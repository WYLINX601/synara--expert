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
