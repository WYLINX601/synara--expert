import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { planOfficialMigrationLineage } from "../../persistence/Migrations.ts";
import {
  LEGACY_OFFICIAL_MIGRATIONS,
  LEGACY_EXPERT_OFFICIAL_MIGRATIONS,
  LEGACY_CONTEXT_OFFICIAL_MIGRATIONS,
  WorkbenchMigrationError,
  ensureWorkbenchTracker,
  ensureWorkbenchSchemaFormat,
  inspectSqliteObject,
  inspectTableColumns,
  normalizeRecognizedOfficialMigrationRows,
  planWorkbenchHistory,
  readOfficialMigrationRecords,
  readWorkbenchSchemaState,
  readWorkbenchTracker,
  validateOfficialMigrationPrefixAgainstCatalog,
  currentOfficialMigrationCatalog,
  type OfficialMigrationCatalog,
  validateFrozenLegacyOfficialPrefix,
  validateOfficialTrackerShape,
  validateWorkbenchSchemaState,
  workbenchMigrationEntries,
  contextWorkbenchMigrationEntries,
  type OfficialMigrationRecord,
  type WorkbenchMigrationRecord,
  type WorkbenchSchemaState,
} from "./WorkbenchMigrations.ts";

export interface LegacyExpertMigrationAdoptionInput {
  readonly officialTrackerExists: boolean;
  readonly officialRows: readonly OfficialMigrationRecord[];
  readonly workbenchTrackerExists: boolean;
  readonly workbenchRows: readonly WorkbenchMigrationRecord[];
  readonly schemaState: WorkbenchSchemaState;
  /** True only when SQLite has no non-system tables at all. */
  readonly databaseEmpty?: boolean | undefined;
  readonly hasApplicationTables?: boolean | undefined;
  /** The live official catalog, injectable for pure future-catalog tests. */
  readonly officialCatalog?: OfficialMigrationCatalog | undefined;
}

export type AdoptedLegacyMigration = {
  readonly moduleId: "expert" | "context";
  readonly officialId: number;
  readonly officialName: string;
  readonly workbenchId: number;
};

export type LegacyExpertMigrationAdoptionPlan =
  | { readonly kind: "none" }
  | {
      readonly kind: "adopt";
      readonly migrationIds: readonly (1 | 2)[];
      readonly contextMigrationIds: readonly 1[];
      readonly legacyMigrations: readonly AdoptedLegacyMigration[];
    }
  | { readonly kind: "invalid"; readonly reason: string };

const isExactLegacyIdentity = (row: OfficialMigrationRecord) =>
  LEGACY_OFFICIAL_MIGRATIONS.find(
    (migration) => migration.officialId === row.migration_id && migration.officialName === row.name,
  );

/**
 * Recognize the exact pre-upstream workbench rows before checking the current
 * official catalog, which has since reused IDs 109–111. Unknown identities in
 * those slots remain unsupported and fail closed.
 */
export const planLegacyExpertMigrationAdoption = (
  input: LegacyExpertMigrationAdoptionInput,
): LegacyExpertMigrationAdoptionPlan => {
  const databaseEmpty =
    input.databaseEmpty ??
    (!input.officialTrackerExists &&
      !input.workbenchTrackerExists &&
      input.officialRows.length === 0 &&
      input.workbenchRows.length === 0 &&
      input.hasApplicationTables !== true);

  if (!input.officialTrackerExists && input.officialRows.length > 0) {
    return {
      kind: "invalid",
      reason: "Official migration rows exist without their tracker table.",
    };
  }
  if (!input.workbenchTrackerExists && input.workbenchRows.length > 0) {
    return {
      kind: "invalid",
      reason: "Workbench migration rows exist without their tracker table.",
    };
  }
  if (!input.officialTrackerExists && !databaseEmpty) {
    return { kind: "invalid", reason: "A non-empty database has no official migration tracker." };
  }

  const recognizedEarlyOfficialPrefix =
    input.officialTrackerExists &&
    input.officialRows.length > 0 &&
    input.officialRows.every(({ migration_id }) => migration_id >= 1 && migration_id <= 4);
  if (
    !input.schemaState.projectionThreadsExists &&
    !databaseEmpty &&
    !recognizedEarlyOfficialPrefix
  ) {
    return {
      kind: "invalid",
      reason:
        "The official projection_threads table is missing from a non-empty or migrated database.",
    };
  }

  const workbenchPlan = planWorkbenchHistory(input.workbenchRows);
  if (!workbenchPlan.ok) return { kind: "invalid", reason: workbenchPlan.reason };

  const officialCatalog = input.officialCatalog ?? currentOfficialMigrationCatalog();
  // A prior foreign divergence must never hide an unknown identity in a slot
  // shared by the official catalog and a frozen local migration.
  for (const row of input.officialRows) {
    if (
      LEGACY_OFFICIAL_MIGRATIONS.some(({ officialId }) => officialId === row.migration_id) &&
      isExactLegacyIdentity(row) === undefined &&
      !officialCatalog.some(([id, name]) => id === row.migration_id && name === row.name)
    ) {
      return {
        kind: "invalid",
        reason: `Official migration ${row.migration_id} has an unknown identity in a reserved legacy workbench slot.`,
      };
    }
  }

  const legacyMigrations = input.officialRows.flatMap((row) => {
    const identity = isExactLegacyIdentity(row);
    if (identity === undefined) return [];
    const moduleId = LEGACY_CONTEXT_OFFICIAL_MIGRATIONS.some(
      ({ officialId }) => officialId === identity.officialId,
    )
      ? "context"
      : "expert";
    return [{ ...identity, moduleId } satisfies AdoptedLegacyMigration];
  });

  if (legacyMigrations.length > 0) {
    const frozenPrefixIssue = validateFrozenLegacyOfficialPrefix(input.officialRows);
    if (frozenPrefixIssue !== null) return { kind: "invalid", reason: frozenPrefixIssue };

    const expertLegacyIds = legacyMigrations
      .filter(({ moduleId }) => moduleId === "expert")
      .map(({ workbenchId }) => workbenchId);
    const contextLegacyIds = legacyMigrations
      .filter(({ moduleId }) => moduleId === "context")
      .map(({ workbenchId }) => workbenchId);
    if (
      expertLegacyIds.some((id) => workbenchPlan.appliedByModule.expert >= id) ||
      contextLegacyIds.some((id) => workbenchPlan.appliedByModule.context >= id)
    ) {
      return {
        kind: "invalid",
        reason: "A legacy migration is recorded in both the official and workbench trackers.",
      };
    }

    const schemaIssue = validateWorkbenchSchemaState(
      {
        expert: Math.max(workbenchPlan.appliedByModule.expert, ...expertLegacyIds, 0),
        context: Math.max(workbenchPlan.appliedByModule.context, ...contextLegacyIds, 0),
      },
      input.schemaState,
    );
    if (schemaIssue !== null) return { kind: "invalid", reason: schemaIssue };

    return {
      kind: "adopt",
      migrationIds: expertLegacyIds as readonly (1 | 2)[],
      contextMigrationIds: contextLegacyIds as readonly 1[],
      legacyMigrations,
    };
  }

  const normalizedOfficial = normalizeRecognizedOfficialMigrationRows(input.officialRows);
  const currentOfficialIssue = validateOfficialMigrationPrefixAgainstCatalog(
    normalizedOfficial.rows,
    officialCatalog,
  );
  const officialLineage = planOfficialMigrationLineage(input.officialRows, officialCatalog);
  if (officialLineage.kind === "imported-divergence") {
    const reservedSlot = LEGACY_OFFICIAL_MIGRATIONS.find(
      ({ officialId }) => officialId === officialLineage.divergence?.firstDivergedId,
    );
    if (reservedSlot !== undefined) {
      return {
        kind: "invalid",
        reason: `Official migration ${reservedSlot.officialId} has an unknown identity in a reserved legacy workbench slot.`,
      };
    }
  } else if (officialLineage.kind === "shared-divergence") {
    return {
      kind: "invalid",
      reason:
        officialLineage.divergence === undefined
          ? "The official migration lineage is not supported."
          : `Official migration ${officialLineage.divergence.firstDivergedId} diverges from the shared lineage.`,
    };
  } else if (officialLineage.kind === "future-prefix") {
    return {
      kind: "invalid",
      reason: `Official migration history is newer than this build supports (through ${officialLineage.rawHighWaterMark}).`,
    };
  } else if (currentOfficialIssue !== null) {
    return { kind: "invalid", reason: currentOfficialIssue };
  }

  const schemaIssue = validateWorkbenchSchemaState(
    workbenchPlan.appliedByModule,
    input.schemaState,
  );
  if (schemaIssue !== null) return { kind: "invalid", reason: schemaIssue };
  return { kind: "none" };
};

export interface AdoptLegacyExpertMigrationsResult {
  readonly adoptedMigrationIds: readonly (1 | 2)[];
  readonly adoptedContextMigrationIds: readonly 1[];
}

const fail = (reason: string) => Effect.fail(new WorkbenchMigrationError({ reason }));

/** Audit and transfer exact legacy identities atomically on the shared SQLite connection. */
export const adoptLegacyExpertMigrations = () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const officialTracker = yield* inspectSqliteObject(sql, "effect_sql_migrations");
        if (officialTracker !== null && officialTracker.type !== "table") {
          return yield* fail("effect_sql_migrations exists but is not a table.");
        }

        let officialRows: readonly OfficialMigrationRecord[] = [];
        if (officialTracker !== null) {
          const columns = yield* inspectTableColumns(sql, "effect_sql_migrations");
          if (!validateOfficialTrackerShape(columns)) {
            return yield* fail(
              "The official effect_sql_migrations table has an unsupported schema.",
            );
          }
          officialRows = yield* readOfficialMigrationRecords(sql);
        }
        const workbenchTracker = yield* readWorkbenchTracker;
        const schemaState = yield* readWorkbenchSchemaState;
        const databaseTables = yield* sql<{ readonly name: string }>`
          SELECT name FROM sqlite_master
          WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
        `;
        const applicationTables = databaseTables.filter(
          ({ name }) =>
            name !== "effect_sql_migrations" &&
            name !== "workbench_sql_migrations" &&
            name !== "workbench_schema_metadata",
        );
        const plan = planLegacyExpertMigrationAdoption({
          officialTrackerExists: officialTracker !== null,
          officialRows,
          workbenchTrackerExists: workbenchTracker.exists,
          workbenchRows: workbenchTracker.rows,
          schemaState,
          databaseEmpty: databaseTables.length === 0,
          hasApplicationTables: applicationTables.length > 0,
        });
        if (plan.kind === "invalid") return yield* fail(plan.reason);
        if (plan.kind === "none") {
          return { adoptedMigrationIds: [], adoptedContextMigrationIds: [] } as const;
        }

        yield* ensureWorkbenchTracker;
        yield* ensureWorkbenchSchemaFormat;
        yield* ensureLegacyAdoptionAudit(sql);
        const currentTracker = yield* readWorkbenchTracker;
        const currentHistory = planWorkbenchHistory(currentTracker.rows);
        if (!currentHistory.ok) return yield* fail(currentHistory.reason);
        if (
          plan.migrationIds.some((id) => currentHistory.appliedByModule.expert >= id) ||
          plan.contextMigrationIds.some((id) => currentHistory.appliedByModule.context >= id)
        ) {
          return yield* fail("Workbench migration history changed during legacy adoption.");
        }

        for (const migrationId of plan.migrationIds) {
          const migration = workbenchMigrationEntries.find(
            (entry) => entry.migrationId === migrationId,
          );
          if (migration === undefined) {
            return yield* fail(
              `No expert workbench migration exists for legacy ID ${migrationId}.`,
            );
          }
          yield* insertAdoptedMigration(sql, migration);
        }
        for (const migrationId of plan.contextMigrationIds) {
          const migration = contextWorkbenchMigrationEntries.find(
            (entry) => entry.migrationId === migrationId,
          );
          if (migration === undefined) {
            return yield* fail(
              `No context workbench migration exists for legacy ID ${migrationId}.`,
            );
          }
          yield* insertAdoptedMigration(sql, migration);
        }
        for (const legacy of plan.legacyMigrations) {
          const migration = [
            ...workbenchMigrationEntries,
            ...contextWorkbenchMigrationEntries,
          ].find(
            (entry) =>
              entry.moduleId === legacy.moduleId && entry.migrationId === legacy.workbenchId,
          );
          if (migration === undefined)
            return yield* fail("The adopted migration has no frozen implementation.");
          const audited = yield* sql<{ readonly official_id: number }>`
            INSERT INTO workbench_legacy_migration_adoptions (
              module_id, migration_id, official_id, official_name,
              official_created_at, checksum, adopted_at
            ) SELECT ${legacy.moduleId}, ${legacy.workbenchId}, migration_id, name,
                created_at, ${migration.checksum}, ${new Date().toISOString()}
              FROM effect_sql_migrations
              WHERE migration_id = ${legacy.officialId} AND name = ${legacy.officialName}
              RETURNING official_id
          `;
          if (audited.length !== 1)
            return yield* fail("The legacy migration identity changed before its audit.");
          yield* sql`
            DELETE FROM effect_sql_migrations
            WHERE migration_id = ${legacy.officialId} AND name = ${legacy.officialName}
          `;
        }

        const remainingRows = yield* readOfficialMigrationRecords(sql);
        if (
          plan.legacyMigrations.some(({ officialId, officialName }) =>
            remainingRows.some(
              (row) => row.migration_id === officialId && row.name === officialName,
            ),
          )
        ) {
          return yield* fail("A legacy official migration identity changed during adoption.");
        }
        return {
          adoptedMigrationIds: plan.migrationIds,
          adoptedContextMigrationIds: plan.contextMigrationIds,
        };
      }),
    );
  });

const insertAdoptedMigration = (
  sql: SqlClient.SqlClient,
  migration:
    | (typeof workbenchMigrationEntries)[number]
    | (typeof contextWorkbenchMigrationEntries)[number],
) =>
  sql`
    INSERT INTO workbench_sql_migrations (
      module_id, migration_id, name, checksum, applied_at
    ) VALUES (
      ${migration.moduleId}, ${migration.migrationId}, ${migration.name},
      ${migration.checksum}, ${new Date().toISOString()}
    )
  `;

/** The audit belongs to the ledger infrastructure and is written in the adoption transaction. */
const ensureLegacyAdoptionAudit = (sql: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    const tableName = "workbench_legacy_migration_adoptions";
    const object = yield* inspectSqliteObject(sql, tableName);
    if (object === null) {
      yield* sql`CREATE TABLE workbench_legacy_migration_adoptions (
      module_id TEXT NOT NULL,
      migration_id INTEGER NOT NULL,
      official_id INTEGER NOT NULL,
      official_name TEXT NOT NULL,
      official_created_at TEXT NOT NULL,
      checksum TEXT NOT NULL,
      adopted_at TEXT NOT NULL,
      PRIMARY KEY (module_id, migration_id)
    )`;
    } else if (object.type !== "table") {
      return yield* fail("The legacy migration audit exists but is not a table.");
    }
    const columns = yield* inspectTableColumns(sql, tableName);
    const expected = [
      ["module_id", "TEXT", 1],
      ["migration_id", "INTEGER", 2],
      ["official_id", "INTEGER", 0],
      ["official_name", "TEXT", 0],
      ["official_created_at", "TEXT", 0],
      ["checksum", "TEXT", 0],
      ["adopted_at", "TEXT", 0],
    ] as const;
    if (
      columns.length !== expected.length ||
      columns.some((column, index) => {
        const entry = expected[index];
        return (
          entry === undefined ||
          column.name !== entry[0] ||
          column.type.toUpperCase() !== entry[1] ||
          column.pk !== entry[2] ||
          column.notnull !== 1 ||
          column.dflt_value !== null
        );
      })
    ) {
      return yield* fail("The legacy migration audit has an unsupported schema.");
    }
  });
