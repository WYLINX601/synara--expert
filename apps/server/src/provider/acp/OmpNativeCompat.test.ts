import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import * as nodeOs from "node:os";
import * as nodePath from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import { SKILL_EVOLUTION_SYSTEM_PROMPT } from "../skillEvolutionConstraints.ts";
import {
  OMP_NATIVE_COMPAT_MAX_EVENT_LINE_BYTES,
  OMP_NATIVE_COMPAT_MAX_PROMPT_BYTES,
  parseOmpNativeCompatEvent,
  prepareOmpNativeCompat,
  writeOmpNativeEvolutionPrompt,
  type OmpNativeCompatEvent,
  type OmpNativeCompatLaunch,
} from "./OmpNativeCompat.ts";

const tempDirectories: string[] = [];

async function makeTempDirectory(): Promise<string> {
  const directory = await mkdtemp(nodePath.join(nodeOs.tmpdir(), "synara-omp-native-compat-"));
  tempDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

function makeRuntime() {
  const handlers = new Map<string, Array<(event: any, ctx: any) => unknown>>();
  const lines: string[] = [];
  const exit = vi.fn((_code: number) => {});
  const processLike = { stderr: { write: (line: string) => (lines.push(line), true) }, exit };
  const pi = {
    on: vi.fn((event: string, handler: (event: any, ctx: any) => unknown) => {
      const registered = handlers.get(event) ?? [];
      registered.push(handler);
      handlers.set(event, registered);
    }),
    getActiveTools: vi.fn(() => [] as string[]),
  };
  return {
    handlers,
    lines,
    exit,
    processLike,
    pi,
    handler(event: string) {
      const handler = handlers.get(event)?.[0];
      if (!handler) throw new Error(`No handler registered for ${event}`);
      return handler;
    },
  };
}

function makeContext(
  options: {
    kind?: "main" | "sub";
    mode?: string;
    prompt?: string[];
    idle?: boolean;
  } = {},
) {
  return {
    agent: { kind: options.kind ?? "main" },
    mode: options.mode ?? "rpc",
    getSystemPrompt: () => options.prompt ?? [SKILL_EVOLUTION_SYSTEM_PROMPT],
    isIdle: () => options.idle ?? true,
  };
}

async function importExtension(launch: OmpNativeCompatLaunch) {
  return import(pathToFileURL(launch.extensionPath).href) as Promise<{
    activateOmpNativeCompat: (pi: unknown, processLike: unknown) => Promise<void> | void;
  }>;
}

describe("OMP public native compatibility bridge", () => {
  it("prepares an immutable fixed extension and emits only root ACP observations", async () => {
    const directory = await makeTempDirectory();
    const launch = await prepareOmpNativeCompat({ privateTempDirectory: directory, kind: "fixed" });
    const extensionMode = (await stat(launch.extensionPath)).mode & 0o777;
    expect(extensionMode).toBe(0o400);
    expect(launch.expectedMarker).toMatch(/^SYNARA_OMP_NATIVE_COMPAT v1 nonce=[a-f0-9]{32}$/u);
    expect(launch.sessionDir).toBeUndefined();

    const source = await readFile(launch.extensionPath, "utf8");
    expect(source).toContain('pi.on("session_start"');
    expect(source).toContain('pi.on("tool_approval_requested"');
    expect(source).toContain('pi.on("tool_execution_update"');
    expect(source).not.toContain('pi.on("input"');

    const runtime = makeRuntime();
    const extension = await importExtension(launch);
    extension.activateOmpNativeCompat(runtime.pi, runtime.processLike);
    await runtime.handler("session_start")({}, makeContext());
    await runtime.handler("session_start")({}, makeContext({ kind: "sub" }));
    await runtime.handler("tool_approval_requested")(
      { toolCallId: "approval-1", toolName: "write" },
      makeContext(),
    );
    await runtime.handler("tool_approval_requested")(
      { toolCallId: "sub-approval", toolName: "write" },
      makeContext({ kind: "sub" }),
    );

    const partialResult = {
      details: { async: { type: "task", jobId: "job-1", state: "running" } },
    };
    const taskEvent = {
      toolCallId: "task-1",
      toolName: "task",
      args: { prompt: "subtask request" },
      partialResult,
    };
    await runtime.handler("tool_execution_update")(taskEvent, makeContext({ idle: true }));
    await runtime.handler("tool_execution_update")(taskEvent, makeContext({ kind: "sub" }));
    await runtime.handler("tool_execution_update")(taskEvent, makeContext({ idle: false }));
    await runtime.handler("tool_execution_update")(
      { ...taskEvent, partialResult: { details: { async: { type: "other" } } } },
      makeContext(),
    );

    expect(runtime.lines).toHaveLength(3);
    expect(runtime.lines.every((line) => line.endsWith("\n"))).toBe(true);
    expect(runtime.lines.map((line) => parseOmpNativeCompatEvent(line, launch))).toEqual([
      { type: "ready", kind: "fixed" },
      { type: "approval", toolCallId: "approval-1", toolName: "write" },
      {
        type: "task",
        toolCallId: "task-1",
        toolName: "task",
        args: { prompt: "subtask request" },
        partialResult,
      },
    ] satisfies Array<OmpNativeCompatEvent | undefined>);
  });

  it("rejects malformed, unauthenticated, cross-kind, and oversized event lines", async () => {
    const directory = await makeTempDirectory();
    const launch = await prepareOmpNativeCompat({ privateTempDirectory: directory, kind: "fixed" });
    const valid = `${launch.expectedMarker} ${JSON.stringify({ type: "ready", kind: "fixed" })}`;

    expect(parseOmpNativeCompatEvent(valid, launch)).toEqual({ type: "ready", kind: "fixed" });
    expect(parseOmpNativeCompatEvent(`${launch.expectedMarker} not-json`, launch)).toBeUndefined();
    expect(
      parseOmpNativeCompatEvent(
        `${launch.expectedMarker.replace(/[a-f0-9]{32}$/u, "0".repeat(32))} ${JSON.stringify({ type: "ready", kind: "fixed" })}`,
        launch,
      ),
    ).toBeUndefined();
    expect(
      parseOmpNativeCompatEvent(
        `${launch.expectedMarker} ${JSON.stringify({ type: "ready", kind: "evolution" })}`,
        launch,
      ),
    ).toBeUndefined();
    expect(
      parseOmpNativeCompatEvent(
        `${launch.expectedMarker} ${"x".repeat(OMP_NATIVE_COMPAT_MAX_EVENT_LINE_BYTES)}`,
        launch,
      ),
    ).toBeUndefined();
    expect(parseOmpNativeCompatEvent(`${valid}\nsecond-line`, launch)).toBeUndefined();
  });

  it("fails closed instead of silently dropping an oversized fixed task event", async () => {
    const directory = await makeTempDirectory();
    const launch = await prepareOmpNativeCompat({ privateTempDirectory: directory, kind: "fixed" });
    const runtime = makeRuntime();
    const extension = await importExtension(launch);
    extension.activateOmpNativeCompat(runtime.pi, runtime.processLike);
    const partialResult = {
      details: { async: { type: "task", jobId: "job-1", state: "running" } },
    };

    await expect(
      runtime.handler("tool_execution_update")(
        {
          toolCallId: "task-1",
          toolName: "task",
          args: { input: "x".repeat(OMP_NATIVE_COMPAT_MAX_EVENT_LINE_BYTES) },
          partialResult,
        },
        makeContext(),
      ),
    ).rejects.toThrow(/event-too-large/u);
    expect(runtime.exit).toHaveBeenCalledExactlyOnceWith(1);
    expect(runtime.lines.map((line) => parseOmpNativeCompatEvent(line, launch))).toEqual([
      { type: "failure", reason: "event-too-large" },
    ]);
  });

  it("prepares isolated evolution constraints and atomically writes a bounded nonce-bound request", async () => {
    const directory = await makeTempDirectory();
    await expect(
      prepareOmpNativeCompat({ privateTempDirectory: directory, kind: "evolution" }),
    ).rejects.toThrow(/private session directory/u);
    const launch = await prepareOmpNativeCompat({
      privateTempDirectory: directory,
      kind: "evolution",
      sessionDir: nodePath.join(directory, "sessions"),
    });
    expect(launch.sessionDir).toBe(nodePath.join(directory, "sessions"));
    expect(launch.systemPromptPath).toBeDefined();
    expect(launch.appendSystemPromptPath).toBeDefined();
    expect(launch.configOverlayPath).toBeDefined();
    expect(launch.promptPath).toBeDefined();

    for (const path of [
      launch.extensionPath,
      launch.systemPromptPath!,
      launch.appendSystemPromptPath!,
      launch.configOverlayPath!,
    ]) {
      expect((await stat(path)).mode & 0o777).toBe(0o400);
    }
    expect(await readFile(launch.systemPromptPath!, "utf8")).toBe(SKILL_EVOLUTION_SYSTEM_PROMPT);
    expect(await readFile(launch.appendSystemPromptPath!, "utf8")).toBe("");
    expect(await readFile(launch.configOverlayPath!, "utf8")).toContain(
      "autolearn:\n  enabled: false\n  autoContinue: false\ntask:\n  maxRecursionDepth: 0\nadvisor:\n  enabled: false",
    );

    const firstPrompt = "Analyze only this explicitly submitted material.\nSecond line.";
    await writeOmpNativeEvolutionPrompt(launch, firstPrompt);
    const firstRecord = JSON.parse(await readFile(launch.promptPath!, "utf8")) as {
      version: string;
      nonce: string;
      text: string;
    };
    expect(firstRecord).toEqual({
      version: "v1",
      nonce: launch.expectedMarker.slice(launch.expectedMarker.lastIndexOf("=") + 1),
      text: firstPrompt,
    });
    expect((await stat(launch.promptPath!)).mode & 0o777).toBe(0o600);

    await writeOmpNativeEvolutionPrompt(launch, "Replacement request only.");
    const secondRecord = JSON.parse(await readFile(launch.promptPath!, "utf8")) as {
      text: string;
    };
    expect(secondRecord.text).toBe("Replacement request only.");
    await expect(
      writeOmpNativeEvolutionPrompt(launch, "x".repeat(OMP_NATIVE_COMPAT_MAX_PROMPT_BYTES + 1)),
    ).rejects.toThrow(/size limit/u);
    await expect(writeOmpNativeEvolutionPrompt({ ...launch, kind: "fixed" }, "x")).rejects.toThrow(
      /evolution launch/u,
    );
  });

  it("requires the native project block to be removed before provider dispatch", async () => {
    const directory = await makeTempDirectory();
    const launch = await prepareOmpNativeCompat({
      privateTempDirectory: directory,
      kind: "evolution",
      sessionDir: nodePath.join(directory, "sessions"),
    });
    await writeOmpNativeEvolutionPrompt(launch, "authorized text");
    const runtime = makeRuntime();
    const extension = await importExtension(launch);
    await extension.activateOmpNativeCompat(runtime.pi, runtime.processLike);
    const nativeContext = makeContext({
      prompt: [SKILL_EVOLUTION_SYSTEM_PROMPT, "<project-context>private cwd</project-context>"],
    });
    await runtime.handler("session_start")({}, nativeContext);
    expect(
      await runtime.handler("before_agent_start")(
        { prompt: "native transformed text" },
        nativeContext,
      ),
    ).toEqual({ systemPrompt: [SKILL_EVOLUTION_SYSTEM_PROMPT] });
    await expect(runtime.handler("context")({}, nativeContext)).rejects.toThrow(
      /system-prompt-mismatch/u,
    );
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });

  it("removes late SDK reminders from supported provider payloads and rejects unknown shapes", async () => {
    const directory = await makeTempDirectory();
    const launch = await prepareOmpNativeCompat({
      privateTempDirectory: directory,
      kind: "evolution",
      sessionDir: nodePath.join(directory, "sessions"),
    });
    await writeOmpNativeEvolutionPrompt(launch, "authorized text");
    const runtime = makeRuntime();
    const extension = await importExtension(launch);
    await extension.activateOmpNativeCompat(runtime.pi, runtime.processLike);
    const ctx = makeContext();
    await runtime.handler("before_agent_start")({ prompt: "transformed" }, ctx);
    const system = SKILL_EVOLUTION_SYSTEM_PROMPT;
    const cases = [
      {
        messages: [
          { role: "system", content: system },
          { role: "user", content: "late private reminder" },
        ],
      },
      {
        system: [{ type: "text", text: system }],
        messages: [{ role: "user", content: [{ type: "text", text: "late private reminder" }] }],
      },
      {
        instructions: system,
        input: [{ role: "user", content: [{ type: "input_text", text: "late private reminder" }] }],
      },
      { instructions: system, input: "late private reminder" },
      {
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: "user", parts: [{ text: "late private reminder" }] }],
      },
    ];
    for (const payload of cases) {
      const original = JSON.stringify(payload);
      const result = runtime.handler("before_provider_request")(
        { payload: { model: "unchanged", ...payload } },
        ctx,
      );
      expect(result).not.toBeInstanceOf(Promise);
      expect(result).toMatchObject({ model: "unchanged" });
      expect(JSON.stringify(result)).toContain("authorized text");
      expect(JSON.stringify(result)).not.toContain("late private reminder");
      expect(JSON.stringify(payload)).toBe(original);
    }
    for (const payload of [
      { prompt: "unknown provider shape" },
      { ...cases[0], tools: [{ type: "function", name: "read" }] },
      { ...cases[1], system: "unexpected system" },
      {
        ...cases[0],
        messages: [...cases[0]!.messages!, { role: "assistant", content: "history" }],
      },
    ]) {
      expect(() => runtime.handler("before_provider_request")({ payload }, ctx)).toThrow(
        /unsupported-provider-payload/u,
      );
    }
    await writeOmpNativeEvolutionPrompt(launch, "changed after admission");
    expect(() => runtime.handler("before_provider_request")({ payload: cases[0] }, ctx)).toThrow(
      /prompt-changed/u,
    );
  });

  it("replaces evolution history with exactly the authorized user text and vetoes tools", async () => {
    const directory = await makeTempDirectory();
    const launch = await prepareOmpNativeCompat({
      privateTempDirectory: directory,
      kind: "evolution",
      sessionDir: nodePath.join(directory, "sessions"),
    });
    const submitted = "Only explicitly provided text.\nNo ambient date or CWD.";
    await writeOmpNativeEvolutionPrompt(launch, submitted);

    const runtime = makeRuntime();
    const extension = await importExtension(launch);
    await extension.activateOmpNativeCompat(runtime.pi, runtime.processLike);
    const ctx = makeContext();
    await runtime.handler("session_start")({}, ctx);
    const before = await runtime.handler("before_agent_start")({ prompt: submitted }, ctx);
    expect(before).toEqual({ systemPrompt: [SKILL_EVOLUTION_SYSTEM_PROMPT] });

    const context = await runtime.handler("context")(
      {
        messages: [
          { role: "user", content: "ambient history" },
          { role: "assistant", content: "old" },
        ],
      },
      ctx,
    );
    expect(context).toEqual({
      messages: [{ role: "user", content: submitted, timestamp: expect.any(Number) }],
    });
    expect(runtime.lines.map((line) => parseOmpNativeCompatEvent(line, launch))).toEqual([
      { type: "ready", kind: "evolution" },
    ]);
    expect(runtime.lines.join("")).not.toContain(submitted);

    await expect(
      runtime.handler("tool_call")({ toolName: "read", toolCallId: "call-1", input: {} }, ctx),
    ).rejects.toThrow(/unauthorized-tool-call/u);
    expect(runtime.exit).toHaveBeenCalledExactlyOnceWith(1);
    expect(runtime.lines.map((line) => parseOmpNativeCompatEvent(line, launch))).toEqual([
      { type: "ready", kind: "evolution" },
      { type: "failure", reason: "unauthorized-tool-call" },
    ]);
  });

  it("fails closed when evolution constraints or the authorized prompt are missing", async () => {
    const directory = await makeTempDirectory();
    const launch = await prepareOmpNativeCompat({
      privateTempDirectory: directory,
      kind: "evolution",
      sessionDir: nodePath.join(directory, "sessions"),
    });
    const runtime = makeRuntime();
    const extension = await importExtension(launch);
    await extension.activateOmpNativeCompat(runtime.pi, runtime.processLike);

    await expect(
      runtime.handler("session_start")({}, makeContext({ prompt: ["ambient system prompt"] })),
    ).rejects.toThrow(/system-prompt-mismatch/u);
    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(runtime.lines.map((line) => parseOmpNativeCompatEvent(line, launch))).toEqual([
      { type: "failure", reason: "system-prompt-mismatch" },
    ]);

    const nextRuntime = makeRuntime();
    const nextExtension = await importExtension(launch);
    await nextExtension.activateOmpNativeCompat(nextRuntime.pi, nextRuntime.processLike);
    const ctx = makeContext();
    await nextRuntime.handler("session_start")({}, ctx);
    await expect(
      nextRuntime.handler("before_agent_start")({ prompt: "unsubmitted" }, ctx),
    ).rejects.toThrow(/authorized-prompt-unavailable/u);
    expect(nextRuntime.exit).toHaveBeenCalledWith(1);
  });

  it("keeps transformed ACP prompt text out of context and rejects tool roster changes or a second request", async () => {
    const directory = await makeTempDirectory();
    const launch = await prepareOmpNativeCompat({
      privateTempDirectory: directory,
      kind: "evolution",
      sessionDir: nodePath.join(directory, "sessions"),
    });
    await writeOmpNativeEvolutionPrompt(launch, "authorized text");

    const mismatchRuntime = makeRuntime();
    const extension = await importExtension(launch);
    await extension.activateOmpNativeCompat(mismatchRuntime.pi, mismatchRuntime.processLike);
    const mismatchContext = makeContext();
    await mismatchRuntime.handler("before_agent_start")(
      { prompt: "native date and private working directory reminder" },
      mismatchContext,
    );
    const replacement = await mismatchRuntime.handler("context")(
      {
        messages: [{ role: "user", content: "native date and private working directory reminder" }],
      },
      mismatchContext,
    );
    expect(replacement).toMatchObject({
      messages: [{ role: "user", content: "authorized text" }],
    });

    const toolsRuntime = makeRuntime();
    const toolsExtension = await importExtension(launch);
    await toolsExtension.activateOmpNativeCompat(toolsRuntime.pi, toolsRuntime.processLike);
    toolsRuntime.pi.getActiveTools.mockReturnValue(["read"]);
    await expect(toolsRuntime.handler("session_start")({}, makeContext())).rejects.toThrow(
      /active-tools-not-empty/u,
    );
    expect(toolsRuntime.lines.map((line) => parseOmpNativeCompatEvent(line, launch))).toEqual([
      { type: "failure", reason: "active-tools-not-empty" },
    ]);

    const secondRuntime = makeRuntime();
    const secondExtension = await importExtension(launch);
    await secondExtension.activateOmpNativeCompat(secondRuntime.pi, secondRuntime.processLike);
    const ctx = makeContext();
    await secondRuntime.handler("before_agent_start")({ prompt: "transformed native text" }, ctx);
    await expect(
      secondRuntime.handler("before_agent_start")({ prompt: "another transformed prompt" }, ctx),
    ).rejects.toThrow(/multiple-user-requests/u);
  });
});
