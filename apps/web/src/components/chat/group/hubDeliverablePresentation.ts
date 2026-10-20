// FILE: hubDeliverablePresentation.ts
// Purpose: Shared stable grouping and ordering for Hub key deliverables in the
//          Library and the composer reference chooser.
// Layer: Chat UI logic (framework-free)

import type { HubDeliverableCollection } from "@synara/contracts";

import type { LibraryKeyDeliverable, LibraryPublishedFile } from "./libraryPanel.logic";

export interface HubDeliverableWorkGroup {
  /** Worker identity keeps separate accepted work items separate. */
  readonly key: string;
  readonly title: string;
  readonly items: readonly LibraryKeyDeliverable[];
}

export interface HubDeliverableExpertGroup {
  /** Immutable accepted Expert binding identity, with a legacy fallback. */
  readonly key: string;
  readonly name: string;
  readonly works: readonly HubDeliverableWorkGroup[];
}

interface MutableWorkGroup {
  key: string;
  title: string;
  items: LibraryKeyDeliverable[];
}

interface MutableExpertGroup {
  key: string;
  name: string;
  works: Map<string, MutableWorkGroup>;
}

function expertIdentity(collection: HubDeliverableCollection): string {
  const binding = collection.expertBinding;
  if (binding) {
    return `binding:${JSON.stringify([binding.expertId, binding.revision, binding.displayName])}`;
  }
  const snapshotId = collection.provenance?.expertBindingSnapshotId;
  if (snapshotId) return `snapshot:${snapshotId}`;
  // Older publications may lack provenance. Keep each one distinct instead
  // of merging unrelated or unknown Expert identities.
  return `legacy-worker:${collection.workerThreadId}`;
}

/**
 * Build deterministic Expert → source work → file groups from current Hub
 * collections. Missing files remain represented so callers can mark them or
 * disable them; withdrawn collections are not current selections.
 *
 * Items deliberately retain their full selection metadata for exact-version
 * reads, while presentation callers choose which fields to display.
 */
export function buildHubDeliverableGroups(
  collections: readonly HubDeliverableCollection[],
): HubDeliverableExpertGroup[] {
  const experts = new Map<string, MutableExpertGroup>();

  for (const collection of collections) {
    if (collection.state !== "active" || collection.files.length === 0) continue;
    const expertKey = expertIdentity(collection);
    let expert = experts.get(expertKey);
    if (!expert) {
      expert = {
        key: expertKey,
        name: collection.expertBinding?.displayName ?? "Expert",
        works: new Map(),
      };
      experts.set(expertKey, expert);
    }

    const workKey = collection.workerThreadId;
    let work = expert.works.get(workKey);
    if (!work) {
      work = {
        key: workKey,
        title: collection.sourceWorkTitle ?? "Untitled work item",
        items: [],
      };
      expert.works.set(workKey, work);
    }

    for (const rawFile of collection.files) {
      const file = rawFile as LibraryPublishedFile;
      work.items.push({
        collection,
        file,
        libraryPath: file.currentLibraryPath ?? file.libraryPath,
      });
    }
  }

  return Array.from(experts.values())
    .toSorted((a, b) => a.name.localeCompare(b.name) || a.key.localeCompare(b.key))
    .map((expert) => ({
      key: expert.key,
      name: expert.name,
      works: Array.from(expert.works.values())
        .toSorted((a, b) => a.title.localeCompare(b.title) || a.key.localeCompare(b.key))
        .map((work) => ({
          key: work.key,
          title: work.title,
          items: work.items.toSorted(
            (a, b) =>
              a.file.name.localeCompare(b.file.name) || a.file.path.localeCompare(b.file.path),
          ),
        })),
    }));
}
