import * as fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import * as path from "node:path";

import {
  ExpertConnectionConfig as ExpertConnectionConfigSchema,
  ExpertConnectionSaveInput,
  type ExpertConnectionConfig,
} from "@synara/contracts";
import { Effect, Schema } from "effect";

import { writeFileStringAtomically } from "../atomicWrite";
import { ensurePrivateDirectorySync, syncDirectoryEntry } from "../privatePathPermissions";

const MAX_CONFIG_BYTES = 64 * 1024;
const EXPERT_CONNECTION_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/u;
const writeTails = new Map<string, Promise<void>>();

export class ExpertConnectionStoreError extends Error {
  constructor(
    message: string,
    readonly code: "invalid_input" | "not_found" | "revision_conflict" | "corrupt",
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ExpertConnectionStoreError";
  }
}

export interface ExpertConnectionStore {
  list(): Promise<ExpertConnectionConfig[]>;
  read(id: string): Promise<ExpertConnectionConfig | null>;
  save(input: typeof ExpertConnectionSaveInput.Type): Promise<ExpertConnectionConfig>;
  remove(id: string, expectedRevision: number): Promise<void>;
}

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

function validateNoPlaintextCredentials(input: typeof ExpertConnectionSaveInput.Type): void {
  const { transport } = input;
  if (transport.type === "stdio") {
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
  // ponytail: process-local queue; use cross-process locking if stateDir is shared by servers.
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

export function createExpertConnectionStore(stateDir: string): ExpertConnectionStore {
  if (!path.isAbsolute(stateDir) || stateDir.includes("\0")) {
    throw new ExpertConnectionStoreError("State directory must be absolute.", "invalid_input");
  }
  const directory = path.join(path.resolve(stateDir), "expert-connections");
  ensurePrivateDirectorySync(directory);
  const filePath = (id: string) => {
    assertId(id);
    return path.join(directory, `${id}.json`);
  };

  const read = async (id: string): Promise<ExpertConnectionConfig | null> => {
    const target = filePath(id);
    let handle: fs.FileHandle;
    let before: Awaited<ReturnType<typeof fs.lstat>>;
    try {
      before = await fs.lstat(target);
      if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_CONFIG_BYTES) {
        throw new ExpertConnectionStoreError("Expert connection file is invalid.", "corrupt");
      }
      handle = await fs.open(
        target,
        fsConstants.O_RDONLY | (process.platform === "win32" ? 0 : fsConstants.O_NOFOLLOW),
      );
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return null;
      if (cause instanceof ExpertConnectionStoreError) throw cause;
      throw new ExpertConnectionStoreError("Failed to read expert connection.", "corrupt", {
        cause,
      });
    }
    try {
      const opened = await handle.stat();
      if (
        !opened.isFile() ||
        opened.dev !== before.dev ||
        opened.ino !== before.ino ||
        opened.size > MAX_CONFIG_BYTES
      ) {
        throw new ExpertConnectionStoreError("Expert connection file is invalid.", "corrupt");
      }
      const bytes = await handle.readFile();
      if (bytes.byteLength > MAX_CONFIG_BYTES) {
        throw new ExpertConnectionStoreError("Expert connection file is too large.", "corrupt");
      }
      let value: unknown;
      try {
        value = JSON.parse(bytes.toString("utf8")) as unknown;
      } catch (cause) {
        throw new ExpertConnectionStoreError("Expert connection file is corrupt.", "corrupt", {
          cause,
        });
      }
      const config = decode<ExpertConnectionConfig>(
        ExpertConnectionConfigSchema,
        value,
        "Expert connection file is invalid.",
        "corrupt",
      );
      if (config.id !== id) {
        throw new ExpertConnectionStoreError(
          "Expert connection file ID does not match.",
          "corrupt",
        );
      }
      return config;
    } finally {
      await handle.close();
    }
  };

  const list = async (): Promise<ExpertConnectionConfig[]> => {
    const names = (await fs.readdir(directory)).filter((name) => name.endsWith(".json"));
    const configs = await Promise.all(names.map((name) => read(name.slice(0, -5))));
    return configs
      .filter((config): config is ExpertConnectionConfig => config !== null)
      .sort(
        (left, right) =>
          right.updatedAt.localeCompare(left.updatedAt) || left.name.localeCompare(right.name),
      );
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
      if ((previous?.revision ?? undefined) !== input.expectedRevision) {
        throw new ExpertConnectionStoreError(
          "Expert connection revision changed; reload before saving.",
          "revision_conflict",
        );
      }
      const config = decode<ExpertConnectionConfig>(
        ExpertConnectionConfigSchema,
        {
          id: input.id,
          name: input.name,
          transport: input.transport,
          revision: (previous?.revision ?? 0) + 1,
          updatedAt: new Date().toISOString(),
        },
        "Expert connection input is invalid.",
        "invalid_input",
      );
      await Effect.runPromise(
        writeFileStringAtomically({
          filePath: filePath(config.id),
          contents: `${JSON.stringify(config, null, 2)}\n`,
        }),
      );
      return config;
    });

  const remove = (id: string, expectedRevision: number): Promise<void> =>
    withWriteLock(directory, async () => {
      if (!Number.isInteger(expectedRevision) || expectedRevision < 1) {
        throw new ExpertConnectionStoreError("Expected revision is invalid.", "invalid_input");
      }
      const previous = await read(id);
      if (!previous)
        throw new ExpertConnectionStoreError("Expert connection not found.", "not_found");
      if (previous.revision !== expectedRevision) {
        throw new ExpertConnectionStoreError(
          "Expert connection revision changed; reload before removing.",
          "revision_conflict",
        );
      }
      await fs.rm(filePath(id));
      await syncDirectoryEntry(directory);
    });

  return { list, read, save, remove };
}
