import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ThreadId } from "@synara/contracts";
import { Effect, Layer, Stream } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AgentGatewayCredentials,
  type AgentGatewayCredentialsShape,
} from "../../agentGateway/Services/AgentGatewayCredentials.ts";
import { SYNARA_HARNESS_POLICY_MARKER } from "../../agentGateway/harnessPolicy.ts";
import { ServerConfig } from "../../config.ts";
import { OmpAdapter } from "../Services/OmpAdapter.ts";
import { makeOmpAdapterLive } from "./OmpAdapter.ts";

const fixture = vi.hoisted(() => ({
  compatibilityProbeMarker: "OMP_SKILL_EVOLUTION_PROBE_MARKER",
  compatibilityMarker: "OMP_SKILL_EVOLUTION_SESSION_MARKER",
  compatibilityInputs: [] as Array<Record<string, any>>,
  compatibilityFailure: false,
  runtimeInputs: [] as Array<Record<string, any>>,
  prompts: [] as unknown[],
  modelSelections: [] as Array<Record<string, unknown>>,
  hangPrompt: false,
  releasePrompt: undefined as (() => void) | undefined,
}));

vi.mock("../acp/OmpSkillEvolutionCompat.ts", async (original) => ({
  ...(await original<typeof import("../acp/OmpSkillEvolutionCompat.ts")>()),
  OMP_SKILL_EVOLUTION_COMPAT_MARKER_TIMEOUT_MS: 5,
  prepareOmpSkillEvolutionCompat: async (input: Record<string, any>) => {
    fixture.compatibilityInputs.push(input);
    if (fixture.compatibilityFailure) throw new Error("fixture bundle hash mismatch");
    return {
      bunExecutable: "/selected/bun",
      cliEntrypoint: "/selected/omp/dist/cli.js",
      preloadPath: path.join(input.privateTempDirectory, "omp-skill-evolution-compat.mjs"),
      sessionDir: input.sessionDir,
      probeMarker: fixture.compatibilityProbeMarker,
      expectedMarker: fixture.compatibilityMarker,
    };
  },
  verifyOmpSkillEvolutionCompatProbe: (input: {
    readonly stderr: string;
    readonly expectedMarker: string;
  }) => input.stderr.split(/\r?\n/u).some((line) => line.trim() === input.expectedMarker),
}));

vi.mock("../acp/OmpAcpSupport.ts", async (original) => ({
  ...(await original<typeof import("../acp/OmpAcpSupport.ts")>()),
  applyOmpAcpModelSelection: (input: Record<string, unknown>) =>
    Effect.sync(() => fixture.modelSelections.push(input)),
  applyOmpAcpInteractionMode: () => Effect.void,
  runOmpAcpCliCommand: () =>
    Effect.succeed({
      stdout: "omp/18.12.1",
      stderr: `${fixture.compatibilityProbeMarker}\n`,
      exitCode: 0,
    }),
  makeOmpAcpRuntime: (input: Record<string, any>) => {
    fixture.runtimeInputs.push(input);
    return Effect.succeed({
      handleRequestPermission: () => Effect.void,
      handleElicitation: () => Effect.void,
      start: () => {
        if (input.expertSessionSpawn?.skillEvolutionCompat) {
          input.onChildStderrLine?.(fixture.compatibilityMarker);
        }
        return Effect.succeed({
          sessionId: `omp-fixture-${fixture.runtimeInputs.length}`,
          sessionSetupMethod: "new" as const,
          initializeResult: { protocolVersion: 1, agentCapabilities: {} },
          sessionSetupResult: { sessionId: `omp-fixture-${fixture.runtimeInputs.length}` },
          modelConfigId: undefined,
        });
      },
      awaitExit: Effect.never,
      getEvents: () => Stream.never,
      sessionUpdatesEnqueuedCount: Effect.succeed(0),
      getModeState: Effect.succeed(undefined),
      getConfigOptions: Effect.succeed([]),
      awaitLoadReplayReady: Effect.void,
      getAvailableCommands: Effect.succeed([]),
      supportsSessionRecovery: Effect.succeed(true),
      supportsSessionFork: Effect.succeed(false),
      cancel: Effect.sync(() => fixture.releasePrompt?.()),
      prompt: (content: unknown) => {
        fixture.prompts.push(content);
        return fixture.hangPrompt
          ? Effect.promise(
              () =>
                new Promise((resolve) => {
                  fixture.releasePrompt = () => resolve({ stopReason: "end_turn" });
                }),
            )
          : Effect.succeed({ stopReason: "end_turn" as const });
      },
    });
  },
}));

const testRoots: string[] = [];

afterEach(async () => {
  fixture.compatibilityInputs.length = 0;
  fixture.compatibilityFailure = false;
  fixture.runtimeInputs.length = 0;
  fixture.prompts.length = 0;
  fixture.modelSelections.length = 0;
  fixture.hangPrompt = false;
  fixture.releasePrompt = undefined;
  for (const root of testRoots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

function makeGatewayCredentials(calls: { connection: number; revoked: number }) {
  return {
    connectionForThread: vi.fn(() => {
      calls.connection += 1;
      return { url: "http://127.0.0.1:1/mcp", bearerToken: "GATEWAY_SENTINEL" };
    }),
    revokeSessionToken: vi.fn(() => {
      calls.revoked += 1;
    }),
    stdioProxy: { command: "/server/node", args: ["/server/proxy.js"] },
  } as unknown as AgentGatewayCredentialsShape;
}

async function makeTestAdapterLayer(root: string, credentials: AgentGatewayCredentialsShape) {
  const spawner = ChildProcessSpawner.make(() =>
    Effect.die(new Error("the mocked OMP ACP seam owns this test")),
  );
  return makeOmpAdapterLive({ binaryPath: "/selected/omp" }).pipe(
    Layer.provideMerge(ServerConfig.layerTest(root, path.join(root, "state"))),
    Layer.provideMerge(NodeServices.layer),
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Layer.succeed(AgentGatewayCredentials, credentials),
      ),
    ),
  );
}

describe("OMP Skill extraction runtime isolation", () => {
  it("skips Gateway, MCP, and harness injection, preserves model/account sources, and cleans up on cancel", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-skill-evolution-adapter-"));
    testRoots.push(root);
    const gatewayCalls = { connection: 0, revoked: 0 };
    const credentials = makeGatewayCredentials(gatewayCalls);
    fixture.hangPrompt = true;
    let workspaceRoot = "";

    await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OmpAdapter;
        const threadId = ThreadId.makeUnsafe("omp-skill-evolution-isolated");
        const modelSelection = {
          provider: "omp" as const,
          instanceId: "omp",
          model: "openai/gpt-4o",
        };
        const started = yield* adapter.startSession({
          threadId,
          provider: "omp",
          providerInstanceId: "omp" as never,
          cwd: root,
          runtimeMode: "approval-required",
          modelSelection,
          executionPurpose: "skill-evolution",
          providerOptions: { omp: { agentDir: "/selected/account/agent" } },
        });

        expect(started.cwd).not.toBe(root);
        expect(fixture.compatibilityInputs).toHaveLength(1);
        const compatInput = fixture.compatibilityInputs[0]!;
        expect(compatInput.cwd).toBe(started.cwd);
        expect(compatInput.env.PI_CODING_AGENT_DIR).toBe("/selected/account/agent");
        expect(compatInput.sessionDir).not.toBe(started.cwd);
        expect(compatInput.privateTempDirectory).not.toBe(compatInput.sessionDir);
        workspaceRoot = path.dirname(started.cwd as string);

        const resumeAttempt = yield* Effect.result(
          adapter.startSession({
            threadId,
            provider: "omp",
            providerInstanceId: "omp" as never,
            cwd: root,
            runtimeMode: "approval-required",
            modelSelection,
            executionPurpose: "skill-evolution",
            resumeCursor: { schemaVersion: 1, sessionId: "must-not-resume" },
          }),
        );
        expect(resumeAttempt._tag).toBe("Failure");
        expect(fixture.compatibilityInputs).toHaveLength(1);
        expect(fixture.runtimeInputs).toHaveLength(1);

        const runtimeInput = fixture.runtimeInputs.at(-1)!;
        expect(runtimeInput.ompSettings.agentDir).toBe("/selected/account/agent");
        expect(runtimeInput.expertSessionSpawn).toMatchObject({
          disableExtensions: true,
          skillEvolutionCompat: {
            sessionDir: compatInput.sessionDir,
            expectedMarker: fixture.compatibilityMarker,
            probeMarker: fixture.compatibilityProbeMarker,
          },
        });
        expect(runtimeInput.buildMcpServers).toBeUndefined();
        expect(gatewayCalls.connection).toBe(0);

        const fork = yield* Effect.result(
          adapter.forkThread!({
            threadId: ThreadId.makeUnsafe("omp-skill-evolution-fork-target"),
            sourceThreadId: threadId,
            cwd: root,
            runtimeMode: "approval-required",
          }),
        );
        expect(fork._tag).toBe("Failure");
        expect(fixture.runtimeInputs).toHaveLength(1);

        const ambientSkill = yield* Effect.result(
          adapter.sendTurn({
            threadId,
            input: "This must not include a discovered skill.",
            skills: [{ name: "Ambient skill", path: "/ambient/SKILL.md" }],
          }),
        );
        expect(ambientSkill._tag).toBe("Failure");
        expect(fixture.prompts).toHaveLength(0);

        const sent = yield* adapter.sendTurn({
          threadId,
          input: "Explicit extraction request only.",
          attachments: [],
          modelSelection,
        });
        expect(fixture.modelSelections.at(-1)).toMatchObject({ model: "openai/gpt-4o" });
        yield* adapter.interruptTurn(threadId, sent.turnId);
        expect(yield* adapter.hasSession(threadId)).toBe(false);
      }).pipe(Effect.provide(await makeTestAdapterLayer(root, credentials)), Effect.scoped),
    );

    expect(gatewayCalls.connection).toBe(0);
    expect(gatewayCalls.revoked).toBe(0);
    expect(fixture.prompts).toHaveLength(1);
    expect(fixture.prompts[0]).toEqual({
      prompt: [{ type: "text", text: "Explicit extraction request only." }],
    });
    expect(JSON.stringify(fixture.prompts)).not.toContain(SYNARA_HARNESS_POLICY_MARKER);
    expect(JSON.stringify(fixture.prompts)).not.toContain("GATEWAY_SENTINEL");
    await expect(fs.stat(workspaceRoot)).rejects.toThrow();
  });

  it("keeps ordinary OMP Gateway and harness behavior, and cleans an extraction workspace on preflight failure", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-skill-evolution-failure-"));
    testRoots.push(root);
    const gatewayCalls = { connection: 0, revoked: 0 };
    const credentials = makeGatewayCredentials(gatewayCalls);
    let failedWorkspaceRoot = "";

    fixture.compatibilityFailure = true;
    await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OmpAdapter;
        const outcome = yield* Effect.result(
          adapter.startSession({
            threadId: ThreadId.makeUnsafe("omp-skill-evolution-preflight-failure"),
            provider: "omp",
            providerInstanceId: "omp" as never,
            cwd: root,
            runtimeMode: "approval-required",
            modelSelection: {
              provider: "omp",
              instanceId: "omp",
              model: "openai/gpt-4o",
            },
            executionPurpose: "skill-evolution",
          }),
        );
        expect(outcome._tag).toBe("Failure");
        expect(fixture.runtimeInputs).toHaveLength(0);
        expect(gatewayCalls.connection).toBe(0);
        failedWorkspaceRoot = path.dirname(fixture.compatibilityInputs[0]!.cwd);

        fixture.compatibilityFailure = false;
        fixture.hangPrompt = false;
        const ordinaryThreadId = ThreadId.makeUnsafe("omp-skill-evolution-ordinary-control");
        yield* adapter.startSession({
          threadId: ordinaryThreadId,
          provider: "omp",
          cwd: root,
          runtimeMode: "approval-required",
        });
        const ordinaryRuntime = fixture.runtimeInputs.at(-1)!;
        expect(typeof ordinaryRuntime.buildMcpServers).toBe("function");
        expect(gatewayCalls.connection).toBe(1);

        yield* adapter.sendTurn({ threadId: ordinaryThreadId, input: "ordinary OMP turn" });
        yield* Effect.sleep(20);
        yield* adapter.stopSession(ordinaryThreadId);
      }).pipe(Effect.provide(await makeTestAdapterLayer(root, credentials)), Effect.scoped),
    );

    await expect(fs.stat(failedWorkspaceRoot)).rejects.toThrow();
    expect(gatewayCalls.revoked).toBe(1);
    expect(fixture.prompts).toHaveLength(1);
    expect(JSON.stringify(fixture.prompts[0])).toContain(SYNARA_HARNESS_POLICY_MARKER);
  });
});
