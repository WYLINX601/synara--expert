import { EventEmitter } from "node:events";
import type { BrowserWindow, IpcMainEvent } from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { ipc } = vi.hoisted(() => ({ ipc: { on: vi.fn(), off: vi.fn() } }));
vi.mock("electron", () => ({ ipcMain: ipc }));
vi.mock("./i18n", () => ({ t: (key: string) => key }));
import { LinxUpdateWindowMaintenance } from "./linxUpdateWindowMaintenance";
import { DESKTOP_IPC_CHANNELS } from "./ipcChannels";

const attemptId = "12345678-1234-4234-8234-123456789012";
const digest = "a".repeat(64);
const coordinators: LinxUpdateWindowMaintenance[] = [];
function fakeWindow() {
  const contents = Object.assign(new EventEmitter(), {
    mainFrame: {},
    send: vi.fn(),
    isDestroyed: () => false,
    isLoadingMainFrame: (): boolean => false,
  });
  const window = Object.assign(new EventEmitter(), {
    webContents: contents,
    isDestroyed: () => false,
  });
  return { window, managed: window as unknown as BrowserWindow, contents };
}
function setup(count = 1) {
  const windows = Array.from({ length: count }, fakeWindow);
  const managed = windows.map((entry) => entry.managed);
  let trusted = true;
  const coordinator = new LinxUpdateWindowMaintenance({
    getManagedWindows: () => managed,
    isTrustedSender: () => trusted,
    timeoutMs: 100,
  });
  coordinators.push(coordinator);
  const receive = ipc.on.mock.calls.findLast(
    (call) => call[0] === DESKTOP_IPC_CHANNELS.updateWindowMaintenanceResponse,
  )![1] as (event: IpcMainEvent, response: unknown) => void;
  const reply = (index = 0, overrides = {}, frame: unknown = windows[index]!.contents.mainFrame) =>
    receive(
      {
        sender: windows[index]!.contents,
        senderFrame: frame,
      } as unknown as IpcMainEvent,
      {
        schemaVersion: 1,
        attemptId,
        manifestDigest: digest,
        probeId: windows[index]!.contents.send.mock.lastCall?.[1].probeId,
        ready: true,
        unsavedEditors: 0,
        savingEditors: 0,
        message: null,
        ...overrides,
      },
    );
  return {
    coordinator,
    windows,
    managed,
    reply,
    setTrusted: (value: boolean) => {
      trusted = value;
    },
  };
}
beforeEach(() => {
  vi.useFakeTimers();
  ipc.on.mockClear();
  ipc.off.mockClear();
});
afterEach(() => {
  for (const coordinator of coordinators.splice(0)) coordinator.dispose();
  vi.useRealTimers();
});

describe("all-window installation lease", () => {
  it("requires every managed window and holds keyboard input until release", async () => {
    const f = setup(2);
    const pending = f.coordinator.prepare(attemptId, digest);
    let ready = false;
    void pending.then((result) => {
      ready = result.ready;
    });
    f.reply(0);
    await Promise.resolve();
    expect(ready).toBe(false);
    f.reply(1);
    await expect(pending).resolves.toEqual({ ready: true, message: null });
    const preventDefault = vi.fn();
    f.windows[0]!.contents.emit("before-input-event", { preventDefault });
    expect(preventDefault).toHaveBeenCalledOnce();
    f.coordinator.release(attemptId);
    expect(f.windows[0]!.contents.listenerCount("before-input-event")).toBe(0);
    expect(f.windows[1]!.contents.send).toHaveBeenLastCalledWith(
      DESKTOP_IPC_CHANNELS.updateWindowMaintenanceRequest,
      expect.objectContaining({ action: "release", attemptId, manifestDigest: digest }),
    );
  });

  it("rejects dirty or saving editor acknowledgments without retaining a lease", async () => {
    const f = setup();
    const pending = f.coordinator.prepare(attemptId, digest);
    f.reply(0, { ready: false, unsavedEditors: 1, savingEditors: 1, message: "Save work first" });
    await expect(pending).resolves.toEqual({ ready: false, message: "Save work first" });
    expect(f.windows[0]!.contents.listenerCount("before-input-event")).toBe(0);
  });

  it("ignores untrusted senders, subframes, changed digests and late replies", async () => {
    const f = setup();
    const pending = f.coordinator.prepare(attemptId, digest);
    f.setTrusted(false);
    f.reply();
    f.setTrusted(true);
    f.reply(0, {}, {});
    f.reply(0, { manifestDigest: "b".repeat(64) });
    await vi.advanceTimersByTimeAsync(101);
    await expect(pending).resolves.toMatchObject({ ready: false });
    f.reply();
    await expect(f.coordinator.prepare(attemptId, digest)).resolves.toMatchObject({ ready: false });
    expect(f.windows[0]!.contents.listenerCount("before-input-event")).toBe(0);
  });

  it("invalidates readiness when window membership changes after acknowledgment", async () => {
    const f = setup();
    const first = f.coordinator.prepare(attemptId, digest);
    f.reply();
    await expect(first).resolves.toMatchObject({ ready: true });
    f.managed.push(fakeWindow().managed);
    await expect(f.coordinator.prepare(attemptId, digest)).resolves.toMatchObject({ ready: false });
    expect(f.windows[0]!.contents.listenerCount("before-input-event")).toBe(0);
  });

  it("binds the main-frame generation and refuses navigation before handoff", async () => {
    const f = setup();
    const pending = f.coordinator.prepare(attemptId, digest);
    f.windows[0]!.contents.mainFrame = {};
    f.reply();
    await expect(pending).resolves.toMatchObject({ ready: false });
  });

  it("releases the old lease but never switches an attempt to another target", async () => {
    const f = setup();
    const first = f.coordinator.prepare(attemptId, digest);
    await expect(f.coordinator.prepare(attemptId, "b".repeat(64))).resolves.toMatchObject({
      ready: false,
    });
    await expect(first).resolves.toMatchObject({ ready: false });
    f.reply();
    await expect(f.coordinator.prepare(attemptId, digest)).resolves.toMatchObject({ ready: false });
  });

  it("refuses a missing renderer rather than using ordinary quit's permissive fallback", async () => {
    const f = setup(0);
    await expect(f.coordinator.prepare(attemptId, digest)).resolves.toMatchObject({ ready: false });
  });
  it("refuses unknown managed-window state without crashing the main process", async () => {
    const coordinator = new LinxUpdateWindowMaintenance({
      getManagedWindows: () => {
        throw new Error("Window registry unavailable");
      },
      isTrustedSender: () => true,
    });
    coordinators.push(coordinator);
    await expect(coordinator.prepare(attemptId, digest)).resolves.toMatchObject({ ready: false });
    expect(coordinator.held).toBe(false);
  });

  it.each(["loading", "detached"] as const)(
    "revokes the final held proof synchronously for a %s main frame",
    async (change) => {
      const f = setup();
      const ready = f.coordinator.prepare(attemptId, digest);
      f.reply();
      await expect(ready).resolves.toMatchObject({ ready: true });
      if (change === "loading") f.windows[0]!.contents.isLoadingMainFrame = () => true;
      else Object.assign(f.windows[0]!.contents.mainFrame, { detached: true });
      expect(f.coordinator.held).toBe(false);
      expect(f.windows[0]!.contents.listenerCount("before-input-event")).toBe(0);
      f.reply();
      await expect(f.coordinator.prepare(attemptId, digest)).resolves.toMatchObject({
        ready: false,
      });
    },
  );

  it("invalidates every window when a renderer revokes its durable readiness after all acknowledgments", async () => {
    const f = setup(2);
    const ready = f.coordinator.prepare(attemptId, digest);
    f.reply(0);
    f.reply(1);
    await expect(ready).resolves.toMatchObject({ ready: true });
    f.reply(1, { ready: false, message: "Persistence changed" });
    expect(f.coordinator.held).toBe(false);
    for (const window of f.windows) {
      expect(window.contents.listenerCount("before-input-event")).toBe(0);
      expect(window.contents.send).toHaveBeenLastCalledWith(
        DESKTOP_IPC_CHANNELS.updateWindowMaintenanceRequest,
        expect.objectContaining({ action: "release" }),
      );
    }
    f.reply(0);
    f.reply(1);
    await expect(f.coordinator.prepare(attemptId, digest)).resolves.toMatchObject({ ready: false });
  });

  it("refuses membership replacement while replies are outstanding and releases the surviving windows", async () => {
    const f = setup(2);
    const pending = f.coordinator.prepare(attemptId, digest);
    f.reply(0);
    f.managed.splice(1, 1, fakeWindow().managed);
    f.reply(1);
    await expect(pending).resolves.toMatchObject({ ready: false });
    expect(f.coordinator.held).toBe(false);
    expect(f.windows[0]!.contents.listenerCount("before-input-event")).toBe(0);
  });
});

it("takes a fresh all-window proof on each prepare and ignores old positive and negative replies", async () => {
  const f = setup(2);
  const first = f.coordinator.prepare(attemptId, digest);
  const oldProbe = f.windows[0]!.contents.send.mock.lastCall?.[1].probeId;
  f.reply(0);
  f.reply(1);
  await expect(first).resolves.toMatchObject({ ready: true });
  const second = f.coordinator.prepare(attemptId, digest);
  const newProbe = f.windows[0]!.contents.send.mock.lastCall?.[1].probeId;
  expect(newProbe).not.toBe(oldProbe);
  let settled = false;
  void second.then(() => {
    settled = true;
  });
  f.reply(0, { probeId: oldProbe });
  f.reply(1, { probeId: oldProbe, ready: false, message: "Late retired refusal" });
  await Promise.resolve();
  expect(settled).toBe(false);
  expect(f.coordinator.held).toBe(true);
  f.reply(0);
  await Promise.resolve();
  expect(settled).toBe(false);
  f.reply(1);
  await expect(second).resolves.toMatchObject({ ready: true });
  expect(f.windows[0]!.contents.listenerCount("before-input-event")).toBe(1);
  f.coordinator.release(attemptId);
  expect(f.windows[0]!.contents.send).toHaveBeenLastCalledWith(
    DESKTOP_IPC_CHANNELS.updateWindowMaintenanceRequest,
    expect.objectContaining({ action: "release", probeId: newProbe }),
  );
});

it("retires an outstanding proof without losing the target lease when a newer prepare supersedes it", async () => {
  const f = setup(2);
  const first = f.coordinator.prepare(attemptId, digest);
  const oldProbe = f.windows[0]!.contents.send.mock.lastCall?.[1].probeId;
  f.reply(0);
  const second = f.coordinator.prepare(attemptId, digest);
  await expect(first).resolves.toMatchObject({ ready: false });
  f.reply(1, { probeId: oldProbe });
  expect(f.coordinator.held).toBe(true);
  f.reply(0);
  f.reply(1);
  await expect(second).resolves.toMatchObject({ ready: true });
});

it("permits a stopped-backend proof only after an existing connected lease and never downgrades that lease", async () => {
  const withoutLease = setup();
  await expect(
    withoutLease.coordinator.prepare(attemptId, digest, { backendStopped: true }),
  ).resolves.toMatchObject({ ready: false });
  expect(withoutLease.windows[0]!.contents.send).not.toHaveBeenCalled();
  const f = setup();
  const first = f.coordinator.prepare(attemptId, digest);
  f.reply();
  await expect(first).resolves.toMatchObject({ ready: true });
  const final = f.coordinator.prepare(attemptId, digest, { backendStopped: true });
  expect(f.windows[0]!.contents.send).toHaveBeenLastCalledWith(
    DESKTOP_IPC_CHANNELS.updateWindowMaintenanceRequest,
    expect.objectContaining({ backendStopped: true }),
  );
  f.reply();
  await expect(final).resolves.toMatchObject({ ready: true });
  await expect(f.coordinator.prepare(attemptId, digest)).resolves.toMatchObject({ ready: false });
  expect(f.coordinator.held).toBe(false);
});

it("releases each renderer's delivered probe if broadcasting a newer proof fails midway", async () => {
  const f = setup(2);
  const first = f.coordinator.prepare(attemptId, digest);
  const oldProbe = f.windows[0]!.contents.send.mock.lastCall?.[1].probeId;
  f.reply(0);
  f.reply(1);
  await expect(first).resolves.toMatchObject({ ready: true });
  f.windows[1]!.contents.send.mockImplementationOnce(() => {
    throw new Error("Renderer IPC gone");
  });
  await expect(f.coordinator.prepare(attemptId, digest)).resolves.toMatchObject({ ready: false });
  const firstRelease = f.windows[0]!.contents.send.mock.lastCall?.[1];
  const secondRelease = f.windows[1]!.contents.send.mock.lastCall?.[1];
  expect(firstRelease.action).toBe("release");
  expect(firstRelease.probeId).not.toBe(oldProbe);
  expect(secondRelease).toMatchObject({ action: "release", probeId: oldProbe });
  expect(f.coordinator.held).toBe(false);
});
