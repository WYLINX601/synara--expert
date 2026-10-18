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
  const bindingStore = createExpertMcpBindingStore(stateDir);
  const binding = await bindingStore.get(snapshot.snapshotId, async () => {
    if (snapshot.mcpBinding) return snapshot.mcpBinding;

    // Pre-MCP-1 snapshots are never edited. The first safe connection boundary
    // captures their then-current revisions once in the sidecar store.
    const servers = [];
    for (const connection of snapshot.connections) {
      if (
        connection.enabled === false ||
        (connection.toolMode !== "all" && connection.tools.length === 0)
      ) {
        continue;
      }
      const config = await connectionStore.pinRevision(connection.id);
      if (!config && connection.required) {
        throw new Error(`Required expert connection is not configured: ${connection.id}`);
      }
      servers.push({
        id: connection.id,
        ...(config ? { configRevision: config.revision } : {}),
        required: connection.required,
        ...(connection.toolMode ? { toolMode: connection.toolMode } : {}),
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
  if (snapshot.mcpBinding) {
    const snapshotShape = (value: typeof snapshot.mcpBinding) =>
      JSON.stringify({
        schemaVersion: value!.schemaVersion,
        source: value!.source,
        ...(value!.authorizationId ? { authorizationId: value!.authorizationId } : {}),
        servers: value!.servers.map((server) => ({
          id: server.id,
          ...(server.configRevision !== undefined ? { configRevision: server.configRevision } : {}),
          required: server.required,
          ...(server.toolMode ? { toolMode: server.toolMode } : {}),
          tools: server.tools,
        })),
      });
    if (snapshotShape(binding) !== snapshotShape(snapshot.mcpBinding)) {
      throw new Error("Persisted expert MCP binding does not match its immutable snapshot.");
    }
  }
  return binding;
}

function bindingUnavailableMessage(id: string, status?: string): string {
  if (status === "retired") return `Expert connection has been retired: ${id}`;
  if (status === "disabled") return `Expert connection is disabled: ${id}`;
  return `Expert connection is unavailable: ${id}`;
}

class ExpertToolAuthorizationPersistenceError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ExpertToolAuthorizationPersistenceError";
  }
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

type ToolIdentity = { readonly connectionId: string; readonly downstreamName: string };

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

function toolIdentityKey(identity: ToolIdentity): string {
  return JSON.stringify([identity.connectionId, identity.downstreamName]);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Allocate names against the complete snapshot authorization set. A currently
 * unavailable optional server still participates, so reconnecting it cannot
 * rename a tool that was already exposed by another server.
 */
function gatewayToolNames(identities: ReadonlyArray<ToolIdentity>): ReadonlyMap<string, string> {
  const unique = new Map(identities.map((identity) => [toolIdentityKey(identity), identity]));
  const legacyGroups = new Map<string, ToolIdentity[]>();
  for (const identity of unique.values()) {
    const legacyName = gatewayToolName(identity.connectionId, identity.downstreamName);
    const group = legacyGroups.get(legacyName) ?? [];
    group.push(identity);
    legacyGroups.set(legacyName, group);
  }

  const names = new Map<string, string>();
  const reserved = new Set<string>();
  for (const [legacyName, group] of legacyGroups) {
    if (group.length === 1) {
      names.set(toolIdentityKey(group[0]!), legacyName);
      reserved.add(legacyName);
    }
  }
  for (const [legacyName, group] of [...legacyGroups].toSorted(([left], [right]) =>
    compareText(left, right),
  )) {
    if (group.length === 1) continue;
    for (const identity of group.toSorted((left, right) =>
      compareText(toolIdentityKey(left), toolIdentityKey(right)),
    )) {
      const key = toolIdentityKey(identity);
      const digest = createHash("sha256").update(key).digest("hex");
      let suffixLength = 12;
      let candidate: string;
      do {
        const suffix = digest.slice(0, suffixLength);
        candidate = `${legacyName.slice(0, 127 - suffix.length)}_${suffix}`;
        if (reserved.has(candidate) && suffixLength < digest.length) {
          suffixLength = Math.min(suffixLength + 4, digest.length);
        } else if (reserved.has(candidate)) {
          // Also avoid an intentional collision with a legacy tool name.
          let ordinal = 1;
          let fallback = "";
          do {
            const fallbackSuffix = `${digest}_${ordinal++}`;
            fallback = `${legacyName.slice(0, 127 - fallbackSuffix.length)}_${fallbackSuffix}`;
          } while (reserved.has(fallback));
          candidate = fallback;
        }
      } while (reserved.has(candidate));
      reserved.add(candidate);
      names.set(key, candidate);
    }
  }
  return names;
}

function toolDefinition(
  connectionId: string,
  downstream: ConnectedExpertMcp["tools"][number],
  exposedName: string,
): McpToolDefinition {
  const annotations = downstream.annotations;
  return {
    name: exposedName,
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
  const issues: string[] = [];
  if (raw.content !== undefined && !Array.isArray(raw.content)) {
    issues.push("MCP result content is not an array.");
  }
  for (const [index, item] of (Array.isArray(raw.content) ? raw.content : []).entries()) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      issues.push(`MCP result content block ${index} is invalid.`);
      continue;
    }
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
      continue;
    }
    if (block.type === "resource") {
      const resource =
        block.resource !== null &&
        typeof block.resource === "object" &&
        !Array.isArray(block.resource)
          ? (block.resource as Record<string, unknown>)
          : undefined;
      if (resource && typeof resource.text === "string") {
        const uri = typeof resource.uri === "string" ? resource.uri : "(missing URI)";
        const mimeType =
          typeof resource.mimeType === "string" ? resource.mimeType : "(unspecified)";
        content.push({
          type: "text",
          text: `Embedded resource\nURI: ${uri}\nMIME type: ${mimeType}\n\n${resource.text}`,
        });
        if (typeof resource.uri !== "string") {
          issues.push(`MCP embedded resource block ${index} has invalid metadata.`);
        }
      } else {
        issues.push(`MCP embedded resource block ${index} is unsupported or invalid.`);
      }
      continue;
    }
    if (block.type === "resource_link") {
      const name = typeof block.name === "string" ? block.name : "(unnamed resource)";
      const description =
        typeof block.description === "string" ? block.description : "(no description)";
      const uri = typeof block.uri === "string" ? block.uri : "(missing URI)";
      content.push({
        type: "text",
        text: `Resource link\nName: ${name}\nDescription: ${description}\nURI: ${uri}`,
      });
      if (typeof block.name !== "string" || typeof block.uri !== "string") {
        issues.push(`MCP resource link block ${index} has invalid metadata.`);
      }
      continue;
    }
    issues.push(
      typeof block.type === "string"
        ? `MCP result content block ${index} has unsupported type: ${block.type}.`
        : `MCP result content block ${index} has no valid type.`,
    );
  }
  const structuredContent =
    raw.structuredContent !== null &&
    typeof raw.structuredContent === "object" &&
    !Array.isArray(raw.structuredContent)
      ? (raw.structuredContent as Record<string, unknown>)
      : undefined;
  if (issues.length > 0) {
    content.push({ type: "text", text: issues.join(" ") });
  }
  return {
    content:
      content.length > 0
        ? content
        : [
            {
              type: "text",
              text: structuredContent
                ? JSON.stringify(structuredContent, null, 2)
                : raw.isError === true
                  ? "Tool returned an error without content."
                  : "Tool completed.",
            },
          ],
    ...(typeof raw.isError === "boolean" || issues.length > 0
      ? { isError: raw.isError === true || issues.length > 0 }
      : {}),
    ...(structuredContent ? { structuredContent } : {}),
  };
}

async function inspectSnapshotConnections(
  snapshot: ExpertSnapshot,
  stateDir: string,
  connect: typeof connectExpertMcp,
): Promise<{ readonly optionalIssues: string[] }> {
  const connectionStore = createExpertConnectionStore(stateDir);
  const bindingStore = createExpertMcpBindingStore(stateDir);
  const optionalIssues: string[] = [];
  const binding = await resolveSnapshotMcpBinding(snapshot, stateDir, connectionStore);
  for (const server of binding.servers) {
    const allMode = server.toolMode === "all";
    const hasFrozenTools = allMode && server.effectiveTools !== undefined;
    const frozenTools = hasFrozenTools ? server.effectiveTools! : undefined;
    if (!allMode && server.tools.length === 0) continue;
    if (allMode && server.resolutionStatus === "unavailable") {
      const message = `可选连接“${server.id}”在本任务首次读取时不可用，未授权工具。`;
      if (server.required) throw new Error(`必需连接“${server.id}”此前无法读取。`);
      optionalIssues.push(message);
      continue;
    }
    if (allMode && server.resolutionStatus === "resolved" && frozenTools?.length === 0) continue;
    const unavailable = async (message: string) => {
      if (allMode && !hasFrozenTools && !server.required) {
        try {
          await bindingStore.resolveToolsOnce(snapshot.snapshotId, server.id, {
            status: "unavailable",
            tools: [],
          });
        } catch (cause) {
          throw new ExpertToolAuthorizationPersistenceError(
            `Could not persist the unavailable state for optional connection ${server.id}.`,
            { cause },
          );
        }
      }
      if (server.required) throw new Error(message);
      optionalIssues.push(message);
    };
    if (server.configRevision === undefined) {
      await unavailable(`连接“${server.id}”尚未配置。`);
      continue;
    }
    let state;
    try {
      state = await connectionStore.readState(server.id);
    } catch (cause) {
      await unavailable(`必需连接“${server.id}”状态不可用。`);
      if (server.required) throw new Error(`必需连接“${server.id}”状态不可用。`, { cause });
      continue;
    }
    if (state.status !== "active") {
      await unavailable(bindingUnavailableMessage(server.id, state.status));
      continue;
    }
    let config;
    try {
      config = await connectionStore.readRevision(server.id, server.configRevision);
    } catch (cause) {
      await unavailable(`必需连接“${server.id}”版本 ${server.configRevision} 不可用。`);
      if (server.required)
        throw new Error(`必需连接“${server.id}”版本 ${server.configRevision} 不可用。`, {
          cause,
        });
      continue;
    }
    if (!config) {
      await unavailable(`连接“${server.id}”版本 ${server.configRevision} 不可用。`);
      continue;
    }
    let client: ConnectedExpertMcp | undefined;
    try {
      client = await connect(config);
      state = await connectionStore.readState(server.id);
      if (state.status !== "active") {
        await unavailable(bindingUnavailableMessage(server.id, state.status));
        continue;
      }
      const names = new Set(client.tools.map((tool) => tool.name));
      let authorizedTools = server.tools;
      if (allMode) {
        if (frozenTools !== undefined) {
          authorizedTools = frozenTools;
        } else {
          let updated;
          try {
            updated = await bindingStore.resolveToolsOnce(snapshot.snapshotId, server.id, {
              status: "resolved",
              tools: client.tools.map((tool) => tool.name),
            });
          } catch (cause) {
            throw new ExpertToolAuthorizationPersistenceError(
              `Could not persist effective tools for connection ${server.id}.`,
              { cause },
            );
          }
          authorizedTools =
            updated.servers.find((entry) => entry.id === server.id)?.effectiveTools ?? [];
        }
      }
      const missing = authorizedTools.filter((name) => !names.has(name));
      if (missing.length > 0) {
        await unavailable(`连接“${server.id}”不可用，缺少工具：${missing.join("、")}。`);
      }
    } catch (cause) {
      if (cause instanceof ExpertToolAuthorizationPersistenceError) throw cause;
      if (server.required) {
        throw new Error(`必需连接“${server.id}”不可用。`, { cause });
      }
      if (allMode && !hasFrozenTools) await unavailable(`可选连接“${server.id}”当前不可用。`);
      else optionalIssues.push(`可选连接“${server.id}”当前不可用。`);
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
  const bindingStore = createExpertMcpBindingStore(options.stateDir);
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
    const authorizedByConnection = new Map(
      binding.servers.map((server) => [
        server.id,
        server.toolMode === "all" ? (server.effectiveTools ?? []) : server.tools,
      ]),
    );
    const pendingConnections: Array<{
      readonly server: (typeof binding.servers)[number];
      readonly runtimeConnection: RuntimeConnection;
      readonly authorizedTools: ReadonlyArray<string>;
    }> = [];
    const seenConnectionIds = new Set<string>();
    const freezeOptionalUnavailable = async (server: (typeof binding.servers)[number]) => {
      if (server.toolMode !== "all" || server.effectiveTools !== undefined) return;
      try {
        await bindingStore.resolveToolsOnce(snapshot.snapshotId, server.id, {
          status: "unavailable",
          tools: [],
        });
      } catch (cause) {
        throw new ExpertToolAuthorizationPersistenceError(
          `Could not persist the unavailable state for optional connection ${server.id}.`,
          { cause },
        );
      }
    };
    try {
      for (const server of binding.servers) {
        if (record.closed) return;
        if (seenConnectionIds.has(server.id)) {
          throw new Error(`Expert snapshot contains duplicate connection IDs: ${server.id}`);
        }
        seenConnectionIds.add(server.id);
        const allMode = server.toolMode === "all";
        if (allMode && server.resolutionStatus === "unavailable") {
          if (server.required) {
            throw new Error(
              `Required expert connection was unavailable during first enumeration: ${server.id}`,
            );
          }
          continue;
        }
        if (
          (!allMode && server.tools.length === 0) ||
          (allMode && server.effectiveTools !== undefined && server.effectiveTools.length === 0)
        ) {
          continue;
        }
        if (record.revokedConnectionIds.has(server.id)) {
          if (server.required) throw new Error(bindingUnavailableMessage(server.id, "disabled"));
          await freezeOptionalUnavailable(server);
          continue;
        }
        if (server.configRevision === undefined) {
          if (server.required) {
            throw new Error(`Required expert connection is not configured: ${server.id}`);
          }
          await freezeOptionalUnavailable(server);
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
          await freezeOptionalUnavailable(server);
          continue;
        }
        if (stateAtStart.status !== "active") {
          if (server.required) {
            throw new Error(bindingUnavailableMessage(server.id, stateAtStart.status));
          }
          await freezeOptionalUnavailable(server);
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
          await freezeOptionalUnavailable(server);
          continue;
        }
        if (!config) {
          if (server.required) {
            throw new Error(
              `Required expert connection revision is unavailable: ${server.id}@${server.configRevision}`,
            );
          }
          await freezeOptionalUnavailable(server);
          continue;
        }
        let client: ConnectedExpertMcp;
        try {
          client = await connect(config);
        } catch (cause) {
          if (server.required) {
            throw new Error(bindingUnavailableMessage(server.id), { cause });
          }
          await freezeOptionalUnavailable(server);
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
          await freezeOptionalUnavailable(server);
          continue;
        }

        let authorizedTools = server.tools;
        if (allMode) {
          if (server.effectiveTools !== undefined) {
            authorizedTools = server.effectiveTools;
          } else {
            let resolvedBinding;
            try {
              resolvedBinding = await bindingStore.resolveToolsOnce(
                snapshot.snapshotId,
                server.id,
                {
                  status: "resolved",
                  tools: client.tools.map((tool) => tool.name),
                },
              );
            } catch (cause) {
              await client.close().catch(() => undefined);
              throw new ExpertToolAuthorizationPersistenceError(
                `Could not persist effective tools for connection ${server.id}.`,
                { cause },
              );
            }
            const resolvedServer = resolvedBinding.servers.find((entry) => entry.id === server.id);
            if (!resolvedServer || resolvedServer.effectiveTools === undefined) {
              await client.close().catch(() => undefined);
              throw new Error(`Effective tools were not persisted for connection ${server.id}.`);
            }
            if (resolvedServer.resolutionStatus === "unavailable") {
              authorizedByConnection.set(server.id, resolvedServer.effectiveTools);
              await client.close().catch(() => undefined);
              if (server.required) {
                throw new Error(
                  `Required expert connection was unavailable during first enumeration: ${server.id}`,
                );
              }
              continue;
            }
            authorizedTools = resolvedServer.effectiveTools;
          }
        }
        authorizedByConnection.set(server.id, authorizedTools);
        if (authorizedTools.length === 0) {
          await client.close().catch(() => undefined);
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
        const stateAfterIndex = await connectionStore.readState(server.id).catch(() => null);
        if (stateAfterIndex?.status !== "active") {
          revokeConnection(record, server.id, stateAfterIndex?.status ?? "disabled");
          if (server.required) {
            throw new Error(bindingUnavailableMessage(server.id, stateAfterIndex?.status));
          }
          continue;
        }
        pendingConnections.push({ server, runtimeConnection, authorizedTools });
      }

      const toolNames = gatewayToolNames(
        [...authorizedByConnection].flatMap(([connectionId, downstreamNames]) =>
          downstreamNames.map((downstreamName) => ({ connectionId, downstreamName })),
        ),
      );
      const exposedNames = new Set<string>();
      for (const { server, runtimeConnection, authorizedTools } of pendingConnections) {
        const client = runtimeConnection.client;
        const downstreamByName = new Map(client.tools.map((tool) => [tool.name, tool]));
        for (const downstreamName of authorizedTools) {
          const downstream = downstreamByName.get(downstreamName);
          if (!downstream) {
            if (server.required) {
              throw new Error(
                `Required expert connection ${server.id} does not expose ${downstreamName}.`,
              );
            }
            continue;
          }
          const identity = { connectionId: server.id, downstreamName };
          const exposedName = toolNames.get(toolIdentityKey(identity));
          if (!exposedName) throw new Error(`Expert tool name was not allocated: ${server.id}`);
          const definition = toolDefinition(server.id, downstream, exposedName);
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
