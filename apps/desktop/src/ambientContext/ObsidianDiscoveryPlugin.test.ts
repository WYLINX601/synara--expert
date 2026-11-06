import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import * as Fs from "node:fs/promises";
import * as Path from "node:path";
import * as Os from "node:os";
import { randomUUID } from "node:crypto";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
const require = createRequire(import.meta.url);
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => Fs.rm(root, { recursive: true, force: true })));
});
async function setup(realpath?: () => Promise<string>) {
  const root = await Fs.mkdtemp(Path.join(Os.tmpdir(), "synara-companion-discovery-"));
  roots.push(root);
  const module = { exports: undefined as unknown };
  const opened: string[] = [];
  class Socket {
    static OPEN = 1;
    readyState = 0;
    close = vi.fn(() => {
      this.readyState = 3;
    });
    constructor(endpoint: string) {
      opened.push(endpoint);
    }
  }
  runInNewContext(
    readFileSync(new URL("../../../obsidian-plugin/main.js", import.meta.url), "utf8"),
    {
      module,
      require: (id: string) =>
        id === "obsidian"
          ? { Plugin: vi.fn(), PluginSettingTab: vi.fn(), Notice: vi.fn() }
          : id === "./capture.cjs"
            ? require("../../../obsidian-plugin/capture.cjs")
            : id === "node:fs/promises" && realpath
              ? { ...Fs, realpath }
              : id === "node:os"
                ? { ...Os, homedir: () => root }
                : require(id),
      process: { platform: "linux", env: {} },
      WebSocket: Socket,
      clearTimeout,
      setTimeout,
    },
  );
  // Exercise the actual plain-JS plugin lifecycle without opening the user's Vault.
  const Plugin = module.exports as new () => any;
  const plugin = new Plugin();
  Object.assign(plugin, {
    discoveryRoot: root,
    vaultId: randomUUID(),
    requestId: randomUUID(),
    instanceId: "",
    clientPath: Path.join(root, "clients", "test.json"),
    autoConnect: true,
    discoveryRevision: 0,
    retryAt: 0,
    app: { vault: { getName: () => "Paper" } },
  });
  async function instance(id = randomUUID(), token = "a".repeat(64)) {
    const connection = {
      id: "b".repeat(64),
      sourceId: "b".repeat(64),
      vaultId: plugin.vaultId,
      label: "Paper",
      endpoint: "ws://127.0.0.1:12345",
    };
    const record = {
      schemaVersion: 1,
      instanceId: id,
      label: "Synara",
      updatedAt: new Date().toISOString(),
      connections: [connection],
    };
    await Fs.mkdir(Path.join(root, "instances"), { recursive: true });
    await Fs.writeFile(Path.join(root, "instances", `${id}.json`), JSON.stringify(record));
    async function grant() {
      await Fs.mkdir(Path.join(root, "grants", id), { recursive: true });
      await Fs.writeFile(
        Path.join(root, "grants", id, `${plugin.vaultId}.json`),
        JSON.stringify({
          schemaVersion: 1,
          instanceId: id,
          vaultId: plugin.vaultId,
          sourceId: connection.sourceId,
          token,
        }),
      );
    }
    return { id, grant, record };
  }
  return { root, plugin, opened, instance };
}
describe("Companion automatic discovery", () => {
  it("waits for approval then connects without saving credentials to preferences or discovery", async () => {
    const { root, plugin, instance, opened } = await setup();
    const server = await instance();
    await plugin.discover();
    expect(opened).toEqual([]);
    expect(plugin.instanceId).toBe(server.id);
    await server.grant();
    await plugin.discover();
    expect(opened).toEqual(["ws://127.0.0.1:12345"]);
    expect(await Fs.readFile(plugin.clientPath, "utf8")).not.toContain("a".repeat(64));
    expect(
      await Fs.readFile(Path.join(root, "vaults", `${plugin.vaultId}.json`), "utf8"),
    ).not.toContain("a".repeat(64));
    await plugin.discover();
    expect(opened).toHaveLength(1);
  });
  it("does not guess among multiple app instances and never fails over from the selected instance", async () => {
    const { root, plugin, instance, opened } = await setup();
    const a = await instance();
    const b = await instance();
    await a.grant();
    await b.grant();
    await plugin.discover();
    expect(opened).toEqual([]);
    await plugin.requestConnection(a.id);
    expect(opened).toHaveLength(1);
    await Fs.rm(Path.join(root, "instances", `${a.id}.json`));
    await plugin.discover();
    expect(plugin.instanceId).toBe(a.id);
    expect(plugin.socket).toBeNull();
    expect(opened).toHaveLength(1);
  });
  it("manual disconnect suppresses reconnection and removes the discovery request", async () => {
    const { root, plugin, instance, opened } = await setup();
    const server = await instance();
    await server.grant();
    await plugin.discover();
    await plugin.pauseConnection();
    await plugin.discover();
    expect(opened).toHaveLength(1);
    expect(plugin.token).toBe("");
    await expect(Fs.stat(Path.join(root, "vaults", `${plugin.vaultId}.json`))).rejects.toThrow();
  });
  it("revocation disconnects rather than reusing an in-memory token", async () => {
    const { root, plugin, instance } = await setup();
    const server = await instance();
    await server.grant();
    await plugin.discover();
    await Fs.rm(Path.join(root, "grants", server.id, `${plugin.vaultId}.json`));
    await plugin.discover();
    expect(plugin.socket).toBeNull();
    expect(plugin.token).toBe("");
  });
  it("rejects remote endpoints and stale instance discovery", async () => {
    const { root, plugin, instance, opened } = await setup();
    const server = await instance();
    await server.grant();
    server.record.connections[0]!.endpoint = "ws://example.com:12345";
    const locator = Path.join(root, "instances", `${server.id}.json`);
    await Fs.writeFile(locator, JSON.stringify(server.record));
    await plugin.discover();
    expect(opened).toEqual([]);
    server.record.connections[0]!.endpoint = "ws://127.0.0.1:12345";
    server.record.updatedAt = new Date(Date.now() - 30_000).toISOString();
    await Fs.writeFile(locator, JSON.stringify(server.record));
    await plugin.discover();
    expect(opened).toEqual([]);
  });
  it("unload joins an in-flight discovery before retiring the request", async () => {
    const { root, plugin, instance, opened } = await setup();
    const server = await instance();
    await server.grant();
    const work = plugin.discover();
    plugin.onunload();
    await work;
    await expect
      .poll(async () => {
        try {
          await Fs.stat(Path.join(root, "vaults", `${plugin.vaultId}.json`));
          return true;
        } catch {
          return false;
        }
      })
      .toBe(false);
    expect(opened).toEqual([]);
    expect(plugin.token).toBe("");
  });

  it("cannot reopen a socket when a pending manual connect resumes after unload", async () => {
    const { plugin, opened } = await setup();
    let release!: () => void;
    plugin.discoveryJob = new Promise<void>((resolve) => {
      release = resolve;
    });
    const manual = plugin.pauseConnection().then(() => {
      plugin.endpoint = "ws://127.0.0.1:12345";
      plugin.token = "a".repeat(64);
      plugin.connect();
    });
    plugin.onunload();
    release();
    await manual;
    expect(opened).toEqual([]);
  });

  it("does not register listeners or timers after unloading during async initialization", async () => {
    let release!: (value: string) => void;
    const pending = new Promise<string>((resolve) => {
      release = resolve;
    });
    const { plugin, root, opened } = await setup(() => pending);
    plugin.basePath = () => root;
    plugin.registerEvent = vi.fn();
    plugin.registerInterval = vi.fn();
    plugin.addSettingTab = vi.fn();
    const loading = plugin.onload();
    plugin.onunload();
    release(root);
    await loading;
    expect(plugin.registerEvent).not.toHaveBeenCalled();
    expect(plugin.registerInterval).not.toHaveBeenCalled();
    expect(plugin.addSettingTab).not.toHaveBeenCalled();
    expect(opened).toEqual([]);
  });
});
