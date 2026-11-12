import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  CommandId,
  type ExpertDelegation,
  type ExpertDelegationAttempt,
  type ProviderExpertSession,
  type SuiteRef,
} from "@synara/contracts";
import {
  OMP_NATIVE_EXPERT_METHODS,
  OmpNativeExpertProfile,
  OmpPrepareNativeTaskRequest,
  OmpNativeTaskStartedRequest,
  OmpNativeTaskEvent,
  OmpNativeTaskCredentialRequest,
  OmpNativeTaskObservation,
  OmpNativeTaskCancelAck,
  type OmpDelegationExecution,
  type OmpNativeTaskAck,
  type OmpPrepareNativeTaskResponse,
} from "@synara/contracts/omp/expertDelegation";
import { Effect, Layer, Option, Schema, ServiceMap } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ServerConfig } from "../../config";
import { AgentGatewayCredentials } from "../../agentGateway/Services/AgentGatewayCredentials";
import {
  ExpertDelegationStore,
  ExpertDelegationStoreError,
} from "../../workbench/host/expertDelegationStore";
import { ExpertDelegationArtifacts } from "../../workbench/host/expertDelegationArtifacts";
import { NativeExpertReexecutionGate } from "../../workbench/host/nativeExpertReexecutionGate";
import { createRunSkillAssemblyStore } from "../../experts/RunSkillAssemblyStore";
import { expertResourceFiles } from "../../experts/ExpertStore";
import { inspectFileResourceRoot } from "../../experts/FileResourceStore";
import { ExpertLearningRepository } from "../../experts/evolution/ExpertLearningRepository";
import { frozenLearningEntriesReader } from "../../experts/evolution/ExpertLearningState";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery";
import {
  SuiteCompositionStore,
  capabilityBindingFingerprint,
} from "../../suites/SuiteCompositionStore";
import { SuiteBindingResolver } from "../../suites/SuiteBindingResolver";
import { canonicalSuiteJson, suiteContentDigest } from "../../suites/suiteIdentity";
import { SpaceMemoryService } from "../../spaceMemory/SpaceMemoryService";
import { WorkbenchExpertRuntime } from "../../workbench/runtimeLayer";
import {
  prepareRuntimeKnowledge,
  verifyRuntimeKnowledge,
  renderRuntimeKnowledge,
} from "../../workbench/host/runtimeKnowledge";
import { ensurePrivateDirectorySync } from "../../privatePathPermissions";
import { renderSuiteRuntimeInstructions } from "../suiteRuntimeInstructions";
import { AcpRequestError } from "./AcpErrors";
import {
  OmpExpertExecutionStore,
  OmpExpertExecutionConflict,
  type OmpExpertIngress,
} from "./OmpExpertExecutionStore";
import type {
  OmpNativeExpertProtocol,
  OmpNativeExpertProtocolFactory,
} from "./OmpNativeExpertProtocol";

export interface OmpExpertDelegationHostShape {
  readonly protocolFactory: OmpNativeExpertProtocolFactory;
}
export class OmpExpertDelegationHost extends ServiceMap.Service<
  OmpExpertDelegationHost,
  OmpExpertDelegationHostShape
>()("synara/provider/omp/OmpExpertDelegationHost") {}

interface PromptScope {
  readonly rootRunId: string;
  readonly cursor: number;
  readonly abort: AbortController;
  accepting: boolean;
}
const normalize = (text: string) => text.normalize("NFC").replace(/\r\n?/gu, "\n").trim();
const ended = (attempt: ExpertDelegationAttempt) =>
  attempt.resultRef !== null ||
  attempt.state === "completed" ||
  attempt.state === "failed" ||
  attempt.state === "stopped";
const unavailable = (message = "The native Expert execution cannot be verified.") =>
  new ExpertDelegationStoreError(message, "execution_unknown");
const now = () => new Date().toISOString();

/** Owns authorization and receipts only. OMP's original Task remains the only executor. */
export const makeOmpExpertDelegationHost = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const config = yield* ServerConfig;
  const common = yield* ExpertDelegationStore;
  const executions = yield* OmpExpertExecutionStore;
  const suites = yield* SuiteCompositionStore;
  const resolver = yield* SuiteBindingResolver;
  const runtime = yield* WorkbenchExpertRuntime;
  const credentials = yield* AgentGatewayCredentials;
  const engine = yield* OrchestrationEngineService;
  const projection = yield* ProjectionSnapshotQuery;
  const memory = yield* SpaceMemoryService;
  const learning = yield* ExpertLearningRepository;
  const gate = yield* NativeExpertReexecutionGate;
  const artifacts = yield* ExpertDelegationArtifacts;
  const frozen = frozenLearningEntriesReader(learning);
  const runs = createRunSkillAssemblyStore(config.stateDir, {
    suiteStore: suites,
    frozenEntries: (expertId, bindings) => frozen(expertId, bindings ?? []),
  });
  const protocols = new Map<
    OmpNativeExpertProtocol,
    { readonly threadId: string; readonly generation: string }
  >();
  const opening = new Set<string>();
  const run = async <A, E>(effect: Effect.Effect<A, E>): Promise<A> => {
    const result = await Effect.runPromise(
      effect.pipe(
        Effect.match({
          onFailure: (error) => ({ ok: false as const, error }),
          onSuccess: (value) => ({ ok: true as const, value }),
        }),
      ),
    );
    if (!result.ok) throw result.error;
    return result.value;
  };
  const createProtocol: OmpNativeExpertProtocolFactory = async (context) => {
    const parent = Option.getOrUndefined(
      await run(projection.getThreadShellById(context.threadId)),
    );
    const expert = context.expertSession;
    if (
      !expert?.expertId ||
      !parent?.expertBinding ||
      parent.expertBinding.expertId !== expert.expertId ||
      parent.expertBinding.snapshotId !== expert.snapshotId
    )
      return null;
    for (const [protocol, owner] of protocols) {
      if (owner.threadId !== context.threadId) continue;
      if (owner.generation === context.generation)
        throw unavailable("This parent generation already owns an actual ACP connection.");
      await protocol.close();
    }
    if ((parent.capabilityBindingId ?? null) !== (context.capabilityBindingId ?? null))
      throw unavailable("The parent capability binding changed.");
    const parentBinding = context.capabilityBindingId
      ? await run(suites.readBinding(context.capabilityBindingId))
      : null;
    if (
      context.capabilityBindingId &&
      (!parentBinding ||
        parentBinding.bindingHash !== capabilityBindingFingerprint(parentBinding) ||
        parentBinding.projectId !== parent.projectId ||
        parentBinding.purpose.kind === "hub-coordinator" ||
        parentBinding.purpose.expertSnapshotId !== expert.snapshotId)
    )
      throw unavailable();
    const suite = parentBinding?.suite ?? null;
    const composition = suite ? await run(suites.read(suite)) : null;
    if (
      suite &&
      (!composition || !composition.members.some((member) => member.expertId === expert.expertId))
    )
      throw unavailable("The fixed parent is not a member of its Suite revision.");
    const workRoot = await fs.realpath(context.cwd);
    const targets = new Map<string, { expertId: string; suite: SuiteRef | null }>();
    const definitions = await runtime.experts.list();
    for (const definition of definitions) {
      if (definition.archived) continue;
      const name = `synara_expert_${suiteContentDigest({ expertId: definition.id }).slice(0, 32)}`;
      targets.set(name, {
        expertId: definition.id,
        suite: composition?.members.some((member) => member.expertId === definition.id)
          ? suite
          : null,
      });
    }
    const catalogParent = path.join(config.stateDir, "experts", "native-catalogs");
    ensurePrivateDirectorySync(catalogParent);
    const directory = await fs.mkdtemp(path.join(catalogParent, "omp-"));
    const agentDirectory = await fs.realpath(directory);
    const scopes = new Map<string, PromptScope>();
    const profiles = new Map<string, OmpPrepareNativeTaskResponse>();
    const preparing = new Map<
      string,
      { hash: string; promise: Promise<OmpPrepareNativeTaskResponse> }
    >();
    const events = new Map<string, { hash: string; promise: Promise<OmpNativeTaskAck> }>();
    const leases = new Map<string, Set<string>>();
    const retired = new Set<string>();
    const cancelledAttempts = new Set<string>();
    const cancelling = new Map<string, Promise<void>>();
    const abort = new AbortController();
    let actualSessionId: string | undefined;
    let accepting = true;
    let closed = false;
    let closing: Promise<void> | undefined;
    const currentGeneration = Effect.gen(function* () {
      const [row] = yield* sql<{
        readonly generation: string;
        readonly status: string;
      }>`SELECT lifecycle_generation AS generation, status FROM provider_session_runtime WHERE thread_id = ${context.threadId} AND provider_name = 'omp'`;
      return (
        row?.generation === context.generation && row.status !== "stopped" && row.status !== "error"
      );
    });
    const requireParent = async () => {
      if (closed || !accepting || !actualSessionId || !(await run(currentGeneration)))
        throw unavailable("The parent session generation is no longer accepting delegation.");
      const current = Option.getOrUndefined(
        await run(projection.getThreadShellById(context.threadId)),
      );
      if (
        !current ||
        current.archivedAt ||
        current.expertBinding?.snapshotId !== expert.snapshotId ||
        current.expertBinding.expertId !== expert.expertId ||
        current.projectId !== parent.projectId ||
        current.capabilityBindingId !== parent.capabilityBindingId
      )
        throw unavailable();
      return current;
    };
    const retire = async (attemptId: string) => {
      retired.add(attemptId);
      const tokens = [...(leases.get(attemptId) ?? [])];
      // Revoke the complete set before awaiting any request's cleanup.
      for (const token of tokens) credentials.revokeSessionToken(token);
      await Promise.all(
        tokens.map((token) => credentials.cancelSessionTurnRequests(token, attemptId)),
      );
      leases.delete(attemptId);
    };
    const audit = async (cause: unknown) => {
      if (cause instanceof OmpExpertExecutionConflict) await run(common.recordConflict(cause));
    };
    const checkAssociation = async (
      execution: OmpDelegationExecution,
      phases: readonly string[],
    ) => {
      const attempt = await run(common.readAttempt(execution.attemptId));
      const delegation = attempt ? await run(common.readDelegation(attempt.delegationId)) : null;
      const binding = attempt ? await run(suites.readBinding(attempt.capabilityBindingId)) : null;
      const assembly = await runs.read(execution.attemptId);
      if (
        !attempt ||
        !delegation ||
        !binding ||
        !assembly ||
        assembly.schemaVersion !== 2 ||
        !phases.includes(attempt.state) ||
        retired.has(attempt.attemptId) ||
        execution.parentThreadId !== context.threadId ||
        attempt.executionBindingId !== execution.executionBindingId ||
        binding.bindingHash !== capabilityBindingFingerprint(binding) ||
        binding.projectId !== parent.projectId ||
        binding.purpose.kind !== "native-delegate" ||
        binding.purpose.attemptId !== attempt.attemptId ||
        binding.purpose.delegationId !== delegation.delegationId ||
        binding.purpose.parentThreadId !== context.threadId ||
        binding.purpose.parentRootRunId !== delegation.parentRootRunId ||
        assembly.threadId !== context.threadId ||
        assembly.rootRunId !== attempt.attemptId ||
        assembly.bindingId !== binding.bindingId ||
        assembly.bindingHash !== binding.bindingHash ||
        assembly.assemblyId !== attempt.assemblyId ||
        assembly.baseSnapshotId !== binding.purpose.expertSnapshotId
      )
        throw unavailable();
      const session = await runs.sessionFor(assembly);
      if (!session || session.expertId !== delegation.targetExpertId) throw unavailable();
      return { attempt, delegation, binding, assembly, session };
    };
    const targetProof = (
      execution: OmpDelegationExecution,
      session: ProviderExpertSession,
      phases: readonly string[],
    ) => ({
      expertId: session.expertId!,
      snapshotId: session.snapshotId,
      projectId: parent.projectId,
      attemptId: execution.attemptId,
      assemblyId: session.skillAssemblyId!,
      verify: async () => {
        await checkAssociation(execution, phases);
        return !abort.signal.aborted;
      },
    });
    const admission = (scope: PromptScope) =>
      Effect.gen(function* () {
        if (
          !accepting ||
          closed ||
          !scope.accepting ||
          scope.abort.signal.aborted ||
          !(yield* currentGeneration)
        )
          return false;
        if (
          !engine.hasThreadStopAfter ||
          (yield* engine.hasThreadStopAfter(context.threadId, scope.cursor))
        )
          return false;
        const thread = Option.getOrUndefined(
          yield* projection.getThreadShellById(context.threadId),
        );
        return (
          !!thread &&
          !thread.archivedAt &&
          thread.projectId === parent.projectId &&
          thread.expertBinding?.snapshotId === expert.snapshotId
        );
      });
    const processIngress = async (ingress: OmpExpertIngress): Promise<OmpNativeTaskAck> => {
      if (ingress.acknowledgement) return ingress.acknowledgement;
      const event = ingress.event;
      const execution = await run(executions.read(event.attemptId));
      if (!execution || execution.parentThreadId !== context.threadId) throw unavailable();
      if (event.payload.kind === "progress") return run(executions.commitProgress(ingress));
      await retire(event.attemptId);
      const assembly = await runs.read(event.attemptId);
      if (assembly?.phase === "initializing" && assembly.initializationAttempt)
        await runs.finishInitialization(
          event.attemptId,
          assembly.initializationAttempt,
          new Error("The native execution ended before machine initialization proof."),
        );
      const attempt = await run(common.readAttempt(event.attemptId));
      const delegation = attempt ? await run(common.readDelegation(attempt.delegationId)) : null;
      if (!attempt || !delegation) throw unavailable();
      const content = {
        outcome: event.payload.outcome,
        result: event.payload.result,
        issue: event.payload.issue,
      };
      const resultHash = suiteContentDigest(content);
      await run(
        artifacts.prepare({
          attemptId: event.attemptId,
          resultHash,
          workRoot: execution.artifactRoot,
          artifacts: content.result.artifacts,
        }),
      );
      const scope =
        execution.parentGeneration === context.generation
          ? scopes.get(execution.parentTurnId)
          : undefined;
      // Filesystem lifecycle checks never run inside the Engine's event transaction.
      const currentRoot = await runs.current(context.threadId);
      const rootMatches = scope !== undefined && currentRoot?.rootRunId === scope.rootRunId;
      const canApplyToParent = () =>
        Effect.gen(function* () {
          if (
            execution.deliveryMode !== "host-continuation" ||
            !scope ||
            !scope.accepting ||
            !accepting ||
            closed ||
            !rootMatches ||
            cancelledAttempts.has(event.attemptId)
          )
            return false;
          const current = yield* common.readAttempt(event.attemptId);
          const [newer] =
            yield* sql`SELECT attempt_id FROM expert_delegation_attempts WHERE delegation_id = ${delegation.delegationId}
          AND rowid > (SELECT rowid FROM expert_delegation_attempts WHERE attempt_id = ${event.attemptId}) LIMIT 1`;
          if (
            !current ||
            current.state === "cancel-requested" ||
            current.resultRef !== null ||
            newer ||
            !(yield* admission(scope))
          )
            return false;
          return true;
        });
      await run(
        engine.dispatch(
          {
            type: "thread.expert-delegation.result",
            commandId: CommandId.makeUnsafe(
              `omp-expert-result:${event.attemptId}:${event.sequence}`,
            ),
            threadId: context.threadId,
            parentRootRunId: delegation.parentRootRunId,
            delegationId: delegation.delegationId,
            attemptId: event.attemptId,
            targetExpertId: delegation.targetExpertId,
            ...content,
            resultRef: `ndr_${event.attemptId}`,
            resultHash,
            applyToParent: false,
            createdAt: ingress.receivedAt,
          },
          {
            expertDelegationResult: {
              canApplyToParent,
              commit: (eventId) => executions.commitTerminal(ingress, eventId).pipe(Effect.asVoid),
            },
            ...(scope
              ? {
                  expertDelegationContinuation: {
                    parentRootRunId: scope.rootRunId,
                    delegationId: delegation.delegationId,
                    attemptId: event.attemptId,
                  },
                }
              : {}),
          },
        ),
      );
      const committed = await run(executions.receive(event, ingress.receivedAt));
      if (!committed.acknowledgement)
        throw unavailable("The result transaction did not commit its acknowledgement.");
      return committed.acknowledgement;
    };
    const receiveEvent = async (event: OmpNativeTaskEvent, recovered = false) => {
      const execution = await run(executions.read(event.attemptId));
      if (
        !actualSessionId ||
        !execution ||
        execution.parentThreadId !== context.threadId ||
        (!recovered &&
          (closed ||
            execution.parentGeneration !== context.generation ||
            event.parentGeneration !== context.generation))
      )
        throw unavailable();
      const key = `${event.attemptId}:${event.sequence}`;
      const hash = suiteContentDigest(event);
      const pending = events.get(key);
      if (pending) {
        if (pending.hash !== hash)
          throw new OmpExpertExecutionConflict(event.attemptId, pending.hash, hash, {
            kind: "inflight-sequence",
            sequence: event.sequence,
          });
        return pending.promise;
      }
      const promise = (async () => processIngress(await run(executions.receive(event, now()))))();
      events.set(key, { hash, promise });
      try {
        return await promise;
      } finally {
        if (events.get(key)?.promise === promise) events.delete(key);
      }
    };
    const query = async (execution: OmpDelegationExecution) => {
      const observation = Schema.decodeUnknownSync(OmpNativeTaskObservation)(
        await context.request(OMP_NATIVE_EXPERT_METHODS.query, {
          attemptId: execution.attemptId,
          nativeTaskId: execution.nativeTaskId,
        }),
      );
      if (observation.state === "terminal") {
        const event = observation.terminalEvent;
        if (
          observation.nativeSessionId !== execution.nativeSessionId ||
          event.attemptId !== execution.attemptId ||
          event.nativeTaskId !== execution.nativeTaskId ||
          event.parentGeneration !== execution.parentGeneration ||
          event.payload.kind !== "terminal"
        )
          throw unavailable(
            "The recovered terminal proof does not match its original started session.",
          );
        await receiveEvent(event, true);
      } else if (observation.state === "not-found") {
        const attempt = await run(common.readAttempt(execution.attemptId));
        if (attempt && !ended(attempt)) {
          await run(common.transition(attempt.attemptId, "unknown", now()));
          await retire(attempt.attemptId);
        }
      } else if (
        observation.nativeSessionId !== null &&
        observation.nativeSessionId !== execution.nativeSessionId
      ) {
        throw new OmpExpertExecutionConflict(
          execution.attemptId,
          suiteContentDigest(execution.nativeSessionId),
          suiteContentDigest(observation.nativeSessionId),
          { kind: "query-session" },
        );
      }
    };
    const prepareExisting = async (
      execution: OmpDelegationExecution,
      request: OmpPrepareNativeTaskRequest,
      requestHash: string,
    ): Promise<OmpPrepareNativeTaskResponse> => {
      const attempt = await run(common.readAttempt(execution.attemptId));
      const requestId = `nr_${suiteContentDigest({ key: { parentThreadId: context.threadId, parentGeneration: request.parentGeneration, parentTurnId: request.parentTurnId, toolCallId: request.toolCallId, taskIndex: request.taskIndex }, frame: request })}`;
      if (
        !attempt ||
        attempt.requestHash !== requestHash ||
        attempt.requestId !== requestId ||
        execution.nativeTaskId !== request.nativeTaskId ||
        execution.deliveryMode !== request.deliveryMode
      )
        throw new OmpExpertExecutionConflict(
          execution.attemptId,
          suiteContentDigest({
            requestId: attempt?.requestId,
            requestHash: attempt?.requestHash,
            nativeTaskId: execution.nativeTaskId,
            deliveryMode: execution.deliveryMode,
          }),
          suiteContentDigest({
            requestId,
            requestHash,
            nativeTaskId: request.nativeTaskId,
            deliveryMode: request.deliveryMode,
          }),
          { kind: "prepare-replay" },
        );
      if (ended(attempt))
        throw unavailable(
          `This request already has result ${attempt.resultRef}; read that immutable result instead of executing it again.`,
        );
      if (attempt.state === "unknown" || attempt.state === "cancel-requested")
        throw unavailable(
          `Execution ${attempt.attemptId} is ${attempt.state}; reconcile it or explicitly approve a new Task attempt. Replaying this request cannot run it again.`,
        );
      const cached = profiles.get(attempt.attemptId);
      if (cached) return cached;
      // A live SDK may have mutated its run-private roots. Never regenerate a
      // profile after loss of this protocol's immutable preparation cache.
      await run(common.transition(attempt.attemptId, "unknown", now()));
      await retire(attempt.attemptId);
      throw unavailable(
        "The original native preparation is no longer live; its execution outcome is unknown.",
      );
    };
    const prepare = async (
      request: OmpPrepareNativeTaskRequest,
    ): Promise<OmpPrepareNativeTaskResponse> => {
      await requireParent();
      const scope = scopes.get(request.parentTurnId);
      const target = targets.get(request.agentName);
      if (
        request.parentSessionId !== actualSessionId ||
        request.parentGeneration !== context.generation ||
        !scope?.accepting ||
        !target ||
        !(await run(admission(scope)))
      )
        throw unavailable();
      const key = {
        parentThreadId: context.threadId,
        parentGeneration: context.generation,
        parentTurnId: request.parentTurnId,
        toolCallId: request.toolCallId,
        taskIndex: request.taskIndex,
      };
      const business = {
        provider: "omp",
        targetExpertId: target.expertId,
        task: normalize(request.task),
        context: normalize(request.context),
        deliverable: normalize(request.deliverable),
        suite: target.suite,
      };
      const requestHash = suiteContentDigest(business);
      const frameHash = suiteContentDigest(request);
      const preparationKey = canonicalSuiteJson(key);
      const inflight = preparing.get(preparationKey);
      if (inflight) {
        if (inflight.hash !== frameHash) {
          // Do not share a profile with a conflicting caller. Wait until the
          // first caller's durable identity is available for conflict auditing.
          try {
            await inflight.promise;
          } catch {
            /* The original caller owns its failure. */
          }
          const existing = await run(executions.findPreparation(key));
          if (existing)
            throw new OmpExpertExecutionConflict(existing.attemptId, inflight.hash, frameHash, {
              kind: "inflight-prepare",
            });
          throw new ExpertDelegationStoreError(
            "A concurrent preparation has different content.",
            "result_conflict",
          );
        }
        return inflight.promise;
      }
      const promise = (async () => {
        const existing = await run(executions.findPreparation(key));
        if (existing) return prepareExisting(existing, request, requestHash);
        const currentRoot = await runs.current(context.threadId);
        if (currentRoot?.rootRunId !== scope.rootRunId)
          throw unavailable("The parent logical Run changed before preparation.");
        const all = await run(common.listForParent(context.threadId));
        const candidates: { attempt: ExpertDelegationAttempt; delegation: ExpertDelegation }[] = [];
        for (const recorded of all) {
          if (recorded.provider !== "omp" || ended(recorded)) continue;
          const delegation = await run(common.readDelegation(recorded.delegationId));
          if (
            !delegation ||
            delegation.targetExpertId !== target.expertId ||
            normalize(delegation.task) !== business.task
          )
            continue;
          const execution = await run(executions.read(recorded.attemptId));
          if (!execution) throw unavailable();
          const originalKey = canonicalSuiteJson({
            parentThreadId: execution.parentThreadId,
            parentGeneration: execution.parentGeneration,
            parentTurnId: execution.parentTurnId,
            toolCallId: execution.toolCallId,
            taskIndex: execution.taskIndex,
          });
          if (preparing.has(originalKey))
            throw unavailable(
              `The original request ${recorded.attemptId} is still being prepared; reconcile that request before repeating it.`,
            );
          // A source-side initialization/reporting failure can leave no terminal
          // packet. Observe the actual original owner before deciding on redo.
          await query(execution);
          const attempt = await run(common.readAttempt(recorded.attemptId));
          if (!attempt || ended(attempt)) continue;
          if (attempt.state !== "unknown")
            throw unavailable(
              `The original execution ${attempt.attemptId} is still ${attempt.state}; a second Task cannot silently repeat it.`,
            );
          // Only the latest admitted attempt can be offered for another redo.
          const [newer] = await run(
            sql`SELECT attempt_id FROM expert_delegation_attempts WHERE delegation_id = ${delegation.delegationId} AND rowid > (SELECT rowid FROM expert_delegation_attempts WHERE attempt_id = ${attempt.attemptId}) LIMIT 1`,
          );
          if (!newer) candidates.push({ attempt, delegation });
        }
        if (
          candidates.length > 1 ||
          candidates.some(({ attempt }) => attempt.requestHash !== requestHash)
        )
          throw unavailable(
            `Reconcile these unknown attempts before changing or repeating this work: ${candidates.map(({ attempt }) => attempt.attemptId).join(", ")}.`,
          );
        const previous = candidates[0];
        if (
          previous &&
          !(await gate.request({
            threadId: context.threadId,
            generation: context.generation,
            delegationId: previous.delegation.delegationId,
            previousAttemptId: previous.attempt.attemptId,
            expectedRevision: previous.attempt.revision,
            requestHash: previous.attempt.requestHash,
            targetExpertId: target.expertId,
            task: previous.delegation.task,
            signal: AbortSignal.any([abort.signal, scope.abort.signal]),
            publish: engine.dispatch,
          }))
        )
          throw unavailable("A new attempt was not explicitly approved.");
        const attemptId = `nda_${randomUUID()}`;
        const delegation: ExpertDelegation = previous?.delegation ?? {
          delegationId: `nd_${randomUUID()}`,
          parentThreadId: context.threadId,
          parentRootRunId: scope.rootRunId,
          targetExpertId: target.expertId,
          task: business.task,
          context: business.context,
          deliverable: business.deliverable,
        };
        const base = await runtime.experts.prepareSnapshot(target.expertId, {
          projectRoot: workRoot,
          allowMissingConnections: true,
        });
        const binding = await run(
          resolver.prepare({
            suite: target.suite,
            purpose: {
              kind: "native-delegate",
              parentThreadId: context.threadId,
              parentRootRunId: delegation.parentRootRunId,
              delegationId: delegation.delegationId,
              attemptId,
              expertSnapshotId: base.snapshotId,
            },
            projectId: parent.projectId,
            projectRoot: workRoot,
          }),
        );
        let assembly = await runs.prepare({
          threadId: context.threadId,
          rootRunId: attemptId,
          baseSnapshotId: base.snapshotId,
          capabilityBindingId: binding.bindingId,
          createdAt: now(),
          projectRoot: workRoot,
          bindThreadRoot: false,
        });
        const artifactParent = path.join(config.stateDir, "experts", "native-artifacts");
        ensurePrivateDirectorySync(artifactParent);
        const stage = path.join(artifactParent, attemptId);
        await fs.mkdir(stage, { mode: 0o700 });
        const artifactRoot = await fs.realpath(stage);
        const execution: OmpDelegationExecution = {
          ...key,
          executionBindingId: `nex_${randomUUID()}`,
          attemptId,
          provider: "omp",
          nativeTaskId: request.nativeTaskId,
          nativeSessionId: null,
          deliveryMode: request.deliveryMode,
          workRoot,
          artifactRoot,
          lastSequence: 0,
        };
        const attempt: ExpertDelegationAttempt = {
          attemptId,
          delegationId: delegation.delegationId,
          requestId: `nr_${suiteContentDigest({ key, frame: request })}`,
          requestHash,
          provider: "omp",
          capabilityBindingId: binding.bindingId,
          assemblyId: assembly.assemblyId,
          executionBindingId: execution.executionBindingId,
          state: "prepared",
          revision: 1,
          resultRef: null,
          resultHash: null,
          appliedEventId: null,
          updatedAt: now(),
        };
        const admitted = await run(
          executions.prepare({
            execution,
            delegation,
            attempt,
            admission: admission(scope),
            ...(previous
              ? {
                  previousUnknown: {
                    attemptId: previous.attempt.attemptId,
                    revision: previous.attempt.revision,
                    requestHash: previous.attempt.requestHash,
                  },
                }
              : {}),
          }),
        );
        if (admitted.attemptId !== attemptId)
          return prepareExisting(admitted, request, requestHash);
        try {
          let session = await runs.sessionFor(assembly);
          if (!session) throw unavailable();
          const knowledgeAssembly = await run(
            prepareRuntimeKnowledge({
              stateDir: config.stateDir,
              threadId: context.threadId,
              provider: "omp",
              assembly,
              sessionFor: runs.sessionFor,
              allowCreate: true,
              memory,
              learningRepository: learning,
              projection,
              targetBinding: targetProof(execution, session, ["prepared", "starting"]),
              attachKnowledge: runs.attachKnowledge,
            }),
          );
          if (knowledgeAssembly.schemaVersion !== 2)
            throw unavailable("Native targets require their own V2 assembly.");
          assembly = knowledgeAssembly;
          session = await runs.sessionFor(assembly);
          if (!session) throw unavailable();
          const manifest = await run(
            verifyRuntimeKnowledge({
              threadId: context.threadId,
              expertSession: session,
              memory,
              learningRepository: learning,
              projection,
              targetBinding: targetProof(execution, session, ["prepared", "starting"]),
            }),
          );
          const runtimeContext = await runs.runtimeContext(assembly);
          if (!runtimeContext) throw unavailable();
          const resourceRoots = new Map<string, { path: string; contentHash: string }>();
          const contextFiles = [];
          for (const root of runtimeContext.resourceRoots) {
            const verified = await inspectFileResourceRoot(root.path);
            resourceRoots.set(verified.rootPath, {
              path: verified.rootPath,
              contentHash: verified.contentHash,
            });
          }
          for (const reference of session.references) {
            const stat = await fs.lstat(reference);
            if (stat.isSymbolicLink()) throw unavailable("A target reference is a symbolic link.");
            if (stat.isDirectory()) {
              const verified = await inspectFileResourceRoot(reference);
              resourceRoots.set(verified.rootPath, {
                path: verified.rootPath,
                contentHash: verified.contentHash,
              });
            } else if (stat.isFile()) {
              // A single reference does not grant its siblings. Keep it a file
              // reference in the persona, not an automatically loaded instruction.
              await expertResourceFiles.read(reference);
            } else throw unavailable("A target reference is not a regular resource.");
          }
          for (const file of runtimeContext.contextFiles) {
            const canonical = await fs.realpath(file.path);
            const bytes = await expertResourceFiles.read(canonical);
            if (createHash("sha256").update(bytes).digest("hex") !== file.contentHash)
              throw unavailable("Fixed Suite instructions changed.");
            contextFiles.push({ path: canonical, contentHash: file.contentHash });
          }
          const skillEntries = await Promise.all(
            runtimeContext.skillEntries.map(async (entry) => {
              const canonical = await fs.realpath(entry.path);
              const bytes = await expertResourceFiles.read(canonical);
              if (entry.sha256 && createHash("sha256").update(bytes).digest("hex") !== entry.sha256)
                throw unavailable("A fixed target Skill changed.");
              return {
                ...entry,
                path: canonical,
                sha256: createHash("sha256").update(bytes).digest("hex"),
              };
            }),
          );
          const profile = Schema.decodeUnknownSync(OmpNativeExpertProfile)({
            protocolVersion: 1,
            attemptId,
            capabilityBindingId: binding.bindingId,
            assemblyId: assembly.assemblyId,
            targetAgentName: request.agentName,
            persona: [
              session.persona,
              renderSuiteRuntimeInstructions({ ...runtimeContext, contextFiles: [] }),
              manifest ? renderRuntimeKnowledge(manifest, { learningActionsAvailable: false }) : "",
            ]
              .filter(Boolean)
              .join("\n\n"),
            artifactRoot,
            skills: skillEntries.map(({ name, path: skillPath }) => ({ name, path: skillPath })),
            skillEntries,
            contextFiles,
            resourceRoots: [...resourceRoots.values()],
            mcpServers: [
              {
                name: "synara",
                url: credentials.mcpEndpointUrl,
                credentialHandle: `ncred_${suiteContentDigest({ attemptId, executionBindingId: execution.executionBindingId })}`,
              },
            ],
          });
          await runs.beginInitialization(attemptId);
          await run(
            sql.withTransaction(
              Effect.gen(function* () {
                if (!(yield* admission(scope))) return yield* Effect.fail(unavailable());
                const current = yield* common.readAttempt(attemptId);
                if (current?.state !== "prepared") return yield* Effect.fail(unavailable());
                yield* common.transition(attemptId, "starting", now());
              }),
            ),
          );
          const response = {
            attemptId,
            capabilityBindingId: binding.bindingId,
            assemblyId: assembly.assemblyId,
            profile,
          };
          profiles.set(attemptId, response);
          return response;
        } catch (cause) {
          const current = await run(common.readAttempt(attemptId));
          if (current && !ended(current) && current.state !== "cancel-requested")
            await run(common.transition(attemptId, "unknown", now()));
          await retire(attemptId);
          throw cause;
        }
      })();
      preparing.set(preparationKey, { hash: frameHash, promise });
      try {
        return await promise;
      } finally {
        if (preparing.get(preparationKey)?.promise === promise) preparing.delete(preparationKey);
      }
    };
    const cancelTask = (nativeTaskId: string): Promise<void> => {
      const pending = cancelling.get(nativeTaskId);
      if (pending) return pending;
      const promise = (async () => {
        const execution = await run(executions.findNative(nativeTaskId));
        if (
          !execution ||
          execution.parentThreadId !== context.threadId ||
          execution.parentGeneration !== context.generation
        )
          throw unavailable();
        retired.add(execution.attemptId);
        cancelledAttempts.add(execution.attemptId);
        const attempt = await run(common.readAttempt(execution.attemptId));
        if (!attempt) throw unavailable();
        if (!ended(attempt))
          await run(common.transition(attempt.attemptId, "cancel-requested", now()));
        await retire(execution.attemptId);
        if (ended(attempt)) return;
        try {
          Schema.decodeUnknownSync(OmpNativeTaskCancelAck)(
            await context.request(OMP_NATIVE_EXPERT_METHODS.cancel, {
              attemptId: execution.attemptId,
              nativeTaskId,
            }),
          );
          await query(execution);
        } finally {
          const current = await run(common.readAttempt(execution.attemptId));
          if (current && !ended(current))
            await run(common.transition(execution.attemptId, "unknown", now()));
        }
      })();
      cancelling.set(nativeTaskId, promise);
      return promise.finally(() => {
        if (cancelling.get(nativeTaskId) === promise) cancelling.delete(nativeTaskId);
      });
    };
    const protocol: OmpNativeExpertProtocol = {
      agentDirectory,
      targetAgentNames: [...targets.keys()],
      async bindSession(sessionId) {
        if (closed || !sessionId || (actualSessionId && actualSessionId !== sessionId))
          throw unavailable("The actual ACP session cannot be rebound.");
        if (actualSessionId) return;
        actualSessionId = sessionId;
        // Only durable ingress and actual terminal proofs are recoverable. A
        // running/not-found observation never restarts a model or restores a lease.
        for (const execution of await run(executions.listForParent(context.threadId))) {
          const attempt = await run(common.readAttempt(execution.attemptId));
          if (!attempt || ended(attempt)) continue;
          retired.add(attempt.attemptId);
          if (attempt.state !== "unknown")
            await run(common.transition(attempt.attemptId, "unknown", now()));
        }
        for (const ingress of await run(executions.pendingForParent(context.threadId)))
          await processIngress(ingress);
        for (const execution of await run(executions.listForParent(context.threadId))) {
          const attempt = await run(common.readAttempt(execution.attemptId));
          if (attempt && !ended(attempt)) {
            try {
              await query(execution);
            } catch (cause) {
              await audit(cause);
            }
          }
        }
      },
      async preparePrompt(input) {
        await requireParent();
        // This port is called by the bound Adapter immediately before its real
        // ACP prompt. Its turn.started event may not be projected yet.
        if (input.sessionId !== actualSessionId || !input.parentTurnId.trim())
          throw unavailable("The prompt does not belong to the actual parent session.");
        const root = await runs.current(context.threadId);
        if (
          !root ||
          root.rootRunId !== input.parentRootRunId ||
          root.baseSnapshotId !== expert.snapshotId ||
          (context.assemblyId && root.assemblyId !== context.assemblyId && scopes.size === 0)
        )
          throw unavailable("The prompt does not match its fixed parent Run.");
        const previous = scopes.get(input.parentTurnId);
        if (previous) {
          if (previous.rootRunId !== root.rootRunId || !previous.accepting)
            throw unavailable("A prompt's logical Run cannot be rebound.");
        } else
          scopes.set(input.parentTurnId, {
            rootRunId: root.rootRunId,
            cursor: await run(engine.getEventHighWaterSequence),
            abort: new AbortController(),
            accepting: true,
          });
        return {
          parentGeneration: context.generation,
          parentTurnId: input.parentTurnId,
          targetAgentNames: [...targets.keys()],
        };
      },
      async handleRequest(method, params) {
        try {
          if (method === OMP_NATIVE_EXPERT_METHODS.prepare)
            return await prepare(Schema.decodeUnknownSync(OmpPrepareNativeTaskRequest)(params));
          if (method === OMP_NATIVE_EXPERT_METHODS.started) {
            const input = Schema.decodeUnknownSync(OmpNativeTaskStartedRequest)(params);
            await requireParent();
            const execution = await run(executions.read(input.attemptId));
            const scope = execution ? scopes.get(execution.parentTurnId) : undefined;
            if (
              !execution ||
              execution.parentGeneration !== context.generation ||
              input.parentGeneration !== context.generation ||
              execution.nativeTaskId !== input.nativeTaskId ||
              !scope ||
              retired.has(input.attemptId)
            )
              throw unavailable();
            if (input.initializationComplete === true) {
              if (execution.nativeSessionId === null)
                throw unavailable("Initialization proof requires the original started session.");
              if (execution.nativeSessionId !== input.nativeSessionId)
                throw new OmpExpertExecutionConflict(
                  input.attemptId,
                  suiteContentDigest(execution.nativeSessionId),
                  suiteContentDigest(input.nativeSessionId),
                  { kind: "initialization-session" },
                );
              const association = await checkAssociation(execution, ["running"]);
              const token = association.assembly.initializationAttempt;
              if (
                !token ||
                (association.assembly.phase !== "initializing" &&
                  association.assembly.phase !== "ready")
              )
                throw unavailable("Native initialization has no matching original attempt.");
              if (association.assembly.phase !== "ready")
                await runs.finishInitialization(input.attemptId, token);
              // Stop may commit while the filesystem owner finishes its record.
              // Denying this ready ACK prevents the source from prompting.
              if (
                !(await run(admission(scope))) ||
                retired.has(input.attemptId) ||
                cancelledAttempts.has(input.attemptId)
              )
                throw unavailable();
              const current = await checkAssociation(execution, ["running"]);
              if (current.assembly.phase !== "ready") throw unavailable();
              return {
                attemptId: input.attemptId,
                nativeTaskId: input.nativeTaskId,
                nativeSessionId: input.nativeSessionId,
                disposition: "duplicate",
              };
            }
            await checkAssociation(execution, ["starting", "running"]);
            const started = await run(
              sql.withTransaction(
                Effect.gen(function* () {
                  if (!(yield* admission(scope))) return yield* Effect.fail(unavailable());
                  return yield* executions.started(input, now());
                }),
              ),
            );
            if (!started.mayRun || retired.has(input.attemptId) || !scope.accepting || !accepting)
              throw unavailable();
            return started.acknowledgement;
          }
          if (method === OMP_NATIVE_EXPERT_METHODS.event)
            return await receiveEvent(Schema.decodeUnknownSync(OmpNativeTaskEvent)(params));
          if (method === OMP_NATIVE_EXPERT_METHODS.credential) {
            const input = Schema.decodeUnknownSync(OmpNativeTaskCredentialRequest)(params);
            await requireParent();
            const execution = await run(executions.read(input.attemptId));
            const scope = execution ? scopes.get(execution.parentTurnId) : undefined;
            if (
              !execution ||
              !execution.nativeSessionId ||
              execution.parentGeneration !== context.generation ||
              input.parentGeneration !== context.generation ||
              execution.nativeTaskId !== input.nativeTaskId ||
              !scope?.accepting ||
              !(await run(admission(scope)))
            )
              throw unavailable();
            const association = await checkAssociation(execution, ["running"]);
            const handle = `ncred_${suiteContentDigest({ attemptId: execution.attemptId, executionBindingId: execution.executionBindingId })}`;
            if (input.credentialHandle !== handle)
              throw unavailable("The credential handle does not belong to this execution.");
            await run(
              verifyRuntimeKnowledge({
                threadId: context.threadId,
                expertSession: association.session,
                memory,
                learningRepository: learning,
                projection,
                targetBinding: targetProof(execution, association.session, ["running"]),
              }),
            );
            const mayIssue = await run(
              sql.withTransaction(
                Effect.gen(function* () {
                  if (!(yield* admission(scope))) return false;
                  const current = yield* common.readAttempt(input.attemptId);
                  return current?.state === "running";
                }),
              ),
            );
            if (
              !mayIssue ||
              !accepting ||
              closed ||
              !scope.accepting ||
              retired.has(input.attemptId)
            )
              throw unavailable();
            const expiresAt = Date.now() + 5 * 60_000;
            const token = credentials.issueSessionToken(context.threadId, "omp", {
              expiresAt,
              ...(association.session.knowledge
                ? { learningSession: association.session.knowledge }
                : {}),
              nativeExecution: {
                executionBindingId: execution.executionBindingId,
                attemptId: input.attemptId,
                capabilityBindingId: association.binding.bindingId,
                assemblyId: association.assembly.assemblyId,
                parentRootRunId: association.delegation.parentRootRunId,
              },
            });
            const tokens = leases.get(input.attemptId) ?? new Set<string>();
            for (const previous of tokens)
              if (credentials.verifySession(previous) === null) tokens.delete(previous);
            tokens.add(token);
            leases.set(input.attemptId, tokens);
            return {
              authorization: `Bearer ${token}`,
              expiresAt: new Date(expiresAt).toISOString(),
            };
          }
          throw new ExpertDelegationStoreError(
            "This private method is not a host ingress method.",
            "permission_denied",
          );
        } catch (cause) {
          await audit(cause);
          if (cause instanceof AcpRequestError) throw cause;
          const error =
            cause instanceof ExpertDelegationStoreError
              ? cause
              : new ExpertDelegationStoreError(
                  "The native Expert request is invalid or unavailable.",
                  "probe_error",
                  { cause },
                );
          throw new AcpRequestError({
            code: -32000,
            errorMessage: error.message,
            data: {
              code: error.code,
              category: "execution",
              subject: { kind: "execution", id: context.threadId, path: null },
              action: "run",
              effect: "deny-action",
              message: error.message,
              evidenceRef: null,
              checkedAt: now(),
              recovery: "reconcile",
            },
          });
        }
      },
      cancelTask,
      close() {
        if (closing) return closing;
        // Session closure is local authority cleanup. The Adapter's ACP scope
        // owns physical process-tree termination; an unresponsive native peer
        // must never hold that boundary behind a cancel/query response.
        closed = true;
        accepting = false;
        abort.abort();
        gate.cancelThread(context.threadId, context.generation);
        for (const scope of scopes.values()) {
          scope.accepting = false;
          scope.abort.abort();
        }
        closing = (async () => {
          try {
            const owned = await run(executions.listForParent(context.threadId, context.generation));
            const attemptIds = new Set([
              ...leases.keys(),
              ...owned.map((execution) => execution.attemptId),
            ]);
            const results = await Promise.allSettled(
              [...attemptIds].map(async (attemptId) => {
                cancelledAttempts.add(attemptId);
                try {
                  await retire(attemptId);
                } finally {
                  const attempt = await run(common.readAttempt(attemptId));
                  if (attempt && !ended(attempt))
                    await run(common.transition(attemptId, "unknown", now()));
                }
              }),
            );
            const failures = results.filter(
              (result): result is PromiseRejectedResult => result.status === "rejected",
            );
            if (failures.length)
              throw new AggregateError(
                failures.map((result) => result.reason),
                "Native Expert authority cleanup failed; unconfirmed executions remain unknown.",
              );
          } finally {
            try {
              await Promise.all([...leases.keys()].map(retire));
            } finally {
              await fs.rm(agentDirectory, { recursive: true, force: true });
              protocols.delete(protocol);
            }
          }
        })();
        return closing;
      },
    };
    try {
      await fs.mkdir(path.join(agentDirectory, "agents"), { mode: 0o700 });
      for (const [name, target] of targets) {
        const definition = definitions.find((item) => item.id === target.expertId)!;
        // Only discovery metadata lives here. The verified target profile, not
        // this Markdown, provides the actual SDK persona/resources/permissions.
        await fs.writeFile(
          path.join(agentDirectory, "agents", `${name}.md`),
          `---\nname: ${JSON.stringify(name)}\ndescription: ${JSON.stringify(`Synara Expert ${definition.id} (revision ${definition.revision}), ${definition.name}: ${definition.description}`)}\n---\n`,
          { mode: 0o400, flag: "wx" },
        );
      }
      protocols.set(protocol, { threadId: context.threadId, generation: context.generation });
      return protocol;
    } catch (cause) {
      await fs.rm(agentDirectory, { recursive: true, force: true });
      throw cause;
    }
  };
  const protocolFactory: OmpNativeExpertProtocolFactory = async (context) => {
    if (opening.has(context.threadId))
      throw unavailable("An actual parent ACP connection is already being prepared.");
    opening.add(context.threadId);
    try {
      return await createProtocol(context);
    } finally {
      opening.delete(context.threadId);
    }
  };
  yield* Effect.addFinalizer(() =>
    Effect.promise(async () => {
      const results = await Promise.allSettled(
        [...protocols.keys()].map((protocol) => protocol.close()),
      );
      const failures = results.filter(
        (result): result is PromiseRejectedResult => result.status === "rejected",
      );
      if (failures.length)
        throw new AggregateError(
          failures.map((result) => result.reason),
          "Native Expert host cleanup failed.",
        );
    }),
  );
  return { protocolFactory };
});
export const OmpExpertDelegationHostLive = Layer.effect(
  OmpExpertDelegationHost,
  makeOmpExpertDelegationHost,
);
