import type { OrchestrationEvent, OrchestrationThreadActivity } from "@synara/contracts";

/** Preserve the trusted author's complete terminal observation, including late results. */
export function expertDelegationResultActivity(
  event: Extract<OrchestrationEvent, { type: "thread.expert-delegation-result" }>,
): OrchestrationThreadActivity {
  return {
    id: event.eventId,
    kind: "expert.delegation.result",
    tone: event.payload.outcome === "failed" ? "error" : "info",
    summary:
      event.payload.result?.summary ||
      `Expert ${event.payload.targetExpertId}: ${event.payload.outcome}`,
    payload: event.payload,
    turnId: null,
    sequence: event.sequence,
    sequenceSource: "orchestration",
    createdAt: event.occurredAt,
  };
}
