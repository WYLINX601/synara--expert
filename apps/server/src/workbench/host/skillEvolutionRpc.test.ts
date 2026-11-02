import { WS_METHODS, WsRpcError } from "@synara/contracts";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import { CurrentManagedAttachmentPrincipal } from "../../managedAttachmentPrincipal";
import type { ExpertLearningActionsShape } from "../../experts/evolution/ExpertLearningActions";
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
    await expect(
      Effect.runPromise(
        rpc.handlers[WS_METHODS.serverSkillEvolution]({
          request: { action: "learningChanges", expertId: "expert-a" },
        }),
      ),
    ).rejects.toThrow("第二阶段学习能力不可用");
    expect(host).not.toHaveBeenCalled();
    await rpc.dispose();
  });

  it("routes learning history operations through actions using the authenticated owner", async () => {
    const calls: unknown[][] = [];
    const publicRevertChange = {
      changeId: "inverse-change-a",
      revertsChangeId: "change-a",
      status: "committed",
    };
    const publicEditChange = { changeId: "edit-change-a", status: "committed" };
    const actions = {
      listChanges: (ownerId: string, expertId: string) =>
        Effect.sync(() => {
          calls.push(["list", ownerId, expertId]);
          return [];
        }),
      readMemory: (ownerId: string, expertId: string, changeId: string, revision: number) =>
        Effect.sync(() => {
          calls.push(["readMemory", ownerId, expertId, changeId, revision]);
          return { memoryId: "memory-a", revision };
        }),
      readSkillChange: (ownerId: string, expertId: string, changeId: string) =>
        Effect.sync(() => {
          calls.push(["readSkillChange", ownerId, expertId, changeId]);
          return {
            changeId,
            files: [],
            coverage: ["exact-historical-packages-integrity-validated"],
          };
        }),
      revertOwner: (
        ownerId: string,
        expertId: string,
        input: { changeId: string; requestId: string; expectedRevision?: number },
      ) =>
        Effect.sync(() => {
          calls.push(["revert", ownerId, expertId, input]);
          return { status: "committed" as const, changeSet: publicRevertChange };
        }),
      editOwnerMemory: (ownerId: string, expertId: string, input: unknown) =>
        Effect.sync(() => {
          calls.push(["editMemory", ownerId, expertId, input]);
          return { status: "committed" as const, changeSet: publicEditChange };
        }),
    } as unknown as ExpertLearningActionsShape;
    const host = vi.fn();
    const rpc = makeSkillEvolutionRpcHandlers({
      stateDir: "/unused",
      runtime,
      actions,
      host,
      requireOwner: Effect.void,
      rpcEffect: (effect) =>
        effect.pipe(Effect.mapError((cause) => new WsRpcError({ message: String(cause) }))),
    });
    const principal = { ownerKind: "session", ownerId: "authenticated-owner" } as const;
    const request = (
      value: Parameters<
        (typeof rpc.handlers)[typeof WS_METHODS.serverSkillEvolution]
      >[0]["request"],
    ) =>
      Effect.runPromise(
        rpc.handlers[WS_METHODS.serverSkillEvolution]({ request: value }).pipe(
          Effect.provideService(CurrentManagedAttachmentPrincipal, principal),
        ),
      );

    await expect(request({ action: "learningChanges", expertId: "expert-a" })).resolves.toEqual({
      learningChanges: [],
    });
    await expect(
      request({
        action: "learningReadMemory",
        expertId: "expert-a",
        changeId: "change-a",
        revision: 2,
      }),
    ).resolves.toMatchObject({ memoryEntry: { memoryId: "memory-a", revision: 2 } });
    await expect(
      request({
        action: "learningReadSkillChange",
        expertId: "expert-a",
        changeId: "change-skill-a",
      }),
    ).resolves.toMatchObject({
      learningSkillChange: {
        changeId: "change-skill-a",
        files: [],
      },
    });
    const revertResponse = await request({
      action: "learningRevert",
      expertId: "expert-a",
      changeId: "change-a",
      operationId: "revert-a",
      expectedRevision: 3,
    });
    expect(revertResponse).toEqual({
      learningStatus: "committed",
      learningChange: publicRevertChange,
    });
    expect(revertResponse.learningChange).toHaveProperty("revertsChangeId", "change-a");
    expect(revertResponse.learningChange).not.toHaveProperty("data");
    expect(revertResponse.learningChange).not.toHaveProperty("operationRef");
    const editResponse = await request({
      action: "learningEditMemory",
      expertId: "expert-a",
      changeId: "change-a",
      requestId: "edit-a",
      expectedRevision: 3,
      content: "Updated project fact.",
    });
    expect(editResponse).toEqual({
      learningStatus: "committed",
      learningChange: publicEditChange,
    });
    expect(editResponse.learningChange).not.toHaveProperty("data");
    expect(editResponse.learningChange).not.toHaveProperty("operationRef");
    expect(calls).toEqual([
      ["list", "authenticated-owner", "expert-a"],
      ["readMemory", "authenticated-owner", "expert-a", "change-a", 2],
      ["readSkillChange", "authenticated-owner", "expert-a", "change-skill-a"],
      [
        "revert",
        "authenticated-owner",
        "expert-a",
        { changeId: "change-a", requestId: "revert-a", expectedRevision: 3 },
      ],
      [
        "editMemory",
        "authenticated-owner",
        "expert-a",
        {
          changeId: "change-a",
          requestId: "edit-a",
          expectedRevision: 3,
          content: "Updated project fact.",
        },
      ],
    ]);
    expect(host).not.toHaveBeenCalled();
    await rpc.dispose();
  });

  it("checks owner authorization before dispatching learning actions", async () => {
    const listChanges = vi.fn(() => Effect.succeed([]));
    const readSkillChange = vi.fn(() =>
      Effect.succeed({ changeId: "change-a", files: [], coverage: [] }),
    );
    const actions = { listChanges, readSkillChange } as unknown as ExpertLearningActionsShape;
    const rpc = makeSkillEvolutionRpcHandlers({
      stateDir: "/unused",
      runtime,
      actions,
      host: vi.fn(),
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
          request: { action: "learningChanges", expertId: "expert-a" },
        }),
      ),
    ).rejects.toThrow("Owner access required");
    expect(listChanges).not.toHaveBeenCalled();
    await expect(
      Effect.runPromise(
        rpc.handlers[WS_METHODS.serverSkillEvolution]({
          request: {
            action: "learningReadSkillChange",
            expertId: "expert-a",
            changeId: "change-a",
          },
        }),
      ),
    ).rejects.toThrow("Owner access required");
    expect(readSkillChange).not.toHaveBeenCalled();
    await rpc.dispose();
  });
});
