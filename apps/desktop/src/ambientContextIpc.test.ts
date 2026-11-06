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
  const approveConnection = vi.fn(async () => ({}));
  const revokeConnection = vi.fn(async () => ({}));
  const capture = vi.fn(async () => ({}));
  const context = {
    pairing,
    approveConnection,
    revokeConnection,
    capture,
  } as unknown as DesktopAmbientContext;
  const frame = {};
  const sender = { id: 1, mainFrame: frame };
  registerAmbientContextIpc(ipc, context, (event) => event.sender.id === 1);
  expect(handlers.size).toBe(7);
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
  await handlers.get(DESKTOP_IPC_CHANNELS.ambientContext.approveConnection)!(
    { sender, senderFrame: frame } as unknown as IpcMainInvokeEvent,
    "vault-1",
  );
  expect(approveConnection).toHaveBeenCalledWith("vault-1");
  await handlers.get(DESKTOP_IPC_CHANNELS.ambientContext.revokeConnection)!(
    { sender, senderFrame: frame } as unknown as IpcMainInvokeEvent,
    "vault-1",
  );
  expect(revokeConnection).toHaveBeenCalledWith("vault-1");
  await handlers.get(DESKTOP_IPC_CHANNELS.ambientContext.capture)!(
    { sender, senderFrame: frame } as unknown as IpcMainInvokeEvent,
    ["vault-1"],
  );
  expect(capture).toHaveBeenCalledWith(["vault-1"], undefined);
  const captureOptions = { includeFullTextSourceIds: ["vault-1"] };
  await handlers.get(DESKTOP_IPC_CHANNELS.ambientContext.capture)!(
    { sender, senderFrame: frame } as unknown as IpcMainInvokeEvent,
    ["vault-1"],
    captureOptions,
  );
  expect(capture).toHaveBeenLastCalledWith(["vault-1"], captureOptions);
  expect(() =>
    handlers.get(DESKTOP_IPC_CHANNELS.ambientContext.capture)!(
      { sender, senderFrame: frame } as unknown as IpcMainInvokeEvent,
      [1],
    ),
  ).toThrow("Invalid Obsidian context selection");
});
