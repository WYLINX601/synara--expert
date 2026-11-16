import { afterEach, describe, expect, it, vi } from "vitest";
// Dynamic import deliberately exercises first module evaluation after installing
// the synthetic env grant; a static import would consume it before test setup.

const original = process.env.LINX_HOME_OWNERSHIP_NONCE;
afterEach(() => {
  if (original === undefined) delete process.env.LINX_HOME_OWNERSHIP_NONCE;
  else process.env.LINX_HOME_OWNERSHIP_NONCE = original;
  vi.resetModules();
});

describe("pre-provider ephemeral home grant", () => {
  it("deletes the grant during first dependency evaluation and consumes it exactly once", async () => {
    vi.resetModules();
    const nonce = "a".repeat(64);
    process.env.LINX_HOME_OWNERSHIP_NONCE = nonce;
    const grant = await import("./linxHomeOwnershipGrant");
    const providerEnvironmentSnapshot = { ...process.env };
    expect(process.env.LINX_HOME_OWNERSHIP_NONCE).toBeUndefined();
    expect(providerEnvironmentSnapshot.LINX_HOME_OWNERSHIP_NONCE).toBeUndefined();
    expect(grant.takeLinxHomeOwnershipGrant()).toBe(nonce);
    expect(grant.takeLinxHomeOwnershipGrant()).toBeUndefined();
  });
});
