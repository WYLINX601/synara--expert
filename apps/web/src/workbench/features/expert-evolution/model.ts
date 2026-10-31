import type {
  LearningChangeSet,
  SkillEvolutionGraph,
  SkillEvolutionGraphNode,
  SkillEvolutionRun,
  SkillEvolutionSource,
} from "@synara/contracts";

export const skillEvolutionQueryKey = (expertId: string) =>
  ["server", "skillEvolution", expertId] as const;

const DISCOVERY_SOURCE_COVERING_STATUSES = new Set<SkillEvolutionRun["status"]>([
  "queued",
  "running",
  "waiting_authorization",
  "cancel_requested",
  "opportunity_ready",
  "no_change",
  "insufficient_evidence",
]);

export interface DefaultSkillEvolutionSourceOptions {
  readonly runs?: ReadonlyArray<SkillEvolutionRun>;
  readonly preferredThreadId?: string | null;
  readonly limit?: number;
}

export function defaultSkillEvolutionSources(
  sources: ReadonlyArray<SkillEvolutionSource>,
  { runs = [], preferredThreadId, limit = 5 }: DefaultSkillEvolutionSourceOptions = {},
): SkillEvolutionSource[] {
  const recent = [...sources].sort((left, right) =>
    right.completedAt.localeCompare(left.completedAt),
  );
  if (preferredThreadId) {
    const preferred = recent.find((source) => source.threadId === preferredThreadId);
    return preferred ? [preferred] : [];
  }
  const coveredSourceKeys = new Set(
    runs
      .filter(
        (run) => run.stage === "discovery" && DISCOVERY_SOURCE_COVERING_STATUSES.has(run.status),
      )
      .flatMap(
        (run) =>
          run.sourceSelections?.map(
            (selection) => selection.threadId + "\u0000" + selection.turnId,
          ) ?? [],
      ),
  );
  return recent
    .filter((source) => !coveredSourceKeys.has(source.threadId + "\u0000" + source.turnId))
    .slice(0, Math.max(0, limit));
}

export function latestOpportunityGeneration(
  runs: ReadonlyArray<SkillEvolutionRun>,
  discoveryRequestId: string,
  opportunityId: string,
): SkillEvolutionRun | undefined {
  return runs
    .filter(
      (run) => run.discoveryRequestId === discoveryRequestId && run.opportunityId === opportunityId,
    )
    .sort(
      (left, right) =>
        (right.generationIndex ?? 0) - (left.generationIndex ?? 0) ||
        right.createdAt.localeCompare(left.createdAt) ||
        right.requestId.localeCompare(left.requestId),
    )[0];
}

export function isLatestOpportunityGeneration(
  run: SkillEvolutionRun,
  runs: ReadonlyArray<SkillEvolutionRun>,
): boolean {
  if (!run.discoveryRequestId || !run.opportunityId) return true;
  return (
    latestOpportunityGeneration(runs, run.discoveryRequestId, run.opportunityId)?.requestId ===
    run.requestId
  );
}

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
    case "opportunity_ready":
      return "发现可提炼经验";
    case "no_change":
      return "无需提炼";
    case "insufficient_evidence":
      return "证据不足";
    case "failed":
      return "提取失败";
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

export function skillEvolutionActionLabel(
  action: SkillEvolutionRun["proposals"][number]["action"],
) {
  switch (action) {
    case "create":
      return "新建";
    case "derive":
      return "复制";
    case "update":
      return "更新";
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

export function skillEvolutionScopeLabel(
  scope:
    | { readonly kind: "shared" }
    | { readonly kind: "expert"; readonly expertId: string }
    | undefined,
  expertNameById: ReadonlyMap<string, string> = new Map(),
) {
  if (!scope || scope.kind === "shared") return "共享技能";
  return `专家专用 · ${expertNameById.get(scope.expertId) ?? scope.expertId}`;
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

export interface EvolutionTimelineEntry {
  readonly id: string;
  readonly run: SkillEvolutionRun;
  readonly opportunity?: NonNullable<SkillEvolutionRun["opportunities"]>[number];
  readonly title: string;
  readonly label: string;
  readonly pending: boolean;
  readonly applied: boolean;
  readonly failed: boolean;
  readonly active: boolean;
}

/** Keep one stable row per experience; child attempts stay within their discovery. */
export function evolutionTimelineEntries(
  runs: ReadonlyArray<SkillEvolutionRun>,
): EvolutionTimelineEntry[] {
  const entries: EvolutionTimelineEntry[] = [];
  for (const run of runs) {
    if (
      run.stage === "generation" &&
      runs.some(
        (parent) =>
          parent.requestId === run.discoveryRequestId &&
          parent.opportunities?.some((item) => item.opportunityId === run.opportunityId),
      )
    )
      continue;
    const opportunities = run.stage === "discovery" ? (run.opportunities ?? []) : [];
    for (const opportunity of opportunities.length ? opportunities : [undefined]) {
      const latest = opportunity
        ? latestOpportunityGeneration(runs, run.requestId, opportunity.opportunityId)
        : run;
      const dismissed = opportunity?.status === "dismissed";
      const applied = Boolean(
        latest?.proposals.length && latest.proposals.every((item) => item.status === "applied"),
      );
      // Background progress and no-change outcomes are state, never a user review queue.
      if ((run.origin === "automatic" || latest?.origin === "automatic") && !applied) continue;
      const active = isSkillEvolutionRunActive(latest);
      const needsReview =
        latest?.proposals.some((item) =>
          ["proposed", "applying", "saved_unbound", "conflict", "failed"].includes(item.status),
        ) ?? false;
      const failed = latest?.status === "failed";
      const pending =
        !dismissed && !applied && !failed && (active || needsReview || Boolean(opportunity));
      const label = dismissed
        ? "已忽略"
        : applied
          ? "已应用"
          : latest
            ? latest.status === "proposal_ready" &&
              latest.proposals.length &&
              latest.proposals.every((item) => item.status === "proposed")
              ? "待审阅"
              : skillEvolutionRunPresentation(latest).label
            : "待生成预览";
      entries.push({
        id: opportunity
          ? JSON.stringify([run.requestId, opportunity.opportunityId])
          : run.requestId,
        run,
        ...(opportunity ? { opportunity } : {}),
        title:
          opportunity?.name ??
          run.proposals[0]?.name ??
          (run.stage === "generation" ? "经验修改预览" : "发现可复用经验"),
        label,
        pending,
        applied,
        failed,
        active,
      });
    }
  }
  return entries.sort(
    (left, right) =>
      right.run.createdAt.localeCompare(left.run.createdAt) || left.id.localeCompare(right.id),
  );
}

export type LearningTimelineEntry = {
  readonly kind: "learning";
  readonly id: string;
  readonly change: LearningChangeSet;
  readonly title: string;
  readonly label: string;
  readonly createdAt: string;
  readonly applied: true;
  readonly pending: false;
  readonly failed: false;
};
export type GrowthTimelineEntry =
  | LearningTimelineEntry
  | (EvolutionTimelineEntry & { readonly kind: "experience"; readonly createdAt: string });

/** Only exact asset-version receipts replace legacy automatic growth; never match prose. */
export function growthTimelineEntries(
  experiences: ReadonlyArray<EvolutionTimelineEntry>,
  changes: ReadonlyArray<LearningChangeSet>,
  events: SkillEvolutionGraph["events"],
  runs: ReadonlyArray<SkillEvolutionRun>,
): GrowthTimelineEntry[] {
  const committed = changes.filter(
    (change) => change.status === "committed" || change.status === "reverted",
  );
  const entries: GrowthTimelineEntry[] = experiences
    .filter((entry) => {
      const run = entry.opportunity
        ? latestOpportunityGeneration(runs, entry.run.requestId, entry.opportunity.opportunityId)
        : entry.run;
      if (
        !entry.applied ||
        !run ||
        (entry.run.origin !== "automatic" && run.origin !== "automatic")
      )
        return true;
      return !run.proposals.every((proposal) =>
        events.some(
          (event) =>
            event.requestId === run.requestId &&
            event.skillId === proposal.resultSkillId &&
            event.revision === proposal.resultRevision &&
            committed.some((change) => {
              const after = change.after;
              if (
                change.assetKind !== "skill" ||
                after?.assetKind !== "skill" ||
                after.skillId !== event.skillId ||
                !after.packageId ||
                after.packageId !== event.packageId
              )
                return false;
              const before = change.before;
              if (before === undefined) return false;
              if (before === null) return event.kind === "created" && !event.previousPackageId;
              return (
                before.assetKind === "skill" &&
                before.skillId ===
                  (event.previousSkillId ?? event.derivedFromSkillId ?? event.skillId) &&
                Boolean(before.packageId) &&
                before.packageId === event.previousPackageId &&
                (before.revision === undefined || before.revision === event.previousRevision)
              );
            }),
        ),
      );
    })
    .map((entry) => ({ ...entry, kind: "experience", createdAt: entry.run.createdAt }));
  for (const change of committed)
    entries.push({
      kind: "learning",
      id: `learning:${change.changeId}`,
      change,
      title: change.revertsChangeId
        ? "已撤回一次学习"
        : change.assetKind === "memory"
          ? "已更新记忆"
          : change.summary || "已更新技能",
      label: change.revertsChangeId
        ? "撤回记录"
        : change.status === "reverted"
          ? "已撤回"
          : "已生效",
      createdAt: change.createdAt,
      applied: true,
      pending: false,
      failed: false,
    });
  return entries.sort(
    (left, right) =>
      right.createdAt.localeCompare(left.createdAt) || left.id.localeCompare(right.id),
  );
}

export async function stableEvolutionOperationId(
  kind: "apply" | "restore" | "bind-restore" | "generate" | "learning-revert",
  parts: ReadonlyArray<string>,
) {
  const bytes = new TextEncoder().encode(parts.join("\u0000"));
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", bytes));
  const hex = [...digest].map((value) => value.toString(16).padStart(2, "0")).join("");
  return `skill-evolution-${kind}-${hex}`;
}

export function learningSkillCoverageLabel(code: string): string | null {
  if (code === "no-file-differences" || code === "exact-historical-packages-integrity-validated")
    return null;
  const files = /^additional-file-pairs-omitted:(\d+)$/u.exec(code);
  if (files) return `另有 ${files[1]} 个文件变化超出本次展示上限，未展示。`;
  const text = /^file-text-omitted-by-content-budget:(\d+)$/u.exec(code);
  if (text) return `${text[1]} 份版本正文超出本次展示上限，已省略。`;
  return "本次详情仅展示部分内容。";
}
