import * as path from "node:path";
import { createHash } from "node:crypto";
import {
  FIXED_EXPERT_SKILL_POLICY,
  type CapabilityBinding,
  type EffectiveSuiteConfig,
  type ProviderExpertSession,
  type ResolvedExpertSkillEntry,
  type ResolvedSuiteResource,
  type SuiteRunAssemblyV2,
  type SuiteIssue,
  type SkillRunResourceReference,
  type LearningSessionContext,
  type ExpertSkillBinding,
  type ExpertSkillSelection,
  type SkillScope,
} from "@synara/contracts";
import { Effect } from "effect";
import type { SuiteCompositionStoreShape } from "../suites/SuiteCompositionStore";
import { capabilityBindingFingerprint, SuiteStoreError } from "../suites/SuiteCompositionStore";
import { suiteResourcesFor } from "../suites/SuiteBindingResolver";
import { suiteContentDigest } from "../suites/suiteIdentity";
import { createExpertStore, expertResourceFiles } from "./ExpertStore";
import { expertSnapshotSession } from "./expertSnapshotSession";
import { createFileResourceStore } from "./FileResourceStore";
import {
  createSkillPackageStore,
  readCompletedSkillPackageImports,
  verifySkillPackageContent,
} from "./SkillPackageStore";
import { readSkillLibrarySnapshot, resolveSkillBindings } from "./SkillLibraryStore";
import { assertSkillScopeForExpert, effectiveSkillScope } from "./skillEvolutionPolicy";
import {
  prepareSkillRunResources,
  privateSkillResourceRoot,
  verifySkillRunResources,
} from "./skillRunResources";
import { resolveSuiteRunConfiguration } from "./SuiteRunConfiguration";

export type SuiteRunStore = Pick<
  SuiteCompositionStoreShape,
  "read" | "readBinding" | "readFileRevision" | "publishedSkillPackages"
> &
  Partial<Pick<SuiteCompositionStoreShape, "readIssues">>;
export interface SuiteRuntimeContext {
  readonly bindingId: string;
  readonly assemblyId: string;
  readonly rootRunId: string;
  readonly effectiveConfig: EffectiveSuiteConfig;
  readonly resources: readonly ResolvedSuiteResource[];
  /** Runtime paths, including the original owner's persistent private working roots. */
  readonly skillEntries: readonly ResolvedExpertSkillEntry[];
  readonly contextFiles: readonly {
    readonly path: string;
    readonly contentHash: string;
    readonly content: string;
  }[];
  readonly resourceRoots: readonly {
    readonly path: string;
    readonly contentHash: string;
    readonly mode: "shared-readonly" | "run-private";
  }[];
}
export function suiteAssemblyFingerprint(
  record: Pick<
    SuiteRunAssemblyV2,
    | "threadId"
    | "rootRunId"
    | "bindingHash"
    | "baseSnapshotId"
    | "effectiveConfig"
    | "resources"
    | "skillEntries"
  >,
): string {
  const {
    threadId,
    rootRunId,
    bindingHash,
    baseSnapshotId,
    effectiveConfig,
    resources,
    skillEntries,
  } = record;
  const config = {
    ...effectiveConfig,
    issues: effectiveConfig.issues.map(({ checkedAt: _checkedAt, ...issue }) => issue),
  };
  return `sca_${suiteContentDigest({ threadId, rootRunId, bindingHash, baseSnapshotId, effectiveConfig: config, resources, skillEntries })}`;
}
export function createSuiteRunMaterialization(
  stateDir: string,
  store?: SuiteRunStore,
  frozenEntries?: (
    expertId: string,
    bindings: readonly ExpertSkillBinding[] | undefined,
  ) => Promise<readonly ResolvedExpertSkillEntry[] | undefined>,
) {
  const experts = createExpertStore(stateDir),
    packages = createSkillPackageStore(stateDir),
    files = createFileResourceStore(stateDir);
  const bindingFor = async (id: string): Promise<CapabilityBinding> => {
    if (!store) throw new Error("Suite capability storage is unavailable.");
    const binding = await Effect.runPromise(store.readBinding(id));
    if (!binding || binding.bindingHash !== capabilityBindingFingerprint(binding))
      throw new Error("Suite capability binding is missing or corrupt.");
    return binding;
  };
  const assertBinding = (record: SuiteRunAssemblyV2, binding: CapabilityBinding) => {
    if (
      record.bindingHash !== binding.bindingHash ||
      record.assemblyId !== suiteAssemblyFingerprint(record) ||
      (binding.purpose.kind === "hub-coordinator"
        ? record.baseSnapshotId !== null
        : record.baseSnapshotId !== binding.purpose.expertSnapshotId)
    )
      throw new Error("Suite Run identity does not match its trusted binding.");
  };
  const references = (record: SuiteRunAssemblyV2): SkillRunResourceReference[] => [
    ...new Map(
      record.resources
        .filter((item) => item.mode === "run-private" && item.packageId?.startsWith("pkg_"))
        .map((item) => [
          item.packageId!,
          {
            packageId: item.packageId!,
            mode: "run-private" as const,
            ownerRootRunId: item.ownerRootRunId,
            rootPath: privateSkillResourceRoot(stateDir, item.ownerRootRunId, item.packageId!),
          },
        ]),
    ).values(),
  ];
  const sessionFor = async (
    record: SuiteRunAssemblyV2,
    knowledge?: LearningSessionContext,
  ): Promise<ProviderExpertSession | undefined> => {
    const binding = await bindingFor(record.bindingId);
    assertBinding(record, binding);
    if (record.baseSnapshotId === null) return undefined;
    const snapshot = await experts.readSnapshot(record.baseSnapshotId);
    if (
      knowledge &&
      (knowledge.rootRunId !== record.rootRunId ||
        knowledge.snapshotId !== record.baseSnapshotId ||
        knowledge.scope.expertId !== snapshot.expertId)
    )
      throw new Error("Suite Run knowledge identity is corrupt.");
    const refs = references(record);
    await verifySkillRunResources(stateDir, record.skillEntries, refs);
    return {
      ...expertSnapshotSession(snapshot),
      skillPolicy: FIXED_EXPERT_SKILL_POLICY,
      skillsRoot: path.join(stateDir, "experts", "skill-packages"),
      skillEntries: record.skillEntries,
      skills: record.skillEntries.map(({ name, path }) => ({ name, path })),
      skillRootRunId: record.rootRunId,
      skillAssemblyId: record.assemblyId,
      ...(refs.length ? { skillResourceRefs: refs } : {}),
      ...(knowledge ? { knowledge } : {}),
    };
  };
  const runtimeContext = async (record: SuiteRunAssemblyV2): Promise<SuiteRuntimeContext> => {
    const binding = await bindingFor(record.bindingId);
    assertBinding(record, binding);
    const contextFiles: { path: string; contentHash: string; content: string }[] = [],
      resourceRoots: {
        path: string;
        contentHash: string;
        mode: "shared-readonly" | "run-private";
      }[] = [];
    const privateReferences = references(record);
    await verifySkillRunResources(stateDir, record.skillEntries, privateReferences);
    const packagesById = new Map<string, { contentRoot: string; contentHash: string }>();
    const rootPaths = new Set<string>(),
      contextPaths = new Set<string>();
    for (const resource of record.resources) {
      const ref = resource.ref;
      if (ref.kind === "connection") {
        if (
          resource.contentHash !==
          suiteContentDigest({
            connection: ref.connection,
            server:
              binding.mcpBinding?.servers.find((item) => item.id === ref.connection.id) ?? null,
          })
        )
          throw new Error("Fixed Suite connection resource changed.");
      } else if (ref.kind === "files") {
        if (!resource.packageId || !store)
          throw new Error("Fixed file resource identity is incomplete.");
        const fixed = await Effect.runPromise(
          store.readFileRevision(ref.resourceId, Number(resource.revision)),
        );
        if (!fixed || fixed.packageId !== resource.packageId)
          throw new Error("Fixed file resource revision changed.");
        const sealed = await files.read(resource.packageId);
        if (sealed.packageId.slice(4) !== resource.contentHash)
          throw new Error("Fixed file resource content changed.");
        if (!rootPaths.has(sealed.rootPath)) {
          resourceRoots.push({
            path: sealed.rootPath,
            contentHash: resource.contentHash,
            mode: resource.mode,
          });
          rootPaths.add(sealed.rootPath);
        }
        if (ref.purpose === "instructions")
          for (const entry of sealed.resources) {
            if (entry.kind !== "file") continue;
            const target = path.join(sealed.rootPath, ...entry.path.split("/"));
            if (contextPaths.has(target)) continue;
            const bytes = await expertResourceFiles.read(target, sealed.rootPath);
            if (createHash("sha256").update(bytes).digest("hex") !== entry.sha256)
              throw new Error("Suite instruction content changed.");
            contextFiles.push({
              path: target,
              contentHash: entry.sha256,
              content: bytes.toString("utf8"),
            });
            contextPaths.add(target);
          }
      } else {
        if (!resource.packageId) throw new Error("Fixed Skill resource identity is incomplete.");
        let verified = packagesById.get(resource.packageId);
        if (!verified) {
          const content = await verifySkillPackageContent(stateDir, resource.packageId);
          verified = {
            contentRoot: content.contentRoot,
            contentHash: suiteContentDigest(content.resources),
          };
          packagesById.set(resource.packageId, verified);
        }
        if (verified.contentHash !== resource.contentHash)
          throw new Error("Fixed Skill package content changed.");
        const root =
          resource.mode === "run-private"
            ? privateSkillResourceRoot(stateDir, resource.ownerRootRunId, resource.packageId)
            : verified.contentRoot;
        if (!rootPaths.has(root)) {
          resourceRoots.push({
            path: root,
            contentHash: resource.contentHash,
            mode: resource.mode,
          });
          rootPaths.add(root);
        }
      }
    }
    const runtimeEntries = record.skillEntries.map((entry) => {
      const reference = privateReferences.find((item) => item.packageId === entry.packageId);
      return reference
        ? { ...entry, path: path.join(reference.rootPath, ...entry.entryPath.split("/")) }
        : entry;
    });
    return {
      bindingId: record.bindingId,
      assemblyId: record.assemblyId,
      rootRunId: record.rootRunId,
      effectiveConfig: record.effectiveConfig,
      resources: record.resources,
      skillEntries: runtimeEntries,
      contextFiles,
      resourceRoots,
    };
  };
  const prepare = async (
    input: {
      threadId: SuiteRunAssemblyV2["threadId"];
      rootRunId: string;
      baseSnapshotId: string | null;
      capabilityBindingId: string;
      createdAt: string;
      projectRoot?: string;
    },
    inherited?: SuiteRunAssemblyV2,
  ): Promise<SuiteRunAssemblyV2> => {
    const binding = await bindingFor(input.capabilityBindingId);
    if (
      binding.purpose.kind === "hub-coordinator"
        ? input.baseSnapshotId !== null
        : input.baseSnapshotId !== binding.purpose.expertSnapshotId
    )
      throw new Error("Suite base identity does not match its execution purpose.");
    if (inherited) {
      if (
        inherited.bindingId !== binding.bindingId ||
        inherited.baseSnapshotId !== input.baseSnapshotId
      )
        throw new Error("Suite continuation changed its capability identity.");
      await runtimeContext(inherited);
      const next = {
        ...inherited,
        threadId: input.threadId,
        rootRunId: input.rootRunId,
        createdAt: input.createdAt,
        phase: "prepared" as const,
      };
      return { ...next, assemblyId: suiteAssemblyFingerprint(next) };
    }
    const snapshot =
      input.baseSnapshotId === null ? null : await experts.readSnapshot(input.baseSnapshotId);
    const composition =
      binding.suite === null ? null : await Effect.runPromise(store!.read(binding.suite));
    if (binding.suite && !composition) throw new Error("The bound Suite revision is missing.");
    const issues: SuiteIssue[] =
      composition && store?.readIssues
        ? [...(await Effect.runPromise(store.readIssues(composition.ref)))]
        : [];
    const config = await resolveSuiteRunConfiguration({
      ...(composition ? { defaults: composition.defaults, suiteId: composition.ref.suiteId } : {}),
      ...(input.projectRoot ? { projectRoot: input.projectRoot } : {}),
      createdAt: input.createdAt,
      issues,
    });
    const uses = composition
      ? [...suiteResourcesFor(composition, binding.purpose, snapshot?.expertId)]
      : [];
    const definition = snapshot ? await experts.read(snapshot.expertId) : null;
    if (snapshot && !definition) throw new Error("The bound Expert is unavailable.");
    // Capture the mutable library once. Every reference in this new logical Run uses this view.
    const needsLibrary =
      uses.some((use) => use.ref.kind === "managed-skill" || use.ref.kind === "skill") ||
      definition?.skillBindings?.some((item) => item.enabled) ||
      (definition?.skillSelections ?? snapshot?.skillSelections ?? []).length > 0;
    const library = needsLibrary
      ? await readSkillLibrarySnapshot(stateDir).then(
          (value) => ({ ok: true as const, value }),
          () => ({ ok: false as const }),
        )
      : null;
    const definitions = library?.ok ? library.value.skills : [];
    const managedById = new Map(
      definitions.filter((item) => !item.deleted).map((item) => [item.skillId, item]),
    );
    const ownsScope = (scope: SkillScope) =>
      scope.kind === "shared" || scope.expertId === snapshot?.expertId;
    const ownership = new Map<string, SkillScope[]>();
    if (library?.ok)
      for (const record of library.value.packageScopes) {
        const key = `${record.packageId}\0${record.entryPath}`;
        const scopes = ownership.get(key);
        if (scopes) scopes.push(record.scope);
        else ownership.set(key, [record.scope]);
      }
    let completedImports: Promise<ReadonlySet<string>> | undefined;
    let publishedAssets: Promise<ReadonlySet<string>> | undefined;
    const entries: ResolvedExpertSkillEntry[] = [],
      resources: ResolvedSuiteResource[] = [];
    if (snapshot && definition) {
      const frozen = await frozenEntries?.(definition.id, definition.skillBindings);
      if (frozen) entries.push(...frozen);
      else if (definition.skillBindings)
        for (const direct of definition.skillBindings) {
          if (!direct.enabled) continue;
          const managed = managedById.get(direct.skillId);
          if (!managed) {
            issues.push({
              code: "resource_missing",
              category: "dependency",
              subject: { kind: "resource", id: direct.skillId, path: null },
              action: "run",
              effect: "limit-capability",
              message: "An Expert Skill is unavailable for this Run.",
              evidenceRef: null,
              checkedAt: input.createdAt,
              recovery: "repair-source",
            });
            continue;
          }
          try {
            assertSkillScopeForExpert(managed, snapshot.expertId);
            const selections = await resolveSkillBindings(stateDir, [direct], snapshot.expertId, {
              definitions,
            });
            for (const selection of selections)
              uses.push({
                key: `expert-skill-${uses.length}`,
                audience: "shared",
                purpose: "Expert direct Skill",
                ref: { kind: "skill", sourceId: snapshot.snapshotId, selection },
              });
          } catch {
            issues.push({
              code: "dependency_conflict",
              category: "dependency",
              subject: { kind: "resource", id: direct.skillId, path: null },
              action: "run",
              effect: "limit-capability",
              message: "This Expert Skill selection could not be resolved for this Run.",
              evidenceRef: null,
              checkedAt: input.createdAt,
              recovery: "choose-alternative",
            });
          }
        }
      else
        for (const selection of definition.skillSelections ?? snapshot.skillSelections ?? [])
          uses.push({
            key: `expert-skill-${uses.length}`,
            audience: "shared",
            purpose: "Expert direct Skill",
            ref: { kind: "skill", sourceId: snapshot.snapshotId, selection },
          });
      for (const entry of entries)
        uses.push({
          key: `expert-frozen-${uses.length}`,
          audience: "shared",
          purpose: "Frozen Expert Skill",
          ref: {
            kind: "skill",
            sourceId: snapshot.snapshotId,
            selection: {
              packageId: entry.packageId,
              entryPath: entry.entryPath,
              ...(entry.resourceMode ? { resourceMode: entry.resourceMode } : {}),
            },
          },
        });
    }
    const directUses = uses.filter((use) => use.ref.sourceId === snapshot?.snapshotId);
    for (const use of [
      ...directUses,
      ...uses.filter((use) => use.ref.sourceId !== snapshot?.snapshotId),
    ]) {
      try {
        const ref = use.ref;
        let revision: string,
          packageId: string | null = null,
          entryPath: string | null = null,
          contentHash: string,
          mode: ResolvedSuiteResource["mode"] = "shared-readonly";
        if (ref.kind === "connection") {
          const server = binding.mcpBinding?.servers.find((item) => item.id === ref.connection.id);
          revision = String(server?.configRevision ?? "unavailable");
          contentHash = suiteContentDigest({ connection: ref.connection, server: server ?? null });
          const selected = binding.connections.find((item) => item.id === ref.connection.id);
          if (selected?.enabled === false || !server?.configRevision)
            issues.push({
              code: selected?.enabled === false ? "dependency_conflict" : "resource_missing",
              category: "dependency",
              subject: { kind: "connection", id: ref.connection.id, path: null },
              action: "tool-call",
              effect: "limit-capability",
              message: "This connection selection is unavailable in the fixed capability binding.",
              evidenceRef: null,
              checkedAt: input.createdAt,
              recovery: "choose-alternative",
            });
        } else if (ref.kind === "files") {
          const fixed = await Effect.runPromise(store!.readFileRevision(ref.resourceId));
          if (!fixed) throw new Error("File resource is unavailable.");
          const sealed = await files.read(fixed.packageId);
          revision = String(fixed.revision);
          packageId = sealed.packageId;
          contentHash = sealed.packageId.slice(4);
        } else {
          if (library?.ok !== true)
            throw new SuiteStoreError("Skill ownership could not be verified.", "resource_corrupt");
          if (ref.kind === "skill") {
            const scopes = ownership.get(`${ref.selection.packageId}\0${ref.selection.entryPath}`);
            if (scopes && !scopes.some(ownsScope))
              throw new SuiteStoreError(
                "This execution cannot access the referenced private Skill.",
                "permission_denied",
              );
            if (!scopes) {
              // A snapshot may contain raw selections copied by an untrusted import.
              // Its immutability is not independent permission evidence.
              let publishedBySuite = false;
              if (composition) {
                publishedAssets ??= Effect.runPromise(
                  store!.publishedSkillPackages(composition.ref),
                );
                publishedBySuite = (await publishedAssets).has(ref.selection.packageId);
              }
              if (!publishedBySuite) {
                completedImports ??= readCompletedSkillPackageImports(stateDir);
                if (!(await completedImports).has(ref.selection.packageId))
                  throw new SuiteStoreError(
                    "Ownership of this legacy Skill package is unavailable.",
                    "identity_unavailable",
                  );
              }
            }
          }
          const managed =
            ref.kind === "managed-skill"
              ? managedById.get(ref.managedSkillId)
              : definitions.find(
                  (item) =>
                    !item.deleted &&
                    item.packageId === ref.selection.packageId &&
                    item.entryPath === ref.selection.entryPath &&
                    ownsScope(effectiveSkillScope(item)),
                );
          if (ref.kind === "managed-skill" && !managed)
            throw new Error("Managed Skill is unavailable.");
          if (managed) {
            if (snapshot) assertSkillScopeForExpert(managed, snapshot.expertId);
            else if (effectiveSkillScope(managed).kind !== "shared")
              throw new Error("Coordinator cannot access Expert-private Skills.");
          }
          const selection: ExpertSkillSelection =
            ref.kind === "skill"
              ? ref.selection
              : { packageId: managed!.packageId, entryPath: managed!.entryPath };
          const resolved = await packages.resolveSelections([selection]);
          for (const entry of resolved)
            if (
              entries.some(
                (item) =>
                  (item.packageId === entry.packageId &&
                    (item.resourceMode ?? "shared-readonly") !==
                      (entry.resourceMode ?? "shared-readonly")) ||
                  (item.name === entry.name &&
                    (item.packageId !== entry.packageId || item.entryPath !== entry.entryPath)),
              )
            )
              throw new SuiteStoreError(
                "Skill resource selection conflicts.",
                "dependency_conflict",
              );
          packageId = selection.packageId;
          entryPath = selection.entryPath;
          revision = managed ? String(managed.revision) : packageId;
          mode = selection.resourceMode ?? "shared-readonly";
          contentHash = suiteContentDigest(
            (await verifySkillPackageContent(stateDir, packageId)).resources,
          );
          for (const entry of resolved)
            if (
              !entries.some(
                (item) => item.packageId === entry.packageId && item.entryPath === entry.entryPath,
              )
            )
              entries.push({ ...entry, ...(managed ? { managedSkillId: managed.skillId } : {}) });
        }
        resources.push({
          key: use.key,
          ref,
          revision,
          packageId,
          entryPath,
          contentHash,
          mode,
          ownerRootRunId: input.rootRunId,
        });
      } catch (cause) {
        issues.push({
          code: cause instanceof SuiteStoreError ? cause.code : "resource_missing",
          category: "dependency",
          subject: { kind: "resource", id: use.key, path: null },
          action: "run",
          effect: "limit-capability",
          message:
            "This Suite resource could not be materialized; other capabilities remain available.",
          evidenceRef: null,
          checkedAt: input.createdAt,
          recovery: "repair-source",
        });
      }
    }
    await prepareSkillRunResources(stateDir, input.rootRunId, entries);
    const record = {
      schemaVersion: 2 as const,
      assemblyId: "",
      threadId: input.threadId,
      rootRunId: input.rootRunId,
      bindingId: binding.bindingId,
      bindingHash: binding.bindingHash,
      baseSnapshotId: input.baseSnapshotId,
      effectiveConfig: config,
      resources,
      skillEntries: entries,
      phase: "prepared" as const,
      hasInitializationEffects: false,
      createdAt: input.createdAt,
    };
    return { ...record, assemblyId: suiteAssemblyFingerprint(record) };
  };
  return { prepare, sessionFor, runtimeContext };
}
