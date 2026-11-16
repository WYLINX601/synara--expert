import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  LinxUpdateMaintenanceRequest,
  LinxUpdateMaintenanceResponse,
  LinxUpdateManifest,
} from "@synara/contracts";
import type { LinxUpdateInstallationTarget } from "./linxUpdateClient";
import {
  LinxUpdateInstaller,
  stopLinxBackendCleanly,
  type LinxInstallerDependencies,
  type LinxInstallerHelper,
} from "./linxUpdateInstall";
import { requireLinxReceipt } from "./linxUpdateHelperCore";

const shutdown = vi.hoisted(() => ({ start: vi.fn() }));
vi.mock("./backendShutdown", () => ({ startDesktopBackendShutdownRequest: shutdown.start }));

function fixture() {
  const events: string[] = [];
  const manifest: LinxUpdateManifest = {
    schemaVersion: 1,
    productId: "linx",
    installIdentity: "com.wylinx.linx",
    channel: "stable",
    version: "0.1.16",
    sourceCommit: "a".repeat(40),
    platform: "darwin",
    arch: "arm64",
    minOSVersion: "13.0",
    assetName: "Linx-0.1.16-arm64.zip",
    assetUrl: "https://github.com/owner/repo/releases/download/v0.1.16/Linx-0.1.16-arm64.zip",
    size: 3,
    sha256: "b".repeat(64),
    keyId: "c".repeat(16),
  };
  const input: LinxUpdateInstallationTarget = {
    target: {
      ...manifest,
      manifest,
      manifestBytes: Buffer.from("signed fixture"),
      signatureBytes: Buffer.from("signature fixture"),
      manifestDigest: "d".repeat(64),
    },
    download: { filePath: "/fixture/package.zip", size: 3, sha256: manifest.sha256 },
    release: {
      schemaVersion: 1,
      repository: "owner/repo",
      tagName: "v0.1.16",
      releaseId: 1,
      tagObjectSha: manifest.sourceCommit,
      sourceCommit: manifest.sourceCommit,
      packageAssetId: 2,
      manifestAssetId: 3,
      signatureAssetId: 4,
      manifestDigest: "d".repeat(64),
      packageSha256: manifest.sha256,
      verifiedAt: new Date().toISOString(),
    },
  };
  const helper: LinxInstallerHelper = {
    pid: 123,
    nonce: "e".repeat(64),
    attemptPath: "/fixture/attempt",
    prepare: vi.fn(async () => {
      events.push("helper.prepare");
    }),
    createRecovery: vi.fn(async () => {
      events.push("helper.recovery");
    }),
    commit: vi.fn(async () => {
      events.push("helper.commit");
    }),
    cancel: vi.fn(async () => {
      events.push("helper.cancel");
    }),
    detach: vi.fn(() => {
      events.push("helper.detach");
    }),
  };
  const transfer = vi.fn(async () => {
    events.push("ownership.transfer");
  });
  const dependencies: LinxInstallerDependencies = {
    currentVersion: "0.1.15",
    createHelper: vi.fn(async () => helper),
    windows: {
      prepare: vi.fn(async () => {
        events.push("windows.proof");
        return { ready: true, message: null };
      }),
      release: vi.fn(() => {
        events.push("windows.release");
      }),
    },
    maintenance: vi.fn(
      async (request: LinxUpdateMaintenanceRequest): Promise<LinxUpdateMaintenanceResponse> => {
        events.push(`maintenance.${request.action}`);
        return {
          schemaVersion: 1,
          attemptId: request.attemptId,
          manifestDigest: request.manifestDigest,
          status:
            request.action === "prepare"
              ? "ready"
              : request.action === "commit"
                ? "committed"
                : "released",
          busy: {
            activeTurns: 0,
            pendingApprovals: 0,
            pendingUserInputs: 0,
            backgroundTasks: 0,
            acceptedWrites: 0,
          },
          message: null,
        };
      },
    ),
    stopBackend: vi.fn(async () => {
      events.push("backend.exit");
    }),
    restartBackend: vi.fn(async () => {
      events.push("backend.restart");
    }),
    snapshot: vi.fn(async () => {
      events.push("profile.snapshot");
      return "/fixture/snapshot";
    }),
    takeOwnership: () => ({ nonce: "f".repeat(64), transfer, release: vi.fn() }),
    restoreOwnership: vi.fn(async () => {
      events.push("ownership.restore");
    }),
    revalidate: vi.fn(async () => {
      events.push("online.proof");
      return input.release;
    }),
    clearTransferredOwnership: vi.fn(() => {
      events.push("ownership.clear");
    }),
    claimHandoff: vi.fn(() => {
      events.push("client.claim");
    }),
    quit: vi.fn(() => {
      events.push("quit.intentional");
    }),
    message: (reason) => reason,
    log: vi.fn(),
  };
  const installer = new LinxUpdateInstaller(dependencies);
  return {
    installer,
    input,
    dependencies,
    helper,
    transfer,
    events,
    signal: new AbortController().signal,
  };
}

describe("Linx native installer lifecycle", () => {
  it("does not report a completed upgrade when only intentional handoff has finished", async () => {
    const f = fixture();
    await expect(f.installer.install(f.input, f.signal)).resolves.toEqual({
      accepted: true,
      completed: false,
      message: null,
    });
    expect(f.installer.handoffClaimed).toBe(true);
    expect(f.installer.installing).toBe(false);
  });

  it("refreshes a pinned receipt after a slow download before starting the helper", async () => {
    const f = fixture();
    const now = Date.now();
    const downloaded = {
      ...f.input,
      release: { ...f.input.release, verifiedAt: new Date(now - 60_000).toISOString() },
    };
    const fresh = { ...downloaded.release, verifiedAt: new Date(now).toISOString() };
    vi.mocked(f.dependencies.revalidate).mockResolvedValue(fresh);
    vi.mocked(f.dependencies.createHelper).mockImplementation(async (input) => {
      requireLinxReceipt(
        input.release,
        downloaded.release,
        input.target.manifest,
        input.target.manifestDigest,
        "owner/repo",
        now,
      );
      return f.helper;
    });
    await expect(f.installer.install(downloaded, f.signal)).resolves.toMatchObject({
      accepted: true,
      completed: false,
    });
    expect(f.installer.handoffClaimed).toBe(true);
  });

  it("refuses an offline install before holding windows or stopping the backend", async () => {
    const f = fixture();
    vi.mocked(f.dependencies.revalidate).mockRejectedValue(new Error("offline"));
    await expect(f.installer.install(f.input, f.signal)).resolves.toMatchObject({
      accepted: false,
      completed: false,
    });
    expect(f.dependencies.createHelper).not.toHaveBeenCalled();
    expect(f.dependencies.windows.prepare).not.toHaveBeenCalled();
    expect(f.dependencies.maintenance).not.toHaveBeenCalled();
    expect(f.dependencies.stopBackend).not.toHaveBeenCalled();
    expect(f.installer.handoffClaimed).toBe(false);
  });

  it.each(["ENOSPC", "EDQUOT", "EACCES", "EPERM", "EROFS"])(
    "reports a bounded refusal for %s without exposing private error text",
    async (code) => {
      const f = fixture();
      vi.mocked(f.helper.prepare).mockRejectedValue(
        Object.assign(new Error("private-path-and-credential-marker"), { code }),
      );
      const result = await f.installer.install(f.input, f.signal);
      expect(result).toEqual({
        accepted: false,
        completed: false,
        message: code === "ENOSPC" || code === "EDQUOT" ? "space" : "permissions",
      });
      expect(f.dependencies.stopBackend).not.toHaveBeenCalled();
      expect(f.installer.handoffClaimed).toBe(false);
    },
  );

  it("refuses busy windows without stopping tasks and requires a new explicit attempt", async () => {
    const f = fixture();
    vi.mocked(f.dependencies.windows.prepare).mockResolvedValueOnce({
      ready: false,
      message: "unsaved",
    });
    await expect(f.installer.install(f.input, f.signal)).resolves.toMatchObject({
      accepted: false,
      message: "unsaved",
    });
    expect(f.dependencies.maintenance).not.toHaveBeenCalled();
    expect(f.dependencies.stopBackend).not.toHaveBeenCalled();
    expect(f.helper.cancel).toHaveBeenCalledOnce();
    expect(f.dependencies.windows.release).toHaveBeenCalledOnce();
    expect(f.dependencies.quit).not.toHaveBeenCalled();
  });

  it("aborts an ambiguous reversible prepare without quiescing or restarting the backend", async () => {
    const f = fixture();
    vi.mocked(f.dependencies.maintenance).mockRejectedValueOnce(new Error("response lost"));
    await f.installer.install(f.input, f.signal);
    expect(
      vi.mocked(f.dependencies.maintenance).mock.calls.map(([request]) => request.action),
    ).toEqual(["prepare", "abort"]);
    expect(f.dependencies.stopBackend).not.toHaveBeenCalled();
    expect(f.dependencies.restartBackend).not.toHaveBeenCalled();
  });

  it("treats a lost commit response as possibly quiesced and proves exit before restart", async () => {
    const f = fixture();
    const realMaintenance = f.dependencies.maintenance;
    f.dependencies.maintenance = vi.fn(async (request, signal) => {
      if (request.action === "commit") throw new Error("commit response lost");
      return realMaintenance(request, signal);
    });
    await f.installer.install(f.input, f.signal);
    expect(f.events.slice(-4)).toEqual([
      "helper.cancel",
      "backend.exit",
      "backend.restart",
      "windows.release",
    ]);
    expect(f.dependencies.snapshot).not.toHaveBeenCalled();
    expect(f.dependencies.claimHandoff).not.toHaveBeenCalled();
  });

  it("restores transferred ownership and idle backend if fresh pinned release revalidation fails", async () => {
    const f = fixture();
    vi.mocked(f.dependencies.revalidate)
      .mockResolvedValueOnce(f.input.release)
      .mockRejectedValueOnce(new Error("withdrawn or offline"));
    await f.installer.install(f.input, f.signal);
    expect(f.events.slice(-4)).toEqual([
      "helper.cancel",
      "ownership.restore",
      "backend.restart",
      "windows.release",
    ]);
    expect(f.helper.commit).not.toHaveBeenCalled();
    expect(f.dependencies.quit).not.toHaveBeenCalled();
  });

  it("cancels even an acknowledged helper commit if the final window lease changed", async () => {
    const f = fixture();
    let proofs = 0;
    vi.mocked(f.dependencies.windows.prepare).mockImplementation(async () => ({
      ready: ++proofs < 5,
      message: "window changed",
    }));
    await expect(f.installer.install(f.input, f.signal)).resolves.toMatchObject({
      accepted: false,
      message: "window changed",
    });
    expect(f.helper.commit).toHaveBeenCalledOnce();
    expect(f.helper.cancel).toHaveBeenCalledOnce();
    expect(f.dependencies.claimHandoff).not.toHaveBeenCalled();
    expect(f.dependencies.quit).not.toHaveBeenCalled();
  });

  it("retains recovery protection if helper death prevents ownership return", async () => {
    const f = fixture();
    vi.mocked(f.dependencies.revalidate)
      .mockResolvedValueOnce(f.input.release)
      .mockRejectedValueOnce(new Error("offline"));
    vi.mocked(f.helper.cancel).mockRejectedValueOnce(new Error("helper died"));
    await expect(f.installer.install(f.input, f.signal)).resolves.toMatchObject({
      accepted: false,
      message: "recovery",
    });
    expect(f.dependencies.restoreOwnership).not.toHaveBeenCalled();
    expect(f.dependencies.restartBackend).not.toHaveBeenCalled();
    expect(f.dependencies.windows.release).not.toHaveBeenCalled();
    await expect(f.installer.install(f.input, f.signal)).resolves.toMatchObject({
      accepted: false,
      message: "recovery",
    });
    expect(f.dependencies.createHelper).toHaveBeenCalledOnce();
  });

  it("serializes explicit clicks and never retries busy work in the background", async () => {
    const f = fixture();
    const gate = Promise.withResolvers<void>();
    vi.mocked(f.helper.prepare).mockReturnValueOnce(gate.promise);
    const first = f.installer.install(f.input, f.signal);
    await expect(f.installer.install(f.input, f.signal)).resolves.toMatchObject({
      accepted: false,
      message: "busy",
    });
    expect(f.dependencies.createHelper).toHaveBeenCalledOnce();
    gate.resolve();
    await first;
  });
});

class BackendChild extends EventEmitter {
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  kill = vi.fn();
  exit(code: number | null, signal: NodeJS.Signals | null = null) {
    this.exitCode = code;
    this.signalCode = signal;
    this.emit("exit", code, signal);
  }
}

describe("installer clean backend exit proof", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    shutdown.start.mockReturnValue({
      outcome: Promise.resolve({ type: "response", statusCode: 202 }),
      cancel: vi.fn(),
    });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });
  it("does not mistake HTTP acceptance for actual exit", async () => {
    const child = new BackendChild();
    const stopping = stopLinxBackendCleanly({
      child: child as unknown as ChildProcess,
      baseUrl: "http://127.0.0.1:1234",
      token: "private",
    });
    let settled = false;
    void stopping.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    child.exit(0);
    await expect(stopping).resolves.toBeUndefined();
    expect(child.kill).not.toHaveBeenCalled();
  });
  it("times out without force killing the child or claiming it exited", async () => {
    const child = new BackendChild();
    const stopping = stopLinxBackendCleanly({
      child: child as unknown as ChildProcess,
      baseUrl: "http://127.0.0.1:1234",
      token: "private",
      timeoutMs: 10,
    });
    const rejected = expect(stopping).rejects.toThrow("exit was not observed");
    await vi.advanceTimersByTimeAsync(10);
    await rejected;
    expect(child.exitCode).toBeNull();
    expect(child.kill).not.toHaveBeenCalled();
  });
  it.each([
    [1, null],
    [null, "SIGKILL"],
  ] as const)("refuses nonclean exit %s/%s", async (code, signal) => {
    const child = new BackendChild();
    const stopping = stopLinxBackendCleanly({
      child: child as unknown as ChildProcess,
      baseUrl: "http://127.0.0.1:1234",
      token: "private",
    });
    child.exit(code, signal);
    await expect(stopping).rejects.toThrow("did not exit cleanly");
    expect(child.kill).not.toHaveBeenCalled();
  });
});
