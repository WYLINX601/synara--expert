import * as Fs from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import * as Path from "node:path";
import { expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import type { AmbientContextObservation } from "@synara/contracts";
import { DesktopAmbientContext } from "./DesktopAmbientContext";
import { writeJson } from "./AmbientContextDiscovery";

const VAULT_A = "a1000000-0000-4000-8000-000000000001";
const VAULT_B = "b2000000-0000-4000-8000-000000000002";
const REQUEST_A = "a1000000-0000-4000-8000-000000000010";
const REQUEST_B = "b2000000-0000-4000-8000-000000000020";
const timestamp = () => new Date().toISOString();

function environment() {
  const root = Path.join(tmpdir(), `synara-ambient-${randomUUID()}`);
  const userData = Path.join(root, "synara-dev");
  const sharedData = Path.join(root, "SynaraContext");
  return {
    root,
    userData,
    sharedData,
    settingsPath: Path.join(userData, "settings.json"),
    grantsPath: Path.join(userData, "ambient-context-connections.json"),
  };
}

async function announceVault(
  directory: string,
  vaultId: string,
  requestId: string,
  label = "Paper",
): Promise<void> {
  await writeJson(Path.join(directory, "vaults", `${vaultId}.json`), {
    schemaVersion: 1,
    vaultId,
    requestId,
    label,
    updatedAt: timestamp(),
  });
}

async function openPeer(endpoint: string, token: string): Promise<WebSocket> {
  const peer = await new Promise<WebSocket>((resolve, reject) => {
    const socket = new WebSocket(endpoint, { headers: { Origin: "app://obsidian.md" } });
    socket.once("open", () => resolve(socket));
    socket.once("error", reject);
  });
  const policyReceived = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Timed out waiting for context policy.")),
      2_000,
    );
    peer.once("message", (data) => {
      clearTimeout(timer);
      try {
        const message = JSON.parse(data.toString()) as Record<string, unknown>;
        if (message.kind !== "policy") throw new Error("Invalid policy response.");
        resolve();
      } catch (error) {
        reject(error);
      }
    });
  });
  peer.send(JSON.stringify({ kind: "pair", token }));
  await policyReceived;
  return peer;
}

function observations(text: string): AmbientContextObservation[] {
  const capturedAt = timestamp();
  return [
    {
      schemaVersion: 1,
      id: `resource-${text}`,
      targetKey: "shared-resource-key",
      capturedAt,
      method: "obsidian-editor-api",
      confidence: "exact",
      type: "resource.identity",
      value: { uri: "file:///same/path/note.md", title: "note.md", kind: "file" },
    },
    {
      schemaVersion: 1,
      id: `selection-${text}`,
      targetKey: "shared-resource-key",
      capturedAt,
      method: "obsidian-editor-api",
      confidence: "exact",
      type: "selection.text",
      value: { text },
    },
  ];
}

async function publish(
  peer: WebSocket,
  observations: readonly AmbientContextObservation[],
): Promise<void> {
  peer.send(JSON.stringify({ kind: "publish", publication: { sequence: 0, observations } }));
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((finish) => {
    resolve = finish;
  });
  return { promise, resolve };
}

it("does not deadlock if the discovery poll fires while preferences are restoring", async () => {
  const paths = environment();
  const barrier = deferred<void>();
  await announceVault(paths.sharedData, VAULT_A, REQUEST_A);
  const context = new DesktopAmbientContext(paths.settingsPath, () => {}, {
    sharedDataDirectory: paths.sharedData,
    initializationBarrier: barrier.promise,
  });
  try {
    await new Promise((resolve) => setTimeout(resolve, 1_050));
    barrier.resolve();
    await expect
      .poll(() => context.getState().then((state) => state.pendingConnections?.length), {
        timeout: 3_000,
      })
      .toBe(1);
  } finally {
    barrier.resolve();
    await context.stop();
    await Fs.rm(paths.root, { recursive: true, force: true });
  }
});

it("keeps a stable device grant per app profile and requires explicit source IDs to capture", async () => {
  const paths = environment();
  await Fs.mkdir(paths.userData, { recursive: true });
  await announceVault(paths.sharedData, VAULT_A, REQUEST_A);
  const first = new DesktopAmbientContext(paths.settingsPath, () => {}, {
    sharedDataDirectory: paths.sharedData,
    instanceLabel: "Synara (Dev)",
  });
  let second: DesktopAmbientContext | undefined;
  try {
    const policy = {
      enabled: true,
      allowedTypes: ["resource.identity", "selection.text"] as const,
    };
    await first.configure("obsidian", policy);
    const pending = (await first.getState()).pendingConnections!;
    expect(pending).toHaveLength(1);
    const id = pending[0]!.id;
    await first.approveConnection(id);
    const initialGrant = await first.pairing(id);
    expect(JSON.parse(await Fs.readFile(paths.settingsPath, "utf8"))).toEqual(policy);
    expect(JSON.parse(await Fs.readFile(paths.grantsPath, "utf8"))[0].token).toBe(
      initialGrant.token,
    );
    const instanceId = JSON.parse(
      await Fs.readFile(Path.join(paths.userData, "ambient-context-instance.json"), "utf8"),
    ).instanceId as string;
    const pluginGrantPath = Path.join(paths.sharedData, "grants", instanceId, `${VAULT_A}.json`);
    expect(JSON.parse(await Fs.readFile(pluginGrantPath, "utf8"))).toEqual({
      schemaVersion: 1,
      instanceId,
      vaultId: VAULT_A,
      sourceId: id,
      token: initialGrant.token,
    });
    expect((await first.getState()).sources[0]?.connected).toBe(false);
    expect((await first.capture()).items).toEqual([]);
    await expect(first.capture([id])).rejects.toThrow("unavailable");

    await first.stop();
    second = new DesktopAmbientContext(paths.settingsPath, () => {}, {
      sharedDataDirectory: paths.sharedData,
      instanceLabel: "Synara (Dev)",
    });
    await expect
      .poll(() => second!.pairing(id).then((value) => value.token))
      .toBe(initialGrant.token);
    expect((await second.getState()).connections?.[0]).toMatchObject({
      id,
      sourceId: id,
      label: "Paper",
      connected: false,
    });

    await second.revokeConnection(id);
    expect(JSON.parse(await Fs.readFile(paths.grantsPath, "utf8"))).toEqual([]);
    await expect(Fs.access(pluginGrantPath)).rejects.toThrow();
  } finally {
    await first.stop();
    await second?.stop();
    await Fs.rm(paths.root, { recursive: true, force: true });
  }
});

it("isolates two same-named Vaults before cross-source URI correlation", async () => {
  const paths = environment();
  await announceVault(paths.sharedData, VAULT_A, REQUEST_A, "Research");
  await announceVault(paths.sharedData, VAULT_B, REQUEST_B, "Research");
  const context = new DesktopAmbientContext(paths.settingsPath, () => {}, {
    sharedDataDirectory: paths.sharedData,
  });
  const peers: WebSocket[] = [];
  try {
    await context.configure("obsidian", {
      enabled: true,
      allowedTypes: ["resource.identity", "selection.text"],
    });
    const pending = (await context.getState()).pendingConnections!;
    expect(pending).toHaveLength(2);
    expect(pending[0]?.label).toBe(pending[1]?.label);
    expect(pending[0]?.id).not.toBe(pending[1]?.id);
    const idA = pending.toSorted((left, right) => left.id.localeCompare(right.id))[0]!.id;
    const idB = pending.find((item) => item.id !== idA)!.id;
    await context.approveConnection(idA);
    await context.approveConnection(idB);
    for (const id of [idA, idB]) {
      const details = await context.pairing(id);
      peers.push(await openPeer(details.endpoint, details.token));
    }
    await publish(peers[0]!, observations("Paper only"));
    await publish(peers[1]!, observations("Work only"));
    await expect
      .poll(() => context.getState().then((state) => state.items.length))
      .toBeGreaterThanOrEqual(3);

    const selected = await context.capture([idA]);
    expect(
      selected.items.flatMap((item) => item.provenance.map((source) => source.sourceId)),
    ).toEqual([idA, idA]);
    const combined = await context.capture([idA, idB]);
    const resource = combined.items.find((item) => item.observation.type === "resource.identity");
    expect(resource?.provenance.map((source) => source.sourceId)).toEqual([idA, idB]);
    expect((await context.capture()).items).toEqual([]);
  } finally {
    peers.forEach((peer) => peer.close());
    await context.stop();
    await Fs.rm(paths.root, { recursive: true, force: true });
  }
});

it("includes resource bodies only for explicitly opted-in bound source IDs", async () => {
  const paths = environment();
  await announceVault(paths.sharedData, VAULT_A, REQUEST_A);
  const context = new DesktopAmbientContext(paths.settingsPath, () => {}, {
    sharedDataDirectory: paths.sharedData,
  });
  let peer: WebSocket | undefined;
  try {
    await context.configure("obsidian", {
      enabled: true,
      allowedTypes: ["resource.identity", "resource.content"],
    });
    const id = (await context.getState()).pendingConnections![0]!.id;
    await context.approveConnection(id);
    const details = await context.pairing(id);
    peer = await openPeer(details.endpoint, details.token);
    const capturedAt = timestamp();
    await publish(peer, [
      {
        schemaVersion: 1,
        id: "resource-id",
        targetKey: "target",
        capturedAt,
        method: "obsidian-editor-api",
        confidence: "exact",
        type: "resource.identity",
        value: { uri: "file:///vault/note.md", title: "note.md", kind: "file" },
      },
      {
        schemaVersion: 1,
        id: "body-id",
        targetKey: "target",
        capturedAt,
        method: "obsidian-editor-api",
        confidence: "exact",
        type: "resource.content",
        value: { text: "PRIVATE BODY", truncated: false },
      },
    ]);
    await expect.poll(() => context.getState().then((state) => state.items.length)).toBe(2);

    const defaultCapture = await context.capture([id]);
    expect(defaultCapture.items.map((item) => item.observation.type)).toEqual([
      "resource.identity",
    ]);
    const explicitCapture = await context.capture([id], { includeFullTextSourceIds: [id] });
    expect(explicitCapture.items.map((item) => item.observation.type)).toEqual([
      "resource.identity",
      "resource.content",
    ]);
    await expect(context.capture([], { includeFullTextSourceIds: [id] })).rejects.toThrow(
      "Invalid full-text context selection",
    );
    await context.configure("obsidian", {
      enabled: true,
      allowedTypes: ["resource.identity"],
    });
    await expect(context.capture([id], { includeFullTextSourceIds: [id] })).rejects.toThrow(
      "unavailable",
    );
  } finally {
    peer?.close();
    await context.stop();
    await Fs.rm(paths.root, { recursive: true, force: true });
  }
});

it("dismisses a pending request until the plugin starts a new request ID", async () => {
  const paths = environment();
  await announceVault(paths.sharedData, VAULT_A, REQUEST_A);
  const context = new DesktopAmbientContext(paths.settingsPath, () => {}, {
    sharedDataDirectory: paths.sharedData,
  });
  try {
    const id = (await context.getState()).pendingConnections![0]!.id;
    await context.revokeConnection(id);
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    expect((await context.getState()).pendingConnections).toEqual([]);
    await announceVault(paths.sharedData, VAULT_A, "a1000000-0000-4000-8000-000000000011");
    await expect
      .poll(() => context.getState().then((state) => state.pendingConnections?.length))
      .toBe(1);
  } finally {
    await context.stop();
    await Fs.rm(paths.root, { recursive: true, force: true });
  }
});

it("keeps revocation retryable when grant persistence fails after live data is cleared", async () => {
  const paths = environment();
  await announceVault(paths.sharedData, VAULT_A, REQUEST_A);
  const context = new DesktopAmbientContext(paths.settingsPath, () => {}, {
    sharedDataDirectory: paths.sharedData,
  });
  try {
    await context.configure("obsidian", { enabled: true, allowedTypes: ["selection.text"] });
    const id = (await context.getState()).pendingConnections![0]!.id;
    await context.approveConnection(id);
    const details = await context.pairing(id);
    const peer = await openPeer(details.endpoint, details.token);
    await publish(peer, observations("selected"));
    await expect
      .poll(() => context.getState().then((state) => state.items.length))
      .toBeGreaterThan(0);

    await Fs.rm(paths.grantsPath, { force: true });
    await Fs.mkdir(paths.grantsPath, { recursive: true });
    await expect(context.revokeConnection(id)).rejects.toThrow();
    expect((await context.getState()).connections?.find((item) => item.id === id)).toMatchObject({
      connected: false,
      error: expect.stringContaining("Revocation is incomplete"),
    });
    expect((await context.getState()).items).toEqual([]);

    await Fs.rm(paths.grantsPath, { recursive: true, force: true });
    await context.revokeConnection(id);
    expect((await context.getState()).connections?.some((item) => item.id === id)).toBe(false);
    expect(JSON.parse(await Fs.readFile(paths.grantsPath, "utf8"))).toEqual([]);
    peer.close();
  } finally {
    await context.stop();
    await Fs.rm(paths.root, { recursive: true, force: true });
  }
});

it("rolls back a failed first approval and permits a clean retry", async () => {
  const paths = environment();
  await announceVault(paths.sharedData, VAULT_A, REQUEST_A);
  const context = new DesktopAmbientContext(paths.settingsPath, () => {}, {
    sharedDataDirectory: paths.sharedData,
  });
  try {
    await context.configure("obsidian", { enabled: true, allowedTypes: ["selection.text"] });
    const id = (await context.getState()).pendingConnections![0]!.id;
    await Fs.mkdir(paths.grantsPath, { recursive: true });
    await expect(context.approveConnection(id)).rejects.toThrow();
    expect((await context.getState()).pendingConnections?.map((item) => item.id)).toEqual([id]);
    expect((await context.getState()).connections?.find((item) => item.id === id)).toBeUndefined();

    await Fs.rm(paths.grantsPath, { recursive: true, force: true });
    await context.approveConnection(id);
    expect((await context.getState()).pendingConnections).toEqual([]);
    await expect(context.pairing(id)).resolves.toMatchObject({
      token: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
  } finally {
    await context.stop();
    await Fs.rm(paths.root, { recursive: true, force: true });
  }
});

it("stops restored sources and clears runtime discovery when grant publication fails", async () => {
  const paths = environment();
  const instanceId = "00000000-0000-4000-8000-000000000001";
  const sourceId = createHash("sha256").update(`${instanceId}\0${VAULT_A}`).digest("hex");
  const token = "c".repeat(64);
  await Fs.mkdir(paths.userData, { recursive: true });
  await Fs.writeFile(
    Path.join(paths.userData, "ambient-context-instance.json"),
    JSON.stringify({ schemaVersion: 1, instanceId }),
  );
  await Fs.writeFile(
    paths.settingsPath,
    JSON.stringify({ enabled: true, allowedTypes: ["selection.text"] }),
  );
  await Fs.writeFile(
    paths.grantsPath,
    JSON.stringify([
      {
        id: sourceId,
        sourceId,
        vaultId: VAULT_A,
        label: "Paper",
        token,
        approvedAt: timestamp(),
      },
    ]),
  );
  await Fs.mkdir(paths.sharedData, { recursive: true });
  await Fs.writeFile(Path.join(paths.sharedData, "grants"), "not a directory");

  const context = new DesktopAmbientContext(paths.settingsPath, () => {}, {
    sharedDataDirectory: paths.sharedData,
  });
  const managerStop = vi.spyOn(context.manager, "stop");
  try {
    await expect
      .poll(() => {
        const source = context.connections.get(sourceId)?.source;
        try {
          return source?.pairing().endpoint ?? null;
        } catch {
          return null;
        }
      })
      .toMatch(/^ws:\/\/127\.0\.0\.1:[0-9]+$/);
    const source = context.connections.get(sourceId)!.source;
    await expect(context.getState()).rejects.toThrow();
    await expect(context.stop()).rejects.toThrow();
    expect(managerStop).toHaveBeenCalledTimes(1);
    expect(() => source.pairing()).toThrow();
  } finally {
    await context.stop().catch(() => undefined);
    await Fs.rm(paths.root, { recursive: true, force: true });
  }
});

it("discards a resource search whose policy was revoked before it completed", async () => {
  const paths = environment();
  await announceVault(paths.sharedData, VAULT_A, REQUEST_A);
  const context = new DesktopAmbientContext(paths.settingsPath, () => {}, {
    sharedDataDirectory: paths.sharedData,
  });
  try {
    await context.configure("obsidian", { enabled: true, allowedTypes: ["resource.identity"] });
    const id = (await context.getState()).pendingConnections![0]!.id;
    await context.approveConnection(id);
    const search = vi
      .spyOn(context.connections.get(id)!.source, "searchResources")
      .mockImplementation(() => new Promise((resolve) => setTimeout(() => resolve([]), 30)));
    const pending = context.searchResources("note");
    await expect.poll(() => search.mock.calls.length).toBe(1);
    const revoke = context.configure("obsidian", { enabled: false, allowedTypes: [] });
    expect(await pending).toEqual([]);
    await revoke;
    expect(await context.searchResources("note")).toEqual([]);
    expect(search).toHaveBeenCalledTimes(1);
  } finally {
    await context.stop();
    await Fs.rm(paths.root, { recursive: true, force: true });
  }
});
