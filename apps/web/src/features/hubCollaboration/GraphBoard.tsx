import type { HubPlanSnapshot, ThreadId } from "@synara/contracts";

import { ComposerColumnFrame } from "~/components/chat/ComposerColumnFrame";
import { ComposerCapsulePopover, ComposerCapsuleRow } from "~/components/chat/ComposerCapsule";
import { DisclosureChevron } from "~/components/ui/DisclosureChevron";
import { ListChecksIcon } from "~/lib/icons";

import { HubPipelineStrip } from "./HubPipelineStrip";
import { hubGraphGlobalStatus } from "./hubGraph.logic";

export function GraphBoard(props: {
  readonly snapshot: HubPlanSnapshot;
  readonly connected: boolean;
  readonly error?: string | null | undefined;
  readonly onRefresh?: (() => void) | undefined;
  readonly onOpenThread?: ((threadId: ThreadId) => void) | undefined;
  readonly onOpenPlanActions?: (() => void) | undefined;
}) {
  return (
    <ComposerColumnFrame>
      <ComposerCapsuleRow>
        <ComposerCapsulePopover
          icon={<ListChecksIcon className="size-3.5" />}
          label={(open) => (
            <span className="inline-flex items-center gap-1.5">
              <span>协作流程</span>
              {!open ? (
                <span className="text-muted-foreground">
                  · {hubGraphGlobalStatus(props.snapshot)}
                </span>
              ) : null}
              <DisclosureChevron open={open} className="size-3" />
            </span>
          )}
          title="展开或收起协作流程"
          testId="hub-graph-capsule"
          popupTestId="hub-graph-panel"
          popupClassName="rounded-2xl shadow-none dark:shadow-none [&_[data-slot=popover-viewport]]:p-0"
          popupPositionerClassName="w-(--anchor-width)"
        >
          {(close) => (
            <HubPipelineStrip
              {...props}
              onOpenThread={
                props.onOpenThread
                  ? (id) => {
                      close();
                      props.onOpenThread?.(id);
                    }
                  : undefined
              }
              onOpenPlanActions={
                props.onOpenPlanActions
                  ? () => {
                      close();
                      props.onOpenPlanActions?.();
                    }
                  : undefined
              }
            />
          )}
        </ComposerCapsulePopover>
      </ComposerCapsuleRow>
    </ComposerColumnFrame>
  );
}
