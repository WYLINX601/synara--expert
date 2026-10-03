import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const SHA_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const CANDIDATE_METADATA = "workbench/sync-candidate.json";
const OFFICIAL_REPOSITORY = "https://github.com/Emanuele-web04/synara.git";
const CANDIDATE_PREFIX = "refs/heads/codex/sync-";

export function sanitizeBranchFragment(raw) {
  const normalized = raw
    .trim()
    .toLowerCase()
    .replace(/['"`]/g, "")
    .replace(/^[./\s_-]+|[./\s_-]+$/g, "");
  const fragment = normalized
    .replace(/[^a-z0-9/_-]+/g, "-")
    .replace(/\/+/g, "/")
    .replace(/-+/g, "-")
    .replace(/^[./_-]+|[./_-]+$/g, "")
    .slice(0, 64)
    .replace(/[./_-]+$/g, "");
  return fragment || "update";
}

export function expectedCandidateBranch(tag, targetSha) {
  if (!isSha(targetSha) || typeof tag !== "string" || tag.length === 0) return null;
  return `codex/sync-${sanitizeBranchFragment(tag)}-${targetSha.slice(0, 8).toLowerCase()}`;
}

export function parseCandidateMetadata(value, expectedBranch) {
  let metadata;
  try {
    metadata = typeof value === "string" ? JSON.parse(value) : value;
  } catch {
    return { ok: false, reason: "candidate-metadata-invalid-json" };
  }
  if (
    !isRecord(metadata) ||
    !hasExactKeys(metadata, ["formatVersion", "baseSha", "target", "branch"])
  ) {
    return { ok: false, reason: "candidate-metadata-schema-mismatch" };
  }
  if (
    metadata.formatVersion !== 1 ||
    !isSha(metadata.baseSha) ||
    !isRecord(metadata.target) ||
    !hasExactKeys(metadata.target, ["tag", "commit"]) ||
    !isValidTag(metadata.target.tag) ||
    !isSha(metadata.target.commit) ||
    typeof metadata.branch !== "string"
  ) {
    return { ok: false, reason: "candidate-metadata-invalid-values" };
  }
  const branch = expectedCandidateBranch(metadata.target.tag, metadata.target.commit);
  if (metadata.branch !== branch || (expectedBranch !== undefined && branch !== expectedBranch)) {
    return { ok: false, reason: "candidate-metadata-branch-mismatch" };
  }
  return {
    ok: true,
    metadata: {
      formatVersion: 1,
      baseSha: metadata.baseSha,
      target: { tag: metadata.target.tag, commit: metadata.target.commit },
      branch,
    },
  };
}

export function validateCandidateRef(rawRef) {
  if (typeof rawRef !== "string" || !rawRef.startsWith(CANDIDATE_PREFIX)) return null;
  const branch = rawRef.slice("refs/heads/".length);
  const hasInvalidRefCharacter = [...branch].some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint <= 0x20 || codePoint === 0x7f || "~^:?*[]\\".includes(character);
  });
  if (
    branch.length > 240 ||
    branch.includes("..") ||
    branch.includes("//") ||
    branch.endsWith("/") ||
    branch.endsWith(".") ||
    branch.includes("@{") ||
    hasInvalidRefCharacter ||
    branch.startsWith("-")
  ) {
    return null;
  }
  return branch;
}

export function chooseCandidateTarget(checkReport, activeCandidates) {
  if (!Array.isArray(activeCandidates))
    return { status: "blocked", reason: "candidate-list-invalid" };
  if (activeCandidates.length > 1) {
    return {
      status: "blocked",
      reason: "multiple-active-candidates",
      branches: activeCandidates.map((candidate) => candidate.branch),
    };
  }
  if (activeCandidates.length === 1) {
    const candidate = activeCandidates[0];
    return {
      status: "resume",
      branch: candidate.branch,
      expectedOldSha: candidate.tipSha,
      metadata: candidate.metadata,
    };
  }
  if (checkReport?.status === "no-update") return { status: "no-update" };
  if (checkReport?.status !== "update-available") {
    return { status: "blocked", reason: "official-selection-not-available" };
  }
  const release = checkReport.release;
  if (!isRecord(release) || !isValidTag(release.tag) || !isSha(release.commit)) {
    return { status: "blocked", reason: "official-release-report-invalid" };
  }
  return {
    status: "new",
    branch: expectedCandidateBranch(release.tag, release.commit),
    expectedOldSha: null,
    metadata: {
      formatVersion: 1,
      baseSha: checkReport.mainSha,
      target: { tag: release.tag, commit: release.commit },
      branch: expectedCandidateBranch(release.tag, release.commit),
    },
  };
}

export function planCandidatePublish(input) {
  const baseSha = normalizeSha(input.baseSha);
  const mainSha = normalizeSha(input.mainSha);
  const candidateSha = normalizeSha(input.candidateSha);
  const expectedOldSha = input.expectedOldSha === null ? null : normalizeSha(input.expectedOldSha);
  const observedOldSha = input.observedOldSha === null ? null : normalizeSha(input.observedOldSha);
  if (!baseSha || !mainSha || !candidateSha) {
    return { status: "blocked", stage: "publish-input-validation", push: false };
  }
  if (baseSha !== mainSha) {
    return { status: "candidate-stale", stage: "default-branch-advanced", push: false };
  }
  if (expectedOldSha !== observedOldSha) {
    return { status: "remote-branch-advanced", stage: "candidate-ref-compare", push: false };
  }
  if (observedOldSha === candidateSha) {
    return { status: "unchanged", stage: "candidate-ref-compare", push: false };
  }
  if (observedOldSha === null) {
    return { status: "create", stage: "candidate-ref-create", push: true };
  }
  if (input.fastForward === true) {
    return { status: "advance", stage: "candidate-ref-advance", push: true };
  }
  return { status: "non-fast-forward", stage: "candidate-ref-ancestry", push: false };
}

function tokenizedGitEnvironment(environment) {
  const token = environment.GITHUB_TOKEN;
  if (typeof token !== "string" || token.length === 0) return environment;
  const existingCount = Number.parseInt(environment.GIT_CONFIG_COUNT ?? "0", 10);
  const count = Number.isSafeInteger(existingCount) && existingCount >= 0 ? existingCount : 0;
  const authorization = Buffer.from(`x-access-token:${token}`).toString("base64");
  return {
    ...environment,
    GIT_CONFIG_COUNT: String(count + 1),
    [`GIT_CONFIG_KEY_${count}`]: "http.https://github.com/.extraheader",
    [`GIT_CONFIG_VALUE_${count}`]: `AUTHORIZATION: basic ${authorization}`,
  };
}

export function publishCandidateRef(root, input) {
  const remoteName = input.remoteName ?? "origin";
  const branch = input.branch;
  const expectedBranch = expectedCandidateBranch(input.targetTag, input.targetSha);
  if (
    !isSha(input.baseSha) ||
    !isSha(input.candidateSha) ||
    !isValidTag(input.targetTag) ||
    !isSha(input.targetSha) ||
    branch !== expectedBranch ||
    validateCandidateRef(`refs/heads/${branch}`) !== branch ||
    !(input.expectedOldSha === null || isSha(input.expectedOldSha))
  ) {
    return { status: "blocked", stage: "publish-input-validation", exitCode: null, push: false };
  }
  const fullRef = `refs/heads/${branch}`;
  const remoteMainSha = currentRemoteRef(root, remoteName, input.mainRef, "publish-main-ref-check");
  if (!remoteMainSha) {
    return { status: "blocked", stage: "publish-main-ref-check", exitCode: null, push: false };
  }
  const observedOldSha = currentRemoteRef(root, remoteName, fullRef, "publish-candidate-ref-check");
  const object = gitResult(root, ["cat-file", "-e", `${input.candidateSha}^{commit}`], {
    stage: "publish-candidate-object-check",
  });
  if (!object.ok) {
    return {
      status: "blocked",
      stage: "publish-candidate-object-check",
      exitCode: object.exitCode,
      push: false,
    };
  }
  if (input.expectedOldSha !== observedOldSha) {
    return {
      status: "remote-branch-advanced",
      stage: "candidate-ref-compare",
      exitCode: null,
      retryAction: "preserve-the-newer-remote-candidate-and-review-it-before-retrying",
      remoteMainSha,
      observedOldSha,
      push: false,
    };
  }
  let fastForward = true;
  if (observedOldSha !== null) {
    const oldRef = `refs/workbench-weekly-publish/${observedOldSha}`;
    try {
      git(root, ["fetch", "--no-tags", remoteName, `${fullRef}:${oldRef}`], {
        stage: "candidate-ref-fetch",
      });
    } catch {
      return {
        status: "publish-failed",
        stage: "candidate-ref-fetch",
        exitCode: null,
        retryAction: "retain-the-candidate-artifact-and-review-the-current-remote-candidate",
        remoteMainSha,
        observedOldSha,
        push: false,
      };
    }
    const fetchedOldSha = git(root, ["rev-parse", "--verify", `${oldRef}^{commit}`], {
      stage: "candidate-ref-fetch-resolve",
    }).toLowerCase();
    if (fetchedOldSha !== observedOldSha) {
      return {
        status: "remote-branch-advanced",
        stage: "candidate-ref-fetch-race",
        exitCode: null,
        retryAction: "preserve-the-newer-remote-candidate-and-review-it-before-retrying",
        remoteMainSha,
        observedOldSha: fetchedOldSha,
        push: false,
      };
    }
    fastForward = isAncestor(root, observedOldSha, input.candidateSha);
  }
  const plan = planCandidatePublish({
    baseSha: input.baseSha,
    mainSha: remoteMainSha,
    candidateSha: input.candidateSha,
    expectedOldSha: input.expectedOldSha,
    observedOldSha,
    fastForward,
  });
  if (!plan.push) return { ...plan, remoteMainSha, observedOldSha, exitCode: null };

  const lease = `--force-with-lease=${fullRef}:${observedOldSha ?? ""}`;
  const push = gitResult(
    root,
    ["push", "--porcelain", lease, remoteName, `${input.candidateSha}:${fullRef}`],
    {
      stage: "candidate-ref-push",
      env: tokenizedGitEnvironment(input.environment ?? process.env),
      timeout: 120_000,
    },
  );
  if (!push.ok) {
    return {
      status: "publish-failed",
      stage: "candidate-ref-push",
      exitCode: push.exitCode,
      retryAction: "retain-the-candidate-artifact-and-review-remote-permissions-and-ref-state",
      remoteMainSha,
      observedOldSha,
      push: false,
    };
  }
  const publishedSha = currentRemoteRef(root, remoteName, fullRef, "publish-result-check");
  const confirmedMainSha = currentRemoteRef(
    root,
    remoteName,
    input.mainRef,
    "publish-result-main-check",
  );
  if (publishedSha !== input.candidateSha.toLowerCase()) {
    return {
      status: "remote-branch-advanced",
      stage: "publish-result-check",
      exitCode: null,
      retryAction: "preserve-the-newer-remote-candidate-and-review-it-before-retrying",
      remoteMainSha: confirmedMainSha,
      observedOldSha,
      publishedSha,
      push: false,
    };
  }
  if (confirmedMainSha !== input.baseSha.toLowerCase()) {
    return {
      status: "candidate-stale",
      stage: "default-branch-advanced-during-publish",
      exitCode: null,
      retryAction: "merge-current-default-branch-into-the-candidate-and-reverify",
      remoteMainSha: confirmedMainSha,
      observedOldSha,
      publishedSha,
      push: true,
    };
  }
  return {
    status: plan.status === "create" ? "published" : "advanced",
    stage: plan.stage,
    exitCode: 0,
    remoteMainSha,
    observedOldSha,
    publishedSha,
    push: true,
  };
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value, expected) {
  return Object.keys(value).toSorted().join("\0") === [...expected].toSorted().join("\0");
}

function isSha(value) {
  return typeof value === "string" && SHA_PATTERN.test(value);
}

function normalizeSha(value) {
  return isSha(value) ? value.toLowerCase() : null;
}

function isValidTag(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 128 &&
    /^v[0-9A-Za-z][0-9A-Za-z.+-]*$/.test(value) &&
    !value.includes("..") &&
    !value.endsWith(".")
  );
}

class StageError extends Error {
  constructor(stage, message, exitCode = null, details = {}) {
    super(message);
    this.stage = stage;
    this.exitCode = exitCode;
    this.details = details;
  }
}

function environment() {
  const workspace = resolve(process.env.GITHUB_WORKSPACE ?? process.cwd());
  const runnerTemp = resolve(process.env.RUNNER_TEMP ?? "/tmp");
  const runId = process.env.GITHUB_RUN_ID ?? "local";
  const attempt = process.env.GITHUB_RUN_ATTEMPT ?? "1";
  if (!/^[A-Za-z0-9-]+$/.test(runId) || !/^\d+$/.test(attempt)) {
    throw new StageError("environment-validation", "invalid-workflow-run-identity");
  }
  const defaultBranch = process.env.DEFAULT_BRANCH ?? "main";
  if (!/^[A-Za-z0-9._/-]+$/.test(defaultBranch) || defaultBranch.includes("..")) {
    throw new StageError("environment-validation", "invalid-default-branch");
  }
  return {
    workspace,
    runnerTemp,
    runId,
    attempt,
    artifactName: `workbench-weekly-candidate-${runId}-${attempt}`,
    artifactDir: join(runnerTemp, `workbench-weekly-candidate-${runId}-${attempt}`),
    mainRef: `refs/heads/${defaultBranch}`,
    defaultBranch,
  };
}

function run(command, args, cwd, env = process.env, timeout = 120_000) {
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: "utf8",
    timeout,
    maxBuffer: 24 * 1024 * 1024,
  });
  return {
    ok: result.status === 0,
    exitCode: typeof result.status === "number" ? result.status : null,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error,
  };
}

function git(cwd, args, options = {}) {
  const result = run("git", args, cwd, options.env ?? process.env, options.timeout ?? 120_000);
  if (!result.ok) {
    throw new StageError(options.stage ?? `git-${args[0]}`, "git-command-failed", result.exitCode, {
      reason: result.error ? "git-process-error" : "git-command-failed",
    });
  }
  return result.stdout.trim();
}

function gitResult(cwd, args, options = {}) {
  return run("git", args, cwd, options.env ?? process.env, options.timeout ?? 120_000);
}

function syncCommand(cwd, args, timeout = 15 * 60_000) {
  const result = run("bun", ["run", "workbench:sync", ...args], cwd, process.env, timeout);
  let report;
  try {
    report = JSON.parse(result.stdout);
  } catch {
    throw new StageError("sync-cli-output", "sync-cli-did-not-return-json", result.exitCode, {
      command: args[0] ?? "unknown",
    });
  }
  if (!isRecord(report) || report.command !== args[0]) {
    throw new StageError("sync-cli-output", "sync-cli-report-command-mismatch", result.exitCode, {
      command: args[0] ?? "unknown",
    });
  }
  return { report, exitCode: result.exitCode, stderr: result.stderr };
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

function writeOutput(key, value) {
  if (!process.env.GITHUB_OUTPUT) return;
  if (!/^[a-z][a-z0-9_]*$/.test(key) || /[\r\n]/.test(String(value))) {
    throw new StageError("workflow-output", "invalid-workflow-output");
  }
  appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
}

function markdownEscape(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function appendSummary(title, report) {
  if (!process.env.GITHUB_STEP_SUMMARY) return;
  const fields = [
    ["status", report.status],
    ["stage", report.stage],
    ["exitCode", report.exitCode],
    ["retryAction", report.retryAction],
    ["baseSha", report.baseSha],
    ["candidateSha", report.candidateSha],
    ["branch", report.branch],
    ["target", report.target ? `${report.target.tag} (${report.target.commit})` : null],
  ].filter(([, value]) => value !== undefined && value !== null && value !== "");
  const content = [
    `## ${title}`,
    "",
    ...fields.map(([key, value]) => `- **${key}**: ${markdownEscape(value)}`),
    "",
  ].join("\n");
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, content);
}

function writePreparationOutputs(report) {
  writeOutput("candidate_sha", report.candidateSha ?? "");
  writeOutput("candidate_branch", report.branch ?? "");
  writeOutput("base_sha", report.baseSha ?? "");
  writeOutput("target_tag", report.target?.tag ?? "");
  writeOutput("target_sha", report.target?.commit ?? "");
  writeOutput("publishable", report.publishable === true ? "true" : "false");
  writeOutput("explicit_ref", report.explicitRef === true ? "true" : "false");
  writeOutput("artifact_name", environment().artifactName);
}

function errorReport(error, command) {
  const known = error instanceof StageError;
  return {
    command,
    status: "workflow-failed",
    stage: known ? error.stage : "unexpected-error",
    exitCode: known ? error.exitCode : null,
    reason: known ? error.message : "unexpected-workflow-error",
    details: known ? error.details : {},
    retryAction:
      "inspect-the-run-artifact-and-retry-only-after-reviewing-current-main-and-candidate-ref",
  };
}

function readCandidateMetadataAt(root, sha, branch) {
  const show = gitResult(root, ["show", `${sha}:${CANDIDATE_METADATA}`], {
    stage: "candidate-metadata-read",
  });
  if (!show.ok) return { ok: false, reason: "candidate-metadata-missing" };
  return parseCandidateMetadata(show.stdout, branch);
}

function parseRemoteHeads(output) {
  const branches = [];
  for (const line of output.split("\n")) {
    const match = /^([0-9a-f]{40,64})\t(refs\/heads\/codex\/sync-.+)$/.exec(line.trim());
    if (match)
      branches.push({
        tipSha: match[1],
        fullRef: match[2],
        branch: match[2].slice("refs/heads/".length),
      });
  }
  return branches;
}

function isAncestor(root, ancestor, descendant) {
  const result = gitResult(root, ["merge-base", "--is-ancestor", ancestor, descendant], {
    stage: "candidate-ancestry",
  });
  if (result.ok) return true;
  if (result.exitCode === 1) return false;
  throw new StageError("candidate-ancestry", "git-ancestry-check-failed", result.exitCode);
}

function fetchCandidateRef(root, candidate, localRef) {
  git(root, ["check-ref-format", candidate.fullRef], { stage: "candidate-ref-validation" });
  git(root, ["fetch", "--no-tags", "origin", `${candidate.fullRef}:${localRef}`], {
    stage: "candidate-ref-fetch",
  });
  const fetched = git(root, ["rev-parse", "--verify", `${localRef}^{commit}`], {
    stage: "candidate-ref-resolve",
  }).toLowerCase();
  if (fetched !== candidate.tipSha)
    throw new StageError("candidate-ref-resolve", "candidate-ref-moved-during-fetch");
  return { ...candidate, localRef };
}

function enumerateActiveCandidates(root, mainSha) {
  const remoteOutput = git(root, ["ls-remote", "--heads", "origin"], {
    stage: "candidate-enumeration",
  });
  const remoteBranches = parseRemoteHeads(remoteOutput);
  const active = [];
  const invalid = [];
  for (const [index, remote] of remoteBranches.entries()) {
    const localRef = `refs/remotes/workbench-weekly/candidates/${index}`;
    const fetched = fetchCandidateRef(root, remote, localRef);
    if (isAncestor(root, fetched.tipSha, mainSha)) continue;
    const parsed = readCandidateMetadataAt(root, fetched.tipSha, fetched.branch);
    if (!parsed.ok) {
      invalid.push({ branch: fetched.branch, tipSha: fetched.tipSha, reason: parsed.reason });
      continue;
    }
    active.push({ ...fetched, metadata: parsed.metadata });
  }
  return { active, invalid };
}

function createWorktree(root, path, baseSha, branch, localRef) {
  if (localRef) {
    git(root, ["worktree", "add", "-b", branch, path, localRef], {
      stage: "candidate-worktree-create",
    });
  } else {
    git(root, ["worktree", "add", "-b", branch, path, baseSha], {
      stage: "candidate-worktree-create",
    });
  }
}

function removeWorktree(root, path) {
  gitResult(root, ["worktree", "remove", "--force", path], { stage: "candidate-worktree-cleanup" });
}

function conflictFiles(path) {
  const result = gitResult(path, ["diff", "--name-only", "--diff-filter=U", "-z"], {
    stage: "conflict-file-list",
  });
  return result.ok ? result.stdout.split("\0").filter(Boolean) : [];
}

function configureCandidateCommit(path) {
  git(path, ["config", "user.name", "github-actions[bot]"], { stage: "candidate-commit-identity" });
  git(path, ["config", "user.email", "41898282+github-actions[bot]@users.noreply.github.com"], {
    stage: "candidate-commit-identity",
  });
}

export function createWritableCandidateWorktree(root, path, baseSha, branch, localRef) {
  createWorktree(root, path, baseSha, branch, localRef);
  configureCandidateCommit(path);
}

function candidateMetadataText(baseSha, target, branch) {
  return `${JSON.stringify(
    {
      formatVersion: 1,
      baseSha,
      target: { tag: target.tag, commit: target.commit },
      branch,
    },
    null,
    2,
  )}\n`;
}

function commitMetadata(path, baseSha, target, branch) {
  const metadataPath = join(path, CANDIDATE_METADATA);
  const desired = candidateMetadataText(baseSha, target, branch);
  let current = null;
  try {
    current = readFileSync(metadataPath, "utf8");
  } catch {
    current = null;
  }
  if (current === desired) return { changed: false, sha: git(path, ["rev-parse", "HEAD"]) };
  writeFileSync(metadataPath, desired, { mode: 0o644 });
  configureCandidateCommit(path);
  git(path, ["add", "--", CANDIDATE_METADATA], { stage: "candidate-metadata-stage" });
  git(path, ["commit", "-m", "chore(workbench): record sync candidate metadata"], {
    stage: "candidate-metadata-commit",
  });
  return { changed: true, sha: git(path, ["rev-parse", "HEAD"]) };
}

export function makeRecoveryInstructions(branch, baseSha, target, files, hadRemoteBranch) {
  const branchText = branch ?? "codex/sync-<sanitized-tag>-<target-short-sha>";
  const recoveryTargetRef = `refs/workbench/recovery-target/${target.commit}`;
  const start = hadRemoteBranch
    ? `git fetch origin refs/heads/${branchText}:refs/remotes/origin/${branchText}\ngit switch --create ${branchText} --track refs/remotes/origin/${branchText}`
    : `git switch --create ${branchText} ${baseSha}\ngit fetch --no-tags ${OFFICIAL_REPOSITORY} refs/tags/${target.tag}:${recoveryTargetRef}\ntest "$(git rev-parse ${recoveryTargetRef}^{commit})" = ${target.commit}`;
  const mergeSha = hadRemoteBranch ? baseSha : target.commit;
  return [
    "The workflow left the remote candidate tip unchanged. Start from the exact base and target recorded in the run artifact; merge normally, resolve the listed files, and commit the merge. This is a recovery procedure only; no merge or repair is complete until you resolve and commit it.",
    start,
    `git merge --no-ff ${mergeSha}`,
    "# Resolve each listed file, then commit the merge before updating candidate metadata.",
    `# Set workbench/sync-candidate.json baseSha to ${baseSha}; keep the target and branch fields unchanged, then commit that metadata edit.`,
    `git push origin HEAD:refs/heads/${branchText}`,
    "# Re-run workflow_dispatch with that exact full candidate ref after the manual repair is pushed.",
    `Conflict files: ${JSON.stringify(files)}`,
  ].join("\n");
}

function assertWorkflowContext(root, env) {
  const githubRef = process.env.GITHUB_REF;
  const sha = normalizeSha(process.env.GITHUB_SHA);
  const expectedRef = `refs/heads/${env.defaultBranch}`;
  if (!sha || githubRef !== expectedRef) {
    throw new StageError("default-branch-guard", "workflow-must-run-on-default-branch", null, {
      expectedRef,
      observedRef: githubRef ?? "missing",
    });
  }
  const head = git(root, ["rev-parse", "--verify", "HEAD"], {
    stage: "checkout-validation",
  }).toLowerCase();
  if (head !== sha) {
    throw new StageError("checkout-validation", "checkout-is-not-fixed-workflow-sha");
  }
  const status = git(root, ["status", "--porcelain=v1", "--untracked-files=all"], {
    stage: "checkout-cleanliness",
  });
  if (status.length > 0)
    throw new StageError("checkout-cleanliness", "trusted-main-checkout-is-dirty");
  const main = gitResult(root, ["show-ref", "--verify", "--quiet", env.mainRef], {
    stage: "main-ref-validation",
  });
  if (!main.ok) git(root, ["update-ref", env.mainRef, sha, ""], { stage: "main-ref-create" });
  const mainSha = git(root, ["rev-parse", "--verify", env.mainRef], {
    stage: "main-ref-resolution",
  }).toLowerCase();
  if (mainSha !== sha)
    throw new StageError("main-ref-validation", "default-main-ref-does-not-match-fixed-checkout");
  return sha;
}

function captureCandidateBundle(root, artifactDir, candidateSha, baseSha, targetSha) {
  const bundlePath = join(artifactDir, "candidate.bundle");
  const bundleRef = `refs/workbench-weekly-artifact/${environment().runId}-${environment().attempt}/candidate`;
  const refs = { candidate: candidateSha, base: baseSha, target: targetSha };
  const createdRefs = [];
  for (const [name, sha] of Object.entries(refs)) {
    if (!isSha(sha)) continue;
    const ref = `refs/workbench-weekly-artifact/${environment().runId}-${environment().attempt}/${name}`;
    const result = gitResult(root, ["update-ref", ref, sha, ""], { stage: "bundle-ref-create" });
    if (!result.ok)
      throw new StageError("bundle-ref-create", "could-not-create-bundle-ref", result.exitCode);
    createdRefs.push(ref);
  }
  try {
    git(root, ["bundle", "create", bundlePath, ...createdRefs], { stage: "bundle-create" });
    git(root, ["bundle", "verify", bundlePath], { stage: "bundle-verify" });
  } finally {
    for (const ref of createdRefs)
      gitResult(root, ["update-ref", "-d", ref], { stage: "bundle-ref-cleanup" });
  }
  return { bundlePath, bundleRef };
}

function writeBaseOutputs(report) {
  writePreparationOutputs(report);
  writeOutput("status", report.status ?? "unknown");
  writeOutput("verification_bound", report.bindPassed === true ? "true" : "false");
}

export function fetchOfficialTagCommit(root, target, repository = OFFICIAL_REPOSITORY) {
  const tagRef = `refs/tags/${target.tag}`;
  const format = gitResult(root, ["check-ref-format", tagRef], {
    stage: "official-tag-validation",
  });
  if (!format.ok)
    throw new StageError(
      "official-tag-validation",
      "candidate-target-tag-invalid",
      format.exitCode,
    );
  const suffix = createHash("sha256").update(target.tag).digest("hex").slice(0, 16);
  const destination = `refs/workbench-weekly/official/${suffix}`;
  const shallow =
    git(root, ["rev-parse", "--is-shallow-repository"], {
      stage: "official-target-shallow-check",
    }) === "true";
  const args = [
    "fetch",
    ...(shallow ? ["--depth=1"] : []),
    "--no-tags",
    repository,
    `${tagRef}:${destination}`,
  ];
  const fetched = run("git", args, root);
  if (!fetched.ok)
    throw new StageError(
      "official-target-fetch",
      "candidate-target-fetch-failed",
      fetched.exitCode,
    );
  const resolved = git(root, ["rev-parse", "--verify", `${destination}^{commit}`], {
    stage: "official-target-resolve",
  }).toLowerCase();
  if (resolved !== target.commit.toLowerCase()) {
    throw new StageError("official-target-identity", "candidate-target-tag-moved", null, {
      expectedTargetSha: target.commit,
      observedTargetSha: resolved,
    });
  }
  return resolved;
}

function officialTagCommit(root, target) {
  return fetchOfficialTagCommit(root, target);
}

function currentRemoteRef(root, remoteName, fullRef, stage) {
  const output = git(root, ["ls-remote", "--heads", remoteName, fullRef], { stage });
  const line = output.split("\n").find((entry) => entry.endsWith(`\t${fullRef}`));
  const sha = line?.split("\t", 1)[0]?.toLowerCase();
  if (!sha) return null;
  if (!isSha(sha)) throw new StageError(stage, "remote-ref-returned-invalid-sha");
  return sha;
}

function currentRemoteMain(root, mainRef) {
  const sha = currentRemoteRef(root, "origin", mainRef, "default-branch-recheck");
  if (!sha)
    throw new StageError("default-branch-recheck", "could-not-resolve-current-default-branch");
  return sha;
}

function getGitHead(path) {
  return git(path, ["rev-parse", "--verify", "HEAD"], {
    stage: "candidate-head-resolution",
  }).toLowerCase();
}

function candidateStatus(path) {
  return git(path, ["status", "--porcelain=v1", "--untracked-files=all"], {
    stage: "candidate-cleanliness",
  });
}

function createCandidateBundle(root, artifactDir, candidateSha, baseSha, targetSha) {
  return captureCandidateBundle(root, artifactDir, candidateSha, baseSha, targetSha);
}

function runBind(root, checkout, baseSha, target, candidateSha, mainRef) {
  return syncCommand(root, [
    "bind",
    "--checkout",
    checkout,
    "--base",
    baseSha,
    "--target-tag",
    target.tag,
    "--target-sha",
    target.commit,
    "--candidate-sha",
    candidateSha,
    "--main-ref",
    mainRef,
  ]);
}

function writePrepareReport(env, report, exitCode) {
  mkdirSync(env.artifactDir, { recursive: true });
  report.artifactName = env.artifactName;
  writeJson(join(env.artifactDir, "candidate-report.json"), report);
  writeBaseOutputs(report);
  appendSummary("Workbench weekly sync · candidate", report);
  return exitCode;
}

function runCheck(root, mainRef) {
  const result = syncCommand(root, ["check", "--main-ref", mainRef]);
  return { report: result.report, exitCode: result.exitCode };
}

function checkReportIsUsable(checkReport) {
  return checkReport?.status === "update-available" || checkReport?.status === "no-update";
}

function resolveExpectedBranch(target) {
  const branch = expectedCandidateBranch(target.tag, target.commit);
  if (!branch || validateCandidateRef(`refs/heads/${branch}`) !== branch) {
    throw new StageError("candidate-branch-validation", "candidate-branch-cannot-be-safely-formed");
  }
  return branch;
}

function refAlreadyExists(root, branch) {
  const output = git(root, ["ls-remote", "--heads", "origin", `refs/heads/${branch}`], {
    stage: "candidate-ref-collision-check",
  });
  return output.split("\n").some((line) => line.endsWith(`\trefs/heads/${branch}`));
}

function makeBlockedReport(env, status, stage, retryAction, fields = {}) {
  return {
    command: "weekly-prepare",
    status,
    stage,
    exitCode: fields.exitCode ?? null,
    retryAction,
    mainRef: env.mainRef,
    ...fields,
    publishable: false,
    bindPassed: false,
  };
}

function resolveExplicitCandidate(root, env, rawRef, mainSha) {
  const branch = validateCandidateRef(rawRef);
  if (!branch) {
    return makeBlockedReport(
      env,
      "candidate-ref-invalid",
      "explicit-candidate-ref-validation",
      "provide-a-full-codex-sync-branch-ref",
      {
        explicitRef: true,
      },
    );
  }
  const remoteOutput = git(root, ["ls-remote", "--heads", "origin", rawRef], {
    stage: "explicit-candidate-ref-resolution",
  });
  const line = remoteOutput.split("\n").find((entry) => entry.endsWith(`\t${rawRef}`));
  const tipSha = line?.split("\t", 1)[0]?.toLowerCase();
  if (!tipSha || !isSha(tipSha)) {
    return makeBlockedReport(
      env,
      "candidate-ref-missing",
      "explicit-candidate-ref-resolution",
      "verify-the-exact-candidate-ref-and-retry",
      {
        branch,
        explicitRef: true,
      },
    );
  }
  const fetched = fetchCandidateRef(
    root,
    { branch, fullRef: rawRef, tipSha },
    `refs/remotes/workbench-weekly/explicit/${env.runId}`,
  );
  const parsed = readCandidateMetadataAt(root, fetched.tipSha, branch);
  if (!parsed.ok) {
    return makeBlockedReport(
      env,
      "candidate-metadata-invalid",
      "explicit-candidate-metadata",
      "repair-the-branch-metadata-after-review",
      {
        branch,
        candidateSha: tipSha,
        reason: parsed.reason,
        explicitRef: true,
      },
    );
  }
  const target = parsed.metadata.target;
  if (officialTagCommit(root, target) !== target.commit.toLowerCase()) {
    return makeBlockedReport(
      env,
      "candidate-target-mismatch",
      "explicit-candidate-target-validation",
      "review-the-official-tag-and-candidate-metadata",
      {
        branch,
        candidateSha: tipSha,
        baseSha: parsed.metadata.baseSha,
        mainSha,
        target,
        explicitRef: true,
      },
    );
  }
  const path = join(env.artifactDir, "candidate-checkout");
  mkdirSync(env.artifactDir, { recursive: true });
  createWorktree(root, path, parsed.metadata.baseSha, branch, fetched.localRef);
  try {
    const bind = runBind(root, path, mainSha, target, tipSha, env.mainRef);
    const bindPassed = bind.exitCode === 0;
    const bundle = createCandidateBundle(
      root,
      env.artifactDir,
      tipSha,
      parsed.metadata.baseSha,
      target.commit,
    );
    return {
      command: "weekly-prepare",
      status: bindPassed ? "candidate-selected" : "candidate-stale",
      stage: bindPassed ? "candidate-bound" : (bind.report.stage ?? "candidate-bind"),
      exitCode: bind.exitCode,
      retryAction: bindPassed
        ? "review-the-verification-job-for-this-exact-sha"
        : (bind.report.retryAction ?? "merge-current-main-and-rebind-before-verifying"),
      mainRef: env.mainRef,
      mainSha,
      baseSha: parsed.metadata.baseSha,
      target,
      branch,
      candidateSha: tipSha,
      expectedOldSha: tipSha,
      bindPassed,
      bind: bind.report,
      bundleRef: bundle.bundleRef,
      bundleFile: "candidate.bundle",
      explicitRef: true,
      publishable: false,
    };
  } finally {
    removeWorktree(root, path);
  }
}

function prepareNewCandidate(root, env, mainSha, target) {
  const branch = resolveExpectedBranch(target);
  if (refAlreadyExists(root, branch)) {
    return makeBlockedReport(
      env,
      "candidate-ref-collision",
      "candidate-ref-collision-check",
      "inspect-the-existing-ref-without-resetting-or-overwriting-it",
      {
        mainSha,
        baseSha: mainSha,
        target,
        branch,
      },
    );
  }
  const path = join(env.artifactDir, "candidate-checkout");
  mkdirSync(env.artifactDir, { recursive: true });
  createWritableCandidateWorktree(root, path, mainSha, branch);
  try {
    const prepared = syncCommand(root, [
      "prepare",
      "--checkout",
      path,
      "--base",
      mainSha,
      "--target-tag",
      target.tag,
      "--target-sha",
      target.commit,
      "--main-ref",
      env.mainRef,
    ]);
    if (prepared.exitCode !== 0 || prepared.report.status !== "candidate-ready") {
      const files = Array.isArray(prepared.report.conflictFiles)
        ? prepared.report.conflictFiles
        : [];
      const head = (() => {
        const found = gitResult(path, ["rev-parse", "--verify", "HEAD"], {
          stage: "candidate-head-resolution",
        });
        return found.ok ? found.stdout.trim().toLowerCase() : null;
      })();
      const bundle = createCandidateBundle(root, env.artifactDir, null, mainSha, target.commit);
      const conflict = prepared.report.status === "candidate-conflict" || files.length > 0;
      return {
        command: "weekly-prepare",
        status: conflict ? "candidate-conflict" : "candidate-prepare-failed",
        stage: prepared.report.stage ?? "candidate-prepare",
        exitCode: prepared.exitCode,
        retryAction: conflict
          ? "resolve-the-listed-conflicts-manually-then-bind-and-reverify"
          : (prepared.report.retryAction ?? "inspect-the-run-artifact-before-retrying"),
        mainRef: env.mainRef,
        mainSha,
        baseSha: mainSha,
        target,
        branch,
        attemptedHeadSha: head,
        conflictFiles: files,
        recoveryInstructions: makeRecoveryInstructions(branch, mainSha, target, files, false),
        prepare: prepared.report,
        bundleRef: bundle.bundleRef,
        bundleFile: "candidate.bundle",
        publishable: false,
        bindPassed: false,
      };
    }
    const mergeSha = normalizeSha(prepared.report.candidateSha ?? prepared.report.mergeCommitSha);
    if (!mergeSha || getGitHead(path) !== mergeSha) {
      throw new StageError(
        "candidate-prepare-validation",
        "prepare-sha-does-not-match-worktree-head",
      );
    }
    const branchNow = git(path, ["symbolic-ref", "--short", "-q", "HEAD"], {
      stage: "candidate-branch-validation",
    });
    if (branchNow !== branch)
      throw new StageError("candidate-branch-validation", "prepare-selected-unexpected-branch");
    if (candidateStatus(path).length > 0)
      throw new StageError("candidate-prepare-cleanliness", "prepare-left-candidate-dirty");
    const metadata = commitMetadata(path, mainSha, target, branch);
    const candidateSha = metadata.sha.toLowerCase();
    const bind = runBind(root, path, mainSha, target, candidateSha, env.mainRef);
    const bindPassed = bind.exitCode === 0;
    const status = bindPassed ? "candidate-prepared" : "candidate-bind-failed";
    const candidate = {
      metadata: { baseSha: mainSha, target },
      mainSha,
      branch,
      expectedOldSha: null,
      candidateSha,
    };
    if (bindPassed && candidateStatus(path).length > 0)
      throw new StageError("candidate-bind-cleanliness", "bind-left-candidate-dirty");
    const bundle = createCandidateBundle(
      root,
      env.artifactDir,
      candidateSha,
      mainSha,
      target.commit,
    );
    const remoteMain = currentRemoteMain(root, env.mainRef);
    const mainStillCurrent = remoteMain === mainSha;
    return {
      command: "weekly-prepare",
      status: mainStillCurrent ? status : "candidate-stale",
      stage: mainStillCurrent
        ? bindPassed
          ? "candidate-bound"
          : (bind.report.stage ?? "candidate-bind")
        : "default-branch-advanced",
      exitCode: mainStillCurrent ? bind.exitCode : null,
      retryAction: mainStillCurrent
        ? bindPassed
          ? "review-the-verification-job-for-this-exact-sha"
          : (bind.report.retryAction ?? "inspect-the-candidate-bind-report")
        : "merge-the-current-default-branch-into-this-candidate-and-reverify",
      mainRef: env.mainRef,
      mainSha,
      baseSha: mainSha,
      target,
      branch,
      candidateSha,
      expectedOldSha: null,
      bindPassed,
      bind: bind.report,
      prepare: prepared.report,
      metadataCommitCreated: metadata.changed,
      bundleRef: bundle.bundleRef,
      bundleFile: "candidate.bundle",
      publishable: bindPassed && mainStillCurrent,
      explicitRef: false,
      ...(!mainStillCurrent ? { observedMainSha: remoteMain } : {}),
      candidate,
    };
  } finally {
    removeWorktree(root, path);
  }
}

function resumeCandidate(root, env, mainSha, candidate) {
  const { branch, tipSha: expectedOldSha, metadata, localRef } = candidate;
  if (!isAncestor(root, metadata.baseSha, mainSha)) {
    const bundle = createCandidateBundle(
      root,
      env.artifactDir,
      expectedOldSha,
      metadata.baseSha,
      metadata.target.commit,
    );
    return makeBlockedReport(
      env,
      "candidate-base-diverged",
      "candidate-base-ancestry",
      "review-main-history-and-candidate-branch-before-recovery",
      {
        mainSha,
        baseSha: metadata.baseSha,
        target: metadata.target,
        branch,
        remoteCandidateSha: expectedOldSha,
        expectedOldSha,
        bundleRef: bundle.bundleRef,
        bundleFile: "candidate.bundle",
      },
    );
  }
  officialTagCommit(root, metadata.target);
  const path = join(env.artifactDir, "candidate-checkout");
  mkdirSync(env.artifactDir, { recursive: true });
  createWritableCandidateWorktree(root, path, metadata.baseSha, branch, localRef);
  try {
    const remoteHead = getGitHead(path);
    if (remoteHead !== expectedOldSha)
      throw new StageError("candidate-ref-validation", "candidate-tip-changed-after-enumeration");
    if (!isAncestor(root, mainSha, remoteHead)) {
      const merge = gitResult(path, ["merge", "--no-ff", "--no-edit", mainSha], {
        stage: "merge-current-main",
      });
      if (!merge.ok) {
        const files = conflictFiles(path);
        const bundle = createCandidateBundle(
          root,
          env.artifactDir,
          expectedOldSha,
          mainSha,
          metadata.target.commit,
        );
        const recoveryInstructions = makeRecoveryInstructions(
          branch,
          mainSha,
          metadata.target,
          files,
          true,
        );
        return {
          command: "weekly-prepare",
          status: files.length > 0 ? "candidate-conflict" : "candidate-main-merge-failed",
          stage: "merge-current-main",
          exitCode: merge.exitCode,
          retryAction:
            files.length > 0
              ? "resolve-the-listed-files-manually; remote-candidate-was-left-unchanged"
              : "inspect-the-candidate-bundle-and-git-error-before-retrying",
          mainRef: env.mainRef,
          mainSha,
          baseSha: metadata.baseSha,
          target: metadata.target,
          branch,
          remoteCandidateSha: expectedOldSha,
          expectedOldSha,
          conflictFiles: files,
          recoveryInstructions,
          bundleRef: bundle.bundleRef,
          bundleFile: "candidate.bundle",
          publishable: false,
          bindPassed: false,
        };
      }
    }
    const updated = commitMetadata(path, mainSha, metadata.target, branch);
    const candidateSha = updated.sha.toLowerCase();
    const bind = runBind(root, path, mainSha, metadata.target, candidateSha, env.mainRef);
    const bindPassed = bind.exitCode === 0;
    if (bindPassed && candidateStatus(path).length > 0)
      throw new StageError("candidate-bind-cleanliness", "bind-left-candidate-dirty");
    const bundle = createCandidateBundle(
      root,
      env.artifactDir,
      candidateSha,
      mainSha,
      metadata.target.commit,
    );
    const remoteMain = currentRemoteMain(root, env.mainRef);
    const mainStillCurrent = remoteMain === mainSha;
    return {
      command: "weekly-prepare",
      status: !mainStillCurrent
        ? "candidate-stale"
        : bindPassed
          ? "candidate-prepared"
          : "candidate-bind-failed",
      stage: !mainStillCurrent
        ? "default-branch-advanced"
        : (bind.report.stage ?? (bindPassed ? "candidate-bound" : "candidate-bind")),
      exitCode: !mainStillCurrent ? null : bind.exitCode,
      retryAction: !mainStillCurrent
        ? "merge-the-current-default-branch-into-this-candidate-and-reverify"
        : (bind.report.retryAction ?? "inspect-the-candidate-bind-report"),
      mainRef: env.mainRef,
      mainSha,
      baseSha: mainSha,
      target: metadata.target,
      branch,
      candidateSha,
      expectedOldSha,
      remoteCandidateSha: expectedOldSha,
      bindPassed,
      bind: bind.report,
      metadataCommitCreated: updated.changed,
      bundleRef: bundle.bundleRef,
      bundleFile: "candidate.bundle",
      publishable: bindPassed && mainStillCurrent,
      explicitRef: false,
      ...(!mainStillCurrent ? { observedMainSha: remoteMain } : {}),
    };
  } finally {
    removeWorktree(root, path);
  }
}

function runPrepare() {
  const env = environment();
  const root = env.workspace;
  mkdirSync(env.artifactDir, { recursive: true });
  const mainSha = assertWorkflowContext(root, env);
  const observedMainSha = currentRemoteMain(root, env.mainRef);
  if (observedMainSha !== mainSha) {
    return writePrepareReport(
      env,
      makeBlockedReport(
        env,
        "candidate-stale",
        "default-branch-advanced-before-prepare",
        "rerun-from-the-current-default-branch-snapshot-after-reviewing-this-run-artifact",
        { baseSha: mainSha, mainSha, observedMainSha },
      ),
      1,
    );
  }
  const rawCandidateRef = (process.env.CANDIDATE_REF ?? "").trim();
  if (rawCandidateRef.length > 256)
    throw new StageError("explicit-candidate-ref-validation", "candidate-ref-input-too-long");
  if (rawCandidateRef) {
    const report = resolveExplicitCandidate(root, env, rawCandidateRef, mainSha);
    return writePrepareReport(env, report, report.bindPassed ? 0 : 1);
  }

  const checked = runCheck(root, env.mainRef);
  const listed = enumerateActiveCandidates(root, mainSha);
  if (listed.invalid.length > 0) {
    const report = makeBlockedReport(
      env,
      "unrecognized-active-sync-branch",
      "candidate-metadata-enumeration",
      "review-or-repair-active-codex-sync-branches-before-creating-another",
      {
        mainSha,
        invalidBranches: listed.invalid,
        check: checked.report,
        checkExitCode: checked.exitCode,
      },
    );
    return writePrepareReport(env, report, 1);
  }
  if (!checkReportIsUsable(checked.report) && listed.active.length === 0) {
    const report = makeBlockedReport(
      env,
      checked.report.status ?? "selection-blocked",
      checked.report.stage ?? "official-selection",
      checked.report.retryAction ?? "review-the-sync-check-report-before-retrying",
      {
        mainSha,
        check: checked.report,
        checkExitCode: checked.exitCode,
      },
    );
    return writePrepareReport(env, report, 1);
  }
  const selection = chooseCandidateTarget(checked.report, listed.active);
  if (selection.status === "blocked") {
    const report = makeBlockedReport(
      env,
      selection.reason,
      "candidate-selection",
      "review-the-active-candidate-branches-before-retrying",
      {
        mainSha,
        branches: selection.branches ?? [],
        check: checked.report,
        checkExitCode: checked.exitCode,
      },
    );
    return writePrepareReport(env, report, 1);
  }
  if (selection.status === "no-update") {
    const report = {
      command: "weekly-prepare",
      status: "no-update",
      stage: "official-selection",
      exitCode: checked.exitCode,
      retryAction: checked.report.retryAction ?? "check-after-next-stable-release",
      mainRef: env.mainRef,
      mainSha,
      check: checked.report,
      publishable: false,
      bindPassed: false,
      explicitRef: false,
    };
    return writePrepareReport(env, report, 0);
  }
  const report =
    selection.status === "new"
      ? prepareNewCandidate(root, env, mainSha, selection.metadata.target)
      : resumeCandidate(root, env, mainSha, listed.active[0]);
  report.check = checked.report;
  report.checkExitCode = checked.exitCode;
  const code = report.publishable ? 0 : report.status === "candidate-conflict" ? 1 : 1;
  return writePrepareReport(env, report, code);
}

function readJson(path, stage) {
  let value;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new StageError(stage, "workflow-artifact-json-invalid");
  }
  if (!isRecord(value)) throw new StageError(stage, "workflow-artifact-json-invalid");
  return value;
}

function readPrepareArtifact(env) {
  return readJson(join(env.artifactDir, "candidate-report.json"), "candidate-artifact-read");
}

function candidateReportHasCommit(report) {
  return (
    isSha(report.candidateSha) &&
    isValidTag(report.target?.tag) &&
    isSha(report.target?.commit) &&
    typeof report.branch === "string"
  );
}

function importCandidateBundle(root, env, report) {
  if (!candidateReportHasCommit(report) || !isSha(report.mainSha) || !isSha(report.baseSha)) {
    throw new StageError(
      "candidate-artifact-validation",
      "candidate-artifact-lacks-fixed-sha-fields",
    );
  }
  const expectedBranch = resolveExpectedBranch(report.target);
  if (report.branch !== expectedBranch)
    throw new StageError("candidate-artifact-validation", "candidate-artifact-branch-mismatch");
  if (
    typeof report.bundleRef !== "string" ||
    !report.bundleRef.startsWith("refs/workbench-weekly-artifact/")
  ) {
    throw new StageError("candidate-artifact-validation", "candidate-artifact-bundle-ref-invalid");
  }
  const localRef = `refs/workbench-weekly-import/${env.runId}-${env.attempt}/candidate`;
  const importedSha = importCandidateBundleRef(
    root,
    join(env.artifactDir, "candidate.bundle"),
    report.bundleRef,
    localRef,
    report.candidateSha,
  );
  const metadata = readCandidateMetadataAt(root, importedSha, report.branch);
  if (!metadata.ok) throw new StageError("candidate-metadata-validation", metadata.reason);
  if (
    metadata.metadata.baseSha !== report.baseSha ||
    metadata.metadata.target.tag !== report.target.tag ||
    metadata.metadata.target.commit !== report.target.commit
  ) {
    throw new StageError(
      "candidate-metadata-validation",
      "candidate-metadata-does-not-match-run-report",
    );
  }
  checkoutImportedCandidate(root, importedSha, report.branch);
  return { report, metadata: metadata.metadata, localRef };
}

export function importCandidateBundleRef(root, bundlePath, bundleRef, localRef, expectedSha) {
  if (
    typeof bundleRef !== "string" ||
    !bundleRef.startsWith("refs/workbench-weekly-artifact/") ||
    !bundleRef.endsWith("/candidate") ||
    !isSha(expectedSha) ||
    !/^refs\/workbench-weekly-import\/[A-Za-z0-9-]+\/candidate$/.test(localRef)
  ) {
    throw new StageError("candidate-artifact-validation", "candidate-bundle-reference-invalid");
  }
  git(root, ["bundle", "verify", bundlePath], { stage: "candidate-bundle-verify" });
  git(root, ["fetch", "--no-tags", bundlePath, `${bundleRef}:${localRef}`], {
    stage: "candidate-bundle-fetch",
  });
  const importedSha = git(root, ["rev-parse", "--verify", `${localRef}^{commit}`], {
    stage: "candidate-bundle-resolve",
  }).toLowerCase();
  if (importedSha !== expectedSha.toLowerCase()) {
    throw new StageError(
      "candidate-bundle-identity",
      "bundle-commit-does-not-match-reported-candidate",
    );
  }
  return importedSha;
}

export function checkoutImportedCandidate(root, candidateSha, branch) {
  if (!isSha(candidateSha) || validateCandidateRef(`refs/heads/${branch}`) !== branch) {
    throw new StageError("candidate-checkout-validation", "candidate-branch-or-sha-invalid");
  }
  const branchRef = `refs/heads/${branch}`;
  const exists = gitResult(root, ["show-ref", "--verify", "--quiet", branchRef], {
    stage: "candidate-checkout-branch",
  });
  if (exists.ok)
    throw new StageError("candidate-checkout-branch", "candidate-local-branch-already-exists");
  if (exists.exitCode !== 1)
    throw new StageError(
      "candidate-checkout-branch",
      "could-not-check-local-candidate-branch",
      exists.exitCode,
    );
  git(root, ["switch", "--no-track", "--create", branch, candidateSha], {
    stage: "candidate-checkout",
  });
  if (getGitHead(root) !== candidateSha.toLowerCase())
    throw new StageError("candidate-checkout", "checked-out-candidate-sha-mismatch");
  const actualBranch = git(root, ["symbolic-ref", "--short", "-q", "HEAD"], {
    stage: "candidate-checkout-branch",
  });
  if (actualBranch !== branch)
    throw new StageError("candidate-checkout-branch", "checked-out-candidate-branch-mismatch");
}

function verifyOutputPaths(env) {
  const dir = join(env.runnerTemp, `workbench-weekly-verify-${env.runId}-${env.attempt}`);
  mkdirSync(dir, { recursive: true });
  return { dir, reportPath: join(dir, "verification-report.json") };
}

function writeVerificationReport(env, report, code) {
  const paths = verifyOutputPaths(env);
  report.artifactName = `workbench-weekly-verify-${env.runId}-${env.attempt}`;
  writeJson(paths.reportPath, report);
  writeOutput("verify_candidate_sha", report.candidateSha ?? "");
  writeOutput("verify_status", report.status ?? "unknown");
  writeOutput("verification_bound", report.bindPassed === true ? "true" : "false");
  appendSummary("Workbench weekly sync · verification", report);
  return code;
}

function verifyFixedCandidate() {
  const env = environment();
  const root = env.workspace;
  const artifact = readPrepareArtifact(env);
  if (!candidateReportHasCommit(artifact)) {
    return writeVerificationReport(
      env,
      {
        command: "weekly-verify",
        status: "not-run",
        stage: "candidate-artifact-validation",
        exitCode: null,
        retryAction: "inspect-the-candidate-preparation-report",
        candidateSha: artifact.candidateSha ?? null,
        bindPassed: false,
      },
      1,
    );
  }
  const report = artifact;
  if (!candidateReportHasCommit(report))
    throw new StageError(
      "candidate-artifact-validation",
      "candidate-artifact-lacks-fixed-sha-fields",
    );
  const metadata = readCandidateMetadataAt(root, report.candidateSha, report.branch);
  if (!metadata.ok) throw new StageError("candidate-metadata-validation", metadata.reason);
  if (getGitHead(root) !== report.candidateSha.toLowerCase()) {
    throw new StageError("verify-candidate-head", "verification-checkout-sha-mismatch");
  }
  const remoteMainSha = currentRemoteMain(root, env.mainRef);
  if (remoteMainSha !== report.mainSha) {
    return writeVerificationReport(
      env,
      {
        command: "weekly-verify",
        status: "candidate-stale",
        stage: "default-branch-advanced-before-verification",
        exitCode: null,
        retryAction: "merge-the-current-default-branch-into-the-candidate-and-reverify",
        candidateSha: report.candidateSha,
        baseSha: report.baseSha,
        mainRef: env.mainRef,
        mainSha: report.mainSha,
        observedMainSha: remoteMainSha,
        branch: report.branch,
        target: report.target,
        bindPassed: false,
      },
      1,
    );
  }
  const actualMainRefSha = git(root, ["rev-parse", "--verify", env.mainRef], {
    stage: "verify-main-ref",
  }).toLowerCase();
  if (actualMainRefSha !== report.mainSha) {
    return writeVerificationReport(
      env,
      {
        command: "weekly-verify",
        status: "candidate-stale",
        stage: "fixed-main-ref-mismatch",
        exitCode: null,
        retryAction: "checkout-the-exact-default-main-snapshot-and-retry",
        candidateSha: report.candidateSha,
        baseSha: report.baseSha,
        mainRef: env.mainRef,
        mainSha: report.mainSha,
        observedMainSha: actualMainRefSha,
        branch: report.branch,
        target: report.target,
        bindPassed: false,
      },
      1,
    );
  }
  if (getGitHead(root) !== report.candidateSha.toLowerCase()) {
    throw new StageError("verify-candidate-head", "verification-checkout-sha-mismatch");
  }
  if (candidateStatus(root).length > 0)
    throw new StageError("verify-candidate-cleanliness", "verification-checkout-is-dirty");
  const bind = syncCommand(root, [
    "bind",
    "--checkout",
    root,
    "--base",
    report.mainSha,
    "--target-tag",
    report.target.tag,
    "--target-sha",
    report.target.commit,
    "--candidate-sha",
    report.candidateSha,
    "--main-ref",
    env.mainRef,
  ]);
  if (bind.exitCode !== 0) {
    const stale = bind.report.status === "candidate-stale";
    return writeVerificationReport(
      env,
      {
        command: "weekly-verify",
        status: stale ? "candidate-stale" : "candidate-bind-failed",
        stage: bind.report.stage ?? "candidate-bind",
        exitCode: bind.exitCode,
        retryAction: bind.report.retryAction ?? "inspect-candidate-bind-report-before-retrying",
        candidateSha: report.candidateSha,
        baseSha: report.baseSha,
        mainRef: env.mainRef,
        mainSha: report.mainSha,
        branch: report.branch,
        target: report.target,
        bind: bind.report,
        bindPassed: false,
      },
      1,
    );
  }
  if (candidateStatus(root).length > 0)
    throw new StageError("verify-candidate-cleanliness", "bind-left-checkout-dirty");
  const verified = syncCommand(
    root,
    ["verify", "--candidate-sha", report.candidateSha],
    45 * 60_000,
  );
  const verificationSha = normalizeSha(
    verified.report.candidateSha ?? verified.report.candidate?.sha,
  );
  if (verificationSha !== report.candidateSha.toLowerCase()) {
    return writeVerificationReport(
      env,
      {
        command: "weekly-verify",
        status: "verification-sha-mismatch",
        stage: "verification-report-identity",
        exitCode: verified.exitCode,
        retryAction: "rerun-verification-after-confirming-the-exact-candidate-checkout",
        candidateSha: report.candidateSha,
        reportedCandidateSha: verified.report.candidateSha ?? null,
        baseSha: report.baseSha,
        mainRef: env.mainRef,
        mainSha: report.mainSha,
        branch: report.branch,
        target: report.target,
        bind: bind.report,
        verification: verified.report,
        bindPassed: true,
      },
      1,
    );
  }
  const validStatus =
    verified.report.status === "awaiting-runtime" ||
    verified.report.status === "checks-failed" ||
    verified.report.status === "candidate-stale";
  const status = validStatus ? verified.report.status : "verification-status-invalid";
  const matchingBase = verified.report.baseSha?.toLowerCase() === report.baseSha.toLowerCase();
  const matchingTarget =
    verified.report.target?.commit?.toLowerCase() === report.target.commit.toLowerCase() &&
    verified.report.target?.tag === report.target.tag;
  const success =
    verified.exitCode === 0 && status === "awaiting-runtime" && matchingBase && matchingTarget;
  const result = {
    command: "weekly-verify",
    status: !matchingBase || !matchingTarget ? "verification-input-mismatch" : status,
    stage: verified.report.stage ?? "candidate-verification",
    exitCode: verified.exitCode,
    retryAction:
      verified.report.retryAction ??
      (success
        ? "perform-separate-local-runtime-validation"
        : "inspect-failed-check-rows-and-retry-after-fix"),
    candidateSha: report.candidateSha,
    baseSha: report.baseSha,
    mainRef: env.mainRef,
    mainSha: report.mainSha,
    branch: report.branch,
    target: report.target,
    bind: bind.report,
    verification: verified.report,
    bindPassed: true,
  };
  return writeVerificationReport(env, result, success ? 0 : 1);
}

function importCandidateForVerify() {
  const env = environment();
  const root = env.workspace;
  const fixedMainSha = assertWorkflowContext(root, env);
  const artifact = readPrepareArtifact(env);
  if (!candidateReportHasCommit(artifact)) {
    writeOutput("candidate_imported", "false");
    return 0;
  }
  const currentMain = currentRemoteMain(root, env.mainRef);
  if (currentMain !== artifact.mainSha || artifact.mainSha?.toLowerCase() !== fixedMainSha) {
    const paths = verifyOutputPaths(env);
    writeJson(paths.reportPath, {
      command: "weekly-verify",
      status: "candidate-stale",
      stage: "default-branch-advanced-before-verification",
      exitCode: null,
      retryAction: "merge-the-current-default-branch-into-the-candidate-and-reverify",
      candidateSha: artifact.candidateSha,
      baseSha: artifact.baseSha,
      mainRef: env.mainRef,
      mainSha: artifact.mainSha,
      observedMainSha: currentMain,
      branch: artifact.branch,
      target: artifact.target,
      bindPassed: false,
    });
    writeOutput("candidate_imported", "false");
    writeOutput("verify_candidate_sha", artifact.candidateSha);
    writeOutput("verify_status", "candidate-stale");
    writeOutput("verification_bound", "false");
    appendSummary(
      "Workbench weekly sync · verification",
      readJson(paths.reportPath, "verify-report-read"),
    );
    return 1;
  }
  if (artifact.baseSha !== artifact.mainSha) {
    const paths = verifyOutputPaths(env);
    const stale = {
      command: "weekly-verify",
      status: "candidate-stale",
      stage: "candidate-base-does-not-match-fixed-main",
      exitCode: null,
      retryAction: "merge-current-main-normally-update-candidate-metadata-and-reverify",
      candidateSha: artifact.candidateSha,
      baseSha: artifact.baseSha,
      mainRef: env.mainRef,
      mainSha: artifact.mainSha,
      branch: artifact.branch,
      target: artifact.target,
      bindPassed: false,
    };
    writeJson(paths.reportPath, stale);
    writeOutput("candidate_imported", "false");
    writeOutput("verify_candidate_sha", artifact.candidateSha);
    writeOutput("verify_status", "candidate-stale");
    writeOutput("verification_bound", "false");
    appendSummary("Workbench weekly sync · verification", stale);
    return 1;
  }
  importCandidateBundle(root, env, artifact);
  writeOutput("candidate_imported", "true");
  writeOutput("verify_candidate_sha", artifact.candidateSha);
  return 0;
}

function writePublishReport(env, report, code) {
  const dir = join(env.runnerTemp, `workbench-weekly-publish-${env.runId}-${env.attempt}`);
  mkdirSync(dir, { recursive: true });
  report.artifactName = `workbench-weekly-publish-${env.runId}-${env.attempt}`;
  writeJson(join(dir, "publish-report.json"), report);
  writeOutput("publish_status", report.status ?? "unknown");
  writeOutput("published_sha", report.publishedSha ?? "");
  appendSummary("Workbench weekly sync · candidate persistence", report);
  return code;
}

function runPublish() {
  const env = environment();
  const root = env.workspace;
  const prepared = readPrepareArtifact(env);
  const verifyPath = join(
    env.runnerTemp,
    `workbench-weekly-verify-${env.runId}-${env.attempt}`,
    "verification-report.json",
  );
  const verified = readJson(verifyPath, "verification-artifact-read");
  let fixedMainSha;
  try {
    fixedMainSha = assertWorkflowContext(root, env);
  } catch (error) {
    const failure = errorReport(error, "weekly-publish");
    return writePublishReport(
      env,
      {
        ...failure,
        status: "publish-context-failed",
        candidateSha: prepared.candidateSha ?? null,
        branch: prepared.branch ?? null,
        target: prepared.target ?? null,
        baseSha: prepared.baseSha ?? null,
        verificationStatus: verified.status ?? "missing",
        verificationCandidateSha: verified.candidateSha ?? null,
        bindPassed: verified.bindPassed === true,
      },
      1,
    );
  }
  if (
    !candidateReportHasCommit(prepared) ||
    prepared.publishable !== true ||
    prepared.explicitRef === true ||
    prepared.mainSha?.toLowerCase() !== fixedMainSha ||
    prepared.baseSha?.toLowerCase() !== fixedMainSha ||
    !isSha(prepared.candidateSha) ||
    !(prepared.expectedOldSha === null || isSha(prepared.expectedOldSha))
  ) {
    return writePublishReport(
      env,
      {
        command: "weekly-publish",
        status: "publish-input-invalid",
        stage: "candidate-artifact-validation",
        exitCode: null,
        retryAction: "retain-and-review-the-candidate-report-before-publishing",
        candidateSha: prepared.candidateSha ?? null,
        branch: prepared.branch ?? null,
        target: prepared.target ?? null,
        bindPassed: false,
      },
      1,
    );
  }
  const verificationMatches =
    verified.candidateSha?.toLowerCase() === prepared.candidateSha.toLowerCase() &&
    verified.baseSha?.toLowerCase() === prepared.baseSha.toLowerCase() &&
    verified.mainSha?.toLowerCase() === prepared.mainSha.toLowerCase() &&
    verified.branch === prepared.branch &&
    verified.target?.tag === prepared.target.tag &&
    verified.target?.commit?.toLowerCase() === prepared.target.commit.toLowerCase() &&
    verified.bindPassed === true &&
    (verified.status === "awaiting-runtime" || verified.status === "checks-failed");
  if (!verificationMatches) {
    return writePublishReport(
      env,
      {
        command: "weekly-publish",
        status: "verification-artifact-mismatch",
        stage: "verification-artifact-validation",
        exitCode: null,
        retryAction: "preserve-the-candidate-bundle-and-review-the-exact-sha-verification-report",
        candidateSha: prepared.candidateSha,
        branch: prepared.branch,
        target: prepared.target,
        verificationStatus: verified.status ?? "missing",
        verificationCandidateSha: verified.candidateSha ?? null,
        bindPassed: false,
      },
      1,
    );
  }

  let importedSha;
  try {
    const localRef = `refs/workbench-weekly-import/${env.runId}-${env.attempt}/candidate`;
    importedSha = importCandidateBundleRef(
      root,
      join(env.artifactDir, "candidate.bundle"),
      prepared.bundleRef,
      localRef,
      prepared.candidateSha,
    );
  } catch (error) {
    const failed = errorReport(error, "weekly-publish");
    return writePublishReport(
      env,
      {
        ...failed,
        candidateSha: prepared.candidateSha,
        branch: prepared.branch,
        target: prepared.target,
        baseSha: prepared.baseSha,
        verificationStatus: verified.status,
        bindPassed: false,
      },
      1,
    );
  }
  let metadata;
  let ancestry = false;
  try {
    metadata = readCandidateMetadataAt(root, importedSha, prepared.branch);
    ancestry =
      metadata.ok &&
      metadata.metadata.baseSha.toLowerCase() === prepared.baseSha.toLowerCase() &&
      metadata.metadata.target.tag === prepared.target.tag &&
      metadata.metadata.target.commit.toLowerCase() === prepared.target.commit.toLowerCase() &&
      isAncestor(root, prepared.baseSha, importedSha) &&
      isAncestor(root, prepared.target.commit, importedSha);
  } catch (error) {
    const failure = errorReport(error, "weekly-publish");
    return writePublishReport(
      env,
      {
        ...failure,
        status: "candidate-validation-failed",
        candidateSha: prepared.candidateSha,
        branch: prepared.branch,
        target: prepared.target,
        baseSha: prepared.baseSha,
        verificationStatus: verified.status,
        verificationCandidateSha: verified.candidateSha,
        bindPassed: false,
      },
      1,
    );
  }
  if (!ancestry) {
    return writePublishReport(
      env,
      {
        command: "weekly-publish",
        status: "candidate-bundle-invalid",
        stage: metadata.ok ? "candidate-ancestry-validation" : "candidate-metadata-validation",
        exitCode: null,
        retryAction: "retain-the-original-bundle-and-review-candidate-metadata-and-merge-history",
        candidateSha: prepared.candidateSha,
        branch: prepared.branch,
        target: prepared.target,
        baseSha: prepared.baseSha,
        bindPassed: false,
      },
      1,
    );
  }

  let publication;
  try {
    publication = publishCandidateRef(root, {
      remoteName: "origin",
      mainRef: env.mainRef,
      baseSha: prepared.baseSha,
      candidateSha: prepared.candidateSha,
      targetTag: prepared.target.tag,
      targetSha: prepared.target.commit,
      branch: prepared.branch,
      expectedOldSha: prepared.expectedOldSha,
    });
  } catch (error) {
    const failure = errorReport(error, "weekly-publish");
    return writePublishReport(
      env,
      {
        ...failure,
        status: "publish-failed",
        candidateSha: prepared.candidateSha,
        branch: prepared.branch,
        target: prepared.target,
        baseSha: prepared.baseSha,
        verificationStatus: verified.status,
        verificationCandidateSha: verified.candidateSha,
        bindPassed: verified.bindPassed === true,
      },
      1,
    );
  }
  const successfulPublication =
    publication.status === "published" ||
    publication.status === "advanced" ||
    publication.status === "unchanged";
  const status =
    successfulPublication && verified.status === "checks-failed"
      ? "candidate-published-checks-failed"
      : publication.status;
  const report = {
    command: "weekly-publish",
    ...publication,
    status,
    candidateSha: prepared.candidateSha,
    branch: prepared.branch,
    target: prepared.target,
    baseSha: prepared.baseSha,
    verificationStatus: verified.status,
    verificationCandidateSha: verified.candidateSha,
    checks: verified.verification?.checks ?? [],
    bindPassed: verified.bindPassed === true,
    pullRequest: { status: "not-created", reason: "actions-token-pr-creation-setting-disabled" },
    retryAction:
      publication.retryAction ??
      "review-the-candidate-branch-and-await-separate-runtime-validation",
  };
  return writePublishReport(env, report, successfulPublication ? 0 : 1);
}

function writeCommandFailure(command, error) {
  const env = environment();
  const report = errorReport(error, command);
  if (command === "weekly-prepare") return writePrepareReport(env, report, 1);
  if (command === "weekly-verify") {
    let details = {};
    try {
      const prepared = readPrepareArtifact(env);
      details = {
        candidateSha: prepared.candidateSha ?? null,
        baseSha: prepared.baseSha ?? null,
        mainRef: env.mainRef,
        mainSha: prepared.mainSha ?? null,
        branch: prepared.branch ?? null,
        target: prepared.target ?? null,
        bindPassed: false,
      };
    } catch {
      // Keep a useful stage report even when the prepare artifact is unavailable.
    }
    return writeVerificationReport(env, { ...report, ...details }, 1);
  }
  let details = {};
  try {
    const prepared = readPrepareArtifact(env);
    details = {
      candidateSha: prepared.candidateSha ?? null,
      baseSha: prepared.baseSha ?? null,
      branch: prepared.branch ?? null,
      target: prepared.target ?? null,
    };
  } catch {
    // The candidate bundle remains the recovery source when its report is unreadable.
  }
  return writePublishReport(env, { ...report, ...details }, 1);
}

function main() {
  const command = process.argv[2];
  try {
    if (command === "prepare") return runPrepare();
    if (command === "import-for-verify") return importCandidateForVerify();
    if (command === "verify") return verifyFixedCandidate();
    if (command === "publish") return runPublish();
    throw new StageError(
      "command-validation",
      "supported-commands-are-prepare-import-for-verify-verify-publish",
    );
  } catch (error) {
    const reportCommand =
      command === "prepare"
        ? "weekly-prepare"
        : command === "verify" || command === "import-for-verify"
          ? "weekly-verify"
          : "weekly-publish";
    try {
      return writeCommandFailure(reportCommand, error);
    } catch {
      process.stderr.write(`${reportCommand}: workflow-failed\n`);
      return 1;
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  process.exitCode = main();
}
