import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { spawnProcessSync } from "@synara/shared/processRuntime";
import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("workspace test command", () => {
  it.each([false, true])(
    "serializes package work and collects every outcome (package failure=%s)",
    async (packageFailure) => {
      const root = await mkdtemp(join(tmpdir(), "synara-test-runner-"));
      try {
        const source = JSON.parse(await readFile(join(repositoryRoot, "package.json"), "utf8"));
        const eventsPath = join(root, "events.jsonl");
        const lockPath = join(root, "resource.lock");
        await symlink(
          join(repositoryRoot, "node_modules"),
          join(root, "node_modules"),
          process.platform === "win32" ? "junction" : "dir",
        );
        await writeFile(
          join(root, "package.json"),
          JSON.stringify({
            name: "test-runner-fixture",
            private: true,
            packageManager: source.packageManager,
            workspaces: ["packages/*"],
            scripts: { test: source.scripts.test },
          }),
        );
        await writeFile(
          join(root, "turbo.json"),
          JSON.stringify({
            tasks: {
              test: { cache: false, outputs: [] },
              "@fixture/after#test": { dependsOn: ["@fixture/first#test"] },
            },
          }),
        );
        const names = ["first", "after", "independent"];
        await writeFile(
          join(root, "bun.lock"),
          JSON.stringify({
            lockfileVersion: 1,
            workspaces: Object.fromEntries([
              ["", { name: "test-runner-fixture" }],
              ...names.map((name) => [`packages/${name}`, { name: `@fixture/${name}` }]),
            ]),
          }),
        );
        for (const name of names) {
          const directory = join(root, "packages", name);
          await mkdir(directory, { recursive: true });
          await writeFile(
            join(directory, "package.json"),
            JSON.stringify({
              name: `@fixture/${name}`,
              private: true,
              scripts: { test: "node test.cjs" },
            }),
          );
          await writeFile(
            join(directory, "test.cjs"),
            [
              'const fs = require("node:fs");',
              `const events = ${JSON.stringify(eventsPath)};`,
              `const lock = ${JSON.stringify(lockPath)};`,
              `const name = ${JSON.stringify(name)};`,
              'fs.closeSync(fs.openSync(lock, "wx"));',
              'fs.appendFileSync(events, JSON.stringify({ name, phase: "start" }) + "\\n");',
              // This integration probes real OS process scheduling: fake timers cannot
              // drive Turbo's child runtimes. A bounded resource hold exposes overlap.
              "setTimeout(() => {",
              "  fs.unlinkSync(lock);",
              '  fs.appendFileSync(events, JSON.stringify({ name, phase: "end" }) + "\\n");',
              `  process.exit(${name === "first" && packageFailure ? 7 : 0});`,
              "}, 200);",
            ].join("\n"),
          );
        }

        const result = spawnProcessSync("bun", ["run", "test"], {
          cwd: root,
          encoding: "utf8",
          timeout: 10_000,
          maxBuffer: 1024 * 1024,
          env: { ...process.env, TURBO_TELEMETRY_DISABLED: "1" },
        });
        expect(result.error, result.stderr).toBeUndefined();
        expect(result.signal, result.stderr).toBeNull();
        expect(result.status, result.stdout + result.stderr).toBe(packageFailure ? 7 : 0);
        const events = (await readFile(eventsPath, "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as { name: string; phase: "start" | "end" });
        let active: string | null = null;
        for (const event of events) {
          if (event.phase === "start") {
            expect(active).toBeNull();
            active = event.name;
          } else {
            expect(active).toBe(event.name);
            active = null;
          }
        }
        expect(active).toBeNull();
        expect(
          events
            .filter((event) => event.phase === "end")
            .map((event) => event.name)
            .toSorted(),
        ).toEqual(names.toSorted());
        expect(
          events.findIndex((event) => event.name === "after" && event.phase === "start"),
        ).toBeGreaterThan(
          events.findIndex((event) => event.name === "first" && event.phase === "end"),
        );
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
    15_000,
  );
});
