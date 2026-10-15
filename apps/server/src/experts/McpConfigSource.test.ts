import { DatabaseSync } from "node:sqlite";
import { mkdtemp, readFile, rm, stat, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

import {
  McpSourceReadError,
  readMcpConfigSourceValues,
  readMcpSourceEntries,
  type ResolvedMcpSource,
} from "./McpConfigSource.ts";

const MAX_SOURCE_BYTES = 1024 * 1024;
const MAX_SOURCE_ENTRIES = 1_000;
const MAX_CC_SWITCH_DATABASE_BYTES = 64 * 1024 * 1024;

async function withTempDirectory<T>(run: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(path.join(tmpdir(), "synara-mcp-config-source-test-"));
  try {
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function expectInvalidSource(read: () => Promise<unknown>, sensitiveText?: string) {
  let failure: unknown;
  try {
    await read();
  } catch (error) {
    failure = error;
  }

  expect(failure).toBeInstanceOf(McpSourceReadError);
  expect(failure).toMatchObject({
    code: "invalid",
    message: "MCP source is unavailable.",
  });
  if (sensitiveText !== undefined) {
    expect(String(failure)).not.toContain(sensitiveText);
  }
}

async function createCcSwitchDatabase(
  databasePath: string,
  entries: ReadonlyArray<{
    readonly id: string;
    readonly name: string;
    readonly config: string;
    readonly enabledCodex: 0 | 1;
  }>,
  paddingBytes = 0,
): Promise<void> {
  const database = new DatabaseSync(databasePath);
  try {
    database.exec(
      "CREATE TABLE mcp_servers (id TEXT PRIMARY KEY, name TEXT, server_config TEXT, enabled_codex INTEGER)",
    );
    const insert = database.prepare(
      "INSERT INTO mcp_servers (id, name, server_config, enabled_codex) VALUES (?, ?, ?, ?)",
    );
    for (const entry of entries) {
      insert.run(entry.id, entry.name, entry.config, entry.enabledCodex);
    }
    if (paddingBytes > 0) {
      database.exec("CREATE TABLE source_padding (value TEXT)");
      database
        .prepare("INSERT INTO source_padding (value) VALUES (?)")
        .run("x".repeat(paddingBytes));
    }
  } finally {
    database.close();
  }
}

describe("MCP config source reader", () => {
  it("reads Codex literal env and HTTP header fields without confusing host env names", async () => {
    await withTempDirectory(async (root) => {
      const sourcePath = path.join(root, "config.toml");
      const contents = [
        "[mcp_servers.fixture]",
        'command = "fixture-mcp"',
        'env = { TOKEN = "first\\nsecond" }',
        'env_vars = ["HOST_TOKEN"]',
        'http_headers = { Authorization = "Bearer literal-header" }',
        "",
      ].join("\n");
      await writeFile(sourcePath, contents, "utf8");
      const before = await readFile(sourcePath);
      const source = { kind: "codex" as const, path: sourcePath, entryId: "fixture" };

      const env = await readMcpConfigSourceValues({ source, section: "env", names: ["TOKEN"] });
      const headers = await readMcpConfigSourceValues({
        source,
        section: "headers",
        names: ["Authorization"],
      });

      expect(env).toMatchObject({ TOKEN: "first\nsecond" });
      expect(headers).toMatchObject({ Authorization: "Bearer literal-header" });
      await expectInvalidSource(() =>
        readMcpConfigSourceValues({ source, section: "env", names: ["HOST_TOKEN"] }),
      );
      expect(await readFile(sourcePath)).toEqual(before);
    });
  });

  it("reads JSON mcpServers and servers containers and keeps malformed JSON errors generic", async () => {
    await withTempDirectory(async (root) => {
      const sourcePath = path.join(root, "servers.json");
      const contents = JSON.stringify({
        mcpServers: { first: { command: "fixture-one" } },
        servers: { second: { url: "https://example.invalid/mcp" } },
      });
      await writeFile(sourcePath, contents, "utf8");
      const before = await readFile(sourcePath);
      const source: ResolvedMcpSource = { kind: "json", path: sourcePath };

      const entries = await readMcpSourceEntries(source);

      expect(entries.map(({ entryId }) => entryId)).toEqual(["mcpServers:first", "servers:second"]);
      expect(await readFile(sourcePath)).toEqual(before);

      const invalidPath = path.join(root, "invalid.json");
      const privateMarker = "PRIVATE_CONFIG_MARKER_DO_NOT_EXPOSE";
      await writeFile(invalidPath, `{ invalid: "${privateMarker}" }`, "utf8");
      const invalidBefore = await readFile(invalidPath);
      await expectInvalidSource(
        () => readMcpSourceEntries({ kind: "json", path: invalidPath }),
        privateMarker,
      );
      expect(await readFile(invalidPath)).toEqual(invalidBefore);
    });
  });

  it("reads enabled and disabled CC Switch rows from a database larger than one MiB", async () => {
    await withTempDirectory(async (root) => {
      const databasePath = path.join(root, "cc-switch.db");
      await createCcSwitchDatabase(
        databasePath,
        [
          {
            id: "enabled",
            name: "Enabled entry",
            config: JSON.stringify({ type: "stdio", command: "fixture-enabled" }),
            enabledCodex: 1,
          },
          {
            id: "disabled",
            name: "Disabled entry",
            config: JSON.stringify({ type: "stdio", command: "fixture-disabled" }),
            enabledCodex: 0,
          },
        ],
        1_100_000,
      );
      const before = await readFile(databasePath);
      expect((await stat(databasePath)).size).toBeGreaterThan(MAX_SOURCE_BYTES);

      const entries = await readMcpSourceEntries({ kind: "cc-switch", path: databasePath });

      expect(entries.map(({ entryId, sourceEnabled }) => [entryId, sourceEnabled])).toEqual([
        ["enabled", true],
        ["disabled", false],
      ]);
      expect(await readFile(databasePath)).toEqual(before);
    });
  });

  it("requires own string values, unique names, NUL-free values, and CR/LF-free headers", async () => {
    await withTempDirectory(async (root) => {
      const sourcePath = path.join(root, "source.json");
      const source = { kind: "json" as const, path: sourcePath, entryId: "mcpServers:fixture" };
      const invalidCases: ReadonlyArray<{
        readonly env?: Record<string, string>;
        readonly headers?: Record<string, string>;
        readonly section: "env" | "headers";
        readonly names: ReadonlyArray<string>;
      }> = [
        { env: {}, section: "env", names: ["toString"] },
        { env: { TOKEN: "value" }, section: "env", names: ["TOKEN", "TOKEN"] },
        {
          headers: { "X-Token": "one", "x-token": "two" },
          section: "headers",
          names: ["X-Token", "x-token"],
        },
        { env: { TOKEN: "before\0after" }, section: "env", names: ["TOKEN"] },
        {
          headers: { Authorization: "safe\r\nInjected: value" },
          section: "headers",
          names: ["Authorization"],
        },
      ];

      for (const invalidCase of invalidCases) {
        const contents = JSON.stringify({
          mcpServers: {
            fixture: {
              command: "fixture-mcp",
              ...(invalidCase.env === undefined ? {} : { env: invalidCase.env }),
              ...(invalidCase.headers === undefined ? {} : { headers: invalidCase.headers }),
            },
          },
        });
        await writeFile(sourcePath, contents, "utf8");
        const before = await readFile(sourcePath);
        await expectInvalidSource(() =>
          readMcpConfigSourceValues({
            source,
            section: invalidCase.section,
            names: invalidCase.names,
          }),
        );
        expect(await readFile(sourcePath)).toEqual(before);
      }
    });
  });

  it("enforces text, entry-count, and CC Switch database size limits", async () => {
    await withTempDirectory(async (root) => {
      const oversizedTextPath = path.join(root, "oversized.json");
      const privateMarker = "PRIVATE_OVERSIZED_VALUE";
      await writeFile(oversizedTextPath, privateMarker + "x".repeat(MAX_SOURCE_BYTES));
      await expectInvalidSource(
        () => readMcpSourceEntries({ kind: "json", path: oversizedTextPath }),
        privateMarker,
      );

      const tooManyEntriesPath = path.join(root, "too-many.json");
      const entries = Object.fromEntries(
        Array.from({ length: MAX_SOURCE_ENTRIES + 1 }, (_, index) => [
          `entry-${index}`,
          { command: "fixture-mcp" },
        ]),
      );
      await writeFile(tooManyEntriesPath, JSON.stringify({ mcpServers: entries }), "utf8");
      await expectInvalidSource(() =>
        readMcpSourceEntries({ kind: "json", path: tooManyEntriesPath }),
      );

      const oversizedDatabasePath = path.join(root, "oversized.db");
      await writeFile(oversizedDatabasePath, "");
      await truncate(oversizedDatabasePath, MAX_CC_SWITCH_DATABASE_BYTES + 1);
      await expectInvalidSource(() =>
        readMcpSourceEntries({ kind: "cc-switch", path: oversizedDatabasePath }),
      );
    });
  });
});
