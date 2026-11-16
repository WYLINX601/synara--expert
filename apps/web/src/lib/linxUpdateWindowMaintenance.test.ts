import { describe, expect, it, vi } from "vitest";
import type { LinxUpdateWindowMaintenanceRequest } from "@synara/contracts";
vi.mock("~/i18n", () => ({ t: (key: string) => key }));
vi.mock("~/store", () => ({ useStore: { getState: vi.fn() } }));
vi.mock("./workspaceEditorSession", () => ({
  freezeWorkspaceEditorsForUpdate: vi.fn(),
  releaseWorkspaceEditorsForUpdate: vi.fn(),
  workspaceEditorMaintenanceSnapshot: vi.fn(),
}));
vi.mock("./runningChatsQuitConfirmation", () => ({ listRunningChatsFromDesktopStore: vi.fn() }));
import { createRendererMaintenanceHandler } from "./linxUpdateWindowMaintenance";

const durable = () => ({ pendingWrites: 0, transientAttachments: 0, hydrated: true });
const request: LinxUpdateWindowMaintenanceRequest = {
  schemaVersion: 1,
  action: "prepare",
  attemptId: "12345678-1234-4234-8234-123456789012",
  probeId: "22345678-1234-4234-8234-123456789012",
  backendStopped: false,
  manifestDigest: "a".repeat(64),
};
function setup(editors = { unsavedEditors: 0, savingEditors: 0 }, chats = 0) {
  const release = vi.fn();
  const freeze = vi.fn(() => release);
  const reply = vi.fn();
  const handler = createRendererMaintenanceHandler({
    freeze,
    editors: () => editors,
    runningChats: () => chats,
    persistence: durable,
    connected: () => true,
    reply,
    message: (reason) => reason,
  });
  return { handler, release, freeze, reply };
}

describe("renderer maintenance is not ordinary quit", () => {
  it.each([
    { unsavedEditors: 1, savingEditors: 0 },
    { unsavedEditors: 0, savingEditors: 1 },
  ])(
    "refuses dirty/saving buffers immediately, without invoking save or stopping chats",
    (editors) => {
      const f = setup(editors);
      f.handler.handle(request);
      expect(f.reply).toHaveBeenLastCalledWith(
        expect.objectContaining({ ready: false, ...editors, message: "editors" }),
      );
      expect(f.release).toHaveBeenCalledOnce();
    },
  );

  it("refuses running chats rather than presenting the ordinary stop-and-quit dialog", () => {
    const f = setup(undefined, 1);
    f.handler.handle(request);
    expect(f.reply).toHaveBeenLastCalledWith(
      expect.objectContaining({ ready: false, message: "chats" }),
    );
    expect(f.release).toHaveBeenCalledOnce();
  });

  it("freezes before reading editors and keeps input frozen until exact release", () => {
    const release = vi.fn();
    const order: string[] = [];
    const handler = createRendererMaintenanceHandler({
      freeze: () => {
        order.push("freeze");
        return release;
      },
      editors: () => {
        order.push("inspect");
        return { unsavedEditors: 0, savingEditors: 0 };
      },
      persistence: durable,
      connected: () => true,
      runningChats: () => 0,
      reply: () => {
        order.push("reply");
      },
      message: (reason) => reason,
    });
    handler.handle(request);
    expect(order).toEqual(["freeze", "inspect", "reply"]);
    expect(release).not.toHaveBeenCalled();
    handler.handle({ ...request, action: "release", manifestDigest: "b".repeat(64) });
    expect(release).not.toHaveBeenCalled();
    handler.handle({ ...request, action: "release" });
    expect(release).toHaveBeenCalledOnce();
  });

  it("does not revive a failed attempt after the user later finishes saving", () => {
    const editors = { unsavedEditors: 1, savingEditors: 0 };
    const f = setup(editors);
    f.handler.handle(request);
    editors.unsavedEditors = 0;
    f.handler.handle(request);
    expect(f.reply).toHaveBeenLastCalledWith(
      expect.objectContaining({ ready: false, message: "changed" }),
    );
    expect(f.freeze).toHaveBeenCalledOnce();
  });

  it("unknown activity releases editing and refuses a ready acknowledgment", () => {
    const f = setup({ unsavedEditors: Number.NaN, savingEditors: 0 });
    f.handler.handle(request);
    expect(f.reply).toHaveBeenLastCalledWith(
      expect.objectContaining({ ready: false, message: "unknown" }),
    );
    expect(f.release).toHaveBeenCalledOnce();
  });

  it("does not retarget a held lease and releases it on teardown", () => {
    const f = setup();
    f.handler.handle(request);
    f.handler.handle({ ...request, manifestDigest: "b".repeat(64) });
    expect(f.reply).toHaveBeenLastCalledWith(
      expect.objectContaining({ ready: false, message: "changed" }),
    );
    expect(f.release).toHaveBeenCalledOnce();
    f.handler.dispose();
    expect(f.release).toHaveBeenCalledOnce();
  });

  it.each([
    { pendingWrites: 1, transientAttachments: 0, hydrated: true },
    { pendingWrites: 0, transientAttachments: 1, hydrated: true },
    { pendingWrites: 0, transientAttachments: 0, hydrated: false },
  ])("refuses pending or unknown durability without flushing persistence", (persistence) => {
    const release = vi.fn();
    const reply = vi.fn();
    const handler = createRendererMaintenanceHandler({
      freeze: () => release,
      editors: () => ({ unsavedEditors: 0, savingEditors: 0 }),
      runningChats: () => 0,
      persistence: () => persistence,
      connected: () => true,
      reply,
      message: (reason) => reason,
    });
    handler.handle(request);
    expect(reply).toHaveBeenLastCalledWith(expect.objectContaining({ ready: false }));
    expect(release).toHaveBeenCalledOnce();
    handler.dispose();
  });

  it("revokes an acknowledged lease on accepted activity and ignores callbacks after disposal", () => {
    let changed = () => {};
    const release = vi.fn();
    const unsubscribe = vi.fn();
    const reply = vi.fn();
    const handler = createRendererMaintenanceHandler({
      freeze: () => release,
      editors: () => ({ unsavedEditors: 0, savingEditors: 0 }),
      runningChats: () => 0,
      persistence: durable,
      connected: () => true,
      subscribe: (invalidate) => {
        changed = invalidate;
        return unsubscribe;
      },
      reply,
      message: (reason) => reason,
    });
    handler.handle(request);
    expect(reply).toHaveBeenLastCalledWith(expect.objectContaining({ ready: true }));
    changed();
    expect(reply).toHaveBeenLastCalledWith(
      expect.objectContaining({ ready: false, message: "changed" }),
    );
    expect(release).toHaveBeenCalledOnce();
    handler.handle(request);
    expect(reply).toHaveBeenLastCalledWith(expect.objectContaining({ ready: false }));
    handler.dispose();
    expect(unsubscribe).toHaveBeenCalledOnce();
    const replies = reply.mock.calls.length;
    handler.handle({ ...request, attemptId: "22345678-1234-4234-8234-123456789012" });
    changed();
    expect(reply).toHaveBeenCalledTimes(replies);
  });

  it("requires initial connectivity but preserves the local lease through a planned backend stop", () => {
    let connected = true;
    const reply = vi.fn();
    const handler = createRendererMaintenanceHandler({
      freeze: () => () => {},
      editors: () => ({ unsavedEditors: 0, savingEditors: 0 }),
      runningChats: () => 0,
      persistence: durable,
      connected: () => connected,
      reply,
      message: (reason) => reason,
    });
    handler.handle(request);
    connected = false;
    const stopped = {
      ...request,
      probeId: "32345678-1234-4234-8234-123456789012",
      backendStopped: true,
    };
    handler.handle(stopped);
    expect(reply).toHaveBeenLastCalledWith(
      expect.objectContaining({ ready: true, probeId: stopped.probeId }),
    );
    handler.handle({ ...stopped, action: "release" });
    const disconnected = {
      ...request,
      attemptId: "22345678-1234-4234-8234-123456789012",
      probeId: "42345678-1234-4234-8234-123456789012",
    };
    // A new attempt must use a fresh probe, not the retired pre-stop probe above.
    handler.handle(disconnected);
    expect(reply).toHaveBeenLastCalledWith(
      expect.objectContaining({
        attemptId: disconnected.attemptId,
        probeId: disconnected.probeId,
        ready: false,
        message: "unknown",
      }),
    );
    handler.dispose();
  });
});

it("binds held-lease invalidation to the newest probe and ignores a late old release", () => {
  let changed = () => {};
  const release = vi.fn();
  const reply = vi.fn();
  const handler = createRendererMaintenanceHandler({
    freeze: () => release,
    editors: () => ({ unsavedEditors: 0, savingEditors: 0 }),
    runningChats: () => 0,
    persistence: durable,
    connected: () => true,
    subscribe: (invalidate) => {
      changed = invalidate;
      return () => {};
    },
    reply,
    message: (reason) => reason,
  });
  handler.handle(request);
  const fresh = { ...request, probeId: "32345678-1234-4234-8234-123456789012" };
  handler.handle(fresh);
  expect(reply).toHaveBeenLastCalledWith(
    expect.objectContaining({ ready: true, probeId: fresh.probeId }),
  );
  handler.handle({ ...request, action: "release" });
  expect(release).not.toHaveBeenCalled();
  changed();
  expect(reply).toHaveBeenLastCalledWith(
    expect.objectContaining({ ready: false, probeId: fresh.probeId }),
  );
  expect(release).toHaveBeenCalledOnce();
  handler.dispose();
});

it("refuses an unplanned disconnected fresh probe before the backend stop is authorized", () => {
  let connected = true;
  const release = vi.fn();
  const reply = vi.fn();
  const handler = createRendererMaintenanceHandler({
    freeze: () => release,
    editors: () => ({ unsavedEditors: 0, savingEditors: 0 }),
    runningChats: () => 0,
    persistence: durable,
    connected: () => connected,
    reply,
    message: (reason) => reason,
  });
  handler.handle(request);
  connected = false;
  const fresh = { ...request, probeId: "32345678-1234-4234-8234-123456789012" };
  handler.handle(fresh);
  expect(reply).toHaveBeenLastCalledWith(
    expect.objectContaining({ ready: false, probeId: fresh.probeId }),
  );
  expect(release).toHaveBeenCalledOnce();
  handler.dispose();
});

it("does not let a stopped-backend flag bootstrap a lease without a prior connected durable proof", () => {
  const freeze = vi.fn();
  const reply = vi.fn();
  const handler = createRendererMaintenanceHandler({
    freeze,
    editors: () => ({ unsavedEditors: 0, savingEditors: 0 }),
    runningChats: () => 0,
    persistence: durable,
    connected: () => false,
    reply,
    message: (reason) => reason,
  });
  handler.handle({ ...request, backendStopped: true });
  expect(freeze).not.toHaveBeenCalled();
  expect(reply).toHaveBeenLastCalledWith(expect.objectContaining({ ready: false }));
  handler.dispose();
});
