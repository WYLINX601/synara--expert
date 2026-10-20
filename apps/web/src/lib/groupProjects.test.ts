// FILE: groupProjects.test.ts
// Purpose: Verifies Group container detection for group rows, legacy Studio, and boot-time roots.
// Layer: Web orchestration tests

import {
  ProjectId,
  type OrchestrationShellSnapshot,
  type ProjectAgentOverview,
  type ProjectAgentSummary,
} from "@synara/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Project } from "../types";
import { useStore } from "../store";
import { useWorkspacePathsStore } from "../workspacePathsStore";
import {
  collectGroupProjectIds,
  createGroupProject,
  createProjectHubFromProject,
  completePendingProjectHubCreation,
  findLinkedGroupProjectIds,
  findLegacyStudioContainerForAdoption,
  isGroupContainerProject,
  type ProjectHubCreationStorage,
} from "./groupProjects";

const GROUPS_ROOT = "/Users/tester/Documents/Synara/Groups";
const NOW = "2026-10-19T00:00:00.000Z";

function shellSnapshot(
  projects: OrchestrationShellSnapshot["projects"],
): OrchestrationShellSnapshot {
  return {
    snapshotSequence: 1,
    spaces: [],
    projects,
    threads: [],
    updatedAt: NOW,
  };
}

function shellGroupProject(input: {
  id: ProjectId;
  workspaceRoot: string;
  title?: string;
}): OrchestrationShellSnapshot["projects"][number] {
  return {
    id: input.id,
    kind: "group",
    title: input.title ?? "Alpha",
    workspaceRoot: input.workspaceRoot,
    defaultModelSelection: null,
    scripts: [],
    isPinned: false,
    spaceId: null,
    additionalFolders: [],
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function projectAgentOverview(
  projectId: ProjectId,
  sourceProjectId: ProjectId,
): ProjectAgentOverview {
  return {
    projectId,
    configured: false,
    config: null,
    linkedProjectIds: [sourceProjectId],
    sourceProjectId,
    goal: null,
    digest: null,
    blockers: [],
    recentOutcomes: [],
    coordinatorStatus: "unconfigured",
  };
}

function memoryStorage(): ProjectHubCreationStorage {
  const items = new Map<string, string>();
  return {
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => void items.set(key, value),
    removeItem: (key) => void items.delete(key),
  };
}

const duplicateCreateError = (projectId: ProjectId) =>
  new Error(
    `Orchestration command invariant failed (project.create): Project '${projectId}' already uses workspace root '${GROUPS_ROOT}/alpha-${projectId}'.`,
  );

beforeEach(() => {
  vi.stubGlobal("localStorage", {
    getItem: () => null,
    setItem: vi.fn(),
    removeItem: vi.fn(),
  });
  useWorkspacePathsStore.setState({ groupsWorkspaceRoot: GROUPS_ROOT });
  useStore.setState({ projects: [], threadsHydrated: true });
});

afterEach(() => {
  useWorkspacePathsStore.setState({ groupsWorkspaceRoot: null });
  useStore.setState({ projects: [], threadIds: [], threadShellById: {} });
  vi.unstubAllGlobals();
});

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: "project-group" as ProjectId,
    kind: "group",
    name: "Alpha",
    remoteName: "Alpha",
    folderName: "alpha",
    localName: null,
    cwd: "/Users/tester/Documents/Synara/Groups/alpha",
    defaultModelSelection: null,
    expanded: false,
    spaceId: null,
    scripts: [],
    ...overrides,
  };
}

const PATHS = {
  homeDir: "/Users/tester",
  chatWorkspaceRoot: "/Users/tester/Documents/Synara",
  studioWorkspaceRoot: "/Users/tester/Documents/Synara/Studio",
  groupsWorkspaceRoot: "/Users/tester/Documents/Synara/Groups",
};

describe("isGroupContainerProject", () => {
  it("matches a group under the Groups root", () => {
    expect(isGroupContainerProject(makeProject(), PATHS)).toBe(true);
  });

  it("matches a legacy Studio row under the Studio root", () => {
    expect(
      isGroupContainerProject(
        makeProject({
          id: "project-studio" as ProjectId,
          kind: "studio",
          name: "Studio",
          cwd: "/Users/tester/Documents/Synara/Studio",
        }),
        PATHS,
      ),
    ).toBe(true);
  });

  it("rejects an ordinary project", () => {
    expect(
      isGroupContainerProject(
        makeProject({
          kind: "project",
          cwd: "/Users/tester/Developer/app",
        }),
        PATHS,
      ),
    ).toBe(false);
  });

  it("trusts kind alone before welcome delivers roots", () => {
    expect(isGroupContainerProject(makeProject(), { homeDir: "/Users/tester" })).toBe(true);
    expect(
      isGroupContainerProject(
        makeProject({
          kind: "studio",
          cwd: "/Users/tester/Documents/Synara/Studio",
        }),
        { homeDir: "/Users/tester" },
      ),
    ).toBe(true);
  });
});

describe("findLegacyStudioContainerForAdoption", () => {
  const makeLegacyStudio = (overrides: Partial<Project> = {}): Project =>
    makeProject({
      id: "project-studio" as ProjectId,
      kind: "studio",
      name: "Studio",
      remoteName: "Studio",
      localName: null,
      cwd: "/Users/tester/Documents/Synara/Studio",
      ...overrides,
    });

  it("adopts the default-titled legacy Studio container", () => {
    const studio = makeLegacyStudio();
    expect(findLegacyStudioContainerForAdoption([makeProject(), studio], PATHS)?.id).toBe(
      studio.id,
    );
  });

  it("does not adopt a studio row with a non-Studio title", () => {
    const renamed = makeLegacyStudio({
      name: "Ops studio",
      remoteName: "Ops studio",
    });
    expect(findLegacyStudioContainerForAdoption([renamed], PATHS)).toBeNull();
  });

  it("does not adopt a row already titled Groups", () => {
    const alreadyGroups = makeLegacyStudio({
      name: "Groups",
      remoteName: "Groups",
    });
    expect(findLegacyStudioContainerForAdoption([alreadyGroups], PATHS)).toBeNull();
  });

  it("does not adopt a studio row the user renamed locally", () => {
    const userTitled = makeLegacyStudio({ localName: "Studio" });
    expect(findLegacyStudioContainerForAdoption([userTitled], PATHS)).toBeNull();
  });
});

describe("collectGroupProjectIds", () => {
  it("collects group and legacy studio ids", () => {
    const group = makeProject();
    const studio = makeProject({
      id: "project-studio" as ProjectId,
      kind: "studio",
      cwd: "/Users/tester/Documents/Synara/Studio",
    });
    const ordinary = makeProject({
      id: "project-app" as ProjectId,
      kind: "project",
      cwd: "/Users/tester/Developer/app",
    });
    expect(collectGroupProjectIds([group, studio, ordinary], PATHS)).toEqual(
      new Set([group.id, studio.id]),
    );
  });
});

describe("findLinkedGroupProjectIds", () => {
  it("returns only hubs that explicitly link the source project", () => {
    const sourceId = ProjectId.makeUnsafe("source-project");
    const linkedId = ProjectId.makeUnsafe("linked-hub");
    const unrelatedId = ProjectId.makeUnsafe("unrelated-hub");
    const summaries = new Map<ProjectId, Pick<ProjectAgentSummary, "linkedProjectIds">>([
      [linkedId, { linkedProjectIds: [sourceId] }],
      [unrelatedId, { linkedProjectIds: [] }],
    ]);

    expect(
      findLinkedGroupProjectIds(sourceId, [{ id: linkedId }, { id: unrelatedId }], summaries),
    ).toEqual([linkedId]);
  });
});

describe("createGroupProject", () => {
  it("creates independent workspaces for distinct requests with the same title", async () => {
    const created: Array<OrchestrationShellSnapshot["projects"][number]> = [];
    const api = {
      orchestration: {
        dispatchCommand: vi.fn(async (command: { type: string; [key: string]: unknown }) => {
          if (command.type === "project.create") {
            created.push(
              shellGroupProject({
                id: command.projectId as ProjectId,
                workspaceRoot: command.workspaceRoot as string,
              }),
            );
          }
        }),
        getShellSnapshot: vi.fn(async () => shellSnapshot(created)),
      },
    };
    vi.stubGlobal("window", { nativeApi: api });

    const first = await createGroupProject({ title: "Alpha" });
    const second = await createGroupProject({ title: "Alpha" });

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(second).not.toBe(first);
    expect(created.map((project) => project.workspaceRoot)).toEqual([
      `${GROUPS_ROOT}/alpha-${first}`,
      `${GROUPS_ROOT}/alpha-${second}`,
    ]);
  });

  it("recovers a retry by its stable project ID and never adopts a same-title Hub", async () => {
    const requestProjectId = ProjectId.makeUnsafe("project-create-request");
    const workspaceRoot = `${GROUPS_ROOT}/alpha-${requestProjectId}`;
    const unrelatedId = ProjectId.makeUnsafe("unrelated-alpha");
    const created = shellGroupProject({ id: requestProjectId, workspaceRoot });
    const unrelated = shellGroupProject({
      id: unrelatedId,
      workspaceRoot: `${GROUPS_ROOT}/alpha-unrelated`,
    });
    const dispatchCommand = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(duplicateCreateError(requestProjectId));
    const api = {
      orchestration: {
        dispatchCommand,
        getShellSnapshot: vi.fn(async () => shellSnapshot([created, unrelated])),
      },
    };
    vi.stubGlobal("window", { nativeApi: api });

    const first = await createGroupProject({
      title: "Alpha",
      projectId: requestProjectId,
    });
    const retry = await createGroupProject({
      title: "Alpha",
      projectId: requestProjectId,
    });

    expect(first).toBe(requestProjectId);
    expect(retry).toBe(requestProjectId);
    expect(dispatchCommand.mock.calls[0]?.[0]).toMatchObject({
      projectId: requestProjectId,
      workspaceRoot,
    });
    expect(dispatchCommand.mock.calls[1]?.[0]).toMatchObject({
      projectId: requestProjectId,
      workspaceRoot,
    });
  });

  it("does not recover an unrelated same-title Hub from a duplicate response", async () => {
    const requestProjectId = ProjectId.makeUnsafe("project-create-request");
    const unrelatedId = ProjectId.makeUnsafe("unrelated-alpha");
    const api = {
      orchestration: {
        dispatchCommand: vi.fn(async () => {
          throw duplicateCreateError(unrelatedId);
        }),
        getShellSnapshot: vi.fn(async () =>
          shellSnapshot([
            shellGroupProject({
              id: unrelatedId,
              workspaceRoot: `${GROUPS_ROOT}/alpha-${unrelatedId}`,
            }),
          ]),
        ),
      },
    };
    vi.stubGlobal("window", { nativeApi: api });

    await expect(
      createGroupProject({ title: "Alpha", projectId: requestProjectId }),
    ).rejects.toThrow(String(unrelatedId));
    expect(api.orchestration.getShellSnapshot).not.toHaveBeenCalled();
  });
});

describe("createProjectHubFromProject", () => {
  it("clears pending state only for its matching Hub and association request", () => {
    const sourceProjectId = ProjectId.makeUnsafe("source-project-scope");
    const pendingProjectId = ProjectId.makeUnsafe("hub-pending");
    const storage = memoryStorage();
    const key = `synara:project-hub-create:v1:${sourceProjectId}`;
    storage.setItem(
      key,
      JSON.stringify({
        projectId: pendingProjectId,
        title: "Alpha",
        sourceLinkRequestId: "request-pending",
      }),
    );

    expect(
      completePendingProjectHubCreation({
        sourceProjectId,
        projectId: ProjectId.makeUnsafe("different-hub"),
        storage,
      }),
    ).toBe(false);
    expect(
      completePendingProjectHubCreation({
        sourceProjectId,
        projectId: pendingProjectId,
        sourceLinkRequestId: "different-request",
        storage,
      }),
    ).toBe(false);
    expect(storage.getItem(key)).not.toBeNull();

    expect(
      completePendingProjectHubCreation({
        sourceProjectId,
        projectId: pendingProjectId,
        sourceLinkRequestId: "request-pending",
        storage,
      }),
    ).toBe(true);
    expect(storage.getItem(key)).toBeNull();
  });

  it("retains a Hub request after source-link failure and clears it after retry success", async () => {
    const sourceProjectId = ProjectId.makeUnsafe("source-project-link-retry");
    const storage = memoryStorage();
    const createGroup = vi.fn(
      async (input: { projectId: ProjectId; title: string }) => input.projectId,
    );
    const linkProject = vi
      .fn()
      .mockRejectedValueOnce(new Error("source link unavailable"))
      .mockImplementation(
        async (input: {
          requestId: string;
          projectId: ProjectId;
          linkedProjectId: ProjectId;
          contextSource: true;
        }) => projectAgentOverview(input.projectId, input.linkedProjectId),
      );
    const setupReady = vi.fn();
    const input = {
      sourceProjectId,
      title: "Alpha",
      createGroupProject: createGroup,
      linkProject,
      onSetupReady: setupReady,
      storage,
    };

    const first = await createProjectHubFromProject(input);
    const pendingKey = `synara:project-hub-create:v1:${sourceProjectId}`;
    expect(first?.overview).toBeNull();
    expect(storage.getItem(pendingKey)).not.toBeNull();

    const retry = await createProjectHubFromProject({
      ...input,
      title: "Changed project title",
    });

    expect(retry?.projectId).toBe(first?.projectId);
    expect(retry?.sourceLinkRequestId).toBe(first?.sourceLinkRequestId);
    expect(createGroup).toHaveBeenCalledTimes(2);
    expect(createGroup.mock.calls.map(([request]) => request.projectId)).toEqual([
      first?.projectId,
      first?.projectId,
    ]);
    expect(linkProject.mock.calls.map(([request]) => request.requestId)).toEqual([
      first?.sourceLinkRequestId,
      first?.sourceLinkRequestId,
    ]);
    expect(retry?.overview?.sourceProjectId).toBe(sourceProjectId);
    expect(storage.getItem(pendingKey)).toBeNull();

    const next = await createProjectHubFromProject(input);
    expect(next?.projectId).not.toBe(first?.projectId);
    expect(createGroup).toHaveBeenCalledTimes(3);
  });

  it("reuses a pending caller request after an uncertain create and starts a new request after setup opens", async () => {
    const sourceProjectId = ProjectId.makeUnsafe("source-project-retry");
    const storage = memoryStorage();
    const createdProjectIds: ProjectId[] = [];
    const createGroup = vi.fn(async (input: { projectId: ProjectId; title: string }) => {
      createdProjectIds.push(input.projectId);
      if (createdProjectIds.length === 1) throw new Error("create response timed out");
      return input.projectId;
    });
    const linkProject = vi.fn(
      async (input: {
        requestId: string;
        projectId: ProjectId;
        linkedProjectId: ProjectId;
        contextSource: true;
      }) => projectAgentOverview(input.projectId, input.linkedProjectId),
    );
    const firstSetupReady = vi.fn();

    await expect(
      createProjectHubFromProject({
        sourceProjectId,
        title: "Alpha",
        createGroupProject: createGroup,
        linkProject,
        onSetupReady: firstSetupReady,
        storage,
      }),
    ).rejects.toThrow("create response timed out");
    expect(firstSetupReady).not.toHaveBeenCalled();

    const retrySetupReady = vi.fn(() => {
      expect(storage.getItem(`synara:project-hub-create:v1:${sourceProjectId}`)).not.toBeNull();
    });
    const retry = await createProjectHubFromProject({
      sourceProjectId,
      title: "Renamed while retrying",
      createGroupProject: createGroup,
      linkProject,
      onSetupReady: retrySetupReady,
      storage,
    });

    expect(retry).not.toBeNull();
    expect(createdProjectIds[1]).toBe(createdProjectIds[0]);
    expect(createGroup.mock.calls.map(([input]) => input.title)).toEqual(["Alpha", "Alpha"]);
    expect(linkProject).toHaveBeenCalledWith({
      requestId: retry?.sourceLinkRequestId,
      projectId: retry?.projectId,
      linkedProjectId: sourceProjectId,
      contextSource: true,
    });
    expect(retrySetupReady).toHaveBeenCalledOnce();
    expect(storage.getItem(`synara:project-hub-create:v1:${sourceProjectId}`)).toBeNull();

    const nextSetupReady = vi.fn();
    const next = await createProjectHubFromProject({
      sourceProjectId,
      title: "Alpha",
      createGroupProject: createGroup,
      linkProject,
      onSetupReady: nextSetupReady,
      storage,
    });
    expect(next?.projectId).not.toBe(retry?.projectId);
    expect(createGroup).toHaveBeenCalledTimes(3);
    expect(linkProject).toHaveBeenCalledTimes(2);
  });

  it("coalesces concurrent attempts for one source Project", async () => {
    const sourceProjectId = ProjectId.makeUnsafe("source-project-concurrent");
    const storage = memoryStorage();
    const projectId = ProjectId.makeUnsafe("hub-from-project");
    let resolveCreate: ((value: ProjectId | null) => void) | undefined;
    const createGroup = vi.fn(
      () =>
        new Promise<ProjectId | null>((resolve) => {
          resolveCreate = resolve;
        }),
    );
    const linkProject = vi.fn(
      async (input: {
        requestId: string;
        projectId: ProjectId;
        linkedProjectId: ProjectId;
        contextSource: true;
      }) => projectAgentOverview(input.projectId, input.linkedProjectId),
    );
    const firstSetupReady = vi.fn();
    const secondSetupReady = vi.fn();
    const input = {
      sourceProjectId,
      title: "Alpha",
      createGroupProject: createGroup,
      linkProject,
      storage,
    };

    const first = createProjectHubFromProject({ ...input, onSetupReady: firstSetupReady });
    const second = createProjectHubFromProject({ ...input, onSetupReady: secondSetupReady });
    expect(createGroup).toHaveBeenCalledOnce();
    resolveCreate?.(projectId);
    const results = await Promise.all([first, second]);

    expect(results[0]?.projectId).toBe(projectId);
    expect(results[1]?.projectId).toBe(projectId);
    expect(linkProject).toHaveBeenCalledOnce();
    expect(firstSetupReady).toHaveBeenCalledOnce();
    expect(secondSetupReady).not.toHaveBeenCalled();
  });
});
