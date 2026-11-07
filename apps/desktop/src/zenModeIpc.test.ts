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
    };
    registerZenModeIpc(
      ipc as unknown as IpcMain,
      manager as unknown as ZenModeManager,
      (event) => event.sender.id === 1,
    );

    const channels = DESKTOP_IPC_CHANNELS.zenMode;
    expect(handlers.size).toBe(6);
    const frame = {};
    const trusted = {
      sender: { id: 1, mainFrame: frame },
      senderFrame: frame,
    } as unknown as IpcMainInvokeEvent;
    const channelsToCheck = [
      channels.getState,
      channels.enter,
      channels.exit,
      channels.setExpanded,
      channels.setCompactHeight,
      channels.setPointerPassthrough,
    ];
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
  });
});
