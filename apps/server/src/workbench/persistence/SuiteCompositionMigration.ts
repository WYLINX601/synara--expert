import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

const statements = [
  `CREATE TABLE suite_import_plans (
    plan_id TEXT PRIMARY KEY,
    source_key TEXT NOT NULL UNIQUE,
    state TEXT NOT NULL CHECK (state IN ('pending', 'committed')),
    plan_json TEXT NOT NULL,
    result_json TEXT,
    last_issue_json TEXT,
    CHECK ((state = 'committed' AND result_json IS NOT NULL) OR
           (state = 'pending' AND result_json IS NULL))
  )`,
  `CREATE TABLE suite_import_operations (
    operation_id TEXT PRIMARY KEY,
    request_hash TEXT NOT NULL,
    plan_id TEXT REFERENCES suite_import_plans(plan_id),
    rejected_issue_json TEXT,
    CHECK ((plan_id IS NOT NULL AND rejected_issue_json IS NULL) OR
           (plan_id IS NULL AND rejected_issue_json IS NOT NULL))
  )`,
  `CREATE TABLE suite_compositions (
    suite_id TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision > 0),
    composition_hash TEXT NOT NULL,
    record_json TEXT NOT NULL,
    PRIMARY KEY (suite_id, revision)
  )`,
  `CREATE TABLE suite_capability_bindings (
    binding_id TEXT PRIMARY KEY,
    binding_hash TEXT NOT NULL,
    record_json TEXT NOT NULL
  )`,
  `CREATE TABLE suite_resource_revisions (
    resource_id TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision > 0),
    package_id TEXT NOT NULL,
    PRIMARY KEY (resource_id, revision)
  )`,
  `CREATE TABLE hub_suite_selections (
    hub_id TEXT PRIMARY KEY,
    suite_id TEXT NOT NULL,
    suite_revision INTEGER NOT NULL,
    composition_hash TEXT NOT NULL,
    FOREIGN KEY (suite_id, suite_revision) REFERENCES suite_compositions(suite_id, revision)
  )`,
  `CREATE TABLE hub_suite_mode_locks (
    hub_id TEXT PRIMARY KEY,
    state TEXT NOT NULL CHECK (state IN ('open', 'locked')),
    config_revision INTEGER NOT NULL CHECK (config_revision >= 0),
    selection_json TEXT NOT NULL,
    first_admission_id TEXT,
    CHECK ((state = 'open' AND first_admission_id IS NULL) OR
           (state = 'locked' AND first_admission_id IS NOT NULL))
  )`,
  `CREATE TABLE expert_delegations (
    delegation_id TEXT PRIMARY KEY,
    parent_thread_id TEXT NOT NULL,
    parent_root_run_id TEXT NOT NULL,
    target_expert_id TEXT NOT NULL,
    record_json TEXT NOT NULL
  )`,
  `CREATE INDEX idx_expert_delegations_parent
    ON expert_delegations(parent_thread_id, parent_root_run_id)`,
  `CREATE TABLE expert_delegation_attempts (
    attempt_id TEXT PRIMARY KEY,
    delegation_id TEXT NOT NULL REFERENCES expert_delegations(delegation_id),
    request_id TEXT NOT NULL,
    request_hash TEXT NOT NULL,
    provider TEXT NOT NULL,
    capability_binding_id TEXT NOT NULL REFERENCES suite_capability_bindings(binding_id),
    assembly_id TEXT NOT NULL,
    execution_binding_id TEXT UNIQUE,
    state TEXT NOT NULL CHECK (state IN
      ('prepared', 'starting', 'running', 'cancel-requested', 'completed', 'failed', 'stopped', 'unknown')),
    revision INTEGER NOT NULL CHECK (revision > 0),
    record_json TEXT NOT NULL,
    UNIQUE (delegation_id, request_id)
  )`,
  `CREATE TABLE expert_delegation_results (
    attempt_id TEXT PRIMARY KEY REFERENCES expert_delegation_attempts(attempt_id),
    result_ref TEXT NOT NULL UNIQUE,
    result_hash TEXT NOT NULL,
    outcome TEXT NOT NULL CHECK (outcome IN ('completed', 'failed', 'stopped')),
    record_json TEXT NOT NULL
  )`,
  `CREATE TABLE expert_delegation_artifact_versions (
    attempt_id TEXT PRIMARY KEY REFERENCES expert_delegation_attempts(attempt_id),
    result_hash TEXT NOT NULL,
    package_id TEXT NOT NULL
  )`,
  `CREATE TABLE expert_delegation_conflicts (
    conflict_id TEXT PRIMARY KEY,
    attempt_id TEXT NOT NULL REFERENCES expert_delegation_attempts(attempt_id),
    expected_hash TEXT NOT NULL,
    received_hash TEXT NOT NULL,
    evidence_json TEXT NOT NULL
  )`,
  `CREATE TABLE omp_expert_execution_bindings (
    execution_binding_id TEXT PRIMARY KEY,
    attempt_id TEXT NOT NULL UNIQUE REFERENCES expert_delegation_attempts(attempt_id),
    parent_thread_id TEXT NOT NULL,
    parent_generation TEXT NOT NULL,
    parent_turn_id TEXT NOT NULL,
    tool_call_id TEXT NOT NULL,
    task_index INTEGER NOT NULL CHECK (task_index >= 0),
    native_task_id TEXT NOT NULL UNIQUE,
    native_session_id TEXT,
    last_sequence INTEGER NOT NULL CHECK (last_sequence >= 0),
    record_json TEXT NOT NULL,
    UNIQUE (parent_thread_id, parent_generation, parent_turn_id, tool_call_id, task_index)
  )`,
  `CREATE TABLE omp_expert_task_events (
    attempt_id TEXT NOT NULL REFERENCES expert_delegation_attempts(attempt_id),
    sequence INTEGER NOT NULL CHECK (sequence > 0),
    payload_hash TEXT NOT NULL,
    event_json TEXT NOT NULL,
    received_at TEXT NOT NULL,
    ack_json TEXT,
    PRIMARY KEY (attempt_id, sequence)
  )`,
  "ALTER TABLE projection_threads ADD COLUMN capability_binding_id TEXT",
  "ALTER TABLE projection_threads ADD COLUMN suite_selection_json TEXT",
  "ALTER TABLE projection_threads ADD COLUMN expert_draft_selection_json TEXT",
] as const;

export const SUITE_COMPOSITION_SQL = `${statements.join(";\n\n")};\n`;
export const SUITE_COMPOSITION_EFFECT = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  for (const statement of statements) yield* sql.unsafe(statement);
});
