import * as fs from "node:fs/promises";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";

import { BMAD_ROLE_PRESETS, bmadPresetSelections } from "./bmadSkillPreset.ts";
import { createSkillPackageStore } from "./SkillPackageStore.ts";
import { createExpertStore, expertResourceFiles } from "./ExpertStore.ts";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await expertResourceFiles.removeStaging(root);
});

describe("BMad preset", () => {
  it("pins role entries and reviewed workflows as native on-demand Skills", async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), "bmad-package-")));
    roots.push(root);
    const source = path.join(root, "skills");
    const names = new Set([
      "bmad",
      ...BMAD_ROLE_PRESETS.flatMap((preset) => [preset.role, ...preset.workflows]),
    ]);
    for (const name of names) {
      await fs.mkdir(path.join(source, name), { recursive: true });
      await fs.writeFile(
        path.join(source, name, "SKILL.md"),
        `---\nname: ${name}\ndescription: fixture\n---\n${name}`,
      );
    }
    const state = path.join(root, "state");
    const packages = createSkillPackageStore(state);
    const preview = await packages.preview({ path: source });
    const imported = await packages.import({ previewId: preview.previewId });
    const experts = createExpertStore(state);
    const rolePaths = new Set<string>();
    for (const preset of BMAD_ROLE_PRESETS) {
      const selections = bmadPresetSelections(imported.package, preset.id);
      expect(selections.every((selection) => !Object.hasOwn(selection, "activation"))).toBe(true);
      expect(selections.map((selection) => selection.entryPath)).toEqual(
        [preset.role, "bmad", ...preset.workflows].map((name) => `${name}/SKILL.md`),
      );
      const definition = await experts.save({
        id: preset.id,
        name: preset.name,
        persona: "Preserved persona",
        description: "",
        useCases: "",
        outputRequirements: "",
        references: [],
        connections: [],
        skills: [],
        skillSelections: selections,
      });
      const binding = await experts.prepareSnapshot(definition.id);
      const snapshot = await experts.readSnapshot(binding.snapshotId);
      const preview = await experts.preview({ expertId: definition.id, provider: "codex" });
      expect(preview.status).toBe("available");
      expect(
        snapshot.skillEntries?.every((entry) => entry.packageId === imported.package.packageId),
      ).toBe(true);
      expect(snapshot.skillEntries?.every((entry) => !Object.hasOwn(entry, "activation"))).toBe(
        true,
      );
      rolePaths.add(snapshot.skillEntries!.find((entry) => entry.name === preset.role)!.path);
      expect(
        await fs.readdir(path.join(state, "experts", "snapshots", binding.snapshotId)),
      ).not.toContain("skills");
    }
    expect(rolePaths.size).toBe(6);
    expect(await packages.list()).toHaveLength(1);
  });
});
