import { ApprovalRequestId, CommandId, ThreadId, TurnId, type NativeApi } from "@synara/contracts";
import { afterEach, expect, it, vi } from "vitest";
import { renderHook } from "vitest-browser-react";

import { useComposerDraftStore } from "../../composerDraftStore";
import { resetComposerDraftStore } from "../../composerDraftStoreTestFixtures";
import { makeActivity, makeThread } from "../../storeTestFixtures";
import type { Thread } from "../../types";
import { useChatPendingInteractions } from "./useChatPendingInteractions";

const originalNativeApi = window.nativeApi;

afterEach(() => {
  resetComposerDraftStore();
  if (originalNativeApi) window.nativeApi = originalNativeApi;
  else delete window.nativeApi;
});

const threadId = ThreadId.makeUnsafe("pending-gate-thread");
const turnId = TurnId.makeUnsafe("pending-gate-turn");
const createdAt = "2026-10-06T19:53:00.000Z";

function threadWithPendingRequests(session: Thread["session"]): Thread {
  const approvalId = ApprovalRequestId.makeUnsafe("pending-gate-approval");
  const userInputId = ApprovalRequestId.makeUnsafe("pending-gate-question");
  return makeThread({
    id: threadId,
    session,
    latestTurn: {
      turnId,
      state: "running",
      requestedAt: createdAt,
      startedAt: createdAt,
      completedAt: null,
      assistantMessageId: null,
    },
    hasPendingApprovals: true,
    hasPendingUserInput: true,
    activities: [
      makeActivity({
        id: "pending-gate-approval-requested",
        kind: "approval.requested",
        tone: "approval",
        createdAt,
        sequence: 1,
        turnId,
        payload: {
          requestId: approvalId,
          requestKind: "command",
          requestType: "command_execution_approval",
          detail: "Command: git status",
        },
      }),
      makeActivity({
        id: "pending-gate-question-requested",
        kind: "user-input.requested",
        tone: "info",
        createdAt,
        sequence: 2,
        turnId,
        payload: {
          requestId: userInputId,
          questions: [{ id: "next", header: "Next", question: "Continue?", options: [] }],
        },
      }),
    ],
  });
}

function renderPendingInteractions(thread: Thread) {
  return renderHook(
    (currentThread = thread) =>
      useChatPendingInteractions({
        threadId: currentThread.id,
        activeThread: currentThread,
        runtimeMode: "approval-required",
        promptRef: { current: "" },
        setPrompt: () => undefined,
        setComposerCursor: () => undefined,
        setComposerTrigger: () => undefined,
        setComposerHighlightedItemId: () => undefined,
      }),
    { initialProps: thread },
  );
}

it("keeps pending requests of a live session actionable", async () => {
  const { result } = await renderPendingInteractions(
    threadWithPendingRequests({
      provider: "codex",
      status: "running",
      orchestrationStatus: "running",
      activeTurnId: turnId,
      createdAt,
      updatedAt: createdAt,
    }),
  );
  expect(result.current.pendingApprovals).toHaveLength(1);
  expect(result.current.activePendingApproval?.requestId).toBe("pending-gate-approval");
  expect(result.current.pendingUserInputs).toHaveLength(1);
});

it.each([
  ["stopped", "closed"],
  ["error", "error"],
] as const)(
  "does not hold the composer on requests a %s session can no longer answer",
  async (orchestrationStatus, status) => {
    // Matches the sidebar pill, Kanban and Tasks gating: a closed or errored
    // session has no live provider callback to deliver an answer to.
    const { result } = await renderPendingInteractions(
      threadWithPendingRequests({
        provider: "codex",
        status,
        orchestrationStatus,
        activeTurnId: undefined,
        createdAt,
        updatedAt: createdAt,
      }),
    );
    expect(result.current.pendingApprovals).toEqual([]);
    expect(result.current.activePendingApproval).toBeNull();
    expect(result.current.pendingUserInputs).toEqual([]);
  },
);

async function mountApprovalInteractions() {
  const dispatchCommand = vi
    .fn<(_command: unknown) => Promise<void>>()
    .mockResolvedValue(undefined);
  window.nativeApi = {
    orchestration: {
      dispatchCommand,
      subscribeThread: vi.fn(async () => undefined),
    },
  } as unknown as NativeApi;
  const thread = threadWithPendingRequests({
    provider: "codex",
    status: "running",
    orchestrationStatus: "running",
    activeTurnId: turnId,
    createdAt,
    updatedAt: createdAt,
  });
  useComposerDraftStore.getState().setRuntimeMode(thread.id, "approval-required");
  const hook = await renderPendingInteractions(thread);
  const requestId = hook.result.current.activePendingApproval!.requestId;
  return { hook, thread, requestId, dispatchCommand };
}

it("claims an approval synchronously across repeated handlers while a response is pending", async () => {
  const { hook, requestId, dispatchCommand } = await mountApprovalInteractions();
  let resolveResponse!: () => void;
  const response = new Promise<void>((resolve) => {
    resolveResponse = resolve;
  });
  dispatchCommand.mockImplementationOnce(() => response);
  const firstResponse = hook.result.current.onRespondToApproval(
    requestId,
    "accept",
    undefined,
    "command",
  );
  await hook.result.current.onRespondToApproval(
    requestId,
    "acceptForSession",
    undefined,
    "command",
  );
  await expect.poll(() => dispatchCommand.mock.calls.length).toBe(1);
  await expect.poll(() => hook.result.current.respondingRequestKeys.length).toBe(1);
  expect(useComposerDraftStore.getState().draftsByThreadId[threadId]?.runtimeMode).toBe(
    "approval-required",
  );
  resolveResponse();
  await firstResponse;
  await expect.poll(() => hook.result.current.respondingRequestKeys).toEqual([]);
});

it("retains an accepted approval claim across card replacement without escalating local permissions", async () => {
  const { hook, thread, requestId, dispatchCommand } = await mountApprovalInteractions();
  await hook.result.current.onRespondToApproval(requestId, "accept", undefined, "command");
  await hook.rerender({ ...thread });
  await hook.result.current.onRespondToApproval(
    requestId,
    "acceptForSession",
    undefined,
    "command",
  );
  await hook.result.current.onRespondToApproval(requestId, "cancel", undefined, "command");
  expect(dispatchCommand.mock.calls).toEqual([
    [
      expect.objectContaining({
        type: "thread.approval.respond",
        threadId,
        requestId,
        decision: "accept",
      }),
    ],
  ]);
  expect(useComposerDraftStore.getState().draftsByThreadId[threadId]?.runtimeMode).toBe(
    "approval-required",
  );
});

it("releases an approval claim after immediate dispatch failure so the original decision can retry", async () => {
  const { hook, requestId, dispatchCommand } = await mountApprovalInteractions();
  dispatchCommand.mockRejectedValueOnce(new Error("Temporary dispatch failure"));
  await expect(
    hook.result.current.onRespondToApproval(requestId, "decline", undefined, "command"),
  ).rejects.toThrow("Temporary dispatch failure");
  await expect.poll(() => hook.result.current.respondingRequestKeys).toEqual([]);
  await hook.result.current.onRespondToApproval(requestId, "decline", undefined, "command");
  await hook.result.current.onRespondToApproval(requestId, "cancel", undefined, "command");
  expect(dispatchCommand).toHaveBeenCalledTimes(2);
  expect(dispatchCommand.mock.calls[1]).toEqual([expect.objectContaining({ decision: "decline" })]);
});

it("allows exactly one new response when a durable retry attempt changes", async () => {
  const { hook, thread, requestId, dispatchCommand } = await mountApprovalInteractions();
  await hook.result.current.onRespondToApproval(requestId, "accept", undefined, "command");
  const retryable = {
    ...thread,
    pendingInteractions: [
      {
        interactionKind: "approval" as const,
        requestId,
        threadId,
        lifecycleGeneration: null,
        turnId,
        status: "retryable" as const,
        decision: "accept" as const,
        responseCommandId: CommandId.makeUnsafe("approval-attempt-1"),
        responseRequestedAt: createdAt,
        createdAt,
        resolvedAt: null,
      },
    ],
  };
  await hook.rerender(retryable);
  await hook.result.current.onRespondToApproval(requestId, "decline", undefined, "command");
  await hook.result.current.onRespondToApproval(requestId, "cancel", undefined, "command");
  expect(dispatchCommand).toHaveBeenCalledTimes(2);
  await hook.rerender(thread);
  await hook.result.current.onRespondToApproval(
    requestId,
    "acceptForSession",
    undefined,
    "command",
  );
  expect(dispatchCommand).toHaveBeenCalledTimes(2);
  expect(useComposerDraftStore.getState().draftsByThreadId[threadId]?.runtimeMode).toBe(
    "approval-required",
  );
  await hook.rerender({
    ...retryable,
    pendingInteractions: [
      {
        ...retryable.pendingInteractions[0]!,
        responseCommandId: CommandId.makeUnsafe("approval-attempt-2"),
      },
    ],
  });
  await hook.result.current.onRespondToApproval(requestId, "cancel", undefined, "command");
  await hook.result.current.onRespondToApproval(requestId, "accept", undefined, "command");
  expect(dispatchCommand).toHaveBeenCalledTimes(3);
  expect(dispatchCommand.mock.calls[2]).toEqual([expect.objectContaining({ decision: "cancel" })]);
});

it("keeps accepted claims isolated by thread when the same request id appears in another chat", async () => {
  const { hook, thread, requestId, dispatchCommand } = await mountApprovalInteractions();
  await hook.result.current.onRespondToApproval(requestId, "accept", undefined, "command");
  const otherThread = { ...thread, id: ThreadId.makeUnsafe("other-approval-thread") };
  await hook.rerender(otherThread);
  await hook.result.current.onRespondToApproval(requestId, "decline", undefined, "command");
  await hook.rerender(thread);
  await hook.result.current.onRespondToApproval(
    requestId,
    "acceptForSession",
    undefined,
    "command",
  );
  expect(dispatchCommand.mock.calls).toEqual([
    [expect.objectContaining({ threadId, decision: "accept" })],
    [expect.objectContaining({ threadId: otherThread.id, decision: "decline" })],
  ]);
  expect(useComposerDraftStore.getState().draftsByThreadId[threadId]?.runtimeMode).toBe(
    "approval-required",
  );
});

it("releases an accepted claim when its request disappears", async () => {
  const { hook, thread, requestId, dispatchCommand } = await mountApprovalInteractions();
  await hook.result.current.onRespondToApproval(requestId, "accept", undefined, "command");
  await hook.rerender({ ...thread, hasPendingApprovals: false });
  expect(hook.result.current.pendingApprovals).toEqual([]);
  await hook.rerender(thread);
  await hook.result.current.onRespondToApproval(requestId, "decline", undefined, "command");
  expect(dispatchCommand).toHaveBeenCalledTimes(2);
});

it("retains an accepted claim while the durable responding settlement temporarily hides the card", async () => {
  const { hook, thread, requestId, dispatchCommand } = await mountApprovalInteractions();
  await hook.result.current.onRespondToApproval(requestId, "accept", undefined, "command");
  await hook.rerender({
    ...thread,
    pendingInteractions: [
      {
        interactionKind: "approval",
        requestId,
        threadId,
        lifecycleGeneration: null,
        turnId,
        status: "responding",
        decision: "accept",
        responseCommandId: CommandId.makeUnsafe("approval-recorded"),
        responseRequestedAt: createdAt,
        createdAt,
        resolvedAt: null,
      },
    ],
  });
  expect(hook.result.current.activePendingApproval).toBeNull();
  await hook.rerender(thread);
  await hook.result.current.onRespondToApproval(
    requestId,
    "acceptForSession",
    undefined,
    "command",
  );
  expect(dispatchCommand).toHaveBeenCalledOnce();
  expect(useComposerDraftStore.getState().draftsByThreadId[threadId]?.runtimeMode).toBe(
    "approval-required",
  );
});

it("treats a new lifecycle generation as a different approval even when the request id is reused", async () => {
  const { hook, thread, requestId, dispatchCommand } = await mountApprovalInteractions();
  await hook.result.current.onRespondToApproval(requestId, "accept", undefined, "command");
  const lifecycleGeneration = "approval-generation-2";
  await hook.rerender({
    ...thread,
    activities: [
      makeActivity({
        kind: "approval.requested",
        createdAt,
        turnId,
        payload: {
          requestId,
          lifecycleGeneration,
          requestKind: "command",
          detail: "Command: git status",
        },
      }),
    ],
  });
  await hook.result.current.onRespondToApproval(
    requestId,
    "decline",
    lifecycleGeneration,
    "command",
  );
  await hook.result.current.onRespondToApproval(
    requestId,
    "cancel",
    lifecycleGeneration,
    "command",
  );
  expect(dispatchCommand).toHaveBeenCalledTimes(2);
  expect(dispatchCommand.mock.calls[1]).toEqual([
    expect.objectContaining({ decision: "decline", lifecycleGeneration }),
  ]);
});
