import { assert, it } from "@effect/vitest";
import {
  MessageId,
  EventId,
  RuntimeItemId,
  type ExpertAppliedRuntimeRecord,
  type ProjectReadFileInput,
  type ProjectReadFileResult,
  ProjectId,
  SpaceId,
  ThreadId,
  TurnId,
  type ExpertLearningEvidence,
  type LearningCommitInput,
  type LearningSessionContext,
  LearningSkillEditBaseline,
  type OrchestrationMessage,
  type OrchestrationProjectShell,
  type OrchestrationThread,
  type ProviderRuntimeEvent,
} from "@synara/contracts";
import { Effect, Layer, Option, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { chmodSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, vi } from "vitest";
import { ServerConfig, type ServerConfigShape } from "../../config";
import {
  ExpertLearningActions,
  type LearningActionResult,
} from "../../experts/evolution/ExpertLearningActions";
import { ExpertLearningRepository } from "../../experts/evolution/ExpertLearningRepository";
import type {
  ExpertLearningRepositoryShape,
  LearningStateRow,
} from "../../experts/evolution/ExpertLearningRepository";
import { ExpertAppliedRuntimeRepository } from "../../persistence/Services/ExpertAppliedRuntimeRecords";
import {
  ManagedAttachmentRepository,
  type ManagedAttachmentBlob,
} from "../../persistence/Services/ManagedAttachments";
import { ProjectionTurnRepository } from "../../persistence/Services/ProjectionTurns";
import {
  ProviderRuntimeEventRepository,
  type PersistedProviderRuntimeEvent,
  type ProviderRuntimeEventRepositoryShape,
} from "../../persistence/Services/ProviderRuntimeEvents";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery";
import {
  SpaceMemoryService,
  SpaceMemoryServiceLive,
  type SpaceMemoryServiceShape,
} from "../../spaceMemory/SpaceMemoryService";
import { WorkspaceFileSystem } from "../../workspace/Services/WorkspaceFileSystem";
import { ExpertLearningRepositoryLive } from "./expertLearningPersistence";
import { SpaceMemoryRepositoryLive } from "./spaceMemoryPersistence";
import { ExpertLearningActionsLive } from "./expertLearningActions";
import { createWorkbenchExpertRuntime, WorkbenchExpertRuntime } from "../runtimeLayer";

const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), "synara-learning-actions-"));
const stateDir = path.join(temporaryRoot, "state");
const workspaceRoot = path.join(temporaryRoot, "workspace");
const now = "2026-10-31T10:00:00.000Z";
const projects = new Map<string, OrchestrationProjectShell>();
const threads = new Map<string, OrchestrationThread>();
const turns = new Map<
  string,
  ReadonlyArray<{
    readonly turnId: TurnId;
    readonly pendingMessageId: MessageId | null;
  }>
>();
const applied = new Map<string, unknown>();
type RuntimeReadInput = Parameters<ProviderRuntimeEventRepositoryShape["readThreadEvents"]>[0];
const persistedRuntimeRows: PersistedProviderRuntimeEvent[] = [];
const runtimeReadInputs: RuntimeReadInput[] = [];
const claimedAttachments = new Map<string, ManagedAttachmentBlob>();
const workspaceFiles = new Map<string, string>();
const workspaceReadInputs: ProjectReadFileInput[] = [];
let acceptedRuntimeSequence = 0;
let fixtureSequence = 0;
const hostRuntime = createWorkbenchExpertRuntime({
  stateDir,
  expertAppliedRuntimeRepository: {
    getByThreadId: ({ threadId }: { readonly threadId: ThreadId }) =>
      Effect.succeed(
        (applied.has(threadId)
          ? Option.some(applied.get(threadId)! as ExpertAppliedRuntimeRecord)
          : Option.none()) as Option.Option<ExpertAppliedRuntimeRecord>,
      ),
  },
});

afterAll(async () => {
  await hostRuntime.skillLibrary.dispose();
  const makeWritable = (entry: string) => {
    const stat = lstatSync(entry);
    if (stat.isSymbolicLink()) return;
    chmodSync(entry, stat.isDirectory() ? 0o700 : 0o600);
    if (stat.isDirectory())
      for (const child of readdirSync(entry)) makeWritable(path.join(entry, child));
  };
  makeWritable(temporaryRoot);
  rmSync(temporaryRoot, { recursive: true, force: true });
});

afterEach(() => {
  persistedRuntimeRows.splice(0);
  runtimeReadInputs.splice(0);
  claimedAttachments.clear();
  workspaceFiles.clear();
  workspaceReadInputs.splice(0);
  acceptedRuntimeSequence = 0;
});

const config = {
  stateDir,
  attachmentsDir: path.join(temporaryRoot, "attachments"),
} as ServerConfigShape;

const repositoryLayer = Layer.mergeAll(
  ExpertLearningRepositoryLive,
  SpaceMemoryRepositoryLive,
).pipe(Layer.provideMerge(SqlitePersistenceMemory));

const dependencies = Layer.mergeAll(
  Layer.succeed(ServerConfig, config),
  Layer.succeed(WorkbenchExpertRuntime, hostRuntime),
  Layer.succeed(ProjectionSnapshotQuery, {
    getThreadDetailForExportById: (id: ThreadId) =>
      Effect.succeed(threads.has(id) ? Option.some(threads.get(id)!) : Option.none()),
    getProjectShellById: (id: ProjectId) =>
      Effect.succeed(projects.has(id) ? Option.some(projects.get(id)!) : Option.none()),
  } as never),
  Layer.succeed(ProjectionTurnRepository, {
    listByThreadId: ({ threadId }: { readonly threadId: ThreadId }) =>
      Effect.succeed(turns.get(threadId) ?? []),
  } as never),
  Layer.succeed(ExpertAppliedRuntimeRepository, {
    getByThreadId: ({ threadId }: { readonly threadId: ThreadId }) =>
      Effect.succeed(applied.has(threadId) ? Option.some(applied.get(threadId)!) : Option.none()),
  } as never),
  Layer.succeed(ProviderRuntimeEventRepository, {
    getConsumerCursor: () => Effect.succeed(acceptedRuntimeSequence),
    readThreadEvents: (input: RuntimeReadInput) => {
      runtimeReadInputs.push(input);
      return Effect.succeed(
        persistedRuntimeRows
          .filter((row) => row.sequence <= input.throughSequenceInclusive)
          .filter((row) => row.event.threadId === input.threadId)
          .filter((row) => input.turnId === undefined || row.event.turnId === input.turnId)
          .filter((row) => !input.eventIds || input.eventIds.includes(row.event.eventId))
          .toSorted((left, right) => right.sequence - left.sequence)
          .slice(0, input.limit),
      );
    },
  } as never),
  Layer.succeed(ManagedAttachmentRepository, {
    findClaimedById: ({ attachmentId }: { readonly attachmentId: string }) => {
      const blob = claimedAttachments.get(attachmentId);
      return Effect.succeed(blob ? Option.some(blob) : Option.none());
    },
  } as never),
  Layer.succeed(WorkspaceFileSystem, {
    readFile: (input: ProjectReadFileInput) => {
      workspaceReadInputs.push(input);
      const contents = workspaceFiles.get(input.relativePath);
      if (contents === undefined)
        return Effect.fail(new Error("No document reader is configured in this fixture."));
      const bytes = Buffer.from(contents, "utf8");
      const maxBytes = input.maxBytes ?? bytes.byteLength;
      return Effect.succeed({
        relativePath: input.relativePath,
        contents: bytes.subarray(0, maxBytes).toString("utf8"),
        truncated: bytes.byteLength > maxBytes,
        version: null,
        encoding: "utf8",
        lineEnding: "lf",
      } satisfies ProjectReadFileResult);
    },
  } as never),
  SpaceMemoryServiceLive.pipe(Layer.provideMerge(repositoryLayer)),
);

const layer = it.layer(ExpertLearningActionsLive.pipe(Layer.provideMerge(dependencies)));

type Fixture = {
  readonly ownerId: string;
  readonly expertId: string;
  readonly threadId: string;
  readonly turnId: string;
  readonly messageId: string;
  readonly skill?: { skillId: string; revision: number; packageId: string };
  readonly context: {
    readonly session: LearningSessionContext;
    readonly threadId: string;
    readonly turnId: string;
    readonly provider: "omp";
    readonly sessionKey: string;
    readonly assertActive: () => Effect.Effect<void>;
  };
};

async function makeFixture(
  memory: SpaceMemoryServiceShape,
  learning: ExpertLearningRepositoryShape,
  input?: {
    readonly text?: string;
    readonly ownerId?: string;
    readonly epoch?: number;
    readonly bindReadonlySkill?: boolean;
    readonly spaceId?: string | null;
    readonly attachments?: OrchestrationMessage["attachments"];
  },
): Promise<Fixture> {
  const n = ++fixtureSequence;
  const ownerId = input?.ownerId ?? `owner-${n}`;
  const expertId = `expert-${n}`;
  const threadId = `thread-${n}`;
  const turnId = `turn-${n}`;
  const messageId = `message-${n}`;
  const projectId = `project-${n}`;
  const spaceId = input?.spaceId === undefined ? `space-${n}` : input.spaceId;
  const epoch = input?.epoch ?? 3;
  const skill = input?.bindReadonlySkill
    ? (
        await hostRuntime.skillLibrary.execute({
          action: "create",
          name: `Permission fixture ${n}`,
          body: `---\nname: Permission fixture ${n}\ndescription: Test binding permission.\n---\n\nOriginal instructions.\n`,
          tags: [],
        })
      ).skill
    : undefined;
  const expert = await hostRuntime.experts.save({
    id: expertId,
    name: "Learning fixture",
    description: "",
    useCases: "",
    persona: "",
    outputRequirements: "",
    skills: [],
    ...(skill
      ? { skillBindings: [{ skillId: skill.skillId, enabled: true, allowEvolution: false }] }
      : {}),
    references: [],
    connections: [],
  });
  const snapshotId = (await hostRuntime.experts.prepareSnapshot(expert.id)).snapshotId;

  const userMessage: OrchestrationMessage = {
    id: MessageId.makeUnsafe(messageId),
    role: "user",
    text: input?.text ?? "Please put the decision first in every report.",
    ...(input?.attachments ? { attachments: input.attachments } : {}),
    turnId: TurnId.makeUnsafe(turnId),
    streaming: true,
    source: "native",
    createdAt: now,
    updatedAt: now,
  };
  threads.set(threadId, {
    id: ThreadId.makeUnsafe(threadId),
    projectId: ProjectId.makeUnsafe(projectId),
    expertBinding: {
      expertId,
      snapshotId,
      displayName: "Learning fixture",
      revision: 1,
    },
    archivedAt: null,
    messages: [userMessage],
  } as unknown as OrchestrationThread);
  projects.set(projectId, {
    id: ProjectId.makeUnsafe(projectId),
    title: "Learning fixture project",
    workspaceRoot,
    defaultModelSelection: null,
    scripts: [],
    additionalFolders: [],
    ...(spaceId === null ? {} : { spaceId: SpaceId.makeUnsafe(spaceId) }),
    createdAt: now,
    updatedAt: now,
  } as OrchestrationProjectShell);
  turns.set(threadId, [
    {
      turnId: TurnId.makeUnsafe(turnId),
      pendingMessageId: MessageId.makeUnsafe(messageId),
    },
  ]);

  const rootRunId = `root-${n}`;
  const skillAssemblyId = `assembly-${n}`;
  applied.set(threadId, {
    threadId: ThreadId.makeUnsafe(threadId),
    snapshotId,
    provider: "omp",
    model: "test-model",
    lifecycleGeneration: `generation-${n}`,
    skillApplication: {
      mode: "catalog",
      snapshotId,
      packageIds: [],
      catalogHash: "a".repeat(64),
      instructionsHash: "b".repeat(64),
      skillRootRunId: rootRunId,
      skillAssemblyId,
      lifecycleGeneration: `generation-${n}`,
    },
    appliedAt: now,
  });

  const scope = { ownerId, expertId, projectId, spaceId };
  const manifest = await Effect.runPromise(
    memory.prepareRunManifest({
      scope,
      rootRunId,
      snapshotId,
      skillAssemblyId,
      learningEpoch: epoch,
    }),
  );
  const state = {
    ownerKind: "session",
    enabledAt: now,
    state: {
      expertId,
      enabled: true,
      epoch,
      revision: 1,
      harnessKind: "omp",
      updatedAt: now,
    },
  };
  const row: LearningStateRow = {
    ownerId,
    expertId,
    record: JSON.stringify(state),
    revision: 1,
    updatedAt: now,
  };
  await Effect.runPromise(learning.writeState(row, 0));

  const session: LearningSessionContext = {
    manifestId: manifest.id,
    rootRunId,
    snapshotId,
    scope,
    knowledgeHash: manifest.hash,
    learningEpoch: epoch,
  };
  return {
    ownerId,
    expertId,
    threadId,
    turnId,
    messageId,
    ...(skill
      ? { skill: { skillId: skill.skillId, revision: skill.revision, packageId: skill.packageId } }
      : {}),
    context: {
      session,
      threadId,
      turnId,
      provider: "omp",
      sessionKey: `session-${n}`,
      assertActive: () => Effect.void,
    },
  };
}

async function makeEditablePrivateSkillFixture(
  memory: SpaceMemoryServiceShape,
  learning: ExpertLearningRepositoryShape,
): Promise<Fixture & { readonly expectedExpertRevision: number; readonly initialBody: string }> {
  const fixture = await makeFixture(memory, learning);
  const skillName = `Private save target ${fixture.expertId}`;
  const initialBody = `---\nname: ${skillName}\ndescription: Private save recovery fixture.\n---\n\nOriginal private instructions.\n`;
  const created = await hostRuntime.skillLibrary.execute(
    {
      action: "create",
      requestId: `private-target-${fixture.expertId}`,
      name: skillName,
      body: initialBody,
      tags: [],
    },
    { actor: fixture.ownerId, createForExpertId: fixture.expertId },
  );
  const skill = created.skill;
  if (!skill) throw new Error("Private Skill fixture was not created.");

  const previousExpert = await hostRuntime.experts.read(fixture.expertId);
  if (!previousExpert) throw new Error("Editable Skill fixture Expert is unavailable.");
  const editableExpert = await hostRuntime.experts.save({
    id: previousExpert.id,
    expectedRevision: previousExpert.revision,
    name: previousExpert.name,
    description: previousExpert.description,
    useCases: previousExpert.useCases,
    persona: previousExpert.persona,
    outputRequirements: previousExpert.outputRequirements,
    skills: [],
    skillBindings: [{ skillId: skill.skillId, enabled: true, allowEvolution: true }],
    references: previousExpert.references,
    connections: previousExpert.connections,
    ...(previousExpert.preferredProvider
      ? { preferredProvider: previousExpert.preferredProvider }
      : {}),
  });
  const snapshotId = (await hostRuntime.experts.prepareSnapshot(fixture.expertId)).snapshotId;
  threads.set(fixture.threadId, {
    ...threads.get(fixture.threadId)!,
    expertBinding: {
      expertId: fixture.expertId,
      snapshotId,
      displayName: editableExpert.name,
      revision: editableExpert.revision,
    },
  });

  const rootRunId = `${fixture.context.session.rootRunId}-private-save`;
  const skillAssemblyId = `assembly-${fixture.expertId}-private-save`;
  const scope = fixture.context.session.scope;
  const manifest = await Effect.runPromise(
    memory.prepareRunManifest({
      scope,
      rootRunId,
      snapshotId,
      skillAssemblyId,
      learningEpoch: fixture.context.session.learningEpoch!,
    }),
  );
  const native = applied.get(fixture.threadId) as ExpertAppliedRuntimeRecord;
  applied.set(fixture.threadId, {
    ...native,
    snapshotId,
    skillApplication: {
      ...native.skillApplication!,
      snapshotId,
      skillRootRunId: rootRunId,
      skillAssemblyId,
    },
  });
  return {
    ...fixture,
    skill: { skillId: skill.skillId, revision: skill.revision, packageId: skill.packageId },
    expectedExpertRevision: editableExpert.revision,
    initialBody,
    context: {
      ...fixture.context,
      session: {
        ...fixture.context.session,
        rootRunId,
        snapshotId,
        manifestId: manifest.id,
        knowledgeHash: manifest.hash,
      },
    },
  };
}

const memoryDraft = (key: string, content = "Put the decision first.") => ({
  assetKind: "memory" as const,
  kind: "rule" as const,
  key,
  content,
});

function itemEvent(input: {
  readonly eventId: string;
  readonly threadId: string;
  readonly turnId: string;
  readonly provider?: "pi" | "omp";
  readonly data: unknown;
  readonly title?: string;
  readonly detail?: string;
  readonly status?: "completed" | "failed" | "inProgress";
}): ProviderRuntimeEvent {
  const provider = input.provider ?? "pi";
  return {
    type: "item.completed",
    eventId: EventId.makeUnsafe(input.eventId),
    provider,
    providerInstanceId: provider,
    lifecycleGeneration: "learning-actions-generation",
    threadId: ThreadId.makeUnsafe(input.threadId),
    turnId: TurnId.makeUnsafe(input.turnId),
    itemId: RuntimeItemId.makeUnsafe(`logical-${input.eventId}`),
    createdAt: now,
    payload: {
      itemType: "dynamic_tool_call",
      status: input.status ?? "completed",
      ...(input.title ? { title: input.title } : {}),
      ...(input.detail ? { detail: input.detail } : {}),
      data: input.data,
    },
  } as ProviderRuntimeEvent;
}

function persistedRow(
  event: ProviderRuntimeEvent,
  sequence: number,
): PersistedProviderRuntimeEvent {
  return { event, sequence };
}

function piReadEvent(input: {
  readonly eventId: string;
  readonly threadId: string;
  readonly turnId: string;
  readonly absolutePath: string;
  readonly output: string;
  readonly detail?: string;
  readonly status?: "completed" | "failed" | "inProgress";
}): ProviderRuntimeEvent {
  return itemEvent({
    ...input,
    data: {
      toolName: "read",
      kind: "read",
      args: { path: input.absolutePath },
      result: { content: [{ type: "text", text: input.output }] },
      ...(input.status === "failed" ? { isError: true } : {}),
    },
  });
}

const commitInput = (
  fixture: Fixture,
  requestId: string,
  patch?: Partial<LearningCommitInput>,
): LearningCommitInput => ({
  requestId,
  sources: [{ kind: "message", messageId: fixture.messageId, quote: "decision first" }],
  change: memoryDraft(`report.${requestId}`),
  ...patch,
});

function memoryAfter(changeSet: LearningActionResult["changeSet"] | undefined) {
  const ref = changeSet?.after;
  if (!ref || ref.assetKind !== "memory") {
    throw new Error("The fixture change must reference Memory.");
  }
  return ref;
}

const writeState = (
  repository: ExpertLearningRepositoryShape,
  fixture: Fixture,
  patch: {
    enabled?: boolean;
    epoch?: number;
    frozenRuleSequence?: number;
    ruleOverrides?: readonly unknown[];
  },
) =>
  Effect.gen(function* () {
    const row = yield* repository.readState(fixture.ownerId, fixture.expertId);
    assert.isDefined(row);
    const previous = JSON.parse(row!.record) as Record<string, unknown> & {
      state: {
        expertId: string;
        enabled: boolean;
        epoch: number;
        revision: number;
        harnessKind: string;
        updatedAt: string;
      };
    };
    const revision = row!.revision + 1;
    const next = {
      ...previous,
      ...(patch.frozenRuleSequence !== undefined
        ? { frozenRuleSequence: patch.frozenRuleSequence }
        : {}),
      ...(patch.ruleOverrides ? { ruleOverrides: patch.ruleOverrides } : {}),
      state: {
        ...previous.state,
        ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
        ...(patch.epoch !== undefined ? { epoch: patch.epoch } : {}),
        revision,
        updatedAt: "2026-10-31T10:01:00.000Z",
      },
    };
    yield* repository.writeState(
      {
        ...row!,
        revision,
        updatedAt: next.state.updatedAt,
        record: JSON.stringify(next),
      },
      row!.revision,
    );
  });

layer("Expert learning host actions", (test) => {
  test.effect("does not create a Memory revision for an equivalent expiry timezone", () =>
    Effect.gen(function* () {
      const actions = yield* ExpertLearningActions;
      const memory = yield* SpaceMemoryService;
      const learning = yield* ExpertLearningRepository;
      const fixture = yield* Effect.promise(() => makeFixture(memory, learning));
      const expiry = Date.now() + 60 * 60 * 1000;
      const first = yield* actions.commit(
        fixture.context,
        commitInput(fixture, "expiry-utc", {
          change: { ...memoryDraft("expiry.topic"), validUntil: new Date(expiry).toISOString() },
        }),
      );
      const ref = memoryAfter(first.changeSet);
      const next = yield* actions.commit(
        fixture.context,
        commitInput(fixture, "expiry-offset", {
          change: {
            ...memoryDraft("expiry.topic"),
            memoryId: ref.memoryId,
            expectedRevision: ref.revision,
            validUntil: new Date(expiry + 8 * 60 * 60 * 1000).toISOString().replace("Z", "+08:00"),
          },
        }),
      );
      assert.strictEqual(next.status, "unchanged");
      assert.strictEqual(
        (yield* memory.readApplicable({ scope: fixture.context.session.scope }))[0]?.revision,
        ref.revision,
      );
      assert.lengthOf(yield* actions.listChanges(fixture.ownerId, fixture.expertId), 1);
    }),
  );
  test.effect("commits current user feedback while its accepted turn is still running", () =>
    Effect.gen(function* () {
      const actions = yield* ExpertLearningActions;
      const memory = yield* SpaceMemoryService;
      const learning = yield* ExpertLearningRepository;
      const fixture = yield* Effect.promise(() => makeFixture(memory, learning));
      const result = yield* actions.commit(
        fixture.context,
        commitInput(fixture, "active-feedback"),
      );

      assert.strictEqual(result.status, "committed");
      assert.isDefined(result.changeSet);
      assert.strictEqual(result.changeSet?.ownerId, fixture.ownerId);
      const source = result.changeSet?.sourceRefs[0];
      assert.isDefined(source);
      assert.strictEqual(source?.kind, "message");
      if (source?.kind === "message") {
        assert.strictEqual(source.messageId, fixture.messageId);
        assert.strictEqual(source.threadId, fixture.threadId);
      }
      assert.strictEqual(
        (yield* memory.readApplicable({
          scope: fixture.context.session.scope,
          kinds: ["rule"],
        })).length,
        1,
      );
    }),
  );

  test.effect(
    "rejects model-supplied owner or epoch and an authorization from a closed, reopened epoch",
    () =>
      Effect.gen(function* () {
        const actions = yield* ExpertLearningActions;
        const learning = yield* ExpertLearningRepository;
        const memory = yield* SpaceMemoryService;
        const fixture = yield* Effect.promise(() => makeFixture(memory, learning));
        const injected = {
          ...commitInput(fixture, "injected-identity"),
          ownerId: "attacker-owner",
          epoch: 900,
        } as unknown as LearningCommitInput;
        const schemaFailure = yield* Effect.flip(actions.commit(fixture.context, injected));
        assert.match(String(schemaFailure), /ownerId|epoch|excess|additional/u);

        yield* writeState(learning, fixture, { enabled: false, epoch: 4 });
        yield* writeState(learning, fixture, { enabled: true, epoch: 5 });
        const stale = yield* Effect.flip(
          actions.commit(fixture.context, commitInput(fixture, "stale-epoch")),
        );
        assert.match(String(stale), /授权代次/u);
        assert.deepStrictEqual(yield* actions.listChanges(fixture.ownerId, fixture.expertId), []);
      }),
  );

  test.effect("defers unavailable or foreign-turn sources without writing a change", () =>
    Effect.gen(function* () {
      const actions = yield* ExpertLearningActions;
      const memory = yield* SpaceMemoryService;
      const learning = yield* ExpertLearningRepository;
      const fixture = yield* Effect.promise(() => makeFixture(memory, learning));
      const result = yield* actions.commit(
        fixture.context,
        commitInput(fixture, "unavailable-source", {
          sources: [{ kind: "message", messageId: "old-or-foreign-message" }],
        }),
      );
      assert.strictEqual(result.status, "deferred");
      assert.isDefined(
        result.coverage?.find((label) => label.includes("message-source-not-in-current-turn")),
      );
      assert.deepStrictEqual(yield* actions.listChanges(fixture.ownerId, fixture.expertId), []);
      assert.deepStrictEqual(
        yield* memory.readApplicable({
          scope: fixture.context.session.scope,
        }),
        [],
      );
    }),
  );

  test.effect("requires an exact source fragment before committing Memory", () =>
    Effect.gen(function* () {
      const actions = yield* ExpertLearningActions;
      const memory = yield* SpaceMemoryService;
      const learning = yield* ExpertLearningRepository;
      const fixture = yield* Effect.promise(() => makeFixture(memory, learning));

      const deferred = yield* actions.commit(
        fixture.context,
        commitInput(fixture, "memory-without-fragment", {
          sources: [{ kind: "message", messageId: fixture.messageId }],
          change: memoryDraft("report.needs-fragment", "Must wait for exact evidence."),
        }),
      );
      assert.strictEqual(deferred.status, "deferred");
      assert.deepStrictEqual(deferred.coverage, ["source-fragment-required"]);
      assert.deepStrictEqual(yield* actions.listChanges(fixture.ownerId, fixture.expertId), []);
      assert.deepStrictEqual(
        yield* memory.readApplicable({ scope: fixture.context.session.scope }),
        [],
      );

      const committed = yield* actions.commit(
        fixture.context,
        commitInput(fixture, "memory-with-exact-fragment", {
          change: memoryDraft("report.exact-fragment", "Backed by the cited feedback."),
        }),
      );
      assert.strictEqual(committed.status, "committed");
      const source = committed.changeSet?.sourceRefs[0];
      assert.isDefined(source);
      assert.strictEqual(source?.kind, "message");
      assert.strictEqual(source?.quote, "decision first");
      assert.match(source?.fragmentHash ?? "", /^sha256:[a-f0-9]{64}$/u);
    }),
  );

  test.effect("requires an exact source fragment before committing a Skill", () =>
    Effect.gen(function* () {
      const actions = yield* ExpertLearningActions;
      const memory = yield* SpaceMemoryService;
      const learning = yield* ExpertLearningRepository;
      const fixture = yield* Effect.promise(() =>
        makeEditablePrivateSkillFixture(memory, learning),
      );
      const skill = fixture.skill!;
      const skillName = `Private save target ${fixture.expertId}`;
      const updatedBody = fixture.initialBody.replace(
        "Original private instructions.",
        "Exact-source private instructions.",
      );
      const draft = {
        assetKind: "skill" as const,
        targetSkillId: skill.skillId,
        expectedSkillRevision: skill.revision,
        basePackageId: skill.packageId,
        expectedExpertRevision: fixture.expectedExpertRevision,
        name: skillName,
        changes: [
          { path: "SKILL.md", content: Buffer.from(updatedBody, "utf8").toString("base64") },
        ],
      };

      const deferred = yield* actions.commit(
        fixture.context,
        commitInput(fixture, "skill-without-fragment", {
          sources: [{ kind: "message", messageId: fixture.messageId }],
          change: draft,
        }),
      );
      assert.strictEqual(deferred.status, "deferred");
      assert.deepStrictEqual(deferred.coverage, ["source-fragment-required"]);
      assert.deepStrictEqual(yield* actions.listChanges(fixture.ownerId, fixture.expertId), []);
      const unchanged = yield* Effect.promise(() =>
        hostRuntime.skillLibrary.execute({ action: "read", skillId: skill.skillId }),
      );
      assert.strictEqual(unchanged.skill?.revision, skill.revision);

      const committed = yield* actions.commit(
        fixture.context,
        commitInput(fixture, "skill-with-exact-fragment", { change: draft }),
      );
      assert.strictEqual(committed.status, "committed");
      const source = committed.changeSet?.sourceRefs[0];
      assert.isDefined(source);
      assert.strictEqual(source?.kind, "message");
      assert.strictEqual(source?.quote, "decision first");
      assert.match(source?.fragmentHash ?? "", /^sha256:[a-f0-9]{64}$/u);
    }),
  );

  test.effect(
    "bridges accepted Pi reads through the host index, cursor, workspace, and commit",
    () =>
      Effect.gen(function* () {
        const actions = yield* ExpertLearningActions;
        const memory = yield* SpaceMemoryService;
        const learning = yield* ExpertLearningRepository;
        const fixture = yield* Effect.promise(() => makeFixture(memory, learning));
        const eventId = "journal-read-guide";
        const itemId = `logical-${eventId}`;
        const event = piReadEvent({
          eventId,
          threadId: fixture.threadId,
          turnId: fixture.turnId,
          absolutePath: path.join(workspaceRoot, "docs", "guide.md"),
          output: "Guide contains exact evidence.",
          detail: "Runtime read includes the unique phrase host runtime evidence.",
        });
        persistedRuntimeRows.push(persistedRow(event, 41));
        persistedRuntimeRows.push(
          persistedRow(
            piReadEvent({
              eventId: "journal-read-after-cursor",
              threadId: fixture.threadId,
              turnId: fixture.turnId,
              absolutePath: path.join(workspaceRoot, "docs", "unaccepted.md"),
              output: "Must not be indexed.",
            }),
            42,
          ),
          persistedRow(
            piReadEvent({
              eventId: "journal-read-older-turn",
              threadId: fixture.threadId,
              turnId: "older-turn",
              absolutePath: path.join(workspaceRoot, "docs", "older.md"),
              output: "Must not be indexed.",
            }),
            40,
          ),
          persistedRow(
            piReadEvent({
              eventId: "journal-read-other-thread",
              threadId: "other-thread",
              turnId: fixture.turnId,
              absolutePath: path.join(workspaceRoot, "docs", "other.md"),
              output: "Must not be indexed.",
            }),
            39,
          ),
        );
        acceptedRuntimeSequence = 41;
        workspaceFiles.set("docs/guide.md", "Guide contains exact evidence.");

        const readResult = (yield* actions.read(fixture.context, { mode: "runtime" })) as {
          readonly availableSources: ReadonlyArray<Record<string, unknown>>;
          readonly runtimeSourceIndex: ReadonlyArray<Record<string, unknown>>;
        };
        assert.includeDeepMembers(
          [...readResult.availableSources],
          [
            { kind: "runtime", eventId },
            { kind: "document", relativePath: "docs/guide.md", rootIndex: 0 },
          ],
        );
        assert.notInclude(
          readResult.availableSources.map((source) => source.eventId),
          `tool-result:${itemId}`,
        );
        assert.includeDeepMembers(
          [...readResult.runtimeSourceIndex],
          [{ eventId, eventType: "item.completed", toolCallId: itemId }],
        );
        assert.notInclude(
          readResult.runtimeSourceIndex.map((source) => source.eventId),
          "journal-read-after-cursor",
        );
        assert.notInclude(
          readResult.runtimeSourceIndex.map((source) => source.eventId),
          "journal-read-older-turn",
        );
        const availabilityRead = runtimeReadInputs.at(-1);
        assert.isDefined(availabilityRead);
        assert.strictEqual(availabilityRead?.threadId, fixture.threadId);
        assert.strictEqual(availabilityRead?.turnId, fixture.turnId);
        assert.strictEqual(availabilityRead?.throughSequenceInclusive, 41);
        assert.isAtMost(availabilityRead?.maxBytes ?? Infinity, 2 * 1024 * 1024);
        assert.isUndefined(availabilityRead?.eventIds);

        const documentCommit = yield* actions.commit(
          fixture.context,
          commitInput(fixture, "host-pi-document", {
            sources: [
              {
                kind: "document",
                relativePath: "docs/guide.md",
                quote: "Guide contains exact evidence.",
              },
            ],
            change: memoryDraft("host.source.document", "Learned from the unmentioned guide."),
          }),
        );
        assert.strictEqual(documentCommit.status, "committed");
        assert.isDefined(documentCommit.changeSet);
        const documentRef = documentCommit.changeSet?.sourceRefs[0];
        assert.isDefined(documentRef);
        assert.strictEqual(documentRef?.kind, "document");
        if (documentRef?.kind === "document") {
          assert.strictEqual(
            documentRef.documentId,
            `${fixture.context.session.scope.projectId}:0:docs/guide.md`,
          );
          assert.strictEqual(documentRef.quote, "Guide contains exact evidence.");
          assert.match(documentRef.contentHash, /^sha256:[a-f0-9]{64}$/u);
        }
        assert.includeDeepMembers(workspaceReadInputs, [
          {
            cwd: workspaceRoot,
            relativePath: "docs/guide.md",
            maxBytes: 1_000_000,
          },
        ]);

        const runtimeCommit = yield* actions.commit(
          fixture.context,
          commitInput(fixture, "host-pi-runtime-event", {
            sources: [{ kind: "runtime", eventId, quote: "host runtime evidence" }],
            change: memoryDraft("host.source.runtime", "Learned from the exact journal event."),
          }),
        );
        assert.strictEqual(runtimeCommit.status, "committed");
        const runtimeRef = runtimeCommit.changeSet?.sourceRefs[0];
        assert.isDefined(runtimeRef);
        assert.strictEqual(runtimeRef?.kind, "runtime");
        if (runtimeRef?.kind === "runtime") assert.strictEqual(runtimeRef.eventId, eventId);
        assert.deepStrictEqual(runtimeReadInputs.at(-1)?.eventIds, [eventId]);
        assert.strictEqual(runtimeReadInputs.at(-1)?.throughSequenceInclusive, 41);
        assert.isAtMost(runtimeReadInputs.at(-1)?.maxBytes ?? Infinity, 2 * 1024 * 1024);
      }),
  );

  test.effect(
    "uses actual OMP output for a claimed binary excerpt and defers spoofed read proofs",
    () =>
      Effect.gen(function* () {
        const actions = yield* ExpertLearningActions;
        const memory = yield* SpaceMemoryService;
        const learning = yield* ExpertLearningRepository;
        const attachmentId = "managed-guide-pdf";
        const attachmentPath = path.join(config.attachmentsDir, "objects", "a1", "guide.pdf");
        const fixture = yield* Effect.promise(() =>
          makeFixture(memory, learning, {
            attachments: [
              {
                type: "file",
                id: attachmentId,
                name: "guide.pdf",
                mimeType: "application/pdf",
                sizeBytes: 512,
              },
            ] as OrchestrationMessage["attachments"],
          }),
        );
        claimedAttachments.set(attachmentId, {
          attachmentId,
          ownerThreadId: fixture.threadId,
          ownerKind: "session",
          ownerId: fixture.ownerId,
          kind: "file",
          originalName: "guide.pdf",
          mimeType: "application/pdf",
          reservedBytes: 512,
          sizeBytes: 512,
          sha256: "a".repeat(64),
          relativePath: "objects/a1/guide.pdf",
          state: "claimed",
          stagingExpiresAt: null,
          claimCommandId: "claim-guide-pdf",
          claimMessageId: fixture.messageId,
          claimedAt: now,
          deleteReason: null,
          deleteRequestedAt: null,
          deletedAt: null,
          createdAt: now,
          updatedAt: now,
        });
        const eventId = "journal-omp-pdf-read";
        const binaryRead = itemEvent({
          eventId,
          threadId: fixture.threadId,
          turnId: fixture.turnId,
          provider: "omp",
          data: {
            kind: "read",
            rawInput: { path: attachmentPath },
            rawOutput: { content: "Extracted from actual OMP read: exact PDF excerpt." },
          },
          detail: "Displayed title and detail cannot provide the excerpt.",
        });
        persistedRuntimeRows.push(persistedRow(binaryRead, 55));
        acceptedRuntimeSequence = 55;

        const result = yield* actions.commit(
          fixture.context,
          commitInput(fixture, "host-omp-pdf-read", {
            sources: [
              {
                kind: "attachment",
                attachmentId,
                messageId: fixture.messageId,
                quote: "exact PDF excerpt",
              },
            ],
            change: memoryDraft("host.source.pdf", "Learned from the actual PDF excerpt."),
          }),
        );
        assert.strictEqual(result.status, "committed");
        const source = result.changeSet?.sourceRefs[0];
        assert.isDefined(source);
        assert.strictEqual(source?.kind, "attachment");
        if (source?.kind === "attachment") {
          assert.strictEqual(source.attachmentId, attachmentId);
          assert.strictEqual(source.messageId, fixture.messageId);
          assert.strictEqual(source.quote, "exact PDF excerpt");
        }
        assert.strictEqual(workspaceReadInputs.length, 0);
        assert.strictEqual(runtimeReadInputs.at(-1)?.throughSequenceInclusive, 55);
        assert.isAtMost(runtimeReadInputs.at(-1)?.maxBytes ?? Infinity, 2 * 1024 * 1024);

        const missingDocument = "docs/missing.md";
        workspaceFiles.set(missingDocument, "A title or failed read must not authorize this file.");
        persistedRuntimeRows.splice(0);
        acceptedRuntimeSequence = 70;
        persistedRuntimeRows.push(
          persistedRow(
            itemEvent({
              eventId: "fake-title-read",
              threadId: fixture.threadId,
              turnId: fixture.turnId,
              provider: "omp",
              data: {
                kind: "other",
                rawInput: { command: `cat ${path.join(workspaceRoot, missingDocument)}` },
              },
              title: `Read ${path.join(workspaceRoot, missingDocument)}`,
              detail: "A display title claims the file was read.",
            }),
            70,
          ),
          persistedRow(
            piReadEvent({
              eventId: "failed-read-proof",
              threadId: fixture.threadId,
              turnId: fixture.turnId,
              absolutePath: path.join(workspaceRoot, missingDocument),
              output: "Failed output must not count.",
              status: "failed",
            }),
            69,
          ),
          persistedRow(
            piReadEvent({
              eventId: "outside-project-read",
              threadId: fixture.threadId,
              turnId: fixture.turnId,
              absolutePath: path.join(temporaryRoot, "outside", missingDocument),
              output: "A successful read outside the trusted root is not project evidence.",
            }),
            68,
          ),
          persistedRow(
            piReadEvent({
              eventId: "foreign-turn-read",
              threadId: fixture.threadId,
              turnId: "foreign-turn",
              absolutePath: path.join(workspaceRoot, missingDocument),
              output: "A different turn's read is not current proof.",
            }),
            67,
          ),
          persistedRow(
            piReadEvent({
              eventId: "unaccepted-current-read",
              threadId: fixture.threadId,
              turnId: fixture.turnId,
              absolutePath: path.join(workspaceRoot, missingDocument),
              output: "This row is past the accepted cursor.",
            }),
            71,
          ),
        );
        const workspaceReadsBeforeDeferred = workspaceReadInputs.length;
        const deferred = yield* actions.commit(
          fixture.context,
          commitInput(fixture, "host-spoofed-read-proof", {
            sources: [{ kind: "document", relativePath: missingDocument }],
            change: memoryDraft("host.source.spoofed", "Must remain deferred."),
          }),
        );
        assert.strictEqual(deferred.status, "deferred");
        assert.include(deferred.coverage ?? [], "document-not-named-or-read-in-current-turn");
        assert.strictEqual(workspaceReadInputs.length, workspaceReadsBeforeDeferred);
        assert.strictEqual(runtimeReadInputs.at(-1)?.throughSequenceInclusive, 70);
        const changes = yield* actions.listChanges(fixture.ownerId, fixture.expertId);
        assert.strictEqual(changes.length, 1);
        assert.strictEqual(changes[0]?.changeId, result.changeSet?.changeId);
        assert.strictEqual(changes[0]?.status, "committed");
      }),
  );

  test.effect(
    "recovers a private Skill save after its durable mutation response is lost and reverses the committed receipt",
    () =>
      Effect.gen(function* () {
        const actions = yield* ExpertLearningActions;
        const memory = yield* SpaceMemoryService;
        const learning = yield* ExpertLearningRepository;
        const fixture = yield* Effect.promise(() =>
          makeEditablePrivateSkillFixture(memory, learning),
        );
        const skill = fixture.skill!;
        const skillName = `Private save target ${fixture.expertId}`;
        const updatedBody = fixture.initialBody.replace(
          "Original private instructions.",
          "Updated private instructions.",
        );
        const input = commitInput(fixture, "host-private-save-lost-response", {
          change: {
            assetKind: "skill",
            targetSkillId: skill.skillId,
            expectedSkillRevision: skill.revision,
            basePackageId: skill.packageId,
            expectedExpertRevision: fixture.expectedExpertRevision,
            name: skillName,
            changes: [
              { path: "SKILL.md", content: Buffer.from(updatedBody, "utf8").toString("base64") },
            ],
          },
        });
        const originalExecute = hostRuntime.skillLibrary.execute.bind(hostRuntime.skillLibrary);
        const executeSpy = vi.spyOn(hostRuntime.skillLibrary, "execute");
        let lostSaveResponse = false;
        executeSpy.mockImplementation((async (request, executionContext) => {
          const response = await originalExecute(request, executionContext);
          if (!lostSaveResponse && request.action === "save" && request.skillId === skill.skillId) {
            lostSaveResponse = true;
            throw new Error("Simulated lost private Skill save response after durable write.");
          }
          return response;
        }) as typeof hostRuntime.skillLibrary.execute);

        let committed: LearningActionResult | undefined;
        try {
          const failed = yield* Effect.flip(actions.commit(fixture.context, input));
          assert.match(String(failed), /lost private Skill save response/u);
          assert.isTrue(lostSaveResponse);

          const prepared = yield* memory.readChange(
            fixture.ownerId,
            fixture.expertId,
            input.requestId,
          );
          assert.isDefined(prepared);
          assert.strictEqual(prepared?.status, "prepared");
          assert.isDefined(prepared?.operationRef);
          const intent = prepared?.operationRef as {
            readonly kind: string;
            readonly schemaVersion: number;
            readonly request: { readonly operationId: string; readonly expertId: string };
            readonly mutation: {
              readonly request: {
                readonly action: string;
                readonly skillId?: string;
                readonly expectedRevision?: number;
                readonly requestId?: string;
                readonly changes?: ReadonlyArray<{
                  readonly path: string;
                  readonly content?: string;
                }>;
              };
            };
          };
          assert.strictEqual(intent.kind, "commit");
          assert.strictEqual(intent.schemaVersion, 1);
          assert.strictEqual(intent.request.expertId, fixture.expertId);
          assert.strictEqual(intent.mutation.request.action, "save");
          assert.strictEqual(intent.mutation.request.skillId, skill.skillId);
          assert.strictEqual(intent.mutation.request.expectedRevision, skill.revision);
          assert.isString(intent.mutation.request.requestId);
          assert.strictEqual(intent.mutation.request.changes?.[0]?.path, "SKILL.md");
          assert.strictEqual(
            intent.mutation.request.changes?.[0]?.content,
            Buffer.from(updatedBody, "utf8").toString("base64"),
          );

          const afterLostResponse = yield* Effect.promise(() =>
            hostRuntime.skillLibrary.execute({ action: "read", skillId: skill.skillId }),
          );
          assert.strictEqual(afterLostResponse.skill?.revision, skill.revision + 1);

          committed = yield* actions.commit(fixture.context, input);
          assert.strictEqual(committed.status, "committed");
          const completed = yield* memory.readChange(
            fixture.ownerId,
            fixture.expertId,
            input.requestId,
          );
          assert.strictEqual(completed?.status, "committed");
          assert.strictEqual(completed?.changeId, prepared?.changeId);
          const liveExpert = yield* Effect.promise(() =>
            hostRuntime.experts.read(fixture.expertId),
          );
          assert.deepStrictEqual(liveExpert?.skillBindings, [
            { skillId: skill.skillId, enabled: true, allowEvolution: true },
          ]);
          const liveSkill = yield* Effect.promise(() =>
            hostRuntime.skillLibrary.execute({ action: "read", skillId: skill.skillId }),
          );
          assert.strictEqual(liveSkill.skill?.revision, skill.revision + 1);
        } finally {
          executeSpy.mockRestore();
        }

        assert.isDefined(committed?.changeSet);
        const undo = yield* actions.revertOwner(fixture.ownerId, fixture.expertId, {
          requestId: "host-private-save-owner-undo",
          changeId: committed!.changeSet!.changeId,
        });
        assert.strictEqual(undo.status, "committed");
        assert.strictEqual(
          (yield* memory.getChange(fixture.ownerId, committed!.changeSet!.changeId))?.status,
          "reverted",
        );
        const restoredSkill = yield* Effect.promise(() =>
          hostRuntime.skillLibrary.execute({ action: "read", skillId: skill.skillId }),
        );
        assert.isDefined(restoredSkill.skill);
        const restoredBody = readFileSync(
          path.join(
            stateDir,
            "experts",
            "skill-packages",
            restoredSkill.skill!.packageId,
            "content",
            "SKILL.md",
          ),
          "utf8",
        );
        assert.include(restoredBody, "Original private instructions.");
      }),
  );

  test.effect(
    "recovers a created Skill undo after its binding removal succeeded but the SQL receipt was not completed",
    () =>
      Effect.gen(function* () {
        const actions = yield* ExpertLearningActions;
        const memory = yield* SpaceMemoryService;
        const learning = yield* ExpertLearningRepository;
        const fixture = yield* Effect.promise(() => makeFixture(memory, learning));
        const name = `Created undo recovery ${fixture.expertId}`;
        const body = `---\nname: ${name}\ndescription: Created undo host recovery fixture.\n---\n\nCreated instructions.\n`;
        const created = yield* actions.commit(
          fixture.context,
          commitInput(fixture, "host-created-skill-undo", {
            change: {
              assetKind: "skill",
              expectedExpertRevision: 1,
              name,
              changes: [
                { path: "SKILL.md", content: Buffer.from(body, "utf8").toString("base64") },
              ],
            },
          }),
        );
        assert.strictEqual(created.status, "committed");
        const original = created.changeSet;
        assert.isDefined(original);
        const skillRef = original?.after;
        assert.isDefined(skillRef);
        if (!skillRef || skillRef.assetKind !== "skill")
          throw new Error("Created Skill commit did not retain its Skill identity.");

        const originalExecute = hostRuntime.skillLibrary.execute.bind(hostRuntime.skillLibrary);
        const executeSpy = vi.spyOn(hostRuntime.skillLibrary, "execute");
        let lostUnbindResponse = false;
        executeSpy.mockImplementation((async (request, executionContext) => {
          const response = await originalExecute(request, executionContext);
          if (
            !lostUnbindResponse &&
            request.action === "bindings" &&
            request.operation === "set" &&
            request.requestId?.startsWith("learning-skill:revert-bind:")
          ) {
            lostUnbindResponse = true;
            throw new Error("Simulated lost created Skill unbind response after durable write.");
          }
          return response;
        }) as typeof hostRuntime.skillLibrary.execute);
        const revertInput = {
          requestId: "host-created-skill-undo-retry",
          changeId: original!.changeId,
        };

        try {
          const failed = yield* Effect.flip(
            actions.revertOwner(fixture.ownerId, fixture.expertId, revertInput),
          );
          assert.match(String(failed), /lost created Skill unbind response/u);
          assert.isTrue(lostUnbindResponse);
          const prepared = yield* memory.readChange(
            fixture.ownerId,
            fixture.expertId,
            revertInput.requestId,
          );
          assert.isDefined(prepared);
          assert.strictEqual(prepared?.status, "prepared");
          assert.isDefined(prepared?.operationRef);
          const intent = prepared?.operationRef as {
            readonly kind: string;
            readonly recordOperationId: string;
            readonly mutations: ReadonlyArray<{
              readonly request: {
                readonly action: string;
                readonly operation?: string;
                readonly bindings?: ReadonlyArray<{ readonly skillId: string }>;
              };
            }>;
          };
          assert.strictEqual(intent.kind, "revert");
          assert.strictEqual(intent.recordOperationId, original!.changeId);
          assert.strictEqual(intent.mutations[0]?.request.action, "bindings");
          assert.strictEqual(intent.mutations[0]?.request.operation, "set");
          assert.notInclude(
            (intent.mutations[0]?.request.bindings ?? []).map((binding) => binding.skillId),
            skillRef.skillId,
          );
          const afterLostResponse = yield* Effect.promise(() =>
            hostRuntime.experts.read(fixture.expertId),
          );
          assert.notInclude(
            afterLostResponse?.skillBindings?.map((binding) => binding.skillId) ?? [],
            skillRef.skillId,
          );

          const retry = yield* actions.revertOwner(fixture.ownerId, fixture.expertId, revertInput);
          assert.strictEqual(retry.status, "committed");
          assert.strictEqual(retry.changeSet?.status, "committed");
          assert.strictEqual(
            (yield* memory.readChange(fixture.ownerId, fixture.expertId, revertInput.requestId))
              ?.changeId,
            prepared?.changeId,
          );
          assert.strictEqual(
            (yield* memory.getChange(fixture.ownerId, original!.changeId))?.status,
            "reverted",
          );
          const finalExpert = yield* Effect.promise(() =>
            hostRuntime.experts.read(fixture.expertId),
          );
          assert.notInclude(
            finalExpert?.skillBindings?.map((binding) => binding.skillId) ?? [],
            skillRef.skillId,
          );
          const unboundSkill = yield* Effect.promise(() =>
            hostRuntime.skillLibrary.execute({ action: "read", skillId: skillRef.skillId }),
          );
          assert.strictEqual(unboundSkill.skill?.skillId, skillRef.skillId);
        } finally {
          executeSpy.mockRestore();
        }
      }),
  );

  test.effect(
    "reverts a closed owner's exact rule override and keeps unrelated frozen overrides",
    () =>
      Effect.gen(function* () {
        const actions = yield* ExpertLearningActions;
        const learning = yield* ExpertLearningRepository;
        const memory = yield* SpaceMemoryService;
        const fixture = yield* Effect.promise(() => makeFixture(memory, learning));
        const first = yield* actions.commit(
          fixture.context,
          commitInput(fixture, "revert-exact-rule"),
        );
        const unrelated = yield* actions.commit(
          fixture.context,
          commitInput(fixture, "keep-other-rule", {
            change: memoryDraft("report.other", "Keep the warning at the end."),
          }),
        );
        const firstRef = first.changeSet?.after;
        const otherRef = unrelated.changeSet?.after;
        assert.isDefined(firstRef);
        assert.isDefined(otherRef);
        if (
          !firstRef ||
          firstRef.assetKind !== "memory" ||
          !otherRef ||
          otherRef.assetKind !== "memory"
        ) {
          throw new Error("The fixture commits must produce Memory references.");
        }
        const unrelatedRef = otherRef;
        yield* writeState(learning, fixture, {
          enabled: false,
          epoch: 4,
          ruleOverrides: [
            {
              memoryId: unrelatedRef.memoryId,
              revision: unrelatedRef.revision,
              contentHash: unrelatedRef.contentHash,
            },
          ],
        });

        const reverted = yield* actions.revertOwner(fixture.ownerId, fixture.expertId, {
          requestId: "closed-owner-revert",
          changeId: first.changeSet!.changeId,
        });
        assert.strictEqual(reverted.status, "committed");
        assert.strictEqual(reverted.changeSet?.revertsChangeId, first.changeSet!.changeId);
        assert.isUndefined(reverted.changeSet?.data);
        assert.isUndefined(reverted.changeSet?.operationRef);
        const finalRow = yield* learning.readState(fixture.ownerId, fixture.expertId);
        const finalState = JSON.parse(finalRow!.record) as {
          ruleOverrides: ReadonlyArray<{
            memoryId: string;
            revision: number;
            contentHash: string;
          }>;
        };
        const revertedRef = reverted.changeSet?.after;
        assert.isDefined(revertedRef);
        if (!revertedRef || revertedRef.assetKind !== "memory")
          throw new Error("The revert must reference the restored Memory revision.");
        assert.deepStrictEqual(
          finalState.ruleOverrides,
          [unrelatedRef, revertedRef].map(({ memoryId, revision, contentHash }) => ({
            memoryId,
            revision,
            contentHash,
          })),
        );
      }),
  );

  test.effect("deduplicates automatic learning against a withdrawn frontend source", () =>
    Effect.gen(function* () {
      const actions = yield* ExpertLearningActions;
      const learning = yield* ExpertLearningRepository;
      const memory = yield* SpaceMemoryService;
      const fixture = yield* Effect.promise(() => makeFixture(memory, learning));
      const draft = memoryDraft("report.withdrawn", "Put the decision first.");
      const committed = yield* actions.commit(
        fixture.context,
        commitInput(fixture, "frontend-withdrawn", { change: draft }),
      );
      assert.isDefined(committed.changeSet);
      const reverted = yield* actions.revertOwner(fixture.ownerId, fixture.expertId, {
        requestId: "withdraw-frontend-learning",
        changeId: committed.changeSet!.changeId,
      });
      assert.strictEqual(reverted.status, "committed");
      const afterRevert = yield* actions.listChanges(fixture.ownerId, fixture.expertId);
      assert.strictEqual(
        afterRevert.find((change) => change.changeId === committed.changeSet?.changeId)?.status,
        "reverted",
      );

      const evidence: ExpertLearningEvidence = {
        evidenceId: `evidence-${fixture.turnId}`,
        learningEpoch: fixture.context.session.learningEpoch,
        ownerId: fixture.ownerId,
        expertId: fixture.expertId,
        threadId: fixture.threadId,
        turnId: fixture.turnId,
        rootRunId: fixture.context.session.rootRunId,
        snapshotId: fixture.context.session.snapshotId,
        projectId: fixture.context.session.scope.projectId,
        ...(fixture.context.session.scope.spaceId
          ? { spaceId: fixture.context.session.scope.spaceId }
          : {}),
        modelSelection: {
          provider: "omp",
          instanceId: "omp",
          model: "test-model",
        },
        items: [
          {
            id: fixture.messageId,
            kind: "message",
            text: "Please put the decision first in every report.",
            role: "user",
          },
        ],
        coverage: ["user_feedback"],
        completedAt: now,
        updatedAt: now,
      };
      yield* learning.writeEvidence({
        evidenceId: evidence.evidenceId,
        ownerId: fixture.ownerId,
        expertId: fixture.expertId,
        threadId: fixture.threadId,
        turnId: fixture.turnId,
        record: JSON.stringify(evidence),
        updatedAt: evidence.updatedAt,
      });
      const automatic = yield* actions.commitAutomaticMemory({
        ownerId: fixture.ownerId,
        expertId: fixture.expertId,
        epoch: fixture.context.session.learningEpoch!,
        requestId: "automatic-same-source",
        evidence,
        draft,
        citations: [
          {
            threadId: fixture.threadId as never,
            messageId: fixture.messageId as never,
            quote: "decision first",
          },
        ],
      });
      assert.strictEqual(automatic.status, "unchanged");
      assert.strictEqual(automatic.changeSet?.changeId, committed.changeSet?.changeId);
      assert.strictEqual(automatic.changeSet?.status, "reverted");
      assert.strictEqual((yield* actions.listChanges(fixture.ownerId, fixture.expertId)).length, 2);
    }),
  );

  test.effect(
    "keeps the closed rule watermark and unrelated frozen overrides after owner edit",
    () =>
      Effect.gen(function* () {
        const actions = yield* ExpertLearningActions;
        const learning = yield* ExpertLearningRepository;
        const memory = yield* SpaceMemoryService;
        const fixture = yield* Effect.promise(() => makeFixture(memory, learning));
        const first = yield* actions.commit(
          fixture.context,
          commitInput(fixture, "owner-rule-one", {
            change: memoryDraft("report.owner-one", "Original first rule."),
          }),
        );
        const second = yield* actions.commit(
          fixture.context,
          commitInput(fixture, "owner-rule-two", {
            change: memoryDraft("report.owner-two", "Original second rule."),
          }),
        );
        const firstRef = memoryAfter(first.changeSet);
        const secondRef = memoryAfter(second.changeSet);
        const watermark = yield* memory.ruleSequence(fixture.ownerId);
        yield* writeState(learning, fixture, {
          enabled: false,
          epoch: 4,
          frozenRuleSequence: watermark,
          ruleOverrides: [
            {
              memoryId: secondRef.memoryId,
              revision: secondRef.revision,
              contentHash: secondRef.contentHash,
            },
          ],
        });

        const edited = yield* actions.editOwnerMemory(fixture.ownerId, fixture.expertId, {
          changeId: first.changeSet!.changeId,
          requestId: "owner-edit-rule-one",
          expectedRevision: firstRef.revision,
          content: "Edited first rule while learning is closed.",
        });
        assert.isUndefined(edited.changeSet?.data);
        assert.isUndefined(edited.changeSet?.operationRef);
        const editedRef = memoryAfter(edited.changeSet);
        const saved = yield* learning.readState(fixture.ownerId, fixture.expertId);
        const stored = JSON.parse(saved!.record) as {
          frozenRuleSequence: number;
          ruleOverrides: ReadonlyArray<{
            memoryId: string;
            revision: number;
            contentHash: string;
          }>;
        };
        assert.strictEqual(stored.frozenRuleSequence, watermark);
        assert.deepStrictEqual(stored.ruleOverrides, [
          {
            memoryId: secondRef.memoryId,
            revision: secondRef.revision,
            contentHash: secondRef.contentHash,
          },
          {
            memoryId: editedRef.memoryId,
            revision: editedRef.revision,
            contentHash: editedRef.contentHash,
          },
        ]);

        const frozenRules = yield* memory.readApplicable({
          scope: fixture.context.session.scope,
          kinds: ["rule"],
          ruleSequence: stored.frozenRuleSequence,
          overrides: stored.ruleOverrides,
        });
        assert.deepStrictEqual(
          frozenRules
            .map(({ key, content }) => [key, content])
            .toSorted(([left], [right]) => String(left).localeCompare(String(right))),
          [
            ["report.owner-one", "Edited first rule while learning is closed."],
            ["report.owner-two", "Original second rule."],
          ],
        );
      }),
  );

  test.effect(
    "owner edits make facts fresh for runtime reads and record the read while writes remain closed",
    () =>
      Effect.gen(function* () {
        const actions = yield* ExpertLearningActions;
        const learning = yield* ExpertLearningRepository;
        const memory = yield* SpaceMemoryService;
        const sql = yield* SqlClient.SqlClient;
        const fixture = yield* Effect.promise(() => makeFixture(memory, learning));
        const created = yield* actions.commit(
          fixture.context,
          commitInput(fixture, "owner-edit-fact", {
            change: {
              assetKind: "memory",
              kind: "fact",
              key: "workspace.current_branch",
              content: "feature/old",
            },
          }),
        );
        const factRef = memoryAfter(created.changeSet);
        const watermark = yield* memory.ruleSequence(fixture.ownerId);
        yield* writeState(learning, fixture, {
          enabled: false,
          epoch: 4,
          frozenRuleSequence: watermark,
          ruleOverrides: [],
        });

        const edited = yield* actions.editOwnerMemory(fixture.ownerId, fixture.expertId, {
          changeId: created.changeSet!.changeId,
          requestId: "owner-edit-fact-value",
          expectedRevision: factRef.revision,
          content: "feature/current",
        });
        const editedRef = memoryAfter(edited.changeSet);
        const runtimeRead = (yield* actions.read(fixture.context, {
          mode: "runtime",
          memoryId: factRef.memoryId,
        })) as { entry: { content: string; revision: number } };
        assert.deepStrictEqual(runtimeRead.entry, {
          ...runtimeRead.entry,
          content: "feature/current",
          revision: editedRef.revision,
        });
        const receipts = yield* sql.unsafe<{ readonly revision: number }>(
          "SELECT revision FROM space_memory_reads WHERE manifest_id = ? AND memory_id = ?",
          [fixture.context.session.manifestId, factRef.memoryId],
        );
        assert.includeMembers(
          receipts.map(({ revision }) => revision),
          [editedRef.revision],
        );

        const writeDenied = yield* Effect.flip(
          actions.commit(fixture.context, commitInput(fixture, "write-after-owner-fact-edit")),
        );
        assert.match(String(writeDenied), /自学习已关闭|授权代次/u);
        const freshFacts = yield* memory.readApplicable({
          scope: fixture.context.session.scope,
          kinds: ["fact"],
        });
        assert.deepStrictEqual(
          freshFacts.map(({ memoryId, content }) => [memoryId, content]),
          [[factRef.memoryId, "feature/current"]],
        );
        const state = JSON.parse(
          (yield* learning.readState(fixture.ownerId, fixture.expertId))!.record,
        ) as { frozenRuleSequence: number; ruleOverrides: ReadonlyArray<unknown> };
        assert.strictEqual(state.frozenRuleSequence, watermark);
        assert.deepStrictEqual(state.ruleOverrides, []);
      }),
  );

  test.effect(
    "does not rewind a frozen rule override when an older owner edit request is retried",
    () =>
      Effect.gen(function* () {
        const actions = yield* ExpertLearningActions;
        const learning = yield* ExpertLearningRepository;
        const memory = yield* SpaceMemoryService;
        const fixture = yield* Effect.promise(() => makeFixture(memory, learning));
        const created = yield* actions.commit(
          fixture.context,
          commitInput(fixture, "owner-edit-retry-base", {
            change: memoryDraft("report.retry", "Original frozen rule."),
          }),
        );
        const baseRef = memoryAfter(created.changeSet);
        const watermark = yield* memory.ruleSequence(fixture.ownerId);
        yield* writeState(learning, fixture, {
          enabled: false,
          epoch: 4,
          frozenRuleSequence: watermark,
          ruleOverrides: [],
        });
        const firstEdit = yield* actions.editOwnerMemory(fixture.ownerId, fixture.expertId, {
          changeId: created.changeSet!.changeId,
          requestId: "owner-edit-retry-idempotency",
          expectedRevision: baseRef.revision,
          content: "First owner edit.",
        });
        const firstEditRef = memoryAfter(firstEdit.changeSet);
        const newerEdit = yield* actions.editOwnerMemory(fixture.ownerId, fixture.expertId, {
          changeId: created.changeSet!.changeId,
          requestId: "owner-edit-newer-revision",
          expectedRevision: firstEditRef.revision,
          content: "Newer owner edit.",
        });
        const newerRef = memoryAfter(newerEdit.changeSet);

        yield* actions.editOwnerMemory(fixture.ownerId, fixture.expertId, {
          changeId: created.changeSet!.changeId,
          requestId: "owner-edit-retry-idempotency",
          expectedRevision: baseRef.revision,
          content: "First owner edit.",
        });

        const saved = yield* learning.readState(fixture.ownerId, fixture.expertId);
        const stored = JSON.parse(saved!.record) as {
          frozenRuleSequence: number;
          ruleOverrides: ReadonlyArray<{
            memoryId: string;
            revision: number;
            contentHash: string;
          }>;
        };
        assert.strictEqual(stored.frozenRuleSequence, watermark);
        assert.deepStrictEqual(stored.ruleOverrides, [
          {
            memoryId: newerRef.memoryId,
            revision: newerRef.revision,
            contentHash: newerRef.contentHash,
          },
        ]);
        const frozenRules = yield* memory.readApplicable({
          scope: fixture.context.session.scope,
          kinds: ["rule"],
          ruleSequence: stored.frozenRuleSequence,
          overrides: stored.ruleOverrides,
        });
        assert.strictEqual(frozenRules[0]?.content, "Newer owner edit.");
      }),
  );

  test.effect(
    "rejects automatic evidence that reuses a root manifest from the previous learning epoch",
    () =>
      Effect.gen(function* () {
        const actions = yield* ExpertLearningActions;
        const learning = yield* ExpertLearningRepository;
        const memory = yield* SpaceMemoryService;
        const fixture = yield* Effect.promise(() => makeFixture(memory, learning));
        yield* writeState(learning, fixture, { enabled: false, epoch: 4 });
        yield* writeState(learning, fixture, { enabled: true, epoch: 5 });
        const evidence: ExpertLearningEvidence = {
          evidenceId: `evidence-new-epoch-${fixture.turnId}`,
          learningEpoch: 5,
          ownerId: fixture.ownerId,
          expertId: fixture.expertId,
          threadId: fixture.threadId,
          turnId: fixture.turnId,
          rootRunId: fixture.context.session.rootRunId,
          snapshotId: fixture.context.session.snapshotId,
          projectId: fixture.context.session.scope.projectId,
          ...(fixture.context.session.scope.spaceId
            ? { spaceId: fixture.context.session.scope.spaceId }
            : {}),
          modelSelection: {
            provider: "omp",
            instanceId: "omp",
            model: "test-model",
          },
          items: [
            {
              id: fixture.messageId,
              kind: "message",
              text: "Please put the decision first in every report.",
              role: "user",
            },
          ],
          coverage: ["user_feedback"],
          completedAt: now,
          updatedAt: now,
        };
        yield* learning.writeEvidence({
          evidenceId: evidence.evidenceId,
          ownerId: fixture.ownerId,
          expertId: fixture.expertId,
          threadId: fixture.threadId,
          turnId: fixture.turnId,
          record: JSON.stringify(evidence),
          updatedAt: evidence.updatedAt,
        });

        const denied = yield* Effect.flip(
          actions.commitAutomaticMemory({
            ownerId: fixture.ownerId,
            expertId: fixture.expertId,
            epoch: 5,
            requestId: "automatic-old-root-manifest",
            evidence,
            draft: { kind: "fact", key: "report.old-root", content: "Must not learn." },
            citations: [
              {
                threadId: fixture.threadId as never,
                messageId: fixture.messageId as never,
                quote: "decision first",
              },
            ],
          }),
        );
        assert.match(String(denied), /原 Run 的记忆学习授权已经结束/u);
        assert.deepStrictEqual(yield* actions.listChanges(fixture.ownerId, fixture.expertId), []);
        assert.deepStrictEqual(
          yield* memory.readApplicable({ scope: fixture.context.session.scope }),
          [],
        );
      }),
  );

  test.effect("keeps the runtime Skill catalog separate from the current exact edit baseline", () =>
    Effect.gen(function* () {
      const actions = yield* ExpertLearningActions;
      const memory = yield* SpaceMemoryService;
      const learning = yield* ExpertLearningRepository;
      const fixture = yield* Effect.promise(() =>
        makeEditablePrivateSkillFixture(memory, learning),
      );
      const original = fixture.skill!;
      const current = yield* Effect.promise(() =>
        hostRuntime.skillLibrary.execute({
          action: "read",
          skillId: original.skillId,
        }),
      );
      const changedBody = `${fixture.initialBody}\nLater owner-only instructions.\n`;
      const changed = yield* Effect.promise(() =>
        hostRuntime.skillLibrary.execute({
          action: "save",
          skillId: original.skillId,
          expectedRevision: original.revision,
          requestId: `read-baseline-${fixture.expertId}`,
          name: current.skill!.name,
          tags: [],
          changes: [{ path: "SKILL.md", content: Buffer.from(changedBody).toString("base64") }],
        }),
      );
      assert.notStrictEqual(changed.skill!.packageId, original.packageId);
      for (const mode of [undefined, "runtime"] as const) {
        const denied = yield* Effect.flip(
          actions.read(fixture.context, {
            ...(mode ? { mode } : {}),
            skillId: original.skillId,
          }),
        );
        assert.match(String(denied), /固定原生技能目录/u);
      }
      const baseline = Schema.decodeUnknownSync(LearningSkillEditBaseline)(
        yield* actions.read(fixture.context, { mode: "edit", skillId: original.skillId }),
      );
      const expert = yield* Effect.promise(() => hostRuntime.experts.read(fixture.expertId));
      assert.strictEqual(baseline.usage, "edit-baseline");
      assert.strictEqual(baseline.expertRevision, expert!.revision);
      assert.strictEqual(baseline.skill.revision, changed.skill!.revision);
      assert.strictEqual(baseline.skill.packageId, changed.skill!.packageId);
      assert.strictEqual(baseline.file.path, "SKILL.md");
      assert.strictEqual(baseline.file.text, changedBody);
      assert.strictEqual(
        Buffer.from(baseline.file.content, "base64").toString("utf8"),
        changedBody,
      );
      assert.deepStrictEqual(baseline.coverage, []);
    }),
  );

  for (const budget of ["bytes", "characters"] as const) {
    test.effect(
      `rejects an oversized Skill edit baseline without pretending it is complete (${budget})`,
      () =>
        Effect.gen(function* () {
          const actions = yield* ExpertLearningActions;
          const memory = yield* SpaceMemoryService;
          const learning = yield* ExpertLearningRepository;
          const fixture = yield* Effect.promise(() =>
            makeEditablePrivateSkillFixture(memory, learning),
          );
          const skill = fixture.skill!;
          const original = yield* Effect.promise(() =>
            hostRuntime.skillLibrary.execute({ action: "read", skillId: skill.skillId }),
          );
          yield* Effect.promise(() =>
            hostRuntime.skillLibrary.execute({
              action: "save",
              skillId: skill.skillId,
              expectedRevision: skill.revision,
              requestId: `large-read-${fixture.expertId}`,
              name: original.skill!.name,
              tags: [],
              changes: [
                {
                  path: "SKILL.md",
                  content: Buffer.from(
                    fixture.initialBody + "x".repeat(budget === "bytes" ? 1_000_001 : 128_001),
                  ).toString("base64"),
                },
              ],
            }),
          );
          const execute = vi.spyOn(hostRuntime.skillLibrary, "execute");
          const denied = yield* Effect.flip(
            actions.read(fixture.context, { mode: "edit", skillId: skill.skillId }),
          );
          assert.match(String(denied), /预算.*完整编辑基线/u);
          assert.strictEqual(
            execute.mock.calls.some(([request]) => request.action === "readFile"),
            budget !== "bytes",
          );
        }),
    );
  }

  test.effect("preserves exact Skill target permission for a bound read-only skill", () =>
    Effect.gen(function* () {
      const actions = yield* ExpertLearningActions;
      const memory = yield* SpaceMemoryService;
      const learning = yield* ExpertLearningRepository;
      const fixture = yield* Effect.promise(() =>
        makeFixture(memory, learning, { bindReadonlySkill: true }),
      );
      assert.isDefined(fixture.skill);
      const skill = fixture.skill!;
      const unauthorized = yield* Effect.flip(
        actions.read(fixture.context, {
          mode: "edit",
          skillId: skill.skillId,
        }),
      );
      assert.match(String(unauthorized), /相应授权/u);

      const skillBody = `---\nname: Permission fixture\ndescription: Test binding permission.\n---\n\nChanged instructions.\n`;
      const commitFailure = yield* Effect.flip(
        actions.commit(
          fixture.context,
          commitInput(fixture, "readonly-skill-target", {
            change: {
              assetKind: "skill",
              targetSkillId: skill.skillId,
              expectedSkillRevision: skill.revision,
              basePackageId: skill.packageId,
              expectedExpertRevision: 1,
              name: "Permission fixture",
              changes: [
                {
                  path: "SKILL.md",
                  content: Buffer.from(skillBody).toString("base64"),
                },
              ],
            },
          }),
        ),
      );
      assert.match(String(commitFailure), /read-only for this Expert binding/u);
      const stillUnchanged = yield* Effect.promise(() =>
        hostRuntime.skillLibrary.execute({
          action: "read",
          skillId: skill.skillId,
        }),
      );
      assert.strictEqual(stillUnchanged.skill?.revision, skill.revision);
    }),
  );

  test.effect("reads exact historical Skill packages and redacts only verified inverse links", () =>
    Effect.gen(function* () {
      const actions = yield* ExpertLearningActions;
      const memory = yield* SpaceMemoryService;
      const learning = yield* ExpertLearningRepository;
      const fixture = yield* Effect.promise(() =>
        makeEditablePrivateSkillFixture(memory, learning),
      );
      const skill = fixture.skill!;
      const skillName = `Private save target ${fixture.expertId}`;
      const script = Buffer.from("#!/bin/sh\necho ready\n", "utf8");
      const binaryBefore = Buffer.from([0, 1, 2, 127, 255]);
      const binaryAfter = Buffer.from([0, 1, 2, 128, 254]);
      const baseline = yield* Effect.promise(() =>
        hostRuntime.skillLibrary.execute(
          {
            action: "save",
            requestId: `history-c0-${fixture.expertId}`,
            skillId: skill.skillId,
            expectedRevision: skill.revision,
            name: skillName,
            tags: [],
            changes: [
              { path: "SKILL.md", content: Buffer.from(fixture.initialBody).toString("base64") },
              {
                path: "docs/remove.txt",
                content: Buffer.from("C0 file to remove.", "utf8").toString("base64"),
              },
              { path: "scripts/check.sh", content: script.toString("base64"), executable: false },
              { path: "resources/blob.bin", content: binaryBefore.toString("base64") },
            ],
          },
          { actor: fixture.ownerId, retainForEvolution: true },
        ),
      );
      assert.isDefined(baseline.skill);
      const c1Body = fixture.initialBody.replace(
        "Original private instructions.",
        "C1 private method.",
      );
      const committed = yield* actions.commit(
        fixture.context,
        commitInput(fixture, "historical-skill-c1", {
          change: {
            assetKind: "skill",
            targetSkillId: skill.skillId,
            expectedSkillRevision: baseline.skill!.revision,
            basePackageId: baseline.skill!.packageId,
            expectedExpertRevision: fixture.expectedExpertRevision,
            name: skillName,
            changes: [
              { path: "SKILL.md", content: Buffer.from(c1Body).toString("base64") },
              { path: "docs/remove.txt" },
              {
                path: "docs/add.txt",
                content: Buffer.from("C1 added file.", "utf8").toString("base64"),
              },
              { path: "scripts/check.sh", content: script.toString("base64"), executable: true },
              { path: "resources/blob.bin", content: binaryAfter.toString("base64") },
            ],
          },
        }),
      );
      assert.strictEqual(committed.status, "committed");
      assert.isDefined(committed.changeSet);

      const c2Body = c1Body.replace("C1 private method.", "C1 private method.\nLater C2 note.");
      const c2 = yield* Effect.promise(() =>
        hostRuntime.skillLibrary.execute(
          {
            action: "save",
            requestId: `history-c2-${fixture.expertId}`,
            skillId: skill.skillId,
            expectedRevision:
              committed.changeSet?.after?.assetKind === "skill"
                ? committed.changeSet.after.revision!
                : baseline.skill!.revision + 1,
            name: skillName,
            tags: [],
            changes: [{ path: "SKILL.md", content: Buffer.from(c2Body).toString("base64") }],
          },
          { actor: fixture.ownerId, retainForEvolution: true },
        ),
      );
      assert.isDefined(c2.skill);

      const detail = yield* actions.readSkillChange(
        fixture.ownerId,
        fixture.expertId,
        committed.changeSet!.changeId,
      );
      assert.strictEqual(detail.changeId, committed.changeSet!.changeId);
      const byPath = new Map(detail.files.map((file) => [file.path, file]));
      const entry = byPath.get("SKILL.md");
      assert.isDefined(entry?.before);
      assert.isDefined(entry?.after);
      assert.include(entry!.before!.text!, "Original private instructions.");
      assert.include(entry!.after!.text!, "C1 private method.");
      assert.notInclude(entry!.after!.text!, "Later C2 note.");

      const removed = byPath.get("docs/remove.txt");
      assert.isDefined(removed?.before);
      assert.strictEqual(removed?.after, null);
      assert.strictEqual(removed?.before?.text, "C0 file to remove.");
      const added = byPath.get("docs/add.txt");
      assert.strictEqual(added?.before, null);
      assert.strictEqual(added?.after?.text, "C1 added file.");

      const modeOnly = byPath.get("scripts/check.sh");
      assert.isDefined(modeOnly?.before);
      assert.isDefined(modeOnly?.after);
      assert.strictEqual(modeOnly?.before?.sha256, modeOnly?.after?.sha256);
      assert.strictEqual(modeOnly?.before?.executable, false);
      assert.strictEqual(modeOnly?.after?.executable, true);
      assert.strictEqual(modeOnly?.before?.text, script.toString("utf8"));

      const binary = byPath.get("resources/blob.bin");
      assert.strictEqual(binary?.before?.omittedReason, "binary");
      assert.strictEqual(binary?.after?.omittedReason, "binary");
      assert.notStrictEqual(binary?.before?.sha256, binary?.after?.sha256);

      const unavailableOwner = yield* Effect.flip(
        actions.readSkillChange(
          `${fixture.ownerId}-foreign`,
          fixture.expertId,
          committed.changeSet!.changeId,
        ),
      );
      assert.match(String(unavailableOwner), /不属于当前所有者和专家/u);
      const unavailableExpert = yield* Effect.flip(
        actions.readSkillChange(
          fixture.ownerId,
          `${fixture.expertId}-foreign`,
          committed.changeSet!.changeId,
        ),
      );
      assert.match(String(unavailableExpert), /不属于当前所有者和专家/u);

      const reverted = yield* actions.revertOwner(fixture.ownerId, fixture.expertId, {
        changeId: committed.changeSet!.changeId,
        requestId: "historical-skill-c1-revert",
      });
      assert.strictEqual(reverted.status, "committed");
      assert.strictEqual(reverted.changeSet?.revertsChangeId, committed.changeSet!.changeId);
      assert.isUndefined(reverted.changeSet?.data);
      assert.isUndefined(reverted.changeSet?.operationRef);
      const changes = yield* actions.listChanges(fixture.ownerId, fixture.expertId);
      const originalChange = changes.find(
        (change) => change.changeId === committed.changeSet!.changeId,
      );
      const inverseChange = changes.find(
        (change) => change.changeId === reverted.changeSet?.changeId,
      );
      assert.strictEqual(originalChange?.status, "reverted");
      assert.strictEqual(inverseChange?.revertsChangeId, committed.changeSet!.changeId);
      assert.isUndefined(inverseChange?.data);
      assert.isUndefined(inverseChange?.operationRef);
      assert.isUndefined(originalChange?.data);
      assert.isUndefined(originalChange?.operationRef);

      const fakeRef = {
        assetKind: "skill" as const,
        skillId: `skl_${"e".repeat(32)}`,
        revision: 1,
        packageId: `pkg_${"f".repeat(64)}`,
        expertRevision: fixture.expectedExpertRevision,
      };
      const aliasOriginPrepared = yield* memory.prepareChange({
        ownerId: fixture.ownerId,
        expertId: fixture.expertId,
        sourceScope: fixture.context.session.scope,
        assetKind: "skill",
        requestId: "projection-alias-origin",
        requestFingerprint: `sha256:${"1".repeat(64)}`,
        sourceRefs: [],
        summary: "Synthetic original for projection coverage.",
      });
      const aliasOrigin = yield* memory.completeChange({
        ownerId: fixture.ownerId,
        changeId: aliasOriginPrepared.changeId,
        status: "committed",
        before: null,
        after: fakeRef,
      });
      const aliasInversePrepared = yield* memory.prepareChange({
        ownerId: fixture.ownerId,
        expertId: fixture.expertId,
        sourceScope: fixture.context.session.scope,
        assetKind: "skill",
        requestId: "projection-alias-inverse",
        requestFingerprint: `sha256:${"2".repeat(64)}`,
        sourceRefs: [],
        summary: "Synthetic inverse for projection coverage.",
        data: { revertedChangeId: aliasOrigin.changeId },
      });
      yield* memory.completeChange({
        ownerId: fixture.ownerId,
        changeId: aliasInversePrepared.changeId,
        status: "committed",
        before: fakeRef,
        after: { ...fakeRef, revision: 2 },
      });
      const foreignExpertId = `${fixture.expertId}-foreign`;
      const foreignExpertPrepared = yield* memory.prepareChange({
        ownerId: fixture.ownerId,
        expertId: foreignExpertId,
        sourceScope: { ...fixture.context.session.scope, expertId: foreignExpertId },
        assetKind: "skill",
        requestId: "projection-foreign-expert-origin",
        requestFingerprint: `sha256:${"3".repeat(64)}`,
        sourceRefs: [],
        summary: "Wrong-expert candidate.",
      });
      const foreignExpertOrigin = yield* memory.completeChange({
        ownerId: fixture.ownerId,
        changeId: foreignExpertPrepared.changeId,
        status: "committed",
        before: null,
        after: fakeRef,
      });
      const invalidInversePrepared = yield* memory.prepareChange({
        ownerId: fixture.ownerId,
        expertId: fixture.expertId,
        sourceScope: fixture.context.session.scope,
        assetKind: "skill",
        requestId: "projection-invalid-inverse",
        requestFingerprint: `sha256:${"4".repeat(64)}`,
        sourceRefs: [],
        summary: "Inverse with a wrong-expert target.",
        data: { reverts: foreignExpertOrigin.changeId },
      });
      yield* memory.completeChange({
        ownerId: fixture.ownerId,
        changeId: invalidInversePrepared.changeId,
        status: "committed",
        before: fakeRef,
        after: { ...fakeRef, revision: 2 },
      });
      const differentSkillOriginPrepared = yield* memory.prepareChange({
        ownerId: fixture.ownerId,
        expertId: fixture.expertId,
        sourceScope: fixture.context.session.scope,
        assetKind: "skill",
        requestId: "projection-different-skill-origin",
        requestFingerprint: `sha256:${"5".repeat(64)}`,
        sourceRefs: [],
        summary: "Different Skill identity.",
      });
      const differentSkillRef = {
        ...fakeRef,
        skillId: `skl_${"d".repeat(32)}`,
      };
      const differentSkillOrigin = yield* memory.completeChange({
        ownerId: fixture.ownerId,
        changeId: differentSkillOriginPrepared.changeId,
        status: "committed",
        before: null,
        after: differentSkillRef,
      });
      const mismatchedIdentityInversePrepared = yield* memory.prepareChange({
        ownerId: fixture.ownerId,
        expertId: fixture.expertId,
        sourceScope: fixture.context.session.scope,
        assetKind: "skill",
        requestId: "projection-mismatched-identity-inverse",
        requestFingerprint: `sha256:${"6".repeat(64)}`,
        sourceRefs: [],
        summary: "Same asset kind but a different Skill identity.",
        data: { reverts: differentSkillOrigin.changeId },
      });
      yield* memory.completeChange({
        ownerId: fixture.ownerId,
        changeId: mismatchedIdentityInversePrepared.changeId,
        status: "committed",
        before: fakeRef,
        after: { ...fakeRef, revision: 2 },
      });
      const projected = yield* actions.listChanges(fixture.ownerId, fixture.expertId);
      assert.strictEqual(
        projected.find((change) => change.changeId === aliasInversePrepared.changeId)
          ?.revertsChangeId,
        aliasOrigin.changeId,
      );
      assert.isUndefined(
        projected.find((change) => change.changeId === invalidInversePrepared.changeId)
          ?.revertsChangeId,
      );
      assert.isUndefined(
        projected.find((change) => change.changeId === mismatchedIdentityInversePrepared.changeId)
          ?.revertsChangeId,
      );
    }),
  );

  test.effect(
    "bounds returned Skill change text by file count, UTF-16 units, and UTF-8 bytes",
    () =>
      Effect.gen(function* () {
        const actions = yield* ExpertLearningActions;
        const memory = yield* SpaceMemoryService;
        const learning = yield* ExpertLearningRepository;
        const fixture = yield* Effect.promise(() =>
          makeEditablePrivateSkillFixture(memory, learning),
        );
        const skill = fixture.skill!;
        const skillName = `Private save target ${fixture.expertId}`;
        const changes = [
          {
            path: "docs/a-overlimit.txt",
            content: Buffer.from("x".repeat(128_001)).toString("base64"),
          },
          { path: "docs/b-first.txt", content: Buffer.from("b".repeat(70_000)).toString("base64") },
          {
            path: "docs/c-second.txt",
            content: Buffer.from("c".repeat(70_000)).toString("base64"),
          },
          ...Array.from({ length: 97 }, (_, index) => ({
            path: `docs/file-${String(index).padStart(3, "0")}.txt`,
            content: Buffer.from("small historical text", "utf8").toString("base64"),
          })),
        ];
        const committed = yield* actions.commit(
          fixture.context,
          commitInput(fixture, "bounded-skill-change-text", {
            change: {
              assetKind: "skill",
              targetSkillId: skill.skillId,
              expectedSkillRevision: skill.revision,
              basePackageId: skill.packageId,
              expectedExpertRevision: fixture.expectedExpertRevision,
              name: `${skillName} updated`,
              changes,
            },
          }),
        );
        assert.strictEqual(committed.status, "committed");
        const detail = yield* actions.readSkillChange(
          fixture.ownerId,
          fixture.expertId,
          committed.changeSet!.changeId,
        );
        assert.strictEqual(detail.files.length, 100);
        assert.include(detail.coverage, "additional-file-pairs-omitted:1");
        const large = detail.files.find((file) => file.path === "docs/a-overlimit.txt");
        assert.strictEqual(large?.after?.omittedReason, "budget");
        assert.isUndefined(large?.after?.text);
        assert.strictEqual(
          detail.files.find((file) => file.path === "docs/b-first.txt")?.after?.text?.length,
          70_000,
        );
        assert.strictEqual(
          detail.files.find((file) => file.path === "docs/c-second.txt")?.after?.omittedReason,
          "budget",
        );
        const returnedTexts = detail.files.flatMap((file) => [file.before?.text, file.after?.text]);
        assert.isAtMost(
          returnedTexts.reduce((sum, text) => sum + (text?.length ?? 0), 0),
          128_000,
        );
        assert.isAtMost(
          returnedTexts.reduce((sum, text) => sum + Buffer.byteLength(text ?? "", "utf8"), 0),
          1_000_000,
        );
      }),
  );

  for (const scenario of [
    "fact",
    "environment",
    "project-rule",
    "void-rule",
    "foreign-space",
    "shared-rule",
  ] as const) {
    test.effect(`checks formal Memory applicability for Agent undo (${scenario})`, () =>
      Effect.gen(function* () {
        const actions = yield* ExpertLearningActions;
        const memory = yield* SpaceMemoryService;
        const learning = yield* ExpertLearningRepository;
        const fixture = yield* Effect.promise(() =>
          makeFixture(memory, learning, scenario === "void-rule" ? { spaceId: null } : undefined),
        );
        const result = yield* actions.commit(
          fixture.context,
          commitInput(fixture, `scope-${scenario}`, {
            change: {
              ...memoryDraft(`scope.${scenario}`),
              kind:
                scenario === "fact" ? "fact" : scenario === "environment" ? "environment" : "rule",
              ...(scenario === "project-rule" ? { projectOnly: true } : {}),
            },
          }),
        );
        const ref = memoryAfter(result.changeSet);
        const original = fixture.context.session;
        const projectId = `${original.scope.projectId}-next`;
        const spaceId =
          scenario === "foreign-space" ? `${original.scope.spaceId}-next` : original.scope.spaceId;
        const oldProject = projects.get(original.scope.projectId)!;
        projects.set(projectId, {
          ...oldProject,
          id: ProjectId.makeUnsafe(projectId),
          ...(spaceId === null ? {} : { spaceId: SpaceId.makeUnsafe(spaceId) }),
        });
        threads.set(fixture.threadId, {
          ...threads.get(fixture.threadId)!,
          projectId: ProjectId.makeUnsafe(projectId),
        });
        const scope = { ...original.scope, projectId, spaceId };
        const rootRunId = `${original.rootRunId}-next`;
        const skillAssemblyId = `assembly-scope-${fixture.expertId}`;
        const manifest = yield* memory.prepareRunManifest({
          scope,
          rootRunId,
          snapshotId: original.snapshotId,
          skillAssemblyId,
          learningEpoch: original.learningEpoch!,
        });
        const native = applied.get(fixture.threadId) as ExpertAppliedRuntimeRecord;
        applied.set(fixture.threadId, {
          ...native,
          skillApplication: {
            ...native.skillApplication!,
            skillRootRunId: rootRunId,
            skillAssemblyId,
          },
        });
        const context = {
          ...fixture.context,
          session: {
            ...original,
            scope,
            rootRunId,
            manifestId: manifest.id,
            knowledgeHash: manifest.hash,
          },
        };
        const input = {
          requestId: `scope-revert-${scenario}`,
          changeId: result.changeSet!.changeId,
          expectedRevision: ref.revision,
        };
        if (scenario === "shared-rule") {
          assert.strictEqual((yield* actions.revert(context, input)).status, "committed");
        } else {
          const error = yield* Effect.flip(actions.revert(context, input));
          assert.match(String(error), /scope|范围|Space|Project/u);
          const afterDenial = yield* memory.readApplicable({ scope: original.scope });
          assert.strictEqual(
            afterDenial.find((entry) => entry.memoryId === ref.memoryId)?.revision,
            ref.revision,
          );
          // Explicit owner operations retain their cross-scope management authority.
          assert.strictEqual(
            (yield* actions.revertOwner(fixture.ownerId, fixture.expertId, input)).status,
            "committed",
          );
        }
      }),
    );
  }
});
