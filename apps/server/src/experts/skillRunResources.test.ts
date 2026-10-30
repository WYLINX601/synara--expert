import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createSkillPackageStore } from "./SkillPackageStore";
import { expertResourceFiles } from "./ExpertStore";
import {
  prepareSkillRunResources,
  privateSkillResourceRoot,
  verifySkillRunResources,
} from "./skillRunResources";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await expertResourceFiles.removeStaging(root);
});

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "synara-run-resource-"));
  roots.push(root);
  const stateDir = path.join(root, "state");
  const source = path.join(root, "source");
  await fs.mkdir(path.join(source, "nested"), { recursive: true });
  await fs.writeFile(
    path.join(source, "SKILL.md"),
    "---\nname: writer\ndescription: Files\n---\nUse nested/input.txt.",
  );
  await fs.writeFile(path.join(source, "nested", "input.txt"), "Fixed input.");
  const store = createSkillPackageStore(stateDir);
  const preview = await store.preview({ path: source });
  const imported = await store.import({ previewId: preview.previewId });
  const entries = await store.resolveSelections([
    {
      packageId: imported.package.packageId,
      entryPath: "SKILL.md",
      resourceMode: "run-private",
    },
  ]);
  return { root, stateDir, entries, packageId: imported.package.packageId };
}

describe("Run-private Skill resource boundaries", () => {
  it.skipIf(process.platform === "win32")(
    "rejects writable shared inputs without calling the source package corrupt",
    async () => {
      const f = await fixture();
      const entries = f.entries.map((entry) => ({
        ...entry,
        resourceMode: "shared-readonly" as const,
      }));
      const input = path.join(path.dirname(entries[0]!.path), "nested", "input.txt");
      await fs.chmod(input, 0o600);
      await expect(createSkillPackageStore(f.stateDir).read(f.packageId)).resolves.toMatchObject({
        packageId: f.packageId,
      });
      await expect(verifySkillRunResources(f.stateDir, entries)).rejects.toThrow("read-only");
      await fs.chmod(input, 0o400);
      await expect(verifySkillRunResources(f.stateDir, entries)).resolves.toBeUndefined();
      await fs.chmod(path.dirname(input), 0o700);
      await expect(verifySkillRunResources(f.stateDir, entries)).rejects.toThrow("read-only");
    },
  );

  it("refuses a forged working root without modifying the external directory", async () => {
    const f = await fixture();
    const outside = path.join(f.root, "external");
    await fs.mkdir(outside);
    await expect(
      prepareSkillRunResources(f.stateDir, "run", f.entries, [
        {
          packageId: f.packageId,
          mode: "run-private",
          ownerRootRunId: "run",
          rootPath: outside,
        },
      ]),
    ).rejects.toThrow("working tree identity");
    expect(await fs.readdir(outside)).toEqual([]);
  });

  it("does not follow a linked owner directory during materialization", async () => {
    const f = await fixture();
    const parent = path.join(f.stateDir, "experts", "run-skill-resources");
    const outside = path.join(f.root, "external");
    await fs.mkdir(parent);
    await fs.mkdir(outside);
    await fs.symlink(outside, path.join(parent, createHash("sha256").update("run").digest("hex")));
    await expect(prepareSkillRunResources(f.stateDir, "run", f.entries)).rejects.toThrow(
      "unsafe ancestor",
    );
    expect(await fs.readdir(outside)).toEqual([]);
  });

  it("preserves outputs and reports missing or linked fixed inputs as working-copy drift", async () => {
    const f = await fixture();
    const references = await prepareSkillRunResources(f.stateDir, "run", f.entries);
    const working = privateSkillResourceRoot(f.stateDir, "run", f.packageId);
    const output = path.join(working, "result.bin");
    await fs.writeFile(output, Buffer.from([0, 1, 255]));
    await expect(prepareSkillRunResources(f.stateDir, "run", f.entries)).resolves.toEqual(
      references,
    );
    const input = path.join(working, "nested", "input.txt");
    await fs.unlink(input);
    await expect(verifySkillRunResources(f.stateDir, f.entries, references)).rejects.toThrow(
      "working copy drifted",
    );
    await fs.symlink(output, input);
    await expect(verifySkillRunResources(f.stateDir, f.entries, references)).rejects.toThrow(
      "working copy drifted",
    );
    expect(await fs.readFile(output)).toEqual(Buffer.from([0, 1, 255]));
  });
});
