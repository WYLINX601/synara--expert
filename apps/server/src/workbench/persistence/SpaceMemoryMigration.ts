import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

const statements = [
  "CREATE TABLE space_memory_sequences (owner_id TEXT PRIMARY KEY, sequence INTEGER NOT NULL CHECK (sequence >= 0))",
  "CREATE TABLE space_memory_revisions (owner_id TEXT NOT NULL, memory_id TEXT NOT NULL, revision INTEGER NOT NULL CHECK (revision >= 1), space_key TEXT NOT NULL, expert_id TEXT NOT NULL, project_id TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('rule', 'fact', 'environment')), commit_sequence INTEGER NOT NULL CHECK (commit_sequence >= 1), record_json TEXT NOT NULL, PRIMARY KEY (owner_id, memory_id, revision))",
  "CREATE INDEX space_memory_revisions_scope_sequence ON space_memory_revisions (owner_id, space_key, expert_id, kind, project_id, commit_sequence DESC, memory_id)",
  "CREATE TABLE space_memory_heads (owner_id TEXT NOT NULL, memory_id TEXT NOT NULL, space_key TEXT NOT NULL, expert_id TEXT NOT NULL, project_id TEXT NOT NULL, revision INTEGER NOT NULL CHECK (revision >= 1), record_json TEXT NOT NULL, PRIMARY KEY (owner_id, memory_id))",
  "CREATE INDEX space_memory_heads_scope ON space_memory_heads (owner_id, space_key, expert_id, project_id, memory_id)",
  "CREATE TABLE learning_change_sets (change_id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, expert_id TEXT NOT NULL, request_id TEXT NOT NULL, request_fingerprint TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('prepared', 'committed', 'saved_unbound', 'failed', 'reverted')), record_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE (owner_id, expert_id, request_id))",
  "CREATE INDEX learning_change_sets_owner_expert_created ON learning_change_sets (owner_id, expert_id, created_at DESC, change_id)",
  "CREATE TABLE run_knowledge_manifests (manifest_id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, space_key TEXT NOT NULL, expert_id TEXT NOT NULL, project_id TEXT NOT NULL, root_run_id TEXT NOT NULL, record_json TEXT NOT NULL, created_at TEXT NOT NULL)",
  "CREATE UNIQUE INDEX run_knowledge_manifests_root_identity ON run_knowledge_manifests (owner_id, space_key, expert_id, project_id, root_run_id)",
  "CREATE INDEX run_knowledge_manifests_scope ON run_knowledge_manifests (owner_id, space_key, expert_id, project_id, root_run_id)",
  "CREATE TABLE space_memory_reads (manifest_id TEXT NOT NULL, memory_id TEXT NOT NULL, revision INTEGER NOT NULL CHECK (revision >= 1), content_hash TEXT NOT NULL, tool_call_id TEXT NOT NULL, read_at TEXT NOT NULL, PRIMARY KEY (manifest_id, memory_id, revision, tool_call_id))",
  "CREATE INDEX space_memory_reads_tool_call ON space_memory_reads (manifest_id, tool_call_id, read_at)",
];

export const SPACE_MEMORY_SQL = statements.join(";\n");
export const SPACE_MEMORY_EFFECT = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  for (const statement of statements) yield* sql.unsafe(statement);
});
