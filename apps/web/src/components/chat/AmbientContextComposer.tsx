import type { ThreadId } from "@synara/contracts";
import { useState } from "react";
import { useComposerDraftStore, useComposerThreadDraft } from "~/composerDraftStore";
import { useAmbientContext } from "~/hooks/useAmbientContext";
import {
  ambientContextItemKey,
  ambientContextItemLabel,
  mergeAmbientContext,
  removeAmbientContextItem,
} from "~/lib/ambientContext";
import { AmbientContextItemDetails } from "./AmbientContextSummaryChip";
import { Button } from "../ui/button";
import { FileIcon } from "~/lib/icons";
import { AttachmentSummaryChip } from "./AttachmentSummaryChip";

export function AmbientContextComposer({ threadId }: { threadId: ThreadId }) {
  const { bridge, data, error } = useAmbientContext();
  const draft = useComposerThreadDraft(threadId);
  const [pending, setPending] = useState(false);
  const [captureError, setCaptureError] = useState<string | null>(null);
  const enabledSources = data?.sources.filter((source) => source.policy.enabled) ?? [];
  if (!bridge) return null;
  if (enabledSources.length === 0 && !draft.ambientContext) return null;
  async function attach() {
    if (!bridge) return;
    setPending(true);
    setCaptureError(null);
    try {
      const snapshot = await bridge.capture();
      const store = useComposerDraftStore.getState();
      store.setAmbientContext(
        threadId,
        mergeAmbientContext(store.draftsByThreadId[threadId]?.ambientContext, snapshot),
      );
    } catch {
      setCaptureError("Could not attach context. Check the source connection and try again.");
    } finally {
      setPending(false);
    }
  }
  const resource = data?.items.find((item) => item.observation.type === "resource.identity");
  const selection = data?.items.find((item) => item.observation.type === "selection.text");
  const activeItem = resource ?? selection ?? data?.items[0];
  return (
    <div className="flex flex-col gap-2 px-3 py-2 text-ui-sm" aria-label="Ambient context">
      {enabledSources.length > 0 ? (
        <div className="flex items-center gap-2 text-muted-foreground">
          <span
            className="min-w-0 flex-1 truncate"
            title={activeItem ? ambientContextItemLabel(activeItem) : undefined}
          >
            {activeItem
              ? ambientContextItemLabel(activeItem)
              : enabledSources.some((source) => source.connected)
                ? "No active context"
                : "Waiting for Obsidian"}
            {resource && selection ? " · Selection available" : ""}
          </span>
          <Button
            type="button"
            size="xs"
            variant="ghost"
            disabled={pending || !data?.items.length}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => void attach()}
          >
            {pending ? "Attaching…" : "Attach context"}
          </Button>
        </div>
      ) : null}
      {draft.ambientContext ? (
        <div className="flex flex-wrap gap-1.5" aria-label="Pinned context">
          {draft.ambientContext.items.map((item) => (
            <AttachmentSummaryChip
              key={ambientContextItemKey(item)}
              icon={FileIcon}
              label={ambientContextItemLabel(item)}
              removeLabel={`Remove context: ${ambientContextItemLabel(item)}`}
              tooltip={<AmbientContextItemDetails item={item} />}
              onRemove={() => {
                const store = useComposerDraftStore.getState();
                const current = store.draftsByThreadId[threadId]?.ambientContext;
                if (current)
                  store.setAmbientContext(
                    threadId,
                    removeAmbientContextItem(current, ambientContextItemKey(item)),
                  );
              }}
            />
          ))}
        </div>
      ) : null}
      {captureError || error ? (
        <p role="status" className="text-ui-xs text-destructive">
          {captureError ?? "Context source unavailable. You can continue chatting."}
        </p>
      ) : null}
    </div>
  );
}
