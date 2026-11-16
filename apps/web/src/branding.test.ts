import { afterEach, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.resetModules();
});

it.each([
  ["linx:", "Linx", "Linx"],
  ["linx-preview:", "Linx", "Linx Preview"],
  ["synara:", "Synara", "Synara"],
  ["synara-beta:", "Synara", "Synara Beta"],
  ["synara-canary:", "Synara", "Synara Canary"],
  ["synara-cua:", "Synara", "Synara"],
])("brands %s without changing unrelated flavor names", async (protocol, base, display) => {
  vi.stubGlobal("window", { location: { protocol } });
  vi.stubEnv("DEV", false);
  // Re-load the module to exercise startup-time protocol identity capture.
  const branding = await import("./branding");
  expect(branding.APP_BASE_NAME).toBe(base);
  expect(branding.APP_DISPLAY_NAME).toBe(display);
});
