import * as fs from "node:fs/promises";
import * as path from "node:path";

import {
  ExpertConnectionConfig as ExpertConnectionConfigSchema,
  ExpertConnectionReferencesResultSchema,
  ExpertConnectionSaveInput,
  ExpertDefinition as ExpertDefinitionSchema,
  ExpertMcpBindingSchema,
  McpConnectionId,
  McpConnectionSetStateInputSchema,
  McpConnectionStateSchema,
  type ExpertConnectionConfig,
  type ExpertConnectionReferencesResult,
  type ExpertMcpBinding,
  type ExpertSnapshot,
  type McpConnectionSetStateInput,
  type McpConnectionState,
} from "@synara/contracts";
import { Schema } from "effect";

import { ensurePrivateDirectorySync, syncDirectoryEntry } from "../privatePathPermissions";
import {
  assertPrivateDirectory,
  readPrivateJsonFile,
  serializeJsonWithinByteLimit,
  writePrivateFileAtomically,
} from "./ExpertMcpStorage.ts";

const MAX_CONFIG_BYTES = 64 * 1024;
const MAX_STATE_BYTES = 16 * 1024;
const MAX_REFERENCE_FILE_BYTES = 16 * 1024 * 1024;
const EXPERT_CONNECTION_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/u;
const EXPERT_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/u;
const SNAPSHOT_ID_PATTERN = /^exp_[a-f0-9]{64}$/u;
const writeTails = new Map<string, Promise<void>>();
const stateListeners = new Map<string, Set<(state: McpConnectionState) => void>>();

export class ExpertConnectionStoreError extends Error {
  constructor(
    message: string,
    readonly code: "invalid_input" | "not_found" | "revision_conflict" | "corrupt" | "in_use",
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ExpertConnectionStoreError";
  }
}

export interface ExpertConnectionStore {
  list(): Promise<ExpertConnectionConfig[]>;
  read(id: string): Promise<ExpertConnectionConfig | null>;
  readRevision(id: string, revision: number): Promise<ExpertConnectionConfig | null>;
  pinRevision(id: string): Promise<ExpertConnectionConfig | null>;
  readState(id: string): Promise<McpConnectionState>;
  setState(input: McpConnectionSetStateInput): Promise<McpConnectionState>;
  subscribeStateChanges(listener: (state: McpConnectionState) => void): () => void;
  save(input: typeof ExpertConnectionSaveInput.Type): Promise<ExpertConnectionConfig>;
  remove(id: string, expectedRevision: number): Promise<void>;
}

export type ExpertConnectionReferenceScan = Pick<
  ExpertConnectionReferencesResult,
  "experts" | "snapshots"
>;

function decode<T>(
  schema: Schema.Top,
  value: unknown,
  message: string,
  code: "invalid_input" | "corrupt",
): T {
  try {
    return Schema.decodeUnknownSync(schema as Schema.Decoder<T>)(value) as T;
  } catch (cause) {
    throw new ExpertConnectionStoreError(message, code, { cause });
  }
}

function assertId(id: string): void {
  if (!EXPERT_CONNECTION_ID_PATTERN.test(id)) {
    throw new ExpertConnectionStoreError("Expert connection ID is invalid.", "invalid_input");
  }
}

function assertRevision(revision: number): void {
  if (!Number.isSafeInteger(revision) || revision < 1) {
    throw new ExpertConnectionStoreError("Revision is invalid.", "invalid_input");
  }
}

function validateNoPlaintextCredentials(input: typeof ExpertConnectionSaveInput.Type): void {
  const { transport } = input;
  if (transport.type === "stdio") {
    if (transport.envFromSecret) {
      const names = [
        ...transport.envFromHost.map(({ name }) => name),
        ...(transport.envFromSource?.names ?? []),
        ...transport.envFromSecret.names,
      ];
      if (new Set(names).size !== names.length) {
        throw new ExpertConnectionStoreError(
          "Expert connection environment references conflict.",
          "invalid_input",
        );
      }
    }
    for (let index = 0; index < transport.args.length; index += 1) {
      const argument = transport.args[index]!;
      if (/^(?:Bearer|Basic)\s+\S+/iu.test(argument)) {
        throw new ExpertConnectionStoreError(
          "Expert connection credentials must be referenced from the host environment.",
          "invalid_input",
        );
      }
      if (
        /^--?(?:auth(?:orization)?|token|api[-_]?key|secret|password|credential)(?:=|$)/iu.test(
          argument,
        )
      ) {
        const hasInlineValue = argument.includes("=") && argument.split("=", 2)[1] !== "";
        const next = transport.args[index + 1];
        if (hasInlineValue || (next !== undefined && !next.startsWith("-"))) {
          throw new ExpertConnectionStoreError(
            "Expert connection credentials must be referenced from the host environment.",
            "invalid_input",
          );
        }
      }
    }
    return;
  }

  if (transport.headersFromSecret) {
    const names = [
      ...transport.headersFromHost.map(({ name }) => name),
      ...(transport.headersFromSource?.names ?? []),
      ...transport.headersFromSecret.names,
    ];
    const normalizedNames = names.map((name) => name.toLowerCase());
    if (new Set(normalizedNames).size !== names.length) {
      throw new ExpertConnectionStoreError(
        "Expert connection header references conflict.",
        "invalid_input",
      );
    }
  }

  let url: URL;
  try {
    url = new URL(transport.url);
  } catch (cause) {
    throw new ExpertConnectionStoreError("Expert connection URL is invalid.", "invalid_input", {
      cause,
    });
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new ExpertConnectionStoreError(
      "Expert connection credentials must be referenced from the host environment.",
      "invalid_input",
    );
  }
}

function withWriteLock<T>(key: string, action: () => Promise<T>): Promise<T> {
  // This is a process-local queue shared by all stores. Running multiple servers against one
  // stateDir is unsupported; this queue is not a cross-process lock.
  const previous = writeTails.get(key) ?? Promise.resolve();
  const result = previous.then(action, action);
  const tail = result.then(
    () => undefined,
    () => undefined,
  );
  writeTails.set(key, tail);
  void tail.then(() => {
    if (writeTails.get(key) === tail) writeTails.delete(key);
  });
  return result;
}

function publishStateChange(directory: string, state: McpConnectionState): void {
  for (const listener of stateListeners.get(directory) ?? []) {
    try {
      listener(state);
    } catch {
      // State persistence is already committed; observers cannot roll it back.
    }
  }
}

function causeCode(cause: unknown): string | undefined {
  return (cause as NodeJS.ErrnoException).code;
}

async function assertDirectory(
  directory: string,
  message: string,
  missingOk: boolean,
): Promise<boolean> {
  try {
    return await assertPrivateDirectory(directory, message, missingOk);
  } catch (cause) {
    throw new ExpertConnectionStoreError(message, "corrupt", { cause });
  }
}

async function readJsonFile(
  target: string,
  maxBytes: number,
  message: string,
  missingOk: boolean,
): Promise<unknown | undefined> {
  try {
    return await readPrivateJsonFile(target, maxBytes, message, missingOk);
  } catch (cause) {
    throw new ExpertConnectionStoreError(message, "corrupt", { cause });
  }
}

function stableJson(value: unknown): string {
  const sort = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(sort);
    if (item !== null && typeof item === "object") {
      return Object.fromEntries(
        Object.entries(item)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, child]) => [key, sort(child)]),
      );
    }
    return item;
  };
  return JSON.stringify(sort(value)) ?? "undefined";
}

async function readDirectoryEntries(
  directory: string,
  message: string,
  missingOk: boolean,
): Promise<import("node:fs").Dirent[]> {
  if (!(await assertDirectory(directory, message, missingOk))) return [];
  try {
    return await fs.readdir(directory, { withFileTypes: true });
  } catch (cause) {
    throw new ExpertConnectionStoreError(message, "corrupt", { cause });
  }
}

function validateConnectionReferences(value: unknown, message: string): ExpertMcpBinding {
  const binding = decode<ExpertMcpBinding>(ExpertMcpBindingSchema, value, message, "corrupt");
  for (const server of binding.servers) {
    if (
      (server.effectiveTools === undefined) !== (server.resolutionStatus === undefined) ||
      (server.toolMode !== "all" && server.effectiveTools !== undefined) ||
      (server.resolutionStatus === "unavailable" && server.effectiveTools?.length !== 0)
    ) {
      throw new ExpertConnectionStoreError(message, "corrupt");
    }
  }
  return binding;
}

function immutableBindingShape(binding: ExpertMcpBinding, isSnapshot: boolean): unknown {
  return {
    schemaVersion: binding.schemaVersion,
    source: binding.source,
    ...(binding.authorizationId ? { authorizationId: binding.authorizationId } : {}),
    createdAt: binding.createdAt,
    servers: binding.servers.map((server) => {
      if (
        isSnapshot &&
        (server.effectiveTools !== undefined || server.resolutionStatus !== undefined)
      ) {
        throw new ExpertConnectionStoreError(
          "Snapshot MCP bindings cannot contain resolved tool state.",
          "corrupt",
        );
      }
      return {
        id: server.id,
        ...(server.configRevision !== undefined ? { configRevision: server.configRevision } : {}),
        required: server.required,
        ...(server.toolMode ? { toolMode: server.toolMode } : {}),
        tools: server.tools,
      };
    }),
  };
}

/**
 * Reads every persisted expert and snapshot reference to a connection. Corrupt or unsafe
 * reference data fails closed so callers cannot remove an ID whose owners are unknown.
 */
export async function scanExpertConnectionReferences(
  stateDir: string,
  rawId: string,
): Promise<ExpertConnectionReferenceScan> {
  if (!path.isAbsolute(stateDir) || stateDir.includes("\0")) {
    throw new ExpertConnectionStoreError("State directory must be absolute.", "invalid_input");
  }
  assertId(rawId);
  const id = decode<string>(
    McpConnectionId,
    rawId,
    "Expert connection ID is invalid.",
    "invalid_input",
  );
  const stateRoot = path.resolve(stateDir);
  const root = path.join(stateRoot, "experts");
  const definitionsDir = path.join(root, "definitions");
  const snapshotsDir = path.join(root, "snapshots");
  const bindingDir = path.join(stateRoot, "expert-mcp-bindings");
  const experts: ExpertConnectionReferenceScan["experts"][number][] = [];
  const snapshots: ExpertConnectionReferenceScan["snapshots"][number][] = [];

  await assertDirectory(stateRoot, "State directory is invalid.", true);
  await assertDirectory(root, "Experts directory is invalid.", true);
  const definitionNames = await readDirectoryEntries(
    definitionsDir,
    "Expert definitions directory is invalid.",
    true,
  );
  for (const entry of definitionNames) {
    if (!entry.name.endsWith(".json")) continue;
    if (!entry.isFile() || entry.isSymbolicLink()) {
      throw new ExpertConnectionStoreError("Expert definition file is invalid.", "corrupt");
    }
    const expertId = entry.name.slice(0, -".json".length);
    if (!EXPERT_ID_PATTERN.test(expertId)) {
      throw new ExpertConnectionStoreError("Expert definition filename is invalid.", "corrupt");
    }
    const rawDefinition = await readJsonFile(
      path.join(definitionsDir, entry.name),
      MAX_REFERENCE_FILE_BYTES,
      "Expert definition file is invalid.",
      false,
    );
    const definition = decode<typeof ExpertDefinitionSchema.Type>(
      ExpertDefinitionSchema,
      rawDefinition,
      "Expert definition file is invalid.",
      "corrupt",
    );
    if (definition.id !== expertId) {
      throw new ExpertConnectionStoreError(
        "Expert definition ID does not match its filename.",
        "corrupt",
      );
    }
    for (const connection of definition.connections) {
      if (connection.id !== id) continue;
      experts.push({
        id: definition.id,
        name: definition.name,
        revision: definition.revision,
        enabled: !definition.archived && connection.enabled !== false,
        required: connection.required,
        ...(connection.toolMode ? { toolMode: connection.toolMode } : {}),
        tools: connection.tools,
      });
    }
  }

  const snapshotEntries = await readDirectoryEntries(
    snapshotsDir,
    "Expert snapshots directory is invalid.",
    true,
  );
  const snapshotBindings = new Map<string, ExpertMcpBinding | undefined>();
  const parsedSnapshots = new Map<string, ExpertSnapshot>();
  for (const entry of snapshotEntries) {
    if (entry.name.startsWith(".tmp-") || entry.name.startsWith(".staging-")) continue;
    if (!entry.isDirectory() || entry.isSymbolicLink() || !SNAPSHOT_ID_PATTERN.test(entry.name)) {
      throw new ExpertConnectionStoreError("Expert snapshot directory is invalid.", "corrupt");
    }
    let snapshot: ExpertSnapshot;
    try {
      const { readVerifiedStoredExpertSnapshot } = await import("./ExpertStore.ts");
      snapshot = await readVerifiedStoredExpertSnapshot(
        path.join(snapshotsDir, entry.name),
        entry.name,
      );
    } catch (cause) {
      throw new ExpertConnectionStoreError(
        "Expert snapshot integrity validation failed.",
        "corrupt",
        { cause },
      );
    }
    parsedSnapshots.set(entry.name, snapshot);
    snapshotBindings.set(entry.name, snapshot.mcpBinding);
  }

  const bindingEntries = await readDirectoryEntries(
    bindingDir,
    "Expert MCP bindings directory is invalid.",
    true,
  );
  for (const entry of bindingEntries) {
    if (!entry.name.endsWith(".json")) continue;
    if (!entry.isFile() || entry.isSymbolicLink()) {
      throw new ExpertConnectionStoreError("Expert MCP binding file is invalid.", "corrupt");
    }
    const snapshotId = entry.name.slice(0, -".json".length);
    if (!SNAPSHOT_ID_PATTERN.test(snapshotId)) {
      throw new ExpertConnectionStoreError("Expert MCP binding filename is invalid.", "corrupt");
    }
    const bindingValue = await readJsonFile(
      path.join(bindingDir, entry.name),
      MAX_REFERENCE_FILE_BYTES,
      "Expert MCP binding file is invalid.",
      false,
    );
    const binding = validateConnectionReferences(
      bindingValue,
      "Expert MCP binding file is invalid.",
    );
    const snapshotBinding = snapshotBindings.get(snapshotId);
    if (
      snapshotBinding &&
      stableJson(immutableBindingShape(snapshotBinding, true)) !==
        stableJson(immutableBindingShape(binding, false))
    ) {
      throw new ExpertConnectionStoreError(
        "Snapshot and sidecar MCP bindings disagree.",
        "corrupt",
      );
    }
    snapshotBindings.set(snapshotId, binding);
  }

  for (const [snapshotId, snapshot] of parsedSnapshots) {
    const connectionById = new Map(
      snapshot.connections.map((connection) => [connection.id, connection]),
    );
    const binding = snapshotBindings.get(snapshotId);
    const ids = new Set([
      ...connectionById.keys(),
      ...(binding?.servers.map((server) => server.id) ?? []),
    ]);
    for (const connectionId of ids) {
      if (connectionId !== id) continue;
      const connection = connectionById.get(connectionId);
      const boundServer = binding?.servers.find((server) => server.id === connectionId);
      snapshots.push({
        snapshotId,
        expertId: snapshot.expertId,
        displayName: snapshot.displayName,
        ...(boundServer?.configRevision === undefined
          ? {}
          : { configRevision: boundServer.configRevision }),
        required: boundServer?.required ?? connection?.required ?? false,
        ...((boundServer?.toolMode ?? connection?.toolMode)
          ? { toolMode: boundServer?.toolMode ?? connection?.toolMode }
          : {}),
        legacy: binding === undefined || binding.source === "legacy-current",
      });
    }
  }

  for (const [snapshotId, binding] of snapshotBindings) {
    if (parsedSnapshots.has(snapshotId) || !binding) continue;
    for (const server of binding.servers) {
      if (server.id !== id) continue;
      snapshots.push({
        snapshotId,
        expertId: "unknown",
        displayName: snapshotId,
        ...(server.configRevision === undefined ? {} : { configRevision: server.configRevision }),
        required: server.required,
        ...(server.toolMode ? { toolMode: server.toolMode } : {}),
        legacy: binding.source === "legacy-current",
      });
    }
  }

  experts.sort((left, right) => left.id.localeCompare(right.id));
  snapshots.sort(
    (left, right) =>
      left.snapshotId.localeCompare(right.snapshotId) ||
      (left.required === right.required ? 0 : left.required ? -1 : 1),
  );
  const checked = decode<ExpertConnectionReferencesResult>(
    ExpertConnectionReferencesResultSchema,
    { experts, snapshots, tasks: [], activeSessionCount: 0 },
    "Expert connection references are invalid.",
    "corrupt",
  );
  return { experts: checked.experts, snapshots: checked.snapshots };
}

export function createExpertConnectionStore(stateDir: string): ExpertConnectionStore {
  if (!path.isAbsolute(stateDir) || stateDir.includes("\0")) {
    throw new ExpertConnectionStoreError("State directory must be absolute.", "invalid_input");
  }
  const root = path.resolve(stateDir);
  const directory = path.join(root, "expert-connections");
  const revisionsDir = path.join(directory, "revisions");
  const statesDir = path.join(directory, "state");
  ensurePrivateDirectorySync(directory);
  ensurePrivateDirectorySync(revisionsDir);
  ensurePrivateDirectorySync(statesDir);

  const filePath = (id: string) => {
    assertId(id);
    return path.join(directory, id + ".json");
  };
  const statePath = (id: string) => {
    assertId(id);
    return path.join(statesDir, id + ".json");
  };
  const revisionsForId = (id: string) => {
    assertId(id);
    const target = path.join(revisionsDir, id);
    ensurePrivateDirectorySync(target);
    return target;
  };
  const revisionPath = (id: string, revision: number) => {
    assertRevision(revision);
    return path.join(revisionsForId(id), revision + ".json");
  };

  const assertStoreDirectories = async (): Promise<void> => {
    await assertDirectory(root, "State directory is invalid.", false);
    await assertDirectory(directory, "Expert connections directory is invalid.", false);
  };

  const readConfigAt = async (
    target: string,
    id: string,
    missingOk: boolean,
  ): Promise<ExpertConnectionConfig | null> => {
    const value = await readJsonFile(
      target,
      MAX_CONFIG_BYTES,
      "Expert connection file is invalid.",
      missingOk,
    );
    if (value === undefined) return null;
    const config = decode<ExpertConnectionConfig>(
      ExpertConnectionConfigSchema,
      value,
      "Expert connection file is invalid.",
      "corrupt",
    );
    if (config.id !== id) {
      throw new ExpertConnectionStoreError("Expert connection file ID does not match.", "corrupt");
    }
    return config;
  };

  const read = async (id: string): Promise<ExpertConnectionConfig | null> => {
    await assertStoreDirectories();
    return readConfigAt(filePath(id), id, true);
  };

  const readRevision = async (
    id: string,
    revision: number,
  ): Promise<ExpertConnectionConfig | null> => {
    assertId(id);
    assertRevision(revision);
    await assertStoreDirectories();
    await assertDirectory(revisionsDir, "Expert connection revisions directory is invalid.", false);
    if (
      !(await assertDirectory(
        path.join(revisionsDir, id),
        "Expert connection revisions directory is invalid.",
        true,
      ))
    ) {
      return null;
    }
    const target = path.join(revisionsDir, id, revision + ".json");
    const config = await readConfigAt(target, id, true);
    if (config && config.revision !== revision) {
      throw new ExpertConnectionStoreError(
        "Archived connection revision does not match its path.",
        "corrupt",
      );
    }
    return config;
  };

  const readPersistedState = async (id: string): Promise<McpConnectionState | null> => {
    await assertStoreDirectories();
    await assertDirectory(statesDir, "Expert connection state directory is invalid.", false);
    const value = await readJsonFile(
      statePath(id),
      MAX_STATE_BYTES,
      "Expert connection state file is invalid.",
      true,
    );
    if (value === undefined) return null;
    const state = decode<McpConnectionState>(
      McpConnectionStateSchema,
      value,
      "Expert connection state file is invalid.",
      "corrupt",
    );
    if (state.id !== id) {
      throw new ExpertConnectionStoreError("Expert connection state ID does not match.", "corrupt");
    }
    return state;
  };

  const readStateUnlocked = async (id: string): Promise<McpConnectionState> => {
    assertId(id);
    const stored = await readPersistedState(id);
    if (stored) return stored;
    const config = await read(id);
    if (!config) throw new ExpertConnectionStoreError("Expert connection not found.", "not_found");
    return decode<McpConnectionState>(
      McpConnectionStateSchema,
      {
        id,
        status: "active",
        revision: 1,
        updatedAt: config.updatedAt,
      },
      "Legacy expert connection state is invalid.",
      "corrupt",
    );
  };

  const writeJsonAtomically = async (target: string, contents: string): Promise<void> => {
    await assertStoreDirectories();
    await assertDirectory(
      path.dirname(target),
      "Expert connection storage directory is invalid.",
      false,
    );
    await writePrivateFileAtomically(target, contents);
  };

  const serializeStoreJson = (
    value: unknown,
    maxBytes: number,
    message: string,
    code: "invalid_input" | "corrupt",
  ): string => {
    try {
      return serializeJsonWithinByteLimit(value, maxBytes, message);
    } catch (cause) {
      throw new ExpertConnectionStoreError(message, code, { cause });
    }
  };

  const archiveImmutable = async (
    config: ExpertConnectionConfig,
    serializedContents = serializeStoreJson(
      config,
      MAX_CONFIG_BYTES,
      "Expert connection file is too large or invalid.",
      "corrupt",
    ),
  ): Promise<void> => {
    await assertStoreDirectories();
    await assertDirectory(revisionsDir, "Expert connection revisions directory is invalid.", false);
    const target = revisionPath(config.id, config.revision);
    const existing = await readConfigAt(target, config.id, true);
    if (existing) {
      if (stableJson(existing) === stableJson(config)) return;
      throw new ExpertConnectionStoreError(
        "A different expert connection already uses this archived revision.",
        "revision_conflict",
      );
    }
    await writeJsonAtomically(target, serializedContents);
  };

  const highestArchivedRevision = async (id: string): Promise<number> => {
    await assertStoreDirectories();
    await assertDirectory(revisionsDir, "Expert connection revisions directory is invalid.", false);
    const target = path.join(revisionsDir, id);
    let stat: Awaited<ReturnType<typeof fs.lstat>>;
    try {
      stat = await fs.lstat(target);
    } catch (cause) {
      if (causeCode(cause) === "ENOENT") return 0;
      throw new ExpertConnectionStoreError(
        "Expert connection revisions directory is invalid.",
        "corrupt",
        {
          cause,
        },
      );
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new ExpertConnectionStoreError(
        "Expert connection revisions directory is invalid.",
        "corrupt",
      );
    }
    let names: string[];
    try {
      names = await fs.readdir(target);
    } catch (cause) {
      throw new ExpertConnectionStoreError(
        "Expert connection revisions directory is invalid.",
        "corrupt",
        {
          cause,
        },
      );
    }
    let highest = 0;
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const match = /^([1-9][0-9]*)\.json$/u.exec(name);
      const revision = match ? Number(match[1]) : NaN;
      if (!Number.isSafeInteger(revision) || revision < 1) {
        throw new ExpertConnectionStoreError(
          "Archived connection revision filename is invalid.",
          "corrupt",
        );
      }
      const config = await readConfigAt(path.join(target, name), id, false);
      if (!config || config.revision !== revision) {
        throw new ExpertConnectionStoreError("Archived connection revision is invalid.", "corrupt");
      }
      highest = Math.max(highest, revision);
    }
    return highest;
  };

  const save = (rawInput: typeof ExpertConnectionSaveInput.Type): Promise<ExpertConnectionConfig> =>
    withWriteLock(directory, async () => {
      let inputBytes: number;
      try {
        const serialized = JSON.stringify(rawInput);
        if (serialized === undefined) throw new TypeError("Input is not JSON serializable.");
        inputBytes = Buffer.byteLength(serialized, "utf8");
      } catch (cause) {
        throw new ExpertConnectionStoreError(
          "Expert connection input is invalid.",
          "invalid_input",
          {
            cause,
          },
        );
      }
      if (inputBytes > MAX_CONFIG_BYTES) {
        throw new ExpertConnectionStoreError(
          "Expert connection input is too large.",
          "invalid_input",
        );
      }
      const input = decode<typeof ExpertConnectionSaveInput.Type>(
        ExpertConnectionSaveInput,
        rawInput,
        "Expert connection input is invalid.",
        "invalid_input",
      );
      validateNoPlaintextCredentials(input);

      const previous = await read(input.id);
      const storedState = await readPersistedState(input.id);
      if (storedState?.status === "retired") {
        throw new ExpertConnectionStoreError(
          "Retired expert connection IDs cannot be reused.",
          "revision_conflict",
        );
      }
      if (!previous && storedState) {
        throw new ExpertConnectionStoreError(
          "Expert connection state exists without its current config.",
          "corrupt",
        );
      }
      if ((previous?.revision ?? undefined) !== input.expectedRevision) {
        throw new ExpertConnectionStoreError(
          "Expert connection revision changed; reload before saving.",
          "revision_conflict",
        );
      }

      const latestRevision = await highestArchivedRevision(input.id);
      const nextRevision = Math.max(previous?.revision ?? 0, latestRevision) + 1;
      const config = decode<ExpertConnectionConfig>(
        ExpertConnectionConfigSchema,
        {
          id: input.id,
          name: input.name,
          transport: input.transport,
          ...(input.importedFrom === undefined ? {} : { importedFrom: input.importedFrom }),
          revision: nextRevision,
          updatedAt: new Date().toISOString(),
        },
        "Expert connection input is invalid.",
        "invalid_input",
      );
      // Check the exact bytes that will be persisted before publishing either the old or new
      // immutable revision. This includes metadata, pretty-printing, UTF-8 and the final newline.
      const previousContents = previous
        ? serializeStoreJson(
            previous,
            MAX_CONFIG_BYTES,
            "Expert connection file is too large or invalid.",
            "corrupt",
          )
        : undefined;
      const configContents = serializeStoreJson(
        config,
        MAX_CONFIG_BYTES,
        "Expert connection file is too large or invalid.",
        "invalid_input",
      );
      if (previous && previousContents) await archiveImmutable(previous, previousContents);
      // The immutable revision is published first. A failed current-file replacement can only
      // leave an orphan archive; the previous current config remains readable.
      await archiveImmutable(config, configContents);
      await writeJsonAtomically(filePath(config.id), configContents);
      return config;
    });

  const readState = async (id: string): Promise<McpConnectionState> => readStateUnlocked(id);

  const setState = (rawInput: McpConnectionSetStateInput): Promise<McpConnectionState> =>
    withWriteLock(directory, async () => {
      const input = decode<McpConnectionSetStateInput>(
        McpConnectionSetStateInputSchema,
        rawInput,
        "Expert connection state input is invalid.",
        "invalid_input",
      );
      const current = await read(input.id);
      if (!current) {
        throw new ExpertConnectionStoreError("Expert connection not found.", "not_found");
      }
      const previous = await readStateUnlocked(input.id);
      if (previous.revision !== input.expectedRevision) {
        throw new ExpertConnectionStoreError(
          "Expert connection state changed; reload before updating.",
          "revision_conflict",
        );
      }
      if (previous.status === "retired" && input.status !== "retired") {
        throw new ExpertConnectionStoreError(
          "Retired expert connections cannot be reactivated.",
          "revision_conflict",
        );
      }
      const state = decode<McpConnectionState>(
        McpConnectionStateSchema,
        {
          id: input.id,
          status: input.status,
          revision: previous.revision + 1,
          updatedAt: new Date().toISOString(),
        },
        "Expert connection state is invalid.",
        "invalid_input",
      );
      const stateContents = serializeStoreJson(
        state,
        MAX_STATE_BYTES,
        "Expert connection state is too large or invalid.",
        "invalid_input",
      );
      await writeJsonAtomically(statePath(state.id), stateContents);
      publishStateChange(directory, state);
      return state;
    });

  const subscribeStateChanges = (listener: (state: McpConnectionState) => void): (() => void) => {
    const listeners =
      stateListeners.get(directory) ?? new Set<(state: McpConnectionState) => void>();
    listeners.add(listener);
    stateListeners.set(directory, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0 && stateListeners.get(directory) === listeners) {
        stateListeners.delete(directory);
      }
    };
  };

  const pinRevision = (id: string): Promise<ExpertConnectionConfig | null> =>
    withWriteLock(directory, async () => {
      const current = await read(id);
      if (!current) return null;
      await archiveImmutable(current);
      return current;
    });

  const remove = (id: string, expectedRevision: number): Promise<void> =>
    withWriteLock(directory, async () => {
      assertRevision(expectedRevision);
      const previous = await read(id);
      if (!previous) {
        throw new ExpertConnectionStoreError("Expert connection not found.", "not_found");
      }
      if (previous.revision !== expectedRevision) {
        throw new ExpertConnectionStoreError(
          "Expert connection revision changed; reload before removing.",
          "revision_conflict",
        );
      }
      const references = await scanExpertConnectionReferences(root, id);
      if (references.experts.length > 0 || references.snapshots.length > 0) {
        throw new ExpertConnectionStoreError(
          "Expert connection is still referenced by an expert or snapshot.",
          "in_use",
        );
      }

      await archiveImmutable(previous);
      const state = await readStateUnlocked(id);
      const retired = decode<McpConnectionState>(
        McpConnectionStateSchema,
        {
          id,
          status: "retired",
          revision: state.revision + 1,
          updatedAt: new Date().toISOString(),
        },
        "Retired expert connection state is invalid.",
        "corrupt",
      );
      const retiredContents = serializeStoreJson(
        retired,
        MAX_STATE_BYTES,
        "Retired expert connection state is too large or invalid.",
        "corrupt",
      );
      // Persist the tombstone before unlinking current so a crash cannot make this ID reusable.
      await writeJsonAtomically(statePath(id), retiredContents);
      publishStateChange(directory, retired);
      try {
        await fs.unlink(filePath(id));
      } catch (cause) {
        throw new ExpertConnectionStoreError("Failed to remove expert connection.", "corrupt", {
          cause,
        });
      }
      await syncDirectoryEntry(directory);
    });

  const list = async (): Promise<ExpertConnectionConfig[]> => {
    const entries = await readDirectoryEntries(
      directory,
      "Expert connections directory is invalid.",
      false,
    );
    const names = entries
      .filter((entry) => entry.name.endsWith(".json"))
      .map((entry) => entry.name);
    const configs = await Promise.all(names.map((name) => read(name.slice(0, -5))));
    return configs
      .filter((config): config is ExpertConnectionConfig => config !== null)
      .sort(
        (left, right) =>
          right.updatedAt.localeCompare(left.updatedAt) || left.name.localeCompare(right.name),
      );
  };

  return {
    list,
    read,
    readRevision,
    pinRevision,
    readState,
    setState,
    subscribeStateChanges,
    save,
    remove,
  };
}
