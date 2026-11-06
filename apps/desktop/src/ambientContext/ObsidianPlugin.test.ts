import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { AmbientContextPublication } from "@synara/contracts";
import { Schema } from "effect";
import { WebSocket } from "ws";
import { AmbientContextManager } from "./AmbientContextManager";
import { ObsidianSource } from "./ObsidianSource";

const require = createRequire(import.meta.url);
const plugin = require("../../../obsidian-plugin/capture.cjs") as {
  capture: (input: Record<string, unknown>) => unknown[];
  search: (input: Record<string, unknown>) => unknown[];
};
const editor = () => ({
  getSelection: vi.fn(() => "未保存的内容"),
  getCursor: vi.fn((kind: string) => ({ line: kind === "from" ? 2 : 3, ch: 4 })),
  getValue: vi.fn(() => "正文"),
});
class ObsidianWebSocket extends WebSocket {
  constructor(endpoint: string) {
    super(endpoint, { headers: { Origin: "app://obsidian.md" } });
  }
}
describe("Obsidian companion capture", () => {
  it("pairs the actual companion transport and captures unsaved editor data through the desktop bridge", async () => {
    const manager = new AmbientContextManager();
    const source = new ObsidianSource();
    manager.registerSource(source);
    await manager.setPolicy("obsidian", {
      enabled: true,
      allowedTypes: ["resource.identity", "selection.text", "selection.location"],
    });
    const module = { exports: undefined as unknown };
    class FileSystemAdapter {
      getBasePath() {
        return "/test-vault";
      }
    }
    runInNewContext(
      readFileSync(new URL("../../../obsidian-plugin/main.js", import.meta.url), "utf8"),
      {
        module,
        require: (id: string) =>
          id === "obsidian"
            ? {
                Plugin: class {},
                PluginSettingTab: class {},
                MarkdownView: class {},
                FileSystemAdapter,
                Notice: class {},
              }
            : id === "./capture.cjs"
              ? plugin
              : require(id),
        WebSocket: ObsidianWebSocket,
        clearTimeout,
      },
    );
    const Companion = module.exports as new () => {
      connect(): void;
      onunload(): void;
    };
    const companion = new Companion();
    Object.assign(companion, source.pairing(), {
      windowId: "test-window",
      sequence: 0,
      socket: null,
      timer: null,
      policy: { enabled: false, allowedTypes: [] },
      app: {
        vault: { adapter: new FileSystemAdapter() },
        workspace: {
          getActiveViewOfType: () => ({
            file: { name: "note.md", path: "folder/note.md" },
            editor: editor(),
          }),
        },
      },
    });
    try {
      companion.connect();
      await expect.poll(() => manager.resolve().length).toBe(3);
      const snapshot = manager.capture();
      expect(
        snapshot.items.find((item) => item.observation.type === "selection.text")?.observation
          .value,
      ).toEqual({ text: "未保存的内容" });
      expect(
        snapshot.items.find((item) => item.observation.type === "resource.identity")?.observation
          .value,
      ).toEqual({ uri: "file:///test-vault/folder/note.md", title: "note.md", kind: "file" });
      companion.onunload();
      await expect.poll(() => manager.resolve().length).toBe(0);
      expect(snapshot.items).toHaveLength(3);
    } finally {
      companion.onunload();
      await manager.stop();
    }
  });
  it("replaces oversized publications with an empty batch instead of leaving stale context", () => {
    const notices: string[] = [];
    const module = { exports: undefined as unknown };
    runInNewContext(
      readFileSync(new URL("../../../obsidian-plugin/main.js", import.meta.url), "utf8"),
      {
        module,
        require: (id: string) =>
          id === "obsidian"
            ? {
                Plugin: class {},
                PluginSettingTab: class {},
                Notice: class {
                  constructor(text: string) {
                    notices.push(text);
                  }
                },
              }
            : id === "./capture.cjs"
              ? plugin
              : require(id),
        WebSocket: { OPEN: 1 },
      },
    );
    const Plugin = module.exports as new () => {
      sequence: number;
      socket: { readyState: number; bufferedAmount: number; send: ReturnType<typeof vi.fn> };
      send: (message: unknown) => void;
    };
    const instance = new Plugin();
    instance.sequence = 4;
    instance.socket = { readyState: 1, bufferedAmount: 0, send: vi.fn() };
    instance.send({
      kind: "publish",
      publication: { sequence: 3, observations: ["x".repeat(70_000)] },
    });
    expect(JSON.parse(instance.socket.send.mock.calls[0]![0])).toEqual({
      kind: "publish",
      publication: { sequence: 4, observations: [] },
    });
    expect(notices[0]).toContain("Previous context was cleared");
  });
  it("does not read disabled selection or content and emits typed exact editor positions", () => {
    const api = editor();
    const input = {
      basePath: "/vault",
      view: { file: { path: "目录/note #1.md", name: "note #1.md" }, editor: api },
      windowId: "window",
    };
    const observations = plugin.capture({
      ...input,
      policy: { enabled: true, allowedTypes: ["resource.identity", "selection.location"] },
    });
    expect(api.getValue).not.toHaveBeenCalled();
    expect(api.getSelection).not.toHaveBeenCalled();
    const decoded = Schema.decodeUnknownSync(AmbientContextPublication)({
      sequence: 0,
      observations,
    });
    expect(decoded.observations.map((value) => value.type)).toEqual([
      "resource.identity",
      "selection.location",
    ]);
    expect(decoded.observations[0]?.targetKey).not.toContain("note");
    expect(JSON.stringify(decoded)).toContain("note%20%231.md");
  });
  it("captures unsaved selected text, marks content truncation, and clears missing focus", () => {
    const api = editor();
    api.getValue.mockReturnValue("x".repeat(20_000));
    const input = {
      basePath: "/vault",
      view: { file: { path: "note.md", name: "note.md" }, editor: api },
      windowId: "window",
      policy: { enabled: true, allowedTypes: ["selection.text", "resource.content"] },
    };
    const decoded = Schema.decodeUnknownSync(AmbientContextPublication)({
      sequence: 0,
      observations: plugin.capture(input),
    });
    expect(decoded.observations[0]?.value).toEqual({ text: "未保存的内容" });
    expect(decoded.observations[1]?.value).toEqual({ text: "x".repeat(16_384), truncated: true });
    expect(plugin.capture({ ...input, view: null })).toEqual([]);
    expect(plugin.capture({ ...input, policy: { enabled: false, allowedTypes: [] } })).toEqual([]);
  });
  it("searches names/paths without reading file content and respects identity policy", () => {
    const input = {
      basePath: "/vault",
      query: "NOTE",
      files: [{ path: "folder/note.md", name: "note.md" }],
      policy: { enabled: true, allowedTypes: ["resource.identity"] },
    };
    expect(plugin.search(input)).toHaveLength(1);
    expect(plugin.search({ ...input, policy: { enabled: true, allowedTypes: [] } })).toEqual([]);
  });
});
