import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import viteConfig, { applyReactCompiler } from "../vite.config";

describe("React Compiler activation policy", () => {
  beforeAll(async () => {
    await Promise.all(viteConfig.plugins ?? []);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each([undefined, "", "0", "false", "yes", "true extra"])(
    "does not enable expensive development compilation for %s",
    (flag) => {
      vi.stubEnv("SYNARA_DEV_REACT_COMPILER", flag);
      expect(applyReactCompiler({}, { command: "serve", mode: "development" })).toBe(false);
    },
  );

  it.each(["1", "true", " TRUE "])("accepts the explicit development opt-in %s", (flag) => {
    vi.stubEnv("SYNARA_DEV_REACT_COMPILER", flag);
    expect(applyReactCompiler({}, { command: "serve", mode: "development" })).toBe(true);
  });

  it.each([
    { command: "build" as const, mode: "production" },
    { command: "build" as const, mode: "development" },
    { command: "serve" as const, mode: "test" },
  ])("does not let a disabled development flag override $command/$mode", (environment) => {
    vi.stubEnv("SYNARA_DEV_REACT_COMPILER", "0");
    expect(applyReactCompiler({}, environment)).toBe(true);
  });
});
