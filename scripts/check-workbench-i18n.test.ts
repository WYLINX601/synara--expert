import { describe, expect, it } from "vitest";
import { checkLegacyLiterals } from "./check-workbench-i18n";

const literal = { file: "apps/web/src/legacy.tsx", code: "ui-literal", message: "Old copy" };
const baseline = {
  formatVersion: 1,
  sourceSha: "e147a7c4e93eed3a8734b72213781f547a8d5f16",
  entries: [{ ...literal, count: 1 }],
};

describe("Workbench localization debt boundary", () => {
  it("allows only inherited occurrences, independently of line shifts", () => {
    expect(checkLegacyLiterals([{ ...literal, line: 200 }], baseline)).toEqual({
      errors: [],
      inherited: 1,
    });
    for (const extra of [
      literal,
      { ...literal, file: "apps/web/src/new.tsx" },
      { ...literal, message: "New copy" },
    ])
      expect(checkLegacyLiterals([literal, extra], baseline).errors).toHaveLength(1);
  });
  it("requires retiring removed allowances", () => {
    expect(checkLegacyLiterals([], baseline).errors).toHaveLength(1);
  });
  it("fails closed for malformed, negative and duplicate budgets", () => {
    for (const value of [
      null,
      {},
      { ...baseline, sourceSha: "main" },
      { ...baseline, entries: [{ ...literal, count: -1 }] },
      { ...baseline, entries: [...baseline.entries, ...baseline.entries] },
    ])
      expect(checkLegacyLiterals([literal], value).errors.length).toBeGreaterThan(0);
  });
});
