import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { migrationEntries } from "../../persistence/Migrations.ts";
import LegacyExpertBindingMigration from "../../persistence/Migrations/109_ProjectionThreadsExpertBinding.ts";
import ExpertAppliedRuntimeRecordsMigration from "../../persistence/Migrations/110_ExpertAppliedRuntimeRecords.ts";
import ContextV1Migration from "../../persistence/Migrations/111_ContextV1.ts";
import * as NodeSqliteClient from "../../persistence/NodeSqliteClient.ts";
import { runMigrations } from "../../persistence/Migrations.ts";
import {
  LEGACY_EXPERT_OFFICIAL_MIGRATIONS,
  LEGACY_EXPERT_OFFICIAL_HIGH_WATER_MARK,
  currentOfficialMigrationCount,
  workbenchMigrationEntries,
  type OfficialMigrationRecord,
  type WorkbenchMigrationRecord,
} from "./WorkbenchMigrations.ts";
import {
  inspectWorkbenchUpgradePlan,
  planWorkbenchUpgrade,
  type WorkbenchUpgradeObservation,
} from "./WorkbenchUpgradePlan.ts";

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

const officialPrefix = (through: number): readonly OfficialMigrationRecord[] =>
  migrationEntries
    .filter(([id]) => id <= through && id <= 108)
    .map(([migration_id, name]) => ({ migration_id, name }));

const currentOfficialRows = (): readonly OfficialMigrationRecord[] =>
  migrationEntries.map(([migration_id, name]) => ({ migration_id, name }));

const legacyRows = (through: 109 | 110): readonly OfficialMigrationRecord[] => [
  ...officialPrefix(108),
  ...LEGACY_EXPERT_OFFICIAL_MIGRATIONS.filter(({ officialId }) => officialId <= through).map(
    ({ officialId: migration_id, officialName: name }) => ({ migration_id, name }),
  ),
];

const workbenchRows = (through: 0 | 1 | 2): readonly WorkbenchMigrationRecord[] =>
  workbenchMigrationEntries.slice(0, through).map((migration) => ({
    module_id: migration.moduleId,
    migration_id: migration.migrationId,
    name: migration.name,
    checksum: migration.checksum,
    applied_at: "2026-09-29T12:00:00.000Z",
  }));

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

const emptySchema = {
  ...absentContextSchema,
  projectionThreadsExists: false,
  bindingColumn: null,
  runtimeRecordColumns: null,
} as const;
const baselineSchema = {
  ...absentContextSchema,
  projectionThreadsExists: true,
  bindingColumn: null,
  runtimeRecordColumns: null,
} as const;
const legacy109Schema = {
  ...absentContextSchema,
  projectionThreadsExists: true,
  bindingColumn: {
    name: "expert_binding_json",
    type: "TEXT",
    notnull: 0,
    dflt_value: null,
    pk: 0,
  },
  runtimeRecordColumns: null,
} as const;
const legacy110Schema = {
  ...legacy109Schema,
  runtimeRecordColumns: [
    { name: "thread_id", type: "TEXT", notnull: 0, dflt_value: null, pk: 1 },
    { name: "snapshot_id", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
    { name: "provider", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
    { name: "model", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
    { name: "runtime_component", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
    { name: "runtime_version", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
    { name: "lifecycle_generation", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
    { name: "applied_at", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
  ],
} as const;

const observe = (
  overrides: Partial<WorkbenchUpgradeObservation> = {},
): WorkbenchUpgradeObservation => ({
  databaseEmpty: false,
  hasApplicationTables: true,
  officialTrackerExists: true,
  officialTrackerValid: true,
  officialRows: currentOfficialRows(),
  workbenchTrackerExists: false,
  workbenchTrackerValid: true,
  workbenchRows: [],
  workbenchFormatExists: false,
  workbenchFormatValid: true,
  workbenchFormatVersion: 0,
  schemaState: baselineSchema,
  ...overrides,
});

it.effect("plans empty initialization without a meaningless backup", () =>
  Effect.sync(() => {
    const plan = planWorkbenchUpgrade(
      observe({
        databaseEmpty: true,
        hasApplicationTables: false,
        officialTrackerExists: false,
        workbenchTrackerExists: false,
        officialRows: [],
        workbenchRows: [],
        schemaState: emptySchema,
      }),
    );
    assert.strictEqual(plan.kind, "ready");
    if (plan.kind !== "ready") return;
    assert.deepStrictEqual(plan.official, {
      sourceVersion: 0,
      sourceLabel: "v0",
      targetVersion: currentOfficialMigrationCount(),
      replayTargetVersion: Math.max(
        LEGACY_EXPERT_OFFICIAL_HIGH_WATER_MARK,
        ...migrationEntries.map(([id]) => id),
      ),
      hasPendingMigrations: true,
      hasLineageRepair: false,
    });
    assert.strictEqual(plan.workbench.sourceVersion, 0);
    assert.deepStrictEqual(plan.format, {
      existsAtSource: false,
      sourceVersion: 0,
      targetVersion: 1,
      hasPendingUpgrade: true,
    });
    assert.strictEqual(plan.requiresBackup, false);
  }),
);

it.effect("backs up extension-only and official-only non-empty upgrades", () =>
  Effect.sync(() => {
    const extensionOnly = planWorkbenchUpgrade(observe());
    assert.strictEqual(extensionOnly.kind, "ready");
    if (extensionOnly.kind === "ready") {
      assert.strictEqual(extensionOnly.official.hasPendingMigrations, false);
      assert.strictEqual(extensionOnly.workbench.hasPendingMigrations, true);
      assert.strictEqual(extensionOnly.format.hasPendingUpgrade, true);
      assert.strictEqual(extensionOnly.requiresBackup, true);
    }

    const officialOnly = planWorkbenchUpgrade(
      observe({ officialRows: officialPrefix(52), schemaState: baselineSchema }),
    );
    assert.strictEqual(officialOnly.kind, "ready");
    if (officialOnly.kind === "ready") {
      assert.strictEqual(officialOnly.official.sourceVersion, 52);
      assert.strictEqual(officialOnly.official.hasPendingMigrations, true);
      assert.strictEqual(officialOnly.requiresBackup, true);
    }
  }),
);

it.effect("plans legacy adoption with the pending Context migration", () =>
  Effect.sync(() => {
    const plan = planWorkbenchUpgrade(
      observe({ officialRows: legacyRows(110), schemaState: legacy110Schema }),
    );
    assert.strictEqual(plan.kind, "ready");
    if (plan.kind !== "ready") return;
    assert.strictEqual(plan.official.sourceVersion, 108);
    assert.strictEqual(plan.official.hasPendingMigrations, true);
    assert.strictEqual(plan.official.targetVersion, currentOfficialMigrationCount());
    assert.deepStrictEqual(plan.workbench.adoptedMigrationIds, [1, 2]);
    assert.strictEqual(plan.workbench.hasPendingMigrations, true);
    assert.deepStrictEqual(
      plan.legacyOfficialMigrations.map(({ officialId, workbenchId }) => [officialId, workbenchId]),
      [
        [109, 1],
        [110, 2],
      ],
    );
    assert.strictEqual(plan.requiresBackup, true);
  }),
);

it.effect("recognizes frozen legacy rows before checking the post-split official catalog", () =>
  Effect.sync(() => {
    const postSplitCatalog = migrationEntries;
    for (const through of [109, 110] as const) {
      const legacy = planWorkbenchUpgrade(
        observe({
          officialRows: legacyRows(through),
          schemaState: through === 109 ? legacy109Schema : legacy110Schema,
        }),
        postSplitCatalog,
      );
      assert.strictEqual(legacy.kind, "ready");
      if (legacy.kind === "ready") {
        assert.deepStrictEqual(
          legacy.workbench.adoptedMigrationIds,
          through === 109 ? [1] : [1, 2],
        );
        assert.strictEqual(legacy.official.sourceVersion, 108);
        assert.strictEqual(legacy.official.targetVersion, currentOfficialMigrationCount());
        assert.strictEqual(legacy.official.hasPendingMigrations, true);
      }
    }

    const futureCatalog = [
      ...postSplitCatalog,
      [137, "OfficialMigrationAfterContextV1", Effect.void] as const,
    ];
    const futureRows = [
      ...currentOfficialRows(),
      { migration_id: 137, name: "OfficialMigrationAfterContextV1" },
    ];
    const sparseOfficial = planWorkbenchUpgrade(
      observe({ officialRows: futureRows, schemaState: baselineSchema }),
      futureCatalog,
    );
    assert.strictEqual(sparseOfficial.kind, "ready");
    if (sparseOfficial.kind === "ready") {
      assert.strictEqual(sparseOfficial.official.sourceVersion, 137);
      assert.strictEqual(sparseOfficial.official.targetVersion, 137);
    }

    const known136Catalog = [
      ...postSplitCatalog,
      [136, "CurrentOfficialMigration136", Effect.void] as const,
    ];
    const known136 = planWorkbenchUpgrade(
      observe({
        officialRows: [
          ...currentOfficialRows(),
          { migration_id: 136, name: "CurrentOfficialMigration136" },
        ],
        schemaState: baselineSchema,
      }),
      known136Catalog,
    );
    assert.strictEqual(known136.kind, "ready");
    if (known136.kind === "ready") {
      assert.strictEqual(known136.official.sourceVersion, 136);
      assert.strictEqual(known136.official.targetVersion, 136);
      assert.deepStrictEqual(known136.legacyOfficialMigrations, []);
    }

    const unknownKnown136 = planWorkbenchUpgrade(
      observe({
        officialRows: [
          ...currentOfficialRows(),
          { migration_id: 136, name: "UnrecognizedMigration136" },
        ],
        schemaState: baselineSchema,
      }),
      known136Catalog,
    );
    assert.strictEqual(unknownKnown136.kind, "ready");
    if (unknownKnown136.kind === "ready") {
      assert.isFalse(unknownKnown136.official.hasLineageRepair);
      assert.isTrue(unknownKnown136.requiresBackup);
    }
  }),
);

it.effect("rejects unknown, too-new, and structurally inconsistent histories", () =>
  Effect.sync(() => {
    const tooNewOfficial = planWorkbenchUpgrade(
      observe({
        officialRows: [
          ...currentOfficialRows(),
          { migration_id: 136, name: "UnrecognizedFutureOfficialMigration" },
        ],
        schemaState: baselineSchema,
      }),
    );
    assert.strictEqual(tooNewOfficial.kind, "rejected");
    if (tooNewOfficial.kind === "rejected") {
      assert.strictEqual(tooNewOfficial.rejectionKind, "official-too-new");
      assert.strictEqual(tooNewOfficial.databaseVersion, 136);
    }

    const tooNewWorkbench = planWorkbenchUpgrade(
      observe({
        workbenchTrackerExists: true,
        workbenchRows: [
          {
            ...workbenchRows(2)[1]!,
            migration_id: 3,
            name: "UnrecognizedFutureExpertMigration",
          },
        ],
      }),
    );
    assert.strictEqual(tooNewWorkbench.kind, "rejected");

    const missingProjection = planWorkbenchUpgrade(
      observe({ officialRows: officialPrefix(1), schemaState: emptySchema }),
    );
    assert.strictEqual(missingProjection.kind, "ready");

    const missingProjectionAfterCreation = planWorkbenchUpgrade(
      observe({ officialRows: officialPrefix(5), schemaState: emptySchema }),
    );
    assert.strictEqual(missingProjectionAfterCreation.kind, "rejected");

    const trackerOnlyDatabase = planWorkbenchUpgrade(
      observe({
        databaseEmpty: false,
        hasApplicationTables: false,
        officialRows: [],
        schemaState: emptySchema,
      }),
    );
    assert.strictEqual(trackerOnlyDatabase.kind, "rejected");

    const unknownLegacyName = planWorkbenchUpgrade(
      observe({
        officialRows: [
          ...officialPrefix(108),
          { migration_id: 109, name: "UnknownOldExpertMigration" },
        ],
        schemaState: legacy109Schema,
      }),
    );
    assert.strictEqual(unknownLegacyName.kind, "rejected");

    const futureFormat = planWorkbenchUpgrade(
      observe({ workbenchFormatExists: true, workbenchFormatVersion: 2 }),
    );
    assert.strictEqual(futureFormat.kind, "rejected");

    const malformedFormat = planWorkbenchUpgrade(
      observe({ workbenchFormatExists: true, workbenchFormatValid: false }),
    );
    assert.strictEqual(malformedFormat.kind, "rejected");
  }),
);

it.effect("reads the empty database as an initialization plan", () =>
  inspectWorkbenchUpgradePlan.pipe(
    Effect.map((plan) => {
      assert.strictEqual(plan.kind, "ready");
      if (plan.kind === "ready") {
        assert.strictEqual(plan.databaseEmpty, true);
        assert.strictEqual(plan.requiresBackup, false);
      }
    }),
    Effect.provide(NodeSqliteClient.layerMemory()),
  ),
);

it.effect("reads an extension-only pending migration without confusing official versions", () =>
  Effect.gen(function* () {
    yield* runMigrations();
    const plan = yield* inspectWorkbenchUpgradePlan;
    assert.strictEqual(plan.kind, "ready");
    if (plan.kind === "ready") {
      assert.strictEqual(plan.official.sourceVersion, currentOfficialMigrationCount());
      assert.strictEqual(plan.official.hasPendingMigrations, false);
      assert.strictEqual(plan.workbench.sourceVersion, 0);
      assert.strictEqual(plan.workbench.hasPendingMigrations, true);
      assert.strictEqual(plan.requiresBackup, true);
      assert.strictEqual(plan.format.sourceVersion, 0);
      assert.strictEqual(plan.format.hasPendingUpgrade, true);
    }
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it.effect("accepts a real early official prefix before migration 5 creates projections", () =>
  Effect.gen(function* () {
    yield* runMigrations({ toMigrationInclusive: 4 });
    const plan = yield* inspectWorkbenchUpgradePlan;
    assert.strictEqual(plan.kind, "ready");
    if (plan.kind === "ready") {
      assert.strictEqual(plan.official.sourceVersion, 4);
      assert.strictEqual(plan.official.hasPendingMigrations, true);
      assert.strictEqual(plan.databaseEmpty, false);
      assert.strictEqual(plan.requiresBackup, true);
    }
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it.effect("reads old 109/110 as an adoption-only upgrade with a required backup", () =>
  Effect.gen(function* () {
    yield* seedLegacyExpertHistory(110);
    const plan = yield* inspectWorkbenchUpgradePlan;
    assert.strictEqual(plan.kind, "ready");
    if (plan.kind === "ready") {
      assert.strictEqual(plan.official.sourceVersion, 108);
      assert.strictEqual(plan.official.targetVersion, currentOfficialMigrationCount());
      assert.strictEqual(plan.official.hasPendingMigrations, true);
      assert.strictEqual(plan.workbench.sourceVersion, 0);
      assert.deepStrictEqual(plan.workbench.adoptedMigrationIds, [1, 2]);
      assert.strictEqual(plan.workbench.hasPendingMigrations, true);
      assert.strictEqual(plan.requiresBackup, true);
    }
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it.effect("does not let imported-lineage consent bypass any untracked Context schema", () =>
  Effect.sync(() => {
    const importedRows = officialPrefix(108).map((row) =>
      row.migration_id === 17 ? { migration_id: 17, name: "UnknownImportedName" } : row,
    );
    const clean = planWorkbenchUpgrade(observe({ officialRows: importedRows }));
    assert.strictEqual(clean.kind, "ready");
    if (clean.kind === "ready") {
      assert.strictEqual(clean.official.sourceVersion, 16);
      assert.isTrue(clean.official.hasPendingMigrations);
      assert.isTrue(clean.requiresBackup);
    }
    for (const reservedId of [109, 110, 111]) {
      const rows = migrationEntries
        .filter(([id]) => id <= reservedId)
        .map(([migration_id, name]) => ({
          migration_id,
          name:
            migration_id === 17
              ? "UnknownImportedName"
              : migration_id === reservedId
                ? "UnknownReservedMigration"
                : name,
        }));
      const plan = planWorkbenchUpgrade(observe({ officialRows: rows }));
      assert.strictEqual(
        plan.kind,
        "rejected",
        `unknown reserved ${reservedId} cannot use imported consent`,
      );
    }
    const column = {
      name: "partial_column",
      type: "TEXT",
      notnull: 0,
      dflt_value: null,
      pk: 0,
    } as const;
    for (const tableName of Object.keys(absentContextSchema.contextTableColumns)) {
      const plan = planWorkbenchUpgrade(
        observe({
          officialRows: importedRows,
          schemaState: {
            ...baselineSchema,
            contextTableColumns: {
              ...absentContextSchema.contextTableColumns,
              [tableName]: [column],
            },
          },
        }),
      );
      assert.strictEqual(plan.kind, "rejected", `untracked ${tableName} must be rejected`);
    }
    for (const name of [
      "context_snapshot_id",
      "context_input_digest",
      "context_message_id",
      "context_phase",
    ]) {
      const plan = planWorkbenchUpgrade(
        observe({
          officialRows: importedRows,
          schemaState: {
            ...baselineSchema,
            contextDeliveryColumns: [{ ...column, name }],
          },
        }),
      );
      assert.strictEqual(
        plan.kind,
        "rejected",
        `untracked delivery column ${name} must be rejected`,
      );
    }
  }),
);

it.effect(
  "rejects foreign imported prefix 17 followed by exact legacy111 and its complete Context schema",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 108 });
      yield* ContextV1Migration;
      yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (111, 'ContextV1')`;
      yield* sql`UPDATE effect_sql_migrations SET name = 'UnknownImportedName' WHERE migration_id = 17`;
      const before =
        yield* sql`SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id`;
      const plan = yield* inspectWorkbenchUpgradePlan;
      assert.strictEqual(plan.kind, "rejected");
      assert.deepStrictEqual(
        yield* sql`SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id`,
        before,
      );
      assert.deepStrictEqual(
        yield* sql`SELECT name FROM sqlite_master WHERE name IN ('workbench_sql_migrations', 'workbench_legacy_migration_adoptions')`,
        [],
      );
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);
