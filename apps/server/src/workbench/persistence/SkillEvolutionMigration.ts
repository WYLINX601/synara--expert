import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

const statements = [
  "CREATE TABLE expert_skill_evolution_requests (request_id TEXT PRIMARY KEY, expert_id TEXT NOT NULL, task_thread_id TEXT NOT NULL UNIQUE, record_json TEXT NOT NULL, updated_at TEXT NOT NULL)",
  "CREATE INDEX expert_skill_evolution_requests_expert ON expert_skill_evolution_requests (expert_id, updated_at)",
  "CREATE TABLE expert_skill_evolution_events (event_id TEXT PRIMARY KEY, expert_id TEXT NOT NULL, skill_id TEXT NOT NULL, record_json TEXT NOT NULL, created_at TEXT NOT NULL)",
  "CREATE INDEX expert_skill_evolution_events_expert ON expert_skill_evolution_events (expert_id, created_at)",
];
export const SKILL_EVOLUTION_SQL = statements.join(";\n");
export const SKILL_EVOLUTION_EFFECT = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  for (const statement of statements) yield* sql.unsafe(statement);
});
