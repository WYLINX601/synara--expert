import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { createHash } from "node:crypto";

import { migrationEntries } from "../../persistence/Migrations.ts";

export const WORKBENCH_MIGRATIONS_TABLE = "workbench_sql_migrations";
export const EXPERT_WORKBENCH_MODULE_ID = "expert";

/**
 * These are the exact legacy identities that were temporarily stored in the
 * official tracker. Keep them independent from today's official catalog: a
 * later Synara release may reuse either numeric slot for an official change.
 */
export const LEGACY_EXPERT_OFFICIAL_MIGRATIONS = [
  { officialId: 109, officialName: "ProjectionThreadsExpertBinding", workbenchId: 1 },
  { officialId: 110, officialName: "ExpertAppliedRuntimeRecords", workbenchId: 2 },
] as const;

const FROZEN_LEGACY_OFFICIAL_PREFIX_LENGTH = 108;
const FROZEN_LEGACY_OFFICIAL_PREFIX_SHA256 =
  "90e752819eb4bc22f406af1b2c7fdbe6c5667973e3ec832c1d5e31568108ea15";

const PROJECTION_THREADS_BINDING_COLUMN = {
  name: "expert_binding_json",
  type: "TEXT",
  notnull: 0,
  dflt_value: null,
  pk: 0,
} as const;

const EXPERT_RUNTIME_RECORD_COLUMNS = [
  { name: "thread_id", type: "TEXT", notnull: 0, dflt_value: null, pk: 1 },
  { name: "snapshot_id", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
  { name: "provider", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
  { name: "model", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
  { name: "runtime_component", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
  { name: "runtime_version", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
  { name: "lifecycle_generation", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
  { name: "applied_at", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
] as const;

const WORKBENCH_MIGRATIONS_DDL = `CREATE TABLE workbench_sql_migrations (
  module_id TEXT NOT NULL,
  migration_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  checksum TEXT NOT NULL,
  applied_at TEXT NOT NULL,
  PRIMARY KEY (module_id, migration_id)
)`;

export class WorkbenchMigrationError extends Schema.TaggedErrorClass<WorkbenchMigrationError>()(
  "WorkbenchMigrationError",
  { reason: Schema.String },
) {
  override get message(): string {
    return this.reason;
  }
}

export interface SqliteColumnInfo {
  readonly name: string;
  readonly type: string;
  readonly notnull: number;
  readonly dflt_value: string | null;
  readonly pk: number;
}

export interface WorkbenchMigrationRecord {
  readonly module_id: string;
  readonly migration_id: number;
  readonly name: string;
  readonly checksum: string;
  readonly applied_at: string;
}

export interface OfficialMigrationRecord {
  readonly migration_id: number;
  readonly name: string;
}

export interface WorkbenchSchemaState {
  readonly projectionThreadsExists: boolean;
  readonly bindingColumn: SqliteColumnInfo | null;
  readonly runtimeRecordColumns: readonly SqliteColumnInfo[] | null;
}

export interface WorkbenchMigrationDefinition {
  readonly moduleId: string;
  readonly migrationId: number;
  readonly name: string;
  readonly checksum: string;
  readonly statement: string;
}

const isLegacyExpertIdentity = (id: number, name: string) =>
  LEGACY_EXPERT_OFFICIAL_MIGRATIONS.some(
    (migration) => migration.officialId === id && migration.officialName === name,
  );

const currentOfficialMigrationEntries = () =>
  migrationEntries
    .filter(([id, name]) => !isLegacyExpertIdentity(id, name))
    .toSorted(([a], [b]) => a - b);

export const validateOfficialMigrationPrefixAgainstCatalog = (
  rows: readonly OfficialMigrationRecord[],
  catalog: readonly (readonly [number, string, unknown])[],
): string | null => {
  const expectedEntries = catalog.toSorted(([a], [b]) => a - b);
  if (rows.length > expectedEntries.length) {
    return `Official migration ${rows[expectedEntries.length]?.migration_id ?? expectedEntries.length + 1} is newer than this build supports.`;
  }
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]!;
    const expected = expectedEntries[index];
    if (expected === undefined || row.migration_id !== expected[0]) {
      return `Official migration history is not a supported prefix at ${index + 1}.`;
    }
    if (row.name !== expected[1]) {
      return `Official migration ${row.migration_id} has an unknown name; expected ${expected[1]}.`;
    }
  }
  return null;
};

/** Validate against the current official catalog, excluding only the exact historical expert rows. */
export const validateCurrentOfficialMigrationPrefix = (
  rows: readonly OfficialMigrationRecord[],
): string | null =>
  validateOfficialMigrationPrefixAgainstCatalog(rows, currentOfficialMigrationEntries());

/** Validate the frozen official history that existed before expert IDs 109/110 were added. */
export const validateFrozenLegacyOfficialPrefix = (
  rows: readonly OfficialMigrationRecord[],
): string | null => {
  if (
    rows.length < FROZEN_LEGACY_OFFICIAL_PREFIX_LENGTH + 1 ||
    rows.length > FROZEN_LEGACY_OFFICIAL_PREFIX_LENGTH + LEGACY_EXPERT_OFFICIAL_MIGRATIONS.length
  ) {
    return "The legacy expert migrations do not follow the frozen official prefix.";
  }
  const frozenPrefix = rows.slice(0, FROZEN_LEGACY_OFFICIAL_PREFIX_LENGTH);
  if (
    frozenPrefix.some((row, index) => row.migration_id !== index + 1) ||
    createHash("sha256")
      .update(JSON.stringify(frozenPrefix.map(({ migration_id, name }) => [migration_id, name])))
      .digest("hex") !== FROZEN_LEGACY_OFFICIAL_PREFIX_SHA256
  ) {
    return "The official migration prefix before legacy expert migrations is not recognized.";
  }
  const legacyTail = rows.slice(FROZEN_LEGACY_OFFICIAL_PREFIX_LENGTH);
  for (let index = 0; index < legacyTail.length; index += 1) {
    const row = legacyTail[index]!;
    const expected = LEGACY_EXPERT_OFFICIAL_MIGRATIONS[index];
    if (
      expected === undefined ||
      row.migration_id !== expected.officialId ||
      row.name !== expected.officialName
    ) {
      return `Legacy official migration ${row.migration_id} has an unknown name or order.`;
    }
  }
  return null;
};

export const currentOfficialMigrationCount = () => currentOfficialMigrationEntries().length;

/**
 * Expert-owned extensions intentionally use local IDs. These checksums cover
 * the canonical SQL statements; changing an applied migration requires a new
 * ID rather than rewriting its history.
 */
export const workbenchMigrationEntries: readonly WorkbenchMigrationDefinition[] = [
  {
    moduleId: EXPERT_WORKBENCH_MODULE_ID,
    migrationId: 1,
    name: "ProjectionThreadsExpertBinding",
    checksum: "sha256:7c1841c76b12dd5bc62bc9ae8a1a0ebedd38672386d621b67ad8d0894c0b67db",
    statement: "ALTER TABLE projection_threads ADD COLUMN expert_binding_json TEXT",
  },
  {
    moduleId: EXPERT_WORKBENCH_MODULE_ID,
    migrationId: 2,
    name: "ExpertAppliedRuntimeRecords",
    checksum: "sha256:fb5efd19411fc0445ad0a2eabbe52e3115f4cf1a29a9f044fe868689e59889a7",
    statement:
      "CREATE TABLE expert_applied_runtime_records (thread_id TEXT PRIMARY KEY, snapshot_id TEXT NOT NULL, provider TEXT NOT NULL, model TEXT, runtime_component TEXT, runtime_version TEXT, lifecycle_generation TEXT NOT NULL, applied_at TEXT NOT NULL)",
  },
];

export interface WorkbenchHistoryPlan {
  readonly ok: true;
  readonly applied: readonly WorkbenchMigrationDefinition[];
}

export interface InvalidWorkbenchHistoryPlan {
  readonly ok: false;
  readonly reason: string;
}

export const planWorkbenchHistory = (
  rows: readonly WorkbenchMigrationRecord[],
): WorkbenchHistoryPlan | InvalidWorkbenchHistoryPlan => {
  for (const migration of workbenchMigrationEntries) {
    const expectedChecksum = `sha256:${createHash("sha256")
      .update(migration.statement)
      .digest("hex")}`;
    if (migration.checksum !== expectedChecksum) {
      return {
        ok: false,
        reason: `Expert workbench migration ${migration.migrationId} has a stale source checksum.`,
      };
    }
  }

  const ordered = rows.toSorted(
    (a, b) => a.module_id.localeCompare(b.module_id) || a.migration_id - b.migration_id,
  );
  const modules = new Set(ordered.map((row) => row.module_id));
  if ([...modules].some((moduleId) => moduleId !== EXPERT_WORKBENCH_MODULE_ID)) {
    return { ok: false, reason: "The workbench migration tracker contains an unsupported module." };
  }

  const expertRows = ordered.filter((row) => row.module_id === EXPERT_WORKBENCH_MODULE_ID);
  const applied: WorkbenchMigrationDefinition[] = [];
  for (let index = 0; index < expertRows.length; index += 1) {
    const row = expertRows[index]!;
    const expectedId = index + 1;
    if (row.migration_id > workbenchMigrationEntries.length) {
      return {
        ok: false,
        reason: `Workbench migration ${row.migration_id} is newer than this build supports.`,
      };
    }
    if (row.migration_id !== expectedId) {
      return {
        ok: false,
        reason: `Expert workbench migration history is not a contiguous prefix at ${expectedId}.`,
      };
    }
    const expected = workbenchMigrationEntries[index];
    if (
      expected === undefined ||
      row.name !== expected.name ||
      row.checksum !== expected.checksum ||
      row.applied_at.length === 0
    ) {
      return {
        ok: false,
        reason: `Expert workbench migration ${row.migration_id} has an unknown name, checksum, or timestamp.`,
      };
    }
    applied.push(expected);
  }

  return { ok: true, applied };
};

export const validateWorkbenchSchemaState = (
  appliedMigrationCount: number,
  state: WorkbenchSchemaState,
): string | null => {
  if (!state.projectionThreadsExists) {
    if (
      appliedMigrationCount === 0 &&
      state.bindingColumn === null &&
      state.runtimeRecordColumns === null
    ) {
      return null;
    }
    return "The official projection_threads table is missing; run official migrations through 108 first.";
  }

  const bindingApplied = appliedMigrationCount >= 1;
  if (bindingApplied) {
    if (
      state.bindingColumn === null ||
      !sameColumn(state.bindingColumn, PROJECTION_THREADS_BINDING_COLUMN)
    ) {
      return "projection_threads.expert_binding_json does not match the expert migration schema.";
    }
  } else if (state.bindingColumn !== null) {
    return "projection_threads.expert_binding_json exists without a matching workbench migration record.";
  }

  const runtimeRecordsApplied = appliedMigrationCount >= 2;
  if (runtimeRecordsApplied) {
    if (
      state.runtimeRecordColumns === null ||
      !sameColumns(state.runtimeRecordColumns, EXPERT_RUNTIME_RECORD_COLUMNS)
    ) {
      return "expert_applied_runtime_records does not match the expert migration schema.";
    }
  } else if (state.runtimeRecordColumns !== null) {
    return "expert_applied_runtime_records exists without a matching workbench migration record.";
  }

  return null;
};

const sameColumn = (
  actual: SqliteColumnInfo,
  expected: Pick<SqliteColumnInfo, "name" | "type" | "notnull" | "dflt_value" | "pk">,
) =>
  actual.name === expected.name &&
  actual.type.toUpperCase() === expected.type &&
  actual.notnull === expected.notnull &&
  actual.dflt_value === expected.dflt_value &&
  actual.pk === expected.pk;

const sameColumns = (
  actual: readonly SqliteColumnInfo[],
  expected: readonly Pick<SqliteColumnInfo, "name" | "type" | "notnull" | "dflt_value" | "pk">[],
) =>
  actual.length === expected.length &&
  actual.every((column, index) => {
    const expectedColumn = expected[index];
    return expectedColumn !== undefined && sameColumn(column, expectedColumn);
  });

const fail = (reason: string) => Effect.fail(new WorkbenchMigrationError({ reason }));

export const inspectSqliteObject = (sql: SqlClient.SqlClient, name: string) =>
  sql<{ readonly type: string; readonly sql: string | null }>`
    SELECT type, sql FROM sqlite_master WHERE name = ${name}
  `.pipe(
    Effect.map((rows) => {
      const object = rows[0];
      if (object === undefined) return null;
      if (object.type !== "table") {
        return { type: object.type, sql: object.sql };
      }
      return { type: object.type, sql: object.sql };
    }),
  );

export const inspectTableColumns = (sql: SqlClient.SqlClient, name: string) =>
  sql<SqliteColumnInfo>`
    SELECT name, type, "notnull", dflt_value, pk
    FROM pragma_table_info(${name}) ORDER BY cid
  `;

export const readOfficialMigrationRecords = (sql: SqlClient.SqlClient) =>
  sql<OfficialMigrationRecord>`
    SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id ASC
  `;

export const validateOfficialTrackerShape = (columns: readonly SqliteColumnInfo[]) => {
  const expected = [
    { name: "migration_id", type: "INTEGER", notnull: 1, dflt_value: null, pk: 1 },
    {
      name: "created_at",
      type: "DATETIME",
      notnull: 1,
      dflt_value: "current_timestamp",
      pk: 0,
    },
    { name: "name", type: "VARCHAR(255)", notnull: 1, dflt_value: null, pk: 0 },
  ] as const;
  if (columns.length !== expected.length) return false;
  return columns.every((column, index) => {
    const expectedColumn = expected[index];
    const defaultValue =
      column.dflt_value
        ?.trim()
        .replace(/^\((.*)\)$/, "$1")
        .toLowerCase() ?? null;
    return (
      expectedColumn !== undefined &&
      column.name === expectedColumn.name &&
      column.type.toUpperCase() === expectedColumn.type &&
      column.notnull === expectedColumn.notnull &&
      defaultValue === expectedColumn.dflt_value &&
      column.pk === expectedColumn.pk
    );
  });
};

export const readAndValidateOfficialMigrationState = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const tracker = yield* inspectSqliteObject(sql, "effect_sql_migrations");
  if (tracker === null || tracker.type !== "table") {
    return yield* fail("The official effect_sql_migrations table is missing or is not a table.");
  }
  const columns = yield* inspectTableColumns(sql, "effect_sql_migrations");
  if (!validateOfficialTrackerShape(columns)) {
    return yield* fail("The official effect_sql_migrations table has an unsupported schema.");
  }
  const rows = yield* readOfficialMigrationRecords(sql);
  return { sql, rows };
});

export const validateWorkbenchTrackerShape = (columns: readonly SqliteColumnInfo[]) => {
  const expected = [
    { name: "module_id", type: "TEXT", notnull: 1, dflt_value: null, pk: 1 },
    { name: "migration_id", type: "INTEGER", notnull: 1, dflt_value: null, pk: 2 },
    { name: "name", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
    { name: "checksum", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
    { name: "applied_at", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
  ] as const;
  return sameColumns(columns, expected);
};

export const readWorkbenchTracker = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const tracker = yield* inspectSqliteObject(sql, WORKBENCH_MIGRATIONS_TABLE);
  if (tracker === null) return { exists: false as const, rows: [] as const };
  if (tracker.type !== "table") {
    return yield* fail("workbench_sql_migrations exists but is not a table.");
  }
  const columns = yield* inspectTableColumns(sql, WORKBENCH_MIGRATIONS_TABLE);
  if (!validateWorkbenchTrackerShape(columns)) {
    return yield* fail("workbench_sql_migrations has an unsupported schema.");
  }
  const rows = yield* sql<WorkbenchMigrationRecord>`
    SELECT module_id, migration_id, name, checksum, applied_at
    FROM workbench_sql_migrations ORDER BY module_id ASC, migration_id ASC
  `;
  return { exists: true as const, rows };
});

export const readWorkbenchSchemaState = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const projectionThreads = yield* inspectSqliteObject(sql, "projection_threads");
  if (projectionThreads !== null && projectionThreads.type !== "table") {
    return yield* fail("projection_threads exists but is not a table.");
  }
  const projectionThreadsExists = projectionThreads !== null;
  const projectionColumns = projectionThreadsExists
    ? yield* inspectTableColumns(sql, "projection_threads")
    : [];
  const bindingColumn =
    projectionColumns.find((column) => column.name === "expert_binding_json") ?? null;

  const runtimeTable = yield* inspectSqliteObject(sql, "expert_applied_runtime_records");
  if (runtimeTable !== null && runtimeTable.type !== "table") {
    return yield* fail("expert_applied_runtime_records exists but is not a table.");
  }
  const runtimeRecordColumns =
    runtimeTable === null
      ? null
      : yield* inspectTableColumns(sql, "expert_applied_runtime_records");
  return { projectionThreadsExists, bindingColumn, runtimeRecordColumns };
});

export const ensureWorkbenchTracker = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const tracker = yield* inspectSqliteObject(sql, WORKBENCH_MIGRATIONS_TABLE);
  if (tracker === null) {
    yield* sql.unsafe(WORKBENCH_MIGRATIONS_DDL);
  } else if (tracker.type !== "table") {
    return yield* fail("workbench_sql_migrations exists but is not a table.");
  }
  const columns = yield* inspectTableColumns(sql, WORKBENCH_MIGRATIONS_TABLE);
  if (!validateWorkbenchTrackerShape(columns)) {
    return yield* fail("workbench_sql_migrations has an unsupported schema.");
  }
});

export interface RunWorkbenchMigrationsResult {
  readonly executed: readonly WorkbenchMigrationDefinition[];
}

/**
 * Runs only the expert-owned extension migrations. Startup and backup/recovery
 * integration are intentionally left to the next WB-02 slice.
 */
export const runWorkbenchMigrations = () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const official = yield* readAndValidateOfficialMigrationState;
    const officialIssue = validateCurrentOfficialMigrationPrefix(official.rows);
    if (officialIssue !== null) return yield* fail(officialIssue);
    if (official.rows.length !== currentOfficialMigrationCount()) {
      return yield* fail(
        "The complete current official migration prefix must be applied before workbench migrations run.",
      );
    }

    yield* sql.withTransaction(ensureWorkbenchTracker);

    const initialTracker = yield* readWorkbenchTracker;
    const initialPlan = planWorkbenchHistory(initialTracker.rows);
    if (!initialPlan.ok) return yield* fail(initialPlan.reason);
    const initialSchema = yield* readWorkbenchSchemaState;
    const schemaIssue = validateWorkbenchSchemaState(initialPlan.applied.length, initialSchema);
    if (schemaIssue !== null) return yield* fail(schemaIssue);

    const executed: WorkbenchMigrationDefinition[] = [];
    for (const migration of workbenchMigrationEntries.slice(initialPlan.applied.length)) {
      yield* sql.withTransaction(
        Effect.gen(function* () {
          const tracker = yield* readWorkbenchTracker;
          const plan = planWorkbenchHistory(tracker.rows);
          if (!plan.ok) return yield* fail(plan.reason);
          if (plan.applied.length !== migration.migrationId - 1) {
            return yield* fail("Expert workbench migration history changed during upgrade.");
          }
          const schema = yield* readWorkbenchSchemaState;
          const issue = validateWorkbenchSchemaState(plan.applied.length, schema);
          if (issue !== null) return yield* fail(issue);

          yield* sql.unsafe(migration.statement);
          yield* sql`
            INSERT INTO workbench_sql_migrations (
              module_id, migration_id, name, checksum, applied_at
            ) VALUES (
              ${migration.moduleId}, ${migration.migrationId}, ${migration.name},
              ${migration.checksum}, ${new Date().toISOString()}
            )
          `;
        }),
      );
      executed.push(migration);
    }

    const finalTracker = yield* readWorkbenchTracker;
    const finalPlan = planWorkbenchHistory(finalTracker.rows);
    if (!finalPlan.ok) return yield* fail(finalPlan.reason);
    const finalSchema = yield* readWorkbenchSchemaState;
    const finalIssue = validateWorkbenchSchemaState(finalPlan.applied.length, finalSchema);
    if (finalIssue !== null) return yield* fail(finalIssue);
    return { executed };
  });
