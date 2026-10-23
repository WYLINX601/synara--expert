import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
  HUB_PLAN_MAX_REVIEWERS_PER_STAGE,
  HubPlanDefinitionSchema,
  type HubPlanDefinition,
} from "@synara/contracts";
import {
  computeHubStageViews,
  isRetryableHubPlanAttempt,
  validateHubPlanDefinition,
  type HubPlanGraphFacts,
  type HubPlanReviewFact,
  type HubPlanTaskFact,
} from "./planGraph";

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

const threeStagePlan = (): HubPlanDefinition => ({
  objective: "Deliver a reviewed result",
  scope: "Three stages with a user decision at the solution exit",
  stages: [
    { key: "requirements", title: "Requirements", releasePolicy: "auto" },
    { key: "solution", title: "Solution", releasePolicy: "user" },
    { key: "delivery", title: "Delivery", releasePolicy: "auto" },
  ],
  nodes: [
    node("requirements-author", "requirements"),
    node("solution-author", "solution", "author", ["requirements-author"]),
    node("solution-reviewer-a", "solution", "reviewer", ["solution-author"]),
    node("solution-reviewer-b", "solution", "reviewer", ["solution-author"]),
    node("delivery-author", "delivery", "author", ["solution-reviewer-a"]),
  ],
  maxRepairRounds: 3,
});

const task = (
  nodeKey: string,
  options: {
    taskStatus?: HubPlanTaskFact["taskStatus"];
    attemptId?: string;
    generation?: number;
    workState?: NonNullable<HubPlanTaskFact["currentAttempt"]>["workState"];
  } = {},
): HubPlanTaskFact => ({
  nodeKey,
  taskStatus: options.taskStatus ?? "done",
  currentAttempt: {
    attemptId: options.attemptId ?? `${nodeKey}-attempt`,
    generation: options.generation ?? 1,
    workState: options.workState ?? "completed",
  },
});

const baseFacts = (): HubPlanGraphFacts => ({
  controlState: "active",
  stageGenerations: { requirements: 1, solution: 1, delivery: 1 },
  tasks: [
    task("requirements-author"),
    task("solution-author"),
    task("solution-reviewer-a"),
    task("solution-reviewer-b"),
    task("delivery-author", { taskStatus: "planned", workState: "idle" }),
  ],
  currentCandidates: [
    {
      stageKey: "requirements",
      generation: 1,
      candidateId: "requirements-candidate",
      outputDigest: "sha256:req",
      authorNodeKey: "requirements-author",
      authorAttemptId: "requirements-author-attempt",
      summary: "Requirements accepted",
      status: "current",
    },
    {
      stageKey: "solution",
      generation: 1,
      candidateId: "solution-candidate",
      outputDigest: "sha256:solution",
      authorNodeKey: "solution-author",
      authorAttemptId: "solution-author-attempt",
      summary: "Reviewed solution draft",
      status: "current",
    },
  ],
  effectiveReviews: [
    {
      stageKey: "solution",
      generation: 1,
      candidateId: "solution-candidate",
      outputDigest: "sha256:solution",
      reviewerNodeKey: "solution-reviewer-a",
      attemptId: "solution-reviewer-a-attempt",
      outcome: "pass",
      status: "submitted",
    },
    {
      stageKey: "solution",
      generation: 1,
      candidateId: "solution-candidate",
      outputDigest: "sha256:solution",
      reviewerNodeKey: "solution-reviewer-b",
      attemptId: "solution-reviewer-b-attempt",
      outcome: "pass",
      status: "submitted",
    },
  ],
  effectiveReleases: [
    {
      stageKey: "requirements",
      generation: 1,
      candidateId: "requirements-candidate",
      outputDigest: "sha256:req",
      source: "auto",
      effective: true,
    },
  ],
});

describe("validateHubPlanDefinition", () => {
  it("checks unique keys, stage bindings, dependencies, self edges, and task cycles", () => {
    const valid = threeStagePlan();
    expect(validateHubPlanDefinition(valid)).toEqual([]);

    const invalid = {
      ...valid,
      nodes: [
        ...valid.nodes,
        node("delivery-author", "missing-stage", "worker", ["missing-node", "delivery-author"]),
      ],
    };
    const codes = validateHubPlanDefinition(invalid).map((issue) => issue.code);
    expect(codes).toContain("node.duplicate_key");
    expect(codes).toContain("node.unknown_stage");
    expect(codes).toContain("dependency.unknown_node");
    expect(codes).toContain("dependency.self_edge");
  });

  it("rejects a cycle in the atomic Task dependency graph", () => {
    const input = {
      objective: "Avoid a task cycle",
      scope: "The nodes form one cyclic chain",
      stages: [{ key: "work", title: "Work", releasePolicy: "auto" as const }],
      nodes: [
        node("author", "work", "author", ["last"]),
        node("middle", "work", "worker", ["author"]),
        node("last", "work", "worker", ["middle"]),
      ],
      maxRepairRounds: 0,
    };

    expect(validateHubPlanDefinition(input).map((issue) => issue.code)).toContain(
      "dependency.task_cycle",
    );
  });

  it("rejects an acyclic task graph whose stage aggregation cycles A to B to A", () => {
    const input = {
      objective: "Check stage aggregation",
      scope: "A1 -> B1 -> A2 remains task-acyclic but blocks stage exits",
      stages: [
        { key: "A", title: "A", releasePolicy: "auto" as const },
        { key: "B", title: "B", releasePolicy: "auto" as const },
      ],
      nodes: [
        node("A1", "A"),
        node("B1", "B", "author", ["A1"]),
        node("A2", "A", "worker", ["B1"]),
      ],
      maxRepairRounds: 1,
    };
    const issues = validateHubPlanDefinition(input);

    expect(issues.map((issue) => issue.code)).not.toContain("dependency.task_cycle");
    expect(issues).toContainEqual(
      expect.objectContaining({ code: "dependency.stage_cycle", path: "stages" }),
    );
  });

  it("requires each reviewer to have a same-stage author in its transitive ancestors", () => {
    const valid = {
      objective: "Review a result",
      scope: "The reviewer depends on the author through a worker node",
      stages: [{ key: "work", title: "Work", releasePolicy: "user" as const }],
      nodes: [
        node("author", "work"),
        node("prep", "work", "worker", ["author"]),
        node("review", "work", "reviewer", ["prep"]),
      ],
      maxRepairRounds: 0,
    };
    expect(validateHubPlanDefinition(valid)).toEqual([]);

    const invalid = {
      ...valid,
      nodes: [node("author", "work"), node("review", "work", "reviewer")],
    };
    expect(validateHubPlanDefinition(invalid).map((issue) => issue.code)).toContain(
      "reviewer.missing_author_ancestor",
    );
  });

  it("rejects empty stages and more than the per-stage reviewer cap", () => {
    const input = {
      objective: "Bound a plan",
      scope: "The stage and reviewers stay within explicit limits",
      stages: [
        { key: "work", title: "Work", releasePolicy: "auto" as const },
        { key: "empty", title: "Empty", releasePolicy: "auto" as const },
      ],
      nodes: [
        node("author", "work"),
        ...Array.from({ length: HUB_PLAN_MAX_REVIEWERS_PER_STAGE + 1 }, (_, index) =>
          node(`review-${index}`, "work", "reviewer", ["author"]),
        ),
      ],
      maxRepairRounds: 0,
    };

    const issues = validateHubPlanDefinition(input);
    expect(issues.map((issue) => issue.code)).toContain("stage.empty");
    expect(issues.map((issue) => issue.code)).toContain("stage.too_many_reviewers");
    expect(Schema.is(HubPlanDefinitionSchema)(input)).toBe(false);
  });

  it("requires exactly one author node in every stage for the single-candidate model", () => {
    const input = {
      objective: "Use one candidate author per stage",
      scope: "Each stage candidate maps to exactly one author attempt",
      stages: [{ key: "work", title: "Work", releasePolicy: "auto" as const }],
      nodes: [node("author-a", "work"), node("author-b", "work")],
      maxRepairRounds: 0,
    };

    expect(validateHubPlanDefinition(input).map((issue) => issue.code)).toContain(
      "stage.author_count",
    );
    expect(Schema.is(HubPlanDefinitionSchema)(input)).toBe(false);
  });

  it("returns a structured schema issue instead of throwing for malformed input", () => {
    expect(validateHubPlanDefinition({ nodes: [], stages: [] })).toEqual([
      expect.objectContaining({ code: "schema.invalid", path: "$", message: expect.any(String) }),
    ]);
  });
});

describe("computeHubStageViews", () => {
  it("keeps a professionally reviewed user-exit stage at 1/3 until user release", () => {
    const view = computeHubStageViews(threeStagePlan(), baseFacts());

    expect(view.releasedCount).toBe(1);
    expect(view.stageCount).toBe(3);
    expect(view.stages.find((stage) => stage.stageKey === "solution")).toMatchObject({
      status: "waiting_user",
      isReleased: false,
      outputDigest: "sha256:solution",
      outputSummary: "Reviewed solution draft",
    });
  });

  it("requires all parallel reviewer tasks to pass for the same candidate", () => {
    const facts = baseFacts();
    const oneReview = {
      ...facts,
      effectiveReviews: facts.effectiveReviews.slice(0, 1),
    };
    const oneReviewView = computeHubStageViews(threeStagePlan(), oneReview);
    expect(oneReviewView.stages.find((stage) => stage.stageKey === "solution")?.status).toBe(
      "reviewing",
    );
    expect(oneReviewView.releasedCount).toBe(1);

    const allReviewsView = computeHubStageViews(threeStagePlan(), facts);
    expect(allReviewsView.stages.find((stage) => stage.stageKey === "solution")?.status).toBe(
      "waiting_user",
    );
    const userReleasedView = computeHubStageViews(threeStagePlan(), {
      ...facts,
      effectiveReleases: [
        ...facts.effectiveReleases,
        {
          stageKey: "solution",
          generation: 1,
          candidateId: "solution-candidate",
          outputDigest: "sha256:solution",
          source: "user",
          effective: true,
        },
      ],
    });
    expect(userReleasedView.releasedCount).toBe(2);
    expect(userReleasedView.stages.find((stage) => stage.stageKey === "solution")?.status).toBe(
      "released",
    );
  });

  it("does not count an old-generation review", () => {
    const facts = baseFacts();
    const oldReview: HubPlanReviewFact = {
      ...facts.effectiveReviews[0]!,
      generation: 0,
    };
    const view = computeHubStageViews(threeStagePlan(), {
      ...facts,
      stageGenerations: { ...facts.stageGenerations, solution: 2 },
      tasks: facts.tasks.map((item) =>
        item.nodeKey.startsWith("solution-")
          ? {
              ...item,
              currentAttempt: {
                attemptId: item.currentAttempt!.attemptId,
                generation: 2,
                workState: "completed" as const,
              },
            }
          : item,
      ),
      currentCandidates: facts.currentCandidates.map((item) =>
        item.stageKey === "solution"
          ? {
              ...item,
              generation: 2,
              authorAttemptId: "solution-author-attempt",
            }
          : item,
      ),
      effectiveReviews: [oldReview, { ...facts.effectiveReviews[1]!, generation: 2 }],
    });

    expect(view.stages.find((stage) => stage.stageKey === "solution")?.status).toBe("reviewing");
    expect(view.releasedCount).toBe(1);
  });

  it("does not accept a release whose output digest differs from the current candidate", () => {
    const facts = baseFacts();
    const view = computeHubStageViews(threeStagePlan(), {
      ...facts,
      effectiveReleases: [
        ...facts.effectiveReleases,
        {
          stageKey: "solution",
          generation: 1,
          candidateId: "solution-candidate",
          outputDigest: "sha256:stale-output",
          source: "user",
          effective: true,
        },
      ],
    });

    expect(view.stages.find((stage) => stage.stageKey === "solution")).toMatchObject({
      status: "waiting_user",
      isReleased: false,
    });
    expect(view.releasedCount).toBe(1);
  });

  it("does not count draft candidates or draft reviews", () => {
    const facts = baseFacts();
    const draftCandidate = {
      ...facts.currentCandidates[1]!,
      status: "draft" as const,
    };
    const view = computeHubStageViews(threeStagePlan(), {
      ...facts,
      currentCandidates: [facts.currentCandidates[0]!, draftCandidate],
      effectiveReviews: facts.effectiveReviews.map((review) => ({
        ...review,
        status: "draft" as const,
      })),
    });

    expect(view.stages.find((stage) => stage.stageKey === "solution")).toMatchObject({
      status: "awaiting_candidate",
      isReleased: false,
    });
    expect(view.releasedCount).toBe(1);
  });

  it("keeps released and user-ready stages waiting until every current Work is completed", () => {
    const facts = baseFacts();
    const runningWork = computeHubStageViews(threeStagePlan(), {
      ...facts,
      tasks: facts.tasks.map((item) =>
        item.nodeKey === "solution-reviewer-b"
          ? {
              ...item,
              taskStatus: "done" as const,
              currentAttempt: {
                ...item.currentAttempt!,
                workState: "working" as const,
              },
            }
          : item,
      ),
      effectiveReleases: [
        ...facts.effectiveReleases,
        {
          stageKey: "solution",
          generation: 1,
          candidateId: "solution-candidate",
          outputDigest: "sha256:solution",
          source: "user",
          effective: true,
        },
      ],
    });

    expect(runningWork.stages.find((stage) => stage.stageKey === "requirements")).toMatchObject({
      status: "released",
      isReleased: true,
    });
    expect(runningWork.stages.find((stage) => stage.stageKey === "solution")).toMatchObject({
      status: "running",
      isReleased: false,
    });
    expect(runningWork.stages.find((stage) => stage.stageKey === "delivery")?.status).toBe(
      "blocked",
    );

    const settled = computeHubStageViews(threeStagePlan(), {
      ...facts,
      tasks: facts.tasks.map((item) =>
        item.nodeKey === "delivery-author" ? { ...item, taskStatus: "ready" as const } : item,
      ),
      effectiveReleases: [
        ...facts.effectiveReleases,
        {
          stageKey: "solution",
          generation: 1,
          candidateId: "solution-candidate",
          outputDigest: "sha256:solution",
          source: "user",
          effective: true,
        },
      ],
    });
    expect(settled.stages.find((stage) => stage.stageKey === "solution")).toMatchObject({
      status: "released",
      isReleased: true,
    });
    expect(settled.stages.find((stage) => stage.stageKey === "delivery")?.status).toBe("ready");
  });

  it("advances on accepted results whose exact attempts were cancelled by a plan stop", () => {
    const facts = baseFacts();
    const acceptedFacts: HubPlanGraphFacts = {
      ...facts,
      tasks: facts.tasks.map((item) =>
        item.nodeKey === "solution-author" || item.nodeKey === "solution-reviewer-a"
          ? {
              ...item,
              currentAttempt: {
                ...item.currentAttempt!,
                workState: "cancelled" as const,
                acceptedAfterStop: true,
              },
            }
          : item,
      ),
    };
    const accepted = computeHubStageViews(threeStagePlan(), acceptedFacts);
    expect(accepted.stages.find((stage) => stage.stageKey === "solution")).toMatchObject({
      status: "waiting_user",
      isReleased: false,
    });

    const unverified = computeHubStageViews(threeStagePlan(), {
      ...acceptedFacts,
      tasks: acceptedFacts.tasks.map((item) =>
        item.nodeKey === "solution-reviewer-a"
          ? {
              ...item,
              currentAttempt: { ...item.currentAttempt!, acceptedAfterStop: false },
            }
          : item,
      ),
    });
    expect(unverified.stages.find((stage) => stage.stageKey === "solution")?.status).toBe(
      "blocked",
    );
  });

  it("does not count a draft plan even if release-shaped facts are present", () => {
    const facts = baseFacts();
    const view = computeHubStageViews(threeStagePlan(), { ...facts, controlState: "draft" });

    expect(view.releasedCount).toBe(0);
    expect(view.stages.every((stage) => stage.status === "draft" && !stage.isReleased)).toBe(true);
  });

  it("fails closed when the authoritative current stage generation is missing", () => {
    const facts = baseFacts();
    const stageGenerations = { ...facts.stageGenerations };
    delete (stageGenerations as Record<string, number>).requirements;
    const view = computeHubStageViews(threeStagePlan(), { ...facts, stageGenerations });

    expect(view.stages.find((stage) => stage.stageKey === "requirements")).toMatchObject({
      generation: null,
      status: "blocked",
      isReleased: false,
    });
    expect(view.releasedCount).toBe(0);
  });

  it("requires the accepted auto-release candidate to match the current author attempt", () => {
    const facts = baseFacts();
    const view = computeHubStageViews(threeStagePlan(), {
      ...facts,
      tasks: facts.tasks.map((item) =>
        item.nodeKey === "requirements-author"
          ? {
              ...item,
              currentAttempt: {
                attemptId: "different-attempt",
                generation: 1,
                workState: "completed" as const,
              },
            }
          : item,
      ),
    });

    expect(view.releasedCount).toBe(0);
    expect(view.stages.find((stage) => stage.stageKey === "requirements")).toMatchObject({
      status: "awaiting_candidate",
      isReleased: false,
    });
  });

  it("shows queued and running as different stage states", () => {
    const singleStage: HubPlanDefinition = {
      objective: "Run one task",
      scope: "Queue state remains visible",
      stages: [{ key: "work", title: "Work", releasePolicy: "auto" }],
      nodes: [node("author", "work")],
      maxRepairRounds: 0,
    };
    const makeFacts = (workState: "queued" | "working"): HubPlanGraphFacts => ({
      controlState: "active",
      stageGenerations: { work: 1 },
      tasks: [task("author", { taskStatus: "running", workState })],
      currentCandidates: [],
      effectiveReviews: [],
      effectiveReleases: [],
    });

    expect(computeHubStageViews(singleStage, makeFacts("queued")).stages[0]?.status).toBe("queued");
    expect(computeHubStageViews(singleStage, makeFacts("working")).stages[0]?.status).toBe(
      "running",
    );
  });

  it("blocks a completed provider turn with no accepted result and exposes retryability", () => {
    const singleStage: HubPlanDefinition = {
      objective: "Produce one candidate",
      scope: "Retry only a completed turn without accepted output",
      stages: [{ key: "work", title: "Work", releasePolicy: "user" }],
      nodes: [node("author", "work")],
      maxRepairRounds: 0,
    };
    const authorTask = task("author", {
      taskStatus: "running",
      workState: "completed",
    });
    const view = computeHubStageViews(singleStage, {
      controlState: "active",
      stageGenerations: { work: 1 },
      tasks: [{ ...authorTask, retryable: true }],
      currentCandidates: [],
      effectiveReviews: [],
      effectiveReleases: [],
    });

    expect(view.stages[0]).toMatchObject({
      status: "blocked",
      underlyingStatus: "blocked",
      isReleased: false,
    });
    expect(view.stages[0]?.blockingReasons).toContain(
      "A provider turn completed without an accepted node result; an explicit retry is available.",
    );
  });

  it("pauses stage presentation while preserving the number already released", () => {
    const facts = baseFacts();
    const view = computeHubStageViews(threeStagePlan(), { ...facts, controlState: "paused" });

    expect(view.controlState).toBe("paused");
    expect(view.releasedCount).toBe(1);
    expect(view.stages.find((stage) => stage.stageKey === "requirements")).toMatchObject({
      status: "paused",
      underlyingStatus: "released",
      isReleased: true,
    });
  });

  it("does not let an author task marked done release a stage without its review and exit facts", () => {
    const facts = baseFacts();
    const view = computeHubStageViews(threeStagePlan(), {
      ...facts,
      effectiveReviews: [],
      effectiveReleases: facts.effectiveReleases,
    });

    expect(view.releasedCount).toBe(1);
    expect(view.stages.find((stage) => stage.stageKey === "solution")).toMatchObject({
      status: "reviewing",
      isReleased: false,
    });
  });
});

describe("isRetryableHubPlanAttempt", () => {
  it("requires settled failure proof for Worker-role retries", () => {
    const input = {
      planId: "plan",
      hubId: "hub",
      revision: 1,
      currentGeneration: 1,
      node: node("worker", "work", "worker"),
      binding: {
        planId: "plan",
        revision: 1,
        nodeKey: "worker",
        stageGeneration: 1,
        taskId: "task",
        attemptId: "attempt",
        workItemId: "work",
      } as never,
      task: {
        id: "task",
        projectId: "hub",
        status: "running",
        assignedThreadId: "thread",
        archivedAt: null,
      } as never,
      attempt: {
        id: "attempt",
        taskId: "task",
        projectId: "hub",
        workerThreadId: "thread",
      } as never,
      workState: "failed" as const,
      workSlotHeld: false,
      workWorkerThreadId: "thread",
      candidates: [],
      reviews: [],
    };
    const failedSettlement = {
      projectId: "hub",
      threadId: "thread",
      taskId: "task",
      requestId: "work",
      settleOutcome: "failed",
      settledAt: "2026-10-23T00:00:00.000Z",
      resultSummary: null,
      resultAt: null,
    };

    expect(isRetryableHubPlanAttempt({ ...input, managedWorker: failedSettlement as never })).toBe(
      true,
    );
    expect(isRetryableHubPlanAttempt(input)).toBe(false);
    expect(
      isRetryableHubPlanAttempt({
        ...input,
        managedWorker: { ...failedSettlement, requestId: "different-work" } as never,
      }),
    ).toBe(false);
    expect(
      isRetryableHubPlanAttempt({
        ...input,
        managedWorker: { ...failedSettlement, resultSummary: "A Worker result" } as never,
      }),
    ).toBe(false);
    expect(
      isRetryableHubPlanAttempt({
        ...input,
        managedWorker: failedSettlement as never,
        workSlotHeld: true,
      }),
    ).toBe(false);
    expect(
      isRetryableHubPlanAttempt({
        ...input,
        managedWorker: failedSettlement as never,
        hasPendingInputRequest: true,
      }),
    ).toBe(false);
  });
});
