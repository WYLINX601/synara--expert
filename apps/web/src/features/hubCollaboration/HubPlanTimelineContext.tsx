import type {
  HubPlanEvent,
  HubPlanInputRequest,
  HubPlanSnapshot,
  ThreadId,
} from "@synara/contracts";
import { createContext, useContext, useMemo, type ReactNode } from "react";

import type { HubPlanActionReference, HubPlanUserAction } from "./useHubPlans";
import type { HubInputRequestReplyTarget } from "./hubInputRequest.logic";

export type HubPlanTimelineValue = {
  readonly snapshot: HubPlanSnapshot | null;
  readonly events: ReadonlyArray<HubPlanEvent>;
  readonly connected: boolean;
  readonly onAction: (
    event: HubPlanEvent,
    action: HubPlanUserAction,
    reference?: HubPlanActionReference,
    comment?: string,
  ) => Promise<void>;
  readonly onBeginInputReply: (target: HubInputRequestReplyTarget) => void;
  readonly onRespondInput: (
    event: HubPlanEvent,
    request: HubPlanInputRequest,
    answers: ReadonlyArray<string>,
  ) => Promise<HubPlanSnapshot>;
  readonly onOpenThread: (
    threadId: ThreadId,
    inputRequestTarget?: HubInputRequestReplyTarget,
  ) => void;
};

const HubPlanTimelineContext = createContext<HubPlanTimelineValue | null>(null);
const EMPTY_HUB_PLAN_EVENTS: ReadonlyArray<HubPlanEvent> = [];
const NOOP_HUB_PLAN_ACTION: HubPlanTimelineValue["onAction"] = async () => undefined;
const NOOP_BEGIN_INPUT_REPLY: HubPlanTimelineValue["onBeginInputReply"] = () => undefined;
const NOOP_RESPOND_INPUT: HubPlanTimelineValue["onRespondInput"] = async () => {
  throw new Error("当前不能回复 Worker 问题。");
};
const NOOP_OPEN_THREAD: HubPlanTimelineValue["onOpenThread"] = () => undefined;

export function HubPlanTimelineProvider(props: {
  readonly value: HubPlanTimelineValue | null;
  readonly children: ReactNode;
}) {
  const hasValue = props.value !== null;
  const snapshot = props.value?.snapshot ?? null;
  const events = props.value?.events ?? EMPTY_HUB_PLAN_EVENTS;
  const connected = props.value?.connected ?? false;
  const onAction = props.value?.onAction ?? NOOP_HUB_PLAN_ACTION;
  const onBeginInputReply = props.value?.onBeginInputReply ?? NOOP_BEGIN_INPUT_REPLY;
  const onRespondInput = props.value?.onRespondInput ?? NOOP_RESPOND_INPUT;
  const onOpenThread = props.value?.onOpenThread ?? NOOP_OPEN_THREAD;
  const stableValue = useMemo(
    () =>
      hasValue
        ? { snapshot, events, connected, onAction, onBeginInputReply, onRespondInput, onOpenThread }
        : null,
    [
      hasValue,
      snapshot,
      events,
      connected,
      onAction,
      onBeginInputReply,
      onRespondInput,
      onOpenThread,
    ],
  );
  return (
    <HubPlanTimelineContext.Provider value={stableValue}>
      {props.children}
    </HubPlanTimelineContext.Provider>
  );
}

export function useHubPlanTimeline(): HubPlanTimelineValue | null {
  return useContext(HubPlanTimelineContext);
}
