import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type ServerResponse } from "node:http";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { AnySchema } from "@modelcontextprotocol/sdk/server/zod-compat.js";
import type { ExpertConnectionConfig } from "@synara/contracts";
import * as z from "zod/v4";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createExpertConnectionStore } from "./ExpertConnectionStore.ts";
import { createExpertMcpCredentialStore } from "./ExpertMcpCredentials.ts";
import { collectExpertMcpTools, connectExpertMcp } from "./ExpertMcpClient.ts";
import { createLocalMcpDiscovery } from "./LocalMcpDiscovery.ts";
import { startWorkbenchRuntimeMcpFixture } from "../../../../scripts/lib/workbench-runtime-mcp-fixture.ts";

const originalToken = process.env.SYNARA_EXPERT_MCP_TEST_TOKEN;

afterEach(() => {
  vi.restoreAllMocks();
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

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Fixture child process did not exit before the deadline.");
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

async function makeHttpFixture(
  options: {
    hangCancellationNotificationResponse?: boolean;
    redirectSseTo?: { url: string; status: 307 | 308 };
  } = {},
) {
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
    if (request.method === "GET" && options.redirectSseTo) {
      response
        .writeHead(options.redirectSseTo.status, {
          location: options.redirectSseTo.url,
        })
        .end();
      return;
    }
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
      const closed = new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      // A failed assertion must still tear down requests that never reached an
      // end state; otherwise server.close() can hold Vitest until its test-wide
      // timeout and hide the original lifecycle failure.
      server.closeAllConnections();
      await closed;
      await mcpServer.close();
    },
  };
}

async function makeRedirectReceiver() {
  const received: Array<{ apiKey: string | string[] | undefined; body: string }> = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      received.push({
        apiKey: request.headers["x-api-key"],
        body: Buffer.concat(chunks).toString(),
      });
      response.writeHead(405).end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Receiver has no TCP address.");
  return {
    url: `http://127.0.0.1:${address.port}/capture`,
    received,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

describe("connectExpertMcp", () => {
  it.each([307, 308] as const)(
    "does not forward credentials or POST bodies across a %i redirect",
    async (status) => {
      process.env.SYNARA_EXPERT_MCP_TEST_TOKEN = "fixture-api-key";
      const receiver = await makeRedirectReceiver();
      let sourceRequests = 0;
      const server = createServer((request, response) => {
        sourceRequests += 1;
        request.resume();
        response.writeHead(status, { location: receiver.url }).end();
      });
      try {
        await new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen(0, "127.0.0.1", resolve);
        });
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("Source has no TCP address.");
        await expect(
          connectExpertMcp(
            connectionConfig({
              type: "http",
              url: `http://127.0.0.1:${address.port}/mcp`,
              headersFromHost: [{ name: "X-API-Key", envVar: "SYNARA_EXPERT_MCP_TEST_TOKEN" }],
            }),
          ),
        ).rejects.toThrow();
        expect(sourceRequests).toBe(1);
        expect(receiver.received).toEqual([]);
      } finally {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        });
        await receiver.close();
      }
    },
  );

  it.each([307, 308] as const)(
    "does not forward SSE GET credentials across a %i redirect",
    async (status) => {
      process.env.SYNARA_EXPERT_MCP_TEST_TOKEN = "fixture-token";
      const receiver = await makeRedirectReceiver();
      const fixture = await makeHttpFixture({ redirectSseTo: { url: receiver.url, status } });
      let client: Awaited<ReturnType<typeof connectExpertMcp>> | undefined;
      let sseFinished!: () => void;
      const sseRequestFinished = new Promise<void>((resolve) => {
        sseFinished = resolve;
      });
      const originalFetch = globalThis.fetch;
      vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
        try {
          return await originalFetch(input, init);
        } finally {
          if (String(input) === fixture.url && init?.method === "GET") sseFinished();
        }
      });
      try {
        client = await connectExpertMcp(
          connectionConfig({
            type: "http",
            url: fixture.url,
            headersFromHost: [
              { name: "authorization", envVar: "SYNARA_EXPERT_MCP_TEST_TOKEN", prefix: "Bearer " },
              { name: "X-API-Key", envVar: "SYNARA_EXPERT_MCP_TEST_TOKEN" },
            ],
          }),
        );
        await withTimeout(sseRequestFinished, 5_000, "SSE redirect request");
        expect(receiver.received).toEqual([]);
      } finally {
        await client?.close().catch(() => undefined);
        await fixture.close();
        await receiver.close();
      }
    },
  );

  it("uses one startup timeout budget across tools/list pages", async () => {
    let now = 1_000;
    const timeouts: number[] = [];
    const requestPage = async (cursor: string | undefined, timeoutMs: number) => {
      timeouts.push(timeoutMs);
      if (cursor === undefined) {
        now += 40;
        return { tools: [], nextCursor: "page-two" };
      }
      return { tools: [] };
    };

    await expect(collectExpertMcpTools(requestPage, 100, () => now)).resolves.toEqual([]);
    expect(timeouts).toEqual([100, 60]);
  });

  it("does not request another tools/list page after the startup budget expires", async () => {
    let now = 1_000;
    let requestCount = 0;
    const requestPage = async () => {
      requestCount += 1;
      now += 100;
      return { tools: [], nextCursor: "page-two" };
    };

    await expect(collectExpertMcpTools(requestPage, 100, () => now)).rejects.toThrow(
      "startup timeout",
    );
    expect(requestCount).toBe(1);
  });

  it("rejects repeated tools/list cursors instead of looping indefinitely", async () => {
    const fixture = await startWorkbenchRuntimeMcpFixture({ pagination: "repeated-cursor" });

    try {
      await expect(
        connectExpertMcp(connectionConfig({ type: "http", url: fixture.url, headersFromHost: [] })),
      ).rejects.toThrow("repeated pagination cursor");
    } finally {
      await fixture.close();
    }
  });

  it("restores output validation and task guards across tools/list pages", async () => {
    const fixture = await startWorkbenchRuntimeMcpFixture({
      pagination: "two-pages",
      invalidFirstPageOutput: true,
      firstPageTaskSupport: "required",
    });
    let client: Awaited<ReturnType<typeof connectExpertMcp>> | undefined;

    try {
      client = await connectExpertMcp(
        connectionConfig({ type: "http", url: fixture.url, headersFromHost: [] }),
      );
      await expect(client.callTool("workbench_probe_echo", { value: "invalid" })).rejects.toThrow(
        "output schema",
      );
      await expect(client.callTool("workbench_probe_required", {})).rejects.toThrow(
        "requires task-based execution",
      );
      expect(fixture.stats().echoCalls).toBe(1);
      expect(fixture.stats().paginatedToolCalls).toBe(0);
      expect(fixture.stats().requiredTaskToolCalls).toBe(0);
    } finally {
      await client?.close().catch(() => undefined);
      await fixture.close();
    }
  });

  it("uses Synara-owned credentials for HTTP headers", async () => {
    const root = await mkdtemp(join(tmpdir(), "synara-mcp-http-secret-"));
    const credentials = createExpertMcpCredentialStore(join(root, "state"));
    const credentialId = await credentials.create({
      env: {},
      headers: { authorization: "Bearer fixture-token" },
    });
    const fixture = await makeHttpFixture();
    let client: Awaited<ReturnType<typeof connectExpertMcp>> | undefined;

    try {
      client = await connectExpertMcp(
        connectionConfig({
          type: "http",
          url: fixture.url,
          headersFromHost: [],
          headersFromSecret: { credentialId, names: ["authorization"] },
        }),
        { credentials },
      );
      expect(client.tools.map((tool) => tool.name)).toContain("echo");
      expect(fixture.authorizedRequests()).toBeGreaterThan(0);
    } finally {
      await client?.close().catch(() => undefined);
      await fixture.close();
      await rm(root, { recursive: true, force: true });
    }
  });

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
      await withTimeout(fixture.waitStarted, 5_000, "downstream HTTP tool start");

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

  it("imports Codex literal env references and verifies stdio cwd, timeouts, and child cleanup", async () => {
    const root = await mkdtemp(join(tmpdir(), "synara-mcp-stdio-source-"));
    const sourcePath = join(root, "config.toml");
    const stateDir = join(root, "state");
    const cwd = join(root, "workspace");
    const markerPath = join(root, "fixture-result.txt");
    await mkdir(cwd);
    const expectedCwd = await realpath(cwd);
    const envNames = Array.from(
      { length: 16 },
      (_, index) => `FIXTURE_ENV_${String(index + 1).padStart(2, "0")}`,
    );
    const sourceSecrets = Object.fromEntries(
      envNames.map((name, index) => [name, `source-literal-secret-${index + 1}`]),
    );
    const expectedNames = JSON.stringify(envNames);
    const script = [
      `const fs = require("node:fs");`,
      `const names = ${expectedNames};`,
      `const envOk = names.every((name) => Object.hasOwn(process.env, name) && process.env[name].length > 0);`,
      `const cwdOk = process.cwd() === ${JSON.stringify(expectedCwd)};`,
      `fs.writeFileSync(${JSON.stringify(markerPath)}, JSON.stringify({ envOk, cwdOk }));`,
      `const readline = require("node:readline");`,
      `const input = readline.createInterface({ input: process.stdin });`,
      `input.on("line", (line) => {`,
      `  let request; try { request = JSON.parse(line); } catch { return; }`,
      `  if (request.id === undefined) return;`,
      `  let result = {};`,
      `  if (request.method === "initialize") result = { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "local-fixture", version: "1" } };`,
      `  if (request.method === "tools/list") result = { tools: [{ name: "fixture", description: "pid:" + process.pid, inputSchema: { type: "object", properties: {} } }] };`,
      `  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\\n");`,
      `});`,
    ].join("");
    const envToml = Object.entries(sourceSecrets)
      .map(([name, value]) => `${name} = ${JSON.stringify(value)}`)
      .join("\n");
    await writeFile(
      sourcePath,
      `[mcp_servers.fixture]\ncommand = ${JSON.stringify(process.execPath)}\nargs = ["-e", ${JSON.stringify(script)}]\ncwd = ${JSON.stringify(cwd)}\nstartup_timeout_sec = 15\ntool_timeout_sec = 5\n[mcp_servers.fixture.env]\n${envToml}\n`,
    );

    const connections = createExpertConnectionStore(stateDir);
    const credentials = createExpertMcpCredentialStore(stateDir);
    const discovery = createLocalMcpDiscovery({ connections, credentials, homeDir: root });
    const scan = await discovery.discover({ sources: [{ kind: "codex", path: sourcePath }] });
    const candidate = scan.candidates.find((entry) => entry.name === "fixture");
    expect(candidate).toMatchObject({ status: "ready", sourceEntryId: "fixture" });
    expect(JSON.stringify(scan)).not.toContain("source-literal-secret");

    const imported = await discovery.importSelected({
      scanId: scan.scanId,
      items: [
        { candidateId: candidate!.candidateId, targetId: "mcp_codex_fixture", mode: "create" },
      ],
    });
    expect(imported.items).toMatchObject([{ status: "imported", revision: 1 }]);
    const stored = await connections.read("mcp_codex_fixture");
    expect(stored?.transport).toMatchObject({
      type: "stdio",
      cwd,
      startupTimeoutMs: 15_000,
      toolTimeoutMs: 5_000,
      envFromHost: [],
      envFromSecret: { credentialId: expect.any(String), names: envNames },
    });
    expect(stored?.importedFrom).toEqual([{ kind: "codex", path: sourcePath, entryId: "fixture" }]);
    expect(JSON.stringify(stored)).not.toContain("source-literal-secret");
    await rm(sourcePath);

    let client: Awaited<ReturnType<typeof connectExpertMcp>> | undefined;
    let childPid: number | undefined;
    try {
      const reopenedConnections = createExpertConnectionStore(stateDir);
      const reopenedCredentials = createExpertMcpCredentialStore(stateDir);
      const reopenedStored = await reopenedConnections.read("mcp_codex_fixture");
      expect(reopenedStored).toEqual(stored);
      client = await connectExpertMcp(reopenedStored!, { credentials: reopenedCredentials });
      expect(client.tools.map((tool) => tool.name)).toContain("fixture");
      const pidDescription =
        client.tools.find((tool) => tool.name === "fixture")?.description ?? "";
      const match = /^pid:(\d+)$/u.exec(pidDescription);
      expect(match).not.toBeNull();
      childPid = Number(match![1]);
      expect(JSON.parse(await readFile(markerPath, "utf8"))).toEqual({ envOk: true, cwdOk: true });
      expect(JSON.stringify(client.tools)).not.toContain("source-literal-secret");
      await client.close();
      client = undefined;
      await waitForProcessExit(childPid, 2_000);
    } finally {
      await client?.close().catch(() => undefined);
      if (childPid !== undefined) await waitForProcessExit(childPid, 2_000).catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  }, 15_000);

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
    ).rejects.toThrow("Expert MCP credential is unavailable or invalid.");
  });
});
