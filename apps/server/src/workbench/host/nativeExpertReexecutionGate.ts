import { randomUUID } from "node:crypto";
import {
  ApprovalRequestId,
  CommandId,
  EventId,
  type ProviderApprovalDecision,
  ThreadId,
} from "@synara/contracts";
import { Effect, Layer, Option, ServiceMap } from "effect";
import type { OrchestrationEngineShape } from "../../orchestration/Services/OrchestrationEngine.ts";
import {
  ProjectionPendingInteractionRepository,
  type ProjectionPendingInteractionRepositoryShape,
} from "../../persistence/Services/ProjectionPendingInteractions.ts";
import { ExpertDelegationStore, type ExpertDelegationStoreShape } from "./expertDelegationStore.ts";

export const NATIVE_EXPERT_REEXECUTION_PREFIX = "native-expert-redo:";
const approvalLifetimeMs = 5 * 60_000;

export interface NativeExpertReexecutionRequest {
  readonly threadId: ThreadId;
  readonly generation: string;
  readonly delegationId: string;
  readonly previousAttemptId: string;
  readonly expectedRevision: number;
  /** The previous unknown attempt's hash, not the proposed new request's hash. */
  readonly requestHash: string;
  readonly targetExpertId: string;
  readonly task: string;
  readonly signal: AbortSignal;
  readonly publish: OrchestrationEngineShape["dispatch"];
}

export interface NativeExpertReexecutionGateShape {
  readonly request: (input: NativeExpertReexecutionRequest) => Promise<boolean>;
  /** Only the existing human-interaction owner calls this, after its durable claim. */
  readonly respond: (
    threadId: ThreadId,
    requestId: string,
    decision: ProviderApprovalDecision,
  ) => Promise<boolean>;
  readonly cancelThread: (threadId: ThreadId, generation?: string) => void;
}

export class NativeExpertReexecutionGate extends ServiceMap.Service<
  NativeExpertReexecutionGate,
  NativeExpertReexecutionGateShape
>()("synara/experts/NativeExpertReexecutionGate") {}

interface PendingConsent {
  readonly input: NativeExpertReexecutionRequest;
  readonly createdAt: string;
  readonly answer: (decision: ProviderApprovalDecision) => void;
  readonly settled: Promise<void>;
  readonly signalCancellation: () => void;
  cancelled: boolean;
  responding: boolean;
}

/** A live callback barrier only. Neither a restart nor a new turn restores a grant. */
export function makeNativeExpertReexecutionGate(dependencies: {
  readonly delegations: Pick<ExpertDelegationStoreShape, "readAttempt" | "readDelegation">;
  readonly interactions: Pick<ProjectionPendingInteractionRepositoryShape, "getByIdentity">;
}): NativeExpertReexecutionGateShape {
  const pending = new Map<string, PendingConsent>();
  const matchesUnknown = async (input: NativeExpertReexecutionRequest): Promise<boolean> => {
    const attempt = await Effect.runPromise(
      dependencies.delegations.readAttempt(input.previousAttemptId),
    );
    const delegation = await Effect.runPromise(
      dependencies.delegations.readDelegation(input.delegationId),
    );
    return (
      attempt !== null &&
      delegation !== null &&
      attempt.attemptId === input.previousAttemptId &&
      attempt.delegationId === input.delegationId &&
      attempt.state === "unknown" &&
      attempt.revision === input.expectedRevision &&
      attempt.requestHash === input.requestHash &&
      attempt.provider === "omp" &&
      attempt.resultRef === null &&
      attempt.resultHash === null &&
      attempt.appliedEventId === null &&
      delegation.delegationId === input.delegationId &&
      delegation.parentThreadId === input.threadId &&
      delegation.targetExpertId === input.targetExpertId
    );
  };
  const cancel = (entry: PendingConsent) => {
    entry.cancelled = true;
    entry.answer("cancel");
    entry.signalCancellation();
  };
  return {
    cancelThread(threadId, generation) {
      for (const entry of pending.values()) {
        if (
          entry.input.threadId === threadId &&
          (generation === undefined || entry.input.generation === generation)
        )
          cancel(entry);
      }
    },
    async request(rawInput) {
      // Capture server-owned identity once; callbacks may not mutate a pending consent's scope.
      const input = { ...rawInput };
      if (input.signal.aborted) return false;
      let threadCount = 0;
      for (const entry of pending.values()) {
        if (entry.input.threadId !== input.threadId) continue;
        threadCount += 1;
        if (entry.input.previousAttemptId === input.previousAttemptId) {
          throw new Error("A reexecution decision for this unknown attempt is already pending.");
        }
      }
      if (pending.size >= 128 || threadCount >= 8) {
        throw new Error("Too many Expert reexecution approvals are waiting.");
      }
      const requestId = `${NATIVE_EXPERT_REEXECUTION_PREFIX}${randomUUID()}`;
      const createdAt = new Date().toISOString();
      const { promise: answered, resolve: answer } =
        Promise.withResolvers<ProviderApprovalDecision>();
      const { promise: settled, resolve: settle, reject: fail } = Promise.withResolvers<void>();
      const { promise: cancelled, resolve: signalCancellation } = Promise.withResolvers<void>();
      // A request can fail without a response owner waiting on its settlement.
      void settled.catch(() => undefined);
      const entry: PendingConsent = {
        input,
        createdAt,
        answer,
        settled,
        signalCancellation,
        cancelled: false,
        responding: false,
      };
      pending.set(requestId, entry);
      const abort = () => cancel(entry);
      input.signal.addEventListener("abort", abort, { once: true });
      const timeout = setTimeout(abort, approvalLifetimeMs);
      timeout.unref?.();
      let opened = false;
      let settlementAttempted = false;
      let resolvedAt: string | undefined;
      const publish = async (decision?: ProviderApprovalDecision) => {
        const eventKey = `${requestId}:${decision === undefined ? "open" : "resolved"}`;
        const at = decision === undefined ? createdAt : (resolvedAt ??= new Date().toISOString());
        if (decision !== undefined) settlementAttempted = true;
        await Effect.runPromise(
          input.publish({
            type: "thread.activity.append",
            commandId: CommandId.makeUnsafe(eventKey),
            threadId: input.threadId,
            activity: {
              id: EventId.makeUnsafe(eventKey),
              tone: "info",
              kind: decision === undefined ? "approval.requested" : "approval.resolved",
              summary:
                decision === undefined
                  ? "Run this Expert task again?"
                  : "Expert reexecution approval resolved",
              payload: {
                requestId,
                lifecycleGeneration: input.generation,
                requestKind: "tool",
                requestType: "tool",
                toolName: "native_expert_reexecute",
                detail:
                  "The previous attempt's outcome is unknown and it may still be running. Running again can duplicate external side effects. Approve only after checking the previous execution.",
                toolParamsDisplay: [
                  {
                    name: "targetExpertId",
                    display_name: "Target Expert",
                    value: input.targetExpertId,
                  },
                  { name: "task", display_name: "Task to run again", value: input.task },
                  {
                    name: "previousAttemptId",
                    display_name: "Previous unknown attempt",
                    value: input.previousAttemptId,
                  },
                ],
                sessionApprovalAvailable: false,
                ...(decision === undefined ? {} : { decision }),
              },
              // This host-owned question survives a naturally completed parent turn.
              turnId: null,
              createdAt: at,
            },
            createdAt: at,
          }),
        );
      };
      try {
        if (!(await matchesUnknown(input)) || entry.cancelled || input.signal.aborted) {
          settle();
          return false;
        }
        const opening = publish();
        const published = await Promise.race([
          opening.then(() => true),
          cancelled.then(() => false),
        ]);
        if (!published) {
          // A cancelled caller must not hang on publication. If its open command
          // later commits (or its ACK was lost), dismiss it in the same owner flow.
          void opening
            .then(
              () => publish("cancel"),
              () => publish("cancel"),
            )
            .catch(() => undefined);
          settle();
          return false;
        }
        opened = true;
        if (input.signal.aborted) cancel(entry);
        const decision = await answered;
        const accepted =
          decision === "accept" &&
          (await matchesUnknown(input)) &&
          !entry.cancelled &&
          !input.signal.aborted;
        // Settlement is a required durable barrier, not a best-effort UI dismissal.
        await publish(accepted ? "accept" : decision === "decline" ? "decline" : "cancel");
        const authorized =
          accepted && (await matchesUnknown(input)) && !entry.cancelled && !input.signal.aborted;
        settle();
        return authorized;
      } catch (cause) {
        if (opened && !settlementAttempted) await publish("cancel").catch(() => undefined);
        fail(cause);
        throw cause;
      } finally {
        pending.delete(requestId);
        clearTimeout(timeout);
        input.signal.removeEventListener("abort", abort);
      }
    },
    async respond(threadId, requestId, decision) {
      const entry = pending.get(requestId);
      if (!entry || entry.input.threadId !== threadId || entry.responding || entry.cancelled)
        return false;
      // Synchronous take before any await: one human response can release only one request.
      entry.responding = true;
      try {
        const row = Option.getOrUndefined(
          await Effect.runPromise(
            dependencies.interactions.getByIdentity({
              threadId,
              interactionKind: "approval",
              requestId: ApprovalRequestId.makeUnsafe(requestId),
            }),
          ),
        );
        if (
          !row ||
          row.status !== "responding" ||
          row.responseCommandId === null ||
          row.responseRequestedAt === null ||
          row.lifecycleGeneration !== entry.input.generation ||
          row.createdAt !== entry.createdAt ||
          row.decision !== decision ||
          entry.cancelled ||
          entry.input.signal.aborted ||
          !(await matchesUnknown(entry.input))
        ) {
          cancel(entry);
          await entry.settled;
          return false;
        }
        // Session-wide consent is never authority for this gate, even from an old client.
        entry.answer(decision === "acceptForSession" ? "decline" : decision);
        await entry.settled;
        return true;
      } catch (cause) {
        cancel(entry);
        throw cause;
      }
    },
  };
}

export const NativeExpertReexecutionGateLive = Layer.effect(
  NativeExpertReexecutionGate,
  Effect.gen(function* () {
    const delegations = yield* ExpertDelegationStore;
    const interactions = yield* ProjectionPendingInteractionRepository;
    const gate = makeNativeExpertReexecutionGate({ delegations, interactions });
    const shutdown = new AbortController();
    yield* Effect.addFinalizer(() => Effect.sync(() => shutdown.abort()));
    return {
      ...gate,
      request: (input: NativeExpertReexecutionRequest) =>
        gate.request({
          ...input,
          signal: AbortSignal.any([input.signal, shutdown.signal]),
        }),
    };
  }),
);
