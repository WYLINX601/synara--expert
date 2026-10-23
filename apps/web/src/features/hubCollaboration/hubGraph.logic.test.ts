import {
  ProjectId,
  ProjectTaskId,
  ProjectTaskAttemptId,
  ThreadId,
  type HubPlanNodeState,
  type HubPlanSnapshot,
} from "@synara/contracts";
import { describe, expect, it } from "vitest";

import {
  hubGraphDefaultStageKey,
  hubGraphGlobalStatus,
  hubGraphNodes,
  hubGraphStageWaitsForUpstream,
} from "./hubGraph.logic";

type NodeDefinition = HubPlanSnapshot["definition"]["nodes"][number];
type HubReviewOutcome = "pass" | "changes_requested" | "blocked";

function definitionNode(
  key: string,
  role: NodeDefinition["role"],
  options: { title?: string; dependsOnNodeKeys?: string[]; stageKey?: string } = {},
): NodeDefinition {
  return {
    key,
    stageKey: options.stageKey ?? "stage-a",
    title: options.title ?? `${key} task`,
    brief: `${key} brief`,
    role,
    dependsOnNodeKeys: options.dependsOnNodeKeys ?? [],
    workMode: "agent",
    acceptanceCriteria: `${key} acceptance criteria`,
  };
}

function nodeState(
  nodeKey: string,
  options: Partial<Omit<HubPlanNodeState, "nodeKey" | "taskId" | "attemptId">> & {
    reviewOutcome?: HubReviewOutcome;
  } = {},
): HubPlanNodeState {
  return {
    nodeKey,
    taskId: ProjectTaskId.makeUnsafe(`task-${nodeKey}`),
    workerThreadId: options.workerThreadId ?? null,
    attemptId: null,
    ...options,
  };
}

function snapshot(
  options: {
    controlState?: HubPlanSnapshot["controlState"];
    releasePolicy?: "auto" | "user";
    stageStatus?: HubPlanSnapshot["graph"]["stages"][number]["status"];
    isReleased?: boolean;
    candidateId?: string | null;
    nodes?: NodeDefinition[];
    nodeStates?: HubPlanNodeState[];
  } = {},
): HubPlanSnapshot {
  const controlState = options.controlState ?? "active";
  const stageStatus = options.stageStatus ?? "running";
  return {
    id: "plan-a",
    hubId: ProjectId.makeUnsafe("hub-a"),
    goalId: null,
    revision: 1,
    stateVersion: 1,
    controlState,
    definition: {
      objective: "Plan objective",
      scope: "Plan scope",
      stages: [
        { key: "stage-a", title: "Stage A", releasePolicy: options.releasePolicy ?? "auto" },
      ],
      nodes: options.nodes ?? [definitionNode("node-a", "author")],
      maxRepairRounds: 0,
    },
    createdAt: "2026-10-22T10:00:00.000Z",
    updatedAt: "2026-10-22T10:00:00.000Z",
    graph: {
      controlState,
      stages: [
        {
          stageKey: "stage-a",
          title: "Stage A",
          releasePolicy: options.releasePolicy ?? "auto",
          generation: null,
          status: stageStatus,
          underlyingStatus: stageStatus,
          isReleased: options.isReleased ?? false,
          candidateId: options.candidateId ?? null,
          outputDigest: null,
          outputSummary: null,
          blockingReasons: [],
        },
      ],
      releasedCount: options.isReleased ? 1 : 0,
      stageCount: 1,
    },
    nodeStates: options.nodeStates ?? [],
    eventSequence: 1,
  };
}

function twoStageSnapshot(options: {
  upstreamStatus: HubPlanSnapshot["graph"]["stages"][number]["status"];
  upstreamReleased?: boolean;
  upstreamReleasePolicy?: "auto" | "user";
  downstreamStatus: HubPlanSnapshot["graph"]["stages"][number]["status"];
  downstreamDependsOnUpstream?: boolean;
  nodeStates?: HubPlanNodeState[];
}): HubPlanSnapshot {
  const base = snapshot();
  const upstreamReleasePolicy = options.upstreamReleasePolicy ?? "auto";
  const upstreamReleased = options.upstreamReleased ?? false;
  const upstreamStage = {
    ...base.graph.stages[0]!,
    stageKey: "stage-a",
    title: "Stage A",
    releasePolicy: upstreamReleasePolicy,
    status: options.upstreamStatus,
    underlyingStatus: options.upstreamStatus,
    isReleased: upstreamReleased,
  };
  const downstreamStage = {
    ...base.graph.stages[0]!,
    stageKey: "stage-b",
    title: "Stage B",
    releasePolicy: "auto" as const,
    status: options.downstreamStatus,
    underlyingStatus: options.downstreamStatus,
    isReleased: false,
  };
  return {
    ...base,
    definition: {
      ...base.definition,
      stages: [
        { key: "stage-a", title: "Stage A", releasePolicy: upstreamReleasePolicy },
        { key: "stage-b", title: "Stage B", releasePolicy: "auto" },
      ],
      nodes: [
        definitionNode("node-a", "author", { stageKey: "stage-a" }),
        definitionNode("node-b", "author", {
          stageKey: "stage-b",
          dependsOnNodeKeys: options.downstreamDependsOnUpstream ? ["node-a"] : [],
        }),
      ],
    },
    graph: {
      ...base.graph,
      stages: [upstreamStage, downstreamStage],
      releasedCount: upstreamReleased ? 1 : 0,
      stageCount: 2,
    },
    nodeStates: options.nodeStates ?? [],
  };
}

describe("Hub pipeline graph projection", () => {
  it("projects current directed questions separately from the native work lifecycle", () => {
    const initial = snapshot({
      nodeStates: [
        {
          ...nodeState("node-a", { taskStatus: "running", workState: "idle" }),
          attemptId: ProjectTaskAttemptId.makeUnsafe("attempt-a"),
          workerThreadId: ThreadId.makeUnsafe("worker-a"),
        },
      ],
    });
    const current = {
      ...initial,
      graph: {
        ...initial.graph,
        stages: initial.graph.stages.map((stage) => ({ ...stage, generation: 1 })),
      },
    };
    const request = {
      id: "question-a",
      nodeKey: "node-a",
      stageKey: "stage-a",
      generation: 1,
      attemptId: ProjectTaskAttemptId.makeUnsafe("attempt-a"),
      workerThreadId: ThreadId.makeUnsafe("worker-a"),
      questions: [{ title: "Which scope should I use?" }],
      status: "pending" as const,
    };
    const waiting = { ...current, inputRequests: [request] };
    expect(hubGraphNodes(waiting, "stage-a").levels[0]?.[0]).toMatchObject({
      status: "waiting",
      statusLabel: "等待回复",
    });
    expect(hubGraphGlobalStatus(waiting)).toBe("等待回复");
    expect(waiting.nodeStates[0]?.workState).toBe("idle");
    const answered = { ...current, inputRequests: [{ ...request, status: "answered" as const }] };
    expect(hubGraphNodes(answered, "stage-a").levels[0]?.[0]?.statusLabel).toBe("等待送达");
    expect(hubGraphGlobalStatus(answered)).toBe("等待送达");

    for (const changed of [
      { generation: 2 },
      { attemptId: ProjectTaskAttemptId.makeUnsafe("attempt-old") },
      { workerThreadId: ThreadId.makeUnsafe("worker-old") },
      { stageKey: "other-stage" },
      { status: "stale" as const },
      { status: "delivered" as const },
    ]) {
      expect(
        hubGraphNodes({ ...current, inputRequests: [{ ...request, ...changed }] }, "stage-a")
          .levels[0]?.[0]?.statusLabel,
      ).toBe("等待成果");
    }
    for (const taskStatus of ["done", "cancelled"] as const) {
      expect(
        hubGraphNodes(
          { ...waiting, nodeStates: [{ ...waiting.nodeStates[0]!, taskStatus }] },
          "stage-a",
        ).levels[0]?.[0]?.statusLabel,
      ).toBe(taskStatus === "done" ? "已完成" : "已取消");
    }
  });

  it("groups dependency peers at the same horizontal level and splits role prefixes", () => {
    const graph = hubGraphNodes(
      snapshot({
        nodes: [
          definitionNode("author", "author", { title: "产品经理：明确目标" }),
          definitionNode("reviewer-a", "reviewer", { dependsOnNodeKeys: ["author"] }),
          definitionNode("worker-a", "worker", { dependsOnNodeKeys: ["author"] }),
          definitionNode("worker-b", "worker", {
            dependsOnNodeKeys: ["reviewer-a", "worker-a"],
          }),
        ],
      }),
      "stage-a",
    );

    expect(graph.levels.map((level) => level.map((node) => node.key))).toEqual([
      ["author"],
      ["reviewer-a", "worker-a"],
      ["worker-b"],
    ]);
    expect(graph.levels[0]?.[0]).toMatchObject({
      roleLabel: "产品经理",
      taskTitle: "明确目标",
      status: "pending",
      statusLabel: "未开始",
    });
    expect(graph.gate).toBeNull();
  });

  it("does not infer completed node work from a candidate or release-ready stage", () => {
    const graph = hubGraphNodes(
      snapshot({
        stageStatus: "ready_to_release",
        candidateId: "candidate-a",
        nodes: [definitionNode("author", "author"), definitionNode("reviewer", "reviewer")],
      }),
      "stage-a",
    );

    expect(graph.levels.flat().map((node) => node.status)).toEqual(["pending", "pending"]);
  });

  it("keeps stage release as the compatibility signal for completed nodes", () => {
    const graph = hubGraphNodes(snapshot({ stageStatus: "released" }), "stage-a");

    expect(graph.levels[0]?.[0]).toMatchObject({ status: "completed", statusLabel: "已完成" });
  });

  it("preserves negative review outcomes over task done and lets pass plus done complete", () => {
    const graph = hubGraphNodes(
      snapshot({
        nodes: [
          definitionNode("review-blocked", "author"),
          definitionNode("review-changes", "reviewer"),
          definitionNode("review-pass", "worker"),
        ],
        nodeStates: [
          nodeState("review-blocked", { taskStatus: "done", reviewOutcome: "blocked" }),
          nodeState("review-changes", { taskStatus: "done", reviewOutcome: "changes_requested" }),
          nodeState("review-pass", { taskStatus: "done", reviewOutcome: "pass" }),
        ],
      }),
      "stage-a",
    );

    expect(graph.levels.flat().map((node) => [node.status, node.statusLabel])).toEqual([
      ["blocked", "审核受阻"],
      ["blocked", "需要修改"],
      ["completed", "已完成"],
    ]);

    const releasedGraph = hubGraphNodes(
      snapshot({
        isReleased: true,
        nodeStates: [nodeState("node-a", { taskStatus: "done", reviewOutcome: "blocked" })],
      }),
      "stage-a",
    );
    expect(releasedGraph.levels[0]?.[0]).toMatchObject({
      status: "completed",
      statusLabel: "已完成",
    });
  });

  it("uses explicit task and work state, with retryable failures marked as unsubmitted", () => {
    const graph = hubGraphNodes(
      snapshot({
        nodes: [
          definitionNode("done", "author"),
          definitionNode("retry", "reviewer"),
          definitionNode("failed", "worker"),
          definitionNode("running", "worker"),
          definitionNode("queued", "worker"),
          definitionNode("waiting", "worker"),
          definitionNode("idle", "worker"),
          definitionNode("planned", "worker"),
          definitionNode("legacy-running", "worker"),
        ],
        nodeStates: [
          nodeState("done", { taskStatus: "done" }),
          nodeState("retry", { retryable: true, workState: "failed" }),
          nodeState("failed", { taskStatus: "blocked" }),
          nodeState("running", { workState: "starting" }),
          nodeState("queued", { taskStatus: "running", workState: "queued" }),
          nodeState("waiting", { taskStatus: "running", workState: "waiting" }),
          nodeState("idle", { taskStatus: "running", workState: "completed" }),
          nodeState("planned", { taskStatus: "ready" }),
          nodeState("legacy-running", {
            taskStatus: "running",
            workerThreadId: ThreadId.makeUnsafe("thread-legacy-running"),
          }),
        ],
      }),
      "stage-a",
    );

    expect(graph.levels.flat().map((node) => [node.status, node.statusLabel])).toEqual([
      ["completed", "已完成"],
      ["blocked", "执行失败"],
      ["blocked", "受阻"],
      ["running", "运行中"],
      ["queued", "排队中"],
      ["waiting", "等待中"],
      ["waiting", "等待成果"],
      ["pending", "未开始"],
      ["dispatched", "已派发"],
    ]);
  });

  it("keeps a thread-only historical node dispatched instead of calling it running", () => {
    const graph = hubGraphNodes(
      snapshot({
        nodeStates: [nodeState("node-a", { workerThreadId: ThreadId.makeUnsafe("thread-a") })],
      }),
      "stage-a",
    );

    expect(graph.levels[0]?.[0]).toMatchObject({ status: "dispatched", statusLabel: "已派发" });
  });

  it("models the user release gate as waiting for confirmation only when active", () => {
    const waiting = hubGraphNodes(
      snapshot({ releasePolicy: "user", stageStatus: "waiting_user" }),
      "stage-a",
    ).gate;
    const paused = hubGraphNodes(
      snapshot({ controlState: "paused", releasePolicy: "user", stageStatus: "waiting_user" }),
      "stage-a",
    ).gate;
    const released = hubGraphNodes(
      snapshot({ releasePolicy: "user", stageStatus: "released", isReleased: true }),
      "stage-a",
    ).gate;

    expect(waiting).toMatchObject({
      key: "stage-a:release",
      nodeKey: null,
      status: "awaiting_confirmation",
      statusLabel: "待人工确认",
    });
    expect(paused).toMatchObject({ status: "pending", statusLabel: "未开始" });
    expect(released).toMatchObject({ status: "completed", statusLabel: "已放行" });
  });

  it("includes blocked and queued stage projections when node work facts are absent", () => {
    const blocked = snapshot({ stageStatus: "blocked" });
    const queued = snapshot({ stageStatus: "queued" });

    expect(blocked.nodeStates).toEqual([]);
    expect(
      hubGraphNodes(blocked, "stage-a")
        .levels.flat()
        .map((node) => node.status),
    ).toEqual(["pending"]);
    expect(hubGraphGlobalStatus(blocked)).toBe("受阻");
    expect(queued.nodeStates).toEqual([]);
    expect(hubGraphGlobalStatus(queued)).toBe("排队中");
    expect(hubGraphGlobalStatus(snapshot({ stageStatus: "changes_requested" }))).toBe("需要修改");
  });

  it("treats a blocked downstream stage as waiting when its upstream stage is unreleased", () => {
    const activeUpstream = twoStageSnapshot({
      upstreamStatus: "running",
      downstreamStatus: "blocked",
      downstreamDependsOnUpstream: true,
      nodeStates: [nodeState("node-a", { workState: "working" })],
    });

    expect(hubGraphStageWaitsForUpstream(activeUpstream, "stage-b")).toBe(true);
    expect(hubGraphGlobalStatus(activeUpstream)).toBe("运行中");
    expect(hubGraphDefaultStageKey(activeUpstream)).toBe("stage-a");
  });

  it("keeps a waiting user release ahead of a blocked dependent stage", () => {
    const waitingForUser = twoStageSnapshot({
      upstreamStatus: "waiting_user",
      upstreamReleasePolicy: "user",
      downstreamStatus: "blocked",
      downstreamDependsOnUpstream: true,
    });

    expect(hubGraphStageWaitsForUpstream(waitingForUser, "stage-b")).toBe(true);
    expect(hubGraphGlobalStatus(waitingForUser)).toBe("待人工确认");
    expect(hubGraphDefaultStageKey(waitingForUser)).toBe("stage-a");
  });

  it("prefers a downstream stage with real blocked node facts after upstream release", () => {
    const downstreamBlocked = twoStageSnapshot({
      upstreamStatus: "released",
      upstreamReleased: true,
      downstreamStatus: "blocked",
      downstreamDependsOnUpstream: true,
      nodeStates: [nodeState("node-b", { taskStatus: "blocked" })],
    });

    expect(hubGraphStageWaitsForUpstream(downstreamBlocked, "stage-b")).toBe(false);
    expect(hubGraphGlobalStatus(downstreamBlocked)).toBe("受阻");
    expect(hubGraphDefaultStageKey(downstreamBlocked)).toBe("stage-b");
  });

  it("keeps an independent parallel blocked stage actionable", () => {
    const parallelBlocked = twoStageSnapshot({
      upstreamStatus: "running",
      downstreamStatus: "blocked",
      nodeStates: [nodeState("node-a", { workState: "working" })],
    });

    expect(hubGraphStageWaitsForUpstream(parallelBlocked, "stage-b")).toBe(false);
    expect(hubGraphGlobalStatus(parallelBlocked)).toBe("受阻");
    expect(hubGraphDefaultStageKey(parallelBlocked)).toBe("stage-b");
  });

  it("summarizes active state from node states and lets terminal control state take precedence", () => {
    expect(
      hubGraphGlobalStatus(
        snapshot({ stageStatus: "ready_to_release", candidateId: "candidate-a" }),
      ),
    ).toBe("等待中");
    expect(
      hubGraphGlobalStatus(
        snapshot({ nodeStates: [nodeState("node-a", { workState: "working" })] }),
      ),
    ).toBe("运行中");
    const taskDoneButUnreleased = snapshot({
      nodeStates: [nodeState("node-a", { taskStatus: "done" })],
    });
    expect(hubGraphNodes(taskDoneButUnreleased, "stage-a").levels[0]?.[0]?.status).toBe(
      "completed",
    );
    expect(hubGraphGlobalStatus(taskDoneButUnreleased)).toBe("等待中");
    expect(hubGraphGlobalStatus(snapshot({ isReleased: true }))).toBe("已完成");
    expect(
      hubGraphGlobalStatus(
        snapshot({
          controlState: "paused",
          nodeStates: [nodeState("node-a", { retryable: true })],
        }),
      ),
    ).toBe("已暂停");
    expect(
      hubGraphGlobalStatus(snapshot({ controlState: "paused", stageStatus: "changes_requested" })),
    ).toBe("已暂停");
    expect(hubGraphGlobalStatus(snapshot({ controlState: "completed" }))).toBe("已完成");
  });
});
