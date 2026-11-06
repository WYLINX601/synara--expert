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
    ...(process.platform === "darwin" ? { titleBarStyle: "hiddenInset" as const } : {}),
    webPreferences: {
      preload: resolve(process.env.SYNARA_ZEN_SMOKE_PRELOAD ?? "dist-electron/preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  const browser = new DesktopBrowserManager();
  browser.setWindow(window);
  let browserViewsOccluded = false;
  const manager = new ZenModeManager({
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
    assert.deepEqual(manager.getWindowStateForPersistence()?.bounds, original.bounds);
    await invoke("window.desktopBridge.zenMode.setCompactHeight(145)");
    await eventually(() => Math.abs(window.getContentBounds().height - 145) <= 1, "compact height");
    const compact = window.getBounds();
    await invoke("window.desktopBridge.zenMode.setExpanded(true)");
    await eventually(() => window.getContentBounds().height >= 500, "expanded height");
    assert.equal(window.getBounds().x, compact.x);
    assert.equal(window.getBounds().width, compact.width);
    const expanded = window.getBounds();
    await invoke("window.desktopBridge.zenMode.setCompactHeight(180)");
    assert.deepEqual(window.getBounds(), expanded, "expanded geometry must ignore compact updates");
    await invoke("window.desktopBridge.zenMode.setExpanded(false)");
    await eventually(
      () => Math.abs(window.getContentBounds().height - 180) <= 1,
      "cached compact height",
    );
    await assert.rejects(invoke("window.desktopBridge.zenMode.setCompactHeight(NaN)"));
    await invoke("window.desktopBridge.zenMode.exit()");
    await eventually(() => window.getBounds().width === original.bounds.width, "restored width");
    assert.deepEqual(window.getNormalBounds(), original.bounds);
    assert.deepEqual(window.getMinimumSize(), original.minimum);
    assert.deepEqual(window.getMaximumSize(), original.maximum);
    assert.equal(window.isAlwaysOnTop(), original.pinned);
    assert.equal(window.isResizable(), original.resizable);
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
    await manager.resetForRendererReload();
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
          "content-height",
          "expand-collapse",
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
