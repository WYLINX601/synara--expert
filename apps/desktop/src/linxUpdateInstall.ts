import { randomUUID } from "node:crypto";
import * as Http from "node:http";
import type { ChildProcess } from "node:child_process";
import { Schema } from "effect";
import {
  LinxUpdateMaintenanceResponse,
  type LinxUpdateMaintenanceRequest,
  type LinxUpdateReleaseReceipt,
} from "@synara/contracts";
import type { LinxHomeOwnership } from "@synara/shared/linxUpdateHomeOwnership";
import {
  startDesktopBackendShutdownRequest,
  type PendingDesktopBackendShutdownRequest,
} from "./backendShutdown";
import type { LinxUpdateInstallationTarget, LinxUpdateInstallResult } from "./linxUpdateClient";
import { linxUpdateFailureReason, type LinxUpdateFailureReason } from "./linxUpdateFailure";

export interface LinxInstallerHelper {
  readonly pid: number;
  readonly nonce: string;
  readonly attemptPath: string;
  prepare(signal: AbortSignal): Promise<void>;
  createRecovery(snapshotPath: string, signal: AbortSignal): Promise<void>;
  commit(receipt: LinxUpdateReleaseReceipt, signal: AbortSignal): Promise<void>;
  cancel(): Promise<void>;
  detach(): void;
}
export interface LinxInstallerDependencies {
  currentVersion: string;
  createHelper(
    input: LinxUpdateInstallationTarget,
    attemptId: string,
    signal: AbortSignal,
  ): Promise<LinxInstallerHelper>;
  windows: {
    prepare(attemptId: string, digest: string): Promise<{ ready: boolean; message: string | null }>;
    release(attemptId: string): void;
  };
  maintenance(
    request: LinxUpdateMaintenanceRequest,
    signal: AbortSignal,
  ): Promise<LinxUpdateMaintenanceResponse>;
  stopBackend(): Promise<void>;
  restartBackend(): Promise<void>;
  snapshot(helper: LinxInstallerHelper): Promise<string>;
  takeOwnership(): LinxHomeOwnership;
  restoreOwnership(nonce: string): Promise<void>;
  revalidate(
    input: LinxUpdateInstallationTarget,
    signal: AbortSignal,
  ): Promise<LinxUpdateReleaseReceipt>;
  clearTransferredOwnership(): void;
  claimHandoff(digest: string): void;
  quit(): void;
  message(
    reason:
      | "busy"
      | "backend"
      | "unknown"
      | "recovery"
      | "online"
      | "prepare"
      | "backup"
      | "verification"
      | LinxUpdateFailureReason,
  ): string;
  log(error: unknown): void;
}

/** One explicit click owns exactly one immutable target and one attempt. Never waits for busy work. */
export class LinxUpdateInstaller {
  private active = false;
  private handedOff = false;
  private recoveryRequired = false;
  constructor(private readonly dependencies: LinxInstallerDependencies) {}
  get handoffClaimed(): boolean {
    return this.handedOff;
  }
  get installing(): boolean {
    return this.active;
  }
  async install(
    input: LinxUpdateInstallationTarget,
    signal: AbortSignal,
  ): Promise<LinxUpdateInstallResult> {
    const d = this.dependencies;
    if (this.recoveryRequired)
      return { accepted: false, completed: false, message: d.message("recovery") };
    if (this.active || this.handedOff)
      return { accepted: false, completed: false, message: d.message("busy") };
    this.active = true;
    const attemptId = randomUUID();
    const digest = input.target.manifestDigest;
    const request = (
      action: LinxUpdateMaintenanceRequest["action"],
    ): LinxUpdateMaintenanceRequest => ({
      schemaVersion: 1,
      action,
      attemptId,
      manifestDigest: digest,
      targetVersion: input.target.version,
    });
    let helper: LinxInstallerHelper | undefined;
    let maintenancePrepared = false;
    let committed = false;
    let stopped = false;
    let transferred = false;
    let refusal = d.message("failed");
    const check = (): void => signal.throwIfAborted();
    const proveWindows = async (): Promise<void> => {
      check();
      const proof = await d.windows.prepare(attemptId, digest);
      check();
      if (!proof.ready) {
        refusal = proof.message ?? d.message("busy");
        throw new Error("Window maintenance refused");
      }
    };
    try {
      check();
      refusal = d.message("online");
      // Downloading or waiting for a new explicit click can outlive a receipt.
      // Refresh the same immutable release before the helper's admission check.
      const initialReceipt = await d.revalidate(input, signal);
      check();
      refusal = d.message("prepare");
      helper = await d.createHelper({ ...input, release: initialReceipt }, attemptId, signal);
      await helper.prepare(signal);
      await proveWindows();
      maintenancePrepared = true; // An ambiguous response still requires exact-target abort.
      refusal = d.message("backend");
      const ready = await d.maintenance(request("prepare"), signal);
      check();
      if (ready.status !== "ready") {
        refusal = d.message("backend");
        throw new Error("Backend is busy or unknown");
      }
      await proveWindows();
      // Commit may have reached the backend even if its response is lost. From
      // here an abort is not permission to reuse an irreversibly quiesced engine.
      committed = true;
      const sealed = await d.maintenance(request("commit"), signal);
      if (sealed.status !== "committed")
        throw new Error("Backend did not confirm maintenance commit");
      check();
      await d.stopBackend();
      stopped = true;
      check();
      refusal = d.message("backup");
      const snapshot = await d.snapshot(helper);
      await proveWindows();
      check();
      const ownership = d.takeOwnership();
      await ownership.transfer({ pid: helper.pid, nonce: helper.nonce, version: d.currentVersion });
      d.clearTransferredOwnership();
      transferred = true;
      await helper.createRecovery(snapshot, signal);
      refusal = d.message("online");
      const receipt = await d.revalidate(input, signal);
      await proveWindows();
      check();
      refusal = d.message("verification");
      await helper.commit(receipt, signal);
      await proveWindows();
      // No asynchronous gap between final proof/claim and intentional quit.
      d.claimHandoff(digest);
      this.handedOff = true;
      helper.detach();
      d.quit();
      return { accepted: true, completed: false, message: null };
    } catch (error) {
      d.log(error);
      const reason = linxUpdateFailureReason(error);
      if (reason !== null && reason !== "failed") refusal = d.message(reason);
      let recovered = true;
      if (helper !== undefined) {
        try {
          await helper.cancel();
        } catch (cancelError) {
          d.log(cancelError);
          recovered = false;
        }
      }
      if (transferred && recovered && helper !== undefined) {
        try {
          await d.restoreOwnership(helper.nonce);
        } catch (ownershipError) {
          d.log(ownershipError);
          recovered = false;
        }
      }
      if (committed) {
        // Even a lost commit response may have quiesced the engine. Prove clean
        // exit before starting a fresh idle instance; never force-kill it.
        if (recovered) {
          try {
            if (!stopped) await d.stopBackend();
            await d.restartBackend();
          } catch (restartError) {
            d.log(restartError);
            recovered = false;
          }
        }
      } else if (maintenancePrepared) {
        try {
          await d.maintenance(request("abort"), new AbortController().signal);
        } catch (abortError) {
          d.log(abortError);
          recovered = false;
        }
      }
      if (recovered) d.windows.release(attemptId);
      else {
        this.recoveryRequired = true;
        refusal = d.message("recovery");
      }
      return { accepted: false, completed: false, message: refusal };
    } finally {
      this.active = false;
    }
  }
}

export function requestLinxUpdateMaintenance(input: {
  baseUrl: string;
  token: string;
  request: LinxUpdateMaintenanceRequest;
  signal: AbortSignal;
}): Promise<LinxUpdateMaintenanceResponse> {
  const url = new URL("/api/desktop/maintenance", input.baseUrl);
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "[::1]"].includes(url.hostname) ||
    url.username ||
    url.password ||
    !input.token
  ) {
    return Promise.reject(new Error("Update maintenance requires authenticated loopback"));
  }
  const { promise, resolve, reject } = Promise.withResolvers<LinxUpdateMaintenanceResponse>();
  const bytes = Buffer.from(JSON.stringify(input.request));
  const request = Http.request(
    url,
    {
      method: "POST",
      agent: false,
      signal: input.signal,
      headers: {
        authorization: `Bearer ${input.token}`,
        "content-type": "application/json",
        "content-length": bytes.length,
      },
    },
    (response) => {
      const chunks: Buffer[] = [];
      let size = 0;
      response.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > 64 * 1024) response.destroy(new Error("Maintenance response too large"));
        else chunks.push(chunk);
      });
      response.once("error", reject);
      response.once("end", () => {
        try {
          if (response.statusCode !== 200) throw new Error("Maintenance request refused");
          const value = Schema.decodeUnknownSync(LinxUpdateMaintenanceResponse)(
            JSON.parse(Buffer.concat(chunks).toString("utf8")),
          );
          if (
            value.attemptId !== input.request.attemptId ||
            value.manifestDigest !== input.request.manifestDigest
          )
            throw new Error("Maintenance response binding changed");
          resolve(value);
        } catch (error) {
          reject(error);
        }
      });
    },
  );
  request.setTimeout(20_000, () => request.destroy(new Error("Maintenance response timed out")));
  request.once("error", reject);
  request.end(bytes);
  return promise;
}

/** Installer-only shutdown: no SIGTERM, SIGKILL, task cancellation or optimistic PID clearing. */
export async function stopLinxBackendCleanly(input: {
  child: ChildProcess;
  baseUrl: string;
  token: string;
  timeoutMs?: number;
}): Promise<void> {
  const child = input.child;
  if (child.exitCode !== null || child.signalCode !== null) {
    if (child.exitCode === 0 && child.signalCode === null) return;
    throw new Error("Backend did not exit cleanly; installation refused");
  }
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  let pending: PendingDesktopBackendShutdownRequest | undefined;
  let settled = false;
  const finish = (error?: Error): void => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    child.off("exit", exited);
    pending?.cancel();
    if (error) reject(error);
    else resolve();
  };
  const exited = (code: number | null, signal: NodeJS.Signals | null): void =>
    finish(
      code === 0 && signal === null
        ? undefined
        : new Error("Backend did not exit cleanly; installation refused"),
    );
  const timer = setTimeout(
    () => finish(new Error("Clean backend exit was not observed; installation refused")),
    input.timeoutMs ?? 20_000,
  );
  child.once("exit", exited);
  if (child.exitCode !== null || child.signalCode !== null) {
    exited(child.exitCode, child.signalCode);
    return;
  }
  try {
    pending = startDesktopBackendShutdownRequest({
      backendHttpUrl: input.baseUrl,
      shutdownToken: input.token,
    });
    void pending.outcome.then((outcome) => {
      if (outcome.type !== "response" || outcome.statusCode !== 202)
        finish(new Error("Backend rejected clean shutdown"));
    });
  } catch (error) {
    finish(error instanceof Error ? error : new Error(String(error)));
  }
  await promise;
}
