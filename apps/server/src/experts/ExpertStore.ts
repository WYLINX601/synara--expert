import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import {
  ExpertBinding,
  ExpertDefinition as ExpertDefinitionSchema,
  ExpertPreviewInput,
  ExpertSaveInput,
  ExpertSnapshot as ExpertSnapshotSchema,
  type ExpertDefinition,
  type ExpertPreview,
  type ExpertSnapshot,
  type ResolvedExpertSkillEntry,
} from "@synara/contracts";
import { Schema } from "effect";

import { ensurePrivateDirectorySync, syncDirectoryEntry } from "../privatePathPermissions";
import { inspectBmadWorkspace } from "./bmadSkillPreset.ts";
import { createExpertConnectionStore } from "./ExpertConnectionStore.ts";
import { withSkillPackageLifecycle } from "./skillPackageLifecycle.ts";

const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_SNAPSHOT_BYTES = 100 * 1024 * 1024;
const MAX_SNAPSHOT_ENTRIES = 5_000;
const EXPERT_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/u;
const SNAPSHOT_ID_PATTERN = /^exp_[a-f0-9]{64}$/u;
const EMPTY_HASH = createHash("sha256").digest("hex");
const pendingInitializations = new Map<string, Promise<void>>();

const ResourceEntry = Schema.Struct({
  path: Schema.String,
  kind: Schema.Literals(["file", "directory"]),
  size: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  sha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u)),
  executable: Schema.optional(Schema.Boolean),
});
const StoredSnapshot = Schema.Struct({
  snapshot: ExpertSnapshotSchema,
  resources: Schema.Array(ResourceEntry),
});
type ResourceEntry = typeof ResourceEntry.Type;
type StoredSnapshot = typeof StoredSnapshot.Type;

type SourceResource = {
  readonly targetRoot: string;
  readonly sourceRoot: string;
  readonly selectedFile?: string;
};

export type CollectedExpertResource = ResourceEntry & {
  readonly bytes?: Buffer;
  readonly sourcePath?: string;
};
type CollectedResource = CollectedExpertResource;
type TreeEntry = ResourceEntry & { readonly sourcePath: string; readonly bytes?: Buffer };
type ExpertSkillSelections = NonNullable<(typeof ExpertSaveInput.Type)["skillSelections"]>;

async function resolvePackageSelections(
  stateDir: string,
  selections: ReadonlyArray<ExpertSkillSelections[number]>,
): Promise<ResolvedExpertSkillEntry[]> {
  // SkillPackageStore imports the resource collection capability from this module.
  // Load it only after ExpertStore has initialized to avoid an eager module cycle.
  const { createSkillPackageStore } = await import("./SkillPackageStore.ts");
  return createSkillPackageStore(stateDir).resolveSelections(selections);
}

export interface ExpertStore {
  list(): Promise<ExpertDefinition[]>;
  read(id: string): Promise<ExpertDefinition | null>;
  save(input: typeof ExpertSaveInput.Type): Promise<ExpertDefinition>;
  archive(id: string, expectedRevision?: number): Promise<ExpertDefinition>;
  restore(id: string, expectedRevision: number): Promise<ExpertDefinition>;
  remove(id: string, expectedRevision: number): Promise<void>;
  preview(input: typeof ExpertPreviewInput.Type): Promise<ExpertPreview>;
  prepareSnapshot(id: string): Promise<typeof ExpertBinding.Type>;
  readSnapshot(snapshotId: string): Promise<ExpertSnapshot>;
  listStoredSnapshots(): Promise<ReadonlyArray<ExpertSnapshot>>;
  removeLegacySkillSnapshots(
    snapshotIds: ReadonlyArray<string>,
    verifyNoReferences?: () => Promise<void>,
  ): Promise<ReadonlyArray<string>>;
}

export class ExpertStoreError extends Error {
  constructor(
    message: string,
    readonly code:
      | "invalid_input"
      | "not_found"
      | "revision_conflict"
      | "invalid_resource"
      | "snapshot_corrupt",
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ExpertStoreError";
  }
}

function decodeDefinitionInput(value: unknown): ExpertDefinition {
  try {
    return Schema.decodeUnknownSync(ExpertDefinitionSchema)(value);
  } catch (cause) {
    throw new ExpertStoreError("Expert definition is invalid.", "invalid_input", { cause });
  }
}

function decodeSaveInput(value: unknown): typeof ExpertSaveInput.Type {
  try {
    return Schema.decodeUnknownSync(ExpertSaveInput)(value);
  } catch (cause) {
    throw new ExpertStoreError("Expert save input is invalid.", "invalid_input", { cause });
  }
}

function decodePreviewInput(value: unknown): typeof ExpertPreviewInput.Type {
  try {
    return Schema.decodeUnknownSync(ExpertPreviewInput)(value);
  } catch (cause) {
    throw new ExpertStoreError("Expert preview input is invalid.", "invalid_input", { cause });
  }
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
  );
}

function stableJson(value: unknown): string {
  const sort = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(sort);
    if (item !== null && typeof item === "object") {
      return Object.fromEntries(
        Object.entries(item)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, child]) => [key, sort(child)]),
      );
    }
    return item;
  };
  return JSON.stringify(sort(value));
}

function hashJson(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function safePart(value: string): string {
  return (
    value
      .normalize("NFKC")
      .replace(/[^A-Za-z0-9._-]+/gu, "-")
      .replace(/^\.+/u, "")
      .slice(0, 48) || "resource"
  );
}

function isSafeRelativePath(value: string, rootName: string): boolean {
  const segments = value.split("/");
  return (
    !path.isAbsolute(value) &&
    !value.includes("\\") &&
    segments[0] === rootName &&
    segments.every((segment) => segment !== "" && segment !== "." && segment !== "..")
  );
}

function sourcePath(value: string, description: string): string {
  if (value.includes("\0") || !path.isAbsolute(value) || value.length > 4_096) {
    throw new ExpertStoreError(
      `${description} must be an absolute local path.`,
      "invalid_resource",
    );
  }
  return path.resolve(value);
}

function validateDefinitionInput(input: typeof ExpertSaveInput.Type): void {
  const maxText = 32_000;
  if (
    input.name.length > 200 ||
    input.description.length > 4_000 ||
    input.useCases.length > maxText ||
    input.persona.length > maxText ||
    input.outputRequirements.length > maxText ||
    input.skills.length > 100 ||
    input.references.length > 100 ||
    input.connections.length > 100
  ) {
    throw new ExpertStoreError("Expert definition is too large.", "invalid_input");
  }
  if (input.skillSelections === undefined) {
    for (const skill of input.skills) sourcePath(skill.path, `Skill ${skill.name}`);
  } else if (input.skills.length > 0) {
    throw new ExpertStoreError(
      "Package-based skill selections cannot be mixed with legacy skill paths.",
      "invalid_input",
    );
  }
  for (const reference of input.references) sourcePath(reference, "Reference");
  for (const connection of input.connections) {
    if (connection.tools.length > 200) {
      throw new ExpertStoreError(
        `Connection ${connection.id} has too many tools.`,
        "invalid_input",
      );
    }
  }
}

function definitionPath(directory: string, id: string): string {
  if (!EXPERT_ID_PATTERN.test(id)) {
    throw new ExpertStoreError("Expert ID is invalid.", "invalid_input");
  }
  return path.join(directory, `${id}.json`);
}

function definitionRevisionPath(directory: string, id: string, revision: number): string {
  if (!Number.isSafeInteger(revision) || revision < 1) {
    throw new ExpertStoreError("Expert revision is invalid.", "invalid_input");
  }
  return path.join(directory, id, `${revision}.json`);
}

function decodeDefinition(value: unknown): ExpertDefinition {
  const definition = decodeDefinitionInput(value);
  if (!EXPERT_ID_PATTERN.test(definition.id)) {
    throw new ExpertStoreError("Expert ID is invalid.", "snapshot_corrupt");
  }
  if (definition.skillSelections !== undefined && definition.skills.length > 0) {
    throw new ExpertStoreError(
      "Package-based skill selections cannot be mixed with legacy skill paths.",
      "snapshot_corrupt",
    );
  }
  return definition;
}

async function safeReadFileWithMetadata(
  filePath: string,
  allowedRoot?: string,
): Promise<{ readonly bytes: Buffer; readonly executable: boolean }> {
  const before = await fs.lstat(filePath);
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new ExpertStoreError(`Expected a regular file: ${filePath}`, "invalid_resource");
  }
  const real = await fs.realpath(filePath);
  if (allowedRoot && !isWithin(allowedRoot, real)) {
    throw new ExpertStoreError(`Path escapes its selected root: ${filePath}`, "invalid_resource");
  }
  const noFollow = process.platform === "win32" ? 0 : fsConstants.O_NOFOLLOW;
  const handle = await fs.open(filePath, fsConstants.O_RDONLY | noFollow);
  try {
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.size > MAX_FILE_BYTES
    ) {
      throw new ExpertStoreError(
        `File changed or exceeds the size limit: ${filePath}`,
        "invalid_resource",
      );
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    const pathAfter = await fs.lstat(filePath);
    const realAfter = await fs.realpath(filePath);
    if (
      bytes.byteLength > MAX_FILE_BYTES ||
      !pathAfter.isFile() ||
      pathAfter.isSymbolicLink() ||
      after.dev !== opened.dev ||
      after.ino !== opened.ino ||
      after.size !== opened.size ||
      after.mtimeMs !== opened.mtimeMs ||
      (process.platform !== "win32" &&
        ((after.mode & 0o100) !== (opened.mode & 0o100) ||
          (pathAfter.mode & 0o100) !== (opened.mode & 0o100))) ||
      pathAfter.dev !== opened.dev ||
      pathAfter.ino !== opened.ino ||
      (allowedRoot && !isWithin(allowedRoot, realAfter))
    ) {
      throw new ExpertStoreError(`File changed while being read: ${filePath}`, "invalid_resource");
    }
    return {
      bytes,
      // Windows does not provide POSIX execute-bit semantics. Do not infer
      // executable status from a filename or a synthetic mode bit there.
      executable: process.platform !== "win32" && (opened.mode & 0o100) !== 0,
    };
  } finally {
    await handle.close();
  }
}

async function safeReadFile(filePath: string, allowedRoot?: string): Promise<Buffer> {
  return (await safeReadFileWithMetadata(filePath, allowedRoot)).bytes;
}

async function collectTree(input: {
  readonly sourceRoot: string;
  readonly targetRoot: string;
  readonly realSourceRoot: string;
  readonly onEntry: (entry: TreeEntry) => Promise<void>;
}): Promise<void> {
  const visit = async (source: string, relative: string): Promise<void> => {
    const stat = await fs.lstat(source);
    if (stat.isSymbolicLink()) {
      throw new ExpertStoreError(
        `Symbolic links cannot be snapshotted: ${source}`,
        "invalid_resource",
      );
    }
    const real = await fs.realpath(source);
    if (!isWithin(input.realSourceRoot, real)) {
      throw new ExpertStoreError(
        `Resource escaped its selected root: ${source}`,
        "invalid_resource",
      );
    }
    const target = path.posix.join(input.targetRoot, relative.split(path.sep).join("/"));
    if (stat.isDirectory()) {
      await input.onEntry({
        path: target,
        kind: "directory",
        size: 0,
        sha256: EMPTY_HASH,
        sourcePath: source,
      });
      const names = (await fs.readdir(source)).sort((left, right) => left.localeCompare(right));
      for (const name of names) {
        await visit(path.join(source, name), relative ? path.join(relative, name) : name);
      }
      return;
    }
    if (!stat.isFile()) {
      throw new ExpertStoreError(`Unsupported resource file: ${source}`, "invalid_resource");
    }
    const { bytes, executable } = await safeReadFileWithMetadata(source, input.realSourceRoot);
    await input.onEntry({
      path: target,
      kind: "file",
      size: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      executable,
      sourcePath: source,
      bytes,
    });
  };
  await visit(input.sourceRoot, "");
}

async function readCollectedTree(
  resource: SourceResource,
  remaining: { readonly bytes: number; readonly entries: number },
): Promise<CollectedResource[]> {
  const sourceRoot = sourcePath(resource.sourceRoot, "Resource");
  const rootStat = await fs.lstat(sourceRoot);
  if (rootStat.isSymbolicLink() || (!rootStat.isDirectory() && !rootStat.isFile())) {
    throw new ExpertStoreError(
      `Selected resource is not a regular file or directory: ${sourceRoot}`,
      "invalid_resource",
    );
  }
  const realSelectedPath = await fs.realpath(sourceRoot);
  const realSourceRoot = rootStat.isDirectory() ? realSelectedPath : path.dirname(realSelectedPath);
  const entries: CollectedResource[] = [];
  let totalBytes = 0;
  await collectTree({
    sourceRoot: realSelectedPath,
    targetRoot: resource.targetRoot,
    realSourceRoot,
    onEntry: async (entry) => {
      if (entries.length >= remaining.entries) {
        throw new ExpertStoreError(
          `Resource entry limit exceeded at: ${entry.sourcePath}`,
          "invalid_resource",
        );
      }
      if (entry.kind === "file") {
        const bytes = entry.bytes!;
        totalBytes += bytes.byteLength;
        if (totalBytes > remaining.bytes) {
          throw new ExpertStoreError(
            `Resource total size limit exceeded at: ${entry.sourcePath}`,
            "invalid_resource",
          );
        }
        if (
          bytes.byteLength !== entry.size ||
          createHash("sha256").update(bytes).digest("hex") !== entry.sha256
        ) {
          throw new ExpertStoreError(
            `Resource changed while being collected: ${entry.sourcePath}`,
            "invalid_resource",
          );
        }
        entries.push({ ...entry, bytes });
      } else {
        entries.push(entry);
      }
    },
  });
  if (resource.selectedFile) {
    const selected = sourcePath(resource.selectedFile, "Skill file");
    const realSelected = await fs.realpath(selected);
    if (
      !isWithin(realSourceRoot, realSelected) ||
      path.relative(realSourceRoot, realSelected) === ""
    ) {
      throw new ExpertStoreError(
        `Skill file is outside its skill directory: ${selected}`,
        "invalid_resource",
      );
    }
    const selectedEntry = entries.find(
      (entry) => entry.kind === "file" && entry.sourcePath === realSelected,
    );
    if (!selectedEntry) {
      throw new ExpertStoreError(`Skill file was not copied: ${selected}`, "invalid_resource");
    }
  }
  return entries;
}

async function validateResourceTree(
  selectedPathValue: string,
  kind: "skill" | "reference",
): Promise<{ readonly bytes: number; readonly entries: number }> {
  const selectedPath = sourcePath(selectedPathValue, kind === "skill" ? "Skill" : "Reference");
  const selectedStat = await fs.lstat(selectedPath);
  if (selectedStat.isSymbolicLink()) {
    throw new ExpertStoreError(
      `Symbolic links cannot be selected: ${selectedPath}`,
      "invalid_resource",
    );
  }
  if (kind === "skill" && !selectedStat.isFile()) {
    throw new ExpertStoreError(
      `Skill path must point to a regular skill file: ${selectedPath}`,
      "invalid_resource",
    );
  }
  if (kind === "reference" && !selectedStat.isFile() && !selectedStat.isDirectory()) {
    throw new ExpertStoreError(
      `Reference must be a regular file or directory: ${selectedPath}`,
      "invalid_resource",
    );
  }
  const treePath = kind === "skill" ? path.dirname(selectedPath) : selectedPath;
  const realTreePath = await fs.realpath(treePath);
  const treeStat = await fs.lstat(realTreePath);
  const realSourceRoot = treeStat.isDirectory() ? realTreePath : path.dirname(realTreePath);
  let bytes = 0;
  let entries = 0;
  await collectTree({
    sourceRoot: realTreePath,
    targetRoot: "resource",
    realSourceRoot,
    onEntry: async (entry) => {
      entries += 1;
      bytes += entry.size;
      if (entries > MAX_SNAPSHOT_ENTRIES || bytes > MAX_SNAPSHOT_BYTES) {
        throw new ExpertStoreError(
          "Resource exceeds its size or file count limit.",
          "invalid_resource",
        );
      }
    },
  });
  return { bytes, entries };
}

function hashSnapshot(snapshot: ExpertSnapshot, resources: ReadonlyArray<ResourceEntry>): string {
  const payload: Record<string, unknown> = {
    expertId: snapshot.expertId,
    displayName: snapshot.displayName,
    revision: snapshot.revision,
    description: snapshot.description,
    useCases: snapshot.useCases,
    persona: snapshot.persona,
    outputRequirements: snapshot.outputRequirements,
    skills: snapshot.skills.map(({ name, path: skillPath }) => ({ name, path: skillPath })),
    skillsRoot: "skills",
    references: snapshot.references,
    connections: snapshot.connections,
    preferredProvider: snapshot.preferredProvider ?? null,
    resources: [...resources].sort((left, right) => left.path.localeCompare(right.path)),
  };
  if (snapshot.schemaVersion === 2) {
    payload.schemaVersion = 2;
    payload.skillSelections = snapshot.skillSelections;
  }
  // Older manifests had no MCP binding. Omitting the key entirely preserves
  // their content hash while making each new snapshot pin its connection revs.
  if (snapshot.mcpBinding) {
    const { createdAt: _createdAt, ...binding } = snapshot.mcpBinding;
    payload.mcpBinding = binding;
  }
  return `exp_${hashJson(payload)}`;
}

async function copyResources(
  stagePath: string,
  resources: ReadonlyArray<CollectedResource>,
): Promise<void> {
  for (const resource of resources) {
    const destination = path.join(stagePath, ...resource.path.split("/"));
    if (resource.kind === "directory") {
      await fs.mkdir(destination, { recursive: true, mode: 0o700 });
      continue;
    }
    await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    const handle = await fs.open(
      destination,
      fsConstants.O_WRONLY |
        fsConstants.O_CREAT |
        fsConstants.O_EXCL |
        (process.platform === "win32" ? 0 : fsConstants.O_NOFOLLOW),
      0o600,
    );
    try {
      if (!resource.bytes)
        throw new ExpertStoreError("Snapshot resource bytes are missing.", "snapshot_corrupt");
      await handle.writeFile(resource.bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await syncDirectoryEntry(path.dirname(destination));
  }
}

async function makeSnapshotReadOnly(
  directory: string,
  resources: ReadonlyArray<ResourceEntry>,
): Promise<void> {
  const resourcesByPath = new Map(resources.map((resource) => [resource.path, resource]));
  const noFollow = process.platform === "win32" ? 0 : fsConstants.O_NOFOLLOW;
  const directoryOnly = process.platform === "win32" ? 0 : fsConstants.O_DIRECTORY;
  const visit = async (entryPath: string, isStageRoot = false): Promise<void> => {
    const before = await fs.lstat(entryPath);
    if (before.isSymbolicLink())
      throw new Error(`Unexpected symlink in new snapshot: ${entryPath}`);
    if (before.isDirectory()) {
      for (const name of await fs.readdir(entryPath)) await visit(path.join(entryPath, name));
      // A read-only source directory cannot be atomically renamed on Darwin.
      // Keep only the unhashed staging root writable until publication; all
      // resource and child-directory modes are final and durable beforehand.
      if (isStageRoot) return;
      if (process.platform === "win32") {
        await fs.chmod(entryPath, 0o500);
      } else {
        const handle = await fs.open(entryPath, fsConstants.O_RDONLY | directoryOnly | noFollow);
        try {
          const opened = await handle.stat();
          const pathAfter = await fs.lstat(entryPath);
          if (
            !opened.isDirectory() ||
            pathAfter.isSymbolicLink() ||
            !pathAfter.isDirectory() ||
            opened.dev !== before.dev ||
            opened.ino !== before.ino ||
            pathAfter.dev !== opened.dev ||
            pathAfter.ino !== opened.ino
          ) {
            throw new Error(`Snapshot directory changed while publishing: ${entryPath}`);
          }
          await handle.chmod(0o500);
        } finally {
          await handle.close();
        }
        // Persist both the directory contents and its read-only mode before it
        // becomes reachable at the final snapshot path.
        await syncDirectoryEntry(entryPath);
      }
    } else if (before.isFile()) {
      const relativePath = path.relative(directory, entryPath).split(path.sep).join("/");
      const resource = resourcesByPath.get(relativePath);
      const mode = resource?.executable === true ? 0o500 : 0o400;
      if (process.platform === "win32") {
        await fs.chmod(entryPath, mode);
        return;
      }
      const handle = await fs.open(entryPath, fsConstants.O_RDONLY | noFollow);
      try {
        const opened = await handle.stat();
        const pathAfter = await fs.lstat(entryPath);
        if (
          !opened.isFile() ||
          pathAfter.isSymbolicLink() ||
          !pathAfter.isFile() ||
          opened.dev !== before.dev ||
          opened.ino !== before.ino ||
          pathAfter.dev !== opened.dev ||
          pathAfter.ino !== opened.ino
        ) {
          throw new Error(`Snapshot file changed while publishing: ${entryPath}`);
        }
        await handle.chmod(mode);
        // Contents were synced when copied. Sync again after chmod so the
        // executable/read-only inode metadata is durable before publication.
        await handle.sync();
      } finally {
        await handle.close();
      }
    }
  };
  await visit(directory, true);
}

async function makeSnapshotRootReadOnly(directory: string): Promise<void> {
  const before = await fs.lstat(directory);
  if (before.isSymbolicLink() || !before.isDirectory()) {
    throw new Error(`Unexpected snapshot root while publishing: ${directory}`);
  }
  if (process.platform === "win32") {
    // Windows keeps the established guarded path chmod behavior; directory
    // handles and POSIX directory fsync are not portable there.
    await fs.chmod(directory, 0o500);
    return;
  }

  const handle = await fs.open(
    directory,
    fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
  );
  try {
    const opened = await handle.stat();
    const pathAfter = await fs.lstat(directory);
    if (
      !opened.isDirectory() ||
      pathAfter.isSymbolicLink() ||
      !pathAfter.isDirectory() ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      pathAfter.dev !== opened.dev ||
      pathAfter.ino !== opened.ino
    ) {
      throw new Error(`Snapshot root changed while publishing: ${directory}`);
    }
    await handle.chmod(0o500);
  } finally {
    await handle.close();
  }
  await syncDirectoryEntry(directory);
}

async function makeTreeWritable(directory: string): Promise<void> {
  const visit = async (entryPath: string): Promise<void> => {
    let stat: Awaited<ReturnType<typeof fs.lstat>>;
    try {
      stat = await fs.lstat(entryPath);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return;
      throw cause;
    }
    if (stat.isSymbolicLink()) return;
    if (stat.isDirectory()) {
      await fs.chmod(entryPath, 0o700);
      for (const name of await fs.readdir(entryPath)) await visit(path.join(entryPath, name));
    } else if (stat.isFile()) {
      await fs.chmod(entryPath, 0o600);
    }
  };
  await visit(directory);
}

async function collectSnapshotResources(
  snapshotRoot: string,
  expectedResources?: ReadonlyArray<ResourceEntry>,
  allowMissingSkillsRoot = false,
): Promise<ResourceEntry[]> {
  const collected: ResourceEntry[] = [];
  const expectedByPath = new Map(expectedResources?.map((resource) => [resource.path, resource]));
  let totalBytes = 0;
  const realSnapshotRoot = await fs.realpath(snapshotRoot);
  const addTree = async (relativeRoot: string, optional = false): Promise<void> => {
    const fullRoot = path.join(snapshotRoot, relativeRoot);
    let rootStat: Awaited<ReturnType<typeof fs.lstat>>;
    try {
      rootStat = await fs.lstat(fullRoot);
    } catch (cause) {
      if (optional && (cause as NodeJS.ErrnoException).code === "ENOENT") return;
      throw cause;
    }
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      throw new ExpertStoreError("Snapshot resource root is invalid.", "snapshot_corrupt");
    }
    for (const name of (await fs.readdir(fullRoot)).sort((left, right) =>
      left.localeCompare(right),
    )) {
      const sourceRoot = path.join(fullRoot, name);
      const targetRoot = path.posix.join(relativeRoot, name);
      await collectTree({
        sourceRoot,
        targetRoot,
        realSourceRoot: realSnapshotRoot,
        onEntry: async (entry) => {
          if (entry.kind === "file") {
            totalBytes += entry.size;
            if (totalBytes > MAX_SNAPSHOT_BYTES) {
              throw new ExpertStoreError(
                "Snapshot exceeds the total size limit.",
                "invalid_resource",
              );
            }
          }
          const expected = expectedByPath.get(entry.path);
          const executable =
            entry.kind !== "file" || expected?.executable === undefined
              ? undefined
              : process.platform === "win32"
                ? expected.executable
                : entry.executable;
          collected.push({
            path: entry.path,
            kind: entry.kind,
            size: entry.size,
            sha256: entry.sha256,
            ...(executable !== undefined ? { executable } : {}),
          });
        },
      });
    }
  };
  await addTree("skills", allowMissingSkillsRoot);
  await addTree("references");
  if (collected.length > MAX_SNAPSHOT_ENTRIES) {
    throw new ExpertStoreError("Snapshot contains too many files.", "invalid_resource");
  }
  return collected.sort((left, right) => left.path.localeCompare(right.path));
}

async function safeRemoveTree(directory: string): Promise<void> {
  await makeTreeWritable(directory).catch(() => undefined);
  await fs.rm(directory, { recursive: true, force: true });
}

async function hydrateSnapshot(
  snapshot: ExpertSnapshot,
  snapshotRoot: string,
): Promise<ExpertSnapshot> {
  const hydrated: ExpertSnapshot = {
    ...snapshot,
    skillsRoot: path.join(snapshotRoot, "skills"),
    skills:
      snapshot.schemaVersion === 2
        ? []
        : snapshot.skills.map((skill) => ({
            ...skill,
            path: path.join(snapshotRoot, ...skill.path.split("/")),
          })),
    references: snapshot.references.map((reference) =>
      path.join(snapshotRoot, ...reference.split("/")),
    ),
  };
  if (snapshot.schemaVersion !== 2) return hydrated;
  const stateDir = path.resolve(snapshotRoot, "..", "..", "..");
  const resolved = await resolvePackageSelections(stateDir, snapshot.skillSelections!);
  return {
    ...hydrated,
    skillsRoot: path.join(stateDir, "experts", "skill-packages"),
    skills: resolved.map(({ name, path: skillPath }) => ({ name, path: skillPath })),
    skillEntries: resolved,
  };
}

/**
 * Read and validate an immutable snapshot manifest without initializing or
 * mutating the Expert store. Reference scanners use this single verifier so
 * snapshot hashes, schemas, and resource integrity have one implementation.
 */
export async function readVerifiedStoredExpertSnapshot(
  snapshotRoot: string,
  snapshotId: string,
): Promise<ExpertSnapshot> {
  if (!SNAPSHOT_ID_PATTERN.test(snapshotId)) {
    throw new ExpertStoreError("Snapshot ID is invalid.", "invalid_input");
  }
  if (!path.isAbsolute(snapshotRoot) || path.basename(snapshotRoot) !== snapshotId) {
    throw new ExpertStoreError("Snapshot directory is invalid.", "snapshot_corrupt");
  }
  const rootStat = await fs.lstat(snapshotRoot).catch((cause: unknown) => {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") {
      throw new ExpertStoreError(`Snapshot not found: ${snapshotId}`, "not_found", { cause });
    }
    throw cause;
  });
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new ExpertStoreError("Snapshot directory is invalid.", "snapshot_corrupt");
  }
  const manifestPath = path.join(snapshotRoot, "snapshot.json");
  const manifestBytes = await safeReadFile(manifestPath, await fs.realpath(snapshotRoot));
  let stored: StoredSnapshot;
  try {
    stored = Schema.decodeUnknownSync(StoredSnapshot)(
      JSON.parse(manifestBytes.toString("utf8")) as unknown,
    );
  } catch (cause) {
    throw new ExpertStoreError("Snapshot manifest is invalid.", "snapshot_corrupt", { cause });
  }
  const snapshot = stored.snapshot;
  const packageBased = snapshot.schemaVersion === 2;
  if (
    snapshot.snapshotId !== snapshotId ||
    !EXPERT_ID_PATTERN.test(snapshot.expertId) ||
    snapshot.skillsRoot !== "skills" ||
    stored.resources.length > MAX_SNAPSHOT_ENTRIES ||
    (packageBased &&
      (!Array.isArray(snapshot.skillSelections) ||
        snapshot.skills.length > 0 ||
        snapshot.skillEntries !== undefined ||
        stored.resources.some((entry) => entry.path.startsWith("skills/")))) ||
    (!packageBased &&
      (snapshot.skillSelections !== undefined || snapshot.skillEntries !== undefined)) ||
    stored.resources.some(
      (entry) =>
        !["skills", "references"].some((rootName) => isSafeRelativePath(entry.path, rootName)),
    )
  ) {
    throw new ExpertStoreError("Snapshot manifest paths are invalid.", "snapshot_corrupt");
  }
  if (
    snapshot.skills.some((skill) => !isSafeRelativePath(skill.path, "skills")) ||
    snapshot.references.some((reference) => !isSafeRelativePath(reference, "references"))
  ) {
    throw new ExpertStoreError("Snapshot resource references are invalid.", "snapshot_corrupt");
  }
  if (packageBased) {
    try {
      await fs.lstat(path.join(snapshotRoot, "skills"));
      throw new ExpertStoreError(
        "Package-based snapshots must not contain a skills directory.",
        "snapshot_corrupt",
      );
    } catch (cause) {
      if (cause instanceof ExpertStoreError || (cause as NodeJS.ErrnoException).code !== "ENOENT") {
        throw cause;
      }
    }
  }
  const actualResources = await collectSnapshotResources(
    snapshotRoot,
    stored.resources,
    packageBased,
  );
  if (stableJson(actualResources) !== stableJson(stored.resources)) {
    throw new ExpertStoreError(
      "Snapshot resources failed integrity validation.",
      "snapshot_corrupt",
    );
  }
  if (hashSnapshot(snapshot, actualResources) !== snapshotId) {
    throw new ExpertStoreError("Snapshot content hash does not match its ID.", "snapshot_corrupt");
  }
  if (packageBased) {
    try {
      await resolvePackageSelections(
        path.resolve(snapshotRoot, "..", "..", ".."),
        snapshot.skillSelections!,
      );
    } catch (cause) {
      throw new ExpertStoreError(
        "Snapshot skill package selections failed integrity validation.",
        "snapshot_corrupt",
        { cause },
      );
    }
  }
  return snapshot;
}

/** Shared immutable-file capability for Expert snapshots and content-addressed skill packages.
 * Collection rejects inner links and special files; callers own their manifest/hash semantics.
 * Do not use this capability to grant model tools or bypass provider filesystem approvals.
 */
export const expertResourceFiles = {
  collect: readCollectedTree,
  read: safeReadFile,
  copy: copyResources,
  makeReadOnly: makeSnapshotReadOnly,
  sealRoot: makeSnapshotRootReadOnly,
  removeStaging: safeRemoveTree,
  hashJson,
  stableJson,
};

export function createExpertStore(stateDir: string): ExpertStore {
  if (!path.isAbsolute(stateDir) || stateDir.includes("\0")) {
    throw new ExpertStoreError("State directory must be an absolute local path.", "invalid_input");
  }
  const root = path.join(path.resolve(stateDir), "experts");
  const definitionsDir = path.join(root, "definitions");
  const revisionsDir = path.join(root, "revisions");
  const snapshotsDir = path.join(root, "snapshots");
  const initializationPath = path.join(root, "initialized.json");
  const initializationMarker = '{"version":1}\n';
  const connectionStore = createExpertConnectionStore(stateDir);
  ensurePrivateDirectorySync(root);
  ensurePrivateDirectorySync(definitionsDir);
  ensurePrivateDirectorySync(revisionsDir);
  ensurePrivateDirectorySync(snapshotsDir);

  // ponytail: one write queue per local store; use cross-process locks if the same state directory is shared by multiple servers.
  let writeTail: Promise<void> = Promise.resolve();
  const withWriteLock = <T>(action: () => Promise<T>): Promise<T> => {
    const result = writeTail.then(action, action);
    writeTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  const readDefinitionFile = async (id: string): Promise<ExpertDefinition | null> => {
    const file = definitionPath(definitionsDir, id);
    try {
      const bytes = await safeReadFile(file);
      return decodeDefinition(JSON.parse(bytes.toString("utf8")) as unknown);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw cause;
    }
  };

  const writeAtomically = async (filePath: string, contents: string): Promise<void> => {
    ensurePrivateDirectorySync(path.dirname(filePath));
    const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
    const noFollow = process.platform === "win32" ? 0 : fsConstants.O_NOFOLLOW;
    let handle: fs.FileHandle | undefined;
    try {
      handle = await fs.open(
        tempPath,
        fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollow,
        0o600,
      );
      await handle.writeFile(contents);
      await handle.sync();
      const opened = await handle.stat();
      await handle.close();
      handle = undefined;
      const tempStat = await fs.lstat(tempPath);
      if (
        !tempStat.isFile() ||
        tempStat.isSymbolicLink() ||
        tempStat.dev !== opened.dev ||
        tempStat.ino !== opened.ino
      ) {
        throw new ExpertStoreError(
          "Temporary manifest changed before publication.",
          "snapshot_corrupt",
        );
      }
      await fs.rename(tempPath, filePath);
      await syncDirectoryEntry(path.dirname(filePath));
    } finally {
      await handle?.close().catch(() => undefined);
      await fs.rm(tempPath, { force: true }).catch(() => undefined);
    }
  };

  const persistRevision = async (definition: ExpertDefinition): Promise<void> => {
    const filePath = definitionRevisionPath(revisionsDir, definition.id, definition.revision);
    try {
      const existing = decodeDefinition(
        JSON.parse((await safeReadFile(filePath)).toString("utf8")),
      );
      if (stableJson(existing) !== stableJson(definition)) {
        throw new ExpertStoreError(
          "Expert revision history contains conflicting content.",
          "snapshot_corrupt",
        );
      }
      return;
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
    }
    await writeAtomically(filePath, `${JSON.stringify(definition, null, 2)}\n`);
  };

  const list = (): Promise<ExpertDefinition[]> =>
    withWriteLock(async () => {
      await ensureInitialized();
      const names = (await fs.readdir(definitionsDir)).filter((name) => name.endsWith(".json"));
      const definitions = await Promise.all(
        names.map(async (name) => {
          const id = name.slice(0, -".json".length);
          const definition = await readDefinitionFile(id);
          if (!definition)
            throw new ExpertStoreError(`Expert manifest disappeared: ${name}`, "snapshot_corrupt");
          return definition;
        }),
      );
      return definitions.sort(
        (left, right) =>
          right.updatedAt.localeCompare(left.updatedAt) ||
          left.name.localeCompare(right.name, "zh-Hans"),
      );
    });

  const save = (rawInput: typeof ExpertSaveInput.Type): Promise<ExpertDefinition> =>
    withSkillPackageLifecycle(stateDir, () =>
      withWriteLock(async () => {
        await ensureInitialized();
        const input = decodeSaveInput(rawInput);
        validateDefinitionInput(input);
        if (input.skillSelections !== undefined) {
          try {
            await resolvePackageSelections(stateDir, input.skillSelections);
          } catch (cause) {
            throw new ExpertStoreError(
              "Expert skill package selections are invalid or unavailable.",
              "invalid_resource",
              { cause },
            );
          }
        }
        const id = input.id ?? randomUUID().replaceAll("-", "");
        if (!EXPERT_ID_PATTERN.test(id)) {
          throw new ExpertStoreError(
            "Expert ID may contain lowercase letters, digits, _ and - only.",
            "invalid_input",
          );
        }
        const previous = await readDefinitionFile(id);
        if (previous && input.expectedRevision === undefined) {
          throw new ExpertStoreError(
            "Saving an existing expert requires expectedRevision.",
            "revision_conflict",
          );
        }
        if ((previous?.revision ?? undefined) !== input.expectedRevision) {
          throw new ExpertStoreError(
            "Expert revision changed; reload before saving.",
            "revision_conflict",
          );
        }
        const definition = decodeDefinition({
          id,
          name: input.name.trim(),
          description: input.description,
          useCases: input.useCases,
          persona: input.persona,
          outputRequirements: input.outputRequirements,
          skills: input.skills,
          ...(input.skillSelections !== undefined
            ? { skillSelections: input.skillSelections }
            : {}),
          references: input.references,
          connections: input.connections,
          preferredProvider: input.preferredProvider,
          revision: (previous?.revision ?? 0) + 1,
          archived: previous?.archived ?? false,
          updatedAt: new Date().toISOString(),
        });
        if (previous) await persistRevision(previous);
        await writeAtomically(
          definitionPath(definitionsDir, id),
          `${JSON.stringify(definition, null, 2)}\n`,
        );
        return definition;
      }),
    );

  const archive = (id: string, expectedRevision?: number): Promise<ExpertDefinition> =>
    withSkillPackageLifecycle(stateDir, () =>
      withWriteLock(async () => {
        await ensureInitialized();
        const definition = await readDefinitionFile(id);
        if (!definition) throw new ExpertStoreError(`Expert not found: ${id}`, "not_found");
        if (expectedRevision !== undefined && definition.revision !== expectedRevision) {
          throw new ExpertStoreError(
            "Expert revision changed; reload before archiving.",
            "revision_conflict",
          );
        }
        if (definition.archived) return definition;
        const archived = {
          ...definition,
          archived: true,
          revision: definition.revision + 1,
          updatedAt: new Date().toISOString(),
        };
        await persistRevision(definition);
        await writeAtomically(
          definitionPath(definitionsDir, id),
          `${JSON.stringify(archived, null, 2)}\n`,
        );
        return archived;
      }),
    );

  const restore = (id: string, expectedRevision: number): Promise<ExpertDefinition> =>
    withSkillPackageLifecycle(stateDir, () =>
      withWriteLock(async () => {
        await ensureInitialized();
        const definition = await readDefinitionFile(id);
        if (!definition) throw new ExpertStoreError(`Expert not found: ${id}`, "not_found");
        if (definition.revision !== expectedRevision) {
          throw new ExpertStoreError(
            "Expert revision changed; reload before restoring.",
            "revision_conflict",
          );
        }
        if (!definition.archived) return definition;
        const restored = {
          ...definition,
          archived: false,
          revision: definition.revision + 1,
          updatedAt: new Date().toISOString(),
        };
        await persistRevision(definition);
        await writeAtomically(
          definitionPath(definitionsDir, id),
          `${JSON.stringify(restored, null, 2)}\n`,
        );
        return restored;
      }),
    );

  const remove = (id: string, expectedRevision: number): Promise<void> =>
    withSkillPackageLifecycle(stateDir, () =>
      withWriteLock(async () => {
        await ensureInitialized();
        const definition = await readDefinitionFile(id);
        if (!definition) throw new ExpertStoreError(`Expert not found: ${id}`, "not_found");
        if (definition.revision !== expectedRevision) {
          throw new ExpertStoreError(
            "Expert revision changed; reload before deleting.",
            "revision_conflict",
          );
        }
        // Existing tasks own immutable snapshots independently of the definition.
        await persistRevision(definition);
        await fs.unlink(definitionPath(definitionsDir, id));
        await syncDirectoryEntry(definitionsDir);
      }),
    );

  const readSnapshot = async (snapshotId: string): Promise<ExpertSnapshot> => {
    await ensureInitialized();
    const snapshotRoot = path.join(snapshotsDir, snapshotId);
    const snapshot = await readVerifiedStoredExpertSnapshot(snapshotRoot, snapshotId);
    if (snapshot.schemaVersion !== 2 && snapshot.skills.length > 0) {
      throw new ExpertStoreError(
        "This task snapshot uses legacy skill paths; convert the Expert before starting it.",
        "invalid_resource",
      );
    }
    return hydrateSnapshot(snapshot, snapshotRoot);
  };

  const listStoredSnapshots = async (): Promise<ReadonlyArray<ExpertSnapshot>> => {
    await ensureInitialized();
    const entries = await fs.readdir(snapshotsDir, { withFileTypes: true });
    const snapshots: ExpertSnapshot[] = [];
    for (const entry of entries) {
      if (!SNAPSHOT_ID_PATTERN.test(entry.name) || !entry.isDirectory() || entry.isSymbolicLink()) {
        throw new ExpertStoreError(
          "Snapshot inventory contains an unknown or unsafe entry: " + entry.name,
          "snapshot_corrupt",
        );
      }
      snapshots.push(
        await readVerifiedStoredExpertSnapshot(path.join(snapshotsDir, entry.name), entry.name),
      );
    }
    return snapshots.sort((left, right) => left.snapshotId.localeCompare(right.snapshotId));
  };

  const removeLegacySkillSnapshots = (
    snapshotIds: ReadonlyArray<string>,
    verifyNoReferences?: () => Promise<void>,
  ): Promise<ReadonlyArray<string>> =>
    withSkillPackageLifecycle(stateDir, () =>
      withWriteLock(async () => {
        await ensureInitialized();
        // The host rechecks every durable reference while this shared lifecycle
        // lock prevents concurrent definition/package/snapshot mutations.
        await verifyNoReferences?.();
        if (new Set(snapshotIds).size !== snapshotIds.length) {
          throw new ExpertStoreError("Duplicate snapshot ID in cleanup request.", "invalid_input");
        }
        const verified: string[] = [];
        for (const snapshotId of snapshotIds) {
          if (!SNAPSHOT_ID_PATTERN.test(snapshotId)) {
            throw new ExpertStoreError("Snapshot ID is invalid.", "invalid_input");
          }
          let snapshot: ExpertSnapshot;
          try {
            snapshot = await readVerifiedStoredExpertSnapshot(
              path.join(snapshotsDir, snapshotId),
              snapshotId,
            );
          } catch (cause) {
            // A host-verified retry may arrive after a previous cleanup removed
            // this entry but before durable switch progress was advanced.
            if (
              verifyNoReferences &&
              cause instanceof ExpertStoreError &&
              cause.code === "not_found"
            ) {
              continue;
            }
            throw cause;
          }
          if (snapshot.schemaVersion === 2 || snapshot.skills.length === 0) {
            throw new ExpertStoreError(
              "Only verified legacy skill snapshots can be removed by migration cleanup.",
              "invalid_input",
            );
          }
          verified.push(snapshotId);
        }
        for (const snapshotId of verified) {
          await safeRemoveTree(path.join(snapshotsDir, snapshotId));
        }
        if (verified.length > 0) await syncDirectoryEntry(snapshotsDir);
        return verified;
      }),
    );

  const prepareSnapshot = (id: string): Promise<typeof ExpertBinding.Type> =>
    withSkillPackageLifecycle(stateDir, async () => {
      await ensureInitialized();
      const definition = await readDefinitionFile(id);
      if (!definition) throw new ExpertStoreError(`Expert not found: ${id}`, "not_found");
      if (definition.archived)
        throw new ExpertStoreError(
          "Archived experts cannot create new snapshots.",
          "invalid_input",
        );

      if (definition.skillSelections === undefined && definition.skills.length > 0) {
        throw new ExpertStoreError(
          "This Expert uses legacy skill paths; convert its skills to shared packages before starting it.",
          "invalid_resource",
        );
      }
      const skillSelections = definition.skillSelections ?? [];
      try {
        await resolvePackageSelections(stateDir, skillSelections);
      } catch (cause) {
        throw new ExpertStoreError(
          "Expert skill package selections are invalid or unavailable.",
          "invalid_resource",
          { cause },
        );
      }

      const sourceResources: SourceResource[] = [];
      const referenceTargets: string[] = [];
      for (const [index, reference] of definition.references.entries()) {
        const selectedPath = sourcePath(reference, "Reference");
        const selectedStat = await fs.lstat(selectedPath);
        if (
          selectedStat.isSymbolicLink() ||
          (!selectedStat.isDirectory() && !selectedStat.isFile())
        ) {
          throw new ExpertStoreError(
            `Reference must be a regular file or directory: ${selectedPath}`,
            "invalid_resource",
          );
        }
        const targetRoot = `references/${String(index).padStart(3, "0")}-${safePart(path.basename(selectedPath))}`;
        sourceResources.push({ sourceRoot: selectedPath, targetRoot });
        referenceTargets.push(targetRoot);
      }

      const collected: CollectedResource[] = [];
      let totalBytes = 0;
      for (const resource of sourceResources) {
        const entries = await readCollectedTree(resource, {
          bytes: MAX_SNAPSHOT_BYTES - totalBytes,
          entries: MAX_SNAPSHOT_ENTRIES - collected.length,
        });
        collected.push(...entries);
        totalBytes += entries.reduce((total, entry) => total + entry.size, 0);
      }
      const connectionStore = createExpertConnectionStore(stateDir);
      const mcpBindingServers = [];
      for (const connection of definition.connections) {
        if (
          connection.enabled === false ||
          (connection.toolMode !== "all" && connection.tools.length === 0)
        ) {
          continue;
        }
        const config = await connectionStore.pinRevision(connection.id);
        if (!config && connection.required) {
          throw new ExpertStoreError(
            `Required expert connection is not configured: ${connection.id}`,
            "invalid_resource",
          );
        }
        mcpBindingServers.push({
          id: connection.id,
          ...(config ? { configRevision: config.revision } : {}),
          required: connection.required,
          ...(connection.toolMode ? { toolMode: connection.toolMode } : {}),
          tools: connection.tools,
        });
      }
      const resources = collected
        .map(({ path: resourcePath, kind, size, sha256, executable }) => ({
          path: resourcePath,
          kind,
          size,
          sha256,
          ...(executable !== undefined ? { executable } : {}),
        }))
        .sort((left, right) => left.path.localeCompare(right.path));
      const relativeSnapshot: ExpertSnapshot = {
        snapshotId: "pending",
        expertId: definition.id,
        displayName: definition.name,
        revision: definition.revision,
        description: definition.description,
        useCases: definition.useCases,
        persona: definition.persona,
        outputRequirements: definition.outputRequirements,
        schemaVersion: 2,
        skills: [],
        skillSelections,
        skillsRoot: "skills",
        references: referenceTargets,
        connections: definition.connections,
        mcpBinding: {
          schemaVersion: 1,
          source: "snapshot",
          ...(mcpBindingServers.some((server) => server.toolMode === "all")
            ? { authorizationId: randomUUID() }
            : {}),
          createdAt: new Date().toISOString(),
          servers: mcpBindingServers,
        },
        preferredProvider: definition.preferredProvider,
        createdAt: "1970-01-01T00:00:00.000Z",
      };
      const snapshotId = hashSnapshot(relativeSnapshot, resources);
      const finalPath = path.join(snapshotsDir, snapshotId);
      try {
        const existing = await readSnapshot(snapshotId);
        if (existing.expertId !== definition.id || existing.revision !== definition.revision) {
          throw new ExpertStoreError("Snapshot ID collision.", "snapshot_corrupt");
        }
        return Schema.decodeUnknownSync(ExpertBinding)({
          expertId: existing.expertId,
          snapshotId,
          displayName: existing.displayName,
          revision: existing.revision,
        });
      } catch (cause) {
        if (!(cause instanceof ExpertStoreError && cause.code === "not_found")) throw cause;
      }

      const stagePath = path.join(snapshotsDir, `.staging-${randomUUID()}`);
      await fs.mkdir(stagePath, { mode: 0o700 });
      try {
        await fs.mkdir(path.join(stagePath, "references"), { mode: 0o700 });
        await copyResources(stagePath, collected);
        const stored: StoredSnapshot = {
          snapshot: { ...relativeSnapshot, snapshotId, createdAt: new Date().toISOString() },
          resources,
        };
        const manifest = path.join(stagePath, "snapshot.json");
        const handle = await fs.open(
          manifest,
          fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL,
          0o600,
        );
        try {
          await handle.writeFile(`${JSON.stringify(stored, null, 2)}\n`);
          await handle.sync();
        } finally {
          await handle.close();
        }
        await syncDirectoryEntry(stagePath);
        await makeSnapshotReadOnly(stagePath, resources);
        try {
          await fs.rename(stagePath, finalPath);
        } catch (cause) {
          const maybeExisting = await fs.lstat(finalPath).catch(() => null);
          if (!maybeExisting) throw cause;
          await safeRemoveTree(stagePath);
        }
        await makeSnapshotRootReadOnly(finalPath);
        await syncDirectoryEntry(snapshotsDir);
      } catch (cause) {
        await safeRemoveTree(stagePath).catch(() => undefined);
        throw cause;
      }
      const snapshot = await readSnapshot(snapshotId);
      return Schema.decodeUnknownSync(ExpertBinding)({
        expertId: snapshot.expertId,
        snapshotId,
        displayName: snapshot.displayName,
        revision: snapshot.revision,
      });
    });

  const preview = async (rawInput: typeof ExpertPreviewInput.Type): Promise<ExpertPreview> => {
    await ensureInitialized();
    const input = decodePreviewInput(rawInput);
    const definition = await readDefinitionFile(input.expertId);
    if (!definition) throw new ExpertStoreError(`Expert not found: ${input.expertId}`, "not_found");
    const issues: string[] = [];
    let incompatible = definition.archived;
    if (definition.archived) issues.push("已归档专家不能用于新任务。");
    let inspectedBytes = 0;
    let inspectedEntries = 0;
    let workspaceBlocked = false;
    let skillEntries: ResolvedExpertSkillEntry[] | undefined;
    const inspect = async (resourcePath: string, kind: "skill" | "reference"): Promise<void> => {
      const size = await validateResourceTree(resourcePath, kind);
      inspectedBytes += size.bytes;
      inspectedEntries += size.entries;
      if (inspectedBytes > MAX_SNAPSHOT_BYTES || inspectedEntries > MAX_SNAPSHOT_ENTRIES) {
        throw new ExpertStoreError(
          "Resources exceed the snapshot size or file count limit.",
          "invalid_resource",
        );
      }
    };
    if (definition.skillSelections !== undefined) {
      try {
        skillEntries = await resolvePackageSelections(stateDir, definition.skillSelections);
      } catch (cause) {
        incompatible = true;
        issues.push(
          `技能包选择无法读取或校验失败：${String(cause instanceof Error ? cause.message : cause)}`,
        );
      }
    } else if (definition.skills.length > 0) {
      incompatible = true;
      issues.push("此专家仍使用旧式本机技能路径；转换为共享技能包后才能启动。");
    } else {
      skillEntries = await resolvePackageSelections(stateDir, []);
    }
    for (const reference of definition.references) {
      try {
        await inspect(reference, "reference");
      } catch (cause) {
        incompatible = true;
        issues.push(
          `参考资料无法读取或包含不安全路径：${String(cause instanceof Error ? cause.message : cause)}`,
        );
      }
    }
    try {
      const bmadPreflight = await inspectBmadWorkspace(skillEntries ?? [], input.cwd);
      if (bmadPreflight?.issues.length) {
        workspaceBlocked = true;
        issues.push(...bmadPreflight.issues.map((issue) => `BMad workspace: ${issue}`));
      }
    } catch (cause) {
      workspaceBlocked = true;
      issues.push(
        `BMad workspace preflight failed: ${String(cause instanceof Error ? cause.message : cause)}`,
      );
    }
    let connectionBlocked = false;
    let connectionPartial = false;
    for (const connection of definition.connections) {
      if (
        connection.enabled === false ||
        (connection.toolMode !== "all" && connection.tools.length === 0)
      ) {
        continue;
      }
      const markUnavailable = (message: string) => {
        issues.push(message);
        if (connection.required) connectionBlocked = true;
        else connectionPartial = true;
      };
      let config;
      try {
        config = await connectionStore.read(connection.id);
      } catch {
        config = null;
      }
      if (!config) {
        markUnavailable(`${connection.required ? "必需" : "可选"}连接“${connection.id}”尚未配置。`);
        continue;
      }
      let connectionState;
      try {
        connectionState = await connectionStore.readState(connection.id);
      } catch {
        markUnavailable(
          `${connection.required ? "必需" : "可选"}连接“${connection.id}”状态不可用。`,
        );
        continue;
      }
      if (connectionState.status !== "active") {
        markUnavailable(
          `${connection.required ? "必需" : "可选"}连接“${connection.id}”已${connectionState.status === "retired" ? "退役" : "停用"}。`,
        );
        continue;
      }
      const envVars =
        config.transport.type === "stdio"
          ? config.transport.envFromHost.map((entry) => entry.envVar)
          : config.transport.headersFromHost.map((entry) => entry.envVar);
      const missing = [...new Set(envVars.filter((name) => process.env[name] === undefined))];
      if (missing.length > 0) {
        markUnavailable(
          `${connection.required ? "必需" : "可选"}连接“${connection.id}”缺少环境变量：${missing.join("、")}。`,
        );
      }
    }
    const status =
      connectionBlocked || workspaceBlocked
        ? "blocked"
        : incompatible
          ? "incompatible"
          : connectionPartial
            ? "partial"
            : "available";
    return {
      definition,
      ...(skillEntries !== undefined ? { skillEntries } : {}),
      status,
      issues,
    };
  };

  let initialization: Promise<void> | undefined;
  const ensureInitialized = (): Promise<void> => {
    if (initialization) return initialization;
    const pending = pendingInitializations.get(root);
    if (pending) return (initialization = pending);
    const created = (async () => {
      try {
        const marker = await safeReadFile(initializationPath);
        if (marker.toString("utf8") !== initializationMarker) {
          throw new ExpertStoreError(
            "Expert initialization marker is invalid.",
            "snapshot_corrupt",
          );
        }
        return;
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
      }
      const existing = await fs.readdir(definitionsDir);
      if (existing.some((name) => name.endsWith(".json"))) {
        await writeAtomically(initializationPath, initializationMarker);
        return;
      }
      const now = new Date().toISOString();
      const examples: Omit<ExpertDefinition, "updatedAt">[] = [
        {
          id: "product-manager",
          name: "产品经理",
          description: "梳理需求、识别假设并撰写 PRD。",
          useCases: "澄清需求、比较方案并形成可验收的 PRD。",
          persona: "先区分事实与假设；输出决策依据和待验证问题。",
          outputRequirements: "先给结论，再列出依据、风险和待确认事项。",
          skills: [],
          references: [],
          connections: [],
          preferredProvider: "codex",
          revision: 1,
          archived: false,
        },
        {
          id: "ui-designer",
          name: "UI 设计师",
          description: "从任务流程出发，产出可评审的界面方案。",
          useCases: "梳理信息架构、用户流程与关键界面方案。",
          persona: "先画关键流程，再定组件细节；指出无障碍风险。",
          outputRequirements: "先说明用户目标，再给流程、界面要点和无障碍检查项。",
          skills: [],
          references: [],
          connections: [],
          preferredProvider: "codex",
          revision: 1,
          archived: false,
        },
        {
          id: "code-reviewer",
          name: "代码审查员",
          description: "检查改动的正确性、回归与可维护性。",
          useCases: "评审代码变更，优先识别可复现的问题和回归风险。",
          persona: "先找能复现的问题，再说明影响和修复方向。",
          outputRequirements: "按严重程度列出发现，给出文件位置、触发条件与修复方向。",
          skills: [],
          references: [],
          connections: [],
          preferredProvider: "pi",
          revision: 1,
          archived: false,
        },
      ];
      for (const example of examples) {
        await writeAtomically(
          definitionPath(definitionsDir, example.id),
          `${JSON.stringify({ ...example, updatedAt: now }, null, 2)}\n`,
        );
      }
      await writeAtomically(initializationPath, initializationMarker);
    })();
    pendingInitializations.set(root, created);
    void created
      .finally(() => {
        if (pendingInitializations.get(root) === created) pendingInitializations.delete(root);
      })
      .catch(() => undefined);
    return (initialization = created);
  };

  return {
    list,
    read: async (id) => {
      await ensureInitialized();
      return readDefinitionFile(id);
    },
    save,
    archive,
    restore,
    remove,
    preview,
    prepareSnapshot,
    readSnapshot,
    listStoredSnapshots,
    removeLegacySkillSnapshots,
  };
}
