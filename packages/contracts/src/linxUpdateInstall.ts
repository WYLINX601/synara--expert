import { Schema } from "effect";

import { NonNegativeInt, PositiveInt } from "./baseSchemas";
import { LinxUpdateSha256, LinxUpdateVersion } from "./linxUpdateManifest";

export const LINX_UPDATE_INSTALL_REQUEST_MAX_BYTES = 64 * 1024;
export const LINX_UPDATE_INSTALL_JOURNAL_MAX_BYTES = 64 * 1024;
export const LINX_UPDATE_INSTALL_JOURNAL_FILE_NAME = "linx-update-install.json";

export const LinxUpdateAttemptId = Schema.String.check(
  Schema.isPattern(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u),
);

const NON_CANONICAL_PATH_SEGMENT = /(?:^|\/)\.{1,2}(?:\/|$)/u;
export const LinxUpdateAbsolutePath = Schema.String.check(
  Schema.isMaxLength(4_096),
  Schema.makeFilter(
    (value: string) =>
      value.startsWith("/") &&
      value.length > 1 &&
      !value.endsWith("/") &&
      !value.includes("//") &&
      !value.includes("\0") &&
      !value.includes("\n") &&
      !value.includes("\r") &&
      !NON_CANONICAL_PATH_SEGMENT.test(value),
  ),
);

const LinxUpdateTimestamp = Schema.String.check(
  Schema.isMaxLength(32),
  Schema.makeFilter((value: string) => Number.isFinite(Date.parse(value))),
);
const LinxUpdateMessage = Schema.NullOr(
  Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2_048)),
);

export const LinxUpdateInstallPhase = Schema.Literals([
  "prepared",
  "waiting-for-exit",
  "old-retained",
  "new-installed",
  "launching",
  "awaiting-health",
  "healthy",
  "rolled-back",
  "recovery-required",
  "cancelled",
]);
export type LinxUpdateInstallPhase = typeof LinxUpdateInstallPhase.Type;

/** Paths are claims, not authority; the helper must bind them to its live parent and private attempt. */
export const LinxUpdateInstallRequest = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  attemptId: LinxUpdateAttemptId,
  requestedAt: LinxUpdateTimestamp,
  fromVersion: LinxUpdateVersion,
  toVersion: LinxUpdateVersion,
  manifestDigest: LinxUpdateSha256,
  manifestPath: LinxUpdateAbsolutePath,
  signaturePath: LinxUpdateAbsolutePath,
  packagePath: LinxUpdateAbsolutePath,
  applicationPath: LinxUpdateAbsolutePath,
  homePath: LinxUpdateAbsolutePath,
  userDataPath: LinxUpdateAbsolutePath,
  parentPid: PositiveInt.check(Schema.isLessThanOrEqualTo(2_147_483_647)),
  authorizationDigest: LinxUpdateSha256,
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type LinxUpdateInstallRequest = typeof LinxUpdateInstallRequest.Type;

export const LinxUpdateInstallJournal = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  attemptId: LinxUpdateAttemptId,
  fromVersion: LinxUpdateVersion,
  toVersion: LinxUpdateVersion,
  manifestDigest: LinxUpdateSha256,
  packageSha256: LinxUpdateSha256,
  applicationPath: LinxUpdateAbsolutePath,
  homePath: LinxUpdateAbsolutePath,
  userDataPath: LinxUpdateAbsolutePath,
  retainedApplicationPath: LinxUpdateAbsolutePath,
  recoveryDirectoryPath: LinxUpdateAbsolutePath,
  phase: LinxUpdateInstallPhase,
  requestedAt: LinxUpdateTimestamp,
  updatedAt: LinxUpdateTimestamp,
  mayHaveWrittenData: Schema.Boolean,
  message: LinxUpdateMessage,
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type LinxUpdateInstallJournal = typeof LinxUpdateInstallJournal.Type;

export const LinxUpdateBusyState = Schema.Struct({
  activeTurns: NonNegativeInt,
  pendingApprovals: NonNegativeInt,
  pendingUserInputs: NonNegativeInt,
  backgroundTasks: NonNegativeInt,
  acceptedWrites: NonNegativeInt,
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type LinxUpdateBusyState = typeof LinxUpdateBusyState.Type;

export function isLinxUpdateBusyStateClear(state: LinxUpdateBusyState | null): boolean {
  return (
    state !== null &&
    state.activeTurns === 0 &&
    state.pendingApprovals === 0 &&
    state.pendingUserInputs === 0 &&
    state.backgroundTasks === 0 &&
    state.acceptedWrites === 0
  );
}

export const LinxUpdateMaintenanceRequest = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  action: Schema.Literals(["prepare", "commit", "abort"]),
  attemptId: LinxUpdateAttemptId,
  targetVersion: LinxUpdateVersion,
  manifestDigest: LinxUpdateSha256,
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type LinxUpdateMaintenanceRequest = typeof LinxUpdateMaintenanceRequest.Type;

export const LinxUpdateMaintenanceResponse = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  attemptId: LinxUpdateAttemptId,
  manifestDigest: LinxUpdateSha256,
  status: Schema.Literals(["ready", "blocked", "committed", "released"]),
  busy: Schema.NullOr(LinxUpdateBusyState),
  message: LinxUpdateMessage,
})
  .check(
    Schema.makeFilter(
      (value) =>
        (value.status !== "ready" && value.status !== "committed") ||
        isLinxUpdateBusyStateClear(value.busy),
    ),
  )
  .annotate({ parseOptions: { onExcessProperty: "error" } });
export type LinxUpdateMaintenanceResponse = typeof LinxUpdateMaintenanceResponse.Type;

export const LinxUpdateWindowMaintenanceRequest = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  action: Schema.Literals(["prepare", "release"]),
  attemptId: LinxUpdateAttemptId,
  probeId: LinxUpdateAttemptId,
  backendStopped: Schema.Boolean,
  manifestDigest: LinxUpdateSha256,
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type LinxUpdateWindowMaintenanceRequest = typeof LinxUpdateWindowMaintenanceRequest.Type;

export const LinxUpdateWindowMaintenanceResponse = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  attemptId: LinxUpdateAttemptId,
  probeId: LinxUpdateAttemptId,
  manifestDigest: LinxUpdateSha256,
  ready: Schema.Boolean,
  unsavedEditors: NonNegativeInt,
  savingEditors: NonNegativeInt,
  message: LinxUpdateMessage,
})
  .check(
    Schema.makeFilter(
      (value) => !value.ready || (value.unsavedEditors === 0 && value.savingEditors === 0),
    ),
  )
  .annotate({ parseOptions: { onExcessProperty: "error" } });
export type LinxUpdateWindowMaintenanceResponse = typeof LinxUpdateWindowMaintenanceResponse.Type;
