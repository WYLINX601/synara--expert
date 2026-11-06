const { createHash } = require("node:crypto");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const opaqueKey = (value) => createHash("sha256").update(value).digest("hex");
const resourceReference = (basePath, file, sourceId = "obsidian") => {
  const uri = pathToFileURL(path.join(basePath, file.path)).href;
  return { sourceId, targetKey: opaqueKey(uri), uri, title: file.name.slice(0, 512) };
};

/** Read only allowed types. Disabled content is never fetched from the editor. */
function capture({
  sourceId = "obsidian",
  policy,
  view,
  basePath,
  windowId,
  now = new Date().toISOString(),
}) {
  if (!policy.enabled || !view?.file || !basePath) return [];
  const reading = view.getMode?.() === "preview";
  if (!reading && !view.editor) return [];
  const file = view.file;
  const targetKey = opaqueKey(`${basePath}\0${file.path}`);
  const allowed = new Set(policy.allowedTypes);
  const observations = [];
  const add = (type, value) =>
    observations.push({
      schemaVersion: 1,
      id: opaqueKey(`${windowId}\0${targetKey}\0${now}\0${type}`),
      targetKey,
      capturedAt: now,
      method: reading ? "obsidian-reading-selection" : "obsidian-editor-api",
      confidence: "exact",
      type,
      value,
    });
  if (allowed.has("application.identity"))
    add("application.identity", { applicationId: "md.obsidian", name: "Obsidian" });
  if (allowed.has("resource.identity")) {
    const ref = resourceReference(basePath, file, sourceId);
    add("resource.identity", { uri: ref.uri, title: ref.title, kind: "file" });
  }
  if (allowed.has("selection.text")) {
    // Reading views can leave an old editor mounted. Never read its stale selection.
    const container = view.containerEl;
    const selection = reading ? container?.ownerDocument?.getSelection() : null;
    const inside =
      selection?.anchorNode &&
      selection?.focusNode &&
      container?.contains(selection.anchorNode) &&
      container.contains(selection.focusNode);
    const text = reading ? (inside ? selection.toString() : "") : view.editor.getSelection();
    // Never silently truncate a selection and claim it was captured exactly.
    if (text && text.length <= 16_384) add("selection.text", { text });
  }
  if (!reading && allowed.has("selection.location")) {
    const from = view.editor.getCursor("from");
    const to = view.editor.getCursor("to");
    if (from.line !== to.line || from.ch !== to.ch)
      add("selection.location", {
        start: { line: from.line, column: from.ch },
        end: { line: to.line, column: to.ch },
      });
  }
  // Rendered reading views are not guaranteed to contain the complete Markdown source.
  if (!reading && allowed.has("resource.content")) {
    const text = view.editor.getValue();
    add("resource.content", { text: text.slice(0, 16_384), truncated: text.length > 16_384 });
  }
  return observations;
}

function search({ sourceId = "obsidian", policy, basePath, files, query }) {
  if (!policy.enabled || !policy.allowedTypes.includes("resource.identity") || !basePath) return [];
  const normalized = query.slice(0, 256).toLocaleLowerCase();
  return files
    .filter((file) => file.path.toLocaleLowerCase().includes(normalized))
    .slice(0, 30)
    .map((file) => resourceReference(basePath, file, sourceId));
}

module.exports = { capture, search };
