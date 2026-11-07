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
import { ZenModeManager } from "../src/zenModeManager";
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
  try {
    await window.loadURL(
      `data:text/html,${encodeURIComponent("<title>Zen isolated smoke</title><textarea id='draft'>retained synthetic draft</textarea>")}`,
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
    const compact = window.getBounds();
    // Native drag regions move this same window; disclosure must retain the new anchor.
    const workArea = screen.getDisplayMatching(compact).workArea;
    window.setBounds({
      ...compact,
      x: Math.min(compact.x + 16, workArea.x + workArea.width - compact.width),
      y: Math.max(workArea.y, workArea.y + workArea.height - compact.height - 24),
    });
    const moved = window.getBounds();
    await invoke("window.desktopBridge.zenMode.setExpanded(true)");
    await eventually(() => window.getContentBounds().height >= 500, "expanded height");
    assert.equal(window.getBounds().x, moved.x);
    assert.equal(window.getBounds().width, moved.width);
    assert.equal(
      window.getBounds().y + window.getBounds().height,
      moved.y + moved.height,
      "drawer keeps the dragged window's bottom anchor",
    );
    const expanded = window.getBounds();
    await invoke("window.desktopBridge.zenMode.setCompactHeight(180)");
    assert.deepEqual(window.getBounds(), expanded, "expanded geometry must ignore compact updates");
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
          "moved-window-bottom-anchor",
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
