import type { SkillDefinition, SkillEvolutionPolicy, SkillScope } from "@synara/contracts";

const SHARED_SCOPE: SkillScope = { kind: "shared" };

/** Historical Skills remain shared and protected until an owner configures them. */
export function effectiveSkillEvolutionPolicy(
  skill: Pick<SkillDefinition, "evolutionPolicy">,
): SkillEvolutionPolicy {
  return skill.evolutionPolicy ?? "protected";
}

export function effectiveSkillScope(skill: Pick<SkillDefinition, "scope">): SkillScope {
  return skill.scope ?? SHARED_SCOPE;
}

export function assertSkillEvolutionConfiguration(input: {
  readonly current?: Pick<SkillDefinition, "scope">;
  readonly evolutionPolicy: SkillEvolutionPolicy;
  readonly scope: SkillScope;
}): void {
  const { current, evolutionPolicy, scope } = input;
  if (evolutionPolicy === "shared" && scope.kind !== "shared")
    throw new Error("Shared evolution requires shared Skill scope.");

  if (!current) return;
  const previousScope = effectiveSkillScope(current);
  if (previousScope.kind === "shared" && scope.kind === "expert")
    throw new Error("Shared Skills cannot be made Expert-specific; derive a private copy instead.");
  if (
    previousScope.kind === "expert" &&
    scope.kind === "expert" &&
    previousScope.expertId !== scope.expertId
  )
    throw new Error("An Expert-specific Skill cannot be transferred to another Expert.");
}

export function assertSkillScopeForExpert(
  skill: Pick<SkillDefinition, "skillId" | "scope">,
  expertId: string,
): void {
  const scope = effectiveSkillScope(skill);
  if (scope.kind === "expert" && scope.expertId !== expertId)
    throw new Error(`Expert-specific Skill ${skill.skillId} belongs to Expert ${scope.expertId}.`);
}
