import { ProjectId, ThreadId, TurnId } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import { makeProject, makeState, makeThread } from "~/storeTestFixtures";
import type { AppState } from "~/storeState";
import type { SidebarThreadSummary, Thread, ThreadShell } from "~/types";

import {
  createExpertTaskHistorySelector,
  resolveExpertTaskHistorySyncStatus,
  selectExpertTaskHistoryRows,
} from "./expertTaskSource";

const expertId = "expert-current";

function makeExpertThread(
  id: string,
  overrides: Partial<Thread> = {},
  bindingOverrides: Partial<NonNullable<Thread["expertBinding"]>> = {},
): Thread {
  return makeThread({
    id: ThreadId.makeUnsafe(id),
    projectId: ProjectId.makeUnsafe("project-history"),
    expertBinding: {
      expertId,
      displayName: "Bound name",
      revision: 4,
      snapshotId: "snapshot-original",
      ...bindingOverrides,
    },
    updatedAt: "2026-10-01T00:00:00.000Z",
    ...overrides,
  });
}

function stateForThreads(threads: readonly Thread[]): AppState {
  const first = threads[0];
  if (!first) throw new Error("test state needs a thread");
  const threadIds = threads.map((thread) => thread.id);
  const threadShellById = Object.fromEntries(
    threads.map((thread) => {
      const state = makeState(thread);
      return [thread.id, state.threadShellById?.[thread.id]];
    }),
  ) as AppState["threadShellById"];
  return {
    ...makeState(first),
    threadIds,
    threadShellById: threadShellById ?? {},
    projects: [
      makeProject({ id: ProjectId.makeUnsafe("project-history"), localName: "Local project" }),
    ],
  };
}

function makeSummary(thread: Thread, overrides: Partial<SidebarThreadSummary> = {}) {
  return {
    ...thread,
    session: {
      status: "ready",
      orchestrationStatus: "ready",
      createdAt: thread.createdAt,
      updatedAt: thread.updatedAt ?? thread.createdAt,
    },
    latestTurn: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    hasLiveTailWork: false,
    pendingBackgroundWorkCount: 0,
    ...overrides,
  } as SidebarThreadSummary;
}

describe("Expert task history projection", () => {
  it("filters by exact Expert ID, keeps archived rows, and preserves bound version metadata", () => {
    const older = makeExpertThread("thread-older", {
      title: "Older task",
      updatedAt: "2026-10-01T00:00:00.000Z",
      archivedAt: "2026-10-02T00:00:00.000Z",
    });
    const newer = makeExpertThread(
      "thread-newer",
      { title: "Newer task", updatedAt: "2026-10-03T00:00:00.000Z" },
      { displayName: "Name changed later", revision: 5, snapshotId: "snapshot-new" },
    );
    const sameNameDifferentId = makeExpertThread(
      "thread-other-expert",
      { title: "Other Expert task" },
      { expertId: "expert-similar-name", displayName: "Bound name" },
    );
    const deleted = makeExpertThread("thread-deleted", { title: "Deleted task" });
    const state = stateForThreads([older, newer, sameNameDifferentId, deleted]);
    state.deletedThreadIdsById = { [deleted.id]: 42 };
    state.sidebarThreadSummaryById = {
      [older.id]: makeSummary(older, { hasPendingApprovals: true }),
    };

    const rows = selectExpertTaskHistoryRows(state, expertId);

    expect(rows.map((row) => row.threadId)).toEqual([newer.id, older.id]);
    expect(rows[0]).toMatchObject({
      title: "Newer task",
      projectName: "Local project",
      expertDisplayName: "Name changed later",
      expertRevision: 5,
      expertSnapshotId: "snapshot-new",
      statusLabel: "状态不可用",
    });
    expect(rows[1]).toMatchObject({
      title: "Older task",
      archivedAt: "2026-10-02T00:00:00.000Z",
      expertDisplayName: "Bound name",
      expertRevision: 4,
      expertSnapshotId: "snapshot-original",
      statusLabel: "等待审批",
    });
  });

  it("uses a missing-project fallback and ignores detail/message-only changes", () => {
    const thread = makeExpertThread("thread-no-project", {
      projectId: ProjectId.makeUnsafe("project-missing"),
      settledAt: "2026-10-05T00:00:00.000Z",
    });
    const state = stateForThreads([thread]);
    const selectRows = createExpertTaskHistorySelector(expertId);
    const firstRows = selectRows(state);

    expect(firstRows[0]?.projectName).toBeNull();
    expect(firstRows[0]?.statusLabel).toBe("回合已结束");
    expect(
      selectRows({
        ...state,
        messageByThreadId: { ...state.messageByThreadId },
      }),
    ).toBe(firstRows);
    expect(
      selectRows({
        ...state,
        threadShellById: {
          ...state.threadShellById,
          [thread.id]: {
            ...state.threadShellById?.[thread.id],
            updatedAt: "2026-10-05T00:00:00.000Z",
          } as ThreadShell,
        },
      })[0]?.updatedAt,
    ).toBe("2026-10-05T00:00:00.000Z");
  });

  it("invalidates when only a thread deletion tombstone changes", () => {
    const thread = makeExpertThread("thread-tombstone");
    const state = stateForThreads([thread]);
    const selectRows = createExpertTaskHistorySelector(expertId);
    expect(selectRows(state)).toHaveLength(1);

    const rowsAfterDeletion = selectRows({
      ...state,
      deletedThreadIdsById: { [thread.id]: 7 },
    });

    expect(rowsAfterDeletion).toHaveLength(0);
  });

  it("preserves approval, input, failure, and review distinctions from task status", () => {
    const thread = makeExpertThread("thread-statuses");
    const state = stateForThreads([thread]);
    const resolveStatus = (summary: Partial<SidebarThreadSummary>) =>
      selectExpertTaskHistoryRows(
        {
          ...state,
          sidebarThreadSummaryById: {
            [thread.id]: makeSummary(thread, summary),
          },
        },
        expertId,
      )[0]?.statusLabel;

    expect(resolveStatus({ hasPendingApprovals: true })).toBe("等待审批");
    expect(resolveStatus({ hasPendingUserInput: true })).toBe("等待你回答");
    expect(
      resolveStatus({
        session: {
          provider: "codex",
          status: "error",
          orchestrationStatus: "error",
          createdAt: thread.createdAt,
          updatedAt: thread.createdAt,
        },
      }),
    ).toBe("失败");
    expect(
      resolveStatus({
        interactionMode: "plan",
        latestTurn: {
          turnId: TurnId.makeUnsafe("turn-history"),
          state: "completed",
          requestedAt: "2026-10-01T00:00:00.000Z",
          startedAt: null,
          completedAt: "2026-10-01T00:01:00.000Z",
          assistantMessageId: null,
        },
        hasActionableProposedPlan: true,
      }),
    ).toBe("待审阅");
  });
});

describe("resolveExpertTaskHistorySyncStatus", () => {
  const base = {
    threadsHydrated: true,
    transportState: "open" as const,
    subscriptionGeneration: 3,
    receivedGeneration: 3,
  };

  it("distinguishes first loading from stale cached data", () => {
    expect(resolveExpertTaskHistorySyncStatus({ ...base, threadsHydrated: false })).toBe("loading");
    expect(resolveExpertTaskHistorySyncStatus({ ...base, transportState: "closed" })).toBe("stale");
    expect(resolveExpertTaskHistorySyncStatus({ ...base, receivedGeneration: 2 })).toBe("stale");
    expect(resolveExpertTaskHistorySyncStatus(base)).toBe("ready");
  });
});
