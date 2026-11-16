import { Schema } from "effect";

import { PositiveInt } from "./baseSchemas.ts";

/**
 * Fixed product, lane and installation identity prevent a valid signature from
 * authorizing a package meant for another application. Signing the exact UTF-8
 * bytes avoids publisher/client disagreement caused by JSON reserialization.
 */

export const LINX_UPDATE_SCHEMA_VERSION = 1;
export const LINX_UPDATE_PRODUCT_ID = "linx";
export const LINX_UPDATE_INSTALL_IDENTITY = "com.wylinx.linx";
export const LINX_UPDATE_CHANNEL = "stable";
export const LINX_UPDATE_PLATFORM = "darwin";
export const LINX_UPDATE_ARCH = "arm64";

// Bounds applied before any parse. They keep a hostile download from turning
// into unbounded memory use, and they are the same values both sides enforce.
export const LINX_UPDATE_MANIFEST_MAX_BYTES = 16 * 1024;
export const LINX_UPDATE_SIGNATURE_MAX_BYTES = 256;
export const LINX_UPDATE_SIGNATURE_BYTES = 64;
export const LINX_UPDATE_KEY_RING_MAX_BYTES = 16 * 1024;
export const LINX_UPDATE_KEY_RING_MAX_KEYS = 8;
export const LINX_UPDATE_PUBLIC_KEY_BYTES = 44;
export const LINX_UPDATE_ASSET_MAX_BYTES = 4 * 1024 * 1024 * 1024;
export const LINX_UPDATE_ASSET_NAME_MAX_LENGTH = 255;
export const LINX_UPDATE_KEY_ID_LENGTH = 16;

// Rejection reasons are a closed set and are evaluated in exactly this order.
// The first stage that fails wins, so callers can rely on a stable cause.
export const LINX_UPDATE_REJECTION_REASONS = [
  "size",
  "signature",
  "encoding",
  "schema",
  "key",
  "url",
  "version",
] as const;
export type LinxUpdateRejectionReason = (typeof LINX_UPDATE_REJECTION_REASONS)[number];

export const LINX_UPDATE_VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;
export const LINX_UPDATE_SOURCE_COMMIT_PATTERN = /^[a-f0-9]{40}$/u;
export const LINX_UPDATE_MIN_OS_VERSION_PATTERN = /^\d{1,2}(\.\d{1,2}){0,2}$/u;
export const LINX_UPDATE_SHA256_PATTERN = /^[a-f0-9]{64}$/u;
export const LINX_UPDATE_KEY_ID_PATTERN = /^[a-f0-9]{16}$/u;
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;

export const LinxUpdateVersion = Schema.String.check(Schema.isPattern(LINX_UPDATE_VERSION_PATTERN));

export const LinxUpdateSourceCommit = Schema.String.check(
  Schema.isPattern(LINX_UPDATE_SOURCE_COMMIT_PATTERN),
);

export const LinxUpdateMinOSVersion = Schema.String.check(
  Schema.isPattern(LINX_UPDATE_MIN_OS_VERSION_PATTERN),
);

export const LinxUpdateAssetName = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(LINX_UPDATE_ASSET_NAME_MAX_LENGTH),
  Schema.makeFilter((value: string) => {
    if (!value.endsWith(".zip")) return false;
    if (value.includes("/") || value.includes("\\")) return false;
    return !value.includes("..");
  }),
);

/** Absolute https URL with no userinfo and no fragment. */
export function isLinxUpdateAssetUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return (
    url.protocol === "https:" &&
    url.username === "" &&
    url.password === "" &&
    url.hash === "" &&
    url.hostname !== ""
  );
}

export const LinxUpdateAssetUrl = Schema.String.check(
  Schema.isMaxLength(2_048),
  Schema.makeFilter(isLinxUpdateAssetUrl),
);

export const LinxUpdateSha256 = Schema.String.check(Schema.isPattern(LINX_UPDATE_SHA256_PATTERN));

export const LinxUpdateKeyId = Schema.String.check(Schema.isPattern(LINX_UPDATE_KEY_ID_PATTERN));

export const LinxUpdateManifest = Schema.Struct({
  schemaVersion: Schema.Literal(LINX_UPDATE_SCHEMA_VERSION),
  productId: Schema.Literal(LINX_UPDATE_PRODUCT_ID),
  installIdentity: Schema.Literal(LINX_UPDATE_INSTALL_IDENTITY),
  channel: Schema.Literal(LINX_UPDATE_CHANNEL),
  platform: Schema.Literal(LINX_UPDATE_PLATFORM),
  arch: Schema.Literal(LINX_UPDATE_ARCH),
  version: LinxUpdateVersion,
  sourceCommit: LinxUpdateSourceCommit,
  minOSVersion: LinxUpdateMinOSVersion,
  assetName: LinxUpdateAssetName,
  assetUrl: LinxUpdateAssetUrl,
  size: PositiveInt.check(Schema.isLessThanOrEqualTo(LINX_UPDATE_ASSET_MAX_BYTES)),
  sha256: LinxUpdateSha256,
  keyId: LinxUpdateKeyId,
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type LinxUpdateManifest = typeof LinxUpdateManifest.Type;

/** Public key ring file: `keyId` -> base64 SPKI DER. */
export const LinxUpdateKeyRingPublicKey = Schema.String.check(
  Schema.isMaxLength(128),
  Schema.makeFilter((value: string) => value.length > 0 && BASE64_PATTERN.test(value)),
);

export const LinxUpdateKeyRing = Schema.Record(LinxUpdateKeyId, LinxUpdateKeyRingPublicKey).check(
  Schema.isMaxProperties(LINX_UPDATE_KEY_RING_MAX_KEYS),
);
export type LinxUpdateKeyRing = typeof LinxUpdateKeyRing.Type;

export function parseLinxUpdateVersion(value: string): readonly [string, string, string] | null {
  if (!LINX_UPDATE_VERSION_PATTERN.test(value)) return null;
  const [major, minor, patch] = value.split(".");
  if (major === undefined || minor === undefined || patch === undefined) return null;
  return [major, minor, patch];
}

// Decimal string comparison: `Number` would collapse components above 2^53 and
// the grammar allows arbitrarily many digits.
function compareDecimalStrings(left: string, right: string): number {
  if (left.length !== right.length) return left.length < right.length ? -1 : 1;
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

/** Returns a negative/zero/positive comparison, or `null` when either side is invalid. */
export function compareLinxUpdateVersions(left: string, right: string): number | null {
  const leftParts = parseLinxUpdateVersion(left);
  const rightParts = parseLinxUpdateVersion(right);
  if (leftParts === null || rightParts === null) return null;

  const major = compareDecimalStrings(leftParts[0], rightParts[0]);
  if (major !== 0) return major;
  const minor = compareDecimalStrings(leftParts[1], rightParts[1]);
  if (minor !== 0) return minor;
  return compareDecimalStrings(leftParts[2], rightParts[2]);
}

/** Strictly newer check used by admission; invalid input is not "newer". */
export function isLinxUpdateVersionNewer(candidate: string, current: string): boolean {
  const comparison = compareLinxUpdateVersions(candidate, current);
  return comparison !== null && comparison > 0;
}
