import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  verifyReleaseArtifactCheckpoint,
  type ReleaseArtifactCheckpointInput,
} from "./release-artifact-checkpoint.ts";
import type { ReleaseArtifactProvenanceManifest } from "./release-artifact-provenance.ts";
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
function fixture() {
  const assetsDirectory = mkdtempSync(join(tmpdir(), "linx-checkpoint-test-"));
  roots.push(assetsDirectory);
  const input: ReleaseArtifactCheckpointInput = {
    assetsDirectory,
    platform: "mac",
    arch: "arm64",
    target: "dmg",
    flavor: "workbench",
    version: "0.1.15",
    sourceCommit: "a".repeat(40),
    sourceTag: "v0.1.15",
    lockfileSha256: "b".repeat(64),
    publication: true,
  };
  const manifest: ReleaseArtifactProvenanceManifest = {
    schemaVersion: 1,
    publication: true,
    platform: "mac",
    arch: "arm64",
    target: "dmg",
    version: input.version,
    source: {
      commit: input.sourceCommit,
      tag: input.sourceTag,
      lockfileSha256: input.lockfileSha256,
    },
    signing: {
      status: "verified",
      scheme: "linx-ad-hoc",
      identity: { bundleId: "com.wylinx.linx" },
      checks: ["isolated recorded structural evidence fixture"],
    },
    artifacts: ["dmg", "zip"].map((ext) => {
      const fileName = `Linx-0.1.15-arm64.${ext}`;
      const bytes = `fixture-${ext}`;
      writeFileSync(join(assetsDirectory, fileName), bytes);
      return {
        fileName,
        size: Buffer.byteLength(bytes),
        sha256: createHash("sha256").update(bytes).digest("hex"),
      };
    }),
  };
  const save = () =>
    writeFileSync(
      join(assetsDirectory, "artifact-mac-arm64.provenance.json"),
      JSON.stringify(manifest),
    );
  save();
  return { input, manifest, save };
}
describe("Linx same-run qualification checkpoint", () => {
  it("accepts the exact sealed DMG/ZIP inventory without retired feed aliases", async () => {
    const { input } = fixture();
    expect((await verifyReleaseArtifactCheckpoint(input)).signing.scheme).toBe("linx-ad-hoc");
  });
  it("refuses mutated bytes, incomplete artifacts and retired updater metadata", async () => {
    const first = fixture();
    writeFileSync(join(first.input.assetsDirectory, "Linx-0.1.15-arm64.zip"), "changed-zip");
    await expect(verifyReleaseArtifactCheckpoint(first.input)).rejects.toThrow();
    const second = fixture();
    rmSync(join(second.input.assetsDirectory, "Linx-0.1.15-arm64.dmg"));
    await expect(verifyReleaseArtifactCheckpoint(second.input)).rejects.toThrow();
    const third = fixture();
    writeFileSync(join(third.input.assetsDirectory, "latest-mac.yml"), "stale feed");
    await expect(verifyReleaseArtifactCheckpoint(third.input)).rejects.toThrow("inventory");
  });
  it("refuses unqualified signing or a foreign source/platform on retry", async () => {
    const { input, manifest } = fixture();
    await expect(
      verifyReleaseArtifactCheckpoint({ ...input, sourceCommit: "c".repeat(40) }),
    ).rejects.toThrow("source commit");
    await expect(verifyReleaseArtifactCheckpoint({ ...input, arch: "x64" })).rejects.toThrow(
      "Invalid expected",
    );
    writeFileSync(
      join(input.assetsDirectory, "artifact-mac-arm64.provenance.json"),
      JSON.stringify({
        ...manifest,
        signing: {
          status: "unsigned-build-only",
          scheme: "none",
          identity: null,
          checks: ["unsigned"],
        },
      }),
    );
    await expect(verifyReleaseArtifactCheckpoint(input)).rejects.toThrow("signing status");
  });
});
