// Native UI imports are evaluated only after this page-local Storage replacement.
// No method delegates to the browser's persisted Synara storage.
export function createMemoryStorage(): Storage {
  const entries = new Map<string, string>();
  return {
    get length() {
      return entries.size;
    },
    clear: () => entries.clear(),
    getItem: (key) => entries.get(String(key)) ?? null,
    key: (index) => Array.from(entries.keys())[index] ?? null,
    removeItem: (key) => entries.delete(String(key)),
    setItem: (key, value) => {
      entries.set(String(key), String(value));
    },
  };
}

export function installStorageBoundary() {
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: createMemoryStorage(),
  });
  Object.defineProperty(window, "sessionStorage", {
    configurable: true,
    value: createMemoryStorage(),
  });
}
