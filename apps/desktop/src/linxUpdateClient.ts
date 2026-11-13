// FILE: linxUpdateClient.ts
// Purpose: The single owner of the Linx (workbench) update state — manifest checks,
// pinned downloads, timers, and persisted attempt bookkeeping.
// Layer: Desktop updater client
// Depends on: the LU-00 verification pipeline, the feed transport, and the downloader.

import { createHash } from "node:crypto";
import FS from "node:fs";
import Path from "node:path";

import type { DesktopUpdateState } from "@synara/contracts";
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
import { fetchLinxUpdateBytes, LinxUpdateFeedError } from "./linxUpdateFeed";
import type { LinxUpdateSource } from "./linxUpdateSource";
import {
  reduceDesktopUpdateStateOnDownloadComplete,
  reduceDesktopUpdateStateOnDownloadProgress,
  reduceDesktopUpdateStateOnDownloadStart,
  reduceDesktopUpdateStateOnNoUpdate,
  reduceDesktopUpdateStateOnUpdateAvailable,
} from "./updateMachine";
import { shouldBroadcastDownloadProgress } from "./updateState";

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

/** Until LU-04 ships the helper, a refused install must still explain itself. */
export const LINX_UPDATE_INSTALL_UNAVAILABLE_MESSAGE =
  "This build cannot install updates yet. Downloading works; installing arrives in a later update.";

/** The manifest entry frozen when a check found a version; never swapped mid-download. */
export interface LinxUpdatePinnedTarget extends LinxUpdateDownloadTarget {
  readonly manifestDigest: string;
}

export interface LinxUpdateActionResult {
  readonly accepted: boolean;
  readonly completed: boolean;
}

export interface LinxUpdateClientOptions {
  readonly source: LinxUpdateSource;
  readonly currentVersion: string;
  readonly stagingDir: string;
  readonly getUpdateState: () => DesktopUpdateState;
  readonly setUpdateState: (patch: Partial<DesktopUpdateState>) => void;
  readonly readCheckRecord: () => LinxUpdateCheckRecord;
  readonly writeCheckRecord: (record: LinxUpdateCheckRecord) => void;
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

  /**
   * Downloads the pinned package. The second click while a transfer is running
   * returns immediately, and a click after a completed download reports the
   * existing artifact instead of starting another transfer.
   */
  async download(): Promise<LinxUpdateActionResult> {
    if (this.disposed) return { accepted: false, completed: false };
    const state = this.options.getUpdateState();
    if (this.inFlightDownload !== null || state.status === "downloading") {
      return { accepted: false, completed: false };
    }
    if (state.status === "downloaded") {
      return { accepted: false, completed: this.downloadedFile !== null };
    }
    const target = this.pinnedTarget;
    // A failed download publishes `error` with the offered version kept, so the
    // same pinned target must still be downloadable when the user retries.
    const retryable =
      state.status === "error" && state.errorContext === "download" && state.canRetry;
    if (
      (state.status !== "available" && !retryable) ||
      target === null ||
      target.version !== state.availableVersion
    ) {
      this.log("[linx-updater] Ignoring download request without a pinned target.");
      return { accepted: false, completed: false };
    }

    const abort = new AbortController();
    this.downloadAbort = abort;
    this.options.setUpdateState(reduceDesktopUpdateStateOnDownloadStart(state));

    const download = (this.options.downloadAsset ?? downloadLinxUpdateAsset)({
      target,
      stagingDir: this.options.stagingDir,
      allowedHosts: this.options.source.allowedAssetHosts,
      signal: abort.signal,
      onProgress: (percent) => {
        if (this.disposed) return;
        const current = this.options.getUpdateState();
        if (current.status !== "downloading") return;
        if (!shouldBroadcastDownloadProgress(current, percent)) return;
        this.options.setUpdateState(reduceDesktopUpdateStateOnDownloadProgress(current, percent));
      },
    });
    this.inFlightDownload = download;

    try {
      const result = await download;
      if (this.disposed) return { accepted: true, completed: false };
      this.downloadedFile = result;
      this.options.setUpdateState(
        reduceDesktopUpdateStateOnDownloadComplete(this.options.getUpdateState(), target.version),
      );
      this.log(
        `[linx-updater] Downloaded ${target.assetName} (${target.version}, sha256=${result.sha256.slice(0, 16)}…).`,
      );
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

  /** LU-04 owns installation; this build reports the handoff as unavailable. */
  install(): LinxUpdateActionResult {
    this.log("[linx-updater] Install is not available yet; the LU-04 helper owns the handoff.");
    if (!this.disposed) {
      // Status and downloadedVersion stay untouched: the package is still ready.
      this.options.setUpdateState({ message: LINX_UPDATE_INSTALL_UNAVAILABLE_MESSAGE });
    }
    return { accepted: false, completed: false };
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
    if (this.inFlightDownload !== null || state.status === "downloading") {
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
    readonly verification: LinxUpdateVerificationResult;
  }> {
    const [manifestBytes, signatureBytes] = await Promise.all([
      this.fetch(this.options.source.manifestUrl, LINX_UPDATE_MANIFEST_MAX_BYTES),
      this.fetch(this.options.source.signatureUrl, LINX_UPDATE_SIGNATURE_MAX_BYTES),
    ]);
    return {
      manifestBytes,
      verification: verifyLinxUpdateManifest({
        manifestBytes,
        signatureBytes,
        keyRing: this.options.source.keyRing,
        currentVersion: this.options.currentVersion,
        allowedAssetHosts: this.options.source.allowedAssetHosts,
      }),
    };
  }

  private fetch(url: string, maxBytes: number): Promise<Uint8Array> {
    if (this.options.fetchBytes !== undefined) {
      return this.options.fetchBytes(url, maxBytes);
    }
    return fetchLinxUpdateBytes({
      url,
      maxBytes,
      allowedHosts: this.options.source.allowedAssetHosts,
    });
  }
}
