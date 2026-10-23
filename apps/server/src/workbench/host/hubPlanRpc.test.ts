import { describe, expect, it, vi } from "vitest";
import { Effect } from "effect";
import { ProjectId, WS_METHODS, WsRpcError } from "@synara/contracts";
import { makeHubPlanRpcHandlers } from "./hubPlanRpc.ts";
import type { HubPlanService } from "../../hubCollaboration/HubPlanService.ts";

describe("Hub plan RPC", () => {
  it("rejects non-owner sessions before reaching the service", async () => {
    const list = vi.fn();
    const handlers = makeHubPlanRpcHandlers({
      service: { list } as unknown as HubPlanService,
      requireOwner: Effect.fail(new WsRpcError({ message: "Owner authorization is required." })),
    });
    await expect(
      Effect.runPromise(handlers[WS_METHODS.hubPlansList]({ hubId: ProjectId.makeUnsafe("hub") })),
    ).rejects.toThrow("Owner authorization");
    expect(list).not.toHaveBeenCalled();
  });
});
