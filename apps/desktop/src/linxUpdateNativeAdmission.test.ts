import type { IpcMain, Menu } from "electron";
import { describe, expect, it, vi } from "vitest";
import {
  LinxUpdateNativeAdmission,
  createLinxUpdateNativeIpc,
  freezeLinxUpdateNativeMenu,
} from "./linxUpdateNativeAdmission";

describe("Linx native mutation admission", () => {
  it("freezes native edit role menus and restores each prior enabled state on abort", () => {
    const undo = { role: "undo", enabled: true };
    const paste = { role: "pasteAndMatchStyle", enabled: true };
    const cut = { role: "cut", enabled: false };
    const copy = { role: "copy", enabled: true };
    const reload = { role: "reload", enabled: true };
    // Structural menu fixture intentionally supplies only the role/admission API.
    const menu = {
      items: [
        { role: "editMenu", enabled: true, submenu: { items: [undo, paste, cut, copy] } },
        reload,
      ],
    } as unknown as Menu;
    const restore = freezeLinxUpdateNativeMenu(menu);
    expect(undo.enabled).toBe(false);
    expect(paste.enabled).toBe(false);
    expect(cut.enabled).toBe(false);
    expect(copy.enabled).toBe(true);
    expect(reload.enabled).toBe(false);
    restore();
    expect(undo.enabled).toBe(true);
    expect(paste.enabled).toBe(true);
    expect(cut.enabled).toBe(false);
    expect(copy.enabled).toBe(true);
    expect(reload.enabled).toBe(true);
    restore();
    expect(undo.enabled).toBe(true);
  });

  it("tracks accepted async native work until real settlement and refuses newly held work", async () => {
    let held = false;
    const admission = new LinxUpdateNativeAdmission(() => held);
    const pending = Promise.withResolvers<void>();
    const accepted = admission.run(() => pending.promise);
    expect(admission.busy).toBe(true);
    held = true;
    const forbidden = vi.fn();
    await expect(admission.run(forbidden)).rejects.toThrow("frozen");
    expect(forbidden).not.toHaveBeenCalled();
    expect(admission.busy).toBe(true);
    pending.resolve();
    await accepted;
    expect(admission.busy).toBe(false);
    held = false;
    await admission.run(forbidden);
    expect(forbidden).toHaveBeenCalledOnce();
  });

  it("releases failed accepted work without leaking an installed-idle unknown state", async () => {
    const admission = new LinxUpdateNativeAdmission(() => false);
    await expect(
      admission.run(() => {
        throw new Error("native refusal");
      }),
    ).rejects.toThrow("native refusal");
    expect(admission.busy).toBe(false);
  });

  it("wraps only application registrations and leaves the global IPC singleton unchanged", async () => {
    let held = false;
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const listeners = new Map<string, (...args: unknown[]) => unknown>();
    const ipc = {
      handle: vi.fn((channel, handler) => handlers.set(channel, handler)),
      on: vi.fn((channel, handler) => listeners.set(channel, handler)),
    };
    const originalHandle = ipc.handle;
    const admission = new LinxUpdateNativeAdmission(() => held);
    const proxy = createLinxUpdateNativeIpc({
      ipc: ipc as unknown as IpcMain,
      admission,
      held: () => held,
      exempt: new Set(["install", "response"]),
    });
    const write = vi.fn(async () => "saved");
    const install = vi.fn(async () => "accepted");
    const event = vi.fn();
    proxy.handle("write", write);
    proxy.handle("install", install);
    proxy.on("event", event);
    proxy.on("response", event);
    held = true;
    await expect(handlers.get("write")!({})).rejects.toThrow("frozen");
    await expect(handlers.get("install")!({})).resolves.toBe("accepted");
    const refusedEvent = { returnValue: undefined };
    listeners.get("event")!(refusedEvent);
    expect(refusedEvent.returnValue).toBeNull();
    expect(event).not.toHaveBeenCalled();
    listeners.get("response")!({});
    expect(event).toHaveBeenCalledOnce();
    expect(ipc.handle).toBe(originalHandle);
    held = false;
    await expect(handlers.get("write")!({})).resolves.toBe("saved");
    expect(write).toHaveBeenCalledOnce();
  });
});
