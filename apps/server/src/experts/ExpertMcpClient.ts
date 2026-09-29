import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { ExpertConnectionConfig } from "@synara/contracts";

const CONNECTION_TIMEOUT_MS = 10_000;
const TOOL_CALL_TIMEOUT_MS = 60_000;

type ExpertMcpClient = {
  readonly tools: Awaited<ReturnType<Client["listTools"]>>["tools"];
  callTool(
    name: string,
    args?: Record<string, unknown>,
    signal?: AbortSignal,
  ): ReturnType<Client["callTool"]>;
  close(): Promise<void>;
};

function referencedValue(expertId: string, name: string, envVar: string): string {
  const value = process.env[envVar];
  if (value === undefined) {
    throw new Error(
      `Expert "${expertId}" requires environment variable "${envVar}" for "${name}".`,
    );
  }
  return value;
}

export async function connectExpertMcp(config: ExpertConnectionConfig): Promise<ExpertMcpClient> {
  const { id, transport: configTransport } = config;
  const transport = (configTransport.type === "stdio"
    ? new StdioClientTransport({
        command: configTransport.command,
        args: [...configTransport.args],
        env: Object.fromEntries(
          configTransport.envFromHost.map(({ name, envVar }) => [
            name,
            referencedValue(id, name, envVar),
          ]),
        ),
      })
    : new StreamableHTTPClientTransport(new URL(configTransport.url), {
        requestInit: {
          headers: Object.fromEntries(
            configTransport.headersFromHost.map(({ name, envVar, prefix }) => [
              name,
              `${prefix ?? ""}${referencedValue(id, name, envVar)}`,
            ]),
          ),
        },
      })) as unknown as Transport;
  const client = new Client({ name: "synara-expert", version: "1.0.0" });

  try {
    await client.connect(transport, {
      timeout: CONNECTION_TIMEOUT_MS,
      maxTotalTimeout: CONNECTION_TIMEOUT_MS,
    });
    const { tools } = await client.listTools(undefined, {
      timeout: CONNECTION_TIMEOUT_MS,
      maxTotalTimeout: CONNECTION_TIMEOUT_MS,
    });
    return {
      tools,
      callTool: (name, args = {}, signal) =>
        client.callTool({ name, arguments: args }, undefined, {
          ...(signal ? { signal } : {}),
          timeout: TOOL_CALL_TIMEOUT_MS,
          maxTotalTimeout: TOOL_CALL_TIMEOUT_MS,
        }),
      close: () => client.close(),
    };
  } catch (error) {
    await transport.close().catch(() => undefined);
    throw error;
  }
}
