import type {
  SkillEvolutionGraph,
  SkillEvolutionRun,
  SkillEvolutionSource,
} from "@synara/contracts";
import { describe, expect, it } from "vitest";
import {
  evolutionTimelineEntries,
  isSkillEvolutionRunActive,
  isLatestOpportunityGeneration,
  defaultSkillEvolutionSources,
  latestOpportunityGeneration,
  layoutEvolutionGraph,
  skillEvolutionActionLabel,
  skillEvolutionEventLabel,
  skillEvolutionProposalStatusDetail,
  skillEvolutionRunPresentation,
  skillEvolutionRunStatusLabel,
  skillEvolutionScopeLabel,
} from "./model";

const graph: SkillEvolutionGraph = {
  nodes: [
    {
      skillId: `skl_${"b".repeat(32)}`,
      name: "Known",
      revision: 2,
      packageId: `pkg_${"a".repeat(64)}`,
      timestamp: "2026-10-27T00:00:00.000Z",
      baseline: false,
    },
    {
      skillId: `skl_${"a".repeat(32)}`,
      name: "Unknown baseline",
      revision: 1,
      packageId: `pkg_${"b".repeat(64)}`,
      timestamp: null,
      baseline: true,
    },
  ],
  events: [],
};

describe("Expert Skill evolution presentation model", () => {
  it("keeps unknown baseline timestamps unknown and lays nodes out deterministically", () => {
    const first = layoutEvolutionGraph(graph);
    const second = layoutEvolutionGraph(graph);
    expect(first).toEqual(second);
    expect(first.find((position) => position.node.baseline)?.node.timestamp).toBeNull();
    expect(first.find((position) => position.node.baseline)?.x).toBeLessThan(100);
    expect(first.find((position) => !position.node.baseline)?.x).not.toBe(
      first.find((position) => position.node.baseline)?.x,
    );
  });

  it("polls only live execution states and keeps terminal outcomes distinct", () => {
    expect(isSkillEvolutionRunActive({ status: "running" })).toBe(true);
    expect(isSkillEvolutionRunActive({ status: "waiting_authorization" })).toBe(true);
    expect(isSkillEvolutionRunActive({ status: "proposal_ready" })).toBe(false);
    expect(skillEvolutionRunStatusLabel("no_change")).toBe("无需提炼");
    expect(skillEvolutionRunStatusLabel("insufficient_evidence")).toBe("证据不足");
    expect(skillEvolutionRunStatusLabel("failed")).toBe("提取失败");
    expect(skillEvolutionRunStatusLabel("opportunity_ready")).toBe("发现可提炼经验");
  });

  it("defaults to the five most recent available fragments and honors an explicit source thread", () => {
    const available = Array.from({ length: 7 }, (_, index) => ({
      threadId: index === 1 ? "preferred-thread" : `thread-${index}`,
      turnId: `turn-${index}`,
      projectId: "project-1",
      title: `Work ${index}`,
      expertId: "review-expert",
      expertRevision: 1,
      snapshotId: `snapshot-${index}`,
      completedAt: `2026-10-${String(20 + index).padStart(2, "0")}T00:00:00.000Z`,
      messageCount: 1,
    })) as unknown as SkillEvolutionSource[];

    expect(defaultSkillEvolutionSources(available).map((source) => source.turnId)).toEqual([
      "turn-6",
      "turn-5",
      "turn-4",
      "turn-3",
      "turn-2",
    ]);
    expect(
      defaultSkillEvolutionSources(available, { preferredThreadId: "preferred-thread" }).map(
        (source) => source.turnId,
      ),
    ).toEqual(["turn-1"]);
    expect(
      defaultSkillEvolutionSources(available, { preferredThreadId: "missing-thread" }),
    ).toEqual([]);
  });

  it("excludes sources covered by discovery runs while keeping failed and cancelled sources retryable", () => {
    const available = Array.from({ length: 9 }, (_, index) => ({
      threadId: `thread-${index}`,
      turnId: `turn-${index}`,
      projectId: "project-1",
      title: `Work ${index}`,
      expertId: "review-expert",
      expertRevision: 1,
      snapshotId: `snapshot-${index}`,
      completedAt: `2026-10-${String(20 + index).padStart(2, "0")}T00:00:00.000Z`,
      messageCount: 1,
    })) as unknown as SkillEvolutionSource[];
    const coveringStatuses: SkillEvolutionRun["status"][] = [
      "queued",
      "running",
      "waiting_authorization",
      "cancel_requested",
      "opportunity_ready",
      "no_change",
      "insufficient_evidence",
    ];
    const coveredRuns = coveringStatuses.map(
      (status, index) =>
        ({
          requestId: `discovery-${index}`,
          expertId: "review-expert",
          stage: "discovery",
          createdAt: "2026-10-30T00:00:00.000Z",
          updatedAt: "2026-10-30T00:00:00.000Z",
          modelSelection: { provider: "pi", model: "test-model" },
          sourceCount: 1,
          sourceSelections: [{ threadId: `thread-${index}`, turnId: `turn-${index}` }],
          status,
          proposals: [],
        }) as unknown as SkillEvolutionRun,
    );
    const failedRun = {
      ...coveredRuns[0]!,
      requestId: "failed-discovery",
      status: "failed",
      sourceSelections: [{ threadId: "thread-7", turnId: "turn-7" }],
    } as unknown as SkillEvolutionRun;
    const cancelledRun = {
      ...coveredRuns[0]!,
      requestId: "cancelled-discovery",
      status: "cancelled",
      sourceSelections: [{ threadId: "thread-8", turnId: "turn-8" }],
    } as unknown as SkillEvolutionRun;

    expect(
      defaultSkillEvolutionSources(available, { runs: coveredRuns }).map((source) => source.turnId),
    ).toEqual(["turn-8", "turn-7"]);
    expect(
      defaultSkillEvolutionSources(available, {
        runs: [...coveredRuns, failedRun, cancelledRun],
      }).map((source) => source.turnId),
    ).toEqual(["turn-8", "turn-7"]);
    expect(
      defaultSkillEvolutionSources(available, {
        runs: coveredRuns,
        preferredThreadId: "thread-4",
      }).map((source) => source.turnId),
    ).toEqual(["turn-4"]);
  });

  it("selects only the highest generation index for an experience opportunity", () => {
    const child = (requestId: string, generationIndex: number): SkillEvolutionRun =>
      ({
        requestId,
        expertId: "review-expert",
        stage: "generation",
        discoveryRequestId: "discovery-1",
        opportunityId: "opportunity-1",
        generationIndex,
        createdAt: `2026-10-2${generationIndex}T00:00:00.000Z`,
        updatedAt: `2026-10-2${generationIndex}T00:00:00.000Z`,
        modelSelection: { provider: "pi", model: "test-model" },
        sourceCount: 1,
        status: "proposal_ready",
        proposals: [],
      }) as SkillEvolutionRun;
    const oldGeneration = child("generation-1", 1);
    const latestGeneration = child("generation-2", 2);

    expect(
      latestOpportunityGeneration(
        [oldGeneration, latestGeneration],
        "discovery-1",
        "opportunity-1",
      ),
    ).toEqual(latestGeneration);
    expect(isLatestOpportunityGeneration(oldGeneration, [oldGeneration, latestGeneration])).toBe(
      false,
    );
    expect(isLatestOpportunityGeneration(latestGeneration, [oldGeneration, latestGeneration])).toBe(
      true,
    );
  });

  it("labels binding restoration as a binding event rather than a content version", () => {
    expect(skillEvolutionEventLabel("binding_restored")).toBe("恢复原绑定");
    expect(skillEvolutionEventLabel("restored")).toBe("恢复内容版本");
  });

  it("labels proposal actions and derives ownership labels from the current owner", () => {
    expect(skillEvolutionActionLabel("create")).toBe("新建");
    expect(skillEvolutionActionLabel("derive")).toBe("复制");
    expect(skillEvolutionActionLabel("update")).toBe("更新");
    expect(skillEvolutionScopeLabel(undefined)).toBe("共享技能");
    expect(
      skillEvolutionScopeLabel(
        { kind: "expert", expertId: "review" },
        new Map([["review", "Review Expert"]]),
      ),
    ).toBe("专家专用 · Review Expert");
  });

  it("derives proposal-ready run status from proposal outcomes and counts partial work", () => {
    expect(
      skillEvolutionRunPresentation({
        status: "proposal_ready",
        proposals: [{ status: "applied" }, { status: "applied" }],
      }),
    ).toMatchObject({ label: "已采用" });
    expect(
      skillEvolutionRunPresentation({
        status: "proposal_ready",
        proposals: [{ status: "applied" }, { status: "proposed" }],
      }),
    ).toMatchObject({ label: "部分处理" });
    expect(
      skillEvolutionProposalStatusDetail([{ status: "applied" }, { status: "proposed" }]),
    ).toBe("已采用 1 · 已拒绝 0 · 冲突 0 · 失败 0 · 待处理 1");
  });
});

describe("experience timeline grouping", () => {
  const parent = {
    requestId: "discovery",
    expertId: "expert",
    stage: "discovery",
    createdAt: "2026-10-30T00:00:00.000Z",
    updatedAt: "2026-10-30T00:00:00.000Z",
    modelSelection: { provider: "pi", model: "test" },
    sourceCount: 1,
    status: "opportunity_ready",
    proposals: [],
    opportunities: [
      {
        opportunityId: "experience",
        requestId: "discovery",
        expertId: "expert",
        name: "复核真实结果",
        reason: "重复验证",
        outcomes: ["复核"],
        evidence: [],
        digest: "d",
        status: "suggested",
      },
    ],
  } as unknown as SkillEvolutionRun;
  const child = (status: "proposed" | "applied", generationIndex = 1) =>
    ({
      ...parent,
      requestId: `generation-${generationIndex}`,
      stage: "generation",
      discoveryRequestId: parent.requestId,
      opportunityId: "experience",
      generationIndex,
      status: "proposal_ready",
      opportunities: undefined,
      proposals: [{ name: "复核方法", status }],
    }) as unknown as SkillEvolutionRun;

  it("keeps a stable experience row across generation, retries and application", () => {
    const initial = evolutionTimelineEntries([parent]);
    const preview = evolutionTimelineEntries([child("proposed", 2), parent, child("applied")]);
    const applied = evolutionTimelineEntries([parent, child("proposed"), child("applied", 2)]);
    expect(initial).toHaveLength(1);
    expect(preview).toHaveLength(1);
    expect(applied).toHaveLength(1);
    expect(initial[0]).toMatchObject({ title: "复核真实结果", pending: true, label: "待生成预览" });
    expect(preview[0]).toMatchObject({ id: initial[0]!.id, pending: true, label: "待审阅" });
    expect(applied[0]).toMatchObject({
      id: initial[0]!.id,
      pending: false,
      applied: true,
      label: "已应用",
    });
  });

  it("marks a failed extraction as an outcome rather than pending user work", () => {
    const failed = {
      ...child("proposed"),
      status: "failed",
      error: "Timeout",
      proposals: [],
    } as unknown as SkillEvolutionRun;
    expect(evolutionTimelineEntries([parent, failed])[0]).toMatchObject({
      failed: true,
      pending: false,
      label: "提取失败",
    });
    expect(
      evolutionTimelineEntries([
        { ...parent, status: "failed", opportunities: [] } as unknown as SkillEvolutionRun,
      ])[0],
    ).toMatchObject({ failed: true, pending: false, label: "提取失败" });
  });

  it("keeps orphan and legacy results inspectable and dismissed experiences out of pending", () => {
    expect(evolutionTimelineEntries([child("proposed")])).toHaveLength(1);
    const dismissed = {
      ...parent,
      opportunities: parent.opportunities!.map((item) => ({
        ...item,
        status: "dismissed" as const,
      })),
    };
    expect(evolutionTimelineEntries([dismissed, child("proposed")])[0]).toMatchObject({
      pending: false,
      label: "已忽略",
    });
    const legacy = {
      ...child("applied"),
      stage: undefined,
      discoveryRequestId: undefined,
      opportunityId: undefined,
    } as unknown as SkillEvolutionRun;
    expect(evolutionTimelineEntries([legacy])[0]).toMatchObject({
      title: "复核方法",
      applied: true,
    });
  });
});
