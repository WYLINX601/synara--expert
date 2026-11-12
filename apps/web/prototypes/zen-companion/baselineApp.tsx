import React, { useEffect } from "react";
import ReactDOM, { type Root } from "react-dom/client";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import "@fontsource-variable/jetbrains-mono";
import "./baselineApp.css";
import { DEFAULT_THEME_STATE, serializeThemeState } from "../../src/theme/theme.logic";
import type { BaselineFixtureController, BaselineScene, CompanionStatus } from "./baseline.types";
import {
  installPreviewBridge,
  isBaselineScene,
  postToReview,
  type PreviewControlMessage,
  type PreviewBridgeController,
} from "./previewBridge";

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("Preview application root is missing.");

let fixture: BaselineFixtureController | undefined;
let bridge: PreviewBridgeController | undefined;
let selectedScene: BaselineScene = "idle";
let ready = false;
let disposeI18n: (() => void) | undefined;
let root: Root | undefined;
let disposed = false;
let disposeStatus: (() => void) | undefined;
let latestStatus: CompanionStatus | undefined;
let focusFrame: number | undefined;

const publishStatus = () => {
  if (latestStatus)
    postToReview({ source: "synara-zen-baseline", type: "status", status: latestStatus });
};

const cancelComposerFocus = () => {
  if (focusFrame !== undefined) cancelAnimationFrame(focusFrame);
  focusFrame = undefined;
};

const requestComposerFocus = () => {
  cancelComposerFocus();
  if (!ready || !bridge?.isZenActive()) return;
  // The bridge event updates the real provider first. Wait for that React
  // commit and the parent's visible-frame commit, never focus on status changes.
  focusFrame = requestAnimationFrame(() => {
    focusFrame = requestAnimationFrame(() => {
      focusFrame = undefined;
      if (!ready || disposed || !bridge?.isZenActive()) return;
      const frame = window.frameElement;
      if (
        !frame ||
        frame.closest("[inert], [hidden]") ||
        frame.getClientRects().length === 0 ||
        getComputedStyle(frame).visibility !== "visible"
      )
        return;
      const editor = document.querySelector<HTMLElement>(
        '[data-testid="composer-editor"][contenteditable="true"]',
      );
      if (editor?.getClientRects().length && !editor.closest("[inert], [hidden]"))
        editor.focus({ preventScroll: true });
    });
  });
};

const onReviewMessage = (event: MessageEvent<PreviewControlMessage>) => {
  if (event.origin !== window.location.origin || event.source !== window.parent) return;
  const message = event.data;
  if (!message || message.source !== "synara-zen-review") return;
  if ((message.type === "connect" || message.type === "scene") && isBaselineScene(message.scene)) {
    if (selectedScene !== message.scene) {
      selectedScene = message.scene;
      fixture?.setScene(selectedScene);
    }
    if (message.type === "connect" && ready) {
      postToReview({ source: "synara-zen-baseline", type: "ready" });
      bridge?.publish();
      publishStatus();
    }
  } else if (message.type === "toggle-mode" && ready) {
    cancelComposerFocus();
    bridge?.requestToggle();
  } else if (
    message.type === "show-mode" &&
    ready &&
    bridge &&
    Number.isSafeInteger(message.requestId) &&
    message.requestId > 0 &&
    (message.mode === "zen" || message.mode === "workspace")
  ) {
    cancelComposerFocus();
    bridge.requestMode(message.mode);
    postToReview({
      source: "synara-zen-baseline",
      type: "mode-result",
      requestId: message.requestId,
      mode: bridge.isZenActive() ? "zen" : "workspace",
    });
  } else if (message.type === "focus-composer") {
    requestComposerFocus();
  } else if (message.type === "hide-bubble") {
    bridge?.hideBubble();
  }
};
window.addEventListener("message", onReviewMessage);

function MountedHandshake() {
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      ready = true;
      postToReview({ source: "synara-zen-baseline", type: "ready" });
      bridge?.publish();
      publishStatus();
    });
    return () => {
      cancelAnimationFrame(frame);
      ready = false;
      cancelComposerFocus();
    };
  }, []);
  return null;
}

async function start() {
  bridge = installPreviewBridge();
  const { initializeBaselineFixture, PREVIEW_THREAD_ID } = await import("./baselineFixture");
  fixture = await initializeBaselineFixture();
  if (disposed) {
    fixture.dispose();
    return;
  }
  disposeStatus = fixture.subscribeStatus((status) => {
    const changed =
      !latestStatus ||
      latestStatus.phase !== status.phase ||
      latestStatus.threadId !== status.threadId ||
      latestStatus.threadTitle !== status.threadTitle;
    latestStatus = status;
    // The fixture reports every snapshot revision; the parent needs activity
    // transitions, not repeated announcements for each streaming text chunk.
    if (ready && changed) publishStatus();
  });
  // Seed only this isolated preview origin through the production preference
  // format. The original theme engine and typography still own every app style.
  localStorage.setItem(
    "synara:theme",
    serializeThemeState({ ...DEFAULT_THEME_STATE, mode: "light" }),
  );
  if (selectedScene !== "idle") fixture.setScene(selectedScene);

  // Transport interception must exist before importing the actual route graph:
  // its module-level stores and hooks may construct the real WebSocket client.
  const [{ getRouter }, { initializeI18n, setLanguagePreference }] = await Promise.all([
    import("../../src/router"),
    import("../../src/i18n"),
  ]);
  if (disposed) return;
  disposeI18n = initializeI18n();
  setLanguagePreference("zh-CN");
  const router = getRouter(createMemoryHistory({ initialEntries: [`/${PREVIEW_THREAD_ID}`] }));
  root = ReactDOM.createRoot(rootElement!);
  root.render(
    <React.StrictMode>
      <RouterProvider router={router} />
      <MountedHandshake />
    </React.StrictMode>,
  );
}

void start().catch((error: unknown) => {
  if (disposed) return;
  const message = error instanceof Error ? error.message : String(error);
  postToReview({ source: "synara-zen-baseline", type: "error", message });
  // A direct app.html visit still gets an honest startup error rather than a
  // replacement composer or a silently disconnected imitation of the app.
  rootElement.textContent = `Preview could not start: ${message}`;
});

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    disposed = true;
    ready = false;
    cancelComposerFocus();
    disposeStatus?.();
    window.removeEventListener("message", onReviewMessage);
    root?.unmount();
    fixture?.dispose();
    disposeI18n?.();
    bridge?.dispose();
  });
}
