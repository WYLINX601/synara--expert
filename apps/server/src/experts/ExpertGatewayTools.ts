import { createHash } from "node:crypto";

import type { ExpertSnapshot } from "@synara/contracts";
import { Effect } from "effect";

import type { McpToolCallResult, McpToolDefinition } from "../agentGateway/protocol.ts";
import type { ToolEntry } from "../agentGateway/toolRuntime.ts";
import { createExpertConnectionStore } from "./ExpertConnectionStore.ts";
import { connectExpertMcp } from "./ExpertMcpClient.ts";
import { createExpertStore } from "./ExpertStore.ts";

type ConnectedExpertMcp = Awaited<ReturnType<typeof connectExpertMcp>>;

type ExpertGatewayToolResolverOptions = {
  readonly stateDir: string;
  readonly connect?: typeof connectExpertMcp;
};

type SessionCatalog = {
  readonly tools: ReadonlyArray<ToolEntry>;
  readonly clients: ReadonlyArray<ConnectedExpertMcp>;
};

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

async function closeClients(clients: ReadonlyArray<ConnectedExpertMcp>): Promise<void> {
  await Promise.allSettled(clients.map((client) => client.close()));
}

async function inspectSnapshotConnections(
  snapshot: ExpertSnapshot,
  stateDir: string,
  connect: typeof connectExpertMcp,
): Promise<{ readonly optionalIssues: string[] }> {
  const connectionStore = createExpertConnectionStore(stateDir);
  const optionalIssues: string[] = [];
  for (const binding of snapshot.connections) {
    if (binding.tools.length === 0) continue;
    const config = await connectionStore.read(binding.id);
    if (!config) {
      const message = `连接“${binding.id}”未配置。`;
      if (binding.required) throw new Error(message);
      optionalIssues.push(message);
      continue;
    }
    let client: ConnectedExpertMcp | undefined;
    try {
      client = await connect(config);
      const names = new Set(client.tools.map((tool) => tool.name));
      const missing = binding.tools.filter((name) => !names.has(name));
      if (missing.length > 0) {
        const message = `连接“${binding.id}”缺少工具：${missing.join("、")}。`;
        if (binding.required) throw new Error(message);
        optionalIssues.push(message);
      }
    } catch (cause) {
      if (binding.required) {
        throw new Error(`必需连接“${binding.id}”不可用。`, { cause });
      }
      optionalIssues.push(`可选连接“${binding.id}”当前不可用。`);
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
    options.connect ?? connectExpertMcp,
  );
}

export function makeExpertGatewayToolResolver(options: ExpertGatewayToolResolverOptions): {
  readonly resolve: (sessionKey: string, snapshotId: string) => Promise<ReadonlyArray<ToolEntry>>;
  readonly closeSession: (sessionKey: string) => Promise<void>;
  readonly closeAll: () => Promise<void>;
} {
  const expertStore = createExpertStore(options.stateDir);
  const connectionStore = createExpertConnectionStore(options.stateDir);
  const connect = options.connect ?? connectExpertMcp;
  const sessions = new Map<string, Promise<SessionCatalog>>();

  const createCatalog = async (snapshotId: string): Promise<SessionCatalog> => {
    const snapshot = await expertStore.readSnapshot(snapshotId);
    const clients: ConnectedExpertMcp[] = [];
    const tools: ToolEntry[] = [];
    const exposedNames = new Set<string>();
    try {
      for (const binding of snapshot.connections) {
        if (binding.tools.length === 0) continue;
        const config = await connectionStore.read(binding.id);
        if (!config) {
          if (binding.required)
            throw new Error(`Required expert connection is not configured: ${binding.id}`);
          continue;
        }
        let client: ConnectedExpertMcp;
        try {
          client = await connect(config);
        } catch (cause) {
          if (binding.required) {
            throw new Error(`Required expert connection is unavailable: ${binding.id}`, { cause });
          }
          continue;
        }
        clients.push(client);
        const downstreamByName = new Map(client.tools.map((tool) => [tool.name, tool]));
        for (const downstreamName of binding.tools) {
          const downstream = downstreamByName.get(downstreamName);
          if (!downstream) {
            if (binding.required) {
              throw new Error(
                `Required expert connection ${binding.id} does not expose ${downstreamName}.`,
              );
            }
            continue;
          }
          const definition = toolDefinition(binding.id, downstream);
          if (exposedNames.has(definition.name)) {
            throw new Error(`Expert tool name collision: ${definition.name}`);
          }
          exposedNames.add(definition.name);
          tools.push({
            definition,
            requiredCapability: "thread:read",
            requiresActiveTurn: true,
            handler: (args) =>
              Effect.tryPromise({
                try: (signal) => client.callTool(downstreamName, args, signal).then(callResult),
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
      return { tools, clients };
    } catch (error) {
      await closeClients(clients);
      throw error;
    }
  };

  const closeSession = async (sessionKey: string): Promise<void> => {
    const pending = sessions.get(sessionKey);
    sessions.delete(sessionKey);
    if (!pending) return;
    const catalog = await pending.catch(() => null);
    if (catalog) await closeClients(catalog.clients);
  };

  return {
    resolve: async (sessionKey, snapshotId) => {
      let pending = sessions.get(sessionKey);
      if (!pending) {
        pending = createCatalog(snapshotId);
        sessions.set(sessionKey, pending);
        void pending.catch(() => {
          if (sessions.get(sessionKey) === pending) sessions.delete(sessionKey);
        });
      }
      return (await pending).tools;
    },
    closeSession,
    closeAll: async () => {
      const sessionKeys = [...sessions.keys()];
      await Promise.all(sessionKeys.map(closeSession));
    },
  };
}
