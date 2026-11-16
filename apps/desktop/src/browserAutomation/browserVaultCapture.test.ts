import { EventEmitter } from "node:events";
import type { BrowserVaultSnapshot } from "@synara/contracts";
import type { CaptureContextShim } from "./browserVaultCapture";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserAutomationVisibleRuntime } from "../browserManager";
import type { BrowserVault } from "./browserVault";
import { LinxUpdateNativeAdmission } from "../linxUpdateNativeAdmission";

const mocks = vi.hoisted(() => ({ install: vi.fn(), dispose: vi.fn() }));
vi.mock("betterwright/capture", () => ({ installVaultCapture: mocks.install }));
import { BrowserVaultCapture } from "./browserVaultCapture";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.dispose.mockResolvedValue(undefined);
  mocks.install.mockReturnValue({ dispose: mocks.dispose });
});

function fixture(admission?: LinxUpdateNativeAdmission) {
  let changed = () => {};
  let state: BrowserVaultSnapshot = {
    protection: { configured: true, locked: false, osProtected: false },
    settings: { offerSave: false, autosave: false, agentUse: true },
    logins: [],
    pending: [],
    error: null,
  };
  const vault = {
    snapshot: async () => state,
    onChanged: (listener: () => void) => {
      changed = listener;
      return () => {
        changed = () => {};
      };
    },
    reportCaptureFailure: vi.fn(),
    saveCaptured: vi.fn(async () => {}),
    askSave: vi.fn(async (): Promise<"save" | "dismiss"> => "dismiss"),
  };
  const capture = new BrowserVaultCapture(vault as unknown as BrowserVault, admission);
  return {
    capture,
    vault,
    update: (patch: Partial<BrowserVaultSnapshot>) => {
      state = { ...state, ...patch };
      changed();
    },
  };
}

describe("native credential capture lifecycle", () => {
  it("counts native sensor persistence and save prompts until settlement and refuses new work under the window lease", async () => {
    let held = false;
    const admission = new LinxUpdateNativeAdmission(() => held);
    const f = fixture(admission);
    f.update({ settings: { offerSave: true, autosave: false, agentUse: true } });
    await vi.waitFor(() => expect(mocks.install).toHaveBeenCalled());
    const context = mocks.install.mock.calls[0]![0] as CaptureContextShim;
    const options = mocks.install.mock.calls[0]![1];
    const unregister = f.capture.register({
      threadId: "fixture",
      webContents: {
        isDestroyed: () => false,
        debugger: Object.assign(new EventEmitter(), {
          isAttached: () => false,
          sendCommand: vi.fn(),
        }),
      },
    } as unknown as BrowserAutomationVisibleRuntime);
    const page = context.pages()[0]!;
    const save = Promise.withResolvers<void>();
    f.vault.saveCaptured.mockReturnValueOnce(save.promise);
    const accepted = options.vaultCallAtOrigin(
      options.sessionForPage(page),
      "https://example.test",
      "save",
      { username: "fixture", password: "isolated-secret", label: "Fixture" },
    );
    expect(admission.busy).toBe(true);
    held = true;
    await expect(
      options.vaultCallAtOrigin(options.sessionForPage(page), "https://example.test", "save", {
        username: "new",
        password: "not-accepted",
        label: "New",
      }),
    ).rejects.toThrow("frozen");
    expect(f.vault.saveCaptured).toHaveBeenCalledOnce();
    save.resolve();
    await accepted;
    expect(admission.busy).toBe(false);
    held = false;
    const prompt = Promise.withResolvers<"save" | "dismiss">();
    f.vault.askSave.mockReturnValueOnce(prompt.promise);
    const asking = options.requestSave({
      origin: "https://example.test",
      username: "fixture",
      mode: "save",
    });
    expect(admission.busy).toBe(true);
    held = true;
    await expect(
      options.requestSave({ origin: "https://example.test", username: "new", mode: "save" }),
    ).rejects.toThrow("frozen");
    expect(f.vault.askSave).toHaveBeenCalledOnce();
    prompt.resolve("dismiss");
    await asking;
    expect(admission.busy).toBe(false);
    unregister();
    await f.capture.dispose();
  });

  it("does not install sensors without consent and removes them when the vault locks", async () => {
    const f = fixture();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mocks.install).not.toHaveBeenCalled();
    f.update({ settings: { offerSave: true, autosave: false, agentUse: true } });
    await vi.waitFor(() => expect(mocks.install).toHaveBeenCalledTimes(1));
    expect(mocks.install.mock.calls[0]![1]).toMatchObject({ promptTtlMs: 120_000 });
    f.update({ protection: { configured: true, locked: true, osProtected: false } });
    await vi.waitFor(() => expect(mocks.dispose).toHaveBeenCalledTimes(1));
    await f.capture.dispose();
  });

  it("keeps the capture surface structurally complete (pages/on/off/newCDPSession/isClosed)", async () => {
    const f = fixture();
    f.update({ settings: { offerSave: true, autosave: false, agentUse: true } });
    await vi.waitFor(() => expect(mocks.install).toHaveBeenCalled());
    const context = mocks.install.mock.calls[0]![0] as CaptureContextShim;
    // on("page") fires for late-registered tabs; off("page") stops the fan-out.
    const seen: string[] = [];
    const listener = (page: { id: string }) => void seen.push(page.id);
    context.on("page", listener);
    const unregister = f.capture.register({
      webContents: {
        debugger: Object.assign(new EventEmitter(), {
          isAttached: () => false,
          sendCommand: vi.fn(),
        }),
        isDestroyed: () => false,
      },
    } as unknown as BrowserAutomationVisibleRuntime);
    expect(seen).toHaveLength(1);
    context.off("page", listener);
    f.capture.register({
      webContents: {
        debugger: Object.assign(new EventEmitter(), {
          isAttached: () => false,
          sendCommand: vi.fn(),
        }),
        isDestroyed: () => false,
      },
    } as unknown as BrowserAutomationVisibleRuntime);
    expect(seen).toHaveLength(1);
    // Closed tabs are reported shut and refuse new CDP sessions.
    const [page] = context.pages();
    expect(page!.isClosed()).toBe(false);
    unregister();
    expect(page!.isClosed()).toBe(true);
    await expect(context.newCDPSession(page!)).rejects.toThrow("unavailable");
    await f.capture.dispose();
  });
});
