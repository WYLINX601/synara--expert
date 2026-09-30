import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { spawnProcessSync } from "@synara/shared/processRuntime";
import {
  readRepositoryLockStatus,
  readWorkbenchSyncState,
  withRepositoryLock,
  writeWorkbenchSyncState,
  type ActiveCandidate,
  type CheckSnapshot,
  type LockfileHashes,
  type RuntimeEvidence,
  type ToolchainSnapshot,
  type VerificationCheck,
} from "./state.ts";
import { runGit } from "./git.ts";
import {
  checkWorkbenchSync,
  expectedCandidateBranch,
  prepareCandidate,
  readSyncLock,
  validateFixedOfficialTag,
  type CheckReport,
  type PrepareReport,
  type WorkbenchSyncLock,
} from "./sync.ts";
import type { ReleaseFetcher } from "./releases.ts";

const DEFAULT_MAIN_REF = "refs/heads/main";
const SHA_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
const SHA256_PATTERN = /^[0-9a-f]{64}$/i;
const MAX_GATE_MS = 30 * 60 * 1000;
const MAX_SHORT_COMMAND_MS = 10_000;

export const AUTOMATIC_CHECKS = [
  { id: "format", script: "fmt:check" },
  { id: "lint", script: "lint" },
  { id: "typecheck", script: "typecheck" },
  { id: "tests", script: "test" },
  { id: "migrations", script: "migrations:check" },
  { id: "windows-runtime", script: "windows-runtime:check" },
] as const;

export const REQUIRED_RUNTIME_CHECKS = [
  "codex-ordinary-first-turn",
  "codex-expert-first-turn",
  "pi-ordinary-first-turn",
  "pi-expert-first-turn",
  "recovery",
  "cancellation",
  "mcp",
  "session-isolation",
  "packaged-identity",
  "migration-restore",
] as const;

export type CommandRunner = (
  cwd: string,
  command: string,
  args: readonly string[],
  timeoutMs: number,
) => { readonly exitCode: number | null; readonly stdout: string; readonly stderr: string };

type WorkflowDependencies = {
  readonly repository?: string;
  readonly fetcher?: ReleaseFetcher;
  readonly commandRunner?: CommandRunner;
  readonly readToolchain?: (cwd: string) => ToolchainSnapshot | null;
};

export type CheckWorkflowReport = Omit<CheckReport, "stage" | "exitCode"> & {
  readonly mainRef: string;
  readonly mainSha?: string;
  readonly stage: string;
  readonly exitCode: number | null;
};

export type PrepareWorkflowReport = PrepareReport & {
  readonly mainRef: string;
  readonly mainSha: string;
  readonly candidateSha?: string;
};

export type BindWorkflowReport = {
  readonly command: "bind";
  readonly status: "candidate-bound" | "bind-rejected" | "candidate-busy";
  readonly stage: string;
  readonly exitCode: number | null;
  readonly mainRef: string;
  readonly mainSha?: string;
  readonly baseSha: string;
  readonly target: { readonly tag: string; readonly commit: string };
  readonly candidateSha: string;
  readonly branch: string;
  readonly retryAction: string;
};

export type VerifyWorkflowReport = {
  readonly command: "verify";
  readonly status: "checks-failed" | "awaiting-runtime" | "ready" | "candidate-stale";
  readonly stage: string;
  readonly exitCode: number | null;
  readonly candidateSha: string;
  readonly baseSha?: string;
  readonly mainRef?: string;
  readonly mainSha?: string;
  readonly target?: { readonly tag: string; readonly commit: string };
  readonly lockfileHashes?: LockfileHashes;
  readonly toolchain?: ToolchainSnapshot;
  readonly checks: readonly VerificationCheck[];
  readonly runtimeEvidence: {
    readonly status: "accepted" | "missing" | "rejected";
    readonly reason?: string;
  };
  readonly retryAction: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSha(value: unknown): value is string {
  return typeof value === "string" && SHA_PATTERN.test(value);
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function gitOutput(cwd: string, args: readonly string[]): string | null {
  const result = runGit(cwd, args);
  return result.ok ? result.stdout.trim() : null;
}

function resolveRefSha(repoRoot: string, mainRef: string): string | null {
  const valid = runGit(repoRoot, ["check-ref-format", mainRef]);
  if (!valid.ok) return null;
  const result = runGit(repoRoot, ["rev-parse", "--verify", `${mainRef}^{commit}`]);
  const value = result.stdout.trim().toLowerCase();
  return result.ok && isSha(value) ? value : null;
}

async function repositoryLockFile(repoRoot: string): Promise<string> {
  return resolve(await realpath(repoRoot), "workbench/upstream.lock.json");
}

async function readCurrentLock(lockPath: string): Promise<WorkbenchSyncLock> {
  return readSyncLock(lockPath);
}

async function hashLockfile(lockPath: string): Promise<string> {
  return sha256(await readFile(lockPath));
}

async function collectLockfileHashes(checkout: string): Promise<LockfileHashes> {
  const [bunLock, upstreamLock, miseToml] = await Promise.all([
    readFile(resolve(checkout, "bun.lock")),
    readFile(resolve(checkout, "workbench/upstream.lock.json")),
    readFile(resolve(checkout, ".mise.toml")),
  ]);
  return {
    bunLock: sha256(bunLock),
    upstreamLock: sha256(upstreamLock),
    miseToml: sha256(miseToml),
  };
}

function readPinnedToolchain(checkout: string): ToolchainSnapshot | null {
  let miseToml: string;
  try {
    const result = runGit(checkout, ["show", "HEAD:.mise.toml"]);
    if (!result.ok) return null;
    miseToml = result.stdout;
  } catch {
    return null;
  }
  const node = /^\s*node\s*=\s*["']([^"']+)["']\s*$/m.exec(miseToml)?.[1];
  const bun = /^\s*bun\s*=\s*["']([^"']+)["']\s*$/m.exec(miseToml)?.[1];
  return node && bun ? { node, bun } : null;
}

function defaultReadToolchain(checkout: string): ToolchainSnapshot | null {
  const pinned = readPinnedToolchain(checkout);
  if (!pinned) return null;
  const readVersion = (command: string): string | null => {
    const result = spawnProcessSync(command, ["--version"], {
      cwd: checkout,
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      timeout: MAX_SHORT_COMMAND_MS,
    });
    if (result.status !== 0 || result.error !== undefined || typeof result.stdout !== "string") {
      return null;
    }
    return result.stdout.trim().replace(/^v/, "");
  };
  const node = readVersion("node");
  const bun = readVersion("bun");
  return node && bun ? { node, bun } : null;
}

function defaultCommandRunner(
  cwd: string,
  command: string,
  args: readonly string[],
  timeoutMs: number,
): ReturnType<CommandRunner> {
  const result = spawnProcessSync(command, args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: timeoutMs,
  });
  return {
    exitCode: result.status,
    stdout: typeof result.stdout === "string" ? result.stdout : "",
    stderr: typeof result.stderr === "string" ? result.stderr : "",
  };
}

function makeCheck(
  id: string,
  status: VerificationCheck["status"],
  exitCode: number | null,
  durationMs: number,
  reason?: string,
): VerificationCheck {
  return { id, status, exitCode, durationMs, ...(reason ? { reason } : {}) };
}

function getCheckoutIdentity(checkout: string): {
  readonly head: string | null;
  readonly branch: string | null;
  readonly status: string | null;
  readonly mergeHead: string | null;
} {
  const head = gitOutput(checkout, ["rev-parse", "--verify", "HEAD"])?.toLowerCase() ?? null;
  const branch = gitOutput(checkout, ["symbolic-ref", "--short", "-q", "HEAD"]);
  const status = gitOutput(checkout, ["status", "--porcelain=v1", "--untracked-files=all"]);
  const mergeHead =
    gitOutput(checkout, ["rev-parse", "--verify", "-q", "MERGE_HEAD"])?.toLowerCase() ?? null;
  return { head, branch, status, mergeHead };
}

function checkExitCode(status: CheckReport["status"]): number {
  return status === "network-failure" ? 1 : status === "selection-blocked" ? 2 : 0;
}

export async function checkWorkbenchSyncWorkflow(input: {
  readonly repoRoot: string;
  readonly mainRef?: string;
  readonly lockPath?: string;
  readonly dependencies?: WorkflowDependencies;
}): Promise<CheckWorkflowReport> {
  const repoRoot = await realpath(input.repoRoot);
  const mainRef = input.mainRef ?? DEFAULT_MAIN_REF;
  return withRepositoryLock(repoRoot, "check", async (paths) => {
    const lockPath = input.lockPath ?? (await repositoryLockFile(repoRoot));
    const lock = await readCurrentLock(lockPath);
    const mainSha = resolveRefSha(repoRoot, mainRef);
    if (!mainSha) {
      return {
        command: "check",
        status: "selection-blocked",
        reason: "main-ref-unavailable",
        integratedBase: lock.integratedBase,
        stage: "main-ref-resolution",
        exitCode: null,
        retryAction: "select-an-existing-commit-ref-with-main-ref",
        mainRef,
      };
    }

    const lockfileHash = await hashLockfile(lockPath);
    const report = await checkWorkbenchSync({
      repoRoot,
      lock,
      ...(input.dependencies?.repository ? { repository: input.dependencies.repository } : {}),
      ...(input.dependencies?.fetcher ? { fetcher: input.dependencies.fetcher } : {}),
    });
    const finalMainSha = resolveRefSha(repoRoot, mainRef);
    const finalReport: CheckReport =
      finalMainSha === mainSha
        ? report
        : {
            ...report,
            status: "selection-blocked",
            reason: "main-ref-moved-during-check",
            stage: "main-ref-recheck",
            retryAction: "rerun-check-against-the-current-main-ref",
          };
    const snapshot: CheckSnapshot = {
      status: finalReport.status,
      checkedAt: new Date().toISOString(),
      mainRef,
      mainSha,
      lockfileHash,
      integratedBase: finalReport.integratedBase,
      ...(finalReport.release?.commit && isSha(finalReport.release.commit)
        ? { release: finalReport.release }
        : {}),
      ...(finalReport.reason ? { reason: finalReport.reason } : {}),
    };
    const state = await readWorkbenchSyncState(paths.stateFile);
    let activeCandidate = state.activeCandidate;
    if (activeCandidate) {
      const activeMainSha = resolveRefSha(repoRoot, activeCandidate.mainRef);
      if (!activeMainSha || activeMainSha !== activeCandidate.mainSha) {
        const {
          automaticChecks: _automaticChecks,
          runtimeEvidence: _runtimeEvidence,
          runtimeEvidenceHash: _runtimeEvidenceHash,
          ...withoutEvidence
        } = activeCandidate;
        activeCandidate = {
          ...withoutEvidence,
          status: "rebind-required",
          updatedAt: new Date().toISOString(),
        };
      }
    }
    await writeWorkbenchSyncState(paths.stateFile, {
      ...state,
      lastCheck: snapshot,
      ...(activeCandidate ? { activeCandidate } : {}),
    });
    return {
      ...finalReport,
      stage: finalReport.stage ?? "release-selection",
      exitCode: finalReport.exitCode ?? null,
      mainRef,
      mainSha,
    };
  });
}

function prepareRejected(
  status: PrepareReport["status"],
  stage: string,
  baseSha: string,
  targetTag: string,
  targetSha: string,
  mainRef: string,
  mainSha: string,
  branch = expectedCandidateBranch(targetTag, targetSha || "00000000"),
  retryAction = "review-the-reported-candidate-state-before-retrying",
): PrepareWorkflowReport {
  return {
    command: "prepare",
    status,
    stage,
    exitCode: null,
    baseSha,
    target: { tag: targetTag, commit: targetSha },
    branch,
    mainRef,
    mainSha,
    retryAction,
  };
}

function activeIdentityMatches(
  candidate: ActiveCandidate,
  checkout: string,
  mainRef: string,
  baseSha: string,
  targetTag: string,
  targetSha: string,
): boolean {
  return (
    candidate.checkoutPath === checkout &&
    candidate.mainRef === mainRef &&
    candidate.baseSha === baseSha &&
    candidate.target.tag === targetTag &&
    candidate.target.commit === targetSha
  );
}

export async function prepareWorkbenchCandidate(input: {
  readonly repoRoot: string;
  readonly checkout: string;
  readonly baseSha: string;
  readonly targetTag: string;
  readonly targetSha: string;
  readonly mainRef?: string;
  readonly dependencies?: Pick<WorkflowDependencies, "repository">;
}): Promise<PrepareWorkflowReport> {
  const repoRoot = await realpath(input.repoRoot);
  const checkout = await realpath(input.checkout);
  const mainRef = input.mainRef ?? DEFAULT_MAIN_REF;
  const baseSha = input.baseSha.toLowerCase();
  const targetSha = input.targetSha.toLowerCase();
  return withRepositoryLock(repoRoot, "prepare", async (paths) => {
    const mainSha = resolveRefSha(repoRoot, mainRef);
    if (!mainSha) {
      return prepareRejected(
        "candidate-base-mismatch",
        "main-ref-resolution",
        baseSha,
        input.targetTag,
        targetSha,
        mainRef,
        "",
        undefined,
        "select-an-existing-commit-ref-with-main-ref",
      );
    }
    const checkoutPaths = await import("./state.ts").then(({ resolveRepositoryStatePaths }) =>
      resolveRepositoryStatePaths(checkout),
    );
    if (checkoutPaths.commonDirectory !== paths.commonDirectory) {
      return prepareRejected(
        "candidate-base-mismatch",
        "checkout-repository-mismatch",
        baseSha,
        input.targetTag,
        targetSha,
        mainRef,
        mainSha,
        undefined,
        "use-a-candidate-checkout-in-the-same-git-common-directory",
      );
    }
    if (resolveRefSha(checkout, mainRef) !== mainSha) {
      return prepareRejected(
        "candidate-base-mismatch",
        "main-ref-mismatch",
        baseSha,
        input.targetTag,
        targetSha,
        mainRef,
        mainSha,
        undefined,
        "refresh-the-candidate-checkout-main-ref-and-recheck",
      );
    }
    if (baseSha !== mainSha) {
      return prepareRejected(
        "candidate-base-mismatch",
        "base-is-not-current-main",
        baseSha,
        input.targetTag,
        targetSha,
        mainRef,
        mainSha,
        undefined,
        "run-check-and-prepare-against-the-current-main-sha",
      );
    }
    const state = await readWorkbenchSyncState(paths.stateFile);
    const lockPath = await repositoryLockFile(repoRoot);
    const lockfileHash = await hashLockfile(lockPath);
    const lock = await readCurrentLock(lockPath);
    const check = state.lastCheck;
    if (
      !check ||
      check.status !== "update-available" ||
      check.mainRef !== mainRef ||
      check.mainSha !== mainSha ||
      check.lockfileHash !== lockfileHash ||
      check.release?.tag !== input.targetTag ||
      check.release.commit !== targetSha
    ) {
      return prepareRejected(
        "candidate-target-missing",
        "successful-check-snapshot-required",
        baseSha,
        input.targetTag,
        targetSha,
        mainRef,
        mainSha,
        undefined,
        "run-check-and-use-its-exact-target-tag-and-sha",
      );
    }

    const officialTag = validateFixedOfficialTag(
      repoRoot,
      input.dependencies?.repository ?? lock.repository,
      input.targetTag,
      targetSha,
    );
    if (!officialTag.ok) {
      return {
        ...prepareRejected(
          officialTag.reason === "remote-unavailable" ? "prepare-failed" : "candidate-target-moved",
          `official-tag-${officialTag.reason}`,
          baseSha,
          input.targetTag,
          targetSha,
          mainRef,
          mainSha,
          undefined,
          officialTag.reason === "remote-unavailable"
            ? "retry-after-official-tag-resolution-is-available"
            : "run-check-again-and-review-the-official-tag-movement",
        ),
        exitCode: officialTag.exitCode,
      };
    }

    const canonicalCheckout = resolve(checkout);
    const active = state.activeCandidate;
    if (active) {
      if (
        !activeIdentityMatches(
          active,
          canonicalCheckout,
          mainRef,
          baseSha,
          input.targetTag,
          targetSha,
        )
      ) {
        return prepareRejected(
          "candidate-busy",
          "another-active-candidate",
          baseSha,
          input.targetTag,
          targetSha,
          mainRef,
          mainSha,
          active.branch,
          "bind-or-finish-the-existing-candidate-before-selecting-another",
        );
      }
      const identity = getCheckoutIdentity(checkout);
      if (identity.status === "") {
        if (
          identity.head === active.candidateSha &&
          identity.branch === active.branch &&
          identity.mergeHead === null
        ) {
          return {
            command: "prepare",
            status: "candidate-ready",
            stage: "existing-candidate-reused",
            exitCode: null,
            baseSha,
            target: { tag: input.targetTag, commit: targetSha },
            branch: active.branch,
            ...(active.mergeCommitSha ? { mergeCommitSha: active.mergeCommitSha } : {}),
            mainRef,
            mainSha,
            candidateSha: active.candidateSha,
            retryAction: "run-verify-on-this-exact-candidate-sha",
          };
        }
      }
      return prepareRejected(
        identity.status && identity.status.length > 0 ? "candidate-dirty" : "candidate-busy",
        identity.status && identity.status.length > 0
          ? "candidate-dirty"
          : "candidate-rebind-required",
        baseSha,
        input.targetTag,
        targetSha,
        mainRef,
        mainSha,
        active.branch,
        identity.status && identity.status.length > 0
          ? "preserve-candidate-changes-and-bind-the-exact-clean-candidate-sha-after-review"
          : "bind-the-exact-clean-candidate-sha-after-reviewing-its-history",
      );
    }

    const report = prepareCandidate({
      checkout,
      baseSha,
      targetTag: input.targetTag,
      targetSha,
    });
    if (report.status !== "candidate-ready" && report.status !== "candidate-conflict") {
      return { ...report, mainRef, mainSha };
    }

    if (report.status === "candidate-conflict") {
      const nextCandidate: ActiveCandidate = {
        status: "conflict",
        checkoutPath: canonicalCheckout,
        branch: report.branch,
        mainRef,
        mainSha,
        baseSha,
        target: { tag: input.targetTag, commit: targetSha },
        updatedAt: new Date().toISOString(),
      };
      await writeWorkbenchSyncState(paths.stateFile, { ...state, activeCandidate: nextCandidate });
      return { ...report, mainRef, mainSha };
    }

    const candidateSha = gitOutput(checkout, ["rev-parse", "--verify", "HEAD"])?.toLowerCase();
    if (!candidateSha || !isSha(candidateSha)) {
      return {
        ...report,
        status: "prepare-failed",
        stage: "candidate-head-resolution",
        exitCode: null,
        mainRef,
        mainSha,
        retryAction: "inspect-the-candidate-merge-head-before-retrying",
      };
    }
    const lockfileHashes = await collectLockfileHashes(checkout);
    const toolchain = defaultReadToolchain(checkout);
    const candidate: ActiveCandidate = {
      status: "awaiting-verification",
      checkoutPath: canonicalCheckout,
      branch: report.branch,
      mainRef,
      mainSha,
      baseSha,
      target: { tag: input.targetTag, commit: targetSha },
      candidateSha,
      ...(report.mergeCommitSha ? { mergeCommitSha: report.mergeCommitSha } : {}),
      lockfileHashes,
      ...(toolchain ? { toolchain } : {}),
      updatedAt: new Date().toISOString(),
    };
    await writeWorkbenchSyncState(paths.stateFile, { ...state, activeCandidate: candidate });
    return { ...report, mainRef, mainSha, candidateSha };
  });
}

function isAncestor(repoRoot: string, ancestor: string, descendant: string): boolean | null {
  const result = runGit(repoRoot, ["merge-base", "--is-ancestor", ancestor, descendant]);
  if (result.ok) return true;
  if (result.exitCode === 1) return false;
  return null;
}

function hasOriginalTargetMerge(
  checkout: string,
  baseSha: string,
  targetSha: string,
): string | null {
  const log = runGit(checkout, ["log", "--merges", "--format=%H%x00%P", "HEAD"]);
  if (!log.ok) return null;
  for (const line of log.stdout.split("\n")) {
    const [mergeShaRaw, parentsRaw] = line.split("\0");
    const parents = parentsRaw?.trim().split(/\s+/) ?? [];
    const mergeSha = mergeShaRaw?.trim().toLowerCase();
    const firstParent = parents[0]?.toLowerCase();
    const secondParent = parents[1]?.toLowerCase();
    if (!mergeSha || !firstParent || secondParent !== targetSha) continue;
    if (isAncestor(checkout, firstParent, baseSha) === true) return mergeSha;
  }
  return null;
}

export async function bindWorkbenchCandidate(input: {
  readonly repoRoot: string;
  readonly checkout: string;
  readonly baseSha: string;
  readonly targetTag: string;
  readonly targetSha: string;
  readonly candidateSha: string;
  readonly mainRef?: string;
  readonly dependencies?: Pick<WorkflowDependencies, "readToolchain" | "repository">;
}): Promise<BindWorkflowReport> {
  const repoRoot = await realpath(input.repoRoot);
  const checkout = await realpath(input.checkout);
  const mainRef = input.mainRef ?? DEFAULT_MAIN_REF;
  const baseSha = input.baseSha.toLowerCase();
  const targetSha = input.targetSha.toLowerCase();
  const candidateSha = input.candidateSha.toLowerCase();
  const branch = expectedCandidateBranch(input.targetTag, targetSha || "00000000");

  return withRepositoryLock(repoRoot, "bind", async (paths) => {
    const reject = (
      stage: string,
      retryAction: string,
      status: BindWorkflowReport["status"] = "bind-rejected",
    ): BindWorkflowReport => ({
      command: "bind",
      status,
      stage,
      exitCode: null,
      mainRef,
      ...(resolveRefSha(repoRoot, mainRef) ? { mainSha: resolveRefSha(repoRoot, mainRef)! } : {}),
      baseSha,
      target: { tag: input.targetTag, commit: targetSha },
      candidateSha,
      branch,
      retryAction,
    });
    if (!isSha(baseSha) || !isSha(targetSha) || !isSha(candidateSha) || !input.targetTag) {
      return reject("input-validation", "provide-full-valid-base-target-and-candidate-shas");
    }
    const mainSha = resolveRefSha(repoRoot, mainRef);
    if (!mainSha)
      return reject("main-ref-resolution", "select-an-existing-commit-ref-with-main-ref");
    if (mainSha !== baseSha)
      return reject("base-is-not-current-main", "pass-the-current-main-ref-sha-as-base");
    const checkoutMainSha = resolveRefSha(checkout, mainRef);
    if (checkoutMainSha !== baseSha)
      return reject(
        "checkout-main-ref-mismatch",
        "fetch-or-update-the-candidate-checkout-main-ref",
      );
    const checkoutPaths = await import("./state.ts").then(({ resolveRepositoryStatePaths }) =>
      resolveRepositoryStatePaths(checkout),
    );
    if (checkoutPaths.commonDirectory !== paths.commonDirectory) {
      return reject(
        "checkout-repository-mismatch",
        "bind-a-candidate-checkout-from-this-repository",
      );
    }

    let rootLock: WorkbenchSyncLock;
    try {
      rootLock = await readCurrentLock(await repositoryLockFile(repoRoot));
    } catch {
      return reject("upstream-lockfile-check", "repair-the-versioned-upstream-lock-before-binding");
    }
    const officialTag = validateFixedOfficialTag(
      repoRoot,
      input.dependencies?.repository ?? rootLock.repository,
      input.targetTag,
      targetSha,
    );
    if (!officialTag.ok) {
      return reject(
        `official-tag-${officialTag.reason}`,
        officialTag.reason === "remote-unavailable"
          ? "retry-bind-after-official-tag-resolution-is-available"
          : "review-the-official-tag-movement-before-binding",
      );
    }

    const identity = getCheckoutIdentity(checkout);
    if (identity.head !== candidateSha)
      return reject("candidate-head-mismatch", "pass-the-exact-current-candidate-head-sha");
    if (identity.branch !== branch)
      return reject(
        "candidate-branch-mismatch",
        "switch-to-the-expected-candidate-branch-without-resetting-it",
      );
    if (identity.status !== "")
      return reject(
        "candidate-dirty",
        "commit-or-remove-changes-before-binding; preserve-manual-work",
      );
    if (identity.mergeHead !== null)
      return reject(
        "candidate-merge-in-progress",
        "finish-the-current-merge-manually-before-binding",
      );

    const targetExists = runGit(checkout, ["cat-file", "-e", `${targetSha}^{commit}`]);
    if (!targetExists.ok)
      return reject("target-object-check", "fetch-the-exact-locked-target-commit-before-binding");
    const metadataPath = resolve(checkout, "workbench/sync-candidate.json");
    let metadata: unknown;
    try {
      metadata = JSON.parse(await readFile(metadataPath, "utf8")) as unknown;
    } catch {
      return reject(
        "candidate-metadata-check",
        "write-and-commit-workbench-sync-candidate-json-before-bind",
      );
    }
    const metadataTarget = isRecord(metadata) ? metadata.target : undefined;
    const metadataKeys = isRecord(metadata) ? Object.keys(metadata).toSorted().join(",") : "";
    const targetKeys = isRecord(metadataTarget)
      ? Object.keys(metadataTarget).toSorted().join(",")
      : "";
    if (
      !isRecord(metadata) ||
      metadataKeys !== "baseSha,branch,formatVersion,target" ||
      metadata.formatVersion !== 1 ||
      metadata.baseSha !== baseSha ||
      metadata.branch !== branch ||
      !isRecord(metadataTarget) ||
      targetKeys !== "commit,tag" ||
      metadataTarget.tag !== input.targetTag ||
      typeof metadataTarget.commit !== "string" ||
      metadataTarget.commit.toLowerCase() !== targetSha
    ) {
      return reject(
        "candidate-metadata-mismatch",
        "review-and-commit-metadata-for-this-base-target-and-branch",
      );
    }

    const baseIsAncestor = isAncestor(checkout, baseSha, candidateSha);
    const targetIsAncestor = isAncestor(checkout, targetSha, candidateSha);
    if (baseIsAncestor !== true || targetIsAncestor !== true) {
      return reject(
        baseIsAncestor === null || targetIsAncestor === null
          ? "candidate-history-incomplete"
          : "candidate-ancestry-mismatch",
        "fetch-complete-candidate-history-and-confirm-base-and-target-are-ancestors",
      );
    }
    const mergeSha = hasOriginalTargetMerge(checkout, baseSha, targetSha);
    if (!mergeSha)
      return reject(
        "candidate-merge-history-missing",
        "bind-requires-a-real-merge-of-the-fixed-official-target",
      );

    const state = await readWorkbenchSyncState(paths.stateFile);
    const current = state.activeCandidate;
    if (
      current &&
      (current.target.tag !== input.targetTag ||
        current.target.commit !== targetSha ||
        current.branch !== branch)
    ) {
      return reject(
        "another-active-candidate",
        "finish-or-explicitly-retire-the-existing-candidate-before-binding",
        "candidate-busy",
      );
    }
    const lockfileHashes = await collectLockfileHashes(checkout);
    const toolchain =
      input.dependencies?.readToolchain?.(checkout) ?? defaultReadToolchain(checkout);
    const candidate: ActiveCandidate = {
      status: "awaiting-verification",
      checkoutPath: checkout,
      branch,
      mainRef,
      mainSha,
      baseSha,
      target: { tag: input.targetTag, commit: targetSha },
      candidateSha,
      mergeCommitSha: mergeSha,
      lockfileHashes,
      ...(toolchain ? { toolchain } : {}),
      updatedAt: new Date().toISOString(),
    };
    await writeWorkbenchSyncState(paths.stateFile, { ...state, activeCandidate: candidate });
    return {
      command: "bind",
      status: "candidate-bound",
      stage: "candidate-validated",
      exitCode: null,
      mainRef,
      mainSha,
      baseSha,
      target: { tag: input.targetTag, commit: targetSha },
      candidateSha,
      branch,
      retryAction: "run-verify-on-this-exact-candidate-sha",
    };
  });
}

function parseRuntimeEvidence(value: unknown): RuntimeEvidence | null {
  if (!isRecord(value) || value.formatVersion !== 1) return null;
  const target = value.target;
  const hashes = value.lockfileHashes;
  const toolchain = value.toolchain;
  if (
    !isSha(value.candidateSha) ||
    !isSha(value.baseSha) ||
    typeof value.mainRef !== "string" ||
    !isSha(value.mainSha) ||
    !isRecord(target) ||
    typeof target.tag !== "string" ||
    !isSha(target.commit) ||
    !isRecord(hashes) ||
    !isSha(hashes.bunLock) ||
    !isSha(hashes.upstreamLock) ||
    !isSha(hashes.miseToml) ||
    !isRecord(toolchain) ||
    typeof toolchain.node !== "string" ||
    typeof toolchain.bun !== "string" ||
    !Array.isArray(value.checks)
  )
    return null;
  const checks = value.checks;
  if (
    !checks.every(
      (check) =>
        isRecord(check) &&
        typeof check.id === "string" &&
        check.status === "passed" &&
        typeof check.evidenceSha256 === "string" &&
        SHA256_PATTERN.test(check.evidenceSha256),
    )
  ) {
    return null;
  }
  const byId = new Map(
    checks.map((entry) => [(entry as Record<string, unknown>).id as string, entry]),
  );
  if (
    byId.size !== REQUIRED_RUNTIME_CHECKS.length ||
    REQUIRED_RUNTIME_CHECKS.some((id) => !byId.has(id))
  )
    return null;
  return value as RuntimeEvidence;
}

function runtimeEvidenceReason(
  evidence: RuntimeEvidence,
  candidate: ActiveCandidate,
  live: {
    readonly candidateSha: string;
    readonly mainSha: string;
    readonly lockfileHashes: LockfileHashes;
    readonly toolchain: ToolchainSnapshot;
  },
): string | null {
  if (
    evidence.candidateSha !== live.candidateSha ||
    evidence.baseSha !== candidate.baseSha ||
    evidence.mainRef !== candidate.mainRef ||
    evidence.mainSha !== live.mainSha ||
    evidence.target.tag !== candidate.target.tag ||
    evidence.target.commit !== candidate.target.commit ||
    evidence.lockfileHashes.bunLock !== live.lockfileHashes.bunLock ||
    evidence.lockfileHashes.upstreamLock !== live.lockfileHashes.upstreamLock ||
    evidence.lockfileHashes.miseToml !== live.lockfileHashes.miseToml ||
    evidence.toolchain.node !== live.toolchain.node ||
    evidence.toolchain.bun !== live.toolchain.bun
  )
    return "runtime-evidence-binding-mismatch";
  return null;
}

function staleChecks(reason: string): VerificationCheck[] {
  return AUTOMATIC_CHECKS.map(({ id }) => makeCheck(id, "not-run", null, 0, reason));
}

function hasCompletePassedAutomaticChecks(
  checks: readonly VerificationCheck[] | undefined,
): boolean {
  if (!checks || checks.length !== AUTOMATIC_CHECKS.length) return false;
  const byId = new Map(checks.map((check) => [check.id, check]));
  return (
    byId.size === AUTOMATIC_CHECKS.length &&
    AUTOMATIC_CHECKS.every(({ id }) => {
      const check = byId.get(id);
      return check?.status === "passed" && check.exitCode === 0;
    })
  );
}

export async function verifyWorkbenchCandidate(input: {
  readonly repoRoot: string;
  readonly candidateSha: string;
  readonly runtimeEvidencePath?: string;
  readonly dependencies?: WorkflowDependencies;
}): Promise<VerifyWorkflowReport> {
  const repoRoot = await realpath(input.repoRoot);
  const candidateSha = input.candidateSha.toLowerCase();
  return withRepositoryLock(repoRoot, "verify", async (paths) => {
    const state = await readWorkbenchSyncState(paths.stateFile);
    const candidate = state.activeCandidate;
    const genericFailure = async (
      stage: string,
      reason: string,
      invalidate = false,
    ): Promise<VerifyWorkflowReport> => {
      if (candidate && invalidate) {
        const {
          automaticChecks: _automaticChecks,
          runtimeEvidence: _runtimeEvidence,
          runtimeEvidenceHash: _runtimeEvidenceHash,
          ...withoutEvidence
        } = candidate;
        await writeWorkbenchSyncState(paths.stateFile, {
          ...state,
          activeCandidate: {
            ...withoutEvidence,
            status: "rebind-required",
            updatedAt: new Date().toISOString(),
          },
        });
      }
      return {
        command: "verify",
        status: "candidate-stale",
        stage,
        exitCode: null,
        candidateSha,
        ...(candidate
          ? {
              baseSha: candidate.baseSha,
              mainRef: candidate.mainRef,
              mainSha: candidate.mainSha,
              target: candidate.target,
            }
          : {}),
        checks: staleChecks(reason),
        runtimeEvidence: { status: "missing", reason },
        retryAction: "bind-the-exact-clean-candidate-sha-before-verifying",
      };
    };
    if (!isSha(candidateSha)) return genericFailure("input-validation", "candidate-sha-invalid");
    if (!candidate?.candidateSha) return genericFailure("candidate-state", "no-bound-candidate");
    if (candidate.candidateSha !== candidateSha)
      return genericFailure("candidate-sha-mismatch", "candidate-sha-does-not-match-bound-state");

    const checkout = candidate.checkoutPath;
    const identity = getCheckoutIdentity(checkout);
    if (identity.head !== candidateSha)
      return genericFailure("candidate-head-mismatch", "candidate-head-changed-since-bind", true);
    if (identity.branch !== candidate.branch)
      return genericFailure(
        "candidate-branch-mismatch",
        "candidate-branch-changed-since-bind",
        true,
      );
    if (identity.status !== "")
      return genericFailure("candidate-dirty", "candidate-checkout-is-dirty", true);
    if (identity.mergeHead !== null)
      return genericFailure("candidate-merge-in-progress", "candidate-merge-is-in-progress", true);
    const mainSha = resolveRefSha(repoRoot, candidate.mainRef);
    if (!mainSha || mainSha !== candidate.mainSha || candidate.baseSha !== mainSha) {
      return genericFailure(
        "main-ref-advanced",
        "main-ref-sha-changed-since-candidate-binding",
        true,
      );
    }
    const candidateMainSha = resolveRefSha(checkout, candidate.mainRef);
    if (candidateMainSha !== mainSha)
      return genericFailure(
        "candidate-main-ref-mismatch",
        "candidate-checkout-main-ref-changed",
        true,
      );

    let lockfileHashes: LockfileHashes;
    try {
      lockfileHashes = await collectLockfileHashes(checkout);
    } catch {
      return genericFailure("lockfile-read", "required-lockfile-unavailable", true);
    }
    if (
      !candidate.lockfileHashes ||
      JSON.stringify(candidate.lockfileHashes) !== JSON.stringify(lockfileHashes)
    )
      return genericFailure(
        "lockfile-changed",
        "lockfile-hashes-changed-since-candidate-binding",
        true,
      );

    const readToolchain = input.dependencies?.readToolchain ?? defaultReadToolchain;
    const toolchain = readToolchain(checkout);
    if (!toolchain)
      return genericFailure("toolchain-resolution", "actual-node-or-bun-version-unavailable", true);
    const pinned = readPinnedToolchain(checkout);
    if (!pinned || toolchain.node !== pinned.node || toolchain.bun !== pinned.bun) {
      return genericFailure(
        "toolchain-mismatch",
        "actual-node-or-bun-version-does-not-match-mise-lock",
        true,
      );
    }
    if (candidate.toolchain && JSON.stringify(candidate.toolchain) !== JSON.stringify(toolchain)) {
      return genericFailure("toolchain-changed", "toolchain-changed-since-candidate-binding", true);
    }

    const commandRunner = input.dependencies?.commandRunner ?? defaultCommandRunner;
    const checks: VerificationCheck[] = [];
    for (const { id, script } of AUTOMATIC_CHECKS) {
      const startedAt = Date.now();
      let result: ReturnType<CommandRunner>;
      try {
        result = commandRunner(checkout, "bun", ["run", script], MAX_GATE_MS);
      } catch {
        checks.push(makeCheck(id, "failed", null, Date.now() - startedAt, "gate-runner-threw"));
        continue;
      }
      checks.push(
        makeCheck(
          id,
          result.exitCode === 0 ? "passed" : "failed",
          result.exitCode,
          Date.now() - startedAt,
          result.exitCode === 0 ? undefined : `bun-run-${script}-failed`,
        ),
      );
    }

    const postIdentity = getCheckoutIdentity(checkout);
    const postMainSha = resolveRefSha(repoRoot, candidate.mainRef);
    let stable =
      postIdentity.head === candidateSha &&
      postIdentity.branch === candidate.branch &&
      postIdentity.status === "" &&
      postIdentity.mergeHead === null &&
      postMainSha === mainSha;
    try {
      const afterHashes = await collectLockfileHashes(checkout);
      stable = stable && JSON.stringify(afterHashes) === JSON.stringify(lockfileHashes);
    } catch {
      stable = false;
    }
    const currentToolchain = readToolchain(checkout);
    stable =
      stable &&
      !!currentToolchain &&
      JSON.stringify(currentToolchain) === JSON.stringify(toolchain);
    if (!stable)
      checks.push(
        makeCheck(
          "candidate-stability",
          "failed",
          null,
          0,
          "candidate-or-main-changed-during-verification",
        ),
      );

    const automaticPassed =
      stable &&
      checks.length === AUTOMATIC_CHECKS.length &&
      checks.every((entry) => entry.status === "passed");
    const runtimeEvidencePath = input.runtimeEvidencePath
      ? resolve(input.runtimeEvidencePath)
      : undefined;
    let runtimeEvidence: RuntimeEvidence | undefined;
    let evidenceStatus: VerifyWorkflowReport["runtimeEvidence"] = {
      status: "missing",
      reason: "runtime-evidence-not-provided",
    };
    let evidenceHash: string | undefined;
    if (runtimeEvidencePath) {
      try {
        const content = await readFile(runtimeEvidencePath);
        const parsed = parseRuntimeEvidence(JSON.parse(content.toString("utf8")) as unknown);
        if (!parsed) {
          evidenceStatus = { status: "rejected", reason: "runtime-evidence-schema-invalid" };
        } else {
          const reason = runtimeEvidenceReason(parsed, candidate, {
            candidateSha,
            mainSha,
            lockfileHashes,
            toolchain,
          });
          if (reason) evidenceStatus = { status: "rejected", reason };
          else {
            runtimeEvidence = parsed;
            evidenceHash = sha256(JSON.stringify(parsed));
            evidenceStatus = { status: "accepted" };
          }
        }
      } catch {
        evidenceStatus = { status: "rejected", reason: "runtime-evidence-unreadable" };
      }
    } else if (candidate.runtimeEvidence) {
      const reason = runtimeEvidenceReason(candidate.runtimeEvidence, candidate, {
        candidateSha,
        mainSha,
        lockfileHashes,
        toolchain,
      });
      if (!reason) {
        const expectedEvidenceHash = sha256(JSON.stringify(candidate.runtimeEvidence));
        if (candidate.runtimeEvidenceHash === expectedEvidenceHash) {
          runtimeEvidence = candidate.runtimeEvidence;
          evidenceStatus = { status: "accepted" };
          evidenceHash = candidate.runtimeEvidenceHash;
        } else {
          evidenceStatus = {
            status: "rejected",
            reason: "persisted-runtime-evidence-hash-mismatch",
          };
        }
      }
    }

    const ready = automaticPassed && evidenceStatus.status === "accepted";
    const {
      runtimeEvidence: _priorRuntimeEvidence,
      runtimeEvidenceHash: _priorRuntimeEvidenceHash,
      ...candidateWithoutRuntimeEvidence
    } = candidate;
    const nextCandidate: ActiveCandidate = {
      ...candidateWithoutRuntimeEvidence,
      status: !automaticPassed ? "checks-failed" : ready ? "ready" : "awaiting-runtime",
      candidateSha,
      lockfileHashes,
      toolchain,
      automaticChecks: checks,
      ...(runtimeEvidence
        ? {
            runtimeEvidence,
            runtimeEvidenceHash: evidenceHash ?? sha256(JSON.stringify(runtimeEvidence)),
          }
        : {}),
      updatedAt: new Date().toISOString(),
    };
    await writeWorkbenchSyncState(paths.stateFile, {
      ...state,
      activeCandidate: nextCandidate,
    });
    const failed = checks.some((entry) => entry.status === "failed");
    return {
      command: "verify",
      status: !automaticPassed ? "checks-failed" : ready ? "ready" : "awaiting-runtime",
      stage: !automaticPassed
        ? "automatic-checks"
        : ready
          ? "runtime-evidence-accepted"
          : "awaiting-runtime-evidence",
      exitCode: failed ? 1 : null,
      candidateSha,
      baseSha: candidate.baseSha,
      mainRef: candidate.mainRef,
      mainSha,
      target: candidate.target,
      lockfileHashes,
      toolchain,
      checks,
      runtimeEvidence: evidenceStatus,
      retryAction: !automaticPassed
        ? "repair-the-reported-check-failures-and-rerun-verify-on-this-exact-sha"
        : ready
          ? "candidate-is-ready-for-explicit-integration-review"
          : "provide-strict-runtime-evidence-for-this-exact-candidate-sha",
    };
  });
}

export async function statusWorkbenchSync(input: {
  readonly repoRoot: string;
  readonly dependencies?: Pick<WorkflowDependencies, "readToolchain">;
}): Promise<Record<string, unknown>> {
  const repoRoot = await realpath(input.repoRoot);
  const paths = await import("./state.ts").then(({ resolveRepositoryStatePaths }) =>
    resolveRepositoryStatePaths(repoRoot),
  );
  const state = await readWorkbenchSyncState(paths.stateFile);
  const lock = await readRepositoryLockStatus(paths.lockDirectory);
  const candidate = state.activeCandidate;
  if (!candidate) {
    return {
      command: "status",
      status: state.lastCheck?.status ?? "no-candidate",
      stage: "persisted-state-inspected",
      exitCode: null,
      lastCheck: state.lastCheck,
      operationLock: lock,
      retryAction:
        state.lastCheck?.status === "update-available"
          ? "prepare-the-exact-target-from-the-last-check"
          : "run-check-to-refresh-official-release-status",
    };
  }

  const checkoutIdentity = getCheckoutIdentity(candidate.checkoutPath);
  if (candidate.status === "conflict" && checkoutIdentity.mergeHead !== null) {
    return {
      command: "status",
      status: "conflict",
      stage: "merge-conflict-unresolved",
      exitCode: null,
      candidate: {
        status: candidate.status,
        branch: candidate.branch,
        baseSha: candidate.baseSha,
        mainRef: candidate.mainRef,
        mainSha: candidate.mainSha,
        target: candidate.target,
      },
      invalidations: ["merge-conflict-unresolved"],
      lastCheck: state.lastCheck,
      operationLock: lock,
      retryAction: "resolve-the-merge-manually-without-resetting-or-aborting-the-candidate",
    };
  }
  const invalidations: string[] = [];
  if (checkoutIdentity.head !== candidate.candidateSha)
    invalidations.push("candidate-head-changed");
  if (checkoutIdentity.branch !== candidate.branch) invalidations.push("candidate-branch-changed");
  if (checkoutIdentity.status !== "") invalidations.push("candidate-checkout-dirty-or-unavailable");
  if (checkoutIdentity.mergeHead !== null) invalidations.push("merge-in-progress");
  const mainSha = resolveRefSha(repoRoot, candidate.mainRef);
  if (!mainSha || mainSha !== candidate.mainSha || mainSha !== candidate.baseSha)
    invalidations.push("main-ref-advanced-or-unavailable");
  if (resolveRefSha(candidate.checkoutPath, candidate.mainRef) !== mainSha)
    invalidations.push("candidate-main-ref-mismatch");
  let lockfileHashes: LockfileHashes | undefined;
  try {
    lockfileHashes = await collectLockfileHashes(candidate.checkoutPath);
    if (
      !candidate.lockfileHashes ||
      JSON.stringify(lockfileHashes) !== JSON.stringify(candidate.lockfileHashes)
    )
      invalidations.push("lockfile-hashes-changed");
  } catch {
    invalidations.push("lockfile-unavailable");
  }
  const toolchain = (input.dependencies?.readToolchain ?? defaultReadToolchain)(
    candidate.checkoutPath,
  );
  const pinnedToolchain = readPinnedToolchain(candidate.checkoutPath);
  if (!toolchain) invalidations.push("toolchain-unavailable");
  else if (candidate.toolchain && JSON.stringify(toolchain) !== JSON.stringify(candidate.toolchain))
    invalidations.push("toolchain-changed");
  else if (!candidate.toolchain) invalidations.push("toolchain-unbound");
  if (
    toolchain &&
    pinnedToolchain &&
    (toolchain.node !== pinnedToolchain.node || toolchain.bun !== pinnedToolchain.bun)
  ) {
    invalidations.push("toolchain-not-pinned");
  }
  if (candidate.status === "ready") {
    if (!hasCompletePassedAutomaticChecks(candidate.automaticChecks))
      invalidations.push("automatic-checks-incomplete-or-invalid");
    if (!candidate.runtimeEvidence || !candidate.runtimeEvidenceHash)
      invalidations.push("runtime-evidence-missing");
    else {
      const runtimeEvidence = parseRuntimeEvidence(candidate.runtimeEvidence);
      if (!runtimeEvidence) invalidations.push("runtime-evidence-schema-invalid");
      else if (sha256(JSON.stringify(runtimeEvidence)) !== candidate.runtimeEvidenceHash)
        invalidations.push("runtime-evidence-hash-mismatch");
      else if (
        toolchain &&
        lockfileHashes &&
        runtimeEvidenceReason(runtimeEvidence, candidate, {
          candidateSha: candidate.candidateSha ?? "",
          mainSha: mainSha ?? "",
          lockfileHashes,
          toolchain,
        })
      )
        invalidations.push("runtime-evidence-binding-mismatch");
    }
  }
  const stateStatus = candidate.status;
  const status = invalidations.length > 0 ? "rebind-required" : stateStatus;
  return {
    command: "status",
    status,
    stage:
      invalidations.length > 0 ? "evidence-invalidation-detected" : "persisted-state-inspected",
    exitCode: null,
    candidate: {
      status: stateStatus,
      branch: candidate.branch,
      candidateSha: candidate.candidateSha,
      baseSha: candidate.baseSha,
      mainRef: candidate.mainRef,
      mainSha: candidate.mainSha,
      target: candidate.target,
      mergeCommitSha: candidate.mergeCommitSha,
      lockfileHashes: candidate.lockfileHashes,
      toolchain: candidate.toolchain,
      automaticChecks: candidate.automaticChecks,
      runtimeEvidenceHash: candidate.runtimeEvidenceHash,
      updatedAt: candidate.updatedAt,
    },
    invalidations,
    lastCheck: state.lastCheck,
    operationLock: lock,
    retryAction:
      invalidations.length > 0
        ? "review-the-candidate-and-bind-its-exact-clean-sha-again"
        : stateStatus === "awaiting-runtime"
          ? "provide-runtime-evidence-bound-to-this-exact-sha"
          : stateStatus === "checks-failed"
            ? "repair-failing-checks-and-rerun-verify"
            : "continue-the-explicit-candidate-review-step",
  };
}

export function parseMainRef(args: Map<string, string>): string {
  return args.get("--main-ref") ?? DEFAULT_MAIN_REF;
}

export function reportExitCode(report: Record<string, unknown>): number {
  if (report.exitCode === 1) return 1;
  if (
    report.status === "candidate-ready" ||
    report.status === "candidate-bound" ||
    report.status === "awaiting-runtime" ||
    report.status === "ready" ||
    report.status === "no-update" ||
    report.status === "update-available"
  )
    return 0;
  if (
    report.status === "checks-failed" ||
    report.status === "network-failure" ||
    report.status === "prepare-failed"
  )
    return 1;
  return 2;
}

export const workbenchSyncConstants = {
  defaultMainRef: DEFAULT_MAIN_REF,
  gateTimeoutMs: MAX_GATE_MS,
  checkExitCode,
};
