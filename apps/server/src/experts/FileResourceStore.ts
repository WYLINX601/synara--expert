import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import { ensurePrivateDirectorySync, syncDirectoryEntry } from "../privatePathPermissions";
import { canonicalSuiteJson, suiteContentDigest } from "../suites/suiteIdentity";
import { expertResourceFiles, type CollectedExpertResource } from "./ExpertStore";
import {
  assertSkillResourcePath,
  SKILL_FILE_LIMIT,
  SKILL_PACKAGE_LIMIT,
} from "./skillLibraryArchive";

export interface FileResourceEntry {
  readonly path: string;
  readonly kind: "file" | "directory";
  readonly size: number;
  readonly sha256: string;
  readonly executable: boolean;
}
export interface SealedFileResources {
  readonly packageId: string;
  readonly rootPath: string;
  readonly resources: ReadonlyArray<FileResourceEntry>;
  readonly fileCount: number;
  readonly totalBytes: number;
}
export interface FileResourceStore {
  /** archiveManifest is server-only verified archive metadata, never client input.
   * It preserves recorded execute bits on Windows; actual paths and bytes are still recollected. */
  seal(
    root: string,
    archiveManifest?: ReadonlyArray<FileResourceEntry>,
  ): Promise<SealedFileResources>;
  read(packageId: string): Promise<SealedFileResources>;
  /** Capture only declared files, verifying their bytes in the authorized root first. */
  sealFiles(root: string, files: ReadonlyArray<DeclaredArtifactFile>): Promise<SealedFileResources>;
}
const EMPTY_HASH = createHash("sha256").digest("hex");
const PACKAGE_ID = /^res_[a-f0-9]{64}$/u;

export interface DeclaredArtifactFile {
  readonly path: string;
  readonly sha256: string;
  readonly size: number;
}

/** Byte snapshots deliberately do not preserve executable permissions. */
export function artifactFileResourceManifest(
  files: ReadonlyArray<DeclaredArtifactFile>,
): FileResourceEntry[] {
  if (files.length > 100) throw new Error("Artifact file budget exceeded.");
  const entries = new Map<string, FileResourceEntry>();
  for (const file of files) {
    assertSkillResourcePath(file.path);
    if (entries.has(file.path)) throw new Error("Duplicate artifact path.");
    entries.set(file.path, { ...file, kind: "file", executable: false });
    for (
      let parent = path.posix.dirname(file.path);
      parent !== ".";
      parent = path.posix.dirname(parent)
    ) {
      if (!entries.has(parent))
        entries.set(parent, {
          path: parent,
          kind: "directory",
          size: 0,
          sha256: EMPTY_HASH,
          executable: false,
        });
    }
  }
  const resources = [...entries.values()].sort((a, b) => compareResourcePaths(a.path, b.path));
  validateFileResourceManifest(resources);
  if (resources.filter((entry) => entry.kind === "file").length !== files.length)
    throw new Error("Artifact file collides with a parent directory.");
  return resources;
}

async function canonicalRoot(root: string): Promise<string> {
  if (!path.isAbsolute(root) || root.includes("\0"))
    throw new Error("File resource root must be absolute.");
  const stat = await fs.lstat(root);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new Error("File resource root must be a real directory.");
  return fs.realpath(root);
}

async function assertArtifactPath(root: string, relative: string): Promise<string> {
  const segments = relative.split("/");
  let full = root;
  for (const [index, segment] of segments.entries()) {
    full = path.join(full, segment);
    const stat = await fs.lstat(full);
    if (
      stat.isSymbolicLink() ||
      (index === segments.length - 1 ? !stat.isFile() : !stat.isDirectory())
    )
      throw new Error("Artifact path contains a link or non-regular entry.");
    if ((await fs.realpath(full)) !== full)
      throw new Error("Artifact path changed during capture.");
  }
  return full;
}

/** Inspect the real F-4 identity without publishing or copying a package. */
export async function inspectFileResourceRoot(
  root: string,
): Promise<{ rootPath: string; contentHash: string }> {
  const rootPath = await canonicalRoot(root);
  const resources = manifest(await collect(rootPath));
  return { rootPath, contentHash: suiteContentDigest({ schemaVersion: 1, resources }) };
}

/** F-4 ordering is UTF-8 unsigned byte order, never host locale order. */
export function compareResourcePaths(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}
export function validateFileResourceManifest(resources: ReadonlyArray<FileResourceEntry>): void {
  if (resources.length > 5_000) throw new Error("File resource entry budget exceeded.");
  const seen = new Map<string, FileResourceEntry>();
  let total = 0;
  let previous: string | undefined;
  for (const entry of resources) {
    assertSkillResourcePath(entry.path);
    if (
      entry.path !== entry.path.normalize("NFC") ||
      Buffer.from(entry.path, "utf8").toString("utf8") !== entry.path
    )
      throw new Error("File resource paths must be NFC UTF-8.");
    if (previous !== undefined && compareResourcePaths(previous, entry.path) >= 0)
      throw new Error("File resource paths must be uniquely byte-sorted.");
    previous = entry.path;
    const folded = entry.path.toLowerCase();
    if (seen.has(folded)) throw new Error("File resource paths collide after case folding.");
    if (
      !["file", "directory"].includes(entry.kind) ||
      !Number.isSafeInteger(entry.size) ||
      entry.size < 0 ||
      entry.size > SKILL_FILE_LIMIT ||
      !/^[a-f0-9]{64}$/u.test(entry.sha256) ||
      typeof entry.executable !== "boolean"
    )
      throw new Error("Invalid file resource metadata.");
    if (
      entry.kind === "directory" &&
      (entry.size !== 0 || entry.sha256 !== EMPTY_HASH || entry.executable)
    )
      throw new Error("Invalid file resource directory metadata.");
    seen.set(folded, entry);
    total += entry.size;
    if (total > SKILL_PACKAGE_LIMIT) throw new Error("File resource byte budget exceeded.");
  }
  for (const entry of resources) {
    for (
      let parent = path.posix.dirname(entry.path);
      parent !== ".";
      parent = path.posix.dirname(parent)
    ) {
      const found = seen.get(parent.toLowerCase());
      if (!found || found.path !== parent || found.kind !== "directory")
        throw new Error("File resource parent directory is missing or colliding.");
    }
  }
}

async function collect(
  root: string,
  expected?: ReadonlyArray<FileResourceEntry>,
): Promise<Array<CollectedExpertResource & { readonly executable: boolean }>> {
  const collected = await expertResourceFiles.collect(
    { sourceRoot: root, targetRoot: "content" },
    { bytes: SKILL_PACKAGE_LIMIT, entries: 5_001 },
  );
  const expectedMap = expected ? new Map(expected.map((entry) => [entry.path, entry])) : undefined;
  const entries: Array<CollectedExpertResource & { readonly executable: boolean }> = [];
  for (const entry of collected) {
    if (entry.path === "content") continue;
    const relative = entry.path.slice("content/".length);
    let executable = false;
    if (entry.kind === "file") {
      if (expectedMap && process.platform === "win32") {
        executable = expectedMap.get(relative)?.executable ?? false;
      } else {
        // Legacy collection tracks owner-execute only. New res_ tracks ANY POSIX execute bit.
        const before = await fs.lstat(entry.sourcePath!);
        const bytes = await expertResourceFiles.read(entry.sourcePath!, root);
        const after = await fs.lstat(entry.sourcePath!);
        if (
          before.dev !== after.dev ||
          before.ino !== after.ino ||
          before.mode !== after.mode ||
          before.mtimeMs !== after.mtimeMs ||
          !bytes.equals(entry.bytes!)
        )
          throw new Error("File resource changed during collection.");
        executable = process.platform !== "win32" && (after.mode & 0o111) !== 0;
      }
    }
    entries.push({ ...entry, path: relative, executable });
  }
  entries.sort((a, b) => compareResourcePaths(a.path, b.path));
  validateFileResourceManifest(entries);
  return entries;
}
function manifest(entries: ReadonlyArray<CollectedExpertResource>): FileResourceEntry[] {
  return entries.map(({ path: relative, kind, size, sha256, executable }) => ({
    path: relative,
    kind,
    size,
    sha256,
    executable: executable === true,
  }));
}

export function createFileResourceStore(stateDir: string): FileResourceStore {
  if (!path.isAbsolute(stateDir) || stateDir.includes("\0"))
    throw new Error("State directory must be absolute.");
  const packages = path.join(stateDir, "experts", "file-resources");
  const staging = path.join(stateDir, "experts", "file-resource-staging");
  const read = async (packageId: string): Promise<SealedFileResources> => {
    if (!PACKAGE_ID.test(packageId)) throw new Error("Invalid file resource package ID.");
    const packageRoot = path.join(packages, packageId);
    const rootStat = await fs.lstat(packageRoot);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink())
      throw new Error("Invalid file resource package root.");
    const canonicalPackageRoot = await fs.realpath(packageRoot);
    const raw: unknown = JSON.parse(
      (
        await expertResourceFiles.read(
          path.join(canonicalPackageRoot, "manifest.json"),
          canonicalPackageRoot,
        )
      ).toString("utf8"),
    );
    if (
      !raw ||
      typeof raw !== "object" ||
      !("schemaVersion" in raw) ||
      raw.schemaVersion !== 1 ||
      !("resources" in raw) ||
      !Array.isArray(raw.resources)
    )
      throw new Error("Invalid file resource manifest.");
    const resources = raw.resources as FileResourceEntry[];
    validateFileResourceManifest(resources);
    const normalized = manifest(resources);
    if (
      canonicalSuiteJson(raw) !== canonicalSuiteJson({ schemaVersion: 1, resources: normalized }) ||
      `res_${suiteContentDigest({ schemaVersion: 1, resources: normalized })}` !== packageId
    )
      throw new Error("File resource identity mismatch.");
    const contentPath = path.join(canonicalPackageRoot, "content");
    const contentStat = await fs.lstat(contentPath);
    if (!contentStat.isDirectory() || contentStat.isSymbolicLink())
      throw new Error("Invalid file resource content root.");
    const rootPath = await fs.realpath(contentPath);
    const actual = manifest(await collect(rootPath, resources));
    if (canonicalSuiteJson(actual) !== canonicalSuiteJson(resources))
      throw new Error("File resource integrity mismatch.");
    return {
      packageId,
      rootPath,
      resources,
      fileCount: resources.filter((entry) => entry.kind === "file").length,
      totalBytes: resources.reduce((sum, entry) => sum + entry.size, 0),
    };
  };
  const publish = async (
    entries: ReadonlyArray<CollectedExpertResource>,
  ): Promise<SealedFileResources> => {
    const resources = manifest(entries);
    const payload = { schemaVersion: 1, resources };
    const packageId = `res_${suiteContentDigest(payload)}`;
    ensurePrivateDirectorySync(packages);
    ensurePrivateDirectorySync(staging);
    const stage = path.join(staging, randomUUID());
    await fs.mkdir(stage, { mode: 0o700 });
    try {
      const content = path.join(stage, "content");
      await fs.mkdir(content, { mode: 0o700 });
      await expertResourceFiles.copy(content, entries);
      const handle = await fs.open(path.join(stage, "manifest.json"), "wx", 0o600);
      try {
        await handle.writeFile(canonicalSuiteJson(payload));
        await handle.sync();
      } finally {
        await handle.close();
      }
      await expertResourceFiles.makeReadOnly(stage, [
        ...resources.map((entry) => ({ ...entry, path: `content/${entry.path}` })),
        { path: "manifest.json", kind: "file", size: 0, sha256: EMPTY_HASH, executable: false },
      ]);
      await syncDirectoryEntry(stage);
      let existing: SealedFileResources | undefined;
      try {
        await fs.rename(stage, path.join(packages, packageId));
      } catch (cause) {
        const code = (cause as NodeJS.ErrnoException).code ?? "";
        if (!["EEXIST", "ENOTEMPTY", "EACCES"].includes(code)) throw cause;
        // Darwin may report EACCES for an existing immutable directory.
        // It is a duplicate only after the complete existing package verifies.
        try {
          existing = await read(packageId);
        } catch (verificationError) {
          if (code === "EACCES") throw cause;
          throw verificationError;
        }
      }
      await expertResourceFiles.sealRoot(path.join(packages, packageId));
      await syncDirectoryEntry(packages);
      return existing ?? (await read(packageId));
    } finally {
      await expertResourceFiles.removeStaging(stage);
    }
  };
  return {
    read,
    async seal(root, archiveManifest) {
      const rootPath = await canonicalRoot(root);
      if (archiveManifest) validateFileResourceManifest(archiveManifest);
      const entries = await collect(rootPath, archiveManifest);
      if (
        archiveManifest &&
        canonicalSuiteJson(manifest(entries)) !== canonicalSuiteJson(archiveManifest)
      )
        throw new Error("File resource archive metadata does not match collected bytes.");
      return publish(entries);
    },
    async sealFiles(root, files) {
      const resources = artifactFileResourceManifest(files);
      const rootPath = await canonicalRoot(root);
      const entries: CollectedExpertResource[] = [];
      for (const resource of resources) {
        if (resource.kind === "directory") {
          entries.push(resource);
          continue;
        }
        const full = await assertArtifactPath(rootPath, resource.path);
        const bytes = await expertResourceFiles.read(full, rootPath);
        await assertArtifactPath(rootPath, resource.path);
        if (
          bytes.length !== resource.size ||
          createHash("sha256").update(bytes).digest("hex") !== resource.sha256
        )
          throw new Error("Artifact bytes do not match declared sha256 and size.");
        entries.push({ ...resource, bytes });
      }
      return publish(entries);
    },
  };
}
