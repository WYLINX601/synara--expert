import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import readline from "node:readline";

const temp = await mkdtemp(join(tmpdir(), "synara-expert-codex-lifecycle-"));
await chmod(temp, 0o700);
const children = [];
let phase = "setup";
const result = {
  codexVersion: "unknown",
  isolatedCredentialStatus: "unknown",
  start: "not-run",
  preResumeTurn: "not-run",
  preResumeCancellation: "unverified",
  resume: "not-run",
  skillRediscoveredAfterResume: false,
  turnStart: "not-run",
  cancellation: "unverified",
  cleanup: "pending",
};

function classifyError(error) {
  const message =
    error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  if (/thread.{0,24}not found|not found.{0,24}thread/.test(message)) return "thread-not-found";
  if (/auth|login|credential|unauthori[sz]ed/.test(message)) return "authentication-required";
  if (/quota|rate.limit|too many requests/.test(message)) return "quota-or-rate-limit";
  if (/sqlite|database|state store/.test(message)) return "state-store-error";
  if (/no active turn|turn.{0,24}already (?:completed|finished)|not active/.test(message))
    return "turn-already-terminal";
  if (error?.rpcCode === -32601) return "unsupported-method";
  if (error?.rpcCode === -32602) return "invalid-params";
  if (error?.rpcCode === -32600 && /turn\/interrupt/.test(message))
    return "interrupt-rejected-no-active-turn";
  if (error?.rpcCode === -32600) return "invalid-request";
  if (/invalid|unknown field|unsupported/.test(message)) return "invalid-or-unsupported-parameter";
  if (/already active|in use|locked/.test(message)) return "thread-busy";
  if (/timed out/.test(message)) return "timeout";
  return "protocol-error";
}

function isolatedEnv(home, tempDir) {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: home,
    CODEX_HOME: home,
    TMPDIR: tempDir,
    LANG: process.env.LANG ?? "en_US.UTF-8",
  };
}

async function startAppServer(home, cwd) {
  const child = spawn("codex", ["app-server"], {
    cwd,
    env: isolatedEnv(home, join(temp, "tmp")),
    detached: true,
    stdio: ["pipe", "pipe", "ignore"],
  });
  children.push(child);
  const pending = new Map();
  const events = [];
  const waiters = new Set();
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
      child.stdin.write(
        `${JSON.stringify({ id: message.id, error: { code: -32601, message: "Probe does not approve tool requests" } })}\n`,
      );
      return;
    }
    if (!message.method) return;
    events.push(message);
    for (const waiter of waiters) {
      if (waiter.predicate(message)) {
        waiters.delete(waiter);
        clearTimeout(waiter.timeout);
        waiter.resolve(message);
      }
    }
  });

  child.on("close", () => {
    for (const request of pending.values()) {
      clearTimeout(request.timeout);
      request.reject(new Error(`${request.method}: app-server exited`));
    }
    pending.clear();
    for (const waiter of waiters) {
      clearTimeout(waiter.timeout);
      waiter.reject(new Error("app-server exited"));
    }
    waiters.clear();
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

  const waitFor = (predicate, timeoutMs) => {
    const existing = events.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve, reject, timeout: undefined };
      waiter.timeout = setTimeout(() => {
        waiters.delete(waiter);
        reject(new Error("notification timed out"));
      }, timeoutMs);
      waiters.add(waiter);
    });
  };

  await request("initialize", {
    clientInfo: {
      name: "synara-expert-codex-lifecycle",
      title: "Codex lifecycle probe",
      version: "0.1.0",
    },
    capabilities: { experimentalApi: true },
  });
  child.stdin.write(`${JSON.stringify({ method: "initialized", params: {} })}\n`);
  return { child, request, waitFor, findEvent: (predicate) => events.find(predicate), closed };
}

async function stopAppServer(server) {
  if (server.child.exitCode !== null || server.child.signalCode !== null) return true;
  try {
    process.kill(-server.child.pid, "SIGTERM");
  } catch {
    server.child.kill("SIGTERM");
  }
  const exited = await Promise.race([
    server.closed.then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 2_000)),
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

async function registerSkill(server, cwd, skillRoot, name) {
  await server.request("skills/extraRoots/set", { extraRoots: [skillRoot] });
  const listed = await server.request("skills/list", { cwds: [cwd], forceReload: true });
  const skills = listed?.data?.flatMap((entry) => entry.skills ?? []) ?? [];
  return skills.some((skill) => skill.name === name);
}

async function startAndInterruptSkillTurn(server, threadId, skillName, skillRoot) {
  let turnId;
  try {
    const response = await server.request(
      "turn/start",
      {
        threadId,
        input: [
          {
            type: "text",
            text: "Return the persona marker and invoke the explicitly provided skill.",
          },
          { type: "skill", name: skillName, path: join(skillRoot, skillName) },
        ],
      },
      15_000,
    );
    turnId = response?.turn?.id;
    if (typeof turnId !== "string") return { start: "missing-turn-id", cancellation: "unverified" };
  } catch (error) {
    return { start: classifyError(error), cancellation: "unverified; no active turn was created" };
  }

  const terminalPredicate = (message) =>
    ["turn/completed", "turn/aborted", "turn/failed"].includes(message.method) &&
    message.params?.turn?.id === turnId;
  const earlyTerminal = server.findEvent(terminalPredicate);
  if (earlyTerminal) {
    return {
      start: "accepted",
      cancellation: `unverified; turn-${earlyTerminal.params?.turn?.status ?? "terminal"}-arrived-before-interrupt`,
    };
  }

  let cancellation = "unverified";
  let cancellationRpcCode;
  try {
    await server.request("turn/interrupt", { threadId, turnId }, 10_000);
    const terminal = await server.waitFor(terminalPredicate, 15_000);
    cancellation =
      terminal.method === "turn/aborted" ||
      ["interrupted", "cancelled"].includes(terminal.params?.turn?.status)
        ? "passed"
        : `terminal-${terminal.params?.turn?.status ?? "unknown"}`;
  } catch (error) {
    cancellation = classifyError(error);
    cancellationRpcCode = error?.rpcCode;
    const terminal = server.findEvent(terminalPredicate);
    if (terminal)
      cancellation = `unverified; turn-${terminal.params?.turn?.status ?? "terminal"}-arrived-before-confirmed-interrupt`;
  }
  return {
    start: "accepted",
    cancellation,
    ...(Number.isInteger(cancellationRpcCode) ? { cancellationRpcCode } : {}),
  };
}

try {
  await Promise.all([
    mkdir(join(temp, "tmp"), { recursive: true }),
    mkdir(join(temp, "home"), { recursive: true }),
    mkdir(join(temp, "work"), { recursive: true }),
    mkdir(join(temp, "skills", "expert-resume"), { recursive: true }),
  ]);
  const home = join(temp, "home");
  const cwd = join(temp, "work");
  const skillRoot = join(temp, "skills");
  const skillName = "expert-resume";
  await writeFile(
    join(skillRoot, skillName, "SKILL.md"),
    `---\nname: ${skillName}\ndescription: isolated lifecycle probe skill\n---\nOutput SKILL_RESUME_MARKER when invoked.\n`,
  );

  phase = "cli-version";
  const version = spawnSync("codex", ["--version"], { encoding: "utf8", timeout: 5_000 });
  result.codexVersion = version.stdout?.match(/codex-cli\s+(\S+)/)?.[1] ?? "unavailable";
  assert.equal(version.status, 0, "Codex CLI is not runnable");

  // Check only whether this empty temporary home can see credentials; discard all output.
  phase = "isolated-auth-status";
  const auth = spawnSync("codex", ["login", "status"], {
    cwd,
    env: isolatedEnv(home, join(temp, "tmp")),
    encoding: "utf8",
    timeout: 8_000,
  });
  result.isolatedCredentialStatus =
    auth.status === 0 ? "available; model call skipped" : "unavailable";
  await access(join(home, "auth.json")).then(
    () => assert.fail("Unexpected credential file in the isolated home"),
    () => undefined,
  );

  phase = "thread-start";
  let server = await startAppServer(home, cwd);
  assert.equal(await registerSkill(server, cwd, skillRoot, skillName), true);
  const started = await server.request("thread/start", {
    cwd,
    developerInstructions: "For every final answer, prefix PERSONA_RESUME_MARKER.",
    sandbox: "read-only",
    approvalPolicy: "never",
  });
  const threadId = started?.thread?.id;
  assert.equal(typeof threadId, "string");
  result.start = "passed";
  if (result.isolatedCredentialStatus === "unavailable") {
    phase = "pre-resume-turn";
    const preResume = await startAndInterruptSkillTurn(server, threadId, skillName, skillRoot);
    result.preResumeTurn = preResume.start;
    result.preResumeCancellation = preResume.cancellation;
  }
  assert.equal(await stopAppServer(server), true, "initial app-server did not exit");

  phase = "thread-resume";
  server = await startAppServer(home, cwd);
  result.skillRediscoveredAfterResume = await registerSkill(server, cwd, skillRoot, skillName);
  assert.equal(result.skillRediscoveredAfterResume, true);
  const resumed = await server.request("thread/resume", {
    threadId,
    cwd,
    developerInstructions: "For every final answer, prefix PERSONA_RESUME_MARKER.",
    excludeTurns: true,
  });
  assert.equal(resumed?.thread?.id, threadId);
  result.resume =
    "protocol-passed; same thread id, developerInstructions resent, skill root rediscovered";

  if (result.isolatedCredentialStatus === "unavailable") {
    phase = "turn-start-and-cancel";
    const turnResult = await startAndInterruptSkillTurn(server, threadId, skillName, skillRoot);
    result.turnStart = turnResult.start;
    result.cancellation = turnResult.cancellation;
    if (Number.isInteger(turnResult.cancellationRpcCode))
      result.cancellationRpcCode = turnResult.cancellationRpcCode;
  }

  assert.equal(await stopAppServer(server), true, "resumed app-server did not exit");
  result.cleanup = "app-server children exited";
} catch (error) {
  result.failure = `${phase}:${classifyError(error)}`;
  if (Number.isInteger(error?.rpcCode)) result.failureRpcCode = error.rpcCode;
  if (error instanceof assert.AssertionError) result.failure = `${phase}:assertion-failed`;
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
  const waitForChildren = (timeoutMs) =>
    Promise.race([
      Promise.all(
        children.map(
          (child) =>
            new Promise((resolve) => {
              if (child.exitCode !== null || child.signalCode !== null) return resolve(true);
              child.once("close", () => resolve(true));
            }),
        ),
      ).then(() => true),
      new Promise((resolve) => setTimeout(() => resolve(false), timeoutMs)),
    ]);
  if (!(await waitForChildren(1_000))) {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      }
    }
  }
  if (!(await waitForChildren(1_000))) {
    result.cleanup = "unconfirmed";
    result.failure ??= "cleanup:app-server-still-running";
  } else if (result.cleanup === "pending") {
    result.cleanup = "app-server children exited during cleanup";
  }
  await rm(temp, { recursive: true, force: true });
  result.tempDirectoryRemoved = true;
  const badProtocolResult =
    [
      "protocol-error",
      "invalid-request",
      "invalid-params",
      "unsupported-method",
      "timeout",
      "missing-turn-id",
    ].includes(result.turnStart) ||
    [
      "protocol-error",
      "invalid-request",
      "invalid-params",
      "unsupported-method",
      "timeout",
    ].includes(result.cancellation);
  if (
    result.failure ||
    result.start !== "passed" ||
    !result.resume.startsWith("protocol-passed;") ||
    !result.skillRediscoveredAfterResume ||
    result.cleanup === "unconfirmed" ||
    badProtocolResult
  )
    process.exitCode = 1;
  console.log(JSON.stringify(result, null, 2));
}
