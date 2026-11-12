import { createHash } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ThreadId } from "@synara/contracts";
import { OMP_NATIVE_EXPERT_METHODS } from "@synara/contracts/omp/expertDelegation";
import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  createOmpNativeExpertTransport,
  verifiedOmpNativeExpertBuild,
} from "./OmpNativeExpertTransport";
import { makeFakeAcpSessionRuntime } from "./testing/fakeAcpSessionRuntime";
import type { OmpNativeExpertProtocolFactory } from "./OmpNativeExpertProtocol";
import type { OmpNativeExpertTaskUpdate } from "./OmpNativeExpertTransport";
import {
  OmpPrepareNativeTaskRequest,
  OmpNativeTaskStartedRequest,
  OmpNativeTaskEvent,
} from "@synara/contracts/omp/expertDelegation";

describe("OMP private Expert boundary", () => {
  it("requires exact binary bytes rather than a version or a caller-provided path", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "omp-native-proof-"));
    try {
      const binary = path.join(directory, "omp"),
        bytes = Buffer.from("isolated compiled binary fixture");
      await writeFile(binary, bytes);
      const build = {
        binarySha256: createHash("sha256").update(bytes).digest("hex"),
        buildFingerprint: "b".repeat(64),
      };
      expect(await verifiedOmpNativeExpertBuild(binary, [])).toBeUndefined();
      expect(await verifiedOmpNativeExpertBuild(binary, [build])).toEqual(build);
      await writeFile(binary, Buffer.from("changed binary fixture"));
      expect(await verifiedOmpNativeExpertBuild(binary, [build])).toBeUndefined();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it("does not bind or expose prompt authority when the actual connection reports another build", async () => {
    let binds = 0,
      closes = 0;
    const transport = createOmpNativeExpertTransport({
      context: {
        threadId: ThreadId.makeUnsafe("parent"),
        generation: "generation-1",
        cwd: process.cwd(),
        buildFingerprint: "a".repeat(64),
      },
      factory: async () => ({
        agentDirectory: "/trusted/catalog",
        targetAgentNames: ["author"],
        bindSession: async () => {
          binds += 1;
        },
        preparePrompt: async () => {
          throw new Error("Unverified prompt authority reached.");
        },
        handleRequest: async () => {
          throw new Error("Unverified host method reached.");
        },
        cancelTask: async () => {
          throw new Error("No task is bound.");
        },
        close: async () => {
          closes += 1;
        },
      }),
    });
    await transport.prepare();
    await Effect.runPromise(
      transport.connect({
        ...makeFakeAcpSessionRuntime(),
        request: () =>
          Effect.succeed({
            protocolVersion: 1,
            buildFingerprint: "b".repeat(64),
            targetProfiles: true,
            lifecycle: true,
          }),
      }),
    );
    expect(await transport.bind("actual-session")).toBe(false);
    expect(binds).toBe(0);
    expect(closes).toBe(1);
    expect(await transport.prompt("turn", "root")).toBeUndefined();
  });
  it("stops only the ACK-bound child and waits for terminal evidence before reporting completion", async () => {
    const handlers = new Map<string, (params: unknown) => Promise<unknown>>();
    const stopped: string[] = [],
      updates: OmpNativeExpertTaskUpdate[] = [];
    const transport = createOmpNativeExpertTransport({
      context: {
        threadId: ThreadId.makeUnsafe("parent"),
        generation: "generation-1",
        cwd: process.cwd(),
        buildFingerprint: "a".repeat(64),
      },
      onTask: async (update) => {
        updates.push(update);
      },
      factory: async () => ({
        agentDirectory: "/trusted/catalog",
        targetAgentNames: ["author"],
        bindSession: async () => {
          stopped.push("bound");
        },
        preparePrompt: async ({ parentTurnId }) => ({
          parentGeneration: "generation-1",
          parentTurnId,
          targetAgentNames: ["author"],
        }),
        handleRequest: async (method, params) => {
          if (method === OMP_NATIVE_EXPERT_METHODS.prepare) {
            const input = Schema.decodeUnknownSync(OmpPrepareNativeTaskRequest)(params);
            const attemptId = `attempt-${input.nativeTaskId}`;
            return {
              attemptId,
              capabilityBindingId: "binding",
              assemblyId: "assembly",
              profile: {
                protocolVersion: 1,
                attemptId,
                capabilityBindingId: "binding",
                assemblyId: "assembly",
                targetAgentName: "author",
                persona: "Target identity",
                artifactRoot: "/trusted/artifacts",
                skills: [],
                skillEntries: [],
                contextFiles: [],
                resourceRoots: [],
                mcpServers: [],
              },
            };
          }
          if (method === OMP_NATIVE_EXPERT_METHODS.started) {
            const input = Schema.decodeUnknownSync(OmpNativeTaskStartedRequest)(params);
            return {
              attemptId: input.attemptId,
              nativeTaskId: input.nativeTaskId,
              nativeSessionId: input.nativeSessionId,
              disposition: "accepted",
            };
          }
          const event = Schema.decodeUnknownSync(OmpNativeTaskEvent)(params);
          return {
            attemptId: event.attemptId,
            sequence: event.sequence,
            disposition: "accepted",
            resultRef: "result",
            resultHash: "d".repeat(64),
          };
        },
        cancelTask: async (nativeTaskId) => {
          stopped.push(nativeTaskId);
        },
        close: async () => {
          stopped.push("closed");
        },
      }),
    });
    await transport.prepare();
    await Effect.runPromise(
      transport.connect({
        ...makeFakeAcpSessionRuntime(),
        handleExtRequest: (method, _codec, handler) =>
          Effect.sync(() => {
            handlers.set(method, (params) => Effect.runPromise(handler(params as never)));
          }),
        request: () =>
          Effect.succeed({
            protocolVersion: 1,
            buildFingerprint: "a".repeat(64),
            targetProfiles: true,
            lifecycle: true,
          }),
      }),
    );
    expect(await transport.bind("actual-session")).toBe(true);
    await transport.prompt("actual-turn", "original-root");
    await expect(transport.cancelTask("forged-task")).rejects.toThrow();
    for (const [index, nativeTaskId] of ["child-a", "child-b"].entries()) {
      await handlers.get(OMP_NATIVE_EXPERT_METHODS.prepare)!({
        parentSessionId: "actual-session",
        parentGeneration: "generation-1",
        parentTurnId: "actual-turn",
        toolCallId: "parallel-task-call",
        taskIndex: index,
        nativeTaskId,
        agentName: "author",
        task: "Bound work",
        context: "",
        deliverable: "",
        deliveryMode: "host-continuation",
      });
      await handlers.get(OMP_NATIVE_EXPERT_METHODS.started)!({
        attemptId: `attempt-${nativeTaskId}`,
        nativeTaskId,
        nativeSessionId: `session-${nativeTaskId}`,
        parentGeneration: "generation-1",
      });
    }
    await transport.cancelTask("attempt-child-a");
    expect(stopped).toEqual(["bound", "child-a"]);
    expect(updates.map((update) => update.state)).toEqual(["running", "running"]);
    const terminal = {
      protocolVersion: 1,
      attemptId: "attempt-child-a",
      nativeTaskId: "child-a",
      parentGeneration: "generation-1",
      sequence: 1,
      payload: {
        kind: "terminal",
        outcome: "stopped",
        result: { summary: "Stopped with actual terminal evidence.", artifacts: [] },
        issue: null,
      },
    };
    await handlers.get(OMP_NATIVE_EXPERT_METHODS.event)!(terminal);
    await handlers.get(OMP_NATIVE_EXPERT_METHODS.event)!(terminal);
    expect(updates.filter((update) => update.state === "stopped")).toHaveLength(1);
    await expect(transport.cancelTask("attempt-child-a")).rejects.toThrow();
    await transport.cancelTask("attempt-child-b");
    expect(stopped).toEqual(["bound", "child-a", "child-b"]);
  });
  it("keeps query/cancel on the original connection and revokes its authority on close", async () => {
    let request: Parameters<OmpNativeExpertProtocolFactory>[0]["request"] | undefined;
    const sent: string[] = [],
      bound: string[] = [];
    const transport = createOmpNativeExpertTransport({
      context: {
        threadId: ThreadId.makeUnsafe("parent"),
        generation: "generation-1",
        cwd: process.cwd(),
        buildFingerprint: "a".repeat(64),
      },
      factory: async (context) => {
        request = context.request;
        return {
          agentDirectory: "/trusted/catalog",
          targetAgentNames: ["author"],
          bindSession: async (sessionId) => {
            bound.push(sessionId);
          },
          preparePrompt: async ({ parentTurnId }) => ({
            parentGeneration: context.generation,
            parentTurnId,
            targetAgentNames: ["author"],
          }),
          handleRequest: async () => {
            throw new Error("No inbound host request expected.");
          },
          cancelTask: async () => {
            throw new Error("No task is bound.");
          },
          close: async () => {
            sent.push("closed");
          },
        };
      },
    });
    await transport.prepare();
    await expect(request!(OMP_NATIVE_EXPERT_METHODS.query, {})).rejects.toThrow();
    await Effect.runPromise(
      transport.connect({
        ...makeFakeAcpSessionRuntime(),
        request: (method) => {
          sent.push(method);
          return method === OMP_NATIVE_EXPERT_METHODS.capabilities
            ? Effect.succeed({
                protocolVersion: 1,
                buildFingerprint: "a".repeat(64),
                targetProfiles: true,
                lifecycle: true,
              })
            : Effect.succeed({ state: "not-found" });
        },
      }),
    );
    expect(await transport.bind("actual-resumed-session")).toBe(true);
    expect(bound).toEqual(["actual-resumed-session"]);
    await expect(request!("session/new", {})).rejects.toThrow();
    await request!(OMP_NATIVE_EXPERT_METHODS.query, {
      attemptId: "attempt",
      nativeTaskId: "native",
    });
    await request!(OMP_NATIVE_EXPERT_METHODS.cancel, {
      attemptId: "attempt",
      nativeTaskId: "native",
    });
    await transport.close();
    await transport.close();
    expect(sent.filter((method) => method === OMP_NATIVE_EXPERT_METHODS.cancel)).toHaveLength(1);
    expect(sent.filter((method) => method === "closed")).toHaveLength(1);
    await expect(request!(OMP_NATIVE_EXPERT_METHODS.query, {})).rejects.toThrow();
    expect(await transport.prompt("turn-after-close", "original-root")).toBeUndefined();
  });
});
