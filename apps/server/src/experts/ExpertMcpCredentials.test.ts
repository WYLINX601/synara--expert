import { randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import type { ExpertConnectionTransport } from "@synara/contracts";
import { afterEach, describe, expect, it } from "vitest";

import {
  createExpertMcpCredentialStore,
  resolveExpertMcpCredentialValues,
} from "./ExpertMcpCredentials.ts";

const temporaryRoots: string[] = [];
const originalHostValue = process.env.SYNARA_MCP_CREDENTIAL_TEST_HOST;

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "synara-expert-mcp-credentials-"));
  temporaryRoots.push(root);
  return root;
}

afterEach(async () => {
  if (originalHostValue === undefined) delete process.env.SYNARA_MCP_CREDENTIAL_TEST_HOST;
  else process.env.SYNARA_MCP_CREDENTIAL_TEST_HOST = originalHostValue;
  for (const root of temporaryRoots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

describe("ExpertMcpCredentialStore", () => {
  it("persists credentials across store instances with private file permissions", async () => {
    const stateDir = path.join(await makeTempRoot(), "state");
    const firstStore = createExpertMcpCredentialStore(stateDir);
    const values = {
      env: { FIXTURE_TOKEN: "private-env-value" },
      headers: { authorization: "Bearer private-header-value" },
    };
    const credentialId = await firstStore.create(values);
    const filePath = path.join(stateDir, "secrets", `mcp-${credentialId}.bin`);
    const directoryStat = await lstat(path.dirname(filePath));
    const fileStat = await lstat(filePath);

    expect(credentialId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(directoryStat.mode & 0o777).toBe(0o700);
    expect(fileStat.mode & 0o777).toBe(0o600);
    expect(await createExpertMcpCredentialStore(stateDir).read(credentialId)).toEqual(values);
    expect(await readFile(filePath, "utf8")).toContain("private-env-value");
  });

  it("rejects missing, corrupt, and symlinked credentials with value-free errors", async () => {
    const stateDir = path.join(await makeTempRoot(), "state");
    const store = createExpertMcpCredentialStore(stateDir);
    const missingId = randomUUID();
    await expect(store.read(missingId)).rejects.toThrow(
      "Expert MCP credential is unavailable or invalid.",
    );

    const corruptId = randomUUID();
    const corruptPath = path.join(stateDir, "secrets", `mcp-${corruptId}.bin`);
    await writeFile(corruptPath, "corrupt-private-value");
    await expect(store.read(corruptId)).rejects.toThrow(
      "Expert MCP credential is unavailable or invalid.",
    );

    const symlinkId = randomUUID();
    const externalPath = path.join(await makeTempRoot(), "outside-secret.bin");
    const symlinkPath = path.join(stateDir, "secrets", `mcp-${symlinkId}.bin`);
    await writeFile(externalPath, "outside-private-value");
    await symlink(externalPath, symlinkPath);
    await expect(store.read(symlinkId)).rejects.toThrow(
      "Expert MCP credential is unavailable or invalid.",
    );

    await expect(store.read(corruptId)).rejects.not.toThrow("corrupt-private-value");
    await expect(store.read(symlinkId)).rejects.not.toThrow("outside-private-value");
  });

  it("rejects a symlinked credential directory", async () => {
    const root = await makeTempRoot();
    const stateDir = path.join(root, "state");
    const externalDirectory = path.join(root, "external");
    await mkdir(stateDir);
    await mkdir(externalDirectory);
    await symlink(externalDirectory, path.join(stateDir, "secrets"));

    expect(() => createExpertMcpCredentialStore(stateDir)).toThrow(
      "Expert MCP credential is unavailable or invalid.",
    );
  });

  it("rejects malformed values without including them in errors", async () => {
    const store = createExpertMcpCredentialStore(path.join(await makeTempRoot(), "state"));
    await expect(store.create({ env: { TOKEN: "private\0value" }, headers: {} })).rejects.toThrow(
      "Expert MCP credential is unavailable or invalid.",
    );
    await expect(
      store.create({ env: {}, headers: { authorization: "Bearer private\r\nvalue" } }),
    ).rejects.toThrow("Expert MCP credential is unavailable or invalid.");
    await expect(
      store.create({ env: {}, headers: { Authorization: "one", authorization: "two" } }),
    ).rejects.toThrow("Expert MCP credential is unavailable or invalid.");
  });
});

describe("resolveExpertMcpCredentialValues", () => {
  it("resolves host, legacy source, and owned references together", async () => {
    const root = await makeTempRoot();
    const stateDir = path.join(root, "state");
    const sourcePath = path.join(root, "source.json");
    await writeFile(
      sourcePath,
      JSON.stringify({ mcpServers: { fixture: { env: { LEGACY_VALUE: "legacy-secret-value" } } } }),
    );
    const credentials = createExpertMcpCredentialStore(stateDir);
    const credentialId = await credentials.create({
      env: { OWNED_VALUE: "owned-secret-value" },
      headers: {},
    });
    process.env.SYNARA_MCP_CREDENTIAL_TEST_HOST = "host-value";
    const transport: ExpertConnectionTransport = {
      type: "stdio",
      command: process.execPath,
      args: [],
      envFromHost: [{ name: "HOST_VALUE", envVar: "SYNARA_MCP_CREDENTIAL_TEST_HOST" }],
      envFromSource: {
        source: { kind: "json", path: sourcePath, entryId: "mcpServers:fixture" },
        names: ["LEGACY_VALUE"],
      },
      envFromSecret: { credentialId, names: ["OWNED_VALUE"] },
    };

    await expect(resolveExpertMcpCredentialValues(transport, credentials)).resolves.toEqual({
      env: {
        HOST_VALUE: "host-value",
        LEGACY_VALUE: "legacy-secret-value",
        OWNED_VALUE: "owned-secret-value",
      },
      headers: {},
    });
  });

  it("applies host header prefixes and rejects case-insensitive duplicate HTTP headers", async () => {
    const stateDir = path.join(await makeTempRoot(), "state");
    const credentials = createExpertMcpCredentialStore(stateDir);
    const credentialId = await credentials.create({
      env: {},
      headers: { Authorization: "Bearer owned-secret-value" },
    });
    process.env.SYNARA_MCP_CREDENTIAL_TEST_HOST = "host-secret-value";
    const transport: ExpertConnectionTransport = {
      type: "http",
      url: "https://example.test/mcp",
      headersFromHost: [
        {
          name: "authorization",
          envVar: "SYNARA_MCP_CREDENTIAL_TEST_HOST",
          prefix: "Bearer ",
        },
      ],
      headersFromSecret: { credentialId, names: ["Authorization"] },
    };

    await expect(resolveExpertMcpCredentialValues(transport, credentials)).rejects.toThrow(
      "Expert MCP credential is unavailable or invalid.",
    );
    await expect(resolveExpertMcpCredentialValues(transport, credentials)).rejects.not.toThrow(
      "owned-secret-value",
    );
  });

  it("keeps legacy source references working and rejects missing host values", async () => {
    const root = await makeTempRoot();
    const sourcePath = path.join(root, "source.json");
    await writeFile(
      sourcePath,
      JSON.stringify({ mcpServers: { fixture: { env: { LEGACY_VALUE: "legacy-only-value" } } } }),
    );
    const sourceTransport: ExpertConnectionTransport = {
      type: "stdio",
      command: process.execPath,
      args: [],
      envFromHost: [],
      envFromSource: {
        source: { kind: "json", path: sourcePath, entryId: "mcpServers:fixture" },
        names: ["LEGACY_VALUE"],
      },
    };
    await expect(resolveExpertMcpCredentialValues(sourceTransport)).resolves.toMatchObject({
      env: { LEGACY_VALUE: "legacy-only-value" },
    });

    delete process.env.SYNARA_MCP_CREDENTIAL_TEST_HOST;
    const missingHostTransport: ExpertConnectionTransport = {
      type: "stdio",
      command: process.execPath,
      args: [],
      envFromHost: [{ name: "HOST_VALUE", envVar: "SYNARA_MCP_CREDENTIAL_TEST_HOST" }],
    };
    await expect(resolveExpertMcpCredentialValues(missingHostTransport)).rejects.toThrow(
      "Expert MCP credential is unavailable or invalid.",
    );
  });
});
