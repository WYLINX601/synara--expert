import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
  ExpertSkillBinding,
  SkillDefinition,
  SkillLibraryItem,
  SkillLibraryQuery,
  SkillLibraryRequest,
} from "./skillLibrary";
import { ExpertSkillSelection } from "./skillPackage";
import { SkillEvolutionRequest } from "./skillEvolution";

const skillId = `skl_${"a".repeat(32)}`;
const packageId = `pkg_${"b".repeat(64)}`;

describe("Expert Skill binding contracts", () => {
  it.each([true, false])(
    "keeps explicit improvement permission %s on the binding",
    (allowEvolution) => {
      expect(
        Schema.decodeUnknownSync(ExpertSkillBinding)({
          skillId,
          enabled: false,
          allowEvolution,
          selectionScope: "package",
          resourceMode: "run-private",
        }),
      ).toEqual({
        skillId,
        enabled: false,
        allowEvolution,
        selectionScope: "package",
        resourceMode: "run-private",
      });
    },
  );

  it("requires a boolean permission and never infers it from a Skill policy", () => {
    expect(() =>
      Schema.decodeUnknownSync(ExpertSkillBinding)({
        skillId,
        enabled: true,
        allowEvolution: "true",
      }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(ExpertSkillBinding)({
        skillId,
        enabled: true,
        evolutionPolicy: "independent",
      }),
    ).toThrow();
  });
  it("keeps selection scope and resource defaults without a loading-time setting", () => {
    expect(
      Schema.decodeUnknownSync(ExpertSkillBinding)({
        skillId,
        enabled: true,
      }),
    ).toEqual({ skillId, enabled: true });
    expect(
      Schema.decodeUnknownSync(ExpertSkillSelection)({
        packageId,
        entryPath: "SKILL.md",
      }),
    ).toEqual({ packageId, entryPath: "SKILL.md" });
    expect(
      Schema.decodeUnknownSync(ExpertSkillBinding)({
        skillId,
        enabled: true,
        selectionScope: "package",
        resourceMode: "run-private",
      }),
    ).toMatchObject({ selectionScope: "package", resourceMode: "run-private" });
  });

  it.each(["startup", "on-demand"])("rejects the removed %s activation setting", (activation) => {
    expect(() =>
      Schema.decodeUnknownSync(ExpertSkillBinding)({ skillId, enabled: true, activation }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(ExpertSkillSelection)({
        packageId,
        entryPath: "SKILL.md",
        activation,
      }),
    ).toThrow();
  });

  it("rejects the removed binding conversion operation", () => {
    expect(() =>
      Schema.decodeUnknownSync(SkillLibraryRequest)({
        action: "bindings",
        operation: "convert",
        expertId: "expert-a",
        expectedRevision: 2,
        requestId: "removed-conversion",
        dryRun: true,
      }),
    ).toThrow();
  });
});

describe("Expert-owned Skill improvement contracts", () => {
  it.each([
    { evolutionPolicy: "independent" },
    { scope: { kind: "expert", expertId: "expert-a" } },
  ])("rejects global policy or ownership authoring on create: %j", (retiredField) => {
    expect(() =>
      Schema.decodeUnknownSync(SkillLibraryRequest)({
        action: "create",
        name: "Skill",
        body: "Skill body",
        tags: [],
        ...retiredField,
      }),
    ).toThrow();
  });

  it("rejects the retired global strategy operation", () => {
    expect(() =>
      Schema.decodeUnknownSync(SkillLibraryRequest)({
        action: "configureEvolution",
        skillId,
        expectedRevision: 1,
        requestId: "retired-policy",
        evolutionPolicy: "shared",
        scope: { kind: "shared" },
      }),
    ).toThrow();
  });

  it("rejects strategy choices and extra approval flags on evolution requests", () => {
    expect(() =>
      Schema.decodeUnknownSync(SkillEvolutionRequest)({
        action: "start",
        requestId: "start",
        expertId: "expert-a",
        sources: [{ threadId: "thread-a", turnId: "turn-a" }],
        modelSelection: { provider: "pi", model: "selected-model" },
        protectedAction: "update",
      }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(SkillEvolutionRequest)({
        action: "apply",
        requestId: "start",
        proposalId: "proposal",
        expectedDigest: "a".repeat(64),
        operationId: "adopt",
        approveProtected: true,
      }),
    ).toThrow();
  });
});

describe("Skill library attribution contract", () => {
  it("drops legacy creator metadata from Skill definitions and list items", () => {
    const createdAt = "2026-10-20T00:00:00.000Z";
    const definition = Schema.decodeUnknownSync(SkillDefinition)({
      skillId,
      name: "Legacy Skill",
      description: "",
      tags: [],
      packageId,
      entryPath: "SKILL.md",
      source: { kind: "manual", location: "", entryPath: "SKILL.md", packageId },
      locallyModified: false,
      revision: 1,
      deleted: false,
      updatedAt: createdAt,
      createdAt,
      createdBy: "legacy-actor",
      evolutionPolicy: "shared",
      scope: { kind: "expert", expertId: "expert-a" },
    });
    const item = Schema.decodeUnknownSync(SkillLibraryItem)({
      skillId,
      createdAt,
      createdBy: "legacy-actor",
      usage: { expertIds: [], enabledExpertIds: [] },
    });

    expect(definition.createdAt).toBe(createdAt);
    expect(definition).not.toHaveProperty("createdBy");
    expect(definition).not.toHaveProperty("evolutionPolicy");
    expect(definition.scope).toEqual({ kind: "expert", expertId: "expert-a" });
    expect(item.createdAt).toBe(createdAt);
    expect(item).not.toHaveProperty("createdBy");
  });

  it("rejects the removed creator query field", () => {
    expect(() =>
      Schema.decodeUnknownSync(SkillLibraryQuery)({ createdBy: ["legacy-actor"] }),
    ).toThrow();
  });
});
