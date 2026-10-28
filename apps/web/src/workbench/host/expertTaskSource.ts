// FILE: expertTaskSource.ts
// Purpose: Read-only, shell-backed task history for an Expert.
// Exports: Stable selectors and the narrow Expert task-history hook.

import { useCallback, useEffect, useMemo, useState } from "react";
import type { ProjectId, ThreadId } from "@synara/contracts";

import {
  deriveTaskStatus,
  NEEDS_ANSWER_DETAIL,
  NEEDS_APPROVAL_DETAIL,
} from "~/components/tasks/tasks.logic";
import { useStore } from "~/store";
import type { AppState } from "~/storeState";
import type { SidebarThreadSummary, ThreadShell } from "~/types";
import { addWsTransportStateListener, type WsTransportState } from "~/wsTransportEvents";

export const EXPERT_TASK_HISTORY_BATCH_SIZE = 50;

export type ExpertTaskHistorySyncStatus = "loading" | "ready" | "stale";

export interface ExpertTaskHistoryRow {
  readonly threadId: ThreadId;
  readonly title: string;
  readonly projectId: ProjectId;
  readonly projectName: string | null;
  readonly expertDisplayName: string;
  readonly expertRevision: number;
  readonly expertSnapshotId: string;
  readonly statusLabel: string;
  readonly updatedAt: string | null;
  readonly archivedAt: string | null;
}

const EMPTY_EXPERT_TASK_HISTORY_ROWS: readonly ExpertTaskHistoryRow[] = [];

function resolveShellOnlyStatus(shell: ThreadShell): string {
  if (shell.error !== null) return "失败";
  if (shell.settledAt != null) return "回合已结束";
  return "状态不可用";
}

function makeHistoryRow(
  shell: ThreadShell,
  summary: SidebarThreadSummary | undefined,
  projectNameById: ReadonlyMap<ProjectId, string>,
): ExpertTaskHistoryRow {
  const binding = shell.expertBinding!;
  let statusLabel: string;
  if (
    shell.error !== null ||
    summary?.session?.status === "error" ||
    summary?.session?.orchestrationStatus === "error"
  ) {
    statusLabel = "失败";
  } else if (summary) {
    const status = deriveTaskStatus({
      todo: {
        completedAt: null,
        threadId: summary.id,
        delegationBaseTurnId: null,
        linkedAt: null,
      },
      thread: summary,
      hasDraftThread: false,
      threadsHydrated: true,
    });
    switch (status.kind) {
      case "needs":
        statusLabel = status.detail === NEEDS_APPROVAL_DETAIL ? "等待审批" : "等待你回答";
        break;
      case "running":
        statusLabel = "运行中";
        break;
      case "starting":
        statusLabel = "启动中";
        break;
      case "stopped":
        statusLabel = status.detail === "Interrupted" ? "已中断" : "失败";
        break;
      case "review":
        statusLabel = status.detail === "Plan ready" ? "待审阅" : "回合已结束";
        break;
      case "done":
        statusLabel = "已结束";
        break;
      case "todo":
        statusLabel = "未开始";
        break;
    }
  } else {
    statusLabel = resolveShellOnlyStatus(shell);
  }

  return {
    threadId: shell.id,
    title: shell.title,
    projectId: shell.projectId,
    projectName: projectNameById.get(shell.projectId) ?? null,
    expertDisplayName: binding.displayName,
    expertRevision: binding.revision,
    expertSnapshotId: binding.snapshotId,
    statusLabel,
    updatedAt: shell.updatedAt ?? null,
    archivedAt: shell.archivedAt ?? null,
  };
}

function sameRow(left: ExpertTaskHistoryRow, right: ExpertTaskHistoryRow): boolean {
  return (
    left.threadId === right.threadId &&
    left.title === right.title &&
    left.projectId === right.projectId &&
    left.projectName === right.projectName &&
    left.expertDisplayName === right.expertDisplayName &&
    left.expertRevision === right.expertRevision &&
    left.expertSnapshotId === right.expertSnapshotId &&
    left.statusLabel === right.statusLabel &&
    left.updatedAt === right.updatedAt &&
    left.archivedAt === right.archivedAt
  );
}

function sameRows(
  left: readonly ExpertTaskHistoryRow[],
  right: readonly ExpertTaskHistoryRow[],
): boolean {
  return (
    left.length === right.length &&
    left.every((row, index) => {
      const other = right[index];
      return other !== undefined && sameRow(row, other);
    })
  );
}

/** Pure projection for callers that do not need a reference-stable selector. */
export function selectExpertTaskHistoryRows(
  state: AppState,
  expertId: string,
): readonly ExpertTaskHistoryRow[] {
  const projectNameById = new Map(
    state.projects.map((project) => [project.id, project.localName?.trim() || project.name]),
  );
  const rows: ExpertTaskHistoryRow[] = [];
  for (const threadId of state.threadIds ?? []) {
    if (state.deletedThreadIdsById?.[threadId] !== undefined) continue;
    const shell = state.threadShellById?.[threadId];
    if (!shell || shell.expertBinding?.expertId !== expertId) continue;
    rows.push(makeHistoryRow(shell, state.sidebarThreadSummaryById[threadId], projectNameById));
  }
  rows.sort((left, right) => {
    const byRecentActivity = (right.updatedAt ?? "").localeCompare(left.updatedAt ?? "");
    return byRecentActivity || left.threadId.localeCompare(right.threadId);
  });
  return rows.length > 0 ? rows : EMPTY_EXPERT_TASK_HISTORY_ROWS;
}

/** Memoized shell/summary selector. It never reads detail, messages, or streamed tokens. */
export function createExpertTaskHistorySelector(
  expertId: string,
): (state: AppState) => readonly ExpertTaskHistoryRow[] {
  let previousThreadIds: AppState["threadIds"];
  let previousThreadShellById: AppState["threadShellById"];
  let previousSummaryById: AppState["sidebarThreadSummaryById"] | undefined;
  let previousProjects: AppState["projects"] | undefined;
  let previousDeletedThreadIdsById: AppState["deletedThreadIdsById"] | undefined;
  let previousRows: readonly ExpertTaskHistoryRow[] = EMPTY_EXPERT_TASK_HISTORY_ROWS;

  return (state) => {
    if (
      previousThreadIds === state.threadIds &&
      previousThreadShellById === state.threadShellById &&
      previousSummaryById === state.sidebarThreadSummaryById &&
      previousProjects === state.projects &&
      previousDeletedThreadIdsById === state.deletedThreadIdsById
    ) {
      return previousRows;
    }

    previousThreadIds = state.threadIds;
    previousThreadShellById = state.threadShellById;
    previousSummaryById = state.sidebarThreadSummaryById;
    previousProjects = state.projects;
    previousDeletedThreadIdsById = state.deletedThreadIdsById;
    const nextRows = selectExpertTaskHistoryRows(state, expertId);
    if (!sameRows(previousRows, nextRows)) previousRows = nextRows;
    return previousRows;
  };
}

export function resolveExpertTaskHistorySyncStatus(input: {
  readonly threadsHydrated: boolean;
  readonly transportState: WsTransportState | null;
  readonly subscriptionGeneration: number;
  readonly receivedGeneration: number;
}): ExpertTaskHistorySyncStatus {
  if (!input.threadsHydrated) return "loading";
  if (
    input.transportState !== "open" ||
    input.receivedGeneration !== input.subscriptionGeneration
  ) {
    return "stale";
  }
  return "ready";
}

export interface UseExpertTaskHistoryResult {
  readonly status: ExpertTaskHistorySyncStatus;
  /** The currently visible slice (50 initially, then extended by `showMore`). */
  readonly rows: readonly ExpertTaskHistoryRow[];
  readonly totalCount: number;
  readonly hasMore: boolean;
  readonly showMore: () => void;
}

export function useExpertTaskHistory(expertId: string): UseExpertTaskHistoryResult {
  const selector = useMemo(() => createExpertTaskHistorySelector(expertId), [expertId]);
  const allRows = useStore(selector);
  const threadsHydrated = useStore((state) => state.threadsHydrated);
  const subscriptionGeneration = useStore((state) => state.shellSubscriptionGeneration ?? 0);
  const receivedGeneration = useStore((state) => state.shellSnapshotReceivedGeneration ?? -1);
  const [transportState, setTransportState] = useState<WsTransportState | null>(null);
  const [visiblePage, setVisiblePage] = useState({
    expertId,
    count: EXPERT_TASK_HISTORY_BATCH_SIZE,
  });

  useEffect(() => addWsTransportStateListener(setTransportState, { replayCurrent: true }), []);

  const visibleCount =
    visiblePage.expertId === expertId ? visiblePage.count : EXPERT_TASK_HISTORY_BATCH_SIZE;
  const showMore = useCallback(() => {
    setVisiblePage((previous) => ({
      expertId,
      count:
        (previous.expertId === expertId ? previous.count : EXPERT_TASK_HISTORY_BATCH_SIZE) +
        EXPERT_TASK_HISTORY_BATCH_SIZE,
    }));
  }, [expertId]);

  return {
    status: resolveExpertTaskHistorySyncStatus({
      threadsHydrated,
      transportState,
      subscriptionGeneration,
      receivedGeneration,
    }),
    rows: allRows.slice(0, visibleCount),
    totalCount: allRows.length,
    hasMore: visibleCount < allRows.length,
    showMore,
  };
}
