import { performance } from "node:perf_hooks";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import type { JsonSchemaType, JsonSchemaValidator } from "@modelcontextprotocol/sdk/validation";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { ErrorCode, ListToolsResultSchema, McpError } from "@modelcontextprotocol/sdk/types.js";
import type { ExpertConnectionConfig } from "@synara/contracts";

import type { ExpertMcpCredentialStore } from "./ExpertMcpCredentials.ts";
import { resolveExpertMcpCredentialValues } from "./ExpertMcpCredentials.ts";

const CONNECTION_TIMEOUT_MS = 10_000;
const TOOL_CALL_TIMEOUT_MS = 60_000;
const MAX_TOOL_LIST_PAGES = 1_024;

type ToolOutputValidator = JsonSchemaValidator<unknown>;

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

type ExpertMcpToolListPage = Awaited<ReturnType<Client["listTools"]>>;
type ExpertMcpToolListPageRequest = (
  cursor: string | undefined,
  timeoutMs: number,
) => Promise<ExpertMcpToolListPage>;

/** Collects every tools/list page inside one startup-time budget. */
export async function collectExpertMcpTools(
  requestPage: ExpertMcpToolListPageRequest,
  startupTimeoutMs: number,
  now: () => number = performance.now.bind(performance),
): Promise<ExpertMcpToolListPage["tools"]> {
  const deadline = now() + startupTimeoutMs;
  const tools: ExpertMcpToolListPage["tools"] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  let pageCount = 0;

  while (true) {
    pageCount += 1;
    if (pageCount > MAX_TOOL_LIST_PAGES) {
      throw new Error("Expert MCP tools/list exceeded the maximum page count.");
    }
    const remainingMs = deadline - now();
    if (remainingMs <= 0) {
      throw new Error("Expert MCP tools/list exceeded its startup timeout.");
    }
    const page = await requestPage(cursor, remainingMs);
    tools.push(...page.tools);
    if (page.nextCursor === undefined) return tools;
    if (seenCursors.has(page.nextCursor)) {
      throw new Error("Expert MCP tools/list returned a repeated pagination cursor.");
    }
    seenCursors.add(page.nextCursor);
    cursor = page.nextCursor;
  }
}

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
    const tools = await collectExpertMcpTools(
      (cursor, timeoutMs) =>
        client.request(
          {
            method: "tools/list",
            ...(cursor === undefined ? {} : { params: { cursor } }),
          },
          ListToolsResultSchema,
          { timeout: timeoutMs, maxTotalTimeout: timeoutMs },
        ),
      startupTimeout,
    );
    const requiredTaskTools = new Set<string>();
    const outputValidators = new Map<string, ToolOutputValidator>();
    const jsonSchemaValidator = new AjvJsonSchemaValidator();
    for (const tool of tools) {
      if (tool.execution?.taskSupport === "required") requiredTaskTools.add(tool.name);
      if (tool.outputSchema) {
        outputValidators.set(
          tool.name,
          jsonSchemaValidator.getValidator(tool.outputSchema as JsonSchemaType),
        );
      }
    }
    const callTool: ExpertMcpClient["callTool"] = async (name, args = {}, signal) => {
      if (requiredTaskTools.has(name)) {
        throw new McpError(
          ErrorCode.InvalidRequest,
          `Tool "${name}" requires task-based execution. Use client.experimental.tasks.callToolStream() instead.`,
        );
      }
      const result = await client.callTool({ name, arguments: args }, undefined, {
        ...(signal ? { signal } : {}),
        timeout: toolTimeout,
        maxTotalTimeout: toolTimeout,
      });
      const validator = outputValidators.get(name);
      if (validator) {
        if (!result.structuredContent && !result.isError) {
          throw new McpError(
            ErrorCode.InvalidRequest,
            `Tool ${name} has an output schema but did not return structured content`,
          );
        }
        if (result.structuredContent) {
          let validation: ReturnType<ToolOutputValidator>;
          try {
            validation = validator(result.structuredContent);
          } catch (error) {
            throw new McpError(
              ErrorCode.InvalidParams,
              `Failed to validate structured content: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
          if (!validation.valid) {
            throw new McpError(
              ErrorCode.InvalidParams,
              `Structured content does not match the tool's output schema: ${validation.errorMessage}`,
            );
          }
        }
      }
      return result;
    };
    return {
      tools,
      callTool,
      close: () => client.close(),
    };
  } catch (error) {
    await transport.close().catch(() => undefined);
    throw error;
  }
}
