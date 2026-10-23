import { ProjectId, ProjectGoalId, ProjectTaskId, ThreadId } from "@synara/contracts";
import { Effect, Layer, Option, ServiceMap } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { makeHubPlanStore } from "../../hubCollaboration/HubPlanStore.ts";
import { makeHubPlanService } from "../../hubCollaboration/HubPlanService.ts";
import { ProjectAgentRepository } from "../../persistence/Services/ProjectAgentRepository.ts";
import { HubWorkRepository } from "../../persistence/Services/HubWorkRepository.ts";
import {
  ProjectAgentService,
  type ProjectAgentServiceShape,
} from "../../projectAgent/Services/ProjectAgentService.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { createExpertStore } from "../../experts/ExpertStore.ts";
import { ServerConfig } from "../../config.ts";
import { resolveHubWorkSource } from "../../agentGateway/hubWorkSource.ts";
import type { HubPlanServiceNativeCapabilities } from "../../hubCollaboration/HubPlanService.ts";
import type { HubPlanStore } from "../../hubCollaboration/HubPlanStore.ts";
import type { HubWorkRepositoryShape } from "../../persistence/Services/HubWorkRepository.ts";
import type { ProjectAgentRepositoryShape } from "../../persistence/Services/ProjectAgentRepository.ts";

export const makeHubPlanNodeFinalizer =
  (dependencies: {
    readonly store: HubPlanStore;
    readonly projectAgentRepository: ProjectAgentRepositoryShape;
    readonly workRepository: HubWorkRepositoryShape;
  }): HubPlanServiceNativeCapabilities["finalizePlanNode"] =>
  (input) =>
    Effect.gen(function* () {
      const binding = yield* dependencies.store.findAttemptBindingByWork({
        workItemId: input.workItemId,
      });
      if (
        !binding ||
        binding.planId !== input.planId ||
        binding.revision !== input.revision ||
        binding.nodeKey !== input.nodeKey ||
        binding.taskId !== input.taskId ||
        binding.attemptId !== input.attemptId
      ) {
        return yield* Effect.fail(new Error("Plan node finalization binding is stale."));
      }
      const [taskOption, workRecord, attempts, managedWorkerOption] = yield* Effect.all([
        dependencies.projectAgentRepository.getTask(input.taskId),
        dependencies.workRepository.get(input.workItemId),
        dependencies.projectAgentRepository.listAttemptsForTask(input.taskId),
        dependencies.projectAgentRepository.findManagedWorkerByThread(input.workerThreadId),
      ]);
      if (Option.isNone(taskOption) || !workRecord || Option.isNone(managedWorkerOption)) {
        return yield* Effect.fail(
          new Error("Plan node native task, work, or managed worker is missing."),
        );
      }
      const task = taskOption.value;
      const managedWorker = managedWorkerOption.value;
      const attempt = attempts.find((candidate) => candidate.id === input.attemptId);
      if (
        task.projectId !== input.hubId ||
        task.assignedThreadId !== input.workerThreadId ||
        managedWorker.projectId !== input.hubId ||
        managedWorker.threadId !== input.workerThreadId ||
        managedWorker.taskId !== task.id ||
        managedWorker.requestId !== input.workItemId ||
        workRecord.projectId !== input.hubId ||
        workRecord.workerThreadId !== input.workerThreadId ||
        (workRecord.state !== "working" && workRecord.state !== "completed") ||
        !attempt ||
        attempt.taskId !== task.id ||
        attempt.workerThreadId !== input.workerThreadId
      ) {
        return yield* Effect.fail(new Error("Plan node finalization identity is stale."));
      }
      if (task.status === "done" && attempt.outcome === "succeeded") return;
      if (
        (task.status !== "running" && task.status !== "review") ||
        attempt.outcome !== "running" ||
        managedWorker.resultAt !== null
      ) {
        return yield* Effect.fail(new Error("Plan node is no longer running."));
      }
      yield* dependencies.projectAgentRepository.saveTask(
        {
          ...task,
          status: "done",
          revision: task.revision + 1,
          updatedAt: input.submittedAt,
        },
        task.revision,
      );
      yield* dependencies.projectAgentRepository.saveAttempt({
        ...attempt,
        outcome: "succeeded",
        error: null,
        finishedAt: input.submittedAt,
      });
      yield* dependencies.projectAgentRepository.upsertManagedWorker({
        ...managedWorker,
        resultSummary: input.summary.slice(0, 4_000),
        resultAt: input.submittedAt,
        updatedAt: input.submittedAt,
      });
    });

export const makeHubPlanDeliverableValidator =
  (
    projectAgent: Pick<ProjectAgentServiceShape, "deliverables" | "resolvePrincipalForThread">,
  ): HubPlanServiceNativeCapabilities["validateDeliverables"] =>
  (hubId, refs, authorThreadId) =>
    Effect.gen(function* () {
      if (!projectAgent.deliverables)
        return yield* Effect.fail(new Error("Deliverable verification is unavailable."));
      const principal = yield* projectAgent.resolvePrincipalForThread(
        ThreadId.makeUnsafe(authorThreadId),
      );
      if (
        principal.kind !== "worker" ||
        principal.projectId !== hubId ||
        principal.threadId !== authorThreadId
      ) {
        return yield* Effect.fail(new Error("The candidate author is not a Worker in this Hub."));
      }
      for (const ref of refs) {
        if (
          ref.hubId !== hubId ||
          ref.workerThreadId !== authorThreadId ||
          ref.provenance.workerThreadId !== authorThreadId
        ) {
          return yield* Effect.fail(
            new Error("Candidate outputs must belong to this Hub's author attempt."),
          );
        }
        const actual = yield* projectAgent.deliverables.resolveReference(
          {
            projectId: ProjectId.makeUnsafe(hubId),
            ownerThreadId: ThreadId.makeUnsafe(authorThreadId),
            path: ref.file.path,
            revision: ref.revision,
          },
          principal,
        );
        if (
          actual.file.sha256 !== ref.file.sha256 ||
          actual.commitSha !== ref.commitSha ||
          actual.provenance.expertBindingSnapshotId !== ref.provenance.expertBindingSnapshotId
        ) {
          return yield* Effect.fail(
            new Error("The fixed candidate publication no longer matches its recorded digest."),
          );
        }
        // Resolve metadata and read the fixed file: missing/corrupt content must fail closed.
        yield* projectAgent.deliverables.read(
          {
            projectId: ProjectId.makeUnsafe(hubId),
            ownerThreadId: ThreadId.makeUnsafe(authorThreadId),
            path: ref.file.path,
            revision: ref.revision,
          },
          principal,
        );
      }
    });

export class HubPlanService extends ServiceMap.Service<
  HubPlanService,
  ReturnType<typeof makeHubPlanService>
>()("synara/HubPlanService") {}

export const HubPlanServiceLive = Layer.effect(
  HubPlanService,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const repository = yield* ProjectAgentRepository;
    const work = yield* HubWorkRepository;
    const projectAgent = yield* ProjectAgentService;
    const projection = yield* ProjectionSnapshotQuery;
    const config = yield* ServerConfig;
    const experts = createExpertStore(config.stateDir);
    const store = makeHubPlanStore(sql);
    const requireConfig = (hubId: string) =>
      repository.getConfig(ProjectId.makeUnsafe(hubId)).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.fail(new Error("Hub is not configured.")),
            onSome: Effect.succeed,
          }),
        ),
      );
    return makeHubPlanService({
      store,
      native: {
        readConfig: requireConfig,
        getActiveGoal: (id) =>
          repository.getActiveGoal(ProjectId.makeUnsafe(id)).pipe(Effect.map(Option.getOrNull)),
        getGoal: (id) =>
          repository.getGoal(ProjectGoalId.makeUnsafe(id)).pipe(Effect.map(Option.getOrNull)),
        getTask: (id) =>
          repository.getTask(ProjectTaskId.makeUnsafe(id)).pipe(Effect.map(Option.getOrNull)),
        readTasks: (goalId) =>
          repository.getGoal(ProjectGoalId.makeUnsafe(goalId)).pipe(
            Effect.flatMap((goal) =>
              Option.isSome(goal)
                ? repository.listTasks({
                    projectId: goal.value.projectId,
                    goalId: goal.value.id,
                    includeArchived: true,
                    limit: 128,
                  })
                : Effect.succeed([]),
            ),
          ),
        saveGoal: repository.saveGoal,
        saveTask: repository.saveTask,
        listAttempts: (id) => repository.listAttemptsForTask(ProjectTaskId.makeUnsafe(id)),
        saveAttempt: repository.saveAttempt,
        readManagedWorkerByThread: (threadId) =>
          repository.findManagedWorkerByThread(threadId).pipe(Effect.map(Option.getOrNull)),
        readWork: work.get,
        finalizePlanNode: makeHubPlanNodeFinalizer({
          store,
          projectAgentRepository: repository,
          workRepository: work,
        }),
        readSourceMessages: (hubId, sourceMessageIds) =>
          Effect.gen(function* () {
            const hub = yield* requireConfig(hubId);
            return yield* resolveHubWorkSource({
              snapshotQuery: projection,
              callerThreadId: hub.coordinatorThreadId,
              callerTurnId: null,
              contextMessageIds: sourceMessageIds,
            });
          }),
        freezeExperts: (ids) =>
          Effect.forEach(ids, (expertId) =>
            Effect.tryPromise({
              try: async () => {
                const binding = await experts.prepareSnapshot(expertId);
                return { expertId, snapshotId: binding.snapshotId, revision: binding.revision };
              },
              catch: (cause) => cause,
            }),
          ),
        validateDeliverables: makeHubPlanDeliverableValidator(projectAgent),
      },
    });
  }),
);
