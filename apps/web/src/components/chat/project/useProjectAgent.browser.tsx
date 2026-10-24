// FILE: useProjectAgent.browser.tsx
// Purpose: Covers the project-agent hook's stream handling — config-upserted
//          derives `configured` and loads the lists on the first configure,
//          refreshes only the thread index on later config/task events, and a
//          second instance's unmount does not unsubscribe the first.
// Layer: Chat UI hook browser tests
// Depends on: useProjectAgent plus a stubbed nativeApi.

import "~/index.css";

import {
  ProjectAgentConfig,
  ProjectGoal,
  ProjectGoalId,
  ProjectId,
  ProjectTask,
  ProjectTaskId,
  ThreadId,
  type ProjectAgentOverview,
  type ProjectAgentStreamEvent,
  type ProjectThreadIndexEntry,
} from "@synara/contracts";
import { page } from "vitest/browser";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, renderHook } from "vitest-browser-react";

const PROJECT_ID = ProjectId.makeUnsafe("project-group-1");

const harness = vi.hoisted(() => {
  const listeners = new Set<(event: unknown) => void>();
  return {
    listeners,
    api: {
      projectAgent: {
        getOverview: vi.fn(),
        listTasks: vi.fn(),
        listActivity: vi.fn(async () => ({ activity: [], nextCursor: null })),
        listDocuments: vi.fn(async () => ({ documents: [] })),
        listThreadIndex: vi.fn(async () => ({ threads: [] as ProjectThreadIndexEntry[] })),
        startGoal: vi.fn(),
        subscribe: vi.fn(async () => undefined),
        unsubscribe: vi.fn(async () => undefined),
        onEvent: vi.fn((listener: (event: unknown) => void) => {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        }),
      },
    },
  };
});

vi.mock("~/nativeApi", () => ({
  readNativeApi: () => harness.api,
  ensureNativeApi: () => harness.api,
}));

import { useProjectAgent } from "./useProjectAgent";

function overview(overrides: Partial<ProjectAgentOverview> = {}): ProjectAgentOverview {
  return {
    projectId: PROJECT_ID,
    configured: false,
    config: null,
    goal: null,
    digest: null,
    linkedProjectIds: [],
    blockers: [],
    recentOutcomes: [],
    coordinatorStatus: "unconfigured",
    ...overrides,
  } as ProjectAgentOverview;
}

function configPayload(projectId: ProjectId = PROJECT_ID, revision = 1): ProjectAgentConfig {
  return ProjectAgentConfig.makeUnsafe({
    projectId,
    coordinatorThreadId: ThreadId.makeUnsafe("thread-coordinator"),
    coordinatorName: "alpha Coordinator",
    coordinatorModelSelection: { provider: "codex", model: "gpt-5-codex" },
    limits: {
      maxConcurrentWorkers: 4,
      maxNewWorkersPerTurn: 2,
      maxWorkerCreationsPerGoal: 12,
      maxAutomaticContinuationsPerGoal: 2,
      maxRepairRoundsPerTask: 2,
    },
    captureEnabled: true,
    enabled: true,
    automationId: null,
    revision,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    disabledAt: null,
  });
}

function goalPayload(revision: number, status: "active" | "paused"): ProjectGoal {
  return ProjectGoal.makeUnsafe({
    id: ProjectGoalId.makeUnsafe("goal-1"),
    projectId: PROJECT_ID,
    objective: "test goal",
    authorizationSource: "user",
    scopeVersion: 1,
    acceptanceCriteria: null,
    limits: {
      maxConcurrentWorkers: 4,
      maxNewWorkersPerTurn: 2,
      maxWorkerCreationsPerGoal: 12,
      maxAutomaticContinuationsPerGoal: 2,
      maxRepairRoundsPerTask: 2,
    },
    status,
    continuationCount: 0,
    workerCreationCount: 0,
    authorizedAt: "2026-09-01T00:00:00.000Z",
    revision,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: revision === 1 ? "2026-09-01T00:00:00.000Z" : "2026-09-02T00:00:00.000Z",
  });
}

function emitProjectAgentEvent(event: ProjectAgentStreamEvent) {
  harness.listeners.forEach((listener) => listener(event));
}

function taskPayload(id = "task-1", revision = 1): ProjectTask {
  return ProjectTask.makeUnsafe({
    id: ProjectTaskId.makeUnsafe(id),
    projectId: PROJECT_ID,
    goalId: ProjectGoalId.makeUnsafe("goal-1"),
    title: "write tests",
    description: null,
    acceptanceCriteria: null,
    status: revision === 1 ? "running" : "review",
    dependsOnTaskIds: [],
    assignedThreadId: ThreadId.makeUnsafe("thread-worker-1"),
    repairCount: 0,
    archivedAt: null,
    revision,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function Probe({ enabled = true }: { enabled?: boolean }) {
  const agent = useProjectAgent({ projectId: PROJECT_ID, enabled });
  return (
    <output data-testid="agent-probe">
      {JSON.stringify({
        configured: agent.overview?.configured ?? null,
        tasks: agent.tasks.length,
        threads: agent.threads.length,
      })}
    </output>
  );
}

describe("useProjectAgent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    harness.listeners.clear();
    harness.api.projectAgent.getOverview.mockReset().mockResolvedValue(overview());
    harness.api.projectAgent.listTasks
      .mockReset()
      .mockResolvedValue({ tasks: [], nextCursor: null });
    harness.api.projectAgent.startGoal.mockReset().mockResolvedValue(undefined);
  });

  it("derives configured and loads the lists on the first config-upserted", async () => {
    // After the configure write the server's getOverview reports configured —
    // the transition load must not regress to a stale unconfigured payload.
    harness.api.projectAgent.getOverview
      .mockResolvedValueOnce(overview())
      .mockResolvedValue(
        overview({ configured: true, config: configPayload(), coordinatorStatus: "idle" }),
      );
    await render(<Probe />);
    await vi.waitFor(() => expect(harness.api.projectAgent.getOverview).toHaveBeenCalledOnce());

    emitProjectAgentEvent({ type: "config-upserted", config: configPayload() });

    await expect.element(page.getByTestId("agent-probe")).toHaveTextContent('"configured":true');
    await vi.waitFor(() => {
      expect(harness.api.projectAgent.listTasks).toHaveBeenCalledOnce();
      expect(harness.api.projectAgent.listThreadIndex).toHaveBeenCalledOnce();
      expect(harness.api.projectAgent.listActivity).toHaveBeenCalledOnce();
      expect(harness.api.projectAgent.listDocuments).toHaveBeenCalledOnce();
    });
    // The transition load doubles as the second getOverview.
    expect(harness.api.projectAgent.getOverview).toHaveBeenCalledTimes(2);
  });

  it("refreshes only the thread index on later config and task upserts", async () => {
    harness.api.projectAgent.getOverview.mockResolvedValue(
      overview({ configured: true, config: configPayload(), coordinatorStatus: "idle" }),
    );
    await render(<Probe />);
    await vi.waitFor(() => expect(harness.api.projectAgent.listTasks).toHaveBeenCalledOnce());
    expect(harness.api.projectAgent.listThreadIndex).toHaveBeenCalledOnce();

    emitProjectAgentEvent({ type: "config-upserted", config: configPayload() });
    await vi.waitFor(() =>
      expect(harness.api.projectAgent.listThreadIndex).toHaveBeenCalledTimes(2),
    );
    expect(harness.api.projectAgent.listTasks).toHaveBeenCalledOnce();

    const task = ProjectTask.makeUnsafe({
      id: ProjectTaskId.makeUnsafe("task-1"),
      projectId: PROJECT_ID,
      goalId: ProjectGoalId.makeUnsafe("goal-1"),
      title: "write tests",
      description: null,
      acceptanceCriteria: null,
      status: "running",
      dependsOnTaskIds: [],
      assignedThreadId: ThreadId.makeUnsafe("thread-worker-1"),
      repairCount: 0,
      archivedAt: null,
      revision: 1,
      createdAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-01T00:00:00.000Z",
    });
    emitProjectAgentEvent({ type: "task-upserted", task });
    await vi.waitFor(() =>
      expect(harness.api.projectAgent.listThreadIndex).toHaveBeenCalledTimes(3),
    );
    await expect.element(page.getByTestId("agent-probe")).toHaveTextContent('"tasks":1');
  });

  it("keeps the first instance subscribed when a second instance unmounts", async () => {
    const first = await render(<Probe />);
    const second = await render(<Probe />);
    await vi.waitFor(() => expect(harness.api.projectAgent.subscribe).toHaveBeenCalledTimes(2));
    const listenersBefore = harness.listeners.size;
    expect(listenersBefore).toBe(2);

    await second.unmount();
    expect(harness.api.projectAgent.unsubscribe).toHaveBeenCalledTimes(1);
    expect(harness.listeners.size).toBe(1);

    harness.api.projectAgent.getOverview.mockResolvedValue(
      overview({ configured: true, config: configPayload(), coordinatorStatus: "idle" }),
    );
    emitProjectAgentEvent({ type: "config-upserted", config: configPayload() });
    await expect.element(page.getByTestId("agent-probe")).toHaveTextContent('"configured":true');

    await first.unmount();
    expect(harness.api.projectAgent.unsubscribe).toHaveBeenCalledTimes(2);
    expect(harness.listeners.size).toBe(0);
  });

  it("keeps task updates received while an older list request is loading", async () => {
    harness.api.projectAgent.getOverview.mockResolvedValue(
      overview({ configured: true, config: configPayload(), coordinatorStatus: "idle" }),
    );
    harness.api.projectAgent.listTasks.mockResolvedValue({
      tasks: [taskPayload()],
      nextCursor: null,
    });
    const hook = await renderHook(() => useProjectAgent({ projectId: PROJECT_ID, enabled: true }));
    try {
      await vi.waitFor(() => expect(hook.result.current.tasks).toHaveLength(1));
      const pending = deferred<{ tasks: ProjectTask[]; nextCursor: null }>();
      harness.api.projectAgent.listTasks.mockReturnValueOnce(pending.promise);
      const loading = hook.result.current.load();
      await vi.waitFor(() => expect(harness.api.projectAgent.listTasks).toHaveBeenCalledTimes(2));
      emitProjectAgentEvent({ type: "task-upserted", task: taskPayload("task-1", 2) });
      emitProjectAgentEvent({ type: "task-upserted", task: taskPayload("task-2", 1) });
      await vi.waitFor(() => expect(hook.result.current.tasks).toHaveLength(2));
      pending.resolve({ tasks: [taskPayload()], nextCursor: null });
      await loading;
      await hook.rerender();
      expect(hook.result.current.tasks.map((task) => [task.id, task.revision])).toEqual([
        ["task-1", 2],
        ["task-2", 1],
      ]);
    } finally {
      await hook.unmount();
    }
  });

  it("reloads task lists on a reconnect snapshot", async () => {
    const currentOverview = overview({
      configured: true,
      config: configPayload(),
      coordinatorStatus: "idle",
    });
    harness.api.projectAgent.getOverview.mockResolvedValue(currentOverview);
    const hook = await renderHook(() => useProjectAgent({ projectId: PROJECT_ID, enabled: true }));
    try {
      await vi.waitFor(() => expect(harness.api.projectAgent.listTasks).toHaveBeenCalledOnce());
      harness.api.projectAgent.listTasks.mockResolvedValue({
        tasks: [taskPayload()],
        nextCursor: null,
      });
      emitProjectAgentEvent({ type: "snapshot", overview: currentOverview });
      await vi.waitFor(() => expect(hook.result.current.tasks).toHaveLength(1));
    } finally {
      await hook.unmount();
    }
  });

  it("uses a reconnect snapshot only to trigger a fresh overview read", async () => {
    const staleOverview = overview({
      configured: true,
      config: configPayload(PROJECT_ID, 1),
      goal: goalPayload(1, "active"),
      coordinatorStatus: "running",
    });
    const latestOverview = overview({
      configured: true,
      config: configPayload(PROJECT_ID, 2),
      goal: goalPayload(2, "paused"),
      coordinatorStatus: "paused",
    });
    const pendingInitialOverview = deferred<ProjectAgentOverview>();
    harness.api.projectAgent.getOverview
      .mockReturnValueOnce(pendingInitialOverview.promise)
      .mockResolvedValueOnce(latestOverview);
    const hook = await renderHook(() => useProjectAgent({ projectId: PROJECT_ID, enabled: true }));
    try {
      await vi.waitFor(() => expect(harness.api.projectAgent.getOverview).toHaveBeenCalledOnce());

      emitProjectAgentEvent({ type: "snapshot", overview: staleOverview });

      await vi.waitFor(() => {
        expect(harness.api.projectAgent.getOverview).toHaveBeenCalledTimes(2);
        expect(hook.result.current.overview?.config?.revision).toBe(2);
        expect(hook.result.current.overview?.goal?.revision).toBe(2);
        expect(hook.result.current.overview?.goal?.status).toBe("paused");
        expect(hook.result.current.overview?.coordinatorStatus).toBe("paused");
      });

      // A slow first read must not undo the latest overview either.
      pendingInitialOverview.resolve(staleOverview);
      await pendingInitialOverview.promise;
      await hook.rerender();
      expect(hook.result.current.overview?.config?.revision).toBe(2);
      expect(hook.result.current.overview?.goal?.revision).toBe(2);
      expect(hook.result.current.overview?.coordinatorStatus).toBe("paused");
    } finally {
      pendingInitialOverview.resolve(staleOverview);
      await hook.unmount();
    }
  });

  it("does not let an older thread-index list overwrite a task-event refresh", async () => {
    const staleIndex = deferred<{ threads: ProjectThreadIndexEntry[] }>();
    const thread: ProjectThreadIndexEntry = {
      projectId: PROJECT_ID,
      threadId: ThreadId.makeUnsafe("thread-from-task-refresh"),
      excluded: false,
      archived: false,
      summaryStatus: "pending",
      lastUpdatedAt: null,
      lastSummarizedAt: null,
    };
    harness.api.projectAgent.getOverview.mockResolvedValue(
      overview({ configured: true, config: configPayload(), coordinatorStatus: "idle" }),
    );
    harness.api.projectAgent.listThreadIndex
      .mockReset()
      .mockReturnValueOnce(staleIndex.promise)
      .mockResolvedValue({ threads: [thread] });
    const hook = await renderHook(() => useProjectAgent({ projectId: PROJECT_ID, enabled: true }));
    try {
      await vi.waitFor(() =>
        expect(harness.api.projectAgent.listThreadIndex).toHaveBeenCalledOnce(),
      );
      emitProjectAgentEvent({ type: "task-upserted", task: taskPayload() });
      await vi.waitFor(() =>
        expect(harness.api.projectAgent.listThreadIndex).toHaveBeenCalledTimes(2),
      );
      await vi.waitFor(() => expect(hook.result.current.threads).toEqual([thread]));
      staleIndex.resolve({ threads: [] });
      await hook.rerender();
      expect(hook.result.current.threads).toEqual([thread]);
    } finally {
      staleIndex.resolve({ threads: [] });
      await hook.unmount();
    }
  });

  it("loads all task pages instead of dropping tasks after the first page", async () => {
    harness.api.projectAgent.getOverview.mockResolvedValue(
      overview({ configured: true, config: configPayload(), coordinatorStatus: "idle" }),
    );
    harness.api.projectAgent.listTasks
      .mockResolvedValueOnce({ tasks: [taskPayload("task-new")], nextCursor: "page-2" })
      .mockResolvedValueOnce({ tasks: [taskPayload("task-old")], nextCursor: null });
    const hook = await renderHook(() => useProjectAgent({ projectId: PROJECT_ID, enabled: true }));
    try {
      await vi.waitFor(() => expect(hook.result.current.tasks).toHaveLength(2));
      expect(harness.api.projectAgent.listTasks).toHaveBeenLastCalledWith(
        expect.objectContaining({ projectId: PROJECT_ID, cursor: "page-2", includeArchived: true }),
      );
    } finally {
      await hook.unmount();
    }
  });

  it("does not repopulate a disabled hook from a late overview response", async () => {
    const pending = deferred<ProjectAgentOverview>();
    harness.api.projectAgent.getOverview.mockReturnValue(pending.promise);
    const hook = await renderHook(
      (props?: { enabled: boolean }) =>
        useProjectAgent({ projectId: PROJECT_ID, enabled: props?.enabled ?? true }),
      { initialProps: { enabled: true } },
    );
    try {
      await vi.waitFor(() => expect(harness.api.projectAgent.getOverview).toHaveBeenCalledOnce());
      await hook.rerender({ enabled: false });
      pending.resolve(overview({ configured: true, config: configPayload() }));
      await pending.promise;
      await hook.rerender({ enabled: false });
      expect(hook.result.current.overview).toBeNull();
      expect(harness.api.projectAgent.listTasks).not.toHaveBeenCalled();
    } finally {
      await hook.unmount();
    }
  });

  it("resets busy when switching projects during a pending mutation", async () => {
    const pending = deferred<void>();
    harness.api.projectAgent.startGoal.mockReturnValue(pending.promise);
    const hook = await renderHook(
      (props?: { projectId: ProjectId }) =>
        useProjectAgent({ projectId: props?.projectId ?? PROJECT_ID, enabled: true }),
      { initialProps: { projectId: PROJECT_ID } },
    );
    try {
      const mutation = hook.result.current.startGoal("first project goal");
      await vi.waitFor(() => expect(hook.result.current.busy).toBe(true));
      await hook.rerender({ projectId: ProjectId.makeUnsafe("second-project") });
      pending.resolve(undefined);
      await mutation;
      await hook.rerender({ projectId: ProjectId.makeUnsafe("second-project") });
      expect(hook.result.current.busy).toBe(false);
    } finally {
      pending.resolve(undefined);
      await hook.unmount();
    }
  });

  it("settles busy for a mutation invoked while the current hook is disabled", async () => {
    const pending = deferred<void>();
    harness.api.projectAgent.startGoal.mockReturnValue(pending.promise);
    const hook = await renderHook(
      (props?: { enabled: boolean }) =>
        useProjectAgent({ projectId: PROJECT_ID, enabled: props?.enabled ?? false }),
      { initialProps: { enabled: false } },
    );
    try {
      const mutation = hook.result.current.startGoal("disabled scope");
      await vi.waitFor(() => expect(hook.result.current.busy).toBe(true));
      pending.resolve(undefined);
      await mutation;
      await hook.rerender({ enabled: false });
      expect(hook.result.current.busy).toBe(false);
    } finally {
      pending.resolve(undefined);
      await hook.unmount();
    }
  });

  it("keeps busy until every concurrent mutation in the current scope settles", async () => {
    const first = deferred<void>();
    const second = deferred<void>();
    harness.api.projectAgent.startGoal
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const hook = await renderHook(() => useProjectAgent({ projectId: PROJECT_ID, enabled: true }));
    try {
      const firstMutation = hook.result.current.startGoal("first");
      const secondMutation = hook.result.current.startGoal("second");
      first.resolve(undefined);
      await firstMutation;
      await hook.rerender();
      expect(hook.result.current.busy).toBe(true);
      second.resolve(undefined);
      await secondMutation;
      await hook.rerender();
      expect(hook.result.current.busy).toBe(false);
    } finally {
      first.resolve(undefined);
      second.resolve(undefined);
      await hook.unmount();
    }
  });

  it("ignores an old mutation when returning to the same project", async () => {
    const old = deferred<void>();
    const current = deferred<void>();
    harness.api.projectAgent.startGoal
      .mockReturnValueOnce(old.promise)
      .mockReturnValueOnce(current.promise);
    const hook = await renderHook(
      (props?: { projectId: ProjectId }) =>
        useProjectAgent({ projectId: props?.projectId ?? PROJECT_ID, enabled: true }),
      { initialProps: { projectId: PROJECT_ID } },
    );
    try {
      const oldMutation = hook.result.current.startGoal("old");
      await hook.rerender({ projectId: ProjectId.makeUnsafe("second-project") });
      await hook.rerender({ projectId: PROJECT_ID });
      const newMutation = hook.result.current.startGoal("new");
      old.resolve(undefined);
      await oldMutation;
      await hook.rerender({ projectId: PROJECT_ID });
      expect(hook.result.current.busy).toBe(true);
      current.resolve(undefined);
      await newMutation;
      await hook.rerender({ projectId: PROJECT_ID });
      expect(hook.result.current.busy).toBe(false);
    } finally {
      old.resolve(undefined);
      current.resolve(undefined);
      await hook.unmount();
    }
  });

  it("rejects a non-advancing task cursor instead of polling indefinitely", async () => {
    harness.api.projectAgent.getOverview.mockResolvedValue(
      overview({ configured: true, config: configPayload() }),
    );
    harness.api.projectAgent.listTasks.mockResolvedValue({ tasks: [], nextCursor: "same-page" });
    const hook = await renderHook(() => useProjectAgent({ projectId: PROJECT_ID, enabled: true }));
    try {
      await vi.waitFor(() =>
        expect(hook.result.current.error).toBe("Task pagination did not advance."),
      );
      expect(harness.api.projectAgent.listTasks).toHaveBeenCalledTimes(2);
    } finally {
      await hook.unmount();
    }
  });
});
