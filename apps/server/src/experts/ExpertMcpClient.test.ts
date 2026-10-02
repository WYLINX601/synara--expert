import { createServer, type ServerResponse } from "node:http";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { AnySchema } from "@modelcontextprotocol/sdk/server/zod-compat.js";
import type { ExpertConnectionConfig } from "@synara/contracts";
import * as z from "zod/v4";
import { afterEach, describe, expect, it } from "vitest";

import { connectExpertMcp } from "./ExpertMcpClient.ts";

const originalToken = process.env.SYNARA_EXPERT_MCP_TEST_TOKEN;

afterEach(() => {
  if (originalToken === undefined) delete process.env.SYNARA_EXPERT_MCP_TEST_TOKEN;
  else process.env.SYNARA_EXPERT_MCP_TEST_TOKEN = originalToken;
});

function connectionConfig(transport: ExpertConnectionConfig["transport"]): ExpertConnectionConfig {
  return {
    id: "fixture",
    name: "Fixture",
    transport,
    revision: 1,
    updatedAt: "2026-09-26T00:00:00.000Z",
  };
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function makeHttpFixture(options: { hangCancellationNotificationResponse?: boolean } = {}) {
  const mcpServer = new McpServer({ name: "expert-fixture", version: "1.0.0" });
  let startedWait!: () => void;
  let cancelledWait!: () => void;
  let cancellationNotificationHeld!: () => void;
  let cancellationNotificationClosed!: () => void;
  const waitStarted = new Promise<void>((resolve) => (startedWait = resolve));
  const waitCancelled = new Promise<void>((resolve) => (cancelledWait = resolve));
  const waitCancellationNotificationHeld = new Promise<void>(
    (resolve) => (cancellationNotificationHeld = resolve),
  );
  const waitCancellationNotificationClosed = new Promise<void>(
    (resolve) => (cancellationNotificationClosed = resolve),
  );
  let cancellationObserved = false;
  let heldCancellationNotificationPosts = 0;
  let cancellationNotificationResponsesClosedBeforeEnd = 0;
  const heldResponses = new Set<ServerResponse>();
  const interceptedResponses = new WeakSet<ServerResponse>();

  mcpServer.registerTool(
    "echo",
    {
      description: "Echo a value",
      inputSchema: { value: z.string() as unknown as AnySchema },
      outputSchema: { answer: z.string() as unknown as AnySchema },
    },
    ({ value }: { value: string }) => ({
      content: [{ type: "text", text: value }],
      structuredContent: { answer: value },
    }),
  );
  mcpServer.registerTool(
    "wait",
    { description: "Wait for cancellation", inputSchema: {} },
    (_args, extra) => {
      startedWait();
      return new Promise((resolve) => {
        extra.signal.addEventListener(
          "abort",
          () => {
            cancellationObserved = true;
            cancelledWait();
            resolve({ content: [{ type: "text", text: "cancelled" }] });
          },
          { once: true },
        );
      });
    },
  );

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => "expert-fixture-session",
    enableJsonResponse: true,
  });
  await mcpServer.connect(transport as unknown as Transport);

  let authorizedRequests = 0;
  const server = createServer((request, response) => {
    if (request.headers.authorization !== "Bearer fixture-token") {
      response.writeHead(401).end();
      return;
    }
    authorizedRequests += 1;
    const originalEnd = response.end;
    response.end = ((...args: unknown[]) => {
      // The Streamable HTTP server returns 202 for notification-only POSTs.
      // Hold that response after this fixture's wait handler observed cancellation.
      if (
        options.hangCancellationNotificationResponse &&
        cancellationObserved &&
        response.statusCode === 202 &&
        !interceptedResponses.has(response)
      ) {
        interceptedResponses.add(response);
        heldCancellationNotificationPosts += 1;
        heldResponses.add(response);
        response.once("close", () => {
          heldResponses.delete(response);
          if (!response.writableEnded) {
            cancellationNotificationResponsesClosedBeforeEnd += 1;
            cancellationNotificationClosed();
          }
        });
        cancellationNotificationHeld();
        return response;
      }
      return Reflect.apply(originalEnd, response, args) as ServerResponse;
    }) as typeof response.end;
    void transport.handleRequest(request, response).catch((error: unknown) => {
      if (!response.headersSent) response.writeHead(500).end(String(error));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Fixture did not get a TCP address.");

  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    waitStarted,
    waitCancelled,
    waitCancellationNotificationHeld,
    waitCancellationNotificationClosed,
    heldCancellationNotificationPosts: () => heldCancellationNotificationPosts,
    heldCancellationNotificationResponses: () => heldResponses.size,
    cancellationNotificationResponsesClosedBeforeEnd: () =>
      cancellationNotificationResponsesClosedBeforeEnd,
    authorizedRequests: () => authorizedRequests,
    close: async () => {
      for (const response of heldResponses) {
        if (!response.destroyed && !response.writableEnded) response.destroy();
      }
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      await mcpServer.close();
    },
  };
}

describe("connectExpertMcp", () => {
  it("lists and calls HTTP tools, forwards cancellation, and closes the connection", async () => {
    const previousToken = process.env.SYNARA_EXPERT_MCP_TEST_TOKEN;
    process.env.SYNARA_EXPERT_MCP_TEST_TOKEN = "fixture-token";
    const fixture = await makeHttpFixture();
    let client: Awaited<ReturnType<typeof connectExpertMcp>> | undefined;

    try {
      client = await connectExpertMcp(
        connectionConfig({
          type: "http",
          url: fixture.url,
          headersFromHost: [
            { name: "authorization", envVar: "SYNARA_EXPERT_MCP_TEST_TOKEN", prefix: "Bearer " },
          ],
        }),
      );
      expect(client.tools.map((tool) => tool.name)).toContain("echo");
      await expect(client.callTool("echo", { value: "hello" })).resolves.toMatchObject({
        content: [{ type: "text", text: "hello" }],
        structuredContent: { answer: "hello" },
      });

      const controller = new AbortController();
      const pending = client.callTool("wait", {}, controller.signal);
      await fixture.waitStarted;
      controller.abort();
      await expect(pending).rejects.toThrow();
      await fixture.waitCancelled;
      expect(fixture.authorizedRequests()).toBeGreaterThan(0);

      await client.close();
      await expect(client.callTool("echo", { value: "after close" })).rejects.toThrow();
    } finally {
      await client?.close().catch(() => undefined);
      await fixture.close();
      if (previousToken === undefined) delete process.env.SYNARA_EXPERT_MCP_TEST_TOKEN;
      else process.env.SYNARA_EXPERT_MCP_TEST_TOKEN = previousToken;
    }
  });

  it("forwards an HTTP tool abort when the client closes immediately", async () => {
    const previousToken = process.env.SYNARA_EXPERT_MCP_TEST_TOKEN;
    process.env.SYNARA_EXPERT_MCP_TEST_TOKEN = "fixture-token";
    const fixture = await makeHttpFixture();
    let client: Awaited<ReturnType<typeof connectExpertMcp>> | undefined;

    try {
      client = await connectExpertMcp(
        connectionConfig({
          type: "http",
          url: fixture.url,
          headersFromHost: [
            { name: "authorization", envVar: "SYNARA_EXPERT_MCP_TEST_TOKEN", prefix: "Bearer " },
          ],
        }),
      );
      const controller = new AbortController();
      const pending = client.callTool("wait", {}, controller.signal);
      const pendingRejection = expect(
        withTimeout(pending, 5_000, "aborted MCP call"),
      ).rejects.toThrow();
      void pendingRejection.catch(() => undefined);
      await fixture.waitStarted;

      controller.abort();
      const closing = client.close();
      void closing.catch(() => undefined);
      await Promise.all([
        withTimeout(fixture.waitCancelled, 5_000, "downstream HTTP tool abort"),
        pendingRejection,
        withTimeout(closing, 5_000, "immediate MCP client close"),
      ]);

      expect(fixture.authorizedRequests()).toBeGreaterThan(0);
    } finally {
      await client?.close().catch(() => undefined);
      await fixture.close();
      if (previousToken === undefined) delete process.env.SYNARA_EXPERT_MCP_TEST_TOKEN;
      else process.env.SYNARA_EXPERT_MCP_TEST_TOKEN = previousToken;
    }
  });

  it("bounds close and closes its HTTP connection when a cancellation notification POST hangs", async () => {
    const previousToken = process.env.SYNARA_EXPERT_MCP_TEST_TOKEN;
    process.env.SYNARA_EXPERT_MCP_TEST_TOKEN = "fixture-token";
    const fixture = await makeHttpFixture({ hangCancellationNotificationResponse: true });
    let client: Awaited<ReturnType<typeof connectExpertMcp>> | undefined;

    try {
      client = await connectExpertMcp(
        connectionConfig({
          type: "http",
          url: fixture.url,
          headersFromHost: [
            { name: "authorization", envVar: "SYNARA_EXPERT_MCP_TEST_TOKEN", prefix: "Bearer " },
          ],
        }),
      );
      const controller = new AbortController();
      const pending = client.callTool("wait", {}, controller.signal);
      const pendingRejection = expect(
        withTimeout(pending, 5_000, "aborted MCP call"),
      ).rejects.toThrow();
      void pendingRejection.catch(() => undefined);
      await fixture.waitStarted;

      controller.abort();
      const closing = client.close();
      void closing.catch(() => undefined);
      await Promise.all([
        withTimeout(fixture.waitCancelled, 5_000, "downstream HTTP tool abort"),
        withTimeout(
          fixture.waitCancellationNotificationHeld,
          5_000,
          "hanging cancellation notification POST",
        ),
        pendingRejection,
      ]);

      expect(fixture.heldCancellationNotificationPosts()).toBe(1);
      expect(fixture.heldCancellationNotificationResponses()).toBe(1);
      let closeSettled = false;
      void closing.then(
        () => {
          closeSettled = true;
        },
        () => {
          closeSettled = true;
        },
      );
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(closeSettled).toBe(false);

      await withTimeout(closing, 15_000, "bounded MCP client close");
      await withTimeout(
        fixture.waitCancellationNotificationClosed,
        2_000,
        "client closing the held cancellation response",
      );
      expect(fixture.cancellationNotificationResponsesClosedBeforeEnd()).toBe(1);
      expect(fixture.heldCancellationNotificationResponses()).toBe(0);
    } finally {
      await client?.close().catch(() => undefined);
      await fixture.close();
      if (previousToken === undefined) delete process.env.SYNARA_EXPERT_MCP_TEST_TOKEN;
      else process.env.SYNARA_EXPERT_MCP_TEST_TOKEN = previousToken;
    }
  }, 30_000);

  it("fails before connecting when a referenced environment variable is missing", async () => {
    delete process.env.SYNARA_EXPERT_MCP_TEST_TOKEN;
    await expect(
      connectExpertMcp(
        connectionConfig({
          type: "http",
          url: "http://127.0.0.1:1/mcp",
          headersFromHost: [
            { name: "authorization", envVar: "SYNARA_EXPERT_MCP_TEST_TOKEN", prefix: "Bearer " },
          ],
        }),
      ),
    ).rejects.toThrow(/SYNARA_EXPERT_MCP_TEST_TOKEN/u);
  });
});
