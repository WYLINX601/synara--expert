import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";

import { ServerConfig } from "../../config";
import { ServerSecretStore, type SecretStoreError } from "../Services/ServerSecretStore";
import { makeServerSecretStoreAt, ServerSecretStoreLive } from "./ServerSecretStore";

const makeLayer = () =>
  ServerSecretStoreLive.pipe(
    Layer.provide(
      ServerConfig.layerTest(process.cwd(), {
        prefix: "synara-secret-store-test-",
      }),
    ),
    Layer.provide(NodeServices.layer),
  );

const runWithSecretStore = (effect: Effect.Effect<void, SecretStoreError, ServerSecretStore>) =>
  effect.pipe(Effect.provide(makeLayer()), Effect.scoped, Effect.runPromise);

describe("ServerSecretStoreLive", () => {
  it("persists and reads named secrets", async () => {
    await runWithSecretStore(
      Effect.gen(function* () {
        const store = yield* ServerSecretStore;
        yield* store.set("session-signing", new Uint8Array([1, 2, 3]));

        expect(Array.from((yield* store.get("session-signing")) ?? [])).toEqual([1, 2, 3]);
      }),
    );
  });

  it("reuses generated random secrets", async () => {
    await runWithSecretStore(
      Effect.gen(function* () {
        const store = yield* ServerSecretStore;
        const first = yield* store.getOrCreateRandom("websocket", 32);
        const second = yield* store.getOrCreateRandom("websocket", 32);

        expect(first.byteLength).toBe(32);
        expect(Array.from(second)).toEqual(Array.from(first));
      }),
    );
  });

  it("removes secrets idempotently", async () => {
    await runWithSecretStore(
      Effect.gen(function* () {
        const store = yield* ServerSecretStore;
        yield* store.set("remove-me", new Uint8Array([9]));
        yield* store.remove("remove-me");
        yield* store.remove("remove-me");

        expect(yield* store.get("remove-me")).toBeNull();
      }),
    );
  });
});

describe("makeServerSecretStoreAt", () => {
  it("rejects symlinked secret files without reading their targets", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "synara-secret-store-at-test-"));
    const secretsDir = path.join(root, "secrets");
    const externalPath = path.join(root, "outside.bin");
    await mkdir(secretsDir);
    await writeFile(externalPath, "private-outside-value");
    await symlink(externalPath, path.join(secretsDir, "linked.bin"));

    try {
      const store = await Effect.runPromise(
        makeServerSecretStoreAt(secretsDir).pipe(Effect.provide(NodeServices.layer)),
      );
      const error = await Effect.runPromise(store.get("linked")).then(
        () => null,
        (cause: unknown) => cause as Error,
      );
      expect(error).toBeInstanceOf(Error);
      expect(error?.message).not.toContain("private-outside-value");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a symlinked secrets directory", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "synara-secret-store-at-link-test-"));
    const externalDir = path.join(root, "outside");
    const secretsDir = path.join(root, "secrets");
    await mkdir(externalDir);
    await symlink(externalDir, secretsDir);

    try {
      await expect(
        Effect.runPromise(
          makeServerSecretStoreAt(secretsDir).pipe(Effect.provide(NodeServices.layer)),
        ),
      ).rejects.toThrow(/secrets directory/u);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
