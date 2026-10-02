import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  readRepositoryLockStatus,
  resolveRepositoryStatePaths,
  withRepositoryLock,
  type RuntimeEvidence,
} from "./lib/workbench-sync/state.ts";
import { runGit } from "./lib/workbench-sync/git.ts";
import {
  AUTOMATIC_CHECKS,
  bindWorkbenchCandidate,
  checkWorkbenchSyncWorkflow,
  prepareWorkbenchCandidate,
  REQUIRED_RUNTIME_CHECKS,
  statusWorkbenchSync,
  verifyWorkbenchCandidate,
} from "./lib/workbench-sync/workflow.ts";
import type { WorkbenchSyncLock } from "./lib/workbench-sync/sync.ts";

const temporaryDirectories: string[] = [];
const OFFICIAL_REPOSITORY = "https://github.com/Emanuele-web04/synara.git";

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function tempDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), `synara-workflow-${prefix}-`));
  temporaryDirectories.push(directory);
  return directory;
}

function git(cwd: string, ...args: string[]): string {
  const result = runGit(cwd, args, 30_000);
  if (!result.ok) throw new Error(`git ${args[0]} failed (${result.exitCode ?? "unknown"})`);
  return result.stdout.trim();
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolvePromise!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromiseValue) => {
    resolvePromise = resolvePromiseValue;
  });
  return { promise, resolve: resolvePromise };
}

async function commitFile(
  repo: string,
  file: string,
  content: string,
  message: string,
): Promise<string> {
  const path = join(repo, file);
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, content);
  git(repo, "add", "--", file);
  git(repo, "commit", "-m", message);
  return git(repo, "rev-parse", "HEAD");
}

function fixtureLock(
  baseSha: string,
  targetSha: string,
  candidateTag = "v0.9.2",
  baseTag = "v0.9.1",
): WorkbenchSyncLock {
  return {
    formatVersion: 1,
    repository: OFFICIAL_REPOSITORY,
    branch: "main",
    updateChannel: "latest-stable-release",
    integrationStrategy: "merge",
    integratedBase: { tag: baseTag, commit: baseSha },
    candidate: { tag: candidateTag, commit: targetSha, status: "not-yet-integrated" },
  };
}

function fakeFetcher(tag = "v0.9.2"): () => Promise<Response> {
  return async () =>
    new Response(
      JSON.stringify([
        {
          draft: false,
          prerelease: false,
          tag_name: tag,
          published_at: "2026-09-22T00:00:00Z",
        },
      ]),
      { status: 200 },
    );
}

type Fixture = {
  readonly directory: string;
  readonly remote: string;
  readonly seed: string;
  readonly repo: string;
  readonly checkout: string;
  readonly baseSha: string;
  readonly targetSha: string;
};

async function makeFixture(conflict = false): Promise<Fixture> {
  const directory = await tempDirectory("repo");
  const seed = join(directory, "seed");
  const remote = join(directory, "upstream.git");
  const repo = join(directory, "repo");
  const checkout = join(directory, "candidate");
  git(directory, "init", "--bare", remote);
  git(directory, "init", "-b", "main", seed);
  git(seed, "config", "user.name", "Workbench Test");
  git(seed, "config", "user.email", "workbench-test@example.invalid");
  const baseFile = conflict ? "shared.txt" : "upstream.txt";
  const baseSha = await commitFile(seed, baseFile, "base\n", "official base");
  git(seed, "tag", "v0.9.1", baseSha);
  const targetSha = await commitFile(
    seed,
    conflict ? baseFile : "release.txt",
    conflict ? "official update\n" : "release\n",
    "stable release",
  );
  git(seed, "tag", "v0.9.2", targetSha);
  git(seed, "push", remote, "main", "--tags");

  git(directory, "clone", "--no-checkout", remote, repo);
  git(repo, "config", "user.name", "Workbench Test");
  git(repo, "config", "user.email", "workbench-test@example.invalid");
  git(repo, "switch", "-C", "main", baseSha);
  await mkdir(join(repo, "workbench"), { recursive: true });
  if (conflict) await writeFile(join(repo, baseFile), "custom update\n");
  await writeFile(
    join(repo, "workbench/upstream.lock.json"),
    `${JSON.stringify(fixtureLock(baseSha, targetSha), null, 2)}\n`,
  );
  await writeFile(join(repo, ".mise.toml"), '[tools]\nnode = "24.13.1"\nbun = "1.4.2"\n');
  await writeFile(join(repo, "bun.lock"), '{"lockfileVersion":1}\n');
  git(repo, "add", "--", "workbench/upstream.lock.json", ".mise.toml", "bun.lock");
  if (conflict) git(repo, "add", "--", baseFile);
  git(repo, "commit", "-m", "workbench candidate fixture");
  git(repo, "worktree", "add", "--detach", checkout, "main");
  return { directory, remote, seed, repo, checkout, baseSha, targetSha };
}

async function checkedAndPrepared(fixture: Fixture) {
  const check = await checkWorkbenchSyncWorkflow({
    repoRoot: fixture.repo,
    dependencies: { repository: fixture.remote, fetcher: fakeFetcher() },
  });
  expect(check.status).toBe("update-available");
  const baseSha = check.mainSha!;
  const prepare = await prepareWorkbenchCandidate({
    repoRoot: fixture.repo,
    checkout: fixture.checkout,
    baseSha,
    targetTag: "v0.9.2",
    targetSha: fixture.targetSha,
    dependencies: { repository: fixture.remote },
  });
  expect(prepare.status).toBe("candidate-ready");
  expect(prepare.candidateSha).toBeTruthy();
  expect(git(fixture.checkout, "status", "--porcelain=v1", "--untracked-files=all")).toBe("");
  return { baseSha, prepare };
}

const toolchain = { node: "24.13.1", bun: "1.4.2" };
const allPassing = () => ({ exitCode: 0, stdout: "", stderr: "" });

async function runtimeEvidenceFor(
  fixture: Fixture,
  candidateSha: string,
  baseSha: string,
): Promise<RuntimeEvidence> {
  const hash = async (path: string) =>
    createHash("sha256")
      .update(await readFile(path))
      .digest("hex");
  return {
    formatVersion: 1,
    candidateSha,
    baseSha,
    mainRef: "refs/heads/main",
    mainSha: baseSha,
    target: { tag: "v0.9.2", commit: fixture.targetSha },
    lockfileHashes: {
      bunLock: await hash(join(fixture.checkout, "bun.lock")),
      upstreamLock: await hash(join(fixture.checkout, "workbench/upstream.lock.json")),
      miseToml: await hash(join(fixture.checkout, ".mise.toml")),
    },
    toolchain,
    checks: REQUIRED_RUNTIME_CHECKS.map((id) => ({
      id,
      status: "passed",
      evidenceSha256: createHash("sha256").update(id).digest("hex"),
    })),
  };
}

describe("workbench sync persisted workflow", () => {
  // The composed Git fixture needs a 30s test budget matching its per-command Git timeout.
  it("binds a newly checked official release when the versioned candidate lock is stale", async () => {
    const fixture = await makeFixture();
    const nextTargetSha = await commitFile(
      fixture.seed,
      "release-next.txt",
      "next release\n",
      "next stable release",
    );
    git(fixture.seed, "tag", "v0.9.3", nextTargetSha);
    git(fixture.seed, "push", fixture.remote, "main", "--tags");

    const check = await checkWorkbenchSyncWorkflow({
      repoRoot: fixture.repo,
      dependencies: { repository: fixture.remote, fetcher: fakeFetcher("v0.9.3") },
    });
    expect(check.status).toBe("update-available");
    expect(check.release).toMatchObject({ tag: "v0.9.3", commit: nextTargetSha });

    const prepare = await prepareWorkbenchCandidate({
      repoRoot: fixture.repo,
      checkout: fixture.checkout,
      baseSha: check.mainSha!,
      targetTag: "v0.9.3",
      targetSha: nextTargetSha,
      dependencies: { repository: fixture.remote },
    });
    expect(prepare.status).toBe("candidate-ready");
    const metadata = {
      formatVersion: 1,
      baseSha: check.mainSha,
      target: { tag: "v0.9.3", commit: nextTargetSha },
      branch: prepare.branch,
    };
    await commitFile(
      fixture.checkout,
      "workbench/sync-candidate.json",
      `${JSON.stringify(metadata, null, 2)}\n`,
      "record next official candidate identity",
    );
    const candidateSha = git(fixture.checkout, "rev-parse", "HEAD");

    const bind = await bindWorkbenchCandidate({
      repoRoot: fixture.repo,
      checkout: fixture.checkout,
      baseSha: check.mainSha!,
      targetTag: "v0.9.3",
      targetSha: nextTargetSha,
      candidateSha,
      dependencies: { repository: fixture.remote },
    });

    expect(bind.status).toBe("candidate-bound");
    expect(bind.target).toEqual({ tag: "v0.9.3", commit: nextTargetSha });
    const unchangedLock = JSON.parse(
      await readFile(join(fixture.repo, "workbench/upstream.lock.json"), "utf8"),
    ) as WorkbenchSyncLock;
    expect(unchangedLock.candidate).toEqual({
      tag: "v0.9.2",
      commit: fixture.targetSha,
      status: "not-yet-integrated",
    });
  }, 30_000);

  it("rejects a locked release target older than the integrated base during bind", async () => {
    const fixture = await makeFixture();
    git(
      fixture.repo,
      "merge",
      "--no-ff",
      fixture.targetSha,
      "-m",
      "integrate newer official release",
    );
    await commitFile(
      fixture.repo,
      "workbench/upstream.lock.json",
      `${JSON.stringify(
        fixtureLock(fixture.targetSha, fixture.baseSha, "v0.9.1", "v0.9.2"),
        null,
        2,
      )}\n`,
      "lock an older target against the newer integrated base",
    );
    const currentMain = git(fixture.repo, "rev-parse", "HEAD");
    const candidateHead = git(fixture.checkout, "rev-parse", "HEAD");

    const bind = await bindWorkbenchCandidate({
      repoRoot: fixture.repo,
      checkout: fixture.checkout,
      baseSha: currentMain,
      targetTag: "v0.9.1",
      targetSha: fixture.baseSha,
      candidateSha: candidateHead,
      dependencies: { repository: fixture.remote },
    });

    expect(bind.status).toBe("bind-rejected");
    expect(bind.stage).toBe("target-not-after-integrated-base");
  });

  it("rejects a locked release target that diverges from the integrated base during bind", async () => {
    const fixture = await makeFixture();
    git(fixture.seed, "switch", "--detach", fixture.baseSha);
    git(fixture.seed, "switch", "-c", "divergent-release");
    const divergentSha = await commitFile(
      fixture.seed,
      "divergent-release.txt",
      "divergent release\n",
      "create a divergent official release",
    );
    git(fixture.seed, "tag", "v0.9.3", divergentSha);
    git(fixture.seed, "push", fixture.remote, "divergent-release", "--tags");
    git(fixture.repo, "fetch", fixture.remote, "--tags");
    git(fixture.repo, "merge", "--no-ff", fixture.targetSha, "-m", "integrate official baseline");
    await commitFile(
      fixture.repo,
      "workbench/upstream.lock.json",
      `${JSON.stringify(
        fixtureLock(fixture.targetSha, divergentSha, "v0.9.3", "v0.9.2"),
        null,
        2,
      )}\n`,
      "lock a divergent target against the integrated base",
    );
    const currentMain = git(fixture.repo, "rev-parse", "HEAD");
    const candidateHead = git(fixture.checkout, "rev-parse", "HEAD");

    const bind = await bindWorkbenchCandidate({
      repoRoot: fixture.repo,
      checkout: fixture.checkout,
      baseSha: currentMain,
      targetTag: "v0.9.3",
      targetSha: divergentSha,
      candidateSha: candidateHead,
      dependencies: { repository: fixture.remote },
    });

    expect(bind.status).toBe("bind-rejected");
    expect(bind.stage).toBe("target-not-after-integrated-base");
  });

  // The composed Git fixture needs a 30s test budget matching its per-command Git timeout.
  it("checks a fixed target, prepares it, records bounded checks, and stays awaiting runtime", async () => {
    const fixture = await makeFixture();
    const { prepare } = await checkedAndPrepared(fixture);
    const status = await statusWorkbenchSync({
      repoRoot: fixture.repo,
      dependencies: { readToolchain: () => toolchain },
    });
    expect(status.status).toBe("awaiting-verification");
    expect(JSON.stringify(status)).not.toContain(fixture.checkout);

    const commands: string[] = [];
    const verified = await verifyWorkbenchCandidate({
      repoRoot: fixture.repo,
      candidateSha: prepare.candidateSha!,
      dependencies: {
        readToolchain: () => toolchain,
        commandRunner: (_cwd, command, args) => {
          commands.push(`${command} ${args.join(" ")}`);
          return allPassing();
        },
      },
    });
    expect(commands).toEqual(AUTOMATIC_CHECKS.map(({ script }) => `bun run ${script}`));
    expect(verified.status).toBe("awaiting-runtime");
    expect(verified.checks.every((check) => check.status === "passed")).toBe(true);
    expect(verified.runtimeEvidence).toEqual({
      status: "missing",
      reason: "runtime-evidence-not-provided",
    });
  }, 30_000);

  // The composed Git fixture needs a 30s test budget matching its per-command Git timeout.
  it("stores private stdout and stderr logs with per-check hashes and a relative index", async () => {
    const fixture = await makeFixture();
    const { prepare } = await checkedAndPrepared(fixture);
    let calls = 0;
    const verified = await verifyWorkbenchCandidate({
      repoRoot: fixture.repo,
      candidateSha: prepare.candidateSha!,
      dependencies: {
        readToolchain: () => toolchain,
        commandRunner: () => {
          calls += 1;
          if (calls === 1) {
            return {
              exitCode: 0,
              stdout: "format output\n",
              stderr: "format diagnostic\n",
            };
          }
          if (calls === 2) {
            return {
              exitCode: 1,
              stdout: "lint output\n",
              stderr: "lint diagnostic\n",
            };
          }
          if (calls === 3) throw new Error("injected gate runner exception");
          if (calls === 4) {
            return {
              exitCode: null,
              stdout: "timeout partial output\n",
              stderr: "timeout partial diagnostic\n",
              runnerError: "spawnSync bun ETIMEDOUT\nspawnSignal=SIGTERM",
            };
          }
          return allPassing();
        },
      },
    });

    expect(calls).toBe(AUTOMATIC_CHECKS.length);
    expect(verified.status).toBe("checks-failed");
    expect(verified.verificationLogs?.status).toBe("saved");
    expect(verified.verificationLogs?.indexPath).toBe(
      `workbench-sync/verification-logs/${prepare.candidateSha}/${verified.verificationLogs?.runId}/index.json`,
    );
    expect(verified.checks.map((check) => check.status)).toEqual([
      "passed",
      "failed",
      "failed",
      "failed",
      "passed",
      "passed",
    ]);
    expect(verified.checks[2]?.reason).toBe("gate-runner-threw");

    const paths = await resolveRepositoryStatePaths(fixture.repo);
    const resolveLogPath = (path: string) => join(paths.commonDirectory, path);
    const readAndCheckLog = async (reference: {
      readonly path: string;
      readonly sha256: string;
      readonly sizeBytes: number;
    }) => {
      expect(reference.path).not.toContain(fixture.repo);
      const contents = await readFile(resolveLogPath(reference.path));
      expect(createHash("sha256").update(contents).digest("hex")).toBe(reference.sha256);
      expect(contents.byteLength).toBe(reference.sizeBytes);
      if (process.platform !== "win32") {
        expect((await stat(resolveLogPath(reference.path))).mode & 0o777).toBe(0o600);
      }
      return contents.toString("utf8");
    };

    const formatLogs = verified.checks[0]!.logs!;
    expect(await readAndCheckLog(formatLogs.stdout!)).toBe("format output\n");
    expect(await readAndCheckLog(formatLogs.stderr!)).toBe("format diagnostic\n");
    const thrownRunnerError = verified.checks[2]!.logs!.runnerError!;
    expect(await readAndCheckLog(thrownRunnerError)).toContain("injected gate runner exception");
    const timeoutRunnerError = verified.checks[3]!.logs!.runnerError!;
    expect(await readAndCheckLog(timeoutRunnerError)).toContain("ETIMEDOUT");

    const indexPath = resolveLogPath(verified.verificationLogs!.indexPath!);
    const indexContents = await readFile(indexPath);
    expect(createHash("sha256").update(indexContents).digest("hex")).toBe(
      verified.verificationLogs?.indexSha256,
    );
    expect(indexContents.byteLength).toBe(verified.verificationLogs?.indexSizeBytes);
    expect(indexContents.toString("utf8")).not.toContain("format output");
    const index = JSON.parse(indexContents.toString("utf8")) as {
      readonly candidateSha: string;
      readonly checks: readonly { readonly id: string; readonly logs?: unknown }[];
    };
    expect(index.candidateSha).toBe(prepare.candidateSha);
    expect(index.checks.map((check) => check.id)).toEqual(AUTOMATIC_CHECKS.map(({ id }) => id));
    expect(index.checks[0]?.logs).toEqual(formatLogs);
    expect(JSON.stringify(verified)).not.toContain(fixture.repo);
    if (process.platform !== "win32") {
      expect(
        (await stat(join(paths.commonDirectory, "workbench-sync/verification-logs"))).mode & 0o777,
      ).toBe(0o700);
      expect((await stat(indexPath)).mode & 0o777).toBe(0o600);
    }
    const status = await statusWorkbenchSync({ repoRoot: fixture.repo });
    expect(status.status).toBe("checks-failed");
    expect((status.candidate as { readonly verificationLogs: unknown }).verificationLogs).toEqual(
      verified.verificationLogs,
    );
  }, 30_000);

  it("keeps verification failed when the private log archive cannot be created", async () => {
    const fixture = await makeFixture();
    const { baseSha, prepare } = await checkedAndPrepared(fixture);
    const paths = await resolveRepositoryStatePaths(fixture.repo);
    await writeFile(join(paths.stateDirectory, "verification-logs"), "block the log directory");
    const evidencePath = join(fixture.directory, "runtime-evidence.json");
    await writeFile(
      evidencePath,
      `${JSON.stringify(
        await runtimeEvidenceFor(fixture, prepare.candidateSha!, baseSha),
        null,
        2,
      )}\n`,
    );
    let calls = 0;
    const verified = await verifyWorkbenchCandidate({
      repoRoot: fixture.repo,
      candidateSha: prepare.candidateSha!,
      runtimeEvidencePath: evidencePath,
      dependencies: {
        readToolchain: () => toolchain,
        commandRunner: () => {
          calls += 1;
          return allPassing();
        },
      },
    });

    expect(calls).toBe(AUTOMATIC_CHECKS.length);
    expect(verified.checks.every((check) => check.status === "passed")).toBe(true);
    expect(verified.runtimeEvidence.status).toBe("accepted");
    expect(verified.status).toBe("checks-failed");
    expect(verified.exitCode).toBe(1);
    expect(verified.verificationLogs).toMatchObject({
      status: "failed",
      reason: "log-directory-unavailable",
    });
    expect((await statusWorkbenchSync({ repoRoot: fixture.repo })).status).toBe("checks-failed");
  });

  // The composed Git fixture needs a 30s test budget matching its per-command Git timeout.
  it("keeps unmerged candidates busy, then retires a merged candidate and prepares the next release", async () => {
    const fixture = await makeFixture();
    const { prepare: firstCandidate } = await checkedAndPrepared(fixture);
    const nextTargetSha = await commitFile(
      fixture.seed,
      "release-next.txt",
      "next release\n",
      "next stable release",
    );
    git(fixture.seed, "tag", "v0.9.3", nextTargetSha);
    git(fixture.seed, "push", fixture.remote, "main", "--tags");

    await commitFile(
      fixture.repo,
      "main-followup.txt",
      "advance without integrating candidate\n",
      "advance main without candidate",
    );
    const unmergedCheck = await checkWorkbenchSyncWorkflow({
      repoRoot: fixture.repo,
      dependencies: { repository: fixture.remote, fetcher: fakeFetcher("v0.9.3") },
    });
    expect(unmergedCheck.status).toBe("update-available");
    expect(unmergedCheck.retiredCandidate).toBeUndefined();

    const blockedCheckout = join(fixture.directory, "candidate-before-integration");
    git(fixture.repo, "worktree", "add", "--detach", blockedCheckout, "main");
    const blockedPrepare = await prepareWorkbenchCandidate({
      repoRoot: fixture.repo,
      checkout: blockedCheckout,
      baseSha: unmergedCheck.mainSha!,
      targetTag: "v0.9.3",
      targetSha: nextTargetSha,
      dependencies: { repository: fixture.remote },
    });
    expect(blockedPrepare.status).toBe("candidate-busy");
    expect(blockedPrepare.stage).toBe("another-active-candidate");

    git(fixture.repo, "merge", "--no-ff", firstCandidate.branch, "-m", "integrate first candidate");
    await writeFile(
      join(fixture.repo, "workbench/upstream.lock.json"),
      `${JSON.stringify(fixtureLock(fixture.targetSha, nextTargetSha, "v0.9.3", "v0.9.2"), null, 2)}\n`,
    );
    git(fixture.repo, "add", "--", "workbench/upstream.lock.json");
    git(fixture.repo, "commit", "-m", "record integrated upstream release");
    const integrationMainSha = git(fixture.repo, "rev-parse", "HEAD");

    const integratedCheck = await checkWorkbenchSyncWorkflow({
      repoRoot: fixture.repo,
      dependencies: { repository: fixture.remote, fetcher: fakeFetcher("v0.9.3") },
    });
    expect(integratedCheck.status, JSON.stringify(integratedCheck)).toBe("update-available");
    expect(integratedCheck.retiredCandidate).toEqual({
      candidateSha: firstCandidate.candidateSha,
      target: { tag: "v0.9.2", commit: fixture.targetSha },
      integrationMainSha,
    });
    const statePaths = await resolveRepositoryStatePaths(fixture.repo);
    const state = JSON.parse(await readFile(statePaths.stateFile, "utf8")) as {
      activeCandidate?: unknown;
    };
    expect(state.activeCandidate).toBeUndefined();
    const archived = JSON.parse(
      await readFile(join(statePaths.stateDirectory, "last-integrated-candidate.json"), "utf8"),
    ) as {
      activeCandidate: { candidateSha: string; target: { tag: string; commit: string } };
      integrationMainSha: string;
    };
    expect(archived.activeCandidate.candidateSha).toBe(firstCandidate.candidateSha);
    expect(archived.activeCandidate.target).toEqual({ tag: "v0.9.2", commit: fixture.targetSha });
    expect(archived.integrationMainSha).toBe(integrationMainSha);

    const nextCheckout = join(fixture.directory, "candidate-next-release");
    git(fixture.repo, "worktree", "add", "--detach", nextCheckout, "main");
    const nextPrepare = await prepareWorkbenchCandidate({
      repoRoot: fixture.repo,
      checkout: nextCheckout,
      baseSha: integratedCheck.mainSha!,
      targetTag: "v0.9.3",
      targetSha: nextTargetSha,
      dependencies: { repository: fixture.remote },
    });
    expect(nextPrepare.status).toBe("candidate-ready");
    expect(nextPrepare.target).toEqual({ tag: "v0.9.3", commit: nextTargetSha });
  }, 30_000);

  it("keeps failed automatic gates out of ready and records all fixed checks", async () => {
    const fixture = await makeFixture();
    const { prepare } = await checkedAndPrepared(fixture);
    let calls = 0;
    const verified = await verifyWorkbenchCandidate({
      repoRoot: fixture.repo,
      candidateSha: prepare.candidateSha!,
      dependencies: {
        readToolchain: () => toolchain,
        commandRunner: () => {
          calls += 1;
          return { exitCode: calls === 2 ? 1 : 0, stdout: "", stderr: "" };
        },
      },
    });
    expect(calls).toBe(AUTOMATIC_CHECKS.length);
    expect(verified.status).toBe("checks-failed");
    expect(verified.checks.map((check) => check.status)).toEqual([
      "passed",
      "failed",
      "passed",
      "passed",
      "passed",
      "passed",
    ]);
    expect((await statusWorkbenchSync({ repoRoot: fixture.repo })).status).toBe("checks-failed");
  });

  it("reports an appended candidate commit as needing bind without resetting the branch", async () => {
    const fixture = await makeFixture();
    const { baseSha } = await checkedAndPrepared(fixture);
    const appendedSha = await commitFile(
      fixture.checkout,
      "manual-review.txt",
      "retain this commit\n",
      "append candidate review commit",
    );
    const report = await prepareWorkbenchCandidate({
      repoRoot: fixture.repo,
      checkout: fixture.checkout,
      baseSha,
      targetTag: "v0.9.2",
      targetSha: fixture.targetSha,
      dependencies: { repository: fixture.remote },
    });
    expect(report.status).toBe("candidate-busy");
    expect(report.stage).toBe("candidate-rebind-required");
    expect(git(fixture.checkout, "rev-parse", "HEAD")).toBe(appendedSha);
    await expect(readFile(join(fixture.checkout, "manual-review.txt"), "utf8")).resolves.toBe(
      "retain this commit\n",
    );
  });

  // The composed Git fixture needs a 30s test budget matching its per-command Git timeout.
  it("invalidates candidate evidence when the checkout is dirty or the actual toolchain changes", async () => {
    const dirtyFixture = await makeFixture();
    const dirtyPrepared = await checkedAndPrepared(dirtyFixture);
    await writeFile(join(dirtyFixture.checkout, "untracked-review.txt"), "keep this change\n");
    const dirty = await verifyWorkbenchCandidate({
      repoRoot: dirtyFixture.repo,
      candidateSha: dirtyPrepared.prepare.candidateSha!,
      dependencies: { readToolchain: () => toolchain, commandRunner: () => allPassing() },
    });
    expect(dirty.status).toBe("candidate-stale");
    expect(dirty.stage).toBe("candidate-dirty");
    expect(await readFile(join(dirtyFixture.checkout, "untracked-review.txt"), "utf8")).toBe(
      "keep this change\n",
    );

    const toolchainFixture = await makeFixture();
    const toolchainPrepared = await checkedAndPrepared(toolchainFixture);
    const changedToolchain = await verifyWorkbenchCandidate({
      repoRoot: toolchainFixture.repo,
      candidateSha: toolchainPrepared.prepare.candidateSha!,
      dependencies: {
        readToolchain: () => ({ node: "24.13.0", bun: "1.4.2" }),
        commandRunner: () => allPassing(),
      },
    });
    expect(changedToolchain.status).toBe("candidate-stale");
    expect(changedToolchain.stage).toBe("toolchain-mismatch");
    expect(
      (
        await statusWorkbenchSync({
          repoRoot: toolchainFixture.repo,
          dependencies: { readToolchain: () => ({ node: "24.13.0", bun: "1.4.2" }) },
        })
      ).status,
    ).toBe("rebind-required");
  }, 30_000);

  it("refuses prepare when the official tag moved after the successful check", async () => {
    const fixture = await makeFixture();
    const check = await checkWorkbenchSyncWorkflow({
      repoRoot: fixture.repo,
      dependencies: { repository: fixture.remote, fetcher: fakeFetcher() },
    });
    expect(check.status).toBe("update-available");
    const movedSha = await commitFile(fixture.seed, "moved.txt", "moved\n", "move official tag");
    git(fixture.seed, "tag", "--force", "v0.9.2", movedSha);
    git(fixture.seed, "push", "--force", fixture.remote, "refs/tags/v0.9.2");
    const prepare = await prepareWorkbenchCandidate({
      repoRoot: fixture.repo,
      checkout: fixture.checkout,
      baseSha: check.mainSha!,
      targetTag: "v0.9.2",
      targetSha: fixture.targetSha,
      dependencies: { repository: fixture.remote },
    });
    expect(prepare.status).toBe("candidate-target-moved");
    expect(prepare.stage).toBe("official-tag-tag-moved");
    expect(git(fixture.checkout, "branch", "--show-current")).toBe("");
    expect(git(fixture.checkout, "rev-parse", "HEAD")).toBe(check.mainSha);
  });

  it("keeps a conflicting candidate merge open and reports conflict without cleanup", async () => {
    const fixture = await makeFixture(true);
    const check = await checkWorkbenchSyncWorkflow({
      repoRoot: fixture.repo,
      dependencies: { repository: fixture.remote, fetcher: fakeFetcher() },
    });
    const prepare = await prepareWorkbenchCandidate({
      repoRoot: fixture.repo,
      checkout: fixture.checkout,
      baseSha: check.mainSha!,
      targetTag: "v0.9.2",
      targetSha: fixture.targetSha,
      dependencies: { repository: fixture.remote },
    });
    expect(prepare.status).toBe("candidate-conflict");
    expect(git(fixture.checkout, "rev-parse", "MERGE_HEAD")).toBe(fixture.targetSha);
    expect(await readFile(join(fixture.checkout, "shared.txt"), "utf8")).toContain("<<<<<<<");
    const status = await statusWorkbenchSync({ repoRoot: fixture.repo });
    expect(status.status).toBe("conflict");
    expect(status.stage).toBe("merge-conflict-unresolved");
    expect(git(fixture.checkout, "rev-parse", "MERGE_HEAD")).toBe(fixture.targetSha);
  });

  it("accepts runtime evidence only when it binds all exact candidate and toolchain values", async () => {
    const fixture = await makeFixture();
    const { baseSha, prepare } = await checkedAndPrepared(fixture);
    const candidateSha = prepare.candidateSha!;
    const evidence = await runtimeEvidenceFor(fixture, candidateSha, baseSha);
    const evidencePath = join(fixture.directory, "runtime-evidence.json");
    await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
    const verified = await verifyWorkbenchCandidate({
      repoRoot: fixture.repo,
      candidateSha,
      runtimeEvidencePath: evidencePath,
      dependencies: { readToolchain: () => toolchain, commandRunner: () => allPassing() },
    });
    expect(verified.status).toBe("ready");
    expect(verified.runtimeEvidence.status).toBe("accepted");

    const incomplete = {
      ...evidence,
      checks: evidence.checks.filter((check) => check.id !== "migration-restore"),
    };
    await writeFile(evidencePath, `${JSON.stringify(incomplete, null, 2)}\n`);
    const incompleteRejected = await verifyWorkbenchCandidate({
      repoRoot: fixture.repo,
      candidateSha,
      runtimeEvidencePath: evidencePath,
      dependencies: { readToolchain: () => toolchain, commandRunner: () => allPassing() },
    });
    expect(incompleteRejected.status).toBe("awaiting-runtime");
    expect(incompleteRejected.runtimeEvidence.status).toBe("rejected");

    const wrong = { ...evidence, candidateSha: fixture.baseSha };
    await writeFile(evidencePath, `${JSON.stringify(wrong, null, 2)}\n`);
    const rejected = await verifyWorkbenchCandidate({
      repoRoot: fixture.repo,
      candidateSha,
      runtimeEvidencePath: evidencePath,
      dependencies: { readToolchain: () => toolchain, commandRunner: () => allPassing() },
    });
    expect(rejected.status).toBe("awaiting-runtime");
    expect(rejected.runtimeEvidence.status).toBe("rejected");
  });

  it("does not report ready when persisted automatic or runtime checks are incomplete", async () => {
    const fixture = await makeFixture();
    const { baseSha, prepare } = await checkedAndPrepared(fixture);
    const candidateSha = prepare.candidateSha!;
    const evidence = await runtimeEvidenceFor(fixture, candidateSha, baseSha);
    const evidencePath = join(fixture.directory, "runtime-evidence.json");
    await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
    const verified = await verifyWorkbenchCandidate({
      repoRoot: fixture.repo,
      candidateSha,
      runtimeEvidencePath: evidencePath,
      dependencies: { readToolchain: () => toolchain, commandRunner: () => allPassing() },
    });
    expect(verified.status).toBe("ready");

    const statePaths = await resolveRepositoryStatePaths(fixture.repo);
    const originalState = JSON.parse(await readFile(statePaths.stateFile, "utf8")) as {
      formatVersion: 1;
      activeCandidate: {
        automaticChecks: Array<{
          id: string;
          status: string;
          exitCode: number | null;
          durationMs: number;
        }>;
        runtimeEvidence: RuntimeEvidence;
        runtimeEvidenceHash: string;
      };
    };

    const missingAutomaticCheck = structuredClone(originalState);
    missingAutomaticCheck.activeCandidate.automaticChecks =
      missingAutomaticCheck.activeCandidate.automaticChecks.slice(1);
    await writeFile(statePaths.stateFile, `${JSON.stringify(missingAutomaticCheck, null, 2)}\n`);
    const automaticStatus = await statusWorkbenchSync({
      repoRoot: fixture.repo,
      dependencies: { readToolchain: () => toolchain },
    });
    expect(automaticStatus.status).toBe("rebind-required");
    expect(automaticStatus.invalidations).toContain("automatic-checks-incomplete-or-invalid");

    const oldRuntimeEvidence: RuntimeEvidence = {
      ...evidence,
      checks: [
        "codex-first-turn",
        "pi-first-turn",
        "recovery",
        "cancellation",
        "mcp",
        "session-isolation",
      ].map((id) => ({
        id,
        status: "passed",
        evidenceSha256: createHash("sha256").update(id).digest("hex"),
      })),
    };
    const oldRuntimeState = structuredClone(originalState);
    oldRuntimeState.activeCandidate.runtimeEvidence = oldRuntimeEvidence;
    oldRuntimeState.activeCandidate.runtimeEvidenceHash = createHash("sha256")
      .update(JSON.stringify(oldRuntimeEvidence))
      .digest("hex");
    await writeFile(statePaths.stateFile, `${JSON.stringify(oldRuntimeState, null, 2)}\n`);
    const runtimeStatus = await statusWorkbenchSync({
      repoRoot: fixture.repo,
      dependencies: { readToolchain: () => toolchain },
    });
    expect(runtimeStatus.status).toBe("rebind-required");
    expect(runtimeStatus.invalidations).toContain("runtime-evidence-schema-invalid");
  });

  it("invalidates previous evidence when main advances and safely rebinds merged candidate history", async () => {
    const fixture = await makeFixture();
    const { baseSha, prepare } = await checkedAndPrepared(fixture);
    const originalCandidateSha = prepare.candidateSha!;
    const evidencePath = join(fixture.directory, "runtime-evidence.json");
    await writeFile(
      evidencePath,
      `${JSON.stringify(await runtimeEvidenceFor(fixture, originalCandidateSha, baseSha), null, 2)}\n`,
    );
    const ready = await verifyWorkbenchCandidate({
      repoRoot: fixture.repo,
      candidateSha: originalCandidateSha,
      runtimeEvidencePath: evidencePath,
      dependencies: { readToolchain: () => toolchain, commandRunner: () => allPassing() },
    });
    expect(ready.status).toBe("ready");

    const advancedMain = await commitFile(
      fixture.repo,
      "main-followup.txt",
      "advance\n",
      "advance isolated main ref",
    );
    await checkWorkbenchSyncWorkflow({
      repoRoot: fixture.repo,
      dependencies: { repository: fixture.remote, fetcher: fakeFetcher() },
    });
    expect(
      (
        await statusWorkbenchSync({
          repoRoot: fixture.repo,
          dependencies: { readToolchain: () => toolchain },
        })
      ).status,
    ).toBe("rebind-required");
    const invalidated = await verifyWorkbenchCandidate({
      repoRoot: fixture.repo,
      candidateSha: originalCandidateSha,
      dependencies: { readToolchain: () => toolchain, commandRunner: () => allPassing() },
    });
    expect(invalidated.status).toBe("candidate-stale");
    expect(invalidated.stage).toBe("main-ref-advanced");
    const statePaths = await resolveRepositoryStatePaths(fixture.repo);
    const persisted = JSON.parse(await readFile(statePaths.stateFile, "utf8")) as {
      activeCandidate: { status: string; runtimeEvidence?: RuntimeEvidence };
    };
    expect(persisted.activeCandidate.status).toBe("rebind-required");
    expect(persisted.activeCandidate.runtimeEvidence).toBeUndefined();

    git(fixture.checkout, "merge", "--no-ff", "main", "-m", "merge newer main into sync candidate");
    const branch = git(fixture.checkout, "branch", "--show-current");
    await writeFile(
      join(fixture.checkout, "workbench/sync-candidate.json"),
      `${JSON.stringify(
        {
          formatVersion: 1,
          baseSha: advancedMain,
          target: { tag: "v0.9.2", commit: fixture.targetSha },
          branch,
        },
        null,
        2,
      )}\n`,
    );
    git(fixture.checkout, "add", "--", "workbench/sync-candidate.json");
    git(fixture.checkout, "commit", "-m", "record candidate identity metadata");
    const metadataSha = git(fixture.checkout, "rev-parse", "HEAD");

    const bind = await bindWorkbenchCandidate({
      repoRoot: fixture.repo,
      checkout: fixture.checkout,
      baseSha: advancedMain,
      targetTag: "v0.9.2",
      targetSha: fixture.targetSha,
      candidateSha: metadataSha,
      dependencies: { readToolchain: () => toolchain, repository: fixture.remote },
    });
    expect(bind.status).toBe("candidate-bound");
    expect(bind.baseSha).toBe(advancedMain);
    expect(bind.candidateSha).toBe(metadataSha);
    expect(
      (
        await statusWorkbenchSync({
          repoRoot: fixture.repo,
          dependencies: { readToolchain: () => toolchain },
        })
      ).status,
    ).toBe("awaiting-verification");
  });

  it("detects a crashed runner state that no longer matches the actual candidate HEAD", async () => {
    const fixture = await makeFixture();
    const { prepare } = await checkedAndPrepared(fixture);
    const paths = await resolveRepositoryStatePaths(fixture.repo);
    const state = JSON.parse(await readFile(paths.stateFile, "utf8")) as {
      activeCandidate: { candidateSha: string };
    };
    state.activeCandidate.candidateSha = fixture.baseSha;
    await writeFile(
      paths.stateFile,
      `${JSON.stringify({ formatVersion: 1, ...state }, null, 2)}\n`,
    );
    const status = await statusWorkbenchSync({
      repoRoot: fixture.repo,
      dependencies: { readToolchain: () => toolchain },
    });
    expect(status.status).toBe("rebind-required");
    const report = await verifyWorkbenchCandidate({
      repoRoot: fixture.repo,
      candidateSha: prepare.candidateSha!,
      dependencies: { readToolchain: () => toolchain, commandRunner: () => allPassing() },
    });
    expect(report.status).toBe("candidate-stale");
  });
});

describe("workbench sync repository lock", () => {
  it("makes concurrent mutating operations mutually exclusive", async () => {
    const fixture = await makeFixture();
    const started = deferred<void>();
    const held = deferred<void>();
    const first = withRepositoryLock(fixture.repo, "first-test", async () => {
      started.resolve();
      await held.promise;
    });
    await started.promise;
    await expect(
      withRepositoryLock(fixture.repo, "second-test", async () => undefined),
    ).rejects.toMatchObject({
      name: "RepositoryLockError",
      state: "busy",
    });
    held.resolve();
    await first;
    const paths = await resolveRepositoryStatePaths(fixture.repo);
    await expect(readRepositoryLockStatus(paths.lockDirectory)).resolves.toEqual({
      status: "unlocked",
    });
  });

  it("does not reclaim a lock with an untrusted or cross-host owner", async () => {
    const fixture = await makeFixture();
    const paths = await resolveRepositoryStatePaths(fixture.repo);
    await mkdir(paths.lockDirectory, { recursive: true });
    await writeFile(
      join(paths.lockDirectory, "owner.json"),
      `${JSON.stringify({
        formatVersion: 1,
        token: "remote-owner-token",
        operation: "weekly-sync",
        pid: 999_999_999,
        host: "another-host",
        startedAt: "2026-09-30T00:00:00Z",
      })}\n`,
    );
    await expect(
      withRepositoryLock(fixture.repo, "test", async () => undefined),
    ).rejects.toMatchObject({
      name: "RepositoryLockError",
      state: "busy",
    });
    await expect(readRepositoryLockStatus(paths.lockDirectory)).resolves.toEqual({
      status: "locked",
      operation: "weekly-sync",
    });
  });

  it("reclaims a same-host dead PID only after rechecking the owner token and directory", async () => {
    const fixture = await makeFixture();
    const paths = await resolveRepositoryStatePaths(fixture.repo);
    await mkdir(paths.lockDirectory, { recursive: true });
    await writeFile(
      join(paths.lockDirectory, "owner.json"),
      `${JSON.stringify({
        formatVersion: 1,
        token: "dead-owner-token",
        operation: "interrupted-verify",
        pid: 2_147_483_647,
        host: hostname(),
        startedAt: "2026-09-30T00:00:00Z",
      })}\n`,
    );
    await withRepositoryLock(fixture.repo, "recovered-test", async () => {
      await expect(readRepositoryLockStatus(paths.lockDirectory)).resolves.toEqual({
        status: "locked",
        operation: "recovered-test",
      });
    });
    await expect(readRepositoryLockStatus(paths.lockDirectory)).resolves.toEqual({
      status: "unlocked",
    });
  });
});
