import { Schema } from "effect";

import { IsoDateTime, PositiveInt, TrimmedNonEmptyString } from "./baseSchemas";
import { ExpertSkillSelection } from "./skillPackage";
import { HubWorkState } from "./hubWork";

const ExpertId = Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9_-]{0,63}$/u));
const SwitchId = Schema.String.check(Schema.isPattern(/^[a-f0-9-]{36}$/u));
const SwitchDigest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));
const SnapshotId = Schema.String.check(Schema.isPattern(/^exp_[a-f0-9]{64}$/u));

export const SkillPackageSwitchPersonaPatch = Schema.Struct({
  reviewed: Schema.Literal(true),
  before: Schema.String,
  after: Schema.String,
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type SkillPackageSwitchPersonaPatch = typeof SkillPackageSwitchPersonaPatch.Type;

export const SkillPackageSwitchExpertInput = Schema.Struct({
  expertId: ExpertId,
  skillSelections: Schema.Array(ExpertSkillSelection).check(Schema.isMaxLength(100)),
  personaPatch: Schema.optional(SkillPackageSwitchPersonaPatch),
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type SkillPackageSwitchExpertInput = typeof SkillPackageSwitchExpertInput.Type;

/** Explicit conversion choices and explicit test-only cleanup allowlists. */
export const SkillPackageSwitchInput = Schema.Struct({
  experts: Schema.Array(SkillPackageSwitchExpertInput)
    .check(Schema.isMinLength(1))
    .check(Schema.isMaxLength(500)),
  allowlistedThreadIds: Schema.Array(TrimmedNonEmptyString.check(Schema.isMaxLength(256))).check(
    Schema.isMaxLength(500),
  ),
  allowlistedSnapshotIds: Schema.Array(SnapshotId).check(Schema.isMaxLength(500)),
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type SkillPackageSwitchInput = typeof SkillPackageSwitchInput.Type;

export const SkillPackageSwitchApplyInput = Schema.Struct({
  switchId: SwitchId,
  digest: SwitchDigest,
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type SkillPackageSwitchApplyInput = typeof SkillPackageSwitchApplyInput.Type;

export const SkillPackageSwitchProgressReadInput = Schema.Struct({ switchId: SwitchId }).annotate({
  parseOptions: { onExcessProperty: "error" },
});
export type SkillPackageSwitchProgressReadInput = typeof SkillPackageSwitchProgressReadInput.Type;

export const SkillPackageSwitchReference = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("thread"), id: TrimmedNonEmptyString }),
  Schema.Struct({ kind: Schema.Literal("snapshot"), id: SnapshotId }),
  Schema.Struct({ kind: Schema.Literal("hub-work"), id: TrimmedNonEmptyString }),
  Schema.Struct({ kind: Schema.Literal("ordinary"), id: TrimmedNonEmptyString }),
]);
export type SkillPackageSwitchReference = typeof SkillPackageSwitchReference.Type;

export const SkillPackageSwitchThreadTarget = Schema.Struct({
  threadId: TrimmedNonEmptyString,
  snapshotIds: Schema.Array(SnapshotId),
  /** Soft-deleted native rows remain durable historical references. */
  deleted: Schema.optional(Schema.Boolean),
});
export type SkillPackageSwitchThreadTarget = typeof SkillPackageSwitchThreadTarget.Type;

export const SkillPackageSwitchSnapshotTarget = Schema.Struct({
  snapshotId: SnapshotId,
  kind: Schema.Literals(["legacy-skill", "other"]),
  references: Schema.Array(SkillPackageSwitchReference),
  projectionIds: Schema.Array(TrimmedNonEmptyString),
});
export type SkillPackageSwitchSnapshotTarget = typeof SkillPackageSwitchSnapshotTarget.Type;

export const SkillPackageSwitchHubWorkTarget = Schema.Struct({
  workId: TrimmedNonEmptyString,
  kind: Schema.Literals(["test", "ordinary"]),
  state: HubWorkState,
  references: Schema.Array(SkillPackageSwitchReference),
});
export type SkillPackageSwitchHubWorkTarget = typeof SkillPackageSwitchHubWorkTarget.Type;

export const SkillPackageSwitchExpertTarget = Schema.Struct({
  expertId: ExpertId,
  expectedRevision: PositiveInt,
  originalDefinitionHash: SwitchDigest,
  originalNonSkillHash: SwitchDigest,
  targetNonSkillHash: SwitchDigest,
  targetSkillSelections: Schema.Array(ExpertSkillSelection).check(Schema.isMaxLength(100)),
  personaBefore: Schema.String,
  targetPersona: Schema.String,
});
export type SkillPackageSwitchExpertTarget = typeof SkillPackageSwitchExpertTarget.Type;

export const SkillPackageSwitchPlan = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  switchId: SwitchId,
  createdAt: IsoDateTime,
  experts: Schema.Array(SkillPackageSwitchExpertTarget),
  threadIds: Schema.Array(TrimmedNonEmptyString),
  threadTargets: Schema.Array(SkillPackageSwitchThreadTarget),
  snapshotIds: Schema.Array(SnapshotId),
  snapshotTargets: Schema.Array(SkillPackageSwitchSnapshotTarget),
  /** Existing Hub records are retained as history; referenced legacy snapshots stay on disk. */
  retainedSnapshotIds: Schema.Array(SnapshotId),
  hubWorkIds: Schema.Array(TrimmedNonEmptyString),
  hubWorkTargets: Schema.Array(SkillPackageSwitchHubWorkTarget),
  projectionIds: Schema.Array(TrimmedNonEmptyString),
  inventoryHash: SwitchDigest,
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type SkillPackageSwitchPlan = typeof SkillPackageSwitchPlan.Type;

export const SkillPackageSwitchPreview = Schema.Struct({
  switchId: SwitchId,
  digest: SwitchDigest,
  plan: SkillPackageSwitchPlan,
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type SkillPackageSwitchPreview = typeof SkillPackageSwitchPreview.Type;

export const SkillPackageSwitchProgress = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  switchId: SwitchId,
  digest: SwitchDigest,
  backupPath: TrimmedNonEmptyString,
  status: Schema.Literals([
    "prepared",
    "stopping",
    "publishing",
    "deleting",
    "verifying",
    "cleaning",
    "complete",
    "complete_with_retained_artifacts",
    "failed",
  ]),
  stoppedThreadIds: Schema.Array(TrimmedNonEmptyString),
  cancelledHubWorkIds: Schema.Array(TrimmedNonEmptyString),
  publishedExperts: Schema.Record(ExpertId, PositiveInt),
  deletedThreadIds: Schema.Array(TrimmedNonEmptyString),
  cleaned: Schema.Boolean,
  retainedSnapshotIds: Schema.Array(SnapshotId),
  error: Schema.optional(Schema.String),
  updatedAt: IsoDateTime,
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type SkillPackageSwitchProgress = typeof SkillPackageSwitchProgress.Type;

export const SkillPackageSwitchProgressResult = Schema.Struct({
  progress: SkillPackageSwitchProgress,
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type SkillPackageSwitchProgressResult = typeof SkillPackageSwitchProgressResult.Type;

export const SkillPackageSwitchApplyResult = Schema.Struct({
  completed: Schema.Literal(true),
});
export type SkillPackageSwitchApplyResult = typeof SkillPackageSwitchApplyResult.Type;
