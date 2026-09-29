// FILE: expertSkillsSettingsModel.test.ts
// Purpose: Verify Expert skill draft editing, path de-duplication, and save validation.
// Layer: Web settings logic tests

import type { ProviderSkillReference } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import {
  addExpertSkillReference,
  expertSkillPathKey,
  removeExpertSkillReference,
  removeExpertSkillReferencesByPath,
  updateExpertSkillReference,
  validateExpertSkillReferences,
} from "./expertSkillsSettingsModel";

const initialSkills: ProviderSkillReference[] = [
  { name: "review", path: "/Users/test/skills/review/SKILL.md" },
  { name: "release", path: "/Users/test/skills/release/SKILL.md" },
];

describe("Expert skill reference editing", () => {
  it("adds a blank local reference row that can be completed later", () => {
    expect(addExpertSkillReference([])).toEqual([{ name: "", path: "" }]);
  });

  it("updates one reference immutably and preserves the others", () => {
    const updated = updateExpertSkillReference(initialSkills, 1, {
      name: "release notes",
      path: "/Users/test/skills/release/ENTRY.md",
    });

    expect(updated).toEqual([
      initialSkills[0],
      { name: "release notes", path: "/Users/test/skills/release/ENTRY.md" },
    ]);
    expect(initialSkills[1]).toEqual({
      name: "release",
      path: "/Users/test/skills/release/SKILL.md",
    });
  });

  it("removes one reference by index", () => {
    expect(removeExpertSkillReference(initialSkills, 0)).toEqual([initialSkills[1]]);
  });

  it("adds a catalog reference only once for normalized path spellings", () => {
    const duplicate = { name: "review copy", path: "\\Users\\test\\skills\\review\\.\\SKILL.md" };

    expect(addExpertSkillReference(initialSkills, duplicate)).toEqual(initialSkills);
    expect(removeExpertSkillReferencesByPath(initialSkills, duplicate.path)).toEqual([
      initialSkills[1],
    ]);
    expect(expertSkillPathKey("/Users/test/skills/review/../review/SKILL.md")).toBe(
      expertSkillPathKey(initialSkills[0]!.path),
    );
  });
});

describe("validateExpertSkillReferences", () => {
  it("allows an empty list and distinct complete paths", () => {
    expect(validateExpertSkillReferences([])).toEqual([]);
    expect(validateExpertSkillReferences(initialSkills)).toEqual([]);
  });

  it("reports blank names and paths on the corresponding row and field", () => {
    expect(validateExpertSkillReferences([{ name: "  ", path: " " }])).toEqual([
      { index: 0, field: "name", message: "请填写技能名称。" },
      {
        index: 0,
        field: "path",
        message: "请填写本机技能入口文件路径，例如 SKILL.md。",
      },
    ]);
  });

  it("rejects duplicate paths after separator and dot-segment normalization", () => {
    const issues = validateExpertSkillReferences([
      initialSkills[0]!,
      {
        name: "review alias",
        path: "\\Users\\test\\skills\\review\\.\\SKILL.md",
      },
    ]);

    expect(issues).toEqual([
      {
        index: 1,
        field: "path",
        message: "此路径与第 1 条技能重复，请修改路径或移除重复项。",
      },
    ]);
  });
});
