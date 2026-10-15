import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { createRequire } from "node:module";
import { lstat, open } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type { McpConfigSourceReference, McpDiscoverySource } from "@synara/contracts";

import { openReadOnlyDatabase } from "../providerUsage/sqlite.ts";

const require = createRequire(import.meta.url);
const parseToml = (text: string): unknown =>
  (require("toml") as { parse: (value: string) => unknown }).parse(text);

const MAX_SOURCE_TEXT_BYTES = 1024 * 1024;
const MAX_SOURCE_ENTRIES = 1_000;
const MAX_CC_SWITCH_DATABASE_BYTES = 64 * 1024 * 1024;

export type ResolvedMcpSource = {
  readonly kind: McpDiscoverySource["kind"];
  readonly path: string;
};

export type McpSourceEntry = {
  readonly entryId: string;
  readonly name: string;
  readonly config: unknown;
  readonly sourceEnabled?: boolean;
  readonly digest: string;
  readonly malformed?: boolean;
};

export class McpSourceReadError extends Error {
  constructor(readonly code: "missing" | "invalid" | "unavailable") {
    super("MCP source is unavailable.");
    this.name = "McpSourceReadError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.hasOwn(record, key);
}

function isSafeEntryId(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 1_024 &&
    value.trim() === value &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

function sourceReadError(error: unknown): McpSourceReadError {
  if (error instanceof McpSourceReadError) return error;
  return new McpSourceReadError(errorCode(error) === "ENOENT" ? "missing" : "unavailable");
}

export function resolveMcpSourcePath(
  source: McpDiscoverySource,
  homeDir: string = homedir(),
): ResolvedMcpSource {
  if (!isAbsolute(homeDir)) throw new McpSourceReadError("invalid");

  let rawPath = source.path;
  if (rawPath === undefined) {
    if (source.kind === "codex") rawPath = join(homeDir, ".codex", "config.toml");
    else if (source.kind === "cc-switch") rawPath = join(homeDir, ".cc-switch", "cc-switch.db");
    else throw new McpSourceReadError("invalid");
  }

  let expanded = rawPath;
  if (rawPath === "~") expanded = homeDir;
  else if (rawPath.startsWith("~/") || rawPath.startsWith("~\\")) {
    expanded = join(homeDir, rawPath.slice(2));
  } else if (rawPath.startsWith("~")) {
    throw new McpSourceReadError("invalid");
  }

  if (!isAbsolute(expanded)) throw new McpSourceReadError("invalid");
  return { kind: source.kind, path: resolve(expanded) };
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  const record = value as Record<string, unknown>;
  return (
    "{" +
    Object.keys(record)
      .sort()
      .map((key) => JSON.stringify(key) + ":" + canonicalJson(record[key]))
      .join(",") +
    "}"
  );
}

function entryDigest(input: {
  kind: McpDiscoverySource["kind"];
  entryId: string;
  name: string;
  config: unknown;
  sourceEnabled?: boolean | undefined;
  rawConfig?: string;
}): string {
  const contents = canonicalJson({
    kind: input.kind,
    entryId: input.entryId,
    name: input.name,
    config: input.rawConfig === undefined ? input.config : input.rawConfig,
    sourceEnabled: input.sourceEnabled,
  });
  return createHash("sha256").update(contents, "utf8").digest("hex");
}

async function readBoundedText(path: string): Promise<string> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);
    handle = await open(path, flags);
    const stats = await handle.stat();
    if (!stats.isFile() || stats.size > MAX_SOURCE_TEXT_BYTES) {
      throw new McpSourceReadError("invalid");
    }

    const chunks: Buffer[] = [];
    let total = 0;
    while (true) {
      const remaining = MAX_SOURCE_TEXT_BYTES + 1 - total;
      if (remaining <= 0) throw new McpSourceReadError("invalid");
      const chunk = Buffer.alloc(Math.min(64 * 1024, remaining));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > MAX_SOURCE_TEXT_BYTES) throw new McpSourceReadError("invalid");
      chunks.push(chunk.subarray(0, bytesRead));
    }
    return Buffer.concat(chunks, total).toString("utf8");
  } catch (error) {
    throw sourceReadError(error);
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function assertRegularDatabase(path: string): Promise<void> {
  try {
    const stats = await lstat(path);
    if (!stats.isFile() || stats.isSymbolicLink() || stats.size > MAX_CC_SWITCH_DATABASE_BYTES) {
      throw new McpSourceReadError("invalid");
    }
  } catch (error) {
    throw sourceReadError(error);
  }
}

function getReadOnlyStatement(
  database: {
    query?: (sql: string) => { all?: (...params: ReadonlyArray<unknown>) => unknown };
    prepare?: (sql: string) => { all?: (...params: ReadonlyArray<unknown>) => unknown };
  },
  sql: string,
) {
  return database.query?.(sql) ?? database.prepare?.(sql);
}

function rowSourceEnabled(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (value === 0) return false;
  if (value === 1) return true;
  return undefined;
}

function sourceConfigEnabled(config: unknown): boolean | undefined {
  if (!isRecord(config)) return undefined;
  return typeof config.enabled === "boolean" ? config.enabled : undefined;
}

function parseCcSwitchConfig(raw: unknown): { config: unknown; malformed: boolean } {
  if (typeof raw !== "string" || Buffer.byteLength(raw, "utf8") > MAX_SOURCE_TEXT_BYTES) {
    return { config: undefined, malformed: true };
  }
  try {
    return { config: JSON.parse(raw) as unknown, malformed: false };
  } catch {
    return { config: undefined, malformed: true };
  }
}

async function readCcSwitchRows(path: string): Promise<McpSourceEntry[]> {
  await assertRegularDatabase(path);
  let database: Awaited<ReturnType<typeof openReadOnlyDatabase>> | undefined;
  try {
    database = await openReadOnlyDatabase(path);
    database.exec?.("PRAGMA busy_timeout = 250; PRAGMA query_only = ON;");
    const statement = getReadOnlyStatement(
      database,
      "SELECT id, name, server_config, enabled_codex FROM mcp_servers LIMIT ?",
    );
    if (!statement?.all) throw new McpSourceReadError("invalid");
    const rawRows = statement.all(1_001);
    if (!Array.isArray(rawRows) || rawRows.length > MAX_SOURCE_ENTRIES) {
      throw new McpSourceReadError("invalid");
    }

    const entries: McpSourceEntry[] = [];
    for (const [index, rawRow] of rawRows.entries()) {
      if (!isRecord(rawRow) || typeof rawRow.id !== "string" || !isSafeEntryId(rawRow.id)) {
        throw new McpSourceReadError("invalid");
      }
      const id = rawRow.id;
      const name =
        typeof rawRow.name === "string" && rawRow.name.trim().length > 0 ? rawRow.name : id;
      const parsed = parseCcSwitchConfig(rawRow.server_config);
      const sourceEnabled = rowSourceEnabled(rawRow.enabled_codex);
      entries.push({
        entryId: id,
        name,
        config: parsed.config,
        ...(sourceEnabled === undefined ? {} : { sourceEnabled }),
        malformed: parsed.malformed,
        digest: entryDigest({
          kind: "cc-switch",
          entryId: id,
          name,
          config: parsed.config,
          sourceEnabled,
          rawConfig:
            typeof rawRow.server_config === "string"
              ? rawRow.server_config
              : "invalid-config-" + String(index),
        }),
      });
    }
    return entries;
  } catch (error) {
    throw sourceReadError(error);
  } finally {
    try {
      database?.close();
    } catch {
      // Ignore read-only handle cleanup failures.
    }
  }
}

function mapEntries(
  kind: McpDiscoverySource["kind"],
  container: unknown,
  prefix: string,
  enabledOf: (config: unknown) => boolean | undefined = sourceConfigEnabled,
): McpSourceEntry[] {
  if (!isRecord(container)) throw new McpSourceReadError("invalid");
  const keys = Object.keys(container);
  if (keys.length > MAX_SOURCE_ENTRIES) throw new McpSourceReadError("invalid");
  return keys.map((entryName) => {
    const config = container[entryName];
    const entryId = prefix.length > 0 ? prefix + ":" + entryName : entryName;
    if (!isSafeEntryId(entryId)) throw new McpSourceReadError("invalid");
    const sourceEnabled = enabledOf(config);
    return {
      entryId,
      name: entryName,
      config,
      ...(sourceEnabled === undefined ? {} : { sourceEnabled }),
      digest: entryDigest({ kind, entryId, name: entryName, config, sourceEnabled }),
    };
  });
}

function parseJsonEntries(value: unknown): McpSourceEntry[] {
  if (!isRecord(value)) throw new McpSourceReadError("invalid");
  const result: McpSourceEntry[] = [];
  if (hasOwn(value, "mcpServers")) {
    result.push(...mapEntries("json", value.mcpServers, "mcpServers"));
  }
  if (hasOwn(value, "servers")) {
    result.push(...mapEntries("json", value.servers, "servers"));
  }
  if (hasOwn(value, "mcp")) {
    if (!isRecord(value.mcp) || !hasOwn(value.mcp, "servers")) {
      throw new McpSourceReadError("invalid");
    }
    result.push(...mapEntries("json", value.mcp.servers, "mcp.servers"));
  }
  if (result.length > MAX_SOURCE_ENTRIES) throw new McpSourceReadError("invalid");
  return result;
}

function parseCodexEntries(value: unknown): McpSourceEntry[] {
  if (!isRecord(value) || !isRecord(value.mcp_servers)) {
    if (isRecord(value) && !hasOwn(value, "mcp_servers")) return [];
    throw new McpSourceReadError("invalid");
  }
  return mapEntries("codex", value.mcp_servers, "");
}

function jsonEntryParts(entryId: string): { container: string; key: string } {
  const separator = entryId.indexOf(":");
  if (separator <= 0 || separator === entryId.length - 1) {
    throw new McpSourceReadError("invalid");
  }
  return { container: entryId.slice(0, separator), key: entryId.slice(separator + 1) };
}

function sourceConfigFromText(
  kind: "codex" | "json",
  text: string,
  entryId?: string,
): McpSourceEntry[] | McpSourceEntry {
  let parsed: unknown;
  try {
    parsed = kind === "codex" ? parseToml(text) : JSON.parse(text);
  } catch {
    throw new McpSourceReadError("invalid");
  }

  if (kind === "codex") {
    const entries = parseCodexEntries(parsed);
    if (entryId === undefined) return entries;
    const found = entries.find((entry) => entry.entryId === entryId);
    if (!found) throw new McpSourceReadError("missing");
    return found;
  }

  const entries = parseJsonEntries(parsed);
  if (entryId === undefined) return entries;
  const parts = jsonEntryParts(entryId);
  const root = parsed as Record<string, unknown>;
  let container: unknown;
  if (parts.container === "mcpServers" || parts.container === "servers") {
    container = root[parts.container];
  } else if (parts.container === "mcp.servers" && isRecord(root.mcp)) {
    container = root.mcp.servers;
  } else {
    throw new McpSourceReadError("missing");
  }
  if (!isRecord(container) || !hasOwn(container, parts.key)) {
    throw new McpSourceReadError("missing");
  }
  const config = container[parts.key];
  const sourceEnabled = sourceConfigEnabled(config);
  return {
    entryId,
    name: parts.key,
    config,
    ...(sourceEnabled === undefined ? {} : { sourceEnabled }),
    digest: entryDigest({ kind, entryId, name: parts.key, config, sourceEnabled }),
  };
}

export async function readMcpSourceEntries(source: ResolvedMcpSource): Promise<McpSourceEntry[]> {
  if (!isAbsolute(source.path)) throw new McpSourceReadError("invalid");
  if (source.kind === "cc-switch") return readCcSwitchRows(source.path);
  const text = await readBoundedText(source.path);
  const entries = sourceConfigFromText(source.kind, text) as McpSourceEntry[];
  if (entries.length > MAX_SOURCE_ENTRIES) throw new McpSourceReadError("invalid");
  return entries;
}

export async function readMcpSourceEntry(
  source: McpConfigSourceReference,
): Promise<McpSourceEntry> {
  if (!isAbsolute(source.path)) throw new McpSourceReadError("invalid");
  if (source.kind === "cc-switch") {
    await assertRegularDatabase(source.path);
    let database: Awaited<ReturnType<typeof openReadOnlyDatabase>> | undefined;
    try {
      database = await openReadOnlyDatabase(source.path);
      database.exec?.("PRAGMA busy_timeout = 250; PRAGMA query_only = ON;");
      const statement = getReadOnlyStatement(
        database,
        "SELECT id, name, server_config, enabled_codex FROM mcp_servers WHERE id = ? LIMIT 2",
      );
      if (!statement?.all) throw new McpSourceReadError("invalid");
      const rows = statement.all(source.entryId);
      if (!Array.isArray(rows) || rows.length !== 1 || !isRecord(rows[0])) {
        throw new McpSourceReadError("missing");
      }
      const row = rows[0];
      if (row.id !== source.entryId) throw new McpSourceReadError("missing");
      const name =
        typeof row.name === "string" && row.name.trim().length > 0 ? row.name : source.entryId;
      const parsed = parseCcSwitchConfig(row.server_config);
      if (parsed.malformed) throw new McpSourceReadError("invalid");
      const sourceEnabled = rowSourceEnabled(row.enabled_codex);
      return {
        entryId: source.entryId,
        name,
        config: parsed.config,
        ...(sourceEnabled === undefined ? {} : { sourceEnabled }),
        digest: entryDigest({
          kind: "cc-switch",
          entryId: source.entryId,
          name,
          config: parsed.config,
          sourceEnabled,
          rawConfig: row.server_config as string,
        }),
      };
    } catch (error) {
      throw sourceReadError(error);
    } finally {
      try {
        database?.close();
      } catch {
        // Ignore read-only handle cleanup failures.
      }
    }
  }

  const text = await readBoundedText(source.path);
  const entry = sourceConfigFromText(source.kind, text, source.entryId);
  return entry as McpSourceEntry;
}

export async function readMcpConfigSourceValues(input: {
  readonly source: McpConfigSourceReference;
  readonly section: "env" | "headers";
  readonly names: ReadonlyArray<string>;
}): Promise<Record<string, string>> {
  const entry = await readMcpSourceEntry(input.source);
  if (!isRecord(entry.config)) throw new McpSourceReadError("invalid");
  let containerName: string;
  if (input.source.kind === "codex") {
    containerName = input.section === "env" ? "env" : "http_headers";
  } else {
    containerName = input.section;
  }
  const container = entry.config[containerName];
  if (!isRecord(container)) throw new McpSourceReadError("invalid");

  const result = Object.create(null) as Record<string, string>;
  const seenNames = new Set<string>();
  for (const name of input.names) {
    const normalizedName = input.section === "headers" ? name.toLowerCase() : name;
    const validName =
      input.section === "headers"
        ? /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u.test(name)
        : /^[A-Za-z_][A-Za-z0-9_]*$/u.test(name);
    if (!validName || seenNames.has(normalizedName)) {
      throw new McpSourceReadError("invalid");
    }
    seenNames.add(normalizedName);
    if (!hasOwn(container, name)) throw new McpSourceReadError("invalid");
    const value = container[name];
    if (
      typeof value !== "string" ||
      value.includes("\0") ||
      (input.section === "headers" && /[\r\n]/u.test(value))
    ) {
      throw new McpSourceReadError("invalid");
    }
    result[name] = value;
  }
  return result;
}
