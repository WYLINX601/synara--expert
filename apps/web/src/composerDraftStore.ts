// FILE: composerDraftStore.ts
// Purpose: Public Zustand facade for composer drafts, model choices, attachments, and persistence.
// Exports: Stable composer draft API, hooks, and promotion helpers.

import {
  type ModelSelection,
  type ProviderInstanceId,
  type ProviderKind,
  type ThreadId,
} from "@synara/contracts";
import { useMemo } from "react";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { useShallow } from "zustand/react/shallow";

import { createComposerDraftStoreState } from "./composerDraftActions";
import {
  COMPOSER_DRAFT_STORAGE_KEY,
  COMPOSER_DRAFT_STORAGE_VERSION,
  composerThreadDraftIsPending,
  composerThreadDraftPreviewText,
  selectComposerThreadDraft,
  selectThreadIdsWithPendingDraft,
  type ComposerDraftStoreState,
  type ComposerThreadDraftState,
} from "./composerDraftDomain";
import {
  deriveEffectiveComposerModelState,
  type EffectiveComposerModelState,
} from "./composerDraftModels";
import {
  migratePersistedComposerDraftStoreState,
  normalizeCurrentPersistedComposerDraftStoreState,
  partializeComposerDraftStoreState,
  toHydratedThreadDraft,
  type PersistedComposerDraftStoreState,
} from "./composerDraftPersistence";
import {
  createDeferredPersistStorage,
  createMemoryStorage,
  flushStorageBeforePageHide,
  type StateStorage,
} from "./lib/storage";
import {
  assertComposerPersistenceAllowed,
  notifyComposerPersistenceChanged,
} from "./lib/composerPersistenceActivity";

export {
  findSupersededComposerImageBlobAttachments,
  isComposerImageBlobReferenced,
} from "./composerDraftAttachments";
export {
  captureComposerPromptHistorySavedDraft,
  composerThreadDraftIsPending,
  COMPOSER_DRAFT_STORAGE_KEY,
  COMPOSER_DRAFT_STORAGE_VERSION,
  PersistedComposerImageAttachment,
} from "./composerDraftDomain";
export type {
  ComposerAssistantSelectionAttachment,
  ComposerAttachmentPersistenceResult,
  ComposerDraftStoreState,
  ComposerFileAttachment,
  ComposerImageAttachment,
  ComposerPromptHistorySavedDraft,
  ComposerThreadDraftState,
  DraftThreadEnvMode,
  DraftThreadState,
  QueuedComposerChatTurn,
  QueuedComposerPlanFollowUp,
  QueuedComposerTurn,
  RestoredComposerSourceProposedPlan,
} from "./composerDraftDomain";
export type { BrowserAnnotationDraft } from "./lib/browserAnnotations";
export {
  deriveEffectiveComposerModelState,
  providerInstanceModelSelectionKey,
  resolvePreferredComposerModelSelection,
} from "./composerDraftModels";
export type { EffectiveComposerModelState } from "./composerDraftModels";
export { partializeComposerDraftStoreState } from "./composerDraftPersistence";

const COMPOSER_PERSIST_DEBOUNCE_MS = 300;
const composerBaseStorage: StateStorage =
  typeof localStorage !== "undefined" ? localStorage : createMemoryStorage();
const composerPersistStorage = createDeferredPersistStorage<
  ComposerDraftStoreState,
  PersistedComposerDraftStoreState
>({
  getStorage: () => composerBaseStorage,
  partialize: partializeComposerDraftStoreState,
  debounceMs: COMPOSER_PERSIST_DEBOUNCE_MS,
});

// Flush pending composer draft writes before the page goes away so at most one
// debounce window of changes can be lost.
flushStorageBeforePageHide(() => composerPersistStorage.flush());

export const useComposerDraftStore = create<ComposerDraftStoreState>()(
  persist(
    (set, get, api): ComposerDraftStoreState => {
      const state = createComposerDraftStoreState(() => composerPersistStorage.flush())(
        set,
        get,
        api,
      );
      // Fence the public actions before their blob cleanup or state side effects.
      for (const [key, action] of Object.entries(state)) {
        if (typeof action !== "function" || key.startsWith("get")) continue;
        Object.assign(state, {
          [key]: (...args: unknown[]) => {
            assertComposerPersistenceAllowed();
            return Reflect.apply(action, state, args);
          },
        });
      }
      return state;
    },
    {
      name: COMPOSER_DRAFT_STORAGE_KEY,
      version: COMPOSER_DRAFT_STORAGE_VERSION,
      // Partialization is owned by deferred storage so serialization does not run
      // on each keystroke and instead happens once per 300ms flush window.
      storage: composerPersistStorage,
      migrate: migratePersistedComposerDraftStoreState,
      merge: (persistedState, currentState) => {
        const normalizedPersisted =
          normalizeCurrentPersistedComposerDraftStoreState(persistedState);
        const draftsByThreadId = Object.fromEntries(
          Object.entries(normalizedPersisted.draftsByThreadId).map(([threadId, draft]) => [
            threadId,
            toHydratedThreadDraft(threadId as ThreadId, draft),
          ]),
        );
        return {
          ...currentState,
          draftsByThreadId,
          draftThreadsByThreadId: normalizedPersisted.draftThreadsByThreadId,
          projectDraftThreadIdByProjectId: normalizedPersisted.projectDraftThreadIdByProjectId,
          stickyModelSelectionByProvider: normalizedPersisted.stickyModelSelectionByProvider ?? {},
          stickyActiveProvider: normalizedPersisted.stickyActiveProvider ?? null,
        };
      },
    },
  ),
);

// Direct hydration/reconciliation writes must also revoke a previously acknowledged lease.
useComposerDraftStore.subscribe(notifyComposerPersistenceChanged);

/** File attachments are transient in every draft slot. Images need committed
 * metadata, or an inline data URL for queued turns, to survive restart. */
export function composerDraftDurabilitySnapshot(): {
  transientAttachments: number;
  hydrated: boolean;
} {
  let transientAttachments = 0;
  for (const draft of Object.values(useComposerDraftStore.getState().draftsByThreadId)) {
    const inspect = (
      slot: Pick<
        ComposerThreadDraftState,
        "images" | "files" | "persistedAttachments" | "nonPersistedImageIds"
      >,
    ) => {
      transientAttachments += slot.files.length;
      const persisted = new Set(
        slot.persistedAttachments
          .filter((attachment) => attachment.blobKey || attachment.dataUrl)
          .map((attachment) => attachment.id),
      );
      for (const image of slot.images) {
        if (!persisted.has(image.id) || slot.nonPersistedImageIds.includes(image.id))
          transientAttachments += 1;
      }
    };
    inspect(draft);
    if (draft.promptHistorySavedDraft) inspect(draft.promptHistorySavedDraft);
    for (const turn of draft.queuedTurns) {
      if (turn.kind !== "chat") continue;
      transientAttachments += turn.files.length;
      for (const image of turn.images) {
        if (!image.previewUrl.startsWith("data:")) transientAttachments += 1;
      }
    }
  }
  return { transientAttachments, hydrated: useComposerDraftStore.persist.hasHydrated() };
}

export function useComposerThreadDraft(threadId: ThreadId): ComposerThreadDraftState {
  return useComposerDraftStore((state) => selectComposerThreadDraft(state, threadId));
}

export function useThreadHasPendingDraft(threadId: ThreadId): boolean {
  return useComposerDraftStore((state) => {
    const draft = state.draftsByThreadId[threadId];
    return draft !== undefined && composerThreadDraftIsPending(draft);
  });
}

/** Short excerpt of the chat's unsent prompt, or null when it has no draft text. */
export function useThreadDraftPreviewText(threadId: ThreadId): string | null {
  return useComposerDraftStore((state) =>
    composerThreadDraftPreviewText(state.draftsByThreadId[threadId]),
  );
}

/**
 * Threads whose composer holds an unsent message. The set only changes identity when
 * a thread gains or loses its draft, not on every keystroke.
 */
export function useThreadIdsWithPendingDraft(): ReadonlySet<ThreadId> {
  const threadIds = useComposerDraftStore(useShallow(selectThreadIdsWithPendingDraft));
  return useMemo(() => new Set(threadIds), [threadIds]);
}

export function useEffectiveComposerModelState(input: {
  threadId: ThreadId;
  selectedProvider: ProviderKind;
  selectedProviderInstanceId?: ProviderInstanceId | null | undefined;
  threadModelSelection: ModelSelection | null | undefined;
  projectModelSelection: ModelSelection | null | undefined;
  customModelsByProvider: Record<ProviderKind, readonly string[]>;
  availableModelOptionsByProvider?: Partial<
    Record<ProviderKind, ReadonlyArray<{ slug: string; name: string }>>
  >;
}): EffectiveComposerModelState {
  const draft = useComposerThreadDraft(input.threadId);
  return deriveEffectiveComposerModelState({
    draft,
    selectedProvider: input.selectedProvider,
    selectedProviderInstanceId: input.selectedProviderInstanceId,
    threadModelSelection: input.threadModelSelection,
    projectModelSelection: input.projectModelSelection,
    customModelsByProvider: input.customModelsByProvider,
    ...(input.availableModelOptionsByProvider !== undefined
      ? { availableModelOptionsByProvider: input.availableModelOptionsByProvider }
      : {}),
  });
}

// Mark drafts as promoted first; route/composer cleanup happens after the server thread starts.
export function markPromotedDraftThreads(serverThreadIds: ReadonlySet<ThreadId>): void {
  const store = useComposerDraftStore.getState();
  const draftThreadIds = Object.keys(store.draftThreadsByThreadId) as ThreadId[];
  for (const draftId of draftThreadIds) {
    if (serverThreadIds.has(draftId)) {
      store.markDraftThreadPromoting(draftId);
    }
  }
}

export function finalizePromotedDraftThreads(serverThreadIds: ReadonlySet<ThreadId>): void {
  const store = useComposerDraftStore.getState();
  for (const threadId of serverThreadIds) {
    store.finalizePromotedDraftThread(threadId);
  }
}
