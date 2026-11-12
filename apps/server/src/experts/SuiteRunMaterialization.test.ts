import * as fs from "node:fs/promises";
import { createHash } from "node:crypto";
import * as path from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Layer, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";
import { ProjectId, SuiteRunAssemblyV2, ThreadId, type SuiteComposition } from "@synara/contracts";
import { ServerConfig } from "../config";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient";
import { runMigrations } from "../persistence/Migrations";
import { runWorkbenchMigrations } from "../workbench/persistence/WorkbenchMigrations";
import {
  makeSuiteCompositionStore,
  suiteCompositionFingerprint,
  suiteImportSourceKey,
  SuiteCompositionStore,
} from "../suites/SuiteCompositionStore";
import { makeSuiteBindingResolver } from "../suites/SuiteBindingResolver";
import { suiteContentDigest } from "../suites/suiteIdentity";
import { createFileResourceStore } from "./FileResourceStore";
import { createSkillLibraryStore, readSkillLibraryDefinitions } from "./SkillLibraryStore";
import { createExpertStore } from "./ExpertStore";
import { createRunSkillAssemblyStore } from "./RunSkillAssemblyStore";
import { suiteAssemblyFingerprint } from "./SuiteRunMaterialization";
import { createSkillPackageStore } from "./SkillPackageStore";
import { renderSuiteRuntimeInstructions } from "../provider/suiteRuntimeInstructions";
import { readonlyResourceTestConfigLayer } from "./expertResourceTestFixtures";

const environment = Layer.mergeAll(
  NodeSqliteClient.layerMemory(),
  readonlyResourceTestConfigLayer("suite-runs-").pipe(Layer.provide(NodeServices.layer)),
);
const fixture = Effect.gen(function* () {
  yield* runMigrations();
  yield* runWorkbenchMigrations();
  const sql = yield* SqlClient.SqlClient,
    config = yield* ServerConfig;
  const skillLibrary = createSkillLibraryStore(config.stateDir);
  yield* Effect.addFinalizer(() => Effect.promise(() => skillLibrary.dispose()));
  const store = yield* makeSuiteCompositionStore;
  const resolver = yield* makeSuiteBindingResolver.pipe(
    Effect.provideService(SuiteCompositionStore, store),
  );
  const directory = path.join(config.stateDir, "instruction-source");
  const projectRoot = path.join(config.stateDir, "project");
  yield* Effect.promise(() => fs.mkdir(projectRoot));
  yield* Effect.promise(() => fs.mkdir(directory));
  yield* Effect.promise(() =>
    fs.writeFile(path.join(directory, "rules.txt"), "Use the fixed shared evidence rules."),
  );
  const sealed = yield* Effect.promise(() =>
    createFileResourceStore(config.stateDir).seal(directory),
  );
  const skill = yield* Effect.promise(
    async () =>
      (
        await skillLibrary.execute({
          action: "create",
          name: "coordinator-method",
          body: "---\nname: coordinator-method\ndescription: Coordinate evidence\n---\nFirst method revision.",
          tags: [],
        })
      ).skill!,
  );
  const expert = yield* Effect.promise(() =>
    createExpertStore(config.stateDir).save({
      name: "Author",
      persona: "Author identity",
      description: "",
      useCases: "",
      outputRequirements: "",
      skills: [],
      references: [],
      connections: [],
    }),
  );
  const base = yield* Effect.promise(() =>
    createExpertStore(config.stateDir).prepareSnapshot(expert.id),
  );
  const composition: SuiteComposition = {
    schemaVersion: 1,
    ref: { suiteId: "suite_a892dfb0-7aaf-44bc-bc65-e7dcf292ee66", revision: 1 },
    name: "Evidence Suite",
    description: "",
    source: {
      kind: "local-folder",
      sourceId: "local-fixture",
      contentHash: sealed.packageId.slice(4),
    },
    adapterId: "synara-suite-v1",
    adapterVersion: 1,
    members: [{ key: "author", expertId: expert.id, roleSourcePath: null }],
    resources: [
      {
        key: "rules",
        purpose: "Evidence",
        audience: "shared",
        ref: {
          kind: "files",
          sourceId: "local-fixture",
          resourceId: "rules-resource",
          purpose: "instructions",
        },
      },
      {
        key: "method",
        purpose: "Coordinate",
        audience: "coordinator",
        ref: { kind: "managed-skill", sourceId: "local-fixture", managedSkillId: skill.skillId },
      },
      {
        key: "broken",
        purpose: "Optional reference",
        audience: "shared",
        ref: {
          kind: "files",
          sourceId: "local-fixture",
          resourceId: "missing-resource",
          purpose: "reference",
        },
      },
    ],
    defaults: { language: "中文", outputDirectory: "artifacts" },
    compositionHash: "0".repeat(64),
    createdAt: "2026-11-10T10:00:00.000Z",
  };
  const verified = { ...composition, compositionHash: suiteCompositionFingerprint(composition) };
  const request = {
    operationId: "import-fixture",
    previewId: "preview-fixture",
    contentHash: verified.source.contentHash,
    mode: "reuse-or-create" as const,
  };
  yield* store.beginImport(request, suiteContentDigest(request), {
    planId: "plan-fixture",
    creatorOperationId: request.operationId,
    sourceKey: suiteImportSourceKey(verified),
    sourceRoot: directory,
    composition: verified,
    experts: [
      {
        key: "author",
        expertId: expert.id,
        definition: null,
        bmadRole: null,
        roleSourceRoot: null,
        identityAvailable: true,
      },
    ],
    assets: [
      { key: "rules", kind: "files", rootPath: sealed.rootPath, packageId: sealed.packageId },
    ],
    fileResourceRevisions: [
      { resourceId: "rules-resource", revision: 1, packageId: sealed.packageId },
    ],
    issues: [],
  });
  yield* store.completeImport("plan-fixture");
  return {
    store,
    resolver,
    config,
    projectRoot,
    composition: verified,
    expert,
    base,
    skill,
    sealed,
    sql,
    skillLibrary,
  };
});

describe("Suite Run materialization", () => {
  it("projects coordinator shared resources/config without an Expert and pins managed heads through recovery", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const f = yield* fixture;
        const binding = yield* f.resolver.prepare({
          suite: f.composition.ref,
          purpose: { kind: "hub-coordinator", hubId: "hub-fixture", hubConfigRevision: 1 },
          projectId: ProjectId.makeUnsafe("project-fixture"),
        });
        const assemblies = createRunSkillAssemblyStore(f.config.stateDir, { suiteStore: f.store });
        const input = {
          threadId: ThreadId.makeUnsafe("coordinator-thread"),
          rootRunId: "coordinator-root",
          baseSnapshotId: null,
          capabilityBindingId: binding.bindingId,
          projectRoot: f.projectRoot,
          createdAt: f.composition.createdAt,
        };
        const first = yield* Effect.promise(() => assemblies.prepare(input));
        expect(first.schemaVersion).toBe(2);
        expect(first).not.toHaveProperty("session");
        expect(yield* Effect.promise(() => assemblies.sessionFor(first))).toBeUndefined();
        const context = yield* Effect.promise(() => assemblies.runtimeContext(first));
        expect(context?.contextFiles[0]?.content).toContain("fixed shared evidence");
        expect(context?.resourceRoots[0]?.path).toBe(f.sealed.rootPath);
        expect(context?.effectiveConfig.language).toBe("中文");
        expect(context?.effectiveConfig.outputDirectory).toBe("artifacts");
        expect(context?.effectiveConfig.issues).toContainEqual(
          expect.objectContaining({
            subject: { kind: "resource", id: "broken", path: null },
            effect: "limit-capability",
          }),
        );
        const updated = yield* Effect.promise(
          async () =>
            (
              await f.skillLibrary.execute({
                action: "save",
                skillId: f.skill.skillId,
                expectedRevision: f.skill.revision,
                name: f.skill.name,
                tags: [],
                changes: [
                  {
                    path: "SKILL.md",
                    content: Buffer.from(
                      "---\nname: coordinator-method\ndescription: Coordinate evidence\n---\nSecond method revision.",
                    ).toString("base64"),
                  },
                ],
              })
            ).skill!,
        );
        const reopened = createRunSkillAssemblyStore(f.config.stateDir, { suiteStore: f.store });
        expect(
          (yield* Effect.promise(() => reopened.prepare(input))).skillEntries[0]?.packageId,
        ).toBe(f.skill.packageId);
        const next = yield* Effect.promise(() =>
          reopened.prepare({ ...input, rootRunId: "new-logical-root" }),
        );
        expect(next.skillEntries[0]?.packageId).toBe(updated.packageId);
        expect(next.assemblyId).not.toBe(first.assemblyId);
        expect(() =>
          Schema.decodeUnknownSync(SuiteRunAssemblyV2)({ ...first, session: {} }),
        ).toThrow();
        expect(
          suiteAssemblyFingerprint({
            ...first,
            effectiveConfig: {
              ...first.effectiveConfig,
              provenance: [
                ...first.effectiveConfig.provenance,
                { field: "language", layer: "invocation", sourceId: "request", value: "English" },
              ],
            },
          }),
        ).not.toBe(first.assemblyId);
        yield* f.sql`UPDATE suite_resource_revisions SET package_id = ${"res_" + "f".repeat(64)} WHERE resource_id = 'rules-resource'`;
        const broken = yield* Effect.promise(() =>
          reopened.runtimeContext(first).then(
            () => false,
            () => true,
          ),
        );
        expect(broken).toBe(true);
      }).pipe(Effect.provide(environment), Effect.scoped),
    );
  });
  it("keeps independent delegate scope and refuses uncertain initialization replay", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const f = yield* fixture;
        yield* Effect.promise(() =>
          createExpertStore(f.config.stateDir).save({
            ...f.expert,
            expectedRevision: f.expert.revision,
            skillBindings: [
              { skillId: f.skill.skillId, enabled: true, resourceMode: "run-private" },
            ],
          }),
        );
        const binding = yield* f.resolver.prepare({
          suite: f.composition.ref,
          purpose: {
            kind: "native-delegate",
            parentThreadId: ThreadId.makeUnsafe("parent"),
            parentRootRunId: "parent-root",
            delegationId: "delegation",
            attemptId: "attempt",
            expertSnapshotId: f.base.snapshotId,
          },
          projectId: ProjectId.makeUnsafe("project-fixture"),
        });
        expect(binding.purpose.kind).toBe("native-delegate");
        const assemblies = createRunSkillAssemblyStore(f.config.stateDir, { suiteStore: f.store });
        const record = yield* Effect.promise(() =>
          assemblies.prepare({
            threadId: ThreadId.makeUnsafe("delegate"),
            rootRunId: "delegate-root",
            baseSnapshotId: f.base.snapshotId,
            capabilityBindingId: binding.bindingId,
            continuationKey: "delegate-work",
            createdAt: f.composition.createdAt,
          }),
        );
        const session = yield* Effect.promise(() => assemblies.sessionFor(record));
        expect(session?.expertId).toBe(f.expert.id);
        expect(record.resources.some((resource) => resource.key === "method")).toBe(false);
        const privateRoot = session!.skillResourceRefs![0]!.rootPath;
        yield* Effect.promise(() =>
          fs.writeFile(path.join(privateRoot, "generated.txt"), "Preserve this real output."),
        );
        const continued = yield* Effect.promise(() =>
          assemblies.prepare({
            threadId: ThreadId.makeUnsafe("delegate"),
            rootRunId: "continued-delegate-root",
            baseSnapshotId: f.base.snapshotId,
            capabilityBindingId: binding.bindingId,
            continuationKey: "delegate-work",
            inheritContinuation: true,
            createdAt: f.composition.createdAt,
          }),
        );
        const continuedContext = yield* Effect.promise(() => assemblies.runtimeContext(continued));
        expect(
          continued.resources.find((resource) => resource.packageId === f.skill.packageId)
            ?.ownerRootRunId,
        ).toBe(record.rootRunId);
        expect(continuedContext?.skillEntries[0]?.path).toBe(path.join(privateRoot, "SKILL.md"));
        expect(
          yield* Effect.promise(() => fs.readFile(path.join(privateRoot, "generated.txt"), "utf8")),
        ).toBe("Preserve this real output.");
        const file = path.join(
          f.config.stateDir,
          "experts",
          "run-skill-assemblies",
          createHash("sha256").update(record.rootRunId).digest("hex") + ".json",
        );
        yield* Effect.promise(() =>
          fs.writeFile(
            file,
            JSON.stringify({
              ...record,
              phase: "initializing",
              hasInitializationEffects: true,
              initializationAttempt: "uncertain-attempt",
            }),
          ),
        );
        const rejected = yield* Effect.promise(() =>
          assemblies.beginInitialization(record.rootRunId).then(
            () => false,
            () => true,
          ),
        );
        expect(rejected).toBe(true);
        const still = yield* Effect.promise(() => assemblies.read(record.rootRunId));
        expect(still?.initializationAttempt).toBe("uncertain-attempt");
      }).pipe(Effect.provide(environment), Effect.scoped),
    );
  });
  it("preserves a pinned Suite Expert after its template is archived", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const f = yield* fixture;
        const binding = yield* f.resolver.prepare({
          suite: f.composition.ref,
          purpose: { kind: "direct-expert", expertSnapshotId: f.base.snapshotId },
          projectId: ProjectId.makeUnsafe("project-fixture"),
        });
        yield* Effect.promise(() =>
          createExpertStore(f.config.stateDir).archive(f.expert.id, f.expert.revision),
        );
        const assemblies = createRunSkillAssemblyStore(f.config.stateDir, { suiteStore: f.store });
        const record = yield* Effect.promise(() =>
          assemblies.prepare({
            threadId: ThreadId.makeUnsafe("bound-before-archive"),
            rootRunId: "after-archive-run",
            baseSnapshotId: f.base.snapshotId,
            capabilityBindingId: binding.bindingId,
            projectRoot: f.projectRoot,
            createdAt: f.composition.createdAt,
          }),
        );
        const session = yield* Effect.promise(() => assemblies.sessionFor(record));
        expect(session?.snapshotId).toBe(f.base.snapshotId);
        expect(session?.persona).toContain("Author identity");
        expect(
          (yield* Effect.promise(() => createExpertStore(f.config.stateDir).list())).some(
            (item) => item.id === f.expert.id && !item.archived,
          ),
        ).toBe(false);
        expect(
          (yield* Effect.promise(() => assemblies.runtimeContext(record)))?.contextFiles[0]
            ?.content,
        ).toContain("fixed shared evidence");
      }).pipe(Effect.provide(environment), Effect.scoped),
    );
  });
  it("captures project/team/personal configuration once and preserves its runtime projection through continuation", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const f = yield* fixture;
        const bmad = path.join(f.projectRoot, "_bmad"),
          custom = path.join(bmad, "custom");
        yield* Effect.promise(() => fs.mkdir(custom, { recursive: true }));
        yield* Effect.promise(() =>
          fs.writeFile(
            path.join(bmad, "config.toml"),
            '[core]\ncommunication_language = "English"\noutput_folder = "{project-root}/base-output"\n',
          ),
        );
        yield* Effect.promise(() =>
          fs.writeFile(
            path.join(custom, "config.toml"),
            '[core]\ncommunication_language = "French"\noutput_folder = "team-output"\ndocument_output_language = "UNSUPPORTED_LANGUAGE_SENTINEL"\n',
          ),
        );
        yield* Effect.promise(() =>
          fs.writeFile(
            path.join(custom, "config.user.toml"),
            '[core]\noutput_folder = "{project-root}/personal-output"\n[provider]\napi_key = "CONFIG_SECRET_NOT_EXPORTED"\n',
          ),
        );
        const binding = yield* f.resolver.prepare({
          suite: f.composition.ref,
          purpose: { kind: "hub-coordinator", hubId: "config-hub", hubConfigRevision: 1 },
          projectId: ProjectId.makeUnsafe("project-fixture"),
        });
        const assemblies = createRunSkillAssemblyStore(f.config.stateDir, { suiteStore: f.store });
        const input = {
          threadId: ThreadId.makeUnsafe("fixed-config-thread"),
          rootRunId: "fixed-config-root",
          baseSnapshotId: null,
          capabilityBindingId: binding.bindingId,
          projectRoot: f.projectRoot,
          continuationKey: "fixed-config-work",
          createdAt: f.composition.createdAt,
        };
        const first = yield* Effect.promise(() => assemblies.prepare(input));
        expect(first.effectiveConfig.language).toBe("French");
        expect(first.effectiveConfig.outputDirectory).toBe("personal-output");
        expect(
          first.effectiveConfig.provenance.filter((item) => item.field === "language"),
        ).toEqual([
          { field: "language", layer: "suite", sourceId: f.composition.ref.suiteId, value: "中文" },
          { field: "language", layer: "project", sourceId: "_bmad/config.toml", value: "English" },
          {
            field: "language",
            layer: "project",
            sourceId: "_bmad/custom/config.toml",
            value: "French",
          },
        ]);
        expect(
          first.effectiveConfig.provenance
            .filter((item) => item.field === "outputDirectory")
            .map(({ layer, sourceId, value }) => ({ layer, sourceId, value })),
        ).toEqual([
          { layer: "suite", sourceId: f.composition.ref.suiteId, value: "artifacts" },
          { layer: "project", sourceId: "_bmad/config.toml", value: "base-output" },
          { layer: "project", sourceId: "_bmad/custom/config.toml", value: "team-output" },
          {
            layer: "personal",
            sourceId: "_bmad/custom/config.user.toml",
            value: "personal-output",
          },
        ]);
        expect(JSON.stringify(first.effectiveConfig)).not.toContain(f.projectRoot);
        expect(JSON.stringify(first.effectiveConfig)).not.toContain("CONFIG_SECRET_NOT_EXPORTED");
        expect(JSON.stringify(first.effectiveConfig)).not.toContain(
          "UNSUPPORTED_LANGUAGE_SENTINEL",
        );
        yield* Effect.promise(() =>
          fs.writeFile(
            path.join(custom, "config.user.toml"),
            '[core]\ncommunication_language = "Japanese"\noutput_folder = "{project-root}/new-personal-output"\n',
          ),
        );
        const reopened = createRunSkillAssemblyStore(f.config.stateDir, { suiteStore: f.store });
        const recovered = yield* Effect.promise(() => reopened.prepare(input));
        expect(recovered.effectiveConfig).toEqual(first.effectiveConfig);
        const context = yield* Effect.promise(() => reopened.runtimeContext(recovered));
        expect(renderSuiteRuntimeInstructions(context!)).toContain("French");
        expect(renderSuiteRuntimeInstructions(context!)).not.toContain("Japanese");
        const continued = yield* Effect.promise(() =>
          reopened.prepare({
            ...input,
            rootRunId: "continued-config-root",
            inheritContinuation: true,
          }),
        );
        expect(continued.effectiveConfig).toEqual(first.effectiveConfig);
        const next = yield* Effect.promise(() =>
          reopened.prepare({ ...input, rootRunId: "new-config-root" }),
        );
        expect(next.effectiveConfig.language).toBe("Japanese");
        expect(next.effectiveConfig.outputDirectory).toBe("new-personal-output");
        expect(next.effectiveConfig.provenance.at(-2)).toEqual({
          field: "language",
          layer: "personal",
          sourceId: "_bmad/custom/config.user.toml",
          value: "Japanese",
        });
      }).pipe(Effect.provide(environment), Effect.scoped),
    );
  });

  it("limits malformed or escaping configuration without leaking rejected values or disabling resources", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const f = yield* fixture;
        const bmad = path.join(f.projectRoot, "_bmad"),
          custom = path.join(bmad, "custom");
        yield* Effect.promise(() => fs.mkdir(custom, { recursive: true }));
        yield* Effect.promise(() =>
          fs.writeFile(
            path.join(bmad, "config.toml"),
            '[core]\ncommunication_language = "English"\noutput_folder = "safe-output"\n',
          ),
        );
        yield* Effect.promise(() =>
          fs.writeFile(
            path.join(custom, "config.toml"),
            '[core]\ncommunication_language = 17\noutput_folder = "team-safe-output"\n',
          ),
        );
        yield* Effect.promise(() =>
          fs.writeFile(
            path.join(custom, "config.user.toml"),
            '[core]\noutput_folder = "../ESCAPING_CONFIG_SECRET_SENTINEL"\n',
          ),
        );
        const binding = yield* f.resolver.prepare({
          suite: f.composition.ref,
          purpose: { kind: "hub-coordinator", hubId: "unsafe-config-hub", hubConfigRevision: 1 },
          projectId: ProjectId.makeUnsafe("project-fixture"),
        });
        const assemblies = createRunSkillAssemblyStore(f.config.stateDir, { suiteStore: f.store });
        const input = {
          threadId: ThreadId.makeUnsafe("unsafe-config-thread"),
          rootRunId: "unsafe-config-root",
          baseSnapshotId: null,
          capabilityBindingId: binding.bindingId,
          projectRoot: f.projectRoot,
          createdAt: f.composition.createdAt,
        };
        const record = yield* Effect.promise(() => assemblies.prepare(input));
        expect(record.effectiveConfig.language).toBeNull();
        expect(record.effectiveConfig.outputDirectory).toBeNull();
        expect(record.effectiveConfig.issues).toContainEqual(
          expect.objectContaining({
            code: "resource_corrupt",
            subject: {
              kind: "resource",
              id: "_bmad/custom/config.toml",
              path: "_bmad/custom/config.toml",
            },
            effect: "limit-capability",
          }),
        );
        expect(record.effectiveConfig.issues).toContainEqual(
          expect.objectContaining({
            code: "unsafe_path",
            subject: {
              kind: "resource",
              id: "_bmad/custom/config.user.toml",
              path: "_bmad/custom/config.user.toml",
            },
            action: "tool-call",
            effect: "deny-action",
          }),
        );
        const context = yield* Effect.promise(() => assemblies.runtimeContext(record));
        expect(context?.contextFiles[0]?.content).toContain("fixed shared evidence");
        expect(JSON.stringify(context)).not.toContain("ESCAPING_CONFIG_SECRET_SENTINEL");
        yield* Effect.promise(() =>
          fs.writeFile(
            path.join(custom, "config.user.toml"),
            '[core]\ncommunication_language = "MALFORMED_CONFIG_SECRET_SENTINEL\n',
          ),
        );
        const malformed = yield* Effect.promise(() =>
          assemblies.prepare({ ...input, rootRunId: "malformed-config-root" }),
        );
        expect(malformed.effectiveConfig.language).toBeNull();
        expect(malformed.effectiveConfig.outputDirectory).toBeNull();
        expect(JSON.stringify(malformed.effectiveConfig)).not.toContain(
          "MALFORMED_CONFIG_SECRET_SENTINEL",
        );
        const outside = path.join(f.config.stateDir, "outside-project");
        yield* Effect.promise(() => fs.mkdir(outside));
        yield* Effect.promise(() =>
          fs.symlink(
            outside,
            path.join(f.projectRoot, "linked-output"),
            process.platform === "win32" ? "junction" : "dir",
          ),
        );
        yield* Effect.promise(() =>
          fs.writeFile(
            path.join(custom, "config.user.toml"),
            '[core]\ncommunication_language = "German"\noutput_folder = "{project-root}/linked-output/SYMLINK_ESCAPE_SECRET_SENTINEL"\n',
          ),
        );
        const linked = yield* Effect.promise(() =>
          assemblies.prepare({ ...input, rootRunId: "linked-config-root" }),
        );
        expect(linked.effectiveConfig.language).toBe("German");
        expect(linked.effectiveConfig.outputDirectory).toBeNull();
        expect(JSON.stringify(linked.effectiveConfig)).not.toContain(
          "SYMLINK_ESCAPE_SECRET_SENTINEL",
        );
      }).pipe(Effect.provide(environment), Effect.scoped),
    );
  });
  it("enforces immutable private Skill ownership independently of imported provenance and mutable heads", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const f = yield* fixture;
        const experts = createExpertStore(f.config.stateDir);
        const other = yield* Effect.promise(() =>
          experts.save({
            name: "Other author",
            persona: "Separate owner",
            description: "",
            useCases: "",
            outputRequirements: "",
            skills: [],
            references: [],
            connections: [],
          }),
        );
        const otherBase = yield* Effect.promise(() => experts.prepareSnapshot(other.id));
        const privateSkill = yield* Effect.promise(
          async () =>
            (
              await f.skillLibrary.execute(
                {
                  action: "create",
                  requestId: "private-origin-proof",
                  name: "owner-only-method",
                  body: "---\nname: owner-only-method\ndescription: Private method\n---\nOWNER_PRIVATE_METHOD",
                  tags: [],
                },
                { createForExpertId: f.expert.id },
              )
            ).skill!,
        );
        const rawRoot = path.join(f.config.stateDir, "unregistered-method");
        yield* Effect.promise(async () => {
          await fs.mkdir(rawRoot);
          await fs.writeFile(
            path.join(rawRoot, "SKILL.md"),
            "---\nname: public-package-method\ndescription: Immutable external method\n---\nPUBLIC_PACKAGE_METHOD",
          );
        });
        const external = yield* Effect.promise(async () => {
          const packages = createSkillPackageStore(f.config.stateDir);
          const preview = await packages.preview({ path: rawRoot });
          return (
            await packages.import({
              previewId: preview.previewId,
              idempotencyKey: "external-immutable-package",
            })
          ).package;
        });
        const unidentified = yield* Effect.promise(async () => {
          const root = path.join(f.config.stateDir, "unidentified-managed-package");
          await fs.mkdir(root);
          await fs.writeFile(
            path.join(root, "SKILL.md"),
            "---\nname: unidentified-legacy-method\ndescription: Unknown ownership\n---\nUNKNOWN_LEGACY_METHOD",
          );
          return createSkillPackageStore(f.config.stateDir).publishDirectory(root);
        });
        const composed = {
          ...f.composition,
          ref: { suiteId: "suite_77d1ae1d-b472-43f7-aa23-8547db6f9d20", revision: 1 },
          source: { ...f.composition.source, contentHash: suiteContentDigest(privateSkill) },
          members: [
            ...f.composition.members,
            { key: "other", expertId: other.id, roleSourcePath: null },
          ],
          resources: [
            f.composition.resources[0]!,
            {
              key: "borrowed-private",
              purpose: "Untrusted imported reference",
              audience: "shared",
              ref: {
                kind: "skill",
                sourceId: "untrusted-source-id",
                selection: { packageId: privateSkill.packageId, entryPath: privateSkill.entryPath },
              },
            },
            {
              key: "external",
              purpose: "Legitimate unregistered immutable package",
              audience: "shared",
              ref: {
                kind: "skill",
                sourceId: "untrusted-source-id",
                selection: {
                  packageId: external.packageId,
                  entryPath: external.entries[0]!.entryPath,
                },
              },
            },
            {
              key: "unidentified",
              purpose: "Unverifiable legacy ownership",
              audience: "shared",
              ref: {
                kind: "skill",
                sourceId: "untrusted-source-id",
                selection: {
                  packageId: unidentified.packageId,
                  entryPath: unidentified.entries[0]!.entryPath,
                },
              },
            },
          ],
        } satisfies SuiteComposition;
        const composition = { ...composed, compositionHash: suiteCompositionFingerprint(composed) };
        const request = {
          operationId: "import-private-reference",
          previewId: "preview-private-reference",
          contentHash: composition.source.contentHash,
          mode: "independent-new-content" as const,
        };
        yield* f.store.beginImport(request, suiteContentDigest(request), {
          planId: "private-reference-plan",
          creatorOperationId: request.operationId,
          sourceKey: suiteImportSourceKey(composition),
          sourceRoot: rawRoot,
          composition,
          experts: composition.members.map((member) => ({
            key: member.key,
            expertId: member.expertId,
            definition: null,
            bmadRole: null,
            roleSourceRoot: null,
            identityAvailable: true,
          })),
          assets: [],
          fileResourceRevisions: [],
          issues: [],
        });
        yield* f.store.completeImport("private-reference-plan");
        const assemblies = createRunSkillAssemblyStore(f.config.stateDir, { suiteStore: f.store });
        const coordinator = yield* f.resolver.prepare({
          suite: composition.ref,
          purpose: {
            kind: "hub-coordinator",
            hubId: "private-reference-hub",
            hubConfigRevision: 1,
          },
          projectId: ProjectId.makeUnsafe("project-fixture"),
        });
        const prepare = (rootRunId: string, bindingId: string, baseSnapshotId: string | null) =>
          assemblies.prepare({
            threadId: ThreadId.makeUnsafe(rootRunId),
            rootRunId,
            capabilityBindingId: bindingId,
            baseSnapshotId,
            projectRoot: f.projectRoot,
            createdAt: composition.createdAt,
          });
        const coordinatorRecord = yield* Effect.promise(() =>
          prepare("private-reference-coordinator", coordinator.bindingId, null),
        );
        expect(
          coordinatorRecord.skillEntries.some(
            (entry) => entry.packageId === privateSkill.packageId,
          ),
        ).toBe(false);
        expect(
          coordinatorRecord.skillEntries.some((entry) => entry.packageId === external.packageId),
        ).toBe(true);
        expect(
          coordinatorRecord.skillEntries.some(
            (entry) => entry.packageId === unidentified.packageId,
          ),
        ).toBe(false);
        expect(coordinatorRecord.effectiveConfig.issues).toContainEqual(
          expect.objectContaining({
            code: "identity_unavailable",
            subject: { kind: "resource", id: "unidentified", path: null },
          }),
        );
        const context = yield* Effect.promise(() => assemblies.runtimeContext(coordinatorRecord));
        expect(context?.contextFiles[0]?.content).toContain("fixed shared evidence");
        expect(coordinatorRecord.effectiveConfig.issues).toContainEqual(
          expect.objectContaining({
            subject: { kind: "resource", id: "borrowed-private", path: null },
          }),
        );
        for (const [base, allowed] of [
          [otherBase, false],
          [f.base, true],
        ] as const) {
          const binding = yield* f.resolver.prepare({
            suite: composition.ref,
            purpose: { kind: "direct-expert", expertSnapshotId: base.snapshotId },
            projectId: ProjectId.makeUnsafe("project-fixture"),
          });
          const record = yield* Effect.promise(() =>
            prepare(`private-reference-${base.expertId}`, binding.bindingId, base.snapshotId),
          );
          expect(
            record.skillEntries.some((entry) => entry.packageId === privateSkill.packageId),
          ).toBe(allowed);
        }
        yield* Effect.promise(() =>
          f.skillLibrary.execute({
            action: "save",
            skillId: privateSkill.skillId,
            expectedRevision: privateSkill.revision,
            name: privateSkill.name,
            tags: [],
            changes: [
              {
                path: privateSkill.entryPath,
                content: Buffer.from(
                  "---\nname: owner-only-method\ndescription: Updated private method\n---\nNEW_OWNER_PRIVATE_METHOD",
                ).toString("base64"),
              },
            ],
          }),
        );
        const afterAdvance = yield* Effect.promise(() =>
          prepare("private-reference-after-head-advance", coordinator.bindingId, null),
        );
        expect(
          afterAdvance.skillEntries.some((entry) => entry.packageId === privateSkill.packageId),
        ).toBe(false);
        // Valid pre-ledger state: only the current head survives in the registry.
        yield* Effect.promise(async () => {
          const skills = await readSkillLibraryDefinitions(f.config.stateDir);
          await fs.writeFile(
            path.join(f.config.stateDir, "experts", "skill-library.json"),
            JSON.stringify({ schemaVersion: 1, skills }),
          );
        });
        const legacy = yield* Effect.promise(() =>
          prepare("private-reference-legacy-head", coordinator.bindingId, null),
        );
        expect(
          legacy.skillEntries.some((entry) => entry.packageId === privateSkill.packageId),
        ).toBe(false);
      }).pipe(Effect.provide(environment), Effect.scoped),
    );
  });
});
