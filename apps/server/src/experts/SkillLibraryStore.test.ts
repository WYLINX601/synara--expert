import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSkillLibraryStore } from "./SkillLibraryStore";
import { expertResourceFiles, createExpertStore } from "./ExpertStore";
import { createSkillPackageStore } from "./SkillPackageStore";
import * as storage from "./ExpertMcpStorage";
import { SKILL_FILE_LIMIT } from "./skillLibraryArchive";
import { createRunSkillAssemblyStore } from "./RunSkillAssemblyStore";
import type { SkillLibraryRequest } from "@synara/contracts";

const roots: string[] = [];
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "synara-skill-library-"));
  roots.push(root);
  const stateDir = path.join(root, "state");
  return { root, stateDir, store: createSkillLibraryStore(stateDir) };
}
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const root of roots.splice(0)) await expertResourceFiles.removeStaging(root);
});
const body = "---\nname: alpha\ndescription: Alpha skill\n---\nDo alpha.\n";
function crc32(bytes: Buffer): number {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
  }
  return (value ^ 0xffffffff) >>> 0;
}
function storedZip(entries: ReadonlyArray<{ name: string; content: string }>): Buffer {
  const local: Buffer[] = [],
    central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name),
      data = Buffer.from(entry.content),
      crc = crc32(data),
      header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(data.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(name.length, 26);
    local.push(header, name, data);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50, 0);
    directory.writeUInt16LE(20, 4);
    directory.writeUInt16LE(20, 6);
    directory.writeUInt32LE(crc, 16);
    directory.writeUInt32LE(data.length, 20);
    directory.writeUInt32LE(data.length, 24);
    directory.writeUInt16LE(name.length, 28);
    directory.writeUInt32LE(offset, 42);
    central.push(directory, name);
    offset += header.length + name.length + data.length;
  }
  const centralBytes = Buffer.concat(central),
    end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, centralBytes, end]);
}
function hostedSource() {
  const source = { sha: "1".repeat(40), body, wait: Promise.resolve() };
  const fetch = vi.fn(async (input: unknown) => {
    await source.wait;
    const url = new URL(String(input));
    if (url.pathname.endsWith("/git/matching-refs/heads/main"))
      return Response.json([{ ref: "refs/heads/main" }]);
    if (url.pathname.endsWith("/git/matching-refs/tags/main")) return Response.json([]);
    if (url.pathname.endsWith("/commits/main")) return Response.json({ sha: source.sha });
    if (url.hostname === "codeload.github.com") {
      const archive = storedZip([
        { name: `skills-${source.sha}/alpha/SKILL.md`, content: source.body },
      ]);
      return new Response(archive, { headers: { "content-length": String(archive.length) } });
    }
    return new Response("unexpected request", { status: 500 });
  });
  vi.stubGlobal("fetch", fetch);
  return { source, fetch, location: "https://github.com/acme/skills/tree/main/alpha" };
}
async function bindPair(
  stateDir: string,
  store: ReturnType<typeof createSkillLibraryStore>,
  firstName = "alpha",
) {
  const first = (await store.execute({ action: "create", name: firstName, body, tags: [] })).skill!;
  const second = (await store.execute({ action: "create", name: "beta", body, tags: [] })).skill!;
  const experts = createExpertStore(stateDir);
  const expert = await experts.save({
    name: "Bound pair",
    description: "",
    useCases: "",
    persona: "Expert",
    outputRequirements: "",
    skills: [],
    references: [],
    connections: [],
    skillBindings: [first, second].map((skill) => ({
      skillId: skill.skillId,
      enabled: true,
      activation: "on-demand" as const,
    })),
  });
  return { first, second, experts, expert };
}
describe("managed Skill library", () => {
  it.each(["cancel", "dispose"] as const)(
    "aborts source preparation on %s and cleans staging before reopening the store",
    async (action) => {
      const { stateDir, store } = await fixture();
      const hosted = hostedSource();
      const preview = (
        await store.execute({ action: "previewImport", kind: "url", location: hosted.location })
      ).preview!;
      const skill = (
        await store.execute({
          action: "import",
          previewId: preview.previewId,
          choices: [{ entryPath: "SKILL.md", duplicate: "skip" }],
        })
      ).skills![0]!;
      let entered!: () => void;
      let signal: AbortSignal | undefined;
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      vi.stubGlobal(
        "fetch",
        vi.fn(
          (_input: unknown, options: RequestInit) =>
            new Promise<Response>((_resolve, reject) => {
              signal = options.signal!;
              entered();
              options.signal!.addEventListener(
                "abort",
                () => reject(new Error("Cancelled by caller")),
                { once: true },
              );
            }),
        ),
      );
      const pending = store.execute({
        action: "updateFromSource",
        skillId: skill.skillId,
        expectedRevision: skill.revision,
        requestId: "dispose-source",
        dryRun: true,
      });
      const settled = pending.then(
        (response) => ({ response }),
        (error: unknown) => ({ error }),
      );
      await started;
      try {
        if (action === "cancel")
          await store.execute({ action: "cancel", previewId: "dispose-source" });
        else await store.dispose();
        await vi.waitFor(() => expect(signal?.aborted).toBe(true));
        const result = await settled;
        if (action === "cancel") {
          expect("response" in result && result.response.updateResult).toMatchObject({
            status: "failed",
            error: expect.stringMatching(/cancelled/iu),
          });
        } else expect("error" in result && String(result.error)).toMatch(/closing/iu);
      } finally {
        await store.dispose();
      }
      expect(await fs.readdir(path.join(stateDir, "experts", "skill-library-staging"))).toEqual([]);
      const reopened = createSkillLibraryStore(stateDir);
      expect((await reopened.execute({ action: "read", skillId: skill.skillId })).skill).toEqual(
        skill,
      );
      await reopened.dispose();
    },
  );
  it.each(["single", "batch"] as const)(
    "binds %s source confirmation to the previewed package and refuses source drift",
    async (mode) => {
      const { store } = await fixture();
      const hosted = hostedSource();
      const preview = (
        await store.execute({ action: "previewImport", kind: "url", location: hosted.location })
      ).preview!;
      const initial = (
        await store.execute({
          action: "import",
          previewId: preview.previewId,
          choices: [{ entryPath: "SKILL.md", duplicate: "skip" }],
        })
      ).skills![0]!;
      const edited = (
        await store.execute({
          action: "save",
          skillId: initial.skillId,
          expectedRevision: initial.revision,
          name: initial.name,
          tags: [],
          changes: [
            { path: "SKILL.md", content: Buffer.from(body + "Local draft.\n").toString("base64") },
          ],
        })
      ).skill!;
      hosted.source.sha = "2".repeat(40);
      hosted.source.body = body + "Source version two.\n";
      const request = {
        action: "updateFromSource" as const,
        skillId: edited.skillId,
        expectedRevision: edited.revision,
        requestId: "reviewed-source",
        overwriteLocalEdits: true,
      };
      const reviewed = (await store.execute({ ...request, dryRun: true })).updateResult!.preview!;
      hosted.source.sha = "3".repeat(40);
      hosted.source.body = body + "Source version three.\n";
      const confirmed = { ...request, expectedPackageId: reviewed.package.packageId };
      const { action: _action, ...confirmedItem } = confirmed;
      const response = await store.execute(
        mode === "single"
          ? confirmed
          : { action: "batch", items: [{ ...confirmedItem, operation: "updateFromSource" }] },
      );
      const update =
        mode === "single" ? response.updateResult : response.results?.[0]?.updateResult;
      expect(update).toMatchObject({ status: "conflict", revision: edited.revision });
      expect((await store.execute({ action: "read", skillId: edited.skillId })).skill).toEqual(
        edited,
      );
      const refreshed = { ...request, requestId: "reviewed-new-source" };
      const next = (await store.execute({ ...refreshed, dryRun: true })).updateResult!.preview!;
      expect(
        (await store.execute({ ...refreshed, expectedPackageId: next.package.packageId }))
          .updateResult?.status,
      ).toBe("updated");
      expect(
        (await store.execute({ action: "read", skillId: edited.skillId })).skill?.source
          .resolvedRevision,
      ).toBe(hosted.source.sha);
    },
  );

  it.each([
    ["alpha", "alpha"],
    ["alpha", "ALPHA"],
    ["café", "cafe\u0301"],
  ])(
    "rejects renaming a bound Skill from beta to %s / %s before changing its head",
    async (firstName, conflictingName) => {
      const { stateDir, store } = await fixture();
      const { second, experts, expert } = await bindPair(stateDir, store, firstName);
      const base = await experts.prepareSnapshot(expert.id);
      const runs = createRunSkillAssemblyStore(stateDir);
      const prepare = (rootRunId: string) =>
        runs.prepare({
          threadId: "conflict-thread",
          rootRunId,
          baseSnapshotId: base.snapshotId,
          createdAt: "2026-10-27T00:00:00.000Z",
        });
      const pinned = await prepare("before-conflict");
      await expect(
        store.execute({
          action: "save",
          skillId: second.skillId,
          expectedRevision: second.revision,
          name: conflictingName,
          tags: [],
          changes: [],
        }),
      ).rejects.toThrow(/Duplicate selected skill name/u);
      expect((await store.execute({ action: "read", skillId: second.skillId })).skill).toEqual(
        second,
      );
      expect(
        (await prepare("after-conflict")).session.skillEntries?.map((entry) => entry.name),
      ).toEqual([firstName, "beta"]);
      expect((await runs.read(pinned.rootRunId))?.session).toEqual(pinned.session);
      // Names are scoped to effective Expert assemblies, not the whole library.
      expect(
        (await store.execute({ action: "create", name: conflictingName, body, tags: [] })).skill
          ?.name,
      ).toBe(conflictingName);
    },
  );

  it.each(["replace", "refresh", "updateFromSource"] as const)(
    "validates bound Expert assemblies for %s publication",
    async (operation) => {
      const { root, stateDir, store } = await fixture();
      const { second } = await bindPair(stateDir, store);
      let request: SkillLibraryRequest;
      let prior = second;
      if (operation === "replace") {
        const source = path.join(root, "replacement");
        await fs.mkdir(source);
        await fs.writeFile(path.join(source, "SKILL.md"), body);
        const preview = (
          await store.execute({ action: "previewImport", kind: "local", location: source })
        ).preview!;
        request = {
          action: "import",
          previewId: preview.previewId,
          choices: [
            {
              entryPath: "SKILL.md",
              duplicate: "replace",
              replaceSkillId: second.skillId,
              expectedRevision: second.revision,
            },
          ],
        };
      } else {
        const hosted = hostedSource();
        const registry = path.join(stateDir, "experts", "skill-library.json");
        const data = JSON.parse(await fs.readFile(registry, "utf8")) as {
          skills: Array<typeof second>;
        };
        prior = { ...second, source: { ...second.source, kind: "url", location: hosted.location } };
        data.skills = data.skills.map((skill) =>
          skill.skillId === second.skillId ? prior : skill,
        );
        await fs.writeFile(registry, JSON.stringify(data));
        if (operation === "refresh") {
          const preview = (
            await store.execute({
              action: "previewRefresh",
              skillId: second.skillId,
              expectedRevision: second.revision,
            })
          ).preview!;
          request = {
            action: "refresh",
            skillId: second.skillId,
            expectedRevision: second.revision,
            previewId: preview.previewId,
          };
        } else
          request = {
            action: "updateFromSource",
            skillId: second.skillId,
            expectedRevision: second.revision,
            requestId: "conflicting-source",
          };
      }
      if (operation === "updateFromSource")
        expect((await store.execute(request)).updateResult).toMatchObject({
          status: "failed",
          error: expect.stringMatching(/Duplicate selected skill name/u),
        });
      else await expect(store.execute(request)).rejects.toThrow(/Duplicate selected skill name/u);
      expect((await store.execute({ action: "read", skillId: second.skillId })).skill).toEqual(
        prior,
      );
    },
  );

  it.each(["previewImport", "updateFromSource", "batch"] as const)(
    "allows committed reads and unrelated writes while %s waits for a remote download",
    async (action) => {
      const { stateDir, store } = await fixture();
      const hosted = hostedSource();
      const preview = (
        await store.execute({ action: "previewImport", kind: "url", location: hosted.location })
      ).preview!;
      const original = (
        await store.execute({
          action: "import",
          previewId: preview.previewId,
          choices: [{ entryPath: "SKILL.md", duplicate: "skip" }],
        })
      ).skills![0]!;
      const unrelated = (
        await store.execute({ action: "create", name: "unrelated", body, tags: [] })
      ).skill!;
      let release!: () => void;
      hosted.source.wait = new Promise<void>((resolve) => {
        release = resolve;
      });
      const count = hosted.fetch.mock.calls.length;
      const update = {
        action: "updateFromSource" as const,
        skillId: original.skillId,
        expectedRevision: original.revision,
        requestId: "slow-source",
      };
      const { action: _action, ...updateItem } = update;
      const pending = store.execute(
        action === "previewImport"
          ? { action, kind: "url", location: hosted.location }
          : action === "batch"
            ? { action, items: [{ ...updateItem, operation: "updateFromSource" }] }
            : update,
      );
      try {
        await vi.waitFor(() => expect(hosted.fetch.mock.calls.length).toBeGreaterThan(count));
        expect((await store.execute({ action: "list" })).skills).toHaveLength(2);
        expect((await store.execute({ action: "read", skillId: original.skillId })).skill).toEqual(
          original,
        );
        expect(
          (
            await store.execute({
              action: "save",
              skillId: unrelated.skillId,
              expectedRevision: unrelated.revision,
              name: unrelated.name,
              tags: ["during-download"],
              changes: [],
            })
          ).skill?.revision,
        ).toBe(unrelated.revision + 1);
        if (action !== "previewImport") {
          await store.execute({
            action: "save",
            skillId: original.skillId,
            expectedRevision: original.revision,
            name: original.name,
            tags: ["concurrent"],
            changes: [],
          });
        }
      } finally {
        release();
      }
      const response = await pending;
      if (action === "previewImport") {
        await store.execute({ action: "cancel", previewId: response.preview!.previewId });
      } else {
        const result =
          action === "batch" ? response.results?.[0]?.updateResult : response.updateResult;
        expect(result?.status).toBe("conflict");
        expect(
          (await store.execute({ action: "read", skillId: original.skillId })).skill?.tags,
        ).toEqual(["concurrent"]);
      }
      await store.dispose();
      expect(await fs.readdir(path.join(stateDir, "experts", "skill-library-staging"))).toEqual([]);
    },
  );
  it("saves the description atomically with other resources and preserves raw metadata unless explicitly changed", async () => {
    const { store } = await fixture();
    const first = (
      await store.execute({
        action: "create",
        name: "Alpha",
        body: body.replace("---\nDo alpha.", "allowed-tools: [Read]\n---\nDo alpha."),
        tags: [],
      })
    ).skill!;
    const description = "读取资料：判断何时使用。\n保留多行说明。";
    const next = (
      await store.execute({
        action: "save",
        skillId: first.skillId,
        expectedRevision: first.revision,
        name: first.name,
        description,
        tags: ["review"],
        changes: [
          { path: "notes.txt", content: Buffer.from("Support resource").toString("base64") },
        ],
      })
    ).skill!;
    expect(next.description).toBe(description);
    expect(next.skillId).toBe(first.skillId);
    expect(next.packageId).not.toBe(first.packageId);
    const content = Buffer.from(
      (await store.execute({ action: "readFile", skillId: next.skillId, path: "SKILL.md" })).file!
        .content,
      "base64",
    ).toString("utf8");
    expect(content).toContain("allowed-tools:");
    expect(content).toContain("Do alpha.");
    const raw = (
      await store.execute({
        action: "save",
        skillId: next.skillId,
        expectedRevision: next.revision,
        name: next.name,
        tags: next.tags,
        changes: [
          {
            path: "SKILL.md",
            content: Buffer.from(body.replace("Alpha skill", "Raw editor description")).toString(
              "base64",
            ),
          },
        ],
      })
    ).skill!;
    expect(raw.description).toBe("Raw editor description");
    await expect(
      store.execute({
        action: "save",
        skillId: raw.skillId,
        expectedRevision: next.revision,
        name: raw.name,
        description: "Stale",
        tags: [],
        changes: [],
      }),
    ).rejects.toThrow();
    expect((await store.execute({ action: "read", skillId: raw.skillId })).skill!.description).toBe(
      "Raw editor description",
    );
  });
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
    const atomicWrite = vi
      .spyOn(storage, "writePrivateFileAtomically")
      .mockImplementation(async (...args) => {
        if (args[0] === registry) throw new Error("injected registry write failure");
        return write(...args);
      });
    const saveRequest = {
      action: "save" as const,
      requestId: "save-registry-failure-retry",
      skillId: first.skillId,
      expectedRevision: first.revision,
      name: first.name,
      tags: [],
      changes: [
        { path: "SKILL.md", content: Buffer.from(body + "New body.\n").toString("base64") },
      ],
    };
    await expect(store.execute(saveRequest)).rejects.toThrow("injected registry write failure");
    expect(await fs.readFile(registry)).toEqual(original);
    expect((await store.execute({ action: "read", skillId: first.skillId })).skill).toEqual(first);
    expect(await fs.readdir(packagesDir)).toEqual(inventory);
    expect(await fs.readdir(path.join(stateDir, "experts", "skill-library-staging"))).toEqual([]);
    atomicWrite.mockRestore();
    const retried = (await store.execute(saveRequest)).skill!;
    expect(retried).toMatchObject({ skillId: first.skillId, revision: first.revision + 1 });
    expect((await createSkillPackageStore(stateDir).read(first.packageId)).packageId).toBe(
      first.packageId,
    );
    expect(await fs.readdir(packagesDir)).toHaveLength(inventory.length + 1);
  });
  it("imports only explicitly selected entries and rejects in-place refresh for local sources", async () => {
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
    await expect(
      store.execute({
        action: "previewRefresh",
        skillId: item.skillId,
        expectedRevision: edited.revision,
      }),
    ).rejects.toThrow(/Only GitHub, Skills\.sh, and ClawHub/u);
    const update = await store.execute({
      action: "updateFromSource",
      skillId: item.skillId,
      expectedRevision: edited.revision,
      requestId: "local-source-update-skip",
      overwriteLocalEdits: true,
    });
    expect(update.updateResult?.status).toBe("skipped");
    expect((await store.execute({ action: "read", skillId: item.skillId })).skill).toEqual(edited);
    await fs.rm(path.join(source, "alpha"), { recursive: true });
    await expect(
      store.execute({
        action: "previewRefresh",
        skillId: item.skillId,
        expectedRevision: edited.revision,
      }),
    ).rejects.toThrow(/Only GitHub, Skills\.sh, and ClawHub/u);
  });
  it("marks an imported rename as a local edit and keeps it ineligible for hosted refresh", async () => {
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
    await expect(
      store.execute({
        action: "previewRefresh",
        skillId: item.skillId,
        expectedRevision: item.revision,
      }),
    ).rejects.toThrow(/Only GitHub, Skills\.sh, and ClawHub/u);
    const update = await store.execute({
      action: "updateFromSource",
      skillId: item.skillId,
      expectedRevision: item.revision,
      requestId: "renamed-local-source-update",
      overwriteLocalEdits: true,
    });
    expect(update.updateResult?.status).toBe("skipped");
    expect((await store.execute({ action: "read", skillId: item.skillId })).skill).toEqual(item);
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
    expect(previews.results?.map((item) => item.success)).toEqual([false, false]);
    expect((await store.execute({ action: "read", skillId: skill.skillId })).skill?.packageId).toBe(
      skill.packageId,
    );
    expect(previews.results?.[0]?.message).toMatch(/supported hosted source/u);
    expect(previews.results?.[1]?.message).toMatch(/supported hosted source/u);
    const update = await store.execute({
      action: "updateFromSource",
      skillId: skill.skillId,
      expectedRevision: skill.revision,
      requestId: "local-source-is-skipped",
      dryRun: true,
    });
    expect(update.updateResult?.status).toBe("skipped");
  });

  it("filters Skills server-side and counts disabled bindings as usage", async () => {
    const { store, stateDir } = await fixture();
    const first = (
        await store.execute({
          action: "create",
          name: "Alpha",
          body,
          tags: ["review", "writing"],
          requestId: "filter-alpha-create",
        })
      ).skill!,
      second = (
        await store.execute({
          action: "create",
          name: "Beta",
          body: body.replaceAll("alpha", "beta"),
          tags: ["design", "review"],
          requestId: "filter-beta-create",
        })
      ).skill!;
    const expert = await createExpertStore(stateDir).save({
      name: "Reviewer",
      description: "",
      useCases: "",
      persona: "Reviewer",
      outputRequirements: "",
      skills: [],
      references: [],
      connections: [],
      skillBindings: [
        { skillId: first.skillId, enabled: false, activation: "startup" },
        { skillId: second.skillId, enabled: true, activation: "on-demand" },
      ],
    });
    const all = await store.execute({ action: "list" });
    expect(all.items?.find((item) => item.skillId === first.skillId)?.usage).toEqual({
      expertIds: [expert.id],
      enabledExpertIds: [],
    });
    expect(
      (
        await store.execute({
          action: "list",
          query: {
            usage: "used",
            expertIds: [expert.id],
            sort: { field: "name", direction: "asc" },
          },
        })
      ).skills?.map((skill) => skill.skillId),
    ).toEqual([first.skillId, second.skillId]);
    expect(
      (
        await store.execute({
          action: "list",
          query: {
            sources: ["manual"],
            tags: ["writing", "design"],
            createdBy: ["owner"],
            sort: { field: "name", direction: "asc" },
          },
        })
      ).skills?.map((skill) => skill.skillId),
    ).toEqual([first.skillId, second.skillId]);
    expect(
      (await store.execute({ action: "list", query: { usage: "unused", expertIds: [expert.id] } }))
        .skills,
    ).toEqual([]);
  });

  it("previews and applies N×M bindings without changing existing disabled bindings, then replays after restart", async () => {
    const { store, stateDir } = await fixture();
    const existingSkill = (
        await store.execute({ action: "create", name: "Existing", body, tags: [] })
      ).skill!,
      newSkill = (await store.execute({ action: "create", name: "New", body, tags: [] })).skill!;
    const experts = createExpertStore(stateDir),
      expert = await experts.save({
        name: "Binding target",
        description: "",
        useCases: "",
        persona: "Reviewer",
        outputRequirements: "",
        skills: [],
        references: [],
        connections: [],
        skillBindings: [{ skillId: existingSkill.skillId, enabled: false, activation: "startup" }],
      }),
      request = {
        action: "bindExperts" as const,
        requestId: "n-by-m-replay",
        skillIds: [existingSkill.skillId, newSkill.skillId],
        targets: [{ expertId: expert.id, expectedRevision: expert.revision }],
      };
    const preview = await store.execute({ ...request, dryRun: true });
    expect(preview.bindingResults?.[0]).toMatchObject({
      status: "applied",
      addedSkillIds: [newSkill.skillId],
      skippedSkillIds: [existingSkill.skillId],
      newRevision: expert.revision + 1,
    });
    expect((await experts.read(expert.id))?.revision).toBe(expert.revision);
    const applied = await store.execute(request);
    expect(applied.bindingResults?.[0]?.status).toBe("applied");
    const saved = (await experts.read(expert.id))!;
    expect(saved.skillBindings).toEqual([
      { skillId: existingSkill.skillId, enabled: false, activation: "startup" },
      { skillId: newSkill.skillId, enabled: true, activation: "on-demand" },
    ]);
    const journalPath = path.join(stateDir, "experts", "skill-library-operations.json"),
      journal = JSON.parse(await fs.readFile(journalPath, "utf8")),
      operation = journal.requests.find(
        (entry: { requestId: string }) => entry.requestId === request.requestId,
      );
    delete operation.response;
    delete operation.bindingResults;
    await fs.writeFile(journalPath, JSON.stringify(journal));
    await store.dispose();
    const restarted = createSkillLibraryStore(stateDir);
    const replay = await restarted.execute(request);
    expect(replay.bindingResults).toEqual(applied.bindingResults);
    expect((await experts.read(expert.id))?.revision).toBe(saved.revision);
    await restarted.dispose();
  });

  it("replays a completed bind receipt after its Skill is later deleted without restoring the binding", async () => {
    const { store, stateDir } = await fixture(),
      skill = (await store.execute({ action: "create", name: "Replay", body, tags: [] })).skill!,
      experts = createExpertStore(stateDir),
      expert = await experts.save({
        name: "Replay target",
        description: "",
        useCases: "",
        persona: "Reviewer",
        outputRequirements: "",
        skills: [],
        references: [],
        connections: [],
        skillBindings: [],
      }),
      request = {
        action: "bindExperts" as const,
        requestId: "binding-replay-after-delete",
        skillIds: [skill.skillId],
        targets: [{ expertId: expert.id, expectedRevision: expert.revision }],
      };
    const applied = await store.execute(request);
    expect(applied.bindingResults?.[0]?.status).toBe("applied");
    await store.execute({
      action: "delete",
      requestId: "delete-after-binding-receipt",
      skillId: skill.skillId,
      expectedRevision: skill.revision,
      confirmExpertIds: [expert.id],
    });

    const replay = await store.execute(request);
    expect(replay.bindingResults).toEqual(applied.bindingResults);
    expect((await experts.read(expert.id))?.skillBindings).toEqual([]);
    expect((await store.execute({ action: "list" })).skills).toEqual([]);
  });

  it("dry-runs narrow binding edits, permits the same requestId for apply, and returns needs_conversion for legacy Experts", async () => {
    const { store, stateDir } = await fixture(),
      skill = (await store.execute({ action: "create", name: "Binding", body, tags: [] })).skill!,
      experts = createExpertStore(stateDir),
      current = await experts.save({
        name: "Modern",
        description: "",
        useCases: "",
        persona: "Expert",
        outputRequirements: "",
        skills: [],
        references: [],
        connections: [],
        skillBindings: [],
      });
    const request = {
      action: "bindings" as const,
      operation: "add" as const,
      expertId: current.id,
      expectedRevision: current.revision,
      requestId: "binding-add-dry-run",
      bindings: [{ skillId: skill.skillId, enabled: false, activation: "startup" as const }],
    };
    const preview = await store.execute({ ...request, dryRun: true });
    expect(preview.bindingResult?.status).toBe("applied");
    expect((await experts.read(current.id))?.revision).toBe(current.revision);
    const applied = await store.execute(request);
    expect(applied.bindingResult?.status).toBe("applied");
    expect((await experts.read(current.id))?.skillBindings).toEqual(request.bindings);

    const legacy = await experts.save({
      name: "Legacy",
      description: "",
      useCases: "",
      persona: "Expert",
      outputRequirements: "",
      skills: [{ name: "Old", path: "/old/SKILL.md" }],
      references: [],
      connections: [],
    });
    const result = await store.execute({
      action: "bindExperts",
      requestId: "legacy-conversion-plan",
      skillIds: [skill.skillId],
      targets: [{ expertId: legacy.id, expectedRevision: legacy.revision }],
      dryRun: true,
    });
    expect(result.bindingResults?.[0]?.status).toBe("needs_conversion");
    expect((await experts.read(legacy.id))?.skillBindings).toBeUndefined();
  });

  it("retries only failed Experts from a partially committed N×M binding request", async () => {
    const { store, stateDir } = await fixture(),
      skill = (await store.execute({ action: "create", name: "Retry target", body, tags: [] }))
        .skill!,
      experts = createExpertStore(stateDir),
      first = await experts.save({
        name: "First",
        description: "",
        useCases: "",
        persona: "Expert",
        outputRequirements: "",
        skills: [],
        references: [],
        connections: [],
        skillBindings: [],
      }),
      second = await experts.save({
        name: "Second",
        description: "",
        useCases: "",
        persona: "Expert",
        outputRequirements: "",
        skills: [],
        references: [],
        connections: [],
        skillBindings: [],
      });
    let checks = 0;
    const context = {
      beforeMutation: async () => {
        checks++;
        if (checks === 3) throw new Error("transient Expert write failure");
      },
    };
    const request = {
      action: "bindExperts" as const,
      requestId: "partial-expert-retry",
      skillIds: [skill.skillId],
      targets: [first, second].map((expert) => ({
        expertId: expert.id,
        expectedRevision: expert.revision,
      })),
    };
    const partial = await store.execute(request, context);
    expect(partial.bindingResults?.map((result) => result.status)).toEqual(["applied", "failed"]);
    expect((await experts.read(first.id))?.revision).toBe(first.revision + 1);
    expect((await experts.read(second.id))?.revision).toBe(second.revision);
    const retried = await store.execute(request, context);
    expect(retried.bindingResults?.map((result) => result.status)).toEqual(["applied", "applied"]);
    expect((await experts.read(first.id))?.revision).toBe(first.revision + 1);
    expect((await experts.read(second.id))?.revision).toBe(second.revision + 1);
  });

  it("requires a new preview and requestId after a binding CAS conflict", async () => {
    const { store, stateDir } = await fixture(),
      skill = (await store.execute({ action: "create", name: "CAS target", body, tags: [] }))
        .skill!,
      experts = createExpertStore(stateDir),
      expert = await experts.save({
        name: "CAS expert",
        description: "",
        useCases: "",
        persona: "Expert",
        outputRequirements: "",
        skills: [],
        references: [],
        connections: [],
        skillBindings: [],
      }),
      firstRequest = {
        action: "bindExperts" as const,
        requestId: "stale-binding-preview",
        skillIds: [skill.skillId],
        targets: [{ expertId: expert.id, expectedRevision: expert.revision }],
      };
    expect(
      (await store.execute({ ...firstRequest, dryRun: true })).bindingResults?.[0]?.status,
    ).toBe("applied");
    const changed = await experts.save({
      id: expert.id,
      expectedRevision: expert.revision,
      name: "CAS expert changed elsewhere",
      description: expert.description,
      useCases: expert.useCases,
      persona: expert.persona,
      outputRequirements: expert.outputRequirements,
      skills: expert.skills,
      references: expert.references,
      connections: expert.connections,
      skillBindings: expert.skillBindings,
    });
    expect((await store.execute(firstRequest)).bindingResults?.[0]?.status).toBe("conflict");

    const replanned = {
      ...firstRequest,
      requestId: "fresh-binding-preview",
      targets: [{ expertId: expert.id, expectedRevision: changed.revision }],
    };
    expect((await store.execute({ ...replanned, dryRun: true })).bindingResults?.[0]?.status).toBe(
      "applied",
    );
    expect((await store.execute(replanned)).bindingResults?.[0]?.status).toBe("applied");
    expect((await experts.read(expert.id))?.skillBindings).toEqual([
      { skillId: skill.skillId, enabled: true, activation: "on-demand" },
    ]);
  });

  it("updates only supported hosted sources, confirms local-edit overwrite and preserves Skill identity and Expert bindings", async () => {
    const { root, stateDir, store } = await fixture(),
      sourcePath = path.join(root, "hosted-seed");
    await fs.mkdir(sourcePath);
    await fs.writeFile(path.join(sourcePath, "SKILL.md"), body);
    const seedPreview = (
      await store.execute({ action: "previewImport", location: sourcePath, kind: "local" })
    ).preview!;
    const original = (
      await store.execute({
        action: "import",
        previewId: seedPreview.previewId,
        choices: [{ entryPath: "SKILL.md", duplicate: "skip" }],
      })
    ).skills![0]!;
    const edited = (
      await store.execute({
        action: "save",
        skillId: original.skillId,
        expectedRevision: original.revision,
        name: original.name,
        tags: ["preserve"],
        changes: [
          { path: "SKILL.md", content: Buffer.from(body + "Local edits.\n").toString("base64") },
        ],
      })
    ).skill!;
    const expert = await createExpertStore(stateDir).save({
      name: "Bound",
      description: "",
      useCases: "",
      persona: "Expert",
      outputRequirements: "",
      skills: [],
      references: [],
      connections: [],
      skillBindings: [{ skillId: original.skillId, enabled: false, activation: "startup" }],
    });
    const registry = path.join(stateDir, "experts", "skill-library.json"),
      registryData = JSON.parse(await fs.readFile(registry, "utf8")) as {
        schemaVersion: number;
        skills: Array<typeof edited>;
      };
    registryData.skills = registryData.skills.map((skill) =>
      skill.skillId === edited.skillId
        ? {
            ...skill,
            source: {
              ...skill.source,
              kind: "url" as const,
              location: "https://github.com/acme/skills/tree/main/alpha",
            },
          }
        : skill,
    );
    await fs.writeFile(registry, `${JSON.stringify(registryData, null, 2)}\n`);
    const sha = "b".repeat(40),
      hostedBody = "---\nname: alpha\ndescription: Hosted alpha\n---\nUpdated upstream.\n",
      archive = storedZip([{ name: `skills-${sha}/alpha/SKILL.md`, content: hostedBody }]),
      fetch = vi.fn(async (input: unknown) => {
        const url = new URL(String(input));
        if (
          url.hostname === "api.github.com" &&
          url.pathname.endsWith("/git/matching-refs/heads/main")
        )
          return Response.json([{ ref: "refs/heads/main" }]);
        if (
          url.hostname === "api.github.com" &&
          url.pathname.endsWith("/git/matching-refs/tags/main")
        )
          return Response.json([]);
        if (url.hostname === "api.github.com" && url.pathname.endsWith("/commits/main"))
          return Response.json({ sha });
        if (url.hostname === "codeload.github.com")
          return new Response(archive, { headers: { "content-length": String(archive.length) } });
        return new Response("unexpected request", { status: 500 });
      });
    vi.stubGlobal("fetch", fetch);
    const before = await store.execute({ action: "read", skillId: edited.skillId });
    expect(
      (
        await store.execute({
          action: "updateFromSource",
          skillId: edited.skillId,
          expectedRevision: edited.revision,
          requestId: "hosted-requires-overwrite-confirmation",
        })
      ).updateResult?.status,
    ).toBe("skipped");
    expect(fetch).not.toHaveBeenCalled();
    const dryRun = await store.execute({
      action: "updateFromSource",
      skillId: edited.skillId,
      expectedRevision: edited.revision,
      requestId: "hosted-update-after-confirmation",
      overwriteLocalEdits: true,
      dryRun: true,
    });
    expect(dryRun.updateResult).toMatchObject({
      status: "updated",
      preview: { overwritesLocalEdits: true },
    });
    expect((await store.execute({ action: "read", skillId: edited.skillId })).skill).toEqual(
      before.skill,
    );
    const updated = await store.execute({
      action: "updateFromSource",
      skillId: edited.skillId,
      expectedRevision: edited.revision,
      requestId: "hosted-update-after-confirmation",
      overwriteLocalEdits: true,
    });
    if (updated.updateResult?.status !== "updated")
      throw new Error(`Hosted update failed: ${updated.updateResult?.error ?? "no error detail"}`);
    expect(updated.updateResult).toMatchObject({
      status: "updated",
      revision: edited.revision + 1,
    });
    const saved = (await store.execute({ action: "read", skillId: edited.skillId })).skill!;
    expect(saved).toMatchObject({
      skillId: original.skillId,
      tags: ["preserve"],
      locallyModified: false,
      createdAt: original.createdAt,
      createdBy: original.createdBy,
      source: { resolvedRevision: sha },
    });
    expect((await createExpertStore(stateDir).read(expert.id))?.skillBindings).toEqual([
      { skillId: original.skillId, enabled: false, activation: "startup" },
    ]);
    const unchanged = await store.execute({
      action: "updateFromSource",
      skillId: edited.skillId,
      expectedRevision: saved.revision,
      requestId: "hosted-source-unchanged",
      overwriteLocalEdits: true,
    });
    expect(unchanged.updateResult?.status).toBe("unchanged");
  });

  it("keeps historical writes dry-run-only and replays a durable create receipt across store restart", async () => {
    const { store, stateDir } = await fixture();
    const preview = await store.execute({
      action: "create",
      name: "Idempotent",
      body,
      tags: [],
      requestId: "create-dry-run-then-apply",
      dryRun: true,
    });
    expect(preview.dryRun).toBe(true);
    expect((await store.execute({ action: "list" })).skills).toEqual([]);
    const request = {
      action: "create" as const,
      name: "Idempotent",
      body,
      tags: [],
      requestId: "create-dry-run-then-apply",
    };
    const created = (await store.execute(request, { actor: "management-client:test" })).skill!;
    await store.dispose();
    const restarted = createSkillLibraryStore(stateDir);
    const replay = (await restarted.execute(request, { actor: "management-client:test" })).skill!;
    expect(replay).toEqual(created);
    expect((await restarted.execute({ action: "list" })).skills).toHaveLength(1);
    await expect(
      restarted.execute(
        { ...request, body: `${body}\nchanged` },
        { actor: "management-client:test" },
      ),
    ).rejects.toThrow(/requestId/iu);
    await restarted.dispose();
  });

  it("dry-runs and replays save, import, batch tags and delete by requestId", async () => {
    const { root, store } = await fixture(),
      initial = (await store.execute({ action: "create", name: "Before", body, tags: [] })).skill!;
    const saveRequest = {
      action: "save" as const,
      skillId: initial.skillId,
      expectedRevision: initial.revision,
      requestId: "save-dry-run-replay",
      name: "After",
      tags: ["saved"],
      changes: [],
    };
    expect((await store.execute({ ...saveRequest, dryRun: true })).dryRun).toBe(true);
    expect((await store.execute({ action: "read", skillId: initial.skillId })).skill).toEqual(
      initial,
    );
    const saved = (await store.execute(saveRequest)).skill!;
    expect(await store.execute(saveRequest)).toEqual({
      skill: saved,
      requestId: saveRequest.requestId,
    });

    const source = path.join(root, "import-source");
    await fs.mkdir(source);
    await fs.writeFile(path.join(source, "SKILL.md"), body.replaceAll("alpha", "imported"));
    const preview = (
      await store.execute({ action: "previewImport", location: source, kind: "local" })
    ).preview!;
    const importRequest = {
      action: "import" as const,
      requestId: "import-dry-run-replay",
      previewId: preview.previewId,
      choices: [{ entryPath: "SKILL.md", duplicate: "skip" as const }],
    };
    expect((await store.execute({ ...importRequest, dryRun: true })).dryRun).toBe(true);
    expect((await store.execute({ action: "list" })).skills).toHaveLength(1);
    const imported = (await store.execute(importRequest)).skills!;
    expect(await store.execute(importRequest)).toEqual({
      skills: imported,
      requestId: importRequest.requestId,
    });

    const batchRequest = {
      action: "batch" as const,
      requestId: "batch-tags-dry-run-replay",
      items: [
        {
          skillId: saved.skillId,
          expectedRevision: saved.revision,
          operation: "tags" as const,
          tags: ["batched"],
        },
      ],
    };
    expect((await store.execute({ ...batchRequest, dryRun: true })).results?.[0]?.status).toBe(
      "would_change",
    );
    expect((await store.execute({ action: "read", skillId: saved.skillId })).skill?.tags).toEqual([
      "saved",
    ]);
    const batch = await store.execute(batchRequest);
    expect(batch.results?.[0]?.success).toBe(true);
    expect(await store.execute(batchRequest)).toEqual(batch);
    expect((await store.execute({ action: "read", skillId: saved.skillId })).skill?.revision).toBe(
      saved.revision + 1,
    );

    const deleteRequest = {
      action: "delete" as const,
      skillId: imported[0]!.skillId,
      expectedRevision: imported[0]!.revision,
      requestId: "delete-dry-run-replay",
      confirmExpertIds: [],
    };
    expect((await store.execute({ ...deleteRequest, dryRun: true })).plan?.status).toBe(
      "would_change",
    );
    expect(
      (await store.execute({ action: "read", skillId: imported[0]!.skillId })).skill?.deleted,
    ).toBe(false);
    await store.execute(deleteRequest);
    await store.execute(deleteRequest);
    expect((await store.execute({ action: "list" })).skills?.map((skill) => skill.skillId)).toEqual(
      [saved.skillId],
    );
  });

  it("recovers batch tags after the library head commits but before the item receipt", async () => {
    const { stateDir, store } = await fixture(),
      skill = (await store.execute({ action: "create", name: "alpha", body, tags: [] })).skill!,
      request = {
        action: "batch" as const,
        requestId: "batch-tags-crash-window",
        items: [
          {
            operation: "tags" as const,
            skillId: skill.skillId,
            expectedRevision: skill.revision,
            tags: ["committed"],
          },
        ],
      },
      write = storage.writePrivateFileAtomically;
    let headCommitted = false;
    const atomicWrite = vi
      .spyOn(storage, "writePrivateFileAtomically")
      .mockImplementation(async (target, bytes) => {
        if (target.endsWith("skill-library.json")) {
          const result = await write(target, bytes);
          headCommitted =
            JSON.parse(String(bytes)).skills.find(
              (item: { skillId: string }) => item.skillId === skill.skillId,
            )?.tags[0] === "committed";
          return result;
        }
        if (target.endsWith("skill-library-operations.json") && headCommitted)
          throw new Error("injected crash after batch mutation");
        return write(target, bytes);
      });
    await expect(store.execute(request)).rejects.toThrow("injected crash after batch mutation");
    const committed = (await store.execute({ action: "read", skillId: skill.skillId })).skill!;
    expect(committed).toMatchObject({ revision: skill.revision + 1, tags: ["committed"] });
    atomicWrite.mockRestore();
    await store.dispose();

    const restarted = createSkillLibraryStore(stateDir),
      recovered = await restarted.execute(request);
    expect(recovered.results?.[0]).toMatchObject({ success: true, skillId: skill.skillId });
    expect((await restarted.execute({ action: "read", skillId: skill.skillId })).skill).toEqual(
      committed,
    );
    expect(await restarted.execute(request)).toEqual(recovered);
    await restarted.dispose();
  });

  it("recovers a tombstone after deletion commits but before its response receipt", async () => {
    const { stateDir, store } = await fixture(),
      skill = (await store.execute({ action: "create", name: "alpha", body, tags: [] })).skill!,
      experts = createExpertStore(stateDir),
      expert = await experts.save({
        name: "Bound",
        description: "",
        useCases: "",
        persona: "Expert",
        outputRequirements: "",
        skills: [],
        references: [],
        connections: [],
        skillBindings: [{ skillId: skill.skillId, enabled: true, activation: "on-demand" }],
      }),
      request = {
        action: "delete" as const,
        requestId: "delete-tombstone-crash-window",
        skillId: skill.skillId,
        expectedRevision: skill.revision,
        confirmExpertIds: [expert.id],
      },
      write = storage.writePrivateFileAtomically;
    let tombstoneCommitted = false;
    const atomicWrite = vi
      .spyOn(storage, "writePrivateFileAtomically")
      .mockImplementation(async (target, bytes) => {
        if (target.endsWith("skill-library.json")) {
          const result = await write(target, bytes);
          tombstoneCommitted = JSON.parse(String(bytes)).skills.some(
            (item: { skillId: string; deleted: boolean }) =>
              item.skillId === skill.skillId && item.deleted,
          );
          return result;
        }
        if (target.endsWith("skill-library-operations.json") && tombstoneCommitted)
          throw new Error("injected crash after tombstone");
        return write(target, bytes);
      });
    await expect(store.execute(request)).rejects.toThrow("injected crash after tombstone");
    const savedExpert = (await experts.read(expert.id))!;
    expect(savedExpert).toMatchObject({ revision: expert.revision + 1, skillBindings: [] });
    atomicWrite.mockRestore();
    await store.dispose();

    const restarted = createSkillLibraryStore(stateDir);
    expect(await restarted.execute(request)).toEqual({ requestId: request.requestId });
    expect((await experts.read(expert.id))?.revision).toBe(savedExpert.revision);
    expect(
      await restarted.execute({ action: "read", skillId: skill.skillId }).catch(() => undefined),
    ).toBeUndefined();
    await restarted.dispose();
  });

  it("reconstructs create after package publication and library commit but before receipt", async () => {
    const { stateDir, store } = await fixture();
    const retained = (await store.execute({ action: "create", name: "retained", body, tags: [] }))
      .skill!;
    const request = {
      action: "create" as const,
      requestId: "create-package-head-receipt-crash",
      name: "beta",
      body: body.replace("alpha", "beta"),
      tags: ["crash-test"],
    };
    const write = storage.writePrivateFileAtomically;
    let headCommitted = false;
    const atomicWrite = vi
      .spyOn(storage, "writePrivateFileAtomically")
      .mockImplementation(async (target, bytes) => {
        if (target.endsWith("skill-library.json")) {
          const result = await write(target, bytes);
          headCommitted = JSON.parse(String(bytes)).skills.some(
            (item: { name: string; deleted: boolean }) => item.name === "beta" && !item.deleted,
          );
          return result;
        }
        if (target.endsWith("skill-library-operations.json") && headCommitted)
          throw new Error("injected crash after create head");
        return write(target, bytes);
      });
    await expect(store.execute(request)).rejects.toThrow("injected crash after create head");
    const committed = (await store.execute({ action: "list" })).skills!.find(
      (item) => item.name === "beta",
    )!;
    expect((await createSkillPackageStore(stateDir).read(committed.packageId)).packageId).toBe(
      committed.packageId,
    );
    atomicWrite.mockRestore();
    await store.dispose();

    const packageDirectory = path.join(stateDir, "experts", "skill-packages"),
      beforeReplay = (await fs.readdir(packageDirectory)).filter((name) =>
        /^pkg_[a-f0-9]{64}$/u.test(name),
      ),
      restarted = createSkillLibraryStore(stateDir),
      recovered = await restarted.execute(request);
    expect(recovered.skill).toEqual(committed);
    expect(await fs.readdir(packageDirectory)).toEqual(expect.arrayContaining(beforeReplay));
    expect(
      (await fs.readdir(packageDirectory)).filter((name) => /^pkg_[a-f0-9]{64}$/u.test(name)),
    ).toHaveLength(2);
    expect((await createSkillPackageStore(stateDir).read(retained.packageId)).packageId).toBe(
      retained.packageId,
    );
    await restarted.dispose();
  });

  it("imports 101 entries through the same successful dry-run and apply limits", async () => {
    const { root, store } = await fixture(),
      source = path.join(root, "many-skills");
    await fs.mkdir(source);
    for (let index = 0; index < 101; index++) {
      const directory = path.join(source, `entry-${index}`);
      await fs.mkdir(directory);
      await fs.writeFile(
        path.join(directory, "SKILL.md"),
        `---\nname: entry-${index}\ndescription: boundary fixture\n---\nInstructions.\n`,
      );
    }
    const preview = (
        await store.execute({ action: "previewImport", kind: "local", location: source })
      ).preview!,
      request = {
        action: "import" as const,
        requestId: "import-101-plan",
        previewId: preview.previewId,
        choices: preview.package.entries.map((entry) => ({
          entryPath: entry.entryPath,
          duplicate: "skip" as const,
        })),
      };
    expect(request.choices).toHaveLength(101);
    const dryRun = await store.execute({ ...request, dryRun: true });
    expect(dryRun.plans).toHaveLength(101);
    expect(dryRun.requestId).toBe(request.requestId);
    const applied = await store.execute(request);
    expect(applied.skills).toHaveLength(101);
    expect(applied.requestId).toBe(request.requestId);
    expect(await store.execute(request)).toEqual(applied);
    expect((await store.execute({ action: "list" })).skills).toHaveLength(101);
  });

  it("journals ID-less legacy writes, returns effective IDs, and leaves dry-run IDs unreserved", async () => {
    const { root, stateDir, store } = await fixture(),
      journalPath = path.join(stateDir, "experts", "skill-library-operations.json"),
      createRequest = { action: "create" as const, name: "legacy-create", body, tags: [] };
    const dryRun = await store.execute({ ...createRequest, dryRun: true });
    expect(dryRun.requestId).toEqual(expect.any(String));
    await expect(fs.readFile(journalPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    const created = await store.execute({ ...createRequest, requestId: dryRun.requestId });
    expect(created.requestId).toBe(dryRun.requestId);
    expect(await store.execute({ ...createRequest, requestId: dryRun.requestId })).toEqual(created);
    const directCreate = { ...createRequest, name: "legacy-create-without-dry-run" },
      directCreated = await store.execute(directCreate);
    expect(directCreated.requestId).toEqual(expect.any(String));
    expect(await store.execute({ ...directCreate, requestId: directCreated.requestId })).toEqual(
      directCreated,
    );

    const createdSkill = created.skill!;
    const saveRequest = {
      action: "save" as const,
      skillId: createdSkill.skillId,
      expectedRevision: createdSkill.revision,
      name: createdSkill.name,
      tags: ["legacy-save"],
      changes: [],
    };
    const saved = await store.execute(saveRequest);
    expect(saved.requestId).toEqual(expect.any(String));
    expect(await store.execute({ ...saveRequest, requestId: saved.requestId })).toEqual(saved);

    const importSource = path.join(root, "legacy-import");
    await fs.mkdir(importSource);
    await fs.writeFile(path.join(importSource, "SKILL.md"), body.replace("alpha", "legacy-import"));
    const importPreview = (
        await store.execute({ action: "previewImport", kind: "local", location: importSource })
      ).preview!,
      importRequest = {
        action: "import" as const,
        previewId: importPreview.previewId,
        choices: [{ entryPath: "SKILL.md", duplicate: "skip" as const }],
      },
      imported = await store.execute(importRequest);
    expect(imported.requestId).toEqual(expect.any(String));
    expect(await store.execute({ ...importRequest, requestId: imported.requestId })).toEqual(
      imported,
    );

    const batchRequest = {
      action: "batch" as const,
      items: [
        {
          skillId: createdSkill.skillId,
          expectedRevision: saved.skill!.revision,
          operation: "tags" as const,
          tags: ["legacy-batch"],
        },
      ],
    };
    const batch = await store.execute(batchRequest);
    expect(batch.requestId).toEqual(expect.any(String));
    expect(await store.execute({ ...batchRequest, requestId: batch.requestId })).toEqual(batch);

    const importedSkill = imported.skills![0]!,
      deleteRequest = {
        action: "delete" as const,
        skillId: importedSkill.skillId,
        expectedRevision: importedSkill.revision,
        confirmExpertIds: [],
      },
      deleted = await store.execute(deleteRequest);
    expect(deleted.requestId).toEqual(expect.any(String));
    expect(await store.execute({ ...deleteRequest, requestId: deleted.requestId })).toEqual(
      deleted,
    );
  });
});
