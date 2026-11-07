import { useZenPointerPassthrough } from "./useZenPointerPassthrough";
import { ThreadId, type ZenModeState } from "@synara/contracts";
import { useLocation, useParams } from "@tanstack/react-router";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { useTranslation } from "~/i18n";
import { zenModeEntryBlock } from "~/lib/zenMode";
import { selectThreadTerminalState, useTerminalStateStore } from "~/terminalStateStore";
import { toastManager } from "../ui/toast";

const INITIAL_STATE: ZenModeState = {
  isActive: false,
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
  useZenPointerPassthrough(state.isActive);
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
      if (!disposed) setState(next);
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
  }, [bridge, entryBlock, exit, run, state.isActive, t]);

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
      if (bridge) run(() => bridge.setExpanded(expanded));
    },
    [bridge, run],
  );
  const setCompactHeight = useCallback(
    async (height: number) => {
      if (!bridge) return;
      try {
        await bridge.setCompactHeight(height);
      } catch (error) {
        reportFailure(error);
        throw error;
      }
    },
    [bridge, reportFailure],
  );
  const value = useMemo(
    () => ({
      state,
      available: Boolean(bridge),
      pending,
      toggle,
      exit,
      setExpanded,
      setCompactHeight,
    }),
    [state, bridge, pending, toggle, exit, setExpanded, setCompactHeight],
  );

  return <ZenModeContext.Provider value={value}>{children}</ZenModeContext.Provider>;
}
