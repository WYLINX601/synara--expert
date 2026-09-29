import { createServer } from "node:http";

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

async function makeHttpFixture() {
  const mcpServer = new McpServer({ name: "expert-fixture", version: "1.0.0" });
  let startedWait!: () => void;
  let cancelledWait!: () => void;
  const waitStarted = new Promise<void>((resolve) => (startedWait = resolve));
  const waitCancelled = new Promise<void>((resolve) => (cancelledWait = resolve));

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
    authorizedRequests: () => authorizedRequests,
    close: async () => {
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
