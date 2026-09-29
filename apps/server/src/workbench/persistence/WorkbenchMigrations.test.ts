import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { migrationEntries, runMigrations } from "../../persistence/Migrations.ts";
import * as NodeSqliteClient from "../../persistence/NodeSqliteClient.ts";
import {
  EXPERT_WORKBENCH_MODULE_ID,
  LEGACY_EXPERT_OFFICIAL_MIGRATIONS,
  WorkbenchMigrationError,
  currentOfficialMigrationCount,
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

const frozenOfficialPrefix = migrationEntries
  .filter(([id]) => id <= 108)
  .map(([migration_id, name]) => ({ migration_id, name }));

const legacyRows = (through: 109 | 110): readonly OfficialMigrationRecord[] => [
  ...frozenOfficialPrefix,
  ...LEGACY_EXPERT_OFFICIAL_MIGRATIONS.filter(({ officialId }) => officialId <= through).map(
    ({ officialId: migration_id, officialName: name }) => ({ migration_id, name }),
  ),
];

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
  projectionThreadsExists: true,
  bindingColumn,
  runtimeRecordColumns: null,
} as const;

const adopted110Schema = {
  projectionThreadsExists: true,
  bindingColumn,
  runtimeRecordColumns,
} as const;

const workbenchRows = (count: 0 | 1 | 2): readonly WorkbenchMigrationRecord[] =>
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
    const future = [{ ...workbenchRows(1)[0]!, migration_id: 3, name: "FutureExpertMigration" }];
    const unsupportedModule = [{ ...workbenchRows(1)[0]!, module_id: "future-module" }];

    assert.isFalse(planWorkbenchHistory(wrongChecksum).ok);
    assert.isFalse(planWorkbenchHistory(wrongName).ok);
    assert.isFalse(planWorkbenchHistory(gap).ok);
    assert.isFalse(planWorkbenchHistory(future).ok);
    assert.isFalse(planWorkbenchHistory(unsupportedModule).ok);
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
      { kind: "adopt", migrationIds: [1] },
    );
    assert.deepStrictEqual(
      planLegacyExpertMigrationAdoption({
        ...prefix,
        officialRows: legacyRows(110),
        schemaState: adopted110Schema,
      }),
      { kind: "adopt", migrationIds: [1, 2] },
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

it.effect("allows an empty database to pass pre-migration history recognition", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const result = yield* adoptLegacyExpertMigrations();
    assert.deepStrictEqual(result, { adoptedMigrationIds: [] });
    const tables = yield* sql<{ readonly name: string }>`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name IN ('effect_sql_migrations', 'workbench_sql_migrations', 'projection_threads')
    `;
    assert.deepStrictEqual(tables, []);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it.effect("accepts a current official catalog that has reused legacy numeric IDs", () =>
  Effect.sync(() => {
    const catalog = [
      ...migrationEntries.filter(([id]) => id <= 108),
      [109, "OfficialChangeAfterSplit", Effect.void] as const,
    ];
    const rows: OfficialMigrationRecord[] = [
      ...frozenOfficialPrefix,
      { migration_id: 109, name: "OfficialChangeAfterSplit" },
    ];
    assert.isNull(validateOfficialMigrationPrefixAgainstCatalog(rows, catalog));
    assert.isNull(validateCurrentOfficialMigrationPrefix(frozenOfficialPrefix));
    assert.strictEqual(currentOfficialMigrationCount(), 108);
  }),
);

it.effect("validates extension schema only after the official projection exists", () =>
  Effect.sync(() => {
    assert.isNull(
      validateWorkbenchSchemaState(0, {
        projectionThreadsExists: false,
        bindingColumn: null,
        runtimeRecordColumns: null,
      }),
    );
    assert.isNotNull(
      validateWorkbenchSchemaState(1, {
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
      yield* runMigrations({ toMigrationInclusive: 109 });
      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, model_selection_json, runtime_mode,
          interaction_mode, env_mode, created_at, updated_at, expert_binding_json
        ) VALUES (
          'legacy-thread', 'project', 'Legacy', '{"provider":"codex","model":"gpt"}',
          'full-access', 'default', 'local', '2026-09-29', '2026-09-29', '{"expertId":"reviewer"}'
        )
      `;
      yield* runMigrations();
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

      const officialRows = yield* sql<{ readonly migration_id: number; readonly name: string }>`
        SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id
      `;
      assert.strictEqual(officialRows.length, 108);
      assert.strictEqual(officialRows[107]?.name, "GatewayCompletions");

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
        ORDER BY module_id, migration_id
      `;
      assert.deepStrictEqual(
        extension.map(({ migration_id, name, checksum }) => [migration_id, name, checksum]),
        workbenchMigrationEntries.map(({ migrationId, name, checksum }) => [
          migrationId,
          name,
          checksum,
        ]),
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
      yield* runMigrations({ toMigrationInclusive: 109 });
      const adopted = yield* adoptLegacyExpertMigrations();
      assert.deepStrictEqual(adopted.adoptedMigrationIds, [1]);

      const result = yield* runWorkbenchMigrations();
      assert.deepStrictEqual(
        result.executed.map(({ migrationId }) => migrationId),
        [2],
      );
      const rows = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM workbench_sql_migrations WHERE module_id = 'expert'
      `;
      assert.strictEqual(rows[0]?.count, 2);
    }),
  );
});

const freshUpgradeLayer = it.layer(NodeSqliteClient.layerMemory());
freshUpgradeLayer("fresh workbench extension migration", (test) => {
  test.effect("runs static expert migrations once after the official baseline", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 108 });
      const first = yield* runWorkbenchMigrations();
      const second = yield* runWorkbenchMigrations();
      assert.deepStrictEqual(
        first.executed.map(({ migrationId }) => migrationId),
        [1, 2],
      );
      assert.deepStrictEqual(second.executed, []);
    }),
  );
});

const rollbackLayer = it.layer(NodeSqliteClient.layerMemory());
rollbackLayer("transactional legacy expert handoff", (test) => {
  test.effect("retains legacy rows and rolls back partial ledger writes", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 109 });
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
      assert.deepStrictEqual(
        oldRows.map(({ migration_id }) => migration_id),
        [109],
      );
      assert.deepStrictEqual(newRows, []);
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
});
