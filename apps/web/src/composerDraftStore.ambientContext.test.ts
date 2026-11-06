import { ThreadId } from "@synara/contracts";
import { beforeEach, describe, expect, it } from "vitest";
import {
  captureComposerPromptHistorySavedDraft,
  partializeComposerDraftStoreState,
  useComposerDraftStore,
} from "./composerDraftStore";
import {
  normalizeCurrentPersistedComposerDraftStoreState,
  toHydratedThreadDraft,
} from "./composerDraftPersistence";
import { makeQueuedChatTurn, resetComposerDraftStore } from "./composerDraftStoreTestFixtures";
import {
  ambientContextItemKey,
  removeAmbientContextItem,
  ambientResourceSnapshot,
  cloneAmbientContext,
  mergeAmbientContext,
} from "./lib/ambientContext";

const threadA = ThreadId.makeUnsafe("ambient-a");
const threadB = ThreadId.makeUnsafe("ambient-b");
const resource = {
  sourceId: "obsidian",
  targetKey: "note-1",
  uri: "obsidian://open?vault=Research&file=Note.md",
  title: "Note.md",
};

beforeEach(resetComposerDraftStore);

describe("ambient context composer ownership", () => {
  it("pins identity only, isolates threads, and copies input before storing", () => {
    const snapshot = ambientResourceSnapshot(resource);
    useComposerDraftStore.getState().setAmbientContext(threadA, snapshot);
    expect(snapshot.items.map((item) => item.observation.type)).toEqual(["resource.identity"]);
    const draft = useComposerDraftStore.getState().draftsByThreadId[threadA]!;
    expect(draft.ambientContext).toEqual(snapshot);
    expect(draft.ambientContext).not.toBe(snapshot);
    expect(useComposerDraftStore.getState().draftsByThreadId[threadB]).toBeUndefined();
    useComposerDraftStore
      .getState()
      .setAmbientContext(
        threadB,
        ambientResourceSnapshot({ ...resource, targetKey: "note-2", title: "Other.md" }),
      );
    useComposerDraftStore.getState().clearComposerContent(threadB);
    expect(useComposerDraftStore.getState().draftsByThreadId[threadA]?.ambientContext).toEqual(
      snapshot,
    );
  });

  it("persists a context-only draft and restores the exact snapshot", () => {
    const snapshot = ambientResourceSnapshot(resource);
    useComposerDraftStore.getState().setAmbientContext(threadA, snapshot);
    const persisted = partializeComposerDraftStoreState(useComposerDraftStore.getState());
    const normalized = normalizeCurrentPersistedComposerDraftStoreState(
      JSON.parse(JSON.stringify(persisted)),
    );
    const restored = toHydratedThreadDraft(threadA, normalized.draftsByThreadId[threadA]!);
    expect(restored.ambientContext).toEqual(snapshot);
    useComposerDraftStore.getState().setAmbientContext(threadA, { ...snapshot, items: [] });
    expect(useComposerDraftStore.getState().draftsByThreadId[threadA]).toBeUndefined();
  });

  it("queue persistence keeps the frozen context after live pins change", () => {
    const snapshot = ambientResourceSnapshot(resource);
    const queued = makeQueuedChatTurn("queued");
    if (queued.kind !== "chat") throw new Error("Expected chat fixture");
    queued.ambientContext = cloneAmbientContext(snapshot);
    useComposerDraftStore.getState().enqueueQueuedTurn(threadA, queued);
    useComposerDraftStore
      .getState()
      .setAmbientContext(
        threadA,
        ambientResourceSnapshot({ ...resource, targetKey: "later", title: "Later.md" }),
      );
    const persisted = partializeComposerDraftStoreState(useComposerDraftStore.getState());
    const normalized = normalizeCurrentPersistedComposerDraftStoreState(
      JSON.parse(JSON.stringify(persisted)),
    );
    const restored = toHydratedThreadDraft(threadA, normalized.draftsByThreadId[threadA]!);
    const turn = restored.queuedTurns[0]!;
    expect(turn.kind === "chat" && turn.ambientContext).toEqual(snapshot);
    expect(restored.ambientContext).not.toEqual(snapshot);
  });

  it("protects pins while browsing prompt history and restores them", () => {
    const snapshot = ambientResourceSnapshot(resource);
    const store = useComposerDraftStore.getState();
    store.setAmbientContext(threadA, snapshot);
    const saved = captureComposerPromptHistorySavedDraft({
      threadId: threadA,
      prompt: "Draft",
      draft: useComposerDraftStore.getState().draftsByThreadId[threadA]!,
    });
    store.setPromptHistorySavedDraft(threadA, saved);
    store.restorePromptHistorySavedDraft(threadA);
    expect(useComposerDraftStore.getState().draftsByThreadId[threadA]?.ambientContext).toEqual(
      snapshot,
    );
  });

  it("keeps changed file/selection captures despite reused source-local observation IDs", () => {
    const first = ambientResourceSnapshot(resource);
    const original = first.items[0]!;
    const second = {
      ...first,
      items: [
        {
          ...original,
          observation: {
            ...original.observation,
            targetKey: "note-2",
            capturedAt: "2026-11-06T00:00:00.000Z",
            type: "resource.identity" as const,
            value: {
              uri: "obsidian://open?file=Other.md",
              title: "Other.md",
              kind: "file" as const,
            },
          },
        },
      ],
    };
    const pins = mergeAmbientContext(first, second);
    expect(pins.items).toHaveLength(2);
    expect(mergeAmbientContext(pins, second).items).toHaveLength(2);
    const selection = {
      ...first,
      items: [
        {
          ...original,
          observation: {
            ...original.observation,
            type: "selection.text" as const,
            value: { text: "First selection" },
          },
        },
      ],
    };
    const changedSelection = {
      ...selection,
      items: [
        {
          ...selection.items[0]!,
          observation: { ...selection.items[0]!.observation, value: { text: "Changed selection" } },
        },
      ],
    };
    expect(mergeAmbientContext(selection, changedSelection).items).toHaveLength(2);
  });

  it("removes just the selected provenance when independent sources reuse all observation fields", () => {
    const first = ambientResourceSnapshot(resource);
    const original = first.items[0]!;
    const second = {
      ...first,
      items: [
        {
          ...original,
          provenance: original.provenance.map((entry) => ({
            ...entry,
            sourceId: "another-source",
          })),
        },
      ],
    };
    const pins = mergeAmbientContext(first, second);
    expect(pins.items).toHaveLength(2);
    const remaining = removeAmbientContextItem(pins, ambientContextItemKey(original));
    expect(remaining?.items).toEqual(second.items);
    expect(pins.items).toHaveLength(2);
    expect(mergeAmbientContext(pins, second).items).toHaveLength(2);
  });

  it("merges explicit captures without changing the prior snapshot and enforces bounds", () => {
    const first = ambientResourceSnapshot(resource);
    const next = ambientResourceSnapshot({ ...resource, targetKey: "second" });
    expect(mergeAmbientContext(first, next).items).toHaveLength(2);
    expect(first.items).toHaveLength(1);
    expect(mergeAmbientContext(first, first).items).toHaveLength(1);
    expect(() =>
      mergeAmbientContext(first, {
        ...next,
        items: Array.from({ length: 64 }, (_, index) => ({
          ...next.items[0]!,
          observation: { ...next.items[0]!.observation, id: `item-${index}` },
        })),
      }),
    ).toThrow("Context is too large");
    expect(cloneAmbientContext({ ...next, schemaVersion: 2 })).toBeUndefined();
  });
});
