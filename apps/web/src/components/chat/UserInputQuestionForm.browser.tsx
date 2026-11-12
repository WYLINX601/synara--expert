import "../../index.css";
import {
  ApprovalRequestId,
  MessageId,
  ThreadId,
  TurnId,
  type NativeApi,
  type UserInputQuestion,
} from "@synara/contracts";
import { Schema } from "effect";
import { useRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import { ComposerPendingUserInputPanel } from "./ComposerPendingUserInputPanel";
import { AsyncUserInputCard } from "./AsyncUserInputCard";
import { resetComposerDraftStore } from "../../composerDraftStoreTestFixtures";
import { makeActivity, makeThread } from "../../storeTestFixtures";
import { useChatPendingInteractions } from "./useChatPendingInteractions";

const originalNativeApi = window.nativeApi;

afterEach(() => {
  resetComposerDraftStore();
  if (originalNativeApi) window.nativeApi = originalNativeApi;
  else delete window.nativeApi;
});

const ignoreComposerUpdate = () => undefined;

function waitForChoiceAutoAdvance() {
  return new Promise<void>((resolve) => window.setTimeout(resolve, 250));
}

async function mountDecisionFlow(questions: ReadonlyArray<UserInputQuestion>) {
  const dispatchCommand = vi
    .fn<(_command: unknown) => Promise<void>>()
    .mockResolvedValue(undefined);
  window.nativeApi = {
    orchestration: {
      dispatchCommand,
      subscribeThread: vi.fn(async () => undefined),
    },
  } as unknown as NativeApi;
  const threadId = ThreadId.makeUnsafe("decision-flow-thread");
  const turnId = TurnId.makeUnsafe("decision-flow-turn");
  const createdAt = "2026-11-08T00:00:00Z";
  const thread = makeThread({
    id: threadId,
    hasPendingUserInput: true,
    session: {
      provider: "codex",
      status: "running",
      orchestrationStatus: "running",
      activeTurnId: turnId,
      createdAt,
      updatedAt: createdAt,
    },
    activities: [
      makeActivity({
        kind: "user-input.requested",
        createdAt,
        turnId,
        payload: Schema.decodeUnknownSync(Schema.Json)({
          requestId: ApprovalRequestId.makeUnsafe("decision-flow-request"),
          questions,
        }),
      }),
    ],
  });
  function DecisionFlow() {
    const promptRef = useRef("");
    const interactions = useChatPendingInteractions({
      threadId,
      activeThread: thread,
      runtimeMode: "approval-required",
      promptRef,
      setPrompt: ignoreComposerUpdate,
      setComposerCursor: ignoreComposerUpdate,
      setComposerTrigger: ignoreComposerUpdate,
      setComposerHighlightedItemId: ignoreComposerUpdate,
    });
    return (
      <ComposerPendingUserInputPanel
        pendingUserInputs={interactions.pendingUserInputs}
        submissionVersion={interactions.userInputSubmissionVersion}
        isResponding={interactions.activePendingIsResponding}
        answers={interactions.activePendingDraftAnswers}
        questionIndex={interactions.activePendingQuestionIndex}
        onToggleOption={interactions.onToggleActivePendingUserInputOption}
        onAdvance={interactions.onAdvanceActivePendingUserInput}
        onPrevious={interactions.onPreviousActivePendingUserInputQuestion}
        onCancel={interactions.onCancelActivePendingUserInput}
        compact
        customAnswerEntry={{
          onChange: (value) =>
            interactions.onChangeActivePendingUserInputCustomAnswer(
              interactions.activePendingQuestion!.id,
              value,
              value.length,
              value.length,
              false,
            ),
        }}
      />
    );
  }
  const screen = await render(<DecisionFlow />);
  return { screen, dispatchCommand };
}

const prompt = {
  requestId: ApprovalRequestId.makeUnsafe("blocking-question"),
  createdAt: "2026-09-15T00:00:00Z",
  questions: [
    {
      id: "question",
      header: "Choose",
      question: "Which option?",
      multiSelect: false,
      options: [
        { label: "First", description: "First" },
        { label: "Second", description: "Second" },
      ],
    },
  ],
};

const props = () => ({
  pendingUserInputs: [prompt],
  answers: {},
  questionIndex: 0,
  submissionVersion: 0,
  isResponding: false,
  onToggleOption: vi.fn((_questionId: string, label: string) => ({
    selectedOptionLabels: [label],
  })),
  onAdvance: vi.fn(),
  onPrevious: vi.fn(),
  onCancel: vi.fn(),
});

describe("shared question form with blocking prompts", () => {
  it("shows the header, full question, descriptions and active custom answer mode", async () => {
    const callbacks = props();
    const input = {
      ...prompt,
      questions: [
        {
          ...prompt.questions[0]!,
          header: "Continuation",
          question: "Where should this discussion continue?",
          options: [
            {
              label: "Original thread",
              description: "Keep the existing discussion and its history.",
            },
          ],
        },
      ],
    };
    const screen = await render(
      <ComposerPendingUserInputPanel
        {...callbacks}
        pendingUserInputs={[input]}
        answers={{ question: { customAnswer: "Discuss here" } }}
      />,
    );
    await expect.element(screen.getByText("Continuation", { exact: true })).toBeVisible();
    await expect
      .element(screen.getByText(input.questions[0]!.question, { exact: true }))
      .toBeVisible();
    await expect
      .element(screen.getByText("Keep the existing discussion and its history.", { exact: true }))
      .toBeVisible();
    await expect.element(screen.getByRole("status")).toHaveTextContent("Using custom answer.");
    await screen.getByRole("button", { name: /Original thread/ }).click();
    expect(callbacks.onToggleOption).toHaveBeenCalledExactlyOnceWith("question", "Original thread");
  });

  it("cancels pending option submission when the user switches to custom input", async () => {
    const callbacks = props();
    const screen = await render(<ComposerPendingUserInputPanel {...callbacks} />);
    await screen.getByRole("button", { name: /Second/ }).click();
    await screen.rerender(
      <ComposerPendingUserInputPanel
        {...callbacks}
        answers={{ question: { customAnswer: "A different answer" } }}
      />,
    );
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(callbacks.onAdvance).not.toHaveBeenCalled();
    await expect.element(screen.getByRole("status")).toHaveTextContent("Using custom answer.");
  });
  it("offers Cancel with choices and stops pending auto-advance", async () => {
    const callbacks = props();
    const screen = await render(<ComposerPendingUserInputPanel {...callbacks} />);
    await screen.getByRole("button", { name: /Second/ }).click();
    await screen.getByRole("button", { name: "Cancel" }).click();
    expect(callbacks.onCancel).toHaveBeenCalledOnce();
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(callbacks.onAdvance).not.toHaveBeenCalled();
  });

  it("keeps Cancel available when a question has no choices", async () => {
    const callbacks = props();
    const noChoicePrompt = {
      ...prompt,
      questions: [{ ...prompt.questions[0]!, options: [] }],
    };
    const screen = await render(
      <ComposerPendingUserInputPanel {...callbacks} pendingUserInputs={[noChoicePrompt]} />,
    );
    await screen.getByRole("button", { name: "Cancel" }).click();
    expect(callbacks.onCancel).toHaveBeenCalledOnce();
  });

  it("preserves global digit shortcuts and advances with the newly selected answer", async () => {
    const callbacks = props();
    await render(<ComposerPendingUserInputPanel {...callbacks} />);
    await userEvent.keyboard("2");
    expect(callbacks.onToggleOption).toHaveBeenCalledExactlyOnceWith("question", "Second");
    await expect
      .poll(() => callbacks.onAdvance.mock.calls)
      .toEqual([[{ question: { selectedOptionLabels: ["Second"] } }]]);
  });

  it("answers through the last choice row instead of the composer editor", async () => {
    const callbacks = props();
    const onChange = vi.fn();
    const screen = await render(
      <ComposerPendingUserInputPanel
        {...callbacks}
        answers={{ question: { customAnswer: "Keep it simple" } }}
        customAnswerEntry={{ onChange }}
      />,
    );
    const answer = screen.getByRole("textbox");
    expect((answer.element() as HTMLTextAreaElement).value).toBe("Keep it simple");
    expect(screen.getByRole("status").elements()).toHaveLength(0);

    await userEvent.keyboard("3");
    expect(document.activeElement).toBe(answer.element());

    await userEvent.keyboard("!");
    expect(onChange).toHaveBeenCalledWith("Keep it simple!");

    await userEvent.keyboard("{Enter}");
    expect(callbacks.onAdvance).toHaveBeenCalledOnce();
  });

  it("can confirm a multi-select answer without the hidden composer footer", async () => {
    const callbacks = props();
    const screen = await render(
      <ComposerPendingUserInputPanel
        {...callbacks}
        pendingUserInputs={[
          { ...prompt, questions: [{ ...prompt.questions[0]!, multiSelect: true }] },
        ]}
        answers={{ question: { selectedOptionLabels: ["First", "Second"] } }}
        customAnswerEntry={{ onChange: vi.fn() }}
      />,
    );
    await screen.getByRole("button", { name: "Submit answers", exact: true }).click();
    expect(callbacks.onAdvance).toHaveBeenCalledOnce();
  });

  it("navigates multiple questions without auto-submitting multi-select choices or losing drafts", async () => {
    const { screen, dispatchCommand } = await mountDecisionFlow([
      { ...prompt.questions[0]!, multiSelect: true },
      { id: "details", header: "Details", question: "What else?", options: [] },
    ]);
    await expect.element(screen.getByText("Next question", { exact: true })).toBeDisabled();
    await screen.getByRole("button", { name: /First/ }).click();
    await screen.getByRole("button", { name: /Second/ }).click();
    await waitForChoiceAutoAdvance();
    expect(dispatchCommand).not.toHaveBeenCalled();
    await expect.element(screen.getByText("Which option?", { exact: true })).toBeVisible();
    await screen.getByText("Next question", { exact: true }).click();
    await expect.element(screen.getByRole("button", { name: "Submit answers" })).toBeDisabled();
    await screen.getByRole("textbox").fill("继续讨论");
    await screen.getByRole("button", { name: "Previous question" }).click();
    await expect
      .element(screen.getByRole("button", { name: /First/ }))
      .toHaveAttribute("aria-pressed", "true");
    await expect
      .element(screen.getByRole("button", { name: /Second/ }))
      .toHaveAttribute("aria-pressed", "true");
    await screen.getByText("Next question", { exact: true }).click();
    await expect.element(screen.getByRole("textbox")).toHaveValue("继续讨论");
    await screen.getByRole("button", { name: "Submit answers" }).click();
    await expect
      .poll(() => dispatchCommand.mock.calls)
      .toEqual([
        [
          expect.objectContaining({
            type: "thread.user-input.respond",
            answers: { question: ["First", "Second"], details: "继续讨论" },
          }),
        ],
      ]);
  });

  it.each([true, false])(
    "preserves multi-select custom-answer combination policy (%s)",
    async (allowCustomAnswerWithOptions) => {
      const { screen, dispatchCommand } = await mountDecisionFlow([
        { ...prompt.questions[0]!, multiSelect: true, allowCustomAnswerWithOptions },
      ]);
      await screen.getByRole("button", { name: /First/ }).click();
      await screen.getByRole("textbox").fill("另一种方案");
      await expect
        .element(screen.getByRole("button", { name: /First/ }))
        .toHaveAttribute("aria-pressed", String(allowCustomAnswerWithOptions));
      await screen.getByRole("button", { name: /Second/ }).click();
      await expect
        .element(screen.getByRole("textbox"))
        .toHaveValue(allowCustomAnswerWithOptions ? "另一种方案" : "");
      await waitForChoiceAutoAdvance();
      expect(dispatchCommand).not.toHaveBeenCalled();
      await screen.getByRole("button", { name: "Submit answers" }).click();
      await expect
        .poll(() => dispatchCommand.mock.calls)
        .toEqual([
          [
            expect.objectContaining({
              answers: {
                question: allowCustomAnswerWithOptions
                  ? ["First", "Second", "另一种方案"]
                  : ["Second"],
              },
            }),
          ],
        ]);
    },
  );

  it("requires a meaningful no-option answer and preserves composition and Shift+Enter", async () => {
    const { screen, dispatchCommand } = await mountDecisionFlow([
      { ...prompt.questions[0]!, options: [] },
    ]);
    const submit = screen.getByRole("button", { name: "Submit answers" });
    const answer = screen.getByRole("textbox");
    await expect.element(submit).toBeDisabled();
    await answer.fill("   ");
    await userEvent.keyboard("{Enter}");
    expect(dispatchCommand).not.toHaveBeenCalled();
    await answer.fill("中文回答");
    const composingEnter = new KeyboardEvent("keydown", {
      key: "Enter",
      bubbles: true,
      cancelable: true,
      isComposing: true,
    });
    expect(answer.element().dispatchEvent(composingEnter)).toBe(true);
    expect(dispatchCommand).not.toHaveBeenCalled();
    const compositionCommit = new KeyboardEvent("keydown", {
      key: "Enter",
      keyCode: 229,
      bubbles: true,
      cancelable: true,
      isComposing: false,
    });
    expect(answer.element().dispatchEvent(compositionCommit)).toBe(true);
    expect(dispatchCommand).not.toHaveBeenCalled();
    await userEvent.keyboard("{Shift>}{Enter}{/Shift}第二行");
    await expect.element(answer).toHaveValue("中文回答\n第二行");
    expect(dispatchCommand).not.toHaveBeenCalled();
    await userEvent.keyboard("{Enter}");
    await expect
      .poll(() => dispatchCommand.mock.calls)
      .toEqual([[expect.objectContaining({ answers: { question: "中文回答\n第二行" } })]]);
  });

  it("disables decision controls during submission and keeps the answer retryable after failure", async () => {
    const { screen, dispatchCommand } = await mountDecisionFlow([
      { ...prompt.questions[0]!, multiSelect: true },
    ]);
    let rejectResponse!: (error: Error) => void;
    const response = new Promise<void>((_resolve, reject) => {
      rejectResponse = reject;
    });
    dispatchCommand.mockImplementationOnce(() => response);
    await screen.getByRole("button", { name: /First/ }).click();
    await screen.getByRole("button", { name: "Submit answers" }).click();
    await expect.element(screen.getByRole("button", { name: "Submitting..." })).toBeDisabled();
    await expect.element(screen.getByRole("textbox")).toBeDisabled();
    await expect.element(screen.getByRole("button", { name: /Second/ })).toBeDisabled();
    await expect.element(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    await userEvent.keyboard("2{Enter}");
    expect(dispatchCommand).toHaveBeenCalledOnce();
    rejectResponse(new Error("Temporary failure"));
    await expect.element(screen.getByRole("button", { name: "Submit answers" })).toBeEnabled();
    await expect
      .element(screen.getByRole("button", { name: /First/ }))
      .toHaveAttribute("aria-pressed", "true");
    await screen.getByRole("button", { name: "Submit answers" }).click();
    await expect.poll(() => dispatchCommand.mock.calls.length).toBe(2);
    expect(dispatchCommand.mock.calls[1]).toEqual([
      expect.objectContaining({ answers: { question: ["First"] } }),
    ]);
  });

  it("cancels a queued single-choice advance after immediate failure and permits an explicit retry", async () => {
    const { screen, dispatchCommand } = await mountDecisionFlow(prompt.questions);
    dispatchCommand.mockRejectedValueOnce(new Error("Immediate failure"));
    await screen.getByRole("button", { name: /Second/ }).click();
    await screen.getByRole("button", { name: "Submit answers" }).click();
    await expect.poll(() => dispatchCommand.mock.calls.length).toBe(1);
    await expect.element(screen.getByRole("button", { name: "Submit answers" })).toBeEnabled();
    await waitForChoiceAutoAdvance();
    expect(dispatchCommand).toHaveBeenCalledOnce();
    await screen.getByRole("button", { name: "Submit answers" }).click();
    await expect.poll(() => dispatchCommand.mock.calls.length).toBe(2);
    expect(dispatchCommand.mock.calls[1]).toEqual([
      expect.objectContaining({ answers: { question: "Second" } }),
    ]);
  });

  it("keeps a long compact question bounded with a sticky header and reachable confirmation", async () => {
    const { screen, dispatchCommand } = await mountDecisionFlow([
      {
        ...prompt.questions[0]!,
        multiSelect: true,
        options: Array.from({ length: 30 }, (_, index) => ({
          label: `Choice ${index + 1}`,
          description: "Detailed decision context that must remain scrollable.",
        })),
      },
    ]);
    const heading = screen.getByText("Which option?", { exact: true }).element();
    const header = heading.parentElement!.parentElement!;
    const surface = header.parentElement!;
    const heightLimit = 20 * Number.parseFloat(getComputedStyle(document.documentElement).fontSize);
    expect(surface.clientHeight).toBeLessThanOrEqual(heightLimit);
    expect(surface.scrollHeight).toBeGreaterThan(surface.clientHeight);
    surface.scrollTop = 40;
    await expect.poll(() => surface.scrollTop).toBe(40);
    const headerTop = header.getBoundingClientRect().top;
    surface.scrollTop = surface.scrollHeight;
    await expect.poll(() => surface.scrollTop).toBeGreaterThan(0);
    expect(Math.abs(header.getBoundingClientRect().top - headerTop)).toBeLessThan(1);
    await screen.getByRole("button", { name: /Choice 30/ }).click();
    await screen.getByRole("button", { name: "Submit answers" }).click();
    await expect
      .poll(() => dispatchCommand.mock.calls)
      .toEqual([[expect.objectContaining({ answers: { question: ["Choice 30"] } })]]);
  });

  it("does not add compact confirmation controls to ordinary blocking prompts", async () => {
    const screen = await render(<ComposerPendingUserInputPanel {...props()} />);
    expect(screen.getByRole("button", { name: "Submit answers" }).elements()).toHaveLength(0);
    expect(screen.getByRole("textbox").elements()).toHaveLength(0);
  });

  it("cancels delayed choice advancement when a response starts", async () => {
    const callbacks = props();
    const screen = await render(<ComposerPendingUserInputPanel {...callbacks} />);
    await screen.getByRole("button", { name: /Second/ }).click();
    await screen.rerender(
      <ComposerPendingUserInputPanel {...callbacks} isResponding submissionVersion={1} />,
    );
    await expect.element(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(callbacks.onAdvance).not.toHaveBeenCalled();
  });

  it("does not consume shortcuts from an open async form", async () => {
    const callbacks = props();
    const screen = await render(
      <>
        <AsyncUserInputCard
          messageId={MessageId.makeUnsafe("async")}
          input={{ questions: [{ title: "Async question?", options: ["Only choice"] }] }}
          onRespond={vi.fn()}
        />
        <ComposerPendingUserInputPanel {...callbacks} />
      </>,
    );
    await screen.getByRole("button", { name: "1 question", exact: true }).click();
    await screen.getByRole("button", { name: /Only choice/ }).click();
    await userEvent.keyboard("2");
    expect(callbacks.onToggleOption).not.toHaveBeenCalled();
  });
});
