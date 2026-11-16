import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { createHash } from "node:crypto";
import type { BrowserWindow } from "electron";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LINX_PORTABLE_PROFILE_FILE_NAME,
  prepareLinxUpdateProfileRecovery,
  restoreLinxUpdatePortableProfile,
} from "./linxUpdateProfileRecovery";

const mocks = vi.hoisted(() => ({
  operation: vi.fn(),
  execute: vi.fn(),
  handle: vi.fn(),
  unhandle: vi.fn(),
  flush: vi.fn(),
  close: vi.fn(),
}));
vi.mock("./linxLegacyStorage", () => ({
  LINX_BROWSER_DATABASES: [
    { name: "synara-composer-images", store: "images", keyPath: "key", blob: "blob" },
    { name: "synara-appsnap-icons", store: "icons", keyPath: "bundleIdentifier", blob: null },
  ],
  runLinxBrowserStorageOperation: mocks.operation,
}));
vi.mock("electron", () => ({
  session: {
    fromPath: () => ({
      protocol: { handle: mocks.handle, unhandle: mocks.unhandle },
      webRequest: { onBeforeRequest: vi.fn() },
      flushStorageData: mocks.flush,
      closeAllConnections: mocks.close,
    }),
  },
  BrowserWindow: class {
    webContents = { executeJavaScript: mocks.execute };
    loadURL = vi.fn();
    isDestroyed = () => false;
    destroy = vi.fn();
  },
}));
const temporary: string[] = [];
afterEach(async () => {
  vi.clearAllMocks();
  await Promise.all(
    temporary.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "linx-portable-profile-"));
  temporary.push(root);
  const userDataPath = path.join(root, "live-profile");
  await fs.mkdir(userDataPath);
  const snapshotDirectoryPath = path.join(root, "stable-export");
  const window = {
    isDestroyed: () => false,
    webContents: {
      isDestroyed: () => false,
      getURL: () => "linx://app/index.html",
      session: { getStoragePath: () => userDataPath },
    },
  } as unknown as BrowserWindow;
  const blob = Buffer.from("unique unsent draft image");
  const digest = createHash("sha256").update(blob).digest("hex");
  const snapshot = {
    version: 1,
    exportedAt: "2026-11-13T00:00:00.000Z",
    entries: {
      "synara:composer-drafts:v1": JSON.stringify({
        draftsByThreadId: {
          thread: { text: "unsent draft", persistedAttachments: [{ blobKey: "thread:image" }] },
        },
      }),
    },
  };
  mocks.operation.mockImplementation(
    async (_window: unknown, operation: string, args: Record<string, unknown> = {}) => {
      if (operation === "snapshot") return snapshot;
      if (operation === "keys")
        return args.name === "synara-composer-images" ? ["thread:image"] : [];
      if (operation === "metadata")
        return {
          record: {
            key: "thread:image",
            name: "image.png",
            mimeType: "image/png",
            lastModified: 42,
          },
          size: blob.length,
        };
      if (operation === "chunk")
        return blob
          .subarray(args.offset as number, (args.offset as number) + (args.length as number))
          .toString("base64");
      if (operation === "digest") return digest;
      if (operation === "add") return true;
      throw new Error("Unexpected storage operation");
    },
  );
  return { root, userDataPath, snapshotDirectoryPath, window, snapshot, blob, digest };
}

describe("stable logical Chromium profile recovery", () => {
  it("exports drafts, hashed blob bytes and app-owned metadata without copying live Chromium databases", async () => {
    const input = await fixture();
    await fs.mkdir(path.join(input.userDataPath, "IndexedDB"));
    await fs.writeFile(path.join(input.userDataPath, "IndexedDB", "LOCK"), "live database lock");
    await fs.writeFile(path.join(input.userDataPath, "desktop-language.json"), '{"language":"zh"}');
    await fs.mkdir(path.join(input.userDataPath, "appsnap"));
    await fs.writeFile(path.join(input.userDataPath, "appsnap", "pending.png"), input.blob);
    await fs.mkdir(
      path.join(input.userDataPath, "ambient-context-discovery", "grants", "owned-instance"),
      { recursive: true, mode: 0o700 },
    );
    await fs.writeFile(
      path.join(
        input.userDataPath,
        "ambient-context-discovery",
        "grants",
        "owned-instance",
        "owned-vault.json",
      ),
      '{"token":"private-grant"}',
      { mode: 0o600 },
    );
    await fs.mkdir(path.join(input.userDataPath, "ambient-context-discovery", "clients"), {
      mode: 0o700,
    });
    await fs.writeFile(
      path.join(input.userDataPath, "ambient-context-discovery", "clients", "selection.json"),
      '{"selectedInstance":"owned-instance"}',
      { mode: 0o600 },
    );
    for (const name of ["instances", "vaults"]) {
      await fs.mkdir(path.join(input.userDataPath, "ambient-context-discovery", name));
      await fs.writeFile(
        path.join(input.userDataPath, "ambient-context-discovery", name, "heartbeat.json"),
        "reconstructable heartbeat",
      );
    }
    await prepareLinxUpdateProfileRecovery(input);
    const portable = JSON.parse(
      await fs.readFile(
        path.join(input.snapshotDirectoryPath, LINX_PORTABLE_PROFILE_FILE_NAME),
        "utf8",
      ),
    );
    expect(portable.snapshot).toEqual(input.snapshot);
    expect(portable.records[0]).toMatchObject({ key: "thread:image", sha256: input.digest });
    expect(
      await fs.readFile(path.join(input.snapshotDirectoryPath, portable.records[0].file)),
    ).toEqual(input.blob);
    expect(
      await fs.readFile(path.join(input.snapshotDirectoryPath, "desktop-language.json"), "utf8"),
    ).toContain("zh");
    expect(
      await fs.readFile(path.join(input.snapshotDirectoryPath, "appsnap", "pending.png")),
    ).toEqual(input.blob);
    const grant = path.join(
      input.snapshotDirectoryPath,
      "ambient-context-discovery",
      "grants",
      "owned-instance",
      "owned-vault.json",
    );
    expect(await fs.readFile(grant, "utf8")).toContain("private-grant");
    expect((await fs.stat(grant)).mode & 0o777).toBe(0o600);
    const discovery = path.join(input.snapshotDirectoryPath, "ambient-context-discovery");
    expect(await fs.readFile(path.join(discovery, "clients", "selection.json"), "utf8")).toContain(
      "owned-instance",
    );
    for (const name of ["instances", "vaults"])
      await expect(fs.stat(path.join(discovery, name))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      fs.stat(path.join(input.snapshotDirectoryPath, "IndexedDB")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("supports an absent empty source profile without fabricating populated state", async () => {
    const input = await fixture();
    await fs.rmdir(input.userDataPath);
    await prepareLinxUpdateProfileRecovery({ ...input, window: null });
    const portable = JSON.parse(
      await fs.readFile(
        path.join(input.snapshotDirectoryPath, LINX_PORTABLE_PROFILE_FILE_NAME),
        "utf8",
      ),
    );
    expect(portable.snapshot.entries).toEqual({});
    expect(portable.records).toEqual([]);
    expect(mocks.operation).not.toHaveBeenCalled();
  });
  it("refuses unavailable or untrusted renderers for a populated profile", async () => {
    const input = await fixture();
    await fs.writeFile(path.join(input.userDataPath, "owned-settings"), "unique");
    await expect(prepareLinxUpdateProfileRecovery({ ...input, window: null })).rejects.toThrow(
      "trusted live renderer",
    );
    const window = {
      isDestroyed: () => false,
      webContents: { isDestroyed: () => false, getURL: () => "https://untrusted.invalid/" },
    } as unknown as BrowserWindow;
    await expect(prepareLinxUpdateProfileRecovery({ ...input, window })).rejects.toThrow(
      "trusted Linx app origin",
    );
  });
  it("refuses a trusted app URL backed by the temporary bootstrap or nonpersistent session", async () => {
    const input = await fixture();
    for (const storagePath of [null, `${input.userDataPath}.bootstrap`]) {
      const window = {
        isDestroyed: () => false,
        webContents: {
          isDestroyed: () => false,
          getURL: () => "linx://app/index.html",
          session: { getStoragePath: () => storagePath },
        },
      } as unknown as BrowserWindow;
      await expect(prepareLinxUpdateProfileRecovery({ ...input, window })).rejects.toThrow(
        "selected persistent profile",
      );
    }
    await expect(fs.stat(input.snapshotDirectoryPath)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("binds Preview exports to the separate Preview app origin and persistent session", async () => {
    const input = await fixture();
    await expect(prepareLinxUpdateProfileRecovery({ ...input, preview: true })).rejects.toThrow(
      "trusted Linx app origin",
    );
    const window = {
      isDestroyed: () => false,
      webContents: {
        isDestroyed: () => false,
        getURL: () => "linx-preview://app/index.html",
        session: { getStoragePath: () => input.userDataPath },
      },
    } as unknown as BrowserWindow;
    await prepareLinxUpdateProfileRecovery({ ...input, window, preview: true });
    const portable = JSON.parse(
      await fs.readFile(
        path.join(input.snapshotDirectoryPath, LINX_PORTABLE_PROFILE_FILE_NAME),
        "utf8",
      ),
    );
    expect(portable.origin).toBe("linx-preview://app");
    await expect(
      restoreLinxUpdatePortableProfile({ userDataPath: input.snapshotDirectoryPath }),
    ).rejects.toThrow("identity");
  });
  it("rejects changed persisted record metadata even when its blob bytes and keys stay unchanged", async () => {
    const input = await fixture();
    const original = mocks.operation.getMockImplementation()!;
    let reads = 0;
    mocks.operation.mockImplementation(async (...args: unknown[]) => {
      const result = await original(...args);
      if (args[1] === "metadata" && ++reads > 1)
        return { ...result, record: { ...result.record, name: "changed.png" } };
      return result;
    });
    await expect(prepareLinxUpdateProfileRecovery(input)).rejects.toThrow("record changed");
    await expect(
      fs.stat(path.join(input.snapshotDirectoryPath, LINX_PORTABLE_PROFILE_FILE_NAME)),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("refuses missing referenced draft images", async () => {
    const input = await fixture();
    const original = mocks.operation.getMockImplementation()!;
    mocks.operation.mockImplementation(async (...args: unknown[]) =>
      args[1] === "keys" ? [] : original(...args),
    );
    await expect(prepareLinxUpdateProfileRecovery(input)).rejects.toThrow("missing image blob");
  });
  it("refuses changed blob bytes and never labels the snapshot complete", async () => {
    const input = await fixture();
    const original = mocks.operation.getMockImplementation()!;
    mocks.operation.mockImplementation(async (...args: unknown[]) =>
      args[1] === "digest" ? "a".repeat(64) : original(...args),
    );
    await expect(prepareLinxUpdateProfileRecovery(input)).rejects.toThrow(
      "changed during logical export",
    );
    await expect(
      fs.stat(path.join(input.snapshotDirectoryPath, LINX_PORTABLE_PROFILE_FILE_NAME)),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("rejects symlink app metadata and nested export roots", async () => {
    const input = await fixture();
    await fs.symlink(input.root, path.join(input.userDataPath, "appsnap"));
    await expect(prepareLinxUpdateProfileRecovery(input)).rejects.toThrow("symlink");
    await expect(
      prepareLinxUpdateProfileRecovery({
        ...input,
        snapshotDirectoryPath: path.join(input.userDataPath, "nested"),
      }),
    ).rejects.toThrow("outside");
  });
  it("hydrates a verified portable profile only into empty application storage and retains evidence", async () => {
    const input = await fixture();
    await prepareLinxUpdateProfileRecovery(input);
    const original = mocks.operation.getMockImplementation()!;
    mocks.operation.mockImplementation(async (...args: unknown[]) => {
      if (args[1] === "keys") return [];
      if (args[1] === "snapshot")
        return { version: 1, exportedAt: "2026-11-13T00:00:00.000Z", entries: {} };
      return original(...args);
    });
    expect(
      await restoreLinxUpdatePortableProfile({ userDataPath: input.snapshotDirectoryPath }),
    ).toBe(true);
    expect(
      JSON.parse(
        await fs.readFile(
          path.join(input.snapshotDirectoryPath, "synara-storage-origin-v1.json"),
          "utf8",
        ),
      ),
    ).toEqual(input.snapshot);
    expect(
      await fs.stat(
        path.join(input.snapshotDirectoryPath, `${LINX_PORTABLE_PROFILE_FILE_NAME}.restored`),
      ),
    ).toBeTruthy();
    expect(
      await restoreLinxUpdatePortableProfile({ userDataPath: input.snapshotDirectoryPath }),
    ).toBe(false);
    expect(mocks.unhandle).toHaveBeenCalledWith("linx");
  });
  it("refuses corrupt blob bytes, escape paths and newer live browser storage", async () => {
    const input = await fixture();
    await prepareLinxUpdateProfileRecovery(input);
    await expect(
      restoreLinxUpdatePortableProfile({ userDataPath: input.snapshotDirectoryPath }),
    ).rejects.toThrow("nonempty");
    const file = path.join(input.snapshotDirectoryPath, LINX_PORTABLE_PROFILE_FILE_NAME);
    const portable = JSON.parse(await fs.readFile(file, "utf8"));
    const original = mocks.operation.getMockImplementation()!;
    mocks.operation.mockImplementation(async (...args: unknown[]) => {
      if (args[1] === "keys") return [];
      if (args[1] === "snapshot")
        return { version: 1, exportedAt: "2026-11-13T00:00:00.000Z", entries: {} };
      return original(...args);
    });
    await fs.writeFile(
      path.join(input.snapshotDirectoryPath, portable.records[0].file),
      Buffer.alloc(input.blob.length, 88),
    );
    await expect(
      restoreLinxUpdatePortableProfile({ userDataPath: input.snapshotDirectoryPath }),
    ).rejects.toThrow("hash mismatch");
    portable.records[0].file = "../escape";
    await fs.writeFile(file, JSON.stringify(portable));
    await expect(
      restoreLinxUpdatePortableProfile({ userDataPath: input.snapshotDirectoryPath }),
    ).rejects.toThrow("Unsafe portable blob path");
  });
});
