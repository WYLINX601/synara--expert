import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { createHash } from "node:crypto";

import {
  planLegacyMigration32Rename,
  planMigrationLineageAliasRepairs,
} from "../../persistence/Migrations.ts";
import { migrationEntries } from "../../persistence/Migrations.ts";
import ContextV1Migration from "../../persistence/Migrations/111_ContextV1.ts";
import { HUB_PROJECT_ORIGIN_SQL } from "./HubProjectOriginMigration.ts";
import { HUB_EXPERT_V1_SQL, HUB_EXPERT_V1_EFFECT } from "./HubExpertV1Migration.ts";
import { HUB_EXPERT_PARTICIPANTS_SQL } from "./HubExpertParticipantsMigration.ts";
import {
  HUB_COLLABORATION_V1_SQL,
  HUB_COLLABORATION_V1_EFFECT,
} from "./HubCollaborationMigration.ts";
import { HUB_PLAN_SQL, HUB_PLAN_EFFECT } from "./HubPlanMigration.ts";
import { HUB_PLAN_INPUT_REQUEST_SQL, HUB_PLAN_INPUT_REQUEST_EFFECT } from "./HubPlanMigration.ts";
import { SKILL_EVOLUTION_SQL, SKILL_EVOLUTION_EFFECT } from "./SkillEvolutionMigration.ts";
import { EXPERT_LEARNING_SQL, EXPERT_LEARNING_EFFECT } from "./ExpertLearningMigration.ts";
import {
  CONTEXT_SCHEMA_OBJECTS_QUERY,
  validateFrozenContextSchema,
  type SqliteSchemaObject,
} from "./FrozenContextSchema.ts";

export const WORKBENCH_MIGRATIONS_TABLE = "workbench_sql_migrations";
export const WORKBENCH_SCHEMA_METADATA_TABLE = "workbench_schema_metadata";
export const WORKBENCH_SCHEMA_FORMAT_VERSION = 1;
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
export const LEGACY_CONTEXT_OFFICIAL_MIGRATIONS = [
  { officialId: 111, officialName: "ContextV1", workbenchId: 1 },
] as const;
export const LEGACY_OFFICIAL_MIGRATIONS = [
  ...LEGACY_EXPERT_OFFICIAL_MIGRATIONS,
  ...LEGACY_CONTEXT_OFFICIAL_MIGRATIONS,
] as const;
export const LEGACY_EXPERT_OFFICIAL_HIGH_WATER_MARK = Math.max(
  ...LEGACY_EXPERT_OFFICIAL_MIGRATIONS.map(({ officialId }) => officialId),
);
export const LEGACY_CONTEXT_OFFICIAL_HIGH_WATER_MARK = Math.max(
  ...LEGACY_CONTEXT_OFFICIAL_MIGRATIONS.map(({ officialId }) => officialId),
);

const FROZEN_LEGACY_OFFICIAL_PREFIX_LENGTH = 108;
export const FROZEN_LEGACY_OFFICIAL_PREFIX_HIGH_WATER_MARK = FROZEN_LEGACY_OFFICIAL_PREFIX_LENGTH;
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

export const CONTEXT_TABLE_COLUMNS: Readonly<Record<string, readonly SqliteColumnInfo[]>> = {
  context_meta: [
    { name: "singleton", type: "INTEGER", notnull: 0, dflt_value: null, pk: 1 },
    { name: "data_instance_id", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
  ],
  context_spaces: [
    { name: "space_id", type: "TEXT", notnull: 0, dflt_value: null, pk: 1 },
    { name: "direction_goal", type: "TEXT", notnull: 1, dflt_value: "''", pk: 0 },
    { name: "shared_instructions", type: "TEXT", notnull: 1, dflt_value: "''", pk: 0 },
    { name: "revision", type: "INTEGER", notnull: 1, dflt_value: "0", pk: 0 },
    { name: "updated_at", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
  ],
  context_projects: [
    { name: "project_id", type: "TEXT", notnull: 0, dflt_value: null, pk: 1 },
    { name: "project_goal", type: "TEXT", notnull: 1, dflt_value: "''", pk: 0 },
    { name: "project_instructions", type: "TEXT", notnull: 1, dflt_value: "''", pk: 0 },
    { name: "revision", type: "INTEGER", notnull: 1, dflt_value: "0", pk: 0 },
    { name: "updated_at", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
  ],
  context_migrations: [
    { name: "project_id", type: "TEXT", notnull: 0, dflt_value: null, pk: 1 },
    { name: "source_digest", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
    { name: "legacy_instructions", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
    { name: "status", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
    { name: "choice", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
    { name: "updated_at", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
  ],
  context_thread_bindings: [
    { name: "thread_id", type: "TEXT", notnull: 0, dflt_value: null, pk: 1 },
    { name: "mode", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
    { name: "snapshot_json", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
  ],
  context_applied_runtime_records: [
    { name: "thread_id", type: "TEXT", notnull: 0, dflt_value: null, pk: 1 },
    { name: "record_json", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
  ],
  context_command_results: [
    { name: "command_id", type: "TEXT", notnull: 0, dflt_value: null, pk: 1 },
    { name: "result_json", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
  ],
};
export const CONTEXT_DELIVERY_COLUMNS = [
  { name: "context_snapshot_id", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
  { name: "context_input_digest", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
  { name: "context_message_id", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
  { name: "context_phase", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
] as const;

const WORKBENCH_MIGRATIONS_DDL = `CREATE TABLE workbench_sql_migrations (
  module_id TEXT NOT NULL,
  migration_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  checksum TEXT NOT NULL,
  applied_at TEXT NOT NULL,
  PRIMARY KEY (module_id, migration_id)
)`;

const WORKBENCH_SCHEMA_METADATA_DDL = `CREATE TABLE workbench_schema_metadata (
  format_version INTEGER NOT NULL
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
  readonly contextSchemaObjects: readonly SqliteSchemaObject[];
  readonly projectionThreadsExists: boolean;
  readonly bindingColumn: SqliteColumnInfo | null;
  readonly runtimeRecordColumns: readonly SqliteColumnInfo[] | null;
  readonly contextTableColumns: Readonly<Record<string, readonly SqliteColumnInfo[] | null>>;
  readonly contextDeliveryColumns: readonly SqliteColumnInfo[] | null;
}

export interface WorkbenchSchemaFormatState {
  readonly exists: boolean;
  readonly version: number;
}

export interface WorkbenchMigrationDefinition {
  readonly moduleId: "expert" | "context";
  readonly migrationId: number;
  readonly name: string;
  readonly checksum: string;
  readonly statement?: string | undefined;
  readonly effect?: typeof ContextV1Migration | undefined;
}

const currentOfficialMigrationEntries = () => migrationEntries.toSorted(([a], [b]) => a - b);

export type OfficialMigrationCatalog = readonly (readonly [number, string, unknown])[];

export const currentOfficialMigrationCatalog = (): OfficialMigrationCatalog =>
  currentOfficialMigrationEntries();

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
): string | null => {
  const normalized = normalizeRecognizedOfficialMigrationRows(rows);
  return validateOfficialMigrationPrefixAgainstCatalog(
    normalized.rows,
    currentOfficialMigrationEntries(),
  );
};

/** Pure metadata repair view shared by pre-migration planning and the migrator. */
export const normalizeRecognizedOfficialMigrationRows = (
  rows: readonly OfficialMigrationRecord[],
): { readonly rows: readonly OfficialMigrationRecord[]; readonly changed: boolean } => {
  const names = new Map(rows.map(({ migration_id, name }) => [migration_id, name] as const));
  let changed = false;
  const migration32Name = planLegacyMigration32Rename(names);
  if (migration32Name !== null) {
    names.set(32, migration32Name);
    changed = true;
  }
  for (const repair of planMigrationLineageAliasRepairs(names)) {
    if (repair.kind === "rename") names.set(repair.migrationId, repair.name);
    else names.delete(repair.migrationId);
    changed = true;
  }
  return {
    rows: [...names]
      .toSorted(([left], [right]) => left - right)
      .map(([migration_id, name]) => ({ migration_id, name })),
    changed,
  };
};

/** Validate the exact old 1..108 prefix followed only by known fork migrations. */
export const validateFrozenLegacyOfficialPrefix = (
  rows: readonly OfficialMigrationRecord[],
): string | null => {
  if (
    rows.length < FROZEN_LEGACY_OFFICIAL_PREFIX_LENGTH + 1 ||
    rows.length > FROZEN_LEGACY_OFFICIAL_PREFIX_LENGTH + LEGACY_OFFICIAL_MIGRATIONS.length
  ) {
    return "The legacy workbench migrations do not follow the frozen official prefix.";
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
  let previousId = FROZEN_LEGACY_OFFICIAL_PREFIX_LENGTH;
  const found = new Set<string>();
  for (const row of legacyTail) {
    const expected = LEGACY_OFFICIAL_MIGRATIONS.find(
      (migration) => migration.officialId === row.migration_id,
    );
    if (
      expected === undefined ||
      row.name !== expected.officialName ||
      row.migration_id <= previousId
    ) {
      return `Legacy official migration ${row.migration_id} has an unknown name or order.`;
    }
    found.add(`${expected.workbenchId}:${expected.officialName}`);
    previousId = row.migration_id;
  }
  if (
    LEGACY_EXPERT_OFFICIAL_MIGRATIONS[1] !== undefined &&
    found.has(
      `${LEGACY_EXPERT_OFFICIAL_MIGRATIONS[1].workbenchId}:${LEGACY_EXPERT_OFFICIAL_MIGRATIONS[1].officialName}`,
    ) &&
    !found.has(
      `${LEGACY_EXPERT_OFFICIAL_MIGRATIONS[0]!.workbenchId}:${LEGACY_EXPERT_OFFICIAL_MIGRATIONS[0]!.officialName}`,
    )
  ) {
    return "Legacy expert migration 110 is recorded without migration 109.";
  }
  return null;
};

export const officialMigrationCatalogHighWaterMark = (
  catalog: readonly (readonly [number, string, unknown])[],
) => Math.max(...catalog.map(([id]) => id), 0);

export const currentOfficialMigrationCount = () =>
  officialMigrationCatalogHighWaterMark(currentOfficialMigrationEntries());

export const currentOfficialMigrationEntryCount = () => currentOfficialMigrationEntries().length;

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
  {
    moduleId: EXPERT_WORKBENCH_MODULE_ID,
    migrationId: 3,
    name: "HubProjectOrigin",
    checksum: "sha256:828b1a4627e3e09d525bfb9975a9f81fad553071d7ee131d567657a8b6917e55",
    statement: HUB_PROJECT_ORIGIN_SQL,
  },
  {
    moduleId: EXPERT_WORKBENCH_MODULE_ID,
    migrationId: 4,
    name: "HubExpertDeliverables",
    checksum: "sha256:fec59450c54d3e12905d05f47a634989432f28770095b025f9f5ed1745c8d5fc",
    statement: HUB_EXPERT_V1_SQL,
    effect: HUB_EXPERT_V1_EFFECT,
  },
  {
    moduleId: EXPERT_WORKBENCH_MODULE_ID,
    migrationId: 5,
    name: "HubExpertParticipants",
    checksum: "sha256:47fed115ba3ae457e8c899ea3a4a49eb51c2ad83ab29b4948d90a3cc485523d4",
    statement: HUB_EXPERT_PARTICIPANTS_SQL,
  },
  {
    moduleId: EXPERT_WORKBENCH_MODULE_ID,
    migrationId: 6,
    name: "ExpertSkillApplication",
    checksum: "sha256:d5a205fd4bc04221ae9f4a16a8dde18b2b53a83b8b7eb068102eafb1cc626114",
    statement: "ALTER TABLE expert_applied_runtime_records ADD COLUMN skill_application_json TEXT",
  },
  {
    moduleId: EXPERT_WORKBENCH_MODULE_ID,
    migrationId: 7,
    name: "HubCollaborationPresetsAndSettings",
    checksum: "sha256:791f43d30cdace88bfe9c5dc5354e210768b58876bbe3fe37825ad2e1404a67b",
    statement: HUB_COLLABORATION_V1_SQL,
    effect: HUB_COLLABORATION_V1_EFFECT,
  },
  {
    moduleId: EXPERT_WORKBENCH_MODULE_ID,
    migrationId: 8,
    name: "HubPlanStateAndOutbox",
    checksum: "sha256:f0cb93776624de7874786a05d93c254baaacc55ae700b8a34ccf4758e3fef0d9",
    statement: HUB_PLAN_SQL,
    effect: HUB_PLAN_EFFECT,
  },
  {
    moduleId: EXPERT_WORKBENCH_MODULE_ID,
    migrationId: 9,
    name: "HubPlanDirectedInput",
    checksum: "sha256:c1eed65d20738b04e96d8197d66fa5094fbb0fac6899e23cfb2b9c6ef6cabcdc",
    statement: HUB_PLAN_INPUT_REQUEST_SQL,
    effect: HUB_PLAN_INPUT_REQUEST_EFFECT,
  },
  {
    moduleId: EXPERT_WORKBENCH_MODULE_ID,
    migrationId: 10,
    name: "ExpertSkillEvolution",
    checksum: "sha256:fe4cc3be8d7c7cebd5d36dce4ae48a6c8528b3d4b4ed0dc695be5570633074fa",
    statement: SKILL_EVOLUTION_SQL,
    effect: SKILL_EVOLUTION_EFFECT,
  },
  {
    moduleId: EXPERT_WORKBENCH_MODULE_ID,
    migrationId: 11,
    name: "ExpertAutomaticLearning",
    checksum: "sha256:dcc48be624cd25911d923e8f730ee31ab57b9914f44113e11a2f69ca161484b7",
    statement: EXPERT_LEARNING_SQL,
    effect: EXPERT_LEARNING_EFFECT,
  },
];

/** The Context migration reuses the exact frozen native script from legacy 111. */
export const contextWorkbenchMigrationEntries: readonly WorkbenchMigrationDefinition[] = [
  {
    moduleId: "context",
    migrationId: 1,
    name: "ContextV1",
    checksum: "sha256:b7dbd84911484156f3f38093973338ca005dce9e8ba4b38b8972d9dfe79a4911",
    effect: ContextV1Migration,
  },
];

export const allWorkbenchMigrationEntries: readonly WorkbenchMigrationDefinition[] = [
  ...workbenchMigrationEntries,
  ...contextWorkbenchMigrationEntries,
];

export interface WorkbenchHistoryPlan {
  readonly ok: true;
  readonly applied: readonly WorkbenchMigrationDefinition[];
  readonly appliedByModule: Readonly<Record<"expert" | "context", number>>;
}

export interface InvalidWorkbenchHistoryPlan {
  readonly ok: false;
  readonly reason: string;
}

export const planWorkbenchHistory = (
  rows: readonly WorkbenchMigrationRecord[],
): WorkbenchHistoryPlan | InvalidWorkbenchHistoryPlan => {
  for (const migration of workbenchMigrationEntries) {
    if (migration.statement === undefined) {
      return {
        ok: false,
        reason: `Expert workbench migration ${migration.migrationId} has no canonical SQL statement.`,
      };
    }
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
  if ([...modules].some((moduleId) => moduleId !== "expert" && moduleId !== "context")) {
    return { ok: false, reason: "The workbench migration tracker contains an unsupported module." };
  }

  const applied: WorkbenchMigrationDefinition[] = [];
  const appliedByModule: Record<"expert" | "context", number> = { expert: 0, context: 0 };
  for (const moduleId of ["expert", "context"] as const) {
    const definitions =
      moduleId === "expert" ? workbenchMigrationEntries : contextWorkbenchMigrationEntries;
    const moduleRows = ordered.filter((row) => row.module_id === moduleId);
    for (let index = 0; index < moduleRows.length; index += 1) {
      const row = moduleRows[index]!;
      const expectedId = index + 1;
      const expected = definitions[index];
      if (row.migration_id > definitions.length) {
        return {
          ok: false,
          reason: `${moduleId} workbench migration ${row.migration_id} is newer than this build supports.`,
        };
      }
      if (row.migration_id !== expectedId) {
        return {
          ok: false,
          reason: `${moduleId} workbench migration history is not a contiguous prefix at ${expectedId}.`,
        };
      }
      if (
        expected === undefined ||
        row.name !== expected.name ||
        row.checksum !== expected.checksum ||
        row.applied_at.length === 0
      ) {
        return {
          ok: false,
          reason: `${moduleId} workbench migration ${row.migration_id} has an unknown name, checksum, or timestamp.`,
        };
      }
      applied.push(expected);
    }
    appliedByModule[moduleId] = moduleRows.length;
  }

  return { ok: true, applied, appliedByModule };
};

export const validateWorkbenchSchemaState = (
  appliedMigrationCount: number | Readonly<Record<"expert" | "context", number>>,
  state: WorkbenchSchemaState,
): string | null => {
  const appliedByModule =
    typeof appliedMigrationCount === "number"
      ? { expert: appliedMigrationCount, context: 0 }
      : appliedMigrationCount;
  const contextApplied = appliedByModule.context >= 1;
  const contextDefinitionIssue = validateFrozenContextSchema(
    contextApplied,
    state.contextSchemaObjects,
  );
  if (contextDefinitionIssue !== null) return contextDefinitionIssue;
  const contextTableNames = Object.keys(CONTEXT_TABLE_COLUMNS);
  if (contextApplied) {
    for (const tableName of contextTableNames) {
      const actual = state.contextTableColumns[tableName];
      const expected = CONTEXT_TABLE_COLUMNS[tableName];
      if (
        actual === null ||
        actual === undefined ||
        expected === undefined ||
        !sameColumns(actual, expected)
      ) {
        return `Context table ${tableName} does not match the frozen Context V1 schema.`;
      }
    }
    if (
      state.contextDeliveryColumns === null ||
      !sameColumns(state.contextDeliveryColumns, CONTEXT_DELIVERY_COLUMNS)
    ) {
      return "orchestration_event_deliveries does not match the frozen Context V1 columns.";
    }
  } else if (
    contextTableNames.some((tableName) => state.contextTableColumns[tableName] !== null) ||
    state.contextDeliveryColumns !== null
  ) {
    return "Context V1 schema exists without a matching context workbench migration record.";
  }

  if (!state.projectionThreadsExists) {
    if (
      appliedByModule.expert === 0 &&
      !contextApplied &&
      state.bindingColumn === null &&
      state.runtimeRecordColumns === null
    ) {
      return null;
    }
    return "The official projection_threads table is missing; run official migrations through 108 first.";
  }

  const bindingApplied = appliedByModule.expert >= 1;
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

  const runtimeRecordsApplied = appliedByModule.expert >= 2;
  if (runtimeRecordsApplied) {
    if (
      state.runtimeRecordColumns === null ||
      !sameColumns(
        state.runtimeRecordColumns,
        appliedByModule.expert >= 6
          ? [
              ...EXPERT_RUNTIME_RECORD_COLUMNS,
              { name: "skill_application_json", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
            ]
          : EXPERT_RUNTIME_RECORD_COLUMNS,
      )
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

export const validateWorkbenchSchemaMetadataShape = (columns: readonly SqliteColumnInfo[]) =>
  sameColumns(columns, [
    { name: "format_version", type: "INTEGER", notnull: 1, dflt_value: null, pk: 0 },
  ]);

export const readWorkbenchSchemaFormat = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const metadata = yield* inspectSqliteObject(sql, WORKBENCH_SCHEMA_METADATA_TABLE);
  if (metadata === null) return { exists: false, version: 0 } as const;
  if (metadata.type !== "table") {
    return yield* fail("workbench_schema_metadata exists but is not a table.");
  }
  const columns = yield* inspectTableColumns(sql, WORKBENCH_SCHEMA_METADATA_TABLE);
  if (!validateWorkbenchSchemaMetadataShape(columns)) {
    return yield* fail("workbench_schema_metadata has an unsupported schema.");
  }
  const rows = yield* sql<{ readonly format_version: number }>`
    SELECT format_version FROM workbench_schema_metadata
  `;
  if (
    rows.length !== 1 ||
    !Number.isSafeInteger(rows[0]?.format_version) ||
    (rows[0]?.format_version ?? -1) < 0
  ) {
    return yield* fail("workbench_schema_metadata must contain exactly one valid format version.");
  }
  return { exists: true, version: rows[0]!.format_version } as const;
});

export const ensureWorkbenchSchemaFormat = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const state = yield* readWorkbenchSchemaFormat;
  if (state.version > WORKBENCH_SCHEMA_FORMAT_VERSION) {
    return yield* fail(
      `Workbench data format ${state.version} is newer than this build supports (${WORKBENCH_SCHEMA_FORMAT_VERSION}).`,
    );
  }
  if (!state.exists) {
    yield* sql.unsafe(WORKBENCH_SCHEMA_METADATA_DDL);
    yield* sql`
      INSERT INTO workbench_schema_metadata (format_version)
      VALUES (${WORKBENCH_SCHEMA_FORMAT_VERSION})
    `;
  } else if (state.version < WORKBENCH_SCHEMA_FORMAT_VERSION) {
    yield* sql`
      UPDATE workbench_schema_metadata
      SET format_version = ${WORKBENCH_SCHEMA_FORMAT_VERSION}
    `;
  }
});

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

  const contextTableColumns: Record<string, readonly SqliteColumnInfo[] | null> = {};
  for (const tableName of Object.keys(CONTEXT_TABLE_COLUMNS)) {
    const table = yield* inspectSqliteObject(sql, tableName);
    if (table !== null && table.type !== "table") {
      return yield* fail(`${tableName} exists but is not a table.`);
    }
    contextTableColumns[tableName] =
      table === null ? null : yield* inspectTableColumns(sql, tableName);
  }
  const deliveryTable = yield* inspectSqliteObject(sql, "orchestration_event_deliveries");
  if (deliveryTable !== null && deliveryTable.type !== "table") {
    return yield* fail("orchestration_event_deliveries exists but is not a table.");
  }
  const deliveryColumns =
    deliveryTable === null
      ? null
      : yield* inspectTableColumns(sql, "orchestration_event_deliveries");
  const contextDeliveryColumns =
    deliveryColumns === null
      ? null
      : deliveryColumns.filter(({ name }) =>
          CONTEXT_DELIVERY_COLUMNS.some((expected) => expected.name === name),
        );
  const contextSchemaObjects = yield* sql.unsafe<SqliteSchemaObject>(CONTEXT_SCHEMA_OBJECTS_QUERY);
  return {
    contextSchemaObjects,
    projectionThreadsExists,
    bindingColumn,
    runtimeRecordColumns,
    contextTableColumns,
    contextDeliveryColumns: contextDeliveryColumns?.length === 0 ? null : contextDeliveryColumns,
  };
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
 * Runs only the workbench-owned extension migrations after the shared SQLite
 * startup path has planned, backed up, adopted any frozen legacy rows, and run
 * the official migrator.
 */
export const runWorkbenchMigrations = () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const official = yield* readAndValidateOfficialMigrationState;
    const officialIssue = validateCurrentOfficialMigrationPrefix(official.rows);
    if (officialIssue !== null) return yield* fail(officialIssue);
    if (official.rows.length !== currentOfficialMigrationEntryCount()) {
      return yield* fail(
        "The complete current official migration prefix must be applied before workbench migrations run.",
      );
    }

    const initialTracker = yield* readWorkbenchTracker;
    const initialPlan = planWorkbenchHistory(initialTracker.rows);
    if (!initialPlan.ok) return yield* fail(initialPlan.reason);
    const initialSchema = yield* readWorkbenchSchemaState;
    const schemaIssue = validateWorkbenchSchemaState(initialPlan.appliedByModule, initialSchema);
    if (schemaIssue !== null) return yield* fail(schemaIssue);
    const initialFormat = yield* readWorkbenchSchemaFormat;
    if (initialFormat.version > WORKBENCH_SCHEMA_FORMAT_VERSION) {
      return yield* fail(
        `Workbench data format ${initialFormat.version} is newer than this build supports (${WORKBENCH_SCHEMA_FORMAT_VERSION}).`,
      );
    }

    const executed: WorkbenchMigrationDefinition[] = [];
    const pendingMigrations = allWorkbenchMigrationEntries.filter(
      (migration) => migration.migrationId > initialPlan.appliedByModule[migration.moduleId],
    );
    for (const migration of pendingMigrations) {
      yield* sql.withTransaction(
        Effect.gen(function* () {
          const tracker = yield* readWorkbenchTracker;
          const plan = planWorkbenchHistory(tracker.rows);
          if (!plan.ok) return yield* fail(plan.reason);
          if (plan.appliedByModule[migration.moduleId] !== migration.migrationId - 1) {
            return yield* fail(
              `${migration.moduleId} workbench migration history changed during upgrade.`,
            );
          }
          yield* ensureWorkbenchTracker;
          yield* ensureWorkbenchSchemaFormat;
          const schema = yield* readWorkbenchSchemaState;
          const issue = validateWorkbenchSchemaState(plan.appliedByModule, schema);
          if (issue !== null) return yield* fail(issue);

          if (migration.effect !== undefined) {
            yield* migration.effect;
          } else if (migration.statement !== undefined) {
            yield* sql.unsafe(migration.statement);
          } else {
            return yield* fail(`Workbench migration ${migration.name} has no implementation.`);
          }
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

    if (pendingMigrations.length === 0) {
      yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* ensureWorkbenchTracker;
          yield* ensureWorkbenchSchemaFormat;
        }),
      );
    }

    const finalTracker = yield* readWorkbenchTracker;
    const finalPlan = planWorkbenchHistory(finalTracker.rows);
    if (!finalPlan.ok) return yield* fail(finalPlan.reason);
    const finalSchema = yield* readWorkbenchSchemaState;
    const finalIssue = validateWorkbenchSchemaState(finalPlan.appliedByModule, finalSchema);
    if (finalIssue !== null) return yield* fail(finalIssue);
    const finalFormat = yield* readWorkbenchSchemaFormat;
    if (finalFormat.version !== WORKBENCH_SCHEMA_FORMAT_VERSION) {
      return yield* fail("The workbench data format was not initialized to the supported version.");
    }
    return { executed };
  });
