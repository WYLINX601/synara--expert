import {
  CommandId,
  DEFAULT_PROJECT_AGENT_LIMITS,
  HubWorkProgress,
  HubWorkRecord,
  SynaraCreateThreadSpec,
  SynaraResolvedCreateThreadSpec,
  hubWorkItem,
  type HubWorkItem,
  type HubWorkProgressStep,
  type HubWorkSourceMessage,
  type HubWorkState,
  type ProjectId,
  type ThreadId,
  type TurnId,
} from "@synara/contracts";
import { Effect, Option, Schema } from "effect";

import { stableGatewayDigest } from "../agentGateway/creationUtils";
import { parseHubReferenceUri } from "@synara/shared/hubReferences";
import type { ProjectionSnapshotQueryShape } from "../orchestration/Services/ProjectionSnapshotQuery";
import type { OrchestrationCommandReceiptRepositoryShape } from "../persistence/Services/OrchestrationCommandReceipts";
import type { ProjectionThreadMessageRepositoryShape } from "../persistence/Services/ProjectionThreadMessages";
import type { ProjectionTurnRepositoryShape } from "../persistence/Services/ProjectionTurns";
import type { QueuedTurnPromotionRepositoryShape } from "../persistence/Services/QueuedTurnPromotions";
import {
  HubWorkRepositoryError,
  type HubWorkRepositoryShape,
} from "../persistence/Services/HubWorkRepository";
import type { ProjectAgentRepositoryShape } from "../persistence/Services/ProjectAgentRepository";
import { ProjectAgentServiceError } from "./Errors";
import { resolveHubWorkLifecycle } from "./hubWorkLifecycle";
import { reserveHubWorkAdmission, rollbackHubWorkAdmission } from "./hubWorkAdmission.ts";
import { resolveHubTargetProjectId } from "./hubTarget";
import { GROUPS_BETA_ONLY_MESSAGE, isServerGroupsEnabled } from "./groupsBetaGate";
import type { ProjectAgentPrincipal } from "./principal";
import type { ProjectAgentServiceShape } from "./Services/ProjectAgentService";

type HubWorkDependencies = {
  readonly repository: HubWorkRepositoryShape;
  readonly projectAgentService: Pick<
    ProjectAgentServiceShape,
    "resolvePrincipalForThread" | "assertCallerMayCreateThreadInProject" | "notifyWorkItemChanged"
  >;
  readonly projectAgentRepository: ProjectAgentRepositoryShape;
  readonly messages?: Pick<ProjectionThreadMessageRepositoryShape, "getByThreadAndMessageId">;
  readonly projectionTurns?: Pick<ProjectionTurnRepositoryShape, "getByTurnId">;
  readonly commandReceipts?: Pick<OrchestrationCommandReceiptRepositoryShape, "getByCommandId">;
  readonly snapshotQuery?: Pick<ProjectionSnapshotQueryShape, "getThreadShellsByIds">;
  readonly resolveCreationSpec?: (input: {
    readonly callerThreadId: ThreadId;
    readonly targetProjectId: ProjectId;
    readonly spec: SynaraCreateThreadSpec;
  }) => Effect.Effect<SynaraResolvedCreateThreadSpec, unknown>;
  readonly queuedTurnPromotions?: Pick<QueuedTurnPromotionRepositoryShape, "listPendingThreadIds">;
  readonly planExecution?: {
    readonly assertWorkAllowed: (record: HubWorkRecord) => Effect.Effect<void, unknown>;
    readonly authorizeInputResponseFollowup?: (input: {
      readonly inputRequestId: string;
      readonly threadId: ThreadId;
      readonly commandId: string;
      readonly messageId: string;
    }) => Effect.Effect<void, unknown>;
  };
};

export interface HubWorkSubmitInput {
  readonly callerThreadId: ThreadId;
  readonly callerTurnId?: TurnId;
  readonly requestId: string;
  readonly sourceMessages: readonly HubWorkSourceMessage[];
  readonly tasks: readonly {
    readonly spec: SynaraCreateThreadSpec;
    readonly title?: string;
  }[];
}

export interface HubWorkService {
  readonly submit: (
    input: HubWorkSubmitInput,
  ) => Effect.Effect<
    { readonly items: readonly HubWorkRecord[]; readonly replayed: boolean },
    ProjectAgentServiceError
  >;
  readonly claimNext: (
    projectId: ProjectId,
  ) => Effect.Effect<HubWorkRecord | null, ProjectAgentServiceError>;
  readonly reconcile: (projectId: ProjectId) => Effect.Effect<void, ProjectAgentServiceError>;
  readonly admitFollowup: (input: {
    readonly threadId: ThreadId;
    readonly commandId: string;
    readonly messageId: string;
    readonly inputRequestId?: string | undefined;
  }) => Effect.Effect<HubWorkRecord | null, ProjectAgentServiceError>;
  readonly releaseFailedFollowup: (input: {
    readonly workItemId: string;
    readonly admittedAt: string | null;
    readonly expectedRevision: number;
    readonly commandId: string;
  }) => Effect.Effect<void, ProjectAgentServiceError>;
  readonly recoverFollowupAdmissions: (
    projectId: ProjectId,
  ) => Effect.Effect<void, ProjectAgentServiceError>;
  readonly attachWorker: (input: {
    readonly workItemId: string;
    readonly workerThreadId: ThreadId;
  }) => Effect.Effect<HubWorkRecord, ProjectAgentServiceError>;
  readonly setState: (input: {
    readonly workItemId: string;
    readonly state: HubWorkState;
    readonly resultSummary?: string | null;
  }) => Effect.Effect<HubWorkRecord, ProjectAgentServiceError>;
  readonly updateProgress: (input: {
    readonly callerThreadId: ThreadId;
    readonly workItemId: string;
    readonly expectedRevision: number;
    readonly steps: readonly HubWorkProgressStep[];
    readonly summary?: string;
  }) => Effect.Effect<HubWorkRecord, ProjectAgentServiceError>;
  readonly cancel: (
    input: { readonly workItemId: string },
    principal: ProjectAgentPrincipal,
  ) => Effect.Effect<HubWorkRecord, ProjectAgentServiceError>;
  readonly list: (
    projectId: ProjectId,
    principal: ProjectAgentPrincipal,
  ) => Effect.Effect<readonly HubWorkItem[], ProjectAgentServiceError>;
}

const fail = (message: string, code: ProjectAgentServiceError["code"] = "forbidden") =>
  new ProjectAgentServiceError({ message, code });
const serviceError = (cause: unknown) =>
  cause instanceof ProjectAgentServiceError
    ? cause
    : new ProjectAgentServiceError({
        message: cause instanceof Error ? cause.message : "Could not update hub work.",
        code:
          cause instanceof HubWorkRepositoryError && cause.code === "conflict"
            ? "conflict"
            : undefined,
        cause,
      });
const inactiveStates = new Set<HubWorkState>([
  "queued",
  "idle",
  "completed",
  "failed",
  "cancelled",
]);

export function makeHubWorkService(dependencies: HubWorkDependencies): HubWorkService {
  const { repository, projectAgentService, projectAgentRepository } = dependencies;

  const requireConfig = (projectId: ProjectId) =>
    Effect.gen(function* () {
      if (!isServerGroupsEnabled()) return yield* Effect.fail(fail(GROUPS_BETA_ONLY_MESSAGE));
      const config = yield* projectAgentRepository
        .getConfig(projectId)
        .pipe(Effect.mapError(serviceError));
      if (Option.isNone(config)) return yield* Effect.fail(fail("Hub was not found.", "not-found"));
      return config.value;
    });

  const requireRecord = (id: string) =>
    Effect.gen(function* () {
      const record = yield* repository.get(id).pipe(Effect.mapError(serviceError));
      if (!record) return yield* Effect.fail(fail("Hub work was not found.", "not-found"));
      yield* requireConfig(record.projectId);
      return record;
    });

  const notify = (record: HubWorkRecord) =>
    (
      projectAgentService.notifyWorkItemChanged?.({
        projectId: record.projectId,
        workItemId: record.id,
      }) ?? Effect.void
    ).pipe(
      Effect.catch((error) =>
        Effect.logWarning("Hub work notification failed after persistence", {
          workItemId: record.id,
          error,
        }),
      ),
    );

  const save = (record: HubWorkRecord, update: Partial<HubWorkRecord>) =>
    repository
      .save({
        record: {
          ...record,
          ...update,
          revision: record.revision + 1,
          updatedAt: new Date().toISOString(),
        },
        expectedRevision: record.revision,
      })
      .pipe(Effect.mapError(serviceError), Effect.tap(notify));

  const restoreFollowupAdmission = (record: HubWorkRecord) =>
    rollbackHubWorkAdmission(repository, record).pipe(
      Effect.mapError(serviceError),
      Effect.tap(notify),
    );

  const assertProject = (projectId: ProjectId, principal: ProjectAgentPrincipal) => {
    if (principal.kind !== "user" && principal.projectId !== projectId)
      return Effect.fail(fail("Cross-hub access is blocked."));
    return Effect.void;
  };

  return {
    submit: (input) =>
      Effect.gen(function* () {
        const principal = yield* projectAgentService.resolvePrincipalForThread(
          input.callerThreadId,
        );
        if (principal.kind !== "coordinator")
          return yield* Effect.fail(fail("Only the hub coordinator can submit work."));
        for (const source of input.sourceMessages) {
          for (const mention of source.references ?? []) {
            const reference = parseHubReferenceUri(mention.path);
            if (!reference) {
              return yield* Effect.fail(
                fail("A selected Hub reference is malformed or unsupported.", "invalid"),
              );
            }
            if (reference.kind === "deliverable" && reference.hubId !== principal.projectId) {
              return yield* Effect.fail(
                fail("Hub work cannot carry a deliverable reference from another Hub."),
              );
            }
          }
        }
        const config = yield* requireConfig(principal.projectId);
        if (config.collaboration !== undefined) {
          return yield* Effect.fail(
            fail(
              "New-mode Hub work must be authorized by a confirmed collaboration plan.",
              "forbidden",
            ),
          );
        }
        if (!config.enabled || config.pausedAt !== null || config.archivedAt !== null)
          return yield* Effect.fail(fail("Resume this hub before starting work.", "conflict"));
        if (
          input.tasks.length === 0 ||
          input.tasks.length >
            Math.min(
              config.limits.maxNewWorkersPerTurn,
              DEFAULT_PROJECT_AGENT_LIMITS.maxNewWorkersPerTurn,
            )
        ) {
          return yield* Effect.fail(
            fail("The hub work plan exceeds the per-turn task limit.", "limit"),
          );
        }
        if (
          input.sourceMessages.length === 0 ||
          input.sourceMessages.some((message) => message.threadId !== config.coordinatorThreadId)
        ) {
          return yield* Effect.fail(
            fail("Hub work requires original messages from this coordinator conversation."),
          );
        }
        const orderedSources = input.sourceMessages.toSorted((left, right) =>
          left.messageId < right.messageId ? -1 : left.messageId > right.messageId ? 1 : 0,
        );
        const sourceDigest = stableGatewayDigest(orderedSources, 64);
        const scopeKey = `source:${sourceDigest}`;
        const fingerprint = stableGatewayDigest(
          { sourceMessages: input.sourceMessages, tasks: input.tasks },
          64,
        );
        // Replay lookup precedes Expert reads and model discovery. Once accepted,
        // template edits and archiving must not change or invalidate the frozen
        // target/binding returned for the same source request.
        const existingRecords = yield* repository
          .list(principal.projectId)
          .pipe(Effect.mapError(serviceError));
        const sameRequest = existingRecords.filter(
          (record) => record.requestId === input.requestId,
        );
        const sameScope = existingRecords.filter((record) => record.scopeKey === scopeKey);
        const replay = sameRequest.length > 0 ? sameRequest : sameScope;
        if (replay.length > 0) {
          if (
            replay.length !== input.tasks.length ||
            replay.some(
              (record) => record.scopeKey !== scopeKey || record.fingerprint !== fingerprint,
            )
          ) {
            return yield* Effect.fail(
              fail("This request already has a different hub work plan.", "conflict"),
            );
          }
          // Keep the repository's request-ID conflict ledger in sync when a
          // semantically identical source request arrives with a new wake ID.
          const result = yield* repository
            .submit(
              replay.map((record) => ({
                ...record,
                requestId: input.requestId,
              })),
            )
            .pipe(Effect.mapError(serviceError));
          yield* Effect.forEach(result.items, notify, { discard: true });
          return result;
        }
        for (const task of input.tasks) {
          if (
            task.spec.expertId !== undefined &&
            !(config.expertIds ?? []).includes(task.spec.expertId)
          ) {
            return yield* Effect.fail(
              fail("This Expert does not participate in the current Hub.", "forbidden"),
            );
          }
        }
        const now = new Date().toISOString();
        const records: HubWorkRecord[] = [];
        const sourceById = new Map<string, HubWorkSourceMessage>(
          input.sourceMessages.map((source) => [source.messageId, source]),
        );
        for (const [taskIndex, task] of input.tasks.entries()) {
          const sourceIds = task.spec.contextMessageIds;
          const taskSources = sourceIds
            ? sourceIds.flatMap((id) => {
                const source = sourceById.get(id);
                return source ? [source] : [];
              })
            : input.sourceMessages;
          if (
            taskSources.length === 0 ||
            (sourceIds &&
              (new Set(sourceIds).size !== sourceIds.length ||
                sourceIds.length !== taskSources.length))
          )
            return yield* Effect.fail(
              fail("Task context references must belong to this frozen source request.", "invalid"),
            );
          const targetProjectId = resolveHubTargetProjectId({
            hubId: principal.projectId,
            sourceProjectId: config.sourceProjectId,
            targetProjectId: task.spec.projectId,
          });
          yield* projectAgentService.assertCallerMayCreateThreadInProject({
            callerThreadId: input.callerThreadId,
            targetProjectId,
          });
          const creationSpec = dependencies.resolveCreationSpec
            ? yield* dependencies
                .resolveCreationSpec({
                  callerThreadId: input.callerThreadId,
                  targetProjectId,
                  spec: task.spec,
                })
                .pipe(Effect.mapError(serviceError))
            : task.spec.expertId !== undefined || task.spec.target === undefined
              ? yield* Effect.fail(
                  fail(
                    task.spec.expertId
                      ? "Hub Expert dispatch is unavailable."
                      : "A target is required for a plain worker.",
                    "invalid",
                  ),
                )
              : yield* Schema.decodeUnknownEffect(SynaraResolvedCreateThreadSpec)({
                  ...task.spec,
                  target: task.spec.target,
                }).pipe(Effect.mapError(serviceError));
          const record = yield* Schema.decodeUnknownEffect(HubWorkRecord)({
            id: `hub-work:${stableGatewayDigest({ projectId: principal.projectId, scopeKey, taskIndex }, 40)}`,
            projectId: principal.projectId,
            ...(input.callerTurnId ? { delegationTurnId: input.callerTurnId } : {}),
            targetProjectId,
            requestId: input.requestId,
            scopeKey,
            fingerprint,
            taskIndex,
            sourceThreadId: config.coordinatorThreadId,
            sourceMessageId: taskSources[0]!.messageId,
            sourceMessages: taskSources,
            creationSpec,
            title:
              (task.title ?? task.spec.title ?? task.spec.prompt.split("\n")[0] ?? "Task")
                .trim()
                .slice(0, 240) || "Task",
            workerThreadId: null,
            state: "queued",
            queueReason: "Waiting for an available worker slot",
            resultSummary: null,
            progress: null,
            slotHeld: false,
            admittedAt: null,
            admissionCommandId: null,
            admissionMessageId: null,
            admissionPreviousState: null,
            admissionPreviousSlotHeld: false,
            revision: 0,
            createdAt: now,
            updatedAt: now,
          }).pipe(Effect.mapError(serviceError));
          records.push(record);
        }
        const result = yield* repository
          .submit(records, { expectedConfigRevision: config.revision })
          .pipe(Effect.mapError(serviceError));
        yield* Effect.forEach(result.items, notify, { discard: true });
        return result;
      }),

    claimNext: (projectId) =>
      Effect.gen(function* () {
        if (!isServerGroupsEnabled()) return null;
        const config = yield* requireConfig(projectId);
        let claimed: HubWorkRecord | null = null;
        if (config.collaboration === undefined) {
          claimed = yield* repository.claimNext(projectId).pipe(Effect.mapError(serviceError));
        } else {
          if (!dependencies.planExecution) {
            return yield* Effect.fail(
              fail("Plan execution is unavailable for this Hub.", "forbidden"),
            );
          }
          const queued = (yield* repository
            .list(projectId)
            .pipe(Effect.mapError(serviceError))).filter((record) => record.state === "queued");
          for (const record of queued) {
            const gate = yield* Effect.exit(dependencies.planExecution.assertWorkAllowed(record));
            if (gate._tag === "Failure") continue;
            claimed = yield* repository
              .claimNext(projectId, record.id)
              .pipe(Effect.mapError(serviceError));
            if (claimed) break;
          }
        }
        if (claimed) yield* notify(claimed);
        return claimed;
      }),

    admitFollowup: (input) =>
      Effect.gen(function* () {
        const record = yield* repository
          .findByWorker(input.threadId)
          .pipe(Effect.mapError(serviceError));
        if (!record) return null;
        const config = yield* requireConfig(record.projectId);
        if (config.collaboration !== undefined) {
          if (
            !input.inputRequestId ||
            !dependencies.planExecution?.authorizeInputResponseFollowup
          ) {
            return yield* Effect.fail(
              fail(
                "Plan workers can only resume through an answered directed input request.",
                "forbidden",
              ),
            );
          }
          yield* dependencies.planExecution
            .authorizeInputResponseFollowup({
              inputRequestId: input.inputRequestId,
              threadId: input.threadId,
              commandId: input.commandId,
              messageId: input.messageId,
            })
            .pipe(Effect.mapError(serviceError));
        }
        if (!config.enabled || config.pausedAt !== null || config.archivedAt !== null)
          return yield* Effect.fail(fail("Resume this hub before starting work.", "conflict"));
        if (record.state === "cancelled")
          return yield* Effect.fail(fail("This hub task was cancelled.", "conflict"));
        yield* projectAgentService.assertCallerMayCreateThreadInProject({
          callerThreadId: config.coordinatorThreadId,
          targetProjectId: record.targetProjectId,
        });
        if (record.admissionCommandId === input.commandId) {
          if (record.admissionMessageId !== input.messageId) {
            return yield* Effect.fail(
              fail(
                "This Hub work admission command is already bound to another message.",
                "conflict",
              ),
            );
          }
          return record;
        }
        const admitted = yield* reserveHubWorkAdmission(repository, input).pipe(
          Effect.mapError(serviceError),
        );
        if (!admitted) {
          return yield* Effect.fail(
            fail("All hub worker slots are busy. Try again when a worker finishes.", "limit"),
          );
        }
        yield* notify(admitted);
        return admitted;
      }),

    releaseFailedFollowup: (input) =>
      Effect.gen(function* () {
        const record = yield* requireRecord(input.workItemId);
        if (
          record.state !== "starting" ||
          record.admissionCommandId !== input.commandId ||
          record.admittedAt !== input.admittedAt
        )
          return;
        if (dependencies.commandReceipts) {
          const receipt = yield* dependencies.commandReceipts
            .getByCommandId({
              commandId: CommandId.makeUnsafe(input.commandId),
            })
            .pipe(Effect.mapError(serviceError));
          if (Option.isSome(receipt) && receipt.value.status === "accepted") return;
        }
        yield* restoreFollowupAdmission(record);
      }),

    recoverFollowupAdmissions: (projectId) =>
      Effect.gen(function* () {
        if (!isServerGroupsEnabled() || !dependencies.commandReceipts) return;
        yield* requireConfig(projectId);
        const records = yield* repository.list(projectId).pipe(Effect.mapError(serviceError));
        for (const record of records) {
          if (record.state !== "starting" || !record.workerThreadId || !record.admissionCommandId)
            continue;
          const receipt = yield* dependencies.commandReceipts
            .getByCommandId({
              commandId: CommandId.makeUnsafe(record.admissionCommandId),
            })
            .pipe(Effect.mapError(serviceError));
          if (Option.isNone(receipt) || receipt.value.status === "rejected") {
            yield* restoreFollowupAdmission(record);
          }
        }
      }),

    reconcile: (projectId) =>
      Effect.gen(function* () {
        if (!isServerGroupsEnabled()) return;
        const config = yield* requireConfig(projectId);
        const records = yield* repository.list(projectId).pipe(Effect.mapError(serviceError));
        const queued = records.filter((record) => record.state === "queued");
        if (queued.length) {
          const linkedIds = new Set(
            yield* projectAgentRepository
              .listLinkedProjectIds(projectId)
              .pipe(Effect.mapError(serviceError)),
          );
          for (const record of queued) {
            const queueReason =
              !config.enabled || config.pausedAt !== null || config.archivedAt !== null
                ? "Resume this hub before starting work"
                : record.targetProjectId !== projectId && !linkedIds.has(record.targetProjectId)
                  ? "Link this repository before starting"
                  : "Waiting for an available worker slot";
            if (record.queueReason !== queueReason)
              yield* save(record, { queueReason }).pipe(
                Effect.catchIf(
                  (error) => error.code === "conflict",
                  () => Effect.void,
                ),
              );
          }
        }
        if (!dependencies.snapshotQuery || !dependencies.queuedTurnPromotions) return;
        const mapped = records.filter((record) => record.workerThreadId !== null);
        if (mapped.length === 0) return;
        const shells = yield* dependencies.snapshotQuery
          .getThreadShellsByIds(mapped.map((record) => record.workerThreadId!))
          .pipe(Effect.mapError(serviceError));
        const pending = new Set(
          yield* dependencies.queuedTurnPromotions.listPendingThreadIds.pipe(
            Effect.mapError(serviceError),
          ),
        );
        const workers = yield* projectAgentRepository
          .listManagedWorkers(projectId)
          .pipe(Effect.mapError(serviceError));
        const shellById = new Map(shells.map((shell) => [shell.id, shell]));
        const workerById = new Map(workers.map((worker) => [worker.threadId, worker]));
        for (const record of mapped) {
          if (
            record.state !== "cancelled" &&
            record.admissionCommandId &&
            dependencies.commandReceipts
          ) {
            const receipt = yield* dependencies.commandReceipts
              .getByCommandId({
                commandId: CommandId.makeUnsafe(record.admissionCommandId),
              })
              .pipe(Effect.mapError(serviceError));
            if (Option.isNone(receipt)) continue;
            if (receipt.value.status === "rejected") {
              yield* restoreFollowupAdmission(record);
              continue;
            }
          }
          const admissionMessage =
            record.admissionMessageId && dependencies.messages
              ? yield* dependencies.messages
                  .getByThreadAndMessageId({
                    threadId: record.workerThreadId!,
                    messageId: record.admissionMessageId,
                  })
                  .pipe(Effect.mapError(serviceError), Effect.map(Option.getOrNull))
              : null;
          const workerShell = shellById.get(record.workerThreadId!) ?? null;
          let resolvedAdmissionTurn = null;
          if (
            admissionMessage?.startsNewTurn === true &&
            admissionMessage.turnId === null &&
            record.admittedAt !== null &&
            record.admissionMessageId !== null &&
            workerShell?.latestTurn?.state === "completed" &&
            workerShell.latestTurn.completedAt !== null &&
            workerShell.latestTurn.completedAt >= record.admittedAt &&
            dependencies.projectionTurns
          ) {
            const nativeTurn = yield* dependencies.projectionTurns
              .getByTurnId({
                threadId: record.workerThreadId!,
                turnId: workerShell.latestTurn.turnId,
              })
              .pipe(Effect.mapError(serviceError), Effect.map(Option.getOrNull));
            if (
              nativeTurn?.threadId === record.workerThreadId &&
              nativeTurn.turnId === workerShell.latestTurn.turnId &&
              nativeTurn.pendingMessageId === record.admissionMessageId
            ) {
              resolvedAdmissionTurn = nativeTurn;
            }
          }
          const update = resolveHubWorkLifecycle({
            record,
            shell: workerShell,
            worker: workerById.get(record.workerThreadId!) ?? null,
            hasPendingTurn: pending.has(record.workerThreadId!),
            admissionMessage,
            resolvedAdmissionTurn,
          });
          if (
            update &&
            Object.entries(update).some(
              ([key, value]) => record[key as keyof HubWorkRecord] !== value,
            )
          ) {
            yield* save(record, update).pipe(
              Effect.catchIf(
                (error) => error.code === "conflict",
                () => Effect.void,
              ),
            );
          }
        }
      }),

    attachWorker: (input) =>
      Effect.gen(function* () {
        const record = yield* requireRecord(input.workItemId);
        if (dependencies.planExecution) {
          yield* dependencies.planExecution
            .assertWorkAllowed(record)
            .pipe(Effect.mapError(serviceError));
        } else {
          const config = yield* requireConfig(record.projectId);
          if (config.collaboration !== undefined) {
            return yield* Effect.fail(
              fail("Plan execution is unavailable for this Hub.", "forbidden"),
            );
          }
        }
        if (record.workerThreadId === input.workerThreadId) return record;
        if (record.workerThreadId !== null || record.state !== "starting")
          return yield* Effect.fail(fail("This hub task is not awaiting a worker.", "conflict"));
        return yield* save(record, {
          workerThreadId: input.workerThreadId,
          state: "working",
          queueReason: null,
        });
      }),

    setState: (input) =>
      Effect.gen(function* () {
        const record = yield* requireRecord(input.workItemId);
        if (record.state === "cancelled" && input.state !== "cancelled") return record;
        const resultSummary =
          input.resultSummary === undefined ? record.resultSummary : input.resultSummary;
        if (record.state === input.state && record.resultSummary === resultSummary) return record;
        if (
          input.state === "starting" ||
          (input.state === "queued" && record.workerThreadId !== null)
        )
          return yield* Effect.fail(fail("Use admission before starting hub work.", "conflict"));
        return yield* save(record, {
          state: input.state,
          resultSummary,
          slotHeld: inactiveStates.has(input.state) ? false : record.slotHeld,
        });
      }),

    updateProgress: (input) =>
      Effect.gen(function* () {
        const record = yield* requireRecord(input.workItemId);
        if (dependencies.planExecution) {
          yield* dependencies.planExecution
            .assertWorkAllowed(record)
            .pipe(Effect.mapError(serviceError));
        } else if ((yield* requireConfig(record.projectId)).collaboration !== undefined) {
          return yield* Effect.fail(
            fail("Plan execution is unavailable for this Hub.", "forbidden"),
          );
        }
        const principal = yield* projectAgentService.resolvePrincipalForThread(
          input.callerThreadId,
        );
        yield* assertProject(record.projectId, principal);
        if (record.workerThreadId !== input.callerThreadId || principal.kind !== "worker")
          return yield* Effect.fail(fail("Only this task's worker can update its progress."));
        const revision = record.progress?.revision ?? 0;
        if (input.expectedRevision !== revision)
          return yield* Effect.fail(fail("Progress changed. Reload and retry.", "conflict"));
        if (new Set(input.steps.map((step) => step.id)).size !== input.steps.length)
          return yield* Effect.fail(fail("Progress step identifiers must be unique.", "invalid"));
        const progress = yield* Schema.decodeUnknownEffect(HubWorkProgress)({
          revision: revision + 1,
          steps: input.steps,
          ...(input.summary !== undefined ? { summary: input.summary } : {}),
        }).pipe(Effect.mapError(serviceError));
        return yield* save(record, { progress });
      }),

    cancel: (input, principal) =>
      Effect.gen(function* () {
        const record = yield* requireRecord(input.workItemId);
        yield* assertProject(record.projectId, principal);
        const config = yield* requireConfig(record.projectId);
        if (config.collaboration !== undefined) {
          if (!dependencies.planExecution) {
            return yield* Effect.fail(
              fail("Plan execution is unavailable; plan-bound work cannot be cancelled directly."),
            );
          }
          yield* dependencies.planExecution
            .assertWorkAllowed(record)
            .pipe(Effect.mapError(serviceError));
          return yield* Effect.fail(
            fail("Plan-bound work must be stopped through Hub plan controls."),
          );
        }
        if (principal.kind !== "user" && principal.kind !== "coordinator")
          return yield* Effect.fail(fail("Only the user or coordinator can cancel queued work."));
        if (record.state === "cancelled") return record;
        if (record.state !== "queued" && record.state !== "idle")
          return yield* Effect.fail(
            fail("Stop the active worker before cancelling this task.", "conflict"),
          );
        return yield* save(record, {
          state: "cancelled",
          slotHeld: false,
          queueReason: null,
        });
      }),

    list: (projectId, principal) =>
      Effect.gen(function* () {
        yield* assertProject(projectId, principal);
        yield* requireConfig(projectId);
        return (yield* repository.list(projectId).pipe(Effect.mapError(serviceError))).map(
          hubWorkItem,
        );
      }),
  };
}
