import { randomUUID } from "node:crypto";
import { ipcMain, type BrowserWindow, type IpcMainEvent } from "electron";
import {
  LinxUpdateWindowMaintenanceRequest,
  LinxUpdateWindowMaintenanceResponse,
} from "@synara/contracts";
import { Schema } from "effect";
import { DESKTOP_IPC_CHANNELS } from "./ipcChannels";
import { t } from "./i18n";

interface MaintenanceResult {
  readonly ready: boolean;
  readonly message: string | null;
}
interface WindowLease {
  readonly window: BrowserWindow;
  readonly frame: Electron.WebFrameMain;
  probeId: string;
  readonly release: () => void;
  acknowledged: boolean;
}
interface Attempt {
  readonly attemptId: string;
  readonly manifestDigest: string;
  probeId: string;
  backendStopped: boolean;
  readonly windows: readonly WindowLease[];
  resolve: (result: MaintenanceResult) => void;
  timer: ReturnType<typeof setTimeout> | undefined;
}

/** Owns the lease over all managed renderers, not just the focused window. */
export class LinxUpdateWindowMaintenance {
  private current: Attempt | null = null;
  private readonly retired = new Set<string>();
  private disposed = false;
  /** Main must deny new managed windows/reloads while the input lease is held. */
  get held(): boolean {
    if (this.current && !this.sameMembership(this.current))
      this.fail(t("desktop:linxUpdateMaintenance_changed"));
    return this.current !== null;
  }
  private readonly membershipTimer: ReturnType<typeof setInterval>;
  private readonly receive = (event: IpcMainEvent, payload: unknown) => {
    const attempt = this.current;
    if (
      !attempt ||
      !this.options.isTrustedSender(event) ||
      event.senderFrame !== event.sender.mainFrame
    )
      return;
    const decoded = Schema.decodeUnknownOption(LinxUpdateWindowMaintenanceResponse)(payload);
    if (decoded._tag === "None") return;
    const response = decoded.value;
    if (
      response.attemptId !== attempt.attemptId ||
      response.manifestDigest !== attempt.manifestDigest ||
      response.probeId !== attempt.probeId
    )
      return;
    const lease = attempt.windows.find(
      (item) => item.window.webContents === event.sender && item.frame === event.senderFrame,
    );
    if (!lease || !this.sameMembership(attempt)) {
      this.fail(t("desktop:linxUpdateMaintenance_changed"));
      return;
    }
    if (!response.ready) {
      this.fail(response.message ?? t("desktop:linxUpdateMaintenance_unknown"));
      return;
    }
    lease.acknowledged = true;
    if (attempt.windows.every((item) => item.acknowledged)) {
      clearTimeout(attempt.timer);
      attempt.timer = undefined;
      attempt.resolve({ ready: true, message: null });
    }
  };

  constructor(
    private readonly options: {
      readonly getManagedWindows: () => readonly BrowserWindow[];
      readonly isTrustedSender: (event: IpcMainEvent) => boolean;
      readonly timeoutMs?: number;
    },
  ) {
    ipcMain.on(DESKTOP_IPC_CHANNELS.updateWindowMaintenanceResponse, this.receive);
    this.membershipTimer = setInterval(() => {
      if (this.current && !this.sameMembership(this.current))
        this.fail(t("desktop:linxUpdateMaintenance_changed"));
    }, 25);
    this.membershipTimer.unref?.();
  }

  private sameMembership(attempt: Attempt) {
    try {
      const windows = this.options.getManagedWindows();
      return (
        windows.length === attempt.windows.length &&
        new Set(windows).size === windows.length &&
        attempt.windows.every(
          (lease) =>
            windows.includes(lease.window) &&
            !lease.window.isDestroyed() &&
            !lease.window.webContents.isDestroyed() &&
            !lease.window.webContents.isLoadingMainFrame() &&
            !lease.frame.detached &&
            lease.window.webContents.mainFrame === lease.frame,
        )
      );
    } catch {
      return false;
    }
  }

  private fail(message: string) {
    const attempt = this.current;
    if (!attempt) return;
    this.current = null;
    this.retired.add(attempt.attemptId);
    clearTimeout(attempt.timer);
    for (const lease of attempt.windows) {
      lease.release();
      if (!lease.window.isDestroyed() && !lease.window.webContents.isDestroyed()) {
        try {
          lease.window.webContents.send(DESKTOP_IPC_CHANNELS.updateWindowMaintenanceRequest, {
            schemaVersion: 1,
            action: "release",
            attemptId: attempt.attemptId,
            manifestDigest: attempt.manifestDigest,
            probeId: lease.probeId,
            backendStopped: attempt.backendStopped,
          } satisfies LinxUpdateWindowMaintenanceRequest);
        } catch {
          // A dead renderer cannot retain input. Continue releasing every other window.
        }
      }
    }
    attempt.resolve({ ready: false, message });
  }

  prepare(
    attemptId: string,
    manifestDigest: string,
    options: { readonly backendStopped: boolean } = { backendStopped: false },
  ): Promise<MaintenanceResult> {
    const probeId = randomUUID();
    const parsed = Schema.decodeUnknownOption(LinxUpdateWindowMaintenanceRequest)({
      schemaVersion: 1,
      action: "prepare",
      attemptId,
      manifestDigest,
      probeId,
      backendStopped: options.backendStopped,
    });
    if (this.disposed || parsed._tag === "None" || this.retired.has(attemptId))
      return Promise.resolve({ ready: false, message: t("desktop:linxUpdateMaintenance_changed") });
    if (this.current) {
      if (this.current.attemptId !== attemptId || this.current.manifestDigest !== manifestDigest) {
        this.fail(t("desktop:linxUpdateMaintenance_changed"));
        this.retired.add(attemptId);
        return Promise.resolve({
          ready: false,
          message: t("desktop:linxUpdateMaintenance_changed"),
        });
      }
      if (this.current.backendStopped && !options.backendStopped) {
        this.fail(t("desktop:linxUpdateMaintenance_changed"));
        return Promise.resolve({
          ready: false,
          message: t("desktop:linxUpdateMaintenance_changed"),
        });
      }
      if (!this.sameMembership(this.current)) {
        this.fail(t("desktop:linxUpdateMaintenance_changed"));
        return Promise.resolve({
          ready: false,
          message: t("desktop:linxUpdateMaintenance_changed"),
        });
      }
      const attempt = this.current;
      clearTimeout(attempt.timer);
      attempt.resolve({ ready: false, message: t("desktop:linxUpdateMaintenance_changed") });
      const { promise, resolve } = Promise.withResolvers<MaintenanceResult>();
      attempt.probeId = probeId;
      attempt.backendStopped = options.backendStopped;
      attempt.resolve = resolve;
      for (const lease of attempt.windows) lease.acknowledged = false;
      attempt.timer = setTimeout(() => {
        this.fail(t("desktop:linxUpdateMaintenance_unknown"));
      }, this.options.timeoutMs ?? 3_000);
      try {
        for (const lease of attempt.windows) {
          lease.window.webContents.send(
            DESKTOP_IPC_CHANNELS.updateWindowMaintenanceRequest,
            parsed.value,
          );
          lease.probeId = probeId;
        }
      } catch {
        this.fail(t("desktop:linxUpdateMaintenance_unknown"));
      }
      return promise;
    }
    if (options.backendStopped) {
      this.retired.add(attemptId);
      return Promise.resolve({ ready: false, message: t("desktop:linxUpdateMaintenance_unknown") });
    }
    let windows: readonly BrowserWindow[];
    try {
      windows = this.options.getManagedWindows();
      if (
        windows.length === 0 ||
        new Set(windows).size !== windows.length ||
        windows.some(
          (window) =>
            window.isDestroyed() ||
            window.webContents.isDestroyed() ||
            window.webContents.isLoadingMainFrame() ||
            window.webContents.mainFrame.detached,
        )
      ) {
        this.retired.add(attemptId);
        return Promise.resolve({
          ready: false,
          message: t("desktop:linxUpdateMaintenance_unknown"),
        });
      }
    } catch {
      this.retired.add(attemptId);
      return Promise.resolve({ ready: false, message: t("desktop:linxUpdateMaintenance_unknown") });
    }
    const { promise, resolve } = Promise.withResolvers<MaintenanceResult>();
    const leases: WindowLease[] = [];
    const attempt: Attempt = {
      attemptId,
      manifestDigest,
      probeId,
      backendStopped: options.backendStopped,
      windows: leases,
      resolve,
      timer: undefined,
    };
    this.current = attempt;
    try {
      for (const window of windows) {
        const contents = window.webContents;
        const invalidate = () => {
          this.fail(t("desktop:linxUpdateMaintenance_changed"));
        };
        const navigation = (
          _event: unknown,
          _url: string,
          _inPlace: boolean,
          isMainFrame: boolean,
        ) => {
          if (isMainFrame) invalidate();
        };
        const freeze = (event: { preventDefault: () => void }) => {
          event.preventDefault();
        };
        leases.push({
          window,
          frame: contents.mainFrame,
          probeId,
          acknowledged: false,
          release: () => {
            contents.off("before-input-event", freeze);
            contents.off("before-mouse-event", freeze);
            contents.off("did-start-navigation", navigation);
            contents.off("render-process-gone", invalidate);
            contents.off("destroyed", invalidate);
            window.off("closed", invalidate);
          },
        });
        contents.on("before-input-event", freeze);
        contents.on("before-mouse-event", freeze);
        contents.on("did-start-navigation", navigation);
        contents.on("render-process-gone", invalidate);
        contents.on("destroyed", invalidate);
        window.on("closed", invalidate);
      }
      attempt.timer = setTimeout(() => {
        this.fail(t("desktop:linxUpdateMaintenance_unknown"));
      }, this.options.timeoutMs ?? 3_000);
      for (const lease of leases)
        lease.window.webContents.send(
          DESKTOP_IPC_CHANNELS.updateWindowMaintenanceRequest,
          parsed.value,
        );
    } catch {
      this.fail(t("desktop:linxUpdateMaintenance_unknown"));
    }
    return promise;
  }

  release(attemptId: string): void {
    if (this.current?.attemptId === attemptId)
      this.fail(t("desktop:linxUpdateMaintenance_changed"));
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.fail(t("desktop:linxUpdateMaintenance_changed"));
    clearInterval(this.membershipTimer);
    ipcMain.off(DESKTOP_IPC_CHANNELS.updateWindowMaintenanceResponse, this.receive);
  }
}
