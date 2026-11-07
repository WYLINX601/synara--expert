import { describe, expect, it } from "vitest";

import {
  createHubGraphRuntimeState,
  HubGraphTransitionError,
  reduceHubGraphEvent,
} from "./GraphReducer.ts";

const createState = () =>
  createHubGraphRuntimeState({
    nodeIds: ["author", "reviewer"],
    interactionBlocks: [{ id: "review", maxRounds: 3, initiatorNodeId: "author", responderNodeId: "reviewer" }],
    gateIds: ["release"],
  });

describe("Hub Graph runtime reducer", () => {
  it("enforces run lifecycle and optimistic state versions", () => {
    let state = createState();
    state = reduceHubGraphEvent(state, { type: "graph.started" });
    expect(state.runStatus).toBe("active");
    expect(state.stateVersion).toBe(1);

    expect(() =>
      reduceHubGraphEvent(state, { type: "graph.paused" }, 0),
    ).toThrow(HubGraphTransitionError);

    state = reduceHubGraphEvent(state, { type: "graph.paused" });
    expect(state.runStatus).toBe("paused");
    state = reduceHubGraphEvent(state, { type: "graph.resumed" });
    expect(state.runStatus).toBe("active");
  });

  it("enforces the node execution lifecycle and separates settlement from accepted output", () => {
    let state = reduceHubGraphEvent(createState(), { type: "graph.started" });
    state = reduceHubGraphEvent(state, { type: "node.ready", nodeId: "author" });
    state = reduceHubGraphEvent(state, { type: "node.queued", nodeId: "author" });
    state = reduceHubGraphEvent(state, { type: "node.started", nodeId: "author" });
    state = reduceHubGraphEvent(state, { type: "node.settled", nodeId: "author" });
    expect(state.nodes.author).toBe("settled");

    expect(() =>
      reduceHubGraphEvent(state, { type: "graph.completed" }),
    ).toThrow(HubGraphTransitionError);

    state = reduceHubGraphEvent(state, { type: "node.output_accepted", nodeId: "author" });
    expect(state.nodes.author).toBe("completed");
  });

  it("enforces bounded interaction rounds and terminal outcomes", () => {
    let state = reduceHubGraphEvent(createState(), { type: "graph.started" });
    state = reduceHubGraphEvent(state, { type: "node.ready", nodeId: "author" });
    state = reduceHubGraphEvent(state, { type: "node.queued", nodeId: "author" });
    state = reduceHubGraphEvent(state, { type: "node.started", nodeId: "author" });
    state = reduceHubGraphEvent(state, { type: "node.settled", nodeId: "author" });
    state = reduceHubGraphEvent(state, { type: "node.output_accepted", nodeId: "author" });
    state = reduceHubGraphEvent(state, { type: "interaction.requested", blockId: "review" });
    expect(state.interactions.review.round).toBe(1);
    state = reduceHubGraphEvent(state, { type: "interaction.responder_dispatched", blockId: "review" });
    state = reduceHubGraphEvent(state, { type: "interaction.response_received", blockId: "review", requiresRevision: true });
    expect(state.nodes.author).toBe("stale");
    state = reduceHubGraphEvent(state, { type: "node.retry", nodeId: "author" });
    state = reduceHubGraphEvent(state, { type: "node.queued", nodeId: "author" });
    state = reduceHubGraphEvent(state, { type: "node.started", nodeId: "author" });
    state = reduceHubGraphEvent(state, { type: "node.settled", nodeId: "author" });
    state = reduceHubGraphEvent(state, { type: "node.output_accepted", nodeId: "author" });
    state = reduceHubGraphEvent(state, { type: "interaction.requested", blockId: "review" });
    state = reduceHubGraphEvent(state, { type: "interaction.responder_dispatched", blockId: "review" });
    state = reduceHubGraphEvent(state, { type: "interaction.response_received", blockId: "review" });
    state = reduceHubGraphEvent(state, { type: "interaction.requested", blockId: "review" });
    state = reduceHubGraphEvent(state, { type: "interaction.responder_dispatched", blockId: "review" });
    state = reduceHubGraphEvent(state, { type: "interaction.response_received", blockId: "review" });
    state = reduceHubGraphEvent(state, { type: "interaction.exhausted", blockId: "review" });
    expect(state.interactions.review.status).toBe("exhausted");
    expect(state.nodes.reviewer).toBe("completed");
    expect(state.interactions.review.round).toBe(3);

    expect(() =>
      reduceHubGraphEvent(state, { type: "interaction.requested", blockId: "review" }),
    ).toThrow(HubGraphTransitionError);
  });

  it("allows only one authenticated decision for a pending Human Gate", () => {
    let state = reduceHubGraphEvent(createState(), { type: "graph.started" });
    state = reduceHubGraphEvent(state, { type: "gate.decided", gateId: "human_review", decision: "approve" });
    expect(state.gates.human_review).toBe("approved");

    expect(() =>
      reduceHubGraphEvent(state, { type: "gate.decided", gateId: "human_review", decision: "reject" }),
    ).toThrow(HubGraphTransitionError);
  });

  it("reopens a returned Human Gate for a new decision", () => {
    let state = reduceHubGraphEvent(createState(), { type: "graph.started" });
    state = reduceHubGraphEvent(state, { type: "gate.decided", gateId: "release", decision: "return" });
    expect(state.gates.release).toBe("returned");
    state = reduceHubGraphEvent(state, { type: "gate.reopened", gateId: "release" });
    expect(state.gates.release).toBe("pending");
    state = reduceHubGraphEvent(state, { type: "gate.decided", gateId: "release", decision: "approve" });
    expect(state.gates.release).toBe("approved");
  });

  it("rejects completion while any node, interaction or gate remains unresolved", () => {
    const state = reduceHubGraphEvent(createState(), { type: "graph.started" });
    expect(() =>
      reduceHubGraphEvent(state, { type: "graph.completed" }),
    ).toThrow(HubGraphTransitionError);
  });

  it("rejects events for unknown runtime targets", () => {
    const state = reduceHubGraphEvent(createState(), { type: "graph.started" });
    expect(() =>
      reduceHubGraphEvent(state, { type: "node.ready", nodeId: "missing" }),
    ).toThrow(HubGraphTransitionError);
  });
});
