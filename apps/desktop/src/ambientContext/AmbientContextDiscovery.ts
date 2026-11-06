import { randomUUID } from "node:crypto";
import * as Fs from "node:fs/promises";
import * as Path from "node:path";

export const AMBIENT_CONTEXT_DISCOVERY_TTL_MS = 15_000;
const MAX_DISCOVERY_ENTRIES = 128;
const MAX_DISCOVERY_FILE_BYTES = 4_096;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const SAFE_ID = /^[a-f0-9-]{16,128}$/i;

function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

export interface ObsidianVaultDiscovery {
  readonly schemaVersion: 1;
  readonly vaultId: string;
  readonly requestId: string;
  readonly label: string;
  readonly updatedAt: string;
}

export interface SynaraInstanceDiscovery {
  readonly schemaVersion: 1;
  readonly instanceId: string;
  readonly label: string;
  readonly updatedAt: string;
  readonly connections: readonly {
    readonly id: string;
    readonly sourceId: string;
    readonly vaultId: string;
    readonly label: string;
    readonly endpoint: string;
  }[];
}

function validTimestamp(value: unknown, now: number): value is string {
  if (typeof value !== "string") return false;
  const timestamp = Date.parse(value);
  return (
    Number.isFinite(timestamp) &&
    timestamp <= now + 5_000 &&
    now - timestamp <= AMBIENT_CONTEXT_DISCOVERY_TTL_MS
  );
}

async function readJson(path: string): Promise<unknown> {
  const stat = await Fs.lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_DISCOVERY_FILE_BYTES) return null;
  try {
    return JSON.parse(await Fs.readFile(path, "utf8")) as unknown;
  } catch {
    return null;
  }
}

export async function readObsidianVaultDiscoveries(
  directory: string,
  now = Date.now(),
): Promise<readonly ObsidianVaultDiscovery[]> {
  let entries: string[];
  try {
    entries = (await Fs.readdir(directory)).filter(
      (name) => UUID.test(name.slice(0, -5)) && name.endsWith(".json"),
    );
  } catch {
    return [];
  }
  const discoveries: ObsidianVaultDiscovery[] = [];
  for (const name of entries.slice(0, MAX_DISCOVERY_ENTRIES)) {
    let value: unknown;
    try {
      value = await readJson(Path.join(directory, name));
    } catch {
      continue;
    }
    if (!value || typeof value !== "object") continue;
    const record = value as Record<string, unknown>;
    if (
      record.schemaVersion !== 1 ||
      record.vaultId !== name.slice(0, -5) ||
      !isUuid(record.vaultId) ||
      !isUuid(record.requestId) ||
      typeof record.label !== "string" ||
      record.label.length > 128 ||
      !validTimestamp(record.updatedAt, now)
    )
      continue;
    discoveries.push({
      schemaVersion: 1,
      vaultId: record.vaultId,
      requestId: record.requestId,
      label: record.label,
      updatedAt: record.updatedAt,
    });
  }
  return discoveries;
}

export async function readOrCreateInstanceId(userDataDirectory: string): Promise<string> {
  const path = Path.join(userDataDirectory, "ambient-context-instance.json");
  try {
    const value = await readJson(path);
    if (value && typeof value === "object") {
      const instanceId = (value as Record<string, unknown>).instanceId;
      if (isUuid(instanceId)) return instanceId;
    }
  } catch {
    // Generate a fresh profile identity if the prior record was unreadable.
  }
  const instanceId = randomUUID();
  await writeJson(path, { schemaVersion: 1, instanceId });
  return instanceId;
}

export async function writeJson(path: string, value: unknown, mode = 0o600): Promise<void> {
  await Fs.mkdir(Path.dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await Fs.writeFile(temporary, JSON.stringify(value), { mode, flag: "wx" });
    await Fs.rename(temporary, path);
  } catch (error) {
    await Fs.rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function writeInstanceDiscovery(
  directory: string,
  discovery: SynaraInstanceDiscovery,
): Promise<void> {
  await writeJson(Path.join(directory, "instances", `${discovery.instanceId}.json`), discovery);
}

export async function removeInstanceDiscovery(
  directory: string,
  instanceId: string,
): Promise<void> {
  await Fs.rm(Path.join(directory, "instances", `${instanceId}.json`), { force: true });
}

export async function writeConnectionGrant(
  directory: string,
  instanceId: string,
  vaultId: string,
  sourceId: string,
  token: string,
): Promise<void> {
  if (!UUID.test(instanceId) || !UUID.test(vaultId) || !SAFE_ID.test(sourceId)) {
    throw new Error("Invalid Obsidian connection identity.");
  }
  await writeJson(Path.join(directory, "grants", instanceId, `${vaultId}.json`), {
    schemaVersion: 1,
    instanceId,
    vaultId,
    sourceId,
    token,
  });
}

export async function removeConnectionGrant(
  directory: string,
  instanceId: string,
  vaultId: string,
): Promise<void> {
  if (!UUID.test(instanceId) || !UUID.test(vaultId)) return;
  await Fs.rm(Path.join(directory, "grants", instanceId, `${vaultId}.json`), { force: true });
}
