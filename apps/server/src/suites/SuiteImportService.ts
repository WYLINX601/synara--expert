import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  SuitePreview as SuitePreviewSchema,
  SuitePreviewInput as SuitePreviewInputSchema,
  SuiteImportRequest as SuiteImportRequestSchema,
  type ExpertConnection,
  type ExpertSaveInput,
  type SkillPackage,
  type SkillScope,
  type SkillLibraryRequest,
  type SkillLibraryResponse,
  type SuiteComposition,
  type SuiteSummary,
  type SuiteImportReceipt,
  type SuiteImportRequest,
  type SuiteIssue,
  type SuitePreview,
  type SuitePreviewInput,
  type SuiteRef,
  type SuiteResourceRef,
  type SuiteResourceUse,
} from "@synara/contracts";
import { Effect, Layer, Schema, ServiceMap } from "effect";
import { ServerConfig } from "../config";
import { createFileResourceStore } from "../experts/FileResourceStore";
import type { ExpertStore } from "../experts/ExpertStore";
import type { ExpertConnectionStore } from "../experts/ExpertConnectionStore";
import {
  readCompletedSkillPackageImports,
  type SkillPackageStore,
} from "../experts/SkillPackageStore";
import { readSkillLibrarySnapshot } from "../experts/SkillLibraryStore";
import { readPrivateJsonFile, writePrivateFileAtomically } from "../experts/ExpertMcpStorage";
import { withSkillPackageLifecycle } from "../experts/skillPackageLifecycle";
import { bmadPresetSelections, BMAD_ROLE_PRESETS } from "../experts/bmadSkillPreset";
import { GitHubCli } from "../git/Services/GitHubCli";
import { ExpertDelegationArtifacts } from "../workbench/host/expertDelegationArtifacts";
import { WorkbenchExpertRuntime } from "../workbench/runtimeLayer";
import {
  SuiteCompositionStore,
  SuiteStoreError,
  suiteCompositionFingerprint,
  suiteImportSourceKey,
  type SuiteImportPlan,
  type SuiteCompositionStoreShape,
} from "./SuiteCompositionStore";
import {
  analyzeSuiteSource,
  compileBmadRole,
  type AnalyzedSuiteSource,
} from "./SuiteSourceAdapters";
import {
  createSuiteSourceSnapshot,
  sourceIssue,
  SuiteSourceError,
  type SuiteSourceSnapshotOptions,
} from "./SuiteSourceSnapshot";
import { canonicalSuiteJson, suiteContentDigest } from "./suiteIdentity";

const PREVIEW_TTL_MS = 15 * 60 * 1_000;
const MAX_PREVIEWS = 100;
const StoredPreview = Schema.Struct({
  preview: SuitePreviewSchema,
  rootPath: Schema.String,
});
interface ImportRuntime {
  readonly experts: ExpertStore;
  readonly skillPackages: SkillPackageStore;
  readonly connections: ExpertConnectionStore;
  readonly skillLibrary: { execute(request: SkillLibraryRequest): Promise<SkillLibraryResponse> };
}
export interface SuiteImportServiceShape {
  readonly preview: (request: SuitePreviewInput) => Effect.Effect<SuitePreview, SuiteStoreError>;
  readonly cancelPreview: (
    previewId: string,
  ) => Effect.Effect<{ cancelled: boolean }, SuiteStoreError>;
  readonly commit: (
    request: SuiteImportRequest,
  ) => Effect.Effect<SuiteImportReceipt, SuiteStoreError>;
  readonly getReceipt: (
    operationId: string,
  ) => Effect.Effect<SuiteImportReceipt | null, SuiteStoreError>;
  readonly list: () => Effect.Effect<readonly SuiteSummary[], SuiteStoreError>;
  readonly read: (ref: SuiteRef) => Effect.Effect<SuiteComposition, SuiteStoreError>;
}
const attempt = <A>(run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) =>
      cause instanceof SuiteStoreError
        ? cause
        : cause instanceof SuiteSourceError
          ? new SuiteStoreError(cause.issue.message, cause.issue.code, { cause })
          : new SuiteStoreError("Suite owner operation failed.", "commit_failed", { cause }),
  });
const checked = <A>(run: () => A) =>
  Effect.try({
    try: run,
    catch: (cause) =>
      new SuiteStoreError("Invalid Suite request or persisted preview.", "invalid_manifest", {
        cause,
      }),
  });
const issue = (
  code: SuiteIssue["code"],
  message: string,
  subject: SuiteIssue["subject"],
  action: SuiteIssue["action"] = "run",
  effect: SuiteIssue["effect"] = "limit-capability",
): SuiteIssue => ({ ...sourceIssue(code, message, subject, effect), action });

/** File owners run outside SQL; the SQL journal is the only publication authority. */
export function createSuiteImportService(input: {
  readonly stateDir: string;
  readonly store: SuiteCompositionStoreShape;
  readonly runtime: ImportRuntime;
  readonly readExternalFileResourcePackages: () => Promise<ReadonlySet<string>>;
  readonly sourceOptions?: SuiteSourceSnapshotOptions;
}): SuiteImportServiceShape {
  const { stateDir, store, runtime } = input;
  if (!path.isAbsolute(stateDir) || stateDir.includes("\0"))
    throw new Error("Suite state directory must be absolute.");
  const files = createFileResourceStore(stateDir);
  const snapshots = createSuiteSourceSnapshot(stateDir, input.sourceOptions);
  const previewDirectory = path.join(stateDir, "suites", "previews");
  // Request IDs are opaque and may contain slash/dot components. Never join them.
  const previewPath = (id: string) => path.join(previewDirectory, `${suiteContentDigest(id)}.json`);
  const readPreview = async (filePath: string) => {
    const raw = await readPrivateJsonFile(
      filePath,
      16 * 1024 * 1024,
      "Suite preview is unavailable.",
      true,
    );
    if (raw === undefined) return undefined;
    const value = Schema.decodeUnknownSync(StoredPreview)(raw);
    if (previewPath(value.preview.previewId) !== filePath)
      throw new SuiteStoreError("Suite preview identity is corrupt.", "resource_corrupt");
    return value;
  };
  const releaseSources = async (
    sources: ReadonlyArray<{ readonly contentHash: string; readonly rootPath: string }>,
    retained: ReadonlyArray<typeof StoredPreview.Type>,
  ) => {
    if (sources.length === 0) return;
    const protectedPackages = new Set(await Effect.runPromise(store.referencedFilePackages()));
    for (const packageId of await input.readExternalFileResourcePackages())
      protectedPackages.add(packageId);
    for (const saved of retained) protectedPackages.add(`res_${saved.preview.contentHash}`);
    const released = new Set<string>();
    for (const source of sources) {
      const packageId = `res_${source.contentHash}`;
      if (!protectedPackages.has(packageId) && !released.has(packageId)) {
        await snapshots.release(source.contentHash, source.rootPath);
        released.add(packageId);
      }
    }
  };
  // All readers that can create a journal share the package lifecycle lock with
  // expiry collection, so a source cannot disappear between planning and admission.
  const reapPreviews = async (cancelId?: string) => {
    let names: string[];
    try {
      names = await fs.readdir(previewDirectory);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
      return { live: [], cancelled: false };
    }
    const live: Array<typeof StoredPreview.Type> = [];
    const expired: Array<typeof StoredPreview.Type> = [];
    const now = Date.now();
    let cancelled = false;
    for (const name of names.sort()) {
      if (!/^[a-f0-9]{64}\.json$/u.test(name)) continue;
      const saved = await readPreview(path.join(previewDirectory, name));
      if (!saved) continue;
      if (saved.preview.previewId === cancelId || Date.parse(saved.preview.expiresAt) <= now) {
        expired.push(saved);
        if (saved.preview.previewId === cancelId && Date.parse(saved.preview.expiresAt) > now)
          cancelled = true;
      } else live.push(saved);
    }
    await releaseSources(
      expired.map((saved) => ({
        contentHash: saved.preview.contentHash,
        rootPath: saved.rootPath,
      })),
      live,
    );
    for (const saved of expired) await fs.unlink(previewPath(saved.preview.previewId));
    return { live, cancelled };
  };
  const readSource = async (rootPath: string, contentHash: string) => {
    const sealed = await files.read(`res_${contentHash}`);
    if (sealed.rootPath !== rootPath)
      throw new SuiteStoreError("Suite source root is corrupt.", "resource_corrupt");
    return sealed;
  };
  const diagnoseReferences = async (analysis: AnalyzedSuiteSource): Promise<SuiteIssue[]> => {
    const issues: SuiteIssue[] = [];
    const managedSkills = (analysis.manifest.resources ?? []).some(
      (resource) =>
        resource.kind === "resource-reference" && resource.resourceRef.kind === "managed-skill",
    )
      ? ((await runtime.skillLibrary.execute({ action: "list" })).skills ?? [])
      : [];
    for (const member of analysis.manifest.experts)
      if (member.kind === "reference") {
        const expert = await runtime.experts.read(member.expertId);
        if (!expert || expert.archived)
          issues.push(
            issue(
              "identity_unavailable",
              "Referenced Expert is missing or archived.",
              { kind: "expert", id: member.key, path: null },
              "run",
              "deny-action",
            ),
          );
      }
    for (const resource of analysis.manifest.resources ?? []) {
      const ref = resource.kind === "resource-reference" ? resource.resourceRef : undefined;
      const connectionId =
        resource.kind === "connection"
          ? resource.connectionId
          : ref?.kind === "connection"
            ? ref.connection.id
            : undefined;
      if (connectionId) {
        const config = await runtime.connections.read(connectionId);
        if (!config)
          issues.push(
            issue(
              "resource_missing",
              "Referenced connection does not exist; import never creates connections.",
              { kind: "connection", id: connectionId, path: null },
            ),
          );
        else {
          const state = await runtime.connections.readState(connectionId);
          issues.push(
            issue(
              state.status === "active" ? "tool_unreachable" : "permission_denied",
              state.status === "active"
                ? "Connection is referenced, but tool availability has not been probed."
                : `Referenced connection is ${state.status}.`,
              { kind: "connection", id: connectionId, path: null },
              "tool-call",
              state.status === "active" ? "observe" : "deny-action",
            ),
          );
        }
      }
      if (ref && ref.kind !== "connection") {
        try {
          if (ref.kind === "files") {
            const revision = await Effect.runPromise(store.readFileRevision(ref.resourceId));
            if (!revision)
              issues.push(
                issue("resource_missing", "Referenced file resource is missing.", {
                  kind: "resource",
                  id: resource.key,
                  path: null,
                }),
              );
            else await files.read(revision.packageId);
          } else if (ref.kind === "skill") {
            const pkg = await runtime.skillPackages.read(ref.selection.packageId);
            if (!pkg.entries.some((entry) => entry.entryPath === ref.selection.entryPath))
              issues.push(
                issue("resource_missing", "Referenced Skill entry is missing.", {
                  kind: "resource",
                  id: resource.key,
                  path: null,
                }),
              );
          } else {
            // The owner inventory distinguishes absence from unrelated read failures:
            // the library's read operation throws an ordinary Error for absence.
            const definition = managedSkills.find((skill) => skill.skillId === ref.managedSkillId);
            if (!definition || definition.deleted)
              issues.push(
                issue("resource_missing", "Referenced managed Skill is missing or deleted.", {
                  kind: "resource",
                  id: resource.key,
                  path: null,
                }),
              );
            else
              await runtime.skillLibrary.execute({
                action: "read",
                skillId: ref.managedSkillId,
              });
          }
        } catch (cause) {
          const code =
            cause !== null && typeof cause === "object" && "code" in cause ? cause.code : undefined;
          if (code !== "not_found" && code !== "ENOENT") throw cause;
          issues.push(
            issue("resource_missing", "Referenced resource does not exist in its owning store.", {
              kind: "resource",
              id: resource.key,
              path: null,
            }),
          );
        }
      }
    }
    if (
      Object.keys(analysis.roles).length === 0 &&
      !analysis.manifest.experts.some(
        (member) =>
          member.kind === "reference" &&
          !issues.some(
            (entry) =>
              entry.subject.kind === "expert" &&
              entry.subject.id === member.key &&
              entry.effect === "deny-action",
          ),
      )
    )
      throw new SuiteStoreError(
        "No readable or existing member identity is available.",
        "identity_unavailable",
      );
    return issues;
  };
  const makePlan = async (
    request: SuiteImportRequest,
    saved: typeof StoredPreview.Type,
  ): Promise<SuiteImportPlan> => {
    const source = await readSource(saved.rootPath, request.contentHash);
    const analysis = await analyzeSuiteSource(source.rootPath, saved.preview.source);
    if (
      analysis.adapterId !== saved.preview.adapterId ||
      analysis.adapterVersion !== saved.preview.adapterVersion
    )
      throw new SuiteStoreError("Suite adapter identity changed.", "content_changed");
    const manifest = analysis.manifest;
    const expertIds = Object.fromEntries(
      manifest.experts.map((member) => [
        member.key,
        member.kind === "reference"
          ? member.expertId
          : `expert_${randomUUID().replaceAll("-", "")}`,
      ]),
    );
    const issues = [...analysis.issues, ...(await diagnoseReferences(analysis))];
    const assets: SuiteImportPlan["assets"][number][] = [];
    const revisions: SuiteImportPlan["fileResourceRevisions"][number][] = [];
    const refs = new Map<string, SuiteResourceRef>();
    const skillRoots = new Map<string, SkillPackage>();
    const fileRoots = new Map<string, string>();
    for (const resource of manifest.resources ?? []) {
      if (resource.kind === "connection") {
        refs.set(resource.key, {
          kind: "connection",
          sourceId: saved.preview.source.sourceId,
          connection: {
            id: resource.connectionId,
            required: true,
            tools: resource.tools.mode === "all" ? [] : [...resource.tools.names],
            toolMode: resource.tools.mode,
            enabled: true,
          },
        });
      } else if (resource.kind === "resource-reference")
        refs.set(resource.key, resource.resourceRef);
      else {
        const relative = resource.kind === "skill" ? resource.packageRoot : resource.root;
        const rootPath = relative === "." ? source.rootPath : path.join(source.rootPath, relative);
        try {
          if (resource.kind === "skill") {
            let pkg = skillRoots.get(rootPath);
            if (!pkg) {
              const preview = await runtime.skillPackages.preview({ path: rootPath });
              pkg = preview.package;
              runtime.skillPackages.cancelPreview(preview.previewId);
              skillRoots.set(rootPath, pkg);
            }
            if (!pkg.entries.some((entry) => entry.entryPath === resource.entryPath))
              throw new SuiteStoreError(
                "Declared original Skill entry is missing.",
                "resource_missing",
              );
            if (
              analysis.adapterId === "bmad-61e01f8-v1" &&
              issues.some(
                (item) =>
                  item.subject.kind === "resource" &&
                  item.subject.id === resource.key &&
                  item.effect !== "observe",
              )
            )
              continue;
            refs.set(resource.key, {
              kind: "skill",
              sourceId: saved.preview.source.sourceId,
              selection: { packageId: pkg.packageId, entryPath: resource.entryPath },
            });
            if (!assets.some((asset) => asset.kind === "skill" && asset.rootPath === rootPath))
              assets.push({ key: resource.key, kind: "skill", rootPath, packageId: pkg.packageId });
          } else {
            const prefix = relative === "." ? "" : `${relative}/`;
            if (
              relative !== "." &&
              !source.resources.some(
                (entry) => entry.path === relative && entry.kind === "directory",
              )
            )
              throw new SuiteStoreError(
                "Declared file resource root is missing.",
                "resource_missing",
              );
            const resources = source.resources
              .filter((entry) => entry.path.startsWith(prefix) && entry.path !== relative)
              .map((entry) => ({ ...entry, path: entry.path.slice(prefix.length) }));
            const packageId =
              relative === "."
                ? source.packageId
                : `res_${suiteContentDigest({ schemaVersion: 1, resources })}`;
            const resourceId = `resource_${randomUUID()}`;
            refs.set(resource.key, {
              kind: "files",
              sourceId: saved.preview.source.sourceId,
              resourceId,
              purpose: resource.purpose,
            });
            revisions.push({ resourceId, revision: 1, packageId });
            fileRoots.set(resource.key, rootPath);
            if (!assets.some((asset) => asset.kind === "files" && asset.rootPath === rootPath))
              assets.push({ key: resource.key, kind: "files", rootPath, packageId });
          }
        } catch (cause) {
          const code =
            cause !== null && typeof cause === "object" && "code" in cause ? cause.code : undefined;
          if (
            ![
              "resource_missing",
              "invalid_resource",
              "package_corrupt",
              "not_found",
              "ENOENT",
            ].includes(String(code))
          )
            throw cause;
          // The sealed raw source remains authoritative; no placeholder package IDs.
          issues.push(
            issue(
              "resource_missing",
              cause instanceof Error
                ? cause.message.replaceAll(source.rootPath, "<suite-source>")
                : "Declared resource is unavailable.",
              { kind: "resource", id: resource.key, path: relative },
            ),
          );
        }
      }
    }
    const publishedSkills = new Set(
      assets.filter((asset) => asset.kind === "skill").map((asset) => asset.packageId),
    );
    const selectionResources = new Map<string, string>();
    for (const [key, ref] of refs)
      if (ref.kind === "skill")
        selectionResources.set(`${ref.selection.packageId}\0${ref.selection.entryPath}`, key);
    let selectionOwners: Promise<Map<string, SkillScope[]>> | undefined;
    let ownerImports: Promise<ReadonlySet<string>> | undefined;
    const uses: SuiteResourceUse[] = [];
    const addUse = (key: string, audience: SuiteResourceUse["audience"]) => {
      const ref = refs.get(key);
      if (ref) uses.push({ key, ref, audience, purpose: ref.kind === "files" ? ref.purpose : key });
    };
    for (const key of manifest.sharedResourceKeys ?? []) addUse(key, "shared");
    for (const key of manifest.coordinatorResourceKeys ?? []) addUse(key, "coordinator");
    const experts: SuiteImportPlan["experts"][number][] = [];
    for (const member of manifest.experts) {
      if (member.kind === "reference") {
        experts.push({
          key: member.key,
          expertId: member.expertId,
          definition: null,
          bmadRole: null,
          roleSourceRoot: null,
          identityAvailable: !issues.some(
            (item) =>
              item.subject.kind === "expert" &&
              item.subject.id === member.key &&
              item.effect === "deny-action",
          ),
        });
        continue;
      }
      const preset =
        analysis.adapterId === "bmad-61e01f8-v1"
          ? BMAD_ROLE_PRESETS.find((role) => role.id === member.key)
          : undefined;
      const roleSourceRoot = preset
        ? path.dirname(path.dirname(path.join(source.rootPath, member.personaPath)))
        : null;
      let role = analysis.roles[member.key];
      if (role && preset && roleSourceRoot)
        role = await compileBmadRole({ sourceRoot: roleSourceRoot, roleKey: preset.id, expertIds });
      const selections: NonNullable<ExpertSaveInput["skillSelections"]>[number][] = [];
      const references: string[] = [];
      const connections: ExpertConnection[] = [];
      for (const key of member.resourceKeys ?? []) {
        addUse(key, { expertKey: member.key });
        const ref = refs.get(key);
        if (
          ref?.kind !== "connection" &&
          issues.some(
            (entry) =>
              entry.subject.kind === "resource" &&
              entry.subject.id === key &&
              entry.effect !== "observe",
          )
        )
          continue;
        if (ref?.kind === "skill") selections.push(ref.selection);
        else if (ref?.kind === "connection") connections.push(ref.connection);
        else if (ref?.kind === "files") {
          const root = fileRoots.get(key);
          if (root) references.push(root);
          else {
            const revision = await Effect.runPromise(store.readFileRevision(ref.resourceId));
            if (revision) references.push((await files.read(revision.packageId)).rootPath);
          }
        } else if (ref?.kind === "managed-skill") {
          const result = await runtime.skillLibrary.execute({
            action: "read",
            skillId: ref.managedSkillId,
          });
          if (result.skill && !result.skill.deleted) {
            const selection = {
              packageId: result.skill.packageId,
              entryPath: result.skill.entryPath,
            };
            selections.push(selection);
            selectionResources.set(`${selection.packageId}\0${selection.entryPath}`, key);
          }
        }
      }
      if (preset && roleSourceRoot) {
        const pkg = skillRoots.get(roleSourceRoot);
        if (pkg) {
          // Reuse the one fixed discovery projection; never expose role/module entries.
          const allowed = new Set(
            [...refs.values()]
              .filter((ref) => ref.kind === "skill")
              .map((ref) => ref.selection.entryPath),
          );
          selections.splice(
            0,
            selections.length,
            ...bmadPresetSelections(
              { ...pkg, entries: pkg.entries.filter((entry) => allowed.has(entry.entryPath)) },
              preset.id,
              { allowMissing: true },
            ),
          );
        }
        references.push(roleSourceRoot);
      }
      // These raw selections also execute outside a Suite. Never persist an
      // untrusted reference as an apparently pre-authorized Expert selection.
      const admittedSelections: typeof selections = [];
      for (const selection of selections) {
        const key = `${selection.packageId}\0${selection.entryPath}`;
        try {
          selectionOwners ??= readSkillLibrarySnapshot(stateDir).then(({ packageScopes }) => {
            const owners = new Map<string, SkillScope[]>();
            for (const record of packageScopes) {
              const ownerKey = `${record.packageId}\0${record.entryPath}`;
              const scopes = owners.get(ownerKey);
              if (scopes) scopes.push(record.scope);
              else owners.set(ownerKey, [record.scope]);
            }
            return owners;
          });
          const scopes = (await selectionOwners).get(key);
          if (scopes) {
            if (
              !scopes.some(
                (scope) => scope.kind === "shared" || scope.expertId === expertIds[member.key],
              )
            )
              throw new SuiteStoreError(
                "Imported member cannot access this private Skill.",
                "permission_denied",
              );
          } else if (!publishedSkills.has(selection.packageId)) {
            ownerImports ??= readCompletedSkillPackageImports(stateDir);
            if (!(await ownerImports).has(selection.packageId))
              throw new SuiteStoreError(
                "Skill ownership cannot be established for this imported member.",
                "identity_unavailable",
              );
          }
          admittedSelections.push(selection);
        } catch (cause) {
          issues.push(
            issue(
              cause instanceof SuiteStoreError ? cause.code : "resource_corrupt",
              "This Skill could not be admitted to the imported Expert.",
              {
                kind: "resource",
                id: selectionResources.get(key) ?? selection.entryPath,
                path: null,
              },
            ),
          );
        }
      }
      experts.push({
        key: member.key,
        expertId: expertIds[member.key]!,
        bmadRole: preset?.id ?? null,
        roleSourceRoot,
        identityAvailable: !!role,
        definition: {
          id: expertIds[member.key]!,
          name: role?.name ?? member.name,
          description: role?.description ?? member.description,
          persona: role?.persona ?? "",
          useCases: role?.useCases ?? "",
          outputRequirements: role?.outputRequirements ?? "",
          skills: [],
          skillSelections: admittedSelections,
          references: [...new Set(references)],
          connections,
        },
      });
    }
    const createdAt = new Date().toISOString();
    const composition: SuiteComposition = {
      schemaVersion: 1,
      ref: { suiteId: `suite_${randomUUID()}`, revision: 1 },
      name: manifest.name,
      description: manifest.description,
      source: saved.preview.source,
      adapterId: analysis.adapterId,
      adapterVersion: analysis.adapterVersion,
      members: manifest.experts.map((member) => ({
        key: member.key,
        expertId: expertIds[member.key]!,
        roleSourcePath: member.kind === "definition" ? member.personaPath : null,
      })),
      resources: uses,
      defaults: manifest.defaults ?? {},
      createdAt,
      compositionHash: "0".repeat(64),
    };
    return {
      planId: `suite_plan_${randomUUID()}`,
      creatorOperationId: request.operationId,
      sourceKey: suiteImportSourceKey(composition),
      sourceRoot: source.rootPath,
      composition: { ...composition, compositionHash: suiteCompositionFingerprint(composition) },
      experts,
      assets,
      fileResourceRevisions: revisions,
      issues: issues.map((item) =>
        item.subject.kind === "expert" && expertIds[item.subject.id]
          ? { ...item, subject: { ...item.subject, id: expertIds[item.subject.id]! } }
          : item,
      ),
    };
  };
  const resume = (plan: SuiteImportPlan) =>
    Effect.gen(function* () {
      if (yield* store.isPlanCommitted(plan.planId)) return;
      yield* attempt(async () => {
        const source = await readSource(plan.sourceRoot, plan.composition.source.contentHash);
        for (const asset of plan.assets) {
          const relative = path.relative(source.rootPath, asset.rootPath).split(path.sep).join("/");
          if (relative === ".." || relative.startsWith("../") || path.isAbsolute(relative))
            throw new SuiteStoreError("Planned asset escaped its sealed source.", "unsafe_path");
          let published: { readonly packageId: string };
          if (asset.kind === "files") {
            if (asset.packageId === source.packageId && asset.rootPath === source.rootPath)
              published = source;
            else {
              const prefix = relative ? `${relative}/` : "";
              const manifest = source.resources
                .filter((entry) => entry.path.startsWith(prefix) && entry.path !== relative)
                .map((entry) => ({ ...entry, path: entry.path.slice(prefix.length) }));
              published = await files.seal(asset.rootPath, manifest);
            }
          } else published = await runtime.skillPackages.publishDirectory(asset.rootPath);
          if (published.packageId !== asset.packageId)
            throw new SuiteStoreError("Planned asset content changed.", "content_changed");
        }
        const expertIds = Object.fromEntries(
          plan.experts.map((expert) => [expert.key, expert.expertId]),
        );
        for (const expert of plan.experts)
          if (expert.definition) {
            await runtime.experts.stageImport({
              planId: plan.planId,
              definition: {
                ...expert.definition,
                id: expert.expertId,
                revision: 1,
                archived: false,
                updatedAt: plan.composition.createdAt,
              },
              identityAvailable: expert.identityAvailable,
              bmadRole: expert.bmadRole,
              roleSourceRoot: expert.roleSourceRoot,
              expertIds,
            });
            await runtime.experts.verifyImport(expert.expertId, plan.planId);
          }
      });
      yield* store.completeImport(plan.planId);
    }).pipe(
      Effect.catch((cause) =>
        store
          .recordImportIssue(
            plan.planId,
            issue(
              cause.code,
              cause.message,
              { kind: "suite", id: plan.composition.ref.suiteId, path: null },
              "commit",
              "deny-action",
            ),
          )
          .pipe(Effect.andThen(Effect.fail(cause))),
      ),
    );

  return {
    preview: (request: SuitePreviewInput) =>
      Effect.gen(function* () {
        const decoded = yield* checked(() =>
          Schema.decodeUnknownSync(SuitePreviewInputSchema)(request),
        );
        return yield* attempt(() =>
          withSkillPackageLifecycle(stateDir, async () => {
            const { live } = await reapPreviews();
            if (live.length >= MAX_PREVIEWS)
              throw new SuiteStoreError(
                "Too many outstanding Suite previews; cancel one or wait for expiry.",
                "invalid_manifest",
              );
            const captured = await snapshots.capture(decoded.source);
            try {
              const analysis = await analyzeSuiteSource(captured.rootPath, captured.source);
              const issues = [...analysis.issues, ...(await diagnoseReferences(analysis))];
              const preview = Schema.decodeUnknownSync(SuitePreviewSchema)({
                requestId: decoded.requestId,
                previewId: randomUUID(),
                expiresAt: new Date(Date.now() + PREVIEW_TTL_MS).toISOString(),
                source: captured.source,
                contentHash: captured.contentHash,
                adapterId: analysis.adapterId,
                adapterVersion: analysis.adapterVersion,
                name: analysis.manifest.name,
                description: analysis.manifest.description,
                members: analysis.manifest.experts.map((member) => ({
                  key: member.key,
                  name:
                    member.kind === "definition"
                      ? (analysis.roles[member.key]?.name ?? member.name)
                      : member.key,
                  description:
                    member.kind === "definition"
                      ? member.description
                      : "Referenced existing Expert",
                })),
                resourceKeys: (analysis.manifest.resources ?? []).map((resource) => resource.key),
                issues,
              });
              await writePrivateFileAtomically(
                previewPath(preview.previewId),
                canonicalSuiteJson({ preview, rootPath: captured.rootPath }),
              );
              return preview;
            } catch (cause) {
              await releaseSources([captured], live);
              throw cause;
            }
          }),
        );
      }),
    cancelPreview: (previewId: string) =>
      attempt(() =>
        withSkillPackageLifecycle(stateDir, async () => {
          const { cancelled } = await reapPreviews(previewId);
          return { cancelled };
        }),
      ),
    commit: (request: SuiteImportRequest) =>
      Effect.gen(function* () {
        const decoded = yield* checked(() =>
          Schema.decodeUnknownSync(SuiteImportRequestSchema)(request),
        );
        const hash = suiteContentDigest(decoded);
        const existing = yield* store.getImportReceipt(decoded.operationId);
        if (existing) {
          if (existing.requestHash !== hash)
            return yield* Effect.fail(
              new SuiteStoreError(
                "This operation belongs to another request.",
                "revision_conflict",
              ),
            );
          if (existing.state !== "pending") return existing;
          const plan = yield* store.findImport(decoded.operationId);
          if (!plan)
            return yield* Effect.fail(
              new SuiteStoreError("Pending import journal is missing.", "resource_corrupt"),
            );
          yield* resume(plan);
          return (yield* store.getImportReceipt(decoded.operationId))!;
        }
        const result = yield* attempt(() =>
          withSkillPackageLifecycle(stateDir, () =>
            Effect.runPromise(
              Effect.result(
                Effect.gen(function* () {
                  const saved = yield* attempt(() => readPreview(previewPath(decoded.previewId)));
                  if (!saved || Date.parse(saved.preview.expiresAt) <= Date.now())
                    return {
                      plan: null,
                      receipt: yield* store.rejectImport(
                        decoded.operationId,
                        hash,
                        issue(
                          "preview_expired",
                          "Preview expired or was cancelled; capture the source again.",
                          { kind: "suite", id: decoded.previewId, path: null },
                          "commit",
                          "deny-action",
                        ),
                      ),
                    };
                  if (saved.preview.contentHash !== decoded.contentHash)
                    return {
                      plan: null,
                      receipt: yield* store.rejectImport(
                        decoded.operationId,
                        hash,
                        issue(
                          "content_changed",
                          "Request content does not match the immutable preview.",
                          { kind: "suite", id: decoded.previewId, path: null },
                          "commit",
                          "deny-action",
                        ),
                      ),
                    };
                  const proposed = yield* attempt(() => makePlan(decoded, saved)).pipe(
                    Effect.catch((cause) =>
                      store
                        .rejectImport(
                          decoded.operationId,
                          hash,
                          issue(
                            cause.code,
                            cause.message,
                            { kind: "suite", id: decoded.previewId, path: null },
                            "commit",
                            "deny-action",
                          ),
                        )
                        .pipe(Effect.andThen(Effect.fail(cause))),
                    ),
                  );
                  return yield* store.beginImport(decoded, hash, proposed);
                }),
              ),
            ),
          ),
        );
        if (result._tag === "Failure") return yield* Effect.fail(result.failure);
        const admission = result.success;
        if (admission.receipt.state !== "pending") return admission.receipt;
        if (!admission.plan)
          return yield* Effect.fail(
            new SuiteStoreError("Import admission omitted its durable plan.", "resource_corrupt"),
          );
        // A/B races MUST resume the selected winner, not any of the proposed IDs.
        yield* resume(admission.plan);
        return (yield* store.getImportReceipt(decoded.operationId))!;
      }),
    getReceipt: (operationId: string) =>
      Effect.gen(function* () {
        const receipt = yield* store.getImportReceipt(operationId);
        if (receipt?.state !== "pending") return receipt;
        // Existing Web recovery queries the original operation, never a new request.
        const plan = yield* store.findImport(operationId);
        if (!plan)
          return yield* Effect.fail(
            new SuiteStoreError("Pending import journal is missing.", "resource_corrupt"),
          );
        yield* resume(plan);
        return yield* store.getImportReceipt(operationId);
      }),
    list: () => store.list(),
    read: (ref: SuiteRef) =>
      store
        .read(ref)
        .pipe(
          Effect.flatMap((composition) =>
            composition
              ? Effect.succeed(composition)
              : Effect.fail(new SuiteStoreError("Selected Suite is missing.", "suite_missing")),
          ),
        ),
  };
}

export class SuiteImportService extends ServiceMap.Service<
  SuiteImportService,
  SuiteImportServiceShape
>()("synara/suites/SuiteImportService") {}
export const SuiteImportServiceLive = Layer.effect(
  SuiteImportService,
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const store = yield* SuiteCompositionStore;
    const runtime = yield* WorkbenchExpertRuntime;
    const github = yield* GitHubCli;
    const artifacts = yield* ExpertDelegationArtifacts;
    return createSuiteImportService({
      stateDir: config.stateDir,
      store,
      runtime,
      readExternalFileResourcePackages: () => Effect.runPromise(artifacts.referencedPackages),
      sourceOptions: {
        readGitHubSnapshot: (request) =>
          Effect.runPromise(github.readRepositorySnapshot({ ...request, cwd: config.cwd })),
      },
    });
  }),
);
