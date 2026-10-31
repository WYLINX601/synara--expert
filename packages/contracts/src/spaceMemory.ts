import { Schema } from "effect";
import { IsoDateTime, NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas";

const Id = TrimmedNonEmptyString.check(Schema.isMaxLength(200));
const Hash = Schema.String.check(Schema.isPattern(/^sha256:[a-f0-9]{64}$/u));
const Quote = Schema.String.check(Schema.isMaxLength(16_000));
const Scope = Schema.Struct({
  ownerId: Id,
  spaceId: Schema.NullOr(Id),
  expertId: Id,
  projectId: Id,
});

/** The host supplies this scope; callers and model output cannot broaden it. */
export const MemoryScope = Scope;
export type MemoryScope = typeof MemoryScope.Type;

const SourceRange = {
  /** Host-computed exact fragment hash; source identity alone does not imply topic coverage. */
  fragmentHash: Schema.optional(Hash),
  startOffset: Schema.optional(NonNegativeInt),
  endOffset: Schema.optional(NonNegativeInt),
  truncated: Schema.optional(Schema.Boolean),
};

/** Bounded, exact provenance retained with a learned value. */
export const LearningSourceReference = Schema.Union([
  /** Produced only by an authenticated owner command, never a model selector. */
  Schema.Struct({
    kind: Schema.Literal("owner"),
    requestId: Id,
    contentHash: Hash,
    quote: Schema.optional(Quote),
    fragmentHash: Schema.optional(Hash),
  }),
  Schema.Struct({
    kind: Schema.Literal("message"),
    messageId: Id,
    threadId: Id,
    turnId: Schema.optional(Id),
    role: Schema.optional(Schema.Literals(["user", "assistant"])),
    contentHash: Hash,
    quote: Schema.optional(Quote),
    ...SourceRange,
  }),
  Schema.Struct({
    kind: Schema.Literal("runtime"),
    runId: TrimmedNonEmptyString.check(Schema.isMaxLength(2_048)),
    eventId: Id,
    eventSequence: Schema.optional(NonNegativeInt),
    toolCallId: Schema.optional(Id),
    contentHash: Hash,
    quote: Schema.optional(Quote),
    ...SourceRange,
  }),
  Schema.Struct({
    kind: Schema.Literal("document"),
    documentId: Id,
    contentHash: Hash,
    quote: Schema.optional(Quote),
    ...SourceRange,
  }),
  Schema.Struct({
    kind: Schema.Literal("attachment"),
    attachmentId: Id,
    messageId: Schema.optional(Id),
    contentHash: Hash,
    quote: Schema.optional(Quote),
    ...SourceRange,
  }),
]);
export type LearningSourceReference = typeof LearningSourceReference.Type;

export const SpaceMemoryKind = Schema.Literals(["rule", "fact", "environment"]);
export type SpaceMemoryKind = typeof SpaceMemoryKind.Type;
export const SpaceMemoryStatus = Schema.Literals(["active", "retracted"]);
export type SpaceMemoryStatus = typeof SpaceMemoryStatus.Type;

/** An immutable, source-backed revision of one Space Memory entry. */
export const SpaceMemoryEntry = Schema.Struct({
  memoryId: Id,
  revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  contentHash: Hash,
  kind: SpaceMemoryKind,
  key: Id,
  content: Schema.String.check(Schema.isMaxLength(4_000)),
  scope: MemoryScope,
  /** Optional on read for old records; new writes normalize the sharing scope. */
  projectBound: Schema.optional(Schema.Boolean),
  sourceRefs: Schema.Array(LearningSourceReference).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(5),
  ),
  changeId: Id,
  commitSequence: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  observedAt: IsoDateTime,
  validUntil: Schema.optional(IsoDateTime),
  status: SpaceMemoryStatus,
});
export type SpaceMemoryEntry = typeof SpaceMemoryEntry.Type;

export const SpaceMemoryRevisionRef = Schema.Struct({
  memoryId: Id,
  revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  contentHash: Hash,
});
export type SpaceMemoryRevisionRef = typeof SpaceMemoryRevisionRef.Type;

/** Exact asset refs stored in the shared learning-change journal. */
export const LearningChangeReference = Schema.Union([
  Schema.Struct({
    assetKind: Schema.Literal("memory"),
    memoryId: Id,
    revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
    contentHash: Hash,
  }),
  Schema.Struct({
    assetKind: Schema.Literal("skill"),
    skillId: Id,
    revision: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
    packageId: Schema.optional(Id),
    expertRevision: Schema.optional(NonNegativeInt),
    contentHash: Schema.optional(Hash),
    data: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  }),
]);
export type LearningChangeReference = typeof LearningChangeReference.Type;

export const LearningChangeStatus = Schema.Literals([
  "prepared",
  "committed",
  "saved_unbound",
  "failed",
  "reverted",
]);
export type LearningChangeStatus = typeof LearningChangeStatus.Type;

/** Durable cross-asset receipt. Operation-specific skill data remains opaque to Memory. */
export const LearningChangeSet = Schema.Struct({
  changeId: Id,
  requestId: Id,
  requestFingerprint: Hash,
  ownerId: Id,
  expertId: Id,
  sourceScope: MemoryScope,
  assetKind: Schema.Literals(["memory", "skill"]),
  before: Schema.optional(Schema.NullOr(LearningChangeReference)),
  after: Schema.optional(Schema.NullOr(LearningChangeReference)),
  /** Host-projected link from a committed inverse to its exact source change. */
  revertsChangeId: Schema.optional(Id),
  sourceRefs: Schema.Array(LearningSourceReference).check(Schema.isMaxLength(5)),
  status: LearningChangeStatus,
  summary: Schema.String.check(Schema.isMaxLength(2_000)),
  operationRef: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  data: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type LearningChangeSet = typeof LearningChangeSet.Type;

export const RunKnowledgeManifest = Schema.Struct({
  id: Id,
  rootRunId: TrimmedNonEmptyString.check(Schema.isMaxLength(2_048)),
  scope: MemoryScope,
  snapshotId: Id,
  skillAssemblyId: Schema.optional(Id),
  learningEpoch: Schema.optional(NonNegativeInt),
  frozenRuleSequence: Schema.optional(NonNegativeInt),
  rules: Schema.Array(SpaceMemoryRevisionRef).check(Schema.isMaxLength(256)),
  renderVersion: Schema.Literal(1),
  text: Schema.String.check(Schema.isMaxLength(24_000)),
  hash: Hash,
  createdAt: IsoDateTime,
});
export type RunKnowledgeManifest = typeof RunKnowledgeManifest.Type;

export const SpaceMemoryReadReceipt = Schema.Struct({
  manifestId: Id,
  memoryId: Id,
  revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  contentHash: Hash,
  toolCallId: Id,
  readAt: IsoDateTime,
});
export type SpaceMemoryReadReceipt = typeof SpaceMemoryReadReceipt.Type;
