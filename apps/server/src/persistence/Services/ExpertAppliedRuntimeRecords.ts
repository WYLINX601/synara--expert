import {
  ExpertAppliedRuntimeReadInput,
  ExpertAppliedRuntimeRecord,
  ExpertSkillApplication,
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
  /** Full owner-only inventory used to find immutable snapshot references. */
  readonly listAll: () => Effect.Effect<
    ReadonlyArray<ExpertAppliedRuntimeRecordType>,
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
  skillApplicationJson: Schema.NullOr(Schema.fromJsonString(ExpertSkillApplication)),
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
    ...(row.skillApplicationJson !== null
      ? {
          skillApplication: row.skillApplicationJson,
        }
      : {}),
  });
}
