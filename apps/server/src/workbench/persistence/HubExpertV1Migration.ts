import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

const HUB_EXPERT_V1_STATEMENTS = [
  `CREATE TABLE hub_expert_deliverable_collections (
    hub_id TEXT NOT NULL,
    worker_thread_id TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision >= 0),
    state TEXT NOT NULL CHECK (state IN ('active', 'withdrawn')),
    commit_sha TEXT,
    provenance_json TEXT,
    files_json TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (hub_id, worker_thread_id),
    CHECK ((state = 'active' AND commit_sha IS NOT NULL AND provenance_json IS NOT NULL) OR
           (state = 'withdrawn' AND commit_sha IS NULL AND provenance_json IS NULL AND files_json = '[]'))
  )`,
  `CREATE TABLE hub_expert_deliverable_requests (
    hub_id TEXT NOT NULL,
    worker_thread_id TEXT NOT NULL,
    request_id TEXT NOT NULL,
    operation TEXT NOT NULL CHECK (operation IN ('publish', 'withdraw')),
    expected_revision INTEGER NOT NULL CHECK (expected_revision >= 0),
    fingerprint TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('prepared', 'committed', 'completed')),
    request_json TEXT NOT NULL,
    files_json TEXT NOT NULL,
    commit_sha TEXT,
    result_json TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (hub_id, worker_thread_id, request_id),
    CHECK ((status = 'completed' AND result_json IS NOT NULL) OR
           (status <> 'completed' AND result_json IS NULL))
  )`,
  `CREATE INDEX idx_hub_expert_deliverable_requests_updated
    ON hub_expert_deliverable_requests(updated_at)`,
] as const;

/** Canonical multi-statement SQL for the Expert workbench migration record. */
export const HUB_EXPERT_V1_SQL = `${HUB_EXPERT_V1_STATEMENTS.join(";\n\n")};\n`;

/** Migration runner effect; the runner executes one SQL statement per call. */
export const HUB_EXPERT_V1_EFFECT = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  for (const statement of HUB_EXPERT_V1_STATEMENTS) {
    yield* sql.unsafe(statement);
  }
});
