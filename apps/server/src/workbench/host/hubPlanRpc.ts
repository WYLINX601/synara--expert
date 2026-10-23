import { WS_METHODS, WsRpcError, type HubPlansApi } from "@synara/contracts";
import { Effect } from "effect";
import type { makeHubPlanService } from "../../hubCollaboration/HubPlanService.ts";

type Input<K extends keyof HubPlansApi> = Parameters<HubPlansApi[K]>[0];
export function makeHubPlanRpcHandlers<R>(input: {
  readonly service: ReturnType<typeof makeHubPlanService> | undefined;
  readonly requireOwner: Effect.Effect<void, WsRpcError, R>;
}) {
  const run = <A>(
    operation: (service: NonNullable<typeof input.service>) => Effect.Effect<A, unknown>,
  ) =>
    Effect.gen(function* () {
      yield* input.requireOwner;
      if (!input.service)
        return yield* Effect.fail(
          new WsRpcError({
            message: "Hub plans are unavailable.",
            code: "hub-plans-unavailable",
            retryable: false,
          }),
        );
      return yield* operation(input.service).pipe(
        Effect.mapError(
          (cause) =>
            new WsRpcError({
              message: cause instanceof Error ? cause.message : "Hub plan operation failed.",
              code:
                typeof cause === "object" && cause !== null && "code" in cause
                  ? String(cause.code)
                  : "hub-plan-error",
              retryable: false,
            }),
        ),
      );
    });
  const owner = { kind: "user" as const };
  return {
    [WS_METHODS.hubPlansList]: (request: Input<"list">) =>
      run((service) => service.list(request, owner)),
    [WS_METHODS.hubPlansRead]: (request: Input<"read">) =>
      run((service) => service.read(request, owner)),
    [WS_METHODS.hubPlansEvents]: (request: Input<"events">) =>
      run((service) => service.events(request, owner)),
    [WS_METHODS.hubPlansPropose]: (request: Input<"propose">) =>
      run((service) => service.propose(request, owner)),
    [WS_METHODS.hubPlansCommand]: (request: Input<"command">) =>
      run((service) => service.command(request, owner)),
  };
}
