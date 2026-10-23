import {
  ThreadId,
  type HubPlanEvent,
  type HubPlanInputRequest,
  type HubPlanSnapshot,
  type ProjectId,
} from "@synara/contracts";

export type HubInputRequestReplyTarget = {
  readonly hubId: ProjectId;
  readonly planId: HubPlanSnapshot["id"];
  readonly revision: number;
  readonly request: HubPlanInputRequest;
  readonly event: HubPlanEvent;
};

export function sameHubInputRequestIdentity(
  left: HubPlanInputRequest,
  right: HubPlanInputRequest,
): boolean {
  return (
    left.id === right.id &&
    left.nodeKey === right.nodeKey &&
    left.stageKey === right.stageKey &&
    left.generation === right.generation &&
    left.attemptId === right.attemptId &&
    left.workerThreadId === right.workerThreadId &&
    JSON.stringify(left.questions) === JSON.stringify(right.questions)
  );
}

/** Find the persisted request receipt only when the full worker-attempt identity still matches. */
export function matchingHubInputRequest(
  target: Pick<HubInputRequestReplyTarget, "hubId" | "planId" | "request">,
  plan: HubPlanSnapshot | null,
): HubPlanInputRequest | null {
  if (!plan || plan.id !== target.planId || plan.hubId !== target.hubId) return null;
  const request = (plan.inputRequests ?? []).find((item) => item.id === target.request.id);
  return request && sameHubInputRequestIdentity(request, target.request) ? request : null;
}

export function currentHubInputRequest(
  target: Pick<HubInputRequestReplyTarget, "hubId" | "planId" | "revision" | "request">,
  plan: HubPlanSnapshot | null,
): HubPlanInputRequest | null {
  if (
    !plan ||
    plan.id !== target.planId ||
    plan.hubId !== target.hubId ||
    plan.revision !== target.revision ||
    plan.controlState !== "active"
  ) {
    return null;
  }
  const request = matchingHubInputRequest(target, plan);
  if (!request || request.status !== "pending") {
    return null;
  }
  const node = plan.definition.nodes.find((item) => item.key === request.nodeKey);
  const stage = plan.graph.stages.find((item) => item.stageKey === request.stageKey);
  const nodeState = plan.nodeStates.find((item) => item.nodeKey === request.nodeKey);
  if (
    node?.stageKey !== request.stageKey ||
    stage?.generation !== request.generation ||
    nodeState?.attemptId !== request.attemptId ||
    nodeState.workerThreadId !== request.workerThreadId
  ) {
    return null;
  }
  return request;
}

/** A separate composerDraftStore key for each immutable plan attempt request. */
export function hubInputRequestDraftKey(target: HubInputRequestReplyTarget): ThreadId {
  const identity = [
    target.hubId,
    target.planId,
    target.revision,
    target.request.nodeKey,
    target.request.stageKey,
    target.request.generation,
    target.request.attemptId,
    target.request.workerThreadId,
    target.request.id,
  ];
  return ThreadId.makeUnsafe(`synara-hub-input-reply:v1:${JSON.stringify(identity)}`);
}

export type HubInputRequestDraftData = {
  readonly answers: ReadonlyArray<string>;
  readonly questionIndex: number;
};

export function parseHubInputRequestDraft(
  raw: string,
  questionCount: number,
): HubInputRequestDraftData {
  const emptyAnswers = () => Array.from({ length: questionCount }, () => "");
  if (!raw) return { answers: emptyAnswers(), questionIndex: 0 };
  try {
    const parsed: unknown = JSON.parse(raw);
    const sourceAnswers = Array.isArray(parsed)
      ? parsed
      : typeof parsed === "object" && parsed !== null && "answers" in parsed
        ? (parsed as { readonly answers?: unknown }).answers
        : null;
    if (!Array.isArray(sourceAnswers)) {
      return { answers: emptyAnswers(), questionIndex: 0 };
    }
    const answers = Array.from({ length: questionCount }, (_, index) => {
      const answer = sourceAnswers[index];
      return typeof answer === "string" ? answer : "";
    });
    const parsedIndex =
      typeof parsed === "object" && parsed !== null && "questionIndex" in parsed
        ? (parsed as { readonly questionIndex?: unknown }).questionIndex
        : 0;
    const questionIndex =
      typeof parsedIndex === "number" && Number.isInteger(parsedIndex)
        ? Math.max(0, Math.min(parsedIndex, questionCount - 1))
        : 0;
    return { answers, questionIndex };
  } catch {
    return { answers: emptyAnswers(), questionIndex: 0 };
  }
}

export function parseHubInputRequestAnswers(raw: string, questionCount: number): string[] {
  return [...parseHubInputRequestDraft(raw, questionCount).answers];
}

export function hubInputRequestReceipt(status: HubPlanInputRequest["status"]): string {
  switch (status) {
    case "pending":
      return "等待回复";
    case "answered":
      return "已提交回复，等待送达 Worker";
    case "delivered":
      return "回复已送达 Worker";
    case "stale":
      return "该请求已过期";
  }
}

/** Block ordinary composer sends while a Hub question reply is explicitly selected. */
export function guardDirectedReplyModeSend<Arguments extends unknown[]>(
  directedReplyActive: boolean,
  send: (...args: Arguments) => Promise<boolean>,
): (...args: Arguments) => Promise<boolean> {
  return (...args) => (directedReplyActive ? Promise.resolve(false) : send(...args));
}
