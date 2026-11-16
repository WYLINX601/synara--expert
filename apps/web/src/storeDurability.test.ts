import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { makeFakeWindow, makeReadModel, makeReadModelThread } from "./storeTestFixtures";
import { PERSISTED_STATE_KEY } from "./storePersistence";
import { THREAD_VISITED_STORAGE_KEY } from "./threadVisitedPersistence";

// Import after reset: each case exercises module-owned persistence caches and
// the store subscription against a fresh isolated window/storage boundary.
beforeEach(() => {
  vi.useFakeTimers();
  vi.resetModules();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it("tracks the actual app-state debounce from acceptance to committed localStorage and cancels stale work after explicit persistence", async () => {
  const bytes = new Map<string, string>();
  vi.stubGlobal("window", makeFakeWindow(bytes));
  const { useStore, persistAppStateNow } = await import("./store");
  const { composerPersistenceOperationCount } = await import("./lib/composerPersistenceActivity");
  useStore.setState({ threadsHydrated: true, projects: [] });
  expect(composerPersistenceOperationCount()).toBe(1);
  expect(bytes.has(PERSISTED_STATE_KEY)).toBe(false);
  await vi.advanceTimersByTimeAsync(499);
  expect(composerPersistenceOperationCount()).toBe(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(composerPersistenceOperationCount()).toBe(0);
  expect(JSON.parse(bytes.get(PERSISTED_STATE_KEY)!).projectOrderCwds).toEqual([]);
  useStore.setState({ projects: [] });
  expect(composerPersistenceOperationCount()).toBe(1);
  persistAppStateNow();
  expect(composerPersistenceOperationCount()).toBe(0);
  expect(bytes.has(THREAD_VISITED_STORAGE_KEY)).toBe(true);
  // The fake window's writer is already a spy; exclude the commits asserted above.
  const write = vi.spyOn(window.localStorage, "setItem").mockClear();
  await vi.advanceTimersByTimeAsync(501);
  expect(write).not.toHaveBeenCalled();
});

it.each([PERSISTED_STATE_KEY, THREAD_VISITED_STORAGE_KEY])(
  "retains failed metadata persistence for %s until the unchanged latest state really saves",
  async (failedKey) => {
    const bytes = new Map<string, string>();
    const fakeWindow = makeFakeWindow(bytes);
    vi.stubGlobal("window", fakeWindow);
    let fail = true;
    // Capture the implementation, not the mutable mock wrapper (which would recurse).
    const setItem = fakeWindow.localStorage.setItem.getMockImplementation();
    if (!setItem) throw new Error("The isolated storage fixture must provide a writer");
    fakeWindow.localStorage.setItem.mockImplementation((key, value) => {
      if (fail && key === failedKey) throw new Error("Storage unavailable");
      setItem(key, value);
    });
    const { useStore } = await import("./store");
    const { composerPersistenceOperationCount } = await import("./lib/composerPersistenceActivity");
    useStore.getState().syncServerReadModel(makeReadModel(makeReadModelThread({})));
    await vi.advanceTimersByTimeAsync(500);
    expect(bytes.has(failedKey)).toBe(false);
    expect(composerPersistenceOperationCount()).toBe(1);
    fail = false;
    useStore.setState({ projects: [...useStore.getState().projects] });
    await vi.advanceTimersByTimeAsync(500);
    expect(bytes.has(failedKey)).toBe(true);
    expect(composerPersistenceOperationCount()).toBe(0);
  },
);

it("does not report unhydrated metadata as durably idle", async () => {
  vi.stubGlobal("window", makeFakeWindow(new Map()));
  const { useStore, persistAppStateNow } = await import("./store");
  const { composerPersistenceOperationCount } = await import("./lib/composerPersistenceActivity");
  useStore.setState({ threadsHydrated: false });
  persistAppStateNow();
  await vi.advanceTimersByTimeAsync(501);
  expect(composerPersistenceOperationCount()).toBe(1);
  useStore.setState({ threadsHydrated: true });
  persistAppStateNow();
  expect(composerPersistenceOperationCount()).toBe(0);
});
