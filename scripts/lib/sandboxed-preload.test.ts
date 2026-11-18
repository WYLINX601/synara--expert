import { describe, expect, it } from "vitest";
import { assertSandboxedPreloadBundle } from "./sandboxed-preload";

describe("sandboxed preload bundle", () => {
  it("accepts the electron-only runtime", () => {
    expect(() =>
      assertSandboxedPreloadBundle('const { contextBridge } = require("electron");'),
    ).not.toThrow();
  });

  it.each([
    'const effect = require("effect");',
    'require("effect/unstable/rpc/Rpc");',
    'require("node:fs");',
    'require("zod");',
  ])("rejects unavailable runtime module %s", (source) => {
    expect(() => assertSandboxedPreloadBundle(source)).toThrow(
      "Sandboxed preload requires unavailable modules",
    );
  });

  it("reports each unavailable module once", () => {
    expect(() => assertSandboxedPreloadBundle('require("effect"); require("effect");')).toThrow(
      "effect",
    );
  });
});
