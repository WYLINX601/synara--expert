import { expect, it, vi } from "vitest";
import type { IpcMain, IpcMainInvokeEvent } from "electron";
import type { DesktopAmbientContext } from "./ambientContext/DesktopAmbientContext";
import { registerAmbientContextIpc } from "./ambientContextIpc";
import { DESKTOP_IPC_CHANNELS } from "./ipcChannels";

it("restricts every context endpoint, including pairing, to the trusted top-level renderer", async () => {
  const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>();
  const ipc = {
    removeHandler: vi.fn(),
    handle: (
      channel: string,
      handler: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown,
    ) => handlers.set(channel, handler),
  } as unknown as IpcMain;
  const pairing = vi.fn(async () => ({ endpoint: "local", token: "secret" }));
  const context = { pairing } as unknown as DesktopAmbientContext;
  const frame = {};
  const sender = { id: 1, mainFrame: frame };
  registerAmbientContextIpc(ipc, context, (event) => event.sender.id === 1);
  expect(handlers.size).toBe(5);
  for (const handler of handlers.values()) {
    expect(() =>
      handler({
        sender: { id: 2, mainFrame: frame },
        senderFrame: frame,
      } as unknown as IpcMainInvokeEvent),
    ).toThrow();
    expect(() => handler({ sender, senderFrame: {} } as unknown as IpcMainInvokeEvent)).toThrow();
  }
  expect(pairing).not.toHaveBeenCalled();
  await handlers.get(DESKTOP_IPC_CHANNELS.ambientContext.getPairing)!(
    { sender, senderFrame: frame } as unknown as IpcMainInvokeEvent,
    "obsidian",
  );
  expect(pairing).toHaveBeenCalledWith("obsidian");
});
