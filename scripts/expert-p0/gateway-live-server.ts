#!/usr/bin/env bun
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import http from "node:http";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProjectId, ThreadId, TurnId, type OrchestrationThreadShell } from "@synara/contracts";
import { Effect, Exit, Layer, Option, Scope } from "effect";
import { HttpRouter } from "effect/unstable/http";

import type { ProjectionSnapshotQueryShape } from "../../apps/server/src/orchestration/Services/ProjectionSnapshotQuery.ts";
import { makeAgentGatewaySessionRegistry } from "../../apps/server/src/agentGateway/Layers/AgentGatewaySessionRegistry.ts";
import {
  AgentGateway,
  type AgentGatewayShape,
} from "../../apps/server/src/agentGateway/Services/AgentGateway.ts";
import {
  AgentGatewayCredentials,
  type AgentGatewayCredentialsShape,
} from "../../apps/server/src/agentGateway/Services/AgentGatewayCredentials.ts";
import { makeAgentGatewayMcpTransport } from "../../apps/server/src/agentGateway/mcpTransport.ts";
import { makeAgentGatewayInFlightRequestRegistry } from "../../apps/server/src/agentGateway/inFlightRequestRegistry.ts";
import { agentGatewayRouteLayer } from "../../apps/server/src/agentGateway/httpRoute.ts";
import type { ToolEntry } from "../../apps/server/src/agentGateway/toolRuntime.ts";

const sdkRoot = process.env.MCP_SDK_ROOT;
if (!sdkRoot) throw new Error("Set MCP_SDK_ROOT to the temporary MCP SDK package directory.");
const sdkRequire = createRequire(resolve(sdkRoot, "gateway-live-server-loader.cjs"));
const { Client } = sdkRequire("@modelcontextprotocol/sdk/client/index.js") as {
  Client: new (info: { name: string; version: string }) => any;
};
const { StdioClientTransport } = sdkRequire("@modelcontextprotocol/sdk/client/stdio.js") as {
  StdioClientTransport: new (options: Record<string, unknown>) => any;
};
const { StreamableHTTPClientTransport } = sdkRequire(
  "@modelcontextprotocol/sdk/client/streamableHttp.js",
) as { StreamableHTTPClientTransport: new (url: URL, options: Record<string, unknown>) => any };

const fixturePath = fileURLToPath(new URL("./gateway-probe.mjs", import.meta.url));
const timeout = async <T>(promise: Promise<T>, label: string, milliseconds = 5000): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out`)), milliseconds);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

const ensure = (condition: boolean, message: string) => {
  if (!condition) throw new Error(message);
};

function deferred<T = void>() {
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (error: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

function makeThread(
  threadId: string,
  provider: "codex" | "pi",
  turnState: "running" | "completed",
) {
  return {
    id: ThreadId.makeUnsafe(threadId),
    projectId: ProjectId.makeUnsafe("project-expert-p0-gateway-fixture"),
    title: threadId,
    modelSelection: { provider, model: provider === "codex" ? "gpt-5.6-sol" : "fixture" },
    runtimeMode: "full-access",
    interactionMode: "default",
    envMode: "local",
    branch: null,
    worktreePath: null,
    associatedWorktreePath: null,
    associatedWorktreeBranch: null,
    associatedWorktreeRef: null,
    createBranchFlowCompleted: false,
    isPinned: false,
    parentThreadId: null,
    subagentAgentId: null,
    subagentNickname: null,
    subagentRole: null,
    forkSourceThreadId: null,
    sidechatSourceThreadId: null,
    lastKnownPr: null,
    latestTurn: {
      turnId: TurnId.makeUnsafe(`turn-${threadId}`),
      state: turnState,
      requestedAt: "2026-09-25T00:00:00.000Z",
      startedAt: "2026-09-25T00:00:00.000Z",
      completedAt: turnState === "running" ? null : "2026-09-25T00:01:00.000Z",
      assistantMessageId: null,
    },
    latestUserMessageAt: "2026-09-25T00:00:00.000Z",
    createdAt: "2026-09-25T00:00:00.000Z",
    updatedAt: "2026-09-25T00:00:00.000Z",
    archivedAt: null,
    session: null,
  } as unknown as OrchestrationThreadShell;
}

async function main() {
  const sessionRegistry = makeAgentGatewaySessionRegistry();
  const inFlightRequests = makeAgentGatewayInFlightRequestRegistry();
  const threads = new Map<string, OrchestrationThreadShell>();
  const sessionAlias = new Map<string, string>();
  const grants = new Map<string, ReadonlySet<string>>();
  const downstreamCalls: Record<string, number> = Object.create(null) as Record<string, number>;
  const readyTokens: Record<string, string> = {};
  const allTokens: string[] = [];
  const stdioStarted = deferred();
  const stdioCancelled = deferred();
  const stdioClosed = deferred();
  const scope = await Effect.runPromise(Scope.make("sequential"));
  let nodeServer: http.Server | null = null;
  let origin: string | null = null;
  let stdioClient: any;
  let stdioTransport: any;
  let mainFailed = false;
  let mainFailure: unknown;
  let cleanupFailure: unknown;

  const credentials: AgentGatewayCredentialsShape = {
    get mcpEndpointUrl() {
      return origin ? `${origin}/mcp` : "http://127.0.0.1:0/mcp";
    },
    setListeningPort: () => undefined,
    issueSessionToken: (threadId, provider) => {
      const session = sessionRegistry.issue(threadId, provider);
      return session.token;
    },
    verifySessionToken: (token) => sessionRegistry.verify(token)?.threadId ?? null,
    verifySession: sessionRegistry.verify,
    issueStdioBootstrapToken: () => null,
    exchangeStdioBootstrapToken: () => null,
    bindWriteAuthority: sessionRegistry.bindWriteAuthority,
    verifyWriteAuthority: sessionRegistry.verifyWriteAuthority,
    registerInFlightRequest: inFlightRequests.register,
    cancelInFlightRequests: inFlightRequests.cancel,
    cancelSessionTurnRequests: (token, turnId) => {
      const session = sessionRegistry.verify(token);
      return session
        ? inFlightRequests.cancelTurn(session.sessionKey, turnId).settled
        : Promise.resolve();
    },
    retireSessionTurn: (token, turnId) => {
      const session = sessionRegistry.verify(token);
      if (!session) return Promise.resolve();
      sessionRegistry.retireWriteAuthority(token, turnId);
      return inFlightRequests.cancelTurn(session.sessionKey, turnId).settled;
    },
    revokeSessionToken: (token) => {
      const session = sessionRegistry.verify(token);
      sessionRegistry.revoke(token);
      if (session) void inFlightRequests.revokeSession(session.sessionKey).settled;
    },
    connectionForThread: (threadId, provider) => ({
      url: credentials.mcpEndpointUrl,
      bearerToken: credentials.issueSessionToken(threadId, provider),
    }),
    stdioProxy: { command: process.execPath, args: [] },
  };

  const addSession = (
    alias: string,
    provider: "codex" | "pi",
    turnState: "running" | "completed",
    allowedTools: ReadonlyArray<string>,
  ): string => {
    const threadId = ThreadId.makeUnsafe(`p0-${alias}`);
    threads.set(String(threadId), makeThread(String(threadId), provider, turnState));
    const token = credentials.issueSessionToken(threadId, provider);
    const session = credentials.verifySession(token);
    if (!session) throw new Error(`Session issue failed for ${alias}`);
    sessionAlias.set(session.sessionKey, alias);
    grants.set(session.sessionKey, new Set(allowedTools));
    allTokens.push(token);
    return token;
  };

  const serverTool = (name: "expert_probe_echo" | "expert_probe_wait"): ToolEntry => ({
    definition: {
      name,
      description:
        name === "expert_probe_echo"
          ? "Echo through a local MCP fixture."
          : "Wait for MCP cancellation.",
      inputSchema:
        name === "expert_probe_echo"
          ? { type: "object", properties: { text: { type: "string" } }, required: ["text"] }
          : { type: "object", properties: {} },
    },
    requiredCapability: "thread:read",
    requiresActiveTurn: true,
    sessionScoped: true,
    handler: (_args, context) => {
      const alias = sessionAlias.get(context.callerSessionKey) ?? "unknown-session";
      downstreamCalls[alias] = (downstreamCalls[alias] ?? 0) + 1;
      const nameArgs = name === "expert_probe_echo" ? { text: _args.text } : {};
      return Effect.tryPromise({
        try: (signal) => stdioClient.callTool({ name, arguments: nameArgs }, undefined, { signal }),
        catch: () => new Error("Downstream fixture tool call failed."),
      }).pipe(
        Effect.map((result: any) => ({
          content: result.content.filter(
            (item: any) => item.type === "text" || item.type === "image",
          ),
          ...(result.isError === true ? { isError: true } : {}),
          ...(result.structuredContent && typeof result.structuredContent === "object"
            ? { structuredContent: result.structuredContent }
            : {}),
        })),
      );
    },
  });

  const tools: ToolEntry[] = [serverTool("expert_probe_echo"), serverTool("expert_probe_wait")];
  const snapshotQuery = {
    getThreadShellById: (threadId: ThreadId) =>
      Effect.succeed(Option.fromNullishOr(threads.get(String(threadId)))),
  } as unknown as ProjectionSnapshotQueryShape;
  const transport = makeAgentGatewayMcpTransport({
    credentials,
    snapshotQuery,
    tools,
    instructions: "P0 local gateway fixture.",
    requireThreadShell: (threadId) => {
      const thread = threads.get(threadId);
      return thread ? Effect.succeed(thread) : Effect.fail(new Error("Fixture thread missing."));
    },
    authorizeTool: ({ sessionKey, toolName }) => grants.get(sessionKey)?.has(toolName) === true,
  });

  const openGatewayClient = async (token: string) => {
    if (!origin) throw new Error("Gateway route has not started.");
    const client = new Client({ name: "synara-p0-gateway-live", version: "1.0.0" });
    const clientTransport = new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    });
    await client.connect(clientTransport);
    return client;
  };

  try {
    stdioTransport = new StdioClientTransport({
      command: process.execPath,
      args: [fixturePath, "--fixture-stdio"],
      env: { MCP_SDK_ROOT: resolve(sdkRoot) },
      stderr: "pipe",
    });
    stdioTransport.stderr?.on("data", (chunk: unknown) => {
      const text = String(chunk);
      if (text.includes("wait-started")) stdioStarted.resolve();
      if (text.includes("wait-cancelled")) stdioCancelled.resolve();
    });
    // The MCP SDK transport exposes close as a callback property.
    // oxlint-disable-next-line unicorn/prefer-add-event-listener
    stdioTransport.onclose = () => stdioClosed.resolve();
    stdioClient = new Client({ name: "synara-p0-downstream-fixture", version: "1.0.0" });
    await stdioClient.connect(stdioTransport);

    const gateway: AgentGatewayShape = { handleMcpPost: transport };
    await Effect.runPromise(
      Scope.provide(
        Effect.gen(function* () {
          const httpServer = yield* NodeHttpServer.make(
            () => {
              nodeServer = http.createServer();
              return nodeServer;
            },
            { port: 0, host: "127.0.0.1" },
          );
          const httpApp = yield* HttpRouter.toHttpEffect(agentGatewayRouteLayer);
          yield* httpServer.serve(httpApp);
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              Layer.succeed(AgentGateway, gateway),
              Layer.succeed(AgentGatewayCredentials, credentials),
              NodeServices.layer,
            ),
          ),
        ),
        scope,
      ),
    );
    const address = nodeServer?.address();
    if (!address || typeof address !== "object")
      throw new Error("Gateway did not bind a TCP port.");
    origin = `http://127.0.0.1:${address.port}`;

    const tokenAliases = {
      codexA: addSession("codexA", "codex", "running", ["expert_probe_echo"]),
      codexB: addSession("codexB", "codex", "running", []),
      piA: addSession("piA", "pi", "running", ["expert_probe_echo"]),
      piB: addSession("piB", "pi", "running", []),
    };
    readyTokens.codexA = tokenAliases.codexA;
    readyTokens.codexB = tokenAliases.codexB;
    readyTokens.piA = tokenAliases.piA;
    readyTokens.piB = tokenAliases.piB;

    for (const provider of ["codex", "pi"] as const) {
      const aClient = await openGatewayClient(tokenAliases[`${provider}A` as "codexA" | "piA"]);
      try {
        const listed = await aClient.listTools();
        ensure(
          listed.tools.some(({ name }: { name: string }) => name === "expert_probe_echo"),
          `${provider} A cannot list the granted tool`,
        );
        const result = await aClient.callTool({
          name: "expert_probe_echo",
          arguments: {
            text: `fixture-${provider}`,
            expertId: `spoof-${provider}-B`,
            threadId: `p0-${provider}B`,
          },
        });
        ensure(
          result.content[0]?.text === `echo:fixture-${provider}`,
          `${provider} A did not receive the downstream echo`,
        );
        ensure(
          result.content[1]?.type === "image",
          `${provider} route dropped downstream image content`,
        );
        ensure(
          JSON.stringify(result.structuredContent) ===
            JSON.stringify({ echo: `fixture-${provider}` }),
          `${provider} route dropped downstream structured content`,
        );
      } finally {
        await aClient.close();
      }

      const bClient = await openGatewayClient(tokenAliases[`${provider}B` as "codexB" | "piB"]);
      try {
        const listed = await bClient.listTools();
        ensure(
          !listed.tools.some(({ name }: { name: string }) => name === "expert_probe_echo"),
          `${provider} B saw a tool without a grant`,
        );
        await assert.rejects(
          bClient.callTool({
            name: "expert_probe_echo",
            arguments: {
              text: `unauthorized-${provider}`,
              expertId: `p0-${provider}A`,
              threadId: `p0-${provider}A`,
            },
          }),
          (error: any) => error?.code === -32602,
        );
        ensure(
          (downstreamCalls[`${provider}B`] ?? 0) === 0,
          `${provider} B reached the downstream handler`,
        );
      } finally {
        await bClient.close();
      }
    }

    const inactiveToken = addSession("inactive", "codex", "completed", ["expert_probe_echo"]);
    const inactiveClient = await openGatewayClient(inactiveToken);
    try {
      const result = await inactiveClient.callTool({
        name: "expert_probe_echo",
        arguments: { text: "inactive" },
      });
      ensure(result.isError === true, "Completed-turn tool call was not rejected.");
      ensure(
        (downstreamCalls.inactive ?? 0) === 0,
        "Completed-turn call reached the downstream handler.",
      );
    } finally {
      await inactiveClient.close();
    }

    const revokedToken = addSession("revoked", "codex", "running", ["expert_probe_echo"]);
    credentials.revokeSessionToken(revokedToken);
    const revokedResponse = await fetch(`${origin}/mcp`, {
      method: "POST",
      headers: { Authorization: `Bearer ${revokedToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    ensure(
      revokedResponse.status === 401,
      "Revoked token was not rejected by the real HTTP route.",
    );
    ensure((downstreamCalls.revoked ?? 0) === 0, "Revoked session reached the downstream handler.");

    const cancelToken = addSession("cancel", "codex", "running", ["expert_probe_wait"]);
    const cancelClient = await openGatewayClient(cancelToken);
    try {
      const controller = new AbortController();
      const pendingCall = cancelClient.callTool(
        { name: "expert_probe_wait", arguments: {} },
        undefined,
        { signal: controller.signal },
      );
      await timeout(stdioStarted.promise, "downstream wait start");
      controller.abort();
      await assert.rejects(pendingCall);
      await timeout(stdioCancelled.promise, "downstream cancellation signal");
      ensure(
        (downstreamCalls.cancel ?? 0) === 1,
        "Cancellation test did not execute exactly one downstream tool call.",
      );
    } finally {
      await cancelClient.close();
    }

    process.stdout.write(`P0_READY ${JSON.stringify({ url: `${origin}/mcp`, ...readyTokens })}\n`);
    await new Promise<void>((resolveStop) => {
      const stop = () => {
        process.stdin.pause();
        process.off("SIGINT", stop);
        process.off("SIGTERM", stop);
        process.stdin.off("end", stop);
        resolveStop();
      };
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
      process.stdin.once("end", stop);
      process.stdin.resume();
    });
  } catch (error) {
    mainFailed = true;
    mainFailure = error;
  } finally {
    try {
      const activeTokens = [...allTokens];
      await Promise.all(
        activeTokens.map(async (token) => {
          const session = sessionRegistry.verify(token);
          if (!session) return;
          const cancelled = inFlightRequests.revokeSession(session.sessionKey);
          await cancelled.settled;
          credentials.revokeSessionToken(token);
        }),
      );
      await Effect.runPromise(Scope.close(scope, Exit.void));
      if (stdioClient) await stdioClient.close().catch(() => undefined);
      if (stdioTransport) await timeout(stdioClosed.promise, "stdio child close");
      ensure(
        stdioTransport?.pid === null || stdioTransport === undefined,
        "The downstream stdio fixture process did not exit after client.close().",
      );
    } catch (error) {
      cleanupFailure = error;
    }
    process.stdout.write(
      `P0_CLEANUP ${JSON.stringify({
        selfTests: mainFailed
          ? "failed"
          : "codex/pi allow-deny, spoofed identity, inactive turn, revoked bearer, cancelled downstream call passed",
        downstreamCalls: Object.values(downstreamCalls).reduce((sum, count) => sum + count, 0),
        downstreamChildClosed: stdioTransport?.pid === null || stdioTransport === undefined,
        gatewayServerClosed: nodeServer?.listening !== true,
        cleanupError: cleanupFailure ? "cleanup-failed" : null,
      })}\n`,
    );
  }
  if (mainFailed) throw mainFailure;
  if (cleanupFailure) throw cleanupFailure;
}

await main();
