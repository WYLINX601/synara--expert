import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  ExpertSkillBinding,
  SkillDefinition,
  SkillId,
  SkillLibraryRequest,
  type SkillLibraryBindingResult,
  type SkillLibraryBindingState,
  type SkillLibraryItem,
  type SkillLibraryPlan,
  type SkillLibraryQuery,
  type SkillLibrarySourceFilter,
  type SkillLibraryUpdateResult,
  type ExpertSkillSelection,
  type ExpertDefinition,
  type SkillLibraryPreview,
  type SkillLibraryResponse,
  type SkillPackage,
  type SkillSource,
  type SkillEvolutionPolicy,
  type SkillScope,
  type SkillDerivation,
} from "@synara/contracts";
import { Schema } from "effect";
import YAML from "yaml";
import { ensurePrivateDirectorySync } from "../privatePathPermissions";
import { writePrivateFileAtomically } from "./ExpertMcpStorage";
import { createExpertStore, ExpertStoreError, expertResourceFiles } from "./ExpertStore";
import {
  createSkillLibraryOperations,
  SkillLibraryRequestIdConflict,
  type SkillLibraryDeleteIntent,
} from "./SkillLibraryOperations";
import { createSkillPackageStore, SkillPackageStoreError } from "./SkillPackageStore";
import { withSkillPackageLifecycle } from "./skillPackageLifecycle";
import { retainSkillEvolutionPackagesUnlocked } from "./skillEvolutionPackagePins";
import {
  assertSkillEvolutionConfiguration,
  assertSkillScopeForExpert,
} from "./skillEvolutionPolicy";
import {
  assertSkillResourcePath,
  downloadSkillSource,
  extractSkillArchive,
  SKILL_FILE_LIMIT,
  SKILL_PACKAGE_LIMIT,
} from "./skillLibraryArchive";

const Registry = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  skills: Schema.Array(SkillDefinition),
});
const pendingWrites = new Map<string, Promise<unknown>>();
const registryPath = (stateDir: string) => path.join(stateDir, "experts", "skill-library.json");
export type SkillLibraryMutationEffect = {
  readonly expertBindings?: boolean;
};
export type SkillLibraryExecutionContext = {
  /** Supplied by a trusted server owner principal, never by the request payload. */
  readonly actor?: string;
  /** Trusted server-only retention request; never accepted from the RPC payload. */
  readonly retainForEvolution?: boolean;
  /** Revalidate the caller immediately before each persistent mutation. */
  readonly beforeMutation?: (effect?: SkillLibraryMutationEffect) => Promise<void>;
};

const stableJson = (value: unknown): string => {
  const sort = (item: unknown): unknown =>
    Array.isArray(item)
      ? item.map(sort)
      : item !== null && typeof item === "object"
        ? Object.fromEntries(
            Object.entries(item)
              .sort(([left], [right]) => left.localeCompare(right))
              .map(([key, child]) => [key, sort(child)]),
          )
        : item;
  return JSON.stringify(sort(value));
};
const matchesExpertIntent = (
  actual: ExpertDefinition,
  intent: {
    expectedRevision: number;
    expectedExpert: ExpertDefinition;
    bindings: ReadonlyArray<ExpertSkillBinding>;
  },
) =>
  actual.revision === intent.expectedRevision + 1 &&
  stableJson(actual.skillBindings ?? []) === stableJson(intent.bindings) &&
  stableJson({
    ...actual,
    revision: intent.expectedExpert.revision,
    updatedAt: intent.expectedExpert.updatedAt,
    skillBindings: intent.expectedExpert.skillBindings,
  }) === stableJson(intent.expectedExpert);
const fingerprint = (value: unknown) =>
  createHash("sha256").update(stableJson(value)).digest("hex");
const hasOptionalWriteRequestId = (
  request: SkillLibraryRequest,
): request is Extract<
  SkillLibraryRequest,
  {
    action:
      | "create"
      | "configureEvolution"
      | "derive"
      | "save"
      | "import"
      | "refresh"
      | "delete"
      | "batch";
  }
> =>
  request.action === "create" ||
  request.action === "configureEvolution" ||
  request.action === "derive" ||
  request.action === "save" ||
  request.action === "import" ||
  request.action === "refresh" ||
  request.action === "delete" ||
  request.action === "batch";
const needsLegacyConversion = (expert: ExpertDefinition) =>
  expert.skillBindings === undefined &&
  (expert.skills.length > 0 || !!expert.skillSelections?.length);
const expertSaveInput = (
  expert: ExpertDefinition,
  skillBindings: ReadonlyArray<ExpertSkillBinding>,
) => ({
  id: expert.id,
  expectedRevision: expert.revision,
  name: expert.name,
  description: expert.description,
  useCases: expert.useCases,
  persona: expert.persona,
  outputRequirements: expert.outputRequirements,
  skills: expert.skills,
  ...(expert.skillSelections !== undefined ? { skillSelections: expert.skillSelections } : {}),
  skillBindings,
  references: expert.references,
  connections: expert.connections,
  ...(expert.preferredProvider !== undefined
    ? { preferredProvider: expert.preferredProvider }
    : {}),
});
function skillLibrarySourceFilter(skill: SkillDefinition): SkillLibrarySourceFilter | undefined {
  if (
    skill.source.kind === "manual" ||
    skill.source.kind === "local" ||
    skill.source.kind === "archive" ||
    skill.source.kind === "runtime"
  )
    return skill.source.kind;
  try {
    const hostname = new URL(skill.source.location).hostname.replace(/^www\./u, "");
    if (hostname === "skills.sh") return "skills.sh";
    if (hostname === "clawhub.ai" || hostname === "clawhub.com") return "clawhub";
    if (hostname === "github.com") return "github";
  } catch {
    /* Malformed historical source metadata has no normalized source filter. */
  }
  return undefined;
}
const refreshableSource = (skill: SkillDefinition) => {
  if (skill.source.kind !== "url") return false;
  try {
    return ["github.com", "skills.sh", "clawhub.ai", "clawhub.com"].includes(
      new URL(skill.source.location).hostname.replace(/^www\./u, ""),
    );
  } catch {
    return false;
  }
};
export async function readSkillLibraryDefinitions(stateDir: string): Promise<SkillDefinition[]> {
  try {
    return [
      ...Schema.decodeUnknownSync(Registry)(
        JSON.parse((await expertResourceFiles.read(registryPath(stateDir))).toString("utf8")),
      ).skills,
    ];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}
export async function readSkillDefinition(
  stateDir: string,
  skillId: string,
): Promise<SkillDefinition> {
  Schema.decodeUnknownSync(SkillId)(skillId);
  const definition = (await readSkillLibraryDefinitions(stateDir)).find(
    (item) => item.skillId === skillId && !item.deleted,
  );
  if (!definition) throw new Error(`Skill not found or deleted: ${skillId}`);
  return definition;
}
export async function resolveSkillBindings(
  stateDir: string,
  rawBindings: ReadonlyArray<ExpertSkillBinding>,
  expertId?: string,
): Promise<ExpertSkillSelection[]> {
  const bindings = Schema.decodeUnknownSync(
    Schema.Array(ExpertSkillBinding).check(Schema.isMaxLength(100)),
  )(rawBindings);
  if (new Set(bindings.map((binding) => binding.skillId)).size !== bindings.length)
    throw new Error("Duplicate Skill binding.");
  if (bindings.filter((binding) => binding.enabled && binding.activation === "startup").length > 1)
    throw new Error("An Expert can enable at most one startup Skill.");
  const skills = await Promise.all(
    bindings.map((binding) => readSkillDefinition(stateDir, binding.skillId)),
  );
  if (expertId !== undefined)
    for (const skill of skills) assertSkillScopeForExpert(skill, expertId);
  return bindings.flatMap((binding, index) =>
    binding.enabled
      ? [
          {
            packageId: skills[index]!.packageId,
            entryPath: skills[index]!.entryPath,
            activation: binding.activation,
          },
        ]
      : [],
  );
}

async function renameEntry(file: string, name: string, description?: string): Promise<void> {
  const text = (await fs.readFile(file)).toString("utf8"),
    match = /^---\s*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(text);
  const parsed: unknown = match ? YAML.parse(match[1]!, { logLevel: "error" }) : {};
  if (parsed !== null && (typeof parsed !== "object" || Array.isArray(parsed)))
    throw new Error("Skill frontmatter must be a mapping before renaming.");
  await fs.writeFile(
    file,
    `---\n${YAML.stringify({ ...((parsed as object) ?? {}), name, ...(description !== undefined ? { description } : {}) })}---\n${match ? text.slice(match[0].length) : text}`,
  );
}

const libraryInstances = new Map<string, ReturnType<typeof makeSkillLibraryStore>>();
export function createSkillLibraryStore(stateDir: string) {
  if (!path.isAbsolute(stateDir))
    throw new Error("Skill library state directory must be absolute.");
  const key = path.resolve(stateDir),
    existing = libraryInstances.get(key);
  if (existing) return existing;
  const store = makeSkillLibraryStore(stateDir);
  libraryInstances.set(key, store);
  return store;
}
function assertNoActivePrivateDerivation(
  definitions: ReadonlyArray<SkillDefinition>,
  sourceSkillId: string,
  expertId: string,
  allowedSkillId?: string,
) {
  const existing = definitions.find(
    (skill) =>
      !skill.deleted &&
      skill.skillId !== allowedSkillId &&
      skill.scope?.kind === "expert" &&
      skill.scope.expertId === expertId &&
      skill.derivedFrom?.skillId === sourceSkillId,
  );
  if (existing)
    throw new Error(
      `This Expert already has a private derived copy of the source Skill (${existing.skillId}); continue with that copy or resolve it before deriving again.`,
    );
}

function makeSkillLibraryStore(stateDir: string) {
  if (!path.isAbsolute(stateDir))
    throw new Error("Skill library state directory must be absolute.");
  const packages = createSkillPackageStore(stateDir),
    staging = path.join(stateDir, "experts", "skill-library-staging"),
    operations = createSkillLibraryOperations(stateDir);
  ensurePrivateDirectorySync(staging);
  type Pending = {
    preview: SkillLibraryPreview;
    packagePreviewId: string;
    ownedRoot?: string;
    skillId?: string;
    revision?: number;
  };
  const previews = new Map<string, Pending>();
  const activePreviews = new Map<string, Set<AbortController>>();
  const activeRequests = new Set<Promise<unknown>>();
  const track = <T>(operation: Promise<T>): Promise<T> => {
    activeRequests.add(operation);
    return operation.finally(() => activeRequests.delete(operation));
  };
  let disposal: Promise<void> | undefined;
  const lock = <T>(operation: () => Promise<T>): Promise<T> => {
    const key = path.resolve(stateDir),
      result = (pendingWrites.get(key) ?? Promise.resolve()).then(operation);
    const settled = result.then(
      () => undefined,
      () => undefined,
    );
    pendingWrites.set(key, settled);
    void settled.then(() => {
      if (pendingWrites.get(key) === settled) pendingWrites.delete(key);
    });
    return result;
  };
  const writeRegistry = (
    skills: SkillDefinition[],
    lifecycleHeld = false,
    beforeMutation?: () => Promise<void>,
  ) => {
    const serialized = `${JSON.stringify({ schemaVersion: 1, skills }, null, 2)}\n`;
    if (Buffer.byteLength(serialized, "utf8") > SKILL_FILE_LIMIT)
      throw new Error("Skill library registry exceeds the 16 MiB read limit.");
    const write = async () => {
      await beforeMutation?.();
      await writePrivateFileAtomically(registryPath(stateDir), serialized);
    };
    return lifecycleHeld ? write() : withSkillPackageLifecycle(stateDir, write);
  };
  const rootPath = (packageId: string) =>
    path.join(stateDir, "experts", "skill-packages", packageId, "content");
  const cleanup = async (id: string) => {
    const pending = previews.get(id);
    previews.delete(id);
    if (pending) packages.cancelPreview(pending.packagePreviewId);
    if (pending?.ownedRoot) await fs.rm(pending.ownedRoot, { recursive: true, force: true });
  };
  const expire = async () => {
    for (const [id, pending] of previews)
      if (Date.parse(pending.preview.expiresAt) <= Date.now()) await cleanup(id);
  };
  const revision = async (skillId: string, expected: number) => {
    const item = await readSkillDefinition(stateDir, skillId);
    if (item.revision !== expected)
      throw new Error("Skill revision changed; reload before saving.");
    return item;
  };
  const commit = (
    items: SkillDefinition[],
    lifecycleHeld = false,
    beforeMutation?: () => Promise<void>,
  ) => {
    const publish = async () => {
      const current = await readSkillLibraryDefinitions(stateDir),
        ids = new Set(items.map((item) => item.skillId)),
        next = [...current.filter((item) => !ids.has(item.skillId)), ...items],
        nextById = new Map(next.map((item) => [item.skillId, item]));
      for (const item of items) {
        const previous = current.find((entry) => entry.skillId === item.skillId);
        if ((previous?.revision ?? 0) !== item.revision - 1)
          throw new ExpertStoreError(
            "Skill revision changed; reload before publishing.",
            "revision_conflict",
          );
      }
      // Expert saves share this lifecycle lock. Validate the proposed head while
      // both its package and the complete set of affected bindings are stable.
      for (const expert of await createExpertStore(stateDir).list()) {
        if (!expert.skillBindings?.some((binding) => ids.has(binding.skillId))) continue;
        const selections: ExpertSkillSelection[] = [];
        for (const binding of expert.skillBindings) {
          const skill =
            nextById.get(binding.skillId) ?? (await readSkillDefinition(stateDir, binding.skillId));
          if (skill.deleted) throw new Error(`Skill not found or deleted: ${binding.skillId}`);
          assertSkillScopeForExpert(skill, expert.id);
          if (binding.enabled)
            selections.push({
              packageId: skill.packageId,
              entryPath: skill.entryPath,
              activation: binding.activation,
            });
        }
        await packages.resolveSelections(selections);
      }
      await writeRegistry(next, true, beforeMutation);
    };
    return lifecycleHeld ? publish() : withSkillPackageLifecycle(stateDir, publish);
  };
  const recoverPlannedSkills = async (
    plannedSkills: ReadonlyArray<SkillDefinition>,
    context: SkillLibraryExecutionContext,
  ): Promise<SkillDefinition[] | undefined> => {
    const current = await readSkillLibraryDefinitions(stateDir),
      byId = new Map(current.map((skill) => [skill.skillId, skill])),
      alreadyCommitted = plannedSkills.every(
        (planned) => stableJson(byId.get(planned.skillId)) === stableJson(planned),
      );
    if (alreadyCommitted) return plannedSkills.map((planned) => byId.get(planned.skillId)!);
    for (const planned of plannedSkills) {
      const actual = byId.get(planned.skillId);
      if (stableJson(actual) === stableJson(planned)) continue;
      const expectedRevision = planned.revision - 1;
      if (
        (expectedRevision === 0 && actual !== undefined) ||
        (expectedRevision > 0 &&
          (!actual || actual.deleted || actual.revision !== expectedRevision))
      )
        throw new ExpertStoreError(
          "Skill revision changed; reload before recovering this operation.",
          "revision_conflict",
        );
    }
    try {
      await Promise.all(plannedSkills.map((planned) => packages.read(planned.packageId)));
    } catch (cause) {
      if (cause instanceof SkillPackageStoreError && cause.code === "not_found") return undefined;
      throw cause;
    }
    const pending = plannedSkills.filter(
      (planned) => stableJson(byId.get(planned.skillId)) !== stableJson(planned),
    );
    if (pending.length) await commit([...pending], false, context.beforeMutation);
    const recovered = await readSkillLibraryDefinitions(stateDir),
      recoveredById = new Map(recovered.map((skill) => [skill.skillId, skill]));
    if (
      !plannedSkills.every(
        (planned) => stableJson(recoveredById.get(planned.skillId)) === stableJson(planned),
      )
    )
      throw new Error("Skill operation recovery did not produce the planned library state.");
    return plannedSkills.map((planned) => recoveredById.get(planned.skillId)!);
  };
  const makeItem = (input: {
    pkg: SkillPackage;
    entryPath: string;
    source: SkillSource;
    skillId?: string;
    name?: string;
    tags?: ReadonlyArray<string>;
    previous?: SkillDefinition;
    modified?: boolean;
    actor?: string;
    evolutionPolicy?: SkillEvolutionPolicy;
    scope?: SkillScope;
    derivedFrom?: SkillDerivation;
  }): SkillDefinition => {
    const entry = input.pkg.entries.find((entry) => entry.entryPath === input.entryPath);
    if (!entry) throw new Error("Selected Skill entry disappeared or is ambiguous.");
    return Schema.decodeUnknownSync(SkillDefinition)({
      skillId:
        input.previous?.skillId ?? input.skillId ?? `skl_${randomUUID().replaceAll("-", "")}`,
      name: input.name ?? entry.name,
      description: entry.description,
      tags: [...new Set(input.tags ?? input.previous?.tags ?? [])],
      packageId: input.pkg.packageId,
      entryPath: input.entryPath,
      source: input.source,
      locallyModified: input.modified ?? false,
      revision: (input.previous?.revision ?? 0) + 1,
      deleted: false,
      updatedAt: new Date().toISOString(),
      ...(input.previous
        ? {
            ...(input.previous.createdAt !== undefined
              ? { createdAt: input.previous.createdAt }
              : {}),
            ...(input.previous.createdBy !== undefined
              ? { createdBy: input.previous.createdBy }
              : {}),
            ...(input.previous.evolutionPolicy !== undefined
              ? { evolutionPolicy: input.previous.evolutionPolicy }
              : {}),
            ...(input.previous.scope !== undefined ? { scope: input.previous.scope } : {}),
            ...(input.previous.derivedFrom !== undefined
              ? { derivedFrom: input.previous.derivedFrom }
              : {}),
          }
        : {
            createdAt: new Date().toISOString(),
            createdBy: input.actor ?? "owner",
            evolutionPolicy: input.evolutionPolicy ?? "protected",
            scope: input.scope ?? { kind: "shared" },
            ...(input.derivedFrom !== undefined ? { derivedFrom: input.derivedFrom } : {}),
          }),
    });
  };
  const previewSource = async (
    location: string,
    kind: "local" | "url" | "runtime",
    current?: SkillDefinition,
    signal?: AbortSignal,
    requestId?: string,
  ): Promise<SkillLibraryPreview> => {
    if (signal?.aborted) throw new Error("Skill preview cancelled.");
    await expire();
    if (previews.size >= 100) throw new Error("Too many pending Skill previews.");
    let packagePreviewId: string | undefined;
    let sourcePath = location,
      ownedRoot: string | undefined,
      sourceKind: SkillSource["kind"] = kind;
    let remote: Awaited<ReturnType<typeof downloadSkillSource>> | undefined;
    try {
      if (kind === "url") {
        ownedRoot = await fs.mkdtemp(path.join(staging, "import-"));
        remote = await downloadSkillSource(location, ownedRoot, signal);
        sourcePath = remote.root;
        location = remote.canonicalLocation;
      } else if (/\.(?:zip|skill)$/iu.test(location)) {
        const stat = await fs.lstat(location);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > SKILL_PACKAGE_LIMIT)
          throw new Error("Unsafe or oversized Skill archive.");
        const bytes = await fs.readFile(location);
        if (bytes.length > SKILL_PACKAGE_LIMIT) throw new Error("Oversized Skill archive.");
        ownedRoot = await fs.mkdtemp(path.join(staging, "import-"));
        sourcePath = path.join(ownedRoot, "package");
        await fs.mkdir(sourcePath, { mode: 0o700 });
        await extractSkillArchive(bytes, sourcePath);
        sourceKind = "archive";
      }
      const result = await packages.preview({ path: sourcePath });
      packagePreviewId = result.previewId;
      if (signal?.aborted) throw new Error("Skill preview cancelled.");
      const remoteMatches = remote?.skillName
        ? result.package.entries.filter(
            (entry) =>
              entry.name === remote!.skillName ||
              path.posix.basename(path.posix.dirname(entry.entryPath)) === remote!.skillName ||
              (entry.entryPath === "SKILL.md" && path.basename(sourcePath) === remote!.skillName),
          )
        : undefined;
      if (remoteMatches && remoteMatches.length !== 1)
        throw new Error(
          "Skills.sh source entry disappeared or is ambiguous; use an exact GitHub Skill directory URL.",
        );
      if (current && remoteMatches && remoteMatches[0]!.entryPath !== current.source.entryPath)
        throw new Error("Source Skill entry identity changed; review a replacement explicitly.");
      if (
        current &&
        !result.package.entries.some((entry) => entry.entryPath === current.source.entryPath)
      )
        throw new Error(
          "Source Skill entry disappeared; select and review the replacement explicitly.",
        );
      const previous = current ? await packages.read(current.packageId) : undefined;
      const before = new Map(
          previous?.resources.map((resource) => [resource.path, resource.sha256]) ?? [],
        ),
        after = new Map(
          result.package.resources.map((resource) => [resource.path, resource.sha256]),
        );
      const preview: SkillLibraryPreview = {
        previewId: requestId ?? randomUUID(),
        package: result.package,
        expiresAt: result.expiresAt,
        source: {
          kind: sourceKind,
          location,
          ...(remote ? { resolvedRevision: remote.resolvedRevision } : {}),
          packageId: result.package.packageId,
          entryPath:
            current?.source.entryPath ??
            remoteMatches?.[0]?.entryPath ??
            result.package.entries[0]!.entryPath,
        },
        ...(remoteMatches
          ? { selectedEntryPaths: remoteMatches.map((entry) => entry.entryPath) }
          : {}),
        resourceChanges: [...new Set([...before.keys(), ...after.keys()])].filter(
          (name) => before.get(name) !== after.get(name),
        ),
        overwritesLocalEdits: current?.locallyModified ?? false,
      };
      if (previews.size >= 100) throw new Error("Too many pending Skill previews.");
      previews.set(preview.previewId, {
        preview,
        packagePreviewId: result.previewId,
        ...(ownedRoot ? { ownedRoot } : {}),
        ...(current ? { skillId: current.skillId, revision: current.revision } : {}),
      });
      return preview;
    } catch (error) {
      if (packagePreviewId) packages.cancelPreview(packagePreviewId);
      if (ownedRoot) await fs.rm(ownedRoot, { recursive: true, force: true });
      throw error;
    }
  };
  const pendingPreview = async (id: string) => {
    await expire();
    const item = previews.get(id);
    if (!item) throw new Error("Skill preview expired or was cancelled; preview again.");
    return item;
  };
  const edit = async (
    request: Extract<SkillLibraryRequest, { action: "save" }>,
    context: SkillLibraryExecutionContext,
    journal?: { requestId: string; fingerprint: string },
  ): Promise<{ skill?: SkillDefinition; plan?: SkillLibraryPlan }> => {
    const current = await readSkillDefinition(stateDir, request.skillId);
    if (journal) {
      const record = await operations.read(journal.requestId);
      if (record?.plannedSkill) {
        const recovered = await recoverPlannedSkills([record.plannedSkill], context);
        if (recovered) return { skill: recovered[0]! };
      }
      if (
        record?.plannedPackageId === current.packageId &&
        record.plannedRevision === current.revision &&
        current.revision === request.expectedRevision + 1
      )
        return { skill: current };
    }
    if (current.revision !== request.expectedRevision)
      throw new Error("Skill revision changed; reload before saving.");
    if (journal && context.retainForEvolution)
      await operations.recordPlan(journal.requestId, "save", journal.fingerprint, {
        evolutionPackageIds: [current.packageId],
      });
    const pkg = await packages.read(current.packageId);
    const owned = await fs.mkdtemp(path.join(staging, "edit-")),
      directory = path.join(owned, pkg.rootName);
    await fs.mkdir(directory, { mode: 0o700 });
    try {
      for (const resource of pkg.resources) {
        const relative = resource.path.slice("content/".length);
        if (!relative) continue;
        const target = path.join(directory, ...relative.split("/"));
        if (resource.kind === "directory") await fs.mkdir(target, { recursive: true, mode: 0o700 });
        else {
          await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
          await fs.writeFile(
            target,
            await expertResourceFiles.read(
              path.join(rootPath(pkg.packageId), ...relative.split("/")),
            ),
            { mode: resource.executable ? 0o700 : 0o600 },
          );
        }
      }
      const changed = new Set<string>();
      for (const change of request.changes) {
        assertSkillResourcePath(change.path);
        const key = change.path.normalize("NFC").toLowerCase();
        if (changed.has(key)) throw new Error("Duplicate file change.");
        changed.add(key);
        const target = path.join(directory, ...change.path.split("/"));
        if (change.content === undefined) {
          await fs.rm(target, { force: true });
          continue;
        }
        const bytes = Buffer.from(change.content, "base64");
        if (bytes.toString("base64") !== change.content || bytes.length > SKILL_FILE_LIMIT)
          throw new Error("Invalid base64 or resource exceeds 16 MiB.");
        await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
        await fs.writeFile(target, bytes, { mode: change.executable ? 0o700 : 0o600 });
        const prior = pkg.resources.find((resource) => resource.path === `content/${change.path}`);
        await fs.chmod(target, (change.executable ?? prior?.executable) ? 0o700 : 0o600);
      }
      if (request.name !== current.name || request.description !== undefined)
        await renameEntry(
          path.join(directory, ...current.entryPath.split("/")),
          request.name,
          request.description,
        );
      if (request.dryRun) {
        const preview = await packages.preview({ path: directory });
        packages.cancelPreview(preview.previewId);
        const candidate = makeItem({
          pkg: preview.package,
          entryPath: current.entryPath,
          source: current.source,
          tags: request.tags,
          previous: current,
          modified:
            current.locallyModified || preview.package.packageId !== current.source.packageId,
        });
        return {
          plan: {
            operation: "save",
            status:
              candidate.packageId === current.packageId
                ? ("unchanged" as const)
                : ("would_change" as const),
            skillId: current.skillId,
            revision: current.revision,
            packageId: candidate.packageId,
          },
        };
      }
      let item!: SkillDefinition;
      await context.beforeMutation?.();
      await packages.publishDirectory(directory, async (next) => {
        item = makeItem({
          pkg: next,
          entryPath: current.entryPath,
          source: current.source,
          tags: request.tags,
          previous: current,
          modified: current.locallyModified || next.packageId !== current.source.packageId,
        });
        if (journal)
          await operations.recordPlan(journal.requestId, "save", journal.fingerprint, {
            plannedSkillId: current.skillId,
            plannedRevision: current.revision + 1,
            plannedPackageId: next.packageId,
            plannedSkill: item,
            ...(context.retainForEvolution
              ? { evolutionPackageIds: [current.packageId, next.packageId] }
              : {}),
          });
        if (context.retainForEvolution)
          await retainSkillEvolutionPackagesUnlocked(stateDir, [current.packageId, next.packageId]);
        await commit([item], true, context.beforeMutation);
      });
      return { skill: item };
    } finally {
      await fs.rm(owned, { recursive: true, force: true });
    }
  };
  const configureEvolution = async (
    request: Extract<SkillLibraryRequest, { action: "configureEvolution" }>,
    context: SkillLibraryExecutionContext,
    journal?: { requestId: string; fingerprint: string },
  ): Promise<{ skill: SkillDefinition }> => {
    if (journal) {
      const prior = await operations.read(journal.requestId);
      if (prior?.plannedSkill) {
        const recovered = await recoverPlannedSkills([prior.plannedSkill], context);
        if (recovered) return { skill: recovered[0]! };
      }
    }
    const current = await revision(request.skillId, request.expectedRevision);
    assertSkillEvolutionConfiguration({
      current,
      evolutionPolicy: request.evolutionPolicy,
      scope: request.scope,
    });
    if (
      current.evolutionPolicy === request.evolutionPolicy &&
      stableJson(current.scope) === stableJson(request.scope)
    )
      return { skill: current };
    const planned: SkillDefinition = Schema.decodeUnknownSync(SkillDefinition)({
      ...current,
      evolutionPolicy: request.evolutionPolicy,
      scope: request.scope,
      revision: current.revision + 1,
      updatedAt: new Date().toISOString(),
    });
    await context.beforeMutation?.();
    if (journal)
      await operations.recordPlan(journal.requestId, "configureEvolution", journal.fingerprint, {
        plannedSkillId: planned.skillId,
        plannedRevision: planned.revision,
        plannedPackageId: planned.packageId,
        plannedSkill: planned,
      });
    await commit([planned], false, context.beforeMutation);
    return { skill: planned };
  };
  const deriveSkill = async (
    request: Extract<SkillLibraryRequest, { action: "derive" }>,
    context: SkillLibraryExecutionContext,
    journal?: { requestId: string; fingerprint: string },
  ): Promise<{ skill: SkillDefinition }> => {
    const prior = journal ? await operations.read(journal.requestId) : undefined;
    if (prior?.plannedSkill) {
      const planned = prior.plannedSkill,
        scope = planned.scope,
        derivation = planned.derivedFrom;
      const recoveryContext: SkillLibraryExecutionContext =
        scope?.kind === "expert" && derivation
          ? {
              ...context,
              beforeMutation: async (effect) => {
                assertNoActivePrivateDerivation(
                  await readSkillLibraryDefinitions(stateDir),
                  derivation.skillId,
                  scope.expertId,
                  planned.skillId,
                );
                await context.beforeMutation?.(effect);
              },
            }
          : context;
      const recovered = await recoverPlannedSkills([planned], recoveryContext);
      if (recovered) return { skill: recovered[0]! };
    }
    const validateSource = async () => {
      const current = await revision(request.sourceSkillId, request.expectedRevision);
      assertSkillScopeForExpert(current, request.expertId);
      const expert = await createExpertStore(stateDir).read(request.expertId);
      if (!expert || expert.archived) throw new Error("Active target Expert not found.");
      if (needsLegacyConversion(expert))
        throw new Error("Convert the target Expert's Skill configuration before deriving.");
      if (!expert.skillBindings?.some((binding) => binding.skillId === current.skillId))
        throw new Error("The source Skill must be bound to the target Expert before deriving.");
      assertNoActivePrivateDerivation(
        await readSkillLibraryDefinitions(stateDir),
        request.sourceSkillId,
        request.expertId,
      );
      const duplicateName = (await readSkillLibraryDefinitions(stateDir)).some(
        (skill) =>
          !skill.deleted &&
          skill.name.normalize("NFC").toLowerCase() === request.name.normalize("NFC").toLowerCase(),
      );
      if (duplicateName)
        throw new Error("A Skill with this name already exists; choose a unique derived name.");
      if (context.retainForEvolution)
        await retainSkillEvolutionPackagesUnlocked(stateDir, [current.packageId]);
      return current;
    };
    const source = prior?.plannedSkill
      ? undefined
      : await withSkillPackageLifecycle(stateDir, validateSource);
    if (source) {
      assertSkillScopeForExpert(source, request.expertId);
    }
    const sourcePackageId = prior?.plannedSkill?.derivedFrom?.packageId ?? source?.packageId;
    const entryPath = prior?.plannedSkill?.entryPath ?? source?.entryPath;
    if (!sourcePackageId || !entryPath)
      throw new Error("The planned derivation has no immutable source package.");
    let plannedSkillId = prior?.plannedSkillId;
    if (journal && !plannedSkillId) {
      plannedSkillId = `skl_${randomUUID().replaceAll("-", "")}`;
      await operations.recordPlan(journal.requestId, "derive", journal.fingerprint, {
        plannedSkillId,
        ...(context.retainForEvolution && sourcePackageId
          ? { evolutionPackageIds: [sourcePackageId] }
          : {}),
      });
    } else if (journal && context.retainForEvolution && sourcePackageId) {
      await operations.recordPlan(journal.requestId, "derive", journal.fingerprint, {
        evolutionPackageIds: [sourcePackageId],
      });
    }
    const sourcePackage = await packages.read(sourcePackageId),
      owned = await fs.mkdtemp(path.join(staging, "derive-")),
      directory = path.join(owned, sourcePackage.rootName);
    await fs.mkdir(directory, { mode: 0o700 });
    try {
      for (const resource of sourcePackage.resources) {
        const relative = resource.path.slice("content/".length);
        if (!relative) continue;
        const target = path.join(directory, ...relative.split("/"));
        if (resource.kind === "directory") await fs.mkdir(target, { recursive: true, mode: 0o700 });
        else {
          await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
          await fs.writeFile(
            target,
            await expertResourceFiles.read(
              path.join(rootPath(sourcePackageId), ...relative.split("/")),
            ),
            { mode: resource.executable ? 0o700 : 0o600 },
          );
        }
      }
      const changed = new Set<string>();
      for (const change of request.changes) {
        assertSkillResourcePath(change.path);
        const key = change.path.normalize("NFC").toLowerCase();
        if (changed.has(key)) throw new Error("Duplicate file change.");
        changed.add(key);
        const target = path.join(directory, ...change.path.split("/")),
          resourcePath = `content/${change.path}`,
          previousResource = sourcePackage.resources.find(
            (resource) => resource.path === resourcePath,
          );
        if (previousResource?.kind === "directory")
          throw new Error(`Skill changes must target files: ${change.path}`);
        if (change.content === undefined) {
          if (change.path === entryPath)
            throw new Error("The selected Skill entry cannot be deleted during derivation.");
          await fs.rm(target, { force: true });
          continue;
        }
        const bytes = Buffer.from(change.content, "base64");
        if (bytes.toString("base64") !== change.content || bytes.length > SKILL_FILE_LIMIT)
          throw new Error("Invalid base64 or resource exceeds 16 MiB.");
        await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
        await fs.writeFile(target, bytes, { mode: change.executable ? 0o700 : 0o600 });
        await fs.chmod(target, (change.executable ?? previousResource?.executable) ? 0o700 : 0o600);
      }
      await renameEntry(path.join(directory, ...entryPath.split("/")), request.name);
      let derived!: SkillDefinition;
      await context.beforeMutation?.();
      await packages.publishDirectory(directory, async (pkg) => {
        if (prior?.plannedSkill && pkg.packageId !== prior.plannedSkill.packageId)
          throw new Error("Derived package changed after the operation plan.");
        assertNoActivePrivateDerivation(
          await readSkillLibraryDefinitions(stateDir),
          request.sourceSkillId,
          request.expertId,
          prior?.plannedSkill?.skillId ?? plannedSkillId,
        );
        derived =
          prior?.plannedSkill ??
          makeItem({
            pkg,
            entryPath,
            ...(plannedSkillId ? { skillId: plannedSkillId } : {}),
            name: request.name,
            source: { kind: "manual", location: "", packageId: pkg.packageId, entryPath },
            modified: false,
            ...(context.actor ? { actor: context.actor } : {}),
            evolutionPolicy: "independent",
            scope: { kind: "expert", expertId: request.expertId },
            derivedFrom: {
              skillId: request.sourceSkillId,
              revision: request.expectedRevision,
              packageId: sourcePackageId,
            },
          });
        if (journal)
          await operations.recordPlan(journal.requestId, "derive", journal.fingerprint, {
            plannedSkillId: derived.skillId,
            plannedRevision: derived.revision,
            plannedPackageId: derived.packageId,
            plannedSkill: derived,
            ...(context.retainForEvolution
              ? { evolutionPackageIds: [sourcePackageId, derived.packageId] }
              : {}),
          });
        if (context.retainForEvolution)
          await retainSkillEvolutionPackagesUnlocked(stateDir, [
            sourcePackageId,
            derived.packageId,
          ]);
        await commit([derived], true, context.beforeMutation);
      });
      return { skill: derived };
    } finally {
      await fs.rm(owned, { recursive: true, force: true });
    }
  };
  const expertIds = async (skillId: string) =>
    (await createExpertStore(stateDir).list())
      .filter((expert) => expert.skillBindings?.some((binding) => binding.skillId === skillId))
      .map((expert) => expert.id)
      .toSorted();
  const validateDelete = async (
    skillId: string,
    expected: number,
    confirmed: ReadonlyArray<string>,
  ) => {
    const current = await revision(skillId, expected),
      affected = await expertIds(skillId);
    if (JSON.stringify(affected) !== JSON.stringify([...new Set(confirmed)].toSorted()))
      throw new Error("Affected Expert bindings changed; review and confirm deletion again.");
    return { current, affected };
  };
  const createDeleteIntent = async (
    skillId: string,
    expected: number,
    confirmed: ReadonlyArray<string>,
  ): Promise<SkillLibraryDeleteIntent> => {
    const { current, affected } = await validateDelete(skillId, expected, confirmed),
      experts = createExpertStore(stateDir),
      targets: Array<SkillLibraryDeleteIntent["experts"][number]> = [];
    for (const expertId of affected) {
      const expert = await experts.read(expertId);
      if (!expert) throw new Error("Expert changed during deletion.");
      if (needsLegacyConversion(expert))
        throw new Error(`Expert ${expert.id} needs skill binding conversion before deletion.`);
      const expectedBindings = expert.skillBindings ?? [];
      targets.push({
        expertId: expert.id,
        expectedRevision: expert.revision,
        expectedExpert: expert,
        expectedBindings,
        bindings: expectedBindings.filter((binding) => binding.skillId !== skillId),
      });
    }
    return {
      expectedRevision: current.revision,
      tombstone: Schema.decodeUnknownSync(SkillDefinition)({
        ...current,
        deleted: true,
        revision: current.revision + 1,
        updatedAt: new Date().toISOString(),
      }),
      experts: targets,
    };
  };
  const remove = async (
    skillId: string,
    expected: number,
    confirmed: ReadonlyArray<string>,
    context: SkillLibraryExecutionContext,
    journal?: {
      requestId: string;
      operation: "delete" | "batch";
      fingerprint: string;
      index?: number;
    },
  ) => {
    const record = journal ? await operations.read(journal.requestId) : undefined;
    let intent =
      journal?.operation === "delete"
        ? record?.deleteIntent
        : record?.batchIntents?.find((item) => item.index === journal?.index)?.delete;
    if (intent && (intent.tombstone.skillId !== skillId || intent.expectedRevision !== expected))
      throw new SkillLibraryRequestIdConflict();
    if (!intent) {
      intent = await createDeleteIntent(skillId, expected, confirmed);
      if (journal)
        await operations.recordDeleteIntent(
          journal.requestId,
          journal.operation,
          journal.fingerprint,
          intent,
          journal.index,
        );
    }
    const currentDefinitions = await readSkillLibraryDefinitions(stateDir),
      current = currentDefinitions.find((skill) => skill.skillId === skillId),
      tombstone = current && stableJson(current) === stableJson(intent.tombstone);
    if (tombstone) {
      if ((await expertIds(skillId)).length)
        throw new Error("Skill was rebound during deletion; review again.");
      return;
    }
    if (!current || current.deleted || current.revision !== intent.expectedRevision)
      throw new Error("Skill revision changed; reload before deleting.");
    const experts = createExpertStore(stateDir);
    for (const target of intent.experts) {
      const expert = await experts.read(target.expertId);
      if (!expert) throw new Error("Expert changed during deletion.");
      if (needsLegacyConversion(expert))
        throw new Error(`Expert ${expert.id} needs skill binding conversion before deletion.`);
      const bindings = expert.skillBindings ?? [];
      if (
        expert.revision === target.expectedRevision &&
        stableJson(expert) === stableJson(target.expectedExpert) &&
        stableJson(bindings) === stableJson(target.expectedBindings)
      ) {
        await context.beforeMutation?.({ expertBindings: true });
        await experts.save(expertSaveInput(expert, target.bindings));
      } else if (!matchesExpertIntent(expert, target))
        throw new Error(`Expert ${expert.id} changed during deletion; review and confirm again.`);
    }
    await withSkillPackageLifecycle(stateDir, async () => {
      if ((await expertIds(skillId)).length)
        throw new Error("Skill was rebound during deletion; review again.");
      const latest = (await readSkillLibraryDefinitions(stateDir)).find(
        (skill) => skill.skillId === skillId,
      );
      if (latest && stableJson(latest) === stableJson(intent!.tombstone)) return;
      if (!latest || latest.deleted || latest.revision !== intent!.expectedRevision)
        throw new Error("Skill revision changed; reload before deleting.");
      await commit([intent!.tombstone], true, context.beforeMutation);
    });
  };
  const listSkills = async (query?: SkillLibraryQuery) => {
    const definitions = (await readSkillLibraryDefinitions(stateDir)).filter(
        (skill) => !skill.deleted,
      ),
      experts = await createExpertStore(stateDir).list(),
      usage = new Map<string, { expertIds: string[]; enabledExpertIds: string[] }>();
    for (const expert of experts) {
      for (const binding of expert.skillBindings ?? []) {
        const item = usage.get(binding.skillId) ?? { expertIds: [], enabledExpertIds: [] };
        if (!item.expertIds.includes(expert.id)) item.expertIds.push(expert.id);
        if (binding.enabled && !item.enabledExpertIds.includes(expert.id))
          item.enabledExpertIds.push(expert.id);
        usage.set(binding.skillId, item);
      }
    }
    const normalizedSearch = query?.search?.trim().toLocaleLowerCase(),
      expertFilters = query?.expertIds?.length ? new Set(query.expertIds) : undefined,
      creatorFilters = query?.createdBy?.length ? new Set(query.createdBy) : undefined,
      tagFilters = query?.tags?.length
        ? new Set(query.tags.map((tag) => tag.normalize("NFC").toLocaleLowerCase()))
        : undefined,
      sourceFilters = query?.sources?.length ? new Set(query.sources) : undefined,
      filtered = definitions.filter((skill) => {
        const skillUsage = usage.get(skill.skillId) ?? { expertIds: [], enabledExpertIds: [] };
        if (
          normalizedSearch &&
          !`${skill.name} ${skill.description} ${skill.tags.join(" ")}`
            .toLocaleLowerCase()
            .includes(normalizedSearch)
        )
          return false;
        if (query?.usage === "used" && !skillUsage.expertIds.length) return false;
        if (query?.usage === "unused" && skillUsage.expertIds.length) return false;
        if (sourceFilters && !sourceFilters.has(skillLibrarySourceFilter(skill)!)) return false;
        if (expertFilters && !skillUsage.expertIds.some((id) => expertFilters.has(id)))
          return false;
        if (creatorFilters && !creatorFilters.has(skill.createdBy ?? "unknown")) return false;
        if (
          tagFilters &&
          !skill.tags.some((tag) => tagFilters.has(tag.normalize("NFC").toLocaleLowerCase()))
        )
          return false;
        return true;
      });
    const field = query?.sort?.field ?? "updated",
      direction = query?.sort?.direction ?? "desc",
      multiplier = direction === "asc" ? 1 : -1,
      compareText = (left: string, right: string) => left.localeCompare(right, "zh-Hans"),
      compareDate = (left?: string, right?: string) => {
        const leftValue = left && Number.isFinite(Date.parse(left)) ? Date.parse(left) : undefined,
          rightValue = right && Number.isFinite(Date.parse(right)) ? Date.parse(right) : undefined;
        if (leftValue === undefined || rightValue === undefined) {
          if (leftValue === rightValue) return 0;
          return leftValue === undefined ? 1 : -1;
        }
        return (leftValue - rightValue) * multiplier;
      };
    filtered.sort((left, right) => {
      let comparison = 0;
      if (field === "name") comparison = compareText(left.name, right.name) * multiplier;
      else if (field === "usedBy")
        comparison =
          ((usage.get(left.skillId)?.expertIds.length ?? 0) -
            (usage.get(right.skillId)?.expertIds.length ?? 0)) *
          multiplier;
      else if (field === "created") comparison = compareDate(left.createdAt, right.createdAt);
      else comparison = compareDate(left.updatedAt, right.updatedAt);
      return (
        comparison ||
        compareText(left.name, right.name) ||
        left.skillId.localeCompare(right.skillId)
      );
    });
    const items: SkillLibraryItem[] = filtered.map((skill) => ({
      skillId: skill.skillId,
      ...(skill.createdAt !== undefined ? { createdAt: skill.createdAt } : {}),
      ...(skill.createdBy !== undefined ? { createdBy: skill.createdBy } : {}),
      usage: usage.get(skill.skillId) ?? { expertIds: [], enabledExpertIds: [] },
    }));
    return { skills: filtered, items };
  };
  const readBindingState = async (expertId: string): Promise<SkillLibraryBindingState> => {
    const expert = await createExpertStore(stateDir).read(expertId);
    if (!expert) throw new Error(`Expert not found: ${expertId}`);
    return {
      expertId: expert.id,
      revision: expert.revision,
      bindings: expert.skillBindings ?? [],
      ...(needsLegacyConversion(expert) ? { needsConversion: true } : {}),
    };
  };
  const applyBindingOperation = async (
    request: Extract<SkillLibraryRequest, { action: "bindings" }>,
    context: SkillLibraryExecutionContext,
  ): Promise<SkillLibraryBindingState> => {
    if (request.operation === "list") return readBindingState(request.expertId);
    const fingerprintInput = {
        actor: context.actor ?? "owner",
        request: { ...request, dryRun: undefined },
      },
      requestFingerprint = fingerprint(fingerprintInput),
      experts = createExpertStore(stateDir);
    let prior: Awaited<ReturnType<typeof operations.begin>> | undefined;
    if (!request.dryRun) {
      await context.beforeMutation?.();
      prior = await operations.begin(request.requestId, "bindings", requestFingerprint);
      if (prior.bindingResult?.status === "applied" || prior.bindingResult?.status === "unchanged")
        return prior.bindingResult!;
    }
    const current = await experts.read(request.expertId);
    if (!current) throw new Error(`Expert not found: ${request.expertId}`);
    const initial: SkillLibraryBindingState = {
      expertId: current.id,
      revision: current.revision,
      bindings: current.skillBindings ?? [],
      ...(needsLegacyConversion(current) ? { needsConversion: true } : {}),
      ...(request.dryRun ? { dryRun: true } : {}),
    };
    const finish = async (result: SkillLibraryBindingState) => {
      if (!request.dryRun)
        await operations.recordBindingState(request.requestId, requestFingerprint, result);
      return result;
    };
    if (needsLegacyConversion(current))
      return finish({
        ...initial,
        status: "needs_conversion",
        error: "Convert the existing Expert skill configuration before editing bindings.",
      });

    const currentBindings = current.skillBindings ?? [];
    let nextBindings: ReadonlyArray<ExpertSkillBinding>;
    if (request.operation === "set") {
      nextBindings = request.bindings;
    } else if (request.operation === "add") {
      const byId = new Map(currentBindings.map((binding) => [binding.skillId, binding]));
      for (const binding of request.bindings)
        if (!byId.has(binding.skillId)) byId.set(binding.skillId, binding);
      nextBindings = [...byId.values()];
    } else if ("skillIds" in request) {
      const requested = new Set(request.skillIds);
      if (request.operation === "remove")
        nextBindings = currentBindings.filter((binding) => !requested.has(binding.skillId));
      else {
        if (
          [...requested].some(
            (skillId) => !currentBindings.some((binding) => binding.skillId === skillId),
          )
        )
          return finish({
            ...initial,
            status: "failed",
            error: "Enable/disable requires every Skill ID to be bound to this Expert.",
          });
        nextBindings = currentBindings.map((binding) =>
          requested.has(binding.skillId)
            ? { ...binding, enabled: request.operation === "enable" }
            : binding,
        );
      }
    } else {
      return finish({ ...initial, status: "failed", error: "Unsupported binding operation." });
    }
    if (new Set(nextBindings.map((binding) => binding.skillId)).size !== nextBindings.length)
      return finish({ ...initial, status: "failed", error: "Duplicate Skill binding." });
    if (nextBindings.length > 100)
      return finish({
        ...initial,
        status: "failed",
        error: "An Expert can have at most 100 Skill bindings.",
      });
    const intent = prior?.bindingIntent;
    if (
      intent?.expertId === current.id &&
      intent.expectedRevision === request.expectedRevision &&
      matchesExpertIntent(current, intent) &&
      stableJson(nextBindings) === stableJson(intent.bindings)
    )
      return finish({
        expertId: current.id,
        revision: current.revision,
        bindings: currentBindings,
        status: "applied",
      });
    if (
      intent?.expertId === current.id &&
      intent.expectedRevision === request.expectedRevision &&
      current.revision !== intent.expectedRevision
    )
      return finish({
        ...initial,
        status: "conflict",
        error: "Expert revision advanced after the planned binding write; reload before retrying.",
      });
    const unchanged = stableJson(nextBindings) === stableJson(currentBindings);
    if (unchanged) return finish({ ...initial, status: "unchanged" });
    if (current.revision !== request.expectedRevision)
      return finish({
        ...initial,
        status: "conflict",
        error: "Expert revision changed; reload before saving bindings.",
      });
    try {
      await resolveSkillBindings(stateDir, nextBindings, current.id);
      if (request.dryRun) return { ...initial, status: "applied", revision: current.revision + 1 };
      await context.beforeMutation?.();
      await operations.recordBindingIntent(request.requestId, "bindings", requestFingerprint, {
        expertId: current.id,
        expectedRevision: current.revision,
        expectedExpert: current,
        bindings: [...nextBindings],
      });
      const saved = await experts.save(expertSaveInput(current, nextBindings));
      return finish({
        expertId: saved.id,
        revision: saved.revision,
        bindings: saved.skillBindings ?? [],
        status: "applied",
      });
    } catch (cause) {
      if (intent && !request.dryRun) {
        const latest = await experts.read(current.id);
        if (latest && matchesExpertIntent(latest, intent))
          return finish({
            expertId: latest.id,
            revision: latest.revision,
            bindings: latest.skillBindings ?? [],
            status: "applied",
          });
      }
      const status =
        cause instanceof ExpertStoreError && cause.code === "revision_conflict"
          ? "conflict"
          : "failed";
      return finish({
        ...initial,
        status,
        error: cause instanceof Error ? cause.message : String(cause),
      });
    }
  };
  const bindExperts = async (
    request: Extract<SkillLibraryRequest, { action: "bindExperts" }>,
    context: SkillLibraryExecutionContext,
  ): Promise<SkillLibraryResponse> => {
    if (!request.skillIds.length || !request.targets.length)
      throw new Error("Select at least one Skill and one Expert.");
    if (new Set(request.skillIds).size !== request.skillIds.length)
      throw new Error("Duplicate Skill IDs are not allowed.");
    if (new Set(request.targets.map((target) => target.expertId)).size !== request.targets.length)
      throw new Error("Duplicate Expert targets are not allowed.");
    const requestFingerprint = fingerprint({
      action: "bindExperts",
      actor: context.actor ?? "owner",
      skillIds: [...request.skillIds].toSorted(),
      targets: [...request.targets].toSorted((left, right) =>
        left.expertId.localeCompare(right.expertId),
      ),
    });
    if (!request.dryRun) {
      await context.beforeMutation?.();
      await operations.begin(request.requestId, "bindExperts", requestFingerprint);
    }
    const prior = request.dryRun ? undefined : await operations.read(request.requestId),
      priorResults = new Map(
        (prior?.bindingResults ?? []).map((result) => [result.expertId, result]),
      ),
      results = new Map<string, SkillLibraryBindingResult>(),
      experts = createExpertStore(stateDir);
    for (const target of request.targets) {
      const previous = priorResults.get(target.expertId);
      if (previous && ["applied", "unchanged"].includes(previous.status)) {
        results.set(target.expertId, previous);
        continue;
      }
      const current = await experts.read(target.expertId);
      let result: SkillLibraryBindingResult;
      if (!current) {
        result = {
          expertId: target.expertId,
          status: "failed",
          addedSkillIds: [],
          skippedSkillIds: request.skillIds,
          error: "Expert not found.",
        };
      } else if (needsLegacyConversion(current)) {
        result = {
          expertId: current.id,
          status: "needs_conversion",
          oldRevision: current.revision,
          addedSkillIds: [],
          skippedSkillIds: request.skillIds,
          error: "Convert the existing Expert skill configuration before adding bindings.",
        };
      } else if (current.archived) {
        result = {
          expertId: current.id,
          status: "failed",
          oldRevision: current.revision,
          addedSkillIds: [],
          skippedSkillIds: request.skillIds,
          error: "Archived Experts cannot receive Skill bindings.",
        };
      } else {
        const currentBindings = current.skillBindings ?? [],
          existing = new Set(currentBindings.map((binding) => binding.skillId)),
          addedSkillIds = request.skillIds.filter((skillId) => !existing.has(skillId)),
          skippedSkillIds = request.skillIds.filter((skillId) => existing.has(skillId)),
          intent = prior?.bindingIntents?.find((item) => item.expertId === current.id),
          intentApplied =
            intent !== undefined &&
            intent.expectedRevision === target.expectedRevision &&
            matchesExpertIntent(current, intent),
          intentAdvanced =
            intent !== undefined &&
            intent.expectedRevision === target.expectedRevision &&
            current.revision !== target.expectedRevision &&
            !intentApplied;
        let unavailableSkill: string | undefined;
        if (!intentApplied && !intentAdvanced) {
          for (const skillId of request.skillIds) {
            try {
              await readSkillDefinition(stateDir, skillId);
            } catch (cause) {
              unavailableSkill = cause instanceof Error ? cause.message : String(cause);
              break;
            }
          }
        }
        if (intentApplied) {
          result = {
            expertId: current.id,
            status: "applied",
            oldRevision: target.expectedRevision,
            newRevision: current.revision,
            addedSkillIds: intent.addedSkillIds ?? [],
            skippedSkillIds: intent.skippedSkillIds ?? [],
          };
        } else if (intentAdvanced) {
          result = {
            expertId: current.id,
            status: "conflict",
            oldRevision: target.expectedRevision,
            newRevision: current.revision,
            addedSkillIds: [],
            skippedSkillIds: intent.skippedSkillIds ?? [],
            error:
              "Expert revision advanced after the planned binding write; reload before retrying.",
          };
        } else if (unavailableSkill) {
          result = {
            expertId: current.id,
            status: "failed",
            oldRevision: current.revision,
            addedSkillIds: [],
            skippedSkillIds: request.skillIds,
            error: unavailableSkill,
          };
        } else if (!addedSkillIds.length) {
          result = {
            expertId: current.id,
            status: "unchanged",
            oldRevision: current.revision,
            newRevision: current.revision,
            addedSkillIds: [],
            skippedSkillIds,
          };
        } else if (current.revision !== target.expectedRevision) {
          result = {
            expertId: current.id,
            status: "conflict",
            oldRevision: target.expectedRevision,
            newRevision: current.revision,
            addedSkillIds: [],
            skippedSkillIds,
            error: "Expert revision changed; reload before applying this batch.",
          };
        } else if (currentBindings.length + addedSkillIds.length > 100) {
          result = {
            expertId: current.id,
            status: "failed",
            oldRevision: current.revision,
            addedSkillIds: [],
            skippedSkillIds: request.skillIds,
            error: "An Expert can have at most 100 Skill bindings.",
          };
        } else {
          const nextBindings = [
            ...currentBindings,
            ...addedSkillIds.map((skillId) => ({
              skillId,
              enabled: true,
              activation: "on-demand" as const,
            })),
          ];
          try {
            await resolveSkillBindings(stateDir, nextBindings, current.id);
            if (request.dryRun) {
              result = {
                expertId: current.id,
                status: "applied",
                oldRevision: current.revision,
                newRevision: current.revision + 1,
                addedSkillIds,
                skippedSkillIds,
              };
            } else {
              await context.beforeMutation?.();
              await operations.recordBindingIntent(
                request.requestId,
                "bindExperts",
                requestFingerprint,
                {
                  expertId: current.id,
                  expectedRevision: current.revision,
                  expectedExpert: current,
                  bindings: nextBindings,
                  addedSkillIds,
                  skippedSkillIds,
                },
              );
              const saved = await experts.save(expertSaveInput(current, nextBindings));
              result = {
                expertId: current.id,
                status: "applied",
                oldRevision: current.revision,
                newRevision: saved.revision,
                addedSkillIds,
                skippedSkillIds,
              };
            }
          } catch (cause) {
            result = {
              expertId: current.id,
              status:
                cause instanceof ExpertStoreError && cause.code === "revision_conflict"
                  ? "conflict"
                  : "failed",
              oldRevision: target.expectedRevision,
              newRevision: current.revision,
              addedSkillIds: [],
              skippedSkillIds,
              error: cause instanceof Error ? cause.message : String(cause),
            };
          }
        }
      }
      results.set(target.expertId, result);
      if (!request.dryRun)
        await operations.recordBindingResult(
          request.requestId,
          "bindExperts",
          requestFingerprint,
          result,
        );
    }
    return {
      bindingResults: request.targets.map((target) => results.get(target.expertId)!),
      ...(request.dryRun ? { dryRun: true } : {}),
    };
  };
  const updateFromSource = async (
    request: Extract<SkillLibraryRequest, { action: "updateFromSource" }>,
    context: SkillLibraryExecutionContext,
    sourcePreview: () => SkillLibraryPreview,
  ): Promise<SkillLibraryUpdateResult> => {
    const requestFingerprint = fingerprint({
      action: "updateFromSource",
      actor: context.actor ?? "owner",
      skillId: request.skillId,
      expectedRevision: request.expectedRevision,
      overwriteLocalEdits: request.overwriteLocalEdits ?? false,
      expectedPackageId: request.expectedPackageId,
    });
    let prior: Awaited<ReturnType<typeof operations.begin>> | undefined;
    if (!request.dryRun) {
      await context.beforeMutation?.();
      prior = await operations.begin(request.requestId, "updateFromSource", requestFingerprint);
      if (
        prior.updateResult &&
        ["updated", "unchanged", "skipped"].includes(prior.updateResult.status)
      )
        return prior.updateResult;
    }
    let current: SkillDefinition;
    try {
      current = await readSkillDefinition(stateDir, request.skillId);
    } catch (cause) {
      const result: SkillLibraryUpdateResult = {
        skillId: request.skillId,
        status: "failed",
        error: cause instanceof Error ? cause.message : String(cause),
      };
      if (!request.dryRun)
        await operations.recordUpdateResult(request.requestId, requestFingerprint, result);
      return result;
    }
    if (prior?.plannedSkill) {
      try {
        const recovered = await recoverPlannedSkills([prior.plannedSkill], context);
        if (recovered) {
          const result: SkillLibraryUpdateResult = {
            skillId: recovered[0]!.skillId,
            status: "updated",
            revision: recovered[0]!.revision,
          };
          await operations.recordUpdateResult(request.requestId, requestFingerprint, result);
          return result;
        }
      } catch (cause) {
        if (!(cause instanceof ExpertStoreError && cause.code === "revision_conflict")) throw cause;
        const result: SkillLibraryUpdateResult = {
          skillId: current.skillId,
          status: "conflict",
          revision: current.revision,
          error: cause.message,
        };
        await operations.recordUpdateResult(request.requestId, requestFingerprint, result);
        return result;
      }
    }
    if (prior?.plannedPackageId && current.packageId === prior.plannedPackageId) {
      const result: SkillLibraryUpdateResult = {
        skillId: current.skillId,
        status: "updated",
        revision: current.revision,
      };
      await operations.recordUpdateResult(request.requestId, requestFingerprint, result);
      return result;
    }
    if (current.revision !== request.expectedRevision) {
      const result: SkillLibraryUpdateResult = {
        skillId: current.skillId,
        status: "conflict",
        revision: current.revision,
        error: "Skill revision changed; reload before updating its source.",
      };
      if (!request.dryRun)
        await operations.recordUpdateResult(request.requestId, requestFingerprint, result);
      return result;
    }
    if (!refreshableSource(current)) {
      const result: SkillLibraryUpdateResult = {
        skillId: current.skillId,
        status: "skipped",
        revision: current.revision,
        error: "Only GitHub, Skills.sh, and ClawHub sources can be updated in place.",
      };
      if (!request.dryRun)
        await operations.recordUpdateResult(request.requestId, requestFingerprint, result);
      return result;
    }
    if (current.locallyModified && !request.overwriteLocalEdits) {
      const result: SkillLibraryUpdateResult = {
        skillId: current.skillId,
        status: "skipped",
        revision: current.revision,
        error: "Local edits require explicit overwriteLocalEdits confirmation.",
      };
      if (!request.dryRun)
        await operations.recordUpdateResult(request.requestId, requestFingerprint, result);
      return result;
    }

    let preview: SkillLibraryPreview | undefined;
    try {
      preview = sourcePreview();
      const candidate = makeItem({
        pkg: preview.package,
        entryPath: current.source.entryPath,
        source: { ...preview.source, entryPath: current.source.entryPath },
        previous: current,
        modified: false,
      });
      if (request.expectedPackageId && candidate.packageId !== request.expectedPackageId) {
        await cleanup(preview.previewId);
        const result: SkillLibraryUpdateResult = {
          skillId: current.skillId,
          status: "conflict",
          revision: current.revision,
          error:
            "The hosted source changed after preview; preview and confirm again with a new requestId.",
        };
        if (!request.dryRun)
          await operations.recordUpdateResult(request.requestId, requestFingerprint, result);
        return result;
      }
      if (prior?.plannedSkill && candidate.packageId !== prior.plannedSkill.packageId) {
        await cleanup(preview.previewId);
        const result: SkillLibraryUpdateResult = {
          skillId: current.skillId,
          status: "conflict",
          revision: current.revision,
          error:
            "The hosted source changed after this request was planned; preview and retry with a new requestId.",
        };
        await operations.recordUpdateResult(request.requestId, requestFingerprint, result);
        return result;
      }
      if (candidate.packageId === current.packageId) {
        await cleanup(preview.previewId);
        const result: SkillLibraryUpdateResult = {
          skillId: current.skillId,
          status: "unchanged",
          revision: current.revision,
          ...(request.dryRun ? { preview } : {}),
        };
        if (!request.dryRun)
          await operations.recordUpdateResult(request.requestId, requestFingerprint, result);
        return result;
      }
      if (request.dryRun) {
        await cleanup(preview.previewId);
        return {
          skillId: current.skillId,
          status: "updated",
          revision: current.revision,
          preview,
        };
      }
      const plannedSkill = prior?.plannedSkill ?? candidate;
      await operations.recordPlan(request.requestId, "updateFromSource", requestFingerprint, {
        plannedPackageId: plannedSkill.packageId,
        plannedRevision: plannedSkill.revision,
        plannedSkill,
      });
      await context.beforeMutation?.();
      const pending = await pendingPreview(preview.previewId);
      let saved = plannedSkill;
      await packages.publishPreview(pending.packagePreviewId, async (pkg) => {
        if (pkg.packageId !== plannedSkill.packageId)
          throw new Error("Source package changed after the operation plan.");
        await commit([saved], true, context.beforeMutation);
      });
      await cleanup(preview.previewId);
      const result: SkillLibraryUpdateResult = {
        skillId: saved.skillId,
        status: "updated",
        revision: saved.revision,
      };
      await operations.recordUpdateResult(request.requestId, requestFingerprint, result);
      return result;
    } catch (cause) {
      if (preview) await cleanup(preview.previewId).catch(() => undefined);
      const result: SkillLibraryUpdateResult = {
        skillId: current.skillId,
        status:
          cause instanceof Error && /revision changed/iu.test(cause.message)
            ? "conflict"
            : "failed",
        revision: current.revision,
        error: cause instanceof Error ? cause.message : String(cause),
      };
      if (!request.dryRun)
        await operations.recordUpdateResult(request.requestId, requestFingerprint, result);
      return result;
    }
  };
  const executeRequest = async (
    raw: SkillLibraryRequest,
    context: SkillLibraryExecutionContext = {},
  ): Promise<SkillLibraryResponse> => {
    if (disposal) throw new Error("Skill library is closing; reconnect before continuing.");
    const decodedRequest = Schema.decodeUnknownSync(SkillLibraryRequest)(raw),
      generatedRequestId = hasOptionalWriteRequestId(decodedRequest)
        ? (decodedRequest.requestId ?? randomUUID())
        : undefined,
      request: SkillLibraryRequest = hasOptionalWriteRequestId(decodedRequest)
        ? { ...decodedRequest, requestId: generatedRequestId! }
        : decodedRequest;
    if (request.action === "cancel")
      for (const controller of activePreviews.get(request.previewId) ?? []) controller.abort();
    const previewRequestId =
      request.action === "previewImport" || request.action === "updateFromSource"
        ? (request.requestId ?? randomUUID())
        : request.action === "previewRefresh" ||
            (request.action === "batch" &&
              request.items.some(
                (item) =>
                  item.operation === "previewRefresh" || item.operation === "updateFromSource",
              ))
          ? randomUUID()
          : undefined;
    const controller = previewRequestId ? new AbortController() : undefined;
    if (
      request.action === "previewImport" &&
      previewRequestId &&
      (activePreviews.has(previewRequestId) || previews.has(previewRequestId))
    )
      throw new Error("Skill preview request ID is already in use.");
    if (previewRequestId) {
      const controllers = activePreviews.get(previewRequestId) ?? new Set<AbortController>();
      controllers.add(controller!);
      activePreviews.set(previewRequestId, controllers);
    }
    const writeRequestId = generatedRequestId,
      writeOperation = hasOptionalWriteRequestId(request) ? request.action : undefined,
      responseRequestId =
        writeRequestId ??
        (request.action === "bindings" && request.operation !== "list"
          ? request.requestId
          : request.action === "bindExperts" || request.action === "updateFromSource"
            ? request.requestId
            : undefined);
    const isDryRun = "dryRun" in request && request.dryRun === true;
    const writeFingerprint =
      writeRequestId && writeOperation && !isDryRun
        ? fingerprint({
            actor: context.actor ?? "owner",
            ...(context.retainForEvolution ? { retainForEvolution: true } : {}),
            request: { ...request, dryRun: undefined },
          })
        : undefined;
    type Prepared = { preview: SkillLibraryPreview } | { error: unknown };
    const prepared = new Map<string, Prepared>(),
      ownedPreviews = new Set<string>();
    const prepareRefresh = async (skillId: string, expectedRevision: number, key: string) => {
      try {
        const skill = await revision(skillId, expectedRevision);
        if (!refreshableSource(skill))
          throw new Error("This Skill has no supported hosted source.");
        const preview = await previewSource(
          skill.source.location,
          "url",
          skill,
          controller?.signal,
        );
        prepared.set(key, { preview });
        ownedPreviews.add(preview.previewId);
      } catch (error) {
        prepared.set(key, { error });
      }
    };
    const prepareUpdate = async (
      update: Extract<SkillLibraryRequest, { action: "updateFromSource" }>,
      key: string,
    ) => {
      try {
        if (!update.dryRun) {
          const prior = await operations.read(update.requestId);
          if (
            prior?.updateResult &&
            ["updated", "unchanged", "skipped"].includes(prior.updateResult.status)
          )
            return;
          if (prior?.plannedSkill) {
            try {
              await packages.read(prior.plannedSkill.packageId);
              return; // Recovery uses the durable candidate without downloading again.
            } catch (error) {
              if (!(error instanceof SkillPackageStoreError && error.code === "not_found"))
                throw error;
            }
          }
        }
        const skill = await revision(update.skillId, update.expectedRevision);
        if (!refreshableSource(skill) || (skill.locallyModified && !update.overwriteLocalEdits))
          return;
        await prepareRefresh(update.skillId, update.expectedRevision, key);
      } catch (error) {
        prepared.set(key, { error });
      }
    };
    const preparedPreview = (key: string) => {
      const source = prepared.get(key);
      if (!source) throw new Error("Source update was not prepared; preview and retry.");
      if ("error" in source) throw source.error;
      return source.preview;
    };
    const runOperation = async () => {
      let writeJournal: Awaited<ReturnType<typeof operations.begin>> | undefined;
      if (writeRequestId && writeOperation && writeFingerprint) {
        await context.beforeMutation?.();
        writeJournal = await operations.begin(writeRequestId, writeOperation, writeFingerprint);
        if (context.retainForEvolution && writeJournal.evolutionPackageIds?.length)
          await withSkillPackageLifecycle(stateDir, () =>
            retainSkillEvolutionPackagesUnlocked(stateDir, writeJournal!.evolutionPackageIds!),
          );
        if (
          writeJournal.response &&
          (writeOperation !== "batch" ||
            writeJournal.response.results?.every((item) => item.success))
        )
          return responseRequestId
            ? { ...writeJournal.response, requestId: responseRequestId }
            : writeJournal.response;
      }
      const operationResponse = await (async (): Promise<SkillLibraryResponse> => {
        switch (request.action) {
          case "list":
            return listSkills(request.query);
          case "read": {
            const skill = await readSkillDefinition(stateDir, request.skillId);
            return { skill, resources: (await packages.read(skill.packageId)).resources };
          }
          case "create": {
            const evolutionPolicy = request.evolutionPolicy ?? "protected",
              scope = request.scope ?? { kind: "shared" };
            assertSkillEvolutionConfiguration({ evolutionPolicy, scope });
            if (scope.kind === "expert") {
              const owner = await createExpertStore(stateDir).read(scope.expertId);
              if (!owner || owner.archived)
                throw new Error("Active target Expert not found for private Skill creation.");
            }
            let plannedSkillId: string | undefined;
            if (writeRequestId && writeFingerprint && !request.dryRun) {
              plannedSkillId = writeJournal?.plannedSkillId;
              if (!plannedSkillId) {
                plannedSkillId = `skl_${randomUUID().replaceAll("-", "")}`;
                await operations.recordPlan(writeRequestId, "create", writeFingerprint, {
                  plannedSkillId,
                });
              }
              if (writeJournal?.plannedSkill) {
                const recovered = await recoverPlannedSkills([writeJournal.plannedSkill], context);
                if (recovered) return { skill: recovered[0] };
              }
              const recovered = (await readSkillLibraryDefinitions(stateDir)).find(
                (skill) => skill.skillId === plannedSkillId,
              );
              if (recovered && !writeJournal?.plannedSkill) return { skill: recovered };
              if (recovered)
                throw new Error(
                  "Created Skill changed after its planned mutation; reload the library.",
                );
            }
            const owned = await fs.mkdtemp(path.join(staging, "create-")),
              directory = path.join(owned, "skill");
            await fs.mkdir(directory, { mode: 0o700 });
            try {
              await fs.writeFile(path.join(directory, "SKILL.md"), request.body, { mode: 0o600 });
              await renameEntry(path.join(directory, "SKILL.md"), request.name);
              const changedPaths = new Set<string>();
              for (const change of request.changes ?? []) {
                assertSkillResourcePath(change.path);
                const key = change.path.normalize("NFC").toLowerCase();
                if (key === "skill.md")
                  throw new Error(
                    "Create changes may add support files but cannot replace SKILL.md.",
                  );
                if (changedPaths.has(key)) throw new Error("Duplicate file change.");
                changedPaths.add(key);
                if (change.content === undefined)
                  throw new Error("Create changes may add support files but cannot delete files.");
                const bytes = Buffer.from(change.content, "base64");
                if (bytes.toString("base64") !== change.content || bytes.length > SKILL_FILE_LIMIT)
                  throw new Error("Invalid base64 or resource exceeds 16 MiB.");
                const target = path.join(directory, ...change.path.split("/"));
                await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
                await fs.writeFile(target, bytes, { mode: change.executable ? 0o700 : 0o600 });
                await fs.chmod(target, change.executable ? 0o700 : 0o600);
              }
              if (request.dryRun) {
                const preview = await packages.preview({ path: directory });
                packages.cancelPreview(preview.previewId);
                return {
                  dryRun: true,
                  plan: {
                    operation: "create",
                    status: "would_change" as const,
                    packageId: preview.package.packageId,
                    message:
                      "Skill content passed validation; no identity or package was published.",
                  },
                };
              }
              let skill!: SkillDefinition;
              await context.beforeMutation?.();
              await packages.publishDirectory(directory, async (pkg) => {
                const entryPath = "SKILL.md";
                skill = makeItem({
                  pkg,
                  entryPath,
                  ...(plannedSkillId ? { skillId: plannedSkillId } : {}),
                  tags: request.tags,
                  ...(context.actor ? { actor: context.actor } : {}),
                  evolutionPolicy,
                  scope,
                  source: { kind: "manual", location: "", packageId: pkg.packageId, entryPath },
                });
                if (writeRequestId && writeFingerprint)
                  await operations.recordPlan(writeRequestId, "create", writeFingerprint, {
                    plannedSkillId: skill.skillId,
                    plannedSkill: skill,
                    ...(context.retainForEvolution
                      ? { evolutionPackageIds: [skill.packageId] }
                      : {}),
                  });
                if (context.retainForEvolution)
                  await retainSkillEvolutionPackagesUnlocked(stateDir, [skill.packageId]);
                await commit([skill], true, context.beforeMutation);
              });
              return { skill };
            } finally {
              await fs.rm(owned, { recursive: true, force: true });
            }
          }
          case "configureEvolution":
            return configureEvolution(
              request,
              context,
              writeRequestId && writeFingerprint
                ? { requestId: writeRequestId, fingerprint: writeFingerprint }
                : undefined,
            );
          case "derive":
            return deriveSkill(
              request,
              context,
              writeRequestId && writeFingerprint
                ? { requestId: writeRequestId, fingerprint: writeFingerprint }
                : undefined,
            );
          case "save": {
            const result = await edit(
              request,
              context,
              writeRequestId && writeFingerprint
                ? { requestId: writeRequestId, fingerprint: writeFingerprint }
                : undefined,
            );
            return request.dryRun ? { ...result, dryRun: true } : result;
          }
          case "previewImport":
            return {
              preview: await previewSource(
                request.location,
                request.kind,
                undefined,
                controller?.signal,
                previewRequestId,
              ),
            };
          case "cancel":
            await cleanup(request.previewId);
            return {};
          case "import": {
            const priorImport =
                writeRequestId && writeFingerprint
                  ? await operations.read(writeRequestId)
                  : undefined,
              plannedSkillIds = priorImport?.plannedSkillIds;
            if (priorImport?.plannedSkills) {
              const recovered = await recoverPlannedSkills(priorImport.plannedSkills, context);
              if (recovered) return { skills: recovered };
            }
            if (priorImport?.plannedSkillIds?.length === 0) return { skills: [] };
            if (plannedSkillIds?.length && !priorImport?.plannedSkills) {
              const existingSkills = await readSkillLibraryDefinitions(stateDir),
                recovered = plannedSkillIds.map((id) =>
                  existingSkills.find((skill) => skill.skillId === id),
                );
              if (recovered.every((skill): skill is SkillDefinition => skill !== undefined))
                return { skills: recovered };
            }
            const pending = await pendingPreview(request.previewId);
            if (pending.skillId) throw new Error("Refresh previews cannot import new identities.");
            if (
              !request.choices.length ||
              new Set(request.choices.map((choice) => choice.entryPath)).size !==
                request.choices.length
            )
              throw new Error("Select distinct Skill entries to import.");
            const existing = (await readSkillLibraryDefinitions(stateDir)).filter(
                (item) => !item.deleted,
              ),
              items: SkillDefinition[] = [];
            for (const choice of request.choices) {
              if (
                pending.preview.selectedEntryPaths &&
                !pending.preview.selectedEntryPaths.includes(choice.entryPath)
              )
                throw new Error("Selected entry does not match this source URL.");
              const entry = pending.preview.package.entries.find(
                (entry) => entry.entryPath === choice.entryPath,
              );
              if (!entry) throw new Error("Skill entry is absent from preview.");
              const name = choice.name ?? entry.name,
                duplicates = existing.filter(
                  (item) =>
                    item.name.normalize("NFC").toLowerCase() ===
                    name.normalize("NFC").toLowerCase(),
                );
              if (choice.duplicate === "skip" && duplicates.length) continue;
              let previous: SkillDefinition | undefined;
              if (choice.duplicate === "replace") {
                if (!choice.replaceSkillId || !choice.expectedRevision)
                  throw new Error("Replacement requires a stable Skill identity and revision.");
                previous = await revision(choice.replaceSkillId, choice.expectedRevision);
                if (items.some((item) => item.skillId === previous?.skillId))
                  throw new Error("Duplicate replacement target.");
              } else if (duplicates.length || items.some((item) => item.name === name))
                throw new Error(
                  "Duplicate Skill name; skip, choose a new name, or replace an existing Skill.",
                );
              items.push(
                makeItem({
                  pkg: pending.preview.package,
                  entryPath: choice.entryPath,
                  ...(plannedSkillIds?.[items.length]
                    ? { skillId: plannedSkillIds[items.length] }
                    : {}),
                  source: { ...pending.preview.source, entryPath: choice.entryPath },
                  name,
                  ...(context.actor ? { actor: context.actor } : {}),
                  ...(previous ? { previous } : {}),
                }),
              );
            }
            const renames = request.choices.filter(
              (choice) =>
                choice.name &&
                pending.preview.package.entries.find(
                  (entry) => entry.entryPath === choice.entryPath,
                )?.name !== choice.name &&
                items.some((item) => item.entryPath === choice.entryPath),
            );
            if (writeRequestId && writeFingerprint && !request.dryRun && !plannedSkillIds) {
              await operations.recordPlan(writeRequestId, "import", writeFingerprint, {
                plannedSkillIds: items.map((item) => item.skillId),
              });
            }
            if (request.dryRun) {
              let plannedPackageId = pending.preview.package.packageId;
              if (renames.length) {
                const owned = await fs.mkdtemp(path.join(staging, "dry-run-rename-"));
                try {
                  const original = await packages.materializePreview(
                      pending.packagePreviewId,
                      owned,
                    ),
                    directory = path.join(owned, original.rootName);
                  await fs.rename(path.join(owned, "content"), directory);
                  for (const choice of renames)
                    await renameEntry(
                      path.join(directory, ...choice.entryPath.split("/")),
                      choice.name!,
                    );
                  const renamed = await packages.preview({ path: directory });
                  plannedPackageId = renamed.package.packageId;
                  packages.cancelPreview(renamed.previewId);
                } finally {
                  await fs.rm(owned, { recursive: true, force: true });
                }
              }
              return {
                dryRun: true,
                plans: request.choices.map((choice) => {
                  const item = items.find((candidate) => candidate.entryPath === choice.entryPath);
                  return item
                    ? {
                        operation: "import",
                        status: "would_change" as const,
                        skillId: item.skillId,
                        entryPath: item.entryPath,
                        revision: item.revision,
                        packageId: plannedPackageId,
                      }
                    : {
                        operation: "import",
                        status: "skipped" as const,
                        entryPath: choice.entryPath,
                        message: "A Skill with this name already exists and was skipped.",
                      };
                }),
              };
            }
            if (items.length) {
              await context.beforeMutation?.();
              if (renames.length) {
                const owned = await fs.mkdtemp(path.join(staging, "rename-"));
                try {
                  const original = await packages.materializePreview(
                      pending.packagePreviewId,
                      owned,
                    ),
                    directory = path.join(owned, original.rootName);
                  await fs.rename(path.join(owned, "content"), directory);
                  for (const choice of renames)
                    await renameEntry(
                      path.join(directory, ...choice.entryPath.split("/")),
                      choice.name!,
                    );
                  const renamed = await packages.preview({ path: directory });
                  packages.cancelPreview(renamed.previewId);
                  const planned = items.map((item) => ({
                    ...item,
                    packageId: renamed.package.packageId,
                    locallyModified: true,
                  }));
                  if (writeRequestId && writeFingerprint)
                    await operations.recordPlan(writeRequestId, "import", writeFingerprint, {
                      plannedSkillIds: planned.map((item) => item.skillId),
                      plannedSkills: planned,
                    });
                  await packages.publishDirectory(directory, async (pkg) => {
                    if (pkg.packageId !== renamed.package.packageId)
                      throw new Error("Imported package changed after the operation plan.");
                    await commit(planned, true, context.beforeMutation);
                  });
                  const ids = new Set(items.map((item) => item.skillId));
                  const stored = (await readSkillLibraryDefinitions(stateDir)).filter((item) =>
                    ids.has(item.skillId),
                  );
                  items.splice(0, items.length, ...stored);
                } finally {
                  await fs.rm(owned, { recursive: true, force: true });
                }
              } else {
                if (writeRequestId && writeFingerprint)
                  await operations.recordPlan(writeRequestId, "import", writeFingerprint, {
                    plannedSkillIds: items.map((item) => item.skillId),
                    plannedSkills: items,
                  });
                await packages.publishPreview(pending.packagePreviewId, async () =>
                  commit(items, true, context.beforeMutation),
                );
              }
            }
            await cleanup(request.previewId);
            return { skills: items };
          }
          case "previewRefresh": {
            const skill = await revision(request.skillId, request.expectedRevision);
            if (!refreshableSource(skill))
              throw new Error(
                "Only GitHub, Skills.sh, and ClawHub sources can be refreshed in place.",
              );
            return {
              preview: await previewSource(skill.source.location, "url", skill, controller?.signal),
            };
          }
          case "refresh": {
            if (writeJournal?.plannedSkill) {
              const recovered = await recoverPlannedSkills([writeJournal.plannedSkill], context);
              if (recovered) return { skill: recovered[0] };
            }
            const current = await revision(request.skillId, request.expectedRevision),
              pending = await pendingPreview(request.previewId);
            if (pending.skillId !== current.skillId || pending.revision !== current.revision)
              throw new Error("Refresh preview belongs to a different Skill revision.");
            const candidate = makeItem({
              pkg: pending.preview.package,
              entryPath: current.source.entryPath,
              source: { ...pending.preview.source, entryPath: current.source.entryPath },
              previous: current,
              modified: false,
            });
            if (request.dryRun)
              return {
                dryRun: true,
                plan: {
                  operation: "refresh",
                  status:
                    candidate.packageId === current.packageId
                      ? ("unchanged" as const)
                      : ("would_change" as const),
                  skillId: current.skillId,
                  revision: current.revision,
                  packageId: candidate.packageId,
                  preview: pending.preview,
                },
              };
            let skill!: SkillDefinition;
            skill = candidate;
            if (writeRequestId && writeFingerprint)
              await operations.recordPlan(writeRequestId, "refresh", writeFingerprint, {
                plannedSkillId: candidate.skillId,
                plannedRevision: candidate.revision,
                plannedPackageId: candidate.packageId,
                plannedSkill: candidate,
              });
            await context.beforeMutation?.();
            await packages.publishPreview(pending.packagePreviewId, async (pkg) => {
              if (pkg.packageId !== candidate.packageId)
                throw new Error("Refresh package changed after the operation plan.");
              await commit([skill], true, context.beforeMutation);
            });
            await cleanup(request.previewId);
            return { skill };
          }
          case "readFile": {
            assertSkillResourcePath(request.path);
            const skill =
                request.expectedRevision === undefined
                  ? await readSkillDefinition(stateDir, request.skillId)
                  : await revision(request.skillId, request.expectedRevision),
              pkg = await packages.read(skill.packageId);
            if (
              !pkg.resources.some(
                (resource) =>
                  resource.kind === "file" && resource.path === `content/${request.path}`,
              )
            )
              throw new Error("File is not in the managed package.");
            const bytes = await expertResourceFiles.read(
                path.join(rootPath(skill.packageId), ...request.path.split("/")),
              ),
              text = bytes.toString("utf8");
            return {
              file: {
                path: request.path,
                content: bytes.toString("base64"),
                ...(Buffer.from(text).equals(bytes) && !text.includes("\0") ? { text } : {}),
              },
            };
          }
          case "previewDelete":
            await readSkillDefinition(stateDir, request.skillId);
            return { expertIds: await expertIds(request.skillId) };
          case "delete":
            if (request.dryRun) {
              const { current, affected } = await validateDelete(
                request.skillId,
                request.expectedRevision,
                request.confirmExpertIds,
              );
              return {
                dryRun: true,
                plan: {
                  operation: "delete",
                  status: "would_change" as const,
                  skillId: current.skillId,
                  revision: current.revision,
                  expertIds: affected,
                },
              };
            }
            await remove(
              request.skillId,
              request.expectedRevision,
              request.confirmExpertIds,
              context,
              writeRequestId && writeFingerprint
                ? {
                    requestId: writeRequestId,
                    operation: "delete",
                    fingerprint: writeFingerprint,
                  }
                : undefined,
            );
            return {};
          case "bindings":
            return { bindingResult: await applyBindingOperation(request, context) };
          case "bindExperts":
            return bindExperts(request, context);
          case "updateFromSource":
            return {
              updateResult: await updateFromSource(request, context, () =>
                preparedPreview("source"),
              ),
              ...(request.dryRun ? { dryRun: true } : {}),
            };
          case "batch": {
            const resultByIndex = new Map(
                (writeJournal?.batchResults ?? []).map(({ index, result }) => [index, result]),
              ),
              appendResult = async (
                index: number,
                result: NonNullable<SkillLibraryResponse["results"]>[number],
              ) => {
                resultByIndex.set(index, result);
                if (writeRequestId && writeFingerprint && !request.dryRun)
                  await operations.recordBatchResult(
                    writeRequestId,
                    writeFingerprint,
                    index,
                    result,
                  );
              };
            for (const [index, item] of request.items.entries()) {
              if (resultByIndex.get(index)?.success) continue;
              try {
                const planned = writeJournal?.batchIntents?.find(
                  (intent) => intent.index === index,
                )?.skill;
                if (planned) {
                  const recovered = await recoverPlannedSkills([planned], context);
                  if (recovered) {
                    await appendResult(index, {
                      skillId: item.skillId,
                      success: true,
                      status: "would_change",
                      message:
                        "Recovered the committed Skill state from the durable operation plan.",
                    });
                    continue;
                  }
                }
                if (item.operation === "delete") {
                  if (request.dryRun) {
                    const { current, affected } = await validateDelete(
                      item.skillId,
                      item.expectedRevision,
                      item.confirmExpertIds ?? [],
                    );
                    await appendResult(index, {
                      skillId: item.skillId,
                      success: true,
                      status: "would_change",
                      message: `Would delete; ${affected.length} Expert bindings would be removed.`,
                    });
                    continue;
                  }
                  await remove(
                    item.skillId,
                    item.expectedRevision,
                    item.confirmExpertIds ?? [],
                    context,
                    writeRequestId && writeFingerprint
                      ? {
                          requestId: writeRequestId,
                          operation: "batch",
                          fingerprint: writeFingerprint,
                          index,
                        }
                      : undefined,
                  );
                } else if (item.operation === "previewRefresh") {
                  const current = await revision(item.skillId, item.expectedRevision);
                  if (!refreshableSource(current))
                    throw new Error("This Skill has no supported hosted source and was skipped.");
                  const preview = preparedPreview(String(index));
                  if (request.dryRun) await cleanup(preview.previewId);
                  await appendResult(index, {
                    skillId: item.skillId,
                    success: true,
                    status: preview.resourceChanges.length ? "would_change" : "unchanged",
                    message: request.dryRun
                      ? "Validated source update; no preview was retained."
                      : "Review the source replacement before confirming.",
                    preview,
                  });
                  if (!request.dryRun) ownedPreviews.delete(preview.previewId);
                  continue;
                } else if (item.operation === "refresh") {
                  const current = await revision(item.skillId, item.expectedRevision),
                    pending = await pendingPreview(item.previewId ?? "");
                  if (pending.skillId !== current.skillId || pending.revision !== current.revision)
                    throw new Error("Refresh preview does not match this Skill revision.");
                  const candidate = makeItem({
                    pkg: pending.preview.package,
                    entryPath: current.source.entryPath,
                    source: { ...pending.preview.source, entryPath: current.source.entryPath },
                    previous: current,
                    modified: false,
                  });
                  if (request.dryRun) {
                    await appendResult(index, {
                      skillId: item.skillId,
                      success: true,
                      status:
                        candidate.packageId === current.packageId
                          ? ("unchanged" as const)
                          : ("would_change" as const),
                      message:
                        candidate.packageId === current.packageId
                          ? "Source content is unchanged."
                          : "Validated source update; the existing preview remains available.",
                      preview: pending.preview,
                    });
                    continue;
                  }
                  if (writeRequestId && writeFingerprint)
                    await operations.recordBatchIntent(writeRequestId, writeFingerprint, {
                      index,
                      skill: candidate,
                    });
                  await context.beforeMutation?.();
                  await packages.publishPreview(pending.packagePreviewId, async (pkg) =>
                    commit(
                      [
                        pkg.packageId === candidate.packageId
                          ? candidate
                          : (() => {
                              throw new Error("Refresh package changed after the operation plan.");
                            })(),
                      ],
                      true,
                      context.beforeMutation,
                    ),
                  );
                  await cleanup(pending.preview.previewId);
                } else if (item.operation === "updateFromSource") {
                  if (!item.requestId)
                    throw new Error("Batch source updates require a requestId for each Skill.");
                  const update = await updateFromSource(
                    {
                      action: "updateFromSource",
                      skillId: item.skillId,
                      expectedRevision: item.expectedRevision,
                      requestId: item.requestId,
                      ...(item.overwriteLocalEdits !== undefined
                        ? { overwriteLocalEdits: item.overwriteLocalEdits }
                        : {}),
                      ...(item.expectedPackageId
                        ? { expectedPackageId: item.expectedPackageId }
                        : {}),
                      ...(request.dryRun ? { dryRun: true } : {}),
                    },
                    context,
                    () => preparedPreview(String(index)),
                  );
                  const success = !["conflict", "failed"].includes(update.status);
                  await appendResult(index, {
                    skillId: item.skillId,
                    success,
                    message: update.error ?? update.status,
                    updateResult: update,
                    status: update.status === "updated" ? "would_change" : update.status,
                  });
                  continue;
                } else {
                  const current = await revision(item.skillId, item.expectedRevision);
                  const tags = item.tags ?? [];
                  if (stableJson(tags) === stableJson(current.tags)) {
                    await appendResult(index, {
                      skillId: item.skillId,
                      success: true,
                      status: "unchanged",
                      message: "Tags are unchanged.",
                    });
                    continue;
                  }
                  if (request.dryRun) {
                    await appendResult(index, {
                      skillId: item.skillId,
                      success: true,
                      status: "would_change",
                      message: "Validated tag update; no changes were saved.",
                    });
                    continue;
                  }
                  const plannedSkill = Schema.decodeUnknownSync(SkillDefinition)({
                    ...current,
                    tags,
                    revision: current.revision + 1,
                    updatedAt: new Date().toISOString(),
                  });
                  if (writeRequestId && writeFingerprint)
                    await operations.recordBatchIntent(writeRequestId, writeFingerprint, {
                      index,
                      skill: plannedSkill,
                    });
                  await context.beforeMutation?.();
                  await commit([plannedSkill], false, context.beforeMutation);
                }
                await appendResult(index, {
                  skillId: item.skillId,
                  success: true,
                  status: "would_change",
                  message: "Completed",
                });
              } catch (error) {
                if (writeRequestId && writeFingerprint && !request.dryRun) {
                  const latest = await operations.read(writeRequestId),
                    intent = latest?.batchIntents?.find((entry) => entry.index === index);
                  let recovered: NonNullable<SkillLibraryResponse["results"]>[number] | undefined;
                  if (intent?.skill) {
                    const current = (await readSkillLibraryDefinitions(stateDir)).find(
                      (skill) => skill.skillId === intent.skill!.skillId,
                    );
                    if (current && stableJson(current) === stableJson(intent.skill))
                      recovered = {
                        skillId: item.skillId,
                        success: true,
                        status: "would_change",
                        message:
                          "Recovered the committed Skill state from the durable operation plan.",
                      };
                  } else if (intent?.delete) {
                    const current = (await readSkillLibraryDefinitions(stateDir)).find(
                      (skill) => skill.skillId === intent.delete!.tombstone.skillId,
                    );
                    if (current && stableJson(current) === stableJson(intent.delete.tombstone))
                      recovered = {
                        skillId: item.skillId,
                        success: true,
                        status: "would_change",
                        message:
                          "Recovered the committed deletion from the durable operation plan.",
                      };
                  } else if (item.operation === "updateFromSource" && item.requestId) {
                    const nested = await operations.read(item.requestId);
                    if (
                      nested?.updateResult &&
                      ["updated", "unchanged", "skipped"].includes(nested.updateResult.status)
                    )
                      recovered = {
                        skillId: item.skillId,
                        success: true,
                        message: nested.updateResult.error ?? nested.updateResult.status,
                        updateResult: nested.updateResult,
                        status:
                          nested.updateResult.status === "updated"
                            ? "would_change"
                            : nested.updateResult.status,
                      };
                  }
                  if (recovered) {
                    await appendResult(index, recovered);
                    continue;
                  }
                }
                await appendResult(index, {
                  skillId: item.skillId,
                  success: false,
                  status:
                    error instanceof ExpertStoreError && error.code === "revision_conflict"
                      ? "conflict"
                      : "failed",
                  message: error instanceof Error ? error.message : String(error),
                });
              }
            }
            return {
              results: request.items.map(
                (item, index) =>
                  resultByIndex.get(index) ?? {
                    skillId: item.skillId,
                    success: false,
                    status: "failed" as const,
                    message: "No result was recorded for this batch item.",
                  },
              ),
              ...(request.dryRun ? { dryRun: true } : {}),
            };
          }
        }
      })();
      const response = responseRequestId
        ? { ...operationResponse, requestId: responseRequestId }
        : operationResponse;
      if (writeRequestId && writeOperation && writeFingerprint && !isDryRun) {
        if (writeOperation !== "batch" || response.results?.every((item) => item.success))
          await operations.recordResponse(
            writeRequestId,
            writeOperation,
            writeFingerprint,
            response,
          );
      }
      return response;
    };
    try {
      // Remote IO and independent validation never own the management commit
      // queue. The operation below rechecks revisions, plans and authorization.
      if (request.action === "updateFromSource") await prepareUpdate(request, "source");
      if (request.action === "batch") {
        const prior =
          writeRequestId && !isDryRun ? await operations.read(writeRequestId) : undefined;
        for (const [index, item] of request.items.entries()) {
          if (prior?.batchResults?.some((entry) => entry.index === index && entry.result.success))
            continue;
          if (item.operation === "previewRefresh")
            await prepareRefresh(item.skillId, item.expectedRevision, String(index));
          if (item.operation === "updateFromSource" && item.requestId)
            await prepareUpdate(
              { ...item, action: "updateFromSource", requestId: item.requestId, dryRun: isDryRun },
              String(index),
            );
        }
      }
      if (disposal) throw new Error("Skill library is closing; reconnect before continuing.");
      const independent =
        request.action === "list" ||
        request.action === "read" ||
        request.action === "readFile" ||
        request.action === "previewImport" ||
        request.action === "previewRefresh" ||
        request.action === "previewDelete" ||
        (request.action === "bindings" && request.operation === "list");
      return await (independent ? runOperation() : lock(runOperation));
    } finally {
      for (const id of ownedPreviews) await cleanup(id);
      if (previewRequestId) {
        const controllers = activePreviews.get(previewRequestId);
        controllers?.delete(controller!);
        if (!controllers?.size) activePreviews.delete(previewRequestId);
      }
    }
  };
  return {
    execute: (raw: SkillLibraryRequest, context?: SkillLibraryExecutionContext) =>
      track(executeRequest(raw, context)),
    /** HTTP upload uses the same preview/commit flow and authenticated host ownership. */
    previewArchive: (bytes: Buffer, fileName: string): Promise<SkillLibraryResponse> =>
      track(
        (async () => {
          if (disposal) throw new Error("Skill library is closing; reconnect before continuing.");
          assertSkillResourcePath(fileName);
          if (fileName.includes("/")) throw new Error("Archive upload requires a file name.");
          await expire();
          if (previews.size >= 100) throw new Error("Too many pending Skill previews.");
          const owned = await fs.mkdtemp(path.join(staging, "upload-"));
          try {
            const directory = path.join(owned, "package");
            await fs.mkdir(directory, { mode: 0o700 });
            await extractSkillArchive(bytes, directory);
            const result = await packages.preview({ path: directory });
            const preview: SkillLibraryPreview = {
              previewId: randomUUID(),
              package: result.package,
              expiresAt: result.expiresAt,
              source: {
                kind: "archive",
                location: fileName,
                entryPath: result.package.entries[0]!.entryPath,
                packageId: result.package.packageId,
              },
              resourceChanges: [],
              overwritesLocalEdits: false,
            };
            if (previews.size >= 100) {
              packages.cancelPreview(result.previewId);
              throw new Error("Too many pending Skill previews.");
            }
            previews.set(preview.previewId, {
              preview,
              packagePreviewId: result.previewId,
              ownedRoot: owned,
            });
            return { preview };
          } catch (error) {
            await fs.rm(owned, { recursive: true, force: true });
            throw error;
          }
        })(),
      ),
    dispose: () => {
      if (disposal) return disposal;
      for (const controllers of activePreviews.values())
        for (const controller of controllers) controller.abort();
      disposal = Promise.allSettled(activeRequests).then(() =>
        lock(async () => {
          for (const id of [...previews.keys()]) await cleanup(id);
          libraryInstances.delete(path.resolve(stateDir));
        }),
      );
      return disposal;
    },
  };
}
