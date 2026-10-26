import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const entryPoint = fileURLToPath(new URL("../index.ts", import.meta.url));
const serverPackageDir = path.resolve(path.dirname(entryPoint), "..");

describe("management CLI parser process boundary", () => {
  it.each([
    ["unknown flag", ["skill", "list", "--bogus", "--json"]],
    ["invalid integer", ["skill", "list", "--expected-revision", "nope"]],
    ["invalid choice", ["expert", "skills", "list", "--flavor", "other"]],
    ["missing value", ["skill", "import", "--path"]],
  ])("emits one JSON usage error with exit 2 for %s", (_caseName, args) => {
    const result = spawnSync("bun", ["run", entryPoint, ...args], {
      cwd: serverPackageDir,
      encoding: "utf8",
      env: process.env,
    });

    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(2);
    expect(result.stdout).toBe("");
    const lines = result.stderr.trim().split(/\r?\n/u);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({
      version: 1,
      ok: false,
      error: { code: "usage_error", exitCode: 2 },
    });
  });
});
