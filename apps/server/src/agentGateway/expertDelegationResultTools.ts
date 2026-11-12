import type { OrchestrationThreadShell } from "@synara/contracts";
import { Effect } from "effect";
import type { ExpertDelegationArtifactsShape } from "../workbench/host/expertDelegationArtifacts";
import type { ExpertDelegationStoreShape } from "../workbench/host/expertDelegationStore";
import { createExpertStore } from "../experts/ExpertStore";
import {
  capabilityBindingFingerprint,
  type SuiteCompositionStoreShape,
} from "../suites/SuiteCompositionStore";
import { mcpToolResultJson } from "./protocol";
import { readStringArg } from "./toolInput";
import {
  GatewayToolError,
  gatewayToolErrorResult,
  READ_ONLY_TOOL_ANNOTATIONS,
  type ToolEntry,
} from "./toolRuntime";

/** Result refs and paths are data, never authority to another task or file pool. */
export function makeExpertDelegationResultTools(input: {
  readonly stateDir: string;
  readonly artifacts: ExpertDelegationArtifactsShape;
  readonly delegations: Pick<ExpertDelegationStoreShape, "readAttempt" | "readDelegation">;
  readonly bindings: Pick<SuiteCompositionStoreShape, "readBinding">;
  readonly requireThreadShell: (
    threadId: string,
  ) => Effect.Effect<OrchestrationThreadShell, unknown>;
}): ReadonlyArray<ToolEntry> {
  const experts = createExpertStore(input.stateDir);
  return [
    {
      requiredCapability: "thread:read",
      definition: {
        name: "synara_read_expert_result",
        description:
          "Read an Expert delegation receipt belonging to this parent Task. Optionally read one declared artifact's immutable bytes (base64), not the mutable workspace file. The receipt identifies the actual author and attempt. resultRef and artifactPath never grant access to another Task.",
        inputSchema: {
          type: "object",
          required: ["resultRef"],
          properties: { resultRef: { type: "string" }, artifactPath: { type: "string" } },
          additionalProperties: false,
        },
        annotations: { title: "Read Expert result", ...READ_ONLY_TOOL_ANNOTATIONS },
      },
      handler: (args, context) =>
        Effect.gen(function* () {
          const resultRef = yield* Effect.try({
            try: () => readStringArg(args, "resultRef", { required: true }),
            catch: (cause) => cause,
          });
          const artifactPath = yield* Effect.try({
            try: () => readStringArg(args, "artifactPath"),
            catch: (cause) => cause,
          });
          const denied = new GatewayToolError(
            "permission_denied",
            "The result does not belong to this authorized parent Task and author binding.",
          );
          if (!resultRef?.startsWith("ndr_") || resultRef.length <= 4)
            return yield* Effect.fail(denied);
          const caller = yield* input.requireThreadShell(context.callerThreadId);
          if (caller.id !== context.principal.threadId || caller.id !== context.callerThreadId)
            return yield* Effect.fail(denied);
          const attempt = yield* input.delegations.readAttempt(resultRef.slice(4));
          if (!attempt || attempt.resultRef !== resultRef) return yield* Effect.fail(denied);
          const delegation = yield* input.delegations.readDelegation(attempt.delegationId);
          if (
            !delegation ||
            delegation.parentThreadId !== caller.id ||
            (context.nativeExecution &&
              context.nativeExecution.parentRootRunId !== delegation.parentRootRunId)
          )
            return yield* Effect.fail(denied);
          const binding = yield* input.bindings.readBinding(attempt.capabilityBindingId);
          if (
            !binding ||
            binding.bindingHash !== capabilityBindingFingerprint(binding) ||
            binding.projectId !== caller.projectId ||
            binding.purpose.kind !== "native-delegate" ||
            binding.purpose.attemptId !== attempt.attemptId ||
            binding.purpose.delegationId !== delegation.delegationId ||
            binding.purpose.parentThreadId !== caller.id ||
            binding.purpose.parentRootRunId !== delegation.parentRootRunId
          )
            return yield* Effect.fail(denied);
          const snapshotId = binding.purpose.expertSnapshotId;
          const snapshot = yield* Effect.tryPromise(() => experts.readSnapshot(snapshotId));
          if (snapshot.expertId !== delegation.targetExpertId) return yield* Effect.fail(denied);
          const result = yield* input.artifacts.read({
            attemptId: attempt.attemptId,
            ...(artifactPath !== undefined ? { artifactPath } : {}),
          });
          if (
            result.receipt.resultRef !== resultRef ||
            result.receipt.attemptId !== attempt.attemptId
          )
            return yield* Effect.fail(denied);
          return mcpToolResultJson({
            author: {
              expertId: delegation.targetExpertId,
              snapshotId: snapshot.snapshotId,
              capabilityBindingId: binding.bindingId,
              assemblyId: attempt.assemblyId,
            },
            delegationId: delegation.delegationId,
            parentThreadId: caller.id,
            parentRootRunId: delegation.parentRootRunId,
            ...result,
          });
        }).pipe(
          Effect.catch((cause) =>
            Effect.succeed(
              gatewayToolErrorResult(
                cause instanceof GatewayToolError
                  ? cause
                  : new GatewayToolError(
                      "result_unavailable",
                      "The result version could not be verified or read.",
                    ),
              ),
            ),
          ),
        ),
    },
  ];
}
