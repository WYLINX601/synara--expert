import type {
  SkillEvolutionGraph,
  SkillEvolutionGraphNode,
  SkillEvolutionRun,
} from "@synara/contracts";

export const skillEvolutionQueryKey = (expertId: string) =>
  ["server", "skillEvolution", expertId] as const;

export function isSkillEvolutionRunActive(
  run: Pick<SkillEvolutionRun, "status"> | undefined,
): boolean {
  return Boolean(
    run && ["queued", "running", "waiting_authorization", "cancel_requested"].includes(run.status),
  );
}

export function skillEvolutionRunStatusLabel(status: SkillEvolutionRun["status"]): string {
  switch (status) {
    case "queued":
      return "排队中";
    case "running":
      return "分析中";
    case "waiting_authorization":
      return "等待原生权限";
    case "proposal_ready":
      return "候选就绪";
    case "no_change":
      return "无需提炼";
    case "insufficient_evidence":
      return "证据不足";
    case "failed":
      return "分析失败";
    case "cancel_requested":
      return "正在取消";
    case "cancelled":
      return "已取消";
  }
}

type EvolutionProposalStatus = SkillEvolutionRun["proposals"][number]["status"];

export function skillEvolutionProposalStatusLabel(status: EvolutionProposalStatus): string {
  switch (status) {
    case "proposed":
      return "待审阅";
    case "applying":
      return "采用中";
    case "saved_unbound":
      return "已保存，待绑定";
    case "applied":
      return "已采用";
    case "rejected":
      return "已拒绝";
    case "conflict":
      return "目标冲突";
    case "failed":
      return "采用失败";
  }
}

export function skillEvolutionProposalStatusDetail(
  proposals: ReadonlyArray<{ readonly status: EvolutionProposalStatus }>,
): string | undefined {
  if (!proposals.length) return undefined;
  const counts = {
    applied: proposals.filter((proposal) => proposal.status === "applied").length,
    rejected: proposals.filter((proposal) => proposal.status === "rejected").length,
    conflict: proposals.filter((proposal) => proposal.status === "conflict").length,
    failed: proposals.filter((proposal) => proposal.status === "failed").length,
    savedUnbound: proposals.filter((proposal) => proposal.status === "saved_unbound").length,
    proposed: proposals.filter((proposal) => proposal.status === "proposed").length,
    applying: proposals.filter((proposal) => proposal.status === "applying").length,
  };
  const terminalCount = counts.applied + counts.rejected + counts.conflict + counts.failed;
  if (terminalCount === 0 && counts.savedUnbound === 0 && counts.applying === 0) return undefined;
  const pendingCount = counts.proposed + counts.savedUnbound + counts.applying;
  return [
    `已采用 ${counts.applied}`,
    `已拒绝 ${counts.rejected}`,
    `冲突 ${counts.conflict}`,
    `失败 ${counts.failed}`,
    ...(counts.savedUnbound ? [`待完成绑定 ${counts.savedUnbound}`] : []),
    ...(counts.proposed ? [`待处理 ${counts.proposed}`] : []),
    ...(counts.applying ? [`正在采用 ${counts.applying}`] : []),
    ...(pendingCount === 0 ? ["候选均已处理"] : []),
  ].join(" · ");
}

export function skillEvolutionRunPresentation(run: {
  readonly status: SkillEvolutionRun["status"];
  readonly proposals: ReadonlyArray<{ readonly status: EvolutionProposalStatus }>;
}): { readonly label: string; readonly detail?: string } {
  if (run.status !== "proposal_ready" || !run.proposals.length)
    return { label: skillEvolutionRunStatusLabel(run.status) };
  const statuses = run.proposals.map((proposal) => proposal.status);
  const terminal = statuses.filter((status) =>
    ["applied", "rejected", "conflict", "failed"].includes(status),
  ).length;
  const applied = statuses.filter((status) => status === "applied").length;
  const rejected = statuses.filter((status) => status === "rejected").length;
  const savedUnbound = statuses.filter((status) => status === "saved_unbound").length;
  const applying = statuses.filter((status) => status === "applying").length;
  const detail = skillEvolutionProposalStatusDetail(run.proposals);
  if (applied === statuses.length) return { label: "已采用", ...(detail ? { detail } : {}) };
  if (rejected === statuses.length) return { label: "已拒绝", ...(detail ? { detail } : {}) };
  if (terminal === statuses.length) return { label: "已处理", ...(detail ? { detail } : {}) };
  if (terminal > 0 || (savedUnbound > 0 && savedUnbound < statuses.length))
    return { label: "部分处理", ...(detail ? { detail } : {}) };
  if (savedUnbound === statuses.length)
    return { label: "待完成绑定", ...(detail ? { detail } : {}) };
  if (applying > 0) return { label: "正在采用", ...(detail ? { detail } : {}) };
  return { label: skillEvolutionRunStatusLabel(run.status) };
}

export function skillEvolutionPolicyLabel(policy: "protected" | "shared" | "independent") {
  switch (policy) {
    case "protected":
      return "受保护";
    case "shared":
      return "共享进化";
    case "independent":
      return "独立进化";
  }
}

export function skillEvolutionEventLabel(kind: SkillEvolutionGraph["events"][number]["kind"]) {
  switch (kind) {
    case "created":
      return "创建 Skill";
    case "derived":
      return "派生专用副本";
    case "updated":
      return "更新内容";
    case "restored":
      return "恢复内容版本";
    case "shared":
      return "设为共享";
    case "binding_restored":
      return "恢复原绑定";
  }
}

export function defaultEvolutionPolicy(policy: "protected" | "shared" | "independent" | undefined) {
  return policy ?? "protected";
}

export function skillEvolutionScopeLabel(
  scope:
    | { readonly kind: "shared" }
    | { readonly kind: "expert"; readonly expertId: string }
    | undefined,
  expertNameById: ReadonlyMap<string, string> = new Map(),
) {
  if (!scope || scope.kind === "shared") return "共享可用";
  return `仅限 ${expertNameById.get(scope.expertId) ?? scope.expertId}`;
}

export interface EvolutionGraphNodePosition {
  readonly node: SkillEvolutionGraphNode;
  readonly x: number;
  readonly y: number;
}

/** Stable, fixed-size radial positions; unknown baseline times stay in the inner ring. */
export function layoutEvolutionGraph(graph: SkillEvolutionGraph): EvolutionGraphNodePosition[] {
  const nodes = [...graph.nodes].sort((left, right) => left.skillId.localeCompare(right.skillId));
  if (nodes.length === 0) return [];
  const knownTimes = nodes
    .map((node) => node.timestamp)
    .filter((timestamp): timestamp is string => timestamp !== null)
    .map((timestamp) => Date.parse(timestamp))
    .filter(Number.isFinite);
  const minTime = Math.min(...knownTimes);
  const maxTime = Math.max(...knownTimes);
  const bucketCounts = [0, 0, 0, 0];

  return nodes.map((node, index) => {
    const time = node.timestamp === null ? Number.NaN : Date.parse(node.timestamp);
    const progress = Number.isFinite(time)
      ? maxTime === minTime
        ? 1
        : (time - minTime) / (maxTime - minTime)
      : -1;
    const ring = progress < 0 ? 0 : Math.min(3, 1 + Math.floor(progress * 2.99));
    const ringIndex = bucketCounts[ring] ?? 0;
    bucketCounts[ring] = ringIndex + 1;
    const ringRadius = ring === 0 ? 62 : 122 + (ring - 1) * 82;
    const angle = ringIndex * 2.399963229728653 + (index % 7) * 0.31;
    return {
      node,
      x: Math.cos(angle) * ringRadius,
      y: Math.sin(angle) * ringRadius,
    };
  });
}
