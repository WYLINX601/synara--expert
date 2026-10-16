import * as path from "node:path";

import { ExpertMcpBindingSchema, type ExpertMcpBinding } from "@synara/contracts";
import { Schema } from "effect";

import { ensurePrivateDirectorySync } from "../privatePathPermissions";
import {
  assertPrivateDirectory,
  readPrivateJsonFile,
  writePrivateFileAtomically,
} from "./ExpertMcpStorage.ts";

const MAX_BINDING_BYTES = 256 * 1024;
const SNAPSHOT_ID_PATTERN = /^exp_[a-f0-9]{64}$/u;
const writeTails = new Map<string, Promise<void>>();

export class ExpertMcpBindingStoreError extends Error {
  constructor(
    message: string,
    readonly code: "invalid_input" | "not_found" | "revision_conflict" | "corrupt",
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ExpertMcpBindingStoreError";
  }
}

export interface ExpertMcpBindingStore {
  read(snapshotId: string): Promise<ExpertMcpBinding | null>;
  createOnce(snapshotId: string, binding: ExpertMcpBinding): Promise<ExpertMcpBinding>;
  get(
    snapshotId: string,
    capture: () => ExpertMcpBinding | Promise<ExpertMcpBinding>,
  ): Promise<ExpertMcpBinding>;
  resolveToolsOnce(
    snapshotId: string,
    connectionId: string,
    resolution: {
      readonly status: "resolved" | "unavailable";
      readonly tools: ReadonlyArray<string>;
    },
  ): Promise<ExpertMcpBinding>;
}

function withWriteLock<T>(key: string, action: () => Promise<T>): Promise<T> {
  // One in-process queue is shared by all stores. Concurrent servers sharing stateDir are unsupported.
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

function validateSnapshotId(snapshotId: string): void {
  if (!SNAPSHOT_ID_PATTERN.test(snapshotId)) {
    throw new ExpertMcpBindingStoreError("Snapshot ID is invalid.", "invalid_input");
  }
}

function decodeBinding(value: unknown, code: "invalid_input" | "corrupt"): ExpertMcpBinding {
  try {
    const binding = Schema.decodeUnknownSync(ExpertMcpBindingSchema)(value);
    for (const server of binding.servers) {
      if (
        (server.effectiveTools === undefined) !== (server.resolutionStatus === undefined) ||
        (server.toolMode !== "all" && server.effectiveTools !== undefined) ||
        (server.resolutionStatus === "unavailable" && server.effectiveTools?.length !== 0)
      ) {
        throw new Error("Expert MCP tool resolution state is inconsistent.");
      }
    }
    return binding;
  } catch (cause) {
    throw new ExpertMcpBindingStoreError("Expert MCP binding is invalid.", code, { cause });
  }
}

async function assertBindingDirectory(directory: string): Promise<void> {
  try {
    await assertPrivateDirectory(directory, "Expert MCP binding directory is invalid.", false);
  } catch (cause) {
    throw new ExpertMcpBindingStoreError("Expert MCP binding directory is invalid.", "corrupt", {
      cause,
    });
  }
}

export function createExpertMcpBindingStore(stateDir: string): ExpertMcpBindingStore {
  if (!path.isAbsolute(stateDir) || stateDir.includes("\0")) {
    throw new ExpertMcpBindingStoreError("State directory must be absolute.", "invalid_input");
  }
  const stateRoot = path.resolve(stateDir);
  const directory = path.join(stateRoot, "expert-mcp-bindings");
  ensurePrivateDirectorySync(directory);

  const filePath = (snapshotId: string): string => {
    validateSnapshotId(snapshotId);
    return path.join(directory, snapshotId + ".json");
  };

  const readUnlocked = async (snapshotId: string): Promise<ExpertMcpBinding | null> => {
    const target = filePath(snapshotId);
    await assertBindingDirectory(directory);
    let value: unknown | undefined;
    try {
      value = await readPrivateJsonFile(
        target,
        MAX_BINDING_BYTES,
        "Expert MCP binding file is invalid.",
        true,
      );
    } catch (cause) {
      throw new ExpertMcpBindingStoreError("Failed to read expert MCP binding.", "corrupt", {
        cause,
      });
    }
    if (value === undefined) return null;
    return decodeBinding(value, "corrupt");
  };

  const writeUnlocked = async (
    snapshotId: string,
    binding: ExpertMcpBinding,
  ): Promise<ExpertMcpBinding> => {
    const existing = await readUnlocked(snapshotId);
    if (existing) {
      if (stableJson(existing) === stableJson(binding)) return existing;
      throw new ExpertMcpBindingStoreError(
        "An immutable MCP binding already exists for this snapshot.",
        "revision_conflict",
      );
    }
    const contents = JSON.stringify(binding, null, 2) + "\n";
    if (Buffer.byteLength(contents, "utf8") > MAX_BINDING_BYTES) {
      throw new ExpertMcpBindingStoreError("Expert MCP binding is too large.", "invalid_input");
    }
    await assertBindingDirectory(directory);
    await writePrivateFileAtomically(filePath(snapshotId), contents);
    return binding;
  };

  const read = async (snapshotId: string): Promise<ExpertMcpBinding | null> =>
    readUnlocked(snapshotId);

  const createOnce = (
    snapshotId: string,
    rawBinding: ExpertMcpBinding,
  ): Promise<ExpertMcpBinding> =>
    withWriteLock(directory, async () => {
      validateSnapshotId(snapshotId);
      const binding = decodeBinding(rawBinding, "invalid_input");
      return writeUnlocked(snapshotId, binding);
    });

  const get = (
    snapshotId: string,
    capture: () => ExpertMcpBinding | Promise<ExpertMcpBinding>,
  ): Promise<ExpertMcpBinding> =>
    withWriteLock(directory, async () => {
      validateSnapshotId(snapshotId);
      const current = await readUnlocked(snapshotId);
      if (current) return current;
      const binding = decodeBinding(await capture(), "invalid_input");
      return writeUnlocked(snapshotId, binding);
    });

  const resolveToolsOnce: ExpertMcpBindingStore["resolveToolsOnce"] = (
    snapshotId,
    connectionId,
    resolution,
  ) =>
    withWriteLock(directory, async () => {
      validateSnapshotId(snapshotId);
      const current = await readUnlocked(snapshotId);
      if (!current) {
        throw new ExpertMcpBindingStoreError(
          "Expert MCP binding must exist before tool authorization is resolved.",
          "not_found",
        );
      }
      const index = current.servers.findIndex((server) => server.id === connectionId);
      if (index < 0) {
        throw new ExpertMcpBindingStoreError(
          "Expert MCP binding does not contain the connection being resolved.",
          "not_found",
        );
      }
      const server = current.servers[index]!;
      if (server.toolMode !== "all") {
        throw new ExpertMcpBindingStoreError(
          "Only all-mode Expert MCP bindings can resolve effective tools.",
          "invalid_input",
        );
      }
      if (server.effectiveTools !== undefined || server.resolutionStatus !== undefined) {
        if (server.effectiveTools === undefined || server.resolutionStatus === undefined) {
          throw new ExpertMcpBindingStoreError(
            "Expert MCP tool resolution state is corrupt.",
            "corrupt",
          );
        }
        return current;
      }
      if (resolution.status === "unavailable" && resolution.tools.length !== 0) {
        throw new ExpertMcpBindingStoreError(
          "Unavailable Expert MCP connections cannot authorize tools.",
          "invalid_input",
        );
      }
      const servers = current.servers.map((entry, entryIndex) =>
        entryIndex === index
          ? {
              ...entry,
              effectiveTools: [...resolution.tools],
              resolutionStatus: resolution.status,
            }
          : entry,
      );
      const updated = decodeBinding({ ...current, servers }, "invalid_input");
      const contents = JSON.stringify(updated, null, 2) + "\n";
      if (Buffer.byteLength(contents, "utf8") > MAX_BINDING_BYTES) {
        throw new ExpertMcpBindingStoreError("Expert MCP binding is too large.", "invalid_input");
      }
      await assertBindingDirectory(directory);
      await writePrivateFileAtomically(filePath(snapshotId), contents);
      return updated;
    });

  return { read, createOnce, get, resolveToolsOnce };
}
