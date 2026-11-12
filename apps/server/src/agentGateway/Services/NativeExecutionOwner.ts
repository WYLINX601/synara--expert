import type { ProviderKind, ThreadId } from "@synara/contracts";
import { ServiceMap, type Effect } from "effect";

import type { AgentGatewayNativeExecution } from "./AgentGatewaySessionRegistry.ts";

/** Public opaque identities only; provider execution and lifecycle details stay with their owner. */
export interface NativeExecutionIdentity extends AgentGatewayNativeExecution {
  readonly provider: ProviderKind;
  readonly threadId: ThreadId;
}

export interface NativeExecutionOwnerShape {
  readonly isExecutionActive: (
    identity: NativeExecutionIdentity,
  ) => Effect.Effect<boolean, unknown>;
}

export class NativeExecutionOwner extends ServiceMap.Service<
  NativeExecutionOwner,
  NativeExecutionOwnerShape
>()("synara/agentGateway/Services/NativeExecutionOwner") {}
