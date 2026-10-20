import * as fs from "node:fs/promises";
import * as path from "node:path";

import { ExpertDefinition, SkillPackageId } from "@synara/contracts";
import { Schema } from "effect";

import { expertResourceFiles, readVerifiedStoredExpertSnapshot } from "./ExpertStore.ts";

const EXPERT_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/u;

async function directoryEntries(directory: string) {
  try {
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error(`Unsafe reference directory: ${directory}`);
    return await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

/** Conservative scan: every retained snapshot protects its package, including
 * accepted Hub work. Unknown/corrupt records fail closed, never imply no owners.
 * Caller must hold the shared package lifecycle lock through removal.
 */
export async function scanSkillPackageReferences(
  stateDir: string,
  packageId: string,
): Promise<string[]> {
  Schema.decodeUnknownSync(SkillPackageId)(packageId);
  const references: string[] = [];
  const root = path.join(stateDir, "experts");
  await directoryEntries(root);
  const inspectDefinition = async (file: string, id: string, revision?: number) => {
    const definition = Schema.decodeUnknownSync(ExpertDefinition)(
      JSON.parse((await expertResourceFiles.read(file)).toString("utf8")) as unknown,
    );
    if (definition.id !== id || (revision !== undefined && definition.revision !== revision))
      throw new Error(`Expert reference identity mismatch: ${file}`);
    if (definition.skillSelections?.some((entry) => entry.packageId === packageId))
      references.push(
        `Expert ${definition.name} (${definition.id}), revision ${definition.revision}`,
      );
  };
  for (const entry of await directoryEntries(path.join(root, "definitions"))) {
    const id = entry.name.replace(/\.json$/u, "");
    if (!entry.isFile() || !entry.name.endsWith(".json") || !EXPERT_ID.test(id))
      throw new Error(`Unknown expert reference record: ${entry.name}`);
    await inspectDefinition(path.join(root, "definitions", entry.name), id);
  }
  for (const expert of await directoryEntries(path.join(root, "revisions"))) {
    if (!expert.isDirectory() || !EXPERT_ID.test(expert.name))
      throw new Error(`Unknown expert revision directory: ${expert.name}`);
    for (const entry of await directoryEntries(path.join(root, "revisions", expert.name))) {
      if (!entry.isFile() || !/^[1-9]\d*\.json$/u.test(entry.name))
        throw new Error(`Unknown expert revision record: ${entry.name}`);
      await inspectDefinition(
        path.join(root, "revisions", expert.name, entry.name),
        expert.name,
        Number(entry.name.slice(0, -5)),
      );
    }
  }
  for (const entry of await directoryEntries(path.join(root, "snapshots"))) {
    // A staging directory may hold a future reference after an interrupted write.
    // Keep it recoverable and refuse deletion until its ownership is resolved.
    if (!entry.isDirectory() || !/^exp_[a-f0-9]{64}$/u.test(entry.name))
      throw new Error(`Unresolved expert snapshot record: ${entry.name}`);
    const snapshot = await readVerifiedStoredExpertSnapshot(
      path.join(root, "snapshots", entry.name),
      entry.name,
    );
    if (snapshot.skillSelections?.some((entry) => entry.packageId === packageId))
      references.push(`Snapshot ${snapshot.snapshotId}`);
  }
  return [...new Set(references)];
}

export async function assertSkillPackageUnreferenced(stateDir: string, packageId: string) {
  const references = await scanSkillPackageReferences(stateDir, packageId);
  if (references.length > 0)
    throw new Error(`Skill package is referenced by:\n${references.join("\n")}`);
}
