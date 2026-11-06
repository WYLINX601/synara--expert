import { MessageId, ThreadId } from "@synara/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useComposerDraftStore, type QueuedComposerTurn } from "../composerDraftStore";
import { makeImage, resetComposerDraftStore } from "../composerDraftStoreTestFixtures";
import { useStore } from "../store";
import { initialState } from "../storeState";
import { makeState, makeThread, makeUsageLimitRecovery } from "../storeTestFixtures";
import { dispatchQueuedComposerTurnHeadless } from "./queuedComposerDispatch";
import * as composerSend from "./composerSend";
import { ambientResourceSnapshot } from "./ambientContext";

const nativeApiMocks = vi.hoisted(() => ({
  dispatchCommand: vi.fn(async () => undefined),
  getThreadDetailSnapshot: vi.fn(),
  readExpertSnapshot: vi.fn(),
  serverConnection: vi.fn(() => ({ connected: true, generation: "connection-1" })),
  serverCapability: vi.fn(() => "supported"),
}));

vi.mock("../nativeApi", () => ({
  readNativeApiServerConnection: nativeApiMocks.serverConnection,
  readNativeApiServerCapabilityState: nativeApiMocks.serverCapability,
  readNativeApi: () => ({
    server: { readExpertSnapshot: nativeApiMocks.readExpertSnapshot },
    orchestration: {
      dispatchCommand: nativeApiMocks.dispatchCommand,
      getThreadDetailSnapshot: nativeApiMocks.getThreadDetailSnapshot,
    },
  }),
}));

const THREAD_ID = ThreadId.makeUnsafe("thread-1");

function makeQueuedChatTurn(): QueuedComposerTurn {
  return {
    id: "queued-chat-1",
    kind: "chat",
    createdAt: "2026-03-13T12:00:00.000Z",
    previewText: "follow up after the turn",
    prompt: "follow up after the turn",
    images: [],
    files: [],
    assistantSelections: [],
    browserAnnotations: [],
    terminalContexts: [],
    fileComments: [],
    pastedTexts: [],
    pullRequestContexts: [],
    skills: [],
    mentions: [],
    selectedProvider: "codex",
    selectedModel: "gpt-5",
    selectedPromptEffort: null,
    modelSelection: {
      provider: "codex",
      model: "gpt-5",
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    envMode: "local",
  };
}

function makeQueuedPlanFollowUp(): QueuedComposerTurn {
  return {
    id: "queued-plan-1",
    kind: "plan-follow-up",
    createdAt: "2026-03-13T12:00:00.000Z",
    previewText: "implement the plan",
    text: "implement the plan",
    interactionMode: "default",
    selectedProvider: "codex",
    selectedModel: "gpt-5",
    selectedPromptEffort: null,
    modelSelection: {
      provider: "codex",
      model: "gpt-5",
    },
    runtimeMode: "full-access",
  };
}

describe("dispatchQueuedComposerTurnHeadless", () => {
  beforeEach(() => {
    resetComposerDraftStore();
    useStore.setState(initialState);
    nativeApiMocks.dispatchCommand.mockClear();
    nativeApiMocks.serverConnection.mockReturnValue({
      connected: true,
      generation: "connection-1",
    });
    nativeApiMocks.serverCapability.mockReturnValue("supported");
    useStore.setState(makeState(makeThread({ id: THREAD_ID })));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetComposerDraftStore();
    useStore.setState(initialState);
  });

  it.each(["chat"] as const)(
    "holds a %s before uploads or settings changes while a cache review is pending",
    async (kind) => {
      const stageUpload = vi.spyOn(composerSend, "stageUploadComposerAttachments");
      useStore.setState(
        makeState(
          makeThread({
            id: THREAD_ID,
            claudeCacheReview: {
              reviewId: "cache-review-1",
              messageId: MessageId.makeUnsafe("held-message"),
              sourceEventSequence: 8,
              assessment: {
                observedAt: "2026-09-16T10:00:00.000Z",
                state: "likely-expired",
                source: "session-start",
              },
              status: "pending",
              createdAt: "2026-09-16T10:00:00.000Z",
            },
          }),
        ),
      );
      const succeeded = await dispatchQueuedComposerTurnHeadless({
        threadId: THREAD_ID,
        queuedTurn: kind === "chat" ? makeQueuedChatTurn() : makeQueuedPlanFollowUp(),
        dispatchMode: "queue",
        assistantDeliveryMode: "streaming",
      });
      expect(succeeded).toBe(false);
      expect(stageUpload).not.toHaveBeenCalled();
      expect(nativeApiMocks.dispatchCommand).not.toHaveBeenCalled();
    },
  );

  it("dispatches a snapshotted chat turn with dispatchMode queue", async () => {
    const queuedTurn = makeQueuedChatTurn();
    const messageId = MessageId.makeUnsafe("queued-dispatch-message");
    const succeeded = await dispatchQueuedComposerTurnHeadless({
      threadId: THREAD_ID,
      queuedTurn,
      dispatchMode: "queue",
      assistantDeliveryMode: "streaming",
      messageId,
    });

    expect(succeeded).toBe(true);
    expect(nativeApiMocks.dispatchCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "thread.turn.start",
        threadId: THREAD_ID,
        dispatchMode: "queue",
        interactionMode: "default",
        runtimeMode: "full-access",
        assistantDeliveryMode: "streaming",
        message: expect.objectContaining({
          messageId,
          role: "user",
          text: "follow up after the turn",
        }),
      }),
    );
  });

  it("sends frozen queued context without replacing it with live composer pins", async () => {
    const queuedTurn = makeQueuedChatTurn();
    if (queuedTurn.kind !== "chat") throw new Error("chat fixture required");
    const snapshot = ambientResourceSnapshot({
      sourceId: "obsidian",
      targetKey: "queued-note",
      uri: "obsidian://open?file=Queued.md",
      title: "Queued.md",
    });
    queuedTurn.ambientContext = snapshot;
    queuedTurn.prompt = "";
    useComposerDraftStore.getState().setAmbientContext(
      THREAD_ID,
      ambientResourceSnapshot({
        sourceId: "obsidian",
        targetKey: "live-note",
        uri: "obsidian://open?file=Live.md",
        title: "Live.md",
      }),
    );
    expect(
      await dispatchQueuedComposerTurnHeadless({
        threadId: THREAD_ID,
        queuedTurn,
        dispatchMode: "queue",
        assistantDeliveryMode: "streaming",
      }),
    ).toBe(true);
    expect(nativeApiMocks.dispatchCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "thread.turn.start",
        message: expect.objectContaining({ ambientContext: snapshot }),
      }),
    );
  });

  it.each(["unsupported", "reconnect"])("keeps attached context queued on %s", async (failure) => {
    const queuedTurn = makeQueuedChatTurn();
    if (queuedTurn.kind !== "chat") throw new Error("chat fixture required");
    queuedTurn.ambientContext = ambientResourceSnapshot({
      sourceId: "obsidian",
      targetKey: "queued-note",
      uri: "obsidian://open?file=Queued.md",
      title: "Queued.md",
    });
    useComposerDraftStore.getState().enqueueQueuedTurn(THREAD_ID, queuedTurn);
    if (failure === "unsupported") nativeApiMocks.serverCapability.mockReturnValue("unsupported");
    else
      nativeApiMocks.dispatchCommand.mockImplementationOnce(async () => {
        nativeApiMocks.serverConnection.mockReturnValue({
          connected: true,
          generation: "connection-2",
        });
      });
    expect(
      await dispatchQueuedComposerTurnHeadless({
        threadId: THREAD_ID,
        queuedTurn,
        dispatchMode: "queue",
        assistantDeliveryMode: "streaming",
      }),
    ).toBe(false);
    expect(nativeApiMocks.dispatchCommand).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "thread.turn.start" }),
    );
    expect(useComposerDraftStore.getState().draftsByThreadId[THREAD_ID]?.queuedTurns).toEqual([
      queuedTurn,
    ]);
  });

  it("binds a queued draft skill to the accepted snapshot before dispatch", async () => {
    const packageId = `pkg_${"a".repeat(64)}`;
    const queuedTurn = makeQueuedChatTurn();
    if (queuedTurn.kind !== "chat") throw new Error("chat fixture required");
    queuedTurn.prompt = "$workflow run the selected workflow";
    queuedTurn.skills = [
      {
        name: "workflow",
        path: "ignored",
        expert: {
          snapshotId: "pending",
          packageId,
          entryPath: "workflow/SKILL.md",
        },
      },
    ];
    nativeApiMocks.getThreadDetailSnapshot.mockResolvedValue({
      thread: { expertBinding: { snapshotId: "accepted" } },
    });
    nativeApiMocks.readExpertSnapshot.mockResolvedValue({
      snapshotId: "accepted",
      skillEntries: [{ name: "workflow", packageId, entryPath: "workflow/SKILL.md" }],
    });
    expect(
      await dispatchQueuedComposerTurnHeadless({
        threadId: THREAD_ID,
        queuedTurn,
        dispatchMode: "queue",
        assistantDeliveryMode: "streaming",
      }),
    ).toBe(true);
    expect(nativeApiMocks.dispatchCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "thread.turn.start",
        message: expect.objectContaining({
          skills: [
            expect.objectContaining({
              expert: { snapshotId: "accepted", packageId, entryPath: "workflow/SKILL.md" },
            }),
          ],
        }),
      }),
    );
  });

  it("holds an early upload refusal until preparation settles without losing its queued retry", async () => {
    const queuedTurn = makeQueuedChatTurn();
    if (queuedTurn.kind !== "chat") throw new Error("Expected a queued chat");
    queuedTurn.images = [makeImage({ id: "retry-photo", previewUrl: "blob:retry-photo" })];
    useStore.setState(
      makeState(
        makeThread({
          id: THREAD_ID,
          modelSelection: queuedTurn.modelSelection,
          runtimeMode: "approval-required",
        }),
      ),
    );
    useComposerDraftStore.getState().enqueueQueuedTurn(THREAD_ID, queuedTurn);

    let finishPreparation: () => void = () => undefined;
    const preparation = new Promise<undefined>((resolve) => {
      finishPreparation = () => resolve(undefined);
    });
    nativeApiMocks.dispatchCommand.mockImplementationOnce(() => preparation);
    vi.stubGlobal("window", {
      desktopBridge: { getWsUrl: () => null },
      location: { origin: "synara-remote://app" },
    });
    vi.stubEnv("VITE_WS_URL", "");
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    let settled = false;
    const pending = dispatchQueuedComposerTurnHeadless({
      threadId: THREAD_ID,
      queuedTurn,
      dispatchMode: "queue",
      assistantDeliveryMode: "streaming",
    }).finally(() => {
      settled = true;
    });
    try {
      await vi.waitFor(() => expect(nativeApiMocks.dispatchCommand).toHaveBeenCalledOnce());
      // A real event-loop turn exposes an unobserved rejection while the RPC is held.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(unhandled).not.toHaveBeenCalled();
      expect(settled).toBe(false);
      expect(fetchMock).not.toHaveBeenCalled();

      finishPreparation();
      await expect(pending).resolves.toBe(false);
      expect(nativeApiMocks.dispatchCommand).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: "thread.turn.start" }),
      );
      expect(useComposerDraftStore.getState().draftsByThreadId[THREAD_ID]?.queuedTurns).toEqual([
        queuedTurn,
      ]);
    } finally {
      finishPreparation();
      try {
        await pending;
      } finally {
        process.off("unhandledRejection", unhandled);
        vi.unstubAllGlobals();
        vi.unstubAllEnvs();
      }
    }
  });

  it("sends a queued turn on the provider the thread was handed off to", async () => {
    const claudeSelection = { provider: "claudeAgent" as const, model: "claude-sonnet-5" };
    useStore.setState(
      makeState(
        makeThread({
          id: THREAD_ID,
          modelSelection: claudeSelection,
          latestTurn: {
            turnId: "turn-1" as never,
            state: "completed",
            requestedAt: "2026-03-13T11:00:00.000Z",
            startedAt: null,
            completedAt: null,
            assistantMessageId: null,
          },
        }),
      ),
    );

    const succeeded = await dispatchQueuedComposerTurnHeadless({
      threadId: THREAD_ID,
      queuedTurn: makeQueuedChatTurn(),
      dispatchMode: "queue",
      assistantDeliveryMode: "streaming",
    });

    expect(succeeded).toBe(true);
    // Writing the queued Codex selection back would flip the thread off Claude.
    expect(nativeApiMocks.dispatchCommand).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "thread.meta.update" }),
    );
    expect(nativeApiMocks.dispatchCommand).toHaveBeenCalledWith(
      expect.objectContaining({ type: "thread.turn.start", modelSelection: claudeSelection }),
    );
  });

  it("dispatches a snapshotted plan follow-up as its own turn kind", async () => {
    const succeeded = await dispatchQueuedComposerTurnHeadless({
      threadId: THREAD_ID,
      queuedTurn: makeQueuedPlanFollowUp(),
      dispatchMode: "queue",
      assistantDeliveryMode: "buffered",
    });

    expect(succeeded).toBe(true);
    expect(nativeApiMocks.dispatchCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "thread.turn.start",
        threadId: THREAD_ID,
        dispatchMode: "queue",
        interactionMode: "default",
        assistantDeliveryMode: "buffered",
        message: expect.objectContaining({
          role: "user",
          text: "implement the plan",
          attachments: [],
        }),
      }),
    );
  });

  it.each(["chat", "plan-follow-up"] as const)(
    "holds %s before uploads or settings changes while the host owns a recovery",
    async (kind) => {
      const stageUpload = vi.spyOn(composerSend, "stageUploadComposerAttachments");
      useStore.setState(makeState(makeThread({ usageLimitRecovery: makeUsageLimitRecovery() })));
      expect(
        await dispatchQueuedComposerTurnHeadless({
          threadId: THREAD_ID,
          queuedTurn: kind === "chat" ? makeQueuedChatTurn() : makeQueuedPlanFollowUp(),
          dispatchMode: "queue",
          assistantDeliveryMode: "streaming",
        }),
      ).toBe(false);
      expect(stageUpload).not.toHaveBeenCalled();
      expect(nativeApiMocks.dispatchCommand).not.toHaveBeenCalled();
    },
  );

  it("keeps the queued message and cleans staged attachments if a wait arrives during upload", async () => {
    type Staged = Awaited<ReturnType<typeof composerSend.stageUploadComposerAttachments>>;
    let finishStaging: ((value: Staged) => void) | undefined;
    const upload = new Promise<Staged>((resolve) => {
      finishStaging = resolve;
    });
    const stageUpload = vi
      .spyOn(composerSend, "stageUploadComposerAttachments")
      .mockReturnValue(upload);
    const queuedTurn = makeQueuedChatTurn();
    useStore.setState(makeState(makeThread({ modelSelection: queuedTurn.modelSelection })));
    const result = dispatchQueuedComposerTurnHeadless({
      threadId: THREAD_ID,
      queuedTurn,
      dispatchMode: "queue",
      assistantDeliveryMode: "streaming",
    });
    await vi.waitFor(() => expect(stageUpload).toHaveBeenCalledOnce());
    useStore.setState(
      makeState(
        makeThread({
          modelSelection: queuedTurn.modelSelection,
          usageLimitRecovery: makeUsageLimitRecovery(),
        }),
      ),
    );
    const cleanup = vi.fn(async () => undefined);
    const runWithDispatch = vi.fn();
    finishStaging?.({
      attachments: [],
      cleanup,
      commit: vi.fn(),
      runWithDispatch: async (dispatch) => {
        runWithDispatch();
        return dispatch([]);
      },
    });
    expect(await result).toBe(false);
    expect(cleanup).toHaveBeenCalledOnce();
    expect(runWithDispatch).not.toHaveBeenCalled();
    expect(nativeApiMocks.dispatchCommand).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "thread.turn.start" }),
    );
  });

  it("returns false when the thread is not in the store", async () => {
    useStore.setState(initialState);
    const succeeded = await dispatchQueuedComposerTurnHeadless({
      threadId: THREAD_ID,
      queuedTurn: makeQueuedChatTurn(),
      dispatchMode: "queue",
      assistantDeliveryMode: "streaming",
    });
    expect(succeeded).toBe(false);
    expect(nativeApiMocks.dispatchCommand).not.toHaveBeenCalled();
  });

  it.each(["chat", "plan-follow-up"] as const)(
    "accepts the exact held %s after a lost RPC acknowledgement without cleaning its attachments",
    async (kind) => {
      const messageId = MessageId.makeUnsafe("accepted-held-message");
      const queuedTurn = kind === "chat" ? makeQueuedChatTurn() : makeQueuedPlanFollowUp();
      const idleThread = makeThread({ id: THREAD_ID, modelSelection: queuedTurn.modelSelection });
      useStore.setState(makeState(idleThread));
      const cleanup = vi.fn(async () => undefined);
      const commit = vi.fn();
      vi.spyOn(composerSend, "stageUploadComposerAttachments").mockResolvedValue({
        attachments: [],
        cleanup,
        commit,
        runWithDispatch: async (dispatch) => {
          try {
            const result = await dispatch([]);
            commit();
            return result;
          } catch (error) {
            await cleanup();
            throw error;
          }
        },
      });
      nativeApiMocks.dispatchCommand.mockImplementationOnce(async () => {
        useStore.setState(
          makeState({
            ...idleThread,
            claudeCacheReview: {
              reviewId: "cache-review-accepted",
              messageId,
              sourceEventSequence: 8,
              assessment: {
                observedAt: "2026-09-16T10:00:00.000Z",
                state: "likely-expired",
                source: "session-start",
              },
              status: "pending",
              createdAt: "2026-09-16T10:00:00.000Z",
            },
          }),
        );
        throw new Error("RPC acknowledgement lost");
      });
      const accepted = await dispatchQueuedComposerTurnHeadless({
        threadId: THREAD_ID,
        queuedTurn,
        dispatchMode: "queue",
        assistantDeliveryMode: "streaming",
        messageId,
      });
      expect(accepted).toBe(true);
      expect(cleanup).not.toHaveBeenCalled();
      if (kind === "chat") expect(commit).toHaveBeenCalledOnce();
    },
  );
});
