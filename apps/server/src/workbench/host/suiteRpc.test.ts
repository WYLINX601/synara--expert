import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";
import { ProjectId, ThreadId } from "@synara/contracts";
import { ServerConfig } from "../../config";
import * as NodeSqliteClient from "../../persistence/NodeSqliteClient";
import { runMigrations } from "../../persistence/Migrations";
import { runWorkbenchMigrations } from "../persistence/WorkbenchMigrations";
import {
  makeSuiteCompositionStore,
  SuiteCompositionStore,
} from "../../suites/SuiteCompositionStore";
import { makeSuiteBindingResolver } from "../../suites/SuiteBindingResolver";
import { createSuiteImportService } from "../../suites/SuiteImportService";
import { installExpertImportPublicationReader } from "../../suites/SuitePublicationHost";
import { createExpertConnectionStore } from "../../experts/ExpertConnectionStore";
import { createSkillPackageStore } from "../../experts/SkillPackageStore";
import { createSkillLibraryStore } from "../../experts/SkillLibraryStore";
import { createExpertStore } from "../../experts/ExpertStore";
import { createRunSkillAssemblyStore } from "../../experts/RunSkillAssemblyStore";
import { readAuthorizedSuiteRunConfiguration } from "./suiteRpc";
import { readonlyResourceTestConfigLayer } from "../../experts/expertResourceTestFixtures";
import { makeExpertDelegationArtifacts } from "./expertDelegationArtifacts";
import { ExpertDelegationStore, makeExpertDelegationStore } from "./expertDelegationStore";

const environment = Layer.mergeAll(
  NodeSqliteClient.layerMemory(),
  readonlyResourceTestConfigLayer("suite-rpc-").pipe(Layer.provide(NodeServices.layer)),
);
const fixture = Effect.gen(function* () {
  yield* runMigrations();
  yield* runWorkbenchMigrations();
  const config = yield* ServerConfig;
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
  const source = path.join(config.stateDir, "run-suite-source");
  yield* Effect.promise(async () => {
    await fs.mkdir(source);
    await fs.writeFile(path.join(source, "author.md"), "Real run fixture identity");
    await fs.writeFile(
      path.join(source, "synara-suite.json"),
      JSON.stringify({
        schemaVersion: 1,
        name: "Run config",
        description: "",
        experts: [
          {
            key: "author",
            kind: "definition",
            name: "Author",
            description: "",
            personaPath: "author.md",
          },
        ],
        defaults: { language: "中文", outputDirectory: "outputs/evidence" },
      }),
    );
  });
  const delegations = yield* makeExpertDelegationStore;
  const artifacts = yield* makeExpertDelegationArtifacts.pipe(
    Effect.provideService(ExpertDelegationStore, delegations),
  );
  const imports = createSuiteImportService({
    stateDir: config.stateDir,
    store,
    runtime,
    readExternalFileResourcePackages: () => Effect.runPromise(artifacts.referencedPackages),
  });
  const preview = yield* imports.preview({
    requestId: "run-config",
    source: { kind: "local-folder", path: source },
  });
  const receipt = yield* imports.commit({
    operationId: "run-config",
    previewId: preview.previewId,
    contentHash: preview.contentHash,
    mode: "reuse-or-create",
  });
  if (receipt.state !== "committed") throw new Error("Run fixture import did not commit");
  const saved = yield* imports.read(receipt.suite);
  const resolver = yield* makeSuiteBindingResolver.pipe(
    Effect.provideService(SuiteCompositionStore, store),
  );
  const projectId = ProjectId.makeUnsafe("project-fixture"),
    threadId = ThreadId.makeUnsafe("thread-fixture");
  const binding = yield* resolver.prepare({
    suite: saved.ref,
    purpose: { kind: "hub-coordinator", hubId: "hub-fixture", hubConfigRevision: 1 },
    projectId,
  });
  const assemblies = createRunSkillAssemblyStore(config.stateDir, { suiteStore: store });
  const record = yield* Effect.promise(() =>
    assemblies.prepare({
      threadId,
      rootRunId: "actual-root",
      baseSnapshotId: null,
      capabilityBindingId: binding.bindingId,
      projectRoot: config.cwd,
      createdAt: saved.createdAt,
    }),
  );
  const thread = { id: threadId, projectId, capabilityBindingId: binding.bindingId };
  return { config, store, assemblies, record, thread, composition: saved };
});

describe("Suite RPC actual read-only Run configuration", () => {
  it("reads the fixed real assembly, not current Suite defaults or prepare, and rejects cross-thread Roots", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const f = yield* fixture;
        const request = { threadId: f.thread.id, rootRunId: f.record.rootRunId };
        const output = yield* readAuthorizedSuiteRunConfiguration({
          stateDir: f.config.stateDir,
          store: f.store,
          thread: f.thread,
          request,
        });
        expect(output).toMatchObject({
          state: "prepared",
          suite: f.composition.ref,
          assemblyId: f.record.assemblyId,
          effectiveConfig: { language: "中文", outputDirectory: "outputs/evidence" },
        });
        expect(JSON.stringify(output)).not.toContain(f.config.stateDir);
        expect(JSON.stringify(output)).not.toContain(f.config.cwd);
        const directory = path.join(f.config.stateDir, "experts", "run-skill-assemblies");
        const filesBefore = yield* Effect.promise(() => fs.readdir(directory));
        const missing = yield* readAuthorizedSuiteRunConfiguration({
          stateDir: f.config.stateDir,
          store: f.store,
          thread: f.thread,
          request: { ...request, rootRunId: "../../unknown-run" },
        });
        expect(missing).toEqual({ state: "not-prepared" });
        expect(yield* Effect.promise(() => fs.readdir(directory))).toEqual(filesBefore);
        const otherThread = { ...f.thread, id: ThreadId.makeUnsafe("another-thread") };
        const denied = yield* Effect.flip(
          readAuthorizedSuiteRunConfiguration({
            stateDir: f.config.stateDir,
            store: f.store,
            thread: otherThread,
            request: { ...request, threadId: otherThread.id },
          }),
        );
        expect(denied.message).toContain("does not belong");
        const deniedBinding = yield* Effect.flip(
          readAuthorizedSuiteRunConfiguration({
            stateDir: f.config.stateDir,
            store: f.store,
            thread: { ...f.thread, capabilityBindingId: "another-binding" },
            request,
          }),
        );
        expect(deniedBinding.message).toContain("does not match");
      }).pipe(Effect.provide(environment), Effect.scoped),
    );
  });

  it("reports a real v1 as prepared without inventing Suite provenance", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const f = yield* fixture;
        const experts = createExpertStore(f.config.stateDir);
        const expert = yield* Effect.promise(() =>
          experts.save({
            name: "Legacy identity",
            description: "",
            persona: "Real legacy identity",
            useCases: "",
            outputRequirements: "",
            skills: [],
            references: [],
            connections: [],
          }),
        );
        const base = yield* Effect.promise(() => experts.prepareSnapshot(expert.id));
        const legacy = yield* Effect.promise(() =>
          f.assemblies.prepare({
            threadId: f.thread.id,
            rootRunId: "legacy-root",
            baseSnapshotId: base.snapshotId,
            createdAt: f.composition.createdAt,
          }),
        );
        expect(legacy.schemaVersion).toBe(1);
        const output = yield* readAuthorizedSuiteRunConfiguration({
          stateDir: f.config.stateDir,
          store: f.store,
          thread: f.thread,
          request: { threadId: f.thread.id, rootRunId: legacy.rootRunId },
        });
        expect(output).toMatchObject({
          state: "prepared",
          suite: null,
          assemblyId: legacy.assemblyId,
          effectiveConfig: {
            language: null,
            outputDirectory: null,
            provenance: [],
            issues: [
              expect.objectContaining({ code: "unsupported_capability", effect: "observe" }),
            ],
          },
        });
      }).pipe(Effect.provide(environment), Effect.scoped),
    );
  });
});
