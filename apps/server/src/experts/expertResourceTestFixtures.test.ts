import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Exit, Layer, ManagedRuntime } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";
import { ServerConfig } from "../config";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient";
import { createFileResourceStore } from "./FileResourceStore";
import { createSkillLibraryStore } from "./SkillLibraryStore";
import { readonlyResourceTestConfigLayer } from "./expertResourceTestFixtures";

const body =
  "---\nname: fixture-method\ndescription: Lifecycle regression\n---\nRetain the sealed method.\n";

async function sealRules(stateDir: string) {
  const source = path.join(stateDir, "source");
  await fs.mkdir(source);
  await fs.writeFile(path.join(source, "rules.txt"), "Retain the sealed rules.");
  return createFileResourceStore(stateDir).seal(source);
}

describe("private readonly resource fixture lifecycle", () => {
  it.each([false, true])(
    "closes consumers before removing sealed resources, business failure=%s",
    async (fail) => {
      const survivor = ManagedRuntime.make(
        readonlyResourceTestConfigLayer("readonly-survivor-").pipe(
          Layer.provide(NodeServices.layer),
        ),
      );
      try {
        const survivorConfig = await survivor.runPromise(
          Effect.gen(function* () {
            return yield* ServerConfig;
          }),
        );
        const retained = await sealRules(survivorConfig.stateDir);
        const retainedMode = (await fs.stat(retained.rootPath)).mode;
        const order: string[] = [];
        let baseDir = "";
        const consumer = Layer.effectDiscard(
          Effect.gen(function* () {
            const config = yield* ServerConfig;
            const sql = yield* SqlClient.SqlClient;
            baseDir = config.baseDir;
            const library = createSkillLibraryStore(config.stateDir);
            yield* Effect.addFinalizer(() =>
              Effect.promise(async () => {
                await library.dispose();
                order.push("library");
              }),
            );
            const sealed = yield* Effect.promise(() => sealRules(config.stateDir));
            const skill = yield* Effect.promise(
              async () =>
                (
                  await library.execute({
                    action: "create",
                    name: "fixture-method",
                    body,
                    tags: [],
                  })
                ).skill!,
            );
            const skillFile = path.join(
              config.stateDir,
              "experts",
              "skill-packages",
              skill.packageId,
              "content",
              "SKILL.md",
            );
            // A link to a different live fixture must not make that fixture ours.
            yield* Effect.promise(() =>
              fs.symlink(retained.rootPath, path.join(config.stateDir, "other-fixture"), "dir"),
            );
            if (process.platform !== "win32") {
              expect((yield* Effect.promise(() => fs.stat(sealed.rootPath))).mode & 0o222).toBe(0);
              expect((yield* Effect.promise(() => fs.stat(skillFile))).mode & 0o222).toBe(0);
            }
            yield* Effect.addFinalizer(() =>
              Effect.gen(function* () {
                // Finalizers still need their bindings, immutable bytes and live SQL.
                expect(
                  yield* Effect.promise(() =>
                    fs.readFile(path.join(sealed.rootPath, "rules.txt"), "utf8"),
                  ),
                ).toBe("Retain the sealed rules.");
                expect(yield* Effect.promise(() => fs.readFile(skillFile, "utf8"))).toBe(body);
                expect(yield* sql<{ value: number }>`SELECT 1 AS value`).toEqual([{ value: 1 }]);
                order.push("consumer");
              }).pipe(Effect.orDie),
            );
          }),
        ).pipe(
          Layer.provideMerge(
            Layer.mergeAll(
              NodeSqliteClient.layerMemory(),
              readonlyResourceTestConfigLayer("readonly-owned-"),
            ),
          ),
          Layer.provide(NodeServices.layer),
        );
        const businessError = new Error("Original fixture business failure");
        const exit = await Effect.runPromise(
          Effect.exit(
            Effect.scoped(
              Effect.gen(function* () {
                yield* ServerConfig;
                if (fail) return yield* Effect.fail(businessError);
              }).pipe(Effect.provide(consumer)),
            ),
          ),
        );
        expect(exit).toEqual(fail ? Exit.fail(businessError) : Exit.succeed(undefined));
        expect(order).toEqual(["consumer", "library"]);
        await expect(fs.stat(baseDir)).rejects.toMatchObject({ code: "ENOENT" });
        // Neither bytes nor readonly permissions of the other live owner changed.
        expect(await fs.readFile(path.join(retained.rootPath, "rules.txt"), "utf8")).toBe(
          "Retain the sealed rules.",
        );
        expect((await fs.stat(retained.rootPath)).mode).toBe(retainedMode);
        await createFileResourceStore(survivorConfig.stateDir).read(retained.packageId);
      } finally {
        await survivor.dispose();
      }
    },
  );
});
