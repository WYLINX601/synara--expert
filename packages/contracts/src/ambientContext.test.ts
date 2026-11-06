import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import {
  AmbientContextObservation,
  AmbientContextPublication,
  AmbientContextSnapshot,
} from "./ambientContext";

const base = {
  schemaVersion: 1,
  id: "o1",
  targetKey: "opaque",
  capturedAt: "2026-11-06T00:00:00.000Z",
  method: "editor",
  confidence: "exact",
  type: "selection.text",
  value: { text: "笔记" },
};

describe("ambient context boundary", () => {
  it("accepts bounded typed data and strips unknown instruction fields", () => {
    const value = Schema.decodeUnknownSync(AmbientContextObservation)({
      ...base,
      instructions: "execute",
    });
    expect(value).toEqual(base);
  });
  it.each([
    { type: "unknown" },
    { value: { path: "/private" } },
    { capturedAt: "2026-02-30T00:00:00.000Z" },
    { value: { text: "x".repeat(16_385) } },
    {
      type: "selection.location",
      value: { start: { line: 2, column: 0 }, end: { line: 1, column: 0 } },
    },
  ])("rejects invalid payload %j", (change) => {
    expect(() =>
      Schema.decodeUnknownSync(AmbientContextObservation)({ ...base, ...change }),
    ).toThrow();
  });
  it("rejects aggregate overflow, excessive observations, and negative sequence", () => {
    const large = { ...base, value: { text: "x".repeat(16_384) } };
    for (const publication of [
      { sequence: 1, observations: Array.from({ length: 4 }, () => large) },
      { sequence: 1, observations: Array.from({ length: 65 }, () => base) },
      { sequence: -1, observations: [] },
    ])
      expect(() => Schema.decodeUnknownSync(AmbientContextPublication)(publication)).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(AmbientContextSnapshot)({
        schemaVersion: 1,
        id: "s1",
        capturedAt: base.capturedAt,
        items: [{ observation: base, provenance: [], ambiguous: false }],
      }),
    ).toThrow();
  });
});
