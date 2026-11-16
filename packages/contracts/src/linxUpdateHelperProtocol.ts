import { Schema } from "effect";

import { PositiveInt } from "./baseSchemas";
import { LinxUpdateAbsolutePath, LinxUpdateAttemptId } from "./linxUpdateInstall";
import { LinxUpdateSha256, LinxUpdateSourceCommit, LinxUpdateVersion } from "./linxUpdateManifest";
import { LinxUpdateReleaseReceipt } from "./linxUpdateRelease";

const Nonce = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));
const Pid = PositiveInt.check(Schema.isLessThanOrEqualTo(2_147_483_647));
const Timestamp = Schema.String.check(
  Schema.isMaxLength(32),
  Schema.makeFilter((value: string) => Number.isFinite(Date.parse(value))),
);

export const LinxUpdateHelperCommand = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  attemptId: LinxUpdateAttemptId,
  manifestDigest: LinxUpdateSha256,
  nonce: Nonce,
  action: Schema.Literals(["prepare", "create-recovery", "commit", "cancel"]),
  release: Schema.NullOr(LinxUpdateReleaseReceipt),
  userDataSnapshotPath: Schema.NullOr(LinxUpdateAbsolutePath),
})
  .check(
    Schema.makeFilter(
      (value) =>
        (value.action !== "commit" || value.release !== null) &&
        (value.action !== "create-recovery" || value.userDataSnapshotPath !== null),
    ),
  )
  .annotate({ parseOptions: { onExcessProperty: "error" } });
export type LinxUpdateHelperCommand = typeof LinxUpdateHelperCommand.Type;

export const LinxUpdateHelperResponse = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  attemptId: LinxUpdateAttemptId,
  manifestDigest: LinxUpdateSha256,
  helperPid: Pid,
  status: Schema.Literals(["prepared", "recovery-ready", "committed", "cancelled", "failed"]),
  failure: Schema.NullOr(Schema.Literals(["space", "permissions", "macos", "failed"])),
})
  .check(Schema.makeFilter((value) => (value.status === "failed") === (value.failure !== null)))
  .annotate({ parseOptions: { onExcessProperty: "error" } });
export type LinxUpdateHelperResponse = typeof LinxUpdateHelperResponse.Type;

export const LinxUpdateHealthRequest = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  attemptId: LinxUpdateAttemptId,
  manifestDigest: LinxUpdateSha256,
  nonce: Nonce,
  helperPid: Pid,
  applicationPath: LinxUpdateAbsolutePath,
  homePath: LinxUpdateAbsolutePath,
  userDataPath: LinxUpdateAbsolutePath,
  version: LinxUpdateVersion,
  sourceCommit: LinxUpdateSourceCommit,
  createdAt: Timestamp,
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type LinxUpdateHealthRequest = typeof LinxUpdateHealthRequest.Type;

export const LinxUpdateHealthProof = Schema.Struct({
  ...LinxUpdateHealthRequest.fields,
  pid: Pid,
  phase: Schema.Literals(["claim", "healthy"]),
  backendReady: Schema.Boolean,
  clientConnected: Schema.Boolean,
})
  .check(
    Schema.makeFilter(
      (value) => value.phase !== "healthy" || (value.backendReady && value.clientConnected),
    ),
  )
  .annotate({ parseOptions: { onExcessProperty: "error" } });
export type LinxUpdateHealthProof = typeof LinxUpdateHealthProof.Type;
