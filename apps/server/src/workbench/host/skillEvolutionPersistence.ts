import { ModelSelection, SkillEvolutionEvent, type ThreadId } from "@synara/contracts";
import { Effect, Layer, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import {
  SkillEvolutionRepository,
  type SkillEvolutionRepositoryShape,
  type EvolutionStoredRow,
} from "../../experts/evolution/SkillEvolutionRepository";

const ExecutionIdentity = Schema.Struct({
  requestId: Schema.String,
  ownerId: Schema.String,
  run: Schema.Struct({ modelSelection: ModelSelection }),
});

export const makeSkillEvolutionRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  type Row = {
    readonly request_id: string;
    readonly expert_id: string;
    readonly task_thread_id: string;
    readonly record_json: string;
    readonly updated_at: string;
  };
  const fromRow = (row: Row): EvolutionStoredRow => ({
    requestId: row.request_id,
    expertId: row.expert_id,
    taskThreadId: row.task_thread_id,
    record: row.record_json,
    updatedAt: row.updated_at,
  });
  const read = (requestId: string) =>
    sql
      .unsafe<Row>("SELECT * FROM expert_skill_evolution_requests WHERE request_id = ?", [
        requestId,
      ])
      .pipe(Effect.map((rows) => (rows[0] ? fromRow(rows[0]) : undefined)));
  return {
    read,
    list: (expertId?: string) =>
      (expertId === undefined
        ? sql.unsafe<Row>("SELECT * FROM expert_skill_evolution_requests ORDER BY updated_at DESC")
        : sql.unsafe<Row>(
            "SELECT * FROM expert_skill_evolution_requests WHERE expert_id = ? ORDER BY updated_at DESC",
            [expertId],
          )
      ).pipe(Effect.map((rows) => rows.map(fromRow))),
    write: (row: EvolutionStoredRow) =>
      sql
        .unsafe<{ readonly request_id: string }>(
          "INSERT INTO expert_skill_evolution_requests (request_id, expert_id, task_thread_id, record_json, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(request_id) DO UPDATE SET record_json = excluded.record_json, updated_at = excluded.updated_at WHERE expert_skill_evolution_requests.expert_id = excluded.expert_id AND expert_skill_evolution_requests.task_thread_id = excluded.task_thread_id RETURNING request_id",
          [row.requestId, row.expertId, row.taskThreadId, row.record, row.updatedAt],
        )
        .pipe(
          Effect.flatMap((rows) =>
            rows.length === 1
              ? Effect.void
              : Effect.fail(new Error("提炼请求身份已经固定，不能替换其专家或原生任务。")),
          ),
        ),
    appendEvent: (event: SkillEvolutionEvent) =>
      sql
        .unsafe(
          "INSERT INTO expert_skill_evolution_events (event_id, expert_id, skill_id, record_json, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(event_id) DO NOTHING",
          [event.eventId, event.expertId, event.skillId, JSON.stringify(event), event.createdAt],
        )
        .pipe(Effect.asVoid),
    events: () =>
      sql
        .unsafe<{ readonly record_json: string }>(
          "SELECT record_json FROM expert_skill_evolution_events ORDER BY created_at, event_id",
        )
        .pipe(
          Effect.flatMap((rows) =>
            Effect.try({
              try: () =>
                rows.map((row) =>
                  Schema.decodeUnknownSync(SkillEvolutionEvent)(JSON.parse(row.record_json)),
                ),
              catch: (cause) => cause,
            }),
          ),
        ),
    execution: (threadId: ThreadId) =>
      sql
        .unsafe<{ readonly record_json: string }>(
          "SELECT record_json FROM expert_skill_evolution_requests WHERE task_thread_id = ?",
          [threadId],
        )
        .pipe(
          Effect.flatMap((rows) =>
            Effect.try({
              try: () => {
                if (!rows[0]) return undefined;
                const value = Schema.decodeUnknownSync(ExecutionIdentity)(
                  JSON.parse(rows[0].record_json),
                );
                return {
                  requestId: value.requestId,
                  ownerId: value.ownerId,
                  modelSelection: value.run.modelSelection,
                };
              },
              catch: (cause) => cause,
            }),
          ),
        ),
  } satisfies SkillEvolutionRepositoryShape;
});
export const SkillEvolutionRepositoryLive = Layer.effect(
  SkillEvolutionRepository,
  makeSkillEvolutionRepository,
);
