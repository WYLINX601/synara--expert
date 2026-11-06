import { t } from "~/i18n";
import { useComposerDraftStore } from "~/composerDraftStore";
import { ThreadId, type NativeApi } from "@synara/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "vitest-browser-react";
import { useAmbientContextBindingStore } from "~/ambientContextBindingStore";
import { makeThread } from "~/storeTestFixtures";
import { ambientResourceSnapshot } from "~/lib/ambientContext";
import { useChatTurnFollowUps } from "./useChatTurnFollowUps";

vi.mock("~/workbench/host/ambientContextClient", () => ({
  readAmbientContextSendAuthorization: () => ({ allowed: true, generation: "fixture" }),
}));
const initialApi = window.nativeApi;
const threadId = ThreadId.makeUnsafe("plan-context-limit");
afterEach(() => {
  useComposerDraftStore.setState({ draftsByThreadId: {} });
  useAmbientContextBindingStore.setState({ byThreadId: {}, maxBindings: 5 });
  if (initialApi) window.nativeApi = initialApi;
  else delete window.nativeApi;
});
function setup() {
  useComposerDraftStore.setState({ draftsByThreadId: {} });
  const dispatchCommand = vi.fn(async () => undefined);
  window.nativeApi = { orchestration: { dispatchCommand } } as unknown as NativeApi;
  useAmbientContextBindingStore.setState({ byThreadId: {}, maxBindings: 5 });
  for (const id of ["paper", "work"])
    useAmbientContextBindingStore.getState().bind(threadId, { id, sourceId: id, label: id });
  useAmbientContextBindingStore.getState().setMaxBindings(1);
  const input = {
    threadId,
    activeThread: makeThread({ id: threadId }),
    isServerThread: true,
    isConnecting: false,
    isSendBusy: false,
    sendInFlightRef: { current: false },
    turnDispatchSettings: {
      modelSelection: { provider: "codex", model: "gpt-5-codex" },
      runtimeMode: "full-access",
      interactionMode: "default",
    },
    selectedProvider: "codex",
    selectedModel: "gpt-5-codex",
    selectedPromptEffort: null,
    activeProposedPlan: null,
    setThreadError: vi.fn(),
    beginLocalDispatch: vi.fn(),
    resetLocalDispatch: vi.fn(),
    setOptimisticUserMessages: vi.fn(),
    armTranscriptAutoFollow: vi.fn(),
    setTailAnchor: vi.fn(),
    tailAnchorScrollInFlightRef: { current: false },
    computerControlChangeSequence: { current: 0 },
    persistThreadSettingsForNextTurn: vi.fn(async () => undefined),
    setComposerDraftInteractionMode: vi.fn(),
    rememberCustomBinaryPathForDispatch: vi.fn(),
    setPlanSidebarOpen: vi.fn(),
    planSidebarDismissedForTurnRef: { current: null },
    armLocalDispatchAckFallback: vi.fn(),
  };
  return {
    input,
    dispatchCommand,
    hookInput: input as unknown as Parameters<typeof useChatTurnFollowUps>[0],
  };
}
describe("plan follow-up context limit", () => {
  it("blocks a new plan follow-up while retaining the over-limit thread bindings", async () => {
    const { input, dispatchCommand, hookInput } = setup();
    const hook = await renderHook(() => useChatTurnFollowUps(hookInput));
    expect(
      await hook.result.current.onSubmitPlanFollowUp({
        text: "Implement this plan",
        interactionMode: "default",
        dispatchMode: "queue",
      }),
    ).toBe(false);
    expect(input.setThreadError).toHaveBeenCalledWith(
      threadId,
      t("chat:ambientBindingLimitExceeded", { bound: 2, limit: 1 }),
    );
    expect(input.beginLocalDispatch).not.toHaveBeenCalled();
    expect(dispatchCommand).not.toHaveBeenCalled();
    expect(useAmbientContextBindingStore.getState().byThreadId[threadId]).toHaveLength(2);
    expect(input.sendInFlightRef.current).toBe(false);
    await hook.unmount();
  });
  it("replays already queued plan context unchanged even when the live binding limit was lowered", async () => {
    const { dispatchCommand, hookInput } = setup();
    const snapshot = ambientResourceSnapshot({
      sourceId: "paper",
      targetKey: "plan",
      uri: "obsidian://open?file=Plan.md",
      title: "Plan.md",
    });
    const hook = await renderHook(() => useChatTurnFollowUps(hookInput));
    expect(
      await hook.result.current.onSubmitPlanFollowUp({
        text: "Implement this plan",
        interactionMode: "default",
        dispatchMode: "queue",
        queuedTurn: {
          id: "queued",
          kind: "plan-follow-up",
          createdAt: new Date().toISOString(),
          previewText: "Implement this plan",
          text: "Implement this plan",
          interactionMode: "default",
          selectedProvider: "codex",
          selectedModel: "gpt-5-codex",
          selectedPromptEffort: null,
          modelSelection: { provider: "codex", model: "gpt-5-codex" },
          runtimeMode: "full-access",
          ambientContext: snapshot,
        },
      }),
    ).toBe(true);
    expect(dispatchCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "thread.turn.start",
        message: expect.objectContaining({ ambientContext: snapshot }),
      }),
    );
    expect(useAmbientContextBindingStore.getState().byThreadId[threadId]).toHaveLength(2);
    await hook.unmount();
  });
  it.each([false, true])(
    "restores the exact cleared prompt and captured snapshot on live failure (%s)",
    async (withContext) => {
      const { dispatchCommand, hookInput } = setup();
      dispatchCommand.mockRejectedValueOnce(new Error("Dispatch failed"));
      const snapshot = withContext
        ? ambientResourceSnapshot({
            sourceId: "paper",
            targetKey: "retry",
            uri: "obsidian://open?file=Retry.md",
            title: "Retry.md",
          })
        : undefined;
      const originalPrompt = withContext ? "  refine this part  " : "";
      const hook = await renderHook(() => useChatTurnFollowUps(hookInput));
      expect(
        await hook.result.current.onSubmitPlanFollowUp({
          text: "The sent follow-up",
          retryIntent: { prompt: originalPrompt, interactionMode: "plan" },
          ambientContext: snapshot,
          ambientContextCaptured: true,
          interactionMode: originalPrompt.trim() ? "plan" : "default",
          dispatchMode: "queue",
        }),
      ).toBe(false);
      const draft = useComposerDraftStore.getState().draftsByThreadId[threadId];
      expect(draft?.prompt).toBe(originalPrompt);
      expect(draft?.ambientContext).toEqual(snapshot);
      expect(draft?.ambientContextFrozen).toBe(true);
      expect(draft?.interactionMode).toBe("plan");
      await hook.unmount();
    },
  );

  it("does not restore a failed queued follow-up into the live composer", async () => {
    const { dispatchCommand, hookInput } = setup();
    dispatchCommand.mockRejectedValueOnce(new Error("Queued dispatch failed"));
    const hook = await renderHook(() => useChatTurnFollowUps(hookInput));
    expect(
      await hook.result.current.onSubmitPlanFollowUp({
        text: "Queued plan",
        interactionMode: "plan",
        dispatchMode: "queue",
        queuedTurn: {
          id: "queued-failure",
          kind: "plan-follow-up",
          createdAt: new Date().toISOString(),
          previewText: "Queued plan",
          text: "Queued plan",
          interactionMode: "plan",
          selectedProvider: "codex",
          selectedModel: "gpt-5-codex",
          selectedPromptEffort: null,
          modelSelection: { provider: "codex", model: "gpt-5-codex" },
          runtimeMode: "full-access",
        },
      }),
    ).toBe(false);
    expect(useComposerDraftStore.getState().draftsByThreadId[threadId]).toBeUndefined();
    await hook.unmount();
  });
});
