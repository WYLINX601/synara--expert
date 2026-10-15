import {
  CommandId,
  ProjectId,
  WS_METHODS,
  WsRpcError,
  type ContextCommandResult,
} from "@synara/contracts";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";

import type { ContextRepositoryShape } from "../../context/ContextRepository.ts";
import { makeWorkbenchContextRpcHandlers } from "./contextRpc.ts";

const commandId = CommandId.makeUnsafe("saved-command");
const request = {
  commandId,
  dataInstanceId: "instance",
  projectId: ProjectId.makeUnsafe("project"),
  expectedRevision: 0,
  projectGoal: "Goal",
  projectInstructions: "Instructions",
};

function handlers(cause: unknown, result: ContextCommandResult) {
  const read = vi.fn(() => Effect.succeed(result));
  const rpc = makeWorkbenchContextRpcHandlers({
    repository: { getCommandResult: read } as unknown as ContextRepositoryShape,
    dispatch: () => Effect.fail(cause),
    retryLoad: () => Effect.succeed(result),
    rpcEffect: (effect) =>
      effect.pipe(Effect.mapError((error) => new WsRpcError({ message: String(error) }))),
  });
  return { rpc, read };
}

describe("Context command result recovery", () => {
  it("recovers an original receipt after a lost acknowledgment", async () => {
    const saved = { commandId, status: "saved" as const };
    const { rpc, read } = handlers(new Error("lost ACK"), saved);
    expect(await Effect.runPromise(rpc[WS_METHODS.contextSaveProject](request))).toEqual(saved);
    expect(read).toHaveBeenCalledExactlyOnceWith(commandId);
  });

  it("does not hide an identity collision behind another command's successful receipt", async () => {
    const { rpc, read } = handlers(
      { _tag: "OrchestrationCommandIdentityCollisionError" },
      { commandId, status: "saved" },
    );
    await expect(Effect.runPromise(rpc[WS_METHODS.contextSaveProject](request))).rejects.toThrow();
    expect(read).not.toHaveBeenCalled();
  });

  it.each(["unknown", "pending"] as const)(
    "keeps an unconfirmed %s write failed",
    async (status) => {
      const { rpc } = handlers(new Error("lost ACK"), { commandId, status });
      await expect(Effect.runPromise(rpc[WS_METHODS.contextSaveProject](request))).rejects.toThrow(
        "lost ACK",
      );
    },
  );
});
