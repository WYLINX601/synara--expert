import type {
  HubGraphGateStatus,
  HubGraphInteractionStatus,
  HubGraphNodeExecutionStatus,
  HubGraphRunStatus,
} from "@synara/contracts";

export interface HubGraphRuntimeState {
  readonly runStatus: HubGraphRunStatus;
  readonly stateVersion: number;
  readonly nodes: Readonly<Record<string, HubGraphNodeExecutionStatus>>;
  readonly interactions: Readonly<
    Record<string, { readonly status: HubGraphInteractionStatus; readonly round: number; readonly maxRounds: number; readonly initiatorNodeId: string; readonly responderNodeId: string; readonly outcome: string | null }>
  >;
  readonly gates: Readonly<Record<string, HubGraphGateStatus>>;
}

export type HubGraphRuntimeEvent =
  | { readonly type: "graph.started" }
  | { readonly type: "graph.paused" }
  | { readonly type: "graph.resumed" }
  | { readonly type: "graph.cancelled" }
  | { readonly type: "graph.failed" }
  | { readonly type: "graph.completed" }
  | { readonly type: "node.ready"; readonly nodeId: string }
  | { readonly type: "node.retry"; readonly nodeId: string }
  | { readonly type: "node.queued"; readonly nodeId: string }
  | { readonly type: "node.started"; readonly nodeId: string }
  | { readonly type: "node.settled"; readonly nodeId: string }
  | { readonly type: "node.output_accepted"; readonly nodeId: string }
  | { readonly type: "node.failed"; readonly nodeId: string }
  | { readonly type: "node.blocked"; readonly nodeId: string }
  | { readonly type: "node.cancelled"; readonly nodeId: string }
  | { readonly type: "node.stale"; readonly nodeId: string }
  | { readonly type: "interaction.requested"; readonly blockId: string }
  | { readonly type: "interaction.responder_dispatched"; readonly blockId: string }
  | { readonly type: "interaction.response_received"; readonly blockId: string; readonly outcome: string; readonly requiresRevision?: boolean }
  | { readonly type: "interaction.completed"; readonly blockId: string; readonly outcome: string }
  | { readonly type: "interaction.approved"; readonly blockId: string }
  | { readonly type: "interaction.exhausted"; readonly blockId: string }
  | { readonly type: "interaction.blocked"; readonly blockId: string }
  | { readonly type: "interaction.reopened"; readonly blockId: string }
  | { readonly type: "interaction.cancelled"; readonly blockId: string }
  | { readonly type: "gate.opened"; readonly gateId: string }
  | { readonly type: "gate.reopened"; readonly gateId: string }
  | {
      readonly type: "gate.decided";
      readonly gateId: string;
      readonly decision: "approve" | "return" | "reject";
    };

export type HubGraphTransitionErrorCode =
  | "stale_version"
  | "invalid_run_transition"
  | "invalid_node_transition"
  | "invalid_interaction_transition"
  | "invalid_gate_transition"
  | "unknown_target"
  | "invalid_event";

export class HubGraphTransitionError extends Error {
  constructor(
    readonly code: HubGraphTransitionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "HubGraphTransitionError";
  }
}

export function createHubGraphRuntimeState(input: {
  readonly nodeIds: readonly string[];
  readonly interactionBlocks: readonly {
    readonly id: string;
    readonly maxRounds: number;
    readonly initiatorNodeId: string;
    readonly responderNodeId: string;
  }[];
  readonly gateIds: readonly string[];
}): HubGraphRuntimeState {
  return {
    runStatus: "draft",
    stateVersion: 0,
    nodes: Object.fromEntries(input.nodeIds.map((id) => [id, "pending" as const] as const)),
    interactions: Object.fromEntries(
      input.interactionBlocks.map((block) => [
        block.id,
        { status: "waiting_initiator" as const, round: 0, maxRounds: block.maxRounds, initiatorNodeId: block.initiatorNodeId, responderNodeId: block.responderNodeId, outcome: null },
      ] as const),
    ),
    gates: Object.fromEntries(input.gateIds.map((id) => [id, "not_opened" as const] as const)),
  };
}

function requireTarget<T>(record: Readonly<Record<string, T>>, id: string, kind: string): T {
  const value = record[id];
  if (value === undefined) {
    throw new HubGraphTransitionError("unknown_target", `Unknown ${kind} "${id}".`);
  }
  return value;
}

function requireRunStatus(
  state: HubGraphRuntimeState,
  allowed: readonly HubGraphRunStatus[],
): void {
  if (!allowed.includes(state.runStatus)) {
    throw new HubGraphTransitionError(
      "invalid_run_transition",
      `Run status "${state.runStatus}" does not allow this event.`,
    );
  }
}

/**
 * Pure state reducer. It performs no persistence, I/O, scheduling or tool calls.
 * The caller must persist the returned state and event atomically.
 */
export function reduceHubGraphEvent(
  state: HubGraphRuntimeState,
  event: HubGraphRuntimeEvent,
  expectedStateVersion: number = state.stateVersion,
): HubGraphRuntimeState {
  if (expectedStateVersion !== state.stateVersion) {
    throw new HubGraphTransitionError(
      "stale_version",
      `Expected state version ${expectedStateVersion}; current version is ${state.stateVersion}.`,
    );
  }

  let next: HubGraphRuntimeState = state;

  switch (event.type) {
    case "graph.started":
      requireRunStatus(state, ["draft"]);
      next = { ...state, runStatus: "active" };
      break;
    case "graph.paused":
      requireRunStatus(state, ["active"]);
      next = { ...state, runStatus: "paused" };
      break;
    case "graph.resumed":
      requireRunStatus(state, ["paused"]);
      next = { ...state, runStatus: "active" };
      break;
    case "graph.cancelled":
      requireRunStatus(state, ["draft", "active", "paused", "failed"]);
      next = {
        ...state,
        runStatus: "cancelled",
        nodes: Object.fromEntries(Object.entries(state.nodes).map(([id, status]) => [id, ["completed", "cancelled"].includes(status) ? status : "cancelled"])) as HubGraphRuntimeState["nodes"],
        interactions: Object.fromEntries(Object.entries(state.interactions).map(([id, item]) => [id, ["completed", "exhausted", "cancelled"].includes(item.status) ? item : { ...item, status: "cancelled" }])) as HubGraphRuntimeState["interactions"],
        gates: Object.fromEntries(Object.entries(state.gates).map(([id, status]) => [id, ["approved", "rejected", "cancelled"].includes(status) ? status : "cancelled"])) as HubGraphRuntimeState["gates"],
      };
      break;
    case "graph.failed":
      requireRunStatus(state, ["active"]);
      next = { ...state, runStatus: "failed" };
      break;
    case "graph.completed":
      requireRunStatus(state, ["active"]);
      if (
        Object.values(state.nodes).some((status) => !["completed", "cancelled"].includes(status)) ||
        Object.values(state.interactions).some((item) => !["completed", "exhausted"].includes(item.status)) ||
        Object.values(state.gates).some((status) => !["approved", "rejected"].includes(status))
      ) {
        throw new HubGraphTransitionError(
          "invalid_run_transition",
          "A Graph Run cannot complete while nodes, interactions or gates remain unresolved.",
        );
      }
      next = { ...state, runStatus: "completed" };
      break;
    case "node.ready":
    case "node.retry":
    case "node.queued":
    case "node.started":
    case "node.settled":
    case "node.output_accepted":
    case "node.failed":
    case "node.blocked":
    case "node.cancelled":
    case "node.stale": {
      requireRunStatus(state, ["active"]);
      const current = requireTarget(state.nodes, event.nodeId, "node");
      const transitions: Readonly<Record<string, readonly string[]>> = {
        "node.ready": ["pending", "stale"],
        "node.retry": ["failed", "blocked"],
        "node.queued": ["ready"],
        "node.started": ["queued"],
        "node.settled": ["running"],
        "node.output_accepted": ["settled"],
        "node.failed": ["queued", "running", "settled"],
        "node.blocked": ["pending", "ready", "queued", "running", "settled"],
        "node.cancelled": ["pending", "ready", "queued", "running", "settled", "blocked", "stale"],
        "node.stale": ["completed", "settled"],
      };
      const allowed = transitions[event.type] ?? [];
      if (!allowed.includes(current)) {
        throw new HubGraphTransitionError(
          "invalid_node_transition",
          `Node "${event.nodeId}" cannot transition from "${current}" via "${event.type}".`,
        );
      }
      const status: HubGraphNodeExecutionStatus =
        event.type === "node.ready" || event.type === "node.retry" ? "ready" :
        event.type === "node.queued" ? "queued" :
        event.type === "node.started" ? "running" :
        event.type === "node.settled" ? "settled" :
        event.type === "node.output_accepted" ? "completed" :
        event.type === "node.failed" ? "failed" :
        event.type === "node.blocked" ? "blocked" :
        event.type === "node.cancelled" ? "cancelled" : "stale";
      next = { ...state, nodes: { ...state.nodes, [event.nodeId]: status } };
      break;
    }
    case "interaction.requested":
    case "interaction.responder_dispatched":
    case "interaction.response_received":
    case "interaction.completed":
    case "interaction.approved":
    case "interaction.exhausted":
    case "interaction.blocked":
    case "interaction.reopened":
    case "interaction.cancelled": {
      requireRunStatus(state, ["active"]);
      const current = requireTarget(state.interactions, event.blockId, "interaction");
      let status: HubGraphInteractionStatus;
      let round = current.round;
      if (event.type === "interaction.requested") {
        if (current.status !== "waiting_initiator" || current.round >= current.maxRounds) {
          throw new HubGraphTransitionError("invalid_interaction_transition", "Interaction cannot accept another request.");
        }
        const initiatorStatus = requireTarget(state.nodes, current.initiatorNodeId, "initiator node");
        if (initiatorStatus !== "completed" && initiatorStatus !== "settled") {
          throw new HubGraphTransitionError("invalid_interaction_transition", "The initiator must submit a current result before the next interaction round.");
        }
        round += 1;
        status = "dispatching_responder";
      } else if (event.type === "interaction.responder_dispatched") {
        if (current.status !== "dispatching_responder") {
          throw new HubGraphTransitionError("invalid_interaction_transition", "Responder dispatch is not expected.");
        }
        status = "waiting_responder";
      } else if (event.type === "interaction.response_received") {
        if (current.status !== "waiting_responder") {
          throw new HubGraphTransitionError("invalid_interaction_transition", "No responder result is expected.");
        }
        status = "waiting_initiator";
        if (event.requiresRevision) {
          const initiatorStatus = requireTarget(state.nodes, current.initiatorNodeId, "initiator node");
          if (initiatorStatus === "completed" || initiatorStatus === "settled") {
            next = { ...state, nodes: { ...state.nodes, [current.initiatorNodeId]: "stale" } };
          }
        }
      } else if (event.type === "interaction.completed") {
        if (current.status !== "waiting_responder") {
          throw new HubGraphTransitionError("invalid_interaction_transition", "Interaction cannot complete before a response.");
        }
        status = "completed";
      } else if (event.type === "interaction.approved") {
        if (current.status !== "waiting_responder") {
          throw new HubGraphTransitionError("invalid_interaction_transition", "Approval is not expected.");
        }
        status = "completed";
      } else if (event.type === "interaction.exhausted") {
        if (current.status !== "waiting_initiator" || current.round < current.maxRounds) {
          throw new HubGraphTransitionError("invalid_interaction_transition", "Interaction has not exhausted its round budget.");
        }
        status = "exhausted";
      } else if (event.type === "interaction.blocked") {
        if (!["waiting_initiator", "dispatching_responder", "waiting_responder"].includes(current.status)) {
          throw new HubGraphTransitionError("invalid_interaction_transition", "Interaction cannot be blocked from its current state.");
        }
        status = "blocked";
      } else if (event.type === "interaction.reopened") {
        if (current.status !== "blocked") {
          throw new HubGraphTransitionError("invalid_interaction_transition", "Only a blocked Interaction can be reopened.");
        }
        status = "waiting_initiator";
      } else {
        if (["completed", "exhausted", "cancelled"].includes(current.status)) {
          throw new HubGraphTransitionError("invalid_interaction_transition", "A terminal Interaction cannot be cancelled again.");
        }
        status = "cancelled";
      }
      next = {
        ...next,
        interactions: { ...state.interactions, [event.blockId]: { ...current, status, round, outcome: event.type === "interaction.response_received" || event.type === "interaction.completed" ? event.outcome : event.type === "interaction.approved" ? "approved" : event.type === "interaction.exhausted" ? "exhausted" : event.type === "interaction.blocked" ? "blocked" : event.type === "interaction.reopened" || event.type === "interaction.requested" ? null : current.outcome } },
        ...(status === "completed" || status === "exhausted"
          ? { nodes: { ...next.nodes, [current.responderNodeId]: "completed" } }
          : {}),
      };
      break;
    }
    case "gate.opened": {
      requireRunStatus(state, ["active"]);
      const current = requireTarget(state.gates, event.gateId, "gate");
      if (current !== "not_opened") {
        throw new HubGraphTransitionError("invalid_gate_transition", "Only a not-yet-opened Gate can be opened.");
      }
      next = { ...state, gates: { ...state.gates, [event.gateId]: "pending" } };
      break;
    }
    case "gate.reopened": {
      requireRunStatus(state, ["active"]);
      const current = requireTarget(state.gates, event.gateId, "gate");
      if (current !== "returned") {
        throw new HubGraphTransitionError("invalid_gate_transition", "Only a returned Gate can be reopened.");
      }
      next = { ...state, gates: { ...state.gates, [event.gateId]: "pending" } };
      break;
    }
    case "gate.decided": {
      requireRunStatus(state, ["active"]);
      const current = requireTarget(state.gates, event.gateId, "gate");
      if (current !== "pending") {
        throw new HubGraphTransitionError("invalid_gate_transition", "This Gate has already been decided.");
      }
      const status: HubGraphGateStatus =
        event.decision === "approve" ? "approved" :
        event.decision === "return" ? "returned" : "rejected";
      next = { ...state, gates: { ...state.gates, [event.gateId]: status } };
      break;
    }
  }

  return next === state ? state : { ...next, stateVersion: state.stateVersion + 1 };
}
