import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { McpDiscoveryResult } from "@synara/contracts";
import { afterEach, describe, expect, it } from "vitest";

import { createExpertConnectionStore } from "./ExpertConnectionStore.ts";
import {
  createExpertMcpCredentialStore,
  resolveExpertMcpCredentialValues,
} from "./ExpertMcpCredentials.ts";
import { createLocalMcpDiscovery } from "./LocalMcpDiscovery.ts";
import { readMcpSourceEntries } from "./McpConfigSource.ts";

const temporaryRoots: string[] = [];
const environmentValues = new Map<string, string | undefined>();

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "synara-mcp-discovery-"));
  temporaryRoots.push(root);
  return root;
}

afterEach(async () => {
  for (const [name, previousValue] of environmentValues) {
    if (previousValue === undefined) delete process.env[name];
    else process.env[name] = previousValue;
  }
  environmentValues.clear();
  for (const root of temporaryRoots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

function candidateByName(result: McpDiscoveryResult, name: string) {
  const candidate = result.candidates.find((entry) => entry.name === name);
  if (!candidate) throw new Error(`Missing fixture candidate ${name}.`);
  return candidate;
}

function setFixtureEnvironment(name: string, value: string | undefined): void {
  if (!environmentValues.has(name)) environmentValues.set(name, process.env[name]);
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

describe("LocalMcpDiscovery", () => {
  it("moves source credentials into Synara storage and rejects a changed source", async () => {
    const root = await makeRoot();
    const sourcePath = join(root, "servers.json");
    const sourceSecret = "fixture-source-secret-do-not-return";
    await writeFile(
      sourcePath,
      JSON.stringify({
        mcpServers: {
          fixture: {
            command: process.execPath,
            args: [],
            env: { FIXTURE_SECRET: sourceSecret },
          },
        },
      }),
    );

    const stateDir = join(root, "state");
    const connections = createExpertConnectionStore(stateDir);
    const credentials = createExpertMcpCredentialStore(stateDir);
    const discovery = createLocalMcpDiscovery({ connections, credentials, homeDir: root });
    const scan = await discovery.discover({ sources: [{ kind: "json", path: sourcePath }] });
    const candidate = candidateByName(scan, "fixture");

    expect(candidate.status).toBe("ready");
    expect(JSON.stringify(scan)).not.toContain(sourceSecret);

    const firstImport = await discovery.importSelected({
      scanId: scan.scanId,
      items: [
        { candidateId: candidate.candidateId, targetId: "mcp_source_fixture", mode: "create" },
      ],
    });
    expect(firstImport.items).toMatchObject([{ status: "imported", revision: 1 }]);
    expect(JSON.stringify(firstImport)).not.toContain(sourceSecret);
    const stored = await connections.read("mcp_source_fixture");
    expect(stored?.transport).toMatchObject({
      type: "stdio",
      envFromHost: [],
      envFromSecret: { names: ["FIXTURE_SECRET"] },
    });
    expect(stored?.importedFrom).toEqual([
      { kind: "json", path: sourcePath, entryId: "mcpServers:fixture" },
    ]);
    expect(JSON.stringify(stored)).not.toContain(sourceSecret);
    const secretId =
      stored?.transport.type === "stdio" ? stored.transport.envFromSecret?.credentialId : undefined;
    expect(secretId).toMatch(/^[0-9a-f-]{36}$/u);
    if (!secretId || !stored) throw new Error("Expected an imported private credential.");
    expect(await credentials.read(secretId)).toMatchObject({
      env: { FIXTURE_SECRET: sourceSecret },
    });

    await writeFile(
      sourcePath,
      JSON.stringify({
        mcpServers: {
          fixture: {
            command: process.execPath,
            args: [],
            env: { FIXTURE_SECRET: "changed-source-secret" },
          },
        },
      }),
    );
    const staleImport = await discovery.importSelected({
      scanId: scan.scanId,
      items: [
        { candidateId: candidate.candidateId, targetId: "mcp_stale_fixture", mode: "create" },
      ],
    });
    expect(staleImport.items).toMatchObject([
      { status: "failed", message: "Source entry changed after discovery." },
    ]);
    expect(await connections.read("mcp_stale_fixture")).toBeNull();
    expect(JSON.stringify(staleImport)).not.toContain(sourceSecret);
    await rm(sourcePath);
    expect(await resolveExpertMcpCredentialValues(stored.transport, credentials)).toMatchObject({
      env: { FIXTURE_SECRET: sourceSecret },
    });
  });

  it("imports Codex http_headers as a source reference and rejects header aliases", async () => {
    const root = await makeRoot();
    const sourcePath = join(root, "config.toml");
    const headerSecret = "fixture-http-header-secret";
    await writeFile(
      sourcePath,
      `[mcp_servers.api]\nurl = "https://example.invalid/mcp"\n` +
        `[mcp_servers.api.http_headers]\nAuthorization = ${JSON.stringify(headerSecret)}\n` +
        `[mcp_servers.wrong_alias]\nurl = "https://example.invalid/other"\n` +
        `[mcp_servers.wrong_alias.headers]\nX-Token = "must-not-be-imported"\n` +
        `[mcp_servers.ambiguous]\nurl = "https://example.invalid/ambiguous"\n` +
        `[mcp_servers.ambiguous.headers]\nX-Legacy = "legacy"\n` +
        `[mcp_servers.ambiguous.http_headers]\nX-Canonical = "canonical"\n`,
    );

    const stateDir = join(root, "state");
    const connections = createExpertConnectionStore(stateDir);
    const credentials = createExpertMcpCredentialStore(stateDir);
    const discovery = createLocalMcpDiscovery({ connections, credentials, homeDir: root });
    const scan = await discovery.discover({ sources: [{ kind: "codex", path: sourcePath }] });
    const api = candidateByName(scan, "api");
    expect(api.status).toBe("ready");
    expect(candidateByName(scan, "wrong_alias")).toMatchObject({
      status: "needs-config",
      issues: ["Header settings use an unsupported source field."],
    });
    expect(candidateByName(scan, "ambiguous")).toMatchObject({
      status: "needs-config",
      issues: ["Header settings are ambiguous and need manual review."],
    });
    expect(JSON.stringify(scan)).not.toContain(headerSecret);

    const imported = await discovery.importSelected({
      scanId: scan.scanId,
      items: [{ candidateId: api.candidateId, targetId: "mcp_codex_http", mode: "create" }],
    });
    expect(imported.items).toMatchObject([{ status: "imported", revision: 1 }]);
    const stored = await connections.read("mcp_codex_http");
    expect(stored?.transport).toMatchObject({
      type: "http",
      url: "https://example.invalid/mcp",
      headersFromHost: [],
      headersFromSecret: { names: ["Authorization"] },
    });
    const credentialId =
      stored?.transport.type === "http"
        ? stored.transport.headersFromSecret?.credentialId
        : undefined;
    expect(credentialId).toMatch(/^[0-9a-f-]{36}$/u);
    if (!credentialId || !stored) throw new Error("Expected an imported private credential.");
    expect(await credentials.read(credentialId)).toMatchObject({
      headers: { Authorization: headerSecret },
    });
    expect(JSON.stringify(stored)).not.toContain(headerSecret);
    expect(await resolveExpertMcpCredentialValues(stored.transport, credentials)).toMatchObject({
      headers: { Authorization: headerSecret },
    });
  });

  it("reports same-name conflicts and returns partial per-item outcomes for duplicates, stale CAS, and retired IDs", async () => {
    const root = await makeRoot();
    const sourcePath = join(root, "servers.json");
    await writeFile(
      sourcePath,
      JSON.stringify({
        mcpServers: {
          alpha: { command: process.execPath, args: [] },
          beta: { command: process.execPath, args: ["--safe-fixture"] },
          gamma: { command: process.execPath, args: ["--another-fixture"] },
          delta: { command: process.execPath, args: ["--cas-target"] },
          epsilon: { command: process.execPath, args: ["--retired-target"] },
          collision: { command: process.execPath, args: ["--different-config"] },
        },
      }),
    );

    const stateDir = join(root, "state");
    const connections = createExpertConnectionStore(stateDir);
    const credentials = createExpertMcpCredentialStore(stateDir);
    await connections.save({
      id: "mcp_existing_name",
      name: "collision",
      transport: { type: "stdio", command: "different-command", args: [], envFromHost: [] },
    });
    await connections.save({
      id: "mcp_update_target",
      name: "Previous config",
      transport: { type: "stdio", command: "old-command", args: [], envFromHost: [] },
    });
    await connections.save({
      id: "mcp_retired_target",
      name: "Retired config",
      transport: { type: "stdio", command: "old-command", args: [], envFromHost: [] },
    });
    await connections.remove("mcp_retired_target", 1);

    const discovery = createLocalMcpDiscovery({ connections, credentials, homeDir: root });
    const scan = await discovery.discover({ sources: [{ kind: "json", path: sourcePath }] });
    expect(candidateByName(scan, "collision")).toMatchObject({
      status: "conflict",
      existingId: "mcp_existing_name",
      existingRevision: 1,
    });

    const alpha = candidateByName(scan, "alpha");
    const beta = candidateByName(scan, "beta");
    const gamma = candidateByName(scan, "gamma");
    const delta = candidateByName(scan, "delta");
    const epsilon = candidateByName(scan, "epsilon");
    const result = await discovery.importSelected({
      scanId: scan.scanId,
      items: [
        { candidateId: alpha.candidateId, targetId: "mcp_partial_target", mode: "create" },
        { candidateId: beta.candidateId, targetId: "mcp_duplicate_target", mode: "create" },
        { candidateId: gamma.candidateId, targetId: "mcp_duplicate_target", mode: "create" },
        {
          candidateId: delta.candidateId,
          targetId: "mcp_update_target",
          mode: "update",
          expectedRevision: 2,
        },
        { candidateId: epsilon.candidateId, targetId: "mcp_retired_target", mode: "create" },
      ],
    });

    expect(result.items.map((item) => item.status)).toEqual([
      "imported",
      "failed",
      "failed",
      "failed",
      "failed",
    ]);
    expect(result.items[1]?.message).toBe("Duplicate import selection.");
    expect(result.items[3]?.message).toBe("Connection revision changed; reload before importing.");
    expect(result.items[4]?.message).toBe("Retired connection IDs cannot be reused.");
    expect(await connections.read("mcp_partial_target")).toMatchObject({ revision: 1 });
    expect((await connections.read("mcp_partial_target"))?.transport).not.toHaveProperty(
      "envFromSecret",
    );
    expect(await connections.read("mcp_duplicate_target")).toBeNull();
    expect(await connections.read("mcp_update_target")).toMatchObject({ revision: 1 });
    expect((await connections.readState("mcp_retired_target")).status).toBe("retired");

    expect(await connections.list()).toHaveLength(3);
  });

  it("groups aliases and rechecks every origin before importing one connection", async () => {
    const root = await makeRoot();
    const codexPath = join(root, "config.toml");
    const jsonPath = join(root, "servers.json");
    const sourceSecret = "fixture-dedup-source-secret";
    await writeFile(
      codexPath,
      `[mcp_servers."Codex Alias"]\n` +
        `command = ${JSON.stringify(process.execPath)}\n` +
        `args = ["--shared-fixture"]\n` +
        `enabled = false\n` +
        `env = { FIXTURE_TOKEN = ${JSON.stringify(sourceSecret)} }\n`,
    );
    const jsonConfig = {
      mcpServers: {
        "JSON Alias": {
          command: process.execPath,
          args: ["--shared-fixture"],
          enabled: true,
          env: { FIXTURE_TOKEN: sourceSecret },
        },
      },
    };
    await writeFile(jsonPath, JSON.stringify(jsonConfig));
    expect((await readMcpSourceEntries({ kind: "codex", path: codexPath }))[0]?.sourceEnabled).toBe(
      false,
    );
    expect((await readMcpSourceEntries({ kind: "json", path: jsonPath }))[0]?.sourceEnabled).toBe(
      true,
    );

    const stateDir = join(root, "state");
    const connections = createExpertConnectionStore(stateDir);
    const credentials = createExpertMcpCredentialStore(stateDir);
    const discovery = createLocalMcpDiscovery({ connections, credentials, homeDir: root });
    const scan = await discovery.discover({
      sources: [
        { kind: "codex", path: codexPath },
        { kind: "json", path: jsonPath },
      ],
    });
    expect(scan.candidates).toHaveLength(1);
    const candidate = scan.candidates[0]!;
    expect(candidate).toMatchObject({
      name: "Codex Alias",
      status: "ready",
      sources: [
        { kind: "codex", path: codexPath, entryId: "Codex Alias" },
        { kind: "json", path: jsonPath, entryId: "mcpServers:JSON Alias" },
      ],
    });
    expect(candidate).not.toHaveProperty("sourceEnabled");
    expect(JSON.stringify(scan)).not.toContain(sourceSecret);

    const imported = await discovery.importSelected({
      scanId: scan.scanId,
      items: [{ candidateId: candidate.candidateId, targetId: "mcp_shared_alias", mode: "create" }],
    });
    expect(imported.items).toMatchObject([{ status: "imported", revision: 1 }]);
    const stored = await connections.read("mcp_shared_alias");
    expect(stored?.importedFrom).toEqual(candidate.sources);
    expect(stored?.transport).toMatchObject({
      type: "stdio",
      envFromHost: [],
      envFromSecret: { names: ["FIXTURE_TOKEN"] },
    });
    expect(JSON.stringify(stored)).not.toContain(sourceSecret);

    await writeFile(
      jsonPath,
      JSON.stringify({
        mcpServers: {
          "JSON Alias": {
            ...jsonConfig.mcpServers["JSON Alias"],
            env: { FIXTURE_TOKEN: "changed-after-discovery" },
          },
        },
      }),
    );
    const stale = await discovery.importSelected({
      scanId: scan.scanId,
      items: [{ candidateId: candidate.candidateId, targetId: "mcp_stale_alias", mode: "create" }],
    });
    expect(stale.items).toMatchObject([
      { status: "failed", message: "Source entry changed after discovery." },
    ]);
    expect(await connections.read("mcp_stale_alias")).toBeNull();
  });

  it("normalizes header case and map order while keeping different values separate", async () => {
    const root = await makeRoot();
    const firstPath = join(root, "first.json");
    const secondPath = join(root, "second.json");
    const command = process.execPath;
    await writeFile(
      firstPath,
      JSON.stringify({
        mcpServers: {
          headerFirst: {
            url: "https://example.invalid/mcp",
            headers: { "X-Token": "header-value", "X-Mode": "safe" },
          },
          envFirst: {
            command,
            args: ["--ordered-env"],
            env: { ALPHA: "a", BETA: "b" },
          },
          sameName: { command, args: ["--same-name"], env: { VALUE: "left" } },
        },
      }),
    );
    await writeFile(
      secondPath,
      JSON.stringify({
        mcpServers: {
          headerAlias: {
            url: "https://example.invalid/mcp",
            headers: { "x-mode": "safe", "x-token": "header-value" },
          },
          envAlias: {
            command,
            args: ["--ordered-env"],
            env: { BETA: "b", ALPHA: "a" },
          },
          sameName: { command, args: ["--same-name"], env: { VALUE: "right" } },
        },
      }),
    );

    const stateDir = join(root, "state");
    const connections = createExpertConnectionStore(stateDir);
    const credentials = createExpertMcpCredentialStore(stateDir);
    const discovery = createLocalMcpDiscovery({ connections, credentials, homeDir: root });
    const scan = await discovery.discover({
      sources: [
        { kind: "json", path: firstPath },
        { kind: "json", path: secondPath },
      ],
    });

    expect(candidateByName(scan, "headerFirst").sources).toHaveLength(2);
    expect(candidateByName(scan, "envFirst").sources).toHaveLength(2);
    const sameName = scan.candidates.filter((candidate) => candidate.name === "sameName");
    expect(sameName).toHaveLength(2);
    expect(sameName.map((candidate) => candidate.sources)).toEqual([
      [{ kind: "json", path: firstPath, entryId: "mcpServers:sameName" }],
      [{ kind: "json", path: secondPath, entryId: "mcpServers:sameName" }],
    ]);
  });

  it("matches managed values and updates an equivalent legacy reference", async () => {
    const root = await makeRoot();
    const sourcePath = join(root, "servers.json");
    await writeFile(
      sourcePath,
      JSON.stringify({
        mcpServers: {
          fixture: {
            command: process.execPath,
            args: ["--managed-fixture"],
            env: { FIXTURE_VALUE: "same-value" },
          },
        },
      }),
    );

    const stateDir = join(root, "state");
    const connections = createExpertConnectionStore(stateDir);
    const credentials = createExpertMcpCredentialStore(stateDir);
    const source = { kind: "json" as const, path: sourcePath, entryId: "mcpServers:fixture" };
    await connections.save({
      id: "mcp_legacy_reference",
      name: "Legacy alias",
      transport: {
        type: "stdio",
        command: process.execPath,
        args: ["--managed-fixture"],
        envFromHost: [],
        envFromSource: { source, names: ["FIXTURE_VALUE"] },
      },
    });
    const discovery = createLocalMcpDiscovery({ connections, credentials, homeDir: root });
    const scan = await discovery.discover({ sources: [{ kind: "json", path: sourcePath }] });
    const candidate = candidateByName(scan, "fixture");
    expect(candidate).toMatchObject({
      status: "conflict",
      existingId: "mcp_legacy_reference",
      existingRevision: 1,
    });

    const imported = await discovery.importSelected({
      scanId: scan.scanId,
      items: [
        {
          candidateId: candidate.candidateId,
          targetId: "mcp_legacy_reference",
          mode: "update",
          expectedRevision: 1,
        },
      ],
    });
    expect(imported.items).toMatchObject([{ status: "imported", revision: 2 }]);
    const updated = await connections.read("mcp_legacy_reference");
    expect(updated?.transport).toMatchObject({
      type: "stdio",
      envFromHost: [],
      envFromSecret: { names: ["FIXTURE_VALUE"] },
    });
    expect(updated?.transport).not.toHaveProperty("envFromSource");
    expect(updated?.importedFrom).toEqual([source]);

    const rescanned = await discovery.discover({ sources: [{ kind: "json", path: sourcePath }] });
    expect(candidateByName(rescanned, "fixture")).toMatchObject({
      status: "exists",
      existingId: "mcp_legacy_reference",
      existingRevision: 2,
    });
  });

  it("requires host environment values and rejects changes after discovery", async () => {
    const root = await makeRoot();
    const sourcePath = join(root, "servers.json");
    const envName = `SYNARA_MCP_DISCOVERY_${randomUUID().replaceAll("-", "_").toUpperCase()}`;
    setFixtureEnvironment(envName, undefined);
    await writeFile(
      sourcePath,
      JSON.stringify({
        mcpServers: {
          fixture: {
            command: process.execPath,
            args: [],
            env: { FIXTURE_VALUE: "${env:" + envName + "}" },
          },
        },
      }),
    );
    const stateDir = join(root, "state");
    const connections = createExpertConnectionStore(stateDir);
    const credentials = createExpertMcpCredentialStore(stateDir);
    const discovery = createLocalMcpDiscovery({ connections, credentials, homeDir: root });

    const missingHostValue = await discovery.discover({
      sources: [{ kind: "json", path: sourcePath }],
    });
    expect(candidateByName(missingHostValue, "fixture")).toMatchObject({ status: "needs-config" });

    setFixtureEnvironment(envName, "before-discovery");
    const scan = await discovery.discover({ sources: [{ kind: "json", path: sourcePath }] });
    const candidate = candidateByName(scan, "fixture");
    expect(candidate.status).toBe("ready");
    setFixtureEnvironment(envName, "after-discovery");
    const imported = await discovery.importSelected({
      scanId: scan.scanId,
      items: [{ candidateId: candidate.candidateId, targetId: "mcp_host_changed", mode: "create" }],
    });
    expect(imported.items).toMatchObject([
      { status: "failed", message: "Credential values changed after discovery." },
    ]);
    expect(await connections.read("mcp_host_changed")).toBeNull();
  });
});
