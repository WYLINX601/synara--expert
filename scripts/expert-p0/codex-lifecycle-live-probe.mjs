import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import readline from "node:readline";

const temp = await mkdtemp(join(tmpdir(), "synara-expert-codex-live-"));
await chmod(temp, 0o700);
const children = [];
const result = {
  version: "unknown",
  model: "unknown",
  reasoningEffort: "unknown",
  modelSource: "unknown",
  credentials: "unknown",
  bootstrapTurn: "not-run",
  resumedThread: "not-run",
  resumedPersona: false,
  resumedSkill: false,
  activeCommandObserved: false,
  activeCommandPid: null,
  commandApprovalRequests: 0,
  holdCommandApproved: false,
  cancellationTurnStartFields: [],
  cancellationTurnStartStatus: "unknown",
  cancellationItemTypes: [],
  cancellationItemStatuses: [],
  cancellationTurnTerminalBeforeActive: "not-observed",
  interrupt: "not-run",
  terminal: "not-observed",
  commandExitedAfterInterrupt: false,
  cleanup: "pending",
};
let phase = "setup";
const home = join(temp, "home");
const cwd = join(temp, "work");
const skillRoot = join(temp, "skills");
const skillName = "expert-resume-live";
const skillPath = join(skillRoot, skillName, "SKILL.md");
const holdPath = join(cwd, "p0-cancel-hold.py");
const holdPidPath = join(cwd, "p0-cancel-hold.pid");
const persona = "For every final answer, include the exact marker PERSONA_RESUME_LIVE.";

function classify(error) {
  const message =
    error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  if (/hold command did not become active/.test(message)) return "active-command-not-observed";
  if (/auth|login|credential|unauthori[sz]ed/.test(message)) return "authentication-required";
  if (/quota|rate.limit|too many requests/.test(message)) return "quota-or-rate-limit";
  if (/timed out/.test(message)) return "timeout";
  if (/thread.{0,24}not found|not found.{0,24}thread/.test(message)) return "thread-not-found";
  if (error?.rpcCode === -32601) return "unsupported-method";
  if (error?.rpcCode === -32602) return "invalid-params";
  return "protocol-error";
}

function envFor(tempHome) {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: tempHome,
    CODEX_HOME: tempHome,
    TMPDIR: join(temp, "tmp"),
    LANG: process.env.LANG ?? "en_US.UTF-8",
  };
}

function matchesHoldCommand(params) {
  const command = params?.command;
  const parts = Array.isArray(command)
    ? command.filter((part) => typeof part === "string")
    : [String(command ?? "")];
  const commandText = parts.join(" ").replace(/\s+/g, " ").trim();
  return (
    commandText.includes(holdPath) &&
    /\bpython3?\b/.test(commandText) &&
    !/[;|&><]/.test(commandText)
  );
}

async function startServer({ allowHoldCommand = false } = {}) {
  const child = spawn("codex", ["app-server"], {
    cwd,
    env: envFor(home),
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
        const error = new Error(`${request.method}: ${message.error.message ?? "RPC error"}`);
        error.rpcCode = message.error.code;
        request.reject(error);
      } else request.resolve(message.result);
      return;
    }
    if (message.id !== undefined && message.method) {
      const allow =
        allowHoldCommand &&
        message.method === "item/commandExecution/requestApproval" &&
        matchesHoldCommand(message.params);
      if (message.method === "item/commandExecution/requestApproval") {
        result.commandApprovalRequests += 1;
        if (allow) result.holdCommandApproved = true;
      }
      child.stdin.write(
        `${JSON.stringify(
          allow
            ? { id: message.id, result: { decision: "accept" } }
            : {
                id: message.id,
                error: { code: -32601, message: "Probe rejected an unrecognized server request" },
              },
        )}\n`,
      );
      return;
    }
    if (message.method) messages.push(message);
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
    throw new Error("notification timed out");
  };

  await request("initialize", {
    clientInfo: {
      name: "synara-expert-p0-live",
      title: "Codex lifecycle live probe",
      version: "0.1.0",
    },
    capabilities: { experimentalApi: true },
  });
  child.stdin.write(`${JSON.stringify({ method: "initialized", params: {} })}\n`);
  return { child, request, waitFor, messages, closed };
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

async function registerSkill(server) {
  await server.request("skills/extraRoots/set", { extraRoots: [skillRoot] });
  const listed = await server.request("skills/list", { cwds: [cwd], forceReload: true });
  const skills = listed?.data?.flatMap((entry) => entry.skills ?? []) ?? [];
  return skills.some((skill) => skill.name === skillName);
}

function terminalFor(turnId) {
  return (message) =>
    ["turn/completed", "turn/aborted", "turn/failed"].includes(message.method) &&
    (message.params?.turn?.id === turnId || message.params?.turnId === turnId);
}

async function runTurn(server, threadId, input, timeoutMs = 90_000) {
  const startIndex = server.messages.length;
  const opened = await server.request("turn/start", { threadId, input });
  const turnId = opened?.turn?.id;
  assert.equal(typeof turnId, "string", "turn/start returned no turn id");
  const terminal = await server.waitFor(terminalFor(turnId), timeoutMs);
  const output = server.messages
    .slice(startIndex)
    .filter(
      (message) =>
        message.method === "item/completed" && message.params?.item?.type === "agentMessage",
    )
    .map((message) => message.params.item.text ?? "")
    .join("\n");
  return { turnId, terminal, output };
}

async function holdProcessId() {
  const value = await readFile(holdPidPath, "utf8").catch(() => "");
  const pid = Number(value.trim());
  return Number.isSafeInteger(pid) && pid > 1 ? pid : undefined;
}

async function holdProcessIsAlive() {
  const pid = await holdProcessId();
  if (!pid) return false;
  const ps = spawnSync("ps", ["-p", String(pid), "-o", "command="], {
    encoding: "utf8",
    timeout: 2_000,
  });
  return ps.status === 0 && (ps.stdout ?? "").includes(holdPath);
}

async function waitForHoldProcess(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await holdProcessIsAlive()) return true;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return false;
}

async function waitForHoldExit(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await holdProcessIsAlive())) return true;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return !(await holdProcessIsAlive());
}

async function killHoldProcesses() {
  const pid = await holdProcessId();
  if (!pid || !(await holdProcessIsAlive())) return false;
  try {
    process.kill(pid, "SIGTERM");
  } catch {}
  if (!(await waitForHoldExit(1_500))) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
  return await waitForHoldExit(1_500);
}

try {
  await Promise.all([
    mkdir(join(temp, "tmp"), { recursive: true }),
    mkdir(home, { recursive: true, mode: 0o700 }),
    mkdir(cwd, { recursive: true, mode: 0o700 }),
    mkdir(join(skillRoot, skillName), { recursive: true, mode: 0o700 }),
  ]);
  const version = spawnSync("codex", ["--version"], { encoding: "utf8", timeout: 5_000 });
  result.version = version.stdout?.match(/codex-cli\s+(\S+)/)?.[1] ?? "unavailable";
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
  assert.equal(modelConfig.model_provider, null, "Custom model providers are outside this probe");
  result.model = modelConfig.model;
  result.reasoningEffort = modelConfig.model_reasoning_effort;
  result.modelSource =
    "selected model/effort fields read from current config; copied to temporary home only";
  await writeFile(
    join(home, "config.toml"),
    `model = ${JSON.stringify(result.model)}\nmodel_reasoning_effort = ${JSON.stringify(result.reasoningEffort)}\n`,
    { mode: 0o600 },
  );

  phase = "isolated-auth-copy";
  const authPath = join(sourceHome, "auth.json");
  await copyFile(authPath, join(home, "auth.json"));
  await chmod(join(home, "auth.json"), 0o600);
  const login = spawnSync("codex", ["login", "status"], {
    cwd,
    env: envFor(home),
    encoding: "utf8",
    timeout: 8_000,
  });
  assert.equal(login.status, 0, "Temporary Codex home is not authenticated");
  result.credentials = "available in isolated temporary home";

  await writeFile(
    skillPath,
    `---\nname: ${skillName}\ndescription: Add the required lifecycle skill marker to replies.\n---\nFor this task, include the exact token SKILL_RESUME_LIVE in your final answer.\n`,
  );
  await writeFile(
    holdPath,
    `import os, time\nwith open(${JSON.stringify(holdPidPath)}, "w") as f: f.write(str(os.getpid()))\ntime.sleep(90)\n`,
  );
  phase = "thread-start-and-bootstrap";
  let server = await startServer();
  assert.equal(await registerSkill(server), true, "Temporary expert skill was not discovered");
  const opened = await server.request("thread/start", {
    cwd,
    developerInstructions: persona,
    sandbox: "workspace-write",
    approvalPolicy: "never",
    approvalsReviewer: "user",
  });
  const threadId = opened?.thread?.id;
  assert.equal(typeof threadId, "string", "thread/start returned no thread id");
  assert.equal(opened.thread.model, result.model, "Thread did not use the isolated probe model");
  const bootstrap = await runTurn(server, threadId, [
    { type: "text", text: "Reply exactly THREAD_BOOTSTRAP_COMPLETE." },
  ]);
  assert.equal(bootstrap.terminal.method, "turn/completed", "Bootstrap turn did not complete");
  result.bootstrapTurn = "completed";
  assert.equal(await stopServer(server), true, "First app-server did not exit");

  phase = "thread-resume-and-live-markers";
  server = await startServer();
  assert.equal(
    await registerSkill(server),
    true,
    "Temporary expert skill was not rediscovered after restart",
  );
  const resumed = await server.request("thread/resume", {
    threadId,
    cwd,
    developerInstructions: persona,
    excludeTurns: true,
  });
  assert.equal(resumed?.thread?.id, threadId, "thread/resume returned a different thread");
  assert.equal(resumed.thread.model, result.model, "Resumed thread changed model");
  result.resumedThread = "same thread id; persona resent; skill root re-registered";
  const resumedTurn = await runTurn(server, threadId, [
    {
      type: "text",
      text: `$${skillName} Use the attached skill and follow the thread persona. Include both required markers.`,
    },
    { type: "skill", name: skillName, path: join(skillRoot, skillName) },
  ]);
  assert.equal(
    resumedTurn.terminal.method,
    "turn/completed",
    "Resumed marker turn did not complete",
  );
  result.resumedPersona = resumedTurn.output.includes("PERSONA_RESUME_LIVE");
  result.resumedSkill = resumedTurn.output.includes("SKILL_RESUME_LIVE");
  assert.equal(result.resumedPersona, true, "Resumed answer lacked the persona marker");
  assert.equal(result.resumedSkill, true, "Resumed answer lacked the skill marker");

  phase = "active-turn-interrupt";
  const cancelTurn = await server.request("turn/start", {
    threadId,
    input: [
      {
        type: "text",
        text: `Run exactly the shell command python3 ${holdPath} and wait for it to finish. Do not issue any other command. Then reply CANCELLATION_SHOULD_NOT_FINISH.`,
      },
    ],
  });
  const cancelTurnId = cancelTurn?.turn?.id;
  assert.equal(typeof cancelTurnId, "string", "Cancellation turn did not start");
  result.cancellationTurnStartFields = Object.keys(cancelTurn.turn).sort();
  result.cancellationTurnStartStatus = cancelTurn?.turn?.status ?? "status not returned";
  result.activeCommandObserved = await waitForHoldProcess(60_000);
  const cancelEvents = server.messages.filter((message) => {
    const params = message.params ?? {};
    return (
      params.turn?.id === cancelTurnId ||
      params.turnId === cancelTurnId ||
      params.item?.turnId === cancelTurnId
    );
  });
  result.cancellationItemTypes = [
    ...new Set(
      cancelEvents
        .filter((message) => message.method.startsWith("item/"))
        .map((message) => message.params?.item?.type)
        .filter((type) => typeof type === "string")
        .map((type) =>
          [
            "agentMessage",
            "commandExecution",
            "fileChange",
            "mcpToolCall",
            "webSearch",
            "reasoning",
          ].includes(type)
            ? type
            : "other",
        ),
    ),
  ];
  result.cancellationItemStatuses = [
    ...new Set(
      cancelEvents
        .filter((message) => message.method.startsWith("item/"))
        .map((message) => message.params?.item?.status ?? message.params?.status)
        .filter((status) =>
          [
            "inProgress",
            "completed",
            "failed",
            "interrupted",
            "cancelled",
            "running",
            "pending",
          ].includes(status),
        ),
    ),
  ];
  if (!result.activeCommandObserved) {
    const terminalBeforeActive = server.messages.find(terminalFor(cancelTurnId));
    if (terminalBeforeActive)
      result.cancellationTurnTerminalBeforeActive = terminalBeforeActive.method;
  }
  assert.equal(
    result.activeCommandObserved,
    true,
    "The hold command did not become active before timeout",
  );
  result.activeCommandPid = await holdProcessId();
  await server.request("turn/interrupt", { threadId, turnId: cancelTurnId }, 10_000);
  result.interrupt = "acknowledged while hold process was active";
  const terminal = await server.waitFor((message) => terminalFor(cancelTurnId)(message), 20_000);
  result.terminal =
    terminal.method === "turn/aborted"
      ? "aborted"
      : (terminal.params?.turn?.status ?? terminal.method);
  assert.ok(
    ["aborted", "interrupted", "cancelled"].includes(result.terminal),
    "Interrupt did not produce a cancelled terminal state",
  );
  result.commandExitedAfterInterrupt = await waitForHoldExit(10_000);
  const appServerExited = await stopServer(server);
  const commandExitedAfterServerStop = await waitForHoldExit(3_000);
  assert.equal(appServerExited, true, "Resumed app-server did not exit");
  result.cleanup = commandExitedAfterServerStop
    ? "app-server and hold process exited"
    : "hold process needed forced cleanup";
  if (!result.commandExitedAfterInterrupt)
    result.failure = "active-turn-interrupt:hold-process-survived-interrupt";
} catch (error) {
  result.failure = `${phase}:${classify(error)}`;
} finally {
  result.holdProcessForcedCleanup = await killHoldProcesses();
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        child.kill("SIGTERM");
      }
    }
  }
  const waitForChildren = async (timeoutMs) =>
    Promise.race([
      Promise.all(
        children.map(
          (child) =>
            new Promise((resolve) => {
              if (child.exitCode !== null || child.signalCode !== null) return resolve(true);
              child.once("close", () => resolve(true));
            }),
        ),
      ),
      new Promise((resolve) => setTimeout(() => resolve(false), timeoutMs)),
    ]);
  let allExited = await waitForChildren(2_000);
  for (const child of children) {
    if (!allExited && child.exitCode === null && child.signalCode === null) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }
  }
  if (!allExited) allExited = await waitForChildren(2_000);
  if (!allExited) {
    result.cleanup = "unconfirmed";
    result.failure ??= "cleanup:unconfirmed";
  } else if (result.cleanup === "pending") {
    result.cleanup =
      result.activeCommandPid === null
        ? "app-server processes exited; no hold PID was observed"
        : "app-server processes exited";
  }
  result.appServerProcesses = children.map((child) => ({
    pid: child.pid,
    exited: child.exitCode !== null || child.signalCode !== null,
    exitCode: child.exitCode,
    signal: child.signalCode,
  }));
  if (result.holdProcessForcedCleanup === false && (await holdProcessIsAlive())) {
    result.cleanup = "unconfirmed";
    result.failure ??= "cleanup:hold-process-still-alive";
  }
  await rm(temp, { recursive: true, force: true });
  result.tempDirectoryRemoved = true;
  if (result.failure) process.exitCode = 1;
  console.log(JSON.stringify(result, null, 2));
}
