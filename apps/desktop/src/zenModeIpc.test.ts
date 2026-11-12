import type { IpcMain, IpcMainInvokeEvent } from "electron";
import { describe, expect, it, vi } from "vitest";
import type { ZenModeState } from "@synara/contracts";
import { DESKTOP_IPC_CHANNELS } from "./ipcChannels";
import { registerZenModeIpc } from "./zenModeIpc";
import type { ZenModeManager } from "./zenModeManager";

type Handler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;

describe("Zen mode IPC", () => {
  it("requires the trusted main frame and validates measured content height", async () => {
    const handlers = new Map<string, Handler>();
    const ipc = {
      removeHandler: vi.fn((channel: string) => handlers.delete(channel)),
      handle: vi.fn((channel: string, handler: Handler) => handlers.set(channel, handler)),
    };
    const state: ZenModeState = {
      isActive: false,
      isBubble: false,
      expanded: false,
      alwaysOnTop: false,
      shortcut: "CommandOrControl+Shift+Space",
      shortcutAvailable: true,
    };
    const manager = {
      getState: vi.fn(() => state),
      enter: vi.fn(async () => undefined),
      exit: vi.fn(async () => undefined),
      setExpanded: vi.fn(async () => undefined),
      setCompactHeight: vi.fn(async () => undefined),
      setPointerPassthrough: vi.fn(async () => undefined),
      setDragRegion: vi.fn(async () => undefined),
      collapseToBubble: vi.fn(async () => undefined),
      restoreFromBubble: vi.fn(async () => undefined),
      hideBubble: vi.fn(async () => undefined),
    };
    registerZenModeIpc(
      ipc as unknown as IpcMain,
      manager as unknown as ZenModeManager,
      (event) => event.sender.id === 1,
    );

    const channels = DESKTOP_IPC_CHANNELS.zenMode;
    expect(handlers.size).toBe(10);
    const frame = {};
    const trusted = {
      sender: { id: 1, mainFrame: frame },
      senderFrame: frame,
    } as unknown as IpcMainInvokeEvent;
    const channelsToCheck = Object.entries(channels)
      .filter(([key]) => key !== "stateChanged" && key !== "toggleRequested")
      .map(([, channel]) => channel);
    for (const channel of channelsToCheck) {
      const handler = handlers.get(channel)!;
      expect(() =>
        handler({
          sender: { id: 9, mainFrame: frame },
          senderFrame: frame,
        } as unknown as IpcMainInvokeEvent),
      ).toThrow("trusted Synara window");
      expect(() => handler({ ...trusted, senderFrame: {} } as IpcMainInvokeEvent)).toThrow(
        "trusted Synara window",
      );
    }
    expect(manager.getState).not.toHaveBeenCalled();
    expect(manager.enter).not.toHaveBeenCalled();
    expect(manager.exit).not.toHaveBeenCalled();

    expect(handlers.get(channels.getState)!(trusted)).toEqual(state);
    await expect(handlers.get(channels.enter)!(trusted)).resolves.toBeUndefined();
    await expect(handlers.get(channels.exit)!(trusted)).resolves.toBeUndefined();
    await expect(handlers.get(channels.setExpanded)!(trusted, true)).resolves.toBeUndefined();
    await expect(handlers.get(channels.setCompactHeight)!(trusted, 160)).resolves.toBeUndefined();
    await expect(
      handlers.get(channels.setPointerPassthrough)!(trusted, true),
    ).resolves.toBeUndefined();
    expect(manager.setExpanded).toHaveBeenCalledWith(true);
    expect(manager.setCompactHeight).toHaveBeenCalledWith(160);

    for (const invalid of [Number.NaN, Number.POSITIVE_INFINITY, "160", null]) {
      expect(() => handlers.get(channels.setCompactHeight)!(trusted, invalid)).toThrow(
        "Invalid Zen mode content height",
      );
    }
    expect(manager.setCompactHeight).toHaveBeenCalledTimes(1);
    expect(manager.setPointerPassthrough).toHaveBeenCalledWith(true);

    for (const invalid of [1, "true", null]) {
      expect(() => handlers.get(channels.setPointerPassthrough)!(trusted, invalid)).toThrow(
        "Invalid Zen mode pointer passthrough state",
      );
    }
    expect(manager.setPointerPassthrough).toHaveBeenCalledTimes(1);

    const region = { x: 20, y: 120, width: 400, height: 24 };
    await expect(handlers.get(channels.setDragRegion)!(trusted, region)).resolves.toBeUndefined();
    expect(manager.setDragRegion).toHaveBeenLastCalledWith(region);
    await expect(handlers.get(channels.setDragRegion)!(trusted, null)).resolves.toBeUndefined();
    expect(manager.setDragRegion).toHaveBeenLastCalledWith(null);
    for (const invalid of [
      undefined,
      false,
      "rect",
      {},
      { ...region, width: 0 },
      { ...region, height: -1 },
      { ...region, x: Number.NaN },
      { ...region, y: Number.POSITIVE_INFINITY },
      { ...region, width: "400" },
    ]) {
      expect(() => handlers.get(channels.setDragRegion)!(trusted, invalid)).toThrow(
        "Invalid Zen mode drag region",
      );
    }
    expect(manager.setDragRegion).toHaveBeenCalledTimes(2);
    await expect(handlers.get(channels.collapseToBubble)!(trusted)).resolves.toBeUndefined();
    await expect(handlers.get(channels.restoreFromBubble)!(trusted)).resolves.toBeUndefined();
    await expect(handlers.get(channels.hideBubble)!(trusted)).resolves.toBeUndefined();
    expect(manager.collapseToBubble).toHaveBeenCalledOnce();
    expect(manager.restoreFromBubble).toHaveBeenCalledOnce();
    expect(manager.hideBubble).toHaveBeenCalledOnce();
  });
});
