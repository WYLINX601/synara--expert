import * as fs from "node:fs/promises";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";

import {
  BMAD_ROLE_PRESETS,
  bmadPresetSelections,
  inspectBmadWorkspace,
} from "./bmadSkillPreset.ts";
import { createSkillPackageStore } from "./SkillPackageStore.ts";
import { createExpertStore, expertResourceFiles } from "./ExpertStore.ts";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await expertResourceFiles.removeStaging(root);
});

describe("BMad preset", () => {
  it("pins six different role entries and only reviewed workflows to a single package", async () => {
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
    const startupPaths = new Set<string>();
    for (const preset of BMAD_ROLE_PRESETS) {
      const selections = bmadPresetSelections(imported.package, preset.id);
      expect(selections.filter((selection) => selection.activation === "startup")).toHaveLength(1);
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
      expect(
        snapshot.skillEntries?.every((entry) => entry.packageId === imported.package.packageId),
      ).toBe(true);
      startupPaths.add(
        snapshot.skillEntries!.find((entry) => entry.activation === "startup")!.path,
      );
      expect(
        await fs.readdir(path.join(state, "experts", "snapshots", binding.snapshotId)),
      ).not.toContain("skills");
    }
    expect(startupPaths.size).toBe(6);
    expect(await packages.list()).toHaveLength(1);
  });

  it("blocks missing project prerequisites without writing or installing, and fingerprints configuration", async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), "bmad-workspace-")));
    roots.push(root);
    const entries = [{ name: "bmad-agent-pm", activation: "startup" as const }];
    expect((await inspectBmadWorkspace(entries, root, () => null))?.issues).toEqual([
      expect.stringContaining("missing _bmad/"),
    ]);
    await fs.mkdir(path.join(root, "_bmad", "scripts"), { recursive: true });
    for (const file of [
      "config.toml",
      "scripts/resolve_config.py",
      "scripts/resolve_customization.py",
    ])
      await fs.writeFile(path.join(root, "_bmad", file), "fixture");
    expect((await inspectBmadWorkspace(entries, root, () => null))?.issues).toEqual([
      expect.stringContaining("requires uv"),
    ]);
    const before = await inspectBmadWorkspace(entries, root, () => "/mock/uv");
    expect(before?.issues).toEqual([]);
    expect(before?.configurationHash).toMatch(/^[a-f0-9]{64}$/u);
    await fs.writeFile(path.join(root, "_bmad", "config.toml"), "changed");
    expect(
      (await inspectBmadWorkspace(entries, root, () => "/mock/uv"))?.configurationHash,
    ).not.toBe(before?.configurationHash);
    expect(await inspectBmadWorkspace([], undefined, () => null)).toBeNull();
  });
});
