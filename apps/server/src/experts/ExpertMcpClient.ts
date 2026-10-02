import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { ExpertConnectionConfig } from "@synara/contracts";

const CONNECTION_TIMEOUT_MS = 10_000;
const TOOL_CALL_TIMEOUT_MS = 60_000;

type HttpSendParameters = Parameters<typeof StreamableHTTPClientTransport.prototype.send>;

function includesCancellationNotification(message: HttpSendParameters[0]): boolean {
  const messages = Array.isArray(message) ? message : [message];
  let hasCancellation = false;
  const notificationsOnly =
    messages.length > 0 &&
    messages.every((candidate) => {
      if (
        typeof candidate !== "object" ||
        candidate === null ||
        !("method" in candidate) ||
        "id" in candidate
      ) {
        return false;
      }
      if (candidate.method === "notifications/cancelled") hasCancellation = true;
      return true;
    });
  return notificationsOnly && hasCancellation;
}

/**
 * The SDK's request abort path sends `notifications/cancelled` without waiting
 * for its HTTP POST. Drain those POSTs before close aborts the shared fetch
 * signal, while keeping tool-call POSTs outside this wait.
 */
class CancellationDrainingHttpTransport extends StreamableHTTPClientTransport {
  readonly #pendingCancellationSends = new Set<Promise<void>>();
  #closeRequested = false;
  #transportCloseStarted = false;
  #closePromise: Promise<void> | undefined;

  override send(message: HttpSendParameters[0], options?: HttpSendParameters[1]): Promise<void> {
    const cancellation = includesCancellationNotification(message);
    if (this.#transportCloseStarted || (this.#closeRequested && !cancellation)) {
      return Promise.reject(new Error("Expert MCP HTTP transport is closing."));
    }

    const sending = super.send(message, options);
    if (cancellation) {
      let tracked: Promise<void>;
      tracked = sending
        .then(
          () => undefined,
          () => undefined,
        )
        .finally(() => this.#pendingCancellationSends.delete(tracked));
      this.#pendingCancellationSends.add(tracked);
    }
    return sending;
  }

  override close(): Promise<void> {
    if (!this.#closePromise) {
      this.#closeRequested = true;
      this.#closePromise = Promise.resolve().then(() => this.#drainThenClose());
    }
    return this.#closePromise;
  }

  async #drainThenClose(): Promise<void> {
    const deadline = Date.now() + CONNECTION_TIMEOUT_MS;
    try {
      while (this.#pendingCancellationSends.size > 0) {
        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0) break;

        let timeout: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            Promise.all([...this.#pendingCancellationSends]),
            new Promise<void>((resolve) => {
              timeout = setTimeout(resolve, remainingMs);
            }),
          ]);
        } finally {
          if (timeout !== undefined) clearTimeout(timeout);
        }
      }
    } finally {
      // A stalled notification must not prevent local transport cleanup.
      this.#transportCloseStarted = true;
      await super.close();
    }
  }
}

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
    : new CancellationDrainingHttpTransport(new URL(configTransport.url), {
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
