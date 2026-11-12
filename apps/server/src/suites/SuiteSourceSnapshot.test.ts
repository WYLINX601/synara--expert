import * as fs from "node:fs/promises";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSuiteSourceSnapshot } from "./SuiteSourceSnapshot";
import { expertResourceFiles } from "../experts/ExpertStore";
import { withSkillPackageLifecycle } from "../experts/skillPackageLifecycle";
import { skillZip } from "../experts/skillLibraryTestFixtures";

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const root of roots.splice(0)) await expertResourceFiles.removeStaging(root);
});

describe("local Suite snapshots", () => {
  it("reuses provenance through a state-directory alias without changing source identity or sealed bytes", async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), "suite-local-")));
    roots.push(root);
    const canonical = path.join(root, "canonical");
    const alias = path.join(root, "alias");
    await fs.mkdir(canonical);
    await fs.symlink(canonical, alias, process.platform === "win32" ? "junction" : "dir");
    const source = path.join(root, "source");
    const otherSource = path.join(root, "other-source");
    await fs.mkdir(source);
    await fs.mkdir(otherSource);
    await fs.writeFile(path.join(source, "author.md"), "Original identity");
    await fs.writeFile(path.join(otherSource, "author.md"), "Original identity");
    const owner = createSuiteSourceSnapshot(path.join(alias, "state"));
    const first = await owner.capture({ kind: "local-folder", path: source });
    const other = await owner.capture({ kind: "local-folder", path: otherSource });
    expect(other.source.sourceId).not.toBe(first.source.sourceId);
    expect(other.contentHash).toBe(first.contentHash);
    expect(await owner.capture({ kind: "local-folder", path: source })).toEqual(first);

    await fs.writeFile(path.join(source, "author.md"), "Independent identity");
    const changed = await owner.capture({ kind: "local-folder", path: source });
    expect(changed.source.sourceId).toBe(first.source.sourceId);
    expect(changed.contentHash).not.toBe(first.contentHash);
    expect(changed.source.contentHash).toBe(changed.contentHash);
    expect(await owner.capture({ kind: "local-folder", path: otherSource })).toEqual(other);
    expect(await fs.readFile(path.join(first.rootPath, "author.md"), "utf8")).toBe(
      "Original identity",
    );
    expect(await fs.readFile(path.join(other.rootPath, "author.md"), "utf8")).toBe(
      "Original identity",
    );
    expect(await fs.readFile(path.join(changed.rootPath, "author.md"), "utf8")).toBe(
      "Independent identity",
    );
    expect(JSON.stringify(changed.source)).not.toContain(root);
  });

  it("still rejects a linked source file after capturing safe provenance", async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), "suite-local-linked-")));
    roots.push(root);
    const source = path.join(root, "source");
    await fs.mkdir(source);
    await fs.writeFile(path.join(source, "author.md"), "Safe identity");
    const owner = createSuiteSourceSnapshot(path.join(root, "state"));
    const first = await owner.capture({ kind: "local-folder", path: source });
    const outside = path.join(root, "outside.md");
    await fs.writeFile(outside, "Not selected");
    await fs.symlink(outside, path.join(source, "linked.md"), "file");
    await expect(owner.capture({ kind: "local-folder", path: source })).rejects.toMatchObject({
      issue: { code: "unsafe_path", category: "security", effect: "deny-action" },
    });
    expect(await fs.readFile(path.join(first.rootPath, "author.md"), "utf8")).toBe("Safe identity");
  });

  it("rejects a symlinked provenance directory rather than following it", async () => {
    const root = await fs.realpath(
      await fs.mkdtemp(path.join(tmpdir(), "suite-local-provenance-")),
    );
    roots.push(root);
    const source = path.join(root, "source");
    const state = path.join(root, "state");
    const outside = path.join(root, "outside");
    await fs.mkdir(source);
    await fs.mkdir(path.join(state, "suites"), { recursive: true });
    await fs.mkdir(outside);
    await fs.writeFile(path.join(source, "author.md"), "Safe identity");
    await fs.symlink(
      outside,
      path.join(state, "suites", "source-provenance"),
      process.platform === "win32" ? "junction" : "dir",
    );
    const owner = createSuiteSourceSnapshot(state);
    await expect(owner.capture({ kind: "local-folder", path: source })).rejects.toMatchObject({
      issue: { code: "unsafe_path", category: "security", effect: "deny-action" },
    });
    expect(await fs.readdir(outside)).toEqual([]);
  });

  it("releases only the verified captured package and never the mutable source or a supplied outside root", async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), "suite-source-release-")));
    roots.push(root);
    const source = path.join(root, "source");
    const outside = path.join(root, "outside");
    const state = path.join(root, "state");
    await fs.mkdir(source);
    await fs.mkdir(outside);
    await fs.writeFile(path.join(source, "author.md"), "Original identity");
    await fs.writeFile(path.join(outside, "keep.txt"), "Unrelated bytes");
    const owner = createSuiteSourceSnapshot(state);
    const captured = await owner.capture({ kind: "local-folder", path: source });
    await expect(
      withSkillPackageLifecycle(state, () => owner.release(captured.contentHash, outside)),
    ).rejects.toMatchObject({ issue: { code: "resource_corrupt" } });
    expect(await fs.readFile(path.join(captured.rootPath, "author.md"), "utf8")).toBe(
      "Original identity",
    );
    await withSkillPackageLifecycle(state, () =>
      owner.release(captured.contentHash, captured.rootPath),
    );
    await expect(fs.lstat(captured.rootPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readFile(path.join(source, "author.md"), "utf8")).toBe("Original identity");
    expect(await fs.readFile(path.join(outside, "keep.txt"), "utf8")).toBe("Unrelated bytes");
    await withSkillPackageLifecycle(state, () =>
      owner.release(captured.contentHash, captured.rootPath),
    );
  });
});

describe("GitHub Suite snapshots", () => {
  it.each([
    { kind: "portable directory", mode: 0o755, suffix: "/", allowed: true },
    { kind: "Unix directory", mode: 0o40755, suffix: "/", allowed: true },
    { kind: "linked directory", mode: 0o120777, suffix: "/", allowed: false },
    { kind: "regular file", mode: 0o100644, suffix: "", allowed: false },
    { kind: "file mode on directory", mode: 0o100644, suffix: "/", allowed: false },
    { kind: "directory mode on file", mode: 0o40755, suffix: "", allowed: false },
    { kind: "special entry", mode: 0o20666, suffix: "/", allowed: false },
  ])("validates the selected public archive root as a $kind", async ({ mode, suffix, allowed }) => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), "suite-public-kind-")));
    roots.push(root);
    const commit = "a".repeat(40);
    const prefix = `repo-${commit}/suite`;
    const archive = skillZip([
      { name: `${prefix}${suffix}`, content: "", mode },
      { name: `${prefix}/rules.md`, content: "Keep the fixed public instructions." },
    ]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: URL | string) => {
        const url = new URL(input);
        if (url.hostname === "api.github.com") return Response.json({ sha: commit });
        if (url.hostname === "codeload.github.com") return new Response(new Uint8Array(archive));
        throw new Error("Unexpected network request");
      }),
    );
    const owner = createSuiteSourceSnapshot(path.join(root, "state"));
    const capture = owner.capture({
      kind: "github",
      url: `https://github.com/owner/repo/tree/${commit}/suite`,
    });
    if (allowed) {
      const snapshot = await capture;
      expect(await fs.readFile(path.join(snapshot.rootPath, "rules.md"), "utf8")).toBe(
        "Keep the fixed public instructions.",
      );
      expect(snapshot.source).toMatchObject({ resolvedCommit: commit, subdirectory: "suite" });
    } else
      await expect(capture).rejects.toMatchObject({
        issue: { code: "unsafe_path", category: "security", effect: "deny-action" },
      });
  });
  it("uses the existing-login bridge for an ambiguous 404 and seals its fixed bytes", async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), "suite-private-")));
    roots.push(root);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("unavailable", { status: 404 })),
    );
    const bridge = vi.fn(async () => ({
      resolvedCommit: "a".repeat(40),
      entries: [
        {
          path: "nested/empty",
          kind: "directory" as const,
          bytes: Buffer.alloc(0),
          executable: false,
        },
        {
          path: "nested/rules.md",
          kind: "file" as const,
          bytes: Buffer.from("private policy"),
          executable: true,
        },
      ],
    }));
    const owner = createSuiteSourceSnapshot(path.join(root, "state"), {
      readGitHubSnapshot: bridge,
    });
    const snapshot = await owner.capture({
      kind: "github",
      url: "https://github.com/Owner/Private/tree/main/suite",
    });
    expect(bridge).toHaveBeenCalledWith({
      repository: "owner/private",
      requestedRef: "main",
      subdirectory: "suite",
    });
    expect(snapshot.source).toMatchObject({
      kind: "github",
      repository: "owner/private",
      requestedRef: "main",
      subdirectory: "suite",
      resolvedCommit: "a".repeat(40),
      contentHash: snapshot.contentHash,
    });
    expect(await fs.readFile(path.join(snapshot.rootPath, "nested", "rules.md"), "utf8")).toBe(
      "private policy",
    );
    expect(await fs.stat(path.join(snapshot.rootPath, "nested", "empty"))).toMatchObject({
      size: expect.any(Number),
    });
    expect(JSON.stringify(snapshot.source)).not.toContain(root);
  });

  it("rejects bridge path collisions before publishing and keeps authorization failures concrete", async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), "suite-private-bad-")));
    roots.push(root);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("unavailable", { status: 404 })),
    );
    const owner = createSuiteSourceSnapshot(path.join(root, "state"), {
      readGitHubSnapshot: async () => ({
        resolvedCommit: "a".repeat(40),
        entries: [
          { path: "A", kind: "file", bytes: Buffer.from("one"), executable: false },
          { path: "a", kind: "file", bytes: Buffer.from("two"), executable: false },
        ],
      }),
    });
    await expect(
      owner.capture({ kind: "github", url: "https://github.com/owner/private" }),
    ).rejects.toMatchObject({
      issue: { code: "unsafe_path", category: "security", effect: "deny-action" },
    });
    await expect(
      createSuiteSourceSnapshot(path.join(root, "other-state")).capture({
        kind: "github",
        url: "https://github.com/owner/private",
      }),
    ).rejects.toMatchObject({ issue: { code: "source_auth_required", recovery: "authorize" } });
  });

  it("rejects unsafe URL origins before making a request", async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), "suite-url-")));
    roots.push(root);
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const owner = createSuiteSourceSnapshot(path.join(root, "state"));
    for (const url of [
      "https://user:secret@github.com/owner/repo",
      "https://example.com/owner/repo",
      "https://github.com/owner/repo?token=secret",
      "https://github.com/owner/repo/blob/main/file.md",
    ])
      await expect(owner.capture({ kind: "github", url })).rejects.toHaveProperty(
        "issue.effect",
        "deny-action",
      );
    expect(fetch).not.toHaveBeenCalled();
  });
});
