import { ProjectId, SpaceId, ThreadId, type ProjectAgentSummary } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import { resolveChatIndexRestoreRoute } from "../routes/-chatIndexRoute.logic";
import type { ServerWorkspacePaths } from "./serverWorkspacePaths";
import {
  isThreadReachableFromSpace,
  resolveSpaceSelectionTarget,
  type SpaceSelectionTarget,
} from "./spaceNavigation";
import type { Project, SidebarThreadSummary } from "../types";

// No server paths resolved: container classification then falls back to `kind` alone, which is
// exactly the partition these rules care about (see isHomeChatContainerProject).
const paths: ServerWorkspacePaths = {
  homeDir: null,
  chatWorkspaceRoot: null,
  studioWorkspaceRoot: null,
  groupsWorkspaceRoot: null,
};

const workSpaceId = SpaceId.makeUnsafe("space-work");

function project(input: { id: string; spaceId?: SpaceId | null; kind?: Project["kind"] }): Project {
  return {
    id: ProjectId.makeUnsafe(input.id),
    kind: input.kind ?? "project",
    name: input.id,
    remoteName: input.id,
    folderName: input.id,
    localName: null,
    cwd: `/tmp/${input.id}`,
    defaultModelSelection: null,
    expanded: false,
    spaceId: input.spaceId ?? null,
    scripts: [],
  };
}

function thread(input: {
  id: string;
  projectId: string;
  sidechatSourceThreadId?: ThreadId | null;
}): SidebarThreadSummary {
  return {
    id: ThreadId.makeUnsafe(input.id),
    projectId: ProjectId.makeUnsafe(input.projectId),
    title: input.id,
    modelSelection: { provider: "codex", model: "gpt-5" },
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    session: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    latestTurn: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    hasLiveTailWork: false,
    pendingBackgroundWorkCount: 0,
    sidechatSourceThreadId: input.sidechatSourceThreadId ?? null,
  };
}

// The upgraded-install shape that produced the bug report: every pre-existing project kept
// `space_id = NULL`, so the user's own Space is genuinely empty while Void holds everything.
const voidProject = project({ id: "project-void", spaceId: null });
const homeChatContainer = project({ id: "project-home", kind: "chat" });
const voidThread = thread({ id: "thread-void", projectId: "project-void" });
const projectById = new Map([
  [voidProject.id, voidProject],
  [homeChatContainer.id, homeChatContainer],
]);

describe("selecting an empty Space", () => {
  // The user-visible symptom: clicking a Space in the switcher appeared to do nothing. Selecting
  // an empty Space fell through to the generic "/" restore, which reopened the *previous* Space's
  // thread, and useRouteSpaceSync then wrote that thread's Space back over the click.
  it("never lands on a thread belonging to another Space", () => {
    const target: SpaceSelectionTarget = resolveSpaceSelectionTarget({
      spaceId: workSpaceId,
      projects: [voidProject],
      projectById,
      threads: [voidThread],
      rememberedThreadId: null,
      rememberedProjectId: null,
      paths,
      sortThreads: (threads) => threads,
    });
    expect(target).toEqual({ kind: "empty", spaceId: workSpaceId });

    const restored = resolveChatIndexRestoreRoute({
      // The Space we just left is still the remembered route.
      lastThreadRoute: { threadId: voidThread.id },
      availableSplitViewIds: new Set(),
      threadIds: [voidThread.id],
      sidebarThreadSummaryById: { [voidThread.id]: { projectId: voidThread.projectId } },
      groupProjectIds: new Set(),
      draftProjectIdByThreadId: new Map(),
      rememberedSplitViewThreadIds: undefined,
      landingSpace: {
        spaceId: target.kind === "empty" ? target.spaceId : null,
        projectById,
        workspacePaths: paths,
      },
    });
    expect(restored).toBeNull();
  });

  it("still lands on the Chats container, which every Space can reach", () => {
    const homeThread = thread({ id: "thread-home", projectId: "project-home" });
    expect(
      resolveChatIndexRestoreRoute({
        lastThreadRoute: { threadId: homeThread.id },
        availableSplitViewIds: new Set(),
        threadIds: [homeThread.id],
        sidebarThreadSummaryById: { [homeThread.id]: { projectId: homeThread.projectId } },
        groupProjectIds: new Set(),
        draftProjectIdByThreadId: new Map(),
        rememberedSplitViewThreadIds: undefined,
        landingSpace: { spaceId: workSpaceId, projectById, workspacePaths: paths },
      }),
    ).toEqual({ threadId: homeThread.id });
  });

  // activeSpaceId lives in sessionStorage and is empty on a fresh launch; the remembered route
  // lives in localStorage and survives. Scoping unconditionally would drop the user out of the
  // Space they closed the app in, so a landing with no Space intent must not filter.
  it("restores the remembered route unscoped when the landing carries no Space intent", () => {
    expect(
      resolveChatIndexRestoreRoute({
        lastThreadRoute: { threadId: voidThread.id, splitViewId: "split-cross-space" },
        availableSplitViewIds: new Set(["split-cross-space"]),
        threadIds: [voidThread.id],
        sidebarThreadSummaryById: { [voidThread.id]: { projectId: voidThread.projectId } },
        groupProjectIds: new Set(),
        draftProjectIdByThreadId: new Map(),
        // Unscoped startup preserves the remembered split without applying a Space policy.
        rememberedSplitViewThreadIds: undefined,
        landingSpace: null,
      }),
    ).toEqual({ threadId: voidThread.id, splitViewId: "split-cross-space" });
  });

  it("does not restore a remembered side chat as a standalone route", () => {
    const sidechat = thread({ id: "thread-sidechat", projectId: voidThread.projectId });

    expect(
      resolveChatIndexRestoreRoute({
        lastThreadRoute: { threadId: sidechat.id },
        availableSplitViewIds: new Set(),
        threadIds: [sidechat.id],
        sidebarThreadSummaryById: {
          [sidechat.id]: {
            projectId: sidechat.projectId,
            sidechatSourceThreadId: voidThread.id,
          },
        },
        groupProjectIds: new Set(),
        draftProjectIdByThreadId: new Map(),
        rememberedSplitViewThreadIds: undefined,
        landingSpace: null,
      }),
    ).toBeNull();
  });

  it("drops a split containing a thread from another Space while retaining its focused route", () => {
    const workProject = project({ id: "project-work", spaceId: workSpaceId });
    const workThread = thread({ id: "thread-work", projectId: "project-work" });
    const projects = new Map([...projectById, [workProject.id, workProject]]);

    expect(
      resolveChatIndexRestoreRoute({
        lastThreadRoute: { threadId: workThread.id, splitViewId: "split-cross-space" },
        availableSplitViewIds: new Set(["split-cross-space"]),
        threadIds: [workThread.id, voidThread.id],
        sidebarThreadSummaryById: {
          [workThread.id]: { projectId: workThread.projectId },
          [voidThread.id]: { projectId: voidThread.projectId },
        },
        groupProjectIds: new Set(),
        draftProjectIdByThreadId: new Map(),
        rememberedSplitViewThreadIds: [workThread.id, voidThread.id],
        landingSpace: {
          spaceId: workSpaceId,
          projectById: projects,
          workspacePaths: paths,
        },
      }),
    ).toEqual({ threadId: workThread.id });
  });

  it("drops a split whose pane membership cannot be validated", () => {
    const workProject = project({ id: "project-work", spaceId: workSpaceId });
    const workThread = thread({ id: "thread-work", projectId: "project-work" });

    expect(
      resolveChatIndexRestoreRoute({
        lastThreadRoute: { threadId: workThread.id, splitViewId: "split-unresolved" },
        availableSplitViewIds: new Set(["split-unresolved"]),
        threadIds: [workThread.id],
        sidebarThreadSummaryById: {
          [workThread.id]: { projectId: workThread.projectId },
        },
        groupProjectIds: new Set(),
        draftProjectIdByThreadId: new Map(),
        rememberedSplitViewThreadIds: undefined,
        landingSpace: {
          spaceId: workSpaceId,
          projectById: new Map([...projectById, [workProject.id, workProject]]),
          workspacePaths: paths,
        },
      }),
    ).toEqual({ threadId: workThread.id });
  });

  it("keeps a split when every populated pane is reachable from the selected Space", () => {
    const workProject = project({ id: "project-work", spaceId: workSpaceId });
    const firstThread = thread({ id: "thread-work-1", projectId: "project-work" });
    const secondThread = thread({ id: "thread-work-2", projectId: "project-work" });

    expect(
      resolveChatIndexRestoreRoute({
        lastThreadRoute: { threadId: firstThread.id, splitViewId: "split-work" },
        availableSplitViewIds: new Set(["split-work"]),
        threadIds: [firstThread.id, secondThread.id],
        sidebarThreadSummaryById: {
          [firstThread.id]: { projectId: firstThread.projectId },
          [secondThread.id]: { projectId: secondThread.projectId },
        },
        groupProjectIds: new Set(),
        draftProjectIdByThreadId: new Map(),
        rememberedSplitViewThreadIds: [firstThread.id, secondThread.id],
        landingSpace: {
          spaceId: workSpaceId,
          projectById: new Map([...projectById, [workProject.id, workProject]]),
          workspacePaths: paths,
        },
      }),
    ).toEqual({ threadId: firstThread.id, splitViewId: "split-work" });
  });
});

describe("resolveSpaceSelectionTarget", () => {
  it("prefers the Space's remembered thread, then its remembered project, then its newest thread", () => {
    const workProject = project({ id: "project-work", spaceId: workSpaceId });
    const older = thread({ id: "thread-older", projectId: "project-work" });
    const newer = thread({ id: "thread-newer", projectId: "project-work" });
    const byId = new Map([...projectById, [workProject.id, workProject]]);
    const base = {
      spaceId: workSpaceId,
      projects: [voidProject, workProject],
      projectById: byId,
      threads: [voidThread, older, newer],
      paths,
      sortThreads: (threads: readonly SidebarThreadSummary[]) =>
        threads.toSorted((left, right) => right.id.localeCompare(left.id)),
    };

    expect(
      resolveSpaceSelectionTarget({
        ...base,
        rememberedThreadId: older.id,
        rememberedProjectId: null,
      }),
    ).toEqual({ kind: "thread", threadId: older.id });

    expect(
      resolveSpaceSelectionTarget({
        ...base,
        rememberedThreadId: null,
        rememberedProjectId: workProject.id,
      }),
    ).toEqual({ kind: "project", projectId: workProject.id });

    expect(
      resolveSpaceSelectionTarget({ ...base, rememberedThreadId: null, rememberedProjectId: null }),
    ).toEqual({ kind: "thread", threadId: older.id });
  });

  it("ignores remembered context that no longer belongs to the Space", () => {
    expect(
      resolveSpaceSelectionTarget({
        spaceId: workSpaceId,
        projects: [voidProject],
        projectById,
        threads: [voidThread],
        // Both were remembered for this Space but their project has since moved to Void.
        rememberedThreadId: voidThread.id,
        rememberedProjectId: voidProject.id,
        paths,
        sortThreads: (threads) => threads,
      }),
    ).toEqual({ kind: "empty", spaceId: workSpaceId });
  });

  it("never treats a parent-linked side chat as a Space landing", () => {
    const workProject = project({ id: "project-work", spaceId: workSpaceId });
    const parent = thread({ id: "thread-parent", projectId: "project-work" });
    const sidechat = thread({
      id: "thread-sidechat",
      projectId: "project-work",
      sidechatSourceThreadId: parent.id,
    });

    expect(
      resolveSpaceSelectionTarget({
        spaceId: workSpaceId,
        projects: [workProject],
        projectById: new Map([[workProject.id, workProject]]),
        threads: [sidechat, parent],
        rememberedThreadId: sidechat.id,
        rememberedProjectId: null,
        paths,
        sortThreads: (threads) => threads,
      }),
    ).toEqual({ kind: "thread", threadId: parent.id });
  });

  it("uses the Hub's Space for a coordinator and its server-confirmed Worker", () => {
    const hubSpaceId = SpaceId.makeUnsafe("space-hub");
    const executionProject = project({ id: "project-execution", spaceId: workSpaceId });
    const hub = project({ id: "hub-project", kind: "group", spaceId: hubSpaceId });
    const worker = thread({ id: "hub-worker", projectId: executionProject.id });
    const coordinator = thread({ id: "hub-coordinator", projectId: hub.id });
    const summariesByProjectId = new Map([
      [
        hub.id,
        {
          coordinatorThreadId: coordinator.id,
          memberThreadIds: [worker.id],
        },
      ],
    ]);
    const common = {
      projects: [executionProject],
      hubProjects: [hub],
      summariesByProjectId,
      projectById: new Map([
        [executionProject.id, executionProject],
        [hub.id, hub],
      ]),
      threads: [worker, coordinator],
      rememberedThreadId: worker.id,
      rememberedProjectId: null,
      paths,
      sortThreads: (threads: readonly SidebarThreadSummary[]) => threads,
    };

    expect(resolveSpaceSelectionTarget({ ...common, spaceId: hubSpaceId })).toEqual({
      kind: "thread",
      threadId: worker.id,
    });
    expect(
      resolveSpaceSelectionTarget({ ...common, spaceId: workSpaceId, rememberedThreadId: null }),
    ).toEqual({ kind: "empty", spaceId: workSpaceId });
  });

  it("keeps unconfirmed Workers reachable through their execution Project", () => {
    const executionProject = project({ id: "project-execution", spaceId: workSpaceId });
    const hub = project({
      id: "hub-project",
      kind: "group",
      spaceId: SpaceId.makeUnsafe("hub-space"),
    });
    const worker = thread({ id: "hub-worker-unconfirmed", projectId: executionProject.id });
    expect(
      resolveSpaceSelectionTarget({
        spaceId: workSpaceId,
        projects: [executionProject],
        hubProjects: [hub],
        summariesByProjectId: new Map(),
        projectById: new Map([
          [executionProject.id, executionProject],
          [hub.id, hub],
        ]),
        threads: [worker],
        rememberedThreadId: worker.id,
        rememberedProjectId: null,
        paths,
        sortThreads: (threads) => threads,
      }),
    ).toEqual({ kind: "thread", threadId: worker.id });
  });
});

describe("isThreadReachableFromSpace", () => {
  it("fails closed on a project the client cannot resolve", () => {
    expect(isThreadReachableFromSpace({ project: undefined, spaceId: null, paths })).toBe(false);
  });

  it("uses a Hub container's own Space while keeping Chats global", () => {
    const hub = project({ id: "hub-space-owner", kind: "group", spaceId: workSpaceId });
    expect(isThreadReachableFromSpace({ project: hub, spaceId: workSpaceId, paths })).toBe(true);
    expect(isThreadReachableFromSpace({ project: hub, spaceId: null, paths })).toBe(false);
    expect(isThreadReachableFromSpace({ project: homeChatContainer, spaceId: null, paths })).toBe(
      true,
    );
  });
});

describe("restoring Hub threads from a selected Space", () => {
  const hubSpaceId = SpaceId.makeUnsafe("space-hub");
  const executionProject = project({ id: "project-execution", spaceId: workSpaceId });
  const hub = project({ id: "hub-owner", kind: "group", spaceId: hubSpaceId });
  const hubProjectById = new Map([
    [executionProject.id, executionProject],
    [hub.id, hub],
  ]);

  function restore(input: {
    thread: SidebarThreadSummary;
    spaceId: SpaceId;
    summariesByProjectId?: ReadonlyMap<
      ProjectId,
      Pick<ProjectAgentSummary, "coordinatorThreadId" | "memberThreadIds">
    >;
  }) {
    return resolveChatIndexRestoreRoute({
      lastThreadRoute: { threadId: input.thread.id },
      availableSplitViewIds: new Set(),
      threadIds: [input.thread.id],
      sidebarThreadSummaryById: {
        [input.thread.id]: { projectId: input.thread.projectId },
      },
      groupProjectIds: new Set([hub.id]),
      ...(input.summariesByProjectId ? { summariesByProjectId: input.summariesByProjectId } : {}),
      draftProjectIdByThreadId: new Map(),
      rememberedSplitViewThreadIds: undefined,
      landingSpace: {
        spaceId: input.spaceId,
        projectById: hubProjectById,
        workspacePaths: paths,
      },
    });
  }

  it("restores a Coordinator from its Hub Space", () => {
    const coordinator = thread({ id: "hub-coordinator", projectId: hub.id });
    const summary = new Map<
      ProjectId,
      Pick<ProjectAgentSummary, "coordinatorThreadId" | "memberThreadIds">
    >([[hub.id, { coordinatorThreadId: coordinator.id, memberThreadIds: [] }]]);
    expect(
      restore({ thread: coordinator, spaceId: hubSpaceId, summariesByProjectId: summary }),
    ).toEqual({
      threadId: coordinator.id,
    });
    expect(
      restore({ thread: coordinator, spaceId: workSpaceId, summariesByProjectId: summary }),
    ).toBeNull();
  });

  it("restores a confirmed Worker from the Hub Space, not its execution Project Space", () => {
    const worker = thread({ id: "hub-worker", projectId: executionProject.id });
    const summary = new Map([
      [hub.id, { coordinatorThreadId: null, memberThreadIds: [worker.id] }],
    ]);
    expect(restore({ thread: worker, spaceId: hubSpaceId, summariesByProjectId: summary })).toEqual(
      {
        threadId: worker.id,
      },
    );
    expect(
      restore({ thread: worker, spaceId: workSpaceId, summariesByProjectId: summary }),
    ).toBeNull();
  });

  it("keeps a Worker reachable from its execution Project until Hub membership is known", () => {
    const worker = thread({ id: "pending-hub-worker", projectId: executionProject.id });
    expect(restore({ thread: worker, spaceId: workSpaceId })).toEqual({ threadId: worker.id });
  });
});

it("does not restore a linked-repository hub worker from the Home landing", () => {
  const hubId = ProjectId.makeUnsafe("hub");
  const workerId = ThreadId.makeUnsafe("hub-worker");
  expect(
    resolveChatIndexRestoreRoute({
      lastThreadRoute: { threadId: workerId },
      availableSplitViewIds: new Set(),
      threadIds: [workerId],
      sidebarThreadSummaryById: { [workerId]: { projectId: ProjectId.makeUnsafe("repo") } },
      groupProjectIds: new Set([hubId]),
      summariesByProjectId: new Map([
        [hubId, { coordinatorThreadId: null, memberThreadIds: [workerId] }],
      ]),
      draftProjectIdByThreadId: new Map(),
      rememberedSplitViewThreadIds: undefined,
      landingSpace: null,
    }),
  ).toBeNull();
});
