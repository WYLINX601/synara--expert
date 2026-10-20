import type { ExpertSkillSelection, SkillPackage } from "@synara/contracts";

export function expertSkillSelectionKey(selection: ExpertSkillSelection): string {
  return `${selection.packageId}\u0000${selection.entryPath}`;
}

export function toggleExpertSkillSelection(
  selections: ReadonlyArray<ExpertSkillSelection>,
  selection: ExpertSkillSelection,
  selected: boolean,
): ExpertSkillSelection[] {
  const key = expertSkillSelectionKey(selection);
  if (selected) {
    if (selections.some((item) => expertSkillSelectionKey(item) === key)) return [...selections];
    return [...selections, selection];
  }
  return selections.filter((item) => expertSkillSelectionKey(item) !== key);
}

export function setExpertSkillSelectionActivation(
  selections: ReadonlyArray<ExpertSkillSelection>,
  selection: ExpertSkillSelection,
  activation: ExpertSkillSelection["activation"],
): ExpertSkillSelection[] {
  const key = expertSkillSelectionKey(selection);
  return selections.map((item) => {
    if (expertSkillSelectionKey(item) === key) return { ...item, activation };
    if (activation === "startup" && item.activation === "startup") {
      return { ...item, activation: "on-demand" };
    }
    return item;
  });
}

export function switchExpertSkillEntryVersion(
  selections: ReadonlyArray<ExpertSkillSelection>,
  packages: ReadonlyArray<SkillPackage>,
  nextPackage: SkillPackage,
  entryPath: string,
): ExpertSkillSelection[] {
  const nextEntry = nextPackage.entries.find((entry) => entry.entryPath === entryPath);
  if (!nextEntry) return [...selections];
  const nextName = nextEntry.name.normalize("NFC").toLowerCase();
  const packagesById = new Map(packages.map((item) => [item.packageId, item]));
  const selectedIndex = selections.findIndex((selection) => {
    if (selection.packageId === nextPackage.packageId) return false;
    const previousPackage = packagesById.get(selection.packageId);
    const previousEntry = previousPackage?.entries.find(
      (entry) => entry.entryPath === selection.entryPath,
    );
    return (
      previousPackage?.rootName === nextPackage.rootName &&
      previousEntry?.name.normalize("NFC").toLowerCase() === nextName
    );
  });
  if (selectedIndex < 0) return [...selections];
  return selections.map((selection, index) =>
    index === selectedIndex
      ? { ...selection, packageId: nextPackage.packageId, entryPath: nextEntry.entryPath }
      : selection,
  );
}
