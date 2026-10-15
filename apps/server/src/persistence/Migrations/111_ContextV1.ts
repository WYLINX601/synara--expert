import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { columnExists } from "./schemaHelpers.ts";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`CREATE TABLE IF NOT EXISTS context_meta (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    data_instance_id TEXT NOT NULL
  )`;
  yield* sql`INSERT OR IGNORE INTO context_meta (singleton, data_instance_id) VALUES (
    1,
    lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
      substr(lower(hex(randomblob(2))), 2) || '-a' || substr(lower(hex(randomblob(2))), 2) || '-' ||
      lower(hex(randomblob(6)))
  )`;

  yield* sql`CREATE TABLE IF NOT EXISTS context_spaces (
    space_id TEXT PRIMARY KEY,
    direction_goal TEXT NOT NULL DEFAULT '',
    shared_instructions TEXT NOT NULL DEFAULT '',
    revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
    updated_at TEXT NOT NULL
  )`;
  yield* sql`CREATE TABLE IF NOT EXISTS context_projects (
    project_id TEXT PRIMARY KEY,
    project_goal TEXT NOT NULL DEFAULT '',
    project_instructions TEXT NOT NULL DEFAULT '',
    revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
    updated_at TEXT NOT NULL
  )`;
  yield* sql`CREATE TABLE IF NOT EXISTS context_migrations (
    project_id TEXT PRIMARY KEY,
    source_digest TEXT NOT NULL,
    legacy_instructions TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'conflict', 'completed')),
    choice TEXT CHECK (choice IS NULL OR choice IN ('keep_saved', 'use_legacy')),
    updated_at TEXT NOT NULL
  )`;
  yield* sql`CREATE TABLE IF NOT EXISTS context_thread_bindings (
    thread_id TEXT PRIMARY KEY,
    mode TEXT NOT NULL CHECK (mode IN ('legacy', 'unbound', 'bound')),
    snapshot_json TEXT
  )`;
  yield* sql`CREATE TABLE IF NOT EXISTS context_applied_runtime_records (
    thread_id TEXT PRIMARY KEY,
    record_json TEXT NOT NULL
  )`;
  yield* sql`CREATE TABLE IF NOT EXISTS context_command_results (
    command_id TEXT PRIMARY KEY,
    result_json TEXT NOT NULL
  )`;

  if (!(yield* columnExists(sql, "orchestration_event_deliveries", "context_snapshot_id"))) {
    yield* sql`ALTER TABLE orchestration_event_deliveries ADD COLUMN context_snapshot_id TEXT`;
  }
  if (!(yield* columnExists(sql, "orchestration_event_deliveries", "context_input_digest"))) {
    yield* sql`ALTER TABLE orchestration_event_deliveries ADD COLUMN context_input_digest TEXT`;
  }
  if (!(yield* columnExists(sql, "orchestration_event_deliveries", "context_message_id"))) {
    yield* sql`ALTER TABLE orchestration_event_deliveries ADD COLUMN context_message_id TEXT`;
  }
  if (!(yield* columnExists(sql, "orchestration_event_deliveries", "context_phase"))) {
    yield* sql`ALTER TABLE orchestration_event_deliveries ADD COLUMN context_phase TEXT
      CHECK (context_phase IS NULL OR context_phase IN ('before_dispatch', 'dispatch_started', 'acknowledged'))`;
  }
});
