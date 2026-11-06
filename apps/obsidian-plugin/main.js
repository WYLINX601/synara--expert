/* Obsidian loads main.js as CommonJS. No external service or Agent runtime. */
const {
  Plugin,
  PluginSettingTab,
  Setting,
  MarkdownView,
  FileSystemAdapter,
  Notice,
} = require("obsidian");
const { randomUUID, createHash } = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const ENDPOINT = /^ws:\/\/127\.0\.0\.1:[0-9]{1,5}$/;
async function readLocalJson(file) {
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65_536) return null;
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return null;
  }
}
async function writeLocalJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(value), { mode: 0o600, flag: "wx" });
  await fs.rename(temporary, file);
}
function appDataDirectory() {
  return process.platform === "darwin"
    ? path.join(os.homedir(), "Library", "Application Support")
    : process.platform === "win32"
      ? process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming")
      : process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
}
const { capture, search } = require("./capture.cjs");

module.exports = class SynaraContextPlugin extends Plugin {
  async onload() {
    // Credentials remain outside the Vault; only the selected local instance is remembered.
    this.endpoint = "";
    this.token = "";
    this.policy = { enabled: false, allowedTypes: [] };
    this.windowId = randomUUID();
    this.sequence = 0;
    this.socket = null;
    this.timer = null;
    this.instances = [];
    this.status = "正在查找工作台";
    this.autoConnect = true;
    this.unloaded = false;
    this.retryAt = 0;
    this.retryDelay = 1_000;
    this.requestId = randomUUID();
    this.discoveryRevision = 0;
    this.files = null;
    this.discoveryRoot = path.join(appDataDirectory(), "SynaraContext");
    const basePath = this.basePath();
    if (basePath) {
      const canonical = await fs.realpath(basePath);
      this.clientPath = path.join(
        this.discoveryRoot,
        "clients",
        `${createHash("sha256").update(canonical).digest("hex")}.json`,
      );
      const saved = await readLocalJson(this.clientPath);
      this.vaultId = UUID.test(saved?.vaultId || "") ? saved.vaultId : randomUUID();
      this.instanceId = UUID.test(saved?.instanceId || "") ? saved.instanceId : "";
      await this.saveConnectionPreference();
    }
    if (this.unloaded) return;
    for (const event of ["create", "delete", "rename"]) {
      this.registerEvent(
        this.app.vault.on(event, () => {
          this.files = null;
        }),
      );
    }
    this.registerInterval(
      window.setInterval(() => {
        void this.discover();
      }, 3_000),
    );
    await this.discover();
    if (this.unloaded) return;
    this.addSettingTab(new ContextSettings(this.app, this));
    this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.schedule()));
    this.registerEvent(this.app.workspace.on("file-open", () => this.schedule()));
    this.registerEvent(this.app.workspace.on("editor-change", () => this.schedule()));
    this.registerDomEvent(document, "selectionchange", () => this.schedule());
    this.registerInterval(
      window.setInterval(() => {
        // Re-read the Vault current view even while typing in Synara; this is not OS focus attribution.
        this.schedule();
      }, 5_000),
    );
    this.addCommand({
      id: "share-current-context",
      name: "Share current note context",
      callback: () => this.publish(),
    });
  }

  async saveConnectionPreference() {
    if (this.clientPath)
      await writeLocalJson(this.clientPath, { vaultId: this.vaultId, instanceId: this.instanceId });
  }

  async removeDiscovery() {
    if (this.vaultId && this.discoveryRoot)
      await fs
        .rm(path.join(this.discoveryRoot, "vaults", `${this.vaultId}.json`), { force: true })
        .catch(() => {});
  }

  async requestConnection(instanceId = this.instanceId) {
    this.discoveryRevision = (this.discoveryRevision || 0) + 1;
    if (this.discoveryJob) await this.discoveryJob;
    if (this.unloaded) return;
    this.disconnect();
    this.instanceId = UUID.test(instanceId || "") ? instanceId : "";
    this.autoConnect = true;
    this.requestId = randomUUID();
    this.retryAt = 0;
    await this.saveConnectionPreference();
    await this.discover();
  }

  async pauseConnection() {
    this.discoveryRevision = (this.discoveryRevision || 0) + 1;
    this.autoConnect = false;
    this.disconnect();
    this.token = "";
    this.status = "已断开";
    if (this.discoveryJob) await this.discoveryJob;
    await this.removeDiscovery();
  }

  discover() {
    if (this.discoveryJob) return this.discoveryJob;
    this.discoveryJob = this.discoverOnce()
      .catch(() => {
        this.status = "无法读取本机连接信息";
      })
      .finally(() => {
        this.discoveryJob = null;
      });
    return this.discoveryJob;
  }

  async discoverOnce() {
    if (this.unloaded || !this.vaultId || !this.autoConnect) return;
    const revision = this.discoveryRevision;
    const now = Date.now();
    await writeLocalJson(path.join(this.discoveryRoot, "vaults", `${this.vaultId}.json`), {
      schemaVersion: 1,
      vaultId: this.vaultId,
      requestId: this.requestId,
      label: this.app.vault.getName().slice(0, 128),
      updatedAt: new Date(now).toISOString(),
    });
    let names = [];
    try {
      names = await fs.readdir(path.join(this.discoveryRoot, "instances"));
    } catch {
      /* No running workbench. */
    }
    const instances = [];
    for (const name of names
      .filter((entry) => entry.endsWith(".json") && UUID.test(entry.slice(0, -5)))
      .slice(0, 128)) {
      const item = await readLocalJson(path.join(this.discoveryRoot, "instances", name));
      const age = now - Date.parse(item?.updatedAt);
      if (
        item?.schemaVersion !== 1 ||
        item.instanceId !== name.slice(0, -5) ||
        !Number.isFinite(age) ||
        age > 15_000 ||
        age < -5_000 ||
        typeof item.label !== "string" ||
        item.label.length > 128 ||
        !Array.isArray(item.connections)
      )
        continue;
      instances.push(item);
    }
    if (this.unloaded || !this.autoConnect || revision !== this.discoveryRevision) return;
    this.instances = instances;
    let instance = instances.find((entry) => entry.instanceId === this.instanceId);
    if (!this.instanceId && instances.length === 1) {
      instance = instances[0];
      this.instanceId = instance.instanceId;
      await this.saveConnectionPreference();
    }
    const connection = instance?.connections.find(
      (entry) =>
        entry.vaultId === this.vaultId &&
        ENDPOINT.test(entry.endpoint) &&
        /^[a-f0-9]{64}$/.test(entry.sourceId),
    );
    const grant = instance
      ? await readLocalJson(
          path.join(this.discoveryRoot, "grants", instance.instanceId, `${this.vaultId}.json`),
        )
      : null;
    if (this.unloaded || !this.autoConnect || revision !== this.discoveryRevision) return;
    if (
      !connection ||
      grant?.instanceId !== instance.instanceId ||
      grant?.vaultId !== this.vaultId ||
      grant?.sourceId !== connection.sourceId ||
      !/^[a-f0-9]{64}$/.test(grant?.token || "")
    ) {
      this.disconnect();
      this.token = "";
      this.status = !instance
        ? instances.length > 1
          ? "请选择工作台"
          : "等待工作台启动"
        : "等待在 Synara 应用上下文中授权";
      return;
    }
    if (
      this.endpoint === connection.endpoint &&
      this.token === grant.token &&
      this.socket &&
      this.socket.readyState <= WebSocket.OPEN
    )
      return;
    if (now < this.retryAt) return;
    this.endpoint = connection.endpoint;
    this.token = grant.token;
    this.expectedSourceId = connection.sourceId;
    this.status = "正在连接";
    this.connect();
  }

  basePath() {
    const adapter = this.app.vault.adapter;
    return adapter instanceof FileSystemAdapter ? adapter.getBasePath() : null;
  }

  schedule() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.publish();
    }, 150);
  }

  publish() {
    if (this.socket?.readyState !== WebSocket.OPEN || !this.policy.enabled) return;
    const observations = capture({
      sourceId: this.sourceId,
      policy: this.policy,
      view: this.app.workspace.getActiveViewOfType(MarkdownView),
      basePath: this.basePath(),
      windowId: this.windowId,
    });
    this.send({ kind: "publish", publication: { sequence: this.sequence++, observations } });
  }

  send(message) {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    const body = JSON.stringify(message);
    if (body.length > 65_536 || this.socket.bufferedAmount > 262_144) {
      if (message.kind === "publish") {
        // Never leave the previous file/selection attachable after a failed update.
        // Closing also clears the desktop batch when backpressure prevents a replacement.
        if (this.socket.bufferedAmount > 262_144) this.disconnect();
        else
          this.socket.send(
            JSON.stringify({
              kind: "publish",
              publication: { sequence: this.sequence++, observations: [] },
            }),
          );
        new Notice(
          "Current context exceeds the sharing limit. Previous context was cleared. Reduce the selection or disable document content in Synara.",
        );
      }
      return;
    }
    this.socket.send(body);
  }

  connect() {
    if (this.unloaded) return;
    this.disconnect();
    // No arbitrary network endpoints, redirects, URL credentials or path/query tokens.
    if (
      !/^ws:\/\/127\.0\.0\.1:[0-9]{1,5}$/.test(this.endpoint) ||
      !/^[a-f0-9]{64}$/.test(this.token)
    ) {
      new Notice("Enter the local endpoint and pairing code shown in Synara.");
      return;
    }
    const socket = new WebSocket(this.endpoint);
    this.socket = socket;
    this.sequence = 0;
    socket.onopen = () => {
      if (socket === this.socket) this.send({ kind: "pair", token: this.token });
    };
    socket.onmessage = (event) => {
      if (socket !== this.socket || typeof event.data !== "string" || event.data.length > 65_536)
        return;
      try {
        const message = JSON.parse(event.data);
        if (
          message.kind === "policy" &&
          typeof message.policy?.enabled === "boolean" &&
          Array.isArray(message.policy.allowedTypes)
        ) {
          if (this.expectedSourceId && message.sourceId !== this.expectedSourceId) {
            this.disconnect();
            return;
          }
          this.sourceId = typeof message.sourceId === "string" ? message.sourceId : "obsidian";
          this.policy = message.policy;
          this.retryDelay = 1_000;
          this.status = "已连接";
          this.publish();
          if (!this.autoConnect)
            new Notice("Synara context connected. Only the types enabled in Synara are shared.");
        } else if (
          message.kind === "search" &&
          typeof message.requestId === "string" &&
          typeof message.query === "string"
        ) {
          this.send({
            kind: "search-result",
            requestId: message.requestId,
            resources: search({
              sourceId: this.sourceId,
              policy: this.policy,
              basePath: this.basePath(),
              files: this.files ?? (this.files = this.app.vault.getMarkdownFiles()),
              query: message.query,
            }),
          });
        }
      } catch {
        this.disconnect();
      }
    };
    socket.onclose = () => {
      if (socket !== this.socket) return;
      this.policy = { enabled: false, allowedTypes: [] };
      this.socket = null;
      this.status = "连接已断开，等待重连";
      this.retryAt = Date.now() + (this.retryDelay || 1_000);
      this.retryDelay = Math.min((this.retryDelay || 1_000) * 2, 30_000);
    };
    socket.onerror = () => socket.close();
  }

  disconnect() {
    const socket = this.socket;
    this.socket = null;
    this.policy = { enabled: false, allowedTypes: [] };
    socket?.close();
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  onunload() {
    this.unloaded = true;
    this.autoConnect = false;
    this.disconnect();
    if (this.discoveryJob) void this.discoveryJob.finally(() => this.removeDiscovery());
    else void this.removeDiscovery();
    this.token = "";
  }
};

class ContextSettings extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
    this.selectedInstanceId = plugin.instanceId || "";
    this.selectionEdited = false;
    this.busy = false;
  }

  refreshConnectionState() {
    if (!this.containerEl.isConnected || !this.statusSetting) return;
    const plugin = this.plugin;
    this.statusSetting.setDesc(plugin.status || "尚未连接");
    const signature = JSON.stringify(
      plugin.instances.map((instance) => [instance.instanceId, instance.label]),
    );
    if (signature !== this.instanceSignature && this.instanceDropdown) {
      this.instanceSignature = signature;
      this.instanceDropdown.selectEl.replaceChildren();
      this.instanceDropdown.addOption(
        "",
        plugin.instances.length ? "选择工作台" : "未发现正在运行的工作台",
      );
      for (const instance of plugin.instances) {
        const duplicate =
          plugin.instances.filter((entry) => entry.label === instance.label).length > 1;
        this.instanceDropdown.addOption(
          instance.instanceId,
          duplicate ? `${instance.label} · ${instance.instanceId.slice(0, 8)}` : instance.label,
        );
      }
      if (
        this.selectedInstanceId &&
        !plugin.instances.some((instance) => instance.instanceId === this.selectedInstanceId)
      ) {
        this.instanceDropdown.addOption(
          this.selectedInstanceId,
          `上次工作台 · ${this.selectedInstanceId.slice(0, 8)}（未运行）`,
        );
      }
      this.instanceDropdown.setValue(this.selectedInstanceId);
    }
    if (
      !this.selectionEdited &&
      plugin.instanceId &&
      this.selectedInstanceId !== plugin.instanceId
    ) {
      this.selectedInstanceId = plugin.instanceId;
      this.instanceDropdown?.setValue(this.selectedInstanceId);
    }
    this.instanceDropdown?.setDisabled(this.busy);
    this.connectButton?.setDisabled(
      this.busy || (plugin.instances.length > 1 && !this.selectedInstanceId),
    );
    this.disconnectButton?.setDisabled(this.busy || (!plugin.autoConnect && !plugin.socket));
    this.refreshButton?.setDisabled(this.busy || !plugin.autoConnect);
  }

  async runConnectionAction(action) {
    this.busy = true;
    this.refreshConnectionState();
    try {
      await action();
    } catch (error) {
      this.plugin.status = "连接操作失败，请重试";
      new Notice(error instanceof Error ? error.message : this.plugin.status);
    } finally {
      this.busy = false;
      this.refreshConnectionState();
    }
  }

  display() {
    const { containerEl } = this;
    const plugin = this.plugin;
    containerEl.empty();
    this.instanceSignature = null;
    containerEl.createEl("p", {
      text: "自动查找本机 Synara。首次连接请在 Synara 设置 → 应用上下文中批准此知识库，再在会话中通过 @ → 上下文绑定。",
    });
    new Setting(containerEl)
      .setName("工作台")
      .setDesc("同时运行多个工作台时，选择此知识库要连接的实例。")
      .addDropdown((dropdown) => {
        this.instanceDropdown = dropdown;
        dropdown.onChange((value) => {
          this.selectedInstanceId = value;
          this.selectionEdited = true;
          this.refreshConnectionState();
        });
      });
    this.statusSetting = new Setting(containerEl)
      .setName("连接状态")
      .addButton((button) => {
        this.refreshButton = button;
        button
          .setButtonText("刷新")
          .onClick(() => this.runConnectionAction(() => plugin.discover()));
      })
      .addButton((button) => {
        this.connectButton = button;
        button
          .setButtonText("连接 / 请求授权")
          .setCta()
          .onClick(() =>
            this.runConnectionAction(async () => {
              await plugin.requestConnection(this.selectedInstanceId);
              this.selectionEdited = false;
            }),
          );
      })
      .addButton((button) => {
        this.disconnectButton = button;
        button
          .setButtonText("断开")
          .onClick(() => this.runConnectionAction(() => plugin.pauseConnection()));
      });
    containerEl.createEl("p", {
      text: "断开后停止自动连接；点击连接可重新查找。选区优先，未选中正文时默认只发送文件引用。",
    });
    const advanced = containerEl.createEl("details");
    advanced.createEl("summary", { text: "高级：手动连接" });
    advanced.createEl("p", {
      text: "仅在自动发现不可用时填写 Synara 提供的本机地址与配对码。配对码只保留在当前会话，不写入知识库。",
    });
    let manualEndpoint = plugin.endpoint || "";
    let manualToken = "";
    new Setting(advanced).setName("本机地址").addText((text) =>
      text
        .setPlaceholder("ws://127.0.0.1:端口")
        .setValue(manualEndpoint)
        .onChange((value) => {
          manualEndpoint = value.trim();
        }),
    );
    new Setting(advanced).setName("配对码").addText((text) => {
      text.inputEl.type = "password";
      text.inputEl.autocomplete = "off";
      text.onChange((value) => {
        manualToken = value.trim();
      });
    });
    new Setting(advanced).addButton((button) => {
      button.setButtonText("手动连接").onClick(() =>
        this.runConnectionAction(async () => {
          if (!ENDPOINT.test(manualEndpoint) || !manualToken) {
            new Notice("请填写有效的本机地址与配对码。");
            return;
          }
          await plugin.pauseConnection();
          plugin.autoConnect = false;
          plugin.expectedSourceId = undefined;
          plugin.endpoint = manualEndpoint;
          plugin.token = manualToken;
          plugin.status = "正在连接";
          plugin.connect();
        }),
      );
    });
    this.refreshConnectionState();
    if (!this.refreshTimerStarted) {
      this.refreshTimerStarted = true;
      plugin.registerInterval(window.setInterval(() => this.refreshConnectionState(), 1_000));
    }
  }
}
