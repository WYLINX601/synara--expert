import type { OrchestrationEvent, ProjectId, ThreadId } from "@synara/contracts";
import { makeDrainableWorker, startDrainableWorkerProducers } from "@synara/shared/DrainableWorker";
import { Cause, Duration, Effect, Layer, Schedule, Stream } from "effect";

import {
  PROJECT_AGENT_WORKER_HEALTH_INTERVAL_MS,
  isWorkerRuntimeTerminalState,
  workerTurnSettlementSourceId,
} from "../workerHealth.ts";

import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectAgentReactor } from "../Services/ProjectAgentReactor.ts";
import { ProjectAgentService } from "../Services/ProjectAgentService.ts";

// Turn-ownership signals: who started the worker's active turn decides
// whether the ladder may steer it (coordinator/ladder only) and re-arms
// monitoring on terminally settled workers.
const TURN_REQUEST_EVENT_TYPES: ReadonlySet<OrchestrationEvent["type"]> = new Set([
  "thread.turn-start-requested",
  "thread.turn-queued",
]);

// Request-side waiting signals ride `thread.activity-appended` — the provider
// raising an approval/input request marks the worker waiting; the
// response-requested event types fire when the USER answers and are not
// worker-waiting signals.
const REQUEST_ACTIVITY_KINDS: ReadonlySet<string> = new Set([
  "approval.requested",
  "user-input.requested",
]);

const make = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const projectAgent = yield* ProjectAgentService;

  yield* projectAgent.reconcilePendingWakes().pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("project agent wake reconciliation failed", {
        cause: Cause.pretty(cause),
      }),
    ),
  );

  const inspectWorkerHealthSafely = projectAgent.inspectWorkerHealth().pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("project agent worker health inspect failed", {
        cause: Cause.pretty(cause),
      }),
    ),
  );
  yield* inspectWorkerHealthSafely.pipe(
    Effect.repeat(Schedule.spaced(Duration.millis(PROJECT_AGENT_WORKER_HEALTH_INTERVAL_MS))),
    Effect.forkScoped,
  );

  const isWatchedEvent = (type: OrchestrationEvent["type"]) =>
    type === "project.deleted" ||
    TURN_REQUEST_EVENT_TYPES.has(type) ||
    type === "thread.activity-appended";

  const worker = yield* makeDrainableWorker((event: OrchestrationEvent) =>
    Effect.gen(function* () {
      if (event.type === "project.deleted") {
        yield* projectAgent.onProjectDeleted(event.payload.projectId as ProjectId);
        return;
      }

      if (TURN_REQUEST_EVENT_TYPES.has(event.type)) {
        const payload = event.payload;
        if (!("threadId" in payload)) return;
        yield* projectAgent.recordWorkerTurnRequest({
          threadId: payload.threadId as ThreadId,
          commandId: event.commandId,
          dispatchOrigin:
            "dispatchOrigin" in payload && typeof payload.dispatchOrigin === "string"
              ? payload.dispatchOrigin
              : null,
          turnId: "turnId" in payload && typeof payload.turnId === "string" ? payload.turnId : null,
          // `thread.turn-queued` only enqueues behind a running turn — the
          // running turn keeps its ownership until promotion emits
          // `thread.turn-start-requested`.
          eventType: event.type,
          createdAt: new Date().toISOString(),
        });
        return;
      }

      if (event.type === "thread.activity-appended") {
        const payload = event.payload;
        if (!("threadId" in payload) || !("activity" in payload)) return;
        const activity = payload.activity as {
          createdAt?: unknown;
          kind?: unknown;
          payload?: unknown;
          turnId?: unknown;
        };
        if (activity?.kind === "turn.completed") {
          const terminalPayload = activity.payload;
          if (
            typeof activity.turnId !== "string" ||
            terminalPayload === null ||
            typeof terminalPayload !== "object"
          ) {
            return;
          }
          const state = (terminalPayload as Record<string, unknown>).state;
          if (!isWorkerRuntimeTerminalState(state)) return;
          const generation = (terminalPayload as Record<string, unknown>).lifecycleGeneration;
          yield* projectAgent.ingestSettledThreadEvent({
            threadId: payload.threadId as ThreadId,
            sourceEventId: workerTurnSettlementSourceId({
              threadId: payload.threadId,
              turnId: activity.turnId,
              lifecycleGeneration: typeof generation === "string" ? generation : null,
            }),
            eventType: "turn.completed",
            runtimeTurnState: state,
            turnId: activity.turnId,
            ...(typeof generation === "string" ? { lifecycleGeneration: generation } : {}),
            createdAt:
              typeof activity.createdAt === "string"
                ? activity.createdAt
                : new Date().toISOString(),
          });
          return;
        }
        if (typeof activity?.kind !== "string" || !REQUEST_ACTIVITY_KINDS.has(activity.kind)) {
          return;
        }
        yield* projectAgent.ingestSettledThreadEvent({
          threadId: payload.threadId as ThreadId,
          sourceEventId: `${event.sequence}:${activity.kind}`,
          eventType: activity.kind,
          createdAt: new Date().toISOString(),
        });
        return;
      }
    }).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.failCause(cause);
        }
        return Effect.logWarning("project agent reactor failed", {
          cause: Cause.pretty(cause),
        });
      }),
    ),
  );

  yield* startDrainableWorkerProducers(
    worker,
    Effect.forkScoped(
      Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) =>
        isWatchedEvent(event.type) ? worker.enqueue(event).pipe(Effect.asVoid) : Effect.void,
      ),
    ).pipe(Effect.asVoid),
  );

  return { ready: true as const };
});

export const ProjectAgentReactorLive = Layer.effect(ProjectAgentReactor, make);
