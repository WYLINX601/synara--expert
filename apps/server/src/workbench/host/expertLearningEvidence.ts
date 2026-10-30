import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  ExpertLearningEvidence,
  ModelSelection,
  TurnId,
  type ExpertLearningEvidence as ExpertLearningEvidenceType,
  type ExpertLearningEvidenceItem,
  type ProviderRuntimeEvent,
} from "@synara/contracts";
import { Effect, Option, Schema } from "effect";
import { readRunSkillAssembly } from "../../experts/RunSkillAssemblyStore.ts";
import {
  isLearningEvidenceRelevantEvent,
  learningEvidenceDeltaFromRuntimeEvent,
  learningEvidenceMessagesForTurn,
  LEARNING_EVIDENCE_TRANSCRIPT_TAIL_LIMIT,
  mergeLearningEvidenceItems,
} from "../../experts/evolution/LearningEvidence.ts";
import { ExpertLearningRepository } from "../../experts/evolution/ExpertLearningRepository.ts";
import { SkillEvolutionRepository } from "../../experts/evolution/SkillEvolutionRepository.ts";
import type { PersistedProviderRuntimeEvent } from "../../persistence/Services/ProviderRuntimeEvents.ts";
import { ExpertAppliedRuntimeRepository } from "../../persistence/Services/ExpertAppliedRuntimeRecords.ts";
import {
  ProjectionTurnRepository,
  type ProjectionTurnById,
} from "../../persistence/Services/ProjectionTurns.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ServerConfig } from "../../config.ts";
import { PersistenceDecodeError } from "../../persistence/Errors.ts";

interface EnabledLearningState {
  readonly ownerId: string;
  readonly ownerKind: string;
  readonly expertId: string;
  readonly enabled: true;
  readonly epoch: number;
  readonly revision: number;
  readonly harnessKind: "omp" | "pi";
  readonly enabledAt: string;
}

export type ExpertLearningEvidenceCapture = (
  entry: PersistedProviderRuntimeEvent,
  resolvedTurnId?: TurnId,
) => Effect.Effect<void, unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseEnabledLearningState(row: {
  readonly ownerId: string;
  readonly expertId: string;
  readonly record: string;
  readonly revision: number;
}): EnabledLearningState | undefined {
  let stored: unknown;
  try {
    stored = JSON.parse(row.record);
  } catch {
    return undefined;
  }
  if (!isRecord(stored) || !isRecord(stored.state)) return undefined;
  const state = stored.state;
  const ownerKind = stored.ownerKind;
  const enabledAt = stored.enabledAt;
  if (
    typeof row.ownerId !== "string" ||
    row.ownerId.length === 0 ||
    typeof ownerKind !== "string" ||
    ownerKind.length === 0 ||
    state.expertId !== row.expertId ||
    state.enabled !== true ||
    !Number.isSafeInteger(state.epoch) ||
    (state.epoch as number) < 0 ||
    !Number.isSafeInteger(state.revision) ||
    state.revision !== row.revision ||
    (state.harnessKind !== "omp" && state.harnessKind !== "pi") ||
    typeof enabledAt !== "string" ||
    !Number.isFinite(Date.parse(enabledAt))
  ) {
    return undefined;
  }
  return {
    ownerId: row.ownerId,
    ownerKind,
    expertId: row.expertId,
    enabled: true,
    epoch: state.epoch as number,
    revision: state.revision as number,
    harnessKind: state.harnessKind,
    enabledAt,
  };
}

function stableEvidenceId(input: {
  readonly ownerId: string;
  readonly expertId: string;
  readonly threadId: string;
  readonly turnId: string;
  readonly learningEpoch: number;
}): string {
  const identity = JSON.stringify([
    input.ownerId,
    input.expertId,
    input.threadId,
    input.turnId,
    input.learningEpoch,
  ]);
  return `le_${createHash("sha256").update(identity).digest("hex")}`;
}

function addCoverage(
  existing: ReadonlyArray<string>,
  incoming: ReadonlyArray<string>,
): ReadonlyArray<string> {
  const labels = [...new Set([...existing, ...incoming])];
  if (labels.length <= 32) return labels;
  return [...labels.slice(0, 31), "coverage-truncated"];
}

function buildModelSelection(input: {
  readonly event: ProviderRuntimeEvent;
  readonly appliedModel?: string | undefined;
  readonly actualInstanceId: string;
  readonly previous?: ExpertLearningEvidenceType | undefined;
}): Effect.Effect<ExpertLearningEvidenceType["modelSelection"] | undefined> {
  const provider = input.event.provider;
  if (provider !== "omp" && provider !== "pi") return Effect.succeed(undefined);
  const previousSelection = input.previous?.modelSelection;
  const eventModel =
    input.event.type === "turn.started"
      ? input.event.payload.model
      : input.event.type === "model.rerouted"
        ? input.event.payload.toModel
        : undefined;
  const model =
    eventModel ??
    input.appliedModel ??
    (previousSelection?.provider === provider &&
    previousSelection.instanceId === input.actualInstanceId
      ? previousSelection.model
      : undefined);
  const instanceId = input.actualInstanceId;
  if (!model) return Effect.succeed(undefined);
  const retainedOptions =
    previousSelection?.provider === provider &&
    previousSelection.instanceId === input.actualInstanceId
      ? previousSelection.options
      : undefined;
  const options =
    input.event.type === "turn.started" && input.event.payload.effort
      ? {
          ...(isRecord(retainedOptions) ? retainedOptions : {}),
          thinkingLevel: input.event.payload.effort,
        }
      : retainedOptions;
  try {
    return Effect.succeed(
      Schema.decodeUnknownSync(ModelSelection)({
        provider,
        instanceId,
        model,
        ...(options !== undefined ? { options } : {}),
      }),
    );
  } catch {
    return Effect.succeed(undefined);
  }
}

function isNormalCompletion(
  event: ProviderRuntimeEvent,
): event is Extract<ProviderRuntimeEvent, { type: "turn.completed" }> {
  return event.type === "turn.completed" && event.payload.state === "completed";
}

function isMalformedStoredEvidence(error: unknown): boolean {
  return (
    error instanceof SyntaxError ||
    error instanceof Schema.SchemaError ||
    (error instanceof Error && error.message === "学习证据记录与固定身份不匹配。")
  );
}

function isDecodeFailure(error: unknown): boolean {
  return (
    error instanceof SyntaxError ||
    Schema.isSchemaError(error) ||
    Schema.is(PersistenceDecodeError)(error)
  );
}

/**
 * Capture one accepted provider journal row into a bounded, idempotent turn record.
 * Services are read once while the ingestion layer is built so its worker fiber does not
 * depend on request-local context.
 */
export const makeExpertLearningEvidenceCapture = Effect.gen(function* () {
  const learningRepository = yield* Effect.serviceOption(ExpertLearningRepository);
  const skillEvolutionRepository = yield* Effect.serviceOption(SkillEvolutionRepository);
  const appliedRuntimeRepository = yield* Effect.serviceOption(ExpertAppliedRuntimeRepository);
  const turnRepository = yield* Effect.serviceOption(ProjectionTurnRepository);
  const projectionQuery = yield* Effect.serviceOption(ProjectionSnapshotQuery);
  const serverConfig = yield* Effect.serviceOption(ServerConfig);

  if (Option.isNone(learningRepository)) {
    return (_entry: PersistedProviderRuntimeEvent, _resolvedTurnId?: TurnId) => Effect.void;
  }
  const missingServices = [
    ...(!Option.isSome(skillEvolutionRepository) ? ["SkillEvolutionRepository"] : []),
    ...(!Option.isSome(appliedRuntimeRepository) ? ["ExpertAppliedRuntimeRepository"] : []),
    ...(!Option.isSome(turnRepository) ? ["ProjectionTurnRepository"] : []),
    ...(!Option.isSome(projectionQuery) ? ["ProjectionSnapshotQuery"] : []),
  ];
  if (missingServices.length > 0) {
    return yield* Effect.fail(
      new Error(
        `Expert learning evidence capture is enabled but required services are missing: ${missingServices.join(", ")}`,
      ),
    );
  }

  const capture: ExpertLearningEvidenceCapture = (entry, resolvedTurnId) =>
    Effect.gen(function* () {
      const event = entry.event;
      if (
        !Option.isSome(learningRepository) ||
        !Option.isSome(skillEvolutionRepository) ||
        !Option.isSome(appliedRuntimeRepository) ||
        !Option.isSome(turnRepository) ||
        !Option.isSome(projectionQuery) ||
        !isLearningEvidenceRelevantEvent(event)
      ) {
        return;
      }
      const skip = (reason: string) =>
        Effect.logDebug("expert learning evidence capture skipped", {
          eventId: event.eventId,
          eventType: event.type,
          threadId: event.threadId,
          reason,
        });
      let eventDelta;
      try {
        eventDelta = learningEvidenceDeltaFromRuntimeEvent(entry);
      } catch {
        yield* skip("runtime-event-learning-metadata-invalid");
        return;
      }
      if (
        eventDelta.items.length === 0 &&
        event.type !== "turn.started" &&
        event.type !== "turn.completed" &&
        event.type !== "model.rerouted"
      ) {
        return;
      }
      if (!resolvedTurnId) {
        yield* skip("orchestration-turn-unresolved");
        return;
      }

      const query = projectionQuery.value;
      const turnOption = yield* turnRepository.value
        .getByTurnId({ threadId: event.threadId, turnId: resolvedTurnId })
        .pipe(
          Effect.catch((error) =>
            isDecodeFailure(error)
              ? skip("projection-turn-decode-failed").pipe(
                  Effect.as(Option.none<ProjectionTurnById>()),
                )
              : Effect.fail(error),
          ),
        );
      const turn = Option.getOrUndefined(turnOption);
      if (!turn || turn.threadId !== event.threadId || turn.turnId !== resolvedTurnId) {
        yield* skip("projection-turn-not-found");
        return;
      }
      if (event.turnId === undefined) {
        const isTerminal = event.type === "turn.completed" || event.type === "turn.aborted";
        const turnBeganAt = turn.startedAt ?? turn.requestedAt;
        if (!isTerminal || Date.parse(event.createdAt) < Date.parse(turnBeganAt)) {
          yield* skip("turnless-event-cannot-be-attributed-safely");
          return;
        }
      }

      const shellOption = yield* query
        .getThreadShellById(event.threadId)
        .pipe(
          Effect.catch((error) =>
            isDecodeFailure(error)
              ? skip("thread-shell-decode-failed").pipe(Effect.as(Option.none()))
              : Effect.fail(error),
          ),
        );
      const shell = Option.getOrUndefined(shellOption);
      const binding = shell?.expertBinding;
      if (!shell || !binding || binding.expertId.length === 0 || binding.snapshotId.length === 0) {
        yield* skip("saved-expert-binding-unavailable");
        return;
      }

      const extraction = yield* skillEvolutionRepository.value
        .execution(event.threadId)
        .pipe(
          Effect.catch((error) =>
            isDecodeFailure(error)
              ? skip("skill-evolution-identity-decode-failed").pipe(Effect.as(null))
              : Effect.fail(error),
          ),
        );
      if (extraction === null) return;
      if (extraction !== undefined) {
        yield* skip("skill-evolution-extraction-thread");
        return;
      }

      const stateRows = yield* learningRepository.value
        .listStates()
        .pipe(
          Effect.catch((error) =>
            isDecodeFailure(error)
              ? skip("learning-state-decode-failed").pipe(Effect.as([]))
              : Effect.fail(error),
          ),
        );
      const matchingStateRows = stateRows.filter((row) => row.expertId === binding.expertId);
      if (matchingStateRows.length !== 1) {
        if (matchingStateRows.length > 1) {
          yield* skip("ambiguous-state-owner");
        } else {
          yield* skip("enabled-state-not-found");
        }
        return;
      }
      const state = parseEnabledLearningState(matchingStateRows[0]!);
      if (!state || !state.enabled) {
        yield* skip("learning-state-invalid-or-disabled");
        return;
      }
      if (
        state.expertId !== binding.expertId ||
        state.harnessKind !== event.provider ||
        (event.provider !== "omp" && event.provider !== "pi") ||
        shell.modelSelection.provider !== event.provider
      ) {
        yield* skip("provider-does-not-match-enabled-harness");
        return;
      }
      const requestInstanceId =
        typeof shell.modelSelection.instanceId === "string" &&
        shell.modelSelection.instanceId.length > 0
          ? shell.modelSelection.instanceId
          : undefined;
      const sessionInstanceId =
        shell.session?.providerName === event.provider
          ? shell.session.providerInstanceId
          : undefined;
      if (
        (event.providerInstanceId !== undefined &&
          requestInstanceId !== undefined &&
          event.providerInstanceId !== requestInstanceId) ||
        (sessionInstanceId !== undefined &&
          requestInstanceId !== undefined &&
          sessionInstanceId !== requestInstanceId) ||
        (event.providerInstanceId !== undefined &&
          sessionInstanceId !== undefined &&
          event.providerInstanceId !== sessionInstanceId)
      ) {
        yield* skip("provider-instance-identity-unavailable-or-mismatched");
        return;
      }
      const actualInstanceId = event.providerInstanceId ?? sessionInstanceId ?? requestInstanceId;
      if (!actualInstanceId) {
        yield* skip("provider-instance-identity-unavailable-or-mismatched");
        return;
      }
      const enabledAt = Date.parse(state.enabledAt);
      if (Date.parse(turn.requestedAt) < enabledAt || Date.parse(event.createdAt) < enabledAt) {
        yield* skip("turn-predates-learning-epoch");
        return;
      }

      const appliedOption = yield* appliedRuntimeRepository.value
        .getByThreadId({ threadId: event.threadId })
        .pipe(
          Effect.catch((error) =>
            isDecodeFailure(error)
              ? skip("applied-runtime-decode-failed").pipe(Effect.as(Option.none()))
              : Effect.fail(error),
          ),
        );
      const applied = Option.getOrUndefined(appliedOption);
      if (
        !applied ||
        applied.snapshotId !== binding.snapshotId ||
        applied.provider !== event.provider ||
        event.lifecycleGeneration === undefined ||
        applied.lifecycleGeneration !== event.lifecycleGeneration
      ) {
        yield* skip("applied-runtime-identity-mismatch");
        return;
      }

      const previousRootRunId = `run:${shell.id}:${turn.pendingMessageId ?? ""}`;
      const application = applied.skillApplication;
      let rootRunId: string | undefined;
      let assemblyId: string | undefined;
      const assemblyCoverage: string[] = [];
      if (
        Option.isSome(serverConfig) &&
        turn.pendingMessageId !== null &&
        application?.snapshotId === binding.snapshotId &&
        application.lifecycleGeneration === applied.lifecycleGeneration &&
        application.skillRootRunId === previousRootRunId &&
        typeof application.skillAssemblyId === "string"
      ) {
        const assembly = yield* Effect.tryPromise({
          try: () => readRunSkillAssembly(serverConfig.value.stateDir, previousRootRunId),
          catch: () => undefined,
        });
        if (
          assembly &&
          assembly.rootRunId === previousRootRunId &&
          assembly.threadId === shell.id &&
          assembly.baseSnapshotId === binding.snapshotId &&
          assembly.assemblyId === application.skillAssemblyId
        ) {
          rootRunId = assembly.rootRunId;
          assemblyId = assembly.assemblyId;
        } else {
          assemblyCoverage.push("run-assembly-unavailable");
        }
      } else {
        assemblyCoverage.push("run-assembly-unattributed");
      }

      const evidenceId = stableEvidenceId({
        ownerId: state.ownerId,
        expertId: binding.expertId,
        threadId: shell.id,
        turnId: resolvedTurnId,
        learningEpoch: state.epoch,
      });
      const previousRow = yield* learningRepository.value.readEvidence(evidenceId).pipe(
        Effect.catch((error) =>
          isMalformedStoredEvidence(error)
            ? Effect.logDebug("expert learning evidence skipped malformed stored row", {
                evidenceId,
                threadId: shell.id,
              }).pipe(Effect.as(undefined))
            : Effect.fail(error),
        ),
      );
      let previous: ExpertLearningEvidenceType | undefined;
      if (previousRow) {
        try {
          previous = Schema.decodeUnknownSync(ExpertLearningEvidence)(
            JSON.parse(previousRow.record),
          );
        } catch {
          yield* skip("malformed-stored-evidence");
          return;
        }
      }
      if (
        previous &&
        (previous.ownerId !== state.ownerId ||
          previous.expertId !== binding.expertId ||
          previous.threadId !== shell.id ||
          previous.turnId !== resolvedTurnId ||
          previous.learningEpoch !== state.epoch ||
          previous.snapshotId !== binding.snapshotId)
      ) {
        yield* skip("previous-evidence-identity-mismatch");
        return;
      }

      const delta = eventDelta;
      const coverage = [...delta.coverage, ...assemblyCoverage];
      let incomingItems: ReadonlyArray<ExpertLearningEvidenceItem> = delta.items;
      let messageHasUser = false;
      let messageHasAssistant = false;
      let completedAt = previous?.completedAt;
      if (isNormalCompletion(event) && turn.state === "completed") {
        const contextOption = yield* query
          .getThreadMentionContextById(shell.id, {
            messageLimit: LEARNING_EVIDENCE_TRANSCRIPT_TAIL_LIMIT,
          })
          .pipe(
            Effect.catch((error) =>
              isDecodeFailure(error)
                ? skip("turn-transcript-decode-failed").pipe(Effect.as(Option.none()))
                : Effect.fail(error),
            ),
          );
        const context = Option.getOrUndefined(contextOption);
        if (!context) {
          coverage.push("turn-transcript-unavailable");
        } else {
          const slice = learningEvidenceMessagesForTurn({
            messages: context.messages,
            turnId: resolvedTurnId,
            pendingMessageId: turn.pendingMessageId,
            transcriptWasTruncated: context.totalMessageCount > context.messages.length,
          });
          incomingItems = [...incomingItems, ...slice.items];
          coverage.push(...slice.coverage);
          messageHasUser =
            slice.hasUserMessage &&
            slice.items.some((item) => item.id === turn.pendingMessageId && item.role === "user");
          messageHasAssistant =
            slice.hasAssistantMessage &&
            turn.assistantMessageId !== null &&
            slice.items.some(
              (item) => item.id === turn.assistantMessageId && item.role === "assistant",
            );
          if (!messageHasUser) coverage.push("turn-request-message-missing");
          if (!messageHasAssistant) coverage.push("turn-assistant-message-missing");
          if (messageHasUser && messageHasAssistant) completedAt = event.createdAt;
        }
      }

      const mergedItems = mergeLearningEvidenceItems(previous?.items ?? [], incomingItems);
      if (mergedItems.truncated) coverage.push("items-truncated");
      const projectOption = yield* query
        .getProjectShellById(shell.projectId)
        .pipe(
          Effect.catch((error) =>
            isDecodeFailure(error)
              ? skip("project-shell-decode-failed").pipe(Effect.as(Option.none()))
              : Effect.fail(error),
          ),
        );
      const project = Option.getOrUndefined(projectOption);
      if (!project) coverage.push("space-identity-unavailable");
      if (previous && previous.spaceId !== (project?.spaceId ?? undefined)) {
        yield* skip("project-space-identity-changed");
        return;
      }
      const selectedModel = yield* buildModelSelection({
        event,
        appliedModel: applied.model,
        actualInstanceId,
        ...(previous !== undefined ? { previous } : {}),
      });
      if (!selectedModel) {
        yield* skip("actual-model-selection-unavailable");
        return;
      }

      const updatedAt =
        previous && Date.parse(previous.updatedAt) > Date.parse(event.createdAt)
          ? previous.updatedAt
          : event.createdAt;
      const record: ExpertLearningEvidenceType = {
        evidenceId,
        ownerId: state.ownerId,
        expertId: binding.expertId,
        learningEpoch: state.epoch,
        threadId: shell.id,
        turnId: resolvedTurnId,
        ...((rootRunId ?? previous?.rootRunId)
          ? { rootRunId: rootRunId ?? previous!.rootRunId }
          : {}),
        snapshotId: binding.snapshotId,
        ...((assemblyId ?? previous?.assemblyId)
          ? { assemblyId: assemblyId ?? previous!.assemblyId }
          : {}),
        projectId: shell.projectId,
        ...(project?.spaceId ? { spaceId: project.spaceId } : {}),
        modelSelection: selectedModel,
        items: mergedItems.items,
        coverage: addCoverage(previous?.coverage ?? [], coverage),
        ...(completedAt ? { completedAt } : {}),
        updatedAt,
      };
      try {
        Schema.decodeUnknownSync(ExpertLearningEvidence)(record);
      } catch {
        yield* skip("generated-evidence-schema-invalid");
        return;
      }
      if (previous && sameEvidenceContent(previous, record)) return;
      yield* learningRepository.value.writeEvidence({
        evidenceId,
        ownerId: state.ownerId,
        expertId: binding.expertId,
        threadId: shell.id,
        turnId: resolvedTurnId,
        record: JSON.stringify(record),
        updatedAt,
      });
    });

  return capture;
});

function sameEvidenceContent(
  left: ExpertLearningEvidenceType,
  right: ExpertLearningEvidenceType,
): boolean {
  const { updatedAt: _leftUpdatedAt, ...leftContent } = left;
  const { updatedAt: _rightUpdatedAt, ...rightContent } = right;
  return isDeepStrictEqual(leftContent, rightContent);
}
