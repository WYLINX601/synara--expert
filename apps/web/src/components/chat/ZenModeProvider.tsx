import { useZenPointerPassthrough } from "./useZenPointerPassthrough";
import { ZenModeBubble } from "./ZenModeBubble";
import { THREAD_STATUS_LABEL_KEYS, resolveThreadStatusPill } from "../Sidebar.logic";
import { useStore } from "~/store";
import { ThreadId, type ZenModeState } from "@synara/contracts";
import { useLocation, useParams } from "@tanstack/react-router";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { useTranslation } from "~/i18n";
import { suspendShortcutDispatch } from "~/keybindings";
import { zenModeEntryBlock } from "~/lib/zenMode";
import { selectThreadTerminalState, useTerminalStateStore } from "~/terminalStateStore";
import { toastManager } from "../ui/toast";

const INITIAL_STATE: ZenModeState = {
  isActive: false,
  isBubble: false,
  expanded: false,
  alwaysOnTop: true,
  shortcut: "",
  shortcutAvailable: false,
};

interface ZenModeContextValue {
  state: ZenModeState;
  available: boolean;
  pending: boolean;
  toggle: () => void;
  exit: () => void;
  setExpanded: (expanded: boolean) => void;
  setCompactHeight: (height: number) => Promise<void>;
  /** False when the host has no bubble window; the surface then omits the control. */
  bubbleAvailable: boolean;
  collapseToBubble: () => void;
  restoreFromBubble: () => void;
  hideBubble: () => void;
}

const noop = () => {};
const ZenModeContext = createContext<ZenModeContextValue>({
  state: INITIAL_STATE,
  available: false,
  pending: false,
  toggle: noop,
  exit: noop,
  setExpanded: noop,
  setCompactHeight: async () => {},
  bubbleAvailable: false,
  collapseToBubble: noop,
  restoreFromBubble: noop,
  hideBubble: noop,
});

export function useZenMode() {
  return useContext(ZenModeContext);
}

/** One native subscription above the unchanged route and coordinator trees. */
export function ZenModeProvider({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const bridge = window.desktopBridge?.zenMode;
  const [state, setState] = useState(INITIAL_STATE);
  const [pending, setPending] = useState(false);
  const [operationError, setOperationError] = useState<string | null>(null);
  const isBubble = state.isActive && state.isBubble;
  useZenPointerPassthrough(state.isActive && !isBubble);
  const retainedFocus = useRef<HTMLElement | null>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const bubbleRef = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    if (!isBubble) {
      retainedFocus.current?.focus({ preventScroll: true });
      retainedFocus.current = null;
      return;
    }
    const resumeShortcuts = suspendShortcutDispatch();
    const focused = document.activeElement;
    if (focused instanceof HTMLElement && contentRef.current?.contains(focused)) {
      retainedFocus.current = focused;
    }
    document.documentElement.dataset.zenBubble = "true";
    bubbleRef.current?.focus({ preventScroll: true });
    // Portals live outside the retained route. Keep them mounted, but unable to
    // capture input or focus while only the native companion entry is visible.
    const portals = new Map<HTMLElement, boolean>();
    const suppressPortals = () => {
      for (const child of document.body.children) {
        if (
          !(child instanceof HTMLElement) ||
          child.contains(contentRef.current) ||
          child.contains(bubbleRef.current)
        )
          continue;
        if (!portals.has(child)) portals.set(child, child.inert);
        child.dataset.zenSuppressedPortal = "";
        child.inert = true;
      }
    };
    suppressPortals();
    const observer = new MutationObserver(suppressPortals);
    observer.observe(document.body, { childList: true });
    const guardFocus = (event: FocusEvent) => {
      if (event.target instanceof Node && !bubbleRef.current?.contains(event.target)) {
        bubbleRef.current?.focus({ preventScroll: true });
      }
    };
    const guardKeys = (event: KeyboardEvent) => {
      if (
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        (!["Tab", "Enter", " ", "Escape", "ContextMenu"].includes(event.key) &&
          !(event.shiftKey && event.key === "F10"))
      ) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    };
    window.addEventListener("focusin", guardFocus, true);
    window.addEventListener("keydown", guardKeys, true);
    return () => {
      delete document.documentElement.dataset.zenBubble;
      observer.disconnect();
      window.removeEventListener("focusin", guardFocus, true);
      window.removeEventListener("keydown", guardKeys, true);
      for (const [portal, inert] of portals) {
        portal.inert = inert;
        delete portal.dataset.zenSuppressedPortal;
      }
      resumeShortcuts();
    };
  }, [isBubble]);
  useLayoutEffect(() => {
    if (isBubble && !pending) bubbleRef.current?.focus({ preventScroll: true });
  }, [isBubble, pending]);
  useEffect(() => {
    if (!state.isActive) return;
    document.documentElement.dataset.zenSurface = "true";
    return () => {
      delete document.documentElement.dataset.zenSurface;
    };
  }, [state.isActive]);
  const operationPending = useRef(false);
  const automaticExitRequested = useRef(false);
  const shortcutWarningShown = useRef(false);
  const threadId = useParams({ strict: false, select: (params) => params.threadId ?? null });
  const thread = useStore((store) =>
    threadId ? store.sidebarThreadSummaryById[threadId] : undefined,
  );
  const activity = thread
    ? resolveThreadStatusPill({
        thread,
        hasPendingApprovals: thread.hasPendingApprovals,
        hasPendingUserInput: thread.hasPendingUserInput,
      })
    : null;
  const search = useLocation({ select: (location) => location.search }) as {
    splitViewId?: string;
    view?: string;
  };
  const terminal = useTerminalStateStore((store) => {
    if (!threadId) return false;
    const current = selectThreadTerminalState(
      store.terminalStateByThreadId,
      ThreadId.makeUnsafe(threadId),
    );
    return (
      current.entryPoint === "terminal" ||
      (current.terminalOpen && current.workspaceActiveTab === "terminal")
    );
  });
  const entryBlock = zenModeEntryBlock({ threadId, ...search, terminal });

  const reportFailure = useCallback(
    (error: unknown) => {
      setOperationError(error instanceof Error ? error.message : String(error));
      toastManager.add({
        type: "error",
        title: t("chat:zenFailed"),
        description: error instanceof Error ? error.message : String(error),
      });
    },
    [t],
  );

  useEffect(() => {
    if (!bridge) return;
    let disposed = false;
    let receivedEvent = false;
    const unsubscribe = bridge.onStateChanged((next) => {
      receivedEvent = true;
      if (!disposed) {
        if (
          next.isBubble &&
          document.activeElement instanceof HTMLElement &&
          contentRef.current?.contains(document.activeElement)
        ) {
          retainedFocus.current = document.activeElement;
        }
        setState(next);
      }
    });
    void bridge
      .getState()
      .then((next) => {
        if (!disposed && !receivedEvent) setState(next);
      })
      .catch(reportFailure);
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [bridge, reportFailure]);

  const run = useCallback(
    (action: () => Promise<void>) => {
      if (operationPending.current) return;
      operationPending.current = true;
      setPending(true);
      setOperationError(null);
      void action()
        .catch(reportFailure)
        .finally(() => {
          operationPending.current = false;
          setPending(false);
        });
    },
    [reportFailure],
  );
  const exit = useCallback(() => {
    if (bridge) run(() => bridge.exit());
  }, [bridge, run]);
  const toggle = useCallback(() => {
    if (!bridge) return;
    if (isBubble) {
      if (bridge.bubble) run(() => bridge.bubble!.restore());
      return;
    }
    if (state.isActive) {
      exit();
      return;
    }
    if (entryBlock) {
      toastManager.add({
        type: "info",
        title: t(entryBlock === "choose-chat" ? "chat:zenChooseChat" : "chat:zenUnavailable"),
      });
      return;
    }
    run(() => bridge.enter());
  }, [bridge, entryBlock, exit, isBubble, run, state.isActive, t]);

  useEffect(() => bridge?.onToggleRequested(toggle), [bridge, toggle]);

  // Navigation from an existing shortcut/link must never strand another page in
  // compact native bounds. The same chat stays mounted on ordinary mode changes.
  useEffect(() => {
    if (!state.isActive || !entryBlock) {
      automaticExitRequested.current = false;
      return;
    }
    if (!pending && !automaticExitRequested.current) {
      automaticExitRequested.current = true;
      exit();
    }
  }, [entryBlock, exit, state.isActive, pending]);

  useEffect(() => {
    if (!state.isActive) {
      shortcutWarningShown.current = false;
      return;
    }
    if (state.shortcut && !state.shortcutAvailable && !shortcutWarningShown.current) {
      shortcutWarningShown.current = true;
      toastManager.add({ type: "info", title: t("chat:zenShortcutUnavailable") });
    }
  }, [state.isActive, state.shortcut, state.shortcutAvailable, t]);

  const setExpanded = useCallback(
    (expanded: boolean) => {
      if (bridge && !isBubble) run(() => bridge.setExpanded(expanded));
    },
    [bridge, isBubble, run],
  );
  const setCompactHeight = useCallback(
    async (height: number) => {
      if (!bridge || isBubble) return;
      try {
        await bridge.setCompactHeight(height);
      } catch (error) {
        reportFailure(error);
        throw error;
      }
    },
    [bridge, isBubble, reportFailure],
  );
  const collapseToBubble = useCallback(() => {
    if (bridge?.bubble) run(() => bridge.bubble!.collapse());
  }, [bridge, run]);
  const restoreFromBubble = useCallback(() => {
    if (bridge?.bubble) run(() => bridge.bubble!.restore());
  }, [bridge, run]);
  const hideBubble = useCallback(() => {
    if (bridge?.bubble) run(() => bridge.bubble!.hide());
  }, [bridge, run]);
  const value = useMemo(
    () => ({
      state,
      available: Boolean(bridge),
      pending,
      toggle,
      exit,
      setExpanded,
      setCompactHeight,
      bubbleAvailable: Boolean(bridge?.bubble),
      collapseToBubble,
      restoreFromBubble,
      hideBubble,
    }),
    [
      state,
      bridge,
      pending,
      toggle,
      exit,
      setExpanded,
      setCompactHeight,
      collapseToBubble,
      restoreFromBubble,
      hideBubble,
    ],
  );

  return (
    <ZenModeContext.Provider value={value}>
      <div
        ref={contentRef}
        data-zen-retained-content=""
        data-hidden={isBubble}
        className="contents"
        inert={isBubble}
        aria-hidden={isBubble || undefined}
      >
        {children}
      </div>
      {isBubble ? (
        <ZenModeBubble
          buttonRef={bubbleRef}
          label={`${t("chat:zenRestore")}${thread?.title ? ` · ${thread.title}` : ""}${operationError ? ` · ${operationError}` : activity ? ` · ${t(THREAD_STATUS_LABEL_KEYS[activity.label])}` : ""}`}
          hideLabel={t("chat:zenHideBubble")}
          disabled={pending}
          onRestore={restoreFromBubble}
          onHide={hideBubble}
          onError={reportFailure}
        >
          {operationError || activity ? (
            <span
              data-testid="zen-bubble-status"
              className={`zen-bubble-status ${operationError ? "text-destructive" : activity?.colorClass}`}
              aria-hidden="true"
            />
          ) : null}
        </ZenModeBubble>
      ) : null}
    </ZenModeContext.Provider>
  );
}
