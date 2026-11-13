import { Buffer } from "node:buffer";
import {
  createHash,
  createPublicKey,
  verify as verifyDetachedSignature,
  type KeyObject,
} from "node:crypto";

import { Schema, SchemaIssue } from "effect";

import {
  compareLinxUpdateVersions,
  LINX_UPDATE_KEY_ID_LENGTH,
  LINX_UPDATE_KEY_RING_MAX_BYTES,
  LINX_UPDATE_MANIFEST_MAX_BYTES,
  LINX_UPDATE_PUBLIC_KEY_BYTES,
  LINX_UPDATE_SIGNATURE_BYTES,
  LINX_UPDATE_SIGNATURE_MAX_BYTES,
  LinxUpdateKeyRing,
  LinxUpdateManifest,
  parseLinxUpdateVersion,
} from "@synara/contracts";
import type { LinxUpdateManifest as LinxUpdateManifestType } from "@synara/contracts";
import type { LinxUpdateRejectionReason } from "@synara/contracts";

/**
 * Client-side admission pipeline for the LU-00 update manifest.
 *
 * Order is fixed and must not be reordered: size -> signature -> encoding ->
 * schema -> key -> url -> version. Nothing is decoded (not even UTF-8) until
 * the detached signature has been verified over the exact manifest bytes, so a
 * hostile download cannot influence a parser before proving authorship.
 */

/** Configuration mistakes (bad key ring, missing/bad parameters) are not manifest rejections. */
export class LinxUpdateConfigurationError extends Error {
  override readonly name = "LinxUpdateConfigurationError";
}

export type LinxUpdateTrustedKeys = ReadonlyMap<string, KeyObject>;

/** `keyId` is the first 16 hex characters of the sha256 of the SPKI DER bytes. */
export function linxUpdateKeyIdForPublicKeyDer(der: Uint8Array): string {
  return createHash("sha256").update(der).digest("hex").slice(0, LINX_UPDATE_KEY_ID_LENGTH);
}

function decodeCanonicalBase64(value: string): Buffer | null {
  if (value.length === 0 || value.length % 4 !== 0) return null;
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) return null;
  const bytes = Buffer.from(value, "base64");
  return bytes.toString("base64") === value ? bytes : null;
}

/**
 * Loads a trusted key ring, rejecting any entry whose declared `keyId` is not
 * the id of its own DER bytes. Publisher and client share this loader so the
 * two cannot drift.
 */
export function loadLinxUpdateKeyRing(raw: string): LinxUpdateTrustedKeys {
  if (Buffer.byteLength(raw, "utf8") > LINX_UPDATE_KEY_RING_MAX_BYTES) {
    throw new LinxUpdateConfigurationError(
      `Trusted key ring exceeds ${LINX_UPDATE_KEY_RING_MAX_BYTES} bytes.`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new LinxUpdateConfigurationError("Trusted key ring is not valid JSON.");
  }

  let keyRing: typeof LinxUpdateKeyRing.Type;
  try {
    keyRing = Schema.decodeUnknownSync(LinxUpdateKeyRing)(parsed);
  } catch (error) {
    throw new LinxUpdateConfigurationError(
      `Trusted key ring has an invalid shape: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const keys = new Map<string, KeyObject>();
  for (const [keyId, encoded] of Object.entries(keyRing)) {
    keys.set(keyId, decodeLinxUpdatePublicKey(keyId, encoded));
  }
  return keys;
}

export function decodeLinxUpdatePublicKey(keyId: string, encoded: string): KeyObject {
  const der = decodeCanonicalBase64(encoded);
  if (der === null) {
    throw new LinxUpdateConfigurationError(`Trusted key "${keyId}" is not canonical base64.`);
  }
  if (der.length !== LINX_UPDATE_PUBLIC_KEY_BYTES) {
    throw new LinxUpdateConfigurationError(
      `Trusted key "${keyId}" must be a ${LINX_UPDATE_PUBLIC_KEY_BYTES}-byte Ed25519 SPKI DER key.`,
    );
  }
  const derived = linxUpdateKeyIdForPublicKeyDer(der);
  if (derived !== keyId) {
    throw new LinxUpdateConfigurationError(
      `Trusted key "${keyId}" does not match its public key (expected "${derived}").`,
    );
  }

  let key: KeyObject;
  try {
    key = createPublicKey({ key: der, format: "der", type: "spki" });
  } catch {
    throw new LinxUpdateConfigurationError(`Trusted key "${keyId}" is not a valid public key.`);
  }
  if (key.asymmetricKeyType !== "ed25519") {
    throw new LinxUpdateConfigurationError(`Trusted key "${keyId}" is not an Ed25519 key.`);
  }
  return key;
}

export interface LinxUpdateVerificationInput {
  /** Exact bytes of the manifest file as published. */
  readonly manifestBytes: Uint8Array;
  /** Exact bytes of the detached signature file (base64 text, trailing whitespace allowed). */
  readonly signatureBytes: Uint8Array;
  readonly keyRing: LinxUpdateTrustedKeys;
  /** Version currently installed; must be a strict `x.y.z` string. */
  readonly currentVersion: string;
  /** Bare host names the manifest may point `assetUrl` at (ports are not supported). */
  readonly allowedAssetHosts: ReadonlyArray<string>;
}

export interface LinxUpdateAccepted {
  readonly ok: true;
  readonly manifest: LinxUpdateManifestType;
  readonly keyId: string;
}

export interface LinxUpdateRejected {
  readonly ok: false;
  readonly reason: LinxUpdateRejectionReason;
  readonly field: string | null;
  readonly message: string;
}

export type LinxUpdateVerificationResult = LinxUpdateAccepted | LinxUpdateRejected;

function reject(
  reason: LinxUpdateRejectionReason,
  field: string | null,
  message: string,
): LinxUpdateRejected {
  return { ok: false, reason, field, message };
}

function decodeSignatureFile(bytes: Uint8Array): Buffer | null {
  const text = Buffer.from(bytes).toString("latin1");
  // Base64 only; trailing whitespace is tolerated because editors add it.
  if (/[^\t\n\r\x20-\x7e]/u.test(text)) return null;
  const trimmed = text.replace(/[\t\n\r ]+$/u, "");
  // An empty file is a length violation, not an encoding one: let the 64-byte
  // check below report it as `size`.
  return trimmed.length === 0 ? Buffer.alloc(0) : decodeCanonicalBase64(trimmed);
}

function firstIssuePath(issue: SchemaIssue.Issue): ReadonlyArray<PropertyKey> | null {
  switch (issue._tag) {
    case "Pointer": {
      const nested = firstIssuePath(issue.issue);
      return nested === null ? issue.path : [...issue.path, ...nested];
    }
    case "Composite":
    case "AnyOf": {
      const [first] = issue.issues;
      return first === undefined ? null : firstIssuePath(first);
    }
    case "Filter":
    case "Encoding":
      return firstIssuePath(issue.issue);
    default:
      return null;
  }
}

function schemaRejectionField(error: unknown): string | null {
  const cause = error instanceof Error ? error.cause : undefined;
  if (!SchemaIssue.isIssue(cause)) return null;
  const path = firstIssuePath(cause);
  if (path === null || path.length === 0) return null;
  return path.map(String).join(".");
}

function normalizeAssetHosts(hosts: ReadonlyArray<string>): ReadonlySet<string> {
  const normalized = new Set<string>();
  for (const host of hosts) {
    const value = host.trim().toLowerCase();
    if (value.length > 0) normalized.add(value);
  }
  return normalized;
}

/**
 * Verifies one manifest and returns either the decoded manifest with the key
 * that actually signed it, or a reason from the closed rejection set.
 *
 * Throws `LinxUpdateConfigurationError` for caller-controlled mistakes
 * (unparseable current version), which are not manifest rejections.
 */
export function verifyLinxUpdateManifest(
  input: LinxUpdateVerificationInput,
): LinxUpdateVerificationResult {
  if (parseLinxUpdateVersion(input.currentVersion) === null) {
    throw new LinxUpdateConfigurationError(
      `Current version "${input.currentVersion}" is not an x.y.z version.`,
    );
  }
  const allowedAssetHosts = normalizeAssetHosts(input.allowedAssetHosts);

  // 1. size
  if (input.manifestBytes.byteLength > LINX_UPDATE_MANIFEST_MAX_BYTES) {
    return reject("size", "manifest", `Manifest exceeds ${LINX_UPDATE_MANIFEST_MAX_BYTES} bytes.`);
  }
  if (input.signatureBytes.byteLength > LINX_UPDATE_SIGNATURE_MAX_BYTES) {
    return reject(
      "size",
      "signature",
      `Signature file exceeds ${LINX_UPDATE_SIGNATURE_MAX_BYTES} bytes.`,
    );
  }

  // 2. signature: every trusted key is tried; the manifest's own `keyId` is not
  // trusted until the signature over the raw bytes proves which key signed.
  const signature = decodeSignatureFile(input.signatureBytes);
  if (signature === null) {
    return reject("signature", "signature", "Signature file is not canonical base64.");
  }
  if (signature.byteLength !== LINX_UPDATE_SIGNATURE_BYTES) {
    return reject(
      "size",
      "signature",
      `Signature must decode to ${LINX_UPDATE_SIGNATURE_BYTES} bytes, got ${signature.byteLength}.`,
    );
  }
  const signingKeyIds: string[] = [];
  for (const [keyId, key] of input.keyRing) {
    if (verifyDetachedSignature(null, input.manifestBytes, key, signature)) {
      signingKeyIds.push(keyId);
    }
  }
  if (signingKeyIds.length === 0) {
    return reject("signature", null, "Manifest signature does not match any trusted key.");
  }

  // 3. encoding: only now is the payload read as text.
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(input.manifestBytes);
  } catch {
    return reject("encoding", "manifest", "Manifest is not valid UTF-8.");
  }

  // 4. schema
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return reject("schema", "manifest", "Manifest is not valid JSON.");
  }
  let manifest: LinxUpdateManifestType;
  try {
    manifest = Schema.decodeUnknownSync(LinxUpdateManifest)(parsed);
  } catch (error) {
    return reject(
      "schema",
      schemaRejectionField(error),
      `Manifest failed schema validation: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  // 5. key: the declared id must be one of the keys that actually verified.
  const signingKeyId = signingKeyIds.includes(manifest.keyId) ? manifest.keyId : null;
  if (signingKeyId === null) {
    return reject(
      "key",
      "keyId",
      `Manifest keyId "${manifest.keyId}" is not the key that signed it.`,
    );
  }

  // 6. url. The schema already proved this is an absolute https URL without
  // credentials or a fragment, so parsing cannot fail here.
  const assetUrl = new URL(manifest.assetUrl);
  if (!allowedAssetHosts.has(assetUrl.host)) {
    return reject(
      "url",
      "assetUrl",
      `Manifest asset host "${assetUrl.host}" is not in the allowed list.`,
    );
  }

  // 7. version
  const comparison = compareLinxUpdateVersions(manifest.version, input.currentVersion);
  if (comparison === null || comparison <= 0) {
    return reject(
      "version",
      "version",
      `Manifest version "${manifest.version}" is not newer than "${input.currentVersion}".`,
    );
  }

  return { ok: true, manifest, keyId: signingKeyId };
}
