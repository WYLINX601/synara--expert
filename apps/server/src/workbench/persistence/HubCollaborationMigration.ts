import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

const HUB_COLLABORATION_V1_STATEMENTS = [
  `CREATE TABLE hub_team_presets (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL CHECK (length(trim(name)) > 0),
    purpose TEXT NOT NULL,
    expert_ids_json TEXT NOT NULL CHECK (json_valid(expert_ids_json)),
    coordinator_instructions TEXT,
    collaboration_preferences TEXT,
    revision INTEGER NOT NULL CHECK (revision > 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    archived_at TEXT
  )`,
  `CREATE TABLE hub_team_preset_revisions (
    preset_id TEXT NOT NULL REFERENCES hub_team_presets(id) ON DELETE CASCADE,
    revision INTEGER NOT NULL CHECK (revision > 0),
    request_id TEXT NOT NULL,
    payload_digest TEXT NOT NULL,
    operation TEXT NOT NULL CHECK (operation IN ('save', 'archive', 'restore')),
    name TEXT NOT NULL CHECK (length(trim(name)) > 0),
    purpose TEXT NOT NULL,
    expert_ids_json TEXT NOT NULL CHECK (json_valid(expert_ids_json)),
    coordinator_instructions TEXT,
    collaboration_preferences TEXT,
    archived_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (preset_id, revision)
  )`,
  `CREATE TABLE hub_collaboration_configs (
    hub_id TEXT PRIMARY KEY REFERENCES projection_projects(project_id) ON DELETE CASCADE,
    revision INTEGER NOT NULL CHECK (revision > 0),
    settings_json TEXT NOT NULL CHECK (json_valid(settings_json)),
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE hub_collaboration_config_revisions (
    hub_id TEXT NOT NULL REFERENCES projection_projects(project_id) ON DELETE CASCADE,
    revision INTEGER NOT NULL CHECK (revision > 0),
    settings_json TEXT NOT NULL CHECK (json_valid(settings_json)),
    expert_ids_json TEXT NOT NULL CHECK (json_valid(expert_ids_json)),
    request_id TEXT NOT NULL,
    payload_digest TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (hub_id, revision)
  )`,
  `CREATE TABLE hub_collaboration_operation_receipts (
    operation_scope TEXT NOT NULL CHECK (operation_scope IN ('team-save', 'team-archive', 'hub-settings-save')),
    aggregate_id TEXT NOT NULL,
    request_id TEXT NOT NULL,
    payload_digest TEXT NOT NULL,
    result_json TEXT NOT NULL CHECK (json_valid(result_json)),
    created_at TEXT NOT NULL,
    PRIMARY KEY (operation_scope, aggregate_id, request_id)
  )`,
] as const;

/** Canonical SQL for the Expert workbench migration ledger. */
export const HUB_COLLABORATION_V1_SQL = `${HUB_COLLABORATION_V1_STATEMENTS.join(";\n\n")};\n`;

/** Migration runner effect; the runner executes one SQL statement per call. */
export const HUB_COLLABORATION_V1_EFFECT = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  for (const statement of HUB_COLLABORATION_V1_STATEMENTS) {
    yield* sql.unsafe(statement);
  }
});
