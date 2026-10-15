import type { ProjectId, ThreadId } from "@synara/contracts";

const TOP_LEVEL_NON_THREAD_PATHS = new Set([
  "/automations",
  "/automations/",
  "/kanban",
  "/kanban/",
  "/plugins",
  "/pull-requests",
  "/pull-requests/",
  "/settings",
  "/studio",
  "/studio/",
]);

export function shouldGuardProjectContextNavigation(input: {
  readonly activeProjectId: ProjectId | null;
  readonly currentPathname: string;
  readonly nextPathname: string;
  readonly projectIdForThread: (threadId: ThreadId) => ProjectId | null;
}): boolean {
  if (input.currentPathname === input.nextPathname || !input.activeProjectId) return false;

  const kanbanProjectMatch = /^\/kanban\/([^/]+)$/.exec(input.nextPathname);
  if (kanbanProjectMatch) {
    return (kanbanProjectMatch[1] as ProjectId) !== input.activeProjectId;
  }

  if (TOP_LEVEL_NON_THREAD_PATHS.has(input.nextPathname)) return true;

  const threadMatch = /^\/([^/]+)$/.exec(input.nextPathname);
  if (threadMatch) {
    const targetProjectId = input.projectIdForThread(threadMatch[1] as ThreadId);
    // An unknown one-segment route may be a same-project local draft promotion.
    return targetProjectId !== null && targetProjectId !== input.activeProjectId;
  }

  return true;
}
