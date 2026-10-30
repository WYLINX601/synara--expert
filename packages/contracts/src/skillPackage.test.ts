import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
  ExpertSkillSelection,
  SkillEntryPath,
  SkillPackageId,
  SkillPackageImportInput,
} from "./skillPackage";

const packageId = `pkg_${"a".repeat(64)}`;

describe("skill package contracts", () => {
  it.each(["SKILL.md", "skills/bmad-pm/SKILL.md", "模块/入口/SKILL.md", "native:posix/SKILL.md"])(
    "accepts package-relative entries: %s",
    (entryPath) => {
      expect(Schema.decodeUnknownSync(SkillEntryPath)(entryPath)).toBe(entryPath);
    },
  );

  it.each([
    "../SKILL.md",
    "a/../SKILL.md",
    "./SKILL.md",
    "a/./SKILL.md",
    "/SKILL.md",
    "C:/SKILL.md",
    "a\\SKILL.md",
    "a//SKILL.md",
    "a/\0/SKILL.md",
    "a/README.md",
  ])("rejects unsafe or non-entry paths: %s", (entryPath) => {
    expect(Schema.is(SkillEntryPath)(entryPath)).toBe(false);
  });

  it("validates content-addressed package IDs", () => {
    expect(Schema.is(SkillPackageId)(packageId)).toBe(true);
    for (const input of [
      "pkg_abc",
      `pkg_${"A".repeat(64)}`,
      `exp_${"a".repeat(64)}`,
      "../../other",
    ]) {
      expect(Schema.is(SkillPackageId)(input)).toBe(false);
    }
  });

  it("uses native loading and rejects loading-time settings or extra selection authority", () => {
    const selection = { packageId, entryPath: "skills/pm/SKILL.md" };
    expect(Schema.decodeUnknownSync(ExpertSkillSelection)(selection)).toEqual(selection);
    expect(Schema.is(ExpertSkillSelection)({ ...selection, activation: "startup" })).toBe(false);
    expect(() =>
      Schema.decodeUnknownSync(ExpertSkillSelection)({ ...selection, path: "/local/SKILL.md" }),
    ).toThrow();
    expect(
      Schema.decodeUnknownSync(ExpertSkillSelection)({ packageId, entryPath: "SKILL.md" }),
    ).toEqual({ packageId, entryPath: "SKILL.md" });
  });

  it("accepts only the server-owned preview token at confirmation", () => {
    expect(
      Schema.decodeUnknownSync(SkillPackageImportInput)({ previewId: "server-token" }),
    ).toEqual({ previewId: "server-token" });
    expect(() =>
      Schema.decodeUnknownSync(SkillPackageImportInput)({
        previewId: "token",
        path: "/substitute",
      }),
    ).toThrow();
  });
});
