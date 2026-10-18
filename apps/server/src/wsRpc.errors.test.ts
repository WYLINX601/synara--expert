import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { ThreadId, WS_METHODS, WsRpcError } from "@synara/contracts";
import { Effect, Fiber, Option } from "effect";
import { describe, expect, it, vi } from "vitest";

import { startWorkbenchRuntimeMcpFixture } from "../../../scripts/lib/workbench-runtime-mcp-fixture.ts";
import {
  ExpertConnectionStoreError,
  createExpertConnectionStore,
} from "./experts/ExpertConnectionStore.ts";
import { ExpertStoreError } from "./experts/ExpertStore.ts";
import type { ExpertAppliedRuntimeRepositoryShape } from "./persistence/Services/ExpertAppliedRuntimeRecords.ts";
import { makeWorkbenchExpertRpcHandlers } from "./workbench/host/expertRpc.ts";
import { createWorkbenchExpertRuntime } from "./workbench/runtimeLayer.ts";
import { CurrentWsSessionRole } from "./wsConnectionSessions";
import { requireWsOwnerSession } from "./wsOwnerAuthorization";
import { expertRpcEffect, toWsRpcError } from "./wsRpc";
import {
  OrchestrationCommandInvariantError,
  OrchestrationCommandPreviouslyRejectedError,
  OrchestrationCommandTimeoutError,
} from "./orchestration/Errors";

const emptyExpertAppliedRuntimeRepository = (): ExpertAppliedRuntimeRepositoryShape => ({
  upsert: () => Effect.void,
  getByThreadId: () => Effect.succeed(Option.none()),
  deleteByThreadId: () => Effect.void,
});

const mapRpcError = <A, E, R>(effect: Effect.Effect<A, E, R>, fallbackMessage: string) =>
  effect.pipe(Effect.mapError((cause) => toWsRpcError(cause, fallbackMessage)));

const makeExpertRpcHandlers = <R>(
  runtime: ReturnType<typeof createWorkbenchExpertRuntime>,
  requireOwner: Effect.Effect<void, WsRpcError, R>,
  previewProvider?: Parameters<typeof makeWorkbenchExpertRpcHandlers>[0]["previewProvider"],
) =>
  makeWorkbenchExpertRpcHandlers({
    runtime,
    requireOwner,
    ...(previewProvider ? { previewProvider } : {}),
    rpcEffect: mapRpcError,
    expertRpcEffect,
    loadProjectionThreads: () => Effect.succeed([]),
  });

describe("workbench Expert RPC error preservation", () => {
  it("keeps connection state mutations behind owner authorization", async () => {
    const ownerDenied = new WsRpcError({ message: "Owner access required." });
    const operation = vi.fn(async () => "mutated");
    await expect(
      Effect.runPromise(expertRpcEffect(Effect.fail(ownerDenied), operation, "fallback")),
    ).rejects.toBe(ownerDenied);
    expect(operation).not.toHaveBeenCalled();
  });

  it("blocks non-owner discovery and import before reading or writing local sources", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "synara-expert-mcp-owner-rpc-"));
    const sourcePath = path.join(root, "source.json");
    const sourceContents = '{"mcpServers":{"fixture":{"command":"fixture-mcp"}}}';
    try {
      await writeFile(sourcePath, sourceContents, "utf8");
      const runtime = createWorkbenchExpertRuntime({
        stateDir: path.join(root, "state"),
        expertAppliedRuntimeRepository: emptyExpertAppliedRuntimeRepository(),
      });
      const discover = vi.spyOn(runtime, "discoverMcpConnections");
      const importSelected = vi.spyOn(runtime, "importMcpConnections");
      const handlers = makeExpertRpcHandlers(runtime, requireWsOwnerSession);
      const nonOwner = <A>(effect: Effect.Effect<A, WsRpcError, never>) =>
        effect.pipe(Effect.provideService(CurrentWsSessionRole, "client"));

      await expect(
        Effect.runPromise(
          nonOwner(
            handlers[WS_METHODS.serverDiscoverMcpConnections]({
              sources: [{ kind: "json", path: sourcePath }],
            }),
          ),
        ),
      ).rejects.toMatchObject({ message: "Owner authorization is required for this operation." });
      await expect(
        Effect.runPromise(
          nonOwner(
            handlers[WS_METHODS.serverImportMcpConnections]({ scanId: "unknown-scan", items: [] }),
          ),
        ),
      ).rejects.toMatchObject({ message: "Owner authorization is required for this operation." });

      expect(discover).not.toHaveBeenCalled();
      expect(importSelected).not.toHaveBeenCalled();
      expect(await readFile(sourcePath, "utf8")).toBe(sourceContents);
      expect(await createExpertConnectionStore(path.join(root, "state")).list()).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("authorizes deletion before mutation and preserves revision failures", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "synara-expert-delete-rpc-"));
    try {
      const runtime = createWorkbenchExpertRuntime({
        stateDir: path.join(root, "state"),
        expertAppliedRuntimeRepository: emptyExpertAppliedRuntimeRepository(),
      });
      const expert = (await runtime.experts.list())[0]!;
      const remove = vi.spyOn(runtime.experts, "remove");
      const denied = new WsRpcError({ message: "Owner access required." });
      const deniedHandlers = makeExpertRpcHandlers(runtime, Effect.fail(denied));
      await expect(
        Effect.runPromise(
          deniedHandlers[WS_METHODS.serverDeleteExpert]({
            id: expert.id,
            expectedRevision: expert.revision,
          }),
        ),
      ).rejects.toBe(denied);
      expect(remove).not.toHaveBeenCalled();
      const handlers = makeExpertRpcHandlers(runtime, Effect.void);
      const error = await Effect.runPromise(
        handlers[WS_METHODS.serverDeleteExpert]({
          id: expert.id,
          expectedRevision: expert.revision + 1,
        }),
      ).catch((cause: unknown) => cause);
      expect(error).toBeInstanceOf(WsRpcError);
      if (!(error instanceof WsRpcError)) throw new Error("Expected RPC error envelope");
      expect(error.cause).toBeInstanceOf(ExpertStoreError);
      expect(error.cause).toMatchObject({ code: "revision_conflict" });
      expect(await runtime.experts.read(expert.id)).toEqual(expert);
      await expect(
        Effect.runPromise(
          handlers[WS_METHODS.serverDeleteExpert]({
            id: expert.id,
            expectedRevision: expert.revision,
          }),
        ),
      ).resolves.toBeUndefined();
      expect(await runtime.experts.read(expert.id)).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("passes a real connection revision conflict through Effect and RPC mapping", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "synara-expert-rpc-error-"));
    try {
      const runtime = createWorkbenchExpertRuntime({
        stateDir: path.join(root, "state"),
        expertAppliedRuntimeRepository: emptyExpertAppliedRuntimeRepository(),
      });
      const saved = await runtime.connections.save({
        id: "revision-conflict",
        name: "Revision conflict",
        transport: { type: "stdio", command: "fixture-mcp", args: [], envFromHost: [] },
      });
      const handlers = makeExpertRpcHandlers(runtime, Effect.succeed(undefined));
      const mappedError = await Effect.runPromise(
        handlers[WS_METHODS.serverRemoveExpertConnection]({
          id: saved.id,
          expectedRevision: saved.revision + 1,
        }),
      ).then(
        () => undefined,
        (cause: unknown) => cause,
      );

      const originalError = mappedError instanceof WsRpcError ? mappedError.cause : undefined;
      expect(originalError).toBeInstanceOf(ExpertConnectionStoreError);
      expect(mappedError).toBeInstanceOf(WsRpcError);
      if (!(originalError instanceof ExpertConnectionStoreError)) {
        throw new Error("Expected the real connection store revision error.");
      }
      if (!(mappedError instanceof WsRpcError)) {
        throw new Error("Expected the Expert RPC error envelope.");
      }
      expect(originalError.code).toBe("revision_conflict");
      expect(mappedError.cause).toBe(originalError);
      expect(mappedError.message).toBe(originalError.message);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("passes an actual MCP connection failure through the Expert RPC mapper", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "synara-expert-mcp-rpc-error-"));
    let fixture: Awaited<ReturnType<typeof startWorkbenchRuntimeMcpFixture>> | undefined;
    try {
      fixture = await startWorkbenchRuntimeMcpFixture();
      const connections = createExpertConnectionStore(path.join(root, "state"));
      const saved = await connections.save({
        id: "mcp-unavailable",
        name: "Unavailable MCP",
        transport: { type: "http", url: fixture.url, headersFromHost: [] },
      });
      await fixture.close();

      const runtime = createWorkbenchExpertRuntime({
        stateDir: path.join(root, "state"),
        expertAppliedRuntimeRepository: emptyExpertAppliedRuntimeRepository(),
      });
      const handlers = makeExpertRpcHandlers(runtime, Effect.succeed(undefined));
      const mappedError = await Effect.runPromise(
        handlers[WS_METHODS.serverTestExpertConnection]({
          id: saved.id,
          expectedRevision: saved.revision,
        }),
      ).then(
        () => undefined,
        (cause: unknown) => cause,
      );
      const originalError = mappedError instanceof WsRpcError ? mappedError.cause : undefined;

      expect(originalError).toBeInstanceOf(Error);
      expect(mappedError).toBeInstanceOf(WsRpcError);
      if (!(originalError instanceof Error)) {
        throw new Error("Expected the production MCP connector failure.");
      }
      if (!(mappedError instanceof WsRpcError)) {
        throw new Error("Expected the Expert RPC error envelope.");
      }
      expect(mappedError.cause).toBe(originalError);
      expect(mappedError.message).toBe(originalError.message);
      expect(mappedError.message).not.toBe("An error occurred in Effect.tryPromise");
    } finally {
      const cleanup = await Promise.allSettled([
        rm(root, { recursive: true, force: true }),
        ...(fixture ? [fixture.close()] : []),
      ]);
      const failure = cleanup.find((result) => result.status === "rejected");
      if (failure?.status === "rejected") throw failure.reason;
    }
  });

  it("keeps the extracted applied-runtime handler response shape", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "synara-expert-applied-runtime-rpc-"));
    try {
      const runtime = createWorkbenchExpertRuntime({
        stateDir: path.join(root, "state"),
        expertAppliedRuntimeRepository: emptyExpertAppliedRuntimeRepository(),
      });
      const handlers = makeExpertRpcHandlers(runtime, Effect.succeed(undefined));

      await expect(
        Effect.runPromise(
          handlers[WS_METHODS.serverReadExpertAppliedRuntime]({
            threadId: ThreadId.makeUnsafe("thread-without-applied-runtime"),
          }),
        ),
      ).resolves.toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("joins projected tasks into the extracted connection-reference response", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "synara-expert-connection-references-rpc-"));
    try {
      const runtime = createWorkbenchExpertRuntime({
        stateDir: path.join(root, "state"),
        expertAppliedRuntimeRepository: emptyExpertAppliedRuntimeRepository(),
      });
      vi.spyOn(runtime, "readExpertConnectionReferences").mockResolvedValue({
        experts: [],
        snapshots: [
          {
            snapshotId: "snapshot-1",
            expertId: "expert-1",
            displayName: "Expert One",
            configRevision: 3,
            required: true,
            legacy: false,
          },
        ],
        tasks: [],
        activeSessionCount: 1,
      });
      const threadId = ThreadId.makeUnsafe("thread-bound-to-snapshot");
      const handlers = makeWorkbenchExpertRpcHandlers({
        runtime,
        requireOwner: Effect.succeed(undefined),
        rpcEffect: mapRpcError,
        expertRpcEffect,
        loadProjectionThreads: () =>
          Effect.succeed([
            {
              id: threadId,
              title: "Bound task",
              expertBinding: {
                expertId: "expert-1",
                snapshotId: "snapshot-1",
                displayName: "Expert One",
                revision: 2,
              },
            },
          ]),
      });

      await expect(
        Effect.runPromise(
          handlers[WS_METHODS.serverReadExpertConnectionReferences]({ id: "connection-1" }),
        ),
      ).resolves.toMatchObject({
        tasks: [
          {
            threadId,
            title: "Bound task",
            snapshotId: "snapshot-1",
            configRevision: 3,
            required: true,
          },
        ],
        activeSessionCount: 1,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps an in-flight Expert RPC handler interruptible", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "synara-expert-rpc-cancellation-"));
    try {
      const runtime = createWorkbenchExpertRuntime({
        stateDir: path.join(root, "state"),
        expertAppliedRuntimeRepository: emptyExpertAppliedRuntimeRepository(),
      });
      let resolveList!: (value: Awaited<ReturnType<typeof runtime.experts.list>>) => void;
      let resolveStarted!: () => void;
      const operationStarted = new Promise<void>((resolve) => {
        resolveStarted = resolve;
      });
      const list = vi.spyOn(runtime.experts, "list").mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveList = resolve;
            resolveStarted();
          }),
      );
      const handlers = makeExpertRpcHandlers(runtime, Effect.succeed(undefined));
      const fiber = Effect.runFork(handlers[WS_METHODS.serverListExperts]());

      try {
        await operationStarted;
        await Effect.runPromise(Fiber.interrupt(fiber));
        expect(list).toHaveBeenCalledOnce();
      } finally {
        resolveList([]);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("orchestration RPC rejection evidence", () => {
  it.each([
    new OrchestrationCommandInvariantError({
      commandType: "thread.turn.start",
      detail: "Task is unavailable",
    }),
    new OrchestrationCommandPreviouslyRejectedError({
      commandId: "compact",
      detail: "Task was unavailable",
    }),
  ])("reports a proven rejection for $name", (error) => {
    expect(toWsRpcError(error, "Dispatch failed")).toMatchObject({
      code: "ORCHESTRATION_COMMAND_REJECTED",
      retryable: false,
    });
  });
  it.each([
    new OrchestrationCommandTimeoutError({
      commandId: "compact",
      commandType: "thread.turn.start",
      timeoutMs: 1000,
    }),
  ])("does not turn ambiguous errors into rejection evidence: $name", (error) => {
    expect(toWsRpcError(error, "Dispatch failed").code).toBeUndefined();
  });
});

describe("instance-scoped Expert provider preflight", () => {
  it("checks the selected instance after authorization and preserves incompatibility reasons", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "synara-expert-provider-preview-"));
    try {
      const runtime = createWorkbenchExpertRuntime({
        stateDir: root,
        expertAppliedRuntimeRepository: emptyExpertAppliedRuntimeRepository(),
      });
      const expert = await runtime.experts.save({
        name: "Fixed reviewer",
        description: "",
        useCases: "",
        persona: "Review",
        outputRequirements: "",
        skills: [],
        references: [],
        connections: [],
        preferredProvider: "omp",
      });
      const check = vi.fn(() => Effect.succeed(["The selected runtime filters a required skill."]));
      const request = {
        expertId: expert.id,
        provider: "omp" as const,
        providerInstanceId: "omp-work",
        cwd: "/workspace/work",
      };
      const denied = makeExpertRpcHandlers(
        runtime,
        Effect.fail(new WsRpcError({ message: "Owner required" })),
        check,
      );
      await expect(
        Effect.runPromise(denied[WS_METHODS.serverPreviewExpert](request)),
      ).rejects.toMatchObject({ message: "Owner required" });
      expect(check).not.toHaveBeenCalled();
      const allowed = makeExpertRpcHandlers(runtime, Effect.void, check);
      const result = await Effect.runPromise(allowed[WS_METHODS.serverPreviewExpert](request));
      expect(check).toHaveBeenCalledWith(request, []);
      expect(result.status).toBe("incompatible");
      expect(result.issues).toContain("The selected runtime filters a required skill.");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
