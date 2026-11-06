import { t } from "~/i18n";
import {
  AMBIENT_CONTEXT_FRESHNESS_MS,
  AMBIENT_CONTEXT_SNAPSHOT_LIMIT_ERROR,
} from "@synara/contracts";
import type {
  AmbientContextDesktopMethods,
  AmbientContextDesktopState,
  AmbientContextSnapshot,
} from "@synara/contracts";
import {
  useAmbientContextBindingStore,
  type AmbientContextBinding,
} from "~/ambientContextBindingStore";
import { cloneAmbientContext, mergeAmbientContext } from "./ambientContext";

export function ambientBindingAvailable(
  state: AmbientContextDesktopState | undefined,
  binding: AmbientContextBinding,
): boolean {
  const connection = state?.connections?.find(
    (entry) => entry.id === binding.id && entry.sourceId === binding.sourceId,
  );
  return Boolean(
    connection?.connected &&
    !connection.error &&
    state?.items.some(
      (item) =>
        item.provenance.some((entry) => entry.sourceId === binding.sourceId) &&
        Date.now() - Date.parse(item.observation.capturedAt) <= AMBIENT_CONTEXT_FRESHNESS_MS,
    ) &&
    state?.sources.some((source) => source.manifest.id === "obsidian" && source.policy.enabled),
  );
}

export function selectBoundAmbientItems(
  items: AmbientContextSnapshot["items"],
  bindings: readonly AmbientContextBinding[],
): AmbientContextSnapshot["items"] {
  return items.filter((item) => {
    const binding = bindings.find((entry) =>
      item.provenance.some((source) => source.sourceId === entry.sourceId),
    );
    if (!binding) return false;
    if (item.observation.type !== "resource.content") return true;
    return binding.includeFullText;
  });
}

export function assertAmbientBindingLimit(bindings: readonly AmbientContextBinding[]): void {
  const limit = useAmbientContextBindingStore.getState().maxBindings;
  if (bindings.length > limit)
    throw new Error(t("chat:ambientBindingLimitExceeded", { bound: bindings.length, limit }));
}

/** One capture freezes all valid bindings. Live state is never written into the draft. */
export async function captureBoundAmbientContext(
  bridge: AmbientContextDesktopMethods | undefined,
  bindings: readonly AmbientContextBinding[],
  pins: AmbientContextSnapshot | undefined,
): Promise<{ snapshot: AmbientContextSnapshot | undefined; unavailable: string[] }> {
  assertAmbientBindingLimit(bindings);
  if (bindings.length === 0) return { snapshot: cloneAmbientContext(pins), unavailable: [] };
  if (!bridge)
    return {
      snapshot: cloneAmbientContext(pins),
      unavailable: bindings.map((entry) => entry.label),
    };
  let state: AmbientContextDesktopState;
  try {
    state = await bridge.getState();
  } catch {
    return {
      snapshot: cloneAmbientContext(pins),
      unavailable: bindings.map((entry) => entry.label),
    };
  }
  let available = bindings.filter((entry) => ambientBindingAvailable(state, entry));
  let captured: AmbientContextSnapshot | undefined;
  // A connection can expire between the state read and the atomic capture. Refresh
  // eligibility once; never replace the missing vault with its cached preview.
  for (let attempt = 0; attempt < 2 && available.length; attempt += 1) {
    assertAmbientBindingLimit(bindings);
    try {
      captured = await bridge.capture(
        available.map((entry) => entry.sourceId),
        {
          includeFullTextSourceIds: available
            .filter(
              (entry) =>
                entry.includeFullText &&
                state.sources.some(
                  (source) =>
                    source.manifest.id === "obsidian" &&
                    source.policy.enabled &&
                    source.policy.allowedTypes.includes("resource.content"),
                ),
            )
            .map((entry) => entry.sourceId),
        },
      );
      const after = await bridge.getState();
      available = available.filter((entry) => ambientBindingAvailable(after, entry));
      break;
    } catch (cause) {
      if (
        cause instanceof Error &&
        (cause.message.includes(AMBIENT_CONTEXT_SNAPSHOT_LIMIT_ERROR) ||
          cause.message.includes("Context exceeds the snapshot size or schema limits."))
      )
        throw new Error(t("chat:ambientSnapshotTooLarge"), { cause });
      captured = undefined;
      if (attempt === 1) break;
      try {
        state = await bridge.getState();
        available = available.filter((entry) => ambientBindingAvailable(state, entry));
      } catch {
        break;
      }
    }
  }
  assertAmbientBindingLimit(bindings);
  const items = captured ? selectBoundAmbientItems(captured.items, available) : [];
  const unavailable = bindings
    .filter(
      (binding) =>
        !items.some((item) => item.provenance.some((entry) => entry.sourceId === binding.sourceId)),
    )
    .map((binding) => binding.label);
  return {
    snapshot:
      captured && items.length
        ? mergeAmbientContext(pins, { ...captured, items })
        : cloneAmbientContext(pins),
    unavailable,
  };
}

/** Keep asynchronous failure handling outside compiled hot-path React hooks. */
export async function prepareBoundAmbientContext(
  ...args: Parameters<typeof captureBoundAmbientContext>
) {
  try {
    return { result: await captureBoundAmbientContext(...args), error: null };
  } catch (cause) {
    return {
      result: null,
      error: cause instanceof Error ? cause.message : t("chat:ambientPrepareFailed"),
    };
  }
}

/** Disambiguate equal vault labels across pending, connected and bound peers. */
export function ambientConnectionPresentation(
  connection: { readonly id: string; readonly label: string },
  peers: ReadonlyArray<{ readonly id: string; readonly label: string }>,
): { label: string; title: string } {
  const duplicates = peers.filter(
    (peer) => peer.label === connection.label && peer.id !== connection.id,
  );
  let label = connection.label;
  if (duplicates.length) {
    let length = 8;
    const maxLength = Math.max(connection.id.length, ...duplicates.map((peer) => peer.id.length));
    while (
      length < maxLength &&
      duplicates.some((peer) => peer.id.slice(-length) === connection.id.slice(-length))
    )
      length += 1;
    label = `${label} · ${connection.id.slice(-length)}`;
  }
  return { label, title: `${connection.label} · ${connection.id}` };
}
