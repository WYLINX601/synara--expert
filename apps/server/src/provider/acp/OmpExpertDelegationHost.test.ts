import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ApprovalRequestId,
  CommandId,
  MessageId,
  ProjectId,
  ThreadId,
  TurnId,
  type SuiteComposition,
} from "@synara/contracts";
import {
  OMP_NATIVE_EXPERT_METHODS,
  OmpNativeTaskReference,
  OmpPrepareNativeTaskResponse,
  OmpNativeTaskCredential,
  OmpNativeTaskAck,
  type OmpNativeTaskEvent,
  type OmpPrepareNativeTaskRequest,
} from "@synara/contracts/omp/expertDelegation";
import { Effect, Fiber, Layer, ManagedRuntime, Option, Schema, Stream } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { describe, expect, it, vi } from "vitest";
import { ServerConfig } from "../../config";
import { ServerSettingsService } from "../../serverSettings";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts";
import { ProviderRuntimeEventRepositoryLive } from "../../persistence/Layers/ProviderRuntimeEvents";
import { ProjectAgentRepositoryLive } from "../../persistence/Layers/ProjectAgentRepository";
import { ExpertAppliedRuntimeRepositoryLive } from "../../persistence/Layers/ExpertAppliedRuntimeRecords";
import { ProjectionPendingInteractionRepositoryLive } from "../../persistence/Layers/ProjectionPendingInteractions";
import {
  ProjectionPendingInteractionRepository,
  type ProjectionPendingInteractionRepositoryShape,
} from "../../persistence/Services/ProjectionPendingInteractions";
import { OrchestrationEngineLive } from "../../orchestration/Layers/OrchestrationEngine";
import { OrchestrationProjectionPipelineLive } from "../../orchestration/Layers/ProjectionPipeline";
import { OrchestrationProjectionSnapshotQueryLive } from "../../orchestration/Layers/ProjectionSnapshotQuery";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../../orchestration/Services/OrchestrationEngine";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery";
import {
  ExpertDelegationStore,
  ExpertDelegationStoreLive,
} from "../../workbench/host/expertDelegationStore";
import {
  ExpertDelegationArtifacts,
  ExpertDelegationArtifactsLive,
} from "../../workbench/host/expertDelegationArtifacts";
import {
  NativeExpertReexecutionGate,
  NativeExpertReexecutionGateLive,
  type NativeExpertReexecutionGateShape,
} from "../../workbench/host/nativeExpertReexecutionGate";
import { createRunSkillAssemblyStore } from "../../experts/RunSkillAssemblyStore";
import { createFileResourceStore, inspectFileResourceRoot } from "../../experts/FileResourceStore";
import { ExpertLearningRepository } from "../../experts/evolution/ExpertLearningRepository";
import { ExpertLearningRepositoryLive } from "../../workbench/host/expertLearningPersistence";
import { SpaceMemoryLive } from "../../workbench/host/spaceMemoryPersistence";
import { SpaceMemoryService } from "../../spaceMemory/SpaceMemoryService";
import { WorkbenchExpertRuntime, WorkbenchExpertRuntimeLive } from "../../workbench/runtimeLayer";
import {
  SuiteCompositionStore,
  SuiteCompositionStoreLive,
  suiteCompositionFingerprint,
  suiteImportSourceKey,
} from "../../suites/SuiteCompositionStore";
import { SuiteBindingResolver, SuiteBindingResolverLive } from "../../suites/SuiteBindingResolver";
import { suiteContentDigest } from "../../suites/suiteIdentity";
import { AgentGatewayCredentials } from "../../agentGateway/Services/AgentGatewayCredentials";
import { AgentGatewayCredentialsLive } from "../../agentGateway/Layers/AgentGatewayCredentials";
import { makeNativeExecutionAuthorizer } from "../../agentGateway/nativeExecutionScope";
import { OmpExpertExecutionStore, OmpExpertExecutionStoreLive } from "./OmpExpertExecutionStore";
import { OmpExpertDelegationHost, OmpExpertDelegationHostLive } from "./OmpExpertDelegationHost";
import { readonlyResourceTestConfigLayer } from "../../experts/expertResourceTestFixtures";

const createdAt = "2026-11-11T00:00:00.000Z";
const threadId = ThreadId.makeUnsafe("native-parent");
const projectId = ProjectId.makeUnsafe("native-project");
const rootRunId = "native-parent-root";
const generation = "actual-native-generation";
const turnId = "actual-native-turn";

async function fixture() {
  const commonLayer = ExpertDelegationStoreLive;
  const suiteLayer = SuiteBindingResolverLive.pipe(Layer.provideMerge(SuiteCompositionStoreLive));
  const engineLayer = OrchestrationEngineLive.pipe(
    Layer.provideMerge(OrchestrationProjectionPipelineLive),
    Layer.provideMerge(OrchestrationProjectionSnapshotQueryLive),
    Layer.provideMerge(OrchestrationEventStoreLive),
    Layer.provideMerge(OrchestrationCommandReceiptRepositoryLive),
    Layer.provideMerge(ProviderRuntimeEventRepositoryLive),
    Layer.provideMerge(ProjectAgentRepositoryLive),
    Layer.provideMerge(suiteLayer),
  );
  const hostLayer = OmpExpertDelegationHostLive.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        OmpExpertExecutionStoreLive.pipe(Layer.provideMerge(commonLayer)),
        ExpertDelegationArtifactsLive.pipe(Layer.provideMerge(commonLayer)),
        NativeExpertReexecutionGateLive.pipe(
          Layer.provideMerge(commonLayer),
          Layer.provideMerge(ProjectionPendingInteractionRepositoryLive),
        ),
        WorkbenchExpertRuntimeLive.pipe(Layer.provideMerge(ExpertAppliedRuntimeRepositoryLive)),
        AgentGatewayCredentialsLive,
        ExpertLearningRepositoryLive,
        SpaceMemoryLive,
      ),
    ),
    Layer.provideMerge(engineLayer),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provide(ServerSettingsService.layerTest()),
    Layer.provideMerge(readonlyResourceTestConfigLayer("native-host-")),
    Layer.provideMerge(NodeServices.layer),
  );
  const runtime = ManagedRuntime.make(hostLayer);
  const setup = await runtime.runPromise(
    Effect.gen(function* () {
      return {
        host: yield* OmpExpertDelegationHost,
        engine: yield* OrchestrationEngineService,
        projection: yield* ProjectionSnapshotQuery,
        common: yield* ExpertDelegationStore,
        executions: yield* OmpExpertExecutionStore,
        artifacts: yield* ExpertDelegationArtifacts,
        suites: yield* SuiteCompositionStore,
        resolver: yield* SuiteBindingResolver,
        workbench: yield* WorkbenchExpertRuntime,
        credentials: yield* AgentGatewayCredentials,
        config: yield* ServerConfig,
        sql: yield* SqlClient.SqlClient,
        gate: yield* NativeExpertReexecutionGate,
        interactions: yield* ProjectionPendingInteractionRepository,
        learning: yield* ExpertLearningRepository,
        memory: yield* SpaceMemoryService,
      };
    }),
  );
  const run = <A, E>(effect: Effect.Effect<A, E>) => runtime.runPromise(effect);
  const { workbench, config, suites, resolver, engine, sql } = setup;
  const workspace = path.join(config.stateDir, "workspace");
  await fs.mkdir(workspace);
  const makeExpert = async (id: string) => {
    const skill = (
      await workbench.skillLibrary.execute({
        action: "create",
        name: `${id}-method`,
        tags: [],
        body: `---\nname: ${id}-method\ndescription: ${id} only\n---\n${id} private procedure.\n`,
      })
    ).skill!;
    const expert = await workbench.experts.save({
      id,
      name: id,
      persona: `${id} pinned persona`,
      description: `${id} professional`,
      useCases: "",
      outputRequirements: "Actual work",
      skills: [],
      references: [],
      connections: [],
      skillBindings: [{ skillId: skill.skillId, enabled: true, resourceMode: "run-private" }],
    });
    return { expert, skill };
  };
  const parent = await makeExpert("parent-expert");
  const author = await makeExpert("author-expert");
  const reviewer = await makeExpert("global-reviewer");
  const referenceDirectory = path.join(config.stateDir, "author-reference-directory");
  const referenceFile = path.join(config.stateDir, "author-reference-file.txt");
  await fs.mkdir(referenceDirectory);
  await fs.writeFile(
    path.join(referenceDirectory, "reference-note.txt"),
    "REFERENCE_DATA_NOT_PERSONA_INSTRUCTIONS",
  );
  await fs.writeFile(referenceFile, "SINGLE_REFERENCE_DATA_NOT_PERSONA_INSTRUCTIONS");
  await workbench.experts.save({
    ...author.expert,
    expectedRevision: author.expert.revision,
    references: [referenceDirectory, referenceFile],
  });
  const instructions = path.join(config.stateDir, "suite-instructions");
  await fs.mkdir(instructions);
  await fs.writeFile(path.join(instructions, "rules.txt"), "SUITE_SHARED_INSTRUCTIONS_ONCE");
  const sealed = await createFileResourceStore(config.stateDir).seal(instructions);
  const composition: SuiteComposition = {
    schemaVersion: 1,
    ref: { suiteId: "suite_4ce8808e-e7dc-4314-8c75-e0a2a5c74829", revision: 1 },
    name: "Native suite",
    description: "",
    source: {
      kind: "local-folder",
      sourceId: "native-source",
      contentHash: sealed.packageId.slice(4),
    },
    adapterId: "synara-suite-v1",
    adapterVersion: 1,
    members: [
      { key: "parent", expertId: parent.expert.id, roleSourcePath: null },
      { key: "author", expertId: author.expert.id, roleSourcePath: null },
    ],
    resources: [
      {
        key: "rules",
        purpose: "Shared instructions",
        audience: "shared",
        ref: {
          kind: "files",
          sourceId: "native-source",
          resourceId: "native-rules",
          purpose: "instructions",
        },
      },
    ],
    defaults: { language: "French", outputDirectory: "deliverables" },
    compositionHash: "0".repeat(64),
    createdAt,
  };
  const fixed = { ...composition, compositionHash: suiteCompositionFingerprint(composition) };
  const importRequest = {
    operationId: "native-import",
    previewId: "native-preview",
    contentHash: fixed.source.contentHash,
    mode: "reuse-or-create" as const,
  };
  await run(
    suites.beginImport(importRequest, suiteContentDigest(importRequest), {
      planId: "native-plan",
      creatorOperationId: importRequest.operationId,
      sourceKey: suiteImportSourceKey(fixed),
      sourceRoot: instructions,
      composition: fixed,
      experts: fixed.members.map(({ key, expertId }) => ({
        key,
        expertId,
        definition: null,
        bmadRole: null,
        roleSourceRoot: null,
        identityAvailable: true,
      })),
      assets: [
        { key: "rules", kind: "files", rootPath: sealed.rootPath, packageId: sealed.packageId },
      ],
      fileResourceRevisions: [
        { resourceId: "native-rules", revision: 1, packageId: sealed.packageId },
      ],
      issues: [],
    }),
  );
  await run(suites.completeImport("native-plan"));
  await run(
    engine.dispatch({
      type: "project.create",
      commandId: CommandId.makeUnsafe("native-project-create"),
      projectId,
      title: "Native project",
      workspaceRoot: workspace,
      createdAt,
    }),
  );
  await run(
    engine.dispatch({
      type: "thread.create",
      commandId: CommandId.makeUnsafe("native-parent-create"),
      threadId,
      projectId,
      title: "Native parent",
      modelSelection: { provider: "omp", model: "isolated-fixture" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      expertDraftSelection: { expertId: parent.expert.id, suite: fixed.ref },
      createdAt,
    }),
  );
  await run(
    engine.dispatch({
      type: "thread.turn.start",
      commandId: CommandId.makeUnsafe("native-parent-first-send"),
      threadId,
      message: {
        messageId: MessageId.makeUnsafe("native-parent-first-message"),
        role: "user",
        text: "Perform the approved parent task.",
        attachments: [],
      },
      runtimeMode: "full-access",
      interactionMode: "default",
      createdAt,
    }),
  );
  const boundParent = Option.getOrThrow(await run(setup.projection.getThreadShellById(threadId)));
  if (!boundParent.expertBinding || !boundParent.capabilityBindingId)
    throw new Error("The actual first send did not fix the parent binding.");
  const base = boundParent.expertBinding;
  const parentBinding = await run(suites.readBinding(boundParent.capabilityBindingId));
  if (!parentBinding) throw new Error("The actual parent capability binding is unavailable.");
  const runs = createRunSkillAssemblyStore(config.stateDir, { suiteStore: suites });
  const parentRun = await runs.prepare({
    threadId,
    rootRunId,
    baseSnapshotId: base.snapshotId,
    capabilityBindingId: parentBinding.bindingId,
    projectRoot: workspace,
    createdAt,
  });
  const parentSession = (await runs.sessionFor(parentRun))!;
  await run(
    sql`INSERT INTO provider_session_runtime(thread_id, provider_name, adapter_key, runtime_mode, status, lifecycle_generation, last_seen_at) VALUES (${threadId}, 'omp', 'omp', 'full-access', 'running', ${generation}, ${createdAt})`,
  );
  await run(
    engine.dispatch({
      type: "thread.session.set",
      commandId: CommandId.makeUnsafe("native-session"),
      threadId,
      session: {
        threadId,
        status: "running",
        providerName: "omp",
        runtimeMode: "full-access",
        activeTurnId: TurnId.makeUnsafe(turnId),
        lastError: null,
        updatedAt: createdAt,
      },
      createdAt,
    }),
  );
  const requests: { method: string; params: unknown }[] = [];
  const terminalProofs = new Map<
    string,
    { nativeSessionId: string; terminalEvent: OmpNativeTaskEvent }
  >();
  const context = {
    threadId,
    generation,
    cwd: workspace,
    expertSession: parentSession,
    capabilityBindingId: parentBinding.bindingId,
    assemblyId: parentRun.assemblyId,
    buildFingerprint: "a".repeat(64),
    request: async (method: string, params: unknown) => {
      requests.push({ method, params });
      const reference = Schema.decodeUnknownSync(OmpNativeTaskReference)(params);
      if (method === OMP_NATIVE_EXPERT_METHODS.cancel) return { accepted: true };
      if (method === OMP_NATIVE_EXPERT_METHODS.query) {
        const proof = terminalProofs.get(reference.attemptId);
        return proof ? { state: "terminal", ...proof } : { state: "not-found" };
      }
      throw new Error("The host must never start an SDK through a new execution port.");
    },
  };
  const protocol = (await setup.host.protocolFactory(context))!;
  await protocol.bindSession("actual-acp-session");
  await protocol.preparePrompt({
    sessionId: "actual-acp-session",
    parentTurnId: turnId,
    parentRootRunId: rootRunId,
  });
  const request = (
    expertId: string,
    suffix: string,
    deliveryMode: OmpPrepareNativeTaskRequest["deliveryMode"] = "host-continuation",
  ): OmpPrepareNativeTaskRequest => ({
    parentSessionId: "actual-acp-session",
    parentGeneration: generation,
    parentTurnId: turnId,
    toolCallId: `tool-${suffix}`,
    taskIndex: 0,
    nativeTaskId: `native-${suffix}`,
    agentName: `synara_expert_${suiteContentDigest({ expertId }).slice(0, 32)}`,
    task: `Produce actual ${suffix}`,
    context: "Existing approved work",
    deliverable: "Versioned source",
    deliveryMode,
  });
  const prepare = async (input: OmpPrepareNativeTaskRequest, owner = protocol) =>
    Schema.decodeUnknownSync(OmpPrepareNativeTaskResponse)(
      await owner.handleRequest(OMP_NATIVE_EXPERT_METHODS.prepare, input),
    );
  const start = async (
    prepared: OmpPrepareNativeTaskResponse,
    input: OmpPrepareNativeTaskRequest,
    ready = true,
  ) => {
    const started = {
      attemptId: prepared.attemptId,
      nativeTaskId: input.nativeTaskId,
      nativeSessionId: `sdk-${prepared.attemptId}`,
      parentGeneration: generation,
    };
    await protocol.handleRequest(OMP_NATIVE_EXPERT_METHODS.started, started);
    if (ready)
      await protocol.handleRequest(OMP_NATIVE_EXPERT_METHODS.started, {
        ...started,
        initializationComplete: true,
      });
    return started;
  };
  const credential = async (
    prepared: OmpPrepareNativeTaskResponse,
    input: OmpPrepareNativeTaskRequest,
  ) =>
    Schema.decodeUnknownSync(OmpNativeTaskCredential)(
      await protocol.handleRequest(OMP_NATIVE_EXPERT_METHODS.credential, {
        attemptId: prepared.attemptId,
        nativeTaskId: input.nativeTaskId,
        parentGeneration: generation,
        credentialHandle: prepared.profile.mcpServers[0]!.credentialHandle,
      }),
    );
  const terminal = (
    prepared: OmpPrepareNativeTaskResponse,
    input: OmpPrepareNativeTaskRequest,
  ): OmpNativeTaskEvent => ({
    protocolVersion: 1,
    attemptId: prepared.attemptId,
    nativeTaskId: input.nativeTaskId,
    parentGeneration: generation,
    sequence: 1,
    payload: {
      kind: "terminal",
      outcome: "completed",
      result: { summary: "Actual result", artifacts: [] },
      issue: null,
    },
  });
  const resultEvents = async () =>
    Array.from(
      await run(
        Stream.runCollect(
          engine.readThreadEvents(threadId, 0, ["thread.expert-delegation-result"]),
        ),
      ),
    );
  return {
    ...setup,
    runtime,
    run,
    workspace,
    parent,
    author,
    reviewer,
    fixed,
    sealed,
    parentRun,
    runs,
    context,
    protocol,
    requests,
    terminalProofs,
    request,
    prepare,
    start,
    credential,
    terminal,
    resultEvents,
    dispose: () => runtime.dispose(),
  };
}

interface ApprovalFixture {
  readonly engine: OrchestrationEngineShape;
  readonly gate: NativeExpertReexecutionGateShape;
  readonly interactions: ProjectionPendingInteractionRepositoryShape;
  readonly run: <A, E>(effect: Effect.Effect<A, E>) => Promise<A>;
}

async function approvalWatcher(f: ApprovalFixture) {
  const attached = Promise.withResolvers<void>();
  const fiber = Effect.runFork(
    Effect.scoped(
      Effect.gen(function* () {
        const events = yield* f.engine.subscribeDomainEvents;
        attached.resolve();
        return yield* Stream.runHead(
          events.pipe(
            Stream.filter(
              (event) =>
                event.type === "thread.activity-appended" &&
                event.payload.activity.kind === "approval.requested",
            ),
          ),
        );
      }),
    ),
  );
  await attached.promise;
  return async () => {
    const event = Option.getOrThrow(await f.run(Fiber.join(fiber)));
    if (event.type !== "thread.activity-appended")
      throw new Error("Expected actual approval activity");
    const payload = event.payload.activity.payload;
    if (
      !payload ||
      typeof payload !== "object" ||
      !("requestId" in payload) ||
      typeof payload.requestId !== "string"
    )
      throw new Error("Expected actual approval identity");
    return payload.requestId;
  };
}

async function approve(f: ApprovalFixture, requestId: string) {
  expect(
    await f.run(
      f.interactions.claimResponse({
        threadId,
        interactionKind: "approval",
        requestId: ApprovalRequestId.makeUnsafe(requestId),
        lifecycleGeneration: generation,
        responseCommandId: CommandId.makeUnsafe(`human:${requestId}`),
        decision: "accept",
        requestedAt: new Date().toISOString(),
      }),
    ),
  ).toBe(true);
  expect(await f.gate.respond(threadId, requestId, "accept")).toBe(true);
}

// These tests use the original Engine, event receipts, SQL owners and filesystem.
// Only the already-negotiated ACP query/cancel boundary is supplied by the fixture.
describe("OMP native Expert host lifecycle", () => {
  it("owns a discovery-only catalog and independently fixes target resources, knowledge, actual sessions and Gateway leases", async () => {
    const f = await fixture();
    try {
      for (const [expertId, rule] of [
        [f.parent.expert.id, "PARENT_PRIVATE_KNOWLEDGE"],
        [f.author.expert.id, "AUTHOR_PRIVATE_KNOWLEDGE"],
      ] as const) {
        const ownerId = `owner-${expertId}`;
        await f.run(
          f.learning.writeState(
            {
              ownerId,
              expertId,
              revision: 1,
              updatedAt: createdAt,
              record: JSON.stringify({
                ownerKind: "session",
                state: { expertId, enabled: true, epoch: 1, revision: 1, updatedAt: createdAt },
              }),
            },
            0,
          ),
        );
        await f.run(
          f.memory.commit({
            scope: { ownerId, expertId, projectId, spaceId: null },
            expectedRevision: 0,
            kind: "rule",
            key: "target-rule",
            content: rule,
            sources: [
              {
                kind: "owner",
                requestId: `rule-${expertId}`,
                contentHash: `sha256:${createHash("sha256").update(rule).digest("hex")}`,
              },
            ],
            requestId: `rule-${expertId}`,
            requestFingerprint: `sha256:${suiteContentDigest({ expertId, rule })}`,
            observedAt: createdAt,
          }),
        );
      }
      f.credentials.setConnectorServers?.([
        { name: "parent-connected-tool", connectorId: "parent-connector" },
      ]);
      const parentConnection = f.credentials.connectionForThread(threadId, "omp");
      expect(parentConnection.connectors).toHaveLength(1);
      expect(
        f.credentials.canUseConnector?.(parentConnection.bearerToken, "parent-connector"),
      ).toBe(true);
      const input = f.request(f.author.expert.id, "author");
      const globalInput = f.request(f.reviewer.expert.id, "reviewer");
      const [author, reviewer] = await Promise.all([f.prepare(input), f.prepare(globalInput)]);
      expect(author.attemptId).not.toBe(reviewer.attemptId);
      expect(author.profile.persona).toContain("author-expert pinned persona");
      expect(author.profile.persona).not.toContain("parent-expert pinned persona");
      expect(author.profile.persona).toContain("Fixed language: French");
      expect(author.profile.persona).not.toContain("SUITE_SHARED_INSTRUCTIONS_ONCE");
      expect(author.profile.persona).not.toContain("REFERENCE_DATA_NOT_PERSONA_INSTRUCTIONS");
      expect(author.profile.persona).not.toContain(
        "SINGLE_REFERENCE_DATA_NOT_PERSONA_INSTRUCTIONS",
      );
      const resourceFiles = await Promise.all(
        author.profile.resourceRoots.map((root) => fs.readdir(root.path)),
      );
      expect(resourceFiles.some((files) => files.includes("reference-note.txt"))).toBe(true);
      expect(author.profile.contextFiles).toHaveLength(1);
      expect(reviewer.profile.contextFiles).toHaveLength(0);
      expect(author.profile.persona).toContain("AUTHOR_PRIVATE_KNOWLEDGE");
      expect(author.profile.persona).not.toContain("PARENT_PRIVATE_KNOWLEDGE");
      expect(author.profile.persona).toContain("no learning-action authority");
      expect(reviewer.profile.persona).not.toContain("AUTHOR_PRIVATE_KNOWLEDGE");
      expect(await f.run(f.learning.listStates())).toHaveLength(2);
      const reviewerBinding = await f.run(f.suites.readBinding(reviewer.capabilityBindingId));
      expect(reviewerBinding?.suite).toBeNull();
      expect((await f.runs.current(threadId))?.rootRunId).toBe(rootRunId);
      expect(author.profile.skillEntries.map((entry) => entry.name)).toEqual([
        "author-expert-method",
      ]);
      expect(reviewer.profile.skillEntries.map((entry) => entry.name)).toEqual([
        "global-reviewer-method",
      ]);
      for (const root of author.profile.resourceRoots)
        expect(await inspectFileResourceRoot(root.path)).toEqual({
          rootPath: root.path,
          contentHash: root.contentHash,
        });
      const ownRun = await f.runs.read(author.attemptId);
      const ownContext = await f.runs.runtimeContext(ownRun!);
      const privateRoot = ownContext!.resourceRoots.find((root) => root.mode === "run-private")!;
      expect(
        author.profile.resourceRoots.find((root) => root.path === privateRoot.path)?.contentHash,
      ).not.toBe(privateRoot.contentHash);
      expect(await f.runs.read(author.attemptId)).toMatchObject({
        rootRunId: author.attemptId,
        phase: "initializing",
      });
      await expect(f.credential(author, input)).rejects.toMatchObject({
        data: { code: "execution_unknown" },
      });
      await expect(
        f.protocol.handleRequest(OMP_NATIVE_EXPERT_METHODS.started, {
          attemptId: author.attemptId,
          nativeTaskId: input.nativeTaskId,
          nativeSessionId: "sdk-too-early",
          parentGeneration: generation,
          initializationComplete: true,
        }),
      ).rejects.toThrow();
      const started = await f.start(author, input, false);
      expect((await f.runs.read(author.attemptId))?.phase).toBe("initializing");
      await f.protocol.handleRequest(OMP_NATIVE_EXPERT_METHODS.started, {
        ...started,
        initializationComplete: true,
      });
      await f.protocol.handleRequest(OMP_NATIVE_EXPERT_METHODS.started, {
        ...started,
        initializationComplete: true,
      });
      expect((await f.runs.read(author.attemptId))?.phase).toBe("ready");
      await f.start(reviewer, globalInput);
      const [a, b] = await Promise.all([
        f.credential(author, input),
        f.credential(reviewer, globalInput),
      ]);
      const aToken = a.authorization.slice("Bearer ".length),
        bToken = b.authorization.slice("Bearer ".length);
      expect(aToken).not.toBe(bToken);
      expect(f.credentials.verifySession(aToken)?.nativeExecution).toMatchObject({
        attemptId: author.attemptId,
        capabilityBindingId: author.capabilityBindingId,
        assemblyId: author.assemblyId,
        parentRootRunId: rootRunId,
      });
      expect(f.credentials.verifySession(bToken)?.nativeExecution?.attemptId).toBe(
        reviewer.attemptId,
      );
      const authorize = makeNativeExecutionAuthorizer({
        stateDir: f.config.stateDir,
        delegations: f.common,
        bindings: f.suites,
        executionOwner: f.executions,
      });
      const parentShell = (await f.run(f.engine.getReadModel())).threads.find(
        (thread) => thread.id === threadId,
      )!;
      const authorIdentity = f.credentials.verifySession(aToken)!,
        reviewerIdentity = f.credentials.verifySession(bToken)!;
      expect((await f.run(authorize(authorIdentity, parentShell))).bindingId).toBe(
        author.capabilityBindingId,
      );
      expect((await f.run(authorize(reviewerIdentity, parentShell))).bindingId).toBe(
        reviewer.capabilityBindingId,
      );
      expect(authorIdentity.learningSession?.scope.expertId).toBe(f.author.expert.id);
      expect(authorIdentity.learningSession?.rootRunId).toBe(author.attemptId);
      expect(reviewerIdentity.learningSession).toBeUndefined();
      expect(f.credentials.canUseConnector?.(aToken, "parent-connector")).toBe(false);
      await expect(
        f.protocol.handleRequest(OMP_NATIVE_EXPERT_METHODS.credential, {
          attemptId: author.attemptId,
          nativeTaskId: input.nativeTaskId,
          parentGeneration: generation,
          credentialHandle: reviewer.profile.mcpServers[0]!.credentialHandle,
        }),
      ).rejects.toThrow();
      await f.protocol.cancelTask(input.nativeTaskId);
      expect(f.credentials.verifySession(aToken)).toBeNull();
      expect(f.credentials.verifySession(bToken)?.nativeExecution?.attemptId).toBe(
        reviewer.attemptId,
      );
      expect(await f.run(authorize(authorIdentity, parentShell).pipe(Effect.flip))).toMatchObject({
        code: "caller_session_inactive",
      });
      expect((await f.run(authorize(reviewerIdentity, parentShell))).bindingId).toBe(
        reviewer.capabilityBindingId,
      );
      expect((await f.run(f.common.readAttempt(author.attemptId)))?.state).toBe("unknown");
      await expect(
        f.protocol.handleRequest(OMP_NATIVE_EXPERT_METHODS.started, {
          ...started,
          initializationComplete: true,
        }),
      ).rejects.toThrow();
    } finally {
      await f.dispose();
    }
  });

  it.each([
    { label: "replacement generation", generation: "replacement-generation", status: "running" },
    { label: "stopped runtime", generation, status: "stopped" },
    { label: "error runtime", generation, status: "error" },
  ])(
    "rejects an already issued native lease immediately after $label without a replacement protocol",
    async (runtime) => {
      const f = await fixture();
      try {
        const input = f.request(f.author.expert.id, "runtime-authority");
        const prepared = await f.prepare(input);
        await f.start(prepared, input);
        const credential = await f.credential(prepared, input);
        const identity = f.credentials.verifySession(
          credential.authorization.slice("Bearer ".length),
        )!;
        const authorize = makeNativeExecutionAuthorizer({
          stateDir: f.config.stateDir,
          delegations: f.common,
          bindings: f.suites,
          executionOwner: f.executions,
        });
        const parentShell = (await f.run(f.engine.getReadModel())).threads.find(
          (thread) => thread.id === threadId,
        )!;
        expect((await f.run(authorize(identity, parentShell))).bindingId).toBe(
          prepared.capabilityBindingId,
        );
        await f.run(
          f.sql`UPDATE provider_session_runtime SET lifecycle_generation = ${runtime.generation}, status = ${runtime.status} WHERE thread_id = ${threadId}`,
        );
        expect((await f.run(f.common.readAttempt(prepared.attemptId)))?.state).toBe("running");
        expect(await f.run(authorize(identity, parentShell).pipe(Effect.flip))).toMatchObject({
          code: "caller_session_inactive",
        });
        await expect(f.credential(prepared, input)).rejects.toMatchObject({
          data: { code: "execution_unknown" },
        });
        expect(f.requests).toEqual([]);
      } finally {
        await f.dispose();
      }
    },
  );

  it.each(["cancel", "query"] as const)(
    "closes local parent authority while native %s never replies",
    async (blockedMethod) => {
      const f = await fixture();
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      let cancelling: Promise<void> | undefined;
      let closing: Promise<void> | undefined;
      let closed = false;
      try {
        const input = f.request(f.author.expert.id, `unresponsive-${blockedMethod}`);
        const prepared = await f.prepare(input);
        await f.start(prepared, input);
        const lease = await f.credential(prepared, input);
        const originalRequest = f.context.request;
        f.context.request = async (method, params) => {
          if (method === OMP_NATIVE_EXPERT_METHODS[blockedMethod]) {
            entered.resolve();
            await release.promise;
          }
          return originalRequest(method, params);
        };
        cancelling = f.protocol.cancelTask(input.nativeTaskId);
        await entered.promise;
        closing = f.protocol.close().then(() => {
          closed = true;
        });
        await vi.waitFor(() =>
          expect(closed, "local authority teardown must not await the native reply").toBe(true),
        );
        expect(f.credentials.verifySession(lease.authorization.slice("Bearer ".length))).toBeNull();
        const attempt = await f.run(f.common.readAttempt(prepared.attemptId));
        expect(attempt?.state).toBe("unknown");
        expect(attempt?.resultRef).toBeNull();
        expect(await f.resultEvents()).toEqual([]);
        await expect(f.credential(prepared, input)).rejects.toThrow();
        await expect(
          f.protocol.preparePrompt({
            sessionId: "actual-acp-session",
            parentTurnId: "late-turn",
            parentRootRunId: rootRunId,
          }),
        ).rejects.toThrow();
        await expect(fs.stat(f.protocol.agentDirectory)).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        release.resolve();
        await cancelling?.catch(() => undefined);
        await closing?.catch(() => undefined);
        await f.dispose();
      }
    },
  );

  it("deduplicates the exact request and audits changed native/body/mode frames; unknown replay cannot authorize a new execution", async () => {
    const f = await fixture();
    try {
      const input = f.request(f.author.expert.id, "same-request");
      const [one, two] = await Promise.all([f.prepare(input), f.prepare(input)]);
      expect(one).toEqual(two);
      await fs.writeFile(
        path.join(path.dirname(one.profile.skillEntries[0]!.path), "legitimate-output"),
        "do not recompute the immutable profile",
      );
      expect(await f.prepare(input)).toEqual(one);
      for (const changed of [
        { ...input, task: ` ${input.task} ` },
        { ...input, deliveryMode: "native-return" as const },
        { ...input, nativeTaskId: "other-native" },
      ])
        await expect(f.prepare(changed)).rejects.toMatchObject({
          data: { code: "result_conflict" },
        });
      const audits = await f.run(
        f.sql`SELECT * FROM expert_delegation_conflicts WHERE attempt_id = ${one.attemptId}`,
      );
      expect(audits).toHaveLength(3);
      await f.run(f.common.transition(one.attemptId, "unknown", createdAt));
      await expect(f.prepare(input)).rejects.toMatchObject({ data: { code: "execution_unknown" } });
      expect(await f.run(f.common.listForParent(threadId))).toHaveLength(1);
      expect(f.requests).toEqual([]);
      await expect(f.protocol.bindSession("different-actual-session")).rejects.toThrow();
      await expect(f.prepare({ ...input, parentGeneration: "forged" })).rejects.toThrow();
    } finally {
      await f.dispose();
    }
  });

  it("uses a durable human decision across a real new parent Run, preserving origin while continuing only the newly accepted fixed configuration", async () => {
    const f = await fixture();
    try {
      const input = f.request(f.author.expert.id, "human-redo");
      const first = await f.prepare(input);
      await f.start(first, input);
      await fs.mkdir(path.join(f.workspace, "_bmad"));
      await fs.writeFile(
        path.join(f.workspace, "_bmad", "config.toml"),
        '[core]\ncommunication_language = "German"\noutput_folder = "new-parent-deliverables"\n',
      );
      await f.run(
        f.engine.dispatch({
          type: "thread.session.set",
          commandId: CommandId.makeUnsafe("old-human-turn-ended"),
          threadId,
          session: {
            threadId,
            status: "idle",
            providerName: "omp",
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: createdAt,
          },
          createdAt,
        }),
      );
      const messageId = MessageId.makeUnsafe("explicit-human-redo-message");
      await f.run(
        f.engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.makeUnsafe("explicit-human-redo"),
          threadId,
          message: {
            messageId,
            role: "user",
            text: "Reconcile the prior attempt and run that Expert task again with the current approved configuration.",
            attachments: [],
          },
          runtimeMode: "full-access",
          interactionMode: "default",
          createdAt,
        }),
      );
      const newParentRoot = `run:${threadId}:${messageId}`;
      const newParent = await f.runs.prepare({
        threadId,
        rootRunId: newParentRoot,
        baseSnapshotId: f.parentRun.baseSnapshotId,
        capabilityBindingId: f.context.capabilityBindingId,
        projectRoot: f.workspace,
        createdAt,
      });
      expect(newParent.effectiveConfig.language).toBe("German");
      const nextTurn = "actual-human-redo-turn";
      await f.protocol.preparePrompt({
        sessionId: "actual-acp-session",
        parentTurnId: nextTurn,
        parentRootRunId: newParentRoot,
      });
      const newInput = {
        ...input,
        parentTurnId: nextTurn,
        toolCallId: "new-human-tool",
        nativeTaskId: "new-human-native",
      };
      const getApproval = await approvalWatcher(f);
      const next = f.prepare(newInput);
      const id = await getApproval();
      expect(
        f.requests.some(
          (request) =>
            request.method === OMP_NATIVE_EXPERT_METHODS.query &&
            Schema.decodeUnknownSync(OmpNativeTaskReference)(request.params).attemptId ===
              first.attemptId,
        ),
      ).toBe(true);
      expect(await f.run(f.common.listForParent(threadId))).toHaveLength(1);
      await approve(f, id);
      const second = await next;
      expect(second.attemptId).not.toBe(first.attemptId);
      const [oldAttempt, newAttempt] = await Promise.all([
        f.run(f.common.readAttempt(first.attemptId)),
        f.run(f.common.readAttempt(second.attemptId)),
      ]);
      expect(oldAttempt?.state).toBe("unknown");
      expect(newAttempt?.delegationId).toBe(oldAttempt?.delegationId);
      expect(newAttempt?.requestHash).toBe(oldAttempt?.requestHash);
      expect(await f.gate.respond(threadId, id, "accept")).toBe(false);
      const decisions = await f.run(f.interactions.listByThreadId({ threadId }));
      expect(decisions.find((entry) => entry.requestId === id)?.status).toBe("confirmed");
      expect(first.profile.persona).toContain("Fixed language: French");
      expect(second.profile.persona).toContain("Fixed language: German");
      expect(second.profile.persona).toContain("new-parent-deliverables");
      expect((await f.runs.current(threadId))?.rootRunId).toBe(newParentRoot);
      expect(await f.run(f.common.readDelegation(newAttempt!.delegationId))).toMatchObject({
        parentRootRunId: rootRunId,
      });
      expect(
        (await f.run(f.suites.readBinding(second.capabilityBindingId)))?.purpose,
      ).toMatchObject({ parentRootRunId: rootRunId });
      await f.start(second, newInput);
      const lease = await f.credential(second, newInput);
      const identity = f.credentials.verifySession(lease.authorization.slice("Bearer ".length))!;
      const authorize = makeNativeExecutionAuthorizer({
        stateDir: f.config.stateDir,
        delegations: f.common,
        bindings: f.suites,
        executionOwner: f.executions,
      });
      const parentShell = (await f.run(f.engine.getReadModel())).threads.find(
        (thread) => thread.id === threadId,
      )!;
      expect((await f.run(authorize(identity, parentShell))).bindingId).toBe(
        second.capabilityBindingId,
      );
      await f.protocol.handleRequest(OMP_NATIVE_EXPERT_METHODS.event, f.terminal(second, newInput));
      expect((await f.resultEvents())[0]).toMatchObject({
        payload: { parentRootRunId: rootRunId, attemptId: second.attemptId, applyToParent: true },
        metadata: {
          expertDelegationContinuation: {
            parentRootRunId: newParentRoot,
            delegationId: newAttempt!.delegationId,
            attemptId: second.attemptId,
          },
        },
      });
      expect((await f.run(f.common.readAttempt(first.attemptId)))?.state).toBe("unknown");
    } finally {
      await f.dispose();
    }
  });

  it("atomically rejects stale unknown approval and cancelled admission without inserting a new association", async () => {
    const f = await fixture();
    try {
      const input = f.request(f.author.expert.id, "stale");
      const prepared = await f.prepare(input);
      await f.run(f.common.transition(prepared.attemptId, "unknown", createdAt));
      const previous = (await f.run(f.common.readAttempt(prepared.attemptId)))!;
      const execution = (await f.run(f.executions.read(previous.attemptId)))!;
      const delegation = (await f.run(f.common.readDelegation(previous.delegationId)))!;
      const proposed = {
        ...previous,
        attemptId: "new-stale-attempt",
        requestId: "new-stale-request",
        executionBindingId: "new-stale-binding",
        state: "prepared" as const,
        revision: 1,
      };
      const proposedExecution = {
        ...execution,
        attemptId: proposed.attemptId,
        executionBindingId: proposed.executionBindingId,
        nativeTaskId: "new-stale-native",
        toolCallId: "new-stale-tool",
      };
      await f.run(f.common.transition(previous.attemptId, "cancel-requested", createdAt));
      expect(
        await f.run(
          f.executions
            .prepare({
              delegation,
              attempt: proposed,
              execution: proposedExecution,
              admission: Effect.succeed(true),
              previousUnknown: {
                attemptId: previous.attemptId,
                revision: previous.revision,
                requestHash: previous.requestHash,
              },
            })
            .pipe(Effect.flip),
        ),
      ).toMatchObject({ code: "revision_conflict" });
      expect(
        await f.run(
          f.executions
            .prepare({
              delegation,
              attempt: proposed,
              execution: proposedExecution,
              admission: Effect.succeed(false),
            })
            .pipe(Effect.flip),
        ),
      ).toMatchObject({ code: "execution_unknown" });
      expect(await f.run(f.common.readAttempt(proposed.attemptId))).toBeNull();
      expect(await f.run(f.executions.read(proposed.attemptId))).toBeNull();
    } finally {
      await f.dispose();
    }
  });

  it("commits ingress, immutable artifact bytes, original Engine result and ACK exactly once across rollback and dropped ACK", async () => {
    const f = await fixture();
    try {
      const input = f.request(f.author.expert.id, "rollback");
      const prepared = await f.prepare(input);
      await f.start(prepared, input);
      const bytes = Buffer.from("export const actualVersion = 7;\n");
      await fs.writeFile(path.join(prepared.profile.artifactRoot, "result.ts"), bytes);
      const event = f.terminal(prepared, input);
      if (event.payload.kind !== "terminal") throw new Error("Expected terminal fixture");
      const withArtifact = {
        ...event,
        payload: {
          ...event.payload,
          result: {
            ...event.payload.result,
            artifacts: [
              {
                path: "result.ts",
                sha256: createHash("sha256").update(bytes).digest("hex"),
                size: bytes.length,
              },
            ],
          },
        },
      };
      await f.run(
        f.sql`CREATE TRIGGER fail_native_result BEFORE INSERT ON expert_delegation_results BEGIN SELECT RAISE(ABORT, 'injected original transaction rollback'); END`,
      );
      await expect(
        f.protocol.handleRequest(OMP_NATIVE_EXPERT_METHODS.event, withArtifact),
      ).rejects.toThrow();
      expect(await f.resultEvents()).toHaveLength(0);
      expect(await f.run(f.common.readResult(prepared.attemptId))).toBeNull();
      const [pending] = await f.run(f.executions.pendingForParent(threadId));
      expect(pending?.acknowledgement).toBeNull();
      await fs.writeFile(
        path.join(prepared.profile.artifactRoot, "result.ts"),
        "new mutable version",
      );
      await f.run(f.sql`DROP TRIGGER fail_native_result`);
      const ack = Schema.decodeUnknownSync(OmpNativeTaskAck)(
        await f.protocol.handleRequest(OMP_NATIVE_EXPERT_METHODS.event, withArtifact),
      );
      // The first ACK can be lost by the transport. Replay must return the
      // original receipt without creating a new event, action or timestamp.
      expect(await f.protocol.handleRequest(OMP_NATIVE_EXPERT_METHODS.event, withArtifact)).toEqual(
        ack,
      );
      const events = await f.resultEvents();
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: "thread.expert-delegation-result",
        occurredAt: pending!.receivedAt,
        payload: { attemptId: prepared.attemptId, applyToParent: true },
      });
      const receipt = await f.run(
        f.artifacts.read({ attemptId: prepared.attemptId, artifactPath: "result.ts" }),
      );
      expect(Buffer.from(receipt.artifact!.content, "base64")).toEqual(bytes);
      expect(await f.run(f.executions.pendingForParent(threadId))).toHaveLength(0);
      expect((await f.run(f.common.readAttempt(prepared.attemptId)))?.appliedEventId).toBe(
        events[0]!.eventId,
      );
      await expect(
        f.protocol.handleRequest(OMP_NATIVE_EXPERT_METHODS.event, {
          ...withArtifact,
          payload: {
            ...withArtifact.payload,
            result: { ...withArtifact.payload.result, summary: "conflicting later result" },
          },
        }),
      ).rejects.toMatchObject({ data: { code: "result_conflict" } });
      expect(await f.resultEvents()).toHaveLength(1);
    } finally {
      await f.dispose();
    }
  });

  it("revokes and drains tools before pinning a terminal result, and a durable Stop wins even before live cancellation arrives", async () => {
    const f = await fixture();
    try {
      const input = f.request(f.author.expert.id, "stop-race");
      const prepared = await f.prepare(input);
      await f.start(prepared, input);
      const lease = await f.credential(prepared, input);
      const token = lease.authorization.slice("Bearer ".length);
      const identity = f.credentials.verifySession(token)!;
      const entered = Promise.withResolvers<void>(),
        release = Promise.withResolvers<void>();
      f.credentials.registerInFlightRequest({
        sessionKey: identity.sessionKey,
        turnId: prepared.attemptId,
        requestId: "running-tool",
        cancel: async () => {
          entered.resolve();
          await release.promise;
        },
      });
      const terminal = f.protocol.handleRequest(
        OMP_NATIVE_EXPERT_METHODS.event,
        f.terminal(prepared, input),
      );
      await entered.promise;
      expect(f.credentials.verifySession(token)).toBeNull();
      expect(await f.run(f.common.readResult(prepared.attemptId))).toBeNull();
      await f.run(
        f.engine.dispatch({
          type: "thread.turn.interrupt",
          commandId: CommandId.makeUnsafe("durable-stop-before-host"),
          threadId,
          turnId: TurnId.makeUnsafe(turnId),
          createdAt,
        }),
      );
      release.resolve();
      await terminal;
      expect((await f.resultEvents())[0]).toMatchObject({
        payload: { outcome: "completed", applyToParent: false },
      });
    } finally {
      await f.dispose();
    }
  });

  it("uses native-return as the only synchronous delivery and retains a single-task-cancel late result without stopping its sibling", async () => {
    const f = await fixture();
    try {
      const input = f.request(f.author.expert.id, "sync", "native-return"),
        siblingInput = f.request(f.reviewer.expert.id, "sibling");
      const prepared = await f.prepare(input),
        sibling = await f.prepare(siblingInput);
      await f.start(prepared, input);
      await f.start(sibling, siblingInput);
      await f.protocol.handleRequest(OMP_NATIVE_EXPERT_METHODS.event, f.terminal(prepared, input));
      await f.protocol.cancelTask(siblingInput.nativeTaskId);
      await f.protocol.handleRequest(
        OMP_NATIVE_EXPERT_METHODS.event,
        f.terminal(sibling, siblingInput),
      );
      const events = await f.resultEvents();
      expect(events).toHaveLength(2);
      for (const event of events)
        expect(event).toMatchObject({ payload: { outcome: "completed", applyToParent: false } });
      expect(
        f.requests
          .filter((request) => request.method === OMP_NATIVE_EXPERT_METHODS.cancel)
          .map(
            (request) =>
              Schema.decodeUnknownSync(OmpNativeTaskReference)(request.params).nativeTaskId,
          ),
      ).toEqual([siblingInput.nativeTaskId]);
    } finally {
      await f.dispose();
    }
  });

  it("recovers unknown without starting or pretending stopped, and accepts only original-session terminal proof after catalog cleanup", async () => {
    const f = await fixture();
    try {
      const input = f.request(f.author.expert.id, "recovery");
      const prepared = await f.prepare(input);
      const started = await f.start(prepared, input);
      const originalInitialization = (await f.runs.read(prepared.attemptId))?.initializationAttempt;
      const oldCatalog = f.protocol.agentDirectory;
      await f.protocol.close();
      await expect(fs.stat(oldCatalog)).rejects.toMatchObject({ code: "ENOENT" });
      expect((await f.run(f.common.readAttempt(prepared.attemptId)))?.state).toBe("unknown");
      const recovered = (await f.host.protocolFactory(f.context))!;
      await recovered.bindSession("recovered-actual-acp-session");
      expect((await f.run(f.common.readAttempt(prepared.attemptId)))?.state).toBe("unknown");
      expect((await f.runs.read(prepared.attemptId))?.initializationAttempt).toBe(
        originalInitialization,
      );
      await expect(
        f.prepare({ ...input, parentSessionId: "recovered-actual-acp-session" }, recovered),
      ).rejects.toThrow();
      await recovered.close();
      f.terminalProofs.set(prepared.attemptId, {
        nativeSessionId: started.nativeSessionId,
        terminalEvent: f.terminal(prepared, input),
      });
      const reconciled = (await f.host.protocolFactory(f.context))!;
      await reconciled.bindSession("terminal-recovery-acp-session");
      expect((await f.run(f.common.readAttempt(prepared.attemptId)))?.state).toBe("completed");
      expect((await f.resultEvents())[0]).toMatchObject({
        payload: { attemptId: prepared.attemptId, applyToParent: false },
      });
      expect(
        f.requests.every(
          (request) =>
            request.method === OMP_NATIVE_EXPERT_METHODS.query ||
            request.method === OMP_NATIVE_EXPERT_METHODS.cancel,
        ),
      ).toBe(true);
      await reconciled.close();
    } finally {
      await f.dispose();
    }
  });
  it("never marks a Run ready from a terminal result without the second actual-session initialization proof", async () => {
    const f = await fixture();
    try {
      const input = f.request(f.author.expert.id, "startup-ended", "native-return");
      const prepared = await f.prepare(input);
      await f.start(prepared, input, false);
      await f.protocol.handleRequest(OMP_NATIVE_EXPERT_METHODS.event, f.terminal(prepared, input));
      const assembly = await f.runs.read(prepared.attemptId);
      expect(assembly?.phase).not.toBe("ready");
      expect((await f.run(f.common.readAttempt(prepared.attemptId)))?.state).toBe("completed");
      await expect(f.prepare(input)).rejects.toMatchObject({ data: { code: "execution_unknown" } });
    } finally {
      await f.dispose();
    }
  });

  it("retires every old-generation lease before binding a replacement actual ACP session", async () => {
    const f = await fixture();
    try {
      const input = f.request(f.author.expert.id, "generation");
      const prepared = await f.prepare(input);
      await f.start(prepared, input);
      const first = await f.credential(prepared, input),
        second = await f.credential(prepared, input);
      const nextGeneration = "next-actual-generation";
      await f.run(
        f.sql`UPDATE provider_session_runtime SET lifecycle_generation = ${nextGeneration} WHERE thread_id = ${threadId}`,
      );
      const replacement = (await f.host.protocolFactory({
        ...f.context,
        generation: nextGeneration,
      }))!;
      for (const lease of [first, second])
        expect(f.credentials.verifySession(lease.authorization.slice("Bearer ".length))).toBeNull();
      expect((await f.run(f.common.readAttempt(prepared.attemptId)))?.state).toBe("unknown");
      await replacement.bindSession("next-actual-acp-session");
      await expect(f.credential(prepared, input)).rejects.toThrow();
      await replacement.close();
    } finally {
      await f.dispose();
    }
  });

  it("retains late authored results after parent deletion without admitting a continuation", async () => {
    const f = await fixture();
    try {
      const input = f.request(f.author.expert.id, "deleted-parent");
      const prepared = await f.prepare(input);
      await f.start(prepared, input);
      await f.run(
        f.engine.dispatch({
          type: "thread.delete",
          commandId: CommandId.makeUnsafe("delete-native-parent"),
          threadId,
        }),
      );
      await f.protocol.handleRequest(OMP_NATIVE_EXPERT_METHODS.event, f.terminal(prepared, input));
      expect(await f.run(f.common.readResult(prepared.attemptId))).toMatchObject({
        attemptId: prepared.attemptId,
        outcome: "completed",
      });
      expect((await f.resultEvents())[0]).toMatchObject({
        payload: { attemptId: prepared.attemptId, applyToParent: false },
      });
    } finally {
      await f.dispose();
    }
  });
  it("keeps an old asynchronous scope alive across natural parent completion and prompt refresh without propagating cancellation", async () => {
    const f = await fixture();
    try {
      const input = f.request(f.author.expert.id, "natural-end");
      const prepared = await f.prepare(input);
      await f.start(prepared, input);
      await f.run(
        f.engine.dispatch({
          type: "thread.session.set",
          commandId: CommandId.makeUnsafe("natural-parent-end"),
          threadId,
          session: {
            threadId,
            status: "idle",
            providerName: "omp",
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: createdAt,
          },
          createdAt,
        }),
      );
      await f.protocol.preparePrompt({
        sessionId: "actual-acp-session",
        parentTurnId: "next-actual-prompt",
        parentRootRunId: rootRunId,
      });
      await f.protocol.handleRequest(OMP_NATIVE_EXPERT_METHODS.event, f.terminal(prepared, input));
      expect((await f.resultEvents())[0]).toMatchObject({
        payload: { attemptId: prepared.attemptId, applyToParent: true },
      });
      expect(f.requests).toEqual([]);
    } finally {
      await f.dispose();
    }
  });
});
