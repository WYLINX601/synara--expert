import { DatabaseSync } from "node:sqlite";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { afterEach, expect, it } from "vitest";

import {
  inspectPendingMigrationRecovery,
  migrationRecoveryMarkerPath,
  restoreMarkedMigrationBackup,
  runWithPreMigrationBackup,
} from "../../persistence/MigrationBackup.ts";
import { runMigrations } from "../../persistence/Migrations.ts";
import ContextV1Migration from "../../persistence/Migrations/111_ContextV1.ts";
import * as NodeSqliteClient from "../../persistence/NodeSqliteClient.ts";
import { adoptLegacyExpertMigrations } from "./LegacyExpertMigrationAdoption.ts";
import { CONTEXT_SCHEMA_OBJECTS_QUERY, FROZEN_CONTEXT_TABLE_SQL } from "./FrozenContextSchema.ts";
import { inspectWorkbenchUpgradePlan } from "./WorkbenchUpgradePlan.ts";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});
const runWithDatabase = <A, E>(dbPath: string, effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  Effect.runPromise(effect.pipe(Effect.provide(NodeSqliteClient.layer({ filename: dbPath }))));

async function makeDbPath() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "synara-context-schema-"));
  directories.push(directory);
  const dbPath = path.join(directory, "state.sqlite");
  await runWithDatabase(
    dbPath,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 108 });
      yield* ContextV1Migration;
      yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (111, 'ContextV1')`;
      yield* sql`INSERT INTO context_spaces VALUES ('preserved', 'goal', 'instructions', 3, '2026-10-18')`;
    }),
  );
  return dbPath;
}

const damageCases = [
  {
    name: "singleton CHECK missing",
    table: "context_meta",
    from: " CHECK (singleton = 1)",
    to: "",
  },
  {
    name: "revision CHECK missing",
    table: "context_spaces",
    from: " CHECK (revision >= 0)",
    to: "",
  },
  {
    name: "status CHECK missing",
    table: "context_migrations",
    from: " CHECK (status IN ('pending', 'conflict', 'completed'))",
    to: "",
  },
  {
    name: "choice CHECK missing",
    table: "context_migrations",
    from: " CHECK (choice IS NULL OR choice IN ('keep_saved', 'use_legacy'))",
    to: "",
  },
  {
    name: "mode CHECK missing",
    table: "context_thread_bindings",
    from: " CHECK (mode IN ('legacy', 'unbound', 'bound'))",
    to: "",
  },
  {
    name: "mode CHECK changed",
    table: "context_thread_bindings",
    from: "'bound'",
    to: "'outside-frozen-enum'",
  },
  {
    name: "choice quoted NULL keyword",
    table: "context_migrations",
    from: "choice IS NULL",
    to: 'choice IS "NULL"',
  },
  {
    name: "choice NULL string literal",
    table: "context_migrations",
    from: "choice IS NULL",
    to: "choice IS 'NULL'",
  },
  {
    name: "choice TRUE keyword",
    table: "context_migrations",
    from: "choice IS NULL",
    to: "choice IS TRUE",
  },
  {
    name: "choice FALSE keyword",
    table: "context_migrations",
    from: "choice IS NULL",
    to: "choice IS FALSE",
  },
  {
    name: "choice quoted TRUE",
    table: "context_migrations",
    from: "choice IS NULL",
    to: 'choice IS "TRUE"',
  },
  {
    name: "choice quoted FALSE",
    table: "context_migrations",
    from: "choice IS NULL",
    to: 'choice IS "FALSE"',
  },
  {
    name: "mode quoted enum literals",
    table: "context_thread_bindings",
    from: "'legacy', 'unbound', 'bound'",
    to: '"legacy", "unbound", "bound"',
  },
  {
    name: "phase quoted NULL keyword",
    statement:
      "ALTER TABLE orchestration_event_deliveries DROP COLUMN context_phase; ALTER TABLE orchestration_event_deliveries ADD COLUMN context_phase TEXT CHECK (context_phase IS \"NULL\" OR context_phase IN ('before_dispatch', 'dispatch_started', 'acknowledged'))",
  },
  {
    name: "phase CHECK missing",
    statement:
      "ALTER TABLE orchestration_event_deliveries DROP COLUMN context_phase; ALTER TABLE orchestration_event_deliveries ADD COLUMN context_phase TEXT",
  },
  {
    name: "phase CHECK changed",
    statement:
      "ALTER TABLE orchestration_event_deliveries DROP COLUMN context_phase; ALTER TABLE orchestration_event_deliveries ADD COLUMN context_phase TEXT CHECK (context_phase IS NULL OR context_phase IN ('outside-frozen-enum'))",
  },
  {
    name: "unknown Context trigger",
    statement:
      "CREATE TRIGGER foreign_context_guard AFTER INSERT ON context_thread_bindings BEGIN SELECT 1; END",
  },
  {
    name: "unknown delivery trigger",
    statement:
      "CREATE TRIGGER foreign_delivery_guard AFTER INSERT ON orchestration_event_deliveries BEGIN SELECT 1; END",
  },
  {
    name: "unknown Context index",
    statement: "CREATE INDEX foreign_context_index ON context_thread_bindings(mode)",
  },
  {
    name: "unknown delivery index",
    statement:
      "CREATE INDEX foreign_delivery_index ON orchestration_event_deliveries(context_phase)",
  },
] as const;

function damage(dbPath: string, fixture: (typeof damageCases)[number]) {
  // Match the application's Bun SQLite DQS compatibility when constructing
  // adversarial metadata. Production inspection still uses its normal reader.
  const db = new DatabaseSync(dbPath, { enableDoubleQuotedStringLiterals: true });
  try {
    if ("statement" in fixture) {
      db.exec(fixture.statement);
      return;
    }
    const original = FROZEN_CONTEXT_TABLE_SQL[fixture.table]!;
    const changed = original.replace(fixture.from, fixture.to);
    expect(changed).not.toBe(original);
    // Rebuild only this test fixture and preserve its existing rows.
    const columns = db
      .prepare(`PRAGMA table_info(${fixture.table})`)
      .all()
      .map((row) => String(row.name));
    db.exec(`CREATE TEMP TABLE saved_rows AS SELECT * FROM ${fixture.table}`);
    db.exec(`DROP TABLE ${fixture.table}`);
    db.exec(changed);
    db.exec(`INSERT INTO ${fixture.table} (${columns.join(",")}) SELECT * FROM saved_rows`);
  } finally {
    db.close();
  }
}

function inspect(dbPath: string) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return {
      schema: db.prepare(CONTEXT_SCHEMA_OBJECTS_QUERY).all(),
      history: db.prepare("SELECT * FROM effect_sql_migrations ORDER BY migration_id").all(),
      spaces: db.prepare("SELECT * FROM context_spaces").all(),
      certification: db
        .prepare(
          "SELECT name FROM sqlite_master WHERE name IN ('workbench_sql_migrations', 'workbench_legacy_migration_adoptions')",
        )
        .all(),
    };
  } finally {
    db.close();
  }
}

for (const fixture of damageCases) {
  it(`rejects live ${fixture.name} without auditing or deleting old111`, async () => {
    const dbPath = await makeDbPath();
    damage(dbPath, fixture);
    const before = inspect(dbPath);
    await runWithDatabase(
      dbPath,
      Effect.gen(function* () {
        const plan = yield* inspectWorkbenchUpgradePlan;
        expect(plan.kind).toBe("rejected");
        if (plan.kind === "rejected") expect(plan.reason).toMatch(/frozen|protected Context/);
        const failure = yield* Effect.flip(adoptLegacyExpertMigrations());
        expect(failure.message).toMatch(/frozen|protected Context/);
      }),
    );
    expect(inspect(dbPath)).toEqual(before);
    expect(before.certification).toEqual([]);
    await expect(fs.stat(migrationRecoveryMarkerPath(dbPath))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it(`rejects backup ${fixture.name} before restore and preserves the source and marker`, async () => {
    const dbPath = await makeDbPath();
    await expect(
      runWithDatabase(
        dbPath,
        Effect.gen(function* () {
          const plan = yield* inspectWorkbenchUpgradePlan;
          if (plan.kind !== "ready") throw new Error(plan.reason);
          yield* runWithPreMigrationBackup(
            dbPath,
            Effect.fail(new Error("leave original recovery point")),
            { upgradePlan: plan },
          );
        }),
      ),
    ).rejects.toThrow("leave original recovery point");
    const marker = await Effect.runPromise(inspectPendingMigrationRecovery(dbPath));
    expect(marker).not.toBeNull();
    const before = inspect(dbPath);
    const markerBytes = await fs.readFile(marker!.markerPath, "utf8");
    damage(marker!.backupPath, fixture);
    const backupBefore = inspect(marker!.backupPath);
    await expect(Effect.runPromise(restoreMarkedMigrationBackup(dbPath))).rejects.toThrow(
      /unrecognized migration lineage/,
    );
    expect(inspect(dbPath)).toEqual(before);
    expect(inspect(marker!.backupPath)).toEqual(backupBefore);
    expect(await fs.readFile(marker!.markerPath, "utf8")).toBe(markerBytes);
    expect(before.certification).toEqual([]);
    expect(backupBefore.certification).toEqual([]);
  });
}
