import { randomUUID } from "node:crypto";
import {
  ExpertDelegation,
  ExpertDelegationAttempt,
  ExpertDelegationResult,
  SuiteContentHash,
  SuiteIssue,
  type ExpertDelegationState,
  type ThreadId,
} from "@synara/contracts";
import { Effect, Layer, Schema, ServiceMap } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { canonicalSuiteJson, suiteContentDigest } from "../../suites/suiteIdentity";

export class ExpertDelegationStoreError extends Error {
  constructor(
    message: string,
    readonly code: SuiteIssue["code"],
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ExpertDelegationStoreError";
  }
}
const failure = (cause: unknown): ExpertDelegationStoreError =>
  cause instanceof ExpertDelegationStoreError
    ? cause
    : new ExpertDelegationStoreError("Expert delegation storage is unavailable.", "probe_error", {
        cause,
      });
const guarded = <A>(
  effect: Effect.Effect<A, unknown>,
): Effect.Effect<A, ExpertDelegationStoreError> => effect.pipe(Effect.mapError(failure));
const checked = <A>(action: () => A) => Effect.try({ try: action, catch: failure });
const conflict = () =>
  new ExpertDelegationStoreError(
    "Expert delegation identity or content conflicts with an existing attempt.",
    "result_conflict",
  );
const missing = () =>
  new ExpertDelegationStoreError("Expert delegation attempt is unavailable.", "execution_unknown");
const terminal: Partial<Record<ExpertDelegationState, true>> = {
  completed: true,
  failed: true,
  stopped: true,
};
const transitions: Record<ExpertDelegationState, readonly ExpertDelegationState[]> = {
  prepared: ["starting", "cancel-requested", "unknown"],
  starting: ["running", "cancel-requested", "unknown"],
  running: ["cancel-requested", "unknown"],
  "cancel-requested": ["unknown"],
  unknown: ["running", "cancel-requested"],
  completed: [],
  failed: [],
  stopped: [],
};
const ResultContent = Schema.Struct({
  outcome: Schema.Literals(["completed", "failed", "stopped"]),
  result: Schema.NullOr(ExpertDelegationResult),
  issue: Schema.NullOr(SuiteIssue),
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type ExpertDelegationResultContent = typeof ResultContent.Type;
export interface StoredExpertDelegationResult extends ExpertDelegationResultContent {
  readonly attemptId: string;
  readonly resultRef: string;
  readonly resultHash: string;
}
interface AttemptRow {
  readonly attemptId: string;
  readonly delegationId: string;
  readonly requestId: string;
  readonly requestHash: string;
  readonly provider: string;
  readonly bindingId: string;
  readonly assemblyId: string;
  readonly executionBindingId: string | null;
  readonly state: string;
  readonly revision: number;
  readonly recordJson: string;
}
export interface ExpertDelegationStoreShape {
  readonly readDelegation: (
    delegationId: string,
  ) => Effect.Effect<ExpertDelegation | null, ExpertDelegationStoreError>;
  readonly readAttempt: (
    attemptId: string,
  ) => Effect.Effect<ExpertDelegationAttempt | null, ExpertDelegationStoreError>;
  readonly readResult: (
    attemptId: string,
  ) => Effect.Effect<StoredExpertDelegationResult | null, ExpertDelegationStoreError>;
  readonly prepare: (input: {
    readonly delegation: ExpertDelegation;
    readonly attempt: ExpertDelegationAttempt;
  }) => Effect.Effect<
    { readonly delegation: ExpertDelegation; readonly attempt: ExpertDelegationAttempt },
    ExpertDelegationStoreError
  >;
  readonly transition: (
    attemptId: string,
    state: "starting" | "running" | "cancel-requested" | "unknown",
    updatedAt: string,
  ) => Effect.Effect<ExpertDelegationAttempt, ExpertDelegationStoreError>;
  readonly commitResult: (input: {
    readonly attemptId: string;
    readonly content: ExpertDelegationResultContent;
    readonly appliedEventId: string;
    readonly updatedAt: string;
  }) => Effect.Effect<StoredExpertDelegationResult, ExpertDelegationStoreError>;
  readonly recordConflict: (input: {
    readonly attemptId: string;
    readonly expectedHash: string;
    readonly receivedHash: string;
    readonly evidence: Readonly<Record<string, unknown>>;
  }) => Effect.Effect<void, ExpertDelegationStoreError>;
  readonly listForParent: (
    threadId: ThreadId,
  ) => Effect.Effect<readonly ExpertDelegationAttempt[], ExpertDelegationStoreError>;
}
export class ExpertDelegationStore extends ServiceMap.Service<
  ExpertDelegationStore,
  ExpertDelegationStoreShape
>()("synara/experts/ExpertDelegationStore") {}

export const makeExpertDelegationStore = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const decodeAttempt = (row: AttemptRow) => {
    const value = Schema.decodeUnknownSync(ExpertDelegationAttempt)(JSON.parse(row.recordJson));
    if (
      value.attemptId !== row.attemptId ||
      value.delegationId !== row.delegationId ||
      value.requestId !== row.requestId ||
      value.requestHash !== row.requestHash ||
      value.provider !== row.provider ||
      value.capabilityBindingId !== row.bindingId ||
      value.assemblyId !== row.assemblyId ||
      value.executionBindingId !== row.executionBindingId ||
      value.state !== row.state ||
      value.revision !== row.revision
    )
      throw new ExpertDelegationStoreError(
        "Expert delegation content is inconsistent.",
        "resource_corrupt",
      );
    return value;
  };
  const readAttemptRows = (
    attemptId: string,
  ) => sql<AttemptRow>`SELECT attempt_id AS "attemptId", delegation_id AS "delegationId",
    request_id AS "requestId", request_hash AS "requestHash", provider, capability_binding_id AS "bindingId",
    assembly_id AS "assemblyId", execution_binding_id AS "executionBindingId", state, revision, record_json AS "recordJson"
    FROM expert_delegation_attempts WHERE attempt_id = ${attemptId}`;
  const readDelegation: ExpertDelegationStoreShape["readDelegation"] = (id) =>
    guarded(
      Effect.gen(function* () {
        const [row] = yield* sql<{
          readonly threadId: string;
          readonly rootRunId: string;
          readonly expertId: string;
          readonly recordJson: string;
        }>`SELECT
      parent_thread_id AS "threadId", parent_root_run_id AS "rootRunId", target_expert_id AS "expertId", record_json AS "recordJson"
      FROM expert_delegations WHERE delegation_id = ${id}`;
        if (!row) return null;
        return yield* checked(() => {
          const value = Schema.decodeUnknownSync(ExpertDelegation)(JSON.parse(row.recordJson));
          if (
            value.delegationId !== id ||
            value.parentThreadId !== row.threadId ||
            value.parentRootRunId !== row.rootRunId ||
            value.targetExpertId !== row.expertId
          )
            throw new ExpertDelegationStoreError(
              "Expert delegation owner is inconsistent.",
              "resource_corrupt",
            );
          return value;
        });
      }),
    );
  const readAttempt: ExpertDelegationStoreShape["readAttempt"] = (id) =>
    guarded(
      Effect.gen(function* () {
        const [row] = yield* readAttemptRows(id);
        return row ? yield* checked(() => decodeAttempt(row)) : null;
      }),
    );
  const writeAttempt = (old: ExpertDelegationAttempt, next: ExpertDelegationAttempt) =>
    Effect.gen(function* () {
      yield* checked(() => Schema.decodeUnknownSync(ExpertDelegationAttempt)(next));
      yield* sql`UPDATE expert_delegation_attempts SET state = ${next.state}, revision = ${next.revision},
      record_json = ${canonicalSuiteJson(next)} WHERE attempt_id = ${old.attemptId} AND revision = ${old.revision}`;
      const stored = yield* readAttempt(old.attemptId);
      if (!stored || canonicalSuiteJson(stored) !== canonicalSuiteJson(next))
        return yield* Effect.fail(conflict());
    });
  const readResult: ExpertDelegationStoreShape["readResult"] = (attemptId) =>
    guarded(
      Effect.gen(function* () {
        const [row] = yield* sql<{
          readonly resultRef: string;
          readonly resultHash: string;
          readonly outcome: string;
          readonly recordJson: string;
        }>`SELECT
      result_ref AS "resultRef", result_hash AS "resultHash", outcome, record_json AS "recordJson"
      FROM expert_delegation_results WHERE attempt_id = ${attemptId}`;
        if (!row) return null;
        return yield* checked(() => {
          const content = Schema.decodeUnknownSync(ResultContent)(JSON.parse(row.recordJson));
          if (
            row.resultRef !== `ndr_${attemptId}` ||
            suiteContentDigest(content) !== row.resultHash ||
            content.outcome !== row.outcome
          )
            throw new ExpertDelegationStoreError(
              "Expert delegation result content is corrupt.",
              "resource_corrupt",
            );
          return { ...content, attemptId, resultRef: row.resultRef, resultHash: row.resultHash };
        });
      }),
    );
  const store: ExpertDelegationStoreShape = {
    readDelegation,
    readAttempt,
    readResult,
    prepare: (input) =>
      guarded(
        sql.withTransaction(
          Effect.gen(function* () {
            const { delegation, attempt } = yield* checked(() => ({
              delegation: Schema.decodeUnknownSync(ExpertDelegation)(input.delegation),
              attempt: Schema.decodeUnknownSync(ExpertDelegationAttempt)(input.attempt),
            }));
            if (
              attempt.delegationId !== delegation.delegationId ||
              attempt.state !== "prepared" ||
              attempt.revision !== 1 ||
              attempt.resultRef !== null ||
              attempt.resultHash !== null ||
              attempt.appliedEventId !== null
            )
              return yield* Effect.fail(conflict());
            const oldDelegation = yield* readDelegation(delegation.delegationId);
            if (
              oldDelegation &&
              canonicalSuiteJson(oldDelegation) !== canonicalSuiteJson(delegation)
            )
              return yield* Effect.fail(conflict());
            if (!oldDelegation)
              yield* sql`INSERT INTO expert_delegations(delegation_id, parent_thread_id, parent_root_run_id, target_expert_id, record_json)
        VALUES (${delegation.delegationId}, ${delegation.parentThreadId}, ${delegation.parentRootRunId}, ${delegation.targetExpertId}, ${canonicalSuiteJson(delegation)})`;
            const [matching] = yield* sql<{
              readonly attemptId: string;
            }>`SELECT attempt_id AS "attemptId" FROM expert_delegation_attempts
        WHERE delegation_id = ${delegation.delegationId} AND request_id = ${attempt.requestId}`;
            const old = yield* readAttempt(matching?.attemptId ?? attempt.attemptId);
            if (old) {
              if (
                old.delegationId !== attempt.delegationId ||
                old.requestId !== attempt.requestId ||
                old.requestHash !== attempt.requestHash ||
                old.provider !== attempt.provider
              )
                return yield* Effect.fail(conflict());
              return { delegation: oldDelegation ?? delegation, attempt: old };
            }
            yield* sql`INSERT INTO expert_delegation_attempts(attempt_id, delegation_id, request_id, request_hash, provider,
        capability_binding_id, assembly_id, execution_binding_id, state, revision, record_json) VALUES
        (${attempt.attemptId}, ${attempt.delegationId}, ${attempt.requestId}, ${attempt.requestHash}, ${attempt.provider},
         ${attempt.capabilityBindingId}, ${attempt.assemblyId}, ${attempt.executionBindingId}, ${attempt.state}, ${attempt.revision}, ${canonicalSuiteJson(attempt)})`;
            return { delegation, attempt };
          }),
        ),
      ),
    transition: (id, state, updatedAt) =>
      guarded(
        sql.withTransaction(
          Effect.gen(function* () {
            const old = yield* readAttempt(id);
            if (!old) return yield* Effect.fail(missing());
            if (old.state === state || terminal[old.state]) return old;
            if (!transitions[old.state].includes(state)) return yield* Effect.fail(conflict());
            const next = { ...old, state, revision: old.revision + 1, updatedAt };
            yield* writeAttempt(old, next);
            return next;
          }),
        ),
      ),
    commitResult: (input) =>
      guarded(
        Effect.gen(function* () {
          // The owning event transaction invokes this effect: no files, external
          // callbacks, new fibers or publication precede its SQL commit.
          const content = yield* checked(() =>
            Schema.decodeUnknownSync(ResultContent)(input.content),
          );
          const resultHash = suiteContentDigest(content);
          const old = yield* readAttempt(input.attemptId);
          if (!old) return yield* Effect.fail(missing());
          const resultRef = `ndr_${input.attemptId}`;
          const existing = yield* readResult(input.attemptId);
          if (existing) {
            if (
              existing.resultHash !== resultHash ||
              old.appliedEventId !== input.appliedEventId ||
              old.state !== content.outcome
            )
              return yield* Effect.fail(conflict());
            return existing;
          }
          if (
            old.resultRef !== null ||
            old.resultHash !== null ||
            old.appliedEventId !== null ||
            terminal[old.state]
          )
            return yield* Effect.fail(conflict());
          yield* sql`INSERT INTO expert_delegation_results(attempt_id, result_ref, result_hash, outcome, record_json)
        VALUES (${input.attemptId}, ${resultRef}, ${resultHash}, ${content.outcome}, ${canonicalSuiteJson(content)})`;
          const next = {
            ...old,
            state: content.outcome,
            revision: old.revision + 1,
            resultRef,
            resultHash,
            appliedEventId: input.appliedEventId,
            updatedAt: input.updatedAt,
          };
          yield* writeAttempt(old, next);
          return { ...content, attemptId: input.attemptId, resultRef, resultHash };
        }),
      ),
    recordConflict: (input) =>
      guarded(
        Effect.gen(function* () {
          yield* checked(() => {
            Schema.decodeUnknownSync(SuiteContentHash)(input.expectedHash);
            Schema.decodeUnknownSync(SuiteContentHash)(input.receivedHash);
          });
          yield* sql`INSERT INTO expert_delegation_conflicts(conflict_id, attempt_id, expected_hash, received_hash, evidence_json)
        VALUES (${randomUUID()}, ${input.attemptId}, ${input.expectedHash}, ${input.receivedHash}, ${canonicalSuiteJson(input.evidence)})`;
        }),
      ),
    listForParent: (threadId) =>
      guarded(
        Effect.gen(function* () {
          const rows = yield* sql<{
            readonly attemptId: string;
          }>`SELECT a.attempt_id AS "attemptId" FROM expert_delegation_attempts a
        JOIN expert_delegations d ON d.delegation_id = a.delegation_id WHERE d.parent_thread_id = ${threadId} ORDER BY a.attempt_id`;
          const records = yield* Effect.forEach(rows, ({ attemptId }) => readAttempt(attemptId));
          return records.filter((record): record is ExpertDelegationAttempt => record !== null);
        }),
      ),
  };
  return store;
});
export const ExpertDelegationStoreLive = Layer.effect(
  ExpertDelegationStore,
  makeExpertDelegationStore,
);
