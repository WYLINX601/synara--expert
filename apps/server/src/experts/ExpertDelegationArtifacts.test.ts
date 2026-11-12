import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ProjectId,
  ThreadId,
  OrchestrationThreadShell,
  type CapabilityBinding,
} from "@synara/contracts";
import { Effect, Layer, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";
import { ServerConfig } from "../config";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient";
import { runMigrations } from "../persistence/Migrations";
import { runWorkbenchMigrations } from "../workbench/persistence/WorkbenchMigrations";
import {
  capabilityBindingFingerprint,
  makeSuiteCompositionStore,
} from "../suites/SuiteCompositionStore";
import { suiteContentDigest } from "../suites/suiteIdentity";
import { makeExpertDelegationResultTools } from "../agentGateway/expertDelegationResultTools";
import type { ToolContext } from "../agentGateway/toolRuntime";
import {
  ExpertDelegationStore,
  makeExpertDelegationStore,
} from "../workbench/host/expertDelegationStore";
import { makeExpertDelegationArtifacts } from "../workbench/host/expertDelegationArtifacts";
import { createExpertStore } from "./ExpertStore";
import { readonlyResourceTestConfigLayer } from "./expertResourceTestFixtures";

const createdAt = "2026-11-11T00:00:00.000Z";
const environment = Layer.mergeAll(
  NodeSqliteClient.layerMemory(),
  readonlyResourceTestConfigLayer("artifact-versions-").pipe(Layer.provide(NodeServices.layer)),
);
const fixture = Effect.gen(function* () {
  yield* runMigrations();
  yield* runWorkbenchMigrations();
  const config = yield* ServerConfig;
  const sql = yield* SqlClient.SqlClient;
  const delegations = yield* makeExpertDelegationStore;
  const bindings = yield* makeSuiteCompositionStore;
  const artifacts = yield* makeExpertDelegationArtifacts.pipe(
    Effect.provideService(ExpertDelegationStore, delegations),
  );
  const experts = createExpertStore(config.stateDir);
  const expert = yield* Effect.promise(() =>
    experts.save({
      name: "Actual code author",
      description: "",
      useCases: "",
      persona: "Author",
      outputRequirements: "Code",
      skills: [],
      references: [],
      connections: [],
    }),
  );
  const snapshot = yield* Effect.promise(() => experts.prepareSnapshot(expert.id));
  const workRoot = path.join(config.stateDir, "workspace");
  const code = Buffer.from("export const value = 42;\n");
  yield* Effect.promise(async () => {
    await fs.mkdir(workRoot);
    await fs.writeFile(path.join(workRoot, "result.ts"), code);
  });
  const files = [
    {
      path: "result.ts",
      sha256: createHash("sha256").update(code).digest("hex"),
      size: code.length,
    },
  ];
  const content = {
    outcome: "completed" as const,
    result: { summary: "Actual code", artifacts: files },
    issue: null,
  };
  const resultHash = suiteContentDigest(content);
  const prepare = (id: string, parent = "parent", author = expert.id) =>
    Effect.gen(function* () {
      const initial: CapabilityBinding = {
        schemaVersion: 1,
        bindingId: `binding-${id}`,
        bindingHash: "0".repeat(64),
        suite: null,
        purpose: {
          kind: "native-delegate",
          parentThreadId: ThreadId.makeUnsafe(parent),
          parentRootRunId: "root",
          delegationId: `delegation-${id}`,
          attemptId: id,
          expertSnapshotId: snapshot.snapshotId,
        },
        projectId: ProjectId.makeUnsafe("project"),
        connections: [],
        mcpBinding: null,
        createdAt,
      };
      const binding = yield* bindings.saveBinding({
        ...initial,
        bindingHash: capabilityBindingFingerprint(initial),
      });
      yield* delegations.prepare({
        delegation: {
          delegationId: `delegation-${id}`,
          parentThreadId: ThreadId.makeUnsafe(parent),
          parentRootRunId: "root",
          targetExpertId: author,
          task: "Produce code",
          context: "",
          deliverable: "Code",
        },
        attempt: {
          attemptId: id,
          delegationId: `delegation-${id}`,
          requestId: `request-${id}`,
          requestHash: suiteContentDigest({ id }),
          provider: "omp",
          capabilityBindingId: binding.bindingId,
          assemblyId: `assembly-${id}`,
          executionBindingId: `execution-${id}`,
          state: "prepared",
          revision: 1,
          resultRef: null,
          resultHash: null,
          appliedEventId: null,
          updatedAt: createdAt,
        },
      });
    });
  const commit = (id: string) =>
    sql.withTransaction(
      delegations.commitResult({
        attemptId: id,
        content,
        appliedEventId: `event-${id}`,
        updatedAt: createdAt,
      }),
    );
  return {
    sql,
    config,
    delegations,
    bindings,
    artifacts,
    experts,
    expert,
    snapshot,
    workRoot,
    code,
    files,
    content,
    resultHash,
    prepare,
    commit,
  };
});

const shell = Schema.decodeUnknownSync(OrchestrationThreadShell)({
  id: "parent",
  projectId: "project",
  title: "Parent",
  modelSelection: { provider: "omp", model: "fixture" },
  runtimeMode: "full-access",
  branch: null,
  worktreePath: null,
  latestTurn: null,
  createdAt,
  updatedAt: createdAt,
  session: null,
});
const context: ToolContext = {
  principal: {
    kind: "provider-session",
    sessionKey: "trusted",
    threadId: "parent",
    provider: "omp",
    turnId: null,
  },
  callerThreadId: "parent",
  callerThreadLabel: "Parent",
  callerSessionKey: "trusted",
  callerProvider: "omp",
  callerCapabilities: new Set(["thread:read"]),
  callerTurnId: null,
  assertCallerTurnActive: () => Effect.void,
  jsonRpcRequestId: 1,
};

describe("C6 artifact byte versions", () => {
  it("recovers only its own verified preparation, retaining original bytes and canonical receipt after source changes", () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* fixture;
          yield* f.prepare("one");
          const prepared = yield* f.artifacts.prepare({
            attemptId: "one",
            resultHash: f.resultHash,
            workRoot: f.workRoot,
            artifacts: f.files,
          });
          expect(prepared.packageId).toMatch(/^res_[a-f0-9]{64}$/u);
          yield* Effect.promise(() =>
            fs.writeFile(path.join(f.workRoot, "result.ts"), "changed source"),
          );
          const recovered = yield* makeExpertDelegationArtifacts.pipe(
            Effect.provideService(ExpertDelegationStore, f.delegations),
          );
          expect(
            yield* recovered.prepare({
              attemptId: "one",
              resultHash: f.resultHash,
              workRoot: path.join(f.workRoot, "missing"),
              artifacts: f.files,
            }),
          ).toEqual(prepared);
          const receipt = yield* f.commit("one");
          const result = yield* recovered.read({ attemptId: "one", artifactPath: "result.ts" });
          expect(result.receipt).toEqual(receipt);
          expect(Buffer.from(result.artifact!.content, "base64")).toEqual(f.code);
          const repeat = yield* f.commit("one");
          expect(repeat).toEqual(receipt);
          expect(
            yield* recovered
              .prepare({
                attemptId: "one",
                resultHash: "f".repeat(64),
                workRoot: f.workRoot,
                artifacts: f.files,
              })
              .pipe(Effect.flip),
          ).toMatchObject({ code: "result_conflict" });
          expect(
            yield* recovered
              .prepare({
                attemptId: "one",
                resultHash: f.resultHash,
                workRoot: f.workRoot,
                artifacts: [{ ...f.files[0]!, path: "other" }],
              })
              .pipe(Effect.flip),
          ).toMatchObject({ code: "result_conflict" });
          // Existing global pool bytes do not authorize another attempt's first capture.
          yield* f.prepare("two");
          yield* f.artifacts
            .prepare({
              attemptId: "two",
              resultHash: f.resultHash,
              workRoot: f.workRoot,
              artifacts: f.files,
            })
            .pipe(Effect.flip);
          const rows =
            yield* f.sql`SELECT * FROM expert_delegation_artifact_versions WHERE attempt_id = 'two'`;
          expect(rows).toHaveLength(0);
          yield* recovered.read({ attemptId: "one", artifactPath: "../escape" }).pipe(Effect.flip);
          yield* f.sql`UPDATE expert_delegation_artifact_versions SET result_hash = ${"0".repeat(64)} WHERE attempt_id = 'one'`;
          yield* recovered.read({ attemptId: "one" }).pipe(Effect.flip);
        }),
      ).pipe(Effect.provide(environment)),
    ));

  it("reads actual author/attempt/result versions only in the real caller's parent scope", () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* fixture;
          for (const [id, parent, author] of [
            ["own", "parent", f.expert.id],
            ["foreign", "foreign-parent", f.expert.id],
            ["false-author", "parent", "other-expert"],
          ] as const) {
            yield* f.prepare(id, parent, author);
            yield* f.artifacts.prepare({
              attemptId: id,
              resultHash: f.resultHash,
              workRoot: f.workRoot,
              artifacts: f.files,
            });
            yield* f.commit(id);
          }
          const [tool] = makeExpertDelegationResultTools({
            stateDir: f.config.stateDir,
            artifacts: f.artifacts,
            delegations: f.delegations,
            bindings: f.bindings,
            requireThreadShell: () => Effect.succeed(shell),
          });
          const result = yield* tool!.handler(
            { resultRef: "ndr_own", artifactPath: "result.ts" },
            context,
          );
          expect(result.isError).not.toBe(true);
          const text = result.content[0];
          if (text?.type !== "text") throw new Error("Expected JSON receipt");
          expect(JSON.parse(text.text)).toMatchObject({
            author: { expertId: f.expert.id, snapshotId: f.snapshot.snapshotId },
            receipt: { attemptId: "own", resultRef: "ndr_own", resultHash: f.resultHash },
            artifact: { content: f.code.toString("base64") },
          });
          for (const resultRef of [
            "ndr_foreign",
            "ndr_false-author",
            "ndr_forged",
            "res_" + "0".repeat(64),
          ])
            expect((yield* tool!.handler({ resultRef }, context)).isError).toBe(true);
          expect(
            (yield* tool!.handler({ resultRef: "ndr_own", artifactPath: "not-declared" }, context))
              .isError,
          ).toBe(true);
          expect(
            (yield* tool!.handler(
              { resultRef: "ndr_own" },
              { ...context, callerThreadId: "foreign-parent" },
            )).isError,
          ).toBe(true);
          const foreignRun = {
            executionBindingId: "execution-reader",
            attemptId: "reader",
            capabilityBindingId: "binding-reader",
            assemblyId: "assembly-reader",
            parentRootRunId: "another-parent-run",
          };
          expect(
            (yield* tool!.handler(
              { resultRef: "ndr_own" },
              {
                ...context,
                nativeExecution: foreignRun,
                principal: {
                  ...context.principal,
                  kind: "native-delegate",
                  nativeExecution: foreignRun,
                },
              },
            )).isError,
          ).toBe(true);
        }),
      ).pipe(Effect.provide(environment)),
    ));

  it("keeps no-file results in the original ledger without inventing a resource reference", () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* fixture;
          yield* f.prepare("no-files");
          const content = {
            outcome: "completed" as const,
            result: { summary: "Analysis only", artifacts: [] },
            issue: null,
          };
          const resultHash = suiteContentDigest(content);
          expect(
            yield* f.artifacts.prepare({
              attemptId: "no-files",
              resultHash,
              workRoot: path.join(f.workRoot, "absent"),
              artifacts: [],
            }),
          ).toEqual({ packageId: null });
          const receipt = yield* f.sql.withTransaction(
            f.delegations.commitResult({
              attemptId: "no-files",
              content,
              appliedEventId: "no-files-event",
              updatedAt: createdAt,
            }),
          );
          expect(yield* f.artifacts.read({ attemptId: "no-files" })).toEqual({
            receipt,
            packageId: null,
            artifact: null,
          });
          const rows =
            yield* f.sql`SELECT * FROM expert_delegation_artifact_versions WHERE attempt_id = 'no-files'`;
          expect(rows).toHaveLength(0);
          yield* f.artifacts
            .read({ attemptId: "no-files", artifactPath: "invented.ts" })
            .pipe(Effect.flip);
          yield* f.artifacts
            .prepare({ attemptId: "missing", resultHash, workRoot: f.workRoot, artifacts: [] })
            .pipe(Effect.flip);
        }),
      ).pipe(Effect.provide(environment)),
    ));
});
