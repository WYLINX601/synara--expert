import { describe, expect, it } from "vitest";

import {
  canContinueAfterProbeApproval,
  hasExpectedMcpToolActivity,
  inspectProbeApproval,
  probeApprovalCompletionFailure,
  probeApprovalResponseKey,
  respondToProbeApprovalOnce,
  trackProbeApprovalSettlement,
  waitForFixtureWaitStart,
  type ProbeApprovalDecision,
  type ProbeApprovalScope,
  type ProbeToolActivity,
} from "./lib/workbench-runtime-probe-evidence.ts";

const TURN_ID = "turn-current";
const ALIAS = "expert_wb_probe_workbench_probe_echo";
const CONNECTION_ID = "wb_probe_0123456789abcdefabcd";
const ECHO_ALIAS = `expert_${CONNECTION_ID}_workbench_probe_echo`;
const WAIT_ALIAS = `expert_${CONNECTION_ID}_workbench_probe_wait`;
const NONCE = "nonce-for-one-authorized-fixture-call";
const THREAD_ID = "thread-own";
const OWN_TURN_ID = "turn-own";
const USER_MESSAGE_ID = "message-own";
const LIFECYCLE = "lifecycle-own";
const REQUEST_ID = "request-own";

function approvalScope(
  input: {
    provider?: "codex" | "pi";
    tool?: "echo" | "wait";
    value?: string;
    threadId?: string;
    turnId?: string;
    userMessageId?: string;
    userMessageText?: string;
  } = {},
): ProbeApprovalScope {
  const tool = input.tool ?? "echo";
  const alias = tool === "echo" ? ECHO_ALIAS : WAIT_ALIAS;
  const userMessageText =
    input.userMessageText ??
    (tool === "echo"
      ? `Use the configured MCP tool named ${alias} exactly once with the JSON input ${JSON.stringify({ value: input.value ?? NONCE })}.`
      : `Call the configured MCP tool named ${alias} exactly once.`);
  return {
    provider: input.provider ?? "codex",
    threadId: input.threadId ?? THREAD_ID,
    turnId: input.turnId ?? OWN_TURN_ID,
    userMessageId: input.userMessageId ?? USER_MESSAGE_ID,
    userMessageText,
    fixture: {
      connectionId: CONNECTION_ID,
      expertBinding: { expertId: "expert-own", snapshotId: "snapshot-own", revision: 4 },
      tool,
      ...(tool === "echo" ? { value: input.value ?? NONCE } : {}),
    },
  };
}

function approvalThread(
  scope = approvalScope(),
  input: {
    requestId?: string;
    lifecycleGeneration?: string;
    interactionThreadId?: string;
    interactionTurnId?: string | null;
    interactionLifecycleGeneration?: string | null;
    status?: string;
    decision?: string | null;
    payload?: Record<string, unknown>;
    activities?: ProbeToolActivity[];
    pendingInteractions?: ProbeApprovalThreadFixture[];
    latestTurnId?: string;
    latestTurnState?: string;
    sessionThreadId?: string;
    providerName?: string | null;
    activeTurnId?: string | null;
    binding?: { expertId: string; snapshotId: string; revision: number } | null;
  } = {},
) {
  const requestId = input.requestId ?? REQUEST_ID;
  const lifecycleGeneration = input.lifecycleGeneration ?? LIFECYCLE;
  const requestActivity: ProbeToolActivity = {
    kind: "approval.requested",
    turnId: scope.turnId,
    payload: {
      requestId,
      lifecycleGeneration,
      requestKind: "tool",
      requestType: "tool_approval",
      detail: `Allow the synara MCP server to run tool "${scope.fixture?.tool === "wait" ? WAIT_ALIAS : ECHO_ALIAS}"?`,
      toolParamsDisplay:
        scope.fixture?.tool === "wait"
          ? []
          : [{ display_name: "value", name: "value", value: scope.fixture?.value ?? NONCE }],
      ...input.payload,
    },
  };
  const row: ProbeApprovalThreadFixture = {
    interactionKind: "approval",
    requestId,
    threadId: input.interactionThreadId ?? scope.threadId,
    turnId: input.interactionTurnId === undefined ? scope.turnId : input.interactionTurnId,
    lifecycleGeneration:
      input.interactionLifecycleGeneration === undefined
        ? lifecycleGeneration
        : input.interactionLifecycleGeneration,
    status: input.status ?? "pending",
    decision: input.decision ?? null,
  };
  return {
    id: scope.threadId,
    latestTurn: {
      turnId: input.latestTurnId ?? scope.turnId,
      state: input.latestTurnState ?? "running",
    },
    session: {
      threadId: input.sessionThreadId ?? scope.threadId,
      providerName: input.providerName ?? scope.provider,
      activeTurnId: input.activeTurnId === undefined ? scope.turnId : input.activeTurnId,
    },
    expertBinding:
      input.binding === undefined ? (scope.fixture?.expertBinding ?? null) : input.binding,
    messages: [
      {
        id: scope.userMessageId,
        role: "user",
        text: scope.userMessageText,
      },
    ],
    activities: input.activities ?? [requestActivity],
    pendingInteractions: input.pendingInteractions ?? [row],
  };
}

type ProbeApprovalThreadFixture = {
  interactionKind: string;
  requestId: string;
  threadId: string;
  turnId: string | null;
  lifecycleGeneration: string | null;
  status: string;
  decision: string | null;
};

describe("workbench runtime probe approval evidence", () => {
  it("accepts only the exact Codex fixture echo request bound to this connection and prompt nonce", () => {
    const scope = approvalScope();
    expect(inspectProbeApproval(approvalThread(scope), scope, new Map())).toMatchObject({
      kind: "respond",
      requestId: REQUEST_ID,
      lifecycleGeneration: LIFECYCLE,
      decision: "accept",
      fixtureConnectionBound: true,
    });
  });

  it.each([
    ["wrong nonce", { payload: { toolParamsDisplay: [{ name: "value", value: "other" }] } }],
    [
      "extra argument key",
      { payload: { toolParamsDisplay: [{ name: "value", value: NONCE, extra: true }] } },
    ],
    [
      "truncated argument",
      { payload: { toolParamsDisplay: [{ name: "value", value: "[truncated]" }] } },
    ],
    [
      "wrong alias",
      { payload: { detail: 'Allow the synara MCP server to run tool "other_tool"?' } },
    ],
    [
      "alias from another connection",
      { payload: { toolName: "expert_wb_probe_ffeeddccbbaa99887766_workbench_probe_echo" } },
    ],
    [
      "wrong request kind",
      { payload: { requestKind: "command", requestType: "command_execution_approval" } },
    ],
  ] as const)("declines %s rather than granting a broader approval", (_label, overrides) => {
    const scope = approvalScope();
    expect(inspectProbeApproval(approvalThread(scope, overrides), scope, new Map())).toMatchObject({
      kind: "respond",
      decision: "decline",
    });
  });

  it("requires the complete fixed Codex detail when the structured tool alias is omitted", () => {
    const scope = approvalScope();
    const truncated = approvalThread(scope, {
      payload: { detail: `Allow the synara MCP server to run tool "${ECHO_ALIAS}"?...` },
    });
    expect(inspectProbeApproval(truncated, scope, new Map())).toMatchObject({
      kind: "respond",
      decision: "decline",
      reasonCode: "fixture-tool-alias-mismatch",
    });
  });

  it("declines Pi approvals because their product approval payload is not verified", () => {
    const scope = approvalScope({ provider: "pi" });
    expect(inspectProbeApproval(approvalThread(scope), scope, new Map())).toMatchObject({
      kind: "respond",
      decision: "decline",
      reasonCode: "provider-approval-shape-unverified",
    });
  });

  it.each([
    ["another turn", { interactionTurnId: "turn-other" }],
    ["another lifecycle", { interactionLifecycleGeneration: "lifecycle-other" }],
    ["another session", { sessionThreadId: "thread-other" }],
    ["a superseded current turn", { latestTurnId: "turn-newer" }],
  ] as const)("fails closed for an approval from %s", (_label, overrides) => {
    const scope = approvalScope();
    expect(inspectProbeApproval(approvalThread(scope, overrides), scope, new Map())).toMatchObject({
      kind: "failure",
    });
  });

  it("declines approvals on ordinary threads and user-input requests", () => {
    const baseScope = approvalScope();
    const scope: ProbeApprovalScope = {
      provider: baseScope.provider,
      threadId: baseScope.threadId,
      turnId: baseScope.turnId,
      userMessageId: baseScope.userMessageId,
      userMessageText: baseScope.userMessageText,
    };
    expect(
      inspectProbeApproval(approvalThread(scope, { binding: null }), scope, new Map()),
    ).toMatchObject({
      kind: "respond",
      decision: "decline",
      reasonCode: "fixture-approval-not-authorized",
    });
    const userInput = approvalThread(scope, {
      binding: null,
      pendingInteractions: [
        {
          interactionKind: "userInput",
          requestId: REQUEST_ID,
          threadId: THREAD_ID,
          turnId: OWN_TURN_ID,
          lifecycleGeneration: LIFECYCLE,
          status: "pending",
          decision: null,
        },
      ],
    });
    expect(inspectProbeApproval(userInput, scope, new Map())).toMatchObject({
      kind: "failure",
      reasonCode: "unexpected-pending-user-input",
    });
  });

  it("accepts the wait tool only when the product shows an explicit empty argument list", () => {
    const scope = approvalScope({ tool: "wait" });
    expect(inspectProbeApproval(approvalThread(scope), scope, new Map())).toMatchObject({
      kind: "respond",
      decision: "accept",
    });
    const missingDisplay = approvalThread(scope, {
      payload: { toolParamsDisplay: undefined },
    });
    expect(inspectProbeApproval(missingDisplay, scope, new Map())).toMatchObject({
      kind: "respond",
      decision: "decline",
      reasonCode: "fixture-tool-arguments-mismatch",
    });
  });

  it("responds at most once to a repeated pending snapshot and scopes deduplication by thread and turn", async () => {
    const scope = approvalScope();
    const first = approvalThread(scope);
    const sent = new Map<string, ProbeApprovalDecision>();
    const inspection = inspectProbeApproval(first, scope, sent);
    expect(inspection.kind).toBe("respond");
    if (inspection.kind !== "respond") return;
    const response = {
      threadId: scope.threadId,
      turnId: scope.turnId,
      requestId: inspection.requestId,
      lifecycleGeneration: inspection.lifecycleGeneration,
      decision: inspection.decision,
    } as const;
    let sends = 0;
    expect(
      await respondToProbeApprovalOnce(response, sent, async () => {
        sends += 1;
      }),
    ).toBe(true);
    expect(inspectProbeApproval(first, scope, sent)).toEqual({
      kind: "wait",
      requestId: REQUEST_ID,
      lifecycleGeneration: LIFECYCLE,
    });
    const responding = approvalThread(scope, { status: "responding" });
    expect(inspectProbeApproval(responding, scope, sent)).toEqual({
      kind: "wait",
      requestId: REQUEST_ID,
      lifecycleGeneration: LIFECYCLE,
    });
    expect(
      await respondToProbeApprovalOnce(response, sent, async () => {
        sends += 1;
      }),
    ).toBe(false);
    expect(sends).toBe(1);

    const sameRequestDifferentTurn = probeApprovalResponseKey({
      ...response,
      turnId: "turn-next",
    });
    const sameRequestDifferentThread = probeApprovalResponseKey({
      ...response,
      threadId: "thread-next",
    });
    const sameRequestDifferentLifecycle = probeApprovalResponseKey({
      ...response,
      lifecycleGeneration: "lifecycle-next",
    });
    expect(
      new Set([
        probeApprovalResponseKey(response),
        sameRequestDifferentTurn,
        sameRequestDifferentThread,
        sameRequestDifferentLifecycle,
      ]).size,
    ).toBe(4);
  });

  it("matches a confirmed interaction by full identity when an older turn reused the request id", () => {
    const scope = approvalScope();
    const base = approvalThread(scope);
    const resolvedActivity: ProbeToolActivity = {
      kind: "approval.resolved",
      turnId: scope.turnId,
      payload: {
        requestId: REQUEST_ID,
        lifecycleGeneration: LIFECYCLE,
        decision: "accept",
      },
    };
    const thread = approvalThread(scope, {
      activities: [...base.activities, resolvedActivity],
      pendingInteractions: [
        {
          interactionKind: "approval",
          requestId: REQUEST_ID,
          threadId: THREAD_ID,
          turnId: "turn-old",
          lifecycleGeneration: "lifecycle-old",
          status: "confirmed",
          decision: "accept",
        },
      ],
      latestTurnState: "completed",
      activeTurnId: null,
    });
    const sent = new Map<string, ProbeApprovalDecision>([
      [
        probeApprovalResponseKey({
          threadId: THREAD_ID,
          turnId: scope.turnId,
          lifecycleGeneration: LIFECYCLE,
          requestId: REQUEST_ID,
          decision: "accept",
        }),
        "accept",
      ],
    ]);
    expect(inspectProbeApproval(thread, scope, sent)).toMatchObject({
      kind: "settled",
      requestId: REQUEST_ID,
      lifecycleGeneration: LIFECYCLE,
      decision: "accept",
    });
  });

  it.each(["confirmed interaction", "resolved activity"] as const)(
    "settles an accepted fixture approval from the current %s",
    (settlement) => {
      const scope = approvalScope();
      const base = approvalThread(scope);
      const resolvedActivity: ProbeToolActivity = {
        kind: "approval.resolved",
        turnId: scope.turnId,
        payload: {
          requestId: REQUEST_ID,
          lifecycleGeneration: LIFECYCLE,
          decision: "accept",
        },
      };
      const thread = approvalThread(scope, {
        activities:
          settlement === "resolved activity"
            ? [...base.activities, resolvedActivity]
            : base.activities,
        pendingInteractions:
          settlement === "confirmed interaction"
            ? [
                {
                  interactionKind: "approval",
                  requestId: REQUEST_ID,
                  threadId: THREAD_ID,
                  turnId: scope.turnId,
                  lifecycleGeneration: LIFECYCLE,
                  status: "confirmed",
                  decision: "accept",
                },
              ]
            : [],
        latestTurnState: "completed",
        activeTurnId: null,
      });
      const sent = new Map<string, ProbeApprovalDecision>([
        [
          probeApprovalResponseKey({
            threadId: THREAD_ID,
            turnId: scope.turnId,
            lifecycleGeneration: LIFECYCLE,
            requestId: REQUEST_ID,
            decision: "accept",
          }),
          "accept",
        ],
      ]);

      expect(inspectProbeApproval(thread, scope, sent)).toMatchObject({
        kind: "settled",
        requestId: REQUEST_ID,
        lifecycleGeneration: LIFECYCLE,
        decision: "accept",
      });
    },
  );

  it("fails if a current approval resolves without this probe sending a response", () => {
    const scope = approvalScope();
    const base = approvalThread(scope);
    const thread = approvalThread(scope, {
      activities: [
        ...base.activities,
        {
          kind: "approval.resolved",
          turnId: scope.turnId,
          payload: {
            requestId: REQUEST_ID,
            lifecycleGeneration: LIFECYCLE,
            decision: "accept",
          },
        },
      ],
      pendingInteractions: [],
      latestTurnState: "completed",
      activeTurnId: null,
    });

    expect(inspectProbeApproval(thread, scope, new Map())).toMatchObject({
      kind: "failure",
      reasonCode: "approval-resolved-without-probe-response",
    });
  });

  it("keeps a missing-activity approval unsettled through none until the same approval settles", async () => {
    const scope = approvalScope();
    const unsettled = new Set<string>();
    const sent = new Map<string, ProbeApprovalDecision>();
    let accepted = 0;
    let settledCount = 0;
    const progress = () => ({ unsettled, accepted, declined: 0, settled: settledCount });
    const noApproval = approvalThread(scope, { activities: [], pendingInteractions: [] });
    const initiallyNone = inspectProbeApproval(noApproval, scope, sent);
    expect(initiallyNone).toEqual({ kind: "none" });
    trackProbeApprovalSettlement(unsettled, scope, initiallyNone);
    expect(canContinueAfterProbeApproval(progress())).toBe(true);
    expect(probeApprovalCompletionFailure(progress())).toBeNull();

    const pendingWithoutActivity = approvalThread(scope, { activities: [] });
    const waiting = inspectProbeApproval(pendingWithoutActivity, scope, sent);

    expect(waiting).toMatchObject({ kind: "wait", requestId: REQUEST_ID });
    trackProbeApprovalSettlement(unsettled, scope, waiting);
    expect(canContinueAfterProbeApproval(progress())).toBe(false);
    expect(probeApprovalCompletionFailure(progress())).toBe("fixture-approval-not-settled");

    const disappeared = approvalThread(scope, { activities: [], pendingInteractions: [] });
    const noActivity = inspectProbeApproval(disappeared, scope, sent);
    expect(noActivity).toEqual({ kind: "none" });
    trackProbeApprovalSettlement(unsettled, scope, noActivity);
    expect(canContinueAfterProbeApproval(progress())).toBe(false);
    expect(probeApprovalCompletionFailure(progress())).toBe("fixture-approval-not-settled");

    const requested = approvalThread(scope);
    const responseInspection = inspectProbeApproval(requested, scope, sent);
    expect(responseInspection.kind).toBe("respond");
    if (responseInspection.kind !== "respond") return;
    trackProbeApprovalSettlement(unsettled, scope, responseInspection);
    await respondToProbeApprovalOnce(
      {
        threadId: scope.threadId,
        turnId: scope.turnId,
        requestId: responseInspection.requestId,
        lifecycleGeneration: responseInspection.lifecycleGeneration,
        decision: responseInspection.decision,
      },
      sent,
      async () => undefined,
    );
    accepted += 1;

    const resolved = approvalThread(scope, {
      activities: [
        ...requested.activities,
        {
          kind: "approval.resolved",
          turnId: scope.turnId,
          payload: {
            requestId: REQUEST_ID,
            lifecycleGeneration: LIFECYCLE,
            decision: "accept",
          },
        },
      ],
      pendingInteractions: [],
      latestTurnState: "completed",
      activeTurnId: null,
    });
    const resolution = inspectProbeApproval(resolved, scope, sent);
    expect(resolution.kind).toBe("settled");
    trackProbeApprovalSettlement(unsettled, scope, resolution);
    settledCount += 1;
    expect(canContinueAfterProbeApproval(progress())).toBe(true);
    expect(probeApprovalCompletionFailure(progress())).toBeNull();
  });

  it.each([
    ["decision", { decision: "decline" }],
    ["lifecycle", { lifecycleGeneration: "lifecycle-other" }],
  ] as const)("fails when the resolution %s disagrees with the sent approval", (_kind, change) => {
    const scope = approvalScope();
    const base = approvalThread(scope);
    const thread = approvalThread(scope, {
      activities: [
        ...base.activities,
        {
          kind: "approval.resolved",
          turnId: scope.turnId,
          payload: {
            requestId: REQUEST_ID,
            lifecycleGeneration: LIFECYCLE,
            decision: "accept",
            ...change,
          },
        },
      ],
      pendingInteractions: [],
      latestTurnState: "completed",
      activeTurnId: null,
    });
    const sent = new Map<string, ProbeApprovalDecision>([
      [
        probeApprovalResponseKey({
          threadId: THREAD_ID,
          turnId: scope.turnId,
          lifecycleGeneration: LIFECYCLE,
          requestId: REQUEST_ID,
          decision: "accept",
        }),
        "accept",
      ],
    ]);

    expect(inspectProbeApproval(thread, scope, sent)).toMatchObject({
      kind: "failure",
      reasonCode:
        _kind === "decision"
          ? "approval-settlement-decision-mismatch"
          : "approval-lifecycle-mismatch",
    });
  });

  it("rejects conflicting lifecycle rows from the current thread and turn", () => {
    const scope = approvalScope();
    const base = approvalThread(scope);
    const thread = approvalThread(scope, {
      activities: [
        ...base.activities,
        {
          kind: "approval.resolved",
          turnId: scope.turnId,
          payload: {
            requestId: REQUEST_ID,
            lifecycleGeneration: LIFECYCLE,
            decision: "accept",
          },
        },
      ],
      pendingInteractions: [
        {
          interactionKind: "approval",
          requestId: REQUEST_ID,
          threadId: THREAD_ID,
          turnId: scope.turnId,
          lifecycleGeneration: "lifecycle-conflict",
          status: "confirmed",
          decision: "accept",
        },
      ],
      latestTurnState: "completed",
      activeTurnId: null,
    });
    expect(inspectProbeApproval(thread, scope, new Map())).toMatchObject({
      kind: "failure",
      reasonCode: "approval-lifecycle-mismatch",
    });
  });

  it("observes the wait handler only after the exact fixture approval response", async () => {
    const scope = approvalScope({ tool: "wait" });
    const snapshot = approvalThread(scope);
    const sent = new Map<string, ProbeApprovalDecision>();
    const observed = new Set<string>();
    const stats = { waitCalls: 0, activeWaits: 0 };
    const started = await waitForFixtureWaitStart({
      readSnapshot: async () => snapshot,
      observeSnapshot: async (thread) => {
        const inspection = inspectProbeApproval(thread, scope, sent, observed);
        if (inspection.kind !== "respond") throw new Error("expected-explicit-wait-approval");
        await respondToProbeApprovalOnce(
          {
            threadId: scope.threadId,
            turnId: scope.turnId,
            requestId: inspection.requestId,
            lifecycleGeneration: inspection.lifecycleGeneration,
            decision: inspection.decision,
          },
          sent,
          async () => {
            expect(inspection.decision).toBe("accept");
            stats.waitCalls = 1;
            stats.activeWaits = 1;
          },
        );
      },
      stats: () => stats,
      timeoutMs: 100,
      pollIntervalMs: 1,
      sleep: async () => undefined,
    });
    expect(started).toBe(snapshot);
    expect(stats).toEqual({ waitCalls: 1, activeWaits: 1 });
  });
});

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
