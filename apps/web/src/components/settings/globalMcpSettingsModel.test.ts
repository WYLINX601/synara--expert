import { describe, expect, it } from "vitest";
import {
  connectionSaveInput,
  draftFromConnection,
  sameConnectionDraft,
  validateConnectionDraft,
} from "./globalMcpSettingsModel";

describe("global MCP connection form mapping", () => {
  it("preserves legal stdio argument arrays when another field changes", () => {
    const connection = {
      id: "tools",
      name: "Tools",
      transport: {
        type: "stdio" as const,
        command: "runner",
        args: ["", "  ", "--flag"],
        envFromHost: [],
      },
      revision: 2,
      updatedAt: "2026-10-05T00:00:00.000Z",
    };
    const draft = draftFromConnection(connection);
    draft.name = "Updated name";
    expect(connectionSaveInput(draft, connection.revision).transport).toEqual(connection.transport);
  });

  it("round-trips header prefixes exactly, including an optional trailing space", () => {
    for (const prefix of ["Bearer", "Bearer "]) {
      const connection = {
        id: "http-tools",
        name: "HTTP tools",
        transport: {
          type: "http" as const,
          url: "http://[::1]:8080/mcp",
          headersFromHost: [{ name: "Authorization", envVar: "TOKEN", prefix }],
        },
        revision: 4,
        updatedAt: "2026-10-05T00:00:00.000Z",
      };
      expect(
        connectionSaveInput(draftFromConnection(connection), connection.revision).transport,
      ).toEqual(connection.transport);
    }
  });

  it("keeps a trailing header prefix space after an explicit form edit", () => {
    const connection = {
      id: "http-tools",
      name: "HTTP tools",
      transport: {
        type: "http" as const,
        url: "https://mcp.example.test/mcp",
        headersFromHost: [],
      },
      revision: 4,
      updatedAt: "2026-10-05T00:00:00.000Z",
    };
    const draft = draftFromConnection(connection);
    draft.headersFromHost = "Authorization=TOKEN|Bearer ";
    draft.headersEdited = true;
    expect(connectionSaveInput(draft, connection.revision).transport).toMatchObject({
      headersFromHost: [{ name: "Authorization", envVar: "TOKEN", prefix: "Bearer " }],
    });
  });

  it("preserves imported stdio source references and launch settings while editing form fields", () => {
    const connection = {
      id: "imported-stdio",
      name: "Imported stdio",
      transport: {
        type: "stdio" as const,
        command: "runner",
        args: ["--safe"],
        envFromHost: [],
        cwd: "/repo",
        startupTimeoutMs: 15_000,
        toolTimeoutMs: 45_000,
        envFromSource: {
          source: { kind: "json" as const, path: "/tmp/mcp.json", entryId: "search" },
          names: ["API_TOKEN"],
        },
      },
      revision: 5,
      updatedAt: "2026-10-05T00:00:00.000Z",
    };
    const draft = draftFromConnection(connection);
    draft.name = "Renamed imported stdio";
    draft.command = "runner-v2";

    expect(connectionSaveInput(draft, connection.revision).transport).toEqual({
      ...connection.transport,
      command: "runner-v2",
    });
  });

  it("preserves imported HTTP header references and excludes stdio extensions", () => {
    const connection = {
      id: "imported-http",
      name: "Imported HTTP",
      transport: {
        type: "http" as const,
        url: "https://mcp.example.test/mcp",
        headersFromHost: [],
        headersFromSource: {
          source: { kind: "cc-switch" as const, path: "/tmp/cc-switch.db", entryId: "search" },
          names: ["Authorization", "X-Workspace"],
        },
      },
      revision: 6,
      updatedAt: "2026-10-05T00:00:00.000Z",
    };
    const draft = draftFromConnection(connection);
    draft.name = "Renamed imported HTTP";

    expect(connectionSaveInput(draft, connection.revision).transport).toEqual(connection.transport);

    draft.type = "stdio";
    draft.command = "runner";
    const switchedToStdio = connectionSaveInput(draft, connection.revision).transport;
    expect(switchedToStdio.type).toBe("stdio");
    expect(switchedToStdio).not.toHaveProperty("headersFromSource");

    const switched = draftFromConnection({
      ...connection,
      transport: {
        type: "stdio",
        command: "runner",
        args: [],
        envFromHost: [],
        cwd: "/repo",
        envFromSource: {
          source: { kind: "json", path: "/tmp/mcp.json", entryId: "stdio" },
          names: ["API_TOKEN"],
        },
      },
    });
    switched.type = "http";
    switched.url = "https://mcp.example.test/other";
    const switchedTransport = connectionSaveInput(switched, null).transport;
    expect(switchedTransport.type).toBe("http");
    expect(switchedTransport).not.toHaveProperty("cwd");
    expect(switchedTransport).not.toHaveProperty("envFromSource");
    expect(switchedTransport).not.toHaveProperty("headersFromSource");
  });

  it("preserves private stdio credentials and imported provenance through edits", () => {
    const credentialId = "123e4567-e89b-42d3-a456-426614174000";
    const importedFrom = [
      { kind: "codex" as const, path: "/tmp/codex/config.toml", entryId: "linear" },
      { kind: "cc-switch" as const, path: "/tmp/cc-switch.db", entryId: "linear" },
    ];
    const connection = {
      id: "imported-stdio",
      name: "Imported stdio",
      transport: {
        type: "stdio" as const,
        command: "runner",
        args: ["--safe"],
        envFromHost: [],
        envFromSecret: { credentialId, names: ["API_TOKEN"] },
      },
      importedFrom,
      revision: 7,
      updatedAt: "2026-10-08T00:00:00.000Z",
    };
    const draft = draftFromConnection(connection);
    expect(sameConnectionDraft(draft, draftFromConnection(connection))).toBe(true);
    draft.name = "Renamed imported stdio";

    const saveInput = connectionSaveInput(draft, connection.revision);
    expect(saveInput.importedFrom).toEqual(importedFrom);
    expect(saveInput.transport).toMatchObject({
      type: "stdio",
      envFromSecret: { credentialId, names: ["API_TOKEN"] },
    });
    expect(
      sameConnectionDraft(draft, {
        ...draft,
        envFromSecret: {
          credentialId: "123e4567-e89b-42d3-a456-426614174001",
          names: ["API_TOKEN"],
        },
      }),
    ).toBe(false);
    expect(
      sameConnectionDraft(draft, {
        ...draft,
        importedFrom: [...importedFrom, { kind: "json", path: "/tmp/mcp.json", entryId: "linear" }],
      }),
    ).toBe(false);
  });

  it("preserves private HTTP header references through edits", () => {
    const credentialId = "123e4567-e89b-42d3-a456-426614174002";
    const importedFrom = [
      { kind: "json" as const, path: "/tmp/mcp.json", entryId: "servers:linear" },
    ];
    const connection = {
      id: "imported-http",
      name: "Imported HTTP",
      transport: {
        type: "http" as const,
        url: "https://mcp.example.test/mcp",
        headersFromHost: [],
        headersFromSecret: { credentialId, names: ["Authorization", "X-Workspace"] },
      },
      importedFrom,
      revision: 8,
      updatedAt: "2026-10-08T00:00:00.000Z",
    };
    const draft = draftFromConnection(connection);
    draft.name = "Renamed imported HTTP";

    const saveInput = connectionSaveInput(draft, connection.revision);
    expect(saveInput.importedFrom).toEqual(importedFrom);
    expect(saveInput.transport).toEqual(connection.transport);
    expect(
      sameConnectionDraft(draft, {
        ...draft,
        headersFromSecret: { credentialId, names: ["Authorization"] },
      }),
    ).toBe(false);
  });

  it("blocks host mappings that shadow saved private or legacy names", () => {
    const stdio = draftFromConnection({
      id: "imported-stdio",
      name: "Imported stdio",
      transport: {
        type: "stdio",
        command: "runner",
        args: [],
        envFromHost: [],
        envFromSource: {
          source: { kind: "codex", path: "/tmp/codex.toml", entryId: "tools" },
          names: ["LEGACY_TOKEN"],
        },
        envFromSecret: {
          credentialId: "123e4567-e89b-42d3-a456-426614174003",
          names: ["API_TOKEN"],
        },
      },
      revision: 9,
      updatedAt: "2026-10-08T00:00:00.000Z",
    });
    stdio.envFromHost = "API_TOKEN=HOST_TOKEN";
    expect(validateConnectionDraft(stdio)).toBe("主机映射与已保存变量名称重复。");
    stdio.envFromHost = "LEGACY_TOKEN=HOST_TOKEN";
    expect(validateConnectionDraft(stdio)).toBe("主机映射与已保存变量名称重复。");
    stdio.envFromHost = "OTHER_TOKEN=HOST_TOKEN";
    expect(validateConnectionDraft(stdio)).toBeNull();

    const http = draftFromConnection({
      id: "imported-http",
      name: "Imported HTTP",
      transport: {
        type: "http",
        url: "https://mcp.example.test/mcp",
        headersFromHost: [],
        headersFromSource: {
          source: { kind: "json", path: "/tmp/mcp.json", entryId: "servers:tools" },
          names: ["X-Legacy-Key"],
        },
        headersFromSecret: {
          credentialId: "123e4567-e89b-42d3-a456-426614174004",
          names: ["Authorization"],
        },
      },
      revision: 10,
      updatedAt: "2026-10-08T00:00:00.000Z",
    });
    http.headersFromHost = "authorization=HOST_TOKEN";
    http.headersEdited = true;
    expect(validateConnectionDraft(http)).toBe("主机请求头与已保存名称重复。");
    http.headersFromHost = "x-legacy-key=HOST_TOKEN";
    expect(validateConnectionDraft(http)).toBe("主机请求头与已保存名称重复。");
    http.headersFromHost = "X-Other=HOST_TOKEN";
    expect(validateConnectionDraft(http)).toBeNull();

    const legacyOnly = draftFromConnection({
      id: "legacy-only",
      name: "Legacy only",
      transport: {
        type: "stdio",
        command: "runner",
        args: [],
        envFromHost: [],
        envFromSource: {
          source: { kind: "codex", path: "/tmp/codex.toml", entryId: "legacy" },
          names: ["LEGACY_TOKEN"],
        },
      },
      revision: 11,
      updatedAt: "2026-10-08T00:00:00.000Z",
    });
    legacyOnly.envFromHost = "LEGACY_TOKEN=HOST_TOKEN";
    expect(validateConnectionDraft(legacyOnly)).toBeNull();
  });
});
