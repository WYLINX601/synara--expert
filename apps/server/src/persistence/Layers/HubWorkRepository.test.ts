import {
  ProjectId,
  ThreadId,
  type CapabilityBinding,
  type HubWorkRecord,
  type SuiteComposition,
} from "@synara/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Exit, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { suiteContentDigest } from "../../suites/suiteIdentity";
import { HubWorkRepository, type HubWorkRepositoryShape } from "../Services/HubWorkRepository";
import { ProjectAgentRepository } from "../Services/ProjectAgentRepository";
import { HubWorkRepositoryLive } from "./HubWorkRepository";
import { ProjectAgentRepositoryLive } from "./ProjectAgentRepository";
import { SqlitePersistenceMemory } from "./Sqlite";

const layer = it.layer(
  Layer.mergeAll(HubWorkRepositoryLive, ProjectAgentRepositoryLive).pipe(
    Layer.provideMerge(SqlitePersistenceMemory),
  ),
);
const projectId = ProjectId.makeUnsafe("hub-queue");
const now = "2026-10-02T10:00:00.000Z";

function work(id: string, index: number): HubWorkRecord {
  return {
    id,
    projectId,
    targetProjectId: projectId,
    sourceThreadId: ThreadId.makeUnsafe("coordinator"),
    sourceMessageId: null,
    title: `Task ${index}`,
    workerThreadId: null,
    state: "queued",
    queueReason: "Waiting for capacity",
    resultSummary: null,
    progress: null,
    requestId: "request",
    scopeKey: "source",
    fingerprint: "plan",
    taskIndex: index,
    creationSpec: { prompt: `Task ${index}`, target: { provider: "codex", model: "gpt-5" } },
    sourceMessages: [],
    slotHeld: false,
    admittedAt: null,
    admissionCommandId: null,
    admissionMessageId: null,
    admissionPreviousState: null,
    admissionPreviousSlotHeld: false,
    revision: 0,
    createdAt: now,
    updatedAt: now,
  };
}

const submitWork = (
  repository: HubWorkRepositoryShape,
  records: readonly HubWorkRecord[],
  overrides: { readonly requestId?: string; readonly scopeKey?: string } = {},
) =>
  repository.submit({
    projectId: records[0]!.projectId,
    requestId: overrides.requestId ?? records[0]!.requestId,
    scopeKey: overrides.scopeKey ?? records[0]!.scopeKey,
    fingerprint: records[0]!.fingerprint,
    records,
  });

const configure = (hubId = projectId) =>
  Effect.gen(function* () {
    const repository = yield* ProjectAgentRepository;
    yield* repository.saveConfig(
      {
        projectId: hubId,
        coordinatorThreadId: ThreadId.makeUnsafe(`coordinator:${hubId}`),
        coordinatorName: "Hub",
        coordinatorModelSelection: { provider: "codex", model: "gpt-5" },
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
  });

layer("Hub work durable admission", (it) => {
  it.effect("lists all retained Hub history across projects for complete reference scans", () =>
    Effect.gen(function* () {
      const repository = yield* HubWorkRepository;
      const firstProject = ProjectId.makeUnsafe("inventory-hub-a");
      const secondProject = ProjectId.makeUnsafe("inventory-hub-b");
      const first = {
        ...work("inventory-work-a", 0),
        projectId: firstProject,
        targetProjectId: firstProject,
      };
      const second = {
        ...work("inventory-work-b", 0),
        projectId: secondProject,
        targetProjectId: secondProject,
        state: "cancelled" as const,
      };
      yield* repository.submit([first]);
      yield* repository.submit([second]);
      const all = yield* repository.listAll();
      assert.deepEqual(
        all.filter((record) => record.id.startsWith("inventory-work-")).map((record) => record.id),
        ["inventory-work-a", "inventory-work-b"],
      );
      assert.equal(all.find((record) => record.id === second.id)?.state, "cancelled");
    }),
  );

  it.effect(
    "enforces participant membership in the acceptance transaction and prioritizes replay",
    () =>
      Effect.gen(function* () {
        const hubId = ProjectId.makeUnsafe("guard-hub");
        yield* configure(hubId);
        const repository = yield* HubWorkRepository;
        const record = {
          ...work("guard-work", 0),
          projectId: hubId,
          creationSpec: {
            prompt: "Expert work",
            expertId: "unselected",
            target: { provider: "codex" as const, model: "gpt-5" },
          },
        };
        const rejected = yield* Effect.exit(
          repository.submit([record], { expectedConfigRevision: 1 }),
        );
        assert.equal(Exit.isFailure(rejected), true);
        assert.equal((yield* repository.list(hubId)).length, 0);
        // Simulates an already accepted historical record predating the roster feature.
        yield* repository.submit([record]);
        const replay = yield* repository.submit([record], { expectedConfigRevision: 999 });
        assert.equal(replay.replayed, true);
        assert.equal(replay.items[0]?.creationSpec.expertId, "unselected");
      }),
  );

  it.effect(
    "claims FIFO without oversubscribing concurrent starts and releases capacity durably",
    () =>
      Effect.gen(function* () {
        yield* configure();
        const repository = yield* HubWorkRepository;
        yield* submitWork(repository, [work("first", 0), work("second", 1)]);
        const claims = yield* Effect.all(
          [repository.claimNext(projectId), repository.claimNext(projectId)],
          { concurrency: 2 },
        );
        assert.equal(claims.filter(Boolean).length, 1);
        const first = claims.find((claim) => claim !== null)!;
        assert.equal(first.id, "first");
        assert.equal(first.slotHeld, true);
        yield* repository.save({
          record: {
            ...first,
            state: "completed",
            slotHeld: false,
            admittedAt: null,
            admissionCommandId: null,
            admissionMessageId: null,
            admissionPreviousState: null,
            admissionPreviousSlotHeld: false,
            revision: first.revision + 1,
          },
          expectedRevision: first.revision,
        });
        const second = yield* repository.claimNext(projectId);
        assert.equal(second?.id, "second");
        assert.equal(second?.state, "starting");
      }),
  );

  it.effect(
    "replays frozen requests, rejects changed plans, and preserves progress against stale writes",
    () =>
      Effect.gen(function* () {
        const repository = yield* HubWorkRepository;
        const record = { ...work("replay", 0), projectId: ProjectId.makeUnsafe("hub-replay") };
        yield* submitWork(repository, [record]);
        const replay = yield* submitWork(repository, [record]);
        assert.equal(replay.replayed, true);
        assert.deepEqual(
          replay.items.map((item) => item.id),
          [record.id],
        );
        // A frozen task is never forked by a retry that carries a different plan.
        const changed = yield* Effect.exit(
          submitWork(repository, [{ ...record, fingerprint: "changed" }]),
        );
        assert.equal(Exit.isFailure(changed), true);
        // The same request id may not be reused for a different source scope.
        const rescoped = yield* Effect.exit(
          submitWork(repository, [{ ...record, id: "rescoped", scopeKey: "other-source" }], {
            scopeKey: "other-source",
          }),
        );
        assert.equal(Exit.isFailure(rescoped), true);
        const saved = yield* repository.save({
          record: {
            ...record,
            revision: 1,
            progress: {
              revision: 1,
              steps: [{ id: "read", text: "Read source", status: "completed" }],
            },
          },
          expectedRevision: 0,
        });
        const stale = yield* Effect.exit(
          repository.save({
            record: { ...record, revision: 1, progress: null },
            expectedRevision: 0,
          }),
        );
        assert.equal(Exit.isFailure(stale), true);
        assert.deepEqual((yield* repository.get(record.id))?.progress, saved.progress);
      }),
  );

  it.effect("compares frozen specs across SQL reads, omitted optionals, and reordered keys", () =>
    Effect.gen(function* () {
      const repository = yield* HubWorkRepository;
      const sql = yield* SqlClient.SqlClient;
      const record: HubWorkRecord = {
        ...work("normalized-spec", 0),
        projectId: ProjectId.makeUnsafe("hub-normalized-spec"),
        creationSpec: {
          prompt: "Keep the original context",
          target: { provider: "codex", model: "gpt-5" },
          contextMessageIds: ["context-first", "context-second"],
        },
      };
      yield* submitWork(repository, [record]);
      const [raw] = yield* sql<{ readonly instanceId: string | null }>`
        SELECT json_extract(record_json, '$.creationSpec.target.instanceId') AS "instanceId"
        FROM project_agent_work_items WHERE work_item_id = ${record.id}
      `;
      assert.equal(raw?.instanceId, null);
      const loaded = yield* repository.get(record.id);
      assert.equal(loaded?.creationSpec.target.instanceId, "codex");
      const saved = yield* repository.save({
        record: {
          ...record,
          revision: 1,
          state: "waiting",
          creationSpec: {
            contextMessageIds: record.creationSpec.contextMessageIds,
            target: { model: "gpt-5", provider: "codex" },
            notifyCreatorOnComplete: undefined,
            prompt: record.creationSpec.prompt,
          },
        },
        expectedRevision: 0,
      });
      assert.equal(saved.creationSpec.target.instanceId, "codex");
      const reloaded = yield* repository.get(record.id);
      assert.deepEqual(reloaded, saved);
      const completed = yield* repository.save({
        record: { ...saved, state: "completed", revision: 2 },
        expectedRevision: 1,
      });
      const changedSpecs: readonly HubWorkRecord["creationSpec"][] = [
        { ...record.creationSpec, target: { provider: "codex", model: "different-model" } },
        { ...record.creationSpec, contextMessageIds: ["context-second", "context-first"] },
        { ...record.creationSpec, suite: null },
      ];
      for (const creationSpec of changedSpecs) {
        const rejected = yield* repository
          .save({
            record: { ...completed, creationSpec, revision: 3 },
            expectedRevision: 2,
          })
          .pipe(Effect.flip);
        assert.equal(rejected.code, "conflict");
        assert.equal(
          rejected.message,
          "Accepted Hub work cannot change its frozen creation binding.",
        );
      }
      assert.deepEqual(yield* repository.get(record.id), completed);
    }),
  );

  it.effect(
    "retains Suite identity and context through configuration changes and SQL round trips",
    () =>
      Effect.gen(function* () {
        const repository = yield* HubWorkRepository;
        const configRepository = yield* ProjectAgentRepository;
        const sql = yield* SqlClient.SqlClient;
        const hub = ProjectId.makeUnsafe("hub-frozen-suite-spec");
        const suite = { suiteId: "suite_00000000-0000-0000-0000-000000000002", revision: 1 };
        const content: Omit<SuiteComposition, "compositionHash" | "createdAt"> = {
          schemaVersion: 1,
          ref: suite,
          name: "Frozen Suite",
          description: "Preserve accepted work",
          source: {
            kind: "local-folder",
            sourceId: "/fixture/frozen-suite",
            contentHash: "a".repeat(64),
          },
          adapterId: "fixture",
          adapterVersion: 1,
          members: [{ key: "worker", expertId: "frozen-expert", roleSourcePath: null }],
          resources: [],
          defaults: {},
        };
        const composition: SuiteComposition = {
          ...content,
          compositionHash: suiteContentDigest(content),
          createdAt: now,
        };
        yield* sql`INSERT INTO suite_compositions(suite_id, revision, composition_hash, record_json)
        VALUES (${suite.suiteId}, ${suite.revision}, ${composition.compositionHash}, ${JSON.stringify(composition)})`;
        yield* configRepository.beginSuiteOnboarding(hub);
        yield* configure(hub);
        const configured = yield* configRepository.getConfig(hub);
        if (configured._tag !== "Some") throw new Error("Expected configured hub");
        yield* configRepository.saveConfig({ ...configured.value, suite, revision: 2 }, 1);
        const record: HubWorkRecord = {
          ...work("suite-spec-roundtrip", 0),
          projectId: hub,
          targetProjectId: hub,
          creationSpec: {
            prompt: "Use the frozen Suite and context",
            target: { provider: "codex", model: "gpt-5" },
            expertId: "frozen-expert",
            expertBinding: {
              expertId: "frozen-expert",
              snapshotId: "snapshot:original",
              displayName: "Frozen Expert",
              revision: 1,
            },
            capabilityBindingId: "binding:frozen-suite-spec",
            suite,
            contextMessageIds: ["context:v1"],
          },
        };
        const bindingContent: Pick<
          CapabilityBinding,
          "suite" | "purpose" | "projectId" | "connections" | "mcpBinding"
        > = {
          suite,
          purpose: {
            kind: "hub-worker",
            hubId: hub,
            workId: record.id,
            hubConfigRevision: 2,
            expertSnapshotId: "snapshot:original",
          },
          projectId: hub,
          connections: [],
          mcpBinding: null,
        };
        const binding: CapabilityBinding = {
          ...bindingContent,
          schemaVersion: 1,
          bindingId: "binding:frozen-suite-spec",
          bindingHash: suiteContentDigest(bindingContent),
          createdAt: now,
        };
        yield* sql`INSERT INTO suite_capability_bindings(binding_id, binding_hash, record_json)
        VALUES (${binding.bindingId}, ${binding.bindingHash}, ${JSON.stringify(binding)})`;
        yield* repository.submit({
          projectId: hub,
          requestId: record.requestId,
          scopeKey: record.scopeKey,
          fingerprint: record.fingerprint,
          records: [record],
          admission: { expectedConfigRevision: 2 },
        });
        yield* configRepository.saveConfig(
          {
            ...configured.value,
            suite,
            coordinatorName: "Updated Hub",
            coordinatorModelSelection: { provider: "codex", model: "new-default-model" },
            revision: 3,
          },
          2,
        );
        const saved = yield* repository.save({
          record: { ...record, revision: 1, state: "waiting" },
          expectedRevision: 0,
        });
        assert.deepEqual(yield* repository.get(record.id), saved);
        assert.deepEqual(saved.creationSpec.suite, suite);
        assert.equal(saved.creationSpec.capabilityBindingId, binding.bindingId);
        assert.equal(saved.creationSpec.expertBinding?.snapshotId, "snapshot:original");
        assert.deepEqual(saved.creationSpec.contextMessageIds, ["context:v1"]);
        const expertBinding = saved.creationSpec.expertBinding;
        if (!expertBinding) throw new Error("Expected frozen Expert binding");
        const changedSpecs: readonly HubWorkRecord["creationSpec"][] = [
          { ...saved.creationSpec, suite: { ...suite, revision: 2 } },
          { ...saved.creationSpec, suite: null },
          { ...saved.creationSpec, capabilityBindingId: "binding:replacement" },
          {
            ...saved.creationSpec,
            expertBinding: { ...expertBinding, snapshotId: "snapshot:replacement" },
          },
          { ...saved.creationSpec, expertBinding: { ...expertBinding, revision: 2 } },
          { ...saved.creationSpec, contextMessageIds: ["context:v2"] },
        ];
        for (const creationSpec of changedSpecs) {
          const rejected = yield* repository
            .save({
              record: { ...saved, creationSpec, revision: 2 },
              expectedRevision: 1,
            })
            .pipe(Effect.flip);
          assert.equal(rejected.code, "conflict");
          assert.equal(
            rejected.message,
            "Accepted Hub work cannot change its frozen creation binding.",
          );
        }
        assert.deepEqual(yield* repository.get(record.id), saved);
      }),
  );

  it.effect(
    "appends concurrently prepared task keys without colliding at their provisional index",
    () =>
      Effect.gen(function* () {
        const repository = yield* HubWorkRepository;
        const hub = ProjectId.makeUnsafe("hub-concurrent-plans");
        const alpha = {
          ...work("alpha", 0),
          projectId: hub,
          taskKey: "alpha",
          taskFingerprint: "alpha-plan",
        };
        const beta = {
          ...alpha,
          id: "beta",
          taskKey: "beta",
          taskFingerprint: "beta-plan",
          requestId: "beta-request",
          fingerprint: "beta-request-plan",
        };
        // Both plans were prepared before either transaction allocated its index.
        const appended = yield* Effect.all(
          [submitWork(repository, [alpha]), submitWork(repository, [beta])],
          { concurrency: 2 },
        );
        assert.equal(
          appended.every((result) => !result.replayed),
          true,
        );
        const stored = yield* repository.list(hub);
        assert.deepEqual(stored.map((record) => record.id).toSorted(), ["alpha", "beta"]);
        assert.deepEqual(stored.map((record) => record.taskIndex).toSorted(), [0, 1]);
        // Retrying one exact request must not expand it to a different key set.
        const changedRequest = yield* Effect.exit(
          submitWork(repository, [
            {
              ...beta,
              id: "gamma",
              taskKey: "gamma",
              taskFingerprint: "gamma-plan",
              fingerprint: "gamma-request-plan",
            },
          ]),
        );
        assert.equal(Exit.isFailure(changedRequest), true);
        assert.equal((yield* repository.list(hub)).length, 2);
      }),
  );

  it.effect("rejects an incompatible decision prepared before another request froze its key", () =>
    Effect.gen(function* () {
      const repository = yield* HubWorkRepository;
      const original = {
        ...work("frozen-key", 0),
        projectId: ProjectId.makeUnsafe("hub-frozen-decision"),
        taskKey: "alpha",
        taskFingerprint: "original-plan",
      };
      yield* submitWork(repository, [original]);
      const changed = yield* Effect.exit(
        submitWork(repository, [
          {
            ...original,
            requestId: "concurrent-decision",
            taskFingerprint: "different-plan",
            creationSpec: { ...original.creationSpec, prompt: "Different work" },
          },
        ]),
      );
      assert.equal(Exit.isFailure(changed), true);
      assert.equal(
        (yield* repository.get(original.id))?.creationSpec.prompt,
        original.creationSpec.prompt,
      );
    }),
  );

  it.effect("never starts cancelled work or paused hubs", () =>
    Effect.gen(function* () {
      const repository = yield* HubWorkRepository;
      const configRepository = yield* ProjectAgentRepository;
      const pausedHub = ProjectId.makeUnsafe("hub-paused");
      yield* configure(pausedHub);
      const record = {
        ...work("cancelled", 0),
        projectId: pausedHub,
        targetProjectId: pausedHub,
        scopeKey: "cancelled",
      };
      yield* submitWork(repository, [record]);
      yield* repository.save({
        record: { ...record, revision: 1, state: "cancelled" },
        expectedRevision: 0,
      });
      assert.equal(yield* repository.claimNext(pausedHub), null);
      yield* submitWork(
        repository,
        [
          {
            ...work("paused", 0),
            projectId: pausedHub,
            targetProjectId: pausedHub,
            scopeKey: "paused",
            requestId: "paused-request",
          },
        ],
        { requestId: "paused-request", scopeKey: "paused" },
      );
      const existing = yield* configRepository.getConfig(pausedHub);
      if (existing._tag !== "Some") throw new Error("Expected configured hub");
      yield* configRepository.saveConfig(
        { ...existing.value, pausedAt: now, revision: existing.value.revision + 1 },
        existing.value.revision,
      );
      assert.equal(yield* repository.claimNext(pausedHub), null);
      assert.equal((yield* repository.get("cancelled"))?.state, "cancelled");
    }),
  );
  it.effect("re-admits an idle worker under the same atomic capacity boundary", () =>
    Effect.gen(function* () {
      const hub = ProjectId.makeUnsafe("hub-followup");
      yield* configure(hub);
      const repository = yield* HubWorkRepository;
      const first = {
        ...work("followup", 0),
        projectId: hub,
        targetProjectId: hub,
        workerThreadId: ThreadId.makeUnsafe("followup-worker"),
        state: "idle" as const,
      };
      const queued = { ...work("competing", 1), projectId: hub, targetProjectId: hub };
      yield* submitWork(repository, [first, queued]);
      const admitted = yield* repository.reserveWorker({
        threadId: first.workerThreadId,
        commandId: "followup-command",
        messageId: "followup-message",
      });
      assert.equal(admitted?.slotHeld, true);
      assert.equal(admitted?.admissionPreviousSlotHeld, false);
      assert.equal(admitted?.admissionPreviousState, "idle");
      assert.equal(yield* repository.claimNext(hub), null);
      yield* repository.save({
        record: { ...admitted!, state: "working", revision: admitted!.revision + 1 },
        expectedRevision: admitted!.revision,
      });
      const continuing = yield* repository.reserveWorker({
        threadId: first.workerThreadId,
        commandId: "next-command",
        messageId: "next-message",
      });
      assert.equal(continuing?.admissionPreviousSlotHeld, true);
      assert.equal(yield* repository.claimNext(hub), null);
    }),
  );
});
