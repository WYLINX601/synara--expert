import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ThreadId } from "@synara/contracts";
import { OMP_NATIVE_EXPERT_METHODS } from "@synara/contracts/omp/expertDelegation";
import { Deferred, Effect, Exit, Fiber, Layer, Scope } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import { describe, expect, it, vi } from "vitest";
import { ServerConfig } from "../../config";
import { spawnProviderProcess } from "../../platform/effectProcessRuntime";
import { teardownAcpChildProcess } from "../acp/AcpSessionRuntime";
import { makeFakeAcpSessionRuntime } from "../acp/testing/fakeAcpSessionRuntime";
import type { OmpNativeExpertProtocolFactory } from "../acp/OmpNativeExpertProtocol";

const runtime = vi.hoisted(() => ({
  make: undefined as (() => unknown) | undefined,
}));
vi.mock("../acp/OmpAcpSupport.ts", async (original) => ({
  ...(await original<typeof import("../acp/OmpAcpSupport.ts")>()),
  makeOmpAcpRuntime: () => runtime.make!(),
}));
import { makeOmpAdapter } from "./OmpAdapter";

describe("OMP native parent teardown", () => {
  it.each(
    (["cancel", "query"] as const).flatMap((blockedMethod) =>
      (["stop", "replacement", "shutdown"] as const).map((trigger) => ({ blockedMethod, trigger })),
    ),
  )(
    "releases $trigger and replacement admission while a native $blockedMethod reply is withheld",
    async ({ blockedMethod, trigger }) => {
      const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-native-stop-"));
      const binaryPath = path.join(directory, "omp");
      const bytes = Buffer.from("test-owned native build provenance");
      await fs.writeFile(binaryPath, bytes);
      const release = Effect.runSync(Deferred.make<void>());
      const entered = Effect.runSync(Deferred.make<void>());
      let cancel: (() => Promise<void>) | undefined;
      let cancelled: Promise<void> | undefined;
      let request: Parameters<OmpNativeExpertProtocolFactory>[0]["request"] | undefined;
      let finalized = 0;
      let created = 0;
      const children: ChildProcessSpawner.ChildProcessHandle[] = [];
      const sessionScope = Effect.runSync(Scope.make());
      const factory: OmpNativeExpertProtocolFactory = async (context) => {
        request = context.request;
        cancel = () =>
          context
            .request(OMP_NATIVE_EXPERT_METHODS.cancel, {})
            .then(() => context.request(OMP_NATIVE_EXPERT_METHODS.query, {}))
            .then(() => undefined);
        return {
          agentDirectory: directory,
          targetAgentNames: ["author"],
          bindSession: async () => undefined,
          preparePrompt: async ({ parentTurnId }) => ({
            parentGeneration: context.generation,
            parentTurnId,
            targetAgentNames: ["author"],
          }),
          handleRequest: async () => {
            throw new Error("No task ingress is expected in this lifecycle regression.");
          },
          cancelTask: async () => {
            await cancelled;
          },
          close: async () => undefined,
        };
      };
      runtime.make = () =>
        Effect.gen(function* () {
          const number = ++created;
          const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
          // A real idle child keeps the platform process-tree proof exercised;
          // its interval only holds liveness, never synchronizes an assertion.
          const child = yield* spawnProviderProcess(spawner, process.execPath, [
            "-e",
            "setInterval(() => {}, 2 ** 30)",
          ]);
          children.push(child);
          yield* Effect.addFinalizer(() =>
            teardownAcpChildProcess(child).pipe(
              Effect.andThen(
                Effect.sync(() => {
                  finalized += 1;
                }),
              ),
            ),
          );
          return {
            ...makeFakeAcpSessionRuntime({ sessionId: `actual-session-${number}` }),
            request: (method: string) => {
              if (method === OMP_NATIVE_EXPERT_METHODS.capabilities)
                return Effect.succeed({
                  protocolVersion: 1,
                  buildFingerprint: "a".repeat(64),
                  targetProfiles: true,
                  lifecycle: true,
                });
              if (method === OMP_NATIVE_EXPERT_METHODS[blockedMethod])
                return Deferred.succeed(entered, undefined).pipe(
                  Effect.andThen(Deferred.await(release)),
                  Effect.as({ state: "not-found" }),
                );
              return Effect.succeed({ accepted: true });
            },
          };
        });
      try {
        await Effect.runPromise(
          Effect.gen(function* () {
            const adapter = yield* makeOmpAdapter(
              { binaryPath },
              {
                nativeExpertProtocolFactory: factory,
                nativeExpertBuilds: [
                  {
                    binarySha256: createHash("sha256").update(bytes).digest("hex"),
                    buildFingerprint: "a".repeat(64),
                  },
                ],
              },
            );
            const threadId = ThreadId.makeUnsafe(`native-stop-${blockedMethod}`);
            const input = {
              threadId,
              provider: "omp" as const,
              runtimeMode: "full-access" as const,
              lifecycleGeneration: "generation-1",
              cwd: directory,
            };
            yield* adapter.startSession(input);
            cancelled = cancel!();
            yield* Deferred.await(entered);
            const oldRequest = request!;
            // The test deadline is only an assertion budget, never the production fallback.
            // Release the peer in finally so even a failing-before stop can finish cleanup.
            const replacementInput = { ...input, lifecycleGeneration: "generation-2" };
            const operation =
              trigger === "replacement"
                ? adapter.startSession(replacementInput).pipe(Effect.asVoid)
                : trigger === "shutdown"
                  ? Scope.close(sessionScope, Exit.void)
                  : adapter.stopSession(threadId);
            const stopping = yield* operation.pipe(Effect.forkDetach);
            const stopped = yield* Fiber.join(stopping).pipe(Effect.timeoutOption("3 seconds"));
            expect(
              stopped._tag,
              "physical teardown must not depend on the withheld native reply",
            ).toBe("Some");
            expect(finalized).toBe(1);
            expect(yield* children[0]!.isRunning).toBe(false);
            yield* Effect.promise(() =>
              expect(oldRequest(OMP_NATIVE_EXPERT_METHODS.query, {})).rejects.toThrow(),
            );
            if (trigger === "replacement") {
              expect(yield* adapter.hasSession(threadId)).toBe(true);
              expect(yield* adapter.listSessions()).toHaveLength(1);
              expect(created).toBe(2);
            } else {
              expect(yield* adapter.hasSession(threadId)).toBe(false);
              expect(yield* adapter.listSessions()).toEqual([]);
            }
            if (trigger === "shutdown") return;
            if (trigger === "stop") {
              const replacement = yield* adapter.startSession(replacementInput);
              expect(replacement.threadId).toBe(threadId);
              expect(yield* adapter.hasSession(threadId)).toBe(true);
              expect(created).toBe(2);
            }
            yield* adapter.stopSession(threadId);
            expect(finalized).toBe(2);
            expect(yield* children[1]!.isRunning).toBe(false);
          }).pipe(
            Effect.provideService(Scope.Scope, sessionScope),
            Effect.provide(
              ServerConfig.layerTest(directory, { prefix: "omp-native-stop-config-" }).pipe(
                Layer.provide(NodeServices.layer),
              ),
            ),
            Effect.provide(NodeServices.layer),
          ),
        );
      } finally {
        Effect.runSync(Deferred.succeed(release, undefined));
        await cancelled?.catch(() => undefined);
        await Effect.runPromise(Scope.close(sessionScope, Exit.void));
        await fs.rm(directory, { recursive: true, force: true });
        runtime.make = undefined;
      }
    },
    15_000,
  );
});
