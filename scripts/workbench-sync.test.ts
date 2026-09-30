import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runGit } from "./lib/workbench-sync/git.ts";
import { fetchLatestStableRelease, type ReleaseFetcher } from "./lib/workbench-sync/releases.ts";
import {
  checkWorkbenchSync,
  prepareCandidate,
  type WorkbenchSyncLock,
} from "./lib/workbench-sync/sync.ts";

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
  const directory = await mkdtemp(join(tmpdir(), `synara-sync-${prefix}-`));
  temporaryDirectories.push(directory);
  return directory;
}

function git(cwd: string, ...args: string[]): string {
  const result = runGit(cwd, args, 30_000);
  if (!result.ok) throw new Error(`git ${args[0]} failed (${result.exitCode ?? "unknown"})`);
  return result.stdout.trim();
}

async function initRepo(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
  git(path, "init", "-b", "main");
  git(path, "config", "user.name", "Workbench Test");
  git(path, "config", "user.email", "workbench-test@example.invalid");
}

async function commitFile(
  repo: string,
  file: string,
  contents: string,
  message: string,
): Promise<string> {
  await writeFile(join(repo, file), contents);
  git(repo, "add", "--", file);
  git(repo, "commit", "-m", message);
  return git(repo, "rev-parse", "HEAD");
}

async function releaseRepo(): Promise<{
  readonly directory: string;
  readonly remote: string;
  readonly checkout: string;
  readonly seed: string;
  readonly baseSha: string;
  readonly candidateSha: string;
}> {
  const directory = await tempDirectory("release");
  const remote = join(directory, "upstream.git");
  const seed = join(directory, "seed");
  git(directory, "init", "--bare", remote);
  await initRepo(seed);
  const baseSha = await commitFile(seed, "base.txt", "base\n", "base release");
  git(seed, "tag", "v0.9.1", baseSha);
  const candidateSha = await commitFile(seed, "feature.txt", "feature\n", "stable release");
  git(seed, "tag", "v0.9.2", candidateSha);
  git(seed, "push", remote, "main", "--tags");
  const repository = join(directory, "checkout");
  await initRepo(repository);
  return { directory, remote, checkout: repository, seed, baseSha, candidateSha };
}

function makeLock(baseSha: string, candidateSha: string): WorkbenchSyncLock {
  return {
    formatVersion: 1,
    repository: OFFICIAL_REPOSITORY,
    branch: "main",
    updateChannel: "latest-stable-release",
    integrationStrategy: "merge",
    integratedBase: { tag: "v0.9.1", commit: baseSha },
    candidate: { tag: "v0.9.2", commit: candidateSha, status: "not-yet-integrated" },
  };
}

function fakeFetcher(body: unknown): ReleaseFetcher {
  return async () => new Response(JSON.stringify(body), { status: 200 });
}

function stableRelease(tag: string, publishedAt = "2026-09-20T00:00:00Z") {
  return { draft: false, prerelease: false, tag_name: tag, published_at: publishedAt };
}

describe("workbench sync release selection", () => {
  it("filters draft and prerelease entries and chooses the newest published stable release", async () => {
    const pages = [
      [
        {
          draft: true,
          prerelease: false,
          tag_name: "v9.9.0",
          published_at: "2026-09-30T00:00:00Z",
        },
        {
          draft: false,
          prerelease: true,
          tag_name: "v9.9.0-beta.1",
          published_at: "2026-09-29T00:00:00Z",
        },
        ...Array.from({ length: 98 }, (_, index) => ({
          draft: true,
          prerelease: false,
          tag_name: `draft-${index}`,
          published_at: "2026-09-28T00:00:00Z",
        })),
      ],
      [
        stableRelease("v0.9.2", "2026-09-22T00:00:00Z"),
        stableRelease("v0.9.1", "2026-09-21T00:00:00Z"),
      ],
    ];
    const requested: string[] = [];
    const fetcher: ReleaseFetcher = async (input) => {
      requested.push(String(input));
      const page = Number(new URL(String(input)).searchParams.get("page"));
      return new Response(JSON.stringify(pages[page - 1] ?? []), { status: 200 });
    };

    const release = await fetchLatestStableRelease(fetcher);

    expect(release).toEqual({ tag: "v0.9.2", publishedAt: "2026-09-22T00:00:00.000Z" });
    expect(requested).toHaveLength(2);
  });

  it("does not treat an unpublished timestamp as the release publication time", async () => {
    const release = await fetchLatestStableRelease(
      fakeFetcher([
        {
          draft: false,
          prerelease: false,
          tag_name: "v9.9.0",
          published_at: null,
          created_at: "2026-09-30T00:00:00Z",
        },
        stableRelease("v0.9.2", "2026-09-22T00:00:00Z"),
      ]),
    );

    expect(release).toEqual({ tag: "v0.9.2", publishedAt: "2026-09-22T00:00:00.000Z" });
  });
});

describe("workbench sync check", () => {
  it("reports no-update separately when latest stable is the integrated base", async () => {
    const fixture = await releaseRepo();
    const report = await checkWorkbenchSync({
      repoRoot: fixture.checkout,
      repository: fixture.remote,
      lock: makeLock(fixture.baseSha, fixture.candidateSha),
      fetcher: fakeFetcher([stableRelease("v0.9.1")]),
    });

    expect(report.status).toBe("no-update");
    expect(report.release?.commit).toBe(fixture.baseSha);
  });

  it("reports a descendant stable release as available", async () => {
    const fixture = await releaseRepo();
    const report = await checkWorkbenchSync({
      repoRoot: fixture.checkout,
      repository: fixture.remote,
      lock: makeLock(fixture.baseSha, fixture.candidateSha),
      fetcher: fakeFetcher([stableRelease("v0.9.2")]),
    });

    expect(report.status).toBe("update-available");
    expect(report.release?.commit).toBe(fixture.candidateSha);
  });

  it("reports a divergent stable release as blocked", async () => {
    const fixture = await releaseRepo();
    git(fixture.seed, "switch", "--orphan", "unrelated");
    const divergentSha = await commitFile(
      fixture.seed,
      "other.txt",
      "other\n",
      "unrelated release",
    );
    git(fixture.seed, "tag", "v1.0.0", divergentSha);
    git(fixture.seed, "push", fixture.remote, "v1.0.0");
    const report = await checkWorkbenchSync({
      repoRoot: fixture.checkout,
      repository: fixture.remote,
      lock: makeLock(fixture.baseSha, fixture.candidateSha),
      fetcher: fakeFetcher([stableRelease("v1.0.0", "2026-09-30T00:00:00Z")]),
    });

    expect(report.status).toBe("selection-blocked");
    expect(report.reason).toBe("release-target-diverged");
  });

  it("reports a stable release behind the integrated base as a rollback", async () => {
    const fixture = await releaseRepo();
    const lock = {
      ...makeLock(fixture.candidateSha, fixture.candidateSha),
      integratedBase: { tag: "v0.9.2", commit: fixture.candidateSha },
    };
    const report = await checkWorkbenchSync({
      repoRoot: fixture.checkout,
      repository: fixture.remote,
      lock,
      fetcher: fakeFetcher([stableRelease("v0.9.1", "2026-09-30T00:00:00Z")]),
    });

    expect(report.status).toBe("selection-blocked");
    expect(report.reason).toBe("release-target-behind-integrated-base");
  });

  it("blocks when a previously locked tag now resolves to another commit", async () => {
    const fixture = await releaseRepo();
    const movedSha = await commitFile(fixture.seed, "moved.txt", "moved\n", "moved candidate tag");
    git(fixture.seed, "tag", "-f", "v0.9.2", movedSha);
    git(fixture.seed, "push", "--force", fixture.remote, "refs/tags/v0.9.2");
    const report = await checkWorkbenchSync({
      repoRoot: fixture.checkout,
      repository: fixture.remote,
      lock: makeLock(fixture.baseSha, fixture.candidateSha),
      fetcher: fakeFetcher([stableRelease("v0.9.2")]),
    });

    expect(report.status).toBe("selection-blocked");
    expect(report.reason).toBe("locked-tag-moved");
  });

  it("reports network failure distinctly and offers a retry action", async () => {
    const fixture = await releaseRepo();
    const report = await checkWorkbenchSync({
      repoRoot: fixture.checkout,
      repository: fixture.remote,
      lock: makeLock(fixture.baseSha, fixture.candidateSha),
      fetcher: async () => {
        throw new TypeError("network unavailable");
      },
    });

    expect(report.status).toBe("network-failure");
    expect(report.retryAction).toBe("rerun-workbench-sync-check");
    expect(JSON.stringify(report)).not.toContain("network unavailable");
  });

  it("does not mislabel ancestry as divergent when the fetched source is shallow", async () => {
    const fixture = await releaseRepo();
    const shallowRemote = join(fixture.directory, "shallow-upstream.git");
    git(fixture.directory, "init", "--bare", shallowRemote);
    git(
      shallowRemote,
      "fetch",
      "--depth=1",
      `file://${fixture.remote}`,
      "+refs/tags/v0.9.1:refs/tags/v0.9.1",
      "+refs/tags/v0.9.2:refs/tags/v0.9.2",
    );
    const report = await checkWorkbenchSync({
      repoRoot: fixture.checkout,
      repository: shallowRemote,
      lock: makeLock(fixture.baseSha, fixture.candidateSha),
      fetcher: fakeFetcher([stableRelease("v0.9.2")]),
    });

    expect(report.status).toBe("selection-blocked");
    expect(report.reason).toBe("history-incomplete");
  });
});

describe("workbench sync prepare", () => {
  async function prepareRepo(conflict: boolean) {
    const directory = await tempDirectory(conflict ? "conflict" : "merge");
    const repo = join(directory, "repo");
    await initRepo(repo);
    const commonSha = await commitFile(repo, "shared.txt", "base\n", "base");
    const baseSha = conflict
      ? await commitFile(repo, "shared.txt", "local change\n", "expert change")
      : commonSha;
    const targetBranch = conflict ? "upstream/conflict" : "upstream/target";
    git(repo, "switch", "-c", targetBranch, commonSha);
    const targetSha = await commitFile(
      repo,
      conflict ? "shared.txt" : "upstream.txt",
      conflict ? "upstream change\n" : "upstream addition\n",
      "upstream target",
    );
    git(repo, "switch", "--detach", baseSha);
    return { directory, repo, commonSha, baseSha, targetSha };
  }

  it("performs a real merge and reuses the exact candidate on repeat", async () => {
    const fixture = await prepareRepo(false);
    const input = {
      checkout: fixture.repo,
      baseSha: fixture.baseSha,
      targetTag: "v0.9.2",
      targetSha: fixture.targetSha,
    };
    const first = prepareCandidate(input);
    const firstHead = git(fixture.repo, "rev-parse", "HEAD");
    const parents = git(fixture.repo, "show", "-s", "--format=%P", firstHead).split(/\s+/);
    const second = prepareCandidate(input);

    expect(first.status).toBe("candidate-ready");
    expect(first.mergeCommitSha).toBe(firstHead);
    expect(parents).toEqual([fixture.baseSha, fixture.targetSha]);
    expect(second.status).toBe("candidate-ready");
    expect(second.mergeCommitSha).toBe(firstHead);
    expect(first.exitCode).toBeNull();
  });

  it("reports a missing exact target object with its prepare stage and Git exit code", async () => {
    const fixture = await prepareRepo(false);
    const report = prepareCandidate({
      checkout: fixture.repo,
      baseSha: fixture.baseSha,
      targetTag: "v0.9.2",
      targetSha: "0000000000000000000000000000000000000000",
    });

    expect(report.status).toBe("candidate-target-missing");
    expect(report.stage).toBe("target-object-check");
    expect(report.exitCode).not.toBeNull();
    expect(report.target.commit).toBe("0000000000000000000000000000000000000000");
  });

  it("does not reuse a prepared SHA when the checkout becomes dirty or HEAD advances", async () => {
    const fixture = await prepareRepo(false);
    const input = {
      checkout: fixture.repo,
      baseSha: fixture.baseSha,
      targetTag: "v0.9.2",
      targetSha: fixture.targetSha,
    };
    const prepared = prepareCandidate(input);
    expect(prepared.status).toBe("candidate-ready");

    await writeFile(join(fixture.repo, "manual.txt"), "manual edit\n");
    const dirty = prepareCandidate(input);
    expect(dirty.status).toBe("candidate-dirty");
    expect(
      await import("node:fs/promises").then(({ readFile }) =>
        readFile(join(fixture.repo, "manual.txt"), "utf8"),
      ),
    ).toBe("manual edit\n");

    git(fixture.repo, "add", "--", "manual.txt");
    git(fixture.repo, "commit", "-m", "manual follow-up");
    const advanced = prepareCandidate(input);
    expect(advanced.status).toBe("candidate-busy");
    expect(advanced.mergeCommitSha).toBe(prepared.mergeCommitSha);
  });

  it("leaves merge conflicts and later human resolution untouched", async () => {
    const fixture = await prepareRepo(true);
    const input = {
      checkout: fixture.repo,
      baseSha: fixture.baseSha,
      targetTag: "v0.9.2",
      targetSha: fixture.targetSha,
    };
    const first = prepareCandidate(input);
    const unresolved = await import("node:fs/promises").then(({ readFile }) =>
      readFile(join(fixture.repo, "shared.txt"), "utf8"),
    );
    const second = prepareCandidate(input);

    expect(first.status).toBe("candidate-conflict");
    expect(first.conflictFiles).toEqual(["shared.txt"]);
    expect(first.stage).toBe("git-merge");
    expect(first.exitCode).not.toBeNull();
    expect(unresolved).toContain("<<<<<<<");
    expect(second.status).toBe("candidate-conflict");
    expect(second.stage).toBe("existing-merge");
    expect(second.exitCode).toBeNull();
    expect(second.conflictFiles).toEqual(["shared.txt"]);

    await writeFile(join(fixture.repo, "shared.txt"), "human resolution\n");
    const repairedInProgress = prepareCandidate(input);
    expect(repairedInProgress.status).toBe("candidate-conflict");
    expect(
      await import("node:fs/promises").then(({ readFile }) =>
        readFile(join(fixture.repo, "shared.txt"), "utf8"),
      ),
    ).toBe("human resolution\n");
    git(fixture.repo, "add", "--", "shared.txt");
    git(fixture.repo, "commit", "--no-edit", "-m", "resolve merge conflict");
    const resolvedHead = git(fixture.repo, "rev-parse", "HEAD");
    const third = prepareCandidate(input);

    expect(third.status).toBe("candidate-ready");
    expect(third.mergeCommitSha).toBe(resolvedHead);
    await expect(
      import("node:fs/promises").then(({ readFile }) =>
        readFile(join(fixture.repo, "shared.txt"), "utf8"),
      ),
    ).resolves.toBe("human resolution\n");
  });

  it("refuses a matching in-progress merge when its base or branch is not the requested candidate", async () => {
    const fixture = await prepareRepo(true);
    const input = {
      checkout: fixture.repo,
      baseSha: fixture.baseSha,
      targetTag: "v0.9.2",
      targetSha: fixture.targetSha,
    };
    const started = prepareCandidate(input);
    const conflictedContents = await import("node:fs/promises").then(({ readFile }) =>
      readFile(join(fixture.repo, "shared.txt"), "utf8"),
    );

    const wrongBase = prepareCandidate({ ...input, baseSha: fixture.commonSha });
    expect(wrongBase.status).toBe("candidate-busy");
    expect(wrongBase.stage).toBe("existing-merge-validation");

    git(fixture.repo, "branch", "-m", "codex/unexpected-candidate");
    const wrongBranch = prepareCandidate(input);
    expect(wrongBranch.status).toBe("candidate-busy");
    expect(wrongBranch.stage).toBe("existing-merge-validation");
    expect(started.status).toBe("candidate-conflict");
    await expect(
      import("node:fs/promises").then(({ readFile }) =>
        readFile(join(fixture.repo, "shared.txt"), "utf8"),
      ),
    ).resolves.toBe(conflictedContents);
    expect(git(fixture.repo, "rev-parse", "--verify", "MERGE_HEAD")).toBe(fixture.targetSha);
  });

  it("refuses a dirty candidate without creating a branch or merge", async () => {
    const fixture = await prepareRepo(false);
    await writeFile(join(fixture.repo, "untracked.txt"), "keep me\n");
    const report = prepareCandidate({
      checkout: fixture.repo,
      baseSha: fixture.baseSha,
      targetTag: "v0.9.2",
      targetSha: fixture.targetSha,
    });

    expect(report.status).toBe("candidate-dirty");
    expect(git(fixture.repo, "rev-parse", "--abbrev-ref", "HEAD")).toBe("HEAD");
    expect(git(fixture.repo, "status", "--porcelain=v1")).toContain("untracked.txt");
  });
});
