/** User-facing read capability; shares dispatch availability and never prepares snapshots. */
import type { ProjectId, ProjectAgentConfig } from "@synara/contracts";
import { isGroupContainerKind } from "@synara/shared/projectContainers";
import { Effect, Option } from "effect";

import type { ProjectionSnapshotQueryShape } from "../orchestration/Services/ProjectionSnapshotQuery";
import { listHubExpertSummaries, type HubExpertDispatchDependencies } from "./hubExpertDispatch";
import { errorText, ToolInputError } from "./toolInput";

export function readHubExpertCatalog(input: {
  readonly projectId: ProjectId;
  readonly snapshotQuery: Pick<
    ProjectionSnapshotQueryShape,
    "getProjectShellById" | "getThreadShellById"
  >;
  readonly loadConfig: (
    projectId: ProjectId,
  ) => Effect.Effect<Pick<ProjectAgentConfig, "coordinatorThreadId" | "expertIds"> | null, unknown>;
  readonly dependencies: Omit<HubExpertDispatchDependencies, "getProjectWorkspaceRoot">;
}) {
  return Effect.gen(function* () {
    const project = yield* input.snapshotQuery.getProjectShellById(input.projectId);
    if (Option.isNone(project) || !isGroupContainerKind(project.value.kind)) {
      return yield* Effect.fail(new ToolInputError("Expert selection requires an existing Hub."));
    }
    const config = yield* input.loadConfig(input.projectId);
    if (config === null) {
      return yield* Effect.fail(new ToolInputError("Finish Hub setup before selecting an Expert."));
    }
    const coordinator = yield* input.snapshotQuery.getThreadShellById(config.coordinatorThreadId);
    if (Option.isNone(coordinator) || coordinator.value.projectId !== input.projectId) {
      return yield* Effect.fail(new ToolInputError("The Hub coordinator is unavailable."));
    }
    const workspaceRoot = project.value.workspaceRoot;
    return yield* listHubExpertSummaries({
      projectId: input.projectId,
      expertIds: config.expertIds ?? [],
      callerTarget: coordinator.value.modelSelection,
      dependencies: {
        ...input.dependencies,
        getProjectWorkspaceRoot: () => Effect.succeed(workspaceRoot),
      },
    });
  }).pipe(
    Effect.mapError((error) =>
      error instanceof ToolInputError ? error : new ToolInputError(errorText(error)),
    ),
  );
}
