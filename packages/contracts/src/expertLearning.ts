import { Schema } from "effect";
import { IsoDateTime, NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas";
import { ModelSelection } from "./orchestration";

const Id = TrimmedNonEmptyString.check(Schema.isMaxLength(200));
const Summary = Schema.String.check(Schema.isMaxLength(2_000));

/** Public learning state. Missing state is interpreted by the host as disabled. */
export const ExpertLearningState = Schema.Struct({
  expertId: Id,
  enabled: Schema.Boolean,
  epoch: NonNegativeInt,
  revision: NonNegativeInt,
  harnessKind: Schema.optional(Schema.Literals(["omp", "pi"])),
  updatedAt: IsoDateTime,
  status: Schema.optional(Schema.Literals(["disabled", "idle", "queued", "learning", "failed"])),
  summary: Schema.optional(Summary),
});
export type ExpertLearningState = typeof ExpertLearningState.Type;

const EvidenceText = Schema.String.check(Schema.isMaxLength(16_000));
const CoverageLabel = TrimmedNonEmptyString.check(Schema.isMaxLength(200));

/** A bounded, persisted item captured from the current native task event stream. */
export const ExpertLearningEvidenceItem = Schema.Struct({
  id: Id,
  kind: Schema.Literals(["message", "tool_call", "tool_result", "verification", "activity"]),
  text: EvidenceText,
  role: Schema.optional(Schema.Literals(["user", "assistant"])),
  eventSequence: Schema.optional(NonNegativeInt),
  /** Exact native journal event; item IDs may instead identify a tool-call projection. */
  sourceEventId: Schema.optional(Id),
  toolCallId: Schema.optional(Id),
  truncated: Schema.optional(Schema.Boolean),
});
export type ExpertLearningEvidenceItem = typeof ExpertLearningEvidenceItem.Type;

/** Bounded current-task evidence. This is storage data, not a model authority contract. */
export const ExpertLearningEvidence = Schema.Struct({
  evidenceId: Id,
  /** Server-owned enable epoch; legacy snapshots without it are not auto-consumable. */
  learningEpoch: Schema.optional(NonNegativeInt),
  ownerId: Id,
  expertId: Id,
  threadId: Id,
  turnId: Id,
  rootRunId: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(2_048))),
  snapshotId: Id,
  assemblyId: Schema.optional(Id),
  projectId: Id,
  spaceId: Schema.optional(Id),
  modelSelection: ModelSelection,
  items: Schema.Array(ExpertLearningEvidenceItem).check(Schema.isMaxLength(128)),
  coverage: Schema.Array(CoverageLabel).check(Schema.isMaxLength(32)),
  completedAt: Schema.optional(IsoDateTime),
  updatedAt: IsoDateTime,
});
export type ExpertLearningEvidence = typeof ExpertLearningEvidence.Type;
