import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ProviderExpertSession } from "@synara/contracts";
import { ensurePrivateDirectorySync, syncDirectoryEntry } from "../privatePathPermissions";
import { expertResourceFiles } from "../experts/ExpertStore";
import {
  verifyFixedExpertAssembly,
  recordVerifiedNativeSkillAssembly,
  invalidateNativeSkillAssemblyVerification,
} from "./expertSkillCatalog";

export interface FixedSkillProjection {
  readonly root: string;
  readonly pluginName: string;
  readonly entries: ReadonlyArray<{
    readonly name: string;
    readonly path: string;
    readonly originalName: string;
    readonly originalPath: string;
    readonly sha256: string;
  }>;
}
const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

/** Small discovery entries point at immutable originals. Supporting resources stay
 * at their original package-relative paths; unselected sibling entries are absent.
 */
export async function createFixedSkillProjection(
  base: string,
  session: ProviderExpertSession,
): Promise<FixedSkillProjection> {
  await verifyFixedExpertAssembly(session, session.skills);
  if (!/^exp_[a-f0-9]{64}$/u.test(session.snapshotId))
    throw new Error("Invalid fixed Skill snapshot identity.");
  ensurePrivateDirectorySync(base);
  const root = path.join(base, session.snapshotId),
    pluginName = `synara-fixed-${session.snapshotId.slice(4, 28)}`;
  const entries: FixedSkillProjection["entries"][number][] = [];
  const expected = new Map<string, string>();
  expected.set(
    ".claude-plugin/plugin.json",
    `${JSON.stringify({ name: pluginName, version: "1.0.0", description: "Fixed Expert Skill assembly" })}\n`,
  );
  for (const entry of session.skillEntries ?? []) {
    const name = `entry-${sha(`${entry.packageId}#${entry.entryPath}`).slice(0, 24)}`;
    const body = [
      "---",
      `name: ${name}`,
      `description: ${JSON.stringify(entry.description || entry.name)}`,
      ...(entry.disableModelInvocation ? ["disable-model-invocation: true"] : []),
      ...(entry.userInvocable === false ? ["user-invocable: false"] : []),
      "---",
      `Fixed Expert Skill ${JSON.stringify(entry.name)}.`,
      `Read and apply the complete original SKILL.md at ${JSON.stringify(entry.path)}. Its SHA-256 is ${entry.sha256}.`,
      `Resolve every relative file, script and resource from ${JSON.stringify(path.dirname(entry.path))}. The original package layout is preserved there.`,
      "This entry grants no tool permissions. Do not discover or substitute any other Skill version.",
      "",
    ].join("\n");
    const relative = `skills/${name}/SKILL.md`;
    expected.set(relative, body);
    entries.push({
      name,
      path: path.join(root, ...relative.split("/")),
      originalName: entry.name,
      originalPath: entry.path,
      sha256: sha(body),
    });
  }
  const existing = await fs.lstat(root).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  });
  if (existing && (!existing.isDirectory() || existing.isSymbolicLink()))
    throw new Error("Unsafe fixed Skill projection.");
  if (!existing) {
    const stage = path.join(base, `.staging-${randomUUID()}`);
    await fs.mkdir(stage, { mode: 0o700 });
    try {
      await fs.mkdir(path.join(stage, "skills"), { mode: 0o700 });
      for (const [relative, body] of expected) {
        const target = path.join(stage, ...relative.split("/"));
        await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
        await fs.writeFile(target, body, { mode: 0o400, flag: "wx" });
      }
      try {
        await fs.rename(stage, root);
      } catch (error) {
        if (!(await fs.lstat(root).catch(() => null))?.isDirectory()) throw error;
        await expertResourceFiles.removeStaging(stage);
      }
      await syncDirectoryEntry(base);
    } catch (error) {
      await expertResourceFiles.removeStaging(stage).catch(() => undefined);
      throw error;
    }
  }
  const resources = await expertResourceFiles.collect(
    { sourceRoot: root, targetRoot: "projection" },
    { bytes: 1024 * 1024, entries: 500 },
  );
  const files = resources.filter((resource) => resource.kind === "file");
  if (
    files.length !== expected.size ||
    files.some(
      (resource) =>
        !expected.has(resource.path.slice("projection/".length)) ||
        resource.sha256 !== sha(expected.get(resource.path.slice("projection/".length))!),
    )
  )
    throw new Error("Fixed Skill projection changed or contains unselected entries.");
  return { root, pluginName, entries };
}

export async function verifyProjectedSkillAssembly(
  session: ProviderExpertSession,
  projection: FixedSkillProjection,
  active: ReadonlyArray<{ readonly name: string; readonly path: string }>,
  lifecycleGeneration: string,
): Promise<void> {
  invalidateNativeSkillAssemblyVerification(session);
  const mapped = active.map((item) => {
    const entry = projection.entries.find(
      (candidate) =>
        (item.name === candidate.name ||
          item.name === `${projection.pluginName}:${candidate.name}`) &&
        path.resolve(item.path) === path.resolve(candidate.path),
    );
    if (!entry) throw new Error(`Native catalog contains an unselected Skill: ${item.name}`);
    return { name: entry.originalName, path: entry.originalPath };
  });
  for (const entry of projection.entries)
    if (sha(await expertResourceFiles.read(entry.path)) !== entry.sha256)
      throw new Error("Fixed Skill projection content changed.");
  await recordVerifiedNativeSkillAssembly(session, mapped, lifecycleGeneration);
}
