import { createHash, webcrypto } from "node:crypto";
import { runInNewContext } from "node:vm";
import type { BrowserWindow } from "electron";
import { describe, expect, it, vi } from "vitest";
import { runLinxBrowserStorageOperation } from "./linxLegacyStorage";
import type { LinxBrowserRecordMetadata } from "./linxLegacyStorage";

vi.mock("electron", () => ({ BrowserWindow: vi.fn(), session: {} }));

function browserFixture(
  origin: string,
  entries: Record<string, string>,
  initial: Record<string, Record<string, unknown>[]>,
) {
  const databases = new Map(
    Object.entries(initial).map(([name, records]) => [
      name,
      new Map(
        records.map((record) => [
          String(record.key ?? record.bundleIdentifier),
          structuredClone(record),
        ]),
      ),
    ]),
  );
  // A deterministic transaction/event fixture; production always uses Chromium IndexedDB.
  function request(value: unknown) {
    const result: { result: unknown; onsuccess?: () => void; error?: Error; onerror?: () => void } =
      { result: value };
    queueMicrotask(() => result.onsuccess?.());
    return result;
  }
  const context = {
    Blob,
    Uint8Array,
    crypto: webcrypto,
    btoa: (value: string) => Buffer.from(value, "binary").toString("base64"),
    atob: (value: string) => Buffer.from(value, "base64").toString("binary"),
    localStorage: {
      length: Object.keys(entries).length,
      key: (index: number) => Object.keys(entries)[index] ?? null,
      getItem: (key: string) => entries[key] ?? null,
    },
    indexedDB: {
      open: (name: string) => {
        const isNew = !databases.has(name);
        if (isNew) databases.set(name, new Map());
        const records = databases.get(name)!;
        let keyPath = name === "synara-composer-images" ? "key" : "bundleIdentifier";
        const database = {
          createObjectStore: (_store: string, options: { keyPath: string }) => {
            keyPath = options.keyPath;
          },
          close: () => undefined,
          transaction: () => {
            const transaction: {
              oncomplete?: () => void;
              onerror?: () => void;
              onabort?: () => void;
              error?: Error;
              objectStore: () => unknown;
            } = {
              objectStore: () => ({
                getAllKeys: () => request([...records.keys()]),
                get: (key: string) => request(structuredClone(records.get(key))),
                add: (record: Record<string, unknown>) => {
                  const key = String(record[keyPath]);
                  queueMicrotask(() => {
                    if (records.has(key)) {
                      transaction.error = new Error("ConstraintError: newer record exists");
                      transaction.onerror?.();
                    } else {
                      records.set(key, structuredClone(record));
                      transaction.oncomplete?.();
                    }
                  });
                },
              }),
            };
            return transaction;
          },
        };
        const open: {
          result: typeof database;
          onupgradeneeded?: () => void;
          onsuccess?: () => void;
        } = { result: database };
        queueMicrotask(() => {
          if (isNew) open.onupgradeneeded?.();
          open.onsuccess?.();
        });
        return open;
      },
    },
  };
  const executeJavaScript = async (code: string) => runInNewContext(code, context);
  const window = {
    isDestroyed: () => false,
    webContents: {
      isDestroyed: () => false,
      getURL: () => `${origin}/linx-migration`,
      executeJavaScript,
    },
  } as unknown as BrowserWindow;
  return { window, databases, executeJavaScript };
}
const images = { name: "synara-composer-images", store: "images", keyPath: "key", blob: "blob" };
const icons = {
  name: "synara-appsnap-icons",
  store: "icons",
  keyPath: "bundleIdentifier",
  blob: null,
};

describe("isolated legacy browser storage extraction", () => {
  it("extracts only app-owned localStorage while preserving unsent draft bytes exactly", async () => {
    const draft = JSON.stringify({
      text: "unsent 中文 draft",
      persistedAttachments: [{ blobKey: "thread:image" }],
    });
    const source = browserFixture(
      "workbench://app",
      {
        "synara:composer-drafts:v1": draft,
        "foreign-session": "do not migrate",
        "synara.preference": "true",
      },
      {},
    );
    const result = await runLinxBrowserStorageOperation<{ entries: Record<string, string> }>(
      source.window,
      "snapshot",
    );
    expect(result.entries).toEqual({
      "synara:composer-drafts:v1": draft,
      "synara.preference": "true",
    });
  });
  it("round-trips actual binary Blob contents, file metadata and hashes through the serialized browser operation", async () => {
    const bytes = Buffer.from([0, 255, 13, 10, 128, 42]);
    const record = {
      key: "thread:image",
      blob: new Blob([bytes], { type: "image/png" }),
      name: "draft.png",
      mimeType: "image/png",
      lastModified: 42,
      updatedAt: 71,
    };
    const source = browserFixture("workbench://app", {}, { [images.name]: [record] });
    const target = browserFixture("linx://app", {}, {});
    expect(await runLinxBrowserStorageOperation(source.window, "keys", images)).toEqual([
      record.key,
    ]);
    const metadata = await runLinxBrowserStorageOperation<LinxBrowserRecordMetadata>(
      source.window,
      "metadata",
      { ...images, key: record.key },
    );
    expect(metadata.record).toEqual({
      key: record.key,
      name: record.name,
      mimeType: record.mimeType,
      lastModified: 42,
      updatedAt: 71,
    });
    expect(metadata.size).toBe(bytes.length);
    const chunk = await runLinxBrowserStorageOperation<string>(source.window, "chunk", {
      ...images,
      key: record.key,
      offset: 0,
      length: 256 * 1024,
    });
    expect(Buffer.from(chunk, "base64")).toEqual(bytes);
    await target.executeJavaScript(
      `globalThis.linxBlobParts = [Uint8Array.from(atob(${JSON.stringify(chunk)}), c => c.charCodeAt(0))]`,
    );
    await runLinxBrowserStorageOperation(target.window, "add", {
      ...images,
      key: record.key,
      record: metadata.record,
    });
    const expectedHash = createHash("sha256").update(bytes).digest("hex");
    expect(
      await runLinxBrowserStorageOperation(source.window, "digest", { ...images, key: record.key }),
    ).toBe(expectedHash);
    expect(
      await runLinxBrowserStorageOperation(target.window, "digest", { ...images, key: record.key }),
    ).toBe(expectedHash);
    const restored = target.databases.get(images.name)!.get(record.key)!;
    expect(Buffer.from(await (restored.blob as Blob).arrayBuffer())).toEqual(bytes);
  });
  it("preserves icon records and refuses overwrite of newer target records", async () => {
    const record = {
      bundleIdentifier: "com.example.fixture",
      dataUrl: "data:image/png;base64,AA==",
      updatedAt: 8,
    };
    const target = browserFixture("linx-preview://app", {}, {});
    await runLinxBrowserStorageOperation(target.window, "add", { ...icons, record });
    expect(
      (
        await runLinxBrowserStorageOperation<LinxBrowserRecordMetadata>(target.window, "metadata", {
          ...icons,
          key: record.bundleIdentifier,
        })
      ).record,
    ).toEqual(record);
    await expect(
      runLinxBrowserStorageOperation(target.window, "add", {
        ...icons,
        record: { ...record, updatedAt: 7 },
      }),
    ).rejects.toThrow("newer record exists");
  });
  it("rejects corrupt blob records and untrusted extraction origins", async () => {
    const source = browserFixture(
      "workbench://app",
      {},
      { [images.name]: [{ key: "corrupt", blob: "not binary data" }] },
    );
    await expect(
      runLinxBrowserStorageOperation(source.window, "metadata", { ...images, key: "corrupt" }),
    ).rejects.toThrow("corrupt");
    const untrusted = browserFixture("https://untrusted.invalid", {}, {});
    expect(() => runLinxBrowserStorageOperation(untrusted.window, "snapshot")).toThrow(
      "trusted application origin",
    );
  });
});
