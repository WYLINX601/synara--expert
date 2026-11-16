import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  LinxHomeOwnershipNonce,
  LinxHomeOwnershipRecord,
  compareLinxInstalledAppVersions,
} from "./linxUpdateHomeOwnership";

const decode = Schema.decodeUnknownSync(LinxHomeOwnershipRecord);
const fixture = () => ({
  schemaVersion: 1,
  guardId: "c79746cd-3311-4a12-88d2-3c42fb4f1204",
  uid: 501,
  homePath: "/Users/fixture/.linx",
  userDataPath: "/Users/fixture/Library/profile",
  applicationPath: "/Applications/Linx.app",
  version: "0.1.15",
  generation: 1,
  updatedAt: "2026-11-13T00:00:00.000Z",
  owner: { pid: 99, startedAt: "Fri Nov 13 10:00:00 2026" },
  nonceDigest: "a".repeat(64),
  adopted: true,
  members: [],
});
describe("whole-home ownership records", () => {
  it("accepts bound owners and clean persistent guards", () => {
    expect(decode(fixture())).toEqual(fixture());
    expect(
      decode({ ...fixture(), owner: null, nonceDigest: null, adopted: false }).owner,
    ).toBeNull();
  });
  it.each([
    { owner: null },
    { nonceDigest: null },
    { owner: null, nonceDigest: null },
    { generation: 0 },
    { owner: { pid: -1, startedAt: "unknown" } },
    { nonce: "plaintext-secret" },
    { homePath: "/home/../escape" },
    { owner: { pid: 99, startedAt: "a\nb" } },
    { version: "1.0.0-preview.01" },
  ])("rejects inconsistent/unbounded binding %j", (change) => {
    expect(() => decode({ ...fixture(), ...change })).toThrow();
  });
  it("rejects duplicate and future-generation cohort memberships", () => {
    const member = {
      id: "c79746cd-3311-4a12-88d2-3c42fb4f1204",
      role: "server",
      process: { pid: 100, startedAt: "Fri Nov 13 10:00:01 2026" },
      joinedGeneration: 1,
    };
    expect(() => decode({ ...fixture(), members: [member, member] })).toThrow();
    expect(() => decode({ ...fixture(), members: [{ ...member, joinedGeneration: 2 }] })).toThrow();
  });
  it("accepts only full-entropy encoded grant shapes", () => {
    const nonce = Schema.decodeUnknownSync(LinxHomeOwnershipNonce);
    expect(nonce("a".repeat(64))).toBe("a".repeat(64));
    expect(() => nonce("short")).toThrow();
    expect(() => nonce("A".repeat(64))).toThrow();
  });
  it("compares real Preview semver with stable precedence and no numeric precision loss", () => {
    expect(decode({ ...fixture(), version: "0.1.0-preview.1" }).version).toBe("0.1.0-preview.1");
    expect(compareLinxInstalledAppVersions("0.1.0-preview.10", "0.1.0-preview.9")).toBeGreaterThan(
      0,
    );
    expect(compareLinxInstalledAppVersions("0.1.0", "0.1.0-preview.999")).toBeGreaterThan(0);
    expect(
      compareLinxInstalledAppVersions("9007199254740993.0.0-preview.1", "9007199254740992.0.0"),
    ).toBeGreaterThan(0);
    expect(compareLinxInstalledAppVersions("0.1.0+build.2", "0.1.0+build.1")).toBe(0);
    expect(compareLinxInstalledAppVersions("0.1.0-preview.01", "0.1.0")).toBeNull();
  });
});
