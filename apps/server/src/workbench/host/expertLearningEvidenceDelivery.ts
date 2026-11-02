import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  ExpertLearningEvidenceItem,
  ProviderRuntimeEvent,
  ThreadId,
  TurnId,
} from "@synara/contracts";
import { Cause, Duration, Effect, Option, Schema } from "effect";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import {
  isLearningEvidenceRelevantEvent,
  learningEvidenceDeltaFromRuntimeEvent,
  mergeLearningEvidenceItems,
} from "../../experts/evolution/LearningEvidence.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import type { PersistedProviderRuntimeEvent } from "../../persistence/Services/ProviderRuntimeEvents.ts";
import { ExpertAppliedRuntimeRepository } from "../../persistence/Services/ExpertAppliedRuntimeRecords.ts";
import type { ExpertLearningEvidenceCapture } from "./expertLearningEvidence.ts";

const Source = Schema.Struct({
  expertId: Schema.String,
  snapshotId: Schema.String,
  projectId: Schema.String,
  spaceId: Schema.optional(Schema.String),
  instanceId: Schema.optional(Schema.String),
});
const Packet = Schema.Struct({
  sequence: Schema.Number,
  event: ProviderRuntimeEvent,
  turnId: TurnId,
  items: Schema.Array(ExpertLearningEvidenceItem).check(Schema.isMaxLength(128)),
  coverage: Schema.Array(Schema.String).check(Schema.isMaxLength(32)),
  modelEvent: Schema.optional(ProviderRuntimeEvent),
  effort: Schema.optional(Schema.String),
  appliedIdentity: Schema.optional(
    Schema.Struct({
      threadId: ThreadId,
      snapshotId: Schema.String,
      provider: Schema.Literals(["claudeAgent", "codex", "omp", "pi"]),
      model: Schema.optional(Schema.String),
      lifecycleGeneration: Schema.String,
      skillApplication: Schema.optional(
        Schema.Struct({
          snapshotId: Schema.String,
          lifecycleGeneration: Schema.String,
          skillRootRunId: Schema.optional(Schema.String),
          skillAssemblyId: Schema.optional(Schema.String),
        }),
      ),
    }),
  ),
});
type Packet = typeof Packet.Type;
type PendingRow = {
  readonly capture_id: string;
  readonly source_json: string;
  readonly record_json: string;
  readonly last_sequence: number;
  readonly first_sequence: number;
  readonly discarded: number;
};

/** Retain event identity and model facts; tool/error text lives only in the scrubbed delta. */
function carrier(event: ProviderRuntimeEvent): ProviderRuntimeEvent {
  const identity = {
    eventId: event.eventId,
    provider: event.provider,
    threadId: event.threadId,
    createdAt: event.createdAt,
    ...(event.providerInstanceId ? { providerInstanceId: event.providerInstanceId } : {}),
    ...(event.turnId ? { turnId: event.turnId } : {}),
    ...(event.itemId ? { itemId: event.itemId } : {}),
    ...(event.lifecycleGeneration ? { lifecycleGeneration: event.lifecycleGeneration } : {}),
  };
  switch (event.type) {
    case "turn.started":
      return {
        ...identity,
        type: event.type,
        payload: {
          ...(event.payload.model !== undefined ? { model: event.payload.model } : {}),
          ...(event.payload.effort !== undefined ? { effort: event.payload.effort } : {}),
        },
      };
    case "item.started":
    case "item.updated":
    case "item.completed":
      return { ...identity, type: event.type, payload: { itemType: event.payload.itemType } };
    case "turn.completed":
      return { ...identity, type: event.type, payload: { state: event.payload.state } };
    case "model.rerouted":
      return {
        ...identity,
        type: event.type,
        payload: {
          fromModel: event.payload.fromModel,
          toModel: event.payload.toModel,
          reason: "See bounded evidence delta.",
        },
      };
    case "runtime.error":
    case "runtime.warning":
      return { ...identity, type: event.type, payload: { message: "See bounded evidence delta." } };
    case "turn.aborted":
      return { ...identity, type: event.type, payload: { reason: "See bounded evidence delta." } };
    default:
      throw new Error("Unsupported learning evidence carrier.");
  }
}

/**
 * The business consumer durably hands off bounded turn evidence before acknowledging
 * its journal row. Learning reads/writes then retry independently of chat projection.
 * One row coalesces a turn, and its source tombstone prevents later reattribution.
 */
export const makeExpertLearningEvidenceDelivery = (capture: ExpertLearningEvidenceCapture) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const projection = yield* ProjectionSnapshotQuery;
    const appliedRepository = yield* Effect.serviceOption(ExpertAppliedRuntimeRepository);
    const lock = yield* Semaphore.make(1);
    let visitedThrough = 0;

    const readSource = (event: ProviderRuntimeEvent) =>
      Effect.gen(function* () {
        const shell = Option.getOrUndefined(yield* projection.getThreadShellById(event.threadId));
        if (!shell?.expertBinding) return undefined;
        const project = Option.getOrUndefined(
          yield* projection.getProjectShellById(shell.projectId),
        );
        if (!project) throw new Error("Learning source project is unavailable.");
        const instanceId =
          (shell.session?.providerName === event.provider
            ? shell.session.providerInstanceId
            : undefined) ??
          shell.modelSelection.instanceId ??
          event.providerInstanceId;
        return {
          expertId: shell.expertBinding.expertId,
          snapshotId: shell.expertBinding.snapshotId,
          projectId: shell.projectId,
          ...(project.spaceId ? { spaceId: project.spaceId } : {}),
          ...(instanceId ? { instanceId } : {}),
        };
      });

    const enqueue: ExpertLearningEvidenceCapture = (entry, turnId) =>
      Effect.gen(function* () {
        const event = entry.event;
        if (
          !turnId ||
          (event.provider !== "omp" && event.provider !== "pi") ||
          !isLearningEvidenceRelevantEvent(event)
        )
          return;
        let delta;
        try {
          delta = learningEvidenceDeltaFromRuntimeEvent(entry);
        } catch {
          yield* Effect.logWarning("learning evidence metadata is malformed", {
            eventId: event.eventId,
          });
          return;
        }
        if (
          delta.items.length === 0 &&
          event.type !== "turn.started" &&
          event.type !== "turn.completed" &&
          event.type !== "model.rerouted"
        )
          return;
        const captureId = createHash("sha256")
          .update(
            JSON.stringify([event.threadId, turnId, event.provider, event.lifecycleGeneration]),
          )
          .digest("hex");
        const source = yield* readSource(event).pipe(
          Effect.catchCause((cause) => {
            if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause);
            return Effect.logWarning("learning evidence source unavailable at handoff", {
              eventId: event.eventId,
              cause: Cause.pretty(cause),
            }).pipe(Effect.as(null));
          }),
        );
        if (source === undefined) return;
        const applied = Option.isSome(appliedRepository)
          ? Option.getOrUndefined(
              yield* appliedRepository.value.getByThreadId({ threadId: event.threadId }).pipe(
                Effect.catchCause((cause) => {
                  if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause);
                  return Effect.logWarning("learning applied identity unavailable at handoff", {
                    eventId: event.eventId,
                    cause: Cause.pretty(cause),
                  }).pipe(Effect.as(Option.none()));
                }),
              ),
            )
          : undefined;
        const appliedUnavailable =
          Option.isSome(appliedRepository) &&
          (!applied ||
            !source ||
            applied.snapshotId !== source.snapshotId ||
            applied.provider !== event.provider ||
            applied.lifecycleGeneration !== event.lifecycleGeneration);
        if (source !== null) {
          const enabled = yield* sql`SELECT 1 FROM expert_learning_states
            WHERE expert_id = ${source.expertId}
              AND CASE WHEN json_valid(record_json) THEN json_extract(record_json, '$.state.enabled') END = 1
              AND CASE WHEN json_valid(record_json) THEN json_extract(record_json, '$.state.harnessKind') END = ${event.provider}
            LIMIT 1`.pipe(
            Effect.map((rows) => rows.length > 0),
            Effect.catchCause((cause) => {
              if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause);
              // Unknown is only a retryable handoff, never permission to learn.
              return Effect.logWarning("learning state unavailable at evidence handoff", {
                eventId: event.eventId,
                cause: Cause.pretty(cause),
              }).pipe(Effect.as(undefined));
            }),
          );
          if (enabled === false) return;
        }
        if (
          source?.instanceId &&
          event.providerInstanceId &&
          source.instanceId !== event.providerInstanceId
        )
          return;
        yield* sql.withTransaction(
          Effect.gen(function* () {
            const rows = yield* sql<PendingRow>`SELECT * FROM expert_learning_pending_evidence
              WHERE capture_id = ${captureId}`;
            const previous = rows[0];
            if (previous && (previous.last_sequence >= entry.sequence || previous.discarded))
              return;
            const sourceJson = JSON.stringify(source);
            const discard = () => sql`INSERT INTO expert_learning_pending_evidence
              (capture_id, source_json, record_json, first_sequence, last_sequence, pending, discarded, updated_at)
              VALUES (${captureId}, ${previous?.source_json ?? sourceJson}, '{}', ${entry.sequence}, ${entry.sequence}, 0, 1, ${event.createdAt})
              ON CONFLICT(capture_id) DO UPDATE SET record_json = '{}', pending = 0, discarded = 1,
                last_sequence = excluded.last_sequence, updated_at = excluded.updated_at`;
            if (source === null || (previous && previous.source_json !== sourceJson)) {
              yield* discard();
              return;
            }
            let old: Packet | undefined;
            try {
              old =
                previous?.record_json !== "{}" && previous
                  ? Schema.decodeUnknownSync(Packet)(JSON.parse(previous.record_json))
                  : undefined;
            } catch {
              yield* discard();
              yield* Effect.logWarning("learning evidence handoff record is malformed", {
                captureId,
              });
              return;
            }
            const merged = mergeLearningEvidenceItems(old?.items ?? [], delta.items);
            const labels = [
              ...new Set([
                ...(old?.coverage ?? []),
                ...delta.coverage,
                ...(merged.truncated ? ["items-truncated"] : []),
              ]),
            ];
            const packet: Packet = {
              sequence: entry.sequence,
              event: old?.event.type === "turn.completed" ? old.event : carrier(event),
              turnId,
              ...(old?.appliedIdentity
                ? { appliedIdentity: old.appliedIdentity }
                : applied && !appliedUnavailable
                  ? {
                      appliedIdentity: {
                        threadId: applied.threadId,
                        snapshotId: applied.snapshotId,
                        provider: applied.provider,
                        lifecycleGeneration: applied.lifecycleGeneration,
                        ...(applied.model !== undefined ? { model: applied.model } : {}),
                        ...(applied.skillApplication
                          ? {
                              skillApplication: {
                                snapshotId: applied.skillApplication.snapshotId,
                                lifecycleGeneration: applied.skillApplication.lifecycleGeneration,
                                ...(applied.skillApplication.skillRootRunId
                                  ? { skillRootRunId: applied.skillApplication.skillRootRunId }
                                  : {}),
                                ...(applied.skillApplication.skillAssemblyId
                                  ? { skillAssemblyId: applied.skillApplication.skillAssemblyId }
                                  : {}),
                              },
                            }
                          : {}),
                      },
                    }
                  : {}),
              items: merged.items,
              coverage:
                labels.length <= 32 ? labels : [...labels.slice(0, 31), "coverage-truncated"],
              ...(event.type === "turn.started" || event.type === "model.rerouted"
                ? { modelEvent: carrier(event) }
                : old?.modelEvent
                  ? { modelEvent: old.modelEvent }
                  : {}),
              ...((event.type === "turn.started" ? event.payload.effort : old?.effort)
                ? { effort: event.type === "turn.started" ? event.payload.effort : old!.effort! }
                : {}),
            };
            if (Option.isSome(appliedRepository) && !packet.appliedIdentity) {
              yield* discard();
              yield* Effect.logWarning("learning evidence has no fixed applied identity", {
                captureId,
              });
              return;
            }
            yield* sql`INSERT INTO expert_learning_pending_evidence
              (capture_id, source_json, record_json, first_sequence, last_sequence, pending, discarded, updated_at)
              VALUES (${captureId}, ${sourceJson}, ${JSON.stringify(packet)}, ${entry.sequence}, ${entry.sequence}, 1, 0, ${event.createdAt})
              ON CONFLICT(capture_id) DO UPDATE SET record_json = excluded.record_json,
                last_sequence = excluded.last_sequence, pending = 1, updated_at = excluded.updated_at`;
          }),
        );
      });

    const drain = lock
      .withPermits(1)(
        Effect.gen(function* () {
          const readPage = () => sql<PendingRow>`SELECT * FROM expert_learning_pending_evidence
            WHERE pending = 1 AND first_sequence > ${visitedThrough}
            ORDER BY first_sequence, capture_id LIMIT 32`;
          let rows = yield* readPage();
          if (rows.length === 0 && visitedThrough > 0) {
            visitedThrough = 0;
            rows = yield* readPage();
          }
          for (const row of rows) {
            visitedThrough = row.first_sequence;
            yield* Effect.gen(function* () {
              const packet = Schema.decodeUnknownSync(Packet)(JSON.parse(row.record_json));
              const source = Schema.decodeUnknownSync(Source)(JSON.parse(row.source_json));
              if (
                packet.modelEvent &&
                ((packet.modelEvent.type !== "turn.started" &&
                  packet.modelEvent.type !== "model.rerouted") ||
                  packet.modelEvent.threadId !== packet.event.threadId ||
                  packet.modelEvent.provider !== packet.event.provider ||
                  packet.modelEvent.lifecycleGeneration !== packet.event.lifecycleGeneration ||
                  (packet.modelEvent.turnId !== undefined &&
                    packet.modelEvent.turnId !== packet.turnId) ||
                  (packet.modelEvent.providerInstanceId &&
                    source.instanceId &&
                    packet.modelEvent.providerInstanceId !== source.instanceId))
              )
                throw new Error("Deferred learning model identity does not match its turn.");
              const current = yield* readSource(packet.event);
              if (!isDeepStrictEqual(source, current)) {
                yield* sql`UPDATE expert_learning_pending_evidence SET pending = 0, discarded = 1,
              record_json = '{}' WHERE capture_id = ${row.capture_id} AND last_sequence = ${row.last_sequence}`;
                yield* Effect.logWarning("learning evidence source changed before capture", {
                  eventId: packet.event.eventId,
                });
                return;
              }
              const entry: PersistedProviderRuntimeEvent = {
                sequence: packet.sequence,
                event: packet.event,
              };
              const result = yield* capture(entry, packet.turnId, {
                delta: { items: packet.items, coverage: packet.coverage },
                source,
                ...(packet.modelEvent ? { modelEvent: packet.modelEvent } : {}),
                ...(packet.effort ? { effort: packet.effort } : {}),
                ...(packet.appliedIdentity ? { appliedIdentity: packet.appliedIdentity } : {}),
              }).pipe(Effect.timeoutOption(Duration.seconds(2)));
              if (Option.isNone(result)) throw new Error("Learning evidence capture timed out.");
              // An enqueue during capture owns the newer packet and cannot be cleared here.
              const retained = JSON.stringify({ ...packet, items: [], coverage: [] });
              yield* sql`UPDATE expert_learning_pending_evidence SET pending = 0, record_json = ${retained}
            WHERE capture_id = ${row.capture_id} AND last_sequence = ${row.last_sequence}`;
            }).pipe(
              Effect.catchCause((cause) => {
                if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause);
                return Effect.logWarning("learning evidence capture deferred for retry", {
                  captureId: row.capture_id,
                  cause: Cause.pretty(cause),
                }).pipe(
                  Effect.andThen(sql`UPDATE expert_learning_pending_evidence
            SET updated_at = ${new Date().toISOString()}
            WHERE capture_id = ${row.capture_id} AND last_sequence = ${row.last_sequence}`),
                );
              }),
            );
          }
        }),
      )
      .pipe(
        Effect.catchCause((cause) => {
          if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause);
          return Effect.logWarning("learning evidence delivery unavailable", {
            cause: Cause.pretty(cause),
          });
        }),
      );
    const run = Effect.gen(function* () {
      while (true) {
        yield* drain;
        yield* Effect.sleep(Duration.seconds(1));
      }
    });
    return { enqueue, drain, run };
  });
