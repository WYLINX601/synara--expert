import type { ReactNode } from "react";
import { Button } from "./button";
import { cn } from "~/lib/utils";

/** Underlined detail navigation; the caller owns panels and preserves their draft state. */
export function DetailTabs<T extends string>({
  id,
  label,
  tabs,
  value,
  onChange,
  disabled = false,
  className,
}: {
  id: string;
  label: string;
  tabs: ReadonlyArray<{ value: T; label: ReactNode; trailing?: ReactNode }>;
  value: T;
  onChange: (value: T) => void;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <div
      role="tablist"
      aria-label={label}
      className={cn("flex min-w-0 shrink-0 gap-6 border-b border-border", className)}
      onKeyDown={(event) => {
        if (disabled || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        const index = tabs.findIndex((tab) => tab.value === value);
        const next =
          tabs[
            event.key === "Home"
              ? 0
              : event.key === "End"
                ? tabs.length - 1
                : (index + (event.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length
          ];
        if (!next) return;
        onChange(next.value);
        document.getElementById(`${id}-${next.value}-tab`)?.focus();
      }}
    >
      {tabs.map((tab) => (
        <Button
          key={tab.value}
          id={`${id}-${tab.value}-tab`}
          role="tab"
          disabled={disabled}
          aria-selected={value === tab.value}
          aria-controls={`${id}-${tab.value}-panel`}
          tabIndex={value === tab.value ? 0 : -1}
          size="sm"
          variant="ghost"
          className="h-auto gap-2 rounded-none px-0 py-0 text-foreground/75 hover:bg-transparent aria-selected:text-foreground sm:h-auto"
          onClick={() => onChange(tab.value)}
        >
          <span
            className={cn(
              "border-b-2 py-3",
              value === tab.value ? "border-foreground" : "border-transparent",
            )}
          >
            {tab.label}
          </span>
          {tab.trailing}
        </Button>
      ))}
    </div>
  );
}
