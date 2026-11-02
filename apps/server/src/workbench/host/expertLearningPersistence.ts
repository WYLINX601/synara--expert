import { ExpertLearningEvidence } from "@synara/contracts";
import { Effect, Layer, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import {
  ExpertLearningRepository,
  type ExpertLearningRepositoryShape,
  type LearningCycleRow,
  type LearningEvidenceRow,
  type LearningStateRow,
} from "../../experts/evolution/ExpertLearningRepository";

const decodeEvidenceRow = (row: LearningEvidenceRow): LearningEvidenceRow => {
  const evidence = Schema.decodeUnknownSync(ExpertLearningEvidence)(JSON.parse(row.record));
  if (
    evidence.evidenceId !== row.evidenceId ||
    evidence.ownerId !== row.ownerId ||
    evidence.expertId !== row.expertId ||
    evidence.threadId !== row.threadId ||
    evidence.turnId !== row.turnId ||
    evidence.updatedAt !== row.updatedAt
  ) {
    throw new Error("学习证据记录与固定身份不匹配。");
  }
  return row;
};

const parseEvidenceRecord = (row: LearningEvidenceRow) =>
  Effect.try({
    try: () => decodeEvidenceRow(row),
    catch: (cause) => cause,
  });

export const makeExpertLearningRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  type StateDbRow = {
    readonly owner_id: string;
    readonly expert_id: string;
    readonly record_json: string;
    readonly revision: number;
    readonly updated_at: string;
  };
  type EvidenceDbRow = {
    readonly evidence_id: string;
    readonly owner_id: string;
    readonly expert_id: string;
    readonly thread_id: string;
    readonly turn_id: string;
    readonly record_json: string;
    readonly updated_at: string;
  };
  type CycleDbRow = {
    readonly cycle_id: string;
    readonly owner_id: string;
    readonly expert_id: string;
    readonly record_json: string;
    readonly updated_at: string;
  };
  const fromState = (row: StateDbRow): LearningStateRow => ({
    ownerId: row.owner_id,
    expertId: row.expert_id,
    record: row.record_json,
    revision: row.revision,
    updatedAt: row.updated_at,
  });
  const fromEvidence = (row: EvidenceDbRow): LearningEvidenceRow => ({
    evidenceId: row.evidence_id,
    ownerId: row.owner_id,
    expertId: row.expert_id,
    threadId: row.thread_id,
    turnId: row.turn_id,
    record: row.record_json,
    updatedAt: row.updated_at,
  });
  const fromCycle = (row: CycleDbRow): LearningCycleRow => ({
    cycleId: row.cycle_id,
    ownerId: row.owner_id,
    expertId: row.expert_id,
    record: row.record_json,
    updatedAt: row.updated_at,
  });

  const readEvidence = (evidenceId: string) =>
    sql
      .unsafe<EvidenceDbRow>("SELECT * FROM expert_learning_evidence WHERE evidence_id = ?", [
        evidenceId,
      ])
      .pipe(
        Effect.flatMap((rows) =>
          rows[0] === undefined
            ? Effect.succeed(undefined)
            : parseEvidenceRecord(fromEvidence(rows[0])),
        ),
      );

  const readCycle = (cycleId: string) =>
    sql
      .unsafe<CycleDbRow>("SELECT * FROM expert_learning_cycles WHERE cycle_id = ?", [cycleId])
      .pipe(Effect.map((rows) => (rows[0] === undefined ? undefined : fromCycle(rows[0]))));

  return {
    readState: (ownerId: string, expertId: string) =>
      sql
        .unsafe<StateDbRow>(
          "SELECT * FROM expert_learning_states WHERE owner_id = ? AND expert_id = ?",
          [ownerId, expertId],
        )
        .pipe(Effect.map((rows) => (rows[0] === undefined ? undefined : fromState(rows[0])))),
    listStates: () =>
      sql
        .unsafe<StateDbRow>(
          "SELECT * FROM expert_learning_states ORDER BY updated_at, owner_id, expert_id",
        )
        .pipe(Effect.map((rows) => rows.map(fromState))),
    writeState: (row: LearningStateRow, expectedRevision: number) => {
      if (
        !Number.isSafeInteger(expectedRevision) ||
        expectedRevision < 0 ||
        row.revision !== expectedRevision + 1
      ) {
        return Effect.fail(
          new Error("学习状态修订号必须是期望修订号的下一版，且首次写入从 1 开始。"),
        );
      }
      return sql
        .unsafe<{ readonly owner_id: string }>(
          "INSERT INTO expert_learning_states (owner_id, expert_id, record_json, revision, updated_at) SELECT ?, ?, ?, ?, ? WHERE ? = 0 OR EXISTS (SELECT 1 FROM expert_learning_states WHERE owner_id = ? AND expert_id = ? AND revision = ?) ON CONFLICT(owner_id, expert_id) DO UPDATE SET record_json = excluded.record_json, revision = excluded.revision, updated_at = excluded.updated_at WHERE expert_learning_states.revision = ? RETURNING owner_id",
          [
            row.ownerId,
            row.expertId,
            row.record,
            row.revision,
            row.updatedAt,
            expectedRevision,
            row.ownerId,
            row.expertId,
            expectedRevision,
            expectedRevision,
          ],
        )
        .pipe(
          Effect.flatMap((rows) =>
            rows.length === 1
              ? Effect.void
              : Effect.fail(new Error("学习状态修订冲突；请重新读取后再提交。")),
          ),
        );
    },
    readEvidence,
    listEvidence: (ownerId: string, expertId: string) =>
      sql
        .unsafe<EvidenceDbRow>(
          "SELECT * FROM expert_learning_evidence WHERE owner_id = ? AND expert_id = ? ORDER BY updated_at DESC, evidence_id LIMIT 256",
          [ownerId, expertId],
        )
        .pipe(
          Effect.flatMap((rows) =>
            Effect.forEach(rows, (row) => parseEvidenceRecord(fromEvidence(row))),
          ),
        ),
    writeEvidence: (row: LearningEvidenceRow) =>
      parseEvidenceRecord(row).pipe(
        Effect.flatMap(() =>
          sql
            .unsafe<{ readonly evidence_id: string }>(
              "INSERT INTO expert_learning_evidence (evidence_id, owner_id, expert_id, thread_id, turn_id, record_json, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(evidence_id) DO UPDATE SET record_json = excluded.record_json, updated_at = excluded.updated_at WHERE expert_learning_evidence.owner_id = excluded.owner_id AND expert_learning_evidence.expert_id = excluded.expert_id AND expert_learning_evidence.thread_id = excluded.thread_id AND expert_learning_evidence.turn_id = excluded.turn_id RETURNING evidence_id",
              [
                row.evidenceId,
                row.ownerId,
                row.expertId,
                row.threadId,
                row.turnId,
                row.record,
                row.updatedAt,
              ],
            )
            .pipe(
              Effect.flatMap((rows) =>
                rows.length === 1
                  ? Effect.void
                  : Effect.fail(new Error("学习证据身份已经固定，不能替换其归属或原生任务。")),
              ),
            ),
        ),
      ),
    readCycle,
    listCycles: (ownerId?: string, expertId?: string, activeOnly = false) => {
      const clauses: string[] = [];
      const parameters: string[] = [];
      if (ownerId !== undefined) {
        clauses.push("owner_id = ?");
        parameters.push(ownerId);
      }
      if (expertId !== undefined) {
        clauses.push("expert_id = ?");
        parameters.push(expertId);
      }
      if (activeOnly)
        clauses.push(
          "CASE WHEN json_valid(record_json) THEN json_extract(record_json, '$.status') END IN ('queued', 'discovery', 'generation')",
        );
      const where = clauses.length ? " WHERE " + clauses.join(" AND ") : "";
      return sql
        .unsafe<CycleDbRow>(
          "SELECT * FROM expert_learning_cycles" +
            where +
            " ORDER BY updated_at DESC, cycle_id LIMIT 512",
          parameters,
        )
        .pipe(Effect.map((rows) => rows.map(fromCycle)));
    },
    writeCycle: (row: LearningCycleRow) =>
      sql
        .unsafe<{ readonly cycle_id: string }>(
          "INSERT INTO expert_learning_cycles (cycle_id, owner_id, expert_id, record_json, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(cycle_id) DO UPDATE SET record_json = excluded.record_json, updated_at = excluded.updated_at WHERE expert_learning_cycles.owner_id = excluded.owner_id AND expert_learning_cycles.expert_id = excluded.expert_id RETURNING cycle_id",
          [row.cycleId, row.ownerId, row.expertId, row.record, row.updatedAt],
        )
        .pipe(
          Effect.flatMap((rows) =>
            rows.length === 1
              ? Effect.void
              : Effect.fail(new Error("学习周期身份已经固定，不能替换其归属或专家。")),
          ),
        ),
  } satisfies ExpertLearningRepositoryShape;
});

export const ExpertLearningRepositoryLive = Layer.effect(
  ExpertLearningRepository,
  makeExpertLearningRepository,
);
