/* Obsidian loads main.js as CommonJS. No external service or Agent runtime. */
const {
  Plugin,
  PluginSettingTab,
  Setting,
  MarkdownView,
  FileSystemAdapter,
  Notice,
} = require("obsidian");
const { randomUUID } = require("node:crypto");
const { capture, search } = require("./capture.cjs");

module.exports = class SynaraContextPlugin extends Plugin {
  async onload() {
    // Pairing credentials are deliberately session-only, never saved into the Vault.
    this.endpoint = "";
    this.token = "";
    this.policy = { enabled: false, allowedTypes: [] };
    this.windowId = randomUUID();
    this.sequence = 0;
    this.socket = null;
    this.timer = null;
    this.addSettingTab(new ContextSettings(this.app, this));
    this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.schedule()));
    this.registerEvent(this.app.workspace.on("file-open", () => this.schedule()));
    this.registerEvent(this.app.workspace.on("editor-change", () => this.schedule()));
    this.registerDomEvent(document, "selectionchange", () => this.schedule());
    this.registerInterval(
      window.setInterval(() => {
        if (document.hasFocus()) this.schedule();
      }, 5_000),
    );
    this.addCommand({
      id: "share-current-context",
      name: "Share current note context",
      callback: () => this.publish(),
    });
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
          this.policy = message.policy;
          this.publish();
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
              policy: this.policy,
              basePath: this.basePath(),
              files: this.app.vault.getMarkdownFiles(),
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
      new Notice("Synara context disconnected. Reconnect using the current pairing details.");
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
    this.disconnect();
    this.token = "";
  }
};

class ContextSettings extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }
  display() {
    const { containerEl } = this;
    const plugin = this.plugin;
    containerEl.empty();
    containerEl.createEl("p", {
      text: "Enable Obsidian in Synara’s context settings, then paste its pairing details here. Pairing lasts for this app session. Note text is shared only for the types you enable.",
    });
    new Setting(containerEl).setName("Local endpoint").addText((text) =>
      text.setValue(plugin.endpoint).onChange((value) => {
        plugin.endpoint = value.trim();
      }),
    );
    new Setting(containerEl).setName("Pairing code").addText((text) => {
      text.inputEl.type = "password";
      text.setValue(plugin.token).onChange((value) => {
        plugin.token = value.trim();
      });
    });
    new Setting(containerEl)
      .setName("Connection")
      .addButton((button) => button.setButtonText("Connect").onClick(() => plugin.connect()))
      .addButton((button) => button.setButtonText("Disconnect").onClick(() => plugin.disconnect()));
  }
}
