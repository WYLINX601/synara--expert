import { createHash } from "node:crypto";
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import { dirname, join } from "node:path";
import { spawnProcess, spawnProcessSync } from "@synara/shared/processRuntime";
import { syncDirectoryEntry } from "@synara/shared/filesystemPlatform";
import type { LinxUpdateManifest } from "@synara/contracts";
import {
  requireCanonicalPath,
  sha256,
  linxOSAtLeast,
  requirePrivateDirectory,
} from "./linxUpdateHelperFiles";
import { parseLinxUpdateSource } from "./linxUpdateSource";
import { validateLinxMachOMinimum } from "./linxUpdateHelperMachO";

declare const __LINX_UPDATE_DARWIN_BRIDGE_BASE64__: string;
declare const __LINX_UPDATE_DARWIN_BRIDGE_SHA256__: string;
export function runLinxPlatformCommand(command: string, args: readonly string[]): string {
  const result = spawnProcessSync(command, args, {
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 4 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error || result.status !== 0)
    throw new Error(
      `Platform operation failed: ${command}: ${result.error?.message ?? result.stderr.slice(0, 1024)}`,
    );
  return result.stdout.trim();
}
export interface LinxInstallationTargetLock {
  assertHeld(): Promise<void>;
  release(completed: boolean): Promise<void>;
}
export interface LinxHelperPlatform {
  acquireTargetLock(
    applicationPath: string,
    attemptPath: string,
  ): Promise<LinxInstallationTargetLock>;
  validateStandaloneHelper(applicationPath: string, attemptPath: string): Promise<void>;
  pidPath(pid: number): Promise<string>;
  validateBundle(
    path: string,
    version: string,
    strict: boolean,
    manifest?: LinxUpdateManifest,
  ): Promise<string>;
  prepareMetadata(
    packagePath: string,
    applicationPath: string,
    metadata: readonly { filePath: string; targetPath: string }[],
    url: string,
  ): Promise<void>;
  osVersion(): string;
  launch(path: string, attemptPath?: string): Promise<void>;
}
async function readBundleText(path: string): Promise<string> {
  await requireCanonicalPath(path);
  const handle = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 64 * 1024)
      throw new Error("Bundle metadata exceeds its bounded regular-file format");
    const bytes = Buffer.alloc(stat.size + 1);
    let size = 0;
    while (size < bytes.length) {
      const read = await handle.read(bytes, size, bytes.length - size, size);
      if (read.bytesRead === 0) break;
      size += read.bytesRead;
    }
    const after = await handle.stat();
    if (
      size !== stat.size ||
      after.size !== stat.size ||
      after.mtimeMs !== stat.mtimeMs ||
      after.ctimeMs !== stat.ctimeMs
    )
      throw new Error("Bundle metadata changed while reading");
    return bytes.toString("utf8", 0, size);
  } finally {
    await handle.close();
  }
}
async function readBundlePackage(resources: string): Promise<Record<string, unknown>> {
  try {
    return JSON.parse(await readBundleText(join(resources, "app/package.json"))) as Record<
      string,
      unknown
    >;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  // ASAR's pickle header contains a JSON file table. Read only bounded header and package bytes.
  const handle = await fs.open(
    join(resources, "app.asar"),
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const prefix = Buffer.alloc(16);
    if ((await handle.read(prefix, 0, 16, 0)).bytesRead !== 16) throw new Error("Truncated ASAR");
    const headerSize = prefix.readUInt32LE(4);
    const jsonSize = prefix.readUInt32LE(12);
    if (headerSize < 8 || headerSize > 4 * 1024 * 1024 || jsonSize > headerSize - 8)
      throw new Error("Invalid ASAR header");
    const bytes = Buffer.alloc(jsonSize);
    if ((await handle.read(bytes, 0, jsonSize, 16)).bytesRead !== jsonSize)
      throw new Error("Truncated ASAR table");
    const table = JSON.parse(bytes.toString("utf8")) as {
      files?: Record<string, { size?: number; offset?: string; unpacked?: boolean; link?: string }>;
    };
    const entry = table.files?.["package.json"];
    const offset = Number(entry?.offset);
    const size = entry?.size;
    if (
      !entry ||
      entry.unpacked ||
      entry.link ||
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      !Number.isSafeInteger(size) ||
      size === undefined ||
      size < 1 ||
      size > 64 * 1024
    )
      throw new Error("Invalid ASAR package metadata");
    const data = Buffer.alloc(size);
    if ((await handle.read(data, 0, size, 8 + headerSize + offset)).bytesRead !== size)
      throw new Error("Truncated package metadata");
    return JSON.parse(data.toString("utf8")) as Record<string, unknown>;
  } finally {
    await handle.close();
  }
}
async function verifyNativeArchitectures(
  root: string,
  signedMinimum: string,
  actualVersion: string,
): Promise<void> {
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      await verifyNativeArchitectures(path, signedMinimum, actualVersion);
      continue;
    }
    if (!entry.isFile()) throw new Error("Special file in candidate application");
    await validateLinxMachOMinimum(path, signedMinimum, actualVersion);
  }
}
export async function createLinxDarwinHelperPlatform(
  attemptPath: string,
  sourceJson: string,
): Promise<LinxHelperPlatform> {
  if (process.platform !== "darwin" || process.arch !== "arm64")
    throw new Error("Linx installation requires macOS arm64");
  await requirePrivateDirectory(attemptPath);
  if (
    typeof __LINX_UPDATE_DARWIN_BRIDGE_BASE64__ !== "string" ||
    typeof __LINX_UPDATE_DARWIN_BRIDGE_SHA256__ !== "string"
  )
    throw new Error("Native bridge was not embedded by the release builder");
  const bytes = Buffer.from(__LINX_UPDATE_DARWIN_BRIDGE_BASE64__, "base64");
  if (sha256(bytes) !== __LINX_UPDATE_DARWIN_BRIDGE_SHA256__)
    throw new Error("Embedded native bridge digest mismatch");
  const bridge = join(
    attemptPath,
    `linx-update-darwin-bridge-${__LINX_UPDATE_DARWIN_BRIDGE_SHA256__}`,
  );
  try {
    const handle = await fs.open(bridge, "wx", 0o700);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existing = await fs.open(bridge, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await existing.stat();
      if (
        !stat.isFile() ||
        stat.uid !== process.getuid?.() ||
        stat.nlink !== 1 ||
        (stat.mode & 0o777) !== 0o700 ||
        stat.size !== bytes.length ||
        sha256(await existing.readFile()) !== __LINX_UPDATE_DARWIN_BRIDGE_SHA256__
      )
        throw new Error("Existing native bridge is not the embedded authenticated bridge");
    } finally {
      await existing.close();
    }
  }
  runLinxPlatformCommand("/usr/bin/codesign", ["--verify", "--strict", bridge]);
  runLinxPlatformCommand("/usr/bin/lipo", ["-verify_arch", "arm64", bridge]);
  const trusted = parseLinxUpdateSource(sourceJson);
  if (!trusted) throw new Error("Invalid embedded trust source");
  return {
    acquireTargetLock: async (applicationPath, directory) => {
      const parent = dirname(applicationPath);
      await requireCanonicalPath(parent);
      await requirePrivateDirectory(directory);
      const parentStat = await fs.stat(parent);
      if (
        (parentStat.mode & 0o002) !== 0 ||
        (parentStat.uid !== 0 && parentStat.uid !== process.getuid?.())
      )
        throw new Error("Unproven installation parent authority");
      await fs.access(parent, constants.W_OK | constants.X_OK);
      // The application may be absent in a rename gap; its canonical parent and
      // fixed basename still select exactly the same cross-home installation.
      const lock = join(parent, `.linx-install-${sha256(applicationPath)}.lock`);
      const child = spawnProcess(bridge, ["target-lock", lock, directory], { stdio: "pipe" });
      const closed = Promise.withResolvers<void>();
      let pending = Promise.withResolvers<void>();
      let failure: Error | null = null;
      let releasing = false;
      let output = "";
      child.stderr.resume();
      child.stdin.on("error", (error) => {
        failure = error;
        pending.reject(error);
      });
      child.once("error", (error) => {
        failure = error;
        pending.reject(error);
        closed.reject(error);
      });
      child.once("close", (code) => {
        if (code !== 0 || !releasing) {
          failure = new Error("Installation target lock is busy, interrupted, or unproven");
          pending.reject(failure);
        }
        if (code === 0) closed.resolve();
        else closed.reject(failure!);
      });
      // Observe the process result even when acquisition itself is rejected.
      void closed.promise.catch(() => {});
      child.stdout.on("data", (bytes: Buffer) => {
        output += bytes.toString("utf8");
        if (output === "locked\n") {
          output = "";
          pending.resolve();
        } else if (output.length >= 7) {
          failure = new Error("Invalid installation lock response");
          pending.reject(failure);
          child.stdin.destroy();
        }
      });
      try {
        await pending.promise;
        await syncDirectoryEntry(parent);
      } catch (error) {
        child.stdin.destroy();
        throw error;
      }
      return {
        assertHeld: async () => {
          if (failure || releasing) throw failure ?? new Error("Installation lock released");
          pending = Promise.withResolvers<void>();
          child.stdin.write("check\n");
          await pending.promise;
        },
        release: async (completed) => {
          if (releasing) return;
          releasing = true;
          child.stdin.end(completed ? "release\n" : undefined);
          await closed.promise;
          await syncDirectoryEntry(parent);
        },
      };
    },
    pidPath: async (pid) => runLinxPlatformCommand(bridge, ["pidpath", String(pid)]),
    validateStandaloneHelper: async (applicationPath, directory) => {
      const copied = join(directory, "linx-update-helper");
      runLinxPlatformCommand(bridge, ["preflight", applicationPath, dirname(applicationPath)]);
      await requireCanonicalPath(copied);
      if (runLinxPlatformCommand(bridge, ["pidpath", String(process.pid)]) !== copied)
        throw new Error("Helper is not running from the private outside-app attempt");
      const copiedStat = await fs.lstat(copied);
      if (
        copiedStat.uid !== process.getuid?.() ||
        copiedStat.nlink !== 1 ||
        (copiedStat.mode & 0o777) !== 0o700
      )
        throw new Error("Standalone helper is not private and owned");
      const digests: string[] = [];
      for (const path of [copied, join(applicationPath, "Contents/Resources/linx-update-helper")]) {
        const handle = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const before = await handle.stat();
          if (!before.isFile() || before.size > 256 * 1024 * 1024)
            throw new Error("Invalid helper executable");
          const hash = createHash("sha256");
          for await (const chunk of handle.createReadStream({ autoClose: false }))
            hash.update(chunk);
          const after = await handle.stat();
          if (
            after.size !== before.size ||
            after.mtimeMs !== before.mtimeMs ||
            after.ctimeMs !== before.ctimeMs
          )
            throw new Error("Helper changed during authentication");
          digests.push(hash.digest("hex"));
        } finally {
          await handle.close();
        }
      }
      if (digests[0] !== digests[1])
        throw new Error("Copied helper differs from current bundle's authenticated resource");
      runLinxPlatformCommand("/usr/bin/codesign", ["--verify", "--strict", copied]);
    },
    osVersion: () => runLinxPlatformCommand("/usr/bin/sw_vers", ["-productVersion"]),
    validateBundle: async (path, version, strict, manifest) => {
      await requireCanonicalPath(path);
      const plist = JSON.parse(
        runLinxPlatformCommand("/usr/bin/plutil", [
          "-convert",
          "json",
          "-o",
          "-",
          join(path, "Contents/Info.plist"),
        ]),
      ) as Record<string, unknown>;
      const executable = plist.CFBundleExecutable;
      if (
        plist.CFBundleIdentifier !== "com.wylinx.linx" ||
        plist.CFBundleShortVersionString !== version ||
        plist.CFBundleVersion !== version ||
        typeof executable !== "string" ||
        !/^[A-Za-z0-9 _-]+$/u.test(executable)
      )
        throw new Error("Application identity/version mismatch");
      const actualVersion = runLinxPlatformCommand("/usr/bin/sw_vers", ["-productVersion"]);
      if (manifest && !linxOSAtLeast(actualVersion, manifest.minOSVersion))
        throw new Error("This system is older than the signed minimum macOS version");
      const architectureMinimum = (
        plist.LSMinimumSystemVersionByArchitecture as Record<string, unknown> | undefined
      )?.arm64;
      for (const minimum of [plist.LSMinimumSystemVersion, architectureMinimum]) {
        if (minimum === undefined) continue;
        if (
          typeof minimum !== "string" ||
          !linxOSAtLeast(actualVersion, minimum) ||
          (manifest && !linxOSAtLeast(manifest.minOSVersion, minimum))
        )
          throw new Error(
            "Application requires macOS newer than its signed minimum or this system",
          );
      }
      if (
        typeof plist.LSMinimumSystemVersion !== "string" &&
        typeof architectureMinimum !== "string"
      )
        throw new Error("Application has no minimum macOS version");
      runLinxPlatformCommand("/usr/bin/codesign", [
        "--verify",
        "--deep",
        ...(strict ? ["--strict"] : []),
        path,
      ]);
      const executablePath = join(path, "Contents/MacOS", executable);
      await requireCanonicalPath(executablePath);
      runLinxPlatformCommand("/usr/bin/lipo", ["-verify_arch", "arm64", executablePath]);
      const resources = join(path, "Contents/Resources");
      await requireCanonicalPath(resources);
      const source = parseLinxUpdateSource(
        await readBundleText(join(resources, "linx-update-source.json")),
      );
      if (!source || source.repository !== trusted.repository)
        throw new Error("Candidate release repository mismatch");
      // New rings may extend the root only while retaining all previously trusted keys.
      for (const [id, key] of trusted.keyRing)
        if (
          source.keyRing.get(id)?.export({ type: "spki", format: "der" }).toString("hex") !==
          key.export({ type: "spki", format: "der" }).toString("hex")
        )
          throw new Error("Candidate removed or replaced trusted key lineage");
      const pkg = await readBundlePackage(resources);
      if (
        pkg.version !== version ||
        pkg.buildVersion !== version ||
        typeof pkg.synaraCommitHash !== "string" ||
        !/^[a-f0-9]{40}$/u.test(pkg.synaraCommitHash) ||
        (manifest && pkg.synaraCommitHash !== manifest.sourceCommit)
      )
        throw new Error("Bundle source/version provenance mismatch");
      if (strict) {
        if (!manifest) throw new Error("Strict candidate validation requires a signed manifest");
        await verifyNativeArchitectures(path, manifest.minOSVersion, actualVersion);
      }
      return executablePath;
    },
    prepareMetadata: async (packagePath, applicationPath, metadata, url) => {
      runLinxPlatformCommand(bridge, ["mark-download", packagePath, url]);
      for (const item of metadata)
        runLinxPlatformCommand(bridge, ["unpack", item.filePath, item.targetPath]);
      runLinxPlatformCommand(bridge, ["provenance", packagePath, applicationPath]);
    },
    launch: async (path, attempt) => {
      runLinxPlatformCommand("/usr/bin/open", [
        "-n",
        path,
        ...(attempt ? ["--args", "--linx-update-attempt", attempt] : []),
      ]);
    },
  };
}
