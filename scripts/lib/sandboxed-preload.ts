const REQUIRE_CALL = /\brequire\s*\(\s*["']([^"']+)["']\s*\)/gu;

/**
 * Electron sandboxed preloads only expose `require("electron")`. Any other
 * runtime require fails before contextBridge runs, leaving the renderer with no
 * IPC surface at all. The desktop bundle must inline those dependencies.
 */
export function assertSandboxedPreloadBundle(source: string): void {
  const unavailable = [...source.matchAll(REQUIRE_CALL)]
    .map((match) => match[1]!)
    .filter((id) => id !== "electron");
  if (unavailable.length > 0)
    throw new Error(
      `Sandboxed preload requires unavailable modules: ${[...new Set(unavailable)].join(", ")}`,
    );
}
