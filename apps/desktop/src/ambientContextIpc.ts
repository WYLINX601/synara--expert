import type { IpcMain, IpcMainInvokeEvent } from "electron";
import { DESKTOP_IPC_CHANNELS } from "./ipcChannels";
import type { DesktopAmbientContext } from "./ambientContext/DesktopAmbientContext";

export function registerAmbientContextIpc(
  ipc: IpcMain,
  context: DesktopAmbientContext,
  isTrustedRenderer: (event: IpcMainInvokeEvent) => boolean,
): void {
  const channels = DESKTOP_IPC_CHANNELS.ambientContext;
  const handlers: Array<[string, (...args: unknown[]) => Promise<unknown>]> = [
    [channels.getState, () => context.getState()],
    [channels.configure, (sourceId, policy) => context.configure(sourceId, policy)],
    [channels.getPairing, (sourceId) => context.pairing(sourceId)],
    [channels.capture, () => context.capture()],
    [channels.searchResources, (query) => context.searchResources(query)],
  ];
  for (const [channel, handler] of handlers) {
    ipc.removeHandler(channel);
    ipc.handle(channel, (event, ...args: unknown[]) => {
      if (!isTrustedRenderer(event) || event.senderFrame !== event.sender.mainFrame) {
        throw new Error("Ambient context requires the trusted Synara window.");
      }
      return handler(...args);
    });
  }
}
