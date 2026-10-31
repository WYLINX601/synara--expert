import type { ReactNode } from "react";
import { DisclosureChevron } from "~/components/ui/DisclosureChevron";
import { DisclosureRegion } from "~/components/ui/DisclosureRegion";
import { CircleAlertIcon, CircleCheckIcon, ClockIcon, LoaderCircleIcon } from "~/lib/icons";

/** A shared row for native Skill experience and typed learning receipts. */
export function EvolutionTimelineNode({
  id,
  visible,
  expanded,
  applied,
  muted = false,
  failed = false,
  active = false,
  pending = false,
  title,
  label,
  assetLabel,
  automatic,
  createdAt,
  hasNext,
  onToggle,
  children,
}: {
  id: string;
  visible: boolean;
  expanded: boolean;
  applied: boolean;
  muted?: boolean;
  failed?: boolean;
  active?: boolean;
  pending?: boolean;
  title: string;
  label: string;
  assetLabel?: string;
  automatic?: boolean;
  createdAt: string;
  hasNext: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  const StatusIcon = active
    ? LoaderCircleIcon
    : applied
      ? CircleCheckIcon
      : pending
        ? ClockIcon
        : CircleAlertIcon;
  const detailId = `experience-detail-${encodeURIComponent(id)}`;
  const summary = (
    <>
      <span className="min-w-0 flex-1 basis-full break-words text-ui font-medium sm:basis-auto">
        {title}
      </span>
      {assetLabel ? (
        <span className="rounded-md bg-muted px-2 py-1 text-ui-xs text-muted-foreground">
          {assetLabel}
        </span>
      ) : null}
      {!failed ? (
        <span
          className={`rounded-md px-2 py-1 text-ui-xs ${applied && !muted ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300" : "bg-muted text-muted-foreground"}`}
        >
          {label}
        </span>
      ) : null}
      {automatic ? <span className="text-ui-xs text-muted-foreground">自动学习</span> : null}
      <time
        dateTime={createdAt}
        className="flex items-center gap-1 text-ui-xs text-muted-foreground"
      >
        <ClockIcon aria-hidden="true" className="size-3.5" />
        {new Date(createdAt).toLocaleString(undefined, {
          month: "short",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
        })}
      </time>
      {!failed ? <DisclosureChevron open={expanded} /> : null}
    </>
  );
  return (
    <li hidden={!visible} className="relative min-w-0 pl-9" data-testid={`experience-node:${id}`}>
      {hasNext || expanded ? (
        <div aria-hidden="true" className="absolute bottom-0 left-3 top-7 border-l border-border" />
      ) : null}
      <StatusIcon
        aria-hidden="true"
        className={`absolute left-0.5 top-4 size-5 bg-background ${applied && !muted ? "text-emerald-700 dark:text-emerald-400" : "text-muted-foreground"} ${active ? "animate-spin motion-reduce:animate-none" : ""}`}
      />
      {failed ? (
        <div className="flex w-full min-w-0 flex-wrap items-center gap-x-3 gap-y-1 py-3 pr-2">
          {summary}
        </div>
      ) : (
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={detailId}
          className="flex w-full min-w-0 flex-wrap items-center gap-x-3 gap-y-1 rounded-lg py-3 pr-2 text-left outline-none hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring"
          onClick={onToggle}
        >
          {summary}
        </button>
      )}
      <div id={detailId}>
        <DisclosureRegion open={expanded}>{children}</DisclosureRegion>
      </div>
    </li>
  );
}
