import { Schema } from "effect";

import {
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas";

export const HUB_DELIVERABLE_MAX_FILES = 3;
export const HUB_DELIVERABLE_MAX_FILE_BYTES = 1_000_000;
export const HUB_DELIVERABLE_MAX_TOTAL_BYTES =
  HUB_DELIVERABLE_MAX_FILE_BYTES * HUB_DELIVERABLE_MAX_FILES;

const HubDeliverablePath = TrimmedNonEmptyString.check(Schema.isMaxLength(2_048));
const HubDeliverableRequestId = TrimmedNonEmptyString.check(Schema.isMaxLength(256));
const HubDeliverableDescription = Schema.String.check(Schema.isMaxLength(4_000));
const HubDeliverableName = TrimmedNonEmptyString.check(Schema.isMaxLength(240));

/** File paths are relative to the authenticated worker's own workspace. */
export const HubDeliverablePublishFile = Schema.Struct({
  path: HubDeliverablePath,
  name: Schema.optional(HubDeliverableName),
  description: Schema.optional(HubDeliverableDescription),
});
export type HubDeliverablePublishFile = typeof HubDeliverablePublishFile.Type;

export const HubDeliverablePublishInput = Schema.Struct({
  requestId: HubDeliverableRequestId,
  expectedRevision: NonNegativeInt,
  files: Schema.Array(HubDeliverablePublishFile).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(HUB_DELIVERABLE_MAX_FILES),
  ),
});
export type HubDeliverablePublishInput = typeof HubDeliverablePublishInput.Type;

export const HubDeliverableListInput = Schema.Struct({ ownerThreadId: Schema.optional(ThreadId) });
export type HubDeliverableListInput = typeof HubDeliverableListInput.Type;

export const HubDeliverableReadInput = Schema.Struct({
  ownerThreadId: ThreadId,
  path: HubDeliverablePath,
  /** Omitted reads the current collection; supplied revisions select published history. */
  revision: Schema.optional(NonNegativeInt),
});
export type HubDeliverableReadInput = typeof HubDeliverableReadInput.Type;

export const HubDeliverableWithdrawInput = Schema.Struct({
  ownerThreadId: ThreadId,
  requestId: HubDeliverableRequestId,
  expectedRevision: NonNegativeInt,
});
export type HubDeliverableWithdrawInput = typeof HubDeliverableWithdrawInput.Type;

/** ProjectAgent wire inputs carry the Hub id; principal identity remains server-derived. */
export const ProjectAgentDeliverablesListInput = Schema.Struct({
  projectId: ProjectId,
  ...HubDeliverableListInput.fields,
});
export type ProjectAgentDeliverablesListInput = typeof ProjectAgentDeliverablesListInput.Type;

export const ProjectAgentDeliverablesReadInput = Schema.Struct({
  projectId: ProjectId,
  ...HubDeliverableReadInput.fields,
});
export type ProjectAgentDeliverablesReadInput = typeof ProjectAgentDeliverablesReadInput.Type;

export const ProjectAgentDeliverablesWithdrawInput = Schema.Struct({
  projectId: ProjectId,
  ...HubDeliverableWithdrawInput.fields,
});
export type ProjectAgentDeliverablesWithdrawInput =
  typeof ProjectAgentDeliverablesWithdrawInput.Type;

export const HubDeliverableMediaType = Schema.Literals([
  "text/markdown",
  "text/plain",
  "text/html",
  "application/json",
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
]);
export type HubDeliverableMediaType = typeof HubDeliverableMediaType.Type;

export const HubDeliverableLibraryState = Schema.Literals(["available", "missing"]);
export type HubDeliverableLibraryState = typeof HubDeliverableLibraryState.Type;

/** Immutable Expert identity captured by the accepted Hub work item. */
export const HubDeliverableExpertSummary = Schema.Struct({
  expertId: TrimmedNonEmptyString,
  displayName: TrimmedNonEmptyString,
  revision: PositiveInt,
});
export type HubDeliverableExpertSummary = typeof HubDeliverableExpertSummary.Type;

/** This provenance is stored with the collection and survives later Expert rebinding. */
export const HubDeliverableProvenance = Schema.Struct({
  hubId: ProjectId,
  workerThreadId: ThreadId,
  expertBindingSnapshotId: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
  publishedAt: IsoDateTime,
});
export type HubDeliverableProvenance = typeof HubDeliverableProvenance.Type;

export const HubDeliverableFile = Schema.Struct({
  /** The worker-relative source identity; never an absolute workspace path. */
  path: HubDeliverablePath,
  /** Server-derived relative path in the Hub Library; never accepted from publish input. */
  libraryPath: HubDeliverablePath,
  /** Current Library location; absent on historical publication snapshots. */
  currentLibraryPath: Schema.optional(HubDeliverablePath),
  /** Current Library availability; absent on historical publication snapshots. */
  libraryState: Schema.optional(HubDeliverableLibraryState),
  name: HubDeliverableName,
  description: Schema.NullOr(HubDeliverableDescription),
  mediaType: HubDeliverableMediaType,
  sizeBytes: NonNegativeInt,
  sha256: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/)),
});
export type HubDeliverableFile = typeof HubDeliverableFile.Type;

export const HubDeliverableCollection = Schema.Struct({
  hubId: ProjectId,
  workerThreadId: ThreadId,
  revision: NonNegativeInt,
  state: Schema.Literals(["active", "withdrawn"]),
  commitSha: Schema.NullOr(Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/))),
  provenance: Schema.NullOr(HubDeliverableProvenance),
  /** Added to current-collection queries from the accepted work item/snapshot. */
  expertBinding: Schema.optional(HubDeliverableExpertSummary),
  sourceWorkTitle: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(240))),
  files: Schema.Array(HubDeliverableFile).check(Schema.isMaxLength(HUB_DELIVERABLE_MAX_FILES)),
  updatedAt: IsoDateTime,
});
export type HubDeliverableCollection = typeof HubDeliverableCollection.Type;

export const HubDeliverableMutationResult = Schema.Struct({
  collection: HubDeliverableCollection,
  replayed: Schema.Boolean,
});
export type HubDeliverableMutationResult = typeof HubDeliverableMutationResult.Type;

export const HubDeliverableListResult = Schema.Array(HubDeliverableCollection);
export type HubDeliverableListResult = typeof HubDeliverableListResult.Type;

export const HubDeliverableReadContent = Schema.Union([
  Schema.Struct({ encoding: Schema.Literal("utf-8"), text: Schema.String }),
  Schema.Struct({
    encoding: Schema.Literal("base64"),
    data: Schema.String.check(Schema.isMaxLength(1_500_000)),
  }),
]);
export type HubDeliverableReadContent = typeof HubDeliverableReadContent.Type;

export const HubDeliverableReadResult = Schema.Struct({
  hubId: ProjectId,
  workerThreadId: ThreadId,
  revision: NonNegativeInt,
  commitSha: Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/)),
  provenance: HubDeliverableProvenance,
  file: HubDeliverableFile,
  content: HubDeliverableReadContent,
});
export type HubDeliverableReadResult = typeof HubDeliverableReadResult.Type;

/** Internal metadata projection for a selected immutable publication; carries no file body. */
export const HubDeliverableReferenceMetadata = Schema.Struct({
  hubId: ProjectId,
  workerThreadId: ThreadId,
  revision: PositiveInt,
  commitSha: Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/)),
  provenance: HubDeliverableProvenance,
  file: HubDeliverableFile,
  expertBinding: Schema.optional(HubDeliverableExpertSummary),
  sourceWorkTitle: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(240))),
});
export type HubDeliverableReferenceMetadata = typeof HubDeliverableReferenceMetadata.Type;
