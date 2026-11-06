import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";
import type { AmbientContextObservation, AmbientResourceReference } from "@synara/contracts";

const require = createRequire(import.meta.url);
const companion = require("../../../obsidian-plugin/capture.cjs") as {
  capture(input: Record<string, unknown>): AmbientContextObservation[];
  search(input: Record<string, unknown>): AmbientResourceReference[];
};
function readingView(text = "阅读模式选区") {
  const anchor = {};
  const focus = {};
  const selection = { anchorNode: anchor, focusNode: focus, toString: vi.fn(() => text) };
  const editor = {
    getSelection: vi.fn(() => "stale"),
    getValue: vi.fn(() => "stale body"),
    getCursor: vi.fn(),
  };
  return {
    selection,
    view: {
      file: { name: "note.md", path: "folder/note.md" },
      getMode: () => "preview",
      editor,
      containerEl: {
        ownerDocument: { getSelection: vi.fn(() => selection) },
        contains: (node: unknown) => node === anchor || node === focus,
      },
    },
  };
}
const base = {
  sourceId: "paper-instance",
  basePath: "/vault/Paper",
  windowId: "window",
  policy: {
    enabled: true,
    allowedTypes: ["resource.identity", "selection.text", "selection.location", "resource.content"],
  },
};
describe("Obsidian reading-view capture", () => {
  it("captures only this view's visible selection without stale editor text or invented locations", () => {
    const { view } = readingView();
    const items = companion.capture({ ...base, view });
    expect(items.map((item) => item.type)).toEqual(["resource.identity", "selection.text"]);
    expect(items[1]?.value).toEqual({ text: "阅读模式选区" });
    expect(view.editor.getSelection).not.toHaveBeenCalled();
    expect(view.editor.getValue).not.toHaveBeenCalled();
    expect(view.editor.getCursor).not.toHaveBeenCalled();
  });
  it("does not capture selections outside or crossing the active view", () => {
    const { view, selection } = readingView();
    selection.focusNode = {};
    expect(companion.capture({ ...base, view }).map((item) => item.type)).toEqual([
      "resource.identity",
    ]);
    selection.anchorNode = {};
    expect(companion.capture({ ...base, view }).map((item) => item.type)).toEqual([
      "resource.identity",
    ]);
  });
  it("does not access DOM selection when its type is denied", () => {
    const { view } = readingView();
    companion.capture({
      ...base,
      view,
      policy: { enabled: true, allowedTypes: ["resource.identity"] },
    });
    expect(view.containerEl.ownerDocument.getSelection).not.toHaveBeenCalled();
  });
  it("does not label an oversized partial selection as exact", () => {
    const { view } = readingView("x".repeat(16_385));
    expect(companion.capture({ ...base, view }).map((item) => item.type)).toEqual([
      "resource.identity",
    ]);
  });
  it("scopes same-name search references to their vault source and full URI", () => {
    const files = [{ name: "note.md", path: "folder/note.md" }];
    const paper = companion.search({ ...base, files, query: "note" });
    const work = companion.search({
      ...base,
      sourceId: "work-instance",
      basePath: "/vault/Work",
      files,
      query: "note",
    });
    expect(paper[0]?.sourceId).toBe("paper-instance");
    expect(work[0]?.sourceId).toBe("work-instance");
    expect(paper[0]?.uri).not.toBe(work[0]?.uri);
    expect(paper[0]?.targetKey).not.toBe(work[0]?.targetKey);
  });
});
