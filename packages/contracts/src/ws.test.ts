import { assert, it } from "@effect/vitest";
import { Effect, Schema } from "effect";

import { ORCHESTRATION_WS_CHANNELS, ORCHESTRATION_WS_METHODS } from "./orchestration";
import { McpDiscoveryResultSchema } from "./mcp";
import { WebSocketRequest, WsResponse, WS_CHANNELS, WS_METHODS } from "./ws";

const decode = <S extends Schema.Top>(
  schema: S,
  input: unknown,
): Effect.Effect<Schema.Schema.Type<S>, Schema.SchemaError, never> =>
  Schema.decodeUnknownEffect(schema as never)(input) as Effect.Effect<
    Schema.Schema.Type<S>,
    Schema.SchemaError,
    never
  >;

it.effect("rejects getTurnDiff requests when fromTurnCount > toTurnCount", () =>
  Effect.gen(function* () {
    const result = yield* Effect.exit(
      decode(WebSocketRequest, {
        id: "req-1",
        body: {
          _tag: ORCHESTRATION_WS_METHODS.getTurnDiff,
          threadId: "thread-1",
          fromTurnCount: 3,
          toTurnCount: 2,
        },
      }),
    );
    assert.strictEqual(result._tag, "Failure");
  }),
);

it.effect("trims websocket request id and nested orchestration ids", () =>
  Effect.gen(function* () {
    const parsed = yield* decode(WebSocketRequest, {
      id: " req-1 ",
      body: {
        _tag: ORCHESTRATION_WS_METHODS.getTurnDiff,
        threadId: " thread-1 ",
        fromTurnCount: 0,
        toTurnCount: 0,
      },
    });
    assert.strictEqual(parsed.id, "req-1");
    assert.strictEqual(parsed.body._tag, ORCHESTRATION_WS_METHODS.getTurnDiff);
    if (parsed.body._tag === ORCHESTRATION_WS_METHODS.getTurnDiff) {
      assert.strictEqual(parsed.body.threadId, "thread-1");
    }
  }),
);

it.effect("accepts revision-guarded expert restore websocket requests", () =>
  Effect.gen(function* () {
    const parsed = yield* decode(WebSocketRequest, {
      id: "req-restore-expert",
      body: {
        _tag: WS_METHODS.serverRestoreExpert,
        id: "expert-1",
        expectedRevision: 7,
      },
    });
    assert.strictEqual(parsed.body._tag, WS_METHODS.serverRestoreExpert);
    if (parsed.body._tag === WS_METHODS.serverRestoreExpert) {
      assert.strictEqual(parsed.body.expectedRevision, 7);
    }

    const invalid = yield* Effect.exit(
      decode(WebSocketRequest, {
        id: "req-restore-expert-invalid",
        body: {
          _tag: WS_METHODS.serverRestoreExpert,
          id: "expert-1",
          expectedRevision: 0,
        },
      }),
    );
    assert.strictEqual(invalid._tag, "Failure");
  }),
);

it.effect("requires a revision for expert delete websocket requests", () =>
  Effect.gen(function* () {
    const parsed = yield* decode(WebSocketRequest, {
      id: "req-delete-expert",
      body: {
        _tag: WS_METHODS.serverDeleteExpert,
        id: "expert-1",
        expectedRevision: 7,
      },
    });
    assert.strictEqual(parsed.body._tag, WS_METHODS.serverDeleteExpert);
    if (parsed.body._tag === WS_METHODS.serverDeleteExpert) {
      assert.strictEqual(parsed.body.expectedRevision, 7);
    }

    const missingRevision = yield* Effect.exit(
      decode(WebSocketRequest, {
        id: "req-delete-expert-missing-revision",
        body: {
          _tag: WS_METHODS.serverDeleteExpert,
          id: "expert-1",
        },
      }),
    );
    assert.strictEqual(missingRevision._tag, "Failure");
  }),
);

it.effect("validates MCP discovery and selected import websocket request schemas", () =>
  Effect.gen(function* () {
    const discovery = yield* decode(WebSocketRequest, {
      id: "req-mcp-discovery",
      body: {
        _tag: WS_METHODS.serverDiscoverMcpConnections,
        sources: [{ kind: "json", path: "/tmp/mcp.json" }],
      },
    });
    assert.strictEqual(discovery.body._tag, WS_METHODS.serverDiscoverMcpConnections);

    const jsonPathRequired = yield* Effect.exit(
      decode(WebSocketRequest, {
        id: "req-mcp-discovery-no-json-path",
        body: {
          _tag: WS_METHODS.serverDiscoverMcpConnections,
          sources: [{ kind: "json" }],
        },
      }),
    );
    assert.strictEqual(jsonPathRequired._tag, "Failure");

    const extraSourceField = yield* Effect.exit(
      decode(WebSocketRequest, {
        id: "req-mcp-discovery-extra-source-field",
        body: {
          _tag: WS_METHODS.serverDiscoverMcpConnections,
          sources: [{ kind: "json", path: "/tmp/mcp.json", rawConfig: "must-not-cross-rpc" }],
        },
      }),
    );
    assert.strictEqual(extraSourceField._tag, "Failure");

    const nulSourcePath = yield* Effect.exit(
      decode(WebSocketRequest, {
        id: "req-mcp-discovery-nul-path",
        body: {
          _tag: WS_METHODS.serverDiscoverMcpConnections,
          sources: [{ kind: "json", path: "/tmp/\0mcp.json" }],
        },
      }),
    );
    assert.strictEqual(nulSourcePath._tag, "Failure");

    const importRequest = yield* decode(WebSocketRequest, {
      id: "req-mcp-import",
      body: {
        _tag: WS_METHODS.serverImportMcpConnections,
        scanId: "scan-1",
        items: [
          {
            candidateId: "candidate-1",
            targetId: "local-tools",
            mode: "update",
            expectedRevision: 3,
          },
        ],
      },
    });
    assert.strictEqual(importRequest.body._tag, WS_METHODS.serverImportMcpConnections);

    const invalidImportRevision = yield* Effect.exit(
      decode(WebSocketRequest, {
        id: "req-mcp-import-invalid-revision",
        body: {
          _tag: WS_METHODS.serverImportMcpConnections,
          scanId: "scan-1",
          items: [
            {
              candidateId: "candidate-1",
              targetId: "local-tools",
              mode: "update",
              expectedRevision: 0,
            },
          ],
        },
      }),
    );
    assert.strictEqual(invalidImportRevision._tag, "Failure");

    const tooManySources = yield* Effect.exit(
      decode(WebSocketRequest, {
        id: "req-mcp-discovery-too-many-sources",
        body: {
          _tag: WS_METHODS.serverDiscoverMcpConnections,
          sources: Array.from({ length: 17 }, (_, index) => ({
            kind: "json",
            path: `/tmp/mcp-${index}.json`,
          })),
        },
      }),
    );
    assert.strictEqual(tooManySources._tag, "Failure");

    const maxSources = yield* decode(WebSocketRequest, {
      id: "req-mcp-discovery-max-sources",
      body: {
        _tag: WS_METHODS.serverDiscoverMcpConnections,
        sources: Array.from({ length: 16 }, (_, index) => ({
          kind: "json",
          path: `/tmp/mcp-${index}.json`,
        })),
      },
    });
    assert.strictEqual(maxSources.body._tag, WS_METHODS.serverDiscoverMcpConnections);

    const tooManyItems = yield* Effect.exit(
      decode(WebSocketRequest, {
        id: "req-mcp-import-too-many-items",
        body: {
          _tag: WS_METHODS.serverImportMcpConnections,
          scanId: "scan-1",
          items: Array.from({ length: 1_001 }, (_, index) => ({
            candidateId: `candidate-${index}`,
            targetId: "local-tools",
            mode: "create",
          })),
        },
      }),
    );
    assert.strictEqual(tooManyItems._tag, "Failure");

    const maxItems = yield* decode(WebSocketRequest, {
      id: "req-mcp-import-max-items",
      body: {
        _tag: WS_METHODS.serverImportMcpConnections,
        scanId: "scan-1",
        items: Array.from({ length: 1_000 }, (_, index) => ({
          candidateId: `candidate-${index}`,
          targetId: "local-tools",
          mode: "create",
        })),
      },
    });
    assert.strictEqual(maxItems.body._tag, WS_METHODS.serverImportMcpConnections);

    const oversizedId = yield* Effect.exit(
      decode(WebSocketRequest, {
        id: "req-mcp-import-oversized-id",
        body: {
          _tag: WS_METHODS.serverImportMcpConnections,
          scanId: "s".repeat(201),
          items: [
            {
              candidateId: "c".repeat(201),
              targetId: "local-tools",
              mode: "create",
            },
          ],
        },
      }),
    );
    assert.strictEqual(oversizedId._tag, "Failure");
  }),
);

it.effect("validates owner skill package import, update, read and removal requests", () =>
  Effect.gen(function* () {
    const base = { id: "req-skill-package" };
    const packageId = `pkg_${"a".repeat(64)}`;
    const sourceId = `src_${"b".repeat(64)}`;
    const preview = yield* decode(WebSocketRequest, {
      ...base,
      body: {
        _tag: WS_METHODS.serverPreviewSkillPackage,
        path: "/tmp/skills/SKILL.md",
      },
    });
    assert.strictEqual(preview.body._tag, WS_METHODS.serverPreviewSkillPackage);

    const importRequest = yield* decode(WebSocketRequest, {
      ...base,
      body: { _tag: WS_METHODS.serverImportSkillPackage, previewId: "preview-1" },
    });
    assert.strictEqual(importRequest.body._tag, WS_METHODS.serverImportSkillPackage);

    const update = yield* decode(WebSocketRequest, {
      ...base,
      body: {
        _tag: WS_METHODS.serverPreviewSkillPackageUpdate,
        sourceId,
        expectedRevision: 3,
      },
    });
    assert.strictEqual(update.body._tag, WS_METHODS.serverPreviewSkillPackageUpdate);

    for (const method of [
      WS_METHODS.serverReadSkillPackage,
      WS_METHODS.serverPreviewSkillPackageRemoval,
    ]) {
      const parsed = yield* decode(WebSocketRequest, {
        ...base,
        body: { _tag: method, packageId },
      });
      assert.strictEqual(parsed.body._tag, method);
    }

    const invalidPackageId = yield* Effect.exit(
      decode(WebSocketRequest, {
        ...base,
        body: { _tag: WS_METHODS.serverRemoveSkillPackage, packageId: "../package" },
      }),
    );
    assert.strictEqual(invalidPackageId._tag, "Failure");
  }),
);

it.effect("bounds MCP transport settings and restricts source references to metadata", () =>
  Effect.gen(function* () {
    const valid = yield* decode(WebSocketRequest, {
      id: "req-mcp-transport-source",
      body: {
        _tag: WS_METHODS.serverSaveExpertConnection,
        id: "source-aware",
        name: "Source aware",
        transport: {
          type: "stdio",
          command: "fixture-mcp",
          args: [],
          envFromHost: [],
          cwd: "/tmp",
          startupTimeoutMs: 300_000,
          toolTimeoutMs: 1,
          envFromSource: {
            source: { kind: "json", path: "/tmp/mcp.json", entryId: "search" },
            names: ["API_TOKEN"],
          },
        },
      },
    });
    assert.strictEqual(valid.body._tag, WS_METHODS.serverSaveExpertConnection);

    const validHttp = yield* decode(WebSocketRequest, {
      id: "req-mcp-http-source",
      body: {
        _tag: WS_METHODS.serverSaveExpertConnection,
        id: "source-aware-http",
        name: "Source aware HTTP",
        transport: {
          type: "http",
          url: "https://mcp.example.test/mcp",
          headersFromHost: [],
          headersFromSource: {
            source: { kind: "json", path: "/tmp/mcp.json", entryId: "search" },
            names: ["Authorization"],
          },
        },
      },
    });
    assert.strictEqual(validHttp.body._tag, WS_METHODS.serverSaveExpertConnection);

    const managedSecretRefs = yield* decode(WebSocketRequest, {
      id: "req-mcp-managed-secret-refs",
      body: {
        _tag: WS_METHODS.serverSaveExpertConnection,
        id: "managed-secret",
        name: "Managed secret",
        importedFrom: [{ kind: "json", path: "/tmp/mcp.json", entryId: "servers:fixture" }],
        transport: {
          type: "stdio",
          command: "fixture-mcp",
          args: [],
          envFromHost: [],
          envFromSecret: {
            credentialId: "01234567-89ab-cdef-0123-456789abcdef",
            names: ["API_TOKEN"],
          },
        },
      },
    });
    assert.strictEqual(managedSecretRefs.body._tag, WS_METHODS.serverSaveExpertConnection);

    const managedHttpSecretRef = yield* decode(WebSocketRequest, {
      id: "req-mcp-managed-http-secret-ref",
      body: {
        _tag: WS_METHODS.serverSaveExpertConnection,
        id: "managed-http-secret",
        name: "Managed HTTP secret",
        transport: {
          type: "http",
          url: "https://mcp.example.test/mcp",
          headersFromHost: [],
          headersFromSecret: {
            credentialId: "fedcba98-7654-3210-fedc-ba9876543210",
            names: ["Authorization"],
          },
        },
      },
    });
    assert.strictEqual(managedHttpSecretRef.body._tag, WS_METHODS.serverSaveExpertConnection);

    const invalidCredentialId = yield* Effect.exit(
      decode(WebSocketRequest, {
        id: "req-mcp-managed-secret-invalid-id",
        body: {
          _tag: WS_METHODS.serverSaveExpertConnection,
          id: "managed-secret",
          name: "Managed secret",
          transport: {
            type: "stdio",
            command: "fixture-mcp",
            args: [],
            envFromHost: [],
            envFromSecret: { credentialId: "mcp-01234567", names: ["API_TOKEN"] },
          },
        },
      }),
    );
    assert.strictEqual(invalidCredentialId._tag, "Failure");

    const plaintextCredential = yield* Effect.exit(
      decode(WebSocketRequest, {
        id: "req-mcp-managed-secret-plaintext",
        body: {
          _tag: WS_METHODS.serverSaveExpertConnection,
          id: "managed-secret",
          name: "Managed secret",
          transport: {
            type: "stdio",
            command: "fixture-mcp",
            args: [],
            envFromHost: [],
            env: { API_TOKEN: "plaintext-secret-value" },
          },
        },
      }),
    );
    assert.strictEqual(plaintextCredential._tag, "Failure");

    const overTimeout = yield* Effect.exit(
      decode(WebSocketRequest, {
        id: "req-mcp-transport-over-timeout",
        body: {
          _tag: WS_METHODS.serverSaveExpertConnection,
          id: "source-aware",
          name: "Source aware",
          transport: {
            type: "stdio",
            command: "fixture-mcp",
            args: [],
            envFromHost: [],
            toolTimeoutMs: 300_001,
          },
        },
      }),
    );
    assert.strictEqual(overTimeout._tag, "Failure");

    const secretValue = yield* Effect.exit(
      decode(WebSocketRequest, {
        id: "req-mcp-transport-no-source-secret",
        body: {
          _tag: WS_METHODS.serverSaveExpertConnection,
          id: "source-aware",
          name: "Source aware",
          transport: {
            type: "stdio",
            command: "fixture-mcp",
            args: [],
            envFromHost: [],
            envFromSource: {
              source: {
                kind: "json",
                path: "/tmp/mcp.json",
                entryId: "search",
                token: "plaintext-must-not-be-persisted",
              },
              names: ["API_TOKEN"],
            },
          },
        },
      }),
    );
    assert.strictEqual(secretValue._tag, "Failure");

    const nulTransportPaths = yield* Effect.exit(
      decode(WebSocketRequest, {
        id: "req-mcp-transport-nul-paths",
        body: {
          _tag: WS_METHODS.serverSaveExpertConnection,
          id: "source-aware",
          name: "Source aware",
          transport: {
            type: "stdio",
            command: "fixture-mcp",
            args: [],
            envFromHost: [],
            cwd: "/repo\0bad",
            envFromSource: {
              source: { kind: "json", path: "/tmp/\0mcp.json", entryId: "search" },
              names: ["API_TOKEN"],
            },
          },
        },
      }),
    );
    assert.strictEqual(nulTransportPaths._tag, "Failure");
  }),
);

it.effect("validates discovery provenance without accepting secret values", () =>
  Effect.gen(function* () {
    const valid = yield* decode(McpDiscoveryResultSchema, {
      scanId: "scan-provenance",
      sources: [],
      candidates: [
        {
          candidateId: "candidate-1",
          sourceKind: "json",
          sourcePath: "/tmp/mcp.json",
          sourceEntryId: "servers:fixture",
          sources: [
            { kind: "json", path: "/tmp/mcp.json", entryId: "servers:fixture" },
            { kind: "json", path: "/tmp/other.json", entryId: "mcpServers:fixture" },
          ],
          suggestedId: "mcp_fixture",
          name: "Fixture",
          protocol: "stdio",
          summary: "node fixture",
          status: "ready",
          issues: [],
        },
      ],
    });
    assert.strictEqual(valid.candidates[0]?.sources?.length, 2);

    const secretValue = yield* Effect.exit(
      decode(McpDiscoveryResultSchema, {
        scanId: "scan-provenance-secret",
        sources: [],
        candidates: [
          {
            candidateId: "candidate-1",
            sourceKind: "json",
            sourcePath: "/tmp/mcp.json",
            sourceEntryId: "servers:fixture",
            sources: [
              {
                kind: "json",
                path: "/tmp/mcp.json",
                entryId: "servers:fixture",
                token: "plaintext-secret-value",
              },
            ],
            suggestedId: "mcp_fixture",
            name: "Fixture",
            protocol: "stdio",
            summary: "node fixture",
            status: "ready",
            issues: [],
          },
        ],
      }),
    );
    assert.strictEqual(secretValue._tag, "Failure");
  }),
);

it.effect("accepts legacy and revision-guarded expert connection test requests", () =>
  Effect.gen(function* () {
    const legacy = yield* decode(WebSocketRequest, {
      id: "req-test-expert-legacy",
      body: { _tag: WS_METHODS.serverTestExpertConnection, id: "research" },
    });
    assert.strictEqual(legacy.body._tag, WS_METHODS.serverTestExpertConnection);

    const guarded = yield* decode(WebSocketRequest, {
      id: "req-test-expert-guarded",
      body: {
        _tag: WS_METHODS.serverTestExpertConnection,
        id: "research",
        expectedRevision: 4,
      },
    });
    assert.strictEqual(guarded.body._tag, WS_METHODS.serverTestExpertConnection);
    if (guarded.body._tag === WS_METHODS.serverTestExpertConnection) {
      assert.strictEqual(guarded.body.expectedRevision, 4);
    }

    const invalid = yield* Effect.exit(
      decode(WebSocketRequest, {
        id: "req-test-expert-invalid",
        body: {
          _tag: WS_METHODS.serverTestExpertConnection,
          id: "research",
          expectedRevision: 0,
        },
      }),
    );
    assert.strictEqual(invalid._tag, "Failure");
  }),
);

it.effect("validates expert connection state and references RPC request payloads", () =>
  Effect.gen(function* () {
    const state = yield* decode(WebSocketRequest, {
      id: "req-connection-state",
      body: { _tag: WS_METHODS.serverGetExpertConnectionState, id: "research" },
    });
    assert.strictEqual(state.body._tag, WS_METHODS.serverGetExpertConnectionState);

    const update = yield* decode(WebSocketRequest, {
      id: "req-connection-state-update",
      body: {
        _tag: WS_METHODS.serverSetExpertConnectionState,
        id: "research",
        status: "disabled",
        expectedRevision: 3,
      },
    });
    assert.strictEqual(update.body._tag, WS_METHODS.serverSetExpertConnectionState);

    const references = yield* decode(WebSocketRequest, {
      id: "req-connection-references",
      body: { _tag: WS_METHODS.serverReadExpertConnectionReferences, id: "research" },
    });
    assert.strictEqual(references.body._tag, WS_METHODS.serverReadExpertConnectionReferences);

    const invalid = yield* Effect.exit(
      decode(WebSocketRequest, {
        id: "req-connection-state-invalid",
        body: {
          _tag: WS_METHODS.serverSetExpertConnectionState,
          id: "research",
          status: "disabled",
          expectedRevision: 0,
        },
      }),
    );
    assert.strictEqual(invalid._tag, "Failure");
  }),
);

it.effect("accepts typed websocket push envelopes with sequence", () =>
  Effect.gen(function* () {
    const parsed = yield* decode(WsResponse, {
      type: "push",
      sequence: 1,
      channel: WS_CHANNELS.serverWelcome,
      data: {
        cwd: "/tmp/workspace",
        projectName: "workspace",
      },
    });

    if (!("type" in parsed) || parsed.type !== "push") {
      assert.fail("expected websocket response to decode as a push envelope");
    }

    assert.strictEqual(parsed.type, "push");
    assert.strictEqual(parsed.sequence, 1);
    assert.strictEqual(parsed.channel, WS_CHANNELS.serverWelcome);
  }),
);

it.effect("accepts server.keepAwakeUpdated push envelopes", () =>
  Effect.gen(function* () {
    const parsed = yield* decode(WsResponse, {
      type: "push",
      sequence: 4,
      channel: WS_CHANNELS.serverKeepAwakeUpdated,
      data: {
        keepAwake: { available: true, mode: "agent", active: false, error: null },
      },
    });

    if (!("type" in parsed) || parsed.type !== "push") {
      assert.fail("expected websocket response to decode as a push envelope");
    }

    assert.strictEqual(parsed.channel, WS_CHANNELS.serverKeepAwakeUpdated);
    if (parsed.channel === WS_CHANNELS.serverKeepAwakeUpdated) {
      assert.strictEqual(parsed.data.keepAwake.mode, "agent");
    }
  }),
);

it.effect("rejects push envelopes when channel payload does not match the channel schema", () =>
  Effect.gen(function* () {
    const result = yield* Effect.exit(
      decode(WsResponse, {
        type: "push",
        sequence: 2,
        channel: ORCHESTRATION_WS_CHANNELS.domainEvent,
        data: {
          cwd: "/tmp/workspace",
          projectName: "workspace",
        },
      }),
    );

    assert.strictEqual(result._tag, "Failure");
  }),
);
