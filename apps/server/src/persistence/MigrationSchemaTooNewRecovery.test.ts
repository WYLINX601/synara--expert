import { DatabaseSync } from "node:sqlite";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { gzipSync } from "node:zlib";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Fiber, Layer } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  MIGRATION_RECOVERY_MAX_RESUME_ATTEMPTS,
  migrationBackupDirectory,
  migrationBackupProvenancePath,
  migrationRecoveryMarkerPath,
  parseMigrationSchemaTooNewStartupBlock,
} from "@synara/shared/migrationRecovery";

import {
  inspectCompletedMigrationBackupForSchemaTooNew,
  reclaimOrphanedMigrationArtifacts,
  restoreMarkedMigrationBackup,
} from "./MigrationBackup.ts";
import {
  DatabaseLifecycleLockedError,
  withDatabaseLifecycleLock,
} from "./DatabaseLifecycleLock.ts";
import { MigrationSchemaTooNewError } from "./Errors.ts";
import { makeSqlitePersistenceLive } from "./Layers/Sqlite.ts";
import * as NodeSqliteClient from "./NodeSqliteClient.ts";
import {
  MigrationSchemaTooNewStartupBlockError,
  createMigrationSchemaTooNewStartupBlockError,
} from "./MigrationSchemaTooNewStartupBlock.ts";
import { LATEST_MIGRATION_ID, migrationEntries, runMigrations } from "./Migrations.ts";
import { runWorkbenchMigrations } from "../workbench/persistence/WorkbenchMigrations.ts";
import { inspectWorkbenchUpgradePlan } from "../workbench/persistence/WorkbenchUpgradePlan.ts";

vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  return { ...actual, open: vi.fn(actual.open) };
});

const tempDirectories: Array<string> = [];

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true })),
  );
});

async function makeDatabasePath(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "synara-schema-too-new-"));
  tempDirectories.push(directory);
  return path.join(directory, "state.sqlite");
}

function writeTrackedDatabase(databasePath: string, migrationId: number): void {
  const database = new DatabaseSync(databasePath);
  try {
    database.exec(
      "CREATE TABLE effect_sql_migrations (migration_id INTEGER NOT NULL PRIMARY KEY, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, name VARCHAR(255) NOT NULL); CREATE TABLE projection_threads (thread_id TEXT NOT NULL)",
    );
    const insert = database.prepare(
      "INSERT INTO effect_sql_migrations (migration_id, name) VALUES (?, ?)",
    );
    let latestWrittenMigrationId = 0;
    for (const [knownMigrationId, name] of migrationEntries) {
      if (knownMigrationId > migrationId) break;
      insert.run(knownMigrationId, name);
      latestWrittenMigrationId = knownMigrationId;
    }
    for (
      let futureMigrationId = latestWrittenMigrationId + 1;
      futureMigrationId <= migrationId;
      futureMigrationId += 1
    ) {
      insert.run(futureMigrationId, `FutureMigration${futureMigrationId}`);
    }
  } finally {
    database.close();
  }
}

function writeImportedTrackedDatabase(databasePath: string, migrationId: number): void {
  const database = new DatabaseSync(databasePath);
  try {
    database.exec(
      "CREATE TABLE effect_sql_migrations (migration_id INTEGER NOT NULL PRIMARY KEY, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, name VARCHAR(255) NOT NULL); CREATE TABLE projection_threads (thread_id TEXT NOT NULL)",
    );
    const insert = database.prepare(
      "INSERT INTO effect_sql_migrations (migration_id, name) VALUES (?, ?)",
    );
    for (const [knownMigrationId, name] of migrationEntries) {
      if (knownMigrationId > 16) break;
      insert.run(knownMigrationId, name);
    }
    for (
      let importedMigrationId = 17;
      importedMigrationId <= migrationId;
      importedMigrationId += 1
    ) {
      insert.run(importedMigrationId, `ImportedMigration${importedMigrationId}`);
    }
  } finally {
    database.close();
  }
}

function writeFutureCanonicalDatabase(databasePath: string): number {
  const database = new DatabaseSync(databasePath);
  const latestMigrationId = Math.max(...migrationEntries.map(([migrationId]) => migrationId));
  try {
    database.exec(
      "CREATE TABLE effect_sql_migrations (migration_id INTEGER NOT NULL PRIMARY KEY, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, name VARCHAR(255) NOT NULL); CREATE TABLE projection_threads (thread_id TEXT NOT NULL)",
    );
    const insert = database.prepare(
      "INSERT INTO effect_sql_migrations (migration_id, name) VALUES (?, ?)",
    );
    for (const [migrationId, name] of migrationEntries) insert.run(migrationId, name);
    insert.run(latestMigrationId + 1, "FutureMigration");
  } finally {
    database.close();
  }
  return latestMigrationId;
}

function previousSupportedMigrationId(latestMigrationId: number): number {
  const previous = migrationEntries
    .map(([migrationId]) => migrationId)
    .filter((migrationId) => migrationId < latestMigrationId)
    .at(-1);
  if (previous === undefined) throw new Error("Expected a previous supported migration");
  return previous;
}

async function seedDatabaseThrough(
  databasePath: string,
  targetVersion: number,
  withWorkbench = false,
) {
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: targetVersion });
      if (withWorkbench) yield* runWorkbenchMigrations();
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: databasePath }))),
  );
}

const inspectUpgradePlan = (databasePath: string) =>
  Effect.runPromise(
    inspectWorkbenchUpgradePlan.pipe(
      Effect.provide(NodeSqliteClient.layer({ filename: databasePath })),
    ),
  );

async function writeCurrentCompletedProvenance(input: {
  readonly databasePath: string;
  readonly backupPath: string;
  readonly sourcePlan: Awaited<ReturnType<typeof inspectUpgradePlan>>;
}): Promise<void> {
  const source = input.sourcePlan;
  const target = await inspectUpgradePlan(input.databasePath);
  if (source.kind !== "ready" || target.kind !== "ready") {
    throw new Error("Expected migration provenance fixtures to have recognized upgrade plans");
  }
  const legacySuffix = source.legacyMigrations
    .map(({ officialId }) => `-legacy${officialId}`)
    .join("");
  const sourceVersion = source.lineageDivergence
    ? source.official.sourceLabel
    : `${source.official.sourceLabel}-wb${source.workbench.sourceVersion}` +
      `-fmt${source.format.sourceVersion}${legacySuffix}`;
  const payload = {
    version: 3,
    databasePath: input.databasePath,
    backupPath: input.backupPath,
    sourceVersion,
    targetVersion: target.official.targetVersion,
    lineageDivergence: source.lineageDivergence ?? null,
    phase: "migration-completed",
    createdAt: "2026-08-30T12:00:00.000Z",
    completedAt: "2026-08-30T12:01:00.000Z",
    resumeAttempts: 0,
    migrationVersions: {
      source: {
        official: source.official.sourceVersion,
        workbench: source.workbench.sourceVersion,
        format: source.format.sourceVersion,
      },
      target: {
        official: target.official.targetVersion,
        workbench: target.workbench.targetVersion,
        format: target.format.targetVersion,
      },
    },
    moduleVersions: {
      source: {
        expert: source.workbench.modules.expert.sourceVersion,
        context: source.workbench.modules.context.sourceVersion,
      },
      target: {
        expert: target.workbench.modules.expert.targetVersion,
        context: target.workbench.modules.context.targetVersion,
      },
    },
    legacyMigrations: source.legacyMigrations,
    legacyProgressMigrations: source.legacyMigrations,
    legacyExpertMigrations: source.legacyOfficialMigrations,
  };
  await fs.writeFile(
    migrationBackupProvenancePath(input.databasePath),
    `${JSON.stringify(payload)}\n`,
    { mode: 0o600 },
  );
}

function generatedBackupPath(databasePath: string, suffix: string, targetVersion: number): string {
  return path.join(
    migrationBackupDirectory(databasePath),
    `${path.basename(databasePath)}.pre-migration-v1-to-v${targetVersion}-20260830T120000000Z-${suffix}.sqlite`,
  );
}

async function compressBackupFixture(backupPath: string): Promise<string> {
  const compressedPath = `${backupPath}.gz`;
  await fs.writeFile(compressedPath, gzipSync(await fs.readFile(backupPath), { level: 1 }), {
    flag: "wx",
    mode: 0o600,
  });
  await fs.unlink(backupPath);
  return compressedPath;
}

async function writeCompletedProvenance(input: {
  readonly databasePath: string;
  readonly backupPath: string;
  readonly targetVersion: number;
}): Promise<void> {
  await fs.writeFile(
    migrationBackupProvenancePath(input.databasePath),
    `${JSON.stringify({
      version: 1,
      databasePath: input.databasePath,
      backupPath: input.backupPath,
      sourceVersion: "v1",
      targetVersion: input.targetVersion,
      phase: "migration-completed",
      createdAt: "2026-08-30T12:00:00.000Z",
      completedAt: "2026-08-30T12:01:00.000Z",
      resumeAttempts: 0,
    })}\n`,
  );
}

async function writeActiveRecoveryMarker(input: {
  readonly databasePath: string;
  readonly backupPath: string;
  readonly targetVersion: number;
  readonly phase?: string;
}): Promise<void> {
  await fs.writeFile(
    migrationRecoveryMarkerPath(input.databasePath),
    `${JSON.stringify({
      version: 1,
      databasePath: input.databasePath,
      backupPath: input.backupPath,
      sourceVersion: "v1",
      targetVersion: input.targetVersion,
      phase: input.phase ?? "migration-in-progress",
      createdAt: "2026-08-30T12:02:00.000Z",
      resumeAttempts: MIGRATION_RECOVERY_MAX_RESUME_ATTEMPTS,
    })}\n`,
  );
}

const firstUuid = "00000000-0000-4000-8000-000000000001";
const secondUuid = "00000000-0000-4000-8000-000000000002";

describe("completed migration backup recovery", () => {
  it("inspects and restores the exact compressed backup, reclaiming inspection partials", async () => {
    const databasePath = await makeDatabasePath();
    const latestMigrationId = LATEST_MIGRATION_ID;
    const previouslySupportedMigrationId = previousSupportedMigrationId(latestMigrationId);
    await seedDatabaseThrough(databasePath, latestMigrationId, true);
    const targetVersion = latestMigrationId;
    const directory = migrationBackupDirectory(databasePath);
    await fs.mkdir(directory);
    const plainPath = generatedBackupPath(databasePath, firstUuid, targetVersion);
    await seedDatabaseThrough(plainPath, previouslySupportedMigrationId);
    const sourcePlan = await inspectUpgradePlan(plainPath);
    const backupPath = await compressBackupFixture(plainPath);
    const unrelatedPath = generatedBackupPath(databasePath, secondUuid, targetVersion + 1);
    writeTrackedDatabase(unrelatedPath, targetVersion + 1);
    await writeCurrentCompletedProvenance({ databasePath, backupPath, sourcePlan });
    await fs.writeFile(
      path.join(directory, `.${path.basename(backupPath)}.crashed.partial`),
      "partial",
    );

    await Effect.runPromise(reclaimOrphanedMigrationArtifacts(databasePath));
    await expect(
      inspectCompletedMigrationBackupForSchemaTooNew(databasePath, {
        databaseMigrationId: latestMigrationId,
        latestSupportedMigrationId: previouslySupportedMigrationId,
      }),
    ).resolves.toMatchObject({
      kind: "restore-available",
      backupPath,
      backupMigrationId: previouslySupportedMigrationId,
    });
    expect((await fs.readdir(directory)).sort()).toEqual(
      [path.basename(backupPath), path.basename(unrelatedPath)].sort(),
    );

    await Effect.runPromise(
      restoreMarkedMigrationBackup(databasePath, {
        expectedBackupPath: backupPath,
        expectedProvenancePath: migrationBackupProvenancePath(databasePath),
      }),
    );
    const restored = new DatabaseSync(databasePath, { readOnly: true });
    try {
      expect(
        restored.prepare("SELECT MAX(migration_id) AS id FROM effect_sql_migrations").get(),
      ).toMatchObject({ id: previouslySupportedMigrationId });
    } finally {
      restored.close();
    }
  });

  it.each(["truncated", "checksum", "invalid-sqlite"])(
    "rejects %s gzip backups without changing the live database or recovery records",
    async (damage) => {
      const databasePath = await makeDatabasePath();
      const latestMigrationId = LATEST_MIGRATION_ID;
      const previouslySupportedMigrationId = previousSupportedMigrationId(latestMigrationId);
      await seedDatabaseThrough(databasePath, latestMigrationId, true);
      const targetVersion = latestMigrationId;
      const directory = migrationBackupDirectory(databasePath);
      await fs.mkdir(directory);
      const plainPath = generatedBackupPath(databasePath, firstUuid, targetVersion);
      await seedDatabaseThrough(plainPath, previouslySupportedMigrationId);
      const sourcePlan = await inspectUpgradePlan(plainPath);
      const backupPath = await compressBackupFixture(plainPath);
      const encoded = await fs.readFile(backupPath);
      if (damage === "checksum") encoded[encoded.length - 8]! ^= 1;
      await fs.writeFile(
        backupPath,
        damage === "truncated"
          ? encoded.subarray(0, -3)
          : damage === "invalid-sqlite"
            ? gzipSync("not sqlite")
            : encoded,
      );
      await writeCurrentCompletedProvenance({ databasePath, backupPath, sourcePlan });
      await writeActiveRecoveryMarker({ databasePath, backupPath, targetVersion });
      const protectedPaths = [
        databasePath,
        migrationBackupProvenancePath(databasePath),
        migrationRecoveryMarkerPath(databasePath),
      ];
      const before = await Promise.all(protectedPaths.map((filePath) => fs.readFile(filePath)));

      await expect(
        inspectCompletedMigrationBackupForSchemaTooNew(databasePath, {
          databaseMigrationId: latestMigrationId,
          latestSupportedMigrationId: previouslySupportedMigrationId,
        }),
      ).resolves.toEqual({ kind: "restore-unavailable", reason: "invalid-backup" });
      await expect(Effect.runPromise(restoreMarkedMigrationBackup(databasePath))).rejects.toThrow();

      expect(await Promise.all(protectedPaths.map((filePath) => fs.readFile(filePath)))).toEqual(
        before,
      );
      expect(await fs.readdir(directory)).toEqual([path.basename(backupPath)]);
      expect(
        (await fs.readdir(path.dirname(databasePath))).filter((name) => name.endsWith(".restore")),
      ).toEqual([]);
    },
  );

  it("fails closed when completed provenance claims an unknown future official target", async () => {
    const databasePath = await makeDatabasePath();
    const latestMigrationId = writeFutureCanonicalDatabase(databasePath);
    const futureMigrationId = latestMigrationId + 1;
    const directory = migrationBackupDirectory(databasePath);
    await fs.mkdir(directory);
    const plainPath = generatedBackupPath(databasePath, firstUuid, futureMigrationId);
    writeTrackedDatabase(plainPath, latestMigrationId);
    const backupPath = await compressBackupFixture(plainPath);
    await writeCompletedProvenance({ databasePath, backupPath, targetVersion: futureMigrationId });

    await expect(
      inspectCompletedMigrationBackupForSchemaTooNew(databasePath, {
        databaseMigrationId: futureMigrationId,
        latestSupportedMigrationId: latestMigrationId,
      }),
    ).resolves.toEqual({ kind: "restore-unavailable", reason: "invalid-provenance" });
  });

  it("holds the lifecycle lock through interrupted compressed too-new startup inspection and cleanup", async () => {
    const databasePath = await makeDatabasePath();
    const latestMigrationId = LATEST_MIGRATION_ID;
    const previouslySupportedMigrationId = previousSupportedMigrationId(latestMigrationId);
    await seedDatabaseThrough(databasePath, latestMigrationId, true);
    const targetVersion = latestMigrationId;
    const directory = migrationBackupDirectory(databasePath);
    await fs.mkdir(directory);
    const plainPath = generatedBackupPath(databasePath, firstUuid, targetVersion);
    await seedDatabaseThrough(plainPath, previouslySupportedMigrationId);
    const sourcePlan = await inspectUpgradePlan(plainPath);
    const backupPath = await compressBackupFixture(plainPath);
    await writeCurrentCompletedProvenance({ databasePath, backupPath, sourcePlan });
    const database = new DatabaseSync(databasePath);
    try {
      database
        .prepare("INSERT INTO effect_sql_migrations (migration_id, name) VALUES (?, ?)")
        .run(latestMigrationId + 1, `FutureMigration${latestMigrationId + 1}`);
    } finally {
      database.close();
    }
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    const open = vi.mocked(fs.open);
    open.mockImplementation(async (...args) => {
      const handle = await actual.open(...args);
      if (String(args[0]).endsWith(".partial") && String(args[0]).includes(".sqlite.gz.")) {
        entered.resolve();
        await release.promise;
      }
      return handle;
    });
    const startup = Effect.runFork(
      Layer.build(
        makeSqlitePersistenceLive(databasePath).pipe(Layer.provide(NodeServices.layer)),
      ).pipe(Effect.scoped),
    );
    try {
      await entered.promise;
      let interrupted = false;
      const interruption = Effect.runPromise(Fiber.interrupt(startup)).then(() => {
        interrupted = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(interrupted).toBe(false);
      await expect(
        Effect.runPromise(withDatabaseLifecycleLock(databasePath, Effect.void)),
      ).rejects.toBeInstanceOf(DatabaseLifecycleLockedError);
      release.resolve();
      await interruption;
      expect((await Effect.runPromise(Fiber.await(startup)))._tag).toBe("Failure");
    } finally {
      release.resolve();
      await Effect.runPromise(Fiber.interrupt(startup));
      open.mockImplementation(actual.open);
    }
    expect(await fs.readdir(directory)).toEqual([path.basename(backupPath)]);
    await expect(fs.stat(`${databasePath}.lifecycle-lock`)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("emits a structured block from the real persistence startup path", async () => {
    const databasePath = await makeDatabasePath();
    const latestMigrationId = writeFutureCanonicalDatabase(databasePath);
    let startupError: unknown;

    try {
      await Effect.runPromise(
        Layer.build(
          makeSqlitePersistenceLive(databasePath).pipe(Layer.provide(NodeServices.layer)),
        ).pipe(Effect.scoped),
      );
    } catch (cause) {
      startupError = cause;
    }

    expect(startupError).toBeInstanceOf(MigrationSchemaTooNewStartupBlockError);
    expect(parseMigrationSchemaTooNewStartupBlock((startupError as Error).message)).toEqual({
      version: 1,
      databasePath,
      databaseMigrationId: latestMigrationId + 1,
      latestSupportedMigrationId: latestMigrationId,
      recovery: { kind: "restore-unavailable", reason: "missing-provenance" },
    });
  });

  it("uses completed provenance when the successful migration removed its marker", async () => {
    const databasePath = await makeDatabasePath();
    writeTrackedDatabase(databasePath, 97);
    await fs.mkdir(migrationBackupDirectory(databasePath));
    const backupPath = generatedBackupPath(databasePath, firstUuid, 97);
    writeTrackedDatabase(backupPath, 90);
    await writeCompletedProvenance({ databasePath, backupPath, targetVersion: 97 });

    await expect(fs.stat(migrationRecoveryMarkerPath(databasePath))).rejects.toMatchObject({
      code: "ENOENT",
    });
    const recovery = await inspectCompletedMigrationBackupForSchemaTooNew(databasePath, {
      databaseMigrationId: 97,
      latestSupportedMigrationId: 96,
    });
    expect(recovery).toEqual({
      kind: "restore-available",
      backupPath,
      provenancePath: migrationBackupProvenancePath(databasePath),
      backupMigrationId: 90,
      backupWorkbenchMigrationId: 0,
      backupWorkbenchFormatVersion: 0,
    });

    const startupError = await createMigrationSchemaTooNewStartupBlockError(
      databasePath,
      new MigrationSchemaTooNewError({
        databaseMigrationId: 97,
        latestSupportedMigrationId: 96,
      }),
    );
    expect(parseMigrationSchemaTooNewStartupBlock(startupError.message)).toMatchObject({
      databasePath,
      databaseMigrationId: 97,
      latestSupportedMigrationId: 96,
      recovery,
    });
  });

  it("ignores newer-looking files and selects only the provenance-bound backup", async () => {
    const databasePath = await makeDatabasePath();
    writeTrackedDatabase(databasePath, 97);
    await fs.mkdir(migrationBackupDirectory(databasePath));
    const exactBackupPath = generatedBackupPath(databasePath, firstUuid, 97);
    const unrelatedBackupPath = generatedBackupPath(databasePath, secondUuid, 99);
    writeTrackedDatabase(exactBackupPath, 90);
    writeTrackedDatabase(unrelatedBackupPath, 99);
    await writeCompletedProvenance({
      databasePath,
      backupPath: exactBackupPath,
      targetVersion: 97,
    });

    await expect(
      inspectCompletedMigrationBackupForSchemaTooNew(databasePath, {
        databaseMigrationId: 97,
        latestSupportedMigrationId: 96,
      }),
    ).resolves.toMatchObject({ kind: "restore-available", backupPath: exactBackupPath });
  });

  it("withholds restore when the exact backup is newer than this build", async () => {
    const databasePath = await makeDatabasePath();
    writeTrackedDatabase(databasePath, 98);
    await fs.mkdir(migrationBackupDirectory(databasePath));
    const backupPath = generatedBackupPath(databasePath, firstUuid, 97);
    writeTrackedDatabase(backupPath, 97);
    await writeCompletedProvenance({ databasePath, backupPath, targetVersion: 98 });

    await expect(
      inspectCompletedMigrationBackupForSchemaTooNew(databasePath, {
        databaseMigrationId: 98,
        latestSupportedMigrationId: 96,
      }),
    ).resolves.toEqual({ kind: "restore-unavailable", reason: "incompatible-backup" });
  });

  it("rejects v1 provenance for an imported lineage outside the frozen legacy histories", async () => {
    const databasePath = await makeDatabasePath();
    const latestMigrationId = Math.max(...migrationEntries.map(([migrationId]) => migrationId));
    const databaseMigrationId = 110;
    writeImportedTrackedDatabase(databasePath, latestMigrationId);
    await fs.mkdir(migrationBackupDirectory(databasePath));
    const backupPath = generatedBackupPath(databasePath, firstUuid, databaseMigrationId);
    writeImportedTrackedDatabase(backupPath, latestMigrationId);
    await writeCompletedProvenance({
      databasePath,
      backupPath,
      targetVersion: databaseMigrationId,
    });

    await expect(
      inspectCompletedMigrationBackupForSchemaTooNew(databasePath, {
        databaseMigrationId,
        latestSupportedMigrationId: latestMigrationId,
      }),
    ).resolves.toEqual({ kind: "restore-unavailable", reason: "invalid-provenance" });
  });

  it("withholds restore when the exact backup has an incompatible shared lineage", async () => {
    const databasePath = await makeDatabasePath();
    writeTrackedDatabase(databasePath, 97);
    await fs.mkdir(migrationBackupDirectory(databasePath));
    const backupPath = generatedBackupPath(databasePath, firstUuid, 97);
    writeTrackedDatabase(backupPath, 90);
    const backup = new DatabaseSync(backupPath);
    try {
      backup
        .prepare("UPDATE effect_sql_migrations SET name = ? WHERE migration_id = ?")
        .run("UnknownSharedMigration", migrationEntries[0]![0]);
    } finally {
      backup.close();
    }
    await writeCompletedProvenance({ databasePath, backupPath, targetVersion: 97 });

    await expect(
      inspectCompletedMigrationBackupForSchemaTooNew(databasePath, {
        databaseMigrationId: 97,
        latestSupportedMigrationId: 96,
      }),
    ).resolves.toEqual({ kind: "restore-unavailable", reason: "incompatible-backup" });
  });

  it("withholds restore when the provenance is missing or its exact backup is corrupt", async () => {
    const databasePath = await makeDatabasePath();

    await expect(
      inspectCompletedMigrationBackupForSchemaTooNew(databasePath, {
        databaseMigrationId: 97,
        latestSupportedMigrationId: 96,
      }),
    ).resolves.toEqual({ kind: "restore-unavailable", reason: "missing-provenance" });

    await fs.mkdir(migrationBackupDirectory(databasePath));
    const backupPath = generatedBackupPath(databasePath, firstUuid, 97);
    await fs.writeFile(backupPath, "not sqlite");
    await writeCompletedProvenance({ databasePath, backupPath, targetVersion: 97 });

    await expect(
      inspectCompletedMigrationBackupForSchemaTooNew(databasePath, {
        databaseMigrationId: 97,
        latestSupportedMigrationId: 96,
      }),
    ).resolves.toEqual({ kind: "restore-unavailable", reason: "invalid-backup" });
  });

  it("rejects an unrecognized v1 future target before restore mutates the live database", async () => {
    const databasePath = await makeDatabasePath();
    const latestMigrationId = Math.max(...migrationEntries.map(([migrationId]) => migrationId));
    const newerMigrationId = latestMigrationId + 1;
    writeTrackedDatabase(databasePath, newerMigrationId);
    await fs.mkdir(migrationBackupDirectory(databasePath));
    const backupPath = generatedBackupPath(databasePath, firstUuid, newerMigrationId);
    writeTrackedDatabase(backupPath, newerMigrationId);
    await writeCompletedProvenance({
      databasePath,
      backupPath,
      targetVersion: newerMigrationId,
    });

    await expect(Effect.runPromise(restoreMarkedMigrationBackup(databasePath))).rejects.toThrow(
      "Invalid migration backup provenance version identity",
    );
    const liveDatabase = new DatabaseSync(databasePath, { readOnly: true });
    try {
      expect(
        liveDatabase
          .prepare("SELECT MAX(migration_id) AS migrationId FROM effect_sql_migrations")
          .get(),
      ).toMatchObject({ migrationId: newerMigrationId });
    } finally {
      liveDatabase.close();
    }
  });

  it("restores the explicitly selected completed backup instead of a leftover active marker", async () => {
    const databasePath = await makeDatabasePath();
    // V1 provenance is a frozen legacy format. Current (Context-era) upgrades
    // write V2 records, covered by MigrationBackup.test.ts.
    const latestMigrationId = 108;
    const databaseMigrationId = latestMigrationId;
    const selectedBackupMigrationId = Math.max(latestMigrationId - 5, 0);
    writeTrackedDatabase(databasePath, databaseMigrationId);
    await fs.mkdir(migrationBackupDirectory(databasePath));
    const selectedBackupPath = generatedBackupPath(databasePath, firstUuid, databaseMigrationId);
    const activeBackupPath = generatedBackupPath(databasePath, secondUuid, databaseMigrationId);
    writeTrackedDatabase(selectedBackupPath, selectedBackupMigrationId);
    writeTrackedDatabase(activeBackupPath, latestMigrationId);
    await writeCompletedProvenance({
      databasePath,
      backupPath: selectedBackupPath,
      targetVersion: databaseMigrationId,
    });
    await writeActiveRecoveryMarker({
      databasePath,
      backupPath: activeBackupPath,
      targetVersion: databaseMigrationId,
    });

    await Effect.runPromise(
      restoreMarkedMigrationBackup(databasePath, {
        expectedBackupPath: selectedBackupPath,
        expectedProvenancePath: migrationBackupProvenancePath(databasePath),
      }),
    );

    const restored = new DatabaseSync(databasePath, { readOnly: true });
    try {
      expect(
        restored
          .prepare("SELECT MAX(migration_id) AS migrationId FROM effect_sql_migrations")
          .get(),
      ).toMatchObject({ migrationId: selectedBackupMigrationId });
    } finally {
      restored.close();
    }
    await expect(fs.stat(migrationRecoveryMarkerPath(databasePath))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(
      fs.readFile(migrationBackupProvenancePath(databasePath), "utf8").then(JSON.parse),
    ).resolves.toMatchObject({
      backupPath: selectedBackupPath,
      phase: "migration-restored",
    });
  });

  it("keeps the live database usable when completed-provenance validation fails", async () => {
    const databasePath = await makeDatabasePath();
    const latestMigrationId = Math.max(...migrationEntries.map(([migrationId]) => migrationId));
    const databaseMigrationId = latestMigrationId + 1;
    writeTrackedDatabase(databasePath, databaseMigrationId);
    await fs.mkdir(migrationBackupDirectory(databasePath));
    const backupPath = generatedBackupPath(databasePath, firstUuid, databaseMigrationId);
    await fs.writeFile(backupPath, "not sqlite");
    await writeCompletedProvenance({
      databasePath,
      backupPath,
      targetVersion: databaseMigrationId,
    });

    await expect(
      Effect.runPromise(
        restoreMarkedMigrationBackup(databasePath, {
          expectedBackupPath: backupPath,
          expectedProvenancePath: migrationBackupProvenancePath(databasePath),
        }),
      ),
    ).rejects.toThrow();

    await expect(fs.stat(migrationRecoveryMarkerPath(databasePath))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(
      fs.readFile(migrationBackupProvenancePath(databasePath), "utf8").then(JSON.parse),
    ).resolves.toMatchObject({
      backupPath,
      phase: "migration-completed",
    });
    const live = new DatabaseSync(databasePath, { readOnly: true });
    try {
      expect(
        live.prepare("SELECT MAX(migration_id) AS migrationId FROM effect_sql_migrations").get(),
      ).toMatchObject({ migrationId: databaseMigrationId });
    } finally {
      live.close();
    }
  });

  it("recovers an exact restore after a crash strands the live database mid-swap", async () => {
    const databasePath = await makeDatabasePath();
    const latestMigrationId = 108;
    const databaseMigrationId = latestMigrationId;
    const backupMigrationId = Math.max(latestMigrationId - 5, 0);
    writeTrackedDatabase(databasePath, databaseMigrationId);
    await fs.mkdir(migrationBackupDirectory(databasePath));
    const backupPath = generatedBackupPath(databasePath, firstUuid, databaseMigrationId);
    writeTrackedDatabase(backupPath, backupMigrationId);
    await writeCompletedProvenance({
      databasePath,
      backupPath,
      targetVersion: databaseMigrationId,
    });
    await writeActiveRecoveryMarker({
      databasePath,
      backupPath,
      targetVersion: databaseMigrationId,
      phase: "migration-restore-in-progress",
    });
    await fs.rename(databasePath, `${databasePath}.stranded-after-restore-crash`);

    await Effect.runPromise(
      restoreMarkedMigrationBackup(databasePath, {
        expectedBackupPath: backupPath,
        expectedProvenancePath: migrationBackupProvenancePath(databasePath),
      }),
    );

    const restored = new DatabaseSync(databasePath, { readOnly: true });
    try {
      expect(
        restored
          .prepare("SELECT MAX(migration_id) AS migrationId FROM effect_sql_migrations")
          .get(),
      ).toMatchObject({ migrationId: backupMigrationId });
    } finally {
      restored.close();
    }
    await expect(fs.stat(migrationRecoveryMarkerPath(databasePath))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
