import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  EventId,
  MessageId,
  RuntimeItemId,
  ThreadId,
  TurnId,
  type ExpertAppliedRuntimeRecord,
  type LearningSessionContext,
  type MemoryScope,
  type RunKnowledgeManifest,
  type ModelSelection as ModelSelectionType,
  type OrchestrationMessage,
  type OrchestrationProjectShell,
  type OrchestrationThreadShell,
  type ProviderRuntimeEvent,
} from "@synara/contracts";
import { Cause, Effect, Layer, Option } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { stableJsonStringify } from "@synara/shared/browserAutomationCatalogue";
import { createExpertStore } from "../../experts/ExpertStore.ts";
import { createRunSkillAssemblyStore } from "../../experts/RunSkillAssemblyStore.ts";
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
import { ServerConfig, type ServerConfigShape } from "../../config.ts";
import {
  SpaceMemoryService,
  type SpaceMemoryServiceShape,
} from "../../spaceMemory/SpaceMemoryService.ts";
import { learningEvidenceDeltaFromRuntimeEvent } from "../../experts/evolution/LearningEvidence.ts";
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
const nativeLifecycleGeneration = "generation-learning-a";
const nativeRoots: string[] = [];

afterEach(async () => {
  const makeWritable = async (entry: string): Promise<void> => {
    const stat = await fs.lstat(entry);
    if (stat.isSymbolicLink()) return;
    await fs.chmod(entry, stat.isDirectory() ? 0o700 : 0o600);
    if (stat.isDirectory()) {
      for (const child of await fs.readdir(entry)) await makeWritable(path.join(entry, child));
    }
  };
  for (const root of nativeRoots.splice(0)) {
    await makeWritable(root);
    await fs.rm(root, { recursive: true, force: true });
  }
});

function enabledState(ownerId = "owner-a", revision = 3) {
  return {
    ownerId,
    expertId,
    revision,
    updatedAt: enabledAt,
    record: JSON.stringify({
      ownerKind: "session",
      enabledAt,
      state: {
        expertId,
        enabled: true,
        epoch: 2,
        revision,
        updatedAt: enabledAt,
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
  readonly snapshotId?: string;
  readonly skillApplication?: ExpertAppliedRuntimeRecord["skillApplication"];
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
    expertBinding: {
      expertId,
      snapshotId: options?.snapshotId ?? snapshotId,
      displayName: "Test Expert",
      revision: 1,
    },
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
          snapshotId: options?.snapshotId ?? snapshotId,
          provider: "omp",
          ...(!options?.omitAppliedModel ? { model: "gpt-5.4" } : {}),
          lifecycleGeneration: nativeLifecycleGeneration,
          ...(options?.skillApplication ? { skillApplication: options.skillApplication } : {}),
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

function manifestHash(value: Omit<RunKnowledgeManifest, "hash">): string {
  return `sha256:${createHash("sha256").update(stableJsonStringify(value)).digest("hex")}`;
}

async function prepareNativeAssembly(input: {
  readonly rootRunId: string;
  readonly includeKnowledge?: boolean;
  readonly knowledgeEpoch?: number;
  readonly knowledgeScope?: Partial<MemoryScope>;
}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "expert-learning-assembly-"));
  nativeRoots.push(root);
  const stateDir = path.join(root, "state");
  const experts = createExpertStore(stateDir);
  await experts.save({
    id: expertId,
    name: "Learning capture fixture",
    description: "",
    useCases: "",
    persona: "A pinned learning fixture.",
    outputRequirements: "",
    skills: [],
    references: [],
    connections: [],
    skillBindings: [],
  });
  const binding = await experts.prepareSnapshot(expertId);
  const assemblies = createRunSkillAssemblyStore(stateDir);
  let record = await assemblies.prepare({
    threadId,
    rootRunId: input.rootRunId,
    baseSnapshotId: binding.snapshotId,
    createdAt: enabledAt,
  });
  const attempt = await assemblies.beginInitialization(record.rootRunId);
  await assemblies.finishInitialization(record.rootRunId, attempt);
  record = (await assemblies.read(record.rootRunId))!;

  let manifest: RunKnowledgeManifest | undefined;
  let memory: SpaceMemoryServiceShape | undefined;
  if (input.includeKnowledge) {
    const scope: MemoryScope = {
      ownerId: "owner-a",
      spaceId: "space-learning-a",
      expertId,
      projectId: "project-learning-a",
      ...input.knowledgeScope,
    };
    const body: Omit<RunKnowledgeManifest, "hash"> = {
      id: `manifest-${input.rootRunId}`,
      rootRunId: input.rootRunId,
      scope,
      snapshotId: binding.snapshotId,
      skillAssemblyId: record.assemblyId,
      learningEpoch: input.knowledgeEpoch ?? 2,
      frozenRuleSequence: 0,
      rules: [],
      renderVersion: 1,
      text: "",
      createdAt: enabledAt,
    };
    manifest = { ...body, hash: manifestHash(body) };
    const knowledge: LearningSessionContext = {
      manifestId: manifest.id,
      rootRunId: manifest.rootRunId,
      snapshotId: manifest.snapshotId,
      scope,
      knowledgeHash: manifest.hash,
      learningEpoch: input.knowledgeEpoch ?? 2,
    };
    record = await assemblies.attachKnowledge(record.rootRunId, knowledge);
    memory = {
      readManifest: (requestedScope: MemoryScope, manifestId: string) =>
        requestedScope.ownerId === scope.ownerId &&
        requestedScope.spaceId === scope.spaceId &&
        requestedScope.expertId === scope.expertId &&
        requestedScope.projectId === scope.projectId &&
        manifestId === manifest!.id
          ? Effect.succeed(manifest!)
          : Effect.fail(new Error("Run knowledge manifest identity mismatch.")),
    } as unknown as SpaceMemoryServiceShape;
  }

  return {
    stateDir,
    binding,
    record,
    manifest,
    memory,
    skillApplication: {
      mode: "catalog" as const,
      snapshotId: record.baseSnapshotId,
      packageIds: [],
      catalogHash: "a".repeat(64),
      instructionsHash: "b".repeat(64),
      skillRootRunId: record.rootRunId,
      skillAssemblyId: record.assemblyId,
      lifecycleGeneration: nativeLifecycleGeneration,
    },
  };
}

function preparedCaptureInput(
  entry: PersistedProviderRuntimeEvent,
  native: Awaited<ReturnType<typeof prepareNativeAssembly>>,
) {
  return {
    delta: learningEvidenceDeltaFromRuntimeEvent(entry),
    appliedIdentity: {
      threadId,
      snapshotId: native.binding.snapshotId,
      provider: "omp" as const,
      model: "gpt-5.4",
      lifecycleGeneration: nativeLifecycleGeneration,
      skillApplication: native.skillApplication,
    },
    source: {
      expertId,
      snapshotId: native.binding.snapshotId,
      projectId: "project-learning-a",
      spaceId: "space-learning-a",
      instanceId: "omp",
    },
  };
}

function nativeCaptureLayer(
  fixtureLayer: ReturnType<typeof makeFixture>["layer"],
  native: Awaited<ReturnType<typeof prepareNativeAssembly>>,
) {
  return Layer.mergeAll(
    fixtureLayer,
    Layer.succeed(ServerConfig, { stateDir: native.stateDir } as ServerConfigShape),
    ...(native.memory ? [Layer.succeed(SpaceMemoryService, native.memory)] : []),
  );
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

  it.each(["goal", "managed-hub"] as const)(
    "attributes a trusted accepted %s continuation with its prepared native Memory identity",
    async (continuationKind) => {
      const native = await prepareNativeAssembly({
        rootRunId: `run:${threadId}:${continuationKind}-continuation`,
        includeKnowledge: true,
        knowledgeEpoch: 2,
      });
      const fixture = makeFixture({
        snapshotId: native.binding.snapshotId,
        skillApplication: native.skillApplication,
      });
      const capture = await Effect.runPromise(
        Effect.provide(
          makeExpertLearningEvidenceCapture,
          nativeCaptureLayer(fixture.layer, native),
        ),
      );
      const entry = runtimeEntry(turnStarted(), 1);
      await Effect.runPromise(capture(entry, turnId, preparedCaptureInput(entry, native)));

      const record = JSON.parse([...fixture.evidenceRows.values()][0]!.record) as {
        readonly rootRunId?: string;
        readonly assemblyId?: string;
        readonly learningEpoch?: number;
        readonly coverage: ReadonlyArray<string>;
      };
      expect(record).toMatchObject({
        rootRunId: native.record.rootRunId,
        assemblyId: native.record.assemblyId,
        learningEpoch: 2,
      });
      expect(record.coverage).not.toContain("run-assembly-unattributed");
      expect(record.coverage).not.toContain("run-assembly-unavailable");
      expect(record.coverage).not.toContain("run-knowledge-unavailable");
    },
  );

  it("accepts direct fallback only when its applied root is the exact expected root", async () => {
    const expectedRoot = `run:${threadId}:source-user-message`;
    const native = await prepareNativeAssembly({ rootRunId: expectedRoot });
    const fixture = makeFixture({
      snapshotId: native.binding.snapshotId,
      skillApplication: native.skillApplication,
    });
    const capture = await Effect.runPromise(
      Effect.provide(makeExpertLearningEvidenceCapture, nativeCaptureLayer(fixture.layer, native)),
    );
    await Effect.runPromise(capture(runtimeEntry(turnStarted(), 1), turnId));

    const record = JSON.parse([...fixture.evidenceRows.values()][0]!.record) as {
      readonly rootRunId?: string;
      readonly assemblyId?: string;
    };
    expect(record).toMatchObject({ rootRunId: expectedRoot, assemblyId: native.record.assemblyId });
  });

  it("does not attribute an older direct fallback event to the thread's newer applied root", async () => {
    const native = await prepareNativeAssembly({
      rootRunId: `run:${threadId}:newer-applied-message`,
    });
    const fixture = makeFixture({
      snapshotId: native.binding.snapshotId,
      skillApplication: native.skillApplication,
    });
    const capture = await Effect.runPromise(
      Effect.provide(makeExpertLearningEvidenceCapture, nativeCaptureLayer(fixture.layer, native)),
    );
    await Effect.runPromise(capture(runtimeEntry(turnStarted(), 1), turnId));

    const record = JSON.parse([...fixture.evidenceRows.values()][0]!.record) as {
      readonly rootRunId?: string;
      readonly assemblyId?: string;
      readonly coverage: ReadonlyArray<string>;
    };
    expect(record).not.toHaveProperty("rootRunId");
    expect(record).not.toHaveProperty("assemblyId");
    expect(record.coverage).toContain("run-assembly-unattributed");
  });

  it("skips an old verified Memory grant after close and reopen advances the learning epoch", async () => {
    const native = await prepareNativeAssembly({
      rootRunId: `run:${threadId}:old-memory-grant`,
      includeKnowledge: true,
      knowledgeEpoch: 1,
    });
    const fixture = makeFixture({
      snapshotId: native.binding.snapshotId,
      skillApplication: native.skillApplication,
    });
    const capture = await Effect.runPromise(
      Effect.provide(makeExpertLearningEvidenceCapture, nativeCaptureLayer(fixture.layer, native)),
    );
    const entry = runtimeEntry(turnStarted(), 1);
    await Effect.runPromise(capture(entry, turnId, preparedCaptureInput(entry, native)));

    expect(fixture.evidenceRows.size).toBe(0);
  });

  it.each([
    ["owner", { ownerId: "previous-owner" }],
    ["space", { spaceId: "previous-space" }],
    ["project", { projectId: "previous-project" }],
  ] as const)(
    "skips a Run Memory grant from a different trusted %s scope",
    async (_label, scope) => {
      const native = await prepareNativeAssembly({
        rootRunId: `run:${threadId}:mismatched-${_label}-scope`,
        includeKnowledge: true,
        knowledgeScope: scope,
      });
      const fixture = makeFixture({
        snapshotId: native.binding.snapshotId,
        skillApplication: native.skillApplication,
      });
      const capture = await Effect.runPromise(
        Effect.provide(
          makeExpertLearningEvidenceCapture,
          nativeCaptureLayer(fixture.layer, native),
        ),
      );
      const entry = runtimeEntry(turnStarted(), 1);
      await Effect.runPromise(capture(entry, turnId, preparedCaptureInput(entry, native)));

      expect(fixture.evidenceRows.size).toBe(0);
    },
  );

  it("retains a verified no-Memory native Run without fabricating a Memory grant", async () => {
    const native = await prepareNativeAssembly({ rootRunId: `run:${threadId}:legacy-no-memory` });
    expect(native.record.session.knowledge).toBeUndefined();
    const fixture = makeFixture({
      snapshotId: native.binding.snapshotId,
      skillApplication: native.skillApplication,
    });
    const capture = await Effect.runPromise(
      Effect.provide(makeExpertLearningEvidenceCapture, nativeCaptureLayer(fixture.layer, native)),
    );
    const entry = runtimeEntry(turnStarted(), 1);
    await Effect.runPromise(capture(entry, turnId, preparedCaptureInput(entry, native)));

    const record = JSON.parse([...fixture.evidenceRows.values()][0]!.record) as {
      readonly rootRunId?: string;
      readonly assemblyId?: string;
      readonly learningEpoch?: number;
      readonly coverage: ReadonlyArray<string>;
    };
    expect(record).toMatchObject({
      rootRunId: native.record.rootRunId,
      assemblyId: native.record.assemblyId,
      learningEpoch: 2,
    });
    expect(record.coverage).toContain("run-knowledge-unavailable");
    expect(record).not.toHaveProperty("manifestId");
    expect(record).not.toHaveProperty("knowledgeHash");
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
