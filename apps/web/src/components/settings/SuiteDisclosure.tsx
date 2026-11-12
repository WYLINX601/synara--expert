import { useId, useState, type ReactNode } from "react";
import { DisclosureChevron } from "../ui/DisclosureChevron";
import { DisclosureRegion } from "../ui/DisclosureRegion";

export function SuiteDisclosure({
  label,
  children,
  defaultOpen = false,
}: {
  label: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const id = useId();
  return (
    <div>
      <button
        type="button"
        className="flex w-full items-center gap-2 rounded-md py-1 text-start focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((value) => !value)}
      >
        <DisclosureChevron open={open} className="size-4 shrink-0" />
        <span className="min-w-0 break-words">{label}</span>
      </button>
      <div id={id}>
        <DisclosureRegion open={open} contentClassName="space-y-2 pt-2">
          {children}
        </DisclosureRegion>
      </div>
    </div>
  );
}
