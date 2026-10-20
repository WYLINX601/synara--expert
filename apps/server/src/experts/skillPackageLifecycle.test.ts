import * as fs from "node:fs/promises";
import * as path from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import { createExpertStore, expertResourceFiles } from "./ExpertStore.ts";
import { createSkillPackageStore } from "./SkillPackageStore.ts";
import { withSkillPackageLifecycle } from "./skillPackageLifecycle.ts";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await expertResourceFiles.removeStaging(root);
});

async function fixture() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), "skill-lifecycle-")));
  roots.push(root);
  const stateDir = path.join(root, "state");
  const source = path.join(root, "source");
  await fs.mkdir(source);
  await fs.writeFile(
    path.join(source, "SKILL.md"),
    "---\nname: role\ndescription: Test\n---\nRole",
  );
  const packages = createSkillPackageStore(stateDir);
  const preview = await packages.preview({ path: source });
  const imported = await packages.import({ previewId: preview.previewId });
  const experts = createExpertStore(stateDir);
  const definition = {
    id: "test",
    name: "Test",
    description: "",
    useCases: "",
    persona: "",
    outputRequirements: "",
    skills: [],
    skillSelections: [
      {
        packageId: imported.package.packageId,
        entryPath: "SKILL.md",
        activation: "startup" as const,
      },
    ],
    references: [],
    connections: [],
  };
  return { root, stateDir, source, packages, experts, definition, imported };
}

describe("skill package lifecycle", () => {
  it("removes an unused version and tracking pointer, preserving original files", async () => {
    const { source, packages, imported } = await fixture();
    expect(await packages.previewRemoval(imported.package.packageId)).toEqual({
      packageId: imported.package.packageId,
      references: [],
    });
    await packages.remove(imported.package.packageId);
    expect(await packages.list()).toEqual([]);
    expect(await packages.listSources()).toEqual([]);
    expect(await fs.readFile(path.join(source, "SKILL.md"), "utf8")).toContain("Role");
  });

  it("protects current and retained Expert revisions after edits and deletion", async () => {
    const { packages, experts, definition, imported } = await fixture();
    const saved = await experts.save(definition);
    await expect(packages.remove(imported.package.packageId)).rejects.toThrow("referenced");
    const updated = await experts.save({
      ...definition,
      skillSelections: [],
      expectedRevision: saved.revision,
    });
    await experts.archive(updated.id, updated.revision);
    await experts.remove(updated.id, updated.revision + 1);
    await expect(packages.remove(imported.package.packageId)).rejects.toThrow("referenced");
  });

  it("fails closed on corrupt reference records", async () => {
    const { stateDir, packages, imported } = await fixture();
    await fs.mkdir(path.join(stateDir, "experts", "definitions"), { recursive: true });
    await fs.writeFile(path.join(stateDir, "experts", "definitions", "broken.json"), "{}");
    await expect(packages.remove(imported.package.packageId)).rejects.toThrow();
    expect(await packages.read(imported.package.packageId)).toEqual(imported.package);
  });

  it("serializes a new durable reference before queued removal", async () => {
    const { stateDir, packages, experts, definition, imported } = await fixture();
    const save = experts.save(definition);
    const remove = packages.remove(imported.package.packageId);
    await save;
    await expect(remove).rejects.toThrow("referenced");
    await expect(withSkillPackageLifecycle(stateDir, async () => "unlocked")).resolves.toBe(
      "unlocked",
    );
  });

  it("replays a successful import after recreating the store and rejects key reuse", async () => {
    const { stateDir, source, packages } = await fixture();
    const preview = await packages.preview({ path: source });
    const input = { previewId: preview.previewId, idempotencyKey: "import-once" };
    const first = await packages.import(input);
    expect(await createSkillPackageStore(stateDir).import(input)).toEqual(first);
    const other = await packages.preview({ path: source });
    await expect(
      packages.import({ previewId: other.previewId, idempotencyKey: "import-once" }),
    ).rejects.toThrow("already used");
  });

  it("rejects native execution semantics and applies invocation metadata", async () => {
    const { source, packages } = await fixture();
    await fs.writeFile(
      path.join(source, "SKILL.md"),
      "---\nname: role\ndescription: Test\nhooks:\n  PreToolUse: []\n---\nBody",
    );
    const preview = await packages.preview({ path: source });
    const imported = await packages.import({ previewId: preview.previewId });
    await expect(
      packages.resolveSelections([
        {
          packageId: imported.package.packageId,
          entryPath: "SKILL.md",
          activation: "on-demand",
        },
      ]),
    ).rejects.toThrow("Incompatible");
    await fs.writeFile(
      path.join(source, "SKILL.md"),
      "---\nname: role\ndescription: Test\ndisable-model-invocation: true\nuser-invocable: false\n---\nBody",
    );
    const next = await packages.preview({ path: source });
    const nextPackage = await packages.import({ previewId: next.previewId });
    const selected = {
      packageId: nextPackage.package.packageId,
      entryPath: "SKILL.md",
      activation: "on-demand" as const,
    };
    expect((await packages.resolveSelections([selected]))[0]).toMatchObject({
      disableModelInvocation: true,
      userInvocable: false,
    });
    await expect(
      packages.resolveSelections([{ ...selected, activation: "startup" }]),
    ).rejects.toThrow("automatic invocation");
  });
});
