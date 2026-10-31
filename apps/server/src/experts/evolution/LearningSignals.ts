import { createHash } from "node:crypto";
import type {
  ExpertLearningEvidence,
  LearningChangeSet,
  LearningMemoryDraft,
  LearningSourceReference,
  SkillEvolutionEvidence,
} from "@synara/contracts";

export function learningSourceIdentity(source: LearningSourceReference): string {
  switch (source.kind) {
    case "owner":
      return `owner:${source.requestId}`;
    case "message":
      return `message:${source.threadId}:${source.messageId}`;
    case "runtime":
      return `runtime:${source.runId}:${source.eventId}`;
    case "document":
      return `document:${source.documentId}:${source.contentHash}`;
    case "attachment":
      return `attachment:${source.attachmentId}:${source.contentHash}`;
  }
}

/** Canonical identities shared by foreground receipts and the current-task evidence projection. */
export function learningSignalSources(
  evidence: ExpertLearningEvidence,
  citations?: readonly SkillEvolutionEvidence[],
): LearningSourceReference[] {
  const selected: Array<{
    item: (typeof evidence.items)[number];
    citation?: SkillEvolutionEvidence;
  }> =
    citations === undefined
      ? evidence.items.map((item) => ({ item }))
      : citations.map((citation) => {
          const item = evidence.items.find(
            (item) =>
              citation.threadId === evidence.threadId &&
              item.text.includes(citation.quote) &&
              ("eventId" in citation
                ? item.kind !== "message" && citation.eventId === (item.sourceEventId ?? item.id)
                : item.kind === "message" && citation.messageId === item.id),
          );
          if (!item) throw new Error("学习片段无法对应准确的当前任务来源。");
          return { item, citation };
        });
  const refs = selected.flatMap(({ item, citation }): LearningSourceReference[] => {
    const contentHash = `sha256:${createHash("sha256").update(item.text).digest("hex")}`;
    const fragment = citation
      ? {
          quote: citation.quote,
          fragmentHash: `sha256:${createHash("sha256").update(citation.quote).digest("hex")}`,
        }
      : {};
    if (item.kind === "message")
      return [
        {
          kind: "message",
          threadId: evidence.threadId,
          turnId: evidence.turnId,
          messageId: item.id,
          contentHash,
          ...fragment,
        },
      ];
    return evidence.rootRunId
      ? [
          {
            kind: "runtime",
            runId: evidence.rootRunId,
            eventId: item.sourceEventId ?? item.id,
            contentHash,
            ...(item.toolCallId ? { toolCallId: item.toolCallId } : {}),
            ...(item.eventSequence !== undefined ? { eventSequence: item.eventSequence } : {}),
            ...fragment,
          },
        ]
      : [];
  });
  return [
    ...new Map(
      refs.map((ref) => [`${learningSourceIdentity(ref)}:${ref.fragmentHash ?? "whole"}`, ref]),
    ).values(),
  ];
}

/** A source signal cannot reapply an already handled target or recreate a withdrawn method. */
export function handledLearningSignal(
  changes: readonly LearningChangeSet[],
  sources: readonly LearningSourceReference[],
  target: {
    readonly targetSkillId?: string | undefined;
    readonly memory?: LearningMemoryDraft | undefined;
  },
): LearningChangeSet | undefined {
  if (!sources.length) return undefined;
  const ids = new Set(sources.map(learningSourceIdentity));
  const matching = changes.filter(
    (change) =>
      (change.status === "committed" || change.status === "reverted") &&
      change.sourceRefs.some((ref) => ids.has(learningSourceIdentity(ref))),
  );
  const fragmentIdentity = (source: LearningSourceReference) => {
    const fragmentHash =
      source.fragmentHash ??
      (source.quote !== undefined
        ? `sha256:${createHash("sha256").update(source.quote).digest("hex")}`
        : undefined);
    if (fragmentHash) return `${learningSourceIdentity(source)}:${fragmentHash}`;
    if (
      source.kind !== "owner" &&
      source.startOffset !== undefined &&
      source.endOffset !== undefined
    )
      return `${learningSourceIdentity(source)}:range:${source.startOffset}:${source.endOffset}`;
    return undefined;
  };
  const coveredBy = (candidates: readonly LearningChangeSet[]) => {
    const covered = new Set(
      candidates.flatMap((change) =>
        change.sourceRefs.map(fragmentIdentity).filter((ref): ref is string => ref !== undefined),
      ),
    );
    return sources.every((ref) => {
      const fragment = fragmentIdentity(ref);
      return fragment !== undefined && covered.has(fragment);
    })
      ? candidates[0]
      : undefined;
  };
  if (target.memory)
    return coveredBy(
      matching.filter(
        (change) =>
          change.assetKind === "memory" &&
          change.data?.kind === target.memory!.kind &&
          change.data?.key === target.memory!.key,
      ),
    );
  const skills = matching.filter((change) => change.assetKind === "skill");
  if (target.targetSkillId)
    return coveredBy(
      skills.filter((change) =>
        [change.before, change.after].some(
          (ref) => ref?.assetKind === "skill" && ref.skillId === target.targetSkillId,
        ),
      ),
    );
  // A new, unassigned method supported only by a withdrawn signal has no new
  // target or new evidence. Other known targets and new signals remain eligible.
  const withdrawn = skills.filter((change) => change.status === "reverted");
  return coveredBy(withdrawn);
}
