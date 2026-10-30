import {
  EventId,
  MessageId,
  RuntimeItemId,
  ThreadId,
  TurnId,
  type ModelSelection as ModelSelectionType,
  type OrchestrationMessage,
  type OrchestrationProjectShell,
  type OrchestrationThreadShell,
  type ProviderRuntimeEvent,
} from "@synara/contracts";
import { Cause, Effect, Layer, Option } from "effect";
import { describe, expect, it } from "vitest";
import {
  ExpertLearningRepository,
  type ExpertLearningRepositoryShape,
} from "../../experts/evolution/ExpertLearningRepository.ts";
import {
  SkillEvolutionRepository,
  type SkillEvolutionRepositoryShape,
} from "../../experts/evolution/SkillEvolutionRepository.ts";
import {
  ExpertAppliedRuntimeRepository,
  type ExpertAppliedRuntimeRepositoryShape,
} from "../../persistence/Services/ExpertAppliedRuntimeRecords.ts";
import {
  ProjectionTurnRepository,
  type ProjectionTurnRepositoryShape,
  type ProjectionTurnById,
} from "../../persistence/Services/ProjectionTurns.ts";
import {
  ProjectionSnapshotQuery,
  type ProjectionSnapshotQueryShape,
} from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import type { PersistedProviderRuntimeEvent } from "../../persistence/Services/ProviderRuntimeEvents.ts";
import { makeExpertLearningEvidenceCapture } from "./expertLearningEvidence.ts";

const enabledAt = "2026-10-31T09:00:00.000Z";
const requestedAt = "2026-10-31T09:01:00.000Z";
const completedAt = "2026-10-31T09:03:00.000Z";
const threadId = ThreadId.makeUnsafe("thread-learning-a");
const turnId = TurnId.makeUnsafe("turn-learning-a");
const expertId = "expert-learning-a";
const snapshotId = "snapshot-learning-a";
const modelSelection: ModelSelectionType = {
  provider: "omp",
  instanceId: "omp",
  model: "gpt-5.4",
};

function enabledState(ownerId = "owner-a", revision = 3) {
  return {
    ownerId,
    expertId,
    revision,
    updatedAt: enabledAt,
    record: JSON.stringify({
      ownerKind: "principal",
      enabledAt,
      state: {
        expertId,
        enabled: true,
        epoch: 2,
        revision,
        harnessKind: "omp",
      },
    }),
  };
}

function makeFixture(options?: {
  readonly states?: ReadonlyArray<ReturnType<typeof enabledState>>;
  readonly extraction?: boolean;
  readonly failEvidenceWrite?: boolean;
  readonly includeLearningRepository?: boolean;
  readonly omitAppliedModel?: boolean;
  readonly omitRequestInstanceId?: boolean;
  readonly sessionInstanceId?: string;
  readonly includeAppliedRuntimeRepository?: boolean;
}) {
  const evidenceRows = new Map<
    string,
    {
      readonly evidenceId: string;
      readonly ownerId: string;
      readonly expertId: string;
      readonly threadId: string;
      readonly turnId: string;
      readonly record: string;
      readonly updatedAt: string;
    }
  >();
  const writes: string[] = [];
  const learning: ExpertLearningRepositoryShape = {
    readState: () => Effect.succeed(undefined),
    listStates: () => Effect.succeed(options?.states ?? [enabledState()]),
    writeState: () => Effect.void,
    readEvidence: (id) => Effect.succeed(evidenceRows.get(id)),
    listEvidence: () => Effect.succeed([...evidenceRows.values()]),
    writeEvidence: (row) => {
      if (options?.failEvidenceWrite)
        return Effect.fail(new Error("learning evidence database write failed"));
      writes.push(row.evidenceId);
      evidenceRows.set(row.evidenceId, row);
      return Effect.void;
    },
    readCycle: () => Effect.succeed(undefined),
    listCycles: () => Effect.succeed([]),
    writeCycle: () => Effect.void,
  };

  const threadModelSelection = options?.omitRequestInstanceId
    ? ({ provider: "omp", model: "gpt-5.4" } as unknown as ModelSelectionType)
    : modelSelection;
  const thread = {
    id: threadId,
    projectId: "project-learning-a",
    expertBinding: { expertId, snapshotId, displayName: "Test Expert", revision: 1 },
    modelSelection: threadModelSelection,
    ...(options?.sessionInstanceId
      ? {
          session: {
            providerName: "omp",
            providerInstanceId: options.sessionInstanceId,
          },
        }
      : {}),
  } as unknown as OrchestrationThreadShell;
  const project = {
    id: "project-learning-a",
    spaceId: "space-learning-a",
  } as unknown as OrchestrationProjectShell;
  const messages: OrchestrationMessage[] = [
    {
      id: MessageId.makeUnsafe("source-user-message"),
      role: "user",
      text: "Run the focused check, fix any failure, then report the result.",
      turnId,
      streaming: false,
      source: "native",
      createdAt: requestedAt,
      updatedAt: requestedAt,
    },
    {
      id: MessageId.makeUnsafe("source-assistant-message"),
      role: "assistant",
      text: "I fixed the failure and the focused check passed.",
      turnId,
      streaming: false,
      source: "native",
      createdAt: completedAt,
      updatedAt: completedAt,
    },
    {
      id: MessageId.makeUnsafe("other-turn-message"),
      role: "user",
      text: "Must not leak into this snapshot.",
      turnId: TurnId.makeUnsafe("another-turn"),
      streaming: false,
      source: "native",
      createdAt: completedAt,
      updatedAt: completedAt,
    },
  ];
  const projection: Partial<ProjectionSnapshotQueryShape> = {
    getThreadShellById: () => Effect.succeed(Option.some(thread)),
    getProjectShellById: () => Effect.succeed(Option.some(project)),
    getThreadMentionContextById: () =>
      Effect.succeed(
        Option.some({
          id: threadId,
          title: "Capture test",
          modelSelection: threadModelSelection,
          messages,
          totalMessageCount: messages.length,
        }),
      ),
  };
  const turn: ProjectionTurnById = {
    threadId: threadId as ProjectionTurnById["threadId"],
    turnId,
    pendingMessageId: MessageId.makeUnsafe("source-user-message"),
    sourceProposedPlanThreadId: null,
    sourceProposedPlanId: null,
    assistantMessageId: MessageId.makeUnsafe("source-assistant-message"),
    state: "completed",
    requestedAt,
    startedAt: requestedAt,
    completedAt,
    checkpointTurnCount: null,
    checkpointRef: null,
    checkpointStatus: null,
    checkpointFiles: [],
  };
  const turnRepository: Partial<ProjectionTurnRepositoryShape> = {
    getByTurnId: () => Effect.succeed(Option.some(turn)),
  };
  const appliedRuntime: Partial<ExpertAppliedRuntimeRepositoryShape> = {
    getByThreadId: () =>
      Effect.succeed(
        Option.some({
          threadId,
          snapshotId,
          provider: "omp",
          ...(!options?.omitAppliedModel ? { model: "gpt-5.4" } : {}),
          lifecycleGeneration: "generation-learning-a",
          appliedAt: requestedAt,
        }),
      ),
  };
  const evolution: Partial<SkillEvolutionRepositoryShape> = {
    execution: () =>
      Effect.succeed(
        options?.extraction
          ? { requestId: "extract-a", ownerId: "owner-a", modelSelection }
          : undefined,
      ),
  };
  const layers = [
    ...(options?.includeLearningRepository === false
      ? []
      : [Layer.succeed(ExpertLearningRepository, learning)]),
    Layer.succeed(SkillEvolutionRepository, evolution as SkillEvolutionRepositoryShape),
    ...(options?.includeAppliedRuntimeRepository === false
      ? []
      : [
          Layer.succeed(
            ExpertAppliedRuntimeRepository,
            appliedRuntime as ExpertAppliedRuntimeRepositoryShape,
          ),
        ]),
    Layer.succeed(ProjectionTurnRepository, turnRepository as ProjectionTurnRepositoryShape),
    Layer.succeed(ProjectionSnapshotQuery, projection as ProjectionSnapshotQueryShape),
  ];
  const layer = Layer.mergeAll(
    ...(layers as [(typeof layers)[number], ...(typeof layers)[number][]]),
  );
  return { evidenceRows, writes, layer };
}

function runtimeEntry(
  event: ProviderRuntimeEvent,
  sequence: number,
): PersistedProviderRuntimeEvent {
  return { event, sequence };
}

function turnStarted(
  providerInstanceId: string | undefined = "omp",
  selection: { readonly model?: string; readonly effort?: "medium" | "high" } = {},
): ProviderRuntimeEvent {
  return {
    type: "turn.started",
    eventId: EventId.makeUnsafe("start-event"),
    provider: "omp",
    ...(providerInstanceId !== undefined ? { providerInstanceId } : {}),
    lifecycleGeneration: "generation-learning-a",
    threadId,
    turnId,
    createdAt: requestedAt,
    payload: {
      model: selection.model ?? "gpt-5.4",
      effort: selection.effort ?? "medium",
    },
  };
}

function modelRerouted(fromModel: string, toModel: string): ProviderRuntimeEvent {
  return {
    type: "model.rerouted",
    eventId: EventId.makeUnsafe("model-rerouted-event"),
    provider: "omp",
    providerInstanceId: "omp",
    lifecycleGeneration: "generation-learning-a",
    threadId,
    turnId,
    createdAt: "2026-10-31T09:01:30.000Z",
    payload: { fromModel, toModel, reason: "runtime fallback" },
  };
}

function toolCompleted(): ProviderRuntimeEvent {
  return {
    type: "item.completed",
    eventId: EventId.makeUnsafe("tool-result-event"),
    provider: "omp",
    providerInstanceId: "omp",
    lifecycleGeneration: "generation-learning-a",
    threadId,
    turnId,
    itemId: RuntimeItemId.makeUnsafe("tool-a"),
    createdAt: "2026-10-31T09:02:00.000Z",
    payload: {
      itemType: "command_execution",
      status: "completed",
      title: "Focused test",
      detail: "1 test passed",
      data: { exitCode: 0, password: "private-secret" },
    },
  };
}

function normalCompletion(): ProviderRuntimeEvent {
  return {
    type: "turn.completed",
    eventId: EventId.makeUnsafe("completion-event"),
    provider: "omp",
    providerInstanceId: "omp",
    lifecycleGeneration: "generation-learning-a",
    threadId,
    turnId,
    createdAt: completedAt,
    payload: { state: "completed" },
  };
}

describe("expert learning evidence capture", () => {
  it("writes an idempotent, turn-scoped completed snapshot with its enable epoch", async () => {
    const fixture = makeFixture();
    const capture = await Effect.runPromise(
      Effect.provide(makeExpertLearningEvidenceCapture, fixture.layer),
    );
    const start = runtimeEntry(turnStarted(), 1);
    const result = runtimeEntry(toolCompleted(), 2);
    const completion = runtimeEntry(normalCompletion(), 3);
    await Effect.runPromise(capture(start, turnId));
    await Effect.runPromise(capture(result, turnId));
    await Effect.runPromise(capture(completion, turnId));
    await Effect.runPromise(capture(completion, turnId));

    expect(fixture.evidenceRows.size).toBe(1);
    expect(fixture.writes).toHaveLength(3);
    const record = JSON.parse([...fixture.evidenceRows.values()][0]!.record) as {
      readonly learningEpoch: number;
      readonly modelSelection: ModelSelectionType;
      readonly completedAt?: string;
      readonly items: ReadonlyArray<{ readonly id: string; readonly text: string }>;
      readonly coverage: ReadonlyArray<string>;
    };
    expect(record.learningEpoch).toBe(2);
    expect(record.modelSelection).toMatchObject({ provider: "omp", model: "gpt-5.4" });
    expect(record.completedAt).toBe(completedAt);
    expect(new Set(record.items.map((item) => item.id))).toEqual(
      new Set(["source-user-message", "tool-result:tool-a", "source-assistant-message"]),
    );
    expect(record.items.some((item) => item.text.includes("Must not leak"))).toBe(false);
    expect(record.items.some((item) => item.text.includes("private-secret"))).toBe(false);
    expect(record.coverage).toContain("run-assembly-unattributed");
  });

  it.each([
    ["turn.started", [turnStarted("omp", { model: "gpt-5.5", effort: "high" })]],
    [
      "model.rerouted",
      [
        turnStarted("omp", { model: "gpt-5.4", effort: "high" }),
        modelRerouted("gpt-5.4", "gpt-5.5"),
      ],
    ],
  ] as const)(
    "retains the model from %s across tool and completion events",
    async (_source, selectionEvents) => {
      const fixture = makeFixture();
      const capture = await Effect.runPromise(
        Effect.provide(makeExpertLearningEvidenceCapture, fixture.layer),
      );
      let sequence = 1;
      for (const event of selectionEvents) {
        await Effect.runPromise(capture(runtimeEntry(event, sequence++), turnId));
      }
      await Effect.runPromise(capture(runtimeEntry(toolCompleted(), sequence++), turnId));
      await Effect.runPromise(capture(runtimeEntry(normalCompletion(), sequence), turnId));

      const record = JSON.parse([...fixture.evidenceRows.values()][0]!.record) as {
        readonly modelSelection: ModelSelectionType;
      };
      expect(record.modelSelection).toMatchObject({
        provider: "omp",
        instanceId: "omp",
        model: "gpt-5.5",
        options: { thinkingLevel: "high" },
      });
    },
  );

  it("ignores an event from a different provider instance despite a prior same-turn selection", async () => {
    const fixture = makeFixture();
    const capture = await Effect.runPromise(
      Effect.provide(makeExpertLearningEvidenceCapture, fixture.layer),
    );
    await Effect.runPromise(
      capture(runtimeEntry(turnStarted("omp", { model: "gpt-5.5" }), 1), turnId),
    );
    const mismatchedTool = { ...toolCompleted(), providerInstanceId: "omp-other" };
    await Effect.runPromise(capture(runtimeEntry(mismatchedTool, 2), turnId));

    const record = JSON.parse([...fixture.evidenceRows.values()][0]!.record) as {
      readonly modelSelection: ModelSelectionType;
      readonly items: ReadonlyArray<{ readonly id: string }>;
    };
    expect(record.modelSelection).toMatchObject({ model: "gpt-5.5", instanceId: "omp" });
    expect(record.items.some((item) => item.id === "tool-result:tool-a")).toBe(false);
  });

  it.each([
    ["ambiguous owner", { states: [enabledState("owner-a"), enabledState("owner-b")] }],
    ["malformed enabled state", { states: [{ ...enabledState(), record: "{" }] }],
    ["extraction thread", { extraction: true }],
    ["no learning repository", { includeLearningRepository: false }],
  ] as const)("skips %s without failing runtime capture", async (_label, options) => {
    const fixture = makeFixture(options);
    const capture = await Effect.runPromise(
      Effect.provide(makeExpertLearningEvidenceCapture, fixture.layer),
    );
    await Effect.runPromise(capture(runtimeEntry(toolCompleted(), 2), turnId));
    expect(fixture.evidenceRows.size).toBe(0);
  });

  it("keeps ingestion compatible when the entire learning service is absent", async () => {
    const capture = await Effect.runPromise(
      Effect.provide(makeExpertLearningEvidenceCapture, Layer.empty),
    );
    await Effect.runPromise(capture(runtimeEntry(toolCompleted(), 2), turnId));
  });

  it("fails capture construction when learning is enabled without applied-runtime identity", async () => {
    const fixture = makeFixture({ includeAppliedRuntimeRepository: false });
    const result = await Effect.runPromiseExit(
      Effect.provide(makeExpertLearningEvidenceCapture, fixture.layer),
    );
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") {
      expect(Cause.pretty(result.cause)).toContain("ExpertAppliedRuntimeRepository");
    }
  });

  it("propagates evidence storage failures so the accepted runtime row can retry", async () => {
    const fixture = makeFixture({ failEvidenceWrite: true });
    const capture = await Effect.runPromise(
      Effect.provide(makeExpertLearningEvidenceCapture, fixture.layer),
    );
    const result = await Effect.runPromiseExit(capture(runtimeEntry(turnStarted(), 1), turnId));
    expect(result._tag).toBe("Failure");
    expect(fixture.evidenceRows.size).toBe(0);
  });

  it.each([
    ["runtime event stamp", { omitRequestInstanceId: true }, "omp"],
    ["session stamp", { omitRequestInstanceId: true, sessionInstanceId: "omp" }, undefined],
  ] as const)(
    "uses the concrete %s when request model selection omits an instance id",
    async (_label, options, eventInstanceId) => {
      const fixture = makeFixture(options);
      const capture = await Effect.runPromise(
        Effect.provide(makeExpertLearningEvidenceCapture, fixture.layer),
      );
      await Effect.runPromise(capture(runtimeEntry(turnStarted(eventInstanceId), 1), turnId));

      const record = JSON.parse([...fixture.evidenceRows.values()][0]!.record) as {
        readonly modelSelection: ModelSelectionType;
      };
      expect(record.modelSelection).toMatchObject({ provider: "omp", instanceId: "omp" });
    },
  );

  it("skips a late row when the exact turn model cannot be proven", async () => {
    const fixture = makeFixture({ omitAppliedModel: true });
    const capture = await Effect.runPromise(
      Effect.provide(makeExpertLearningEvidenceCapture, fixture.layer),
    );
    await Effect.runPromise(capture(runtimeEntry(normalCompletion(), 3), turnId));
    expect(fixture.evidenceRows.size).toBe(0);
  });
});
