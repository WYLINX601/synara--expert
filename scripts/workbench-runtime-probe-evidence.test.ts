import { describe, expect, it } from "vitest";

import {
  hasExpectedMcpToolActivity,
  type ProbeToolActivity,
} from "./lib/workbench-runtime-probe-evidence.ts";

const TURN_ID = "turn-current";
const ALIAS = "expert_wb_probe_workbench_probe_echo";

function codexActivity(
  kind: string,
  tool: string,
  turnId: string | null = TURN_ID,
  itemType = "mcp_tool_call",
): ProbeToolActivity {
  return {
    kind,
    turnId,
    payload: {
      itemType,
      // CodexAdapter maps ProviderEvent.payload through as runtime payload.data;
      // this mirrors CodexAdapter.test.ts's nested item:{type:"mcpToolCall", tool} event.
      data: { item: { type: "mcpToolCall", tool } },
    },
  };
}

function piActivity(
  kind: string,
  toolName: string,
  turnId: string | null = TURN_ID,
  itemType = "dynamic_tool_call",
): ProbeToolActivity {
  return {
    kind,
    turnId,
    payload: {
      itemType,
      // PiAdapter lifecycle output carries toolName in toolLifecycleData.
      data: { toolCallId: "pi-tool-echo", toolName, name: toolName, tool: toolName },
    },
  };
}

describe("workbench runtime probe MCP evidence", () => {
  it.each([
    ["codex", "tool.started", () => codexActivity("tool.started", ALIAS)],
    ["codex", "tool.completed", () => codexActivity("tool.completed", ALIAS)],
    ["pi", "tool.started", () => piActivity("tool.started", ALIAS)],
    ["pi", "tool.completed", () => piActivity("tool.completed", ALIAS)],
  ] as const)("accepts the actual %s %s echo lifecycle identity", (provider, _kind, fixture) => {
    expect(hasExpectedMcpToolActivity([fixture()], ALIAS, provider, TURN_ID)).toBe(true);
  });

  it("accepts canonical updates and only the supported Codex progress-name fallback", () => {
    const piUpdate = piActivity("tool.updated", ALIAS);
    const codexProgressUpdate: ProbeToolActivity = {
      kind: "tool.updated",
      turnId: TURN_ID,
      payload: { itemType: "mcp_tool_call", data: { toolName: `mcp__expert__${ALIAS}` } },
    };
    expect(hasExpectedMcpToolActivity([piUpdate], ALIAS, "pi", TURN_ID)).toBe(true);
    expect(hasExpectedMcpToolActivity([codexProgressUpdate], ALIAS, "codex", TURN_ID)).toBe(true);
  });

  it("accepts a precisely qualified Codex gateway alias", () => {
    expect(
      hasExpectedMcpToolActivity(
        [codexActivity("tool.started", `mcp__expert_server__${ALIAS}`)],
        ALIAS,
        "codex",
        TURN_ID,
      ),
    ).toBe(true);
  });

  it("rejects wrong aliases, item types, lifecycle kinds, and stale turns", () => {
    const candidates = [
      codexActivity("tool.started", `${ALIAS}-other`),
      codexActivity("tool.started", ALIAS, TURN_ID, "dynamic_tool_call"),
      codexActivity("assistant.message", ALIAS),
      codexActivity("tool.completed", ALIAS, "turn-previous"),
      codexActivity("tool.completed", ALIAS, null),
      {
        ...codexActivity("tool.updated", "other-tool"),
        summary: ALIAS,
        payload: {
          itemType: "mcp_tool_call",
          title: ALIAS,
          data: { item: { type: "mcpToolCall", tool: "other-tool" }, toolName: ALIAS },
        },
      },
    ];
    expect(hasExpectedMcpToolActivity(candidates, ALIAS, "codex", TURN_ID)).toBe(false);
    expect(
      hasExpectedMcpToolActivity(
        [piActivity("tool.started", ALIAS, TURN_ID, "mcp_tool_call")],
        ALIAS,
        "pi",
        TURN_ID,
      ),
    ).toBe(false);
    expect(
      hasExpectedMcpToolActivity(
        [piActivity("tool.started", `mcp__expert__${ALIAS}`)],
        ALIAS,
        "pi",
        TURN_ID,
      ),
    ).toBe(false);
    expect(
      hasExpectedMcpToolActivity(
        [codexActivity("tool.started", `not-mcp__expert__${ALIAS}`)],
        ALIAS,
        "codex",
        TURN_ID,
      ),
    ).toBe(false);
  });
});
