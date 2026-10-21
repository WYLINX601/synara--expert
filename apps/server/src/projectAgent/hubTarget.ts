import type { ProjectId } from "@synara/contracts";

/** Discovery and acceptance must resolve the same workspace before preflight. */
export function resolveHubTargetProjectId(input: {
  readonly hubId: ProjectId;
  readonly sourceProjectId?: ProjectId | null | undefined;
  readonly targetProjectId?: ProjectId | undefined;
}): ProjectId {
  return input.targetProjectId ?? input.sourceProjectId ?? input.hubId;
}
