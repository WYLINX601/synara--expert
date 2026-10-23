import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

const HUB_PLAN_STATEMENTS = [
  `CREATE TABLE hub_plans (
    plan_id TEXT PRIMARY KEY,
    hub_id TEXT NOT NULL REFERENCES projection_projects(project_id) ON DELETE CASCADE,
    goal_id TEXT,
    revision INTEGER NOT NULL CHECK (revision > 0),
    state_version INTEGER NOT NULL CHECK (state_version >= 0),
    control_state TEXT NOT NULL CHECK (control_state IN ('draft', 'active', 'pausing', 'paused', 'cancelling', 'cancelled', 'completed')),
    definition_json TEXT NOT NULL CHECK (json_valid(definition_json)),
    config_snapshot_json TEXT NOT NULL CHECK (json_valid(config_snapshot_json)),
    stage_generations_json TEXT NOT NULL CHECK (json_valid(stage_generations_json)),
    source_message_ids_json TEXT NOT NULL CHECK (json_valid(source_message_ids_json)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (plan_id, hub_id)
  )`,
  `CREATE UNIQUE INDEX idx_hub_plans_one_nonterminal
    ON hub_plans (hub_id)
    WHERE control_state IN ('active', 'pausing', 'paused', 'cancelling')`,
  `CREATE INDEX idx_hub_plans_by_hub_updated
    ON hub_plans (hub_id, updated_at DESC, plan_id)`,
  `CREATE TABLE hub_plan_revisions (
    plan_id TEXT NOT NULL REFERENCES hub_plans(plan_id) ON DELETE CASCADE,
    revision INTEGER NOT NULL CHECK (revision > 0),
    record_json TEXT NOT NULL CHECK (json_valid(record_json)),
    created_at TEXT NOT NULL,
    PRIMARY KEY (plan_id, revision)
  )`,
  `CREATE TABLE hub_plan_node_bindings (
    plan_id TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision > 0),
    node_key TEXT NOT NULL,
    task_id TEXT NOT NULL REFERENCES project_agent_tasks(task_id),
    stage_key TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('author', 'reviewer', 'worker')),
    PRIMARY KEY (plan_id, revision, node_key),
    UNIQUE (plan_id, revision, task_id),
    FOREIGN KEY (plan_id, revision) REFERENCES hub_plan_revisions(plan_id, revision) ON DELETE CASCADE
  )`,
  `CREATE TABLE hub_plan_attempt_bindings (
    id TEXT PRIMARY KEY,
    plan_id TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision > 0),
    node_key TEXT NOT NULL,
    task_id TEXT NOT NULL REFERENCES project_agent_tasks(task_id),
    -- The deterministic attempt identity is reserved while the work is queued;
    -- the native attempt row cannot exist until thread creation supplies its workerThreadId.
    attempt_id TEXT NOT NULL,
    work_item_id TEXT NOT NULL REFERENCES project_agent_work_items(work_item_id),
    stage_generation INTEGER NOT NULL CHECK (stage_generation >= 0),
    created_at TEXT NOT NULL,
    FOREIGN KEY (plan_id, revision) REFERENCES hub_plan_revisions(plan_id, revision) ON DELETE CASCADE
  )`,
  `CREATE INDEX idx_hub_plan_attempt_bindings_by_plan
    ON hub_plan_attempt_bindings (plan_id, revision, node_key, created_at, id)`,
  `CREATE UNIQUE INDEX idx_hub_plan_attempt_bindings_attempt
    ON hub_plan_attempt_bindings (attempt_id)`,
  `CREATE UNIQUE INDEX idx_hub_plan_attempt_bindings_work_item
    ON hub_plan_attempt_bindings (work_item_id)`,
  `CREATE TABLE hub_plan_candidates (
    plan_id TEXT NOT NULL REFERENCES hub_plans(plan_id) ON DELETE CASCADE,
    id TEXT NOT NULL,
    record_json TEXT NOT NULL CHECK (json_valid(record_json)),
    created_at TEXT NOT NULL,
    PRIMARY KEY (plan_id, id)
  )`,
  `CREATE INDEX idx_hub_plan_candidates_by_plan
    ON hub_plan_candidates (plan_id, created_at, id)`,
  `CREATE UNIQUE INDEX idx_hub_plan_candidates_generation
    ON hub_plan_candidates (
      plan_id,
      json_extract(record_json, '$.revision'),
      json_extract(record_json, '$.stageKey'),
      json_extract(record_json, '$.generation')
    )`,
  `CREATE TABLE hub_plan_reviews (
    plan_id TEXT NOT NULL REFERENCES hub_plans(plan_id) ON DELETE CASCADE,
    id TEXT NOT NULL,
    record_json TEXT NOT NULL CHECK (json_valid(record_json)),
    created_at TEXT NOT NULL,
    PRIMARY KEY (plan_id, id)
  )`,
  `CREATE INDEX idx_hub_plan_reviews_by_plan
    ON hub_plan_reviews (plan_id, created_at, id)`,
  `CREATE UNIQUE INDEX idx_hub_plan_reviews_attempt
    ON hub_plan_reviews (
      plan_id,
      json_extract(record_json, '$.candidateId'),
      json_extract(record_json, '$.reviewerNodeKey'),
      json_extract(record_json, '$.attemptId'),
      json_extract(record_json, '$.generation')
    )`,
  `CREATE TABLE hub_plan_releases (
    plan_id TEXT NOT NULL REFERENCES hub_plans(plan_id) ON DELETE CASCADE,
    id TEXT NOT NULL,
    record_json TEXT NOT NULL CHECK (json_valid(record_json)),
    created_at TEXT NOT NULL,
    PRIMARY KEY (plan_id, id)
  )`,
  `CREATE INDEX idx_hub_plan_releases_by_plan
    ON hub_plan_releases (plan_id, created_at, id)`,
  `CREATE TABLE hub_plan_events (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    plan_id TEXT NOT NULL,
    hub_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
    created_at TEXT NOT NULL,
    FOREIGN KEY (plan_id, hub_id) REFERENCES hub_plans(plan_id, hub_id) ON DELETE CASCADE
  )`,
  `CREATE INDEX idx_hub_plan_events_by_hub_sequence
    ON hub_plan_events (hub_id, sequence)`,
  `CREATE INDEX idx_hub_plan_events_by_plan_sequence
    ON hub_plan_events (plan_id, sequence)`,
  `CREATE TABLE hub_plan_operation_receipts (
    hub_id TEXT NOT NULL REFERENCES projection_projects(project_id) ON DELETE CASCADE,
    request_id TEXT NOT NULL,
    digest TEXT NOT NULL,
    result_json TEXT NOT NULL CHECK (json_valid(result_json)),
    created_at TEXT NOT NULL,
    PRIMARY KEY (hub_id, request_id)
  )`,
  `CREATE TABLE hub_plan_outbox (
    id TEXT PRIMARY KEY,
    plan_id TEXT NOT NULL REFERENCES hub_plans(plan_id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
    status TEXT NOT NULL CHECK (status IN ('pending', 'delivered')),
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX idx_hub_plan_outbox_pending
    ON hub_plan_outbox (status, created_at, id)`,
] as const;

/** Canonical SQL for the Expert workbench migration ledger. */
export const HUB_PLAN_SQL = `${HUB_PLAN_STATEMENTS.join(";\n\n")};\n`;

/** Migration runner effect; the runner executes one SQL statement per call. */
export const HUB_PLAN_EFFECT = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  for (const statement of HUB_PLAN_STATEMENTS) {
    yield* sql.unsafe(statement);
  }
});

const HUB_PLAN_INPUT_REQUEST_STATEMENTS = [
  `CREATE TABLE hub_plan_input_requests (
    plan_id TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision > 0),
    request_id TEXT NOT NULL,
    record_json TEXT NOT NULL CHECK (json_valid(record_json)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (plan_id, revision, request_id),
    FOREIGN KEY (plan_id, revision) REFERENCES hub_plan_revisions(plan_id, revision) ON DELETE CASCADE
  )`,
  `CREATE INDEX idx_hub_plan_input_requests_attempt
    ON hub_plan_input_requests (plan_id, revision, json_extract(record_json, '$.nodeKey'), json_extract(record_json, '$.generation'), created_at, request_id)`,
] as const;

/** Canonical SQL for durable Worker questions and owner answers. */
export const HUB_PLAN_INPUT_REQUEST_SQL = `${HUB_PLAN_INPUT_REQUEST_STATEMENTS.join(";\n\n")};\n`;

/** Migration runner effect; the runner executes one SQL statement per call. */
export const HUB_PLAN_INPUT_REQUEST_EFFECT = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  for (const statement of HUB_PLAN_INPUT_REQUEST_STATEMENTS) {
    yield* sql.unsafe(statement);
  }
});
