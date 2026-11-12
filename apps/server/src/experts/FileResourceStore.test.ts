import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  createFileResourceStore,
  inspectFileResourceRoot,
  artifactFileResourceManifest,
  validateFileResourceManifest,
  compareResourcePaths,
  type FileResourceEntry,
} from "./FileResourceStore";
import { expertResourceFiles } from "./ExpertStore";
import { suiteContentDigest } from "../suites/suiteIdentity";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await expertResourceFiles.removeStaging(root);
});
const emptyHash = createHash("sha256").digest("hex");

describe("F-4 immutable file resources", () => {
  it("seals a real no-SKILL package with parents, empty directories and any execute bit", async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), "suite-files-")));
    roots.push(root);
    const source = path.join(root, "source");
    await fs.mkdir(path.join(source, "nested", "empty"), { recursive: true });
    await fs.writeFile(path.join(source, "nested", "rules.md"), "real instructions", {
      mode: 0o610,
    });
    const store = createFileResourceStore(path.join(root, "state"));
    const sealed = await store.seal(source);
    expect(sealed.packageId).toBe(
      `res_${suiteContentDigest({ schemaVersion: 1, resources: sealed.resources })}`,
    );
    expect(sealed.resources.map((entry) => entry.path)).toEqual([
      "nested",
      "nested/empty",
      "nested/rules.md",
    ]);
    expect(sealed.resources.find((entry) => entry.path === "nested/rules.md")?.executable).toBe(
      process.platform !== "win32",
    );
    expect(sealed.resources.find((entry) => entry.path === "nested/empty")).toEqual({
      path: "nested/empty",
      kind: "directory",
      size: 0,
      sha256: emptyHash,
      executable: false,
    });
    expect(await fs.readFile(path.join(sealed.rootPath, "nested", "rules.md"), "utf8")).toBe(
      "real instructions",
    );
    await fs.writeFile(path.join(source, "nested", "rules.md"), "changed external input");
    expect((await store.read(sealed.packageId)).resources).toEqual(sealed.resources);
  });

  it("uses UTF-8 byte ordering rather than locale or UTF-16 ordering", () => {
    expect(["\u{10000}", "\ue000", "Z", "a"].sort(compareResourcePaths)).toEqual([
      "Z",
      "a",
      "\ue000",
      "\u{10000}",
    ]);
  });

  it("preserves verified archive execute metadata without trusting it for file bytes", async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), "suite-archive-mode-")));
    roots.push(root);
    const source = path.join(root, "source");
    await fs.mkdir(source);
    const bytes = Buffer.from("fixed archive bytes");
    await fs.writeFile(path.join(source, "tool.py"), bytes, { mode: 0o700 });
    const resources: FileResourceEntry[] = [
      {
        path: "tool.py",
        kind: "file",
        size: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        executable: true,
      },
    ];
    const store = createFileResourceStore(path.join(root, "state"));
    const sealed = await store.seal(source, resources);
    expect((await store.read(sealed.packageId)).resources[0]?.executable).toBe(true);
    await fs.writeFile(path.join(source, "tool.py"), "different bytes");
    await expect(store.seal(source, resources)).rejects.toThrow(/metadata does not match/u);
  });

  it("rejects decomposed names, case collisions, absent parents and file parents", () => {
    const file = (relative: string): FileResourceEntry => ({
      path: relative,
      kind: "file",
      size: 0,
      sha256: emptyHash,
      executable: false,
    });
    expect(() => validateFileResourceManifest([file("e\u0301.md")])).toThrow(/NFC/u);
    expect(() => validateFileResourceManifest([file("A"), file("a")])).toThrow(/collid/u);
    expect(() => validateFileResourceManifest([file("a/b")])).toThrow(/parent/u);
    expect(() => validateFileResourceManifest([file("a"), file("a/b")])).toThrow(/parent/u);
    expect(() => validateFileResourceManifest([file("../escape")])).toThrow(/Unsafe/u);
    expect(() =>
      validateFileResourceManifest(Array.from({ length: 5001 }, (_, index) => file(String(index)))),
    ).toThrow(/budget/u);
    expect(() =>
      validateFileResourceManifest([{ ...file("big"), size: 16 * 1024 * 1024 + 1 }]),
    ).toThrow(/metadata/u);
    expect(() =>
      validateFileResourceManifest(
        Array.from({ length: 7 }, (_, index) => ({
          ...file(String(index)),
          size: 16 * 1024 * 1024,
        })),
      ),
    ).toThrow(/byte budget/u);
  });

  it.skipIf(process.platform === "win32")(
    "rejects inner symlinks without following them",
    async () => {
      const root = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), "suite-links-")));
      roots.push(root);
      const source = path.join(root, "source");
      await fs.mkdir(source);
      await fs.writeFile(path.join(root, "outside"), "not a resource");
      await fs.symlink(path.join(root, "outside"), path.join(source, "link"));
      await expect(createFileResourceStore(path.join(root, "state")).seal(source)).rejects.toThrow(
        /links/u,
      );
    },
  );

  it("captures only declared verified byte versions with nonexecutable copies", async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), "artifact-files-")));
    roots.push(root);
    const source = path.join(root, "source");
    await fs.mkdir(path.join(source, "nested"), { recursive: true });
    const bytes = Buffer.from("export const answer = 42;\n");
    await fs.writeFile(path.join(source, "nested", "result.ts"), bytes, { mode: 0o700 });
    await fs.writeFile(path.join(source, "unselected-secret"), "must not be copied");
    const declared = [
      {
        path: "nested/result.ts",
        sha256: createHash("sha256").update(bytes).digest("hex"),
        size: bytes.length,
      },
    ];
    const store = createFileResourceStore(path.join(root, "state"));
    const sealed = await store.sealFiles(source, declared);
    expect(sealed.resources).toEqual(artifactFileResourceManifest(declared));
    expect(sealed.fileCount).toBe(1);
    expect(sealed.resources.every((entry) => !entry.executable)).toBe(true);
    await expect(fs.access(path.join(sealed.rootPath, "unselected-secret"))).rejects.toThrow();
    await fs.writeFile(path.join(source, "nested", "result.ts"), "source changed");
    const historical = await store.read(sealed.packageId);
    expect(await fs.readFile(path.join(historical.rootPath, "nested", "result.ts"))).toEqual(bytes);
    await expect(store.sealFiles(source, declared)).rejects.toThrow();
  });

  it("rejects declared metadata, traversal, collisions and limits before publishing", async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), "artifact-reject-")));
    roots.push(root);
    await fs.writeFile(path.join(root, "file"), "ok");
    const store = createFileResourceStore(path.join(root, "state"));
    const file = { path: "file", sha256: createHash("sha256").update("ok").digest("hex"), size: 2 };
    for (const files of [
      [{ ...file, sha256: emptyHash }],
      [{ ...file, size: 1 }],
      [{ ...file, path: "../escape" }],
      [{ ...file, path: "e\u0301" }],
      [file, file],
      [file, { ...file, path: "FILE" }],
      [{ ...file, size: 16 * 1024 * 1024 + 1 }],
      Array(101).fill(file),
      Array.from({ length: 7 }, (_, i) => ({ ...file, path: `f${i}`, size: 16 * 1024 * 1024 })),
    ])
      await expect(store.sealFiles(root, files)).rejects.toThrow();
  });

  it.skipIf(process.platform === "win32")(
    "allows ancestor aliases but rejects selected/root/content symlinks",
    async () => {
      const root = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), "artifact-alias-")));
      roots.push(root);
      const source = path.join(root, "source");
      await fs.mkdir(source);
      await fs.writeFile(path.join(source, "file"), "ok");
      const alias = path.join(root, "alias");
      await fs.symlink(root, alias);
      const store = createFileResourceStore(path.join(alias, "state"));
      const declared = [
        { path: "file", sha256: createHash("sha256").update("ok").digest("hex"), size: 2 },
      ];
      const sealed = await store.sealFiles(path.join(alias, "source"), declared);
      expect(await inspectFileResourceRoot(path.join(alias, "source"))).toEqual({
        rootPath: source,
        contentHash: suiteContentDigest({
          schemaVersion: 1,
          resources: (await store.seal(source)).resources,
        }),
      });
      await fs.symlink(source, path.join(root, "root-link"));
      await expect(inspectFileResourceRoot(path.join(root, "root-link"))).rejects.toThrow();
      await fs.symlink(path.join(source, "file"), path.join(source, "link"));
      await expect(store.sealFiles(source, [{ ...declared[0]!, path: "link" }])).rejects.toThrow();
      await expect(inspectFileResourceRoot(source)).rejects.toThrow();
      await fs.symlink(source, path.join(source, "inner"));
      await expect(
        store.sealFiles(source, [{ ...declared[0]!, path: "inner/file" }]),
      ).rejects.toThrow();
      const packageRoot = path.dirname(sealed.rootPath);
      await fs.chmod(packageRoot, 0o700);
      await fs.chmod(sealed.rootPath, 0o700);
      await fs.rename(sealed.rootPath, path.join(packageRoot, "original-content"));
      await fs.symlink(path.join(packageRoot, "original-content"), sealed.rootPath);
      await expect(store.read(sealed.packageId)).rejects.toThrow();
    },
  );
});
