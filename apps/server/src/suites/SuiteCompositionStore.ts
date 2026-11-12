import {
  CapabilityBinding,
  ExpertSaveInput,
  SuiteComposition,
  SuiteContentHash,
  SuiteImportReceipt,
  SuiteImportRequest,
  SuiteIssue,
  SuiteName,
  SuitePath,
  SuiteRequestId,
  type SuiteRef,
  type SuiteSummary,
} from "@synara/contracts";
import { Effect, Layer, Schema, ServiceMap } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ServerConfig } from "../config";
import { installExpertImportPublicationReader } from "./SuitePublicationHost";
import { canonicalSuiteJson, suiteContentDigest } from "./suiteIdentity";

/** Recovery intent, not a second live Expert definition or asset owner. */
export const SuiteImportPlan = Schema.Struct({
  planId: SuiteRequestId,
  creatorOperationId: SuiteRequestId,
  sourceKey: SuiteContentHash,
  sourceRoot: SuitePath,
  composition: SuiteComposition,
  experts: Schema.Array(
    Schema.Struct({
      key: SuiteName,
      expertId: SuitePath,
      definition: Schema.NullOr(ExpertSaveInput),
      bmadRole: Schema.NullOr(SuiteName),
      roleSourceRoot: Schema.NullOr(SuitePath),
      identityAvailable: Schema.Boolean,
    }),
  ).check(Schema.isMaxLength(5_000)),
  assets: Schema.Array(
    Schema.Struct({
      key: SuiteName,
      kind: Schema.Literals(["skill", "files"]),
      rootPath: SuitePath,
      packageId: SuitePath,
    }),
  ).check(Schema.isMaxLength(5_000)),
  fileResourceRevisions: Schema.Array(
    Schema.Struct({
      resourceId: SuitePath,
      revision: Schema.Int.check(Schema.isGreaterThan(0)),
      packageId: SuitePath,
    }),
  ).check(Schema.isMaxLength(5_000)),
  issues: Schema.Array(SuiteIssue).check(Schema.isMaxLength(200)),
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type SuiteImportPlan = typeof SuiteImportPlan.Type;

export class SuiteStoreError extends Error {
  constructor(
    message: string,
    readonly code: SuiteIssue["code"],
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "SuiteStoreError";
  }
}
const storageError = (cause: unknown): SuiteStoreError =>
  cause instanceof SuiteStoreError
    ? cause
    : new SuiteStoreError("Suite storage is unavailable.", "commit_failed", { cause });
const conflict = () =>
  new SuiteStoreError(
    "This operation already belongs to a different request.",
    "revision_conflict",
  );
const guarded = <A>(effect: Effect.Effect<A, unknown>): Effect.Effect<A, SuiteStoreError> =>
  effect.pipe(Effect.mapError(storageError));
const checked = <A>(action: () => A): Effect.Effect<A, SuiteStoreError> =>
  Effect.try({ try: action, catch: storageError });

export function suiteCompositionFingerprint(composition: SuiteComposition): string {
  const { compositionHash: _hash, createdAt: _time, ...content } = composition;
  return suiteContentDigest(content);
}
export function capabilityBindingFingerprint(binding: CapabilityBinding): string {
  return suiteContentDigest({
    suite: binding.suite,
    purpose: binding.purpose,
    projectId: binding.projectId,
    connections: binding.connections,
    mcpBinding: binding.mcpBinding,
  });
}
export function suiteImportSourceKey(composition: SuiteComposition): string {
  return suiteContentDigest({
    sourceId: composition.source.sourceId,
    contentHash: composition.source.contentHash,
    adapterId: composition.adapterId,
    adapterVersion: composition.adapterVersion,
  });
}
function decodeComposition(value: unknown): SuiteComposition {
  const composition = Schema.decodeUnknownSync(SuiteComposition)(value);
  if (suiteCompositionFingerprint(composition) !== composition.compositionHash)
    throw new SuiteStoreError("Suite composition content is corrupt.", "resource_corrupt");
  const keys = new Set<string>();
  for (const member of composition.members) {
    if (keys.has(member.key))
      throw new SuiteStoreError("Suite member keys conflict.", "invalid_manifest");
    keys.add(member.key);
  }
  return composition;
}
function decodePlan(value: unknown): SuiteImportPlan {
  const plan = Schema.decodeUnknownSync(SuiteImportPlan)(value);
  decodeComposition(plan.composition);
  if (plan.sourceKey !== suiteImportSourceKey(plan.composition))
    throw new SuiteStoreError("Suite import identity is corrupt.", "resource_corrupt");
  const members = new Map(plan.composition.members.map((member) => [member.key, member.expertId]));
  const seen = new Set<string>();
  for (const expert of plan.experts) {
    if (
      seen.has(expert.key) ||
      members.get(expert.key) !== expert.expertId ||
      (expert.definition !== null && expert.definition.id !== expert.expertId)
    )
      throw new SuiteStoreError("Suite import member identity conflicts.", "resource_corrupt");
    seen.add(expert.key);
  }
  if (seen.size !== members.size)
    throw new SuiteStoreError("Suite import members are incomplete.", "resource_corrupt");
  return plan;
}

type PlanRow = {
  readonly planId: string;
  readonly sourceKey: string;
  readonly state: "pending" | "committed";
  readonly planJson: string;
  readonly resultJson: string | null;
};
type StoredPlan = { readonly plan: SuiteImportPlan; readonly result: SuiteImportReceipt | null };
type OperationRow = {
  readonly requestHash: string;
  readonly planId: string | null;
  readonly rejectedIssueJson: string | null;
};
export interface SuiteImportAdmission {
  readonly plan: SuiteImportPlan | null;
  readonly receipt: SuiteImportReceipt;
}
export interface SuiteCompositionStoreShape {
  readonly list: () => Effect.Effect<readonly SuiteSummary[], SuiteStoreError>;
  readonly read: (ref: SuiteRef) => Effect.Effect<SuiteComposition | null, SuiteStoreError>;
  readonly readIssues: (ref: SuiteRef) => Effect.Effect<readonly SuiteIssue[], SuiteStoreError>;
  readonly scanSkillReferences: (
    packageId: string,
  ) => Effect.Effect<readonly string[], SuiteStoreError>;
  readonly referencedFilePackages: () => Effect.Effect<readonly string[], SuiteStoreError>;
  readonly publishedSkillPackages: (
    ref: SuiteRef,
  ) => Effect.Effect<ReadonlySet<string>, SuiteStoreError>;
  readonly findImport: (
    operationId: string,
  ) => Effect.Effect<SuiteImportPlan | null, SuiteStoreError>;
  readonly getImportReceipt: (
    operationId: string,
  ) => Effect.Effect<SuiteImportReceipt | null, SuiteStoreError>;
  readonly beginImport: (
    request: SuiteImportRequest,
    requestHash: string,
    plan: SuiteImportPlan,
  ) => Effect.Effect<SuiteImportAdmission, SuiteStoreError>;
  readonly rejectImport: (
    operationId: string,
    requestHash: string,
    issue: SuiteIssue,
  ) => Effect.Effect<SuiteImportReceipt, SuiteStoreError>;
  readonly completeImport: (planId: string) => Effect.Effect<void, SuiteStoreError>;
  readonly recordImportIssue: (
    planId: string,
    issue: SuiteIssue,
  ) => Effect.Effect<void, SuiteStoreError>;
  readonly pendingImports: () => Effect.Effect<readonly SuiteImportPlan[], SuiteStoreError>;
  readonly isPlanCommitted: (planId: string) => Effect.Effect<boolean, SuiteStoreError>;
  readonly saveBinding: (
    binding: CapabilityBinding,
  ) => Effect.Effect<CapabilityBinding, SuiteStoreError>;
  readonly readBinding: (
    bindingId: string,
  ) => Effect.Effect<CapabilityBinding | null, SuiteStoreError>;
  readonly readFileRevision: (
    resourceId: string,
    revision?: number,
  ) => Effect.Effect<
    { readonly revision: number; readonly packageId: string } | null,
    SuiteStoreError
  >;
}
export class SuiteCompositionStore extends ServiceMap.Service<
  SuiteCompositionStore,
  SuiteCompositionStoreShape
>()("synara/suites/SuiteCompositionStore") {}

export const makeSuiteCompositionStore = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const decodeStoredPlan = (row: PlanRow): StoredPlan => {
    const plan = decodePlan(JSON.parse(row.planJson));
    if (plan.planId !== row.planId || plan.sourceKey !== row.sourceKey)
      throw new SuiteStoreError("Suite import journal fields disagree.", "resource_corrupt");
    const result =
      row.resultJson === null
        ? null
        : Schema.decodeUnknownSync(SuiteImportReceipt)(JSON.parse(row.resultJson));
    if (
      (row.state === "pending" && result !== null) ||
      (row.state === "committed" &&
        (result?.state !== "committed" ||
          result.operationId !== plan.creatorOperationId ||
          canonicalSuiteJson(result.suite) !== canonicalSuiteJson(plan.composition.ref)))
    )
      throw new SuiteStoreError("Suite import publication receipt is corrupt.", "resource_corrupt");
    return { plan, result };
  };
  const readPlan = (planId: string) =>
    guarded(
      Effect.gen(function* () {
        const [row] =
          yield* sql<PlanRow>`SELECT plan_id AS "planId", source_key AS "sourceKey", state,
      plan_json AS "planJson", result_json AS "resultJson" FROM suite_import_plans WHERE plan_id = ${planId}`;
        return row ? yield* checked(() => decodeStoredPlan(row)) : null;
      }),
    );
  const readOperation = (
    operationId: string,
  ) => sql<OperationRow>`SELECT request_hash AS "requestHash",
    plan_id AS "planId", rejected_issue_json AS "rejectedIssueJson" FROM suite_import_operations WHERE operation_id = ${operationId}`;
  const receiptFor = (operationId: string, operation: OperationRow) =>
    guarded(
      Effect.gen(function* () {
        if (operation.planId === null) {
          if (operation.rejectedIssueJson === null)
            return yield* Effect.fail(storageError("Missing import rejection."));
          const issue = yield* checked(() =>
            Schema.decodeUnknownSync(SuiteIssue)(JSON.parse(operation.rejectedIssueJson!)),
          );
          return {
            operationId,
            requestHash: operation.requestHash,
            state: "failed" as const,
            issue,
          };
        }
        const stored = yield* readPlan(operation.planId);
        if (!stored) return yield* Effect.fail(storageError("Missing import plan."));
        if (stored.result?.state === "committed")
          return {
            operationId,
            requestHash: operation.requestHash,
            state: "committed" as const,
            suite: stored.result.suite,
            reused: operationId !== stored.plan.creatorOperationId,
          };
        return { operationId, requestHash: operation.requestHash, state: "pending" as const };
      }),
    );
  const getImportReceipt = (operationId: string) =>
    guarded(
      Effect.gen(function* () {
        const [operation] = yield* readOperation(operationId);
        return operation ? yield* receiptFor(operationId, operation) : null;
      }),
    );
  const read: SuiteCompositionStoreShape["read"] = (ref) =>
    guarded(
      Effect.gen(function* () {
        const [row] = yield* sql<{ readonly hash: string; readonly recordJson: string }>`SELECT
      composition_hash AS hash, record_json AS "recordJson" FROM suite_compositions
      WHERE suite_id = ${ref.suiteId} AND revision = ${ref.revision}`;
        if (!row) return null;
        const composition = yield* checked(() => decodeComposition(JSON.parse(row.recordJson)));
        if (
          composition.ref.suiteId !== ref.suiteId ||
          composition.ref.revision !== ref.revision ||
          composition.compositionHash !== row.hash
        )
          return yield* Effect.fail(
            new SuiteStoreError("Suite revision fields disagree.", "resource_corrupt"),
          );
        return composition;
      }),
    );
  const rejectImport: SuiteCompositionStoreShape["rejectImport"] = (
    operationId,
    requestHash,
    issue,
  ) =>
    guarded(
      sql.withTransaction(
        Effect.gen(function* () {
          const [existing] = yield* readOperation(operationId);
          if (existing) {
            if (existing.requestHash !== requestHash) return yield* Effect.fail(conflict());
            return yield* receiptFor(operationId, existing);
          }
          const verified = yield* checked(() => Schema.decodeUnknownSync(SuiteIssue)(issue));
          yield* sql`INSERT INTO suite_import_operations(operation_id, request_hash, plan_id, rejected_issue_json)
      VALUES (${operationId}, ${requestHash}, NULL, ${canonicalSuiteJson(verified)})`;
          return { operationId, requestHash, state: "failed" as const, issue: verified };
        }),
      ),
    );
  const store: SuiteCompositionStoreShape = {
    read,
    readIssues: (ref) =>
      guarded(
        Effect.gen(function* () {
          const composition = yield* read(ref);
          if (!composition)
            return yield* Effect.fail(
              new SuiteStoreError("Selected Suite is missing.", "suite_missing"),
            );
          const [row] =
            yield* sql<PlanRow>`SELECT plan_id AS "planId", source_key AS "sourceKey", state,
        plan_json AS "planJson", result_json AS "resultJson" FROM suite_import_plans WHERE state = 'committed'
        AND json_extract(plan_json, '$.composition.ref.suiteId') = ${ref.suiteId}
        AND json_extract(plan_json, '$.composition.ref.revision') = ${ref.revision}`;
          if (!row)
            return yield* Effect.fail(
              new SuiteStoreError("Suite source diagnostics are unavailable.", "resource_corrupt"),
            );
          const { plan } = yield* checked(() => decodeStoredPlan(row));
          if (plan.composition.compositionHash !== composition.compositionHash)
            return yield* Effect.fail(
              new SuiteStoreError("Suite source identity is inconsistent.", "resource_corrupt"),
            );
          return plan.issues;
        }),
      ),
    scanSkillReferences: (packageId) =>
      guarded(
        Effect.gen(function* () {
          const rows =
            yield* sql<PlanRow>`SELECT plan_id AS "planId", source_key AS "sourceKey", state,
        plan_json AS "planJson", result_json AS "resultJson" FROM suite_import_plans ORDER BY plan_id`;
          return yield* checked(() =>
            rows.flatMap((row) => {
              const { plan } = decodeStoredPlan(row);
              const pinned =
                plan.assets.some(
                  (asset) => asset.kind === "skill" && asset.packageId === packageId,
                ) ||
                plan.composition.resources.some(
                  (use) => use.ref.kind === "skill" && use.ref.selection.packageId === packageId,
                );
              return pinned
                ? [
                    `Suite ${plan.composition.name} (${plan.composition.ref.suiteId}), revision ${plan.composition.ref.revision}${row.state === "pending" ? ", pending import" : ""}`,
                  ]
                : [];
            }),
          );
        }),
      ),
    publishedSkillPackages: (ref) =>
      guarded(
        Effect.gen(function* () {
          const rows = yield* sql<PlanRow>`SELECT plan_id AS "planId", source_key AS "sourceKey",
            state, plan_json AS "planJson", result_json AS "resultJson"
            FROM suite_import_plans WHERE state = 'committed'
              AND json_extract(plan_json, '$.composition.ref.suiteId') = ${ref.suiteId}
              AND json_extract(plan_json, '$.composition.ref.revision') = ${ref.revision}`;
          return yield* checked(
            () =>
              new Set(
                rows.flatMap((row) =>
                  decodeStoredPlan(row)
                    .plan.assets.filter((asset) => asset.kind === "skill")
                    .map((asset) => asset.packageId),
                ),
              ),
          );
        }),
      ),
    referencedFilePackages: () =>
      guarded(
        Effect.gen(function* () {
          const rows =
            yield* sql<PlanRow>`SELECT plan_id AS "planId", source_key AS "sourceKey", state,
        plan_json AS "planJson", result_json AS "resultJson" FROM suite_import_plans ORDER BY plan_id`;
          const references = yield* sql<{
            readonly packageId: string;
          }>`SELECT package_id AS "packageId"
        FROM suite_resource_revisions`;
          return yield* checked(() => {
            const packages = new Set(references.map((row) => row.packageId));
            for (const row of rows) {
              const { plan } = decodeStoredPlan(row);
              packages.add(`res_${plan.composition.source.contentHash}`);
              for (const asset of plan.assets)
                if (asset.kind === "files") packages.add(asset.packageId);
              for (const resource of plan.fileResourceRevisions) packages.add(resource.packageId);
            }
            return [...packages];
          });
        }),
      ),
    getImportReceipt,
    rejectImport,
    list: () =>
      guarded(
        Effect.gen(function* () {
          const rows = yield* sql<{ readonly recordJson: string; readonly hash: string }>`SELECT
        record_json AS "recordJson", composition_hash AS hash FROM suite_compositions ORDER BY suite_id, revision`;
          return yield* checked(() =>
            rows.map((row) => {
              const value = decodeComposition(JSON.parse(row.recordJson));
              if (value.compositionHash !== row.hash)
                throw new SuiteStoreError("Suite content fields disagree.", "resource_corrupt");
              return { ref: value.ref, name: value.name, description: value.description };
            }),
          );
        }),
      ),
    findImport: (operationId) =>
      guarded(
        Effect.gen(function* () {
          const [operation] = yield* readOperation(operationId);
          return operation?.planId ? ((yield* readPlan(operation.planId))?.plan ?? null) : null;
        }),
      ),
    beginImport: (request, requestHash, proposed) =>
      guarded(
        sql.withTransaction(
          Effect.gen(function* () {
            const [existing] = yield* readOperation(request.operationId);
            if (existing) {
              if (existing.requestHash !== requestHash) return yield* Effect.fail(conflict());
              return {
                plan: existing.planId ? ((yield* readPlan(existing.planId))?.plan ?? null) : null,
                receipt: yield* receiptFor(request.operationId, existing),
              };
            }
            const candidate = yield* checked(() => decodePlan(proposed));
            if (
              candidate.creatorOperationId !== request.operationId ||
              candidate.composition.source.contentHash !== request.contentHash
            )
              return yield* Effect.fail(conflict());
            const [sameSource] =
              yield* sql<PlanRow>`SELECT plan_id AS "planId", source_key AS "sourceKey", state,
        plan_json AS "planJson", result_json AS "resultJson" FROM suite_import_plans WHERE source_key = ${candidate.sourceKey}`;
            let selected: StoredPlan;
            if (sameSource) selected = yield* checked(() => decodeStoredPlan(sameSource));
            else {
              if (request.mode === "reuse-or-create") {
                const [previous] = yield* sql<{
                  readonly found: number;
                }>`SELECT 1 AS found FROM suite_import_plans
            WHERE json_extract(plan_json, '$.composition.source.sourceId') = ${candidate.composition.source.sourceId}
              AND json_extract(plan_json, '$.composition.source.contentHash') <> ${request.contentHash} LIMIT 1`;
                if (previous) {
                  const issue: SuiteIssue = {
                    code: "content_changed",
                    category: "source",
                    subject: {
                      kind: "suite",
                      id: candidate.composition.source.sourceId,
                      path: null,
                    },
                    action: "commit",
                    effect: "deny-action",
                    message:
                      "This source has another content baseline. Explicitly import it as a new Suite.",
                    evidenceRef: null,
                    checkedAt: new Date().toISOString(),
                    recovery: "choose-alternative",
                  };
                  yield* sql`INSERT INTO suite_import_operations(operation_id, request_hash, plan_id, rejected_issue_json)
              VALUES (${request.operationId}, ${requestHash}, NULL, ${canonicalSuiteJson(issue)})`;
                  return {
                    plan: null,
                    receipt: {
                      operationId: request.operationId,
                      requestHash,
                      state: "failed" as const,
                      issue,
                    },
                  };
                }
              }
              yield* sql`INSERT INTO suite_import_plans(plan_id, source_key, state, plan_json, result_json)
          VALUES (${candidate.planId}, ${candidate.sourceKey}, 'pending', ${canonicalSuiteJson(candidate)}, NULL)`;
              selected = { plan: candidate, result: null };
            }
            // Always persist B's own hash and mapping before projecting A's existing plan.
            yield* sql`INSERT INTO suite_import_operations(operation_id, request_hash, plan_id, rejected_issue_json)
        VALUES (${request.operationId}, ${requestHash}, ${selected.plan.planId}, NULL)`;
            return {
              plan: selected.plan,
              receipt: yield* getImportReceipt(request.operationId).pipe(
                Effect.map((receipt) => receipt!),
              ),
            };
          }),
        ),
      ),
    completeImport: (planId) =>
      guarded(
        sql.withTransaction(
          Effect.gen(function* () {
            const stored = yield* readPlan(planId);
            if (!stored)
              return yield* Effect.fail(
                new SuiteStoreError("Suite import plan is missing.", "commit_failed"),
              );
            const plan = stored.plan;
            if (stored.result?.state === "committed") return;
            const composition = plan.composition;
            const existing = yield* read(composition.ref);
            if (existing && existing.compositionHash !== composition.compositionHash)
              return yield* Effect.fail(conflict());
            if (!existing)
              yield* sql`INSERT INTO suite_compositions(suite_id, revision, composition_hash, record_json)
        VALUES (${composition.ref.suiteId}, ${composition.ref.revision}, ${composition.compositionHash}, ${canonicalSuiteJson(composition)})`;
            for (const resource of plan.fileResourceRevisions) {
              yield* sql`INSERT OR IGNORE INTO suite_resource_revisions(resource_id, revision, package_id)
          VALUES (${resource.resourceId}, ${resource.revision}, ${resource.packageId})`;
              const [actual] = yield* sql<{
                readonly packageId: string;
              }>`SELECT package_id AS "packageId"
          FROM suite_resource_revisions WHERE resource_id = ${resource.resourceId} AND revision = ${resource.revision}`;
              if (actual?.packageId !== resource.packageId) return yield* Effect.fail(conflict());
            }
            const [creator] = yield* readOperation(plan.creatorOperationId);
            if (creator?.planId !== planId)
              return yield* Effect.fail(storageError("Import creator mapping is missing."));
            const result: SuiteImportReceipt = {
              operationId: plan.creatorOperationId,
              requestHash: creator.requestHash,
              state: "committed",
              suite: composition.ref,
              reused: false,
            };
            yield* sql`UPDATE suite_import_plans SET state = 'committed', result_json = ${canonicalSuiteJson(result)}, last_issue_json = NULL
        WHERE plan_id = ${planId} AND state = 'pending'`;
          }),
        ),
      ),
    recordImportIssue: (planId, issue) =>
      guarded(
        Effect.gen(function* () {
          const verified = yield* checked(() => Schema.decodeUnknownSync(SuiteIssue)(issue));
          yield* sql`UPDATE suite_import_plans SET last_issue_json = ${canonicalSuiteJson(verified)} WHERE plan_id = ${planId} AND state = 'pending'`;
        }),
      ),
    pendingImports: () =>
      guarded(
        Effect.gen(function* () {
          const rows =
            yield* sql<PlanRow>`SELECT plan_id AS "planId", source_key AS "sourceKey", state,
        plan_json AS "planJson", result_json AS "resultJson" FROM suite_import_plans WHERE state = 'pending' ORDER BY plan_id`;
          return yield* checked(() => rows.map((row) => decodeStoredPlan(row).plan));
        }),
      ),
    isPlanCommitted: (planId) =>
      guarded(
        Effect.gen(function* () {
          const [row] = yield* sql<{
            readonly state: string;
          }>`SELECT state FROM suite_import_plans WHERE plan_id = ${planId}`;
          return row?.state === "committed";
        }),
      ),
    readBinding: (bindingId) =>
      guarded(
        Effect.gen(function* () {
          const [row] = yield* sql<{
            readonly hash: string;
            readonly recordJson: string;
          }>`SELECT binding_hash AS hash,
        record_json AS "recordJson" FROM suite_capability_bindings WHERE binding_id = ${bindingId}`;
          if (!row) return null;
          const binding = yield* checked(() =>
            Schema.decodeUnknownSync(CapabilityBinding)(JSON.parse(row.recordJson)),
          );
          if (
            binding.bindingId !== bindingId ||
            binding.bindingHash !== row.hash ||
            capabilityBindingFingerprint(binding) !== binding.bindingHash
          )
            return yield* Effect.fail(
              new SuiteStoreError("Capability binding content is corrupt.", "resource_corrupt"),
            );
          return binding;
        }),
      ),
    saveBinding: (input) =>
      guarded(
        sql.withTransaction(
          Effect.gen(function* () {
            const binding = yield* checked(() =>
              Schema.decodeUnknownSync(CapabilityBinding)(input),
            );
            if (capabilityBindingFingerprint(binding) !== binding.bindingHash)
              return yield* Effect.fail(
                new SuiteStoreError(
                  "Capability binding identity does not match.",
                  "resource_corrupt",
                ),
              );
            if (binding.suite && !(yield* read(binding.suite)))
              return yield* Effect.fail(
                new SuiteStoreError("Selected Suite is missing.", "suite_missing"),
              );
            const old = yield* store.readBinding(binding.bindingId);
            if (old) {
              if (canonicalSuiteJson(old) !== canonicalSuiteJson(binding))
                return yield* Effect.fail(conflict());
              return old;
            }
            yield* sql`INSERT INTO suite_capability_bindings(binding_id, binding_hash, record_json)
        VALUES (${binding.bindingId}, ${binding.bindingHash}, ${canonicalSuiteJson(binding)})`;
            return binding;
          }),
        ),
      ),
    readFileRevision: (resourceId, revision) =>
      guarded(
        Effect.gen(function* () {
          const rows =
            revision === undefined
              ? yield* sql<{
                  readonly revision: number;
                  readonly packageId: string;
                }>`SELECT revision, package_id AS "packageId"
            FROM suite_resource_revisions WHERE resource_id = ${resourceId} ORDER BY revision DESC LIMIT 1`
              : yield* sql<{
                  readonly revision: number;
                  readonly packageId: string;
                }>`SELECT revision, package_id AS "packageId"
            FROM suite_resource_revisions WHERE resource_id = ${resourceId} AND revision = ${revision}`;
          return rows[0] ?? null;
        }),
      ),
  };
  return store;
});

export const SuiteCompositionStoreLive = Layer.effect(
  SuiteCompositionStore,
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const store = yield* makeSuiteCompositionStore;
    const remove = yield* Effect.tryPromise(() =>
      installExpertImportPublicationReader(
        config.stateDir,
        (planId) => Effect.runPromise(store.isPlanCommitted(planId)),
        (packageId) => Effect.runPromise(store.scanSkillReferences(packageId)),
      ),
    );
    yield* Effect.addFinalizer(() => Effect.sync(remove));
    return store;
  }),
);
