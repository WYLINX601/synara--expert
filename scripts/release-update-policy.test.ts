import { describe, expect, it } from "vitest";
import { resolveReleaseUpdatePolicy } from "./lib/release-update-policy.ts";
describe("Linx release policy", () => {
  it("binds a stable tag to product config rather than upstream package version", () => {
    expect(resolveReleaseUpdatePolicy("v0.1.15", "0.1.15")).toMatchObject({
      version: "0.1.15",
      tag: "v0.1.15",
      desktopFlavor: "workbench",
      isPrerelease: false,
    });
    for (const version of [
      "1.1.0",
      "0.1.14",
      "0.1.15-beta.1",
      "00.1.15",
      "0.1.15+local",
      "0.1.15\n",
    ])
      expect(() => resolveReleaseUpdatePolicy(version, "0.1.15")).toThrow();
  });
});
