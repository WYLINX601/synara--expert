import { t, setLanguagePreference } from "~/i18n";
import { page } from "vitest/browser";
import { ambientConnectionPresentation } from "~/lib/ambientContextBinding";
import { ComposerCommandMenu } from "./ComposerCommandMenu";
import { useAmbientContextBindingStore } from "~/ambientContextBindingStore";
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
  setLanguagePreference("en");
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  useComposerDraftStore.setState({ draftsByThreadId: {} });
  useAmbientContextBindingStore.setState({ byThreadId: {}, maxBindings: 5 });
  state = {
    connections: [
      { id: "paper", sourceId: "obsidian", label: "Paper", connected: true, error: null },
    ],
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
  it("renders two-vault context menu and bound previews for visual review", async () => {
    const work = ambientResourceSnapshot({
      sourceId: "work",
      targetKey: "work-note",
      uri: "obsidian://open?vault=Work&file=Projects/Plan.md",
      title: "Projects/Plan.md",
    });
    const selected = snapshot.items[0]!;
    state = {
      ...state,
      connections: [
        ...state.connections!,
        { id: "work", sourceId: "work", label: "Work", connected: true, error: null },
      ],
      items: [
        ...snapshot.items,
        {
          ...selected,
          observation: {
            ...selected.observation,
            type: "selection.text",
            value: { text: "传统民居的空间组织与生活实践相互关联。" },
          },
        },
        {
          ...selected,
          observation: {
            ...selected.observation,
            type: "selection.location",
            value: { start: { line: 11, column: 0 }, end: { line: 15, column: 8 } },
          },
        },
        ...work.items,
      ],
    };
    await page.viewport(900, 750);
    const menu = await render(
      wrapper(
        <div className="dark mx-auto mt-10 w-[580px] rounded-xl bg-background p-5 text-foreground">
          <ComposerCommandMenu
            items={state.connections!.map((connection) => ({
              id: connection.id,
              type: "ambient-connection",
              connection,
              label: connection.label,
              description: "绑定此库，自动跟随选区",
            }))}
            resolvedTheme="dark"
            isLoading={false}
            triggerKind="mention"
            activeItemId="paper"
            mentionTab="context"
            onMentionTabChange={vi.fn()}
            onHighlightedItemChange={vi.fn()}
            onSelect={vi.fn()}
          />
        </div>,
      ),
    );
    await expect.element(menu.getByRole("option", { name: /Paper/ })).toBeVisible();
    await expect.element(menu.getByRole("option", { name: /Work/ })).toBeVisible();
    await page.screenshot({
      path: "../../../../../output/playwright/ambient-context-vault-tabs.png",
    });
    await menu.unmount();
    useAmbientContextBindingStore
      .getState()
      .bind(threadId, { id: "paper", sourceId: "obsidian", label: "Paper" });
    useAmbientContextBindingStore
      .getState()
      .bind(threadId, { id: "work", sourceId: "work", label: "Work" });
    const preview = await render(
      wrapper(
        <div className="dark mx-auto mt-8 w-[660px] rounded-xl bg-background p-5 text-foreground">
          <AmbientContextComposer threadId={threadId} />
          <AmbientContextSettingsPanel active />
        </div>,
      ),
    );
    await expect
      .element(
        preview.getByRole("button", { name: t("chat:ambientViewContext", { label: "Paper" }) }),
      )
      .toHaveTextContent("Lines 12–16");
    await expect
      .element(
        preview.getByRole("button", { name: t("chat:ambientViewContext", { label: "Work" }) }),
      )
      .toHaveTextContent(t("chat:ambientReferenceOnly"));
    await page.screenshot({
      path: "../../../../../output/playwright/ambient-context-bound-preview.png",
    });
    await preview.unmount();
  });

  it("disambiguates duplicate pending, connected, mention and bound vault labels", async () => {
    const connected = { ...state.connections![0]!, id: "vault-one-abcdefgh", label: "Paper" };
    const pending = {
      id: "vault-two-abcdefgh",
      label: "Paper",
      requestedAt: new Date().toISOString(),
    };
    state = { ...state, connections: [connected], pendingConnections: [pending] };
    const peers = [connected, pending];
    const label = ambientConnectionPresentation(connected, peers);
    const pendingLabel = ambientConnectionPresentation(pending, peers);
    useAmbientContextBindingStore.getState().bind(threadId, connected);
    const screen = await render(
      wrapper(
        <div>
          <AmbientContextComposer threadId={threadId} />
          <AmbientContextSettingsPanel active />
          <ComposerCommandMenu
            items={[
              {
                id: connected.id,
                type: "ambient-connection",
                connection: connected,
                ...label,
                description: "绑定此库",
              },
            ]}
            resolvedTheme="light"
            isLoading={false}
            triggerKind="mention"
            activeItemId={connected.id}
            onHighlightedItemChange={vi.fn()}
            onSelect={vi.fn()}
          />
        </div>,
      ),
    );
    await expect
      .element(
        screen.getByRole("button", { name: t("chat:ambientViewContext", { label: label.label }) }),
      )
      .toHaveAttribute("title", label.title);
    await expect
      .element(screen.getByText(pendingLabel.label, { exact: true }))
      .toHaveAttribute("title", pendingLabel.title);
    await expect
      .element(screen.getByRole("option", { name: new RegExp(label.label) }))
      .toBeVisible();
    expect(document.querySelector(`[role="option"] [title="${label.title}"]`)).not.toBeNull();
    await screen.unmount();
  });

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
    const buttons = screen.getByRole("button", {
      name: t("chat:ambientRemoveContext", {
        label: `Note.md · ${t("chat:ambientReferenceOnly")}`,
      }),
    });
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

  it("updates ambient controls and warnings when switching among supported languages", async () => {
    useAmbientContextBindingStore.getState().bind(threadId, {
      id: "paper",
      sourceId: "obsidian",
      label: "Paper",
    });
    useComposerDraftStore.getState().setAmbientContext(threadId, undefined, { frozen: true });
    state = { ...state, pendingConnections: [{ id: "work", label: "Work" }] };
    const screen = await render(
      wrapper(
        <>
          <AmbientContextComposer threadId={threadId} />
          <AmbientContextSettingsPanel active />
        </>,
      ),
    );
    for (const [locale, currentContext, approve, vaultLimit] of [
      ["en", "Use current context", "Approve connection", "Vault limit per chat"],
      ["zh-CN", "改用当前上下文", "批准连接", "每个会话的知识库上限"],
      ["es", "Usar el contexto actual", "Aprobar la conexión", "Límite de bóvedas por chat"],
    ] as const) {
      setLanguagePreference(locale);
      await expect
        .element(screen.getByRole("button", { name: currentContext, exact: true }))
        .toBeVisible();
      await expect
        .element(screen.getByRole("button", { name: approve, exact: true }))
        .toBeVisible();
      await expect
        .element(screen.getByRole("spinbutton", { name: vaultLimit, exact: true }))
        .toHaveValue(5);
      await expect
        .element(
          screen.getByRole("button", {
            name: t("chat:ambientViewContext", { label: "Paper" }),
          }),
        )
        .toHaveTextContent(t("chat:ambientReferenceOnly"));
    }
    expect(useComposerDraftStore.getState().draftsByThreadId[threadId]?.ambientContextFrozen).toBe(
      true,
    );
    expect(bridge.capture).not.toHaveBeenCalled();
    await screen.unmount();
    setLanguagePreference("en");
  });

  it("follows bound vaults without creating pins, preserves explicit pins and unbinds only this thread", async () => {
    useAmbientContextBindingStore
      .getState()
      .bind(threadId, { id: "paper", sourceId: "obsidian", label: "Paper" });
    const screen = await render(wrapper(<AmbientContextComposer threadId={threadId} />));
    await expect
      .element(
        screen.getByRole("button", { name: t("chat:ambientViewContext", { label: "Paper" }) }),
      )
      .toHaveTextContent(`Note.md · ${t("chat:ambientReferenceOnly")}`);
    expect(bridge.capture).not.toHaveBeenCalled();
    expect(
      useComposerDraftStore.getState().draftsByThreadId[threadId]?.ambientContext,
    ).toBeUndefined();
    await screen
      .getByRole("button", { name: t("chat:ambientViewContext", { label: "Paper" }) })
      .click();
    await screen.getByRole("button", { name: t("chat:ambientPinCurrent"), exact: true }).click();
    expect(bridge.capture).toHaveBeenCalledWith(["obsidian"], { includeFullTextSourceIds: [] });
    expect(
      useComposerDraftStore.getState().draftsByThreadId[threadId]?.ambientContext?.items,
    ).toEqual(snapshot.items);
    state = { ...state, items: [] };
    changed?.();
    await expect
      .element(
        screen.getByRole("button", { name: t("chat:ambientViewContext", { label: "Paper" }) }),
      )
      .toHaveTextContent(t("chat:ambientUnavailableOmitted"));
    await screen.getByRole("button", { name: t("chat:ambientUnbind", { label: "Paper" }) }).click();
    expect(useAmbientContextBindingStore.getState().byThreadId[threadId]).toEqual([]);
    await expect
      .element(
        screen.getByRole("button", {
          name: t("chat:ambientRemoveContext", {
            label: `Note.md · ${t("chat:ambientReferenceOnly")}`,
          }),
        }),
      )
      .toBeVisible();
    await screen.unmount();
  });

  it("restores source-only bindings after reload without persisting live observations", async () => {
    useAmbientContextBindingStore
      .getState()
      .bind(threadId, { id: "paper", sourceId: "obsidian", label: "Paper" });
    const key = "synara:ambient-context-bindings:v1";
    const saved = localStorage.getItem(key)!;
    expect(saved).not.toContain("Note.md");
    expect(saved).not.toContain("capturedAt");
    useAmbientContextBindingStore.setState({ byThreadId: {}, maxBindings: 5 });
    localStorage.setItem(key, saved);
    await useAmbientContextBindingStore.persist.rehydrate();
    expect(useAmbientContextBindingStore.getState().byThreadId[threadId]).toEqual([
      { id: "paper", sourceId: "obsidian", label: "Paper", includeFullText: false },
    ]);
  });

  it("prevents manual freezing while the thread exceeds the lowered binding limit", async () => {
    const bindings = useAmbientContextBindingStore.getState();
    bindings.bind(threadId, { id: "paper", sourceId: "obsidian", label: "Paper" });
    bindings.bind(threadId, { id: "work", sourceId: "work", label: "Work" });
    bindings.setMaxBindings(1);
    const screen = await render(wrapper(<AmbientContextComposer threadId={threadId} />));
    await screen
      .getByRole("button", { name: t("chat:ambientViewContext", { label: "Paper" }) })
      .click();
    await expect
      .element(screen.getByRole("button", { name: t("chat:ambientPinCurrent"), exact: true }))
      .toBeDisabled();
    await expect
      .element(screen.getByRole("status"))
      .toHaveTextContent(t("chat:ambientBindingLimitExceeded", { bound: 2, limit: 1 }));
    expect(bridge.capture).not.toHaveBeenCalled();
    expect(useAmbientContextBindingStore.getState().byThreadId[threadId]).toHaveLength(2);
    await screen.unmount();
  });

  it("validates the per-chat limit and restores invalid saved limits to five without dropping bindings", async () => {
    const screen = await render(wrapper(<AmbientContextSettingsPanel active />));
    const input = screen.getByRole("spinbutton", { name: t("settings:ambientVaultLimit") });
    await expect.element(input).toHaveValue(5);
    await input.fill("8");
    expect(useAmbientContextBindingStore.getState().maxBindings).toBe(8);
    await input.fill("99");
    expect(useAmbientContextBindingStore.getState().maxBindings).toBe(8);
    localStorage.setItem(
      "synara:ambient-context-bindings:v1",
      JSON.stringify({
        state: {
          maxBindings: 0,
          byThreadId: {
            [threadId]: [
              { id: "paper", sourceId: "obsidian", label: "Paper", includeFullText: false },
            ],
          },
        },
        version: 0,
      }),
    );
    await useAmbientContextBindingStore.persist.rehydrate();
    expect(useAmbientContextBindingStore.getState().maxBindings).toBe(5);
    expect(useAmbientContextBindingStore.getState().byThreadId[threadId]).toHaveLength(1);
    await screen.unmount();
  });

  it("approves and revokes individual vault connections without binding any chat", async () => {
    state = { ...state, pendingConnections: [{ id: "work", label: "Work" }] };
    bridge.approveConnection = vi.fn(async () => state);
    bridge.revokeConnection = vi.fn(async () => state);
    const screen = await render(wrapper(<AmbientContextSettingsPanel active />));
    await screen.getByRole("button", { name: t("settings:ambientApprove") }).click();
    expect(bridge.approveConnection).toHaveBeenCalledWith("work");
    await screen
      .getByRole("button", {
        name: t("settings:ambientConnectionOptionsLabel", { label: "Paper" }),
      })
      .click();
    await page.getByRole("menuitem", { name: t("settings:ambientRevoke") }).click();
    expect(bridge.revokeConnection).toHaveBeenCalledWith("paper");
    expect(useAmbientContextBindingStore.getState().byThreadId).toEqual({});
    await screen.unmount();
  });

  it("requests manual pairing for the selected approved vault when multiple vaults exist", async () => {
    state = {
      ...state,
      connections: [
        { id: "paper", sourceId: "paper", label: "Paper", connected: true, error: null },
        { id: "work", sourceId: "work", label: "Work", connected: false, error: null },
      ],
    };
    const screen = await render(wrapper(<AmbientContextSettingsPanel active />));
    await screen
      .getByRole("button", { name: t("settings:ambientConnectionOptionsLabel", { label: "Work" }) })
      .click();
    await page.getByRole("menuitem", { name: t("settings:ambientManualPairing") }).click();
    expect(bridge.getPairing).toHaveBeenCalledExactlyOnceWith("work");
    await expect
      .element(screen.getByRole("textbox", { name: t("settings:ambientTokenLabel") }))
      .toHaveValue("session-secret");
    await screen.unmount();
  });

  it("configures each type and only reveals pairing after an explicit request", async () => {
    const screen = await render(wrapper(<AmbientContextSettingsPanel active />));
    await expect
      .element(screen.getByRole("checkbox", { name: t("settings:ambientTypeContent") }))
      .not.toBeChecked();
    expect(bridge.getPairing).not.toHaveBeenCalled();
    await screen
      .getByRole("button", {
        name: t("settings:ambientConnectionOptionsLabel", { label: "Paper" }),
      })
      .click();
    await page.getByRole("menuitem", { name: t("settings:ambientManualPairing") }).click();
    await expect
      .element(screen.getByRole("textbox", { name: t("settings:ambientTokenLabel") }))
      .toHaveValue("session-secret");
    await screen.getByRole("checkbox", { name: t("settings:ambientTypeContent") }).click();
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
      .element(screen.getByRole("textbox", { name: t("settings:ambientTokenLabel") }))
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
      .element(screen.getByRole("checkbox", { name: t("settings:ambientTypeContent") }))
      .not.toBeChecked();
    await screen.unmount();
  });
});
