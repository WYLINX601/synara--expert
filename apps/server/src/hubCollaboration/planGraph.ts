import { Schema } from "effect";

import {
  HUB_PLAN_MAX_REVIEWERS_PER_STAGE,
  type HubPlanControlState,
  HubPlanDefinitionSchema,
  type HubPlanGraphView,
  type HubPlanDefinition,
  type HubPlanNodeDefinition,
  type HubPlanStageStatus,
  type HubPlanStageView,
  type ProjectManagedWorker,
  type ProjectTask,
  type ProjectTaskAttempt,
} from "@synara/contracts";
import type {
  HubPlanAttemptBinding,
  HubPlanCandidateRecord,
  HubPlanReviewRecord,
} from "./HubPlanStore.ts";

export type {
  HubPlanControlState,
  HubPlanGraphView,
  HubPlanStageStatus,
  HubPlanStageView,
} from "@synara/contracts";

export interface HubPlanValidationIssue {
  readonly code: string;
  readonly path: string;
  readonly message: string;
}

const taskStatuses = [
  "planned",
  "ready",
  "running",
  "review",
  "done",
  "blocked",
  "cancelled",
] as const;
export type HubPlanTaskStatus = (typeof taskStatuses)[number];

export type HubPlanWorkState =
  | "queued"
  | "starting"
  | "working"
  | "waiting"
  | "idle"
  | "completed"
  | "failed"
  | "cancelled";

/** Read-only projections of existing ProjectTask, attempt, HubWork and collaboration records. */
export interface HubPlanGraphFacts {
  readonly controlState: HubPlanControlState;
  readonly stageGenerations: Readonly<Record<string, number>>;
  readonly tasks: readonly HubPlanTaskFact[];
  readonly currentCandidates: readonly HubPlanCandidateFact[];
  readonly effectiveReviews: readonly HubPlanReviewFact[];
  readonly effectiveReleases: readonly HubPlanReleaseFact[];
}

export interface HubPlanTaskFact {
  readonly nodeKey: string;
  readonly taskStatus: HubPlanTaskStatus;
  /** True only for a settled provider turn without an accepted result for this node. */
  readonly retryable?: boolean;
  /** A durable directed owner question is waiting for an answer or delivery. */
  readonly waitingForUserInput?: boolean;
  readonly currentAttempt?: {
    readonly attemptId: string;
    readonly generation: number;
    readonly workState: HubPlanWorkState;
    /** True only when the matching accepted result survived a plan-controlled stop. */
    readonly acceptedAfterStop?: boolean;
  };
}

/**
 * Shared retry predicate for projections, user commands, and explicitly authorized dispatch.
 * The authorized-reset form is only for a durable `plan.schedule` retry token after the native
 * task was reset to ready; it never makes a node retryable in a live snapshot by itself.
 */
export function isRetryableHubPlanAttempt(input: {
  readonly planId: string;
  readonly hubId: string;
  readonly revision: number;
  readonly currentGeneration: number;
  readonly node: HubPlanNodeDefinition;
  readonly binding: HubPlanAttemptBinding;
  readonly task: ProjectTask;
  readonly attempt: ProjectTaskAttempt;
  readonly workState: HubPlanWorkState;
  readonly workSlotHeld: boolean;
  readonly workWorkerThreadId: string | null;
  readonly candidates: readonly HubPlanCandidateRecord[];
  readonly reviews: readonly HubPlanReviewRecord[];
  readonly managedWorker?: ProjectManagedWorker;
  /** A durable request for this exact node attempt is still pending or awaiting delivery. */
  readonly hasPendingInputRequest?: boolean;
  readonly authorizedReset?: boolean;
}): boolean {
  const { binding, task, attempt, node } = input;
  const managedWorker = input.managedWorker;
  const managedWorkerMatches = Boolean(
    managedWorker &&
    managedWorker.projectId === input.hubId &&
    managedWorker.threadId === attempt.workerThreadId &&
    managedWorker.taskId === task.id &&
    managedWorker.requestId === binding.workItemId,
  );
  const workerSettlementMatches = Boolean(
    managedWorkerMatches &&
    managedWorker &&
    managedWorker.settleOutcome === "completed" &&
    managedWorker.settledAt !== null &&
    input.workSlotHeld === false,
  );
  const failedWorkerSettlementMatches = Boolean(
    managedWorkerMatches &&
    managedWorker &&
    managedWorker.settleOutcome === "failed" &&
    managedWorker.settledAt !== null &&
    managedWorker.resultSummary === null &&
    managedWorker.resultAt === null &&
    input.workState === "failed" &&
    input.workSlotHeld === false,
  );
  const settledWithoutResult =
    (input.workState === "completed" && input.workSlotHeld === false) ||
    (input.workState === "idle" && workerSettlementMatches) ||
    (input.workState === "failed" && input.workSlotHeld === false);
  const validTaskState = input.authorizedReset
    ? task.status === "ready" && task.assignedThreadId === null
    : (task.status === "running" || task.status === "review") &&
      task.assignedThreadId === attempt.workerThreadId;
  if (
    !settledWithoutResult ||
    input.hasPendingInputRequest === true ||
    input.currentGeneration !== binding.stageGeneration ||
    binding.planId !== input.planId ||
    binding.revision !== input.revision ||
    binding.nodeKey !== node.key ||
    binding.stageGeneration !== input.currentGeneration ||
    binding.taskId !== task.id ||
    task.projectId !== input.hubId ||
    task.archivedAt !== null ||
    !validTaskState ||
    attempt.id !== binding.attemptId ||
    attempt.taskId !== task.id ||
    attempt.projectId !== input.hubId ||
    input.workWorkerThreadId !== attempt.workerThreadId
  ) {
    return false;
  }

  // A structured result from any role is accepted evidence even if the plan
  // record has not yet been projected. `idle` alone is not a settled turn;
  // that state needs the matching completed managed-worker record above.
  if (
    managedWorkerMatches &&
    managedWorker &&
    (managedWorker.resultSummary !== null || managedWorker.resultAt !== null)
  ) {
    return false;
  }
  if (node.role === "worker" && !workerSettlementMatches && !failedWorkerSettlementMatches) {
    return false;
  }

  if (
    node.role === "author" &&
    input.candidates.some(
      (candidate) =>
        candidate.planId === input.planId &&
        candidate.revision === input.revision &&
        candidate.stageKey === node.stageKey &&
        candidate.generation === input.currentGeneration &&
        candidate.authorNodeKey === node.key &&
        candidate.authorAttemptId === attempt.id &&
        candidate.status !== "draft",
    )
  ) {
    return false;
  }

  if (
    node.role === "reviewer" &&
    input.reviews.some(
      (review) =>
        review.planId === input.planId &&
        review.revision === input.revision &&
        review.stageKey === node.stageKey &&
        review.generation === input.currentGeneration &&
        review.reviewerNodeKey === node.key &&
        review.attemptId === attempt.id &&
        review.status === "submitted",
    )
  ) {
    return false;
  }

  if (node.role === "worker") {
    // Worker nodes have no candidate/review records; only an empty matching
    // managed-worker result can be explicitly retried.
    if (input.workState === "idle" && !workerSettlementMatches) return false;
  }

  return true;
}

export function isAcceptedAfterStop(input: {
  readonly planId: string;
  readonly hubId: string;
  readonly revision: number;
  readonly nodeKey: string;
  readonly stageKey: string;
  readonly role: "author" | "reviewer" | "worker";
  readonly currentGeneration: number;
  readonly binding: HubPlanAttemptBinding;
  readonly task: ProjectTask;
  readonly attempt: ProjectTaskAttempt;
  readonly workState: HubPlanWorkState;
  readonly workWorkerThreadId: string | null;
  readonly candidates: readonly HubPlanCandidateRecord[];
  readonly reviews: readonly HubPlanReviewRecord[];
  readonly managedWorker?: ProjectManagedWorker;
}): boolean {
  const { binding, task, attempt } = input;
  if (
    input.workState !== "cancelled" ||
    input.currentGeneration !== binding.stageGeneration ||
    binding.planId !== input.planId ||
    binding.revision !== input.revision ||
    binding.nodeKey !== input.nodeKey ||
    binding.taskId !== task.id ||
    binding.attemptId !== attempt.id ||
    task.projectId !== input.hubId ||
    task.status !== "done" ||
    task.assignedThreadId !== attempt.workerThreadId ||
    input.workWorkerThreadId !== attempt.workerThreadId ||
    attempt.taskId !== task.id ||
    attempt.outcome !== "succeeded"
  ) {
    return false;
  }

  const candidate = input.candidates.find(
    (item) =>
      item.planId === input.planId &&
      item.revision === input.revision &&
      item.stageKey === input.stageKey &&
      item.generation === binding.stageGeneration &&
      item.status === "current" &&
      item.candidateId.trim().length > 0 &&
      item.outputDigest.trim().length > 0 &&
      (input.role !== "author" ||
        (item.authorNodeKey === input.nodeKey && item.authorAttemptId === attempt.id)),
  );
  if (!candidate) return false;

  if (input.role === "author") return true;
  if (input.role === "reviewer") {
    return input.reviews.some(
      (review) =>
        review.planId === input.planId &&
        review.revision === input.revision &&
        review.stageKey === input.stageKey &&
        review.generation === binding.stageGeneration &&
        review.candidateId === candidate.candidateId &&
        review.outputDigest === candidate.outputDigest &&
        review.reviewerNodeKey === input.nodeKey &&
        review.attemptId === attempt.id &&
        review.status === "submitted",
    );
  }

  const managedWorker = input.managedWorker;
  return Boolean(
    managedWorker &&
    managedWorker.projectId === input.hubId &&
    managedWorker.threadId === attempt.workerThreadId &&
    managedWorker.taskId === task.id &&
    managedWorker.requestId === binding.workItemId &&
    managedWorker.resultSummary !== null &&
    managedWorker.resultAt !== null,
  );
}

export interface HubPlanCandidateFact {
  readonly stageKey: string;
  readonly generation: number;
  readonly candidateId: string;
  readonly outputDigest: string;
  readonly authorNodeKey: string;
  readonly authorAttemptId: string;
  readonly summary: string | null;
  readonly status: "draft" | "current" | "superseded";
}

export interface HubPlanReviewFact {
  readonly stageKey: string;
  readonly generation: number;
  readonly candidateId: string;
  readonly outputDigest: string;
  readonly reviewerNodeKey: string;
  readonly attemptId: string;
  readonly outcome: "pass" | "changes_requested" | "blocked";
  readonly status: "draft" | "submitted";
}

export interface HubPlanReleaseFact {
  readonly stageKey: string;
  readonly generation: number;
  readonly candidateId: string;
  readonly outputDigest: string;
  readonly source: "auto" | "user";
  readonly effective: boolean;
}

const schemaIssue = (error: unknown): HubPlanValidationIssue => ({
  code: "schema.invalid",
  path: "$",
  message: `Plan definition does not match the strict Hub plan schema: ${
    error instanceof Error ? error.message : "invalid input"
  }`,
});

function findCycle(edges: ReadonlyMap<string, readonly string[]>): readonly string[] | null {
  const state = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];

  const visit = (key: string): readonly string[] | null => {
    const currentState = state.get(key) ?? 0;
    if (currentState === 1) {
      const start = stack.lastIndexOf(key);
      return [...stack.slice(start), key];
    }
    if (currentState === 2) return null;

    state.set(key, 1);
    stack.push(key);
    for (const adjacent of edges.get(key) ?? []) {
      const cycle = visit(adjacent);
      if (cycle) return cycle;
    }
    stack.pop();
    state.set(key, 2);
    return null;
  };

  for (const key of edges.keys()) {
    const cycle = visit(key);
    if (cycle) return cycle;
  }
  return null;
}

function cycleEdges(keys: readonly string[]): Map<string, string[]> {
  return new Map(keys.map((key) => [key, []]));
}

function pushEdge(edges: Map<string, string[]>, from: string, to: string): void {
  const adjacent = edges.get(from);
  if (adjacent && !adjacent.includes(to)) adjacent.push(to);
}

function nodeAncestors(
  nodeKey: string,
  nodesByKey: ReadonlyMap<string, HubPlanNodeDefinition>,
): ReadonlySet<string> {
  const ancestors = new Set<string>();
  const pending = [...(nodesByKey.get(nodeKey)?.dependsOnNodeKeys ?? [])];
  while (pending.length > 0) {
    const key = pending.pop();
    if (key === undefined || ancestors.has(key)) continue;
    ancestors.add(key);
    const ancestor = nodesByKey.get(key);
    if (ancestor) pending.push(...ancestor.dependsOnNodeKeys);
  }
  return ancestors;
}

/** Validate schema and graph rules without throwing for malformed input. */
export function validateHubPlanDefinition(def: unknown): HubPlanValidationIssue[] {
  try {
    if (typeof def === "object" && def !== null && "stages" in def && "nodes" in def) {
      const candidate = def as {
        readonly stages?: readonly unknown[];
        readonly nodes?: readonly unknown[];
      };
      if (Array.isArray(candidate.stages) && Array.isArray(candidate.nodes)) {
        const capIssues: HubPlanValidationIssue[] = [];
        for (const [stageIndex, rawStage] of candidate.stages.entries()) {
          if (typeof rawStage !== "object" || rawStage === null || !("key" in rawStage)) continue;
          const stageKey = (rawStage as { readonly key?: unknown }).key;
          if (typeof stageKey !== "string") continue;
          const stageNodes = candidate.nodes.filter(
            (rawNode) =>
              typeof rawNode === "object" &&
              rawNode !== null &&
              "stageKey" in rawNode &&
              (rawNode as { readonly stageKey?: unknown }).stageKey === stageKey,
          );
          const authorCount = stageNodes.filter(
            (rawNode) =>
              typeof rawNode === "object" &&
              rawNode !== null &&
              "role" in rawNode &&
              (rawNode as { readonly role?: unknown }).role === "author",
          ).length;
          const reviewerCount = stageNodes.filter(
            (rawNode) =>
              typeof rawNode === "object" &&
              rawNode !== null &&
              "role" in rawNode &&
              (rawNode as { readonly role?: unknown }).role === "reviewer",
          ).length;
          if (stageNodes.length === 0) {
            capIssues.push({
              code: "stage.empty",
              path: `stages[${stageIndex}]`,
              message: `Stage ${JSON.stringify(stageKey)} must contain at least one node.`,
            });
          }
          if (authorCount !== 1) {
            capIssues.push({
              code: "stage.author_count",
              path: `stages[${stageIndex}]`,
              message: `Stage ${JSON.stringify(stageKey)} must contain exactly one author node; found ${authorCount}.`,
            });
          }
          if (reviewerCount > HUB_PLAN_MAX_REVIEWERS_PER_STAGE) {
            capIssues.push({
              code: "stage.too_many_reviewers",
              path: `stages[${stageIndex}]`,
              message: `Stage ${JSON.stringify(stageKey)} has ${reviewerCount} reviewers; the limit is ${HUB_PLAN_MAX_REVIEWERS_PER_STAGE}.`,
            });
          }
        }
        if (capIssues.length > 0) return capIssues;
      }
    }

    let plan: HubPlanDefinition;
    try {
      plan = Schema.decodeUnknownSync(HubPlanDefinitionSchema)(def);
    } catch (error) {
      return [schemaIssue(error)];
    }

    const issues: HubPlanValidationIssue[] = [];
    const stagesByKey = new Map<string, number>();
    const nodesByKey = new Map<string, HubPlanNodeDefinition>();

    plan.stages.forEach((stage, index) => {
      const previousIndex = stagesByKey.get(stage.key);
      if (previousIndex !== undefined) {
        issues.push({
          code: "stage.duplicate_key",
          path: `stages[${index}].key`,
          message: `Stage key ${JSON.stringify(stage.key)} duplicates stages[${previousIndex}].key.`,
        });
      } else {
        stagesByKey.set(stage.key, index);
      }
    });

    plan.nodes.forEach((node, index) => {
      const previous = nodesByKey.get(node.key);
      if (previous) {
        issues.push({
          code: "node.duplicate_key",
          path: `nodes[${index}].key`,
          message: `Node key ${JSON.stringify(node.key)} is duplicated.`,
        });
      } else {
        nodesByKey.set(node.key, node);
      }
      if (!stagesByKey.has(node.stageKey)) {
        issues.push({
          code: "node.unknown_stage",
          path: `nodes[${index}].stageKey`,
          message: `Node ${JSON.stringify(node.key)} refers to missing stage ${JSON.stringify(node.stageKey)}.`,
        });
      }
    });

    const nodesPerStage = new Map<string, HubPlanNodeDefinition[]>();
    const reviewersPerStage = new Map<string, HubPlanNodeDefinition[]>();
    for (const node of plan.nodes) {
      const stageNodes = nodesPerStage.get(node.stageKey) ?? [];
      stageNodes.push(node);
      nodesPerStage.set(node.stageKey, stageNodes);
      if (node.role === "reviewer") {
        const reviewers = reviewersPerStage.get(node.stageKey) ?? [];
        reviewers.push(node);
        reviewersPerStage.set(node.stageKey, reviewers);
      }
    }
    for (const [index, stage] of plan.stages.entries()) {
      if ((nodesPerStage.get(stage.key)?.length ?? 0) === 0) {
        issues.push({
          code: "stage.empty",
          path: `stages[${index}]`,
          message: `Stage ${JSON.stringify(stage.key)} must contain at least one node.`,
        });
      }
      const reviewerCount = reviewersPerStage.get(stage.key)?.length ?? 0;
      if (reviewerCount > HUB_PLAN_MAX_REVIEWERS_PER_STAGE) {
        issues.push({
          code: "stage.too_many_reviewers",
          path: `stages[${index}]`,
          message: `Stage ${JSON.stringify(stage.key)} has ${reviewerCount} reviewers; the limit is ${HUB_PLAN_MAX_REVIEWERS_PER_STAGE}.`,
        });
      }
      const authorCount = (nodesPerStage.get(stage.key) ?? []).filter(
        (node) => node.role === "author",
      ).length;
      if (authorCount !== 1) {
        issues.push({
          code: "stage.author_count",
          path: `stages[${index}]`,
          message: `Stage ${JSON.stringify(stage.key)} must contain exactly one author node; found ${authorCount}.`,
        });
      }
    }

    const taskEdges = cycleEdges([...nodesByKey.keys()]);
    for (const [index, node] of plan.nodes.entries()) {
      const seenDependencies = new Set<string>();
      for (const [dependencyIndex, dependencyKey] of node.dependsOnNodeKeys.entries()) {
        const path = `nodes[${index}].dependsOnNodeKeys[${dependencyIndex}]`;
        if (dependencyKey === node.key) {
          issues.push({
            code: "dependency.self_edge",
            path,
            message: `Node ${JSON.stringify(node.key)} cannot depend on itself.`,
          });
          continue;
        }
        if (seenDependencies.has(dependencyKey)) {
          issues.push({
            code: "dependency.duplicate",
            path,
            message: `Dependency ${JSON.stringify(dependencyKey)} is repeated.`,
          });
          continue;
        }
        seenDependencies.add(dependencyKey);
        const dependency = nodesByKey.get(dependencyKey);
        if (!dependency) {
          issues.push({
            code: "dependency.unknown_node",
            path,
            message: `Dependency ${JSON.stringify(dependencyKey)} does not name a plan node.`,
          });
          continue;
        }
        pushEdge(taskEdges, node.key, dependencyKey);
      }
    }

    const taskCycle = findCycle(taskEdges);
    if (taskCycle) {
      issues.push({
        code: "dependency.task_cycle",
        path: "nodes",
        message: `Task dependency cycle: ${taskCycle.join(" -> ")}.`,
      });
    }

    for (const [index, node] of plan.nodes.entries()) {
      if (node.role !== "reviewer") continue;
      const hasSameStageAuthorAncestor = [...nodeAncestors(node.key, nodesByKey)].some((key) => {
        const ancestor = nodesByKey.get(key);
        return ancestor?.role === "author" && ancestor.stageKey === node.stageKey;
      });
      if (!hasSameStageAuthorAncestor) {
        issues.push({
          code: "reviewer.missing_author_ancestor",
          path: `nodes[${index}].dependsOnNodeKeys`,
          message: `Reviewer ${JSON.stringify(node.key)} must depend on a same-stage author node, directly or transitively.`,
        });
      }
    }

    const stageEdges = cycleEdges([...stagesByKey.keys()]);
    for (const node of plan.nodes) {
      for (const dependencyKey of node.dependsOnNodeKeys) {
        const dependency = nodesByKey.get(dependencyKey);
        if (
          dependency &&
          dependency.stageKey !== node.stageKey &&
          stagesByKey.has(dependency.stageKey) &&
          stagesByKey.has(node.stageKey)
        ) {
          // Dependencies point from prerequisite stage to dependent stage.
          pushEdge(stageEdges, dependency.stageKey, node.stageKey);
        }
      }
    }
    const stageCycle = findCycle(stageEdges);
    if (stageCycle) {
      issues.push({
        code: "dependency.stage_cycle",
        path: "stages",
        message: `Aggregated stage dependency cycle: ${stageCycle.join(" -> ")}. Split the stages to remove the exit deadlock.`,
      });
    }

    return issues;
  } catch (error) {
    return [schemaIssue(error)];
  }
}

interface EvaluatedStage {
  readonly view: HubPlanStageView;
}

function hasMatchingAttempt(
  fact: HubPlanTaskFact | undefined,
  attemptId: string,
  generation: number,
): boolean {
  return (
    fact?.taskStatus === "done" &&
    fact.currentAttempt?.attemptId === attemptId &&
    fact.currentAttempt.generation === generation
  );
}

function stageDependencyKeys(plan: HubPlanDefinition, stageKey: string): readonly string[] {
  const dependencies = new Set<string>();
  const nodesByKey = new Map(plan.nodes.map((node) => [node.key, node]));
  for (const node of plan.nodes) {
    if (node.stageKey !== stageKey) continue;
    for (const dependencyKey of node.dependsOnNodeKeys) {
      const dependency = nodesByKey.get(dependencyKey);
      if (dependency && dependency.stageKey !== stageKey) dependencies.add(dependency.stageKey);
    }
  }
  return [...dependencies];
}

/**
 * Pure projection over existing Task, attempt, HubWork and release facts. It does not mutate or
 * synthesize task state; callers map their native records into the readonly facts above.
 */
export function computeHubStageViews(
  def: HubPlanDefinition,
  facts: HubPlanGraphFacts,
): HubPlanGraphView {
  const nodesByKey = new Map(def.nodes.map((node) => [node.key, node]));
  const tasksByKey = new Map<string, HubPlanTaskFact>();
  const duplicateTaskKeys = new Set<string>();
  for (const task of facts.tasks) {
    if (tasksByKey.has(task.nodeKey)) duplicateTaskKeys.add(task.nodeKey);
    else tasksByKey.set(task.nodeKey, task);
  }
  for (const key of duplicateTaskKeys) tasksByKey.delete(key);

  const candidatesByStage = new Map<string, HubPlanCandidateFact[]>();
  for (const candidate of facts.currentCandidates) {
    if (candidate.status !== "current") continue;
    const stageCandidates = candidatesByStage.get(candidate.stageKey) ?? [];
    stageCandidates.push(candidate);
    candidatesByStage.set(candidate.stageKey, stageCandidates);
  }

  const evaluates = (stageKey: string): EvaluatedStage => {
    const stage = def.stages.find((item) => item.key === stageKey);
    if (!stage) {
      return {
        view: {
          stageKey,
          title: stageKey,
          releasePolicy: "auto",
          generation: facts.stageGenerations[stageKey] ?? null,
          status: "blocked",
          underlyingStatus: "blocked",
          isReleased: false,
          candidateId: null,
          outputDigest: null,
          outputSummary: null,
          blockingReasons: ["Stage definition is missing."],
        },
      };
    }

    const rawGeneration = facts.stageGenerations[stage.key];
    const generation =
      typeof rawGeneration === "number" && Number.isSafeInteger(rawGeneration) && rawGeneration > 0
        ? rawGeneration
        : null;
    const blockingReasons: string[] = [];
    if (generation === null) {
      blockingReasons.push("The current stage generation is unavailable or invalid.");
    }
    const stageNodes = def.nodes.filter((node) => node.stageKey === stage.key);
    const reviewers = stageNodes.filter((node) => node.role === "reviewer");
    const upstreamStages = stageDependencyKeys(def, stage.key);
    const unreleasedUpstream = upstreamStages.filter(
      (upstreamKey) => !evaluateCache.get(upstreamKey)?.view.isReleased,
    );
    if (unreleasedUpstream.length > 0) {
      blockingReasons.push(`Waiting for released stage(s): ${unreleasedUpstream.join(", ")}.`);
    }

    const taskFacts = stageNodes.map((node) => tasksByKey.get(node.key));
    const workIsSettled = (task: HubPlanTaskFact | undefined) =>
      task?.currentAttempt?.workState === "completed" ||
      (task?.currentAttempt?.workState === "cancelled" &&
        task.currentAttempt.acceptedAfterStop === true);
    const workWasCancelledWithoutAcceptedResult = (task: HubPlanTaskFact | undefined) =>
      task?.currentAttempt?.workState === "cancelled" &&
      task.currentAttempt.acceptedAfterStop !== true;
    const tasksHaveNoAmbiguity = stageNodes.every((node) => !duplicateTaskKeys.has(node.key));
    const allTasksDone =
      tasksHaveNoAmbiguity &&
      stageNodes.length > 0 &&
      taskFacts.every((task) => task?.taskStatus === "done");
    const allWorkSettled =
      tasksHaveNoAmbiguity && stageNodes.length > 0 && taskFacts.every(workIsSettled);
    if (!tasksHaveNoAmbiguity) blockingReasons.push("One or more task bindings are ambiguous.");

    const stageCandidates = candidatesByStage.get(stage.key) ?? [];
    const currentCandidates = stageCandidates.filter(
      (candidate) => candidate.generation === generation,
    );
    const candidate = currentCandidates.length === 1 ? currentCandidates[0] : undefined;
    if (currentCandidates.length > 1) {
      blockingReasons.push("More than one current candidate exists for this stage generation.");
    }
    const author = candidate ? nodesByKey.get(candidate.authorNodeKey) : undefined;
    const acceptedCandidate =
      candidate !== undefined &&
      generation !== null &&
      author?.role === "author" &&
      author.stageKey === stage.key &&
      hasMatchingAttempt(tasksByKey.get(author.key), candidate.authorAttemptId, generation);
    if (candidate && !acceptedCandidate) {
      blockingReasons.push(
        "The current candidate is not bound to the accepted current author attempt.",
      );
    }
    const draftCandidateExists = facts.currentCandidates.some(
      (item) =>
        item.stageKey === stage.key && item.generation === generation && item.status === "draft",
    );

    const matchedReviews = new Map<string, HubPlanReviewFact>();
    const ambiguousReviewers = new Set<string>();
    if (acceptedCandidate && candidate) {
      for (const review of facts.effectiveReviews) {
        if (
          review.stageKey !== stage.key ||
          review.generation !== generation ||
          review.candidateId !== candidate.candidateId ||
          review.outputDigest !== candidate.outputDigest ||
          review.status !== "submitted"
        ) {
          continue;
        }
        const reviewer = nodesByKey.get(review.reviewerNodeKey);
        if (
          reviewer?.role !== "reviewer" ||
          reviewer.stageKey !== stage.key ||
          !reviewers.some((required) => required.key === reviewer.key) ||
          !hasMatchingAttempt(tasksByKey.get(reviewer.key), review.attemptId, generation)
        ) {
          continue;
        }
        if (matchedReviews.has(reviewer.key)) ambiguousReviewers.add(reviewer.key);
        else matchedReviews.set(reviewer.key, review);
      }
    }
    for (const reviewerKey of ambiguousReviewers) matchedReviews.delete(reviewerKey);
    if (ambiguousReviewers.size > 0) {
      blockingReasons.push(
        `Reviewer submissions are ambiguous: ${[...ambiguousReviewers].join(", ")}.`,
      );
    }

    const anyChangesRequested = [...matchedReviews.values()].some(
      (review) => review.outcome === "changes_requested",
    );
    const anyReviewBlocked = [...matchedReviews.values()].some(
      (review) => review.outcome === "blocked",
    );
    const allReviewsPassed =
      acceptedCandidate &&
      reviewers.every((reviewer) => matchedReviews.get(reviewer.key)?.outcome === "pass") &&
      !anyChangesRequested &&
      !anyReviewBlocked;
    if (acceptedCandidate && !allReviewsPassed && !anyChangesRequested && !anyReviewBlocked) {
      blockingReasons.push(
        "All required reviewers must submit a pass for the current candidate and generation.",
      );
    }
    if (anyChangesRequested) blockingReasons.push("A current required review requested changes.");
    if (anyReviewBlocked) blockingReasons.push("A current required review is blocked.");

    const release = facts.effectiveReleases.find(
      (item) =>
        item.effective &&
        item.stageKey === stage.key &&
        item.generation === generation &&
        item.candidateId === candidate?.candidateId &&
        item.outputDigest === candidate?.outputDigest &&
        item.source === stage.releasePolicy,
    );
    const isReleased = Boolean(
      facts.controlState !== "draft" &&
      acceptedCandidate &&
      allReviewsPassed &&
      release &&
      allTasksDone &&
      allWorkSettled,
    );
    const unfinishedTasks = stageNodes.filter(
      (node) => tasksByKey.get(node.key)?.taskStatus !== "done",
    );
    const unfinishedFacts = unfinishedTasks.map((node) => tasksByKey.get(node.key));
    const unsettledFacts = taskFacts.filter(
      (task) => task?.taskStatus !== "done" || !workIsSettled(task),
    );
    const unfinishedTaskBlocked = unfinishedFacts.some(
      (task) =>
        task?.taskStatus === "blocked" ||
        task?.taskStatus === "cancelled" ||
        task?.currentAttempt?.workState === "failed" ||
        workWasCancelledWithoutAcceptedResult(task),
    );
    const unsettledWorkBlocked = taskFacts.some(
      (task) =>
        task?.currentAttempt?.workState === "failed" || workWasCancelledWithoutAcceptedResult(task),
    );
    if (acceptedCandidate && unfinishedTasks.length > 0) {
      blockingReasons.push("Every stage task must be done before the stage can be released.");
    }
    const authorsDone = stageNodes.some(
      (node) => node.role === "author" && tasksByKey.get(node.key)?.taskStatus === "done",
    );

    let status: HubPlanStageStatus = "not_started";
    if (facts.controlState === "draft") {
      status = "draft";
    } else if (facts.controlState === "cancelled") {
      status = "cancelled";
    } else if (generation === null) {
      status = "blocked";
    } else if (isReleased) {
      status = "released";
    } else if (unreleasedUpstream.length > 0) {
      status = "blocked";
    } else if (taskFacts.some((task) => task?.waitingForUserInput === true)) {
      status = "waiting";
    } else if (anyChangesRequested) {
      status = "changes_requested";
    } else if (taskFacts.some((task) => task?.retryable === true)) {
      status = "blocked";
      blockingReasons.push(
        taskFacts.some(
          (task) => task?.retryable === true && task.currentAttempt?.workState === "failed",
        )
          ? "A provider turn failed without an accepted node result; an explicit retry is available."
          : "A provider turn completed without an accepted node result; an explicit retry is available.",
      );
    } else if (
      anyReviewBlocked ||
      (acceptedCandidate && unfinishedTaskBlocked) ||
      (acceptedCandidate && unsettledWorkBlocked) ||
      !tasksHaveNoAmbiguity ||
      currentCandidates.length > 1
    ) {
      status = "blocked";
    } else if (acceptedCandidate && allReviewsPassed && allTasksDone && allWorkSettled) {
      status = stage.releasePolicy === "user" ? "waiting_user" : "ready_to_release";
    } else if (
      acceptedCandidate &&
      allReviewsPassed &&
      (unfinishedTasks.length > 0 || !allWorkSettled)
    ) {
      if (unsettledFacts.some((task) => task?.currentAttempt?.workState === "queued")) {
        status = "queued";
      } else if (
        unsettledFacts.some((task) =>
          task?.currentAttempt
            ? ["starting", "working"].includes(task.currentAttempt.workState)
            : false,
        )
      ) {
        status = "running";
      } else {
        status = unfinishedTasks.length > 0 ? "waiting" : "running";
      }
    } else if (acceptedCandidate) {
      const reviewerFacts = reviewers.map((reviewer) => tasksByKey.get(reviewer.key));
      if (
        reviewerFacts.some(
          (task) =>
            task?.taskStatus === "blocked" ||
            task?.taskStatus === "cancelled" ||
            task?.currentAttempt?.workState === "failed" ||
            workWasCancelledWithoutAcceptedResult(task),
        )
      ) {
        status = "blocked";
      } else if (reviewerFacts.some((task) => task?.currentAttempt?.workState === "queued")) {
        status = "queued";
      } else if (
        reviewerFacts.some((task) =>
          task?.currentAttempt
            ? ["starting", "working"].includes(task.currentAttempt.workState)
            : false,
        )
      ) {
        status = "running";
      } else if (reviewerFacts.some((task) => task?.currentAttempt?.workState === "waiting")) {
        status = "waiting";
      } else {
        status = "reviewing";
      }
    } else if (draftCandidateExists || (authorsDone && !candidate)) {
      status = "awaiting_candidate";
      blockingReasons.push("A draft candidate is not an accepted current candidate.");
    } else if (candidate && !acceptedCandidate) {
      status = "awaiting_candidate";
    } else {
      const anyTaskBlocked = taskFacts.some(
        (task) => task?.taskStatus === "blocked" || task?.taskStatus === "cancelled",
      );
      const workStates = new Set(
        taskFacts.flatMap((task) => (task?.currentAttempt ? [task.currentAttempt.workState] : [])),
      );
      if (
        anyTaskBlocked ||
        workStates.has("failed") ||
        taskFacts.some(workWasCancelledWithoutAcceptedResult)
      ) {
        status = "blocked";
      } else if (workStates.has("queued")) {
        status = "queued";
      } else if (workStates.has("starting") || workStates.has("working")) {
        status = "running";
      } else if (workStates.has("waiting")) {
        status = "waiting";
      } else if (taskFacts.some((task) => task?.taskStatus === "ready")) {
        status = "ready";
      }
    }

    if (candidate && !acceptedCandidate)
      blockingReasons.push("Candidate acceptance is still pending.");
    if (acceptedCandidate && allReviewsPassed && !isReleased) {
      blockingReasons.push(
        stage.releasePolicy === "user"
          ? "Awaiting a matching user release for the current candidate."
          : "Awaiting a matching effective automatic release for the current candidate.",
      );
    }
    const effectiveStatus =
      facts.controlState === "paused"
        ? "paused"
        : facts.controlState === "pausing"
          ? "pausing"
          : facts.controlState === "cancelling"
            ? "cancelling"
            : status;

    return {
      view: {
        stageKey: stage.key,
        title: stage.title,
        releasePolicy: stage.releasePolicy,
        generation,
        status: effectiveStatus,
        underlyingStatus: status,
        isReleased,
        candidateId: candidate?.candidateId ?? null,
        outputDigest: candidate?.outputDigest ?? null,
        outputSummary: candidate?.summary ?? null,
        blockingReasons: [...new Set(blockingReasons)],
      },
    };
  };

  const evaluateCache = new Map<string, EvaluatedStage>();
  const visiting = new Set<string>();
  const evaluateWithDependencies = (stageKey: string): EvaluatedStage => {
    const cached = evaluateCache.get(stageKey);
    if (cached) return cached;
    if (visiting.has(stageKey)) {
      return {
        view: {
          stageKey,
          title: stageKey,
          releasePolicy: "auto",
          generation: facts.stageGenerations[stageKey] ?? null,
          status: "blocked",
          underlyingStatus: "blocked",
          isReleased: false,
          candidateId: null,
          outputDigest: null,
          outputSummary: null,
          blockingReasons: ["Stage dependency cycle prevents projection."],
        },
      };
    }
    visiting.add(stageKey);
    for (const dependencyKey of stageDependencyKeys(def, stageKey)) {
      evaluateWithDependencies(dependencyKey);
    }
    visiting.delete(stageKey);
    const evaluated = evaluates(stageKey);
    evaluateCache.set(stageKey, evaluated);
    return evaluated;
  };

  for (const stage of def.stages) evaluateWithDependencies(stage.key);
  const stages = def.stages
    .map((stage) => evaluateCache.get(stage.key)?.view)
    .filter((view): view is HubPlanStageView => view !== undefined);
  const releasedCount = stages.filter((stage) => stage.isReleased).length;

  return {
    controlState: facts.controlState,
    stages,
    releasedCount,
    stageCount: def.stages.length,
  };
}
