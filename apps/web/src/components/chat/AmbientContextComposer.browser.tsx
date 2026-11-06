import "../../index.css";
import {
  ThreadId,
  type AmbientContextDesktopMethods,
  type AmbientContextDesktopState,
  type AmbientContextType,
  type AmbientResourceReference,
  type DesktopBridge,
} from "@synara/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { useComposerDraftStore } from "~/composerDraftStore";
import {
  ambientContextItemKey,
  ambientResourceSnapshot,
  mergeAmbientContext,
} from "~/lib/ambientContext";
import { AMBIENT_CONTEXT_QUERY_KEY, useAmbientResources } from "~/hooks/useAmbientContext";
import { AmbientContextSettingsPanel } from "../settings/AmbientContextSettingsPanel";
import { AmbientContextSummaryChip } from "./AmbientContextSummaryChip";
import { AmbientContextComposer } from "./AmbientContextComposer";

const threadId = ThreadId.makeUnsafe("ambient-browser");
const snapshot = ambientResourceSnapshot({
  sourceId: "obsidian",
  targetKey: "note",
  uri: "obsidian://open?vault=test&file=Note.md",
  title: "Note.md",
});
const initialBridge = window.desktopBridge;
let client: QueryClient;
let state: AmbientContextDesktopState;
let bridge: AmbientContextDesktopMethods;
let changed: (() => void) | undefined;

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  useComposerDraftStore.setState({ draftsByThreadId: {} });
  state = {
    sources: [
      {
        manifest: {
          id: "obsidian",
          label: "Obsidian",
          kind: "application",
          capabilities: [
            "application.identity",
            "resource.identity",
            "selection.text",
            "selection.location",
            "window.identity",
            "resource.content",
          ].map((type) => ({
            type: type as AmbientContextType,
            captureMode: "event",
            precision: "exact",
            requiredPermissions: [],
          })),
        },
        policy: {
          enabled: true,
          allowedTypes: [
            "application.identity",
            "resource.identity",
            "selection.text",
            "selection.location",
          ],
        },
        connected: true,
        error: null,
      },
    ],
    items: snapshot.items,
  };
  bridge = {
    getState: vi.fn(async () => state),
    configure: vi.fn(async (id, policy) => {
      state = {
        ...state,
        sources: state.sources.map((source) =>
          source.manifest.id === id ? { ...source, policy } : source,
        ),
      };
      return state;
    }),
    capture: vi.fn(async () => snapshot),
    searchResources: vi.fn(async () => []),
    getPairing: vi.fn(async () => ({ endpoint: "ws://127.0.0.1:19860", token: "session-secret" })),
    onChanged: (listener) => {
      changed = listener;
      return () => {
        changed = undefined;
      };
    },
  };
  window.desktopBridge = { ambientContext: bridge } as DesktopBridge;
});

afterEach(() => {
  client.clear();
  if (initialBridge) window.desktopBridge = initialBridge;
  else delete window.desktopBridge;
  changed = undefined;
});

function wrapper(children: React.ReactNode) {
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

function ResourceSearch() {
  const results = useAmbientResources("Note", true);
  return (
    <div>
      {results.data?.map((resource) => (
        <span key={resource.targetKey}>{resource.title}</span>
      ))}
    </div>
  );
}

describe("desktop ambient context", () => {
  it("does not revive a late resource response after revocation or re-enable", async () => {
    let resolveOld!: (resources: readonly AmbientResourceReference[]) => void;
    let resolveNew!: (resources: readonly AmbientResourceReference[]) => void;
    const oldResponse = new Promise<readonly AmbientResourceReference[]>((resolve) => {
      resolveOld = resolve;
    });
    const newResponse = new Promise<readonly AmbientResourceReference[]>((resolve) => {
      resolveNew = resolve;
    });
    bridge.searchResources = vi.fn().mockReturnValueOnce(oldResponse).mockReturnValue(newResponse);
    const screen = await render(wrapper(<ResourceSearch />));
    await vi.waitFor(() => expect(bridge.searchResources).toHaveBeenCalledTimes(1));
    const enabledState = state;
    state = {
      ...state,
      sources: [{ ...state.sources[0]!, policy: { enabled: false, allowedTypes: [] } }],
    };
    changed?.();
    await vi.waitFor(() =>
      expect(
        client.getQueryData<AmbientContextDesktopState>(AMBIENT_CONTEXT_QUERY_KEY)?.sources[0]
          ?.policy.enabled,
      ).toBe(false),
    );
    resolveOld([
      {
        sourceId: "obsidian",
        targetKey: "old",
        uri: "obsidian://open?file=Old.md",
        title: "Old.md",
      },
    ]);
    await expect.element(screen.getByText("Old.md")).not.toBeInTheDocument();
    state = enabledState;
    changed?.();
    await vi.waitFor(() => expect(bridge.searchResources).toHaveBeenCalledTimes(2));
    await expect.element(screen.getByText("Old.md")).not.toBeInTheDocument();
    resolveNew([
      {
        sourceId: "obsidian",
        targetKey: "new",
        uri: "obsidian://open?file=New.md",
        title: "New.md",
      },
    ]);
    await expect.element(screen.getByText("New.md")).toBeVisible();
    await screen.unmount();
  });

  it("removes one source-local ID collision and preserves the other pin", async () => {
    const original = snapshot.items[0]!;
    const other = {
      ...snapshot,
      items: [
        {
          ...original,
          provenance: [{ ...original.provenance[0]!, sourceId: "another-source" }],
        },
      ],
    };
    useComposerDraftStore
      .getState()
      .setAmbientContext(threadId, mergeAmbientContext(snapshot, other));
    const screen = await render(wrapper(<AmbientContextComposer threadId={threadId} />));
    const buttons = screen.getByRole("button", { name: "Remove context: Note.md" });
    await buttons.nth(0).click();
    const remaining = useComposerDraftStore.getState().draftsByThreadId[threadId]?.ambientContext;
    expect(remaining?.items).toHaveLength(1);
    expect(ambientContextItemKey(remaining!.items[0]!)).toBe(
      ambientContextItemKey(other.items[0]!),
    );
    await screen.unmount();
  });

  it("shows read-only sent snapshot provenance without recapturing live state", async () => {
    const truncatedSnapshot = {
      ...snapshot,
      items: [
        {
          ...snapshot.items[0]!,
          observation: {
            ...snapshot.items[0]!.observation,
            type: "resource.content" as const,
            value: { text: "Captured prefix", truncated: true },
          },
        },
      ],
    };
    const screen = await render(
      wrapper(<AmbientContextSummaryChip snapshot={truncatedSnapshot} />),
    );
    await expect.element(screen.getByText("Context · 1 item")).toBeVisible();
    await expect
      .element(screen.getByRole("button", { name: "Remove context" }))
      .not.toBeInTheDocument();
    await screen.getByText("Context · 1 item").hover();
    await expect.element(screen.getByText("resource.content", { exact: true })).toBeVisible();
    await expect
      .element(screen.getByText(snapshot.items[0]!.observation.capturedAt, { exact: false }))
      .toBeVisible();
    await expect.element(screen.getByText("Captured prefix", { exact: true })).toBeVisible();
    await expect.element(screen.getByText("Content truncated", { exact: true })).toBeVisible();
    expect(bridge.capture).not.toHaveBeenCalled();
    expect(bridge.getState).not.toHaveBeenCalled();
    await screen.unmount();
  });

  it("searches filenames only while resource identity is allowed and drops cached results after revocation", async () => {
    bridge.searchResources = vi.fn(async () => [
      {
        sourceId: "obsidian",
        targetKey: "note",
        uri: "obsidian://open?file=Note.md",
        title: "Note.md",
      },
    ]);
    const screen = await render(wrapper(<ResourceSearch />));
    await expect.element(screen.getByText("Note.md")).toBeVisible();
    expect(bridge.searchResources).toHaveBeenCalledWith("Note");
    expect(bridge.capture).not.toHaveBeenCalled();
    state = {
      ...state,
      sources: [
        { ...state.sources[0]!, policy: { enabled: true, allowedTypes: ["selection.text"] } },
      ],
    };
    changed?.();
    await expect.element(screen.getByText("Note.md")).not.toBeInTheDocument();
    await screen.unmount();
  });

  it("renders nothing when unsupported or disabled", async () => {
    delete window.desktopBridge;
    const unsupported = await render(wrapper(<AmbientContextComposer threadId={threadId} />));
    await expect
      .element(unsupported.getByRole("button", { name: "Attach context" }))
      .not.toBeInTheDocument();
    await unsupported.unmount();
    window.desktopBridge = { ambientContext: bridge } as DesktopBridge;
    state = {
      ...state,
      sources: state.sources.map((source) => ({
        ...source,
        policy: { ...source.policy, enabled: false },
      })),
      items: [],
    };
    const disabled = await render(wrapper(<AmbientContextComposer threadId={threadId} />));
    await expect
      .element(disabled.getByRole("button", { name: "Attach context" }))
      .not.toBeInTheDocument();
    await disabled.unmount();
  });

  it("captures only on explicit attach and keeps pins through live source changes", async () => {
    const screen = await render(wrapper(<AmbientContextComposer threadId={threadId} />));
    await expect.element(screen.getByRole("button", { name: "Attach context" })).toBeEnabled();
    expect(bridge.capture).not.toHaveBeenCalled();
    await screen.getByRole("button", { name: "Attach context" }).click();
    await expect
      .element(screen.getByRole("button", { name: "Remove context: Note.md" }))
      .toBeVisible();
    expect(
      useComposerDraftStore.getState().draftsByThreadId[threadId]?.ambientContext?.items,
    ).toEqual(snapshot.items);
    state = { ...state, items: [] };
    changed?.();
    await expect.element(screen.getByRole("button", { name: "Attach context" })).toBeDisabled();
    await expect
      .element(screen.getByRole("button", { name: "Remove context: Note.md" }))
      .toBeVisible();
    await screen.getByRole("button", { name: "Remove context: Note.md" }).click();
    expect(
      useComposerDraftStore.getState().draftsByThreadId[threadId]?.ambientContext,
    ).toBeUndefined();
    await screen.unmount();
  });

  it("configures each type and only reveals pairing after an explicit request", async () => {
    const screen = await render(wrapper(<AmbientContextSettingsPanel active />));
    await expect
      .element(screen.getByRole("checkbox", { name: "Document content" }))
      .not.toBeChecked();
    expect(bridge.getPairing).not.toHaveBeenCalled();
    await screen.getByRole("button", { name: "Show pairing details" }).click();
    await expect
      .element(screen.getByRole("textbox", { name: "Obsidian pairing token" }))
      .toHaveValue("session-secret");
    await screen.getByRole("checkbox", { name: "Document content" }).click();
    expect(bridge.configure).toHaveBeenCalledWith("obsidian", {
      enabled: true,
      allowedTypes: [
        "application.identity",
        "resource.identity",
        "selection.text",
        "selection.location",
        "resource.content",
      ],
    });
    await expect
      .element(screen.getByRole("textbox", { name: "Obsidian pairing token" }))
      .not.toBeInTheDocument();
    expect(JSON.stringify(useComposerDraftStore.getState().draftsByThreadId)).not.toContain(
      "session-secret",
    );
    await screen.unmount();
  });

  it("enables the minimal four types while leaving document content and window title off", async () => {
    state = {
      ...state,
      sources: [{ ...state.sources[0]!, policy: { enabled: false, allowedTypes: [] } }],
    };
    const screen = await render(wrapper(<AmbientContextSettingsPanel active />));
    await screen.getByRole("switch", { name: "Enable Obsidian context" }).click();
    expect(bridge.configure).toHaveBeenCalledWith("obsidian", {
      enabled: true,
      allowedTypes: [
        "application.identity",
        "resource.identity",
        "selection.text",
        "selection.location",
      ],
    });
    await expect.element(screen.getByRole("checkbox", { name: "Window title" })).not.toBeChecked();
    await expect
      .element(screen.getByRole("checkbox", { name: "Document content" }))
      .not.toBeChecked();
    await screen.unmount();
  });
});
