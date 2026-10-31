import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../persistence/Migrations.ts";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";
import {
  runWorkbenchMigrations,
  workbenchMigrationEntries,
} from "../workbench/persistence/WorkbenchMigrations.ts";
import {
  HubCollaborationStoreConflictError,
  HubCollaborationStoreIdempotencyError,
  makeHubCollaborationConfigStore,
} from "./HubCollaborationConfigStore.ts";

const layer = it.layer(NodeSqliteClient.layerMemory());

layer("Hub collaboration configuration store", (test) => {
  test.effect(
    "preserves preset revisions, replays idempotently, and snapshots settings atomically",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations();
        yield* runWorkbenchMigrations();
        const store = makeHubCollaborationConfigStore(sql);

        const ledgerRows = yield* sql<{ readonly migrationId: number; readonly name: string }>`
        SELECT migration_id AS "migrationId", name
        FROM workbench_sql_migrations
        WHERE module_id = 'expert'
        ORDER BY migration_id
      `;
        assert.strictEqual(ledgerRows.length, workbenchMigrationEntries.length);
        assert.strictEqual(ledgerRows.at(-1)?.migrationId, 13);
        assert.strictEqual(ledgerRows.at(-1)?.name, "SpaceMemory");
        const createdTables = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name IN (
          'hub_team_presets',
          'hub_team_preset_revisions',
          'hub_collaboration_configs',
          'hub_collaboration_config_revisions',
          'hub_collaboration_operation_receipts'
        )
        ORDER BY name
      `;
        assert.deepStrictEqual(
          createdTables.map(({ name }) => name),
          [
            "hub_collaboration_config_revisions",
            "hub_collaboration_configs",
            "hub_collaboration_operation_receipts",
            "hub_team_preset_revisions",
            "hub_team_presets",
          ],
        );

        const createTeamInput = {
          id: "  team-review  ",
          expectedRevision: null,
          requestId: " team-create-1 ",
          name: "  Review Team ",
          purpose: "  Review risky changes  ",
          expertIds: ["reviewer", " reviewer ", "architect"],
          coordinatorInstructions: "   ",
          collaborationPreferences: "  Keep findings concise  ",
        } as const;
        const createdTeam = yield* store.saveTeam(createTeamInput);
        assert.deepStrictEqual(createdTeam, {
          id: "team-review",
          name: "Review Team",
          purpose: "Review risky changes",
          expertIds: ["reviewer", "architect"],
          collaborationPreferences: "Keep findings concise",
          revision: 1,
          createdAt: createdTeam.createdAt,
          updatedAt: createdTeam.updatedAt,
          archivedAt: null,
        });

        const secondTeamInput = {
          id: "team-review",
          expectedRevision: 1,
          requestId: "team-save-2",
          name: "Review Team v2",
          purpose: "Review and record risks",
          expertIds: ["architect", "reviewer"],
        } as const;
        const updatedTeam = yield* store.saveTeam(secondTeamInput);
        assert.strictEqual(updatedTeam.revision, 2);
        assert.strictEqual(updatedTeam.createdAt, createdTeam.createdAt);
        assert.deepStrictEqual(yield* store.saveTeam(secondTeamInput), updatedTeam);
        const idempotencyFailure = yield* Effect.flip(
          store.saveTeam({ ...secondTeamInput, name: "Changed under same request id" }),
        );
        assert.isTrue(idempotencyFailure instanceof HubCollaborationStoreIdempotencyError);
        const teamCasFailure = yield* Effect.flip(
          store.saveTeam({ ...secondTeamInput, requestId: "team-save-stale", purpose: "stale" }),
        );
        assert.isTrue(teamCasFailure instanceof HubCollaborationStoreConflictError);

        const archivedTeam = yield* store.setTeamArchived({
          id: "team-review",
          expectedRevision: 2,
          requestId: "team-archive-3",
          archived: true,
        });
        assert.strictEqual(archivedTeam.revision, 3);
        assert.notStrictEqual(archivedTeam.archivedAt, null);
        assert.strictEqual((yield* store.listTeams()).length, 1);
        assert.deepStrictEqual(yield* store.listTeams({ includeArchived: false }), []);
        const restoredTeam = yield* store.setTeamArchived({
          id: "team-review",
          expectedRevision: 3,
          requestId: "team-restore-4",
          archived: false,
        });
        assert.strictEqual(restoredTeam.revision, 4);
        assert.strictEqual(restoredTeam.archivedAt, null);
        assert.strictEqual(
          (yield* store.readTeam({ id: "team-review", revision: 1 }))?.name,
          "Review Team",
        );
        assert.strictEqual(
          (yield* store.readTeam({ id: "team-review", revision: 2 }))?.name,
          "Review Team v2",
        );
        assert.strictEqual(
          (yield* store.readTeam({ id: "team-review", revision: 3 }))?.archivedAt,
          archivedTeam.archivedAt,
        );

        yield* sql`
        INSERT INTO projection_projects (
          project_id, title, workspace_root, scripts_json, created_at, updated_at
        ) VALUES ('hub-settings-test', 'Hub', '/tmp/hub-settings', '[]', 'now', 'now')
      `;
        yield* sql`
        INSERT INTO hub_expert_participants (hub_id, expert_id)
        VALUES ('hub-settings-test', 'reviewer'), ('hub-settings-test', 'architect')
      `;
        assert.strictEqual(yield* store.readHubSettings({ hubId: "hub-settings-test" }), null);
        assert.deepStrictEqual(
          yield* store.readHubSettingsHistory({ hubId: "hub-settings-test" }),
          [],
        );

        const firstConfigInput = {
          hubId: "hub-settings-test",
          expectedRevision: null,
          requestId: "hub-settings:hub-settings-test:1",
          settings: {
            schemaVersion: 1,
            mode: "expert-team",
            coordinatorInstructions: "  Assign work by specialty  ",
            presetSource: { id: "team-review", revision: 2 },
          },
        } as const;
        const firstConfig = yield* store.saveHubSettings(firstConfigInput);
        assert.deepStrictEqual(firstConfig.expertIds, ["architect", "reviewer"]);
        assert.deepStrictEqual(firstConfig.settings, {
          schemaVersion: 1,
          mode: "expert-team",
          coordinatorInstructions: "Assign work by specialty",
          presetSource: { id: "team-review", revision: 2 },
        });

        yield* sql`DELETE FROM hub_expert_participants WHERE hub_id = 'hub-settings-test'`;
        yield* sql`
        INSERT INTO hub_expert_participants (hub_id, expert_id)
        VALUES ('hub-settings-test', 'writer'), ('hub-settings-test', 'reviewer')
      `;
        const secondConfigInput = {
          hubId: "hub-settings-test",
          expectedRevision: 1,
          requestId: "hub-settings:hub-settings-test:2",
          settings: { schemaVersion: 1, mode: "standard" },
        } as const;
        const secondConfig = yield* store.saveHubSettings(secondConfigInput);
        assert.strictEqual(secondConfig.revision, 2);
        assert.deepStrictEqual(yield* store.saveHubSettings(secondConfigInput), secondConfig);
        const currentConfig = yield* store.readHubSettings({ hubId: "hub-settings-test" });
        assert.deepStrictEqual(currentConfig?.expertIds, ["reviewer", "writer"]);
        assert.deepStrictEqual(currentConfig?.settings, { schemaVersion: 1, mode: "standard" });
        const configHistory = yield* store.readHubSettingsHistory({ hubId: "hub-settings-test" });
        assert.deepStrictEqual(
          configHistory.map(({ revision, expertIds }) => [revision, expertIds]),
          [
            [1, ["architect", "reviewer"]],
            [2, ["reviewer", "writer"]],
          ],
        );

        const configCasFailure = yield* Effect.flip(
          store.saveHubSettings({
            ...secondConfigInput,
            requestId: "hub-settings-stale",
            expectedRevision: 1,
          }),
        );
        assert.isTrue(configCasFailure instanceof HubCollaborationStoreConflictError);

        const transactionFailure = yield* Effect.flip(
          sql.withTransaction(
            Effect.gen(function* () {
              yield* sql`DELETE FROM hub_expert_participants WHERE hub_id = 'hub-settings-test'`;
              yield* sql`
              INSERT INTO hub_expert_participants (hub_id, expert_id)
              VALUES ('hub-settings-test', 'rolled-back')
            `;
              yield* store.saveHubSettingsInTransaction({
                hubId: "hub-settings-test",
                expectedRevision: 2,
                requestId: "hub-settings:hub-settings-test:3",
                settings: { schemaVersion: 1, mode: "expert-team" },
              });
              return yield* Effect.fail(new Error("force transaction rollback"));
            }),
          ),
        );
        assert.strictEqual(transactionFailure.message, "force transaction rollback");
        assert.deepStrictEqual(
          (yield* store.readHubSettings({ hubId: "hub-settings-test" }))?.expertIds,
          ["reviewer", "writer"],
        );
        assert.strictEqual(
          (yield* store.readHubSettings({ hubId: "hub-settings-test" }))?.revision,
          2,
        );
        assert.strictEqual(
          (yield* store.readHubSettingsHistory({ hubId: "hub-settings-test" })).length,
          2,
        );
        const missingReceipt = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count
        FROM hub_collaboration_operation_receipts
        WHERE operation_scope = 'hub-settings-save'
          AND request_id = 'hub-settings:hub-settings-test:3'
      `;
        assert.strictEqual(missingReceipt[0]?.count, 0);
      }),
  );
});
