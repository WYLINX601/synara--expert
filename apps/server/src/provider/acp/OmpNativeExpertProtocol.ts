import type { ProviderExpertSession, ThreadId } from "@synara/contracts";
import type { SuiteRuntimeContext } from "../../experts/SuiteRunMaterialization";

/** Private Adapter metadata. It is never a product DTO or model-provided authority. */
export interface OmpNativeTaskPromptMetadata {
  readonly parentGeneration: string;
  readonly parentTurnId: string;
  readonly targetAgentNames: readonly string[];
}

export interface OmpNativeExpertProtocol {
  /** Private agents-only discovery catalogue bound to the actual connection via the capabilities handshake. */
  readonly agentDirectory: string;
  readonly targetAgentNames: readonly string[];
  /** Bind only the actual session returned by the already-verified ACP transport. */
  readonly bindSession: (sessionId: string) => Promise<void>;
  readonly preparePrompt: (input: {
    readonly sessionId: string;
    readonly parentTurnId: string;
    readonly parentRootRunId: string;
  }) => Promise<OmpNativeTaskPromptMetadata>;
  readonly handleRequest: (method: string, params: unknown) => Promise<unknown>;
  /** Stop one persisted native execution only, after durable cancellation/revocation. */
  readonly cancelTask: (nativeTaskId: string) => Promise<void>;
  /** Revoke local authority and retain unknown outcomes without awaiting the native peer. */
  readonly close: () => Promise<void>;
}

/** Supplied by the trusted host composition root, not a user/provider option. */
export type OmpNativeExpertProtocolFactory = (context: {
  readonly threadId: ThreadId;
  readonly generation: string;
  readonly cwd: string;
  readonly expertSession?: ProviderExpertSession;
  readonly runtimeContext?: SuiteRuntimeContext;
  readonly capabilityBindingId?: string;
  readonly assemblyId?: string;
  /** Bound to the actual ACP connection; only seven negotiated private methods are used. */
  readonly buildFingerprint: string;
  readonly request: (method: string, params: unknown) => Promise<unknown>;
}) => Promise<OmpNativeExpertProtocol | null>;
