import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  MessageId,
  ProjectId,
  ThreadId,
  TurnId,
  type AmbientContextSnapshot,
  type OrchestrationEvent,
} from "@synara/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const PROJECT_ID = ProjectId.makeUnsafe("project-fork-turn");
const SOURCE_THREAD_ID = ThreadId.makeUnsafe("thread-fork-turn-source");
const FORK_THREAD_ID = ThreadId.makeUnsafe("thread-fork-turn-target");
const APPLE_MESSAGE_ID = MessageId.makeUnsafe("assistant:apple");
const MODEL_SELECTION = { provider: "claudeAgent" as const, model: "claude-sonnet-4-6" };
const ambientContext: AmbientContextSnapshot = {
  schemaVersion: 1,
  id: "snapshot-fork-import",
  capturedAt: "2026-10-09T00:00:00.000Z",
  items: [
    {
      observation: {
        schemaVersion: 1,
        id: "observation-fork-import",
        targetKey: "target-fork-import",
        capturedAt: "2026-10-09T00:00:00.000Z",
        method: "selection event",
        confidence: "exact",
        type: "selection.text",
        value: { text: "forked selection" },
      },
      provenance: [
        {
          sourceId: "source-fork-import",
          observationId: "observation-fork-import",
          capturedAt: "2026-10-09T00:00:00.000Z",
          method: "selection event",
          confidence: "exact",
        },
      ],
      ambiguous: false,
    },
  ],
};

const eventBase = (sequence: number, aggregateKind: "project" | "thread", aggregateId: string) => ({
  sequence,
  eventId: EventId.makeUnsafe(`evt-${sequence}`),
  aggregateKind,
  aggregateId,
  occurredAt: "2026-10-09T00:00:00.000Z",
  commandId: CommandId.makeUnsafe(`cmd-${sequence}`),
  causationEventId: null,
  correlationId: CommandId.makeUnsafe(`cmd-${sequence}`),
  metadata: {},
});

async function createSourceReadModel() {
  const now = "2026-10-09T00:00:00.000Z";
  const events = [
    {
      ...eventBase(1, "project", PROJECT_ID),
      type: "project.created",
      payload: {
        projectId: PROJECT_ID,
        kind: "project",
        title: "Project",
        workspaceRoot: "/tmp/project",
        defaultModelSelection: null,
        scripts: [],
        createdAt: now,
        updatedAt: now,
      },
    },
    {
      ...eventBase(2, "thread", SOURCE_THREAD_ID),
      type: "thread.created",
      payload: {
        threadId: SOURCE_THREAD_ID,
        projectId: PROJECT_ID,
        title: "Words",
        modelSelection: MODEL_SELECTION,
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "full-access",
        envMode: "local",
        branch: null,
        worktreePath: null,
        createdAt: now,
        updatedAt: now,
      },
    },
    {
      ...eventBase(3, "thread", SOURCE_THREAD_ID),
      type: "thread.message-sent",
      payload: {
        threadId: SOURCE_THREAD_ID,
        messageId: APPLE_MESSAGE_ID,
        role: "assistant",
        text: "ok",
        turnId: TurnId.makeUnsafe("turn-apple"),
        streaming: false,
        createdAt: now,
        updatedAt: now,
      },
    },
  ] as unknown as ReadonlyArray<OrchestrationEvent>;
  let readModel = createEmptyReadModel(now);
  for (const event of events) {
    readModel = await Effect.runPromise(projectEvent(readModel, event));
  }
  return readModel;
}

const forkCommand = (throughMessageId: MessageId) => ({
  type: "thread.fork.create" as const,
  commandId: CommandId.makeUnsafe("cmd-fork-through-turn"),
  threadId: FORK_THREAD_ID,
  sourceThreadId: SOURCE_THREAD_ID,
  projectId: PROJECT_ID,
  title: "Words",
  modelSelection: MODEL_SELECTION,
  interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
  runtimeMode: "full-access" as const,
  envMode: "local" as const,
  branch: null,
  worktreePath: null,
  createBranchFlowCompleted: false,
  throughMessageId,
  importedMessages: [],
  createdAt: "2026-10-09T00:01:00.000Z",
});

describe("thread.fork.create from a turn", () => {
  it("records the chosen source message so the provider fork can stop there", async () => {
    const readModel = await createSourceReadModel();
    const result = await Effect.runPromise(
      decideOrchestrationCommand({ command: forkCommand(APPLE_MESSAGE_ID), readModel }),
    );
    const createdEvent = (Array.isArray(result) ? result : [result])[0];
    expect(createdEvent?.type).toBe("thread.created");
    if (!createdEvent || createdEvent.type !== "thread.created") return;
    expect(createdEvent.payload.forkSourceThreadId).toBe(SOURCE_THREAD_ID);
    expect(createdEvent.payload.forkSourceMessageId).toBe(APPLE_MESSAGE_ID);

    const projected = await Effect.runPromise(
      projectEvent(readModel, { ...createdEvent, sequence: 4 } as OrchestrationEvent),
    );
    expect(
      projected.threads.find((thread) => thread.id === FORK_THREAD_ID)?.forkSourceMessageId,
    ).toBe(APPLE_MESSAGE_ID);
  });

  it("copies each saved user-message ambient snapshot into fork-import events", async () => {
    const readModel = await createSourceReadModel();
    const result = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          ...forkCommand(APPLE_MESSAGE_ID),
          importedMessages: [
            {
              messageId: MessageId.makeUnsafe("user:ambient-fork"),
              role: "user",
              text: "Continue with this selection",
              ambientContext,
              createdAt: "2026-10-09T00:00:00.000Z",
              updatedAt: "2026-10-09T00:00:00.000Z",
            },
          ],
        },
        readModel,
      }),
    );
    const importedMessage = (Array.isArray(result) ? result : [result]).find(
      (event) => event.type === "thread.message-sent",
    );
    expect(importedMessage?.type).toBe("thread.message-sent");
    if (importedMessage?.type !== "thread.message-sent") return;
    expect(importedMessage.payload.ambientContext).toEqual(ambientContext);
  });
});
