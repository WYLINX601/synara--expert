import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { FIXED_EXPERT_SKILL_POLICY, ThreadId, type ProviderExpertSession } from "@synara/contracts";
import { Effect, Fiber, Layer, Queue, Stream } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import { describe, expect, it, vi } from "vitest";
import { ServerConfig } from "../../config";
import {
  AgentGatewayCredentials,
  type AgentGatewayCredentialsShape,
} from "../../agentGateway/Services/AgentGatewayCredentials.ts";
import { recordVerifiedNativeSkillAssembly } from "../expertSkillCatalog";
import { OmpAdapter } from "../Services/OmpAdapter";

const makeNativeLearningPermissionRequest = (toolCallId: string) => ({
  sessionId: "native-fixed",
  options: [
    { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
    { optionId: "reject", name: "Reject", kind: "reject_once" },
  ],
  toolCall: {
    toolCallId,
    kind: "other",
    title: "Learning gateway call",
    status: "pending",
    rawInput: {},
  },
});

const preparation = vi.hoisted(() => ({
  calls: [] as unknown[],
  reject: true,
  reloadChanged: false,
  runtimeCreations: 0,
  prompts: 0,
  promptInputs: [] as unknown[],
  spawnInputs: [] as unknown[],
  compatChildMarker: true,
  resolveCalls: [] as Array<{ binaryPath?: string | null; options?: unknown }>,
  compatPreparations: 0,
  nativePreparations: 0,
  cliVersion: undefined as string | undefined,
  permissionHandler: undefined as unknown,
  childStderrLine: undefined as unknown,
  promptScenario: undefined as unknown,
  permissionResults: [] as unknown[],
  acpEventEmitter: undefined as unknown,
  queuedAcpEvents: 0,
}));
vi.mock("../acp/OmpExpertSession.ts", async (original) => ({
  ...(await original<typeof import("../acp/OmpExpertSession.ts")>()),
  prepareOmpExpertSession: (input: unknown) => {
    preparation.calls.push(input);
    if (preparation.reject)
      return Effect.succeed({
        issues: ["Fixed native catalog contains an unselected Skill"],
        instructionsHash: "a".repeat(64),
        loadedSkills: [],
        ownedTempDirectory: "/private/omp-fixed-test",
        cleanup: () => Effect.void,
      });
    const session = (input as { expertSession?: ProviderExpertSession }).expertSession;
    if (!session) {
      return Effect.succeed({
        issues: [],
        instructionsHash: "b".repeat(64),
        loadedSkills: [],
        ownedTempDirectory: "/private/omp-context-test",
        cleanup: () => Effect.void,
      });
    }
    return Effect.promise(() =>
      recordVerifiedNativeSkillAssembly(
        session,
        session.skills,
        (input as { lifecycleGeneration: string }).lifecycleGeneration,
      ),
    ).pipe(
      Effect.as({
        issues: [],
        instructionsHash: "a".repeat(64),
        loadedSkills: session.skills,
        ...(preparation.cliVersion ? { cliVersion: preparation.cliVersion } : {}),
        ownedTempDirectory: "/private/omp-fixed-test",
        cleanup: () => Effect.void,
        allowedSkillCommands: ["entry-selected"],
        verify: () =>
          preparation.reloadChanged
            ? Effect.fail(new Error("Advisor or Skill catalog changed"))
            : Effect.void,
      }),
    );
  },
}));
vi.mock("../acp/OmpAcpSupport.ts", async (original) => ({
  ...(await original<typeof import("../acp/OmpAcpSupport.ts")>()),
  resolveOmpCliBinaryPath: (binaryPath?: string | null, options?: unknown) => {
    preparation.resolveCalls.push({
      ...(binaryPath !== undefined ? { binaryPath } : {}),
      ...(options !== undefined ? { options } : {}),
    });
    return binaryPath?.trim() || "/bin/omp";
  },
  runOmpAcpCliCommand: () =>
    Effect.succeed({
      stdout: "omp/18.12.1",
      stderr:
        "SYNARA_OMP_ACP_IDLE_TASK_COMPAT v2 sha256=c5d51fbb4d787035f3cec7b3579234de4c55b169574a094e2a672bb68970992d",
      exitCode: 0,
    }),
  makeOmpAcpRuntime: (input: {
    resumeSessionId?: string;
    expertSessionSpawn?: {
      disableExtensions?: boolean;
      nativeCompat?: { expectedMarker: string; kind: string };
    };
    onChildStderrLine?: (line: string) => void;
  }) => {
    preparation.spawnInputs.push(input);
    preparation.runtimeCreations++;
    return Effect.succeed({
      handleRequestPermission: (handler: unknown) =>
        Effect.sync(() => {
          preparation.permissionHandler = handler;
        }),
      handleElicitation: () => Effect.void,
      start: () =>
        Effect.sync(() => {
          preparation.childStderrLine = input.onChildStderrLine;
          if (preparation.compatChildMarker && input.expertSessionSpawn?.nativeCompat) {
            const bridge = input.expertSessionSpawn.nativeCompat;
            input.onChildStderrLine?.(
              `${bridge.expectedMarker} ${JSON.stringify({ type: "ready", kind: bridge.kind })}`,
            );
          } else if (preparation.compatChildMarker) {
            input.onChildStderrLine?.(
              "SYNARA_OMP_ACP_IDLE_TASK_COMPAT v2 sha256=c5d51fbb4d787035f3cec7b3579234de4c55b169574a094e2a672bb68970992d",
            );
          }
          return {
            sessionId: input.resumeSessionId ?? "native-fixed",
            sessionSetupMethod: input.resumeSessionId ? "resume" : "new",
            initializeResult: { protocolVersion: 1, agentCapabilities: {} },
            sessionSetupResult: { sessionId: "native-fixed" },
            modelConfigId: undefined,
          };
        }),
      awaitExit: Effect.never,
      getEvents: () =>
        Stream.callback((queue) =>
          Effect.sync(() => {
            preparation.acpEventEmitter = (event: unknown) => {
              preparation.queuedAcpEvents++;
              Queue.offerUnsafe(queue, event as never);
            };
          }),
        ),
      sessionUpdatesEnqueuedCount: Effect.sync(() => preparation.queuedAcpEvents),
      getModeState: Effect.succeed(undefined),
      getConfigOptions: Effect.succeed([]),
      awaitLoadReplayReady: Effect.void,
      getAvailableCommands: Effect.succeed([
        { name: "advisor", description: "Unselected native advisor" },
        { name: "ambient-c" },
      ]),
      supportsSessionRecovery: Effect.succeed(true),
      supportsSessionFork: Effect.succeed(false),
      cancel: Effect.void,
      prompt: (input: unknown) =>
        Effect.gen(function* () {
          preparation.prompts++;
          preparation.promptInputs.push(input);
          if (typeof preparation.promptScenario === "function") {
            yield* (preparation.promptScenario as () => Effect.Effect<void>)();
          }
          return { stopReason: "end_turn" };
        }),
    });
  },
}));
vi.mock("../acp/OmpAcpIdleTaskCompat.ts", async (original) => ({
  ...(await original<typeof import("../acp/OmpAcpIdleTaskCompat.ts")>()),
  OMP_ACP_IDLE_TASK_COMPAT_MARKER_TIMEOUT_MS: 5,
  prepareOmpAcpIdleTaskCompat: async () => {
    preparation.compatPreparations++;
    return {
      bunExecutable: "/bin/bun",
      cliEntrypoint: "/bin/omp/cli.js",
      preloadPath: "/private/omp-fixed-test/compat.mjs",
      expectedMarker:
        "SYNARA_OMP_ACP_IDLE_TASK_COMPAT v2 sha256=c5d51fbb4d787035f3cec7b3579234de4c55b169574a094e2a672bb68970992d",
    };
  },
}));
vi.mock("../acp/OmpNativeCompat.ts", async (original) => ({
  ...(await original<typeof import("../acp/OmpNativeCompat.ts")>()),
  prepareOmpNativeCompat: async () => {
    preparation.nativePreparations++;
    return {
      kind: "fixed" as const,
      extensionPath: "/private/omp-fixed-test/native.mjs",
      expectedMarker: "SYNARA_OMP_NATIVE_COMPAT v1 nonce=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    };
  },
}));
import { makeOmpAdapterLive } from "./OmpAdapter";

describe("OMP adapter fixed Skill admission", () => {
  it.each([false, true])(
    "rejects unverifiable native preparation before spawning ACP (empty=%s)",
    async (empty) => {
      preparation.calls.length = 0;
      preparation.reject = true;
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-fixed-adapter-"));
      let spawned = 0;
      const spawner = ChildProcessSpawner.make(() => {
        spawned++;
        return Effect.die(new Error("ACP must not spawn before fixed Skill verification"));
      });
      const layer = makeOmpAdapterLive({ binaryPath: process.execPath }).pipe(
        Layer.provideMerge(ServerConfig.layerTest(root, path.join(root, "state"))),
        Layer.provideMerge(NodeServices.layer),
        Layer.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner)),
      );
      try {
        await Effect.runPromise(
          Effect.gen(function* () {
            const adapter = yield* OmpAdapter;
            const threadId = ThreadId.makeUnsafe("omp-fixed-rejected");
            const outcome = yield* Effect.result(
              adapter.startSession({
                threadId,
                provider: "omp",
                cwd: root,
                runtimeMode: "full-access",
                lifecycleGeneration: "fixed-generation",
                expertSession: {
                  snapshotId: `exp_${"a".repeat(64)}`,
                  persona: "Fixed Expert",
                  skills: empty ? [] : [{ name: "selected", path: path.join(root, "SKILL.md") }],
                  skillEntries: [],
                  skillLoading: "index",
                  skillPolicy: FIXED_EXPERT_SKILL_POLICY,
                  references: [],
                },
              }),
            );
            expect(outcome._tag).toBe("Failure");
            expect(yield* adapter.hasSession(threadId)).toBe(false);
          }).pipe(Effect.provide(layer), Effect.scoped),
        );
        expect(preparation.calls).toHaveLength(1);
        expect(spawned).toBe(0);
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    },
  );
  it.each([false, true])(
    "blocks advisor toggles/reloads before ACP and keeps command discovery fixed after recovery=%s",
    async (resume) => {
      preparation.reject = false;
      preparation.reloadChanged = false;
      preparation.runtimeCreations = 0;
      preparation.prompts = 0;
      preparation.promptInputs.length = 0;
      preparation.compatChildMarker = true;
      preparation.resolveCalls.length = 0;
      preparation.compatPreparations = 0;
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-fixed-runtime-")),
        file = path.join(root, "SKILL.md"),
        bytes = Buffer.from(
          "---\nname: selected\ndescription: Selected only\n---\nInstructions.\n",
        );
      await fs.writeFile(file, bytes);
      const session: ProviderExpertSession = {
        snapshotId: `exp_${"b".repeat(64)}`,
        persona: "Fixed Expert",
        skills: [{ name: "selected", path: file }],
        skillEntries: [
          {
            name: "selected",
            path: file,
            description: "Selected only",
            packageId: `pkg_${"c".repeat(64)}`,
            entryPath: "SKILL.md",

            sha256: createHash("sha256").update(bytes).digest("hex"),
          },
        ],
        skillLoading: "index",
        skillPolicy: FIXED_EXPERT_SKILL_POLICY,
        references: [],
      };
      const spawner = ChildProcessSpawner.make(() =>
        Effect.die("The mocked ACP seam owns this test; discovery must not spawn another process"),
      );
      const layer = makeOmpAdapterLive({ binaryPath: process.execPath }).pipe(
        Layer.provideMerge(ServerConfig.layerTest(root, path.join(root, "state"))),
        Layer.provideMerge(NodeServices.layer),
        Layer.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner)),
      );
      try {
        await Effect.runPromise(
          Effect.gen(function* () {
            const adapter = yield* OmpAdapter,
              threadId = ThreadId.makeUnsafe("omp-fixed-live");
            const started = yield* adapter.startSession({
              threadId,
              provider: "omp",
              cwd: root,
              runtimeMode: "full-access",
              lifecycleGeneration: "fixed-live-generation",
              expertSession: session,
              providerOptions: { omp: { environment: { PATH: "/selected/omp-account-bin" } } },
              ...(resume ? { resumeCursor: { schemaVersion: 1, sessionId: "native-prior" } } : {}),
            });
            expect(started.skillApplication?.enforcement).toBe("native-fixed");
            expect(preparation.spawnInputs.at(-1)).toMatchObject({
              expertSessionSpawn: {
                disableExtensions: true,
                idleTaskCompat: {
                  bunExecutable: "/bin/bun",
                  cliEntrypoint: "/bin/omp/cli.js",
                  preloadPath: "/private/omp-fixed-test/compat.mjs",
                },
              },
            });
            const resolvedPaths = preparation.resolveCalls.filter(
              (call) => call.binaryPath === process.execPath,
            );
            expect(resolvedPaths.length).toBeGreaterThan(0);
            expect(
              resolvedPaths.every((call) => {
                const options = call.options as
                  | { cwd?: string; env?: NodeJS.ProcessEnv }
                  | undefined;
                return options?.cwd === root && options.env?.PATH === "/selected/omp-account-bin";
              }),
            ).toBe(true);
            expect(preparation.compatPreparations).toBe(1);
            const commands = yield* adapter.listCommands!({ provider: "omp", cwd: root, threadId });
            expect(commands.commands).toEqual([]);
            expect(preparation.runtimeCreations).toBe(1);
            for (const input of [
              "/advisor",
              "/advisor:on",
              "/advisor off",
              "/reload",
              "/reload:skills",
              "/ambient-c",
              "/skill:ambient-c",
            ]) {
              const result = yield* Effect.result(adapter.sendTurn({ threadId, input }));
              expect(result._tag).toBe("Failure");
            }
            const rejectedFork = yield* adapter.forkThread!({
              threadId: ThreadId.makeUnsafe("omp-fixed-fork"),
              sourceThreadId: ThreadId.makeUnsafe("stopped-source"),
              cwd: root,
              runtimeMode: "full-access",
              expertSession: session,
              lifecycleGeneration: "fork-generation",
            }).pipe(Effect.flip);
            expect(rejectedFork.message).toMatch(/inherited fixed Skill/u);
            expect(preparation.runtimeCreations).toBe(1);
            preparation.reloadChanged = true;
            expect(
              (yield* Effect.result(adapter.sendTurn({ threadId, input: "Continue" })))._tag,
            ).toBe("Failure");
            expect(preparation.prompts).toBe(0);
            preparation.reloadChanged = false;
            const chipResult = yield* Effect.result(
              adapter.sendTurn({
                threadId,
                input: "Use the selected workflow.",
                skills: [
                  {
                    name: "selected",
                    path: "/untrusted/renderer/path",
                    expert: {
                      snapshotId: session.snapshotId,
                      packageId: session.skillEntries![0]!.packageId,
                      entryPath: session.skillEntries![0]!.entryPath,
                    },
                  },
                ],
              }),
            );
            expect(chipResult._tag).toBe("Success");
            yield* Effect.promise(() =>
              vi.waitFor(() => expect(preparation.prompts).toBe(1), { timeout: 3_000 }),
            );
            expect(preparation.prompts).toBe(1);
            expect(JSON.stringify(preparation.promptInputs[0])).toContain(
              "<selected_skill_references>",
            );
            expect(JSON.stringify(preparation.promptInputs[0])).toContain(file);
            expect(JSON.stringify(preparation.promptInputs[0])).not.toContain(
              "/untrusted/renderer/path",
            );
            yield* adapter.stopSession(threadId);
            expect(yield* adapter.hasSession(threadId)).toBe(false);
          }).pipe(Effect.provide(layer), Effect.scoped),
        );
      } finally {
        preparation.reject = true;
        await fs.rm(root, { recursive: true, force: true });
      }
    },
  );

  it.each(["legacy", "context"] as const)(
    "keeps ordinary expert preparation lookup for %s sessions",
    async (kind) => {
      preparation.reject = false;
      preparation.resolveCalls.length = 0;
      preparation.compatPreparations = 0;
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-noninherited-path-"));
      const spawner = ChildProcessSpawner.make(() =>
        Effect.die("The mocked ACP seam owns this test; no process should spawn"),
      );
      const layer = makeOmpAdapterLive({ binaryPath: process.execPath }).pipe(
        Layer.provideMerge(ServerConfig.layerTest(root, path.join(root, "state"))),
        Layer.provideMerge(NodeServices.layer),
        Layer.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner)),
      );
      try {
        await Effect.runPromise(
          Effect.gen(function* () {
            const adapter = yield* OmpAdapter;
            const threadId = ThreadId.makeUnsafe(`omp-noninherited-${kind}`);
            yield* adapter.startSession(
              kind === "legacy"
                ? {
                    threadId,
                    provider: "omp",
                    cwd: root,
                    runtimeMode: "full-access",
                    lifecycleGeneration: "legacy-fixed-generation",
                    expertSession: {
                      snapshotId: `exp_${"f".repeat(64)}`,
                      persona: "Legacy Fixed Expert",
                      skills: [],
                      skillEntries: [],
                      skillLoading: "index",
                      skillPolicy: {
                        version: 1,
                        discovery: "fixed",
                        nativeSubagents: "blocked",
                      },
                      references: [],
                    },
                  }
                : {
                    threadId,
                    provider: "omp",
                    cwd: root,
                    runtimeMode: "full-access",
                    contextSession: {
                      snapshotId: "context-snapshot",
                      snapshotHash: "a".repeat(64),
                      text: "Project context",
                      hasContent: true,
                    },
                  },
            );

            expect(preparation.resolveCalls).toHaveLength(1);
            expect(preparation.resolveCalls[0]?.options).toBeUndefined();
            expect(preparation.compatPreparations).toBe(0);
            yield* adapter.stopSession(threadId);
          }).pipe(Effect.provide(layer), Effect.scoped),
        );
      } finally {
        preparation.reject = true;
        await fs.rm(root, { recursive: true, force: true });
      }
    },
  );

  it("prepares the exact OMP compatibility for captured learning without native task inheritance", async () => {
    preparation.reject = false;
    preparation.reloadChanged = false;
    preparation.compatChildMarker = true;
    preparation.resolveCalls.length = 0;
    preparation.compatPreparations = 0;
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-learning-permission-"));
    const spawner = ChildProcessSpawner.make(() =>
      Effect.die("The mocked ACP seam owns this test; CLI probing must stay mocked"),
    );
    const gatewayCredentials = {
      connectionForThread: () => ({ url: "http://127.0.0.1:1/mcp", bearerToken: "test-token" }),
      revokeSessionToken: () => undefined,
      stdioProxy: { command: process.execPath, args: [] },
    } as unknown as AgentGatewayCredentialsShape;
    const layer = makeOmpAdapterLive({ binaryPath: process.execPath }).pipe(
      Layer.provideMerge(ServerConfig.layerTest(root, path.join(root, "state"))),
      Layer.provideMerge(NodeServices.layer),
      Layer.provideMerge(Layer.succeed(AgentGatewayCredentials, gatewayCredentials)),
      Layer.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner)),
    );
    const session: ProviderExpertSession = {
      snapshotId: `exp_${"a".repeat(64)}`,
      persona: "Learning Expert",
      skills: [],
      skillEntries: [],
      skillLoading: "index",
      skillPolicy: { version: 1, discovery: "fixed", nativeSubagents: "blocked" },
      knowledge: {
        manifestId: "manifest-1",
        rootRunId: "root-run-1",
        snapshotId: "snapshot-1",
        scope: {
          ownerId: "owner-1",
          spaceId: null,
          expertId: "expert-1",
          projectId: "project-1",
        },
        knowledgeHash: `sha256:${"b".repeat(64)}`,
        learningEpoch: 2,
      },
      references: [],
    };

    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const adapter = yield* OmpAdapter;
          const threadId = ThreadId.makeUnsafe("omp-learning-compat");
          yield* adapter.startSession({
            threadId,
            provider: "omp",
            cwd: root,
            runtimeMode: "approval-required",
            lifecycleGeneration: "learning-compat-generation",
            expertSession: session,
            providerOptions: { omp: { environment: { PATH: "/selected/omp-account-bin" } } },
          });

          expect(preparation.compatPreparations).toBe(1);
          expect(preparation.spawnInputs.at(-1)).toMatchObject({
            expertSessionSpawn: {
              idleTaskCompat: {
                bunExecutable: "/bin/bun",
                cliEntrypoint: "/bin/omp/cli.js",
                preloadPath: "/private/omp-fixed-test/compat.mjs",
              },
            },
          });
          expect(preparation.resolveCalls.length).toBeGreaterThan(0);
          expect(
            preparation.resolveCalls.every((call) => {
              const options = call.options as { cwd?: string; env?: NodeJS.ProcessEnv } | undefined;
              return options?.cwd === root && options.env?.PATH === "/selected/omp-account-bin";
            }),
          ).toBe(true);
          yield* adapter.stopSession(threadId);
        }).pipe(Effect.provide(layer), Effect.scoped),
      );
    } finally {
      preparation.reject = true;
      preparation.compatChildMarker = true;
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("joins public bridge permission names whether stderr arrives before or after ACP permission", async () => {
    preparation.reject = false;
    preparation.reloadChanged = false;
    preparation.cliVersion = "18.16.0";
    preparation.compatChildMarker = true;
    preparation.nativePreparations = 0;
    preparation.permissionHandler = undefined;
    preparation.childStderrLine = undefined;
    preparation.promptScenario = undefined;
    preparation.permissionResults.length = 0;
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-learning-native-bridge-"));
    const spawner = ChildProcessSpawner.make(() =>
      Effect.die(new Error("The mocked ACP seam owns this test; CLI probing must stay mocked")),
    );
    const gatewayCredentials = {
      connectionForThread: () => ({ url: "http://127.0.0.1:1/mcp", bearerToken: "test-token" }),
      revokeSessionToken: () => undefined,
      stdioProxy: { command: process.execPath, args: [] },
    } as unknown as AgentGatewayCredentialsShape;
    const layer = makeOmpAdapterLive({ binaryPath: process.execPath }).pipe(
      Layer.provideMerge(ServerConfig.layerTest(root, path.join(root, "state"))),
      Layer.provideMerge(NodeServices.layer),
      Layer.provideMerge(Layer.succeed(AgentGatewayCredentials, gatewayCredentials)),
      Layer.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner)),
    );
    const session: ProviderExpertSession = {
      snapshotId: `exp_${"c".repeat(64)}`,
      persona: "Learning Expert",
      skills: [],
      skillEntries: [],
      skillLoading: "index",
      skillPolicy: { version: 1, discovery: "fixed", nativeSubagents: "blocked" },
      knowledge: {
        manifestId: "manifest-native",
        rootRunId: "root-run-native",
        snapshotId: "snapshot-native",
        scope: {
          ownerId: "owner-native",
          spaceId: null,
          expertId: "expert-native",
          projectId: "project-native",
        },
        knowledgeHash: `sha256:${"d".repeat(64)}`,
        learningEpoch: 3,
      },
      references: [],
    };

    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const adapter = yield* OmpAdapter;
          const threadId = ThreadId.makeUnsafe("omp-learning-native-bridge");
          yield* adapter.startSession({
            threadId,
            provider: "omp",
            cwd: root,
            runtimeMode: "approval-required",
            lifecycleGeneration: "learning-native-bridge-generation",
            expertSession: session,
          });
          expect(preparation.nativePreparations).toBe(1);
          expect(preparation.spawnInputs.at(-1)).toMatchObject({
            expertSessionSpawn: {
              nativeCompat: { kind: "fixed", expectedMarker: expect.stringMatching(/nonce=/u) },
            },
          });

          preparation.promptScenario = () =>
            Effect.gen(function* () {
              const bridge = preparation.spawnInputs.at(-1) as {
                expertSessionSpawn: { nativeCompat: { expectedMarker: string } };
              };
              const marker = bridge.expertSessionSpawn.nativeCompat.expectedMarker;
              const emitStderr = preparation.childStderrLine as (line: string) => void;
              const requestPermission = preparation.permissionHandler as (
                params: unknown,
              ) => Effect.Effect<unknown>;
              const approvalLine = (toolCallId: string, toolName: string) =>
                emitStderr(
                  `${marker} ${JSON.stringify({ type: "approval", toolCallId, toolName })}`,
                );

              approvalLine("stderr-first", "synara_learning_commit");
              const immediate = yield* requestPermission(
                makeNativeLearningPermissionRequest("stderr-first"),
              );
              const waiting = yield* Effect.forkChild(
                requestPermission(makeNativeLearningPermissionRequest("permission-first")),
              );
              yield* Effect.sleep("25 millis");
              approvalLine("permission-first", "synara_learning_read");
              const joined = yield* Fiber.join(waiting);
              preparation.permissionResults.push(immediate, joined);
            });

          const turn = yield* Effect.result(
            adapter
              .sendTurn({
                threadId,
                input: "Read and commit the captured learning candidate.",
                interactionMode: "default",
              })
              .pipe(Effect.timeout("3 seconds")),
          );
          expect(turn._tag).toBe("Success");
          yield* Effect.promise(() =>
            vi.waitFor(() => expect(preparation.permissionResults).toHaveLength(2), {
              timeout: 3_000,
            }),
          );
          expect(preparation.permissionResults).toEqual([
            { outcome: { outcome: "selected", optionId: "allow-once" } },
            { outcome: { outcome: "selected", optionId: "allow-once" } },
          ]);
          yield* adapter.stopSession(threadId);
        }).pipe(Effect.provide(layer), Effect.scoped),
      );
    } finally {
      preparation.reject = true;
      preparation.cliVersion = undefined;
      preparation.compatChildMarker = true;
      preparation.permissionHandler = undefined;
      preparation.childStderrLine = undefined;
      preparation.promptScenario = undefined;
      preparation.permissionResults.length = 0;
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("attributes a native idle task completion to its original turn after the prompt settles", async () => {
    preparation.reject = false;
    preparation.reloadChanged = false;
    preparation.cliVersion = "18.16.0";
    preparation.compatChildMarker = true;
    preparation.nativePreparations = 0;
    preparation.acpEventEmitter = undefined;
    preparation.queuedAcpEvents = 0;
    preparation.childStderrLine = undefined;
    preparation.promptScenario = undefined;
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-native-idle-task-"));
    const spawner = ChildProcessSpawner.make(() =>
      Effect.die(new Error("The mocked ACP seam owns this test; CLI probing must stay mocked")),
    );
    const layer = makeOmpAdapterLive({ binaryPath: process.execPath }).pipe(
      Layer.provideMerge(ServerConfig.layerTest(root, path.join(root, "state"))),
      Layer.provideMerge(NodeServices.layer),
      Layer.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner)),
    );
    const session: ProviderExpertSession = {
      snapshotId: `exp_${"e".repeat(64)}`,
      persona: "Fixed Expert with inherited native tasks",
      skills: [],
      skillEntries: [],
      skillLoading: "index",
      skillPolicy: FIXED_EXPERT_SKILL_POLICY,
      references: [],
    };
    const runtimeEvents: Array<{
      type: string;
      turnId?: unknown;
      payload?: Record<string, unknown>;
    }> = [];
    const toolCallId = "native-idle-task-1";

    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const adapter = yield* OmpAdapter;
          const threadId = ThreadId.makeUnsafe("omp-native-idle-task");
          yield* adapter.startSession({
            threadId,
            provider: "omp",
            cwd: root,
            runtimeMode: "full-access",
            lifecycleGeneration: "native-idle-task-generation",
            expertSession: session,
          });
          expect(preparation.nativePreparations).toBe(1);

          yield* adapter.streamEvents.pipe(
            Stream.runForEach((event) =>
              Effect.sync(() =>
                runtimeEvents.push({
                  type: event.type,
                  ...(event.turnId !== undefined ? { turnId: event.turnId } : {}),
                  ...(event.payload !== undefined
                    ? { payload: event.payload as Record<string, unknown> }
                    : {}),
                }),
              ),
            ),
            Effect.forkChild,
          );
          yield* Effect.promise(() =>
            vi.waitFor(() => expect(typeof preparation.acpEventEmitter).toBe("function")),
          );

          preparation.promptScenario = () =>
            Effect.gen(function* () {
              const emitAcpEvent = preparation.acpEventEmitter as (event: unknown) => void;
              const bridge = preparation.spawnInputs.at(-1) as {
                expertSessionSpawn: { nativeCompat: { expectedMarker: string } };
              };
              const emitStderr = preparation.childStderrLine as (line: string) => void;
              emitStderr(
                `${bridge.expertSessionSpawn.nativeCompat.expectedMarker} ${JSON.stringify({
                  type: "task",
                  toolCallId,
                  toolName: "task",
                  args: { subagent_type: "worker" },
                  partialResult: {
                    details: { async: { type: "task", jobId: "job-1", state: "running" } },
                  },
                })}`,
              );
              // Allow the stderr consumer to observe the event before stdout
              // delivers the ACP Task row that establishes its turn owner.
              yield* Effect.sleep("10 millis");
              emitAcpEvent({
                _tag: "ToolCallUpdated",
                toolCall: {
                  toolCallId,
                  kind: "other",
                  title: "Task",
                  status: "inProgress",
                  data: { rawInput: { subagent_type: "worker" } },
                },
                rawPayload: {
                  sessionUpdate: "tool_call",
                  toolCallId,
                  title: "Task",
                },
              });
            });

          const turn = yield* adapter.sendTurn({
            threadId,
            input: "Delegate the fixed skill check.",
            interactionMode: "default",
          });
          yield* Effect.promise(() =>
            vi.waitFor(() =>
              expect(
                runtimeEvents.some(
                  (event) =>
                    event.type === "turn.completed" && String(event.turnId) === String(turn.turnId),
                ),
              ).toBe(true),
            ),
          );
          expect(
            runtimeEvents.some(
              (event) =>
                event.type === "task.started" && String(event.turnId) === String(turn.turnId),
            ),
          ).toBe(true);

          const bridge = preparation.spawnInputs.at(-1) as {
            expertSessionSpawn: { nativeCompat: { expectedMarker: string } };
          };
          const emitStderr = preparation.childStderrLine as (line: string) => void;
          emitStderr(
            `${bridge.expertSessionSpawn.nativeCompat.expectedMarker} ${JSON.stringify({
              type: "task",
              toolCallId,
              toolName: "task",
              args: { subagent_type: "worker" },
              partialResult: {
                details: { async: { type: "task", jobId: "job-1", state: "completed" } },
              },
            })}`,
          );
          yield* Effect.promise(() =>
            vi.waitFor(() =>
              expect(
                runtimeEvents.some(
                  (event) =>
                    event.type === "task.completed" && String(event.turnId) === String(turn.turnId),
                ),
              ).toBe(true),
            ),
          );
          const completion = runtimeEvents.find((event) => event.type === "task.completed");
          expect(completion).toMatchObject({
            turnId: turn.turnId,
            payload: { status: "completed", taskId: toolCallId },
          });
          yield* adapter.stopSession(threadId);
        }).pipe(Effect.provide(layer), Effect.scoped),
      );
    } finally {
      preparation.reject = true;
      preparation.cliVersion = undefined;
      preparation.compatChildMarker = true;
      preparation.acpEventEmitter = undefined;
      preparation.queuedAcpEvents = 0;
      preparation.childStderrLine = undefined;
      preparation.promptScenario = undefined;
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("fails fixed inherited-task startup when the actual ACP child omits the compatibility marker", async () => {
    preparation.reject = false;
    preparation.reloadChanged = false;
    preparation.compatChildMarker = false;
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-fixed-marker-"));
    const file = path.join(root, "SKILL.md");
    await fs.writeFile(
      file,
      "---\nname: selected\ndescription: Selected only\n---\nInstructions.\n",
    );
    const spawner = ChildProcessSpawner.make(() =>
      Effect.die(new Error("The mocked ACP seam owns this test; CLI probing must stay mocked")),
    );
    const layer = makeOmpAdapterLive({ binaryPath: process.execPath }).pipe(
      Layer.provideMerge(ServerConfig.layerTest(root, path.join(root, "state"))),
      Layer.provideMerge(NodeServices.layer),
      Layer.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner)),
    );
    const session: ProviderExpertSession = {
      snapshotId: `exp_${"d".repeat(64)}`,
      persona: "Fixed Expert",
      skills: [{ name: "selected", path: file }],
      skillEntries: [
        {
          name: "selected",
          path: file,
          description: "Selected only",
          packageId: `pkg_${"e".repeat(64)}`,
          entryPath: "SKILL.md",

          sha256: createHash("sha256")
            .update(await fs.readFile(file))
            .digest("hex"),
        },
      ],
      skillLoading: "index",
      skillPolicy: FIXED_EXPERT_SKILL_POLICY,
      references: [],
    };
    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const adapter = yield* OmpAdapter;
          const outcome = yield* Effect.result(
            adapter.startSession({
              threadId: ThreadId.makeUnsafe("omp-fixed-missing-marker"),
              provider: "omp",
              cwd: root,
              runtimeMode: "full-access",
              lifecycleGeneration: "fixed-marker-generation",
              expertSession: session,
            }),
          );
          expect(outcome._tag).toBe("Failure");
          if (outcome._tag === "Failure") {
            expect(String(outcome.failure)).toContain("marker was missing");
          }
        }).pipe(Effect.provide(layer), Effect.scoped),
      );
    } finally {
      preparation.compatChildMarker = true;
      preparation.reject = true;
      await fs.rm(root, { recursive: true, force: true });
    }
  });
  it.each([
    { version: "18.16.0", ready: true },
    { version: "19.0.0", ready: true },
    { version: "18.16.0", ready: false },
  ])(
    "admits newer CLI $version only with actual public bridge readiness ($ready)",
    async ({ version, ready }) => {
      preparation.reject = false;
      preparation.reloadChanged = false;
      preparation.cliVersion = version;
      preparation.compatChildMarker = ready;
      const legacyBefore = preparation.compatPreparations;
      const nativeBefore = preparation.nativePreparations;
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-public-contract-"));
      const spawner = ChildProcessSpawner.make(() =>
        Effect.die(new Error("Unexpected real CLI spawn")),
      );
      const layer = makeOmpAdapterLive({ binaryPath: process.execPath }).pipe(
        Layer.provideMerge(ServerConfig.layerTest(root, path.join(root, "state"))),
        Layer.provideMerge(NodeServices.layer),
        Layer.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner)),
      );
      try {
        await Effect.runPromise(
          Effect.gen(function* () {
            const adapter = yield* OmpAdapter;
            const outcome = yield* Effect.result(
              adapter.startSession({
                threadId: ThreadId.makeUnsafe("omp-newer-capability"),
                provider: "omp",
                cwd: root,
                runtimeMode: "full-access",
                lifecycleGeneration: "public-capability-generation",
                expertSession: {
                  snapshotId: `exp_${"a".repeat(64)}`,
                  persona: "Empty fixed Expert",
                  skills: [],
                  skillEntries: [],
                  skillLoading: "index",
                  skillPolicy: FIXED_EXPERT_SKILL_POLICY,
                  references: [],
                },
              }),
            );
            expect(outcome._tag).toBe(ready ? "Success" : "Failure");
            if (outcome._tag === "Failure")
              expect(String(outcome.failure)).toContain("required public extension capabilities");
            expect(preparation.compatPreparations).toBe(legacyBefore);
            expect(preparation.nativePreparations).toBe(nativeBefore + 1);
          }).pipe(Effect.provide(layer), Effect.scoped),
        );
      } finally {
        preparation.cliVersion = undefined;
        preparation.compatChildMarker = true;
        preparation.reject = true;
        await fs.rm(root, { recursive: true, force: true });
      }
    },
  );
});
