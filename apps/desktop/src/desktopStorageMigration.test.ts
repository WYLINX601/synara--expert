import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";

import { describe, expect, it } from "vitest";

import {
  acknowledgeSynaraStorageSnapshot,
  readSynaraStorageSnapshot,
  SYNARA_STORAGE_SNAPSHOT_MAX_BYTES,
  validateSynaraStorageSnapshot,
  relocateSynaraStorageSnapshotPaths,
} from "./desktopStorageMigration";

const snapshot = () => ({
  version: 1 as const,
  exportedAt: "2026-07-09T00:00:00.000Z",
  entries: {
    "synara:theme": "dark",
    "synara.openUsage.enabled": "true",
  },
});

describe("desktopStorageMigration", () => {
  it("reads a legacy snapshot and removes it after acknowledgement", async () => {
    const directory = FS.mkdtempSync(Path.join(OS.tmpdir(), "synara-storage-migration-"));
    const target = Path.join(directory, "snapshot.json");
    try {
      FS.writeFileSync(target, `${JSON.stringify(snapshot())}\n`);
      expect(readSynaraStorageSnapshot(target)).toEqual(snapshot());

      await acknowledgeSynaraStorageSnapshot(target);
      expect(readSynaraStorageSnapshot(target)).toBeNull();
    } finally {
      FS.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects malformed, disallowed, and oversized snapshots", () => {
    expect(validateSynaraStorageSnapshot({ version: 1 })).toBeNull();
    expect(
      validateSynaraStorageSnapshot({
        ...snapshot(),
        entries: { "foreign:theme": "dark" },
      }),
    ).toBeNull();
    expect(
      validateSynaraStorageSnapshot({
        ...snapshot(),
        entries: { "synara:large": "x".repeat(SYNARA_STORAGE_SNAPSHOT_MAX_BYTES) },
      }),
    ).toBeNull();
  });

  it("accepts renderer snapshots containing large composer drafts", () => {
    const largeDraft = "x".repeat(2 * 1024 * 1024);

    expect(
      validateSynaraStorageSnapshot({
        ...snapshot(),
        entries: { "synara:composer-drafts:v1": largeDraft },
      })?.entries["synara:composer-drafts:v1"],
    ).toBe(largeDraft);
  });

  it("relocates managed draft/editor/UI paths without rewriting unsent text or external workspaces", () => {
    const source = {
      ...snapshot(),
      entries: {
        "synara:composer-drafts:v1": JSON.stringify({
          state: {
            draftsByThreadId: {
              thread: {
                text: "/old-home/keep-this-text",
                persistedAttachments: [{ blobKey: "thread:image" }],
              },
            },
            draftThreadsByThreadId: {
              thread: { worktreePath: "/old-home/worktrees/a", workingDirectory: "/external/repo" },
            },
          },
          version: 6,
        }),
        "synara:renderer-state:v8": JSON.stringify({
          projectNamesByCwd: { "/old-home/projects/a": "Personal name" },
          expandedProjectCwds: ["/old-home/projects/a", "/external/repo"],
        }),
        "synara:editor-state": JSON.stringify({
          absolutePath: "/old-home/projects/a/file.ts",
          notes: "/old-home/keep-note",
        }),
      },
    };
    const result = relocateSynaraStorageSnapshotPaths(source, {
      sourceHomePath: "/old-home",
      homePath: "/new-home",
    });
    const drafts = JSON.parse(result.entries["synara:composer-drafts:v1"]!);
    expect(drafts.state.draftsByThreadId.thread.text).toBe("/old-home/keep-this-text");
    expect(drafts.state.draftsByThreadId.thread.persistedAttachments[0].blobKey).toBe(
      "thread:image",
    );
    expect(drafts.state.draftThreadsByThreadId.thread).toEqual({
      worktreePath: "/new-home/worktrees/a",
      workingDirectory: "/external/repo",
    });
    expect(JSON.parse(result.entries["synara:renderer-state:v8"]!)).toEqual({
      projectNamesByCwd: { "/new-home/projects/a": "Personal name" },
      expandedProjectCwds: ["/new-home/projects/a", "/external/repo"],
    });
    expect(JSON.parse(result.entries["synara:editor-state"]!)).toEqual({
      absolutePath: "/new-home/projects/a/file.ts",
      notes: "/old-home/keep-note",
    });
  });

  it("refuses path-key collisions instead of silently merging newer browser data", () => {
    expect(() =>
      relocateSynaraStorageSnapshotPaths(
        {
          ...snapshot(),
          entries: {
            "synara:renderer-state:v8": JSON.stringify({
              projectNamesByCwd: { "/old/a": "old", "/new/a": "new" },
            }),
          },
        },
        { sourceHomePath: "/old", homePath: "/new" },
      ),
    ).toThrow("merge");
  });

  it("treats missing and malformed files as absent", () => {
    const directory = FS.mkdtempSync(Path.join(OS.tmpdir(), "synara-storage-migration-"));
    const target = Path.join(directory, "snapshot.json");
    try {
      expect(readSynaraStorageSnapshot(target)).toBeNull();
      FS.writeFileSync(target, "not json");
      expect(readSynaraStorageSnapshot(target)).toBeNull();
    } finally {
      FS.rmSync(directory, { recursive: true, force: true });
    }
  });
});
