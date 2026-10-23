import { createHash, randomUUID } from "node:crypto";

import {
  HubPlanCommandInputSchema,
  HubPlanEventsInputSchema,
  HubPlanEventSchema,
  HubPlanInputRequestSchema,
  HubPlanListInputSchema,
  HubPlanProposeInputSchema,
  HubPlanReadInputSchema,
  HubPlanSnapshotSchema,
  type HubDeliverableReferenceMetadata,
  type HubPlanCommandInput,
  type HubPlanDefinition,
  type HubPlanEvent,
  type HubPlanInputRequest,
  type HubPlanNodeState,
  type HubPlanProposeInput,
  type HubPlanSnapshot,
  type HubPlanStageView,
  HUB_PLAN_MAX_INPUT_REQUESTS,
  type HubWorkRecord,
  type HubWorkSourceMessage,
  type MessageId,
  type ProjectAgentConfig,
  type ProjectGoal,
  type ProjectManagedWorker,
  ProjectGoalId,
  ProjectId,
  type ProjectTask,
  ProjectTaskId,
  type ProjectTaskAttempt,
  type ProjectTaskAttemptId,
  type ThreadId,
} from "@synara/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  HubPlanStoreConflictError,
  HubPlanStoreIdempotencyError,
  type HubPlanAttemptBinding,
  type HubPlanCandidateRecord,
  type HubPlanConfigSnapshot,
  type HubPlanEvent as HubPlanStoredEvent,
  type HubPlanInputRequestRecord,
  type HubPlanNodeBinding,
  type HubPlanReviewRecord,
  type HubPlanStore,
  type HubPlanStoreError,
  type PlanRecord,
} from "./HubPlanStore.ts";
import {
  computeHubStageViews,
  validateHubPlanDefinition,
  type HubPlanGraphFacts,
  type HubPlanReviewFact,
  type HubPlanTaskFact,
  type HubPlanTaskStatus,
  type HubPlanWorkState,
  isRetryableHubPlanAttempt,
  isAcceptedAfterStop,
} from "./planGraph.ts";
import { hubPlanInputResponseIdentity, hubPlanInputResponseDigest } from "./hubPlanInput.ts";

export type HubPlanPrincipal =
  | { readonly kind: "user" }
  | { readonly kind: "coordinator"; readonly hubId: ProjectId; readonly threadId: ThreadId }
  | { readonly kind: "worker"; readonly hubId: ProjectId; readonly threadId: ThreadId };

/** Narrow injected host capabilities; this service never reaches into host internals. */
export interface HubPlanServiceNativeCapabilities {
  readonly readConfig: (hubId: ProjectId) => Effect.Effect<ProjectAgentConfig, unknown>;
  readonly getActiveGoal: (hubId: ProjectId) => Effect.Effect<ProjectGoal | null, unknown>;
  readonly getGoal: (goalId: ProjectGoal["id"]) => Effect.Effect<ProjectGoal | null, unknown>;
  readonly getTask: (taskId: ProjectTask["id"]) => Effect.Effect<ProjectTask | null, unknown>;
  readonly readTasks: (goalId: ProjectGoal["id"]) => Effect.Effect<readonly ProjectTask[], unknown>;
  readonly saveGoal: (
    goal: ProjectGoal,
    expectedRevision: number | null,
  ) => Effect.Effect<ProjectGoal, unknown>;
  readonly saveTask: (
    task: ProjectTask,
    expectedRevision: number | null,
  ) => Effect.Effect<ProjectTask, unknown>;
  readonly listAttempts: (
    taskId: ProjectTask["id"],
  ) => Effect.Effect<readonly ProjectTaskAttempt[], unknown>;
  readonly saveAttempt: (attempt: ProjectTaskAttempt) => Effect.Effect<ProjectTaskAttempt, unknown>;
  readonly readManagedWorkerByThread: (
    threadId: ThreadId,
  ) => Effect.Effect<ProjectManagedWorker | null, unknown>;
  readonly readWork: (workItemId: string) => Effect.Effect<HubWorkRecord | null, unknown>;
  readonly finalizePlanNode: (input: {
    readonly hubId: ProjectId;
    readonly planId: string;
    readonly revision: number;
    readonly nodeKey: string;
    readonly taskId: ProjectTaskId;
    readonly attemptId: ProjectTaskAttemptId;
    readonly workItemId: string;
    readonly workerThreadId: ThreadId;
    readonly requestId: string;
    readonly outcome: "candidate" | "review" | "worker";
    readonly summary: string;
    /** Server acceptance time. Never supplied by the command body. */
    readonly submittedAt: string;
  }) => Effect.Effect<void, unknown>;
  readonly readSourceMessages: (
    hubId: ProjectId,
    sourceMessageIds: readonly MessageId[],
  ) => Effect.Effect<readonly HubWorkSourceMessage[], unknown>;
  readonly freezeExperts: (expertIds: readonly string[]) => Effect.Effect<
    readonly {
      readonly expertId: string;
      readonly snapshotId: string;
      readonly revision: number;
    }[],
    unknown
  >;
  readonly validateDeliverables: (
    hubId: ProjectId,
    deliverableRefs: readonly HubDeliverableReferenceMetadata[],
    authorThreadId: ThreadId,
  ) => Effect.Effect<void, unknown>;
}

export type HubPlanServiceStore = HubPlanStore & {
  readonly readLatestEventSequence: (input: {
    readonly hubId: string;
    readonly planId?: string;
  }) => Effect.Effect<number, HubPlanStoreError>;
};

export interface HubPlanServiceDependencies {
  readonly store: HubPlanServiceStore;
  readonly native: HubPlanServiceNativeCapabilities;
}

export type HubPlanServiceErrorCode =
  | "forbidden"
  | "invalid_request"
  | "invalid_plan"
  | "not_found"
  | "conflict"
  | "stale_candidate"
  | "idempotency_conflict"
  | "dependency_not_released"
  | "repair_budget_exhausted"
  | "capability_unavailable"
  | "invalid_state"
  | "internal";

export class HubPlanServiceError extends Schema.TaggedErrorClass<HubPlanServiceError>()(
  "HubPlanServiceError",
  { code: Schema.String, detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}

export interface HubPlanService {
  readonly list: (
    input: { readonly hubId: ProjectId },
    principal: HubPlanPrincipal,
  ) => Effect.Effect<readonly HubPlanSnapshot[], HubPlanServiceError>;
  readonly read: (
    input: { readonly hubId: ProjectId; readonly planId: string },
    principal: HubPlanPrincipal,
  ) => Effect.Effect<HubPlanSnapshot | null, HubPlanServiceError>;
  readonly events: (
    input: { readonly hubId: ProjectId; readonly afterSequence: number },
    principal: HubPlanPrincipal,
  ) => Effect.Effect<readonly HubPlanEvent[], HubPlanServiceError>;
  readonly propose: (
    input: HubPlanProposeInput,
    principal: HubPlanPrincipal,
  ) => Effect.Effect<HubPlanSnapshot, HubPlanServiceError>;
  readonly command: (
    input: HubPlanCommandInput,
    principal: HubPlanPrincipal,
  ) => Effect.Effect<HubPlanSnapshot, HubPlanServiceError>;
  readonly reconcile: (
    hubId: ProjectId,
  ) => Effect.Effect<HubPlanSnapshot | null, HubPlanServiceError>;
}

type CandidateWithDeliverables = HubPlanCandidateRecord & {
  readonly deliverableRefs: readonly HubDeliverableReferenceMetadata[];
};

const now = (): string => new Date().toISOString();
const fail = <A = never>(
  code: HubPlanServiceErrorCode,
  detail: string,
): Effect.Effect<A, HubPlanServiceError> => Effect.fail(new HubPlanServiceError({ code, detail }));

const errorText = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

const mapError = (cause: unknown, operation: string): HubPlanServiceError => {
  if (cause instanceof HubPlanServiceError) return cause;
  if (cause instanceof HubPlanStoreConflictError) {
    return new HubPlanServiceError({ code: "conflict", detail: cause.message });
  }
  if (cause instanceof HubPlanStoreIdempotencyError) {
    return new HubPlanServiceError({ code: "idempotency_conflict", detail: cause.message });
  }
  return new HubPlanServiceError({ code: "internal", detail: `${operation}: ${errorText(cause)}` });
};

const decodeRequest = <A>(schema: Schema.Codec<A, unknown>, input: unknown, operation: string) =>
  Effect.try({
    try: () => Schema.decodeUnknownSync(schema)(input),
    catch: (cause) =>
      new HubPlanServiceError({
        code: "invalid_request",
        detail: `${operation}: ${errorText(cause)}`,
      }),
  });

const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, child]) => child !== undefined)
        .toSorted(([a], [b]) => a.localeCompare(b))
        .map(([key, child]) => [key, canonicalize(child)]),
    );
  }
  return value;
};

const canonicalJson = (value: unknown): string => JSON.stringify(canonicalize(value));

const commandDigest = (value: unknown): string =>
  createHash("sha256").update(canonicalJson(value)).digest("hex");

const immutableJsonCopy = <A>(value: A): A => JSON.parse(JSON.stringify(value)) as A;

const digestDeliverables = (refs: readonly HubDeliverableReferenceMetadata[]): string => {
  const stable = refs
    .map((reference) => ({
      hubId: reference.hubId,
      workerThreadId: reference.workerThreadId,
      revision: reference.revision,
      commitSha: reference.commitSha,
      file: {
        path: reference.file.path,
        name: reference.file.name,
        description: reference.file.description,
        mediaType: reference.file.mediaType,
        sizeBytes: reference.file.sizeBytes,
        sha256: reference.file.sha256,
      },
    }))
    .toSorted((a, b) => a.file.path.localeCompare(b.file.path));
  return `sha256:${createHash("sha256").update(canonicalJson(stable)).digest("hex")}`;
};

const taskStatus = (task: ProjectTask | undefined): HubPlanTaskStatus => task?.status ?? "planned";

const workStateFromAttempt = (
  attempt: ProjectTaskAttempt,
  work: HubWorkRecord | null,
): HubPlanWorkState => {
  if (work) return work.state;
  // Without the durable HubWork completion fact, success on the native attempt alone
  // cannot prove that the execution slot and stage work have settled.
  if (attempt.outcome === "succeeded") return "working";
  if (attempt.outcome === "failed") return "failed";
  if (attempt.outcome === "interrupted") return "cancelled";
  return "working";
};

const newestAttempt = (attempts: readonly ProjectTaskAttempt[]): ProjectTaskAttempt | undefined =>
  [...attempts].toSorted(
    (a, b) => b.attemptNumber - a.attemptNumber || b.createdAt.localeCompare(a.createdAt),
  )[0];

const newestAttemptBinding = (
  bindings: readonly HubPlanAttemptBinding[],
): HubPlanAttemptBinding | undefined =>
  [...bindings].toSorted(
    (a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id),
  )[0];

const currentInputRequestRecords = (input: {
  readonly record: PlanRecord;
  readonly store: HubPlanServiceStore;
  readonly native: HubPlanServiceNativeCapabilities;
}) =>
  Effect.gen(function* () {
    const { record, store, native } = input;
    const [requests, nodeBindings, attemptBindings] = yield* Effect.all(
      [
        store.listInputRequests({ planId: record.id }),
        store.listBindings({ planId: record.id }),
        store.listAttemptBindings({ planId: record.id }),
      ],
      { concurrency: 1 },
    ).pipe(Effect.mapError((cause) => mapError(cause, "read plan input requests")));
    const projected: HubPlanInputRequest[] = [];
    for (const request of requests) {
      let isCurrent =
        request.revision === record.revision &&
        request.generation === record.stageGenerations[request.stageKey] &&
        !["draft", "cancelling", "cancelled", "completed"].includes(record.controlState);
      const node = record.definition.nodes.find((candidate) => candidate.key === request.nodeKey);
      const binding = nodeBindings.find(
        (candidate) =>
          candidate.revision === request.revision && candidate.nodeKey === request.nodeKey,
      );
      const matchingAttemptBinding = newestAttemptBinding(
        attemptBindings.filter(
          (candidate) =>
            candidate.revision === request.revision &&
            candidate.nodeKey === request.nodeKey &&
            candidate.stageGeneration === request.generation,
        ),
      );
      const task = binding
        ? yield* native
            .getTask(ProjectTaskId.makeUnsafe(binding.taskId))
            .pipe(Effect.mapError((cause) => mapError(cause, "read input request task")))
        : null;
      const attempts = task
        ? yield* native
            .listAttempts(task.id)
            .pipe(Effect.mapError((cause) => mapError(cause, "read input request attempts")))
        : [];
      const attempt = attempts.find((candidate) => candidate.id === request.attemptId);
      const work = matchingAttemptBinding
        ? yield* native
            .readWork(matchingAttemptBinding.workItemId)
            .pipe(Effect.mapError((cause) => mapError(cause, "read input request work")))
        : null;
      isCurrent = Boolean(
        isCurrent &&
        node?.stageKey === request.stageKey &&
        binding?.stageKey === request.stageKey &&
        binding.role === node.role &&
        matchingAttemptBinding?.attemptId === request.attemptId &&
        task?.projectId === record.hubId &&
        task.goalId === record.goalId &&
        task.assignedThreadId === request.workerThreadId &&
        attempt?.workerThreadId === request.workerThreadId &&
        attempt.outcome === "running" &&
        work?.workerThreadId === request.workerThreadId &&
        work.state !== "cancelled" &&
        work.state !== "failed",
      );
      const status =
        (request.status === "pending" || request.status === "answered") && !isCurrent
          ? "stale"
          : request.status;
      projected.push({
        id: request.id,
        nodeKey: request.nodeKey,
        stageKey: request.stageKey,
        generation: request.generation,
        attemptId: request.attemptId,
        workerThreadId: request.workerThreadId,
        questions: request.questions,
        status,
        ...(request.answers === undefined ? {} : { answers: request.answers }),
      });
    }
    return projected;
  });

function assertHubPrincipal(
  principal: HubPlanPrincipal,
  hubId: ProjectId,
): Effect.Effect<void, HubPlanServiceError> {
  if (principal.kind !== "user" && principal.hubId !== hubId) {
    return fail("forbidden", "Principal is scoped to a different Hub.");
  }
  return Effect.void;
}

function planConfigSnapshot(config: ProjectAgentConfig): HubPlanConfigSnapshot {
  return {
    configRevision: config.revision,
    ...(config.collaboration === undefined ? {} : { settings: config.collaboration }),
    expertIds: [...(config.expertIds ?? [])],
  };
}

function definitionConfigIssues(
  definition: HubPlanDefinition,
  config: ProjectAgentConfig,
): string[] {
  const issues: string[] = [];
  if (
    !config.enabled ||
    config.disabledAt !== null ||
    config.pausedAt != null ||
    config.archivedAt != null
  ) {
    issues.push("Hub configuration must be enabled, active, and unarchived.");
  }
  const expertIds = config.expertIds ?? [];
  const roster = new Set(expertIds);
  if (roster.size !== expertIds.length) issues.push("Hub Expert roster contains duplicate IDs.");
  const mode = config.collaboration?.mode ?? "standard";
  for (const node of definition.nodes) {
    if (node.expertId !== undefined && !roster.has(node.expertId)) {
      issues.push(
        `Node '${node.key}' references Expert '${node.expertId}' outside the current roster.`,
      );
    }
    if (mode === "expert-team" && node.expertId === undefined) {
      issues.push(`Expert-team node '${node.key}' must select an Expert from the Hub roster.`);
    }
    if (node.target === undefined) {
      issues.push(`Node '${node.key}' must select an explicit model target.`);
    }
  }
  return issues;
}

function sortedUniqueStrings(values: readonly string[]): readonly string[] {
  return [...new Set(values)].toSorted((left, right) => left.localeCompare(right));
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function downstreamStageKeys(definition: HubPlanDefinition, startKey: string): ReadonlySet<string> {
  const nodeByKey = new Map(definition.nodes.map((node) => [node.key, node]));
  const outgoing = new Map(definition.stages.map((stage) => [stage.key, new Set<string>()]));
  for (const node of definition.nodes) {
    for (const dependencyKey of node.dependsOnNodeKeys) {
      const prerequisite = nodeByKey.get(dependencyKey);
      if (prerequisite && prerequisite.stageKey !== node.stageKey) {
        outgoing.get(prerequisite.stageKey)?.add(node.stageKey);
      }
    }
  }
  const affected = new Set<string>([startKey]);
  const pending = [startKey];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) continue;
    for (const next of outgoing.get(current) ?? []) {
      if (!affected.has(next)) {
        affected.add(next);
        pending.push(next);
      }
    }
  }
  return affected;
}

function topologicalNodeOrder(
  definition: HubPlanDefinition,
): readonly HubPlanDefinition["nodes"][number][] {
  const byKey = new Map(definition.nodes.map((node) => [node.key, node]));
  const visited = new Set<string>();
  const ordered: HubPlanDefinition["nodes"][number][] = [];
  const visit = (key: string) => {
    if (visited.has(key)) return;
    visited.add(key);
    const node = byKey.get(key);
    if (!node) return;
    for (const dependency of node.dependsOnNodeKeys) visit(dependency);
    ordered.push(node);
  };
  for (const node of definition.nodes) visit(node.key);
  return ordered;
}

function nodeStageByKey(definition: HubPlanDefinition, nodeKey: string): string | undefined {
  return definition.nodes.find((node) => node.key === nodeKey)?.stageKey;
}

const isActiveWorkState = (state: HubPlanWorkState | undefined): boolean =>
  state !== undefined && ["queued", "starting", "working", "waiting"].includes(state);

function validateSourceMessages(
  requestedIds: readonly MessageId[],
  messages: readonly HubWorkSourceMessage[],
): boolean {
  return (
    messages.length === requestedIds.length &&
    requestedIds.every((id, index) => messages[index]?.messageId === id) &&
    new Set(messages.map((message) => message.messageId)).size === messages.length
  );
}

function stageView(snapshot: HubPlanSnapshot, stageKey: string): HubPlanStageView | undefined {
  return snapshot.graph.stages.find((stage) => stage.stageKey === stageKey);
}

function validateDigestForRefs(
  refs: readonly HubDeliverableReferenceMetadata[],
  digest: string,
): boolean {
  return refs.length > 0 && digestDeliverables(refs) === digest;
}

function sameCandidateSubmission(
  left: CandidateWithDeliverables,
  right: CandidateWithDeliverables,
): boolean {
  return (
    left.revision === right.revision &&
    left.stageKey === right.stageKey &&
    left.generation === right.generation &&
    left.authorNodeKey === right.authorNodeKey &&
    left.authorAttemptId === right.authorAttemptId &&
    left.outputDigest === right.outputDigest &&
    left.summary === right.summary
  );
}

function sameReviewSubmission(left: HubPlanReviewRecord, right: HubPlanReviewRecord): boolean {
  return (
    left.revision === right.revision &&
    left.candidateId === right.candidateId &&
    left.reviewerNodeKey === right.reviewerNodeKey &&
    left.attemptId === right.attemptId &&
    left.generation === right.generation &&
    left.outputDigest === right.outputDigest &&
    left.outcome === right.outcome &&
    left.summary === right.summary
  );
}

function isCurrentTaskAttempt(
  attempt: ProjectTaskAttempt | undefined,
  attemptId: ProjectTaskAttemptId,
  work: HubWorkRecord | null,
  task: ProjectTask,
  principal: HubPlanPrincipal,
): boolean {
  if (
    !attempt ||
    attempt.id !== attemptId ||
    attempt.taskId !== task.id ||
    attempt.projectId !== task.projectId
  ) {
    return false;
  }
  if (attempt.outcome !== "succeeded" || task.status !== "done") return false;
  if (!work || work.state !== "completed" || work.workerThreadId !== attempt.workerThreadId)
    return false;
  const authorThreadId = attempt.workerThreadId;
  return principal.kind === "worker" && principal.threadId === authorThreadId;
}

function isCurrentRunningTaskAttempt(
  attempt: ProjectTaskAttempt | undefined,
  attemptId: ProjectTaskAttemptId,
  work: HubWorkRecord | null,
  task: ProjectTask,
  principal: HubPlanPrincipal,
): boolean {
  if (
    !attempt ||
    attempt.id !== attemptId ||
    attempt.taskId !== task.id ||
    attempt.projectId !== task.projectId ||
    attempt.outcome !== "running" ||
    !["running", "review"].includes(task.status) ||
    task.assignedThreadId !== attempt.workerThreadId ||
    !work ||
    work.state !== "working" ||
    work.workerThreadId !== attempt.workerThreadId
  ) {
    return false;
  }
  return principal.kind === "worker" && principal.threadId === attempt.workerThreadId;
}

function isFinalizedPendingWorkAttempt(
  attempt: ProjectTaskAttempt | undefined,
  attemptId: ProjectTaskAttemptId,
  work: HubWorkRecord | null,
  task: ProjectTask,
  principal: HubPlanPrincipal,
): boolean {
  if (
    !attempt ||
    attempt.id !== attemptId ||
    attempt.taskId !== task.id ||
    attempt.projectId !== task.projectId ||
    attempt.outcome !== "succeeded" ||
    task.status !== "done" ||
    !work ||
    work.state !== "working" ||
    work.workerThreadId !== attempt.workerThreadId
  ) {
    return false;
  }
  return principal.kind === "worker" && principal.threadId === attempt.workerThreadId;
}

export function makeHubPlanService(dependencies: HubPlanServiceDependencies): HubPlanService {
  const { store, native } = dependencies;

  const readReceipt = (hubId: ProjectId, requestId: string, digest: string) =>
    store.readReceipt({ hubId, requestId }).pipe(
      Effect.mapError((cause) => mapError(cause, "read operation receipt")),
      Effect.flatMap((receipt) => {
        if (!receipt) return Effect.succeed(null);
        if (receipt.digest !== digest) {
          return fail(
            "idempotency_conflict",
            "Request ID was already used with different content.",
          );
        }
        return decodeRequest(
          Schema.fromJsonString(HubPlanSnapshotSchema),
          receipt.resultJson,
          "read operation receipt",
        ).pipe(Effect.map((snapshot) => snapshot as HubPlanSnapshot));
      }),
    );

  const writeReceipt = (input: {
    readonly hubId: ProjectId;
    readonly requestId: string;
    readonly digest: string;
    readonly snapshot: HubPlanSnapshot;
  }) =>
    store
      .writeReceipt({
        hubId: input.hubId,
        requestId: input.requestId,
        digest: input.digest,
        resultJson: canonicalJson(input.snapshot),
      })
      .pipe(Effect.mapError((cause) => mapError(cause, "write operation receipt")));

  const latestSequence = (hubId: ProjectId) =>
    store
      .readLatestEventSequence({ hubId })
      .pipe(Effect.mapError((cause) => mapError(cause, "read latest event sequence")));

  const readNodeStates = (record: PlanRecord, graphFacts: HubPlanGraphFacts) =>
    Effect.gen(function* () {
      if (record.goalId === null) return [] as HubPlanSnapshot["nodeStates"];
      const [nativeTasks, bindings, attemptBindings, inputRequests] = yield* Effect.all(
        [
          native.readTasks(ProjectGoalId.makeUnsafe(record.goalId)),
          store.listBindings({ planId: record.id, revision: record.revision }),
          store.listAttemptBindings({ planId: record.id }),
          currentInputRequestRecords({ record, store, native }),
        ],
        { concurrency: 1 },
      ).pipe(Effect.mapError((cause) => mapError(cause, "read node bindings")));
      const taskById = new Map(
        nativeTasks
          .filter((task) => task.projectId === record.hubId && task.goalId === record.goalId)
          .map((task) => [task.id, task]),
      );
      const attemptsByTask = new Map<string, HubPlanAttemptBinding[]>();
      for (const binding of attemptBindings) {
        if (binding.revision !== record.revision) continue;
        const bucket = attemptsByTask.get(binding.taskId) ?? [];
        bucket.push(binding);
        attemptsByTask.set(binding.taskId, bucket);
      }
      const nodeStates: HubPlanNodeState[] = [];
      for (const binding of bindings) {
        const task = taskById.get(ProjectTaskId.makeUnsafe(binding.taskId));
        if (!task) {
          return yield* fail("internal", `Bound native task '${binding.taskId}' is missing.`);
        }
        const attemptBinding = newestAttemptBinding(
          (attemptsByTask.get(task.id) ?? []).filter(
            (candidate) =>
              candidate.nodeKey === binding.nodeKey &&
              candidate.stageGeneration === record.stageGenerations[binding.stageKey],
          ),
        );
        const attempts = yield* native
          .listAttempts(task.id)
          .pipe(Effect.mapError((cause) => mapError(cause, "read node attempt binding")));
        const attempt = attemptBinding
          ? attempts.find((candidate) => candidate.id === attemptBinding.attemptId)
          : undefined;
        const graphFact = graphFacts.tasks.find((fact) => fact.nodeKey === binding.nodeKey);
        const retryState = graphFact?.currentAttempt;
        const waitingForUserInput = inputRequests.some(
          (request) =>
            request.nodeKey === binding.nodeKey &&
            request.generation === record.stageGenerations[binding.stageKey] &&
            request.status !== "stale" &&
            request.status !== "delivered" &&
            (request.status === "pending" || request.status === "answered") &&
            request.attemptId === attemptBinding?.attemptId,
        );
        const currentAttempt = Boolean(attempt && task.assignedThreadId === attempt.workerThreadId);
        const exactCurrentAttempt = Boolean(
          attempt &&
          attemptBinding &&
          currentAttempt &&
          attempt.projectId === record.hubId &&
          attempt.taskId === task.id &&
          attemptBinding.revision === record.revision &&
          attemptBinding.nodeKey === binding.nodeKey &&
          attemptBinding.taskId === task.id &&
          attemptBinding.attemptId === attempt.id &&
          attemptBinding.stageGeneration === record.stageGenerations[binding.stageKey] &&
          retryState?.attemptId === attempt.id &&
          retryState.generation === attemptBinding.stageGeneration,
        );
        const planNode = record.definition.nodes.find((node) => node.key === binding.nodeKey);
        const matchingCandidates = graphFacts.currentCandidates.filter(
          (candidate) =>
            candidate.status === "current" &&
            candidate.stageKey === binding.stageKey &&
            candidate.generation === record.stageGenerations[binding.stageKey],
        );
        const currentCandidate = matchingCandidates.length === 1 ? matchingCandidates[0] : null;
        const matchingReviews =
          exactCurrentAttempt && attempt && planNode?.role === "reviewer" && currentCandidate
            ? graphFacts.effectiveReviews.filter(
                (review) =>
                  review.status === "submitted" &&
                  review.reviewerNodeKey === binding.nodeKey &&
                  review.attemptId === attempt.id &&
                  review.stageKey === binding.stageKey &&
                  review.generation === record.stageGenerations[binding.stageKey] &&
                  review.candidateId === currentCandidate.candidateId &&
                  review.outputDigest === currentCandidate.outputDigest,
              )
            : [];
        const reviewOutcome =
          matchingReviews.length === 1 ? matchingReviews[0]?.outcome : undefined;
        let boundWork: HubWorkRecord | null = null;
        if (exactCurrentAttempt && attempt && attemptBinding) {
          boundWork = yield* native
            .readWork(attemptBinding.workItemId)
            .pipe(Effect.mapError((cause) => mapError(cause, "read current node work item")));
          if (boundWork?.workerThreadId !== attempt.workerThreadId) boundWork = null;
        }
        nodeStates.push({
          nodeKey: binding.nodeKey,
          taskId: task.id,
          taskStatus: task.status,
          workerThreadId:
            attempt && currentAttempt
              ? attempt.workerThreadId
              : attemptBinding
                ? null
                : task.assignedThreadId,
          attemptId: attemptBinding && attempt && currentAttempt ? attempt.id : null,
          ...(boundWork ? { workState: boundWork.state } : {}),
          ...(boundWork?.progress?.summary === undefined
            ? {}
            : { progressSummary: boundWork.progress.summary }),
          ...(boundWork?.queueReason == null ? {} : { queueReason: boundWork.queueReason }),
          ...(reviewOutcome === undefined ? {} : { reviewOutcome }),
          ...(attempt &&
          currentAttempt &&
          retryState?.attemptId === attempt.id &&
          graphFact?.retryable &&
          !waitingForUserInput
            ? { retryable: true }
            : {}),
        });
      }
      return nodeStates;
    });

  const readGraphFacts = (
    record: PlanRecord,
  ): Effect.Effect<HubPlanGraphFacts, HubPlanServiceError> =>
    Effect.gen(function* () {
      const emptyFacts: HubPlanGraphFacts = {
        controlState: record.controlState,
        stageGenerations: record.stageGenerations,
        tasks: [],
        currentCandidates: [],
        effectiveReviews: [],
        effectiveReleases: [],
      };
      if (record.goalId === null) return emptyFacts;

      const [
        nativeTasks,
        bindings,
        attemptBindings,
        inputRequests,
        storedInputRequests,
        candidateRecords,
        reviewRecords,
        releaseRecords,
      ] = yield* Effect.all(
        [
          native.readTasks(ProjectGoalId.makeUnsafe(record.goalId)),
          store.listBindings({ planId: record.id, revision: record.revision }),
          store.listAttemptBindings({ planId: record.id }),
          currentInputRequestRecords({ record, store, native }),
          store.listInputRequests({ planId: record.id }),
          store.listCandidates({ planId: record.id }),
          store.listReviews({ planId: record.id }),
          store.listReleases({ planId: record.id }),
        ],
        { concurrency: 1 },
      ).pipe(Effect.mapError((cause) => mapError(cause, "read plan graph facts")));

      const tasksById = new Map(
        nativeTasks
          .filter((task) => task.projectId === record.hubId && task.goalId === record.goalId)
          .map((task) => [task.id, task]),
      );
      const bindingByNode = new Map(bindings.map((binding) => [binding.nodeKey, binding]));
      const attemptBindingsByTask = new Map<string, HubPlanAttemptBinding[]>();
      for (const binding of attemptBindings) {
        const bucket = attemptBindingsByTask.get(binding.taskId) ?? [];
        bucket.push(binding);
        attemptBindingsByTask.set(binding.taskId, bucket);
      }

      const taskFacts: HubPlanTaskFact[] = [];
      for (const node of record.definition.nodes) {
        const binding = bindingByNode.get(node.key);
        if (!binding) continue;
        const task = tasksById.get(ProjectTaskId.makeUnsafe(binding.taskId));
        if (!task) {
          return yield* fail("internal", `Bound native task '${binding.taskId}' is missing.`);
        }
        const attempts = yield* native
          .listAttempts(task.id)
          .pipe(Effect.mapError((cause) => mapError(cause, "read current task attempt")));
        const attemptBinding = newestAttemptBinding(
          (attemptBindingsByTask.get(task.id) ?? []).filter(
            (candidate) =>
              candidate.nodeKey === node.key &&
              candidate.revision === record.revision &&
              candidate.stageGeneration === record.stageGenerations[node.stageKey],
          ),
        );
        if (!attemptBinding) {
          taskFacts.push({ nodeKey: node.key, taskStatus: taskStatus(task) });
          continue;
        }
        const attempt = attempts.find((candidate) => candidate.id === attemptBinding.attemptId);
        const work = yield* native
          .readWork(attemptBinding.workItemId)
          .pipe(Effect.mapError((cause) => mapError(cause, "read current work item")));
        if (!attempt && !work) {
          taskFacts.push({ nodeKey: node.key, taskStatus: taskStatus(task) });
          continue;
        }
        const workState = work ? work.state : workStateFromAttempt(attempt!, null);
        const managedWorker =
          (workState === "cancelled" ||
            workState === "completed" ||
            workState === "idle" ||
            workState === "failed") &&
          attempt
            ? yield* native
                .readManagedWorkerByThread(attempt.workerThreadId)
                .pipe(Effect.mapError((cause) => mapError(cause, "read settled managed worker")))
            : null;
        const retryable = Boolean(
          attempt &&
          work &&
          isRetryableHubPlanAttempt({
            planId: record.id,
            hubId: record.hubId,
            revision: record.revision,
            currentGeneration: record.stageGenerations[node.stageKey] ?? 0,
            node,
            binding: attemptBinding,
            task,
            attempt,
            workState,
            workSlotHeld: work?.slotHeld ?? true,
            workWorkerThreadId: work.workerThreadId,
            candidates: candidateRecords,
            reviews: reviewRecords,
            hasPendingInputRequest: storedInputRequests.some(
              (request) =>
                request.revision === record.revision &&
                request.nodeKey === node.key &&
                request.stageKey === node.stageKey &&
                request.generation === (record.stageGenerations[node.stageKey] ?? 0) &&
                request.attemptId === attempt.id &&
                (request.status === "pending" || request.status === "answered"),
            ),
            ...(managedWorker === null ? {} : { managedWorker }),
          }),
        );
        const waitingForUserInput = inputRequests.some(
          (request) =>
            request.nodeKey === node.key &&
            request.stageKey === node.stageKey &&
            request.generation === record.stageGenerations[node.stageKey] &&
            request.attemptId === attemptBinding.attemptId &&
            (request.status === "pending" || request.status === "answered"),
        );
        const acceptedAfterStop =
          attempt && workState === "cancelled"
            ? isAcceptedAfterStop({
                planId: record.id,
                hubId: record.hubId,
                revision: record.revision,
                nodeKey: node.key,
                stageKey: node.stageKey,
                role: node.role,
                currentGeneration: record.stageGenerations[node.stageKey] ?? 0,
                binding: attemptBinding,
                task,
                attempt,
                workState,
                workWorkerThreadId: work?.workerThreadId ?? null,
                candidates: candidateRecords,
                reviews: reviewRecords,
                ...(managedWorker === null ? {} : { managedWorker }),
              })
            : false;
        taskFacts.push({
          nodeKey: node.key,
          taskStatus: taskStatus(task),
          ...(retryable && !waitingForUserInput ? { retryable: true } : {}),
          ...(waitingForUserInput ? { waitingForUserInput: true } : {}),
          currentAttempt: {
            attemptId: attemptBinding.attemptId,
            generation: attemptBinding.stageGeneration,
            workState,
            ...(acceptedAfterStop ? { acceptedAfterStop: true } : {}),
          },
        });
      }

      const candidatesByStage = new Map<string, HubPlanCandidateRecord[]>();
      for (const candidate of candidateRecords) {
        if (candidate.revision !== record.revision) continue;
        const bucket = candidatesByStage.get(candidate.stageKey) ?? [];
        if (candidate.status === "current") bucket.push(candidate);
        candidatesByStage.set(candidate.stageKey, bucket);
      }
      const latestCandidateIdByStage = new Map<string, string>();
      for (const [stageKey, candidates] of candidatesByStage) {
        const latest = [...candidates].toSorted(
          (a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id),
        )[0];
        if (latest) latestCandidateIdByStage.set(stageKey, latest.id);
      }
      const currentCandidates = candidateRecords
        .filter((candidate) => candidate.revision === record.revision)
        .map((candidate) => ({
          stageKey: candidate.stageKey,
          generation: candidate.generation,
          candidateId: candidate.candidateId,
          outputDigest: candidate.outputDigest,
          authorNodeKey: candidate.authorNodeKey,
          authorAttemptId: candidate.authorAttemptId,
          summary: candidate.summary,
          status:
            candidate.status === "draft"
              ? ("draft" as const)
              : candidate.status === "superseded" ||
                  latestCandidateIdByStage.get(candidate.stageKey) !== candidate.id
                ? ("superseded" as const)
                : ("current" as const),
        }));

      return {
        controlState: record.controlState,
        stageGenerations: record.stageGenerations,
        tasks: taskFacts,
        currentCandidates,
        effectiveReviews: reviewRecords
          .filter((review) => review.revision === record.revision)
          .map(
            ({
              stageKey,
              generation,
              candidateId,
              outputDigest,
              reviewerNodeKey,
              attemptId,
              outcome,
              status,
            }) =>
              ({
                stageKey,
                generation,
                candidateId,
                outputDigest,
                reviewerNodeKey,
                attemptId,
                outcome,
                status,
              }) satisfies HubPlanReviewFact,
          ),
        effectiveReleases: releaseRecords
          .filter((release) => release.revision === record.revision)
          .map((release) => ({
            stageKey: release.stageKey,
            generation: release.generation,
            candidateId: release.candidateId,
            outputDigest: release.outputDigest,
            source: release.source,
            effective: release.effective,
          })),
      };
    });

  const findActiveAffectedNode = (
    record: PlanRecord,
    affectedStages: ReadonlySet<string>,
  ): Effect.Effect<string | null, HubPlanServiceError> =>
    Effect.gen(function* () {
      if (record.goalId === null) {
        return yield* fail("internal", "The active plan has no native goal.");
      }
      const [bindings, attemptBindings, nativeTasks] = yield* Effect.all(
        [
          store.listBindings({ planId: record.id, revision: record.revision }),
          store.listAttemptBindings({ planId: record.id }),
          native.readTasks(ProjectGoalId.makeUnsafe(record.goalId)),
        ],
        { concurrency: 1 },
      ).pipe(Effect.mapError((cause) => mapError(cause, "inspect work before stage return")));
      const taskById = new Map(
        nativeTasks
          .filter((task) => task.projectId === record.hubId && task.goalId === record.goalId)
          .map((task) => [task.id, task]),
      );
      for (const binding of bindings) {
        if (!affectedStages.has(binding.stageKey)) continue;
        const task = taskById.get(ProjectTaskId.makeUnsafe(binding.taskId));
        if (!task) {
          return yield* fail(
            "internal",
            `Bound task '${binding.taskId}' is missing while checking stage return.`,
          );
        }
        if (task.status === "running" || task.status === "review") return binding.nodeKey;
        const generation = record.stageGenerations[binding.stageKey];
        const currentGenerationBindings = attemptBindings.filter(
          (attemptBinding) =>
            attemptBinding.revision === record.revision &&
            attemptBinding.nodeKey === binding.nodeKey &&
            attemptBinding.taskId === binding.taskId &&
            attemptBinding.stageGeneration === generation,
        );
        for (const attemptBinding of currentGenerationBindings) {
          const work = yield* native
            .readWork(attemptBinding.workItemId)
            .pipe(Effect.mapError((cause) => mapError(cause, "inspect node work before return")));
          if (!work || isActiveWorkState(work.state)) return binding.nodeKey;
        }
      }
      return null;
    });

  const snapshotOf = (
    record: PlanRecord,
    sequence?: number,
  ): Effect.Effect<HubPlanSnapshot, HubPlanServiceError> =>
    Effect.gen(function* () {
      const [facts, eventSequence, candidates, inputRequests] = yield* Effect.all(
        [
          readGraphFacts(record),
          sequence === undefined
            ? latestSequence(ProjectId.makeUnsafe(record.hubId))
            : Effect.succeed(sequence),
          store.listCandidates({ planId: record.id }),
          currentInputRequestRecords({ record, store, native }),
        ],
        { concurrency: 1 },
      ).pipe(Effect.mapError((cause) => mapError(cause, "build plan snapshot")));
      const nodeStates = yield* readNodeStates(record, facts);
      const projectedGraph = computeHubStageViews(record.definition, facts);
      const graph = {
        ...projectedGraph,
        stages: projectedGraph.stages.map((stage) => {
          const candidate = candidates.find(
            (item) =>
              item.revision === record.revision &&
              item.stageKey === stage.stageKey &&
              item.generation === stage.generation &&
              item.candidateId === stage.candidateId &&
              item.status === "current",
          );
          return candidate
            ? { ...stage, deliverableRefs: immutableJsonCopy(candidate.deliverableRefs) }
            : stage;
        }),
      };
      return yield* decodeRequest(
        HubPlanSnapshotSchema,
        {
          id: record.id,
          hubId: record.hubId,
          goalId: record.goalId,
          revision: record.revision,
          stateVersion: record.stateVersion,
          controlState: record.controlState,
          definition: record.definition,
          createdAt: record.createdAt,
          updatedAt: record.updatedAt,
          graph,
          nodeStates,
          inputRequests,
          eventSequence,
        },
        "build plan snapshot",
      );
    });

  const appendSnapshotEvents = (
    record: PlanRecord,
    kinds: readonly string[],
    eventDetails: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {},
  ): Effect.Effect<void, HubPlanServiceError> =>
    Effect.gen(function* () {
      let cursor = yield* latestSequence(ProjectId.makeUnsafe(record.hubId));
      for (const kind of kinds) {
        const snapshot = yield* snapshotOf(record, cursor);
        const event: Omit<HubPlanStoredEvent, "sequence"> = {
          planId: record.id,
          hubId: record.hubId,
          kind,
          payload: {
            snapshot: immutableJsonCopy(snapshot),
            ...eventDetails[kind],
          },
          createdAt: now(),
        };
        const appended = yield* store
          .appendEvent(event)
          .pipe(Effect.mapError((cause) => mapError(cause, "append plan event")));
        cursor = appended.sequence;
      }
    });

  const enqueue = (
    record: PlanRecord,
    kind: "plan.schedule" | "plan.stop",
    retry?: {
      readonly nodeKey: string;
      readonly stageKey: string;
      readonly generation: number;
      readonly attemptId: string;
    },
  ) =>
    store
      .enqueue({
        id: randomUUID(),
        planId: record.id,
        kind,
        payload: {
          revision: record.revision,
          stateVersion: record.stateVersion,
          ...(retry ? { retry } : {}),
        },
        createdAt: now(),
      })
      .pipe(Effect.mapError((cause) => mapError(cause, "enqueue plan work")));

  const enqueueInputResponse = (record: PlanRecord, request: HubPlanInputRequestRecord) =>
    store
      .enqueue({
        id: `plan-input-response:${createHash("sha256")
          .update(`${record.id}\n${request.id}`)
          .digest("hex")
          .slice(0, 48)}`,
        planId: record.id,
        kind: "plan.input-response",
        payload: {
          revision: request.revision,
          stateVersion: record.stateVersion,
          inputRequestId: request.id,
        },
        createdAt: request.updatedAt,
      })
      .pipe(Effect.mapError((cause) => mapError(cause, "enqueue plan input response")));

  const list = (rawInput: { readonly hubId: ProjectId }, principal: HubPlanPrincipal) =>
    Effect.gen(function* () {
      const input = yield* decodeRequest(HubPlanListInputSchema, rawInput, "list plans");
      yield* assertHubPrincipal(principal, input.hubId);
      const records = yield* store
        .list({ hubId: input.hubId })
        .pipe(Effect.mapError((cause) => mapError(cause, "list plans")));
      const snapshots: HubPlanSnapshot[] = [];
      for (const record of records) snapshots.push(yield* snapshotOf(record));
      return snapshots;
    }).pipe(Effect.mapError((cause) => mapError(cause, "list plans")));

  const read = (
    rawInput: { readonly hubId: ProjectId; readonly planId: string },
    principal: HubPlanPrincipal,
  ) =>
    Effect.gen(function* () {
      const input = yield* decodeRequest(HubPlanReadInputSchema, rawInput, "read plan");
      yield* assertHubPrincipal(principal, input.hubId);
      const record = yield* store
        .read({ planId: input.planId })
        .pipe(Effect.mapError((cause) => mapError(cause, "read plan")));
      if (!record || record.hubId !== input.hubId) return null;
      return yield* snapshotOf(record);
    }).pipe(Effect.mapError((cause) => mapError(cause, "read plan")));

  const events = (
    rawInput: { readonly hubId: ProjectId; readonly afterSequence: number },
    principal: HubPlanPrincipal,
  ) =>
    Effect.gen(function* () {
      const input = yield* decodeRequest(HubPlanEventsInputSchema, rawInput, "read plan events");
      yield* assertHubPrincipal(principal, input.hubId);
      const stored = yield* store
        .readEvents({ hubId: input.hubId, afterSequence: input.afterSequence })
        .pipe(Effect.mapError((cause) => mapError(cause, "read plan events")));
      return yield* decodeRequest(Schema.Array(HubPlanEventSchema), stored, "read plan events");
    }).pipe(Effect.mapError((cause) => mapError(cause, "read plan events")));

  const propose = (rawInput: HubPlanProposeInput, principal: HubPlanPrincipal) =>
    Effect.gen(function* () {
      const input = yield* decodeRequest(HubPlanProposeInputSchema, rawInput, "propose plan");
      yield* assertHubPrincipal(principal, input.hubId);
      if (principal.kind !== "user" && principal.kind !== "coordinator") {
        return yield* fail("forbidden", "Only a user or Hub coordinator may propose a plan.");
      }
      const digest = commandDigest({ action: "propose", input, principal });
      const replay = yield* readReceipt(input.hubId, input.requestId, digest);
      if (replay) return replay;
      const validationIssues = validateHubPlanDefinition(input.definition);
      if (validationIssues.length > 0) {
        return yield* fail(
          "invalid_plan",
          validationIssues
            .map(({ code, path, message }) => `${code} at ${path}: ${message}`)
            .join("\n"),
        );
      }
      if (new Set(input.sourceMessageIds).size !== input.sourceMessageIds.length) {
        return yield* fail("invalid_request", "Source message IDs must be unique.");
      }
      const sourceMessages = yield* native
        .readSourceMessages(input.hubId, input.sourceMessageIds)
        .pipe(Effect.mapError((cause) => mapError(cause, "read proposal source messages")));
      if (!validateSourceMessages(input.sourceMessageIds, sourceMessages)) {
        return yield* fail(
          "invalid_request",
          "Every source ID must resolve to its authorized human message.",
        );
      }
      const config = yield* native
        .readConfig(input.hubId)
        .pipe(Effect.mapError((cause) => mapError(cause, "read proposal config")));
      const configIssues = definitionConfigIssues(input.definition, config);
      if (configIssues.length > 0) {
        return yield* fail("invalid_plan", configIssues.join("\n"));
      }

      const saved = yield* store
        .transaction(
          Effect.gen(function* () {
            const inTransactionReplay = yield* readReceipt(input.hubId, input.requestId, digest);
            if (inTransactionReplay) return inTransactionReplay;
            const existing = yield* store
              .read({ planId: input.planId })
              .pipe(Effect.mapError((cause) => mapError(cause, "read proposal plan")));
            const timestamp = now();
            let draft: PlanRecord;
            if (input.expectedStateVersion === null) {
              if (existing !== null) {
                return yield* fail("conflict", "A plan with this ID already exists.");
              }
              draft = {
                id: input.planId,
                hubId: input.hubId,
                goalId: null,
                revision: 1,
                stateVersion: 1,
                controlState: "draft",
                definition: input.definition,
                configSnapshot: planConfigSnapshot(config),
                stageGenerations: Object.fromEntries(
                  input.definition.stages.map((stage) => [stage.key, 0]),
                ),
                sourceMessageIds: [...input.sourceMessageIds],
                createdAt: timestamp,
                updatedAt: timestamp,
              };
            } else {
              if (!existing || existing.hubId !== input.hubId) {
                return yield* fail("not_found", "The plan draft does not exist.");
              }
              if (existing.controlState !== "draft") {
                return yield* fail("invalid_state", "Only a draft plan may be edited.");
              }
              if (existing.stateVersion !== input.expectedStateVersion) {
                return yield* fail("conflict", "The plan draft changed; reload before editing.");
              }
              draft = {
                ...existing,
                revision: existing.revision + 1,
                stateVersion: existing.stateVersion + 1,
                definition: input.definition,
                configSnapshot: planConfigSnapshot(config),
                stageGenerations: Object.fromEntries(
                  input.definition.stages.map((stage) => [stage.key, 0]),
                ),
                sourceMessageIds: [...input.sourceMessageIds],
                updatedAt: timestamp,
              };
            }
            const persisted = yield* store
              .savePlan(draft, input.expectedStateVersion)
              .pipe(Effect.mapError((cause) => mapError(cause, "save proposal draft")));
            yield* appendSnapshotEvents(persisted, ["plan.proposed"]);
            const snapshot = yield* snapshotOf(persisted);
            yield* writeReceipt({
              hubId: input.hubId,
              requestId: input.requestId,
              digest,
              snapshot,
            });
            return snapshot;
          }),
        )
        .pipe(Effect.mapError((cause) => mapError(cause, "propose plan")));
      return saved;
    }).pipe(Effect.mapError((cause) => mapError(cause, "propose plan")));

  const command = (rawInput: HubPlanCommandInput, principal: HubPlanPrincipal) =>
    Effect.gen(function* () {
      const input = yield* decodeRequest(HubPlanCommandInputSchema, rawInput, "run plan command");
      yield* assertHubPrincipal(principal, input.hubId);
      const isUserOnly = [
        "confirm",
        "pause",
        "resume",
        "cancel",
        "release",
        "return",
        "retry",
        "respondInput",
      ].includes(input.action);
      if (isUserOnly && principal.kind !== "user") {
        return yield* fail("forbidden", `Only the user may run ${input.action}.`);
      }
      if (
        (input.action === "submitCandidate" ||
          input.action === "submitReview" ||
          input.action === "requestInput") &&
        principal.kind !== "worker"
      ) {
        return yield* fail(
          "forbidden",
          "Only the current assigned Worker may submit a candidate or review.",
        );
      }
      const digest = commandDigest({ action: "command", input, principal });
      const replay = yield* readReceipt(input.hubId, input.requestId, digest);
      if (replay) return replay;

      let confirmPreparation: {
        readonly config: ProjectAgentConfig;
        readonly expertSnapshots: readonly {
          readonly expertId: string;
          readonly snapshotId: string;
          readonly revision: number;
        }[];
      } | null = null;
      if (input.action === "confirm") {
        const draft = yield* store
          .read({ planId: input.planId })
          .pipe(Effect.mapError((cause) => mapError(cause, "read plan before confirmation")));
        if (!draft || draft.hubId !== input.hubId)
          return yield* fail("not_found", "Plan was not found.");
        if (draft.controlState !== "draft")
          return yield* fail("invalid_state", "Only a draft plan can be confirmed.");
        if (
          draft.revision !== input.expectedRevision ||
          draft.stateVersion !== input.expectedStateVersion
        ) {
          return yield* fail("conflict", "The plan changed; reload before confirming.");
        }
        const config = yield* native
          .readConfig(input.hubId)
          .pipe(Effect.mapError((cause) => mapError(cause, "read confirmation config")));
        if (config.revision !== draft.configSnapshot.configRevision) {
          return yield* fail("conflict", "Hub configuration changed after this plan was proposed.");
        }
        if (!sameStrings(config.expertIds ?? [], draft.configSnapshot.expertIds)) {
          return yield* fail("conflict", "Hub Expert roster changed after this plan was proposed.");
        }
        const configIssues = definitionConfigIssues(draft.definition, config);
        if (configIssues.length > 0) return yield* fail("invalid_plan", configIssues.join("\n"));
        const expertIds = sortedUniqueStrings(config.expertIds ?? []);
        const expertSnapshots = yield* native
          .freezeExperts(expertIds)
          .pipe(Effect.mapError((cause) => mapError(cause, "freeze Hub Expert roster")));
        if (
          expertSnapshots.length !== expertIds.length ||
          !sameStrings(
            expertSnapshots.map((snapshot) => snapshot.expertId),
            expertIds,
          )
        ) {
          return yield* fail("conflict", "Expert roster could not be frozen consistently.");
        }
        confirmPreparation = { config, expertSnapshots };
      }

      return yield* store
        .transaction(
          Effect.gen(function* () {
            const inTransactionReplay = yield* readReceipt(input.hubId, input.requestId, digest);
            if (inTransactionReplay) return inTransactionReplay;
            const current = yield* store
              .read({ planId: input.planId })
              .pipe(Effect.mapError((cause) => mapError(cause, "read plan command target")));
            if (!current || current.hubId !== input.hubId)
              return yield* fail("not_found", "Plan was not found.");
            if (
              current.revision !== input.expectedRevision ||
              current.stateVersion !== input.expectedStateVersion
            ) {
              return yield* fail(
                "conflict",
                "The plan changed; reload before applying this command.",
              );
            }
            const timestamp = now();
            let updated: PlanRecord = {
              ...current,
              stateVersion: current.stateVersion + 1,
              updatedAt: timestamp,
            };
            const eventKinds: string[] = [
              input.action === "confirm"
                ? "plan.confirmed"
                : input.action === "pause"
                  ? "plan.pausing"
                  : input.action === "resume"
                    ? "plan.resumed"
                    : input.action === "cancel"
                      ? current.controlState === "draft"
                        ? "plan.cancelled"
                        : "plan.cancelling"
                      : input.action === "submitCandidate"
                        ? "plan.candidate-submitted"
                        : input.action === "submitReview"
                          ? "plan.review-submitted"
                          : input.action === "release"
                            ? "plan.released"
                            : input.action === "retry"
                              ? "plan.retried"
                              : input.action === "requestInput"
                                ? "plan.input-requested"
                                : input.action === "respondInput"
                                  ? "plan.input-responded"
                                  : "plan.returned",
            ];
            const eventDetails: Record<string, Readonly<Record<string, unknown>>> = {};
            let schedule = false;
            let stop = false;
            let retrySchedule:
              | {
                  readonly nodeKey: string;
                  readonly stageKey: string;
                  readonly generation: number;
                  readonly attemptId: string;
                }
              | undefined;

            if (input.action === "confirm") {
              if (current.controlState !== "draft" || !confirmPreparation) {
                return yield* fail("invalid_state", "The plan is no longer a confirmable draft.");
              }
              const configNow = yield* native
                .readConfig(input.hubId)
                .pipe(Effect.mapError((cause) => mapError(cause, "recheck confirmation config")));
              if (configNow.revision !== confirmPreparation.config.revision) {
                return yield* fail("conflict", "Hub configuration changed during confirmation.");
              }
              const configIssues = definitionConfigIssues(current.definition, configNow);
              if (configIssues.length > 0)
                return yield* fail("invalid_plan", configIssues.join("\n"));
              const activeGoal = yield* native
                .getActiveGoal(input.hubId)
                .pipe(Effect.mapError((cause) => mapError(cause, "check active Hub goal")));
              if (
                activeGoal !== null &&
                activeGoal.status !== "completed" &&
                activeGoal.status !== "cancelled" &&
                activeGoal.status !== "stopped"
              ) {
                return yield* fail("conflict", "This Hub already has an active or paused goal.");
              }
              const createdAt = now();
              const goalId = ProjectGoalId.makeUnsafe(`goal-${randomUUID()}`);
              const goal: ProjectGoal = {
                id: goalId,
                projectId: input.hubId,
                objective: current.definition.objective,
                authorizationSource: "user",
                scopeVersion: current.revision,
                acceptanceCriteria: current.definition.scope,
                limits: confirmPreparation.config.limits,
                status: "active",
                continuationCount: 0,
                workerCreationCount: 0,
                authorizedAt: createdAt,
                revision: 1,
                createdAt,
                updatedAt: createdAt,
              };
              yield* native
                .saveGoal(goal, null)
                .pipe(Effect.mapError((cause) => mapError(cause, "create plan goal")));
              const taskIdByNode = new Map(
                current.definition.nodes.map((node) => [
                  node.key,
                  ProjectTaskId.makeUnsafe(`task-${randomUUID()}`),
                ]),
              );
              const nodeByKey = new Map(current.definition.nodes.map((node) => [node.key, node]));
              const taskByNode = new Map<string, ProjectTask>();
              for (const node of topologicalNodeOrder(current.definition)) {
                const taskId = taskIdByNode.get(node.key);
                if (!taskId)
                  return yield* fail("internal", `Missing task ID for node '${node.key}'.`);
                const dependencies = node.dependsOnNodeKeys.flatMap((key) => {
                  const id = taskIdByNode.get(key);
                  return id ? [id] : [];
                });
                const details = [
                  node.brief,
                  `Hub plan node: ${node.key}`,
                  `Role: ${node.role}`,
                  `Work mode: ${node.workMode}`,
                  ...(node.expertId ? [`Expert: ${node.expertId}`] : []),
                  ...(node.target ? [`Model target: ${canonicalJson(node.target)}`] : []),
                ].join("\n\n");
                const task: ProjectTask = {
                  id: taskId,
                  projectId: input.hubId,
                  goalId,
                  title: node.title,
                  description: details,
                  acceptanceCriteria: node.acceptanceCriteria,
                  status: dependencies.length === 0 ? "ready" : "planned",
                  dependsOnTaskIds: dependencies,
                  assignedThreadId: null,
                  repairCount: 0,
                  archivedAt: null,
                  revision: 1,
                  createdAt,
                  updatedAt: createdAt,
                };
                const savedTask = yield* native
                  .saveTask(task, null)
                  .pipe(Effect.mapError((cause) => mapError(cause, "create plan task")));
                taskByNode.set(node.key, savedTask);
              }
              const bindings: HubPlanNodeBinding[] = current.definition.nodes.map((node) => {
                const task = taskByNode.get(node.key);
                if (!task || !nodeByKey.has(node.key))
                  throw new Error(`Missing task binding for '${node.key}'.`);
                return {
                  planId: current.id,
                  revision: current.revision,
                  nodeKey: node.key,
                  taskId: task.id,
                  stageKey: node.stageKey,
                  role: node.role,
                };
              });
              updated = {
                ...updated,
                goalId,
                controlState: "active",
                configSnapshot: {
                  ...planConfigSnapshot(confirmPreparation.config),
                  expertSnapshots: confirmPreparation.expertSnapshots,
                },
                stageGenerations: Object.fromEntries(
                  current.definition.stages.map((stage) => [stage.key, 1]),
                ),
              };
              updated = yield* store
                .savePlan(updated, current.stateVersion)
                .pipe(
                  Effect.mapError((cause) => mapError(cause, "activate plan before binding tasks")),
                );
              yield* store
                .saveBindings(bindings)
                .pipe(Effect.mapError((cause) => mapError(cause, "bind plan tasks")));
              schedule = true;
            } else if (input.action === "pause") {
              if (current.controlState !== "active" || current.goalId === null) {
                return yield* fail("invalid_state", "Only an active plan can be paused.");
              }
              const goal = yield* native
                .getGoal(ProjectGoalId.makeUnsafe(current.goalId))
                .pipe(Effect.mapError((cause) => mapError(cause, "read goal before pause")));
              if (!goal || goal.projectId !== current.hubId || goal.id !== current.goalId) {
                return yield* fail("internal", "The plan's native goal is missing.");
              }
              yield* native
                .saveGoal(
                  { ...goal, status: "paused", revision: goal.revision + 1, updatedAt: timestamp },
                  goal.revision,
                )
                .pipe(Effect.mapError((cause) => mapError(cause, "pause native goal")));
              updated = { ...updated, controlState: "pausing" };
              stop = true;
            } else if (input.action === "resume") {
              if (current.controlState !== "paused" || current.goalId === null) {
                return yield* fail("invalid_state", "Only a paused plan can be resumed.");
              }
              const goal = yield* native
                .getGoal(ProjectGoalId.makeUnsafe(current.goalId))
                .pipe(Effect.mapError((cause) => mapError(cause, "read goal before resume")));
              if (!goal || goal.projectId !== current.hubId || goal.status !== "paused") {
                return yield* fail("invalid_state", "The native goal is not paused.");
              }
              yield* native
                .saveGoal(
                  { ...goal, status: "active", revision: goal.revision + 1, updatedAt: timestamp },
                  goal.revision,
                )
                .pipe(Effect.mapError((cause) => mapError(cause, "resume native goal")));
              updated = { ...updated, controlState: "active" };
              schedule = true;
            } else if (input.action === "cancel") {
              if (current.controlState === "draft") {
                updated = { ...updated, controlState: "cancelled" };
              } else {
                if (
                  current.controlState !== "active" &&
                  current.controlState !== "paused" &&
                  current.controlState !== "pausing"
                ) {
                  return yield* fail(
                    "invalid_state",
                    "Only an active or paused plan can be cancelled.",
                  );
                }
                if (current.goalId === null)
                  return yield* fail("internal", "The active plan has no native goal.");
                const goal = yield* native
                  .getGoal(ProjectGoalId.makeUnsafe(current.goalId))
                  .pipe(
                    Effect.mapError((cause) => mapError(cause, "read goal before cancellation")),
                  );
                if (!goal || goal.projectId !== current.hubId)
                  return yield* fail("internal", "The plan's native goal is missing.");
                if (
                  goal.status !== "stopped" &&
                  goal.status !== "completed" &&
                  goal.status !== "cancelled"
                ) {
                  yield* native
                    .saveGoal(
                      {
                        ...goal,
                        status: "stopped",
                        revision: goal.revision + 1,
                        updatedAt: timestamp,
                      },
                      goal.revision,
                    )
                    .pipe(Effect.mapError((cause) => mapError(cause, "stop native goal")));
                }
                updated = { ...updated, controlState: "cancelling" };
                stop = true;
              }
            } else if (input.action === "retry") {
              if (current.controlState !== "active" || current.goalId === null) {
                return yield* fail("invalid_state", "Only an active plan can retry a node.");
              }
              const node = current.definition.nodes.find(
                (candidate) => candidate.key === input.nodeKey,
              );
              if (!node || node.stageKey !== input.stageKey) {
                return yield* fail("invalid_request", "Retry node does not belong to the stage.");
              }
              if (input.generation !== current.stageGenerations[input.stageKey]) {
                return yield* fail("stale_candidate", "Retry belongs to an old stage generation.");
              }
              const [nodeBindings, attemptBindings, candidates, reviews] = yield* Effect.all(
                [
                  store.listBindings({ planId: current.id, revision: current.revision }),
                  store.listAttemptBindings({ planId: current.id }),
                  store.listCandidates({ planId: current.id }),
                  store.listReviews({ planId: current.id }),
                ],
                { concurrency: 1 },
              ).pipe(Effect.mapError((cause) => mapError(cause, "read retry node evidence")));
              const nodeBinding = nodeBindings.find((candidate) => candidate.nodeKey === node.key);
              if (
                !nodeBinding ||
                nodeBinding.stageKey !== node.stageKey ||
                nodeBinding.role !== node.role
              ) {
                return yield* fail("internal", "Retry node binding does not match the plan.");
              }
              const task = yield* native
                .getTask(ProjectTaskId.makeUnsafe(nodeBinding.taskId))
                .pipe(Effect.mapError((cause) => mapError(cause, "read retry node task")));
              if (
                !task ||
                task.id !== nodeBinding.taskId ||
                task.projectId !== current.hubId ||
                task.goalId !== current.goalId
              ) {
                return yield* fail("internal", "Retry node task is missing or outside the plan.");
              }
              const attemptBinding = newestAttemptBinding(
                attemptBindings.filter(
                  (candidate) =>
                    candidate.revision === current.revision &&
                    candidate.nodeKey === node.key &&
                    candidate.taskId === task.id &&
                    candidate.stageGeneration === input.generation,
                ),
              );
              if (!attemptBinding || attemptBinding.attemptId !== input.attemptId) {
                return yield* fail(
                  "stale_candidate",
                  "Retry attempt is no longer the latest binding for this node generation.",
                );
              }
              const attempts = yield* native
                .listAttempts(task.id)
                .pipe(Effect.mapError((cause) => mapError(cause, "read retry node attempt")));
              const attempt = attempts.find(
                (candidate) => candidate.id === attemptBinding.attemptId,
              );
              if (!attempt) {
                return yield* fail(
                  "stale_candidate",
                  "Retry attempt is missing from native history.",
                );
              }
              const work = yield* native
                .readWork(attemptBinding.workItemId)
                .pipe(Effect.mapError((cause) => mapError(cause, "read retry node work")));
              if (!work) return yield* fail("stale_candidate", "Retry Work record is missing.");
              const managedWorker = yield* native
                .readManagedWorkerByThread(attempt.workerThreadId)
                .pipe(Effect.mapError((cause) => mapError(cause, "read retry worker settlement")));
              const inputRequests = yield* store
                .listInputRequests({ planId: current.id })
                .pipe(Effect.mapError((cause) => mapError(cause, "read retry input requests")));
              const retryable = isRetryableHubPlanAttempt({
                planId: current.id,
                hubId: current.hubId,
                revision: current.revision,
                currentGeneration: current.stageGenerations[node.stageKey] ?? 0,
                node,
                binding: attemptBinding,
                task,
                attempt,
                workState: work.state,
                workSlotHeld: work.slotHeld,
                workWorkerThreadId: work.workerThreadId,
                candidates,
                reviews,
                hasPendingInputRequest: inputRequests.some(
                  (request) =>
                    request.revision === current.revision &&
                    request.nodeKey === node.key &&
                    request.stageKey === node.stageKey &&
                    request.generation === input.generation &&
                    request.attemptId === attempt.id &&
                    (request.status === "pending" || request.status === "answered"),
                ),
                ...(managedWorker === null ? {} : { managedWorker }),
              });
              if (!retryable) {
                return yield* fail(
                  "invalid_state",
                  "Retry requires the latest settled Work with a released slot, no pending input, no accepted node evidence, and an unfinished assigned task.",
                );
              }
              if (attempt.outcome === "running") {
                yield* native
                  .saveAttempt({
                    ...attempt,
                    outcome: "failed",
                    error:
                      work.state === "failed"
                        ? (attempt.error ?? work.progress?.summary ?? "Native Work failed.")
                        : "Provider turn settled without an accepted node result; retried by owner.",
                    finishedAt: timestamp,
                  })
                  .pipe(
                    Effect.mapError((cause) => mapError(cause, "finish missing-result attempt")),
                  );
              }
              yield* native
                .saveTask(
                  {
                    ...task,
                    status: "ready",
                    assignedThreadId: null,
                    revision: task.revision + 1,
                    updatedAt: timestamp,
                  },
                  task.revision,
                )
                .pipe(Effect.mapError((cause) => mapError(cause, "reset node task for retry")));
              retrySchedule = {
                nodeKey: node.key,
                stageKey: node.stageKey,
                generation: input.generation,
                attemptId: input.attemptId,
              };
              eventDetails["plan.retried"] = {
                summary: `Explicit retry of node '${node.key}' in stage '${node.stageKey}', generation ${input.generation}, after attempt ${input.attemptId}.`,
              };
              schedule = true;
            } else if (input.action === "submitCandidate") {
              if (current.controlState !== "active" || current.goalId === null) {
                return yield* fail(
                  "invalid_state",
                  "Candidate submission requires an active plan.",
                );
              }
              const node = current.definition.nodes.find(
                (candidate) => candidate.key === input.nodeKey,
              );
              if (!node || node.stageKey !== input.stageKey || node.role !== "author") {
                return yield* fail(
                  "invalid_request",
                  "Candidate node must be the author for the requested stage.",
                );
              }
              if (input.generation !== current.stageGenerations[input.stageKey]) {
                return yield* fail(
                  "stale_candidate",
                  "Candidate belongs to an old stage generation.",
                );
              }
              const bindings = yield* store
                .listBindings({ planId: current.id, revision: current.revision })
                .pipe(Effect.mapError((cause) => mapError(cause, "read candidate node binding")));
              const binding = bindings.find((candidate) => candidate.nodeKey === node.key);
              if (!binding) return yield* fail("internal", "Author task binding is missing.");
              const task = yield* native
                .getTask(ProjectTaskId.makeUnsafe(binding.taskId))
                .pipe(Effect.mapError((cause) => mapError(cause, "read author task")));
              if (!task || task.projectId !== current.hubId || task.goalId !== current.goalId) {
                return yield* fail(
                  "internal",
                  "Author task is missing or belongs to another goal.",
                );
              }
              const attempts = yield* native
                .listAttempts(task.id)
                .pipe(Effect.mapError((cause) => mapError(cause, "read author attempts")));
              const attempt = newestAttempt(attempts);
              const attemptBinding = (yield* store
                .listAttemptBindings({ planId: current.id })
                .pipe(
                  Effect.mapError((cause) => mapError(cause, "read author attempt binding")),
                )).find(
                (candidate) =>
                  candidate.revision === current.revision &&
                  candidate.nodeKey === node.key &&
                  candidate.taskId === task.id &&
                  candidate.attemptId === input.attemptId &&
                  candidate.stageGeneration === input.generation,
              );
              if (!attemptBinding || !attempt || attempt.id !== input.attemptId) {
                return yield* fail(
                  "stale_candidate",
                  "Candidate attempt is not the current bound attempt.",
                );
              }
              const work = yield* native
                .readWork(attemptBinding.workItemId)
                .pipe(Effect.mapError((cause) => mapError(cause, "read author work item")));
              const completedOwner = isCurrentTaskAttempt(
                attempt,
                input.attemptId,
                work,
                task,
                principal,
              );
              const activeOwner = isCurrentRunningTaskAttempt(
                attempt,
                input.attemptId,
                work,
                task,
                principal,
              );
              const finalizedPendingOwner = isFinalizedPendingWorkAttempt(
                attempt,
                input.attemptId,
                work,
                task,
                principal,
              );
              if (!completedOwner && !activeOwner && !finalizedPendingOwner) {
                return yield* fail(
                  "forbidden",
                  "Candidate submitter does not own the current running or completed author attempt.",
                );
              }
              if (
                input.deliverableRefs.some(
                  (reference) =>
                    reference.hubId !== current.hubId ||
                    reference.workerThreadId !== attempt.workerThreadId,
                )
              ) {
                return yield* fail(
                  "invalid_request",
                  "Deliverable references must belong to this Hub and author thread.",
                );
              }
              yield* native
                .validateDeliverables(
                  ProjectId.makeUnsafe(current.hubId),
                  input.deliverableRefs,
                  attempt.workerThreadId,
                )
                .pipe(
                  Effect.mapError((cause) => mapError(cause, "validate candidate deliverables")),
                );
              const digest = digestDeliverables(input.deliverableRefs);
              if (!validateDigestForRefs(input.deliverableRefs, digest)) {
                return yield* fail(
                  "invalid_request",
                  "Candidate deliverables do not produce a stable digest.",
                );
              }
              const candidateContent: CandidateWithDeliverables = {
                planId: current.id,
                id: "candidate-content-comparison",
                revision: current.revision,
                stageKey: input.stageKey,
                generation: input.generation,
                candidateId: "candidate-content-comparison",
                outputDigest: digest,
                authorNodeKey: node.key,
                authorAttemptId: attempt.id,
                summary: input.summary,
                status: "current",
                createdAt: timestamp,
                deliverableRefs: input.deliverableRefs,
              };
              const existingGenerationCandidate = (yield* store
                .listCandidates({ planId: current.id })
                .pipe(
                  Effect.mapError((cause) => mapError(cause, "check current-generation candidate")),
                )).find(
                (item) =>
                  item.revision === current.revision &&
                  item.stageKey === input.stageKey &&
                  item.generation === input.generation,
              );
              if (existingGenerationCandidate) {
                if (!sameCandidateSubmission(existingGenerationCandidate, candidateContent)) {
                  return yield* fail(
                    "conflict",
                    "This stage generation already has a different candidate; return it before submitting new content.",
                  );
                }
                const snapshot = yield* snapshotOf(current);
                yield* writeReceipt({
                  hubId: input.hubId,
                  requestId: input.requestId,
                  digest,
                  snapshot,
                });
                return snapshot;
              }
              const candidateId = `candidate-${randomUUID()}`;
              const candidate: CandidateWithDeliverables = {
                planId: current.id,
                id: candidateId,
                revision: current.revision,
                stageKey: input.stageKey,
                generation: input.generation,
                candidateId,
                outputDigest: digest,
                authorNodeKey: node.key,
                authorAttemptId: attempt.id,
                summary: input.summary,
                status: "current",
                createdAt: timestamp,
                deliverableRefs: input.deliverableRefs,
              };
              const storedCandidate = yield* store
                .appendCandidate(candidate)
                .pipe(Effect.mapError((cause) => mapError(cause, "store candidate")));
              if (storedCandidate.id !== candidate.id) {
                if (!sameCandidateSubmission(storedCandidate, candidate)) {
                  return yield* fail(
                    "conflict",
                    "This stage generation already has a different candidate; return it before submitting new content.",
                  );
                }
                const snapshot = yield* snapshotOf(current);
                yield* writeReceipt({
                  hubId: input.hubId,
                  requestId: input.requestId,
                  digest,
                  snapshot,
                });
                return snapshot;
              }
              if (activeOwner) {
                yield* native
                  .finalizePlanNode({
                    hubId: ProjectId.makeUnsafe(current.hubId),
                    planId: current.id,
                    revision: current.revision,
                    nodeKey: node.key,
                    taskId: task.id,
                    attemptId: attempt.id,
                    workItemId: attemptBinding.workItemId,
                    workerThreadId: attempt.workerThreadId,
                    requestId: input.requestId,
                    outcome: "candidate",
                    summary: input.summary,
                    submittedAt: timestamp,
                  })
                  .pipe(
                    Effect.mapError((cause) => mapError(cause, "finalize candidate author task")),
                  );
              }
              schedule = true;
            } else if (input.action === "submitReview") {
              if (current.controlState !== "active" || current.goalId === null) {
                return yield* fail("invalid_state", "Review submission requires an active plan.");
              }
              const node = current.definition.nodes.find(
                (candidate) => candidate.key === input.nodeKey,
              );
              if (!node || node.stageKey !== input.stageKey || node.role !== "reviewer") {
                return yield* fail(
                  "invalid_request",
                  "Review node must be a reviewer for the requested stage.",
                );
              }
              if (input.generation !== current.stageGenerations[input.stageKey]) {
                return yield* fail("stale_candidate", "Review belongs to an old stage generation.");
              }
              const candidates = yield* store
                .listCandidates({ planId: current.id })
                .pipe(Effect.mapError((cause) => mapError(cause, "read review candidate")));
              const currentStageView = stageView(yield* snapshotOf(current), input.stageKey);
              if (
                currentStageView?.generation !== input.generation ||
                currentStageView.candidateId !== input.candidateId ||
                currentStageView.outputDigest !== input.outputDigest
              ) {
                return yield* fail(
                  "stale_candidate",
                  "Review must target the current stage candidate.",
                );
              }
              const candidate = candidates.find(
                (item) =>
                  item.candidateId === input.candidateId &&
                  item.stageKey === input.stageKey &&
                  item.generation === input.generation &&
                  item.status === "current",
              );
              if (!candidate || candidate.outputDigest !== input.outputDigest) {
                return yield* fail(
                  "stale_candidate",
                  "Review must match the current candidate and output digest.",
                );
              }
              const bindings = yield* store
                .listBindings({ planId: current.id, revision: current.revision })
                .pipe(Effect.mapError((cause) => mapError(cause, "read reviewer task binding")));
              const binding = bindings.find((item) => item.nodeKey === node.key);
              if (!binding) return yield* fail("internal", "Reviewer task binding is missing.");
              const task = yield* native
                .getTask(ProjectTaskId.makeUnsafe(binding.taskId))
                .pipe(Effect.mapError((cause) => mapError(cause, "read reviewer task")));
              if (!task || task.projectId !== current.hubId || task.goalId !== current.goalId) {
                return yield* fail(
                  "internal",
                  "Reviewer task is missing or belongs to another goal.",
                );
              }
              const attempts = yield* native
                .listAttempts(task.id)
                .pipe(Effect.mapError((cause) => mapError(cause, "read reviewer attempts")));
              const attempt = newestAttempt(attempts);
              const attemptBinding = (yield* store
                .listAttemptBindings({ planId: current.id })
                .pipe(
                  Effect.mapError((cause) => mapError(cause, "read reviewer attempt binding")),
                )).find(
                (item) =>
                  item.revision === current.revision &&
                  item.nodeKey === node.key &&
                  item.taskId === task.id &&
                  item.attemptId === input.attemptId &&
                  item.stageGeneration === input.generation,
              );
              if (!attemptBinding || !attempt || attempt.id !== input.attemptId) {
                return yield* fail(
                  "stale_candidate",
                  "Review attempt is not the current bound attempt.",
                );
              }
              const work = yield* native
                .readWork(attemptBinding.workItemId)
                .pipe(Effect.mapError((cause) => mapError(cause, "read reviewer work item")));
              const completedOwner = isCurrentTaskAttempt(
                attempt,
                input.attemptId,
                work,
                task,
                principal,
              );
              const activeOwner = isCurrentRunningTaskAttempt(
                attempt,
                input.attemptId,
                work,
                task,
                principal,
              );
              const finalizedPendingOwner = isFinalizedPendingWorkAttempt(
                attempt,
                input.attemptId,
                work,
                task,
                principal,
              );
              if (!completedOwner && !activeOwner && !finalizedPendingOwner) {
                return yield* fail(
                  "forbidden",
                  "Review submitter does not own the current running or completed reviewer attempt.",
                );
              }
              const reviewContent: HubPlanReviewRecord = {
                planId: current.id,
                id: "review-content-comparison",
                revision: current.revision,
                stageKey: input.stageKey,
                generation: input.generation,
                candidateId: input.candidateId,
                outputDigest: input.outputDigest,
                reviewerNodeKey: node.key,
                attemptId: attempt.id,
                outcome: input.outcome,
                status: "submitted",
                summary: input.summary,
                createdAt: timestamp,
              };
              const existingAttemptReview = (yield* store
                .listReviews({ planId: current.id })
                .pipe(
                  Effect.mapError((cause) => mapError(cause, "check existing reviewer result")),
                )).find(
                (item) =>
                  item.revision === current.revision &&
                  item.candidateId === input.candidateId &&
                  item.reviewerNodeKey === node.key &&
                  item.attemptId === attempt.id &&
                  item.generation === input.generation,
              );
              if (existingAttemptReview) {
                if (!sameReviewSubmission(existingAttemptReview, reviewContent)) {
                  return yield* fail(
                    "conflict",
                    "This reviewer attempt already submitted a different result for the candidate.",
                  );
                }
                const snapshot = yield* snapshotOf(current);
                yield* writeReceipt({
                  hubId: input.hubId,
                  requestId: input.requestId,
                  digest,
                  snapshot,
                });
                return snapshot;
              }
              const review: HubPlanReviewRecord = {
                planId: current.id,
                id: `review-${randomUUID()}`,
                revision: current.revision,
                stageKey: input.stageKey,
                generation: input.generation,
                candidateId: input.candidateId,
                outputDigest: input.outputDigest,
                reviewerNodeKey: node.key,
                attemptId: attempt.id,
                outcome: input.outcome,
                status: "submitted",
                summary: input.summary,
                createdAt: timestamp,
              };
              const storedReview = yield* store
                .appendReview(review)
                .pipe(Effect.mapError((cause) => mapError(cause, "store review")));
              if (storedReview.id !== review.id) {
                if (!sameReviewSubmission(storedReview, review)) {
                  return yield* fail(
                    "conflict",
                    "This reviewer attempt already submitted a different result for the candidate.",
                  );
                }
                const snapshot = yield* snapshotOf(current);
                yield* writeReceipt({
                  hubId: input.hubId,
                  requestId: input.requestId,
                  digest,
                  snapshot,
                });
                return snapshot;
              }
              if (activeOwner) {
                yield* native
                  .finalizePlanNode({
                    hubId: ProjectId.makeUnsafe(current.hubId),
                    planId: current.id,
                    revision: current.revision,
                    nodeKey: node.key,
                    taskId: task.id,
                    attemptId: attempt.id,
                    workItemId: attemptBinding.workItemId,
                    workerThreadId: attempt.workerThreadId,
                    requestId: input.requestId,
                    outcome: "review",
                    summary: input.summary,
                    submittedAt: timestamp,
                  })
                  .pipe(Effect.mapError((cause) => mapError(cause, "finalize reviewer task")));
              }
              eventDetails["plan.review-submitted"] = { summary: input.summary };
              schedule = true;
            } else if (input.action === "release") {
              if (current.controlState !== "active")
                return yield* fail("invalid_state", "Only an active plan may release a stage.");
              const stage = current.definition.stages.find(
                (candidate) => candidate.key === input.stageKey,
              );
              if (!stage || stage.releasePolicy !== "user")
                return yield* fail("invalid_request", "This stage does not use user release.");
              const graphSnapshot = yield* snapshotOf(current);
              const view = stageView(graphSnapshot, input.stageKey);
              if (
                !view ||
                view.status !== "waiting_user" ||
                view.generation !== input.generation ||
                view.candidateId !== input.candidateId ||
                view.outputDigest !== input.outputDigest
              ) {
                return yield* fail(
                  "stale_candidate",
                  "Release must match the current waiting candidate, generation and digest.",
                );
              }
              const candidate = (yield* store
                .listCandidates({ planId: current.id })
                .pipe(Effect.mapError((cause) => mapError(cause, "read release candidate")))).find(
                (item) =>
                  item.revision === current.revision &&
                  item.candidateId === input.candidateId &&
                  item.status === "current",
              );
              if (
                !candidate ||
                candidate.generation !== input.generation ||
                candidate.outputDigest !== input.outputDigest
              ) {
                return yield* fail("stale_candidate", "Release candidate is no longer current.");
              }
              const authorBinding = (yield* store
                .listBindings({ planId: current.id, revision: current.revision })
                .pipe(
                  Effect.mapError((cause) => mapError(cause, "read release author binding")),
                )).find((item) => item.nodeKey === candidate.authorNodeKey);
              const authorTask = authorBinding
                ? yield* native
                    .getTask(ProjectTaskId.makeUnsafe(authorBinding.taskId))
                    .pipe(Effect.mapError((cause) => mapError(cause, "read release author task")))
                : null;
              const authorAttempts = authorTask
                ? yield* native
                    .listAttempts(authorTask.id)
                    .pipe(
                      Effect.mapError((cause) => mapError(cause, "read release author attempts")),
                    )
                : [];
              const currentAuthorAttempt = authorTask ? newestAttempt(authorAttempts) : undefined;
              if (
                !authorTask ||
                authorTask.status !== "done" ||
                currentAuthorAttempt?.id !== candidate.authorAttemptId ||
                currentAuthorAttempt.outcome !== "succeeded"
              ) {
                return yield* fail(
                  "stale_candidate",
                  "The author task is no longer done on the candidate attempt.",
                );
              }
              yield* native
                .validateDeliverables(
                  ProjectId.makeUnsafe(current.hubId),
                  candidate.deliverableRefs,
                  currentAuthorAttempt.workerThreadId,
                )
                .pipe(
                  Effect.mapError((cause) => mapError(cause, "revalidate release deliverables")),
                );
              if (!validateDigestForRefs(candidate.deliverableRefs, input.outputDigest)) {
                return yield* fail(
                  "stale_candidate",
                  "Release digest no longer matches the immutable candidate references.",
                );
              }
              yield* store
                .appendRelease({
                  planId: current.id,
                  id: `release-${randomUUID()}`,
                  revision: current.revision,
                  stageKey: input.stageKey,
                  generation: input.generation,
                  candidateId: input.candidateId,
                  outputDigest: input.outputDigest,
                  source: "user",
                  effective: true,
                  ...(input.comment === undefined ? {} : { comment: input.comment }),
                  createdAt: timestamp,
                })
                .pipe(Effect.mapError((cause) => mapError(cause, "store user release")));
              if (input.comment !== undefined) {
                eventDetails["plan.released"] = { comment: input.comment };
              }
              schedule = true;
            } else if (input.action === "return") {
              if (current.controlState !== "active")
                return yield* fail("invalid_state", "Only an active plan may return a stage.");
              const graphSnapshot = yield* snapshotOf(current);
              const view = stageView(graphSnapshot, input.stageKey);
              if (
                !view ||
                !["waiting_user", "changes_requested", "ready_to_release"].includes(view.status) ||
                view.generation !== input.generation ||
                view.candidateId !== input.candidateId ||
                view.outputDigest !== input.outputDigest
              ) {
                return yield* fail(
                  "stale_candidate",
                  "Return must match the current stage candidate and generation.",
                );
              }
              const affected = downstreamStageKeys(current.definition, input.stageKey);
              const activeNodeKey = yield* findActiveAffectedNode(current, affected);
              if (activeNodeKey !== null) {
                return yield* fail(
                  "invalid_state",
                  `Pause this plan before returning while node '${activeNodeKey}' has current work.`,
                );
              }
              const bindings = yield* store
                .listBindings({ planId: current.id, revision: current.revision })
                .pipe(Effect.mapError((cause) => mapError(cause, "read return task bindings")));
              const bindingByNode = new Map(bindings.map((item) => [item.nodeKey, item]));
              if (current.goalId === null)
                return yield* fail("internal", "The active plan has no native goal.");
              const allNativeTasks = yield* native
                .readTasks(ProjectGoalId.makeUnsafe(current.goalId))
                .pipe(Effect.mapError((cause) => mapError(cause, "read tasks before return")));
              const taskById = new Map(allNativeTasks.map((task) => [task.id, task]));
              const taskByNode = new Map<string, ProjectTask>();
              for (const node of current.definition.nodes) {
                if (!affected.has(node.stageKey)) continue;
                const binding = bindingByNode.get(node.key);
                const task = binding
                  ? yield* native
                      .getTask(ProjectTaskId.makeUnsafe(binding.taskId))
                      .pipe(Effect.mapError((cause) => mapError(cause, "read task for return")))
                  : null;
                if (!task || task.projectId !== current.hubId || task.goalId !== current.goalId) {
                  return yield* fail(
                    "internal",
                    `Task for returned node '${node.key}' is missing.`,
                  );
                }
                taskByNode.set(node.key, task);
              }
              const authorNode = current.definition.nodes.find(
                (node) => node.stageKey === input.stageKey && node.role === "author",
              );
              const authorTask = authorNode ? taskByNode.get(authorNode.key) : undefined;
              if (!authorTask)
                return yield* fail("internal", "Returned stage author task is missing.");
              if (authorTask.repairCount >= current.definition.maxRepairRounds) {
                return yield* fail(
                  "repair_budget_exhausted",
                  "The plan has used all allowed repair rounds for this stage.",
                );
              }
              const taskIdByNode = new Map(
                current.definition.nodes.map((node) => [
                  node.key,
                  bindingByNode.get(node.key)?.taskId,
                ]),
              );
              for (const node of topologicalNodeOrder(current.definition)) {
                if (!affected.has(node.stageKey)) continue;
                const task = taskByNode.get(node.key);
                if (!task) continue;
                const prerequisitesDone = node.dependsOnNodeKeys.every((key) => {
                  const dependencyStage = nodeStageByKey(current.definition, key);
                  const dependencyTaskId = taskIdByNode.get(key);
                  const dependency = dependencyTaskId
                    ? taskById.get(ProjectTaskId.makeUnsafe(dependencyTaskId))
                    : undefined;
                  return (
                    dependencyStage !== undefined &&
                    !affected.has(dependencyStage) &&
                    dependency?.status === "done"
                  );
                });
                const updatedTask: ProjectTask = {
                  ...task,
                  status: prerequisitesDone ? "ready" : "planned",
                  repairCount:
                    node.key === authorNode?.key ? task.repairCount + 1 : task.repairCount,
                  revision: task.revision + 1,
                  updatedAt: timestamp,
                };
                yield* native
                  .saveTask(updatedTask, task.revision)
                  .pipe(Effect.mapError((cause) => mapError(cause, "reset task for repair")));
                taskByNode.set(node.key, updatedTask);
                taskById.set(updatedTask.id, updatedTask);
              }
              updated = {
                ...updated,
                stageGenerations: {
                  ...current.stageGenerations,
                  ...Object.fromEntries(
                    [...affected].map((key) => [key, (current.stageGenerations[key] ?? 0) + 1]),
                  ),
                },
              };
              if (input.comment !== undefined) {
                eventDetails["plan.returned"] = { comment: input.comment };
              }
              schedule = true;
            } else if (input.action === "requestInput") {
              if (principal.kind !== "worker") {
                return yield* fail("forbidden", "Only the assigned Worker may request Hub input.");
              }
              if (current.controlState !== "active" || current.goalId === null) {
                return yield* fail("invalid_state", "Input requests require an active plan.");
              }
              if (!current.configSnapshot.settings) {
                return yield* fail("invalid_state", "Plan settings are not frozen for execution.");
              }
              const node = current.definition.nodes.find(
                (candidate) => candidate.key === input.nodeKey,
              );
              if (
                !node ||
                node.stageKey !== input.stageKey ||
                input.generation !== current.stageGenerations[input.stageKey]
              ) {
                return yield* fail(
                  "stale_candidate",
                  "Input request is not for the current plan node.",
                );
              }
              if (
                node.expertId !== undefined &&
                (!(current.configSnapshot.expertIds ?? []).includes(node.expertId) ||
                  !(current.configSnapshot.expertSnapshots ?? []).some(
                    (snapshot) => snapshot.expertId === node.expertId,
                  ))
              ) {
                return yield* fail(
                  "forbidden",
                  "This plan node is outside its frozen Expert roster.",
                );
              }
              const config = yield* native
                .readConfig(input.hubId)
                .pipe(Effect.mapError((cause) => mapError(cause, "read input request Hub")));
              if (!config.enabled || config.pausedAt !== null || config.archivedAt !== null) {
                return yield* fail("invalid_state", "Resume the Hub before requesting plan input.");
              }
              const goal = yield* native
                .getGoal(ProjectGoalId.makeUnsafe(current.goalId))
                .pipe(Effect.mapError((cause) => mapError(cause, "read input request goal")));
              if (
                !goal ||
                goal.projectId !== current.hubId ||
                goal.status !== "active" ||
                goal.scopeVersion !== current.revision
              ) {
                return yield* fail(
                  "stale_candidate",
                  "The native goal is no longer active at this plan scope.",
                );
              }
              const nodeBindings = yield* store
                .listBindings({ planId: current.id, revision: current.revision })
                .pipe(
                  Effect.mapError((cause) => mapError(cause, "read input request node binding")),
                );
              const nodeBinding = nodeBindings.find((candidate) => candidate.nodeKey === node.key);
              if (
                !nodeBinding ||
                nodeBinding.stageKey !== node.stageKey ||
                nodeBinding.role !== node.role
              ) {
                return yield* fail("stale_candidate", "Plan node binding is no longer current.");
              }
              const task = yield* native
                .getTask(ProjectTaskId.makeUnsafe(nodeBinding.taskId))
                .pipe(Effect.mapError((cause) => mapError(cause, "read input request task")));
              if (!task || task.projectId !== input.hubId || task.goalId !== current.goalId) {
                return yield* fail("stale_candidate", "Plan node task is no longer current.");
              }
              if (task.status !== "running" && task.status !== "review") {
                return yield* fail(
                  "invalid_state",
                  "Only an active Worker attempt may request input.",
                );
              }
              const attempts = yield* native
                .listAttempts(task.id)
                .pipe(Effect.mapError((cause) => mapError(cause, "read input request attempts")));
              const attempt = attempts.find((candidate) => candidate.id === input.attemptId);
              const attemptBindings = yield* store
                .listAttemptBindings({ planId: current.id })
                .pipe(
                  Effect.mapError((cause) => mapError(cause, "read input request attempt binding")),
                );
              const attemptBinding = newestAttemptBinding(
                attemptBindings.filter(
                  (candidate) =>
                    candidate.revision === current.revision &&
                    candidate.nodeKey === node.key &&
                    candidate.taskId === task.id &&
                    candidate.stageGeneration === input.generation,
                ),
              );
              if (
                !attempt ||
                attempt.taskId !== task.id ||
                attempt.workerThreadId !== principal.threadId ||
                attempt.outcome !== "running" ||
                task.assignedThreadId !== principal.threadId ||
                attemptBinding?.attemptId !== input.attemptId
              ) {
                return yield* fail(
                  "forbidden",
                  "Input requester is not the current assigned Worker attempt.",
                );
              }
              const work = yield* native
                .readWork(attemptBinding.workItemId)
                .pipe(Effect.mapError((cause) => mapError(cause, "read input request work")));
              if (
                !work ||
                work.workerThreadId !== principal.threadId ||
                (work.state !== "working" && work.state !== "waiting")
              ) {
                return yield* fail("invalid_state", "The bound Worker is no longer active.");
              }
              const existingById = yield* store
                .readInputRequest({ planId: current.id, requestId: input.inputRequestId })
                .pipe(Effect.mapError((cause) => mapError(cause, "read existing input request")));
              if (existingById) {
                const sameRequest =
                  existingById.revision === current.revision &&
                  existingById.nodeKey === input.nodeKey &&
                  existingById.stageKey === input.stageKey &&
                  existingById.generation === input.generation &&
                  existingById.attemptId === input.attemptId &&
                  existingById.workerThreadId === principal.threadId &&
                  canonicalJson(existingById.questions) === canonicalJson(input.questions);
                if (!sameRequest) {
                  return yield* fail(
                    "idempotency_conflict",
                    "Input request ID was reused with different content.",
                  );
                }
                const snapshot = yield* snapshotOf(current);
                yield* writeReceipt({
                  hubId: input.hubId,
                  requestId: input.requestId,
                  digest,
                  snapshot,
                });
                return snapshot;
              }
              const allRequests = yield* store
                .listInputRequests({ planId: current.id })
                .pipe(Effect.mapError((cause) => mapError(cause, "count plan input requests")));
              if (allRequests.length >= HUB_PLAN_MAX_INPUT_REQUESTS) {
                return yield* fail(
                  "invalid_state",
                  "This plan has reached its durable input-request limit.",
                );
              }
              if (
                allRequests.some(
                  (request) =>
                    request.revision === current.revision &&
                    request.nodeKey === node.key &&
                    request.generation === input.generation &&
                    request.attemptId === input.attemptId &&
                    (request.status === "pending" || request.status === "answered"),
                )
              ) {
                return yield* fail(
                  "invalid_state",
                  "Answer the existing Worker input request first.",
                );
              }
              const request: HubPlanInputRequestRecord = {
                planId: current.id,
                revision: current.revision,
                id: input.inputRequestId,
                nodeKey: node.key,
                stageKey: node.stageKey,
                generation: input.generation,
                attemptId: input.attemptId,
                workerThreadId: principal.threadId,
                questions: input.questions,
                status: "pending",
                createdAt: timestamp,
                updatedAt: timestamp,
              };
              const savedRequest = yield* store
                .saveInputRequest(request)
                .pipe(Effect.mapError((cause) => mapError(cause, "save plan input request")));
              const publicRequest: HubPlanInputRequest = {
                id: savedRequest.id,
                nodeKey: savedRequest.nodeKey,
                stageKey: savedRequest.stageKey,
                generation: savedRequest.generation,
                attemptId: savedRequest.attemptId,
                workerThreadId: savedRequest.workerThreadId,
                questions: savedRequest.questions,
                status: savedRequest.status,
              };
              eventDetails["plan.input-requested"] = { inputRequest: publicRequest };
            } else if (input.action === "respondInput") {
              const storedRequest = yield* store
                .readInputRequest({ planId: current.id, requestId: input.inputRequestId })
                .pipe(Effect.mapError((cause) => mapError(cause, "read input response target")));
              if (!storedRequest) return yield* fail("not_found", "Input request was not found.");
              if (input.answers.length !== storedRequest.questions.length) {
                return yield* fail(
                  "invalid_request",
                  "Provide one answer for each directed question.",
                );
              }
              if (storedRequest.status === "answered" || storedRequest.status === "delivered") {
                if (canonicalJson(storedRequest.answers) !== canonicalJson(input.answers)) {
                  return yield* fail(
                    "conflict",
                    "This input request already has a different answer.",
                  );
                }
                const snapshot = yield* snapshotOf(current);
                yield* writeReceipt({
                  hubId: input.hubId,
                  requestId: input.requestId,
                  digest,
                  snapshot,
                });
                return snapshot;
              }
              if (storedRequest.status === "stale") {
                return yield* fail(
                  "invalid_state",
                  "This input request is stale and cannot be answered.",
                );
              }
              const projectedRequests = yield* currentInputRequestRecords({
                record: current,
                store,
                native,
              });
              const projectedRequest = projectedRequests.find(
                (request) => request.id === storedRequest.id,
              );
              const canWaitForResume = current.controlState === "paused";
              const requestIsCurrent =
                projectedRequest?.status === "pending" &&
                (current.controlState === "active" || canWaitForResume);
              if (!requestIsCurrent) {
                const stale: HubPlanInputRequestRecord = {
                  ...storedRequest,
                  status: "stale",
                  answers: input.answers,
                  updatedAt: timestamp,
                };
                const savedStale = yield* store
                  .saveInputRequest(stale)
                  .pipe(Effect.mapError((cause) => mapError(cause, "stale old input request")));
                const publicStale: HubPlanInputRequest = {
                  id: savedStale.id,
                  nodeKey: savedStale.nodeKey,
                  stageKey: savedStale.stageKey,
                  generation: savedStale.generation,
                  attemptId: savedStale.attemptId,
                  workerThreadId: savedStale.workerThreadId,
                  questions: savedStale.questions,
                  status: "stale",
                  answers: input.answers,
                };
                eventDetails["plan.input-responded"] = {
                  inputRequestId: input.inputRequestId,
                  answers: input.answers,
                  inputRequest: publicStale,
                };
              } else {
                const answered: HubPlanInputRequest = {
                  id: storedRequest.id,
                  nodeKey: storedRequest.nodeKey,
                  stageKey: storedRequest.stageKey,
                  generation: storedRequest.generation,
                  attemptId: storedRequest.attemptId,
                  workerThreadId: storedRequest.workerThreadId,
                  questions: storedRequest.questions,
                  status: "answered",
                  answers: input.answers,
                };
                const responseIdentity = hubPlanInputResponseIdentity({
                  planId: current.id,
                  requestId: storedRequest.id,
                });
                const savedAnswer = yield* store
                  .saveInputRequest({
                    ...storedRequest,
                    ...responseIdentity,
                    responseCreatedAt: timestamp,
                    responseMessageDigest: hubPlanInputResponseDigest(
                      answered as HubPlanInputRequest & { readonly answers: readonly string[] },
                    ),
                    status: "answered",
                    answers: input.answers,
                    updatedAt: timestamp,
                  })
                  .pipe(Effect.mapError((cause) => mapError(cause, "save plan input answer")));
                yield* enqueueInputResponse(updated, savedAnswer);
                eventDetails["plan.input-responded"] = {
                  inputRequestId: storedRequest.id,
                  answers: input.answers,
                  inputRequest: answered,
                };
              }
            }

            if (input.action === "release") {
              const postRelease = yield* snapshotOf(updated);
              if (
                postRelease.graph.releasedCount === postRelease.graph.stageCount &&
                updated.controlState === "active" &&
                updated.goalId !== null
              ) {
                const goal = yield* native
                  .getGoal(ProjectGoalId.makeUnsafe(updated.goalId))
                  .pipe(Effect.mapError((cause) => mapError(cause, "read completed plan goal")));
                if (goal && goal.projectId === updated.hubId && goal.status !== "completed") {
                  yield* native
                    .saveGoal(
                      {
                        ...goal,
                        status: "completed",
                        revision: goal.revision + 1,
                        updatedAt: timestamp,
                      },
                      goal.revision,
                    )
                    .pipe(Effect.mapError((cause) => mapError(cause, "complete plan goal")));
                }
                updated = { ...updated, controlState: "completed" };
                schedule = false;
                eventKinds.push("plan.completed");
              }
            }

            const persisted = yield* store
              .savePlan(updated, current.stateVersion)
              .pipe(Effect.mapError((cause) => mapError(cause, "save plan command")));
            if (schedule) yield* enqueue(persisted, "plan.schedule", retrySchedule);
            if (stop) yield* enqueue(persisted, "plan.stop");
            yield* appendSnapshotEvents(persisted, eventKinds, eventDetails);
            const snapshot = yield* snapshotOf(persisted);
            yield* writeReceipt({
              hubId: input.hubId,
              requestId: input.requestId,
              digest,
              snapshot,
            });
            return snapshot;
          }),
        )
        .pipe(Effect.mapError((cause) => mapError(cause, "run plan command")));
    }).pipe(Effect.mapError((cause) => mapError(cause, "run plan command")));

  const reconcile = (hubId: ProjectId) =>
    store
      .transaction(
        Effect.gen(function* () {
          const plans = yield* store
            .list({ hubId })
            .pipe(Effect.mapError((cause) => mapError(cause, "list plans for reconciliation")));
          let record = plans.find((item) => item.controlState === "active");
          if (!record) return null;

          for (let pass = 0; pass < record.definition.stages.length; pass += 1) {
            const projected = yield* snapshotOf(record);
            const readyAutoRelease = projected.graph.stages.find(
              (stage) =>
                stage.releasePolicy === "auto" &&
                stage.status === "ready_to_release" &&
                stage.candidateId !== null &&
                stage.outputDigest !== null,
            );
            if (
              !readyAutoRelease ||
              readyAutoRelease.generation === null ||
              !readyAutoRelease.candidateId ||
              !readyAutoRelease.outputDigest
            ) {
              break;
            }
            const candidates = yield* store
              .listCandidates({ planId: record.id })
              .pipe(
                Effect.mapError((cause) => mapError(cause, "read automatic release candidate")),
              );
            const candidate = candidates.find(
              (item) =>
                item.revision === record!.revision &&
                item.status === "current" &&
                item.stageKey === readyAutoRelease.stageKey &&
                item.generation === readyAutoRelease.generation &&
                item.candidateId === readyAutoRelease.candidateId &&
                item.outputDigest === readyAutoRelease.outputDigest,
            ) as CandidateWithDeliverables | undefined;
            if (
              !candidate ||
              !validateDigestForRefs(candidate.deliverableRefs, candidate.outputDigest)
            ) {
              return yield* fail(
                "stale_candidate",
                "Automatic release requires the current candidate and matching deliverable digest.",
              );
            }
            const nodeBindings = yield* store
              .listBindings({ planId: record.id, revision: record.revision })
              .pipe(
                Effect.mapError((cause) =>
                  mapError(cause, "read automatic release author binding"),
                ),
              );
            const authorBinding = nodeBindings.find(
              (binding) => binding.nodeKey === candidate.authorNodeKey,
            );
            if (!authorBinding) {
              return yield* fail("internal", "Automatic release author binding is missing.");
            }
            const authorTask = yield* native
              .getTask(ProjectTaskId.makeUnsafe(authorBinding.taskId))
              .pipe(
                Effect.mapError((cause) => mapError(cause, "read automatic release author task")),
              );
            if (
              !authorTask ||
              authorTask.projectId !== record.hubId ||
              authorTask.goalId !== record.goalId
            ) {
              return yield* fail("internal", "Automatic release author task is missing.");
            }
            const attempts = yield* native
              .listAttempts(authorTask.id)
              .pipe(
                Effect.mapError((cause) =>
                  mapError(cause, "read automatic release author attempt"),
                ),
              );
            const authorAttempt = attempts.find(
              (attempt) => attempt.id === candidate.authorAttemptId,
            );
            const attemptBindings = yield* store
              .listAttemptBindings({ planId: record.id })
              .pipe(
                Effect.mapError((cause) =>
                  mapError(cause, "read automatic release attempt binding"),
                ),
              );
            const currentAttemptBinding = newestAttemptBinding(
              attemptBindings.filter(
                (binding) =>
                  binding.revision === record!.revision &&
                  binding.nodeKey === candidate.authorNodeKey &&
                  binding.stageGeneration === readyAutoRelease.generation,
              ),
            );
            if (
              authorTask.status !== "done" ||
              !authorAttempt ||
              authorAttempt.outcome !== "succeeded" ||
              currentAttemptBinding?.attemptId !== candidate.authorAttemptId
            ) {
              return yield* fail(
                "stale_candidate",
                "Automatic release requires the current completed author attempt.",
              );
            }
            const authorWork = yield* native
              .readWork(currentAttemptBinding.workItemId)
              .pipe(
                Effect.mapError((cause) => mapError(cause, "read automatic release author work")),
              );
            const acceptedAfterStop =
              authorWork !== null &&
              authorAttempt !== undefined &&
              isAcceptedAfterStop({
                planId: record.id,
                hubId: record.hubId,
                revision: record.revision,
                nodeKey: candidate.authorNodeKey,
                stageKey: readyAutoRelease.stageKey,
                role: "author",
                currentGeneration: readyAutoRelease.generation,
                binding: currentAttemptBinding,
                task: authorTask,
                attempt: authorAttempt,
                workState: authorWork.state,
                workWorkerThreadId: authorWork.workerThreadId,
                candidates: [candidate],
                reviews: [],
              });
            if (
              !authorWork ||
              (authorWork.state !== "completed" && !acceptedAfterStop) ||
              authorWork.workerThreadId !== authorAttempt.workerThreadId
            ) {
              return yield* fail(
                "invalid_state",
                "Automatic release waits for author Work completion.",
              );
            }
            yield* native
              .validateDeliverables(
                ProjectId.makeUnsafe(record.hubId),
                candidate.deliverableRefs,
                authorAttempt.workerThreadId,
              )
              .pipe(
                Effect.mapError((cause) =>
                  mapError(cause, "revalidate automatic release deliverables"),
                ),
              );

            const timestamp = now();
            yield* store
              .appendRelease({
                planId: record.id,
                id: `release-${randomUUID()}`,
                revision: record.revision,
                stageKey: readyAutoRelease.stageKey,
                generation: readyAutoRelease.generation,
                candidateId: candidate.candidateId,
                outputDigest: candidate.outputDigest,
                source: "auto",
                effective: true,
                createdAt: timestamp,
              })
              .pipe(Effect.mapError((cause) => mapError(cause, "store automatic release")));
            let next: PlanRecord = {
              ...record,
              stateVersion: record.stateVersion + 1,
              updatedAt: timestamp,
            };
            const afterRelease = yield* snapshotOf(next);
            const completed =
              afterRelease.graph.releasedCount === afterRelease.graph.stageCount &&
              next.goalId !== null;
            if (completed && next.goalId !== null) {
              const goal = yield* native
                .getGoal(ProjectGoalId.makeUnsafe(next.goalId))
                .pipe(Effect.mapError((cause) => mapError(cause, "read goal for plan completion")));
              if (goal && goal.projectId === next.hubId && goal.status !== "completed") {
                yield* native
                  .saveGoal(
                    {
                      ...goal,
                      status: "completed",
                      revision: goal.revision + 1,
                      updatedAt: timestamp,
                    },
                    goal.revision,
                  )
                  .pipe(
                    Effect.mapError((cause) => mapError(cause, "complete automatic plan goal")),
                  );
              }
              next = { ...next, controlState: "completed" };
            }
            record = yield* store
              .savePlan(next, record.stateVersion)
              .pipe(Effect.mapError((cause) => mapError(cause, "save automatic plan release")));
            if (!completed) yield* enqueue(record, "plan.schedule");
            yield* appendSnapshotEvents(
              record,
              completed ? ["plan.released", "plan.completed"] : ["plan.released"],
            );
            if (completed) break;
          }

          if (record.controlState === "active") {
            const projected = yield* snapshotOf(record);
            const events = yield* store
              .readEvents({ planId: record.id })
              .pipe(Effect.mapError((cause) => mapError(cause, "read awaiting-release events")));
            for (const stage of projected.graph.stages) {
              if (
                stage.status !== "waiting_user" ||
                stage.generation === null ||
                stage.candidateId === null ||
                stage.outputDigest === null
              ) {
                continue;
              }
              const alreadyNotified = events.some((event) => {
                if (
                  event.kind !== "plan.awaiting-release" ||
                  typeof event.payload !== "object" ||
                  event.payload === null
                ) {
                  return false;
                }
                const payload = event.payload as Record<string, unknown>;
                return (
                  payload.stageKey === stage.stageKey && payload.generation === stage.generation
                );
              });
              if (alreadyNotified) continue;
              yield* appendSnapshotEvents(record, ["plan.awaiting-release"], {
                "plan.awaiting-release": {
                  stageKey: stage.stageKey,
                  generation: stage.generation,
                  candidateId: stage.candidateId,
                  outputDigest: stage.outputDigest,
                },
              });
            }
          }
          return yield* snapshotOf(record);
        }),
      )
      .pipe(Effect.mapError((cause) => mapError(cause, "reconcile Hub plan")));

  return { list, read, events, propose, command, reconcile };
}
