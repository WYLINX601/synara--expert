import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { migrationEntries, runMigrations } from "../../persistence/Migrations.ts";
import LegacyExpertBindingMigration from "../../persistence/Migrations/109_ProjectionThreadsExpertBinding.ts";
import ExpertAppliedRuntimeRecordsMigration from "../../persistence/Migrations/110_ExpertAppliedRuntimeRecords.ts";
import * as NodeSqliteClient from "../../persistence/NodeSqliteClient.ts";
import {
  EXPERT_WORKBENCH_MODULE_ID,
  LEGACY_EXPERT_OFFICIAL_MIGRATIONS,
  WorkbenchMigrationError,
  currentOfficialMigrationCount,
  currentOfficialMigrationEntryCount,
  officialMigrationCatalogHighWaterMark,
  WORKBENCH_SCHEMA_FORMAT_VERSION,
  planWorkbenchHistory,
  runWorkbenchMigrations,
  validateCurrentOfficialMigrationPrefix,
  validateOfficialMigrationPrefixAgainstCatalog,
  validateWorkbenchSchemaState,
  workbenchMigrationEntries,
  type OfficialMigrationRecord,
  type SqliteColumnInfo,
  type WorkbenchMigrationRecord,
} from "./WorkbenchMigrations.ts";
import {
  adoptLegacyExpertMigrations,
  planLegacyExpertMigrationAdoption,
} from "./LegacyExpertMigrationAdoption.ts";

const absentContextSchema = {
  contextSchemaObjects: [],
  contextTableColumns: {
    context_meta: null,
    context_spaces: null,
    context_projects: null,
    context_migrations: null,
    context_thread_bindings: null,
    context_applied_runtime_records: null,
    context_command_results: null,
  },
  contextDeliveryColumns: null,
} as const;

const frozenOfficialPrefix = migrationEntries
  .filter(([id]) => id <= 108)
  .map(([migration_id, name]) => ({ migration_id, name }));

const legacyRows = (through: 109 | 110): readonly OfficialMigrationRecord[] => [
  ...frozenOfficialPrefix,
  ...LEGACY_EXPERT_OFFICIAL_MIGRATIONS.filter(({ officialId }) => officialId <= through).map(
    ({ officialId: migration_id, officialName: name }) => ({ migration_id, name }),
  ),
];

const seedLegacyExpertHistory = (through: 109 | 110 = 110) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 108 });
    yield* LegacyExpertBindingMigration;
    yield* sql`
      INSERT INTO effect_sql_migrations (migration_id, name)
      VALUES (109, 'ProjectionThreadsExpertBinding')
    `;
    if (through === 110) {
      yield* ExpertAppliedRuntimeRecordsMigration;
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES (110, 'ExpertAppliedRuntimeRecords')
      `;
    }
  });

const bindingColumn: SqliteColumnInfo = {
  name: "expert_binding_json",
  type: "TEXT",
  notnull: 0,
  dflt_value: null,
  pk: 0,
};

const runtimeRecordColumns: readonly SqliteColumnInfo[] = [
  { name: "thread_id", type: "TEXT", notnull: 0, dflt_value: null, pk: 1 },
  { name: "snapshot_id", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
  { name: "provider", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
  { name: "model", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
  { name: "runtime_component", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
  { name: "runtime_version", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
  { name: "lifecycle_generation", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
  { name: "applied_at", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
];

const adopted109Schema = {
  ...absentContextSchema,
  projectionThreadsExists: true,
  bindingColumn,
  runtimeRecordColumns: null,
} as const;

const adopted110Schema = {
  ...absentContextSchema,
  projectionThreadsExists: true,
  bindingColumn,
  runtimeRecordColumns,
} as const;

const workbenchRows = (count: number): readonly WorkbenchMigrationRecord[] =>
  workbenchMigrationEntries.slice(0, count).map((migration) => ({
    module_id: migration.moduleId,
    migration_id: migration.migrationId,
    name: migration.name,
    checksum: migration.checksum,
    applied_at: "2026-09-29T12:00:00.000Z",
  }));

it.effect("uses stable expert checksums and rejects malformed or future extension history", () =>
  Effect.sync(() => {
    const good = planWorkbenchHistory(workbenchRows(2));
    assert.isTrue(good.ok);
    if (!good.ok) return;
    assert.strictEqual(good.applied.length, 2);
    assert.isTrue(
      good.applied.every((migration) => migration.moduleId === EXPERT_WORKBENCH_MODULE_ID),
    );

    const firstWorkbenchRow = workbenchRows(1)[0]!;
    const wrongChecksum = [{ ...firstWorkbenchRow, checksum: "sha256:wrong" }];
    const wrongName = [{ ...firstWorkbenchRow, name: "DifferentMigration" }];
    const gap = [workbenchRows(2)[1]!];
    const future = [{ ...workbenchRows(1)[0]!, migration_id: 6, name: "FutureExpertMigration" }];
    const unsupportedModule = [{ ...workbenchRows(1)[0]!, module_id: "future-module" }];

    assert.isFalse(planWorkbenchHistory(wrongChecksum).ok);
    assert.isFalse(planWorkbenchHistory(wrongName).ok);
    assert.isFalse(planWorkbenchHistory(gap).ok);
    assert.isFalse(planWorkbenchHistory(future).ok);
    assert.isFalse(planWorkbenchHistory(unsupportedModule).ok);

    const complete = planWorkbenchHistory(workbenchRows(workbenchMigrationEntries.length));
    assert.isTrue(complete.ok);
    if (complete.ok) {
      assert.strictEqual(complete.applied.at(-2)?.migrationId, 11);
      assert.strictEqual(complete.applied.at(-2)?.name, "ExpertAutomaticLearning");
      assert.strictEqual(complete.applied.at(-1)?.migrationId, 12);
      assert.strictEqual(complete.applied.at(-1)?.name, "ExpertLearningEvidenceDelivery");
    }
  }),
);

it.effect("recognizes only the frozen 109/110 legacy identities and exact resulting schema", () =>
  Effect.sync(() => {
    const prefix = {
      officialTrackerExists: true,
      workbenchTrackerExists: false,
      workbenchRows: [],
    } as const;

    assert.deepStrictEqual(
      planLegacyExpertMigrationAdoption({
        ...prefix,
        officialRows: legacyRows(109),
        schemaState: adopted109Schema,
      }),
      {
        kind: "adopt",
        migrationIds: [1],
        contextMigrationIds: [],
        legacyMigrations: LEGACY_EXPERT_OFFICIAL_MIGRATIONS.filter(({ workbenchId }) =>
          [1].includes(workbenchId),
        ).map(({ officialId, officialName, workbenchId }) => ({
          officialId,
          officialName,
          workbenchId,
          moduleId: "expert" as const,
        })),
      },
    );
    assert.deepStrictEqual(
      planLegacyExpertMigrationAdoption({
        ...prefix,
        officialRows: legacyRows(110),
        schemaState: adopted110Schema,
      }),
      {
        kind: "adopt",
        migrationIds: [1, 2],
        contextMigrationIds: [],
        legacyMigrations: LEGACY_EXPERT_OFFICIAL_MIGRATIONS.filter(({ workbenchId }) =>
          [1, 2].includes(workbenchId),
        ).map(({ officialId, officialName, workbenchId }) => ({
          officialId,
          officialName,
          workbenchId,
          moduleId: "expert" as const,
        })),
      },
    );

    const legacy109Rows = legacyRows(109);
    const wrongLegacyName = [
      ...legacy109Rows.slice(0, -1),
      { migration_id: 109, name: "NotProjectionThreadsExpertBinding" },
    ];
    const changedFrozenPrefix = [
      ...legacy109Rows.slice(0, 50),
      { migration_id: 51, name: "RenamedFrozenMigration" },
      ...legacy109Rows.slice(51),
    ];
    const malformedRuntimeTable = {
      ...adopted110Schema,
      runtimeRecordColumns: runtimeRecordColumns.slice(1),
    };

    assert.strictEqual(
      planLegacyExpertMigrationAdoption({
        ...prefix,
        officialRows: wrongLegacyName,
        schemaState: adopted109Schema,
      }).kind,
      "invalid",
    );
    assert.strictEqual(
      planLegacyExpertMigrationAdoption({
        ...prefix,
        officialRows: changedFrozenPrefix,
        schemaState: adopted109Schema,
      }).kind,
      "invalid",
    );
    assert.strictEqual(
      planLegacyExpertMigrationAdoption({
        ...prefix,
        officialRows: legacyRows(110),
        schemaState: malformedRuntimeTable,
      }).kind,
      "invalid",
    );
  }),
);

it.effect(
  "allows a missing projection table only for a truly empty database or official versions 1 through 4",
  () =>
    Effect.sync(() => {
      const missingProjectionSchema = {
        ...absentContextSchema,
        projectionThreadsExists: false,
        bindingColumn: null,
        runtimeRecordColumns: null,
      } as const;
      const base = {
        workbenchTrackerExists: false,
        workbenchRows: [],
        schemaState: missingProjectionSchema,
      } as const;

      assert.strictEqual(
        planLegacyExpertMigrationAdoption({
          ...base,
          officialTrackerExists: false,
          officialRows: [],
          databaseEmpty: true,
        }).kind,
        "none",
      );
      assert.strictEqual(
        planLegacyExpertMigrationAdoption({
          ...base,
          officialTrackerExists: true,
          officialRows: frozenOfficialPrefix.slice(0, 4),
          databaseEmpty: false,
        }).kind,
        "none",
      );
      assert.strictEqual(
        planLegacyExpertMigrationAdoption({
          ...base,
          officialTrackerExists: true,
          officialRows: frozenOfficialPrefix.slice(0, 5),
          databaseEmpty: false,
        }).kind,
        "invalid",
      );
      assert.strictEqual(
        planLegacyExpertMigrationAdoption({
          ...base,
          officialTrackerExists: true,
          officialRows: [],
          databaseEmpty: false,
        }).kind,
        "invalid",
      );
      assert.strictEqual(
        planLegacyExpertMigrationAdoption({
          ...base,
          officialTrackerExists: false,
          officialRows: [],
          databaseEmpty: false,
        }).kind,
        "invalid",
      );
    }),
);

it.effect("allows an empty database to pass pre-migration history recognition", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const result = yield* adoptLegacyExpertMigrations();
    assert.deepStrictEqual(result, { adoptedMigrationIds: [], adoptedContextMigrationIds: [] });
    const tables = yield* sql<{ readonly name: string }>`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name IN ('effect_sql_migrations', 'workbench_sql_migrations', 'projection_threads')
    `;
    assert.deepStrictEqual(tables, []);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it.effect("uses official migration IDs as versions even when the catalog reserves a gap", () =>
  Effect.sync(() => {
    const currentEntries = migrationEntries;
    const currentRows: OfficialMigrationRecord[] = currentEntries.map(([migration_id, name]) => ({
      migration_id,
      name,
    }));
    const catalog = [...currentEntries, [137, "OfficialChangeAfterSplit", Effect.void] as const];
    const rows: OfficialMigrationRecord[] = [
      ...currentRows,
      { migration_id: 137, name: "OfficialChangeAfterSplit" },
    ];
    assert.isNull(validateOfficialMigrationPrefixAgainstCatalog(rows, catalog));
    assert.isNull(validateCurrentOfficialMigrationPrefix(frozenOfficialPrefix));
    assert.isNull(validateCurrentOfficialMigrationPrefix(currentRows));
    assert.strictEqual(currentOfficialMigrationCount(), 135);
    assert.strictEqual(currentOfficialMigrationEntryCount(), 135);
    assert.strictEqual(catalog.length, 136);
    assert.strictEqual(officialMigrationCatalogHighWaterMark(catalog), 137);
  }),
);

it.effect("validates extension schema only after the official projection exists", () =>
  Effect.sync(() => {
    assert.isNull(
      validateWorkbenchSchemaState(0, {
        ...absentContextSchema,
        projectionThreadsExists: false,
        bindingColumn: null,
        runtimeRecordColumns: null,
      }),
    );
    assert.isNotNull(
      validateWorkbenchSchemaState(1, {
        ...absentContextSchema,
        projectionThreadsExists: false,
        bindingColumn: null,
        runtimeRecordColumns: null,
      }),
    );
  }),
);

const fullAdoptionLayer = it.layer(NodeSqliteClient.layerMemory());
fullAdoptionLayer("legacy expert migration handoff", (test) => {
  test.effect("moves exact 109/110 history transactionally and preserves schema data", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seedLegacyExpertHistory(110);
      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, model_selection_json, runtime_mode,
          interaction_mode, env_mode, created_at, updated_at, expert_binding_json
        ) VALUES (
          'legacy-thread', 'project', 'Legacy', '{"provider":"codex","model":"gpt"}',
          'full-access', 'default', 'local', '2026-09-29', '2026-09-29', '{"expertId":"reviewer"}'
        )
      `;
      yield* sql`
        INSERT INTO expert_applied_runtime_records (
          thread_id, snapshot_id, provider, model, runtime_component,
          runtime_version, lifecycle_generation, applied_at
        ) VALUES (
          'legacy-thread', 'snapshot-1', 'codex', 'gpt', 'engine', '1.2.3', 'generation-1', '2026-09-29'
        )
      `;

      const adopted = yield* adoptLegacyExpertMigrations();
      assert.deepStrictEqual(adopted.adoptedMigrationIds, [1, 2]);
      yield* runMigrations();

      const officialRows = yield* sql<{ readonly migration_id: number; readonly name: string }>`
        SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id
      `;
      assert.strictEqual(officialRows.length, currentOfficialMigrationEntryCount());
      assert.strictEqual(officialRows[107]?.name, "GatewayCompletions");
      assert.deepStrictEqual(officialRows.at(-1), {
        migration_id: 135,
        name: "ProjectionMessageTurnActivityIndex",
      });

      const binding = yield* sql<{ readonly expert_binding_json: string }>`
        SELECT expert_binding_json FROM projection_threads WHERE thread_id = 'legacy-thread'
      `;
      assert.strictEqual(binding[0]?.expert_binding_json, '{"expertId":"reviewer"}');
      const runtime = yield* sql<{
        readonly snapshot_id: string;
        readonly lifecycle_generation: string;
      }>`
        SELECT snapshot_id, lifecycle_generation
        FROM expert_applied_runtime_records WHERE thread_id = 'legacy-thread'
      `;
      assert.deepStrictEqual(runtime, [
        { snapshot_id: "snapshot-1", lifecycle_generation: "generation-1" },
      ]);

      const extension = yield* sql<{
        readonly migration_id: number;
        readonly name: string;
        readonly checksum: string;
      }>`
        SELECT migration_id, name, checksum FROM workbench_sql_migrations
        WHERE module_id = 'expert'
        ORDER BY module_id, migration_id
      `;
      assert.deepStrictEqual(
        extension.map(({ migration_id, name, checksum }) => [migration_id, name, checksum]),
        workbenchMigrationEntries
          .slice(0, 2)
          .map(({ migrationId, name, checksum }) => [migrationId, name, checksum]),
      );
      const contextUpgrade = yield* runWorkbenchMigrations();
      assert.deepStrictEqual(
        contextUpgrade.executed.map(({ moduleId, migrationId }) => [moduleId, migrationId]),
        [
          ...workbenchMigrationEntries.slice(2).map(({ migrationId }) => ["expert", migrationId]),
          ["context", 1],
        ],
      );
      const rerun = yield* runWorkbenchMigrations();
      assert.deepStrictEqual(rerun.executed, []);
    }),
  );
});

const partialAdoptionLayer = it.layer(NodeSqliteClient.layerMemory());
partialAdoptionLayer("legacy 109 intermediate handoff", (test) => {
  test.effect("adopts 109 and applies only the missing extension migration", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seedLegacyExpertHistory(109);
      const adopted = yield* adoptLegacyExpertMigrations();
      assert.deepStrictEqual(adopted.adoptedMigrationIds, [1]);
      yield* runMigrations();

      const result = yield* runWorkbenchMigrations();
      assert.deepStrictEqual(
        result.executed.map(({ moduleId, migrationId }) => [moduleId, migrationId]),
        [
          ...workbenchMigrationEntries.slice(1).map(({ migrationId }) => ["expert", migrationId]),
          ["context", 1],
        ],
      );
      const rows = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM workbench_sql_migrations WHERE module_id = 'expert'
      `;
      assert.strictEqual(rows[0]?.count, workbenchMigrationEntries.length);
    }),
  );
});

const freshUpgradeLayer = it.layer(NodeSqliteClient.layerMemory());
freshUpgradeLayer("fresh workbench extension migration", (test) => {
  test.effect("runs static expert migrations once after the official baseline", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      const first = yield* runWorkbenchMigrations();
      const second = yield* runWorkbenchMigrations();
      assert.deepStrictEqual(
        first.executed.map(({ moduleId, migrationId }) => [moduleId, migrationId]),
        [
          ...workbenchMigrationEntries.map(({ migrationId }) => ["expert", migrationId]),
          ["context", 1],
        ],
      );
      assert.deepStrictEqual(second.executed, []);
      const format = yield* sql<{ readonly format_version: number }>`
        SELECT format_version FROM workbench_schema_metadata
      `;
      assert.deepStrictEqual(format, [{ format_version: WORKBENCH_SCHEMA_FORMAT_VERSION }]);
      const columns = yield* sql<{ readonly name: string; readonly pk: number }>`
        SELECT name, pk FROM pragma_table_info('hub_expert_participants') ORDER BY pk
      `;
      assert.deepStrictEqual(columns, [
        { name: "hub_id", pk: 1 },
        { name: "expert_id", pk: 2 },
      ]);
      const learningTables = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name IN (
          'expert_learning_states',
          'expert_learning_evidence',
          'expert_learning_cycles'
        )
        ORDER BY name
      `;
      assert.deepStrictEqual(
        learningTables.map(({ name }) => name),
        ["expert_learning_cycles", "expert_learning_evidence", "expert_learning_states"],
      );
      const learningIndexes = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master
        WHERE type = 'index' AND name IN (
          'expert_learning_states_updated',
          'expert_learning_evidence_owner_expert',
          'expert_learning_cycles_owner_expert'
        )
        ORDER BY name
      `;
      assert.deepStrictEqual(
        learningIndexes.map(({ name }) => name),
        [
          "expert_learning_cycles_owner_expert",
          "expert_learning_evidence_owner_expert",
          "expert_learning_states_updated",
        ],
      );
      const foreignKeys = yield* sql<{
        readonly table: string;
        readonly from: string;
        readonly to: string;
        readonly on_delete: string;
      }>`
        SELECT "table", "from", "to", on_delete
        FROM pragma_foreign_key_list('hub_expert_participants')
      `;
      assert.deepStrictEqual(foreignKeys, [
        { table: "projection_projects", from: "hub_id", to: "project_id", on_delete: "CASCADE" },
      ]);
      const hubPlanTables = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name IN (
          'hub_plans',
          'hub_plan_revisions',
          'hub_plan_node_bindings',
          'hub_plan_attempt_bindings',
          'hub_plan_candidates',
          'hub_plan_reviews',
          'hub_plan_releases',
          'hub_plan_events',
          'hub_plan_operation_receipts',
          'hub_plan_outbox',
          'hub_plan_input_requests'
        )
        ORDER BY name
      `;
      assert.deepStrictEqual(
        hubPlanTables.map(({ name }) => name),
        [
          "hub_plan_attempt_bindings",
          "hub_plan_candidates",
          "hub_plan_events",
          "hub_plan_input_requests",
          "hub_plan_node_bindings",
          "hub_plan_operation_receipts",
          "hub_plan_outbox",
          "hub_plan_releases",
          "hub_plan_reviews",
          "hub_plan_revisions",
          "hub_plans",
        ],
      );
      const inputRequestColumns = yield* sql<{ readonly name: string }>`
        SELECT name FROM pragma_table_info('hub_plan_input_requests') ORDER BY cid
      `;
      assert.deepStrictEqual(
        inputRequestColumns.map(({ name }) => name),
        ["plan_id", "revision", "request_id", "record_json", "created_at", "updated_at"],
      );
      const activePlanIndex = yield* sql<{ readonly sql: string }>`
        SELECT sql FROM sqlite_master
        WHERE type = 'index' AND name = 'idx_hub_plans_one_nonterminal'
      `;
      assert.isTrue(
        activePlanIndex[0]?.sql?.includes("'active', 'pausing', 'paused', 'cancelling'"),
      );
      yield* sql`
        INSERT INTO projection_projects (
          project_id, title, workspace_root, scripts_json, created_at, updated_at
        ) VALUES ('hub-participants-test', 'Hub', '/tmp/hub', '[]', 'now', 'now')
      `;
      yield* sql`
        INSERT INTO hub_expert_participants (hub_id, expert_id)
        VALUES ('hub-participants-test', 'reviewer')
      `;
      yield* sql`DELETE FROM projection_projects WHERE project_id = 'hub-participants-test'`;
      const cascadedParticipants = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM hub_expert_participants
        WHERE hub_id = 'hub-participants-test'
      `;
      assert.strictEqual(cascadedParticipants[0]?.count, 0);
    }),
  );
});

const evidenceDeliveryUpgradeLayer = it.layer(NodeSqliteClient.layerMemory());
evidenceDeliveryUpgradeLayer("expert learning evidence delivery migration", (test) => {
  test.effect("applies migration 12 to an 11-entry ledger and preserves learning data", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      yield* sql.unsafe(`CREATE TABLE workbench_sql_migrations (
        module_id TEXT NOT NULL,
        migration_id INTEGER NOT NULL,
        name TEXT NOT NULL,
        checksum TEXT NOT NULL,
        applied_at TEXT NOT NULL,
        PRIMARY KEY (module_id, migration_id)
      )`);
      yield* sql.unsafe("CREATE TABLE workbench_schema_metadata (format_version INTEGER NOT NULL)");
      yield* sql`INSERT INTO workbench_schema_metadata (format_version) VALUES (1)`;

      for (const migration of workbenchMigrationEntries.slice(0, 11)) {
        if (migration.effect !== undefined) yield* migration.effect;
        else if (migration.statement !== undefined) yield* sql.unsafe(migration.statement);
        else throw new Error(`Migration ${migration.name} has no implementation`);
        yield* sql`
          INSERT INTO workbench_sql_migrations (
            module_id, migration_id, name, checksum, applied_at
          ) VALUES (
            ${migration.moduleId}, ${migration.migrationId}, ${migration.name},
            ${migration.checksum}, '2026-10-31T00:00:00.000Z'
          )
        `;
      }

      yield* sql`
        INSERT INTO expert_learning_states (owner_id, expert_id, record_json, revision, updated_at)
        VALUES ('owner-1', 'expert-1', '{"status":"active"}', 1, 'before')
      `;
      yield* sql`
        INSERT INTO expert_learning_evidence (
          evidence_id, owner_id, expert_id, thread_id, turn_id, record_json, updated_at
        ) VALUES ('evidence-1', 'owner-1', 'expert-1', 'thread-1', 'turn-1', '{"kind":"note"}', 'before')
      `;
      yield* sql`
        INSERT INTO expert_learning_cycles (cycle_id, owner_id, expert_id, record_json, updated_at)
        VALUES ('cycle-1', 'owner-1', 'expert-1', '{"status":"complete"}', 'before')
      `;
      const learningStateBefore =
        yield* sql`SELECT * FROM expert_learning_states ORDER BY owner_id, expert_id`;
      const learningEvidenceBefore =
        yield* sql`SELECT * FROM expert_learning_evidence ORDER BY evidence_id`;
      const learningCyclesBefore =
        yield* sql`SELECT * FROM expert_learning_cycles ORDER BY cycle_id`;
      const ledgerBefore = yield* sql<WorkbenchMigrationRecord>`
        SELECT module_id, migration_id, name, checksum, applied_at
        FROM workbench_sql_migrations ORDER BY module_id, migration_id
      `;
      assert.strictEqual(ledgerBefore.length, 11);

      const upgrade = yield* runWorkbenchMigrations();
      assert.deepStrictEqual(
        upgrade.executed.map(({ moduleId, migrationId }) => [moduleId, migrationId]),
        [
          ["expert", 12],
          ["context", 1],
        ],
      );
      assert.deepStrictEqual(
        yield* sql`SELECT * FROM expert_learning_states ORDER BY owner_id, expert_id`,
        learningStateBefore,
      );
      assert.deepStrictEqual(
        yield* sql`SELECT * FROM expert_learning_evidence ORDER BY evidence_id`,
        learningEvidenceBefore,
      );
      assert.deepStrictEqual(
        yield* sql`SELECT * FROM expert_learning_cycles ORDER BY cycle_id`,
        learningCyclesBefore,
      );

      const pendingColumns = yield* sql<{
        readonly name: string;
        readonly type: string;
        readonly notnull: number;
        readonly pk: number;
      }>`SELECT name, type, "notnull", pk FROM pragma_table_info('expert_learning_pending_evidence') ORDER BY cid`;
      assert.deepStrictEqual(pendingColumns, [
        { name: "capture_id", type: "TEXT", notnull: 0, pk: 1 },
        { name: "source_json", type: "TEXT", notnull: 1, pk: 0 },
        { name: "record_json", type: "TEXT", notnull: 1, pk: 0 },
        { name: "first_sequence", type: "INTEGER", notnull: 1, pk: 0 },
        { name: "last_sequence", type: "INTEGER", notnull: 1, pk: 0 },
        { name: "pending", type: "INTEGER", notnull: 1, pk: 0 },
        { name: "discarded", type: "INTEGER", notnull: 1, pk: 0 },
        { name: "updated_at", type: "TEXT", notnull: 1, pk: 0 },
      ]);
      const invalidPendingFlag = yield* Effect.flip(sql`
        INSERT INTO expert_learning_pending_evidence (
          capture_id, source_json, record_json, first_sequence, last_sequence,
          pending, discarded, updated_at
        ) VALUES ('capture-invalid', '{}', '{}', 1, 1, 2, 0, 'before')
      `);
      assert.isTrue(invalidPendingFlag instanceof Error);
      const pendingIndexColumns = yield* sql<{ readonly name: string }>`
        SELECT name FROM pragma_index_info('expert_learning_pending_evidence_pending') ORDER BY seqno
      `;
      assert.deepStrictEqual(
        pendingIndexColumns.map(({ name }) => name),
        ["pending", "first_sequence", "capture_id"],
      );

      const currentLedger = yield* sql<WorkbenchMigrationRecord>`
        SELECT module_id, migration_id, name, checksum, applied_at
        FROM workbench_sql_migrations ORDER BY module_id, migration_id
      `;
      const currentExpertLedger = currentLedger.filter(({ module_id }) => module_id === "expert");
      assert.deepStrictEqual(currentExpertLedger.slice(0, 11), ledgerBefore);
      assert.deepStrictEqual(currentExpertLedger.at(-1), {
        module_id: "expert",
        migration_id: 12,
        name: "ExpertLearningEvidenceDelivery",
        checksum: "sha256:38b2eda40b36b010e44234a78232664299a7031ba98fafe9414557c1261a71a5",
        applied_at: currentExpertLedger.at(-1)?.applied_at,
      });
    }),
  );
});

const rollbackLayer = it.layer(NodeSqliteClient.layerMemory());
rollbackLayer("transactional legacy expert handoff", (test) => {
  test.effect("retains legacy rows and rolls back partial ledger writes", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seedLegacyExpertHistory(109);
      yield* sql`
        CREATE TABLE workbench_sql_migrations (
          module_id TEXT NOT NULL,
          migration_id INTEGER NOT NULL,
          name TEXT NOT NULL,
          checksum TEXT NOT NULL,
          applied_at TEXT NOT NULL,
          PRIMARY KEY (module_id, migration_id)
        )
      `;
      yield* sql`
        CREATE TRIGGER reject_workbench_insert
        BEFORE INSERT ON workbench_sql_migrations
        BEGIN SELECT RAISE(ABORT, 'reject adoption'); END
      `;

      const failure = yield* Effect.flip(adoptLegacyExpertMigrations());
      assert.isTrue(failure instanceof WorkbenchMigrationError || failure instanceof Error);
      const oldRows = yield* sql<{ readonly migration_id: number }>`
        SELECT migration_id FROM effect_sql_migrations WHERE migration_id >= 109 ORDER BY migration_id
      `;
      const newRows = yield* sql<{ readonly migration_id: number }>`
        SELECT migration_id FROM workbench_sql_migrations ORDER BY migration_id
      `;
      const formatTable = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name = 'workbench_schema_metadata'
      `;
      assert.deepStrictEqual(
        oldRows.map(({ migration_id }) => migration_id),
        [109],
      );
      assert.deepStrictEqual(newRows, []);
      assert.deepStrictEqual(formatTable, []);
    }),
  );
});

const tooNewLayer = it.layer(NodeSqliteClient.layerMemory());
tooNewLayer("future workbench migration history", (test) => {
  test.effect("refuses a future extension version without changing its tracker", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 108 });
      yield* sql`
        CREATE TABLE workbench_sql_migrations (
          module_id TEXT NOT NULL,
          migration_id INTEGER NOT NULL,
          name TEXT NOT NULL,
          checksum TEXT NOT NULL,
          applied_at TEXT NOT NULL,
          PRIMARY KEY (module_id, migration_id)
        )
      `;
      yield* sql`
        INSERT INTO workbench_sql_migrations
          (module_id, migration_id, name, checksum, applied_at)
        VALUES ('expert', 3, 'FutureExpertMigration', 'sha256:future', '2026-09-29')
      `;
      const before = yield* sql<WorkbenchMigrationRecord>`
        SELECT module_id, migration_id, name, checksum, applied_at
        FROM workbench_sql_migrations
      `;
      const failure = yield* Effect.flip(runWorkbenchMigrations());
      assert.isTrue(failure instanceof WorkbenchMigrationError);
      const after = yield* sql<WorkbenchMigrationRecord>`
        SELECT module_id, migration_id, name, checksum, applied_at
        FROM workbench_sql_migrations
      `;
      assert.deepStrictEqual(after, before);
    }),
  );

  test.effect("refuses a future data format before creating extension history", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 108 });
      yield* sql`CREATE TABLE workbench_schema_metadata (format_version INTEGER NOT NULL)`;
      yield* sql`INSERT INTO workbench_schema_metadata (format_version) VALUES (2)`;

      const before = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name = 'workbench_sql_migrations'
      `;
      const failure = yield* Effect.flip(runWorkbenchMigrations());
      assert.isTrue(failure instanceof WorkbenchMigrationError);
      const after = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name = 'workbench_sql_migrations'
      `;
      assert.deepStrictEqual(after, before);
      const version = yield* sql<{ readonly format_version: number }>`
        SELECT format_version FROM workbench_schema_metadata
      `;
      assert.deepStrictEqual(version, [{ format_version: 2 }]);
    }),
  );
});
