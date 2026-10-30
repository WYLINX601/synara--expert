import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createSkillPackageStore } from "./SkillPackageStore.ts";
import { verifyPinnedSkillReferences } from "./pinnedSkillReferences.ts";

const roots: string[] = [];

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "synara-pinned-skills-"));
  roots.push(root);
  const stateDir = path.join(root, "state");
  const source = path.join(root, "skill");
  await mkdir(source);
  await writeFile(
    path.join(source, "SKILL.md"),
    "---\nname: pinned\ndescription: Test\n---\nBody\n",
  );
  const store = createSkillPackageStore(stateDir);
  const manifest = await store.publishDirectory(source);
  const [entry] = await store.resolveSelections([
    { packageId: manifest.packageId, entryPath: "SKILL.md" },
  ]);
  return { root, stateDir, source, store, manifest, entry: entry! };
}

async function unlock(filePath: string): Promise<void> {
  const stat = await lstat(filePath);
  await chmod(filePath, stat.isDirectory() ? 0o700 : 0o600);
  if (stat.isDirectory())
    for (const child of await readdir(filePath)) await unlock(path.join(filePath, child));
}

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await unlock(root);
    await rm(root, { recursive: true, force: true });
  }
});

describe("verifyPinnedSkillReferences", () => {
  it("verifies package bytes while preserving persisted metadata and accepting legacy missing hashes", async () => {
    const { stateDir, entry } = await fixture();
    const historical = { ...entry, name: "Preserved historical name" };
    delete historical.sha256;

    await expect(verifyPinnedSkillReferences(stateDir, [historical])).resolves.toBeUndefined();
    expect(historical.name).toBe("Preserved historical name");
    expect(historical.sha256).toBeUndefined();
  });

  it("rejects mismatched paths, hashes, missing entries, and changed package content", async () => {
    const { stateDir, manifest, entry } = await fixture();

    await expect(
      verifyPinnedSkillReferences(stateDir, [{ ...entry, path: `${entry.path}.elsewhere` }]),
    ).rejects.toThrow(/path does not match/u);
    await expect(
      verifyPinnedSkillReferences(stateDir, [{ ...entry, sha256: "0".repeat(64) }]),
    ).rejects.toThrow(/hash does not match/u);
    await expect(
      verifyPinnedSkillReferences(stateDir, [{ ...entry, entryPath: "missing/SKILL.md" }]),
    ).rejects.toThrow(/missing from package/u);

    const skillPath = path.join(
      stateDir,
      "experts",
      "skill-packages",
      manifest.packageId,
      "content",
      "SKILL.md",
    );
    await chmod(skillPath, 0o600);
    await writeFile(skillPath, "changed bytes\n");
    await expect(verifyPinnedSkillReferences(stateDir, [entry])).rejects.toMatchObject({
      code: "package_corrupt",
    });
    await expect(readFile(skillPath, "utf8")).resolves.toBe("changed bytes\n");
  });
});
