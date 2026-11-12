import { Schema } from "effect";

import { IsoDateTime, PositiveInt, ThreadId } from "./baseSchemas";
import { ProviderDriverKind } from "./providerInstance";
import {
  SuiteContentHash,
  SuiteDescription,
  SuitePath,
  SuiteRelativePath,
  SuiteRequestId,
} from "./suite";

/** Business identity only. Provider-native execution IDs belong to the Adapter. */
export const ExpertDelegation = Schema.Struct({
  delegationId: SuitePath,
  parentThreadId: ThreadId,
  parentRootRunId: SuitePath,
  targetExpertId: SuitePath,
  task: SuiteDescription.check(Schema.isMinLength(1)),
  context: SuiteDescription,
  deliverable: SuiteDescription,
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type ExpertDelegation = typeof ExpertDelegation.Type;

export const ExpertDelegationState = Schema.Literals([
  "prepared",
  "starting",
  "running",
  "cancel-requested",
  "completed",
  "failed",
  "stopped",
  "unknown",
]);
export type ExpertDelegationState = typeof ExpertDelegationState.Type;
export const ExpertDelegationAttempt = Schema.Struct({
  attemptId: SuitePath,
  delegationId: SuitePath,
  requestId: SuiteRequestId,
  requestHash: SuiteContentHash,
  provider: ProviderDriverKind,
  capabilityBindingId: SuitePath,
  assemblyId: SuitePath,
  /** Opaque host key, never a native ID, serialized credential, or protocol sequence. */
  executionBindingId: Schema.NullOr(SuitePath),
  state: ExpertDelegationState,
  revision: PositiveInt,
  resultRef: Schema.NullOr(SuitePath),
  resultHash: Schema.NullOr(SuiteContentHash),
  appliedEventId: Schema.NullOr(SuitePath),
  updatedAt: IsoDateTime,
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type ExpertDelegationAttempt = typeof ExpertDelegationAttempt.Type;

export const ExpertDelegationResult = Schema.Struct({
  summary: SuiteDescription,
  artifacts: Schema.Array(
    Schema.Struct({
      path: SuiteRelativePath,
      sha256: SuiteContentHash,
      size: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    }).annotate({ parseOptions: { onExcessProperty: "error" } }),
  ).check(Schema.isMaxLength(100)),
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type ExpertDelegationResult = typeof ExpertDelegationResult.Type;
