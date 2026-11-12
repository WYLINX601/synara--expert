import { useCallback, useEffect, useRef } from "react";
import { useTranslation } from "~/i18n";
import { ChevronDownIcon, ChevronUpIcon, Maximize2, MinusIcon } from "~/lib/icons";
import { DISCLOSURE_FADE_MOTION_CLASS } from "~/lib/disclosureMotion";
import { IconButton } from "../ui/icon-button";
import { useZenMode } from "./ZenModeProvider";

/** One edge overlay for drawer disclosure and the existing native window actions. */
export function ZenModeToolbar({
  keyboardFocusRestore,
}: {
  /** Shared by mutually exclusive anchors so keyboard disclosure keeps its focus. */
  keyboardFocusRestore?: {
    requested: () => boolean;
    setRequested: (requested: boolean) => void;
  };
}) {
  const { t } = useTranslation();
  const { state, pending, setExpanded, exit, bubbleAvailable, collapseToBubble } = useZenMode();
  const localFocusRestoreRef = useRef(false);
  const localRequested = useCallback(() => localFocusRestoreRef.current, []);
  const localSetRequested = useCallback((requested: boolean) => {
    localFocusRestoreRef.current = requested;
  }, []);
  const requested = keyboardFocusRestore?.requested ?? localRequested;
  const setRequested = keyboardFocusRestore?.setRequested ?? localSetRequested;
  const drawerToggleRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!state.isActive || !requested()) return;
    const button = drawerToggleRef.current;
    const active = document.activeElement;
    if (
      active &&
      active !== document.body &&
      active !== document.documentElement &&
      active !== button
    ) {
      setRequested(false);
      return;
    }
    if (pending) {
      // A deliberate focus move while waiting cancels the request, including
      // when that target later blurs before the native operation completes.
      const cancelOnFocusMove = (event: FocusEvent) => {
        if (
          event.target !== document.body &&
          event.target !== document.documentElement &&
          event.target !== drawerToggleRef.current
        ) {
          setRequested(false);
        }
      };
      document.addEventListener("focusin", cancelOnFocusMove);
      return () => document.removeEventListener("focusin", cancelOnFocusMove);
    }
    setRequested(false);
    button?.focus({ preventScroll: true });
  }, [pending, requested, setRequested, state.expanded, state.isActive]);
  if (!state.isActive || state.isBubble) return null;
  const toggleLabel = t(state.expanded ? "chat:zenCollapse" : "chat:zenExpand");
  const bubbleLabel = t("chat:zenCollapseToBubble");
  const returnLabel = t("chat:zenReturn");
  return (
    <div
      role="group"
      aria-label={t("chat:zenWindowActions")}
      data-testid="zen-mode-toolbar"
      data-zen-hit-surface=""
      className={`zen-mode-toolbar pointer-events-auto absolute -top-3 left-1/2 z-20 flex h-6 -translate-x-1/2 items-center gap-0.5 rounded-full bg-popover px-1 shadow-sm ring-1 ring-border/70 [-webkit-app-region:no-drag] ${DISCLOSURE_FADE_MOTION_CLASS}`}
    >
      {bubbleAvailable ? (
        <IconButton
          type="button"
          data-testid="zen-collapse-to-bubble"
          size="icon-chip"
          className="rounded-full"
          label={bubbleLabel}
          tooltip={bubbleLabel}
          disabled={pending}
          onClick={collapseToBubble}
        >
          <MinusIcon className="size-3.5" />
        </IconButton>
      ) : null}
      <IconButton
        type="button"
        ref={drawerToggleRef}
        data-testid="zen-drawer-toggle"
        size="icon-chip"
        className="rounded-full"
        label={toggleLabel}
        tooltip={toggleLabel}
        aria-expanded={state.expanded}
        aria-controls="zen-conversation zen-details"
        disabled={pending}
        onClick={(event) => {
          setRequested(event.detail === 0 && event.currentTarget.matches(":focus-visible"));
          setExpanded(!state.expanded);
        }}
      >
        {state.expanded ? (
          <ChevronDownIcon className="size-3.5" />
        ) : (
          <ChevronUpIcon className="size-3.5" />
        )}
      </IconButton>
      <IconButton
        type="button"
        data-testid="zen-window-return"
        size="icon-chip"
        className="rounded-full"
        label={returnLabel}
        tooltip={returnLabel}
        disabled={pending}
        onClick={exit}
      >
        <Maximize2 className="size-3.5" />
      </IconButton>
    </div>
  );
}
