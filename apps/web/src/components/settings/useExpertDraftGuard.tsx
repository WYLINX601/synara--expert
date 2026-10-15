import { useBlocker } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";

export interface UseExpertDraftGuardOptions {
  isDirty: boolean;
  canSave?: boolean;
  saveDisabledReason?: string;
  onSave: () => Promise<boolean>;
  onDiscard: () => void | boolean | Promise<void | boolean>;
}

interface PendingLeave {
  promise: Promise<boolean>;
  resolve: (canLeave: boolean) => void;
}

export function useExpertDraftGuard({
  isDirty,
  canSave = true,
  saveDisabledReason,
  onSave,
  onDiscard,
}: UseExpertDraftGuardOptions): {
  confirmLeave: () => Promise<boolean>;
  dialog: ReactNode;
} {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const pendingLeaveRef = useRef<PendingLeave | null>(null);
  const savingRef = useRef(false);
  const approvedNavigationTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isDirtyRef = useRef(isDirty);
  const approvedNavigationRef = useRef(false);
  isDirtyRef.current = isDirty;
  const canSaveRef = useRef(canSave);
  canSaveRef.current = canSave;

  useEffect(() => {
    if (isDirty) approvedNavigationRef.current = false;
  }, [isDirty]);

  const settleLeave = useCallback((canLeave: boolean) => {
    const pending = pendingLeaveRef.current;
    if (!pending) return;
    pendingLeaveRef.current = null;
    if (canLeave) {
      approvedNavigationRef.current = true;
      if (approvedNavigationTimerRef.current !== null) {
        clearTimeout(approvedNavigationTimerRef.current);
      }
      // A direct caller may make an in-panel transition without navigating. Keep
      // the bypass only through the immediate navigation that follows approval.
      approvedNavigationTimerRef.current = setTimeout(() => {
        approvedNavigationRef.current = false;
        approvedNavigationTimerRef.current = null;
      }, 0);
    }
    setDialogOpen(false);
    setSaveFailed(false);
    pending.resolve(canLeave);
  }, []);

  const confirmLeave = useCallback((): Promise<boolean> => {
    if (!isDirtyRef.current) return Promise.resolve(true);
    if (pendingLeaveRef.current) return pendingLeaveRef.current.promise;

    let resolve!: (canLeave: boolean) => void;
    const promise = new Promise<boolean>((complete) => {
      resolve = complete;
    });
    pendingLeaveRef.current = { promise, resolve };
    setSaveFailed(false);
    setDialogOpen(true);
    return promise;
  }, []);

  useBlocker({
    shouldBlockFn: async () => {
      if (approvedNavigationRef.current) {
        approvedNavigationRef.current = false;
        if (approvedNavigationTimerRef.current !== null) {
          clearTimeout(approvedNavigationTimerRef.current);
          approvedNavigationTimerRef.current = null;
        }
        return false;
      }
      if (!isDirtyRef.current) return false;
      return !(await confirmLeave());
    },
    enableBeforeUnload: () => isDirtyRef.current,
  });

  useEffect(
    () => () => {
      pendingLeaveRef.current?.resolve(false);
      pendingLeaveRef.current = null;
      if (approvedNavigationTimerRef.current !== null) {
        clearTimeout(approvedNavigationTimerRef.current);
      }
    },
    [],
  );

  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (!open && !savingRef.current) settleLeave(false);
    },
    [settleLeave],
  );

  const handleSave = useCallback(async () => {
    if (savingRef.current || !canSaveRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setSaveFailed(false);
    try {
      const saved = await onSave();
      if (saved) settleLeave(true);
      else setSaveFailed(true);
    } catch {
      setSaveFailed(true);
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }, [onSave, settleLeave]);

  const handleDiscard = useCallback(async () => {
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setSaveFailed(false);
    try {
      const discarded = await onDiscard();
      if (discarded === false) setSaveFailed(true);
      else settleLeave(true);
    } catch {
      setSaveFailed(true);
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }, [onDiscard, settleLeave]);

  const handleCancel = useCallback(() => {
    if (!savingRef.current) settleLeave(false);
  }, [settleLeave]);

  const dialog = (
    <Dialog open={dialogOpen} onOpenChange={handleOpenChange}>
      <DialogPopup showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>未保存的更改</DialogTitle>
          <DialogDescription>离开前要保存还是放弃这些更改？</DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-2">
          {!canSave && saveDisabledReason ? (
            <p className="text-ui-sm text-destructive" role="alert">
              {saveDisabledReason}
            </p>
          ) : null}
          {saveFailed ? (
            <p className="text-ui-sm text-destructive" role="alert">
              保存没有完成，当前更改仍保留。修复错误后重试，或选择放弃更改。
            </p>
          ) : null}
        </DialogPanel>
        <DialogFooter>
          <Button variant="ghost" disabled={saving} onClick={handleCancel}>
            取消
          </Button>
          <Button variant="outline" disabled={saving} onClick={() => void handleDiscard()}>
            放弃更改
          </Button>
          <Button disabled={saving || !canSave} onClick={() => void handleSave()}>
            {saving ? "保存中…" : "保存并继续"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );

  return { confirmLeave, dialog };
}
