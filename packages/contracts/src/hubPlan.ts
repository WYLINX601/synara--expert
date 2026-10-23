import { Schema } from "effect";

import {
  HubDeliverableExpertSummary,
  HubDeliverableFile,
  HubDeliverableProvenance,
  HubDeliverableReferenceMetadata,
} from "./hubDeliverables";
import {
  IsoDateTime,
  MessageId,
  NonNegativeInt,
  PositiveInt,
  ProjectGoalId,
  ProjectId,
  ProjectTaskId,
  ProjectTaskAttemptId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas";
import { ModelSelection } from "./orchestration";
import { ProjectTaskStatus } from "./projectAgent";
import { HubWorkState } from "./hubWork";
import { AsyncUserInputQuestions } from "./asyncUserInput";

export const HUB_PLAN_MAX_STAGES = 12;
export const HUB_PLAN_MAX_NODES = 64;
export const HUB_PLAN_MAX_REVIEWERS_PER_STAGE = 8;
export const HUB_PLAN_MAX_REPAIR_ROUNDS = 20;
export const HUB_PLAN_MAX_SOURCE_MESSAGES = 16;
export const HUB_PLAN_MAX_INPUT_REQUESTS = 256;

const PlanKey = TrimmedNonEmptyString.check(Schema.isMaxLength(128));
const PlanText = Schema.String.check(Schema.isMaxLength(16_000));
const RequestId = TrimmedNonEmptyString.check(Schema.isMaxLength(256));
const PlanId = TrimmedNonEmptyString.check(Schema.isMaxLength(128));
const CandidateId = TrimmedNonEmptyString.check(Schema.isMaxLength(256));
const OutputDigest = TrimmedNonEmptyString.check(Schema.isMaxLength(256));
const PlanComment = Schema.String.check(Schema.isMaxLength(4_000));
const InputRequestId = TrimmedNonEmptyString.check(Schema.isMaxLength(128));
const InputAnswers = Schema.Array(TrimmedNonEmptyString.check(Schema.isMaxLength(4_000))).check(
  Schema.isMinLength(1),
  Schema.isMaxLength(3),
);
const BoundedInputQuestions = AsyncUserInputQuestions.check(
  Schema.makeFilter(
    (questions) =>
      questions.length <= 3 &&
      questions.every(
        (question) =>
          question.title.length <= 4_000 &&
          (question.options === undefined ||
            (question.options.length <= 8 &&
              question.options.every((option) => option.length <= 240))),
      ),
  ),
);

const strictStruct = <Fields extends Schema.Struct.Fields>(fields: Fields) =>
  Schema.Struct(fields).annotate({ parseOptions: { onExcessProperty: "error" } });

const StrictHubDeliverableFile = strictStruct(HubDeliverableFile.fields);
const StrictHubDeliverableProvenance = strictStruct(HubDeliverableProvenance.fields);
const StrictHubDeliverableExpertSummary = strictStruct(HubDeliverableExpertSummary.fields);
const StrictHubDeliverableReferenceMetadata = strictStruct({
  ...HubDeliverableReferenceMetadata.fields,
  provenance: StrictHubDeliverableProvenance,
  file: StrictHubDeliverableFile,
  expertBinding: Schema.optional(StrictHubDeliverableExpertSummary),
});

const HubPlanStageDefinition = Schema.Struct({
  key: PlanKey,
  title: TrimmedNonEmptyString.check(Schema.isMaxLength(240)),
  releasePolicy: Schema.Literals(["auto", "user"]),
}).annotate({ parseOptions: { onExcessProperty: "error" } });

const HubPlanNodeDefinition = Schema.Struct({
  key: PlanKey,
  stageKey: PlanKey,
  title: TrimmedNonEmptyString.check(Schema.isMaxLength(240)),
  brief: PlanText,
  role: Schema.Literals(["author", "reviewer", "worker"]),
  expertId: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(128))),
  target: Schema.optional(ModelSelection),
  dependsOnNodeKeys: Schema.Array(PlanKey).check(Schema.isMaxLength(HUB_PLAN_MAX_NODES)),
  workMode: Schema.Literals(["agent", "co_create"]),
  acceptanceCriteria: PlanText,
}).annotate({ parseOptions: { onExcessProperty: "error" } });

/** Immutable proposal data for the Hub plan graph; it grants no execution authority. */
export const HubPlanDefinitionSchema = Schema.Struct({
  objective: TrimmedNonEmptyString.check(Schema.isMaxLength(16_000)),
  scope: TrimmedNonEmptyString.check(Schema.isMaxLength(16_000)),
  stages: Schema.Array(HubPlanStageDefinition).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(HUB_PLAN_MAX_STAGES),
  ),
  nodes: Schema.Array(HubPlanNodeDefinition).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(HUB_PLAN_MAX_NODES),
  ),
  maxRepairRounds: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).check(
    Schema.isLessThanOrEqualTo(HUB_PLAN_MAX_REPAIR_ROUNDS),
  ),
})
  .check(
    Schema.makeFilter((definition) =>
      definition.stages.every(
        (stage) =>
          definition.nodes.filter((node) => node.stageKey === stage.key && node.role === "author")
            .length === 1 &&
          definition.nodes.filter((node) => node.stageKey === stage.key && node.role === "reviewer")
            .length <= HUB_PLAN_MAX_REVIEWERS_PER_STAGE,
      ),
    ),
  )
  .annotate({ parseOptions: { onExcessProperty: "error" } });

export type HubPlanDefinition = typeof HubPlanDefinitionSchema.Type;
export type HubPlanStageDefinition = typeof HubPlanStageDefinition.Type;
export type HubPlanNodeDefinition = typeof HubPlanNodeDefinition.Type;

export const HubPlanControlStateSchema = Schema.Literals([
  "draft",
  "active",
  "pausing",
  "paused",
  "cancelling",
  "cancelled",
  "completed",
]);
export type HubPlanControlState = typeof HubPlanControlStateSchema.Type;

export const HubPlanStageStatusSchema = Schema.Literals([
  "draft",
  "not_started",
  "blocked",
  "ready",
  "queued",
  "running",
  "waiting",
  "awaiting_candidate",
  "reviewing",
  "changes_requested",
  "ready_to_release",
  "waiting_user",
  "released",
  "pausing",
  "paused",
  "cancelling",
  "cancelled",
]);
export type HubPlanStageStatus = typeof HubPlanStageStatusSchema.Type;

export const HubPlanStageViewSchema = strictStruct({
  stageKey: PlanKey,
  title: TrimmedNonEmptyString.check(Schema.isMaxLength(240)),
  releasePolicy: Schema.Literals(["auto", "user"]),
  generation: Schema.NullOr(PositiveInt),
  status: HubPlanStageStatusSchema,
  underlyingStatus: HubPlanStageStatusSchema,
  isReleased: Schema.Boolean,
  candidateId: Schema.NullOr(CandidateId),
  outputDigest: Schema.NullOr(OutputDigest),
  outputSummary: Schema.NullOr(PlanText),
  deliverableRefs: Schema.optional(
    Schema.Array(StrictHubDeliverableReferenceMetadata).check(Schema.isMaxLength(3)),
  ),
  blockingReasons: Schema.Array(PlanText).check(Schema.isMaxLength(64)),
});
export type HubPlanStageView = typeof HubPlanStageViewSchema.Type;

export const HubPlanGraphViewSchema = Schema.Struct({
  controlState: HubPlanControlStateSchema,
  stages: Schema.Array(HubPlanStageViewSchema).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(HUB_PLAN_MAX_STAGES),
  ),
  releasedCount: NonNegativeInt,
  stageCount: PositiveInt.check(Schema.isLessThanOrEqualTo(HUB_PLAN_MAX_STAGES)),
})
  .check(
    Schema.makeFilter(
      (graph) =>
        graph.stageCount === graph.stages.length &&
        graph.releasedCount === graph.stages.filter((stage) => stage.isReleased).length,
    ),
  )
  .annotate({ parseOptions: { onExcessProperty: "error" } });
export type HubPlanGraphView = typeof HubPlanGraphViewSchema.Type;

export const HubPlanNodeStateSchema = strictStruct({
  nodeKey: PlanKey,
  taskId: ProjectTaskId,
  workerThreadId: Schema.NullOr(ThreadId),
  attemptId: Schema.NullOr(ProjectTaskAttemptId),
  retryable: Schema.optional(Schema.Boolean),
  taskStatus: Schema.optional(ProjectTaskStatus),
  workState: Schema.optional(HubWorkState),
  progressSummary: Schema.optional(Schema.String.check(Schema.isMaxLength(2_000))),
  queueReason: Schema.optional(Schema.String),
  reviewOutcome: Schema.optional(Schema.Literals(["pass", "blocked", "changes_requested"])),
});
export type HubPlanNodeState = typeof HubPlanNodeStateSchema.Type;

/** A Worker question waiting for the Hub owner, scoped to one plan attempt. */
export const HubPlanInputRequestSchema = strictStruct({
  id: InputRequestId,
  nodeKey: PlanKey,
  stageKey: PlanKey,
  generation: PositiveInt,
  attemptId: ProjectTaskAttemptId,
  workerThreadId: ThreadId,
  questions: BoundedInputQuestions,
  status: Schema.Literals(["pending", "answered", "delivered", "stale"]),
  answers: Schema.optional(InputAnswers),
});
export type HubPlanInputRequest = typeof HubPlanInputRequestSchema.Type;

export const HubPlanSnapshotSchema = Schema.Struct({
  id: PlanId,
  hubId: ProjectId,
  goalId: Schema.NullOr(ProjectGoalId),
  revision: PositiveInt,
  stateVersion: PositiveInt,
  controlState: HubPlanControlStateSchema,
  definition: HubPlanDefinitionSchema,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  graph: HubPlanGraphViewSchema,
  nodeStates: Schema.Array(HubPlanNodeStateSchema).check(Schema.isMaxLength(HUB_PLAN_MAX_NODES)),
  inputRequests: Schema.optional(
    Schema.Array(HubPlanInputRequestSchema).check(Schema.isMaxLength(HUB_PLAN_MAX_INPUT_REQUESTS)),
  ),
  eventSequence: NonNegativeInt,
})
  .check(Schema.makeFilter((snapshot) => snapshot.graph.controlState === snapshot.controlState))
  .annotate({ parseOptions: { onExcessProperty: "error" } });
export type HubPlanSnapshot = typeof HubPlanSnapshotSchema.Type;

export const HubPlanEventPayloadSchema = Schema.Struct({
  snapshot: HubPlanSnapshotSchema,
  summary: Schema.optional(PlanText),
  comment: Schema.optional(PlanComment),
  inputRequest: Schema.optional(HubPlanInputRequestSchema),
  inputRequestId: Schema.optional(InputRequestId),
  answers: Schema.optional(InputAnswers),
}).annotate({ parseOptions: { onExcessProperty: "ignore" } });
export type HubPlanEventPayload = typeof HubPlanEventPayloadSchema.Type;

export const HubPlanEventSchema = strictStruct({
  sequence: PositiveInt,
  planId: PlanId,
  hubId: ProjectId,
  kind: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
  payload: HubPlanEventPayloadSchema,
  createdAt: IsoDateTime,
});
export type HubPlanEvent = typeof HubPlanEventSchema.Type;

export const HubPlanListInputSchema = strictStruct({ hubId: ProjectId });
export type HubPlanListInput = typeof HubPlanListInputSchema.Type;

export const HubPlanReadInputSchema = strictStruct({ hubId: ProjectId, planId: PlanId });
export type HubPlanReadInput = typeof HubPlanReadInputSchema.Type;

export const HubPlanEventsInputSchema = strictStruct({
  hubId: ProjectId,
  afterSequence: NonNegativeInt,
});
export type HubPlanEventsInput = typeof HubPlanEventsInputSchema.Type;

export const HubPlanProposeInputSchema = strictStruct({
  hubId: ProjectId,
  requestId: RequestId,
  planId: PlanId,
  expectedStateVersion: Schema.NullOr(PositiveInt),
  definition: HubPlanDefinitionSchema,
  sourceMessageIds: Schema.Array(MessageId).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(HUB_PLAN_MAX_SOURCE_MESSAGES),
  ),
});
export type HubPlanProposeInput = typeof HubPlanProposeInputSchema.Type;

const HubPlanCommandBase = {
  hubId: ProjectId,
  planId: PlanId,
  requestId: RequestId,
  expectedStateVersion: PositiveInt,
  expectedRevision: PositiveInt,
};

const HubPlanSimpleCommandSchema = strictStruct({
  ...HubPlanCommandBase,
  action: Schema.Literals(["confirm", "pause", "resume", "cancel"]),
});

const HubPlanStageReleaseCommandSchema = strictStruct({
  ...HubPlanCommandBase,
  action: Schema.Literals(["release", "return"]),
  stageKey: PlanKey,
  generation: PositiveInt,
  candidateId: CandidateId,
  outputDigest: OutputDigest,
  comment: Schema.optional(PlanComment),
});

export const HubPlanSubmitCandidateCommandSchema = strictStruct({
  ...HubPlanCommandBase,
  action: Schema.Literal("submitCandidate"),
  stageKey: PlanKey,
  generation: PositiveInt,
  nodeKey: PlanKey,
  attemptId: ProjectTaskAttemptId,
  deliverableRefs: Schema.Array(StrictHubDeliverableReferenceMetadata).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(3),
  ),
  summary: PlanText,
});

export const HubPlanSubmitReviewCommandSchema = strictStruct({
  ...HubPlanCommandBase,
  action: Schema.Literal("submitReview"),
  stageKey: PlanKey,
  generation: PositiveInt,
  nodeKey: PlanKey,
  attemptId: ProjectTaskAttemptId,
  candidateId: CandidateId,
  outputDigest: OutputDigest,
  outcome: Schema.Literals(["pass", "changes_requested", "blocked"]),
  summary: PlanText,
});

export const HubPlanRequestInputCommandSchema = strictStruct({
  ...HubPlanCommandBase,
  action: Schema.Literal("requestInput"),
  inputRequestId: InputRequestId,
  stageKey: PlanKey,
  generation: PositiveInt,
  nodeKey: PlanKey,
  attemptId: ProjectTaskAttemptId,
  questions: BoundedInputQuestions,
});

export const HubPlanRespondInputCommandSchema = strictStruct({
  ...HubPlanCommandBase,
  action: Schema.Literal("respondInput"),
  inputRequestId: InputRequestId,
  answers: InputAnswers,
});

export const HubPlanRetryCommandSchema = strictStruct({
  ...HubPlanCommandBase,
  action: Schema.Literal("retry"),
  nodeKey: PlanKey,
  stageKey: PlanKey,
  generation: PositiveInt,
  attemptId: ProjectTaskAttemptId,
});

export const HubPlanCommandInputSchema = Schema.Union([
  HubPlanSimpleCommandSchema,
  HubPlanStageReleaseCommandSchema,
  HubPlanSubmitCandidateCommandSchema,
  HubPlanSubmitReviewCommandSchema,
  HubPlanRequestInputCommandSchema,
  HubPlanRespondInputCommandSchema,
  HubPlanRetryCommandSchema,
]);
export type HubPlanCommandInput = typeof HubPlanCommandInputSchema.Type;

export interface HubPlansApi {
  list(input: HubPlanListInput): Promise<ReadonlyArray<HubPlanSnapshot>>;
  read(input: HubPlanReadInput): Promise<HubPlanSnapshot | null>;
  events(input: HubPlanEventsInput): Promise<ReadonlyArray<HubPlanEvent>>;
  propose(input: HubPlanProposeInput): Promise<HubPlanSnapshot>;
  command(input: HubPlanCommandInput): Promise<HubPlanSnapshot>;
}
