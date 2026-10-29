import { describe, expect, it } from "vitest";
import {
  assertSkillEvolutionConfiguration,
  assertSkillScopeForExpert,
  effectiveSkillEvolutionPolicy,
  effectiveSkillScope,
} from "./skillEvolutionPolicy";

describe("Skill evolution policy defaults and scope rules", () => {
  it("treats historical Skill metadata as protected and shared", () => {
    expect(effectiveSkillEvolutionPolicy({})).toBe("protected");
    expect(effectiveSkillScope({})).toEqual({ kind: "shared" });
  });

  it("allows explicit private-to-shared configuration while preventing ownership transfer", () => {
    expect(() =>
      assertSkillEvolutionConfiguration({
        current: { scope: { kind: "expert", expertId: "expert-a" } },
        evolutionPolicy: "shared",
        scope: { kind: "shared" },
      }),
    ).not.toThrow();
    expect(() =>
      assertSkillEvolutionConfiguration({
        current: { scope: { kind: "expert", expertId: "expert-a" } },
        evolutionPolicy: "independent",
        scope: { kind: "expert", expertId: "expert-b" },
      }),
    ).toThrow(/cannot be transferred/u);
    expect(() =>
      assertSkillEvolutionConfiguration({
        current: {},
        evolutionPolicy: "independent",
        scope: { kind: "expert", expertId: "expert-a" },
      }),
    ).toThrow(/derive a private copy/u);
  });

  it("allows shared independent originals and checks every private target Expert", () => {
    expect(() =>
      assertSkillEvolutionConfiguration({
        evolutionPolicy: "independent",
        scope: { kind: "shared" },
      }),
    ).not.toThrow();
    expect(() =>
      assertSkillScopeForExpert(
        {
          skillId: "skl_00000000000000000000000000000000",
          scope: { kind: "expert", expertId: "expert-a" },
        },
        "expert-b",
      ),
    ).toThrow(/belongs to Expert expert-a/u);
    expect(() =>
      assertSkillScopeForExpert(
        {
          skillId: "skl_00000000000000000000000000000000",
          scope: { kind: "expert", expertId: "expert-a" },
        },
        "expert-a",
      ),
    ).not.toThrow();
  });
});
