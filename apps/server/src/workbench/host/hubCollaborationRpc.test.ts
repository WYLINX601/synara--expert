import { describe, expect, it, vi } from "vitest";
import { Effect } from "effect";
import { WS_METHODS, WsRpcError } from "@synara/contracts";
import { makeHubCollaborationRpcHandlers } from "./hubCollaborationRpc.ts";
import { requireWsOwnerSession } from "../../wsOwnerAuthorization.ts";
import { CurrentWsSessionRole } from "../../wsConnectionSessions.ts";
import type { makeHubCollaborationConfigStore } from "../../hubCollaboration/HubCollaborationConfigStore.ts";

describe("Hub team owner boundary", () => {
  it("checks connection authority before reading or writing preset data", async () => {
    const listTeams = vi.fn(() => Effect.succeed([]));
    const handlers = makeHubCollaborationRpcHandlers({
      store: { listTeams } as unknown as ReturnType<typeof makeHubCollaborationConfigStore>,
      requireOwner: Effect.fail(new WsRpcError({ message: "denied" })),
    });
    await expect(Effect.runPromise(handlers[WS_METHODS.hubTeamsList]())).rejects.toThrow("denied");
    expect(listTeams).not.toHaveBeenCalled();
  });

  it("fails clearly when an older host has no capability", async () => {
    const handlers = makeHubCollaborationRpcHandlers({
      store: undefined,
      requireOwner: requireWsOwnerSession,
    });
    await expect(
      Effect.runPromise(
        handlers[WS_METHODS.hubTeamsList]().pipe(
          Effect.provideService(CurrentWsSessionRole, "owner"),
        ),
      ),
    ).rejects.toThrow("unavailable");
  });
});
