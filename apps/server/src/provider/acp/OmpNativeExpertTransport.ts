import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { realpath } from "node:fs/promises";
import {
  OMP_NATIVE_EXPERT_METHODS,
  OmpNativeTaskCapabilities,
  OmpPrepareNativeTaskRequest,
  OmpPrepareNativeTaskResponse,
  OmpNativeTaskStartedRequest,
  OmpNativeTaskStartedAck,
  OmpNativeTaskEvent,
  OmpNativeTaskAck,
} from "@synara/contracts/omp/expertDelegation";
import { Effect, Schema } from "effect";
import { AcpRequestError } from "./AcpErrors";
import type { AcpSessionRuntimeShape } from "./AcpSessionRuntime";
import type {
  OmpNativeExpertProtocol,
  OmpNativeExpertProtocolFactory,
  OmpNativeTaskPromptMetadata,
} from "./OmpNativeExpertProtocol";

export interface OmpNativeExpertBuild {
  readonly binarySha256: string;
  readonly buildFingerprint: string;
}
/** Exact bytes and private capability handshake must BOTH match trusted build provenance. */
export async function verifiedOmpNativeExpertBuild(
  binaryPath: string,
  builds: readonly OmpNativeExpertBuild[] = [],
): Promise<OmpNativeExpertBuild | undefined> {
  if (builds.length === 0) return undefined;
  const canonical = await realpath(binaryPath);
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(canonical)) digest.update(chunk);
  const hash = digest.digest("hex");
  return builds.find(
    (build) => /^[a-f0-9]{64}$/u.test(build.buildFingerprint) && build.binarySha256 === hash,
  );
}
const privateMethods = new Set<string>(Object.values(OMP_NATIVE_EXPERT_METHODS));
export interface OmpNativeExpertTaskUpdate {
  readonly taskId: string;
  readonly parentTurnId: string;
  readonly state: "running" | "completed" | "failed" | "stopped";
  readonly description?: string;
}
export interface OmpNativeExpertTransport {
  prepare(): Promise<OmpNativeExpertProtocol | null>;
  connect(acp: AcpSessionRuntimeShape): Effect.Effect<void>;
  bind(sessionId: string): Promise<boolean>;
  negotiate(): Promise<boolean>;
  prompt(
    parentTurnId: string,
    parentRootRunId: string,
  ): Promise<OmpNativeTaskPromptMetadata | undefined>;
  cancelTask(taskId: string): Promise<void>;
  close(): Promise<void>;
}
export function createOmpNativeExpertTransport(input: {
  readonly factory: OmpNativeExpertProtocolFactory;
  readonly context: Omit<Parameters<OmpNativeExpertProtocolFactory>[0], "request">;
  readonly onTask?: (update: OmpNativeExpertTaskUpdate) => Promise<void>;
}): OmpNativeExpertTransport {
  let connection: AcpSessionRuntimeShape | undefined;
  let sessionId: string | undefined;
  let protocol: OmpNativeExpertProtocol | null = null;
  let negotiated = false;
  let closed = false;
  let closePromise: Promise<void> | undefined;
  const prompts = new Set<string>();
  const tasks = new Map<
    string,
    { attemptId: string; parentTurnId: string; started: boolean; terminal: boolean }
  >();
  const nativeTaskByAttempt = new Map<string, string>();
  const unavailable = () =>
    new AcpRequestError({
      code: -32000,
      errorMessage: "Native Expert delegation is not verified for this runtime.",
    });
  const negotiate = async (): Promise<boolean> => {
    if (!connection || !protocol || closed) return false;
    if (negotiated) return true;
    const current = protocol;
    try {
      const capability = Schema.decodeUnknownSync(OmpNativeTaskCapabilities)(
        await Effect.runPromise(
          connection
            .request(OMP_NATIVE_EXPERT_METHODS.capabilities, {
              protocolVersion: 1,
              catalogDirectory: current.agentDirectory,
            })
            .pipe(Effect.timeout("5 seconds")),
        ),
      );
      if (
        capability.buildFingerprint !== input.context.buildFingerprint ||
        closed ||
        protocol !== current
      )
        throw unavailable();
      negotiated = true;
      return true;
    } catch {
      negotiated = false;
      await current.close();
      if (protocol === current) protocol = null;
      return false;
    }
  };
  return {
    negotiate,
    async prepare() {
      protocol = await input.factory({
        ...input.context,
        request: async (method, params) => {
          if (!connection || !negotiated || closed || !privateMethods.has(method))
            throw unavailable();
          return Effect.runPromise(connection.request(method, params));
        },
      });
      return protocol;
    },
    connect(acp: AcpSessionRuntimeShape) {
      connection = acp;
      return Effect.forEach(
        Object.values(OMP_NATIVE_EXPERT_METHODS),
        (method) =>
          acp.handleExtRequest(method, Schema.Unknown, (params) => {
            if (!protocol || !negotiated || closed) return Effect.fail(unavailable());
            return Effect.tryPromise({
              try: async () => {
                const result = await protocol!.handleRequest(method, params);
                if (method === OMP_NATIVE_EXPERT_METHODS.prepare) {
                  const request = Schema.decodeUnknownSync(OmpPrepareNativeTaskRequest)(params);
                  const response = Schema.decodeUnknownSync(OmpPrepareNativeTaskResponse)(result);
                  if (
                    request.parentSessionId !== sessionId ||
                    request.parentGeneration !== input.context.generation ||
                    !prompts.has(request.parentTurnId)
                  )
                    throw unavailable();
                  const previous = tasks.get(request.nativeTaskId);
                  if (
                    previous &&
                    (previous.attemptId !== response.attemptId ||
                      previous.parentTurnId !== request.parentTurnId)
                  )
                    throw unavailable();
                  if (!previous) {
                    const native = nativeTaskByAttempt.get(response.attemptId);
                    if (native !== undefined && native !== request.nativeTaskId)
                      throw unavailable();
                    tasks.set(request.nativeTaskId, {
                      attemptId: response.attemptId,
                      parentTurnId: request.parentTurnId,
                      started: false,
                      terminal: false,
                    });
                    nativeTaskByAttempt.set(response.attemptId, request.nativeTaskId);
                  }
                } else if (method === OMP_NATIVE_EXPERT_METHODS.started) {
                  const request = Schema.decodeUnknownSync(OmpNativeTaskStartedRequest)(params);
                  const ack = Schema.decodeUnknownSync(OmpNativeTaskStartedAck)(result);
                  const task = tasks.get(request.nativeTaskId);
                  if (
                    !task ||
                    task.attemptId !== request.attemptId ||
                    ack.attemptId !== task.attemptId ||
                    ack.nativeTaskId !== request.nativeTaskId ||
                    ack.nativeSessionId !== request.nativeSessionId ||
                    request.parentGeneration !== input.context.generation
                  )
                    throw unavailable();
                  if (!task.started && !task.terminal) {
                    await input.onTask?.({
                      taskId: task.attemptId,
                      parentTurnId: task.parentTurnId,
                      state: "running",
                    });
                    task.started = true;
                  }
                } else if (method === OMP_NATIVE_EXPERT_METHODS.event) {
                  const event = Schema.decodeUnknownSync(OmpNativeTaskEvent)(params);
                  const ack = Schema.decodeUnknownSync(OmpNativeTaskAck)(result);
                  const task = tasks.get(event.nativeTaskId);
                  if (
                    task &&
                    (task.attemptId !== event.attemptId ||
                      ack.attemptId !== task.attemptId ||
                      ack.sequence !== event.sequence ||
                      event.parentGeneration !== input.context.generation)
                  )
                    throw unavailable();
                  if (task && event.payload.kind === "terminal" && !task.terminal) {
                    await input.onTask?.({
                      taskId: task.attemptId,
                      parentTurnId: task.parentTurnId,
                      state: event.payload.outcome,
                      description: event.payload.result.summary,
                    });
                    task.terminal = true;
                  }
                }
                return result;
              },
              catch: (cause) =>
                cause instanceof AcpRequestError
                  ? cause
                  : new AcpRequestError({
                      code: -32000,
                      errorMessage: "The native Expert request was rejected.",
                    }),
            });
          }),
        { discard: true },
      );
    },
    async bind(actualSessionId: string) {
      if (!negotiated && !(await negotiate())) return false;
      if (!connection || !protocol || closed) return false;
      const current = protocol;
      try {
        if (closed) throw unavailable();
        sessionId = actualSessionId;
        await current.bindSession(actualSessionId);
        return true;
      } catch {
        negotiated = false;
        await current.close();
        if (protocol === current) protocol = null;
        return false;
      }
    },
    async prompt(parentTurnId: string, parentRootRunId: string) {
      if (!protocol || !negotiated || !sessionId || closed) return undefined;
      const metadata = await protocol.preparePrompt({ sessionId, parentTurnId, parentRootRunId });
      prompts.add(parentTurnId);
      return metadata;
    },
    async cancelTask(taskId: string) {
      if (!protocol || !negotiated || closed) throw unavailable();
      const nativeTaskId = nativeTaskByAttempt.get(taskId);
      const task = nativeTaskId ? tasks.get(nativeTaskId) : undefined;
      if (!nativeTaskId || !task?.started || task.terminal)
        throw new AcpRequestError({
          code: -32000,
          errorMessage: "This task has no live verified native execution.",
        });
      await protocol.cancelTask(nativeTaskId);
    },
    close() {
      if (closePromise) return closePromise;
      closed = true;
      closePromise = (async () => {
        try {
          // Host closure only retires local authority. Physical cancellation is
          // owned by the enclosing ACP scope, not by a cooperative wire reply.
          if (protocol) await protocol.close();
        } finally {
          protocol = null;
          tasks.clear();
          nativeTaskByAttempt.clear();
          prompts.clear();
        }
      })();
      return closePromise;
    },
  };
}
