import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { migrationEntries, runMigrations } from "../../persistence/Migrations.ts";
import ExpertBindingMigration from "../../persistence/Migrations/109_ProjectionThreadsExpertBinding.ts";
import ExpertRuntimeMigration from "../../persistence/Migrations/110_ExpertAppliedRuntimeRecords.ts";
import ContextV1Migration from "../../persistence/Migrations/111_ContextV1.ts";
import * as NodeSqliteClient from "../../persistence/NodeSqliteClient.ts";
import { adoptLegacyExpertMigrations } from "./LegacyExpertMigrationAdoption.ts";
import {
  LEGACY_EXPERT_OFFICIAL_MIGRATIONS,
  allWorkbenchMigrationEntries,
  contextWorkbenchMigrationEntries,
  ensureWorkbenchTracker,
  readWorkbenchTracker,
  runWorkbenchMigrations,
  WorkbenchMigrationError,
  workbenchMigrationEntries,
} from "./WorkbenchMigrations.ts";
import { inspectWorkbenchUpgradePlan } from "./WorkbenchUpgradePlan.ts";

const insertModuleHistory = (moduleId: "expert" | "context") =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* ensureWorkbenchTracker;
    const history = allWorkbenchMigrationEntries.filter((row) => {
      if (row.moduleId !== moduleId) return false;
      // This fixture represents a pre-extension database. Its expert tracker
      // contains only the original two migrations split from legacy 109/110.
      if (moduleId === "expert") {
        return LEGACY_EXPERT_OFFICIAL_MIGRATIONS.some(
          ({ workbenchId }) => workbenchId === row.migrationId,
        );
      }
      return true;
    });
    for (const migration of history) {
      yield* sql`
        INSERT INTO workbench_sql_migrations (module_id, migration_id, name, checksum, applied_at)
        VALUES (${migration.moduleId}, ${migration.migrationId}, ${migration.name},
          ${migration.checksum}, '2026-10-12T00:00:00.000Z')
      `;
    }
  });

const seedLegacy = (mode: "legacy-expert" | "split-expert", through: 109 | 110 | 111 = 111) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 108 });
    yield* ExpertBindingMigration;
    if (mode === "legacy-expert") {
      yield* sql`INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES (109, 'ProjectionThreadsExpertBinding')`;
    }
    if (through >= 110) {
      yield* ExpertRuntimeMigration;
      if (mode === "legacy-expert") {
        yield* sql`INSERT INTO effect_sql_migrations (migration_id, name)
          VALUES (110, 'ExpertAppliedRuntimeRecords')`;
      } else {
        yield* insertModuleHistory("expert");
      }
    }
    if (through === 111) {
      yield* ContextV1Migration;
      yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (111, 'ContextV1')`;
      yield* sql`UPDATE effect_sql_migrations SET created_at = '2026-10-12T11:12:13.000Z' WHERE migration_id = 111`;
    }
  });

const seedPreservedData = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO projection_threads (
    thread_id, project_id, title, model_selection_json, runtime_mode,
    interaction_mode, env_mode, created_at, updated_at, expert_binding_json
  ) VALUES ('thread-preserved', 'project-preserved', 'Preserved',
    '{"provider":"codex","model":"gpt"}', 'full-access', 'default', 'local',
    '2026-10-12', '2026-10-12', '{"expertId":"reviewer"}')`;
  yield* sql`INSERT INTO expert_applied_runtime_records (
    thread_id, snapshot_id, provider, model, lifecycle_generation, applied_at
  ) VALUES ('thread-preserved', 'expert-snapshot', 'codex', 'gpt', 'generation-1', '2026-10-12')`;
  yield* sql`INSERT INTO context_spaces VALUES ('space-preserved', 'direction', 'instructions', 7, '2026-10-12')`;
  yield* sql`INSERT INTO context_projects VALUES ('project-preserved', 'goal', 'project instructions', 9, '2026-10-12')`;
  yield* sql`INSERT INTO context_migrations VALUES ('project-preserved', 'digest', 'legacy', 'completed', 'keep_saved', '2026-10-12')`;
  yield* sql`INSERT INTO context_thread_bindings VALUES ('thread-preserved', 'bound', '{"snapshotId":"context-snapshot","revision":9}')`;
  yield* sql`INSERT INTO context_applied_runtime_records VALUES ('thread-preserved', '{"snapshotId":"context-snapshot","acknowledged":true}')`;
  yield* sql`INSERT INTO context_command_results VALUES ('command-preserved', '{"ok":true,"snapshotId":"context-snapshot"}')`;
  yield* sql`INSERT INTO orchestration_consumer_state VALUES ('context-test-consumer', 0, '2026-10-12', '2026-10-12')`;
  yield* sql`INSERT INTO orchestration_event_deliveries (
    consumer_name, event_sequence, thread_id, state, updated_at,
    context_snapshot_id, context_input_digest, context_message_id, context_phase
  ) VALUES ('context-test-consumer', 1, 'thread-preserved', 'succeeded', '2026-10-12',
    'context-snapshot', 'input-digest', 'message-preserved', 'acknowledged')`;
});

const readPreservedData = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return {
    meta: yield* sql`SELECT * FROM context_meta`,
    spaces: yield* sql`SELECT * FROM context_spaces`,
    projects: yield* sql`SELECT * FROM context_projects`,
    migrations: yield* sql`SELECT * FROM context_migrations`,
    bindings: yield* sql`SELECT * FROM context_thread_bindings`,
    runtime: yield* sql`SELECT * FROM context_applied_runtime_records`,
    commands: yield* sql`SELECT * FROM context_command_results`,
    deliveries:
      yield* sql`SELECT * FROM orchestration_event_deliveries WHERE consumer_name = 'context-test-consumer'`,
    expert:
      yield* sql`SELECT * FROM expert_applied_runtime_records WHERE thread_id = 'thread-preserved'`,
    threads:
      yield* sql`SELECT thread_id, project_id, expert_binding_json FROM projection_threads WHERE thread_id = 'thread-preserved'`,
  };
});

const finishUpgrade = Effect.gen(function* () {
  const adoption = yield* adoptLegacyExpertMigrations();
  yield* runMigrations();
  const migration = yield* runWorkbenchMigrations();
  return { adoption, migration };
});

it("keeps legacy Context 111 byte-for-byte frozen and uses its checksum for context1", () => {
  const bytes = readFileSync(
    new URL("../../persistence/Migrations/111_ContextV1.ts", import.meta.url),
  );
  const checksum = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  assert.strictEqual(
    checksum,
    "sha256:b7dbd84911484156f3f38093973338ca005dce9e8ba4b38b8972d9dfe79a4911",
  );
  assert.strictEqual(contextWorkbenchMigrationEntries[0]?.checksum, checksum);
  assert.deepStrictEqual(
    workbenchMigrationEntries.map(({ migrationId, name }) => [migrationId, name]),
    [
      [1, "ProjectionThreadsExpertBinding"],
      [2, "ExpertAppliedRuntimeRecords"],
      [3, "HubProjectOrigin"],
      [4, "HubExpertDeliverables"],
      [5, "HubExpertParticipants"],
    ],
  );
});

for (const mode of ["legacy-expert", "split-expert"] as const) {
  it.effect(
    `adopts old Context 111 with ${mode} and preserves IDs, snapshots and receipts across restarts`,
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* seedLegacy(mode);
        yield* seedPreservedData;
        const before = yield* readPreservedData;
        const plan = yield* inspectWorkbenchUpgradePlan;
        assert.strictEqual(plan.kind, "ready");
        if (plan.kind !== "ready") return;
        assert.strictEqual(plan.official.sourceVersion, 108);
        assert.deepStrictEqual(plan.workbench.adoptedContextMigrationIds, [1]);
        assert.deepStrictEqual(
          plan.workbench.adoptedMigrationIds,
          mode === "legacy-expert" ? [1, 2] : [],
        );
        assert.isTrue(plan.workbench.hasPendingMigrations);
        assert.isTrue(plan.requiresBackup);
        const first = yield* finishUpgrade;
        assert.deepStrictEqual(first.adoption.adoptedContextMigrationIds, [1]);
        const audit = yield* sql`SELECT module_id, migration_id, official_id, official_name,
        official_created_at, checksum FROM workbench_legacy_migration_adoptions WHERE module_id = 'context'`;
        assert.deepStrictEqual(audit, [
          {
            module_id: "context",
            migration_id: 1,
            official_id: 111,
            official_name: "ContextV1",
            official_created_at: "2026-10-12T11:12:13.000Z",
            checksum: "sha256:b7dbd84911484156f3f38093973338ca005dce9e8ba4b38b8972d9dfe79a4911",
          },
        ]);
        const allAudit =
          yield* sql`SELECT * FROM workbench_legacy_migration_adoptions ORDER BY module_id, migration_id`;
        assert.deepStrictEqual(
          first.migration.executed.map(({ moduleId, migrationId }) => [moduleId, migrationId]),
          [
            ["expert", 3],
            ["expert", 4],
            ["expert", 5],
          ],
        );
        assert.deepStrictEqual(yield* readPreservedData, before);
        const official = yield* sql<{ readonly migration_id: number; readonly name: string }>`
        SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id`;
        assert.deepStrictEqual(
          official,
          migrationEntries.map(([migration_id, name]) => ({ migration_id, name })),
        );
        const tracker = yield* readWorkbenchTracker;
        assert.deepStrictEqual(
          tracker.rows.map(({ module_id, migration_id }) => [module_id, migration_id]),
          [
            ["context", 1],
            ["expert", 1],
            ["expert", 2],
            ["expert", 3],
            ["expert", 4],
            ["expert", 5],
          ],
        );
        const repeated = yield* finishUpgrade;
        assert.deepStrictEqual(repeated.adoption, {
          adoptedMigrationIds: [],
          adoptedContextMigrationIds: [],
        });
        assert.deepStrictEqual(repeated.migration.executed, []);
        assert.deepStrictEqual((yield* readWorkbenchTracker).rows, tracker.rows);
        assert.deepStrictEqual(
          yield* sql`SELECT * FROM workbench_legacy_migration_adoptions ORDER BY module_id, migration_id`,
          allAudit,
        );
        assert.deepStrictEqual(yield* readPreservedData, before);
        const settled = yield* inspectWorkbenchUpgradePlan;
        assert.strictEqual(settled.kind, "ready");
        if (settled.kind === "ready") {
          assert.deepStrictEqual(settled.workbench.modules, {
            expert: { sourceVersion: 5, targetVersion: 5 },
            context: { sourceVersion: 1, targetVersion: 1 },
          });
          assert.isFalse(settled.requiresBackup);
        }
      }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
  );
}

it.effect(
  "initializes a fresh database with native 109–135 and independent expert/context ledgers once",
  () =>
    Effect.gen(function* () {
      const initial = yield* inspectWorkbenchUpgradePlan;
      assert.strictEqual(initial.kind, "ready");
      if (initial.kind === "ready") assert.isFalse(initial.requiresBackup);
      const result = yield* finishUpgrade;
      assert.deepStrictEqual(
        result.migration.executed.map(({ moduleId, migrationId }) => [moduleId, migrationId]),
        [
          ["expert", 1],
          ["expert", 2],
          ["expert", 3],
          ["expert", 4],
          ["expert", 5],
          ["context", 1],
        ],
      );
      const sql = yield* SqlClient.SqlClient;
      const native =
        yield* sql`SELECT migration_id, name FROM effect_sql_migrations WHERE migration_id BETWEEN 109 AND 111 ORDER BY migration_id`;
      assert.deepStrictEqual(native, [
        { migration_id: 109, name: "ProjectAgent" },
        { migration_id: 110, name: "Groups" },
        { migration_id: 111, name: "GroupLibraryHosting" },
      ]);
      const before = yield* sql`SELECT * FROM context_meta`;
      assert.strictEqual(before.length, 1);
      const second = yield* finishUpgrade;
      assert.deepStrictEqual(second.migration.executed, []);
      assert.deepStrictEqual(yield* sql`SELECT * FROM context_meta`, before);
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

for (const through of [109, 110] as const) {
  it.effect(`upgrades legacy Expert ${through} without requiring an existing Context schema`, () =>
    Effect.gen(function* () {
      yield* seedLegacy("legacy-expert", through);
      const result = yield* finishUpgrade;
      assert.deepStrictEqual(result.adoption.adoptedMigrationIds, through === 109 ? [1] : [1, 2]);
      assert.deepStrictEqual(result.adoption.adoptedContextMigrationIds, []);
      assert.deepStrictEqual(
        result.migration.executed.map(({ moduleId, migrationId }) => [moduleId, migrationId]),
        through === 109
          ? [
              ["expert", 2],
              ["expert", 3],
              ["expert", 4],
              ["expert", 5],
              ["context", 1],
            ]
          : [
              ["expert", 3],
              ["expert", 4],
              ["expert", 5],
              ["context", 1],
            ],
      );
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
  );
}

for (const id of [109, 110, 111]) {
  it.effect(
    `rejects an unknown name in reserved legacy slot ${id} without mutating history or Context data`,
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* seedLegacy("legacy-expert");
        yield* seedPreservedData;
        yield* sql`UPDATE effect_sql_migrations SET name = 'UnknownMigration' WHERE migration_id = ${id}`;
        const history = yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`;
        const data = yield* readPreservedData;
        const plan = yield* inspectWorkbenchUpgradePlan;
        assert.strictEqual(plan.kind, "rejected");
        const failure = yield* Effect.flip(adoptLegacyExpertMigrations());
        assert.isTrue(failure instanceof WorkbenchMigrationError);
        assert.deepStrictEqual(
          yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`,
          history,
        );
        assert.deepStrictEqual(yield* readPreservedData, data);
        assert.isFalse((yield* readWorkbenchTracker).exists);
        assert.deepStrictEqual(
          yield* sql`SELECT name FROM sqlite_master WHERE name = 'workbench_legacy_migration_adoptions'`,
          [],
        );
      }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
  );
}

for (const damage of ["table", "column", "delivery-column"] as const) {
  it.effect(`rejects recorded legacy Context 111 with a missing ${damage} before adoption`, () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seedLegacy("legacy-expert");
      if (damage === "table") yield* sql`DROP TABLE context_command_results`;
      if (damage === "column")
        yield* sql`ALTER TABLE context_thread_bindings DROP COLUMN snapshot_json`;
      if (damage === "delivery-column")
        yield* sql`ALTER TABLE orchestration_event_deliveries DROP COLUMN context_input_digest`;
      const before = yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`;
      assert.strictEqual((yield* inspectWorkbenchUpgradePlan).kind, "rejected");
      const failure = yield* Effect.flip(adoptLegacyExpertMigrations());
      assert.isTrue(failure instanceof WorkbenchMigrationError);
      assert.deepStrictEqual(
        yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`,
        before,
      );
      assert.isFalse((yield* readWorkbenchTracker).exists);
      assert.deepStrictEqual(
        yield* sql`SELECT name FROM sqlite_master WHERE name = 'workbench_legacy_migration_adoptions'`,
        [],
      );
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
  );
}

it.effect("rejects Context recorded in both trackers without deleting either record", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* seedLegacy("split-expert");
    yield* insertModuleHistory("context");
    const before = (yield* readWorkbenchTracker).rows;
    assert.strictEqual((yield* inspectWorkbenchUpgradePlan).kind, "rejected");
    const failure = yield* Effect.flip(adoptLegacyExpertMigrations());
    assert.isTrue(failure instanceof WorkbenchMigrationError);
    assert.match(failure.message, /both the official and workbench trackers/);
    assert.deepStrictEqual((yield* readWorkbenchTracker).rows, before);
    assert.deepStrictEqual(
      yield* sql`SELECT name FROM sqlite_master WHERE name = 'workbench_legacy_migration_adoptions'`,
      [],
    );
    assert.deepStrictEqual(
      yield* sql`SELECT migration_id, name FROM effect_sql_migrations WHERE migration_id = 111`,
      [{ migration_id: 111, name: "ContextV1" }],
    );
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it.effect("rolls back Expert adoption too when inserting the Context ledger row fails", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* seedLegacy("legacy-expert");
    yield* seedPreservedData;
    yield* ensureWorkbenchTracker;
    yield* sql`CREATE TRIGGER reject_context_adoption BEFORE INSERT ON workbench_sql_migrations
      WHEN NEW.module_id = 'context' BEGIN SELECT RAISE(ABORT, 'reject context adoption'); END`;
    const history = yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`;
    const data = yield* readPreservedData;
    yield* Effect.flip(adoptLegacyExpertMigrations());
    assert.deepStrictEqual((yield* readWorkbenchTracker).rows, []);
    assert.deepStrictEqual(
      yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`,
      history,
    );
    assert.deepStrictEqual(yield* readPreservedData, data);
    assert.deepStrictEqual(
      yield* sql`SELECT name FROM sqlite_master WHERE name = 'workbench_schema_metadata'`,
      [],
    );
    assert.deepStrictEqual(
      yield* sql`SELECT name FROM sqlite_master WHERE name = 'workbench_legacy_migration_adoptions'`,
      [],
    );
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);
