import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  WS_METHODS,
  WsRpcError,
  ProjectId,
  ThreadId,
  type SuiteImportRequest,
  type SuiteManifestV1,
} from "@synara/contracts";
import { ServerConfig } from "../config";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient";
import { runMigrations } from "../persistence/Migrations";
import { runWorkbenchMigrations } from "../workbench/persistence/WorkbenchMigrations";
import { createExpertStore, expertResourceFiles } from "../experts/ExpertStore";
import { createExpertConnectionStore } from "../experts/ExpertConnectionStore";
import { createSkillPackageStore } from "../experts/SkillPackageStore";
import { createSkillLibraryStore } from "../experts/SkillLibraryStore";
import { createFileResourceStore } from "../experts/FileResourceStore";
import { makeSuiteCompositionStore, SuiteCompositionStore } from "./SuiteCompositionStore";
import { makeSuiteBindingResolver } from "./SuiteBindingResolver";
import { createRunSkillAssemblyStore } from "../experts/RunSkillAssemblyStore";
import { installExpertImportPublicationReader } from "./SuitePublicationHost";
import { createSuiteImportService } from "./SuiteImportService";
import { makeWorkbenchSuiteRpcHandlers } from "../workbench/host/suiteRpc";
import { readonlyResourceTestConfigLayer } from "../experts/expertResourceTestFixtures";

const environment = Layer.mergeAll(
  NodeSqliteClient.layerMemory(),
  readonlyResourceTestConfigLayer("suite-import-").pipe(Layer.provide(NodeServices.layer)),
);
const fixture = Effect.gen(function* () {
  yield* runMigrations();
  yield* runWorkbenchMigrations();
  const config = yield* ServerConfig;
  const sql = yield* SqlClient.SqlClient;
  const store = yield* makeSuiteCompositionStore;
  const stop = yield* Effect.tryPromise(() =>
    installExpertImportPublicationReader(
      config.stateDir,
      (id) => Effect.runPromise(store.isPlanCommitted(id)),
      (id) => Effect.runPromise(store.scanSkillReferences(id)),
    ),
  );
  yield* Effect.addFinalizer(() => Effect.sync(stop));
  const runtime = {
    experts: createExpertStore(config.stateDir),
    connections: createExpertConnectionStore(config.stateDir),
    skillPackages: createSkillPackageStore(config.stateDir),
    skillLibrary: createSkillLibraryStore(config.stateDir),
  };
  yield* Effect.addFinalizer(() => Effect.promise(() => runtime.skillLibrary.dispose()));
  const existingExperts = yield* Effect.promise(() => runtime.experts.list());
  const existingConnections = yield* Effect.promise(() => runtime.connections.list());
  const source = path.join(config.stateDir, "source-fixture");
  const manifest: SuiteManifestV1 = {
    schemaVersion: 1,
    name: "Specification Suite",
    description: "Actual files, no Skill",
    experts: [
      {
        key: "author",
        kind: "definition",
        name: "Author",
        description: "Write",
        personaPath: "author.md",
      },
    ],
    resources: [{ key: "rules", kind: "files", root: "rules", purpose: "instructions" }],
    sharedResourceKeys: ["rules"],
  };
  const write = async () => {
    await fs.mkdir(path.join(source, "rules"), { recursive: true });
    await fs.writeFile(path.join(source, "author.md"), "Fixed author identity");
    await fs.writeFile(path.join(source, "rules", "spec.txt"), "Read the actual specification.");
    await fs.writeFile(path.join(source, "synara-suite.json"), JSON.stringify(manifest));
  };
  yield* Effect.promise(write);
  const readExternalFileResourcePackages = () =>
    Effect.runPromise(
      sql<{
        readonly packageId: string;
      }>`SELECT package_id AS "packageId" FROM expert_delegation_artifact_versions`.pipe(
        Effect.map((rows) => new Set(rows.map((row) => row.packageId))),
      ),
    );
  const service = createSuiteImportService({
    stateDir: config.stateDir,
    store,
    runtime,
    readExternalFileResourcePackages,
  });
  const preview = (requestId = "request") =>
    service.preview({ requestId, source: { kind: "local-folder", path: source } });
  return {
    config,
    sql,
    store,
    runtime,
    readExternalFileResourcePackages,
    existingExperts,
    existingConnections,
    source,
    manifest,
    write,
    service,
    preview,
  };
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const managedReferenceManifest = (manifest: SuiteManifestV1, skillId: string): SuiteManifestV1 => ({
  ...manifest,
  experts: manifest.experts.map((member) =>
    member.kind === "definition"
      ? { ...member, resourceKeys: [...(member.resourceKeys ?? []), "managed-method"] }
      : member,
  ),
  resources: [
    ...(manifest.resources ?? []),
    {
      key: "managed-method",
      kind: "resource-reference",
      resourceRef: {
        kind: "managed-skill",
        sourceId: "existing-managed-library",
        managedSkillId: skillId,
      },
    },
  ],
});

describe("durable Suite import with real owners and SQL", () => {
  it.each(["unregistered", "legacy-receipt", "owner-import"] as const)(
    "does not launder %s ownership through a newly imported member snapshot",
    async (origin) => {
      await Effect.runPromise(
        Effect.gen(function* () {
          const f = yield* fixture;
          const methodRoot = path.join(f.config.stateDir, "existing-method");
          yield* Effect.promise(async () => {
            await fs.mkdir(methodRoot);
            await fs.writeFile(
              path.join(methodRoot, "SKILL.md"),
              "---\nname: existing-method\ndescription: Existing package\n---\nUse only with trusted admission.",
            );
          });
          const pkg = yield* Effect.promise(async () => {
            if (origin === "unregistered")
              return f.runtime.skillPackages.publishDirectory(methodRoot);
            const preview = await f.runtime.skillPackages.preview({ path: methodRoot });
            const result = await f.runtime.skillPackages.import({ previewId: preview.previewId });
            if (origin === "legacy-receipt") {
              const directory = path.join(f.config.stateDir, "experts", "skill-imports");
              const receiptPath = path.join(directory, (await fs.readdir(directory))[0]!);
              const receipt = JSON.parse(await fs.readFile(receiptPath, "utf8"));
              delete receipt.origin;
              await fs.writeFile(receiptPath, JSON.stringify(receipt));
            }
            return result.package;
          });
          const manifest: SuiteManifestV1 = {
            ...f.manifest,
            experts: f.manifest.experts.map((member) =>
              member.kind === "definition"
                ? { ...member, resourceKeys: ["existing-method"] }
                : member,
            ),
            resources: [
              ...(f.manifest.resources ?? []),
              {
                key: "existing-method",
                kind: "resource-reference",
                resourceRef: {
                  kind: "skill",
                  sourceId: "not-authorization",
                  selection: { packageId: pkg.packageId, entryPath: pkg.entries[0]!.entryPath },
                },
              },
            ],
          };
          yield* Effect.promise(() =>
            fs.writeFile(path.join(f.source, "synara-suite.json"), JSON.stringify(manifest)),
          );
          const preview = yield* f.preview(origin);
          const receipt = yield* f.service.commit({
            operationId: origin,
            previewId: preview.previewId,
            contentHash: preview.contentHash,
            mode: "reuse-or-create",
          });
          if (receipt.state !== "committed") throw new Error("Expected import publication");
          const suite = yield* f.service.read(receipt.suite);
          const snapshot = yield* Effect.promise(() =>
            f.runtime.experts.prepareSnapshot(suite.members[0]!.expertId),
          );
          const resolver = yield* makeSuiteBindingResolver.pipe(
            Effect.provideService(SuiteCompositionStore, f.store),
          );
          const binding = yield* resolver.prepare({
            suite: suite.ref,
            projectId: ProjectId.makeUnsafe("import-admission-project"),
            purpose: {
              kind: "native-delegate",
              parentThreadId: ThreadId.makeUnsafe("parent"),
              parentRootRunId: "parent-root",
              delegationId: `delegation-${origin}`,
              attemptId: `attempt-${origin}`,
              expertSnapshotId: snapshot.snapshotId,
            },
          });
          const assemblies = createRunSkillAssemblyStore(f.config.stateDir, {
            suiteStore: f.store,
          });
          const ordinary = yield* Effect.promise(() =>
            assemblies.prepare({
              threadId: ThreadId.makeUnsafe(`ordinary-${origin}`),
              rootRunId: `ordinary-root-${origin}`,
              baseSnapshotId: snapshot.snapshotId,
              createdAt: suite.createdAt,
            }),
          );
          expect(
            ordinary.session.skillEntries?.some((entry) => entry.packageId === pkg.packageId) ??
              false,
          ).toBe(origin === "owner-import");
          const assembly = yield* Effect.promise(() =>
            assemblies.prepare({
              threadId: ThreadId.makeUnsafe(`delegate-${origin}`),
              rootRunId: `root-${origin}`,
              baseSnapshotId: snapshot.snapshotId,
              capabilityBindingId: binding.bindingId,
              createdAt: suite.createdAt,
            }),
          );
          expect(assembly.skillEntries.some((entry) => entry.packageId === pkg.packageId)).toBe(
            origin === "owner-import",
          );
          const issue = expect.objectContaining({
            code: "identity_unavailable",
            subject: { kind: "resource", id: "existing-method", path: null },
            effect: "limit-capability",
          });
          if (origin === "owner-import")
            expect(assembly.effectiveConfig.issues).not.toContainEqual(issue);
          else expect(assembly.effectiveConfig.issues).toContainEqual(issue);
          const context = yield* Effect.promise(() => assemblies.runtimeContext(assembly));
          expect(context?.contextFiles[0]?.content).toBe("Read the actual specification.");
        }).pipe(Effect.provide(environment), Effect.scoped),
      );
    },
  );
  it.each(["missing", "deleted-after-preview"] as const)(
    "keeps a %s managed Skill local while importing usable Suite members",
    async (state) => {
      await Effect.runPromise(
        Effect.gen(function* () {
          const f = yield* fixture;
          const skill =
            state === "missing"
              ? undefined
              : (yield* Effect.promise(() =>
                  f.runtime.skillLibrary.execute({
                    action: "create",
                    name: "Managed method",
                    body: "---\nname: managed-method\ndescription: Managed method\n---\nRead the specification.\n",
                    tags: [],
                  }),
                )).skill!;
          const skillId = skill?.skillId ?? "skl_0123456789abcdef0123456789abcdef";
          const remove = () =>
            f.runtime.skillLibrary.execute({
              action: "delete",
              skillId,
              expectedRevision: skill!.revision,
              confirmExpertIds: [],
            });
          yield* Effect.promise(() =>
            fs.writeFile(
              path.join(f.source, "synara-suite.json"),
              JSON.stringify(managedReferenceManifest(f.manifest, skillId)),
            ),
          );
          const preview = yield* f.preview(`managed-${state}`);
          const missingIssue = expect.objectContaining({
            code: "resource_missing",
            subject: expect.objectContaining({ kind: "resource", id: "managed-method" }),
            effect: "limit-capability",
          });
          if (state === "deleted-after-preview") {
            expect(preview.issues).not.toContainEqual(missingIssue);
            yield* Effect.promise(remove);
          } else {
            expect(preview.issues).toContainEqual(missingIssue);
          }
          const receipt = yield* f.service.commit({
            operationId: `managed-${state}`,
            previewId: preview.previewId,
            contentHash: preview.contentHash,
            mode: "reuse-or-create",
          });
          expect(receipt.state).toBe("committed");
          if (receipt.state !== "committed") throw new Error("Expected usable partial Suite");
          const suite = yield* f.service.read(receipt.suite);
          expect(yield* f.store.readIssues(receipt.suite)).toContainEqual(missingIssue);
          expect(suite.resources).toContainEqual(
            expect.objectContaining({
              key: "rules",
              ref: expect.objectContaining({ kind: "files" }),
            }),
          );
          const author = yield* Effect.promise(() =>
            f.runtime.experts.read(suite.members[0]!.expertId),
          );
          expect(author?.persona).toBe("Fixed author identity");
        }).pipe(Effect.provide(environment), Effect.scoped),
      );
    },
  );

  it.each(["preview", "commit"] as const)(
    "does not downgrade unrelated managed library corruption during %s to resource_missing",
    async (phase) => {
      await Effect.runPromise(
        Effect.gen(function* () {
          const f = yield* fixture;
          const skill = (yield* Effect.promise(() =>
            f.runtime.skillLibrary.execute({
              action: "create",
              name: "Managed method",
              body: "---\nname: managed-method\ndescription: Managed method\n---\nRead the specification.\n",
              tags: [],
            }),
          )).skill!;
          yield* Effect.promise(() =>
            fs.writeFile(
              path.join(f.source, "synara-suite.json"),
              JSON.stringify(managedReferenceManifest(f.manifest, skill.skillId)),
            ),
          );
          const preview = phase === "commit" ? yield* f.preview() : undefined;
          yield* Effect.promise(() =>
            fs.writeFile(path.join(f.config.stateDir, "experts", "skill-library.json"), "{broken"),
          );
          const failure =
            phase === "preview"
              ? yield* Effect.flip(f.preview())
              : yield* Effect.flip(
                  f.service.commit({
                    operationId: "corrupt-library",
                    previewId: preview!.previewId,
                    contentHash: preview!.contentHash,
                    mode: "reuse-or-create",
                  }),
                );
          expect(failure.code).toBe("commit_failed");
          expect(yield* f.service.list()).toEqual([]);
          expect(yield* Effect.promise(() => f.runtime.experts.list())).toEqual(f.existingExperts);
        }).pipe(Effect.provide(environment), Effect.scoped),
      );
    },
  );

  it("rejects the 101st outstanding preview before local capture or network and releases cancelled capacity", async () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-11-11T10:00:00.000Z"));
    const fetch = vi.fn(async () => {
      throw new Error("Unexpected preview network request");
    });
    vi.stubGlobal("fetch", fetch);
    await Effect.runPromise(
      Effect.gen(function* () {
        const f = yield* fixture;
        const previews = [];
        for (let index = 0; index < 100; index++)
          previews.push(yield* f.preview(`budget-${index}`));
        const reopened = createSuiteImportService({
          stateDir: f.config.stateDir,
          store: f.store,
          readExternalFileResourcePackages: f.readExternalFileResourcePackages,
          runtime: f.runtime,
        });
        const capture = vi.spyOn(expertResourceFiles, "collect");
        const localFailure = yield* Effect.flip(
          reopened.preview({
            requestId: "full-local",
            source: { kind: "local-folder", path: f.source },
          }),
        );
        expect(localFailure.code).toBe("invalid_manifest");
        expect(capture).not.toHaveBeenCalled();
        const networkFailure = yield* Effect.flip(
          reopened.preview({
            requestId: "full-network",
            source: { kind: "github", url: "https://github.com/acme/suite" },
          }),
        );
        expect(networkFailure.code).toBe("invalid_manifest");
        expect(fetch).not.toHaveBeenCalled();
        expect(yield* reopened.cancelPreview(previews[0]!.previewId)).toEqual({ cancelled: true });
        expect(
          (yield* reopened.preview({
            requestId: "released-slot",
            source: { kind: "local-folder", path: f.source },
          })).members,
        ).toHaveLength(1);
      }).pipe(Effect.provide(environment), Effect.scoped),
    );
  }, 30_000);

  it("admits only one concurrent preview into the last slot across service owners", async () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-11-11T10:00:00.000Z"));
    await Effect.runPromise(
      Effect.gen(function* () {
        const f = yield* fixture;
        for (let index = 0; index < 99; index++) yield* f.preview(`concurrent-${index}`);
        const reopened = createSuiteImportService({
          stateDir: f.config.stateDir,
          store: f.store,
          readExternalFileResourcePackages: f.readExternalFileResourcePackages,
          runtime: f.runtime,
        });
        const outcomes = yield* Effect.promise(() =>
          Promise.allSettled([
            Effect.runPromise(f.preview("last-slot-a")),
            Effect.runPromise(
              reopened.preview({
                requestId: "last-slot-b",
                source: { kind: "local-folder", path: f.source },
              }),
            ),
          ]),
        );
        expect(outcomes.filter((result) => result.status === "fulfilled")).toHaveLength(1);
        expect(outcomes.filter((result) => result.status === "rejected")).toHaveLength(1);
        const winner = outcomes.find((result) => result.status === "fulfilled");
        if (!winner || winner.status !== "fulfilled")
          throw new Error("Expected one admitted preview");
        expect(yield* reopened.cancelPreview(winner.value.previewId)).toEqual({ cancelled: true });
        expect((yield* f.preview("after-concurrent-cancel")).members).toHaveLength(1);
      }).pipe(Effect.provide(environment), Effect.scoped),
    );
  }, 30_000);

  it("reaps expired preview-only sources but protects pending journals, committed references and unrelated packages", async () => {
    let now = Date.parse("2026-11-11T10:00:00.000Z");
    vi.spyOn(Date, "now").mockImplementation(() => now);
    await Effect.runPromise(
      Effect.gen(function* () {
        const f = yield* fixture;
        const files = createFileResourceStore(f.config.stateDir);
        const orphan = yield* f.preview("orphan");
        const orphanPackage = `res_${orphan.contentHash}`;
        yield* Effect.promise(() =>
          fs.writeFile(path.join(f.source, "author.md"), "Pending identity"),
        );
        const pendingPreview = yield* f.preview("pending");
        const interrupted = createSuiteImportService({
          stateDir: f.config.stateDir,
          store: f.store,
          readExternalFileResourcePackages: f.readExternalFileResourcePackages,
          runtime: {
            ...f.runtime,
            experts: {
              ...f.runtime.experts,
              stageImport: async (input) => {
                await f.runtime.experts.stageImport(input);
                throw new Error("Controlled interruption after real owner staging");
              },
            },
          },
        });
        const pendingRequest: SuiteImportRequest = {
          operationId: "protected-pending",
          previewId: pendingPreview.previewId,
          contentHash: pendingPreview.contentHash,
          mode: "reuse-or-create",
        };
        yield* Effect.flip(interrupted.commit(pendingRequest));
        expect((yield* f.store.getImportReceipt(pendingRequest.operationId))?.state).toBe(
          "pending",
        );
        const pendingPlan = (yield* f.store.findImport(pendingRequest.operationId))!;
        yield* Effect.promise(() =>
          fs.writeFile(path.join(f.source, "author.md"), "Committed identity"),
        );
        yield* Effect.promise(() =>
          fs.writeFile(
            path.join(f.source, "synara-suite.json"),
            JSON.stringify({
              ...f.manifest,
              resources: [{ key: "rules", kind: "files", root: ".", purpose: "instructions" }],
            }),
          ),
        );
        const committedPreview = yield* f.preview("committed");
        const receipt = yield* f.service.commit({
          operationId: "protected-committed",
          previewId: committedPreview.previewId,
          contentHash: committedPreview.contentHash,
          mode: "independent-new-content",
        });
        if (receipt.state !== "committed") throw new Error("Expected committed protected source");
        const unrelatedRoot = path.join(f.config.stateDir, "unrelated-owner-input");
        yield* Effect.promise(async () => {
          await fs.mkdir(unrelatedRoot);
          await fs.writeFile(path.join(unrelatedRoot, "notes.txt"), "Owned outside Suite previews");
        });
        const unrelated = yield* Effect.promise(() => files.seal(unrelatedRoot));
        now = Date.parse(orphan.expiresAt);
        yield* Effect.promise(() =>
          fs.writeFile(path.join(f.source, "author.md"), "Fresh identity"),
        );
        const reopened = createSuiteImportService({
          stateDir: f.config.stateDir,
          store: f.store,
          readExternalFileResourcePackages: f.readExternalFileResourcePackages,
          runtime: f.runtime,
        });
        const fresh = yield* reopened.preview({
          requestId: "after-expiry",
          source: { kind: "local-folder", path: f.source },
        });
        expect(Date.parse(fresh.expiresAt)).toBe(now + 15 * 60 * 1_000);
        expect(yield* reopened.cancelPreview(orphan.previewId)).toEqual({ cancelled: false });
        expect(
          yield* Effect.promise(() =>
            files.read(orphanPackage).then(
              () => false,
              (error: NodeJS.ErrnoException) => error.code === "ENOENT",
            ),
          ),
        ).toBe(true);
        expect(
          (yield* Effect.promise(() => files.read(`res_${pendingPreview.contentHash}`))).rootPath,
        ).toBe(pendingPlan.sourceRoot);
        expect(
          (yield* Effect.promise(() => files.read(`res_${committedPreview.contentHash}`)))
            .resources,
        ).toContainEqual(expect.objectContaining({ path: "author.md" }));
        expect((yield* Effect.promise(() => files.read(unrelated.packageId))).resources).toEqual(
          unrelated.resources,
        );
        const resumed = yield* reopened.getReceipt(pendingRequest.operationId);
        expect(resumed).toMatchObject({ state: "committed", suite: pendingPlan.composition.ref });
        expect(yield* reopened.commit(pendingRequest)).toEqual(resumed);
        expect(yield* reopened.read(receipt.suite)).toEqual(yield* f.service.read(receipt.suite));
        expect(
          yield* Effect.promise(() => fs.readFile(path.join(f.source, "author.md"), "utf8")),
        ).toBe("Fresh identity");
        const expired = yield* reopened.commit({
          operationId: "expired-orphan",
          previewId: orphan.previewId,
          contentHash: orphan.contentHash,
          mode: "reuse-or-create",
        });
        expect(expired).toMatchObject({ state: "failed", issue: { code: "preview_expired" } });
      }).pipe(Effect.provide(environment), Effect.scoped),
    );
  });

  it("fails closed on external reference storage errors before deleting expired source packages", async () => {
    let now = Date.parse("2026-11-11T10:00:00.000Z");
    vi.spyOn(Date, "now").mockImplementation(() => now);
    await Effect.runPromise(
      Effect.gen(function* () {
        const f = yield* fixture;
        const preview = yield* f.preview("external-storage-protection");
        const files = createFileResourceStore(f.config.stateDir);
        const sealed = yield* Effect.promise(() => files.read(`res_${preview.contentHash}`));
        now = Date.parse(preview.expiresAt);
        const unavailable = createSuiteImportService({
          stateDir: f.config.stateDir,
          store: f.store,
          runtime: f.runtime,
          readExternalFileResourcePackages: () =>
            Effect.runPromise(
              f.sql<{
                packageId: string;
              }>`SELECT package_id AS "packageId" FROM unavailable_artifact_versions`.pipe(
                Effect.map((rows) => new Set(rows.map((row) => row.packageId))),
              ),
            ),
        });
        const failure = yield* Effect.flip(
          unavailable.preview({
            requestId: "external-storage-unavailable",
            source: { kind: "local-folder", path: f.source },
          }),
        );
        expect(failure.code).toBe("commit_failed");
        expect((yield* Effect.promise(() => files.read(sealed.packageId))).rootPath).toBe(
          sealed.rootPath,
        );
        yield* Effect.promise(() =>
          fs.writeFile(path.join(f.source, "author.md"), "Replacement identity"),
        );
        yield* f.preview("external-storage-restored");
        expect(yield* f.service.cancelPreview(preview.previewId)).toEqual({ cancelled: false });
        expect(
          yield* Effect.promise(() =>
            files.read(sealed.packageId).then(
              () => false,
              (error: NodeJS.ErrnoException) => error.code === "ENOENT",
            ),
          ),
        ).toBe(true);
      }).pipe(Effect.provide(environment), Effect.scoped),
    );
  });

  it("previews/cancels without objects, hashes opaque IDs, and keeps sealed source bytes", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const f = yield* fixture;
        const p = yield* f.preview("../../outside-request");
        expect(yield* f.service.list()).toEqual([]);
        expect(yield* Effect.promise(() => f.runtime.experts.list())).toEqual(f.existingExperts);
        expect(yield* Effect.promise(() => f.runtime.connections.list())).toEqual(
          f.existingConnections,
        );
        expect(p.source).not.toHaveProperty("path");
        expect(yield* f.service.cancelPreview("../../outside-preview")).toEqual({
          cancelled: false,
        });
        expect(yield* f.service.cancelPreview(p.previewId)).toEqual({ cancelled: true });
        const cancelled = yield* f.service.commit({
          operationId: "../../opaque-operation",
          previewId: p.previewId,
          contentHash: p.contentHash,
          mode: "reuse-or-create",
        });
        expect(cancelled).toMatchObject({ state: "failed", issue: { code: "preview_expired" } });
        expect(yield* f.service.list()).toEqual([]);
        expect(yield* Effect.promise(() => f.runtime.experts.list())).toEqual(f.existingExperts);
        expect(yield* Effect.promise(() => f.runtime.connections.list())).toEqual(
          f.existingConnections,
        );
        const sealed = yield* f.preview();
        yield* Effect.promise(() =>
          fs.writeFile(path.join(f.source, "author.md"), "Changed external source"),
        );
        const reloaded = createSuiteImportService({
          stateDir: f.config.stateDir,
          store: f.store,
          readExternalFileResourcePackages: f.readExternalFileResourcePackages,
          runtime: f.runtime,
        });
        const receipt = yield* reloaded.commit({
          operationId: "sealed",
          previewId: sealed.previewId,
          contentHash: sealed.contentHash,
          mode: "reuse-or-create",
        });
        expect(receipt.state).toBe("committed");
        if (receipt.state !== "committed") throw new Error("Expected committed fixture");
        const suite = yield* f.service.read(receipt.suite);
        expect(
          (yield* Effect.promise(() => f.runtime.experts.read(suite.members[0]!.expertId)))
            ?.persona,
        ).toBe("Fixed author identity");
      }).pipe(Effect.provide(environment), Effect.scoped),
    );
  });

  it("converges A/B to one durable plan, returns independent receipts, and rejects key conflicts", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const f = yield* fixture;
        const a = yield* f.preview("A"),
          b = yield* f.preview("B");
        const requestA: SuiteImportRequest = {
          operationId: "A",
          previewId: a.previewId,
          contentHash: a.contentHash,
          mode: "reuse-or-create",
        };
        const requestB: SuiteImportRequest = {
          operationId: "B",
          previewId: b.previewId,
          contentHash: b.contentHash,
          mode: "reuse-or-create",
        };
        const receipts = yield* Effect.all(
          [f.service.commit(requestA), f.service.commit(requestB)],
          { concurrency: 2 },
        );
        expect(receipts[0]).toMatchObject({ operationId: "A", state: "committed" });
        expect(receipts[1]).toMatchObject({ operationId: "B", state: "committed" });
        if (receipts[0]!.state !== "committed" || receipts[1]!.state !== "committed")
          throw new Error("Expected committed fixtures");
        expect(receipts[0]!.suite).toEqual(receipts[1]!.suite);
        expect([receipts[0]!.reused, receipts[1]!.reused].sort()).toEqual([false, true]);
        const planA = yield* f.store.findImport("A"),
          planB = yield* f.store.findImport("B");
        expect(planA).toEqual(planB);
        expect(yield* f.service.list()).toHaveLength(1);
        const experts = yield* Effect.promise(() => f.runtime.experts.list());
        expect(
          experts.filter((expert) =>
            f.existingExperts.some((existing) => existing.id === expert.id),
          ),
        ).toEqual(f.existingExperts);
        expect(experts.map((expert) => expert.id).sort()).toEqual(
          [
            ...f.existingExperts.map((expert) => expert.id),
            ...planA!.experts.map((expert) => expert.expertId),
          ].sort(),
        );
        expect(yield* f.service.getReceipt("A")).toEqual(receipts[0]);
        const reopened = createSuiteImportService({
          stateDir: f.config.stateDir,
          store: f.store,
          readExternalFileResourcePackages: f.readExternalFileResourcePackages,
          runtime: f.runtime,
        });
        expect(yield* reopened.commit(requestB)).toEqual(receipts[1]);
        const conflict = yield* Effect.flip(
          reopened.commit({ ...requestA, mode: "independent-new-content" }),
        );
        expect(conflict.code).toBe("revision_conflict");
        const rows = yield* f.sql<{
          count: number;
        }>`SELECT count(*) AS count FROM suite_import_plans`;
        expect(rows[0]?.count).toBe(1);
      }).pipe(Effect.provide(environment), Effect.scoped),
    );
  });

  it("persists content_changed until a distinct operation explicitly requests independent content", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const f = yield* fixture;
        const first = yield* f.preview();
        const firstReceipt = yield* f.service.commit({
          operationId: "first",
          previewId: first.previewId,
          contentHash: first.contentHash,
          mode: "reuse-or-create",
        });
        if (firstReceipt.state !== "committed") throw new Error("Expected first committed Suite");
        const firstSuite = yield* f.service.read(firstReceipt.suite);
        const firstPlan = (yield* f.store.findImport("first"))!;
        const beforeSuites = yield* f.service.list();
        const beforeRejected = yield* Effect.promise(() => f.runtime.experts.list());
        yield* Effect.promise(() =>
          fs.writeFile(path.join(f.source, "author.md"), "Independent new identity"),
        );
        const changed = yield* f.preview();
        expect(changed.source.sourceId).toBe(first.source.sourceId);
        expect(changed.contentHash).not.toBe(first.contentHash);
        const request: SuiteImportRequest = {
          operationId: "changed",
          previewId: changed.previewId,
          contentHash: changed.contentHash,
          mode: "reuse-or-create",
        };
        const rejected = yield* f.service.commit(request);
        expect(rejected).toMatchObject({ state: "failed", issue: { code: "content_changed" } });
        expect(yield* f.service.getReceipt("changed")).toEqual(rejected);
        expect(yield* f.service.commit(request)).toEqual(rejected);
        expect(yield* f.service.list()).toEqual(beforeSuites);
        expect(yield* Effect.promise(() => f.runtime.experts.list())).toEqual(beforeRejected);
        expect(yield* Effect.promise(() => f.runtime.connections.list())).toEqual(
          f.existingConnections,
        );
        const independent = yield* f.service.commit({
          ...request,
          operationId: "explicit-independent",
          mode: "independent-new-content",
        });
        if (independent.state !== "committed")
          throw new Error("Expected independent committed Suite");
        expect(independent.suite).not.toEqual(firstReceipt.suite);
        const independentSuite = yield* f.service.read(independent.suite);
        const independentPlan = (yield* f.store.findImport(independent.operationId))!;
        expect(independentSuite.source).toEqual(changed.source);
        expect(firstSuite.source).toEqual(first.source);
        expect(independentSuite.members[0]!.expertId).not.toBe(firstSuite.members[0]!.expertId);
        expect(
          (yield* Effect.promise(() =>
            f.runtime.experts.read(independentSuite.members[0]!.expertId),
          ))?.persona,
        ).toBe("Independent new identity");
        expect(yield* f.service.read(firstReceipt.suite)).toEqual(firstSuite);
        const experts = yield* Effect.promise(() => f.runtime.experts.list());
        expect(
          experts.filter((expert) => beforeRejected.some((existing) => existing.id === expert.id)),
        ).toEqual(beforeRejected);
        expect(experts.map((expert) => expert.id).sort()).toEqual(
          [
            ...beforeRejected.map((expert) => expert.id),
            independentSuite.members[0]!.expertId,
          ].sort(),
        );
        expect(
          yield* Effect.promise(() =>
            fs.readFile(path.join(firstPlan.sourceRoot, "author.md"), "utf8"),
          ),
        ).toBe("Fixed author identity");
        expect(
          yield* Effect.promise(() =>
            fs.readFile(path.join(independentPlan.sourceRoot, "author.md"), "utf8"),
          ),
        ).toBe("Independent new identity");
        expect(yield* f.service.list()).toHaveLength(2);
      }).pipe(Effect.provide(environment), Effect.scoped),
    );
  });

  it("resumes journal/staged interruption after cancellation using the same IDs and hidden Experts", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const f = yield* fixture;
        const p = yield* f.preview();
        const interrupted = createSuiteImportService({
          stateDir: f.config.stateDir,
          store: f.store,
          readExternalFileResourcePackages: f.readExternalFileResourcePackages,
          runtime: {
            ...f.runtime,
            experts: {
              ...f.runtime.experts,
              stageImport: async (input) => {
                await f.runtime.experts.stageImport(input);
                throw new Error("Controlled interruption after real owner staging");
              },
            },
          },
        });
        const request: SuiteImportRequest = {
          operationId: "resume-original",
          previewId: p.previewId,
          contentHash: p.contentHash,
          mode: "reuse-or-create",
        };
        yield* Effect.flip(interrupted.commit(request));
        const pending = yield* f.store.getImportReceipt(request.operationId);
        expect(pending?.state).toBe("pending");
        const plan = (yield* f.store.findImport(request.operationId))!;
        expect(yield* f.service.list()).toEqual([]);
        expect(yield* Effect.promise(() => f.runtime.experts.list())).toEqual(f.existingExperts);
        expect(
          yield* Effect.promise(() => f.runtime.experts.read(plan.experts[0]!.expertId)),
        ).toBeNull();
        const hidden = yield* Effect.promise(() =>
          f.runtime.experts.prepareSnapshot(plan.experts[0]!.expertId).then(
            () => false,
            () => true,
          ),
        );
        expect(hidden).toBe(true);
        yield* f.service.cancelPreview(p.previewId);
        const reloaded = createSuiteImportService({
          stateDir: f.config.stateDir,
          store: f.store,
          readExternalFileResourcePackages: f.readExternalFileResourcePackages,
          runtime: f.runtime,
        });
        const receipt = yield* reloaded.getReceipt(request.operationId);
        expect(receipt).toMatchObject({ state: "committed", suite: plan.composition.ref });
        expect(yield* f.store.findImport(request.operationId)).toEqual(plan);
        expect(yield* reloaded.getReceipt(request.operationId)).toEqual(receipt);
        expect(yield* reloaded.commit(request)).toEqual(receipt);
        const experts = yield* Effect.promise(() => f.runtime.experts.list());
        expect(
          experts.filter((expert) =>
            f.existingExperts.some((existing) => existing.id === expert.id),
          ),
        ).toEqual(f.existingExperts);
        expect(experts.map((expert) => expert.id).sort()).toEqual(
          [
            ...f.existingExperts.map((expert) => expert.id),
            ...plan.experts.map((expert) => expert.expertId),
          ].sort(),
        );
      }).pipe(Effect.provide(environment), Effect.scoped),
    );
  });

  it("keeps a missing identity local and never creates or copies a shared connection into direct Experts", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const f = yield* fixture;
        yield* Effect.promise(() =>
          f.runtime.connections.save({
            id: "readonly-lookup",
            name: "Existing read-only lookup",
            transport: { type: "http", url: "http://127.0.0.1:1/mcp", headersFromHost: [] },
          }),
        );
        const partial: SuiteManifestV1 = {
          ...f.manifest,
          experts: [
            ...f.manifest.experts,
            {
              key: "missing",
              kind: "definition",
              name: "Missing",
              description: "",
              personaPath: "missing.md",
            },
          ],
          resources: [
            ...(f.manifest.resources ?? []),
            {
              key: "lookup",
              kind: "connection",
              connectionId: "readonly-lookup",
              tools: { mode: "selected", names: ["lookup"] },
            },
          ],
          sharedResourceKeys: ["rules", "lookup"],
        };
        yield* Effect.promise(() =>
          fs.writeFile(path.join(f.source, "synara-suite.json"), JSON.stringify(partial)),
        );
        const p = yield* f.preview();
        expect(p.issues).toContainEqual(
          expect.objectContaining({
            code: "identity_unavailable",
            subject: expect.objectContaining({ id: "missing" }),
          }),
        );
        const receipt = yield* f.service.commit({
          operationId: "partial",
          previewId: p.previewId,
          contentHash: p.contentHash,
          mode: "reuse-or-create",
        });
        if (receipt.state !== "committed") throw new Error("Expected committed partial Suite");
        const suite = yield* f.service.read(receipt.suite);
        const author = suite.members.find((member) => member.key === "author")!,
          missing = suite.members.find((member) => member.key === "missing")!;
        expect(
          (yield* Effect.promise(() => f.runtime.experts.read(author.expertId)))?.connections,
        ).toEqual([]);
        expect(
          (yield* Effect.promise(() => f.runtime.experts.read(author.expertId)))?.references,
        ).toEqual([]);
        expect(yield* Effect.promise(() => f.runtime.connections.list())).toHaveLength(1);
        expect(yield* Effect.promise(() => f.runtime.skillPackages.list())).toEqual([]);
        expect(suite.resources).toContainEqual(
          expect.objectContaining({
            audience: "shared",
            ref: {
              kind: "connection",
              sourceId: suite.source.sourceId,
              connection: {
                id: "readonly-lookup",
                required: true,
                tools: ["lookup"],
                toolMode: "selected",
                enabled: true,
              },
            },
          }),
        );
        expect(
          yield* Effect.promise(() =>
            f.runtime.experts.prepareSnapshot(author.expertId).then(() => true),
          ),
        ).toBe(true);
        expect(
          yield* Effect.promise(() =>
            f.runtime.experts.prepareSnapshot(missing.expertId).then(
              () => false,
              () => true,
            ),
          ),
        ).toBe(true);
      }).pipe(Effect.provide(environment), Effect.scoped),
    );
  });

  it("retains missing Skill source and diagnostics without inventing a package capability", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const f = yield* fixture;
        const manifest: SuiteManifestV1 = {
          ...f.manifest,
          resources: [
            ...(f.manifest.resources ?? []),
            { key: "missing-method", kind: "skill", packageRoot: "rules", entryPath: "SKILL.md" },
          ],
          sharedResourceKeys: ["rules", "missing-method"],
        };
        yield* Effect.promise(() =>
          fs.writeFile(path.join(f.source, "synara-suite.json"), JSON.stringify(manifest)),
        );
        const p = yield* f.preview();
        const receipt = yield* f.service.commit({
          operationId: "missing-method",
          previewId: p.previewId,
          contentHash: p.contentHash,
          mode: "reuse-or-create",
        });
        if (receipt.state !== "committed") throw new Error("Expected partial resource commit");
        const plan = (yield* f.store.findImport(receipt.operationId))!;
        expect(plan.assets.every((asset) => asset.kind === "files")).toBe(true);
        expect(plan.issues).toContainEqual(
          expect.objectContaining({
            subject: expect.objectContaining({ id: "missing-method" }),
            effect: "limit-capability",
          }),
        );
        expect(plan.composition.resources.some((use) => use.key === "missing-method")).toBe(false);
        expect(
          yield* Effect.promise(() =>
            fs.readFile(path.join(plan.sourceRoot, "synara-suite.json"), "utf8"),
          ),
        ).toContain("missing-method");
        expect(yield* Effect.promise(() => f.runtime.skillPackages.list())).toEqual([]);
      }).pipe(Effect.provide(environment), Effect.scoped),
    );
  });

  it("requires native owner authorization before every one of the seven handlers", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const f = yield* fixture;
        const denied = new WsRpcError({ message: "Owner required" });
        const handlers = makeWorkbenchSuiteRpcHandlers({
          service: f.service,
          store: f.store,
          stateDir: f.config.stateDir,
          requireOwner: Effect.fail(denied),
          requireThread: () => Effect.fail(denied),
          rpcEffect: (effect) => effect.pipe(Effect.mapError(() => denied)),
        });
        const suite = {
          suiteId: "suite_a892dfb0-7aaf-44bc-bc65-e7dcf292ee66" as const,
          revision: 1,
        };
        const actions: readonly Effect.Effect<unknown, WsRpcError>[] = [
          handlers[WS_METHODS.serverPreviewSuite]({
            requestId: "denied",
            source: { kind: "local-folder", path: f.source },
          }),
          handlers[WS_METHODS.serverCancelSuitePreview]({ previewId: "../../denied" }),
          handlers[WS_METHODS.serverCommitSuiteImport]({
            operationId: "denied",
            previewId: "denied",
            contentHash: "a".repeat(64),
            mode: "reuse-or-create",
          }),
          handlers[WS_METHODS.serverGetSuiteImportReceipt]({ operationId: "denied" }),
          handlers[WS_METHODS.serverListSuites](),
          handlers[WS_METHODS.serverReadSuite](suite),
          handlers[WS_METHODS.serverReadSuiteRunConfiguration]({
            threadId: ThreadId.makeUnsafe("denied"),
            rootRunId: "../../denied",
          }),
        ];
        for (const action of actions) expect(yield* Effect.flip(action)).toBe(denied);
        expect(yield* f.service.list()).toEqual([]);
        expect(yield* f.service.getReceipt("denied")).toBeNull();
        expect(yield* Effect.promise(() => f.runtime.experts.list())).toEqual(f.existingExperts);
        expect(yield* Effect.promise(() => f.runtime.connections.list())).toEqual(
          f.existingConnections,
        );
      }).pipe(Effect.provide(environment), Effect.scoped),
    );
  });
});
