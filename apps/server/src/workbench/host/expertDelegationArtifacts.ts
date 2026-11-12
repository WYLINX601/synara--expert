import { createHash } from "node:crypto";
import * as path from "node:path";
import { ExpertDelegationResult, SuiteContentHash } from "@synara/contracts";
import { Effect, Exit, Layer, Schema, ServiceMap } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ServerConfig } from "../../config";
import { canonicalSuiteJson, suiteContentDigest } from "../../suites/suiteIdentity";
import {
  ExpertDelegationStore,
  ExpertDelegationStoreError,
  type StoredExpertDelegationResult,
} from "./expertDelegationStore";
import {
  artifactFileResourceManifest,
  createFileResourceStore,
} from "../../experts/FileResourceStore";
import { expertResourceFiles } from "../../experts/ExpertStore";
import { withSkillPackageLifecycle } from "../../experts/skillPackageLifecycle";

export interface ExpertDelegationArtifactRead {
  readonly receipt: StoredExpertDelegationResult;
  readonly packageId: string | null;
  readonly artifact: {
    readonly path: string;
    readonly sha256: string;
    readonly size: number;
    readonly encoding: "base64";
    readonly content: string;
  } | null;
}
export interface ExpertDelegationArtifactsShape {
  readonly referencedPackages: Effect.Effect<ReadonlySet<string>, ExpertDelegationStoreError>;
  readonly prepare: (input: {
    readonly attemptId: string;
    readonly resultHash: string;
    readonly workRoot: string;
    readonly artifacts: ExpertDelegationResult["artifacts"];
  }) => Effect.Effect<{ readonly packageId: string | null }, ExpertDelegationStoreError>;
  readonly read: (input: {
    readonly attemptId: string;
    readonly artifactPath?: string;
  }) => Effect.Effect<ExpertDelegationArtifactRead, ExpertDelegationStoreError>;
}
export class ExpertDelegationArtifacts extends ServiceMap.Service<
  ExpertDelegationArtifacts,
  ExpertDelegationArtifactsShape
>()("synara/experts/ExpertDelegationArtifacts") {}
const corrupt = () =>
  new ExpertDelegationStoreError(
    "Artifact version identity or bytes are inconsistent.",
    "resource_corrupt",
  );
const conflict = () =>
  new ExpertDelegationStoreError(
    "Artifact preparation conflicts with the recorded result version.",
    "result_conflict",
  );
const guarded = <A>(
  effect: Effect.Effect<A, unknown>,
): Effect.Effect<A, ExpertDelegationStoreError> =>
  effect.pipe(
    Effect.mapError((cause) =>
      cause instanceof ExpertDelegationStoreError
        ? cause
        : new ExpertDelegationStoreError(
            "Artifact version preparation or reading failed.",
            "resource_corrupt",
            { cause },
          ),
    ),
  );

export const makeExpertDelegationArtifacts = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const config = yield* ServerConfig;
  const delegations = yield* ExpertDelegationStore;
  const files = createFileResourceStore(config.stateDir);
  const readVersion = (attemptId: string) =>
    sql<{
      readonly resultHash: string;
      readonly packageId: string;
    }>`SELECT result_hash AS "resultHash", package_id AS "packageId" FROM expert_delegation_artifact_versions WHERE attempt_id = ${attemptId}`;
  const verify = (packageId: string, artifacts: ExpertDelegationResult["artifacts"]) =>
    Effect.tryPromise(async () => {
      const sealed = await files.read(packageId);
      if (
        canonicalSuiteJson(sealed.resources) !==
        canonicalSuiteJson(artifactFileResourceManifest(artifacts))
      )
        throw corrupt();
      return sealed;
    });
  const service: ExpertDelegationArtifactsShape = {
    referencedPackages: guarded(
      sql<{
        readonly packageId: string;
      }>`SELECT DISTINCT package_id AS "packageId" FROM expert_delegation_artifact_versions`.pipe(
        Effect.map((rows) => new Set(rows.map((row) => row.packageId))),
      ),
    ),
    prepare: (input) =>
      guarded(
        Effect.gen(function* () {
          const expected = yield* Effect.try({
            try: () => {
              Schema.decodeUnknownSync(SuiteContentHash)(input.resultHash);
              const artifacts = Schema.decodeUnknownSync(ExpertDelegationResult)({
                summary: "",
                artifacts: input.artifacts,
              }).artifacts;
              const resources = artifactFileResourceManifest(artifacts);
              return {
                artifacts,
                packageId: artifacts.length
                  ? `res_${suiteContentDigest({ schemaVersion: 1, resources })}`
                  : null,
              };
            },
            catch: (cause) => cause,
          });
          const attempt = yield* delegations.readAttempt(input.attemptId);
          if (!attempt)
            return yield* Effect.fail(
              new ExpertDelegationStoreError(
                "Artifact attempt is unavailable.",
                "execution_unknown",
              ),
            );
          if (attempt.resultHash !== null && attempt.resultHash !== input.resultHash)
            return yield* Effect.fail(conflict());
          const [old] = yield* readVersion(input.attemptId);
          if (old) {
            if (old.resultHash !== input.resultHash || old.packageId !== expected.packageId)
              return yield* Effect.fail(conflict());
            yield* verify(old.packageId, expected.artifacts);
            return { packageId: old.packageId };
          }
          if (!expected.packageId) return { packageId: null };
          // No global hash lookup grants first-capture authority. Only this attempt's
          // durable verified preparation can bypass the original authorized root.
          const captured = yield* Effect.tryPromise({
            try: (signal) =>
              withSkillPackageLifecycle(config.stateDir, () =>
                Effect.runPromiseExit(
                  Effect.gen(function* () {
                    const sealed = yield* Effect.tryPromise(() =>
                      files.sealFiles(input.workRoot, expected.artifacts),
                    );
                    if (sealed.packageId !== expected.packageId)
                      return yield* Effect.fail(corrupt());
                    // Publication and reference registration share the collector's lock.
                    // Filesystem work still precedes the short SQL transaction.
                    return yield* sql.withTransaction(
                      Effect.gen(function* () {
                        const current = yield* delegations.readAttempt(input.attemptId);
                        if (
                          !current ||
                          (current.resultHash !== null && current.resultHash !== input.resultHash)
                        )
                          return yield* Effect.fail(conflict());
                        yield* sql`INSERT INTO expert_delegation_artifact_versions(attempt_id, result_hash, package_id) VALUES (${input.attemptId}, ${input.resultHash}, ${sealed.packageId}) ON CONFLICT(attempt_id) DO NOTHING`;
                        const [stored] = yield* readVersion(input.attemptId);
                        if (
                          !stored ||
                          stored.resultHash !== input.resultHash ||
                          stored.packageId !== sealed.packageId
                        )
                          return yield* Effect.fail(conflict());
                        return { packageId: stored.packageId };
                      }),
                    );
                  }),
                  { signal },
                ),
              ),
            catch: (cause) => cause,
          });
          if (Exit.isFailure(captured)) return yield* Effect.failCause(captured.cause);
          return captured.value;
        }),
      ),
    read: (input) =>
      guarded(
        Effect.gen(function* () {
          const attempt = yield* delegations.readAttempt(input.attemptId);
          const receipt = yield* delegations.readResult(input.attemptId);
          if (
            !attempt ||
            !receipt ||
            attempt.resultRef !== receipt.resultRef ||
            attempt.resultHash !== receipt.resultHash ||
            attempt.state !== receipt.outcome
          )
            return yield* Effect.fail(corrupt());
          const artifacts = receipt.result?.artifacts ?? [];
          const [version] = yield* readVersion(input.attemptId);
          if (!artifacts.length) {
            if (version || input.artifactPath !== undefined) return yield* Effect.fail(corrupt());
            return { receipt, packageId: null, artifact: null };
          }
          if (!version || version.resultHash !== receipt.resultHash)
            return yield* Effect.fail(corrupt());
          const sealed = yield* verify(version.packageId, artifacts);
          if (input.artifactPath === undefined)
            return { receipt, packageId: version.packageId, artifact: null };
          const artifact = artifacts.find((entry) => entry.path === input.artifactPath);
          if (!artifact)
            return yield* Effect.fail(
              new ExpertDelegationStoreError(
                "The requested path is not a declared artifact.",
                "permission_denied",
              ),
            );
          const bytes = yield* Effect.tryPromise(() =>
            expertResourceFiles.read(path.join(sealed.rootPath, artifact.path), sealed.rootPath),
          );
          // read() above verifies the complete package; verify the returned read too.
          if (
            bytes.length !== artifact.size ||
            createHash("sha256").update(bytes).digest("hex") !== artifact.sha256
          )
            return yield* Effect.fail(corrupt());
          return {
            receipt,
            packageId: version.packageId,
            artifact: {
              ...artifact,
              encoding: "base64" as const,
              content: bytes.toString("base64"),
            },
          };
        }),
      ),
  };
  return service;
});
export const ExpertDelegationArtifactsLive = Layer.effect(
  ExpertDelegationArtifacts,
  makeExpertDelegationArtifacts,
);
