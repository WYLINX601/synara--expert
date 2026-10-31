import { Schema } from "effect";
import {
  IsoDateTime,
  MessageId,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
  TurnId,
} from "./baseSchemas";
import { ModelSelection } from "./orchestration";
import { ExpertLearningState } from "./expertLearning";
import { LearningMemoryDraft } from "./learningTools";
import { LearningChangeSet, SpaceMemoryEntry } from "./spaceMemory";
import {
  SkillDefinition,
  SkillFileChange,
  SkillId,
  SkillScope,
  ExpertSkillBinding,
} from "./skillLibrary";
import { SkillPackageId } from "./skillPackage";

const Id = TrimmedNonEmptyString.check(Schema.isMaxLength(200));
const Digest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));
const ShortText = Schema.String.check(Schema.isMaxLength(8_000));
const OpportunityText = TrimmedNonEmptyString.check(Schema.isMaxLength(8_000));

export const SkillEvolutionSourceSelection = Schema.Struct({
  threadId: ThreadId,
  turnId: TurnId,
});
export type SkillEvolutionSourceSelection = typeof SkillEvolutionSourceSelection.Type;
export const SkillEvolutionSource = Schema.Struct({
  threadId: ThreadId,
  turnId: TurnId,
  projectId: ProjectId,
  title: Schema.String,
  expertId: Id,
  expertRevision: PositiveInt,
  snapshotId: Id,
  completedAt: IsoDateTime,
  messageCount: NonNegativeInt,
});
export type SkillEvolutionSource = typeof SkillEvolutionSource.Type;

export const SkillEvolutionEvidence = Schema.Union([
  Schema.Struct({ threadId: ThreadId, messageId: MessageId, quote: ShortText }),
  Schema.Struct({
    kind: Schema.Literal("runtime"),
    threadId: ThreadId,
    eventId: Id,
    quote: ShortText,
  }),
]);
export type SkillEvolutionEvidence = typeof SkillEvolutionEvidence.Type;

/** A reviewable learning opportunity, before any Skill files are generated. */
export const SkillEvolutionOpportunity = Schema.Struct({
  opportunityId: Id,
  requestId: Id,
  expertId: Id,
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
  reason: OpportunityText,
  outcomes: Schema.Array(OpportunityText).check(Schema.isMinLength(1), Schema.isMaxLength(8)),
  evidence: Schema.Array(SkillEvolutionEvidence).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(20),
  ),
  targetSkillId: Schema.optional(SkillId),
  memory: Schema.optional(LearningMemoryDraft),
  digest: Digest,
  status: Schema.Literals(["suggested", "dismissed"]),
});
export type SkillEvolutionOpportunity = typeof SkillEvolutionOpportunity.Type;
export const SkillEvolutionProposal = Schema.Struct({
  proposalId: Id,
  requestId: Id,
  expertId: Id,
  action: Schema.Literals(["create", "update", "derive"]),
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
  summary: ShortText,
  evidence: Schema.Array(SkillEvolutionEvidence).check(Schema.isMaxLength(20)),
  baseSkillId: Schema.optional(SkillId),
  baseRevision: Schema.optional(PositiveInt),
  basePackageId: Schema.optional(SkillPackageId),
  affectedExpertIds: Schema.optional(Schema.Array(Id)),
  changes: Schema.Array(SkillFileChange).check(Schema.isMaxLength(100)),
  digest: Digest,
  status: Schema.Literals([
    "proposed",
    "applying",
    "saved_unbound",
    "applied",
    "rejected",
    "conflict",
    "failed",
  ]),
  resultSkillId: Schema.optional(SkillId),
  resultRevision: Schema.optional(PositiveInt),
  error: Schema.optional(ShortText),
});
export type SkillEvolutionProposal = typeof SkillEvolutionProposal.Type;

export const SkillEvolutionRun = Schema.Struct({
  requestId: Id,
  expertId: Id,
  origin: Schema.optional(Schema.Literals(["manual", "automatic"])),
  cycleId: Schema.optional(Id),
  learningEpoch: Schema.optional(NonNegativeInt),
  /** Missing on historical generation records; all new requests set their stage. */
  stage: Schema.optional(Schema.Literals(["discovery", "generation"])),
  discoveryRequestId: Schema.optional(Id),
  opportunityId: Schema.optional(Id),
  generationIndex: Schema.optional(PositiveInt),
  feedback: Schema.optional(ShortText),
  sourceSelections: Schema.optional(
    Schema.Array(SkillEvolutionSourceSelection).check(Schema.isMaxLength(5)),
  ),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  modelSelection: ModelSelection,
  targetSkillId: Schema.optional(SkillId),
  sourceCount: NonNegativeInt,
  taskThreadId: Schema.optional(ThreadId),
  taskTurnId: Schema.optional(TurnId),
  status: Schema.Literals([
    "queued",
    "running",
    "waiting_authorization",
    "opportunity_ready",
    "proposal_ready",
    "no_change",
    "insufficient_evidence",
    "failed",
    "cancel_requested",
    "cancelled",
  ]),
  summary: Schema.optional(ShortText),
  error: Schema.optional(ShortText),
  proposals: Schema.Array(SkillEvolutionProposal),
  opportunities: Schema.optional(
    Schema.Array(SkillEvolutionOpportunity).check(Schema.isMaxLength(3)),
  ),
});
export type SkillEvolutionRun = typeof SkillEvolutionRun.Type;

export const SkillEvolutionEvent = Schema.Struct({
  eventId: Id,
  operationId: Id,
  requestId: Id,
  expertId: Id,
  skillId: SkillId,
  name: Schema.String,
  kind: Schema.Literals([
    "created",
    "derived",
    "updated",
    "restored",
    "shared",
    "binding_restored",
  ]),
  createdAt: IsoDateTime,
  revision: PositiveInt,
  packageId: SkillPackageId,
  previousRevision: Schema.optional(PositiveInt),
  previousPackageId: Schema.optional(SkillPackageId),
  derivedFromSkillId: Schema.optional(SkillId),
  previousSkillId: Schema.optional(SkillId),
  scope: Schema.optional(SkillScope),
  previousScope: Schema.optional(SkillScope),
  affectedExpertIds: Schema.Array(Id),
});
export type SkillEvolutionEvent = typeof SkillEvolutionEvent.Type;

export const SkillEvolutionGraphNode = Schema.Struct({
  skillId: SkillId,
  name: Schema.String,
  revision: PositiveInt,
  packageId: SkillPackageId,
  ownerExpertId: Schema.optional(Id),
  timestamp: Schema.NullOr(IsoDateTime),
  baseline: Schema.Boolean,
  derivedFromSkillId: Schema.optional(SkillId),
  deleted: Schema.optional(Schema.Boolean),
});
export type SkillEvolutionGraphNode = typeof SkillEvolutionGraphNode.Type;
export const SkillEvolutionGraph = Schema.Struct({
  nodes: Schema.Array(SkillEvolutionGraphNode),
  events: Schema.Array(SkillEvolutionEvent),
});
export type SkillEvolutionGraph = typeof SkillEvolutionGraph.Type;

export const SkillEvolutionCapability = Schema.Struct({
  provider: TrimmedNonEmptyString,
  supported: Schema.Boolean,
  reason: Schema.String,
});
export type SkillEvolutionCapability = typeof SkillEvolutionCapability.Type;

const LearningSkillChangeSide = Schema.Struct({
  size: NonNegativeInt,
  sha256: Digest,
  executable: Schema.Boolean,
  text: Schema.optional(Schema.String.check(Schema.isMaxLength(128_000))),
  omittedReason: Schema.optional(Schema.Literals(["binary", "budget"])),
});
export type LearningSkillChangeSide = typeof LearningSkillChangeSide.Type;
const LearningSkillChangeFile = Schema.Struct({
  path: Schema.String.check(Schema.isMaxLength(4_096)),
  before: Schema.NullOr(LearningSkillChangeSide),
  after: Schema.NullOr(LearningSkillChangeSide),
});
export type LearningSkillChangeFile = typeof LearningSkillChangeFile.Type;
export const LearningSkillChangeDetail = Schema.Struct({
  changeId: Id,
  files: Schema.Array(LearningSkillChangeFile).check(Schema.isMaxLength(100)),
  coverage: Schema.Array(Schema.String.check(Schema.isMaxLength(200))).check(
    Schema.isMaxLength(20),
  ),
});
export type LearningSkillChangeDetail = typeof LearningSkillChangeDetail.Type;

const action = <T extends string, F extends Schema.Struct.Fields>(name: T, fields: F) =>
  Schema.Struct({ action: Schema.Literal(name), ...fields }).annotate({
    parseOptions: { onExcessProperty: "error" },
  });
export const SkillEvolutionRequest = Schema.Union([
  action("sources", { expertId: Id }),
  action("capabilities", {}),
  action("learningRead", { expertId: Id }),
  action("learningChanges", { expertId: Id }),
  action("learningReadMemory", { expertId: Id, changeId: Id, revision: PositiveInt }),
  action("learningReadSkillChange", { expertId: Id, changeId: Id }),
  action("learningEditMemory", {
    expertId: Id,
    changeId: Id,
    requestId: Id,
    expectedRevision: PositiveInt,
    content: TrimmedNonEmptyString.check(Schema.isMaxLength(4_000)),
    validUntil: Schema.optional(IsoDateTime),
  }),
  action("learningRevert", {
    expertId: Id,
    changeId: Id,
    operationId: Id,
    expectedRevision: Schema.optional(NonNegativeInt),
  }),
  action("learningSet", {
    expertId: Id,
    requestId: Id,
    expectedRevision: NonNegativeInt,
    enabled: Schema.Boolean,
    harnessKind: Schema.optional(Schema.Literals(["omp", "pi"])),
  }),
  action("list", { expertId: Id }),
  action("start", {
    requestId: Id,
    expertId: Id,
    sources: Schema.Array(SkillEvolutionSourceSelection).check(
      Schema.isMinLength(1),
      Schema.isMaxLength(5),
    ),
    focus: Schema.optional(ShortText),
    modelSelection: ModelSelection,
  }),
  action("generate", {
    requestId: Id,
    discoveryRequestId: Id,
    opportunityId: Id,
    expectedDigest: Digest,
    feedback: Schema.optional(ShortText),
  }),
  action("dismissOpportunity", {
    requestId: Id,
    opportunityId: Id,
    expectedDigest: Digest,
  }),
  action("read", { requestId: Id }),
  action("cancel", { requestId: Id }),
  action("edit", {
    requestId: Id,
    proposalId: Id,
    expectedDigest: Digest,
    name: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
    changes: Schema.Array(SkillFileChange).check(Schema.isMaxLength(100)),
  }),
  action("apply", {
    requestId: Id,
    proposalId: Id,
    expectedDigest: Digest,
    operationId: Id,
  }),
  action("reject", { requestId: Id, proposalId: Id, expectedDigest: Digest }),
  action("graph", { expertId: Id, at: Schema.optional(IsoDateTime) }),
  action("previewRestore", { eventId: Id, expertId: Id }),
  action("previewBindingRestore", { eventId: Id, expertId: Id }),
  action("restoreBinding", {
    eventId: Id,
    expertId: Id,
    operationId: Id,
    expectedDigest: Digest,
  }),
  action("restore", {
    eventId: Id,
    expertId: Id,
    operationId: Id,
    expectedRevision: PositiveInt,
  }),
]);
export type SkillEvolutionRequest = typeof SkillEvolutionRequest.Type;
export const SkillEvolutionResponse = Schema.Struct({
  learningChanges: Schema.optional(Schema.Array(LearningChangeSet)),
  learningSkillChange: Schema.optional(LearningSkillChangeDetail),
  memoryEntry: Schema.optional(SpaceMemoryEntry),
  learningChange: Schema.optional(LearningChangeSet),
  learningStatus: Schema.optional(
    Schema.Literals(["committed", "saved_unbound", "deferred", "unchanged"]),
  ),
  learningState: Schema.optional(ExpertLearningState),
  sources: Schema.optional(Schema.Array(SkillEvolutionSource)),
  capabilities: Schema.optional(Schema.Array(SkillEvolutionCapability)),
  runs: Schema.optional(Schema.Array(SkillEvolutionRun)),
  run: Schema.optional(SkillEvolutionRun),
  graph: Schema.optional(SkillEvolutionGraph),
  skill: Schema.optional(SkillDefinition),
  restorePreview: Schema.optional(
    Schema.Struct({
      eventId: Id,
      skill: SkillDefinition,
      changes: Schema.Array(SkillFileChange),
      affectedExpertIds: Schema.Array(Id),
    }),
  ),
  bindingRestorePreview: Schema.optional(
    Schema.Struct({
      eventId: Id,
      expertId: Id,
      expertRevision: PositiveInt,
      fromSkill: SkillDefinition,
      toSkill: SkillDefinition,
      before: Schema.Array(ExpertSkillBinding),
      after: Schema.Array(ExpertSkillBinding),
      digest: Digest,
    }),
  ),
});
export type SkillEvolutionResponse = typeof SkillEvolutionResponse.Type;
export const SkillEvolutionRpcInput = Schema.Struct({ request: SkillEvolutionRequest });

/** Model output is untrusted content; no IDs, policies, approvals or ownership are writable. */
export const SkillEvolutionModelResult = Schema.Union([
  action("no_change", { reason: ShortText }),
  action("insufficient_evidence", { reason: ShortText }),
  action("proposals", {
    proposals: Schema.Array(
      Schema.Struct({
        name: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
        summary: ShortText,
        evidence: Schema.Array(SkillEvolutionEvidence).check(
          Schema.isMinLength(1),
          Schema.isMaxLength(20),
        ),
        files: Schema.Array(
          Schema.Struct({
            path: TrimmedNonEmptyString.check(Schema.isMaxLength(4_096)),
            text: Schema.optional(Schema.String.check(Schema.isMaxLength(262_144))),
            remove: Schema.optional(Schema.Boolean),
          }).annotate({ parseOptions: { onExcessProperty: "error" } }),
        ).check(Schema.isMinLength(1), Schema.isMaxLength(100)),
      }).annotate({ parseOptions: { onExcessProperty: "error" } }),
    ).check(Schema.isMinLength(1), Schema.isMaxLength(3)),
  }),
]);
export type SkillEvolutionModelResult = typeof SkillEvolutionModelResult.Type;

/** Discovery proposes experience, never files, approvals, ownership or a write action. */
export const SkillEvolutionDiscoveryResult = Schema.Union([
  action("no_change", { reason: ShortText }),
  action("insufficient_evidence", { reason: ShortText }),
  action("opportunities", {
    opportunities: Schema.Array(
      Schema.Struct({
        name: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
        reason: OpportunityText,
        outcomes: Schema.Array(OpportunityText).check(Schema.isMinLength(1), Schema.isMaxLength(8)),
        evidence: Schema.Array(SkillEvolutionEvidence).check(
          Schema.isMinLength(1),
          Schema.isMaxLength(20),
        ),
        targetSkillId: Schema.optional(SkillId),
        memory: Schema.optional(LearningMemoryDraft),
      }).annotate({ parseOptions: { onExcessProperty: "error" } }),
    ).check(Schema.isMinLength(1), Schema.isMaxLength(3)),
  }),
]);
export type SkillEvolutionDiscoveryResult = typeof SkillEvolutionDiscoveryResult.Type;
