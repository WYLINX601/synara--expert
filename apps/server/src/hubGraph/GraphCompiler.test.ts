import { describe, expect, it } from "vitest";

import { compileHubGraphDefinition } from "./GraphCompiler.ts";

const agent = (id: string, operation: "task" | "merge" | "decision" | "respond" = "task", inputs: unknown[] = []) => ({
  id,
  kind: "agent",
  expertId: `expert_${id}`,
  operation,
  prompt: { objective: `Do ${id}` },
  inputs,
  output: { kind: operation === "respond" ? "structured" : "artifact", required: true },
});

const validDefinition = () => ({
  schemaVersion: 1,
  objective: "Prepare and review a research report",
  sourceMessageIds: ["human-message-1"],
  nodes: [
    agent("market", "task", [{ kind: "user_request" }]),
    agent("competitor", "task", [{ kind: "user_request" }]),
    agent("synthesis", "merge", [
      { kind: "node_output", nodeId: "market" },
      { kind: "node_output", nodeId: "competitor" },
    ]),
    agent("reviewer", "respond"),
    {
      id: "release",
      kind: "human",
      operation: "gate",
      title: "Approve report",
      decisions: ["approve", "return", "reject"],
    },
  ],
  interactionBlocks: [
    {
      id: "review_loop",
      protocol: "review.v1",
      initiatorNodeId: "synthesis",
      responderNodeId: "reviewer",
      trigger: "initiator_request",
      maxRounds: 3,
    },
  ],
  edges: [
    { id: "market-synthesis", from: "market", to: "synthesis" },
    { id: "competitor-synthesis", from: "competitor", to: "synthesis" },
    { id: "synthesis-review", from: "synthesis", to: "review_loop" },
    {
      id: "review-release",
      from: "review_loop",
      to: "release",
      when: { field: "outcome", equals: "approved" },
    },
  ],
});

describe("Hub Graph compiler", () => {
  it("compiles a parallel DAG with an owned interaction responder and a Human Gate", () => {
    const result = compileHubGraphDefinition(validDefinition());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.graph.executionOrder).toEqual([
      "market",
      "competitor",
      "synthesis",
      "review_loop",
      "release",
    ]);
    expect(result.graph.interactionOwnedNodeIds).toEqual(["reviewer"]);
    expect(result.graph.incoming.synthesis).toEqual(["market", "competitor"]);
  });

  it("rejects duplicate IDs and missing references", () => {
    const definition = validDefinition();
    definition.nodes.push(agent("market"));
    const result = compileHubGraphDefinition(definition);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.some((entry) => entry.code === "duplicate_id")).toBe(true);
  });

  it("rejects an outer DAG cycle", () => {
    const definition = validDefinition();
    definition.edges.push({ id: "synthesis-market", from: "synthesis", to: "market" });
    const result = compileHubGraphDefinition(definition);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.some((entry) => entry.code === "cycle_detected")).toBe(true);
  });

  it("requires a merge node to have at least two upstream node outputs", () => {
    const definition = validDefinition();
    definition.nodes = definition.nodes.map((node) =>
      node.id === "synthesis"
        ? { ...node, inputs: [{ kind: "node_output", nodeId: "market" }] }
        : node,
    );
    const result = compileHubGraphDefinition(definition);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.some((entry) => entry.code === "invalid_input")).toBe(true);
  });

  it("requires a responder to use the respond operation and belong to one block", () => {
    const definition = validDefinition();
    definition.nodes = definition.nodes.map((node) =>
      node.id === "reviewer" ? { ...node, operation: "task" } : node,
    );
    const result = compileHubGraphDefinition(definition);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.some((entry) => entry.code === "invalid_role")).toBe(true);
  });

  it("rejects invalid protocol versions and excessive interaction rounds", () => {
    const definition = validDefinition();
    definition.interactionBlocks[0] = {
      ...definition.interactionBlocks[0],
      protocol: "review.latest",
      maxRounds: 11,
    };
    const result = compileHubGraphDefinition(definition);
    expect(result.ok).toBe(false);
  });
});
