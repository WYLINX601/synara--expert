import type { CapabilityBinding, OrchestrationThreadShell } from "@synara/contracts";
import { Effect } from "effect";

import type { ExpertDelegationStoreShape } from "../workbench/host/expertDelegationStore.ts";
import { createExpertStore } from "../experts/ExpertStore.ts";
import { readRunSkillAssembly } from "../experts/RunSkillAssemblyStore.ts";
import type { ExpertGatewayToolResolver } from "../experts/ExpertGatewayTools.ts";
import {
  capabilityBindingFingerprint,
  type SuiteCompositionStoreShape,
} from "../suites/SuiteCompositionStore.ts";
import type { AgentGatewaySessionIdentity } from "./Services/AgentGatewaySessionRegistry.ts";
import type { NativeExecutionOwnerShape } from "./Services/NativeExecutionOwner.ts";
import { GatewayToolError, type ToolEntry } from "./toolRuntime.ts";

export interface NativeExecutionAuthorizer {
  (
    session: AgentGatewaySessionIdentity,
    parent: OrchestrationThreadShell,
  ): Effect.Effect<CapabilityBinding, GatewayToolError>;
}

/** Resolve common target authority and ask its execution owner to verify the live association. */
export function makeNativeExecutionAuthorizer(input: {
  readonly stateDir: string;
  readonly delegations?: Pick<ExpertDelegationStoreShape, "readAttempt" | "readDelegation">;
  readonly bindings?: Pick<SuiteCompositionStoreShape, "readBinding">;
  readonly executionOwner?: NativeExecutionOwnerShape;
}): NativeExecutionAuthorizer {
  const experts = createExpertStore(input.stateDir);
  return (
    session: AgentGatewaySessionIdentity,
    parent: OrchestrationThreadShell,
  ): Effect.Effect<CapabilityBinding, GatewayToolError> =>
    Effect.gen(function* () {
      const scope = session.nativeExecution;
      const denied = () =>
        new GatewayToolError(
          "caller_session_inactive",
          "The native execution lease does not match an active, trusted target binding.",
        );
      if ((parent.session?.providerName ?? parent.modelSelection.provider) !== session.provider)
        return yield* Effect.fail(denied());
      if (!scope || !input.delegations || !input.bindings || !input.executionOwner)
        return yield* Effect.fail(denied());
      const attempt = yield* input.delegations.readAttempt(scope.attemptId);
      if (
        !attempt ||
        attempt.state !== "running" ||
        attempt.provider !== session.provider ||
        attempt.executionBindingId !== scope.executionBindingId ||
        attempt.capabilityBindingId !== scope.capabilityBindingId ||
        attempt.assemblyId !== scope.assemblyId
      )
        return yield* Effect.fail(denied());
      const delegation = yield* input.delegations.readDelegation(attempt.delegationId);
      const binding = yield* input.bindings.readBinding(scope.capabilityBindingId);
      if (
        !delegation ||
        !binding ||
        binding.bindingId !== scope.capabilityBindingId ||
        binding.bindingHash !== capabilityBindingFingerprint(binding) ||
        delegation.parentThreadId !== session.threadId ||
        parent.id !== session.threadId ||
        delegation.parentRootRunId !== scope.parentRootRunId ||
        binding.projectId !== parent.projectId ||
        binding.purpose.kind !== "native-delegate" ||
        binding.purpose.parentThreadId !== session.threadId ||
        binding.purpose.parentRootRunId !== scope.parentRootRunId ||
        binding.purpose.attemptId !== scope.attemptId ||
        binding.purpose.delegationId !== delegation.delegationId
      )
        return yield* Effect.fail(denied());
      const snapshotId = binding.purpose.expertSnapshotId;
      const { snapshot, assembly } = yield* Effect.tryPromise(async () => ({
        snapshot: await experts.readSnapshot(snapshotId),
        // A native target's own common Run is its attempt, not the parent's active turn.
        assembly: await readRunSkillAssembly(input.stateDir, scope.attemptId),
      }));
      if (
        snapshot.expertId !== delegation.targetExpertId ||
        !assembly ||
        assembly.schemaVersion !== 2 ||
        assembly.threadId !== session.threadId ||
        assembly.rootRunId !== scope.attemptId ||
        assembly.assemblyId !== scope.assemblyId ||
        assembly.bindingId !== binding.bindingId ||
        assembly.bindingHash !== binding.bindingHash ||
        assembly.baseSnapshotId !== snapshotId
      )
        return yield* Effect.fail(denied());
      const learning = session.learningSession;
      if (
        learning &&
        (learning.rootRunId !== scope.attemptId ||
          learning.snapshotId !== snapshotId ||
          learning.scope.expertId !== snapshot.expertId ||
          learning.scope.projectId !== binding.projectId)
      )
        return yield* Effect.fail(denied());
      if (
        !(yield* input.executionOwner.isExecutionActive({
          ...scope,
          provider: session.provider,
          threadId: session.threadId,
        }))
      )
        return yield* Effect.fail(denied());
      return binding;
    }).pipe(
      Effect.mapError((cause) =>
        cause instanceof GatewayToolError
          ? cause
          : new GatewayToolError(
              "caller_session_inactive",
              "The native execution authorization could not be verified; this lease cannot be used.",
            ),
      ),
    );
}

/** One trusted branch selection shared by the Gateway Layer and its invocation regressions. */
export function makeAgentGatewaySessionToolResolver(input: {
  readonly requireThreadShell: (
    threadId: string,
  ) => Effect.Effect<OrchestrationThreadShell, unknown>;
  readonly authorizeNativeExecution: NativeExecutionAuthorizer;
  readonly bindings?: Pick<SuiteCompositionStoreShape, "readBinding">;
  readonly expertTools: ExpertGatewayToolResolver;
}) {
  return (session: AgentGatewaySessionIdentity): Effect.Effect<ReadonlyArray<ToolEntry>> =>
    Effect.gen(function* () {
      const shell = yield* input.requireThreadShell(session.threadId);
      if (session.nativeExecution) {
        const binding = yield* input.authorizeNativeExecution(session, shell);
        return yield* Effect.tryPromise(() =>
          input.expertTools.resolveBinding(session.sessionKey, binding),
        );
      }
      if (shell.capabilityBindingId) {
        if (!input.bindings)
          return yield* Effect.fail(new Error("Capability binding owner is unavailable."));
        const binding = yield* input.bindings.readBinding(shell.capabilityBindingId);
        if (
          !binding ||
          binding.projectId !== shell.projectId ||
          binding.purpose.kind === "native-delegate" ||
          (binding.purpose.kind === "hub-coordinator"
            ? shell.expertBinding != null
            : binding.purpose.expertSnapshotId !== shell.expertBinding?.snapshotId)
        )
          return yield* Effect.fail(new Error("Thread capability binding identity is invalid."));
        return yield* Effect.tryPromise(() =>
          input.expertTools.resolveBinding(session.sessionKey, binding),
        );
      }
      return shell.expertBinding
        ? yield* Effect.tryPromise(() =>
            input.expertTools.resolve(session.sessionKey, shell.expertBinding!.snapshotId),
          )
        : [];
    }).pipe(
      Effect.catch((error) =>
        Effect.logWarning("gateway target tool resolution failed", {
          error,
          threadId: session.threadId,
        }).pipe(Effect.as<ReadonlyArray<ToolEntry>>([])),
      ),
    );
}
