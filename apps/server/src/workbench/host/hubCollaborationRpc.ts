import {
  WS_METHODS,
  WsRpcError,
  type HubTeamArchiveInput,
  type HubTeamReadInput,
  type HubTeamSaveInput,
} from "@synara/contracts";
import { Effect } from "effect";
import type { makeHubCollaborationConfigStore } from "../../hubCollaboration/HubCollaborationConfigStore.ts";

/** The host supplies authenticated owner authority and the shared persistence capability. */
export function makeHubCollaborationRpcHandlers<R>(input: {
  readonly store: ReturnType<typeof makeHubCollaborationConfigStore> | undefined;
  readonly requireOwner: Effect.Effect<void, WsRpcError, R>;
}) {
  const run = <A>(
    operation: (store: NonNullable<typeof input.store>) => Effect.Effect<A, unknown>,
  ) =>
    Effect.gen(function* () {
      yield* input.requireOwner;
      if (!input.store) {
        return yield* Effect.fail(
          new WsRpcError({
            message: "Hub collaboration configuration is unavailable.",
            code: "hub-collaboration-unavailable",
            retryable: false,
          }),
        );
      }
      return yield* operation(input.store).pipe(
        Effect.mapError(
          (cause) =>
            new WsRpcError({
              message:
                cause instanceof Error ? cause.message : "Hub collaboration operation failed.",
              code:
                typeof cause === "object" && cause !== null && "_tag" in cause
                  ? String(cause._tag)
                  : "hub-collaboration-error",
              retryable: false,
            }),
        ),
      );
    });
  return {
    [WS_METHODS.hubTeamsList]: () => run((store) => store.listTeams()),
    [WS_METHODS.hubTeamsRead]: (request: HubTeamReadInput) =>
      run((store) => store.readTeam(request)),
    [WS_METHODS.hubTeamsSave]: (request: HubTeamSaveInput) =>
      run((store) => store.saveTeam(request)),
    [WS_METHODS.hubTeamsSetArchived]: (request: HubTeamArchiveInput) =>
      run((store) => store.setTeamArchived(request)),
  };
}
