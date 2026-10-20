// FILE: groupProjects.ts
// Purpose: Classify and create Group container projects. Groups are explicit — never
//          auto-created. A legacy Studio row is adopted as a group when present.
// Layer: Web orchestration helper
// Exports: Group container lookup and creation helpers.

import { type ProjectAgentOverview, type ProjectId, type ThreadId } from "@synara/contracts";
import type { ProjectAgentSummary } from "@synara/contracts";
import { isWorkspaceRootWithin, workspaceRootsEqual } from "@synara/shared/threadWorkspace";
import { isGroupContainerKind } from "@synara/shared/projectContainers";

import { GROUPS_ON } from "../betaFeatures";
import type { DraftThreadState } from "../composerDraftStore";
import { readNativeApi } from "../nativeApi";
import { useStore } from "../store";
import { useWorkspacePathsStore } from "../workspacePathsStore";
import type { Project } from "../types";
import { slugifyGroupTitle } from "@synara/shared/groupSlug";
import {
  extractDuplicateProjectCreateProjectId,
  findContainerCandidateById,
  isDuplicateProjectCreateError,
  waitForSnapshotMatch,
} from "./projectCreateRecovery";
import {
  resolveServerGroupsWorkspaceRoot,
  resolveServerStudioWorkspaceRoot,
  type ServerWorkspacePaths,
} from "./serverWorkspacePaths";
import { newCommandId, newProjectId, randomUUID } from "./utils";

const CREATED_CONTAINER_SYNC_MAX_ATTEMPTS = 10;
const PROJECT_HUB_CREATE_STORAGE_PREFIX = "synara:project-hub-create:v1:";

export interface ProjectHubCreationStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface ProjectHubCreationResult {
  readonly projectId: ProjectId;
  readonly sourceProjectId: ProjectId;
  readonly sourceLinkRequestId: string;
  readonly overview: ProjectAgentOverview | null;
}

interface PendingProjectHubCreation {
  readonly projectId: ProjectId;
  readonly title: string;
  readonly sourceLinkRequestId: string;
}

const inFlightProjectHubCreations = new Map<ProjectId, Promise<ProjectHubCreationResult | null>>();
const fallbackProjectHubCreationStorage = new Map<string, string>();
const fallbackStorage: ProjectHubCreationStorage = {
  getItem: (key) => fallbackProjectHubCreationStorage.get(key) ?? null,
  setItem: (key, value) => void fallbackProjectHubCreationStorage.set(key, value),
  removeItem: (key) => void fallbackProjectHubCreationStorage.delete(key),
};

function projectHubCreationStorage(): ProjectHubCreationStorage {
  let sessionStorage: Storage;
  try {
    if (typeof window === "undefined") return fallbackStorage;
    sessionStorage = window.sessionStorage;
  } catch {
    return fallbackStorage;
  }
  return {
    getItem: (key) => {
      try {
        return sessionStorage.getItem(key) ?? fallbackStorage.getItem(key);
      } catch {
        return fallbackStorage.getItem(key);
      }
    },
    setItem: (key, value) => {
      fallbackStorage.setItem(key, value);
      try {
        sessionStorage.setItem(key, value);
      } catch {
        // Keep the in-memory request identity when browser storage is unavailable.
      }
    },
    removeItem: (key) => {
      fallbackStorage.removeItem(key);
      try {
        sessionStorage.removeItem(key);
      } catch {
        // Keep setup moving; the matching request can still be cleared in memory.
      }
    },
  };
}

function pendingProjectHubCreationKey(sourceProjectId: ProjectId): string {
  return `${PROJECT_HUB_CREATE_STORAGE_PREFIX}${sourceProjectId}`;
}

function readPendingProjectHubCreation(
  storage: ProjectHubCreationStorage,
  sourceProjectId: ProjectId,
  title: string,
): PendingProjectHubCreation {
  const key = pendingProjectHubCreationKey(sourceProjectId);
  const serialized = storage.getItem(key);
  if (serialized) {
    const pending = parsePendingProjectHubCreation(serialized);
    if (pending) return pending;
    // Replace corrupt or stale session data with a new request identity.
    storage.removeItem(key);
  }

  const pending: PendingProjectHubCreation = {
    projectId: newProjectId(),
    title,
    sourceLinkRequestId: randomUUID(),
  };
  storage.setItem(key, JSON.stringify(pending));
  return pending;
}

function parsePendingProjectHubCreation(serialized: string): PendingProjectHubCreation | null {
  try {
    const value: unknown = JSON.parse(serialized);
    if (
      typeof value === "object" &&
      value !== null &&
      "projectId" in value &&
      typeof value.projectId === "string" &&
      value.projectId.length > 0 &&
      "title" in value &&
      typeof value.title === "string" &&
      value.title.length > 0 &&
      "sourceLinkRequestId" in value &&
      typeof value.sourceLinkRequestId === "string" &&
      value.sourceLinkRequestId.length > 0
    ) {
      return {
        projectId: value.projectId as ProjectId,
        title: value.title,
        sourceLinkRequestId: value.sourceLinkRequestId,
      };
    }
  } catch {
    // Treat corrupt session data as absent.
  }
  return null;
}

/** Clears a pending caller retry only for the Hub whose explicit source link succeeded. */
export function completePendingProjectHubCreation(input: {
  readonly sourceProjectId: ProjectId;
  readonly projectId: ProjectId;
  readonly sourceLinkRequestId?: string | undefined;
  readonly storage?: ProjectHubCreationStorage | undefined;
}): boolean {
  const storage = input.storage ?? projectHubCreationStorage();
  const key = pendingProjectHubCreationKey(input.sourceProjectId);
  let serialized: string | null;
  try {
    serialized = storage.getItem(key);
  } catch {
    return false;
  }
  if (!serialized) return false;
  const pending = parsePendingProjectHubCreation(serialized);
  if (
    !pending ||
    pending.projectId !== input.projectId ||
    (input.sourceLinkRequestId !== undefined &&
      pending.sourceLinkRequestId !== input.sourceLinkRequestId)
  ) {
    return false;
  }
  try {
    storage.removeItem(key);
  } catch {
    return false;
  }
  return true;
}

/** Creates and explicitly links a Hub, retaining request identity until its source association succeeds. */
export function createProjectHubFromProject(input: {
  readonly sourceProjectId: ProjectId;
  readonly title: string;
  readonly createGroupProject: (input: {
    title: string;
    projectId: ProjectId;
  }) => Promise<ProjectId | null>;
  readonly linkProject: (input: {
    requestId: string;
    projectId: ProjectId;
    linkedProjectId: ProjectId;
    contextSource: true;
  }) => Promise<ProjectAgentOverview>;
  /** Opens setup after the Hub is known, even when its source link needs retrying. */
  readonly onSetupReady: (result: ProjectHubCreationResult) => void;
  readonly storage?: ProjectHubCreationStorage | undefined;
}): Promise<ProjectHubCreationResult | null> {
  const existing = inFlightProjectHubCreations.get(input.sourceProjectId);
  if (existing) return existing;

  const storage = input.storage ?? projectHubCreationStorage();
  const pending = readPendingProjectHubCreation(storage, input.sourceProjectId, input.title);
  const run = async (): Promise<ProjectHubCreationResult | null> => {
    const projectId = await input.createGroupProject({
      title: pending.title,
      projectId: pending.projectId,
    });
    if (!projectId) return null;

    let overview: ProjectAgentOverview | null = null;
    try {
      overview = await input.linkProject({
        requestId: pending.sourceLinkRequestId,
        projectId,
        linkedProjectId: input.sourceProjectId,
        contextSource: true,
      });
    } catch {
      // Setup can retry this same explicit association on the returned Hub.
    }
    const result = {
      projectId,
      sourceProjectId: input.sourceProjectId,
      sourceLinkRequestId: pending.sourceLinkRequestId,
      overview,
    } satisfies ProjectHubCreationResult;
    input.onSetupReady(result);
    if (overview) {
      try {
        completePendingProjectHubCreation({
          sourceProjectId: input.sourceProjectId,
          projectId,
          sourceLinkRequestId: pending.sourceLinkRequestId,
          storage,
        });
      } catch {
        // Setup is already resumable; a storage cleanup failure must not undo it.
      }
    }
    return result;
  };

  const creation = run();
  inFlightProjectHubCreations.set(input.sourceProjectId, creation);
  const cleanup = () => {
    if (inFlightProjectHubCreations.get(input.sourceProjectId) === creation) {
      inFlightProjectHubCreations.delete(input.sourceProjectId);
    }
  };
  void creation.then(cleanup, cleanup);
  return creation;
}

function preferredPathSeparator(root: string): "\\" | "/" {
  return root.includes("\\") && !root.includes("/") ? "\\" : "/";
}

function joinGroupWorkspacePath(root: string, slug: string): string {
  const separator = preferredPathSeparator(root);
  return [root.replace(/[\\/]+$/g, ""), slug].filter(Boolean).join(separator);
}

export function isGroupContainerProject(
  project: Pick<Project, "cwd" | "kind"> | null | undefined,
  paths: ServerWorkspacePaths,
): boolean {
  // Without Groups (Stable) a group folder is an ordinary project.
  if (!project || !GROUPS_ON) {
    return false;
  }
  if (project.kind === "group") {
    const groupsWorkspaceRoot = resolveServerGroupsWorkspaceRoot(paths);
    // Until the server welcome delivers the Groups root, trust the kind alone so boot
    // partitioning does not briefly treat group rows as ordinary projects.
    if (!groupsWorkspaceRoot) {
      return true;
    }
    return (
      workspaceRootsEqual(project.cwd, groupsWorkspaceRoot) ||
      isWorkspaceRootWithin(project.cwd, groupsWorkspaceRoot)
    );
  }
  if (project.kind === "studio") {
    const studioWorkspaceRoot = resolveServerStudioWorkspaceRoot(paths);
    if (!studioWorkspaceRoot) {
      return true;
    }
    return (
      workspaceRootsEqual(project.cwd, studioWorkspaceRoot) ||
      isWorkspaceRootWithin(project.cwd, studioWorkspaceRoot)
    );
  }
  return false;
}

export function collectGroupProjectIds<T extends Pick<Project, "id" | "cwd" | "kind">>(
  projects: readonly T[],
  paths: ServerWorkspacePaths,
): Set<ProjectId> {
  return new Set(
    projects
      .filter((project) => isGroupContainerProject(project, paths))
      .map((project) => project.id),
  );
}

/** Returns existing Hubs that explicitly link a Project, in the current Hub order. */
export function findLinkedGroupProjectIds(
  sourceProjectId: ProjectId,
  groupProjects: readonly Pick<Project, "id">[],
  summariesByProjectId: ReadonlyMap<ProjectId, Pick<ProjectAgentSummary, "linkedProjectIds">>,
): ProjectId[] {
  return groupProjects
    .filter((project) =>
      summariesByProjectId.get(project.id)?.linkedProjectIds?.includes(sourceProjectId),
    )
    .map((project) => project.id);
}

// The pre-Groups Studio container is adopted as a group in place: retitling it
// "Groups" keeps its chats under the new surface without moving workspaces.
// Idempotent by title — once renamed it no longer matches. A user-set local alias
// (localName) is honored: a renamed row is the user's title, not the default
// "Studio", so it is left alone.
export function findLegacyStudioContainerForAdoption<
  T extends Pick<Project, "id" | "cwd" | "kind" | "name" | "localName">,
>(projects: readonly T[], paths: ServerWorkspacePaths): T | null {
  return (
    projects.find(
      (project) =>
        project.kind === "studio" &&
        project.name === "Studio" &&
        project.localName === null &&
        isGroupContainerProject(project, paths),
    ) ?? null
  );
}

export function findGroupDraftThreadId(input: {
  readonly groupProjectIds: ReadonlySet<ProjectId>;
  readonly projectDraftThreadIdByProjectId: Readonly<Record<string, ThreadId>>;
  readonly draftThreadsByThreadId: Readonly<Record<string, DraftThreadState>>;
}): ThreadId | null {
  for (const projectId of input.groupProjectIds) {
    const draftThreadId = input.projectDraftThreadIdByProjectId[projectId];
    if (!draftThreadId) {
      continue;
    }
    const draftThread = input.draftThreadsByThreadId[draftThreadId];
    if (
      draftThread &&
      draftThread.projectId === projectId &&
      draftThread.entryPoint === "chat" &&
      draftThread.promotedTo === undefined
    ) {
      return draftThreadId;
    }
  }
  return null;
}

function findGroupContainerCandidateById<
  T extends {
    readonly id?: ProjectId | undefined;
    readonly kind?: Project["kind"] | undefined;
  },
>(projects: readonly T[], projectId: ProjectId): T | null {
  return findContainerCandidateById(projects, projectId, (project) =>
    isGroupContainerKind(project.kind),
  );
}

export async function createGroupProject(input: {
  readonly title: string;
  /** Reuse this ID when retrying one creation request after an uncertain response. */
  readonly projectId?: ProjectId | undefined;
}): Promise<ProjectId | null> {
  const api = readNativeApi();
  if (!api) {
    return null;
  }

  const groupsWorkspaceRoot = useWorkspacePathsStore.getState().groupsWorkspaceRoot;
  if (!groupsWorkspaceRoot) {
    return null;
  }

  // A title is display data, not request identity: same-title Hubs need separate
  // workspaces. Reusing projectId replays this creation identity and lets the
  // duplicate-response recovery below return only the Hub created for that request.
  const projectId = input.projectId ?? newProjectId();
  const workspaceFolder = `${slugifyGroupTitle(input.title)}-${projectId}`;
  const workspaceRoot = joinGroupWorkspacePath(groupsWorkspaceRoot, workspaceFolder);
  try {
    await api.orchestration.dispatchCommand({
      type: "project.create",
      commandId: newCommandId(),
      projectId,
      kind: "group",
      title: input.title,
      workspaceRoot,
      createWorkspaceRootIfMissing: true,
      createdAt: new Date().toISOString(),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (isDuplicateProjectCreateError(message)) {
      const duplicateProjectId = extractDuplicateProjectCreateProjectId(message);
      if (duplicateProjectId === projectId) {
        const { match } = await waitForSnapshotMatch({
          maxAttempts: CREATED_CONTAINER_SYNC_MAX_ATTEMPTS,
          loadSnapshot: async () => {
            const snapshot = await api.orchestration.getShellSnapshot().catch(() => null);
            if (snapshot) {
              useStore.getState().syncServerShellSnapshot(snapshot);
            }
            return snapshot;
          },
          findMatch: (snapshot) => findGroupContainerCandidateById(snapshot.projects, projectId),
        });
        return match?.id ?? null;
      }
    }
    throw error;
  }

  const { match } = await waitForSnapshotMatch({
    maxAttempts: CREATED_CONTAINER_SYNC_MAX_ATTEMPTS,
    loadSnapshot: async () => {
      const snapshot = await api.orchestration.getShellSnapshot().catch(() => null);
      if (snapshot) {
        useStore.getState().syncServerShellSnapshot(snapshot);
      }
      return snapshot;
    },
    findMatch: (snapshot) => findGroupContainerCandidateById(snapshot.projects, projectId),
  });
  // A sync miss must not hand back the possibly-nonexistent id: callers open the
  // onboarding dialog for it and the lookup would silently no-op.
  return match?.id ?? null;
}
