import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import * as fs from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveExecutable } from "@synara/shared/executable";
import { spawnProcess, spawnProcessSync } from "@synara/shared/processRuntime";
import { teardownChildProcessTree } from "../apps/server/src/platform/supervisedProcessTeardown";

interface NativeExpertLock {
  schemaVersion: 1;
  upstream: {
    repository: string;
    commit: string;
    version: string;
    archiveSha256: string;
    treeSha256: string;
    bunLockSha256: string;
  };
  patch: { path: string; sha256: string; patchedTreeSha256: string };
  toolchain: { node: string; bun: string; platform: string; arch: string };
  nativeLeaf: {
    name: string;
    version: string;
    url: string;
    integrity: string;
    archiveMember: string;
  };
  operationRoot: string;
  sourceDirectory: string;
}
interface OperationAuthorization {
  upstreamRevision: string;
  stagingRoot: string;
  authorization: { isolatedSourcePatchAndBuild: boolean };
  capacity: {
    maximumNewPeakGiB: number;
    conservativeStopThresholdGiB: number;
    requiredRemainingGiB: number;
    reservedOtherInFlightGiB: number;
  };
}
interface TreeEntry {
  path: string;
  kind: "file" | "symlink";
  sha256: string;
  executable: boolean;
}
const GiB = 1024 ** 3;
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const generatedIdentity = "packages/coding-agent/src/task/native-expert-build.ts";

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error("Non-JSON build identity");
  return encoded;
}
async function sha256(file: string) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}
async function sourceTree(root: string) {
  const entries: TreeEntry[] = [];
  async function visit(directory: string) {
    for (const item of await fs.readdir(directory, { withFileTypes: true })) {
      const file = join(directory, item.name);
      const name = relative(root, file).split("\\").join("/");
      if (
        item.name === "node_modules" ||
        name === ".git" ||
        name === "packages/coding-agent/dist" ||
        name === "packages/natives/native/pi_natives.darwin-arm64.node"
      )
        continue;
      if (item.isDirectory()) await visit(file);
      else if (item.isSymbolicLink()) {
        entries.push({
          path: name,
          kind: "symlink",
          sha256: createHash("sha256")
            .update(await fs.readlink(file))
            .digest("hex"),
          executable: false,
        });
      } else if (item.isFile()) {
        const stat = await fs.stat(file);
        entries.push({
          path: name,
          kind: "file",
          sha256: await sha256(file),
          executable: (stat.mode & 0o111) !== 0,
        });
      } else throw new Error(`Unsupported source entry: ${name}`);
    }
  }
  await visit(root);
  entries.sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
  return createHash("sha256").update(canonical(entries)).digest("hex");
}
async function allocatedBytes(root: string, operation = root): Promise<number> {
  let bytes = 0;
  for (const item of await fs.readdir(root, { withFileTypes: true })) {
    const file = join(root, item.name);
    try {
      const stat = await fs.lstat(file);
      bytes += stat.blocks * 512;
      if (stat.isSymbolicLink() && !within(operation, await fs.realpath(file)))
        throw new Error("Operation contains a symlink escaping its write boundary");
      if (item.isDirectory()) bytes += await allocatedBytes(file, operation);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return bytes;
}
async function availableBytes(root: string) {
  const stat = await fs.statfs(root);
  return stat.bavail * stat.bsize;
}
function probe(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv) {
  const result = spawnProcessSync(command, args, {
    cwd,
    env,
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
  });
  if (result.error || result.status !== 0)
    throw new Error(`Build prerequisite failed: ${command} ${args.join(" ")}`);
  return result.stdout.trim();
}
function safeBuildEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  // Toolchain/platform settings and optional network/certificate references only.
  // Never copy provider/Synara tokens, shell hooks, BUN_OPTIONS or daily OMP config.
  for (const key of [
    "PATH",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "TZ",
    "SystemRoot",
    "WINDIR",
    "SDKROOT",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
    "no_proxy",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "NODE_EXTRA_CA_CERTS",
  ]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return env;
}
function within(root: string, file: string): boolean {
  const name = relative(root, file);
  return (
    name === "" ||
    (!isAbsolute(name) && name !== ".." && !name.startsWith("../") && !name.startsWith("..\\"))
  );
}
async function operationDirectory(operation: string, directory: string): Promise<string> {
  if (!within(operation, directory))
    throw new Error("Write directory escapes authorized operation");
  let current = operation;
  for (const name of relative(operation, directory).split(/[\\/]/u).filter(Boolean)) {
    current = join(current, name);
    try {
      await fs.mkdir(current, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    if (!(await fs.lstat(current)).isDirectory() || (await fs.realpath(current)) !== current)
      throw new Error("Operation write directory is not canonical");
  }
  return directory;
}
async function operationFile(operation: string, file: string): Promise<void> {
  await operationDirectory(operation, dirname(file));
  try {
    if (!(await fs.lstat(file)).isFile() || (await fs.realpath(file)) !== file)
      throw new Error("Operation write file is not canonical");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

/** Dependency preparation and official isolated compilation only; never installs an application or replaces daily OMP. */
export async function buildOmpNativeExpert() {
  if (process.argv.length !== 4 || process.argv[2] !== "--operation-dir" || !process.argv[3]) {
    throw new Error(
      "Usage: mise exec -- bun scripts/build-omp-native-expert.ts --operation-dir <existing-authorized-operation>",
    );
  }
  const lockPath = join(repo, "workbench/omp-native-expert.lock.json");
  const lock = JSON.parse(await fs.readFile(lockPath, "utf8")) as NativeExpertLock;
  if (
    lock.schemaVersion !== 1 ||
    lock.upstream.commit !== "650f3a108229ee11bf68ba3377f4e8c3391cd424" ||
    lock.upstream.version !== "18.16.0"
  )
    throw new Error("Fixed upstream identity mismatch");
  if (process.platform !== lock.toolchain.platform || process.arch !== lock.toolchain.arch)
    throw new Error("This isolated build lock only authorizes its recorded host target");
  const operation = resolve(repo, process.argv[3]);
  const source = resolve(repo, lock.sourceDirectory);
  if (
    operation !== resolve(repo, lock.operationRoot) ||
    dirname(source) !== operation ||
    (await fs.realpath(operation)) !== operation ||
    (await fs.realpath(source)) !== source
  )
    throw new Error("Build path is outside the single authorized operation");
  const authorization = JSON.parse(
    await fs.readFile(join(operation, "operation.json"), "utf8"),
  ) as OperationAuthorization;
  if (
    authorization.upstreamRevision !== lock.upstream.commit ||
    resolve(repo, authorization.stagingRoot) !== operation ||
    authorization.authorization?.isolatedSourcePatchAndBuild !== true
  )
    throw new Error("Operation authorization mismatch");
  const capacity = authorization.capacity;
  const values = [
    capacity?.maximumNewPeakGiB,
    capacity?.conservativeStopThresholdGiB,
    capacity?.requiredRemainingGiB,
    capacity?.reservedOtherInFlightGiB,
  ];
  if (
    values.some((value) => !Number.isFinite(value) || value <= 0) ||
    capacity.conservativeStopThresholdGiB >= capacity.maximumNewPeakGiB
  )
    throw new Error("Operation capacity policy is missing or invalid");
  const ceilingBytes = capacity.maximumNewPeakGiB * GiB;
  const stopThresholdBytes = capacity.conservativeStopThresholdGiB * GiB;
  const requiredRemainingBytes = capacity.requiredRemainingGiB * GiB;
  const reservationBytes = capacity.reservedOtherInFlightGiB * GiB;
  const requiredFreeDuringBytes = requiredRemainingBytes + reservationBytes;
  const marker = join(operation, ".native-build.lock");
  const claim = await fs.open(marker, "wx", 0o600);
  await claim.writeFile(
    `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`,
  );
  let originalIdentity: string | undefined;
  let capacityPeak = 0;
  try {
    const archive = join(operation, "upstream.tar.gz");
    const patch = resolve(repo, lock.patch.path);
    if (
      patch !== join(repo, "patches/omp-native-expert-18.16.0.patch") ||
      (await sha256(archive)) !== lock.upstream.archiveSha256 ||
      (await sha256(patch)) !== lock.patch.sha256
    )
      throw new Error("Archive/patch digest mismatch");
    const freeBefore = await availableBytes(operation);
    const allocatedBefore = await allocatedBytes(operation);
    capacityPeak = allocatedBefore;
    if (capacityPeak > stopThresholdBytes)
      throw new Error("Operation already exceeds its conservative stop threshold");
    // Resume the same owned operation without reserving its existing bytes twice.
    // Keep the absolute operation stop threshold and independent free-space floor.
    const additionalReservationBytes = Math.max(0, ceilingBytes - allocatedBefore);
    const requiredFreeBeforeBytes = requiredFreeDuringBytes + additionalReservationBytes;
    if (freeBefore < requiredFreeBeforeBytes)
      throw new Error(
        "Insufficient space for the operation's preserved/build/in-flight reservations",
      );
    const env = safeBuildEnvironment();
    const bun = resolveExecutable("bun", { env, cwd: repo });
    const node = resolveExecutable("node", { env, cwd: repo });
    if (!bun || !node || (await fs.realpath(bun)) !== (await fs.realpath(process.execPath)))
      throw new Error("Run this script using the mise-selected Bun executable");
    const cache = await operationDirectory(operation, join(operation, "build-cache"));
    const temporary = await operationDirectory(operation, join(operation, "build-tmp"));
    const home = await operationDirectory(operation, join(operation, "build-home"));
    const config = await operationDirectory(operation, join(home, "config"));
    const data = await operationDirectory(operation, join(home, "data"));
    const state = await operationDirectory(operation, join(home, "state"));
    const agentHome = await operationDirectory(operation, join(home, "omp"));
    Object.assign(env, {
      HOME: home,
      USERPROFILE: home,
      XDG_CONFIG_HOME: config,
      XDG_DATA_HOME: data,
      XDG_STATE_HOME: state,
      APPDATA: config,
      LOCALAPPDATA: data,
      XDG_CACHE_HOME: cache,
      BUN_INSTALL_CACHE_DIR: join(cache, "bun"),
      TMPDIR: temporary,
      TMP: temporary,
      TEMP: temporary,
      CARGO_HOME: join(cache, "cargo"),
      CARGO_TARGET_DIR: join(cache, "cargo-target"),
      CROSS_TARGET: "",
      BUN_COMPILE_EXECUTABLE_PATH: bun,
      GIT_CEILING_DIRECTORIES: operation,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: join(home, "gitconfig"),
      npm_config_cache: join(cache, "npm"),
      PI_CODING_AGENT_DIR: agentHome,
      GIT_CONFIG_SYSTEM: join(home, "gitconfig-system"),
      npm_config_userconfig: join(home, "npmrc"),
    });
    for (const directory of [
      join(cache, "bun"),
      join(cache, "cargo"),
      join(cache, "cargo-target"),
      join(cache, "npm"),
    ]) {
      await operationDirectory(operation, directory);
    }
    const toolchain = {
      node: probe(node, ["--version"], repo, env).replace(/^v/u, ""),
      bun: probe(bun, ["--version"], repo, env),
      platform: process.platform,
      arch: process.arch,
      nodeSha256: await sha256(node),
      bunSha256: await sha256(bun),
    };
    if (toolchain.node !== lock.toolchain.node || toolchain.bun !== lock.toolchain.bun)
      throw new Error("Pinned Node/Bun version mismatch; no automatic toolchain change");
    const treeBefore = await sourceTree(source);
    let patchDisposition: "applied" | "verified-pre-applied";
    if (treeBefore === lock.upstream.treeSha256) {
      probe("git", ["apply", "--check", patch], source, env);
      probe("git", ["apply", patch], source, env);
      patchDisposition = "applied";
    } else if (treeBefore === lock.patch.patchedTreeSha256) {
      // The interrupted implementation already owns this exact patched tree.
      // Reverse-check proves the patch is replayable without undoing its work.
      probe("git", ["apply", "--reverse", "--check", patch], source, env);
      patchDisposition = "verified-pre-applied";
    } else
      throw new Error(
        "Source tree is neither the locked official archive nor its exact patched tree; preserve it and reconcile, never overwrite",
      );
    if (
      (await sourceTree(source)) !== lock.patch.patchedTreeSha256 ||
      (await sha256(join(source, "bun.lock"))) !== lock.upstream.bunLockSha256
    )
      throw new Error("Patched source/official dependency lock mismatch");
    const manifest = JSON.parse(
      await fs.readFile(join(source, "packages/coding-agent/package.json"), "utf8"),
    );
    if (
      manifest.version !== lock.upstream.version ||
      manifest.scripts?.build !== "bun scripts/build-binary.ts"
    )
      throw new Error("Official binary build entrypoint changed");
    if (
      lock.nativeLeaf.name !== "@oh-my-pi/pi-natives-darwin-arm64" ||
      lock.nativeLeaf.version !== lock.upstream.version ||
      lock.nativeLeaf.url !==
        "https://registry.npmjs.org/@oh-my-pi/pi-natives-darwin-arm64/-/pi-natives-darwin-arm64-18.16.0.tgz" ||
      lock.nativeLeaf.archiveMember !== "package/pi_natives.darwin-arm64.node"
    )
      throw new Error("Fixed official native leaf mismatch");
    const nativeArchive = join(operation, "native-darwin-arm64-18.16.0.tgz");
    await operationFile(operation, nativeArchive);
    await operationFile(operation, `${nativeArchive}.tmp`);
    try {
      await fs.access(nativeArchive);
    } catch {
      const response = await fetch(lock.nativeLeaf.url, { redirect: "error" });
      if (!response.ok || !response.body)
        throw new Error("Fixed official native leaf download failed");
      const downloaded = await fs.open(`${nativeArchive}.tmp`, "wx", 0o600);
      let compressedBytes = 0;
      try {
        for await (const chunk of response.body) {
          compressedBytes += chunk.length;
          if (compressedBytes > 128 * 1024 ** 2)
            throw new Error("Native leaf archive exceeds its bounded budget");
          await downloaded.write(chunk);
        }
        await downloaded.sync();
      } finally {
        await downloaded.close();
      }
      await fs.rename(`${nativeArchive}.tmp`, nativeArchive);
    }
    const nativeArchiveHash = createHash("sha512");
    for await (const chunk of createReadStream(nativeArchive)) nativeArchiveHash.update(chunk);
    if (`sha512-${nativeArchiveHash.digest("base64")}` !== lock.nativeLeaf.integrity)
      throw new Error("Fixed official native leaf integrity mismatch");
    const nativeDirectory = join(source, "packages/natives/native");
    await operationDirectory(operation, nativeDirectory);
    const nativeAddon = join(nativeDirectory, "pi_natives.darwin-arm64.node");
    await operationFile(operation, nativeAddon);
    probe(
      "tar",
      [
        "-xzf",
        nativeArchive,
        "-C",
        nativeDirectory,
        "--strip-components=1",
        lock.nativeLeaf.archiveMember,
      ],
      source,
      env,
    );
    if (!(await fs.lstat(nativeAddon)).isFile() || (await fs.realpath(nativeAddon)) !== nativeAddon)
      throw new Error("Native leaf did not contain its fixed regular addon");
    if (
      (await availableBytes(operation)) < requiredFreeDuringBytes ||
      (await allocatedBytes(operation)) > stopThresholdBytes
    )
      throw new Error("Insufficient remaining build headroom after native dependency preparation");
    const nativeLeaf = {
      ...lock.nativeLeaf,
      archiveSha256: await sha256(nativeArchive),
      addonSha256: await sha256(nativeAddon),
    };
    const provenance = {
      protocolVersion: 1,
      upstreamCommit: lock.upstream.commit,
      archiveSha256: lock.upstream.archiveSha256,
      patchSha256: lock.patch.sha256,
      patchedTreeSha256: lock.patch.patchedTreeSha256,
      bunLockSha256: lock.upstream.bunLockSha256,
      builderSha256: await sha256(fileURLToPath(import.meta.url)),
      toolchain,
      nativeLeaf,
    };
    const buildFingerprint = createHash("sha256").update(canonical(provenance)).digest("hex");
    const identity = join(source, generatedIdentity);
    originalIdentity = await fs.readFile(identity, "utf8");
    const run = async (args: string[], cwd: string) => {
      // Dependency/build tools must not serialize proxy/certificate environment values.
      const child = spawnProcess(bun, args, {
        cwd,
        env,
        stdio: "pipe",
        ownProcessGroup: true,
        lowerPriority: true,
      });
      // Drain without echoing untrusted tool output; the receipt is the public evidence.
      child.stdout?.resume();
      child.stderr?.resume();
      child.stdin?.end();
      const exit = Promise.withResolvers<void>();
      child.once("exit", (code, signal) =>
        code === 0
          ? exit.resolve()
          : exit.reject(
              new Error(`Official build step failed (${code ?? signal}): ${args.join(" ")}`),
            ),
      );
      child.once("error", exit.reject);
      let measurement: Promise<void> | undefined;
      let capacityError: Error | undefined;
      let teardown: Promise<unknown> | undefined;
      const stop = (error: Error) => {
        capacityError ??= error;
        teardown ??= teardownChildProcessTree(child);
      };
      const onInterrupt = () => stop(new Error("Isolated build interrupted"));
      process.once("SIGINT", onInterrupt);
      process.once("SIGTERM", onInterrupt);
      const monitor = setInterval(() => {
        if (measurement) return;
        measurement = Promise.all([allocatedBytes(operation), availableBytes(operation)])
          .then(([used, free]) => {
            capacityPeak = Math.max(capacityPeak, used);
            if (used > stopThresholdBytes || free < requiredFreeDuringBytes)
              stop(
                new Error(
                  "Operation capacity stop threshold reached; preserve other candidates and recovery sets",
                ),
              );
          })
          .catch((error: unknown) =>
            stop(error instanceof Error ? error : new Error("Capacity observation failed")),
          )
          .finally(() => {
            measurement = undefined;
          });
      }, 1000);
      try {
        await exit.promise;
      } finally {
        clearInterval(monitor);
        await measurement;
        await teardown;
        process.removeListener("SIGINT", onInterrupt);
        process.removeListener("SIGTERM", onInterrupt);
      }
      if (capacityError) throw capacityError;
    };
    // Upstream's official binary entrypoint explicitly generates its resources.
    // Dependency hooks cannot silently mutate the verified source beforehand.
    await run(["install", "--frozen-lockfile", "--ignore-scripts"], source);
    if (
      (await sourceTree(source)) !== lock.patch.patchedTreeSha256 ||
      (await sha256(join(source, "bun.lock"))) !== lock.upstream.bunLockSha256
    )
      throw new Error("Dependency preparation changed verified compiler inputs");
    await fs.writeFile(
      identity,
      `// Trusted compile-time identity generated from the verified build inputs.\nexport const nativeExpertBuildFingerprint: string = ${JSON.stringify(buildFingerprint)};\n`,
    );
    if (
      (await availableBytes(operation)) < requiredFreeDuringBytes ||
      (await allocatedBytes(operation)) > stopThresholdBytes
    )
      throw new Error("Insufficient remaining build headroom after dependency preparation");
    // Upstream's package build embeds the official platform-native addon and
    // viewer/docs resources, and performs its own Darwin ad-hoc signing.
    await run(["run", "build"], join(source, "packages/coding-agent"));
    const binaryPath = join(source, "packages/coding-agent/dist/omp");
    const binaryStat = await fs.lstat(binaryPath);
    if (
      !binaryStat.isFile() ||
      binaryStat.size === 0 ||
      (await fs.realpath(binaryPath)) !== binaryPath
    )
      throw new Error("Official builder did not produce a regular isolated binary");
    const receipt = {
      schemaVersion: 1,
      status: "isolated-build-only",
      createdAt: new Date().toISOString(),
      provenance,
      buildFingerprint,
      patchDisposition,
      sourceDirectory: lock.sourceDirectory,
      compiledSourceTreeSha256: await sourceTree(source),
      binary: {
        path: relative(repo, binaryPath),
        sha256: await sha256(binaryPath),
        size: binaryStat.size,
      },
      capacity: {
        freeBefore,
        freeAfter: await availableBytes(operation),
        allocatedBefore,
        additionalReservationBytes,
        peakObservedBytes: capacityPeak,
        ceilingBytes,
        stopThresholdBytes,
        requiredRemainingBytes,
        reservationBytes,
        requiredFreeBeforeBytes,
        requiredFreeDuringBytes,
      },
      verification: {
        build: "completed",
        tests: "not-run",
        lint: "not-run",
        runtime: "not-run",
        realModel: "not-authorized",
        dailyBinaryReplacement: "not-performed",
      },
    };
    if (receipt.capacity.freeAfter < requiredRemainingBytes)
      throw new Error("Preserved-space boundary violated; no successful receipt");
    const receiptPath = join(operation, "build-receipt.json");
    const temporaryReceipt = `${receiptPath}.tmp`;
    await operationFile(operation, receiptPath);
    await operationFile(operation, temporaryReceipt);
    const receiptFile = await fs.open(temporaryReceipt, "wx", 0o600);
    try {
      await receiptFile.writeFile(`${JSON.stringify(receipt, null, 2)}\n`);
      await receiptFile.sync();
    } finally {
      await receiptFile.close();
    }
    await fs.rename(temporaryReceipt, receiptPath);
    process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
    return receipt;
  } finally {
    if (originalIdentity !== undefined)
      await fs.writeFile(join(source, generatedIdentity), originalIdentity);
    await claim.close();
    await fs.unlink(marker);
  }
}
if (import.meta.main) {
  buildOmpNativeExpert().catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : "Isolated native build failed"}\n`,
    );
    process.exitCode = 1;
  });
}
