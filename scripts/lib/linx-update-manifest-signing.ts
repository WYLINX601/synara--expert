// FILE: linx-update-manifest-signing.ts
// Purpose: Publisher-side Ed25519 key generation and detached manifest signing.
// Layer: Release/publishing helper; never bundled into the desktop app.

import { Buffer } from "node:buffer";
import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as signDetached,
  type KeyObject,
} from "node:crypto";
import { chmodSync, writeFileSync } from "node:fs";

import {
  linxUpdateKeyIdForPublicKeyDer,
  LinxUpdateConfigurationError,
} from "@synara/shared/linxUpdateManifestVerification";

/**
 * The private key only ever lives in a publisher-controlled directory. Nothing
 * here prints key material: callers print the `keyId` and public key instead.
 */

export const LINX_UPDATE_PRIVATE_KEY_FILE_NAME = "linx-update-private.pem";
export const LINX_UPDATE_KEY_RING_FILE_NAME = "linx-update-keys.json";
export const LINX_UPDATE_PRIVATE_KEY_MODE = 0o600;

export interface LinxUpdateSigningKeyPair {
  readonly keyId: string;
  readonly privateKeyPem: string;
  readonly publicKeyBase64: string;
  readonly keyRingJson: string;
}

function exportPublicKeyDer(publicKey: KeyObject): Buffer {
  const der = publicKey.export({ type: "spki", format: "der" });
  if (!(der instanceof Buffer)) {
    throw new Error("Ed25519 public key did not export as SPKI DER.");
  }
  return der;
}

export function generateLinxUpdateSigningKeyPair(): LinxUpdateSigningKeyPair {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const der = exportPublicKeyDer(publicKey);
  const keyId = linxUpdateKeyIdForPublicKeyDer(der);
  const publicKeyBase64 = der.toString("base64");
  return {
    keyId,
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKeyBase64,
    keyRingJson: `${JSON.stringify({ [keyId]: publicKeyBase64 }, null, 2)}\n`,
  };
}

export function loadLinxUpdateSigningPrivateKey(privateKeyPem: string): KeyObject {
  let key: KeyObject;
  try {
    key = createPrivateKey(privateKeyPem);
  } catch {
    throw new LinxUpdateConfigurationError("Signing key is not a valid PEM private key.");
  }
  if (key.asymmetricKeyType !== "ed25519") {
    throw new LinxUpdateConfigurationError("Signing key is not an Ed25519 private key.");
  }
  return key;
}

/** `keyId` of the private key's public half, for operator-facing output. */
export function linxUpdateKeyIdForPrivateKey(privateKeyPem: string): string {
  const privateKey = loadLinxUpdateSigningPrivateKey(privateKeyPem);
  return linxUpdateKeyIdForPublicKeyDer(exportPublicKeyDer(createPublicKey(privateKey)));
}

/** Signs the exact published bytes; returns base64 of the 64-byte signature. */
export function signLinxUpdateManifestBytes(
  manifestBytes: Uint8Array,
  privateKeyPem: string,
): string {
  const privateKey = loadLinxUpdateSigningPrivateKey(privateKeyPem);
  return signDetached(null, manifestBytes, privateKey).toString("base64");
}

function writeConfigurationFile(path: string, contents: string, mode?: number): void {
  try {
    writeFileSync(path, contents, {
      encoding: "utf8",
      flag: "wx",
      ...(mode === undefined ? {} : { mode }),
    });
    // `mode` is filtered through umask, so pin the bits the contract promises.
    if (mode !== undefined) chmodSync(path, mode);
  } catch (error) {
    throw new LinxUpdateConfigurationError(
      `Cannot write "${path}": ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** Creates the private key file at 0600 and refuses to replace an existing one. */
export function writeLinxUpdatePrivateKey(path: string, privateKeyPem: string): void {
  writeConfigurationFile(path, privateKeyPem, LINX_UPDATE_PRIVATE_KEY_MODE);
}

export function writeLinxUpdateKeyRing(path: string, keyRingJson: string): void {
  writeConfigurationFile(path, keyRingJson);
}
