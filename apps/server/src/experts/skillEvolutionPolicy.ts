import type { SkillDefinition, SkillScope } from "@synara/contracts";

const SHARED_SCOPE: SkillScope = { kind: "shared" };

export function effectiveSkillScope(skill: Pick<SkillDefinition, "scope">): SkillScope {
  return skill.scope ?? SHARED_SCOPE;
}

export function assertSkillScopeForExpert(
  skill: Pick<SkillDefinition, "skillId" | "scope">,
  expertId: string,
): void {
  const scope = effectiveSkillScope(skill);
  if (scope.kind === "expert" && scope.expertId !== expertId)
    throw new Error(`Expert-specific Skill ${skill.skillId} belongs to Expert ${scope.expertId}.`);
}
