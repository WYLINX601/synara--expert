import { t } from "~/i18n";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ThreadId,
  ProjectId,
  type AmbientContextDesktopMethods,
  type AmbientContextDesktopState,
  type AmbientContextSnapshot,
} from "@synara/contracts";
import { useAmbientContextBindingStore } from "~/ambientContextBindingStore";
import { useComposerDraftStore } from "~/composerDraftStore";
import {
  ambientResourceSnapshot,
  groupAmbientContextItems,
  mergeAmbientContext,
} from "./ambientContext";
import {
  ambientConnectionPresentation,
  captureBoundAmbientContext,
  selectBoundAmbientItems,
} from "./ambientContextBinding";

const paper = { id: "paper", sourceId: "paper", label: "Paper", includeFullText: false };
const work = { id: "work", sourceId: "work", label: "Work", includeFullText: false };
const thread = ThreadId.makeUnsafe("bound-chat");
const otherThread = ThreadId.makeUnsafe("other-chat");
function resource(sourceId = "paper") {
  return ambientResourceSnapshot({
    sourceId,
    targetKey: "note",
    uri: `obsidian://open?vault=${sourceId}&file=Note.md`,
    title: "Note.md",
  });
}
function fixture() {
  const snapshot = mergeAmbientContext(resource(), resource("work"));
  const state: AmbientContextDesktopState = {
    sources: [
      {
        manifest: { id: "obsidian", label: "Obsidian", kind: "application", capabilities: [] },
        policy: {
          enabled: true,
          allowedTypes: [
            "resource.identity",
            "selection.text",
            "selection.location",
            "resource.content",
          ],
        },
        connected: true,
        error: null,
      },
    ],
    connections: [paper, work].map((binding) => ({ ...binding, connected: true, error: null })),
    items: snapshot.items,
  };
  const bridge = {
    getState: vi.fn(async () => state),
    capture: vi.fn(async () => snapshot),
  } as unknown as AmbientContextDesktopMethods;
  return { state, bridge, snapshot };
}
beforeEach(() => {
  useAmbientContextBindingStore.setState({ byThreadId: {}, maxBindings: 5 });
  useComposerDraftStore.setState({ draftsByThreadId: {}, draftThreadsByThreadId: {} });
});
describe("thread context bindings", () => {
  it("persists only source bindings independently from draft clear, pins, queue edits and new threads", () => {
    const store = useAmbientContextBindingStore.getState();
    store.bind(thread, paper);
    store.bind(thread, work);
    store.bind(thread, paper);
    useComposerDraftStore.getState().setPrompt(thread, "draft");
    useComposerDraftStore.getState().clearComposerContent(thread);
    expect(useAmbientContextBindingStore.getState().byThreadId[thread]).toHaveLength(2);
    expect(useAmbientContextBindingStore.getState().byThreadId[otherThread]).toBeUndefined();
    store.unbind(thread, "paper");
    expect(useAmbientContextBindingStore.getState().byThreadId[thread]).toEqual([work]);
    store.moveThread(thread, otherThread);
    expect(useAmbientContextBindingStore.getState().byThreadId[thread]).toBeUndefined();
    expect(useAmbientContextBindingStore.getState().byThreadId[otherThread]).toEqual([work]);
    store.removeThread(otherThread);
    expect(useAmbientContextBindingStore.getState().byThreadId).toEqual({});
  });
  it("defaults to five bindings per chat, refuses the sixth, and allows an explicitly raised valid limit", () => {
    const store = useAmbientContextBindingStore.getState();
    expect(store.maxBindings).toBe(5);
    for (let index = 0; index < 6; index += 1)
      store.bind(thread, {
        id: `vault-${index}`,
        sourceId: `vault-${index}`,
        label: `Vault ${index}`,
      });
    expect(useAmbientContextBindingStore.getState().byThreadId[thread]).toHaveLength(5);
    store.setMaxBindings(6);
    store.bind(thread, { id: "vault-5", sourceId: "vault-5", label: "Vault 5" });
    expect(useAmbientContextBindingStore.getState().byThreadId[thread]).toHaveLength(6);
    for (const invalid of [0, 33, 1.5, Number.NaN]) store.setMaxBindings(invalid);
    expect(useAmbientContextBindingStore.getState().maxBindings).toBe(6);
  });
  it("preserves bindings when lowering the limit but blocks live capture before touching the bridge", async () => {
    const store = useAmbientContextBindingStore.getState();
    store.bind(thread, paper);
    store.bind(thread, work);
    store.setMaxBindings(1);
    const { bridge } = fixture();
    await expect(
      captureBoundAmbientContext(
        bridge,
        useAmbientContextBindingStore.getState().byThreadId[thread]!,
        undefined,
      ),
    ).rejects.toThrow(t("chat:ambientBindingLimitExceeded", { bound: 2, limit: 1 }));
    expect(bridge.getState).not.toHaveBeenCalled();
    expect(bridge.capture).not.toHaveBeenCalled();
    expect(useAmbientContextBindingStore.getState().byThreadId[thread]).toHaveLength(2);
  });
  it("moves same-chat draft promotion bindings but does not copy bindings through composer transfer", () => {
    const drafts = useComposerDraftStore.getState();
    drafts.setProjectDraftThreadId(ProjectId.makeUnsafe("ambient-project"), thread);
    useAmbientContextBindingStore.getState().bind(thread, paper);
    drafts.markDraftThreadPromoting(thread, otherThread);
    expect(useAmbientContextBindingStore.getState().byThreadId[thread]).toBeUndefined();
    expect(useAmbientContextBindingStore.getState().byThreadId[otherThread]).toEqual([paper]);
    drafts.finalizePromotedDraftThread(thread);
    expect(useAmbientContextBindingStore.getState().byThreadId[otherThread]).toEqual([paper]);
    drafts.setPrompt(otherThread, "fork this draft");
    drafts.copyTransferableComposerState(otherThread, thread);
    expect(useAmbientContextBindingStore.getState().byThreadId[thread]).toBeUndefined();
    drafts.clearDraftThread(otherThread);
    expect(useAmbientContextBindingStore.getState().byThreadId[otherThread]).toBeUndefined();
  });
  it("captures all bound sources once and never writes live observations into a draft", async () => {
    const { bridge } = fixture();
    const result = await captureBoundAmbientContext(bridge, [paper, work], undefined);
    expect(bridge.capture).toHaveBeenCalledExactlyOnceWith(["paper", "work"], {
      includeFullTextSourceIds: [],
    });
    expect(result.snapshot?.items).toHaveLength(2);
    expect(result.unavailable).toEqual([]);
    expect(useComposerDraftStore.getState().draftsByThreadId).toEqual({});
    expect(await captureBoundAmbientContext(bridge, [], undefined)).toEqual({
      snapshot: undefined,
      unavailable: [],
    });
    expect(bridge.capture).toHaveBeenCalledTimes(1);
  });
  it("omits disconnected sources explicitly and preserves valid bindings and fixed pins", async () => {
    const { bridge, state } = fixture();
    vi.mocked(bridge.getState).mockResolvedValue({
      ...state,
      connections: state.connections!.map((entry) => ({
        ...entry,
        connected: entry.id === "paper",
      })),
    });
    const pins = resource("fixed");
    const result = await captureBoundAmbientContext(bridge, [paper, work], pins);
    expect(bridge.capture).toHaveBeenCalledExactlyOnceWith(["paper"], {
      includeFullTextSourceIds: [],
    });
    expect(result.snapshot?.items.map((item) => item.provenance[0]?.sourceId)).toEqual([
      "fixed",
      "paper",
    ]);
    expect(result.unavailable).toEqual(["Work"]);
  });
  it("preserves Paper when Work expires after the atomic capture", async () => {
    const { bridge, state } = fixture();
    vi.mocked(bridge.getState)
      .mockResolvedValueOnce(state)
      .mockResolvedValue({
        ...state,
        connections: state.connections!.map((entry) => ({
          ...entry,
          error: entry.id === "work" ? "expired" : null,
        })),
      });
    const result = await captureBoundAmbientContext(bridge, [paper, work], undefined);
    expect(result.snapshot?.items.map((item) => item.provenance[0]?.sourceId)).toEqual(["paper"]);
    expect(result.unavailable).toEqual(["Work"]);
    expect(bridge.capture).toHaveBeenCalledTimes(1);
  });
  it("refreshes the valid subset once when atomic capture rejects an expired vault", async () => {
    const { bridge, state, snapshot } = fixture();
    vi.mocked(bridge.getState)
      .mockResolvedValueOnce(state)
      .mockResolvedValue({
        ...state,
        connections: state.connections!.map((entry) => ({
          ...entry,
          error: entry.id === "work" ? "expired" : null,
        })),
      });
    vi.mocked(bridge.capture)
      .mockRejectedValueOnce(new Error("Work expired"))
      .mockResolvedValue(snapshot);
    const result = await captureBoundAmbientContext(bridge, [paper, work], undefined);
    expect(bridge.capture).toHaveBeenNthCalledWith(2, ["paper"], { includeFullTextSourceIds: [] });
    expect(result.snapshot?.items.map((item) => item.provenance[0]?.sourceId)).toEqual(["paper"]);
    expect(result.unavailable).toEqual(["Work"]);
  });
  it("keeps selected/reference context after global full-text permission is revoked", async () => {
    const { bridge, state } = fixture();
    vi.mocked(bridge.getState).mockResolvedValue({
      ...state,
      sources: state.sources.map((source) => ({
        ...source,
        policy: {
          ...source.policy,
          allowedTypes: ["resource.identity", "selection.text", "selection.location"],
        },
      })),
    });
    const result = await captureBoundAmbientContext(
      bridge,
      [{ ...paper, includeFullText: true }],
      undefined,
    );
    expect(bridge.capture).toHaveBeenCalledExactlyOnceWith(["paper"], {
      includeFullTextSourceIds: [],
    });
    expect(result.snapshot?.items).toHaveLength(1);
    expect(result.unavailable).toEqual([]);
  });
  it.each([
    "Context exceeds the snapshot size limit.",
    "Context exceeds the snapshot size or schema limits.",
  ])(
    "blocks oversized explicit context instead of silently sending without it (%s)",
    async (message) => {
      const { bridge } = fixture();
      vi.mocked(bridge.capture).mockRejectedValue(new Error(message));
      await expect(
        captureBoundAmbientContext(bridge, [{ ...paper, includeFullText: true }], undefined),
      ).rejects.toThrow(t("chat:ambientSnapshotTooLarge"));
      expect(bridge.capture).toHaveBeenCalledExactlyOnceWith(["paper"], {
        includeFullTextSourceIds: ["paper"],
      });
    },
  );
  it("never falls back to live preview when capture fails or the desktop bridge disappears", async () => {
    const { bridge } = fixture();
    vi.mocked(bridge.capture).mockRejectedValue(new Error("expired"));
    expect(await captureBoundAmbientContext(bridge, [paper], undefined)).toEqual({
      snapshot: undefined,
      unavailable: ["Paper"],
    });
    expect(await captureBoundAmbientContext(undefined, [paper], undefined)).toEqual({
      snapshot: undefined,
      unavailable: ["Paper"],
    });
  });
  it("defaults to selection/reference only; full text requires the explicit thread choice", () => {
    const identity = resource().items[0]!;
    const items: AmbientContextSnapshot["items"] = [
      identity,
      {
        ...identity,
        observation: {
          ...identity.observation,
          type: "selection.text",
          value: { text: "Selected" },
        },
      },
      {
        ...identity,
        observation: {
          ...identity.observation,
          type: "resource.content",
          value: { text: "Full document", truncated: false },
        },
      },
    ];
    expect(selectBoundAmbientItems(items, [paper]).map((item) => item.observation.type)).toEqual([
      "resource.identity",
      "selection.text",
    ]);
    expect(selectBoundAmbientItems(items, [{ ...paper, includeFullText: true }])).toHaveLength(3);
    expect(selectBoundAmbientItems([items[0]!, items[2]!], [paper])).toEqual([identity]);
  });
  it("deduplicates equal data across timestamps but retains distinct selections and source groups", () => {
    const first = resource();
    const later = resource();
    expect(mergeAmbientContext(first, later).items).toHaveLength(1);
    const original = first.items[0]!;
    const selections: AmbientContextSnapshot = {
      ...first,
      items: ["one", "two"].map((text) => ({
        ...original,
        observation: { ...original.observation, type: "selection.text", value: { text } },
      })),
    };
    const merged = mergeAmbientContext(mergeAmbientContext(first, selections), resource("work"));
    expect(merged.items).toHaveLength(4);
    expect(groupAmbientContextItems(merged.items)).toHaveLength(2);
    expect(groupAmbientContextItems(merged.items)[0]?.items).toHaveLength(3);
  });
});

describe("ambient connection labels", () => {
  it("keeps unique labels and identifies duplicates across pending and connected peers", () => {
    const connected = { id: "connection-one-abcdefgh", label: "Paper" };
    const pending = { id: "connection-two-abcdefgh", label: "Paper" };
    const work = { id: "work", label: "Work" };
    const peers = [connected, pending, work, connected];
    const first = ambientConnectionPresentation(connected, peers);
    const second = ambientConnectionPresentation(pending, peers);
    expect(first.label).not.toBe(second.label);
    expect(first.label).toBe("Paper · e-abcdefgh");
    expect(second.label).toBe("Paper · o-abcdefgh");
    expect(first.title).toBe("Paper · connection-one-abcdefgh");
    expect(ambientConnectionPresentation(work, peers).label).toBe("Work");
    expect(ambientConnectionPresentation(connected, [connected, connected]).label).toBe("Paper");
  });
});
