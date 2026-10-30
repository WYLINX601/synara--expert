import { mkdir } from "node:fs/promises";
import * as path from "node:path";
import { SkillPackageId } from "@synara/contracts";
import { Schema } from "effect";
import { expertResourceFiles } from "./ExpertStore";
import { writePrivateFileAtomically } from "./ExpertMcpStorage";
import { withSkillPackageLifecycle } from "./skillPackageLifecycle";

const Pins = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  packageIds: Schema.Array(SkillPackageId).check(Schema.isMaxLength(100_000)),
});
const pinsPath = (stateDir: string) =>
  path.join(stateDir, "experts", "skill-evolution-package-pins.json");
export async function readSkillEvolutionPackagePins(stateDir: string): Promise<readonly string[]> {
  try {
    return Schema.decodeUnknownSync(Pins)(
      JSON.parse((await expertResourceFiles.read(pinsPath(stateDir))).toString("utf8")),
    ).packageIds;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw cause;
  }
}
/** Caller must already hold the Skill package lifecycle lock. Pins fail closed on corruption. */
export async function retainSkillEvolutionPackagesUnlocked(
  stateDir: string,
  ids: readonly string[],
) {
  const existing = await readSkillEvolutionPackagePins(stateDir);
  const next = [...new Set([...existing, ...ids])].sort();
  const record = Schema.decodeUnknownSync(Pins)({ schemaVersion: 1, packageIds: next });
  if (next.length === existing.length) return;
  await mkdir(path.join(stateDir, "experts"), { recursive: true, mode: 0o700 });
  await writePrivateFileAtomically(pinsPath(stateDir), JSON.stringify(record) + "\n");
}
export const retainSkillEvolutionPackages = (stateDir: string, ids: readonly string[]) =>
  withSkillPackageLifecycle(stateDir, () => retainSkillEvolutionPackagesUnlocked(stateDir, ids));
