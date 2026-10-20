import { Schema } from "effect";

import {
  CommandId,
  IsoDateTime,
  NonNegativeInt,
  ProjectId,
  SpaceId,
  ThreadId,
} from "./baseSchemas";

export const CONTEXT_GOAL_MAX_LENGTH = 4_096;
export const CONTEXT_INSTRUCTIONS_MAX_LENGTH = 16_384;
export const ContextGoal = Schema.String.check(Schema.isMaxLength(CONTEXT_GOAL_MAX_LENGTH));
export const ContextInstructions = Schema.String.check(
  Schema.isMaxLength(CONTEXT_INSTRUCTIONS_MAX_LENGTH),
);
export const ContextMode = Schema.Literals(["legacy", "unbound", "bound"]);
export type ContextMode = typeof ContextMode.Type;

export const SpaceContextSettings = Schema.Struct({
  dataInstanceId: Schema.String,
  spaceId: SpaceId,
  name: Schema.String,
  icon: Schema.String,
  directionGoal: ContextGoal,
  sharedInstructions: ContextInstructions,
  revision: NonNegativeInt,
});
export type SpaceContextSettings = typeof SpaceContextSettings.Type;

export const ContextMigrationRecord = Schema.Struct({
  projectId: ProjectId,
  sourceDigest: Schema.String,
  legacyInstructions: Schema.String,
  status: Schema.Literals(["pending", "conflict", "completed"]),
  choice: Schema.NullOr(Schema.Literals(["keep_saved", "use_legacy"])),
  updatedAt: IsoDateTime,
});
export type ContextMigrationRecord = typeof ContextMigrationRecord.Type;

export const ProjectContextSettings = Schema.Struct({
  dataInstanceId: Schema.String,
  projectId: ProjectId,
  title: Schema.String,
  workspaceRoot: Schema.String,
  spaceId: Schema.NullOr(SpaceId),
  projectGoal: ContextGoal,
  projectInstructions: ContextInstructions,
  revision: NonNegativeInt,
  inherited: Schema.NullOr(SpaceContextSettings),
  migration: Schema.NullOr(ContextMigrationRecord),
});
export type ProjectContextSettings = typeof ProjectContextSettings.Type;

export const ContextSpaceSource = Schema.Struct({
  spaceId: SpaceId,
  name: Schema.String,
  revision: NonNegativeInt,
  directionGoal: ContextGoal,
  sharedInstructions: ContextInstructions,
});
export const ContextProjectSource = Schema.Struct({
  projectId: ProjectId,
  title: Schema.String,
  workspaceRoot: Schema.String,
  revision: NonNegativeInt,
  projectGoal: ContextGoal,
  projectInstructions: ContextInstructions,
});
const ContextSnapshotV1Fields = {
  schemaVersion: Schema.Literal(1),
  rendererVersion: Schema.Literal(1),
  space: Schema.NullOr(ContextSpaceSource),
  project: ContextProjectSource,
  text: Schema.String,
  snapshotHash: Schema.String,
  hasContent: Schema.Boolean,
};
const ContextSpacePreviewV2Fields = {
  schemaVersion: Schema.Literal(2),
  rendererVersion: Schema.Literal(1),
  source: Schema.Literal("space"),
  space: ContextSpaceSource,
  text: Schema.String,
  snapshotHash: Schema.String,
  hasContent: Schema.Boolean,
};
const ContextNonePreviewV2Fields = {
  schemaVersion: Schema.Literal(2),
  rendererVersion: Schema.Literal(1),
  source: Schema.Literal("none"),
  space: Schema.Null,
  text: Schema.String,
  snapshotHash: Schema.String,
  hasContent: Schema.Boolean,
};
export const ContextPreviewV1 = Schema.Struct(ContextSnapshotV1Fields);
export const ContextSpacePreviewV2 = Schema.Struct(ContextSpacePreviewV2Fields);
export const ContextNonePreviewV2 = Schema.Struct(ContextNonePreviewV2Fields);
export const ContextPreview = Schema.Union([
  ContextPreviewV1,
  ContextSpacePreviewV2,
  ContextNonePreviewV2,
]);
export type ContextPreview = typeof ContextPreview.Type;
export const ContextSnapshotV1 = Schema.Struct({
  ...ContextSnapshotV1Fields,
  snapshotId: Schema.String,
  createdAt: IsoDateTime,
});
export const ContextSpaceSnapshotV2 = Schema.Struct({
  ...ContextSpacePreviewV2Fields,
  snapshotId: Schema.String,
  createdAt: IsoDateTime,
});
export const ContextNoneSnapshotV2 = Schema.Struct({
  ...ContextNonePreviewV2Fields,
  snapshotId: Schema.String,
  createdAt: IsoDateTime,
});
export const ContextSnapshot = Schema.Union([
  ContextSnapshotV1,
  ContextSpaceSnapshotV2,
  ContextNoneSnapshotV2,
]);
export type ContextSnapshot = typeof ContextSnapshot.Type;

/** Frozen application Context, independently carried alongside the Expert session. */
export const ContextSession = Schema.Struct({
  snapshotId: Schema.String,
  snapshotHash: Schema.String,
  text: Schema.String,
  hasContent: Schema.Boolean,
});
export type ContextSession = typeof ContextSession.Type;

export const ContextAppliedRuntimeRecord = Schema.Struct({
  threadId: ThreadId,
  snapshotId: Schema.String,
  snapshotHash: Schema.String,
  provider: Schema.String,
  lifecycleGeneration: Schema.String,
  baseInstructionsHash: Schema.String,
  submittedInstructions: Schema.String,
  appliedAt: IsoDateTime,
});
export type ContextAppliedRuntimeRecord = typeof ContextAppliedRuntimeRecord.Type;

export const ThreadContextDetails = Schema.Struct({
  dataInstanceId: Schema.String,
  threadId: ThreadId,
  mode: ContextMode,
  snapshot: Schema.NullOr(ContextSnapshot),
  preview: Schema.NullOr(ContextPreview),
  applied: Schema.NullOr(ContextAppliedRuntimeRecord),
  loadStatus: Schema.Literals(["absent", "pending", "loaded", "stopped", "failed", "uncertain"]),
  hasNewVersion: Schema.Boolean,
  retry: Schema.NullOr(Schema.Struct({ eventSequence: NonNegativeInt, messageId: Schema.String })),
  error: Schema.NullOr(Schema.String),
});
export type ThreadContextDetails = typeof ThreadContextDetails.Type;

export const SpaceContextReadInput = Schema.Struct({ spaceId: SpaceId });
export const ProjectContextReadInput = Schema.Struct({ projectId: ProjectId });
export const ThreadContextReadInput = Schema.Struct({ threadId: ThreadId });
export const SpaceContextSaveInput = Schema.Struct({
  commandId: CommandId,
  dataInstanceId: Schema.String,
  spaceId: SpaceId,
  expectedRevision: NonNegativeInt,
  expectedName: Schema.String,
  expectedIcon: Schema.String,
  name: Schema.String,
  icon: Schema.String,
  directionGoal: ContextGoal,
  sharedInstructions: ContextInstructions,
});
export type SpaceContextSaveInput = typeof SpaceContextSaveInput.Type;
export const ProjectContextSaveInput = Schema.Struct({
  commandId: CommandId,
  dataInstanceId: Schema.String,
  projectId: ProjectId,
  expectedRevision: NonNegativeInt,
  projectGoal: ContextGoal,
  projectInstructions: ContextInstructions,
});
export type ProjectContextSaveInput = typeof ProjectContextSaveInput.Type;
export const ContextCommandReadInput = Schema.Struct({ commandId: CommandId });
export const ContextCommandResult = Schema.Struct({
  commandId: CommandId,
  status: Schema.Literals(["saved", "conflict", "rejected", "pending", "unknown"]),
  space: Schema.optional(SpaceContextSettings),
  project: Schema.optional(ProjectContextSettings),
  migration: Schema.optional(ContextMigrationRecord),
  message: Schema.optional(Schema.String),
});
export type ContextCommandResult = typeof ContextCommandResult.Type;
export const ContextMigrationClaimInput = Schema.Struct({
  commandId: CommandId,
  dataInstanceId: Schema.String,
  projectId: ProjectId,
  expectedWorkspaceRoot: Schema.String,
  sourceDigest: Schema.String,
  legacyInstructions: Schema.String,
});
export type ContextMigrationClaimInput = typeof ContextMigrationClaimInput.Type;
export const ContextMigrationResolveInput = Schema.Struct({
  commandId: CommandId,
  dataInstanceId: Schema.String,
  projectId: ProjectId,
  sourceDigest: Schema.String,
  expectedRevision: NonNegativeInt,
  choice: Schema.Literals(["keep_saved", "use_legacy"]),
  instructions: Schema.optional(ContextInstructions),
});
export type ContextMigrationResolveInput = typeof ContextMigrationResolveInput.Type;
export const ContextRetryInput = Schema.Struct({
  commandId: CommandId,
  threadId: ThreadId,
  eventSequence: NonNegativeInt,
});
export type ContextRetryInput = typeof ContextRetryInput.Type;

export interface ContextApi {
  getSpace(input: typeof SpaceContextReadInput.Type): Promise<SpaceContextSettings>;
  getProject(input: typeof ProjectContextReadInput.Type): Promise<ProjectContextSettings>;
  getThread(input: typeof ThreadContextReadInput.Type): Promise<ThreadContextDetails>;
  saveSpace(input: SpaceContextSaveInput): Promise<ContextCommandResult>;
  saveProject(input: ProjectContextSaveInput): Promise<ContextCommandResult>;
  getCommandResult(input: typeof ContextCommandReadInput.Type): Promise<ContextCommandResult>;
  claimMigration(input: ContextMigrationClaimInput): Promise<ContextCommandResult>;
  resolveMigration(input: ContextMigrationResolveInput): Promise<ContextCommandResult>;
  retryLoad(input: ContextRetryInput): Promise<ContextCommandResult>;
}
