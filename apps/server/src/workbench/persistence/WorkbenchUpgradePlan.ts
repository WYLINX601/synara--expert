import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  migrationEntries,
  planOfficialMigrationLineage,
  type OfficialMigrationLineageDivergence,
} from "../../persistence/Migrations.ts";
import {
  inspectSqliteObject,
  inspectTableColumns,
  readOfficialMigrationRecords,
  readWorkbenchSchemaState,
  validateOfficialTrackerShape,
  validateWorkbenchTrackerShape,
  readWorkbenchSchemaFormat,
  currentOfficialMigrationCatalog,
  officialMigrationCatalogHighWaterMark,
  LEGACY_EXPERT_OFFICIAL_MIGRATIONS,
  LEGACY_EXPERT_OFFICIAL_HIGH_WATER_MARK,
  WORKBENCH_SCHEMA_FORMAT_VERSION,
  WORKBENCH_SCHEMA_METADATA_TABLE,
  planWorkbenchHistory,
  normalizeRecognizedOfficialMigrationRows,
  workbenchMigrationEntries,
  type OfficialMigrationRecord,
  type SqliteColumnInfo,
  type WorkbenchMigrationRecord,
  type WorkbenchSchemaState,
  type OfficialMigrationCatalog,
} from "./WorkbenchMigrations.ts";
import { planLegacyExpertMigrationAdoption } from "./LegacyExpertMigrationAdoption.ts";

export interface WorkbenchUpgradeObservation {
  readonly databaseEmpty: boolean;
  readonly hasApplicationTables: boolean;
  readonly officialTrackerExists: boolean;
  readonly officialTrackerValid: boolean;
  readonly officialRows: readonly OfficialMigrationRecord[];
  readonly workbenchTrackerExists: boolean;
  readonly workbenchTrackerValid: boolean;
  readonly workbenchRows: readonly WorkbenchMigrationRecord[];
  readonly workbenchFormatExists: boolean;
  readonly workbenchFormatValid: boolean;
  readonly workbenchFormatVersion: number;
  readonly schemaState: WorkbenchSchemaState;
  readonly readError?: string | undefined;
}

export interface WorkbenchUpgradeReadyPlan {
  readonly kind: "ready";
  readonly official: {
    /** The recognized official prefix, excluding any adopted legacy rows. */
    readonly sourceVersion: number;
    /** Human-readable source identity retained for migration consent challenges. */
    readonly sourceLabel: string;
    readonly targetVersion: number;
    /** Current official migrator high-water target, including the legacy catalog slots. */
    readonly replayTargetVersion: number;
    readonly hasPendingMigrations: boolean;
    readonly hasLineageRepair: boolean;
  };
  readonly workbench: {
    /** The version physically present in workbench_sql_migrations. */
    readonly sourceVersion: number;
    readonly targetVersion: number;
    /** Legacy migrations already applied in the official tracker. */
    readonly adoptedMigrationIds: readonly (1 | 2)[];
    readonly hasPendingMigrations: boolean;
  };
  readonly format: {
    readonly existsAtSource: boolean;
    readonly sourceVersion: number;
    readonly targetVersion: number;
    readonly hasPendingUpgrade: boolean;
  };
  readonly legacyOfficialMigrations: readonly {
    readonly officialId: 109 | 110;
    readonly officialName: string;
    readonly workbenchId: 1 | 2;
  }[];
  readonly lineageDivergence?: OfficialMigrationLineageDivergence | undefined;
  readonly databaseEmpty: boolean;
  readonly requiresBackup: boolean;
}

export type WorkbenchUpgradeRejectionKind =
  | "official-too-new"
  | "workbench-too-new"
  | "format-too-new"
  | "invalid-history";

export interface WorkbenchUpgradeRejectedPlan {
  readonly kind: "rejected";
  readonly rejectionKind: WorkbenchUpgradeRejectionKind;
  readonly reason: string;
  readonly databaseVersion?: number | undefined;
  readonly supportedVersion?: number | undefined;
}

export type WorkbenchUpgradePlan = WorkbenchUpgradeReadyPlan | WorkbenchUpgradeRejectedPlan;

const isMigrationId = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;

const isOfficialRows = (rows: readonly OfficialMigrationRecord[]) =>
  rows.every((row) => isMigrationId(row.migration_id) && typeof row.name === "string");

const isWorkbenchRows = (rows: readonly WorkbenchMigrationRecord[]) =>
  rows.every(
    (row) =>
      typeof row.module_id === "string" &&
      isMigrationId(row.migration_id) &&
      typeof row.name === "string" &&
      typeof row.checksum === "string" &&
      typeof row.applied_at === "string",
  );

const rejected = (
  reason: string,
  rejectionKind: WorkbenchUpgradeRejectionKind = "invalid-history",
  databaseVersion?: number,
  supportedVersion?: number,
): WorkbenchUpgradeRejectedPlan => ({
  kind: "rejected",
  rejectionKind,
  reason,
  ...(databaseVersion === undefined ? {} : { databaseVersion }),
  ...(supportedVersion === undefined ? {} : { supportedVersion }),
});

/** Purely computes both schema lineages and the pre-write recovery requirement. */
export const planWorkbenchUpgrade = (
  observation: WorkbenchUpgradeObservation,
  officialCatalog: OfficialMigrationCatalog = currentOfficialMigrationCatalog(),
): WorkbenchUpgradePlan => {
  if (observation.readError !== undefined) return rejected(observation.readError);
  if (!observation.officialTrackerValid) {
    return rejected("The official migration tracker is missing or has an unsupported schema.");
  }
  if (!observation.workbenchTrackerValid) {
    return rejected("The workbench migration tracker is missing or has an unsupported schema.");
  }
  if (!observation.workbenchFormatValid) {
    return rejected(
      "The workbench schema metadata is missing, malformed, or has an invalid shape.",
    );
  }
  if (observation.workbenchFormatVersion > WORKBENCH_SCHEMA_FORMAT_VERSION) {
    return rejected(
      `Workbench data format ${observation.workbenchFormatVersion} is newer than this build supports (${WORKBENCH_SCHEMA_FORMAT_VERSION}).`,
      "format-too-new",
      observation.workbenchFormatVersion,
      WORKBENCH_SCHEMA_FORMAT_VERSION,
    );
  }
  const observedLineage = planOfficialMigrationLineage(observation.officialRows, officialCatalog);
  if (!observation.officialTrackerExists && !observation.databaseEmpty) {
    return rejected("A non-empty database has no official migration tracker.");
  }
  if (!isOfficialRows(observation.officialRows)) {
    return rejected("The official migration tracker contains unreadable rows.");
  }
  if (!isWorkbenchRows(observation.workbenchRows)) {
    return rejected("The workbench migration tracker contains unreadable rows.");
  }

  const adoption = planLegacyExpertMigrationAdoption({
    officialTrackerExists: observation.officialTrackerExists,
    officialRows: observation.officialRows,
    workbenchTrackerExists: observation.workbenchTrackerExists,
    workbenchRows: observation.workbenchRows,
    schemaState: observation.schemaState,
    databaseEmpty: observation.databaseEmpty,
    hasApplicationTables: observation.hasApplicationTables,
    officialCatalog,
  });
  if (adoption.kind === "invalid") {
    const supportedOfficialVersion = officialMigrationCatalogHighWaterMark(officialCatalog);
    const canUseExistingOfficialDivergenceConsent =
      observedLineage.kind === "imported-divergence" &&
      observedLineage.rawHighWaterMark <= supportedOfficialVersion &&
      observation.workbenchRows.length === 0 &&
      observation.schemaState.bindingColumn === null &&
      observation.schemaState.runtimeRecordColumns === null &&
      !LEGACY_EXPERT_OFFICIAL_MIGRATIONS.some(
        ({ officialId }) => officialId === observedLineage.divergence?.firstDivergedId,
      ) &&
      observation.officialRows.every(
        ({ migration_id }) => migration_id <= supportedOfficialVersion,
      );
    if (canUseExistingOfficialDivergenceConsent) {
      // The original official-import consent flow owns imported lineages. It
      // remains available only while every tracker ID is inside today's
      // official catalog; it can never absorb unknown 109/110 history.
    } else {
      return observedLineage.rawHighWaterMark > supportedOfficialVersion ||
        observedLineage.kind === "future-prefix"
        ? rejected(
            `Official migration history is newer than this build supports (through ${observedLineage.rawHighWaterMark}).`,
            "official-too-new",
            observedLineage.rawHighWaterMark,
            supportedOfficialVersion,
          )
        : rejected(adoption.reason);
    }
  }

  const workbenchHistory = planWorkbenchHistory(observation.workbenchRows);
  if (!workbenchHistory.ok) {
    const appliedMaximum = Math.max(
      0,
      ...observation.workbenchRows.map(({ migration_id }) => migration_id),
    );
    return appliedMaximum > workbenchMigrationEntries.length
      ? rejected(
          workbenchHistory.reason,
          "workbench-too-new",
          appliedMaximum,
          workbenchMigrationEntries.length,
        )
      : rejected(workbenchHistory.reason);
  }
  const officialRowsForTarget =
    adoption.kind === "adopt"
      ? observation.officialRows.filter(({ migration_id }) => migration_id < 109)
      : observation.officialRows;
  const normalizedOfficial = normalizeRecognizedOfficialMigrationRows(officialRowsForTarget);
  const lineagePlan =
    adoption.kind === "adopt"
      ? planOfficialMigrationLineage(officialRowsForTarget, officialCatalog)
      : observedLineage;

  const officialSourceVersion =
    lineagePlan.kind === "imported-divergence"
      ? Math.max(0, (lineagePlan.divergence?.firstDivergedId ?? 1) - 1)
      : Math.max(0, ...normalizedOfficial.rows.map((row) => row.migration_id));
  const officialTargetVersion = officialMigrationCatalogHighWaterMark(officialCatalog);
  const replayTargetVersion = Math.max(
    officialTargetVersion,
    LEGACY_EXPERT_OFFICIAL_HIGH_WATER_MARK,
    ...migrationEntries.map(([id]) => id),
  );
  const workbenchSourceVersion = Math.max(
    0,
    ...workbenchHistory.applied.map((migration) => migration.migrationId),
  );
  const workbenchTargetVersion = workbenchMigrationEntries.length;
  const formatSourceVersion = observation.workbenchFormatVersion;
  const formatTargetVersion = WORKBENCH_SCHEMA_FORMAT_VERSION;
  const formatHasPendingUpgrade = formatSourceVersion < formatTargetVersion;
  const adoptedMigrationIds = adoption.kind === "adopt" ? adoption.migrationIds : [];
  const effectiveWorkbenchSource = Math.max(workbenchSourceVersion, ...adoptedMigrationIds);
  const officialHasPendingMigrations =
    lineagePlan.kind === "imported-divergence" || officialSourceVersion < officialTargetVersion;
  const workbenchHasPendingMigrations = effectiveWorkbenchSource < workbenchTargetVersion;
  const legacyOfficialMigrations =
    adoption.kind === "adopt"
      ? observation.officialRows
          .filter((row) => row.migration_id === 109 || row.migration_id === 110)
          .map((row) => ({
            officialId: row.migration_id as 109 | 110,
            officialName: row.name,
            workbenchId: (row.migration_id - 108) as 1 | 2,
          }))
      : [];
  const requiresBackup =
    !observation.databaseEmpty &&
    (officialHasPendingMigrations ||
      normalizedOfficial.changed ||
      workbenchHasPendingMigrations ||
      formatHasPendingUpgrade ||
      adoptedMigrationIds.length > 0);

  return {
    kind: "ready",
    ...(lineagePlan.kind === "imported-divergence" && lineagePlan.divergence !== undefined
      ? { lineageDivergence: lineagePlan.divergence }
      : {}),
    official: {
      sourceVersion: officialSourceVersion,
      sourceLabel: lineagePlan.sourceVersion,
      targetVersion: officialTargetVersion,
      replayTargetVersion,
      hasPendingMigrations: officialHasPendingMigrations,
      hasLineageRepair: normalizedOfficial.changed || lineagePlan.hasMetadataRepair,
    },
    workbench: {
      sourceVersion: workbenchSourceVersion,
      targetVersion: workbenchTargetVersion,
      adoptedMigrationIds,
      hasPendingMigrations: workbenchHasPendingMigrations,
    },
    format: {
      existsAtSource: observation.workbenchFormatExists,
      sourceVersion: formatSourceVersion,
      targetVersion: formatTargetVersion,
      hasPendingUpgrade: formatHasPendingUpgrade,
    },
    legacyOfficialMigrations,
    databaseEmpty: observation.databaseEmpty,
    requiresBackup,
  };
};

const isOfficialTrackerRecord = (
  rows: readonly OfficialMigrationRecord[],
): rows is readonly OfficialMigrationRecord[] => isOfficialRows(rows);

const isWorkbenchTrackerRecord = (
  rows: readonly WorkbenchMigrationRecord[],
): rows is readonly WorkbenchMigrationRecord[] => isWorkbenchRows(rows);

const emptySchemaState: WorkbenchSchemaState = {
  projectionThreadsExists: false,
  bindingColumn: null,
  runtimeRecordColumns: null,
};

/** Read-only SQLite inspection. This value is intended to be shared with backup and execution. */
export const inspectWorkbenchUpgradePlan = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const tables = yield* sql<{ readonly name: string }>`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
  `;
  const officialObject = yield* inspectSqliteObject(sql, "effect_sql_migrations");
  const workbenchObject = yield* inspectSqliteObject(sql, "workbench_sql_migrations");
  const officialTrackerExists = officialObject !== null;
  const workbenchTrackerExists = workbenchObject !== null;
  let officialTrackerValid = !officialTrackerExists;
  let workbenchTrackerValid = !workbenchTrackerExists;
  let officialRows: readonly OfficialMigrationRecord[] = [];
  let workbenchRows: readonly WorkbenchMigrationRecord[] = [];
  let workbenchFormatExists = false;
  let workbenchFormatValid = true;
  let workbenchFormatVersion = 0;
  let readError: string | undefined;

  if (officialObject !== null) {
    if (officialObject.type !== "table") {
      readError = "effect_sql_migrations exists but is not a table.";
    } else {
      const columns = yield* inspectTableColumns(sql, "effect_sql_migrations");
      officialTrackerValid = validateOfficialTrackerShape(columns);
      if (officialTrackerValid) {
        officialRows = yield* readOfficialMigrationRecords(sql);
        officialTrackerValid = isOfficialTrackerRecord(officialRows);
      }
    }
  }
  if (workbenchObject !== null) {
    if (workbenchObject.type !== "table") {
      readError ??= "workbench_sql_migrations exists but is not a table.";
    } else {
      const columns = yield* inspectTableColumns(sql, "workbench_sql_migrations");
      workbenchTrackerValid = validateWorkbenchTrackerShape(columns);
      if (workbenchTrackerValid) {
        workbenchRows = yield* sql<WorkbenchMigrationRecord>`
          SELECT module_id, migration_id, name, checksum, applied_at
          FROM workbench_sql_migrations ORDER BY module_id ASC, migration_id ASC
        `;
        workbenchTrackerValid = isWorkbenchTrackerRecord(workbenchRows);
      }
    }
  }

  const formatState = yield* readWorkbenchSchemaFormat.pipe(
    Effect.match({
      onFailure: (cause) => ({ error: cause instanceof Error ? cause.message : String(cause) }),
      onSuccess: (state) => ({ state }),
    }),
  );
  if ("error" in formatState) {
    readError ??= formatState.error;
    workbenchFormatValid = false;
  } else {
    workbenchFormatExists = formatState.state.exists;
    workbenchFormatVersion = formatState.state.version;
  }

  let schemaState = emptySchemaState;
  if (readError === undefined) {
    const result = yield* readWorkbenchSchemaState.pipe(
      Effect.match({
        onFailure: (cause) => ({ error: cause instanceof Error ? cause.message : String(cause) }),
        onSuccess: (state) => ({ state }),
      }),
    );
    if ("error" in result) readError = result.error;
    else schemaState = result.state;
  }

  const hasApplicationTables = tables.some(
    ({ name }) =>
      name !== "effect_sql_migrations" &&
      name !== "workbench_sql_migrations" &&
      name !== WORKBENCH_SCHEMA_METADATA_TABLE,
  );
  const databaseEmpty = tables.length === 0;
  return planWorkbenchUpgrade({
    databaseEmpty,
    hasApplicationTables,
    officialTrackerExists,
    officialTrackerValid,
    officialRows,
    workbenchTrackerExists,
    workbenchTrackerValid,
    workbenchRows,
    workbenchFormatExists,
    workbenchFormatValid,
    workbenchFormatVersion,
    schemaState,
    ...(readError === undefined ? {} : { readError }),
  });
});
