import {
  ProjectId,
  ProjectTaskAttemptId,
  ProjectTaskId,
  ThreadId,
  type HubPlanInputRequest,
  type HubPlanSnapshot,
} from "@synara/contracts";
import { describe, expect, it, vi } from "vitest";

import {
  currentHubInputRequest,
  guardDirectedReplyModeSend,
  hubInputRequestDraftKey,
  matchingHubInputRequest,
  parseHubInputRequestAnswers,
  type HubInputRequestReplyTarget,
} from "./hubInputRequest.logic";

const hubId = ProjectId.makeUnsafe("hub-input-request-test");
const workerThreadId = ThreadId.makeUnsafe("worker-thread-input-test");

function inputRequest(overrides: Partial<HubPlanInputRequest> = {}): HubPlanInputRequest {
  return {
    id: "input-request-a",
    nodeKey: "author-a",
    stageKey: "stage-a",
    generation: 2,
    attemptId: ProjectTaskAttemptId.makeUnsafe("attempt-a"),
    workerThreadId,
    questions: [{ title: "Which option?", options: ["A", "B"] }, { title: "Why?" }],
    status: "pending",
    ...overrides,
  };
}

function plan(overrides: Partial<HubPlanSnapshot> = {}, request = inputRequest()): HubPlanSnapshot {
  return {
    id: "plan-a",
    hubId,
    goalId: null,
    revision: 4,
    stateVersion: 8,
    controlState: "active",
    definition: {
      objective: "Review this option",
      scope: "Answer the Worker questions.",
      stages: [{ key: "stage-a", title: "Review", releasePolicy: "user" }],
      nodes: [
        {
          key: "author-a",
          stageKey: "stage-a",
          title: "Review author",
          brief: "Prepare the draft.",
          role: "author",
          dependsOnNodeKeys: [],
          workMode: "agent",
          acceptanceCriteria: "Provide a complete draft.",
        },
      ],
      maxRepairRounds: 0,
    },
    createdAt: "2026-10-23T00:00:00.000Z",
    updatedAt: "2026-10-23T00:00:00.000Z",
    graph: {
      controlState: "active",
      stages: [
        {
          stageKey: "stage-a",
          title: "Review",
          releasePolicy: "user",
          generation: 2,
          status: "running",
          underlyingStatus: "running",
          isReleased: false,
          candidateId: null,
          outputDigest: null,
          outputSummary: null,
          blockingReasons: [],
        },
      ],
      releasedCount: 0,
      stageCount: 1,
    },
    nodeStates: [
      {
        nodeKey: "author-a",
        taskId: ProjectTaskId.makeUnsafe("task-a"),
        workerThreadId,
        attemptId: ProjectTaskAttemptId.makeUnsafe("attempt-a"),
      },
    ],
    inputRequests: [request],
    eventSequence: 8,
    ...overrides,
  };
}

function target(
  planSnapshot: HubPlanSnapshot,
  request = inputRequest(),
): HubInputRequestReplyTarget {
  return {
    hubId: planSnapshot.hubId,
    planId: planSnapshot.id,
    revision: planSnapshot.revision,
    request,
    event: {
      sequence: 7,
      planId: planSnapshot.id,
      hubId: planSnapshot.hubId,
      kind: "plan.input-requested",
      payload: { snapshot: planSnapshot, inputRequest: request },
      createdAt: "2026-10-23T00:00:00.000Z",
    },
  };
}

describe("Hub Worker input request safety and drafts", () => {
  it("blocks ordinary sends during an explicitly selected directed reply", async () => {
    const send = vi.fn(async (text: string) => text.length > 0);
    const blockedSend = guardDirectedReplyModeSend(true, send);
    const allowedSend = guardDirectedReplyModeSend(false, send);

    await expect(blockedSend("ordinary Hub draft")).resolves.toBe(false);
    expect(send).not.toHaveBeenCalled();
    await expect(allowedSend("ordinary Hub draft")).resolves.toBe(true);
    expect(send).toHaveBeenCalledExactlyOnceWith("ordinary Hub draft");
  });

  it("keeps an exact pending request actionable even when other requests are also pending", () => {
    const first = inputRequest();
    const second = inputRequest({ id: "input-request-b" });
    const currentPlan = plan({ inputRequests: [first, second] }, first);

    expect(currentHubInputRequest(target(currentPlan, second), currentPlan)).toEqual(second);
  });

  it.each(["answered", "delivered"] as const)(
    "finds a persisted %s receipt for the same worker attempt",
    (status) => {
      const captured = inputRequest();
      const receipt = inputRequest({
        status,
        answers: ["A", "The same worker attempt answered."],
      });
      const currentPlan = plan({ inputRequests: [receipt] }, captured);

      expect(matchingHubInputRequest(target(currentPlan, captured), currentPlan)).toEqual(receipt);
    },
  );

  it("does not reuse a receipt from a different worker attempt", () => {
    const captured = inputRequest();
    const receiptFromNextAttempt = inputRequest({
      attemptId: ProjectTaskAttemptId.makeUnsafe("attempt-b"),
      status: "delivered",
      answers: ["B", "A later attempt answered."],
    });
    const currentPlan = plan({ inputRequests: [receiptFromNextAttempt] }, captured);

    expect(matchingHubInputRequest(target(currentPlan, captured), currentPlan)).toBeNull();
  });

  it.each([
    [
      "paused",
      (current: HubPlanSnapshot) => ({
        ...current,
        controlState: "paused" as const,
        graph: { ...current.graph, controlState: "paused" as const },
      }),
    ],
    [
      "new revision",
      (current: HubPlanSnapshot) => ({ ...current, revision: current.revision + 1 }),
    ],
    [
      "new stage generation",
      (current: HubPlanSnapshot) => ({
        ...current,
        graph: {
          ...current.graph,
          stages: current.graph.stages.map((stage) => ({
            ...stage,
            generation: stage.generation! + 1,
          })),
        },
      }),
    ],
    [
      "new attempt",
      (current: HubPlanSnapshot) => ({
        ...current,
        nodeStates: current.nodeStates.map((node) => ({
          ...node,
          attemptId: "attempt-b" as typeof node.attemptId,
        })),
      }),
    ],
    [
      "stale request",
      (current: HubPlanSnapshot) => ({
        ...current,
        inputRequests: (current.inputRequests ?? []).map((request) =>
          Object.assign({}, request, { status: "stale" as const }),
        ),
      }),
    ],
  ])("refuses a request after %s", (_label, mutate) => {
    const captured = plan();
    expect(currentHubInputRequest(target(captured), mutate(captured))).toBeNull();
  });

  it("restores all answers and isolates stored drafts by plan attempt and request id", () => {
    const currentPlan = plan();
    const firstKey = hubInputRequestDraftKey(target(currentPlan));
    const otherRequest = inputRequest({ id: "input-request-b" });
    const otherKey = hubInputRequestDraftKey(target(currentPlan, otherRequest));
    const nextAttempt = inputRequest({ attemptId: ProjectTaskAttemptId.makeUnsafe("attempt-b") });
    const nextAttemptKey = hubInputRequestDraftKey(target(currentPlan, nextAttempt));

    expect(firstKey).not.toBe(otherKey);
    expect(firstKey).not.toBe(nextAttemptKey);
    expect(parseHubInputRequestAnswers(JSON.stringify(["B", "Different reason"]), 2)).toEqual([
      "B",
      "Different reason",
    ]);
    expect(parseHubInputRequestAnswers(JSON.stringify(["B"]), 2)).toEqual(["B", ""]);
  });
});
