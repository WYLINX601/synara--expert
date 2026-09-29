import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { copyFile, mkdtemp, mkdir, rm, writeFile, chmod } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import readline from "node:readline";

const temp = await mkdtemp(join(tmpdir(), "synara-expert-codex-p0-"));
const children = [];
const live = process.argv.includes("--live");

async function start(name) {
  const home = join(temp, name, "home");
  const cwd = join(temp, name, "work");
  const skillRoot = join(temp, name, "skills");
  const skillPath = join(skillRoot, `expert-${name}`, "SKILL.md");
  await Promise.all([
    mkdir(home, { recursive: true }),
    mkdir(cwd, { recursive: true }),
    mkdir(join(skillRoot, `expert-${name}`), { recursive: true }),
  ]);
  await copyFile(join(homedir(), ".codex", "auth.json"), join(home, "auth.json"));
  await chmod(join(home, "auth.json"), 0o600);
  await writeFile(
    skillPath,
    `---\nname: expert-${name}\ndescription: P0 session-specific skill\n---\nWhen invoked, output SKILL_${name.toUpperCase()}.\n`,
  );

  const env = { ...process.env, CODEX_HOME: home };
  for (const key of [
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
  ])
    delete env[key];
  const child = spawn("codex", ["app-server"], { cwd, env, stdio: ["pipe", "pipe", "ignore"] });
  children.push(child);
  const pending = new Map();
  const messages = [];
  let nextId = 0;
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
      if (request) {
        pending.delete(message.id);
        if (message.error)
          request.reject(
            new Error(`${request.method}: ${String(message.error.message).slice(0, 160)}`),
          );
        else request.resolve(message.result);
      }
    } else if (message.id !== undefined && message.method) {
      child.stdin.write(
        `${JSON.stringify({ id: message.id, error: { code: -32601, message: "Probe does not approve tool requests" } })}\n`,
      );
    } else if (message.method) messages.push(message);
  });
  child.on("exit", () => {
    for (const request of pending.values())
      request.reject(new Error(`app-server exited during ${request.method}`));
    pending.clear();
  });
  const request = (method, params) =>
    new Promise((resolve, reject) => {
      const id = ++nextId;
      const timeout = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, 30_000);
      pending.set(id, {
        method,
        resolve: (value) => {
          clearTimeout(timeout);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
      });
      child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    });

  await request("initialize", {
    clientInfo: { name: "synara-expert-p0", title: "Synara Expert P0", version: "0.1.0" },
    capabilities: { experimentalApi: true },
  });
  child.stdin.write(`${JSON.stringify({ method: "initialized", params: {} })}\n`);
  await request("skills/extraRoots/set", { extraRoots: [skillRoot] });
  const listed = await request("skills/list", { cwds: [cwd], forceReload: true });
  const skills = listed?.data?.flatMap((entry) => entry.skills ?? []) ?? [];
  assert(
    skills.some((skill) => skill.name === `expert-${name}`),
    `expert-${name} not discovered`,
  );
  const opened = await request("thread/start", {
    cwd,
    developerInstructions: `For this task, prefix each final answer with PERSONA_${name.toUpperCase()}:`,
    sandbox: "read-only",
    approvalPolicy: "never",
  });
  assert(typeof opened?.thread?.id === "string");
  return { child, request, messages, home, cwd, skillPath, threadId: opened.thread.id, name };
}

async function turn(session, collaborationMode) {
  const input = [
    {
      type: "text",
      text: `$expert-${session.name} Use the skill and include its required token in your final reply.`,
    },
    { type: "skill", name: `expert-${session.name}`, path: session.skillPath },
  ];
  const result = await session.request("turn/start", {
    threadId: session.threadId,
    input,
    ...(collaborationMode ? { collaborationMode } : {}),
  });
  const turnId = result?.turn?.id;
  assert(typeof turnId === "string");
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const done = session.messages.find(
      (m) => ["turn/completed", "turn/failed"].includes(m.method) && m.params?.turn?.id === turnId,
    );
    if (done) {
      const text = session.messages
        .filter((m) => m.method === "item/completed" && m.params?.item?.type === "agentMessage")
        .map((m) => m.params.item.text ?? "")
        .join("\n");
      return {
        method: done.method,
        persona: text.includes(`PERSONA_${session.name.toUpperCase()}:`),
        skill: text.includes(`SKILL_${session.name.toUpperCase()}`),
        textPresent: text.length > 0,
      };
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("turn completion timed out");
}

try {
  const [a, b] = await Promise.all([start("a"), start("b")]);
  console.log(
    "Codex app-server: two processes independently registered their expert skill roots and started threads with developerInstructions.",
  );
  if (live) {
    const models = await b.request("model/list", {});
    const selected = models?.data?.find((model) => !model.hidden);
    const mode = selected
      ? {
          mode: "default",
          settings: {
            model: selected.id,
            reasoning_effort: selected.defaultReasoningEffort,
            developer_instructions: "Follow the user's current task.",
          },
        }
      : undefined;
    assert(mode, "No selectable model for collaboration-mode probe");
    const results = await Promise.allSettled([turn(a), turn(b, mode)]);
    for (const [index, result] of results.entries()) {
      if (result.status === "fulfilled") {
        console.log(
          JSON.stringify({
            session: index === 0 ? "a" : "b",
            ...result.value,
            collaborationModeTested: index === 1,
          }),
        );
        if (
          result.value.method !== "turn/completed" ||
          !result.value.persona ||
          !result.value.skill
        )
          process.exitCode = 1;
      } else {
        console.log(
          JSON.stringify({
            session: index === 0 ? "a" : "b",
            error: String(result.reason?.message ?? result.reason).slice(0, 180),
          }),
        );
        process.exitCode = 1;
      }
    }
  }
} finally {
  for (const child of children) child.kill("SIGTERM");
  await new Promise((resolve) => setTimeout(resolve, 500));
  for (const child of children) if (child.exitCode === null) child.kill("SIGKILL");
  await rm(temp, { recursive: true, force: true });
}
