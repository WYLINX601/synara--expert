import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { LinxUpdateRecoveryManifest } from "./linxUpdateRecovery";

const decode = Schema.decodeUnknownSync(LinxUpdateRecoveryManifest);
const fixture = () => ({
  schemaVersion: 1,
  attemptId: "f421dcce-f2e6-4b0f-8649-45ba922bf62f",
  sourceVersion: "0.1.15",
  createdAt: "2026-11-13T00:00:00.000Z",
  homePath: "/private/fixtures/home",
  userDataPath: "/private/fixtures/profile",
  userDataFormat: "offline-profile",
  managedRepositories: [],
  entries: [
    {
      root: "home",
      path: "",
      kind: "directory",
      mode: 0o700,
      size: 0,
      sha256: null,
      linkTarget: null,
    },
  ],
});
describe("Linx recovery manifest", () => {
  it("accepts a bounded versioned inventory", () => expect(decode(fixture())).toEqual(fixture()));
  it("preserves Preview source-version identity without broadening signed update versions", () => {
    expect(decode({ ...fixture(), sourceVersion: "0.1.0-preview.1" }).sourceVersion).toBe(
      "0.1.0-preview.1",
    );
  });
  it.each(["../escape", "folder/../escape", "/absolute", "folder//file", "folder\\file", "a\0b"])(
    "rejects unsafe relative path %s",
    (relative) => {
      const value = fixture();
      expect(() =>
        decode({ ...value, entries: [{ ...value.entries[0], path: relative }] }),
      ).toThrow();
    },
  );
  it.each([
    { schemaVersion: 2 },
    { attemptId: "replay" },
    { sourceVersion: "1.0.0-preview.01" },
    { homePath: "/x/../y" },
    { callerKeyRing: {} },
  ])("rejects malformed or unknown binding %j", (change) => {
    expect(() => decode({ ...fixture(), ...change })).toThrow();
  });
  it.each([
    { kind: "file", path: "db", sha256: null },
    { kind: "directory", sha256: "a".repeat(64) },
    { kind: "symlink", path: "link", linkTarget: null },
    { mode: 0o1777 },
    { size: -1 },
  ])("rejects inconsistent entry metadata %j", (change) => {
    const value = fixture();
    expect(() => decode({ ...value, entries: [{ ...value.entries[0], ...change }] })).toThrow();
  });
  it("rejects duplicate inventory entries and app-home/profile aliases", () => {
    const value = fixture();
    expect(() => decode({ ...value, entries: [...value.entries, ...value.entries] })).toThrow();
    expect(() => decode({ ...value, userDataPath: value.homePath })).toThrow();
  });
  it("rejects ambiguous repository registrations, duplicate refs and mixed Git object formats", () => {
    const worktree = {
      path: "worktrees/thread",
      registrationName: "thread",
      head: "a".repeat(40),
      refs: [{ name: "refs/synara/checkpoints/dGhyZWFk/turn/1", oid: "b".repeat(40) }],
    };
    const repository = {
      id: "c".repeat(64),
      commonPath: "/private/external/.git",
      device: "1",
      inode: "2",
      configSha256: "d".repeat(64),
      objectFormat: "sha1",
      retainedHeads: ["e".repeat(40)],
      sharedIndexes: [],
      worktrees: [worktree],
    };
    const value = { ...fixture(), managedRepositories: [repository] };
    expect(decode(value).managedRepositories).toHaveLength(1);
    expect(() => decode({ ...value, managedRepositories: [repository, repository] })).toThrow();
    for (const change of [
      { worktrees: [worktree, worktree] },
      { retainedHeads: ["e".repeat(40), "e".repeat(40)] },
      { worktrees: [{ ...worktree, refs: [...worktree.refs, ...worktree.refs] }] },
      { objectFormat: "sha256" },
    ])
      expect(() =>
        decode({ ...value, managedRepositories: [{ ...repository, ...change }] }),
      ).toThrow();
  });
});
