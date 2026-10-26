import { ApprovalRequestId, ThreadId, type ProviderRuntimeEvent } from "@synara/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as OfficialAcp from "@agentclientprotocol/sdk";
import type * as Acp from "@agentclientprotocol/sdk";
import { Effect, Layer, Option, Queue, Sink, Stream } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import { spawn, type ChildProcess } from "node:child_process";
import { describe, expect, it } from "vitest";

import { ServerConfig } from "../../config.ts";
import { ProviderAdapterRequestError, ProviderAdapterSessionNotFoundError } from "../Errors.ts";
import type { OmpAdapterShape } from "../Services/OmpAdapter.ts";
import { OmpAdapter } from "../Services/OmpAdapter.ts";
import { makeOmpAdapterLive } from "./OmpAdapter.ts";

type ElicitationOutcome =
  | { readonly _tag: "response"; readonly response: Acp.CreateElicitationResponse }
  | { readonly _tag: "rejected"; readonly error: unknown };

const childExitCode = (child: ChildProcess) =>
  Effect.promise(
    () =>
      new Promise<ChildProcessSpawner.ExitCode>((resolve) => {
        const finish = (code: number | null) => {
          child.off("exit", onExit);
          resolve(ChildProcessSpawner.ExitCode(code ?? 1));
        };
        const onExit = (code: number | null) => finish(code);
        child.once("exit", onExit);
        if (child.exitCode !== null || child.signalCode !== null) finish(child.exitCode);
      }),
  );

const stopTestChild = (child: ChildProcess) => {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const onExit = () => {
      clearTimeout(timeout);
      resolve();
    };
    const timeout = setTimeout(() => {
      child.off("exit", onExit);
      reject(new Error(`test-owned fake OMP child ${child.pid ?? "unknown"} did not exit`));
    }, 5_000);
    child.once("exit", onExit);
    if (child.exitCode !== null || child.signalCode !== null) onExit();
    else child.kill();
  });
};

const elicitation = (sessionId: string): Acp.CreateElicitationRequest => ({
  mode: "form",
  sessionId,
  message: "Choose an implementation approach.",
  requestedSchema: {
    type: "object",
    properties: {
      q0: {
        type: "string",
        title: "Which approach should we take?",
        description: "Approach",
        oneOf: [
          { const: "Choice", title: "Choice", description: "Keep the existing implementation." },
          {
            const: "Alternative",
            title: "Alternative",
            description: "Build a new implementation.",
          },
        ],
      },
      q0__other: { type: "string", title: "Other (type your own)" },
    },
  },
});

const withInMemoryOmp = <A>(
  run: (
    adapter: OmpAdapterShape,
    events: ProviderRuntimeEvent[],
    elicitationResponses: Queue.Queue<ElicitationOutcome>,
  ) => Effect.Effect<A, unknown, any>,
) => {
  const elicitationResponses = Effect.runSync(Queue.unbounded<ElicitationOutcome>());
  const connections: Array<{ close(error?: unknown): void }> = [];
  const testChildren: ChildProcess[] = [];
  const transportQueues: Array<{
    readonly clientToAgent: Queue.Queue<Uint8Array>;
    readonly agentToClient: Queue.Queue<Uint8Array>;
  }> = [];
  let sessionNumber = 0;

  const agentApp = OfficialAcp.agent({ name: "omp-elicitation-fixture" })
    .onRequest(OfficialAcp.methods.agent.initialize, () => ({
      protocolVersion: 1,
      agentInfo: { name: "omp-elicitation-fixture", version: "0.0.0" },
      agentCapabilities: {},
      authMethods: [{ id: "agent", name: "Agent authentication" }],
    }))
    .onRequest(OfficialAcp.methods.agent.authenticate, () => ({}))
    .onRequest(OfficialAcp.methods.agent.session.new, () => {
      sessionNumber += 1;
      return { sessionId: `fake-omp-session-${sessionNumber}` };
    })
    .onRequest(OfficialAcp.methods.agent.session.prompt, async ({ client, params }) => {
      try {
        const response = await client.request(
          OfficialAcp.methods.client.elicitation.create,
          elicitation(params.sessionId),
        );
        await Effect.runPromise(Queue.offer(elicitationResponses, { _tag: "response", response }));
        return { stopReason: "end_turn" };
      } catch (error) {
        await Effect.runPromise(Queue.offer(elicitationResponses, { _tag: "rejected", error }));
        throw error;
      }
    });

  const spawnerLayer = Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make(() =>
      Effect.sync(() => {
        let connection: ReturnType<typeof agentApp.connect> | undefined;
        const clientToAgent = Effect.runSync(Queue.unbounded<Uint8Array>());
        const agentToClient = Effect.runSync(Queue.unbounded<Uint8Array>());
        transportQueues.push({ clientToAgent, agentToClient });
        const testChild = spawn(process.execPath, ["-e", "setInterval(() => {}, 2 ** 30)"], {
          shell: false,
          stdio: "ignore",
          windowsHide: true,
        });
        testChildren.push(testChild);
        if (testChild.pid === undefined) {
          testChild.kill();
          throw new Error("failed to start test-owned fake OMP process handle");
        }
        const input = new ReadableStream<Uint8Array>({
          pull: (controller) =>
            Effect.runPromise(Queue.take(clientToAgent))
              .then((chunk) => {
                try {
                  controller.enqueue(chunk);
                } catch {
                  // The adapter can close this fake child's stream during teardown.
                }
              })
              .catch(() => undefined),
        });
        const output = new WritableStream<Uint8Array>({
          write: (chunk) =>
            Effect.runPromise(Queue.offer(agentToClient, chunk)).then(() => undefined),
        });
        connection = agentApp.connect(OfficialAcp.ndJsonStream(output, input));
        connections.push(connection);
        testChild.once("exit", (code, signal) => {
          connection?.close(
            new Error(`test-owned fake OMP child exited (${code ?? signal ?? "unknown"})`),
          );
        });
        testChild.once("error", (error) => connection?.close(error));
        return ChildProcessSpawner.makeHandle({
          // OMP teardown proves its process-tree lifecycle against this harmless
          // test-owned node child; ACP messages still travel only in memory.
          pid: ChildProcessSpawner.ProcessId(testChild.pid),
          exitCode: childExitCode(testChild),
          isRunning: Effect.sync(
            () => testChild.exitCode === null && testChild.signalCode === null,
          ),
          kill: () => Effect.sync(() => void testChild.kill()),
          stdin: Sink.forEach((chunk: Uint8Array) => Queue.offer(clientToAgent, chunk)),
          stdout: Stream.fromQueue(agentToClient),
          stderr: Stream.never,
          all: Stream.never,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.never,
        });
      }),
    ),
  );
  const configLayer = ServerConfig.layerTest(process.cwd(), {
    prefix: `synara-omp-elicitation-${crypto.randomUUID()}-`,
  }).pipe(Layer.provide(NodeServices.layer));
  const adapterLayer = makeOmpAdapterLive().pipe(
    Layer.provide(Layer.mergeAll(NodeServices.layer, configLayer, spawnerLayer)),
  );

  const program = Effect.scoped(
    Effect.gen(function* () {
      const adapter = yield* OmpAdapter;
      const events: ProviderRuntimeEvent[] = [];
      yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => {
          events.push(event);
        }),
      ).pipe(Effect.forkScoped);
      return yield* run(adapter, events, elicitationResponses);
    }).pipe(Effect.provide(adapterLayer)),
  );
  return Effect.runPromise(program as Effect.Effect<A, unknown, never>).finally(async () => {
    for (const connection of connections) connection.close();
    await Promise.all(testChildren.map(stopTestChild));
    await Promise.all([
      ...transportQueues.flatMap(({ clientToAgent, agentToClient }) => [
        Effect.runPromise(Queue.shutdown(clientToAgent)),
        Effect.runPromise(Queue.shutdown(agentToClient)),
      ]),
      Effect.runPromise(Queue.shutdown(elicitationResponses)),
    ]);
  });
};

const waitForEvent = (
  events: ProviderRuntimeEvent[],
  match: (event: ProviderRuntimeEvent) => boolean,
  timeoutMs: number,
  label: string,
) =>
  Effect.gen(function* () {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const hit = events.find(match);
      if (hit) return hit;
      yield* Effect.sleep(10);
    }
    return yield* Effect.fail(
      new Error(
        `timed out waiting for ${label}; seen: ${events.map((event) => event.type).join(", ")}`,
      ),
    );
  });

const takeElicitationResponse = (responses: Queue.Queue<ElicitationOutcome>, label: string) =>
  Effect.flatMap(Queue.take(responses).pipe(Effect.timeoutOption("5 seconds")), (result) =>
    Option.match(result, {
      onNone: () =>
        Effect.fail(new Error(`timed out waiting for ACP elicitation outcome: ${label}`)),
      onSome: Effect.succeed,
    }),
  );

const waitForUserInputRequest = (
  events: ProviderRuntimeEvent[],
  previousRequestIds: ReadonlyArray<string> = [],
) =>
  Effect.flatMap(
    waitForEvent(
      events,
      (event) =>
        event.type === "user-input.requested" &&
        !previousRequestIds.includes(event.requestId ?? ""),
      10_000,
      "OMP user-input.requested",
    ),
    (event) =>
      event.type === "user-input.requested"
        ? Effect.succeed(event)
        : Effect.fail(new Error("expected user-input.requested")),
  );

const startSession = (adapter: OmpAdapterShape, threadId: ThreadId, lifecycleGeneration: string) =>
  adapter.startSession({
    threadId,
    provider: "omp",
    cwd: "/tmp",
    runtimeMode: "full-access",
    approvalPolicy: "never",
    lifecycleGeneration,
  });

const sendTurn = (adapter: OmpAdapterShape, threadId: ThreadId, input: string) =>
  adapter.sendTurn({ threadId, input });

const requestIdString = (request: { readonly requestId?: string | undefined }) => {
  if (request.requestId === undefined) throw new Error("expected a requestId on user-input event");
  return request.requestId;
};
const responseId = (request: { readonly requestId?: string | undefined }) =>
  ApprovalRequestId.makeUnsafe(requestIdString(request));

describe("OmpAdapter ACP elicitation (in-memory official ACP agent)", () => {
  it("keeps a conflicting legacy answer retryable and resolves one canonical answer once", async () => {
    await withInMemoryOmp((adapter, events, elicitationResponses) =>
      Effect.gen(function* () {
        const threadId = ThreadId.makeUnsafe(crypto.randomUUID());
        yield* startSession(adapter, threadId, "elicitation-generation-1");
        const turn = yield* sendTurn(adapter, threadId, "Ask me to choose.");
        const request = yield* waitForUserInputRequest(events);

        expect(request.payload.questions).toEqual([
          {
            id: "q0",
            header: "Approach",
            question: "Which approach should we take?",
            options: [
              { label: "Choice", description: "Keep the existing implementation." },
              { label: "Alternative", description: "Build a new implementation." },
            ],
            multiSelect: false,
          },
        ]);

        const requestId = responseId(request);
        const invalid = yield* Effect.flip(
          adapter.respondToUserInput(threadId, requestId, {
            q0: "Choice",
            q0__other: "custom",
          }),
        );
        expect(invalid).toBeInstanceOf(ProviderAdapterRequestError);
        if (!(invalid instanceof ProviderAdapterRequestError)) {
          return yield* Effect.fail(invalid);
        }
        expect(invalid.detail).toContain("Conflicting OMP single-select answers for q0");
        expect(
          events.filter(
            (event) =>
              event.type === "user-input.resolved" && event.requestId === request.requestId,
          ),
        ).toHaveLength(0);

        const submit = () =>
          adapter.respondToUserInput(threadId, requestId, { q0: "Choice" }).pipe(
            Effect.match({
              onFailure: (error) => ({ _tag: "Failure" as const, error }),
              onSuccess: () => ({ _tag: "Success" as const }),
            }),
          );
        const concurrentSubmissions = yield* Effect.all([submit(), submit()], {
          concurrency: "unbounded",
        });
        expect(concurrentSubmissions.filter((outcome) => outcome._tag === "Success")).toHaveLength(
          1,
        );
        const rejectedDuplicate = concurrentSubmissions.find(
          (outcome) => outcome._tag === "Failure",
        );
        if (!rejectedDuplicate || rejectedDuplicate._tag !== "Failure") {
          return yield* Effect.fail(
            new Error("expected a concurrent duplicate response to reject"),
          );
        }
        expect(rejectedDuplicate.error).toBeInstanceOf(ProviderAdapterRequestError);

        const acceptedOutcome = yield* takeElicitationResponse(
          elicitationResponses,
          "accepted choice",
        );
        expect(acceptedOutcome).toEqual({
          _tag: "response",
          response: { action: "accept", content: { q0: "Choice" } },
        });

        const resolved = yield* waitForEvent(
          events,
          (event) => event.type === "user-input.resolved" && event.requestId === request.requestId,
          10_000,
          "user-input.resolved",
        );
        if (resolved.type !== "user-input.resolved") {
          return yield* Effect.fail(new Error("expected user-input.resolved"));
        }
        expect(resolved.payload.answers).toEqual({ q0: "Choice" });
        yield* Effect.sleep(20);
        expect(
          events.filter(
            (event) =>
              event.type === "user-input.resolved" && event.requestId === request.requestId,
          ),
        ).toHaveLength(1);

        yield* waitForEvent(
          events,
          (event) => event.type === "turn.completed" && event.turnId === turn.turnId,
          10_000,
          "turn completion",
        );
        yield* adapter.stopAll();
      }),
    );
  }, 30_000);

  it("cancels empty and stopped inputs, and fences an old request after restart", async () => {
    await withInMemoryOmp((adapter, events, elicitationResponses) =>
      Effect.gen(function* () {
        const threadId = ThreadId.makeUnsafe(crypto.randomUUID());
        yield* startSession(adapter, threadId, "elicitation-generation-1");

        const cancelTurn = yield* sendTurn(adapter, threadId, "Cancel this question.");
        const cancelledRequest = yield* waitForUserInputRequest(events);
        yield* adapter.respondToUserInput(threadId, responseId(cancelledRequest), {});
        expect(
          yield* takeElicitationResponse(elicitationResponses, "empty answer cancellation"),
        ).toEqual({ _tag: "response", response: { action: "cancel" } });
        const cancelledResolution = yield* waitForEvent(
          events,
          (event) =>
            event.type === "user-input.resolved" && event.requestId === cancelledRequest.requestId,
          10_000,
          "cancelled input resolution",
        );
        if (cancelledResolution.type !== "user-input.resolved") {
          return yield* Effect.fail(new Error("expected user-input.resolved"));
        }
        expect(cancelledResolution.payload.answers).toEqual({});
        yield* waitForEvent(
          events,
          (event) => event.type === "turn.completed" && event.turnId === cancelTurn.turnId,
          10_000,
          "cancel turn completion",
        );

        yield* sendTurn(adapter, threadId, "Leave this question pending until stop.");
        const stoppedRequest = yield* waitForUserInputRequest(events, [
          requestIdString(cancelledRequest),
        ]);
        const stopResult = yield* adapter
          .stopSession(threadId)
          .pipe(Effect.timeoutOption("8 seconds"));
        expect(Option.isSome(stopResult)).toBe(true);
        const stoppedOutcome = yield* takeElicitationResponse(
          elicitationResponses,
          "stop pending input",
        );
        if (stoppedOutcome._tag === "response") {
          expect(stoppedOutcome.response).toEqual({ action: "cancel" });
        } else {
          expect(stoppedOutcome.error).toBeDefined();
        }
        yield* Effect.sleep(20);
        const stoppedResolutions = events.filter(
          (event) =>
            event.type === "user-input.resolved" && event.requestId === stoppedRequest.requestId,
        );
        expect(stoppedResolutions.length).toBeLessThanOrEqual(1);
        for (const event of stoppedResolutions) {
          if (event.type === "user-input.resolved") expect(event.payload.answers).toEqual({});
        }
        const responseAfterStop = yield* Effect.flip(
          adapter.respondToUserInput(threadId, responseId(stoppedRequest), { q0: "Choice" }),
        );
        expect(responseAfterStop).toBeInstanceOf(ProviderAdapterSessionNotFoundError);

        yield* startSession(adapter, threadId, "elicitation-generation-2");
        const expired = yield* Effect.flip(
          adapter.respondToUserInput(threadId, responseId(stoppedRequest), { q0: "Choice" }),
        );
        expect(expired).toBeInstanceOf(ProviderAdapterRequestError);

        const nextTurn = yield* sendTurn(adapter, threadId, "Ask again after restart.");
        const currentRequest = yield* waitForUserInputRequest(events, [
          requestIdString(cancelledRequest),
          requestIdString(stoppedRequest),
        ]);
        expect(currentRequest.lifecycleGeneration).toBe("elicitation-generation-2");
        expect(currentRequest.requestId).not.toBe(stoppedRequest.requestId);

        yield* adapter.respondToUserInput(threadId, responseId(currentRequest), { q0: "Choice" });
        expect(yield* takeElicitationResponse(elicitationResponses, "restarted answer")).toEqual({
          _tag: "response",
          response: { action: "accept", content: { q0: "Choice" } },
        });
        const currentResolution = yield* waitForEvent(
          events,
          (event) =>
            event.type === "user-input.resolved" && event.requestId === currentRequest.requestId,
          10_000,
          "current generation input resolution",
        );
        if (currentResolution.type !== "user-input.resolved") {
          return yield* Effect.fail(new Error("expected user-input.resolved"));
        }
        expect(currentResolution.lifecycleGeneration).toBe("elicitation-generation-2");
        yield* waitForEvent(
          events,
          (event) => event.type === "turn.completed" && event.turnId === nextTurn.turnId,
          10_000,
          "restarted turn completion",
        );
        // Explicitly stop the restarted session so its test-owned process and
        // in-memory ACP peer are retired before the adapter scope closes.
        yield* adapter.stopSession(threadId);
      }),
    );
  }, 30_000);
});
