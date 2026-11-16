import { Readable } from "node:stream";
import { net, type ClientRequest, type Session } from "electron";

import {
  LinxUpdateFeedError,
  type LinxUpdateHttpResponse,
  type LinxUpdateRequest,
} from "./linxUpdateFeed";

const STREAM_CHUNK_BYTES = 64 * 1024;

/** A dedicated Electron session retains OS proxy/PAC and certificate verification, not browser cookies. */
export function createLinxUpdateElectronRequest(session: Session): LinxUpdateRequest {
  return async (url, options) => {
    const controller = new AbortController();
    const cancel = (): void =>
      controller.abort(new LinxUpdateFeedError("aborted", "The update request was cancelled."));
    if (options.signal?.aborted) cancel();
    else options.signal?.addEventListener("abort", cancel, { once: true });
    const timeout = (): void =>
      controller.abort(new LinxUpdateFeedError("timeout", `Timed out requesting ${url.hostname}.`));
    let timer: NodeJS.Timeout | undefined = setTimeout(timeout, options.timeoutMs);
    timer.unref?.();
    const failure = (cause: unknown): Error =>
      controller.signal.reason instanceof LinxUpdateFeedError
        ? controller.signal.reason
        : new LinxUpdateFeedError("network", "The update service request failed.", { cause });

    const pending = Promise.withResolvers<{
      statusCode: number;
      headers: LinxUpdateHttpResponse["headers"];
      body?: Readable;
    }>();
    let nativeRequest: ClientRequest;
    try {
      nativeRequest = net.request({
        url: url.toString(),
        session,
        method: "GET",
        redirect: "manual",
        credentials: "omit",
        cache: "no-store",
        headers: { "user-agent": "linx-desktop", accept: options.accept },
        bypassCustomProtocolHandlers: true,
      });
    } catch (error) {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", cancel);
      throw failure(error);
    }
    const abortNative = (): void => {
      pending.reject(failure(controller.signal.reason));
      nativeRequest.abort();
    };
    controller.signal.addEventListener("abort", abortNative, { once: true });
    nativeRequest.on("error", pending.reject);
    nativeRequest.once("redirect", (statusCode, _method, redirectUrl, headers) => {
      // Electron fetch rejects manual redirects. Expose this hop without following
      // it: Feed must validate the next URL before a new native request is issued.
      pending.resolve({ statusCode, headers: { ...headers, location: redirectUrl } });
      nativeRequest.abort();
    });
    nativeRequest.once("response", (response) => {
      // Electron 43's runtime response is a Node Readable, although its public
      // declaration only exposes EventEmitter. Require actual stream backpressure.
      if (!(response instanceof Readable)) {
        pending.reject(new Error("The update response is not a readable stream."));
        nativeRequest.abort();
        return;
      }
      pending.resolve({
        statusCode: response.statusCode,
        headers: response.headers,
        body: response,
      });
    });
    try {
      if (controller.signal.aborted) abortNative();
      else nativeRequest.end();
    } catch (error) {
      pending.reject(error);
    }

    let response: Awaited<typeof pending.promise>;
    try {
      response = await pending.promise;
    } catch (error) {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", cancel);
      controller.signal.removeEventListener("abort", abortNative);
      nativeRequest.abort();
      throw failure(error);
    }
    clearTimeout(timer);
    timer = undefined;
    const body = response.body;
    const reader = body?.[Symbol.asyncIterator]();
    let cleaned = false;
    const cleanup = (): void => {
      if (cleaned) return;
      cleaned = true;
      clearTimeout(timer);
      timer = undefined;
      options.signal?.removeEventListener("abort", cancel);
      controller.signal.removeEventListener("abort", abortBody);
      controller.signal.removeEventListener("abort", abortNative);
      nativeRequest.abort();
      body?.destroy();
    };
    const stream = Readable.from(
      (async function* () {
        try {
          if (reader === undefined) return;
          for (;;) {
            timer = setTimeout(timeout, options.timeoutMs);
            timer.unref?.();
            const result = await reader.next();
            clearTimeout(timer);
            timer = undefined;
            if (result.done) break;
            const chunk = result.value;
            if (!Buffer.isBuffer(chunk)) {
              throw new Error("The native update response returned a non-byte chunk.");
            }
            // Chromium can deliver a chunk larger than the Node high-water mark.
            // Slice without copying so a paused downstream retains a bounded queue.
            if (chunk.byteLength <= STREAM_CHUNK_BYTES) yield chunk;
            else {
              for (let offset = 0; offset < chunk.byteLength; offset += STREAM_CHUNK_BYTES) {
                yield chunk.subarray(offset, offset + STREAM_CHUNK_BYTES);
              }
            }
          }
        } catch (error) {
          throw failure(error);
        } finally {
          cleanup();
        }
      })(),
      { objectMode: false },
    );
    const abortBody = (): void => {
      stream.destroy(failure(controller.signal.reason));
    };
    body?.on("error", (error: Error) => {
      stream.destroy(failure(error));
    });
    controller.signal.addEventListener("abort", abortBody, { once: true });
    stream.once("close", cleanup);
    if (controller.signal.aborted) stream.destroy(failure(controller.signal.reason));
    return Object.assign(stream, {
      statusCode: response.statusCode,
      headers: response.headers,
    }) satisfies LinxUpdateHttpResponse;
  };
}
