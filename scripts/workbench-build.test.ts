import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runGit } from "./lib/workbench-sync/git.ts";
import {
  buildWorkbenchArtifact,
  type WorkbenchBuildFlavor,
  type WorkbenchBuildRequest,
} from "./lib/workbench-build.ts";
import { expectedCandidateBranch } from "./lib/workbench-sync/sync.ts";

const temporaryDirectories: string[] = [];
const OFFICIAL_REPOSITORY = "https://github.com/Emanuele-web04/synara.git";
const toolchain = { node: "24.13.1", bun: "1.4.2" };
const BUILD_CONFIG = {
  formatVersion: 1,
  versions: { workbench: "0.1.0", "workbench-preview": "0.1.0-preview.1" },
};

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function git(cwd: string, ...args: string[]): string {
  const result = runGit(cwd, args, 30_000);
  if (!result.ok) throw new Error(`git ${args[0]} failed (${result.exitCode ?? "unknown"})`);
  return result.stdout.trim();
}

function commitFile(repo: string, file: string, content: string, message: string): string {
  const path = join(repo, file);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
  git(repo, "add", "--", file);
  git(repo, "commit", "-m", message);
  return git(repo, "rev-parse", "HEAD");
}

type BuildFixture = {
  readonly directory: string;
  readonly remote: string;
  readonly repo: string;
  readonly baseSha: string;
  readonly candidateSha: string;
  readonly sourceSha: string;
};

function makeFixture(): BuildFixture {
  const directory = mkdtempSync(join(tmpdir(), "synara-workbench-build-"));
  temporaryDirectories.push(directory);
  const seed = join(directory, "official-seed");
  const remote = join(directory, "official.git");
  const repo = join(directory, "source");
  git(directory, "init", "--bare", remote);
  git(directory, "init", "-b", "main", seed);
  git(seed, "config", "user.name", "Workbench Build Test");
  git(seed, "config", "user.email", "workbench-build-test@example.invalid");
  const baseSha = commitFile(seed, "upstream-base.txt", "base\n", "official base");
  git(seed, "tag", "v0.9.1", baseSha);
  const candidateSha = commitFile(seed, "upstream-release.txt", "release\n", "official candidate");
  git(seed, "tag", "v0.9.2", candidateSha);
  git(seed, "push", remote, "main", "--tags");

  git(directory, "clone", "--no-checkout", remote, repo);
  git(repo, "config", "user.name", "Workbench Build Test");
  git(repo, "config", "user.email", "workbench-build-test@example.invalid");
  git(repo, "switch", "-C", "main", baseSha);
  mkdirSync(join(repo, "workbench"), { recursive: true });
  mkdirSync(join(repo, "apps/server/src/persistence"), { recursive: true });
  mkdirSync(join(repo, "apps/server/src/workbench/persistence"), { recursive: true });
  writeFileSync(
    join(repo, "workbench/upstream.lock.json"),
    `${JSON.stringify(
      {
        formatVersion: 1,
        repository: OFFICIAL_REPOSITORY,
        branch: "main",
        updateChannel: "latest-stable-release",
        integrationStrategy: "merge",
        integratedBase: { tag: "v0.9.1", commit: baseSha },
        candidate: { tag: "v0.9.2", commit: candidateSha, status: "not-yet-integrated" },
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(
    join(repo, "workbench/build-config.json"),
    `${JSON.stringify(BUILD_CONFIG, null, 2)}\n`,
  );
  writeFileSync(join(repo, ".mise.toml"), '[tools]\nnode = "24.13.1"\nbun = "1.4.2"\n');
  writeFileSync(join(repo, "bun.lock"), '{"lockfileVersion":1}\n');
  writeFileSync(
    join(repo, "apps/server/src/persistence/Migrations.ts"),
    [
      "export const migrationEntries = [",
      '  [1, "First", {}],',
      '  [108, "Current", {}],',
      '  [109, "ProjectionThreadsExpertBinding", {}],',
      '  [110, "NewOfficialMigration", {}],',
      "] as const;",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(repo, "apps/server/src/workbench/persistence/WorkbenchMigrations.ts"),
    [
      "export const LEGACY_EXPERT_OFFICIAL_MIGRATIONS = [",
      '  { officialId: 109, officialName: "ProjectionThreadsExpertBinding", workbenchId: 1 },',
      '  { officialId: 110, officialName: "ExpertAppliedRuntimeRecords", workbenchId: 2 },',
      "] as const;",
      "export const WORKBENCH_SCHEMA_FORMAT_VERSION = 1;",
      "export const workbenchMigrationEntries: readonly WorkbenchMigrationDefinition[] = [",
      `  { moduleId: "expert", migrationId: 1, name: "First", checksum: "sha256:${"a".repeat(64)}", statement: "SELECT 1" },`,
      `  { moduleId: "expert", migrationId: 2, name: "Second", checksum: "sha256:${"b".repeat(64)}", statement: "SELECT 2" },`,
      `  { moduleId: "other", migrationId: 1, name: "First", checksum: "sha256:${"c".repeat(64)}", statement: "SELECT 3" },`,
      "];",
      'const migrationIdHelper = { moduleId: "fixture", migrationId: 99 };',
      "",
    ].join("\n"),
  );
  git(
    repo,
    "add",
    "--",
    "workbench",
    ".mise.toml",
    "bun.lock",
    "apps/server/src/persistence/Migrations.ts",
    "apps/server/src/workbench/persistence/WorkbenchMigrations.ts",
  );
  git(repo, "commit", "-m", "create clean workbench source fixture");
  return {
    directory,
    remote,
    repo,
    baseSha,
    candidateSha,
    sourceSha: git(repo, "rev-parse", "HEAD"),
  };
}

function requestFor(
  fixture: BuildFixture,
  flavor: WorkbenchBuildFlavor = "workbench",
  outputName = "artifact-output",
): WorkbenchBuildRequest {
  return {
    repoRoot: fixture.repo,
    flavor,
    sourceSha: fixture.sourceSha,
    platform: "linux",
    arch: "x64",
    outputDir: join(fixture.directory, outputName),
    upstreamTag: "v0.9.1",
    upstreamSha: fixture.baseSha,
  };
}

function commitCandidateSource(
  fixture: BuildFixture,
  tag: string,
  targetSha: string,
  options: { readonly allowUnrelatedHistories?: boolean; readonly fetchTag?: boolean } = {},
): string {
  const branch = expectedCandidateBranch(tag, targetSha);
  git(fixture.repo, "switch", "-c", branch);
  if (options.fetchTag !== false) {
    git(fixture.repo, "fetch", fixture.remote, `+refs/tags/${tag}:refs/tags/${tag}`);
  }
  git(
    fixture.repo,
    "merge",
    "--no-ff",
    ...(options.allowUnrelatedHistories ? ["--allow-unrelated-histories"] : []),
    targetSha,
    "-m",
    `merge official ${tag}`,
  );
  commitFile(
    fixture.repo,
    "workbench/sync-candidate.json",
    `${JSON.stringify(
      {
        formatVersion: 1,
        baseSha: fixture.sourceSha,
        target: { tag, commit: targetSha },
        branch,
      },
      null,
      2,
    )}\n`,
    "record candidate identity metadata",
  );
  return git(fixture.repo, "rev-parse", "HEAD");
}

const fakeBuilder = {
  readToolchain: () => toolchain,
  runBuilder: (_repo: string, args: readonly string[]) => {
    const outputDir = args[args.indexOf("--output-dir") + 1]!;
    writeFileSync(join(outputDir, "Personal Workbench.AppImage"), "artifact bytes");
    writeFileSync(join(outputDir, "latest-linux.yml"), "version: 0.1.0\n");
    return { status: 0 };
  },
};

describe("workbench build manifest", () => {
  it.each([
    ["workbench", "0.1.0"],
    ["workbench-preview", "0.1.0-preview.1"],
  ] as const)(
    "records the independent %s version and exact artifact evidence",
    async (flavor, version) => {
      const fixture = makeFixture();
      const result = await buildWorkbenchArtifact(requestFor(fixture, flavor), fakeBuilder);
      const artifactBytes = "artifact bytes";

      expect(result.manifest.status).toBe("diagnostic-build-only");
      expect(result.manifest.readiness).toEqual({
        automaticChecks: "not-run",
        runtimeEvidence: "not-run",
        publication: "not-performed",
      });
      expect(result.manifest.formatVersion).toBe(1);
      expect(result.manifest.source).toEqual({
        commit: fixture.sourceSha,
        flavor,
        version,
      });
      expect(result.manifest.upstream).toMatchObject({
        repository: OFFICIAL_REPOSITORY,
        tag: "v0.9.1",
        commit: fixture.baseSha,
        selection: "explicit-lock-match",
      });
      expect(result.manifest.build).toMatchObject({
        platform: "linux",
        arch: "x64",
        target: "AppImage",
        node: toolchain.node,
        bun: toolchain.bun,
      });
      expect(result.manifest.schemas).toEqual({
        officialMigrationHighWater: 110,
        workbenchMigrationHighWaterByModule: { expert: 2, other: 1 },
        workbenchSchemaFormatVersion: 1,
      });
      expect(result.manifest.lockfileHashes.bunLock).toMatch(/^[0-9a-f]{64}$/u);
      expect(result.manifest.artifactProvenance.signing).toMatchObject({
        status: "not-applicable",
      });
      expect(result.manifest.artifactProvenance.artifacts).toContainEqual({
        fileName: "Personal Workbench.AppImage",
        size: Buffer.byteLength(artifactBytes),
        sha256: createHash("sha256").update(artifactBytes).digest("hex"),
      });
      expect(JSON.parse(readFileSync(result.manifestPath, "utf8"))).toEqual(result.manifest);
      expect(readFileSync(result.provenancePath, "utf8")).toContain("Personal Workbench.AppImage");
    },
  );

  it("refuses a dirty source tree and an explicit source SHA that differs from HEAD", async () => {
    const fixture = makeFixture();
    writeFileSync(join(fixture.repo, "uncommitted.txt"), "local change\n");
    await expect(buildWorkbenchArtifact(requestFor(fixture), fakeBuilder)).rejects.toThrow(
      "source-worktree-is-not-clean",
    );
    rmSync(join(fixture.repo, "uncommitted.txt"));

    await expect(
      buildWorkbenchArtifact(
        { ...requestFor(fixture), sourceSha: fixture.candidateSha },
        fakeBuilder,
      ),
    ).rejects.toThrow("source-sha-does-not-match-current-head");
  });

  it("refuses a locked upstream target that is not an ancestor of the exact source", async () => {
    const fixture = makeFixture();
    await expect(
      buildWorkbenchArtifact(
        {
          ...requestFor(fixture),
          upstreamTag: "v0.9.2",
          upstreamSha: fixture.candidateSha,
        },
        fakeBuilder,
      ),
    ).rejects.toThrow("upstream-target-is-not-an-ancestor-of-source");
  });

  it("builds from committed metadata for a newer official release beyond the stale lock candidate", async () => {
    const fixture = makeFixture();
    const nextTargetSha = commitFile(
      join(fixture.directory, "official-seed"),
      "release-next.txt",
      "next release\n",
      "next stable release",
    );
    git(join(fixture.directory, "official-seed"), "tag", "v0.9.3", nextTargetSha);
    git(join(fixture.directory, "official-seed"), "push", fixture.remote, "main", "--tags");
    const sourceSha = commitCandidateSource(fixture, "v0.9.3", nextTargetSha);
    const { upstreamTag: _tag, upstreamSha: _sha, ...metadataRequest } = requestFor(fixture);

    const result = await buildWorkbenchArtifact(
      { ...metadataRequest, sourceSha, outputDir: join(fixture.directory, "next-release-output") },
      { ...fakeBuilder, repository: fixture.remote },
    );

    expect(result.manifest.source.commit).toBe(sourceSha);
    expect(result.manifest.upstream).toMatchObject({
      tag: "v0.9.3",
      commit: nextTargetSha,
      selection: "candidate-metadata",
    });
  });

  it("refuses candidate metadata whose claimed official tag is missing before invoking the builder", async () => {
    const fixture = makeFixture();
    const sourceSha = commitCandidateSource(fixture, "v0.9.3", fixture.candidateSha, {
      fetchTag: false,
    });
    const { upstreamTag: _tag, upstreamSha: _sha, ...metadataRequest } = requestFor(fixture);
    let builderCalled = false;

    await expect(
      buildWorkbenchArtifact(
        { ...metadataRequest, sourceSha, outputDir: join(fixture.directory, "fake-tag-output") },
        {
          ...fakeBuilder,
          repository: fixture.remote,
          runBuilder: (repoRoot, args) => {
            builderCalled = true;
            return fakeBuilder.runBuilder(repoRoot, args);
          },
        },
      ),
    ).rejects.toThrow("candidate-metadata-official-tag-tag-missing");
    expect(builderCalled).toBe(false);
  });

  it("keeps explicit upstream parameters restricted to the versioned lock without metadata", async () => {
    const fixture = makeFixture();

    await expect(
      buildWorkbenchArtifact(
        {
          ...requestFor(fixture),
          upstreamTag: "v0.9.3",
          upstreamSha: fixture.candidateSha,
        },
        fakeBuilder,
      ),
    ).rejects.toThrow("explicit-upstream-target-does-not-match-versioned-lock");
  });

  it("rejects committed metadata for an official target that diverges from integratedBase", async () => {
    const fixture = makeFixture();
    const seed = join(fixture.directory, "official-seed");
    git(seed, "switch", "--orphan", "older-release");
    const divergentSha = commitFile(
      seed,
      "older-release.txt",
      "older\n",
      "older divergent release",
    );
    git(seed, "tag", "v0.9.0", divergentSha);
    git(seed, "push", fixture.remote, "v0.9.0");
    const sourceSha = commitCandidateSource(fixture, "v0.9.0", divergentSha, {
      allowUnrelatedHistories: true,
    });
    const { upstreamTag: _tag, upstreamSha: _sha, ...metadataRequest } = requestFor(fixture);

    await expect(
      buildWorkbenchArtifact(
        {
          ...metadataRequest,
          sourceSha,
          outputDir: join(fixture.directory, "divergent-release-output"),
        },
        { ...fakeBuilder, repository: fixture.remote },
      ),
    ).rejects.toThrow("upstream-target-is-older-or-diverges-from-integrated-base");
  });
});
