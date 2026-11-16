import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import * as Fs from "node:fs/promises";
import * as Path from "node:path";
import * as Os from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DesktopAmbientContext } from "./DesktopAmbientContext";
const require = createRequire(import.meta.url);
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => Fs.rm(root, { recursive: true, force: true })));
});
async function setup(realpath?: () => Promise<string>) {
  const container = await Fs.realpath(
    await Fs.mkdtemp(Path.join(Os.tmpdir(), "synara-companion-discovery-")),
  );
  roots.push(container);
  const root = Path.join(container, "SynaraContext");
  await Fs.mkdir(root, { mode: 0o700 });
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
                ? { ...Os, homedir: () => container }
                : require(id),
      process: { platform: "linux", env: {} },
      WebSocket: Socket,
      clearTimeout,
      setTimeout,
    },
  );
  // Exercise the actual plain-JS plugin lifecycle only against private fixtures.
  const Plugin = module.exports as new () => any;
  const plugin = new Plugin();
  const descriptor = { key: "synara", directory: root, profiles: {} as Record<string, string> };
  Object.assign(plugin, {
    discoveryRoots: [descriptor],
    discoveryRoot: null,
    discoveryRootKey: "",
    selectionKey: "",
    vaultId: randomUUID(),
    requestId: randomUUID(),
    instanceId: "",
    clientHash: "test",
    clientPath: Path.join(root, "clients", "test.json"),
    autoConnect: true,
    discoveryRevision: 0,
    retryAt: 0,
    loadData: vi.fn(async () => ({})),
    saveData: vi.fn(async () => {}),
    app: { vault: { getName: () => "Paper" } },
  });
  await Fs.mkdir(Path.dirname(plugin.clientPath), { recursive: true, mode: 0o700 });
  await Fs.writeFile(
    plugin.clientPath,
    JSON.stringify({ vaultId: plugin.vaultId, instanceId: "" }),
    { mode: 0o600 },
  );
  let sequence = 0;
  async function instance(
    id = randomUUID(),
    token = "a".repeat(64),
    selectedRoot = descriptor,
    vaultId = plugin.vaultId,
  ) {
    const profile = Path.join(container, `${selectedRoot.key}-profile-${sequence++}`);
    const applicationId =
      selectedRoot.key === "linx"
        ? "com.wylinx.linx"
        : selectedRoot.key === "linx-preview"
          ? "com.wylinx.linx.preview"
          : `com.emanueledipietro.synara.fixture${sequence}`;
    selectedRoot.profiles[applicationId] = profile;
    await Fs.mkdir(profile, { mode: 0o700 });
    await Fs.writeFile(
      Path.join(profile, "ambient-context-instance.json"),
      JSON.stringify({ schemaVersion: 1, instanceId: id }),
      { mode: 0o600 },
    );
    const sourceId = createHash("sha256").update(`${id}\0${vaultId}`).digest("hex");
    const connection = {
      id: sourceId,
      sourceId,
      vaultId,
      label: "Paper",
      endpoint: "ws://127.0.0.1:12345",
    };
    const record = {
      schemaVersion: 2,
      applicationId,
      profilePath: profile,
      instanceId: id,
      label: selectedRoot.key === "synara" ? "Synara" : selectedRoot.key,
      updatedAt: new Date().toISOString(),
      connections: [connection],
    };
    await Fs.mkdir(Path.join(selectedRoot.directory, "instances"), {
      recursive: true,
      mode: 0o700,
    });
    const locator = Path.join(selectedRoot.directory, "instances", `${id}.json`);
    await Fs.writeFile(locator, JSON.stringify(record), { mode: 0o600 });
    async function grant() {
      await Fs.mkdir(Path.join(selectedRoot.directory, "grants", id), {
        recursive: true,
        mode: 0o700,
      });
      await Fs.writeFile(
        Path.join(selectedRoot.directory, "grants", id, `${vaultId}.json`),
        JSON.stringify({
          schemaVersion: 1,
          instanceId: id,
          vaultId,
          sourceId: connection.sourceId,
          token,
        }),
        { mode: 0o600 },
      );
    }
    return { id, grant, record, locator, profile, selectionKey: `${selectedRoot.key}:${id}` };
  }
  async function addRoot(key: string) {
    const directory = Path.join(container, key, "ambient-context-discovery");
    await Fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const added = { key, directory, profiles: {} as Record<string, string> };
    plugin.discoveryRoots.push(added);
    const vaultId = randomUUID();
    await Fs.mkdir(Path.join(directory, "clients"), { mode: 0o700 });
    await Fs.writeFile(
      Path.join(directory, "clients", "test.json"),
      JSON.stringify({ vaultId, instanceId: "" }),
      { mode: 0o600 },
    );
    return { ...added, vaultId };
  }
  return { root, container, plugin, opened, instance, addRoot };
}
describe("Companion automatic discovery", () => {
  it("keeps Linx and Preview roots, grants and identical instance IDs separate until explicit selection", async () => {
    const { root, plugin, opened, instance, addRoot } = await setup();
    const primaryRoot = await addRoot("linx");
    const previewRoot = await addRoot("linx-preview");
    const sharedId = randomUUID();
    const primary = await instance(sharedId, "a".repeat(64), primaryRoot, primaryRoot.vaultId);
    const preview = await instance(sharedId, "b".repeat(64), previewRoot, previewRoot.vaultId);
    preview.record.connections[0]!.endpoint = "ws://127.0.0.1:23456";
    await Fs.writeFile(preview.locator, JSON.stringify(preview.record));
    await primary.grant();
    await preview.grant();
    await plugin.discover();
    expect(opened).toEqual([]);
    expect(plugin.instances).toHaveLength(2);
    expect(plugin.selectionKey).toBe("");
    await expect(Fs.stat(Path.join(primaryRoot.directory, "vaults"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await plugin.requestConnection(primary.selectionKey);
    expect(opened).toEqual(["ws://127.0.0.1:12345"]);
    expect(plugin.discoveryRootKey).toBe("linx");
    expect(plugin.token).toBe("a".repeat(64));
    expect(plugin.saveData).toHaveBeenLastCalledWith({
      discoveryRootKey: "linx",
      instanceId: sharedId,
    });
    expect(JSON.stringify(plugin.saveData.mock.calls)).not.toContain("a".repeat(64));
    expect(
      await Fs.readFile(Path.join(primaryRoot.directory, "clients", "test.json"), "utf8"),
    ).not.toContain("a".repeat(64));
    await expect(
      Fs.stat(Path.join(root, "vaults", `${primaryRoot.vaultId}.json`)),
    ).rejects.toMatchObject({ code: "ENOENT" });
    // Even a matching filename in the other root is not a credential fallback.
    const grantPath = Path.join(
      primaryRoot.directory,
      "grants",
      sharedId,
      `${primaryRoot.vaultId}.json`,
    );
    const grant = await Fs.readFile(grantPath);
    await Fs.writeFile(
      Path.join(previewRoot.directory, "grants", sharedId, `${primaryRoot.vaultId}.json`),
      grant,
    );
    await Fs.rm(grantPath);
    await plugin.discover();
    expect(plugin.token).toBe("");
    expect(plugin.socket).toBeNull();
    expect(opened).toHaveLength(1);
    await Fs.rm(primary.locator);
    await plugin.discover();
    expect(plugin.selectionKey).toBe(primary.selectionKey);
    expect(plugin.discoveryRootKey).toBe("linx");
    expect(opened).toHaveLength(1);
  });

  it("does not create a Linx profile or discovery directory just because no host is installed", async () => {
    const { container, plugin, opened } = await setup();
    const profile = Path.join(container, "not-created");
    plugin.discoveryRoots = [
      {
        key: "linx",
        directory: Path.join(profile, "ambient-context-discovery"),
        profiles: { "com.wylinx.linx": profile },
      },
    ];
    await plugin.discover();
    expect(opened).toEqual([]);
    await expect(Fs.stat(profile)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["application", "profile", "identity", "source", "endpoint", "old-schema"] as const)(
    "rejects a mismatched %s record before pairing",
    async (changed) => {
      const { plugin, instance, addRoot, opened } = await setup();
      const owned = await addRoot("linx");
      const server = await instance(randomUUID(), "a".repeat(64), owned, owned.vaultId);
      await server.grant();
      if (changed === "application") server.record.applicationId = "com.emanueledipietro.synara";
      if (changed === "profile") server.record.profilePath += "-other";
      if (changed === "identity")
        await Fs.writeFile(
          Path.join(server.profile, "ambient-context-instance.json"),
          JSON.stringify({ schemaVersion: 1, instanceId: randomUUID() }),
        );
      if (changed === "source") server.record.connections[0]!.sourceId = "e".repeat(64);
      if (changed === "endpoint") server.record.connections[0]!.endpoint = "ws://127.0.0.1:99999";
      if (changed === "old-schema") server.record.schemaVersion = 1;
      await Fs.writeFile(server.locator, JSON.stringify(server.record));
      await plugin.discover();
      expect(plugin.instances).toHaveLength(0);
      expect(opened).toEqual([]);
    },
  );

  it("consumes the native isolated Linx discovery/grant producer without a shared-root alias", async () => {
    const { plugin, addRoot, opened, container } = await setup();
    const owned = await addRoot("linx");
    const profile = Path.join(container, "linx");
    const applicationId = "com.wylinx.linx";
    owned.profiles[applicationId] = profile;
    const context = new DesktopAmbientContext(
      Path.join(profile, "ambient-context-settings.json"),
      () => {},
      {
        sharedDataDirectory: owned.directory,
        instanceLabel: "Linx",
        applicationId,
      },
    );
    try {
      await context.configure("obsidian", { enabled: true, allowedTypes: ["resource.identity"] });
      await plugin.discover();
      await expect
        .poll(() => context.getState().then((state) => state.pendingConnections?.length), {
          timeout: 3_000,
        })
        .toBe(1);
      const pending = (await context.getState()).pendingConnections![0]!;
      await context.approveConnection(pending.id);
      await plugin.discover();
      expect(plugin.discoveryRootKey).toBe("linx");
      expect(plugin.token).toMatch(/^[a-f0-9]{64}$/);
      expect(opened).toHaveLength(1);
      expect(opened[0]).toMatch(/^ws:\/\/127\.0\.0\.1:[0-9]+$/);
      const record = JSON.parse(
        await Fs.readFile(
          Path.join(owned.directory, "instances", `${plugin.instanceId}.json`),
          "utf8",
        ),
      );
      expect(record).toMatchObject({ schemaVersion: 2, applicationId, profilePath: profile });
      plugin.onunload();
    } finally {
      await context.stop();
    }
  });

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
    await plugin.requestConnection(a.selectionKey);
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
