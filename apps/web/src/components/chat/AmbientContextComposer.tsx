import { useTranslation } from "~/i18n";
import type { ThreadId } from "@synara/contracts";
import { useState } from "react";
import { useComposerDraftStore, useComposerThreadDraft } from "~/composerDraftStore";
import {
  EMPTY_AMBIENT_BINDINGS,
  useAmbientContextBindingStore,
} from "~/ambientContextBindingStore";
import { useAmbientContext } from "~/hooks/useAmbientContext";
import {
  ambientContextItemKey,
  groupAmbientContextItems,
  mergeAmbientContext,
} from "~/lib/ambientContext";
import {
  ambientConnectionPresentation,
  ambientBindingAvailable,
  captureBoundAmbientContext,
  selectBoundAmbientItems,
} from "~/lib/ambientContextBinding";
import { AmbientContextItemDetails } from "./AmbientContextSummaryChip";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { FileIcon } from "~/lib/icons";
import { AttachmentSummaryChip } from "./AttachmentSummaryChip";

export function AmbientContextComposer({ threadId }: { threadId: ThreadId }) {
  const { t } = useTranslation();
  const { bridge, data, error } = useAmbientContext();
  const draft = useComposerThreadDraft(threadId);
  const bindings = useAmbientContextBindingStore(
    (state) => state.byThreadId[threadId] ?? EMPTY_AMBIENT_BINDINGS,
  );
  const connectionPeers = [
    ...(data?.connections ?? []),
    ...(data?.pendingConnections ?? []),
    ...bindings,
  ];
  const presentBinding = (binding: { id: string; label: string }) =>
    ambientConnectionPresentation(
      data?.connections?.find((connection) => connection.id === binding.id) ?? binding,
      connectionPeers,
    );
  const limit = useAmbientContextBindingStore((state) => state.maxBindings);
  const [pending, setPending] = useState<string | null>(null);
  const [captureError, setCaptureError] = useState<string | null>(null);
  if (!bindings.length && !draft.ambientContext && !draft.ambientContextFrozen) return null;
  const fullTextAllowed =
    data?.sources.some(
      (source) =>
        source.manifest.id === "obsidian" &&
        source.policy.enabled &&
        source.policy.allowedTypes.includes("resource.content"),
    ) ?? false;
  const groups = groupAmbientContextItems(draft.ambientContext?.items ?? []).map((group) => {
    const sourceId = group.items[0]?.provenance[0]?.sourceId;
    const resource = group.items.find((item) => item.observation.type === "resource.identity");
    let vault: string | null = null;
    if (resource?.observation.type === "resource.identity") {
      try {
        vault = new URL(resource.observation.value.uri).searchParams.get("vault");
      } catch {
        /* Non-URL resource labels remain readable. */
      }
    }
    const connection =
      data?.connections?.find((entry) => entry.sourceId === sourceId) ??
      bindings.find((binding) => binding.sourceId === sourceId);
    const sourceLabel = connection
      ? presentBinding(connection).label
      : (vault ?? t("chat:ambientApplication"));
    return { ...group, sourceLabel };
  });
  return (
    <div
      className="flex flex-col gap-2 px-3 py-2 text-ui-sm"
      aria-label={t("chat:ambientContextTitle")}
    >
      {bindings.length > limit && !draft.ambientContextFrozen ? (
        <p role="status" className="text-ui-xs text-destructive">
          {t("chat:ambientBindingLimitExceeded", { bound: bindings.length, limit })}
        </p>
      ) : null}
      {draft.ambientContextFrozen ? (
        <div className="flex items-center justify-between gap-2 text-ui-xs text-muted-foreground">
          <span>{t("chat:ambientFrozenContext")}</span>
          <Button
            type="button"
            size="xs"
            variant="ghost"
            onClick={() => {
              const store = useComposerDraftStore.getState();
              store.setAmbientContext(threadId, undefined, { frozen: false });
            }}
          >
            {t("chat:ambientUseCurrentContext")}
          </Button>
        </div>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {bindings.map((binding) => {
          const presentation = presentBinding(binding);
          const available = Boolean(bridge && !error && ambientBindingAvailable(data, binding));
          const items = available ? selectBoundAmbientItems(data?.items ?? [], [binding]) : [];
          const liveGroups = groupAmbientContextItems(items);
          const unavailable = !available || !items.length;
          return (
            <Collapsible
              key={binding.id}
              className="min-w-0 max-w-full rounded-lg border border-border/60 px-2 py-1"
            >
              <div className="flex items-center gap-1">
                <CollapsibleTrigger
                  className="min-w-0 truncate text-ui-sm"
                  aria-label={t("chat:ambientViewContext", { label: presentation.label })}
                  title={presentation.title}
                >
                  {presentation.label} ·{" "}
                  {unavailable
                    ? t("chat:ambientUnavailableOmitted")
                    : liveGroups.map((group) => group.label).join("、")}
                </CollapsibleTrigger>
                <Button
                  type="button"
                  size="icon-xs"
                  variant="ghost"
                  aria-label={t("chat:ambientUnbind", { label: presentation.label })}
                  title={presentation.title}
                  onClick={() =>
                    useAmbientContextBindingStore.getState().unbind(threadId, binding.id)
                  }
                >
                  ×
                </Button>
              </div>
              <CollapsiblePanel>
                <div className="space-y-2 pt-2">
                  <p className="text-ui-xs text-muted-foreground">
                    {t("chat:ambientFollowSelection")}
                  </p>
                  {items.map((item) => (
                    <AmbientContextItemDetails key={ambientContextItemKey(item)} item={item} />
                  ))}
                  <div className="flex flex-wrap items-center justify-end gap-3">
                    <label className="flex items-center gap-1.5 text-ui-xs">
                      <Checkbox
                        checked={binding.includeFullText}
                        disabled={!fullTextAllowed}
                        onCheckedChange={(value) =>
                          useAmbientContextBindingStore
                            .getState()
                            .setFullText(threadId, binding.id, value === true)
                        }
                      />
                      {fullTextAllowed
                        ? t("chat:ambientIncludeFullText")
                        : t("chat:ambientEnableFullTextFirst")}
                    </label>
                    <Button
                      type="button"
                      size="xs"
                      variant="ghost"
                      disabled={unavailable || pending !== null || bindings.length > limit}
                      onClick={async () => {
                        const bindingState = useAmbientContextBindingStore.getState();
                        if (
                          (bindingState.byThreadId[threadId]?.length ?? 0) >
                          bindingState.maxBindings
                        ) {
                          setCaptureError(
                            t("chat:ambientAdjustBindings", { limit: bindingState.maxBindings }),
                          );
                          return;
                        }
                        setPending(binding.id);
                        setCaptureError(null);
                        try {
                          const result = await captureBoundAmbientContext(
                            bridge,
                            [binding],
                            undefined,
                          );
                          if (!result.snapshot || result.unavailable.length)
                            throw new Error(t("chat:ambientPinUnavailable"));
                          const store = useComposerDraftStore.getState();
                          store.setAmbientContext(
                            threadId,
                            mergeAmbientContext(
                              store.draftsByThreadId[threadId]?.ambientContext,
                              result.snapshot,
                            ),
                          );
                        } catch (cause) {
                          setCaptureError(
                            cause instanceof Error ? cause.message : t("chat:ambientPinFailed"),
                          );
                        } finally {
                          setPending(null);
                        }
                      }}
                    >
                      {pending === binding.id
                        ? t("chat:ambientPinning")
                        : t("chat:ambientPinCurrent")}
                    </Button>
                  </div>
                </div>
              </CollapsiblePanel>
            </Collapsible>
          );
        })}
      </div>
      {groups.length ? (
        <div className="flex flex-wrap gap-1.5" aria-label={t("chat:ambientPinnedContext")}>
          {groups.map((group) => (
            <Collapsible key={group.key} className="min-w-0 max-w-full">
              <div className="flex items-center">
                <AttachmentSummaryChip
                  icon={FileIcon}
                  label={t("chat:ambientPinnedLabel", {
                    source: group.sourceLabel,
                    label: group.label,
                  })}
                  removeLabel={t("chat:ambientRemoveContext", { label: group.label })}
                  tooltip={<p>{group.label}</p>}
                  onRemove={() => {
                    const store = useComposerDraftStore.getState();
                    const current = store.draftsByThreadId[threadId]?.ambientContext;
                    if (!current) return;
                    const keys = new Set(group.items.map(ambientContextItemKey));
                    store.setAmbientContext(threadId, {
                      ...current,
                      items: current.items.filter((item) => !keys.has(ambientContextItemKey(item))),
                    });
                  }}
                />
                <CollapsibleTrigger
                  className="px-1 text-ui-xs text-muted-foreground"
                  aria-label={t("chat:ambientExpandPinned", { label: group.label })}
                >
                  {t("chat:ambientDetails")}
                </CollapsibleTrigger>
              </div>
              <CollapsiblePanel>
                <div className="max-h-64 space-y-2 overflow-auto py-2">
                  {group.items.map((item) => (
                    <AmbientContextItemDetails key={ambientContextItemKey(item)} item={item} />
                  ))}
                </div>
              </CollapsiblePanel>
            </Collapsible>
          ))}
        </div>
      ) : null}
      {captureError ? (
        <p role="status" className="text-ui-xs text-destructive">
          {captureError}
        </p>
      ) : null}
    </div>
  );
}
