import type { AmbientContextSnapshot } from "@synara/contracts";
import { ambientContextItemKey, ambientContextItemLabel } from "~/lib/ambientContext";
import { FileIcon } from "~/lib/icons";
import { AttachmentSummaryChip } from "./AttachmentSummaryChip";

export function AmbientContextItemDetails({
  item,
}: {
  item: AmbientContextSnapshot["items"][number];
}) {
  const observation = item.observation;
  return (
    <div className="space-y-1">
      <p className="text-ui-xs text-muted-foreground">
        {observation.type}
        {item.ambiguous ? " · Ambiguous" : ""}
      </p>
      <p className="max-h-48 overflow-auto text-ui-sm">
        {"text" in observation.value ? observation.value.text : ambientContextItemLabel(item)}
      </p>
      {observation.type === "resource.content" && observation.value.truncated ? (
        <p className="text-ui-xs text-muted-foreground">Content truncated</p>
      ) : null}
      {observation.type === "resource.identity" ? (
        <p className="break-all text-ui-xs text-muted-foreground">{observation.value.uri}</p>
      ) : null}
      {item.provenance.map((entry) => (
        <p key={JSON.stringify(entry)} className="text-ui-xs text-muted-foreground">
          {entry.sourceId} · {entry.capturedAt} · {entry.method} · {entry.confidence}
        </p>
      ))}
    </div>
  );
}

/** Reads only the sent snapshot; never subscribes to or recaptures ambient state. */
export function AmbientContextSummaryChip({ snapshot }: { snapshot: AmbientContextSnapshot }) {
  if (snapshot.items.length === 0) return null;
  return (
    <AttachmentSummaryChip
      icon={FileIcon}
      label={`Context · ${snapshot.items.length} ${snapshot.items.length === 1 ? "item" : "items"}`}
      removeLabel="Remove context"
      tooltip={
        <div className="max-h-80 space-y-3 overflow-auto" aria-label="Sent context snapshot">
          {snapshot.items.map((item) => (
            <AmbientContextItemDetails key={ambientContextItemKey(item)} item={item} />
          ))}
        </div>
      }
    />
  );
}
