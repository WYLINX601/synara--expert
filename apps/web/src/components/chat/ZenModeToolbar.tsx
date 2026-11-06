import type { Ref } from "react";
import { useTranslation } from "~/i18n";
import { ArrowLeftIcon, ChevronDownIcon, ChevronUpIcon } from "~/lib/icons";
import { IconButton } from "../ui/icon-button";
import { useZenMode } from "./ZenModeProvider";
import { ComposerColumnFrame, ComposerStackedHeaderFrame } from "./ComposerColumnFrame";
import { CHAT_COLUMN_GUTTER_CLASS_NAME } from "./composerPickerStyles";

/** Small surrounding controls; the original composer is unchanged. */
export function ZenModeToolbar({ title, ref }: { title: string; ref?: Ref<HTMLDivElement> }) {
  const { t } = useTranslation();
  const { state, pending, setExpanded, exit } = useZenMode();
  if (!state.isActive) return null;
  const toggleLabel = t(state.expanded ? "chat:zenCollapse" : "chat:zenExpand");
  return (
    <div
      ref={ref}
      data-zen-toolbar-frame=""
      className={`${CHAT_COLUMN_GUTTER_CLASS_NAME} relative z-10 shrink-0 pt-2`}
    >
      <ComposerColumnFrame>
        <ComposerStackedHeaderFrame>
          <header
            data-testid="zen-mode-toolbar"
            className="drag-region flex h-9 min-w-0 items-center gap-1 rounded-t-xl border border-border/70 bg-background px-3 shadow-sm"
          >
            <div className="min-w-0 flex-1">
              <span className="block truncate text-ui-xs text-muted-foreground" title={title}>
                {title}
              </span>
            </div>
            <IconButton
              type="button"
              className="[-webkit-app-region:no-drag]"
              label={toggleLabel}
              title={toggleLabel}
              aria-expanded={state.expanded}
              aria-controls="zen-conversation"
              disabled={pending}
              onClick={() => setExpanded(!state.expanded)}
            >
              {state.expanded ? (
                <ChevronDownIcon className="size-3.5" />
              ) : (
                <ChevronUpIcon className="size-3.5" />
              )}
            </IconButton>
            <IconButton
              type="button"
              className="[-webkit-app-region:no-drag]"
              label={t("chat:zenReturn")}
              title={t("chat:zenReturn")}
              disabled={pending}
              onClick={exit}
            >
              <ArrowLeftIcon className="size-3.5" />
            </IconButton>
          </header>
        </ComposerStackedHeaderFrame>
      </ComposerColumnFrame>
    </div>
  );
}
