import type { PendingUserInput } from "../../session-logic";
import type { PendingUserInputDraftAnswer } from "../../pendingUserInput";
import { UserInputQuestionForm } from "./UserInputQuestionForm";

interface PendingUserInputPanelProps {
  pendingUserInputs: PendingUserInput[];
  submissionVersion: number;
  isResponding: boolean;
  answers: Record<string, PendingUserInputDraftAnswer>;
  questionIndex: number;
  onToggleOption: (questionId: string, optionLabel: string) => PendingUserInputDraftAnswer | null;
  onAdvance: (answerOverrides?: Record<string, PendingUserInputDraftAnswer>) => void;
  onPrevious: () => void;
  onCancel: () => void;
  customAnswerEntry?: { onChange: (value: string) => void } | undefined;
  compact?: boolean;
}

// Keep pending-input choices neutral so they read like Codex list controls instead of accent buttons.
export function ComposerPendingUserInputPanel({
  pendingUserInputs,
  submissionVersion,
  isResponding,
  answers,
  questionIndex,
  onToggleOption,
  onAdvance,
  onPrevious,
  onCancel,
  customAnswerEntry,
  compact = false,
}: PendingUserInputPanelProps) {
  if (pendingUserInputs.length === 0) return null;
  const activePrompt = pendingUserInputs[0];
  if (!activePrompt) return null;

  return (
    <UserInputQuestionForm
      key={`${activePrompt.requestId}:${activePrompt.lifecycleGeneration ?? "legacy"}`}
      questions={activePrompt.questions}
      submissionVersion={submissionVersion}
      isResponding={isResponding}
      answers={answers}
      questionIndex={questionIndex}
      onToggleOption={onToggleOption}
      onAdvance={onAdvance}
      onPrevious={onPrevious}
      onCancel={onCancel}
      customAnswerEntry={customAnswerEntry}
      compact={compact}
    />
  );
}
