import { createHash } from "node:crypto";
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { BrowserWindow, session } from "electron";
import type { SynaraStorageSnapshot } from "@synara/contracts";
import { canonicalLinxDataPath } from "@synara/shared/linxUpdateRecovery";
import { syncDirectoryEntry } from "@synara/shared/filesystemPlatform";
import { LINX_BROWSER_DATABASES, runLinxBrowserStorageOperation } from "./linxLegacyStorage";
import type { LinxBrowserRecordMetadata } from "./linxLegacyStorage";
import {
  resolveSynaraStorageSnapshotPath,
  validateSynaraStorageSnapshot,
} from "./desktopStorageMigration";

export const LINX_PORTABLE_PROFILE_FILE_NAME = "linx-portable-profile.json";
const CHUNK_BYTES = 256 * 1024;
const MAX_BLOB_BYTES = 64 * 1024 * 1024;
const MAX_TOTAL_BYTES = 512 * 1024 * 1024;
const MAX_RECORDS = 2_048;
const MAX_MANIFEST_BYTES = 64 * 1024 * 1024;
// These are app-owned unique files, NOT Chromium database/cache directories.
const APP_OWNED_PROFILE_PATHS = [
  "desktop-language.json",
  "ambient-context-settings.json",
  "ambient-context-instance.json",
  "ambient-context-connections.json",
  "appsnap",
] as const;
interface PortableRecord {
  database: string;
  key: string;
  record: Record<string, unknown>;
  size: number;
  sha256: string | null;
  file: string | null;
}
interface PortableProfile {
  schemaVersion: 1;
  origin: "linx://app" | "linx-preview://app";
  snapshot: SynaraStorageSnapshot;
  records: PortableRecord[];
}

async function copyAppOwnedPath(source: string, destination: string): Promise<void> {
  const before = await fs.lstat(source).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (before === null) return;
  if (before.isSymbolicLink())
    throw new Error(`App-owned profile metadata is a symlink: ${source}`);
  if (before.isDirectory()) {
    await fs.mkdir(destination, { mode: 0o700 });
    for (const name of (await fs.readdir(source)).sort())
      await copyAppOwnedPath(path.join(source, name), path.join(destination, name));
  } else if (before.isFile()) {
    await fs.copyFile(source, destination, constants.COPYFILE_EXCL);
    await fs.chmod(destination, before.mode & 0o777);
    const handle = await fs.open(destination, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } else throw new Error(`Special app-owned profile file: ${source}`);
  const after = await fs.lstat(source);
  if (
    before.ino !== after.ino ||
    before.dev !== after.dev ||
    before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs ||
    before.ctimeMs !== after.ctimeMs
  )
    throw new Error(`App-owned profile metadata changed: ${source}`);
}

function assertDraftBlobReferences(
  snapshot: SynaraStorageSnapshot,
  records: readonly PortableRecord[],
): void {
  const imageKeys = new Set(
    records
      .filter((record) => record.database === "synara-composer-images")
      .map((record) => record.key),
  );
  const visit = (value: unknown): void => {
    if (value === null || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      if (key === "blobKey" && typeof child === "string" && child && !imageKeys.has(child))
        throw new Error("Draft references a missing image blob");
      visit(child);
    }
  };
  for (const [key, value] of Object.entries(snapshot.entries))
    if (key.includes("composer")) visit(JSON.parse(value));
}

/**
 * Caller holds ALL renderer edit leases and has stopped the backend/producers.
 * Reads transactional logical records through the trusted app origin. Never copies
 * live Chromium databases; the raw profile stays in place throughout installation.
 */
export async function prepareLinxUpdateProfileRecovery(input: {
  window: BrowserWindow | null;
  userDataPath: string;
  snapshotDirectoryPath: string;
  preview?: boolean;
}): Promise<string> {
  const userData = await canonicalLinxDataPath(input.userDataPath);
  const target = await canonicalLinxDataPath(input.snapshotDirectoryPath);
  const relative = path.relative(userData, target);
  if (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  ) {
    throw new Error("Prepared profile export must be outside the live profile");
  }
  const origin = input.preview ? "linx-preview://app" : "linx://app";
  if (input.window === null) {
    const entries = await fs.readdir(userData).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    if (entries.length)
      throw new Error("A populated profile requires its trusted live renderer for recovery export");
  } else {
    if (input.window.isDestroyed() || input.window.webContents.isDestroyed())
      throw new Error("Recovery renderer is unavailable");
    const url = new URL(input.window.webContents.getURL());
    if (url.origin !== origin && `${url.protocol}//${url.host}` !== origin)
      throw new Error("Recovery export requires the trusted Linx app origin");
    const storagePath = input.window.webContents.session.getStoragePath();
    if (storagePath === null || (await canonicalLinxDataPath(storagePath)) !== userData)
      throw new Error("Recovery renderer does not own the selected persistent profile");
  }
  const pendingHandoff = await fs
    .lstat(resolveSynaraStorageSnapshotPath(userData))
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
  if (pendingHandoff)
    throw new Error(
      "An unacknowledged browser migration handoff must complete before preparing an update",
    );
  const stat = await fs.statfs(path.dirname(target), { bigint: true });
  if (stat.bavail * stat.bsize < BigInt(MAX_TOTAL_BYTES + 64 * 1024 * 1024))
    throw new Error("Insufficient space for portable profile export");
  await fs.mkdir(target, { mode: 0o700 });
  await fs.mkdir(path.join(target, "linx-profile-blobs"), { mode: 0o700 });
  const snapshot =
    input.window === null
      ? { version: 1 as const, exportedAt: new Date().toISOString(), entries: {} }
      : validateSynaraStorageSnapshot(
          await runLinxBrowserStorageOperation(input.window, "snapshot"),
        );
  if (!snapshot) throw new Error("Invalid or oversized bounded browser-storage handoff");
  const records: PortableRecord[] = [];
  let total = Buffer.byteLength(JSON.stringify(snapshot));
  if (input.window !== null) {
    for (const database of LINX_BROWSER_DATABASES) {
      const keys = await runLinxBrowserStorageOperation<unknown[]>(input.window, "keys", database);
      if (
        keys.length > MAX_RECORDS ||
        keys.some((key) => typeof key !== "string" || !key || key.length > 512)
      )
        throw new Error("Portable profile record bounds exceeded");
      for (const key of keys as string[]) {
        const args = { ...database, key };
        const metadata = await runLinxBrowserStorageOperation<LinxBrowserRecordMetadata>(
          input.window,
          "metadata",
          args,
        );
        if (
          !Number.isSafeInteger(metadata.size) ||
          metadata.size < 0 ||
          metadata.size > MAX_BLOB_BYTES
        )
          throw new Error("Portable draft blob exceeds bounds");
        if (metadata.record?.[database.keyPath] !== key || (!database.blob && metadata.size !== 0))
          throw new Error("Portable browser record identity is invalid");
        total += metadata.size + Buffer.byteLength(JSON.stringify(metadata.record));
        if (total > MAX_TOTAL_BYTES)
          throw new Error("Portable profile exceeds bounded transfer size");
        let file: string | null = null;
        let sha256: string | null = null;
        if (database.blob) {
          file = `linx-profile-blobs/${createHash("sha256").update(key).digest("hex")}.bin`;
          const output = await fs.open(path.join(target, file), "wx", 0o600);
          const hash = createHash("sha256");
          try {
            for (let offset = 0; offset < metadata.size; offset += CHUNK_BYTES) {
              const chunk = await runLinxBrowserStorageOperation<string>(input.window, "chunk", {
                ...args,
                offset,
                length: CHUNK_BYTES,
              });
              const bytes = Buffer.from(chunk, "base64");
              if (bytes.length !== Math.min(CHUNK_BYTES, metadata.size - offset))
                throw new Error("Draft blob export chunk size mismatch");
              hash.update(bytes);
              await output.writeFile(bytes);
            }
            await output.sync();
          } finally {
            await output.close();
          }
          sha256 = hash.digest("hex");
          if (
            (await runLinxBrowserStorageOperation<string>(input.window, "digest", args)) !== sha256
          )
            throw new Error("Draft blob changed during logical export");
        }
        records.push({
          database: database.name,
          key,
          record: metadata.record,
          size: metadata.size,
          sha256,
          file,
        });
      }
      for (const record of records.filter((record) => record.database === database.name)) {
        const args = { ...database, key: record.key };
        const metadata = await runLinxBrowserStorageOperation<LinxBrowserRecordMetadata>(
          input.window,
          "metadata",
          args,
        );
        if (
          metadata.size !== record.size ||
          JSON.stringify(metadata.record) !== JSON.stringify(record.record) ||
          (database.blob &&
            (await runLinxBrowserStorageOperation<string>(input.window, "digest", args)) !==
              record.sha256)
        ) {
          throw new Error("Browser record changed during held recovery export");
        }
      }
      const finalKeys = await runLinxBrowserStorageOperation<unknown[]>(
        input.window,
        "keys",
        database,
      );
      if (JSON.stringify(keys) !== JSON.stringify(finalKeys))
        throw new Error("Browser records changed during held recovery export");
    }
    const finalSnapshot = validateSynaraStorageSnapshot(
      await runLinxBrowserStorageOperation(input.window, "snapshot"),
    );
    if (
      !finalSnapshot ||
      JSON.stringify(snapshot.entries) !== JSON.stringify(finalSnapshot.entries)
    )
      throw new Error("Browser drafts changed during held recovery export");
  }
  assertDraftBlobReferences(snapshot, records);
  for (const name of APP_OWNED_PROFILE_PATHS)
    await copyAppOwnedPath(path.join(userData, name), path.join(target, name));
  const discoveryPath = path.join(userData, "ambient-context-discovery");
  const discovery = await fs.lstat(discoveryPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (discovery !== null) {
    if (!discovery.isDirectory() || discovery.isSymbolicLink())
      throw new Error("App-owned discovery metadata is not a real directory");
    const destination = path.join(target, "ambient-context-discovery");
    await fs.mkdir(destination, { mode: 0o700 });
    // Companion heartbeats/instance endpoints are reconstructable and can keep
    // changing independently of the native edit lease. Only private grants and
    // durable client authentication/selection belong in portable recovery.
    for (const name of ["grants", "clients"])
      await copyAppOwnedPath(path.join(discoveryPath, name), path.join(destination, name));
  }
  const portable: PortableProfile = { schemaVersion: 1, origin, snapshot, records };
  const text = `${JSON.stringify(portable)}\n`;
  if (Buffer.byteLength(text) > MAX_MANIFEST_BYTES)
    throw new Error("Portable profile metadata exceeds its 64 MiB bound");
  await fs.writeFile(path.join(target, LINX_PORTABLE_PROFILE_FILE_NAME), text, {
    flag: "wx",
    mode: 0o600,
    flush: true,
  });
  await syncDirectoryEntry(path.join(target, "linx-profile-blobs"));
  await syncDirectoryEntry(target);
  return target;
}

/** Hydrates only an explicitly restored portable profile, before normal renderer hydration. */
export async function restoreLinxUpdatePortableProfile(input: {
  userDataPath: string;
  preview?: boolean;
}): Promise<boolean> {
  const root = await canonicalLinxDataPath(input.userDataPath);
  const portablePath = path.join(root, LINX_PORTABLE_PROFILE_FILE_NAME);
  const handle = await fs
    .open(portablePath, constants.O_RDONLY | constants.O_NOFOLLOW)
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
  if (handle === null) return false;
  let portable: PortableProfile;
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_MANIFEST_BYTES)
      throw new Error("Invalid portable profile manifest");
    portable = JSON.parse(await handle.readFile("utf8")) as PortableProfile;
  } finally {
    await handle.close();
  }
  const origin = input.preview ? "linx-preview://app" : "linx://app";
  const snapshot = validateSynaraStorageSnapshot(portable.snapshot);
  if (
    portable.schemaVersion !== 1 ||
    portable.origin !== origin ||
    !snapshot ||
    !Array.isArray(portable.records) ||
    portable.records.length > MAX_RECORDS * LINX_BROWSER_DATABASES.length
  ) {
    throw new Error("Portable profile identity or bounded snapshot is invalid");
  }
  const seen = new Set<string>();
  let total = Buffer.byteLength(JSON.stringify(snapshot));
  for (const record of portable.records) {
    const database = LINX_BROWSER_DATABASES.find((entry) => entry.name === record.database);
    if (
      !database ||
      typeof record.key !== "string" ||
      !record.key ||
      record.key.length > 512 ||
      record.record?.[database.keyPath] !== record.key ||
      !Number.isSafeInteger(record.size) ||
      record.size < 0 ||
      record.size > MAX_BLOB_BYTES ||
      seen.has(`${record.database}:${record.key}`)
    )
      throw new Error("Invalid portable browser record");
    seen.add(`${record.database}:${record.key}`);
    total += record.size + Buffer.byteLength(JSON.stringify(record.record));
    if (total > MAX_TOTAL_BYTES) throw new Error("Portable profile exceeds transfer bounds");
    if (database.blob) {
      const expected = `linx-profile-blobs/${createHash("sha256").update(record.key).digest("hex")}.bin`;
      if (
        record.file !== expected ||
        typeof record.sha256 !== "string" ||
        !/^[a-f0-9]{64}$/u.test(record.sha256)
      )
        throw new Error("Unsafe portable blob path or digest");
      const blobDirectory = await fs.lstat(path.join(root, "linx-profile-blobs"));
      if (!blobDirectory.isDirectory() || blobDirectory.isSymbolicLink())
        throw new Error("Unsafe portable blob directory");
    } else if (record.file !== null || record.sha256 !== null || record.size !== 0)
      throw new Error("Invalid portable icon record");
  }
  assertDraftBlobReferences(snapshot, portable.records);
  const browserSession = session.fromPath(root, { cache: false });
  const scheme = input.preview ? "linx-preview" : "linx";
  let window: BrowserWindow | undefined;
  try {
    browserSession.protocol.handle(
      scheme,
      () =>
        new Response("<!doctype html>", {
          headers: { "Content-Type": "text/html", "Content-Security-Policy": "default-src 'none'" },
        }),
    );
    browserSession.webRequest.onBeforeRequest((details, callback) =>
      callback({ cancel: details.url !== `${origin}/linx-profile-restore` }),
    );
    window = new BrowserWindow({
      show: false,
      webPreferences: {
        session: browserSession,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    await window.loadURL(`${origin}/linx-profile-restore`);
    for (const database of LINX_BROWSER_DATABASES) {
      if ((await runLinxBrowserStorageOperation<unknown[]>(window, "keys", database)).length)
        throw new Error("Portable restore refuses nonempty new-origin storage");
    }
    const current = validateSynaraStorageSnapshot(
      await runLinxBrowserStorageOperation(window, "snapshot"),
    );
    if (!current || Object.keys(current.entries).length)
      throw new Error("Portable restore refuses nonempty new-origin localStorage");
    for (const record of portable.records) {
      const database = LINX_BROWSER_DATABASES.find((entry) => entry.name === record.database)!;
      if (database.blob) {
        const blob = await fs.open(
          path.join(root, record.file!),
          constants.O_RDONLY | constants.O_NOFOLLOW,
        );
        const hash = createHash("sha256");
        await window.webContents.executeJavaScript("globalThis.linxBlobParts = []");
        try {
          const stat = await blob.stat();
          if (!stat.isFile() || stat.size !== record.size)
            throw new Error("Portable draft blob size mismatch");
          const bytes = Buffer.allocUnsafe(CHUNK_BYTES);
          let offset = 0;
          while (offset < record.size) {
            const { bytesRead } = await blob.read(
              bytes,
              0,
              Math.min(CHUNK_BYTES, record.size - offset),
              offset,
            );
            if (bytesRead === 0) throw new Error("Portable draft blob was truncated");
            const chunk = bytes.subarray(0, bytesRead);
            hash.update(chunk);
            await window.webContents.executeJavaScript(
              `globalThis.linxBlobParts.push(Uint8Array.from(atob(${JSON.stringify(chunk.toString("base64"))}), c => c.charCodeAt(0)))`,
            );
            offset += bytesRead;
          }
          if (hash.digest("hex") !== record.sha256)
            throw new Error("Portable draft blob hash mismatch");
        } finally {
          await blob.close();
        }
      }
      await runLinxBrowserStorageOperation(window, "add", {
        ...database,
        key: record.key,
        record: record.record,
      });
      if (
        database.blob &&
        (await runLinxBrowserStorageOperation<string>(window, "digest", {
          ...database,
          key: record.key,
        })) !== record.sha256
      )
        throw new Error("Restored portable draft blob hash mismatch");
    }
    // Existing bounded startup handoff hydrates localStorage before Zustand stores.
    await fs.writeFile(resolveSynaraStorageSnapshotPath(root), `${JSON.stringify(snapshot)}\n`, {
      flag: "wx",
      mode: 0o600,
      flush: true,
    });
    await browserSession.flushStorageData();
    await fs.rename(portablePath, `${portablePath}.restored`);
    await syncDirectoryEntry(root);
    return true;
  } finally {
    if (window && !window.isDestroyed()) window.destroy();
    browserSession.protocol.unhandle(scheme);
    browserSession.webRequest.onBeforeRequest(null);
    await browserSession.closeAllConnections();
  }
}
