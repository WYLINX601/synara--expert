import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSkillLibraryStore } from "./SkillLibraryStore";
import { expertResourceFiles, createExpertStore } from "./ExpertStore";
import { createSkillPackageStore } from "./SkillPackageStore";
import * as storage from "./ExpertMcpStorage";
import { SKILL_FILE_LIMIT } from "./skillLibraryArchive";

const roots: string[] = [];
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "synara-skill-library-"));
  roots.push(root);
  const stateDir = path.join(root, "state");
  return { root, stateDir, store: createSkillLibraryStore(stateDir) };
}
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await expertResourceFiles.removeStaging(root);
});
const body = "---\nname: alpha\ndescription: Alpha skill\n---\nDo alpha.\n";
describe("managed Skill library", () => {
  it("publishes immutable edits, preserves binary bytes and pins admitted Expert tasks", async () => {
    const { store, stateDir } = await fixture();
    const first = (await store.execute({ action: "create", name: "Alpha", body, tags: ["test"] }))
      .skill!;
    const experts = createExpertStore(stateDir);
    const expert = await experts.save({
      name: "Expert",
      description: "",
      useCases: "",
      persona: "Expert persona",
      outputRequirements: "",
      skills: [],
      references: [],
      connections: [],
      skillBindings: [{ skillId: first.skillId, enabled: true, activation: "on-demand" }],
    });
    const pinned = await experts.prepareSnapshot(expert.id);
    const binary = Buffer.from([0, 255, 128, 42]);
    const next = (
      await store.execute({
        action: "save",
        skillId: first.skillId,
        expectedRevision: first.revision,
        name: "Alpha",
        tags: [],
        changes: [
          { path: "assets/data.bin", content: binary.toString("base64") },
          { path: "SKILL.md", content: Buffer.from(body + "Changed.\n").toString("base64") },
        ],
      })
    ).skill!;
    expect(next.skillId).toBe(first.skillId);
    expect(next.packageId).not.toBe(first.packageId);
    expect((await experts.readSnapshot(pinned.snapshotId)).skillSelections?.[0]?.packageId).toBe(
      first.packageId,
    );
    const fresh = await experts.prepareSnapshot(expert.id);
    expect((await experts.readSnapshot(fresh.snapshotId)).skillSelections?.[0]?.packageId).toBe(
      next.packageId,
    );
    expect(
      (await store.execute({ action: "readFile", skillId: first.skillId, path: "assets/data.bin" }))
        .file?.content,
    ).toBe(binary.toString("base64"));
    await expect(
      store.execute({
        action: "save",
        skillId: first.skillId,
        expectedRevision: first.revision,
        name: "Alpha",
        tags: [],
        changes: [],
      }),
    ).rejects.toThrow(/revision/iu);
  });
  it("rejects an oversized registry before writing and preserves a readable near-limit library head", async () => {
    const { store, stateDir } = await fixture();
    const largeBody = `---\nname: alpha\ndescription: ${"中".repeat(2500)}\n---\nOriginal instructions.\n`;
    const first = (
      await store.execute({ action: "create", name: "alpha", body: largeBody, tags: [] })
    ).skill!;
    const formatEntry = (entry: typeof first) =>
      JSON.stringify(entry, null, 2)
        .split("\n")
        .map((line) => `    ${line}`)
        .join("\n");
    const entryBytes = Buffer.byteLength(formatEntry(first));
    const count = Math.floor((SKILL_FILE_LIMIT - 256) / (entryBytes + 2));
    const skills = Array.from({ length: count }, (_, index) => ({
      ...first,
      skillId: index === 0 ? first.skillId : `skl_${index.toString(16).padStart(32, "0")}`,
      tags: [] as string[],
    }));
    const serialize = () => `${JSON.stringify({ schemaVersion: 1, skills }, null, 2)}\n`;
    let size = Buffer.byteLength(serialize());
    const last = skills.at(-1)!;
    while (SKILL_FILE_LIMIT - size > 160) {
      const remaining = SKILL_FILE_LIMIT - size - 128;
      const tagLength = Math.min(100, remaining - 32);
      const previousSize = Buffer.byteLength(formatEntry(last));
      last.tags.push(`${last.tags.length}-`.padEnd(tagLength, "x"));
      size += Buffer.byteLength(formatEntry(last)) - previousSize;
    }
    const original = Buffer.from(serialize());
    expect(original.byteLength).toBe(size);
    expect(size).toBeLessThanOrEqual(SKILL_FILE_LIMIT);
    expect(size).toBeGreaterThan(SKILL_FILE_LIMIT - 256);
    expect(last.tags.length).toBeLessThanOrEqual(100);
    const registry = path.join(stateDir, "experts", "skill-library.json");
    await fs.writeFile(registry, original);
    const packagesDir = path.join(stateDir, "experts", "skill-packages");
    const inventory = await fs.readdir(packagesDir);
    expect((await store.execute({ action: "list" })).skills).toHaveLength(count);
    expect((await store.execute({ action: "read", skillId: first.skillId })).skill).toEqual(first);
    const write = vi.spyOn(storage, "writePrivateFileAtomically");
    await expect(
      store.execute({
        action: "save",
        skillId: first.skillId,
        expectedRevision: first.revision,
        name: first.name,
        tags: ["更".repeat(100)],
        changes: [
          {
            path: "SKILL.md",
            content: Buffer.from(largeBody + "Changed instructions.\n").toString("base64"),
          },
        ],
      }),
    ).rejects.toThrow(/registry.*16 MiB/iu);
    expect(write.mock.calls.filter(([target]) => target === registry)).toEqual([]);
    expect((await fs.readFile(registry)).equals(original)).toBe(true);
    expect((await store.execute({ action: "read", skillId: first.skillId })).skill).toEqual(first);
    expect((await store.execute({ action: "list" })).skills).toHaveLength(count);
    expect(await fs.readdir(packagesDir)).toEqual(inventory);
    expect(await fs.readdir(path.join(stateDir, "experts", "skill-library-staging"))).toEqual([]);
  });
  it("rolls back a newly published package after a registry write failure without changing the head", async () => {
    const { store, stateDir } = await fixture();
    const first = (await store.execute({ action: "create", name: "alpha", body, tags: [] })).skill!;
    const registry = path.join(stateDir, "experts", "skill-library.json");
    const original = await fs.readFile(registry);
    const packagesDir = path.join(stateDir, "experts", "skill-packages");
    const inventory = await fs.readdir(packagesDir);
    const write = storage.writePrivateFileAtomically;
    vi.spyOn(storage, "writePrivateFileAtomically").mockImplementation(async (...args) => {
      if (args[0] === registry) throw new Error("injected registry write failure");
      return write(...args);
    });
    await expect(
      store.execute({
        action: "save",
        skillId: first.skillId,
        expectedRevision: first.revision,
        name: first.name,
        tags: [],
        changes: [
          { path: "SKILL.md", content: Buffer.from(body + "New body.\n").toString("base64") },
        ],
      }),
    ).rejects.toThrow("injected registry write failure");
    expect(await fs.readFile(registry)).toEqual(original);
    expect((await store.execute({ action: "read", skillId: first.skillId })).skill).toEqual(first);
    expect(await fs.readdir(packagesDir)).toEqual(inventory);
    expect(await fs.readdir(path.join(stateDir, "experts", "skill-library-staging"))).toEqual([]);
  });
  it("imports only explicitly selected entries and previews refresh overwriting local edits", async () => {
    const { root, store } = await fixture();
    const source = path.join(root, "source");
    await fs.mkdir(path.join(source, "alpha"), { recursive: true });
    await fs.mkdir(path.join(source, "sibling"));
    await fs.writeFile(path.join(source, "alpha", "SKILL.md"), body);
    await fs.writeFile(
      path.join(source, "sibling", "SKILL.md"),
      body.replaceAll("alpha", "sibling"),
    );
    const preview = (
      await store.execute({ action: "previewImport", location: source, kind: "local" })
    ).preview!;
    const imported = (
      await store.execute({
        action: "import",
        previewId: preview.previewId,
        choices: [{ entryPath: "alpha/SKILL.md", duplicate: "rename" }],
      })
    ).skills!;
    expect(imported).toHaveLength(1);
    const item = imported[0]!;
    const edited = (
      await store.execute({
        action: "save",
        skillId: item.skillId,
        expectedRevision: item.revision,
        name: item.name,
        tags: [],
        changes: [
          { path: "alpha/SKILL.md", content: Buffer.from(body + "Local.\n").toString("base64") },
        ],
      })
    ).skill!;
    const refresh = (
      await store.execute({
        action: "previewRefresh",
        skillId: item.skillId,
        expectedRevision: edited.revision,
      })
    ).preview!;
    expect(refresh.overwritesLocalEdits).toBe(true);
    const updated = (
      await store.execute({
        action: "refresh",
        skillId: item.skillId,
        expectedRevision: edited.revision,
        previewId: refresh.previewId,
      })
    ).skill!;
    expect(updated.skillId).toBe(item.skillId);
    expect(updated.locallyModified).toBe(false);
    await fs.rm(path.join(source, "alpha"), { recursive: true });
    await expect(
      store.execute({
        action: "previewRefresh",
        skillId: item.skillId,
        expectedRevision: updated.revision,
      }),
    ).rejects.toThrow(/disappeared/iu);
  });
  it("marks an imported rename as a local edit before source refresh", async () => {
    const { root, store } = await fixture(),
      source = path.join(root, "source");
    await fs.mkdir(source);
    await fs.writeFile(path.join(source, "SKILL.md"), body);
    const preview = (
      await store.execute({ action: "previewImport", location: source, kind: "local" })
    ).preview!;
    const item = (
      await store.execute({
        action: "import",
        previewId: preview.previewId,
        choices: [{ entryPath: "SKILL.md", duplicate: "rename", name: "custom-alpha" }],
      })
    ).skills![0]!;
    expect(item.name).toBe("custom-alpha");
    expect(item.locallyModified).toBe(true);
    expect(item.packageId).not.toBe(item.source.packageId);
    expect(
      (await store.execute({ action: "readFile", skillId: item.skillId, path: "SKILL.md" })).file
        ?.text,
    ).toContain("name: custom-alpha");
    const refresh = (
      await store.execute({
        action: "previewRefresh",
        skillId: item.skillId,
        expectedRevision: item.revision,
      })
    ).preview!;
    expect(refresh.overwritesLocalEdits).toBe(true);
    expect(refresh.resourceChanges).toContain("content/SKILL.md");
    const updated = (
      await store.execute({
        action: "refresh",
        skillId: item.skillId,
        expectedRevision: item.revision,
        previewId: refresh.previewId,
      })
    ).skill!;
    expect(updated.skillId).toBe(item.skillId);
    expect(updated.name).toBe("alpha");
    expect(updated.locallyModified).toBe(false);
  });
  it("rejects traversal without moving the head and reports each batch item", async () => {
    const { store } = await fixture();
    const item = (await store.execute({ action: "create", name: "Alpha", body, tags: [] })).skill!;
    await expect(
      store.execute({
        action: "save",
        skillId: item.skillId,
        expectedRevision: item.revision,
        name: item.name,
        tags: [],
        changes: [{ path: "../escape", content: "AA==" }],
      }),
    ).rejects.toThrow();
    expect((await store.execute({ action: "read", skillId: item.skillId })).skill?.packageId).toBe(
      item.packageId,
    );
    const result = await store.execute({
      action: "batch",
      items: [
        { skillId: item.skillId, expectedRevision: item.revision, operation: "tags", tags: ["ok"] },
        {
          skillId: item.skillId,
          expectedRevision: item.revision,
          operation: "delete",
          confirmExpertIds: [],
        },
      ],
    });
    expect(result.results?.map((item) => item.success)).toEqual([true, false]);
  });
  it("retains publication under the same lifecycle lock as its durable head", async () => {
    const { store, stateDir } = await fixture();
    const first = (await store.execute({ action: "create", name: "alpha", body, tags: [] })).skill!;
    const original = storage.writePrivateFileAtomically;
    let release!: () => void,
      entered!: () => void,
      publishedId = "";
    const gate = new Promise<void>((resolve) => {
        release = resolve;
      }),
      blocked = new Promise<void>((resolve) => {
        entered = resolve;
      });
    vi.spyOn(storage, "writePrivateFileAtomically").mockImplementation(async (target, bytes) => {
      if (target.endsWith("skill-library.json")) {
        publishedId = (JSON.parse(String(bytes)) as { skills: { packageId: string }[] }).skills[0]!
          .packageId;
        entered();
        await gate;
      }
      return original(target, bytes);
    });
    const save = store.execute({
      action: "save",
      skillId: first.skillId,
      expectedRevision: first.revision,
      name: first.name,
      tags: [],
      changes: [{ path: "notes.txt", content: Buffer.from("new content").toString("base64") }],
    });
    await blocked;
    let removed = false;
    const removal = createSkillPackageStore(stateDir)
      .remove(publishedId)
      .finally(() => {
        removed = true;
      });
    const rejection = expect(removal).rejects.toThrow(/referenced/iu);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(removed).toBe(false);
    release();
    await save;
    await rejection;
    expect((await store.execute({ action: "read", skillId: first.skillId })).skill?.packageId).toBe(
      publishedId,
    );
  });
  it("atomically refuses a rebind queued during the final logical deletion", async () => {
    const { store, stateDir } = await fixture();
    const item = (await store.execute({ action: "create", name: "alpha", body, tags: [] })).skill!;
    const experts = createExpertStore(stateDir),
      expert = await experts.save({
        name: "Unbound",
        description: "",
        useCases: "",
        persona: "Expert",
        outputRequirements: "",
        skills: [],
        skillBindings: [],
        references: [],
        connections: [],
      });
    const original = storage.writePrivateFileAtomically;
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>((resolve) => {
        release = resolve;
      }),
      blocked = new Promise<void>((resolve) => {
        entered = resolve;
      });
    vi.spyOn(storage, "writePrivateFileAtomically").mockImplementation(async (target, bytes) => {
      if (target.endsWith("skill-library.json") && String(bytes).includes('"deleted": true')) {
        entered();
        await gate;
      }
      return original(target, bytes);
    });
    const deletion = store.execute({
      action: "delete",
      skillId: item.skillId,
      expectedRevision: item.revision,
      confirmExpertIds: [],
    });
    await blocked;
    const rebind = experts.save({
      ...expert,
      expectedRevision: expert.revision,
      skillBindings: [{ skillId: item.skillId, enabled: true, activation: "on-demand" }],
    });
    const rejection = expect(rebind).rejects.toThrow(/unavailable/iu);
    release();
    await deletion;
    await rejection;
    expect((await experts.read(expert.id))?.skillBindings).toEqual([]);
  });
  it("confirms affected bindings, unbinds and logically deletes while preserving pinned packages", async () => {
    const { store, stateDir } = await fixture();
    const item = (await store.execute({ action: "create", name: "alpha", body, tags: [] })).skill!;
    const experts = createExpertStore(stateDir),
      expert = await experts.save({
        name: "Bound",
        description: "",
        useCases: "",
        persona: "Expert",
        outputRequirements: "",
        skills: [],
        references: [],
        connections: [],
        skillBindings: [{ skillId: item.skillId, enabled: true, activation: "startup" }],
      });
    const pinned = await experts.prepareSnapshot(expert.id);
    expect(
      (await store.execute({ action: "previewDelete", skillId: item.skillId })).expertIds,
    ).toEqual([expert.id]);
    await expect(
      store.execute({
        action: "delete",
        skillId: item.skillId,
        expectedRevision: item.revision,
        confirmExpertIds: [],
      }),
    ).rejects.toThrow(/bindings changed/iu);
    await store.execute({
      action: "delete",
      skillId: item.skillId,
      expectedRevision: item.revision,
      confirmExpertIds: [expert.id],
    });
    expect((await store.execute({ action: "list" })).skills).toEqual([]);
    expect((await experts.read(expert.id))?.skillBindings).toEqual([]);
    expect((await experts.readSnapshot(pinned.snapshotId)).skillSelections?.[0]?.packageId).toBe(
      item.packageId,
    );
    await expect(createSkillPackageStore(stateDir).remove(item.packageId)).rejects.toThrow(
      /referenced/iu,
    );
  });
  it("refresh batches require individual previews and preserve the successful/failed boundary", async () => {
    const { store, root } = await fixture();
    const source = path.join(root, "source");
    await fs.mkdir(source);
    await fs.writeFile(path.join(source, "SKILL.md"), body);
    const preview = (
      await store.execute({ action: "previewImport", kind: "local", location: source })
    ).preview!;
    const skill = (
      await store.execute({
        action: "import",
        previewId: preview.previewId,
        choices: [{ entryPath: "SKILL.md", duplicate: "skip" }],
      })
    ).skills![0]!;
    const manual = (await store.execute({ action: "create", name: "manual", body, tags: [] }))
      .skill!;
    await fs.writeFile(path.join(source, "SKILL.md"), body + "Source update\n");
    const previews = await store.execute({
      action: "batch",
      items: [skill, manual].map((item) => ({
        skillId: item.skillId,
        expectedRevision: item.revision,
        operation: "previewRefresh",
      })),
    });
    expect(previews.results?.map((item) => item.success)).toEqual([true, false]);
    expect((await store.execute({ action: "read", skillId: skill.skillId })).skill?.packageId).toBe(
      skill.packageId,
    );
    const updated = await store.execute({
      action: "batch",
      items: [
        {
          skillId: skill.skillId,
          expectedRevision: skill.revision,
          operation: "refresh",
          previewId: previews.results![0]!.preview!.previewId,
        },
      ],
    });
    expect(updated.results?.[0]?.success).toBe(true);
    expect(
      (await store.execute({ action: "read", skillId: skill.skillId })).skill?.packageId,
    ).not.toBe(skill.packageId);
  });
});
