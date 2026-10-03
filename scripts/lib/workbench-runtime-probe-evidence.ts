export type ProbeToolActivity = {
  readonly kind: string;
  readonly payload: unknown;
  readonly turnId: string | null;
};

export type ProbeToolProvider = "codex" | "pi";

export type ProbeApprovalDecision = "accept" | "decline";

type ProbeApprovalPendingInteraction = {
  readonly interactionKind: string;
  readonly requestId: string;
  readonly threadId: string;
  readonly turnId: string | null;
  readonly lifecycleGeneration: string | null;
  readonly status: string;
  readonly decision: string | null;
};

type ProbeApprovalThread = {
  readonly id: string;
  readonly latestTurn: { readonly turnId: string; readonly state: string } | null;
  readonly session: {
    readonly threadId: string;
    readonly providerName: string | null;
    readonly activeTurnId: string | null;
  } | null;
  readonly expertBinding?:
    | {
        readonly expertId: string;
        readonly snapshotId: string;
        readonly revision: number;
      }
    | null
    | undefined;
  readonly messages: ReadonlyArray<{
    readonly id: string;
    readonly role: string;
    readonly text: string;
  }>;
  readonly activities: ReadonlyArray<ProbeToolActivity>;
  readonly pendingInteractions?: ReadonlyArray<ProbeApprovalPendingInteraction> | undefined;
};

export type ProbeApprovalScope = {
  readonly provider: ProbeToolProvider;
  readonly threadId: string;
  readonly turnId: string;
  readonly userMessageId: string;
  readonly userMessageText: string;
  readonly fixture?: {
    readonly connectionId: string;
    readonly expertBinding: {
      readonly expertId: string;
      readonly snapshotId: string;
      readonly revision: number;
    };
    readonly tool: "echo" | "wait";
    readonly value?: string;
  };
};

export type ProbeApprovalInspection =
  | { readonly kind: "none" }
  | {
      readonly kind: "wait";
      readonly requestId: string;
      readonly lifecycleGeneration: string;
    }
  | {
      readonly kind: "settled";
      readonly requestId: string;
      readonly lifecycleGeneration: string;
      readonly decision: ProbeApprovalDecision;
    }
  | {
      readonly kind: "respond";
      readonly requestId: string;
      readonly lifecycleGeneration: string;
      readonly requestType: string;
      readonly decision: ProbeApprovalDecision;
      readonly reasonCode: string | null;
      readonly fixtureConnectionBound: boolean;
    }
  | { readonly kind: "failure"; readonly reasonCode: string };

export type ProbeApprovalResponse = {
  readonly threadId: string;
  readonly turnId: string;
  readonly requestId: string;
  readonly lifecycleGeneration: string;
  readonly decision: ProbeApprovalDecision;
};

export type ProbeApprovalProgress = {
  readonly unsettled: ReadonlySet<string>;
  readonly accepted: number;
  readonly declined: number;
  readonly settled: number;
};

const TOOL_ACTIVITY_KINDS = new Set(["tool.started", "tool.updated", "tool.completed"]);

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

const OPEN_APPROVAL_STATUSES = new Set(["pending", "responding", "retryable", "uncertain"]);

export function probeApprovalResponseKey(input: ProbeApprovalResponse): string {
  return JSON.stringify([input.threadId, input.turnId, input.lifecycleGeneration, input.requestId]);
}

export function trackProbeApprovalSettlement(
  unsettled: Set<string>,
  scope: Pick<ProbeApprovalScope, "threadId" | "turnId">,
  inspection: ProbeApprovalInspection,
): void {
  if (inspection.kind === "none" || inspection.kind === "failure") return;
  const key = probeApprovalResponseKey({
    threadId: scope.threadId,
    turnId: scope.turnId,
    lifecycleGeneration: inspection.lifecycleGeneration,
    requestId: inspection.requestId,
    decision: inspection.kind === "settled" ? inspection.decision : "accept",
  });
  if (inspection.kind === "settled") unsettled.delete(key);
  else unsettled.add(key);
}

export function canContinueAfterProbeApproval(input: ProbeApprovalProgress): boolean {
  return input.unsettled.size === 0 && input.declined === 0 && input.accepted === input.settled;
}

export function probeApprovalCompletionFailure(
  input: ProbeApprovalProgress,
): "unexpected-provider-approval-declined" | "fixture-approval-not-settled" | null {
  if (input.declined > 0) return "unexpected-provider-approval-declined";
  if (input.unsettled.size > 0 || input.accepted !== input.settled) {
    return "fixture-approval-not-settled";
  }
  return null;
}

/**
 * Sends one approval response per thread/turn/lifecycle/request identity.
 * Provider request IDs may be reused after a new session, so the key is never
 * global to requestId alone. The key is reserved before the callback runs to
 * prevent retrying an uncertain response.
 */
export async function respondToProbeApprovalOnce(
  input: ProbeApprovalResponse,
  sentResponses: Map<string, ProbeApprovalDecision>,
  send: (response: Omit<ProbeApprovalResponse, "turnId">) => Promise<void>,
): Promise<boolean> {
  const key = probeApprovalResponseKey(input);
  if (sentResponses.has(key)) return false;
  sentResponses.set(key, input.decision);
  await send({
    threadId: input.threadId,
    requestId: input.requestId,
    lifecycleGeneration: input.lifecycleGeneration,
    decision: input.decision,
  });
  return true;
}

function exactDisplayParams(
  value: unknown,
  fixture: NonNullable<ProbeApprovalScope["fixture"]>,
): boolean {
  if (fixture.tool === "wait") return Array.isArray(value) && value.length === 0;
  if (typeof fixture.value !== "string" || !Array.isArray(value) || value.length !== 1) {
    return false;
  }
  const [entry] = value;
  const row = record(entry);
  if (!row) return false;
  const keys = Object.keys(row).toSorted();
  if (
    (keys.join(",") !== "name,value" && keys.join(",") !== "display_name,name,value") ||
    row.name !== "value" ||
    row.value !== fixture.value ||
    row.value === "[truncated]" ||
    (Object.hasOwn(row, "display_name") && row.display_name !== "value")
  ) {
    return false;
  }
  return true;
}

function acceptedFixtureApprovalCount(
  sentResponses: ReadonlyMap<string, ProbeApprovalDecision>,
  scope: ProbeApprovalScope,
  excludedResponseKey: string,
): number {
  let count = 0;
  for (const [key, decision] of sentResponses) {
    if (key === excludedResponseKey || decision !== "accept") continue;
    try {
      const identity: unknown = JSON.parse(key);
      if (
        Array.isArray(identity) &&
        identity[0] === scope.threadId &&
        identity[1] === scope.turnId
      ) {
        count += 1;
      }
    } catch {
      // A malformed in-memory key cannot authorize another tool approval.
    }
  }
  return count;
}

function fixtureToolAlias(connectionId: string, tool: "echo" | "wait"): string | undefined {
  if (!/^wb_probe_[0-9a-f]{20}$/u.test(connectionId)) return undefined;
  return `expert_${connectionId}_workbench_probe_${tool}`;
}

function exactFixtureApproval(
  payload: Record<string, unknown>,
  scope: ProbeApprovalScope,
  actualBinding: ProbeApprovalThread["expertBinding"],
  sentResponses: ReadonlyMap<string, ProbeApprovalDecision>,
  currentResponseKey: string,
): {
  readonly matched: boolean;
  readonly fixtureConnectionBound: boolean;
  readonly reasonCode: string | null;
} {
  const fixture = scope.fixture;
  if (!fixture) {
    return {
      matched: false,
      fixtureConnectionBound: false,
      reasonCode: "fixture-approval-not-authorized",
    };
  }
  if (scope.provider !== "codex") {
    return {
      matched: false,
      fixtureConnectionBound: false,
      reasonCode: "provider-approval-shape-unverified",
    };
  }
  const expectedAlias = fixtureToolAlias(fixture.connectionId, fixture.tool);
  if (!expectedAlias) {
    return {
      matched: false,
      fixtureConnectionBound: false,
      reasonCode: "fixture-connection-id-invalid",
    };
  }
  const expectedDetail = `Allow the synara MCP server to run tool "${expectedAlias}"?`;
  const toolNamePresent = Object.hasOwn(payload, "toolName");
  const aliasMatched = toolNamePresent
    ? payload.toolName === expectedAlias &&
      (payload.detail === undefined || payload.detail === expectedDetail)
    : payload.detail === expectedDetail;
  const requestKindMatched =
    payload.requestKind === "tool" && payload.requestType === "tool_approval";
  const paramsMatched = exactDisplayParams(payload.toolParamsDisplay, fixture);
  const binding = scope.fixture.expertBinding;
  const fixtureConnectionBound =
    actualBinding?.expertId === binding.expertId &&
    actualBinding.snapshotId === binding.snapshotId &&
    actualBinding.revision === binding.revision &&
    binding.expertId.length > 0 &&
    binding.snapshotId.length > 0 &&
    Number.isSafeInteger(binding.revision) &&
    expectedAlias.includes(fixture.connectionId) &&
    (fixture.tool === "echo"
      ? typeof fixture.value === "string" &&
        fixture.value.length > 0 &&
        scope.userMessageText.includes(expectedAlias) &&
        scope.userMessageText.includes(JSON.stringify({ value: fixture.value }))
      : scope.userMessageText.includes(`tool named ${expectedAlias} exactly once`));
  if (!fixtureConnectionBound) {
    return {
      matched: false,
      fixtureConnectionBound: false,
      reasonCode: "fixture-binding-mismatch",
    };
  }
  if (!requestKindMatched) {
    return { matched: false, fixtureConnectionBound, reasonCode: "approval-request-kind-not-tool" };
  }
  if (!aliasMatched) {
    return { matched: false, fixtureConnectionBound, reasonCode: "fixture-tool-alias-mismatch" };
  }
  if (!paramsMatched) {
    return {
      matched: false,
      fixtureConnectionBound,
      reasonCode: "fixture-tool-arguments-mismatch",
    };
  }
  if (acceptedFixtureApprovalCount(sentResponses, scope, currentResponseKey) > 0) {
    return {
      matched: false,
      fixtureConnectionBound,
      reasonCode: "fixture-tool-approval-limit-exceeded",
    };
  }
  return { matched: fixtureConnectionBound, fixtureConnectionBound, reasonCode: null };
}

function approvalActivityPayload(activity: ProbeToolActivity): Record<string, unknown> | undefined {
  return record(activity.payload);
}

function requestActivitiesForTurn(
  thread: ProbeApprovalThread,
  scope: ProbeApprovalScope,
): ReadonlyArray<ProbeToolActivity> {
  return thread.activities.filter(
    (activity) => activity.kind === "approval.requested" && activity.turnId === scope.turnId,
  );
}

function matchingResolution(
  thread: ProbeApprovalThread,
  scope: ProbeApprovalScope,
  requestId: string,
  lifecycleGeneration: string,
): { readonly count: number; readonly decision?: string; readonly lifecycleMismatch: boolean } {
  const matches = thread.activities.filter((activity) => {
    if (activity.kind !== "approval.resolved" || activity.turnId !== scope.turnId) return false;
    const payload = approvalActivityPayload(activity);
    return payload?.requestId === requestId;
  });
  const lifecycleMismatch = matches.some(
    (activity) => approvalActivityPayload(activity)?.lifecycleGeneration !== lifecycleGeneration,
  );
  const matching = lifecycleMismatch
    ? []
    : matches.filter(
        (activity) =>
          approvalActivityPayload(activity)?.lifecycleGeneration === lifecycleGeneration,
      );
  const decision =
    matching.length === 1 ? approvalActivityPayload(matching[0]!)?.decision : undefined;
  return {
    count: matching.length,
    lifecycleMismatch,
    ...(typeof decision === "string" ? { decision } : {}),
  };
}

function responseForIdentity(
  scope: ProbeApprovalScope,
  requestId: string,
  lifecycleGeneration: string,
  sentResponses: ReadonlyMap<string, ProbeApprovalDecision>,
): ProbeApprovalDecision | undefined {
  return sentResponses.get(
    probeApprovalResponseKey({
      threadId: scope.threadId,
      turnId: scope.turnId,
      lifecycleGeneration,
      requestId,
      decision: "accept",
    }),
  );
}

function currentTurnScopeMatches(
  thread: ProbeApprovalThread,
  scope: ProbeApprovalScope,
  requireRunning: boolean,
): boolean {
  return (
    thread.id === scope.threadId &&
    thread.latestTurn?.turnId === scope.turnId &&
    (!requireRunning || thread.latestTurn.state === "running") &&
    thread.session?.threadId === scope.threadId &&
    thread.session.providerName === scope.provider &&
    (!requireRunning || thread.session.activeTurnId === scope.turnId) &&
    (requireRunning ||
      thread.session.activeTurnId === scope.turnId ||
      thread.session.activeTurnId === null)
  );
}

function currentUserMessageMatches(
  thread: ProbeApprovalThread,
  scope: ProbeApprovalScope,
): boolean {
  return thread.messages.some(
    (message) =>
      message.id === scope.userMessageId &&
      message.role === "user" &&
      message.text === scope.userMessageText,
  );
}

/** Strictly classifies one pending approval from a product thread snapshot. */
export function inspectProbeApproval(
  thread: ProbeApprovalThread,
  scope: ProbeApprovalScope,
  sentResponses: ReadonlyMap<string, ProbeApprovalDecision>,
  observedSettlements: ReadonlySet<string> = new Set(),
): ProbeApprovalInspection {
  if (thread.id !== scope.threadId) {
    return { kind: "failure", reasonCode: "approval-thread-scope-mismatch" };
  }
  const activities = requestActivitiesForTurn(thread, scope);
  const interactions = thread.pendingInteractions ?? [];
  const openInteractions = interactions.filter((row) => OPEN_APPROVAL_STATUSES.has(row.status));
  if (
    openInteractions.some((row) => row.threadId !== scope.threadId || row.turnId !== scope.turnId)
  ) {
    return { kind: "failure", reasonCode: "pending-approval-not-current-thread-turn" };
  }
  if (openInteractions.some((row) => row.interactionKind === "userInput")) {
    return { kind: "failure", reasonCode: "unexpected-pending-user-input" };
  }
  if (openInteractions.some((row) => row.interactionKind !== "approval")) {
    return { kind: "failure", reasonCode: "unknown-pending-interaction-kind" };
  }
  const pending = openInteractions.filter((row) => row.interactionKind === "approval");
  if (pending.length > 1) {
    return { kind: "failure", reasonCode: "multiple-pending-approvals" };
  }
  if (pending.length === 0) {
    if (activities.length === 0) return { kind: "none" };
    for (const activity of activities) {
      const payload = approvalActivityPayload(activity);
      const requestId = payload?.requestId;
      if (typeof requestId !== "string" || requestId.length === 0) {
        return { kind: "failure", reasonCode: "approval-request-id-missing" };
      }
      const lifecycleGeneration = payload?.lifecycleGeneration;
      if (typeof lifecycleGeneration !== "string" || lifecycleGeneration.length === 0) {
        return { kind: "failure", reasonCode: "approval-lifecycle-missing" };
      }
      const key = probeApprovalResponseKey({
        threadId: scope.threadId,
        turnId: scope.turnId,
        lifecycleGeneration,
        requestId,
        decision: "accept",
      });
      const sentDecision = responseForIdentity(
        scope,
        requestId,
        lifecycleGeneration,
        sentResponses,
      );
      const sameThreadTurnRows = interactions.filter(
        (row) =>
          row.requestId === requestId &&
          row.threadId === scope.threadId &&
          row.turnId === scope.turnId,
      );
      if (sameThreadTurnRows.some((row) => row.lifecycleGeneration !== lifecycleGeneration)) {
        return { kind: "failure", reasonCode: "approval-lifecycle-mismatch" };
      }
      const interaction = interactions.find(
        (row) =>
          row.requestId === requestId &&
          row.threadId === scope.threadId &&
          row.turnId === scope.turnId &&
          row.lifecycleGeneration === lifecycleGeneration,
      );
      const resolution = matchingResolution(thread, scope, requestId, lifecycleGeneration);
      if (resolution.lifecycleMismatch) {
        return { kind: "failure", reasonCode: "approval-lifecycle-mismatch" };
      }
      if (resolution.count > 1) {
        return { kind: "failure", reasonCode: "approval-resolution-ambiguous" };
      }
      if (resolution.count === 1) {
        if (!sentDecision) {
          return { kind: "failure", reasonCode: "approval-resolved-without-probe-response" };
        }
        if (
          resolution.decision !== sentDecision ||
          (interaction?.decision && interaction.decision !== sentDecision)
        ) {
          return { kind: "failure", reasonCode: "approval-settlement-decision-mismatch" };
        }
        if (
          !currentTurnScopeMatches(thread, scope, false) ||
          !currentUserMessageMatches(thread, scope)
        ) {
          return { kind: "failure", reasonCode: "approval-product-turn-scope-mismatch" };
        }
        if (observedSettlements.has(key)) continue;
        return {
          kind: "settled",
          requestId,
          lifecycleGeneration,
          decision: sentDecision,
        };
      }
      if (interaction?.status === "confirmed") {
        if (!sentDecision || interaction.decision !== sentDecision) {
          return { kind: "failure", reasonCode: "approval-settlement-decision-mismatch" };
        }
        if (
          !currentTurnScopeMatches(thread, scope, false) ||
          !currentUserMessageMatches(thread, scope)
        ) {
          return { kind: "failure", reasonCode: "approval-product-turn-scope-mismatch" };
        }
        if (observedSettlements.has(key)) continue;
        return { kind: "settled", requestId, lifecycleGeneration, decision: sentDecision };
      }
      if (sentDecision !== undefined || !interaction) {
        return { kind: "wait", requestId, lifecycleGeneration };
      }
      return { kind: "failure", reasonCode: "approval-resolved-without-probe-response" };
    }
    return { kind: "none" };
  }

  const interaction = pending[0];
  if (!interaction) return { kind: "none" };
  const activityMatches = activities.filter((activity) => {
    const payload = approvalActivityPayload(activity);
    return payload?.requestId === interaction.requestId;
  });
  if (activityMatches.length === 0) {
    if (!interaction.requestId) {
      return { kind: "failure", reasonCode: "approval-request-id-missing" };
    }
    if (!interaction.lifecycleGeneration) {
      return { kind: "failure", reasonCode: "approval-lifecycle-missing" };
    }
    return {
      kind: "wait",
      requestId: interaction.requestId,
      lifecycleGeneration: interaction.lifecycleGeneration,
    };
  }
  if (activityMatches.length !== 1) {
    return { kind: "failure", reasonCode: "approval-activity-ambiguous" };
  }
  const activity = activityMatches[0];
  const payload = activity ? approvalActivityPayload(activity) : undefined;
  if (!activity || !payload) return { kind: "failure", reasonCode: "approval-payload-unreadable" };
  const lifecycleGeneration = payload.lifecycleGeneration;
  if (
    typeof lifecycleGeneration !== "string" ||
    lifecycleGeneration.length === 0 ||
    interaction.lifecycleGeneration !== lifecycleGeneration
  ) {
    return { kind: "failure", reasonCode: "approval-lifecycle-mismatch" };
  }
  if (!currentTurnScopeMatches(thread, scope, true)) {
    return { kind: "failure", reasonCode: "approval-product-turn-scope-mismatch" };
  }
  if (!currentUserMessageMatches(thread, scope)) {
    return { kind: "failure", reasonCode: "approval-user-message-scope-mismatch" };
  }
  const requestId = payload.requestId;
  if (typeof requestId !== "string" || requestId !== interaction.requestId) {
    return { kind: "failure", reasonCode: "approval-request-id-mismatch" };
  }
  if (interaction.interactionKind !== "approval") {
    return { kind: "failure", reasonCode: "approval-interaction-kind-mismatch" };
  }

  const requestType = typeof payload.requestType === "string" ? payload.requestType : "unknown";
  const responseKey = probeApprovalResponseKey({
    threadId: scope.threadId,
    turnId: scope.turnId,
    lifecycleGeneration,
    requestId: interaction.requestId,
    decision: "accept",
  });
  const exact = exactFixtureApproval(
    payload,
    scope,
    thread.expertBinding,
    sentResponses,
    responseKey,
  );
  const decision = exact.matched ? "accept" : "decline";
  const sentDecision = sentResponses.get(responseKey);
  if (sentDecision !== undefined) {
    return sentDecision === decision
      ? { kind: "wait", requestId: interaction.requestId, lifecycleGeneration }
      : { kind: "failure", reasonCode: "approval-response-decision-changed" };
  }
  if (interaction.status !== "pending") {
    return { kind: "failure", reasonCode: "approval-is-not-pending" };
  }
  return {
    kind: "respond",
    requestId: interaction.requestId,
    lifecycleGeneration,
    requestType,
    decision,
    reasonCode: exact.reasonCode,
    fixtureConnectionBound: exact.fixtureConnectionBound,
  };
}

/** Polls product snapshots while the fixture tool must enter its wait handler. */
export async function waitForFixtureWaitStart<T>(input: {
  readonly readSnapshot: () => Promise<T | null>;
  readonly observeSnapshot: (snapshot: T) => Promise<void>;
  readonly stats: () => { readonly waitCalls: number; readonly activeWaits: number };
  readonly timeoutMs: number;
  readonly pollIntervalMs: number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}): Promise<T> {
  const sleepFor =
    input.sleep ??
    ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const deadline = Date.now() + input.timeoutMs;
  while (Date.now() < deadline) {
    const snapshot = await input.readSnapshot();
    if (snapshot !== null) {
      await input.observeSnapshot(snapshot);
      const stats = input.stats();
      if (stats.waitCalls > 0 && stats.activeWaits > 0) return snapshot;
    }
    await sleepFor(Math.min(input.pollIntervalMs, Math.max(0, deadline - Date.now())));
  }
  throw new Error("fixture-wait-start-timeout");
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
