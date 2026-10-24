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
import { recordVerifiedNativeSkillAssembly } from "../expertSkillCatalog";
import { OmpAdapter } from "../Services/OmpAdapter";

const preparation = vi.hoisted(() => ({
  calls: [] as unknown[],
  reject: true,
  reloadChanged: false,
  runtimeCreations: 0,
  prompts: 0,
  spawnInputs: [] as unknown[],
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
        cleanup: () => Effect.void,
      });
    const session = (input as { expertSession: ProviderExpertSession }).expertSession;
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
  makeOmpAcpRuntime: (input: {
    resumeSessionId?: string;
    expertSessionSpawn?: { disableExtensions?: boolean };
  }) => {
    preparation.spawnInputs.push(input);
    preparation.runtimeCreations++;
    return Effect.succeed({
      handleRequestPermission: () => Effect.void,
      handleElicitation: () => Effect.void,
      start: () =>
        Effect.succeed({
          sessionId: input.resumeSessionId ?? "native-fixed",
          sessionSetupMethod: input.resumeSessionId ? "resume" : "new",
          initializeResult: { protocolVersion: 1, agentCapabilities: {} },
          sessionSetupResult: { sessionId: "native-fixed" },
          modelConfigId: undefined,
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
      prompt: () =>
        Effect.sync(() => {
          preparation.prompts++;
          return { stopReason: "end_turn" };
        }),
    });
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
            activation: "on-demand",
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
              ...(resume ? { resumeCursor: { schemaVersion: 1, sessionId: "native-prior" } } : {}),
            });
            expect(started.skillApplication?.enforcement).toBe("native-fixed");
            expect(preparation.spawnInputs.at(-1)).toMatchObject({
              expertSessionSpawn: { disableExtensions: true },
            });
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
});
