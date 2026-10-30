import { useId, type ReactNode } from "react";
import { Dialog, DialogPopup } from "../ui/dialog";

/** Shared editor surface; draft state and dismissal protection stay with the owner. */
export function SettingsEditorDialog({
  open,
  onClose,
  closeButtonLabel,
  children,
}: {
  open: boolean;
  onClose: () => void;
  closeButtonLabel: string;
  children: ReactNode;
}) {
  const popupId = useId();
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogPopup
        id={popupId}
        initialFocus={() =>
          document
            .getElementById(popupId)
            ?.querySelector<HTMLButtonElement>(`[aria-label="${closeButtonLabel}"]`) ?? true
        }
        closeButtonClassName="size-9 sm:size-9"
        closeButtonLabel={closeButtonLabel}
        className="h-[min(48rem,calc(100dvh-5rem))] max-h-[85dvh] w-[calc(100vw-3rem)] max-w-[57.5rem] rounded-xl max-sm:h-[calc(100dvh-3rem)] max-sm:w-full max-sm:max-h-[calc(100dvh-3rem)]"
      >
        {children}
      </DialogPopup>
    </Dialog>
  );
}
