import { Button } from "../ui/button";

export function ExpertSaveBar({
  disabled,
  pending,
  issueCount,
  issueSummary,
  onSave,
  onDiscard,
  onFocusIssue,
}: {
  disabled: boolean;
  pending: boolean;
  issueCount: number;
  issueSummary?: string;
  onSave: () => void;
  onDiscard: () => void;
  onFocusIssue?: () => void;
}) {
  return (
    <div className="sticky bottom-0 z-10 -mx-1 mt-5 border-t border-border bg-background/92 px-1 py-3 backdrop-blur-xl">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-background-elevated-primary/80 px-3 py-2.5 shadow-lg/5 sm:px-4">
        <div className="min-w-0" role="status" aria-live="polite">
          <p className="text-ui font-medium">有未保存的更改</p>
          <p className="text-ui-sm text-muted-foreground">
            {issueCount > 0 ? `还有 ${issueCount} 项输入需要修正。` : "保存后将创建新的专家版本。"}
          </p>
          {issueSummary && onFocusIssue ? (
            <button
              type="button"
              className="mt-1 text-left text-ui-sm text-destructive underline decoration-dotted underline-offset-2 outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-border-focus)]"
              disabled={pending}
              onClick={onFocusIssue}
            >
              {issueSummary} · 定位问题
            </button>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button variant="ghost" size="sm" disabled={pending} onClick={onDiscard}>
            放弃
          </Button>
          <Button size="sm" disabled={disabled || pending} onClick={onSave}>
            {pending ? "保存中…" : "保存更改"}
          </Button>
        </div>
      </div>
    </div>
  );
}
