import {
  ExpertAppliedRuntimeReadInput,
  ExpertAppliedRuntimeRecord,
  ThreadId,
  type ExpertAppliedRuntimeRecord as ExpertAppliedRuntimeRecordType,
} from "@synara/contracts";
import { Option, Schema, ServiceMap } from "effect";
import type { Effect } from "effect";

import type { PersistenceDecodeError, PersistenceSqlError } from "../Errors.ts";

export type ExpertAppliedRuntimeRepositoryError = PersistenceSqlError | PersistenceDecodeError;

export interface ExpertAppliedRuntimeRepositoryShape {
  readonly upsert: (
    record: ExpertAppliedRuntimeRecordType,
  ) => Effect.Effect<void, ExpertAppliedRuntimeRepositoryError>;
  readonly getByThreadId: (
    input: typeof ExpertAppliedRuntimeReadInput.Type,
  ) => Effect.Effect<
    Option.Option<ExpertAppliedRuntimeRecordType>,
    ExpertAppliedRuntimeRepositoryError
  >;
  readonly deleteByThreadId: (
    input: typeof ExpertAppliedRuntimeReadInput.Type,
  ) => Effect.Effect<void, PersistenceSqlError>;
}

export class ExpertAppliedRuntimeRepository extends ServiceMap.Service<
  ExpertAppliedRuntimeRepository,
  ExpertAppliedRuntimeRepositoryShape
>()("synara/persistence/Services/ExpertAppliedRuntimeRecords/ExpertAppliedRuntimeRepository") {}

export const ExpertAppliedRuntimeDbRow = Schema.Struct({
  threadId: ThreadId,
  snapshotId: Schema.String,
  provider: Schema.String,
  model: Schema.NullOr(Schema.String),
  runtimeComponent: Schema.NullOr(Schema.String),
  runtimeVersion: Schema.NullOr(Schema.String),
  lifecycleGeneration: Schema.String,
  appliedAt: Schema.String,
});
export type ExpertAppliedRuntimeDbRow = typeof ExpertAppliedRuntimeDbRow.Type;

export function expertAppliedRuntimeRecordFromDbRow(
  row: ExpertAppliedRuntimeDbRow,
): Effect.Effect<ExpertAppliedRuntimeRecordType, Schema.SchemaError> {
  return Schema.decodeUnknownEffect(ExpertAppliedRuntimeRecord)({
    threadId: row.threadId,
    snapshotId: row.snapshotId,
    provider: row.provider,
    ...(row.model !== null ? { model: row.model } : {}),
    ...(row.runtimeComponent !== null ? { runtimeComponent: row.runtimeComponent } : {}),
    ...(row.runtimeVersion !== null ? { runtimeVersion: row.runtimeVersion } : {}),
    lifecycleGeneration: row.lifecycleGeneration,
    appliedAt: row.appliedAt,
  });
}
