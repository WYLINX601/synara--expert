import type { DesktopBridge } from "@synara/contracts";
import { expect, it, vi } from "vitest";
import { DESKTOP_IPC_CHANNELS } from "./ipcChannels";

const ipc = vi.hoisted(() => ({
  invoke: vi.fn((..._args: unknown[]) => Promise.resolve(undefined)),
  expose: vi.fn((..._args: unknown[]) => undefined),
  sendSync: vi.fn((): unknown => false),
  on: vi.fn((..._args: unknown[]) => undefined),
  removeListener: vi.fn((..._args: unknown[]) => undefined),
}));
vi.mock("electron", () => ({
  contextBridge: { exposeInMainWorld: ipc.expose },
  ipcRenderer: {
    invoke: ipc.invoke,
    sendSync: ipc.sendSync,
    on: ipc.on,
    send: vi.fn(),
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
  const stateChangedListener = ipc.on.mock.calls.find(
    ([channel]) => channel === DESKTOP_IPC_CHANNELS.zenMode.stateChanged,
  )?.[1] as ((_event: unknown, payload: unknown) => void) | undefined;
  const state = {
    isActive: true,
    expanded: false,
    alwaysOnTop: true,
    shortcut: "CommandOrControl+Shift+Space",
    shortcutAvailable: true,
  };
  stateChangedListener?.({}, state);
  expect(stateListener).toHaveBeenCalledWith(state);
  stateChangedListener?.({}, { ...state, expanded: "invalid" });
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
