import { describe, expect, it } from "vitest";
import type { ExpertSkillSelection, SkillPackage } from "@synara/contracts";
import {
  setExpertSkillSelectionActivation,
  switchExpertSkillEntryVersion,
  toggleExpertSkillSelection,
} from "./expertSkillPackagesSettingsModel";

const packageId = (character: string) => `pkg_${character.repeat(64)}`;
const entry = (entryPath: string, name = "planner") => ({
  entryPath,
  name,
  description: "Plan implementation work",
  issues: [],
});
const skillPackage = (character: string, entries: ReturnType<typeof entry>[]): SkillPackage => ({
  schemaVersion: 1,
  packageId: packageId(character),
  rootName: "agent-skills",
  resources: [],
  entries,
  fileCount: 0,
  totalBytes: 0,
});

describe("expertSkillPackagesSettingsModel", () => {
  it("adds and removes the exact package entry while preserving other versions", () => {
    const first: ExpertSkillSelection = {
      packageId: packageId("a"),
      entryPath: "planner/SKILL.md",
      activation: "startup",
    };
    const second: ExpertSkillSelection = {
      ...first,
      packageId: packageId("b"),
    };
    const selected = toggleExpertSkillSelection([first], second, true);
    expect(selected).toEqual([first, second]);
    expect(toggleExpertSkillSelection(selected, first, false)).toEqual([second]);
  });

  it("keeps at most one startup activation after an explicit activation change", () => {
    const selections: ExpertSkillSelection[] = [
      { packageId: packageId("a"), entryPath: "a/SKILL.md", activation: "startup" },
      { packageId: packageId("b"), entryPath: "b/SKILL.md", activation: "on-demand" },
    ];
    expect(setExpertSkillSelectionActivation(selections, selections[1]!, "startup")).toEqual([
      { ...selections[0]!, activation: "on-demand" },
      { ...selections[1]!, activation: "startup" },
    ]);
  });

  it("switches one selected entry to an explicitly chosen package version", () => {
    const oldPackage = skillPackage("a", [entry("planner/SKILL.md")]);
    const nextPackage = skillPackage("b", [entry("agents/planner/SKILL.md")]);
    const unrelatedPackage = skillPackage("c", [entry("reviewer/SKILL.md", "reviewer")]);
    const selected: ExpertSkillSelection[] = [
      {
        packageId: oldPackage.packageId,
        entryPath: "planner/SKILL.md",
        activation: "startup",
      },
    ];

    expect(
      switchExpertSkillEntryVersion(
        selected,
        [oldPackage, nextPackage, unrelatedPackage],
        nextPackage,
        "agents/planner/SKILL.md",
      ),
    ).toEqual([
      {
        ...selected[0]!,
        packageId: nextPackage.packageId,
        entryPath: "agents/planner/SKILL.md",
      },
    ]);
    expect(
      switchExpertSkillEntryVersion(
        selected,
        [oldPackage, unrelatedPackage],
        unrelatedPackage,
        "reviewer/SKILL.md",
      ),
    ).toEqual(selected);
  });
});
