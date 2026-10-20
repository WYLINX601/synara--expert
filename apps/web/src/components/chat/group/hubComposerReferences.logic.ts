import type { HubDeliverableCollection, HubExpertSummary, ProjectId } from "@synara/contracts";
import {
  buildHubDeliverableReferenceUri,
  buildHubExpertReferenceUri,
} from "@synara/shared/hubReferences";
import type { ComposerCommandItem } from "../ComposerCommandMenu";
import { buildHubDeliverableGroups } from "./hubDeliverablePresentation";

export function buildHubReferenceMenuItems(input: {
  experts: readonly HubExpertSummary[];
  deliverables: readonly HubDeliverableCollection[];
  query: string;
  hubId: ProjectId;
  isCoordinator: boolean;
}): ComposerCommandItem[] {
  const query = input.query.trim().toLocaleLowerCase();
  const matches = (...values: string[]) =>
    values.some((value) => value.toLocaleLowerCase().includes(query));
  const experts: ComposerCommandItem[] = input.isCoordinator
    ? input.experts
        .filter((expert) => matches(expert.displayName, expert.description, expert.useCases))
        .map((expert) => {
          const path = buildHubExpertReferenceUri(expert.expertId);
          return {
            id: path,
            type: "hub-expert",
            label: expert.displayName,
            description: expert.useCases || expert.description,
            mention: { name: expert.displayName, path },
            disabled: !expert.available,
          };
        })
    : [];
  const deliverables: Extract<ComposerCommandItem, { type: "hub-deliverable" }>[] =
    buildHubDeliverableGroups(
      input.deliverables.filter((collection) => collection.hubId === input.hubId),
    ).flatMap((expert) =>
      expert.works.flatMap((work) =>
        work.items
          .filter(({ collection, file }) =>
            matches(
              file.name,
              file.description ?? "",
              collection.expertBinding?.displayName ?? "未知专家",
              work.title,
            ),
          )
          .map(({ collection, file }) => {
            const path = buildHubDeliverableReferenceUri({
              hubId: collection.hubId,
              workerThreadId: collection.workerThreadId,
              path: file.path,
              revision: collection.revision,
            });
            return {
              id: path,
              type: "hub-deliverable" as const,
              label: file.name,
              description: "",
              mention: { name: file.name, path },
              expertDisplayName: collection.expertBinding?.displayName ?? "未知专家",
              disabled: file.libraryState === "missing",
            };
          }),
      ),
    );

  // Identical source entries should remain visible as separate references. Keep
  // the canonical URI on the mention itself; only disambiguate the menu key.
  const occurrenceByPath = new Map<string, number>();
  const uniqueDeliverables = deliverables.map((item) => {
    const occurrence = occurrenceByPath.get(item.mention.path) ?? 0;
    occurrenceByPath.set(item.mention.path, occurrence + 1);
    return occurrence === 0 ? item : { ...item, id: `${item.id}#${occurrence}` };
  });

  return [...experts, ...uniqueDeliverables];
}
