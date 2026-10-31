import { createHash } from "node:crypto";
import type {
  ExpertLearningEvidence,
  LearningChangeSet,
  LearningMemoryDraft,
  LearningSourceReference,
  SkillEvolutionEvidence,
} from "@synara/contracts";
import { describe, expect, it } from "vitest";
import {
  handledLearningSignal,
  learningSignalSources,
  learningSourceIdentity,
} from "./LearningSignals";

const contentHash = `sha256:${"a".repeat(64)}`;
const fragmentHash = (quote: string) =>
  `sha256:${createHash("sha256").update(quote, "utf8").digest("hex")}`;

function messageSource(
  threadId: string,
  messageId: string,
  quote = "Signal excerpt.",
): LearningSourceReference {
  return {
    kind: "message",
    threadId,
    messageId,
    turnId: "turn-signal-test",
    contentHash,
    quote,
    fragmentHash: fragmentHash(quote),
  };
}

function change(
  patch: Partial<LearningChangeSet> &
    Pick<LearningChangeSet, "assetKind" | "sourceRefs" | "status">,
): LearningChangeSet {
  return {
    changeId: "change-signal-test",
    requestId: "request-signal-test",
    requestFingerprint: contentHash,
    ownerId: "owner-signal-test",
    expertId: "expert-signal-test",
    sourceScope: {
      ownerId: "owner-signal-test",
      spaceId: "space-signal-test",
      expertId: "expert-signal-test",
      projectId: "project-signal-test",
    },
    summary: "Signal test receipt.",
    createdAt: "2026-10-31T00:00:00.000Z",
    updatedAt: "2026-10-31T00:00:00.000Z",
    ...patch,
  };
}

const memoryDraft: LearningMemoryDraft = {
  kind: "rule",
  key: "writing.concise",
  content: "Lead with the conclusion.",
  expectedRevision: 0,
};

describe("LearningSignals", () => {
  it("matches runtime citations by native event ID instead of projected item ID", () => {
    const rootRunId = `root-run:${"r".repeat(1_950)}`;
    const itemText = "tool result: verified decision log";
    const evidence: ExpertLearningEvidence = {
      evidenceId: "evidence-runtime-signal",
      ownerId: "owner-signal-test",
      expertId: "expert-signal-test",
      threadId: "thread-runtime-signal",
      turnId: "turn-signal-test",
      rootRunId,
      snapshotId: "snapshot-signal-test",
      projectId: "project-signal-test",
      modelSelection: { provider: "pi", instanceId: "pi-local", model: "test-model" },
      items: [
        {
          id: "tool-result:call-17",
          sourceEventId: "native-event-17",
          kind: "tool_result",
          toolCallId: "call-17",
          eventSequence: 17,
          text: itemText,
        },
      ],
      coverage: [],
      updatedAt: "2026-10-31T00:00:00.000Z",
    };
    const citation: SkillEvolutionEvidence = {
      kind: "runtime",
      threadId: evidence.threadId as never,
      eventId: "native-event-17",
      quote: itemText,
    };

    const sources = learningSignalSources(evidence, [citation]);

    expect(sources).toEqual([
      {
        kind: "runtime",
        runId: rootRunId,
        eventId: "native-event-17",
        contentHash: `sha256:${createHash("sha256").update(itemText).digest("hex")}`,
        quote: itemText,
        fragmentHash: fragmentHash(itemText),
        toolCallId: "call-17",
        eventSequence: 17,
      },
    ]);
    const source = sources[0];
    expect(source?.kind).toBe("runtime");
    expect(source?.kind === "runtime" ? source.eventId : undefined).not.toBe("tool-result:call-17");
  });

  it("keeps message source identity bound to its thread", () => {
    const evidence: ExpertLearningEvidence = {
      evidenceId: "evidence-message-signal",
      ownerId: "owner-signal-test",
      expertId: "expert-signal-test",
      threadId: "thread-a",
      turnId: "turn-signal-test",
      snapshotId: "snapshot-signal-test",
      projectId: "project-signal-test",
      modelSelection: { provider: "pi", instanceId: "pi-local", model: "test-model" },
      items: [{ id: "same-message", kind: "message", role: "user", text: "Keep it concise." }],
      coverage: [],
      updatedAt: "2026-10-31T00:00:00.000Z",
    };
    const wrongThread: SkillEvolutionEvidence = {
      threadId: "thread-b" as never,
      messageId: "same-message" as never,
      quote: "Keep it concise.",
    };
    const correctThread: SkillEvolutionEvidence = {
      threadId: "thread-a" as never,
      messageId: "same-message" as never,
      quote: "Keep it concise.",
    };

    expect(() => learningSignalSources(evidence, [wrongThread])).toThrow(/准确的当前任务来源/u);
    const correctSource = learningSignalSources(evidence, [correctThread])[0]!;
    const otherThreadSource = messageSource("thread-b", "same-message");
    const priorChange = change({
      assetKind: "memory",
      sourceRefs: [correctSource],
      status: "reverted",
      data: { kind: "rule", key: "writing.concise" },
    });
    const opportunity = { memory: memoryDraft };

    expect(learningSourceIdentity(correctSource)).not.toBe(
      learningSourceIdentity(otherThreadSource),
    );
    expect(handledLearningSignal([priorChange], [correctSource], opportunity)).toBe(priorChange);
    expect(handledLearningSignal([priorChange], [otherThreadSource], opportunity)).toBeUndefined();
  });

  it("retains each exact citation fragment from one message and rejects invalid source claims", () => {
    const text =
      "Old correction: keep the introduction short. New correction: include source limitations.";
    const threadId = "thread-multiple-citations";
    const messageId = "message-multiple-citations";
    const evidence: ExpertLearningEvidence = {
      evidenceId: "evidence-multiple-citations",
      ownerId: "owner-signal-test",
      expertId: "expert-signal-test",
      threadId,
      turnId: "turn-signal-test",
      snapshotId: "snapshot-signal-test",
      projectId: "project-signal-test",
      modelSelection: { provider: "pi", instanceId: "pi-local", model: "test-model" },
      items: [{ id: messageId, kind: "message", role: "user", text }],
      coverage: [],
      updatedAt: "2026-10-31T00:00:00.000Z",
    };
    const oldQuote = "Old correction: keep the introduction short.";
    const newQuote = "New correction: include source limitations.";
    const oldCitation: SkillEvolutionEvidence = {
      threadId: threadId as never,
      messageId: messageId as never,
      quote: oldQuote,
    };
    const newCitation: SkillEvolutionEvidence = {
      threadId: threadId as never,
      messageId: messageId as never,
      quote: newQuote,
    };

    const sources = learningSignalSources(evidence, [oldCitation, newCitation]);
    expect(sources).toHaveLength(2);
    expect(sources.map((source) => source.quote)).toEqual([oldQuote, newQuote]);
    expect(sources.map((source) => source.fragmentHash)).toEqual([
      fragmentHash(oldQuote),
      fragmentHash(newQuote),
    ]);

    const alreadyHandledOldCorrection = change({
      assetKind: "memory",
      sourceRefs: [sources[0]!],
      status: "reverted",
      data: { kind: "rule", key: memoryDraft.key },
    });
    expect(
      handledLearningSignal([alreadyHandledOldCorrection], sources, { memory: memoryDraft }),
    ).toBeUndefined();
    expect(learningSignalSources(evidence, [oldCitation, { ...oldCitation }])).toHaveLength(1);

    expect(() =>
      learningSignalSources(evidence, [{ ...oldCitation, messageId: "another-message" as never }]),
    ).toThrow(/准确的当前任务来源/u);
    expect(() =>
      learningSignalSources(evidence, [{ ...oldCitation, threadId: "another-thread" as never }]),
    ).toThrow(/准确的当前任务来源/u);
    expect(() =>
      learningSignalSources(evidence, [
        { ...oldCitation, quote: "Correction: this text was not in the message." },
      ]),
    ).toThrow(/准确的当前任务来源/u);
  });

  it("suppresses only the same handled topic, target, and source; empty or pending receipts do not count", () => {
    const oldSource = messageSource("thread-a", "message-old");
    const newSource = messageSource("thread-a", "message-new");
    const oldMemory = change({
      assetKind: "memory",
      sourceRefs: [oldSource],
      status: "committed",
      data: { kind: "rule", key: "writing.concise", private: "not used for identity" },
    });
    const otherTopic: LearningMemoryDraft = { ...memoryDraft, key: "writing.formal" };

    expect(handledLearningSignal([oldMemory], [oldSource], { memory: memoryDraft })).toBe(
      oldMemory,
    );
    expect(handledLearningSignal([oldMemory], [oldSource], { memory: otherTopic })).toBeUndefined();
    expect(
      handledLearningSignal([oldMemory], [newSource], { memory: memoryDraft }),
    ).toBeUndefined();
    expect(
      handledLearningSignal([oldMemory], [oldSource, newSource], { memory: memoryDraft }),
    ).toBeUndefined();
    const oldMemoryForNewSource = {
      ...oldMemory,
      changeId: "change-memory-new-source",
      requestId: "request-memory-new-source",
      sourceRefs: [newSource],
    };
    expect(
      handledLearningSignal([oldMemory, oldMemoryForNewSource], [oldSource, newSource], {
        memory: memoryDraft,
      }),
    ).toBe(oldMemory);
    expect(handledLearningSignal([oldMemory], [], { memory: memoryDraft })).toBeUndefined();
    expect(
      handledLearningSignal([{ ...oldMemory, status: "prepared" }], [oldSource], {
        memory: memoryDraft,
      }),
    ).toBeUndefined();

    const oldSkill = change({
      assetKind: "skill",
      sourceRefs: [oldSource],
      status: "reverted",
      before: {
        assetKind: "skill",
        skillId: "skill-old-target",
        packageId: "package-old",
        revision: 2,
      },
    });
    expect(
      handledLearningSignal([oldSkill], [oldSource], { targetSkillId: "skill-old-target" }),
    ).toBe(oldSkill);
    expect(
      handledLearningSignal([oldSkill], [oldSource], { targetSkillId: "skill-new-target" }),
    ).toBeUndefined();
    expect(
      handledLearningSignal([oldSkill], [newSource], { targetSkillId: "skill-old-target" }),
    ).toBeUndefined();
    expect(
      handledLearningSignal([oldSkill], [oldSource, newSource], {
        targetSkillId: "skill-old-target",
      }),
    ).toBeUndefined();
    const oldSkillForNewSource = {
      ...oldSkill,
      changeId: "change-skill-new-source",
      requestId: "request-skill-new-source",
      sourceRefs: [newSource],
    };
    expect(
      handledLearningSignal([oldSkill, oldSkillForNewSource], [oldSource, newSource], {
        targetSkillId: "skill-old-target",
      }),
    ).toBe(oldSkill);
    expect(handledLearningSignal([oldSkill], [oldSource], {})).toBe(oldSkill);
    expect(handledLearningSignal([oldSkill], [oldSource, newSource], {})).toBeUndefined();
    expect(
      handledLearningSignal([oldSkill, oldSkillForNewSource], [oldSource, newSource], {}),
    ).toBe(oldSkill);
  });

  it("does not conflate disjoint quoted fragments on the same message and skips only full fragment coverage", () => {
    const first = messageSource("thread-fragments", "same-message", "The first stable preference.");
    const second = messageSource(
      "thread-fragments",
      "same-message",
      "The separate new preference.",
    );
    const firstMemory = change({
      assetKind: "memory",
      sourceRefs: [first],
      status: "committed",
      data: { kind: "rule", key: "writing.concise" },
    });
    const secondMemory = {
      ...firstMemory,
      changeId: "change-memory-second-fragment",
      requestId: "request-memory-second-fragment",
      sourceRefs: [second],
    };
    expect(handledLearningSignal([firstMemory], [second], { memory: memoryDraft })).toBeUndefined();
    expect(handledLearningSignal([firstMemory], [first], { memory: memoryDraft })).toBe(
      firstMemory,
    );
    expect(
      handledLearningSignal([firstMemory, secondMemory], [first, second], {
        memory: memoryDraft,
      }),
    ).toBe(firstMemory);

    const firstSkill = change({
      assetKind: "skill",
      sourceRefs: [first],
      status: "reverted",
      before: {
        assetKind: "skill",
        skillId: "skill-fragment-target",
        packageId: "package-fragment-target",
        revision: 1,
      },
    });
    const secondSkill = {
      ...firstSkill,
      changeId: "change-skill-second-fragment",
      requestId: "request-skill-second-fragment",
      sourceRefs: [second],
    };
    expect(
      handledLearningSignal([firstSkill], [second], { targetSkillId: "skill-fragment-target" }),
    ).toBeUndefined();
    expect(
      handledLearningSignal([firstSkill], [first], { targetSkillId: "skill-fragment-target" }),
    ).toBe(firstSkill);
    expect(
      handledLearningSignal([firstSkill, secondSkill], [first, second], {
        targetSkillId: "skill-fragment-target",
      }),
    ).toBe(firstSkill);
  });
});
