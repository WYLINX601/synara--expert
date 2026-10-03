import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import { Effect, Layer, Option } from "effect";

import {
  toPersistenceDecodeError,
  toPersistenceSqlError,
  toPersistenceSqlOrDecodeError,
} from "../Errors.ts";
import {
  ExpertAppliedRuntimeDbRow,
  ExpertAppliedRuntimeRepository,
  type ExpertAppliedRuntimeRepositoryShape,
  expertAppliedRuntimeRecordFromDbRow,
} from "../Services/ExpertAppliedRuntimeRecords.ts";
import { ExpertAppliedRuntimeReadInput, ExpertAppliedRuntimeRecord } from "@synara/contracts";

const makeExpertAppliedRuntimeRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertRow = SqlSchema.void({
    Request: ExpertAppliedRuntimeRecord,
    execute: (record) => sql`
      INSERT INTO expert_applied_runtime_records (
        thread_id,
        snapshot_id,
        provider,
        model,
        runtime_component,
        runtime_version,
        lifecycle_generation,
        applied_at
      ) VALUES (
        ${record.threadId},
        ${record.snapshotId},
        ${record.provider},
        ${record.model ?? null},
        ${record.runtimeComponent ?? null},
        ${record.runtimeVersion ?? null},
        ${record.lifecycleGeneration},
        ${record.appliedAt}
      )
      ON CONFLICT (thread_id)
      DO UPDATE SET
        snapshot_id = excluded.snapshot_id,
        provider = excluded.provider,
        model = excluded.model,
        runtime_component = excluded.runtime_component,
        runtime_version = excluded.runtime_version,
        lifecycle_generation = excluded.lifecycle_generation,
        applied_at = excluded.applied_at
    `,
  });

  const findByThreadId = SqlSchema.findOneOption({
    Request: ExpertAppliedRuntimeReadInput,
    Result: ExpertAppliedRuntimeDbRow,
    execute: ({ threadId }) => sql`
      SELECT
        thread_id AS "threadId",
        snapshot_id AS "snapshotId",
        provider,
        model,
        runtime_component AS "runtimeComponent",
        runtime_version AS "runtimeVersion",
        lifecycle_generation AS "lifecycleGeneration",
        applied_at AS "appliedAt"
      FROM expert_applied_runtime_records
      WHERE thread_id = ${threadId}
    `,
  });

  const deleteByThreadIdQuery = SqlSchema.void({
    Request: ExpertAppliedRuntimeReadInput,
    execute: ({ threadId }) => sql`
      DELETE FROM expert_applied_runtime_records
      WHERE thread_id = ${threadId}
    `,
  });

  const upsert: ExpertAppliedRuntimeRepositoryShape["upsert"] = (record) =>
    upsertRow(record).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ExpertAppliedRuntimeRepository.upsert:query",
          "ExpertAppliedRuntimeRepository.upsert:encodeRequest",
        ),
      ),
    );

  const getByThreadId: ExpertAppliedRuntimeRepositoryShape["getByThreadId"] = (input) =>
    findByThreadId(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ExpertAppliedRuntimeRepository.getByThreadId:query",
          "ExpertAppliedRuntimeRepository.getByThreadId:decodeRow",
        ),
      ),
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.succeed(Option.none()),
          onSome: (row) =>
            expertAppliedRuntimeRecordFromDbRow(row).pipe(
              Effect.mapError(
                toPersistenceDecodeError(
                  "ExpertAppliedRuntimeRepository.getByThreadId:rowToRecord",
                ),
              ),
              Effect.map(Option.some),
            ),
        }),
      ),
    );

  const deleteByThreadId: ExpertAppliedRuntimeRepositoryShape["deleteByThreadId"] = (input) =>
    deleteByThreadIdQuery(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ExpertAppliedRuntimeRepository.deleteByThreadId:query"),
      ),
    );

  return { upsert, getByThreadId, deleteByThreadId } satisfies ExpertAppliedRuntimeRepositoryShape;
});

export const ExpertAppliedRuntimeRepositoryLive = Layer.effect(
  ExpertAppliedRuntimeRepository,
  makeExpertAppliedRuntimeRepository,
);
