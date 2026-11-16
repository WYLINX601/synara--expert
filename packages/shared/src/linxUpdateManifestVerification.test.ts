import { Buffer } from "node:buffer";
import { generateKeyPairSync, sign as signDetached, type KeyObject } from "node:crypto";

import { describe, expect, it } from "vitest";

import { LINX_UPDATE_MANIFEST_MAX_BYTES, LINX_UPDATE_SIGNATURE_MAX_BYTES } from "@synara/contracts";

import {
  linxUpdateKeyIdForPublicKeyDer,
  loadLinxUpdateKeyRing,
  LinxUpdateConfigurationError,
  verifyLinxUpdateManifest,
  type LinxUpdateTrustedKeys,
  type LinxUpdateVerificationInput,
} from "./linxUpdateManifestVerification";

const baseManifest = {
  schemaVersion: 1,
  productId: "linx",
  installIdentity: "com.wylinx.linx",
  channel: "stable",
  platform: "darwin",
  arch: "arm64",
  version: "1.2.3",
  sourceCommit: "a".repeat(40),
  minOSVersion: "13.0",
  assetName: "Linx-1.2.3-arm64.zip",
  assetUrl: "https://example.com/releases/Linx-1.2.3-arm64.zip",
  size: 1_024,
  sha256: "b".repeat(64),
  keyId: "",
} as const;

interface TestKey {
  readonly keyId: string;
  readonly publicKeyBase64: string;
  readonly privateKey: KeyObject;
}

function makeKey(): TestKey {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const der = publicKey.export({ type: "spki", format: "der" });
  if (!(der instanceof Buffer)) throw new Error("expected a DER buffer");
  return {
    keyId: linxUpdateKeyIdForPublicKeyDer(der),
    publicKeyBase64: der.toString("base64"),
    privateKey,
  };
}

function ringOf(...keys: ReadonlyArray<TestKey>): LinxUpdateTrustedKeys {
  return loadLinxUpdateKeyRing(
    JSON.stringify(Object.fromEntries(keys.map((key) => [key.keyId, key.publicKeyBase64]))),
  );
}

function manifestBytes(keyId: string, patch: Record<string, unknown> = {}, padding = 0): Buffer {
  const text = JSON.stringify({ ...baseManifest, keyId, ...patch });
  return Buffer.from(text + " ".repeat(padding), "utf8");
}

function signatureFile(bytes: Uint8Array, key: TestKey): Buffer {
  return Buffer.from(`${signDetached(null, bytes, key.privateKey).toString("base64")}\n`, "utf8");
}

function verify(
  manifest: Uint8Array,
  signature: Uint8Array,
  keyRing: LinxUpdateTrustedKeys,
  overrides: Partial<LinxUpdateVerificationInput> = {},
) {
  return verifyLinxUpdateManifest({
    manifestBytes: manifest,
    signatureBytes: signature,
    keyRing,
    currentVersion: "0.1.0",
    allowedAssetHosts: ["example.com"],
    ...overrides,
  });
}

describe("Linx update manifest verification", () => {
  it("accepts a manifest signed by a non-first trusted key", () => {
    const first = makeKey();
    const signer = makeKey();
    const bytes = manifestBytes(signer.keyId);
    const signature = signatureFile(bytes, signer);

    const result = verify(bytes, signature, ringOf(first, signer));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.keyId).toBe(signer.keyId);
    expect(result.manifest).toEqual({ ...baseManifest, keyId: signer.keyId });
  });

  it("rejects a manifest changed by one byte", () => {
    const key = makeKey();
    const bytes = manifestBytes(key.keyId);
    const signature = signatureFile(bytes, key);
    const tampered = Buffer.from(bytes);
    tampered[tampered.length - 3] = 0x21; // last byte of the version string

    const result = verify(tampered, signature, ringOf(key));

    expect(result).toMatchObject({ ok: false, reason: "signature" });
    expect(result.ok).toBe(false);
  });

  it("rejects a signature changed by one byte", () => {
    const key = makeKey();
    const bytes = manifestBytes(key.keyId);
    const signature = signatureFile(bytes, key);
    const tampered = Buffer.from(signature);
    tampered[0] = tampered[0] === 0x41 ? 0x42 : 0x41;

    expect(verify(bytes, tampered, ringOf(key))).toMatchObject({
      ok: false,
      reason: "signature",
    });
  });

  it("rejects a manifest that claims a different trusted key than the signer", () => {
    const signer = makeKey();
    const other = makeKey();
    const bytes = manifestBytes(other.keyId);
    const signature = signatureFile(bytes, signer);

    expect(verify(bytes, signature, ringOf(signer, other))).toMatchObject({
      ok: false,
      reason: "key",
      field: "keyId",
    });
  });

  it("rejects a key id that is not in the trusted ring", () => {
    const signer = makeKey();
    const bytes = manifestBytes("0".repeat(16));
    const signature = signatureFile(bytes, signer);

    expect(verify(bytes, signature, ringOf(signer))).toMatchObject({
      ok: false,
      reason: "key",
    });
  });

  it("rejects an empty trusted key ring at the signature stage", () => {
    const key = makeKey();
    const bytes = manifestBytes(key.keyId);

    expect(verify(bytes, signatureFile(bytes, key), new Map())).toMatchObject({
      ok: false,
      reason: "signature",
    });
  });

  it.each([
    ["1.2.3", "same version"],
    ["1.2.2", "downgrade"],
  ])("rejects version %s (%s)", (version) => {
    const key = makeKey();
    const bytes = manifestBytes(key.keyId, { version });

    expect(
      verify(bytes, signatureFile(bytes, key), ringOf(key), { currentVersion: "1.2.3" }),
    ).toMatchObject({ ok: false, reason: "version", field: "version" });
  });

  it.each([["1.2.3-beta.1"], ["1.2"], ["v1.2.3"]])(
    "rejects version grammar %s at the schema stage",
    (version) => {
      const key = makeKey();
      const bytes = manifestBytes(key.keyId, { version });

      expect(verify(bytes, signatureFile(bytes, key), ringOf(key))).toMatchObject({
        ok: false,
        reason: "schema",
        field: "version",
      });
    },
  );

  it("accepts exactly the manifest size limit and rejects one byte more", () => {
    const key = makeKey();
    const exact = manifestBytes(key.keyId, {}, LINX_UPDATE_MANIFEST_MAX_BYTES);
    const exactBytes = exact.subarray(0, LINX_UPDATE_MANIFEST_MAX_BYTES);
    const exactSignature = signatureFile(exactBytes, key);

    expect(exactBytes.byteLength).toBe(LINX_UPDATE_MANIFEST_MAX_BYTES);
    expect(verify(exactBytes, exactSignature, ringOf(key)).ok).toBe(true);

    const oversized = manifestBytes(key.keyId, {}, LINX_UPDATE_MANIFEST_MAX_BYTES + 1);
    expect(verify(oversized, signatureFile(oversized, key), ringOf(key))).toMatchObject({
      ok: false,
      reason: "size",
      field: "manifest",
    });
  });

  it("tolerates trailing whitespace in the signature file", () => {
    const key = makeKey();
    const bytes = manifestBytes(key.keyId);
    const signature = Buffer.concat([signatureFile(bytes, key), Buffer.from(" \n\r\n")]);

    expect(signature.byteLength).toBeLessThanOrEqual(LINX_UPDATE_SIGNATURE_MAX_BYTES);
    expect(verify(bytes, signature, ringOf(key)).ok).toBe(true);
  });

  it("rejects a signature file above the byte limit", () => {
    const key = makeKey();
    const bytes = manifestBytes(key.keyId);
    const oversized = Buffer.concat([
      signatureFile(bytes, key),
      Buffer.alloc(LINX_UPDATE_SIGNATURE_MAX_BYTES, 0x20),
    ]);

    expect(verify(bytes, oversized, ringOf(key))).toMatchObject({
      ok: false,
      reason: "size",
      field: "signature",
    });
  });

  it("rejects a signature that does not decode to 64 bytes", () => {
    const key = makeKey();
    const bytes = manifestBytes(key.keyId);
    const short = Buffer.from(Buffer.alloc(63, 7).toString("base64"), "utf8");

    expect(verify(bytes, short, ringOf(key))).toMatchObject({
      ok: false,
      reason: "size",
      field: "signature",
    });
  });

  it("reports an empty or whitespace-only signature file as size", () => {
    const key = makeKey();
    const bytes = manifestBytes(key.keyId);

    for (const signature of [Buffer.alloc(0), Buffer.from(" \n\t"), Buffer.from("\n")]) {
      expect(verify(bytes, signature, ringOf(key))).toMatchObject({
        ok: false,
        reason: "size",
        field: "signature",
      });
    }
  });

  it("rejects non-base64 signature bytes", () => {
    const key = makeKey();
    const bytes = manifestBytes(key.keyId);

    expect(verify(bytes, Buffer.from("not a signature"), ringOf(key))).toMatchObject({
      ok: false,
      reason: "signature",
    });
  });

  it("rejects validly signed bytes that are not UTF-8 as encoding, not signature", () => {
    const key = makeKey();
    const bytes = Buffer.from([0x7b, 0xff, 0xfe, 0x7d]);

    expect(verify(bytes, signatureFile(bytes, key), ringOf(key))).toMatchObject({
      ok: false,
      reason: "encoding",
    });
  });

  it("rejects validly signed but broken JSON as schema, not signature", () => {
    const key = makeKey();
    const bytes = Buffer.from("{not json", "utf8");

    expect(verify(bytes, signatureFile(bytes, key), ringOf(key))).toMatchObject({
      ok: false,
      reason: "schema",
      field: "manifest",
    });
  });

  it("rejects an unknown manifest field after a valid signature", () => {
    const key = makeKey();
    const bytes = manifestBytes(key.keyId, { installIdentity: "com.wylinx.workbench" });

    const result = verify(bytes, signatureFile(bytes, key), ringOf(key));

    expect(result).toMatchObject({ ok: false, reason: "schema" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.field).not.toBeNull();
  });

  it("rejects an asset host outside the caller allow list", () => {
    const key = makeKey();
    const bytes = manifestBytes(key.keyId, {
      assetUrl: "https://evil.example.net/releases/Linx-1.2.3-arm64.zip",
    });

    expect(verify(bytes, signatureFile(bytes, key), ringOf(key))).toMatchObject({
      ok: false,
      reason: "url",
      field: "assetUrl",
    });
  });

  it("rejects asset hosts that differ only by port", () => {
    const key = makeKey();
    const bytes = manifestBytes(key.keyId, {
      assetUrl: "https://example.com:8443/releases/Linx-1.2.3-arm64.zip",
    });

    expect(verify(bytes, signatureFile(bytes, key), ringOf(key))).toMatchObject({
      ok: false,
      reason: "url",
    });
  });

  it("fails closed when the caller passes no allowed hosts", () => {
    const key = makeKey();
    const bytes = manifestBytes(key.keyId);

    expect(
      verify(bytes, signatureFile(bytes, key), ringOf(key), { allowedAssetHosts: [] }),
    ).toMatchObject({ ok: false, reason: "url" });
  });

  it("treats an unparseable current version as a configuration error", () => {
    const key = makeKey();
    const bytes = manifestBytes(key.keyId);

    expect(() =>
      verify(bytes, signatureFile(bytes, key), ringOf(key), { currentVersion: "1.2" }),
    ).toThrow(LinxUpdateConfigurationError);
  });
});

describe("Linx update trusted key ring loading", () => {
  it("derives the key id and rejects a mismatched declaration", () => {
    const key = makeKey();
    expect(loadLinxUpdateKeyRing(JSON.stringify({ [key.keyId]: key.publicKeyBase64 })).size).toBe(
      1,
    );

    expect(() =>
      loadLinxUpdateKeyRing(JSON.stringify({ ["0".repeat(16)]: key.publicKeyBase64 })),
    ).toThrow(LinxUpdateConfigurationError);
  });

  it("rejects a key ring larger than the byte limit", () => {
    const padded = JSON.stringify({ ["0".repeat(16)]: "A".repeat(17 * 1024) });
    expect(() => loadLinxUpdateKeyRing(padded)).toThrow(LinxUpdateConfigurationError);
  });

  it("rejects malformed JSON and non-object shapes", () => {
    expect(() => loadLinxUpdateKeyRing("[]")).toThrow(LinxUpdateConfigurationError);
    expect(() => loadLinxUpdateKeyRing("{")).toThrow(LinxUpdateConfigurationError);
  });

  it("rejects malformed key records without exposing credential-like values in diagnostics", () => {
    const marker = "credential-value-that-must-not-be-logged";
    let failure: unknown;
    try {
      loadLinxUpdateKeyRing(JSON.stringify({ ["a".repeat(16)]: { privateKey: marker } }));
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(LinxUpdateConfigurationError);
    expect(String(failure)).not.toContain(marker);
  });

  it("rejects keys that are not 44-byte Ed25519 SPKI DER", () => {
    const shortDer = Buffer.alloc(43, 1);
    expect(() =>
      loadLinxUpdateKeyRing(
        JSON.stringify({
          [linxUpdateKeyIdForPublicKeyDer(shortDer)]: shortDer.toString("base64"),
        }),
      ),
    ).toThrow(LinxUpdateConfigurationError);

    const garbage = Buffer.alloc(44, 0xcc);
    expect(() =>
      loadLinxUpdateKeyRing(
        JSON.stringify({
          [linxUpdateKeyIdForPublicKeyDer(garbage)]: garbage.toString("base64"),
        }),
      ),
    ).toThrow(LinxUpdateConfigurationError);
  });

  it("rejects non-canonical base64", () => {
    const key = makeKey();
    expect(() =>
      loadLinxUpdateKeyRing(
        JSON.stringify({ [key.keyId]: key.publicKeyBase64.replace(/=$/u, "") }),
      ),
    ).toThrow(LinxUpdateConfigurationError);
  });
});
