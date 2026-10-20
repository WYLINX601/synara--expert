import { describe, expect, it } from "vitest";

import { parseSkillPackageSwitchArgs, runSkillPackageSwitchCli } from "./skill-package-switch.ts";

describe("expert skill package switch CLI", () => {
  it("requires a concrete input for preview and a reviewed digest for apply", () => {
    expect(parseSkillPackageSwitchArgs(["preview", "--input", "request.json"])).toEqual({
      kind: "preview",
      inputPath: "request.json",
    });
    expect(
      parseSkillPackageSwitchArgs([
        "apply",
        "--switch-id",
        "6f4e1546-9d65-490a-bef2-a5f6b151a0f5",
        "--digest",
        "a".repeat(64),
      ]),
    ).toEqual({
      kind: "apply",
      switchId: "6f4e1546-9d65-490a-bef2-a5f6b151a0f5",
      digest: "a".repeat(64),
    });
  });

  it("reads progress by explicit switch ID and refuses an absent owner RPC endpoint", async () => {
    expect(
      parseSkillPackageSwitchArgs([
        "progress",
        "--switch-id",
        "6f4e1546-9d65-490a-bef2-a5f6b151a0f5",
      ]),
    ).toEqual({ kind: "progress", switchId: "6f4e1546-9d65-490a-bef2-a5f6b151a0f5" });
    await expect(
      runSkillPackageSwitchCli(
        ["progress", "--switch-id", "6f4e1546-9d65-490a-bef2-a5f6b151a0f5"],
        {},
      ),
    ).rejects.toThrow(/SYNARA_EXPERT_SWITCH_OWNER_URL/u);
  });

  it("rejects missing or reordered flags instead of guessing an apply target", () => {
    expect(() => parseSkillPackageSwitchArgs(["apply", "--switch-id", "id"])).toThrow(
      /Usage: skill-package-switch apply/u,
    );
    expect(() =>
      parseSkillPackageSwitchArgs(["apply", "--digest", "a", "--switch-id", "id"]),
    ).toThrow(/Usage: skill-package-switch apply/u);
  });
});
