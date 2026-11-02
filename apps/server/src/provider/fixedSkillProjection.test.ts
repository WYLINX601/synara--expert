import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { FIXED_EXPERT_SKILL_POLICY, type ProviderExpertSession } from "@synara/contracts";

import { createSkillPackageStore } from "../experts/SkillPackageStore";
import { prepareSkillRunResources } from "../experts/skillRunResources";
import { createFixedSkillProjection, verifyProjectedSkillAssembly } from "./fixedSkillProjection";

const temporaryDirectories: string[] = [];

async function unlockTree(directory: string): Promise<void> {
  const stat = await fs.lstat(directory).catch(() => undefined);
  if (!stat || stat.isSymbolicLink()) return;
  await fs.chmod(directory, stat.isDirectory() ? 0o700 : 0o600);
  if (stat.isDirectory())
    for (const item of await fs.readdir(directory)) await unlockTree(path.join(directory, item));
}

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await unlockTree(directory);
    await fs.rm(directory, { recursive: true, force: true });
  }
});

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "synara-fixed-assembly-"));
  temporaryDirectories.push(root);
  const stateDir = path.join(root, "state");
  const source = path.join(root, "package");
  await fs.mkdir(path.join(source, "skills", "selected"), { recursive: true });
  await fs.mkdir(path.join(source, "skills", "unselected"), { recursive: true });
  await fs.mkdir(path.join(source, "agents"), { recursive: true });
  await fs.mkdir(path.join(source, "assets"), { recursive: true });
  await fs.writeFile(
    path.join(source, "skills", "selected", "SKILL.md"),
    "---\nname: selected\ndescription: Selected entry\nagent: reviewer\n---\nRead ../unselected/SKILL.md and ../../assets/reference.txt.\n",
  );
  await fs.writeFile(
    path.join(source, "skills", "unselected", "SKILL.md"),
    "---\nname: unselected\ndescription: Keep in full tree\n---\nNot selected.\n",
  );
  await fs.writeFile(path.join(source, "assets", "reference.txt"), "cross-entry resource\n");
  await fs.writeFile(path.join(source, "agents", "reviewer.md"), "---\nname: [invalid\n");

  const store = createSkillPackageStore(stateDir);
  const preview = await store.preview({ path: source });
  const imported = await store.import({ previewId: preview.previewId });
  const [entry] = await store.resolveSelections([
    {
      packageId: imported.package.packageId,
      entryPath: "skills/selected/SKILL.md",
    },
  ]);
  expect(entry).toBeDefined();
  return { root, stateDir, source, store, imported, entry: entry! };
}

function session(
  stateDir: string,
  entry: Awaited<ReturnType<typeof fixture>>["entry"],
  overrides: Partial<ProviderExpertSession> = {},
): ProviderExpertSession {
  return {
    skillAssemblyId: "assembly-generic-projection",
    snapshotId: `exp_${"a".repeat(64)}`,
    persona: "Expert",
    skillsRoot: path.join(stateDir, "experts", "skill-packages"),
    skills: [{ name: entry.name, path: entry.path }],
    skillEntries: [entry],
    skillPolicy: FIXED_EXPERT_SKILL_POLICY,
    references: [],
    ...overrides,
  };
}

describe("fixed provider-neutral Skill projection", () => {
  it("returns the complete immutable package tree without Claude parsing or copying", async () => {
    const { root, stateDir, imported, entry } = await fixture();
    const projection = await createFixedSkillProjection(
      path.join(root, "views"),
      session(stateDir, entry),
    );

    expect(projection.packages).toHaveLength(1);
    expect(projection.packages[0]).toMatchObject({
      packageId: imported.package.packageId,
      isPrivate: false,
      sourceRoot: projection.packages[0]!.contentRoot,
    });
    expect(projection.skillRoots).toEqual([projection.packages[0]!.contentRoot]);
    expect(projection.entries).toMatchObject([
      {
        packageId: imported.package.packageId,
        entryPath: "skills/selected/SKILL.md",
        name: "selected",
        nativeName: "selected",
        path: entry.path,
        originalPath: entry.path,
        runtimePath: entry.path,
      },
    ]);
    expect(projection).not.toHaveProperty("plugins");
    expect(projection).not.toHaveProperty("agents");
    expect(
      await fs.readFile(
        path.join(projection.skillRoots[0]!, "skills", "unselected", "SKILL.md"),
        "utf8",
      ),
    ).toContain("Keep in full tree");
    expect(
      await fs.readFile(path.join(projection.skillRoots[0]!, "assets", "reference.txt"), "utf8"),
    ).toBe("cross-entry resource\n");
    await expect(fs.lstat(projection.root)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("uses the persistent Run-private resource root and preserves run outputs", async () => {
    const { root, stateDir, entry } = await fixture();
    const privateEntry = { ...entry, resourceMode: "run-private" as const };
    const refs = await prepareSkillRunResources(stateDir, "owner-run-projection", [privateEntry]);
    const privateRoot = refs[0]!.rootPath;
    const output = path.join(privateRoot, "agent-output.txt");
    await fs.writeFile(output, "preserve this output\n");
    const projected = await createFixedSkillProjection(
      path.join(root, "views"),
      session(stateDir, privateEntry, { skillResourceRefs: refs }),
    );

    expect(projected.packages[0]).toMatchObject({ sourceRoot: privateRoot, isPrivate: true });
    expect(projected.entries[0]?.path).toBe(
      path.join(privateRoot, "skills", "selected", "SKILL.md"),
    );
    expect(projected.entries[0]?.runtimePath).toBe(projected.entries[0]?.path);
    expect(await fs.readFile(output, "utf8")).toBe("preserve this output\n");
    await expect(fs.lstat(projected.root)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("has no package roots or ambient directories for an empty assembly", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synara-empty-fixed-assembly-"));
    temporaryDirectories.push(root);
    const projection = await createFixedSkillProjection(path.join(root, "views"), {
      skillAssemblyId: "assembly-empty-generic",
      snapshotId: `exp_${"b".repeat(64)}`,
      persona: "Expert",
      skills: [],
      skillEntries: [],
      skillPolicy: FIXED_EXPERT_SKILL_POLICY,
      references: [],
    });
    expect(projection.skillRoots).toEqual([]);
    expect(projection.packages).toEqual([]);
    expect(projection.entries).toEqual([]);
    await expect(fs.lstat(projection.root)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("maps verified native entries back to the immutable source for shared assembly", async () => {
    const { root, stateDir, entry } = await fixture();
    const expert = session(stateDir, entry);
    const projection = await createFixedSkillProjection(path.join(root, "views"), expert);
    await expect(
      verifyProjectedSkillAssembly(
        expert,
        projection,
        projection.entries.map(({ name, path: entryPath }) => ({ name, path: entryPath })),
        "generation-generic",
      ),
    ).resolves.toBeUndefined();
  });
});
