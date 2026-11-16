import { createHash } from "node:crypto";
import type { ReleaseArtifactDigest } from "./release-artifact-provenance.ts";
import { Schema } from "effect";

export interface LinxReleaseCandidate {
  readonly schemaVersion: 1;
  readonly repository: string;
  readonly version: string;
  readonly tag: string;
  readonly sourceCommit: string;
  readonly lockfileSha256: string;
  readonly runId: string;
  readonly assets: readonly ReleaseArtifactDigest[];
}
const CandidateSchema = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  repository: Schema.String,
  version: Schema.String,
  tag: Schema.String,
  sourceCommit: Schema.String,
  lockfileSha256: Schema.String,
  runId: Schema.String,
  assets: Schema.Array(
    Schema.Struct({ fileName: Schema.String, size: Schema.Number, sha256: Schema.String }).annotate(
      { parseOptions: { onExcessProperty: "error" } },
    ),
  ),
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export function parseCandidate(value: unknown): LinxReleaseCandidate {
  const candidate = Schema.decodeUnknownSync(CandidateSchema)(value);
  candidateBytes(candidate);
  return candidate;
}
export function candidateBytes(candidate: LinxReleaseCandidate): string {
  if (
    candidate.schemaVersion !== 1 ||
    candidate.repository !== "WYLINX601/synara--expert" ||
    !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(candidate.version) ||
    candidate.tag !== `v${candidate.version}` ||
    !/^[0-9a-f]{40}$/.test(candidate.sourceCommit) ||
    !/^[0-9a-f]{64}$/.test(candidate.lockfileSha256) ||
    !/^\d+$/.test(candidate.runId)
  )
    throw new Error("Invalid candidate source binding.");
  const names = new Set<string>();
  for (const asset of candidate.assets) {
    if (
      !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(asset.fileName) ||
      asset.fileName.includes("..") ||
      names.has(asset.fileName) ||
      !Number.isSafeInteger(asset.size) ||
      asset.size <= 0 ||
      !/^[0-9a-f]{64}$/.test(asset.sha256)
    )
      throw new Error("Invalid candidate asset inventory.");
    names.add(asset.fileName);
  }
  const required = [
    `Linx-${candidate.version}-arm64.dmg`,
    `Linx-${candidate.version}-arm64.zip`,
    "artifact-mac-arm64.provenance.json",
    "linx-update.json",
    "linx-update.json.sig",
    "linx-update-source.json",
  ];
  if (names.size !== required.length || required.some((name) => !names.has(name)))
    throw new Error("Candidate must contain exactly the complete Linx asset set.");
  return `${JSON.stringify({ schemaVersion: candidate.schemaVersion, repository: candidate.repository, version: candidate.version, tag: candidate.tag, sourceCommit: candidate.sourceCommit, lockfileSha256: candidate.lockfileSha256, runId: candidate.runId, assets: [...candidate.assets].sort((a, b) => a.fileName.localeCompare(b.fileName)).map(({ fileName, size, sha256 }) => ({ fileName, size, sha256 })) }, null, 2)}\n`;
}
export function candidateDigest(candidate: LinxReleaseCandidate): string {
  return createHash("sha256").update(candidateBytes(candidate)).digest("hex");
}
export function assertImmutableCandidate(
  expected: LinxReleaseCandidate,
  actual: LinxReleaseCandidate,
): void {
  if (candidateDigest(expected) !== candidateDigest(actual))
    throw new Error(
      "Candidate changed; refusing overwrite or promotion. A new version and approval are required.",
    );
}
export function assertReviewerProtection(environment: unknown): void {
  try {
    const value = Schema.decodeUnknownSync(
      Schema.Struct({
        can_admins_bypass: Schema.Boolean,
        protection_rules: Schema.Array(
          Schema.Struct({
            type: Schema.String,
            prevent_self_review: Schema.optional(Schema.Boolean),
            reviewers: Schema.optional(
              Schema.Array(
                Schema.Struct({
                  type: Schema.Literals(["User", "Team"]),
                  reviewer: Schema.Struct({ id: Schema.Number }),
                }),
              ),
            ),
          }),
        ),
      }),
    )(environment);
    const review = value.protection_rules.find((rule) => rule.type === "required_reviewers");
    if (
      !review?.reviewers?.length ||
      review.reviewers.some(
        ({ reviewer }) => !Number.isSafeInteger(reviewer.id) || reviewer.id <= 0,
      ) ||
      review.prevent_self_review !== false ||
      value.can_admins_bypass !== false
    )
      throw new Error("Unprotected release environment.");
  } catch {
    throw new Error(
      "Release environment requires real reviewers, explicit maintainer self-review permission, and disabled admin bypass.",
    );
  }
}
