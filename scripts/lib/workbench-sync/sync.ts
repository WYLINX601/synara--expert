import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { sanitizeBranchFragment } from "@synara/shared/git";
import { runGit } from "./git.ts";
import {
  fetchLatestStableRelease,
  OFFICIAL_REPOSITORY,
  ReleaseMetadataError,
  type ReleaseFetcher,
  type StableRelease,
} from "./releases.ts";

const SHA_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
const MAX_GIT_FETCH_MS = 120_000;
const INITIAL_FETCH_DEPTH = 32;
const DEEPEN_STEPS = [128, 512, 2048, 4096] as const;

export type WorkbenchSyncLock = {
  readonly formatVersion: 1;
  readonly repository: string;
  readonly branch: "main";
  readonly updateChannel: "latest-stable-release";
  readonly integrationStrategy: "merge";
  readonly integratedBase: { readonly tag: string; readonly commit: string };
  readonly candidate: { readonly tag: string; readonly commit: string; readonly status: string };
};

export type CheckReport = {
  readonly command: "check";
  readonly status: "no-update" | "update-available" | "selection-blocked" | "network-failure";
  readonly reason?: string;
  readonly integratedBase: { readonly tag: string; readonly commit: string };
  readonly release?: {
    readonly tag: string;
    readonly commit: string;
    readonly publishedAt: string;
  };
  readonly stage?: string;
  readonly exitCode?: number | null;
  readonly retryAction: string;
};

export type PrepareReport = {
  readonly command: "prepare";
  readonly status:
    | "candidate-ready"
    | "candidate-conflict"
    | "candidate-dirty"
    | "candidate-base-mismatch"
    | "candidate-target-missing"
    | "candidate-busy"
    | "prepare-failed";
  readonly stage: string;
  readonly exitCode: number | null;
  readonly baseSha: string;
  readonly target: { readonly tag: string; readonly commit: string };
  readonly branch: string;
  readonly mergeCommitSha?: string;
  readonly conflictFiles?: readonly string[];
  readonly retryAction: string;
};

type RemoteTag = { readonly objectSha: string; readonly commitSha: string };

function asSha(value: unknown): string | null {
  return typeof value === "string" && SHA_PATTERN.test(value) ? value.toLowerCase() : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readSyncLock(lockPath: string): WorkbenchSyncLock {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(lockPath, "utf8")) as unknown;
  } catch {
    throw new Error("lock-file-unreadable");
  }
  if (!isRecord(value)) throw new Error("lock-file-invalid");
  const base = value.integratedBase;
  const candidate = value.candidate;
  if (
    value.formatVersion !== 1 ||
    value.repository !== OFFICIAL_REPOSITORY ||
    value.branch !== "main" ||
    value.updateChannel !== "latest-stable-release" ||
    value.integrationStrategy !== "merge" ||
    !isRecord(base) ||
    typeof base.tag !== "string" ||
    asSha(base.commit) === null ||
    !isRecord(candidate) ||
    typeof candidate.tag !== "string" ||
    asSha(candidate.commit) === null ||
    typeof candidate.status !== "string"
  ) {
    throw new Error("lock-file-invalid");
  }
  return value as WorkbenchSyncLock;
}

function parseRemoteTags(output: string): Map<string, RemoteTag> {
  const entries = new Map<string, { objectSha: string; peeledSha?: string }>();
  for (const line of output.split("\n")) {
    const separator = line.indexOf("\t");
    if (separator < 0) continue;
    const objectSha = line.slice(0, separator).toLowerCase();
    const refName = line.slice(separator + 1).trim();
    if (!SHA_PATTERN.test(objectSha) || !refName.startsWith("refs/tags/")) continue;
    const peeled = refName.endsWith("^{}");
    const tag = refName.slice("refs/tags/".length, peeled ? -3 : undefined);
    const previous = entries.get(tag) ?? { objectSha };
    entries.set(tag, peeled ? { ...previous, peeledSha: objectSha } : { ...previous, objectSha });
  }
  return new Map(
    [...entries.entries()].map(([tag, value]) => [
      tag,
      { objectSha: value.objectSha, commitSha: value.peeledSha ?? value.objectSha },
    ]),
  );
}

function tagDestination(tag: string): string {
  const key = createHash("sha256").update(tag).digest("hex").slice(0, 24);
  return `refs/workbench-sync/check/${key}`;
}

function resolveRemoteTags(
  repoRoot: string,
  repository: string,
):
  | { readonly ok: true; readonly tags: Map<string, RemoteTag> }
  | { readonly ok: false; readonly exitCode: number | null } {
  const args = ["ls-remote", "--tags", repository] as const;
  const first = runGit(repoRoot, args, MAX_GIT_FETCH_MS);
  const result =
    first.ok || process.env.SYNARA_WORKBENCH_SYNC_HTTP11_RETRY === "0"
      ? first
      : runGit(repoRoot, ["-c", "http.version=HTTP/1.1", ...args], MAX_GIT_FETCH_MS);
  return result.ok
    ? { ok: true, tags: parseRemoteTags(result.stdout) }
    : { ok: false, exitCode: result.exitCode };
}

function fetchTag(
  repoRoot: string,
  repository: string,
  tag: string,
  deepen?: number,
):
  | { readonly ok: true; readonly commitSha: string }
  | { readonly ok: false; readonly exitCode: number | null } {
  const tagCheck = runGit(repoRoot, ["check-ref-format", `refs/tags/${tag}`]);
  if (!tagCheck.ok) return { ok: false, exitCode: tagCheck.exitCode };

  const destination = tagDestination(tag);
  const depthArgs =
    deepen === undefined ? [`--depth=${INITIAL_FETCH_DEPTH}`] : [`--deepen=${deepen}`];
  const args = [
    "fetch",
    "--no-tags",
    ...depthArgs,
    repository,
    `+refs/tags/${tag}:${destination}`,
  ] as const;
  const first = runGit(repoRoot, args, MAX_GIT_FETCH_MS);
  const fetched =
    first.ok || process.env.SYNARA_WORKBENCH_SYNC_HTTP11_RETRY === "0"
      ? first
      : runGit(repoRoot, ["-c", "http.version=HTTP/1.1", ...args], MAX_GIT_FETCH_MS);
  if (!fetched.ok) return { ok: false, exitCode: fetched.exitCode };

  const revision = runGit(repoRoot, ["rev-parse", "--verify", `${destination}^{commit}`]);
  const commitSha = revision.stdout.trim().toLowerCase();
  return revision.ok && SHA_PATTERN.test(commitSha)
    ? { ok: true, commitSha }
    : { ok: false, exitCode: revision.exitCode };
}

function hasRelevantShallowBoundary(repoRoot: string, revisions: readonly string[]): boolean {
  const shallowPathResult = runGit(repoRoot, ["rev-parse", "--git-path", "shallow"]);
  if (!shallowPathResult.ok) return false;
  const shallowPath = shallowPathResult.stdout.trim();
  const resolvedPath = isAbsolute(shallowPath) ? shallowPath : resolve(repoRoot, shallowPath);
  let boundaryShas: string[];
  try {
    boundaryShas = readFileSync(resolvedPath, "utf8")
      .split(/\s+/)
      .map((sha) => sha.trim().toLowerCase())
      .filter((sha) => SHA_PATTERN.test(sha));
  } catch {
    return false;
  }

  for (const boundarySha of boundaryShas) {
    for (const revision of revisions) {
      const reachesBoundary = isAncestor(repoRoot, boundarySha, revision);
      if (reachesBoundary === true) return true;
    }
  }
  return false;
}

function isAncestor(repoRoot: string, ancestor: string, descendant: string): boolean | null {
  const result = runGit(repoRoot, ["merge-base", "--is-ancestor", ancestor, descendant]);
  if (result.ok) return true;
  if (result.exitCode === 1) return false;
  return null;
}

export async function checkWorkbenchSync(input: {
  readonly repoRoot: string;
  readonly lock: WorkbenchSyncLock;
  readonly repository?: string;
  readonly fetcher?: ReleaseFetcher;
}): Promise<CheckReport> {
  const { repoRoot, lock } = input;
  const repository = input.repository ?? lock.repository;
  const integratedBaseSha = lock.integratedBase.commit.toLowerCase();
  let release: StableRelease;
  try {
    release = await fetchLatestStableRelease(input.fetcher);
  } catch (error) {
    const failure = error instanceof ReleaseMetadataError ? error.failure : "unknown";
    const isNetworkFailure = failure === "network" || failure === "http";
    return {
      command: "check",
      status: isNetworkFailure ? "network-failure" : "selection-blocked",
      reason: failure,
      integratedBase: lock.integratedBase,
      stage: "release-metadata",
      ...(error instanceof ReleaseMetadataError ? { exitCode: error.httpStatus ?? null } : {}),
      retryAction: isNetworkFailure
        ? "rerun-workbench-sync-check"
        : "inspect-official-release-metadata-and-retry",
    };
  }

  const remote = resolveRemoteTags(repoRoot, repository);
  if (!remote.ok) {
    return {
      command: "check",
      status: "network-failure",
      reason: "git-ls-remote-failed",
      integratedBase: lock.integratedBase,
      release: { ...release, commit: "unresolved" },
      stage: "tag-resolution",
      exitCode: remote.exitCode,
      retryAction: "rerun-workbench-sync-check",
    };
  }

  const target = remote.tags.get(release.tag);
  if (!target) {
    return {
      command: "check",
      status: "selection-blocked",
      reason: "release-tag-missing",
      integratedBase: lock.integratedBase,
      release: { ...release, commit: "unresolved" },
      retryAction: "review-release-tag-before-retrying",
    };
  }

  const lockedTags = [lock.integratedBase, lock.candidate];
  for (const locked of lockedTags) {
    const current = remote.tags.get(locked.tag);
    if (!current) {
      return {
        command: "check",
        status: "selection-blocked",
        reason: "locked-tag-missing",
        integratedBase: lock.integratedBase,
        release: { ...release, commit: "unresolved" },
        retryAction: "review-release-tags-and-lock-file",
      };
    }
    if (current.commitSha !== locked.commit.toLowerCase()) {
      return {
        command: "check",
        status: "selection-blocked",
        reason: "locked-tag-moved",
        integratedBase: lock.integratedBase,
        release: { ...release, commit: target.commitSha },
        retryAction: "review-release-tag-movement-before-updating-lock",
      };
    }
  }

  const baseFetch = fetchTag(repoRoot, repository, lock.integratedBase.tag);
  if (!baseFetch.ok) {
    return {
      command: "check",
      status: "network-failure",
      reason: "git-fetch-failed",
      integratedBase: lock.integratedBase,
      release: { ...release, commit: target.commitSha },
      stage: "integrated-base-fetch",
      exitCode: baseFetch.exitCode,
      retryAction: "rerun-workbench-sync-check",
    };
  }
  if (baseFetch.commitSha !== integratedBaseSha) {
    return {
      command: "check",
      status: "selection-blocked",
      reason: "integrated-tag-moved-during-check",
      integratedBase: lock.integratedBase,
      release: { ...release, commit: target.commitSha },
      retryAction: "review-release-tag-movement-before-updating-lock",
    };
  }

  const targetFetch =
    release.tag === lock.integratedBase.tag
      ? baseFetch
      : fetchTag(repoRoot, repository, release.tag);
  if (!targetFetch.ok) {
    return {
      command: "check",
      status: "network-failure",
      reason: "git-fetch-failed",
      integratedBase: lock.integratedBase,
      release: { ...release, commit: target.commitSha },
      stage: "release-target-fetch",
      exitCode: targetFetch.exitCode,
      retryAction: "rerun-workbench-sync-check",
    };
  }
  if (targetFetch.commitSha !== target.commitSha) {
    return {
      command: "check",
      status: "selection-blocked",
      reason: "release-tag-moved-during-check",
      integratedBase: lock.integratedBase,
      release: { ...release, commit: targetFetch.commitSha },
      retryAction: "review-release-tag-movement-before-updating-lock",
    };
  }

  const selectedRelease = { ...release, commit: target.commitSha };
  if (target.commitSha === integratedBaseSha) {
    return {
      command: "check",
      status: "no-update",
      reason: "latest-stable-matches-integrated-base",
      integratedBase: lock.integratedBase,
      release: selectedRelease,
      retryAction: "check-after-next-stable-release",
    };
  }

  const ancestry = (): {
    readonly baseIsAncestor: boolean | null;
    readonly targetIsAncestor: boolean | null;
  } => ({
    baseIsAncestor: isAncestor(repoRoot, integratedBaseSha, target.commitSha),
    targetIsAncestor: isAncestor(repoRoot, target.commitSha, integratedBaseSha),
  });
  let { baseIsAncestor, targetIsAncestor } = ancestry();
  if (baseIsAncestor === null || targetIsAncestor === null) {
    return {
      command: "check",
      status: "network-failure",
      reason: "git-ancestry-check-failed",
      integratedBase: lock.integratedBase,
      release: selectedRelease,
      stage: "ancestry-check",
      retryAction: "rerun-workbench-sync-check",
    };
  }
  if (
    !baseIsAncestor &&
    !targetIsAncestor &&
    hasRelevantShallowBoundary(repoRoot, [integratedBaseSha, target.commitSha])
  ) {
    let historyComplete = false;
    for (const deepen of DEEPEN_STEPS) {
      const deepenedBase = fetchTag(repoRoot, repository, lock.integratedBase.tag, deepen);
      if (!deepenedBase.ok) {
        return {
          command: "check",
          status: "network-failure",
          reason: "git-fetch-failed",
          integratedBase: lock.integratedBase,
          release: selectedRelease,
          stage: "ancestry-deepen-base",
          exitCode: deepenedBase.exitCode,
          retryAction: "rerun-workbench-sync-check",
        };
      }
      const deepenedTarget =
        release.tag === lock.integratedBase.tag
          ? deepenedBase
          : fetchTag(repoRoot, repository, release.tag, deepen);
      if (!deepenedTarget.ok) {
        return {
          command: "check",
          status: "network-failure",
          reason: "git-fetch-failed",
          integratedBase: lock.integratedBase,
          release: selectedRelease,
          stage: "ancestry-deepen-target",
          exitCode: deepenedTarget.exitCode,
          retryAction: "rerun-workbench-sync-check",
        };
      }
      if (
        deepenedBase.commitSha !== integratedBaseSha ||
        deepenedTarget.commitSha !== target.commitSha
      ) {
        return {
          command: "check",
          status: "selection-blocked",
          reason: "release-tag-moved-during-check",
          integratedBase: lock.integratedBase,
          release: selectedRelease,
          retryAction: "review-release-tag-movement-before-updating-lock",
        };
      }
      ({ baseIsAncestor, targetIsAncestor } = ancestry());
      if (baseIsAncestor === null || targetIsAncestor === null) {
        return {
          command: "check",
          status: "network-failure",
          reason: "git-ancestry-check-failed",
          integratedBase: lock.integratedBase,
          release: selectedRelease,
          stage: "ancestry-check",
          retryAction: "rerun-workbench-sync-check",
        };
      }
      if (baseIsAncestor || targetIsAncestor) {
        historyComplete = true;
        break;
      }
      if (!hasRelevantShallowBoundary(repoRoot, [integratedBaseSha, target.commitSha])) {
        historyComplete = true;
        break;
      }
    }
    if (!historyComplete) {
      return {
        command: "check",
        status: "selection-blocked",
        reason: "history-incomplete",
        integratedBase: lock.integratedBase,
        release: selectedRelease,
        retryAction: "deepen-official-lineage-or-retry-check-later",
      };
    }
  }

  if (baseIsAncestor) {
    return {
      command: "check",
      status: "update-available",
      reason: "integrated-base-is-ancestor-of-release",
      integratedBase: lock.integratedBase,
      release: selectedRelease,
      retryAction: "prepare-explicit-candidate-from-fixed-shas",
    };
  }
  return {
    command: "check",
    status: "selection-blocked",
    reason: targetIsAncestor ? "release-target-behind-integrated-base" : "release-target-diverged",
    integratedBase: lock.integratedBase,
    release: selectedRelease,
    retryAction: "review-upstream-lineage-before-selecting-a-target",
  };
}

function shortSha(sha: string): string {
  return sha.slice(0, 8).toLowerCase();
}

function expectedCandidateBranch(tag: string, targetSha: string): string {
  return `codex/sync-${sanitizeBranchFragment(tag)}-${shortSha(targetSha)}`;
}

function getConflictFiles(checkout: string): string[] {
  const result = runGit(checkout, ["diff", "--name-only", "--diff-filter=U", "-z"]);
  return result.ok ? result.stdout.split("\0").filter((entry) => entry.length > 0) : [];
}

function getMergeHead(checkout: string): string | null {
  const result = runGit(checkout, ["rev-parse", "--verify", "-q", "MERGE_HEAD"]);
  return result.ok ? result.stdout.trim().toLowerCase() : null;
}

function findExistingMerge(checkout: string, baseSha: string, targetSha: string): string | null {
  const log = runGit(checkout, ["log", "--first-parent", "--merges", "--format=%H%x00%P", "HEAD"]);
  if (!log.ok) return null;
  for (const line of log.stdout.split("\n")) {
    const [mergeSha, parents] = line.split("\0");
    if (!mergeSha || !parents) continue;
    const [firstParent, secondParent] = parents.trim().split(/\s+/);
    if (
      firstParent?.toLowerCase() === baseSha.toLowerCase() &&
      secondParent?.toLowerCase() === targetSha.toLowerCase()
    ) {
      return mergeSha.toLowerCase();
    }
  }
  return null;
}

function makePrepareReport(
  status: PrepareReport["status"],
  baseSha: string,
  tag: string,
  targetSha: string,
  branch: string,
  retryAction: string,
  extras: Partial<
    Pick<PrepareReport, "mergeCommitSha" | "conflictFiles" | "stage" | "exitCode">
  > = {},
): PrepareReport {
  return {
    command: "prepare",
    status,
    stage:
      extras.stage ??
      (status === "candidate-ready"
        ? "candidate-ready"
        : status === "candidate-conflict"
          ? "merge-conflict"
          : status === "candidate-dirty"
            ? "checkout-cleanliness"
            : status === "candidate-base-mismatch"
              ? "base-validation"
              : status === "candidate-target-missing"
                ? "target-object-check"
                : status === "candidate-busy"
                  ? "candidate-state"
                  : "candidate-prepare"),
    exitCode: extras.exitCode ?? null,
    baseSha,
    target: { tag, commit: targetSha },
    branch,
    retryAction,
    ...extras,
  };
}

export function prepareCandidate(input: {
  readonly checkout: string;
  readonly baseSha: string;
  readonly targetTag: string;
  readonly targetSha: string;
}): PrepareReport {
  const baseSha = asSha(input.baseSha) ?? "";
  const targetSha = asSha(input.targetSha) ?? "";
  const branch = expectedCandidateBranch(input.targetTag, targetSha || "00000000");
  const checkout = resolve(input.checkout);
  const invalidReport = makePrepareReport(
    "candidate-base-mismatch",
    baseSha,
    input.targetTag,
    targetSha,
    branch,
    "provide-a-valid-clean-candidate-checkout-at-the-fixed-base",
    { stage: "input-validation" },
  );

  if (!baseSha || !targetSha || !input.targetTag) return invalidReport;

  const topLevel = runGit(checkout, ["rev-parse", "--show-toplevel"]);
  if (!topLevel.ok) {
    return makePrepareReport(
      "candidate-base-mismatch",
      baseSha,
      input.targetTag,
      targetSha,
      branch,
      "provide-a-valid-clean-candidate-checkout-at-the-fixed-base",
      { stage: "checkout-resolution", exitCode: topLevel.exitCode },
    );
  }
  const headResult = runGit(checkout, ["rev-parse", "--verify", "HEAD"]);
  if (!headResult.ok) {
    return makePrepareReport(
      "candidate-base-mismatch",
      baseSha,
      input.targetTag,
      targetSha,
      branch,
      "provide-a-valid-clean-candidate-checkout-at-the-fixed-base",
      { stage: "head-resolution", exitCode: headResult.exitCode },
    );
  }
  const headSha = headResult.stdout.trim().toLowerCase();
  const tagCheck = runGit(checkout, ["check-ref-format", `refs/tags/${input.targetTag}`]);
  if (!tagCheck.ok) {
    return makePrepareReport(
      "candidate-base-mismatch",
      baseSha,
      input.targetTag,
      targetSha,
      branch,
      "provide-a-valid-release-tag-and-clean-candidate-checkout",
      { stage: "target-tag-validation", exitCode: tagCheck.exitCode },
    );
  }
  const currentBranchResult = runGit(checkout, ["symbolic-ref", "--short", "-q", "HEAD"]);
  const currentBranch = currentBranchResult.ok ? currentBranchResult.stdout.trim() : null;
  if (!currentBranchResult.ok && currentBranchResult.exitCode !== 1) {
    return makePrepareReport(
      "prepare-failed",
      baseSha,
      input.targetTag,
      targetSha,
      branch,
      "inspect-candidate-branch-state-and-retry",
      { stage: "branch-inspection", exitCode: currentBranchResult.exitCode },
    );
  }

  const mergeHead = getMergeHead(checkout);
  if (mergeHead !== null) {
    if (mergeHead !== targetSha || headSha !== baseSha || currentBranch !== branch) {
      return makePrepareReport(
        "candidate-busy",
        baseSha,
        input.targetTag,
        targetSha,
        branch,
        "finish-or-abort-the-existing-merge-manually-before-retrying",
        { stage: "existing-merge-validation", conflictFiles: getConflictFiles(checkout) },
      );
    }
    return makePrepareReport(
      "candidate-conflict",
      baseSha,
      input.targetTag,
      targetSha,
      branch,
      "resolve-and-commit-the-existing-merge-manually-then-rerun-prepare",
      { stage: "existing-merge", conflictFiles: getConflictFiles(checkout) },
    );
  }

  const status = runGit(checkout, ["status", "--porcelain=v1", "--untracked-files=all"]);
  if (!status.ok) {
    return makePrepareReport(
      "prepare-failed",
      baseSha,
      input.targetTag,
      targetSha,
      branch,
      "inspect-candidate-checkout-state-and-retry",
      { stage: "checkout-status", exitCode: status.exitCode },
    );
  }
  if (status.stdout.length > 0) {
    return makePrepareReport(
      "candidate-dirty",
      baseSha,
      input.targetTag,
      targetSha,
      branch,
      "commit-or-remove-candidate-changes-and-rerun-prepare",
    );
  }

  const existingMerge = findExistingMerge(checkout, baseSha, targetSha);
  if (existingMerge !== null) {
    if (headSha !== existingMerge) {
      return makePrepareReport(
        "candidate-busy",
        baseSha,
        input.targetTag,
        targetSha,
        branch,
        "candidate-head-advanced-after-merge-create-a-new-candidate-from-current-main",
        { mergeCommitSha: existingMerge },
      );
    }
    if (currentBranch !== branch) {
      return makePrepareReport(
        "candidate-busy",
        baseSha,
        input.targetTag,
        targetSha,
        branch,
        "switch-to-the-expected-candidate-branch-without-resetting-its-commit",
        { mergeCommitSha: existingMerge },
      );
    }
    return makePrepareReport(
      "candidate-ready",
      baseSha,
      input.targetTag,
      targetSha,
      branch,
      "reuse-existing-candidate-and-run-next-verification-step",
      { mergeCommitSha: existingMerge },
    );
  }

  const targetExists = runGit(checkout, ["cat-file", "-e", `${targetSha}^{commit}`]);
  if (!targetExists.ok) {
    return makePrepareReport(
      "candidate-target-missing",
      baseSha,
      input.targetTag,
      targetSha,
      branch,
      "fetch-the-exact-locked-target-commit-into-the-candidate-checkout-then-retry",
      { stage: "target-object-check", exitCode: targetExists.exitCode },
    );
  }

  if (headSha !== baseSha) {
    return makePrepareReport(
      "candidate-base-mismatch",
      baseSha,
      input.targetTag,
      targetSha,
      branch,
      "recreate-or-select-a-clean-candidate-checkout-at-the-fixed-base",
    );
  }

  if (currentBranch === "main" || currentBranch === "master") {
    return makePrepareReport(
      "candidate-busy",
      baseSha,
      input.targetTag,
      targetSha,
      branch,
      "use-a-dedicated-candidate-checkout-not-the-main-branch",
    );
  }
  if (currentBranch !== null && currentBranch !== branch) {
    return makePrepareReport(
      "candidate-busy",
      baseSha,
      input.targetTag,
      targetSha,
      branch,
      "switch-to-the-expected-candidate-branch-or-use-a-detached-checkout-at-base",
    );
  }

  if (currentBranch === null) {
    const branches = runGit(checkout, [
      "branch",
      "--list",
      "--format=%(refname:short) %(objectname)",
      branch,
    ]);
    if (!branches.ok) {
      return makePrepareReport(
        "prepare-failed",
        baseSha,
        input.targetTag,
        targetSha,
        branch,
        "inspect-candidate-branch-state-and-retry",
        { stage: "candidate-branch-list", exitCode: branches.exitCode },
      );
    }
    const existingLine = branches.stdout.trim();
    if (existingLine) {
      const existingHead = existingLine.split(/\s+/).at(-1)?.toLowerCase();
      if (existingHead !== baseSha) {
        return makePrepareReport(
          "candidate-busy",
          baseSha,
          input.targetTag,
          targetSha,
          branch,
          "review-existing-candidate-branch-without-resetting-it",
        );
      }
      const switched = runGit(checkout, ["switch", branch]);
      if (!switched.ok) {
        return makePrepareReport(
          "prepare-failed",
          baseSha,
          input.targetTag,
          targetSha,
          branch,
          "inspect-candidate-branch-state-and-retry",
          { stage: "candidate-branch-switch", exitCode: switched.exitCode },
        );
      }
    } else {
      const created = runGit(checkout, ["switch", "-c", branch, baseSha]);
      if (!created.ok) {
        return makePrepareReport(
          "prepare-failed",
          baseSha,
          input.targetTag,
          targetSha,
          branch,
          "inspect-candidate-branch-state-and-retry",
          { stage: "candidate-branch-create", exitCode: created.exitCode },
        );
      }
    }
  }

  const merge = runGit(checkout, ["merge", "--no-ff", "--no-commit", targetSha], MAX_GIT_FETCH_MS);
  if (!merge.ok) {
    const mergeInProgress = getMergeHead(checkout);
    if (mergeInProgress !== null) {
      return makePrepareReport(
        "candidate-conflict",
        baseSha,
        input.targetTag,
        targetSha,
        branch,
        "resolve-and-commit-the-existing-merge-manually-then-rerun-prepare",
        { stage: "git-merge", exitCode: merge.exitCode, conflictFiles: getConflictFiles(checkout) },
      );
    }
    return makePrepareReport(
      "prepare-failed",
      baseSha,
      input.targetTag,
      targetSha,
      branch,
      "inspect-git-state-and-rerun-prepare-with-the-same-fixed-shas",
      { stage: "git-merge", exitCode: merge.exitCode },
    );
  }

  const commit = runGit(checkout, [
    "commit",
    "--no-edit",
    "-m",
    `Merge ${input.targetTag} (${shortSha(targetSha)}) into workbench candidate`,
  ]);
  if (!commit.ok) {
    return makePrepareReport(
      "candidate-conflict",
      baseSha,
      input.targetTag,
      targetSha,
      branch,
      "complete-the-existing-merge-commit-manually-then-rerun-prepare",
      {
        stage: "merge-commit",
        exitCode: commit.exitCode,
        conflictFiles: getConflictFiles(checkout),
      },
    );
  }

  const mergeCommit = runGit(checkout, ["rev-parse", "--verify", "HEAD"]);
  return mergeCommit.ok
    ? makePrepareReport(
        "candidate-ready",
        baseSha,
        input.targetTag,
        targetSha,
        branch,
        "run-next-verification-step-on-this-candidate-sha",
        {
          stage: "merge-commit-verification",
          exitCode: null,
          mergeCommitSha: mergeCommit.stdout.trim().toLowerCase(),
        },
      )
    : makePrepareReport(
        "prepare-failed",
        baseSha,
        input.targetTag,
        targetSha,
        branch,
        "inspect-git-state-and-rerun-prepare-with-the-same-fixed-shas",
        { stage: "merge-commit-verification", exitCode: mergeCommit.exitCode },
      );
}

export function resolveCandidateCheckout(rawPath: string, cwd = process.cwd()): string {
  return resolve(cwd, rawPath);
}
