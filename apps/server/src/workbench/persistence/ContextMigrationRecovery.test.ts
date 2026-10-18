import { DatabaseSync } from "node:sqlite";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { afterEach, expect, it } from "vitest";

import {
  MIGRATION_RECOVERY_MAX_RESUME_ATTEMPTS,
  migrationBackupProvenancePath,
} from "@synara/shared/migrationRecovery";
import {
  createMigrationBackup,
  inspectPendingMigrationRecovery,
  migrationBackupDirectory,
  migrationRecoveryMarkerPath,
  requireNoPendingMigrationRecovery,
  restoreMarkedMigrationBackup,
  resumeMarkedMigration,
  runWithPreMigrationBackup,
} from "../../persistence/MigrationBackup.ts";
import { runMigrations } from "../../persistence/Migrations.ts";
import ExpertBindingMigration from "../../persistence/Migrations/109_ProjectionThreadsExpertBinding.ts";
import ExpertRuntimeMigration from "../../persistence/Migrations/110_ExpertAppliedRuntimeRecords.ts";
import ContextV1Migration from "../../persistence/Migrations/111_ContextV1.ts";
import * as NodeSqliteClient from "../../persistence/NodeSqliteClient.ts";
import { makeSqlitePersistenceLive } from "../../persistence/Layers/Sqlite.ts";
import { adoptLegacyExpertMigrations } from "./LegacyExpertMigrationAdoption.ts";
import {
  ensureWorkbenchTracker,
  runWorkbenchMigrations,
  workbenchMigrationEntries,
} from "./WorkbenchMigrations.ts";
import { inspectWorkbenchUpgradePlan } from "./WorkbenchUpgradePlan.ts";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

async function makeDbPath() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "synara-context-recovery-"));
  directories.push(directory);
  return path.join(directory, "state.sqlite");
}

const runWithDatabase = <A, E>(dbPath: string, effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  Effect.runPromise(effect.pipe(Effect.provide(NodeSqliteClient.layer({ filename: dbPath }))));

const seedOld111 = (expert: "legacy" | "ledger" | "absent" = "ledger") =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 108 });
    if (expert !== "absent") {
      yield* ExpertBindingMigration;
      yield* ExpertRuntimeMigration;
      if (expert === "legacy") {
        yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES
          (109, 'ProjectionThreadsExpertBinding'), (110, 'ExpertAppliedRuntimeRecords')`;
      } else {
        yield* ensureWorkbenchTracker;
        for (const migration of workbenchMigrationEntries) {
          yield* sql`INSERT INTO workbench_sql_migrations (module_id, migration_id, name, checksum, applied_at)
            VALUES ('expert', ${migration.migrationId}, ${migration.name}, ${migration.checksum}, '2026-10-12')`;
        }
      }
    }
    yield* ContextV1Migration;
    yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (111, 'ContextV1')`;
    yield* sql`UPDATE effect_sql_migrations SET created_at = '2026-10-12T11:12:13.000Z' WHERE migration_id = 111`;
    yield* sql`INSERT INTO context_spaces VALUES ('space-1', 'goal', 'instructions', 5, '2026-10-12')`;
    yield* sql`INSERT INTO context_projects VALUES ('project-1', 'goal', 'instructions', 8, '2026-10-12')`;
    yield* sql`INSERT INTO context_migrations VALUES ('project-1', 'legacy-digest', 'legacy', 'completed', 'keep_saved', '2026-10-12')`;
    yield* sql`INSERT INTO context_thread_bindings VALUES ('thread-1', 'bound', '{"snapshotId":"snapshot-1","revision":8}')`;
    yield* sql`INSERT INTO context_applied_runtime_records VALUES ('thread-1', '{"snapshotId":"snapshot-1","acknowledged":true}')`;
    yield* sql`INSERT INTO context_command_results VALUES ('command-1', '{"snapshotId":"snapshot-1","ok":true}')`;
    yield* sql`INSERT INTO orchestration_consumer_state VALUES ('context-consumer', 0, '2026-10-12', '2026-10-12')`;
    yield* sql`INSERT INTO orchestration_event_deliveries (
      consumer_name, event_sequence, thread_id, state, updated_at,
      context_snapshot_id, context_input_digest, context_message_id, context_phase
    ) VALUES ('context-consumer', 1, 'thread-1', 'succeeded', '2026-10-12',
      'snapshot-1', 'digest-1', 'message-1', 'acknowledged')`;
  });

const contextTables = [
  "context_meta",
  "context_spaces",
  "context_projects",
  "context_migrations",
  "context_thread_bindings",
  "context_applied_runtime_records",
  "context_command_results",
];

function inspectFile(dbPath: string) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const exists = (name: string) =>
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !==
      undefined;
    return {
      context: Object.fromEntries(
        contextTables.map((table) => [table, db.prepare(`SELECT * FROM ${table}`).all()]),
      ),
      deliveries: db
        .prepare(
          "SELECT * FROM orchestration_event_deliveries WHERE consumer_name = 'context-consumer'",
        )
        .all(),
      official: db.prepare("SELECT * FROM effect_sql_migrations ORDER BY migration_id").all(),
      workbench: exists("workbench_sql_migrations")
        ? db
            .prepare("SELECT * FROM workbench_sql_migrations ORDER BY module_id, migration_id")
            .all()
        : null,
      audit: exists("workbench_legacy_migration_adoptions")
        ? db
            .prepare(
              "SELECT * FROM workbench_legacy_migration_adoptions ORDER BY module_id, migration_id",
            )
            .all()
        : null,
    };
  } finally {
    db.close();
  }
}

async function backupPaths(dbPath: string) {
  const names = await fs.readdir(migrationBackupDirectory(dbPath));
  return names
    .filter((name) => name.endsWith(".sqlite"))
    .map((name) => path.join(migrationBackupDirectory(dbPath), name));
}

const fullUpgrade = Effect.gen(function* () {
  yield* adoptLegacyExpertMigrations();
  yield* runMigrations();
  yield* runWorkbenchMigrations();
});

const startNormally = (dbPath: string) =>
  Effect.runPromise(
    Effect.void.pipe(
      Effect.provide(makeSqlitePersistenceLive(dbPath).pipe(Layer.provide(NodeServices.layer))),
    ),
  );

it.each(["legacy", "ledger"] as const)(
  "backs up, fully starts, reopens and restores old Context111 with Expert %s",
  async (expert) => {
    const dbPath = await makeDbPath();
    await runWithDatabase(dbPath, seedOld111(expert));
    const original = inspectFile(dbPath);
    await startNormally(dbPath);
    const completed = JSON.parse(await fs.readFile(migrationBackupProvenancePath(dbPath), "utf8"));
    expect(completed).toMatchObject({
      version: 3,
      phase: "migration-completed",
      resumeAttempts: 0,
      migrationVersions: {
        source: { official: 108, workbench: expert === "ledger" ? 2 : 0, format: 0 },
        target: { official: 135, workbench: 2, format: 1 },
      },
      moduleVersions: {
        source: { expert: expert === "ledger" ? 2 : 0, context: 0 },
        target: { expert: 2, context: 1 },
      },
    });
    expect(await backupPaths(dbPath)).toEqual([completed.backupPath]);
    const first = inspectFile(dbPath);
    expect(first.context).toEqual(original.context);
    expect(first.deliveries).toEqual(original.deliveries);
    expect(first.official.at(-1)).toMatchObject({ migration_id: 135 });
    expect(first.audit).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          module_id: "context",
          migration_id: 1,
          official_id: 111,
          official_name: "ContextV1",
          official_created_at: "2026-10-12T11:12:13.000Z",
          checksum: "sha256:b7dbd84911484156f3f38093973338ca005dce9e8ba4b38b8972d9dfe79a4911",
        }),
      ]),
    );
    await startNormally(dbPath);
    expect(inspectFile(dbPath)).toEqual(first);
    expect(await backupPaths(dbPath)).toEqual([completed.backupPath]);
    await Effect.runPromise(restoreMarkedMigrationBackup(dbPath));
    expect(inspectFile(dbPath)).toEqual(original);
    expect(await fs.readFile(migrationBackupProvenancePath(dbPath), "utf8")).toContain(
      '"migration-restored"',
    );
  },
);

type Failpoint = "before-adoption" | "after-adoption" | "after-official" | "during-extension";
const interruptUpgrade = (point: Failpoint) =>
  Effect.gen(function* () {
    if (point === "before-adoption") return yield* Effect.fail(new Error(`injected ${point}`));
    yield* adoptLegacyExpertMigrations();
    if (point === "after-adoption") return yield* Effect.fail(new Error(`injected ${point}`));
    yield* runMigrations();
    if (point === "after-official") return yield* Effect.fail(new Error(`injected ${point}`));
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TRIGGER reject_second_expert BEFORE INSERT ON workbench_sql_migrations
    WHEN NEW.module_id = 'expert' AND NEW.migration_id = 2
    BEGIN SELECT RAISE(ABORT, 'injected during-extension'); END`;
    yield* runWorkbenchMigrations();
  });

for (const point of [
  "before-adoption",
  "after-adoption",
  "after-official",
  "during-extension",
] as const) {
  it(`resumes ${point} against the original v3 backup, preserves retry budget and restores original old111 data`, async () => {
    const dbPath = await makeDbPath();
    await runWithDatabase(dbPath, seedOld111(point === "during-extension" ? "absent" : "ledger"));
    const original = inspectFile(dbPath);
    await expect(
      runWithDatabase(
        dbPath,
        Effect.gen(function* () {
          const plan = yield* inspectWorkbenchUpgradePlan;
          if (plan.kind !== "ready") throw new Error(plan.reason);
          yield* runWithPreMigrationBackup(dbPath, interruptUpgrade(point), { upgradePlan: plan });
        }),
      ),
    ).rejects.toThrow(
      point === "during-extension" ? "Failed to execute statement" : `injected ${point}`,
    );
    const marker = await Effect.runPromise(inspectPendingMigrationRecovery(dbPath));
    expect(marker).not.toBeNull();
    expect(marker?.payload).toMatchObject({
      version: 3,
      resumeAttempts: 0,
      moduleVersions: { target: { expert: 2, context: 1 } },
      migrationVersions: { target: { official: 135, workbench: 2, format: 1 } },
    });
    expect(await backupPaths(dbPath)).toEqual([marker!.backupPath]);
    expect(inspectFile(marker!.backupPath)).toEqual(original);
    expect(inspectFile(dbPath).context).toEqual(original.context);
    expect(inspectFile(dbPath).deliveries).toEqual(original.deliveries);
    if (point === "during-extension") {
      expect(inspectFile(dbPath).workbench).toEqual(
        expect.arrayContaining([expect.objectContaining({ module_id: "expert", migration_id: 1 })]),
      );
      expect(inspectFile(dbPath).workbench).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ module_id: "expert", migration_id: 2 })]),
      );
    }
    await expect(
      runWithDatabase(
        dbPath,
        resumeMarkedMigration(dbPath, marker!, Effect.fail(new Error("injected retry"))),
      ),
    ).rejects.toThrow("injected retry");
    const retry = await Effect.runPromise(inspectPendingMigrationRecovery(dbPath));
    expect(retry).toMatchObject({ backupPath: marker!.backupPath, resumeAttempts: 1 });
    expect(await backupPaths(dbPath)).toEqual([marker!.backupPath]);
    expect(inspectFile(marker!.backupPath)).toEqual(original);
    if (point === "during-extension") {
      await runWithDatabase(
        dbPath,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`DROP TRIGGER reject_second_expert`;
        }),
      );
    }
    await runWithDatabase(dbPath, resumeMarkedMigration(dbPath, retry!, fullUpgrade));
    expect(await Effect.runPromise(inspectPendingMigrationRecovery(dbPath))).toBeNull();
    const completed = JSON.parse(await fs.readFile(migrationBackupProvenancePath(dbPath), "utf8"));
    expect(completed).toMatchObject({
      version: 3,
      backupPath: marker!.backupPath,
      phase: "migration-completed",
      resumeAttempts: MIGRATION_RECOVERY_MAX_RESUME_ATTEMPTS,
    });
    expect(await backupPaths(dbPath)).toEqual([marker!.backupPath]);
    expect(inspectFile(dbPath).context).toEqual(original.context);
    expect(inspectFile(dbPath).deliveries).toEqual(original.deliveries);
    await Effect.runPromise(restoreMarkedMigrationBackup(dbPath));
    expect(inspectFile(dbPath)).toEqual(original);
  });
}

it("stops after the v3 resume budget is exhausted and preserves the original Context backup", async () => {
  const dbPath = await makeDbPath();
  await runWithDatabase(dbPath, seedOld111());
  const original = inspectFile(dbPath);
  await expect(
    runWithDatabase(
      dbPath,
      Effect.gen(function* () {
        const plan = yield* inspectWorkbenchUpgradePlan;
        yield* runWithPreMigrationBackup(dbPath, Effect.fail(new Error("interrupt")), {
          upgradePlan: plan,
        });
      }),
    ),
  ).rejects.toThrow("interrupt");
  for (let attempt = 0; attempt < MIGRATION_RECOVERY_MAX_RESUME_ATTEMPTS; attempt++) {
    const marker = await Effect.runPromise(inspectPendingMigrationRecovery(dbPath));
    expect(marker!.resumeAttempts).toBe(attempt);
    await expect(
      runWithDatabase(
        dbPath,
        resumeMarkedMigration(dbPath, marker!, Effect.fail(new Error("retry failed"))),
      ),
    ).rejects.toThrow("retry failed");
  }
  const markerText = await fs.readFile(migrationRecoveryMarkerPath(dbPath), "utf8");
  const marker = JSON.parse(markerText);
  expect(marker.resumeAttempts).toBe(MIGRATION_RECOVERY_MAX_RESUME_ATTEMPTS);
  await expect(Effect.runPromise(requireNoPendingMigrationRecovery(dbPath))).rejects.toThrow();
  await expect(Effect.runPromise(inspectPendingMigrationRecovery(dbPath))).rejects.toThrow(
    "Startup already re-ran the interrupted migration",
  );
  expect(await fs.readFile(migrationRecoveryMarkerPath(dbPath), "utf8")).toBe(markerText);
  expect(await backupPaths(dbPath)).toEqual([marker.backupPath]);
  expect(inspectFile(dbPath)).toEqual(original);
  await Effect.runPromise(restoreMarkedMigrationBackup(dbPath));
  expect(inspectFile(dbPath)).toEqual(original);
});

function inspectV2Fixture(dbPath: string) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return {
      official: db.prepare("SELECT * FROM effect_sql_migrations ORDER BY migration_id").all(),
      probe: db.prepare("SELECT * FROM old_marker_probe").all(),
    };
  } finally {
    db.close();
  }
}

for (const version of [1, 2] as const) {
  for (const target of [111, 135]) {
    it(`handles pending v${version} target${target} without expanding its recorded authorization or replacing its backup`, async () => {
      const dbPath = await makeDbPath();
      const backup = await runWithDatabase(
        dbPath,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          if (version === 1) {
            yield* seedOld111("legacy");
          } else {
            yield* runMigrations({ toMigrationInclusive: 108 });
            yield* sql`CREATE TABLE old_marker_probe(value TEXT NOT NULL)`;
            yield* sql`INSERT INTO old_marker_probe VALUES ('preserved from v2')`;
          }
          return yield* createMigrationBackup(dbPath, {
            sourceVersion: version === 1 ? "v111" : "v108-wb0-fmt0",
            targetVersion: target,
          });
        }),
      );
      const readFixture = version === 1 ? inspectFile : inspectV2Fixture;
      const original = readFixture(dbPath);
      const originalPayload = {
        version,
        databasePath: dbPath,
        backupPath: backup.backupPath,
        sourceVersion: version === 1 ? "v111" : "v108-wb0-fmt0",
        targetVersion: target,
        lineageDivergence: null,
        phase: "migration-in-progress",
        createdAt: backup.createdAt,
        resumeAttempts: 0,
        ...(version === 2
          ? {
              migrationVersions: {
                source: { official: 108, workbench: 0, format: 0 },
                target: { official: target, workbench: 2, format: 1 },
              },
              legacyExpertMigrations: [],
            }
          : {}),
      };
      const markerText = `${JSON.stringify(originalPayload)}\n`;
      await fs.writeFile(migrationRecoveryMarkerPath(dbPath), markerText, { mode: 0o600 });
      const marker = await Effect.runPromise(inspectPendingMigrationRecovery(dbPath));
      expect(marker).toMatchObject({ backupPath: backup.backupPath, resumeAttempts: 0 });
      const tryConversion = runWithDatabase(
        dbPath,
        Effect.gen(function* () {
          const plan = yield* inspectWorkbenchUpgradePlan;
          if (plan.kind !== "ready") throw new Error(plan.reason);
          return yield* resumeMarkedMigration(
            dbPath,
            marker!,
            Effect.fail(new Error("converted then interrupted")),
            {
              workbenchUpgradePlan: plan,
            },
          );
        }),
      );
      if (target === 111) {
        await expect(tryConversion).rejects.toThrow(
          version === 1
            ? "targets an older official schema"
            : "cannot be explained by this workbench build",
        );
        expect(await fs.readFile(migrationRecoveryMarkerPath(dbPath), "utf8")).toBe(markerText);
        expect(await backupPaths(dbPath)).toEqual([backup.backupPath]);
        expect(readFixture(dbPath)).toEqual(original);
        await Effect.runPromise(restoreMarkedMigrationBackup(dbPath));
        expect(readFixture(dbPath)).toEqual(original);
        const freshPlan = await runWithDatabase(dbPath, inspectWorkbenchUpgradePlan);
        expect(freshPlan).toMatchObject({
          kind: "ready",
          official: { targetVersion: 135 },
          requiresBackup: true,
        });
        await startNormally(dbPath);
        const completed = JSON.parse(
          await fs.readFile(migrationBackupProvenancePath(dbPath), "utf8"),
        );
        expect(completed).toMatchObject({
          version: 3,
          phase: "migration-completed",
          targetVersion: 135,
        });
        expect(completed.backupPath).not.toBe(backup.backupPath);
        expect(await backupPaths(dbPath)).toContain(backup.backupPath);
      } else {
        await expect(tryConversion).rejects.toThrow("converted then interrupted");
        const converted = await Effect.runPromise(inspectPendingMigrationRecovery(dbPath));
        expect(converted).toMatchObject({
          backupPath: backup.backupPath,
          resumeAttempts: 1,
          payload: {
            version: 3,
            targetVersion: 135,
            moduleVersions: {
              source: { expert: 0, context: 0 },
              target: { expert: 2, context: 1 },
            },
          },
        });
        expect(await backupPaths(dbPath)).toEqual([backup.backupPath]);
        expect(readFixture(dbPath)).toEqual(original);
        await runWithDatabase(dbPath, resumeMarkedMigration(dbPath, converted!, fullUpgrade));
        expect(await Effect.runPromise(inspectPendingMigrationRecovery(dbPath))).toBeNull();
        const completed = JSON.parse(
          await fs.readFile(migrationBackupProvenancePath(dbPath), "utf8"),
        );
        expect(completed).toMatchObject({
          version: 3,
          phase: "migration-completed",
          backupPath: backup.backupPath,
          resumeAttempts: 2,
          targetVersion: 135,
        });
        expect(await backupPaths(dbPath)).toEqual([backup.backupPath]);
        if (version === 1) {
          expect(inspectFile(dbPath).context).toEqual(
            (original as ReturnType<typeof inspectFile>).context,
          );
          expect(inspectFile(dbPath).deliveries).toEqual(
            (original as ReturnType<typeof inspectFile>).deliveries,
          );
        }
        await Effect.runPromise(restoreMarkedMigrationBackup(dbPath));
        expect(readFixture(dbPath)).toEqual(original);
      }
    });
  }
}

for (const afterOfficial of [false, true]) {
  it(`converts a v2 legacy Expert backup after adoption${afterOfficial ? " and official replay" : ""}, survives another restart and restores the original legacy rows`, async () => {
    const dbPath = await makeDbPath();
    const backup = await runWithDatabase(
      dbPath,
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 108 });
        yield* ExpertBindingMigration;
        yield* ExpertRuntimeMigration;
        yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES
        (109, 'ProjectionThreadsExpertBinding'), (110, 'ExpertAppliedRuntimeRecords')`;
        yield* sql`CREATE TABLE old_marker_probe(value TEXT NOT NULL)`;
        yield* sql`INSERT INTO old_marker_probe VALUES ('preserved legacy Expert v2')`;
        return yield* createMigrationBackup(dbPath, {
          sourceVersion: "v108-wb0-fmt0-legacy109-legacy110",
          targetVersion: 135,
        });
      }),
    );
    const original = inspectV2Fixture(dbPath);
    const originalLegacy = [
      { officialId: 109, officialName: "ProjectionThreadsExpertBinding", workbenchId: 1 },
      { officialId: 110, officialName: "ExpertAppliedRuntimeRecords", workbenchId: 2 },
    ];
    await runWithDatabase(
      dbPath,
      Effect.gen(function* () {
        yield* adoptLegacyExpertMigrations();
        if (afterOfficial) yield* runMigrations();
        const plan = yield* inspectWorkbenchUpgradePlan;
        expect(plan).toMatchObject({
          kind: "ready",
          format: { sourceVersion: 1 },
          workbench: { modules: { expert: { sourceVersion: 2 }, context: { sourceVersion: 0 } } },
          legacyMigrations: [],
        });
      }),
    );
    await fs.writeFile(
      migrationRecoveryMarkerPath(dbPath),
      `${JSON.stringify({
        version: 2,
        databasePath: dbPath,
        backupPath: backup.backupPath,
        sourceVersion: "v108-wb0-fmt0-legacy109-legacy110",
        targetVersion: 135,
        lineageDivergence: null,
        phase: "migration-in-progress",
        createdAt: backup.createdAt,
        resumeAttempts: 0,
        legacyExpertMigrations: originalLegacy,
        migrationVersions: {
          source: { official: 108, workbench: 0, format: 0 },
          target: { official: 135, workbench: 2, format: 1 },
        },
      })}\n`,
      { mode: 0o600 },
    );
    const marker = await Effect.runPromise(inspectPendingMigrationRecovery(dbPath));
    await expect(
      runWithDatabase(
        dbPath,
        Effect.gen(function* () {
          const plan = yield* inspectWorkbenchUpgradePlan;
          if (plan.kind !== "ready") throw new Error(plan.reason);
          yield* resumeMarkedMigration(
            dbPath,
            marker!,
            Effect.fail(new Error("converted legacy Expert then interrupted")),
            {
              workbenchUpgradePlan: plan,
            },
          );
        }),
      ),
    ).rejects.toThrow("converted legacy Expert then interrupted");
    const converted = await Effect.runPromise(inspectPendingMigrationRecovery(dbPath));
    expect(converted).toMatchObject({
      backupPath: backup.backupPath,
      resumeAttempts: 1,
      payload: {
        version: 3,
        legacyMigrations: originalLegacy.map(({ officialId, officialName, workbenchId }) => ({
          moduleId: "expert",
          officialId,
          officialName,
          workbenchId,
        })),
        legacyExpertMigrations: originalLegacy,
      },
    });
    expect(converted!.payload.legacyProgressMigrations).toEqual(
      converted!.payload.legacyMigrations,
    );
    expect(await backupPaths(dbPath)).toEqual([backup.backupPath]);
    expect(inspectV2Fixture(backup.backupPath)).toEqual(original);
    await runWithDatabase(dbPath, resumeMarkedMigration(dbPath, converted!, fullUpgrade));
    expect(await Effect.runPromise(inspectPendingMigrationRecovery(dbPath))).toBeNull();
    const completed = JSON.parse(await fs.readFile(migrationBackupProvenancePath(dbPath), "utf8"));
    expect(completed).toMatchObject({
      version: 3,
      phase: "migration-completed",
      backupPath: backup.backupPath,
      resumeAttempts: 2,
    });
    expect(await backupPaths(dbPath)).toEqual([backup.backupPath]);
    await Effect.runPromise(restoreMarkedMigrationBackup(dbPath));
    expect(inspectV2Fixture(dbPath)).toEqual(original);
    await runWithDatabase(
      dbPath,
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        expect(
          yield* sql`SELECT name FROM sqlite_master WHERE name IN ('workbench_sql_migrations', 'workbench_legacy_migration_adoptions')`,
        ).toEqual([]);
      }),
    );
  });

  it(`converts a v1 old111 backup after adoption${afterOfficial ? " and official replay" : ""} without losing its original recovery point`, async () => {
    const dbPath = await makeDbPath();
    const backup = await runWithDatabase(
      dbPath,
      Effect.gen(function* () {
        yield* seedOld111("legacy");
        return yield* createMigrationBackup(dbPath, { sourceVersion: "v111", targetVersion: 135 });
      }),
    );
    const original = inspectFile(dbPath);
    await runWithDatabase(
      dbPath,
      Effect.gen(function* () {
        yield* adoptLegacyExpertMigrations();
        if (afterOfficial) yield* runMigrations();
        const plan = yield* inspectWorkbenchUpgradePlan;
        expect(plan).toMatchObject({
          kind: "ready",
          format: { sourceVersion: 1 },
          workbench: { modules: { expert: { sourceVersion: 2 }, context: { sourceVersion: 1 } } },
          legacyMigrations: [],
        });
      }),
    );
    await fs.writeFile(
      migrationRecoveryMarkerPath(dbPath),
      `${JSON.stringify({
        version: 1,
        databasePath: dbPath,
        backupPath: backup.backupPath,
        sourceVersion: "v111",
        targetVersion: 135,
        lineageDivergence: null,
        phase: "migration-in-progress",
        createdAt: backup.createdAt,
        resumeAttempts: 0,
      })}\n`,
      { mode: 0o600 },
    );
    const marker = await Effect.runPromise(inspectPendingMigrationRecovery(dbPath));
    await expect(
      runWithDatabase(
        dbPath,
        Effect.gen(function* () {
          const plan = yield* inspectWorkbenchUpgradePlan;
          if (plan.kind !== "ready") throw new Error(plan.reason);
          yield* resumeMarkedMigration(
            dbPath,
            marker!,
            Effect.fail(new Error("converted old111 then interrupted")),
            {
              workbenchUpgradePlan: plan,
            },
          );
        }),
      ),
    ).rejects.toThrow("converted old111 then interrupted");
    const converted = await Effect.runPromise(inspectPendingMigrationRecovery(dbPath));
    expect(converted).toMatchObject({
      backupPath: backup.backupPath,
      resumeAttempts: 1,
      payload: {
        version: 3,
        migrationVersions: {
          source: { official: 108, workbench: 0, format: 0 },
          target: { official: 135, workbench: 2, format: 1 },
        },
        moduleVersions: { source: { expert: 0, context: 0 }, target: { expert: 2, context: 1 } },
      },
    });
    expect(converted!.payload.legacyProgressMigrations).toEqual(
      converted!.payload.legacyMigrations,
    );
    expect(await backupPaths(dbPath)).toEqual([backup.backupPath]);
    expect(inspectFile(backup.backupPath)).toEqual(original);
    await runWithDatabase(dbPath, resumeMarkedMigration(dbPath, converted!, fullUpgrade));
    expect(await Effect.runPromise(inspectPendingMigrationRecovery(dbPath))).toBeNull();
    const completed = JSON.parse(await fs.readFile(migrationBackupProvenancePath(dbPath), "utf8"));
    expect(completed).toMatchObject({
      version: 3,
      phase: "migration-completed",
      backupPath: backup.backupPath,
      resumeAttempts: 2,
    });
    expect(inspectFile(dbPath).context).toEqual(original.context);
    expect(inspectFile(dbPath).deliveries).toEqual(original.deliveries);
    await Effect.runPromise(restoreMarkedMigrationBackup(dbPath));
    expect(inspectFile(dbPath)).toEqual(original);
  });
}
