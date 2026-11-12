import { useRef, type ReactNode, type Ref } from "react";
import { showContextMenuFallback } from "~/contextMenuFallback";
import { cn } from "~/lib/utils";
import { SynaraLogo } from "../SynaraLogo";
import { Button } from "../ui/button";

/** Shared by the real native surface and the isolated review shell. */
export function ZenModeBubble({
  label,
  hideLabel,
  disabled = false,
  onRestore,
  onHide,
  buttonRef,
  className,
  onError,
  children,
}: {
  label: string;
  hideLabel: string;
  disabled?: boolean;
  onRestore: () => void;
  onHide: () => void;
  buttonRef?: Ref<HTMLButtonElement>;
  className?: string;
  children?: ReactNode;
  onError: (error: unknown) => void;
}) {
  const ref = useRef<HTMLButtonElement | null>(null);
  const menuPending = useRef(false);
  const openMenu = async (position: { x: number; y: number }) => {
    if (disabled || menuPending.current) return;
    menuPending.current = true;
    try {
      const showMenu = window.desktopBridge?.showContextMenu ?? showContextMenuFallback;
      const action = await showMenu([{ id: "hide", label: hideLabel }], position);
      if (action === "hide") onHide();
    } catch (error) {
      onError(error);
    } finally {
      menuPending.current = false;
      ref.current?.focus({ preventScroll: true });
    }
  };
  return (
    <Button
      ref={(element) => {
        ref.current = element;
        if (typeof buttonRef === "function") buttonRef(element);
        else if (buttonRef) buttonRef.current = element;
      }}
      type="button"
      data-testid="zen-mode-bubble"
      data-zen-hit-surface=""
      className={cn("zen-mode-bubble [-webkit-app-region:no-drag]", className)}
      variant="secondary-outline"
      size="icon-lg"
      disabled={disabled}
      aria-label={label}
      title={label}
      aria-expanded={false}
      onClick={onRestore}
      onContextMenu={(event) => {
        event.preventDefault();
        void openMenu({ x: event.clientX, y: event.clientY });
      }}
      onKeyDown={(event) => {
        if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
        event.preventDefault();
        const rect = event.currentTarget.getBoundingClientRect();
        void openMenu({ x: rect.right, y: rect.top });
      }}
    >
      <SynaraLogo className="size-5" />
      {children}
    </Button>
  );
}
