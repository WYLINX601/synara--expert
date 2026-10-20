// FILE: chatIndexRoute.logic.ts
// Purpose: The "/" landing's restore policy — which remembered thread route the home-chat
//          surface may reopen, and under which Space.
// Layer: Route UI logic helpers
// Exports: home-chat restore-route resolution.

import type {
  ProjectAgentSummary,
  ProjectId,
  SpaceId,
  ThreadId,
  ThreadSidechatContext,
} from "@synara/contracts";

import { isGroupThreadRoute } from "../components/SidebarGroupsSurface.logic";
import { resolveRestorableThreadRoute, type LastThreadRoute } from "../chatRouteRestore";
import type { ServerWorkspacePaths } from "../lib/serverWorkspacePaths";
import { isThreadReachableFromSpace, resolveOwningHubProject } from "../lib/spaceNavigation";
import type { Project } from "../types";
import { isSidechatThread } from "@synara/shared/sidechatThread";

/**
 * Set only when "/" was reached by *selecting* a Space. The landing then restores threads that
 * Space can reach and nothing else. Without it — cold start, a deep link, a plain refresh — the
 * remembered route decides the Space instead: `activeSpaceId` lives in sessionStorage and is
 * empty on a fresh launch, while the remembered route lives in localStorage and survives, so
 * scoping unconditionally would drop the user out of the Space they left the app in.
 */
export interface ChatIndexLandingSpace {
  readonly spaceId: SpaceId | null;
  readonly projectById: ReadonlyMap<ProjectId, Project>;
  readonly workspacePaths: ServerWorkspacePaths;
}

export function resolveChatIndexRestoreRoute(input: {
  readonly lastThreadRoute: LastThreadRoute | null;
  readonly availableSplitViewIds: ReadonlySet<string>;
  readonly threadIds: readonly ThreadId[];
  readonly sidebarThreadSummaryById: Readonly<
    Record<
      string,
      | {
          readonly projectId: ProjectId;
          readonly sidechatSourceThreadId?: ThreadId | null;
          readonly sidechatContext?: ThreadSidechatContext | null;
        }
      | undefined
    >
  >;
  readonly groupProjectIds: ReadonlySet<ProjectId>;
  readonly summariesByProjectId?: ReadonlyMap<
    ProjectId,
    Pick<ProjectAgentSummary, "coordinatorThreadId" | "memberThreadIds">
  >;
  /**
   * Still-unsent chat drafts. They have a route id but no sidebar summary yet, so the summary
   * lookup below never matches them — mirrors the /groups landing's draft handling so a cold
   * start on "/" can reopen an unsent draft instead of always minting a new one.
   */
  readonly draftProjectIdByThreadId: ReadonlyMap<string, ProjectId>;
  /**
   * Populated panes from the split named by `lastThreadRoute`. `undefined` means the current
   * client state could not resolve that split, so a Space-scoped restore must fail closed.
   */
  readonly rememberedSplitViewThreadIds: readonly ThreadId[] | undefined;
  readonly landingSpace: ChatIndexLandingSpace | null;
}): LastThreadRoute | null {
  const { draftProjectIdByThreadId, landingSpace, sidebarThreadSummaryById, groupProjectIds } =
    input;
  const summariesByProjectId = input.summariesByProjectId ?? new Map();
  const hubProjects = landingSpace
    ? Array.from(groupProjectIds, (projectId) => landingSpace.projectById.get(projectId)).filter(
        (project): project is Project => project !== undefined,
      )
    : [];

  const availableThreadIds = new Set<string>();
  for (const threadId of [...input.threadIds, ...draftProjectIdByThreadId.keys()]) {
    // Fail closed: a thread we can't classify is not restorable from "/". Summaries are built
    // from the same snapshot as threadIds, so this only ever excludes a thread if that invariant
    // breaks — and then a fresh draft beats restoring into the wrong segment.
    const threadSummary = sidebarThreadSummaryById[threadId];
    if (threadSummary && isSidechatThread(threadSummary)) continue;
    const projectId = threadSummary?.projectId ?? draftProjectIdByThreadId.get(threadId);
    if (projectId === undefined) continue;
    // Without Space intent, Hub threads stay on the global Hubs route. When a Space was
    // explicitly selected, resolve their Hub owner so Coordinators and confirmed Workers restore
    // in the Hub's Space even when a Worker executes in another Project.
    if (
      !landingSpace &&
      isGroupThreadRoute({
        threadId: threadId as ThreadId,
        projectId,
        groupProjectIds,
        summariesByProjectId,
      })
    )
      continue;
    if (landingSpace) {
      const hubOwner = resolveOwningHubProject({
        threadId: threadId as ThreadId,
        projectId,
        hubProjects,
        summariesByProjectId,
      });
      if (
        !isThreadReachableFromSpace({
          project: hubOwner ?? landingSpace.projectById.get(projectId),
          spaceId: landingSpace.spaceId,
          paths: landingSpace.workspacePaths,
        })
      ) {
        continue;
      }
    }
    availableThreadIds.add(threadId);
  }

  const restorableRoute = resolveRestorableThreadRoute({
    lastThreadRoute: input.lastThreadRoute,
    availableThreadIds,
    availableSplitViewIds: input.availableSplitViewIds,
  });
  if (!landingSpace || !restorableRoute?.splitViewId) {
    return restorableRoute;
  }

  const splitThreadIds = input.rememberedSplitViewThreadIds;
  if (
    splitThreadIds === undefined ||
    splitThreadIds.length === 0 ||
    splitThreadIds.some((threadId) => !availableThreadIds.has(threadId))
  ) {
    return { threadId: restorableRoute.threadId };
  }

  return restorableRoute;
}
