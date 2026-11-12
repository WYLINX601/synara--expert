import { SuiteComposition, SuiteRef, type ProjectId } from "@synara/contracts";
import { Effect, Schema } from "effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

import { suiteCompositionFingerprint } from "../suites/SuiteCompositionStore";
import { canonicalSuiteJson } from "../suites/suiteIdentity";

export const sameHubSuite = (left: SuiteRef | null, right: SuiteRef | null) =>
  left === null
    ? right === null
    : right !== null && left.suiteId === right.suiteId && left.revision === right.revision;

export function readHubSuiteComposition(sql: SqlClient.SqlClient, ref: SuiteRef) {
  return Effect.gen(function* () {
    const [row] = yield* sql<{ readonly hash: string; readonly recordJson: string }>`
      SELECT composition_hash AS hash, record_json AS "recordJson" FROM suite_compositions
      WHERE suite_id = ${ref.suiteId} AND revision = ${ref.revision}
    `;
    if (!row) return yield* Effect.fail(new Error("Selected Suite revision does not exist."));
    const composition = yield* Effect.try({
      try: () => Schema.decodeUnknownSync(SuiteComposition)(JSON.parse(row.recordJson)),
      catch: (cause) => new Error("Selected Suite revision could not be decoded.", { cause }),
    });
    if (
      !sameHubSuite(composition.ref, ref) ||
      composition.compositionHash !== row.hash ||
      suiteCompositionFingerprint(composition) !== row.hash
    )
      return yield* Effect.fail(new Error("Selected Suite revision is corrupt."));
    return composition;
  });
}

export function readHubSuiteSelection(sql: SqlClient.SqlClient, projectId: ProjectId) {
  return Effect.gen(function* () {
    const [row] = yield* sql<{
      readonly suiteId: string;
      readonly revision: number;
      readonly hash: string;
    }>`
      SELECT suite_id AS "suiteId", suite_revision AS revision, composition_hash AS hash
      FROM hub_suite_selections WHERE hub_id = ${projectId}
    `;
    if (!row) return null;
    const ref = yield* Schema.decodeUnknownEffect(SuiteRef)({
      suiteId: row.suiteId,
      revision: row.revision,
    });
    const composition = yield* readHubSuiteComposition(sql, ref);
    if (composition.compositionHash !== row.hash)
      return yield* Effect.fail(new Error("Hub Suite selection and composition disagree."));
    return ref;
  });
}

const ModeLock = Schema.Struct({
  state: Schema.Literals(["open", "locked"]),
  configRevision: Schema.Int,
  selection: Schema.NullOr(SuiteRef),
  firstAdmissionId: Schema.NullOr(Schema.String),
});

export function readHubSuiteModeLock(sql: SqlClient.SqlClient, projectId: ProjectId) {
  return Effect.gen(function* () {
    const [row] = yield* sql<{
      readonly state: string;
      readonly configRevision: number;
      readonly selectionJson: string;
      readonly firstAdmissionId: string | null;
    }>`SELECT state, config_revision AS "configRevision", selection_json AS "selectionJson",
      first_admission_id AS "firstAdmissionId" FROM hub_suite_mode_locks WHERE hub_id = ${projectId}`;
    if (!row) return null;
    const lock = yield* Effect.try({
      try: () =>
        Schema.decodeUnknownSync(ModeLock)({
          ...row,
          selection: JSON.parse(row.selectionJson),
        }),
      catch: (cause) => new Error("Hub Suite mode lock could not be decoded.", { cause }),
    });
    if ((lock.state === "open") !== (lock.firstAdmissionId === null))
      return yield* Effect.fail(new Error("Hub Suite mode lock is corrupt."));
    return lock;
  });
}

/** Caller owns the SQL write transaction; never performs filesystem/Promise reads. */
export function admitHubSuiteExecution(
  sql: SqlClient.SqlClient,
  input: {
    readonly projectId: ProjectId;
    readonly expectedRevision: number;
    readonly admissionId: string;
  },
) {
  return Effect.gen(function* () {
    if (!input.admissionId.trim())
      return yield* Effect.fail(new Error("Admission ID is required."));
    const [config] = yield* sql<{
      readonly revision: number;
      readonly enabled: number;
      readonly pausedAt: string | null;
      readonly archivedAt: string | null;
    }>`SELECT revision, enabled, paused_at AS "pausedAt", archived_at AS "archivedAt"
      FROM project_agent_configs WHERE project_id = ${input.projectId}`;
    if (!config || config.enabled !== 1 || config.pausedAt !== null || config.archivedAt !== null)
      return yield* Effect.fail(new Error("Hub is not authorized to execute."));
    const suite = yield* readHubSuiteSelection(sql, input.projectId);
    const lock = yield* readHubSuiteModeLock(sql, input.projectId);
    if ((!lock && suite !== null) || (lock && !sameHubSuite(lock.selection, suite)))
      return yield* Effect.fail(new Error("Hub Suite selection and mode lock disagree."));
    if (lock?.state === "locked" && lock.firstAdmissionId === input.admissionId)
      return { suite, configRevision: lock.configRevision };
    if (config.revision !== input.expectedRevision)
      return yield* Effect.fail(
        new Error("Hub settings changed during execution preflight. Reload and retry."),
      );
    if (lock?.state === "open") {
      if (lock.configRevision !== config.revision)
        return yield* Effect.fail(
          new Error("Hub Suite mode lock revision disagrees with configuration."),
        );
      yield* sql`UPDATE hub_suite_mode_locks SET state = 'locked', first_admission_id = ${input.admissionId}
        WHERE hub_id = ${input.projectId} AND state = 'open'`;
    }
    return { suite, configRevision: config.revision };
  });
}

export function writeHubSuiteSelection(
  sql: SqlClient.SqlClient,
  projectId: ProjectId,
  suite: SuiteRef | null,
) {
  return Effect.gen(function* () {
    if (suite === null) {
      yield* sql`DELETE FROM hub_suite_selections WHERE hub_id = ${projectId}`;
      return;
    }
    const composition = yield* readHubSuiteComposition(sql, suite);
    yield* sql`INSERT INTO hub_suite_selections(hub_id, suite_id, suite_revision, composition_hash)
      VALUES (${projectId}, ${suite.suiteId}, ${suite.revision}, ${composition.compositionHash})
      ON CONFLICT(hub_id) DO UPDATE SET suite_id = excluded.suite_id,
        suite_revision = excluded.suite_revision, composition_hash = excluded.composition_hash`;
  });
}

export const hubSuiteSelectionJson = (suite: SuiteRef | null) => canonicalSuiteJson(suite);
