// FILE: ExpertTaskHistory.tsx
// Purpose: Read-only task history for one Expert.
// Exports: ExpertTaskHistory.

import type { ThreadId } from "@synara/contracts";

import { formatRelativeTime } from "~/lib/relativeTime";
import { useExpertTaskHistory, type ExpertTaskHistoryRow } from "~/workbench/host/expertTaskSource";

export interface ExpertTaskHistoryProps {
  readonly expertId: string;
  readonly onOpenThread: (threadId: ThreadId) => void;
}

function ActivityTime({ updatedAt }: { readonly updatedAt: string | null }) {
  if (updatedAt === null) {
    return <span>活动时间不可用</span>;
  }
  const relativeTime = formatRelativeTime(updatedAt);
  return <time dateTime={updatedAt}>{relativeTime === "now" ? "刚刚" : `${relativeTime} 前`}</time>;
}

function HistoryRow({
  row,
  onOpenThread,
}: {
  readonly row: ExpertTaskHistoryRow;
  readonly onOpenThread: (threadId: ThreadId) => void;
}) {
  return (
    <li className="rounded-lg border border-border px-3 py-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <button
          type="button"
          className="min-w-0 truncate text-left text-ui font-medium text-foreground hover:underline"
          aria-label={`打开任务：${row.title}`}
          onClick={() => onOpenThread(row.threadId)}
        >
          {row.title || "未命名任务"}
        </button>
        <div className="flex shrink-0 flex-wrap items-center gap-1.5">
          <span className="rounded-full border border-border px-2 py-0.5 text-ui-xs text-muted-foreground">
            {row.statusLabel}
          </span>
          {row.archivedAt !== null && (
            <span className="rounded-full border border-border px-2 py-0.5 text-ui-xs text-muted-foreground">
              已归档
            </span>
          )}
        </div>
      </div>
      <dl className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-ui-sm text-muted-foreground">
        <div className="flex min-w-0 gap-1">
          <dt className="shrink-0">项目</dt>
          <dd className="truncate">{row.projectName ?? "项目不可用"}</dd>
        </div>
        <div className="flex min-w-0 gap-1">
          <dt className="shrink-0">执行时专家</dt>
          <dd className="truncate" title={`${row.expertDisplayName} · 修订 ${row.expertRevision}`}>
            {row.expertDisplayName} · 修订 {row.expertRevision}
          </dd>
        </div>
        <div className="flex min-w-0 gap-1">
          <dt className="shrink-0">最近活动</dt>
          <dd>
            <ActivityTime updatedAt={row.updatedAt} />
          </dd>
        </div>
      </dl>
    </li>
  );
}

export function ExpertTaskHistory({ expertId, onOpenThread }: ExpertTaskHistoryProps) {
  const history = useExpertTaskHistory(expertId);

  return (
    <section className="space-y-3" aria-labelledby="expert-task-history-heading">
      <header className="flex items-center justify-between gap-3">
        <h2 id="expert-task-history-heading" className="text-ui-lg font-medium text-foreground">
          任务历史
        </h2>
        {history.totalCount > 0 && (
          <span className="text-ui-sm text-muted-foreground">{history.totalCount} 条</span>
        )}
      </header>

      {history.status === "stale" && (
        <p role="status" className="text-ui-sm text-muted-foreground">
          更新尚未同步完成，当前显示已缓存的任务记录。
        </p>
      )}

      {history.status === "loading" && history.totalCount === 0 && (
        <p role="status" className="text-ui-sm text-muted-foreground">
          正在加载任务历史…
        </p>
      )}

      {history.status === "ready" && history.totalCount === 0 && (
        <p role="status" className="text-ui-sm text-muted-foreground">
          尚无使用此专家的任务。
        </p>
      )}

      {history.rows.length > 0 && (
        <ul className="space-y-2" aria-label="Expert 任务历史">
          {history.rows.map((row) => (
            <HistoryRow key={row.threadId} row={row} onOpenThread={onOpenThread} />
          ))}
        </ul>
      )}

      {history.hasMore && (
        <button
          type="button"
          className="text-ui-sm font-medium text-foreground hover:underline"
          onClick={history.showMore}
        >
          加载更多任务
        </button>
      )}
    </section>
  );
}
