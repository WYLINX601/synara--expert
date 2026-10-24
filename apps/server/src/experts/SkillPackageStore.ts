import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import {
  ExpertSkillSelection,
  SkillEntryPath,
  SkillPackage as SkillPackageSchema,
  SkillPackageId,
  SkillPackageImportInput,
  SkillPackageImportResult as SkillPackageImportResultSchema,
  SkillPackagePreviewInput,
  SkillPackageSource as SkillPackageSourceSchema,
  SkillPackageUpdatePreviewInput,
  SkillSourceId,
  type ResolvedExpertSkillEntry,
  type SkillEntry,
  type SkillPackage,
  type SkillPackageImportResult,
  type SkillPackagePreview,
  type SkillPackageResource,
  type SkillPackageSource,
  type SkillPackageUpdatePreview,
} from "@synara/contracts";
import { Schema } from "effect";
import YAML from "yaml";

import { ensurePrivateDirectorySync, syncDirectoryEntry } from "../privatePathPermissions";
import { parseSkillFrontmatter } from "../provider/skillsCatalog.ts";
import { writePrivateFileAtomically } from "./ExpertMcpStorage.ts";
import { expertResourceFiles, type CollectedExpertResource } from "./ExpertStore.ts";
import { withSkillPackageLifecycle } from "./skillPackageLifecycle.ts";
import {
  assertSkillPackageUnreferenced,
  scanSkillPackageReferences,
} from "./skillPackageReferences.ts";

const MAX_BYTES = 100 * 1024 * 1024;
const MAX_ENTRIES = 5_000;
const PREVIEW_TTL_MS = 15 * 60 * 1_000;
const MAX_PREVIEWS = 100;
const ordinal = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);
const SkillPackageRemovalRecord = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  packageId: SkillPackageId,
  state: Schema.Literals(["pending", "complete"]),
  sources: Schema.Array(SkillPackageSourceSchema),
});
type SkillPackageRemovalRecord = typeof SkillPackageRemovalRecord.Type;
const SkillPackageImportRecord = Schema.Struct({
  previewId: Schema.String,
  state: Schema.optional(Schema.Literals(["pending", "complete"])),
  result: SkillPackageImportResultSchema,
});

export class SkillPackageStoreError extends Error {
  constructor(
    message: string,
    readonly code:
      | "invalid_input"
      | "invalid_resource"
      | "not_found"
      | "preview_expired"
      | "preview_stale"
      | "revision_conflict"
      | "package_corrupt",
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "SkillPackageStoreError";
  }
}

export interface SkillPackageStore {
  /** Publish managed staging without retaining a mutable staging-source pointer. */
  publishDirectory(
    sourcePath: string,
    retain?: (manifest: SkillPackage) => Promise<void>,
  ): Promise<SkillPackage>;
  publishPreview(
    previewId: string,
    retain?: (manifest: SkillPackage) => Promise<void>,
  ): Promise<SkillPackage>;
  materializePreview(previewId: string, destination: string): Promise<SkillPackage>;
  cancelPreview(previewId: string): void;
  preview(input: typeof SkillPackagePreviewInput.Type): Promise<SkillPackagePreview>;
  previewUpdate(
    input: typeof SkillPackageUpdatePreviewInput.Type,
  ): Promise<SkillPackageUpdatePreview>;
  import(input: typeof SkillPackageImportInput.Type): Promise<SkillPackageImportResult>;
  read(packageId: string): Promise<SkillPackage>;
  list(): Promise<SkillPackage[]>;
  listSources(): Promise<SkillPackageSource[]>;
  previewRemoval(packageId: string): Promise<{ packageId: string; references: string[] }>;
  remove(packageId: string): Promise<void>;
  resolveSelections(
    selections: ReadonlyArray<typeof ExpertSkillSelection.Type>,
  ): Promise<ResolvedExpertSkillEntry[]>;
}

function assertPortablePath(relative: string): void {
  if (
    relative.length > 4_096 ||
    relative
      .split("/")
      .some(
        (segment) =>
          !segment ||
          segment === "." ||
          segment === ".." ||
          /[\\\p{Cc}:<>"|?*]/u.test(segment) ||
          /[. ]$/u.test(segment) ||
          /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(segment),
      )
  ) {
    throw new SkillPackageStoreError(`Non-portable package path: ${relative}`, "invalid_resource");
  }
}

function manifestFromResources(
  rootName: string,
  collected: ReadonlyArray<CollectedExpertResource>,
): SkillPackage {
  assertPortablePath(rootName);
  const seen = new Set<string>();
  const resources: SkillPackageResource[] = [];
  const entries: SkillEntry[] = [];
  let fileCount = 0;
  let totalBytes = 0;
  for (const resource of collected) {
    assertPortablePath(resource.path);
    const key = resource.path.normalize("NFC").toLowerCase();
    if (seen.has(key)) {
      throw new SkillPackageStoreError(
        `Case or Unicode path collision: ${resource.path}`,
        "invalid_resource",
      );
    }
    seen.add(key);
    const { path: resourcePath, kind, size, sha256, executable } = resource;
    resources.push({
      path: resourcePath,
      kind,
      size,
      sha256,
      ...(executable !== undefined ? { executable } : {}),
    });
    if (kind !== "file") continue;
    fileCount += 1;
    totalBytes += size;
    if (path.posix.basename(resourcePath) !== "SKILL.md") continue;
    const entryPath = resourcePath.slice("content/".length);
    Schema.decodeUnknownSync(SkillEntryPath)(entryPath);
    const metadata = parseSkillFrontmatter(resource.bytes!.toString("utf8"));
    const issues: string[] = [];
    const metadataName = typeof metadata.name === "string" ? metadata.name : "";
    const directoryName = path.posix.basename(path.posix.dirname(resourcePath));
    const name = metadataName || (directoryName === "content" ? rootName : directoryName);
    if (!metadataName) issues.push("Missing frontmatter name; the directory name is used.");
    if (metadataName && metadataName !== directoryName && directoryName !== "content")
      issues.push("Skill name differs from its directory name; original files are preserved.");
    const description = typeof metadata.description === "string" ? metadata.description : "";
    if (!description) issues.push("Missing frontmatter description.");
    const frontmatterBlock =
      /^---\s*\r?\n([\s\S]*?)\r?\n---(?:\s|$)/u.exec(resource.bytes!.toString("utf8"))?.[1] ?? "";
    let incompatibleReason: string | undefined;
    try {
      const parsed: unknown = YAML.parse(frontmatterBlock, { logLevel: "error" });
      if (
        parsed &&
        typeof parsed === "object" &&
        ["context", "agent", "model", "hooks"].some((key) => Object.hasOwn(parsed, key))
      )
        incompatibleReason =
          "Provider-native context, agent, model or hooks semantics are unsupported by the unified index.";
    } catch {
      issues.push("Invalid YAML frontmatter; scalar metadata uses the existing discovery parser.");
      if (/^["']?(?:context|agent|model|hooks)["']?\s*:/mu.test(frontmatterBlock))
        incompatibleReason =
          "Provider-native execution metadata is unsupported by the unified index.";
    }
    if (incompatibleReason) issues.push(incompatibleReason);
    if (/^allowed-tools\s*:/mu.test(frontmatterBlock))
      issues.push(
        "allowed-tools grants no permissions; host approval and access rules still apply.",
      );
    if (name.length > 200 || description.length > 16_000) {
      throw new SkillPackageStoreError(
        `Skill metadata exceeds its limit: ${entryPath}`,
        "invalid_resource",
      );
    }
    entries.push({
      entryPath,
      name,
      description,
      issues,
      ...(typeof metadata["disable-model-invocation"] === "boolean"
        ? { disableModelInvocation: metadata["disable-model-invocation"] }
        : {}),
      ...(typeof metadata["user-invocable"] === "boolean"
        ? { userInvocable: metadata["user-invocable"] }
        : {}),
      ...(incompatibleReason ? { incompatibleReason } : {}),
    });
  }
  resources.sort((left, right) => ordinal(left.path, right.path));
  entries.sort((left, right) => ordinal(left.entryPath, right.entryPath));
  if (!entries.length)
    throw new SkillPackageStoreError(
      "The selected package contains no SKILL.md entries.",
      "invalid_resource",
    );
  const packageId = `pkg_${expertResourceFiles.hashJson({ schemaVersion: 1, rootName, resources })}`;
  return Schema.decodeUnknownSync(SkillPackageSchema)({
    schemaVersion: 1,
    packageId,
    rootName,
    resources,
    entries,
    fileCount,
    totalBytes,
  });
}

async function collectSource(selectedPath: string): Promise<{
  realRoot: string;
  package: SkillPackage;
  resources: CollectedExpertResource[];
}> {
  if (!path.isAbsolute(selectedPath) || selectedPath.includes("\0")) {
    throw new SkillPackageStoreError(
      "Select an absolute local SKILL.md path or package directory.",
      "invalid_input",
    );
  }
  const selected = await fs.lstat(selectedPath);
  const realSelected = await fs.realpath(selectedPath);
  const target = await fs.lstat(realSelected);
  // Only an outer directory link is supported, never a linked SKILL.md.
  if (
    !target.isDirectory() &&
    (!target.isFile() || selected.isSymbolicLink() || path.basename(selectedPath) !== "SKILL.md")
  ) {
    throw new SkillPackageStoreError(
      `Select a package directory or a regular SKILL.md: ${selectedPath}`,
      "invalid_resource",
    );
  }
  const realRoot = target.isDirectory() ? realSelected : path.dirname(realSelected);
  const resources = await expertResourceFiles.collect(
    { sourceRoot: realRoot, targetRoot: "content" },
    { bytes: MAX_BYTES, entries: MAX_ENTRIES },
  );
  return {
    realRoot,
    package: manifestFromResources(path.basename(realRoot), resources),
    resources,
  };
}

/** Local immutable package storage. No scripts, dependency installers, provider scans or project writes. */
export function createSkillPackageStore(stateDir: string): SkillPackageStore {
  if (!path.isAbsolute(stateDir) || stateDir.includes("\0")) {
    throw new SkillPackageStoreError(
      "State directory must be an absolute local path.",
      "invalid_input",
    );
  }
  const root = path.join(path.resolve(stateDir), "experts");
  const packagesDir = path.join(root, "skill-packages");
  const sourcesDir = path.join(root, "skill-sources");
  const importsDir = path.join(root, "skill-imports");
  const removalsDir = path.join(root, "skill-package-removals");
  for (const directory of [root, packagesDir, sourcesDir, importsDir, removalsDir])
    ensurePrivateDirectorySync(directory);
  // Serialize writers across store users in this process. The host, not this
  // file store, owns the cross-process stateDir lifecycle lock.
  const previews = new Map<
    string,
    {
      sourcePath: string;
      realRoot: string;
      packageId: string;
      expiresAt: number;
      sourceRevision?: number;
    }
  >();

  const read = async (packageId: string): Promise<SkillPackage> => {
    if (!Schema.is(SkillPackageId)(packageId))
      throw new SkillPackageStoreError("Invalid skill package ID.", "invalid_input");
    const directory = path.join(packagesDir, packageId);
    const directoryStat = await fs.lstat(directory).catch((cause: unknown) => {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT")
        throw new SkillPackageStoreError(`Skill package not found: ${packageId}`, "not_found", {
          cause,
        });
      throw cause;
    });
    try {
      if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink())
        throw new Error("Unsafe package root.");
      const names = (await fs.readdir(directory)).toSorted(ordinal);
      if (JSON.stringify(names) !== JSON.stringify(["content", "package.json"]))
        throw new Error("Unexpected package root entries.");
      const stored = Schema.decodeUnknownSync(SkillPackageSchema)(
        JSON.parse(
          (
            await expertResourceFiles.read(
              path.join(directory, "package.json"),
              await fs.realpath(directory),
            )
          ).toString("utf8"),
        ) as unknown,
      );
      let collected = await expertResourceFiles.collect(
        { sourceRoot: path.join(directory, "content"), targetRoot: "content" },
        { bytes: MAX_BYTES, entries: MAX_ENTRIES },
      );
      // Windows lacks POSIX execute-bit semantics. Preserve the recorded bit there,
      // without inferring executability from extensions or synthetic stat modes.
      if (process.platform === "win32") {
        const expected = new Map(stored.resources.map((entry) => [entry.path, entry]));
        collected = collected.map((entry) =>
          entry.kind === "file"
            ? { ...entry, executable: expected.get(entry.path)?.executable ?? false }
            : entry,
        );
      }
      const actual = manifestFromResources(stored.rootName, collected);
      if (
        actual.packageId !== packageId ||
        expertResourceFiles.stableJson(actual) !== expertResourceFiles.stableJson(stored)
      )
        throw new Error("Package manifest/content mismatch.");
      return actual;
    } catch (cause) {
      throw new SkillPackageStoreError(
        `Skill package failed integrity validation: ${packageId}`,
        "package_corrupt",
        { cause },
      );
    }
  };

  const readSource = async (sourceId: string): Promise<SkillPackageSource | null> => {
    if (!Schema.is(SkillSourceId)(sourceId))
      throw new SkillPackageStoreError("Invalid skill source ID.", "invalid_input");
    try {
      const source = Schema.decodeUnknownSync(SkillPackageSourceSchema)(
        JSON.parse(
          (await expertResourceFiles.read(path.join(sourcesDir, `${sourceId}.json`))).toString(
            "utf8",
          ),
        ) as unknown,
      );
      if (
        source.sourceId !== sourceId ||
        `src_${expertResourceFiles.hashJson(source.sourcePath)}` !== sourceId ||
        !path.isAbsolute(source.sourcePath) ||
        !path.isAbsolute(source.realRoot)
      )
        throw new Error("Invalid source identity.");
      return source;
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw new SkillPackageStoreError(`Skill source is invalid: ${sourceId}`, "package_corrupt", {
        cause,
      });
    }
  };

  const assertPackageId = (packageId: string): void => {
    if (!Schema.is(SkillPackageId)(packageId))
      throw new SkillPackageStoreError("Invalid skill package ID.", "invalid_input");
  };
  const removalJournalPath = (packageId: string) => {
    assertPackageId(packageId);
    return path.join(removalsDir, `${packageId}.json`);
  };
  const removalTombstonePath = (packageId: string) => {
    assertPackageId(packageId);
    return path.join(removalsDir, packageId);
  };
  const readRemovalJournal = async (
    packageId: string,
  ): Promise<SkillPackageRemovalRecord | null> => {
    assertPackageId(packageId);
    try {
      const record = Schema.decodeUnknownSync(SkillPackageRemovalRecord)(
        JSON.parse(
          (await expertResourceFiles.read(removalJournalPath(packageId))).toString("utf8"),
        ) as unknown,
      );
      if (
        record.packageId !== packageId ||
        record.sources.some(
          (source) =>
            source.packageId !== packageId ||
            source.sourceId !== `src_${expertResourceFiles.hashJson(source.sourcePath)}` ||
            !path.isAbsolute(source.sourcePath) ||
            !path.isAbsolute(source.realRoot),
        )
      )
        throw new Error("Removal journal identity mismatch.");
      return record;
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw new SkillPackageStoreError(
        "Skill package removal journal is invalid.",
        "package_corrupt",
        {
          cause,
        },
      );
    }
  };

  const writeRemovalJournal = async (record: SkillPackageRemovalRecord): Promise<void> => {
    await writePrivateFileAtomically(
      removalJournalPath(record.packageId),
      `${JSON.stringify(record, null, 2)}\n`,
    );
  };

  const finishRemoval = async (record: SkillPackageRemovalRecord): Promise<void> => {
    if (record.state === "complete") return;

    // Recheck on every recovery attempt. Package and snapshot writers use the same
    // lifecycle queue, so no new durable reference can race this check and removal.
    await assertSkillPackageUnreferenced(stateDir, record.packageId);

    const finalPath = path.join(packagesDir, record.packageId);
    const tombstonePath = removalTombstonePath(record.packageId);
    const finalStat = await fs.lstat(finalPath).catch((cause: unknown) => {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw cause;
    });
    const tombstoneStat = await fs.lstat(tombstonePath).catch((cause: unknown) => {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw cause;
    });
    if (finalStat && (!finalStat.isDirectory() || finalStat.isSymbolicLink()))
      throw new SkillPackageStoreError(
        "Unsafe package during removal recovery.",
        "package_corrupt",
      );
    if (tombstoneStat && (!tombstoneStat.isDirectory() || tombstoneStat.isSymbolicLink()))
      throw new SkillPackageStoreError("Unsafe package tombstone.", "package_corrupt");
    if (finalStat && tombstoneStat)
      throw new SkillPackageStoreError(
        "Both the package and its removal tombstone exist; recovery stopped.",
        "package_corrupt",
      );

    if (finalStat) {
      // Verify the complete immutable version before atomically moving it out of
      // the visible package inventory. macOS requires a writable source directory
      // for rename; its files and child directories remain sealed until quarantine.
      // The journal makes this small mode transition replayable after a crash.
      await read(record.packageId);
      await fs.chmod(finalPath, 0o700);
      try {
        await fs.rename(finalPath, tombstonePath);
      } catch (cause) {
        await fs.chmod(finalPath, 0o500).catch(() => undefined);
        throw cause;
      }
      await syncDirectoryEntry(packagesDir);
      await syncDirectoryEntry(removalsDir);
    }

    // Remove only the exact source records captured in the durable journal.
    // Preflight all of them before unlinking any, then tolerate already-unlinked
    // records if a prior attempt stopped between files.
    const currentSources = await Promise.all(
      record.sources.map(async (expected) => ({
        expected,
        current: await readSource(expected.sourceId),
      })),
    );
    for (const { expected, current } of currentSources) {
      if (
        current &&
        expertResourceFiles.stableJson(current) !== expertResourceFiles.stableJson(expected)
      )
        throw new SkillPackageStoreError(
          "A skill source changed while package removal was in progress.",
          "revision_conflict",
        );
    }
    for (const { expected, current } of currentSources) {
      if (current) await fs.unlink(path.join(sourcesDir, `${expected.sourceId}.json`));
    }
    if (currentSources.some(({ current }) => current)) await syncDirectoryEntry(sourcesDir);

    // Check again after pointer cleanup and immediately before destroying the
    // quarantine tree. This is intentionally redundant and fails closed on disk
    // corruption discovered during recovery.
    await assertSkillPackageUnreferenced(stateDir, record.packageId);
    const remainingTombstone = await fs.lstat(tombstonePath).catch((cause: unknown) => {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw cause;
    });
    if (remainingTombstone) {
      if (!remainingTombstone.isDirectory() || remainingTombstone.isSymbolicLink())
        throw new SkillPackageStoreError("Unsafe package tombstone.", "package_corrupt");
      await expertResourceFiles.removeStaging(tombstonePath);
      await syncDirectoryEntry(removalsDir);
    }
    await writeRemovalJournal({ ...record, state: "complete" });
  };

  const recoverPendingRemovals = async (): Promise<void> => {
    for (const name of (await fs.readdir(removalsDir))
      .filter((entry) => entry.endsWith(".json"))
      .toSorted(ordinal)) {
      const packageId = name.slice(0, -".json".length);
      if (!Schema.is(SkillPackageId)(packageId))
        throw new SkillPackageStoreError(
          "Unknown skill package removal journal.",
          "package_corrupt",
        );
      const record = await readRemovalJournal(packageId);
      if (record?.state === "pending") await finishRemoval(record);
    }
  };

  const preview = async (
    rawInput: typeof SkillPackagePreviewInput.Type,
  ): Promise<SkillPackagePreview> => {
    const input = Schema.decodeUnknownSync(SkillPackagePreviewInput)(rawInput);
    const sourcePath = path.resolve(input.path);
    // Validate before path.resolve, which would turn a relative path into an absolute one.
    if (!path.isAbsolute(input.path))
      throw new SkillPackageStoreError("Source must be an absolute local path.", "invalid_input");
    const collected = await collectSource(sourcePath);
    const now = Date.now();
    for (const [id, entry] of previews) if (entry.expiresAt <= now) previews.delete(id);
    if (previews.size >= MAX_PREVIEWS)
      throw new SkillPackageStoreError(
        "Too many pending import previews; confirm one or wait for expiry.",
        "invalid_input",
      );
    const previewId = randomUUID();
    const expiresAt = now + PREVIEW_TTL_MS;
    previews.set(previewId, {
      sourcePath,
      realRoot: collected.realRoot,
      packageId: collected.package.packageId,
      expiresAt,
    });
    const byName = new Map<string, string[]>();
    for (const entry of collected.package.entries) {
      const key = entry.name.normalize("NFC").toLowerCase();
      byName.set(key, [...(byName.get(key) ?? []), entry.entryPath]);
    }
    const issues = [...byName.values()]
      .filter((paths) => paths.length > 1)
      .map(
        (paths) =>
          `Duplicate skill name; do not select these entries together: ${paths.join(", ")}`,
      );
    return {
      previewId,
      sourcePath,
      realRoot: collected.realRoot,
      expiresAt: new Date(expiresAt).toISOString(),
      package: collected.package,
      issues,
    };
  };

  const importPackage = async (
    rawInput: typeof SkillPackageImportInput.Type,
    publish: (result: SkillPackageImportResult) => Promise<void>,
  ): Promise<SkillPackageImportResult> => {
    const input = Schema.decodeUnknownSync(SkillPackageImportInput)(rawInput);
    const pending = previews.get(input.previewId);
    if (!pending || pending.expiresAt <= Date.now()) {
      previews.delete(input.previewId);
      throw new SkillPackageStoreError(
        "Import preview expired or is unknown; preview the source again.",
        "preview_expired",
      );
    }
    let collected: Awaited<ReturnType<typeof collectSource>>;
    try {
      collected = await collectSource(pending.sourcePath);
    } catch (cause) {
      throw new SkillPackageStoreError(
        "Import preview is stale; source cannot be revalidated.",
        "preview_stale",
        { cause },
      );
    }
    if (
      collected.realRoot !== pending.realRoot ||
      collected.package.packageId !== pending.packageId
    ) {
      previews.delete(input.previewId);
      throw new SkillPackageStoreError(
        "Import preview is stale; source content or real root changed.",
        "preview_stale",
      );
    }
    const manifest = collected.package;
    const removal = await readRemovalJournal(manifest.packageId);
    if (removal?.state === "pending") {
      throw new SkillPackageStoreError(
        "This immutable package version is still being removed; retry removal before importing it again.",
        "revision_conflict",
      );
    }
    if (removal?.state === "complete") {
      await fs.unlink(removalJournalPath(manifest.packageId));
      await syncDirectoryEntry(removalsDir);
    }
    const sourceId = `src_${expertResourceFiles.hashJson(pending.sourcePath)}`;
    const previous = await readSource(sourceId);
    if (pending.sourceRevision !== undefined && previous?.revision !== pending.sourceRevision) {
      throw new SkillPackageStoreError(
        "Skill source revision changed; preview the update again.",
        "revision_conflict",
      );
    }
    const finalPath = path.join(packagesDir, manifest.packageId);
    let reused = false;
    try {
      await read(manifest.packageId);
      reused = true;
    } catch (cause) {
      if (!(cause instanceof SkillPackageStoreError && cause.code === "not_found")) throw cause;
    }
    if (!reused) {
      const stagePath = path.join(packagesDir, `.staging-${randomUUID()}`);
      await fs.mkdir(stagePath, { mode: 0o700 });
      try {
        await expertResourceFiles.copy(stagePath, collected.resources);
        await writePrivateFileAtomically(
          path.join(stagePath, "package.json"),
          `${JSON.stringify(manifest, null, 2)}\n`,
        );
        await expertResourceFiles.makeReadOnly(stagePath, manifest.resources);
        await syncDirectoryEntry(stagePath);
        try {
          await fs.rename(stagePath, finalPath);
        } catch (cause) {
          // A concurrent publisher may have won. An intact version is reusable;
          // an unsafe/damaged destination must never be replaced automatically.
          try {
            await read(manifest.packageId);
          } catch {
            throw cause;
          }
          reused = true;
          await expertResourceFiles.removeStaging(stagePath);
        }
        await expertResourceFiles.sealRoot(finalPath);
        await syncDirectoryEntry(packagesDir);
      } catch (cause) {
        await expertResourceFiles.removeStaging(stagePath).catch(() => undefined);
        throw cause;
      }
    }
    const verified = await read(manifest.packageId);
    const source: SkillPackageSource =
      previous?.packageId === verified.packageId && previous.realRoot === pending.realRoot
        ? previous
        : {
            sourceId,
            sourcePath: pending.sourcePath,
            realRoot: pending.realRoot,
            packageId: verified.packageId,
            revision: (previous?.revision ?? 0) + 1,
            importedAt: new Date().toISOString(),
          };
    const result = { package: verified, source, reused };
    try {
      await publish(result);
    } catch (cause) {
      if (!reused) {
        try {
          const references = await scanSkillPackageReferences(stateDir, verified.packageId);
          for (const name of await fs.readdir(sourcesDir)) {
            if (!/^src_[a-f0-9]{64}\.json$/u.test(name))
              throw new Error("Unknown Skill source reference during publication rollback.");
            const saved = await readSource(name.slice(0, -5));
            if (!saved) throw new Error("Skill source disappeared during publication rollback.");
            if (saved.packageId === verified.packageId) references.push(`Source ${saved.sourceId}`);
          }
          for (const name of await fs.readdir(importsDir)) {
            if (!/^[a-f0-9]{64}\.json$/u.test(name))
              throw new Error("Unknown Skill import reference during publication rollback.");
            const receipt = Schema.decodeUnknownSync(SkillPackageImportRecord)(
              JSON.parse(
                (await expertResourceFiles.read(path.join(importsDir, name))).toString("utf8"),
              ),
            );
            if (receipt.result.package.packageId === verified.packageId)
              references.push(`Import ${name}`);
          }
          if (references.length === 0) {
            await expertResourceFiles.removeStaging(finalPath);
            await syncDirectoryEntry(packagesDir);
          }
        } catch (rollbackCause) {
          throw new AggregateError(
            [cause, rollbackCause],
            "Skill retention failed; package rollback could not prove safe removal.",
          );
        }
      }
      throw cause;
    }
    previews.delete(input.previewId);
    return result;
  };

  return {
    publishDirectory: async (sourcePath, retain) => {
      const staged = await preview({ path: sourcePath });
      try {
        return await withSkillPackageLifecycle(
          stateDir,
          async () =>
            (
              await importPackage({ previewId: staged.previewId }, async (result) => {
                await retain?.(result.package);
              })
            ).package,
        );
      } finally {
        previews.delete(staged.previewId);
      }
    },
    materializePreview: async (previewId, destination) => {
      const pending = previews.get(previewId);
      if (!pending || pending.expiresAt <= Date.now())
        throw new SkillPackageStoreError("Skill preview expired.", "preview_expired");
      const collected = await collectSource(pending.sourcePath);
      if (
        collected.realRoot !== pending.realRoot ||
        collected.package.packageId !== pending.packageId
      )
        throw new SkillPackageStoreError("Skill preview changed.", "preview_stale");
      await expertResourceFiles.copy(destination, collected.resources);
      return collected.package;
    },
    preview,
    cancelPreview: (previewId) => {
      previews.delete(previewId);
    },
    publishPreview: (previewId, retain) =>
      withSkillPackageLifecycle(
        stateDir,
        async () =>
          (
            await importPackage({ previewId }, async (result) => {
              await retain?.(result.package);
            })
          ).package,
      ),
    previewUpdate: (rawInput) =>
      withSkillPackageLifecycle(stateDir, async () => {
        await recoverPendingRemovals();
        const input = Schema.decodeUnknownSync(SkillPackageUpdatePreviewInput)(rawInput);
        const source = await readSource(input.sourceId);
        if (!source)
          throw new SkillPackageStoreError(
            `Skill source not found: ${input.sourceId}`,
            "not_found",
          );
        if (source.revision !== input.expectedRevision)
          throw new SkillPackageStoreError(
            "Skill source revision changed; reload before previewing an update.",
            "revision_conflict",
          );
        const previous = await read(source.packageId);
        const next = await preview({ path: source.sourcePath });
        previews.get(next.previewId)!.sourceRevision = source.revision;
        const before = new Map(previous.resources.map((entry) => [entry.path, entry]));
        const after = new Map(next.package.resources.map((entry) => [entry.path, entry]));
        const resourceChanges: SkillPackageUpdatePreview["resourceChanges"][number][] = [];
        for (const resourcePath of [...new Set([...before.keys(), ...after.keys()])].toSorted(
          ordinal,
        )) {
          const oldResource = before.get(resourcePath);
          const newResource = after.get(resourcePath);
          if (
            expertResourceFiles.stableJson(oldResource) !==
            expertResourceFiles.stableJson(newResource)
          ) {
            resourceChanges.push({
              path: resourcePath,
              change: !oldResource ? "added" : !newResource ? "removed" : "changed",
            });
          }
        }
        const oldEntries = new Set(previous.entries.map((entry) => entry.entryPath));
        const newEntries = new Set(next.package.entries.map((entry) => entry.entryPath));
        return {
          ...next,
          sourceId: source.sourceId,
          sourceRevision: source.revision,
          previousPackageId: source.packageId,
          addedEntries: [...newEntries].filter((entry) => !oldEntries.has(entry)),
          removedEntries: [...oldEntries].filter((entry) => !newEntries.has(entry)),
          changedEntries: [...newEntries].filter((entry) => {
            if (!oldEntries.has(entry)) return false;
            const directory = path.posix.dirname(entry);
            const prefix = directory === "." ? "content/" : `content/${directory}/`;
            return resourceChanges.some((change) => change.path.startsWith(prefix));
          }),
          resourceChanges,
        };
      }),
    import: (rawInput) =>
      withSkillPackageLifecycle(stateDir, async () => {
        await recoverPendingRemovals();
        const input = Schema.decodeUnknownSync(SkillPackageImportInput)(rawInput);
        const receiptPath = path.join(
          importsDir,
          `${expertResourceFiles.hashJson(input.idempotencyKey ?? input.previewId)}.json`,
        );
        const Receipt = SkillPackageImportRecord;
        const finish = async (receipt: typeof Receipt.Type) => {
          if (receipt.previewId !== input.previewId)
            throw new SkillPackageStoreError(
              "Import idempotency key was already used for another preview.",
              "revision_conflict",
            );
          await read(receipt.result.package.packageId);
          if (receipt.state === "pending") {
            const target = receipt.result.source;
            const current = await readSource(target.sourceId);
            if (
              expertResourceFiles.stableJson(current) !== expertResourceFiles.stableJson(target)
            ) {
              if ((current?.revision ?? 0) !== target.revision - 1)
                throw new SkillPackageStoreError(
                  "Skill source changed while completing an interrupted import.",
                  "revision_conflict",
                );
              await writePrivateFileAtomically(
                path.join(sourcesDir, `${target.sourceId}.json`),
                `${JSON.stringify(target, null, 2)}\n`,
              );
            }
            await writePrivateFileAtomically(
              receiptPath,
              `${JSON.stringify({ ...receipt, state: "complete" }, null, 2)}\n`,
            );
          }
          previews.delete(input.previewId);
          return receipt.result;
        };
        const publish = async (result: SkillPackageImportResult) => {
          // Journal before updating the source pointer. A lost reply or process
          // restart can complete publication without needing an in-memory preview.
          const receipt = { previewId: input.previewId, state: "pending" as const, result };
          await writePrivateFileAtomically(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
          await finish(receipt);
        };
        let receiptBytes: Buffer;
        try {
          receiptBytes = await expertResourceFiles.read(receiptPath);
        } catch (cause) {
          if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
          return importPackage(input, publish);
        }
        const receipt = Schema.decodeUnknownSync(Receipt)(
          JSON.parse(receiptBytes.toString("utf8")),
        );
        return finish(receipt);
      }),
    previewRemoval: (packageId) =>
      withSkillPackageLifecycle(stateDir, async () => {
        await recoverPendingRemovals();
        await read(packageId);
        try {
          return { packageId, references: await scanSkillPackageReferences(stateDir, packageId) };
        } catch (cause) {
          return {
            packageId,
            references: [cause instanceof Error ? cause.message : "Reference scan failed."],
          };
        }
      }),
    remove: async (packageId) => {
      assertPackageId(packageId);
      return withSkillPackageLifecycle(stateDir, async () => {
        const existing = await readRemovalJournal(packageId);
        if (existing) {
          if (existing.state === "pending") {
            await finishRemoval(existing);
            return;
          }
          try {
            await read(packageId);
          } catch (cause) {
            if (cause instanceof SkillPackageStoreError && cause.code === "not_found") return;
            throw cause;
          }
          // A completed record is an acknowledgement replay token only while its
          // package is absent. A later import may republish the same content ID;
          // retire the old token and begin a fresh, reference-checked removal.
          await fs.unlink(removalJournalPath(packageId));
          await syncDirectoryEntry(removalsDir);
        }

        await read(packageId);
        await assertSkillPackageUnreferenced(stateDir, packageId);
        // Validate and journal every source pointer before touching either the
        // pointers or immutable package tree. The outside source directories are
        // never modified; only these managed tracking records are removed.
        const sources: SkillPackageSource[] = [];
        for (const name of (await fs.readdir(sourcesDir)).toSorted(ordinal)) {
          if (!name.endsWith(".json"))
            throw new SkillPackageStoreError("Unknown skill source record.", "package_corrupt");
          const source = await readSource(name.slice(0, -5));
          if (!source)
            throw new SkillPackageStoreError("Skill source disappeared.", "package_corrupt");
          if (source.packageId === packageId) sources.push(source);
        }
        const journal: SkillPackageRemovalRecord = {
          schemaVersion: 1,
          packageId,
          state: "pending",
          sources,
        };
        await writeRemovalJournal(journal);
        await finishRemoval(journal);
      });
    },
    read,
    list: () =>
      withSkillPackageLifecycle(stateDir, async () => {
        await recoverPendingRemovals();
        const packages: SkillPackage[] = [];
        // read verifies the full content tree and retains up to MAX_BYTES of
        // buffers. Bound that work independently of the number of saved versions.
        for (const id of (await fs.readdir(packagesDir))
          .filter((id) => Schema.is(SkillPackageId)(id))
          .toSorted(ordinal)) {
          packages.push(await read(id));
        }
        return packages;
      }),
    listSources: () =>
      withSkillPackageLifecycle(stateDir, async () => {
        await recoverPendingRemovals();
        const result: SkillPackageSource[] = [];
        for (const name of (await fs.readdir(sourcesDir))
          .filter((name) => name.endsWith(".json"))
          .toSorted(ordinal)) {
          const source = await readSource(name.slice(0, -5));
          if (!source)
            throw new SkillPackageStoreError(
              `Skill source disappeared: ${name}`,
              "package_corrupt",
            );
          result.push(source);
        }
        return result;
      }),
    resolveSelections: async (rawSelections) => {
      const selections = Schema.decodeUnknownSync(
        Schema.Array(ExpertSkillSelection).check(Schema.isMaxLength(100)),
      )(rawSelections);
      if (selections.filter((entry) => entry.activation === "startup").length > 1)
        throw new SkillPackageStoreError(
          "An expert may select at most one startup skill.",
          "invalid_input",
        );
      const packages = new Map<string, SkillPackage>();
      const names = new Set<string>();
      const resolved: ResolvedExpertSkillEntry[] = [];
      for (const selection of selections) {
        let manifest = packages.get(selection.packageId);
        if (!manifest) {
          manifest = await read(selection.packageId);
          packages.set(selection.packageId, manifest);
        }
        const entry = manifest.entries.find((entry) => entry.entryPath === selection.entryPath);
        if (!entry)
          throw new SkillPackageStoreError(
            `Skill entry is not in package ${selection.packageId}: ${selection.entryPath}`,
            "invalid_input",
          );
        if (entry.incompatibleReason)
          throw new SkillPackageStoreError(
            `Incompatible skill ${entry.name}: ${entry.incompatibleReason}`,
            "invalid_input",
          );
        if (entry.disableModelInvocation && selection.activation === "startup")
          throw new SkillPackageStoreError(
            `Skill ${entry.name} disables automatic invocation and cannot be a startup entry.`,
            "invalid_input",
          );
        const key = entry.name.normalize("NFC").toLowerCase();
        if (names.has(key))
          throw new SkillPackageStoreError(
            `Duplicate selected skill name: ${entry.name}`,
            "invalid_input",
          );
        names.add(key);
        resolved.push({
          ...selection,
          name: entry.name,
          description: entry.description,
          sha256: manifest.resources.find(
            (resource) => resource.path === `content/${selection.entryPath}`,
          )!.sha256,
          ...(entry.disableModelInvocation !== undefined
            ? { disableModelInvocation: entry.disableModelInvocation }
            : {}),
          ...(entry.userInvocable !== undefined ? { userInvocable: entry.userInvocable } : {}),
          path: path.join(
            packagesDir,
            selection.packageId,
            "content",
            ...entry.entryPath.split("/"),
          ),
        });
      }
      return resolved;
    },
  };
}
