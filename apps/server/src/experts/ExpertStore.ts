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
} from "@synara/contracts";
import { Schema } from "effect";

import { ensurePrivateDirectorySync, syncDirectoryEntry } from "../privatePathPermissions";
import { createExpertConnectionStore } from "./ExpertConnectionStore.ts";

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

type CollectedResource = ResourceEntry & { readonly bytes?: Buffer; readonly sourcePath?: string };
type TreeEntry = ResourceEntry & { readonly sourcePath: string; readonly bytes?: Buffer };

export interface ExpertStore {
  list(): Promise<ExpertDefinition[]>;
  read(id: string): Promise<ExpertDefinition | null>;
  save(input: typeof ExpertSaveInput.Type): Promise<ExpertDefinition>;
  archive(id: string, expectedRevision?: number): Promise<ExpertDefinition>;
  preview(input: typeof ExpertPreviewInput.Type): Promise<ExpertPreview>;
  prepareSnapshot(id: string): Promise<typeof ExpertBinding.Type>;
  readSnapshot(snapshotId: string): Promise<ExpertSnapshot>;
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
  for (const skill of input.skills) sourcePath(skill.path, `Skill ${skill.name}`);
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

function decodeDefinition(value: unknown): ExpertDefinition {
  const definition = decodeDefinitionInput(value);
  if (!EXPERT_ID_PATTERN.test(definition.id)) {
    throw new ExpertStoreError("Expert ID is invalid.", "snapshot_corrupt");
  }
  return definition;
}

async function safeReadFile(filePath: string, allowedRoot?: string): Promise<Buffer> {
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
      !pathAfter.isFile() ||
      pathAfter.isSymbolicLink() ||
      after.dev !== opened.dev ||
      after.ino !== opened.ino ||
      after.size !== opened.size ||
      after.mtimeMs !== opened.mtimeMs ||
      pathAfter.dev !== opened.dev ||
      pathAfter.ino !== opened.ino ||
      (allowedRoot && !isWithin(allowedRoot, realAfter))
    ) {
      throw new ExpertStoreError(`File changed while being read: ${filePath}`, "invalid_resource");
    }
    return bytes;
  } finally {
    await handle.close();
  }
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
    const bytes = await safeReadFile(source, input.realSourceRoot);
    await input.onEntry({
      path: target,
      kind: "file",
      size: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
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
        throw new ExpertStoreError("Snapshot contains too many files.", "invalid_resource");
      }
      if (entry.kind === "file") {
        const bytes = entry.bytes!;
        totalBytes += bytes.byteLength;
        if (totalBytes > remaining.bytes) {
          throw new ExpertStoreError("Snapshot exceeds the total size limit.", "invalid_resource");
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
  const payload = {
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

async function makeSnapshotReadOnly(directory: string): Promise<void> {
  const visit = async (entryPath: string): Promise<void> => {
    const stat = await fs.lstat(entryPath);
    if (stat.isSymbolicLink()) throw new Error(`Unexpected symlink in new snapshot: ${entryPath}`);
    if (stat.isDirectory()) {
      for (const name of await fs.readdir(entryPath)) await visit(path.join(entryPath, name));
      await fs.chmod(entryPath, 0o500);
    } else if (stat.isFile()) {
      await fs.chmod(entryPath, (stat.mode & 0o100) | 0o400);
    }
  };
  await visit(directory);
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

async function collectSnapshotResources(snapshotRoot: string): Promise<ResourceEntry[]> {
  const collected: ResourceEntry[] = [];
  let totalBytes = 0;
  const realSnapshotRoot = await fs.realpath(snapshotRoot);
  const addTree = async (relativeRoot: string): Promise<void> => {
    const fullRoot = path.join(snapshotRoot, relativeRoot);
    const rootStat = await fs.lstat(fullRoot);
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
          collected.push({
            path: entry.path,
            kind: entry.kind,
            size: entry.size,
            sha256: entry.sha256,
          });
        },
      });
    }
  };
  await addTree("skills");
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

function hydrateSnapshot(snapshot: ExpertSnapshot, snapshotRoot: string): ExpertSnapshot {
  return {
    ...snapshot,
    skillsRoot: path.join(snapshotRoot, "skills"),
    skills: snapshot.skills.map((skill) => ({
      ...skill,
      path: path.join(snapshotRoot, ...skill.path.split("/")),
    })),
    references: snapshot.references.map((reference) =>
      path.join(snapshotRoot, ...reference.split("/")),
    ),
  };
}

export function createExpertStore(stateDir: string): ExpertStore {
  if (!path.isAbsolute(stateDir) || stateDir.includes("\0")) {
    throw new ExpertStoreError("State directory must be an absolute local path.", "invalid_input");
  }
  const root = path.join(path.resolve(stateDir), "experts");
  const definitionsDir = path.join(root, "definitions");
  const snapshotsDir = path.join(root, "snapshots");
  const connectionStore = createExpertConnectionStore(stateDir);
  ensurePrivateDirectorySync(root);
  ensurePrivateDirectorySync(definitionsDir);
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

  const list = async (): Promise<ExpertDefinition[]> => {
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
  };

  const save = (rawInput: typeof ExpertSaveInput.Type): Promise<ExpertDefinition> =>
    withWriteLock(async () => {
      await ensureInitialized();
      const input = decodeSaveInput(rawInput);
      validateDefinitionInput(input);
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
        references: input.references,
        connections: input.connections,
        preferredProvider: input.preferredProvider,
        revision: (previous?.revision ?? 0) + 1,
        archived: previous?.archived ?? false,
        updatedAt: new Date().toISOString(),
      });
      await writeAtomically(
        definitionPath(definitionsDir, id),
        `${JSON.stringify(definition, null, 2)}\n`,
      );
      return definition;
    });

  const archive = (id: string, expectedRevision?: number): Promise<ExpertDefinition> =>
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
      await writeAtomically(
        definitionPath(definitionsDir, id),
        `${JSON.stringify(archived, null, 2)}\n`,
      );
      return archived;
    });

  const readSnapshot = async (snapshotId: string): Promise<ExpertSnapshot> => {
    await ensureInitialized();
    if (!SNAPSHOT_ID_PATTERN.test(snapshotId)) {
      throw new ExpertStoreError("Snapshot ID is invalid.", "invalid_input");
    }
    const snapshotRoot = path.join(snapshotsDir, snapshotId);
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
    if (
      snapshot.snapshotId !== snapshotId ||
      !EXPERT_ID_PATTERN.test(snapshot.expertId) ||
      snapshot.skillsRoot !== "skills" ||
      stored.resources.length > MAX_SNAPSHOT_ENTRIES ||
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
    const actualResources = await collectSnapshotResources(snapshotRoot);
    if (stableJson(actualResources) !== stableJson(stored.resources)) {
      throw new ExpertStoreError(
        "Snapshot resources failed integrity validation.",
        "snapshot_corrupt",
      );
    }
    if (hashSnapshot(snapshot, actualResources) !== snapshotId) {
      throw new ExpertStoreError(
        "Snapshot content hash does not match its ID.",
        "snapshot_corrupt",
      );
    }
    return hydrateSnapshot(snapshot, snapshotRoot);
  };

  const prepareSnapshot = async (id: string): Promise<typeof ExpertBinding.Type> => {
    await ensureInitialized();
    const definition = await readDefinitionFile(id);
    if (!definition) throw new ExpertStoreError(`Expert not found: ${id}`, "not_found");
    if (definition.archived)
      throw new ExpertStoreError("Archived experts cannot create new snapshots.", "invalid_input");

    const sourceResources: SourceResource[] = [];
    const skillTargets: string[] = [];
    for (const [index, skill] of definition.skills.entries()) {
      const skillFile = sourcePath(skill.path, `Skill ${skill.name}`);
      const skillFileStat = await fs.lstat(skillFile);
      if (skillFileStat.isSymbolicLink() || !skillFileStat.isFile()) {
        throw new ExpertStoreError(
          `Skill path must be a regular skill file: ${skillFile}`,
          "invalid_resource",
        );
      }
      const sourceRoot = path.dirname(skillFile);
      const targetRoot = `skills/${String(index).padStart(3, "0")}-${safePart(path.basename(sourceRoot))}`;
      sourceResources.push({ sourceRoot, targetRoot, selectedFile: skillFile });
      skillTargets.push(path.posix.join(targetRoot, path.basename(skillFile)));
    }
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
    const resources = collected
      .map(({ path: resourcePath, kind, size, sha256 }) => ({
        path: resourcePath,
        kind,
        size,
        sha256,
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
      skills: definition.skills.map((skill, index) => ({ ...skill, path: skillTargets[index]! })),
      skillsRoot: "skills",
      references: referenceTargets,
      connections: definition.connections,
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
      await fs.mkdir(path.join(stagePath, "skills"), { mode: 0o700 });
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
      let published = false;
      try {
        await fs.rename(stagePath, finalPath);
        published = true;
      } catch (cause) {
        const maybeExisting = await fs.lstat(finalPath).catch(() => null);
        if (!maybeExisting) throw cause;
        await safeRemoveTree(stagePath);
      }
      await syncDirectoryEntry(snapshotsDir);
      if (published) await makeSnapshotReadOnly(finalPath);
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
  };

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
    for (const skill of definition.skills) {
      try {
        await inspect(skill.path, "skill");
      } catch (cause) {
        incompatible = true;
        issues.push(
          `技能“${skill.name}”无法读取或包含不安全路径：${String(cause instanceof Error ? cause.message : cause)}`,
        );
      }
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
    let connectionBlocked = false;
    let connectionPartial = false;
    for (const connection of definition.connections) {
      if (connection.tools.length === 0) continue;
      let config;
      try {
        config = await connectionStore.read(connection.id);
      } catch {
        config = null;
      }
      const markUnavailable = (message: string) => {
        issues.push(message);
        if (connection.required) connectionBlocked = true;
        else connectionPartial = true;
      };
      if (!config) {
        markUnavailable(`${connection.required ? "必需" : "可选"}连接“${connection.id}”尚未配置。`);
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
    const status = connectionBlocked
      ? "blocked"
      : incompatible
        ? "incompatible"
        : connectionPartial
          ? "partial"
          : "available";
    return { definition, status, issues };
  };

  let initialization: Promise<void> | undefined;
  const ensureInitialized = (): Promise<void> => {
    if (initialization) return initialization;
    const pending = pendingInitializations.get(root);
    if (pending) return (initialization = pending);
    const created = (async () => {
      const existing = await fs.readdir(definitionsDir);
      if (existing.some((name) => name.endsWith(".json"))) return;
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
    preview,
    prepareSnapshot,
    readSnapshot,
  };
}
