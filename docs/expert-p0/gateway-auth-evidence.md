# Gateway session-scoped tool authorization evidence

后续已完成两端真实模型经 Gateway 到本地 MCP 子进程的验证；最新结论见 [完整链路证据](./full-chain-evidence.md)。以下记录只描述本文件对应的授权边界测试。

Date: 2026-09-25. This is a local Gateway transport test with fixture threads and a fixture tool; it does not invoke Codex or Pi, nor a third-party MCP server.

## Implemented authorization boundary

Every Expert `ToolEntry` must set `sessionScoped: true` to require an exact session-specific grant. In `makeAgentGatewayMcpTransport`, `tools/list` filters those entries and `tools/call` checks the same authorizer after the existing active-turn check and before capability dispatch. If a scoped tool has no authorizer configured, both listing and direct calls fail closed. Ordinary tools keep their existing capability behavior and do not invoke the session-scoped callback. An unauthorized live caller receives the same `-32602` `Unknown tool` response as an unknown name.

The callback receives only `sessionKey`, `threadId`, and `provider` from the transport context constructed after bearer verification, live-thread lookup, and provider ownership validation. It does not receive tool arguments. In the test, A sends B's Expert ID and thread ID in the tool arguments; authorization and the fixture's simulated connection lookup still resolve to A's verified session and A's thread. The test callback uses a strict `Map<sessionKey, allowed tool names>` for the `expert_fixture_search` entry.

## Exercised behavior

The test runs JSON-RPC `tools/list` and `tools/call` over a local `node:http` server bound to `127.0.0.1` on an ephemeral port. Each request carries a Bearer token and is passed to the actual `makeAgentGatewayMcpTransport` implementation:

- A lists the fixture Expert tool and invokes it; the fixture handler records the verified session and thread.
- B does not see the Expert tool; a direct call returns the unknown-tool error and the handler call count does not change.
- A's now-completed turn is rejected before the tool handler runs.
- Revoking A's token causes both list and call requests to return 401 without running the handler.
- A scoped tool with no configured authorizer is absent from the list and direct calls receive the unknown-tool error. An ordinary Synara fixture tool remains listed alongside authorized Expert tools.

This local HTTP wrapper calls the production transport function, but does not mount the production HTTP route. Existing Gateway route and lifecycle tests were included in the separate full Gateway test run. No model request was sent through Codex or Pi, and the fixture handler is not a downstream MCP client or live external connection.

## Verification

Environment: Bun 1.4.0, Node v22.23.1.

```sh
bun run --cwd apps/server test src/agentGateway/mcpTransport.test.ts
bun run --cwd apps/server test src/agentGateway
bun run --cwd apps/server typecheck
bun run fmt:check -- apps/server/src/agentGateway/mcpTransport.ts apps/server/src/agentGateway/mcpTransport.test.ts apps/server/src/agentGateway/toolRuntime.ts
bun run lint -- apps/server/src/agentGateway/mcpTransport.ts apps/server/src/agentGateway/mcpTransport.test.ts apps/server/src/agentGateway/toolRuntime.ts
git diff --check
```

The final Gateway run passed 34 files and 810 tests. Server typecheck, formatting, and `git diff --check` passed. Focused lint exited successfully with two warnings in pre-existing transport code (`unregister` function scoping and schema-map spread); neither warning points to the new authorization code.

The precise production integration seam is the optional `authorizeTool` passed by the AgentGateway layer into `makeAgentGatewayMcpTransport`; this task does not wire a provider because there is no Expert snapshot service yet. Until one is available, marked tools stay fail-closed. Code boundary: [mcpTransport.ts](../../apps/server/src/agentGateway/mcpTransport.ts#L123), [toolRuntime.ts](../../apps/server/src/agentGateway/toolRuntime.ts#L66). The HTTP integration and fail-closed tests are in [mcpTransport.test.ts](../../apps/server/src/agentGateway/mcpTransport.test.ts#L692).
