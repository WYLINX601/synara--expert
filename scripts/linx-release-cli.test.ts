import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { spawnProcessSync } from "@synara/shared/processRuntime";

const root = resolve(import.meta.dirname, "..");
const environment = {
  can_admins_bypass: false,
  protection_rules: [
    {
      type: "required_reviewers",
      prevent_self_review: false,
      reviewers: [{ type: "User", reviewer: { id: 1 } }],
    },
  ],
};

function inspectProtection(unprotectedEnvironment?: string) {
  return spawnProcessSync(
    "bun",
    [
      "-e",
      `const base = "https://api.github.com/repos/WYLINX601/synara--expert";
       const environment = ${JSON.stringify(environment)};
       const unprotected = ${JSON.stringify(unprotectedEnvironment ?? "")};
       globalThis.fetch = async (input) => {
         const url = String(input);
         if (url === base) return Response.json({ visibility: "public" });
         for (const name of ["linx-signing", "linx-publish"]) {
           if (url === base + "/environments/" + name)
             return Response.json({ ...environment, can_admins_bypass: name === unprotected });
         }
         return new Response("Not Found", { status: 404 });
       };
       process.argv = [process.argv[0], "linx-release.ts", "protection"];
       // The CLI executes on import, after the isolated transport and argv are installed.
       await import(${JSON.stringify(resolve(root, "scripts/linx-release.ts"))});`,
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        GH_TOKEN: "isolated-test-token",
        GITHUB_REPOSITORY: "WYLINX601/synara--expert",
      },
      encoding: "utf8",
      timeout: 30_000,
    },
  );
}

describe("release protection command", () => {
  it("accepts the canonical repository endpoint and both protected environments", () => {
    const result = inspectProtection();
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });

  it.each(["linx-signing", "linx-publish"])("rejects administrator bypass in %s", (name) => {
    const result = inspectProtection(name);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("disabled admin bypass");
  });
});
