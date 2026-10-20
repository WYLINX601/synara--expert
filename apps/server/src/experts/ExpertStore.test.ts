import {
  chmod,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  rename,
  readdir,
  rm,
  symlink,
  stat,
  writeFile,
} from "node:fs/promises";
import nodeFs from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import * as path from "node:path";

import type { ExpertSaveInput } from "@synara/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createExpertStore, readVerifiedStoredExpertSnapshot } from "./ExpertStore.ts";
import { createExpertConnectionStore } from "./ExpertConnectionStore.ts";
import { createSkillPackageStore } from "./SkillPackageStore.ts";

vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  return { ...actual, rename: vi.fn(actual.rename) };
});

const temporaryRoots: string[] = [];

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "synara-expert-store-"));
  temporaryRoots.push(root);
  return root;
}

async function unlockTree(entry: string): Promise<void> {
  await chmod(entry, 0o700).catch(() => undefined);
  for (const name of await readdir(entry).catch(() => [])) {
    const child = path.join(entry, name);
    const stat = await lstat(child);
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) await unlockTree(child);
    else await chmod(child, 0o600).catch(() => undefined);
  }
}

afterEach(async () => {
  for (const root of temporaryRoots.splice(0)) {
    await unlockTree(root);
    await rm(root, { recursive: true, force: true });
  }
});

function definitionInput(name: string, extra: Partial<ExpertSaveInput> = {}): ExpertSaveInput {
  return {
    id: `test-${name.toLowerCase().replaceAll(" ", "-")}`,
    name,
    description: "Test expert",
    useCases: "Test use cases",
    persona: "Separate facts from assumptions.",
    outputRequirements: "Give a conclusion and evidence.",
    skills: [],
    references: [],
    connections: [],
    preferredProvider: "codex" as const,
    ...extra,
  };
}

async function importSkillPackage(stateDir: string, sourceRoot: string) {
  const store = createSkillPackageStore(stateDir);
  const preview = await store.preview({ path: sourceRoot });
  return (await store.import({ previewId: preview.previewId })).package;
}

async function writeSkill(
  root: string,
  relativePath: string,
  name: string,
  text = `Instructions for ${name}.`,
): Promise<void> {
  const skillFile = path.join(root, relativePath);
  await mkdir(path.dirname(skillFile), { recursive: true });
  await writeFile(
    skillFile,
    `---\nname: ${name}\ndescription: Description for ${name}.\n---\n${text}\n`,
  );
}

describe("ExpertStore", () => {
  it("initializes the three examples once across simultaneous store users", async () => {
    const root = await makeTempRoot();
    const stateDir = path.join(root, "state");
    const stores = Array.from({ length: 3 }, () => createExpertStore(stateDir));
    const lists = await Promise.all(stores.map((store) => store.list()));
    expect(lists.every((list) => list.length === 3)).toBe(true);
    expect(lists[0]?.map((expert) => expert.id)).toEqual(lists[1]?.map((expert) => expert.id));
  });

  it("seeds three editable examples and guards edits by revision", async () => {
    const root = await makeTempRoot();
    const store = createExpertStore(path.join(root, "state"));
    const seeded = await store.list();
    expect(seeded.map((expert) => expert.id).sort()).toEqual([
      "code-reviewer",
      "product-manager",
      "ui-designer",
    ]);
    expect(seeded.every((expert) => expert.connections.length === 0)).toBe(true);

    const created = await store.save(definitionInput("Release reviewer"));
    expect(created.revision).toBe(1);
    const updated = await store.save({
      ...definitionInput("Release reviewer"),
      expectedRevision: 1,
    });
    expect(updated.revision).toBe(2);
    await expect(
      store.save({ ...definitionInput("Release reviewer"), expectedRevision: 1 }),
    ).rejects.toMatchObject({ code: "revision_conflict" });

    const reopened = createExpertStore(path.join(root, "state"));
    expect(await reopened.read(created.id)).toMatchObject({ id: created.id, revision: 2 });
    const archived = await reopened.archive(created.id, 2);
    expect(archived).toMatchObject({ archived: true, revision: 3 });
  });

  it("deletes only the requested revision and preserves pinned resources after reopening", async () => {
    const root = await makeTempRoot();
    const stateDir = path.join(root, "state");
    const reference = path.join(root, "brief.md");
    await writeFile(reference, "Pinned task reference", "utf8");
    const store = createExpertStore(stateDir);
    const expert = await store.save(definitionInput("Deleted expert", { references: [reference] }));
    const binding = await store.prepareSnapshot(expert.id);
    const snapshot = await store.readSnapshot(binding.snapshotId);
    const manifest = path.join(
      stateDir,
      "experts",
      "snapshots",
      binding.snapshotId,
      "snapshot.json",
    );
    const manifestBefore = await readFile(manifest, "utf8");

    await expect(store.remove(expert.id, expert.revision + 1)).rejects.toMatchObject({
      code: "revision_conflict",
    });
    expect(await store.read(expert.id)).toEqual(expert);
    const archived = await store.archive(expert.id, expert.revision);
    await expect(store.remove(expert.id, expert.revision)).rejects.toMatchObject({
      code: "revision_conflict",
    });
    await store.remove(expert.id, archived.revision);

    const reopened = createExpertStore(stateDir);
    expect(await reopened.read(expert.id)).toBeNull();
    expect((await reopened.list()).some(({ id }) => id === expert.id)).toBe(false);
    await expect(reopened.prepareSnapshot(expert.id)).rejects.toMatchObject({ code: "not_found" });
    await expect(reopened.remove(expert.id, archived.revision)).rejects.toMatchObject({
      code: "not_found",
    });
    expect(await reopened.readSnapshot(binding.snapshotId)).toEqual(snapshot);
    expect(await readFile(snapshot.references[0]!, "utf8")).toBe("Pinned task reference");
    expect(await readFile(reference, "utf8")).toBe("Pinned task reference");
    expect(await readFile(manifest, "utf8")).toBe(manifestBefore);
  });

  it("keeps an intentionally empty library empty after deleting every default and reopening", async () => {
    const root = await makeTempRoot();
    const stateDir = path.join(root, "state");
    const store = createExpertStore(stateDir);
    const defaults = await store.list();
    await Promise.all(defaults.map((expert) => store.remove(expert.id, expert.revision)));
    expect(await store.list()).toEqual([]);
    expect(await createExpertStore(stateDir).list()).toEqual([]);
  });

  it("marks legacy libraries as initialized without restoring removed defaults", async () => {
    const root = await makeTempRoot();
    const stateDir = path.join(root, "state");
    const store = createExpertStore(stateDir);
    for (const expert of await store.list()) await store.remove(expert.id, expert.revision);
    const custom = await store.save(definitionInput("Legacy custom"));
    await rm(path.join(stateDir, "experts", "initialized.json"));
    const reopened = createExpertStore(stateDir);
    expect(await reopened.list()).toEqual([custom]);
    await reopened.remove(custom.id, custom.revision);
    expect(await createExpertStore(stateDir).list()).toEqual([]);
  });

  it("restores archived experts with revision checks and idempotent repeated restores", async () => {
    const root = await makeTempRoot();
    const store = createExpertStore(path.join(root, "state"));
    const created = await store.save(definitionInput("Restorable expert"));
    const archived = await store.archive(created.id, created.revision);
    expect(archived).toMatchObject({ archived: true, revision: 2 });

    await expect(store.restore(created.id, created.revision)).rejects.toMatchObject({
      code: "revision_conflict",
    });

    const restored = await store.restore(created.id, archived.revision);
    expect(restored).toMatchObject({ archived: false, revision: 3 });
    await expect(store.restore(created.id, restored.revision)).resolves.toEqual(restored);
    await expect(store.restore(created.id, archived.revision)).rejects.toMatchObject({
      code: "revision_conflict",
    });
  });

  it("persists enabled bindings while reading legacy snapshots without rewriting them", async () => {
    const root = await makeTempRoot();
    const stateDir = path.join(root, "state");
    const store = createExpertStore(stateDir);
    const connections: ExpertSaveInput["connections"] = [
      { id: "legacy", required: true, tools: ["review"] },
      { id: "disabled", required: true, tools: ["publish"], enabled: false },
      { id: "enabled", required: false, tools: ["search"], enabled: true },
    ];
    const definition = await store.save(definitionInput("Connection persistence", { connections }));
    const connectionStore = createExpertConnectionStore(stateDir);
    for (const [id, name] of [
      ["legacy", "Legacy connection"],
      ["enabled", "Enabled connection"],
    ] as const) {
      await connectionStore.save({
        id,
        name,
        transport: { type: "stdio", command: "fixture-mcp", args: [], envFromHost: [] },
      });
    }

    const reopened = createExpertStore(stateDir);
    expect((await reopened.read(definition.id))?.connections).toEqual(connections);

    const binding = await reopened.prepareSnapshot(definition.id);
    const manifestPath = path.join(
      stateDir,
      "experts",
      "snapshots",
      binding.snapshotId,
      "snapshot.json",
    );
    const beforeRead = await readFile(manifestPath, "utf8");
    const stored = JSON.parse(beforeRead) as {
      snapshot: {
        connections: unknown;
        mcpBinding?: { servers: Array<{ id: string }> };
      };
    };
    expect(stored.snapshot.connections).toEqual(connections);
    expect(stored.snapshot.mcpBinding?.servers.map(({ id }) => id)).toEqual(["legacy", "enabled"]);
    expect(await reopened.readSnapshot(binding.snapshotId)).toMatchObject({ connections });
    expect(await readFile(manifestPath, "utf8")).toBe(beforeRead);
  });

  it("hashes pinned MCP revisions while keeping unchanged and old snapshots stable", async () => {
    const root = await makeTempRoot();
    const stateDir = path.join(root, "state");
    const store = createExpertStore(stateDir);
    const connections = createExpertConnectionStore(stateDir);
    const firstConfig = await connections.save({
      id: "research",
      name: "Research MCP",
      transport: { type: "stdio", command: "fixture-mcp-r1", args: [], envFromHost: [] },
    });
    const expert = await store.save(
      definitionInput("Pinned MCP revision", {
        connections: [{ id: "research", required: true, tools: ["search"] }],
      }),
    );

    const first = await store.prepareSnapshot(expert.id);
    const repeated = await store.prepareSnapshot(expert.id);
    expect(repeated.snapshotId).toBe(first.snapshotId);
    expect((await store.readSnapshot(first.snapshotId)).mcpBinding?.servers).toEqual([
      { id: "research", configRevision: firstConfig.revision, required: true, tools: ["search"] },
    ]);

    await connections.save({
      id: "research",
      expectedRevision: firstConfig.revision,
      name: "Research MCP v2",
      transport: { type: "stdio", command: "fixture-mcp-r2", args: [], envFromHost: [] },
    });
    const updated = await store.prepareSnapshot(expert.id);
    expect(updated.snapshotId).not.toBe(first.snapshotId);
    expect((await store.readSnapshot(updated.snapshotId)).mcpBinding?.servers[0]).toMatchObject({
      id: "research",
      configRevision: firstConfig.revision + 1,
    });
  });

  it("pins empty all-mode connections and gives each prepared task its own authorization ID", async () => {
    const root = await makeTempRoot();
    const stateDir = path.join(root, "state");
    const store = createExpertStore(stateDir);
    const connections = createExpertConnectionStore(stateDir);
    const config = await connections.save({
      id: "all-tools",
      name: "All tools MCP",
      transport: { type: "stdio", command: "fixture-mcp", args: [], envFromHost: [] },
    });
    const expert = await store.save(
      definitionInput("All tools", {
        connections: [{ id: "all-tools", required: true, tools: [], toolMode: "all" }],
      }),
    );
    await expect(store.preview({ expertId: expert.id, provider: "codex" })).resolves.toMatchObject({
      status: "available",
      issues: [],
    });

    const first = await store.prepareSnapshot(expert.id);
    const firstSnapshot = await store.readSnapshot(first.snapshotId);
    expect(firstSnapshot.mcpBinding).toMatchObject({
      authorizationId: expect.any(String),
      servers: [
        {
          id: "all-tools",
          configRevision: config.revision,
          required: true,
          toolMode: "all",
          tools: [],
        },
      ],
    });

    const second = await store.prepareSnapshot(expert.id);
    expect(second.snapshotId).not.toBe(first.snapshotId);
    expect((await store.readSnapshot(second.snapshotId)).mcpBinding?.authorizationId).not.toBe(
      firstSnapshot.mcpBinding?.authorizationId,
    );
  });

  it("continues to verify legacy snapshots without MCP binding or execute metadata", async () => {
    const root = await makeTempRoot();
    const stateDir = path.join(root, "state");
    const store = createExpertStore(stateDir);
    const reference = path.join(root, "legacy-reference.md");
    await writeFile(reference, "Legacy reference body", "utf8");
    const expert = await store.save(
      definitionInput("Legacy snapshot hash", { references: [reference] }),
    );
    const current = await store.prepareSnapshot(expert.id);
    const snapshotsDir = path.join(stateDir, "experts", "snapshots");
    const currentDir = path.join(snapshotsDir, current.snapshotId);
    const manifestPath = path.join(currentDir, "snapshot.json");
    const stored = JSON.parse(await readFile(manifestPath, "utf8")) as {
      snapshot: {
        snapshotId: string;
        expertId: string;
        displayName: string;
        revision: number;
        description: string;
        useCases: string;
        persona: string;
        outputRequirements: string;
        skills: Array<{ name: string; path: string }>;
        schemaVersion?: number;
        skillSelections?: unknown[];
        skillEntries?: unknown[];
        skillsRoot: string;
        references: string[];
        connections: ExpertSaveInput["connections"];
        preferredProvider?: string;
        mcpBinding?: unknown;
        createdAt: string;
      };
      resources: Array<{
        path: string;
        kind: "file" | "directory";
        size: number;
        sha256: string;
        executable?: boolean;
      }>;
    };
    delete stored.snapshot.schemaVersion;
    delete stored.snapshot.skillSelections;
    delete stored.snapshot.skillEntries;
    delete stored.snapshot.mcpBinding;
    for (const resource of stored.resources) delete resource.executable;
    const payload = {
      expertId: stored.snapshot.expertId,
      displayName: stored.snapshot.displayName,
      revision: stored.snapshot.revision,
      description: stored.snapshot.description,
      useCases: stored.snapshot.useCases,
      persona: stored.snapshot.persona,
      outputRequirements: stored.snapshot.outputRequirements,
      skills: stored.snapshot.skills.map(({ name, path: skillPath }) => ({
        name,
        path: skillPath,
      })),
      skillsRoot: "skills",
      references: stored.snapshot.references,
      connections: stored.snapshot.connections,
      preferredProvider: stored.snapshot.preferredProvider ?? null,
      resources: [...stored.resources].sort((left, right) => left.path.localeCompare(right.path)),
    };
    const stableJson = (value: unknown): string => {
      const sort = (item: unknown): unknown => {
        if (Array.isArray(item)) return item.map(sort);
        if (item !== null && typeof item === "object") {
          return Object.fromEntries(
            Object.entries(item)
              .sort(([left], [right]) => left.localeCompare(right))
              .map(([key, child]) => [key, sort(child)]),
          );
        }
        return item;
      };
      return JSON.stringify(sort(value));
    };
    const legacySnapshotId = `exp_${createHash("sha256").update(stableJson(payload)).digest("hex")}`;
    stored.snapshot.snapshotId = legacySnapshotId;
    const legacyDir = path.join(snapshotsDir, legacySnapshotId);
    await mkdir(legacyDir, { mode: 0o700 });
    await mkdir(path.join(legacyDir, "skills"), { mode: 0o700 });
    await mkdir(path.join(legacyDir, "references"), { mode: 0o700 });
    const legacyResource = stored.resources.find((resource) => resource.kind === "file")!;
    const legacyResourcePath = path.join(legacyDir, ...legacyResource.path.split("/"));
    await mkdir(path.dirname(legacyResourcePath), { recursive: true, mode: 0o700 });
    await writeFile(legacyResourcePath, "Legacy reference body", { mode: 0o400 });
    await writeFile(path.join(legacyDir, "snapshot.json"), `${JSON.stringify(stored, null, 2)}\n`);

    const restored = await store.readSnapshot(legacySnapshotId);
    expect(restored.snapshotId).toBe(legacySnapshotId);
    expect(restored.mcpBinding).toBeUndefined();
  });

  it("requires legacy local skill paths to be converted before Expert use", async () => {
    const root = await makeTempRoot();
    const stateDir = path.join(root, "state");
    const skill = path.join(root, "missing", "legacy", "SKILL.md");

    const store = createExpertStore(stateDir);
    const expert = await store.save(
      definitionInput("Legacy skill path", {
        skills: [{ name: "Legacy", path: skill }],
      }),
    );
    const preview = await store.preview({ expertId: expert.id, provider: "codex" });
    expect(preview.status).toBe("incompatible");
    expect(preview.issues).toEqual(["此专家仍使用旧式本机技能路径；转换为共享技能包后才能启动。"]);
    await expect(store.prepareSnapshot(expert.id)).rejects.toMatchObject({
      code: "invalid_resource",
      message: expect.stringContaining("convert its skills to shared packages"),
    });
  });

  it.skipIf(process.platform === "win32")(
    "publishes durable resource modes before locking the snapshot root",
    async () => {
      const root = await makeTempRoot();
      const stateDir = path.join(root, "state");
      const reference = path.join(root, "reference.md");
      await writeFile(reference, "read-only reference", { mode: 0o600 });

      const store = createExpertStore(stateDir);
      const expert = await store.save(
        definitionInput("Snapshot publish boundary", {
          references: [reference],
        }),
      );
      const renameMock = vi.mocked(rename);
      const realRename = nodeFs.promises.rename.bind(nodeFs.promises);
      let sawStagingRename = false;
      renameMock.mockImplementation(async (source, destination) => {
        if (path.basename(String(source)).startsWith(".staging-")) {
          const stagePath = String(source);
          const stored = JSON.parse(
            await readFile(path.join(stagePath, "snapshot.json"), "utf8"),
          ) as {
            snapshot: { snapshotId: string };
            resources: Array<{
              path: string;
              kind: "file" | "directory";
              executable?: boolean;
            }>;
          };
          expect((await stat(stagePath)).mode & 0o777).toBe(0o700);
          expect((await stat(path.join(stagePath, "snapshot.json"))).mode & 0o777).toBe(0o400);
          await expect(lstat(path.join(stagePath, "skills"))).rejects.toMatchObject({
            code: "ENOENT",
          });
          expect((await stat(path.join(stagePath, "references"))).mode & 0o777).toBe(0o500);
          for (const resource of stored.resources) {
            const resourcePath = path.join(stagePath, ...resource.path.split("/"));
            const mode = (await stat(resourcePath)).mode & 0o777;
            expect(mode).toBe(
              resource.kind === "directory" || resource.executable === true ? 0o500 : 0o400,
            );
          }
          await realRename(source, destination);
          expect((await stat(String(destination))).mode & 0o777).toBe(0o700);
          const verified = await readVerifiedStoredExpertSnapshot(
            String(destination),
            stored.snapshot.snapshotId,
          );
          expect(verified.snapshotId).toBe(stored.snapshot.snapshotId);
          sawStagingRename = true;
          return;
        }
        return realRename(source, destination);
      });

      try {
        const binding = await store.prepareSnapshot(expert.id);
        expect(sawStagingRename).toBe(true);
        const snapshot = await store.readSnapshot(binding.snapshotId);
        expect(snapshot.skills).toEqual([]);
        expect(await readFile(snapshot.references[0]!, "utf8")).toBe("read-only reference");
        expect((await stat(snapshot.references[0]!)).mode & 0o777).toBe(0o400);
      } finally {
        renameMock.mockImplementation(realRename);
      }
    },
  );

  it("keeps package files shared and copies references into a reusable immutable snapshot", async () => {
    const root = await makeTempRoot();
    const stateDir = path.join(root, "state");
    const skillRoot = path.join(root, "skills", "write-prd");
    const references = path.join(root, "prd-template.md");
    await writeSkill(skillRoot, "SKILL.md", "Write PRD", "Original skill text");
    await writeFile(path.join(skillRoot, "example.md"), "Skill companion file");
    await writeFile(references, "Original reference text");
    const manifest = await importSkillPackage(stateDir, skillRoot);

    const store = createExpertStore(stateDir);
    const definition = await store.save(
      definitionInput("Writer", {
        skillSelections: [
          {
            packageId: manifest.packageId,
            entryPath: manifest.entries[0]!.entryPath,
            activation: "startup",
          },
        ],
        references: [references],
      }),
    );
    const binding = await store.prepareSnapshot(definition.id);
    expect(await store.prepareSnapshot(definition.id)).toEqual(binding);
    const snapshot = await store.readSnapshot(binding.snapshotId);
    expect(snapshot.skillsRoot).toBe(path.join(stateDir, "experts", "skill-packages"));
    expect(await readFile(snapshot.skills[0]!.path, "utf8")).toContain("Original skill text");
    expect(
      await readFile(path.join(path.dirname(snapshot.skills[0]!.path), "example.md"), "utf8"),
    ).toBe("Skill companion file");
    expect(await readFile(snapshot.references[0]!, "utf8")).toBe("Original reference text");

    await writeSkill(skillRoot, "SKILL.md", "Write PRD", "Changed source skill");
    await writeFile(references, "Changed source reference");
    expect(
      await readFile((await store.readSnapshot(binding.snapshotId)).skills[0]!.path, "utf8"),
    ).toContain("Original skill text");
    await chmod(snapshot.skills[0]!.path, 0o600);
    await writeFile(snapshot.skills[0]!.path, "Tampered snapshot");
    await expect(store.readSnapshot(binding.snapshotId)).rejects.toMatchObject({
      code: "snapshot_corrupt",
    });
  });

  it("reports missing and locally configured connection prerequisites", async () => {
    const root = await makeTempRoot();
    const stateDir = path.join(root, "state");
    const store = createExpertStore(stateDir);
    const required = await store.save(
      definitionInput("Required tool", {
        connections: [{ id: "git", required: true, tools: ["review"] }],
      }),
    );
    const optional = await store.save(
      definitionInput("Optional tool", {
        connections: [{ id: "docs", required: false, tools: ["search"] }],
      }),
    );

    const blocked = await store.preview({ expertId: required.id, provider: "codex" });
    expect(blocked.status).toBe("blocked");
    expect(blocked.issues.join(" ")).toContain("尚未配置");
    const partial = await store.preview({ expertId: optional.id, provider: "pi" });
    expect(partial.status).toBe("partial");
    expect(partial.issues.join(" ")).toContain("尚未配置");

    const disabled = await store.save(
      definitionInput("Disabled required tool", {
        connections: [{ id: "disabled", required: true, tools: ["run"], enabled: false }],
      }),
    );
    const disabledPreview = await store.preview({ expertId: disabled.id, provider: "codex" });
    expect(disabledPreview.status).toBe("available");
    expect(disabledPreview.issues).toEqual([]);

    await createExpertConnectionStore(stateDir).save({
      id: "git",
      name: "Git MCP",
      transport: { type: "stdio", command: "git-mcp", args: [], envFromHost: [] },
    });
    const configured = await store.preview({ expertId: required.id, provider: "codex" });
    expect(configured.status).toBe("available");
    expect(configured.issues).toEqual([]);
  });

  it.skipIf(process.platform === "win32")(
    "rejects symlink escapes inside selected references",
    async () => {
      const root = await makeTempRoot();
      const referenceRoot = path.join(root, "references", "unsafe");
      const outside = path.join(root, "outside.txt");
      await mkdir(referenceRoot, { recursive: true });
      await writeFile(path.join(referenceRoot, "reference.md"), "Reference content");
      await writeFile(outside, "outside secret");
      await symlink(outside, path.join(referenceRoot, "linked.txt"));

      const store = createExpertStore(path.join(root, "state"));
      const definition = await store.save(
        definitionInput("Unsafe reference", { references: [referenceRoot] }),
      );
      expect((await store.preview({ expertId: definition.id, provider: "pi" })).status).toBe(
        "incompatible",
      );
      await expect(store.prepareSnapshot(definition.id)).rejects.toMatchObject({
        code: "invalid_resource",
      });
    },
  );

  it("pins package selections in V2 snapshots without copying skills", async () => {
    const root = await makeTempRoot();
    const stateDir = path.join(root, "state");
    const sourceRoot = path.join(root, "source", "writer");
    await writeSkill(sourceRoot, "SKILL.md", "Writer", "Original package version");
    const firstPackage = await importSkillPackage(stateDir, sourceRoot);

    await writeSkill(sourceRoot, "SKILL.md", "Writer", "Updated source version");
    const secondPackage = await importSkillPackage(stateDir, sourceRoot);
    expect(secondPackage.packageId).not.toBe(firstPackage.packageId);

    const reference = path.join(root, "reference.md");
    await writeFile(reference, "Pinned reference body");
    const store = createExpertStore(stateDir);
    const definition = await store.save(
      definitionInput("Package based writer", {
        skillSelections: [
          {
            packageId: firstPackage.packageId,
            entryPath: firstPackage.entries[0]!.entryPath,
            activation: "startup",
          },
        ],
        references: [reference],
      }),
    );
    const binding = await store.prepareSnapshot(definition.id);

    await rm(sourceRoot, { recursive: true, force: true });
    const snapshot = await store.readSnapshot(binding.snapshotId);
    const expectedSkillPath = path.join(
      stateDir,
      "experts",
      "skill-packages",
      firstPackage.packageId,
      "content",
      ...firstPackage.entries[0]!.entryPath.split("/"),
    );
    const preview = await store.preview({ expertId: definition.id, provider: "codex" });
    expect(preview.skillEntries).toEqual([
      {
        packageId: firstPackage.packageId,
        entryPath: firstPackage.entries[0]!.entryPath,
        activation: "startup",
        name: "Writer",
        description: "Description for Writer.",
        path: expectedSkillPath,
      },
    ]);
    expect(snapshot).toMatchObject({
      schemaVersion: 2,
      skillSelections: [
        {
          packageId: firstPackage.packageId,
          entryPath: firstPackage.entries[0]!.entryPath,
          activation: "startup",
        },
      ],
      skills: [{ name: "Writer", path: expectedSkillPath }],
      skillEntries: [
        {
          packageId: firstPackage.packageId,
          entryPath: firstPackage.entries[0]!.entryPath,
          activation: "startup",
          name: "Writer",
          description: "Description for Writer.",
          path: expectedSkillPath,
        },
      ],
    });
    expect(await readFile(expectedSkillPath, "utf8")).toContain("Original package version");
    expect(await readFile(snapshot.references[0]!, "utf8")).toBe("Pinned reference body");

    const stored = JSON.parse(
      await readFile(
        path.join(stateDir, "experts", "snapshots", binding.snapshotId, "snapshot.json"),
        "utf8",
      ),
    ) as {
      snapshot: { schemaVersion: number; skills: unknown[]; skillSelections?: unknown[] };
      resources: Array<{ path: string }>;
    };
    expect(stored.snapshot).toMatchObject({
      schemaVersion: 2,
      skills: [],
      skillSelections: snapshot.skillSelections,
    });
    expect("skillEntries" in stored.snapshot).toBe(false);
    expect(
      stored.resources.every(({ path: resourcePath }) => resourcePath.startsWith("references/")),
    ).toBe(true);
    await expect(
      lstat(path.join(stateDir, "experts", "snapshots", binding.snapshotId, "skills")),
    ).rejects.toMatchObject({ code: "ENOENT" });

    const manifestPath = path.join(
      stateDir,
      "experts",
      "snapshots",
      binding.snapshotId,
      "snapshot.json",
    );
    await chmod(manifestPath, 0o600);
    stored.snapshot.skillSelections = [];
    await writeFile(manifestPath, `${JSON.stringify(stored, null, 2)}\n`);
    await expect(store.readSnapshot(binding.snapshotId)).rejects.toMatchObject({
      code: "snapshot_corrupt",
      message: expect.stringContaining("hash"),
    });
    delete stored.snapshot.skillSelections;
    await writeFile(manifestPath, `${JSON.stringify(stored, null, 2)}\n`);
    await expect(store.readSnapshot(binding.snapshotId)).rejects.toMatchObject({
      code: "snapshot_corrupt",
    });
  });

  it("blocks BMad startup entries when the workspace is not configured", async () => {
    const root = await makeTempRoot();
    const stateDir = path.join(root, "state");
    const sourceRoot = path.join(root, "source", "bmad-role");
    await writeSkill(sourceRoot, "SKILL.md", "bmad-agent-analyst");
    const manifest = await importSkillPackage(stateDir, sourceRoot);
    const store = createExpertStore(stateDir);
    const expert = await store.save(
      definitionInput("BMad analyst", {
        skillSelections: [
          {
            packageId: manifest.packageId,
            entryPath: manifest.entries[0]!.entryPath,
            activation: "startup",
          },
        ],
      }),
    );

    const preview = await store.preview({ expertId: expert.id, provider: "codex", cwd: root });
    expect(preview.status).toBe("blocked");
    expect(preview.issues.some((issue) => issue.startsWith("BMad workspace:"))).toBe(true);
  });

  it("rejects invalid package selections and detects missing or corrupted packages", async () => {
    const root = await makeTempRoot();
    const stateDir = path.join(root, "state");
    const sourceRoot = path.join(root, "source", "reviewer");
    await writeSkill(sourceRoot, "one/SKILL.md", "Same name");
    await writeSkill(sourceRoot, "two/SKILL.md", "Same name");
    const manifest = await importSkillPackage(stateDir, sourceRoot);
    const store = createExpertStore(stateDir);
    const selections = manifest.entries.map((entry, index) => ({
      packageId: manifest.packageId,
      entryPath: entry.entryPath,
      activation: index === 0 ? ("startup" as const) : ("on-demand" as const),
    }));

    await expect(
      store.save(definitionInput("Duplicate selected skill", { skillSelections: selections })),
    ).rejects.toMatchObject({ code: "invalid_resource" });
    await expect(
      store.save(
        definitionInput("Missing package", {
          skillSelections: [
            {
              packageId: `pkg_${"f".repeat(64)}`,
              entryPath: "one/SKILL.md",
              activation: "startup",
            },
          ],
        }),
      ),
    ).rejects.toMatchObject({ code: "invalid_resource" });
    await expect(
      store.save(
        definitionInput("Mixed skill sources", {
          skills: [{ name: "Legacy", path: "/missing/SKILL.md" }],
          skillSelections: [selections[0]!],
        }),
      ),
    ).rejects.toMatchObject({ code: "invalid_input" });

    await expect(
      store.save(
        definitionInput("Multiple startup skills", {
          skillSelections: [
            { ...selections[0]!, activation: "startup" },
            { ...selections[1]!, activation: "startup" },
          ],
        }),
      ),
    ).rejects.toMatchObject({ code: "invalid_resource" });

    const validPackage = await importSkillPackage(
      stateDir,
      await (async () => {
        const validRoot = path.join(root, "source", "valid");
        await writeSkill(validRoot, "SKILL.md", "Valid");
        return validRoot;
      })(),
    );
    const expert = await store.save(
      definitionInput("Corrupt package", {
        skillSelections: [
          {
            packageId: validPackage.packageId,
            entryPath: validPackage.entries[0]!.entryPath,
            activation: "startup",
          },
        ],
      }),
    );
    const binding = await store.prepareSnapshot(expert.id);
    const packageSkill = path.join(
      stateDir,
      "experts",
      "skill-packages",
      validPackage.packageId,
      "content",
      ...validPackage.entries[0]!.entryPath.split("/"),
    );
    await chmod(packageSkill, 0o600);
    await writeFile(packageSkill, "Corrupt package content");
    expect((await store.preview({ expertId: expert.id, provider: "codex" })).status).toBe(
      "incompatible",
    );
    await expect(store.readSnapshot(binding.snapshotId)).rejects.toMatchObject({
      code: "snapshot_corrupt",
    });
  });

  it("retains every previous definition revision before changing or deleting it", async () => {
    const root = await makeTempRoot();
    const stateDir = path.join(root, "state");
    const firstRoot = path.join(root, "source", "first");
    const secondRoot = path.join(root, "source", "second");
    await writeSkill(firstRoot, "SKILL.md", "First");
    await writeSkill(secondRoot, "SKILL.md", "Second");
    const firstPackage = await importSkillPackage(stateDir, firstRoot);
    const secondPackage = await importSkillPackage(stateDir, secondRoot);
    const store = createExpertStore(stateDir);
    const expert = await store.save(
      definitionInput("Revision history", {
        skillSelections: [
          {
            packageId: firstPackage.packageId,
            entryPath: firstPackage.entries[0]!.entryPath,
            activation: "startup",
          },
        ],
      }),
    );
    const updated = await store.save({
      ...definitionInput("Revision history", {
        skillSelections: [
          {
            packageId: secondPackage.packageId,
            entryPath: secondPackage.entries[0]!.entryPath,
            activation: "startup",
          },
        ],
      }),
      id: expert.id,
      expectedRevision: expert.revision,
    });
    const revisionsDir = path.join(stateDir, "experts", "revisions", expert.id);
    const readRevision = async (revision: number) =>
      JSON.parse(await readFile(path.join(revisionsDir, `${revision}.json`), "utf8")) as {
        revision: number;
        skillSelections?: Array<{ packageId: string }>;
      };
    expect(await readRevision(1)).toMatchObject({
      revision: 1,
      skillSelections: [{ packageId: firstPackage.packageId }],
    });

    const archived = await store.archive(updated.id, updated.revision);
    expect(await readRevision(2)).toMatchObject({ revision: 2, archived: false });
    const restored = await store.restore(archived.id, archived.revision);
    expect(await readRevision(3)).toMatchObject({ revision: 3, archived: true });
    await store.remove(restored.id, restored.revision);
    expect(await readRevision(4)).toMatchObject({ revision: 4, archived: false });
    expect(await store.read(expert.id)).toBeNull();
  });
});
