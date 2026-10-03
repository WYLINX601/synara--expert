import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import readline from "node:readline";

const scratch = await mkdtemp(join(tmpdir(), "synara-codex-interrupt-"));
await chmod(scratch, 0o700);
const home = join(scratch, "home");
const work = join(scratch, "work");
const result = {
  model: null,
  effort: null,
  turnStart: null,
  activeNotice: null,
  interrupt: null,
  terminal: null,
  noticeMethods: [],
  terminalStatuses: [],
  appServerExited: false,
  scratchRemoved: false,
};
let child;
let closed;
const notices = [];

try {
  await Promise.all([mkdir(home, { mode: 0o700 }), mkdir(work, { mode: 0o700 })]);
  const sourceHome = process.env.CODEX_HOME || join(homedir(), ".codex");
  const parsed = spawnSync(
    "python3",
    [
      "-c",
      "import json,pathlib,sys,tomllib; d=tomllib.loads(pathlib.Path(sys.argv[1]).read_text()); print(json.dumps({k:d.get(k) for k in ('model','model_reasoning_effort')}))",
      join(sourceHome, "config.toml"),
    ],
    { encoding: "utf8", timeout: 5_000 },
  );
  assert.equal(parsed.status, 0, "Could not read current Codex model config");
  const config = JSON.parse(parsed.stdout);
  assert.equal(typeof config.model, "string");
  assert.equal(typeof config.model_reasoning_effort, "string");
  result.model = config.model;
  result.effort = config.model_reasoning_effort;
  await writeFile(
    join(home, "config.toml"),
    `model = ${JSON.stringify(result.model)}\nmodel_reasoning_effort = ${JSON.stringify(result.effort)}\n`,
    { mode: 0o600 },
  );
  await copyFile(join(sourceHome, "auth.json"), join(home, "auth.json"));
  await chmod(join(home, "auth.json"), 0o600);

  child = spawn("codex", ["app-server"], {
    cwd: work,
    env: {
      PATH: process.env.PATH,
      HOME: home,
      CODEX_HOME: home,
      TMPDIR: scratch,
      LANG: process.env.LANG ?? "en_US.UTF-8",
    },
    stdio: ["pipe", "pipe", "ignore"],
  });
  closed = new Promise((resolve) => child.once("close", resolve));
  let id = 0;
  const pending = new Map();
  readline.createInterface({ input: child.stdout }).on("line", (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (message.id !== undefined && ("result" in message || "error" in message)) {
      const waiter = pending.get(message.id);
      if (!waiter) return;
      pending.delete(message.id);
      clearTimeout(waiter.timeout);
      if (message.error) waiter.reject(new Error(`${waiter.method}: ${message.error.message}`));
      else waiter.resolve(message.result);
    } else if (message.method) notices.push(message);
  });
  child.once("close", () => {
    for (const waiter of pending.values())
      waiter.reject(new Error(`${waiter.method}: app-server exited`));
    pending.clear();
  });
  const request = (method, params, timeoutMs = 15_000) =>
    new Promise((resolve, reject) => {
      const requestId = ++id;
      const timeout = setTimeout(() => {
        pending.delete(requestId);
        reject(new Error(`${method}: timeout`));
      }, timeoutMs);
      pending.set(requestId, { method, resolve, reject, timeout });
      child.stdin.write(`${JSON.stringify({ id: requestId, method, params })}\n`);
    });
  const terminal = (turnId) =>
    notices.find(
      (notice) =>
        ["turn/completed", "turn/aborted", "turn/failed"].includes(notice.method) &&
        (notice.params?.turn?.id === turnId || notice.params?.turnId === turnId),
    );
  const waitTerminal = async (turnId) => {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const found = terminal(turnId);
      if (found) return found;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error("Cancellation terminal not observed");
  };

  await request("initialize", {
    clientInfo: { name: "synara-expert-p0-interrupt", version: "0.1.0" },
    capabilities: { experimentalApi: true },
  });
  child.stdin.write(`${JSON.stringify({ method: "initialized", params: {} })}\n`);
  const thread = await request("thread/start", {
    cwd: work,
    sandbox: "workspace-write",
    approvalPolicy: "never",
    approvalsReviewer: "user",
  });
  assert.equal(thread.thread.model, result.model);
  const threadId = thread.thread.id;
  const started = await request("turn/start", {
    threadId,
    input: [
      {
        type: "text",
        text: "Think through a detailed 50-step plan for a fictional library catalog, then answer with a single sentence.",
      },
    ],
  });
  const turnId = started.turn.id;
  result.turnStart = started.turn.status;
  assert.equal(result.turnStart, "inProgress", "Turn was not active at start response");
  const activeDeadline = Date.now() + 20_000;
  while (Date.now() < activeDeadline) {
    const active = notices.find(
      (notice) =>
        ["turn/started", "item/started"].includes(notice.method) &&
        (notice.params?.turn?.id === turnId || notice.params?.turnId === turnId),
    );
    if (active) {
      result.activeNotice = active.method;
      break;
    }
    if (terminal(turnId)) throw new Error("Turn reached terminal before an active notification");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(result.activeNotice, "No active turn notification was observed");
  const interrupted = await request("turn/interrupt", { threadId, turnId });
  result.interrupt = interrupted === undefined ? "acknowledged" : "acknowledged with response";
  const ended = await waitTerminal(turnId);
  result.terminal =
    ended.method === "turn/aborted" ? "aborted" : (ended.params?.turn?.status ?? ended.method);
  assert.ok(
    ["interrupted", "aborted", "cancelled"].includes(result.terminal),
    `Unexpected terminal: ${result.terminal}`,
  );
} catch (error) {
  result.error = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
} finally {
  result.noticeMethods = [...new Set(notices.map((notice) => notice.method))];
  result.terminalStatuses = notices
    .filter((notice) => ["turn/completed", "turn/aborted", "turn/failed"].includes(notice.method))
    .map((notice) => notice.params?.turn?.status ?? notice.method);
  if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  if (closed)
    result.appServerExited = await Promise.race([
      closed.then(() => true),
      new Promise((resolve) => setTimeout(() => resolve(false), 3_000)),
    ]);
  if (!result.appServerExited && child) {
    child.kill("SIGKILL");
    result.appServerExited = await Promise.race([
      closed.then(() => true),
      new Promise((resolve) => setTimeout(() => resolve(false), 2_000)),
    ]);
  }
  await rm(scratch, { recursive: true, force: true });
  result.scratchRemoved = true;
  if (!result.appServerExited) process.exitCode = 1;
  console.log(JSON.stringify(result));
}
