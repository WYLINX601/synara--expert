import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

const statements = [
  `CREATE TABLE expert_learning_pending_evidence (
    capture_id TEXT PRIMARY KEY,
    source_json TEXT NOT NULL,
    record_json TEXT NOT NULL,
    first_sequence INTEGER NOT NULL,
    last_sequence INTEGER NOT NULL,
    pending INTEGER NOT NULL CHECK(pending IN (0,1)),
    discarded INTEGER NOT NULL CHECK(discarded IN (0,1)),
    updated_at TEXT NOT NULL
  )`,
  "CREATE INDEX expert_learning_pending_evidence_pending ON expert_learning_pending_evidence (pending, first_sequence, capture_id)",
];

export const EXPERT_LEARNING_EVIDENCE_DELIVERY_SQL = statements.join(";\n");
export const EXPERT_LEARNING_EVIDENCE_DELIVERY_EFFECT = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  for (const statement of statements) yield* sql.unsafe(statement);
});
