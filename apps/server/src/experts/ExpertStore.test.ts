import {
  chmod,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import * as path from "node:path";

import type { ExpertSaveInput } from "@synara/contracts";
import { afterEach, describe, expect, it } from "vitest";

import { createExpertStore } from "./ExpertStore.ts";
import { createExpertConnectionStore } from "./ExpertConnectionStore.ts";

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

  it("continues to verify a pre-MCP snapshot with its original content hash", async () => {
    const root = await makeTempRoot();
    const stateDir = path.join(root, "state");
    const store = createExpertStore(stateDir);
    const expert = await store.save(definitionInput("Legacy snapshot hash"));
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
        skillsRoot: string;
        references: string[];
        connections: ExpertSaveInput["connections"];
        preferredProvider?: string;
        mcpBinding?: unknown;
        createdAt: string;
      };
      resources: Array<{ path: string; kind: "file" | "directory"; size: number; sha256: string }>;
    };
    delete stored.snapshot.mcpBinding;
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
    await writeFile(path.join(legacyDir, "snapshot.json"), `${JSON.stringify(stored, null, 2)}\n`);

    const restored = await store.readSnapshot(legacySnapshotId);
    expect(restored.snapshotId).toBe(legacySnapshotId);
    expect(restored.mcpBinding).toBeUndefined();
  });

  it("copies resources into a reusable immutable snapshot", async () => {
    const root = await makeTempRoot();
    const stateDir = path.join(root, "state");
    const skillRoot = path.join(root, "skills", "write-prd");
    const references = path.join(root, "prd-template.md");
    await mkdir(skillRoot, { recursive: true });
    await writeFile(path.join(skillRoot, "SKILL.md"), "Original skill text");
    await writeFile(path.join(skillRoot, "example.md"), "Skill companion file");
    await writeFile(references, "Original reference text");

    const store = createExpertStore(stateDir);
    const definition = await store.save(
      definitionInput("Writer", {
        skills: [{ name: "Write PRD", path: path.join(skillRoot, "SKILL.md") }],
        references: [references],
      }),
    );
    const binding = await store.prepareSnapshot(definition.id);
    expect(await store.prepareSnapshot(definition.id)).toEqual(binding);
    const snapshot = await store.readSnapshot(binding.snapshotId);
    expect(snapshot.skillsRoot).toBe(
      path.join(stateDir, "experts", "snapshots", binding.snapshotId, "skills"),
    );
    expect(await readFile(snapshot.skills[0]!.path, "utf8")).toBe("Original skill text");
    expect(
      await readFile(path.join(path.dirname(snapshot.skills[0]!.path), "example.md"), "utf8"),
    ).toBe("Skill companion file");
    expect(await readFile(snapshot.references[0]!, "utf8")).toBe("Original reference text");

    await writeFile(path.join(skillRoot, "SKILL.md"), "Changed source skill");
    await writeFile(references, "Changed source reference");
    expect(
      await readFile((await store.readSnapshot(binding.snapshotId)).skills[0]!.path, "utf8"),
    ).toBe("Original skill text");
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
    "rejects symlink escapes inside selected resources",
    async () => {
      const root = await makeTempRoot();
      const skillRoot = path.join(root, "skills", "unsafe");
      const outside = path.join(root, "outside.txt");
      await mkdir(skillRoot, { recursive: true });
      await writeFile(path.join(skillRoot, "SKILL.md"), "Skill instructions");
      await writeFile(outside, "outside secret");
      await symlink(outside, path.join(skillRoot, "linked.txt"));

      const store = createExpertStore(path.join(root, "state"));
      const definition = await store.save(
        definitionInput("Unsafe", {
          skills: [{ name: "Unsafe skill", path: path.join(skillRoot, "SKILL.md") }],
        }),
      );
      expect((await store.preview({ expertId: definition.id, provider: "pi" })).status).toBe(
        "incompatible",
      );
      await expect(store.prepareSnapshot(definition.id)).rejects.toMatchObject({
        code: "invalid_resource",
      });
    },
  );
});
