import { createHash, randomUUID } from "node:crypto";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import * as path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  ProjectId,
  ThreadId,
  TurnId,
  type CapabilityBinding,
  type ExpertBinding,
  type OrchestrationThreadShell,
  type SuiteComposition,
} from "@synara/contracts";
import { Effect, Layer, Option, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";

import { ServerConfig } from "../config.ts";
import {
  ExpertDelegationStore,
  makeExpertDelegationStore,
} from "../workbench/host/expertDelegationStore.ts";
import { createExpertConnectionStore } from "../experts/ExpertConnectionStore.ts";
import { makeExpertGatewayToolResolver } from "../experts/ExpertGatewayTools.ts";
import { createExpertStore } from "../experts/ExpertStore.ts";
import { createRunSkillAssemblyStore } from "../experts/RunSkillAssemblyStore.ts";
import { readonlyResourceTestConfigLayer } from "../experts/expertResourceTestFixtures.ts";
import type { ProjectionSnapshotQueryShape } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { runMigrations } from "../persistence/Migrations.ts";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";
import {
  capabilityBindingFingerprint,
  makeSuiteCompositionStore,
  suiteCompositionFingerprint,
  suiteImportSourceKey,
  SuiteCompositionStore,
} from "../suites/SuiteCompositionStore.ts";
import { makeSuiteBindingResolver } from "../suites/SuiteBindingResolver.ts";
import { suiteContentDigest } from "../suites/suiteIdentity.ts";
import { runWorkbenchMigrations } from "../workbench/persistence/WorkbenchMigrations.ts";
import { makeOmpExpertExecutionStore } from "../provider/acp/OmpExpertExecutionStore.ts";
import { makeAgentGatewayCredentials } from "./Layers/AgentGatewayCredentials.ts";
import { makeAgentGatewaySessionRegistry } from "./Layers/AgentGatewaySessionRegistry.ts";
import { makeAgentGatewayMcpTransport } from "./mcpTransport.ts";
import {
  makeAgentGatewaySessionToolResolver,
  makeNativeExecutionAuthorizer,
} from "./nativeExecutionScope.ts";
import {
  AgentGatewaySessionRegistry,
  type AgentGatewayNativeExecution,
} from "./Services/AgentGatewaySessionRegistry.ts";
import type { ToolEntry } from "./toolRuntime.ts";

const createdAt = "2026-11-11T00:00:00.000Z";
const environment = Layer.mergeAll(
  NodeServices.layer,
  NodeSqliteClient.layerMemory(),
  readonlyResourceTestConfigLayer("native-gateway-").pipe(Layer.provide(NodeServices.layer)),
);

/** Real MCP servers read separate on-disk target documents and observe actual cancellation. */
async function startDocumentMcp(root: string, target: string) {
  const document = path.join(root, `${target}.txt`);
  const audit = path.join(root, `${target}.reads`);
  await writeFile(document, `Private document belonging to ${target}.`);
  const { promise: started, resolve: resolveStarted } = Promise.withResolvers<void>();
  const { promise: aborted, resolve: resolveAborted } = Promise.withResolvers<void>();
  const sessions = new Map<
    string,
    { server: McpServer; transport: StreamableHTTPServerTransport }
  >();
  let exposeAdditionalTool = false;
  let waiting = 0;
  const serve = async () => {
    const server = new McpServer({ name: `document-${target}`, version: "1.0.0" });
    const readDocument = async () => {
      const contents = await readFile(document, "utf8");
      await appendFile(audit, `${target}\n`);
      return {
        content: [{ type: "text" as const, text: contents }],
        structuredContent: { target, sha256: createHash("sha256").update(contents).digest("hex") },
      };
    };
    server.registerTool(
      `${target}_read`,
      { description: `Read ${target}'s actual document.`, inputSchema: {} },
      readDocument,
    );
    if (exposeAdditionalTool)
      server.registerTool(
        `${target}_new_read`,
        { description: "A later tool not in the first authorization.", inputSchema: {} },
        readDocument,
      );
    server.registerTool(
      `${target}_wait`,
      { description: "Wait for client cancellation.", inputSchema: {} },
      (_args, extra) => {
        waiting += 1;
        resolveStarted();
        const { promise, resolve } = Promise.withResolvers<CallToolResult>();
        const abort = () => {
          extra.signal.removeEventListener("abort", abort);
          waiting -= 1;
          resolveAborted();
          resolve({ content: [{ type: "text", text: "cancelled" }] });
        };
        if (extra.signal.aborted) abort();
        else extra.signal.addEventListener("abort", abort, { once: true });
        return promise;
      },
    );
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: randomUUID,
      enableJsonResponse: true,
      onsessioninitialized: (id) => {
        sessions.set(id, { server, transport });
      },
      onsessionclosed: (id) => {
        sessions.delete(id);
      },
    });
    await server.connect(transport as unknown as Transport);
    return { server, transport };
  };
  const http = createServer((request, response) => {
    void (async () => {
      const id = request.headers["mcp-session-id"];
      const session = typeof id === "string" ? sessions.get(id) : await serve();
      if (!session) {
        request.resume();
        response.writeHead(404).end();
        return;
      }
      await session.transport.handleRequest(request, response);
      if (session.transport.sessionId) sessions.set(session.transport.sessionId, session);
    })().catch(() => {
      if (!response.headersSent) response.writeHead(500).end();
      else response.destroy();
    });
  });
  const listening = Promise.withResolvers<void>();
  http.once("error", listening.reject);
  http.listen(0, "127.0.0.1", () => {
    http.off("error", listening.reject);
    listening.resolve();
  });
  await listening.promise;
  const address = http.address();
  if (!address || typeof address === "string") throw new Error("MCP fixture did not listen.");
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    document,
    audit,
    started,
    aborted,
    waiting: () => waiting,
    exposeAdditional: () => {
      exposeAdditionalTool = true;
    },
    close: async () => {
      await Promise.all([...sessions.values()].map(({ server }) => server.close()));
      http.closeAllConnections();
      const closed = Promise.withResolvers<void>();
      http.close((error) => (error ? closed.reject(error) : closed.resolve()));
      await closed.promise;
    },
  };
}

const fixture = Effect.gen(function* () {
  yield* runMigrations();
  yield* runWorkbenchMigrations();
  const config = yield* ServerConfig;
  const sql = yield* SqlClient.SqlClient;
  const bindings = yield* makeSuiteCompositionStore;
  const delegations = yield* makeExpertDelegationStore;
  const bindingResolver = yield* makeSuiteBindingResolver.pipe(
    Effect.provideService(SuiteCompositionStore, bindings),
  );
  const executions = yield* makeOmpExpertExecutionStore.pipe(
    Effect.provideService(ExpertDelegationStore, delegations),
  );
  const registry = makeAgentGatewaySessionRegistry();
  const credentials = yield* makeAgentGatewayCredentials.pipe(
    Effect.provideService(AgentGatewaySessionRegistry, registry),
  );
  const resolver = makeExpertGatewayToolResolver({ stateDir: config.stateDir });
  const offRevoke = credentials.onSessionRevoked?.((key) => resolver.closeSession(key));
  yield* Effect.addFinalizer(() =>
    Effect.promise(async () => {
      offRevoke?.();
      await resolver.closeAll();
    }),
  );
  const servers = yield* Effect.acquireRelease(
    Effect.promise(async () =>
      Promise.all(
        ["target_a", "target_b", "parent"].map((name) => startDocumentMcp(config.stateDir, name)),
      ),
    ),
    (entries) =>
      Effect.promise(async () => {
        await Promise.all(entries.map((entry) => entry.close()));
      }),
  );
  const connections = createExpertConnectionStore(config.stateDir);
  const experts = createExpertStore(config.stateDir);
  const snapshots: Array<ExpertBinding & { readonly configRevision: number }> = [];
  for (const [index, id] of ["a", "b", "parent"].entries()) {
    const saved = yield* Effect.promise(() =>
      connections.save({
        id,
        name: id,
        transport: { type: "http", url: servers[index]!.url, headersFromHost: [] },
      }),
    );
    const expert = yield* Effect.promise(() =>
      experts.save({
        id: `native-${id}`,
        name: `Native ${id}`,
        description: "Document reader",
        useCases: "Read only the target document",
        persona: `You are ${id}.`,
        outputRequirements: "Report the document hash.",
        skills: [],
        references: [],
        connections: [{ id, required: true, tools: [], toolMode: "all" }],
      }),
    );
    const base = yield* Effect.promise(() => experts.prepareSnapshot(expert.id));
    snapshots.push({ ...base, expertId: expert.id, configRevision: saved.revision });
  }
  const composition: SuiteComposition = {
    schemaVersion: 1,
    ref: { suiteId: `suite_${randomUUID()}`, revision: 1 },
    name: "Native document Suite",
    description: "",
    source: {
      kind: "local-folder",
      sourceId: "native-documents",
      contentHash: suiteContentDigest({ fixture: "native-documents" }),
    },
    adapterId: "synara-suite-v1",
    adapterVersion: 1,
    members: snapshots.map((snapshot, index) => ({
      key: `reader-${index}`,
      expertId: snapshot.expertId,
      roleSourcePath: null,
    })),
    resources: [],
    defaults: {},
    compositionHash: "0".repeat(64),
    createdAt,
  };
  const suite = { ...composition, compositionHash: suiteCompositionFingerprint(composition) };
  const request = {
    operationId: "native-suite-import",
    previewId: "native-suite-preview",
    contentHash: suite.source.contentHash,
    mode: "reuse-or-create" as const,
  };
  yield* bindings.beginImport(request, suiteContentDigest(request), {
    planId: "native-suite-plan",
    creatorOperationId: request.operationId,
    sourceKey: suiteImportSourceKey(suite),
    sourceRoot: config.stateDir,
    composition: suite,
    experts: suite.members.map(({ key, expertId }) => ({
      key,
      expertId,
      definition: null,
      bmadRole: null,
      roleSourceRoot: null,
      identityAvailable: true,
    })),
    assets: [],
    fileResourceRevisions: [],
    issues: [],
  });
  yield* bindings.completeImport("native-suite-plan");
  let parent: OrchestrationThreadShell = {
    id: ThreadId.makeUnsafe("parent-thread"),
    projectId: ProjectId.makeUnsafe("native-project"),
    title: "Parent Hub",
    modelSelection: { provider: "omp", model: "fixture-model" },
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
      turnId: TurnId.makeUnsafe("parent-turn"),
      state: "running",
      requestedAt: createdAt,
      startedAt: createdAt,
      completedAt: null,
      assistantMessageId: null,
    },
    latestUserMessageAt: createdAt,
    createdAt,
    updatedAt: createdAt,
    archivedAt: null,
    handoff: null,
    session: null,
    expertBinding: snapshots[2]!,
  };
  const assemblies = createRunSkillAssemblyStore(config.stateDir, { suiteStore: bindings });
  const generation = "native-gateway-generation";
  yield* sql`INSERT INTO provider_session_runtime(thread_id, provider_name, adapter_key, runtime_mode, status, lifecycle_generation, last_seen_at)
    VALUES (${parent.id}, 'omp', 'omp', 'full-access', 'running', ${generation}, ${createdAt})`;
  const authorize = makeNativeExecutionAuthorizer({
    stateDir: config.stateDir,
    delegations,
    bindings,
    executionOwner: executions,
  });
  const tokens: string[] = [];
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      for (const token of tokens) credentials.revokeSessionToken(token);
    }),
  );
  const issue = (
    nativeExecution?: AgentGatewayNativeExecution,
    expiresAt = Date.now() + 60_000,
    threadId = parent.id,
  ) => {
    const token = credentials.issueSessionToken(threadId, "omp", {
      ...(nativeExecution ? { nativeExecution } : {}),
      expiresAt,
    });
    tokens.push(token);
    return token;
  };
  const prepare = (
    target: 0 | 1,
    attemptId: string,
    transform?: (binding: CapabilityBinding) => CapabilityBinding,
  ) =>
    Effect.gen(function* () {
      const base = snapshots[target]!;
      const purpose = {
        kind: "native-delegate" as const,
        parentThreadId: parent.id,
        parentRootRunId: "parent-root",
        delegationId: `delegation-${attemptId}`,
        attemptId,
        expertSnapshotId: base.snapshotId,
      };
      const initial = yield* bindingResolver.prepare({
        suite: suite.ref,
        purpose,
        projectId: parent.projectId,
      });
      const binding = transform
        ? yield* bindings.saveBinding(transform({ ...initial, bindingId: `cap_${randomUUID()}` }))
        : initial;
      const assembly = yield* Effect.promise(() =>
        assemblies.prepare({
          threadId: parent.id,
          rootRunId: attemptId,
          baseSnapshotId: base.snapshotId,
          capabilityBindingId: binding.bindingId,
          createdAt,
        }),
      );
      const executionBindingId = `execution-${attemptId}`;
      yield* executions.prepare({
        execution: {
          executionBindingId,
          attemptId,
          provider: "omp",
          parentThreadId: parent.id,
          parentGeneration: generation,
          parentTurnId: "parent-turn",
          toolCallId: `tool-${attemptId}`,
          taskIndex: 0,
          nativeTaskId: `native-${attemptId}`,
          nativeSessionId: null,
          deliveryMode: "host-continuation",
          workRoot: config.stateDir,
          artifactRoot: path.join(config.stateDir, attemptId),
          lastSequence: 0,
        },
        admission: Effect.succeed(true),
        delegation: {
          delegationId: purpose.delegationId,
          parentThreadId: parent.id,
          parentRootRunId: purpose.parentRootRunId,
          targetExpertId: base.expertId,
          task: "Read the target file",
          context: "Do not read the parent's document",
          deliverable: "A SHA256",
        },
        attempt: {
          attemptId,
          delegationId: purpose.delegationId,
          requestId: `request-${attemptId}`,
          requestHash: suiteContentDigest({ attemptId }),
          provider: "omp",
          capabilityBindingId: binding.bindingId,
          assemblyId: assembly.assemblyId,
          executionBindingId,
          state: "prepared",
          revision: 1,
          resultRef: null,
          resultHash: null,
          appliedEventId: null,
          updatedAt: createdAt,
        },
      });
      yield* delegations.transition(attemptId, "starting", createdAt);
      yield* executions.started(
        {
          attemptId,
          nativeTaskId: `native-${attemptId}`,
          nativeSessionId: `sdk-${attemptId}`,
          parentGeneration: generation,
        },
        createdAt,
      );
      const scope: AgentGatewayNativeExecution = {
        executionBindingId,
        attemptId,
        capabilityBindingId: binding.bindingId,
        assemblyId: assembly.assemblyId,
        parentRootRunId: "parent-root",
      };
      return { binding, scope, token: issue(scope) };
    });
  const scopeAudit = path.join(config.stateDir, "principal.json");
  const adminAudit = path.join(config.stateDir, "parent-admin.txt");
  const hostTools: ToolEntry[] = [
    {
      definition: {
        name: "host_record_scope",
        description: "Record the authenticated principal.",
        inputSchema: { type: "object" },
      },
      requiredCapability: "browser:control",
      handler: (_args, context) =>
        Effect.promise(async () => {
          await writeFile(scopeAudit, JSON.stringify(context.principal));
          return { content: [{ type: "text", text: "Recorded authenticated scope." }] };
        }),
    },
    {
      definition: {
        name: "parent_admin",
        description: "A parent-only administration operation.",
        inputSchema: { type: "object" },
      },
      requiredCapability: "thread:read",
      handler: () =>
        Effect.promise(async () => {
          await writeFile(adminAudit, "parent administrative side effect");
          return { content: [{ type: "text", text: "Administrative operation performed." }] };
        }),
    },
  ];
  const requireThreadShell = (id: string) =>
    id === parent.id ? Effect.succeed(parent) : Effect.fail(new Error("Missing thread"));
  const transport = makeAgentGatewayMcpTransport({
    credentials,
    tools: hostTools,
    instructions: "Native execution test",
    nativeAllowedToolNames: new Set(hostTools.slice(0, 1).map((tool) => tool.definition.name)),
    snapshotQuery: {
      getThreadShellById: (id: ThreadId) =>
        Effect.succeed(id === parent.id ? Option.some(parent) : Option.none()),
    } as unknown as ProjectionSnapshotQueryShape,
    requireThreadShell,
    validateNativeExecution: (session, shell) => authorize(session, shell).pipe(Effect.asVoid),
    resolveSessionTools: makeAgentGatewaySessionToolResolver({
      requireThreadShell,
      authorizeNativeExecution: authorize,
      bindings,
      expertTools: resolver,
    }),
  });
  let requestId = 0;
  const post = (token: string, method: string, params: Record<string, unknown> = {}) =>
    transport({
      authorizationHeader: `Bearer ${token}`,
      body: { jsonrpc: "2.0", id: ++requestId, method, params },
    });
  return {
    config,
    sql,
    credentials,
    registry,
    resolver,
    bindings,
    delegations,
    executions,
    generation,
    get parent() {
      return parent;
    },
    servers,
    snapshots,
    setParent: (next: OrchestrationThreadShell) => {
      parent = next;
    },
    prepare,
    issue,
    post,
    scopeAudit,
    adminAudit,
    authorize,
    bindingResolver,
    suite,
  };
});

const ToolListResponse = Schema.Struct({
  result: Schema.Struct({
    tools: Schema.Array(Schema.Struct({ name: Schema.String })),
  }),
});
const ToolCallResponse = Schema.Struct({
  result: Schema.Struct({
    isError: Schema.optional(Schema.Boolean),
    structuredContent: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  }),
});
function toolsFrom(response: { readonly body?: unknown }) {
  const decoded = Schema.decodeUnknownSync(ToolListResponse)(response.body);
  return decoded.result.tools.map(({ name }) => name);
}
function resultFrom(response: { readonly body?: unknown }) {
  const decoded = Schema.decodeUnknownSync(ToolCallResponse)(response.body);
  return decoded.result;
}

describe("native Gateway execution authorization", () => {
  it("calls only each target's fixed directory with a trusted principal after the parent ends or changes turns", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const f = yield* fixture;
        const a = yield* f.prepare(0, "attempt-a");
        const b = yield* f.prepare(1, "attempt-b");
        const parentToken = f.issue();
        const [aList, bList, parentList] = yield* Effect.all(
          [
            f.post(a.token, "tools/list"),
            f.post(b.token, "tools/list"),
            f.post(parentToken, "tools/list"),
          ],
          { concurrency: "unbounded" },
        );
        expect(toolsFrom(aList)).toEqual(
          expect.arrayContaining(["host_record_scope", "expert_a_target_a_read"]),
        );
        expect(toolsFrom(aList)).not.toContain("parent_admin");
        expect(toolsFrom(aList)).not.toContain("expert_parent_parent_read");
        expect(toolsFrom(bList)).toContain("expert_b_target_b_read");
        expect(toolsFrom(bList)).not.toContain("expert_a_target_a_read");
        expect(toolsFrom(parentList)).toContain("expert_parent_parent_read");
        expect(
          (yield* f.post(parentToken, "tools/call", {
            name: "expert_a_target_a_read",
            arguments: { attemptId: a.scope.attemptId },
          })).body,
        ).toHaveProperty("error");
        expect(
          (yield* f.post(b.token, "tools/call", {
            name: "expert_a_target_a_read",
            arguments: { expertId: f.snapshots[0]!.expertId },
          })).body,
        ).toHaveProperty("error");
        expect(
          (yield* f.post(a.token, "tools/call", { name: "parent_admin" })).body,
        ).toHaveProperty("error");
        expect(
          (yield* f.post(a.token, "tools/call", { name: "expert_parent_parent_read" })).body,
        ).toHaveProperty("error");
        yield* Effect.promise(() =>
          expect(readFile(f.adminAudit)).rejects.toMatchObject({ code: "ENOENT" }),
        );
        yield* f.post(a.token, "tools/call", {
          name: "host_record_scope",
          arguments: { attemptId: b.scope.attemptId, expertId: "parent" },
        });
        const principal = yield* Effect.promise(async () =>
          JSON.parse(await readFile(f.scopeAudit, "utf8")),
        );
        expect(principal).toMatchObject({
          kind: "native-delegate",
          turnId: "attempt-a",
          nativeExecution: a.scope,
        });
        f.setParent({
          ...f.parent,
          latestTurn: { ...f.parent.latestTurn!, state: "completed", completedAt: createdAt },
        });
        yield* Effect.promise(() => f.credentials.retireSessionTurn(parentToken, "parent-turn"));
        expect(
          resultFrom(
            yield* f.post(a.token, "tools/call", {
              name: "expert_a_target_a_read",
              arguments: { attemptId: b.scope.attemptId },
            }),
          ).structuredContent,
        ).toMatchObject({ target: "target_a" });
        f.setParent({
          ...f.parent,
          latestTurn: {
            ...f.parent.latestTurn!,
            turnId: TurnId.makeUnsafe("parent-new-turn"),
            state: "running",
            completedAt: null,
          },
        });
        expect(
          resultFrom(yield* f.post(b.token, "tools/call", { name: "expert_b_target_b_read" }))
            .structuredContent,
        ).toMatchObject({ target: "target_b" });
        expect(yield* Effect.promise(() => readFile(f.servers[0]!.audit, "utf8"))).toBe(
          "target_a\n",
        );
        expect(yield* Effect.promise(() => readFile(f.servers[1]!.audit, "utf8"))).toBe(
          "target_b\n",
        );
        yield* Effect.promise(() =>
          expect(readFile(f.servers[2]!.audit)).rejects.toMatchObject({ code: "ENOENT" }),
        );
      }).pipe(Effect.provide(environment), Effect.scoped),
    );
  });

  it.each([
    "replacement-generation",
    "stopped",
    "error",
    "missing-runtime",
    "missing-execution",
  ] as const)(
    "rejects existing native HTTP list and call leases after %s without touching the target",
    async (change) => {
      await Effect.runPromise(
        Effect.gen(function* () {
          const f = yield* fixture;
          const a = yield* f.prepare(0, "runtime-bound-http");
          const callToken = f.issue(a.scope);
          expect(toolsFrom(yield* f.post(a.token, "tools/list"))).toContain(
            "expert_a_target_a_read",
          );
          expect(
            resultFrom(yield* f.post(callToken, "tools/call", { name: "expert_a_target_a_read" }))
              .structuredContent?.target,
          ).toBe("target_a");
          if (change === "replacement-generation") {
            yield* f.sql`UPDATE provider_session_runtime SET lifecycle_generation = 'replacement-generation' WHERE thread_id = ${f.parent.id}`;
          } else if (change === "missing-runtime") {
            yield* f.sql`DELETE FROM provider_session_runtime WHERE thread_id = ${f.parent.id}`;
          } else if (change === "missing-execution") {
            yield* f.sql`DELETE FROM omp_expert_execution_bindings WHERE attempt_id = ${a.scope.attemptId}`;
          } else {
            yield* f.sql`UPDATE provider_session_runtime SET status = ${change} WHERE thread_id = ${f.parent.id}`;
          }
          expect((yield* f.delegations.readAttempt(a.scope.attemptId))?.state).toBe("running");
          expect((yield* f.post(a.token, "tools/list")).status).toBe(401);
          expect(
            (yield* f.post(callToken, "tools/call", { name: "expert_a_target_a_read" })).status,
          ).toBe(401);
          expect(f.credentials.verifySession(a.token)).toBeNull();
          expect(f.credentials.verifySession(callToken)).toBeNull();
          expect(yield* Effect.promise(() => readFile(f.servers[0]!.audit, "utf8"))).toBe(
            "target_a\n",
          );
        }).pipe(Effect.provide(environment), Effect.scoped),
      );
    },
  );

  it("uses the same real capability branch for normal Suite threads and never falls back to a cached snapshot", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const f = yield* fixture;
        const token = f.issue();
        expect(toolsFrom(yield* f.post(token, "tools/list"))).toContain(
          "expert_parent_parent_read",
        );
        const direct = yield* f.bindingResolver.prepare({
          suite: f.suite.ref,
          purpose: { kind: "direct-expert", expertSnapshotId: f.snapshots[0]!.snapshotId },
          projectId: f.parent.projectId,
        });
        f.setParent({
          ...f.parent,
          expertBinding: f.snapshots[0]!,
          capabilityBindingId: direct.bindingId,
        });
        expect(toolsFrom(yield* f.post(token, "tools/list"))).toContain("expert_a_target_a_read");
        expect(
          (yield* f.post(token, "tools/call", { name: "expert_parent_parent_read" })).body,
        ).toHaveProperty("error");
        expect(
          resultFrom(yield* f.post(token, "tools/call", { name: "expert_a_target_a_read" }))
            .structuredContent?.target,
        ).toBe("target_a");
        const child = yield* f.prepare(1, "independent-child");
        f.setParent({ ...f.parent, capabilityBindingId: "missing-binding" });
        const missing = toolsFrom(yield* f.post(token, "tools/list"));
        expect(missing).not.toContain("expert_a_target_a_read");
        expect(missing).not.toContain("expert_parent_parent_read");
        expect(
          resultFrom(yield* f.post(child.token, "tools/call", { name: "expert_b_target_b_read" }))
            .structuredContent?.target,
        ).toBe("target_b");
        const coordinator = yield* f.bindingResolver.prepare({
          suite: f.suite.ref,
          purpose: { kind: "hub-coordinator", hubId: "real-hub", hubConfigRevision: 1 },
          projectId: f.parent.projectId,
        });
        f.setParent({
          ...f.parent,
          expertBinding: null,
          capabilityBindingId: coordinator.bindingId,
        });
        expect(
          toolsFrom(yield* f.post(token, "tools/list")).filter((name) =>
            name.startsWith("expert_"),
          ),
        ).toEqual([]);
      }).pipe(Effect.provide(environment), Effect.scoped),
    );
  });

  it("denies forged references, unknown/cancelled/terminal attempts and corrupt assembly references", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const f = yield* fixture;
        const a = yield* f.prepare(0, "checked-attempt");
        const b = yield* f.prepare(1, "sibling-attempt");
        for (const forged of [
          { ...a.scope, attemptId: b.scope.attemptId },
          { ...a.scope, executionBindingId: "forged-execution" },
          { ...a.scope, capabilityBindingId: b.scope.capabilityBindingId },
          { ...a.scope, assemblyId: b.scope.assemblyId },
          { ...a.scope, parentRootRunId: "other-root" },
        ])
          expect((yield* f.post(f.issue(forged), "tools/list")).status).toBe(401);
        const anotherThread = {
          ...f.registry.verify(a.token)!,
          threadId: ThreadId.makeUnsafe("other-parent"),
        };
        expect(
          (yield* f
            .authorize(anotherThread, { ...f.parent, id: anotherThread.threadId })
            .pipe(Effect.result))._tag,
        ).toBe("Failure");
        expect(
          (yield* f
            .authorize(f.registry.verify(a.token)!, {
              ...f.parent,
              projectId: ProjectId.makeUnsafe("other-project"),
            })
            .pipe(Effect.result))._tag,
        ).toBe("Failure");
        const missingOwner = makeNativeExecutionAuthorizer({ stateDir: f.config.stateDir });
        expect(
          (yield* missingOwner(f.registry.verify(a.token)!, f.parent).pipe(Effect.result))._tag,
        ).toBe("Failure");
        const missingExecutionOwner = makeNativeExecutionAuthorizer({
          stateDir: f.config.stateDir,
          delegations: f.delegations,
          bindings: f.bindings,
        });
        expect(
          (yield* missingExecutionOwner(f.registry.verify(a.token)!, f.parent).pipe(Effect.result))
            ._tag,
        ).toBe("Failure");
        const copiedParentKnowledge = f.credentials.issueSessionToken(f.parent.id, "omp", {
          nativeExecution: a.scope,
          expiresAt: Date.now() + 60_000,
          learningSession: {
            manifestId: "parent-manifest",
            rootRunId: "parent-root",
            snapshotId: f.snapshots[2]!.snapshotId,
            scope: {
              ownerId: "owner",
              spaceId: null,
              expertId: f.snapshots[2]!.expertId,
              projectId: f.parent.projectId,
            },
            knowledgeHash: `sha256:${"a".repeat(64)}`,
          },
        });
        expect((yield* f.post(copiedParentKnowledge, "tools/list")).status).toBe(401);
        yield* f.delegations.transition(a.scope.attemptId, "unknown", createdAt);
        expect((yield* f.post(a.token, "tools/list")).status).toBe(401);
        yield* f.delegations.transition(a.scope.attemptId, "running", createdAt);
        // Returning to running cannot revive a bearer revoked while unknown.
        expect((yield* f.post(a.token, "tools/list")).status).toBe(401);
        const replacement = f.issue(a.scope);
        expect((yield* f.post(replacement, "tools/list")).status).toBe(200);
        yield* f.delegations.transition(a.scope.attemptId, "cancel-requested", createdAt);
        expect(
          (yield* f.post(replacement, "tools/call", { name: "expert_a_target_a_read" })).status,
        ).toBe(401);
        yield* f.sql.withTransaction(
          f.delegations.commitResult({
            attemptId: b.scope.attemptId,
            content: {
              outcome: "completed",
              result: { summary: "Document was read", artifacts: [] },
              issue: null,
            },
            appliedEventId: "terminal-result-fixture",
            updatedAt: createdAt,
          }),
        );
        expect((yield* f.post(b.token, "tools/list")).status).toBe(401);
        const c = yield* f.prepare(0, "assembly-integrity");
        const assemblyFile = path.join(
          f.config.stateDir,
          "experts",
          "run-skill-assemblies",
          `${createHash("sha256").update(c.scope.attemptId).digest("hex")}.json`,
        );
        const record = yield* Effect.promise(async () =>
          JSON.parse(await readFile(assemblyFile, "utf8")),
        );
        yield* Effect.promise(() =>
          writeFile(assemblyFile, JSON.stringify({ ...record, bindingId: "other-binding" })),
        );
        expect((yield* f.post(c.token, "tools/list")).status).toBe(401);
      }).pipe(Effect.provide(environment), Effect.scoped),
    );
  });

  it("aborts exactly one revoked child's in-flight call while its sibling remains active", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const f = yield* fixture;
        const a = yield* f.prepare(0, "cancel-a");
        const b = yield* f.prepare(1, "cancel-b");
        const aCall = Effect.runPromise(
          f.post(a.token, "tools/call", { name: "expert_a_target_a_wait" }),
        );
        const bCall = Effect.runPromise(
          f.post(b.token, "tools/call", { name: "expert_b_target_b_wait" }),
        );
        yield* Effect.promise(() => Promise.all([f.servers[0]!.started, f.servers[1]!.started]));
        yield* f.delegations.transition(a.scope.attemptId, "cancel-requested", createdAt);
        f.credentials.revokeSessionToken(a.token);
        yield* Effect.promise(() =>
          f.credentials.cancelSessionTurnRequests(a.token, a.scope.attemptId),
        );
        yield* Effect.promise(() => f.servers[0]!.aborted);
        yield* Effect.promise(() => aCall);
        expect(f.servers[0]!.waiting()).toBe(0);
        expect(f.servers[1]!.waiting()).toBe(1);
        expect((yield* f.post(a.token, "tools/list")).status).toBe(401);
        expect(
          resultFrom(yield* f.post(b.token, "tools/call", { name: "expert_b_target_b_read" }))
            .structuredContent?.target,
        ).toBe("target_b");
        f.credentials.revokeSessionToken(b.token);
        yield* Effect.promise(() => f.servers[1]!.aborted);
        yield* Effect.promise(() => bCall);
      }).pipe(Effect.provide(environment), Effect.scoped),
    );
  });

  it("expires real credentials, drains their MCP client and never revives the old token", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const f = yield* fixture;
        const a = yield* f.prepare(0, "expires-a");
        const b = yield* f.prepare(1, "expires-b");
        const token = f.issue(a.scope, Date.now() + 1_000);
        const sessionKey = f.credentials.verifySession(token)!.sessionKey;
        const { promise: cleaned, resolve: closed } = Promise.withResolvers<void>();
        const off = f.credentials.onSessionRevoked?.((key) => {
          if (key === sessionKey) closed();
        });
        const pending = Effect.runPromise(
          f.post(token, "tools/call", { name: "expert_a_target_a_wait" }),
        );
        yield* Effect.promise(() => f.servers[0]!.started);
        yield* Effect.promise(() => f.servers[0]!.aborted);
        yield* Effect.promise(() => Promise.all([pending, cleaned]));
        off?.();
        expect(f.credentials.verifySession(token)).toBeNull();
        expect((yield* f.post(token, "tools/list")).status).toBe(401);
        expect((yield* f.post(b.token, "tools/list")).status).toBe(200);
        expect((yield* f.post(f.issue(a.scope), "tools/list")).status).toBe(200);
      }).pipe(Effect.provide(environment), Effect.scoped),
    );
  });

  it("keeps missing pinned revisions and disabled selections local without reading latest, and freezes all-mode in the existing owner", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const f = yield* fixture;
        const a = yield* f.prepare(0, "partial-a", (initial) => {
          const binding: CapabilityBinding = {
            ...initial,
            connections: [
              ...initial.connections,
              { id: "parent", required: true, tools: ["parent_read"] },
              { id: "b", required: true, enabled: false, tools: [], toolMode: "selected" },
            ],
            mcpBinding: {
              ...initial.mcpBinding!,
              servers: [
                ...initial.mcpBinding!.servers,
                // parent is configured and active, but this fixed record has no revision.
                { id: "parent", required: true, tools: ["parent_read"] },
                // A conflicting disabled selection must never be unioned back in.
                {
                  id: "b",
                  required: true,
                  tools: ["target_b_read"],
                  configRevision: f.snapshots[1]!.configRevision,
                },
              ],
            },
          };
          return { ...binding, bindingHash: capabilityBindingFingerprint(binding) };
        });
        const names = toolsFrom(yield* f.post(a.token, "tools/list"));
        expect(names).toContain("expert_a_target_a_read");
        expect(names).not.toContain("expert_parent_parent_read");
        expect(names).not.toContain("expert_b_target_b_read");
        expect(
          resultFrom(yield* f.post(a.token, "tools/call", { name: "expert_a_target_a_read" }))
            .structuredContent?.target,
        ).toBe("target_a");
        expect(
          (yield* f.post(a.token, "tools/call", { name: "expert_parent_parent_read" })).body,
        ).toHaveProperty("error");
        f.servers[0]!.exposeAdditional();
        // A second resolver/client still consumes the original authorization sidecar.
        const reopened = makeExpertGatewayToolResolver({ stateDir: f.config.stateDir });
        yield* Effect.addFinalizer(() => Effect.promise(() => reopened.closeAll()));
        const reopenedNames = yield* Effect.promise(async () =>
          (await reopened.resolveBinding("new-session", a.binding)).map(
            (tool) => tool.definition.name,
          ),
        );
        expect(reopenedNames).not.toContain("expert_a_target_a_new_read");
        expect((yield* f.bindings.readBinding(a.binding.bindingId))?.bindingHash).toBe(
          a.binding.bindingHash,
        );
        const sidecarKey = `cap_${createHash("sha256").update(a.binding.bindingId).digest("hex")}`;
        const sidecar = yield* Effect.promise(async () =>
          JSON.parse(
            await readFile(
              path.join(f.config.stateDir, "expert-mcp-bindings", `${sidecarKey}.json`),
              "utf8",
            ),
          ),
        );
        expect(
          sidecar.servers.find((entry: { id: string }) => entry.id === "a").effectiveTools,
        ).toEqual(["target_a_read", "target_a_wait"]);
        const connections = createExpertConnectionStore(f.config.stateDir);
        const state = yield* Effect.promise(() => connections.readState("a"));
        yield* Effect.promise(() =>
          connections.setState({ id: "a", status: "disabled", expectedRevision: state.revision }),
        );
        expect(toolsFrom(yield* f.post(a.token, "tools/list"))).not.toContain(
          "expert_a_target_a_read",
        );
      }).pipe(Effect.provide(environment), Effect.scoped),
    );
  });
});
