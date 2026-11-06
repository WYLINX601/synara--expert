import * as Fs from "node:fs/promises";
import * as Os from "node:os";
import * as Path from "node:path";
import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import {
  readObsidianVaultDiscoveries,
  writeConnectionGrant,
  writeInstanceDiscovery,
  writeJson,
} from "./AmbientContextDiscovery";

const INSTANCE_ID = "00000000-0000-4000-8000-000000000001";
const VAULT_ID = "00000000-0000-4000-8000-000000000002";
const CONNECTION_ID = "a".repeat(64);

it("accepts only fresh, bounded, regular Vault discovery records", async () => {
  const root = await Fs.mkdtemp(Path.join(Os.tmpdir(), "synara-context-discovery-"));
  const directory = Path.join(root, "vaults");
  const currentId = randomUUID();
  const staleId = randomUUID();
  const badId = randomUUID();
  try {
    await writeJson(Path.join(directory, `${currentId}.json`), {
      schemaVersion: 1,
      vaultId: currentId,
      requestId: INSTANCE_ID,
      label: "Paper",
      updatedAt: new Date().toISOString(),
      ignoredCredential: "should not be returned",
    });
    await writeJson(Path.join(directory, `${staleId}.json`), {
      schemaVersion: 1,
      vaultId: staleId,
      requestId: INSTANCE_ID,
      label: "Old Vault",
      updatedAt: new Date(Date.now() - 30_000).toISOString(),
    });
    await writeJson(Path.join(directory, `${badId}.json`), {
      schemaVersion: 1,
      vaultId: badId,
      label: "Missing request identity",
      updatedAt: new Date().toISOString(),
    });
    await Fs.writeFile(Path.join(root, "outside.json"), "{}");
    await Fs.symlink(Path.join(root, "outside.json"), Path.join(directory, `${randomUUID()}.json`));

    expect(await readObsidianVaultDiscoveries(directory)).toEqual([
      {
        schemaVersion: 1,
        vaultId: currentId,
        requestId: INSTANCE_ID,
        label: "Paper",
        updatedAt: expect.any(String),
      },
    ]);
  } finally {
    await Fs.rm(root, { recursive: true, force: true });
  }
});

it("keeps reusable grants out of public instance discovery records", async () => {
  const root = await Fs.mkdtemp(Path.join(Os.tmpdir(), "synara-context-grant-"));
  const token = "f".repeat(64);
  try {
    const record = {
      schemaVersion: 1 as const,
      instanceId: INSTANCE_ID,
      label: "Synara Beta",
      updatedAt: new Date().toISOString(),
      connections: [
        {
          id: CONNECTION_ID,
          sourceId: CONNECTION_ID,
          vaultId: VAULT_ID,
          label: "Paper",
          endpoint: "ws://127.0.0.1:12345",
        },
      ],
    };
    await writeInstanceDiscovery(root, record);
    await writeConnectionGrant(root, INSTANCE_ID, VAULT_ID, CONNECTION_ID, token);
    const discovery = await Fs.readFile(
      Path.join(root, "instances", `${INSTANCE_ID}.json`),
      "utf8",
    );
    const grant = await Fs.readFile(
      Path.join(root, "grants", INSTANCE_ID, `${VAULT_ID}.json`),
      "utf8",
    );
    expect(discovery).not.toContain(token);
    expect(JSON.parse(grant)).toMatchObject({ instanceId: INSTANCE_ID, vaultId: VAULT_ID, token });
    expect(
      (await Fs.stat(Path.join(root, "grants", INSTANCE_ID, `${VAULT_ID}.json`))).mode & 0o777,
    ).toBe(0o600);
  } finally {
    await Fs.rm(root, { recursive: true, force: true });
  }
});
