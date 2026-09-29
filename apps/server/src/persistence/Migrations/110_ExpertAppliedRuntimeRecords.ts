import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE IF NOT EXISTS expert_applied_runtime_records (
    thread_id TEXT PRIMARY KEY,
    snapshot_id TEXT NOT NULL,
    provider TEXT NOT NULL,
    model TEXT,
    runtime_component TEXT,
    runtime_version TEXT,
    lifecycle_generation TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )`;
});
