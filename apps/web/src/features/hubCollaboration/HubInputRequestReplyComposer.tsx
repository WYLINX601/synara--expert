import type { HubPlanInputRequest, HubPlanSnapshot, UserInputQuestion } from "@synara/contracts";
import { useMemo, useRef, useState } from "react";

import { Button } from "~/components/ui/button";
import { Textarea } from "~/components/ui/textarea";
import {
  buildPendingUserInputAnswers,
  resolvePendingUserInputAnswer,
  setPendingUserInputCustomAnswer,
  togglePendingUserInputOptionSelection,
  type PendingUserInputDraftAnswer,
} from "~/pendingUserInput";
import {
  setHubInputRequestReplyDraft,
  useHubInputRequestReplyDraft,
} from "~/workbench/host/hubInputRequestDraftClient";

import {
  currentHubInputRequest,
  hubInputRequestReceipt,
  hubInputRequestDraftKey,
  matchingHubInputRequest,
  parseHubInputRequestDraft,
  type HubInputRequestReplyTarget,
} from "./hubInputRequest.logic";
import { UserInputQuestionForm } from "~/components/chat/UserInputQuestionForm";

function adaptedQuestions(request: HubPlanInputRequest): UserInputQuestion[] {
  return request.questions.map((question, index) => ({
    id: `hub-input-${index}`,
    header: `${index + 1}/${request.questions.length}`,
    question: question.title,
    options: (question.options ?? []).map((label) => ({ label, description: label })),
    multiSelect: false,
  }));
}

function answerFromDraft(question: UserInputQuestion, answer: string): PendingUserInputDraftAnswer {
  if (question.options.some((option) => option.label === answer)) {
    return { selectedOptionLabels: [answer] };
  }
  return { customAnswer: answer };
}

export function HubInputRequestReplyComposer(props: {
  readonly target: HubInputRequestReplyTarget;
  readonly plan: HubPlanSnapshot | null;
  readonly connected: boolean;
  readonly onSubmit: (
    request: HubPlanInputRequest,
    answers: ReadonlyArray<string>,
  ) => Promise<HubPlanSnapshot>;
  readonly onCancel: () => void;
}) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submissionInFlightRef = useRef(false);
  const draftKey = useMemo(() => hubInputRequestDraftKey(props.target), [props.target]);
  const rawDraft = useHubInputRequestReplyDraft(draftKey);
  const questions = useMemo(() => adaptedQuestions(props.target.request), [props.target.request]);
  const draft = useMemo(
    () => parseHubInputRequestDraft(rawDraft, questions.length),
    [questions.length, rawDraft],
  );
  const matchingRequest = matchingHubInputRequest(props.target, props.plan);
  const questionDrafts = useMemo(
    () =>
      Object.fromEntries(
        questions.map((question, index) => [
          question.id,
          answerFromDraft(question, draft.answers[index] ?? ""),
        ]),
      ) as Record<string, PendingUserInputDraftAnswer>,
    [draft.answers, questions],
  );
  const request = currentHubInputRequest(props.target, props.plan);
  const node = props.plan?.definition.nodes.find(
    (item) => item.key === props.target.request.nodeKey,
  );
  const stage = props.plan?.definition.stages.find(
    (item) => item.key === props.target.request.stageKey,
  );
  const canRespond = props.connected && request !== null;
  const resolvedDraftAnswers = buildPendingUserInputAnswers(questions, questionDrafts);
  const answers = resolvedDraftAnswers
    ? questions.map((question) => {
        const answer = resolvedDraftAnswers[question.id];
        return typeof answer === "string" ? answer : "";
      })
    : [];
  const allAnswersComplete =
    answers.length === questions.length && answers.every((answer) => answer.trim().length > 0);
  const activeQuestionIndex = Math.max(0, Math.min(draft.questionIndex, questions.length - 1));

  const persistDraft = (
    nextDrafts: Record<string, PendingUserInputDraftAnswer>,
    nextQuestionIndex: number,
  ) => {
    const nextAnswers = questions.map(
      (question) => resolvePendingUserInputAnswer(question, nextDrafts[question.id]) ?? "",
    );
    setHubInputRequestReplyDraft(
      draftKey,
      JSON.stringify({ answers: nextAnswers, questionIndex: nextQuestionIndex }),
    );
  };

  const updateCustomAnswer = (questionId: string, value: string) => {
    const question = questions.find((item) => item.id === questionId);
    if (!question) return;
    persistDraft(
      {
        ...questionDrafts,
        [questionId]: setPendingUserInputCustomAnswer(questionDrafts[questionId], value),
      },
      activeQuestionIndex,
    );
  };

  const toggleOption = (questionId: string, optionLabel: string) => {
    const question = questions.find((item) => item.id === questionId);
    if (!question) return null;
    const nextAnswer = togglePendingUserInputOptionSelection(
      question,
      questionDrafts[questionId],
      optionLabel,
    );
    persistDraft({ ...questionDrafts, [questionId]: nextAnswer }, activeQuestionIndex);
    return nextAnswer;
  };

  const advance = (answerOverrides?: Record<string, PendingUserInputDraftAnswer>) => {
    const nextDrafts = answerOverrides ? { ...questionDrafts, ...answerOverrides } : questionDrafts;
    const nextIndex = Math.min(activeQuestionIndex + 1, questions.length - 1);
    persistDraft(nextDrafts, nextIndex);
  };

  const previous = () => {
    persistDraft(questionDrafts, Math.max(0, activeQuestionIndex - 1));
  };

  const submit = async () => {
    if (!request || !canRespond || !allAnswersComplete || submissionInFlightRef.current) return;
    submissionInFlightRef.current = true;
    setSubmitting(true);
    setError(null);
    try {
      await props.onSubmit(
        request,
        answers.map((answer) => answer.trim()),
      );
      setHubInputRequestReplyDraft(draftKey, "");
      props.onCancel();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "提交回复失败，请重试。");
    } finally {
      submissionInFlightRef.current = false;
      setSubmitting(false);
    }
  };

  return (
    <section
      className="rounded-xl border border-border/70 bg-card/70 px-3 py-3"
      aria-label="回复 Hub Worker 的问题"
      data-hub-input-request-id={props.target.request.id}
    >
      <div className="mb-2 flex items-center justify-between gap-3">
        <p
          className="min-w-0 truncate text-ui-sm font-medium"
          title={node?.title ?? props.target.request.nodeKey}
        >
          回复「{node?.title ?? props.target.request.nodeKey}」 ·{" "}
          {stage?.title ?? props.target.request.stageKey} · 计划 v{props.target.revision}
        </p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={submitting}
          onClick={props.onCancel}
        >
          取消定向
        </Button>
      </div>
      {!props.connected ? (
        <p className="mb-2 text-ui-sm text-muted-foreground" role="status">
          服务正在同步，连接恢复后可继续提交。
        </p>
      ) : !request ? (
        <p className="mb-2 text-ui-sm text-muted-foreground" role="status">
          {matchingRequest && matchingRequest.status !== "pending"
            ? `${hubInputRequestReceipt(matchingRequest.status)}。草稿已保留；当前不能提交。`
            : "此问题已过期或执行尝试已变化。草稿已保留；当前不能提交。"}
        </p>
      ) : null}
      <UserInputQuestionForm
        questions={questions}
        submissionVersion={0}
        isResponding={submitting}
        answers={questionDrafts}
        questionIndex={activeQuestionIndex}
        onToggleOption={toggleOption}
        onAdvance={advance}
        onPrevious={previous}
        autoAdvance
        keyboardShortcuts="local"
      >
        <div className="mt-2 space-y-2">
          <Textarea
            value={questionDrafts[questions[activeQuestionIndex]?.id ?? ""]?.customAnswer ?? ""}
            onChange={(event) => {
              const activeQuestion = questions[activeQuestionIndex];
              if (activeQuestion) updateCustomAnswer(activeQuestion.id, event.target.value);
            }}
            placeholder="也可以填写自定义回复"
            aria-label={`自定义回复：${props.target.request.questions[activeQuestionIndex]?.title ?? "Worker 问题"}`}
            className="min-h-16 text-ui-sm"
            disabled={submitting}
          />
          {error ? (
            <p className="text-ui-sm text-destructive" role="alert">
              {error}
            </p>
          ) : null}
          <div className="flex items-center justify-between gap-3">
            <p className="text-ui-xs text-muted-foreground">
              回复发给此 Worker；提交不会放行计划。
            </p>
            <Button
              type="button"
              disabled={!canRespond || submitting || !allAnswersComplete}
              onClick={() => void submit()}
            >
              {submitting ? "提交中…" : "提交回复"}
            </Button>
          </div>
        </div>
      </UserInputQuestionForm>
    </section>
  );
}
