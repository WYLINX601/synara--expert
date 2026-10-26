import {
  SkillManagementCredentialSummary,
  SkillManagementPairingResult,
  WsRpcError,
  WS_METHODS,
} from "@synara/contracts";
import { Effect } from "effect";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { ServerConfigShape } from "../../config";
import { createSkillManagementAuthStore } from "../../managementCli/managementAuth";
import { CurrentWsSessionRole } from "../../wsConnectionSessions";
import { makeSkillManagementRpcHandlers } from "./skillManagementRpc";

const temporaryDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function makeHarness(configOverrides: Partial<ServerConfigShape> = {}) {
  const baseDir = await mkdtemp(path.join(os.tmpdir(), "skill-management-rpc-"));
  temporaryDirs.push(baseDir);
  const config = {
    stateDir: path.join(baseDir, "state"),
    baseDir,
    host: "127.0.0.1",
    port: 3773,
    publicUrl: undefined,
    ...configOverrides,
  } as ServerConfigShape;
  const requireSkillOwner = Effect.gen(function* () {
    const role = yield* CurrentWsSessionRole;
    if (role !== "owner" || config.host !== "127.0.0.1" || config.publicUrl !== undefined)
      return yield* Effect.fail(new WsRpcError({ message: "Skill management owner required." }));
  });
  const handlers = makeSkillManagementRpcHandlers({
    config,
    instanceId: Effect.succeed("rpc-test-instance"),
    requireSkillOwner,
  });
  const callAsOwner = <A>(effect: Effect.Effect<A, unknown>) =>
    Effect.runPromise(effect.pipe(Effect.provideService(CurrentWsSessionRole, "owner")));
  const callAsClient = <A>(effect: Effect.Effect<A, unknown>) =>
    Effect.runPromise(effect.pipe(Effect.provideService(CurrentWsSessionRole, "client")));
  return { baseDir, config, handlers, callAsOwner, callAsClient };
}

describe("Skill management RPC authorization", () => {
  it("returns access only to a local owner and operates the shared pairing store", async () => {
    const harness = await makeHarness();
    const readAccess = harness.handlers[
      WS_METHODS.serverReadSkillManagementAccess
    ] as () => Effect.Effect<{
      canManage: boolean;
      instanceId?: string;
      flavor?:
        | "production"
        | "development"
        | "canary"
        | "cua"
        | "beta"
        | "workbench"
        | "workbench-preview";
      endpoint?: string;
      homeDir?: string;
    }>;
    expect(await harness.callAsClient(readAccess())).toEqual({ canManage: false });
    const access = await harness.callAsOwner(readAccess());
    expect(access).toMatchObject({
      canManage: true,
      instanceId: "rpc-test-instance",
      endpoint: "http://127.0.0.1:3773",
      homeDir: harness.baseDir,
    });

    const createPairing = harness.handlers[
      WS_METHODS.serverCreateSkillManagementPairing
    ] as () => Effect.Effect<SkillManagementPairingResult, WsRpcError>;
    const pairing = await harness.callAsOwner(createPairing());
    await createSkillManagementAuthStore(harness.config.stateDir, {
      instanceId: "rpc-test-instance",
      flavor: pairing.flavor,
    }).exchangePairing({
      code: pairing.code,
      expectedInstanceId: "rpc-test-instance",
      expectedFlavor: pairing.flavor,
    });

    const listCredentials = harness.handlers[
      WS_METHODS.serverListSkillManagementCredentials
    ] as () => Effect.Effect<ReadonlyArray<SkillManagementCredentialSummary>, WsRpcError>;
    const [credential] = await harness.callAsOwner(listCredentials());
    expect(credential?.credentialId).toEqual(expect.any(String));

    const revoke = harness.handlers[WS_METHODS.serverRevokeSkillManagementCredential] as (input: {
      credentialId: string;
    }) => Effect.Effect<{ revoked: boolean }>;
    await expect(
      harness.callAsOwner(revoke({ credentialId: credential!.credentialId })),
    ).resolves.toEqual({ revoked: true });
    await expect(harness.callAsOwner(listCredentials())).resolves.toMatchObject([
      { credentialId: credential!.credentialId, revokedAt: expect.any(String) },
    ]);
  });

  it("hides and refuses pairing access for remote or public instances", async () => {
    for (const overrides of [
      { host: "0.0.0.0" },
      { publicUrl: new URL("https://synara.example.test") },
    ]) {
      const harness = await makeHarness(overrides);
      const readAccess = harness.handlers[
        WS_METHODS.serverReadSkillManagementAccess
      ] as () => Effect.Effect<{ canManage: boolean }>;
      await expect(harness.callAsOwner(readAccess())).resolves.toEqual({ canManage: false });
      const createPairing = harness.handlers[
        WS_METHODS.serverCreateSkillManagementPairing
      ] as () => Effect.Effect<unknown>;
      await expect(harness.callAsOwner(createPairing())).rejects.toThrow(
        "Skill management owner required.",
      );
    }
  });
});
