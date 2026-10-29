import type { SkillEvolutionGraph } from "@synara/contracts";
import { describe, expect, it } from "vitest";
import {
  isSkillEvolutionRunActive,
  layoutEvolutionGraph,
  skillEvolutionEventLabel,
  skillEvolutionProposalStatusDetail,
  skillEvolutionRunPresentation,
  skillEvolutionRunStatusLabel,
} from "./model";

const graph: SkillEvolutionGraph = {
  nodes: [
    {
      skillId: `skl_${"b".repeat(32)}`,
      name: "Known",
      revision: 2,
      packageId: `pkg_${"a".repeat(64)}`,
      policy: "shared",
      timestamp: "2026-10-27T00:00:00.000Z",
      baseline: false,
    },
    {
      skillId: `skl_${"a".repeat(32)}`,
      name: "Unknown baseline",
      revision: 1,
      packageId: `pkg_${"b".repeat(64)}`,
      policy: "protected",
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
    expect(skillEvolutionRunStatusLabel("failed")).toBe("分析失败");
  });

  it("labels binding restoration as a binding event rather than a content version", () => {
    expect(skillEvolutionEventLabel("binding_restored")).toBe("恢复原绑定");
    expect(skillEvolutionEventLabel("restored")).toBe("恢复内容版本");
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
