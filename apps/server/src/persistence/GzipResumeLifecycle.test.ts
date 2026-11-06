import { DatabaseSync } from "node:sqlite";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Fiber, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  migrationBackupDirectory,
  migrationRecoveryMarkerPath,
} from "@synara/shared/migrationRecovery";
import {
  DatabaseLifecycleLockedError,
  withDatabaseLifecycleLock,
} from "./DatabaseLifecycleLock.ts";
import { makeSqlitePersistenceLive } from "./Layers/Sqlite.ts";
import { runMigrations } from "./Migrations.ts";
import * as NodeSqliteClient from "./NodeSqliteClient.ts";
import { runWithPreMigrationBackup } from "./MigrationBackup.ts";
import { inspectWorkbenchUpgradePlan } from "../workbench/persistence/WorkbenchUpgradePlan.ts";

vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  return { ...actual, open: vi.fn(actual.open) };
});

const tempDirectories: Array<string> = [];

afterEach(async () => {
  await Promise.all(
    tempDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

async function makeDbPath(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "synara-gzip-resume-lifecycle-"));
  tempDirectories.push(directory);
  return path.join(directory, "state.sqlite");
}

const runWithDatabase = <A, E>(dbPath: string, effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  Effect.runPromise(effect.pipe(Effect.provide(NodeSqliteClient.layer({ filename: dbPath }))));

describe("gzip migration resume lifecycle", () => {
  it("holds the lifecycle lock through interrupted v3 backup inspection and cleanup", async () => {
    const dbPath = await makeDbPath();

    await expect(
      runWithDatabase(
        dbPath,
        Effect.gen(function* () {
          yield* runMigrations({ toMigrationInclusive: 135 });
          const upgradePlan = yield* inspectWorkbenchUpgradePlan;
          if (upgradePlan.kind !== "ready") throw new Error(upgradePlan.reason);
          yield* runWithPreMigrationBackup(
            dbPath,
            Effect.fail(new Error("leave a pending v3 migration recovery record")),
            { upgradePlan },
          );
        }),
      ),
    ).rejects.toThrow("leave a pending v3 migration recovery record");

    const markerPath = migrationRecoveryMarkerPath(dbPath);
    const markerBefore = await fs.readFile(markerPath, "utf8");
    const markerPayload = JSON.parse(markerBefore) as {
      readonly version: number;
      readonly phase: string;
      readonly backupPath: string;
      readonly resumeAttempts: number;
    };
    expect(markerPayload).toMatchObject({
      version: 3,
      phase: "migration-in-progress",
      resumeAttempts: 0,
    });
    expect(markerPayload.backupPath).toMatch(/\.sqlite\.gz$/u);
    expect((await fs.stat(markerPayload.backupPath)).isFile()).toBe(true);

    const enteredInspection = Promise.withResolvers<void>();
    const releaseInspection = Promise.withResolvers<void>();
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    const open = vi.mocked(fs.open);
    open.mockImplementation(async (...args) => {
      const handle = await actual.open(...args);
      const filePath = String(args[0]);
      if (filePath.endsWith(".partial") && filePath.includes(".sqlite.gz.")) {
        enteredInspection.resolve();
        await releaseInspection.promise;
      }
      return handle;
    });

    const startup = Effect.runFork(
      Layer.build(makeSqlitePersistenceLive(dbPath).pipe(Layer.provide(NodeServices.layer))).pipe(
        Effect.scoped,
      ),
    );
    try {
      await enteredInspection.promise;
      let interruptionSettled = false;
      const interruption = Effect.runPromise(Fiber.interrupt(startup));
      void interruption.then(
        () => {
          interruptionSettled = true;
        },
        () => {
          interruptionSettled = true;
        },
      );

      await new Promise<void>((resolve) => setTimeout(resolve, 50));
      expect(interruptionSettled).toBe(false);
      await expect(
        Effect.runPromise(withDatabaseLifecycleLock(dbPath, Effect.void)),
      ).rejects.toBeInstanceOf(DatabaseLifecycleLockedError);

      releaseInspection.resolve();
      await interruption;
      const startupExit = await Effect.runPromise(Fiber.await(startup));
      expect(startupExit._tag).toBe("Failure");
    } finally {
      releaseInspection.resolve();
      await Effect.runPromise(Fiber.interrupt(startup));
      open.mockImplementation(actual.open);
    }

    await expect(
      Effect.runPromise(withDatabaseLifecycleLock(dbPath, Effect.void)),
    ).resolves.toBeUndefined();
    const backupNames = await fs.readdir(migrationBackupDirectory(dbPath));
    expect(backupNames).toContain(path.basename(markerPayload.backupPath));
    expect(backupNames.filter((name) => name.endsWith(".partial"))).toEqual([]);
    expect(await fs.readFile(markerPath, "utf8")).toBe(markerBefore);

    const database = new DatabaseSync(dbPath, { readOnly: true });
    try {
      expect(
        database.prepare("SELECT MAX(migration_id) AS id FROM effect_sql_migrations").get(),
      ).toMatchObject({ id: 135 });
    } finally {
      database.close();
    }
  });
});
