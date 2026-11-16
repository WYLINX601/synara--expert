// FILE: desktopStorageMigration.ts
// Purpose: Reads and acknowledges a validated browser-storage handoff from older desktop builds.
// Layer: Desktop main-process utility

import * as FS from "node:fs";
import * as Path from "node:path";

import type { SynaraStorageSnapshot } from "@synara/contracts";

export const SYNARA_STORAGE_SNAPSHOT_FILE_NAME = "synara-storage-origin-v1.json";
export const SYNARA_STORAGE_SNAPSHOT_MAX_BYTES = 16 * 1024 * 1024;
export const SYNARA_STORAGE_SNAPSHOT_MAX_ENTRIES = 2_048;
export const SYNARA_STORAGE_SNAPSHOT_MAX_KEY_LENGTH = 512;
export const SYNARA_STORAGE_SNAPSHOT_MAX_VALUE_LENGTH = 16 * 1024 * 1024;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function isSynaraStorageKey(key: string): boolean {
  return key.startsWith("synara:") || key.startsWith("synara.");
}

export function validateSynaraStorageSnapshot(value: unknown): SynaraStorageSnapshot | null {
  if (!isPlainRecord(value) || value.version !== 1 || !isPlainRecord(value.entries)) {
    return null;
  }
  if (typeof value.exportedAt !== "string" || !Number.isFinite(Date.parse(value.exportedAt))) {
    return null;
  }

  const entries = Object.entries(value.entries);
  if (entries.length > SYNARA_STORAGE_SNAPSHOT_MAX_ENTRIES) {
    return null;
  }
  for (const [key, entryValue] of entries) {
    if (
      !isSynaraStorageKey(key) ||
      key.length === 0 ||
      key.length > SYNARA_STORAGE_SNAPSHOT_MAX_KEY_LENGTH ||
      typeof entryValue !== "string" ||
      entryValue.length > SYNARA_STORAGE_SNAPSHOT_MAX_VALUE_LENGTH
    ) {
      return null;
    }
  }

  const snapshot = value as unknown as SynaraStorageSnapshot;
  try {
    if (Buffer.byteLength(JSON.stringify(snapshot), "utf8") > SYNARA_STORAGE_SNAPSHOT_MAX_BYTES) {
      return null;
    }
  } catch {
    return null;
  }
  return snapshot;
}

/** Relocates only structured filesystem fields/keys, never draft text or historical ledger bytes. */
export function relocateSynaraStorageSnapshotPaths(
  snapshot: SynaraStorageSnapshot,
  input: { sourceHomePath: string; homePath: string; sourceAliases?: readonly string[] },
): SynaraStorageSnapshot {
  const sources = [input.sourceHomePath, ...(input.sourceAliases ?? [])].map((value) =>
    Path.resolve(value),
  );
  function relocate(value: string): string {
    if (!Path.isAbsolute(value)) return value;
    for (const source of sources) {
      const relative = Path.relative(source, value);
      if (relative === "") return input.homePath;
      if (!Path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${Path.sep}`))
        return Path.join(input.homePath, relative);
    }
    return value;
  }
  const pathField = /(?:Path|Paths|Directory|Directories|Dir|Dirs|Root|Roots|Cwd|Cwds)$/u;
  const entries: Record<string, string> = {};
  for (const [key, raw] of Object.entries(snapshot.entries)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      entries[key] = raw;
      continue;
    }
    let changed = false;
    function visit(value: unknown, field: string): unknown {
      if (typeof value === "string") {
        if (!pathField.test(field) && !["path", "paths", "cwd"].includes(field)) return value;
        const next = relocate(value);
        if (next !== value) changed = true;
        return next;
      }
      if (Array.isArray(value)) return value.map((child) => visit(child, field));
      if (!isPlainRecord(value)) return value;
      const result: Record<string, unknown> = Object.create(null);
      for (const [name, child] of Object.entries(value)) {
        const nextName = relocate(name);
        if (nextName !== name) changed = true;
        if (Object.hasOwn(result, nextName))
          throw new Error("Stored path relocation would merge conflicting browser data");
        result[nextName] = visit(child, name);
      }
      return result;
    }
    const relocated = visit(parsed, key);
    entries[key] = changed ? JSON.stringify(relocated) : raw;
  }
  const result = validateSynaraStorageSnapshot({ ...snapshot, entries });
  if (!result) throw new Error("Relocated browser handoff exceeds the existing storage bounds");
  return result;
}

export function resolveSynaraStorageSnapshotPath(userDataPath: string): string {
  return Path.join(userDataPath, SYNARA_STORAGE_SNAPSHOT_FILE_NAME);
}

export function readSynaraStorageSnapshot(snapshotPath: string): SynaraStorageSnapshot | null {
  try {
    const stats = FS.statSync(snapshotPath);
    if (!stats.isFile() || stats.size > SYNARA_STORAGE_SNAPSHOT_MAX_BYTES) {
      return null;
    }
    return validateSynaraStorageSnapshot(JSON.parse(FS.readFileSync(snapshotPath, "utf8")));
  } catch {
    return null;
  }
}

export async function acknowledgeSynaraStorageSnapshot(snapshotPath: string): Promise<void> {
  await FS.promises.rm(snapshotPath, { force: true }).catch(() => undefined);
}
