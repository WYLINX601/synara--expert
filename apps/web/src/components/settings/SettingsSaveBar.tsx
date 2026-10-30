import type { ReactNode } from "react";
import { Button } from "../ui/button";
import { DialogFooter } from "../ui/dialog";

/** Shared editor footer; the owner controls draft state and protected dismissal. */
export function SettingsSaveBar({
  disabled,
  pending,
  status,
  dirty,
  onClose,
  saveLabel = "保存更改",
  hideSaveWhenClean = false,
  onSave,
  onDiscard,
}: {
  disabled: boolean;
  pending: boolean;
  status?: ReactNode;
  dirty: boolean;
  onClose: () => void;
  saveLabel?: string;
  hideSaveWhenClean?: boolean;
  onSave: () => void;
  onDiscard: () => void;
}) {
  return (
    <DialogFooter
      aria-label="保存更改"
      className="shrink-0 flex-row flex-wrap items-center justify-between gap-3 border-t border-border px-6"
    >
      <div className="min-w-0 flex-1" role="status" aria-live="polite">
        {dirty ? (status ?? <p className="text-ui font-medium">有未保存的更改</p>) : null}
      </div>
      <div className="ml-auto flex shrink-0 items-center gap-2">
        {dirty ? (
          <Button variant="ghost" size="sm" disabled={pending} onClick={onDiscard}>
            放弃
          </Button>
        ) : null}
        <Button variant="outline" size="sm" disabled={pending} onClick={onClose}>
          关闭
        </Button>
        {!hideSaveWhenClean || dirty ? (
          <Button size="sm" disabled={disabled || pending || !dirty} onClick={onSave}>
            {pending ? "保存中…" : saveLabel}
          </Button>
        ) : null}
      </div>
    </DialogFooter>
  );
}
