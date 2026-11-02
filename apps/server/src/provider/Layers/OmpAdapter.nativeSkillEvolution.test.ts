// Native OMP ACP transport validation against a loopback-only synthetic model.
// Opt in with SYNARA_NATIVE_OMP_SKILL_EVOLUTION=1 and
// SYNARA_OMP_SKILL_EVOLUTION_NATIVE_CLI=/absolute/path/to/omp.

import { ThreadId, type ProviderRuntimeEvent } from "@synara/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Layer, Stream } from "effect";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import nodePath from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { ServerConfig } from "../../config.ts";
import type { OmpAcpRuntimeSettings } from "../acp/OmpAcpSupport.ts";
import { SKILL_EVOLUTION_SYSTEM_PROMPT } from "../skillEvolutionConstraints.ts";
import type { OmpAdapterShape } from "../Services/OmpAdapter.ts";
import { OmpAdapter } from "../Services/OmpAdapter.ts";
import { makeOmpAdapterLive } from "./OmpAdapter.ts";

const RUN_NATIVE = process.env.SYNARA_NATIVE_OMP_SKILL_EVOLUTION === "1";
const OMP_BINARY = process.env.SYNARA_OMP_SKILL_EVOLUTION_NATIVE_CLI?.trim() ?? "";
const MODEL_SELECTION = {
  provider: "omp" as const,
  model: "synara-loopback/control",
  options: { thinkingLevel: "off" as const },
};
const AUTHORIZED_PROMPT = "AUTHORIZED_SKILL_EVOLUTION_NATIVE_PROMPT";
const SENTINELS = [
  "SYNARA_CONTEXT_SENTINEL",
  "SYNARA_APPEND_SENTINEL",
  "SYNARA_SKILL_SENTINEL",
  "SYNARA_CUSTOM_TOOL_SENTINEL",
] as const;

interface CapturedModelRequest {
  readonly path: string;
  readonly authorization: string | undefined;
  readonly body: Record<string, unknown>;
}

const adapterLayer = (settings: OmpAcpRuntimeSettings) => {
  const configLayer = ServerConfig.layerTest(process.cwd(), {
    prefix: "synara-omp-native-skill-evolution-",
  }).pipe(Layer.provide(NodeServices.layer));
  return makeOmpAdapterLive(settings).pipe(
    Layer.provide(Layer.mergeAll(NodeServices.layer, configLayer)),
  );
};

const withNativeAdapter = <A, E>(
  settings: OmpAcpRuntimeSettings,
  run: (adapter: OmpAdapterShape, events: ProviderRuntimeEvent[]) => Effect.Effect<A, E>,
) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const adapter = yield* OmpAdapter;
        const events: ProviderRuntimeEvent[] = [];
        yield* Stream.runForEach(adapter.streamEvents, (event) =>
          Effect.sync(() => events.push(event)),
        ).pipe(Effect.forkScoped);
        return yield* run(adapter, events);
      }).pipe(Effect.provide(adapterLayer(settings))),
    ),
  );

const waitForEvent = (
  events: ProviderRuntimeEvent[],
  match: (event: ProviderRuntimeEvent) => boolean,
  timeoutMs: number,
) =>
  Effect.gen(function* () {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const event = events.find(match);
      if (event) return event;
      yield* Effect.sleep(100);
    }
    return yield* Effect.fail(new Error("timed out waiting for native OMP turn completion"));
  });

const waitForPromise = <A>(promise: Promise<A>, timeoutMs: number, detail: string) =>
  Effect.tryPromise({
    try: () =>
      new Promise<A>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(detail)), timeoutMs);
        timer.unref();
        promise.then(
          (value) => {
            clearTimeout(timer);
            resolve(value);
          },
          (cause) => {
            clearTimeout(timer);
            reject(cause);
          },
        );
      }),
    catch: (cause) => (cause instanceof Error ? cause : new Error(detail)),
  });

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) =>
      typeof part === "object" && part !== null && "text" in part && typeof part.text === "string"
        ? part.text
        : "",
    )
    .join("");
}

describe.skipIf(!RUN_NATIVE)("OmpAdapter native Skill extraction ACP isolation", () => {
  let fakeProvider: Server | undefined;
  let ownedRoot: string | undefined;

  afterAll(async () => {
    if (fakeProvider?.listening) {
      fakeProvider.closeAllConnections();
      await new Promise<void>((resolve) => fakeProvider!.close(() => resolve()));
    }
    if (ownedRoot) rmSync(ownedRoot, { recursive: true, force: true });
  });

  it("sends only the fixed system prompt and submitted text, cancels, and removes its private workspace", async () => {
    expect(OMP_BINARY, "set the selected canonical OMP CLI path for this opt-in test").toBeTruthy();
    ownedRoot = mkdtempSync(nodePath.join(tmpdir(), "synara-omp-native-skill-evolution-"));
    const agentDir = nodePath.join(ownedRoot, "agent");
    const requestedCwd = nodePath.join(ownedRoot, "requested-workspace");
    mkdirSync(agentDir, { recursive: true, mode: 0o700 });
    mkdirSync(requestedCwd, { recursive: true, mode: 0o700 });
    for (const directory of [agentDir, requestedCwd]) chmodSync(directory, 0o700);

    let resolveRequest!: (request: CapturedModelRequest) => void;
    let markResponseClosed!: () => void;
    const requestReceived = new Promise<CapturedModelRequest>((resolve) => {
      resolveRequest = resolve;
    });
    const responseClosed = new Promise<void>((resolve) => {
      markResponseClosed = resolve;
    });
    const paths: string[] = [];
    fakeProvider = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const requestPath = request.url ?? "";
        paths.push(requestPath);
        if (requestPath.endsWith("/chat/completions")) {
          let body: Record<string, unknown>;
          try {
            body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
          } catch {
            body = { parseError: true };
          }
          resolveRequest({
            path: requestPath,
            authorization: request.headers.authorization,
            body,
          });
          response.writeHead(200, {
            "content-type": "text/event-stream",
            "cache-control": "no-cache",
            connection: "keep-alive",
          });
          response.write(
            `data: ${JSON.stringify({
              id: "chatcmpl-synara-native-test",
              object: "chat.completion.chunk",
              created: 1,
              model: "control",
              choices: [{ index: 0, delta: { content: "captured" }, finish_reason: null }],
            })}\n\n`,
          );
          response.on("close", markResponseClosed);
          return;
        }
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ data: [{ id: "control" }] }));
      });
    });
    await new Promise<void>((resolve, reject) => {
      fakeProvider!.once("error", reject);
      fakeProvider!.listen(0, "127.0.0.1", () => resolve());
    });
    const address = fakeProvider.address();
    if (!address || typeof address === "string")
      throw new Error("loopback fakeprovider did not bind");

    const syntheticKey = "SYNARA_SYNTHETIC_LOOPBACK_ONLY_KEY";
    const baseUrl = `http://127.0.0.1:${address.port}/v1`;
    writeFileSync(
      nodePath.join(agentDir, "models.yml"),
      [
        "providers:",
        "  synara-loopback:",
        `    baseUrl: \"${baseUrl}\"`,
        `    apiKey: \"${syntheticKey}\"`,
        "    api: openai-completions",
        "    models:",
        "      - id: control",
        "        name: Synara Loopback Control",
        "        contextWindow: 8192",
        "        maxTokens: 512",
        "        supportsTools: true",
        "",
      ].join("\n"),
      { mode: 0o600 },
    );
    writeFileSync(nodePath.join(agentDir, "AGENTS.md"), `${SENTINELS[0]}\n`, { mode: 0o600 });
    writeFileSync(nodePath.join(agentDir, "APPEND_SYSTEM.md"), `${SENTINELS[1]}\n`, {
      mode: 0o600,
    });
    const skillDir = nodePath.join(agentDir, "skills", "sentinel-skill");
    mkdirSync(skillDir, { recursive: true, mode: 0o700 });
    writeFileSync(
      nodePath.join(skillDir, "SKILL.md"),
      `---\nname: sentinel-skill\ndescription: ${SENTINELS[2]}\n---\n${SENTINELS[2]}\n`,
      { mode: 0o600 },
    );
    const customToolsDir = nodePath.join(agentDir, "tools");
    mkdirSync(customToolsDir, { recursive: true, mode: 0o700 });
    writeFileSync(
      nodePath.join(customToolsDir, "sentinel.ts"),
      `export default () => ({ name: "synara_native_sentinel_tool", description: "${SENTINELS[3]}", parameters: { type: "object", properties: {} }, execute: async () => ({ content: [] }) });\n`,
      { mode: 0o600 },
    );

    let sessionCwd = "";
    let cancelled = false;
    try {
      await withNativeAdapter(
        {
          binaryPath: OMP_BINARY,
          agentDir,
          environment: {
            HOME: ownedRoot,
            PATH: process.env.PATH ?? "",
            PI_CODING_AGENT_DIR: agentDir,
          },
        },
        (adapter, events) =>
          Effect.gen(function* () {
            const threadId = ThreadId.makeUnsafe(crypto.randomUUID());
            const session = yield* adapter.startSession({
              threadId,
              provider: "omp",
              executionPurpose: "skill-evolution",
              cwd: requestedCwd,
              runtimeMode: "approval-required",
              approvalPolicy: "on-request",
              modelSelection: MODEL_SELECTION,
            });
            if (!session.cwd)
              return yield* Effect.fail(new Error("native session has no isolated cwd"));
            sessionCwd = session.cwd;
            expect(session.status).toBe("ready");
            expect(session.model).toBe(MODEL_SELECTION.model);
            expect(sessionCwd).not.toBe(requestedCwd);

            const turn = yield* adapter.sendTurn({
              threadId,
              input: AUTHORIZED_PROMPT,
              modelSelection: MODEL_SELECTION,
            });
            const captured = yield* waitForPromise(
              requestReceived,
              30_000,
              "loopback model transport did not receive the OMP prompt",
            );
            yield* adapter.interruptTurn(threadId, turn.turnId);
            yield* waitForPromise(
              responseClosed,
              10_000,
              "native cancellation did not close the model stream",
            );
            const completed = yield* waitForEvent(
              events,
              (candidate) =>
                candidate.type === "turn.completed" && candidate.turnId === turn.turnId,
              30_000,
            );
            if (completed.type !== "turn.completed") {
              return yield* Effect.fail(new Error("unexpected native OMP completion event"));
            }
            cancelled = ["cancelled", "interrupted"].includes(completed.payload.state);
            yield* adapter.stopSession(threadId);
            yield* adapter.stopAll();
            return captured;
          }),
      ).then((captured) => {
        const body = captured.body;
        const messages = Array.isArray(body.messages) ? body.messages : [];
        const systemMessages = messages
          .filter(
            (message): message is Record<string, unknown> =>
              typeof message === "object" &&
              message !== null &&
              (message.role === "system" || message.role === "developer"),
          )
          .map((message) => messageText(message.content));
        const userMessages = messages
          .filter(
            (message): message is Record<string, unknown> =>
              typeof message === "object" && message !== null && message.role === "user",
          )
          .map((message) => messageText(message.content));
        const serializedBody = JSON.stringify(body);
        expect(captured.path).toBe("/v1/chat/completions");
        expect(captured.authorization).toBe(`Bearer ${syntheticKey}`);
        expect(body.model).toBe("control");
        expect(
          body.tools === undefined || (Array.isArray(body.tools) && body.tools.length === 0),
        ).toBe(true);
        expect(systemMessages).toEqual([SKILL_EVOLUTION_SYSTEM_PROMPT]);
        expect(userMessages).toEqual([AUTHORIZED_PROMPT]);
        expect(SENTINELS.every((sentinel) => !serializedBody.includes(sentinel))).toBe(true);
        expect(paths.every((requestPath) => requestPath.startsWith("/v1/"))).toBe(true);
        expect(cancelled).toBe(true);
        expect(existsSync(sessionCwd)).toBe(false);
      });
    } finally {
      fakeProvider.closeAllConnections();
      await Promise.race([
        new Promise<void>((resolve) => fakeProvider!.close(() => resolve())),
        new Promise<void>((resolve) => setTimeout(resolve, 1_000)),
      ]);
      if (ownedRoot) rmSync(ownedRoot, { recursive: true, force: true });
    }
  }, 120_000);
});
