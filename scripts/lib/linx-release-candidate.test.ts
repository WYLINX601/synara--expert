import { describe, expect, it } from "vitest";
import {
  assertImmutableCandidate,
  assertReviewerProtection,
  candidateDigest,
  parseCandidate,
  type LinxReleaseCandidate,
} from "./linx-release-candidate.ts";
const candidate = (): LinxReleaseCandidate => ({
  schemaVersion: 1,
  repository: "WYLINX601/synara--expert",
  version: "0.1.15",
  tag: "v0.1.15",
  sourceCommit: "a".repeat(40),
  lockfileSha256: "b".repeat(64),
  runId: "12345",
  assets: [
    "Linx-0.1.15-arm64.dmg",
    "Linx-0.1.15-arm64.zip",
    "artifact-mac-arm64.provenance.json",
    "linx-update.json",
    "linx-update.json.sig",
    "linx-update-source.json",
  ].map((fileName) => ({ fileName, size: 10, sha256: "c".repeat(64) })),
});
describe("immutable Linx candidate approval", () => {
  it("reuses the same candidate regardless of inventory order", () => {
    const value = candidate();
    const reordered = { ...value, assets: [...value.assets].reverse() };
    expect(candidateDigest(value)).toBe(candidateDigest(reordered));
    expect(() => assertImmutableCandidate(value, reordered)).not.toThrow();
  });
  it.each(["sourceCommit", "lockfileSha256", "runId", "assets"] as const)(
    "rejects a retry changing %s",
    (field) => {
      const value = candidate();
      const changed =
        field === "assets"
          ? {
              ...value,
              assets: value.assets.map((asset, index) =>
                index ? asset : { ...asset, sha256: "d".repeat(64) },
              ),
            }
          : {
              ...value,
              [field]: field === "runId" ? "6789" : "d".repeat(field === "sourceCommit" ? 40 : 64),
            };
      expect(() => assertImmutableCandidate(value, changed)).toThrow("Candidate changed");
    },
  );
  it("rejects partial, duplicate, foreign, traversal and extra-field descriptors", () => {
    const value = candidate();
    for (const assets of [
      value.assets.slice(1),
      [...value.assets, value.assets[0]!],
      value.assets.map((asset, i) => (i ? asset : { ...asset, fileName: "../outside.dmg" })),
      [...value.assets, { fileName: "latest-mac.yml", size: 1, sha256: "e".repeat(64) }],
    ])
      expect(() => parseCandidate({ ...value, assets })).toThrow();
    expect(() => parseCandidate({ ...value, approval: true })).toThrow();
    expect(() => parseCandidate({ ...value, tag: "v1.1.0" })).toThrow();
  });
});
describe("real reviewer protection", () => {
  it("permits explicit maintainer approval but rejects missing reviewers and admin bypass", () => {
    const rule = {
      type: "required_reviewers",
      prevent_self_review: false,
      reviewers: [{ type: "User", reviewer: { id: 1 } }],
    };
    assertReviewerProtection({ protection_rules: [rule], can_admins_bypass: false });
    for (const value of [
      {},
      { protection_rules: [] },
      { protection_rules: [{ ...rule, reviewers: [] }], can_admins_bypass: false },
      { protection_rules: [{ ...rule, prevent_self_review: true }], can_admins_bypass: false },
      {
        protection_rules: [{ type: rule.type, reviewers: rule.reviewers }],
        can_admins_bypass: false,
      },
      {
        protection_rules: [{ ...rule, reviewers: [{ type: "User", reviewer: { id: 0 } }] }],
        can_admins_bypass: false,
      },
      { protection_rules: [rule], can_admins_bypass: true },
    ])
      expect(() => assertReviewerProtection(value)).toThrow("real reviewers");
  });
});
