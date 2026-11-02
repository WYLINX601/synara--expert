import { SettingsSaveBar } from "./SettingsSaveBar";

export function ExpertSaveBar({
  evolution = false,
  disabled,
  pending,
  issueCount,
  issueSummary,
  dirty,
  onClose,
  onSave,
  onDiscard,
  onFocusIssue,
}: {
  evolution?: boolean;
  disabled: boolean;
  pending: boolean;
  issueCount: number;
  issueSummary?: string;
  dirty: boolean;
  onClose: () => void;
  onSave: () => void;
  onDiscard: () => void;
  onFocusIssue?: () => void;
}) {
  return (
    <SettingsSaveBar
      hideSaveWhenClean={evolution}
      saveLabel={evolution ? "保存专家设置" : "保存更改"}
      disabled={disabled}
      pending={pending}
      dirty={dirty}
      onClose={onClose}
      onSave={onSave}
      onDiscard={onDiscard}
      status={
        <>
          <p className="text-ui font-medium">有未保存的更改</p>
          {issueCount > 0 ? (
            <p className="text-ui-sm text-muted-foreground">还有 {issueCount} 项输入需要修正。</p>
          ) : null}
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
        </>
      }
    />
  );
}
