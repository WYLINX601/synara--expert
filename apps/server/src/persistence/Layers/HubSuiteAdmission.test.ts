import {
  DEFAULT_PROJECT_AGENT_LIMITS,
  ProjectId,
  ThreadId,
  type CapabilityBinding,
  type HubWorkRecord,
  type ProjectAgentConfig,
  type SuiteComposition,
} from "@synara/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Exit, Layer, Option } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { capabilityBindingFingerprint } from "../../suites/SuiteCompositionStore";
import { suiteContentDigest } from "../../suites/suiteIdentity";
import { HubWorkRepository } from "../Services/HubWorkRepository";
import { ProjectAgentRepository } from "../Services/ProjectAgentRepository";
import { HubWorkRepositoryLive } from "./HubWorkRepository";
import { ProjectAgentRepositoryLive } from "./ProjectAgentRepository";
import { SqlitePersistenceMemory } from "./Sqlite";

const tests = it.layer(
  Layer.mergeAll(ProjectAgentRepositoryLive, HubWorkRepositoryLive).pipe(
    Layer.provideMerge(SqlitePersistenceMemory),
  ),
);
const now = "2026-11-11T00:00:00.000Z";
const suiteId = "suite_00000000-0000-0000-0000-000000000001";

function composition(revision: number): SuiteComposition {
  const content = {
    schemaVersion: 1 as const,
    ref: { suiteId, revision },
    name: "Hub Suite",
    description: "Shared methods",
    source: {
      kind: "local-folder" as const,
      sourceId: "/fixture/suite",
      contentHash: "a".repeat(64),
    },
    adapterId: "fixture",
    adapterVersion: 1,
    members: [{ key: "research", expertId: "suite-research", roleSourcePath: null }],
    resources: [],
    defaults: {},
  };
  return { ...content, compositionHash: suiteContentDigest(content), createdAt: now };
}

const seedSuite = (revision: number) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const value = composition(revision);
    yield* sql`INSERT OR IGNORE INTO suite_compositions(suite_id, revision, composition_hash, record_json)
    VALUES (${value.ref.suiteId}, ${revision}, ${value.compositionHash}, ${JSON.stringify(value)})`;
    return value.ref;
  });

function config(name: string, suite: ProjectAgentConfig["suite"] = null): ProjectAgentConfig {
  return {
    projectId: ProjectId.makeUnsafe(name),
    suite,
    coordinatorThreadId: ThreadId.makeUnsafe(`${name}:coordinator`),
    coordinatorName: "Hub",
    coordinatorModelSelection: { provider: "codex", model: "fixture" },
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
}

function work(hub: ProjectAgentConfig, id: string): HubWorkRecord {
  return {
    id,
    projectId: hub.projectId,
    targetProjectId: hub.projectId,
    sourceThreadId: hub.coordinatorThreadId,
    sourceMessageId: null,
    title: "Research",
    workerThreadId: null,
    state: "queued",
    queueReason: "Waiting for capacity",
    resultSummary: null,
    progress: null,
    requestId: id,
    scopeKey: `source:${id}`,
    fingerprint: id,
    taskIndex: 0,
    creationSpec: {
      prompt: "Research",
      expertId: "suite-research",
      target: { provider: "codex", model: "fixture" },
      expertBinding: {
        expertId: "suite-research",
        snapshotId: `snapshot:${id}`,
        displayName: "Research",
        revision: 1,
      },
      capabilityBindingId: `binding:${id}`,
    },
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

const seedBinding = (
  hub: ProjectAgentConfig,
  record: HubWorkRecord,
  overrides: Partial<CapabilityBinding> = {},
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const content = {
      suite: hub.suite ?? null,
      purpose: {
        kind: "hub-worker" as const,
        hubId: hub.projectId,
        workId: record.id,
        hubConfigRevision: hub.revision,
        expertSnapshotId: record.creationSpec.expertBinding!.snapshotId,
      },
      projectId: record.targetProjectId,
      connections: [],
      mcpBinding: null,
    };
    const binding: CapabilityBinding = {
      ...content,
      schemaVersion: 1,
      bindingId: record.creationSpec.capabilityBindingId!,
      bindingHash: suiteContentDigest(content),
      createdAt: now,
      ...overrides,
    };
    const stored = { ...binding, bindingHash: capabilityBindingFingerprint(binding) };
    yield* sql`INSERT INTO suite_capability_bindings(binding_id, binding_hash, record_json)
      VALUES (${stored.bindingId}, ${stored.bindingHash}, ${JSON.stringify(stored)})`;
  });

const submit = (hub: ProjectAgentConfig, record: HubWorkRecord) =>
  Effect.gen(function* () {
    const repository = yield* HubWorkRepository;
    return yield* repository.submit({
      projectId: hub.projectId,
      requestId: record.requestId,
      scopeKey: record.scopeKey,
      fingerprint: record.fingerprint,
      records: [record],
      admission: { expectedConfigRevision: hub.revision },
    });
  });

tests("Hub Suite transactional ownership", (it) => {
  it.effect("preserves selection and the old roster on internal lifecycle writes", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectAgentRepository;
      const suite = yield* seedSuite(1);
      const hub = config("suite-lifecycle", suite);
      yield* repository.beginSuiteOnboarding(hub.projectId);
      yield* repository.saveConfig(hub, null);
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO projection_projects(project_id, title, workspace_root, scripts_json, created_at, updated_at)
      VALUES (${hub.projectId}, 'Hub', '/fixture/hub', '[]', ${now}, ${now})`;
      yield* sql`INSERT INTO hub_expert_participants(hub_id, expert_id) VALUES (${hub.projectId}, 'old-roster')`;
      const { suite: _suite, ...lifecycle } = hub;
      yield* repository.saveConfig({ ...lifecycle, revision: 2, pausedAt: now }, 1);
      const loaded = Option.getOrThrow(yield* repository.getConfig(hub.projectId));
      assert.deepEqual(loaded.suite, suite);
      assert.deepEqual(loaded.expertIds, ["old-roster"]);
      assert.deepEqual(
        (yield* repository.listSummaries()).find((row) => row.projectId === hub.projectId)?.suite,
        suite,
      );
    }),
  );

  it.effect(
    "preserves the SQL Suite selection for undefined writes before and after first admission",
    () =>
      Effect.gen(function* () {
        const repository = yield* ProjectAgentRepository;
        const sql = yield* SqlClient.SqlClient;
        const suite = yield* seedSuite(1);
        const hub = config("suite-undefined-write", suite);
        yield* repository.beginSuiteOnboarding(hub.projectId);
        yield* repository.saveConfig(hub, null);
        const preserved = yield* repository.saveConfig(
          { ...hub, suite: undefined, revision: 2 },
          1,
        );
        assert.deepEqual(preserved.suite, suite);
        const [open] = yield* sql<{
          readonly state: string;
          readonly revision: number;
          readonly selectionJson: string;
          readonly suiteId: string;
          readonly suiteRevision: number;
        }>`SELECT lock.state, lock.config_revision AS revision, lock.selection_json AS "selectionJson",
      selection.suite_id AS "suiteId", selection.suite_revision AS "suiteRevision"
      FROM hub_suite_mode_locks AS lock JOIN hub_suite_selections AS selection ON selection.hub_id = lock.hub_id
      WHERE lock.hub_id = ${hub.projectId}`;
        assert.deepEqual(open && { ...open, selectionJson: JSON.parse(open.selectionJson) }, {
          state: "open",
          revision: 2,
          selectionJson: suite,
          suiteId: suite.suiteId,
          suiteRevision: suite.revision,
        });
        yield* repository.saveConfig({ ...hub, suite: null, revision: 3 }, 2);
        assert.deepEqual(
          yield* sql`SELECT 1 FROM hub_suite_selections WHERE hub_id = ${hub.projectId}`,
          [],
        );
        assert.equal(Option.getOrThrow(yield* repository.getConfig(hub.projectId)).suite, null);
        yield* repository.saveConfig({ ...hub, revision: 4 }, 3);
        yield* repository.admitSuiteExecution({
          projectId: hub.projectId,
          expectedRevision: 4,
          admissionId: "undefined-write-first-run",
        });
        yield* repository.saveConfig({ ...hub, suite: undefined, revision: 5 }, 4);
        const loaded = Option.getOrThrow(yield* repository.getConfig(hub.projectId));
        assert.equal(loaded.revision, 5);
        assert.deepEqual(loaded.suite, suite);
        const [locked] = yield* sql<{
          readonly state: string;
          readonly revision: number;
          readonly selectionJson: string;
          readonly firstAdmissionId: string | null;
          readonly suiteId: string;
          readonly suiteRevision: number;
        }>`SELECT lock.state, lock.config_revision AS revision, lock.selection_json AS "selectionJson",
      lock.first_admission_id AS "firstAdmissionId",
      selection.suite_id AS "suiteId", selection.suite_revision AS "suiteRevision"
      FROM hub_suite_mode_locks AS lock JOIN hub_suite_selections AS selection ON selection.hub_id = lock.hub_id
      WHERE lock.hub_id = ${hub.projectId}`;
        assert.deepEqual(locked && { ...locked, selectionJson: JSON.parse(locked.selectionJson) }, {
          state: "locked",
          revision: 4,
          selectionJson: suite,
          firstAdmissionId: "undefined-write-first-run",
          suiteId: suite.suiteId,
          suiteRevision: suite.revision,
        });
        assert.isTrue(
          Exit.isFailure(
            yield* Effect.exit(repository.saveConfig({ ...hub, suite: null, revision: 6 }, 5)),
          ),
        );
        assert.deepEqual(
          Option.getOrThrow(yield* repository.getConfig(hub.projectId)).suite,
          suite,
        );
      }),
  );

  it.effect("locks each Hub independently and replays the original first-admission revision", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectAgentRepository;
      const sql = yield* SqlClient.SqlClient;
      const suite = yield* seedSuite(1);
      const first = config("suite-independent-a", suite);
      const second = config("suite-independent-b", suite);
      yield* repository.beginSuiteOnboarding(first.projectId);
      yield* repository.saveConfig(first, null);
      yield* repository.beginSuiteOnboarding(second.projectId);
      yield* repository.saveConfig(second, null);
      const accepted = yield* repository.admitSuiteExecution({
        projectId: first.projectId,
        expectedRevision: 1,
        admissionId: "first-run",
      });
      yield* repository.saveConfig({ ...first, revision: 2, coordinatorName: "Renamed" }, 1);
      assert.deepEqual(
        yield* repository.admitSuiteExecution({
          projectId: first.projectId,
          expectedRevision: 1,
          admissionId: "first-run",
        }),
        accepted,
      );
      const rows = yield* sql<{
        readonly hubId: string;
        readonly state: string;
      }>`SELECT hub_id AS "hubId", state
      FROM hub_suite_mode_locks WHERE hub_id IN (${first.projectId}, ${second.projectId}) ORDER BY hub_id`;
      assert.deepEqual(
        rows.map((row) => row.state),
        ["locked", "open"],
      );
      assert.isTrue(
        Exit.isFailure(
          yield* Effect.exit(repository.saveConfig({ ...first, revision: 3, suite: null }, 2)),
        ),
      );
      assert.deepEqual(
        Option.getOrThrow(yield* repository.getConfig(first.projectId)).suite,
        suite,
      );
    }),
  );

  it.effect("serializes a real configure/first-admission race under the SQL transaction", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectAgentRepository;
      const sql = yield* SqlClient.SqlClient;
      const firstSuite = yield* seedSuite(1);
      const secondSuite = yield* seedSuite(2);
      const hub = config("suite-save-admission-race", firstSuite);
      yield* repository.beginSuiteOnboarding(hub.projectId);
      yield* repository.saveConfig(hub, null);
      const [save, admission] = yield* Effect.all(
        [
          Effect.exit(repository.saveConfig({ ...hub, suite: secondSuite, revision: 2 }, 1)),
          Effect.exit(
            repository.admitSuiteExecution({
              projectId: hub.projectId,
              expectedRevision: 1,
              admissionId: "race-run",
            }),
          ),
        ],
        { concurrency: "unbounded" },
      );
      assert.notEqual(Exit.isSuccess(save), Exit.isSuccess(admission));
      const loaded = Option.getOrThrow(yield* repository.getConfig(hub.projectId));
      const [lock] = yield* sql<{
        readonly state: string;
        readonly selection: string;
        readonly revision: number;
      }>`
      SELECT state, selection_json AS selection, config_revision AS revision FROM hub_suite_mode_locks WHERE hub_id = ${hub.projectId}`;
      if (Exit.isSuccess(save)) {
        assert.deepEqual(loaded.suite, secondSuite);
        assert.equal(lock?.state, "open");
        assert.deepEqual(
          yield* repository.admitSuiteExecution({
            projectId: hub.projectId,
            expectedRevision: 2,
            admissionId: "race-run",
          }),
          { suite: secondSuite, configRevision: 2 },
        );
      } else {
        assert.deepEqual(loaded.suite, firstSuite);
        assert.equal(lock?.state, "locked");
      }
      assert.deepEqual(JSON.parse(lock!.selection), loaded.suite);
      assert.equal(lock!.revision, loaded.revision);
    }),
  );

  it.effect("keeps historical missing locks non-Suite and closed to adoption", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectAgentRepository;
      const sql = yield* SqlClient.SqlClient;
      const hub = config("legacy-no-suite-lock");
      yield* repository.saveConfig(hub, null);
      yield* repository.beginSuiteOnboarding(hub.projectId);
      const locks = yield* sql`SELECT 1 FROM hub_suite_mode_locks WHERE hub_id = ${hub.projectId}`;
      assert.equal(locks.length, 0);
      assert.equal(yield* repository.isSuiteSelectionOpen(hub.projectId), false);
      assert.deepEqual(
        yield* repository.admitSuiteExecution({
          projectId: hub.projectId,
          expectedRevision: 1,
          admissionId: "legacy-run",
        }),
        { suite: null, configRevision: 1 },
      );
      const suite = yield* seedSuite(1);
      assert.isTrue(
        Exit.isFailure(
          yield* Effect.exit(repository.saveConfig({ ...hub, revision: 2, suite }, 1)),
        ),
      );
      assert.equal(Option.getOrThrow(yield* repository.getConfig(hub.projectId)).suite, null);
    }),
  );

  it.effect("rejects missing compositions without partially updating config or mode lock", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectAgentRepository;
      const hub = config("suite-missing-save");
      yield* repository.beginSuiteOnboarding(hub.projectId);
      yield* repository.saveConfig(hub, null);
      assert.isTrue(
        Exit.isFailure(
          yield* Effect.exit(
            repository.saveConfig({ ...hub, revision: 2, suite: { suiteId, revision: 999 } }, 1),
          ),
        ),
      );
      const loaded = Option.getOrThrow(yield* repository.getConfig(hub.projectId));
      assert.equal(loaded.revision, 1);
      assert.equal(loaded.suite, null);
    }),
  );

  it.effect("rejects SQL/JSON composition hash disagreement and rolls back selection", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectAgentRepository;
      const sql = yield* SqlClient.SqlClient;
      const suite = yield* seedSuite(3);
      const hub = config("suite-corrupt-save");
      yield* repository.beginSuiteOnboarding(hub.projectId);
      yield* repository.saveConfig(hub, null);
      yield* sql`UPDATE suite_compositions SET composition_hash = ${"f".repeat(64)}
      WHERE suite_id = ${suite.suiteId} AND revision = ${suite.revision}`;
      assert.isTrue(
        Exit.isFailure(
          yield* Effect.exit(repository.saveConfig({ ...hub, suite, revision: 2 }, 1)),
        ),
      );
      assert.equal(Option.getOrThrow(yield* repository.getConfig(hub.projectId)).revision, 1);
    }),
  );

  it.effect(
    "accepts Suite members rather than the retained roster and freezes replay after failure",
    () =>
      Effect.gen(function* () {
        const repository = yield* ProjectAgentRepository;
        const workRepository = yield* HubWorkRepository;
        const sql = yield* SqlClient.SqlClient;
        const hub = config("suite-worker-replay", yield* seedSuite(1));
        yield* repository.beginSuiteOnboarding(hub.projectId);
        yield* repository.saveConfig(hub, null);
        const record = work(hub, "suite-work-frozen");
        yield* seedBinding(hub, record);
        const accepted = yield* submit(hub, record);
        assert.equal(accepted.replayed, false);
        const current = accepted.items[0]!;
        yield* workRepository.save({
          record: { ...current, state: "failed", revision: 1 },
          expectedRevision: 0,
        });
        yield* repository.saveConfig({ ...hub, revision: 2, coordinatorName: "After failure" }, 1);
        const replay = yield* submit(hub, {
          ...record,
          creationSpec: { ...record.creationSpec, capabilityBindingId: "must-not-replace" },
        });
        assert.equal(replay.replayed, true);
        assert.equal(
          replay.items[0]?.creationSpec.capabilityBindingId,
          record.creationSpec.capabilityBindingId,
        );
        const [lock] = yield* sql<{ readonly state: string; readonly firstAdmissionId: string }>`
      SELECT state, first_admission_id AS "firstAdmissionId" FROM hub_suite_mode_locks WHERE hub_id = ${hub.projectId}`;
        assert.equal(lock?.state, "locked");
        assert.equal(lock?.firstAdmissionId, `hub-work:${record.requestId}`);
        assert.isTrue(
          Exit.isFailure(
            yield* Effect.exit(repository.saveConfig({ ...hub, revision: 3, suite: null }, 2)),
          ),
        );
        assert.isTrue(
          Exit.isFailure(
            yield* Effect.exit(
              workRepository.save({
                record: {
                  ...replay.items[0]!,
                  revision: 2,
                  creationSpec: { ...record.creationSpec, capabilityBindingId: "changed" },
                },
                expectedRevision: 1,
              }),
            ),
          ),
        );
      }),
  );

  it.effect(
    "rejects a coordinator binding used as a worker and does not publish work or lock",
    () =>
      Effect.gen(function* () {
        const repository = yield* ProjectAgentRepository;
        const workRepository = yield* HubWorkRepository;
        const sql = yield* SqlClient.SqlClient;
        const hub = config("suite-purpose-guard", yield* seedSuite(1));
        yield* repository.beginSuiteOnboarding(hub.projectId);
        yield* repository.saveConfig(hub, null);
        const record = work(hub, "suite-purpose-work");
        yield* seedBinding(hub, record, {
          purpose: { kind: "hub-coordinator", hubId: hub.projectId, hubConfigRevision: 1 },
        });
        assert.isTrue(Exit.isFailure(yield* Effect.exit(submit(hub, record))));
        assert.deepEqual(yield* workRepository.list(hub.projectId), []);
        const [lock] = yield* sql<{
          readonly state: string;
        }>`SELECT state FROM hub_suite_mode_locks WHERE hub_id = ${hub.projectId}`;
        assert.equal(lock?.state, "open");
      }),
  );

  it.effect("rechecks the config revision even when the first-admission ID was already used", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectAgentRepository;
      const workRepository = yield* HubWorkRepository;
      const hub = config("suite-worker-cas", yield* seedSuite(1));
      yield* repository.beginSuiteOnboarding(hub.projectId);
      yield* repository.saveConfig(hub, null);
      const record = work(hub, "suite-work-cas");
      yield* seedBinding(hub, record);
      yield* repository.admitSuiteExecution({
        projectId: hub.projectId,
        expectedRevision: 1,
        admissionId: `hub-work:${record.requestId}`,
      });
      yield* repository.saveConfig({ ...hub, revision: 2 }, 1);
      assert.isTrue(Exit.isFailure(yield* Effect.exit(submit(hub, record))));
      assert.deepEqual(yield* workRepository.list(hub.projectId), []);
    }),
  );

  it.effect(
    "locks an explicit non-Suite first execution and only permits pre-execution selection",
    () =>
      Effect.gen(function* () {
        const repository = yield* ProjectAgentRepository;
        const suite = yield* seedSuite(1);
        const closed = config("non-suite-first-admission");
        const open = config("non-suite-before-admission");
        yield* repository.beginSuiteOnboarding(closed.projectId);
        assert.equal(yield* repository.isSuiteSelectionOpen(closed.projectId), true);
        yield* repository.saveConfig(closed, null);
        yield* repository.beginSuiteOnboarding(open.projectId);
        assert.equal(yield* repository.isSuiteSelectionOpen(open.projectId), true);
        yield* repository.saveConfig(open, null);
        assert.deepEqual(
          yield* repository.admitSuiteExecution({
            projectId: closed.projectId,
            expectedRevision: 1,
            admissionId: "ordinary-first-run",
          }),
          { suite: null, configRevision: 1 },
        );
        assert.equal(yield* repository.isSuiteSelectionOpen(closed.projectId), false);
        assert.isTrue(
          Exit.isFailure(
            yield* Effect.exit(repository.saveConfig({ ...closed, suite, revision: 2 }, 1)),
          ),
        );
        yield* repository.saveConfig({ ...open, suite, revision: 2 }, 1);
        assert.deepEqual(
          yield* repository.admitSuiteExecution({
            projectId: open.projectId,
            expectedRevision: 2,
            admissionId: "suite-first-run",
          }),
          { suite, configRevision: 2 },
        );
      }),
  );

  it.effect(
    "does not turn a historical unconfigured shell into Suite onboarding on first save",
    () =>
      Effect.gen(function* () {
        const repository = yield* ProjectAgentRepository;
        const hub = config("legacy-unconfigured-shell", yield* seedSuite(1));
        assert.isTrue(Exit.isFailure(yield* Effect.exit(repository.saveConfig(hub, null))));
        assert.isTrue(Option.isNone(yield* repository.getConfig(hub.projectId)));
      }),
  );
});
