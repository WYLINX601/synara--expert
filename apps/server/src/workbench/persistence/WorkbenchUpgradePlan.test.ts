import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { migrationEntries } from "../../persistence/Migrations.ts";
import * as NodeSqliteClient from "../../persistence/NodeSqliteClient.ts";
import { runMigrations } from "../../persistence/Migrations.ts";
import {
  LEGACY_EXPERT_OFFICIAL_MIGRATIONS,
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

const officialPrefix = (through: number): readonly OfficialMigrationRecord[] =>
  migrationEntries
    .filter(([id]) => id <= through && id <= 108)
    .map(([migration_id, name]) => ({ migration_id, name }));

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

const emptySchema = {
  projectionThreadsExists: false,
  bindingColumn: null,
  runtimeRecordColumns: null,
} as const;
const baselineSchema = {
  projectionThreadsExists: true,
  bindingColumn: null,
  runtimeRecordColumns: null,
} as const;
const legacy109Schema = {
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
  officialRows: officialPrefix(108),
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
      replayTargetVersion: Math.max(...migrationEntries.map(([id]) => id)),
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

it.effect("plans exact legacy adoption as a backup-required extension-only change", () =>
  Effect.sync(() => {
    const plan = planWorkbenchUpgrade(
      observe({ officialRows: legacyRows(110), schemaState: legacy110Schema }),
    );
    assert.strictEqual(plan.kind, "ready");
    if (plan.kind !== "ready") return;
    assert.strictEqual(plan.official.sourceVersion, 108);
    assert.strictEqual(plan.official.hasPendingMigrations, false);
    assert.deepStrictEqual(plan.workbench.adoptedMigrationIds, [1, 2]);
    assert.strictEqual(plan.workbench.hasPendingMigrations, false);
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
    const postSplitCatalog = migrationEntries.filter(([id]) => id <= 108);
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
        assert.strictEqual(legacy.official.targetVersion, 108);
      }
    }

    const futureCatalog = [
      ...postSplitCatalog,
      [112, "OfficialMigrationAfterReservedSlots", Effect.void] as const,
    ];
    const futureRows = [
      ...officialPrefix(108),
      { migration_id: 112, name: "OfficialMigrationAfterReservedSlots" },
    ];
    const sparseOfficial = planWorkbenchUpgrade(
      observe({ officialRows: futureRows, schemaState: baselineSchema }),
      futureCatalog,
    );
    assert.strictEqual(sparseOfficial.kind, "ready");
    if (sparseOfficial.kind === "ready") {
      assert.strictEqual(sparseOfficial.official.sourceVersion, 112);
      assert.strictEqual(sparseOfficial.official.targetVersion, 112);
    }

    const known109Catalog = [
      ...postSplitCatalog,
      [109, "CurrentOfficialMigration109", Effect.void] as const,
    ];
    const known109 = planWorkbenchUpgrade(
      observe({
        officialRows: [
          ...officialPrefix(108),
          { migration_id: 109, name: "CurrentOfficialMigration109" },
        ],
        schemaState: baselineSchema,
      }),
      known109Catalog,
    );
    assert.strictEqual(known109.kind, "ready");
    if (known109.kind === "ready") {
      assert.strictEqual(known109.official.sourceVersion, 109);
      assert.strictEqual(known109.official.targetVersion, 109);
      assert.deepStrictEqual(known109.legacyOfficialMigrations, []);
    }

    const unknownKnown109 = planWorkbenchUpgrade(
      observe({
        officialRows: [
          ...officialPrefix(108),
          { migration_id: 109, name: "UnrecognizedMigration109" },
        ],
        schemaState: baselineSchema,
      }),
      known109Catalog,
    );
    assert.strictEqual(unknownKnown109.kind, "rejected");
    if (unknownKnown109.kind === "rejected") {
      assert.match(unknownKnown109.reason, /reserved legacy expert slot/u);
    }
  }),
);

it.effect("rejects unknown, too-new, and structurally inconsistent histories", () =>
  Effect.sync(() => {
    const tooNewOfficial = planWorkbenchUpgrade(
      observe({
        officialRows: [
          ...legacyRows(110),
          { migration_id: 111, name: "UnrecognizedFutureOfficialMigration" },
        ],
        schemaState: legacy110Schema,
      }),
    );
    assert.strictEqual(tooNewOfficial.kind, "rejected");
    if (tooNewOfficial.kind === "rejected") {
      assert.strictEqual(tooNewOfficial.rejectionKind, "official-too-new");
      assert.strictEqual(tooNewOfficial.databaseVersion, 111);
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
    yield* runMigrations({ toMigrationInclusive: 108 });
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
    yield* runMigrations();
    const plan = yield* inspectWorkbenchUpgradePlan;
    assert.strictEqual(plan.kind, "ready");
    if (plan.kind === "ready") {
      assert.strictEqual(plan.official.sourceVersion, 108);
      assert.strictEqual(plan.official.hasPendingMigrations, false);
      assert.strictEqual(plan.workbench.sourceVersion, 0);
      assert.deepStrictEqual(plan.workbench.adoptedMigrationIds, [1, 2]);
      assert.strictEqual(plan.workbench.hasPendingMigrations, false);
      assert.strictEqual(plan.requiresBackup, true);
    }
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);
