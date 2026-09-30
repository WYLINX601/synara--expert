export type ProbeToolActivity = {
  readonly kind: string;
  readonly payload: unknown;
  readonly turnId: string | null;
};

export type ProbeToolProvider = "codex" | "pi";

const TOOL_ACTIVITY_KINDS = new Set(["tool.started", "tool.updated", "tool.completed"]);

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function matchesCodexToolName(value: unknown, expectedAlias: string): boolean {
  if (typeof value !== "string") return false;
  if (value === expectedAlias) return true;
  if (!value.startsWith("mcp__")) return false;
  const serverEnd = value.indexOf("__", "mcp__".length);
  return serverEnd > "mcp__".length && value.slice(serverEnd + 2) === expectedAlias;
}

export function hasExpectedMcpToolActivity(
  activities: ReadonlyArray<ProbeToolActivity>,
  expectedAlias: string,
  provider: ProbeToolProvider,
  expectedTurnId: string,
): boolean {
  if (!expectedAlias || !expectedTurnId) return false;
  const expectedItemType = provider === "codex" ? "mcp_tool_call" : "dynamic_tool_call";

  return activities.some((activity) => {
    if (!TOOL_ACTIVITY_KINDS.has(activity.kind) || activity.turnId !== expectedTurnId) return false;

    const payload = record(activity.payload);
    if (!payload || payload.itemType !== expectedItemType) return false;
    const data = record(payload.data);
    if (!data) return false;

    if (provider === "pi") return data.toolName === expectedAlias;

    const item = record(data.item);
    if (item) return matchesCodexToolName(item.tool, expectedAlias);
    // Codex MCP progress events project directly to tool.updated with data.toolName.
    return activity.kind === "tool.updated" && matchesCodexToolName(data.toolName, expectedAlias);
  });
}
