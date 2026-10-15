// FILE: SpaceEditorDialog.tsx
// Purpose: Shared create/edit dialog for a Space name and curated Central icon.

import { SPACE_NAME_MAX_LENGTH } from "@synara/contracts";
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ComponentProps,
  type KeyboardEvent,
  type ReactNode,
} from "react";

import { DEFAULT_SPACE_ICON, DEFAULT_VOID_SPACE_ICON } from "~/lib/spaceGrouping";
import { suggestSpaceIcon } from "~/lib/spaceIconSuggestion";

import { Button } from "./ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
  dialogFieldLabelClassName,
} from "./ui/dialog";
import { Input } from "./ui/input";
import {
  SPACE_ICON_OPTIONS,
  SpaceIcon,
  VOID_SPACE_ICON_OPTIONS,
  type SpaceIconValue,
} from "./SpaceIcon";
import { cn } from "~/lib/utils";

const FIELD_LABEL_CLASS_NAME = dialogFieldLabelClassName;

const ICON_CELL_CLASS_NAME =
  "flex aspect-square cursor-pointer items-center justify-center rounded-lg border text-muted-foreground transition-colors outline-hidden hover:bg-foreground/6 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50";

export interface SpaceEditorValue {
  readonly name: string;
  readonly icon: SpaceIconValue;
}

/**
 * `void` edits the group of projects that are in no Space. It is the same form — a name and
 * an icon — over a presentation preference instead of a stored row, so it shares this dialog
 * rather than growing a near-identical second one.
 */
export type SpaceEditorMode = "create" | "edit" | "void";

export function SpaceEditorDialog(props: {
  open: boolean;
  mode: SpaceEditorMode;
  initialValue?: SpaceEditorValue | undefined;
  /** Names already taken by another Space (or by Void), which this one may not collide with. */
  existingNames: ReadonlyArray<string>;
  onOpenChange: (open: boolean) => void;
  onSubmit: (value: SpaceEditorValue) => Promise<void> | void;
  /** Reports the current name and icon draft so a parent can include it in dirty-state guards. */
  onValueChange?: ((value: SpaceEditorValue) => void) | undefined;
  /** Optional fields rendered only while editing a stored Space. */
  bodyContent?: ReactNode;
  /** Optional return target when the original menu item is no longer mounted. */
  finalFocus?: ComponentProps<typeof DialogPopup>["finalFocus"];
  /** Parent-owned validation or persistence can keep Save unavailable. */
  submitDisabled?: boolean;
  /** Explicitly re-seeds the metadata fields after a server conflict comparison. */
  resetValue?: SpaceEditorValue;
  resetVersion?: number;
  /** Preserve the legacy submitting behavior unless a parent opts into field/close locking. */
  lockWhileSubmitting?: boolean;
  /** Prevents Escape, outside press, and the close affordance from dismissing the dialog. */
  closeDisabled?: boolean;
}) {
  const isVoid = props.mode === "void";
  const iconOptions = isVoid ? VOID_SPACE_ICON_OPTIONS : SPACE_ICON_OPTIONS;
  const defaultIcon: SpaceIconValue = isVoid ? DEFAULT_VOID_SPACE_ICON : DEFAULT_SPACE_ICON;
  const onValueChange = props.onValueChange;
  const [name, setName] = useState("");
  const [icon, setIcon] = useState<SpaceIconValue>(defaultIcon);
  /**
   * In create mode the icon tracks the name (`suggestSpaceIcon`) until the user taps
   * the grid, which pins their choice. Editing starts pinned: a rename must never
   * silently swap an icon someone already chose.
   */
  const [iconPinned, setIconPinned] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const nameInputRef = useRef<HTMLInputElement | null>(null);
  const openedRef = useRef(false);
  const resetVersionRef = useRef(props.resetVersion);
  const fieldId = useId();
  const nameInputId = `${fieldId}-name`;
  const nameErrorId = `${fieldId}-name-error`;
  const iconLegendId = `${fieldId}-icon-legend`;

  useEffect(() => {
    // Seed on the closed -> open transition only. `initialValue` is recomputed from the
    // live snapshot every render, so seeding whenever it changes would let a rename from
    // another window overwrite the name the user is part-way through typing here.
    if (props.open === openedRef.current) return;
    openedRef.current = props.open;
    if (!props.open) return;
    const initialName = props.initialValue?.name ?? "";
    const initialIcon = props.initialValue?.icon ?? defaultIcon;
    setName(initialName);
    setIcon(initialIcon);
    onValueChange?.({ name: initialName, icon: initialIcon });
    setIconPinned(props.mode !== "create");
    setSubmitting(false);
    setSubmitError(null);
    // Deferred a frame: the dialog moves focus itself on open, so selecting the name
    // has to happen after that lands or it is immediately undone. Matches PickerPanelShell.
    const frame = requestAnimationFrame(() => nameInputRef.current?.select());
    return () => cancelAnimationFrame(frame);
  }, [
    defaultIcon,
    props.initialValue?.icon,
    props.initialValue?.name,
    props.mode,
    onValueChange,
    props.open,
  ]);

  useEffect(() => {
    if (!props.open || resetVersionRef.current === props.resetVersion) return;
    resetVersionRef.current = props.resetVersion;
    const value = props.resetValue ?? props.initialValue ?? { name: "", icon: defaultIcon };
    setName(value.name);
    setIcon(value.icon);
    setIconPinned(props.mode !== "create");
    setSubmitError(null);
    onValueChange?.(value);
  }, [
    defaultIcon,
    onValueChange,
    props.initialValue,
    props.mode,
    props.open,
    props.resetValue,
    props.resetVersion,
  ]);

  const trimmedName = name.trim();
  const duplicateName = props.existingNames.some(
    (existingName) => existingName.trim().toLowerCase() === trimmedName.toLowerCase(),
  );
  const nameError =
    trimmedName.length === 0
      ? "Enter a name."
      : duplicateName
        ? // Deliberately not "a space with this name": the taken name may be Void's, which
          // is not a space, and either way the user's next move is the same.
          "That name is already taken."
        : null;
  // An empty field is a starting point, not a mistake — only speak up once there is input.
  const visibleNameError = name.length > 0 ? nameError : null;

  const submit = async () => {
    if (nameError || submitting || props.submitDisabled) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      await props.onSubmit({ name: trimmedName, icon });
      props.onOpenChange(false);
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : "Unable to save the space.");
      setSubmitting(false);
    }
  };

  // The grid reflows between 10 and 5 columns, so the icons are driven as one linear
  // radio group: either axis steps to the neighbouring icon and selects it.
  const handleIconKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    const stepByKey: Record<string, number | "first" | "last"> = {
      ArrowLeft: -1,
      ArrowUp: -1,
      ArrowRight: 1,
      ArrowDown: 1,
      Home: "first",
      End: "last",
    };
    const step = stepByKey[event.key];
    if (step === undefined) return;
    const cells = Array.from(
      event.currentTarget.querySelectorAll<HTMLButtonElement>("[data-space-icon]"),
    );
    if (cells.length === 0) return;
    const currentIndex = cells.indexOf(document.activeElement as HTMLButtonElement);
    const nextIndex =
      step === "first"
        ? 0
        : step === "last"
          ? cells.length - 1
          : (Math.max(currentIndex, 0) + step + cells.length) % cells.length;
    event.preventDefault();
    cells[nextIndex]?.focus();
    cells[nextIndex]?.click();
  }, []);

  const handleOpenChange = (open: boolean) => {
    if (!open && (props.closeDisabled || (props.lockWhileSubmitting && submitting))) return;
    props.onOpenChange(open);
  };

  return (
    <Dialog open={props.open} onOpenChange={handleOpenChange}>
      <DialogPopup
        finalFocus={props.finalFocus}
        className="max-w-sm"
        showCloseButton={!(props.closeDisabled || (props.lockWhileSubmitting && submitting))}
      >
        <DialogHeader>
          <DialogTitle>
            {props.mode === "create" ? "New space" : isVoid ? "Edit unfiled group" : "Edit space"}
          </DialogTitle>
          <DialogDescription>
            {props.mode === "create"
              ? "Group projects into a focused work context. Projects you add while a space is open land in it."
              : isVoid
                ? "Name the group that holds projects you haven't filed into a space. This is a local preference — the projects in it stay where they are."
                : "Rename this space or give it a different icon. Its projects stay where they are."}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-4">
          {/* The error sits outside the label on purpose: text inside a wrapping label
              becomes part of the field's accessible name, so nesting it here would have
              the field announce itself as "Name A space with this name already exists."
              and then repeat the message as its description. */}
          <div className="space-y-1.5">
            <label htmlFor={nameInputId} className={cn("block", FIELD_LABEL_CLASS_NAME)}>
              Name
            </label>
            <Input
              id={nameInputId}
              ref={nameInputRef}
              value={name}
              disabled={props.lockWhileSubmitting && submitting}
              maxLength={SPACE_NAME_MAX_LENGTH}
              aria-invalid={Boolean(visibleNameError)}
              {...(visibleNameError ? { "aria-describedby": nameErrorId } : {})}
              onChange={(event) => {
                const nextName = event.target.value;
                const nextIcon = iconPinned ? icon : suggestSpaceIcon(nextName);
                setName(nextName);
                // The icon follows the name until the user pins one from the grid.
                if (!iconPinned) setIcon(nextIcon);
                props.onValueChange?.({ name: nextName, icon: nextIcon });
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void submit();
                }
              }}
              placeholder={isVoid ? "Unfiled" : "Work"}
            />
            {visibleNameError ? (
              <p id={nameErrorId} role="alert" className="text-ui-xs text-destructive">
                {visibleNameError}
              </p>
            ) : null}
          </div>

          <fieldset>
            <legend id={iconLegendId} className={cn("mb-2", FIELD_LABEL_CLASS_NAME)}>
              Icon
            </legend>
            <div
              role="radiogroup"
              aria-labelledby={iconLegendId}
              onKeyDown={handleIconKeyDown}
              className="grid grid-cols-10 gap-1.5 max-sm:grid-cols-5"
            >
              {iconOptions.map((option) => {
                const selected = icon === option.name;
                return (
                  <button
                    key={option.name}
                    type="button"
                    role="radio"
                    data-space-icon
                    aria-checked={selected}
                    aria-label={option.label}
                    // Roving tabindex: the whole grid is one tab stop.
                    tabIndex={selected ? 0 : -1}
                    disabled={props.lockWhileSubmitting && submitting}
                    onClick={() => {
                      setIcon(option.name);
                      setIconPinned(true);
                      props.onValueChange?.({ name, icon: option.name });
                    }}
                    className={cn(
                      ICON_CELL_CLASS_NAME,
                      selected
                        ? "border-foreground/25 bg-foreground/9 text-foreground"
                        : "border-transparent bg-foreground/3",
                    )}
                  >
                    <SpaceIcon icon={option.name} />
                  </button>
                );
              })}
            </div>
          </fieldset>
          {props.mode === "edit" && props.bodyContent !== undefined ? props.bodyContent : null}
          {submitError ? (
            <p role="alert" className="text-ui-xs text-destructive">
              {submitError}
            </p>
          ) : null}
        </DialogPanel>
        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => handleOpenChange(false)}
            disabled={submitting || props.closeDisabled}
          >
            Cancel
          </Button>
          <Button
            onClick={() => void submit()}
            disabled={Boolean(nameError) || submitting || props.submitDisabled}
          >
            {submitting ? "Saving…" : props.mode === "create" ? "Create space" : "Save"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
