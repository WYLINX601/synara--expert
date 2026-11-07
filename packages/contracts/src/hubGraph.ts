import { Schema } from "effect";

import { NonNegativeInt, PositiveInt, TrimmedNonEmptyString } from "./baseSchemas";

export const HUB_GRAPH_SCHEMA_VERSION = 1 as const;
export const HUB_GRAPH_MAX_NODES = 100;
export const HUB_GRAPH_MAX_INTERACTION_BLOCKS = 32;
export const HUB_GRAPH_MAX_EDGES = 200;
export const HUB_GRAPH_MAX_INTERACTION_ROUNDS = 10;

export const HubGraphNodeId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(64),
  Schema.isPattern(/^[a-z][a-z0-9_-]*$/),
);
export type HubGraphNodeId = typeof HubGraphNodeId.Type;

export const HubGraphBlockId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(64),
  Schema.isPattern(/^[a-z][a-z0-9_-]*$/),
);
export type HubGraphBlockId = typeof HubGraphBlockId.Type;

export const HubGraphEdgeId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(96),
  Schema.isPattern(/^[a-z][a-z0-9_.:-]*$/),
);
export type HubGraphEdgeId = typeof HubGraphEdgeId.Type;

export const HubGraphPrompt = Schema.Struct({
  objective: TrimmedNonEmptyString.check(Schema.isMaxLength(8_000)),
  instructions: Schema.optional(Schema.String.check(Schema.isMaxLength(16_000))),
  acceptanceCriteria: Schema.optional(
    Schema.Array(TrimmedNonEmptyString.check(Schema.isMaxLength(1_000)))
      .check(Schema.isMaxLength(20)),
  ),
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type HubGraphPrompt = typeof HubGraphPrompt.Type;

export const HubGraphInput = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("user_request"),
  }),
  Schema.Struct({
    kind: Schema.Literal("node_output"),
    nodeId: HubGraphNodeId,
  }),
  Schema.Struct({
    kind: Schema.Literal("interaction_response"),
    blockId: HubGraphBlockId,
  }),
]).annotate({ parseOptions: { onExcessProperty: "error" } });
export type HubGraphInput = typeof HubGraphInput.Type;

export const HubGraphOutputContract = Schema.Struct({
  kind: Schema.Literals(["artifact", "structured"]),
  required: Schema.Boolean,
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type HubGraphOutputContract = typeof HubGraphOutputContract.Type;

export const HubGraphAgentOperation = Schema.Literals([
  "task",
  "merge",
  "decision",
  "respond",
]);
export type HubGraphAgentOperation = typeof HubGraphAgentOperation.Type;

export const HubGraphAgentNode = Schema.Struct({
  id: HubGraphNodeId,
  kind: Schema.Literal("agent"),
  expertId: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
  operation: HubGraphAgentOperation,
  prompt: HubGraphPrompt,
  inputs: Schema.Array(HubGraphInput).check(Schema.isMaxLength(32)),
  join: Schema.optional(Schema.Literals(["all", "any"])),
  output: Schema.optional(HubGraphOutputContract),
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type HubGraphAgentNode = typeof HubGraphAgentNode.Type;

export const HubGraphHumanDecision = Schema.Literals(["approve", "return", "reject"]);
export type HubGraphHumanDecision = typeof HubGraphHumanDecision.Type;

export const HubGraphHumanNode = Schema.Struct({
  id: HubGraphNodeId,
  kind: Schema.Literal("human"),
  operation: Schema.Literal("gate"),
  title: TrimmedNonEmptyString.check(Schema.isMaxLength(240)),
  decisions: Schema.Array(HubGraphHumanDecision)
    .check(Schema.isMinLength(2))
    .check(Schema.isMaxLength(3)),
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type HubGraphHumanNode = typeof HubGraphHumanNode.Type;

export const HubGraphNode = Schema.Union([HubGraphAgentNode, HubGraphHumanNode]);
export type HubGraphNode = typeof HubGraphNode.Type;

export const HubGraphInteractionBlock = Schema.Struct({
  id: HubGraphBlockId,
  protocol: TrimmedNonEmptyString.check(
    Schema.isMaxLength(96),
    Schema.isPattern(/^[a-z][a-z0-9_.-]*\.v[1-9][0-9]*$/),
  ),
  initiatorNodeId: HubGraphNodeId,
  responderNodeId: HubGraphNodeId,
  trigger: Schema.Literal("initiator_request"),
  maxRounds: PositiveInt,
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type HubGraphInteractionBlock = typeof HubGraphInteractionBlock.Type;

export const HubGraphEdgeCondition = Schema.Struct({
  field: Schema.Literal("outcome"),
  equals: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type HubGraphEdgeCondition = typeof HubGraphEdgeCondition.Type;

export const HubGraphEdge = Schema.Struct({
  id: HubGraphEdgeId,
  from: TrimmedNonEmptyString.check(Schema.isMaxLength(64)),
  to: TrimmedNonEmptyString.check(Schema.isMaxLength(64)),
  when: Schema.optional(HubGraphEdgeCondition),
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type HubGraphEdge = typeof HubGraphEdge.Type;

/**
 * A Graph Definition is an immutable, declarative plan.
 * Runtime state, Thread IDs and HubWork IDs belong to GraphRun records, not here.
 */
export const HubGraphDefinition = Schema.Struct({
  schemaVersion: Schema.Literal(HUB_GRAPH_SCHEMA_VERSION),
  objective: TrimmedNonEmptyString.check(Schema.isMaxLength(16_000)),
  sourceMessageIds: Schema.Array(TrimmedNonEmptyString)
    .check(Schema.isMinLength(1))
    .check(Schema.isMaxLength(16)),
  nodes: Schema.Array(HubGraphNode)
    .check(Schema.isMinLength(1))
    .check(Schema.isMaxLength(HUB_GRAPH_MAX_NODES)),
  interactionBlocks: Schema.Array(HubGraphInteractionBlock)
    .check(Schema.isMaxLength(HUB_GRAPH_MAX_INTERACTION_BLOCKS)),
  edges: Schema.Array(HubGraphEdge).check(Schema.isMaxLength(HUB_GRAPH_MAX_EDGES)),
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type HubGraphDefinition = typeof HubGraphDefinition.Type;

export const HubGraphRunStatus = Schema.Literals([
  "draft",
  "active",
  "paused",
  "completed",
  "failed",
  "cancelled",
]);
export type HubGraphRunStatus = typeof HubGraphRunStatus.Type;

export const HubGraphNodeExecutionStatus = Schema.Literals([
  "pending",
  "ready",
  "queued",
  "running",
  "settled",
  "completed",
  "failed",
  "blocked",
  "cancelled",
  "stale",
]);
export type HubGraphNodeExecutionStatus = typeof HubGraphNodeExecutionStatus.Type;

export const HubGraphInteractionStatus = Schema.Literals([
  "waiting_initiator",
  "dispatching_responder",
  "waiting_responder",
  "completed",
  "exhausted",
  "blocked",
  "cancelled",
]);
export type HubGraphInteractionStatus = typeof HubGraphInteractionStatus.Type;

export const HubGraphGateStatus = Schema.Literals([
  "pending",
  "approved",
  "returned",
  "rejected",
  "cancelled",
]);
export type HubGraphGateStatus = typeof HubGraphGateStatus.Type;

export const HubGraphRunVersion = Schema.Struct({
  status: HubGraphRunStatus,
  stateVersion: NonNegativeInt,
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type HubGraphRunVersion = typeof HubGraphRunVersion.Type;

export const HubGraphInteractionRuntime = Schema.Struct({
  status: HubGraphInteractionStatus,
  round: NonNegativeInt,
  maxRounds: PositiveInt,
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type HubGraphInteractionRuntime = typeof HubGraphInteractionRuntime.Type;
