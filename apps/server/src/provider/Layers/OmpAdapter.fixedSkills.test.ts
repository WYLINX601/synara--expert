import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { FIXED_EXPERT_SKILL_POLICY, ThreadId, type ProviderExpertSession } from "@synara/contracts";
import { Effect, Layer, Stream } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import { describe, expect, it, vi } from "vitest";
import { ServerConfig } from "../../config";
import {
  AgentGatewayCredentials,
  type AgentGatewayCredentialsShape,
} from "../../agentGateway/Services/AgentGatewayCredentials.ts";
import { recordVerifiedNativeSkillAssembly } from "../expertSkillCatalog";
import { OmpAdapter } from "../Services/OmpAdapter";

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
    expertSessionSpawn?: { disableExtensions?: boolean };
    onChildStderrLine?: (line: string) => void;
  }) => {
    preparation.spawnInputs.push(input);
    preparation.runtimeCreations++;
    return Effect.succeed({
      handleRequestPermission: () => Effect.void,
      handleElicitation: () => Effect.void,
      start: () =>
        Effect.sync(() => {
          if (preparation.compatChildMarker) {
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
      getEvents: () => Stream.never,
      sessionUpdatesEnqueuedCount: Effect.succeed(0),
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
        Effect.sync(() => {
          preparation.prompts++;
          preparation.promptInputs.push(input);
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
});
