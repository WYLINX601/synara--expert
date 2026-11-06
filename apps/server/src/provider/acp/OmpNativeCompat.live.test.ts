// FILE: OmpNativeCompat.live.test.ts
// Purpose: Exercises the public native bridge against an explicitly selected local OMP CLI.
// Layer: Provider ACP live compatibility checks

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { FIXED_EXPERT_SKILL_POLICY, type ProviderExpertSession } from "@synara/contracts";
import { Effect } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import { describe, expect, it } from "vitest";

import { createSkillPackageStore } from "../../experts/SkillPackageStore.ts";
import { providerCredentialKeysFor } from "../../providerChildEnvironment.ts";
import { flattenConfigOptions } from "./AcpConfigOptions.ts";
import { buildOmpProcessEnv, makeOmpAcpRuntime, runOmpAcpCliCommand } from "./OmpAcpSupport.ts";
import {
  parseOmpNativeCompatEvent,
  prepareOmpNativeCompat,
  writeOmpNativeEvolutionPrompt,
  type OmpNativeCompatEvent,
  type OmpNativeCompatKind,
  type OmpNativeCompatLaunch,
} from "./OmpNativeCompat.ts";
import { prepareOmpExpertSession, type OmpExpertSessionPreparation } from "./OmpExpertSession.ts";

const liveOmpBinaryPath = process.env.SYNARA_TEST_REAL_OMP_BINARY?.trim();
const syntheticModel = "synthetic-local/synara-omp-live-probe";
const syntheticWireModelId = "synara-omp-live-probe";
const syntheticApiKey = "synthetic-only-no-real-credentials";
const userPrompt =
  "Use only this synthetic request. Return the exact word SYNTHETIC_ACK and do not call tools.";
const contextSentinels = [
  "SYNARA_LIVE_OMP_CONTEXT_SENTINEL",
  "SYNARA_LIVE_OMP_SKILL_SENTINEL",
  "SYNARA_LIVE_OMP_APPEND_SENTINEL",
];

interface LiveSandbox {
  readonly root: string;
  readonly home: string;
  readonly agentDir: string;
  readonly cwd: string;
  readonly bridgeDir: string;
  readonly sessionsDir: string;
  readonly environment: Readonly<Record<string, string>>;
}

interface CapturedProviderRequest {
  readonly method: string;
  readonly url: string;
  readonly authorization: string | undefined;
  readonly payload: unknown;
}

interface FakeOpenAiEndpoint {
  readonly baseUrl: string;
  readonly requests: Array<CapturedProviderRequest>;
  readonly unexpectedRequests: Array<string>;
  readonly close: () => Promise<void>;
}

async function makeSandbox(): Promise<LiveSandbox> {
  const root = await mkdtemp(path.join(tmpdir(), "synara-omp-native-live-"));
  await chmod(root, 0o700);
  const home = path.join(root, "home");
  const agentDir = path.join(root, "agent");
  const cwd = path.join(root, "cwd");
  const bridgeDir = path.join(root, "bridge");
  const sessionsDir = path.join(root, "sessions");
  await Promise.all(
    [home, agentDir, cwd, bridgeDir, sessionsDir].map((directory) =>
      mkdir(directory, { recursive: true, mode: 0o700 }),
    ),
  );
  return {
    root,
    home,
    agentDir,
    cwd,
    bridgeDir,
    sessionsDir,
    environment: {
      HOME: home,
      USERPROFILE: home,
      TMPDIR: root,
      TEMP: root,
      TMP: root,
      PI_CODING_AGENT_DIR: agentDir,
    },
  };
}

async function makeTreeWritable(target: string): Promise<void> {
  const info = await lstat(target).catch(() => undefined);
  if (!info || info.isSymbolicLink()) return;
  if (info.isDirectory()) {
    await chmod(target, 0o700);
    for (const name of await readdir(target)) await makeTreeWritable(path.join(target, name));
    return;
  }
  if (info.isFile()) await chmod(target, 0o600);
}

async function writeSyntheticModels(sandbox: LiveSandbox, baseUrl: string): Promise<void> {
  const models = {
    providers: {
      "synthetic-local": {
        baseUrl,
        api: "openai-completions",
        apiKey: syntheticApiKey,
        models: [
          {
            id: "synara-omp-live-probe",
            name: "Synara OMP Live Probe (local test double)",
            contextWindow: 32_768,
            maxTokens: 256,
            input: ["text"],
            reasoning: false,
          },
        ],
      },
    },
  };
  const modelsPath = path.join(sandbox.agentDir, "models.json");
  await writeFile(modelsPath, JSON.stringify(models, null, 2), { mode: 0o600 });
  await chmod(modelsPath, 0o600);
}

function readRequestBody(request: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Array<Buffer> = [];
    request.on("data", (chunk: Buffer | Uint8Array | string) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    request.once("error", reject);
    request.once("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown);
      } catch (cause) {
        reject(cause);
      }
    });
  });
}

function sendSyntheticCompletion(
  response: ServerResponse,
  model: string,
  streaming: boolean,
): void {
  const completion = "SYNTHETIC_ACK";
  if (streaming) {
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    const base = {
      id: "chatcmpl-synara-local-test-double",
      object: "chat.completion.chunk",
      created: 1,
      model,
    };
    response.write(
      `data: ${JSON.stringify({
        ...base,
        choices: [
          { index: 0, delta: { role: "assistant", content: completion }, finish_reason: null },
        ],
      })}\n\n`,
    );
    response.write(
      `data: ${JSON.stringify({
        ...base,
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      })}\n\n`,
    );
    response.end("data: [DONE]\n\n");
    return;
  }
  response.writeHead(200, { "content-type": "application/json" });
  response.end(
    JSON.stringify({
      id: "chatcmpl-synara-local-test-double",
      object: "chat.completion",
      created: 1,
      model,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: completion },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }),
  );
}

async function startFakeOpenAiEndpoint(): Promise<FakeOpenAiEndpoint> {
  const requests: Array<CapturedProviderRequest> = [];
  const unexpectedRequests: Array<string> = [];
  const server: Server = createServer((request, response) => {
    void readRequestBody(request)
      .then((payload) => {
        const url = request.url ?? "";
        if (request.method !== "POST" || !url.endsWith("/chat/completions")) {
          unexpectedRequests.push(`${request.method ?? "unknown"} ${url}`);
          response.writeHead(404);
          response.end();
          return;
        }
        requests.push({
          method: request.method,
          url,
          authorization: request.headers.authorization,
          payload,
        });
        const requestBody =
          typeof payload === "object" && payload !== null
            ? (payload as { stream?: unknown; model?: unknown })
            : {};
        const selectedModel =
          typeof requestBody.model === "string"
            ? requestBody.model
            : "synthetic-local/synara-omp-live-probe";
        sendSyntheticCompletion(response, selectedModel, requestBody.stream === true);
      })
      .catch(() => {
        unexpectedRequests.push(`${request.method ?? "unknown"} ${request.url ?? ""} invalid-json`);
        response.writeHead(400);
        response.end();
      });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new Error("The synthetic OMP model endpoint did not bind to a TCP port.");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
    unexpectedRequests,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

function buildOmpSettings(sandbox: LiveSandbox) {
  return {
    ...(liveOmpBinaryPath ? { binaryPath: liveOmpBinaryPath } : {}),
    agentDir: sandbox.agentDir,
    homeDir: sandbox.home,
    isolationRootDir: sandbox.root,
    environment: sandbox.environment,
  } as const;
}

async function waitForReadyEvent(
  events: ReadonlyArray<OmpNativeCompatEvent>,
  kind: OmpNativeCompatKind,
): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const failure = events.find((event) => event.type === "failure");
    if (failure?.type === "failure") {
      throw new Error(`OMP native extension failed closed: ${failure.reason}`);
    }
    if (events.some((event) => event.type === "ready" && event.kind === kind)) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`OMP ${kind} native extension did not emit its authenticated ready event.`);
}

function textContent(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return undefined;
  const pieces = value.flatMap((part) => {
    if (typeof part === "object" && part !== null && "text" in part) {
      return typeof (part as { text: unknown }).text === "string"
        ? [(part as { text: string }).text]
        : [];
    }
    return [];
  });
  return pieces.length ? pieces.join("") : undefined;
}

async function runNativeSession(input: {
  readonly sandbox: LiveSandbox;
  readonly launch: OmpNativeCompatLaunch;
  readonly expertSessionSpawn?: {
    readonly configOverlayPath?: string;
    readonly appendSystemPromptPath?: string;
  };
  readonly prompt?: string;
  readonly cliEnv?: NodeJS.ProcessEnv;
}): Promise<{
  readonly events: ReadonlyArray<OmpNativeCompatEvent>;
  readonly version: string;
  readonly modelResponse?: string;
  readonly modelRequests?: ReadonlyArray<CapturedProviderRequest>;
  readonly unexpectedRequests?: ReadonlyArray<string>;
}> {
  if (!liveOmpBinaryPath) throw new Error("A live OMP binary was not selected.");
  const settings = buildOmpSettings(input.sandbox);
  const spawnEnvironment = buildOmpProcessEnv(settings);
  for (const key of providerCredentialKeysFor("omp")) {
    expect(spawnEnvironment[key]).toBeUndefined();
  }
  const events: Array<OmpNativeCompatEvent> = [];
  const stderrLines: Array<string> = [];
  const fakeEndpoint = input.prompt ? await startFakeOpenAiEndpoint() : undefined;
  try {
    if (fakeEndpoint) await writeSyntheticModels(input.sandbox, fakeEndpoint.baseUrl);
    const output = await Effect.runPromise(
      Effect.gen(function* () {
        const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const version = yield* runOmpAcpCliCommand({
          childProcessSpawner,
          binaryPath: liveOmpBinaryPath!,
          args: ["--version"],
          cwd: input.sandbox.cwd,
          env: input.cliEnv ?? spawnEnvironment,
        });
        expect(version.exitCode).toBe(0);
        expect(version.stdout.trim()).toBe("omp/18.16.0");

        const result = yield* Effect.scoped(
          Effect.gen(function* () {
            const runtime = yield* makeOmpAcpRuntime({
              childProcessSpawner,
              ompSettings: settings,
              cwd: input.sandbox.cwd,
              clientInfo: { name: "synara-omp-native-compat-live", version: "0.0.0" },
              authPolicy: "on-demand",
              startupTimeouts: {
                initializeMs: 15_000,
                authenticateMs: 15_000,
                sessionSetupMs: 15_000,
                totalMs: 30_000,
              },
              expertSessionSpawn: {
                nativeCompat: input.launch,
                ...(input.expertSessionSpawn?.configOverlayPath
                  ? { configOverlayPath: input.expertSessionSpawn.configOverlayPath }
                  : {}),
                ...(input.expertSessionSpawn?.appendSystemPromptPath
                  ? { appendSystemPromptPath: input.expertSessionSpawn.appendSystemPromptPath }
                  : {}),
              },
              onChildStderrLine: (line) => {
                stderrLines.push(line.slice(0, 2_000));
                const event = parseOmpNativeCompatEvent(line, input.launch);
                if (event) events.push(event);
              },
            });
            yield* runtime.start().pipe(
              Effect.catch((cause) => {
                const details = stderrLines.slice(-12).join("\n");
                return Effect.fail(
                  new Error(
                    `${cause instanceof Error ? cause.message : String(cause)}${details ? `\nOMP stderr:\n${details}` : ""}`,
                  ),
                );
              }),
            );
            yield* Effect.tryPromise({
              try: () => waitForReadyEvent(events, input.launch.kind),
              catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
            });
            if (!input.prompt) return { version: version.stdout.trim() };
            if (input.launch.kind !== "evolution") {
              throw new Error("The restricted local-model prompt requires an evolution launch.");
            }
            const options = yield* runtime.getConfigOptions;
            const modelOption = options.find((option) => option.id === "model");
            const availableModels =
              modelOption?.type === "select"
                ? flattenConfigOptions(modelOption.options).map((option) => option.value)
                : [];
            if (!availableModels.includes(syntheticModel)) {
              throw new Error(
                `The isolated OMP profile did not advertise the local synthetic model: ${JSON.stringify(availableModels)}`,
              );
            }
            yield* runtime.setConfigOption("model", syntheticModel);
            yield* Effect.promise(() => writeOmpNativeEvolutionPrompt(input.launch, input.prompt!));
            const response = yield* runtime.prompt({
              prompt: [{ type: "text", text: input.prompt }],
            });
            return {
              version: version.stdout.trim(),
              modelResponse: response.stopReason,
            };
          }).pipe(Effect.provide(NodeServices.layer)),
        ).pipe(Effect.timeout("50 seconds"));
        return result;
      }).pipe(Effect.provide(NodeServices.layer)),
    );
    return {
      ...output,
      events,
      ...(fakeEndpoint
        ? {
            modelRequests: fakeEndpoint.requests,
            unexpectedRequests: fakeEndpoint.unexpectedRequests,
          }
        : {}),
    };
  } finally {
    await fakeEndpoint?.close();
  }
}

async function makeFixedSkillSession(sandbox: LiveSandbox): Promise<ProviderExpertSession> {
  const stateDir = path.join(sandbox.root, "skill-state");
  const packageSource = path.join(sandbox.root, "skill-package-source");
  const selectedSkillPath = path.join(packageSource, "skills", "selected-skill", "SKILL.md");
  const distractorSkillPath = path.join(
    sandbox.cwd,
    ".agents",
    "skills",
    "ambient-distractor",
    "SKILL.md",
  );
  await mkdir(path.dirname(selectedSkillPath), { recursive: true, mode: 0o700 });
  await mkdir(path.dirname(distractorSkillPath), { recursive: true, mode: 0o700 });
  await writeFile(
    selectedSkillPath,
    "---\nname: selected-skill\ndescription: Synthetic selected Skill fixture.\n---\nSelected package entry only.\n",
    { mode: 0o600 },
  );
  await writeFile(
    distractorSkillPath,
    "---\nname: ambient-distractor\ndescription: Must not enter the fixed assembly.\n---\nSYNARA_LIVE_OMP_SKILL_SENTINEL\n",
    { mode: 0o600 },
  );
  const store = createSkillPackageStore(stateDir);
  const preview = await store.preview({ path: packageSource });
  const imported = await store.import({ previewId: preview.previewId });
  const skillEntries = await store.resolveSelections([
    {
      packageId: imported.package.packageId,
      entryPath: "skills/selected-skill/SKILL.md",
      activation: "on-demand",
    },
  ]);
  return {
    snapshotId: `exp_${"b".repeat(64)}`,
    persona: "Synthetic OMP native Skill probe",
    skillsRoot: path.join(stateDir, "experts", "skill-packages"),
    skillPolicy: FIXED_EXPERT_SKILL_POLICY,
    skillLoading: "index",
    skills: skillEntries.map(({ name, path: skillPath }) => ({ name, path: skillPath })),
    skillEntries,
    references: [],
  };
}

describe.skipIf(!liveOmpBinaryPath)("OMP 18.16 native compatibility live probes", () => {
  it("starts the public evolution extension and sends only its authorized prompt to a loopback model", async () => {
    const sandbox = await makeSandbox();
    try {
      const launch = await prepareOmpNativeCompat({
        privateTempDirectory: sandbox.bridgeDir,
        kind: "evolution",
        sessionDir: sandbox.sessionsDir,
      });
      const cwdSentinels = [
        path.join(sandbox.cwd, "AGENTS.md"),
        path.join(sandbox.cwd, ".omp", "APPEND_SYSTEM.md"),
      ];
      await mkdir(path.dirname(cwdSentinels[1]!), { recursive: true, mode: 0o700 });
      await writeFile(cwdSentinels[0]!, `${contextSentinels[0]}\n`, { mode: 0o600 });
      await writeFile(cwdSentinels[1]!, `${contextSentinels[2]}\n`, { mode: 0o600 });
      const result = await runNativeSession({ sandbox, launch, prompt: userPrompt });
      expect(result.version).toBe("omp/18.16.0");
      expect(result.events).toContainEqual({ type: "ready", kind: "evolution" });
      expect(result.modelResponse).toBe("end_turn");
      expect(result.unexpectedRequests).toEqual([]);
      expect(result.modelRequests).toHaveLength(1);
      const request = result.modelRequests![0]!;
      expect(request.method).toBe("POST");
      expect(request.url).toMatch(/\/chat\/completions$/u);
      expect(request.authorization).toBe(`Bearer ${syntheticApiKey}`);
      expect(request.payload).toMatchObject({ model: syntheticWireModelId });
      const body = request.payload as {
        messages?: ReadonlyArray<{ role?: unknown; content?: unknown }>;
        tools?: unknown;
      };
      const messages = body.messages ?? [];
      expect(messages.map((message) => message.role)).toEqual(["system", "user"]);
      expect(textContent(messages[0]?.content)).toBe(
        await readFile(launch.systemPromptPath!, "utf8"),
      );
      expect(textContent(messages[1]?.content)).toBe(userPrompt);
      expect(
        body.tools === undefined || (Array.isArray(body.tools) && body.tools.length === 0),
      ).toBe(true);
      const serialized = JSON.stringify(request.payload);
      for (const sentinel of contextSentinels) expect(serialized).not.toContain(sentinel);
    } finally {
      await makeTreeWritable(sandbox.root);
      await rm(sandbox.root, { recursive: true, force: true });
    }
  }, 90_000);

  it("prepares the exact fixed Skill assembly with OMP config/list and starts the fixed public extension", async () => {
    if (!liveOmpBinaryPath) throw new Error("A live OMP binary was not selected.");
    const sandbox = await makeSandbox();
    const settings = buildOmpSettings(sandbox);
    const events: Array<OmpNativeCompatEvent> = [];
    let prepared: OmpExpertSessionPreparation | undefined;

    try {
      const nativeLaunch = await prepareOmpNativeCompat({
        privateTempDirectory: sandbox.bridgeDir,
        kind: "fixed",
        sessionDir: sandbox.sessionsDir,
      });
      const expertSession = await makeFixedSkillSession(sandbox);
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
          const env = buildOmpProcessEnv(settings);
          const preparation = yield* prepareOmpExpertSession({
            cwd: sandbox.cwd,
            env,
            expertSession,
            lifecycleGeneration: "omp-native-live-fixed-probe",
            tempDirectory: sandbox.root,
            runCli: (args, cwd, childEnv) =>
              runOmpAcpCliCommand({
                childProcessSpawner,
                binaryPath: liveOmpBinaryPath!,
                args,
                cwd,
                env: childEnv,
              }),
          });
          prepared = preparation;
          if (preparation.issues.length) {
            throw new Error(`OMP fixed Skill prep issues: ${preparation.issues.join("; ")}`);
          }
          if (!preparation.verify) throw new Error("OMP fixed Skill prep omitted verification.");
          yield* preparation.verify();
          const skillList = yield* runOmpAcpCliCommand({
            childProcessSpawner,
            binaryPath: liveOmpBinaryPath!,
            args: ["skill", "list", sandbox.cwd, "--json"],
            cwd: sandbox.cwd,
            env: {
              ...env,
              ...(preparation.configOverlayPath
                ? {
                    PI_CONFIG_FILES: [env.PI_CONFIG_FILES, preparation.configOverlayPath]
                      .filter(Boolean)
                      .join(path.delimiter),
                  }
                : {}),
            },
          });
          if (skillList.exitCode !== 0) {
            throw new Error("OMP native Skill list returned a non-zero exit code.");
          }
          const parsedSkills = JSON.parse(skillList.stdout) as {
            skills?: ReadonlyArray<{ name?: unknown; filePath?: unknown }>;
            warnings?: ReadonlyArray<unknown>;
          };
          const nativeNames = (parsedSkills.skills ?? []).map((skill) => skill.name);
          expect(nativeNames).toEqual(["selected-skill"]);
          expect(parsedSkills.skills?.[0]?.filePath).toBe(expertSession.skillEntries?.[0]?.path);
          expect(parsedSkills.warnings).toEqual([]);
          const nativeConfig = yield* runOmpAcpCliCommand({
            childProcessSpawner,
            binaryPath: liveOmpBinaryPath!,
            args: ["config", "list", "--json"],
            cwd: sandbox.cwd,
            env: {
              ...env,
              ...(preparation.configOverlayPath
                ? {
                    PI_CONFIG_FILES: [env.PI_CONFIG_FILES, preparation.configOverlayPath]
                      .filter(Boolean)
                      .join(path.delimiter),
                  }
                : {}),
            },
          });
          if (nativeConfig.exitCode !== 0) {
            throw new Error("OMP fixed Skill config list returned a non-zero exit code.");
          }
          const config = JSON.parse(nativeConfig.stdout) as Record<string, { value?: unknown }>;
          expect(config["skills.enabled"]?.value).toBe(true);
          expect(config["skills.enableAgentsProject"]?.value).toBe(false);
          expect(config["skills.includeSkills"]?.value).toEqual(["selected-skill"]);
          const runtime = yield* Effect.scoped(
            Effect.gen(function* () {
              const acp = yield* makeOmpAcpRuntime({
                childProcessSpawner,
                ompSettings: settings,
                cwd: sandbox.cwd,
                clientInfo: { name: "synara-omp-native-compat-live", version: "0.0.0" },
                authPolicy: "on-demand",
                startupTimeouts: {
                  initializeMs: 15_000,
                  authenticateMs: 15_000,
                  sessionSetupMs: 15_000,
                  totalMs: 30_000,
                },
                expertSessionSpawn: {
                  nativeCompat: nativeLaunch,
                  ...(preparation.configOverlayPath
                    ? { configOverlayPath: preparation.configOverlayPath }
                    : {}),
                  ...(preparation.appendSystemPromptPath
                    ? { appendSystemPromptPath: preparation.appendSystemPromptPath }
                    : {}),
                },
                onChildStderrLine: (line) => {
                  const event = parseOmpNativeCompatEvent(line, nativeLaunch);
                  if (event) events.push(event);
                },
              });
              yield* acp.start();
              yield* Effect.tryPromise({
                try: () => waitForReadyEvent(events, "fixed"),
                catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
              });
              return acp;
            }).pipe(Effect.provide(NodeServices.layer)),
          ).pipe(Effect.timeout("40 seconds"));
          return { preparation, nativeNames, runtimeStarted: Boolean(runtime) };
        }).pipe(Effect.provide(NodeServices.layer)),
      );
      prepared = result.preparation;
      expect(result.preparation.cliVersion).toBe("18.16.0");
      expect(result.preparation.loadedSkills.map((skill) => skill.name)).toEqual([
        "selected-skill",
      ]);
      expect(result.nativeNames).toEqual(["selected-skill"]);
      expect(result.runtimeStarted).toBe(true);
      expect(events).toContainEqual({ type: "ready", kind: "fixed" });
    } finally {
      try {
        if (prepared) await Effect.runPromise(prepared.cleanup());
      } finally {
        await makeTreeWritable(sandbox.root);
        await rm(sandbox.root, { recursive: true, force: true });
      }
    }
  }, 90_000);
});
