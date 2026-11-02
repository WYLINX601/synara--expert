import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import type {
  ProviderExpertSession,
  ResolvedExpertSkillEntry,
  SkillPackageResource,
} from "@synara/contracts";

import {
  skillPackageStateDir,
  skillRuntimeEntries,
  verifySkillRunResources,
} from "../experts/skillRunResources";
import {
  recordVerifiedNativeSkillAssembly,
  verifyFixedExpertAssembly,
  invalidateNativeSkillAssemblyVerification,
} from "./expertSkillCatalog";

const PROJECTION_VERSION = "fixed-skill-assembly-v5";
const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

export interface FixedSkillProjectionEntry {
  readonly packageId: string;
  readonly entryPath: string;
  readonly name: string;
  /** Provider-neutral identity; adapters may substitute a native namespace. */
  readonly nativeName: string;
  /** Runtime-visible file path (immutable source for shared, persistent root for private). */
  readonly path: string;
  /** Immutable package path retained for source identity and Claude allowlist mapping. */
  readonly originalPath: string;
  /** Path expected by the fixed assembly verifier for this session. */
  readonly runtimePath: string;
  readonly sha256: string;
  readonly originalName: string;
  readonly userInvocable?: boolean;
  readonly disableModelInvocation?: boolean;
}

export interface FixedSkillProjectionPackage {
  readonly packageId: string;
  readonly contentRoot: string;
  /** Full runtime tree: immutable package content or the persistent Run-private tree. */
  readonly sourceRoot: string;
  readonly resources: ReadonlyArray<SkillPackageResource>;
  readonly isPrivate: boolean;
}

export interface FixedSkillProjection {
  /** Deterministic host cache identity; this module does not materialize a view tree. */
  readonly root: string;
  /** Complete package roots. Native adapters apply their own selection allowlist. */
  readonly skillRoots: ReadonlyArray<string>;
  readonly packages: ReadonlyArray<FixedSkillProjectionPackage>;
  readonly entries: ReadonlyArray<FixedSkillProjectionEntry>;
}

function inferStateDir(entry: ResolvedExpertSkillEntry): string {
  const depth = entry.entryPath.split("/").length;
  const contentRoot = path.resolve(entry.path, ...Array.from({ length: depth }, () => ".."));
  const packageRoot = path.dirname(contentRoot);
  if (path.basename(contentRoot) !== "content" || path.basename(packageRoot) !== entry.packageId)
    throw new Error("Fixed Skill entry does not identify a package content root.");
  return path.resolve(packageRoot, "..", "..", "..");
}

function selectedRuntimeEntries(session: ProviderExpertSession): ResolvedExpertSkillEntry[] {
  const persisted = session.skillEntries ?? [];
  const runtime = skillRuntimeEntries(session);
  if (runtime.length !== persisted.length)
    throw new Error("Fixed Skill runtime entries do not match the pinned selection.");
  const persistedKeys = new Set(persisted.map((entry) => `${entry.packageId}\0${entry.entryPath}`));
  const runtimeKeys = new Set(runtime.map((entry) => `${entry.packageId}\0${entry.entryPath}`));
  if (persistedKeys.size !== persisted.length || runtimeKeys.size !== runtime.length)
    throw new Error("Fixed Skill assembly contains duplicate package entries.");
  return runtime;
}

/** Verify package references and return their complete, unmodified runtime roots. */
export async function createFixedSkillProjection(
  base: string,
  session: ProviderExpertSession,
): Promise<FixedSkillProjection> {
  if (!/^exp_[a-f0-9]{64}$/u.test(session.snapshotId))
    throw new Error("Invalid fixed Skill snapshot identity.");
  const selected = session.skillEntries ?? [];
  const runtimeEntries = selectedRuntimeEntries(session);
  const assemblyKey = session.skillAssemblyId?.trim() || session.snapshotId;
  const root = path.join(
    path.resolve(base),
    `${PROJECTION_VERSION}-${sha(assemblyKey).slice(0, 32)}`,
  );

  if (selected.length === 0) {
    await verifyFixedExpertAssembly(session, []);
    return { root, skillRoots: [], packages: [], entries: [] };
  }

  const stateDir = session.skillsRoot ? skillPackageStateDir(session) : inferStateDir(selected[0]!);
  await verifySkillRunResources(stateDir, selected, session.skillResourceRefs);
  await verifyFixedExpertAssembly(
    session,
    runtimeEntries.map((entry) => ({ name: entry.name, path: entry.path })),
  );

  const runtimeByKey = new Map(
    runtimeEntries.map((entry) => [`${entry.packageId}\0${entry.entryPath}`, entry]),
  );
  const packages = new Map<string, FixedSkillProjectionPackage>();
  const selectionsByPackage = new Map<string, ResolvedExpertSkillEntry[]>();
  const { verifySkillPackageContent } = await import("../experts/SkillPackageStore.ts");
  for (const entry of selected) {
    const group = selectionsByPackage.get(entry.packageId) ?? [];
    group.push(entry);
    selectionsByPackage.set(entry.packageId, group);
  }

  for (const [packageId, packageEntries] of selectionsByPackage) {
    const content = await verifySkillPackageContent(stateDir, packageId);
    const privateEntries = packageEntries.filter((entry) => entry.resourceMode === "run-private");
    if (privateEntries.length > 0 && privateEntries.length !== packageEntries.length)
      throw new Error("A fixed package cannot mix shared and Run-private entries.");
    const isPrivate = privateEntries.length > 0;
    const reference = isPrivate
      ? session.skillResourceRefs?.find((item) => item.packageId === packageId)
      : undefined;
    if (isPrivate && !reference)
      throw new Error(`Run-private Skill package ${packageId} has no persistent resource root.`);
    const sourceRoot = reference?.rootPath ?? content.contentRoot;
    const resourceByPath = new Map(content.resources.map((resource) => [resource.path, resource]));
    for (const entry of packageEntries) {
      const resource = resourceByPath.get(`content/${entry.entryPath}`);
      if (!resource || resource.kind !== "file")
        throw new Error(`Selected Skill entry is missing from package ${packageId}.`);
      if (entry.sha256 !== undefined && entry.sha256 !== resource.sha256)
        throw new Error(`Selected Skill hash differs from package ${packageId}.`);
      const runtimeEntry = runtimeByKey.get(`${entry.packageId}\0${entry.entryPath}`);
      const expectedRuntimePath = path.join(sourceRoot, ...entry.entryPath.split("/"));
      if (!runtimeEntry || runtimeEntry.path !== expectedRuntimePath)
        throw new Error(`Selected Skill runtime path differs from package ${packageId}.`);
    }
    packages.set(packageId, {
      packageId,
      contentRoot: content.contentRoot,
      sourceRoot,
      resources: content.resources,
      isPrivate,
    });
  }

  const entries: FixedSkillProjectionEntry[] = selected.map((entry) => {
    const resource = packages
      .get(entry.packageId)!
      .resources.find((candidate) => candidate.path === `content/${entry.entryPath}`)!;
    const runtimePath = runtimeByKey.get(`${entry.packageId}\0${entry.entryPath}`)!.path;
    return {
      packageId: entry.packageId,
      entryPath: entry.entryPath,
      name: entry.name,
      nativeName: entry.name,
      path: runtimePath,
      originalPath: entry.path,
      runtimePath,
      sha256: resource.sha256,
      originalName: entry.name,
      ...(entry.userInvocable !== undefined ? { userInvocable: entry.userInvocable } : {}),
      ...(entry.disableModelInvocation !== undefined
        ? { disableModelInvocation: entry.disableModelInvocation }
        : {}),
    };
  });

  return {
    root,
    skillRoots: [...new Set([...packages.values()].map((pkg) => pkg.sourceRoot))],
    packages: [...packages.values()],
    entries,
  };
}

export async function verifyProjectedSkillAssembly(
  session: ProviderExpertSession,
  projection: FixedSkillProjection,
  active: ReadonlyArray<{ readonly name: string; readonly path: string }>,
  lifecycleGeneration: string,
): Promise<void> {
  invalidateNativeSkillAssemblyVerification(session);
  const matched = new Set<string>();
  const mapped = active.map((item) => {
    const entry = projection.entries.find(
      (candidate) =>
        (item.name === candidate.name || item.name === candidate.nativeName) &&
        path.resolve(item.path) === path.resolve(candidate.path),
    );
    if (!entry) throw new Error(`Native catalog contains an unselected Skill: ${item.name}`);
    const key = `${entry.packageId}\0${entry.entryPath}`;
    if (matched.has(key)) throw new Error(`Native catalog duplicated selected Skill: ${item.name}`);
    matched.add(key);
    return {
      name: entry.originalName,
      path: entry.runtimePath,
    };
  });
  if (active.length !== projection.entries.length || matched.size !== projection.entries.length)
    throw new Error("Native catalog omitted a selected fixed Expert Skill.");
  for (const entry of projection.entries)
    if (sha(await fs.readFile(entry.path)) !== entry.sha256)
      throw new Error("Fixed Skill projection content changed.");
  await recordVerifiedNativeSkillAssembly(session, mapped, lifecycleGeneration);
}
