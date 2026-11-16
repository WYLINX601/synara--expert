import type {
  DesktopBridge,
  LinxUpdateWindowMaintenanceRequest,
  LinxUpdateWindowMaintenanceResponse,
} from "@synara/contracts";
import { t } from "~/i18n";
import { useStore } from "~/store";
import { composerDraftDurabilitySnapshot } from "~/composerDraftStore";
import { readNativeApiServerConnection } from "~/nativeApi";
import {
  composerPersistenceOperationCount,
  freezeComposerPersistenceForUpdate,
  releaseComposerPersistenceForUpdate,
  subscribeComposerPersistenceOperations,
} from "./composerPersistenceActivity";
import { listRunningChatsFromDesktopStore } from "./runningChatsQuitConfirmation";
import {
  freezeWorkspaceEditorsForUpdate,
  releaseWorkspaceEditorsForUpdate,
  workspaceEditorMaintenanceSnapshot,
} from "./workspaceEditorSession";

interface EditorState {
  readonly unsavedEditors: number;
  readonly savingEditors: number;
}

/** Synchronous freeze-before-snapshot: neither autosave nor chat interruption is preparation. */
export function createRendererMaintenanceHandler(input: {
  readonly freeze: (attemptId: string, digest: string) => (() => void) | null;
  readonly editors: () => EditorState;
  readonly runningChats: () => number;
  readonly persistence: () => {
    pendingWrites: number;
    transientAttachments: number;
    hydrated: boolean;
  };
  readonly subscribe?: (invalidate: () => void) => () => void;
  readonly connected: () => boolean;
  readonly reply: (response: LinxUpdateWindowMaintenanceResponse) => void;
  readonly message: (reason: "editors" | "chats" | "unknown" | "changed") => string;
}) {
  let held: { request: LinxUpdateWindowMaintenanceRequest; release: () => void } | null = null;
  const retired = new Set<string>();
  const retiredProbes = new Set<string>();
  let disposed = false;
  const release = () => {
    if (!held) return;
    const previous = held;
    held = null;
    retired.add(previous.request.attemptId);
    previous.release();
  };
  const invalidate = () => {
    const request = held?.request;
    if (!request) return;
    release();
    input.reply({
      schemaVersion: 1,
      attemptId: request.attemptId,
      manifestDigest: request.manifestDigest,
      probeId: request.probeId,
      ready: false,
      unsavedEditors: 0,
      savingEditors: 0,
      message: input.message("changed"),
    });
  };
  const unsubscribe = input.subscribe?.(invalidate);
  const handle = (request: LinxUpdateWindowMaintenanceRequest) => {
    if (disposed) return;
    if (retiredProbes.has(request.probeId)) return;
    if (request.action === "release") {
      if (
        held?.request.attemptId === request.attemptId &&
        held.request.manifestDigest === request.manifestDigest &&
        held.request.probeId === request.probeId
      )
        release();
      if (!held || held.request.attemptId !== request.attemptId) retired.add(request.attemptId);
      return;
    }
    const reply = (ready: boolean, state: EditorState, message: string | null) =>
      input.reply({
        schemaVersion: 1,
        attemptId: request.attemptId,
        manifestDigest: request.manifestDigest,
        probeId: request.probeId,
        ready,
        ...state,
        message,
      });
    if (
      retired.has(request.attemptId) ||
      (held &&
        (held.request.attemptId !== request.attemptId ||
          held.request.manifestDigest !== request.manifestDigest ||
          (held.request.probeId === request.probeId &&
            held.request.backendStopped !== request.backendStopped)))
    ) {
      release();
      retired.add(request.attemptId);
      reply(false, { unsavedEditors: 0, savingEditors: 0 }, input.message("changed"));
      return;
    }
    if (held?.request.backendStopped && !request.backendStopped) {
      release();
      reply(false, { unsavedEditors: 0, savingEditors: 0 }, input.message("changed"));
      return;
    }
    if (held && held.request.probeId !== request.probeId) {
      retiredProbes.add(held.request.probeId);
      held.request = request;
    }
    try {
      if (request.backendStopped && !held)
        throw new Error("No connected window lease precedes the stopped proof");
      if (!request.backendStopped && !input.connected()) throw new Error("Window is disconnected");
      if (!held) {
        const cleanup = input.freeze(request.attemptId, request.manifestDigest);
        if (!cleanup) throw new Error("Cannot freeze this window");
        held = { request, release: cleanup };
      }
      const state = input.editors();
      const persistence = input.persistence();
      if (
        !persistence.hydrated ||
        !Number.isSafeInteger(persistence.pendingWrites) ||
        persistence.pendingWrites < 0 ||
        !Number.isSafeInteger(persistence.transientAttachments) ||
        persistence.transientAttachments < 0
      )
        throw new Error("Unknown window persistence");
      const chats = input.runningChats();
      if (
        !Number.isSafeInteger(state.unsavedEditors) ||
        state.unsavedEditors < 0 ||
        !Number.isSafeInteger(state.savingEditors) ||
        state.savingEditors < 0 ||
        !Number.isSafeInteger(chats) ||
        chats < 0
      )
        throw new Error("Unknown window activity");
      if (persistence.pendingWrites !== 0 || persistence.transientAttachments !== 0) {
        release();
        reply(false, state, input.message("editors"));
        return;
      }
      if (state.unsavedEditors !== 0 || state.savingEditors !== 0 || chats !== 0) {
        release();
        reply(false, state, input.message(chats !== 0 ? "chats" : "editors"));
        return;
      }
      if (!held) return;
      reply(true, state, null);
    } catch {
      release();
      retired.add(request.attemptId);
      reply(false, { unsavedEditors: 0, savingEditors: 0 }, input.message("unknown"));
    }
  };
  return {
    handle,
    dispose: () => {
      unsubscribe?.();
      disposed = true;
      invalidate();
    },
  };
}

export function installLinxUpdateWindowMaintenance(
  bridge: DesktopBridge["updateWindowMaintenance"] = window.desktopBridge?.updateWindowMaintenance,
) {
  if (!bridge) return;
  const handler = createRendererMaintenanceHandler({
    freeze: (attemptId, digest) => {
      if (!freezeWorkspaceEditorsForUpdate(attemptId, digest)) return null;
      if (!freezeComposerPersistenceForUpdate(attemptId, digest)) {
        releaseWorkspaceEditorsForUpdate(attemptId, digest);
        return null;
      }
      const previousInert = document.body.inert;
      document.body.inert = true;
      const prevent = (event: Event) => {
        event.preventDefault();
        event.stopImmediatePropagation();
      };
      const events = [
        "beforeinput",
        "keydown",
        "pointerdown",
        "mousedown",
        "click",
        "paste",
        "cut",
        "drop",
        "submit",
      ];
      for (const event of events)
        document.addEventListener(event, prevent, { capture: true, passive: false });
      return () => {
        document.body.inert = previousInert;
        for (const event of events) document.removeEventListener(event, prevent, true);
        releaseWorkspaceEditorsForUpdate(attemptId, digest);
        releaseComposerPersistenceForUpdate(attemptId, digest);
      };
    },
    editors: workspaceEditorMaintenanceSnapshot,
    connected: () => readNativeApiServerConnection().connected,
    persistence: () => {
      const draft = composerDraftDurabilitySnapshot();
      return {
        pendingWrites: composerPersistenceOperationCount(),
        transientAttachments: draft.transientAttachments,
        hydrated: draft.hydrated && useStore.getState().threadsHydrated,
      };
    },
    subscribe: (invalidate) => {
      const unsubscribePersistence = subscribeComposerPersistenceOperations(invalidate);
      const unsubscribeStore = useStore.subscribe(() => {
        if (listRunningChatsFromDesktopStore(useStore.getState()).length !== 0) invalidate();
      });
      const onPageHide = () => invalidate();
      window.addEventListener("pagehide", onPageHide);
      return () => {
        unsubscribePersistence();
        unsubscribeStore();
        window.removeEventListener("pagehide", onPageHide);
      };
    },
    runningChats: () => listRunningChatsFromDesktopStore(useStore.getState()).length,
    reply: bridge.reply,
    message: (reason) => t(`desktop:linxUpdateMaintenance_${reason}`),
  });
  const unsubscribe = bridge.onRequest(handler.handle);
  return () => {
    unsubscribe();
    handler.dispose();
  };
}
