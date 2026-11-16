import type { DesktopBridge } from "@synara/contracts";
import { expect, it, vi } from "vitest";
import { DESKTOP_IPC_CHANNELS } from "./ipcChannels";

const ipc = vi.hoisted(() => ({
  invoke: vi.fn((..._args: unknown[]) => Promise.resolve(undefined)),
  expose: vi.fn((..._args: unknown[]) => undefined),
  sendSync: vi.fn((): unknown => false),
  on: vi.fn((..._args: unknown[]) => undefined),
  removeListener: vi.fn((..._args: unknown[]) => undefined),
  send: vi.fn((..._args: unknown[]) => undefined),
}));
vi.mock("electron", () => ({
  contextBridge: { exposeInMainWorld: ipc.expose },
  ipcRenderer: {
    invoke: ipc.invoke,
    sendSync: ipc.sendSync,
    on: ipc.on,
    send: ipc.send,
    removeListener: ipc.removeListener,
  },
  webUtils: { getPathForFile: vi.fn() },
}));

it("forwards the optional typed language preference through its dedicated IPC channel", async () => {
  await import("./preload");
  const bridge = ipc.expose.mock.calls[0]?.[1] as DesktopBridge;
  await bridge.setLanguagePreference?.("zh-CN");
  expect(ipc.invoke).toHaveBeenCalledWith(DESKTOP_IPC_CHANNELS.setLanguagePreference, "zh-CN");
});

it("reads current native language candidates on every getter call rather than freezing a preload snapshot", async () => {
  let languages = ["en-US"];
  ipc.sendSync.mockImplementation((...args: unknown[]) =>
    args[0] === DESKTOP_IPC_CHANNELS.getSystemLanguages ? languages : false,
  );
  await import("./preload");
  const bridge = ipc.expose.mock.calls[0]?.[1] as DesktopBridge;
  expect(bridge.getSystemLanguages?.()).toEqual(["en-US"]);
  languages = ["zh-Hans-CN", "en-US"];
  expect(bridge.getSystemLanguages?.()).toEqual(["zh-Hans-CN", "en-US"]);
  expect(ipc.sendSync).toHaveBeenLastCalledWith(DESKTOP_IPC_CHANNELS.getSystemLanguages);
});

it("buffers one Zen shortcut toggle until React subscribes, then cleans up the subscriber", async () => {
  await import("./preload");
  const bridge = ipc.expose.mock.calls[0]?.[1] as DesktopBridge;
  const zenMode = bridge.zenMode!;
  ipc.invoke.mockClear();
  await zenMode.getState();
  await zenMode.enter();
  await zenMode.exit();
  await zenMode.setExpanded(true);
  await zenMode.setCompactHeight(145);
  await zenMode.setPointerPassthrough(true);
  expect(ipc.invoke).toHaveBeenNthCalledWith(1, DESKTOP_IPC_CHANNELS.zenMode.getState);
  expect(ipc.invoke).toHaveBeenNthCalledWith(2, DESKTOP_IPC_CHANNELS.zenMode.enter);
  expect(ipc.invoke).toHaveBeenNthCalledWith(3, DESKTOP_IPC_CHANNELS.zenMode.exit);
  expect(ipc.invoke).toHaveBeenNthCalledWith(4, DESKTOP_IPC_CHANNELS.zenMode.setExpanded, true);
  expect(ipc.invoke).toHaveBeenNthCalledWith(5, DESKTOP_IPC_CHANNELS.zenMode.setCompactHeight, 145);
  expect(ipc.invoke).toHaveBeenNthCalledWith(
    6,
    DESKTOP_IPC_CHANNELS.zenMode.setPointerPassthrough,
    true,
  );

  expect(ipc.on).toHaveBeenCalledWith(
    DESKTOP_IPC_CHANNELS.zenMode.toggleRequested,
    expect.any(Function),
  );
  const nativeToggleListener = ipc.on.mock.calls.find(
    ([channel]) => channel === DESKTOP_IPC_CHANNELS.zenMode.toggleRequested,
  )?.[1] as (() => void) | undefined;
  expect(nativeToggleListener).toBeTypeOf("function");

  const stateListener = vi.fn();
  const unsubscribeState = zenMode.onStateChanged(stateListener);
  const stateChangedListener = ipc.on.mock.calls.findLast(
    ([channel]) => channel === DESKTOP_IPC_CHANNELS.zenMode.stateChanged,
  )?.[1] as ((_event: unknown, payload: unknown) => void) | undefined;
  const state = {
    isActive: true,
    expanded: false,
    isBubble: false,
    alwaysOnTop: true,
    shortcut: "CommandOrControl+Shift+Space",
    shortcutAvailable: true,
  };
  stateChangedListener?.({}, state);
  expect(stateListener).toHaveBeenCalledWith(state);
  stateChangedListener?.({}, { ...state, expanded: "invalid" });
  expect(stateListener).toHaveBeenCalledOnce();
  stateChangedListener?.({}, { ...state, isBubble: "invalid" });
  expect(stateListener).toHaveBeenCalledOnce();
  unsubscribeState();
  expect(ipc.removeListener).toHaveBeenCalledWith(
    DESKTOP_IPC_CHANNELS.zenMode.stateChanged,
    stateChangedListener,
  );

  nativeToggleListener?.();
  const firstListener = vi.fn();
  const unsubscribeFirst = zenMode.onToggleRequested(firstListener);
  expect(firstListener).toHaveBeenCalledOnce();
  unsubscribeFirst();
  nativeToggleListener?.();

  const secondListener = vi.fn();
  const unsubscribeSecond = zenMode.onToggleRequested(secondListener);
  expect(secondListener).toHaveBeenCalledOnce();
  nativeToggleListener?.();
  expect(secondListener).toHaveBeenCalledTimes(2);
  expect(firstListener).toHaveBeenCalledOnce();
  unsubscribeSecond();
});

it("exposes an atomic bubble capability only on macOS and forwards drag-region reports", async () => {
  const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
  try {
    for (const platform of ["darwin", "win32", "linux"]) {
      Object.defineProperty(process, "platform", { ...platformDescriptor, value: platform });
      vi.resetModules();
      ipc.expose.mockClear();
      ipc.invoke.mockClear();
      // Platform capabilities are selected at module evaluation, so each host needs a fresh preload.
      await import("./preload");
      const bridge = ipc.expose.mock.calls[0]?.[1] as DesktopBridge;
      const zenMode = bridge.zenMode!;
      const region = { x: 12, y: 100, width: 320, height: 24 };
      await zenMode.setDragRegion(region);
      await zenMode.setDragRegion(null);
      expect(ipc.invoke).toHaveBeenCalledWith(DESKTOP_IPC_CHANNELS.zenMode.setDragRegion, region);
      expect(ipc.invoke).toHaveBeenCalledWith(DESKTOP_IPC_CHANNELS.zenMode.setDragRegion, null);
      if (platform === "darwin") {
        expect(zenMode.bubble).toEqual({
          collapse: expect.any(Function),
          restore: expect.any(Function),
          hide: expect.any(Function),
        });
        await zenMode.bubble!.collapse();
        await zenMode.bubble!.restore();
        await zenMode.bubble!.hide();
        expect(ipc.invoke).toHaveBeenCalledWith(DESKTOP_IPC_CHANNELS.zenMode.collapseToBubble);
        expect(ipc.invoke).toHaveBeenCalledWith(DESKTOP_IPC_CHANNELS.zenMode.restoreFromBubble);
        expect(ipc.invoke).toHaveBeenCalledWith(DESKTOP_IPC_CHANNELS.zenMode.hideBubble);
      } else {
        expect(zenMode.bubble).toBeUndefined();
      }
    }
  } finally {
    Object.defineProperty(process, "platform", platformDescriptor);
  }
});

it("reports viewport changes through the existing zoom channel only while a bubble is active", async () => {
  const addEventListener = vi.fn((_event: string, _listener: () => void) => undefined);
  vi.stubGlobal("addEventListener", addEventListener);
  try {
    vi.resetModules();
    ipc.on.mockClear();
    // The resize subscription belongs to preload evaluation, before any React subscriber.
    await import("./preload");
    const resize = addEventListener.mock.calls.find(([event]) => event === "resize")?.[1];
    const stateChanged = ipc.on.mock.calls.find(
      ([channel]) => channel === DESKTOP_IPC_CHANNELS.zenMode.stateChanged,
    )?.[1] as (_event: unknown, payload: unknown) => void;
    expect(resize).toBeTypeOf("function");
    ipc.sendSync.mockClear();
    resize?.();
    expect(ipc.sendSync).not.toHaveBeenCalled();
    const state = {
      isActive: true,
      isBubble: true,
      expanded: false,
      alwaysOnTop: true,
      shortcut: "CommandOrControl+Shift+Space",
      shortcutAvailable: true,
    };
    stateChanged({}, state);
    resize?.();
    expect(ipc.sendSync).toHaveBeenCalledExactlyOnceWith(DESKTOP_IPC_CHANNELS.zoomFactor);
    stateChanged({}, { ...state, isBubble: false });
    resize?.();
    stateChanged({}, { ...state, isActive: false });
    resize?.();
    expect(ipc.sendSync).toHaveBeenCalledOnce();
  } finally {
    vi.unstubAllGlobals();
  }
});

it("exposes only the schema-bound update edit lease and rejects malformed acknowledgments", async () => {
  vi.resetModules();
  ipc.expose.mockClear();
  ipc.on.mockClear();
  ipc.send.mockClear();
  // Preload exposes the bridge at module evaluation; a static import cannot exercise a fresh IPC binding.
  await import("./preload");
  const bridge = ipc.expose.mock.calls[0]?.[1] as DesktopBridge;
  const maintenance = bridge.updateWindowMaintenance!;
  const listener = vi.fn();
  const unsubscribe = maintenance.onRequest(listener);
  const receive = ipc.on.mock.calls.findLast(
    ([channel]) => channel === DESKTOP_IPC_CHANNELS.updateWindowMaintenanceRequest,
  )?.[1] as (_event: unknown, payload: unknown) => void;
  const request = {
    schemaVersion: 1,
    action: "prepare",
    attemptId: "12345678-1234-4234-8234-123456789012",
    probeId: "22345678-1234-4234-8234-123456789012",
    backendStopped: false,
    manifestDigest: "a".repeat(64),
  };
  receive({}, request);
  expect(listener).toHaveBeenCalledExactlyOnceWith(request);
  receive({}, { ...request, arbitraryPath: "/untrusted" });
  receive({}, { ...request, action: "install" });
  receive({}, { ...request, probeId: undefined });
  receive({}, { ...request, backendStopped: undefined });
  expect(listener).toHaveBeenCalledOnce();
  const response = {
    schemaVersion: 1 as const,
    attemptId: request.attemptId,
    probeId: request.probeId,
    manifestDigest: request.manifestDigest,
    ready: true,
    unsavedEditors: 0,
    savingEditors: 0,
    message: null,
  };
  maintenance.reply(response);
  expect(ipc.send).toHaveBeenCalledExactlyOnceWith(
    DESKTOP_IPC_CHANNELS.updateWindowMaintenanceResponse,
    response,
  );
  Reflect.apply(maintenance.reply, undefined, [{ ...response, unsavedEditors: 1 }]);
  Reflect.apply(maintenance.reply, undefined, [{ ...response, unexpected: true }]);
  Reflect.apply(maintenance.reply, undefined, [{ ...response, probeId: undefined }]);
  expect(ipc.send).toHaveBeenCalledOnce();
  unsubscribe();
  expect(ipc.removeListener).toHaveBeenCalledWith(
    DESKTOP_IPC_CHANNELS.updateWindowMaintenanceRequest,
    receive,
  );
});
