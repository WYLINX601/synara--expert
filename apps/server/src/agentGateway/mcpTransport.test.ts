import { createServer } from "node:http";

import { assert, describe, it } from "@effect/vitest";
import { ProjectId, ThreadId, TurnId, type OrchestrationThreadShell } from "@synara/contracts";
import { Deferred, Effect, Fiber, Option } from "effect";

import type { ProjectionSnapshotQueryShape } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { makeAgentGatewayBrowserTools } from "./browserTools.ts";
import { BrowserHostRpcError } from "../browserAutomation/browserHostRpcClient.ts";
import { makeAgentGatewaySessionRegistry } from "./Layers/AgentGatewaySessionRegistry.ts";
import type { AgentGatewayCredentialsShape } from "./Services/AgentGatewayCredentials.ts";
import { makeAgentGatewayInFlightRequestRegistry } from "./inFlightRequestRegistry.ts";
import { makeAgentGatewayMcpTransport } from "./mcpTransport.ts";
import { FALLBACK_OBJECT_DESCRIPTION } from "./sanitizeToolInputSchema.ts";
import { isSynaraComputerToolFamilyName } from "./computerToolPermission.ts";
import { countSchemaKeyOccurrences, isJsonRecord } from "./schemaTestUtils.ts";
import {
  acquireAgentGatewaySessionLease,
  AGENT_GATEWAY_NO_CAPABILITIES,
  type AgentGatewayCapabilityInput,
  type AgentGatewaySessionLease,
  type AgentGatewaySessionLeaseOptions,
} from "./sessionLease.ts";
import type { ToolEntry } from "./toolRuntime.ts";

const NOW = "2026-07-22T03:00:00.000Z";

function makeThread(threadId: string): OrchestrationThreadShell {
  return {
    id: ThreadId.makeUnsafe(threadId),
    projectId: ProjectId.makeUnsafe("project-mcp-cancellation"),
    title: threadId,
    modelSelection: { provider: "codex", model: "gpt-5.6-sol" },
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
      state: "running",
      requestedAt: NOW,
      startedAt: NOW,
      completedAt: null,
      assistantMessageId: null,
    },
    latestUserMessageAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: null,
    handoff: null,
    session: null,
  };
}

export interface McpTransportTestDenial {
  readonly toolName: string;
  readonly requiredCapability: string;
  readonly callerThreadId: string;
  readonly callerTurnId: string | null;
}

function makeTransport(input: {
  readonly tools: ReadonlyArray<ToolEntry>;
  readonly threads: ReadonlyArray<OrchestrationThreadShell>;
  readonly leaseCapabilities?: AgentGatewayCapabilityInput;
  /** Thread ids that hold a session lease but no longer exist in the snapshot. */
  readonly ghostThreads?: ReadonlyArray<string>;
  /** Computer family names threaded to the transport (absent from tools). */
  readonly computerToolNames?: ReadonlyArray<string>;
  /** Full family-predicate override (e.g. the namespace-insensitive matcher). */
  readonly isComputerToolName?: (toolName: string) => boolean;
  readonly onCapabilityDenied?: (denial: McpTransportTestDenial) => Effect.Effect<void>;
  readonly authorizeTool?: Parameters<typeof makeAgentGatewayMcpTransport>[0]["authorizeTool"];
  readonly resolveSessionTools?: Parameters<
    typeof makeAgentGatewayMcpTransport
  >[0]["resolveSessionTools"];
}) {
  const threads = new Map(input.threads.map((thread) => [String(thread.id), thread]));
  let nextSession = 0;
  let nextRandomPartIsSession = true;
  const sessionRegistry = makeAgentGatewaySessionRegistry({
    randomId: () => {
      if (nextRandomPartIsSession) {
        nextSession += 1;
        nextRandomPartIsSession = false;
        return `session-${nextSession}`;
      }
      nextRandomPartIsSession = true;
      return `token-${nextSession}`;
    },
  });
  const inFlightRequests = makeAgentGatewayInFlightRequestRegistry();
  const credentials = {
    verifySession: sessionRegistry.verify,
    bindWriteAuthority: sessionRegistry.bindWriteAuthority,
    verifyWriteAuthority: sessionRegistry.verifyWriteAuthority,
    registerInFlightRequest: inFlightRequests.register,
    cancelInFlightRequests: inFlightRequests.cancel,
    cancelSessionTurnRequests: (token: string, turnId: string) => {
      const session = sessionRegistry.verify(token);
      return session
        ? inFlightRequests.cancelTurn(session.sessionKey, turnId).settled
        : Promise.resolve();
    },
    retireSessionTurn: (token: string, turnId: string) => {
      const session = sessionRegistry.verify(token);
      if (!session) return Promise.resolve();
      sessionRegistry.retireWriteAuthority(token, turnId);
      return inFlightRequests.cancelTurn(session.sessionKey, turnId).settled;
    },
    revokeSessionToken: (token: string) => {
      const session = sessionRegistry.verify(token);
      sessionRegistry.revoke(token);
      if (session) inFlightRequests.revokeSession(session.sessionKey);
    },
    connectionForThread: (
      threadId: ThreadId,
      _provider: unknown,
      options?: AgentGatewaySessionLeaseOptions,
    ) => {
      const issued = sessionRegistry.issue(threadId, "codex", options);
      return {
        url: "http://127.0.0.1:48123/mcp",
        bearerToken: issued.token,
      };
    },
  } as unknown as AgentGatewayCredentialsShape;
  const tokenAliases = new Map<string, string>();
  const sessionKeyAliases = new Map<string, string>();
  const sessionKeyByTokenAlias = new Map<string, string>();
  const leases = new Map<string, AgentGatewaySessionLease>();
  const startRuntime = (threadId: string, tokenAlias: string): AgentGatewaySessionLease => {
    const lease = acquireAgentGatewaySessionLease(
      credentials,
      ThreadId.makeUnsafe(threadId),
      "codex",
      input.leaseCapabilities ?? AGENT_GATEWAY_NO_CAPABILITIES,
    );
    if (!lease) throw new Error("Expected gateway session lease");
    tokenAliases.set(tokenAlias, lease.connection.bearerToken);
    const session = sessionRegistry.verify(lease.connection.bearerToken);
    if (!session) throw new Error("Expected registered gateway session");
    sessionKeyAliases.set(`session-${leases.size + 1}`, session.sessionKey);
    sessionKeyByTokenAlias.set(tokenAlias, session.sessionKey);
    leases.set(threadId, lease);
    return lease;
  };
  input.threads.forEach((thread, index) => {
    startRuntime(String(thread.id), `token-${index + 1}`);
  });
  (input.ghostThreads ?? []).forEach((threadId, index) => {
    startRuntime(threadId, `token-ghost-${index + 1}`);
  });
  const snapshotQuery = {
    getThreadShellById: (threadId: ThreadId) =>
      Effect.succeed(Option.fromNullishOr(threads.get(String(threadId)))),
  } as unknown as ProjectionSnapshotQueryShape;

  const transport = makeAgentGatewayMcpTransport({
    credentials,
    snapshotQuery,
    tools: input.tools,
    instructions: "test",
    requireThreadShell: (threadId) => {
      const thread = threads.get(threadId);
      return thread ? Effect.succeed(thread) : Effect.fail(new Error("missing thread"));
    },
    ...(input.authorizeTool ? { authorizeTool: input.authorizeTool } : {}),
    ...(input.resolveSessionTools ? { resolveSessionTools: input.resolveSessionTools } : {}),
    ...(input.onCapabilityDenied ? { onCapabilityDenied: input.onCapabilityDenied } : {}),
    ...(input.computerToolNames || input.isComputerToolName
      ? {
          isComputerToolName:
            input.isComputerToolName ??
            ((toolName: string) => input.computerToolNames!.includes(toolName)),
          computerControlCapability: "computer:control" as const,
        }
      : {}),
  });
  return Object.assign(transport, {
    resolveToken: (token: string) => tokenAliases.get(token) ?? token,
    sessionKeyForTokenAlias: (tokenAlias: string) => sessionKeyByTokenAlias.get(tokenAlias),
    revokeTokenAlias: (tokenAlias: string) => {
      const token = tokenAliases.get(tokenAlias);
      if (token) credentials.revokeSessionToken(token);
    },
    cancelTurn: (sessionKey: string, turnId: string) =>
      inFlightRequests.cancelTurn(sessionKeyAliases.get(sessionKey) ?? sessionKey, turnId),
    setThreadTurnState: (
      threadId: string,
      state: "running" | "completed" | "error" | "interrupted",
    ) => {
      const thread = threads.get(threadId);
      if (!thread?.latestTurn) return;
      threads.set(threadId, {
        ...thread,
        latestTurn: {
          ...thread.latestTurn,
          state,
          completedAt: state === "running" ? null : NOW,
        },
      });
    },
    completeTurnAndRestartRuntime: async (
      threadId: string,
      completedTurnId: string,
      replacementTokenAlias: string,
    ) => {
      const outgoing = leases.get(threadId);
      if (!outgoing) throw new Error("Expected outgoing gateway session lease");
      await outgoing.retireTurn(completedTurnId);
      outgoing.release();
      startRuntime(threadId, replacementTokenAlias);
    },
    setThreadTurn: (threadId: string, turnId: string) => {
      const thread = threads.get(threadId);
      if (!thread?.latestTurn) return;
      threads.set(threadId, {
        ...thread,
        latestTurn: {
          ...thread.latestTurn,
          turnId: TurnId.makeUnsafe(turnId),
          state: "running",
          completedAt: null,
        },
      });
    },
  });
}

const post = (transport: ReturnType<typeof makeTransport>, token: string, body: unknown) =>
  transport({ authorizationHeader: `Bearer ${transport.resolveToken(token)}`, body });

describe("makeAgentGatewayMcpTransport cancellation", () => {
  it.effect(
    "rejects turn A's credential after production completion and restart admit turn B",
    () =>
      Effect.gen(function* () {
        let handlerCalls = 0;
        const transport = makeTransport({
          threads: [makeThread("thread-rotated")],
          tools: [
            {
              definition: {
                name: "browser_click",
                description: "test",
                inputSchema: { type: "object" },
              },
              requiredCapability: "browser:control",
              requiresActiveTurn: true,
              handler: () => {
                handlerCalls += 1;
                return Effect.succeed({ content: [{ type: "text" as const, text: "ok" }] });
              },
            },
          ],
        });
        yield* Effect.promise(() =>
          transport.completeTurnAndRestartRuntime(
            "thread-rotated",
            "turn-thread-rotated",
            "token-b",
          ),
        );
        transport.setThreadTurn("thread-rotated", "turn-b");
        const body = {
          jsonrpc: "2.0",
          id: "browser-click",
          method: "tools/call",
          params: { name: "browser_click", arguments: {} },
        };

        const lateA = yield* post(transport, "token-1", body);
        assert.equal(lateA.status, 401);
        const turnB = yield* post(transport, "token-b", body);
        assert.equal(turnB.status, 200);
        assert.equal(handlerCalls, 1);
      }),
  );

  it.effect(
    "cancels a detached MCP call by gateway session and turn without a client notification",
    () =>
      Effect.gen(function* () {
        const hostStarted = yield* Deferred.make<void>();
        const hostAbortObserved = yield* Deferred.make<void>();
        let hostCalls = 0;
        const browserRun = makeAgentGatewayBrowserTools({
          available: true,
          execute: () => {
            hostCalls += 1;
            return Effect.tryPromise({
              try: (signal) => {
                return new Promise<never>((_resolve, reject) => {
                  signal.addEventListener(
                    "abort",
                    () => {
                      Deferred.doneUnsafe(hostAbortObserved, Effect.void);
                      reject(new Error("browser host request aborted"));
                    },
                    { once: true },
                  );
                  // Wake the Stop path before tryPromise returns, reproducing
                  // the re-entrant window where a direct interrupt would miss
                  // Effect's not-yet-installed AbortController finalizer.
                  Deferred.doneUnsafe(hostStarted, Effect.void);
                });
              },
              catch: (error) => new BrowserHostRpcError("transport", String(error)),
            });
          },
        }).find((tool) => tool.definition.name === "browser_run");
        assert.isDefined(browserRun);
        const transport = makeTransport({
          threads: [makeThread("thread-detached")],
          tools: [browserRun!],
        });
        const body = {
          jsonrpc: "2.0",
          id: "detached-browser-wait",
          method: "tools/call",
          params: {
            name: "browser_run",
            arguments: {
              tabId: "53756993-1de8-47a5-82c9-e00766199802",
              code: 'await page.getByText("STOP_SENTINEL_NEVER_APPEARS").waitFor(); return true;',
              timeoutMs: 30_000,
            },
          },
        };

        const request = yield* post(transport, "token-1", body).pipe(Effect.forkChild);
        yield* Deferred.await(hostStarted);

        const cancellation = transport.cancelTurn("session-1", "turn-thread-detached");
        assert.equal(cancellation.count, 1);
        yield* Effect.promise(() => cancellation.settled);
        yield* Deferred.await(hostAbortObserved);
        assert.deepEqual(yield* Fiber.join(request), { status: 202 });

        // A detached cell can race and issue the request after Stop. The turn
        // tombstone must reject it before the handler starts.
        assert.deepEqual(yield* post(transport, "token-1", { ...body, id: "late-request" }), {
          status: 202,
        });
        transport.setThreadTurnState("thread-detached", "interrupted");
        const afterProjectionSettled = yield* post(transport, "token-1", {
          ...body,
          id: "after-turn-terminal",
        });
        assert.equal(afterProjectionSettled.status, 200);
        assert.equal(hostCalls, 1);
      }).pipe(Effect.timeout("2 seconds")),
  );

  it.effect("cleans a completed request before the same JSON-RPC id is reused", () =>
    Effect.gen(function* () {
      const transport = makeTransport({
        threads: [makeThread("thread-reuse")],
        tools: [
          {
            definition: {
              name: "unused",
              description: "unused",
              inputSchema: { type: "object" },
            },
            requiredCapability: "thread:read",
            handler: () => Effect.never,
          },
        ],
      });
      const ping = { jsonrpc: "2.0", id: "reusable", method: "ping" };

      for (let iteration = 0; iteration < 25; iteration += 1) {
        const response = yield* post(transport, "token-1", ping);
        assert.deepEqual(response, {
          status: 200,
          body: { jsonrpc: "2.0", id: "reusable", result: {} },
        });
      }
    }).pipe(Effect.timeout("2 seconds")),
  );

  it.effect(
    "interrupts only the matching session request and keeps a following ping responsive",
    () =>
      Effect.gen(function* () {
        const startedOne = yield* Deferred.make<void>();
        const startedTwo = yield* Deferred.make<void>();
        const interruptedOne = yield* Deferred.make<void>();
        const interruptedTwo = yield* Deferred.make<void>();
        const releaseFirstCleanup = yield* Deferred.make<void>();
        const tool: ToolEntry = {
          definition: {
            name: "slow",
            description: "Wait until cancelled",
            inputSchema: { type: "object" },
          },
          requiredCapability: "thread:read",
          handler: (_args, context) => {
            const first = context.callerSessionKey.endsWith(":session-1");
            return Deferred.succeed(first ? startedOne : startedTwo, undefined).pipe(
              Effect.andThen(Effect.never),
              Effect.onInterrupt(() =>
                Effect.gen(function* () {
                  yield* Deferred.succeed(first ? interruptedOne : interruptedTwo, undefined);
                  if (first) yield* Deferred.await(releaseFirstCleanup);
                }),
              ),
            );
          },
        };
        const transport = makeTransport({
          tools: [tool],
          threads: [makeThread("thread-one"), makeThread("thread-two")],
        });
        const slowBody = {
          jsonrpc: "2.0",
          id: "shared-id",
          method: "tools/call",
          params: { name: "slow", arguments: {} },
        };
        const requestOne = yield* post(transport, "token-1", slowBody).pipe(Effect.forkChild);
        const requestTwo = yield* post(transport, "token-2", slowBody).pipe(Effect.forkChild);
        yield* Deferred.await(startedOne);
        yield* Deferred.await(startedTwo);

        const cancellation = yield* post(transport, "token-1", {
          jsonrpc: "2.0",
          method: "notifications/cancelled",
          params: { requestId: "shared-id", reason: "test" },
        });
        assert.deepEqual(cancellation, { status: 202 });
        yield* Deferred.await(interruptedOne);
        assert.isUndefined(yield* Deferred.poll(interruptedTwo));

        const ping = yield* post(transport, "token-1", {
          jsonrpc: "2.0",
          id: "ping-after-cancel",
          method: "ping",
        });
        assert.equal(ping.status, 200);
        assert.deepEqual(ping.body, {
          jsonrpc: "2.0",
          id: "ping-after-cancel",
          result: {},
        });
        assert.isUndefined(requestOne.pollUnsafe());
        yield* Deferred.succeed(releaseFirstCleanup, undefined);

        yield* post(transport, "token-2", {
          jsonrpc: "2.0",
          method: "notifications/cancelled",
          params: { requestId: "shared-id" },
        });
        yield* Deferred.await(interruptedTwo);
        assert.deepEqual(yield* Fiber.join(requestOne), { status: 202 });
        assert.deepEqual(yield* Fiber.join(requestTwo), { status: 202 });
      }).pipe(Effect.timeout("2 seconds")),
  );

  it.effect(
    "runs batch requests concurrently and applies cancellation without head-of-line blocking",
    () =>
      Effect.gen(function* () {
        const interrupted = yield* Deferred.make<void>();
        const transport = makeTransport({
          threads: [makeThread("thread-batch")],
          tools: [
            {
              definition: {
                name: "slow",
                description: "Wait until cancelled",
                inputSchema: { type: "object" },
              },
              requiredCapability: "thread:read",
              handler: () =>
                Effect.never.pipe(
                  Effect.onInterrupt(() =>
                    Deferred.succeed(interrupted, undefined).pipe(Effect.asVoid),
                  ),
                ),
            },
          ],
        });

        const response = yield* post(transport, "token-1", [
          {
            jsonrpc: "2.0",
            method: "notifications/cancelled",
            params: { requestId: "slow-batch" },
          },
          {
            jsonrpc: "2.0",
            id: "slow-batch",
            method: "tools/call",
            params: { name: "slow", arguments: {} },
          },
          { jsonrpc: "2.0", id: "fast-batch", method: "ping" },
        ]);

        yield* Deferred.await(interrupted);
        assert.equal(response.status, 200);
        assert.deepEqual(response.body, [{ jsonrpc: "2.0", id: "fast-batch", result: {} }]);
      }).pipe(Effect.timeout("2 seconds")),
  );
});

const findToolOrThrow = (tools: ReadonlyArray<unknown>, name: string): Record<string, unknown> => {
  const found = tools.find((candidate) => isJsonRecord(candidate) && candidate.name === name);
  if (!isJsonRecord(found)) {
    throw new Error(`Expected tools/list to serve ${name}.`);
  }
  return found;
};

describe("makeAgentGatewayMcpTransport tools/list schema sanitization", () => {
  it.effect("serves sanitized schemas while keeping stored definitions dirty", () =>
    Effect.gen(function* () {
      const recursiveTool: ToolEntry = {
        definition: {
          name: "synara_recursive",
          description: "tool with a cyclic schema",
          inputSchema: {
            type: "object",
            properties: { payload: { $ref: "#/$defs/JsonValue" } },
            $defs: {
              JsonValue: {
                anyOf: [
                  { type: "string" },
                  { type: "array", items: { $ref: "#/$defs/JsonValue" } },
                ],
              },
            },
          },
        },
        requiredCapability: "thread:read",
        handler: () => Effect.succeed({ content: [{ type: "text" as const, text: "ok" }] }),
      };
      const transport = makeTransport({
        threads: [makeThread("thread-schema")],
        tools: [recursiveTool],
      });
      const response = yield* post(transport, "token-1", {
        jsonrpc: "2.0",
        id: "list-schemas",
        method: "tools/list",
      });
      assert.equal(response.status, 200);
      if (!isJsonRecord(response.body) || !isJsonRecord(response.body.result)) {
        throw new Error("Expected tools/list to answer with a result object.");
      }
      if (!Array.isArray(response.body.result.tools)) {
        throw new Error("Expected tools/list to answer with a tools array.");
      }
      const listed = findToolOrThrow(response.body.result.tools, "synara_recursive");
      assert.deepEqual(listed.inputSchema, {
        type: "object",
        properties: {
          payload: {
            type: "object",
            description: FALLBACK_OBJECT_DESCRIPTION,
          },
        },
      });
      assert.isAbove(countSchemaKeyOccurrences(recursiveTool.definition.inputSchema, "$ref"), 0);
    }),
  );
});

function listedTools(body: unknown): ReadonlyArray<Record<string, unknown>> {
  const result = (body as { result?: { tools?: ReadonlyArray<Record<string, unknown>> } }).result;
  return result?.tools ?? [];
}

describe("makeAgentGatewayMcpTransport tools/list", () => {
  const ok = () => Effect.succeed({ content: [{ type: "text" as const, text: "ok" }] });
  const catalog: ReadonlyArray<ToolEntry> = [
    {
      definition: {
        name: "synara_read_thread",
        description: "Read a thread",
        inputSchema: { type: "object" },
      },
      requiredCapability: "thread:read",
      handler: ok,
    },
    {
      definition: {
        name: "computer_click",
        description: "Click",
        inputSchema: { type: "object" },
        annotations: { title: "Click" },
        _meta: { "anthropic/alwaysLoad": true },
      },
      requiredCapability: "computer:control",
      handler: ok,
    },
  ];
  const listBody = { jsonrpc: "2.0", id: "list", method: "tools/list" };

  it.effect("omits tools the caller's session was never granted", () =>
    Effect.gen(function* () {
      // A session without computer:control can never call these tools; listing
      // them would cost the model prompt tokens and a guaranteed denial.
      const transport = makeTransport({ threads: [makeThread("thread-plain")], tools: catalog });
      const response = yield* post(transport, "token-1", listBody);
      assert.equal(response.status, 200);
      assert.deepEqual(
        listedTools(response.body).map((tool) => tool.name),
        ["synara_read_thread"],
      );
    }),
  );

  it.effect("passes tool _meta through verbatim to a caller that holds the capability", () =>
    Effect.gen(function* () {
      const transport = makeTransport({
        threads: [makeThread("thread-computer")],
        tools: catalog,
        leaseCapabilities: { enableComputerControl: true },
      });
      const response = yield* post(transport, "token-1", listBody);
      assert.equal(response.status, 200);
      const tools = listedTools(response.body);
      assert.deepEqual(
        tools.map((tool) => tool.name),
        ["synara_read_thread", "computer_click"],
      );
      assert.deepEqual(tools[1], {
        name: "computer_click",
        description: "Click",
        inputSchema: { type: "object" },
        annotations: { title: "Click" },
        _meta: { "anthropic/alwaysLoad": true },
      });
      // A tool that declares no _meta must not gain an empty one: an MCP client
      // is entitled to treat the key's absence as "no hints".
      assert.isFalse("_meta" in tools[0]!);
    }),
  );

  it.effect("withholds discovery-only tools from the list but still dispatches them", () =>
    Effect.gen(function* () {
      // The advertised catalog stays small on purpose: a tool marked
      // discoveryOnly is absent from tools/list yet reaches its handler on an
      // exact-name tools/call — capability and approval gates unchanged.
      const discoveryCatalog: ReadonlyArray<ToolEntry> = [
        ...catalog,
        {
          definition: {
            name: "computer_drag",
            description: "Drag",
            inputSchema: { type: "object" },
          },
          requiredCapability: "computer:control",
          discoveryOnly: true,
          handler: ok,
        },
      ];
      const transport = makeTransport({
        threads: [makeThread("thread-computer")],
        tools: discoveryCatalog,
        leaseCapabilities: { enableComputerControl: true },
      });
      const listResponse = yield* post(transport, "token-1", listBody);
      assert.equal(listResponse.status, 200);
      assert.deepEqual(
        listedTools(listResponse.body).map((tool) => tool.name),
        ["synara_read_thread", "computer_click"],
      );
      const callResponse = yield* post(transport, "token-1", toolCallBody("computer_drag"));
      assert.equal(callResponse.status, 200);
      assert.equal(
        (callResponse.body as { result: { content: Array<{ text: string }> } }).result.content[0]
          ?.text,
        "ok",
      );
    }),
  );
});

describe("makeAgentGatewayMcpTransport Expert tool authorization", () => {
  it.effect("resolves dynamic tools per verified session and preserves the call gates", () =>
    Effect.gen(function* () {
      const calls: Array<string> = [];
      const denials: Array<McpTransportTestDenial> = [];
      const resolverSessions: Array<{ sessionKey: string; threadId: string; provider: string }> =
        [];
      let failResolver = false;
      const dynamicTool = (name: string, owner: string): ToolEntry => ({
        definition: {
          name,
          description: owner,
          inputSchema: { type: "object" },
        },
        requiredCapability: "thread:read",
        requiresActiveTurn: true,
        sessionScoped: true,
        handler: (_args, context) =>
          Effect.sync(() => {
            calls.push(`${name}:${context.callerThreadId}`);
            return { content: [{ type: "text" as const, text: owner }] };
          }),
      });
      const sessionATool = dynamicTool("expert_session_a", "owner-a");
      const sessionBTool = dynamicTool("expert_session_b", "owner-b");
      const sessionAComputerTool: ToolEntry = {
        ...dynamicTool("expert_session_a_computer", "computer-a"),
        requiredCapability: "computer:control",
      };
      const staticSharedTool: ToolEntry = {
        definition: {
          name: "expert_shared",
          description: "static wins",
          inputSchema: { type: "object" },
        },
        requiredCapability: "thread:read",
        handler: (_args, context) =>
          Effect.sync(() => {
            calls.push(`expert_shared:${context.callerThreadId}`);
            return { content: [{ type: "text" as const, text: "static" }] };
          }),
      };
      const transport = makeTransport({
        threads: [makeThread("thread-expert-a"), makeThread("thread-expert-b")],
        tools: [staticSharedTool],
        // Dynamic sessionScoped tools are authorized by the resolver itself.
        authorizeTool: () => false,
        resolveSessionTools: ({ sessionKey, threadId, provider }) =>
          Effect.sync(() => {
            if (failResolver) throw new Error("fixture resolver failure");
            resolverSessions.push({ sessionKey, threadId, provider });
            const sessionTools =
              threadId === "thread-expert-a"
                ? [sessionATool, sessionAComputerTool]
                : threadId === "thread-expert-b"
                  ? [sessionBTool]
                  : [];
            return [
              ...sessionTools,
              {
                ...staticSharedTool,
                definition: { ...staticSharedTool.definition, description: "dynamic duplicate" },
              },
            ];
          }),
        onCapabilityDenied: (denial) =>
          Effect.sync(() => {
            denials.push(denial);
          }),
      });

      const listA = yield* post(transport, "token-1", {
        jsonrpc: "2.0",
        id: "list-a-dynamic",
        method: "tools/list",
      });
      const toolsA = listedTools(listA.body);
      assert.include(
        toolsA.map((tool) => tool.name),
        "expert_session_a",
      );
      assert.notInclude(
        toolsA.map((tool) => tool.name),
        "expert_session_b",
      );
      assert.notInclude(
        toolsA.map((tool) => tool.name),
        "expert_session_a_computer",
      );
      assert.equal(toolsA.filter((tool) => tool.name === "expert_shared").length, 1);
      assert.equal(findToolOrThrow(toolsA, "expert_shared").description, "static wins");

      const listB = yield* post(transport, "token-2", {
        jsonrpc: "2.0",
        id: "list-b-dynamic",
        method: "tools/list",
      });
      const toolsB = listedTools(listB.body);
      assert.include(
        toolsB.map((tool) => tool.name),
        "expert_session_b",
      );
      assert.notInclude(
        toolsB.map((tool) => tool.name),
        "expert_session_a",
      );

      const resolverCallsBeforeStaticCall = resolverSessions.length;
      failResolver = true;
      const staticCall = yield* post(transport, "token-1", toolCallBody("expert_shared"));
      failResolver = false;
      assert.equal(resolverSessions.length, resolverCallsBeforeStaticCall);
      assert.equal(
        (staticCall.body as { result: { content: Array<{ text: string }> } }).result.content[0]
          ?.text,
        "static",
      );
      const callA = yield* post(transport, "token-1", toolCallBody("expert_session_a"));
      assert.equal(
        (callA.body as { result: { content: Array<{ text: string }> } }).result.content[0]?.text,
        "owner-a",
      );
      const crossSessionCall = yield* post(transport, "token-2", toolCallBody("expert_session_a"));
      assert.equal(rpcErrorOf(crossSessionCall).code, -32602);
      assert.equal(rpcErrorOf(crossSessionCall).message, 'Unknown tool "expert_session_a".');
      const callB = yield* post(transport, "token-2", toolCallBody("expert_session_b"));
      assert.equal(
        (callB.body as { result: { content: Array<{ text: string }> } }).result.content[0]?.text,
        "owner-b",
      );

      const capabilityDenied = yield* post(
        transport,
        "token-1",
        toolCallBody("expert_session_a_computer"),
      );
      assert.equal(
        (toolResultErrorOf(capabilityDenied).error as { code: string }).code,
        "capability_denied",
      );
      assert.equal(denials.length, 1);

      transport.setThreadTurnState("thread-expert-a", "completed");
      const inactiveCall = yield* post(transport, "token-1", toolCallBody("expert_session_a"));
      assert.equal(
        (toolResultErrorOf(inactiveCall).error as { code: string }).code,
        "caller_turn_inactive",
      );
      assert.deepEqual(calls, [
        "expert_shared:thread-expert-a",
        "expert_session_a:thread-expert-a",
        "expert_session_b:thread-expert-b",
      ]);
      assert.isTrue(
        resolverSessions.some(
          (session) =>
            session.sessionKey === transport.sessionKeyForTokenAlias("token-1") &&
            session.threadId === "thread-expert-a" &&
            session.provider === "codex",
        ),
      );
      assert.isTrue(
        resolverSessions.some(
          (session) =>
            session.sessionKey === transport.sessionKeyForTokenAlias("token-2") &&
            session.threadId === "thread-expert-b" &&
            session.provider === "codex",
        ),
      );
    }),
  );

  it.effect(
    "authorizes exact tools per verified session over HTTP and rejects stale authority",
    () =>
      Effect.gen(function* () {
        const expertToolName = "expert_fixture_search";
        const allowedBySession = new Map<string, ReadonlySet<string>>();
        const expertOwnerBySession = new Map<string, string>();
        const authorizationCalls: Array<{
          readonly sessionKey: string;
          readonly threadId: string;
          readonly provider: string;
          readonly toolName: string;
        }> = [];
        const downstreamCalls: Array<{
          readonly sessionKey: string;
          readonly threadId: string;
          readonly expertOwner: string;
          readonly args: Record<string, unknown>;
        }> = [];
        const expertTool: ToolEntry = {
          definition: {
            name: expertToolName,
            description: "Search the fixture connection.",
            inputSchema: { type: "object", properties: {} },
          },
          requiredCapability: "thread:read",
          requiresActiveTurn: true,
          sessionScoped: true,
          handler: (args, context) =>
            Effect.sync(() => {
              const expertOwner = expertOwnerBySession.get(context.callerSessionKey);
              if (!expertOwner)
                throw new Error("Expected a fixture Expert connection for this session");
              downstreamCalls.push({
                sessionKey: context.callerSessionKey,
                threadId: context.callerThreadId,
                expertOwner,
                args,
              });
              return {
                content: [
                  { type: "text" as const, text: `fixture downstream result for ${expertOwner}` },
                ],
              };
            }),
        };
        const transport = makeTransport({
          threads: [makeThread("thread-expert-a"), makeThread("thread-expert-b")],
          tools: [
            {
              definition: {
                name: "synara_read_thread",
                description: "Read a Synara thread.",
                inputSchema: { type: "object" },
              },
              requiredCapability: "thread:read",
              handler: () => Effect.succeed({ content: [{ type: "text" as const, text: "ok" }] }),
            },
            expertTool,
          ],
          authorizeTool: (authorization) => {
            authorizationCalls.push(authorization);
            return (
              allowedBySession.get(authorization.sessionKey)?.has(authorization.toolName) === true
            );
          },
        });
        const sessionKeyA = transport.sessionKeyForTokenAlias("token-1");
        if (!sessionKeyA) throw new Error("Expected session A identity");
        const sessionKeyB = transport.sessionKeyForTokenAlias("token-2");
        if (!sessionKeyB) throw new Error("Expected session B identity");
        allowedBySession.set(sessionKeyA, new Set([expertToolName]));
        expertOwnerBySession.set(sessionKeyA, "expert-a");
        expertOwnerBySession.set(sessionKeyB, "expert-b");

        const httpServer = createServer(async (request, response) => {
          try {
            let rawBody = "";
            for await (const chunk of request) rawBody += String(chunk);
            const result = await Effect.runPromise(
              transport({
                authorizationHeader: request.headers.authorization,
                body: JSON.parse(rawBody) as unknown,
              }),
            );
            response.writeHead(result.status, { "content-type": "application/json" });
            response.end(JSON.stringify(result.body ?? {}));
          } catch {
            response.writeHead(500).end();
          }
        });
        httpServer.listen(0, "127.0.0.1");
        yield* Effect.tryPromise({
          try: () =>
            new Promise<void>((resolve, reject) => {
              httpServer.once("listening", resolve);
              httpServer.once("error", reject);
            }),
          catch: (error) => error,
        });
        const address = httpServer.address();
        if (!address || typeof address === "string") {
          throw new Error("Expected the local HTTP fixture to bind to a TCP port");
        }
        const endpoint = `http://127.0.0.1:${address.port}/mcp`;
        const postHttp = (tokenAlias: string, body: unknown) =>
          Effect.tryPromise({
            try: async () => {
              const response = await fetch(endpoint, {
                method: "POST",
                headers: {
                  Authorization: `Bearer ${transport.resolveToken(tokenAlias)}`,
                  "Content-Type": "application/json",
                },
                body: JSON.stringify(body),
              });
              return {
                status: response.status,
                body: (await response.json()) as Record<string, unknown>,
              };
            },
            catch: (error) => error,
          });
        const closeServer = () =>
          new Promise<void>((resolve, reject) =>
            httpServer.close((error) => (error ? reject(error) : resolve())),
          );

        try {
          const listA = yield* postHttp("token-1", {
            jsonrpc: "2.0",
            id: "list-a",
            method: "tools/list",
          });
          const namesA = listedTools(listA.body).map((tool) => tool.name);
          assert.include(namesA, expertToolName);
          assert.include(namesA, "synara_read_thread");

          const listB = yield* postHttp("token-2", {
            jsonrpc: "2.0",
            id: "list-b",
            method: "tools/list",
          });
          const namesB = listedTools(listB.body).map((tool) => tool.name);
          assert.notInclude(namesB, expertToolName);
          assert.include(namesB, "synara_read_thread");

          const callA = yield* postHttp("token-1", {
            jsonrpc: "2.0",
            id: "call-a",
            method: "tools/call",
            params: {
              name: expertToolName,
              arguments: { expertId: "expert-b", threadId: "thread-expert-b" },
            },
          });
          const callAResult = callA.body as {
            result: { content: Array<{ text: string }> };
          };
          assert.equal(
            callAResult.result.content[0]?.text,
            "fixture downstream result for expert-a",
          );
          assert.deepEqual(downstreamCalls, [
            {
              sessionKey: sessionKeyA,
              threadId: "thread-expert-a",
              expertOwner: "expert-a",
              args: { expertId: "expert-b", threadId: "thread-expert-b" },
            },
          ]);

          const callB = yield* postHttp("token-2", {
            jsonrpc: "2.0",
            id: "call-b",
            method: "tools/call",
            params: {
              name: expertToolName,
              arguments: { expertId: "expert-a", threadId: "thread-expert-a" },
            },
          });
          const callBError = rpcErrorOf({ body: callB.body });
          assert.equal(callBError.code, -32602);
          assert.equal(callBError.message, `Unknown tool "${expertToolName}".`);
          assert.lengthOf(downstreamCalls, 1);

          assert.isTrue(
            authorizationCalls.some(
              (authorization) =>
                authorization.sessionKey === sessionKeyA &&
                authorization.threadId === "thread-expert-a" &&
                authorization.provider === "codex" &&
                authorization.toolName === expertToolName,
            ),
          );
          assert.isTrue(
            authorizationCalls.some(
              (authorization) =>
                authorization.sessionKey === sessionKeyB &&
                authorization.threadId === "thread-expert-b" &&
                authorization.provider === "codex" &&
                authorization.toolName === expertToolName,
            ),
          );

          transport.setThreadTurnState("thread-expert-a", "completed");
          const inactiveA = yield* postHttp("token-1", {
            jsonrpc: "2.0",
            id: "call-a-inactive",
            method: "tools/call",
            params: { name: expertToolName, arguments: {} },
          });
          const inactiveError = toolResultErrorOf({ body: inactiveA.body }).error as {
            code: string;
          };
          assert.equal(inactiveError.code, "caller_turn_inactive");
          assert.lengthOf(downstreamCalls, 1);

          transport.revokeTokenAlias("token-1");
          const revokedA = yield* postHttp("token-1", {
            jsonrpc: "2.0",
            id: "list-a-revoked",
            method: "tools/list",
          });
          assert.equal(revokedA.status, 401);
          const revokedCallA = yield* postHttp("token-1", {
            jsonrpc: "2.0",
            id: "call-a-revoked",
            method: "tools/call",
            params: { name: expertToolName, arguments: {} },
          });
          assert.equal(revokedCallA.status, 401);
          assert.lengthOf(downstreamCalls, 1);
        } finally {
          yield* Effect.tryPromise({ try: closeServer, catch: (error) => error });
        }
      }),
  );

  it.effect("fails closed for session-scoped tools when no authorizer is wired", () =>
    Effect.gen(function* () {
      let handlerCalls = 0;
      const transport = makeTransport({
        threads: [makeThread("thread-expert-default-deny")],
        tools: [
          {
            definition: {
              name: "expert_fixture_search",
              description: "Search the fixture connection.",
              inputSchema: { type: "object" },
            },
            requiredCapability: "thread:read",
            requiresActiveTurn: true,
            sessionScoped: true,
            handler: () =>
              Effect.sync(() => {
                handlerCalls += 1;
                return { content: [{ type: "text" as const, text: "unexpected" }] };
              }),
          },
        ],
      });

      const listResponse = yield* post(transport, "token-1", {
        jsonrpc: "2.0",
        id: "list-scoped-default-deny",
        method: "tools/list",
      });
      assert.deepEqual(listedTools(listResponse.body), []);
      const callResponse = yield* post(transport, "token-1", toolCallBody("expert_fixture_search"));
      const error = rpcErrorOf(callResponse);
      assert.equal(error.code, -32602);
      assert.equal(error.message, 'Unknown tool "expert_fixture_search".');
      assert.equal(handlerCalls, 0);
    }),
  );
});

const toolCallBody = (name: string, args: Record<string, unknown> = {}) => ({
  jsonrpc: "2.0",
  id: `call-${name}`,
  method: "tools/call",
  params: { name, arguments: args },
});

const toolResultErrorOf = (response: { body?: unknown }): Record<string, unknown> => {
  const body = response.body as { result: { content: Array<{ text: string }> } };
  return JSON.parse(body.result.content[0]!.text) as Record<string, unknown>;
};

const rpcErrorOf = (response: { body?: unknown }): { code: number; message: string } =>
  (response.body as { error: { code: number; message: string } }).error;

const authorityDataOf = (response: { body?: unknown }): { code: string; retry: string } =>
  (response.body as { data: { code: string; retry: string } }).data;

describe("makeAgentGatewayMcpTransport capability truth", () => {
  const computerClick: ToolEntry = {
    definition: {
      name: "computer_click",
      description: "Click",
      inputSchema: { type: "object" },
    },
    requiredCapability: "computer:control",
    requiresActiveTurn: true,
    handler: () => Effect.succeed({ content: [{ type: "text" as const, text: "clicked" }] }),
  };

  it.effect(
    "checks turn authority before capability and keeps the denial hook silent on inactive turns",
    () =>
      Effect.gen(function* () {
        let handlerCalls = 0;
        const denials: Array<McpTransportTestDenial> = [];
        const transport = makeTransport({
          threads: [makeThread("thread-order")],
          tools: [
            {
              ...computerClick,
              handler: () => {
                handlerCalls += 1;
                return Effect.succeed({ content: [{ type: "text" as const, text: "clicked" }] });
              },
            },
          ],
          onCapabilityDenied: (denial) =>
            Effect.sync(() => {
              denials.push(denial);
            }),
        });
        // Active turn, missing capability: deny and surface exactly once.
        const denied = yield* post(transport, "token-1", toolCallBody("computer_click"));
        assert.equal(denied.status, 200);
        assert.equal(
          (toolResultErrorOf(denied).error as { code: string }).code,
          "capability_denied",
        );
        assert.equal(denials.length, 1);
        assert.equal(handlerCalls, 0);
        // Inactive turn, same missing capability: authority wins, hook stays silent.
        transport.setThreadTurnState("thread-order", "completed");
        const inactive = yield* post(transport, "token-1", {
          ...toolCallBody("computer_click"),
          id: "call-computer_click-inactive",
        });
        assert.equal(inactive.status, 200);
        assert.equal(
          (toolResultErrorOf(inactive).error as { code: string }).code,
          "caller_turn_inactive",
        );
        assert.equal(denials.length, 1);
        assert.equal(handlerCalls, 0);
      }),
  );

  it.effect("leaves entirely-unknown tool names as Unknown-tool", () =>
    Effect.gen(function* () {
      const denials: Array<McpTransportTestDenial> = [];
      const transport = makeTransport({
        threads: [makeThread("thread-unknown")],
        tools: [computerClick],
        computerToolNames: ["computer_click"],
        onCapabilityDenied: (denial) =>
          Effect.sync(() => {
            denials.push(denial);
          }),
      });
      const response = yield* post(transport, "token-1", toolCallBody("synara_frobnicate"));
      assert.equal(response.status, 200);
      const error = rpcErrorOf(response);
      assert.equal(error.code, -32602);
      assert.include(error.message, 'Unknown tool "synara_frobnicate".');
      assert.deepEqual(denials, []);
    }),
  );

  it.effect("denies an in-catalog computer name with the hook and explicit capability", () =>
    Effect.gen(function* () {
      const denials: Array<McpTransportTestDenial> = [];
      const transport = makeTransport({
        threads: [makeThread("thread-denied")],
        // The computer tool is known to the family but absent from this catalog.
        tools: [],
        computerToolNames: ["computer_click"],
        onCapabilityDenied: (denial) =>
          Effect.sync(() => {
            denials.push(denial);
          }),
      });
      const response = yield* post(transport, "token-1", toolCallBody("computer_click"));
      assert.equal(response.status, 200);
      const error = toolResultErrorOf(response).error as {
        code: string;
        details: { requiredCapability: string };
      };
      assert.equal(error.code, "capability_denied");
      assert.equal(error.details.requiredCapability, "computer:control");
      assert.deepEqual(denials, [
        {
          toolName: "computer_click",
          requiredCapability: "computer:control",
          callerThreadId: "thread-denied",
          callerTurnId: "turn-thread-denied",
        },
      ]);
    }),
  );

  it.effect("keeps the denial hook silent for an unknown computer tool on an inactive turn", () =>
    Effect.gen(function* () {
      const denials: Array<McpTransportTestDenial> = [];
      const transport = makeTransport({
        threads: [makeThread("thread-quiet")],
        tools: [],
        computerToolNames: ["computer_click"],
        onCapabilityDenied: (denial) =>
          Effect.sync(() => {
            denials.push(denial);
          }),
      });
      transport.setThreadTurnState("thread-quiet", "completed");
      const response = yield* post(transport, "token-1", toolCallBody("computer_click"));
      assert.equal(response.status, 200);
      assert.equal(
        (toolResultErrorOf(response).error as { code: string }).code,
        "caller_turn_inactive",
      );
      assert.deepEqual(denials, []);
    }),
  );

  it.effect("denies prefixed computer spellings without a lease with hook and capability", () =>
    Effect.gen(function* () {
      const denials: Array<McpTransportTestDenial> = [];
      const transport = makeTransport({
        threads: [makeThread("thread-prefixed")],
        // The computer tool is known to the family but absent from this catalog.
        tools: [],
        isComputerToolName: (toolName) => isSynaraComputerToolFamilyName(toolName),
        onCapabilityDenied: (denial) =>
          Effect.sync(() => {
            denials.push(denial);
          }),
      });
      for (const name of ["mcp__synara__computer_click", "synara_computer_click"] as const) {
        const response = yield* post(transport, "token-1", toolCallBody(name));
        assert.equal(response.status, 200);
        const error = toolResultErrorOf(response).error as {
          code: string;
          details: { requiredCapability: string };
        };
        assert.equal(error.code, "capability_denied");
        assert.equal(error.details.requiredCapability, "computer:control");
      }
      assert.deepEqual(
        denials.map((denial) => denial.toolName),
        ["mcp__synara__computer_click", "synara_computer_click"],
      );
    }),
  );

  it.effect("leaves foreign-prefixed and non-computer names as Unknown-tool", () =>
    Effect.gen(function* () {
      const denials: Array<McpTransportTestDenial> = [];
      const transport = makeTransport({
        threads: [makeThread("thread-foreign")],
        tools: [],
        isComputerToolName: (toolName) => isSynaraComputerToolFamilyName(toolName),
        onCapabilityDenied: (denial) =>
          Effect.sync(() => {
            denials.push(denial);
          }),
      });
      for (const name of [
        "foo_bar",
        "computer_future_tool",
        "mcp__other__computer_click",
      ] as const) {
        const response = yield* post(transport, "token-1", toolCallBody(name));
        assert.equal(response.status, 200);
        const error = rpcErrorOf(response);
        assert.equal(error.code, -32602);
        assert.include(error.message, `Unknown tool "${name}".`);
      }
      assert.deepEqual(denials, []);
    }),
  );

  it.effect("keeps the denial hook silent for a prefixed computer tool on an inactive turn", () =>
    Effect.gen(function* () {
      const denials: Array<McpTransportTestDenial> = [];
      const transport = makeTransport({
        threads: [makeThread("thread-quiet-prefixed")],
        tools: [],
        isComputerToolName: (toolName) => isSynaraComputerToolFamilyName(toolName),
        onCapabilityDenied: (denial) =>
          Effect.sync(() => {
            denials.push(denial);
          }),
      });
      transport.setThreadTurnState("thread-quiet-prefixed", "completed");
      const response = yield* post(transport, "token-1", toolCallBody("synara_computer_click"));
      assert.equal(response.status, 200);
      assert.equal(
        (toolResultErrorOf(response).error as { code: string }).code,
        "caller_turn_inactive",
      );
      assert.deepEqual(denials, []);
    }),
  );

  it.effect("reports structured authority codes with retry rules and never fires the hook", () =>
    Effect.gen(function* () {
      const denials: Array<McpTransportTestDenial> = [];
      const transport = makeTransport({
        threads: [
          makeThread("thread-authority"),
          {
            ...makeThread("thread-mismatch"),
            session: {
              threadId: ThreadId.makeUnsafe("thread-mismatch"),
              status: "running",
              providerName: "claudeAgent",
              runtimeMode: "full-access",
              activeTurnId: TurnId.makeUnsafe("turn-thread-mismatch"),
              lastError: null,
              updatedAt: NOW,
            },
          },
        ],
        ghostThreads: ["thread-ghost"],
        tools: [computerClick],
        computerToolNames: ["computer_click"],
        onCapabilityDenied: (denial) =>
          Effect.sync(() => {
            denials.push(denial);
          }),
      });
      const listBody = { jsonrpc: "2.0", id: "list", method: "tools/list" };
      const missing = yield* transport({ authorizationHeader: undefined, body: listBody });
      assert.equal(missing.status, 401);
      assert.deepEqual(authorityDataOf(missing), {
        code: "revoked-token",
        retry: "reauthenticate",
      });
      assert.include(rpcErrorOf(missing).message, "Do not retry with this token");
      const invalid = yield* transport({ authorizationHeader: "Bearer nope", body: listBody });
      assert.equal(invalid.status, 401);
      assert.deepEqual(authorityDataOf(invalid), {
        code: "revoked-token",
        retry: "reauthenticate",
      });
      const gone = yield* post(transport, "token-ghost-1", listBody);
      assert.equal(gone.status, 401);
      assert.deepEqual(authorityDataOf(gone), { code: "thread-gone", retry: "do-not-retry" });
      assert.include(rpcErrorOf(gone).message, "Do not retry");
      // token-2 leases thread-mismatch as codex, but the live session names claudeAgent.
      const mismatch = yield* post(transport, "token-2", listBody);
      assert.equal(mismatch.status, 401);
      assert.deepEqual(authorityDataOf(mismatch), {
        code: "provider-mismatch",
        retry: "re-lease",
      });
      assert.include(rpcErrorOf(mismatch).message, "Do not retry with this token");
      assert.deepEqual(denials, []);
    }),
  );
});
