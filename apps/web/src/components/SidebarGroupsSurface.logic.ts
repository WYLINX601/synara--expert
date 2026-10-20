// FILE: SidebarGroupsSurface.logic.ts
// Purpose: Pure helpers for the Groups sidebar surface — coordinator row labels,
//          empty states, and new-chat target resolution.
// Layer: Web view logic (no React)
// Exports: resolveGroupCoordinatorRowLabel, resolveGroupsListEmptyState,
//          resolveGroupChatTargetProjectId, activateThreadWhenHydrated

import type { ProjectAgentSummary, ProjectId, ThreadId } from "@synara/contracts";

import { resolveGroupCoordinatorDisplayName } from "../lib/groupCoordinatorName";
import type { Project, SidebarThreadSummary } from "../types";

/** A hub worker can belong to the hub while running in a linked repository. */
export function isGroupThreadRoute(input: {
  readonly threadId: ThreadId | null;
  readonly projectId: ProjectId | null;
  readonly groupProjectIds: ReadonlySet<ProjectId>;
  readonly summariesByProjectId: ReadonlyMap<
    ProjectId,
    Pick<ProjectAgentSummary, "memberThreadIds">
  >;
}): boolean {
  if (input.projectId !== null && input.groupProjectIds.has(input.projectId)) {
    return true;
  }
  if (input.threadId === null) {
    return false;
  }
  for (const projectId of input.groupProjectIds) {
    if (input.summariesByProjectId.get(projectId)?.memberThreadIds?.includes(input.threadId)) {
      return true;
    }
  }
  return false;
}

/** Remove only server-confirmed Hub workers from their execution Project's ordinary rows. */
export function filterHubMemberThreadsFromProjectBuckets<
  T extends Pick<SidebarThreadSummary, "id">,
>(input: {
  readonly sortedSidebarThreadsByProjectId: ReadonlyMap<ProjectId, T[]>;
  readonly memberThreadIdsByProjectId: ReadonlyMap<ProjectId, ReadonlySet<ThreadId>>;
}): ReadonlyMap<ProjectId, T[]> {
  if (input.memberThreadIdsByProjectId.size === 0) {
    return input.sortedSidebarThreadsByProjectId;
  }
  const memberThreadIds = new Set<ThreadId>();
  for (const ids of input.memberThreadIdsByProjectId.values()) {
    for (const threadId of ids) memberThreadIds.add(threadId);
  }
  if (memberThreadIds.size === 0) return input.sortedSidebarThreadsByProjectId;
  let filtered: Map<ProjectId, T[]> | null = null;
  for (const [projectId, threads] of input.sortedSidebarThreadsByProjectId) {
    const visible = threads.filter((thread) => !memberThreadIds.has(thread.id));
    if (visible.length === threads.length) continue;
    filtered ??= new Map(input.sortedSidebarThreadsByProjectId);
    filtered.set(projectId, visible);
  }
  return filtered ?? input.sortedSidebarThreadsByProjectId;
}

const HUB_SECTION_STORAGE_KEY = "synara:sidebar-hubs-expanded:v1";

export function readHubSectionExpanded(storage?: Pick<Storage, "getItem">): boolean {
  try {
    const source = storage ?? (typeof window === "undefined" ? null : window.localStorage);
    return source?.getItem(HUB_SECTION_STORAGE_KEY) !== "false";
  } catch {
    return true;
  }
}

export function persistHubSectionExpanded(
  expanded: boolean,
  storage?: Pick<Storage, "setItem">,
): void {
  try {
    const target = storage ?? (typeof window === "undefined" ? null : window.localStorage);
    target?.setItem(HUB_SECTION_STORAGE_KEY, String(expanded));
  } catch {
    // Keep the current in-memory state if browser storage is unavailable.
  }
}

export function resolveGroupCoordinatorRowLabel(input: {
  readonly configured: boolean;
  readonly coordinatorName: string | null | undefined;
  readonly groupName: string;
  readonly remoteName?: string | null | undefined;
  readonly threadTitle?: string | null | undefined;
}): string {
  if (!input.configured) {
    return "Set up coordinator";
  }
  return resolveGroupCoordinatorDisplayName(input);
}

export type GroupsListEmptyState = "loading" | "no-groups" | null;

export function resolveGroupsListEmptyState(input: {
  readonly threadsHydrated: boolean;
  readonly groupCount: number;
}): GroupsListEmptyState {
  if (!input.threadsHydrated) {
    return "loading";
  }
  return input.groupCount === 0 ? "no-groups" : null;
}

/**
 * Picks which group a bare "new group chat" (or the /groups fresh-chat path)
 * should land in: the active group when the current project already is a group
 * container, otherwise the first listed group. Returns null when no group
 * exists — callers then show the Groups empty state instead of creating a
 * container implicitly.
 */
export function resolveGroupChatTargetProjectId(input: {
  readonly activeProject: Pick<Project, "id"> | null;
  readonly groupProjects: readonly Pick<Project, "id">[];
}): ProjectId | null {
  const activeProjectId = input.activeProject?.id;
  if (activeProjectId && input.groupProjects.some((project) => project.id === activeProjectId)) {
    return activeProjectId;
  }
  return input.groupProjects[0]?.id ?? null;
}

/**
 * A just-configured coordinator thread is not in the sidebar summary map yet when
 * onboarding saves, so a bare activation intent is dropped (`threadExists=false`).
 * The snapshot echo can take several seconds, so wait on store notifications (when
 * the caller passes a subscribe) plus a poll fallback until the row appears or the
 * window expires. Returns a cancel function.
 */
export function activateThreadWhenHydrated(input: {
  readonly hasThread: () => boolean;
  readonly activate: () => void;
  readonly subscribe?: ((listener: () => void) => () => void) | undefined;
  readonly maxWaitMs?: number | undefined;
  readonly pollMs?: number | undefined;
}): () => void {
  if (input.hasThread()) {
    input.activate();
    return () => {};
  }
  const maxWaitMs = input.maxWaitMs ?? 30_000;
  const pollMs = input.pollMs ?? 250;
  let finished = false;
  let intervalId: ReturnType<typeof setInterval> | undefined;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let unsubscribe: (() => void) | undefined;
  const finish = (activate: boolean): void => {
    if (finished) {
      return;
    }
    finished = true;
    unsubscribe?.();
    if (intervalId !== undefined) {
      clearInterval(intervalId);
    }
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
    if (activate) {
      input.activate();
    }
  };
  const check = (): void => {
    if (input.hasThread()) {
      finish(true);
    }
  };
  unsubscribe = input.subscribe?.(check);
  intervalId = setInterval(check, pollMs);
  timeoutId = setTimeout(() => finish(false), maxWaitMs);
  return () => finish(false);
}
