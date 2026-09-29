#!/usr/bin/env node
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import http from "node:http";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const sdkRoot = process.env.MCP_SDK_ROOT;
if (!sdkRoot) throw new Error("Set MCP_SDK_ROOT to the temporary MCP SDK package directory.");
const sdkRequire = createRequire(resolve(sdkRoot, "gateway-probe-loader.cjs"));
const { Client } = sdkRequire("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = sdkRequire("@modelcontextprotocol/sdk/client/stdio.js");
const { StreamableHTTPClientTransport } = sdkRequire(
  "@modelcontextprotocol/sdk/client/streamableHttp.js",
);
const { McpServer } = sdkRequire("@modelcontextprotocol/sdk/server/mcp.js");
const { StdioServerTransport } = sdkRequire("@modelcontextprotocol/sdk/server/stdio.js");
const { StreamableHTTPServerTransport } = sdkRequire(
  "@modelcontextprotocol/sdk/server/streamableHttp.js",
);
const { z } = sdkRequire("zod/v4");

const scriptPath = fileURLToPath(import.meta.url);
const toolNames = ["expert_probe_echo", "expert_probe_error", "expert_probe_wait"];
const timeout = (promise, label) => {
  let timer;
  return Promise.race([
    promise,
    new Promise(
      (_, reject) => (timer = setTimeout(() => reject(new Error(`${label} timed out`)), 5000)),
    ),
  ]).finally(() => clearTimeout(timer));
};

function makeFixture(onWaitStarted = () => {}, onWaitCancelled = () => {}) {
  const server = new McpServer({ name: "synara-expert-p0-fixture", version: "1.0.0" });
  server.registerTool(
    "expert_probe_echo",
    {
      description: "Return text, image, and structured output.",
      inputSchema: { text: z.string() },
    },
    async ({ text }) => ({
      content: [
        { type: "text", text: `echo:${text}` },
        { type: "image", data: "AQID", mimeType: "image/png" },
      ],
      structuredContent: { echo: text },
    }),
  );
  server.registerTool(
    "expert_probe_error",
    { description: "Return an MCP tool error.", inputSchema: {} },
    async () => ({ isError: true, content: [{ type: "text", text: "fixture-error" }] }),
  );
  server.registerTool(
    "expert_probe_wait",
    { description: "Wait for protocol cancellation.", inputSchema: {} },
    async (_args, extra) => {
      onWaitStarted();
      await new Promise((_, reject) => {
        const cancel = () => {
          onWaitCancelled();
          reject(new Error("fixture request cancelled"));
        };
        if (extra.signal.aborted) cancel();
        else extra.signal.addEventListener("abort", cancel, { once: true });
      });
      return { content: [{ type: "text", text: "unreachable" }] };
    },
  );
  return server;
}

function deferred() {
  let resolvePromise;
  const promise = new Promise((resolve) => (resolvePromise = resolve));
  return { promise, resolve: resolvePromise };
}

async function checkClient(client, onWaitStarted, onWaitCancelled) {
  const listed = await client.listTools();
  assert.deepEqual(listed.tools.map(({ name }) => name).toSorted(), [...toolNames].toSorted());

  const result = await client.callTool({ name: "expert_probe_echo", arguments: { text: "ok" } });
  assert.equal(result.content[0]?.text, "echo:ok");
  assert.deepEqual(result.content[1], { type: "image", data: "AQID", mimeType: "image/png" });
  assert.deepEqual(result.structuredContent, { echo: "ok" });

  const toolError = await client.callTool({ name: "expert_probe_error", arguments: {} });
  assert.equal(toolError.isError, true);
  assert.equal(toolError.content[0]?.text, "fixture-error");

  const controller = new AbortController();
  const call = client.callTool({ name: "expert_probe_wait", arguments: {} }, undefined, {
    signal: controller.signal,
  });
  await timeout(onWaitStarted.promise, "fixture tool start");
  controller.abort();
  await assert.rejects(call, (error) => error?.name === "McpError" && error.code === -32001);
  await timeout(onWaitCancelled.promise, "fixture cancellation delivery");
}

async function runStdio() {
  const started = deferred();
  const cancelled = deferred();
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [scriptPath, "--fixture-stdio"],
    env: { MCP_SDK_ROOT: resolve(sdkRoot) },
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr?.on("data", (chunk) => {
    stderr += String(chunk);
    if (stderr.includes("wait-started")) started.resolve();
    if (stderr.includes("wait-cancelled")) {
      cancelled.resolve();
    }
  });
  const closed = deferred();
  // The SDK transport exposes close as a callback property, not an EventTarget.
  // oxlint-disable-next-line unicorn/prefer-add-event-listener
  transport.onclose = () => closed.resolve();
  const client = new Client({ name: "synara-expert-p0-probe", version: "1.0.0" });
  try {
    await client.connect(transport);
    await checkClient(client, started, cancelled);
  } finally {
    await client.close();
  }
  await timeout(closed.promise, "stdio close");
  assert.equal(transport.pid, null);
  assert.ok(stderr.includes("wait-cancelled"));
  return "stdio list/call/text+image+structured/error/cancel/child-close passed";
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function runStreamableHttp() {
  const started = deferred();
  const cancelled = deferred();
  const sessions = new Map();
  const httpServer = http.createServer(async (request, response) => {
    try {
      if (request.headers.authorization !== "Bearer probe-only") {
        response.writeHead(401).end();
        return;
      }
      const sessionId = request.headers["mcp-session-id"];
      let session = typeof sessionId === "string" ? sessions.get(sessionId) : undefined;
      if (request.method === "POST") {
        const body = await readJson(request);
        if (!session && body.method === "initialize") {
          const mcpServer = makeFixture(
            () => started.resolve(),
            () => cancelled.resolve(),
          );
          let transport;
          transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: randomUUID,
            onsessioninitialized: (id) => sessions.set(id, { mcpServer, transport }),
          });
          // The SDK transport exposes close as a callback property, not an EventTarget.
          // oxlint-disable-next-line unicorn/prefer-add-event-listener
          transport.onclose = () => {
            if (transport.sessionId) sessions.delete(transport.sessionId);
          };
          await mcpServer.connect(transport);
          await transport.handleRequest(request, response, body);
          return;
        }
        if (!session) {
          response.writeHead(404).end();
          return;
        }
        await session.transport.handleRequest(request, response, body);
        return;
      }
      if ((request.method === "GET" || request.method === "DELETE") && session) {
        await session.transport.handleRequest(request, response);
        return;
      }
      response.writeHead(405).end();
    } catch (error) {
      if (!response.headersSent) response.writeHead(500);
      response.end(error instanceof Error ? error.message : "fixture error");
    }
  });
  httpServer.listen(0, "127.0.0.1");
  await new Promise((resolveListen, reject) => {
    httpServer.once("listening", resolveListen);
    httpServer.once("error", reject);
  });
  const address = httpServer.address();
  assert.ok(address && typeof address === "object");

  const transport = new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${address.port}/mcp`),
    { requestInit: { headers: { Authorization: "Bearer probe-only" } } },
  );
  const client = new Client({ name: "synara-expert-p0-probe", version: "1.0.0" });
  try {
    await client.connect(transport);
    await checkClient(client, started, cancelled);
    assert.equal(sessions.size, 1);
    await transport.terminateSession();
    assert.equal(sessions.size, 0);
  } finally {
    await client.close();
    for (const { transport: serverTransport, mcpServer } of sessions.values()) {
      await serverTransport.close();
      await mcpServer.close();
    }
    await new Promise((resolveClose, reject) =>
      httpServer.close((error) => (error ? reject(error) : resolveClose())),
    );
  }
  return "Streamable HTTP auth header/list/call/text+image+structured/error/cancel/session-delete passed";
}

async function runStdioFixture() {
  const server = makeFixture(
    () => process.stderr.write("wait-started\n"),
    () => process.stderr.write("wait-cancelled\n"),
  );
  await server.connect(new StdioServerTransport());
}

if (process.argv.includes("--fixture-stdio")) {
  await runStdioFixture();
} else {
  const stdioResult = await runStdio();
  const httpResult = await runStreamableHttp();
  const sdkVersion = JSON.parse(
    readFileSync(resolve(sdkRoot, "node_modules/@modelcontextprotocol/sdk/package.json"), "utf8"),
  ).version;
  process.stdout.write(`MCP SDK ${sdkVersion}\n`);
  process.stdout.write(`${stdioResult}\n${httpResult}\n`);
}
