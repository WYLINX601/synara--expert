import * as Crypto from "node:crypto";
import { constants as fsConstants } from "node:fs";
import * as fs from "node:fs/promises";

import { Effect, FileSystem, Layer, Path } from "effect";

import { writeFileStringAtomically } from "../../atomicWrite";
import { ServerConfig } from "../../config";
import { ensurePrivateDirectorySync } from "../../privatePathPermissions";
import {
  SecretStoreError,
  ServerSecretStore,
  type ServerSecretStoreShape,
} from "../Services/ServerSecretStore";

const secretFileName = (name: string): string => `${name.replace(/[^a-zA-Z0-9_.-]/g, "_")}.bin`;
const MAX_SECRET_FILE_BYTES = 16 * 1024 * 1024;

async function readSecretFile(secretPath: string): Promise<Uint8Array | null> {
  let before: Awaited<ReturnType<typeof fs.lstat>>;
  try {
    before = await fs.lstat(secretPath);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw cause;
  }
  if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_SECRET_FILE_BYTES) {
    throw new Error("Secret file is invalid.");
  }

  const flags = fsConstants.O_RDONLY | (process.platform === "win32" ? 0 : fsConstants.O_NOFOLLOW);
  const handle = await fs.open(secretPath, flags);
  try {
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.size > MAX_SECRET_FILE_BYTES
    ) {
      throw new Error("Secret file is invalid.");
    }

    const chunks: Buffer[] = [];
    let total = 0;
    while (true) {
      const remaining = MAX_SECRET_FILE_BYTES + 1 - total;
      if (remaining <= 0) throw new Error("Secret file is invalid.");
      const chunk = Buffer.alloc(Math.min(64 * 1024, remaining));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > MAX_SECRET_FILE_BYTES) throw new Error("Secret file is invalid.");
      chunks.push(chunk.subarray(0, bytesRead));
    }
    return Uint8Array.from(Buffer.concat(chunks, total));
  } finally {
    await handle.close();
  }
}

export const makeServerSecretStoreAt = (secretsDir: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    yield* Effect.try({
      try: () => ensurePrivateDirectorySync(secretsDir),
      catch: (cause) =>
        new SecretStoreError({ message: "Failed to create secrets directory.", cause }),
    });

    const resolveSecretPath = (name: string) => path.join(secretsDir, secretFileName(name));

    const get: ServerSecretStoreShape["get"] = (name) =>
      Effect.tryPromise({
        try: () => readSecretFile(resolveSecretPath(name)),
        catch: (cause) =>
          new SecretStoreError({ message: `Failed to read secret ${name}.`, cause }),
      });

    const set: ServerSecretStoreShape["set"] = (name, value) =>
      writeFileStringAtomically({
        filePath: resolveSecretPath(name),
        contents: value,
        mode: 0o600,
      }).pipe(
        Effect.mapError(
          (cause) =>
            new SecretStoreError({
              message: `Failed to persist secret ${name}.`,
              cause,
            }),
        ),
      );

    const getOrCreateRandom: ServerSecretStoreShape["getOrCreateRandom"] = (name, bytes) =>
      get(name).pipe(
        Effect.flatMap((existing) => {
          if (existing) return Effect.succeed(existing);
          const generated = Uint8Array.from(Crypto.randomBytes(bytes));
          return set(name, generated).pipe(Effect.as(generated));
        }),
      );

    const remove: ServerSecretStoreShape["remove"] = (name) =>
      fileSystem.remove(resolveSecretPath(name), { force: true }).pipe(
        Effect.mapError(
          (cause) =>
            new SecretStoreError({
              message: `Failed to remove secret ${name}.`,
              cause,
            }),
        ),
      );

    return { get, set, getOrCreateRandom, remove } satisfies ServerSecretStoreShape;
  });

export const makeServerSecretStore = Effect.gen(function* () {
  const serverConfig = yield* ServerConfig;
  return yield* makeServerSecretStoreAt(serverConfig.secretsDir);
});

export const ServerSecretStoreLive = Layer.effect(ServerSecretStore, makeServerSecretStore);
