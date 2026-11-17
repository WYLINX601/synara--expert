import { describe, expect, it } from "vitest";

import { assertArm64MachO } from "./machOArchitecture";

describe("assertArm64MachO", () => {
  it("accepts a universal binary that carries the arm64 slice", () => {
    expect(() =>
      assertArm64MachO("/tmp/Linx.app/Contents/MacOS/Linx", "x86_64 arm64"),
    ).not.toThrow();
  });

  it("rejects a Mach-O without an arm64 slice", () => {
    expect(() => assertArm64MachO("/tmp/helper", "x86_64 arm64e")).toThrow(
      "Expected an arm64 Mach-O at /tmp/helper, found: x86_64, arm64e.",
    );
  });
});
