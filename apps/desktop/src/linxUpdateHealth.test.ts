import { describe, expect, it, vi } from "vitest";
import {
  isLinxBackendHealthReady,
  readLinxBackendHealth,
  waitForLinxBackendHealth,
} from "./linxUpdateHealth";

const expected = { pid: 321, homePath: "/fixture/linx", sourceCommit: "a".repeat(40) };
const health = () => ({
  startupReady: true,
  projection: { state: "healthy", inFlight: false },
  linxUpdate: { ...expected, clientConnected: true },
});

describe("native backend/client update proof", () => {
  it("requires actual matching child PID, home, full source, healthy projections and managed client", () => {
    expect(isLinxBackendHealthReady(health(), expected)).toBe(true);
    const invalid = [
      null,
      {},
      { ...health(), startupReady: false },
      { ...health(), projection: { state: "recovering", inFlight: false } },
      { ...health(), projection: { state: "healthy", inFlight: true } },
      { ...health(), linxUpdate: { ...health().linxUpdate, pid: 322 } },
      { ...health(), linxUpdate: { ...health().linxUpdate, homePath: "/fixture/other" } },
      { ...health(), linxUpdate: { ...health().linxUpdate, sourceCommit: "b".repeat(40) } },
      {
        ...health(),
        linxUpdate: { ...health().linxUpdate, sourceCommit: expected.sourceCommit.slice(0, 12) },
      },
      { ...health(), linxUpdate: { ...health().linxUpdate, clientConnected: false } },
    ];
    for (const value of invalid) expect(isLinxBackendHealthReady(value, expected)).toBe(false);
    expect(isLinxBackendHealthReady(health(), { ...expected, sourceCommit: "" })).toBe(false);
  });

  it("cannot complete if the child changed during an otherwise healthy read", async () => {
    let current = true;
    const read = vi.fn(async () => {
      current = false;
      return health();
    });
    await expect(
      waitForLinxBackendHealth({
        ...expected,
        baseUrl: "http://127.0.0.1:1",
        token: "private",
        isCurrent: () => current,
        read,
      }),
    ).rejects.toThrow("exited or changed");
  });

  it("never reports client success from ordinary HTTP readiness alone", async () => {
    await expect(
      waitForLinxBackendHealth({
        ...expected,
        baseUrl: "http://127.0.0.1:1",
        token: "private",
        timeoutMs: 0,
        isCurrent: () => true,
        read: async () => ({
          startupReady: true,
          projection: { state: "healthy", inFlight: false },
        }),
      }),
    ).rejects.toThrow("not proven");
  });

  it("accepts matching evidence only while the child remains current", async () => {
    await expect(
      waitForLinxBackendHealth({
        ...expected,
        baseUrl: "http://127.0.0.1:1",
        token: "private",
        isCurrent: () => true,
        read: async () => health(),
      }),
    ).resolves.toBeUndefined();
  });

  it.each(["https://127.0.0.1:1", "http://example.com", "http://user:secret@127.0.0.1:1"])(
    "refuses nonlocal or credential-bearing health URL %s",
    async (url) => {
      await expect(readLinxBackendHealth(url, "private")).rejects.toThrow("authenticated loopback");
    },
  );
});
