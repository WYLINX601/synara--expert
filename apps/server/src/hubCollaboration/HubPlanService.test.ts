import { assert, it } from "@effect/vitest";
import {
  DEFAULT_PROJECT_AGENT_LIMITS,
  MessageId,
  ProjectId,
  ProjectTaskAttemptId,
  ThreadId,
  type HubPlanCommandInput,
  type HubPlanDefinition,
  type HubPlanProposeInput,
  type HubWorkRecord,
  type ProjectAgentConfig,
  type ProjectManagedWorker,
  type ProjectGoal,
  type ProjectTask,
  type ProjectTaskAttempt,
} from "@synara/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../persistence/Migrations.ts";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";
import { runWorkbenchMigrations } from "../workbench/persistence/WorkbenchMigrations.ts";

import {
  HubPlanStoreConflictError,
  HubPlanStoreIdempotencyError,
  makeHubPlanStore,
  type HubPlanAttemptBinding,
  type HubPlanCandidateRecord,
  type HubPlanEvent,
  type HubPlanNodeBinding,
  type HubPlanOutboxItem,
  type HubPlanReceipt,
  type HubPlanReleaseRecord,
  type HubPlanReviewRecord,
  type HubPlanInputRequestRecord,
  type PlanRecord,
} from "./HubPlanStore.ts";
import {
  HubPlanServiceError,
  makeHubPlanService,
  type HubPlanServiceDependencies,
  type HubPlanServiceNativeCapabilities,
  type HubPlanServiceStore,
} from "./HubPlanService.ts";

const timestamp = "2026-10-22T10:00:00.000Z";
let runtimeCounter = 0;

const makeDefinition = (releasePolicy: "auto" | "user" = "user"): HubPlanDefinition => ({
  objective: "Produce a reviewed result",
  scope: "One bounded work package",
  stages: [{ key: "draft", title: "Draft", releasePolicy }],
  nodes: [
    {
      key: "author",
      stageKey: "draft",
      title: "Author",
      brief: "Prepare the candidate",
      role: "author",
      dependsOnNodeKeys: [],
      target: { provider: "codex", instanceId: "codex", model: "gpt-6.1-sol" },
      workMode: "agent",
      acceptanceCriteria: "The result is complete",
    },
    {
      key: "reviewer",
      stageKey: "draft",
      title: "Reviewer",
      brief: "Review the candidate",
      role: "reviewer",
      dependsOnNodeKeys: ["author"],
      target: { provider: "codex", instanceId: "codex", model: "gpt-6.1-sol" },
      workMode: "agent",
      acceptanceCriteria: "The result meets the criteria",
    },
  ],
  maxRepairRounds: 2,
});

interface TestNativeState {
  readonly goals: Map<string, ProjectGoal>;
  readonly tasks: Map<string, ProjectTask>;
  readonly attempts: Map<string, ProjectTaskAttempt[]>;
  readonly works: Map<string, HubWorkRecord>;
  readonly managedWorkers: Map<string, ProjectManagedWorker>;
}

interface FakeStoreState {
  plans: Map<string, PlanRecord>;
  revisions: Map<string, PlanRecord>;
  bindings: HubPlanNodeBinding[];
  attemptBindings: HubPlanAttemptBinding[];
  candidates: HubPlanCandidateRecord[];
  reviews: HubPlanReviewRecord[];
  releases: HubPlanReleaseRecord[];
  inputRequests: Map<string, HubPlanInputRequestRecord>;
  events: HubPlanEvent[];
  receipts: Map<string, HubPlanReceipt>;
  outbox: HubPlanOutboxItem[];
  nextSequence: number;
}

const cloneStoreState = (state: FakeStoreState): FakeStoreState => ({
  plans: new Map(state.plans),
  revisions: new Map(state.revisions),
  bindings: [...state.bindings],
  attemptBindings: [...state.attemptBindings],
  candidates: [...state.candidates],
  reviews: [...state.reviews],
  releases: [...state.releases],
  inputRequests: new Map(state.inputRequests),
  events: [...state.events],
  receipts: new Map(state.receipts),
  outbox: [...state.outbox],
  nextSequence: state.nextSequence,
});

const makeFakeStore = (): HubPlanServiceStore => {
  let state: FakeStoreState = {
    plans: new Map(),
    revisions: new Map(),
    bindings: [],
    attemptBindings: [],
    candidates: [],
    reviews: [],
    releases: [],
    inputRequests: new Map(),
    events: [],
    receipts: new Map(),
    outbox: [],
    nextSequence: 0,
  };
  const receiptKey = (hubId: string, requestId: string) => `${hubId}\u0000${requestId}`;
  const store = {
    transaction: <A, E, R>(effect: Effect.Effect<A, E, R>) => {
      const before = cloneStoreState(state);
      return effect.pipe(
        Effect.tapError(() =>
          Effect.sync(() => {
            state = before;
          }),
        ),
      );
    },
    read: (input: { readonly planId: string; readonly revision?: number }) =>
      Effect.succeed(
        input.revision === undefined
          ? (state.plans.get(input.planId) ?? null)
          : (state.revisions.get(`${input.planId}\u0000${input.revision}`) ?? null),
      ),
    list: (input: { readonly hubId: string }) =>
      Effect.succeed([...state.plans.values()].filter((plan) => plan.hubId === input.hubId)),
    savePlan: (plan: PlanRecord, expected: number | null) =>
      Effect.gen(function* () {
        const current = state.plans.get(plan.id);
        if (current && JSON.stringify(current) === JSON.stringify(plan)) return current;
        if ((current?.stateVersion ?? null) !== expected) {
          return yield* Effect.fail(
            new HubPlanStoreConflictError({
              resourceId: plan.id,
              expectedStateVersion: expected,
              actualStateVersion: current?.stateVersion ?? null,
            }),
          );
        }
        if (!current && plan.revision !== 1) {
          return yield* Effect.fail(
            new HubPlanStoreConflictError({
              resourceId: plan.id,
              expectedStateVersion: expected,
              actualStateVersion: null,
            }),
          );
        }
        if (["active", "pausing", "paused", "cancelling"].includes(plan.controlState)) {
          const other = [...state.plans.values()].find(
            (item) =>
              item.hubId === plan.hubId &&
              item.id !== plan.id &&
              ["active", "pausing", "paused", "cancelling"].includes(item.controlState),
          );
          if (other)
            return yield* Effect.fail(
              new HubPlanStoreConflictError({
                resourceId: plan.id,
                expectedStateVersion: expected,
                actualStateVersion: other.stateVersion,
              }),
            );
        }
        if (current && current.revision !== plan.revision)
          state.revisions.set(`${current.id}\u0000${current.revision}`, current);
        state.plans.set(plan.id, plan);
        state.revisions.set(`${plan.id}\u0000${plan.revision}`, plan);
        return plan;
      }),
    saveBindings: (bindings: readonly HubPlanNodeBinding[]) => {
      for (const binding of bindings) {
        if (
          !state.bindings.some(
            (item) =>
              item.planId === binding.planId &&
              item.revision === binding.revision &&
              item.nodeKey === binding.nodeKey,
          )
        )
          state.bindings.push(binding);
      }
      return Effect.succeed(bindings);
    },
    listBindings: (input: { readonly planId: string; readonly revision?: number }) =>
      Effect.succeed(
        state.bindings.filter(
          (binding) =>
            binding.planId === input.planId &&
            (input.revision === undefined || binding.revision === input.revision),
        ),
      ),
    appendAttemptBinding: (binding: HubPlanAttemptBinding) => {
      const existing = state.attemptBindings.find((item) => item.id === binding.id);
      if (existing && JSON.stringify(existing) !== JSON.stringify(binding))
        return Effect.fail(new HubPlanStoreIdempotencyError({ resourceId: binding.id }));
      if (!existing) state.attemptBindings.push(binding);
      return Effect.succeed(existing ?? binding);
    },
    listAttemptBindings: (input: { readonly planId: string }) =>
      Effect.succeed(state.attemptBindings.filter((item) => item.planId === input.planId)),
    appendCandidate: (record: HubPlanCandidateRecord) => {
      const existing = state.candidates.find(
        (item) => item.planId === record.planId && item.id === record.id,
      );
      if (existing && JSON.stringify(existing) !== JSON.stringify(record))
        return Effect.fail(new HubPlanStoreIdempotencyError({ resourceId: record.id }));
      if (!existing) state.candidates.push(record);
      return Effect.succeed(existing ?? record);
    },
    listCandidates: (input: { readonly planId: string }) =>
      Effect.succeed(state.candidates.filter((item) => item.planId === input.planId)),
    appendReview: (record: HubPlanReviewRecord) => {
      state.reviews.push(record);
      return Effect.succeed(record);
    },
    listReviews: (input: { readonly planId: string }) =>
      Effect.succeed(state.reviews.filter((item) => item.planId === input.planId)),
    appendRelease: (record: HubPlanReleaseRecord) => {
      state.releases.push(record);
      return Effect.succeed(record);
    },
    listReleases: (input: { readonly planId: string }) =>
      Effect.succeed(state.releases.filter((item) => item.planId === input.planId)),
    appendEvent: (event: Omit<HubPlanEvent, "sequence">) => {
      const stored = { ...event, sequence: ++state.nextSequence };
      state.events.push(stored);
      return Effect.succeed(stored);
    },
    readEvents: (
      input: {
        readonly afterSequence?: number;
        readonly planId?: string;
        readonly hubId?: string;
      } = {},
    ) =>
      Effect.succeed(
        state.events.filter(
          (event) =>
            event.sequence > (input.afterSequence ?? 0) &&
            (!input.planId || event.planId === input.planId) &&
            (!input.hubId || event.hubId === input.hubId),
        ),
      ),
    readLatestEventSequence: (input: { readonly hubId: string; readonly planId?: string }) =>
      Effect.succeed(
        state.events
          .filter(
            (event) =>
              event.hubId === input.hubId && (!input.planId || event.planId === input.planId),
          )
          .at(-1)?.sequence ?? 0,
      ),
    readReceipt: (input: { readonly hubId: string; readonly requestId: string }) =>
      Effect.succeed(state.receipts.get(receiptKey(input.hubId, input.requestId)) ?? null),
    writeReceipt: (receipt: HubPlanReceipt) => {
      const key = receiptKey(receipt.hubId, receipt.requestId);
      const existing = state.receipts.get(key);
      if (existing && JSON.stringify(existing) !== JSON.stringify(receipt))
        return Effect.fail(new HubPlanStoreIdempotencyError({ resourceId: key }));
      state.receipts.set(key, receipt);
      return Effect.succeed(existing ?? receipt);
    },
    enqueue: (item: Omit<HubPlanOutboxItem, "status">) => {
      const stored: HubPlanOutboxItem = { ...item, status: "pending" };
      state.outbox.push(stored);
      return Effect.succeed(stored);
    },
    readPending: (input: { readonly planId?: string } = {}) =>
      Effect.succeed(
        state.outbox.filter(
          (item) => item.status === "pending" && (!input.planId || item.planId === input.planId),
        ),
      ),
    markDelivered: (input: { readonly id: string }) => {
      const index = state.outbox.findIndex((item) => item.id === input.id);
      if (index < 0) return Effect.succeed(null);
      const updated = { ...state.outbox[index]!, status: "delivered" as const };
      state.outbox[index] = updated;
      return Effect.succeed(updated);
    },
    saveInputRequest: (request: HubPlanInputRequestRecord) =>
      Effect.gen(function* () {
        const key = `${request.planId}\u0000${request.id}`;
        const existing = state.inputRequests.get(key);
        if (!existing) {
          if (request.status !== "pending" || request.answers !== undefined) {
            return yield* Effect.fail(new HubPlanStoreIdempotencyError({ resourceId: request.id }));
          }
          state.inputRequests.set(key, request);
          return request;
        }
        const identity = (item: HubPlanInputRequestRecord) => ({
          planId: item.planId,
          revision: item.revision,
          id: item.id,
          nodeKey: item.nodeKey,
          stageKey: item.stageKey,
          generation: item.generation,
          attemptId: item.attemptId,
          workerThreadId: item.workerThreadId,
          questions: item.questions,
          createdAt: item.createdAt,
        });
        if (JSON.stringify(identity(existing)) !== JSON.stringify(identity(request))) {
          return yield* Effect.fail(new HubPlanStoreIdempotencyError({ resourceId: request.id }));
        }
        if (
          existing.answers !== undefined &&
          JSON.stringify(existing.answers) !== JSON.stringify(request.answers)
        ) {
          return yield* Effect.fail(new HubPlanStoreIdempotencyError({ resourceId: request.id }));
        }
        const allowed =
          existing.status === request.status ||
          (existing.status === "pending" && ["answered", "stale"].includes(request.status)) ||
          (existing.status === "answered" && ["delivered", "stale"].includes(request.status));
        if (!allowed)
          return yield* Effect.fail(new HubPlanStoreIdempotencyError({ resourceId: request.id }));
        state.inputRequests.set(key, request);
        return request;
      }),
    readInputRequest: (input: { readonly planId: string; readonly requestId: string }) =>
      Effect.succeed(state.inputRequests.get(`${input.planId}\u0000${input.requestId}`) ?? null),
    listInputRequests: (input: { readonly planId: string }) =>
      Effect.succeed(
        [...state.inputRequests.values()].filter((request) => request.planId === input.planId),
      ),
  };
  return store as unknown as HubPlanServiceStore;
};

const makeTestRuntime = (configOverrides: Partial<ProjectAgentConfig> = {}) => {
  const fixtureId = ++runtimeCounter;
  const hubId = ProjectId.makeUnsafe(`hub-plan-service-test-${fixtureId}`);
  const coordinatorThreadId = ThreadId.makeUnsafe(`hub-coordinator-${fixtureId}`);
  const sourceMessageId = MessageId.makeUnsafe(`source-message-${fixtureId}`);
  const config: ProjectAgentConfig = {
    projectId: hubId,
    coordinatorThreadId,
    coordinatorName: "Coordinator",
    coordinatorModelSelection: { provider: "codex", instanceId: "codex", model: "gpt-6.1-sol" },
    limits: { ...DEFAULT_PROJECT_AGENT_LIMITS },
    captureEnabled: false,
    enabled: true,
    automationId: null,
    revision: 3,
    pausedAt: null,
    archivedAt: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    disabledAt: null,
    expertIds: [],
    collaboration: { schemaVersion: 1, mode: "standard" },
    ...configOverrides,
  };
  const store = makeFakeStore();
  const state: TestNativeState = {
    goals: new Map(),
    tasks: new Map(),
    attempts: new Map(),
    works: new Map(),
    managedWorkers: new Map(),
  };
  const native: HubPlanServiceNativeCapabilities = {
    readConfig: () => Effect.succeed(config),
    getActiveGoal: (projectId) =>
      Effect.succeed(
        [...state.goals.values()].find(
          (goal) =>
            goal.projectId === projectId && ["draft", "active", "paused"].includes(goal.status),
        ) ?? null,
      ),
    getGoal: (goalId) => Effect.succeed(state.goals.get(goalId) ?? null),
    getTask: (taskId) => Effect.succeed(state.tasks.get(taskId) ?? null),
    readTasks: (goalId) =>
      Effect.succeed([...state.tasks.values()].filter((task) => task.goalId === goalId)),
    saveGoal: (goal, expectedRevision) =>
      Effect.gen(function* () {
        const current = state.goals.get(goal.id);
        if ((current?.revision ?? null) !== expectedRevision)
          return yield* Effect.fail(new Error("goal CAS conflict"));
        state.goals.set(goal.id, goal);
        return goal;
      }),
    saveTask: (task, expectedRevision) =>
      Effect.gen(function* () {
        const current = state.tasks.get(task.id);
        if ((current?.revision ?? null) !== expectedRevision)
          return yield* Effect.fail(new Error("task CAS conflict"));
        state.tasks.set(task.id, task);
        return task;
      }),
    listAttempts: (taskId) => Effect.succeed(state.attempts.get(taskId) ?? []),
    saveAttempt: (attempt) =>
      Effect.sync(() => {
        const attempts = state.attempts.get(attempt.taskId) ?? [];
        const existingIndex = attempts.findIndex((candidate) => candidate.id === attempt.id);
        state.attempts.set(
          attempt.taskId,
          existingIndex < 0
            ? [...attempts, attempt]
            : attempts.map((candidate, index) => (index === existingIndex ? attempt : candidate)),
        );
        return attempt;
      }),
    readManagedWorkerByThread: (threadId) =>
      Effect.succeed(state.managedWorkers.get(threadId) ?? null),
    readWork: (workItemId) => Effect.succeed(state.works.get(workItemId) ?? null),
    finalizePlanNode: ({ taskId, attemptId }) =>
      Effect.gen(function* () {
        const task = state.tasks.get(taskId);
        const attempts = state.attempts.get(taskId) ?? [];
        const attempt = attempts.find((item) => item.id === attemptId);
        if (!task || !attempt || attempt.outcome !== "running") {
          return yield* Effect.fail(new Error("current plan node attempt is unavailable"));
        }
        state.tasks.set(taskId, {
          ...task,
          status: "done",
          revision: task.revision + 1,
          updatedAt: timestamp,
        });
        state.attempts.set(
          taskId,
          attempts.map((item) =>
            item.id === attemptId ? { ...item, outcome: "succeeded", finishedAt: timestamp } : item,
          ),
        );
      }),
    readSourceMessages: (_projectId, ids) =>
      Effect.succeed(
        ids.map((messageId) => ({
          threadId: coordinatorThreadId,
          messageId,
          turnId: null,
          text: "Please produce a reviewed result.",
          attachments: [],
          createdAt: timestamp,
          updatedAt: timestamp,
        })),
      ),
    freezeExperts: (expertIds) =>
      Effect.succeed(
        expertIds.map((expertId) => ({
          expertId,
          snapshotId: `snapshot-${expertId}`,
          revision: 1,
        })),
      ),
    validateDeliverables: () => Effect.void,
  };
  const dependencies: HubPlanServiceDependencies = { store, native };
  return {
    store,
    state,
    native,
    config,
    service: makeHubPlanService(dependencies),
    hubId,
    coordinatorThreadId,
    sourceMessageId,
  };
};

const proposeInput = (
  hubId: ProjectId,
  sourceMessageId: MessageId,
  planId: string,
  definition = makeDefinition(),
): HubPlanProposeInput => ({
  hubId,
  requestId: `propose-${planId}`,
  planId,
  expectedStateVersion: null,
  definition,
  sourceMessageIds: [sourceMessageId],
});

const confirmInput = (
  hubId: ProjectId,
  planId: string,
  version = 1,
  requestId = `confirm-${planId}`,
): HubPlanCommandInput => ({
  action: "confirm",
  hubId,
  planId,
  requestId,
  expectedStateVersion: version,
  expectedRevision: 1,
});

const completeAttempt = (
  state: TestNativeState,
  store: HubPlanServiceStore,
  planId: string,
  hubId: ProjectId,
  nodeKey: string,
  generation: number,
  threadId: ThreadId,
) =>
  Effect.gen(function* () {
    const bindings = yield* store.listBindings({ planId, revision: 1 });
    const binding = bindings.find((item) => item.nodeKey === nodeKey);
    assert.isDefined(binding);
    const task = state.tasks.get(binding.taskId);
    assert.isDefined(task);
    const updatedTask: ProjectTask = {
      ...task,
      status: "done",
      revision: task.revision + 1,
      updatedAt: timestamp,
    };
    state.tasks.set(task.id, updatedTask);
    const attemptId = ProjectTaskAttemptId.makeUnsafe(`attempt-${nodeKey}-${generation}`);
    const attempt: ProjectTaskAttempt = {
      id: attemptId,
      projectId: hubId,
      taskId: task.id,
      workerThreadId: threadId,
      gatewayOperationId: null,
      requestId: `request-${nodeKey}-${generation}`,
      attemptNumber: generation,
      outcome: "succeeded",
      error: null,
      createdAt: timestamp,
      finishedAt: timestamp,
    };
    state.attempts.set(task.id, [...(state.attempts.get(task.id) ?? []), attempt]);
    const workItemId = `work-${nodeKey}-${generation}`;
    state.works.set(workItemId, {
      state: "completed",
      workerThreadId: threadId,
      slotHeld: false,
    } as HubWorkRecord);
    yield* store.appendAttemptBinding({
      id: `binding-${nodeKey}-${generation}`,
      planId,
      revision: 1,
      nodeKey,
      taskId: task.id,
      attemptId,
      workItemId,
      stageGeneration: generation,
      createdAt: timestamp,
    });
    return { task: updatedTask, attempt };
  });

const commandError = <A, E>(effect: Effect.Effect<A, E, never>) => Effect.flip(effect);

it.effect("confirms into native goal/tasks, replays receipts, and pause stays pausing", () =>
  Effect.gen(function* () {
    const { store, state, service, hubId, sourceMessageId } = makeTestRuntime();
    yield* service.propose(proposeInput(hubId, sourceMessageId, "plan-confirm"), { kind: "user" });
    const confirmed = yield* service.command(confirmInput(hubId, "plan-confirm"), { kind: "user" });
    assert.strictEqual(confirmed.controlState, "active");
    assert.strictEqual(confirmed.goalId, [...state.goals.values()][0]?.id ?? null);
    assert.strictEqual([...state.goals.values()][0]?.scopeVersion, confirmed.revision);
    assert.strictEqual([...state.tasks.values()].length, 2);
    assert.deepStrictEqual(
      (yield* store.listBindings({ planId: "plan-confirm", revision: 1 })).length,
      2,
    );
    assert.strictEqual((yield* store.readPending({ planId: "plan-confirm" })).length, 1);
    assert.strictEqual((yield* store.readEvents({ planId: "plan-confirm" })).length, 2);

    const replay = yield* service.command(confirmInput(hubId, "plan-confirm"), { kind: "user" });
    assert.deepStrictEqual(replay, confirmed);
    assert.strictEqual((yield* store.readPending({ planId: "plan-confirm" })).length, 1);
    assert.strictEqual([...state.tasks.values()].length, 2);

    const paused = yield* service.command(
      {
        action: "pause",
        hubId,
        planId: confirmed.id,
        requestId: "pause-plan-confirm",
        expectedStateVersion: confirmed.stateVersion,
        expectedRevision: confirmed.revision,
      },
      { kind: "user" },
    );
    assert.strictEqual(paused.controlState, "pausing");
    assert.strictEqual(paused.graph.controlState, "pausing");
    assert.strictEqual([...state.goals.values()][0]?.status, "paused");
    assert.strictEqual(
      (yield* store.readPending({ planId: "plan-confirm" })).at(-1)?.kind,
      "plan.stop",
    );
  }),
);

it.effect(
  "binds directed Hub input to one Worker attempt and records owner answers without approving work",
  () =>
    Effect.gen(function* () {
      const { store, state, service, hubId, sourceMessageId } = makeTestRuntime();
      yield* service.propose(proposeInput(hubId, sourceMessageId, "plan-directed-input"), {
        kind: "user",
      });
      let snapshot = yield* service.command(confirmInput(hubId, "plan-directed-input"), {
        kind: "user",
      });
      const binding = (yield* store.listBindings({ planId: snapshot.id, revision: 1 })).find(
        (item) => item.nodeKey === "author",
      );
      assert.isDefined(binding);
      const workerThreadId = ThreadId.makeUnsafe("directed-input-author");
      const attemptId = ProjectTaskAttemptId.makeUnsafe("directed-input-attempt-1");
      const task = state.tasks.get(binding.taskId);
      assert.isDefined(task);
      state.tasks.set(task.id, {
        ...task,
        status: "running",
        assignedThreadId: workerThreadId,
        revision: task.revision + 1,
        updatedAt: timestamp,
      });
      state.attempts.set(task.id, [
        {
          id: attemptId,
          projectId: hubId,
          taskId: task.id,
          workerThreadId,
          gatewayOperationId: null,
          requestId: "directed-input-native-request-1",
          attemptNumber: 1,
          outcome: "running",
          error: null,
          createdAt: timestamp,
          finishedAt: null,
        },
      ]);
      state.works.set("directed-input-work-1", {
        state: "working",
        workerThreadId,
        slotHeld: true,
      } as HubWorkRecord);
      yield* store.appendAttemptBinding({
        id: "directed-input-binding-1",
        planId: snapshot.id,
        revision: snapshot.revision,
        nodeKey: "author",
        taskId: task.id,
        attemptId,
        workItemId: "directed-input-work-1",
        stageGeneration: 1,
        createdAt: timestamp,
      });

      const requestInput = (input: {
        readonly commandId: string;
        readonly threadId: ThreadId;
        readonly inputRequestId?: string;
        readonly title?: string;
      }) =>
        service.command(
          {
            action: "requestInput",
            hubId,
            planId: snapshot.id,
            requestId: input.commandId,
            expectedStateVersion: snapshot.stateVersion,
            expectedRevision: snapshot.revision,
            inputRequestId: input.inputRequestId ?? "directed-input-question-1",
            nodeKey: "author",
            stageKey: "draft",
            generation: 1,
            attemptId,
            questions: [
              {
                title: input.title ?? "Which output format should I use?",
                options: ["Markdown", "PDF"],
              },
            ],
          },
          { kind: "worker", hubId, threadId: input.threadId },
        );

      snapshot = yield* requestInput({
        commandId: "input-request-by-bound-worker",
        threadId: workerThreadId,
      });
      assert.strictEqual(snapshot.inputRequests?.[0]?.status, "pending");
      assert.strictEqual(snapshot.graph.stages[0]?.status, "waiting");
      assert.strictEqual(
        snapshot.nodeStates.find((node) => node.nodeKey === "author")?.workState,
        "working",
        "directed input must not fabricate a native HubWork state",
      );
      assert.notStrictEqual(
        snapshot.nodeStates.find((node) => node.nodeKey === "author")?.retryable,
        true,
      );

      const spoof = yield* commandError(
        requestInput({
          commandId: "input-request-cross-thread-spoof",
          threadId: ThreadId.makeUnsafe("different-worker-thread"),
        }),
      );
      assert.isTrue(spoof instanceof HubPlanServiceError);
      assert.strictEqual((spoof as HubPlanServiceError).code, "forbidden");

      const changedRequest = yield* commandError(
        requestInput({
          commandId: "input-request-reused-id-different-question",
          threadId: workerThreadId,
          title: "Can I change the permissions?",
        }),
      );
      assert.isTrue(changedRequest instanceof HubPlanServiceError);
      assert.strictEqual((changedRequest as HubPlanServiceError).code, "idempotency_conflict");

      const answered = yield* service.command(
        {
          action: "respondInput",
          hubId,
          planId: snapshot.id,
          requestId: "owner-answer-directed-input",
          expectedStateVersion: snapshot.stateVersion,
          expectedRevision: snapshot.revision,
          inputRequestId: "directed-input-question-1",
          answers: ["Markdown"],
        },
        { kind: "user" },
      );
      assert.strictEqual(answered.controlState, "active");
      assert.strictEqual(answered.inputRequests?.[0]?.status, "answered");
      assert.deepStrictEqual(answered.inputRequests?.[0]?.answers, ["Markdown"]);
      assert.strictEqual(
        (yield* store.readInputRequest({
          planId: snapshot.id,
          requestId: "directed-input-question-1",
        }))?.responseCreatedAt,
        answered.updatedAt,
      );
      assert.strictEqual(answered.graph.stages[0]?.status, "waiting");
      assert.strictEqual(
        answered.nodeStates.find((node) => node.nodeKey === "author")?.workState,
        "working",
        "answering does not mutate the native HubWork state",
      );
      assert.notStrictEqual(
        answered.nodeStates.find((node) => node.nodeKey === "author")?.retryable,
        true,
      );
      assert.strictEqual(
        (yield* store.readPending({ planId: snapshot.id })).at(-1)?.kind,
        "plan.input-response",
      );

      const changedAnswer = yield* commandError(
        service.command(
          {
            action: "respondInput",
            hubId,
            planId: snapshot.id,
            requestId: "owner-changed-answer-directed-input",
            expectedStateVersion: answered.stateVersion,
            expectedRevision: answered.revision,
            inputRequestId: "directed-input-question-1",
            answers: ["PDF"],
          },
          { kind: "user" },
        ),
      );
      assert.isTrue(changedAnswer instanceof HubPlanServiceError);
      assert.strictEqual((changedAnswer as HubPlanServiceError).code, "conflict");
    }),
);

it.effect("requires explicit model targets for Expert nodes too", () =>
  Effect.gen(function* () {
    const { service, hubId, sourceMessageId } = makeTestRuntime({
      expertIds: ["architect"],
      collaboration: { schemaVersion: 1, mode: "expert-team" },
    });
    const definition: HubPlanDefinition = {
      ...makeDefinition(),
      nodes: makeDefinition().nodes.map(({ target: _target, ...node }) => ({
        ...node,
        expertId: "architect",
      })),
    };
    const error = yield* commandError(
      service.propose(proposeInput(hubId, sourceMessageId, "plan-expert-target", definition), {
        kind: "user",
      }),
    );
    assert.isTrue(error instanceof HubPlanServiceError);
    assert.strictEqual((error as HubPlanServiceError).code, "invalid_plan");
    assert.include((error as HubPlanServiceError).detail, "explicit model target");
  }),
);

it.effect("projects the newest reserved retry instead of a cancelled prior attempt", () =>
  Effect.gen(function* () {
    const { store, state, service, hubId, sourceMessageId } = makeTestRuntime();
    yield* service.propose(proposeInput(hubId, sourceMessageId, "plan-pending-retry"), {
      kind: "user",
    });
    const snapshot = yield* service.command(confirmInput(hubId, "plan-pending-retry"), {
      kind: "user",
    });
    const authorThread = ThreadId.makeUnsafe("worker-retry-author");
    const { task } = yield* completeAttempt(
      state,
      store,
      snapshot.id,
      hubId,
      "author",
      1,
      authorThread,
    );
    state.tasks.set(task.id, {
      ...task,
      status: "ready",
      assignedThreadId: null,
      revision: task.revision + 1,
    });
    state.works.set("work-author-1", {
      state: "cancelled",
      workerThreadId: authorThread,
    } as HubWorkRecord);
    state.works.set("work-author-retry-2", {
      state: "queued",
      workerThreadId: null,
    } as HubWorkRecord);
    yield* store.appendAttemptBinding({
      id: "retry-binding-author-2",
      planId: snapshot.id,
      revision: snapshot.revision,
      nodeKey: "author",
      taskId: task.id,
      attemptId: ProjectTaskAttemptId.makeUnsafe("attempt-author-retry-2"),
      workItemId: "work-author-retry-2",
      stageGeneration: 1,
      createdAt: "2026-10-22T10:01:00.000Z",
    });

    const projected = yield* service.read({ hubId, planId: snapshot.id }, { kind: "user" });
    assert.isNotNull(projected);
    assert.deepStrictEqual(
      projected?.nodeStates.find((nodeState) => nodeState.nodeKey === "author"),
      {
        nodeKey: "author",
        taskId: task.id,
        workerThreadId: null,
        attemptId: null,
        taskStatus: "ready",
      },
    );
    assert.isUndefined(
      projected?.nodeStates.find((nodeState) => nodeState.nodeKey === "author")?.workState,
      "reserved queued work without a current assigned attempt has no node runtime state",
    );
    assert.strictEqual(projected?.graph.stages[0]?.status, "queued");
  }),
);

it.effect("projects runtime work details only for the exact assigned attempt", () =>
  Effect.gen(function* () {
    const { store, state, service, hubId, sourceMessageId } = makeTestRuntime();
    yield* service.propose(proposeInput(hubId, sourceMessageId, "plan-runtime-projection"), {
      kind: "user",
    });
    const confirmed = yield* service.command(confirmInput(hubId, "plan-runtime-projection"), {
      kind: "user",
    });
    const authorBinding = (yield* store.listBindings({ planId: confirmed.id, revision: 1 })).find(
      (binding) => binding.nodeKey === "author",
    );
    assert.isDefined(authorBinding);
    const task = state.tasks.get(authorBinding.taskId);
    assert.isDefined(task);
    const workerThreadId = ThreadId.makeUnsafe("worker-runtime-projection-author");
    const attempt: ProjectTaskAttempt = {
      id: ProjectTaskAttemptId.makeUnsafe("attempt-runtime-projection-author"),
      projectId: hubId,
      taskId: task.id,
      workerThreadId,
      gatewayOperationId: null,
      requestId: "request-runtime-projection-author",
      attemptNumber: 1,
      outcome: "running",
      error: null,
      createdAt: timestamp,
      finishedAt: null,
    };
    state.tasks.set(task.id, {
      ...task,
      status: "running",
      assignedThreadId: workerThreadId,
      revision: task.revision + 1,
      updatedAt: timestamp,
    });
    state.attempts.set(task.id, [attempt]);
    state.works.set("work-runtime-projection-author", {
      state: "working",
      workerThreadId,
      slotHeld: true,
      progress: { revision: 1, steps: [], summary: "Editing the current candidate" },
      queueReason: null,
    } as unknown as HubWorkRecord);
    yield* store.appendAttemptBinding({
      id: "binding-runtime-projection-author",
      planId: confirmed.id,
      revision: 1,
      nodeKey: "author",
      taskId: task.id,
      attemptId: attempt.id,
      workItemId: "work-runtime-projection-author",
      stageGeneration: 1,
      createdAt: timestamp,
    });

    const projected = yield* service.read({ hubId, planId: confirmed.id }, { kind: "user" });
    const authorState = projected?.nodeStates.find((nodeState) => nodeState.nodeKey === "author");
    assert.deepStrictEqual(authorState, {
      nodeKey: "author",
      taskId: task.id,
      workerThreadId,
      attemptId: attempt.id,
      taskStatus: "running",
      workState: "working",
      progressSummary: "Editing the current candidate",
    });

    state.works.set("work-runtime-projection-author", {
      state: "waiting",
      workerThreadId,
      slotHeld: true,
      progress: { revision: 2, steps: [], summary: "Waiting for an external response" },
      queueReason: "Waiting for a provider response",
    } as unknown as HubWorkRecord);
    const waitingWork = yield* service.read({ hubId, planId: confirmed.id }, { kind: "user" });
    const waitingState = waitingWork?.nodeStates.find(
      (nodeState) => nodeState.nodeKey === "author",
    );
    assert.strictEqual(waitingState?.workState, "waiting");
    assert.strictEqual(waitingState?.progressSummary, "Waiting for an external response");
    assert.strictEqual(waitingState?.queueReason, "Waiting for a provider response");

    state.works.set("work-runtime-projection-author", {
      state: "failed",
      workerThreadId: ThreadId.makeUnsafe("another-worker"),
      slotHeld: false,
      progress: { revision: 2, steps: [], summary: "A different worker report" },
      queueReason: "A different worker queue reason",
    } as unknown as HubWorkRecord);
    const mismatchedWork = yield* service.read({ hubId, planId: confirmed.id }, { kind: "user" });
    const mismatchedState = mismatchedWork?.nodeStates.find(
      (nodeState) => nodeState.nodeKey === "author",
    );
    assert.strictEqual(mismatchedState?.taskStatus, "running");
    assert.isUndefined(mismatchedState?.workState);
    assert.isUndefined(mismatchedState?.progressSummary);
    assert.isUndefined(mismatchedState?.queueReason);
  }),
);

it.effect("allows only an explicit user retry of a settled node without accepted evidence", () =>
  Effect.gen(function* () {
    const { store, state, service, hubId, sourceMessageId, coordinatorThreadId } =
      makeTestRuntime();
    yield* service.propose(proposeInput(hubId, sourceMessageId, "plan-explicit-retry"), {
      kind: "user",
    });
    const confirmed = yield* service.command(confirmInput(hubId, "plan-explicit-retry"), {
      kind: "user",
    });
    const authorThread = ThreadId.makeUnsafe("worker-explicit-retry-author");
    const { task, attempt } = yield* completeAttempt(
      state,
      store,
      confirmed.id,
      hubId,
      "author",
      1,
      authorThread,
    );
    state.works.set("work-author-1", {
      state: "idle",
      workerThreadId: authorThread,
      slotHeld: false,
      progress: {
        revision: 1,
        steps: [],
        summary: "Provider turn settled without an accepted node result.",
      },
    } as unknown as HubWorkRecord);
    state.managedWorkers.set(authorThread, {
      projectId: hubId,
      threadId: authorThread,
      batchId: "explicit-retry-test",
      requestId: "work-author-1",
      title: "Author",
      taskId: task.id,
      settledAt: timestamp,
      settleOutcome: "completed",
      waitingSince: null,
      stuckKind: null,
      stuckSince: null,
      taskPrompt: "Author a candidate.",
      recoveryEpisode: null,
      recoveryStep: 0,
      nudgeAt: null,
      recoveriesUsed: 0,
      needsYou: false,
      needsYouAt: null,
      activeTurnOrigin: "coordinator",
      activeTurnCommandId: null,
      resultSummary: null,
      resultAt: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    state.attempts.set(task.id, [
      { ...attempt, outcome: "running", error: null, finishedAt: null },
    ]);
    state.tasks.set(task.id, {
      ...task,
      status: "running",
      assignedThreadId: authorThread,
      revision: task.revision + 1,
      updatedAt: timestamp,
    });

    state.works.set("work-author-1", {
      state: "idle",
      workerThreadId: authorThread,
      slotHeld: true,
    } as HubWorkRecord);
    const occupiedSlotSnapshot = yield* service.read(
      { hubId, planId: confirmed.id },
      { kind: "user" },
    );
    assert.notStrictEqual(
      occupiedSlotSnapshot?.nodeStates.find((nodeState) => nodeState.nodeKey === "author")
        ?.retryable,
      true,
      "an idle Work record with a held slot is not settled for retry",
    );
    state.works.set("work-author-1", {
      state: "idle",
      workerThreadId: authorThread,
      slotHeld: false,
      progress: {
        revision: 2,
        steps: [],
        summary: "Provider turn settled without an accepted node result.",
      },
    } as unknown as HubWorkRecord);
    const matchingManagedWorker = state.managedWorkers.get(authorThread)!;
    state.managedWorkers.set(authorThread, {
      ...matchingManagedWorker,
      requestId: "different-work-item",
    });
    const mismatchedSettlementSnapshot = yield* service.read(
      { hubId, planId: confirmed.id },
      { kind: "user" },
    );
    assert.notStrictEqual(
      mismatchedSettlementSnapshot?.nodeStates.find((nodeState) => nodeState.nodeKey === "author")
        ?.retryable,
      true,
      "settlement evidence must match the current Work binding",
    );
    state.managedWorkers.set(authorThread, matchingManagedWorker);

    const failedManagedWorker: ProjectManagedWorker = {
      ...matchingManagedWorker,
      settleOutcome: "failed",
      settledAt: timestamp,
    };
    state.managedWorkers.set(authorThread, failedManagedWorker);
    state.works.set("work-author-1", {
      state: "failed",
      workerThreadId: authorThread,
      slotHeld: true,
      progress: { revision: 3, steps: [], summary: "Provider turn failed." },
    } as unknown as HubWorkRecord);
    const failedHeldSlotSnapshot = yield* service.read(
      { hubId, planId: confirmed.id },
      { kind: "user" },
    );
    assert.notStrictEqual(
      failedHeldSlotSnapshot?.nodeStates.find((nodeState) => nodeState.nodeKey === "author")
        ?.retryable,
      true,
      "a failed Work record with a still-held slot cannot be retried",
    );

    state.works.set("work-author-1", {
      state: "failed",
      workerThreadId: authorThread,
      slotHeld: false,
      progress: { revision: 4, steps: [], summary: "Provider turn failed." },
    } as unknown as HubWorkRecord);
    const pendingInput: HubPlanInputRequestRecord = {
      planId: confirmed.id,
      revision: confirmed.revision,
      id: "pending-input-before-retry",
      nodeKey: "author",
      stageKey: "draft",
      generation: 1,
      attemptId: attempt.id,
      workerThreadId: authorThread,
      questions: [{ title: "Choose a format", options: ["Markdown", "PDF"] }],
      status: "pending",
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    yield* store.saveInputRequest(pendingInput);
    const pendingInputSnapshot = yield* service.read(
      { hubId, planId: confirmed.id },
      { kind: "user" },
    );
    assert.notStrictEqual(
      pendingInputSnapshot?.nodeStates.find((nodeState) => nodeState.nodeKey === "author")
        ?.retryable,
      true,
      "a durable pending input request blocks retry even if its native Work is failed",
    );
    const retryWithPendingInput = yield* commandError(
      service.command(
        {
          action: "retry",
          hubId,
          planId: confirmed.id,
          requestId: "retry-failed-with-pending-input",
          expectedStateVersion: pendingInputSnapshot!.stateVersion,
          expectedRevision: pendingInputSnapshot!.revision,
          nodeKey: "author",
          stageKey: "draft",
          generation: 1,
          attemptId: attempt.id,
        },
        { kind: "user" },
      ),
    );
    assert.isTrue(retryWithPendingInput instanceof HubPlanServiceError);
    assert.strictEqual((retryWithPendingInput as HubPlanServiceError).code, "invalid_state");
    yield* store.saveInputRequest({
      ...pendingInput,
      status: "stale",
      updatedAt: timestamp,
    });
    state.managedWorkers.set(authorThread, failedManagedWorker);

    const beforeRetry = yield* service.read({ hubId, planId: confirmed.id }, { kind: "user" });
    assert.isNotNull(beforeRetry);
    assert.strictEqual(beforeRetry?.graph.stages[0]?.status, "blocked");
    assert.include(
      beforeRetry?.graph.stages[0]?.blockingReasons ?? [],
      "A provider turn failed without an accepted node result; an explicit retry is available.",
    );
    assert.deepStrictEqual(
      beforeRetry?.nodeStates.find((nodeState) => nodeState.nodeKey === "author"),
      {
        nodeKey: "author",
        taskId: task.id,
        workerThreadId: authorThread,
        attemptId: attempt.id,
        taskStatus: "running",
        workState: "failed",
        progressSummary: "Provider turn failed.",
        retryable: true,
      },
    );
    const failedWorkBeforeRetry = state.works.get("work-author-1");

    const retryInput: HubPlanCommandInput = {
      action: "retry",
      hubId,
      planId: confirmed.id,
      requestId: "retry-explicit-retry-author",
      expectedStateVersion: beforeRetry!.stateVersion,
      expectedRevision: beforeRetry!.revision,
      nodeKey: "author",
      stageKey: "draft",
      generation: 1,
      attemptId: attempt.id,
    };
    const forgedCoordinatorRetry = yield* commandError(
      service.command(retryInput, {
        kind: "coordinator",
        hubId,
        threadId: coordinatorThreadId,
      }),
    );
    assert.isTrue(forgedCoordinatorRetry instanceof HubPlanServiceError);
    assert.strictEqual((forgedCoordinatorRetry as HubPlanServiceError).code, "forbidden");

    const retried = yield* service.command(retryInput, { kind: "user" });
    assert.strictEqual(retried.controlState, "active");
    assert.strictEqual(retried.graph.stages[0]?.generation, 1);
    assert.isFalse(
      retried.nodeStates.find((nodeState) => nodeState.nodeKey === "author")?.retryable === true,
    );
    const resetTask = state.tasks.get(task.id);
    assert.strictEqual(resetTask?.status, "ready");
    assert.isNull(resetTask?.assignedThreadId);
    const closedAttempt = state.attempts
      .get(task.id)
      ?.find((candidate) => candidate.id === attempt.id);
    assert.strictEqual(closedAttempt?.outcome, "failed");
    assert.include(closedAttempt?.error ?? "", "Provider turn failed.");
    assert.deepStrictEqual(
      state.works.get("work-author-1"),
      failedWorkBeforeRetry,
      "owner retry preserves the original failed native Work record and cause",
    );
    assert.strictEqual(
      state.works.get("work-author-1")?.state,
      "failed",
      "retry leaves the settled Work record unchanged",
    );

    const events = yield* service.events({ hubId, afterSequence: 0 }, { kind: "user" });
    const retriedEvent = events.find((event) => event.kind === "plan.retried");
    assert.isDefined(retriedEvent);
    assert.include(retriedEvent.payload.summary ?? "", "node 'author'");
    assert.include(retriedEvent.payload.summary ?? "", `attempt ${attempt.id}`);
    assert.isNull(
      retriedEvent.payload.snapshot.nodeStates.find((nodeState) => nodeState.nodeKey === "author")
        ?.attemptId,
    );

    const retryOutbox = (yield* store.readPending({ planId: confirmed.id })).filter(
      (item) =>
        item.kind === "plan.schedule" &&
        (item.payload as { readonly retry?: unknown }).retry !== undefined,
    );
    assert.strictEqual(retryOutbox.length, 1);
    assert.deepStrictEqual((retryOutbox[0]?.payload as { readonly retry?: unknown }).retry, {
      nodeKey: "author",
      stageKey: "draft",
      generation: 1,
      attemptId: attempt.id,
    });

    const replay = yield* service.command(retryInput, { kind: "user" });
    assert.deepStrictEqual(replay, retried);
    assert.strictEqual(
      (yield* service.events({ hubId, afterSequence: 0 }, { kind: "user" })).length,
      3,
    );
    assert.strictEqual(
      (yield* store.readPending({ planId: confirmed.id })).filter(
        (item) =>
          item.kind === "plan.schedule" &&
          (item.payload as { readonly retry?: unknown }).retry !== undefined,
      ).length,
      1,
    );
  }),
);

it.effect("does not retry an accepted author candidate or submitted reviewer conclusion", () =>
  Effect.gen(function* () {
    for (const nodeKey of ["author", "reviewer"] as const) {
      const { store, state, service, hubId, sourceMessageId } = makeTestRuntime();
      const planId = `plan-accepted-retry-${nodeKey}`;
      yield* service.propose(proposeInput(hubId, sourceMessageId, planId), { kind: "user" });
      const confirmed = yield* service.command(confirmInput(hubId, planId), { kind: "user" });
      const workerThreadId = ThreadId.makeUnsafe(`worker-accepted-retry-${nodeKey}`);
      const { task, attempt } = yield* completeAttempt(
        state,
        store,
        confirmed.id,
        hubId,
        nodeKey,
        1,
        workerThreadId,
      );
      state.works.set(`work-${nodeKey}-1`, {
        state: "failed",
        workerThreadId,
        slotHeld: false,
      } as unknown as HubWorkRecord);
      state.tasks.set(task.id, {
        ...task,
        status: "running",
        assignedThreadId: workerThreadId,
        revision: task.revision + 1,
        updatedAt: timestamp,
      });
      if (nodeKey === "author") {
        yield* store.appendCandidate({
          planId,
          id: "candidate-already-accepted",
          revision: confirmed.revision,
          stageKey: "draft",
          generation: 1,
          candidateId: "candidate-already-accepted",
          outputDigest: "sha256:accepted-candidate",
          authorNodeKey: "author",
          authorAttemptId: attempt.id,
          summary: "Accepted before the task was observed unfinished.",
          status: "current",
          deliverableRefs: [],
          createdAt: timestamp,
        });
      } else {
        yield* store.appendReview({
          planId,
          id: "review-already-submitted",
          revision: confirmed.revision,
          stageKey: "draft",
          generation: 1,
          candidateId: "candidate-fixed",
          outputDigest: "sha256:fixed-candidate",
          reviewerNodeKey: "reviewer",
          attemptId: attempt.id,
          outcome: "changes_requested",
          status: "submitted",
          summary: "The submitted review is still an accepted result.",
          createdAt: timestamp,
        });
      }
      const snapshot = yield* service.read({ hubId, planId }, { kind: "user" });
      assert.isNotNull(snapshot);
      const rejected = yield* commandError(
        service.command(
          {
            action: "retry",
            hubId,
            planId,
            requestId: `retry-accepted-${nodeKey}`,
            expectedStateVersion: snapshot!.stateVersion,
            expectedRevision: snapshot!.revision,
            nodeKey,
            stageKey: "draft",
            generation: 1,
            attemptId: attempt.id,
          },
          { kind: "user" },
        ),
      );
      assert.isTrue(rejected instanceof HubPlanServiceError);
      assert.strictEqual((rejected as HubPlanServiceError).code, "invalid_state");
      assert.strictEqual(state.tasks.get(task.id)?.status, "running");
      assert.strictEqual(
        (yield* store.readEvents({ planId })).some((event) => event.kind === "plan.retried"),
        false,
      );
    }
  }),
);

it.effect("projects only a submitted review for the current candidate and reviewer attempt", () =>
  Effect.gen(function* () {
    const reviewCases = [
      { key: "pass", outcome: "pass" },
      { key: "blocked", outcome: "blocked" },
      { key: "changes-requested", outcome: "changes_requested" },
      { key: "old-attempt", outcome: "blocked", staleAttempt: true },
      { key: "old-candidate", outcome: "blocked", staleCandidate: true },
    ] as const;
    for (const reviewCase of reviewCases) {
      const staleAttempt = "staleAttempt" in reviewCase && reviewCase.staleAttempt;
      const staleCandidate = "staleCandidate" in reviewCase && reviewCase.staleCandidate;
      const { store, state, service, hubId, sourceMessageId } = makeTestRuntime();
      const planId = `plan-review-outcome-${reviewCase.key}`;
      yield* service.propose(proposeInput(hubId, sourceMessageId, planId), { kind: "user" });
      const confirmed = yield* service.command(confirmInput(hubId, planId), { kind: "user" });
      const authorThread = ThreadId.makeUnsafe(`worker-review-outcome-author-${reviewCase.key}`);
      const reviewerThread = ThreadId.makeUnsafe(
        `worker-review-outcome-reviewer-${reviewCase.key}`,
      );
      const author = yield* completeAttempt(
        state,
        store,
        confirmed.id,
        hubId,
        "author",
        1,
        authorThread,
      );
      const reviewer = yield* completeAttempt(
        state,
        store,
        confirmed.id,
        hubId,
        "reviewer",
        1,
        reviewerThread,
      );
      state.tasks.set(reviewer.task.id, {
        ...reviewer.task,
        assignedThreadId: reviewerThread,
        revision: reviewer.task.revision + 1,
        updatedAt: timestamp,
      });
      yield* store.appendCandidate({
        planId,
        id: `candidate-review-outcome-${reviewCase.key}`,
        revision: confirmed.revision,
        stageKey: "draft",
        generation: 1,
        candidateId: "candidate-review-outcome-current",
        outputDigest: "sha256:review-outcome-current",
        authorNodeKey: "author",
        authorAttemptId: author.attempt.id,
        summary: "Current candidate",
        status: "current",
        deliverableRefs: [],
        createdAt: timestamp,
      });
      yield* store.appendReview({
        planId,
        id: `review-review-outcome-${reviewCase.key}`,
        revision: confirmed.revision,
        stageKey: "draft",
        generation: 1,
        candidateId: staleCandidate
          ? "candidate-review-outcome-old"
          : "candidate-review-outcome-current",
        outputDigest: staleCandidate
          ? "sha256:review-outcome-old"
          : "sha256:review-outcome-current",
        reviewerNodeKey: "reviewer",
        attemptId: staleAttempt
          ? ProjectTaskAttemptId.makeUnsafe("attempt-review-outcome-old")
          : reviewer.attempt.id,
        outcome: reviewCase.outcome,
        status: "submitted",
        summary: "The review is blocked.",
        createdAt: timestamp,
      });

      const projected = yield* service.read({ hubId, planId }, { kind: "user" });
      const reviewerState = projected?.nodeStates.find(
        (nodeState) => nodeState.nodeKey === "reviewer",
      );
      assert.strictEqual(reviewerState?.taskStatus, "done");
      if (!staleAttempt && !staleCandidate) {
        assert.strictEqual(reviewerState?.reviewOutcome, reviewCase.outcome);
        if (reviewCase.outcome === "blocked") {
          assert.strictEqual(projected?.graph.stages[0]?.status, "blocked");
        }
      } else {
        assert.isUndefined(reviewerState?.reviewOutcome);
      }
    }
  }),
);

it.effect("review pass waits for the user; return invalidates old generation facts", () =>
  Effect.gen(function* () {
    const { store, state, service, hubId, sourceMessageId, coordinatorThreadId } =
      makeTestRuntime();
    yield* service.propose(proposeInput(hubId, sourceMessageId, "plan-generation"), {
      kind: "user",
    });
    let snapshot = yield* service.command(confirmInput(hubId, "plan-generation"), { kind: "user" });
    const authorThread = ThreadId.makeUnsafe("worker-author");
    const reviewerThread = ThreadId.makeUnsafe("worker-reviewer");
    const author = yield* completeAttempt(
      state,
      store,
      snapshot.id,
      hubId,
      "author",
      1,
      authorThread,
    );
    const candidate = yield* service.command(
      {
        action: "submitCandidate",
        hubId,
        planId: snapshot.id,
        requestId: "candidate-generation-1",
        expectedStateVersion: snapshot.stateVersion,
        expectedRevision: snapshot.revision,
        stageKey: "draft",
        generation: 1,
        nodeKey: "author",
        attemptId: author.attempt.id,
        deliverableRefs: [
          {
            hubId,
            workerThreadId: authorThread,
            revision: 1,
            commitSha: "a".repeat(40),
            provenance: {
              hubId,
              workerThreadId: authorThread,
              expertBindingSnapshotId: "binding-author",
              publishedAt: timestamp,
            },
            file: {
              path: "result.md",
              libraryPath: "worker-author/1/result.md",
              name: "Result",
              description: null,
              mediaType: "text/markdown",
              sizeBytes: 1,
              sha256: "b".repeat(64),
            },
          },
        ],
        summary: "Candidate one",
      },
      { kind: "worker", hubId, threadId: authorThread },
    );
    assert.strictEqual(candidate.graph.stages[0]?.status, "reviewing");
    assert.strictEqual(candidate.graph.releasedCount, 0);

    const reviewer = yield* completeAttempt(
      state,
      store,
      snapshot.id,
      hubId,
      "reviewer",
      1,
      reviewerThread,
    );
    const reviewSubmission: HubPlanCommandInput = {
      action: "submitReview",
      hubId,
      planId: snapshot.id,
      requestId: "review-generation-1",
      expectedStateVersion: candidate.stateVersion,
      expectedRevision: candidate.revision,
      stageKey: "draft",
      generation: 1,
      nodeKey: "reviewer",
      attemptId: reviewer.attempt.id,
      candidateId: candidate.graph.stages[0]!.candidateId!,
      outputDigest: candidate.graph.stages[0]!.outputDigest!,
      outcome: "pass",
      summary: "Pass",
    };
    const forgedCoordinatorReview = yield* commandError(
      service.command(
        { ...reviewSubmission, requestId: "review-forged-coordinator" },
        { kind: "coordinator", hubId, threadId: coordinatorThreadId },
      ),
    );
    assert.isTrue(forgedCoordinatorReview instanceof HubPlanServiceError);
    assert.strictEqual((forgedCoordinatorReview as HubPlanServiceError).code, "forbidden");
    snapshot = yield* service.command(reviewSubmission, {
      kind: "worker",
      hubId,
      threadId: reviewerThread,
    });
    assert.strictEqual(snapshot.graph.stages[0]?.status, "waiting_user");
    assert.strictEqual(snapshot.graph.releasedCount, 0);
    const reviewRecords = yield* store.listReviews({ planId: snapshot.id });
    assert.strictEqual(reviewRecords.length, 1);
    assert.strictEqual(reviewRecords[0]?.summary, "Pass");
    const reviewEvent = (yield* store.readEvents({ planId: snapshot.id })).find(
      (event) => event.kind === "plan.review-submitted",
    );
    assert.isDefined(reviewEvent);
    assert.strictEqual((reviewEvent.payload as { readonly summary?: string }).summary, "Pass");
    const repeatedReview = yield* service.command(
      {
        action: "submitReview",
        hubId,
        planId: snapshot.id,
        requestId: "review-generation-1-replay",
        expectedStateVersion: snapshot.stateVersion,
        expectedRevision: snapshot.revision,
        stageKey: "draft",
        generation: 1,
        nodeKey: "reviewer",
        attemptId: reviewer.attempt.id,
        candidateId: snapshot.graph.stages[0]!.candidateId!,
        outputDigest: snapshot.graph.stages[0]!.outputDigest!,
        outcome: "pass",
        summary: "Pass",
      },
      { kind: "worker", hubId, threadId: reviewerThread },
    );
    assert.strictEqual(repeatedReview.stateVersion, snapshot.stateVersion);
    assert.strictEqual((yield* store.listReviews({ planId: snapshot.id })).length, 1);
    const candidateId = snapshot.graph.stages[0]!.candidateId!;
    const digest = snapshot.graph.stages[0]!.outputDigest!;
    snapshot = yield* service.command(
      {
        action: "return",
        hubId,
        planId: snapshot.id,
        requestId: "return-generation-1",
        expectedStateVersion: snapshot.stateVersion,
        expectedRevision: snapshot.revision,
        stageKey: "draft",
        generation: 1,
        candidateId,
        outputDigest: digest,
        comment: "Please add supporting evidence.",
      },
      { kind: "user" },
    );
    assert.strictEqual(snapshot.graph.stages[0]?.generation, 2);
    assert.strictEqual(snapshot.graph.releasedCount, 0);
    assert.strictEqual(state.tasks.get(author.task.id)?.repairCount, 1);
    const staleRetry = yield* commandError(
      service.command(
        {
          action: "retry",
          hubId,
          planId: snapshot.id,
          requestId: "retry-stale-generation",
          expectedStateVersion: snapshot.stateVersion,
          expectedRevision: snapshot.revision,
          nodeKey: "author",
          stageKey: "draft",
          generation: 1,
          attemptId: author.attempt.id,
        },
        { kind: "user" },
      ),
    );
    assert.isTrue(staleRetry instanceof HubPlanServiceError);
    assert.strictEqual((staleRetry as HubPlanServiceError).code, "stale_candidate");
    const returnedEvent = (yield* store.readEvents({ planId: snapshot.id })).find(
      (event) => event.kind === "plan.returned",
    );
    assert.isDefined(returnedEvent);
    assert.strictEqual(
      (returnedEvent.payload as { readonly comment?: string }).comment,
      "Please add supporting evidence.",
    );

    const staleReview = yield* commandError(
      service.command(
        {
          action: "submitReview",
          hubId,
          planId: snapshot.id,
          requestId: "review-stale-generation",
          expectedStateVersion: snapshot.stateVersion,
          expectedRevision: snapshot.revision,
          stageKey: "draft",
          generation: 1,
          nodeKey: "reviewer",
          attemptId: reviewer.attempt.id,
          candidateId,
          outputDigest: digest,
          outcome: "pass",
          summary: "Stale review",
        },
        { kind: "worker", hubId, threadId: reviewerThread },
      ),
    );
    assert.isTrue(staleReview instanceof HubPlanServiceError);
    assert.strictEqual((staleReview as HubPlanServiceError).code, "stale_candidate");

    const staleRelease = yield* commandError(
      service.command(
        {
          action: "release",
          hubId,
          planId: snapshot.id,
          requestId: "release-stale-generation",
          expectedStateVersion: snapshot.stateVersion,
          expectedRevision: snapshot.revision,
          stageKey: "draft",
          generation: 1,
          candidateId,
          outputDigest: digest,
        },
        { kind: "user" },
      ),
    );
    assert.isTrue(staleRelease instanceof HubPlanServiceError);
    assert.strictEqual((staleRelease as HubPlanServiceError).code, "stale_candidate");
  }),
);

it.effect("return rejects active queued work in a downstream stage", () =>
  Effect.gen(function* () {
    const { store, state, service, hubId, sourceMessageId } = makeTestRuntime();
    const base = makeDefinition();
    const definition: HubPlanDefinition = {
      ...base,
      stages: [...base.stages, { key: "next", title: "Next", releasePolicy: "auto" }],
      nodes: [
        ...base.nodes,
        {
          key: "next-author",
          stageKey: "next",
          title: "Next author",
          brief: "Prepare the dependent stage",
          role: "author",
          dependsOnNodeKeys: ["reviewer"],
          target: { provider: "codex", instanceId: "codex", model: "gpt-6.1-sol" },
          workMode: "agent",
          acceptanceCriteria: "The dependent result is complete",
        },
      ],
    };
    yield* service.propose(
      proposeInput(hubId, sourceMessageId, "plan-return-downstream", definition),
      {
        kind: "user",
      },
    );
    let snapshot = yield* service.command(confirmInput(hubId, "plan-return-downstream"), {
      kind: "user",
    });
    const authorThread = ThreadId.makeUnsafe("worker-return-author");
    const reviewerThread = ThreadId.makeUnsafe("worker-return-reviewer");
    const author = yield* completeAttempt(
      state,
      store,
      snapshot.id,
      hubId,
      "author",
      1,
      authorThread,
    );
    snapshot = yield* service.command(
      {
        action: "submitCandidate",
        hubId,
        planId: snapshot.id,
        requestId: "candidate-return-downstream",
        expectedStateVersion: snapshot.stateVersion,
        expectedRevision: snapshot.revision,
        stageKey: "draft",
        generation: 1,
        nodeKey: "author",
        attemptId: author.attempt.id,
        deliverableRefs: [
          {
            hubId,
            workerThreadId: authorThread,
            revision: 1,
            commitSha: "a".repeat(40),
            provenance: {
              hubId,
              workerThreadId: authorThread,
              expertBindingSnapshotId: "binding-return-author",
              publishedAt: timestamp,
            },
            file: {
              path: "return-result.md",
              libraryPath: "worker-return-author/1/return-result.md",
              name: "Return result",
              description: null,
              mediaType: "text/markdown",
              sizeBytes: 1,
              sha256: "b".repeat(64),
            },
          },
        ],
        summary: "Current result",
      },
      { kind: "worker", hubId, threadId: authorThread },
    );
    const reviewer = yield* completeAttempt(
      state,
      store,
      snapshot.id,
      hubId,
      "reviewer",
      1,
      reviewerThread,
    );
    snapshot = yield* service.command(
      {
        action: "submitReview",
        hubId,
        planId: snapshot.id,
        requestId: "review-return-downstream",
        expectedStateVersion: snapshot.stateVersion,
        expectedRevision: snapshot.revision,
        stageKey: "draft",
        generation: 1,
        nodeKey: "reviewer",
        attemptId: reviewer.attempt.id,
        candidateId: snapshot.graph.stages[0]!.candidateId!,
        outputDigest: snapshot.graph.stages[0]!.outputDigest!,
        outcome: "pass",
        summary: "Pass",
      },
      { kind: "worker", hubId, threadId: reviewerThread },
    );
    assert.strictEqual(snapshot.graph.stages[0]?.status, "waiting_user");

    const nextAuthor = (yield* store.listBindings({ planId: snapshot.id, revision: 1 })).find(
      (binding) => binding.nodeKey === "next-author",
    );
    assert.isDefined(nextAuthor);
    const queuedWorkId = "work-next-author-queued";
    state.works.set(queuedWorkId, { state: "queued", workerThreadId: null } as HubWorkRecord);
    yield* store.appendAttemptBinding({
      id: "binding-next-author-queued",
      planId: snapshot.id,
      revision: 1,
      nodeKey: "next-author",
      taskId: nextAuthor.taskId,
      attemptId: ProjectTaskAttemptId.makeUnsafe("attempt-next-author-queued"),
      workItemId: queuedWorkId,
      stageGeneration: 1,
      createdAt: timestamp,
    });

    const returned = yield* commandError(
      service.command(
        {
          action: "return",
          hubId,
          planId: snapshot.id,
          requestId: "return-with-downstream-queued-work",
          expectedStateVersion: snapshot.stateVersion,
          expectedRevision: snapshot.revision,
          stageKey: "draft",
          generation: 1,
          candidateId: snapshot.graph.stages[0]!.candidateId!,
          outputDigest: snapshot.graph.stages[0]!.outputDigest!,
          comment: "Retry after queued work settles",
        },
        { kind: "user" },
      ),
    );
    assert.isTrue(returned instanceof HubPlanServiceError);
    assert.strictEqual((returned as HubPlanServiceError).code, "invalid_state");
    assert.strictEqual(snapshot.graph.stages[0]?.generation, 1);
    assert.strictEqual(
      (yield* store.readEvents({ planId: snapshot.id })).some(
        (event) => event.kind === "plan.returned",
      ),
      false,
    );
  }),
);

it.effect("release checks exact digest and completes a fully released plan", () =>
  Effect.gen(function* () {
    const { service, store, state, hubId, sourceMessageId } = makeTestRuntime();
    yield* service.propose(proposeInput(hubId, sourceMessageId, "plan-release"), { kind: "user" });
    let snapshot = yield* service.command(confirmInput(hubId, "plan-release"), { kind: "user" });
    const authorThread = ThreadId.makeUnsafe("worker-author-release");
    const reviewerThread = ThreadId.makeUnsafe("worker-reviewer-release");
    const author = yield* completeAttempt(
      state,
      store,
      snapshot.id,
      hubId,
      "author",
      1,
      authorThread,
    );
    snapshot = yield* service.command(
      {
        action: "submitCandidate",
        hubId,
        planId: snapshot.id,
        requestId: "candidate-release-1",
        expectedStateVersion: snapshot.stateVersion,
        expectedRevision: snapshot.revision,
        stageKey: "draft",
        generation: 1,
        nodeKey: "author",
        attemptId: author.attempt.id,
        deliverableRefs: [
          {
            hubId,
            workerThreadId: authorThread,
            revision: 1,
            commitSha: "c".repeat(40),
            provenance: {
              hubId,
              workerThreadId: authorThread,
              expertBindingSnapshotId: "binding-author",
              publishedAt: timestamp,
            },
            file: {
              path: "result.md",
              libraryPath: "worker-author-release/1/result.md",
              name: "Result",
              description: null,
              mediaType: "text/markdown",
              sizeBytes: 1,
              sha256: "d".repeat(64),
            },
          },
        ],
        summary: "Candidate one",
      },
      { kind: "worker", hubId, threadId: authorThread },
    );
    const reviewer = yield* completeAttempt(
      state,
      store,
      snapshot.id,
      hubId,
      "reviewer",
      1,
      reviewerThread,
    );
    snapshot = yield* service.command(
      {
        action: "submitReview",
        hubId,
        planId: snapshot.id,
        requestId: "review-release-1",
        expectedStateVersion: snapshot.stateVersion,
        expectedRevision: snapshot.revision,
        stageKey: "draft",
        generation: 1,
        nodeKey: "reviewer",
        attemptId: reviewer.attempt.id,
        candidateId: snapshot.graph.stages[0]!.candidateId!,
        outputDigest: snapshot.graph.stages[0]!.outputDigest!,
        outcome: "pass",
        summary: "Pass",
      },
      { kind: "worker", hubId, threadId: reviewerThread },
    );
    const candidateId = snapshot.graph.stages[0]!.candidateId!;
    const digest = snapshot.graph.stages[0]!.outputDigest!;
    const rejected = yield* commandError(
      service.command(
        {
          action: "release",
          hubId,
          planId: snapshot.id,
          requestId: "release-wrong-digest",
          expectedStateVersion: snapshot.stateVersion,
          expectedRevision: snapshot.revision,
          stageKey: "draft",
          generation: 1,
          candidateId,
          outputDigest: "sha256:wrong",
        },
        { kind: "user" },
      ),
    );
    assert.isTrue(rejected instanceof HubPlanServiceError);
    assert.strictEqual((rejected as HubPlanServiceError).code, "stale_candidate");
    const released = yield* service.command(
      {
        action: "release",
        hubId,
        planId: snapshot.id,
        requestId: "release-matching-digest",
        expectedStateVersion: snapshot.stateVersion,
        expectedRevision: snapshot.revision,
        stageKey: "draft",
        generation: 1,
        candidateId,
        outputDigest: digest,
        comment: "Approved for release.",
      },
      { kind: "user" },
    );
    assert.strictEqual(released.controlState, "completed");
    assert.strictEqual(released.graph.releasedCount, 1);
    assert.strictEqual([...state.goals.values()][0]?.status, "completed");
    const releases = yield* store.listReleases({ planId: snapshot.id });
    assert.strictEqual(releases[0]?.comment, "Approved for release.");
    const releasedEvent = (yield* store.readEvents({ planId: snapshot.id })).find(
      (event) => event.kind === "plan.released",
    );
    assert.isDefined(releasedEvent);
    assert.strictEqual(
      (releasedEvent.payload as { readonly comment?: string }).comment,
      "Approved for release.",
    );
  }),
);

it.effect("reconcile alone commits auto release after current Work has settled", () =>
  Effect.gen(function* () {
    const { service, store, state, hubId, sourceMessageId } = makeTestRuntime();
    const planId = "plan-auto-reconcile";
    yield* service.propose(proposeInput(hubId, sourceMessageId, planId, makeDefinition("auto")), {
      kind: "user",
    });
    let snapshot = yield* service.command(confirmInput(hubId, planId), { kind: "user" });
    const authorThread = ThreadId.makeUnsafe("worker-author-auto");
    const reviewerThread = ThreadId.makeUnsafe("worker-reviewer-auto");
    const author = yield* completeAttempt(
      state,
      store,
      snapshot.id,
      hubId,
      "author",
      1,
      authorThread,
    );
    snapshot = yield* service.command(
      {
        action: "submitCandidate",
        hubId,
        planId: snapshot.id,
        requestId: "candidate-auto-1",
        expectedStateVersion: snapshot.stateVersion,
        expectedRevision: snapshot.revision,
        stageKey: "draft",
        generation: 1,
        nodeKey: "author",
        attemptId: author.attempt.id,
        deliverableRefs: [
          {
            hubId,
            workerThreadId: authorThread,
            revision: 1,
            commitSha: "9".repeat(40),
            provenance: {
              hubId,
              workerThreadId: authorThread,
              expertBindingSnapshotId: "auto-author-binding",
              publishedAt: timestamp,
            },
            file: {
              path: "auto-result.md",
              libraryPath: "auto-author/1/auto-result.md",
              name: "Auto result",
              description: null,
              mediaType: "text/markdown",
              sizeBytes: 1,
              sha256: "8".repeat(64),
            },
          },
        ],
        summary: "Auto candidate",
      },
      { kind: "worker", hubId, threadId: authorThread },
    );
    const reviewer = yield* completeAttempt(
      state,
      store,
      snapshot.id,
      hubId,
      "reviewer",
      1,
      reviewerThread,
    );
    snapshot = yield* service.command(
      {
        action: "submitReview",
        hubId,
        planId: snapshot.id,
        requestId: "review-auto-1",
        expectedStateVersion: snapshot.stateVersion,
        expectedRevision: snapshot.revision,
        stageKey: "draft",
        generation: 1,
        nodeKey: "reviewer",
        attemptId: reviewer.attempt.id,
        candidateId: snapshot.graph.stages[0]!.candidateId!,
        outputDigest: snapshot.graph.stages[0]!.outputDigest!,
        outcome: "pass",
        summary: "Pass",
      },
      { kind: "worker", hubId, threadId: reviewerThread },
    );
    assert.strictEqual(snapshot.graph.stages[0]?.status, "ready_to_release");
    assert.strictEqual(snapshot.controlState, "active");
    assert.strictEqual((yield* store.listReleases({ planId })).length, 0);
    const pendingBeforeReconcile = (yield* store.readPending({ planId })).length;

    const reconciled = yield* service.reconcile(hubId);
    assert.isNotNull(reconciled);
    assert.strictEqual(reconciled?.controlState, "completed");
    assert.strictEqual(reconciled?.graph.releasedCount, 1);
    assert.strictEqual((yield* store.listReleases({ planId }))[0]?.source, "auto");
    assert.strictEqual((yield* store.readPending({ planId })).length, pendingBeforeReconcile);
  }),
);

it.effect("auto reconciliation releases an accepted candidate after pause cancels its Work", () =>
  Effect.gen(function* () {
    const { store, state, service, hubId, sourceMessageId } = makeTestRuntime();
    const authorNode = makeDefinition("auto").nodes.find((node) => node.role === "author");
    assert.isDefined(authorNode);
    const definition: HubPlanDefinition = {
      ...makeDefinition("auto"),
      nodes: [authorNode!],
    };
    const planId = "plan-auto-release-after-stop";
    yield* service.propose(proposeInput(hubId, sourceMessageId, planId, definition), {
      kind: "user",
    });
    let snapshot = yield* service.command(confirmInput(hubId, planId), { kind: "user" });
    const authorThread = ThreadId.makeUnsafe("worker-author-auto-after-stop");
    const author = yield* completeAttempt(
      state,
      store,
      snapshot.id,
      hubId,
      "author",
      1,
      authorThread,
    );
    state.tasks.set(author.task.id, { ...author.task, assignedThreadId: authorThread });
    snapshot = yield* service.command(
      {
        action: "submitCandidate",
        hubId,
        planId: snapshot.id,
        requestId: "candidate-auto-after-stop",
        expectedStateVersion: snapshot.stateVersion,
        expectedRevision: snapshot.revision,
        stageKey: "draft",
        generation: 1,
        nodeKey: "author",
        attemptId: author.attempt.id,
        deliverableRefs: [
          {
            hubId,
            workerThreadId: authorThread,
            revision: 1,
            commitSha: "7".repeat(40),
            provenance: {
              hubId,
              workerThreadId: authorThread,
              expertBindingSnapshotId: "auto-after-stop-author-binding",
              publishedAt: timestamp,
            },
            file: {
              path: "auto-after-stop.md",
              libraryPath: "auto-after-stop/1/auto-after-stop.md",
              name: "Auto result",
              description: null,
              mediaType: "text/markdown",
              sizeBytes: 1,
              sha256: "6".repeat(64),
            },
          },
        ],
        summary: "Accepted auto-release candidate",
      },
      { kind: "worker", hubId, threadId: authorThread },
    );
    assert.strictEqual(snapshot.graph.stages[0]?.status, "ready_to_release");

    const pausing = yield* service.command(
      {
        action: "pause",
        hubId,
        planId,
        requestId: "pause-auto-after-acceptance",
        expectedStateVersion: snapshot.stateVersion,
        expectedRevision: snapshot.revision,
      },
      { kind: "user" },
    );
    const current = yield* store.read({ planId });
    assert.isNotNull(current);
    yield* store.savePlan(
      {
        ...current!,
        controlState: "paused",
        stateVersion: pausing.stateVersion + 1,
        updatedAt: timestamp,
      },
      pausing.stateVersion,
    );
    state.works.set("work-author-1", {
      state: "cancelled",
      workerThreadId: authorThread,
    } as HubWorkRecord);
    const paused = yield* service.read({ hubId, planId }, { kind: "user" });
    assert.isNotNull(paused);
    const resumed = yield* service.command(
      {
        action: "resume",
        hubId,
        planId,
        requestId: "resume-auto-after-acceptance",
        expectedStateVersion: paused!.stateVersion,
        expectedRevision: paused!.revision,
      },
      { kind: "user" },
    );
    assert.strictEqual(resumed.controlState, "active");

    const reconciled = yield* service.reconcile(hubId);
    assert.isNotNull(reconciled);
    assert.strictEqual(reconciled?.controlState, "completed");
    assert.strictEqual(reconciled?.graph.releasedCount, 1);
    assert.strictEqual((yield* store.listReleases({ planId }))[0]?.source, "auto");
  }),
);

const sqliteLayer = it.layer(NodeSqliteClient.layerMemory());

sqliteLayer("Hub plan service with SQLite store", (test) => {
  test.effect(
    "persists freeze, idempotency, and review/release summaries across service instances",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations();
        yield* runWorkbenchMigrations();
        const runtime = makeTestRuntime();
        const { hubId, sourceMessageId, state, config } = runtime;
        const projectRoot = `/tmp/${hubId}`;
        yield* sql`
        INSERT INTO projection_projects (
          project_id, title, workspace_root, scripts_json, created_at, updated_at
        ) VALUES (${hubId}, 'Plan integration', ${projectRoot}, '[]', ${timestamp}, ${timestamp})
      `;
        yield* sql`
        INSERT INTO project_agent_configs (
          project_id, coordinator_thread_id, coordinator_name,
          coordinator_model_selection_json, limits_json, capture_enabled,
          enabled, revision, created_at, updated_at, disabled_at
        ) VALUES (
          ${hubId}, ${config.coordinatorThreadId},
          'Coordinator', '{}', '{}', 0, 1, 3, ${timestamp}, ${timestamp}, NULL
        )
      `;

        const store = makeHubPlanStore(sql);
        const native: HubPlanServiceNativeCapabilities = {
          ...runtime.native,
          saveGoal: (goal, expectedRevision) =>
            Effect.gen(function* () {
              const saved = yield* runtime.native.saveGoal(goal, expectedRevision);
              if (expectedRevision === null) {
                yield* sql`
                INSERT INTO project_agent_goals (
                  goal_id, project_id, objective, authorization_source, scope_version,
                  acceptance_criteria, limits_json, status, continuation_count,
                  worker_creation_count, authorized_at, revision, created_at, updated_at
                ) VALUES (
                  ${goal.id}, ${goal.projectId}, ${goal.objective}, ${goal.authorizationSource},
                  ${goal.scopeVersion}, ${goal.acceptanceCriteria}, ${JSON.stringify(goal.limits)},
                  ${goal.status}, ${goal.continuationCount}, ${goal.workerCreationCount},
                  ${goal.authorizedAt}, ${goal.revision}, ${goal.createdAt}, ${goal.updatedAt}
                )
              `;
              } else {
                yield* sql`
                UPDATE project_agent_goals SET status = ${goal.status}, revision = ${goal.revision},
                  updated_at = ${goal.updatedAt}
                WHERE goal_id = ${goal.id} AND revision = ${expectedRevision}
              `;
              }
              return saved;
            }),
          saveTask: (task, expectedRevision) =>
            Effect.gen(function* () {
              const saved = yield* runtime.native.saveTask(task, expectedRevision);
              if (expectedRevision === null) {
                yield* sql`
                INSERT INTO project_agent_tasks (
                  task_id, project_id, goal_id, title, description, acceptance_criteria,
                  status, assigned_thread_id, repair_count, archived_at, revision,
                  created_at, updated_at
                ) VALUES (
                  ${task.id}, ${task.projectId}, ${task.goalId}, ${task.title}, ${task.description},
                  ${task.acceptanceCriteria}, ${task.status}, ${task.assignedThreadId},
                  ${task.repairCount}, ${task.archivedAt}, ${task.revision}, ${task.createdAt}, ${task.updatedAt}
                )
              `;
              } else {
                yield* sql`
                UPDATE project_agent_tasks SET status = ${task.status},
                  assigned_thread_id = ${task.assignedThreadId}, repair_count = ${task.repairCount},
                  revision = ${task.revision}, updated_at = ${task.updatedAt}
                WHERE task_id = ${task.id} AND revision = ${expectedRevision}
              `;
              }
              return saved;
            }),
          saveAttempt: (attempt) =>
            Effect.gen(function* () {
              const saved = yield* runtime.native.saveAttempt(attempt);
              yield* sql`
                UPDATE project_agent_task_attempts
                SET outcome = ${attempt.outcome}, error = ${attempt.error},
                  finished_at = ${attempt.finishedAt}
                WHERE attempt_id = ${attempt.id}
              `;
              return saved;
            }),
          finalizePlanNode: (input) =>
            Effect.gen(function* () {
              const taskBefore = state.tasks.get(input.taskId);
              if (!taskBefore)
                return yield* Effect.fail(new Error("missing task for finalization"));
              yield* runtime.native.finalizePlanNode(input);
              const finalizedTask = state.tasks.get(input.taskId);
              if (!finalizedTask) return yield* Effect.fail(new Error("task finalization failed"));
              yield* sql`
              UPDATE project_agent_tasks SET status = ${finalizedTask.status},
                revision = ${finalizedTask.revision}, updated_at = ${finalizedTask.updatedAt}
              WHERE task_id = ${finalizedTask.id} AND revision = ${taskBefore.revision}
            `;
              yield* sql`
              UPDATE project_agent_task_attempts SET outcome = 'succeeded', finished_at = ${timestamp}
              WHERE attempt_id = ${input.attemptId} AND outcome = 'running'
            `;
            }),
        };
        const service = makeHubPlanService({ store, native });
        yield* service.propose(proposeInput(hubId, sourceMessageId, "plan-sqlite-integration"), {
          kind: "user",
        });
        let snapshot = yield* service.command(confirmInput(hubId, "plan-sqlite-integration"), {
          kind: "user",
        });
        assert.strictEqual(snapshot.controlState, "active");
        const frozenPlan = yield* store.read({ planId: snapshot.id, revision: 1 });
        assert.strictEqual(frozenPlan?.controlState, "active");
        assert.strictEqual(frozenPlan?.configSnapshot.expertSnapshots?.length, 0);

        const startSqliteAttempt = (nodeKey: string, threadId: ThreadId, generation = 1) =>
          Effect.gen(function* () {
            const bindings = yield* store.listBindings({ planId: snapshot.id, revision: 1 });
            const binding = bindings.find((item) => item.nodeKey === nodeKey);
            assert.isDefined(binding);
            const task = state.tasks.get(binding.taskId);
            assert.isDefined(task);
            const runningTask: ProjectTask = {
              ...task,
              status: "running",
              assignedThreadId: threadId,
              revision: task.revision + 1,
              updatedAt: timestamp,
            };
            yield* native.saveTask(runningTask, task.revision);
            const attemptId = ProjectTaskAttemptId.makeUnsafe(
              `sqlite-${nodeKey}-attempt-${generation}`,
            );
            const attempt: ProjectTaskAttempt = {
              id: attemptId,
              projectId: hubId,
              taskId: task.id,
              workerThreadId: threadId,
              gatewayOperationId: null,
              requestId: `sqlite-${nodeKey}-request-${generation}`,
              attemptNumber: generation,
              outcome: "running",
              error: null,
              createdAt: timestamp,
              finishedAt: null,
            };
            state.attempts.set(task.id, [attempt]);
            const workItemId = `sqlite-${nodeKey}-work-${generation}`;
            state.works.set(workItemId, {
              state: "working",
              workerThreadId: threadId,
            } as HubWorkRecord);
            yield* sql`
            INSERT INTO project_agent_task_attempts (
              attempt_id, project_id, task_id, worker_thread_id, gateway_operation_id,
              request_id, attempt_number, outcome, error, created_at, finished_at
            ) VALUES (
              ${attemptId}, ${hubId}, ${task.id}, ${threadId}, NULL,
              ${attempt.requestId}, ${generation}, 'running', NULL, ${timestamp}, NULL
            )
          `;
            yield* sql`
            INSERT INTO project_agent_work_items (
              work_item_id, project_id, scope_key, task_index, state, worker_thread_id,
              slot_held, revision, record_json
            ) VALUES (
              ${workItemId}, ${hubId}, ${workItemId}, 1, 'working', ${threadId}, 1, 1, '{}'
            )
          `;
            yield* store.appendAttemptBinding({
              id: `sqlite-${nodeKey}-binding-${generation}`,
              planId: snapshot.id,
              revision: 1,
              nodeKey,
              taskId: task.id,
              attemptId,
              workItemId,
              stageGeneration: generation,
              createdAt: timestamp,
            });
            return { attempt, workItemId };
          });

        const authorThread = ThreadId.makeUnsafe("sqlite-author-thread");
        const reviewerThread = ThreadId.makeUnsafe("sqlite-reviewer-thread");
        const authorAttemptBinding = yield* startSqliteAttempt("author", authorThread);
        const authorAttempt = authorAttemptBinding.attempt;
        const makeCandidateRefs = (workerThreadId: ThreadId, generation: number) =>
          [
            {
              hubId,
              workerThreadId,
              revision: generation,
              commitSha: "e".repeat(40),
              provenance: {
                hubId,
                workerThreadId,
                expertBindingSnapshotId: `sqlite-author-binding-${generation}`,
                publishedAt: timestamp,
              },
              file: {
                path: "sqlite-result.md",
                libraryPath: `sqlite-author/${generation}/sqlite-result.md`,
                name: "SQLite result",
                description: null,
                mediaType: "text/markdown",
                sizeBytes: 1,
                sha256: "f".repeat(64),
              },
            },
          ] as const;
        const candidateRefs = makeCandidateRefs(authorThread, 1);
        snapshot = yield* service.command(
          {
            action: "submitCandidate",
            hubId,
            planId: snapshot.id,
            requestId: "sqlite-candidate-1",
            expectedStateVersion: snapshot.stateVersion,
            expectedRevision: snapshot.revision,
            stageKey: "draft",
            generation: 1,
            nodeKey: "author",
            attemptId: authorAttempt.id,
            deliverableRefs: candidateRefs,
            summary: "SQLite candidate",
          },
          { kind: "worker", hubId, threadId: authorThread },
        );
        const candidateId = snapshot.graph.stages[0]!.candidateId!;
        assert.deepStrictEqual(snapshot.graph.stages[0]?.deliverableRefs, candidateRefs);
        const candidateStateVersion = snapshot.stateVersion;
        snapshot = yield* service.command(
          {
            action: "submitCandidate",
            hubId,
            planId: snapshot.id,
            requestId: "sqlite-candidate-1-replay",
            expectedStateVersion: candidateStateVersion,
            expectedRevision: snapshot.revision,
            stageKey: "draft",
            generation: 1,
            nodeKey: "author",
            attemptId: authorAttempt.id,
            deliverableRefs: candidateRefs,
            summary: "SQLite candidate",
          },
          { kind: "worker", hubId, threadId: authorThread },
        );
        assert.strictEqual(snapshot.stateVersion, candidateStateVersion);
        assert.strictEqual((yield* store.listCandidates({ planId: snapshot.id })).length, 1);
        assert.strictEqual(state.tasks.get(authorAttempt.taskId)?.status, "done");
        assert.strictEqual(state.attempts.get(authorAttempt.taskId)?.[0]?.outcome, "succeeded");
        assert.strictEqual(state.works.get(authorAttemptBinding.workItemId)?.state, "working");
        assert.strictEqual(snapshot.graph.stages[0]?.status, "reviewing");
        const changedCandidate = yield* commandError(
          service.command(
            {
              action: "submitCandidate",
              hubId,
              planId: snapshot.id,
              requestId: "sqlite-candidate-changed",
              expectedStateVersion: snapshot.stateVersion,
              expectedRevision: snapshot.revision,
              stageKey: "draft",
              generation: 1,
              nodeKey: "author",
              attemptId: authorAttempt.id,
              deliverableRefs: candidateRefs,
              summary: "Different candidate content",
            },
            { kind: "worker", hubId, threadId: authorThread },
          ),
        );
        assert.isTrue(changedCandidate instanceof HubPlanServiceError);
        assert.strictEqual((changedCandidate as HubPlanServiceError).code, "conflict");

        const reviewerAttemptBinding = yield* startSqliteAttempt("reviewer", reviewerThread);
        const reviewerAttempt = reviewerAttemptBinding.attempt;
        const reviewCommand: HubPlanCommandInput = {
          action: "submitReview",
          hubId,
          planId: snapshot.id,
          requestId: "sqlite-review-1",
          expectedStateVersion: snapshot.stateVersion,
          expectedRevision: snapshot.revision,
          stageKey: "draft",
          generation: 1,
          nodeKey: "reviewer",
          attemptId: reviewerAttempt.id,
          candidateId,
          outputDigest: snapshot.graph.stages[0]!.outputDigest!,
          outcome: "pass",
          summary: "Durable review summary",
        };
        snapshot = yield* service.command(reviewCommand, {
          kind: "worker",
          hubId,
          threadId: reviewerThread,
        });
        assert.strictEqual(snapshot.graph.stages[0]?.status, "running");
        const reviewStateVersion = snapshot.stateVersion;
        snapshot = yield* service.command(
          {
            ...reviewCommand,
            requestId: "sqlite-review-1-replay",
            expectedStateVersion: snapshot.stateVersion,
          },
          { kind: "worker", hubId, threadId: reviewerThread },
        );
        assert.strictEqual(snapshot.stateVersion, reviewStateVersion);
        const changedReview = yield* commandError(
          service.command(
            {
              ...reviewCommand,
              requestId: "sqlite-review-changed",
              expectedStateVersion: snapshot.stateVersion,
              summary: "Conflicting review",
            },
            { kind: "worker", hubId, threadId: reviewerThread },
          ),
        );
        assert.isTrue(changedReview instanceof HubPlanServiceError);
        assert.strictEqual((changedReview as HubPlanServiceError).code, "conflict");

        for (const [workItemId, workerThreadId] of [
          [authorAttemptBinding.workItemId, authorThread],
          [reviewerAttemptBinding.workItemId, reviewerThread],
        ] as const) {
          state.works.set(workItemId, { state: "completed", workerThreadId } as HubWorkRecord);
          yield* sql`
          UPDATE project_agent_work_items SET state = 'completed', slot_held = 0, revision = revision + 1
          WHERE work_item_id = ${workItemId}
        `;
        }
        const reconciled = yield* service.reconcile(hubId);
        assert.isNotNull(reconciled);
        assert.strictEqual(reconciled?.graph.stages[0]?.status, "waiting_user");
        const repeatedReconcile = yield* service.reconcile(hubId);
        assert.strictEqual(repeatedReconcile?.stateVersion, reconciled?.stateVersion);
        const awaitingEvents = (yield* store.readEvents({ planId: snapshot.id })).filter(
          (event) => event.kind === "plan.awaiting-release",
        );
        assert.strictEqual(awaitingEvents.length, 1);

        const returnComment = "Durable return comment";
        const returned = yield* service.command(
          {
            action: "return",
            hubId,
            planId: snapshot.id,
            requestId: "sqlite-return-1",
            expectedStateVersion: snapshot.stateVersion,
            expectedRevision: snapshot.revision,
            stageKey: "draft",
            generation: 1,
            candidateId,
            outputDigest: snapshot.graph.stages[0]!.outputDigest!,
            comment: returnComment,
          },
          { kind: "user" },
        );
        assert.strictEqual(returned.graph.stages[0]?.generation, 2);
        const returnedAttemptBinding = yield* startSqliteAttempt(
          "author",
          ThreadId.makeUnsafe("sqlite-author-thread-2"),
          2,
        );
        const secondAuthorThread = returnedAttemptBinding.attempt.workerThreadId;
        snapshot = yield* service.command(
          {
            action: "submitCandidate",
            hubId,
            planId: snapshot.id,
            requestId: "sqlite-candidate-2",
            expectedStateVersion: returned.stateVersion,
            expectedRevision: snapshot.revision,
            stageKey: "draft",
            generation: 2,
            nodeKey: "author",
            attemptId: returnedAttemptBinding.attempt.id,
            deliverableRefs: makeCandidateRefs(secondAuthorThread, 2),
            summary: "SQLite candidate after return",
          },
          { kind: "worker", hubId, threadId: secondAuthorThread },
        );
        const secondCandidateId = snapshot.graph.stages[0]!.candidateId!;
        const secondReviewerThread = ThreadId.makeUnsafe("sqlite-reviewer-thread-2");
        const secondReviewerBinding = yield* startSqliteAttempt(
          "reviewer",
          secondReviewerThread,
          2,
        );
        snapshot = yield* service.command(
          {
            action: "submitReview",
            hubId,
            planId: snapshot.id,
            requestId: "sqlite-review-2",
            expectedStateVersion: snapshot.stateVersion,
            expectedRevision: snapshot.revision,
            stageKey: "draft",
            generation: 2,
            nodeKey: "reviewer",
            attemptId: secondReviewerBinding.attempt.id,
            candidateId: secondCandidateId,
            outputDigest: snapshot.graph.stages[0]!.outputDigest!,
            outcome: "pass",
            summary: "Second generation review",
          },
          { kind: "worker", hubId, threadId: secondReviewerThread },
        );
        for (const [workItemId, workerThreadId] of [
          [returnedAttemptBinding.workItemId, secondAuthorThread],
          [secondReviewerBinding.workItemId, secondReviewerThread],
        ] as const) {
          state.works.set(workItemId, { state: "completed", workerThreadId } as HubWorkRecord);
          yield* sql`
          UPDATE project_agent_work_items SET state = 'completed', slot_held = 0, revision = revision + 1
          WHERE work_item_id = ${workItemId}
        `;
        }
        const secondGenerationReconcile = yield* service.reconcile(hubId);
        assert.strictEqual(secondGenerationReconcile?.graph.stages[0]?.status, "waiting_user");

        const released = yield* service.command(
          {
            action: "release",
            hubId,
            planId: snapshot.id,
            requestId: "sqlite-release-1",
            expectedStateVersion: snapshot.stateVersion,
            expectedRevision: snapshot.revision,
            stageKey: "draft",
            generation: 2,
            candidateId: secondCandidateId,
            outputDigest: snapshot.graph.stages[0]!.outputDigest!,
            comment: "Durable release comment",
          },
          { kind: "user" },
        );
        const restartedService = makeHubPlanService({ store, native });
        const events = yield* restartedService.events(
          { hubId, afterSequence: 0 },
          { kind: "user" },
        );
        const reviewEvent = events.find((event) => event.kind === "plan.review-submitted");
        const releaseEvent = events.find((event) => event.kind === "plan.released");
        const returnEvent = events.find((event) => event.kind === "plan.returned");
        const awaitingReleaseEvent = events.find((event) => event.kind === "plan.awaiting-release");
        assert.strictEqual(
          (reviewEvent?.payload as { readonly summary?: string } | undefined)?.summary,
          "Durable review summary",
        );
        assert.strictEqual(
          (releaseEvent?.payload as { readonly comment?: string } | undefined)?.comment,
          "Durable release comment",
        );
        assert.strictEqual(
          (returnEvent?.payload as { readonly comment?: string } | undefined)?.comment,
          returnComment,
        );
        assert.isDefined(awaitingReleaseEvent);
        assert.strictEqual((yield* store.listReviews({ planId: snapshot.id })).length, 2);
        assert.strictEqual(
          (yield* store.listReleases({ planId: snapshot.id }))[0]?.comment,
          "Durable release comment",
        );
        assert.strictEqual(released.controlState, "completed");
      }),
  );
});
