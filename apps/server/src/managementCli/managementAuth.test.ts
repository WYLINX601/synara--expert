import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createSkillManagementAuthStore,
  SkillManagementAuthStoreError,
  SKILL_MANAGEMENT_PAIRING_TTL_MS,
} from "./managementAuth";

const temporaryDirectories: string[] = [];

function makeStore(identity = { instanceId: "environment-test", flavor: "development" as const }) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "synara-skill-management-auth-"));
  temporaryDirectories.push(stateDir);
  return { stateDir, store: createSkillManagementAuthStore(stateDir, identity) };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("Skill management auth store", () => {
  it("exchanges a single-use, instance-bound code for a narrow credential without persisting secrets", async () => {
    const { stateDir, store } = makeStore();
    const now = new Date("2026-10-26T00:00:00.000Z");
    const pairing = await store.createPairing(now);

    const credential = await store.exchangePairing({
      code: pairing.code,
      expectedInstanceId: pairing.instanceId,
      expectedFlavor: pairing.flavor,
      now,
    });

    expect(credential.capabilities).toEqual(["skill.manage", "expert.skillBindings.manage"]);
    expect(await store.authorize(credential.credential, now)).toMatchObject({
      credentialId: credential.credentialId,
      instanceId: "environment-test",
      flavor: "development",
    });

    const persisted = fs.readFileSync(store.readonlyPath, "utf8");
    expect(persisted).not.toContain(pairing.code);
    expect(persisted).not.toContain(credential.credential);
    if (process.platform !== "win32") {
      expect(fs.statSync(store.readonlyPath).mode & 0o077).toBe(0);
      expect(fs.statSync(stateDir).mode & 0o077).toBe(0);
    }

    await expect(
      store.exchangePairing({
        code: pairing.code,
        expectedInstanceId: pairing.instanceId,
        expectedFlavor: pairing.flavor,
        now,
      }),
    ).rejects.toBeInstanceOf(SkillManagementAuthStoreError);
  });

  it("rejects expired and mismatched pairings, then enforces immediate revocation", async () => {
    const { store } = makeStore();
    const now = new Date("2026-10-26T00:00:00.000Z");
    const expired = await store.createPairing(
      new Date(now.getTime() - SKILL_MANAGEMENT_PAIRING_TTL_MS - 1),
    );
    await expect(
      store.exchangePairing({
        code: expired.code,
        expectedInstanceId: expired.instanceId,
        expectedFlavor: expired.flavor,
        now,
      }),
    ).rejects.toMatchObject({ code: "invalid_pairing" });

    const pairing = await store.createPairing(now);
    const replacementPairing = await store.createPairing(now);
    await expect(
      store.exchangePairing({
        code: pairing.code,
        expectedInstanceId: pairing.instanceId,
        expectedFlavor: pairing.flavor,
        now,
      }),
    ).rejects.toMatchObject({ code: "invalid_pairing" });
    await expect(
      store.exchangePairing({
        code: replacementPairing.code,
        expectedInstanceId: "another-environment",
        expectedFlavor: replacementPairing.flavor,
        now,
      }),
    ).rejects.toMatchObject({ code: "instance_mismatch" });
    await expect(
      store.exchangePairing({
        code: replacementPairing.code,
        expectedInstanceId: replacementPairing.instanceId,
        expectedFlavor: "beta",
        now,
      }),
    ).rejects.toMatchObject({ code: "flavor_mismatch" });

    const credential = await store.exchangePairing({
      code: replacementPairing.code,
      expectedInstanceId: replacementPairing.instanceId,
      expectedFlavor: replacementPairing.flavor,
      now,
    });
    expect(await store.revokeCredential(credential.credentialId, now)).toBe(true);
    await expect(store.authorize(credential.credential, now)).rejects.toMatchObject({
      code: "management_revoked",
    });
  });

  it("allows exactly one concurrent exchange of the same code", async () => {
    const { store } = makeStore();
    const now = new Date("2026-10-26T00:00:00.000Z");
    const pairing = await store.createPairing(now);
    const attempts = await Promise.allSettled([
      store.exchangePairing({
        code: pairing.code,
        expectedInstanceId: pairing.instanceId,
        expectedFlavor: pairing.flavor,
        now,
      }),
      store.exchangePairing({
        code: pairing.code,
        expectedInstanceId: pairing.instanceId,
        expectedFlavor: pairing.flavor,
        now,
      }),
    ]);
    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter((attempt) => attempt.status === "rejected")).toHaveLength(1);
  });
});
