import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { Stats } from "node:fs";
import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { runGit } from "./git.ts";

const STATE_FORMAT_VERSION = 1 as const;
const LOCK_DIRECTORY_NAME = "operation.lock";
const LOCK_RECOVERY_FILE_NAME = "operation-recovery.lock";
const MAX_LOCK_RECOVERY_ATTEMPTS = 3;
const SHA_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
const SHA256_PATTERN = /^[0-9a-f]{64}$/i;
const VERIFICATION_RUN_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type CheckSnapshot = {
  readonly status: "no-update" | "update-available" | "selection-blocked" | "network-failure";
  readonly checkedAt: string;
  readonly mainRef: string;
  readonly mainSha: string;
  readonly lockfileHash: string;
  readonly integratedBase: { readonly tag: string; readonly commit: string };
  readonly release?: {
    readonly tag: string;
    readonly commit: string;
    readonly publishedAt: string;
  };
  readonly reason?: string;
};

export type VerificationCheck = {
  readonly id: string;
  readonly status: "passed" | "failed" | "not-run";
  readonly exitCode: number | null;
  readonly durationMs: number;
  readonly reason?: string;
  readonly logs?: VerificationCheckLogs;
};

export type VerificationLogFile = {
  readonly path: string;
  readonly sha256: string;
  readonly sizeBytes: number;
};

export type VerificationCheckLogs = {
  readonly stdout?: VerificationLogFile;
  readonly stderr?: VerificationLogFile;
  readonly runnerError?: VerificationLogFile;
};

export type VerificationLogArchive = {
  readonly status: "saved" | "failed";
  readonly runId: string;
  readonly indexPath?: string;
  readonly indexSha256?: string;
  readonly indexSizeBytes?: number;
  readonly reason?: "log-directory-unavailable" | "log-write-failed" | "log-index-write-failed";
};

export type ToolchainSnapshot = {
  readonly node: string;
  readonly bun: string;
};

export type LockfileHashes = {
  readonly bunLock: string;
  readonly upstreamLock: string;
  readonly miseToml: string;
};

export type RuntimeEvidence = {
  readonly formatVersion: 1;
  readonly candidateSha: string;
  readonly baseSha: string;
  readonly mainRef: string;
  readonly mainSha: string;
  readonly target: { readonly tag: string; readonly commit: string };
  readonly lockfileHashes: LockfileHashes;
  readonly toolchain: ToolchainSnapshot;
  readonly checks: readonly {
    readonly id: string;
    readonly status: "passed" | "failed";
    readonly evidenceSha256: string;
  }[];
};

export type ActiveCandidate = {
  readonly status:
    | "merging"
    | "conflict"
    | "candidate-dirty"
    | "awaiting-verification"
    | "checks-failed"
    | "awaiting-runtime"
    | "rebind-required"
    | "ready";
  readonly checkoutPath: string;
  readonly branch: string;
  readonly mainRef: string;
  readonly mainSha: string;
  readonly baseSha: string;
  readonly target: { readonly tag: string; readonly commit: string };
  readonly candidateSha?: string;
  readonly mergeCommitSha?: string;
  readonly lockfileHashes?: LockfileHashes;
  readonly toolchain?: ToolchainSnapshot;
  readonly automaticChecks?: readonly VerificationCheck[];
  readonly verificationLogs?: VerificationLogArchive;
  readonly runtimeEvidenceHash?: string;
  readonly runtimeEvidence?: RuntimeEvidence;
  readonly updatedAt: string;
};

export type WorkbenchSyncState = {
  readonly formatVersion: typeof STATE_FORMAT_VERSION;
  readonly lastCheck?: CheckSnapshot;
  readonly activeCandidate?: ActiveCandidate;
};

export type RepositoryStatePaths = {
  readonly commonDirectory: string;
  readonly stateDirectory: string;
  readonly stateFile: string;
  readonly lockDirectory: string;
};

export type RepositoryLockOwner = {
  readonly formatVersion: 1;
  readonly token: string;
  readonly operation: string;
  readonly pid: number;
  readonly host: string;
  readonly startedAt: string;
};

export class RepositoryLockError extends Error {
  constructor(
    readonly state: "busy" | "owner-unknown",
    readonly owner?: RepositoryLockOwner,
  ) {
    super(
      state === "busy"
        ? "repository-sync-operation-in-progress"
        : "repository-sync-lock-owner-unknown",
    );
    this.name = "RepositoryLockError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSha(value: unknown): value is string {
  return typeof value === "string" && SHA_PATTERN.test(value);
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && SHA256_PATTERN.test(value);
}

function isVerificationLogFile(
  value: unknown,
  candidateSha: string,
  runId: string,
  fileName: string,
): boolean {
  if (!isRecord(value)) return false;
  return (
    value.path === `workbench-sync/verification-logs/${candidateSha}/${runId}/${fileName}` &&
    isSha256(value.sha256) &&
    typeof value.sizeBytes === "number" &&
    Number.isSafeInteger(value.sizeBytes) &&
    value.sizeBytes >= 0
  );
}

function isVerificationLogArchive(
  value: unknown,
  candidateSha: unknown,
): value is VerificationLogArchive {
  if (
    !isRecord(value) ||
    (value.status !== "saved" && value.status !== "failed") ||
    typeof value.runId !== "string" ||
    !VERIFICATION_RUN_ID_PATTERN.test(value.runId) ||
    !isSha(candidateSha)
  ) {
    return false;
  }
  const expectedIndexPath = `workbench-sync/verification-logs/${candidateSha}/${value.runId}/index.json`;
  if (value.indexPath !== undefined && value.indexPath !== expectedIndexPath) return false;
  if (
    (value.indexSha256 !== undefined && !isSha256(value.indexSha256)) ||
    (value.indexSizeBytes !== undefined &&
      (typeof value.indexSizeBytes !== "number" ||
        !Number.isSafeInteger(value.indexSizeBytes) ||
        value.indexSizeBytes < 0)) ||
    (value.indexPath !== undefined) !== (value.indexSha256 !== undefined) ||
    (value.indexPath !== undefined) !== (value.indexSizeBytes !== undefined)
  ) {
    return false;
  }
  if (
    value.reason !== undefined &&
    value.reason !== "log-directory-unavailable" &&
    value.reason !== "log-write-failed" &&
    value.reason !== "log-index-write-failed"
  ) {
    return false;
  }
  return value.status === "saved"
    ? value.indexPath === expectedIndexPath &&
        value.indexSha256 !== undefined &&
        value.indexSizeBytes !== undefined &&
        value.reason === undefined
    : value.reason !== undefined;
}

function isVerificationCheckLogs(
  value: unknown,
  candidateSha: unknown,
  runId: unknown,
  checkId: unknown,
): value is VerificationCheckLogs {
  if (
    !isRecord(value) ||
    !isSha(candidateSha) ||
    typeof runId !== "string" ||
    !VERIFICATION_RUN_ID_PATTERN.test(runId) ||
    typeof checkId !== "string" ||
    !/^[a-z0-9-]+$/.test(checkId)
  ) {
    return false;
  }
  const prefix = `workbench-sync/verification-logs/${candidateSha}/${runId}/`;
  return (
    isVerificationLogFile(value.stdout, candidateSha, runId, `${checkId}.stdout.log`) &&
    isVerificationLogFile(value.stderr, candidateSha, runId, `${checkId}.stderr.log`) &&
    (value.runnerError === undefined ||
      isVerificationLogFile(
        value.runnerError,
        candidateSha,
        runId,
        `${checkId}.runner-error.log`,
      )) &&
    [value.stdout, value.stderr, value.runnerError]
      .filter(isRecord)
      .every((entry) => typeof entry.path === "string" && entry.path.startsWith(prefix))
  );
}

function parseOwner(value: unknown): RepositoryLockOwner | null {
  if (!isRecord(value)) return null;
  if (
    value.formatVersion !== 1 ||
    typeof value.token !== "string" ||
    typeof value.operation !== "string" ||
    typeof value.pid !== "number" ||
    !Number.isInteger(value.pid) ||
    value.pid <= 0 ||
    typeof value.host !== "string" ||
    typeof value.startedAt !== "string"
  ) {
    return null;
  }
  return value as RepositoryLockOwner;
}

function parseState(value: unknown): WorkbenchSyncState {
  if (!isRecord(value) || value.formatVersion !== STATE_FORMAT_VERSION) {
    throw new Error("workbench-sync-state-invalid");
  }
  if (value.lastCheck !== undefined) {
    const check = value.lastCheck;
    if (
      !isRecord(check) ||
      !(
        check.status === "no-update" ||
        check.status === "update-available" ||
        check.status === "selection-blocked" ||
        check.status === "network-failure"
      ) ||
      typeof check.checkedAt !== "string" ||
      typeof check.mainRef !== "string" ||
      !isSha(check.mainSha) ||
      !isSha256(check.lockfileHash) ||
      !isRecord(check.integratedBase) ||
      typeof check.integratedBase.tag !== "string" ||
      !isSha(check.integratedBase.commit) ||
      (check.release !== undefined &&
        (!isRecord(check.release) ||
          typeof check.release.tag !== "string" ||
          !isSha(check.release.commit) ||
          typeof check.release.publishedAt !== "string"))
    ) {
      throw new Error("workbench-sync-state-invalid");
    }
  }
  if (value.activeCandidate !== undefined) {
    const candidate = value.activeCandidate;
    if (
      !isRecord(candidate) ||
      !(
        candidate.status === "merging" ||
        candidate.status === "conflict" ||
        candidate.status === "candidate-dirty" ||
        candidate.status === "awaiting-verification" ||
        candidate.status === "checks-failed" ||
        candidate.status === "awaiting-runtime" ||
        candidate.status === "rebind-required" ||
        candidate.status === "ready"
      ) ||
      typeof candidate.checkoutPath !== "string" ||
      typeof candidate.branch !== "string" ||
      typeof candidate.mainRef !== "string" ||
      !isSha(candidate.mainSha) ||
      !isSha(candidate.baseSha) ||
      !isRecord(candidate.target) ||
      typeof candidate.target.tag !== "string" ||
      !isSha(candidate.target.commit) ||
      (candidate.candidateSha !== undefined && !isSha(candidate.candidateSha)) ||
      (candidate.mergeCommitSha !== undefined && !isSha(candidate.mergeCommitSha)) ||
      (candidate.lockfileHashes !== undefined &&
        (!isRecord(candidate.lockfileHashes) ||
          !isSha256(candidate.lockfileHashes.bunLock) ||
          !isSha256(candidate.lockfileHashes.upstreamLock) ||
          !isSha256(candidate.lockfileHashes.miseToml))) ||
      (candidate.toolchain !== undefined &&
        (!isRecord(candidate.toolchain) ||
          typeof candidate.toolchain.node !== "string" ||
          typeof candidate.toolchain.bun !== "string")) ||
      (candidate.automaticChecks !== undefined &&
        (!Array.isArray(candidate.automaticChecks) ||
          !candidate.automaticChecks.every(
            (entry) =>
              isRecord(entry) &&
              typeof entry.id === "string" &&
              (entry.status === "passed" ||
                entry.status === "failed" ||
                entry.status === "not-run") &&
              (entry.exitCode === null || typeof entry.exitCode === "number") &&
              typeof entry.durationMs === "number" &&
              (entry.logs === undefined ||
                isVerificationCheckLogs(
                  entry.logs,
                  candidate.candidateSha,
                  isRecord(candidate.verificationLogs)
                    ? candidate.verificationLogs.runId
                    : undefined,
                  entry.id,
                )),
          ))) ||
      (candidate.verificationLogs !== undefined &&
        !isVerificationLogArchive(candidate.verificationLogs, candidate.candidateSha)) ||
      (candidate.runtimeEvidenceHash !== undefined && !isSha256(candidate.runtimeEvidenceHash)) ||
      (candidate.runtimeEvidence !== undefined &&
        (!isRecord(candidate.runtimeEvidence) ||
          candidate.runtimeEvidence.formatVersion !== 1 ||
          !isSha(candidate.runtimeEvidence.candidateSha) ||
          !isSha(candidate.runtimeEvidence.baseSha) ||
          typeof candidate.runtimeEvidence.mainRef !== "string" ||
          !isSha(candidate.runtimeEvidence.mainSha) ||
          !isRecord(candidate.runtimeEvidence.target) ||
          typeof candidate.runtimeEvidence.target.tag !== "string" ||
          !isSha(candidate.runtimeEvidence.target.commit) ||
          !isRecord(candidate.runtimeEvidence.lockfileHashes) ||
          !isSha256(candidate.runtimeEvidence.lockfileHashes.bunLock) ||
          !isSha256(candidate.runtimeEvidence.lockfileHashes.upstreamLock) ||
          !isSha256(candidate.runtimeEvidence.lockfileHashes.miseToml) ||
          !isRecord(candidate.runtimeEvidence.toolchain) ||
          typeof candidate.runtimeEvidence.toolchain.node !== "string" ||
          typeof candidate.runtimeEvidence.toolchain.bun !== "string" ||
          !Array.isArray(candidate.runtimeEvidence.checks) ||
          !candidate.runtimeEvidence.checks.every(
            (entry) =>
              isRecord(entry) &&
              typeof entry.id === "string" &&
              entry.status === "passed" &&
              isSha256(entry.evidenceSha256),
          ))) ||
      typeof candidate.updatedAt !== "string"
    ) {
      throw new Error("workbench-sync-state-invalid");
    }
  }
  return value as WorkbenchSyncState;
}

export async function resolveRepositoryStatePaths(repoRoot: string): Promise<RepositoryStatePaths> {
  const result = runGit(repoRoot, ["rev-parse", "--git-common-dir"]);
  if (!result.ok) throw new Error("repository-git-common-dir-unavailable");
  const rawCommonDirectory = result.stdout.trim();
  const commonDirectory = isAbsolute(rawCommonDirectory)
    ? rawCommonDirectory
    : resolve(repoRoot, rawCommonDirectory);
  const stateDirectory = join(commonDirectory, "workbench-sync");
  return {
    commonDirectory,
    stateDirectory,
    stateFile: join(stateDirectory, "state.json"),
    lockDirectory: join(stateDirectory, LOCK_DIRECTORY_NAME),
  };
}

export async function readWorkbenchSyncState(stateFile: string): Promise<WorkbenchSyncState> {
  let contents: string;
  try {
    contents = await readFile(stateFile, "utf8");
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") {
      return { formatVersion: STATE_FORMAT_VERSION };
    }
    throw new Error("workbench-sync-state-unreadable", { cause: error });
  }
  let value: unknown;
  try {
    value = JSON.parse(contents) as unknown;
  } catch {
    throw new Error("workbench-sync-state-invalid");
  }
  return parseState(value);
}

export async function writeWorkbenchSyncState(
  stateFile: string,
  state: WorkbenchSyncState,
): Promise<void> {
  parseState(state);
  const stateDirectory = dirname(stateFile);
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  const temporaryFile = join(stateDirectory, `.state-${randomUUID()}.tmp`);
  const file = await open(temporaryFile, "wx", 0o600);
  try {
    await file.writeFile(`${JSON.stringify(state, null, 2)}\n`, "utf8");
    await file.sync();
  } catch (error) {
    await file.close();
    await rm(temporaryFile, { force: true });
    throw error;
  }
  await file.close();
  try {
    await rename(temporaryFile, stateFile);
  } catch (error) {
    await rm(temporaryFile, { force: true });
    throw error;
  }
  try {
    const directoryHandle = await open(stateDirectory, "r");
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  } catch {
    // Some supported filesystems do not permit syncing directory handles.
  }
}

async function readLockOwner(lockDirectory: string): Promise<RepositoryLockOwner | null> {
  try {
    const contents = await readFile(join(lockDirectory, "owner.json"), "utf8");
    return parseOwner(JSON.parse(contents) as unknown);
  } catch {
    return null;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !isRecord(error) || error.code !== "ESRCH";
  }
}

async function recoverDeadOwner(paths: RepositoryStatePaths): Promise<boolean> {
  const recoveryPath = join(paths.stateDirectory, LOCK_RECOVERY_FILE_NAME);
  const recoveryOwner: RepositoryLockOwner = {
    formatVersion: 1,
    token: randomUUID(),
    operation: "recover-stale-lock",
    pid: process.pid,
    host: hostname(),
    startedAt: new Date().toISOString(),
  };
  let recoveryHandle: Awaited<ReturnType<typeof open>>;
  try {
    recoveryHandle = await open(recoveryPath, "wx", 0o600);
  } catch (error) {
    if (isRecord(error) && error.code === "EEXIST") return false;
    throw error;
  }
  let recoveryFileStats: Stats | undefined;
  try {
    await recoveryHandle.writeFile(`${JSON.stringify(recoveryOwner)}\n`, "utf8");
    await recoveryHandle.sync();
    recoveryFileStats = await stat(recoveryPath);
    let directoryStats;
    try {
      directoryStats = await stat(paths.lockDirectory);
    } catch (error) {
      return isRecord(error) && error.code === "ENOENT";
    }
    const owner = await readLockOwner(paths.lockDirectory);
    if (!owner || owner.host !== hostname() || isProcessAlive(owner.pid)) return false;

    const secondOwner = await readLockOwner(paths.lockDirectory);
    let currentStats;
    try {
      currentStats = await stat(paths.lockDirectory);
    } catch {
      return true;
    }
    if (
      !secondOwner ||
      secondOwner.token !== owner.token ||
      currentStats.dev !== directoryStats.dev ||
      currentStats.ino !== directoryStats.ino
    ) {
      return false;
    }

    const tombstone = join(paths.stateDirectory, `.stale-operation-${owner.token}-${randomUUID()}`);
    try {
      await rename(paths.lockDirectory, tombstone);
    } catch (error) {
      return isRecord(error) && error.code === "ENOENT";
    }
    const movedOwner = await readLockOwner(tombstone);
    if (!movedOwner || movedOwner.token !== owner.token) {
      try {
        await rename(tombstone, paths.lockDirectory);
      } catch {
        // Preserve the unknown lock directory for manual inspection.
      }
      return false;
    }
    await rm(tombstone, { recursive: true, force: true });
    return true;
  } finally {
    await recoveryHandle.close();
    try {
      const contents = await readFile(recoveryPath, "utf8");
      const current = parseOwner(JSON.parse(contents) as unknown);
      const currentStats = await stat(recoveryPath);
      if (
        current?.token === recoveryOwner.token &&
        recoveryFileStats &&
        recoveryFileStats.dev === currentStats.dev &&
        recoveryFileStats.ino === currentStats.ino
      ) {
        await rm(recoveryPath, { force: true });
      }
    } catch {
      // Keep a recovery guard if its ownership cannot be confirmed.
    }
  }
}

export async function readRepositoryLockStatus(lockDirectory: string): Promise<{
  readonly status: "unlocked" | "locked" | "stale" | "unknown";
  readonly operation?: string;
}> {
  const owner = await readLockOwner(lockDirectory);
  if (!owner) {
    try {
      await stat(lockDirectory);
      return { status: "unknown" };
    } catch (error) {
      return isRecord(error) && error.code === "ENOENT"
        ? { status: "unlocked" }
        : { status: "unknown" };
    }
  }
  if (owner.host !== hostname()) return { status: "locked", operation: owner.operation };
  return {
    status: isProcessAlive(owner.pid) ? "locked" : "stale",
    operation: owner.operation,
  };
}

export async function withRepositoryLock<T>(
  repoRoot: string,
  operation: string,
  run: (paths: RepositoryStatePaths) => Promise<T>,
): Promise<T> {
  const paths = await resolveRepositoryStatePaths(repoRoot);
  await mkdir(paths.stateDirectory, { recursive: true, mode: 0o700 });
  let acquired = false;
  let acquiredDirectoryStats: Stats | undefined;

  for (let attempt = 0; attempt < MAX_LOCK_RECOVERY_ATTEMPTS; attempt += 1) {
    try {
      await mkdir(paths.lockDirectory, { mode: 0o700 });
      acquiredDirectoryStats = await stat(paths.lockDirectory);
      acquired = true;
      break;
    } catch (error) {
      if (!isRecord(error) || error.code !== "EEXIST") throw error;
      const owner = await readLockOwner(paths.lockDirectory);
      if (owner && (owner.host !== hostname() || isProcessAlive(owner.pid))) {
        throw new RepositoryLockError("busy", owner);
      }
      if (!owner) {
        throw new RepositoryLockError("owner-unknown");
      }
      const recovered = await recoverDeadOwner(paths);
      if (!recovered && attempt === MAX_LOCK_RECOVERY_ATTEMPTS - 1) {
        throw new RepositoryLockError("busy", owner);
      }
    }
  }
  if (!acquired) throw new RepositoryLockError("busy");

  const owner: RepositoryLockOwner = {
    formatVersion: 1,
    token: randomUUID(),
    operation,
    pid: process.pid,
    host: hostname(),
    startedAt: new Date().toISOString(),
  };
  const ownerFile = join(paths.lockDirectory, "owner.json");
  try {
    await writeFile(ownerFile, `${JSON.stringify(owner, null, 2)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
  } catch (error) {
    try {
      const currentStats = await stat(paths.lockDirectory);
      if (
        acquiredDirectoryStats &&
        currentStats.dev === acquiredDirectoryStats.dev &&
        currentStats.ino === acquiredDirectoryStats.ino
      ) {
        await rm(paths.lockDirectory, { recursive: true, force: true });
      }
    } catch {
      // Keep an unknown lock for manual inspection rather than deleting it without ownership evidence.
    }
    throw error;
  }

  try {
    return await run(paths);
  } finally {
    const currentOwner = await readLockOwner(paths.lockDirectory);
    if (currentOwner?.token === owner.token) {
      try {
        const currentStats = await stat(paths.lockDirectory);
        if (
          acquiredDirectoryStats &&
          currentStats.dev === acquiredDirectoryStats.dev &&
          currentStats.ino === acquiredDirectoryStats.ino
        ) {
          await rm(paths.lockDirectory, { recursive: true, force: true });
        }
      } catch {
        // Preserve the lock if its ownership cannot be confirmed.
      }
    }
  }
}
