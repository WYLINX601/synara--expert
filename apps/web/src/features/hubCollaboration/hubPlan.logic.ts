import { Schema } from "effect";
import type { HubPlanEvent, HubPlanSnapshot } from "@synara/contracts";
import { HubPlanSnapshotSchema } from "@synara/contracts";

import type { MessagesTimelineRow } from "~/components/chat/MessagesTimeline.logic";

const RUNNING_CONTROL_STATES = new Set(["active", "pausing", "paused", "cancelling"]);
const TIMELINE_EVENT_KINDS = new Set([
  "proposed",
  "confirmed",
  "candidate-submitted",
  "review-submitted",
  "awaiting-release",
  "released",
  "returned",
  "pausing",
  "paused",
  "resumed",
  "cancelling",
  "cancelled",
  "completed",
  "retried",
  "input-requested",
  "input-responded",
  "input-delivered",
]);
const INPUT_REQUEST_EVENT_KINDS = new Set([
  "input-requested",
  "input-responded",
  "input-delivered",
]);
const timestampForRow = (row: MessagesTimelineRow) =>
  "createdAt" in row ? (row.createdAt ?? "\uffff") : "\uffff";

export function normalizeHubPlanEventKind(kind: string): string {
  return kind.startsWith("plan.") ? kind.slice("plan.".length) : kind;
}

export function isHubPlanTimelineEvent(event: HubPlanEvent): boolean {
  return (
    event.kind.startsWith("plan.") &&
    TIMELINE_EVENT_KINDS.has(normalizeHubPlanEventKind(event.kind))
  );
}

/** Input request cards are timeline content, but they do not replace plan controls. */
export function isHubPlanControlEvent(event: HubPlanEvent): boolean {
  return (
    isHubPlanTimelineEvent(event) &&
    !INPUT_REQUEST_EVENT_KINDS.has(normalizeHubPlanEventKind(event.kind))
  );
}

export function selectCurrentHubPlan(
  plans: ReadonlyArray<HubPlanSnapshot>,
): HubPlanSnapshot | null {
  // Continue an active plan before considering a newer, unconfirmed draft.
  return (
    plans.find((plan) => RUNNING_CONTROL_STATES.has(plan.controlState)) ??
    plans.find((plan) => plan.controlState === "draft") ??
    plans[0] ??
    null
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function isHubPlanSnapshot(value: unknown): value is HubPlanSnapshot {
  return Schema.is(HubPlanSnapshotSchema)(value);
}

export function snapshotFromHubPlanEvent(event: {
  readonly planId: HubPlanEvent["planId"];
  readonly payload: unknown;
}): HubPlanSnapshot | null {
  if (!isRecord(event.payload) || !isHubPlanSnapshot(event.payload.snapshot)) return null;
  return event.payload.snapshot.id === event.planId ? event.payload.snapshot : null;
}

export function mergeHubPlanEvents(
  existing: ReadonlyArray<HubPlanEvent>,
  incoming: ReadonlyArray<HubPlanEvent>,
): HubPlanEvent[] {
  const byEventKey = new Map<string, HubPlanEvent>();
  for (const event of existing) {
    byEventKey.set(`${event.planId}\u0000${event.sequence}`, event);
  }
  for (const event of incoming) {
    const key = `${event.planId}\u0000${event.sequence}`;
    if (!byEventKey.has(key)) byEventKey.set(key, event);
  }
  return [...byEventKey.values()].toSorted(
    (left, right) => left.sequence - right.sequence || left.planId.localeCompare(right.planId),
  );
}

export function latestSnapshotFromHubPlanEvents(
  events: ReadonlyArray<HubPlanEvent>,
  fallback: HubPlanSnapshot,
): HubPlanSnapshot {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (!event) continue;
    const snapshot = snapshotFromHubPlanEvent(event);
    if (snapshot && snapshot.id === fallback.id && snapshot.stateVersion > fallback.stateVersion) {
      return snapshot;
    }
  }
  return fallback;
}

/** Compare the complete immutable definition, independent of object key order. */
export function sameHubPlanDefinition(
  left: HubPlanSnapshot["definition"],
  right: HubPlanSnapshot["definition"],
): boolean {
  const canonicalize = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonicalize);
    if (isRecord(value)) {
      return Object.fromEntries(
        Object.keys(value)
          .toSorted()
          .map((key) => [key, canonicalize(value[key])]),
      );
    }
    return value;
  };
  return JSON.stringify(canonicalize(left)) === JSON.stringify(canonicalize(right));
}

export function sortHubPlanEvents(events: ReadonlyArray<HubPlanEvent>): HubPlanEvent[] {
  return [...events].toSorted(
    (left, right) =>
      left.createdAt.localeCompare(right.createdAt) || left.sequence - right.sequence,
  );
}

export function mergeHubPlanEventRows(
  rows: ReadonlyArray<MessagesTimelineRow>,
  events: ReadonlyArray<HubPlanEvent>,
): MessagesTimelineRow[] {
  const sortedEvents = sortHubPlanEvents(events.filter(isHubPlanTimelineEvent));
  const merged: MessagesTimelineRow[] = [];
  let rowIndex = 0;
  let eventIndex = 0;
  while (rowIndex < rows.length || eventIndex < sortedEvents.length) {
    const row = rows[rowIndex];
    const event = sortedEvents[eventIndex];
    if (!event) {
      merged.push(row!);
      rowIndex += 1;
      continue;
    }
    if (!row) {
      merged.push({
        kind: "hub-plan-event",
        id: `hub-plan:${event.planId}:${event.sequence}`,
        createdAt: event.createdAt,
        event,
      });
      eventIndex += 1;
      continue;
    }
    // The base timeline is already chronological. Keep its row order intact
    // and place plan events after existing rows when timestamps tie.
    if (timestampForRow(row) <= event.createdAt) {
      merged.push(row);
      rowIndex += 1;
      continue;
    }
    merged.push({
      kind: "hub-plan-event",
      id: `hub-plan:${event.planId}:${event.sequence}`,
      createdAt: event.createdAt,
      event,
    });
    eventIndex += 1;
  }
  return merged;
}
