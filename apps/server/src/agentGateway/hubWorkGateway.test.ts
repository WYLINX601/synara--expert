import * as SqlClient from "effect/unstable/sql/SqlClient";
import { assert, it } from "@effect/vitest";
import {
  MessageId,
  ProjectId,
  type ProviderKind,
  ThreadId,
  TurnId,
  DEFAULT_MODEL_BY_PROVIDER,
  type ExpertBinding,
  type ExpertDefinition,
  type ExpertSnapshot,
  type OrchestrationThread,
  type RuntimeMode,
  type SynaraCreateThreadsInput,
} from "@synara/contracts";
import { Effect, Layer, Option } from "effect";

import {
  HubWorkRepositoryError,
  HubWorkRepository,
} from "../persistence/Services/HubWorkRepository";
import { ProjectAgentRepository } from "../persistence/Services/ProjectAgentRepository";
import { HubWorkRepositoryLive } from "../persistence/Layers/HubWorkRepository";
import { ProjectAgentRepositoryLive } from "../persistence/Layers/ProjectAgentRepository";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite";
import type { ProjectAgentServiceShape } from "../projectAgent/Services/ProjectAgentService";
import { makeHubWorkGateway } from "./hubWorkGateway";
import { mcpToolResultError, mcpToolResultJson } from "./protocol";
import type { ToolContext } from "./toolRuntime";

const tests = it.layer(
  Layer.mergeAll(HubWorkRepositoryLive, ProjectAgentRepositoryLive).pipe(
    Layer.provideMerge(SqlitePersistenceMemory),
  ),
);
const now = "2026-10-02T10:00:00.000Z";
const turn = TurnId.makeUnsafe("human-turn");
const source = {
  id: MessageId.makeUnsafe("human-message"),
  role: "user",
  text: "Keep the API compatible.\nUse the attached requirements exactly.",
  attachments: [],
  turnId: turn,
  dispatchOrigin: "user",
  createdAt: now,
  updatedAt: now,
} as const;
function harness(name: string) {
  return Effect.gen(function* () {
    const repository = yield* HubWorkRepository;
    const projectAgentRepository = yield* ProjectAgentRepository;
    const projectId = ProjectId.makeUnsafe(name);
    const coordinator = ThreadId.makeUnsafe(`coordinator-${name}`);
    const context: ToolContext = {
      callerThreadId: coordinator,
      callerTurnId: turn,
      assertCallerTurnActive: () => Effect.void,
      callerThreadLabel: "Hub",
      callerSessionKey: "fixture",
      callerProvider: "codex",
      callerCapabilities: new Set(["thread:read", "thread:write"]),
      jsonRpcRequestId: 1,
      principal: {
        kind: "provider-session",
        sessionKey: "fixture",
        threadId: coordinator,
        provider: "codex",
        turnId: turn,
      },
    };
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO projection_projects (project_id, kind, title, workspace_root, scripts_json, created_at, updated_at)
      VALUES (${projectId}, 'group', 'Hub', '/tmp/hub', '[]', ${now}, ${now})`;
    yield* projectAgentRepository.saveConfig(
      {
        projectId,
        coordinatorThreadId: coordinator,
        coordinatorName: "Hub",
        expertIds: ["expert-v1"],
        coordinatorModelSelection: {
          provider: "codex",
          model: "fixture-model",
        },
        limits: {
          maxConcurrentWorkers: 1,
          maxNewWorkersPerTurn: 8,
          maxWorkerCreationsPerGoal: 40,
          maxAutomaticContinuationsPerGoal: 20,
          maxRepairRoundsPerTask: 2,
        },
        captureEnabled: true,
        enabled: true,
        automationId: null,
        revision: 1,
        createdAt: now,
        updatedAt: now,
        disabledAt: null,
        pausedAt: null,
        archivedAt: null,
      },
      null,
    );
    const calls: SynaraCreateThreadsInput[] = [];
    const inheritedModes: Array<RuntimeMode | undefined> = [];
    let runtimeMode: RuntimeMode = "approval-required";
    const messages = [source];
    let denyTarget = false;
    let failCreation = false;
    let cleanupPending = false;
    let failWithPendingCleanup = false;
    let brokenProject: string | null = null;
    type Dependencies = Parameters<typeof makeHubWorkGateway>[0];
    let expertRevision = 1;
    let expertArchived = false;
    let expertName = "Pinned Expert";
    let preferredProvider: ExpertDefinition["preferredProvider"] = "claudeAgent";
    let expertPreviewBlocked = false;
    const expertSnapshots = new Map<string, ExpertSnapshot>();
    const expertDefinition = (): ExpertDefinition => ({
      id: "expert-v1",
      name: expertName,
      description: "Fixture Expert",
      useCases: "Fixture",
      persona: "Fixture persona",
      outputRequirements: "Fixture output",
      skills: [],
      references: [],
      connections: [],
      ...(preferredProvider !== undefined ? { preferredProvider } : {}),
      revision: expertRevision,
      archived: expertArchived,
      updatedAt: now,
    });
    const expertStore: Dependencies["expertStore"] = {
      list: async () => [expertDefinition()],
      read: async (id) => (id === "expert-v1" ? expertDefinition() : null),
      preview: async () => ({
        definition: expertDefinition(),
        status: expertPreviewBlocked ? "blocked" : "available",
        issues: expertPreviewBlocked ? ["Required Expert resource is unavailable."] : [],
      }),
      prepareSnapshot: async (id) => {
        const definition = expertDefinition();
        if (id !== definition.id || definition.archived) throw new Error("Expert unavailable");
        const snapshotId = `snapshot-${definition.revision}`;
        const snapshot: ExpertSnapshot = {
          snapshotId,
          expertId: definition.id,
          displayName: definition.name,
          revision: definition.revision,
          description: definition.description,
          useCases: definition.useCases,
          persona: definition.persona,
          outputRequirements: definition.outputRequirements,
          skills: [],
          skillsRoot: "/fixture/skills",
          references: [],
          connections: [],
          preferredProvider: definition.preferredProvider,
          createdAt: now,
        };
        expertSnapshots.set(snapshotId, snapshot);
        return {
          expertId: definition.id,
          snapshotId,
          displayName: definition.name,
          revision: definition.revision,
        } satisfies ExpertBinding;
      },
      readSnapshot: async (snapshotId) => {
        const snapshot = expertSnapshots.get(snapshotId);
        if (!snapshot) throw new Error("Expert snapshot not found");
        return snapshot;
      },
    };
    const expertBindings: Array<ExpertBinding | undefined> = [];
    const dependencies = {
      repository: {
        ...repository,
        list: (id) =>
          id === brokenProject
            ? Effect.fail(
                new HubWorkRepositoryError({
                  code: "storage",
                  message: "damaged work record",
                }),
              )
            : repository.list(id),
      },
      creationOperations: {
        getByScope: () => Effect.succeed(cleanupPending ? { status: "compensating" } : null),
      } as unknown as NonNullable<Dependencies["creationOperations"]>,
      projectAgentRepository,
      projectAgentService: {
        resolvePrincipalForThread: () =>
          Effect.succeed({
            kind: "coordinator",
            threadId: coordinator,
            projectId,
          }),
        assertCallerMayCreateThreadInProject: () =>
          denyTarget ? Effect.fail(new Error("Repository was unlinked")) : Effect.void,
        notifyWorkItemChanged: () => Effect.void,
      } as unknown as ProjectAgentServiceShape,
      snapshotQuery: {
        getThreadShellById: () => Effect.succeed(Option.some({ id: coordinator, runtimeMode })),
        getThreadDetailById: () =>
          Effect.succeed(
            Option.some({
              id: coordinator,
              messages,
            } as unknown as OrchestrationThread),
          ),
        getProjectShellById: () =>
          Effect.succeed(
            Option.some({
              id: projectId,
              kind: "group",
              workspaceRoot: "/fixture",
            }),
          ),
      } as unknown as Dependencies["snapshotQuery"],
      attachments: {} as Dependencies["attachments"],
      serverConfig: {
        attachmentsDir: "/unused",
      } as Dependencies["serverConfig"],
      expertStore,
      providerDiscovery: {
        listModels: ({ provider }: { readonly provider: ProviderKind }) =>
          Effect.succeed({
            models: [
              {
                slug:
                  provider === "claudeAgent"
                    ? DEFAULT_MODEL_BY_PROVIDER.claudeAgent
                    : "fixture-model",
                name: "Fixture model",
              },
            ],
          }),
      } as unknown as Dependencies["providerDiscovery"],
      loadProviderAvailabilities: Effect.succeed(
        new Map([
          ["codex", { enabled: true }],
          ["claudeAgent", { enabled: true }],
        ]),
      ) as Dependencies["loadProviderAvailabilities"],
      git: {
        readBranchContext: () =>
          Effect.succeed({ isRepo: true, branch: "main", upstreamRef: null }),
      },
      createThreads: (input, creationContext) =>
        Effect.gen(function* () {
          yield* creationContext.assertAuthority();
          calls.push(input);
          inheritedModes.push(
            creationContext.kind === "hub-work" ? creationContext.inheritedRuntimeMode : undefined,
          );
          expertBindings.push(
            creationContext.kind === "hub-work" ? creationContext.expertBinding : undefined,
          );
          if (failWithPendingCleanup) {
            cleanupPending = true;
            return mcpToolResultError("Cleanup remains pending");
          }
          if (failCreation) return mcpToolResultError("Provider preflight failed");
          if (creationContext.kind !== "hub-work")
            throw new Error("Expected durable Hub authority");
          yield* creationContext.recordWorker(
            ThreadId.makeUnsafe(`worker-${name}-${calls.length}`),
          );
          return mcpToolResultJson({
            threadIds: [`worker-${name}-${calls.length}`],
          });
        }).pipe(Effect.catch((error) => Effect.succeed(mcpToolResultError(error.message)))),
    } satisfies Dependencies;
    const gateway = makeHubWorkGateway(dependencies);
    const input: SynaraCreateThreadsInput = {
      requestId: "first-request",
      threads: [1, 2].map((index) => ({
        prompt: `Task ${index}`,
        target: { provider: "codex", model: "fixture-model" },
      })),
    };
    return {
      gateway,
      messages,
      context,
      recreate: () => makeHubWorkGateway(dependencies),
      repository,
      projectAgentRepository,
      projectId,
      calls,
      inheritedModes,
      expertBindings,
      setRuntimeMode: (mode: RuntimeMode) => {
        runtimeMode = mode;
      },
      input,
      denyTarget: () => {
        denyTarget = true;
      },
      breakProject: (id: string) => {
        brokenProject = id;
      },
      failWithPendingCleanup: () => {
        failWithPendingCleanup = true;
      },
      setCleanupPending: (pending: boolean) => {
        cleanupPending = pending;
      },
      failCreation: () => {
        failCreation = true;
      },
      editExpert: (revision: number, name: string) => {
        expertRevision = revision;
        expertName = name;
      },
      archiveExpert: () => {
        expertArchived = true;
        expertRevision += 1;
      },
      setPreferredProvider: (provider: ExpertDefinition["preferredProvider"]) => {
        preferredProvider = provider;
      },
      blockExpertPreview: () => {
        expertPreviewBlocked = true;
      },
    };
  });
}

tests("Hub work gateway integration", (it) => {
  for (const count of [1, 2]) {
    it.effect(
      `snapshots Auto approval for ${count === 1 ? "single" : "batch and queued"} work`,
      () =>
        Effect.gen(function* () {
          const h = yield* harness(`approval-inheritance-${count}`);
          h.setRuntimeMode("auto");
          const result = yield* h.gateway.submit(
            { ...h.input, threads: h.input.threads.slice(0, count) },
            h.context,
          );
          assert.notEqual(result?.isError, true);
          const records = yield* h.repository.list(h.projectId);
          assert.equal(records.length, count);
          for (const record of records) {
            assert.equal(record.creationSpec.inheritedRuntimeMode, "auto");
            assert.equal(record.creationSpec.runtimeMode, undefined);
          }
          h.setRuntimeMode("full-access");
          yield* h.recreate().tick;
          assert.deepEqual(h.inheritedModes, ["auto"]);
          if (count === 2) {
            const first = (yield* h.repository.list(h.projectId)).find(
              (record) => record.workerThreadId !== null,
            )!;
            yield* h.gateway.service.setState({
              workItemId: first.id,
              state: "completed",
            });
            yield* h.recreate().tick;
            assert.deepEqual(h.inheritedModes, ["auto", "auto"]);
          }
        }),
    );
  }

  it.effect("preserves an explicit approval mode instead of inheriting Auto", () =>
    Effect.gen(function* () {
      const h = yield* harness("explicit-approval");
      h.setRuntimeMode("auto");
      yield* h.gateway.submit(
        {
          ...h.input,
          threads: [{ ...h.input.threads[0]!, runtimeMode: "approval-required" }],
        },
        h.context,
      );
      yield* h.gateway.tick;
      assert.equal(h.calls[0]!.threads[0]!.runtimeMode, "approval-required");
      assert.equal(h.inheritedModes[0], undefined);
    }),
  );

  it.effect(
    "queues above capacity, forwards canonical source, and replays across coordinator turns",
    () =>
      Effect.gen(function* () {
        const h = yield* harness("queue-integration");
        const accepted = yield* h.gateway.submit(h.input, h.context);
        assert.equal(accepted?.isError, undefined);
        yield* h.gateway.tick;
        assert.equal(h.calls.length, 1);
        assert.include(h.calls[0]!.threads[0]!.prompt, JSON.stringify(source.text));
        assert.include(h.calls[0]!.threads[0]!.prompt, "human-message");
        assert.equal(
          (yield* h.repository.list(h.projectId)).filter((record) => record.state === "queued")
            .length,
          1,
        );
        const replay = yield* h.recreate().submit(
          {
            ...h.input,
            requestId: "different-wake-id",
            threads: h.input.threads.map((spec) => ({
              ...spec,
              contextMessageIds: [source.id],
            })),
          },
          { ...h.context, callerTurnId: "another-turn" },
        );
        assert.equal(replay?.isError, undefined);
        yield* h.gateway.tick;
        assert.equal(h.calls.length, 1);
        const first = (yield* h.repository.list(h.projectId))[0]!;
        yield* h.gateway.service.setState({
          workItemId: first.id,
          state: "completed",
        });
        yield* h.gateway.tick;
        assert.equal(h.calls.length, 2);
      }),
  );

  it.effect(
    "resumes an admitted task after gateway reconstruction and releases failed starts",
    () =>
      Effect.gen(function* () {
        const h = yield* harness("restart-integration");
        yield* h.gateway.submit(h.input, h.context);
        const starting = yield* h.gateway.service.claimNext(h.projectId);
        assert.equal(starting?.state, "starting");
        h.failCreation();
        yield* h.recreate().tick;
        const records = yield* h.repository.list(h.projectId);
        assert.equal(
          records.every((record) => record.state === "failed" && !record.slotHeld),
          true,
        );
        assert.equal(h.calls.length, 2);
        yield* h.recreate().tick;
        assert.equal(h.calls.length, 2);
      }),
  );

  it.effect("continues admitting other Hubs when one Hub cannot be reconciled", () =>
    Effect.gen(function* () {
      const broken = yield* harness("aaa-broken");
      const healthy = yield* harness("zzz-healthy");
      yield* healthy.gateway.submit(healthy.input, healthy.context);
      healthy.breakProject(broken.projectId);
      yield* healthy.gateway.tick;
      assert.equal(healthy.calls.length, 1);
      assert.equal((yield* healthy.repository.list(healthy.projectId))[0]?.state, "working");
    }),
  );

  it.effect("does not release capacity when a failed creation leaves cleanup pending", () =>
    Effect.gen(function* () {
      const h = yield* harness("failed-cleanup-capacity");
      yield* h.gateway.submit(h.input, h.context);
      h.failWithPendingCleanup();
      yield* h.gateway.tick;
      const records = yield* h.repository.list(h.projectId);
      assert.equal(records[0]?.slotHeld, true);
      assert.equal(records[1]?.state, "queued");
      assert.equal(h.calls.length, 1);
      yield* h.recreate().tick;
      assert.equal(h.calls.length, 1);
    }),
  );

  it.effect(
    "holds capacity through incomplete compensation and releases only after durable cleanup",
    () =>
      Effect.gen(function* () {
        const h = yield* harness("pending-compensation");
        yield* h.gateway.submit(h.input, h.context);
        yield* h.gateway.service.claimNext(h.projectId);
        h.failCreation();
        h.setCleanupPending(true);
        yield* h.recreate().tick;
        const pending = yield* h.repository.list(h.projectId);
        assert.equal(pending[0]?.slotHeld, true);
        assert.equal(pending[1]?.state, "queued");
        assert.equal(h.calls.length, 0);
        h.setCleanupPending(false);
        yield* h.recreate().tick;
        assert.equal(
          (yield* h.repository.list(h.projectId)).every(
            (item) => item.state === "failed" && !item.slotHeld,
          ),
          true,
        );
      }),
  );

  it.effect("rechecks target authority before a queued task can dispatch", () =>
    Effect.gen(function* () {
      const h = yield* harness("target-revocation");
      yield* h.gateway.submit(h.input, h.context);
      h.denyTarget();
      yield* h.gateway.tick;
      assert.equal(h.calls.length, 0);
      assert.equal(
        (yield* h.repository.list(h.projectId)).every((record) => record.state === "failed"),
        true,
      );
    }),
  );

  it.effect("freezes Expert binding and preferred-provider target before queue replay", () =>
    Effect.gen(function* () {
      const h = yield* harness("expert-binding-freeze");
      const expertInput: SynaraCreateThreadsInput = {
        requestId: "expert-freeze-request",
        threads: [{ prompt: "Use the pinned Expert", expertId: "expert-v1" }],
      };
      const accepted = yield* h.gateway.submit(expertInput, h.context);
      assert.equal(accepted?.isError, undefined);
      const acceptedContent = accepted!.content[0]!;
      if (acceptedContent.type !== "text") throw new Error("Expected JSON Hub work result");
      const acceptedBody = JSON.parse(acceptedContent.text) as {
        readonly workItems: ReadonlyArray<{
          readonly expertBinding?: {
            readonly expertId: string;
            readonly displayName: string;
            readonly revision: number;
          };
        }>;
      };
      assert.deepEqual(acceptedBody.workItems[0]?.expertBinding, {
        expertId: "expert-v1",
        displayName: "Pinned Expert",
        revision: 1,
      });
      const frozen = (yield* h.repository.list(h.projectId))[0]!;
      assert.deepEqual(frozen.creationSpec.target, {
        provider: "claudeAgent",
        instanceId: "claudeAgent",
        model: DEFAULT_MODEL_BY_PROVIDER.claudeAgent,
      });
      assert.equal(frozen.creationSpec.expertBinding?.snapshotId, "snapshot-1");

      h.editExpert(2, "Renamed Expert");
      h.archiveExpert();
      const currentConfig = yield* h.projectAgentRepository.getConfig(h.projectId);
      if (Option.isSome(currentConfig))
        yield* h.projectAgentRepository.saveConfig(
          { ...currentConfig.value, expertIds: [], revision: currentConfig.value.revision + 1 },
          currentConfig.value.revision,
        );
      const replay = yield* h.recreate().submit(expertInput, h.context);
      assert.equal(replay?.isError, undefined);
      const replayContent = replay!.content[0]!;
      if (replayContent.type !== "text") throw new Error("Expected JSON Hub work result");
      const replayBody = JSON.parse(replayContent.text) as {
        readonly replayed: boolean;
        readonly workItems: ReadonlyArray<{
          readonly expertBinding?: {
            readonly expertId: string;
            readonly displayName: string;
            readonly revision: number;
          };
        }>;
      };
      assert.equal(replayBody.replayed, true);
      assert.deepEqual(replayBody.workItems[0]?.expertBinding, {
        expertId: "expert-v1",
        displayName: "Pinned Expert",
        revision: 1,
      });

      yield* h.recreate().tick;
      assert.deepEqual(h.expertBindings, [frozen.creationSpec.expertBinding]);
      assert.equal(h.calls[0]?.threads[0]?.target?.model, DEFAULT_MODEL_BY_PROVIDER.claudeAgent);
    }),
  );

  it.effect("rejects new Expert dispatch after roster removal but allows ordinary work", () =>
    Effect.gen(function* () {
      const h = yield* harness("expert-removed");
      const config = yield* h.projectAgentRepository.getConfig(h.projectId);
      if (Option.isSome(config))
        yield* h.projectAgentRepository.saveConfig(
          { ...config.value, expertIds: [], revision: config.value.revision + 1 },
          config.value.revision,
        );
      const rejected = yield* h.gateway.submit(
        { requestId: "unselected", threads: [{ prompt: "Must reject", expertId: "expert-v1" }] },
        h.context,
      );
      assert.equal(rejected?.isError, true);
      assert.equal((yield* h.repository.list(h.projectId)).length, 0);
      const ordinary = yield* h.gateway.submit(h.input, h.context);
      assert.equal(ordinary?.isError, undefined);
      yield* h.gateway.tick;
      assert.equal(h.expertBindings[0], undefined);
    }),
  );

  it.effect("rejects unavailable Expert preflight before accepting durable Hub work", () =>
    Effect.gen(function* () {
      const h = yield* harness("expert-preflight-rejected");
      h.blockExpertPreview();
      const result = yield* h.gateway.submit(
        {
          requestId: "expert-blocked",
          threads: [{ prompt: "Blocked Expert task", expertId: "expert-v1" }],
        },
        h.context,
      );
      assert.equal(result?.isError, true);
      assert.include(JSON.stringify(result), "Required Expert resource is unavailable.");
      assert.equal((yield* h.repository.list(h.projectId)).length, 0);
    }),
  );

  it.effect(
    "does not guess a preferred provider model when discovery has no configured default",
    () =>
      Effect.gen(function* () {
        const h = yield* harness("expert-no-default-model");
        h.setPreferredProvider("pi");
        const result = yield* h.gateway.submit(
          {
            requestId: "expert-no-default",
            threads: [{ prompt: "Needs an explicit model", expertId: "expert-v1" }],
          },
          h.context,
        );
        assert.equal(result?.isError, true);
        assert.include(JSON.stringify(result), "has no configured default model");
        assert.equal((yield* h.repository.list(h.projectId)).length, 0);
      }),
  );

  it.effect("requires a target for ordinary Hub workers", () =>
    Effect.gen(function* () {
      const h = yield* harness("plain-worker-target-required");
      const result = yield* h.gateway.submit(
        { requestId: "missing-target", threads: [{ prompt: "No target" }] },
        h.context,
      );
      assert.equal(result?.isError, true);
      assert.include(JSON.stringify(result), "A target is required for a plain worker.");
      assert.equal((yield* h.repository.list(h.projectId)).length, 0);
    }),
  );
  it.effect("keeps explicit old sources separate from implicit current sources in one batch", () =>
    Effect.gen(function* () {
      const h = yield* harness("mixed-context");
      const older = {
        ...source,
        id: MessageId.makeUnsafe("older-message"),
        turnId: TurnId.makeUnsafe("older-turn"),
      };
      h.messages.unshift(older);
      const input = {
        ...h.input,
        threads: [{ ...h.input.threads[0]!, contextMessageIds: [older.id] }, h.input.threads[1]!],
      };
      const accepted = yield* h.gateway.submit(input, h.context);
      assert.equal(accepted?.isError, undefined);
      const records = yield* h.repository.list(h.projectId);
      assert.deepEqual(
        records.map((record) => record.sourceMessages.map((message) => message.messageId)),
        [[older.id], [source.id]],
      );
    }),
  );
});
