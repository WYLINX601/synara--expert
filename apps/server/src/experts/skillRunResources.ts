import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type {
  ProviderExpertSession,
  ResolvedExpertSkillEntry,
  SkillRunResourceReference,
} from "@synara/contracts";
import { expertResourceFiles } from "./ExpertStore";
import { syncDirectoryEntry } from "../privatePathPermissions";
import { verifyPinnedSkillReferences } from "./pinnedSkillReferences";

const digest = (text: string) => createHash("sha256").update(text).digest("hex");

export function skillPackageStateDir(session: ProviderExpertSession): string {
  const first = session.skillEntries?.[0];
  const inferred = first
    ? path.dirname(
        path.dirname(path.resolve(first.path, ...first.entryPath.split("/").map(() => ".."))),
      )
    : undefined;
  const root = session.skillsRoot ?? inferred;
  if (
    !root ||
    !path.isAbsolute(root) ||
    path.basename(root) !== "skill-packages" ||
    path.basename(path.dirname(root)) !== "experts"
  )
    throw new Error("Fixed Skill package storage root is invalid.");
  return path.dirname(path.dirname(root));
}

export function privateSkillResourceRoot(
  stateDir: string,
  ownerRootRunId: string,
  packageId: string,
): string {
  return path.join(
    stateDir,
    "experts",
    "run-skill-resources",
    digest(ownerRootRunId),
    packageId,
    "content",
  );
}

/** Keep source identities pinned; only native file access uses the working tree. */
export function skillRuntimeEntries(session: ProviderExpertSession): ResolvedExpertSkillEntry[] {
  return (session.skillEntries ?? []).map((entry) => {
    const reference = session.skillResourceRefs?.find((item) => item.packageId === entry.packageId);
    return reference
      ? { ...entry, path: path.join(reference.rootPath, ...entry.entryPath.split("/")) }
      : entry;
  });
}

async function assertDirectoryChain(root: string, relative: string): Promise<void> {
  const parts = relative.split("/");
  let current = root;
  for (const part of ["", ...parts.slice(0, -1)]) {
    if (part) current = path.join(current, part);
    const stat = await fs.lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error("Run Skill working tree has an unsafe directory.");
  }
}

async function safeWorkingDirectory(stateDir: string, target: string, create: boolean) {
  const relative = path.relative(stateDir, target);
  if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
    throw new Error("Run Skill working directory escapes its state home.");
  let current = stateDir;
  for (const part of ["", ...relative.split(path.sep)]) {
    if (part) current = path.join(current, part);
    let stat = await fs.lstat(current).catch((cause: unknown) => {
      if (create && (cause as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw cause;
    });
    if (!stat) {
      await fs.mkdir(current, { mode: 0o700 }).catch((cause: unknown) => {
        if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
      });
      stat = await fs.lstat(current);
    }
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error("Run Skill working directory contains an unsafe ancestor.");
  }
}

/** Output files may grow; the original inputs must still match their pinned source. */
export async function verifySkillRunResources(
  stateDir: string,
  entries: ReadonlyArray<ResolvedExpertSkillEntry>,
  references: ReadonlyArray<SkillRunResourceReference> = [],
): Promise<void> {
  await verifyPinnedSkillReferences(stateDir, entries);
  const privatePackages = new Set(
    entries.filter((entry) => entry.resourceMode === "run-private").map((entry) => entry.packageId),
  );
  if (
    references.length !== privatePackages.size ||
    new Set(references.map((item) => item.packageId)).size !== references.length
  )
    throw new Error("Run Skill resource references do not match the fixed assembly.");
  const { verifySkillPackageContent } = await import("./SkillPackageStore.ts");
  // Write permissions are a delivery property, not part of content identity.
  // Reusing a shared tree must never expose writable package inputs to a Run.
  if (process.platform !== "win32") {
    const sharedPackages = new Set(
      entries
        .filter((entry) => entry.resourceMode !== "run-private")
        .map((entry) => entry.packageId),
    );
    for (const packageId of sharedPackages) {
      const content = await verifySkillPackageContent(stateDir, packageId);
      for (const resourcePath of ["content", ...content.resources.map((item) => item.path)]) {
        const target = path.join(path.dirname(content.contentRoot), ...resourcePath.split("/"));
        const stat = await fs.lstat(target);
        if (stat.isSymbolicLink() || (stat.mode & 0o222) !== 0)
          throw new Error("Shared Skill resources must remain read-only before activation.");
      }
    }
  }
  for (const reference of references) {
    if (
      !privatePackages.has(reference.packageId) ||
      !reference.ownerRootRunId.trim() ||
      reference.rootPath !==
        privateSkillResourceRoot(stateDir, reference.ownerRootRunId, reference.packageId)
    )
      throw new Error("Run Skill working tree identity is invalid.");
    const content = await verifySkillPackageContent(stateDir, reference.packageId);
    try {
      await safeWorkingDirectory(stateDir, reference.rootPath, false);
      // Validate all fixed package inputs, rather than treating generated output
      // as part of the content-addressed source manifest.
      for (const resource of content.resources) {
        if (!resource.path.startsWith("content/")) continue;
        const relative = resource.path.slice("content/".length);
        await assertDirectoryChain(reference.rootPath, relative);
        const target = path.join(reference.rootPath, ...relative.split("/"));
        const stat = await fs.lstat(target);
        if (stat.isSymbolicLink()) throw new Error("Symbolic link replaced a fixed input.");
        if (resource.kind === "directory") {
          if (!stat.isDirectory()) throw new Error("Fixed directory changed.");
        } else {
          if (!stat.isFile() || stat.size !== resource.size)
            throw new Error("Fixed input size or type changed.");
          const bytes = await expertResourceFiles.read(
            target,
            await fs.realpath(reference.rootPath),
          );
          if (createHash("sha256").update(bytes).digest("hex") !== resource.sha256)
            throw new Error("Fixed input content changed.");
          if (
            process.platform !== "win32" &&
            resource.executable !== undefined &&
            ((stat.mode & 0o111) !== 0) !== resource.executable
          )
            throw new Error("Fixed input executable mode changed.");
        }
      }
    } catch (cause) {
      throw new Error(
        "Run Skill working copy drifted from its fixed inputs; outputs were preserved. Start a new Run after reviewing the changes.",
        { cause },
      );
    }
  }
}

/** Idempotent materialization. Continuations pass and retain the original references. */
export async function prepareSkillRunResources(
  stateDir: string,
  ownerRootRunId: string,
  entries: ReadonlyArray<ResolvedExpertSkillEntry>,
  inherited?: ReadonlyArray<SkillRunResourceReference>,
): Promise<SkillRunResourceReference[]> {
  if (inherited !== undefined) {
    await verifySkillRunResources(stateDir, entries, inherited);
    return [...inherited];
  }
  await verifyPinnedSkillReferences(stateDir, entries);
  const packageIds = [
    ...new Set(
      entries
        .filter((entry) => entry.resourceMode === "run-private")
        .map((entry) => entry.packageId),
    ),
  ].toSorted();
  const references: SkillRunResourceReference[] = [];
  const { verifySkillPackageContent } = await import("./SkillPackageStore.ts");
  for (const packageId of packageIds) {
    const content = await verifySkillPackageContent(stateDir, packageId);
    const rootPath = privateSkillResourceRoot(stateDir, ownerRootRunId, packageId);
    const packageRoot = path.dirname(rootPath);
    const parent = path.dirname(packageRoot);
    await safeWorkingDirectory(stateDir, parent, true);
    const existing = await fs.lstat(packageRoot).catch((cause: unknown) => {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw cause;
    });
    if (existing && (!existing.isDirectory() || existing.isSymbolicLink()))
      throw new Error("Run Skill working tree root is unsafe.");
    if (!existing) {
      const stage = path.join(parent, `.staging-${randomUUID()}`);
      await fs.mkdir(path.join(stage, "content"), { recursive: true, mode: 0o700 });
      try {
        for (const resource of content.resources) {
          if (!resource.path.startsWith("content/")) continue;
          const relative = resource.path.slice("content/".length);
          const target = path.join(stage, "content", ...relative.split("/"));
          if (resource.kind === "directory") {
            await fs.mkdir(target, { recursive: true, mode: 0o700 });
          } else {
            await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
            const bytes = await expertResourceFiles.read(
              path.join(content.contentRoot, ...relative.split("/")),
              await fs.realpath(content.contentRoot),
            );
            if (createHash("sha256").update(bytes).digest("hex") !== resource.sha256)
              throw new Error("Skill source changed while creating its working tree.");
            await fs.writeFile(target, bytes, {
              mode: resource.executable ? 0o700 : 0o600,
              flag: "wx",
            });
          }
        }
        try {
          await fs.rename(stage, packageRoot);
        } catch (cause) {
          const code = (cause as NodeJS.ErrnoException).code;
          if (code !== "EEXIST" && code !== "ENOTEMPTY") throw cause;
        }
        await syncDirectoryEntry(parent);
      } finally {
        await fs.rm(stage, { recursive: true, force: true });
      }
    }
    references.push({ packageId, mode: "run-private", ownerRootRunId, rootPath });
  }
  await verifySkillRunResources(stateDir, entries, references);
  return references;
}
