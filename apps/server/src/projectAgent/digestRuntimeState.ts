import { createHash } from "node:crypto";
import type { HubWorkItem, ProjectDigestFocusItem, ProjectManagedWorker } from "@synara/contracts";

/** Live work state is authoritative; historical prose must not override it. */
export function buildRuntimeDigest(input: {
  readonly workItems: readonly HubWorkItem[];
  readonly workers: readonly Pick<
    ProjectManagedWorker,
    "threadId" | "title" | "needsYou" | "settleOutcome" | "resultAt" | "resultSummary" | "updatedAt"
  >[];
  readonly pendingWakeCount: number;
}) {
  if (!input.workItems.length && !input.workers.length && input.pendingWakeCount === 0) return null;
  const represented = new Set(input.workItems.map((item) => item.workerThreadId));
  const workersByThread = new Map(input.workers.map((worker) => [worker.threadId, worker]));
  const rows = [
    ...input.workItems.map((item) => ({
      id: item.id,
      threadId: item.workerThreadId,
      title: item.title,
      state:
        item.state === "completed"
          ? "result reported"
          : item.state === "idle" &&
              item.workerThreadId !== null &&
              item.resultSummary === null &&
              workersByThread.get(item.workerThreadId)?.settleOutcome === "completed"
            ? "idle; turn completed; no result registered"
            : item.state,
      detail:
        item.state === "completed"
          ? item.resultSummary
          : item.state === "queued"
            ? (item.queueReason ?? item.progress?.summary)
            : (item.progress?.summary ?? item.queueReason),
      updatedAt: item.updatedAt,
    })),
    ...input.workers
      .filter((worker) => !represented.has(worker.threadId))
      .map((worker) => ({
        id: worker.threadId,
        threadId: worker.threadId,
        title: worker.title,
        state: worker.needsYou
          ? "waiting for you"
          : worker.settleOutcome === "completed"
            ? worker.resultAt
              ? "result reported"
              : "turn completed; no result registered"
            : (worker.settleOutcome ?? "awaiting runtime status"),
        detail: worker.resultSummary,
        updatedAt: worker.updatedAt,
      })),
  ].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
  const queue = `Coordinator inbox: ${input.pendingWakeCount} pending event(s).`;
  const summary = [
    queue,
    ...rows
      .slice(0, 12)
      .map(
        (row) => `${row.title}: ${row.state}.${row.detail ? ` ${row.detail.slice(0, 400)}` : ""}`,
      ),
    ...(rows.length > 12 ? [`${rows.length - 12} additional work item(s).`] : []),
  ]
    .join("\n")
    .slice(0, 8_000);
  const focusItems: ProjectDigestFocusItem[] = rows.slice(0, 5).map((row) => ({
    id: `live-work-${createHash("sha256").update(row.id).digest("hex")}`,
    title: `${row.title}: ${row.state}`.slice(0, 240),
    kind: "message",
    pinned: false,
    ...(row.threadId ? { sourceThreadId: row.threadId } : {}),
  }));
  return { summary, focusItems };
}
