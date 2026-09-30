import { randomBytes, randomUUID } from "node:crypto";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import {
  createServer as createNetServer,
  type ListenOptions,
  type Server as NetServer,
  type Socket,
} from "node:net";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { AnySchema } from "@modelcontextprotocol/sdk/server/zod-compat.js";
import * as z from "zod/v4";

const FIXTURE_HOST = "127.0.0.1";
const FIXTURE_PATH = "/mcp";
const LISTEN_TIMEOUT_MS = 5_000;
const CLOSE_TIMEOUT_MS = 3_000;
const MAX_BIND_ATTEMPTS = 8;
const MAX_SIGNAL_WAIT_MS = 30_000;

export type WorkbenchRuntimeMcpFixture = {
  readonly url: string;
  readonly echoMarker: string;
  /** echoCalls is lifetime-cumulative; wait counters are since the last resetWait call. */
  stats(): {
    readonly echoCalls: number;
    readonly waitCalls: number;
    readonly activeWaits: number;
    readonly cancelledWaits: number;
  };
  waitForWaitStart(timeoutMs: number): Promise<void>;
  waitForWaitAbort(timeoutMs: number): Promise<void>;
  /** Rotate wait event gates and clear wait counters; active wait requests must be zero. */
  resetWait(): void;
  close(): Promise<void>;
};

type SignalGate = {
  readonly promise: Promise<void>;
  resolve(): void;
};

function makeSignalGate(): SignalGate {
  let resolvePromise!: () => void;
  let resolved = false;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve: () => {
      if (resolved) return;
      resolved = true;
      resolvePromise();
    },
  };
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_SIGNAL_WAIT_MS) {
    return Promise.reject(new Error(`invalid-${label}-timeout`));
  }
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label}-timed-out`)), timeoutMs);
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

function listen(
  server: HttpServer | NetServer,
  options: ListenOptions,
  label: string,
): Promise<void> {
  const listening = new Promise<void>((resolve, reject) => {
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(options);
  });
  return withTimeout(listening, LISTEN_TIMEOUT_MS, label);
}

function trackSocket(socket: Socket, sockets: Set<Socket>): void {
  sockets.add(socket);
  socket.once("close", () => sockets.delete(socket));
}

function isIpv6Unavailable(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) return false;
  return ["EAFNOSUPPORT", "EADDRNOTAVAIL", "EPROTONOSUPPORT"].includes(String(error.code));
}

async function stopNetServer(server: NetServer, sockets: ReadonlySet<Socket>): Promise<void> {
  const closed = server.listening
    ? new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      })
    : Promise.resolve();
  for (const socket of sockets) socket.destroy();
  await withTimeout(closed, CLOSE_TIMEOUT_MS, "ipv6-fixture-close");
}

async function stopHttpServer(server: HttpServer, sockets: ReadonlySet<Socket>): Promise<void> {
  const closed = server.listening
    ? new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      })
    : Promise.resolve();
  server.closeIdleConnections();
  server.closeAllConnections();
  for (const socket of sockets) socket.destroy();
  await withTimeout(closed, CLOSE_TIMEOUT_MS, "http-fixture-close");
}

function makeHttpServer(
  transport: StreamableHTTPServerTransport,
  sockets: Set<Socket>,
): HttpServer {
  const server = createHttpServer((request, response) => {
    let pathname: string;
    try {
      pathname = new URL(request.url ?? "/", `http://${FIXTURE_HOST}`).pathname;
    } catch {
      response.writeHead(400).end();
      return;
    }
    if (pathname !== FIXTURE_PATH) {
      response.writeHead(404).end();
      return;
    }
    void transport.handleRequest(request, response).catch(() => {
      if (!response.headersSent) response.writeHead(500).end();
      else response.destroy();
    });
  });
  server.on("connection", (socket) => trackSocket(socket, sockets));
  return server;
}

async function reserveLoopbackPair(transport: StreamableHTTPServerTransport): Promise<{
  readonly httpServer: HttpServer;
  readonly ipv6Guard: NetServer;
  readonly httpSockets: Set<Socket>;
  readonly ipv6Sockets: Set<Socket>;
  readonly port: number;
}> {
  let lastBindError: unknown;
  for (let attempt = 0; attempt < MAX_BIND_ATTEMPTS; attempt += 1) {
    const ipv6Sockets = new Set<Socket>();
    const ipv6Guard = createNetServer((socket) => socket.destroy());
    ipv6Guard.on("connection", (socket) => trackSocket(socket, ipv6Sockets));
    try {
      await listen(
        ipv6Guard,
        { host: "::1", port: 0, ipv6Only: true, exclusive: true },
        "ipv6-loopback-bind",
      );
    } catch (error) {
      await stopNetServer(ipv6Guard, ipv6Sockets).catch(() => undefined);
      if (isIpv6Unavailable(error)) {
        throw new Error("workbench-runtime-fixture-requires-ipv6-loopback", { cause: error });
      }
      throw error;
    }

    const address = ipv6Guard.address();
    if (!address || typeof address === "string") {
      await stopNetServer(ipv6Guard, ipv6Sockets).catch(() => undefined);
      throw new Error("ipv6-loopback-port-resolution-failed");
    }

    const httpSockets = new Set<Socket>();
    const httpServer = makeHttpServer(transport, httpSockets);
    try {
      await listen(
        httpServer,
        { host: FIXTURE_HOST, port: address.port, exclusive: true },
        "ipv4-loopback-bind",
      );
      return { httpServer, ipv6Guard, httpSockets, ipv6Sockets, port: address.port };
    } catch (error) {
      lastBindError = error;
      await stopHttpServer(httpServer, httpSockets).catch(() => undefined);
      await stopNetServer(ipv6Guard, ipv6Sockets).catch(() => undefined);
    }
  }
  throw new Error("could-not-reserve-dual-loopback-fixture-port", { cause: lastBindError });
}

export async function startWorkbenchRuntimeMcpFixture(): Promise<WorkbenchRuntimeMcpFixture> {
  const echoMarker = `wb-mcp-${randomBytes(24).toString("hex")}`;
  const mcpServer = new McpServer({ name: "workbench-runtime-fixture", version: "1.0.0" });
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    enableJsonResponse: true,
  });

  let echoCalls = 0;
  let waitCalls = 0;
  let activeWaits = 0;
  let cancelledWaits = 0;
  let waitStartGate = makeSignalGate();
  let waitAbortGate = makeSignalGate();

  const stringSchema = z.string() as unknown as AnySchema;
  mcpServer.registerTool(
    "workbench_probe_echo",
    {
      description: "Return a fixture-generated marker with the submitted value.",
      inputSchema: { value: stringSchema },
      outputSchema: { echoMarker: stringSchema, value: stringSchema },
    },
    ({ value }: { value: string }) => {
      echoCalls += 1;
      return {
        content: [{ type: "text", text: echoMarker }],
        structuredContent: { echoMarker, value },
      };
    },
  );
  mcpServer.registerTool(
    "workbench_probe_wait",
    {
      description: "Remain pending until the MCP client cancels this tool request.",
      inputSchema: {},
      outputSchema: { cancelled: z.boolean() as unknown as AnySchema },
    },
    (_args, extra) => {
      waitCalls += 1;
      activeWaits += 1;
      waitStartGate.resolve();
      return new Promise((resolve) => {
        let settled = false;
        const onAbort = () => {
          if (settled) return;
          settled = true;
          extra.signal.removeEventListener("abort", onAbort);
          activeWaits -= 1;
          cancelledWaits += 1;
          waitAbortGate.resolve();
          resolve({
            content: [{ type: "text", text: "cancelled" }],
            structuredContent: { cancelled: true },
          });
        };
        if (extra.signal.aborted) onAbort();
        else extra.signal.addEventListener("abort", onAbort, { once: true });
      });
    },
  );

  await mcpServer.connect(transport as unknown as Transport);
  let listeners: Awaited<ReturnType<typeof reserveLoopbackPair>>;
  try {
    listeners = await reserveLoopbackPair(transport);
  } catch (error) {
    await mcpServer.close().catch(() => undefined);
    throw error;
  }
  let closePromise: Promise<void> | undefined;
  return {
    url: `http://${FIXTURE_HOST}:${listeners.port}${FIXTURE_PATH}`,
    echoMarker,
    stats: () => ({ echoCalls, waitCalls, activeWaits, cancelledWaits }),
    waitForWaitStart: (timeoutMs) =>
      withTimeout(waitStartGate.promise, timeoutMs, "mcp-wait-start"),
    waitForWaitAbort: (timeoutMs) =>
      withTimeout(waitAbortGate.promise, timeoutMs, "mcp-wait-abort"),
    resetWait: () => {
      if (activeWaits !== 0) throw new Error("cannot-reset-mcp-wait-while-active");
      waitCalls = 0;
      cancelledWaits = 0;
      waitStartGate = makeSignalGate();
      waitAbortGate = makeSignalGate();
    },
    close: () => {
      if (closePromise) return closePromise;
      closePromise = (async () => {
        const httpClose = stopHttpServer(listeners.httpServer, listeners.httpSockets);
        const ipv6Close = stopNetServer(listeners.ipv6Guard, listeners.ipv6Sockets);
        const mcpClose = withTimeout(mcpServer.close(), CLOSE_TIMEOUT_MS, "mcp-server-close");
        const results = await Promise.allSettled([httpClose, ipv6Close, mcpClose]);
        const errors = results.flatMap((result) =>
          result.status === "rejected" ? [result.reason] : [],
        );
        if (errors.length > 0)
          throw new AggregateError(errors, "workbench-mcp-fixture-close-failed");
      })();
      return closePromise;
    },
  };
}
