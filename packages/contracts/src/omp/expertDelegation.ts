import { Schema } from "effect";

import { IsoDateTime, PositiveInt, ThreadId } from "../baseSchemas";
import { ExpertDelegationResult } from "../expertDelegation";
import { ProviderExpertSession } from "../provider";
import { ResolvedExpertSkillEntry } from "../skillPackage";
import { SuiteContentHash, SuiteDescription, SuiteIssue, SuitePath } from "../suite";

export const OMP_NATIVE_EXPERT_PROTOCOL_VERSION = 1;
export const OMP_NATIVE_EXPERT_METHODS = {
  capabilities: "synara/nativeTaskCapabilities",
  prepare: "synara/prepareNativeTask",
  started: "synara/nativeTaskStarted",
  event: "synara/nativeTaskEvent",
  query: "synara/queryNativeTask",
  cancel: "synara/cancelNativeTask",
  credential: "synara/resolveNativeTaskCredential",
} as const;

// Actual native scheduling determines whether Task returns the result inline
// or the host must resume the parent. This never enters the business ledger.
const OmpNativeTaskDeliveryMode = Schema.Literals(["native-return", "host-continuation"]);

export const OmpNativeTaskCapabilitiesRequest = Schema.Struct({
  protocolVersion: Schema.Literal(1),
  /** Host-owned agents-only projection, bound to this ACP connection. */
  catalogDirectory: Schema.optional(SuitePath),
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export const OmpNativeTaskCapabilities = Schema.Struct({
  protocolVersion: Schema.Literal(1),
  buildFingerprint: SuiteContentHash,
  targetProfiles: Schema.Literal(true),
  lifecycle: Schema.Literal(true),
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type OmpNativeTaskCapabilities = typeof OmpNativeTaskCapabilities.Type;

export const OmpNativeExpertProfile = Schema.Struct({
  protocolVersion: Schema.Literal(1),
  attemptId: SuitePath,
  capabilityBindingId: SuitePath,
  assemblyId: SuitePath,
  targetAgentName: SuitePath,
  persona: ProviderExpertSession.fields.persona,
  /** Host-assigned output staging; Provider paths never enlarge host filesystem scope. */
  artifactRoot: SuitePath,
  skills: Schema.Array(Schema.Struct({ name: SuitePath, path: SuitePath })).check(
    Schema.isMaxLength(5_000),
  ),
  skillEntries: Schema.Array(ResolvedExpertSkillEntry).check(Schema.isMaxLength(5_000)),
  contextFiles: Schema.Array(
    Schema.Struct({ path: SuitePath, contentHash: SuiteContentHash }),
  ).check(Schema.isMaxLength(5_000)),
  resourceRoots: Schema.Array(
    Schema.Struct({ path: SuitePath, contentHash: SuiteContentHash }),
  ).check(Schema.isMaxLength(5_000)),
  mcpServers: Schema.Array(
    Schema.Struct({ name: SuitePath, url: SuitePath, credentialHandle: SuitePath }),
  ).check(Schema.isMaxLength(5_000)),
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type OmpNativeExpertProfile = typeof OmpNativeExpertProfile.Type;

export const OmpPrepareNativeTaskRequest = Schema.Struct({
  parentSessionId: SuitePath,
  parentGeneration: SuitePath,
  parentTurnId: SuitePath,
  toolCallId: SuitePath,
  taskIndex: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  nativeTaskId: SuitePath,
  agentName: SuitePath,
  task: SuiteDescription.check(Schema.isMinLength(1)),
  deliveryMode: OmpNativeTaskDeliveryMode,
  context: SuiteDescription,
  deliverable: SuiteDescription,
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type OmpPrepareNativeTaskRequest = typeof OmpPrepareNativeTaskRequest.Type;
export const OmpPrepareNativeTaskResponse = Schema.Struct({
  attemptId: SuitePath,
  capabilityBindingId: SuitePath,
  assemblyId: SuitePath,
  profile: OmpNativeExpertProfile,
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type OmpPrepareNativeTaskResponse = typeof OmpPrepareNativeTaskResponse.Type;
export const OmpNativeTaskStartedRequest = Schema.Struct({
  attemptId: SuitePath,
  nativeTaskId: SuitePath,
  nativeSessionId: SuitePath,
  parentGeneration: SuitePath,
  /** Second phase only: the already-bound SDK and target MCP initialization have completed. */
  initializationComplete: Schema.optional(Schema.Literal(true)),
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type OmpNativeTaskStartedRequest = typeof OmpNativeTaskStartedRequest.Type;
export const OmpNativeTaskStartedAck = Schema.Struct({
  attemptId: SuitePath,
  nativeTaskId: SuitePath,
  nativeSessionId: SuitePath,
  disposition: Schema.Literals(["accepted", "duplicate"]),
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type OmpNativeTaskStartedAck = typeof OmpNativeTaskStartedAck.Type;

export const OmpNativeTaskEvent = Schema.Struct({
  protocolVersion: Schema.Literal(1),
  attemptId: SuitePath,
  nativeTaskId: SuitePath,
  parentGeneration: SuitePath,
  sequence: PositiveInt,
  payload: Schema.Union([
    Schema.Struct({ kind: Schema.Literal("progress"), message: SuiteDescription }).annotate({
      parseOptions: { onExcessProperty: "error" },
    }),
    Schema.Struct({
      kind: Schema.Literal("terminal"),
      outcome: Schema.Literals(["completed", "failed", "stopped"]),
      result: ExpertDelegationResult,
      issue: Schema.NullOr(SuiteIssue),
    }).annotate({ parseOptions: { onExcessProperty: "error" } }),
  ]),
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type OmpNativeTaskEvent = typeof OmpNativeTaskEvent.Type;
export const OmpNativeTaskAck = Schema.Struct({
  attemptId: SuitePath,
  sequence: PositiveInt,
  disposition: Schema.Literals(["accepted", "duplicate"]),
  resultRef: Schema.NullOr(SuitePath),
  resultHash: Schema.NullOr(SuiteContentHash),
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type OmpNativeTaskAck = typeof OmpNativeTaskAck.Type;
export const OmpNativeTaskReference = Schema.Struct({
  attemptId: SuitePath,
  nativeTaskId: SuitePath,
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type OmpNativeTaskReference = typeof OmpNativeTaskReference.Type;
export const OmpNativeTaskObservation = Schema.Union([
  Schema.Struct({ state: Schema.Literal("not-found") }),
  Schema.Struct({
    state: Schema.Literals(["starting", "running", "cancel-requested"]),
    nativeSessionId: Schema.NullOr(SuitePath),
    lastSequence: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  }),
  Schema.Struct({
    state: Schema.Literal("terminal"),
    nativeSessionId: SuitePath,
    terminalEvent: OmpNativeTaskEvent,
  }),
]);
export type OmpNativeTaskObservation = typeof OmpNativeTaskObservation.Type;
export const OmpNativeTaskCancelAck = Schema.Struct({ accepted: Schema.Boolean });
export const OmpNativeTaskCredentialRequest = Schema.Struct({
  attemptId: SuitePath,
  nativeTaskId: SuitePath,
  credentialHandle: SuitePath,
  parentGeneration: SuitePath,
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type OmpNativeTaskCredentialRequest = typeof OmpNativeTaskCredentialRequest.Type;
export const OmpNativeTaskCredential = Schema.Struct({
  authorization: SuitePath,
  expiresAt: IsoDateTime,
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type OmpNativeTaskCredential = typeof OmpNativeTaskCredential.Type;

/** Adapter-owned persisted association, committed atomically with the public attempt. */
export const OmpDelegationExecution = Schema.Struct({
  executionBindingId: SuitePath,
  attemptId: SuitePath,
  provider: Schema.Literal("omp"),
  parentThreadId: ThreadId,
  parentGeneration: SuitePath,
  parentTurnId: SuitePath,
  toolCallId: SuitePath,
  taskIndex: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  nativeTaskId: SuitePath,
  nativeSessionId: Schema.NullOr(SuitePath),
  deliveryMode: OmpNativeTaskDeliveryMode,
  /** Host-captured canonical workspace, never accepted from a model/tool argument. */
  workRoot: SuitePath,
  artifactRoot: SuitePath,
  lastSequence: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type OmpDelegationExecution = typeof OmpDelegationExecution.Type;
