import {
  LearningCommitInput,
  LearningReadInput,
  LearningRevertInput,
  type LearningSessionContext,
} from "@synara/contracts";
import { Effect, Schema } from "effect";
import { describe, expect, it, vi } from "vitest";

import type {
  ExpertLearningActionsShape,
  LearningActionContext,
} from "../experts/evolution/ExpertLearningActions.ts";
import type { McpToolCallResult } from "./protocol.ts";
import { makeLearningTools } from "./learningTools.ts";
import type { ToolContext, ToolEntry } from "./toolRuntime.ts";

const session = (learningEpoch?: number): LearningSessionContext => ({
  manifestId: "manifest-tools",
  rootRunId: "root-run-tools",
  snapshotId: "snapshot-tools",
  scope: {
    ownerId: "owner-from-host",
    spaceId: null,
    expertId: "expert-from-host",
    projectId: "project-from-host",
  },
  knowledgeHash: `sha256:${"e".repeat(64)}`,
  ...(learningEpoch !== undefined ? { learningEpoch } : {}),
});

function toolContext(learningSession = session(3)): ToolContext {
  return {
    principal: {
      kind: "provider-session",
      sessionKey: "session-key-from-registry",
      threadId: "thread-from-registry",
      provider: "pi",
      turnId: "turn-from-registry",
    },
    callerThreadId: "thread-from-registry",
    callerThreadLabel: null,
    callerSessionKey: "session-key-from-registry",
    callerProvider: "pi",
    callerCapabilities: new Set(["learning:read", "learning:write"]),
    learningSession,
    callerTurnId: "turn-from-registry",
    assertCallerTurnActive: () => Effect.void,
    jsonRpcRequestId: "request-1",
  };
}

const findTool = (tools: readonly ToolEntry[], name: string) => {
  const tool = tools.find((candidate) => candidate.definition.name === name);
  if (!tool) throw new Error(`Missing learning tool ${name}.`);
  return tool;
};

const resultText = (result: McpToolCallResult) =>
  result.content.find((item) => item.type === "text")?.text ?? "";

describe("Agent Gateway learning tools", () => {
  it("registers active-turn tools without expert-MCP sessionScoped authorization", () => {
    const actions = {} as ExpertLearningActionsShape;
    const tools = makeLearningTools(actions);

    expect(tools.map((tool) => [tool.definition.name, tool.requiredCapability])).toEqual([
      ["synara_learning_read", "learning:read"],
      ["synara_learning_commit", "learning:write"],
      ["synara_learning_revert", "learning:write"],
    ]);
    expect(tools.every((tool) => tool.requiresActiveTurn === true)).toBe(true);
    expect(tools.every((tool) => tool.sessionScoped === undefined)).toBe(true);
  });

  it("passes the verified lease identity to read and never takes scope from arguments", async () => {
    const contexts: LearningActionContext[] = [];
    const read = vi.fn((context: LearningActionContext, input: typeof LearningReadInput.Type) =>
      Effect.sync(() => {
        contexts.push(context);
        return { input };
      }),
    );
    const tools = makeLearningTools({ read } as unknown as ExpertLearningActionsShape);
    const readTool = findTool(tools, "synara_learning_read");

    const result = await Effect.runPromise(readTool.handler({ mode: "runtime" }, toolContext()));
    expect(JSON.parse(resultText(result))).toEqual({ input: { mode: "runtime" } });
    expect(read).toHaveBeenCalledOnce();
    expect(contexts[0]).toMatchObject({
      session: session(3),
      threadId: "thread-from-registry",
      turnId: "turn-from-registry",
      provider: "pi",
      sessionKey: "session-key-from-registry",
    });
    expect(contexts[0]?.assertActive).toBeDefined();
    expect(read.mock.calls[0]?.[1]).toEqual({ mode: "runtime" });
  });

  it("rejects model-supplied owner or epoch fields before invoking a write action", async () => {
    const commit = vi.fn(() => Effect.succeed({ status: "committed" as const }));
    const tools = makeLearningTools({ commit } as unknown as ExpertLearningActionsShape);
    const writeTool = findTool(tools, "synara_learning_commit");
    const source = {
      kind: "message",
      messageId: "message-1",
      threadId: "thread-from-registry",
      contentHash: `sha256:${"a".repeat(64)}`,
    };
    const args = {
      requestId: "commit-1",
      sources: [source],
      change: {
        assetKind: "memory",
        kind: "rule",
        key: "response-style",
        content: "Keep decisions concise.",
      },
      ownerId: "model-forged-owner",
      learningEpoch: 999,
    };

    const result = await Effect.runPromise(writeTool.handler(args, toolContext()));
    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain("ownerId");
    expect(commit).not.toHaveBeenCalled();
  });

  it("does not allow a read-only epoch to call commit or revert", async () => {
    const commit = vi.fn(() => Effect.succeed({ status: "committed" as const }));
    const revert = vi.fn(() => Effect.succeed({ status: "committed" as const }));
    const tools = makeLearningTools({ commit, revert } as unknown as ExpertLearningActionsShape);
    const writeContext = toolContext(session());
    const commitResult = await Effect.runPromise(
      findTool(tools, "synara_learning_commit").handler(
        { requestId: "commit-readonly", sources: [], change: {} },
        writeContext,
      ),
    );
    const revertResult = await Effect.runPromise(
      findTool(tools, "synara_learning_revert").handler(
        { requestId: "revert-readonly", changeId: "change-1", ownerId: "forged" },
        writeContext,
      ),
    );

    expect(commitResult.isError).toBe(true);
    expect(resultText(commitResult)).toContain("read-only");
    expect(revertResult.isError).toBe(true);
    expect(resultText(revertResult)).toContain("read-only");
    expect(commit).not.toHaveBeenCalled();
    expect(revert).not.toHaveBeenCalled();
  });

  it("exposes the contract schemas and rejects extra read and revert authority fields", () => {
    expect(() => Schema.decodeUnknownSync(LearningReadInput)({ mode: "runtime" })).not.toThrow();
    expect(() =>
      Schema.decodeUnknownSync(LearningReadInput)({ mode: "runtime", ownerId: "forged" }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(LearningCommitInput)({
        requestId: "commit-1",
        sources: [],
        change: { assetKind: "memory", kind: "rule", key: "k", content: "v" },
        learningEpoch: 4,
      }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(LearningRevertInput)({
        requestId: "revert-1",
        changeId: "change-1",
        ownerId: "forged",
      }),
    ).toThrow();
  });
});
