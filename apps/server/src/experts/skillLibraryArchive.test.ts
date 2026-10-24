import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSkillLibraryStore } from "./SkillLibraryStore";
import { expertResourceFiles } from "./ExpertStore";
import {
  downloadSkillSource,
  extractSkillArchive,
  fetchSkillSource,
  normalizeSkillSourceUrl,
  SKILL_FILE_LIMIT,
} from "./skillLibraryArchive";

import { skillZip } from "./skillLibraryTestFixtures";

const roots: string[] = [];
async function temporary() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "skill-source-test-"));
  roots.push(directory);
  return directory;
}
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const root of roots.splice(0)) await expertResourceFiles.removeStaging(root);
});
const skillBody = (name: string) =>
  `---\nname: ${name}\ndescription: Test skill\n---\nInstructions\n`;
const commit = "a".repeat(40);
function githubStub(
  files: ReadonlyArray<{ name: string; content: string }>,
  refs = [{ ref: "refs/heads/main" }],
) {
  return vi.stubGlobal(
    "fetch",
    vi.fn(async (input: URL | string) => {
      const url = new URL(input);
      if (url.pathname.includes("/matching-refs/heads/")) return Response.json(refs);
      if (url.pathname.includes("/matching-refs/tags/")) return Response.json([]);
      if (url.pathname.includes("/commits/")) return Response.json({ sha: commit });
      if (url.hostname === "codeload.github.com")
        return new Response(new Uint8Array(skillZip(files)));
      throw new Error("Unexpected network request");
    }),
  );
}

describe("Skill archive boundary", () => {
  it.each(["local", "hosted"] as const)(
    "deduplicates identical %s archives across import and unchanged refresh",
    async (source) => {
      const root = await temporary(),
        stateDir = path.join(root, "state"),
        store = createSkillLibraryStore(stateDir);
      const archive = skillZip([
        { name: "SKILL.md", content: skillBody("alpha") },
        { name: "assets/data.bin", content: Buffer.from([0, 255, 128, 42]) },
      ]);
      const location =
        source === "local" ? path.join(root, "alpha.zip") : "https://clawhub.ai/owner/skills/alpha";
      if (source === "local") await fs.writeFile(location, archive);
      else
        vi.stubGlobal(
          "fetch",
          vi.fn(async (input: URL | string) =>
            new URL(input).pathname.includes("/api/v1/skills/")
              ? Response.json({ owner: { handle: "owner" }, latestVersion: { version: "1.2.3" } })
              : new Response(new Uint8Array(archive)),
          ),
        );
      const preview = async () =>
        (
          await store.execute({
            action: "previewImport",
            location,
            kind: source === "local" ? "local" : "url",
          })
        ).preview!;
      const initial = await preview();
      const first = (
        await store.execute({
          action: "import",
          previewId: initial.previewId,
          choices: [{ entryPath: "SKILL.md", duplicate: "skip" }],
        })
      ).skills![0]!;
      const repeated = await preview();
      expect(repeated.package.packageId).toBe(first.packageId);
      expect(repeated.package.rootName).toBe("package");
      const replacement = (
        await store.execute({
          action: "import",
          previewId: repeated.previewId,
          choices: [
            {
              entryPath: "SKILL.md",
              duplicate: "replace",
              replaceSkillId: first.skillId,
              expectedRevision: first.revision,
            },
          ],
        })
      ).skills![0]!;
      const refreshed = (
        await store.execute({
          action: "previewRefresh",
          skillId: replacement.skillId,
          expectedRevision: replacement.revision,
        })
      ).preview!;
      expect(refreshed.package.packageId).toBe(first.packageId);
      expect(refreshed.resourceChanges).toEqual([]);
      const current = (
        await store.execute({
          action: "refresh",
          skillId: replacement.skillId,
          expectedRevision: replacement.revision,
          previewId: refreshed.previewId,
        })
      ).skill!;
      expect(current.packageId).toBe(first.packageId);
      expect(current.source.packageId).toBe(first.packageId);
      expect(
        (
          await store.execute({
            action: "readFile",
            skillId: first.skillId,
            path: "assets/data.bin",
          })
        ).file?.content,
      ).toBe(Buffer.from([0, 255, 128, 42]).toString("base64"));
      expect(await fs.readdir(path.join(stateDir, "experts", "skill-packages"))).toEqual([
        first.packageId,
      ]);
      expect(await fs.readdir(path.join(stateDir, "experts", "skill-library-staging"))).toEqual([]);
    },
  );
  it("preserves binary bytes and executable bits", async () => {
    const root = await temporary(),
      binary = Buffer.from([0, 255, 128, 42]);
    await extractSkillArchive(
      skillZip([
        { name: "SKILL.md", content: skillBody("alpha") },
        { name: "assets/data.bin", content: binary },
        { name: "scripts/test.sh", content: "exit 0\n", mode: 0o100755 },
      ]),
      root,
    );
    expect(await fs.readFile(path.join(root, "assets/data.bin"))).toEqual(binary);
    expect((await fs.stat(path.join(root, "scripts/test.sh"))).mode & 0o111).not.toBe(0);
  });
  it.each(["../escape", "/absolute", "a/../escape", "C:/escape", "a\\escape", "con.txt"])(
    "rejects unsafe path %s before extraction",
    async (name) => {
      const root = await temporary();
      await expect(
        extractSkillArchive(
          skillZip([
            { name: "good.txt", content: "valid" },
            { name, content: "bad" },
          ]),
          root,
        ),
      ).rejects.toThrow();
      expect(await fs.readdir(root)).toEqual([]);
    },
  );
  it("rejects links, path collisions, CRC corruption and expansion bombs without partial files", async () => {
    const root = await temporary();
    await expect(
      extractSkillArchive(skillZip([{ name: "link", content: "/outside", mode: 0o120777 }]), root),
    ).rejects.toThrow(/linked/iu);
    await expect(
      extractSkillArchive(
        skillZip([
          { name: "A", content: "one" },
          { name: "a", content: "two" },
        ]),
        root,
      ),
    ).rejects.toThrow(/colliding/iu);
    const corrupt = skillZip([{ name: "SKILL.md", content: skillBody("alpha") }]);
    const central = corrupt.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    corrupt.writeUInt32LE(0, central + 16);
    await expect(extractSkillArchive(corrupt, root)).rejects.toThrow(/mismatch/iu);
    const bomb = skillZip([{ name: "large", content: "x" }]);
    bomb.writeUInt32LE(
      SKILL_FILE_LIMIT + 1,
      bomb.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])) + 24,
    );
    await expect(extractSkillArchive(bomb, root)).rejects.toThrow(/oversized/iu);
    expect(await fs.readdir(root)).toEqual([]);
  });
  it("cancels owned upload staging without publishing a library or source", async () => {
    const stateDir = await temporary(),
      store = createSkillLibraryStore(stateDir);
    const preview = (
      await store.previewArchive(
        skillZip([{ name: "SKILL.md", content: skillBody("alpha") }]),
        "test.skill",
      )
    ).preview!;
    await store.execute({ action: "cancel", previewId: preview.previewId });
    expect(await fs.readdir(path.join(stateDir, "experts/skill-library-staging"))).toEqual([]);
    expect((await store.execute({ action: "list" })).skills).toEqual([]);
    await expect(
      store.execute({
        action: "import",
        previewId: preview.previewId,
        choices: [{ entryPath: "SKILL.md", duplicate: "skip" }],
      }),
    ).rejects.toThrow(/expired/iu);
    for (let index = 0; index < 101; index++) {
      const pending = (
        await store.previewArchive(
          skillZip([{ name: "SKILL.md", content: skillBody("alpha") }]),
          "cancelled.skill",
        )
      ).preview!;
      await store.execute({ action: "cancel", previewId: pending.previewId });
    }
    expect(await fs.readdir(path.join(stateDir, "experts/skill-library-staging"))).toEqual([]);
  });
});

describe("supported public Skill sources", () => {
  it("resolves an exact Skills.sh slug and records its actual GitHub commit", async () => {
    githubStub([
      { name: `repo-${commit}/skills/alpha/SKILL.md`, content: skillBody("alpha") },
      { name: `repo-${commit}/skills/beta/SKILL.md`, content: skillBody("beta") },
    ]);
    const stateDir = await temporary(),
      store = createSkillLibraryStore(stateDir);
    const preview = (
      await store.execute({
        action: "previewImport",
        kind: "url",
        location: "https://skills.sh/owner/repo/alpha",
      })
    ).preview!;
    expect(preview.selectedEntryPaths).toEqual(["SKILL.md"]);
    expect(preview.source.resolvedRevision).toBe(commit);
    await expect(
      store.execute({
        action: "import",
        previewId: preview.previewId,
        choices: [{ entryPath: "skills/beta/SKILL.md", duplicate: "skip" }],
      }),
    ).rejects.toThrow(/source URL/iu);
    const imported = (
      await store.execute({
        action: "import",
        previewId: preview.previewId,
        choices: [{ entryPath: "SKILL.md", duplicate: "skip" }],
      })
    ).skills!;
    expect(imported).toHaveLength(1);
    expect(imported[0]!.source.location).toBe("https://skills.sh/owner/repo/alpha");
  });
  it("blocks missing and ambiguous Skills.sh entries and cleans owned staging", async () => {
    githubStub([
      { name: `repo-${commit}/one/SKILL.md`, content: skillBody("alpha") },
      { name: `repo-${commit}/two/SKILL.md`, content: skillBody("alpha") },
    ]);
    const stateDir = await temporary(),
      store = createSkillLibraryStore(stateDir);
    for (const slug of ["missing", "alpha"])
      await expect(
        store.execute({
          action: "previewImport",
          kind: "url",
          location: `https://skills.sh/owner/repo/${slug}`,
        }),
      ).rejects.toThrow(/disappeared or is ambiguous/iu);
    expect(await fs.readdir(path.join(stateDir, "experts/skill-library-staging"))).toEqual([]);
  });
  it("uses the unique Skills.sh directory as the boundary and rejects links inside it", async () => {
    const root = await temporary(),
      archiveFiles = [
        { name: `repo-${commit}/skills/alpha/SKILL.md`, content: skillBody("alpha") },
        { name: `repo-${commit}/skills/alpha/assets/data.bin`, content: Buffer.from([0, 255]) },
        { name: `repo-${commit}/unrelated/link`, content: "/outside", mode: 0o120777 },
      ];
    const network = vi.fn(async (input: URL | string) =>
      new URL(input).hostname === "codeload.github.com"
        ? new Response(new Uint8Array(skillZip(archiveFiles)))
        : Response.json({ sha: commit }),
    );
    vi.stubGlobal("fetch", network);
    const result = await downloadSkillSource("https://skills.sh/owner/repo/alpha", root);
    expect(result.root).toBe(path.join(root, `repo-${commit}/skills/alpha`));
    expect(await fs.readFile(path.join(result.root, "assets/data.bin"))).toEqual(
      Buffer.from([0, 255]),
    );
    await expect(fs.stat(path.join(root, `repo-${commit}/unrelated`))).rejects.toThrow();
    archiveFiles.push({
      name: `repo-${commit}/skills/alpha/target-link`,
      content: "/outside",
      mode: 0o120777,
    });
    await expect(
      downloadSkillSource("https://skills.sh/owner/repo/alpha", await temporary()),
    ).rejects.toThrow(/linked/iu);
    archiveFiles.splice(
      0,
      archiveFiles.length,
      { name: `repo-${commit}/SKILL.md`, content: skillBody("root-skill") },
      { name: `repo-${commit}/unsafe-link`, content: "/outside", mode: 0o120777 },
    );
    await expect(
      downloadSkillSource("https://skills.sh/owner/repo/root-skill", await temporary()),
    ).rejects.toThrow(/linked/iu);
  });
  it("preserves a publisher-qualified ClawHub GitHub handoff and rejects ambiguous unqualified slugs", async () => {
    const requests: URL[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: URL | string) => {
        const url = new URL(input);
        requests.push(url);
        if (url.hostname === "clawhub.ai") {
          if (!url.searchParams.has("ownerHandle"))
            return Response.json({ code: "AMBIGUOUS_SKILL_SLUG" }, { status: 409 });
          if (url.pathname.includes("/api/v1/skills/"))
            return Response.json({
              owner: { handle: "owner" },
              latestVersion: { version: "1.0.1" },
            });
          return Response.json({
            sourceRef: "public-github",
            repo: "owner/repo",
            commit,
            path: "skills/alpha",
          });
        }
        if (url.hostname === "api.github.com") return Response.json({ sha: commit });
        return new Response(
          new Uint8Array(
            skillZip([
              { name: `repo-${commit}/skills/alpha/SKILL.md`, content: skillBody("alpha") },
            ]),
          ),
        );
      }),
    );
    const result = await downloadSkillSource(
      "https://clawhub.ai/owner/skills/alpha",
      await temporary(),
    );
    expect(result.resolvedRevision).toBe(commit);
    expect(result.canonicalLocation).toBe("https://clawhub.ai/owner/skills/alpha");
    expect(
      requests
        .filter((url) => url.hostname === "clawhub.ai")
        .every((url) => url.searchParams.get("ownerHandle") === "owner"),
    ).toBe(true);
    await expect(
      downloadSkillSource("https://clawhub.ai/alpha", await temporary()),
    ).rejects.toThrow(/HTTP 409/u);
  });
  it("supports unambiguous slash refs and rejects ambiguous ref/path interpretations", async () => {
    const root = await temporary();
    githubStub(
      [{ name: `repo-${commit}/skills/a/SKILL.md`, content: skillBody("alpha") }],
      [{ ref: "refs/heads/feature/skills" }],
    );
    const result = await downloadSkillSource(
      "https://github.com/owner/repo/blob/feature/skills/skills/a/SKILL.md",
      root,
    );
    expect(result.root).toBe(path.join(root, `repo-${commit}/skills/a`));
    expect(result.resolvedRevision).toBe(commit);
    vi.unstubAllGlobals();
    githubStub([], [{ ref: "refs/heads/feature" }, { ref: "refs/heads/feature/skills" }]);
    await expect(
      downloadSkillSource(
        "https://github.com/owner/repo/tree/feature/skills/skills/a",
        await temporary(),
      ),
    ).rejects.toThrow(/ambiguous/iu);
  });
  it("rejects credentials and sensitive queries without sending or persisting them", async () => {
    const network = vi.fn();
    vi.stubGlobal("fetch", network);
    for (const value of [
      "https://user:secret@github.com/owner/repo",
      "https://github.com/owner/repo?access_token=secret",
      "http://127.0.0.1/private",
      "https://github.com.evil.invalid/owner/repo",
    ])
      expect(() => normalizeSkillSourceUrl(value)).toThrow(/public HTTPS/iu);
    expect(network).not.toHaveBeenCalled();
    expect(normalizeSkillSourceUrl("https://github.com/owner/repo/#readme")).toBe(
      "https://github.com/owner/repo",
    );
  });
  it("cancels an in-flight source request and removes its owned staging", async () => {
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_input: URL | string, options: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            entered();
            options.signal!.addEventListener(
              "abort",
              () => reject(new Error("Cancelled by caller")),
              { once: true },
            );
          }),
      ),
    );
    const stateDir = await temporary(),
      store = createSkillLibraryStore(stateDir);
    const pending = store.execute({
      action: "previewImport",
      kind: "url",
      location: "https://github.com/owner/repo",
      requestId: "cancel-inflight",
    });
    const rejected = expect(pending).rejects.toThrow(/cancelled/iu);
    await started;
    await store.execute({ action: "cancel", previewId: "cancel-inflight" });
    await rejected;
    expect(await fs.readdir(path.join(stateDir, "experts/skill-library-staging"))).toEqual([]);
    expect((await store.execute({ action: "list" })).skills).toEqual([]);
  });
  it("pins ClawHub hosted archives to a returned version and validates the publisher", async () => {
    const archive = skillZip([{ name: "SKILL.md", content: skillBody("alpha") }]);
    const network = vi.fn(async (input: URL | string) => {
      const url = new URL(input);
      return url.pathname.includes("/api/v1/skills/")
        ? Response.json({ owner: { handle: "owner" }, latestVersion: { version: "1.2.3" } })
        : new Response(new Uint8Array(archive));
    });
    vi.stubGlobal("fetch", network);
    const root = await temporary(),
      result = await downloadSkillSource("https://clawhub.ai/owner/alpha", root);
    expect(result.resolvedRevision).toBe("1.2.3");
    expect(result.canonicalLocation).toBe("https://clawhub.ai/owner/skills/alpha");
    expect(await fs.readFile(path.join(result.root, "SKILL.md"), "utf8")).toBe(skillBody("alpha"));
    expect(new URL(network.mock.calls[1]![0]).searchParams.get("version")).toBe("1.2.3");
    expect(
      network.mock.calls.every(
        ([input]) => new URL(input).searchParams.get("ownerHandle") === "owner",
      ),
    ).toBe(true);
    await expect(
      downloadSkillSource("https://clawhub.ai/impostor/alpha", await temporary()),
    ).rejects.toThrow(/publisher/iu);
  });
  it("extracts only a selected GitHub directory while retaining its complete resources", async () => {
    const root = await temporary();
    await extractSkillArchive(
      skillZip([
        { name: "repo/skills/alpha/SKILL.md", content: skillBody("alpha") },
        { name: "repo/skills/alpha/assets/data.bin", content: Buffer.from([0, 255]) },
        { name: "repo/unselected/link", content: "/outside", mode: 0o120777 },
      ]),
      root,
      "repo/skills/alpha/",
    );
    expect(await fs.readFile(path.join(root, "repo/skills/alpha/assets/data.bin"))).toEqual(
      Buffer.from([0, 255]),
    );
    await expect(fs.stat(path.join(root, "repo/unselected"))).rejects.toThrow();
  });
  it("refuses unsafe remote redirects and bounded download overflow", async () => {
    const network = vi.fn(
      async () =>
        new Response(null, { status: 302, headers: { location: "http://127.0.0.1/private" } }),
    );
    vi.stubGlobal("fetch", network);
    await expect(fetchSkillSource("https://github.com/owner/repo")).rejects.toThrow(/unsafe/iu);
    expect(network).toHaveBeenCalledTimes(1);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("too large")),
    );
    await expect(fetchSkillSource("https://github.com/owner/repo", 2)).rejects.toThrow(
      /size limit/iu,
    );
  });
});
