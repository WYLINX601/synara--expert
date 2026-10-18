import {
  CONTEXT_GOAL_MAX_LENGTH,
  CONTEXT_INSTRUCTIONS_MAX_LENGTH,
  type SpaceContextSettings,
} from "@synara/contracts";
import { useId } from "react";

import { Button } from "./ui/button";
import { Textarea } from "./ui/textarea";
import type { SpaceEditorValue } from "./SpaceEditorDialog";

export interface SpaceContextFieldsDraft {
  readonly directionGoal: string;
  readonly sharedInstructions: string;
}

export function SpaceContextFieldsEditor(props: {
  readonly draft: SpaceContextFieldsDraft;
  readonly metadataDraft: SpaceEditorValue | null;
  readonly disabled: boolean;
  readonly loading: boolean;
  readonly ready: boolean;
  readonly error: string | null;
  readonly conflict: SpaceContextSettings | null;
  readonly onChange: (draft: SpaceContextFieldsDraft) => void;
  readonly onUseSaved: () => void;
  readonly onKeepDraft: () => void;
  readonly keepDraftDisabled?: boolean;
  readonly onRetry: () => void;
}) {
  const goalId = useId();
  const instructionsId = useId();

  if (props.loading) {
    return <p className="text-ui-sm text-muted-foreground">Loading Space context…</p>;
  }
  if (!props.ready) {
    return (
      <div className="space-y-2">
        {props.error ? (
          <p role="alert" className="text-ui-sm text-destructive">
            {props.error}
          </p>
        ) : null}
        <Button type="button" variant="outline" size="xs" onClick={props.onRetry}>
          Retry loading context
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-3 border-t border-[color:var(--color-border-light)] pt-3">
      <div className="space-y-1.5">
        <label htmlFor={goalId} className="block text-ui-sm font-medium">
          Direction goal
        </label>
        <Textarea
          id={goalId}
          className="w-full border-[color:var(--color-border-light)] bg-transparent text-ui text-foreground"
          value={props.draft.directionGoal}
          onChange={(event) =>
            props.onChange({ ...props.draft, directionGoal: event.target.value })
          }
          placeholder="Describe the shared direction for this Space"
          disabled={props.disabled}
        />
        <Counter value={props.draft.directionGoal} limit={CONTEXT_GOAL_MAX_LENGTH} />
      </div>
      <div className="space-y-1.5">
        <label htmlFor={instructionsId} className="block text-ui-sm font-medium">
          Shared instructions
        </label>
        <Textarea
          id={instructionsId}
          className="w-full border-[color:var(--color-border-light)] bg-transparent text-ui text-foreground"
          value={props.draft.sharedInstructions}
          onChange={(event) =>
            props.onChange({ ...props.draft, sharedInstructions: event.target.value })
          }
          placeholder="Conventions that apply to projects in this Space"
          disabled={props.disabled}
        />
        <Counter value={props.draft.sharedInstructions} limit={CONTEXT_INSTRUCTIONS_MAX_LENGTH} />
      </div>
      {props.conflict ? (
        <section className="space-y-2 rounded-lg border border-[color:var(--color-border-light)] p-3">
          <p className="text-ui-sm font-medium">Space context changed elsewhere</p>
          <p className="text-ui-xs text-muted-foreground">
            Saved name and icon: {props.conflict.name} · {props.conflict.icon} · revision{" "}
            {props.conflict.revision}
          </p>
          <CompareBlock label="Saved direction goal" value={props.conflict.directionGoal} />
          <CompareBlock label="Your direction goal" value={props.draft.directionGoal} />
          <CompareBlock
            label="Saved shared instructions"
            value={props.conflict.sharedInstructions}
          />
          <CompareBlock label="Your shared instructions" value={props.draft.sharedInstructions} />
          {props.metadataDraft ? (
            <p className="text-ui-xs text-muted-foreground">
              Your name and icon: {props.metadataDraft.name} · {props.metadataDraft.icon}
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button type="button" size="xs" variant="outline" onClick={props.onUseSaved}>
              Use saved values
            </Button>
            <Button
              type="button"
              size="xs"
              disabled={props.keepDraftDisabled}
              onClick={props.onKeepDraft}
            >
              Keep my edits
            </Button>
          </div>
          {props.error ? (
            <p role="alert" className="text-ui-xs text-destructive">
              {props.error}
            </p>
          ) : null}
        </section>
      ) : null}
      {props.error && !props.conflict ? (
        <p role="alert" className="text-ui-sm text-destructive">
          {props.error}
          {props.disabled ? " Save again to confirm the original command." : ""}
        </p>
      ) : null}
    </div>
  );
}

function Counter({ value, limit }: { value: string; limit: number }) {
  const over = value.length > limit;
  if (!over) return null;
  return (
    <p className="text-right text-ui-xs text-muted-foreground" aria-live="polite">
      {value.length} / {limit}
      {over ? (
        <span role="alert" className="ml-2 text-destructive">
          Limit exceeded
        </span>
      ) : null}
    </p>
  );
}

function CompareBlock({ label, value }: { label: string; value: string }) {
  return (
    <div className="space-y-0.5">
      <p className="text-ui-xs font-medium">{label}</p>
      <p className="whitespace-pre-wrap break-words text-ui-xs text-muted-foreground">
        {value || "Empty"}
      </p>
    </div>
  );
}
