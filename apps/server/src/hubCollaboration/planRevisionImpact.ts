import type { HubPlanDefinition } from "@synara/contracts";

import { validateHubPlanDefinition, type HubPlanValidationIssue } from "./planGraph.ts";

export type HubPlanRevisionImpact =
  | { readonly valid: false; readonly issues: readonly HubPlanValidationIssue[] }
  | {
      readonly valid: true;
      readonly globalScopeChanged: boolean;
      readonly changedNodeKeys: readonly string[];
      readonly affectedStageKeys: readonly string[];
      readonly affectedNodeKeys: readonly string[];
      /** Structural candidates only, never authority to reuse an attempt or release. */
      readonly carryForwardCandidateKeys: readonly string[];
    };

function canonical(value: unknown): string {
  const normalize = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(normalize);
    if (item !== null && typeof item === "object") {
      return Object.fromEntries(
        Object.entries(item)
          .filter(([, child]) => child !== undefined)
          .toSorted(([a], [b]) => a.localeCompare(b))
          .map(([key, child]) => [key, normalize(child)]),
      );
    }
    return item;
  };
  return JSON.stringify(normalize(value));
}

/**
 * T3 proposal analysis, with no writes or execution authority. A stage shares one
 * candidate/generation, so changing any member invalidates the whole stage and
 * its downstream closure in BOTH graphs (including dependencies removed by the
 * proposal). Native input/output digests, attempt settlement and explicit
 * carry-forward bindings still have to be checked when a revision is confirmed.
 */
export function analyzeHubPlanRevisionImpact(input: {
  readonly current: HubPlanDefinition;
  readonly proposed: HubPlanDefinition;
  readonly currentConfigurationDigest: string;
  readonly proposedConfigurationDigest: string;
}): HubPlanRevisionImpact {
  const issues = [
    ...validateHubPlanDefinition(input.current).map((issue) => ({
      ...issue,
      path: `current.${issue.path}`,
    })),
    ...validateHubPlanDefinition(input.proposed).map((issue) => ({
      ...issue,
      path: `proposed.${issue.path}`,
    })),
  ];
  for (const field of ["currentConfigurationDigest", "proposedConfigurationDigest"] as const) {
    if (!/^[a-f0-9]{64}$/.test(input[field])) {
      issues.push({
        code: "configuration.invalid_digest",
        path: field,
        message: "A fixed configuration SHA-256 digest is required.",
      });
    }
  }
  if (issues.length > 0) return { valid: false, issues };

  const currentNodes = new Map(input.current.nodes.map((node) => [node.key, node]));
  const proposedNodes = new Map(input.proposed.nodes.map((node) => [node.key, node]));
  const currentStages = new Map(input.current.stages.map((stage) => [stage.key, stage]));
  const proposedStages = new Map(input.proposed.stages.map((stage) => [stage.key, stage]));
  const allNodeKeys = [...new Set([...currentNodes.keys(), ...proposedNodes.keys()])].toSorted();
  const allStageKeys = [...new Set([...currentStages.keys(), ...proposedStages.keys()])].toSorted();
  const nodeShape = (node: HubPlanDefinition["nodes"][number] | undefined) =>
    node ? { ...node, dependsOnNodeKeys: [...node.dependsOnNodeKeys].toSorted() } : null;
  const changedNodeKeys = allNodeKeys.filter(
    (key) =>
      canonical(nodeShape(currentNodes.get(key))) !== canonical(nodeShape(proposedNodes.get(key))),
  );
  const globalScopeChanged =
    input.current.objective !== input.proposed.objective ||
    input.current.scope !== input.proposed.scope ||
    input.current.maxRepairRounds !== input.proposed.maxRepairRounds ||
    input.currentConfigurationDigest !== input.proposedConfigurationDigest;
  const affectedStages = new Set<string>(globalScopeChanged ? allStageKeys : []);
  for (const key of allStageKeys) {
    if (canonical(currentStages.get(key) ?? null) !== canonical(proposedStages.get(key) ?? null)) {
      affectedStages.add(key);
    }
  }
  for (const key of changedNodeKeys) {
    const before = currentNodes.get(key);
    const after = proposedNodes.get(key);
    if (before) affectedStages.add(before.stageKey);
    if (after) affectedStages.add(after.stageKey);
  }

  const downstream = new Map<string, Set<string>>();
  for (const definition of [input.current, input.proposed]) {
    const nodes = new Map(definition.nodes.map((node) => [node.key, node]));
    for (const node of definition.nodes) {
      for (const dependencyKey of node.dependsOnNodeKeys) {
        const dependency = nodes.get(dependencyKey)!;
        if (dependency.stageKey === node.stageKey) continue;
        const next = downstream.get(dependency.stageKey) ?? new Set<string>();
        next.add(node.stageKey);
        downstream.set(dependency.stageKey, next);
      }
    }
  }
  const pending = [...affectedStages];
  while (pending.length > 0) {
    for (const key of downstream.get(pending.shift()!) ?? []) {
      if (!affectedStages.has(key)) {
        affectedStages.add(key);
        pending.push(key);
      }
    }
  }
  const affectedNodeKeys = allNodeKeys.filter((key) => {
    const before = currentNodes.get(key);
    const after = proposedNodes.get(key);
    return (
      (before && affectedStages.has(before.stageKey)) ||
      (after && affectedStages.has(after.stageKey))
    );
  });
  const affectedNodes = new Set(affectedNodeKeys);
  return {
    valid: true,
    globalScopeChanged,
    changedNodeKeys,
    affectedStageKeys: [...affectedStages].toSorted(),
    affectedNodeKeys,
    carryForwardCandidateKeys: allNodeKeys.filter(
      (key) => currentNodes.has(key) && proposedNodes.has(key) && !affectedNodes.has(key),
    ),
  };
}
