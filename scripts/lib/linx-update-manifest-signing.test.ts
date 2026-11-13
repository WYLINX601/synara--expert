import { Buffer } from "node:buffer";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  linxUpdateKeyIdForPublicKeyDer,
  loadLinxUpdateKeyRing,
  verifyLinxUpdateManifest,
} from "@synara/shared/linxUpdateManifestVerification";

import {
  generateLinxUpdateSigningKeyPair,
  LINX_UPDATE_PRIVATE_KEY_MODE,
  linxUpdateKeyIdForPrivateKey,
  loadLinxUpdateSigningPrivateKey,
  signLinxUpdateManifestBytes,
  writeLinxUpdateKeyRing,
  writeLinxUpdatePrivateKey,
} from "./linx-update-manifest-signing.ts";

const temporaryDirectories: string[] = [];

function makeTemporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "linx-signing-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function manifestBytes(keyId: string): Buffer {
  return Buffer.from(
    JSON.stringify({
      schemaVersion: 1,
      productId: "linx",
      channel: "stable",
      platform: "darwin",
      arch: "arm64",
      version: "1.2.3",
      sourceCommit: "a".repeat(40),
      minOSVersion: "13.0",
      assetName: "Linx-1.2.3-arm64.zip",
      assetUrl: "https://example.com/Linx-1.2.3-arm64.zip",
      size: 1_024,
      sha256: "b".repeat(64),
      keyId,
    }),
  );
}

describe("Linx update manifest signing", () => {
  it("derives keyId, public key and key ring from one key pair", () => {
    const pair = generateLinxUpdateSigningKeyPair();
    const der = Buffer.from(pair.publicKeyBase64, "base64");

    expect(pair.keyId).toBe(linxUpdateKeyIdForPublicKeyDer(der));
    expect(pair.keyRingJson.trim()).toBe(
      JSON.stringify({ [pair.keyId]: pair.publicKeyBase64 }, null, 2),
    );
    expect(linxUpdateKeyIdForPrivateKey(pair.privateKeyPem)).toBe(pair.keyId);
    expect(pair.privateKeyPem).toContain("BEGIN PRIVATE KEY");
  });

  it("produces a detached signature that the shipped verifier accepts", () => {
    const pair = generateLinxUpdateSigningKeyPair();
    const bytes = manifestBytes(pair.keyId);
    const signature = signLinxUpdateManifestBytes(bytes, pair.privateKeyPem);
    const keyRing = loadLinxUpdateKeyRing(pair.keyRingJson);

    expect(keyRing.size).toBe(1);
    expect(
      verifyLinxUpdateManifest({
        manifestBytes: bytes,
        signatureBytes: Buffer.from(signature),
        keyRing,
        currentVersion: "1.0.0",
        allowedAssetHosts: ["example.com"],
      }),
    ).toMatchObject({ ok: true, keyId: pair.keyId });
  });

  it("signs the exact bytes: any change breaks verification", () => {
    const pair = generateLinxUpdateSigningKeyPair();
    const bytes = manifestBytes(pair.keyId);
    const signature = signLinxUpdateManifestBytes(bytes, pair.privateKeyPem);
    const tampered = Buffer.concat([bytes, Buffer.from(" ")]);

    expect(
      verifyLinxUpdateManifest({
        manifestBytes: tampered,
        signatureBytes: Buffer.from(signature),
        keyRing: loadLinxUpdateKeyRing(pair.keyRingJson),
        currentVersion: "1.0.0",
        allowedAssetHosts: ["example.com"],
      }),
    ).toMatchObject({ ok: false, reason: "signature" });
  });

  it("uses deterministic Ed25519 signatures over the same bytes", () => {
    const pair = generateLinxUpdateSigningKeyPair();
    const bytes = manifestBytes(pair.keyId);

    expect(signLinxUpdateManifestBytes(bytes, pair.privateKeyPem)).toBe(
      signLinxUpdateManifestBytes(bytes, pair.privateKeyPem),
    );
  });

  it("rejects an invalid private key", () => {
    expect(() => loadLinxUpdateSigningPrivateKey("not a key")).toThrow();
    expect(() => signLinxUpdateManifestBytes(Buffer.from("{}"), "not a key")).toThrow();
  });

  it("creates the private key at 0600 and never replaces it", () => {
    const directory = makeTemporaryDirectory();
    const privateKeyPath = join(directory, "linx-update-private.pem");
    const keyRingPath = join(directory, "linx-update-keys.json");
    const pair = generateLinxUpdateSigningKeyPair();

    writeLinxUpdatePrivateKey(privateKeyPath, pair.privateKeyPem);
    writeLinxUpdateKeyRing(keyRingPath, pair.keyRingJson);

    expect(statSync(privateKeyPath).mode & 0o777).toBe(LINX_UPDATE_PRIVATE_KEY_MODE);
    expect(readFileSync(privateKeyPath, "utf8")).toBe(pair.privateKeyPem);
    expect(readFileSync(keyRingPath, "utf8")).toBe(pair.keyRingJson);
    expect(() => writeLinxUpdatePrivateKey(privateKeyPath, pair.privateKeyPem)).toThrow();
    expect(() => writeLinxUpdateKeyRing(keyRingPath, pair.keyRingJson)).toThrow();
  });
});
