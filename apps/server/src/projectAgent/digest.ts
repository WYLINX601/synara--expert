import {
  ProjectTaskId,
  ThreadId,
  type ProjectActivity,
  type ProjectDigestFocusItem,
} from "@synara/contracts";

type DigestSource = Pick<
  ProjectDigestFocusItem,
  "taskId" | "sourceThreadId" | "sourceMessageId" | "artifactPath"
>;

export function wakeReceiptRequestId(input: {
  readonly projectId: string;
  readonly fromInboxId: string;
  readonly toInboxId: string;
}): string {
  return `wake:${input.projectId}:${input.fromInboxId}:${input.toInboxId}`;
}

export function allowedDigestSources(input: {
  readonly activities: ReadonlyArray<
    Pick<ProjectActivity, "id" | "source" | "taskId" | "actorThreadId">
  >;
  readonly taskIds: ReadonlyArray<string>;
  readonly threadIds: ReadonlyArray<string>;
  readonly documentPaths: ReadonlyArray<string>;
}): ReadonlyMap<string, DigestSource> {
  const sources = new Map<string, DigestSource>();
  for (const id of input.taskIds) sources.set(id, { taskId: ProjectTaskId.makeUnsafe(id) });
  for (const id of input.threadIds) sources.set(id, { sourceThreadId: ThreadId.makeUnsafe(id) });
  for (const path of input.documentPaths) sources.set(path, { artifactPath: path });
  for (const activity of input.activities) {
    const threadId = activity.source?.threadId ?? activity.actorThreadId;
    sources.set(activity.id, {
      ...(activity.taskId && input.taskIds.includes(activity.taskId)
        ? { taskId: activity.taskId }
        : {}),
      ...(threadId && input.threadIds.includes(threadId)
        ? {
            sourceThreadId: threadId,
            ...(activity.source?.messageId ? { sourceMessageId: activity.source.messageId } : {}),
          }
        : {}),
      ...(activity.source?.path && input.documentPaths.includes(activity.source.path)
        ? { artifactPath: activity.source.path }
        : {}),
    });
  }
  return sources;
}

export function validateDigestFocusItems(
  items: ReadonlyArray<{
    readonly title: string;
    readonly kind: ProjectDigestFocusItem["kind"];
    readonly source: string;
  }>,
  allowedSources: ReadonlyMap<string, DigestSource>,
): ReadonlyArray<ProjectDigestFocusItem> {
  const validated: ProjectDigestFocusItem[] = [];
  for (const [index, item] of items.entries()) {
    const source = allowedSources.get(item.source);
    if (!source) continue;
    const target =
      item.kind === "task"
        ? source.taskId
          ? { taskId: source.taskId }
          : {}
        : item.kind === "message"
          ? source.sourceThreadId
            ? {
                sourceThreadId: source.sourceThreadId,
                ...(source.sourceMessageId ? { sourceMessageId: source.sourceMessageId } : {}),
              }
            : {}
          : item.kind === "artifact"
            ? source.artifactPath
              ? { artifactPath: source.artifactPath }
              : {}
            : source;
    validated.push({
      id: `focus-${index}-${item.source}`,
      title: item.title,
      kind: item.kind,
      pinned: false,
      ...target,
    });
  }
  return validated;
}

/** Keep old pinned descriptions, but never retain an invalid navigation target. */
export function sanitizeDigestFocusItems(
  items: readonly ProjectDigestFocusItem[],
  sources: ReadonlyMap<string, DigestSource>,
): readonly ProjectDigestFocusItem[] {
  return items.map(({ taskId, sourceThreadId, sourceMessageId, artifactPath, ...item }) => ({
    ...item,
    ...(taskId && sources.get(taskId)?.taskId === taskId ? { taskId } : {}),
    ...(sourceThreadId && sources.get(sourceThreadId)?.sourceThreadId === sourceThreadId
      ? {
          sourceThreadId,
          ...(sourceMessageId ? { sourceMessageId } : {}),
        }
      : {}),
    ...(artifactPath && sources.get(artifactPath)?.artifactPath === artifactPath
      ? { artifactPath }
      : {}),
  }));
}

export function mergePinnedFocusItems(
  generated: ReadonlyArray<ProjectDigestFocusItem>,
  pinned: ReadonlyArray<ProjectDigestFocusItem>,
): ReadonlyArray<ProjectDigestFocusItem> {
  const seen = new Set(pinned.map((item) => item.id));
  return [
    ...pinned.map((item) => ({ ...item, pinned: true })),
    ...generated.filter((item) => !seen.has(item.id)),
  ];
}
