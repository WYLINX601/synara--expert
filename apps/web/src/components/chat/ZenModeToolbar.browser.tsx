import "../../index.css";
import type { DesktopBridge, ZenModeDesktopMethods, ZenModeState } from "@synara/contracts";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { useMemo, useRef } from "react";
import { page, userEvent } from "vitest/browser";
import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { toastManager } from "../ui/toast";
import { TooltipProvider } from "../ui/tooltip";
import { useZenMode, ZenModeProvider } from "./ZenModeProvider";
import { ZenModeToolbar } from "./ZenModeToolbar";

function Surface({ relocate = false }: { relocate?: boolean }) {
  const { state } = useZenMode();
  const focusRestoreRef = useRef(false);
  const keyboardFocusRestore = useMemo(
    () => ({
      requested: () => focusRestoreRef.current,
      setRequested: (requested: boolean) => {
        focusRestoreRef.current = requested;
      },
    }),
    [],
  );
  return (
    <>
      <button data-testid="before-toolbar">Before controls</button>
      <div
        data-zen-chat="true"
        data-zen-expanded={String(state.expanded)}
        style={{ display: "flex", flexDirection: "column", width: 360, height: 200, margin: 16 }}
      >
        <div
          data-zen-main=""
          data-testid="toolbar-anchor"
          className="relative min-h-0 overflow-hidden"
          style={{ height: 160 }}
        >
          {relocate ? (
            state.expanded ? (
              <section data-testid="expanded-anchor" className="relative">
                <ZenModeToolbar keyboardFocusRestore={keyboardFocusRestore} />
              </section>
            ) : (
              <div data-testid="compact-anchor" className="relative">
                <ZenModeToolbar keyboardFocusRestore={keyboardFocusRestore} />
              </div>
            )
          ) : (
            <ZenModeToolbar />
          )}
          <div data-testid="chat-transcript-drawer" style={{ height: 64, overflow: "hidden" }}>
            <div data-testid="transcript-scroll" style={{ height: "100%", overflowY: "auto" }}>
              <div style={{ height: 400 }}>Scrollable transcript</div>
            </div>
          </div>
          <textarea data-testid="preserved-draft" defaultValue={"保留这份草稿\n第二行"} />
        </div>
      </div>
      <button data-testid="after-toolbar">After controls</button>
    </>
  );
}

async function mountToolbar(
  options: { bubble?: boolean; active?: boolean; relocate?: boolean } = {},
) {
  const previous = window.desktopBridge;
  const failure = vi.spyOn(toastManager, "add");
  let state: ZenModeState = {
    isActive: options.active ?? true,
    isBubble: false,
    expanded: false,
    alwaysOnTop: true,
    shortcut: "",
    shortcutAvailable: true,
  };
  const listeners = new Set<(state: ZenModeState) => void>();
  const update = (patch: Partial<ZenModeState>) => {
    state = { ...state, ...patch };
    for (const listener of listeners) listener(state);
  };
  const actions = {
    collapseToBubble: vi.fn(async () => {}),
    setExpanded: vi.fn(async (expanded: boolean) => update({ expanded })),
    exit: vi.fn(async () => update({ isActive: false })),
  };
  const zenMode: ZenModeDesktopMethods = {
    getState: async () => state,
    enter: async () => update({ isActive: true }),
    exit: actions.exit,
    setExpanded: actions.setExpanded,
    ...(options.bubble === false
      ? {}
      : {
          bubble: {
            collapse: actions.collapseToBubble,
            restore: vi.fn(async () => {}),
            hide: vi.fn(async () => {}),
          },
        }),
    setCompactHeight: vi.fn(async (_height: number) => {}),
    setPointerPassthrough: vi.fn(async (_ignore: boolean) => {}),
    setDragRegion: vi.fn(async () => {}),
    onStateChanged: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    onToggleRequested: () => () => {},
  };
  window.desktopBridge = { ...previous, zenMode } as DesktopBridge;
  const root = createRootRoute();
  const thread = createRoute({
    getParentRoute: () => root,
    path: "/$threadId",
    component: () => (
      <TooltipProvider>
        <ZenModeProvider>
          <Surface relocate={options.relocate ?? false} />
        </ZenModeProvider>
      </TooltipProvider>
    ),
  });
  const router = createRouter({
    routeTree: root.addChildren([thread]),
    history: createMemoryHistory({ initialEntries: ["/zen-toolbar-test"] }),
  });
  const screen = await render(<RouterProvider router={router} />);
  await expect.element(page.getByTestId("preserved-draft")).toBeVisible();
  if (options.active !== false)
    await expect.element(page.getByTestId("zen-mode-toolbar")).toBeInTheDocument();
  return {
    actions,
    zenMode,
    failure,
    update,
    cleanup: async () => {
      await screen.unmount();
      failure.mockRestore();
      if (previous) window.desktopBridge = previous;
      else delete window.desktopBridge;
    },
  };
}

const toolbar = () => page.getByTestId("zen-mode-toolbar").element() as HTMLElement;
const buttons = () => Array.from(toolbar().querySelectorAll<HTMLButtonElement>("button"));
const opacity = () => getComputedStyle(toolbar()).opacity;
const leave = () => userEvent.hover(document.body, { position: { x: 0, y: 0 } });

describe("ZenModeToolbar unified edge controls", () => {
  it("reveals the whole continuous hit region on hover, crosses gaps and hides after pointer focus", async () => {
    const mounted = await mountToolbar();
    try {
      await leave();
      await vi.waitFor(() => expect(opacity()).toBe("0"));
      const anchor = page.getByTestId("toolbar-anchor").element();
      const draft = page.getByTestId("preserved-draft").element() as HTMLTextAreaElement;
      const anchorBefore = anchor.getBoundingClientRect();
      const draftBefore = draft.getBoundingClientRect();
      const box = toolbar().getBoundingClientRect();
      expect(box.height).toBeGreaterThan(0);
      expect(box.width).toBeLessThan(anchorBefore.width);
      expect(box.top + box.height / 2).toBe(anchorBefore.top);
      expect(box.left + box.width / 2).toBe(anchorBefore.left + anchorBefore.width / 2);
      expect(toolbar().hasAttribute("data-zen-hit-surface")).toBe(true);
      expect(getComputedStyle(toolbar()).getPropertyValue("-webkit-app-region")).toBe("no-drag");
      expect(buttons().map((button) => button.dataset.testid)).toEqual([
        "zen-collapse-to-bubble",
        "zen-drawer-toggle",
        "zen-window-return",
      ]);
      expect(toolbar().querySelector("button button")).toBeNull();
      // Even while transparent, only this small rectangle is a native hit island.
      await page.getByTestId("zen-mode-toolbar").hover({
        position: { x: 1, y: box.height / 2 },
      });
      await vi.waitFor(() => expect(opacity()).toBe("1"));
      await vi.waitFor(() =>
        expect(mounted.zenMode.setPointerPassthrough).toHaveBeenLastCalledWith(false),
      );
      const firstBox = buttons()[0]!.getBoundingClientRect();
      await page.getByTestId("zen-mode-toolbar").hover({
        position: { x: firstBox.right - box.left + 1, y: box.height / 2 },
      });
      expect(opacity()).toBe("1");
      expect(toolbar().getBoundingClientRect().height).toBe(box.height);
      expect(
        document
          .elementFromPoint(box.left - 1, box.top + box.height / 2)
          ?.closest("[data-testid=zen-mode-toolbar]"),
      ).toBeNull();
      expect(anchor.getBoundingClientRect().height).toBe(anchorBefore.height);
      expect(draft.getBoundingClientRect().bottom).toBe(draftBefore.bottom);
      await page.getByTestId("zen-collapse-to-bubble").click();
      await vi.waitFor(() => expect(buttons().every((button) => !button.disabled)).toBe(true));
      expect(mounted.actions.collapseToBubble).toHaveBeenCalledTimes(1);
      expect(mounted.actions.setExpanded).not.toHaveBeenCalled();
      expect(mounted.actions.exit).not.toHaveBeenCalled();
      expect(buttons()[0]!.matches(":focus-visible")).toBe(false);
      await leave();
      await vi.waitFor(() => expect(opacity()).toBe("0"));
      await vi.waitFor(() =>
        expect(mounted.zenMode.setPointerPassthrough).toHaveBeenLastCalledWith(true),
      );
      expect(document.elementFromPoint(0, 0)?.closest("[data-zen-hit-surface]")).toBeNull();
      expect(draft.value).toBe("保留这份草稿\n第二行");
      expect(draft.getBoundingClientRect().bottom).toBe(draftBefore.bottom);
      expect(mounted.zenMode.setCompactHeight).not.toHaveBeenCalled();
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps keyboard reveal across the three buttons and executes only the focused action", async () => {
    const mounted = await mountToolbar();
    try {
      await page.getByTestId("before-toolbar").click();
      await userEvent.keyboard("{Tab}");
      expect(document.activeElement).toBe(buttons()[0]);
      expect(buttons()[0]!.matches(":focus-visible")).toBe(true);
      await leave();
      await vi.waitFor(() => expect(opacity()).toBe("1"));
      await userEvent.keyboard("{Tab}");
      expect(document.activeElement).toBe(buttons()[1]);
      await userEvent.keyboard("{Enter}");
      await expect
        .element(page.getByTestId("zen-drawer-toggle"))
        .toHaveAttribute("aria-expanded", "true");
      expect(mounted.actions.setExpanded).toHaveBeenCalledExactlyOnceWith(true);
      expect(mounted.actions.exit).not.toHaveBeenCalled();
      expect(mounted.actions.collapseToBubble).not.toHaveBeenCalled();
      await vi.waitFor(() => {
        expect(buttons().every((button) => !button.disabled)).toBe(true);
        expect(document.activeElement).toBe(buttons()[1]);
      });
      // Keyboard focus leaving the group restores hidden state without pointer motion.
      await userEvent.keyboard("{Tab}{Tab}");
      expect(toolbar().contains(document.activeElement)).toBe(false);
      await vi.waitFor(() => expect(opacity()).toBe("0"));
      await userEvent.keyboard("{Shift>}{Tab}{/Shift}");
      expect(document.activeElement).toBe(page.getByTestId("zen-window-return").element());
      await vi.waitFor(() => expect(opacity()).toBe("1"));
      await userEvent.keyboard(" ");
      await expect.element(page.getByTestId("zen-mode-toolbar")).not.toBeInTheDocument();
      expect(mounted.actions.exit).toHaveBeenCalledTimes(1);
      expect((page.getByTestId("preserved-draft").element() as HTMLTextAreaElement).value).toBe(
        "保留这份草稿\n第二行",
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("omits unsupported bubble capability without leaving an inert button or gap", async () => {
    const mounted = await mountToolbar({ bubble: false });
    try {
      await expect.element(page.getByTestId("zen-collapse-to-bubble")).not.toBeInTheDocument();
      expect(buttons().map((button) => button.dataset.testid)).toEqual([
        "zen-drawer-toggle",
        "zen-window-return",
      ]);
      const box = toolbar().getBoundingClientRect();
      const anchor = page.getByTestId("toolbar-anchor").element().getBoundingClientRect();
      expect(box.left + box.width / 2).toBe(anchor.left + anchor.width / 2);
      await page.getByTestId("before-toolbar").click();
      await userEvent.keyboard("{Tab}{Enter}");
      await expect
        .element(page.getByTestId("zen-drawer-toggle"))
        .toHaveAttribute("aria-expanded", "true");
      expect(mounted.actions.collapseToBubble).not.toHaveBeenCalled();
    } finally {
      await mounted.cleanup();
    }
  });

  it.each(["{Enter}", " "] as const)(
    "restores keyboard focus after moving between compact and expanded anchors with %s",
    async (key) => {
      const mounted = await mountToolbar({ relocate: true });
      try {
        const draft = page.getByTestId("preserved-draft").element();
        const original = page.getByTestId("zen-drawer-toggle").element();
        await page.getByTestId("before-toolbar").click();
        await userEvent.keyboard("{Tab}{Tab}");
        await leave();
        await userEvent.keyboard(key);
        await expect.element(page.getByTestId("expanded-anchor")).toBeInTheDocument();
        await vi.waitFor(() => {
          expect(document.activeElement).toBe(page.getByTestId("zen-drawer-toggle").element());
          expect(buttons().every((button) => !button.disabled)).toBe(true);
        });
        expect(page.getByTestId("zen-drawer-toggle").element()).not.toBe(original);
        expect(document.activeElement!.matches(":focus-visible")).toBe(true);
        await vi.waitFor(() => expect(opacity()).toBe("1"));
        await userEvent.keyboard(key);
        await expect.element(page.getByTestId("compact-anchor")).toBeInTheDocument();
        await expect.element(page.getByTestId("expanded-anchor")).not.toBeInTheDocument();
        await vi.waitFor(() =>
          expect(document.activeElement).toBe(page.getByTestId("zen-drawer-toggle").element()),
        );
        expect(mounted.actions.setExpanded.mock.calls).toEqual([[true], [false]]);
        expect(page.getByTestId("preserved-draft").element()).toBe(draft);
        await vi.waitFor(() => expect(opacity()).toBe("1"));
      } finally {
        await mounted.cleanup();
      }
    },
  );

  it.each(["preserved-draft", "after-toolbar"] as const)(
    "does not steal focus moved to %s while the keyboard action is pending",
    async (targetId) => {
      const mounted = await mountToolbar({ relocate: true });
      try {
        let finish!: () => void;
        const pending = new Promise<void>((resolve) => {
          finish = resolve;
        });
        mounted.actions.setExpanded.mockReturnValueOnce(pending);
        await page.getByTestId("before-toolbar").click();
        await userEvent.keyboard("{Tab}{Tab}{Enter}");
        await vi.waitFor(() => expect(buttons().every((button) => button.disabled)).toBe(true));
        await page.getByTestId(targetId).click();
        const target = page.getByTestId(targetId).element();
        expect(document.activeElement).toBe(target);
        mounted.update({ expanded: true });
        finish();
        await expect.element(page.getByTestId("expanded-anchor")).toBeInTheDocument();
        await vi.waitFor(() => expect(buttons().every((button) => !button.disabled)).toBe(true));
        expect(document.activeElement).toBe(target);
        await leave();
        await vi.waitFor(() => expect(opacity()).toBe("0"));
      } finally {
        await mounted.cleanup();
      }
    },
  );

  it("restores keyboard focus after host rejection so Enter can retry without refocusing", async () => {
    const mounted = await mountToolbar({ relocate: true });
    try {
      let reject!: (error: Error) => void;
      const pending = new Promise<void>((_resolve, fail) => {
        reject = fail;
      });
      mounted.actions.setExpanded.mockReturnValueOnce(pending);
      await page.getByTestId("before-toolbar").click();
      await userEvent.keyboard("{Tab}{Tab}{Enter}");
      await vi.waitFor(() => expect(buttons().every((button) => button.disabled)).toBe(true));
      reject(new Error("Native disclosure failed"));
      await vi.waitFor(() => {
        expect(buttons().every((button) => !button.disabled)).toBe(true);
        expect(document.activeElement).toBe(page.getByTestId("zen-drawer-toggle").element());
      });
      expect(mounted.failure).toHaveBeenCalledWith(
        expect.objectContaining({ type: "error", description: "Native disclosure failed" }),
      );
      await leave();
      await vi.waitFor(() => expect(opacity()).toBe("1"));
      await userEvent.keyboard("{Enter}");
      await expect.element(page.getByTestId("expanded-anchor")).toBeInTheDocument();
      await vi.waitFor(() =>
        expect(document.activeElement).toBe(page.getByTestId("zen-drawer-toggle").element()),
      );
      expect(mounted.actions.setExpanded).toHaveBeenCalledTimes(2);
    } finally {
      await mounted.cleanup();
    }
  });

  it.each([
    ["collapseToBubble", "zen-collapse-to-bubble"],
    ["setExpanded", "zen-drawer-toggle"],
    ["exit", "zen-window-return"],
  ] as const)(
    "disables every action during %s and recovers after host rejection",
    async (action, testId) => {
      const mounted = await mountToolbar();
      try {
        let reject!: (error: Error) => void;
        const pending = new Promise<void>((_resolve, fail) => {
          reject = fail;
        });
        mounted.actions[action].mockReturnValueOnce(pending);
        await page.getByTestId(testId).click();
        await vi.waitFor(() => expect(buttons().every((button) => button.disabled)).toBe(true));
        for (const button of buttons()) button.click();
        expect(mounted.actions[action]).toHaveBeenCalledTimes(1);
        expect(
          Object.values(mounted.actions).reduce(
            (count, operation) => count + operation.mock.calls.length,
            0,
          ),
        ).toBe(1);
        await expect
          .element(page.getByTestId("zen-drawer-toggle"))
          .toHaveAttribute("aria-expanded", "false");
        reject(new Error("Host rejected window action"));
        await vi.waitFor(() => expect(buttons().every((button) => !button.disabled)).toBe(true));
        expect(mounted.failure).toHaveBeenCalledWith(
          expect.objectContaining({
            type: "error",
            description: "Host rejected window action",
          }),
        );
        await leave();
        await vi.waitFor(() => expect(opacity()).toBe("0"));
        await page.getByTestId("zen-mode-toolbar").hover();
        await vi.waitFor(() => expect(opacity()).toBe("1"));
        await page.getByTestId(testId).click();
        expect(mounted.actions[action]).toHaveBeenCalledTimes(2);
        if (action === "exit") {
          await expect.element(page.getByTestId("zen-mode-toolbar")).not.toBeInTheDocument();
        } else {
          await expect
            .element(page.getByTestId("zen-drawer-toggle"))
            .toHaveAttribute("aria-expanded", String(action === "setExpanded"));
        }
        expect((page.getByTestId("preserved-draft").element() as HTMLTextAreaElement).value).toBe(
          "保留这份草稿\n第二行",
        );
      } finally {
        await mounted.cleanup();
      }
    },
  );

  it("keeps the expanded overlay unclipped while transcript scrolling stays bounded", async () => {
    const mounted = await mountToolbar();
    try {
      mounted.update({ expanded: true });
      await expect
        .element(page.getByTestId("zen-drawer-toggle"))
        .toHaveAttribute("aria-expanded", "true");
      const anchor = page.getByTestId("toolbar-anchor").element();
      const drawer = page.getByTestId("chat-transcript-drawer").element();
      const scroller = page.getByTestId("transcript-scroll").element();
      expect(getComputedStyle(anchor).overflow).toBe("visible");
      expect(getComputedStyle(drawer).overflow).toBe("hidden");
      expect(getComputedStyle(scroller).overflowY).toBe("auto");
      const before = toolbar().getBoundingClientRect();
      expect(
        document
          .elementFromPoint(before.left + before.width / 2, before.top + 2)
          ?.closest("[data-testid=zen-mode-toolbar]"),
      ).toBe(toolbar());
      scroller.scrollTop = 200;
      expect(scroller.scrollTop).toBeGreaterThan(0);
      expect(toolbar().getBoundingClientRect().top).toBe(before.top);
      expect(toolbar().getBoundingClientRect().left).toBe(before.left);
    } finally {
      await mounted.cleanup();
    }
  });

  it("renders no controls outside active Zen mode and ignores background state updates for reveal", async () => {
    const mounted = await mountToolbar({ active: false });
    try {
      await expect.element(page.getByTestId("zen-mode-toolbar")).not.toBeInTheDocument();
      await leave();
      mounted.update({ isActive: true });
      await expect.element(page.getByTestId("zen-mode-toolbar")).toBeInTheDocument();
      await vi.waitFor(() => expect(opacity()).toBe("0"));
      mounted.update({ expanded: true });
      await expect
        .element(page.getByTestId("zen-drawer-toggle"))
        .toHaveAttribute("aria-expanded", "true");
      expect(opacity()).toBe("0");
      expect(document.activeElement?.closest("[data-testid=zen-mode-toolbar]")).toBeNull();
    } finally {
      await mounted.cleanup();
    }
  });
});
