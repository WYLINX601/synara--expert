import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Schema } from "effect";
import {
  LinxUpdateHelperResponse,
  LinxUpdateInstallRequest,
  type LinxUpdateHelperCommand,
  type LinxUpdateReleaseReceipt,
} from "@synara/contracts";
import { spawnProcess, spawnProcessSync } from "@synara/shared/processRuntime";
import { syncDirectoryEntry } from "@synara/shared/filesystemPlatform";
import type { LinxUpdateInstallationTarget } from "./linxUpdateClient";
import type { LinxInstallerHelper } from "./linxUpdateInstall";
import { LinxUpdateOperationError } from "./linxUpdateFailure";

declare const __LINX_UPDATE_HELPER_SHA256__: string;

function native(command: string, args: string[]): void {
  const result = spawnProcessSync(command, args, { encoding: "utf8", timeout: 60_000 });
  if (result.error || result.status !== 0)
    throw new Error(`Native update preparation failed: ${path.basename(command)}`);
}
async function digest(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}
export async function writeLinxPrivateJson(filePath: string, value: unknown): Promise<void> {
  const temporary = `${filePath}.${randomBytes(8).toString("hex")}.tmp`;
  const handle = await fs.open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(temporary, filePath);
  await syncDirectoryEntry(path.dirname(filePath));
}

export async function createLinxInstallerHelper(input: {
  installation: LinxUpdateInstallationTarget;
  attemptId: string;
  attemptsPath: string;
  helperPath: string;
  applicationPath: string;
  homePath: string;
  userDataPath: string;
  currentVersion: string;
  signal: AbortSignal;
}): Promise<LinxInstallerHelper> {
  input.signal.throwIfAborted();
  if (process.platform !== "darwin" || process.arch !== "arm64")
    throw new Error("Linx installer requires macOS arm64");
  const expectedHelperSha256 =
    typeof __LINX_UPDATE_HELPER_SHA256__ === "string" ? __LINX_UPDATE_HELPER_SHA256__ : "";
  if (!/^[0-9a-f]{64}$/.test(expectedHelperSha256))
    throw new Error("Desktop build has no authenticated update helper");
  await fs.mkdir(input.attemptsPath, { recursive: true, mode: 0o700 });
  const parent = await fs.lstat(input.attemptsPath);
  if (
    !parent.isDirectory() ||
    parent.isSymbolicLink() ||
    parent.uid !== process.getuid?.() ||
    (parent.mode & 0o077) !== 0
  )
    throw new Error("Unsafe updater directory");
  const attemptPath = path.join(await fs.realpath(input.attemptsPath), input.attemptId);
  await fs.mkdir(attemptPath, { mode: 0o700 });
  const helperPath = path.join(attemptPath, "linx-update-helper");
  const source = await fs.lstat(input.helperPath);
  if (!source.isFile() || source.isSymbolicLink())
    throw new Error("Bundled helper is not a real file");
  if ((await digest(input.helperPath)) !== expectedHelperSha256)
    throw new Error("Bundled helper does not match this desktop build");
  native("/usr/bin/codesign", ["--verify", "--strict", input.helperPath]);
  native("/usr/bin/lipo", ["-verify_arch", "arm64", input.helperPath]);
  native("/usr/bin/codesign", ["--verify", "--deep", "--strict", input.applicationPath]);
  await fs.copyFile(input.helperPath, helperPath, fs.constants.COPYFILE_EXCL);
  await fs.chmod(helperPath, 0o700);
  if ((await digest(helperPath)) !== expectedHelperSha256)
    throw new Error("Standalone helper does not match this desktop build");
  native("/usr/bin/codesign", ["--verify", "--strict", helperPath]);
  const nonce = randomBytes(32).toString("hex");
  const target = input.installation.target;
  const request = Schema.decodeUnknownSync(LinxUpdateInstallRequest)({
    schemaVersion: 1,
    attemptId: input.attemptId,
    requestedAt: new Date().toISOString(),
    fromVersion: input.currentVersion,
    toVersion: target.version,
    manifestDigest: target.manifestDigest,
    manifestPath: path.join(attemptPath, "manifest.json"),
    signaturePath: path.join(attemptPath, "manifest.sig"),
    packagePath: path.join(attemptPath, "package.zip"),
    applicationPath: input.applicationPath,
    homePath: input.homePath,
    userDataPath: input.userDataPath,
    parentPid: process.pid,
    authorizationDigest: createHash("sha256").update(nonce).digest("hex"),
  });
  await fs.writeFile(request.manifestPath, target.manifestBytes, { flag: "wx", mode: 0o600 });
  await fs.writeFile(request.signaturePath, target.signatureBytes, { flag: "wx", mode: 0o600 });
  const packageSource = await fs.lstat(input.installation.download.filePath);
  if (
    !packageSource.isFile() ||
    packageSource.isSymbolicLink() ||
    packageSource.size !== target.size ||
    input.installation.download.sha256 !== target.sha256 ||
    input.installation.download.size !== target.size
  ) {
    throw new Error("Verified package file identity changed before helper preparation");
  }
  // Copy, not ZIP extraction. Preserve actual quarantine/WhereFrom attributes.
  native("/usr/bin/ditto", [
    "--rsrc",
    "--extattr",
    input.installation.download.filePath,
    request.packagePath,
  ]);
  await fs.chmod(request.packagePath, 0o600);
  if ((await digest(request.packagePath)) !== target.sha256)
    throw new Error("Pinned package changed before helper launch");
  await fs.writeFile(path.join(attemptPath, "authorization.nonce"), nonce, {
    flag: "wx",
    mode: 0o600,
  });
  await writeLinxPrivateJson(path.join(attemptPath, "request.json"), request);
  await writeLinxPrivateJson(path.join(attemptPath, "release.json"), input.installation.release);
  input.signal.throwIfAborted();
  if ((await digest(helperPath)) !== expectedHelperSha256)
    throw new Error("Standalone helper does not match this desktop build");
  input.signal.throwIfAborted();
  const child = spawnProcess(helperPath, ["--attempt", attemptPath], {
    stdio: "pipe",
    detached: true,
  });
  if (!child.pid) throw new Error("Standalone helper did not start");
  const helperPid = child.pid;
  const pending: { expected: string; resolve(): void; reject(error: unknown): void }[] = [];
  let detached = false;
  let failure: Error | undefined;
  const fail = (error: Error): void => {
    failure = error;
    for (const waiter of pending.splice(0)) waiter.reject(error);
  };
  let output = Buffer.alloc(0);
  child.stdout.on("data", (chunk: Buffer) => {
    if (failure) return;
    try {
      if (output.length + chunk.length > 64 * 1024) throw new Error("Oversized helper response");
      output = Buffer.concat([output, chunk]);
      let newline: number;
      while ((newline = output.indexOf(0x0a)) >= 0) {
        const line = output.subarray(0, newline).toString("utf8");
        output = output.subarray(newline + 1);
        const response = Schema.decodeUnknownSync(LinxUpdateHelperResponse)(JSON.parse(line));
        if (
          response.attemptId !== input.attemptId ||
          response.manifestDigest !== target.manifestDigest ||
          response.helperPid !== helperPid
        )
          throw new Error("Helper response binding changed");
        const waiter = pending.shift();
        if (!waiter) throw new Error("Unsolicited helper response");
        if (response.status !== waiter.expected)
          waiter.reject(new LinxUpdateOperationError(response.failure ?? "failed"));
        else waiter.resolve();
      }
    } catch (error) {
      fail(error instanceof Error ? error : new Error(String(error)));
    }
  });
  child.stdout.once("end", () => {
    if (!detached) fail(new Error("Standalone helper protocol disconnected before handoff"));
  });
  child.once("error", fail);
  child.once("exit", () => {
    if (!detached) fail(new Error("Standalone helper exited before handoff"));
  });
  child.stdin.on("error", fail);
  child.stderr.resume(); // Private diagnostics must never echo nonce-bearing protocol bytes.
  const send = async (
    action: LinxUpdateHelperCommand["action"],
    expected: string,
    signal: AbortSignal,
    release: LinxUpdateReleaseReceipt | null = null,
    userDataSnapshotPath: string | null = null,
  ): Promise<void> => {
    signal.throwIfAborted();
    if (failure) throw failure;
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    pending.push({ expected, resolve, reject });
    // Keep the retired waiter in protocol order. A late response cannot be
    // mistaken for the following cancellation acknowledgment.
    const abort = (): void => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => reject(new Error("Helper handoff timed out")), 120_000);
    const command: LinxUpdateHelperCommand = {
      schemaVersion: 1,
      attemptId: input.attemptId,
      manifestDigest: target.manifestDigest,
      nonce,
      action,
      release,
      userDataSnapshotPath,
    };
    child.stdin.write(`${JSON.stringify(command)}\n`);
    try {
      await promise;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
    }
  };
  return {
    pid: helperPid,
    nonce,
    attemptPath,
    prepare: (signal) => send("prepare", "prepared", signal),
    createRecovery: (snapshot, signal) =>
      send("create-recovery", "recovery-ready", signal, null, snapshot),
    commit: (receipt, signal) => send("commit", "committed", signal, receipt),
    cancel: () => send("cancel", "cancelled", new AbortController().signal),
    detach: () => {
      detached = true;
      child.unref();
    },
  };
}
