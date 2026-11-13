import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import {
  assertLinxUpdateUrlAllowed,
  fetchLinxUpdateBytes,
  LinxUpdateFeedError,
  openLinxUpdateStream,
  parseLinxUpdateRetryAfterMs,
} from "./linxUpdateFeed";

type Handler = (request: IncomingMessage, response: ServerResponse) => void;

let server: Server | null = null;

async function startServer(handler: Handler): Promise<string> {
  server = createServer(handler);
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", () => resolve()));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

afterEach(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
  }
});

describe("assertLinxUpdateUrlAllowed", () => {
  it("accepts GitHub hosts over HTTPS", () => {
    expect(() =>
      assertLinxUpdateUrlAllowed(new URL("https://github.com/a/b/releases/latest/download/x"), [
        "github.com",
      ]),
    ).not.toThrow();
  });

  it("rejects hosts outside the allow list before any connection", () => {
    expect(() =>
      assertLinxUpdateUrlAllowed(new URL("https://example.com/x"), ["github.com"]),
    ).toThrowError(expect.objectContaining({ reason: "host" }));
  });

  it("rejects plain HTTP for a non-loopback host", () => {
    expect(() =>
      assertLinxUpdateUrlAllowed(new URL("http://example.com/x"), ["example.com"]),
    ).toThrowError(expect.objectContaining({ reason: "protocol" }));
  });

  it("rejects URLs carrying credentials", () => {
    expect(() =>
      assertLinxUpdateUrlAllowed(new URL("https://user:secret@github.com/x"), ["github.com"]),
    ).toThrowError(expect.objectContaining({ reason: "url" }));
  });

  it("rejects an explicit non-default HTTPS port", () => {
    expect(() =>
      assertLinxUpdateUrlAllowed(new URL("https://github.com:8443/x"), ["github.com"]),
    ).toThrowError(expect.objectContaining({ reason: "host" }));
  });
});

describe("parseLinxUpdateRetryAfterMs", () => {
  it("parses delta seconds", () => {
    expect(parseLinxUpdateRetryAfterMs("2", 0)).toBe(2_000);
  });

  it("parses an HTTP date", () => {
    const now = Date.parse("2026-11-13T00:00:00Z");
    expect(parseLinxUpdateRetryAfterMs("Fri, 13 Nov 2026 00:00:05 GMT", now)).toBe(5_000);
  });

  it("ignores missing, malformed, and past values", () => {
    expect(parseLinxUpdateRetryAfterMs(undefined, 0)).toBeNull();
    expect(parseLinxUpdateRetryAfterMs("soon", 0)).toBeNull();
    expect(
      parseLinxUpdateRetryAfterMs(
        "Fri, 13 Nov 2026 00:00:00 GMT",
        Date.parse("2026-11-14T00:00:00Z"),
      ),
    ).toBe(0);
  });
});

describe("fetchLinxUpdateBytes", () => {
  it("refuses a loopback host that is not in the source allow list", async () => {
    const baseUrl = await startServer((_request, response) => response.end("should not be read"));

    await expect(
      fetchLinxUpdateBytes({
        url: `${baseUrl}/manifest.json`,
        allowedHosts: ["github.com"],
        maxBytes: 100,
      }),
    ).rejects.toMatchObject({ reason: "host" });
  });

  it("refuses an HTTPS URL on a host outside the allow list without connecting", async () => {
    await expect(
      fetchLinxUpdateBytes({
        url: "https://example.com/linx-update.json",
        allowedHosts: ["github.com"],
        maxBytes: 100,
      }),
    ).rejects.toMatchObject({ reason: "host" });
  });

  it("returns the exact bytes of an allowed payload", async () => {
    const baseUrl = await startServer((_request, response) => {
      response.writeHead(200, { "content-length": "5" });
      response.end("hello");
    });

    const bytes = await fetchLinxUpdateBytes({
      url: `${baseUrl}/manifest.json`,
      allowedHosts: ["127.0.0.1"],
      maxBytes: 1024,
    });

    expect(Buffer.from(bytes).toString("utf8")).toBe("hello");
  });

  it("follows a redirect that stays on an allowed host", async () => {
    const baseUrl = await startServer((request, response) => {
      if (request.url === "/start") {
        response.writeHead(302, { location: "/final" });
        response.end();
        return;
      }
      response.end("final-bytes");
    });

    const bytes = await fetchLinxUpdateBytes({
      url: `${baseUrl}/start`,
      allowedHosts: ["127.0.0.1"],
      maxBytes: 1024,
    });

    expect(Buffer.from(bytes).toString("utf8")).toBe("final-bytes");
  });

  it("refuses a redirect to a host outside the allow list", async () => {
    const baseUrl = await startServer((_request, response) => {
      response.writeHead(302, { location: "https://evil.example/payload" });
      response.end();
    });

    await expect(
      fetchLinxUpdateBytes({
        url: `${baseUrl}/start`,
        allowedHosts: ["127.0.0.1"],
        maxBytes: 1024,
      }),
    ).rejects.toMatchObject({ reason: "host" });
  });

  it("stops after the redirect budget", async () => {
    const baseUrl = await startServer((_request, response) => {
      response.writeHead(302, { location: "/loop" });
      response.end();
    });

    await expect(
      fetchLinxUpdateBytes({
        url: `${baseUrl}/loop`,
        allowedHosts: ["127.0.0.1"],
        maxBytes: 1024,
        maxRedirects: 2,
      }),
    ).rejects.toMatchObject({ reason: "redirect" });
  });

  it("reports HTTP failures with their status code", async () => {
    const baseUrl = await startServer((_request, response) => {
      response.writeHead(404);
      response.end("missing");
    });

    await expect(
      fetchLinxUpdateBytes({
        url: `${baseUrl}/missing`,
        allowedHosts: ["127.0.0.1"],
        maxBytes: 1024,
      }),
    ).rejects.toMatchObject({ reason: "status", statusCode: 404 });
  });

  it("surfaces Retry-After on a 429", async () => {
    const baseUrl = await startServer((_request, response) => {
      response.writeHead(429, { "retry-after": "2" });
      response.end();
    });

    const error = await fetchLinxUpdateBytes({
      url: `${baseUrl}/manifest.json`,
      allowedHosts: ["127.0.0.1"],
      maxBytes: 1024,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(LinxUpdateFeedError);
    expect(error).toMatchObject({ reason: "status", statusCode: 429, retryAfterMs: 2_000 });
  });

  it("refuses a declared body larger than the limit", async () => {
    const baseUrl = await startServer((_request, response) => {
      response.writeHead(200, { "content-length": "64" });
      response.end("x".repeat(64));
    });

    await expect(
      fetchLinxUpdateBytes({
        url: `${baseUrl}/manifest.json`,
        allowedHosts: ["127.0.0.1"],
        maxBytes: 16,
      }),
    ).rejects.toMatchObject({ reason: "size" });
  });

  it("refuses a streamed body that grows past the limit", async () => {
    const baseUrl = await startServer((_request, response) => {
      response.writeHead(200);
      response.write("y".repeat(40));
      response.end();
    });

    await expect(
      fetchLinxUpdateBytes({
        url: `${baseUrl}/manifest.json`,
        allowedHosts: ["127.0.0.1"],
        maxBytes: 16,
      }),
    ).rejects.toMatchObject({ reason: "size" });
  });

  it("times out a silent server", async () => {
    const baseUrl = await startServer(() => {
      // Never respond.
    });

    await expect(
      fetchLinxUpdateBytes({
        url: `${baseUrl}/manifest.json`,
        allowedHosts: ["127.0.0.1"],
        maxBytes: 1024,
        timeoutMs: 50,
      }),
    ).rejects.toMatchObject({ reason: "timeout" });
  });

  it("reports cancellation as aborted", async () => {
    const baseUrl = await startServer((_request, response) => response.end("late"));
    const controller = new AbortController();
    controller.abort();

    await expect(
      fetchLinxUpdateBytes({
        url: `${baseUrl}/manifest.json`,
        allowedHosts: ["127.0.0.1"],
        maxBytes: 1024,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ reason: "aborted" });
  });
});

describe("openLinxUpdateStream", () => {
  it("returns an unconsumed body with its declared length", async () => {
    const baseUrl = await startServer((_request, response) => {
      response.writeHead(200, { "content-length": "3" });
      response.end("abc");
    });

    const opened = await openLinxUpdateStream({
      url: `${baseUrl}/asset.zip`,
      allowedHosts: ["127.0.0.1"],
    });

    expect(opened.statusCode).toBe(200);
    expect(opened.contentLength).toBe(3);
    expect(opened.finalUrl).toBe(`${baseUrl}/asset.zip`);
    opened.stream.destroy();
  });
});
