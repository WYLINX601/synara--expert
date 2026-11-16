import { Schema } from "effect";

import { PositiveInt } from "./baseSchemas";
import { LinxUpdateSha256, LinxUpdateSourceCommit } from "./linxUpdateManifest";

export const LinxUpdateRepository = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/u),
);

const GitHubId = PositiveInt.check(Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER));

/** Public observations are bound to signed bytes; they never confer trust in a new key. */
export const LinxUpdateReleaseReceipt = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  repository: LinxUpdateRepository,
  tagName: Schema.String.check(Schema.isMinLength(2), Schema.isMaxLength(128)),
  releaseId: GitHubId,
  tagObjectSha: LinxUpdateSourceCommit,
  sourceCommit: LinxUpdateSourceCommit,
  packageAssetId: GitHubId,
  manifestAssetId: GitHubId,
  signatureAssetId: GitHubId,
  manifestDigest: LinxUpdateSha256,
  packageSha256: LinxUpdateSha256,
  verifiedAt: Schema.String.check(
    Schema.isMaxLength(32),
    Schema.makeFilter((value: string) => Number.isFinite(Date.parse(value))),
  ),
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type LinxUpdateReleaseReceipt = typeof LinxUpdateReleaseReceipt.Type;
