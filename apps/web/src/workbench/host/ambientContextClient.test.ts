import { WS_AMBIENT_CONTEXT_CAPABILITY } from "@synara/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as nativeApi from "~/nativeApi";
import { ambientResourceSnapshot } from "~/lib/ambientContext";
import { readAmbientContextSendAuthorization } from "./ambientContextClient";

const snapshot = ambientResourceSnapshot({
  sourceId: "obsidian",
  targetKey: "note",
  uri: "obsidian://open?file=Note.md",
  title: "Note.md",
});

beforeEach(() => {
  vi.spyOn(nativeApi, "readNativeApiServerConnection").mockReturnValue({
    generation: "connection:1",
    connected: true,
  });
  vi.spyOn(nativeApi, "readNativeApiServerCapabilityState").mockReturnValue("supported");
});
afterEach(() => vi.restoreAllMocks());

describe("ambient context send compatibility", () => {
  it("requires the negotiated capability on the current connected generation", () => {
    expect(readAmbientContextSendAuthorization(snapshot)).toEqual({
      allowed: true,
      generation: "connection:1",
    });
    expect(nativeApi.readNativeApiServerCapabilityState).toHaveBeenCalledWith(
      WS_AMBIENT_CONTEXT_CAPABILITY,
    );
    expect(readAmbientContextSendAuthorization(snapshot, "connection:1").allowed).toBe(true);
  });
  it.each(["unsupported", "unknown"] as const)(
    "refuses %s support without changing the frozen snapshot",
    (capability) => {
      vi.mocked(nativeApi.readNativeApiServerCapabilityState).mockReturnValue(capability);
      const before = structuredClone(snapshot);
      const result = readAmbientContextSendAuthorization(snapshot);
      expect(result.allowed).toBe(false);
      if (!result.allowed)
        expect(result.message).toMatch(
          capability === "unsupported" ? /Update the Synara server/ : /Reconnect/,
        );
      expect(snapshot).toEqual(before);
    },
  );
  it("refuses disconnected or replaced generations even if support was previously known", () => {
    vi.mocked(nativeApi.readNativeApiServerConnection).mockReturnValue({
      generation: "connection:1",
      connected: false,
    });
    expect(readAmbientContextSendAuthorization(snapshot, "connection:1").allowed).toBe(false);
    expect(nativeApi.readNativeApiServerCapabilityState).not.toHaveBeenCalled();
    vi.mocked(nativeApi.readNativeApiServerConnection).mockReturnValue({
      generation: "connection:2",
      connected: true,
    });
    expect(readAmbientContextSendAuthorization(snapshot, "connection:1").allowed).toBe(false);
    expect(readAmbientContextSendAuthorization(snapshot, "connection:2").allowed).toBe(true);
  });
  it("does not gate ordinary messages or empty snapshots", () => {
    vi.mocked(nativeApi.readNativeApiServerCapabilityState).mockReturnValue("unsupported");
    expect(readAmbientContextSendAuthorization(undefined)).toEqual({
      allowed: true,
      generation: null,
    });
    expect(readAmbientContextSendAuthorization({ ...snapshot, items: [] })).toEqual({
      allowed: true,
      generation: null,
    });
    expect(nativeApi.readNativeApiServerConnection).not.toHaveBeenCalled();
    expect(nativeApi.readNativeApiServerCapabilityState).not.toHaveBeenCalled();
  });
});
