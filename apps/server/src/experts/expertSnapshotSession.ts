import type { ExpertSnapshot, ProviderExpertSession } from "@synara/contracts";

/** The task's identity, resources and connection choices never follow Skill head updates. */
export function expertSnapshotSession(snapshot: ExpertSnapshot): ProviderExpertSession {
  return {
    snapshotId: snapshot.snapshotId,
    expertId: snapshot.expertId,
    revision: snapshot.revision,
    displayName: snapshot.displayName,
    persona: [
      `Expert: ${snapshot.displayName}`,
      snapshot.persona,
      snapshot.outputRequirements ? `Output requirements:\n${snapshot.outputRequirements}` : "",
      snapshot.references.length > 0
        ? `Reference files:\n${snapshot.references.map((reference) => `- ${reference}`).join("\n")}`
        : "",
    ]
      .filter(Boolean)
      .join("\n\n"),
    skillsRoot: snapshot.skillsRoot,
    skills: snapshot.skills,
    ...(snapshot.schemaVersion === 2 || snapshot.schemaVersion === 3
      ? {
          ...(snapshot.skillPolicy ? { skillPolicy: snapshot.skillPolicy } : {}),
          skillLoading: "index" as const,
          skillEntries: snapshot.skillEntries ?? [],
        }
      : {}),
    references: snapshot.references,
  };
}
