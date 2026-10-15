import {
  WS_METHODS,
  type ContextCommandResult,
  type ContextApi,
  type OrchestrationCommand,
  type WsRpcError,
} from "@synara/contracts";
import { Effect } from "effect";

import type { ContextRepositoryShape } from "../../context/ContextRepository.ts";

type RpcEffect = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  fallback: string,
) => Effect.Effect<A, WsRpcError, R>;
type Input<K extends keyof ContextApi> = Parameters<ContextApi[K]>[0];

/** Context uses the native command admission boundary; this layer never writes configuration. */
export function makeWorkbenchContextRpcHandlers(input: {
  readonly repository: ContextRepositoryShape;
  readonly dispatch: (command: OrchestrationCommand) => Effect.Effect<unknown, unknown>;
  readonly retryLoad: (request: Input<"retryLoad">) => Effect.Effect<ContextCommandResult, unknown>;
  readonly getThreadDetails?: (
    request: Input<"getThread">,
  ) => Effect.Effect<Awaited<ReturnType<ContextApi["getThread"]>>, unknown>;
  readonly rpcEffect: RpcEffect;
}) {
  const { repository, dispatch, rpcEffect } = input;
  const write = (command: OrchestrationCommand) =>
    dispatch(command).pipe(
      Effect.andThen(() => repository.getCommandResult(command.commandId)),
      Effect.catch((cause) =>
        cause !== null &&
        typeof cause === "object" &&
        "_tag" in cause &&
        cause._tag === "OrchestrationCommandIdentityCollisionError"
          ? Effect.fail(cause)
          : repository
              .getCommandResult(command.commandId)
              .pipe(
                Effect.flatMap((result) =>
                  result.status === "unknown" || result.status === "pending"
                    ? Effect.fail(cause)
                    : Effect.succeed(result),
                ),
              ),
      ),
    );
  return {
    [WS_METHODS.contextGetSpace]: (request: Input<"getSpace">) =>
      rpcEffect(repository.getSpace(request.spaceId), "Failed to read Space context"),
    [WS_METHODS.contextGetProject]: (request: Input<"getProject">) =>
      rpcEffect(repository.getProject(request.projectId), "Failed to read Project context"),
    [WS_METHODS.contextGetThread]: (request: Input<"getThread">) =>
      rpcEffect(
        input.getThreadDetails
          ? input.getThreadDetails(request)
          : repository.getThreadDetails(request.threadId),
        "Failed to read Thread context",
      ),
    [WS_METHODS.contextSaveSpace]: (request: Input<"saveSpace">) =>
      rpcEffect(write({ type: "context.space.save", ...request }), "Failed to save Space context"),
    [WS_METHODS.contextSaveProject]: (request: Input<"saveProject">) =>
      rpcEffect(
        write({ type: "context.project.save", ...request }),
        "Failed to save Project context",
      ),
    [WS_METHODS.contextGetCommandResult]: (request: Input<"getCommandResult">) =>
      rpcEffect(
        repository.getCommandResult(request.commandId),
        "Failed to read saved Context result",
      ),
    [WS_METHODS.contextClaimMigration]: (request: Input<"claimMigration">) =>
      rpcEffect(
        write({ type: "context.migration.claim", ...request }),
        "Failed to claim legacy instructions",
      ),
    [WS_METHODS.contextResolveMigration]: (request: Input<"resolveMigration">) =>
      rpcEffect(
        write({ type: "context.migration.resolve", ...request }),
        "Failed to migrate legacy instructions",
      ),
    [WS_METHODS.contextRetryLoad]: (request: Input<"retryLoad">) =>
      rpcEffect(input.retryLoad(request), "Failed to retry Context loading"),
  };
}
