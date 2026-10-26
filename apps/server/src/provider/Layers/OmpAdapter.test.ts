import { TurnId } from "@synara/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, FileSystem, Sink, Stream } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import { describe, expect, it } from "vitest";
import { SYNARA_HARNESS_POLICY_MARKER } from "../../agentGateway/harnessPolicy.ts";
import { ServerConfig } from "../../config.ts";

import {
  isOmpNestedTaskToolCall,
  isRenderableOmpAssistantDelta,
  makeOmpAdapter,
  retainOmpNestedTaskTracking,
  resolveOmpLateToolCallTurnId,
  resolveOmpSessionCwd,
  scopeOmpRuntimeItemIdForTurn,
  scopeOmpToolCallStateForTurn,
  shouldIgnoreOmpInterrupt,
  takeOmpSynaraHarnessPolicyTextPart,
  updateOmpNestedTaskLifecycle,
} from "./OmpAdapter.ts";

function makeOmpBatchTaskUpdate(
  toolCallId: string,
  status: "pending" | "inProgress" | "completed" | "failed",
  options: {
    readonly asyncMetadata?: boolean;
    readonly asyncState?: string;
    readonly asyncType?: unknown;
    readonly asyncJobId?: unknown;
    readonly omitAsyncType?: boolean;
    readonly omitAsyncJobId?: boolean;
    readonly omitRawInput?: boolean;
  } = {},
) {
  const data: Record<string, unknown> = {};
  if (!options.omitRawInput) {
    data.rawInput = {
      context: "Synthetic check",
      tasks: [{ agent: "task", task: "Read the admitted fixed Skill marker." }],
    };
  }
  if (options.asyncMetadata) {
    const asyncDetails: Record<string, unknown> = {};
    if (options.asyncState !== undefined) asyncDetails.state = options.asyncState;
    if (!options.omitAsyncJobId) {
      asyncDetails.jobId = options.asyncJobId ?? "ImplicitMeadowlark";
    }
    if (!options.omitAsyncType) asyncDetails.type = options.asyncType ?? "task";
    data.rawOutput = {
      details: {
        async: asyncDetails,
      },
    };
  }
  return {
    toolCallId,
    kind: "other",
    title: "Delegating fixed skill verification",
    status,
    data,
  };
}

describe("OMP Synara harness policy", () => {
  it("delivers private scoped host context once", () => {
    const state: { harnessPolicyDelivered?: boolean } = {};
    expect(takeOmpSynaraHarnessPolicyTextPart(state, true)?.text).toContain(
      SYNARA_HARNESS_POLICY_MARKER,
    );
    expect(takeOmpSynaraHarnessPolicyTextPart(state, true)).toBeNull();
  });
});

describe("OmpAdapter model discovery", () => {
  it("returns only the CLI catalog without reading role config, sharing it across projects", async () => {
    let spawns = 0;
    const spawner = ChildProcessSpawner.make((command) => {
      expect(command).toMatchObject({ command: "/bin/omp-fixture", args: ["models", "--json"] });
      spawns += 1;
      return Effect.succeed(
        ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(0x7fff_fffe),
          exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
          isRunning: Effect.succeed(false),
          kill: () => Effect.void,
          stdin: Sink.drain,
          stdout: Stream.make(
            new TextEncoder().encode(
              JSON.stringify({
                models: [
                  {
                    selector: "upstream/model",
                    name: "Model",
                    provider: "upstream",
                    thinking: ["high"],
                  },
                ],
              }),
            ),
          ),
          stderr: Stream.empty,
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
        }),
      );
    });
    const results = await Effect.runPromise(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const adapter = yield* makeOmpAdapter({ binaryPath: "/bin/omp-fixture" }).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.provideService(ServerConfig, serverConfig),
          Effect.provideService(FileSystem.FileSystem, {
            ...fileSystem,
            exists: () => Effect.die("Model discovery must not inspect config files."),
            readFileString: () => Effect.die("Model discovery must not read role config."),
          }),
        );
        const listModels = adapter.listModels!;
        const first = yield* listModels({ provider: "omp", cwd: "/first" });
        const second = yield* listModels({ provider: "omp", cwd: "/second" });
        return { first, second };
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );

    expect(results.first).toEqual({
      models: [
        {
          slug: "upstream/model",
          name: "Model",
          upstreamProviderId: "upstream",
          supportedReasoningEfforts: [{ value: "high", label: "High" }],
        },
      ],
      source: "omp-cli",
      cached: false,
    });
    expect(results.second).toEqual({ ...results.first, cached: true });
    expect(spawns).toBe(1);
  });
});

const serverConfig = {
  cwd: "/server/cwd",
  homeDir: "/home/test",
} as Parameters<typeof resolveOmpSessionCwd>[1];

describe("resolveOmpSessionCwd", () => {
  it("prefers an explicit cwd over the active thread session cwd", () => {
    expect(resolveOmpSessionCwd("/explicit", serverConfig, "/thread")).toBe("/explicit");
  });

  it("uses the active thread session cwd before the server fallback", () => {
    expect(resolveOmpSessionCwd(undefined, serverConfig, "/thread")).toBe("/thread");
  });
});

describe("OmpAdapter runtime event scoping", () => {
  it("makes reused ACP assistant segment ids unique per turn", () => {
    const providerItemId = "assistant:omp-session:segment:5";

    expect(scopeOmpRuntimeItemIdForTurn(TurnId.makeUnsafe("turn-a"), providerItemId)).toBe(
      "omp:turn-a:assistant:omp-session:segment:5",
    );
    expect(scopeOmpRuntimeItemIdForTurn(TurnId.makeUnsafe("turn-b"), providerItemId)).toBe(
      "omp:turn-b:assistant:omp-session:segment:5",
    );
  });

  it("preserves the provider tool id while scoping the runtime item id", () => {
    const scoped = scopeOmpToolCallStateForTurn(TurnId.makeUnsafe("turn-a"), {
      toolCallId: "call-1",
      kind: "execute",
      status: "completed",
      title: "Ran command",
      data: {
        toolCallId: "call-1",
      },
    });

    expect(scoped.toolCallId).toBe("omp:turn-a:call-1");
    expect(scoped.data).toMatchObject({
      toolCallId: "call-1",
      providerToolCallId: "call-1",
    });
  });

  it("only treats visible assistant text as renderable OMP content", () => {
    expect(
      isRenderableOmpAssistantDelta({
        streamKind: "assistant_text",
        text: "done",
      }),
    ).toBe(true);
    expect(
      isRenderableOmpAssistantDelta({
        streamKind: "assistant_text",
        text: "   ",
      }),
    ).toBe(false);
  });

  it("recognizes nested Task rows whose child progress is hidden from parent ACP", () => {
    expect(
      isOmpNestedTaskToolCall({
        toolCallId: "task-1",
        title: "Task",
        status: "pending",
        data: { rawInput: { subagent_type: "worker" } },
      }),
    ).toBe(true);
    expect(
      isOmpNestedTaskToolCall({
        toolCallId: "read-1",
        title: "Read",
        status: "pending",
        data: {},
      }),
    ).toBe(false);
  });

  it("recognizes OMP 18.12.1 batch Task calls with a custom title", () => {
    expect(
      isOmpNestedTaskToolCall({
        toolCallId: "task-batch-1",
        kind: "other",
        title: "Delegating fixed skill verification",
        status: "inProgress",
        data: {
          rawInput: {
            context: "Synthetic check",
            tasks: [
              {
                name: "VerifyFixedSkill",
                agent: "task",
                task: "Invoke the selected Skill and return its marker.",
                solutionSpace: "One fixed check.",
              },
            ],
          },
        },
      }),
    ).toBe(true);
  });

  it.each([
    ["empty batch", { tasks: [] }],
    ["missing tasks", {}],
    ["missing agent", { tasks: [{ task: "run" }] }],
    ["blank agent", { tasks: [{ agent: "  ", task: "run" }] }],
    ["missing task", { tasks: [{ agent: "task" }] }],
    ["blank task", { tasks: [{ agent: "task", task: "  " }] }],
    ["non-object task", { tasks: ["task"] }],
    [
      "mixed valid and invalid tasks",
      { tasks: [{ agent: "task", task: "run" }, { agent: "task" }] },
    ],
  ])(
    "does not misclassify custom-title calls with invalid OMP batch input: %s",
    (_label, rawInput) => {
      expect(
        isOmpNestedTaskToolCall({
          toolCallId: "not-task",
          kind: "other",
          title: "A custom tool title",
          status: "pending",
          data: { rawInput },
        }),
      ).toBe(false);
    },
  );

  it("requires OMP batch Task calls to use the observed other kind", () => {
    expect(
      isOmpNestedTaskToolCall({
        toolCallId: "not-omp-task",
        kind: "read",
        title: "Delegating fixed skill verification",
        status: "pending",
        data: { rawInput: { tasks: [{ agent: "task", task: "run" }] } },
      }),
    ).toBe(false);
  });

  it("keeps a completed ACP Task call active while its native async job is running", () => {
    const activeTaskToolCallIds = new Set<string>();
    const lifecycle = new Map<string, "active" | "active-async" | "completed">();
    const toolCall = makeOmpBatchTaskUpdate("async-task-1", "completed", {
      asyncMetadata: true,
      asyncState: "running",
    });

    expect(updateOmpNestedTaskLifecycle(toolCall, activeTaskToolCallIds, lifecycle)).toEqual({
      kind: "started",
    });
    expect(activeTaskToolCallIds.has("async-task-1")).toBe(true);
    expect(lifecycle.get("async-task-1")).toBe("active-async");
    expect(updateOmpNestedTaskLifecycle(toolCall, activeTaskToolCallIds, lifecycle)).toEqual({
      kind: "none",
    });
    expect(activeTaskToolCallIds.has("async-task-1")).toBe(true);
  });

  it("keeps async task ownership through parent settlement and attributes sparse completion to its origin", () => {
    const activeTaskToolCallIds = new Set<string>();
    const lifecycle = new Map<string, "active" | "active-async" | "completed">();
    const turnToolCallIds = new Map<string, TurnId>();
    const parentTurnId = TurnId.makeUnsafe("parent-turn");
    const nextTurnId = TurnId.makeUnsafe("next-turn");
    const toolCallId = "async-task-2";
    turnToolCallIds.set(toolCallId, parentTurnId);

    expect(
      updateOmpNestedTaskLifecycle(
        makeOmpBatchTaskUpdate(toolCallId, "completed", {
          asyncMetadata: true,
          asyncState: "running",
        }),
        activeTaskToolCallIds,
        lifecycle,
      ),
    ).toEqual({ kind: "started" });
    expect(
      resolveOmpLateToolCallTurnId({
        resumeReplayPending: false,
        activeTurnId: undefined,
        originalTurnId: turnToolCallIds.get(toolCallId),
        isTrackedNestedTask: lifecycle.has(toolCallId),
      }),
    ).toBe(parentTurnId);

    lifecycle.set("already-ended", "completed");
    turnToolCallIds.set("already-ended", parentTurnId);
    turnToolCallIds.set("ordinary-tool", parentTurnId);
    retainOmpNestedTaskTracking(lifecycle, turnToolCallIds);
    expect(activeTaskToolCallIds.has(toolCallId)).toBe(true);
    expect(lifecycle.get(toolCallId)).toBe("active-async");
    expect(turnToolCallIds.get(toolCallId)).toBe(parentTurnId);
    expect(lifecycle.get("already-ended")).toBe("completed");
    expect(turnToolCallIds.get("already-ended")).toBe(parentTurnId);
    expect(turnToolCallIds.has("ordinary-tool")).toBe(false);

    const sparseTerminal = makeOmpBatchTaskUpdate(toolCallId, "completed", {
      asyncMetadata: true,
      asyncState: "completed",
      omitRawInput: true,
    });
    expect(isOmpNestedTaskToolCall(sparseTerminal)).toBe(false);
    expect(
      resolveOmpLateToolCallTurnId({
        resumeReplayPending: false,
        activeTurnId: nextTurnId,
        originalTurnId: turnToolCallIds.get(toolCallId),
        isTrackedNestedTask: lifecycle.has(toolCallId),
      }),
    ).toBe(parentTurnId);
    expect(updateOmpNestedTaskLifecycle(sparseTerminal, activeTaskToolCallIds, lifecycle)).toEqual({
      kind: "completed",
      status: "completed",
    });
    expect(activeTaskToolCallIds.has(toolCallId)).toBe(false);
    expect(lifecycle.get(toolCallId)).toBe("completed");
    expect(updateOmpNestedTaskLifecycle(sparseTerminal, activeTaskToolCallIds, lifecycle)).toEqual({
      kind: "none",
    });
    expect(
      resolveOmpLateToolCallTurnId({
        resumeReplayPending: false,
        activeTurnId: nextTurnId,
        originalTurnId: turnToolCallIds.get(toolCallId),
        isTrackedNestedTask: lifecycle.has(toolCallId),
      }),
    ).toBe(parentTurnId);
  });

  it.each([
    { asyncState: "failed", expectedStatus: "failed" },
    { asyncState: "cancelled", expectedStatus: "stopped" },
  ] as const)(
    "maps native async $asyncState to $expectedStatus and ignores duplicate or late-running updates",
    ({ asyncState, expectedStatus }) => {
      const activeTaskToolCallIds = new Set<string>();
      const lifecycle = new Map<string, "active" | "active-async" | "completed">();
      const running = makeOmpBatchTaskUpdate("async-terminal", "completed", {
        asyncMetadata: true,
        asyncState: "running",
      });
      expect(updateOmpNestedTaskLifecycle(running, activeTaskToolCallIds, lifecycle)).toEqual({
        kind: "started",
      });

      const terminal = makeOmpBatchTaskUpdate("async-terminal", "failed", {
        asyncMetadata: true,
        asyncState,
        omitRawInput: true,
      });
      expect(updateOmpNestedTaskLifecycle(terminal, activeTaskToolCallIds, lifecycle)).toEqual({
        kind: "completed",
        status: expectedStatus,
      });
      expect(activeTaskToolCallIds.has("async-terminal")).toBe(false);
      expect(updateOmpNestedTaskLifecycle(terminal, activeTaskToolCallIds, lifecycle)).toEqual({
        kind: "none",
      });
      expect(updateOmpNestedTaskLifecycle(running, activeTaskToolCallIds, lifecycle)).toEqual({
        kind: "none",
      });
      expect(activeTaskToolCallIds.has("async-terminal")).toBe(false);
    },
  );

  it("does not settle a known async task on missing or malformed native terminal metadata", () => {
    const activeTaskToolCallIds = new Set<string>();
    const lifecycle = new Map<string, "active" | "active-async" | "completed">();
    expect(
      updateOmpNestedTaskLifecycle(
        makeOmpBatchTaskUpdate("async-unknown", "completed", {
          asyncMetadata: true,
          asyncState: "running",
        }),
        activeTaskToolCallIds,
        lifecycle,
      ),
    ).toEqual({ kind: "started" });

    expect(
      updateOmpNestedTaskLifecycle(
        makeOmpBatchTaskUpdate("async-unknown", "completed", {
          asyncMetadata: true,
          omitRawInput: true,
        }),
        activeTaskToolCallIds,
        lifecycle,
      ),
    ).toEqual({ kind: "none" });
    expect(
      updateOmpNestedTaskLifecycle(
        makeOmpBatchTaskUpdate("async-unknown", "failed", { omitRawInput: true }),
        activeTaskToolCallIds,
        lifecycle,
      ),
    ).toEqual({ kind: "none" });
    expect(activeTaskToolCallIds.has("async-unknown")).toBe(true);
  });

  it.each([
    { label: "missing type", omitAsyncType: true },
    { label: "missing job ID", omitAsyncJobId: true },
    { label: "wrong type", asyncType: "agent" },
    { label: "blank job ID", asyncJobId: "  " },
  ] as const)(
    "keeps a known async task active when terminal metadata has $label",
    ({ asyncType, asyncJobId, omitAsyncType, omitAsyncJobId }) => {
      const activeTaskToolCallIds = new Set<string>();
      const lifecycle = new Map<string, "active" | "active-async" | "completed">();
      const running = makeOmpBatchTaskUpdate("async-wire-shape", "completed", {
        asyncMetadata: true,
        asyncState: "running",
      });
      expect(updateOmpNestedTaskLifecycle(running, activeTaskToolCallIds, lifecycle)).toEqual({
        kind: "started",
      });

      const malformedTerminal = makeOmpBatchTaskUpdate("async-wire-shape", "completed", {
        asyncMetadata: true,
        asyncState: "completed",
        ...(asyncType === undefined ? {} : { asyncType }),
        ...(asyncJobId === undefined ? {} : { asyncJobId }),
        ...(omitAsyncType === undefined ? {} : { omitAsyncType }),
        ...(omitAsyncJobId === undefined ? {} : { omitAsyncJobId }),
        omitRawInput: true,
      });
      expect(
        updateOmpNestedTaskLifecycle(malformedTerminal, activeTaskToolCallIds, lifecycle),
      ).toEqual({ kind: "none" });
      expect(activeTaskToolCallIds.has("async-wire-shape")).toBe(true);

      const validTerminal = makeOmpBatchTaskUpdate("async-wire-shape", "completed", {
        asyncMetadata: true,
        asyncState: "completed",
        omitRawInput: true,
      });
      expect(updateOmpNestedTaskLifecycle(validTerminal, activeTaskToolCallIds, lifecycle)).toEqual(
        {
          kind: "completed",
          status: "completed",
        },
      );
    },
  );

  it("keeps completed-task tombstones and original turn ownership across later turns", () => {
    const activeTaskToolCallIds = new Set<string>();
    const lifecycle = new Map<string, "active" | "active-async" | "completed">();
    const turnToolCallIds = new Map<string, TurnId>();
    const parentTurnId = TurnId.makeUnsafe("finished-parent-turn");
    const nextTurnId = TurnId.makeUnsafe("later-turn");
    const toolCallId = "completed-before-new-turn";
    turnToolCallIds.set(toolCallId, parentTurnId);

    const started = makeOmpBatchTaskUpdate(toolCallId, "completed", {
      asyncMetadata: true,
      asyncState: "running",
    });
    expect(updateOmpNestedTaskLifecycle(started, activeTaskToolCallIds, lifecycle)).toEqual({
      kind: "started",
    });
    const terminal = makeOmpBatchTaskUpdate(toolCallId, "completed", {
      asyncMetadata: true,
      asyncState: "completed",
      omitRawInput: true,
    });
    expect(updateOmpNestedTaskLifecycle(terminal, activeTaskToolCallIds, lifecycle)).toEqual({
      kind: "completed",
      status: "completed",
    });
    retainOmpNestedTaskTracking(lifecycle, turnToolCallIds);

    expect(lifecycle.get(toolCallId)).toBe("completed");
    expect(turnToolCallIds.get(toolCallId)).toBe(parentTurnId);
    expect(
      resolveOmpLateToolCallTurnId({
        resumeReplayPending: false,
        activeTurnId: nextTurnId,
        originalTurnId: turnToolCallIds.get(toolCallId),
        isTrackedNestedTask: lifecycle.has(toolCallId),
      }),
    ).toBe(parentTurnId);
    expect(updateOmpNestedTaskLifecycle(started, activeTaskToolCallIds, lifecycle)).toEqual({
      kind: "none",
    });
    expect(updateOmpNestedTaskLifecycle(terminal, activeTaskToolCallIds, lifecycle)).toEqual({
      kind: "none",
    });
    expect(activeTaskToolCallIds.has(toolCallId)).toBe(false);
  });

  it("preserves synchronous Task completion behavior and only backdates tracked child updates", () => {
    const activeTaskToolCallIds = new Set<string>();
    const lifecycle = new Map<string, "active" | "active-async" | "completed">();
    expect(
      updateOmpNestedTaskLifecycle(
        makeOmpBatchTaskUpdate("sync-task", "completed"),
        activeTaskToolCallIds,
        lifecycle,
      ),
    ).toEqual({ kind: "completed", status: "completed" });

    const oldTurnId = TurnId.makeUnsafe("old-turn");
    const currentTurnId = TurnId.makeUnsafe("current-turn");
    expect(
      resolveOmpLateToolCallTurnId({
        resumeReplayPending: false,
        activeTurnId: currentTurnId,
        originalTurnId: oldTurnId,
        isTrackedNestedTask: false,
      }),
    ).toBeUndefined();
    expect(
      resolveOmpLateToolCallTurnId({
        resumeReplayPending: false,
        activeTurnId: currentTurnId,
        originalTurnId: oldTurnId,
        isTrackedNestedTask: true,
      }),
    ).toBe(oldTurnId);
    expect(
      resolveOmpLateToolCallTurnId({
        resumeReplayPending: true,
        activeTurnId: undefined,
        originalTurnId: oldTurnId,
        isTrackedNestedTask: true,
      }),
    ).toBeUndefined();
  });

  it("ignores a delayed stop when its turn is no longer active", () => {
    const oldTurnId = TurnId.makeUnsafe("turn-a");
    const newTurnId = TurnId.makeUnsafe("turn-b");

    expect(shouldIgnoreOmpInterrupt(oldTurnId, newTurnId)).toBe(true);
    expect(shouldIgnoreOmpInterrupt(oldTurnId, undefined)).toBe(true);
    expect(shouldIgnoreOmpInterrupt(newTurnId, newTurnId)).toBe(false);
    expect(shouldIgnoreOmpInterrupt(undefined, newTurnId)).toBe(false);
  });
});
