import { WS_METHODS, WsRpcError } from "@synara/contracts";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import { makeSkillEvolutionRpcHandlers } from "./skillEvolutionRpc";
import type { createWorkbenchExpertRuntime } from "../runtimeLayer";

const runtime = {} as ReturnType<typeof createWorkbenchExpertRuntime>;
describe("Skill evolution owner RPC boundary", () => {
  it("checks owner authorization before revealing capabilities or constructing a task host", async () => {
    const host = vi.fn();
    const rpc = makeSkillEvolutionRpcHandlers({
      stateDir: "/unused",
      runtime,
      host,
      requireOwner: Effect.fail(new WsRpcError({ message: "Owner access required" })),
      rpcEffect: (effect) =>
        effect.pipe(
          Effect.mapError((cause) =>
            cause instanceof WsRpcError ? cause : new WsRpcError({ message: String(cause) }),
          ),
        ),
    });
    await expect(
      Effect.runPromise(
        rpc.handlers[WS_METHODS.serverSkillEvolution]({
          request: { action: "capabilities" },
        }),
      ),
    ).rejects.toThrow("Owner access required");
    expect(host).not.toHaveBeenCalled();
    await rpc.dispose();
  });
  it("fails closed when the persistence capability is absent", async () => {
    const host = vi.fn();
    const rpc = makeSkillEvolutionRpcHandlers({
      stateDir: "/unused",
      runtime,
      host,
      requireOwner: Effect.void,
      rpcEffect: (effect) =>
        effect.pipe(Effect.mapError((cause) => new WsRpcError({ message: String(cause) }))),
    });
    const response = await Effect.runPromise(
      rpc.handlers[WS_METHODS.serverSkillEvolution]({
        request: { action: "capabilities" },
      }),
    );
    expect(response.capabilities?.every((value) => !value.supported)).toBe(true);
    await expect(
      Effect.runPromise(
        rpc.handlers[WS_METHODS.serverSkillEvolution]({
          request: { action: "sources", expertId: "expert-a" },
        }),
      ),
    ).rejects.toThrow("提炼服务不可用");
    expect(host).not.toHaveBeenCalled();
    await rpc.dispose();
  });
});
