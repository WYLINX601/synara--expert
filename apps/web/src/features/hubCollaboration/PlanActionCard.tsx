import {
  ThreadId,
  type HubPlanEvent,
  type HubPlanInputRequest,
  type HubPlanSnapshot,
} from "@synara/contracts";
import { useRef, useState } from "react";

import { Button } from "~/components/ui/button";
import { Textarea } from "~/components/ui/textarea";

import { HubPlanDeliverablePreview } from "./HubPlanDeliverablePreview";
import {
  currentHubInputRequest,
  hubInputRequestReceipt,
  sameHubInputRequestIdentity,
  type HubInputRequestReplyTarget,
} from "./hubInputRequest.logic";
import { normalizeHubPlanEventKind, snapshotFromHubPlanEvent } from "./hubPlan.logic";
import { hubPlanControlStateLabel } from "./planLabels";
import type {
  HubPlanActionReference,
  HubPlanCandidateReference,
  HubPlanRetryReference,
  HubPlanUserAction,
} from "./useHubPlans";

const EVENT_LABELS: Record<string, string> = {
  proposed: "计划提议",
  confirmed: "计划确认",
  "candidate-submitted": "候选成果提交",
  "review-submitted": "审核意见",
  "awaiting-release": "等待放行",
  released: "阶段放行",
  returned: "候选成果退回",
  pausing: "正在暂停",
  paused: "暂停回执",
  resumed: "恢复回执",
  cancelling: "正在取消",
  cancelled: "取消回执",
  completed: "计划完成",
  retried: "节点重试",
  "input-requested": "Worker 请求补充信息",
  "input-responded": "已提交 Worker 回复",
  "input-delivered": "Worker 回复已送达",
};

const RETURNABLE_CANDIDATE_STATES = new Set([
  "waiting_user",
  "changes_requested",
  "ready_to_release",
]);

function actionableCandidates(snapshot: HubPlanSnapshot): HubPlanCandidateReference[] {
  return snapshot.graph.stages.flatMap((stage) =>
    RETURNABLE_CANDIDATE_STATES.has(stage.status) &&
    stage.candidateId &&
    stage.outputDigest &&
    stage.generation
      ? [
          {
            stageKey: stage.stageKey,
            stageTitle: stage.title,
            generation: stage.generation,
            candidateId: stage.candidateId,
            outputDigest: stage.outputDigest,
          },
        ]
      : [],
  );
}

function canActOnCurrentCandidate(
  current: HubPlanSnapshot | null,
  candidate: HubPlanCandidateReference,
  allowedStatuses: ReadonlySet<string>,
): boolean {
  const stage = current?.graph.stages.find((item) => item.stageKey === candidate.stageKey);
  return (
    current?.controlState === "active" &&
    stage !== undefined &&
    allowedStatuses.has(stage.status) &&
    stage.generation === candidate.generation &&
    stage.candidateId === candidate.candidateId &&
    stage.outputDigest === candidate.outputDigest
  );
}

type RetryablePlanNode = {
  readonly title: string;
  readonly reference: HubPlanRetryReference;
};

function retryableNodes(snapshot: HubPlanSnapshot): RetryablePlanNode[] {
  return (snapshot.nodeStates ?? []).flatMap((nodeState) => {
    if (!nodeState.retryable || !nodeState.attemptId) return [];
    const node = snapshot.definition.nodes.find((item) => item.key === nodeState.nodeKey);
    if (!node) return [];
    const stage = snapshot.graph.stages.find((item) => item.stageKey === node.stageKey);
    if (!stage?.generation) return [];
    return [
      {
        title: node.title,
        reference: {
          nodeKey: node.key,
          attemptId: nodeState.attemptId,
          stageKey: node.stageKey,
          generation: stage.generation,
        },
      },
    ];
  });
}

function canRetryCurrentNode(
  current: HubPlanSnapshot | null,
  reference: HubPlanRetryReference,
): boolean {
  if (!current || current.controlState !== "active") return false;
  const nodeState = current.nodeStates?.find((item) => item.nodeKey === reference.nodeKey);
  const node = current.definition.nodes.find((item) => item.key === reference.nodeKey);
  const stage = current.graph.stages.find((item) => item.stageKey === reference.stageKey);
  return (
    nodeState?.retryable === true &&
    nodeState.attemptId === reference.attemptId &&
    node?.stageKey === reference.stageKey &&
    stage?.generation === reference.generation
  );
}

function eventPayloadText(payload: unknown, key: "summary" | "comment"): string | null {
  if (typeof payload !== "object" || payload === null || !(key in payload)) return null;
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function eventInputRequest(event: HubPlanEvent): HubPlanInputRequest | null {
  const request = event.payload.inputRequest;
  return request && typeof request === "object" ? request : null;
}

function eventInputRequestId(event: HubPlanEvent): string | null {
  const payload = event.payload as typeof event.payload & { readonly inputRequestId?: unknown };
  return typeof payload.inputRequestId === "string" ? payload.inputRequestId : null;
}

function eventInputAnswers(event: HubPlanEvent): ReadonlyArray<string> {
  const payload = event.payload as typeof event.payload & { readonly answers?: unknown };
  return Array.isArray(payload.answers)
    ? payload.answers.filter((answer): answer is string => typeof answer === "string")
    : [];
}

function inputRequestQuestionRows(
  request: HubPlanInputRequest,
  answers: ReadonlyArray<string>,
): ReadonlyArray<{
  readonly key: string;
  readonly question: HubPlanInputRequest["questions"][number];
  readonly answer: string;
}> {
  const occurrences = new Map<string, number>();
  return request.questions.map((question, index) => {
    const identity = JSON.stringify(question);
    const occurrence = occurrences.get(identity) ?? 0;
    occurrences.set(identity, occurrence + 1);
    return {
      key: `${request.id}:${identity}:${occurrence}`,
      question,
      answer: answers[index] ?? "",
    };
  });
}

export function PlanActionCard(props: {
  readonly event: HubPlanEvent;
  readonly currentPlan: HubPlanSnapshot | null;
  readonly latestTimelineEventSequence: number | null;
  readonly connected: boolean;
  readonly onAction: (
    event: HubPlanEvent,
    action: HubPlanUserAction,
    reference?: HubPlanActionReference,
    comment?: string,
  ) => Promise<void>;
  readonly onBeginInputReply: (target: HubInputRequestReplyTarget) => void;
  readonly onOpenThread: (
    threadId: ThreadId,
    inputRequestTarget?: HubInputRequestReplyTarget,
  ) => void;
}) {
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const pendingActionRef = useRef(false);
  const [comment, setComment] = useState("");
  const [error, setError] = useState<string | null>(null);
  const snapshot = snapshotFromHubPlanEvent(props.event);
  const eventKind = normalizeHubPlanEventKind(props.event.kind);
  const reviewSummary =
    eventKind === "review-submitted" ? eventPayloadText(props.event.payload, "summary") : null;
  const returnComment =
    eventKind === "returned" ? eventPayloadText(props.event.payload, "comment") : null;
  const eventRequest = eventInputRequest(props.event);
  const isInputRequestEvent =
    eventKind === "input-requested" ||
    eventKind === "input-responded" ||
    eventKind === "input-delivered";
  const requestId = eventRequest?.id ?? eventInputRequestId(props.event);
  const currentRequestCandidate = requestId
    ? ((props.currentPlan?.inputRequests ?? []).find((item) => item.id === requestId) ?? null)
    : null;
  const currentPlanMatchesEvent = Boolean(
    eventRequest &&
    snapshot &&
    props.currentPlan &&
    snapshot.id === props.event.planId &&
    snapshot.hubId === props.event.hubId &&
    snapshot.revision === props.currentPlan.revision &&
    props.currentPlan.id === props.event.planId &&
    props.currentPlan.hubId === props.event.hubId,
  );
  const currentRequest =
    eventRequest &&
    currentRequestCandidate &&
    currentPlanMatchesEvent &&
    sameHubInputRequestIdentity(eventRequest, currentRequestCandidate)
      ? currentRequestCandidate
      : null;
  const displayRequest = eventRequest ?? currentRequest;
  const requestNode =
    (currentRequest &&
      props.currentPlan?.definition.nodes.find((node) => node.key === currentRequest.nodeKey)) ??
    (displayRequest &&
      snapshot?.definition.nodes.find((node) => node.key === displayRequest.nodeKey));
  const requestStage =
    (currentRequest &&
      props.currentPlan?.definition.stages.find(
        (stage) => stage.key === currentRequest.stageKey,
      )) ??
    (displayRequest &&
      snapshot?.definition.stages.find((stage) => stage.key === displayRequest.stageKey));
  const inputRequestTarget =
    eventRequest &&
    currentRequest &&
    props.currentPlan &&
    props.currentPlan.id === props.event.planId &&
    snapshot?.id === props.currentPlan.id &&
    snapshot.revision === props.currentPlan.revision &&
    sameHubInputRequestIdentity(eventRequest, currentRequest)
      ? {
          hubId: props.currentPlan.hubId,
          planId: props.currentPlan.id,
          revision: props.currentPlan.revision,
          request: currentRequest,
          event: props.event,
        }
      : null;
  const currentActionableInputRequest =
    inputRequestTarget && props.connected
      ? currentHubInputRequest(inputRequestTarget, props.currentPlan)
      : null;
  const displayedInputAnswers =
    currentRequest?.answers ?? eventRequest?.answers ?? eventInputAnswers(props.event);
  const displayedInputStatus = currentRequest?.status ?? eventRequest?.status;
  const displayQuestionRows = displayRequest
    ? inputRequestQuestionRows(displayRequest, displayedInputAnswers)
    : [];
  const isLatestEvent =
    props.currentPlan?.id === props.event.planId &&
    props.latestTimelineEventSequence === props.event.sequence;
  const candidates = snapshot ? actionableCandidates(snapshot) : [];
  const retryable = props.currentPlan
    ? retryableNodes(props.currentPlan).filter((node) =>
        canRetryCurrentNode(props.currentPlan, node.reference),
      )
    : [];
  const releaseCandidates = candidates.filter((candidate) => {
    const eventStage = snapshot?.graph.stages.find((item) => item.stageKey === candidate.stageKey);
    return (
      eventStage?.status === "waiting_user" &&
      canActOnCurrentCandidate(props.currentPlan, candidate, new Set(["waiting_user"]))
    );
  });
  const returnCandidates = candidates.filter((candidate) =>
    canActOnCurrentCandidate(props.currentPlan, candidate, RETURNABLE_CANDIDATE_STATES),
  );
  const sameRevision = Boolean(
    snapshot && props.currentPlan && snapshot.revision === props.currentPlan.revision,
  );

  const runAction = async (
    action: HubPlanUserAction,
    actionKey: string,
    reference?: HubPlanActionReference,
    actionComment?: string,
  ) => {
    if (pendingActionRef.current) return;
    pendingActionRef.current = true;
    setPendingAction(actionKey);
    setError(null);
    try {
      await props.onAction(props.event, action, reference, actionComment);
      if (action === "return") setComment("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "操作失败，请重试。");
    } finally {
      pendingActionRef.current = false;
      setPendingAction(null);
    }
  };

  const showActions = isLatestEvent && snapshot !== null && props.connected;
  const showDraftActions =
    showActions &&
    snapshot.controlState === "draft" &&
    props.currentPlan?.controlState === "draft" &&
    sameRevision;
  const showCandidateActions =
    showActions && (releaseCandidates.length > 0 || returnCandidates.length > 0);
  const showActiveActions =
    showActions &&
    props.currentPlan?.controlState === "active" &&
    snapshot.controlState === "active";
  const showPausedActions =
    showActions &&
    props.currentPlan?.controlState === "paused" &&
    snapshot.controlState === "paused";
  const showRetryActions =
    showActions &&
    sameRevision &&
    props.currentPlan?.controlState === "active" &&
    retryable.length > 0;
  const mayCancel =
    showActions &&
    props.currentPlan !== null &&
    !["cancelling", "cancelled", "completed"].includes(props.currentPlan.controlState);

  return (
    <article
      className="rounded-xl border border-border/70 bg-card/55 px-3 py-2.5"
      aria-label={`Hub 操作卡：${EVENT_LABELS[eventKind] ?? "协作事件"}`}
      data-hub-plan-event={props.event.sequence}
      data-hub-plan-id={props.event.planId}
      tabIndex={-1}
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-ui-xs text-muted-foreground">
        <span>Hub</span>
        <span aria-hidden="true">·</span>
        <span>{EVENT_LABELS[eventKind] ?? eventKind}</span>
        <span className="ml-auto tabular-nums">计划 v{snapshot?.revision ?? "—"}</span>
      </div>
      <h3 className="mt-1 text-ui font-medium">
        {isInputRequestEvent
          ? (requestNode?.title ?? displayRequest?.nodeKey ?? EVENT_LABELS[eventKind])
          : (snapshot?.definition.objective ?? EVENT_LABELS[eventKind] ?? "协作计划事件")}
      </h3>
      {snapshot ? (
        !isInputRequestEvent ? (
          <div className="mt-1 space-y-1 text-ui-sm text-muted-foreground">
            <p className="whitespace-pre-wrap">{snapshot.definition.scope}</p>
            {candidates.map((candidate) => {
              const stage = snapshot.graph.stages.find(
                (item) => item.stageKey === candidate.stageKey,
              );
              return (
                <div key={candidate.stageKey} className="rounded-md bg-secondary/55 px-2.5 py-2">
                  <p className="font-medium text-foreground">{candidate.stageTitle} · 候选成果</p>
                  <p className="mt-1 whitespace-pre-wrap">
                    {stage?.outputSummary || "候选成果已提交，摘要暂不可用。"}
                  </p>
                  {stage?.deliverableRefs?.length ? (
                    <div className="mt-2 space-y-2">
                      {stage.deliverableRefs.map((reference) => (
                        <HubPlanDeliverablePreview
                          key={`${reference.hubId}:${reference.workerThreadId}:${reference.revision}:${reference.commitSha}:${reference.file.path}`}
                          reference={reference}
                        />
                      ))}
                    </div>
                  ) : null}
                  <p className="mt-1 truncate font-mono text-ui-xs" title={candidate.outputDigest}>
                    {candidate.outputDigest}
                  </p>
                  <p className="mt-1 text-ui-xs">候选版本：{candidate.candidateId}</p>
                </div>
              );
            })}
            {candidates.length === 0 ? (
              <p>当前状态：{hubPlanControlStateLabel(snapshot.controlState)}</p>
            ) : null}
          </div>
        ) : null
      ) : !isInputRequestEvent ? (
        <p className="mt-1 text-ui-sm text-muted-foreground">该事件没有可读取的历史快照。</p>
      ) : null}
      {!isInputRequestEvent && reviewSummary ? (
        <div className="mt-2 rounded-md border border-border/60 bg-background/50 px-2.5 py-2">
          <p className="text-ui-xs text-muted-foreground">审核意见</p>
          <p className="mt-1 whitespace-pre-wrap text-ui-sm">{reviewSummary}</p>
        </div>
      ) : null}
      {!isInputRequestEvent && returnComment ? (
        <div className="mt-2 rounded-md border border-border/60 bg-background/50 px-2.5 py-2">
          <p className="text-ui-xs text-muted-foreground">退回修改意见</p>
          <p className="mt-1 whitespace-pre-wrap text-ui-sm">{returnComment}</p>
        </div>
      ) : null}

      {displayRequest ? (
        <div className="mt-2 rounded-md border border-border/60 bg-background/50 px-2.5 py-2">
          <div className="flex flex-wrap items-center gap-2">
            {requestStage?.title ? (
              <span className="text-ui-xs text-muted-foreground">{requestStage.title}</span>
            ) : null}
            {requestNode?.expertId ? (
              <span className="text-ui-xs text-muted-foreground">{requestNode.expertId}</span>
            ) : null}
            <span className="ml-auto text-ui-xs text-muted-foreground">
              {displayedInputStatus
                ? hubInputRequestReceipt(displayedInputStatus)
                : props.currentPlan?.id === props.event.planId &&
                    props.currentPlan.hubId === props.event.hubId
                  ? hubInputRequestReceipt("stale")
                  : "连接后可确认当前状态"}
            </span>
          </div>
          <div className="mt-2 space-y-2">
            {displayQuestionRows.map(({ key, question, answer }) => (
              <div key={key}>
                <p className="whitespace-pre-wrap text-ui-sm">{question.title}</p>
                {question.options?.length ? (
                  <p className="mt-0.5 text-ui-xs text-muted-foreground">
                    选项：{question.options.join("、")}
                  </p>
                ) : null}
                {answer ? (
                  <p className="mt-1 whitespace-pre-wrap text-ui-sm text-muted-foreground">
                    回复：{answer}
                  </p>
                ) : null}
              </div>
            ))}
          </div>
          {currentActionableInputRequest && inputRequestTarget ? (
            <div className="mt-2 flex flex-wrap gap-2">
              <Button
                type="button"
                size="sm"
                onClick={() => props.onBeginInputReply(inputRequestTarget)}
              >
                在此回复
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() =>
                  inputRequestTarget &&
                  props.onOpenThread(
                    currentActionableInputRequest.workerThreadId,
                    inputRequestTarget,
                  )
                }
              >
                去回答
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}

      {error ? (
        <p className="mt-2 text-ui-sm text-destructive" role="alert">
          {error}
        </p>
      ) : null}
      {!isInputRequestEvent && !isLatestEvent && candidates.length > 0 ? (
        <p className="mt-2 text-ui-xs text-muted-foreground">
          历史候选仅供查看，操作请使用最新候选卡。
        </p>
      ) : null}
      {!isInputRequestEvent &&
      isLatestEvent &&
      candidates.length > 0 &&
      releaseCandidates.length === 0 &&
      returnCandidates.length === 0 ? (
        <p className="mt-2 text-ui-xs text-muted-foreground">
          此候选已过期，当前计划中的候选版本已变化。
        </p>
      ) : null}

      {!isInputRequestEvent ? (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {showDraftActions ? (
            <Button
              type="button"
              size="sm"
              disabled={pendingAction !== null}
              onClick={() => void runAction("confirm", "confirm")}
            >
              {pendingAction === "confirm" ? "确认中…" : "确认计划"}
            </Button>
          ) : null}
          {showCandidateActions ? (
            <>
              {releaseCandidates.map((candidate) => (
                <Button
                  key={`release:${candidate.stageKey}`}
                  type="button"
                  size="sm"
                  disabled={pendingAction !== null}
                  onClick={() =>
                    void runAction("release", `release:${candidate.stageKey}`, candidate)
                  }
                >
                  {pendingAction === `release:${candidate.stageKey}`
                    ? "确认中…"
                    : `确认并放行：${candidate.stageTitle}`}
                </Button>
              ))}
              {returnCandidates.length > 0 ? (
                <>
                  <Textarea
                    value={comment}
                    onChange={(event) => setComment(event.target.value)}
                    placeholder="填写退回修改意见"
                    aria-label="退回修改意见"
                    className="min-h-16 w-full text-ui-sm"
                  />
                  {returnCandidates.map((candidate) => (
                    <Button
                      key={`return:${candidate.stageKey}`}
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={pendingAction !== null || comment.trim().length === 0}
                      onClick={() =>
                        void runAction("return", `return:${candidate.stageKey}`, candidate, comment)
                      }
                    >
                      {pendingAction === `return:${candidate.stageKey}` ? "退回中…" : "退回修改"}
                    </Button>
                  ))}
                </>
              ) : null}
            </>
          ) : null}
          {showRetryActions
            ? retryable.map(({ reference, title }) => {
                const actionKey = `retry:${reference.nodeKey}:${reference.attemptId}`;
                return (
                  <Button
                    key={actionKey}
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={pendingAction !== null}
                    onClick={() => void runAction("retry", actionKey, reference)}
                  >
                    {pendingAction === actionKey ? "重试中…" : `重试：${title}`}
                  </Button>
                );
              })
            : null}
          {showActiveActions ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={pendingAction !== null}
              onClick={() => void runAction("pause", "pause")}
            >
              {pendingAction === "pause" ? "暂停中…" : "暂停"}
            </Button>
          ) : null}
          {showPausedActions ? (
            <Button
              type="button"
              size="sm"
              disabled={pendingAction !== null}
              onClick={() => void runAction("resume", "resume")}
            >
              {pendingAction === "resume" ? "恢复中…" : "恢复"}
            </Button>
          ) : null}
          {mayCancel ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="text-destructive"
              disabled={pendingAction !== null}
              onClick={() => void runAction("cancel", "cancel")}
            >
              {pendingAction === "cancel" ? "取消中…" : "取消计划"}
            </Button>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}
