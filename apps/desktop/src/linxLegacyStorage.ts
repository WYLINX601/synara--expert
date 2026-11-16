import { createHash } from "node:crypto";
import * as path from "node:path";
import { BrowserWindow, session } from "electron";
import type { SynaraStorageSnapshot } from "@synara/contracts";
import { validateSynaraStorageSnapshot } from "./desktopStorageMigration";
import { snapshotLinxOfflineUserData } from "@synara/shared/linxUpdateRecovery";

/** Register privileges before app.ready; handlers exist ONLY on the temporary migration sessions. */
export const LINX_LEGACY_STORAGE_SCHEMES = ["workbench", "workbench-preview"] as const;
export const LINX_BROWSER_DATABASES = [
  { name: "synara-composer-images", store: "images", keyPath: "key", blob: "blob" },
  { name: "synara-appsnap-icons", store: "icons", keyPath: "bundleIdentifier", blob: null },
] as const;
const MAX_RECORDS = 2_048;
const MAX_BLOB_BYTES = 64 * 1024 * 1024;
const MAX_TOTAL_BYTES = 512 * 1024 * 1024;
const CHUNK_BYTES = 256 * 1024;

interface BrowserStorageArguments {
  name: string;
  store: string;
  keyPath: string;
  blob: string | null;
  record: Record<string, unknown>;
  key: string;
  offset: number;
  length: number;
}
export interface LinxBrowserRecordMetadata {
  record: Record<string, unknown>;
  size: number;
}
// Self-contained browser code: called only inside a sandboxed, offline blank origin.
async function browserStorageOperation(
  operation: string,
  args: BrowserStorageArguments,
): Promise<unknown> {
  if (operation === "snapshot") {
    const entries: Record<string, string> = {};
    for (let index = 0; index < localStorage.length; index++) {
      const key = localStorage.key(index)!;
      if (key.startsWith("synara:") || key.startsWith("synara."))
        entries[key] = localStorage.getItem(key)!;
    }
    return { version: 1, exportedAt: new Date().toISOString(), entries };
  }
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(args.name, 1);
    request.onupgradeneeded = () =>
      request.result.createObjectStore(args.store, { keyPath: args.keyPath });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("Legacy browser database is busy"));
  });
  try {
    if (operation === "keys")
      return await new Promise((resolve, reject) => {
        const request = database.transaction(args.store).objectStore(args.store).getAllKeys();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    if (operation === "add") {
      const record = args.record;
      if (args.blob) {
        const state = globalThis as unknown as { linxBlobParts?: Uint8Array<ArrayBuffer>[] };
        record[args.blob] = new Blob(state.linxBlobParts!, {
          type: typeof record.mimeType === "string" ? record.mimeType : "",
        });
        delete state.linxBlobParts;
      }
      await new Promise<void>((resolve, reject) => {
        const transaction = database.transaction(args.store, "readwrite");
        transaction.objectStore(args.store).add(record);
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error || new Error("Blob transfer aborted"));
      });
      return true;
    }
    const record = await new Promise<Record<string, unknown> | undefined>((resolve, reject) => {
      const request = database.transaction(args.store).objectStore(args.store).get(args.key);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    if (!record) throw new Error("Legacy browser record is missing");
    const candidate = args.blob ? record[args.blob] : undefined;
    const blob = candidate instanceof Blob ? candidate : undefined;
    if (operation === "metadata") {
      if (args.blob && !(blob instanceof Blob)) throw new Error("Legacy draft blob is corrupt");
      if (args.blob) delete record[args.blob];
      return { record, size: blob?.size || 0 };
    }
    if (operation === "chunk") {
      const bytes = new Uint8Array(
        await blob!.slice(args.offset, args.offset + args.length).arrayBuffer(),
      );
      let binary = "";
      for (const byte of bytes) binary += String.fromCharCode(byte);
      return btoa(binary);
    }
    if (operation === "digest") {
      const digest = await crypto.subtle.digest("SHA-256", await blob!.arrayBuffer());
      return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(
        "",
      );
    }
    throw new Error("Unknown migration storage operation");
  } finally {
    database.close();
  }
}

export function runLinxBrowserStorageOperation<Result = unknown>(
  window: BrowserWindow,
  operation: string,
  args: Record<string, unknown> = {},
): Promise<Result> {
  if (window.isDestroyed() || window.webContents.isDestroyed())
    throw new Error("Migration renderer is unavailable");
  const url = new URL(window.webContents.getURL());
  if (
    url.host !== "app" ||
    !["linx:", "linx-preview:", "workbench:", "workbench-preview:"].includes(url.protocol)
  ) {
    throw new Error("Browser storage operation requires a trusted application origin");
  }
  return window.webContents.executeJavaScript(
    `(${browserStorageOperation.toString()})(${JSON.stringify(operation)},${JSON.stringify(args)})`,
  ) as Promise<Result>;
}

export async function transferLinxLegacyStorage(input: {
  /** A private disposable COPY of the verified source profile, never the live source. */
  isolatedSourceProfilePath: string;
  userDataPath: string;
  preview: boolean;
}): Promise<SynaraStorageSnapshot> {
  const sourceSession = session.fromPath(input.isolatedSourceProfilePath, { cache: false });
  const targetSession = session.fromPath(input.userDataPath, { cache: false });
  const sourceScheme = input.preview ? "workbench-preview" : "workbench";
  const targetScheme = input.preview ? "linx-preview" : "linx";
  const windows: BrowserWindow[] = [];
  const sessions = [
    [sourceSession, sourceScheme],
    [targetSession, targetScheme],
  ] as const;
  try {
    for (const [browserSession, scheme] of sessions) {
      // No app JS, preload, Node, external navigation, service workers or network.
      browserSession.webRequest.onBeforeRequest((details, callback) =>
        callback({ cancel: details.url !== `${scheme}://app/linx-migration` }),
      );
      browserSession.setPermissionRequestHandler((_webContents, _permission, callback) =>
        callback(false),
      );
      browserSession.protocol.handle(
        scheme,
        () =>
          new Response("<!doctype html><meta charset=utf-8>", {
            headers: {
              "Content-Type": "text/html",
              "Content-Security-Policy": "default-src 'none'; script-src 'none'",
            },
          }),
      );
      const window = new BrowserWindow({
        show: false,
        webPreferences: {
          session: browserSession,
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          webSecurity: true,
        },
      });
      windows.push(window);
      window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      await window.loadURL(`${scheme}://app/linx-migration`);
    }
    const source = windows[0]!;
    const target = windows[1]!;
    const snapshot = validateSynaraStorageSnapshot(
      await runLinxBrowserStorageOperation(source, "snapshot"),
    );
    if (!snapshot)
      throw new Error("Legacy browser snapshot exceeds the bounded storage handoff or is corrupt");
    let totalBytes = 0;
    const imageKeys = new Set<string>();
    for (const database of LINX_BROWSER_DATABASES) {
      const keys: unknown[] = await runLinxBrowserStorageOperation(source, "keys", database);
      if (
        keys.length > MAX_RECORDS ||
        keys.some((key) => typeof key !== "string" || key.length > 512)
      )
        throw new Error("Legacy browser record limit exceeded");
      const existing: unknown[] = await runLinxBrowserStorageOperation(target, "keys", database);
      if (existing.length) throw new Error("New-origin blob storage is not empty");
      for (const key of keys) {
        const args = { ...database, key };
        const metadata = await runLinxBrowserStorageOperation<LinxBrowserRecordMetadata>(
          source,
          "metadata",
          args,
        );
        if (
          !Number.isSafeInteger(metadata.size) ||
          metadata.size < 0 ||
          metadata.size > MAX_BLOB_BYTES
        )
          throw new Error("Legacy draft blob size is invalid");
        totalBytes += metadata.size + Buffer.byteLength(JSON.stringify(metadata.record));
        if (totalBytes > MAX_TOTAL_BYTES)
          throw new Error("Legacy browser transfer size limit exceeded");
        if (database.blob) {
          imageKeys.add(key as string);
          const digest = createHash("sha256");
          await target.webContents.executeJavaScript("globalThis.linxBlobParts = []");
          for (let offset = 0; offset < metadata.size; offset += CHUNK_BYTES) {
            const chunk: string = await runLinxBrowserStorageOperation(source, "chunk", {
              ...args,
              offset,
              length: CHUNK_BYTES,
            });
            const bytes = Buffer.from(chunk, "base64");
            if (bytes.length !== Math.min(CHUNK_BYTES, metadata.size - offset))
              throw new Error("Legacy blob chunk is corrupt");
            digest.update(bytes);
            await target.webContents.executeJavaScript(
              `globalThis.linxBlobParts.push(Uint8Array.from(atob(${JSON.stringify(chunk)}), c => c.charCodeAt(0)))`,
            );
          }
          await runLinxBrowserStorageOperation(target, "add", { ...args, record: metadata.record });
          if (
            (await runLinxBrowserStorageOperation(target, "digest", args)) !== digest.digest("hex")
          )
            throw new Error("Transferred draft blob hash mismatch");
        } else {
          await runLinxBrowserStorageOperation(target, "add", { ...args, record: metadata.record });
          const restored = await runLinxBrowserStorageOperation<LinxBrowserRecordMetadata>(
            target,
            "metadata",
            args,
          );
          if (JSON.stringify(restored.record) !== JSON.stringify(metadata.record))
            throw new Error("Transferred icon record mismatch");
        }
      }
    }
    const inspectReferences = (value: unknown): void => {
      if (!value || typeof value !== "object") return;
      for (const [key, child] of Object.entries(value)) {
        if (key === "blobKey" && typeof child === "string" && child && !imageKeys.has(child))
          throw new Error("A preserved draft references a missing image blob");
        inspectReferences(child);
      }
    };
    for (const [key, value] of Object.entries(snapshot.entries)) {
      if (key.includes("composer")) inspectReferences(JSON.parse(value));
    }
    await targetSession.flushStorageData();
    return snapshot;
  } finally {
    for (const window of windows) if (!window.isDestroyed()) window.destroy();
    for (const [browserSession, scheme] of sessions) {
      browserSession.protocol.unhandle(scheme);
      browserSession.webRequest.onBeforeRequest(null);
      browserSession.setPermissionRequestHandler(null);
      await browserSession.closeAllConnections();
      await browserSession.flushStorageData();
    }
  }
}

/** The verified profile is copied solely so Chromium can open its databases without mutating recovery evidence. */
export async function copyLinxLegacyProfileForExtraction(
  recoveryDirectoryPath: string,
  isolatedSourceProfilePath: string,
): Promise<void> {
  await snapshotLinxOfflineUserData({
    userDataPath: path.join(recoveryDirectoryPath, "userData"),
    snapshotDirectoryPath: isolatedSourceProfilePath,
  });
}
