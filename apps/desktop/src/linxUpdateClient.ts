// FILE: linxUpdateClient.ts
// Purpose: The single owner of the Linx (workbench) update state — manifest checks,
// pinned downloads, timers, and persisted attempt bookkeeping.
// Layer: Desktop updater client

import { createHash } from "node:crypto";
import FS from "node:fs";
import Path from "node:path";

import type { DesktopUpdateState, LinxUpdateReleaseReceipt } from "@synara/contracts";
import { LINX_UPDATE_MANIFEST_MAX_BYTES, LINX_UPDATE_SIGNATURE_MAX_BYTES } from "@synara/contracts";
import {
  verifyLinxUpdateManifest,
  type LinxUpdateVerificationResult,
} from "@synara/shared/linxUpdateManifestVerification";

import {
  downloadLinxUpdateAsset,
  clearLinxUpdateStaging,
  type LinxUpdateDownloadOptions,
  type LinxUpdateDownloadResult,
  type LinxUpdateDownloadTarget,
} from "./linxUpdateDownload";
import {
  fetchLinxUpdateBytes,
  LinxUpdateFeedError,
  type LinxUpdateRequest,
} from "./linxUpdateFeed";
import { resolveLinxUpdateReleaseReceipt, type LinxUpdateSignedTarget } from "./linxUpdateRelease";
import type { LinxUpdateSource } from "./linxUpdateSource";
import {
  reduceDesktopUpdateStateOnDownloadComplete,
  reduceDesktopUpdateStateOnDownloadProgress,
  reduceDesktopUpdateStateOnDownloadStart,
  reduceDesktopUpdateStateOnNoUpdate,
  reduceDesktopUpdateStateOnUpdateAvailable,
} from "./updateMachine";
import { shouldBroadcastDownloadProgress } from "./updateState";

const systemDate = (): Date => new Date();

/** Startup check delay and steady-state interval, per the v0.2 schedule. */
export const LINX_UPDATE_STARTUP_DELAY_MS = 60_000;
export const LINX_UPDATE_POLL_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** Fluid triggers (foreground) never check more often than the window throttle. */
export const LINX_UPDATE_FOREGROUND_MIN_INTERVAL_MS = 5 * 60 * 1000;
export const LINX_UPDATE_CHECK_STATE_FILE_NAME = "linx-update-check.json";

export type LinxUpdateCheckReason = "startup" | "poll" | "manual" | "foreground";

/** Persisted across restarts so an interval or rate limit survives a relaunch. */
export interface LinxUpdateCheckRecord {
  readonly lastAttemptAt: string | null;
  readonly retryAfterUntil: string | null;
}

export const EMPTY_LINX_UPDATE_CHECK_RECORD: LinxUpdateCheckRecord = {
  lastAttemptAt: null,
  retryAfterUntil: null,
};

/** The exact signed bytes and package entry shown to the user. */
export type LinxUpdatePinnedTarget = LinxUpdateDownloadTarget & LinxUpdateSignedTarget;

export interface LinxUpdateActionResult {
  readonly accepted: boolean;
  readonly completed: boolean;
}

export interface LinxUpdateInstallationTarget {
  readonly target: LinxUpdatePinnedTarget;
  readonly download: LinxUpdateDownloadResult;
  readonly release: LinxUpdateReleaseReceipt;
}

export interface LinxUpdateInstallResult extends LinxUpdateActionResult {
  readonly message: string | null;
}

export interface LinxUpdateClientOptions {
  readonly source: LinxUpdateSource;
  readonly currentVersion: string;
  readonly stagingDir: string;
  readonly getUpdateState: () => DesktopUpdateState;
  readonly setUpdateState: (patch: Partial<DesktopUpdateState>) => void;
  readonly readCheckRecord: () => LinxUpdateCheckRecord;
  readonly writeCheckRecord: (record: LinxUpdateCheckRecord) => void;
  readonly install: (
    input: LinxUpdateInstallationTarget,
    signal: AbortSignal,
  ) => Promise<LinxUpdateInstallResult>;
  readonly installFailureMessage: string;
  readonly request?: LinxUpdateRequest | undefined;
  readonly now?: () => Date;
  /** Test seam for the manifest/signature fetch. */
  readonly fetchBytes?: (url: string, maxBytes: number) => Promise<Uint8Array>;
  /** Test seam for the package download. */
  readonly downloadAsset?: (
    options: LinxUpdateDownloadOptions,
  ) => Promise<LinxUpdateDownloadResult>;
  readonly log?: (message: string) => void;
  readonly startupDelayMs?: number;
  readonly pollIntervalMs?: number;
}

function toIsoOrNull(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}

/** Tolerant parse: a corrupt record degrades to "no recent attempt", never blocks updates. */
export function parseLinxUpdateCheckRecord(raw: string): LinxUpdateCheckRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return EMPTY_LINX_UPDATE_CHECK_RECORD;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return EMPTY_LINX_UPDATE_CHECK_RECORD;
  }
  const entries = parsed as Record<string, unknown>;
  return {
    lastAttemptAt: toIsoOrNull(entries.lastAttemptAt),
    retryAfterUntil: toIsoOrNull(entries.retryAfterUntil),
  };
}

export function readLinxUpdateCheckRecord(filePath: string): LinxUpdateCheckRecord {
  try {
    return parseLinxUpdateCheckRecord(FS.readFileSync(filePath, "utf8"));
  } catch {
    return EMPTY_LINX_UPDATE_CHECK_RECORD;
  }
}

export function writeLinxUpdateCheckRecord(filePath: string, record: LinxUpdateCheckRecord): void {
  try {
    FS.mkdirSync(Path.dirname(filePath), { recursive: true });
    FS.writeFileSync(filePath, JSON.stringify(record), "utf8");
  } catch {
    // Bookkeeping only: losing it costs an extra check, never correctness.
  }
}

function describeCheckFailure(error: unknown): { message: string; retryAfterMs: number | null } {
  if (error instanceof LinxUpdateFeedError) {
    return {
      message: error.statusCode === null ? error.message : `${error.message} (${error.reason})`,
      retryAfterMs: error.retryAfterMs,
    };
  }
  return {
    message: error instanceof Error ? error.message : String(error),
    retryAfterMs: null,
  };
}

function describeDownloadFailure(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) return error.message;
  return "The update could not be downloaded. Try again.";
}

/**
 * Owns check and download for the Linx flavor.
 *
 * Checks are single-flight: manual, startup, and interval triggers share one
 * in-flight request. A download is pinned to the target the user saw and is
 * started only by an explicit click; repeat clicks are idempotent.
 */
export class LinxUpdateClient {
  private readonly options: LinxUpdateClientOptions;
  private readonly startupDelayMs: number;
  private readonly pollIntervalMs: number;
  private readonly log: (message: string) => void;

  private startupTimer: ReturnType<typeof setTimeout> | null = null;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private started = false;
  private inFlightCheck: Promise<void> | null = null;
  private inFlightDownload: Promise<LinxUpdateDownloadResult> | null = null;
  private downloadAbort: AbortController | null = null;
  private pinnedTarget: LinxUpdatePinnedTarget | null = null;
  private downloadedFile: LinxUpdateDownloadResult | null = null;
  private downloadedTarget: LinxUpdatePinnedTarget | null = null;
  private downloadedRelease: LinxUpdateReleaseReceipt | null = null;
  private inFlightInstall: Promise<LinxUpdateActionResult> | null = null;
  private installAbort: AbortController | null = null;
  private stagingHandedOff = false;
  private disposed = false;

  constructor(options: LinxUpdateClientOptions) {
    this.options = options;
    this.startupDelayMs = options.startupDelayMs ?? LINX_UPDATE_STARTUP_DELAY_MS;
    this.pollIntervalMs = options.pollIntervalMs ?? LINX_UPDATE_POLL_INTERVAL_MS;
    this.log = options.log ?? (() => {});
  }

  /** Arms the delayed startup check. Recurring checks are scheduled per run. */
  start(): void {
    if (this.disposed || this.started) return;
    this.started = true;
    this.armStartupCheck();
  }

  private armStartupCheck(): void {
    if (this.disposed || this.startupTimer !== null) return;
    this.startupTimer = setTimeout(() => {
      this.startupTimer = null;
      void this.checkAutomatically("startup");
    }, this.startupDelayMs);
    this.startupTimer.unref?.();
  }

  // A fixed interval drifts: a check that starts slightly before the tick would
  // compare against its own attempt time. Scheduling the next run from the
  // completion of the last one keeps the cadence at exactly `pollIntervalMs`.
  private armNextPoll(): void {
    if (this.disposed || this.pollTimer !== null) return;
    this.pollTimer = setTimeout(() => {
      this.pollTimer = null;
      void this.checkAutomatically("poll");
    }, this.pollIntervalMs);
    this.pollTimer.unref?.();
  }

  checkManually(): Promise<void> {
    return this.check("manual");
  }

  checkAutomatically(reason: Exclude<LinxUpdateCheckReason, "manual">): Promise<void> {
    const run = this.check(reason);
    // A trigger that joins an in-flight check owns no run of its own, so the next
    // poll has to be armed from the completion of whatever it joined.
    if (reason === "startup" || reason === "poll") {
      const keepCadence = (): void => {
        this.armNextPoll();
      };
      void run.then(keepCadence, keepCadence);
    }
    return run;
  }

  /** One click pins the public release, downloads verified bytes, and attempts that installation once. */
  async download(): Promise<LinxUpdateActionResult> {
    if (this.disposed) return { accepted: false, completed: false };
    const state = this.options.getUpdateState();
    if (
      this.inFlightDownload !== null ||
      this.inFlightInstall !== null ||
      state.status === "downloading" ||
      state.status === "installing"
    ) {
      return { accepted: false, completed: false };
    }
    if (state.status === "downloaded") {
      return { accepted: false, completed: this.downloadedFile !== null };
    }
    const target = this.pinnedTarget;
    const retryable =
      state.status === "error" && state.errorContext === "download" && state.canRetry;
    if (
      (state.status !== "available" && !retryable) ||
      target === null ||
      target.version !== state.availableVersion
    ) {
      return { accepted: false, completed: false };
    }
    const abort = new AbortController();
    this.downloadAbort = abort;
    this.options.setUpdateState(reduceDesktopUpdateStateOnDownloadStart(state));
    let release: LinxUpdateReleaseReceipt | null = null;
    const download = (async () => {
      release = await resolveLinxUpdateReleaseReceipt({
        ...target,
        source: this.options.source,
        fetchBytes: this.fetch,
        now: this.options.now ?? systemDate,
      });
      abort.signal.throwIfAborted();
      return (this.options.downloadAsset ?? downloadLinxUpdateAsset)({
        target,
        stagingDir: this.options.stagingDir,
        allowedHosts: this.options.source.allowedAssetHosts,
        request: this.options.request,
        signal: abort.signal,
        onProgress: (percent) => {
          if (this.disposed) return;
          const current = this.options.getUpdateState();
          if (
            current.status !== "downloading" ||
            !shouldBroadcastDownloadProgress(current, percent)
          )
            return;
          this.options.setUpdateState(reduceDesktopUpdateStateOnDownloadProgress(current, percent));
        },
      });
    })();
    this.inFlightDownload = download;
    try {
      const result = await download;
      if (this.disposed) return { accepted: true, completed: false };
      if (release === null || result.sha256 !== target.sha256 || result.size !== target.size) {
        throw new Error("The downloaded Linx artifact does not match its pinned release.");
      }
      this.downloadedFile = result;
      this.downloadedTarget = target;
      this.downloadedRelease = release;
      this.options.setUpdateState(
        reduceDesktopUpdateStateOnDownloadComplete(this.options.getUpdateState(), target.version),
      );
      this.log(
        `[linx-updater] Verified ${target.version} (sha256=${result.sha256.slice(0, 16)}…).`,
      );
      await this.install();
      // This result acknowledges the download, not replacement or new-version health.
      return { accepted: true, completed: true };
    } catch (error) {
      const message = describeDownloadFailure(error);
      if (!this.disposed) {
        this.options.setUpdateState({
          status: "error",
          message,
          errorContext: "download",
          downloadPercent: null,
          canRetry: true,
        });
      }
      this.log(`[linx-updater] Download failed: ${message}`);
      return { accepted: true, completed: false };
    } finally {
      if (this.inFlightDownload === download) this.inFlightDownload = null;
      if (this.downloadAbort === abort) this.downloadAbort = null;
    }
  }

  async install(): Promise<LinxUpdateActionResult> {
    const target = this.downloadedTarget;
    const download = this.downloadedFile;
    const release = this.downloadedRelease;
    const state = this.options.getUpdateState();
    if (
      this.disposed ||
      this.inFlightInstall !== null ||
      state.status !== "downloaded" ||
      target === null ||
      download === null ||
      release === null ||
      state.downloadedVersion !== target.version
    ) {
      return { accepted: false, completed: false };
    }
    const abort = new AbortController();
    this.installAbort = abort;
    this.options.setUpdateState({
      status: "installing",
      message: null,
      errorContext: null,
      canRetry: false,
    });
    const run = Promise.resolve().then(async (): Promise<LinxUpdateActionResult> => {
      try {
        abort.signal.throwIfAborted();
        const result = await this.options.install({ target, download, release }, abort.signal);
        if (result.accepted && !this.stagingHandedOff)
          throw new Error("Installer accepted without claiming the pinned handoff.");
        if (!result.accepted && !this.disposed) {
          this.options.setUpdateState({
            status: "downloaded",
            errorContext: "install",
            canRetry: true,
            message: result.message ?? this.options.installFailureMessage,
          });
        }
        return { accepted: result.accepted, completed: false };
      } catch {
        if (!this.disposed) {
          this.options.setUpdateState({
            status: "downloaded",
            errorContext: "install",
            canRetry: true,
            message: this.options.installFailureMessage,
          });
        }
        return { accepted: false, completed: false };
      }
    });
    this.inFlightInstall = run;
    try {
      return await run;
    } finally {
      if (this.inFlightInstall === run) this.inFlightInstall = null;
      if (this.installAbort === abort) this.installAbort = null;
    }
  }

  claimInstallHandoff(manifestDigest: string): void {
    if (
      this.disposed ||
      this.inFlightInstall === null ||
      this.downloadedTarget?.manifestDigest !== manifestDigest ||
      this.installAbort?.signal.aborted
    ) {
      throw new Error("Cannot hand off an inactive or different Linx update.");
    }
    this.stagingHandedOff = true;
  }

  /** Aborts any transfer, stops the timers, and removes staging. */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    if (this.startupTimer !== null) {
      clearTimeout(this.startupTimer);
      this.startupTimer = null;
    }
    if (this.pollTimer !== null) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    this.downloadAbort?.abort();
    this.downloadAbort = null;
    if (this.stagingHandedOff) return;
    this.installAbort?.abort();
    await this.inFlightInstall;
    try {
      await clearLinxUpdateStaging(this.options.stagingDir);
    } catch (error) {
      this.log(
        `[linx-updater] Could not clear update staging: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private check(reason: LinxUpdateCheckReason): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (this.inFlightCheck !== null) return this.inFlightCheck;
    const run = this.runCheck(reason);
    this.inFlightCheck = run;
    const clear = (): void => {
      if (this.inFlightCheck === run) this.inFlightCheck = null;
    };
    void run.then(clear, clear);
    return run;
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  /** A rate limit recorded before a relaunch still blocks every automatic check. */
  private isRetryAfterActive(now: Date): boolean {
    const record = this.options.readCheckRecord();
    if (record.retryAfterUntil === null) return false;
    const retryAt = Date.parse(record.retryAfterUntil);
    return Number.isFinite(retryAt) && now.getTime() < retryAt;
  }

  /**
   * Automatic reasons honour an active rate limit. Foreground checks are
   * fluid triggers on top of the timer schedule, so they also need the same
   * floor the sidebar window uses; `lastAttemptAt` is what makes it survive a
   * relaunch.
   */
  private shouldSkipAutomaticCheck(
    reason: Exclude<LinxUpdateCheckReason, "manual">,
    now: Date,
  ): boolean {
    if (this.isRetryAfterActive(now)) return true;
    if (reason !== "foreground") return false;
    const lastAttemptAt = this.options.readCheckRecord().lastAttemptAt;
    if (lastAttemptAt === null) return false;
    const lastAttempt = Date.parse(lastAttemptAt);
    if (!Number.isFinite(lastAttempt)) return false;
    const elapsed = now.getTime() - lastAttempt;
    return elapsed >= 0 && elapsed < LINX_UPDATE_FOREGROUND_MIN_INTERVAL_MS;
  }

  private recordAttempt(now: Date, retryAfterUntil: string | null): void {
    this.options.writeCheckRecord({
      lastAttemptAt: now.toISOString(),
      retryAfterUntil,
    });
  }

  private async runCheck(reason: LinxUpdateCheckReason): Promise<void> {
    const now = this.now();
    if (reason !== "manual" && this.shouldSkipAutomaticCheck(reason, now)) {
      this.log(`[linx-updater] Skipping the ${reason} check; a rate limit or throttle is active.`);
      return;
    }
    const state = this.options.getUpdateState();
    if (
      this.inFlightDownload !== null ||
      this.inFlightInstall !== null ||
      state.status === "downloading" ||
      state.status === "installing"
    ) {
      this.log(`[linx-updater] Skipping check (${reason}) while a download is active.`);
      return;
    }
    // A verified package waiting in staging must survive timer-driven checks:
    // re-checking would clear `downloadedVersion` and drop the install action.
    if (state.status === "downloaded") {
      this.log(`[linx-updater] Skipping check (${reason}); a verified package is ready.`);
      return;
    }

    this.recordAttempt(now, this.options.readCheckRecord().retryAfterUntil);
    this.options.setUpdateState({
      status: "checking",
      message: null,
      downloadPercent: null,
      errorContext: null,
      canRetry: false,
    });
    this.log(`[linx-updater] Checking for updates (${reason})...`);

    let failure: string | null = null;
    let retryAfterMs: number | null = null;
    try {
      let attempt = await this.fetchVerifiedManifest();
      if (this.disposed) return;

      // The manifest and its signature are two independent `latest/download`
      // requests: a publish can land between them. Both files are individually
      // valid, so the pair fails only the signature/key stage; refetching the
      // pair together distinguishes that race from a real attack once.
      if (
        !attempt.verification.ok &&
        (attempt.verification.reason === "signature" || attempt.verification.reason === "key")
      ) {
        this.log("[linx-updater] Manifest/signature pair rejected; refetching it once.");
        attempt = await this.fetchVerifiedManifest();
        if (this.disposed) return;
      }

      const verification = attempt.verification;
      if (verification.ok) {
        const { manifest } = verification;
        this.pinnedTarget = {
          version: manifest.version,
          assetName: manifest.assetName,
          assetUrl: manifest.assetUrl,
          size: manifest.size,
          sha256: manifest.sha256,
          manifestDigest: createHash("sha256").update(attempt.manifestBytes).digest("hex"),
          manifest,
          manifestBytes: attempt.manifestBytes,
          signatureBytes: attempt.signatureBytes,
        };
        this.options.setUpdateState(
          reduceDesktopUpdateStateOnUpdateAvailable(
            this.options.getUpdateState(),
            manifest.version,
            now.toISOString(),
          ),
        );
        this.log(
          `[linx-updater] Update available: ${manifest.version} (key ${verification.keyId}, manifest ${this.pinnedTarget.manifestDigest.slice(0, 16)}…).`,
        );
        return;
      }

      if (verification.reason === "version") {
        this.pinnedTarget = null;
        this.options.setUpdateState(
          reduceDesktopUpdateStateOnNoUpdate(this.options.getUpdateState(), now.toISOString()),
        );
        this.log("[linx-updater] No newer Linx version is published.");
        return;
      }

      failure =
        verification.field === null
          ? `manifest rejected (${verification.reason}): ${verification.message}`
          : `manifest rejected (${verification.reason}, ${verification.field}): ${verification.message}`;
    } catch (error) {
      const described = describeCheckFailure(error);
      failure = described.message;
      retryAfterMs = described.retryAfterMs;
    }

    if (this.disposed) return;
    // Keep the last successful result: `checkedAt` and any `availableVersion`
    // stay as they were, and the error context marks the failed attempt.
    this.options.setUpdateState({
      status: "error",
      message: reason === "manual" ? `Could not check for updates: ${failure}` : null,
      errorContext: "check",
      downloadPercent: null,
      canRetry: true,
    });
    this.log(`[linx-updater] Check failed (${reason}): ${failure}`);
    if (retryAfterMs !== null) {
      this.recordAttempt(now, new Date(now.getTime() + retryAfterMs).toISOString());
    }
  }

  private async fetchVerifiedManifest(): Promise<{
    readonly manifestBytes: Uint8Array;
    readonly signatureBytes: Uint8Array;
    readonly verification: LinxUpdateVerificationResult;
  }> {
    const [manifestBytes, signatureBytes] = await Promise.all([
      this.fetch(this.options.source.manifestUrl, LINX_UPDATE_MANIFEST_MAX_BYTES),
      this.fetch(this.options.source.signatureUrl, LINX_UPDATE_SIGNATURE_MAX_BYTES),
    ]);
    return {
      manifestBytes,
      signatureBytes,
      verification: verifyLinxUpdateManifest({
        manifestBytes,
        signatureBytes,
        keyRing: this.options.source.keyRing,
        currentVersion: this.options.currentVersion,
        allowedAssetHosts: this.options.source.allowedAssetHosts,
      }),
    };
  }

  private fetch = (url: string, maxBytes: number): Promise<Uint8Array> => {
    if (this.options.fetchBytes !== undefined) {
      return this.options.fetchBytes(url, maxBytes);
    }
    return fetchLinxUpdateBytes({
      url,
      maxBytes,
      allowedHosts: this.options.source.allowedAssetHosts,
      request: this.options.request,
    });
  };
}
