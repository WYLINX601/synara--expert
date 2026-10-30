import * as path from "node:path";

import { SkillEntryPath, SkillPackageId, type ResolvedExpertSkillEntry } from "@synara/contracts";
import { Schema } from "effect";

/**
 * Recheck persisted skill references against the immutable package ledger.
 * Caller-owned metadata is intentionally left untouched.
 */
export async function verifyPinnedSkillReferences(
  stateDir: string,
  entries: ReadonlyArray<ResolvedExpertSkillEntry>,
): Promise<void> {
  if (!path.isAbsolute(stateDir) || stateDir.includes("\0"))
    throw new Error("State directory must be an absolute local path.");

  const byPackage = new Map<string, ResolvedExpertSkillEntry[]>();
  for (const entry of entries) {
    if (!Schema.is(SkillPackageId)(entry.packageId))
      throw new Error("Pinned skill reference has an invalid package ID.");
    if (!Schema.is(SkillEntryPath)(entry.entryPath))
      throw new Error("Pinned skill reference has an invalid entry path.");
    const group = byPackage.get(entry.packageId) ?? [];
    group.push(entry);
    byPackage.set(entry.packageId, group);
  }

  // ExpertStore imports this helper. Defer the package-store import until the
  // function runs so package verification does not create an eager module cycle.
  const { verifySkillPackageContent } = await import("./SkillPackageStore.ts");
  const resolvedStateDir = path.resolve(stateDir);
  for (const [packageId, packageEntries] of byPackage) {
    const content = await verifySkillPackageContent(resolvedStateDir, packageId);
    const resources = new Map(content.resources.map((resource) => [resource.path, resource]));
    for (const entry of packageEntries) {
      const resourcePath = `content/${entry.entryPath}`;
      const resource = resources.get(resourcePath);
      if (!resource || resource.kind !== "file")
        throw new Error(`Pinned skill entry is missing from package ${packageId}.`);
      if (entry.sha256 !== undefined && entry.sha256 !== resource.sha256)
        throw new Error(`Pinned skill entry hash does not match package ${packageId}.`);

      const expectedPath = path.join(content.contentRoot, ...entry.entryPath.split("/"));
      if (!path.isAbsolute(entry.path) || entry.path !== expectedPath)
        throw new Error(`Pinned skill entry path does not match package ${packageId}.`);
    }
  }
}
