import type { ThreadId } from "@synara/contracts";

import { useComposerDraftStore } from "~/composerDraftStore";

/** Feature-scoped access to persisted Hub Worker reply drafts. */
export function useHubInputRequestReplyDraft(threadId: ThreadId): string {
  return useComposerDraftStore((state) => state.draftsByThreadId[threadId]?.prompt ?? "");
}

export function readHubInputRequestReplyDraft(threadId: ThreadId): string {
  return useComposerDraftStore.getState().draftsByThreadId[threadId]?.prompt ?? "";
}

export function setHubInputRequestReplyDraft(threadId: ThreadId, value: string): void {
  useComposerDraftStore.getState().setPrompt(threadId, value);
}
