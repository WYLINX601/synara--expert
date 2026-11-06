import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import * as Fs from "node:fs/promises";
import * as Os from "node:os";
import * as Path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { runInNewContext } from "node:vm";

const require = createRequire(import.meta.url);

it("bundles capture.cjs into the installable CommonJS plugin entry", async () => {
  const repository = Path.resolve(Path.dirname(fileURLToPath(import.meta.url)), "../../../..");
  const output = Path.join(Os.tmpdir(), `synara-context-plugin-${randomUUID()}.cjs`);
  try {
    execFileSync(
      "bun",
      [
        "build",
        Path.join(repository, "apps/obsidian-plugin/main.js"),
        "--target=node",
        "--format=cjs",
        "--external=obsidian",
        `--outfile=${output}`,
      ],
      { cwd: repository, stdio: "pipe" },
    );
    const bundled = await Fs.readFile(output, "utf8");
    expect(bundled).not.toContain('require("./capture.cjs")');

    const module = { exports: undefined as unknown };
    runInNewContext(bundled, {
      module,
      require: (id: string) => {
        if (id === "obsidian")
          return { Plugin: class {}, PluginSettingTab: class {}, Setting: class {} };
        if (id === "./capture.cjs") throw new Error("Obsidian plugin directory has no capture.cjs");
        return require(id);
      },
    });
    expect(module.exports).toBeTypeOf("function");
  } finally {
    await Fs.rm(output, { force: true });
  }
});
