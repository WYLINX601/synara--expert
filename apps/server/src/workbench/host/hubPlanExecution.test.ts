import { assert, it } from "@effect/vitest";
import {
  DEFAULT_PROJECT_AGENT_LIMITS,
  MessageId,
  ProjectId,
  ProjectTaskAttemptId,
  ProjectTaskId,
  type OrchestrationThreadShell,
  type HubPlanCommandInput,
  SynaraResolvedCreateThreadSpec,
  ThreadId,
} from "@synara/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { HubWorkRepository } from "../../persistence/Services/HubWorkRepository.ts";
import { HubWorkRepositoryLive } from "../../persistence/Layers/HubWorkRepository.ts";
import { ProjectAgentRepository } from "../../persistence/Services/ProjectAgentRepository.ts";
import { ProjectAgentRepositoryLive } from "../../persistence/Layers/ProjectAgentRepository.ts";
import { runMigrations } from "../../persistence/Migrations.ts";
import * as NodeSqliteClient from "../../persistence/NodeSqliteClient.ts";
import { makeHubPlanService } from "../../hubCollaboration/HubPlanService.ts";
import {
  matchesHubPlanInputResponseStart,
  type HubPlanInputResponseAuthorization,
  type HubPlanInputResponseTurnStart,
} from "../../hubCollaboration/hubPlanInput.ts";
import {
  makeHubPlanStore,
  type HubPlanAttemptBinding,
} from "../../hubCollaboration/HubPlanStore.ts";
import { makeHubPlanExecution, type HubPlanInputResponseDispatch } from "./hubPlanExecution.ts";
import { makeHubPlanNodeFinalizer } from "./hubPlanService.ts";
import { runWorkbenchMigrations } from "../persistence/WorkbenchMigrations.ts";
import { resolveHubWorkLifecycle } from "../../projectAgent/hubWorkLifecycle.ts";

const tests = it.layer(
  Layer.mergeAll(HubWorkRepositoryLive, ProjectAgentRepositoryLive).pipe(
    Layer.provideMerge(NodeSqliteClient.layerMemory()),
  ),
);

const now = "2026-10-22T10:00:00.000Z";
const definition = {
  objective: "Produce a reviewed result",
  scope: "One bounded work package",
  stages: [{ key: "draft", title: "Draft", releasePolicy: "user" }],
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
  maxRepairRounds: 1,
} as const;

tests("Hub plan execution", (test) => {
  test.effect(
    "simulates provider attempts across confirmation, settlement, review, and release",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const native = yield* ProjectAgentRepository;
        const work = yield* HubWorkRepository;
        yield* runMigrations();
        yield* runWorkbenchMigrations();

        const hubId = ProjectId.makeUnsafe("hub-plan-execution-integration");
        const coordinatorThreadId = ThreadId.makeUnsafe("hub-plan-execution-coordinator");
        const sourceMessageId = MessageId.makeUnsafe("hub-plan-execution-source");
        yield* sql`
        INSERT INTO projection_projects (
          project_id, title, workspace_root, scripts_json, created_at, updated_at
        ) VALUES (${hubId}, 'Plan Hub', '/tmp/plan-hub', '[]', ${now}, ${now})
      `;
        yield* native.saveConfig(
          {
            projectId: hubId,
            coordinatorThreadId,
            coordinatorName: "Coordinator",
            coordinatorModelSelection: {
              provider: "codex",
              instanceId: "codex",
              model: "gpt-6.1-sol",
            },
            limits: { ...DEFAULT_PROJECT_AGENT_LIMITS },
            captureEnabled: false,
            enabled: true,
            automationId: null,
            revision: 1,
            createdAt: now,
            updatedAt: now,
            disabledAt: null,
            expertIds: [],
            collaboration: { schemaVersion: 1, mode: "standard" },
          },
          null,
        );

        const store = makeHubPlanStore(sql);
        const requireConfig = (projectId: ProjectId) =>
          native.getConfig(projectId).pipe(
            Effect.flatMap(
              Option.match({
                onNone: () => Effect.fail(new Error("missing config")),
                onSome: Effect.succeed,
              }),
            ),
          );
        const service = makeHubPlanService({
          store,
          native: {
            readConfig: requireConfig,
            getActiveGoal: (projectId) =>
              native.getActiveGoal(projectId).pipe(Effect.map(Option.getOrNull)),
            getGoal: (goalId) => native.getGoal(goalId).pipe(Effect.map(Option.getOrNull)),
            getTask: (taskId) => native.getTask(taskId).pipe(Effect.map(Option.getOrNull)),
            readTasks: (goalId) =>
              Effect.gen(function* () {
                const goal = yield* native.getGoal(goalId);
                if (Option.isNone(goal)) return [];
                return yield* native.listTasks({
                  projectId: goal.value.projectId,
                  goalId,
                  includeArchived: true,
                  limit: 128,
                });
              }),
            saveGoal: native.saveGoal,
            saveTask: native.saveTask,
            listAttempts: native.listAttemptsForTask,
            saveAttempt: native.saveAttempt,
            readManagedWorkerByThread: (threadId) =>
              native.findManagedWorkerByThread(threadId).pipe(Effect.map(Option.getOrNull)),
            readWork: work.get,
            finalizePlanNode: makeHubPlanNodeFinalizer({
              store,
              projectAgentRepository: native,
              workRepository: work,
            }),
            readSourceMessages: (projectId, ids) =>
              Effect.gen(function* () {
                const config = yield* requireConfig(projectId);
                return ids.map((messageId) => ({
                  threadId: config.coordinatorThreadId,
                  messageId,
                  turnId: null,
                  text: "Please complete the confirmed work package.",
                  attachments: [],
                  createdAt: now,
                  updatedAt: now,
                }));
              }),
            freezeExperts: (expertIds) =>
              Effect.succeed(
                expertIds.map((expertId) => ({
                  expertId,
                  snapshotId: `snapshot-${expertId}`,
                  revision: 1,
                })),
              ),
            validateDeliverables: () => Effect.void,
          },
        });

        const draft = yield* service.propose(
          {
            hubId,
            requestId: "propose-integration-plan",
            planId: "integration-plan",
            expectedStateVersion: null,
            definition: {
              ...definition,
              stages: [
                ...definition.stages,
                { key: "delivery", title: "Delivery", releasePolicy: "user" },
              ],
              nodes: [
                ...definition.nodes,
                {
                  ...definition.nodes[0],
                  key: "delivery-author",
                  stageKey: "delivery",
                  title: "Use the reviewed result",
                  dependsOnNodeKeys: ["reviewer"],
                },
              ],
            },
            sourceMessageIds: [sourceMessageId],
          },
          { kind: "user" },
        );
        const confirmed = yield* service.command(
          {
            action: "confirm",
            hubId,
            planId: draft.id,
            requestId: "confirm-integration-plan",
            expectedStateVersion: draft.stateVersion,
            expectedRevision: draft.revision,
          },
          { kind: "user" },
        );
        const confirmedAuthor = confirmed.nodeStates.find((node) => node.nodeKey === "author");
        assert.isDefined(confirmedAuthor);
        const bindings = yield* store.listBindings({
          planId: confirmed.id,
          revision: confirmed.revision,
        });
        const confirmedBinding = bindings.find((binding) => binding.nodeKey === "author");
        assert.isDefined(confirmedBinding);
        assert.strictEqual(confirmedBinding.taskId, confirmedAuthor.taskId);
        const taskCountBeforeDispatch = (yield* native.listTasks({
          projectId: hubId,
          ...(confirmed.goalId === null ? {} : { goalId: confirmed.goalId }),
          includeArchived: true,
          limit: 128,
        })).length;

        let snapshotReads = 0;
        let injectSnapshotFailure = true;
        let hasPendingInputApproval = false;
        let crashAfterAcceptedInputDispatch = false;
        const acceptedInputResponseCommands = new Map<string, string>();
        const inputResponseDispatches: HubPlanInputResponseDispatch[] = [];
        const runningWorkers = new Set<string>();
        const workerRunningReads: string[] = [];
        const makeExecution = (failAfterEnqueue: boolean) => {
          snapshotReads = 0;
          return makeHubPlanExecution({
            sql,
            projectAgentRepository: native,
            workRepository: work,
            resolveCreationSpec: ({ spec, targetProjectId }) =>
              Effect.try({
                try: () =>
                  Schema.decodeUnknownSync(SynaraResolvedCreateThreadSpec)({
                    ...spec,
                    target: spec.target!,
                    projectId: targetProjectId,
                  }),
                catch: (cause) => cause,
              }),
            readSourceMessages: (input) =>
              Effect.succeed(
                input.sourceMessageIds.map((messageId) => ({
                  threadId: coordinatorThreadId,
                  messageId: MessageId.makeUnsafe(messageId),
                  turnId: null,
                  text: "Please complete the confirmed work package.",
                  attachments: [],
                  createdAt: now,
                  updatedAt: now,
                })),
              ),
            readExpertSnapshot: async (snapshotId) => {
              throw new Error(`Unexpected Expert snapshot ${snapshotId}`);
            },
            readExpert: async () => null,
            interruptWorker: (threadId) => Effect.sync(() => void runningWorkers.delete(threadId)),
            readWorkerRunning: (threadId) =>
              Effect.sync(() => {
                workerRunningReads.push(threadId);
                return runningWorkers.has(threadId);
              }),
            readInputResponseDispatchState: (threadId) =>
              Effect.succeed({
                hasActiveTurn: runningWorkers.has(threadId),
                hasPendingApprovals: hasPendingInputApproval,
                hasPendingUserInput: false,
                archived: false,
                runtimeMode: "full-access",
                interactionMode: "default",
                modelSelection: {
                  provider: "codex",
                  instanceId: "codex",
                  model: "gpt-6.1-sol",
                },
              }),
            inputResponseWasAccepted: ({ threadId, commandId }) =>
              Effect.succeed(acceptedInputResponseCommands.get(commandId) === threadId),
            dispatchInputResponse: (input) =>
              Effect.gen(function* () {
                inputResponseDispatches.push(input);
                const admission = yield* work.reserveWorker({
                  threadId: input.threadId,
                  commandId: input.commandId,
                  messageId: input.messageId,
                });
                if (!admission)
                  throw new Error("Input response could not reserve its worker slot.");
                acceptedInputResponseCommands.set(input.commandId, input.threadId);
                if (crashAfterAcceptedInputDispatch) {
                  crashAfterAcceptedInputDispatch = false;
                  return yield* Effect.fail(
                    new Error("simulated crash after native command acceptance"),
                  );
                }
                return "accepted" as const;
              }),
            readPlanSnapshot: (input) =>
              Effect.gen(function* () {
                snapshotReads += 1;
                if (failAfterEnqueue && injectSnapshotFailure && snapshotReads === 3) {
                  injectSnapshotFailure = false;
                  return yield* Effect.fail(new Error("simulated event snapshot failure"));
                }
                return yield* service.read(input, { kind: "user" });
              }),
            reconcilePlanSnapshot: (currentHubId) => service.reconcile(currentHubId),
          });
        };
        const trackManagedWorker = (input: {
          readonly threadId: ThreadId;
          readonly workItemId: string;
          readonly taskId: ProjectTaskId;
          readonly title: string;
        }) =>
          native.upsertManagedWorker({
            projectId: hubId,
            threadId: input.threadId,
            batchId: "plan-execution-test-batch",
            requestId: input.workItemId,
            title: input.title,
            taskId: input.taskId,
            settledAt: null,
            settleOutcome: null,
            waitingSince: null,
            stuckKind: null,
            stuckSince: null,
            taskPrompt: input.title,
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
            createdAt: now,
            updatedAt: now,
          });
        const settleNativeTurn = (input: {
          readonly workItemId: string;
          readonly threadId: ThreadId;
        }) =>
          Effect.gen(function* () {
            const record = yield* work.get(input.workItemId);
            if (!record) throw new Error("Work disappeared before native settlement.");
            const managedWorker = yield* native.findManagedWorkerByThread(input.threadId);
            if (Option.isNone(managedWorker)) {
              throw new Error("Managed worker disappeared before native settlement.");
            }
            if (managedWorker.value.resultAt === null) {
              throw new Error("Accepted structured result was not durably written.");
            }
            const settledAt = new Date().toISOString();
            const settledWorker = yield* native.upsertManagedWorker({
              ...managedWorker.value,
              settledAt,
              settleOutcome: "completed",
              updatedAt: settledAt,
            });
            const shell = {
              id: input.threadId,
              archivedAt: null,
              hasPendingApprovals: false,
              hasPendingUserInput: false,
              session: { status: "idle", activeTurnId: null, updatedAt: settledAt },
              latestTurn: {
                turnId: ThreadId.makeUnsafe("simulated-native-turn"),
                state: "completed",
                requestedAt: record.admittedAt ?? record.createdAt,
                startedAt: record.admittedAt ?? record.createdAt,
                completedAt: settledAt,
                assistantMessageId: null,
              },
            } as unknown as OrchestrationThreadShell;
            const lifecycle = resolveHubWorkLifecycle({
              record,
              shell,
              worker: settledWorker,
              hasPendingTurn: false,
              admissionMessage: null,
            });
            assert.strictEqual(lifecycle?.state, "completed");
            return yield* work.save({
              record: {
                ...record,
                ...lifecycle,
                revision: record.revision + 1,
                updatedAt: settledAt,
              },
              expectedRevision: record.revision,
            });
          });
        const startBoundAttempt = (input: {
          readonly binding: HubPlanAttemptBinding;
          readonly threadId: string;
          readonly title: string;
          readonly attemptNumber: number;
        }) =>
          Effect.gen(function* () {
            const queued = yield* work.get(input.binding.workItemId);
            if (!queued) throw new Error("Bound plan work disappeared before claim.");
            const claimed = yield* work.claimNext(hubId, queued.id);
            if (!claimed) throw new Error("Bound plan work could not be claimed.");
            const threadId = ThreadId.makeUnsafe(input.threadId);
            runningWorkers.add(threadId);
            const working = yield* work.save({
              record: {
                ...claimed,
                workerThreadId: threadId,
                state: "working",
                revision: claimed.revision + 1,
                updatedAt: now,
              },
              expectedRevision: claimed.revision,
            });
            const taskOption = yield* native.getTask(
              ProjectTaskId.makeUnsafe(input.binding.taskId),
            );
            if (Option.isNone(taskOption)) throw new Error("Bound plan task disappeared.");
            yield* native.saveTask(
              {
                ...taskOption.value,
                status: "running",
                assignedThreadId: threadId,
                revision: taskOption.value.revision + 1,
                updatedAt: now,
              },
              taskOption.value.revision,
            );
            yield* native.saveAttempt({
              id: ProjectTaskAttemptId.makeUnsafe(input.binding.attemptId),
              projectId: hubId,
              taskId: taskOption.value.id,
              workerThreadId: threadId,
              gatewayOperationId: working.id,
              requestId: `${working.id}:attempt:${threadId}`,
              attemptNumber: input.attemptNumber,
              outcome: "running",
              error: null,
              createdAt: now,
              finishedAt: null,
            });
            yield* trackManagedWorker({
              threadId,
              workItemId: working.id,
              taskId: taskOption.value.id,
              title: input.title,
            });
            return { threadId, work: working, task: taskOption.value };
          });

        const failedExecution = makeExecution(true);
        const failedDrain = yield* Effect.exit(failedExecution.drain(hubId));
        assert.isTrue(Exit.isFailure(failedDrain));
        assert.strictEqual((yield* work.list(hubId)).length, 0);
        assert.strictEqual((yield* store.listAttemptBindings({ planId: confirmed.id })).length, 0);
        assert.strictEqual((yield* store.readPending({ planId: confirmed.id })).length, 1);
        assert.strictEqual(
          (yield* native.listTasks({
            projectId: hubId,
            ...(confirmed.goalId === null ? {} : { goalId: confirmed.goalId }),
            includeArchived: true,
            limit: 128,
          })).length,
          taskCountBeforeDispatch,
        );

        yield* makeExecution(false).drain(hubId);
        const dispatched = yield* work.list(hubId);
        assert.strictEqual(dispatched.length, 1);
        assert.strictEqual(dispatched[0]?.state, "queued");
        const attemptBindings = yield* store.listAttemptBindings({ planId: confirmed.id });
        assert.strictEqual(attemptBindings.length, 1);
        assert.strictEqual(attemptBindings[0]?.taskId, confirmedAuthor.taskId);
        assert.strictEqual(attemptBindings[0]?.workItemId, dispatched[0]?.id);
        assert.strictEqual((yield* store.readPending({ planId: confirmed.id })).length, 0);
        const events = yield* store.readEvents({ planId: confirmed.id });
        assert.isTrue(events.some((event) => event.kind === "plan.node.queued"));
        assert.strictEqual(
          (yield* native.listTasks({
            projectId: hubId,
            ...(confirmed.goalId === null ? {} : { goalId: confirmed.goalId }),
            includeArchived: true,
            limit: 128,
          })).length,
          taskCountBeforeDispatch,
        );

        const initialWork = dispatched[0]!;
        const firstBinding = attemptBindings[0]!;
        const authorPrompt = initialWork.creationSpec.prompt;
        const canonicalAttemptIdentity = JSON.stringify({
          attemptId: firstBinding.attemptId,
          generation: firstBinding.stageGeneration,
          hubId,
          nodeKey: "author",
          planId: confirmed.id,
          stageKey: "draft",
        });
        assert.include(
          authorPrompt,
          `Plan attempt identity (canonical JSON; copy these property names exactly): ${canonicalAttemptIdentity}.`,
        );
        assert.include(authorPrompt, "Use `generation`, never `stageGeneration`.");
        assert.include(
          authorPrompt,
          "call synara_hub_list_plans with this hubId and verify that the plan revision, stateVersion, generation, nodeKey, and attemptId still match this assignment",
        );
        assert.include(
          authorPrompt,
          "Required fields are action, hubId, planId, requestId, expectedStateVersion, expectedRevision, stageKey, generation, nodeKey, attemptId, summary, and deliverableRefs",
        );
        assert.include(authorPrompt, "omitting only content");
        assert.include(
          authorPrompt,
          "Preserve every returned nested file field, including path, libraryPath, currentLibraryPath, libraryState, name, description, mediaType, sizeBytes, and sha256",
        );
        const starting = yield* work.claimNext(hubId, initialWork.id);
        assert.isNotNull(starting);
        const firstWorkerThreadId = ThreadId.makeUnsafe("hub-plan-execution-worker-first");
        runningWorkers.add(firstWorkerThreadId);
        const working = yield* work.save({
          record: {
            ...starting,
            workerThreadId: firstWorkerThreadId,
            state: "working",
            revision: starting.revision + 1,
            updatedAt: now,
          },
          expectedRevision: starting.revision,
        });
        const taskOption = yield* native.getTask(ProjectTaskId.makeUnsafe(firstBinding.taskId));
        if (Option.isNone(taskOption)) throw new Error("Confirmed native task disappeared.");
        const firstTask = taskOption.value;
        yield* native.saveTask(
          {
            ...firstTask,
            status: "running",
            assignedThreadId: firstWorkerThreadId,
            revision: firstTask.revision + 1,
            updatedAt: now,
          },
          firstTask.revision,
        );
        yield* native.saveAttempt({
          id: ProjectTaskAttemptId.makeUnsafe(firstBinding.attemptId),
          projectId: hubId,
          taskId: firstTask.id,
          workerThreadId: firstWorkerThreadId,
          gatewayOperationId: working.id,
          requestId: `${working.id}:attempt:${firstWorkerThreadId}`,
          attemptNumber: 1,
          outcome: "running",
          error: null,
          createdAt: now,
          finishedAt: null,
        });
        yield* trackManagedWorker({
          threadId: firstWorkerThreadId,
          workItemId: working.id,
          taskId: firstTask.id,
          title: "Author",
        });

        // The provider turn ended without a candidate, but native Work still
        // owns an unfinished running Task/Attempt. This settled idle lease must
        // be checked during pause and closed through the normal stop path so
        // resume can admit one fresh plan attempt.
        yield* work.save({
          record: {
            ...working,
            state: "idle",
            slotHeld: false,
            admittedAt: null,
            admissionCommandId: null,
            admissionMessageId: null,
            admissionPreviousState: null,
            admissionPreviousSlotHeld: false,
            revision: working.revision + 1,
            updatedAt: now,
          },
          expectedRevision: working.revision,
        });
        runningWorkers.delete(firstWorkerThreadId);

        const beforePause = yield* service.read({ hubId, planId: confirmed.id }, { kind: "user" });
        if (!beforePause) throw new Error("Confirmed plan disappeared before pause.");
        const pausing = yield* service.command(
          {
            action: "pause",
            hubId,
            planId: confirmed.id,
            requestId: "pause-integration-plan",
            expectedStateVersion: beforePause.stateVersion,
            expectedRevision: beforePause.revision,
          },
          { kind: "user" },
        );
        assert.strictEqual(pausing.controlState, "pausing");
        const workerReadsBeforePause = workerRunningReads.length;
        yield* makeExecution(false).drain(hubId);
        assert.include(
          workerRunningReads.slice(workerReadsBeforePause),
          firstWorkerThreadId,
          "an idle unheld Worker is still checked against native running state before stop",
        );
        const paused = yield* service.read({ hubId, planId: confirmed.id }, { kind: "user" });
        if (!paused) throw new Error("Paused plan disappeared before resume.");
        assert.strictEqual(paused.controlState, "paused");
        assert.strictEqual((yield* work.get(initialWork.id))?.state, "cancelled");
        const pausedTask = yield* native.getTask(firstTask.id);
        if (Option.isNone(pausedTask)) throw new Error("Paused native task disappeared.");
        assert.strictEqual(pausedTask.value.status, "ready");
        assert.isNull(pausedTask.value.assignedThreadId);
        const pausedAttempts = yield* native.listAttemptsForTask(firstTask.id);
        assert.strictEqual(pausedAttempts.length, 1);
        assert.strictEqual(pausedAttempts[0]?.outcome, "interrupted");

        const resumed = yield* service.command(
          {
            action: "resume",
            hubId,
            planId: confirmed.id,
            requestId: "resume-integration-plan",
            expectedStateVersion: paused.stateVersion,
            expectedRevision: paused.revision,
          },
          { kind: "user" },
        );
        assert.strictEqual(resumed.controlState, "active");
        yield* makeExecution(false).drain(hubId);
        const resumedWorks = yield* work.list(hubId);
        const retriedWork = resumedWorks.find((candidate) => candidate.id !== initialWork.id);
        if (!retriedWork) throw new Error("Resume did not queue a new plan attempt.");
        assert.strictEqual(retriedWork.state, "queued");
        assert.notStrictEqual(retriedWork.id, initialWork.id);
        const allBindings = yield* store.listAttemptBindings({ planId: confirmed.id });
        const retriedBinding = allBindings.find((binding) => binding.workItemId === retriedWork.id);
        assert.isDefined(retriedBinding);
        assert.strictEqual(retriedBinding.taskId, firstTask.id);
        assert.notStrictEqual(retriedBinding.attemptId, firstBinding.attemptId);
        assert.strictEqual(allBindings.length, 2);
        yield* makeExecution(false).drain(hubId);
        assert.strictEqual((yield* work.list(hubId)).length, 2);
        assert.strictEqual(
          (yield* store.listAttemptBindings({ planId: confirmed.id })).length,
          2,
          "replaying the resume drain does not duplicate the newly admitted attempt",
        );
        assert.strictEqual(
          (yield* native.listTasks({
            projectId: hubId,
            ...(confirmed.goalId === null ? {} : { goalId: confirmed.goalId }),
            includeArchived: true,
            limit: 128,
          })).length,
          taskCountBeforeDispatch,
        );
        const staleWorkAuthority = yield* Effect.exit(
          makeExecution(false).assertWorkAllowed(initialWork),
        );
        assert.isTrue(Exit.isFailure(staleWorkAuthority));
        const staleThreadAuthority = yield* Effect.exit(
          makeExecution(false).assertThreadAllowed(firstWorkerThreadId),
        );
        assert.isTrue(Exit.isFailure(staleThreadAuthority));

        const resumedStart = yield* work.claimNext(hubId, retriedWork.id);
        assert.isNotNull(resumedStart);
        const resumedAuthorThread = ThreadId.makeUnsafe("hub-plan-execution-worker-resumed");
        runningWorkers.add(resumedAuthorThread);
        const resumedWorking = yield* work.save({
          record: {
            ...resumedStart,
            workerThreadId: resumedAuthorThread,
            state: "working",
            revision: resumedStart.revision + 1,
            updatedAt: now,
          },
          expectedRevision: resumedStart.revision,
        });
        const resumedAuthorTask = yield* native.getTask(firstTask.id);
        if (Option.isNone(resumedAuthorTask)) throw new Error("Resumed author task disappeared.");
        yield* native.saveTask(
          {
            ...resumedAuthorTask.value,
            status: "running",
            assignedThreadId: resumedAuthorThread,
            revision: resumedAuthorTask.value.revision + 1,
            updatedAt: now,
          },
          resumedAuthorTask.value.revision,
        );
        yield* native.saveAttempt({
          id: ProjectTaskAttemptId.makeUnsafe(retriedBinding.attemptId),
          projectId: hubId,
          taskId: firstTask.id,
          workerThreadId: resumedAuthorThread,
          gatewayOperationId: resumedWorking.id,
          requestId: `${resumedWorking.id}:attempt:${resumedAuthorThread}`,
          attemptNumber: 2,
          outcome: "running",
          error: null,
          createdAt: now,
          finishedAt: null,
        });
        yield* trackManagedWorker({
          threadId: resumedAuthorThread,
          workItemId: resumedWorking.id,
          taskId: firstTask.id,
          title: "Author",
        });

        const beforeCandidate = yield* service.read(
          { hubId, planId: confirmed.id },
          { kind: "user" },
        );
        if (!beforeCandidate)
          throw new Error("Active plan disappeared before candidate submission.");
        const inputAsked = yield* service.command(
          {
            action: "requestInput",
            hubId,
            planId: confirmed.id,
            requestId: "resumed-author-directed-question-command",
            expectedStateVersion: beforeCandidate.stateVersion,
            expectedRevision: beforeCandidate.revision,
            inputRequestId: "resumed-author-directed-question",
            nodeKey: "author",
            stageKey: "draft",
            generation: retriedBinding.stageGeneration,
            attemptId: ProjectTaskAttemptId.makeUnsafe(retriedBinding.attemptId),
            questions: [
              { title: "Which format should the result use?", options: ["Markdown", "PDF"] },
            ],
          },
          { kind: "worker", hubId, threadId: resumedAuthorThread },
        );
        assert.strictEqual(inputAsked.inputRequests?.[0]?.status, "pending");
        runningWorkers.delete(resumedAuthorThread);
        hasPendingInputApproval = true;
        const inputWaitingDrain = yield* Effect.exit(makeExecution(false).drain(hubId));
        assert.isTrue(Exit.isSuccess(inputWaitingDrain));
        assert.strictEqual(inputResponseDispatches.length, 0);
        assert.strictEqual(
          (yield* store.readInputRequest({
            planId: confirmed.id,
            requestId: "resumed-author-directed-question",
          }))?.status,
          "pending",
        );
        const beforeInputAnswer = yield* service.read(
          { hubId, planId: confirmed.id },
          { kind: "user" },
        );
        if (!beforeInputAnswer) throw new Error("Plan disappeared while waiting for input.");

        const inputAnswered = yield* service.command(
          {
            action: "respondInput",
            hubId,
            planId: confirmed.id,
            requestId: "owner-answer-resumed-author-directed-question",
            expectedStateVersion: beforeInputAnswer.stateVersion,
            expectedRevision: beforeInputAnswer.revision,
            inputRequestId: "resumed-author-directed-question",
            answers: ["Markdown"],
          },
          { kind: "user" },
        );
        assert.strictEqual(inputAnswered.inputRequests?.[0]?.status, "answered");
        hasPendingInputApproval = true;
        yield* makeExecution(false).drain(hubId);
        assert.strictEqual(inputResponseDispatches.length, 0);
        assert.strictEqual(
          (yield* store.readPending({ planId: confirmed.id })).filter(
            (item) => item.kind === "plan.input-response",
          ).length,
          1,
        );

        hasPendingInputApproval = false;
        crashAfterAcceptedInputDispatch = true;
        const acceptedButUnrecorded = yield* Effect.exit(makeExecution(false).drain(hubId));
        assert.isTrue(Exit.isFailure(acceptedButUnrecorded));
        assert.strictEqual(inputResponseDispatches.length, 1);
        const acceptedResponse = inputResponseDispatches[0];
        assert.isDefined(acceptedResponse);
        assert.include(acceptedResponse.messageText, "Markdown");
        assert.include(acceptedResponse.messageText, "do not grant filesystem");
        assert.strictEqual(acceptedResponse.runtimeMode, "full-access");
        assert.strictEqual(acceptedResponse.interactionMode, "default");
        assert.deepStrictEqual(acceptedResponse.modelSelection, {
          provider: "codex",
          instanceId: "codex",
          model: "gpt-6.1-sol",
        });
        assert.strictEqual(
          (yield* store.readInputRequest({
            planId: confirmed.id,
            requestId: "resumed-author-directed-question",
          }))?.status,
          "answered",
        );
        yield* makeExecution(false).drain(hubId);
        const deliveredInputRequest = yield* store.readInputRequest({
          planId: confirmed.id,
          requestId: "resumed-author-directed-question",
        });
        if (!deliveredInputRequest) throw new Error("Delivered input request disappeared.");
        assert.strictEqual(deliveredInputRequest.status, "delivered");
        const deliveredAdmission = yield* work.get(retriedWork.id);
        assert.isNotNull(deliveredAdmission);
        const actualStart: HubPlanInputResponseTurnStart = {
          commandId: acceptedResponse.commandId,
          messageId: acceptedResponse.messageId,
          messageText: acceptedResponse.messageText,
          runtimeMode: acceptedResponse.runtimeMode,
          interactionMode: acceptedResponse.interactionMode,
          modelSelection: acceptedResponse.modelSelection,
          enableComputerControl: false,
          computerControlMode: "off",
          computerControlGeneration: 0,
          assistantDeliveryMode: "streaming",
          dispatchMode: "queue",
          dispatchOrigin: "user",
          createdAt: acceptedResponse.createdAt,
        };
        assert.isTrue(
          matchesHubPlanInputResponseStart({
            request: deliveredInputRequest as HubPlanInputResponseAuthorization,
            turnStart: actualStart,
            work: deliveredAdmission,
          }),
          "the actual provider start must remain authorized after accepted delivery updates updatedAt",
        );
        runningWorkers.add(resumedAuthorThread);
        yield* work.save({
          record: {
            ...deliveredAdmission,
            state: "working",
            revision: deliveredAdmission.revision + 1,
            updatedAt: now,
          },
          expectedRevision: deliveredAdmission.revision,
        });
        const beforeCandidateSubmission = yield* service.read(
          { hubId, planId: confirmed.id },
          { kind: "user" },
        );
        if (!beforeCandidateSubmission)
          throw new Error("Plan disappeared after its directed input response.");
        const candidate = yield* service.command(
          {
            action: "submitCandidate",
            hubId,
            planId: confirmed.id,
            requestId: "submit-resumed-author-candidate",
            expectedStateVersion: beforeCandidateSubmission.stateVersion,
            expectedRevision: beforeCandidateSubmission.revision,
            stageKey: "draft",
            generation: 1,
            nodeKey: "author",
            attemptId: retriedBinding.attemptId as ProjectTaskAttemptId,
            deliverableRefs: [
              {
                hubId,
                workerThreadId: resumedAuthorThread,
                revision: 1,
                commitSha: "a".repeat(40),
                provenance: {
                  hubId,
                  workerThreadId: resumedAuthorThread,
                  expertBindingSnapshotId: "binding-resumed-author",
                  publishedAt: now,
                },
                file: {
                  path: "result.md",
                  libraryPath: "worker-resumed/1/result.md",
                  name: "Result",
                  description: null,
                  mediaType: "text/markdown",
                  sizeBytes: 1,
                  sha256: "b".repeat(64),
                },
              },
            ],
            summary: "Candidate from resumed author attempt",
          },
          { kind: "worker", hubId, threadId: resumedAuthorThread },
        );
        const authorAfterSubmission = yield* native.getTask(firstTask.id);
        if (Option.isNone(authorAfterSubmission))
          throw new Error("Author task disappeared after candidate submission.");
        assert.strictEqual(authorAfterSubmission.value.status, "done");
        assert.strictEqual((yield* work.get(retriedWork.id))?.state, "working");
        assert.strictEqual(candidate.graph.stages[0]?.status, "reviewing");
        const acceptedAuthorWorker = yield* native.findManagedWorkerByThread(resumedAuthorThread);
        if (Option.isNone(acceptedAuthorWorker))
          throw new Error("Accepted author managed worker disappeared.");
        assert.strictEqual(
          acceptedAuthorWorker.value.resultSummary,
          "Candidate from resumed author attempt",
        );
        assert.isNotNull(acceptedAuthorWorker.value.resultAt);

        yield* makeExecution(false).drain(hubId);
        assert.strictEqual(inputResponseDispatches.length, 1);
        assert.strictEqual(
          (yield* store.readInputRequest({
            planId: confirmed.id,
            requestId: "resumed-author-directed-question",
          }))?.status,
          "delivered",
        );

        const beforeAcceptedPause = yield* service.read(
          { hubId, planId: confirmed.id },
          { kind: "user" },
        );
        if (!beforeAcceptedPause) throw new Error("Accepted plan disappeared before pause.");
        yield* service.command(
          {
            action: "pause",
            hubId,
            planId: confirmed.id,
            requestId: "pause-after-author-candidate",
            expectedStateVersion: beforeAcceptedPause.stateVersion,
            expectedRevision: beforeAcceptedPause.revision,
          },
          { kind: "user" },
        );
        yield* makeExecution(false).drain(hubId);
        const pausedAfterCandidate = yield* service.read(
          { hubId, planId: confirmed.id },
          { kind: "user" },
        );
        if (!pausedAfterCandidate) throw new Error("Accepted plan disappeared after pause.");
        assert.strictEqual(pausedAfterCandidate.controlState, "paused");
        assert.strictEqual((yield* work.get(retriedWork.id))?.state, "cancelled");
        const preservedAuthorTask = yield* native.getTask(firstTask.id);
        if (Option.isNone(preservedAuthorTask))
          throw new Error("Accepted author task disappeared after pause.");
        assert.strictEqual(preservedAuthorTask.value.status, "done");
        const preservedAuthorAttempts = yield* native.listAttemptsForTask(firstTask.id);
        assert.strictEqual(
          preservedAuthorAttempts.find((attempt) => attempt.id === retriedBinding.attemptId)
            ?.outcome,
          "succeeded",
        );
        assert.strictEqual(
          pausedAfterCandidate.graph.stages[0]?.candidateId,
          candidate.graph.stages[0]?.candidateId,
        );
        assert.strictEqual(
          pausedAfterCandidate.graph.stages[0]?.outputDigest,
          candidate.graph.stages[0]?.outputDigest,
        );
        const resumedAfterCandidate = yield* service.command(
          {
            action: "resume",
            hubId,
            planId: confirmed.id,
            requestId: "resume-after-author-candidate",
            expectedStateVersion: pausedAfterCandidate.stateVersion,
            expectedRevision: pausedAfterCandidate.revision,
          },
          { kind: "user" },
        );
        assert.strictEqual(resumedAfterCandidate.controlState, "active");
        yield* makeExecution(false).drain(hubId);
        const firstReviewerBinding = (yield* store.listAttemptBindings({
          planId: confirmed.id,
        })).find((binding) => binding.nodeKey === "reviewer");
        assert.isDefined(firstReviewerBinding);
        const firstReviewerWork = yield* work.get(firstReviewerBinding.workItemId);
        assert.isNotNull(firstReviewerWork);
        assert.strictEqual(firstReviewerWork.state, "queued");
        assert.include(firstReviewerWork.creationSpec.prompt, "Direct task inputs");
        assert.include(
          firstReviewerWork.creationSpec.prompt,
          candidate.graph.stages[0]!.candidateId!,
        );
        assert.include(
          firstReviewerWork.creationSpec.prompt,
          candidate.graph.stages[0]!.outputDigest!,
        );
        const fixedInputs = JSON.parse(
          firstReviewerWork.creationSpec.prompt
            .split("never substitute a newer publication:\n\n")[1]!
            .split("\n\n")[0]!,
        );
        const fixedCandidate = fixedInputs.find(
          (entry: { candidateId?: string }) =>
            entry.candidateId === candidate.graph.stages[0]!.candidateId,
        );
        assert.deepStrictEqual(
          fixedCandidate.deliverableRefs,
          candidate.graph.stages[0]!.deliverableRefs,
        );

        const reviewerStart = yield* work.claimNext(hubId, firstReviewerWork.id);
        assert.isNotNull(reviewerStart);
        const firstReviewerThread = ThreadId.makeUnsafe("hub-plan-execution-reviewer-first");
        runningWorkers.add(firstReviewerThread);
        const firstReviewerWorking = yield* work.save({
          record: {
            ...reviewerStart,
            workerThreadId: firstReviewerThread,
            state: "working",
            revision: reviewerStart.revision + 1,
            updatedAt: now,
          },
          expectedRevision: reviewerStart.revision,
        });
        const reviewerTaskOption = yield* native.getTask(
          ProjectTaskId.makeUnsafe(firstReviewerBinding.taskId),
        );
        if (Option.isNone(reviewerTaskOption))
          throw new Error("Confirmed reviewer task disappeared.");
        yield* native.saveTask(
          {
            ...reviewerTaskOption.value,
            status: "running",
            assignedThreadId: firstReviewerThread,
            revision: reviewerTaskOption.value.revision + 1,
            updatedAt: now,
          },
          reviewerTaskOption.value.revision,
        );
        yield* native.saveAttempt({
          id: ProjectTaskAttemptId.makeUnsafe(firstReviewerBinding.attemptId),
          projectId: hubId,
          taskId: reviewerTaskOption.value.id,
          workerThreadId: firstReviewerThread,
          gatewayOperationId: firstReviewerWorking.id,
          requestId: `${firstReviewerWorking.id}:attempt:${firstReviewerThread}`,
          attemptNumber: 1,
          outcome: "running",
          error: null,
          createdAt: now,
          finishedAt: null,
        });
        yield* trackManagedWorker({
          threadId: firstReviewerThread,
          workItemId: firstReviewerWorking.id,
          taskId: reviewerTaskOption.value.id,
          title: "Reviewer",
        });

        const beforeReviewerPause = yield* service.read(
          { hubId, planId: confirmed.id },
          { kind: "user" },
        );
        if (!beforeReviewerPause) throw new Error("Plan disappeared before reviewer pause.");
        yield* service.command(
          {
            action: "pause",
            hubId,
            planId: confirmed.id,
            requestId: "pause-reviewer-attempt",
            expectedStateVersion: beforeReviewerPause.stateVersion,
            expectedRevision: beforeReviewerPause.revision,
          },
          { kind: "user" },
        );
        yield* makeExecution(false).drain(hubId);
        const pausedReviewer = yield* service.read(
          { hubId, planId: confirmed.id },
          { kind: "user" },
        );
        if (!pausedReviewer) throw new Error("Plan disappeared after reviewer pause.");
        assert.strictEqual(pausedReviewer.controlState, "paused");
        assert.strictEqual((yield* work.get(firstReviewerWork.id))?.state, "cancelled");
        const pausedReviewerTask = yield* native.getTask(reviewerTaskOption.value.id);
        if (Option.isNone(pausedReviewerTask)) throw new Error("Paused reviewer task disappeared.");
        assert.strictEqual(pausedReviewerTask.value.status, "ready");

        const resumedReviewer = yield* service.command(
          {
            action: "resume",
            hubId,
            planId: confirmed.id,
            requestId: "resume-reviewer-attempt",
            expectedStateVersion: pausedReviewer.stateVersion,
            expectedRevision: pausedReviewer.revision,
          },
          { kind: "user" },
        );
        assert.strictEqual(resumedReviewer.controlState, "active");
        yield* makeExecution(false).drain(hubId);
        const reviewerBindings = (yield* store.listAttemptBindings({
          planId: confirmed.id,
        })).filter((binding) => binding.nodeKey === "reviewer");
        assert.strictEqual(reviewerBindings.length, 2);
        const reviewerBinding = reviewerBindings.at(-1)!;
        assert.strictEqual(reviewerBinding.taskId, firstReviewerBinding.taskId);
        assert.notStrictEqual(reviewerBinding.attemptId, firstReviewerBinding.attemptId);
        const snapshotAfterReviewerResume = yield* service.read(
          { hubId, planId: confirmed.id },
          { kind: "user" },
        );
        assert.strictEqual(
          snapshotAfterReviewerResume?.graph.stages[0]?.candidateId,
          candidate.graph.stages[0]?.candidateId,
        );
        assert.strictEqual(
          snapshotAfterReviewerResume?.graph.stages[0]?.outputDigest,
          candidate.graph.stages[0]?.outputDigest,
        );
        const oldReviewerAuthority = yield* Effect.exit(
          makeExecution(false).assertThreadAllowed(firstReviewerThread),
        );
        assert.isTrue(Exit.isFailure(oldReviewerAuthority));
        const reviewerWork = yield* work.get(reviewerBinding.workItemId);
        assert.isNotNull(reviewerWork);
        assert.strictEqual(reviewerWork.state, "queued");
        const retryReviewerStart = yield* work.claimNext(hubId, reviewerWork.id);
        assert.isNotNull(retryReviewerStart);
        const reviewerThread = ThreadId.makeUnsafe("hub-plan-execution-reviewer-resumed");
        runningWorkers.add(reviewerThread);
        const reviewerWorking = yield* work.save({
          record: {
            ...retryReviewerStart,
            workerThreadId: reviewerThread,
            state: "working",
            revision: retryReviewerStart.revision + 1,
            updatedAt: now,
          },
          expectedRevision: retryReviewerStart.revision,
        });
        const currentReviewerTask = yield* native.getTask(
          ProjectTaskId.makeUnsafe(reviewerBinding.taskId),
        );
        if (Option.isNone(currentReviewerTask))
          throw new Error("Current reviewer task disappeared.");
        yield* native.saveTask(
          {
            ...currentReviewerTask.value,
            status: "running",
            assignedThreadId: reviewerThread,
            revision: currentReviewerTask.value.revision + 1,
            updatedAt: now,
          },
          currentReviewerTask.value.revision,
        );
        yield* native.saveAttempt({
          id: ProjectTaskAttemptId.makeUnsafe(reviewerBinding.attemptId),
          projectId: hubId,
          taskId: currentReviewerTask.value.id,
          workerThreadId: reviewerThread,
          gatewayOperationId: reviewerWorking.id,
          requestId: `${reviewerWorking.id}:attempt:${reviewerThread}`,
          attemptNumber: 2,
          outcome: "running",
          error: null,
          createdAt: now,
          finishedAt: null,
        });
        yield* trackManagedWorker({
          threadId: reviewerThread,
          workItemId: reviewerWorking.id,
          taskId: currentReviewerTask.value.id,
          title: "Reviewer",
        });

        const beforeReview = yield* service.read({ hubId, planId: confirmed.id }, { kind: "user" });
        if (!beforeReview) throw new Error("Plan disappeared before reviewer submission.");
        const lateOldReviewerResult = yield* Effect.exit(
          service.command(
            {
              action: "submitReview",
              hubId,
              planId: confirmed.id,
              requestId: "late-result-from-stopped-reviewer",
              expectedStateVersion: beforeReview.stateVersion,
              expectedRevision: beforeReview.revision,
              stageKey: "draft",
              generation: 1,
              nodeKey: "reviewer",
              attemptId: ProjectTaskAttemptId.makeUnsafe(firstReviewerBinding.attemptId),
              candidateId: candidate.graph.stages[0]!.candidateId!,
              outputDigest: candidate.graph.stages[0]!.outputDigest!,
              outcome: "pass",
              summary: "Late stale reviewer result",
            },
            { kind: "worker", hubId, threadId: firstReviewerThread },
          ),
        );
        assert.isTrue(Exit.isFailure(lateOldReviewerResult));
        const currentTaskAfterLateResult = yield* native.getTask(currentReviewerTask.value.id);
        if (Option.isNone(currentTaskAfterLateResult))
          throw new Error("Current reviewer task disappeared after stale result.");
        assert.strictEqual(currentTaskAfterLateResult.value.status, "running");
        assert.strictEqual(currentTaskAfterLateResult.value.assignedThreadId, reviewerThread);
        const reviewerResult = yield* service.command(
          {
            action: "submitReview",
            hubId,
            planId: confirmed.id,
            requestId: "submit-plan-review",
            expectedStateVersion: beforeReview.stateVersion,
            expectedRevision: beforeReview.revision,
            stageKey: "draft",
            generation: 1,
            nodeKey: "reviewer",
            attemptId: reviewerBinding.attemptId as ProjectTaskAttemptId,
            candidateId: candidate.graph.stages[0]!.candidateId!,
            outputDigest: candidate.graph.stages[0]!.outputDigest!,
            outcome: "pass",
            summary: "Reviewed against the fixed candidate.",
          },
          { kind: "worker", hubId, threadId: reviewerThread },
        );
        assert.strictEqual(reviewerResult.graph.releasedCount, 0);
        assert.strictEqual((yield* work.get(reviewerWork.id))?.state, "working");
        const acceptedReviewerWorker = yield* native.findManagedWorkerByThread(reviewerThread);
        if (Option.isNone(acceptedReviewerWorker))
          throw new Error("Accepted reviewer managed worker disappeared.");
        assert.strictEqual(
          acceptedReviewerWorker.value.resultSummary,
          "Reviewed against the fixed candidate.",
        );
        assert.isNotNull(acceptedReviewerWorker.value.resultAt);
        const prematureRelease = yield* Effect.exit(
          service.command(
            {
              action: "release",
              hubId,
              planId: confirmed.id,
              requestId: "release-before-reviewer-settle",
              expectedStateVersion: reviewerResult.stateVersion,
              expectedRevision: reviewerResult.revision,
              stageKey: "draft",
              generation: 1,
              candidateId: candidate.graph.stages[0]!.candidateId!,
              outputDigest: candidate.graph.stages[0]!.outputDigest!,
            },
            { kind: "user" },
          ),
        );
        assert.isTrue(Exit.isFailure(prematureRelease));

        const beforeAcceptedReviewPause = yield* service.read(
          { hubId, planId: confirmed.id },
          { kind: "user" },
        );
        if (!beforeAcceptedReviewPause)
          throw new Error("Plan disappeared before accepted reviewer pause.");
        yield* service.command(
          {
            action: "pause",
            hubId,
            planId: confirmed.id,
            requestId: "pause-after-review-accepted",
            expectedStateVersion: beforeAcceptedReviewPause.stateVersion,
            expectedRevision: beforeAcceptedReviewPause.revision,
          },
          { kind: "user" },
        );
        yield* makeExecution(false).drain(hubId);
        const pausedAfterReview = yield* service.read(
          { hubId, planId: confirmed.id },
          { kind: "user" },
        );
        if (!pausedAfterReview) throw new Error("Plan disappeared after accepted reviewer pause.");
        assert.strictEqual(pausedAfterReview.controlState, "paused");
        assert.strictEqual((yield* work.get(reviewerWork.id))?.state, "cancelled");
        const retainedReviewTask = yield* native.getTask(currentReviewerTask.value.id);
        if (Option.isNone(retainedReviewTask))
          throw new Error("Accepted reviewer task disappeared after stop.");
        assert.strictEqual(retainedReviewTask.value.status, "done");
        assert.strictEqual(
          (yield* native.listAttemptsForTask(currentReviewerTask.value.id)).find(
            (attempt) => attempt.id === reviewerBinding.attemptId,
          )?.outcome,
          "succeeded",
        );
        const resumedAfterReview = yield* service.command(
          {
            action: "resume",
            hubId,
            planId: confirmed.id,
            requestId: "resume-after-review-accepted",
            expectedStateVersion: pausedAfterReview.stateVersion,
            expectedRevision: pausedAfterReview.revision,
          },
          { kind: "user" },
        );
        assert.strictEqual(resumedAfterReview.controlState, "active");
        yield* makeExecution(false).drain(hubId);
        const readyForUser = yield* service.read({ hubId, planId: confirmed.id }, { kind: "user" });
        if (!readyForUser) throw new Error("Plan disappeared before user release.");
        assert.strictEqual(readyForUser.graph.stages[0]?.status, "waiting_user");
        const returned = yield* service.command(
          {
            action: "return",
            hubId,
            planId: confirmed.id,
            requestId: "return-after-reviewer-settle",
            expectedStateVersion: readyForUser.stateVersion,
            expectedRevision: readyForUser.revision,
            stageKey: "draft",
            generation: 1,
            candidateId: candidate.graph.stages[0]!.candidateId!,
            outputDigest: candidate.graph.stages[0]!.outputDigest!,
            comment: "Please add a source quotation and address the review note.",
          },
          { kind: "user" },
        );
        assert.strictEqual(returned.controlState, "active");
        yield* makeExecution(false).drain(hubId);
        const repairBindings = yield* store.listAttemptBindings({ planId: confirmed.id });
        const repairAuthorBinding = repairBindings.find(
          (binding) => binding.nodeKey === "author" && binding.stageGeneration === 2,
        );
        assert.isDefined(repairAuthorBinding);
        const repairAuthorWork = yield* work.get(repairAuthorBinding.workItemId);
        assert.isNotNull(repairAuthorWork);
        const repairPrompt = repairAuthorWork.creationSpec.prompt;
        assert.include(repairPrompt, candidate.graph.stages[0]!.candidateId!);
        assert.include(repairPrompt, candidate.graph.stages[0]!.outputDigest!);
        assert.include(repairPrompt, "worker-resumed/1/result.md");
        assert.include(repairPrompt, "Reviewed against the fixed candidate.");
        assert.include(repairPrompt, "Please add a source quotation and address the review note.");
        assert.include(repairPrompt, "untrusted reference data");

        const repairAuthor = yield* startBoundAttempt({
          binding: repairAuthorBinding,
          threadId: "hub-plan-execution-author-repair",
          title: "Author repair",
          attemptNumber: 3,
        });
        const beforeRepairCandidate = yield* service.read(
          { hubId, planId: confirmed.id },
          { kind: "user" },
        );
        if (!beforeRepairCandidate) throw new Error("Plan disappeared before repair candidate.");
        const repairCandidate = yield* service.command(
          {
            action: "submitCandidate",
            hubId,
            planId: confirmed.id,
            requestId: "submit-repair-author-candidate",
            expectedStateVersion: beforeRepairCandidate.stateVersion,
            expectedRevision: beforeRepairCandidate.revision,
            stageKey: "draft",
            generation: 2,
            nodeKey: "author",
            attemptId: ProjectTaskAttemptId.makeUnsafe(repairAuthorBinding.attemptId),
            deliverableRefs: [
              {
                hubId,
                workerThreadId: repairAuthor.threadId,
                revision: 2,
                commitSha: "c".repeat(40),
                provenance: {
                  hubId,
                  workerThreadId: repairAuthor.threadId,
                  expertBindingSnapshotId: "binding-author-repair",
                  publishedAt: now,
                },
                file: {
                  path: "revised-result.md",
                  libraryPath: "worker-repair/2/revised-result.md",
                  name: "Revised Result",
                  description: null,
                  mediaType: "text/markdown",
                  sizeBytes: 1,
                  sha256: "d".repeat(64),
                },
              },
            ],
            summary: "Revised candidate with source quotation",
          },
          { kind: "worker", hubId, threadId: repairAuthor.threadId },
        );
        runningWorkers.delete(repairAuthor.threadId);
        const repairAuthorSettled = yield* settleNativeTurn({
          workItemId: repairAuthor.work.id,
          threadId: repairAuthor.threadId,
        });
        assert.strictEqual(repairAuthorSettled.state, "completed");
        yield* makeExecution(false).drain(hubId);

        const repairReviewerBinding = (yield* store.listAttemptBindings({
          planId: confirmed.id,
        })).find((binding) => binding.nodeKey === "reviewer" && binding.stageGeneration === 2);
        assert.isDefined(repairReviewerBinding);
        const repairReviewer = yield* startBoundAttempt({
          binding: repairReviewerBinding,
          threadId: "hub-plan-execution-reviewer-repair",
          title: "Reviewer repair",
          attemptNumber: 3,
        });
        const beforeRepairReview = yield* service.read(
          { hubId, planId: confirmed.id },
          { kind: "user" },
        );
        if (!beforeRepairReview) throw new Error("Plan disappeared before repair review.");
        const repairReview = yield* service.command(
          {
            action: "submitReview",
            hubId,
            planId: confirmed.id,
            requestId: "submit-repair-review",
            expectedStateVersion: beforeRepairReview.stateVersion,
            expectedRevision: beforeRepairReview.revision,
            stageKey: "draft",
            generation: 2,
            nodeKey: "reviewer",
            attemptId: ProjectTaskAttemptId.makeUnsafe(repairReviewerBinding.attemptId),
            candidateId: repairCandidate.graph.stages[0]!.candidateId!,
            outputDigest: repairCandidate.graph.stages[0]!.outputDigest!,
            outcome: "pass",
            summary: "Revised candidate includes the requested evidence.",
          },
          { kind: "worker", hubId, threadId: repairReviewer.threadId },
        );
        // Stop after accepted review but before native settlement. Work has no
        // result summary; the durable review remains the authoritative input.
        yield* service.command(
          {
            action: "pause",
            hubId,
            planId: confirmed.id,
            requestId: "pause-repaired-review",
            expectedStateVersion: repairReview.stateVersion,
            expectedRevision: repairReview.revision,
          },
          { kind: "user" },
        );
        yield* makeExecution(false).drain(hubId);
        const stoppedRepairReview = yield* work.get(repairReviewer.work.id);
        assert.strictEqual(stoppedRepairReview?.state, "cancelled");
        assert.strictEqual(stoppedRepairReview?.resultSummary, null);
        const pausedRepairPlan = yield* service.read(
          { hubId, planId: confirmed.id },
          { kind: "user" },
        );
        if (!pausedRepairPlan) throw new Error("Paused repaired review disappeared.");
        yield* service.command(
          {
            action: "resume",
            hubId,
            planId: confirmed.id,
            requestId: "resume-repaired-review",
            expectedStateVersion: pausedRepairPlan.stateVersion,
            expectedRevision: pausedRepairPlan.revision,
          },
          { kind: "user" },
        );
        yield* makeExecution(false).drain(hubId);
        const repairReadyForUser = yield* service.read(
          { hubId, planId: confirmed.id },
          { kind: "user" },
        );
        if (!repairReadyForUser) throw new Error("Plan disappeared before repaired release.");
        assert.strictEqual(repairReview.graph.releasedCount, 0);
        assert.strictEqual(repairReadyForUser.graph.stages[0]?.status, "waiting_user");
        const released = yield* service.command(
          {
            action: "release",
            hubId,
            planId: confirmed.id,
            requestId: "release-repaired-candidate",
            expectedStateVersion: repairReadyForUser.stateVersion,
            expectedRevision: repairReadyForUser.revision,
            stageKey: "draft",
            generation: 2,
            candidateId: repairCandidate.graph.stages[0]!.candidateId!,
            outputDigest: repairCandidate.graph.stages[0]!.outputDigest!,
          },
          { kind: "user" },
        );
        assert.strictEqual(released.controlState, "active");
        assert.strictEqual(released.graph.releasedCount, 1);
        yield* makeExecution(false).drain(hubId);
        const downstreamBinding = (yield* store.listAttemptBindings({ planId: confirmed.id })).find(
          (binding) => binding.nodeKey === "delivery-author",
        );
        assert.isDefined(downstreamBinding);
        const downstreamWork = yield* work.get(downstreamBinding.workItemId);
        assert.isNotNull(downstreamWork);
        const downstreamInputs = JSON.parse(
          downstreamWork.creationSpec.prompt
            .split("never substitute a newer publication:\n\n")[1]!
            .split("\n\n")[0]!,
        );
        const reviewedInput = downstreamInputs.find(
          (entry: { nodeKey?: string }) => entry.nodeKey === "reviewer",
        );
        assert.strictEqual(reviewedInput.reviewAttemptId, repairReviewerBinding.attemptId);
        assert.strictEqual(
          reviewedInput.summary,
          "Revised candidate includes the requested evidence.",
        );
        assert.strictEqual(reviewedInput.candidateId, repairCandidate.graph.stages[0]!.candidateId);
        assert.strictEqual(
          reviewedInput.outputDigest,
          repairCandidate.graph.stages[0]!.outputDigest,
        );
        assert.deepStrictEqual(
          reviewedInput.deliverableRefs,
          repairCandidate.graph.stages[0]!.deliverableRefs,
        );
        assert.notStrictEqual(reviewedInput.candidateId, candidate.graph.stages[0]!.candidateId);
      }),
  );

  test.effect(
    "preserves missing-result retry across pause and resumes a durable retry token once",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const native = yield* ProjectAgentRepository;
        const work = yield* HubWorkRepository;
        yield* runMigrations();
        yield* runWorkbenchMigrations();

        const hubId = ProjectId.makeUnsafe("hub-plan-explicit-retry-integration");
        const coordinatorThreadId = ThreadId.makeUnsafe("hub-plan-explicit-retry-coordinator");
        const sourceMessageId = MessageId.makeUnsafe("hub-plan-explicit-retry-source");
        yield* sql`
          INSERT INTO projection_projects (
            project_id, title, workspace_root, scripts_json, created_at, updated_at
          ) VALUES (${hubId}, 'Retry plan', '/tmp/retry-plan', '[]', ${now}, ${now})
        `;
        yield* native.saveConfig(
          {
            projectId: hubId,
            coordinatorThreadId,
            coordinatorName: "Coordinator",
            coordinatorModelSelection: {
              provider: "codex",
              instanceId: "codex",
              model: "gpt-6.1-sol",
            },
            limits: { ...DEFAULT_PROJECT_AGENT_LIMITS },
            captureEnabled: false,
            enabled: true,
            automationId: null,
            revision: 1,
            createdAt: now,
            updatedAt: now,
            disabledAt: null,
            expertIds: [],
            collaboration: { schemaVersion: 1, mode: "standard" },
          },
          null,
        );

        const store = makeHubPlanStore(sql);
        const requireConfig = (projectId: ProjectId) =>
          native.getConfig(projectId).pipe(
            Effect.flatMap(
              Option.match({
                onNone: () => Effect.fail(new Error("missing config")),
                onSome: Effect.succeed,
              }),
            ),
          );
        const service = makeHubPlanService({
          store,
          native: {
            readConfig: requireConfig,
            getActiveGoal: (projectId) =>
              native.getActiveGoal(projectId).pipe(Effect.map(Option.getOrNull)),
            getGoal: (goalId) => native.getGoal(goalId).pipe(Effect.map(Option.getOrNull)),
            getTask: (taskId) => native.getTask(taskId).pipe(Effect.map(Option.getOrNull)),
            readTasks: (goalId) =>
              Effect.gen(function* () {
                const goal = yield* native.getGoal(goalId);
                if (Option.isNone(goal)) return [];
                return yield* native.listTasks({
                  projectId: goal.value.projectId,
                  goalId,
                  includeArchived: true,
                  limit: 128,
                });
              }),
            saveGoal: native.saveGoal,
            saveTask: native.saveTask,
            listAttempts: native.listAttemptsForTask,
            saveAttempt: native.saveAttempt,
            readManagedWorkerByThread: (threadId) =>
              native.findManagedWorkerByThread(threadId).pipe(Effect.map(Option.getOrNull)),
            readWork: work.get,
            finalizePlanNode: makeHubPlanNodeFinalizer({
              store,
              projectAgentRepository: native,
              workRepository: work,
            }),
            readSourceMessages: (_projectId, ids) =>
              Effect.succeed(
                ids.map((messageId) => ({
                  threadId: coordinatorThreadId,
                  messageId: MessageId.makeUnsafe(messageId),
                  turnId: null,
                  text: "Please complete the fixed plan objective.",
                  attachments: [],
                  createdAt: now,
                  updatedAt: now,
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
          },
        });
        const execution = () =>
          makeHubPlanExecution({
            sql,
            projectAgentRepository: native,
            workRepository: work,
            resolveCreationSpec: ({ spec, targetProjectId }) =>
              Effect.try({
                try: () =>
                  Schema.decodeUnknownSync(SynaraResolvedCreateThreadSpec)({
                    ...spec,
                    target: spec.target!,
                    projectId: targetProjectId,
                  }),
                catch: (cause) => cause,
              }),
            readSourceMessages: (input) =>
              Effect.succeed(
                input.sourceMessageIds.map((messageId) => ({
                  threadId: coordinatorThreadId,
                  messageId: MessageId.makeUnsafe(messageId),
                  turnId: null,
                  text: "Please complete the fixed plan objective.",
                  attachments: [],
                  createdAt: now,
                  updatedAt: now,
                })),
              ),
            readExpertSnapshot: async (snapshotId) => {
              throw new Error(`Unexpected Expert snapshot ${snapshotId}`);
            },
            readExpert: async () => null,
            interruptWorker: () => Effect.void,
            readWorkerRunning: () => Effect.succeed(false),
            readPlanSnapshot: (input) => service.read(input, { kind: "user" }),
            reconcilePlanSnapshot: (currentHubId) => service.reconcile(currentHubId),
          });

        const draft = yield* service.propose(
          {
            hubId,
            requestId: "propose-explicit-retry-integration",
            planId: "explicit-retry-integration",
            expectedStateVersion: null,
            definition,
            sourceMessageIds: [sourceMessageId],
          },
          { kind: "user" },
        );
        const confirmed = yield* service.command(
          {
            action: "confirm",
            hubId,
            planId: draft.id,
            requestId: "confirm-explicit-retry-integration",
            expectedStateVersion: draft.stateVersion,
            expectedRevision: draft.revision,
          },
          { kind: "user" },
        );
        yield* execution().drain(hubId);
        const [initialWork] = yield* work.list(hubId);
        assert.isDefined(initialWork);
        assert.strictEqual(initialWork?.state, "queued");
        const [initialBinding] = yield* store.listAttemptBindings({ planId: confirmed.id });
        assert.isDefined(initialBinding);
        assert.strictEqual(initialBinding?.nodeKey, "author");

        const claimed = yield* work.claimNext(hubId, initialWork!.id);
        assert.isNotNull(claimed);
        const workerThreadId = ThreadId.makeUnsafe("hub-plan-explicit-retry-worker-first");
        const working = yield* work.save({
          record: {
            ...claimed!,
            workerThreadId,
            state: "working",
            revision: claimed!.revision + 1,
            updatedAt: now,
          },
          expectedRevision: claimed!.revision,
        });
        const taskOption = yield* native.getTask(ProjectTaskId.makeUnsafe(initialBinding!.taskId));
        if (Option.isNone(taskOption)) throw new Error("Retry integration task disappeared.");
        yield* native.saveTask(
          {
            ...taskOption.value,
            status: "running",
            assignedThreadId: workerThreadId,
            revision: taskOption.value.revision + 1,
            updatedAt: now,
          },
          taskOption.value.revision,
        );
        yield* native.saveAttempt({
          id: ProjectTaskAttemptId.makeUnsafe(initialBinding!.attemptId),
          projectId: hubId,
          taskId: taskOption.value.id,
          workerThreadId,
          gatewayOperationId: working.id,
          requestId: `${working.id}:attempt:${workerThreadId}`,
          attemptNumber: 1,
          outcome: "running",
          error: null,
          createdAt: now,
          finishedAt: null,
        });
        yield* native.upsertManagedWorker({
          projectId: hubId,
          threadId: workerThreadId,
          batchId: "explicit-retry-test",
          requestId: working.id,
          title: "Author",
          taskId: taskOption.value.id,
          settledAt: null,
          settleOutcome: null,
          waitingSince: null,
          stuckKind: null,
          stuckSince: null,
          taskPrompt: "Author the plan candidate.",
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
          createdAt: now,
          updatedAt: now,
        });
        const managedWorkerOption = yield* native.findManagedWorkerByThread(workerThreadId);
        if (Option.isNone(managedWorkerOption))
          throw new Error("Settled managed worker disappeared before retry projection.");
        yield* native.upsertManagedWorker({
          ...managedWorkerOption.value,
          settledAt: now,
          settleOutcome: "failed",
          updatedAt: now,
        });
        const settledWork = yield* work.save({
          record: {
            ...working,
            state: "failed",
            slotHeld: false,
            admittedAt: null,
            admissionCommandId: null,
            admissionMessageId: null,
            admissionPreviousState: null,
            admissionPreviousSlotHeld: false,
            progress: {
              revision: 1,
              steps: [],
              summary: "Provider turn failed before filing the plan result.",
            },
            revision: working.revision + 1,
            updatedAt: now,
          },
          expectedRevision: working.revision,
        });
        assert.strictEqual(settledWork.state, "failed");
        assert.isFalse(settledWork.slotHeld);

        const missingResultSnapshot = yield* service.read(
          { hubId, planId: confirmed.id },
          { kind: "user" },
        );
        assert.strictEqual(missingResultSnapshot?.graph.stages[0]?.status, "blocked");
        assert.isTrue(
          missingResultSnapshot?.nodeStates.find((nodeState) => nodeState.nodeKey === "author")
            ?.retryable,
        );
        yield* execution().drain(hubId);
        assert.strictEqual((yield* work.list(hubId)).length, 1);
        assert.strictEqual((yield* store.listAttemptBindings({ planId: confirmed.id })).length, 1);

        const beforeRetryPauseView = yield* service.read(
          { hubId, planId: confirmed.id },
          { kind: "user" },
        );
        if (!beforeRetryPauseView) throw new Error("Retryable plan disappeared before pause.");
        const pausingBeforeRetry = yield* service.command(
          {
            action: "pause",
            hubId,
            planId: confirmed.id,
            requestId: "pause-before-explicit-retry-command",
            expectedStateVersion: beforeRetryPauseView.stateVersion,
            expectedRevision: beforeRetryPauseView.revision,
          },
          { kind: "user" },
        );
        assert.strictEqual(pausingBeforeRetry.controlState, "pausing");
        yield* execution().drain(hubId);
        const pausedBeforeRetry = yield* service.read(
          { hubId, planId: confirmed.id },
          { kind: "user" },
        );
        assert.strictEqual(pausedBeforeRetry?.controlState, "paused");
        assert.isTrue(
          pausedBeforeRetry?.nodeStates.find((nodeState) => nodeState.nodeKey === "author")
            ?.retryable,
          "a settled missing-result node remains explicitly retryable after pause",
        );
        assert.strictEqual((yield* work.get(initialWork!.id))?.state, "failed");
        const taskWhilePaused = yield* native.getTask(taskOption.value.id);
        assert.strictEqual(Option.getOrNull(taskWhilePaused)?.status, "running");
        assert.strictEqual(Option.getOrNull(taskWhilePaused)?.assignedThreadId, workerThreadId);
        assert.strictEqual(
          (yield* native.listAttemptsForTask(taskOption.value.id))[0]?.outcome,
          "running",
        );

        const resumedBeforeRetry = yield* service.command(
          {
            action: "resume",
            hubId,
            planId: confirmed.id,
            requestId: "resume-before-explicit-retry-command",
            expectedStateVersion: pausedBeforeRetry!.stateVersion,
            expectedRevision: pausedBeforeRetry!.revision,
          },
          { kind: "user" },
        );
        assert.strictEqual(resumedBeforeRetry.controlState, "active");
        yield* execution().drain(hubId);
        assert.strictEqual((yield* work.list(hubId)).length, 1);
        assert.strictEqual((yield* store.listAttemptBindings({ planId: confirmed.id })).length, 1);
        assert.strictEqual((yield* work.get(initialWork!.id))?.state, "failed");

        const retryView = yield* service.read({ hubId, planId: confirmed.id }, { kind: "user" });
        if (!retryView) throw new Error("Retryable plan disappeared before command.");
        const retryInput: HubPlanCommandInput = {
          action: "retry",
          hubId,
          planId: confirmed.id,
          requestId: "retry-explicit-retry-integration",
          expectedStateVersion: retryView.stateVersion,
          expectedRevision: retryView.revision,
          nodeKey: "author",
          stageKey: "draft",
          generation: 1,
          attemptId: ProjectTaskAttemptId.makeUnsafe(initialBinding!.attemptId),
        };
        const retried = yield* service.command(retryInput, { kind: "user" });
        const taskAfterRetry = yield* native.getTask(taskOption.value.id);
        assert.strictEqual(Option.getOrNull(taskAfterRetry)?.status, "ready");
        const closedAttempt = yield* native.listAttemptsForTask(taskOption.value.id);
        assert.strictEqual(closedAttempt[0]?.outcome, "failed");
        assert.include(
          closedAttempt[0]?.error ?? "",
          "Provider turn failed before filing the plan result.",
        );

        const pausing = yield* service.command(
          {
            action: "pause",
            hubId,
            planId: confirmed.id,
            requestId: "pause-before-explicit-retry-dispatch",
            expectedStateVersion: retried.stateVersion,
            expectedRevision: retried.revision,
          },
          { kind: "user" },
        );
        assert.strictEqual(pausing.controlState, "pausing");
        yield* execution().drain(hubId);
        const paused = yield* service.read({ hubId, planId: confirmed.id }, { kind: "user" });
        assert.strictEqual(paused?.controlState, "paused");
        assert.strictEqual((yield* work.list(hubId)).length, 1);
        assert.strictEqual((yield* store.listAttemptBindings({ planId: confirmed.id })).length, 1);
        assert.strictEqual((yield* work.get(initialWork!.id))?.state, "failed");
        const pendingRetry = (yield* store.readPending({ planId: confirmed.id })).find(
          (item) => item.kind === "plan.schedule",
        );
        assert.isDefined(pendingRetry);
        assert.deepStrictEqual((pendingRetry?.payload as { readonly retry?: unknown }).retry, {
          nodeKey: "author",
          stageKey: "draft",
          generation: 1,
          attemptId: initialBinding!.attemptId,
        });

        const resumed = yield* service.command(
          {
            action: "resume",
            hubId,
            planId: confirmed.id,
            requestId: "resume-before-explicit-retry-dispatch",
            expectedStateVersion: paused!.stateVersion,
            expectedRevision: paused!.revision,
          },
          { kind: "user" },
        );
        assert.strictEqual(resumed.controlState, "active");
        // A fresh executor instance proves the token is recovered from SQLite.
        yield* execution().drain(hubId);
        const allWork = yield* work.list(hubId);
        const allBindings = yield* store.listAttemptBindings({ planId: confirmed.id });
        assert.strictEqual(allWork.length, 2);
        assert.strictEqual(allBindings.length, 2);
        assert.strictEqual(allBindings[1]?.stageGeneration, 1);
        assert.strictEqual(allBindings[1]?.taskId, initialBinding?.taskId);
        assert.notStrictEqual(allBindings[1]?.attemptId, initialBinding?.attemptId);
        assert.strictEqual(allWork.find((item) => item.id === initialWork?.id)?.state, "failed");
        const newWork = allWork.find((item) => item.id !== initialWork?.id);
        assert.strictEqual(newWork?.state, "queued");
        assert.deepStrictEqual(newWork?.creationSpec.target, initialWork?.creationSpec.target);
        yield* execution().drain(hubId);
        assert.strictEqual((yield* work.list(hubId)).length, 2);
        assert.strictEqual((yield* store.listAttemptBindings({ planId: confirmed.id })).length, 2);

        // A normally completed native turn can still have no accepted plan
        // result. Pause/resume must preserve that completed Work and its
        // explicit retry opportunity instead of rewriting it as cancelled.
        if (!newWork) throw new Error("Explicit retry Work disappeared before completion.");
        const completedAttemptBinding = allBindings[1];
        if (!completedAttemptBinding)
          throw new Error("Second attempt binding disappeared before completion.");
        const claimedCompleted = yield* work.claimNext(hubId, newWork.id);
        if (!claimedCompleted) throw new Error("Completed retry Work could not be claimed.");
        const completedWorkerThread = ThreadId.makeUnsafe(
          "hub-plan-explicit-retry-worker-completed-no-result",
        );
        const completedWorking = yield* work.save({
          record: {
            ...claimedCompleted,
            workerThreadId: completedWorkerThread,
            state: "working",
            revision: claimedCompleted.revision + 1,
            updatedAt: now,
          },
          expectedRevision: claimedCompleted.revision,
        });
        const completedTaskOption = yield* native.getTask(
          ProjectTaskId.makeUnsafe(completedAttemptBinding.taskId),
        );
        if (Option.isNone(completedTaskOption))
          throw new Error("Completed retry Task disappeared before execution.");
        yield* native.saveTask(
          {
            ...completedTaskOption.value,
            status: "running",
            assignedThreadId: completedWorkerThread,
            revision: completedTaskOption.value.revision + 1,
            updatedAt: now,
          },
          completedTaskOption.value.revision,
        );
        yield* native.saveAttempt({
          id: ProjectTaskAttemptId.makeUnsafe(completedAttemptBinding.attemptId),
          projectId: hubId,
          taskId: completedTaskOption.value.id,
          workerThreadId: completedWorkerThread,
          gatewayOperationId: completedWorking.id,
          requestId: `${completedWorking.id}:attempt:${completedWorkerThread}`,
          attemptNumber: 2,
          outcome: "running",
          error: null,
          createdAt: now,
          finishedAt: null,
        });
        const completedWorker = yield* native.upsertManagedWorker({
          projectId: hubId,
          threadId: completedWorkerThread,
          batchId: "explicit-retry-test",
          requestId: completedWorking.id,
          title: "Author",
          taskId: completedTaskOption.value.id,
          settledAt: now,
          settleOutcome: "completed",
          waitingSince: null,
          stuckKind: null,
          stuckSince: null,
          taskPrompt: "Author the plan candidate.",
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
          createdAt: now,
          updatedAt: now,
        });
        assert.strictEqual(completedWorker.settleOutcome, "completed");
        const normallyCompletedWork = yield* work.save({
          record: {
            ...completedWorking,
            state: "completed",
            slotHeld: false,
            admittedAt: null,
            admissionCommandId: null,
            admissionMessageId: null,
            admissionPreviousState: null,
            admissionPreviousSlotHeld: false,
            revision: completedWorking.revision + 1,
            updatedAt: now,
          },
          expectedRevision: completedWorking.revision,
        });
        assert.strictEqual(normallyCompletedWork.state, "completed");

        const beforeCompletedPause = yield* service.read(
          { hubId, planId: confirmed.id },
          { kind: "user" },
        );
        if (!beforeCompletedPause)
          throw new Error("Completed no-result plan disappeared before pause.");
        const pausedCompleted = yield* service.command(
          {
            action: "pause",
            hubId,
            planId: confirmed.id,
            requestId: "pause-completed-no-result-retry",
            expectedStateVersion: beforeCompletedPause.stateVersion,
            expectedRevision: beforeCompletedPause.revision,
          },
          { kind: "user" },
        );
        yield* execution().drain(hubId);
        assert.strictEqual(pausedCompleted.controlState, "pausing");
        const completedPausedSnapshot = yield* service.read(
          { hubId, planId: confirmed.id },
          { kind: "user" },
        );
        assert.strictEqual(completedPausedSnapshot?.controlState, "paused");
        assert.strictEqual((yield* work.get(newWork.id))?.state, "completed");
        const completedTaskAfterPause = yield* native.getTask(completedTaskOption.value.id);
        assert.strictEqual(Option.getOrNull(completedTaskAfterPause)?.status, "running");
        assert.strictEqual(
          (yield* native.listAttemptsForTask(completedTaskOption.value.id)).find(
            (attempt) => attempt.id === completedAttemptBinding.attemptId,
          )?.outcome,
          "running",
        );
        assert.isTrue(
          completedPausedSnapshot?.nodeStates.find((nodeState) => nodeState.nodeKey === "author")
            ?.retryable,
        );

        const resumedCompleted = yield* service.command(
          {
            action: "resume",
            hubId,
            planId: confirmed.id,
            requestId: "resume-completed-no-result-retry",
            expectedStateVersion: completedPausedSnapshot!.stateVersion,
            expectedRevision: completedPausedSnapshot!.revision,
          },
          { kind: "user" },
        );
        yield* execution().drain(hubId);
        assert.strictEqual(resumedCompleted.controlState, "active");
        assert.strictEqual((yield* work.list(hubId)).length, 2);
        assert.strictEqual((yield* work.get(newWork.id))?.state, "completed");
        const completedRetryView = yield* service.read(
          { hubId, planId: confirmed.id },
          { kind: "user" },
        );
        if (!completedRetryView)
          throw new Error("Completed no-result plan disappeared before explicit retry.");
        const explicitCompletedRetry = yield* service.command(
          {
            action: "retry",
            hubId,
            planId: confirmed.id,
            requestId: "retry-completed-no-result-attempt",
            expectedStateVersion: completedRetryView.stateVersion,
            expectedRevision: completedRetryView.revision,
            nodeKey: "author",
            stageKey: "draft",
            generation: 1,
            attemptId: ProjectTaskAttemptId.makeUnsafe(completedAttemptBinding.attemptId),
          },
          { kind: "user" },
        );
        assert.strictEqual(explicitCompletedRetry.controlState, "active");
        assert.strictEqual((yield* work.get(newWork.id))?.state, "completed");

        const currentSnapshot = yield* service.read(
          { hubId, planId: confirmed.id },
          { kind: "user" },
        );
        if (!currentSnapshot) throw new Error("Retried plan disappeared after dispatch.");
        const staleAttemptRetry = yield* Effect.exit(
          service.command(
            {
              ...retryInput,
              requestId: "retry-stale-attempt-after-rebind",
              expectedStateVersion: currentSnapshot.stateVersion,
              expectedRevision: currentSnapshot.revision,
            },
            { kind: "user" },
          ),
        );
        assert.isTrue(Exit.isFailure(staleAttemptRetry));
      }),
  );
});
