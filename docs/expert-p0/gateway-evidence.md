# Gateway P0 evidence

后续已完成 Gateway 授权与两端真实模型穿越本地 MCP 的验证；最新结论见 [完整链路证据](./full-chain-evidence.md)。以下记录保留最初独立协议探针的当时结果与边界。

Date: 2026-09-25. This is a bounded source and protocol probe, not an Expert implementation or real-provider test.

## What was exercised

An isolated fixture using the official MCP SDK 1.29.0 completed `tools/list` and `tools/call` over stdio and Streamable HTTP. Both paths observed cancellation in the server tool handler. The stdio client closed its child process; the HTTP client terminated its server session. The fixture also returned text, image, `structuredContent`, and `isError` results. HTTP used a local-only `Bearer probe-only` header and an ephemeral `127.0.0.1` port. No Synara token, provider configuration, or external MCP server was used.

The fixture proves the SDK can provide the protocol client and lifecycle mechanics for the planned boundary. It does not prove Synara's gateway will authorize an external call correctly; the fixture has no per-expert policy and is not wired to the production gateway.

The existing relevant server tests passed: 5 files, 69 tests. They cover gateway catalog projection, session capability filtering, request cancellation, session revocation / replacement, and Pi's gateway-call cancellation. They use mocks or in-process gateway layers; they do not cover expert-specific tool grants or a live third-party server.

## Current request and identity path

1. Provider adapters obtain an `AgentGatewaySessionLease`; `AgentGatewayCredentials` issues a unique bearer whose registry identity contains `sessionKey`, `threadId`, provider, issue time, and capabilities. Revocation removes that identity and cancels requests indexed to its session. See [AgentGatewayCredentials.ts](../../apps/server/src/agentGateway/Layers/AgentGatewayCredentials.ts#L80), [AgentGatewaySessionRegistry.ts](../../apps/server/src/agentGateway/Layers/AgentGatewaySessionRegistry.ts#L40), and the contract in [AgentGatewaySessionRegistry.ts](../../apps/server/src/agentGateway/Services/AgentGatewaySessionRegistry.ts#L17).
2. `makeAgentGatewayMcpTransport` resolves the bearer with `verifySession`, checks that the thread still exists and that the live provider matches, then constructs caller context from that verified identity. The client does not supply the authorized thread identity in tool arguments. See [mcpTransport.ts](../../apps/server/src/agentGateway/mcpTransport.ts#L268).
3. The gateway builds one process-level `ToolEntry[]` and passes it to the transport. The transport creates one name map from that catalog. `tools/list` filters by the identity's coarse capabilities; `tools/call` finds the tool by name and repeats the capability / active-turn checks before invoking it. See [AgentGateway.ts](../../apps/server/src/agentGateway/Layers/AgentGateway.ts#L1180), [mcpTransport.ts](../../apps/server/src/agentGateway/mcpTransport.ts#L124), and [mcpTransport.ts](../../apps/server/src/agentGateway/mcpTransport.ts#L151).
4. Pi already projects the gateway catalog into native custom tools: it calls the canonical `tools/list`, then forwards each execution to `tools/call`. Its existing result adapter retains text and image blocks, puts the full successful result in `details`, and converts `isError` into a thrown `Error` using text blocks (or a generic message). It drops other content block types from `content`; structured fields remain only inside `details`. See [PiAdapter.ts](../../apps/server/src/provider/Layers/PiAdapter.ts#L484) and [PiAdapter.ts](../../apps/server/src/provider/Layers/PiAdapter.ts#L541).

`mcpInjection.ts` is the opposite direction: it builds provider configs for Synara's own gateway, and its native-tool helper sends simple JSON-RPC HTTP requests to that gateway. It is not a general downstream MCP client. The server package does not declare `@modelcontextprotocol/sdk` directly; version 1.29.0 appears in `bun.lock` as a transitive package.

## Authorization seam

Put per-expert visibility and enforcement in `makeAgentGatewayMcpTransport`, after bearer verification and live thread/provider validation. Feed that point a session-bound expert snapshot or normalized allowed-tool set; apply the same rule to both `tools/list` and `tools/call`. Keep Pi as a projection of the filtered gateway list. Filtering only in Pi can be bypassed by a direct `tools/call`, and adding tools only to the process-level `AgentGateway.ts` catalog would make them global because the current dispatch map is shared across sessions.

The current registry has no expert binding or per-tool allowlist. Its capabilities grant broad categories such as `thread:read` and `browser:control`; those are not a substitute for an expert's exact connection/tool permissions. There is also no downstream client or per-provider-session external-connection lifecycle. Future integration should bind downstream connections and the resolved allowlist to the verified provider-session lease, then revoke/cancel/close them with that lease. Do not trust an `expertId`, `threadId`, or connection identifier passed as tool arguments to select authority.

## Result mapping and coverage gaps

The isolated SDK probe confirmed that the protocol client receives text, image, structured output, and `isError` from a fixture. Source inspection shows the Pi adapter currently maps text/image into `content`, retains successful raw output in `details`, and throws for `isError`; existing Pi tests exercise text and cancellation but not structured, image, or error results. If external MCP tools need all result forms to reach the model consistently, extend and test `piGatewayToolResult` at this single provider boundary.

No existing test grants Expert A a tool and proves Expert B cannot list or call it. There is no live Codex/Pi invocation of a third-party service, no OAuth validation, and no proof of packaging or provider-specific shutdown. Those remain P0/P2 validation work.

## Commands and versions

Workspace tests:

```sh
bun run --cwd apps/server test src/agentGateway/mcpTransport.test.ts src/agentGateway/mcpInjection.test.ts src/agentGateway/Layers/AgentGatewaySessionRegistry.test.ts src/agentGateway/Layers/AgentGatewayCredentials.test.ts src/provider/Layers/PiAdapter.test.ts
```

Result: 5 files passed, 69 tests passed.

To reproduce the SDK probe without changing workspace dependencies or lockfiles, install into a fresh temporary prefix and run the fixture before removing that directory:

```sh
P0_MCP_TMP="$(mktemp -d)"
npm --prefix "$P0_MCP_TMP" install --no-save --ignore-scripts --no-audit --no-fund @modelcontextprotocol/sdk@1.29.0
MCP_SDK_ROOT="$P0_MCP_TMP" node scripts/expert-p0/gateway-probe.mjs
rm -rf "$P0_MCP_TMP"
```

```text
MCP SDK 1.29.0
stdio list/call/text+image+structured/error/cancel/child-close passed
Streamable HTTP auth header/list/call/text+image+structured/error/cancel/session-delete passed
```

The run used Bun 1.4.0 and Node v22.23.1. `node --check scripts/expert-p0/gateway-probe.mjs` passed. The probe is a standalone local fixture and makes no external service calls.
