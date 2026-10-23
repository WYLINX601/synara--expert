import { Exit, Schema } from "effect";
import { Rpc } from "effect/unstable/rpc";
import { describe, expect, it } from "vitest";

import {
  HUB_PLAN_MAX_NODES,
  HUB_PLAN_MAX_REPAIR_ROUNDS,
  HUB_PLAN_MAX_REVIEWERS_PER_STAGE,
  HUB_PLAN_MAX_SOURCE_MESSAGES,
  HUB_PLAN_MAX_STAGES,
  HubPlanCommandInputSchema,
  HubPlanDefinitionSchema,
  HubPlanEventsInputSchema,
  HubPlanEventSchema,
  HubPlanGraphViewSchema,
  HubPlanInputRequestSchema,
  HubPlanListInputSchema,
  HubPlanProposeInputSchema,
  HubPlanReadInputSchema,
  HubPlanSnapshotSchema,
  HubPlanSubmitCandidateCommandSchema,
} from "./hubPlan";
import { WsHubPlansEventsRpc } from "./rpc";

const node = (
  key: string,
  stageKey: string,
  role: "author" | "reviewer" | "worker" = "author",
  dependsOnNodeKeys: string[] = [],
) => ({
  key,
  stageKey,
  title: key,
  brief: `Do ${key}`,
  role,
  dependsOnNodeKeys,
  workMode: "agent" as const,
  acceptanceCriteria: `Accept ${key}`,
});

const plan = () => ({
  objective: "Deliver a reviewed result",
  scope: "One bounded workstream",
  stages: [
    { key: "requirements", title: "Requirements", releasePolicy: "auto" as const },
    { key: "solution", title: "Solution", releasePolicy: "user" as const },
  ],
  nodes: [
    node("requirements-author", "requirements"),
    node("solution-author", "solution", "author", ["requirements-author"]),
    node("solution-reviewer", "solution", "reviewer", ["solution-author"]),
  ],
  maxRepairRounds: 2,
});

describe("Hub plan definition contract", () => {
  it("accepts the strict bounded plan shape", () => {
    const input = plan();

    expect(Schema.decodeUnknownSync(HubPlanDefinitionSchema)(input)).toEqual(input);
  });

  it("rejects unknown fields at every object level", () => {
    const input = plan();

    expect(() =>
      Schema.decodeUnknownSync(HubPlanDefinitionSchema)({ ...input, hidden: true }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(HubPlanDefinitionSchema)({
        ...input,
        stages: [{ ...input.stages[0], hidden: true }, input.stages[1]],
      }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(HubPlanDefinitionSchema)({
        ...input,
        nodes: [{ ...input.nodes[0], hidden: true }, ...input.nodes.slice(1)],
      }),
    ).toThrow();
  });

  it("rejects stage, node, reviewer, and repair-round overflow", () => {
    const input = plan();
    const tooManyStages = Array.from({ length: HUB_PLAN_MAX_STAGES + 1 }, (_, index) => ({
      key: `stage-${index}`,
      title: `Stage ${index}`,
      releasePolicy: "auto" as const,
    }));
    const tooManyNodes = Array.from({ length: HUB_PLAN_MAX_NODES + 1 }, (_, index) =>
      node(`node-${index}`, "requirements"),
    );
    const tooManyReviewers = [
      node("author", "requirements"),
      ...Array.from({ length: HUB_PLAN_MAX_REVIEWERS_PER_STAGE + 1 }, (_, index) =>
        node(`review-${index}`, "requirements", "reviewer", ["author"]),
      ),
    ];
    expect(Schema.is(HubPlanDefinitionSchema)({ ...input, stages: tooManyStages })).toBe(false);
    expect(Schema.is(HubPlanDefinitionSchema)({ ...input, nodes: tooManyNodes })).toBe(false);
    expect(
      Schema.is(HubPlanDefinitionSchema)({
        ...input,
        stages: [{ key: "requirements", title: "Requirements", releasePolicy: "auto" }],
        nodes: tooManyReviewers,
      }),
    ).toBe(false);
    expect(
      Schema.is(HubPlanDefinitionSchema)({
        ...input,
        maxRepairRounds: HUB_PLAN_MAX_REPAIR_ROUNDS + 1,
      }),
    ).toBe(false);
  });

  it("does not model a user release as a Task role", () => {
    const input = plan();
    const withFakeUserTask = {
      ...input,
      nodes: [{ ...input.nodes[0], role: "user" }, ...input.nodes.slice(1)],
    };

    expect(Schema.is(HubPlanDefinitionSchema)(withFakeUserTask)).toBe(false);
  });

  it("accepts an explicit ModelSelection target on a node", () => {
    const input = plan();
    const targeted = {
      ...input,
      nodes: [
        {
          ...input.nodes[0],
          target: { provider: "codex", instanceId: "codex", model: "gpt-6.1-sol" },
        },
        ...input.nodes.slice(1),
      ],
    };

    expect(Schema.is(HubPlanDefinitionSchema)(targeted)).toBe(true);
    expect(
      Schema.is(HubPlanDefinitionSchema)({
        ...targeted,
        nodes: [
          {
            ...targeted.nodes[0],
            target: {
              provider: "codex",
              instanceId: "codex",
              model: "gpt-6.1-sol",
              canApprove: true,
            },
          },
          ...targeted.nodes.slice(1),
        ],
      }),
    ).toBe(false);
  });
});

const snapshot = () => {
  const definition = {
    objective: "Deliver a reviewed result",
    scope: "One bounded workstream",
    stages: [{ key: "draft", title: "Draft", releasePolicy: "auto" as const }],
    nodes: [node("author", "draft")],
    maxRepairRounds: 1,
  };
  const stage = {
    stageKey: "draft",
    title: "Draft",
    releasePolicy: "auto" as const,
    generation: 1,
    status: "ready_to_release" as const,
    underlyingStatus: "ready_to_release" as const,
    isReleased: false,
    candidateId: "candidate-1",
    outputDigest: "sha256:abc",
    outputSummary: "Current candidate",
    blockingReasons: [],
  };
  return {
    id: "plan-1",
    hubId: "project-1",
    goalId: null,
    revision: 1,
    stateVersion: 1,
    controlState: "active" as const,
    definition,
    createdAt: "2026-10-22T00:00:00Z",
    updatedAt: "2026-10-22T00:00:00Z",
    graph: {
      controlState: "active" as const,
      stages: [stage],
      releasedCount: 0,
      stageCount: 1,
    },
    nodeStates: [
      {
        nodeKey: "author",
        taskId: "task-1",
        workerThreadId: null,
        attemptId: null,
        retryable: true,
      },
    ],
    eventSequence: 0,
  };
};

const commandBase = () => ({
  hubId: "project-1",
  planId: "plan-1",
  requestId: "request-1",
  expectedStateVersion: 1,
  expectedRevision: 1,
});

const deliverableReference = () => ({
  hubId: "project-1",
  workerThreadId: "thread-1",
  revision: 1,
  commitSha: "a".repeat(40),
  provenance: {
    hubId: "project-1",
    workerThreadId: "thread-1",
    expertBindingSnapshotId: "binding-1",
    publishedAt: "2026-10-22T00:00:00Z",
  },
  file: {
    path: "result.md",
    libraryPath: "thread-1/1/result.md",
    name: "Result",
    description: null,
    mediaType: "text/markdown",
    sizeBytes: 10,
    sha256: "b".repeat(64),
  },
});

describe("Hub plan wire contracts", () => {
  it("validates snapshot graph shape and bounds event counters", () => {
    const value = snapshot();
    expect(Schema.is(HubPlanGraphViewSchema)(value.graph)).toBe(true);
    // Snapshots written before runtime facts were added remain readable.
    expect(Schema.is(HubPlanSnapshotSchema)(value)).toBe(true);
    expect(
      Schema.is(HubPlanSnapshotSchema)({
        ...value,
        nodeStates: [
          {
            ...value.nodeStates[0],
            taskStatus: "running",
            workState: "working",
            progressSummary: "Applying the requested change",
            queueReason: "Waiting for capacity",
            reviewOutcome: "blocked",
          },
        ],
      }),
    ).toBe(true);
    expect(
      Schema.is(HubPlanSnapshotSchema)({
        ...value,
        nodeStates: [{ ...value.nodeStates[0], taskStatus: "waiting" }],
      }),
    ).toBe(false);
    expect(
      Schema.is(HubPlanSnapshotSchema)({
        ...value,
        nodeStates: [{ ...value.nodeStates[0], workState: "blocked" }],
      }),
    ).toBe(false);
    expect(
      Schema.is(HubPlanSnapshotSchema)({
        ...value,
        nodeStates: [{ ...value.nodeStates[0], progressSummary: "x".repeat(2_001) }],
      }),
    ).toBe(false);
    expect(
      Schema.is(HubPlanSnapshotSchema)({
        ...value,
        nodeStates: [{ ...value.nodeStates[0], reviewOutcome: "unknown" }],
      }),
    ).toBe(false);
    expect(
      Schema.is(HubPlanSnapshotSchema)({
        ...value,
        nodeStates: [{ ...value.nodeStates[0], retryable: "yes" }],
      }),
    ).toBe(false);
    expect(Schema.is(HubPlanListInputSchema)({ hubId: "project-1" })).toBe(true);
    expect(Schema.is(HubPlanReadInputSchema)({ hubId: "project-1", planId: "plan-1" })).toBe(true);
    expect(Schema.is(HubPlanSnapshotSchema)({ ...value, actor: "client-controlled" })).toBe(false);
    expect(
      Schema.is(HubPlanSnapshotSchema)({
        ...value,
        graph: { ...value.graph, stageCount: 13 },
      }),
    ).toBe(false);
    expect(
      Schema.is(HubPlanSnapshotSchema)({
        ...value,
        graph: { ...value.graph, controlState: "paused" },
      }),
    ).toBe(false);

    expect(
      Schema.is(HubPlanEventSchema)({
        sequence: 1,
        planId: "plan-1",
        hubId: "project-1",
        kind: "plan.confirmed",
        payload: { snapshot: value },
        createdAt: "2026-10-22T00:00:00Z",
      }),
    ).toBe(true);
    expect(
      Schema.is(HubPlanEventSchema)({
        sequence: 0,
        planId: "plan-1",
        hubId: "project-1",
        kind: "plan.confirmed",
        payload: { snapshot: value },
        createdAt: "2026-10-22T00:00:00Z",
      }),
    ).toBe(false);
    expect(
      Schema.is(HubPlanEventSchema)({
        sequence: 1,
        planId: "plan-1",
        hubId: "project-1",
        kind: "plan.confirmed",
        payload: null,
        createdAt: "2026-10-22T00:00:00Z",
      }),
    ).toBe(false);
    expect(Schema.is(HubPlanEventsInputSchema)({ hubId: "project-1", afterSequence: 0 })).toBe(
      true,
    );
    expect(Schema.is(HubPlanEventsInputSchema)({ hubId: "project-1", afterSequence: -1 })).toBe(
      false,
    );
  });

  it("preserves historical snapshots through the Hub plan events RPC JSON codec", () => {
    const currentSnapshot = snapshot();
    const event = {
      sequence: 3,
      planId: currentSnapshot.id,
      hubId: currentSnapshot.hubId,
      kind: "plan.review-submitted",
      payload: {
        snapshot: currentSnapshot,
        summary: "Review summary",
        nodeKey: "reviewer",
        attemptId: "attempt-2",
      },
      createdAt: "2026-10-22T00:00:00Z",
    };
    const codec = Schema.toCodecJson(Rpc.exitSchema(WsHubPlansEventsRpc));
    const wire = JSON.parse(JSON.stringify(Schema.encodeUnknownSync(codec)(Exit.succeed([event]))));

    expect(wire).toEqual({
      _tag: "Success",
      value: [
        {
          ...event,
          payload: { snapshot: currentSnapshot, summary: "Review summary" },
        },
      ],
    });
    const roundTrip = Schema.decodeUnknownSync(codec)(wire);
    expect(Exit.isSuccess(roundTrip)).toBe(true);
    if (!Exit.isSuccess(roundTrip)) throw new Error("Expected plan events RPC success");
    expect(roundTrip.value[0]?.payload).toEqual({
      snapshot: currentSnapshot,
      summary: "Review summary",
    });
  });

  it("retains original question content and answer receipts in event payloads", () => {
    const inputRequest = {
      id: "question-1",
      nodeKey: "author",
      stageKey: "draft",
      generation: 1,
      attemptId: "attempt-1",
      workerThreadId: "worker-thread-1",
      questions: [{ title: "Which format?", options: ["Markdown", "PDF"] }],
      status: "pending" as const,
    };
    const event = {
      sequence: 4,
      planId: "plan-1",
      hubId: "project-1",
      kind: "plan.input-requested",
      payload: { snapshot: snapshot(), inputRequest },
      createdAt: "2026-10-22T00:00:00Z",
    };
    const decoded = Schema.decodeUnknownSync(HubPlanEventSchema)(event);
    expect(decoded.payload.inputRequest).toEqual(inputRequest);
    expect(
      Schema.is(HubPlanInputRequestSchema)({
        ...inputRequest,
        status: "answered",
        answers: ["PDF"],
      }),
    ).toBe(true);
    expect(Schema.is(HubPlanInputRequestSchema)({ ...inputRequest, status: "answered" })).toBe(
      true,
    );
  });

  it("bounds proposal message references and rejects unknown request authority", () => {
    const input = {
      hubId: "project-1",
      requestId: "request-1",
      planId: "plan-1",
      expectedStateVersion: null,
      definition: snapshot().definition,
      sourceMessageIds: ["message-1"],
    };
    expect(Schema.is(HubPlanProposeInputSchema)(input)).toBe(true);
    expect(Schema.is(HubPlanProposeInputSchema)({ ...input, sourceMessageIds: [] })).toBe(false);
    expect(
      Schema.is(HubPlanProposeInputSchema)({
        ...input,
        sourceMessageIds: Array(HUB_PLAN_MAX_SOURCE_MESSAGES + 1).fill("m"),
      }),
    ).toBe(false);
    expect(Schema.is(HubPlanProposeInputSchema)({ ...input, canApprove: true })).toBe(false);
  });

  it("accepts each discriminated command and rejects unknown or mismatched fields", () => {
    const simpleActions = ["confirm", "pause", "resume", "cancel"] as const;
    const simpleCommands = simpleActions.map((action) => Object.assign(commandBase(), { action }));
    const release = {
      ...commandBase(),
      action: "release" as const,
      stageKey: "draft",
      generation: 1,
      candidateId: "candidate-1",
      outputDigest: "sha256:abc",
    };
    const submitCandidate = {
      ...commandBase(),
      action: "submitCandidate" as const,
      stageKey: "draft",
      generation: 1,
      nodeKey: "author",
      attemptId: "attempt-1",
      deliverableRefs: [deliverableReference()],
      summary: "Candidate summary",
    };
    const submitReview = {
      ...commandBase(),
      action: "submitReview" as const,
      stageKey: "draft",
      generation: 1,
      nodeKey: "reviewer",
      attemptId: "attempt-2",
      candidateId: "candidate-1",
      outputDigest: "sha256:abc",
      outcome: "pass" as const,
      summary: "Review summary",
    };
    const retry = {
      ...commandBase(),
      action: "retry" as const,
      nodeKey: "author",
      stageKey: "draft",
      generation: 1,
      attemptId: "attempt-1",
    };

    for (const input of [
      ...simpleCommands,
      release,
      { ...release, action: "return" as const, comment: "Revise the candidate" },
      submitCandidate,
      submitReview,
      retry,
    ]) {
      expect(Schema.is(HubPlanCommandInputSchema)(input)).toBe(true);
    }
    const simple = simpleCommands[0];
    expect(Schema.is(HubPlanCommandInputSchema)({ ...simple, actor: "client" })).toBe(false);
    expect(Schema.is(HubPlanCommandInputSchema)({ ...simple, canApprove: true })).toBe(false);
    expect(Schema.is(HubPlanCommandInputSchema)({ ...simple, stageKey: "draft" })).toBe(false);
    expect(
      Schema.is(HubPlanCommandInputSchema)({
        ...submitCandidate,
        deliverableRefs: [
          {
            ...deliverableReference(),
            file: { ...deliverableReference().file, body: "client-controlled" },
          },
        ],
      }),
    ).toBe(false);
  });

  it("round-trips fixed candidate references and rejects selector aliases", () => {
    const input = {
      ...commandBase(),
      action: "submitCandidate" as const,
      stageKey: "draft",
      generation: 1,
      nodeKey: "author",
      attemptId: "attempt-1",
      deliverableRefs: [deliverableReference()],
      summary: "Candidate summary",
    };
    const serialized = JSON.stringify(input);
    const decoded = Schema.decodeUnknownSync(HubPlanSubmitCandidateCommandSchema)(
      JSON.parse(serialized),
    );
    const invalidReference = JSON.parse(JSON.stringify(deliverableReference())) as Record<
      string,
      unknown
    >;
    delete invalidReference.workerThreadId;
    invalidReference.ownerThreadId = "thread-1";

    expect(decoded).toEqual(input);
    expect(() =>
      Schema.decodeUnknownSync(HubPlanSubmitCandidateCommandSchema)({
        ...input,
        deliverableRefs: [invalidReference],
      }),
    ).toThrow();
  });
});
