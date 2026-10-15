import type {
  OrchestrationEvent,
  OrchestrationThread,
  ThreadContextDetails,
  ThreadId,
} from "@synara/contracts";
import { Effect, Option } from "effect";

import type { ContextRepositoryShape } from "../../context/ContextRepository.ts";
import {
  contextExecutionInputDigest,
  type ContextExecutionWorkspace,
} from "../../orchestration/contextDispatchEvidence.ts";
import {
  PROVIDER_COMMAND_REACTOR_CONSUMER,
  type OrchestrationEventDeliveryRepositoryShape,
} from "../../persistence/Services/OrchestrationEventDeliveries.ts";
import type { ProviderServiceShape } from "../../provider/Services/ProviderService.ts";

/** Combine immutable content with live execution evidence; prior success alone is never current loading. */
export function readThreadContextDetails(input: {
  readonly threadId: ThreadId;
  readonly repository: ContextRepositoryShape;
  readonly deliveries: OrchestrationEventDeliveryRepositoryShape;
  readonly providers: ProviderServiceShape;
  readonly readEvent: (sequence: number) => Effect.Effect<OrchestrationEvent | undefined, unknown>;
  readonly readThread: (
    threadId: ThreadId,
  ) => Effect.Effect<OrchestrationThread | undefined, unknown>;
  readonly readWorkspace: (
    thread: OrchestrationThread,
  ) => Effect.Effect<ContextExecutionWorkspace | undefined, unknown>;
}): Effect.Effect<ThreadContextDetails, unknown> {
  return Effect.gen(function* () {
    const details = yield* input.repository.getThreadDetails(input.threadId);
    if (details.mode !== "bound" || !details.snapshot?.hasContent) return details;
    const sessions = yield* input.providers.listSessions();
    const live = sessions.some(
      (session) => session.threadId === input.threadId && session.status !== "closed",
    );
    const settled = {
      ...details,
      loadStatus:
        details.loadStatus === "loaded" && !live ? ("stopped" as const) : details.loadStatus,
    };
    const blocker = yield* input.deliveries.firstBlockingDeliveryForThread({
      consumerName: PROVIDER_COMMAND_REACTOR_CONSUMER,
      threadId: input.threadId,
    });
    if (Option.isNone(blocker)) return settled;
    const delivery = blocker.value;
    if (delivery.contextSnapshotId !== details.snapshot.snapshotId) return settled;
    if (delivery.contextPhase === "dispatch_started" || delivery.contextPhase === "acknowledged") {
      return {
        ...settled,
        loadStatus: "uncertain",
        retry: null,
        error: "Execution outcome needs confirmation. The original message was not replayed.",
      };
    }
    const event = yield* input.readEvent(delivery.eventSequence);
    const thread = yield* input.readThread(input.threadId);
    const workspace =
      thread === undefined
        ? undefined
        : yield* input.readWorkspace(thread).pipe(Effect.catch(() => Effect.succeed(undefined)));
    const sameInput =
      event?.type === "thread.turn-start-requested" &&
      event.payload.threadId === input.threadId &&
      delivery.contextPhase === "before_dispatch" &&
      thread !== undefined &&
      workspace !== undefined &&
      delivery.contextMessageId === event.payload.messageId &&
      thread.messages.some((message) => message.id === event.payload.messageId) &&
      delivery.contextInputDigest === contextExecutionInputDigest(event, thread, workspace);
    const noTasks =
      !live &&
      input.providers.hasLiveRuntimeTasks !== undefined &&
      !(yield* input.providers.hasLiveRuntimeTasks({ threadId: input.threadId }));
    return {
      ...settled,
      loadStatus: settled.loadStatus === "loaded" ? "loaded" : "failed",
      retry:
        sameInput && noTasks
          ? { eventSequence: delivery.eventSequence, messageId: delivery.contextMessageId! }
          : null,
      error: sameInput
        ? "The original message has not been dispatched."
        : "Original inputs changed or execution state could not be confirmed.",
    };
  });
}
