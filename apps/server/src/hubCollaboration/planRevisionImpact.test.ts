import type { HubPlanDefinition } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import { analyzeHubPlanRevisionImpact } from "./planRevisionImpact.ts";

function plan(): HubPlanDefinition {
  const node = (
    key: string,
    stageKey: string,
    dependsOnNodeKeys: string[] = [],
    role: "author" | "reviewer" = "author",
  ) => ({
    key,
    stageKey,
    title: key,
    brief: `Do ${key}`,
    dependsOnNodeKeys,
    role,
    workMode: "agent" as const,
    acceptanceCriteria: `Accept ${key}`,
  });
  return {
    objective: "Reviewed delivery",
    scope: "Bounded local documents",
    maxRepairRounds: 2,
    stages: [
      { key: "a", title: "A", releasePolicy: "auto" },
      { key: "b", title: "B", releasePolicy: "user" },
      { key: "c", title: "C", releasePolicy: "user" },
      { key: "independent", title: "Independent", releasePolicy: "user" },
    ],
    nodes: [
      node("a1", "a"),
      node("b1", "b", ["a1"]),
      node("b2", "b", ["b1"], "reviewer"),
      node("c1", "c", ["b2"]),
      node("i1", "independent"),
    ],
  };
}

const digest = "a".repeat(64);
function analyze(
  current: HubPlanDefinition,
  proposed: HubPlanDefinition,
  proposedConfigurationDigest = digest,
) {
  const result = analyzeHubPlanRevisionImpact({
    current,
    proposed,
    currentConfigurationDigest: digest,
    proposedConfigurationDigest,
  });
  if (!result.valid) throw new Error(JSON.stringify(result.issues));
  return result;
}

describe("Hub running revision impact analysis (no execution authority)", () => {
  it("invalidates a shared candidate stage and downstream while preserving an independent branch", () => {
    const before = plan();
    const after = {
      ...before,
      nodes: before.nodes.map((node) =>
        node.key === "b2" ? { ...node, acceptanceCriteria: "Stricter review" } : node,
      ),
    };
    const result = analyze(before, after);
    expect(result.changedNodeKeys).toEqual(["b2"]);
    expect(result.affectedStageKeys).toEqual(["b", "c"]);
    expect(result.affectedNodeKeys).toEqual(["b1", "b2", "c1"]);
    expect(result.carryForwardCandidateKeys).toEqual(["a1", "i1"]);
  });

  it("keeps the old dependency closure even when the proposal removes the edge and its upstream stage", () => {
    const before = plan();
    const after = {
      ...before,
      stages: before.stages.filter((stage) => stage.key !== "b"),
      nodes: before.nodes
        .filter((node) => node.stageKey !== "b")
        .map((node) => (node.key === "c1" ? { ...node, dependsOnNodeKeys: [] } : node)),
    };
    const result = analyze(before, after);
    expect(result.affectedStageKeys).toEqual(["b", "c"]);
    expect(result.affectedNodeKeys).toEqual(["b1", "b2", "c1"]);
  });

  it("includes newly added downstream stages", () => {
    const before = plan();
    const after: HubPlanDefinition = {
      ...before,
      stages: [...before.stages, { key: "d", title: "D", releasePolicy: "user" }],
      nodes: [
        ...before.nodes.map((node) =>
          node.key === "b1" ? { ...node, brief: "Changed brief" } : node,
        ),
        { ...before.nodes[0]!, key: "d1", stageKey: "d", dependsOnNodeKeys: ["c1"] },
      ],
    };
    expect(analyze(before, after).affectedStageKeys).toEqual(["b", "c", "d"]);
  });

  it("invalidates both groups when an existing reviewer moves to another stage", () => {
    const before = plan();
    const after = {
      ...before,
      nodes: before.nodes.map((node) =>
        node.key === "b2" ? { ...node, stageKey: "independent", dependsOnNodeKeys: ["i1"] } : node,
      ),
    };
    expect(analyze(before, after).affectedStageKeys).toEqual(["b", "c", "independent"]);
    expect(analyze(before, after).carryForwardCandidateKeys).toEqual(["a1"]);
  });

  it("terminates when two valid revisions reverse a dependency between stages", () => {
    const before = plan();
    const after = {
      ...before,
      nodes: before.nodes.map((node) =>
        node.key === "a1"
          ? { ...node, dependsOnNodeKeys: ["b2"] }
          : node.key === "b1"
            ? { ...node, dependsOnNodeKeys: [] }
            : node,
      ),
    };
    expect(analyze(before, after).affectedStageKeys).toEqual(["a", "b", "c"]);
  });

  it.each(["objective", "scope", "maxRepairRounds"] as const)(
    "holds every branch when the authorized %s changes",
    (field) => {
      const before = plan();
      const after = {
        ...before,
        [field]: field === "maxRepairRounds" ? 3 : "Changed authorization",
      };
      const result = analyze(before, after);
      expect(result.globalScopeChanged).toBe(true);
      expect(result.carryForwardCandidateKeys).toEqual([]);
    },
  );

  it("treats configuration changes and exit policy changes as authorization changes", () => {
    const before = plan();
    expect(analyze(before, before, "b".repeat(64)).carryForwardCandidateKeys).toEqual([]);
    const after = {
      ...before,
      stages: before.stages.map((stage) =>
        stage.key === "a" ? { ...stage, releasePolicy: "user" as const } : stage,
      ),
    };
    expect(analyze(before, after).affectedStageKeys).toEqual(["a", "b", "c"]);
  });

  it("ignores display ordering and object property ordering without mutating the input", () => {
    const before = plan();
    const serialized = JSON.stringify(before);
    const after = {
      ...before,
      nodes: [...before.nodes].reverse(),
      stages: [...before.stages].reverse(),
    };
    const result = analyze(before, after);
    expect(result.affectedNodeKeys).toEqual([]);
    expect(JSON.stringify(before)).toBe(serialized);
  });

  it("fails closed for cycles, missing references and missing configuration identities", () => {
    const before = plan();
    for (const dependency of ["c1", "missing"]) {
      const proposed = {
        ...before,
        nodes: before.nodes.map((node) =>
          node.key === "a1" ? { ...node, dependsOnNodeKeys: [dependency] } : node,
        ),
      };
      expect(
        analyzeHubPlanRevisionImpact({
          current: before,
          proposed,
          currentConfigurationDigest: digest,
          proposedConfigurationDigest: digest,
        }).valid,
      ).toBe(false);
    }
    expect(
      analyzeHubPlanRevisionImpact({
        current: before,
        proposed: before,
        currentConfigurationDigest: "",
        proposedConfigurationDigest: "",
      }).valid,
    ).toBe(false);
  });
});
