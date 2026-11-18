import type {
  LinxUpdateWindowMaintenanceRequest,
  LinxUpdateWindowMaintenanceResponse,
} from "@synara/contracts";

// Sandboxed preloads may only require("electron"), so these two IPC payloads
// cannot use the Effect schemas from @synara/contracts. Keep this parser in
// lockstep with packages/contracts/src/linxUpdateInstall.ts; the paired test
// compares it against the schemas for valid and rejected payloads.
const ATTEMPT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const REQUEST_KEYS = [
  "schemaVersion",
  "action",
  "attemptId",
  "probeId",
  "backendStopped",
  "manifestDigest",
] as const;
const RESPONSE_KEYS = [
  "schemaVersion",
  "attemptId",
  "probeId",
  "manifestDigest",
  "ready",
  "unsavedEditors",
  "savingEditors",
  "message",
] as const;

function hasExactKeys(value: Record<string, unknown>, keys: ReadonlyArray<string>): boolean {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}
function isAttemptId(value: unknown): value is string {
  return typeof value === "string" && ATTEMPT_ID.test(value);
}
function isSha256(value: unknown): value is string {
  return typeof value === "string" && SHA256.test(value);
}
function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function isMessage(value: unknown): value is string | null {
  return (
    value === null || (typeof value === "string" && value.length >= 1 && value.length <= 2_048)
  );
}

export function parseLinxUpdateWindowMaintenanceRequest(
  value: unknown,
): LinxUpdateWindowMaintenanceRequest | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (!hasExactKeys(record, REQUEST_KEYS)) return null;
  if (
    record.schemaVersion !== 1 ||
    (record.action !== "prepare" && record.action !== "release") ||
    !isAttemptId(record.attemptId) ||
    !isAttemptId(record.probeId) ||
    typeof record.backendStopped !== "boolean" ||
    !isSha256(record.manifestDigest)
  )
    return null;
  return {
    schemaVersion: 1,
    action: record.action,
    attemptId: record.attemptId,
    probeId: record.probeId,
    backendStopped: record.backendStopped,
    manifestDigest: record.manifestDigest,
  };
}

export function parseLinxUpdateWindowMaintenanceResponse(
  value: unknown,
): LinxUpdateWindowMaintenanceResponse | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (!hasExactKeys(record, RESPONSE_KEYS)) return null;
  if (
    record.schemaVersion !== 1 ||
    !isAttemptId(record.attemptId) ||
    !isAttemptId(record.probeId) ||
    !isSha256(record.manifestDigest) ||
    typeof record.ready !== "boolean" ||
    !isCount(record.unsavedEditors) ||
    !isCount(record.savingEditors) ||
    !isMessage(record.message)
  )
    return null;
  if (record.ready && (record.unsavedEditors !== 0 || record.savingEditors !== 0)) return null;
  return {
    schemaVersion: 1,
    attemptId: record.attemptId,
    probeId: record.probeId,
    manifestDigest: record.manifestDigest,
    ready: record.ready,
    unsavedEditors: record.unsavedEditors,
    savingEditors: record.savingEditors,
    message: record.message,
  };
}
