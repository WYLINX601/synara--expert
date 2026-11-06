import { describe, expect, it } from "vitest";
import { zenCompactHeight, zenModeEntryBlock } from "./zenMode";

describe("Zen entry eligibility", () => {
  it("requires an existing chat route without inventing a project", () => {
    expect(zenModeEntryBlock({ threadId: null, terminal: false })).toBe("choose-chat");
    expect(zenModeEntryBlock({ threadId: "chat", terminal: false })).toBeNull();
  });

  it.each([
    { splitViewId: "split", terminal: false },
    { view: "editor", terminal: false },
    { terminal: true },
  ])("refuses unsupported layouts instead of remounting their chat (%j)", (layout) => {
    expect(zenModeEntryBlock({ threadId: "chat", ...layout })).toBe("unsupported");
  });
});

describe("Zen compact height", () => {
  it("rounds intrinsic blocks and clamps to the shared native limits", () => {
    expect(zenCompactHeight(43, 40)).toBe(96);
    expect(zenCompactHeight(43.25, 110.5)).toBe(154);
    expect(zenCompactHeight(43, 1200)).toBe(600);
  });
  it.each([
    [0, 80],
    [43, 0],
    [-1, 80],
    [43, Number.NaN],
    [Infinity, 80],
  ])("ignores unavailable measurements (%s, %s)", (toolbar, composer) => {
    expect(zenCompactHeight(toolbar, composer)).toBeUndefined();
  });
});
