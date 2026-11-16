import * as Crypto from "node:crypto";
import { readServerSecretFile, resolveServerSecretPath } from "@synara/shared/serverSecretFiles";

import { Effect, FileSystem, Layer } from "effect";

import { writeFileStringAtomically } from "../../atomicWrite";
import { ServerConfig } from "../../config";
import { ensurePrivateDirectorySync } from "../../privatePathPermissions";
import {
  SecretStoreError,
  ServerSecretStore,
  type ServerSecretStoreShape,
} from "../Services/ServerSecretStore";

export const makeServerSecretStoreAt = (secretsDir: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;

    yield* Effect.try({
      try: () => ensurePrivateDirectorySync(secretsDir),
      catch: (cause) =>
        new SecretStoreError({ message: "Failed to create secrets directory.", cause }),
    });

    const resolveSecretPath = (name: string) => resolveServerSecretPath(secretsDir, name);

    const get: ServerSecretStoreShape["get"] = (name) =>
      Effect.tryPromise({
        try: () => readServerSecretFile(resolveSecretPath(name)),
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
