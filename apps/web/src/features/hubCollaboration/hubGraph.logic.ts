import type { HubPlanSnapshot } from "@synara/contracts";

import { hubPlanControlStateLabel } from "./planLabels";

type HubPlanNode = HubPlanSnapshot["definition"]["nodes"][number];
type HubPlanStage = HubPlanSnapshot["graph"]["stages"][number];

export type HubGraphNodeStatus =
  | "completed"
  | "running"
  | "queued"
  | "waiting"
  | "pending"
  | "blocked"
  | "awaiting_confirmation"
  | "dispatched"
  | "cancelled";

export type HubGraphNode = {
  readonly key: string;
  readonly nodeKey: string | null;
  readonly stageKey: string;
  readonly roleLabel: string;
  readonly taskTitle: string;
  readonly status: HubGraphNodeStatus;
  readonly statusLabel: string;
  readonly workerThreadId: HubPlanSnapshot["nodeStates"][number]["workerThreadId"];
};

const ROLE_LABELS = {
  author: "产出",
  reviewer: "审核",
  worker: "执行",
} as const;

function nodeLabels(node: HubPlanNode): { roleLabel: string; taskTitle: string } {
  const separator = node.title.indexOf("：");
  if (separator >= 0) {
    const roleLabel = node.title.slice(0, separator).trim();
    const taskTitle = node.title.slice(separator + 1).trim();
    if (roleLabel && taskTitle) return { roleLabel, taskTitle };
  }

  return { roleLabel: ROLE_LABELS[node.role], taskTitle: node.title };
}

function statusForNode(
  node: HubPlanNode,
  stage: HubPlanStage,
  state: HubPlanSnapshot["nodeStates"][number] | undefined,
  inputStatus?: "pending" | "answered",
): { status: HubGraphNodeStatus; statusLabel: string } {
  if (stage.isReleased || stage.status === "released") {
    return { status: "completed", statusLabel: "已完成" };
  }
  const reviewOutcome = state?.reviewOutcome;
  if (reviewOutcome === "blocked") {
    return { status: "blocked", statusLabel: "审核受阻" };
  }
  if (reviewOutcome === "changes_requested") {
    return { status: "blocked", statusLabel: "需要修改" };
  }
  if (state?.taskStatus === "done") return { status: "completed", statusLabel: "已完成" };
  if (state?.taskStatus === "cancelled" || state?.workState === "cancelled") {
    return { status: "cancelled", statusLabel: "已取消" };
  }
  if (inputStatus) {
    return {
      status: "waiting",
      statusLabel: inputStatus === "pending" ? "等待回复" : "等待送达",
    };
  }
  if (state?.retryable) {
    return {
      status: "blocked",
      statusLabel: state.workState === "failed" ? "执行失败" : "未提交成果",
    };
  }
  if (state?.taskStatus === "blocked" || state?.workState === "failed") {
    return { status: "blocked", statusLabel: "受阻" };
  }
  switch (state?.workState) {
    case "working":
    case "starting":
      return { status: "running", statusLabel: "运行中" };
    case "queued":
      return { status: "queued", statusLabel: "排队中" };
    case "waiting":
      return { status: "waiting", statusLabel: "等待中" };
    case "idle":
    case "completed":
      return { status: "waiting", statusLabel: "等待成果" };
  }
  if (state?.taskStatus === "review") return { status: "waiting", statusLabel: "等待审核" };
  if (state?.taskStatus === "planned" || state?.taskStatus === "ready") {
    return { status: "pending", statusLabel: "未开始" };
  }
  if (state?.taskStatus === "running") return { status: "dispatched", statusLabel: "已派发" };
  if (state?.workerThreadId) return { status: "dispatched", statusLabel: "已派发" };
  return { status: "pending", statusLabel: "未开始" };
}

function dependencyLevels(nodes: readonly HubPlanNode[]): HubPlanNode[][] {
  const nodeKeys = new Set(nodes.map((node) => node.key));
  const levels = new Map<string, number>();
  const remaining = new Set(nodes.map((node) => node.key));

  while (remaining.size > 0) {
    const ready = nodes.filter(
      (node) =>
        remaining.has(node.key) &&
        node.dependsOnNodeKeys.every((key) => !nodeKeys.has(key) || levels.has(key)),
    );

    if (ready.length === 0) {
      const fallbackLevel = Math.max(-1, ...levels.values()) + 1;
      for (const node of nodes) {
        if (!remaining.has(node.key)) continue;
        levels.set(node.key, fallbackLevel);
        remaining.delete(node.key);
      }
      break;
    }

    for (const node of ready) {
      const parentLevels = node.dependsOnNodeKeys
        .filter((key) => nodeKeys.has(key))
        .map((key) => levels.get(key) ?? -1);
      levels.set(node.key, Math.max(-1, ...parentLevels) + 1);
      remaining.delete(node.key);
    }
  }

  const grouped = new Map<number, HubPlanNode[]>();
  for (const node of nodes) {
    const level = levels.get(node.key) ?? 0;
    const peers = grouped.get(level) ?? [];
    peers.push(node);
    grouped.set(level, peers);
  }

  return [...grouped.entries()]
    .toSorted(([left], [right]) => left - right)
    .map(([, peers]) => peers);
}

function stageDependencyKeys(snapshot: HubPlanSnapshot, stageKey: string): string[] {
  const nodesByKey = new Map(snapshot.definition.nodes.map((node) => [node.key, node]));
  const dependencies = new Set<string>();
  for (const node of snapshot.definition.nodes) {
    if (node.stageKey !== stageKey) continue;
    for (const dependencyKey of node.dependsOnNodeKeys) {
      const dependency = nodesByKey.get(dependencyKey);
      if (dependency && dependency.stageKey !== stageKey) dependencies.add(dependency.stageKey);
    }
  }
  return [...dependencies];
}

export function hubGraphStageWaitsForUpstream(
  snapshot: HubPlanSnapshot,
  stageKey: string,
): boolean {
  return stageDependencyKeys(snapshot, stageKey).some(
    (upstreamStageKey) =>
      snapshot.graph.stages.find((stage) => stage.stageKey === upstreamStageKey)?.isReleased !==
      true,
  );
}

function stageHasActionableBlock(snapshot: HubPlanSnapshot, stage: HubPlanStage): boolean {
  if (stage.isReleased || hubGraphStageWaitsForUpstream(snapshot, stage.stageKey)) return false;
  if (stage.status === "blocked" || stage.status === "changes_requested") return true;
  const graph = hubGraphNodes(snapshot, stage.stageKey);
  return graph.levels.flat().some((node) => node.status === "blocked");
}

function releaseGate(
  stage: HubPlanStage,
  controlState: HubPlanSnapshot["controlState"],
): HubGraphNode {
  const completed = stage.isReleased || stage.status === "released";
  const awaitingConfirmation =
    !completed && controlState === "active" && stage.status === "waiting_user";
  const status: HubGraphNodeStatus = completed
    ? "completed"
    : awaitingConfirmation
      ? "awaiting_confirmation"
      : "pending";

  return {
    key: `${stage.stageKey}:release`,
    nodeKey: null,
    stageKey: stage.stageKey,
    roleLabel: "用户",
    taskTitle: "放行",
    status,
    statusLabel: completed ? "已放行" : awaitingConfirmation ? "待人工确认" : "未开始",
    workerThreadId: null,
  };
}

export function hubGraphNodes(
  snapshot: HubPlanSnapshot,
  stageKey: string,
): { levels: HubGraphNode[][]; gate: HubGraphNode | null } {
  const stage = snapshot.graph.stages.find((item) => item.stageKey === stageKey);
  if (!stage) return { levels: [], gate: null };

  const definitions = snapshot.definition.nodes.filter((node) => node.stageKey === stage.stageKey);
  const states = new Map(snapshot.nodeStates.map((state) => [state.nodeKey, state]));
  const levels = dependencyLevels(definitions).map((level) =>
    level.map((node) => {
      const state = states.get(node.key);
      const labels = nodeLabels(node);
      const inputRequest =
        snapshot.controlState === "active"
          ? snapshot.inputRequests?.find(
              (request) =>
                request.nodeKey === node.key &&
                request.stageKey === stage.stageKey &&
                request.generation === stage.generation &&
                request.attemptId === state?.attemptId &&
                request.workerThreadId === state?.workerThreadId &&
                (request.status === "pending" || request.status === "answered"),
            )
          : undefined;
      const inputStatus = inputRequest?.status;
      const { status, statusLabel } = statusForNode(
        node,
        stage,
        state,
        inputStatus === "pending" || inputStatus === "answered" ? inputStatus : undefined,
      );
      return {
        key: node.key,
        nodeKey: node.key,
        stageKey: stage.stageKey,
        ...labels,
        status,
        statusLabel,
        workerThreadId: state?.workerThreadId ?? null,
      };
    }),
  );

  return {
    levels,
    gate: stage.releasePolicy === "user" ? releaseGate(stage, snapshot.controlState) : null,
  };
}

export function hubGraphDefaultStageKey(snapshot: HubPlanSnapshot): string {
  const stages = snapshot.graph.stages;
  const actionableBlockedStage = stages.find((stage) => stageHasActionableBlock(snapshot, stage));
  if (actionableBlockedStage) return actionableBlockedStage.stageKey;

  const readyStage = stages.find(
    (stage) => !stage.isReleased && !hubGraphStageWaitsForUpstream(snapshot, stage.stageKey),
  );
  if (readyStage) return readyStage.stageKey;

  return stages.find((stage) => !stage.isReleased)?.stageKey ?? stages.at(-1)?.stageKey ?? "";
}

export function hubGraphGlobalStatus(snapshot: HubPlanSnapshot): string {
  if (snapshot.controlState === "completed") return "已完成";
  if (snapshot.controlState !== "active") return hubPlanControlStateLabel(snapshot.controlState);

  const stages = snapshot.graph.stages;
  const nodes = snapshot.graph.stages.flatMap((stage) => {
    const graph = hubGraphNodes(snapshot, stage.stageKey);
    return [...graph.levels.flat(), ...(graph.gate ? [graph.gate] : [])];
  });

  const stagesReadyByUpstream = stages.filter(
    (stage) => !hubGraphStageWaitsForUpstream(snapshot, stage.stageKey),
  );
  if (stagesReadyByUpstream.some((stage) => stage.status === "blocked")) return "受阻";
  if (nodes.some((node) => node.status === "blocked")) return "受阻";
  if (stagesReadyByUpstream.some((stage) => stage.status === "changes_requested")) {
    return "需要修改";
  }
  if (nodes.some((node) => node.status === "awaiting_confirmation")) return "待人工确认";
  if (nodes.some((node) => node.status === "running")) return "运行中";
  if (nodes.some((node) => node.statusLabel === "等待回复")) return "等待回复";
  if (nodes.some((node) => node.statusLabel === "等待送达")) return "等待送达";
  if (
    stages.some((stage) => stage.status === "queued") ||
    nodes.some((node) => node.status === "queued")
  ) {
    return "排队中";
  }
  if (stages.length > 0 && stages.every((stage) => stage.isReleased)) return "已完成";
  return "等待中";
}
