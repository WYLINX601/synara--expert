// FILE: EnvironmentProjectInstructionsSection.tsx
// Purpose: Environment-panel section for project-scoped instructions that seed thread notes.
// Layer: Environment panel section
// Exports: EnvironmentProjectInstructionsSection

import { useEffect, useId, useRef, useState, type ChangeEventHandler, type ReactNode } from "react";
import { THREAD_NOTES_MAX_CHARS, type ProjectId } from "@synara/contracts";

import { Textarea } from "~/components/ui/textarea";
import { Button } from "~/components/ui/button";
import { CopyIcon } from "~/lib/icons";

import { EnvironmentCollapsibleSection } from "./EnvironmentRow";

const PROJECT_INSTRUCTIONS_AUTOSAVE_DEBOUNCE_MS = 500;

interface PendingProjectInstructionsSave {
  readonly projectId: ProjectId;
  readonly value: string;
  readonly lastCommitted: string;
}

function useProjectInstructionsAutosave({
  projectId,
  instructions,
  onChange,
}: {
  readonly projectId: ProjectId | null;
  readonly instructions: string;
  readonly onChange: (projectId: ProjectId, instructions: string) => void;
}) {
  const [value, setValue] = useState(instructions);
  const [focused, setFocused] = useState(false);
  const debounceRef = useRef<number | null>(null);
  const valueRef = useRef(value);
  const lastCommittedRef = useRef(instructions);
  const projectIdRef = useRef(projectId);
  const pendingSaveRef = useRef<PendingProjectInstructionsSave | null>(null);
  const onChangeRef = useRef(onChange);

  useEffect(() => {
    valueRef.current = value;
  }, [value]);

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  const flush = () => {
    if (debounceRef.current !== null) {
      window.clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    const pendingSave = pendingSaveRef.current;
    pendingSaveRef.current = null;
    if (pendingSave === null || pendingSave.value === pendingSave.lastCommitted) {
      return;
    }
    onChangeRef.current(pendingSave.projectId, pendingSave.value);
    if (projectIdRef.current === pendingSave.projectId) {
      lastCommittedRef.current = pendingSave.value;
    }
  };

  useEffect(() => {
    const projectChanged = projectIdRef.current !== projectId;
    if (projectChanged) {
      flush();
      projectIdRef.current = projectId;
      pendingSaveRef.current = null;
      valueRef.current = instructions;
      lastCommittedRef.current = instructions;
      setValue(instructions);
      return;
    }
    projectIdRef.current = projectId;
    if (
      !focused &&
      debounceRef.current === null &&
      pendingSaveRef.current === null &&
      instructions !== valueRef.current
    ) {
      valueRef.current = instructions;
      lastCommittedRef.current = instructions;
      setValue(instructions);
    }
  }, [flush, focused, instructions, projectId]);

  useEffect(() => {
    return () => {
      flush();
    };
  }, [flush]);

  const handleChange: ChangeEventHandler<HTMLTextAreaElement> = (event) => {
    const nextValue = event.target.value;
    valueRef.current = nextValue;
    setValue(nextValue);
    const currentProjectId = projectIdRef.current;
    if (!currentProjectId) {
      pendingSaveRef.current = null;
      if (debounceRef.current !== null) {
        window.clearTimeout(debounceRef.current);
        debounceRef.current = null;
      }
      return;
    }
    // Keep the project id with the pending payload; active projects can switch before debounce fires.
    pendingSaveRef.current = {
      projectId: currentProjectId,
      value: nextValue,
      lastCommitted: lastCommittedRef.current,
    };
    if (debounceRef.current !== null) {
      window.clearTimeout(debounceRef.current);
    }
    debounceRef.current = window.setTimeout(flush, PROJECT_INSTRUCTIONS_AUTOSAVE_DEBOUNCE_MS);
  };

  return {
    value,
    onChange: handleChange,
    onFocus: () => setFocused(true),
    onBlur: () => {
      setFocused(false);
      flush();
    },
  };
}

interface LegacyEnvironmentProjectInstructionsSectionProps {
  projectId: ProjectId | null;
  instructions: string;
  threadNotes: string;
  canCopyToThreadNotes: boolean;
  onInstructionsChange: (projectId: ProjectId, instructions: string) => void;
  onCopyToThreadNotes: () => void;
}

export interface ControlledProjectContextProps {
  goal: string;
  onGoalChange: (value: string) => void;
  instructions: string;
  onInstructionsChange: (value: string) => void;
  /** Read-only parent context, shown in a collapsed section above the project fields. */
  inheritedContent?: ReactNode;
  /** Collapsed heading for inherited content, e.g. "Inherited from Work". */
  inheritedLabel?: ReactNode;
  /** Parent-owned saving, failure, or conflict state. No default status copy is rendered. */
  status?: ReactNode;
  /** Parent-owned controls such as an explicit Save action. */
  actions?: ReactNode;
  /** Locks both controlled fields while parent validation or persistence is pending. */
  disabled?: boolean;
  /** Prevents copying a draft the parent has not committed yet. */
  copyDisabled?: boolean;
}

export type EnvironmentProjectInstructionsSectionProps =
  LegacyEnvironmentProjectInstructionsSectionProps & {
    controlledContext?: ControlledProjectContextProps;
  };

export function EnvironmentProjectInstructionsSection(
  props: EnvironmentProjectInstructionsSectionProps,
) {
  if (props.controlledContext) {
    return <ControlledProjectContextSection {...props} context={props.controlledContext} />;
  }

  return (
    <AutosavedProjectInstructionsSection
      projectId={props.projectId}
      instructions={props.instructions}
      threadNotes={props.threadNotes}
      canCopyToThreadNotes={props.canCopyToThreadNotes}
      onInstructionsChange={props.onInstructionsChange}
      onCopyToThreadNotes={props.onCopyToThreadNotes}
    />
  );
}

function AutosavedProjectInstructionsSection({
  projectId,
  instructions,
  threadNotes,
  canCopyToThreadNotes,
  onInstructionsChange,
  onCopyToThreadNotes,
}: LegacyEnvironmentProjectInstructionsSectionProps) {
  const autosave = useProjectInstructionsAutosave({
    projectId,
    instructions,
    onChange: onInstructionsChange,
  });
  const hasInstructions = autosave.value.trim().length > 0;
  const copyLabel = threadNotes.trim().length === 0 ? "Copy to notepad" : "Append to notepad";

  return (
    <EnvironmentCollapsibleSection label="Project instructions" defaultOpen={hasInstructions}>
      <div className="flex flex-col gap-2 px-2 pb-1">
        <ProjectContextTextarea
          value={autosave.value}
          onChange={autosave.onChange}
          onFocus={autosave.onFocus}
          onBlur={autosave.onBlur}
          placeholder="Architecture notes, conventions, repo links"
          maxLength={THREAD_NOTES_MAX_CHARS}
          disabled={!projectId}
        />
        {hasInstructions && canCopyToThreadNotes ? (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className="self-start"
            onClick={onCopyToThreadNotes}
          >
            <CopyIcon className="size-3.5" />
            {copyLabel}
          </Button>
        ) : null}
      </div>
    </EnvironmentCollapsibleSection>
  );
}

function ControlledProjectContextSection({
  threadNotes,
  canCopyToThreadNotes,
  onCopyToThreadNotes,
  context,
}: LegacyEnvironmentProjectInstructionsSectionProps & {
  context: ControlledProjectContextProps;
}) {
  const goalId = useId();
  const instructionsId = useId();
  const hasInstructions = context.instructions.trim().length > 0;
  const copyLabel = threadNotes.trim().length === 0 ? "Copy to notepad" : "Append to notepad";

  return (
    <div className="flex flex-col gap-1">
      {context.inheritedContent !== undefined ? (
        <EnvironmentCollapsibleSection
          label={context.inheritedLabel ?? "Inherited from Space"}
          defaultOpen={false}
        >
          {context.inheritedContent}
        </EnvironmentCollapsibleSection>
      ) : null}
      <EnvironmentCollapsibleSection
        label="Project goal"
        defaultOpen={context.goal.trim().length > 0}
      >
        <div className="flex flex-col gap-2 px-2 pb-1">
          <label htmlFor={goalId} className="sr-only">
            Project goal
          </label>
          <ProjectContextTextarea
            id={goalId}
            value={context.goal}
            onChange={(event) => context.onGoalChange(event.target.value)}
            placeholder="Describe the project goal"
            disabled={Boolean(context.disabled)}
          />
        </div>
      </EnvironmentCollapsibleSection>
      <EnvironmentCollapsibleSection label="Project instructions" defaultOpen={hasInstructions}>
        <div className="flex flex-col gap-2 px-2 pb-1">
          <label htmlFor={instructionsId} className="sr-only">
            Project instructions
          </label>
          <ProjectContextTextarea
            id={instructionsId}
            value={context.instructions}
            onChange={(event) => context.onInstructionsChange(event.target.value)}
            placeholder="Architecture notes, conventions, repo links"
            disabled={Boolean(context.disabled)}
          />
          {hasInstructions && canCopyToThreadNotes ? (
            <Button
              type="button"
              variant="ghost"
              size="xs"
              className="self-start"
              onClick={onCopyToThreadNotes}
              disabled={context.copyDisabled || context.disabled}
            >
              <CopyIcon className="size-3.5" />
              {copyLabel}
            </Button>
          ) : null}
        </div>
      </EnvironmentCollapsibleSection>
      {context.status != null ? (
        <div className="px-2 text-ui-sm" aria-live="polite">
          {context.status}
        </div>
      ) : null}
      {context.actions != null ? (
        <div className="flex flex-wrap items-center gap-2 px-2 pb-1">{context.actions}</div>
      ) : null}
    </div>
  );
}

function ProjectContextTextarea({
  value,
  id,
  onChange,
  onFocus,
  onBlur,
  placeholder,
  maxLength,
  disabled,
}: {
  value: string;
  id?: string;
  onChange: ChangeEventHandler<HTMLTextAreaElement>;
  onFocus?: () => void;
  onBlur?: () => void;
  placeholder: string;
  maxLength?: number;
  disabled?: boolean;
}) {
  return (
    <Textarea
      unstyled
      className="relative inline-flex w-full rounded-lg border border-[color:var(--color-border-light)] bg-transparent text-ui text-foreground transition-colors has-focus-visible:border-foreground/25 [&_[data-slot=textarea]]:px-3 [&_[data-slot=textarea]]:py-2"
      {...(id === undefined ? {} : { id })}
      value={value}
      onChange={onChange}
      onFocus={onFocus}
      onBlur={onBlur}
      placeholder={placeholder}
      {...(maxLength === undefined ? {} : { maxLength })}
      disabled={disabled}
    />
  );
}
