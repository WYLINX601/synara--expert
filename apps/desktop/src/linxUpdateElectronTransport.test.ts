import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { setImmediate as nextTurn } from "node:timers/promises";
import type { Session } from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createLinxUpdateElectronRequest } from "./linxUpdateElectronTransport";
import { fetchLinxUpdateBytes } from "./linxUpdateFeed";

const native = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("electron", () => ({ net: native }));

class NativeRequest extends EventEmitter {
  response?: Readable;
  end = vi.fn();
  abort = vi.fn(() => this.response?.destroy());
  followRedirect = vi.fn();
}

// No Session methods are used by the adapter: this sentinel tests exact forwarding.
const networkSession = {} as unknown as Session;
const request = createLinxUpdateElectronRequest(networkSession);
const options = { timeoutMs: 1_000, accept: "application/octet-stream" };
let requests: NativeRequest[];
const streams: Readable[] = [];

beforeEach(() => {
  requests = [];
  native.request.mockReset().mockImplementation(() => {
    const transaction = new NativeRequest();
    requests.push(transaction);
    return transaction;
  });
});

afterEach(() => {
  for (const stream of streams.splice(0)) stream.destroy();
  for (const transaction of requests) transaction.abort();
  vi.useRealTimers();
});

describe("createLinxUpdateElectronRequest", () => {
  it("returns a redirect hop without ever following it inside Electron", async () => {
    const pending = request(new URL("https://github.com/release"), options);
    const transaction = requests[0]!;
    transaction.emit("redirect", 302, "GET", "https://release-assets.githubusercontent.com/asset", {
      location: ["https://release-assets.githubusercontent.com/asset"],
    });
    // A late cancellation error must not replace the captured redirect response.
    transaction.emit("error", new Error("Redirect was cancelled"));
    const response = await pending;
    streams.push(response);
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe("https://release-assets.githubusercontent.com/asset");
    expect(transaction.abort).toHaveBeenCalled();
    expect(transaction.followRedirect).not.toHaveBeenCalled();
    expect(native.request).toHaveBeenCalledWith({
      url: "https://github.com/release",
      session: networkSession,
      method: "GET",
      redirect: "manual",
      credentials: "omit",
      cache: "no-store",
      headers: { "user-agent": "linx-desktop", accept: options.accept },
      bypassCustomProtocolHandlers: true,
    });
  });

  it("lets Feed reject a redirect target before a second native request", async () => {
    const pending = fetchLinxUpdateBytes({
      url: "https://github.com/release",
      allowedHosts: ["github.com"],
      maxBytes: 128,
      request,
    });
    const rejection = expect(pending).rejects.toMatchObject({ reason: "host" });
    requests[0]!.emit("redirect", 302, "GET", "https://unapproved.invalid/asset", {});
    await rejection;
    expect(native.request).toHaveBeenCalledTimes(1);
    expect(requests[0]!.followRedirect).not.toHaveBeenCalled();
  });

  it("lets Feed issue a separately validated allowed redirect", async () => {
    const pending = fetchLinxUpdateBytes({
      url: "https://github.com/release",
      allowedHosts: ["github.com", "release-assets.githubusercontent.com"],
      maxBytes: 128,
      request,
    });
    requests[0]!.emit(
      "redirect",
      302,
      "GET",
      "https://release-assets.githubusercontent.com/asset",
      {},
    );
    await nextTurn();
    const body = Object.assign(Readable.from([Buffer.from("payload")]), {
      statusCode: 200,
      headers: { "content-length": "7" },
    });
    requests[1]!.response = body;
    requests[1]!.emit("response", body);
    expect(Buffer.from(await pending).toString()).toBe("payload");
    expect(native.request).toHaveBeenCalledTimes(2);
    expect(
      requests.every((transaction) => transaction.followRedirect.mock.calls.length === 0),
    ).toBe(true);
  });

  it("preserves TLS failures as network errors with their original cause", async () => {
    const pending = request(new URL("https://github.com/asset"), options);
    const rejection = expect(pending).rejects.toMatchObject({
      reason: "network",
      cause: { message: "net::ERR_CERT_AUTHORITY_INVALID" },
    });
    requests[0]!.emit("error", new Error("net::ERR_CERT_AUTHORITY_INVALID"));
    await rejection;
    expect(requests[0]!.abort).toHaveBeenCalled();
  });

  it("cancels before sending a pre-aborted request", async () => {
    const signal = AbortSignal.abort();
    await expect(
      request(new URL("https://github.com/asset"), { ...options, signal }),
    ).rejects.toMatchObject({ reason: "aborted" });
    expect(requests[0]!.end).not.toHaveBeenCalled();
    expect(requests[0]!.abort).toHaveBeenCalled();
  });

  it("keeps response body consumption cancelable", async () => {
    const controller = new AbortController();
    const pending = fetchLinxUpdateBytes({
      url: "https://github.com/asset",
      allowedHosts: ["github.com"],
      maxBytes: 128,
      request,
      signal: controller.signal,
    });
    const rejection = expect(pending).rejects.toMatchObject({ reason: "aborted" });
    const body = Object.assign(new Readable({ read() {} }), { statusCode: 200, headers: {} });
    requests[0]!.response = body;
    requests[0]!.emit("response", body);
    await nextTurn();
    controller.abort();
    await rejection;
    expect(body.destroyed).toBe(true);
  });

  it("times out while waiting for headers", async () => {
    vi.useFakeTimers();
    const pending = request(new URL("https://github.com/asset"), options);
    const rejection = expect(pending).rejects.toMatchObject({ reason: "timeout" });
    await vi.advanceTimersByTimeAsync(options.timeoutMs);
    await rejection;
    expect(requests[0]!.abort).toHaveBeenCalled();
  });

  it("times out a stalled response body", async () => {
    vi.useFakeTimers();
    const pending = fetchLinxUpdateBytes({
      url: "https://github.com/asset",
      allowedHosts: ["github.com"],
      maxBytes: 128,
      timeoutMs: 100,
      request,
    });
    const rejection = expect(pending).rejects.toMatchObject({ reason: "timeout" });
    const body = Object.assign(new Readable({ read() {} }), { statusCode: 200, headers: {} });
    requests[0]!.response = body;
    requests[0]!.emit("response", body);
    await vi.advanceTimersByTimeAsync(101);
    await rejection;
    expect(body.destroyed).toBe(true);
  });

  it("does not drain an unconsumed native body into an unbounded queue", async () => {
    let produced = 0;
    const chunk = Buffer.alloc(16 * 1024);
    const body = Object.assign(
      new Readable({
        highWaterMark: chunk.length,
        read() {
          produced += chunk.length;
          this.push(chunk);
        },
      }),
      { statusCode: 200, headers: {} },
    );
    const pending = request(new URL("https://github.com/asset"), options);
    requests[0]!.response = body;
    requests[0]!.emit("response", body);
    const response = await pending;
    streams.push(response);
    response.read(0);
    await nextTurn();
    expect(produced).toBeLessThanOrEqual(
      response.readableHighWaterMark + body.readableHighWaterMark + 2 * chunk.length,
    );
    response.destroy();
    await nextTurn();
    expect(body.destroyed).toBe(true);
    expect(requests[0]!.abort).toHaveBeenCalled();
  });

  it("bounds oversized native chunks without changing their bytes", async () => {
    const payload = Buffer.allocUnsafe(512 * 1024);
    for (let index = 0; index < payload.length; index += 1) payload[index] = index % 251;
    const body = Object.assign(Readable.from([payload]), { statusCode: 200, headers: {} });
    const pending = request(new URL("https://github.com/asset"), options);
    requests[0]!.response = body;
    requests[0]!.emit("response", body);
    const response = await pending;
    streams.push(response);
    response.read(0);
    await nextTurn();
    expect(response.readableLength).toBeLessThanOrEqual(response.readableHighWaterMark + 64 * 1024);
    const chunks: Buffer[] = [];
    for await (const chunk of response) chunks.push(chunk);
    expect(Buffer.concat(chunks).equals(payload)).toBe(true);
  });

  it("cleans up timeout and cancellation listeners when request construction throws", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    native.request.mockImplementationOnce(() => {
      throw new Error("session unavailable");
    });
    await expect(
      request(new URL("https://github.com/asset"), { ...options, signal: controller.signal }),
    ).rejects.toMatchObject({ reason: "network", cause: { message: "session unavailable" } });
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
  });
});
