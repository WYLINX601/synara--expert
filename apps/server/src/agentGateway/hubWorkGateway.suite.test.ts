import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  DEFAULT_PROJECT_AGENT_LIMITS,
  MessageId,
  ProjectId,
  ThreadId,
  TurnId,
  type ExpertProviderKind,
  type ModelSelection,
  type ProjectAgentConfig,
  type SuiteComposition,
  type SynaraCreateThreadsInput,
} from "@synara/contracts";
import { Effect, Layer, ManagedRuntime, Option, Stream } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { expect, it } from "vitest";

import { ServerConfig } from "../config";
import { GitCoreLive } from "../git/Layers/GitCore";
import { GitCore } from "../git/Services/GitCore";
import { OrchestrationLayerLive } from "../orchestration/runtimeLayer";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery";
import { HubWorkRepositoryLive } from "../persistence/Layers/HubWorkRepository";
import { ProjectAgentRepositoryLive } from "../persistence/Layers/ProjectAgentRepository";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite";
import { HubWorkRepository } from "../persistence/Services/HubWorkRepository";
import { ManagedAttachmentRepository } from "../persistence/Services/ManagedAttachments";
import { ProjectAgentRepository } from "../persistence/Services/ProjectAgentRepository";
import type { ProjectAgentServiceShape } from "../projectAgent/Services/ProjectAgentService";
import type { ProviderDiscoveryServiceShape } from "../provider/Services/ProviderDiscoveryService";
import { ServerSettingsService } from "../serverSettings";
import { SuiteBindingResolver } from "../suites/SuiteBindingResolver";
import { SuiteCompositionStore } from "../suites/SuiteCompositionStore";
import { SuiteRuntimeLayerLive } from "../suites/runtimeLayer";
import { suiteContentDigest } from "../suites/suiteIdentity";
import { WorkbenchExpertRuntime } from "../workbench/runtimeLayer";
import { AgentGatewayOperationRepositoryLive } from "./Layers/AgentGatewayOperationRepository";
import { AgentGatewayOperationRepository } from "./Services/AgentGatewayOperationRepository";
import { makeCreateThreadsHandler } from "./creationCoordinator";
import { makeHubWorkGateway } from "./hubWorkGateway";
import { readHubExpertCatalog } from "./hubExpertCatalog";
import { ToolInputError } from "./toolInput";
import type { ToolContext } from "./toolRuntime";
import { readonlyResourceTestConfigLayer } from "../experts/expertResourceTestFixtures";

type ExpertTarget = ModelSelection & { readonly provider: ExpertProviderKind };

interface TargetCase {
  readonly name: string;
  readonly suite: boolean;
  readonly callerTarget: ModelSelection;
  readonly savedTarget?: ExpertTarget;
  readonly explicitTarget?: ModelSelection;
  readonly consumer: "dispatch" | "catalogue";
  readonly supported: boolean;
  readonly freeze?: boolean;
}

const fixtureTarget = (provider: ExpertProviderKind): ExpertTarget => ({
  provider,
  model: "fixture-model",
});
const unsupportedSuiteProviders = ["codex", "pi", "claudeAgent"] as const;
const targetCases: TargetCase[] = [
  {
    name: "creates a queued Suite worker from its original accepted binding after Expert and Hub edits",
    suite: true,
    callerTarget: fixtureTarget("omp"),
    savedTarget: fixtureTarget("omp"),
    consumer: "dispatch",
    supported: true,
    freeze: true,
  },
  {
    name: "accepts explicit OMP without replacing the saved unsupported Suite model",
    suite: true,
    callerTarget: fixtureTarget("codex"),
    savedTarget: fixtureTarget("pi"),
    explicitTarget: fixtureTarget("omp"),
    consumer: "dispatch",
    supported: true,
  },
  {
    name: "advertises supported OMP Suite members without binding or accepting work",
    suite: true,
    callerTarget: fixtureTarget("omp"),
    consumer: "catalogue",
    supported: true,
  },
];
for (const [source, provider] of [
  ["caller", "codex"],
  ["saved", "pi"],
  ["explicit", "claudeAgent"],
] as const) {
  for (const consumer of ["dispatch", "catalogue"] as const) {
    // The catalogue diagnoses the default target, not an explicit dispatch override.
    if (source === "explicit" && consumer === "catalogue") continue;
    targetCases.push({
      name: `${consumer} rejects ${source} ${provider} Suite target before accepted work or a fixed spec`,
      suite: true,
      callerTarget: fixtureTarget(source === "caller" ? provider : "omp"),
      ...(source === "saved" ? { savedTarget: fixtureTarget(provider) } : {}),
      ...(source === "explicit"
        ? { savedTarget: fixtureTarget("omp"), explicitTarget: fixtureTarget(provider) }
        : {}),
      consumer,
      supported: false,
    });
  }
}
for (const consumer of ["dispatch", "catalogue"] as const) {
  targetCases.push({
    name: `${consumer} preserves ordinary non-Suite codex Experts`,
    suite: false,
    callerTarget: fixtureTarget("omp"),
    savedTarget: fixtureTarget("codex"),
    consumer,
    supported: true,
  });
}

it.each(targetCases)("$name", async (testCase) => {
  const layer = OrchestrationLayerLive.pipe(
    Layer.provideMerge(SuiteRuntimeLayerLive),
    Layer.provideMerge(ProjectAgentRepositoryLive),
    Layer.provideMerge(HubWorkRepositoryLive),
    Layer.provideMerge(AgentGatewayOperationRepositoryLive),
    Layer.provideMerge(GitCoreLive),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(ServerSettingsService.layerTest()),
    Layer.provideMerge(readonlyResourceTestConfigLayer("hub-suite-worker-")),
    Layer.provideMerge(NodeServices.layer),
  );
  const runtime = ManagedRuntime.make(layer);
  try {
    await runtime.runPromise(
      Effect.gen(function* () {
        const config = yield* ServerConfig;
        const engine = yield* OrchestrationEngineService;
        const snapshots = yield* ProjectionSnapshotQuery;
        const projects = yield* ProjectAgentRepository;
        const work = yield* HubWorkRepository;
        const operations = yield* AgentGatewayOperationRepository;
        const attachments = yield* ManagedAttachmentRepository;
        const git = yield* GitCore;
        const sql = yield* SqlClient.SqlClient;
        const assets = yield* WorkbenchExpertRuntime;
        const suites = yield* SuiteCompositionStore;
        const bindings = yield* SuiteBindingResolver;
        const now = new Date().toISOString();
        const projectId = ProjectId.makeUnsafe("frozen-suite-hub");
        const coordinator = ThreadId.makeUnsafe("frozen-suite-coordinator");
        const humanMessageId = MessageId.makeUnsafe("frozen-suite-human-message");
        const expert = yield* Effect.promise(() =>
          assets.experts.save({
            id: "frozen-suite-author",
            name: "Original author",
            description: "",
            useCases: "",
            persona: "Write the original requested deliverable.",
            outputRequirements: "",
            skills: [],
            references: [],
            connections: [],
            ...(testCase.savedTarget
              ? {
                  preferredProvider: testCase.savedTarget.provider,
                  defaultModelSelection: testCase.savedTarget,
                }
              : {}),
          }),
        );
        const content = {
          schemaVersion: 1 as const,
          ref: { suiteId: "suite_00000000-0000-0000-0000-000000000064", revision: 1 },
          name: "Frozen Suite",
          description: "",
          source: {
            kind: "local-folder" as const,
            sourceId: "frozen-fixture",
            contentHash: "a".repeat(64),
          },
          adapterId: "fixture",
          adapterVersion: 1,
          members: [{ key: "author", expertId: expert.id, roleSourcePath: null }],
          resources: [],
          defaults: {},
        };
        const composition: SuiteComposition = {
          ...content,
          compositionHash: suiteContentDigest(content),
          createdAt: now,
        };
        yield* sql`INSERT INTO suite_compositions(suite_id, revision, composition_hash, record_json)
        VALUES (${composition.ref.suiteId}, 1, ${composition.compositionHash}, ${JSON.stringify(composition)})`;
        yield* engine.dispatch({
          type: "project.create",
          commandId: CommandId.makeUnsafe("frozen-suite-project"),
          projectId,
          kind: "group",
          title: "Hub",
          workspaceRoot: config.stateDir,
          createdAt: now,
        });
        const hub: ProjectAgentConfig = {
          projectId,
          ...(testCase.suite ? { suite: composition.ref } : { expertIds: [expert.id] }),
          coordinatorThreadId: coordinator,
          coordinatorName: "Coordinator",
          coordinatorModelSelection: testCase.callerTarget,
          limits: { ...DEFAULT_PROJECT_AGENT_LIMITS },
          captureEnabled: true,
          enabled: true,
          automationId: null,
          revision: 1,
          createdAt: now,
          updatedAt: now,
          disabledAt: null,
          pausedAt: null,
          archivedAt: null,
        };
        yield* projects.saveConfig(hub, null);
        yield* engine.dispatch({
          type: "thread.create",
          commandId: CommandId.makeUnsafe("frozen-suite-coordinator-create"),
          threadId: coordinator,
          projectId,
          title: "Coordinator",
          modelSelection: hub.coordinatorModelSelection,
          runtimeMode: "approval-required",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt: now,
        });
        yield* engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.makeUnsafe("frozen-suite-human-turn"),
          threadId: coordinator,
          message: {
            messageId: humanMessageId,
            role: "user",
            text: "Write a compatible deliverable.",
            attachments: [],
          },
          runtimeMode: "approval-required",
          interactionMode: "default",
          createdAt: now,
        });
        yield* engine.dispatch({
          type: "thread.message.user.bind-turn",
          commandId: CommandId.makeUnsafe("frozen-suite-bind-human-turn"),
          threadId: coordinator,
          messageId: humanMessageId,
          turnId: TurnId.makeUnsafe("fixture-native-coordinator-turn"),
          createdAt: now,
        });
        const detail = Option.getOrThrow(yield* snapshots.getThreadDetailById(coordinator));
        const humanMessage = detail.messages.find((message) => message.id === humanMessageId)!;
        expect(humanMessage.turnId).not.toBeNull();
        // Only model discovery and caller authorization are boundary fixtures;
        // acceptance, snapshots, queue, creation saga, engine and SQL are real.
        const discovery = {
          listModels: () =>
            Effect.succeed({ models: [{ slug: "fixture-model", name: "Fixture" }] }),
        } as unknown as ProviderDiscoveryServiceShape;
        const availabilities = Effect.succeed(
          new Map(
            (["omp", ...unsupportedSuiteProviders] as const).map((provider) => [
              provider,
              { enabled: true, available: true },
            ]),
          ),
        );
        const projectAgentService = {
          resolvePrincipalForThread: () =>
            Effect.succeed({ kind: "coordinator", projectId, threadId: coordinator }),
          assertCallerMayCreateThreadInProject: () => Effect.void,
        } as unknown as ProjectAgentServiceShape;
        const requireThreadShell = (id: string) =>
          snapshots.getThreadShellById(ThreadId.makeUnsafe(id)).pipe(
            Effect.flatMap((thread) =>
              Option.isSome(thread)
                ? Effect.succeed(thread.value)
                : Effect.fail(new ToolInputError("Thread not found.")),
            ),
            Effect.mapError((cause) =>
              cause instanceof ToolInputError ? cause : new ToolInputError("Thread read failed."),
            ),
          );
        const createThreads = yield* makeCreateThreadsHandler({
          snapshotQuery: snapshots,
          orchestrationEngine: engine,
          git,
          providerDiscovery: discovery,
          operationRepository: operations,
          serverConfig: config,
          loadProviderAvailabilities: availabilities,
          requireThreadShell,
        });
        const dependencies = {
          repository: work,
          creationOperations: operations,
          projectAgentRepository: projects,
          projectAgentService,
          snapshotQuery: snapshots,
          attachments,
          serverConfig: config,
          expertStore: assets.experts,
          suiteStore: suites,
          prepareSuiteBinding: bindings.prepare,
          providerDiscovery: discovery,
          loadProviderAvailabilities: availabilities,
          git,
          createThreads,
        };
        const gateway = makeHubWorkGateway(dependencies);
        const context: ToolContext = {
          callerThreadId: coordinator,
          callerTurnId: humanMessage.turnId,
          assertCallerTurnActive: () => Effect.void,
          callerThreadLabel: "Coordinator",
          callerSessionKey: "fixture",
          callerProvider: "omp",
          callerCapabilities: new Set(["thread:read", "thread:write"]),
          jsonRpcRequestId: 1,
          principal: {
            kind: "provider-session",
            sessionKey: "fixture",
            provider: "omp",
            threadId: coordinator,
            turnId: humanMessage.turnId,
          },
        };
        if (testCase.consumer === "catalogue") {
          const candidates = yield* readHubExpertCatalog({
            projectId,
            assertTarget: () => Effect.void,
            snapshotQuery: snapshots,
            loadConfig: () => Effect.succeed(hub),
            dependencies,
          });
          expect(candidates).toHaveLength(1);
          expect(candidates[0]).toMatchObject({
            expertId: expert.id,
            origin: testCase.suite ? "suite" : "roster",
            available: testCase.supported,
          });
          if (!testCase.supported)
            expect(candidates[0]?.issues).toEqual([
              expect.objectContaining({
                code: "unsupported_capability",
                action: "dispatch",
                effect: "deny-action",
              }),
            ]);
          expect(yield* work.list(projectId)).toEqual([]);
          return;
        }
        const request: SynaraCreateThreadsInput = {
          requestId: "frozen-suite-work",
          threads: [
            {
              expertId: expert.id,
              prompt: "Produce the deliverable",
              contextMessageIds: [humanMessageId],
              environment: "local" as const,
              ...(testCase.explicitTarget ? { target: testCase.explicitTarget } : {}),
            },
          ],
        };
        const result = yield* gateway.submit(request, context);
        if (!testCase.supported) {
          expect(yield* work.list(projectId)).toEqual([]);
          expect(result?.isError).toBe(true);
          return;
        }
        expect(result?.isError).not.toBe(true);
        const accepted = (yield* work.list(projectId))[0]!;
        expect(accepted.state).toBe("queued");
        expect(accepted.creationSpec.target).toMatchObject(
          testCase.explicitTarget ?? testCase.savedTarget ?? testCase.callerTarget,
        );
        expect(yield* Effect.promise(() => assets.experts.read(expert.id))).toEqual(expert);
        if (!testCase.freeze) {
          if (testCase.suite) {
            expect(accepted.creationSpec.suite).toEqual(composition.ref);
            expect(
              yield* suites.readBinding(accepted.creationSpec.capabilityBindingId!),
            ).not.toBeNull();
          } else {
            expect(accepted.creationSpec.suite).toBeUndefined();
            expect(accepted.creationSpec.capabilityBindingId).toBeUndefined();
            expect(accepted.creationSpec.expertBinding?.expertId).toBe(expert.id);
          }
          return;
        }
        expect(accepted.creationSpec.suite).toEqual(composition.ref);
        const acceptedBinding = yield* suites.readBinding(
          accepted.creationSpec.capabilityBindingId!,
        );
        expect(acceptedBinding?.purpose).toEqual({
          kind: "hub-worker",
          hubId: projectId,
          workId: accepted.id,
          hubConfigRevision: 1,
          expertSnapshotId: accepted.creationSpec.expertBinding!.snapshotId,
        });
        yield* Effect.promise(() =>
          assets.experts.save({
            ...expert,
            name: "Edited author",
            persona: "Edited after acceptance.",
            preferredProvider: "codex",
            defaultModelSelection: { provider: "codex", model: "edited-fixture-model" },
            expectedRevision: expert.revision,
          }),
        );
        yield* projects.saveConfig({ ...hub, coordinatorName: "Edited Hub", revision: 2 }, 1);
        // Recreate the queue consumer, rather than relying on its previous closures.
        yield* makeHubWorkGateway(dependencies).tick;
        const started = (yield* work.list(projectId))[0]!;
        expect(started.workerThreadId).not.toBeNull();
        expect(started.state).toBe("working");
        const workerId = started.workerThreadId!;
        const worker = Option.getOrThrow(yield* snapshots.getThreadShellById(workerId));
        expect(worker.expertBinding).toEqual(accepted.creationSpec.expertBinding);
        expect(worker.capabilityBindingId).toBe(accepted.creationSpec.capabilityBindingId);
        expect(worker.suiteSelection).toEqual(composition.ref);
        expect(worker.modelSelection).toMatchObject(expert.defaultModelSelection!);
        const snapshot = yield* Effect.promise(() =>
          assets.experts.readSnapshot(worker.expertBinding!.snapshotId),
        );
        expect(snapshot.persona).toBe(expert.persona);
        expect(snapshot.displayName).toBe("Original author");
        expect(snapshot.preferredProvider).toBe(expert.preferredProvider);
        expect(snapshot.defaultModelSelection).toMatchObject(expert.defaultModelSelection!);
        const eventsBefore = yield* Stream.runCollect(engine.readThreadEvents(workerId, 0));
        expect(eventsBefore.filter((event) => event.type === "thread.created")).toHaveLength(1);
        expect(
          eventsBefore.filter((event) => event.type === "thread.turn-start-requested"),
        ).toHaveLength(1);
        expect((yield* gateway.submit(request, context))?.isError).not.toBe(true);
        yield* makeHubWorkGateway(dependencies).tick;
        expect((yield* work.list(projectId))[0]?.workerThreadId).toBe(workerId);
        expect(yield* Stream.runCollect(engine.readThreadEvents(workerId, 0))).toEqual(
          eventsBefore,
        );
      }),
    );
  } finally {
    await runtime.dispose();
  }
});
