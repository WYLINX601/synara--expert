// FILE: linxUpdateFeed.ts
// Purpose: Bounded, host-restricted HTTP fetching for the Linx update manifest, signature, and asset.
// Layer: Desktop updater transport
// Depends on: node:http, node:https. No Electron, no filesystem.

import {
  request as httpRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type RequestOptions,
} from "node:http";
import { request as httpsRequest } from "node:https";
import type { Readable } from "node:stream";

export const LINX_UPDATE_FEED_TIMEOUT_MS = 15_000;
export const LINX_UPDATE_FEED_MAX_REDIRECTS = 5;

// Plain HTTP is allowed only for loopback so end-to-end tests can exercise the
// real socket path without a TLS fixture. Every other host must be HTTPS.
const LOOPBACK_HOSTS: Readonly<Record<string, true>> = {
  "127.0.0.1": true,
  localhost: true,
  "::1": true,
  "[::1]": true,
};

export type LinxUpdateFeedFailureReason =
  | "url"
  | "protocol"
  | "host"
  | "redirect"
  | "status"
  | "size"
  | "timeout"
  | "network"
  | "aborted";

export class LinxUpdateFeedError extends Error {
  override readonly name = "LinxUpdateFeedError";
  readonly reason: LinxUpdateFeedFailureReason;
  readonly statusCode: number | null;
  /** Parsed `Retry-After` for a rate-limited response, in milliseconds. */
  readonly retryAfterMs: number | null;
  readonly aborted: boolean;

  constructor(
    reason: LinxUpdateFeedFailureReason,
    message: string,
    details: { statusCode?: number | null; retryAfterMs?: number | null; cause?: unknown } = {},
  ) {
    super(
      message,
      details.cause === undefined
        ? undefined
        : { cause: details.cause instanceof Error ? details.cause : undefined },
    );
    this.reason = reason;
    this.statusCode = details.statusCode ?? null;
    this.retryAfterMs = details.retryAfterMs ?? null;
    this.aborted = reason === "aborted";
  }
}

export function isLoopbackLinxUpdateHost(hostname: string): boolean {
  return LOOPBACK_HOSTS[hostname.toLowerCase()] === true;
}

/**
 * Rejects any URL that is not HTTPS on an allowed bare host. An explicit
 * non-default port cannot match the allow list.
 */
export function assertLinxUpdateUrlAllowed(url: URL, allowedHosts: readonly string[]): void {
  const isLoopbackHttp = url.protocol === "http:" && isLoopbackLinxUpdateHost(url.hostname);
  if (url.protocol !== "https:" && !isLoopbackHttp) {
    throw new LinxUpdateFeedError(
      "protocol",
      `Refusing ${url.protocol} update request to ${url.hostname}.`,
    );
  }
  if (url.username !== "" || url.password !== "") {
    throw new LinxUpdateFeedError("url", "Refusing an update URL that carries credentials.");
  }
  if (url.protocol === "https:" && url.port !== "") {
    throw new LinxUpdateFeedError("host", `Refusing update host ${url.host} with a custom port.`);
  }
  const allowed = new Set<string>();
  for (const host of allowedHosts) {
    const normalized = host.trim().toLowerCase();
    if (normalized.length > 0) allowed.add(normalized);
  }
  if (!allowed.has(url.hostname.toLowerCase())) {
    throw new LinxUpdateFeedError("host", `Update host ${url.hostname} is not in the allow list.`);
  }
}

const RETRY_AFTER_MAX_MS = 24 * 60 * 60 * 1000;

/** `Retry-After` as either delta-seconds or an HTTP date, clamped to one day. */
export function parseLinxUpdateRetryAfterMs(
  value: string | string[] | undefined,
  nowMs: number,
): number | null {
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;

  let millis: number;
  if (/^\d+$/u.test(trimmed)) {
    millis = Number(trimmed) * 1000;
  } else {
    const timestamp = Date.parse(trimmed);
    if (Number.isNaN(timestamp)) return null;
    millis = timestamp - nowMs;
  }
  if (!Number.isFinite(millis)) return null;
  return Math.min(Math.max(millis, 0), RETRY_AFTER_MAX_MS);
}

function createAbortError(): LinxUpdateFeedError {
  return new LinxUpdateFeedError("aborted", "The update request was cancelled.");
}

export interface LinxUpdateHttpResponse extends Readable {
  readonly statusCode?: number | undefined;
  readonly headers: IncomingHttpHeaders;
}

export type LinxUpdateRequest = (
  url: URL,
  options: {
    readonly timeoutMs: number;
    readonly signal?: AbortSignal | undefined;
    readonly accept: string;
  },
) => Promise<LinxUpdateHttpResponse>;

function requestLinxUpdateUrl(
  url: URL,
  options: {
    readonly timeoutMs: number;
    readonly signal?: AbortSignal | undefined;
    readonly accept: string;
  },
): Promise<IncomingMessage> {
  let resolve!: (response: IncomingMessage) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<IncomingMessage>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  if (options.signal?.aborted) {
    reject(createAbortError());
    return promise;
  }
  const requestOptions: RequestOptions = {
    method: "GET",
    headers: {
      "user-agent": "linx-desktop",
      accept: options.accept,
    },
  };
  const onResponse = (response: IncomingMessage): void => {
    options.signal?.removeEventListener("abort", onAbort);
    clearTimeout(connectTimer);
    resolve(response);
  };
  const request =
    url.protocol === "http:"
      ? httpRequest(url, requestOptions, onResponse)
      : httpsRequest(url, requestOptions, onResponse);
  const onAbort = (): void => {
    request.destroy(createAbortError());
  };
  const connectTimer = setTimeout(() => {
    request.destroy(new LinxUpdateFeedError("timeout", `Timed out connecting to ${url.hostname}.`));
  }, options.timeoutMs);
  connectTimer.unref?.();
  options.signal?.addEventListener("abort", onAbort, { once: true });
  request.on("error", (error) => {
    clearTimeout(connectTimer);
    options.signal?.removeEventListener("abort", onAbort);
    reject(
      error instanceof LinxUpdateFeedError
        ? error
        : options.signal?.aborted
          ? createAbortError()
          : new LinxUpdateFeedError("network", `Update request failed: ${error.message}`, {
              cause: error,
            }),
    );
  });
  request.setTimeout(options.timeoutMs, () => {
    request.destroy(new LinxUpdateFeedError("timeout", `Timed out requesting ${url.hostname}.`));
  });
  request.end();
  return promise;
}

/**
 * Keeps the body cancelable after the response arrived. Destroying the
 * IncomingMessage with an error is what makes a pending read (or `pipeline`)
 * fail immediately instead of waiting for the socket to time out.
 */
function bindAbortToStream(stream: Readable, signal: AbortSignal | undefined): void {
  if (signal === undefined) return;
  const onAbort = (): void => {
    stream.destroy(createAbortError());
  };
  if (signal.aborted) {
    onAbort();
    return;
  }
  signal.addEventListener("abort", onAbort, { once: true });
  stream.on("close", () => signal.removeEventListener("abort", onAbort));
}

// A discarded body still needs an error listener: an aborted keep-alive socket
// would otherwise surface as an unhandled "error" event.
function discardResponse(response: LinxUpdateHttpResponse): void {
  response.on("error", () => {});
  response.destroy();
}

export interface LinxUpdateStreamInput {
  readonly url: string;
  /** Bare host names the URL and every redirect hop must resolve to. */
  readonly allowedHosts: readonly string[];
  readonly timeoutMs?: number | undefined;
  readonly maxRedirects?: number | undefined;
  readonly accept?: string | undefined;
  readonly signal?: AbortSignal | undefined;
  /** Electron supplies its system-proxy/PAC-aware transport; policy stays shared. */
  readonly request?: LinxUpdateRequest | undefined;
}

export interface LinxUpdateStream {
  readonly finalUrl: string;
  readonly statusCode: number;
  /** Declared body size, when the server sends one. */
  readonly contentLength: number | null;
  /** Open body stream; the caller consumes and destroys it. */
  readonly stream: Readable;
}

/**
 * Opens a bounded GET against an allowed host, following redirects only while
 * every hop stays on the allow list. Non-2xx responses throw.
 */
export async function openLinxUpdateStream(
  input: LinxUpdateStreamInput,
): Promise<LinxUpdateStream> {
  const timeoutMs = input.timeoutMs ?? LINX_UPDATE_FEED_TIMEOUT_MS;
  const maxRedirects = input.maxRedirects ?? LINX_UPDATE_FEED_MAX_REDIRECTS;

  let url: URL;
  try {
    url = new URL(input.url);
  } catch {
    throw new LinxUpdateFeedError("url", `Refusing invalid update URL "${input.url}".`);
  }

  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    assertLinxUpdateUrlAllowed(url, input.allowedHosts);
    const response = await (input.request ?? requestLinxUpdateUrl)(url, {
      timeoutMs,
      signal: input.signal,
      accept: input.accept ?? "application/octet-stream",
    });
    const statusCode = response.statusCode ?? 0;
    const headers: IncomingHttpHeaders = response.headers;

    if (statusCode >= 300 && statusCode < 400) {
      discardResponse(response);
      const location = headers.location;
      if (typeof location !== "string" || location.length === 0) {
        throw new LinxUpdateFeedError(
          "redirect",
          `Update request to ${url.host} redirected without a location.`,
          { statusCode },
        );
      }
      if (hop === maxRedirects) {
        throw new LinxUpdateFeedError(
          "redirect",
          `Update request exceeded ${maxRedirects} redirects.`,
          { statusCode },
        );
      }
      try {
        url = new URL(location, url);
      } catch {
        throw new LinxUpdateFeedError("redirect", "Update request redirected to an invalid URL.", {
          statusCode,
        });
      }
      continue;
    }

    if (statusCode < 200 || statusCode >= 300) {
      discardResponse(response);
      throw new LinxUpdateFeedError("status", `Update request failed with HTTP ${statusCode}.`, {
        statusCode,
        retryAfterMs: parseLinxUpdateRetryAfterMs(headers["retry-after"], Date.now()),
      });
    }

    bindAbortToStream(response, input.signal);
    const declaredLength = headers["content-length"];
    const rawLength = Array.isArray(declaredLength) ? declaredLength[0] : declaredLength;
    const contentLength = typeof rawLength === "string" ? Number(rawLength) : Number.NaN;

    return {
      finalUrl: url.toString(),
      statusCode,
      contentLength: Number.isFinite(contentLength) && contentLength >= 0 ? contentLength : null,
      stream: response,
    };
  }

  throw new LinxUpdateFeedError("redirect", "Update request did not resolve.");
}

function toBuffer(chunk: unknown): Buffer {
  if (Buffer.isBuffer(chunk)) return chunk;
  if (typeof chunk === "string") return Buffer.from(chunk);
  return Buffer.from(chunk as Uint8Array);
}

function normalizeStreamError(error: unknown, signal: AbortSignal | undefined): Error {
  if (error instanceof LinxUpdateFeedError) return error;
  if (signal?.aborted) return createAbortError();
  return new LinxUpdateFeedError(
    "network",
    `Update transfer failed: ${error instanceof Error ? error.message : String(error)}`,
    { cause: error },
  );
}

export interface LinxUpdateBytesInput extends LinxUpdateStreamInput {
  /** Hard cap on bytes read; the protocol limits are the intended values. */
  readonly maxBytes: number;
}

/** Reads a whole small payload (manifest or signature) into memory under `maxBytes`. */
export async function fetchLinxUpdateBytes(input: LinxUpdateBytesInput): Promise<Uint8Array> {
  const { maxBytes } = input;
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) {
    throw new LinxUpdateFeedError("size", "Update payload limit must be a positive number.");
  }

  const opened = await openLinxUpdateStream(input);
  const { stream } = opened;
  if (opened.contentLength !== null && opened.contentLength > maxBytes) {
    stream.destroy();
    throw new LinxUpdateFeedError(
      "size",
      `Update payload declares ${opened.contentLength} bytes, above the ${maxBytes} byte limit.`,
    );
  }

  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for await (const chunk of stream) {
      const buffer = toBuffer(chunk);
      total += buffer.byteLength;
      if (total > maxBytes) {
        stream.destroy();
        throw new LinxUpdateFeedError(
          "size",
          `Update payload exceeded the ${maxBytes} byte limit.`,
        );
      }
      chunks.push(buffer);
    }
  } catch (error) {
    stream.destroy();
    throw normalizeStreamError(error, input.signal);
  }

  return Buffer.concat(chunks, total);
}
