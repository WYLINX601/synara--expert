import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";

import type { LinxUpdateManifest } from "@synara/contracts";

import { resolveLinxUpdateReleaseReceipt, revalidateLinxUpdateRelease } from "./linxUpdateRelease";
import type { LinxUpdateSource } from "./linxUpdateSource";

function fixture() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const keyId = createHash("sha256")
    .update(publicKey.export({ type: "spki", format: "der" }))
    .digest("hex")
    .slice(0, 16);
  const manifest: LinxUpdateManifest = {
    schemaVersion: 1,
    productId: "linx",
    installIdentity: "com.wylinx.linx",
    channel: "stable",
    platform: "darwin",
    arch: "arm64",
    version: "0.2.0",
    sourceCommit: "a".repeat(40),
    minOSVersion: "13.0",
    assetName: "linx-0.2.0.zip",
    assetUrl: "https://github.com/owner/repo/releases/download/v0.2.0/linx-0.2.0.zip",
    size: 1234,
    sha256: "b".repeat(64),
    keyId,
  };
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  const signatureBytes = Buffer.from(sign(null, manifestBytes, privateKey).toString("base64"));
  const manifestDigest = createHash("sha256").update(manifestBytes).digest("hex");
  const source: LinxUpdateSource = {
    repository: "owner/repo",
    keyRing: new Map([[keyId, publicKey]]),
    manifestUrl: "https://github.com/owner/repo/releases/latest/download/linx-update.json",
    signatureUrl: "https://github.com/owner/repo/releases/latest/download/linx-update.json.sig",
    releaseUrl: "https://github.com/owner/repo/releases/latest",
    allowedAssetHosts: ["github.com", "api.github.com", "release-assets.githubusercontent.com"],
  };
  const release = {
    id: 101,
    draft: false,
    prerelease: false,
    tag_name: "v0.2.0",
    published_at: "2026-11-13T00:00:00Z",
    html_url: "https://github.com/owner/repo/releases/tag/v0.2.0",
    assets: [
      {
        id: 201,
        name: manifest.assetName,
        size: manifest.size,
        state: "uploaded",
        browser_download_url: manifest.assetUrl,
      },
      {
        id: 202,
        name: "linx-update.json",
        size: manifestBytes.length,
        state: "uploaded",
        browser_download_url:
          "https://github.com/owner/repo/releases/download/v0.2.0/linx-update.json",
      },
      {
        id: 203,
        name: "linx-update.json.sig",
        size: signatureBytes.length,
        state: "uploaded",
        browser_download_url:
          "https://github.com/owner/repo/releases/download/v0.2.0/linx-update.json.sig",
      },
    ],
  };
  const reference = {
    ref: "refs/tags/v0.2.0",
    object: { type: "commit", sha: manifest.sourceCommit },
  };
  const fetchBytes = async (url: string): Promise<Uint8Array> => {
    if (url.endsWith("/releases/tags/v0.2.0")) return Buffer.from(JSON.stringify(release));
    if (url.endsWith("/git/ref/tags/v0.2.0")) return Buffer.from(JSON.stringify(reference));
    if (url.endsWith("/linx-update.json.sig")) return signatureBytes;
    if (url.endsWith("/linx-update.json")) return manifestBytes;
    throw new Error("Unexpected fixture route");
  };
  const input = { source, manifest, manifestDigest, manifestBytes, signatureBytes, fetchBytes };
  return { input, release, reference };
}

describe("pinned public Linx release", () => {
  it("binds the package, signed pair, release and exact tag commit", async () => {
    const { input } = fixture();
    const receipt = await resolveLinxUpdateReleaseReceipt(input);
    expect(receipt).toMatchObject({
      releaseId: 101,
      packageAssetId: 201,
      manifestAssetId: 202,
      signatureAssetId: 203,
      tagObjectSha: input.manifest.sourceCommit,
      sourceCommit: input.manifest.sourceCommit,
      manifestDigest: input.manifestDigest,
    });
    await expect(
      revalidateLinxUpdateRelease({ ...input, receipt, currentVersion: "0.1.0" }),
    ).resolves.toMatchObject({ releaseId: 101 });
  });

  it.each([
    ["draft", true],
    ["prerelease", true],
    ["published_at", null],
    ["tag_name", "v0.3.0"],
    ["html_url", "https://github.com/other/repo/releases/tag/v0.2.0"],
  ] as const)("rejects a non-public or different release: %s", async (field, value) => {
    const { input, release } = fixture();
    Object.assign(release, { [field]: value });
    await expect(resolveLinxUpdateReleaseReceipt(input)).rejects.toThrow();
  });

  it.each(["size", "state", "browser_download_url"] as const)(
    "rejects changed package metadata: %s",
    async (field) => {
      const { input, release } = fixture();
      Object.assign(release.assets[0]!, {
        [field]:
          field === "size"
            ? 1235
            : field === "state"
              ? "starter"
              : `${input.manifest.assetUrl}?token=not-canonical`,
      });
      await expect(resolveLinxUpdateReleaseReceipt(input)).rejects.toThrow();
    },
  );

  it("rejects duplicate or missing signed assets", async () => {
    const { input, release } = fixture();
    release.assets.push({ ...release.assets[1]!, id: 204 });
    await expect(resolveLinxUpdateReleaseReceipt(input)).rejects.toThrow();
    release.assets.splice(1);
    await expect(resolveLinxUpdateReleaseReceipt(input)).rejects.toThrow();
  });

  it("rejects a tag not pointing at the signed source", async () => {
    const { input, reference } = fixture();
    reference.object.sha = "c".repeat(40);
    await expect(resolveLinxUpdateReleaseReceipt(input)).rejects.toThrow();
  });

  it("refuses withdrawn or replaced assets even when their bytes would match", async () => {
    const { input, release } = fixture();
    const receipt = await resolveLinxUpdateReleaseReceipt(input);
    release.assets[0]!.id = 301;
    await expect(
      revalidateLinxUpdateRelease({ ...input, receipt, currentVersion: "0.1.0" }),
    ).rejects.toThrow();
    release.assets.length = 0;
    await expect(
      revalidateLinxUpdateRelease({ ...input, receipt, currentVersion: "0.1.0" }),
    ).rejects.toThrow();
  });

  it("refuses changed signed bytes without adopting the latest version", async () => {
    const { input } = fixture();
    const receipt = await resolveLinxUpdateReleaseReceipt(input);
    const fetchBytes = async (url: string) =>
      url.endsWith("/linx-update.json")
        ? Buffer.from(JSON.stringify({ ...input.manifest, version: "0.3.0" }))
        : input.fetchBytes(url);
    await expect(
      revalidateLinxUpdateRelease({ ...input, receipt, fetchBytes, currentVersion: "0.1.0" }),
    ).rejects.toThrow();
  });

  it("propagates offline validation refusal instead of trusting cached metadata", async () => {
    const { input } = fixture();
    const receipt = await resolveLinxUpdateReleaseReceipt(input);
    await expect(
      revalidateLinxUpdateRelease({
        ...input,
        receipt,
        currentVersion: "0.1.0",
        fetchBytes: async () => {
          throw new Error("offline");
        },
      }),
    ).rejects.toThrow("offline");
  });
});
