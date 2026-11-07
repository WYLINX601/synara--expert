import { useTranslation } from "~/i18n";
import { ChevronDownIcon, ChevronUpIcon, Maximize2 } from "~/lib/icons";
import { DISCLOSURE_FADE_MOTION_CLASS } from "~/lib/disclosureMotion";
import { IconButton } from "../ui/icon-button";
import { useZenMode } from "./ZenModeProvider";

/** Separate edge controls; neither occupies the composer's metadata row. */
export function ZenModeToolbar({ action }: { action: "drawer" | "return" }) {
  const { t } = useTranslation();
  const { state, pending, setExpanded, exit } = useZenMode();
  if (!state.isActive) return null;
  if (action === "return") {
    if (!state.expanded) return null;
    return (
      <IconButton
        type="button"
        data-testid="zen-drawer-return"
        data-zen-hit-surface=""
        className="pointer-events-auto absolute right-1 top-1 z-20 rounded-full [-webkit-app-region:no-drag]"
        label={t("chat:zenReturn")}
        title={t("chat:zenReturn")}
        disabled={pending}
        onClick={exit}
      >
        <Maximize2 className="size-4" />
      </IconButton>
    );
  }
  const toggleLabel = t(state.expanded ? "chat:zenCollapse" : "chat:zenExpand");
  return (
    <IconButton
      type="button"
      data-testid="zen-drawer-toggle"
      data-zen-hit-surface=""
      className="zen-drawer-toggle absolute -top-2 left-1/2 z-20 h-5 w-14 -translate-x-1/2 sm:h-5 sm:w-14 rounded-full [-webkit-app-region:no-drag]"
      label={toggleLabel}
      title={toggleLabel}
      aria-expanded={state.expanded}
      aria-controls="zen-conversation zen-details"
      disabled={pending}
      onClick={() => setExpanded(!state.expanded)}
    >
      <span className={`zen-drawer-toggle-mark ${DISCLOSURE_FADE_MOTION_CLASS}`}>
        {state.expanded ? (
          <ChevronDownIcon className="size-3.5" />
        ) : (
          <ChevronUpIcon className="size-3.5" />
        )}
      </span>
    </IconButton>
  );
}
