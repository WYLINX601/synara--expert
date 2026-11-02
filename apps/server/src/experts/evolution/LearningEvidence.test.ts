import type {
  ExpertLearningEvidenceItem,
  OrchestrationMessage,
  ProviderRuntimeEvent,
} from "@synara/contracts";
import { EventId, MessageId, RuntimeItemId, ThreadId, TurnId } from "@synara/contracts";
import { describe, expect, it } from "vitest";
import {
  learningEvidenceDeltaFromRuntimeEvent,
  learningEvidenceMessagesForTurn,
  mergeLearningEvidenceItems,
} from "./LearningEvidence.ts";
import type { PersistedProviderRuntimeEvent } from "../../persistence/Services/ProviderRuntimeEvents.ts";

const baseTime = "2026-10-31T10:00:00.000Z";

function persisted(event: ProviderRuntimeEvent, sequence = 1): PersistedProviderRuntimeEvent {
  return { sequence, event };
}

describe("LearningEvidence", () => {
  it("captures bounded tool input and result while redacting credential-bearing keys", () => {
    const call = learningEvidenceDeltaFromRuntimeEvent(
      persisted({
        type: "item.started",
        eventId: EventId.makeUnsafe("event-call"),
        provider: "omp",
        threadId: ThreadId.makeUnsafe("thread-a"),
        turnId: TurnId.makeUnsafe("turn-a"),
        lifecycleGeneration: "generation-a",
        itemId: RuntimeItemId.makeUnsafe("tool-call-a"),
        createdAt: baseTime,
        payload: {
          itemType: "command_execution",
          status: "inProgress",
          title: "Run tests",
          detail: "bun run test --file x.test.ts",
          data: {
            tool: "shell",
            command: "bun run test --file x.test.ts",
            apiKey: "do-not-store-call-secret",
            options: { authorization: "Bearer do-not-store-auth" },
          },
        },
      }),
    );
    expect(call.items).toHaveLength(1);
    expect(call.items[0]).toMatchObject({ id: "tool-call:tool-call-a", kind: "tool_call" });
    expect(call.items[0]?.text).toContain("bun run test");
    expect(call.items[0]?.text).not.toContain("do-not-store-call-secret");
    expect(call.items[0]?.text).not.toContain("do-not-store-auth");
    expect(call.coverage).toContain("tool-input-credentials-redacted");

    const result = learningEvidenceDeltaFromRuntimeEvent(
      persisted(
        {
          type: "item.completed",
          eventId: EventId.makeUnsafe("event-result"),
          provider: "omp",
          threadId: ThreadId.makeUnsafe("thread-a"),
          turnId: TurnId.makeUnsafe("turn-a"),
          lifecycleGeneration: "generation-a",
          itemId: RuntimeItemId.makeUnsafe("tool-call-a"),
          createdAt: baseTime,
          payload: {
            itemType: "command_execution",
            status: "failed",
            title: "Run tests",
            detail: "test failed at assertion",
            data: {
              exitCode: 1,
              output: "test failed at assertion",
              password: "do-not-store-result-secret",
            },
          },
        },
        2,
      ),
    );
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({ id: "tool-result:tool-call-a", kind: "tool_result" });
    expect(result.items[0]?.text).toContain("Status: failed");
    expect(result.items[0]?.text).toContain("test failed at assertion");
    expect(result.items[0]?.text).not.toContain("do-not-store-result-secret");
    expect(result.coverage).toContain("tool-result-credentials-redacted");
  });

  it("does not capture private reasoning or content-delta envelopes", () => {
    const delta = learningEvidenceDeltaFromRuntimeEvent(
      persisted({
        type: "content.delta",
        eventId: EventId.makeUnsafe("reasoning-event"),
        provider: "pi",
        threadId: ThreadId.makeUnsafe("thread-a"),
        turnId: TurnId.makeUnsafe("turn-a"),
        lifecycleGeneration: "generation-a",
        createdAt: baseTime,
        payload: { streamKind: "reasoning_text", delta: "private thought" },
      }),
    );
    expect(delta.items).toEqual([]);
    expect(delta.coverage).toEqual([]);
  });

  it("keeps only transcript messages from the exact turn and uses their actual message ids", () => {
    const turnId = TurnId.makeUnsafe("turn-a");
    const messages: OrchestrationMessage[] = [
      {
        id: MessageId.makeUnsafe("message-user-a"),
        role: "user",
        text: "Please verify the fix.",
        turnId: null,
        streaming: false,
        source: "native",
        createdAt: baseTime,
        updatedAt: baseTime,
      },
      {
        id: MessageId.makeUnsafe("message-assistant-a"),
        role: "assistant",
        text: "The focused check passed.",
        turnId,
        streaming: false,
        source: "native",
        createdAt: baseTime,
        updatedAt: baseTime,
      },
      {
        id: MessageId.makeUnsafe("message-system-a"),
        role: "system",
        text: "Never persist this.",
        turnId,
        streaming: false,
        source: "native",
        createdAt: baseTime,
        updatedAt: baseTime,
      },
      {
        id: MessageId.makeUnsafe("message-user-other-turn"),
        role: "user",
        text: "Another turn.",
        turnId: TurnId.makeUnsafe("turn-b"),
        streaming: false,
        source: "native",
        createdAt: baseTime,
        updatedAt: baseTime,
      },
    ];
    const slice = learningEvidenceMessagesForTurn({
      messages,
      turnId,
      pendingMessageId: "message-user-a",
    });
    expect(slice.items.map((item) => [item.id, item.role])).toEqual([
      ["message-user-a", "user"],
      ["message-assistant-a", "assistant"],
    ]);
    expect(slice.coverage).toEqual([]);
    expect(slice.hasUserMessage).toBe(true);
    expect(slice.hasAssistantMessage).toBe(true);
  });

  it("marks transcript omissions and keeps the bounded item set replay-safe", () => {
    const slice = learningEvidenceMessagesForTurn({
      messages: [],
      turnId: TurnId.makeUnsafe("turn-a"),
      pendingMessageId: "message-missing",
      transcriptWasTruncated: true,
    });
    expect(slice.coverage).toEqual([
      "user-message-missing",
      "assistant-message-missing",
      "turn-request-message-missing",
      "transcript-tail-truncated",
    ]);

    const existing: ExpertLearningEvidenceItem[] = [
      { id: "tool-result:x", kind: "tool_result", text: "old", eventSequence: 3 },
    ];
    const incoming: ExpertLearningEvidenceItem[] = [
      { id: "tool-result:x", kind: "tool_result", text: "corrected", eventSequence: 3 },
      ...Array.from({ length: 128 }, (_, index) => ({
        id: `tool-result:${index}`,
        kind: "tool_result" as const,
        text: `result ${index}`,
        eventSequence: index + 4,
      })),
    ];
    const merged = mergeLearningEvidenceItems(existing, incoming);
    expect(merged.items.length).toBeLessThanOrEqual(128);
    expect(mergeLearningEvidenceItems(existing, incoming.slice(0, 1)).items[0]?.text).toBe(
      "corrected",
    );
    expect(merged.truncated).toBe(true);
  });

  it("retains the user correction, final response and latest verification ahead of early tools", () => {
    const early: ExpertLearningEvidenceItem[] = Array.from({ length: 128 }, (_, index) => ({
      id: `result-${index}`,
      kind: "tool_result",
      text: "result",
      eventSequence: index + 1,
    }));
    const essential: ExpertLearningEvidenceItem[] = [
      { id: "user", kind: "message", role: "user", text: "Long-term correction", eventSequence: 0 },
      { id: "verified", kind: "verification", text: "Final check failed", eventSequence: 129 },
      {
        id: "assistant",
        kind: "message",
        role: "assistant",
        text: "Final conclusion",
        eventSequence: 130,
      },
    ];
    const merged = mergeLearningEvidenceItems(early, essential);
    expect(merged.items).toHaveLength(128);
    for (const item of essential) expect(merged.items).toContainEqual(item);
    expect(merged.items.some((item) => item.id === "result-0")).toBe(false);
    expect(merged.items.at(-1)?.id).toBe("assistant");
    expect(mergeLearningEvidenceItems(merged.items, essential)).toEqual({
      items: merged.items,
      truncated: false,
    });
  });
});
