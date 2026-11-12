// Real Electron window + production preload/IPC, with an isolated synthetic profile.
// This does not start a provider or read the user's workbench data.
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { app, BrowserWindow, WebContentsView, globalShortcut, ipcMain, screen } from "electron";
import { ThreadId } from "@synara/contracts";
import { DesktopBrowserManager } from "../src/browserManager";
import { DESKTOP_IPC_CHANNELS } from "../src/ipcChannels";
import { registerZenModeIpc } from "../src/zenModeIpc";
import { ZEN_MODE_EXPANDED_HEIGHT, ZenModeManager } from "../src/zenModeManager";
import { createWindowMaterialApplier } from "../src/windowMaterial";

const profile = mkdtempSync(join(tmpdir(), "synara-zen-smoke-"));
app.setPath("userData", profile);
const deadline = setTimeout(() => {
  console.error("Zen native smoke exceeded its deadline.");
  app.exit(1);
}, 60_000);

async function eventually(check: () => boolean, label: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (check()) return;
    await new Promise((done) => setTimeout(done, 30));
  }
  assert.ok(check(), label);
}

async function smoke() {
  await app.whenReady();
  // Production preload's synchronous environment probes need explicit neutral replies.
  ipcMain.on(DESKTOP_IPC_CHANNELS.windowTranslucency, (event) => {
    event.returnValue = undefined;
  });
  ipcMain.on(DESKTOP_IPC_CHANNELS.betaDiagnostics.enabled, (event) => {
    event.returnValue = false;
  });
  const window = new BrowserWindow({
    width: 960,
    height: 680,
    minWidth: 840,
    minHeight: 620,
    show: true,
    backgroundColor: "#00000000",
    ...(process.platform === "darwin"
      ? { titleBarStyle: "hiddenInset" as const, transparent: true }
      : {}),
    webPreferences: {
      preload: resolve(process.env.SYNARA_ZEN_SMOKE_PRELOAD ?? "dist-electron/preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  // Electron exposes no mouse-ignore getter; record calls while still applying them natively.
  let pointerPassthrough = false;
  const applyPointerPassthrough = window.setIgnoreMouseEvents.bind(window);
  window.setIgnoreMouseEvents = (ignore, options) => {
    applyPointerPassthrough(ignore, options);
    pointerPassthrough = ignore;
  };
  const browser = new DesktopBrowserManager();
  browser.setWindow(window);
  const applyMaterial = createWindowMaterialApplier(() => null);
  if (process.platform === "darwin") {
    applyMaterial(window, { material: "opaque", blurRadius: 0 });
  }
  let browserViewsOccluded = false;
  let visibleOnFullScreen = false;
  const manager = new ZenModeManager({
    platform: process.platform,
    getWindow: () => (window.isDestroyed() ? null : window),
    getDisplayWorkAreas: () => screen.getAllDisplays().map((display) => display.workArea),
    getCursorScreenPoint: () => screen.getCursorScreenPoint(),
    getWindowZoomFactor: () => window.webContents.getZoomFactor(),
    onStateChanged: (state) => {
      if (!window.isDestroyed()) {
        window.webContents.send(DESKTOP_IPC_CHANNELS.zenMode.stateChanged, state);
      }
    },
    onToggleRequested: () => {},
    setBrowserViewsZenMode: (_window, active) => {
      browserViewsOccluded = active;
      browser.setZenModeActive(active);
    },
    setTrafficLightsVisible: (_window, visible) => {
      if (process.platform === "darwin") window.setWindowButtonVisibility(visible);
    },
    setZenWindowMaterial: (_window, active) => {
      if (process.platform !== "darwin") return;
      if (active) applyMaterial.suspend(window);
      else applyMaterial.resume(window);
    },
    getVisibleOnFullScreen: () => visibleOnFullScreen,
    setVisibleOnAllWorkspaces: (_window, visible, fullscreen) => {
      window.setVisibleOnAllWorkspaces(visible, { visibleOnFullScreen: fullscreen });
      visibleOnFullScreen = fullscreen;
    },
    shortcut: "CommandOrControl+Alt+Shift+F12",
    shortcutRegistry: globalShortcut,
  });
  registerZenModeIpc(ipcMain, manager, (event) => event.sender === window.webContents);
  let zoomSyncError: unknown;
  ipcMain.on(DESKTOP_IPC_CHANNELS.zoomFactor, (event) => {
    event.returnValue = event.sender.getZoomFactor();
    if (event.sender === window.webContents) {
      void manager.syncBubbleZoom().catch((error: unknown) => {
        zoomSyncError = error;
      });
    }
  });
  try {
    await window.loadURL(
      `data:text/html,${encodeURIComponent(`
        <title>Zen isolated smoke</title>
        <style>
          body { margin: 0; background: transparent; }
          textarea { position: fixed; left: 24px; top: 28px; width: 180px; height: 48px; -webkit-app-region: no-drag; }
          #drag { position: fixed; left: 24px; right: 24px; bottom: 0; height: 24px; background: #6080a0; -webkit-app-region: drag; }
        </style>
        <textarea id="draft">retained synthetic draft</textarea><div id="drag"></div>
      `)}`,
    );
    const invoke = (expression: string) => window.webContents.executeJavaScript(expression);
    await invoke("window.originalEditor = document.querySelector('#draft')");
    const threadId = ThreadId.makeUnsafe("zen-native-smoke");
    browser.open({ threadId });
    const browserBounds = { x: 0, y: 0, width: 700, height: 400 };
    browser.setPanelBounds({ threadId, surface: "native", bounds: browserBounds });
    const browserView = window.contentView.children.find(
      (view): view is WebContentsView =>
        view instanceof WebContentsView && view.webContents !== window.webContents,
    );
    assert.ok(browserView?.getVisible());
    const browserContents = browserView.webContents;
    await browserContents.loadURL("data:text/html,<p>synthetic browser page</p>");
    await browserContents.executeJavaScript("window.zenSentinel = 'retained'");
    const original = {
      bounds: window.getNormalBounds(),
      minimum: window.getMinimumSize(),
      maximum: window.getMaximumSize(),
      pinned: window.isAlwaysOnTop(),
      resizable: window.isResizable(),
      allWorkspaces: window.isVisibleOnAllWorkspaces(),
      shadow: window.hasShadow(),
      visibleOnFullScreen,
    };
    const shortcutRegistered = manager.registerShortcut();
    await invoke("window.desktopBridge.zenMode.enter()");
    assert.equal(manager.getState().isActive, true);
    assert.equal(browserViewsOccluded, true);
    assert.equal(browserView.getVisible(), false);
    // The real hidden RightDock reports a zero rectangle; this must not discard the page.
    browser.setPanelBounds({ threadId, surface: "native", bounds: null, occluded: false });
    browser.setPanelBounds({ threadId, surface: "native", bounds: browserBounds });
    assert.equal(browserView.getVisible(), false, "a browser publication must not cover Zen");
    browser.setPanelBounds({ threadId, surface: "native", bounds: null, occluded: false });
    assert.equal(window.isAlwaysOnTop(), true);
    if (process.platform === "darwin") {
      assert.equal(window.isVisibleOnAllWorkspaces(), true);
      assert.equal(visibleOnFullScreen, true);
      const clearPixel = await window.webContents.capturePage({ x: 0, y: 0, width: 1, height: 1 });
      assert.equal(clearPixel.toBitmap()[3], 0, "the empty renderer corner must retain alpha");
    }
    assert.equal(window.hasShadow(), false, "only rendered surfaces should cast Zen shadows");
    await invoke("window.desktopBridge.zenMode.setPointerPassthrough(true)");
    assert.equal(pointerPassthrough, process.platform === "darwin");
    await invoke("window.desktopBridge.zenMode.setPointerPassthrough(false)");
    assert.equal(pointerPassthrough, false);
    if (process.platform === "darwin") {
      const fullscreenHost = new BrowserWindow({
        width: 800,
        height: 600,
        title: "Zen synthetic fullscreen host",
        backgroundColor: "#204060",
        webPreferences: { sandbox: true },
      });
      try {
        await fullscreenHost.loadURL("data:text/html,<title>Zen synthetic fullscreen host</title>");
        await new Promise<void>((done) => {
          fullscreenHost.once("enter-full-screen", () => done());
          fullscreenHost.setFullScreen(true);
        });
        fullscreenHost.focus();
        await eventually(() => fullscreenHost.isFocused(), "fullscreen host retains focus");
        await eventually(() => window.isVisible(), "Zen remains visible in fullscreen workspace");
        assert.equal(window.isVisibleOnAllWorkspaces(), true);
        assert.equal(window.isAlwaysOnTop(), true);
        assert.equal(
          fullscreenHost.isFocused(),
          true,
          "Zen does not reclaim fullscreen host focus",
        );
        await new Promise<void>((done) => {
          fullscreenHost.once("leave-full-screen", () => done());
          fullscreenHost.setFullScreen(false);
        });
      } finally {
        if (!fullscreenHost.isDestroyed()) fullscreenHost.destroy();
      }
    }
    assert.deepEqual(manager.getWindowStateForPersistence()?.bounds, original.bounds);
    await invoke("window.desktopBridge.zenMode.setCompactHeight(145)");
    await eventually(() => Math.abs(window.getContentBounds().height - 145) <= 1, "compact height");
    const region = await invoke(`(() => {
      const { x, y, width, height } = document.querySelector('#drag').getBoundingClientRect();
      return { x, y, width, height };
    })()`);
    await invoke(`window.desktopBridge.zenMode.setDragRegion(${JSON.stringify(region)})`);
    const panelBounds = window.getBounds();
    const workArea = screen.getDisplayMatching(panelBounds).workArea;
    const nativeFrameHeight = panelBounds.height - window.getContentBounds().height;
    const requestedExpandedHeight = ZEN_MODE_EXPANDED_HEIGHT + nativeFrameHeight;
    const expectedExpandedHeight = Math.min(workArea.height, requestedExpandedHeight);
    const requestedTop = panelBounds.y + panelBounds.height - requestedExpandedHeight;
    const expectedExpandedTop = Math.max(
      workArea.y,
      Math.min(requestedTop, workArea.y + workArea.height - expectedExpandedHeight),
    );
    await invoke("window.desktopBridge.zenMode.setExpanded(true)");
    await eventually(
      () => window.getBounds().height === expectedExpandedHeight,
      "expanded height fits the available work area",
    );
    assert.equal(window.getBounds().x, panelBounds.x);
    assert.equal(window.getBounds().width, panelBounds.width);
    assert.equal(window.getBounds().y, expectedExpandedTop, "expansion clamps to the work area");
    if (requestedTop >= workArea.y) {
      assert.equal(
        window.getBounds().y + window.getBounds().height,
        panelBounds.y + panelBounds.height,
        "expansion retains the bottom anchor when there is room above",
      );
    } else {
      assert.equal(
        window.getBounds().y,
        workArea.y,
        "insufficient space clamps to the work-area top",
      );
    }
    await invoke("window.desktopBridge.zenMode.setExpanded(false)");
    const compactBounds = window.getBounds();
    // Initial placement for the next geometry case only; this is not native drag evidence.
    const fixtureBounds = {
      ...compactBounds,
      y: workArea.y + workArea.height - compactBounds.height,
    };
    window.setBounds(fixtureBounds);
    await eventually(
      () => window.getBounds().y === fixtureBounds.y,
      "bottom-edge fixture placement",
    );
    const anchoredBounds = window.getBounds();
    await invoke("window.desktopBridge.zenMode.setExpanded(true)");
    await eventually(
      () => window.getBounds().height === expectedExpandedHeight,
      "anchored expansion height",
    );
    assert.equal(window.getBounds().x, anchoredBounds.x);
    assert.equal(window.getBounds().width, anchoredBounds.width);
    assert.equal(
      window.getBounds().y + window.getBounds().height,
      anchoredBounds.y + anchoredBounds.height,
      "a bottom-edge fixture has enough room to retain the expansion anchor",
    );
    const expanded = window.getBounds();
    await invoke("window.desktopBridge.zenMode.setCompactHeight(180)");
    assert.deepEqual(window.getBounds(), expanded, "expanded geometry must ignore compact updates");
    if (process.platform === "darwin") {
      await invoke("window.desktopBridge.zenMode.bubble.collapse()");
      assert.equal(manager.getState().isBubble, true);
      assert.equal(window.isMinimized(), false, "a bubble is not native minimization");
      assert.deepEqual(window.getContentSize(), [36, 36]);
      const bubble = window.getBounds();
      await invoke("window.desktopBridge.zenMode.setExpanded(false)");
      await invoke("window.desktopBridge.zenMode.setCompactHeight(600)");
      await invoke("window.desktopBridge.zenMode.setPointerPassthrough(true)");
      assert.deepEqual(window.getBounds(), bubble, "late panel IPC must not resize the bubble");
      assert.equal(pointerPassthrough, false, "a stale request must not disable bubble input");
      assert.deepEqual(manager.getWindowStateForPersistence()?.bounds, original.bounds);
      await invoke("window.desktopBridge.zenMode.bubble.hide()");
      assert.equal(window.isVisible(), false);
      await invoke("window.desktopBridge.zenMode.setCompactHeight(600)");
      assert.equal(window.isVisible(), false, "background layout must not wake a hidden bubble");
      await manager.restoreFromBubble();
      assert.equal(window.isVisible(), true, "the host activation path restores the panel");
      assert.equal(manager.getState().isBubble, false);
      assert.deepEqual(window.getBounds(), expanded);
      await invoke("window.desktopBridge.zenMode.bubble.collapse()");
      await invoke("window.desktopBridge.zenMode.bubble.restore()");
      assert.deepEqual(window.getBounds(), expanded);
      const originalZoom = window.webContents.getZoomFactor();
      window.webContents.setZoomFactor(1.25);
      await invoke("window.desktopBridge.zenMode.bubble.collapse()");
      assert.deepEqual(
        window.getContentSize(),
        [45, 45],
        "the bubble fits 36 CSS pixels at 125% zoom",
      );
      window.webContents.setZoomFactor(2);
      await eventually(() => {
        if (zoomSyncError) throw zoomSyncError;
        return window.getContentSize()[0] === 72 && window.getContentSize()[1] === 72;
      }, "preload viewport notification resizes an already-visible bubble at 200% zoom");
      await invoke("window.desktopBridge.zenMode.bubble.hide()");
      window.webContents.setZoomFactor(0.8);
      await manager.syncBubbleZoom();
      assert.deepEqual(
        window.getContentSize(),
        [29, 29],
        "hidden bubbles also retain CSS-pixel sizing",
      );
      assert.equal(window.isVisible(), false, "zoom changes must not wake hidden bubbles");
      await invoke("window.desktopBridge.zenMode.bubble.restore()");
      assert.deepEqual(
        window.getBounds(),
        expanded,
        "zoomed bubbles retain independent panel bounds",
      );
      window.webContents.setZoomFactor(originalZoom);
    } else {
      assert.equal(await invoke("window.desktopBridge.zenMode.bubble"), undefined);
    }
    await invoke("window.desktopBridge.zenMode.setExpanded(false)");
    await eventually(
      () => Math.abs(window.getContentBounds().height - 180) <= 1,
      "cached compact height",
    );
    await assert.rejects(invoke("window.desktopBridge.zenMode.setCompactHeight(NaN)"));
    await invoke("window.desktopBridge.zenMode.setPointerPassthrough(true)");
    await invoke("window.desktopBridge.zenMode.exit()");
    assert.equal(pointerPassthrough, false, "exiting must restore pointer input");
    await eventually(() => window.getBounds().width === original.bounds.width, "restored width");
    assert.deepEqual(window.getNormalBounds(), original.bounds);
    assert.deepEqual(window.getMinimumSize(), original.minimum);
    assert.deepEqual(window.getMaximumSize(), original.maximum);
    assert.equal(window.isAlwaysOnTop(), original.pinned);
    assert.equal(window.isResizable(), original.resizable);
    assert.equal(window.isVisibleOnAllWorkspaces(), original.allWorkspaces);
    assert.equal(window.hasShadow(), original.shadow);
    assert.equal(visibleOnFullScreen, original.visibleOnFullScreen);
    assert.equal(browserViewsOccluded, false);
    browser.setPanelBounds({ threadId, surface: "native", bounds: browserBounds });
    assert.equal(browserView.getVisible(), true);
    assert.equal(await browserContents.executeJavaScript("window.zenSentinel"), "retained");
    assert.equal(await invoke("window.originalEditor === document.querySelector('#draft')"), true);
    assert.equal(
      await invoke("document.querySelector('#draft').value"),
      "retained synthetic draft",
    );
    // A reload must start from normal geometry; this mirrors the main-process exit seam.
    await invoke("window.desktopBridge.zenMode.enter()");
    await invoke("window.desktopBridge.zenMode.setPointerPassthrough(true)");
    if (process.platform === "darwin") {
      await invoke("window.desktopBridge.zenMode.bubble.collapse()");
      await invoke("window.desktopBridge.zenMode.bubble.hide()");
    }
    await manager.resetForRendererReload();
    assert.equal(pointerPassthrough, false, "reload must restore pointer input");
    await window.webContents.reload();
    assert.equal(manager.getState().isActive, false);
    assert.deepEqual(window.getNormalBounds(), original.bounds);
    console.log(
      JSON.stringify({
        passed: true,
        platform: process.platform,
        shortcutRegistered,
        nativeDrag: {
          status: "not-run",
          reason:
            "Requires separate authorized native input and observed window-coordinate changes.",
        },
        checks: [
          "production-preload-ipc",
          "always-on-top",
          "all-workspaces-setting-and-restore",
          "native-pointer-passthrough-and-restore",
          "native-shadow-restore",
          ...(process.platform === "darwin" ? ["transparent-renderer-alpha"] : []),
          ...(process.platform === "darwin" ? ["synthetic-fullscreen-host-focus-and-policy"] : []),
          "content-height",
          "expand-collapse",
          "production-drag-region-ipc",
          "work-area-clamp-and-available-space-bottom-anchor",
          ...(process.platform === "darwin"
            ? [
                "bubble-36px",
                "bubble-hide-and-host-restore",
                "bubble-late-ipc",
                "bubble-panel-geometry",
              ]
            : []),
          "invalid-height",
          "restore",
          "same-editor-draft",
          "browser-occlusion-restore",
          "reload-restore",
        ],
      }),
    );
  } finally {
    await manager.dispose();
    browser.dispose();
    if (!window.isDestroyed()) window.destroy();
    manager.windowClosed();
  }
}

void smoke().then(
  () => {
    clearTimeout(deadline);
    rmSync(profile, { recursive: true, force: true });
    app.exit(0);
  },
  (error) => {
    console.error(error);
    clearTimeout(deadline);
    rmSync(profile, { recursive: true, force: true });
    app.exit(1);
  },
);
