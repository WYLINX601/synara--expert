import type { ExpertDelegation, ExpertDelegationAttempt, ThreadId } from "@synara/contracts";
import {
  OmpDelegationExecution,
  OmpNativeTaskAck,
  OmpNativeTaskEvent,
  type OmpNativeTaskStartedAck,
  type OmpNativeTaskStartedRequest,
} from "@synara/contracts/omp/expertDelegation";
import { Effect, Layer, Schema, ServiceMap } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import {
  NativeExecutionOwner,
  type NativeExecutionIdentity,
} from "../../agentGateway/Services/NativeExecutionOwner";
import {
  ExpertDelegationStore,
  ExpertDelegationStoreError,
  type ExpertDelegationResultContent,
} from "../../workbench/host/expertDelegationStore";
import { canonicalSuiteJson, suiteContentDigest } from "../../suites/suiteIdentity";

interface ExecutionRow {
  readonly executionBindingId: string;
  readonly attemptId: string;
  readonly parentThreadId: string;
  readonly parentGeneration: string;
  readonly parentTurnId: string;
  readonly toolCallId: string;
  readonly taskIndex: number;
  readonly nativeTaskId: string;
  readonly nativeSessionId: string | null;
  readonly lastSequence: number;
  readonly recordJson: string;
}
interface EventRow {
  readonly payloadHash: string;
  readonly eventJson: string;
  readonly receivedAt: string;
  readonly ackJson: string | null;
}
export class OmpExpertExecutionConflict extends ExpertDelegationStoreError {
  constructor(
    readonly attemptId: string,
    readonly expectedHash: string,
    readonly receivedHash: string,
    readonly evidence: Readonly<Record<string, unknown>>,
  ) {
    super(
      "Native Expert execution content conflicts with its durable identity.",
      "result_conflict",
    );
  }
}
export interface OmpExpertIngress {
  readonly event: OmpNativeTaskEvent;
  readonly receivedAt: string;
  readonly acknowledgement: OmpNativeTaskAck | null;
}
export interface OmpExpertExecutionStoreShape {
  readonly read: (
    attemptId: string,
  ) => Effect.Effect<OmpDelegationExecution | null, ExpertDelegationStoreError>;
  readonly isExecutionActive: (
    identity: NativeExecutionIdentity,
  ) => Effect.Effect<boolean, ExpertDelegationStoreError>;
  readonly findNative: (
    nativeTaskId: string,
  ) => Effect.Effect<OmpDelegationExecution | null, ExpertDelegationStoreError>;
  readonly findPreparation: (
    key: Pick<
      OmpDelegationExecution,
      "parentThreadId" | "parentGeneration" | "parentTurnId" | "toolCallId" | "taskIndex"
    >,
  ) => Effect.Effect<OmpDelegationExecution | null, ExpertDelegationStoreError>;
  readonly prepare: (input: {
    readonly execution: OmpDelegationExecution;
    readonly delegation: ExpertDelegation;
    readonly attempt: ExpertDelegationAttempt;
    /** SQL/in-memory checks only; runs inside the association's admission transaction. */
    readonly admission: Effect.Effect<boolean, unknown>;
    readonly previousUnknown?: {
      readonly attemptId: string;
      readonly revision: number;
      readonly requestHash: string;
    };
  }) => Effect.Effect<OmpDelegationExecution, ExpertDelegationStoreError>;
  readonly started: (
    input: OmpNativeTaskStartedRequest,
    updatedAt: string,
  ) => Effect.Effect<
    { readonly acknowledgement: OmpNativeTaskStartedAck; readonly mayRun: boolean },
    ExpertDelegationStoreError
  >;
  readonly receive: (
    input: OmpNativeTaskEvent,
    receivedAt: string,
  ) => Effect.Effect<OmpExpertIngress, ExpertDelegationStoreError>;
  readonly commitProgress: (
    ingress: OmpExpertIngress,
  ) => Effect.Effect<OmpNativeTaskAck, ExpertDelegationStoreError>;
  /** Called only inside the original result event/receipt transaction. */
  readonly commitTerminal: (
    ingress: OmpExpertIngress,
    appliedEventId: string,
  ) => Effect.Effect<OmpNativeTaskAck, ExpertDelegationStoreError>;
  readonly listForParent: (
    threadId: ThreadId,
    generation?: string,
  ) => Effect.Effect<readonly OmpDelegationExecution[], ExpertDelegationStoreError>;
  readonly pendingForParent: (
    threadId: ThreadId,
  ) => Effect.Effect<readonly OmpExpertIngress[], ExpertDelegationStoreError>;
}
export class OmpExpertExecutionStore extends ServiceMap.Service<
  OmpExpertExecutionStore,
  OmpExpertExecutionStoreShape
>()("synara/provider/omp/OmpExpertExecutionStore") {}
const storageFailure = (cause: unknown): ExpertDelegationStoreError =>
  cause instanceof ExpertDelegationStoreError
    ? cause
    : new ExpertDelegationStoreError(
        "Native Expert execution storage is unavailable.",
        "probe_error",
        { cause },
      );
const guarded = <A>(
  effect: Effect.Effect<A, unknown>,
): Effect.Effect<A, ExpertDelegationStoreError> => effect.pipe(Effect.mapError(storageFailure));
const checked = <A>(action: () => A) => Effect.try({ try: action, catch: storageFailure });
const missing = () =>
  new ExpertDelegationStoreError("The native execution cannot be verified.", "execution_unknown");

export const makeOmpExpertExecutionStore = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const common = yield* ExpertDelegationStore;
  const select = `SELECT execution_binding_id AS "executionBindingId", attempt_id AS "attemptId", parent_thread_id AS "parentThreadId",
    parent_generation AS "parentGeneration", parent_turn_id AS "parentTurnId", tool_call_id AS "toolCallId", task_index AS "taskIndex",
    native_task_id AS "nativeTaskId", native_session_id AS "nativeSessionId", last_sequence AS "lastSequence", record_json AS "recordJson"
    FROM omp_expert_execution_bindings`;
  const decode = (row: ExecutionRow) => {
    const execution = Schema.decodeUnknownSync(OmpDelegationExecution)(JSON.parse(row.recordJson));
    if (
      execution.executionBindingId !== row.executionBindingId ||
      execution.attemptId !== row.attemptId ||
      execution.parentThreadId !== row.parentThreadId ||
      execution.parentGeneration !== row.parentGeneration ||
      execution.parentTurnId !== row.parentTurnId ||
      execution.toolCallId !== row.toolCallId ||
      execution.taskIndex !== row.taskIndex ||
      execution.nativeTaskId !== row.nativeTaskId ||
      execution.nativeSessionId !== row.nativeSessionId ||
      execution.lastSequence !== row.lastSequence
    )
      throw new ExpertDelegationStoreError(
        "Native Expert execution association is inconsistent.",
        "resource_corrupt",
      );
    return execution;
  };
  const read: OmpExpertExecutionStoreShape["read"] = (id) =>
    guarded(
      Effect.gen(function* () {
        const [row] = yield* sql.unsafe<ExecutionRow>(`${select} WHERE attempt_id = ?`, [id]);
        return row ? yield* checked(() => decode(row)) : null;
      }),
    );
  const findPreparation: OmpExpertExecutionStoreShape["findPreparation"] = (key) =>
    guarded(
      Effect.gen(function* () {
        const [row] = yield* sql.unsafe<ExecutionRow>(
          `${select} WHERE parent_thread_id = ? AND parent_generation = ? AND parent_turn_id = ? AND tool_call_id = ? AND task_index = ?`,
          [
            key.parentThreadId,
            key.parentGeneration,
            key.parentTurnId,
            key.toolCallId,
            key.taskIndex,
          ],
        );
        return row ? yield* checked(() => decode(row)) : null;
      }),
    );
  const findNative: OmpExpertExecutionStoreShape["findNative"] = (nativeTaskId) =>
    guarded(
      Effect.gen(function* () {
        const [row] = yield* sql.unsafe<ExecutionRow>(`${select} WHERE native_task_id = ?`, [
          nativeTaskId,
        ]);
        return row ? yield* checked(() => decode(row)) : null;
      }),
    );
  const writeExecution = (old: OmpDelegationExecution, next: OmpDelegationExecution) =>
    Effect.gen(function* () {
      yield* checked(() => Schema.decodeUnknownSync(OmpDelegationExecution)(next));
      yield* sql`UPDATE omp_expert_execution_bindings SET native_session_id = ${next.nativeSessionId}, last_sequence = ${next.lastSequence},
      record_json = ${canonicalSuiteJson(next)} WHERE attempt_id = ${old.attemptId} AND last_sequence = ${old.lastSequence}`;
      const actual = yield* read(old.attemptId);
      if (!actual || canonicalSuiteJson(actual) !== canonicalSuiteJson(next))
        return yield* Effect.fail(missing());
    });
  const readEvent = (
    attemptId: string,
    sequence: number,
  ) => sql<EventRow>`SELECT payload_hash AS "payloadHash", event_json AS "eventJson",
    received_at AS "receivedAt", ack_json AS "ackJson" FROM omp_expert_task_events WHERE attempt_id = ${attemptId} AND sequence = ${sequence}`;
  const decodeIngress = (row: EventRow, attemptId: string, sequence: number): OmpExpertIngress => {
    const event = Schema.decodeUnknownSync(OmpNativeTaskEvent)(JSON.parse(row.eventJson));
    if (
      event.attemptId !== attemptId ||
      event.sequence !== sequence ||
      suiteContentDigest(event) !== row.payloadHash
    )
      throw new ExpertDelegationStoreError(
        "Native Expert ingress content is corrupt.",
        "resource_corrupt",
      );
    const acknowledgement =
      row.ackJson === null
        ? null
        : Schema.decodeUnknownSync(OmpNativeTaskAck)(JSON.parse(row.ackJson));
    if (
      acknowledgement &&
      (acknowledgement.attemptId !== attemptId || acknowledgement.sequence !== sequence)
    )
      throw new ExpertDelegationStoreError(
        "Native Expert acknowledgement is inconsistent.",
        "resource_corrupt",
      );
    return { event, receivedAt: row.receivedAt, acknowledgement };
  };
  const finishEvent = (ingress: OmpExpertIngress, acknowledgement: OmpNativeTaskAck) =>
    Effect.gen(function* () {
      const execution = yield* read(ingress.event.attemptId);
      if (!execution) return yield* Effect.fail(missing());
      const [stored] = yield* readEvent(ingress.event.attemptId, ingress.event.sequence);
      if (!stored) return yield* Effect.fail(missing());
      const current = yield* checked(() =>
        decodeIngress(stored, ingress.event.attemptId, ingress.event.sequence),
      );
      if (suiteContentDigest(current.event) !== suiteContentDigest(ingress.event))
        return yield* Effect.fail(missing());
      if (current.acknowledgement) return current.acknowledgement;
      if (execution.lastSequence + 1 !== ingress.event.sequence)
        return yield* Effect.fail(missing());
      yield* writeExecution(execution, { ...execution, lastSequence: ingress.event.sequence });
      yield* sql`UPDATE omp_expert_task_events SET ack_json = ${canonicalSuiteJson(acknowledgement)}
      WHERE attempt_id = ${ingress.event.attemptId} AND sequence = ${ingress.event.sequence} AND ack_json IS NULL`;
      return acknowledgement;
    });
  const store: OmpExpertExecutionStoreShape = {
    read,
    findNative,
    findPreparation,
    isExecutionActive: (identity) =>
      guarded(
        sql.withTransaction(
          Effect.gen(function* () {
            if (identity.provider !== "omp") return false;
            const execution = yield* read(identity.attemptId);
            const attempt = yield* common.readAttempt(identity.attemptId);
            if (
              !execution ||
              !attempt ||
              execution.nativeSessionId === null ||
              execution.executionBindingId !== identity.executionBindingId ||
              execution.parentThreadId !== identity.threadId ||
              attempt.provider !== identity.provider ||
              attempt.state !== "running" ||
              attempt.executionBindingId !== execution.executionBindingId ||
              attempt.capabilityBindingId !== identity.capabilityBindingId ||
              attempt.assemblyId !== identity.assemblyId
            )
              return false;
            const delegation = yield* common.readDelegation(attempt.delegationId);
            if (
              !delegation ||
              delegation.parentThreadId !== execution.parentThreadId ||
              delegation.parentRootRunId !== identity.parentRootRunId
            )
              return false;
            const [runtime] = yield* sql<{ readonly generation: string; readonly status: string }>`
        SELECT lifecycle_generation AS generation, status FROM provider_session_runtime
        WHERE thread_id = ${execution.parentThreadId} AND provider_name = 'omp'`;
            return (
              runtime?.generation === execution.parentGeneration &&
              runtime.status !== "stopped" &&
              runtime.status !== "error"
            );
          }),
        ),
      ),
    prepare: (input) =>
      guarded(
        sql.withTransaction(
          Effect.gen(function* () {
            const execution = yield* checked(() =>
              Schema.decodeUnknownSync(OmpDelegationExecution)(input.execution),
            );
            if (
              execution.attemptId !== input.attempt.attemptId ||
              execution.executionBindingId !== input.attempt.executionBindingId ||
              execution.parentThreadId !== input.delegation.parentThreadId ||
              input.attempt.provider !== "omp" ||
              execution.lastSequence !== 0 ||
              execution.nativeSessionId !== null
            )
              return yield* Effect.fail(
                new ExpertDelegationStoreError(
                  "Prepared native association is invalid.",
                  "result_conflict",
                ),
              );
            const existing = yield* findPreparation(execution);
            if (existing) {
              const oldAttempt = yield* common.readAttempt(existing.attemptId);
              if (
                !oldAttempt ||
                oldAttempt.requestId !== input.attempt.requestId ||
                oldAttempt.requestHash !== input.attempt.requestHash ||
                existing.nativeTaskId !== execution.nativeTaskId ||
                existing.deliveryMode !== execution.deliveryMode
              )
                return yield* Effect.fail(
                  new OmpExpertExecutionConflict(
                    existing.attemptId,
                    suiteContentDigest({
                      requestId: oldAttempt?.requestId,
                      requestHash: oldAttempt?.requestHash,
                      nativeTaskId: existing.nativeTaskId,
                      deliveryMode: existing.deliveryMode,
                    }),
                    suiteContentDigest({
                      requestId: input.attempt.requestId,
                      requestHash: input.attempt.requestHash,
                      nativeTaskId: execution.nativeTaskId,
                      deliveryMode: execution.deliveryMode,
                    }),
                    { kind: "prepare" },
                  ),
                );
              return existing;
            }
            const other = yield* findNative(execution.nativeTaskId);
            if (other)
              return yield* Effect.fail(
                new OmpExpertExecutionConflict(
                  other.attemptId,
                  suiteContentDigest(other),
                  suiteContentDigest(execution),
                  { kind: "native-task-reuse" },
                ),
              );
            if (!(yield* input.admission)) return yield* Effect.fail(missing());
            const [latest] = yield* sql<{
              readonly attemptId: string;
            }>`SELECT attempt_id AS "attemptId" FROM expert_delegation_attempts
        WHERE delegation_id = ${input.delegation.delegationId} ORDER BY rowid DESC LIMIT 1`;
            if (latest && latest.attemptId !== input.previousUnknown?.attemptId)
              return yield* Effect.fail(
                new ExpertDelegationStoreError(
                  "Another attempt already owns this delegation; explicit unknown-attempt approval is required.",
                  "revision_conflict",
                ),
              );
            if (input.previousUnknown) {
              const previous = yield* common.readAttempt(input.previousUnknown.attemptId);
              if (
                !previous ||
                previous.delegationId !== input.delegation.delegationId ||
                previous.provider !== "omp" ||
                previous.state !== "unknown" ||
                previous.revision !== input.previousUnknown.revision ||
                previous.requestHash !== input.previousUnknown.requestHash ||
                previous.requestHash !== input.attempt.requestHash ||
                previous.resultRef !== null ||
                previous.resultHash !== null ||
                previous.appliedEventId !== null
              )
                return yield* Effect.fail(
                  new ExpertDelegationStoreError(
                    "The approved unknown attempt changed before admission.",
                    "revision_conflict",
                  ),
                );
            }
            const prepared = yield* common.prepare({
              delegation: input.delegation,
              attempt: input.attempt,
            });
            if (prepared.attempt.attemptId !== execution.attemptId)
              return yield* Effect.fail(missing());
            yield* sql`INSERT INTO omp_expert_execution_bindings(execution_binding_id, attempt_id, parent_thread_id, parent_generation,
        parent_turn_id, tool_call_id, task_index, native_task_id, native_session_id, last_sequence, record_json) VALUES
        (${execution.executionBindingId}, ${execution.attemptId}, ${execution.parentThreadId}, ${execution.parentGeneration},
         ${execution.parentTurnId}, ${execution.toolCallId}, ${execution.taskIndex}, ${execution.nativeTaskId}, NULL, 0, ${canonicalSuiteJson(execution)})`;
            return execution;
          }),
        ),
      ),
    started: (input, updatedAt) =>
      guarded(
        sql.withTransaction(
          Effect.gen(function* () {
            const execution = yield* read(input.attemptId);
            const attempt = yield* common.readAttempt(input.attemptId);
            if (
              !execution ||
              !attempt ||
              execution.nativeTaskId !== input.nativeTaskId ||
              execution.parentGeneration !== input.parentGeneration
            )
              return yield* Effect.fail(missing());
            // Replaying a started frame is not authority to resurrect an unknown,
            // cancelled or terminal execution, even if its actual session still exists.
            if (attempt.state !== "starting" && attempt.state !== "running")
              return yield* Effect.fail(missing());
            if (
              input.initializationComplete === true &&
              (execution.nativeSessionId !== input.nativeSessionId || attempt.state !== "running")
            )
              return yield* Effect.fail(missing());
            if (execution.nativeSessionId && execution.nativeSessionId !== input.nativeSessionId)
              return yield* Effect.fail(
                new OmpExpertExecutionConflict(
                  input.attemptId,
                  suiteContentDigest(execution.nativeSessionId),
                  suiteContentDigest(input.nativeSessionId),
                  { kind: "started-session" },
                ),
              );
            const [other] = yield* sql<{
              readonly attemptId: string;
            }>`SELECT attempt_id AS "attemptId" FROM omp_expert_execution_bindings
        WHERE native_session_id = ${input.nativeSessionId} AND attempt_id <> ${input.attemptId}`;
            if (other)
              return yield* Effect.fail(
                new OmpExpertExecutionConflict(
                  input.attemptId,
                  suiteContentDigest(other.attemptId),
                  suiteContentDigest(input.attemptId),
                  { kind: "session-reuse" },
                ),
              );
            const duplicate = execution.nativeSessionId !== null;
            if (!duplicate)
              yield* writeExecution(execution, {
                ...execution,
                nativeSessionId: input.nativeSessionId,
              });
            const mayRun = attempt.state === "starting" || attempt.state === "running";
            if (mayRun && attempt.state !== "running")
              yield* common.transition(input.attemptId, "running", updatedAt);
            return {
              acknowledgement: {
                attemptId: input.attemptId,
                nativeTaskId: input.nativeTaskId,
                nativeSessionId: input.nativeSessionId,
                disposition: duplicate ? "duplicate" : "accepted",
              },
              mayRun,
            };
          }),
        ),
      ),
    receive: (input, receivedAt) =>
      guarded(
        sql.withTransaction(
          Effect.gen(function* () {
            const event = yield* checked(() => Schema.decodeUnknownSync(OmpNativeTaskEvent)(input));
            const execution = yield* read(event.attemptId);
            const attempt = yield* common.readAttempt(event.attemptId);
            if (
              !execution ||
              !attempt ||
              execution.nativeTaskId !== event.nativeTaskId ||
              execution.parentGeneration !== event.parentGeneration
            )
              return yield* Effect.fail(missing());
            const hash = suiteContentDigest(event);
            const [old] = yield* readEvent(event.attemptId, event.sequence);
            if (old) {
              if (old.payloadHash !== hash)
                return yield* Effect.fail(
                  new OmpExpertExecutionConflict(event.attemptId, old.payloadHash, hash, {
                    kind: "sequence",
                    sequence: event.sequence,
                  }),
                );
              return yield* checked(() => decodeIngress(old, event.attemptId, event.sequence));
            }
            if (attempt.resultRef !== null || event.sequence !== execution.lastSequence + 1)
              return yield* Effect.fail(
                new ExpertDelegationStoreError(
                  `Native task event cannot be applied; expected sequence ${execution.lastSequence + 1}.`,
                  "probe_error",
                ),
              );
            if (execution.nativeSessionId === null) return yield* Effect.fail(missing());
            yield* sql`INSERT INTO omp_expert_task_events(attempt_id, sequence, payload_hash, event_json, received_at, ack_json)
        VALUES (${event.attemptId}, ${event.sequence}, ${hash}, ${canonicalSuiteJson(event)}, ${receivedAt}, NULL)`;
            if (event.payload.kind === "terminal" && attempt.state !== "cancel-requested") {
              // The execution has ended but its result is not yet version-pinned and
              // published. Retire tool admission before any filesystem preparation.
              yield* common.transition(event.attemptId, "unknown", receivedAt);
            }
            return { event, receivedAt, acknowledgement: null };
          }),
        ),
      ),
    commitProgress: (ingress) =>
      guarded(
        sql.withTransaction(
          Effect.gen(function* () {
            if (ingress.event.payload.kind !== "progress") return yield* Effect.fail(missing());
            return yield* finishEvent(ingress, {
              attemptId: ingress.event.attemptId,
              sequence: ingress.event.sequence,
              disposition: "accepted",
              resultRef: null,
              resultHash: null,
            });
          }),
        ),
      ),
    commitTerminal: (ingress, appliedEventId) =>
      guarded(
        Effect.gen(function* () {
          if (ingress.event.payload.kind !== "terminal") return yield* Effect.fail(missing());
          const content: ExpertDelegationResultContent = {
            outcome: ingress.event.payload.outcome,
            result: ingress.event.payload.result,
            issue: ingress.event.payload.issue,
          };
          const result = yield* common.commitResult({
            attemptId: ingress.event.attemptId,
            content,
            appliedEventId,
            updatedAt: ingress.receivedAt,
          });
          return yield* finishEvent(ingress, {
            attemptId: ingress.event.attemptId,
            sequence: ingress.event.sequence,
            disposition: "accepted",
            resultRef: result.resultRef,
            resultHash: result.resultHash,
          });
        }),
      ),
    listForParent: (threadId, generation) =>
      guarded(
        Effect.gen(function* () {
          const rows = yield* sql.unsafe<ExecutionRow>(
            `${select} WHERE parent_thread_id = ?${generation === undefined ? "" : " AND parent_generation = ?"} ORDER BY attempt_id`,
            generation === undefined ? [threadId] : [threadId, generation],
          );
          return yield* checked(() => rows.map(decode));
        }),
      ),
    pendingForParent: (threadId) =>
      guarded(
        Effect.gen(function* () {
          const rows = yield* sql<
            EventRow & { readonly attemptId: string; readonly sequence: number }
          >`SELECT e.attempt_id AS "attemptId", e.sequence,
        e.payload_hash AS "payloadHash", e.event_json AS "eventJson", e.received_at AS "receivedAt", e.ack_json AS "ackJson"
        FROM omp_expert_task_events e JOIN omp_expert_execution_bindings b ON b.attempt_id = e.attempt_id
        WHERE b.parent_thread_id = ${threadId} AND e.ack_json IS NULL ORDER BY e.attempt_id, e.sequence`;
          return yield* checked(() =>
            rows.map((row) => decodeIngress(row, row.attemptId, row.sequence)),
          );
        }),
      ),
  };
  return store;
});
export const OmpExpertExecutionStoreLive = Layer.effect(
  OmpExpertExecutionStore,
  makeOmpExpertExecutionStore,
);

/** Adapt the existing private owner; never construct a second execution store for Gateway. */
export const OmpNativeExecutionOwnerLive = Layer.effect(
  NativeExecutionOwner,
  Effect.gen(function* () {
    const executions = yield* OmpExpertExecutionStore;
    return { isExecutionActive: executions.isExecutionActive };
  }),
);
