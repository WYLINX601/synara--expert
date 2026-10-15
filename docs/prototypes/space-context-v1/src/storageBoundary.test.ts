import { afterEach, describe, expect, it, vi } from "vitest";
import { createMemoryStorage, installStorageBoundary } from "./storageBoundary";
import { useStore } from "./storeBoundary";

describe("prototype storage isolation", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("keeps writes in page memory and resets them in a new page", () => {
    const storage = createMemoryStorage();
    expect(storage.getItem("synara:renderer-state:v8")).toBeNull();
    storage.setItem("synara:renderer-state:v8", "synthetic test value");
    expect(storage.getItem("synara:renderer-state:v8")).toBe("synthetic test value");
    expect(storage.length).toBe(1);
    expect(createMemoryStorage().getItem("synara:renderer-state:v8")).toBeNull();
  });
  it("installs without reading or invoking the real browser storage", () => {
    const originalGetter = vi.fn(() => {
      throw new Error("real storage must not be read");
    });
    const page = {};
    Object.defineProperty(page, "localStorage", { configurable: true, get: originalGetter });
    Object.defineProperty(page, "sessionStorage", { configurable: true, get: originalGetter });
    vi.stubGlobal("window", page);
    installStorageBoundary();
    window.localStorage.setItem("synara:project-instructions:v1", "demo");
    expect(window.localStorage.getItem("synara:project-instructions:v1")).toBe("demo");
    expect(originalGetter).not.toHaveBeenCalled();
  });
  it("rejects production store hydration and writes", () => {
    expect(() => useStore()).toThrow("正式工作区状态");
    expect(() => useStore.getState()).toThrow("正式工作区状态");
    expect(() => useStore.setState()).toThrow("正式工作区状态");
  });
});
