import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  EXPERT_WORKBENCH_MODULE_ID,
  LEGACY_EXPERT_OFFICIAL_MIGRATIONS,
  WorkbenchMigrationError,
  ensureWorkbenchTracker,
  inspectSqliteObject,
  inspectTableColumns,
  planWorkbenchHistory,
  readOfficialMigrationRecords,
  readWorkbenchSchemaState,
  readWorkbenchTracker,
  validateCurrentOfficialMigrationPrefix,
  validateFrozenLegacyOfficialPrefix,
  validateOfficialTrackerShape,
  validateWorkbenchSchemaState,
  workbenchMigrationEntries,
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
}

export type LegacyExpertMigrationAdoptionPlan =
  | { readonly kind: "none" }
  | { readonly kind: "adopt"; readonly migrationIds: readonly (1 | 2)[] }
  | { readonly kind: "invalid"; readonly reason: string };

/**
 * Pure recognition of the two expert migrations formerly stored in the
 * official Synara tracker. Only the exact official prefix and exact resulting
 * schema can be transferred to the expert module's local IDs.
 */
export const planLegacyExpertMigrationAdoption = (
  input: LegacyExpertMigrationAdoptionInput,
): LegacyExpertMigrationAdoptionPlan => {
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

  const officialTail = input.officialRows.filter((row) => row.migration_id > 108);
  const workbenchPlan = planWorkbenchHistory(input.workbenchRows);
  if (!workbenchPlan.ok) {
    return { kind: "invalid", reason: workbenchPlan.reason };
  }

  const firstTail = officialTail[0];
  const firstLegacyIdentity = LEGACY_EXPERT_OFFICIAL_MIGRATIONS[0];
  const isLegacyExpertTail =
    firstTail?.migration_id === firstLegacyIdentity.officialId &&
    firstTail.name === firstLegacyIdentity.officialName;

  if (isLegacyExpertTail) {
    const frozenPrefixIssue = validateFrozenLegacyOfficialPrefix(input.officialRows);
    if (frozenPrefixIssue !== null) {
      return { kind: "invalid", reason: frozenPrefixIssue };
    }
    if (workbenchPlan.applied.length > 0) {
      return {
        kind: "invalid",
        reason: "Expert migrations are recorded in both the official and workbench trackers.",
      };
    }
    const migrationIds = officialTail.length === 2 ? ([1, 2] as const) : ([1] as const);
    const schemaIssue = validateWorkbenchSchemaState(migrationIds.length, input.schemaState);
    if (schemaIssue !== null) {
      return { kind: "invalid", reason: schemaIssue };
    }
    return { kind: "adopt", migrationIds };
  }

  const currentOfficialIssue = validateCurrentOfficialMigrationPrefix(input.officialRows);
  if (currentOfficialIssue !== null) {
    return { kind: "invalid", reason: currentOfficialIssue };
  }

  const schemaIssue = validateWorkbenchSchemaState(workbenchPlan.applied.length, input.schemaState);
  if (schemaIssue !== null) {
    return { kind: "invalid", reason: schemaIssue };
  }
  return { kind: "none" };
};

export interface AdoptLegacyExpertMigrationsResult {
  readonly adoptedMigrationIds: readonly (1 | 2)[];
}

const fail = (reason: string) => Effect.fail(new WorkbenchMigrationError({ reason }));

/**
 * Atomically transfers recognized expert migration rows from the official
 * tracker to workbench_sql_migrations. No schema or business rows are changed.
 */
export const adoptLegacyExpertMigrations = () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const officialTracker = yield* inspectSqliteObject(sql, "effect_sql_migrations");
        if (officialTracker !== null && officialTracker.type !== "table") {
          return yield* fail("effect_sql_migrations exists but is not a table.");
        }

        const officialRows =
          officialTracker === null
            ? []
            : yield* Effect.gen(function* () {
                const columns = yield* inspectTableColumns(sql, "effect_sql_migrations");
                if (!validateOfficialTrackerShape(columns)) {
                  return yield* fail(
                    "The official effect_sql_migrations table has an unsupported schema.",
                  );
                }
                return yield* readOfficialMigrationRecords(sql);
              });
        const workbenchTracker = yield* readWorkbenchTracker;
        const schemaState = yield* readWorkbenchSchemaState;
        const plan = planLegacyExpertMigrationAdoption({
          officialTrackerExists: officialTracker !== null,
          officialRows,
          workbenchTrackerExists: workbenchTracker.exists,
          workbenchRows: workbenchTracker.rows,
          schemaState,
        });
        if (plan.kind === "invalid") return yield* fail(plan.reason);
        if (plan.kind === "none") return { adoptedMigrationIds: [] };

        yield* ensureWorkbenchTracker;
        const currentWorkbenchTracker = yield* readWorkbenchTracker;
        const currentHistory = planWorkbenchHistory(currentWorkbenchTracker.rows);
        if (!currentHistory.ok || currentHistory.applied.length !== 0) {
          return yield* fail("Workbench migration history changed during legacy adoption.");
        }

        for (const migrationId of plan.migrationIds) {
          const migration = workbenchMigrationEntries[migrationId - 1];
          if (migration === undefined || migration.moduleId !== EXPERT_WORKBENCH_MODULE_ID) {
            return yield* fail(
              `No expert workbench migration exists for legacy ID ${migrationId}.`,
            );
          }
          yield* sql`
            INSERT INTO workbench_sql_migrations (
              module_id, migration_id, name, checksum, applied_at
            ) VALUES (
              ${migration.moduleId}, ${migration.migrationId}, ${migration.name},
              ${migration.checksum}, ${new Date().toISOString()}
            )
          `;
        }
        for (const migrationId of plan.migrationIds) {
          const officialId = LEGACY_EXPERT_OFFICIAL_MIGRATIONS.find(
            (migration) => migration.workbenchId === migrationId,
          )?.officialId;
          if (officialId === undefined) {
            return yield* fail(
              `No legacy official migration exists for workbench ID ${migrationId}.`,
            );
          }
          yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id = ${officialId}`;
        }

        return { adoptedMigrationIds: plan.migrationIds };
      }),
    );
  });
