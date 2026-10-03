import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import readline from "node:readline";
import { randomUUID } from "node:crypto";

if (!process.versions.bun) {
  throw new Error(
    "Run this probe with Bun so it can import the production Codex MCP config helper.",
  );
}

const { buildCodexMcpConfigToml, SYNARA_AGENT_GATEWAY_TOKEN_ENV, SYNARA_MCP_SERVER_NAME } =
  await import("../../apps/server/src/agentGateway/mcpInjection.ts");

const gatewayUrl = process.env.P0_GATEWAY_URL;
const gatewayToken = process.env.P0_GATEWAY_TOKEN;
const toolName = process.env.P0_GATEWAY_TOOL || "expert_probe_echo";
const marker = `P0_GATEWAY_MARKER_${randomUUID()}`;
const temp = await mkdtemp(join(tmpdir(), "synara-codex-gateway-live-"));
await chmod(temp, 0o700);
const home = join(temp, "home");
const cwd = join(temp, "work");
const children = [];
const result = {
  codexVersion: "unknown",
  model: "unknown",
  reasoningEffort: "unknown",
  gatewayConfigured: false,
  authCopiedToIsolatedHome: false,
  statusRpcMethod: "mcpServerStatus/list",
  statusRpcOutcome: "not-attempted",
  statusRpcCode: null,
  statusResponseShape: "not-observed",
  statusServerFound: false,
  gatewayStatus: "not-checked",
  statusAuthStatus: "unknown",
  statusToolCount: null,
  statusToolsErrorPresent: false,
  statusSchemaHasText: false,
  toolAvailable: false,
  mcpStartupNotices: [],
  toolApprovalRequested: false,
  toolApprovalAccepted: false,
  turnStartedInProgress: false,
  mcpToolCallObserved: false,
  mcpToolCallCompleted: false,
  gatewayReturnMarkerVerified: false,
  assistantEchoedMarker: false,
  terminal: "not-observed",
  appServerProcessExited: false,
  tempDirectoryRemoved: false,
};
let phase = "setup";

function classify(error) {
  const code = error?.rpcCode;
  if (code === -32601) return "unsupported-method";
  if (code === -32602) return "invalid-params";
  const message =
    error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  if (/auth|login|credential|unauthori[sz]ed/.test(message)) return "authentication-required";
  if (/quota|rate.limit|too many requests/.test(message)) return "quota-or-rate-limit";
  if (/timed out|timeout/.test(message)) return "timeout";
  if (/mcp server.*(failed|missing)|tool.*not available/.test(message))
    return "mcp-server-unavailable";
  return "protocol-error";
}

function isLoopbackGateway(value) {
  try {
    const url = new URL(value);
    return (
      url.protocol === "http:" &&
      ["127.0.0.1", "localhost", "[::1]", "::1"].includes(url.hostname) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    );
  } catch {
    return false;
  }
}

function childEnv(tempHome, token) {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: tempHome,
    CODEX_HOME: tempHome,
    TMPDIR: join(temp, "tmp"),
    LANG: process.env.LANG ?? "en_US.UTF-8",
    [SYNARA_AGENT_GATEWAY_TOKEN_ENV]: token,
  };
}

function toolApprovalMatches(params) {
  if (
    params?.serverName !== SYNARA_MCP_SERVER_NAME ||
    params?._meta?.codex_approval_kind !== "mcp_tool_call"
  )
    return false;
  if (params._meta.tool_name === toolName) return true;
  return (
    params.message === `Allow the ${SYNARA_MCP_SERVER_NAME} MCP server to run tool "${toolName}"?`
  );
}

async function startAppServer() {
  const child = spawn("codex", ["app-server"], {
    cwd,
    env: childEnv(home, gatewayToken),
    detached: true,
    stdio: ["pipe", "pipe", "ignore"],
  });
  children.push(child);
  const pending = new Map();
  const messages = [];
  let nextId = 0;
  const closed = new Promise((resolve) => child.once("close", resolve));
  const lines = readline.createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (message.id !== undefined && ("result" in message || "error" in message)) {
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      clearTimeout(request.timeout);
      if (message.error) {
        const error = new Error(
          `${request.method}: RPC error ${String(message.error.code ?? "unknown")}`,
        );
        error.rpcCode = message.error.code;
        request.reject(error);
      } else request.resolve(message.result);
      return;
    }
    if (message.id !== undefined && typeof message.method === "string") {
      const acceptTool =
        message.method === "mcpServer/elicitation/request" && toolApprovalMatches(message.params);
      if (message.method === "mcpServer/elicitation/request") {
        result.toolApprovalRequested = true;
        result.toolApprovalAccepted ||= acceptTool;
      }
      child.stdin.write(
        `${JSON.stringify(
          acceptTool
            ? { id: message.id, result: { action: "accept", content: null, _meta: null } }
            : message.method === "mcpServer/elicitation/request"
              ? { id: message.id, result: { action: "cancel", content: null, _meta: null } }
              : {
                  id: message.id,
                  error: { code: -32601, message: "Probe declines unrelated server requests" },
                },
        )}\n`,
      );
      return;
    }
    if (typeof message.method === "string") {
      messages.push(message);
      if (
        message.method === "mcpServer/startupStatus/updated" &&
        message.params?.name === SYNARA_MCP_SERVER_NAME &&
        result.mcpStartupNotices.length < 12
      ) {
        result.mcpStartupNotices.push({
          method: message.method,
          status: message.params.status ?? "unknown",
          failureReason: message.params.failureReason ?? null,
          errorPresent: typeof message.params.error === "string" && message.params.error.length > 0,
        });
      }
    }
  });
  child.on("close", () => {
    for (const request of pending.values()) {
      clearTimeout(request.timeout);
      request.reject(new Error(`${request.method}: app-server exited`));
    }
    pending.clear();
  });

  const request = (method, params, timeoutMs = 20_000) =>
    new Promise((resolve, reject) => {
      const id = ++nextId;
      const timeout = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, timeoutMs);
      pending.set(id, { method, resolve, reject, timeout });
      child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  const waitFor = async (predicate, timeoutMs) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const message = messages.find(predicate);
      if (message) return message;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("app-server notification timed out");
  };

  await request("initialize", {
    clientInfo: {
      name: "synara-expert-p0-gateway-client",
      title: "Synara P0 Gateway client",
      version: "0.1.0",
    },
    capabilities: { experimentalApi: true },
  });
  child.stdin.write(`${JSON.stringify({ method: "initialized", params: {} })}\n`);
  return { child, request, waitFor, messages, closed };
}

function belongsToTurn(message, turnId) {
  return message.params?.turn?.id === turnId || message.params?.turnId === turnId;
}

function terminalFor(turnId) {
  return (message) =>
    ["turn/completed", "turn/aborted", "turn/failed"].includes(message.method) &&
    belongsToTurn(message, turnId);
}

function containsMarker(value) {
  if (typeof value === "string") return value.includes(marker);
  if (Array.isArray(value)) return value.some(containsMarker);
  if (value !== null && typeof value === "object") return Object.values(value).some(containsMarker);
  return false;
}

async function inspectGatewayStatus(server, threadId) {
  try {
    const response = await server.request(
      result.statusRpcMethod,
      { threadId, detail: "full", limit: 100, cursor: null },
      2_500,
    );
    result.statusRpcOutcome = "ok";
    result.statusResponseShape = Array.isArray(response?.data) ? "data-array" : "unexpected";
    if (!Array.isArray(response?.data)) return;
    const status = response.data.find((entry) => entry?.name === SYNARA_MCP_SERVER_NAME);
    result.statusServerFound = Boolean(status);
    if (!status) return;
    result.gatewayStatus = status.runtimeStatus ?? "unavailable";
    result.statusAuthStatus = status.authStatus ?? "unknown";
    result.statusToolCount =
      status.tools && typeof status.tools === "object" ? Object.keys(status.tools).length : 0;
    result.statusToolsErrorPresent =
      typeof status.toolsError === "string" && status.toolsError.length > 0;
    const tool = status.tools?.[toolName];
    result.toolAvailable = Boolean(tool);
    result.statusSchemaHasText = Boolean(tool?.inputSchema?.properties?.text);
  } catch (error) {
    result.statusRpcOutcome = classify(error);
    result.statusRpcCode = Number.isInteger(error?.rpcCode) ? error.rpcCode : null;
    result.statusResponseShape = "no-response";
  }
}

async function stopServer(server) {
  if (server.child.exitCode !== null || server.child.signalCode !== null) return true;
  try {
    process.kill(-server.child.pid, "SIGTERM");
  } catch {
    server.child.kill("SIGTERM");
  }
  const exited = await Promise.race([
    server.closed.then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 3_000)),
  ]);
  if (exited) return true;
  try {
    process.kill(-server.child.pid, "SIGKILL");
  } catch {
    server.child.kill("SIGKILL");
  }
  return Promise.race([
    server.closed.then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 2_000)),
  ]);
}

try {
  assert.equal(typeof gatewayUrl, "string", "P0_GATEWAY_URL is required");
  assert.equal(typeof gatewayToken, "string", "P0_GATEWAY_TOKEN is required");
  assert.match(gatewayToken, /^\S+$/u, "P0_GATEWAY_TOKEN must be a non-empty bearer token");
  assert.ok(isLoopbackGateway(gatewayUrl), "P0_GATEWAY_URL must be a local HTTP loopback URL");
  assert.match(toolName, /^[a-zA-Z0-9_-]+$/u, "P0_GATEWAY_TOOL contains unsupported characters");
  result.gatewayConfigured = true;

  await Promise.all([
    mkdir(join(temp, "tmp"), { recursive: true }),
    mkdir(home, { recursive: true, mode: 0o700 }),
    mkdir(cwd, { recursive: true, mode: 0o700 }),
  ]);
  const version = spawnSync("codex", ["--version"], { encoding: "utf8", timeout: 5_000 });
  result.codexVersion = version.stdout?.match(/codex-cli\s+(\S+)/u)?.[1] ?? "unavailable";
  assert.equal(version.status, 0, "Codex CLI is not runnable");

  phase = "current-model-read";
  const sourceHome = process.env.CODEX_HOME || join(homedir(), ".codex");
  const modelReader = spawnSync(
    "python3",
    [
      "-c",
      "import json,pathlib,sys,tomllib; d=tomllib.loads(pathlib.Path(sys.argv[1]).read_text()); print(json.dumps({k:d.get(k) for k in ('model','model_reasoning_effort','model_provider')}))",
      join(sourceHome, "config.toml"),
    ],
    {
      encoding: "utf8",
      timeout: 5_000,
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: homedir(),
        LANG: process.env.LANG ?? "en_US.UTF-8",
      },
    },
  );
  assert.equal(modelReader.status, 0, "Could not read the current model selection");
  const modelConfig = JSON.parse(modelReader.stdout);
  assert.equal(typeof modelConfig.model, "string", "No explicit current model was found");
  assert.equal(
    typeof modelConfig.model_reasoning_effort,
    "string",
    "No current reasoning effort was found",
  );
  assert.equal(
    modelConfig.model_provider,
    null,
    "Custom model providers are unsupported by this isolated probe",
  );
  result.model = modelConfig.model;
  result.reasoningEffort = modelConfig.model_reasoning_effort;

  phase = "isolated-home-setup";
  const authPath = join(sourceHome, "auth.json");
  await copyFile(authPath, join(home, "auth.json"));
  await chmod(join(home, "auth.json"), 0o600);
  result.authCopiedToIsolatedHome = true;
  const managedMcpConfig = buildCodexMcpConfigToml(gatewayUrl);
  assert.ok(
    !managedMcpConfig.includes(gatewayToken),
    "Bearer token must not be written into config",
  );
  const tempConfig = [
    `model = ${JSON.stringify(result.model)}`,
    `model_reasoning_effort = ${JSON.stringify(result.reasoningEffort)}`,
    "",
    managedMcpConfig,
    "",
  ].join("\n");
  await writeFile(join(home, "config.toml"), tempConfig, { mode: 0o600 });
  const login = spawnSync("codex", ["login", "status"], {
    cwd,
    env: childEnv(home, gatewayToken),
    encoding: "utf8",
    timeout: 8_000,
  });
  assert.equal(login.status, 0, "Temporary Codex home is not authenticated");

  phase = "app-server-and-thread-start";
  const server = await startAppServer();
  const opened = await server.request("thread/start", {
    cwd,
    runtimeWorkspaceRoots: [cwd],
    model: result.model,
    sandbox: "read-only",
    approvalPolicy: "untrusted",
    approvalsReviewer: "user",
  });
  const threadId = opened?.thread?.id;
  assert.equal(typeof threadId, "string", "thread/start returned no thread id");
  assert.equal(
    opened.thread.model,
    result.model,
    "Thread did not use the current configured model",
  );

  phase = "gateway-discovery";
  await inspectGatewayStatus(server, threadId);

  phase = "live-model-tool-turn";
  const turnStart = await server.request(
    "turn/start",
    {
      threadId,
      input: [
        {
          type: "text",
          text: `Call the MCP tool mcp__${SYNARA_MCP_SERVER_NAME}__${toolName} exactly once with {"text":${JSON.stringify(marker)}}. Wait for its result, then include the exact returned marker in your final answer. Do not claim success before the tool returns.`,
        },
      ],
    },
    30_000,
  );
  const turnId = turnStart?.turn?.id;
  assert.equal(typeof turnId, "string", "turn/start returned no turn id");
  result.turnStartedInProgress = turnStart.turn.status === "inProgress";
  assert.equal(result.turnStartedInProgress, true, "turn/start did not enter inProgress");
  const terminal = await server.waitFor(terminalFor(turnId), 90_000);
  const turnEvents = server.messages.filter((message) => belongsToTurn(message, turnId));
  const startedCalls = turnEvents.filter(
    (message) =>
      message.method === "item/started" &&
      message.params?.item?.type === "mcpToolCall" &&
      message.params?.item?.server === SYNARA_MCP_SERVER_NAME &&
      message.params?.item?.tool === toolName,
  );
  const completedCalls = turnEvents.filter(
    (message) =>
      message.method === "item/completed" &&
      message.params?.item?.type === "mcpToolCall" &&
      message.params?.item?.server === SYNARA_MCP_SERVER_NAME &&
      message.params?.item?.tool === toolName,
  );
  result.mcpToolCallObserved = startedCalls.length > 0 || completedCalls.length > 0;
  result.mcpToolCallCompleted =
    completedCalls.length > 0 && completedCalls.at(-1).params.item.status === "completed";
  result.gatewayReturnMarkerVerified = completedCalls.some((message) =>
    containsMarker(message.params.item.result),
  );
  result.assistantEchoedMarker = turnEvents.some(
    (message) =>
      message.method === "item/completed" &&
      message.params?.item?.type === "agentMessage" &&
      typeof message.params.item.text === "string" &&
      message.params.item.text.includes(marker),
  );
  result.terminal = terminal.params?.turn?.status ?? terminal.method;
  assert.equal(terminal.method, "turn/completed", "Model turn did not complete successfully");
  assert.equal(result.mcpToolCallObserved, true, "No matching MCP tool-call event was observed");
  assert.equal(
    result.mcpToolCallCompleted,
    true,
    "MCP tool-call event did not complete successfully",
  );
  assert.equal(
    result.gatewayReturnMarkerVerified,
    true,
    "Gateway result did not contain the probe marker",
  );
  assert.equal(result.assistantEchoedMarker, true, "Final answer did not echo the returned marker");
  assert.equal(await stopServer(server), true, "Codex app-server did not exit");
  result.appServerProcessExited = true;
} catch (error) {
  result.failure = `${phase}:${classify(error)}`;
} finally {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        child.kill("SIGTERM");
      }
    }
  }
  const deadline = Date.now() + 3_000;
  while (
    children.some((child) => child.exitCode === null && child.signalCode === null) &&
    Date.now() < deadline
  ) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }
  }
  const killDeadline = Date.now() + 2_000;
  while (
    children.some((child) => child.exitCode === null && child.signalCode === null) &&
    Date.now() < killDeadline
  ) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  result.appServerProcessExited ||= children.every(
    (child) => child.exitCode !== null || child.signalCode !== null,
  );
  if (!result.appServerProcessExited) {
    result.failure ??= "cleanup:app-server-still-running";
  }
  try {
    await rm(temp, { recursive: true, force: true });
    result.tempDirectoryRemoved = true;
  } catch {
    result.failure ??= "cleanup:temporary-directory-removal-failed";
  }
  if (result.failure) process.exitCode = 1;
  console.log(JSON.stringify(result, null, 2));
}
