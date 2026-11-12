import {
  ApprovalRequestId,
  CommandId,
  ThreadId,
  type ExpertDelegationAttempt,
  type ProviderApprovalDecision,
} from "@synara/contracts";
import { Effect, Option } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OrchestrationEngineShape } from "../orchestration/Services/OrchestrationEngine.ts";
import type { ProjectionPendingInteraction } from "../persistence/Services/ProjectionPendingInteractions.ts";
import { makeNativeExpertReexecutionGate } from "../workbench/host/nativeExpertReexecutionGate.ts";

afterEach(() => vi.useRealTimers());

function fixture() {
  const threadId = ThreadId.makeUnsafe("parent");
  const controller = new AbortController();
  let attempt: ExpertDelegationAttempt = {
    attemptId: "old-attempt",
    delegationId: "delegation",
    requestId: "old-request",
    requestHash: "a".repeat(64),
    provider: "omp",
    capabilityBindingId: "binding",
    assemblyId: "assembly",
    executionBindingId: "execution",
    state: "unknown",
    revision: 3,
    resultRef: null,
    resultHash: null,
    appliedEventId: null,
    updatedAt: "2026-11-11T00:00:00.000Z",
  };
  let ownerThreadId = threadId;
  let row: ProjectionPendingInteraction | undefined;
  const opened = Promise.withResolvers<string>();
  const resolving = Promise.withResolvers<void>();
  let settlementBarrier: Promise<void> = Promise.resolve();
  const events: Parameters<OrchestrationEngineShape["dispatch"]>[0][] = [];
  const dependencies = {
    delegations: {
      readAttempt: vi.fn(() => Effect.succeed(attempt)),
      readDelegation: () =>
        Effect.succeed({
          delegationId: "delegation",
          parentThreadId: ownerThreadId,
          parentRootRunId: "parent-root",
          targetExpertId: "target",
          task: "Original task",
          context: "",
          deliverable: "",
        }),
    },
    interactions: { getByIdentity: () => Effect.succeed(Option.fromNullishOr(row)) },
  };
  const gate = makeNativeExpertReexecutionGate(dependencies);
  const publish: OrchestrationEngineShape["dispatch"] = (command) =>
    Effect.promise(async () => {
      events.push(command);
      if (command.type !== "thread.activity.append") throw new Error("Unexpected command");
      const payload = command.activity.payload as Record<string, unknown>;
      if (command.activity.kind === "approval.requested") {
        row = {
          threadId,
          requestId: ApprovalRequestId.makeUnsafe(String(payload.requestId)),
          interactionKind: "approval",
          turnId: null,
          lifecycleGeneration: String(payload.lifecycleGeneration),
          status: "pending",
          decision: null,
          responseCommandId: null,
          responseRequestedAt: null,
          createdAt: command.createdAt,
          resolvedAt: null,
        };
        opened.resolve(String(payload.requestId));
      } else {
        resolving.resolve();
        await settlementBarrier;
        row = {
          ...row!,
          status: "confirmed",
          decision: payload.decision as ProviderApprovalDecision,
          resolvedAt: command.createdAt,
        };
      }
      return { sequence: events.length };
    });
  const input = {
    threadId,
    generation: "generation-1",
    delegationId: "delegation",
    previousAttemptId: attempt.attemptId,
    expectedRevision: attempt.revision,
    requestHash: attempt.requestHash,
    targetExpertId: "target",
    task: "Run the requested task again",
    signal: controller.signal,
    publish,
  };
  return {
    gate,
    input,
    threadId,
    controller,
    opened: opened.promise,
    resolving: resolving.promise,
    events,
    dependencies,
    changeAttempt(patch: Partial<ExpertDelegationAttempt>) {
      attempt = { ...attempt, ...patch };
    },
    changeOwner() {
      ownerThreadId = ThreadId.makeUnsafe("foreign-thread");
    },
    changeRow(patch: Partial<ProjectionPendingInteraction>) {
      row = { ...row!, ...patch };
    },
    claim(decision: ProviderApprovalDecision) {
      row = {
        ...row!,
        status: "responding",
        decision,
        responseCommandId: CommandId.makeUnsafe("human-response"),
        responseRequestedAt: new Date().toISOString(),
      };
    },
    holdSettlement(promise: Promise<void>) {
      settlementBarrier = promise;
    },
  };
}

describe("native Expert explicit reexecution consent", () => {
  it("releases exactly one accept only after the real claimed decision's durable settlement", async () => {
    const f = fixture();
    const barrier = Promise.withResolvers<void>();
    f.holdSettlement(barrier.promise);
    let released = false;
    const request = f.gate.request(f.input).then((accepted) => {
      released = true;
      return accepted;
    });
    const requestId = await f.opened;
    const opened = f.events[0];
    expect(opened).toMatchObject({
      type: "thread.activity.append",
      activity: {
        turnId: null,
        payload: { sessionApprovalAvailable: false, lifecycleGeneration: "generation-1" },
      },
    });
    expect(JSON.stringify(opened)).toContain("may still be running");
    expect(JSON.stringify(opened)).toContain("duplicate external side effects");
    f.claim("accept");
    const response = f.gate.respond(f.threadId, requestId, "accept");
    await f.resolving;
    expect(released).toBe(false);
    expect(await f.gate.respond(f.threadId, requestId, "accept")).toBe(false);
    barrier.resolve();
    expect(await response).toBe(true);
    expect(await request).toBe(true);
    expect(f.dependencies.delegations.readAttempt.mock.calls.length).toBeGreaterThanOrEqual(4);
    expect(await f.gate.respond(f.threadId, requestId, "accept")).toBe(false);
    expect(f.events).toHaveLength(2);
  });

  it.each(["decline", "cancel", "acceptForSession"] as const)(
    "never turns %s into authority",
    async (decision) => {
      const f = fixture();
      const request = f.gate.request(f.input);
      const id = await f.opened;
      f.claim(decision);
      expect(await f.gate.respond(f.threadId, id, decision)).toBe(true);
      expect(await request).toBe(false);
    },
  );

  it("rejects a direct provider response without the original human claim", async () => {
    const f = fixture();
    const request = f.gate.request(f.input);
    const id = await f.opened;
    expect(await f.gate.respond(f.threadId, id, "accept")).toBe(false);
    expect(await request).toBe(false);
  });

  it.each(["state", "revision", "hash", "owner", "generation", "decision", "settlement"])(
    "rejects changed %s when the answer arrives",
    async (change) => {
      const f = fixture();
      const request = f.gate.request(f.input);
      const id = await f.opened;
      f.claim("accept");
      if (change === "state") f.changeAttempt({ state: "running" });
      if (change === "revision") f.changeAttempt({ revision: 4 });
      if (change === "hash") f.changeAttempt({ requestHash: "b".repeat(64) });
      if (change === "owner") f.changeOwner();
      if (change === "generation") f.changeRow({ lifecycleGeneration: "old-generation" });
      if (change === "decision") f.changeRow({ decision: "decline" });
      if (change === "settlement") f.changeRow({ status: "confirmed" });
      expect(await f.gate.respond(f.threadId, id, "accept")).toBe(false);
      expect(await request).toBe(false);
    },
  );

  it.each(["abort", "stop", "stale-after-accept"])(
    "does not authorize after %s",
    async (reason) => {
      const f = fixture();
      const barrier = Promise.withResolvers<void>();
      f.holdSettlement(barrier.promise);
      const request = f.gate.request(f.input);
      const id = await f.opened;
      f.claim("accept");
      const response = f.gate.respond(f.threadId, id, "accept");
      await f.resolving;
      if (reason === "abort") f.controller.abort();
      if (reason === "stop") f.gate.cancelThread(f.threadId, "generation-1");
      if (reason === "stale-after-accept") f.changeAttempt({ revision: 4 });
      barrier.resolve();
      await response;
      expect(await request).toBe(false);
    },
  );

  it("rechecks abort after the final asynchronous attempt reread", async () => {
    const f = fixture();
    const reading = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const read = f.dependencies.delegations.readAttempt.getMockImplementation()!;
    let reads = 0;
    f.dependencies.delegations.readAttempt.mockImplementation(() => {
      reads += 1;
      if (reads !== 4) return read();
      return Effect.promise(async () => {
        reading.resolve();
        await release.promise;
        return Effect.runPromise(read());
      });
    });
    const request = f.gate.request(f.input);
    const id = await f.opened;
    f.claim("accept");
    const response = f.gate.respond(f.threadId, id, "accept");
    await reading.promise;
    f.controller.abort();
    release.resolve();
    await response;
    expect(await request).toBe(false);
  });

  it("does not reuse callbacks after restart, across conversations, or concurrent requests", async () => {
    const f = fixture();
    const request = f.gate.request(f.input);
    const id = await f.opened;
    const restarted = makeNativeExpertReexecutionGate(f.dependencies);
    expect(await restarted.respond(f.threadId, id, "accept")).toBe(false);
    expect(await f.gate.respond(ThreadId.makeUnsafe("other"), id, "accept")).toBe(false);
    await expect(f.gate.request(f.input)).rejects.toThrow();
    f.gate.cancelThread(f.threadId, "other-generation");
    f.claim("accept");
    expect(await f.gate.respond(f.threadId, id, "accept")).toBe(true);
    expect(await request).toBe(true);
    // A later request gets a new question, not a standing turn/session grant.
    const aborted = new AbortController();
    aborted.abort();
    expect(await f.gate.request({ ...f.input, signal: aborted.signal })).toBe(false);
  });

  it("expires unanswered questions without granting", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const request = f.gate.request(f.input);
    const id = await f.opened;
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(await request).toBe(false);
    expect(await f.gate.respond(f.threadId, id, "accept")).toBe(false);
  });

  it("cancels a stuck opening immediately and dismisses any later committed card", async () => {
    const f = fixture();
    const opening = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const request = f.gate.request({
      ...f.input,
      publish: (command) =>
        command.type === "thread.activity.append" && command.activity.kind === "approval.requested"
          ? Effect.promise(async () => {
              opening.resolve();
              await release.promise;
              return Effect.runPromise(f.input.publish(command));
            })
          : f.input.publish(command),
    });
    await opening.promise;
    f.gate.cancelThread(f.threadId);
    expect(await request).toBe(false);
    release.resolve();
    const id = await f.opened;
    await f.resolving;
    expect(await f.gate.respond(f.threadId, id, "accept")).toBe(false);
    expect(f.events).toHaveLength(2);
  });

  it("does not release authority if the settlement dispatch fails", async () => {
    const f = fixture();
    const request = f.gate.request({
      ...f.input,
      publish: (command) =>
        command.type === "thread.activity.append" && command.activity.kind === "approval.resolved"
          ? Effect.die(new Error("Settlement unavailable"))
          : f.input.publish(command),
    });
    const rejected = expect(request).rejects.toThrow("Settlement unavailable");
    const id = await f.opened;
    f.claim("accept");
    await expect(f.gate.respond(f.threadId, id, "accept")).rejects.toThrow(
      "Settlement unavailable",
    );
    await rejected;
  });
});
