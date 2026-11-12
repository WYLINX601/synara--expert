import type { IpcMain, IpcMainInvokeEvent } from "electron";
import type { ZenModeDragRegion } from "@synara/contracts";
import { DESKTOP_IPC_CHANNELS } from "./ipcChannels";
import type { ZenModeManager } from "./zenModeManager";

export function registerZenModeIpc(
  ipc: IpcMain,
  manager: ZenModeManager,
  isTrustedRenderer: (event: IpcMainInvokeEvent) => boolean,
): void {
  const channels = DESKTOP_IPC_CHANNELS.zenMode;
  const handlers: Array<[string, (event: IpcMainInvokeEvent, value?: unknown) => unknown]> = [
    [channels.getState, () => manager.getState()],
    [channels.enter, () => manager.enter()],
    [channels.exit, () => manager.exit()],
    [channels.collapseToBubble, () => manager.collapseToBubble()],
    [channels.restoreFromBubble, () => manager.restoreFromBubble()],
    [channels.hideBubble, () => manager.hideBubble()],
    [
      channels.setExpanded,
      (_event, expanded) => {
        if (typeof expanded !== "boolean") throw new Error("Invalid Zen mode expansion state.");
        return manager.setExpanded(expanded);
      },
    ],
    [
      channels.setCompactHeight,
      (_event, contentHeight) => {
        if (typeof contentHeight !== "number" || !Number.isFinite(contentHeight)) {
          throw new Error("Invalid Zen mode content height.");
        }
        return manager.setCompactHeight(contentHeight);
      },
    ],
    [
      channels.setPointerPassthrough,
      (_event, ignore) => {
        if (typeof ignore !== "boolean")
          throw new Error("Invalid Zen mode pointer passthrough state.");
        return manager.setPointerPassthrough(ignore);
      },
    ],
    [
      channels.setDragRegion,
      (_event, region) => {
        if (region === null) return manager.setDragRegion(null);
        if (!region || typeof region !== "object") throw new Error("Invalid Zen mode drag region.");
        const value = region as Record<string, unknown>;
        if (
          !["x", "y", "width", "height"].every(
            (key) => typeof value[key] === "number" && Number.isFinite(value[key]),
          ) ||
          (value.width as number) <= 0 ||
          (value.height as number) <= 0
        )
          throw new Error("Invalid Zen mode drag region.");
        return manager.setDragRegion(region as ZenModeDragRegion);
      },
    ],
  ];

  for (const [channel, handler] of handlers) {
    ipc.removeHandler(channel);
    ipc.handle(channel, (event, value?: unknown) => {
      if (!isTrustedRenderer(event) || event.senderFrame !== event.sender.mainFrame) {
        throw new Error("Zen mode requires the trusted Synara window.");
      }
      return handler(event, value);
    });
  }
}
