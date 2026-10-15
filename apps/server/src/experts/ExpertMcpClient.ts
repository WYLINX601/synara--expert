import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { ExpertConnectionConfig } from "@synara/contracts";

import type { ExpertMcpCredentialStore } from "./ExpertMcpCredentials.ts";
import { resolveExpertMcpCredentialValues } from "./ExpertMcpCredentials.ts";

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

export async function connectExpertMcp(
  config: ExpertConnectionConfig,
  options: { readonly credentials?: Pick<ExpertMcpCredentialStore, "read"> } = {},
): Promise<ExpertMcpClient> {
  const configTransport = config.transport;
  const credentialValues = await resolveExpertMcpCredentialValues(
    configTransport,
    options.credentials,
  );
  let transport: Transport;
  let startupTimeout = CONNECTION_TIMEOUT_MS;
  let toolTimeout = TOOL_CALL_TIMEOUT_MS;

  if (configTransport.type === "stdio") {
    startupTimeout = configTransport.startupTimeoutMs ?? CONNECTION_TIMEOUT_MS;
    toolTimeout = configTransport.toolTimeoutMs ?? TOOL_CALL_TIMEOUT_MS;
    transport = new StdioClientTransport({
      command: configTransport.command,
      args: [...configTransport.args],
      ...(configTransport.cwd === undefined ? {} : { cwd: configTransport.cwd }),
      env: { ...credentialValues.env },
    }) as unknown as Transport;
  } else {
    transport = new CancellationDrainingHttpTransport(new URL(configTransport.url), {
      requestInit: {
        headers: { ...credentialValues.headers },
      },
    }) as unknown as Transport;
  }

  const client = new Client({ name: "synara-expert", version: "1.0.0" });

  try {
    await client.connect(transport, {
      timeout: startupTimeout,
      maxTotalTimeout: startupTimeout,
    });
    const { tools } = await client.listTools(undefined, {
      timeout: startupTimeout,
      maxTotalTimeout: startupTimeout,
    });
    return {
      tools,
      callTool: (name, args = {}, signal) =>
        client.callTool({ name, arguments: args }, undefined, {
          ...(signal ? { signal } : {}),
          timeout: toolTimeout,
          maxTotalTimeout: toolTimeout,
        }),
      close: () => client.close(),
    };
  } catch (error) {
    await transport.close().catch(() => undefined);
    throw error;
  }
}
