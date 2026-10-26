import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createSkillPackageStore } from "./SkillPackageStore.ts";
import { expertResourceFiles } from "./ExpertStore.ts";

vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  return { ...actual, rename: vi.fn(actual.rename), rm: vi.fn(actual.rm) };
});

const roots: string[] = [];
async function fixture() {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "synara-skill-packages-")));
  roots.push(root);
  const stateDir = path.join(root, "state");
  const source = path.join(root, "bmad");
  await mkdir(path.join(source, "skills", "pm"), { recursive: true });
  await mkdir(path.join(source, "skills", "prd"), { recursive: true });
  await mkdir(path.join(source, "modules"));
  await writeFile(
    path.join(source, "skills", "pm", "SKILL.md"),
    "---\nname: bmad-pm\ndescription: PM role\n---\nRead ../../modules/config.yaml\n",
  );
  await writeFile(
    path.join(source, "skills", "prd", "SKILL.md"),
    "---\nname: bmad-prd\ndescription: Draft a PRD\n---\nWorkflow\n",
  );
  await writeFile(path.join(source, "modules", "config.yaml"), "language: zh\n");
  await writeFile(path.join(source, "run.sh"), "#!/bin/sh\necho must-not-run > SENTINEL\n");
  await chmod(path.join(source, "run.sh"), 0o700);
  return { root, source, stateDir, store: createSkillPackageStore(stateDir) };
}

async function unlock(entry: string): Promise<void> {
  const stat = await lstat(entry);
  if (stat.isSymbolicLink()) return;
  await chmod(entry, stat.isDirectory() ? 0o700 : 0o600);
  if (stat.isDirectory())
    for (const name of await readdir(entry)) await unlock(path.join(entry, name));
}

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.mocked(rename).mockReset();
  vi.mocked(rm).mockReset();
  for (const root of roots.splice(0)) {
    await unlock(root);
    await rm(root, { recursive: true, force: true });
  }
});

async function importSource(store: ReturnType<typeof createSkillPackageStore>, source: string) {
  const preview = await store.preview({ path: source });
  return store.import({ previewId: preview.previewId });
}

function packageDir(stateDir: string, packageId: string): string {
  return path.join(stateDir, "experts", "skill-packages", packageId);
}

describe("SkillPackageStore", () => {
  it.each(["directory", "preview"] as const)(
    "rolls back only a new unretained %s publication and cleans staging",
    async (mode) => {
      const { source, stateDir, store } = await fixture();
      const retain = async () => {
        throw new Error("injected retention failure");
      };
      const preview = await store.preview({ path: source });
      await expect(
        mode === "directory"
          ? store.publishDirectory(source, retain)
          : store.publishPreview(preview.previewId, retain),
      ).rejects.toThrow("injected retention failure");
      expect(await readdir(path.join(stateDir, "experts", "skill-packages"))).toEqual([]);
      const published = await store.publishDirectory(source);
      await expect(store.publishDirectory(source, retain)).rejects.toThrow(
        "injected retention failure",
      );
      expect(await readdir(path.join(stateDir, "experts", "skill-packages"))).toEqual([
        published.packageId,
      ]);
      expect(await store.read(published.packageId)).toEqual(published);
    },
  );
  it.each(["referenced", "unknown"] as const)(
    "preserves a newly published package when references are %s after retention fails",
    async (reference) => {
      const { source, stateDir, store } = await fixture();
      let packageId = "";
      await expect(
        store.publishDirectory(source, async (manifest) => {
          packageId = manifest.packageId;
          if (reference === "unknown")
            await writeFile(path.join(stateDir, "experts", "skill-library.json"), "invalid");
          else {
            const definitions = path.join(stateDir, "experts", "definitions");
            await mkdir(definitions, { recursive: true });
            await writeFile(
              path.join(definitions, "retained.json"),
              JSON.stringify({
                id: "retained",
                name: "Retained",
                description: "",
                useCases: "",
                persona: "",
                outputRequirements: "",
                skills: [],
                skillSelections: [
                  {
                    packageId: manifest.packageId,
                    entryPath: manifest.entries[0]!.entryPath,
                    activation: "startup",
                  },
                ],
                references: [],
                connections: [],
                revision: 1,
                archived: false,
                updatedAt: "2026-10-25T00:00:00.000Z",
              }),
            );
          }
          throw new Error("injected retention failure");
        }),
      ).rejects.toThrow(
        reference === "unknown" ? /rollback could not prove safe/ : /injected retention failure/,
      );
      expect(await readdir(path.join(stateDir, "experts", "skill-packages"))).toEqual([packageId]);
      expect((await store.read(packageId)).packageId).toBe(packageId);
    },
  );
  it("bounds concurrent package content verification when listing the inventory", async () => {
    const { source, stateDir, store } = await fixture();
    const first = await importSource(store, source);
    await writeFile(path.join(source, "modules", "config.yaml"), "language: en\n");
    const second = await importSource(store, source);
    const collect = expertResourceFiles.collect;
    let active = 0;
    let peak = 0;
    const spy = vi.spyOn(expertResourceFiles, "collect").mockImplementation(async (...args) => {
      active += 1;
      peak = Math.max(peak, active);
      try {
        // Keep content buffers live long enough to expose an unbounded fan-out.
        const resources = await collect(...args);
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
        return resources;
      } finally {
        active -= 1;
      }
    });
    const packages = await store.list();
    expect(new Set(packages.map((entry) => entry.packageId))).toEqual(
      new Set([first.package.packageId, second.package.packageId]),
    );
    expect(spy).toHaveBeenCalledTimes(2);
    expect(peak).toBe(1);

    const entry = path.join(
      packageDir(stateDir, first.package.packageId),
      "content",
      "modules",
      "config.yaml",
    );
    await chmod(entry, 0o600);
    await writeFile(entry, "tampered\n");
    await expect(store.list()).rejects.toMatchObject({ code: "package_corrupt" });
  });

  it("previews without publishing or executing, then preserves the complete package and relative dependencies", async () => {
    const { root, source, stateDir, store } = await fixture();
    const preview = await store.preview({ path: source });
    expect(preview.realRoot).toBe(source);
    expect(preview.package.entries.map((entry) => entry.entryPath)).toEqual([
      "skills/pm/SKILL.md",
      "skills/prd/SKILL.md",
    ]);
    expect(preview.package.fileCount).toBe(4);
    expect(preview.package.resources).toContainEqual(
      expect.objectContaining({ path: "content/modules/config.yaml" }),
    );
    expect(await store.list()).toEqual([]);
    expect(await store.listSources()).toEqual([]);
    const result = await store.import({ previewId: preview.previewId });
    expect(result.reused).toBe(false);
    expect(result.package).toEqual(preview.package);
    const content = path.join(packageDir(stateDir, result.package.packageId), "content");
    expect(
      await readFile(path.join(content, "skills", "pm", "../../modules/config.yaml"), "utf8"),
    ).toBe("language: zh\n");
    expect(await readdir(root)).not.toContain("SENTINEL");
    expect(await readdir(source)).not.toContain("SENTINEL");
    expect(await readdir(packageDir(stateDir, result.package.packageId))).toEqual(
      expect.arrayContaining(["package.json", "content"]),
    );
    expect(await createSkillPackageStore(stateDir).list()).toEqual([result.package]);
    expect(await store.listSources()).toEqual([result.source]);
  });

  it("isolates state directories and does not initialize or rewrite Expert definitions", async () => {
    const { root, source, stateDir, store } = await fixture();
    await importSource(store, source);
    expect(await readdir(path.join(stateDir, "experts"))).toEqual([
      "skill-imports",
      "skill-package-removals",
      "skill-packages",
      "skill-sources",
    ]);
    const other = createSkillPackageStore(path.join(root, "beta-state"));
    expect(await other.list()).toEqual([]);
  });

  it("reuses identical content across imports and source paths, retaining root names and ignoring mtimes", async () => {
    const { root, source, stateDir, store } = await fixture();
    const first = await importSource(store, source);
    const moved = path.join(root, "other", "bmad");
    await mkdir(path.dirname(moved));
    await rename(source, moved);
    const second = await importSource(store, moved);
    expect(second.package.packageId).toBe(first.package.packageId);
    expect(second.reused).toBe(true);
    expect(second.source.sourceId).not.toBe(first.source.sourceId);
    expect((await store.listSources()).length).toBe(2);
    expect(await readdir(path.join(stateDir, "experts", "skill-packages"))).toEqual([
      first.package.packageId,
    ]);
    const third = await importSource(store, moved);
    expect(third.source).toEqual(second.source);
  });

  it("hashes the root name, file paths, empty directories, bytes and executable marks", async () => {
    const { root, source, store } = await fixture();
    const ids = new Set<string>();
    ids.add((await store.preview({ path: source })).package.packageId);
    await mkdir(path.join(source, "empty"));
    ids.add((await store.preview({ path: source })).package.packageId);
    await writeFile(path.join(source, "modules", "config.yaml"), "language: en\n");
    ids.add((await store.preview({ path: source })).package.packageId);
    await rename(
      path.join(source, "modules", "config.yaml"),
      path.join(source, "modules", "other.yaml"),
    );
    ids.add((await store.preview({ path: source })).package.packageId);
    const renamed = path.join(root, "bmad-v2");
    await rename(source, renamed);
    ids.add((await store.preview({ path: renamed })).package.packageId);
    expect(ids.size).toBe(5);
    if (process.platform !== "win32") {
      await chmod(path.join(renamed, "run.sh"), 0o600);
      ids.add((await store.preview({ path: renamed })).package.packageId);
      expect(ids.size).toBe(6);
    }
  });

  it("sets immutable permissions before reuse and preserves source execute permissions", async () => {
    const { source, stateDir, store } = await fixture();
    const result = await importSource(store, source);
    if (process.platform !== "win32") {
      const directory = packageDir(stateDir, result.package.packageId);
      expect((await lstat(directory)).mode & 0o777).toBe(0o500);
      expect((await lstat(path.join(directory, "content", "run.sh"))).mode & 0o777).toBe(0o500);
      expect(
        (await lstat(path.join(directory, "content", "skills", "pm", "SKILL.md"))).mode & 0o777,
      ).toBe(0o400);
      expect((await lstat(path.join(directory, "package.json"))).mode & 0o777).toBe(0o400);
      expect((await lstat(path.join(source, "run.sh"))).mode & 0o777).toBe(0o700);
    }
  });

  it("imports a single SKILL.md using its own directory as the explicit package boundary", async () => {
    const { source, store } = await fixture();
    const result = await importSource(store, path.join(source, "skills", "pm", "SKILL.md"));
    expect(result.package.rootName).toBe("pm");
    expect(result.package.entries.map((entry) => entry.entryPath)).toEqual(["SKILL.md"]);
    expect(result.package.fileCount).toBe(1);
  });

  it("imports and resolves native execution metadata without rewriting the original Skill", async () => {
    const { source, stateDir, store } = await fixture();
    const skillPath = path.join(source, "skills", "pm", "SKILL.md");
    const original = [
      "---",
      "name: bmad-pm",
      "description: PM role",
      "context: fork",
      "agent: reviewer",
      "model: sonnet",
      "hooks:",
      "  PreToolUse:",
      "    - matcher: Bash",
      "      hooks:",
      "        - type: command",
      "          command: ./scripts/check.sh",
      "---",
      "Use ./scripts/check.sh and ../../modules/config.yaml.",
      "",
    ].join("\n");
    await writeFile(skillPath, original);
    await mkdir(path.join(source, "skills", "pm", "scripts"), { recursive: true });
    await writeFile(path.join(source, "skills", "pm", "scripts", "check.sh"), "exit 0\n");

    const preview = await store.preview({ path: source });
    const entry = preview.package.entries.find(
      (candidate) => candidate.entryPath === "skills/pm/SKILL.md",
    )!;
    expect(entry.incompatibleReason).toBeUndefined();
    expect(entry.issues.join("\n")).not.toContain("Provider-native");

    const imported = await store.import({ previewId: preview.previewId });
    const [resolved] = await store.resolveSelections([
      {
        packageId: imported.package.packageId,
        entryPath: entry.entryPath,
        activation: "on-demand",
      },
    ]);
    expect(resolved).toBeDefined();
    expect(await readFile(resolved!.path, "utf8")).toBe(original);
    expect(
      await readFile(
        path.join(
          packageDir(stateDir, imported.package.packageId),
          "content",
          "skills",
          "pm",
          "scripts",
          "check.sh",
        ),
        "utf8",
      ),
    ).toBe("exit 0\n");
  });

  it("selects only requested entries without projecting or renaming siblings", async () => {
    const { source, stateDir, store } = await fixture();
    const result = await importSource(store, source);
    const entries = await store.resolveSelections([
      {
        packageId: result.package.packageId,
        entryPath: "skills/pm/SKILL.md",
        activation: "startup",
      },
    ]);
    expect(entries).toEqual([
      {
        packageId: result.package.packageId,
        entryPath: "skills/pm/SKILL.md",
        activation: "startup",
        name: "bmad-pm",
        description: "PM role",
        sha256: result.package.resources.find(
          (resource) => resource.path === "content/skills/pm/SKILL.md",
        )!.sha256,
        path: path.join(
          packageDir(stateDir, result.package.packageId),
          "content",
          "skills",
          "pm",
          "SKILL.md",
        ),
      },
    ]);
    expect(await store.resolveSelections([])).toEqual([]);
  });

  it.each([
    {
      kind: "valid native metadata",
      body: [
        "---",
        "name: bmad-pm",
        "description: PM role",
        "context: fork",
        "agent: reviewer",
        "model: inherit",
        "hooks:",
        "  PreToolUse: []",
        "---",
        "Use the provider-native metadata.",
        "",
      ].join("\n"),
      reason:
        "Provider-native context, agent, model or hooks semantics are unsupported by the unified index.",
      previousIssues: [],
    },
    {
      kind: "malformed native metadata",
      body: [
        "---",
        "name: bmad-pm",
        "description: PM role",
        "context: [fork",
        "---",
        "Use the provider-native metadata.",
        "",
      ].join("\n"),
      reason: "Provider-native execution metadata is unsupported by the unified index.",
      previousIssues: [
        "Invalid YAML frontmatter; scalar metadata uses the existing discovery parser.",
      ],
    },
  ])(
    "reads and reuses a baseline package with exact historical diagnostics ($kind)",
    async ({ body, reason, previousIssues }) => {
      const { source, stateDir, store } = await fixture();
      await writeFile(path.join(source, "skills", "pm", "SKILL.md"), body);
      const originalPreview = await store.preview({ path: source });
      const originalImport = await store.import({ previewId: originalPreview.previewId });
      const directory = packageDir(stateDir, originalImport.package.packageId);
      const manifestPath = path.join(directory, "package.json");
      await chmod(manifestPath, 0o600);
      const baselineManifest = JSON.parse(await readFile(manifestPath, "utf8"));
      baselineManifest.entries[0].incompatibleReason = reason;
      baselineManifest.entries[0].issues.push(...previousIssues, reason);
      await writeFile(manifestPath, `${JSON.stringify(baselineManifest)}\n`);
      await chmod(manifestPath, 0o400);

      expect(await store.list()).toHaveLength(1);
      const [resolved] = await store.resolveSelections([
        {
          packageId: originalImport.package.packageId,
          entryPath: "skills/pm/SKILL.md",
          activation: "on-demand",
        },
      ]);
      expect(resolved?.name).toBe("bmad-pm");
      expect(resolved?.path).toContain(originalImport.package.packageId);

      const reusedPreview = await store.preview({ path: source });
      const reused = await store.import({ previewId: reusedPreview.previewId });
      expect(reused.reused).toBe(true);
      expect(reused.package.packageId).toBe(originalImport.package.packageId);
      expect(reused.package.entries[0]?.incompatibleReason).toBeUndefined();
      expect(reused.package.entries[0]?.issues).not.toContain(reason);
      for (const issue of previousIssues)
        expect(reused.package.entries[0]?.issues).not.toContain(issue);

      await chmod(manifestPath, 0o600);
      const tampered = JSON.parse(await readFile(manifestPath, "utf8"));
      tampered.entries[0].description = "unrelated manifest damage";
      await writeFile(manifestPath, `${JSON.stringify(tampered)}\n`);
      await chmod(manifestPath, 0o400);
      await expect(store.read(originalImport.package.packageId)).rejects.toMatchObject({
        code: "package_corrupt",
      });
    },
  );

  it("allows one startup entry and many on-demand entries, but rejects two startup entries", async () => {
    const { source, store } = await fixture();
    const {
      package: { packageId },
    } = await importSource(store, source);
    const first = { packageId, entryPath: "skills/pm/SKILL.md", activation: "startup" as const };
    const second = {
      packageId,
      entryPath: "skills/prd/SKILL.md",
      activation: "on-demand" as const,
    };
    expect((await store.resolveSelections([first, second])).length).toBe(2);
    await expect(
      store.resolveSelections([first, { ...second, activation: "startup" }]),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      store.resolveSelections([{ ...first, entryPath: "modules/SKILL.md" }]),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("warns about duplicate names in preview but rejects selecting them together, including across versions", async () => {
    const { source, store } = await fixture();
    const first = await importSource(store, source);
    await writeFile(
      path.join(source, "skills", "prd", "SKILL.md"),
      "---\nname: BMAD-PM\ndescription: duplicate\n---\n",
    );
    const preview = await store.preview({ path: source });
    expect(preview.issues[0]).toContain("Duplicate skill name");
    const second = await store.import({ previewId: preview.previewId });
    await expect(
      store.resolveSelections([
        {
          packageId: first.package.packageId,
          entryPath: "skills/pm/SKILL.md",
          activation: "on-demand",
        },
        {
          packageId: second.package.packageId,
          entryPath: "skills/prd/SKILL.md",
          activation: "on-demand",
        },
      ]),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("publishes updates as separate versions and keeps old selection bytes after source deletion", async () => {
    const { source, store } = await fixture();
    const first = await importSource(store, source);
    await writeFile(path.join(source, "modules", "config.yaml"), "language: new\n");
    const second = await importSource(store, source);
    expect(second.package.packageId).not.toBe(first.package.packageId);
    expect(second.source.sourceId).toBe(first.source.sourceId);
    expect(second.source.revision).toBe(2);
    await rm(source, { recursive: true });
    const selected = await store.resolveSelections([
      {
        packageId: first.package.packageId,
        entryPath: "skills/pm/SKILL.md",
        activation: "startup",
      },
    ]);
    expect(
      await readFile(
        path.resolve(path.dirname(selected[0]!.path), "../../modules/config.yaml"),
        "utf8",
      ),
    ).toBe("language: zh\n");
    expect((await store.list()).length).toBe(2);
  });

  it("previews entry and shared-resource update diffs without advancing the source revision", async () => {
    const { source, store } = await fixture();
    const first = await importSource(store, source);
    await writeFile(
      path.join(source, "skills", "pm", "SKILL.md"),
      "---\nname: bmad-pm\ndescription: updated\n---\n",
    );
    await rm(path.join(source, "skills", "prd"), { recursive: true });
    await mkdir(path.join(source, "skills", "architect"));
    await writeFile(
      path.join(source, "skills", "architect", "SKILL.md"),
      "---\nname: bmad-architect\ndescription: architecture\n---\n",
    );
    await writeFile(path.join(source, "modules", "config.yaml"), "language: en\n");
    const next = await store.previewUpdate({
      sourceId: first.source.sourceId,
      expectedRevision: 1,
    });
    expect(next.previousPackageId).toBe(first.package.packageId);
    expect(next.addedEntries).toEqual(["skills/architect/SKILL.md"]);
    expect(next.removedEntries).toEqual(["skills/prd/SKILL.md"]);
    expect(next.changedEntries).toEqual(["skills/pm/SKILL.md"]);
    expect(next.resourceChanges).toContainEqual({
      path: "content/modules/config.yaml",
      change: "changed",
    });
    expect(await store.listSources()).toEqual([first.source]);
    const updated = await store.import({ previewId: next.previewId });
    expect(updated.source.revision).toBe(2);
    expect(await store.read(first.package.packageId)).toEqual(first.package);
  });

  it("rejects stale source revisions both when previewing an update and at confirmation", async () => {
    const { source, store } = await fixture();
    const first = await importSource(store, source);
    await writeFile(path.join(source, "modules", "config.yaml"), "new content");
    const next = await store.previewUpdate({
      sourceId: first.source.sourceId,
      expectedRevision: 1,
    });
    await importSource(store, source);
    await expect(store.import({ previewId: next.previewId })).rejects.toMatchObject({
      code: "revision_conflict",
    });
    await expect(
      store.previewUpdate({ sourceId: first.source.sourceId, expectedRevision: 1 }),
    ).rejects.toMatchObject({ code: "revision_conflict" });
  });

  it.each(["bytes", "entry", "directory"])(
    "rejects a stale preview when the source changes: %s",
    async (change) => {
      const { source, store } = await fixture();
      const preview = await store.preview({ path: source });
      if (change === "bytes")
        await writeFile(path.join(source, "modules", "config.yaml"), "changed");
      else if (change === "entry") await rm(path.join(source, "skills", "pm", "SKILL.md"));
      else await mkdir(path.join(source, "extra"));
      await expect(store.import({ previewId: preview.previewId })).rejects.toMatchObject({
        code: "preview_stale",
      });
      expect(await store.list()).toEqual([]);
      expect(await store.listSources()).toEqual([]);
    },
  );

  it("expires server-owned previews and never accepts client-substituted source/content", async () => {
    const { source, store } = await fixture();
    const preview = await store.preview({ path: source });
    await expect(store.import({ previewId: "invented" })).rejects.toMatchObject({
      code: "preview_expired",
    });
    await expect(
      store.import({ previewId: preview.previewId, path: "/elsewhere" } as never),
    ).rejects.toThrow();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 16 * 60 * 1_000);
    await expect(store.import({ previewId: preview.previewId })).rejects.toMatchObject({
      code: "preview_expired",
    });
    vi.useRealTimers();
  });

  it("bounds pending preview tokens and releases expired slots", async () => {
    const { source, store } = await fixture();
    for (let index = 0; index < 100; index += 1) await store.preview({ path: source });
    await expect(store.preview({ path: source })).rejects.toMatchObject({ code: "invalid_input" });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 16 * 60 * 1_000);
    await expect(store.preview({ path: source })).resolves.toMatchObject({ sourcePath: source });
    vi.useRealTimers();
  });

  it("returns stale when a previewed source disappears", async () => {
    const { source, store } = await fixture();
    const preview = await store.preview({ path: source });
    await rm(source, { recursive: true });
    await expect(store.import({ previewId: preview.previewId })).rejects.toMatchObject({
      code: "preview_stale",
    });
  });

  it.skipIf(process.platform === "win32")(
    "permits an outer directory symlink, reports its real root, and detects retargeting",
    async () => {
      const { root, source, store } = await fixture();
      const link = path.join(root, "chosen-link");
      await symlink(source, link);
      const preview = await store.preview({ path: link });
      expect(preview.realRoot).toBe(source);
      const first = await store.import({ previewId: preview.previewId });
      const secondPreview = await store.preview({ path: link });
      const moved = path.join(root, "other", "bmad");
      await mkdir(path.dirname(moved));
      await rename(source, moved);
      await rm(link);
      await symlink(moved, link);
      expect((await store.preview({ path: link })).package.packageId).toBe(first.package.packageId);
      await expect(store.import({ previewId: secondPreview.previewId })).rejects.toMatchObject({
        code: "preview_stale",
      });
    },
  );

  it.skipIf(process.platform === "win32")(
    "rejects inner links, including links to files inside the same package",
    async () => {
      const { source, store } = await fixture();
      await symlink(path.join(source, "modules", "config.yaml"), path.join(source, "config-link"));
      await expect(store.preview({ path: source })).rejects.toMatchObject({
        code: "invalid_resource",
      });
    },
  );

  it.skipIf(process.platform === "win32")("rejects a selected SKILL.md symlink", async () => {
    const { root, source, store } = await fixture();
    const linked = path.join(root, "SKILL.md");
    await symlink(path.join(source, "skills", "pm", "SKILL.md"), linked);
    await expect(store.preview({ path: linked })).rejects.toMatchObject({
      code: "invalid_resource",
    });
  });

  it("does not silently exclude .git or hidden files", async () => {
    const { source, store } = await fixture();
    await mkdir(path.join(source, ".git"));
    await writeFile(path.join(source, ".git", "config"), "local git metadata");
    await writeFile(path.join(source, ".env"), "untrusted package data");
    const result = await importSource(store, source);
    expect(result.package.fileCount).toBe(6);
    expect(result.package.resources.some((entry) => entry.path === "content/.env")).toBe(true);
  });

  it("rejects oversized files rather than publishing a subset", async () => {
    const { source, store } = await fixture();
    const large = path.join(source, "large.bin");
    await writeFile(large, "");
    await truncate(large, 16 * 1024 * 1024 + 1);
    await expect(store.preview({ path: source })).rejects.toThrow(/large\.bin/u);
    expect(await store.list()).toEqual([]);
  });

  it("rejects packages over the total byte limit and identifies the overflowing resource", async () => {
    const { source, store } = await fixture();
    for (let index = 0; index < 7; index += 1) {
      const file = path.join(source, `large-${index}.bin`);
      await writeFile(file, "");
      await truncate(file, 16 * 1024 * 1024);
    }
    await expect(store.preview({ path: source })).rejects.toThrow(/large-6\.bin/u);
    expect(await store.list()).toEqual([]);
  });

  it("rejects packages over the entry limit", async () => {
    const { source, store } = await fixture();
    for (let start = 0; start < 5_000; start += 100) {
      await Promise.all(
        Array.from({ length: 100 }, (_, offset) =>
          mkdir(path.join(source, `empty-${start + offset}`)),
        ),
      );
    }
    await expect(store.preview({ path: source })).rejects.toMatchObject({
      code: "invalid_resource",
    });
  });

  it("rejects a package with no skill entries and non-absolute inputs", async () => {
    const { root, store } = await fixture();
    const empty = path.join(root, "empty");
    await mkdir(empty);
    await expect(store.preview({ path: empty })).rejects.toMatchObject({
      code: "invalid_resource",
    });
    await expect(store.preview({ path: "relative" })).rejects.toMatchObject({
      code: "invalid_input",
    });
    expect(() => createSkillPackageStore("relative")).toThrow();
    await expect(store.read("../../elsewhere")).rejects.toMatchObject({ code: "invalid_input" });
    await expect(store.remove("../../elsewhere")).rejects.toMatchObject({ code: "invalid_input" });
  });

  it.skipIf(process.platform !== "linux")(
    "rejects case-colliding names on case-sensitive filesystems",
    async () => {
      const { source, store } = await fixture();
      await writeFile(path.join(source, "case.txt"), "one");
      await writeFile(path.join(source, "CASE.txt"), "two");
      await expect(store.preview({ path: source })).rejects.toMatchObject({
        code: "invalid_resource",
      });
    },
  );

  it.each(["bad:name", "NUL.txt", "trailing."])(
    "rejects non-portable resource names: %s",
    async (name) => {
      const { source, store } = await fixture();
      // These names are themselves forbidden by Windows; creation is only tested on POSIX.
      if (process.platform === "win32") return;
      await writeFile(path.join(source, name), "data");
      await expect(store.preview({ path: source })).rejects.toMatchObject({
        code: "invalid_resource",
      });
    },
  );

  it("reports metadata limitations and uses discovery-compatible fallback names", async () => {
    const { source, store } = await fixture();
    await writeFile(
      path.join(source, "skills", "pm", "SKILL.md"),
      "---\ndescription: >-\n  block description\nallowed-tools: Read\n---\n",
    );
    const preview = await store.preview({ path: source });
    expect(preview.package.entries[0]).toMatchObject({
      name: "pm",
      description: "block description",
      issues: expect.arrayContaining([
        expect.stringContaining("Missing frontmatter name"),
        expect.stringContaining("grants no permissions"),
      ]),
    });
  });

  it.each(["bytes", "manifest", "extra-file", "execute-bit"])(
    "fails closed on corrupt published packages without repairing them: %s",
    async (damage) => {
      const { source, stateDir, store } = await fixture();
      const result = await importSource(store, source);
      const directory = packageDir(stateDir, result.package.packageId);
      const manifest = path.join(directory, "package.json");
      if (damage === "bytes") {
        const file = path.join(directory, "content", "modules", "config.yaml");
        await chmod(file, 0o600);
        await writeFile(file, "corrupt");
      } else if (damage === "manifest") {
        await chmod(manifest, 0o600);
        const value = JSON.parse(await readFile(manifest, "utf8"));
        value.entries[0].description = "tampered index";
        await writeFile(manifest, JSON.stringify(value));
      } else if (damage === "extra-file") {
        await chmod(path.join(directory, "content"), 0o700);
        await writeFile(path.join(directory, "content", "unexpected"), "extra");
      } else {
        if (process.platform === "win32") return; // no POSIX execute-bit semantics
        await chmod(path.join(directory, "content", "run.sh"), 0o400);
      }
      await expect(store.read(result.package.packageId)).rejects.toMatchObject({
        code: "package_corrupt",
      });
      await expect(importSource(store, source)).rejects.toMatchObject({ code: "package_corrupt" });
      expect(await readdir(path.join(stateDir, "experts", "skill-packages"))).toEqual([
        result.package.packageId,
      ]);
    },
  );

  it("rejects corrupted source pointers instead of silently replacing them", async () => {
    const { source, stateDir, store } = await fixture();
    const first = await importSource(store, source);
    const sourceFile = path.join(
      stateDir,
      "experts",
      "skill-sources",
      `${first.source.sourceId}.json`,
    );
    await writeFile(sourceFile, JSON.stringify({ ...first.source, sourcePath: "/changed" }));
    await expect(store.listSources()).rejects.toMatchObject({ code: "package_corrupt" });
    await expect(importSource(store, source)).rejects.toMatchObject({ code: "package_corrupt" });
  });

  it("does not publish or advance the source pointer after a publication failure, and retries cleanly", async () => {
    const { source, stateDir, store } = await fixture();
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    vi.mocked(rename).mockImplementation(async (from, to) => {
      if (path.basename(String(from)).startsWith(".staging-"))
        throw new Error("injected publish failure");
      return actual.rename(from, to);
    });
    const preview = await store.preview({ path: source });
    await expect(store.import({ previewId: preview.previewId })).rejects.toThrow(
      "injected publish failure",
    );
    expect(await readdir(path.join(stateDir, "experts", "skill-packages"))).toEqual([]);
    expect(await store.listSources()).toEqual([]);
    vi.mocked(rename).mockImplementation(actual.rename);
    const result = await store.import({ previewId: preview.previewId });
    expect(result.reused).toBe(false);
    expect(result.source.revision).toBe(1);
  });

  it("replays a journaled import after source-pointer failure and process restart", async () => {
    const { source, stateDir, store } = await fixture();
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    vi.mocked(rename).mockImplementation(async (from, to) => {
      if (String(to).includes("/skill-sources/")) throw new Error("injected source write failure");
      return actual.rename(from, to);
    });
    const preview = await store.preview({ path: source });
    await expect(store.import({ previewId: preview.previewId })).rejects.toThrow(
      "injected source write failure",
    );
    expect(await readdir(path.join(stateDir, "experts", "skill-packages"))).toEqual([
      preview.package.packageId,
    ]);
    expect(await store.listSources()).toEqual([]);
    vi.mocked(rename).mockImplementation(actual.rename);
    const result = await createSkillPackageStore(stateDir).import({ previewId: preview.previewId });
    expect(result.reused).toBe(false);
    expect(result.source.revision).toBe(1);
  });

  it("retains a retryable preview when the import journal cannot be published", async () => {
    const { source, stateDir, store } = await fixture();
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    vi.mocked(rename).mockImplementation(async (from, to) => {
      if (String(to).includes("/skill-imports/")) throw new Error("journal unavailable");
      return actual.rename(from, to);
    });
    const preview = await store.preview({ path: source });
    await expect(store.import({ previewId: preview.previewId })).rejects.toThrow(
      "journal unavailable",
    );
    expect(await readdir(path.join(stateDir, "experts", "skill-packages"))).toEqual([]);
    expect(await store.listSources()).toEqual([]);
    vi.mocked(rename).mockImplementation(actual.rename);
    const result = await store.import({ previewId: preview.previewId });
    expect(result.reused).toBe(false);
    expect(result.source.revision).toBe(1);
  });

  it("finishes an interrupted update without incrementing the source revision twice", async () => {
    const { source, stateDir, store } = await fixture();
    const first = await importSource(store, source);
    await writeFile(path.join(source, "modules", "config.yaml"), "language: en\n");
    const preview = await store.previewUpdate({
      sourceId: first.source.sourceId,
      expectedRevision: 1,
    });
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    let receipts = 0;
    vi.mocked(rename).mockImplementation(async (from, to) => {
      if (String(to).includes("/skill-imports/") && ++receipts === 2)
        throw new Error("lost completion");
      return actual.rename(from, to);
    });
    await expect(store.import({ previewId: preview.previewId })).rejects.toThrow("lost completion");
    expect((await store.listSources())[0]?.revision).toBe(2);
    vi.mocked(rename).mockImplementation(actual.rename);
    const result = await createSkillPackageStore(stateDir).import({ previewId: preview.previewId });
    expect(result.source.revision).toBe(2);
    expect(result.package.packageId).not.toBe(first.package.packageId);
  });

  it("replays a partial tombstone deletion from the durable removal journal", async () => {
    const { source, stateDir, store } = await fixture();
    const imported = await importSource(store, source);
    const tombstone = path.join(
      stateDir,
      "experts",
      "skill-package-removals",
      imported.package.packageId,
    );
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    vi.mocked(rm).mockImplementation(async (target, options) => {
      if (String(target) === tombstone) {
        await actual.rm(path.join(tombstone, "content"), { recursive: true, force: true });
        throw new Error("injected partial tombstone deletion");
      }
      return actual.rm(target, options);
    });

    await expect(store.remove(imported.package.packageId)).rejects.toThrow(
      "injected partial tombstone deletion",
    );
    expect(await readdir(path.join(stateDir, "experts", "skill-sources"))).toEqual([]);
    expect((await lstat(tombstone)).isDirectory()).toBe(true);
    expect(
      JSON.parse(
        await readFile(
          path.join(
            stateDir,
            "experts",
            "skill-package-removals",
            `${imported.package.packageId}.json`,
          ),
          "utf8",
        ),
      ),
    ).toMatchObject({ state: "pending", packageId: imported.package.packageId });

    vi.mocked(rm).mockImplementation(actual.rm);
    const restarted = createSkillPackageStore(stateDir);
    expect(await restarted.list()).toEqual([]);
    expect(await restarted.listSources()).toEqual([]);
    await expect(lstat(tombstone)).rejects.toMatchObject({ code: "ENOENT" });
    expect(
      JSON.parse(
        await readFile(
          path.join(
            stateDir,
            "experts",
            "skill-package-removals",
            `${imported.package.packageId}.json`,
          ),
          "utf8",
        ),
      ),
    ).toMatchObject({ state: "complete" });
  });

  it("retries a lost removal reply without deleting a newly referenced package", async () => {
    const { source, stateDir, store } = await fixture();
    const imported = await importSource(store, source);
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    const journalPath = path.join(
      stateDir,
      "experts",
      "skill-package-removals",
      `${imported.package.packageId}.json`,
    );
    let journalWrites = 0;
    vi.mocked(rename).mockImplementation(async (from, to) => {
      const didRename = await actual.rename(from, to);
      if (String(to) === journalPath && ++journalWrites === 2)
        throw new Error("lost removal reply after durable completion");
      return didRename;
    });
    await expect(store.remove(imported.package.packageId)).rejects.toThrow(
      "lost removal reply after durable completion",
    );
    expect(journalWrites).toBe(2);
    vi.mocked(rename).mockImplementation(actual.rename);
    await expect(
      createSkillPackageStore(stateDir).remove(imported.package.packageId),
    ).resolves.toBe(undefined);

    // A completed tombstone is only a replay receipt. If a same-content package
    // is imported later, the receipt is retired before publication and deletion
    // remains reference-checked as a new operation.
    const replacement = await importSource(createSkillPackageStore(stateDir), source);
    expect(replacement.package.packageId).toBe(imported.package.packageId);
    await expect(
      createSkillPackageStore(stateDir).remove(replacement.package.packageId),
    ).resolves.toBeUndefined();
    expect(await createSkillPackageStore(stateDir).list()).toEqual([]);
    expect(await createSkillPackageStore(stateDir).listSources()).toEqual([]);

    const referencedReplacement = await importSource(createSkillPackageStore(stateDir), source);
    const definitionsDir = path.join(stateDir, "experts", "definitions");
    await mkdir(definitionsDir, { recursive: true });
    await writeFile(
      path.join(definitionsDir, "manual-reference.json"),
      JSON.stringify({
        id: "manual-reference",
        name: "Manual reference",
        description: "",
        useCases: "",
        persona: "",
        outputRequirements: "",
        skills: [],
        skillSelections: [
          {
            packageId: referencedReplacement.package.packageId,
            entryPath: referencedReplacement.package.entries[0]!.entryPath,
            activation: "startup",
          },
        ],
        references: [],
        connections: [],
        revision: 1,
        archived: false,
        updatedAt: "2026-10-20T00:00:00.000Z",
      }),
    );

    await expect(
      createSkillPackageStore(stateDir).remove(referencedReplacement.package.packageId),
    ).rejects.toThrow(/referenced/u);
    await expect(
      createSkillPackageStore(stateDir).read(referencedReplacement.package.packageId),
    ).resolves.toEqual(imported.package);
  });

  it("recovers an interrupted removal before update preview or package reimport", async () => {
    const { source, stateDir, store } = await fixture();
    const imported = await importSource(store, source);
    const reimportPreview = await store.preview({ path: source });
    const tombstone = path.join(
      stateDir,
      "experts",
      "skill-package-removals",
      imported.package.packageId,
    );
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    vi.mocked(rm).mockImplementation(async (target, options) => {
      if (String(target) === tombstone) {
        await actual.rm(path.join(tombstone, "content"), { recursive: true, force: true });
        throw new Error("interrupted before removal acknowledgement");
      }
      return actual.rm(target, options);
    });
    await expect(store.remove(imported.package.packageId)).rejects.toThrow(
      "interrupted before removal acknowledgement",
    );
    vi.mocked(rm).mockImplementation(actual.rm);

    await expect(
      store.previewUpdate({ sourceId: imported.source.sourceId, expectedRevision: 1 }),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(await store.list()).toEqual([]);
    expect(await store.listSources()).toEqual([]);

    const restored = await store.import({
      previewId: reimportPreview.previewId,
    });
    expect(restored.package.packageId).toBe(imported.package.packageId);
    expect(restored.source.revision).toBe(1);
    expect(await createSkillPackageStore(stateDir).listSources()).toEqual([restored.source]);
    await createSkillPackageStore(stateDir).remove(restored.package.packageId);
    expect(await createSkillPackageStore(stateDir).list()).toEqual([]);
  });

  it("retains a partial tombstone when a recovery scan discovers a package reference", async () => {
    const { source, stateDir, store } = await fixture();
    const imported = await importSource(store, source);
    const tombstone = path.join(
      stateDir,
      "experts",
      "skill-package-removals",
      imported.package.packageId,
    );
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    vi.mocked(rm).mockImplementation(async (target, options) => {
      if (String(target) === tombstone) {
        await actual.rm(path.join(tombstone, "content"), { recursive: true, force: true });
        throw new Error("interrupted removal");
      }
      return actual.rm(target, options);
    });
    await expect(store.remove(imported.package.packageId)).rejects.toThrow("interrupted removal");
    vi.mocked(rm).mockImplementation(actual.rm);

    const definitionsDir = path.join(stateDir, "experts", "definitions");
    await mkdir(definitionsDir, { recursive: true });
    await writeFile(
      path.join(definitionsDir, "manual-reference.json"),
      JSON.stringify({
        id: "manual-reference",
        name: "Manual reference",
        description: "",
        useCases: "",
        persona: "",
        outputRequirements: "",
        skills: [],
        skillSelections: [
          {
            packageId: imported.package.packageId,
            entryPath: imported.package.entries[0]!.entryPath,
            activation: "startup",
          },
        ],
        references: [],
        connections: [],
        revision: 1,
        archived: false,
        updatedAt: "2026-10-20T00:00:00.000Z",
      }),
    );

    await expect(createSkillPackageStore(stateDir).list()).rejects.toThrow(/referenced/u);
    expect((await lstat(tombstone)).isDirectory()).toBe(true);
  });

  it.skipIf(process.platform === "win32")(
    "sets child file and directory modes before the package becomes reachable",
    async () => {
      const { source, store } = await fixture();
      const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
      let observed = false;
      vi.mocked(rename).mockImplementation(async (from, to) => {
        if (path.basename(String(from)).startsWith(".staging-")) {
          observed = true;
          expect((await lstat(path.join(String(from), "content"))).mode & 0o777).toBe(0o500);
          expect((await lstat(path.join(String(from), "content", "run.sh"))).mode & 0o777).toBe(
            0o500,
          );
          expect((await lstat(path.join(String(from), "package.json"))).mode & 0o777).toBe(0o400);
        }
        return actual.rename(from, to);
      });
      await importSource(store, source);
      expect(observed).toBe(true);
    },
  );

  it("deduplicates concurrent publication by separate store instances and cleans staging", async () => {
    const { source, stateDir, store } = await fixture();
    const other = createSkillPackageStore(stateDir);
    const first = await store.preview({ path: source });
    const second = await other.preview({ path: source });
    const results = await Promise.all([
      store.import({ previewId: first.previewId }),
      other.import({ previewId: second.previewId }),
    ]);
    expect(results[0].package).toEqual(results[1].package);
    expect(await readdir(path.join(stateDir, "experts", "skill-packages"))).toEqual([
      results[0].package.packageId,
    ]);
  });
});
