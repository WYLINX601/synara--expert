// FILE: CursorAdapter.test.ts
// Purpose: Characterizes Cursor terminal-event account identity.
// Layer: Provider adapter tests

import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EventId,
  type ProviderInstanceId,
  type ProviderRuntimeEvent,
  ThreadId,
} from "@synara/contracts";
import { Effect, Layer } from "effect";
import { describe, expect, it, vi } from "vitest";

import type * as Acp from "@agentclientprotocol/sdk";

import { ServerConfig } from "../../config.ts";
import { CursorAdapter } from "../Services/CursorAdapter.ts";
import { makeFakeAcpSessionRuntime } from "../acp/testing/fakeAcpSessionRuntime.ts";
import {
  cursorPromptUsageSnapshot,
  makeCursorAdapterLive,
  stampCursorTerminalEventInstance,
} from "./CursorAdapter.ts";
import { makeAcpTokenUsageEvent } from "../acp/AcpCoreRuntimeEvents.ts";

const cursorRuntimeMock = vi.hoisted(() => ({ makeRuntime: vi.fn() }));

vi.mock("../acp/CursorAcpSupport.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../acp/CursorAcpSupport.ts")>();
  return {
    ...actual,
    makeCursorAcpRuntime: cursorRuntimeMock.makeRuntime,
  };
});

describe("CursorAdapter terminal event identity", () => {
  it("returns the owned lifecycle generation from start and list", async () => {
    cursorRuntimeMock.makeRuntime.mockReturnValue(
      Effect.succeed(makeFakeAcpSessionRuntime({ sessionId: "cursor-generation-session" })),
    );
    const layer = makeCursorAdapterLive().pipe(
      Layer.provideMerge(
        ServerConfig.layerTest(process.cwd(), { prefix: "cursor-generation-test-" }),
      ),
      Layer.provideMerge(NodeServices.layer),
    );
    const sessions = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* CursorAdapter;
        const threadId = ThreadId.makeUnsafe("cursor-generation-thread");
        const started = yield* adapter.startSession({
          provider: "cursor",
          threadId,
          runtimeMode: "full-access",
          cwd: process.cwd(),
          lifecycleGeneration: "cursor-owned-generation",
        });
        const [listed] = yield* adapter.listSessions();
        yield* adapter.stopAll();
        return { started, listed };
      }).pipe(Effect.provide(layer), Effect.scoped),
    );

    expect(sessions.started.lifecycleGeneration).toBe("cursor-owned-generation");
    expect(sessions.listed?.lifecycleGeneration).toBe("cursor-owned-generation");
  });

  it("keeps the stopped account identity after the thread is rebound to another account", () => {
    const accountA = "cursor_account_a" as ProviderInstanceId;
    const accountB = "cursor_account_b" as ProviderInstanceId;
    const terminalEvent: ProviderRuntimeEvent = {
      type: "session.exited",
      eventId: EventId.makeUnsafe("cursor-exit-a"),
      provider: "cursor",
      threadId: ThreadId.makeUnsafe("shared-cursor-thread"),
      createdAt: "2026-07-11T00:00:00.000Z",
      payload: { exitKind: "graceful" },
    };

    const stamped = stampCursorTerminalEventInstance(terminalEvent, accountA);

    expect(accountB).not.toBe(accountA);
    expect(stamped.providerInstanceId).toBe(accountA);
  });
});

describe("CursorAdapter ACP usage", () => {
  it("keeps the native session identity on token events for session-scoped accounting", () => {
    const event = makeAcpTokenUsageEvent({
      stamp: {
        eventId: EventId.makeUnsafe("cursor-usage-event"),
        createdAt: "2026-10-08T00:00:00.000Z",
      },
      provider: "cursor",
      threadId: ThreadId.makeUnsafe("cursor-thread"),
      turnId: undefined,
      providerRefs: { providerThreadId: "cursor-native-session" },
      usage: { usedTokens: 0, totalProcessedTokens: 12 },
      rawPayload: {},
    });

    expect(event.providerRefs).toEqual({ providerThreadId: "cursor-native-session" });
  });

  it("projects cumulative PromptResponse usage into profile token accounting", () => {
    expect(
      cursorPromptUsageSnapshot({
        totalTokens: 1_234.9,
        inputTokens: 900.2,
        outputTokens: 200.8,
        thoughtTokens: 100.4,
        cachedReadTokens: 30.6,
        cachedWriteTokens: 3.2,
      } satisfies Acp.Usage),
    ).toEqual({
      usedTokens: 0,
      totalProcessedTokens: 1_234,
      inputTokens: 900,
      outputTokens: 200,
      reasoningOutputTokens: 100,
      cachedInputTokens: 30,
      cacheCreationInputTokens: 3,
    });
  });

  it("ignores missing or invalid cumulative usage", () => {
    expect(cursorPromptUsageSnapshot(undefined)).toBeUndefined();
    expect(
      cursorPromptUsageSnapshot({
        totalTokens: Number.NaN,
        inputTokens: 0,
        outputTokens: 0,
      } satisfies Acp.Usage),
    ).toBeUndefined();
    expect(
      cursorPromptUsageSnapshot({
        totalTokens: 10,
        inputTokens: -1,
        outputTokens: 2,
      } satisfies Acp.Usage),
    ).toEqual({
      usedTokens: 0,
      totalProcessedTokens: 10,
      outputTokens: 2,
    });
  });

  it("preserves the latest context occupancy when adding cumulative spend", () => {
    expect(
      cursorPromptUsageSnapshot(
        { totalTokens: 400, inputTokens: 350, outputTokens: 50 } satisfies Acp.Usage,
        {
          usedTokens: 32_000,
          usedPercent: 12.5,
          maxTokens: 256_000,
          compactsAutomatically: true,
        },
      ),
    ).toMatchObject({
      usedTokens: 32_000,
      usedPercent: 12.5,
      maxTokens: 256_000,
      totalProcessedTokens: 400,
    });
  });
});
