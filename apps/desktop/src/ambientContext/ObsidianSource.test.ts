import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import type { AmbientContextPublication, AmbientContextSourcePolicy } from "@synara/contracts";
import { ObsidianSource } from "./ObsidianSource";
import { AmbientContextManager } from "./AmbientContextManager";

const policy: AmbientContextSourcePolicy = {
  enabled: true,
  allowedTypes: ["resource.identity", "selection.text"],
};
const sources: ObsidianSource[] = [];
afterEach(async () => {
  await Promise.all(sources.splice(0).map((source) => source.stop()));
});
function connect(endpoint: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const peer = new WebSocket(endpoint);
    peer.once("open", () => resolve(peer));
    peer.once("error", reject);
  });
}
function message(peer: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve) =>
    peer.once("message", (data) => resolve(JSON.parse(data.toString()))),
  );
}
const publication = (sequence: number): AmbientContextPublication => ({
  sequence,
  observations: [
    {
      schemaVersion: 1,
      id: "one",
      targetKey: "opaque",
      capturedAt: new Date().toISOString(),
      method: "editor",
      confidence: "exact",
      type: "selection.text",
      value: { text: "note" },
    },
  ],
});
async function pair(source: ObsidianSource): Promise<WebSocket> {
  const details = source.pairing();
  const peer = await connect(details.endpoint);
  const reply = message(peer);
  peer.send(JSON.stringify({ kind: "pair", token: details.token }));
  expect((await reply).kind).toBe("policy");
  return peer;
}

describe("Obsidian loopback bridge", () => {
  it("rejects unauthenticated input without publishing it", async () => {
    const source = new ObsidianSource();
    sources.push(source);
    const emitted: unknown[] = [];
    await source.start(policy, (value) => emitted.push(value));
    const peer = await connect(source.pairing().endpoint);
    const closed = new Promise((resolve) => peer.once("close", resolve));
    peer.send(JSON.stringify({ kind: "publish", publication: publication(0) }));
    await closed;
    expect(emitted).toEqual([]);
    expect(source.connected).toBe(false);
  });
  it("clears on disconnect and accepts fresh sequence zero on authenticated reconnect", async () => {
    const manager = new AmbientContextManager();
    const source = new ObsidianSource();
    sources.push(source);
    manager.registerSource(source);
    await manager.setPolicy("obsidian", policy);
    const peer = await pair(source);
    peer.send(JSON.stringify({ kind: "publish", publication: publication(10) }));
    await expect.poll(() => manager.resolve().length).toBe(1);
    const snapshot = manager.capture();
    peer.close();
    await expect.poll(() => manager.resolve().length).toBe(0);
    const second = await pair(source);
    second.send(JSON.stringify({ kind: "publish", publication: publication(0) }));
    await expect.poll(() => manager.resolve().length).toBe(1);
    expect(snapshot.items).toHaveLength(1);
    await manager.setPolicy("obsidian", { ...policy, enabled: false });
    expect(manager.resolve()).toEqual([]);
    expect(() => source.pairing()).toThrow();
  });
  it("keeps a second Vault from replacing a paired source and bounds search responses", async () => {
    const source = new ObsidianSource();
    sources.push(source);
    await source.start(policy, () => {});
    const peer = await pair(source);
    const second = await connect(source.pairing().endpoint);
    const closed = new Promise((resolve) => second.once("close", resolve));
    second.send(JSON.stringify({ kind: "pair", token: source.pairing().token }));
    await closed;
    expect(source.connected).toBe(true);
    const request = message(peer);
    const resources = source.searchResources("note");
    const frame = await request;
    peer.send(
      JSON.stringify({
        kind: "search-result",
        requestId: frame.requestId,
        resources: [
          { sourceId: "obsidian", targetKey: "ref", uri: "file:///note.md", title: "note.md" },
        ],
      }),
    );
    expect(await resources).toEqual([
      { sourceId: "obsidian", targetKey: "ref", uri: "file:///note.md", title: "note.md" },
    ]);
  });
});
