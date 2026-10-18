import { describe, expect, it } from "vitest";
import { isExpertProvider } from "./expertProviders";

describe("Expert provider support", () => {
  it("allows implemented projections without widening to other drivers", () => {
    for (const provider of ["codex", "pi", "claudeAgent", "omp"])
      expect(isExpertProvider(provider)).toBe(true);
    for (const provider of ["claude", "opencode", "droid", "", null, undefined])
      expect(isExpertProvider(provider)).toBe(false);
  });
});
