// FILE: linxUpdateDownload.ts
// Purpose: Streams a Linx update package into staging, hashing as it writes, and only
// promotes the file once the signed manifest's size and sha256 both match.
// Layer: Desktop updater download
// Depends on: node:crypto, node:fs, node:stream and the feed transport.

import { createHash, randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

import { LINX_UPDATE_ASSET_MAX_BYTES } from "@synara/contracts";

import {
  openLinxUpdateStream,
  LinxUpdateFeedError,
  type LinxUpdateRequest,
} from "./linxUpdateFeed";

export type LinxUpdateDownloadFailureReason = "network" | "size" | "sha256" | "write" | "aborted";

export class LinxUpdateDownloadError extends Error {
  override readonly name = "LinxUpdateDownloadError";
  readonly reason: LinxUpdateDownloadFailureReason;
  readonly aborted: boolean;

  constructor(reason: LinxUpdateDownloadFailureReason, message: string, cause?: unknown) {
    super(message, cause instanceof Error ? { cause } : undefined);
    this.reason = reason;
    this.aborted = reason === "aborted";
  }
}

/** The downloaded artifact is pinned to the exact manifest entry it came from. */
export interface LinxUpdateDownloadTarget {
  readonly version: string;
  readonly assetName: string;
  readonly assetUrl: string;
  /** Manifest `size` in bytes. */
  readonly size: number;
  /** Manifest `sha256`, lowercase hex. */
  readonly sha256: string;
}

export interface LinxUpdateDownloadOptions {
  readonly target: LinxUpdateDownloadTarget;
  /** Private staging directory; the finished package lands directly inside it. */
  readonly stagingDir: string;
  readonly allowedHosts: readonly string[];
  /** Receives whole-percent progress; the final call is always 100. */
  readonly onProgress?: (percent: number) => void;
  readonly timeoutMs?: number | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly request?: LinxUpdateRequest | undefined;
  /** Overridable only so tests can use a tiny cap. */
  readonly maxBytes?: number | undefined;
}

export interface LinxUpdateDownloadResult {
  readonly filePath: string;
  readonly size: number;
  readonly sha256: string;
}

export async function clearLinxUpdateStaging(stagingDir: string): Promise<void> {
  await rm(stagingDir, { recursive: true, force: true });
}

function asDownloadError(error: unknown, signal: AbortSignal | undefined): LinxUpdateDownloadError {
  if (error instanceof LinxUpdateDownloadError) return error;
  if (error instanceof LinxUpdateFeedError) {
    const reason = error.aborted ? "aborted" : error.reason === "size" ? "size" : "network";
    return new LinxUpdateDownloadError(reason, error.message, error);
  }
  if (signal?.aborted) {
    return new LinxUpdateDownloadError("aborted", "The update download was cancelled.", error);
  }
  return new LinxUpdateDownloadError(
    "network",
    `Update download failed: ${error instanceof Error ? error.message : String(error)}`,
    error,
  );
}

/**
 * Downloads the pinned package into `stagingDir`.
 *
 * The transfer is bounded by the manifest `size`: a body that is longer or
 * shorter than declared is discarded, and the streamed sha256 must match before
 * the temporary file is renamed into place. Nothing is left behind on failure.
 */
export async function downloadLinxUpdateAsset(
  options: LinxUpdateDownloadOptions,
): Promise<LinxUpdateDownloadResult> {
  const { target, stagingDir } = options;
  const maxBytes = options.maxBytes ?? LINX_UPDATE_ASSET_MAX_BYTES;
  if (!Number.isFinite(target.size) || target.size <= 0 || target.size > maxBytes) {
    throw new LinxUpdateDownloadError(
      "size",
      `Manifest size ${target.size} is outside the allowed package range.`,
    );
  }

  await mkdir(stagingDir, { recursive: true });
  const finalPath = join(stagingDir, target.assetName);
  const partPath = join(stagingDir, `.${target.assetName}.${randomBytes(8).toString("hex")}.part`);

  const opened = await openLinxUpdateStream({
    url: target.assetUrl,
    allowedHosts: options.allowedHosts,
    timeoutMs: options.timeoutMs,
    signal: options.signal,
    request: options.request,
  }).catch((error: unknown) => {
    // Host policy and transport failures happen before the pipeline exists.
    throw asDownloadError(error, options.signal);
  });
  if (opened.contentLength !== null && opened.contentLength !== target.size) {
    opened.stream.destroy();
    throw new LinxUpdateDownloadError(
      "size",
      `Package declares ${opened.contentLength} bytes but the manifest says ${target.size}.`,
    );
  }

  const hash = createHash("sha256");
  let transferred = 0;
  let lastPercent = -1;
  const reportProgress = (final: boolean): void => {
    const percent = Math.min(100, Math.floor((transferred / target.size) * 100));
    if (!final && percent === lastPercent) return;
    lastPercent = percent;
    options.onProgress?.(final ? 100 : percent);
  };

  const meter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      transferred += chunk.byteLength;
      if (transferred > target.size) {
        callback(
          new LinxUpdateDownloadError(
            "size",
            `Package exceeded the ${target.size} bytes the manifest declares.`,
          ),
        );
        return;
      }
      hash.update(chunk);
      reportProgress(false);
      callback(null, chunk);
    },
  });

  try {
    await pipeline(opened.stream, meter, createWriteStream(partPath, { flags: "wx" }));

    if (transferred !== target.size) {
      throw new LinxUpdateDownloadError(
        "size",
        `Downloaded ${transferred} bytes but the manifest declares ${target.size}.`,
      );
    }
    const digest = hash.digest("hex");
    if (digest !== target.sha256) {
      throw new LinxUpdateDownloadError(
        "sha256",
        `Downloaded package digest ${digest} does not match the manifest.`,
      );
    }

    await rename(partPath, finalPath);
    lastPercent = 99;
    reportProgress(true);
    return { filePath: finalPath, size: transferred, sha256: digest };
  } catch (error) {
    await rm(partPath, { force: true });
    throw asDownloadError(error, options.signal);
  }
}
