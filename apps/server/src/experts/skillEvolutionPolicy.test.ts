import { describe, expect, it } from "vitest";
import { assertSkillScopeForExpert, effectiveSkillScope } from "./skillEvolutionPolicy";

describe("Skill scope ownership", () => {
  it("treats historical Skills without scope metadata as shared", () => {
    expect(effectiveSkillScope({})).toEqual({ kind: "shared" });
    expect(effectiveSkillScope({ scope: { kind: "expert", expertId: "expert-a" } })).toEqual({
      kind: "expert",
      expertId: "expert-a",
    });
  });

  it("limits Expert-specific Skills to their owning Expert", () => {
    const skill = {
      skillId: "skl_00000000000000000000000000000000",
      scope: { kind: "expert" as const, expertId: "expert-a" },
    };
    expect(() => assertSkillScopeForExpert(skill, "expert-a")).not.toThrow();
    expect(() => assertSkillScopeForExpert(skill, "expert-b")).toThrow(
      /belongs to Expert expert-a/u,
    );
  });
});
