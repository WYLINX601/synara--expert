import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  checkoutImportedCandidate,
  createWritableCandidateWorktree,
  expectedCandidateBranch,
  fetchOfficialTagCommit,
  importCandidateBundleRef,
  makeRecoveryInstructions,
  publishCandidateRef,
} from "./workbench-weekly.mjs";
import { bindWorkbenchCandidate } from "../../scripts/lib/workbench-sync/workflow.ts";

function git(cwd, ...args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function configureIdentity(root, name = "Fixture User") {
  git(root, "config", "user.name", name);
  git(root, "config", "user.email", "fixture@example.invalid");
}

function commitAll(root, message) {
  git(root, "add", "-A");
  git(root, "commit", "-m", message);
  return git(root, "rev-parse", "HEAD").toLowerCase();
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function main() {
  const workflow = readFileSync(
    new URL("../workflows/workbench-weekly-sync.yml", import.meta.url),
    "utf8",
  );
  const verifyJob = workflow.split("  verify:\n")[1]?.split("  publish:\n")[0] ?? "";
  const publishJob = workflow.split("  publish:\n")[1] ?? "";
  assert.match(workflow, /cron: "30 2 \* \* 6"/);
  assert.match(workflow, /cancel-in-progress: false/);
  assert.match(verifyJob, /permissions:\n\s+contents: read/);
  assert.doesNotMatch(verifyJob, /GITHUB_TOKEN|secrets\.GITHUB_TOKEN|contents: write/);
  assert.match(publishJob, /permissions:\n\s+contents: write/);
  assert.equal((publishJob.match(/\n\s+GITHUB_TOKEN:/g) ?? []).length, 1);
  assert.equal((publishJob.match(/secrets\.GITHUB_TOKEN/g) ?? []).length, 1);
  assert.match(publishJob, /Checkout trusted default-branch publisher/);

  const sandbox = mkdtempSync(join(tmpdir(), "workbench-weekly-fixture-"));
  const source = join(sandbox, "source");
  const officialRemote = join(sandbox, "official.git");
  const candidateRemote = join(sandbox, "candidate.git");
  const verifyRepo = join(sandbox, "verify");
  const humanRepo = join(sandbox, "human");
  const candidateWorktree = join(sandbox, "candidate-worktree");
  const identityWorktree = join(sandbox, "identity-worktree");
  const bundlePath = join(sandbox, "candidate.bundle");
  const tag = "v0.9.2";
  let originalEnvironment;

  try {
    git(sandbox, "init", "--bare", "--initial-branch=main", officialRemote);
    git(sandbox, "init", "--bare", "--initial-branch=main", candidateRemote);
    git(sandbox, "init", "-b", "main", source);
    configureIdentity(source);
    mkdirSync(join(source, "workbench"), { recursive: true });
    writeFileSync(join(source, "bun.lock"), "fixture-lock\n");
    writeFileSync(join(source, ".mise.toml"), 'node = "24.13.1"\nbun = "1.4.2"\n');
    writeJson(join(source, "workbench", "upstream.lock.json"), {
      formatVersion: 1,
      repository: "https://github.com/Emanuele-web04/synara.git",
      branch: "main",
      updateChannel: "latest-stable-release",
      integrationStrategy: "merge",
      integratedBase: { tag: "v0.9.1", commit: "a".repeat(40) },
      candidate: { tag, commit: "b".repeat(40), status: "not-yet-integrated" },
    });
    const baseSha = commitAll(source, "fixture: main base");
    git(source, "remote", "add", "origin", candidateRemote);
    git(source, "push", "origin", "main");
    git(source, "remote", "add", "official", officialRemote);
    git(source, "push", "official", "main");

    git(source, "switch", "-c", "release-fixture", baseSha);
    writeFileSync(join(source, "official-release.txt"), "fixed target\n");
    const targetSha = commitAll(source, "fixture: official target");
    git(source, "tag", "-a", tag, targetSha, "-m", "fixture release");
    git(source, "push", "official", `refs/tags/${tag}`);
    git(source, "switch", "main");

    const branch = expectedCandidateBranch(tag, targetSha);
    assert.ok(branch);

    originalEnvironment = {
      GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL,
      GIT_CONFIG_SYSTEM: process.env.GIT_CONFIG_SYSTEM,
      GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME,
      GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL,
      GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME,
      GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL,
    };
    process.env.GIT_CONFIG_GLOBAL = "/dev/null";
    process.env.GIT_CONFIG_SYSTEM = "/dev/null";
    for (const key of [
      "GIT_AUTHOR_NAME",
      "GIT_AUTHOR_EMAIL",
      "GIT_COMMITTER_NAME",
      "GIT_COMMITTER_EMAIL",
    ])
      delete process.env[key];
    git(source, "config", "--unset-all", "user.name");
    git(source, "config", "--unset-all", "user.email");

    createWritableCandidateWorktree(
      source,
      identityWorktree,
      baseSha,
      "codex/sync-identity-fixture-00000000",
    );
    writeFileSync(
      join(identityWorktree, "identity.txt"),
      "commit identity comes from the worktree helper\n",
    );
    const identitySha = commitAll(identityWorktree, "fixture: identity check");
    assert.match(
      git(identityWorktree, "show", "-s", "--format=%an <%ae>", identitySha),
      /github-actions\[bot\] <41898282\+github-actions\[bot\]@users\.noreply\.github\.com>/,
    );
    git(source, "worktree", "remove", "--force", identityWorktree);
    git(source, "branch", "-D", "codex/sync-identity-fixture-00000000");

    createWritableCandidateWorktree(source, candidateWorktree, baseSha, branch);
    git(candidateWorktree, "merge", "--no-ff", "--no-edit", targetSha);
    writeJson(join(candidateWorktree, "workbench", "sync-candidate.json"), {
      formatVersion: 1,
      baseSha,
      target: { tag, commit: targetSha },
      branch,
    });
    const candidateSha = commitAll(candidateWorktree, "fixture: candidate metadata");
    const fullBefore = git(source, "rev-parse", "--is-shallow-repository");
    assert.equal(fullBefore, "false");
    assert.equal(
      fetchOfficialTagCommit(source, { tag, commit: targetSha }, officialRemote),
      targetSha,
    );
    assert.equal(git(source, "rev-parse", "--is-shallow-repository"), "false");
    assert.equal(git(source, "rev-list", "--count", targetSha), "2");

    const bundleRefBase = "refs/workbench-weekly-artifact/fixture-1/base";
    const bundleRefTarget = "refs/workbench-weekly-artifact/fixture-1/target";
    const bundleRefCandidate = "refs/workbench-weekly-artifact/fixture-1/candidate";
    git(source, "update-ref", bundleRefBase, baseSha);
    git(source, "update-ref", bundleRefTarget, targetSha);
    git(source, "update-ref", bundleRefCandidate, candidateSha);
    git(source, "bundle", "create", bundlePath, bundleRefBase, bundleRefTarget, bundleRefCandidate);
    git(source, "bundle", "verify", bundlePath);
    git(source, "update-ref", "-d", bundleRefBase);
    git(source, "update-ref", "-d", bundleRefTarget);
    git(source, "update-ref", "-d", bundleRefCandidate);
    git(sandbox, "clone", "--no-hardlinks", candidateRemote, verifyRepo);

    const importedSha = importCandidateBundleRef(
      verifyRepo,
      bundlePath,
      bundleRefCandidate,
      "refs/workbench-weekly-import/fixture-1/candidate",
      candidateSha,
    );
    assert.equal(importedSha, candidateSha);
    checkoutImportedCandidate(verifyRepo, importedSha, branch);
    assert.equal(git(verifyRepo, "branch", "--show-current"), branch);
    assert.equal(git(verifyRepo, "rev-parse", "HEAD").toLowerCase(), candidateSha);

    const bound = await bindWorkbenchCandidate({
      repoRoot: verifyRepo,
      checkout: verifyRepo,
      baseSha,
      targetTag: tag,
      targetSha,
      candidateSha,
      mainRef: "refs/heads/main",
      dependencies: {
        repository: officialRemote,
        readToolchain: () => ({ node: "24.13.1", bun: "1.4.2" }),
      },
    });
    assert.equal(bound.status, "candidate-bound");
    assert.equal(bound.candidateSha, candidateSha);
    assert.equal(bound.branch, branch);

    const firstPublish = publishCandidateRef(verifyRepo, {
      remoteName: "origin",
      mainRef: "refs/heads/main",
      baseSha,
      candidateSha,
      targetTag: tag,
      targetSha,
      branch,
      expectedOldSha: null,
      environment: { ...process.env, GITHUB_TOKEN: "" },
    });
    assert.equal(firstPublish.status, "published");
    assert.equal(
      git(candidateRemote, "rev-parse", `refs/heads/${branch}`).toLowerCase(),
      candidateSha,
    );

    git(sandbox, "clone", "--no-hardlinks", candidateRemote, humanRepo);
    configureIdentity(humanRepo, "Human repair");
    git(humanRepo, "switch", "--create", branch, "--track", `origin/${branch}`);
    writeFileSync(join(humanRepo, "human-repair.txt"), "preserve this repair\n");
    const humanSha = commitAll(humanRepo, "fixture: human repair");
    git(humanRepo, "push", "origin", `HEAD:refs/heads/${branch}`);

    const refusedRace = publishCandidateRef(verifyRepo, {
      remoteName: "origin",
      mainRef: "refs/heads/main",
      baseSha,
      candidateSha,
      targetTag: tag,
      targetSha,
      branch,
      expectedOldSha: candidateSha,
      environment: { ...process.env, GITHUB_TOKEN: "" },
    });
    assert.equal(refusedRace.status, "remote-branch-advanced");
    assert.equal(git(candidateRemote, "rev-parse", `refs/heads/${branch}`).toLowerCase(), humanSha);

    git(verifyRepo, "fetch", "origin", `refs/heads/${branch}:refs/remotes/origin/${branch}`);
    configureIdentity(verifyRepo, "Candidate Bot");
    const humanTree = git(verifyRepo, "show", "-s", "--format=%T", humanSha);
    const newCandidateSha = git(
      verifyRepo,
      "commit-tree",
      humanTree,
      "-p",
      humanSha,
      "-m",
      "fixture: authorized candidate advance",
    ).toLowerCase();
    const advance = publishCandidateRef(verifyRepo, {
      remoteName: "origin",
      mainRef: "refs/heads/main",
      baseSha,
      candidateSha: newCandidateSha,
      targetTag: tag,
      targetSha,
      branch,
      expectedOldSha: humanSha,
      environment: { ...process.env, GITHUB_TOKEN: "" },
    });
    assert.equal(advance.status, "advanced");
    assert.equal(
      git(candidateRemote, "rev-parse", `refs/heads/${branch}`).toLowerCase(),
      newCandidateSha,
    );

    const newConflict = makeRecoveryInstructions(
      branch,
      baseSha,
      { tag, commit: targetSha },
      ["conflict.txt"],
      false,
    );
    const resumedConflict = makeRecoveryInstructions(
      branch,
      baseSha,
      { tag, commit: targetSha },
      ["conflict.txt"],
      true,
    );
    assert.match(newConflict, new RegExp(`git merge --no-ff ${targetSha}`));
    assert.match(resumedConflict, new RegExp(`git merge --no-ff ${baseSha}`));
    assert.match(newConflict, /no merge or repair is complete until you resolve and commit it/);

    process.stdout.write(
      "WB05 fixture passed: full-history fetch, worktree identity, cross-job bundle import + real sync bind, CAS create/advance, and race preservation.\n",
    );
  } finally {
    if (originalEnvironment) {
      for (const [key, value] of Object.entries(originalEnvironment)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
    rmSync(sandbox, { recursive: true, force: true });
  }
}

await main();
