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
    return Schema.decodeUnknownSync(ExpertMcpBindingSchema)(value);
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

  return { read, createOnce, get };
}
