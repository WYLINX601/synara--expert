import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const COMPLETE_VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;

export class ToolchainPinError extends Error {
  constructor(code) {
    super(code);
    this.name = "ToolchainPinError";
    this.code = code;
  }
}

function withoutTomlComment(line) {
  let quote = null;
  let escaped = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (quote === '"') {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        quote = null;
      }
    } else if (quote === "'") {
      if (character === "'") quote = null;
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === "#") {
      return line.slice(0, index);
    }
  }
  return line;
}

export function parseMiseToolchainPins(source) {
  if (typeof source !== "string") throw new ToolchainPinError("mise-source-invalid");

  let table = "";
  let toolsTableSeen = false;
  const pins = Object.create(null);
  const tableHeader = /^\[([A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*)\]$/;
  const assignmentLine = /^([A-Za-z0-9_-]+)\s*=\s*(.+)$/;
  const quotedString = /^(?:"([^"\\]*)"|'([^'\\]*)')$/;

  for (const [index, rawLine] of source.split(/\r?\n/).entries()) {
    const line = withoutTomlComment(rawLine).trim();
    if (!line) continue;

    if (line.startsWith("[")) {
      const header = tableHeader.exec(line);
      if (!header) throw new ToolchainPinError("mise-table-header-invalid");
      table = header[1];
      if (table === "tools") {
        if (toolsTableSeen) throw new ToolchainPinError("tools-table-duplicate");
        toolsTableSeen = true;
      }
      continue;
    }

    if (table !== "tools") continue;
    const assignment = assignmentLine.exec(line);
    if (!assignment) throw new ToolchainPinError("tools-entry-invalid-line-" + (index + 1));

    const key = assignment[1];
    if (key !== "node" && key !== "bun") continue;
    if (Object.hasOwn(pins, key)) throw new ToolchainPinError(key + "-pin-duplicate");

    const value = quotedString.exec(assignment[2].trim());
    if (!value) throw new ToolchainPinError(key + "-pin-not-a-plain-string");
    const version = value[1] ?? value[2];
    if (!COMPLETE_VERSION.test(version)) {
      throw new ToolchainPinError(key + "-pin-not-an-exact-version");
    }
    pins[key] = version;
  }

  if (!toolsTableSeen) throw new ToolchainPinError("tools-table-missing");
  if (!Object.hasOwn(pins, "node")) throw new ToolchainPinError("node-pin-missing");
  if (!Object.hasOwn(pins, "bun")) throw new ToolchainPinError("bun-pin-missing");
  return { node: pins.node, bun: pins.bun };
}

function main() {
  if (process.argv.length !== 3 || !process.argv[2]) {
    throw new ToolchainPinError("expected-one-mise-file-path");
  }

  let source;
  try {
    source = readFileSync(process.argv[2], "utf8");
  } catch {
    throw new ToolchainPinError("mise-file-unreadable");
  }
  const pins = parseMiseToolchainPins(source);
  process.stdout.write("node=" + pins.node + "\nbun=" + pins.bun + "\n");
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  try {
    main();
  } catch (error) {
    const code = error instanceof ToolchainPinError ? error.code : "toolchain-read-failed";
    process.stderr.write(
      "::error::Could not load exact Node and Bun pins from .mise.toml (" + code + ").\n",
    );
    process.exitCode = 1;
  }
}
