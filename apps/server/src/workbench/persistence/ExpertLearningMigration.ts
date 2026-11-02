import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

const statements = [
  "CREATE TABLE expert_learning_states (owner_id TEXT NOT NULL, expert_id TEXT NOT NULL, record_json TEXT NOT NULL, revision INTEGER NOT NULL CHECK (revision >= 1), updated_at TEXT NOT NULL, PRIMARY KEY (owner_id, expert_id))",
  "CREATE INDEX expert_learning_states_updated ON expert_learning_states (updated_at, owner_id, expert_id)",
  "CREATE TABLE expert_learning_evidence (evidence_id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, expert_id TEXT NOT NULL, thread_id TEXT NOT NULL, turn_id TEXT NOT NULL, record_json TEXT NOT NULL, updated_at TEXT NOT NULL)",
  "CREATE INDEX expert_learning_evidence_owner_expert ON expert_learning_evidence (owner_id, expert_id, updated_at)",
  "CREATE TABLE expert_learning_cycles (cycle_id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, expert_id TEXT NOT NULL, record_json TEXT NOT NULL, updated_at TEXT NOT NULL)",
  "CREATE INDEX expert_learning_cycles_active ON expert_learning_cycles (CASE WHEN json_valid(record_json) THEN json_extract(record_json, '$.status') END, updated_at)",
  "CREATE INDEX expert_learning_cycles_owner_expert ON expert_learning_cycles (owner_id, expert_id, updated_at)",
];

export const EXPERT_LEARNING_SQL = statements.join(";\n");
export const EXPERT_LEARNING_EFFECT = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  for (const statement of statements) yield* sql.unsafe(statement);
});
