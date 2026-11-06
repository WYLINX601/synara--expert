import { t } from "~/i18n";
import { AmbientContextSnapshot, type AmbientResourceReference } from "@synara/contracts";
import * as Schema from "effect/Schema";
import type { DeepMutable } from "effect/Types";
import { randomUUID } from "./utils";

export function cloneAmbientContext(
  value: AmbientContextSnapshot,
): DeepMutable<AmbientContextSnapshot>;
export function cloneAmbientContext(
  value: unknown,
): DeepMutable<AmbientContextSnapshot> | undefined;
export function cloneAmbientContext(
  value: unknown,
): DeepMutable<AmbientContextSnapshot> | undefined {
  return Schema.is(AmbientContextSnapshot)(value)
    ? (structuredClone(value) as DeepMutable<AmbientContextSnapshot>)
    : undefined;
}

/** Observation IDs and target keys belong to a source, never to the global pin list. */
export function ambientContextItemKey(item: AmbientContextSnapshot["items"][number]): string {
  const observation = item.observation;
  const value =
    observation.type === "selection.location"
      ? [
          observation.value.start.line,
          observation.value.start.column,
          observation.value.end.line,
          observation.value.end.column,
        ]
      : Object.entries(observation.value).toSorted(([left], [right]) => left.localeCompare(right));
  return JSON.stringify([
    observation.schemaVersion,
    observation.targetKey,
    observation.type,
    observation.method,
    observation.confidence,
    value,
    item.provenance
      .map((entry) => JSON.stringify([entry.sourceId, entry.method, entry.confidence]))
      .toSorted(),
    item.ambiguous,
  ]);
}

export function removeAmbientContextItem(
  snapshot: AmbientContextSnapshot,
  key: string,
): AmbientContextSnapshot | undefined {
  const items = snapshot.items.filter((item) => ambientContextItemKey(item) !== key);
  return items.length > 0 ? { ...snapshot, id: randomUUID(), items } : undefined;
}

/** Pins are frozen task input; a newer observation never silently replaces a pin. */
export function mergeAmbientContext(
  current: AmbientContextSnapshot | undefined,
  captured: AmbientContextSnapshot,
): AmbientContextSnapshot {
  const keys = new Set<string>();
  const items = [...(current?.items ?? []), ...captured.items].filter((item) => {
    const key = ambientContextItemKey(item);
    if (keys.has(key)) return false;
    keys.add(key);
    return true;
  });
  const next = {
    schemaVersion: 1 as const,
    id: randomUUID(),
    capturedAt: captured.capturedAt,
    items,
  };
  if (!Schema.is(AmbientContextSnapshot)(next)) {
    throw new Error("Context is too large. Remove a pinned item before attaching more.");
  }
  return structuredClone(next);
}

export function ambientResourceSnapshot(
  resource: AmbientResourceReference,
): AmbientContextSnapshot {
  const capturedAt = new Date().toISOString();
  const id = randomUUID();
  return {
    schemaVersion: 1,
    id: randomUUID(),
    capturedAt,
    items: [
      {
        observation: {
          schemaVersion: 1,
          id,
          targetKey: resource.targetKey,
          capturedAt,
          method: "resource-search",
          confidence: "exact",
          type: "resource.identity",
          value: { uri: resource.uri, title: resource.title, kind: "file" },
        },
        provenance: [
          {
            sourceId: resource.sourceId,
            observationId: id,
            capturedAt,
            method: "resource-search",
            confidence: "exact",
          },
        ],
        ambiguous: false,
      },
    ],
  };
}

export function ambientContextItemLabel(item: AmbientContextSnapshot["items"][number]): string {
  const observation = item.observation;
  switch (observation.type) {
    case "application.identity":
      return observation.value.name;
    case "window.identity":
      return observation.value.title;
    case "resource.identity":
      return observation.value.title || observation.value.uri;
    case "selection.text":
      return `Selection: ${observation.value.text.slice(0, 80)}`;
    case "selection.location":
      return `Lines ${observation.value.start.line + 1}–${observation.value.end.line + 1}`;
    case "resource.content":
      return "Document content";
    case "element.identity":
      return observation.value.name;
  }
}

/** Compact pins share a source/resource group while preserving distinct selections. */
export function groupAmbientContextItems(items: AmbientContextSnapshot["items"]) {
  const groups = new Map<
    string,
    { key: string; label: string; items: AmbientContextSnapshot["items"][number][] }
  >();
  for (const item of items) {
    const sources = [...new Set(item.provenance.map((entry) => entry.sourceId))].sort();
    const key = JSON.stringify([sources, item.observation.targetKey]);
    const group = groups.get(key) ?? { key, label: sources.join(", "), items: [] };
    group.items.push(item);
    groups.set(key, group);
  }
  return [...groups.values()].map((group) => {
    const resource = group.items.find((item) => item.observation.type === "resource.identity");
    const ranges = [
      ...new Set(
        group.items
          .filter((item) => item.observation.type === "selection.location")
          .map(ambientContextItemLabel),
      ),
    ];
    const hasText = group.items.some(
      (item) =>
        item.observation.type === "selection.text" || item.observation.type === "resource.content",
    );
    return {
      ...group,
      label: [
        resource ? ambientContextItemLabel(resource).split(/[\\/]/).at(-1) : group.label,
        ...ranges,
        !hasText ? t("chat:ambientReferenceOnly") : null,
      ]
        .filter(Boolean)
        .join(" · "),
    };
  });
}
