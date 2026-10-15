import { createHash } from "node:crypto";

import * as path from "node:path";

import type { ExpertSnapshot } from "@synara/contracts";
import { Effect } from "effect";

import type { McpToolCallResult, McpToolDefinition } from "../agentGateway/protocol.ts";
import type { ToolEntry } from "../agentGateway/toolRuntime.ts";
import { createExpertMcpCredentialStore } from "./ExpertMcpCredentials.ts";
import { createExpertConnectionStore } from "./ExpertConnectionStore.ts";
import { createExpertMcpBindingStore } from "./ExpertMcpBindingStore.ts";
import { connectExpertMcp } from "./ExpertMcpClient.ts";
import { createExpertStore } from "./ExpertStore.ts";

type ConnectedExpertMcp = Awaited<ReturnType<typeof connectExpertMcp>>;

type ExpertGatewayToolResolverOptions = {
  readonly stateDir: string;
  readonly connect?: typeof connectExpertMcp;
};

function createDefaultExpertMcpConnector(stateDir: string): typeof connectExpertMcp {
  const credentials = createExpertMcpCredentialStore(stateDir);
  return (config) => connectExpertMcp(config, { credentials });
}

type RuntimeConnection = {
  readonly id: string;
  readonly indexToken: symbol;
  readonly client: ConnectedExpertMcp;
  readonly revokeController: AbortController;
  revoked: boolean;
  closePromise?: Promise<void>;
};

type SessionCatalog = {
  readonly sessionKey: string;
  readonly snapshotId: string;
  readonly stateDir: string;
  readonly revokedConnectionIds: Set<string>;
  readonly connections: Map<string, RuntimeConnection>;
  tools: ToolEntry[];
  initializing?: Promise<void>;
  closePromise?: Promise<void>;
  closed: boolean;
};

const activeExpertMcpSessions = new Map<string, Map<string, Map<symbol, string>>>();
const MAX_REVOKED_SESSION_KEYS = 4_096;

function indexConnection(stateDir: string, sessionKey: string, connection: RuntimeConnection) {
  const connections = activeExpertMcpSessions.get(stateDir) ?? new Map();
  const sessions = connections.get(connection.id) ?? new Map();
  sessions.set(connection.indexToken, sessionKey);
  connections.set(connection.id, sessions);
  activeExpertMcpSessions.set(stateDir, connections);
}

function unindexConnection(stateDir: string, connection: RuntimeConnection) {
  const connections = activeExpertMcpSessions.get(stateDir);
  const sessions = connections?.get(connection.id);
  sessions?.delete(connection.indexToken);
  if (sessions?.size === 0) connections?.delete(connection.id);
  if (connections?.size === 0) activeExpertMcpSessions.delete(stateDir);
}

/** Active provider-session count used by the Expert connection references RPC. */
export function readExpertMcpActiveSessionCount(stateDir: string, connectionId: string): number {
  const sessions = activeExpertMcpSessions.get(path.resolve(stateDir))?.get(connectionId);
  return new Set(sessions?.values() ?? []).size;
}

async function resolveSnapshotMcpBinding(
  snapshot: ExpertSnapshot,
  stateDir: string,
  connectionStore: ReturnType<typeof createExpertConnectionStore>,
) {
  if (snapshot.mcpBinding) return snapshot.mcpBinding;

  // Pre-MCP-1 snapshots are never edited. The first safe connection boundary
  // captures their then-current revisions once in the sidecar store.
  const bindingStore = createExpertMcpBindingStore(stateDir);
  return bindingStore.get(snapshot.snapshotId, async () => {
    const servers = [];
    for (const connection of snapshot.connections) {
      if (connection.enabled === false || connection.tools.length === 0) continue;
      const config = await connectionStore.pinRevision(connection.id);
      if (!config && connection.required) {
        throw new Error(`Required expert connection is not configured: ${connection.id}`);
      }
      servers.push({
        id: connection.id,
        ...(config ? { configRevision: config.revision } : {}),
        required: connection.required,
        tools: connection.tools,
      });
    }
    return {
      schemaVersion: 1 as const,
      source: "legacy-current" as const,
      createdAt: new Date().toISOString(),
      servers,
    };
  });
}

function bindingUnavailableMessage(id: string, status?: string): string {
  if (status === "retired") return `Expert connection has been retired: ${id}`;
  if (status === "disabled") return `Expert connection is disabled: ${id}`;
  return `Expert connection is unavailable: ${id}`;
}

function closeRuntimeConnection(
  stateDir: string,
  connection: RuntimeConnection,
  reason: Error,
): Promise<void> {
  connection.revoked = true;
  if (!connection.revokeController.signal.aborted) connection.revokeController.abort(reason);
  unindexConnection(stateDir, connection);
  connection.closePromise ??= connection.client.close().catch(() => undefined);
  return connection.closePromise;
}

function gatewayToolName(connectionId: string, downstreamName: string): string {
  const original = `expert_${connectionId}_${downstreamName}`;
  const readable = original.replace(/[^A-Za-z0-9_-]/gu, "_");
  if (readable === original && readable.length <= 128) return readable;
  const digest = createHash("sha256")
    .update(`${connectionId}\0${downstreamName}`)
    .digest("hex")
    .slice(0, 12);
  return `${readable.slice(0, 115)}_${digest}`;
}

function toolDefinition(
  connectionId: string,
  downstream: ConnectedExpertMcp["tools"][number],
): McpToolDefinition {
  const annotations = downstream.annotations;
  return {
    name: gatewayToolName(connectionId, downstream.name),
    description:
      downstream.description ??
      `Tool ${downstream.name} supplied by expert connection ${connectionId}.`,
    inputSchema: downstream.inputSchema as Record<string, unknown>,
    ...(downstream.outputSchema
      ? { outputSchema: downstream.outputSchema as Record<string, unknown> }
      : {}),
    ...(annotations
      ? {
          annotations: {
            ...(annotations.title ? { title: annotations.title } : {}),
            ...(annotations.readOnlyHint !== undefined
              ? { readOnlyHint: annotations.readOnlyHint }
              : {}),
            ...(annotations.destructiveHint !== undefined
              ? { destructiveHint: annotations.destructiveHint }
              : {}),
            ...(annotations.idempotentHint !== undefined
              ? { idempotentHint: annotations.idempotentHint }
              : {}),
            ...(annotations.openWorldHint !== undefined
              ? { openWorldHint: annotations.openWorldHint }
              : {}),
          },
        }
      : {}),
  };
}

function callResult(value: Awaited<ReturnType<ConnectedExpertMcp["callTool"]>>): McpToolCallResult {
  const raw = value as Record<string, unknown>;
  const content: McpToolCallResult["content"][number][] = [];
  for (const item of Array.isArray(raw.content) ? raw.content : []) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) continue;
    const block = item as Record<string, unknown>;
    if (block.type === "text" && typeof block.text === "string") {
      content.push({ type: "text", text: block.text });
      continue;
    }
    if (
      block.type === "image" &&
      typeof block.data === "string" &&
      typeof block.mimeType === "string"
    ) {
      content.push({ type: "image", data: block.data, mimeType: block.mimeType });
    }
  }
  const structuredContent =
    raw.structuredContent !== null &&
    typeof raw.structuredContent === "object" &&
    !Array.isArray(raw.structuredContent)
      ? (raw.structuredContent as Record<string, unknown>)
      : undefined;
  return {
    content:
      content.length > 0
        ? content
        : [
            {
              type: "text",
              text: structuredContent
                ? JSON.stringify(structuredContent, null, 2)
                : "Tool completed.",
            },
          ],
    ...(typeof raw.isError === "boolean" ? { isError: raw.isError } : {}),
    ...(structuredContent ? { structuredContent } : {}),
  };
}

async function inspectSnapshotConnections(
  snapshot: ExpertSnapshot,
  stateDir: string,
  connect: typeof connectExpertMcp,
): Promise<{ readonly optionalIssues: string[] }> {
  const connectionStore = createExpertConnectionStore(stateDir);
  const optionalIssues: string[] = [];
  const binding = await resolveSnapshotMcpBinding(snapshot, stateDir, connectionStore);
  for (const server of binding.servers) {
    if (server.tools.length === 0) continue;
    const unavailable = (message: string) => {
      if (server.required) throw new Error(message);
      optionalIssues.push(message);
    };
    if (server.configRevision === undefined) {
      unavailable(`连接“${server.id}”尚未配置。`);
      continue;
    }
    let state;
    try {
      state = await connectionStore.readState(server.id);
    } catch (cause) {
      unavailable(`连接“${server.id}”状态不可用。`);
      if (server.required) throw new Error(`必需连接“${server.id}”状态不可用。`, { cause });
      continue;
    }
    if (state.status !== "active") {
      unavailable(bindingUnavailableMessage(server.id, state.status));
      continue;
    }
    let config;
    try {
      config = await connectionStore.readRevision(server.id, server.configRevision);
    } catch (cause) {
      unavailable(`连接“${server.id}”版本 ${server.configRevision} 不可用。`);
      if (server.required) {
        throw new Error(`必需连接“${server.id}”版本 ${server.configRevision} 不可用。`, {
          cause,
        });
      }
      continue;
    }
    if (!config) {
      unavailable(`连接“${server.id}”版本 ${server.configRevision} 不可用。`);
      continue;
    }
    let client: ConnectedExpertMcp | undefined;
    try {
      client = await connect(config);
      state = await connectionStore.readState(server.id);
      if (state.status !== "active") {
        unavailable(bindingUnavailableMessage(server.id, state.status));
        continue;
      }
      const names = new Set(client.tools.map((tool) => tool.name));
      const missing = server.tools.filter((name) => !names.has(name));
      if (missing.length > 0) {
        unavailable(`连接“${server.id}”不可用，缺少工具：${missing.join("、")}。`);
      }
    } catch (cause) {
      if (server.required) {
        throw new Error(`必需连接“${server.id}”不可用。`, { cause });
      }
      optionalIssues.push(`可选连接“${server.id}”当前不可用。`);
    } finally {
      if (client) await client.close().catch(() => undefined);
    }
  }
  return { optionalIssues };
}

export async function preflightExpertConnections(
  snapshot: ExpertSnapshot,
  options: ExpertGatewayToolResolverOptions,
): Promise<{ readonly optionalIssues: string[] }> {
  return inspectSnapshotConnections(
    snapshot,
    options.stateDir,
    options.connect ?? createDefaultExpertMcpConnector(options.stateDir),
  );
}

export function makeExpertGatewayToolResolver(options: ExpertGatewayToolResolverOptions): {
  readonly resolve: (sessionKey: string, snapshotId: string) => Promise<ReadonlyArray<ToolEntry>>;
  readonly closeSession: (sessionKey: string) => Promise<void>;
  readonly closeAll: () => Promise<void>;
} {
  const expertStore = createExpertStore(options.stateDir);
  const connectionStore = createExpertConnectionStore(options.stateDir);
  const connect = options.connect ?? createDefaultExpertMcpConnector(options.stateDir);
  const normalizedStateDir = path.resolve(options.stateDir);
  const sessions = new Map<string, Map<string, SessionCatalog>>();
  const revokedSessionKeys = new Set<string>();
  const activeSnapshots = new Map<
    string,
    { readonly snapshotId: string; readonly transition: Promise<void> }
  >();
  let closed = false;
  let closeAllPromise: Promise<void> | undefined;

  const closeRecord = (record: SessionCatalog): Promise<void> => {
    record.closePromise ??= (async () => {
      record.closed = true;
      const closeConnections = () =>
        Promise.allSettled(
          [...record.connections.values()].map((connection) =>
            closeRuntimeConnection(
              record.stateDir,
              connection,
              new Error("Expert MCP session was closed."),
            ),
          ),
        );
      await closeConnections();
      await record.initializing?.catch(() => undefined);
      await closeConnections();
    })();
    return record.closePromise;
  };

  const revokeConnection = (record: SessionCatalog, connectionId: string, status: string) => {
    record.revokedConnectionIds.add(connectionId);
    const connection = record.connections.get(connectionId);
    if (connection) {
      void closeRuntimeConnection(
        record.stateDir,
        connection,
        new Error(bindingUnavailableMessage(connectionId, status)),
      );
    }
  };

  const unsubscribeStateChanges = connectionStore.subscribeStateChanges((state) => {
    if (state.status === "active") return;
    for (const records of sessions.values()) {
      for (const record of records.values()) {
        revokeConnection(record, state.id, state.status);
      }
    }
  });

  const createCatalog = async (record: SessionCatalog): Promise<void> => {
    const snapshot = await expertStore.readSnapshot(record.snapshotId);
    if (record.closed) return;
    const binding = await resolveSnapshotMcpBinding(snapshot, options.stateDir, connectionStore);
    if (record.closed) return;
    const exposedNames = new Set<string>();
    const seenConnectionIds = new Set<string>();
    try {
      for (const server of binding.servers) {
        if (record.closed) return;
        if (seenConnectionIds.has(server.id)) {
          throw new Error(`Expert snapshot contains duplicate connection IDs: ${server.id}`);
        }
        seenConnectionIds.add(server.id);
        if (server.tools.length === 0) continue;
        if (record.revokedConnectionIds.has(server.id)) {
          if (server.required) throw new Error(bindingUnavailableMessage(server.id, "disabled"));
          continue;
        }
        if (server.configRevision === undefined) {
          if (server.required) {
            throw new Error(`Required expert connection is not configured: ${server.id}`);
          }
          continue;
        }
        let stateAtStart;
        try {
          stateAtStart = await connectionStore.readState(server.id);
        } catch (cause) {
          if (server.required) {
            throw new Error(`Required expert connection state is unavailable: ${server.id}`, {
              cause,
            });
          }
          continue;
        }
        if (stateAtStart.status !== "active") {
          if (server.required) {
            throw new Error(bindingUnavailableMessage(server.id, stateAtStart.status));
          }
          continue;
        }
        let config;
        try {
          config = await connectionStore.readRevision(server.id, server.configRevision);
        } catch (cause) {
          if (server.required) {
            throw new Error(
              `Required expert connection revision is unavailable: ${server.id}@${server.configRevision}`,
              { cause },
            );
          }
          continue;
        }
        if (!config) {
          if (server.required) {
            throw new Error(
              `Required expert connection revision is unavailable: ${server.id}@${server.configRevision}`,
            );
          }
          continue;
        }
        let client: ConnectedExpertMcp;
        try {
          client = await connect(config);
        } catch (cause) {
          if (server.required) {
            throw new Error(bindingUnavailableMessage(server.id), { cause });
          }
          continue;
        }
        const stateAfterConnect = await connectionStore.readState(server.id).catch(() => null);
        if (
          record.closed ||
          record.revokedConnectionIds.has(server.id) ||
          stateAfterConnect?.status !== "active"
        ) {
          await client.close().catch(() => undefined);
          if (record.closed) return;
          if (server.required) {
            throw new Error(bindingUnavailableMessage(server.id, stateAfterConnect?.status));
          }
          continue;
        }

        const runtimeConnection: RuntimeConnection = {
          id: server.id,
          indexToken: Symbol(server.id),
          client,
          revokeController: new AbortController(),
          revoked: false,
        };
        record.connections.set(server.id, runtimeConnection);
        indexConnection(record.stateDir, record.sessionKey, runtimeConnection);

        const downstreamByName = new Map(client.tools.map((tool) => [tool.name, tool]));
        for (const downstreamName of server.tools) {
          const downstream = downstreamByName.get(downstreamName);
          if (!downstream) {
            if (server.required) {
              throw new Error(
                `Required expert connection ${server.id} does not expose ${downstreamName}.`,
              );
            }
            continue;
          }
          const definition = toolDefinition(server.id, downstream);
          if (exposedNames.has(definition.name)) {
            throw new Error(`Expert tool name collision: ${definition.name}`);
          }
          exposedNames.add(definition.name);
          record.tools.push({
            definition,
            requiredCapability: "thread:read",
            requiresActiveTurn: true,
            handler: (args) =>
              Effect.tryPromise({
                try: async (signal) => {
                  if (
                    record.closed ||
                    runtimeConnection.revoked ||
                    record.revokedConnectionIds.has(server.id)
                  ) {
                    throw new Error(bindingUnavailableMessage(server.id, "disabled"));
                  }
                  const currentState = await connectionStore.readState(server.id);
                  if (currentState.status !== "active") {
                    revokeConnection(record, server.id, currentState.status);
                    throw new Error(bindingUnavailableMessage(server.id, currentState.status));
                  }
                  if (
                    record.closed ||
                    runtimeConnection.revoked ||
                    record.revokedConnectionIds.has(server.id)
                  ) {
                    throw new Error(bindingUnavailableMessage(server.id, "disabled"));
                  }
                  return client
                    .callTool(
                      downstreamName,
                      args,
                      AbortSignal.any([signal, runtimeConnection.revokeController.signal]),
                    )
                    .then(callResult);
                },
                catch: (cause) => new Error(`Expert tool ${definition.name} failed.`, { cause }),
              }).pipe(
                Effect.catch((error) =>
                  Effect.succeed({
                    content: [{ type: "text" as const, text: error.message }],
                    isError: true as const,
                  }),
                ),
              ),
          });
        }
      }
    } catch (error) {
      await Promise.allSettled(
        [...record.connections.values()].map((connection) =>
          closeRuntimeConnection(
            record.stateDir,
            connection,
            new Error("Catalog creation failed."),
          ),
        ),
      );
      throw error;
    }
  };

  const makeRecord = (sessionKey: string, snapshotId: string): SessionCatalog => {
    const record: SessionCatalog = {
      sessionKey,
      snapshotId,
      stateDir: normalizedStateDir,
      revokedConnectionIds: new Set(),
      connections: new Map(),
      tools: [],
      closed: false,
    };
    record.initializing = createCatalog(record);
    void record.initializing.catch(() => {
      const bySnapshot = sessions.get(sessionKey);
      if (bySnapshot?.get(snapshotId) === record) bySnapshot.delete(snapshotId);
      if (bySnapshot?.size === 0) sessions.delete(sessionKey);
    });
    return record;
  };

  const closeOtherSnapshots = async (sessionKey: string, snapshotId: string): Promise<void> => {
    const bySnapshot = sessions.get(sessionKey);
    if (!bySnapshot) return;
    const previous = [...bySnapshot.entries()].filter(([id]) => id !== snapshotId);
    for (const [id] of previous) bySnapshot.delete(id);
    if (bySnapshot.size === 0 && sessions.get(sessionKey) === bySnapshot)
      sessions.delete(sessionKey);
    await Promise.all(previous.map(([, record]) => closeRecord(record)));
  };

  const closeSession = async (sessionKey: string): Promise<void> => {
    // Credential verification and its in-flight drain remain the authority;
    // this bounded tombstone only protects the resolver's close/resolve race.
    revokedSessionKeys.add(sessionKey);
    while (revokedSessionKeys.size > MAX_REVOKED_SESSION_KEYS) {
      const oldest = revokedSessionKeys.values().next().value as string | undefined;
      if (oldest === undefined) break;
      revokedSessionKeys.delete(oldest);
    }
    activeSnapshots.delete(sessionKey);
    const bySnapshot = sessions.get(sessionKey);
    sessions.delete(sessionKey);
    if (!bySnapshot) return;
    await Promise.all([...bySnapshot.values()].map(closeRecord));
  };

  return {
    resolve: async (sessionKey, snapshotId) => {
      if (closed || revokedSessionKeys.has(sessionKey)) return [];
      let active = activeSnapshots.get(sessionKey);
      if (!active || active.snapshotId !== snapshotId) {
        active = {
          snapshotId,
          transition: closeOtherSnapshots(sessionKey, snapshotId),
        };
        activeSnapshots.set(sessionKey, active);
      }
      const generation = active;
      await generation.transition;
      if (
        closed ||
        revokedSessionKeys.has(sessionKey) ||
        activeSnapshots.get(sessionKey) !== generation
      ) {
        return [];
      }
      let bySnapshot = sessions.get(sessionKey);
      if (!bySnapshot) {
        bySnapshot = new Map();
        sessions.set(sessionKey, bySnapshot);
      }
      let record = bySnapshot.get(snapshotId);
      if (!record) {
        record = makeRecord(sessionKey, snapshotId);
        bySnapshot.set(snapshotId, record);
      }
      await record.initializing;
      if (record.closed || closed || revokedSessionKeys.has(sessionKey)) return [];
      return record.tools;
    },
    closeSession,
    closeAll: () => {
      closeAllPromise ??= (async () => {
        closed = true;
        unsubscribeStateChanges();
        const records = [...sessions.values()].flatMap((bySnapshot) => [...bySnapshot.values()]);
        sessions.clear();
        activeSnapshots.clear();
        await Promise.all(records.map(closeRecord));
      })();
      return closeAllPromise;
    },
  };
}
