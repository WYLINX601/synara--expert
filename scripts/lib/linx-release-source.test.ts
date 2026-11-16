import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { generateLinxUpdateSigningKeyPair } from "./linx-update-manifest-signing.ts";
import {
  assertLinxSigningKeyLineage,
  readLinxReleaseSource,
  validateLinxReleaseSource,
} from "./linx-release-source.ts";

describe("release public trust and key rotation", () => {
  it("fails a formal build without an authorized public source instead of inventing keys", () => {
    const root = mkdtempSync(join(tmpdir(), "linx-source-test-"));
    try {
      expect(() => readLinxReleaseSource(root)).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
    for (const source of [
      { repository: "WYLINX601/synara--expert", keyRing: {} },
      { repository: "other/repository", keyRing: {} },
      { repository: "WYLINX601/synara--expert", keyRing: {}, privateKey: "not allowed" },
    ])
      expect(() => validateLinxReleaseSource(source)).toThrow();
  });
  it("ships a future public key with the old key before allowing its activation", () => {
    const old = generateLinxUpdateSigningKeyPair();
    const next = generateLinxUpdateSigningKeyPair();
    const oldRing = JSON.parse(old.keyRingJson);
    const nextRing = JSON.parse(next.keyRingJson);
    const prior = validateLinxReleaseSource({
      repository: "WYLINX601/synara--expert",
      keyRing: oldRing,
    });
    const expanded = validateLinxReleaseSource({
      repository: prior.repository,
      keyRing: { ...oldRing, ...nextRing },
    });
    expect(() => assertLinxSigningKeyLineage(expanded, old.keyId, prior)).not.toThrow();
    expect(() => assertLinxSigningKeyLineage(expanded, next.keyId, prior)).toThrow(
      "authenticated prior release",
    );
    expect(() => assertLinxSigningKeyLineage(expanded, next.keyId, expanded)).not.toThrow();
    expect(() => assertLinxSigningKeyLineage(prior, next.keyId, expanded)).toThrow();
  });
});
