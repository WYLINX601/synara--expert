import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
  compareLinxUpdateVersions,
  isLinxUpdateAssetUrl,
  isLinxUpdateVersionNewer,
  LINX_UPDATE_ASSET_MAX_BYTES,
  LINX_UPDATE_KEY_RING_MAX_KEYS,
  LinxUpdateKeyRing,
  LinxUpdateManifest,
} from "./linxUpdateManifest";

const decodeManifest = Schema.decodeUnknownSync(LinxUpdateManifest);

const validManifest = {
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
  size: 12_345,
  sha256: "b".repeat(64),
  keyId: "c".repeat(16),
} as const;

describe("Linx update manifest contract", () => {
  it("accepts a manifest bound to the Linx installation", () => {
    expect(decodeManifest(validManifest).installIdentity).toBe("com.wylinx.linx");
  });

  it("rejects manifests that do not bind an installation identity", () => {
    const unboundManifest = { ...validManifest };
    Reflect.deleteProperty(unboundManifest, "installIdentity");
    expect(() => decodeManifest(unboundManifest)).toThrow();
  });

  it("rejects unknown fields instead of silently dropping them", () => {
    expect(() =>
      decodeManifest({ ...validManifest, installationPath: "/Applications/Linx.app" }),
    ).toThrow();
    expect(() => decodeManifest({ ...validManifest, signature: "abc" })).toThrow();
  });

  it.each([
    ["schemaVersion", 2],
    ["schemaVersion", "1"],
    ["productId", "synara"],
    ["installIdentity", "com.wylinx.workbench"],
    ["installIdentity", "com.wylinx.linx.preview"],
    ["installIdentity", "com.wylinx.linx\n"],
    ["installIdentity", null],
    ["channel", "beta"],
    ["platform", "mas"],
    ["arch", "x64"],
    ["version", "1.2"],
    ["version", "01.2.3"],
    ["version", "1.2.3.4"],
    ["version", "1.2.3-beta.1"],
    ["version", "1.2.3+build"],
    ["version", "v1.2.3"],
    ["sourceCommit", "A".repeat(40)],
    ["sourceCommit", "a".repeat(39)],
    ["sourceCommit", `${"a".repeat(39)}g`],
    ["minOSVersion", "13.0.0.1"],
    ["minOSVersion", "100"],
    ["minOSVersion", "13."],
    ["assetName", "Linx-1.2.3-arm64.dmg"],
    ["assetName", ""],
    ["assetName", "nested/Linx.zip"],
    ["assetName", "nested\\Linx.zip"],
    ["assetName", "Linx..zip"],
    ["assetName", `${"a".repeat(255)}.zip`],
    ["assetUrl", "http://example.com/Linx.zip"],
    ["assetUrl", "example.com/Linx.zip"],
    ["assetUrl", "https://user:pass@example.com/Linx.zip"],
    ["assetUrl", "https://user@example.com/Linx.zip"],
    ["assetUrl", "https://example.com/Linx.zip#frag"],
    ["size", 0],
    ["size", -1],
    ["size", 1.5],
    ["size", LINX_UPDATE_ASSET_MAX_BYTES + 1],
    ["sha256", "b".repeat(63)],
    ["sha256", "B".repeat(64)],
    ["keyId", "c".repeat(15)],
    ["keyId", "C".repeat(16)],
  ])("rejects %s=%j", (field, value) => {
    expect(() => decodeManifest({ ...validManifest, [field]: value })).toThrow();
  });

  it("accepts the exact size and asset-name boundaries", () => {
    expect(
      decodeManifest({
        ...validManifest,
        size: LINX_UPDATE_ASSET_MAX_BYTES,
        assetName: `${"a".repeat(251)}.zip`,
      }),
    ).toMatchObject({ size: LINX_UPDATE_ASSET_MAX_BYTES });
  });

  it("only accepts absolute https asset URLs without credentials or fragments", () => {
    expect(isLinxUpdateAssetUrl("https://example.com/a.zip")).toBe(true);
    expect(isLinxUpdateAssetUrl("https://example.com:8443/a.zip")).toBe(true);
    expect(isLinxUpdateAssetUrl("http://example.com/a.zip")).toBe(false);
    expect(isLinxUpdateAssetUrl("/a.zip")).toBe(false);
    expect(isLinxUpdateAssetUrl("file:///a.zip")).toBe(false);
    expect(isLinxUpdateAssetUrl("https://u:p@example.com/a.zip")).toBe(false);
    expect(isLinxUpdateAssetUrl("https://example.com/a.zip#x")).toBe(false);
  });

  it("validates the key ring shape and key id grammar", () => {
    const decodeKeyRing = Schema.decodeUnknownSync(LinxUpdateKeyRing);
    const keyId = "d".repeat(16);
    expect(decodeKeyRing({ [keyId]: "AAAA" })).toEqual({ [keyId]: "AAAA" });

    expect(() => decodeKeyRing({ [keyId]: "" })).toThrow();
    expect(() => decodeKeyRing({ [keyId]: "not base64!" })).toThrow();
    expect(() => decodeKeyRing({ [keyId.toUpperCase()]: "AAAA" })).toThrow();

    const tooMany = Object.fromEntries(
      Array.from({ length: LINX_UPDATE_KEY_RING_MAX_KEYS + 1 }, (_, index) => [
        index.toString(16).padStart(16, "0"),
        "AAAA",
      ]),
    );
    expect(() => decodeKeyRing(tooMany)).toThrow();
  });
});

describe("Linx update version ordering", () => {
  it("compares numeric components without float precision loss", () => {
    expect(compareLinxUpdateVersions("1.2.3", "1.2.3")).toBe(0);
    expect(compareLinxUpdateVersions("1.2.10", "1.2.9")).toBeGreaterThan(0);
    expect(compareLinxUpdateVersions("2.0.0", "1.99.99")).toBeGreaterThan(0);
    expect(compareLinxUpdateVersions("1.0.0", "1.0.1")).toBeLessThan(0);
    expect(
      compareLinxUpdateVersions("9007199254740993.0.0", "9007199254740992.0.0"),
    ).toBeGreaterThan(0);
    expect(compareLinxUpdateVersions("9007199254740993.0.0", "9007199254740993.0.0")).toBe(0);
    expect(compareLinxUpdateVersions("1.2.3", "1.2.3-beta")).toBeNull();
    expect(compareLinxUpdateVersions("01.2.3", "1.2.3")).toBeNull();
  });

  it("requires a strictly newer version", () => {
    expect(isLinxUpdateVersionNewer("1.2.4", "1.2.3")).toBe(true);
    expect(isLinxUpdateVersionNewer("1.2.3", "1.2.3")).toBe(false);
    expect(isLinxUpdateVersionNewer("1.2.2", "1.2.3")).toBe(false);
    expect(isLinxUpdateVersionNewer("1.2.3-beta", "1.2.2")).toBe(false);
  });
});
