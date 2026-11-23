import { assert, it } from "@effect/vitest";
import { Effect, Schema } from "effect";

import {
  HubGraphDefinition,
  HubGraphGateStatus,
  HubGraphInteractionBlock,
  HubGraphNode,
} from "./hubGraph";

it.effect("decodes an Agent DAG node and a Human Gate", () =>
  Effect.gen(function* () {
    const agent = yield* Schema.decodeUnknownEffect(HubGraphNode)({
      id: "research",
      kind: "agent",
      expertId: "research_expert",
      operation: "task",
      prompt: { objective: "Research the market" },
      inputs: [{ kind: "user_request" }],
      output: { kind: "artifact", required: true },
    });
    assert.strictEqual(agent.kind, "agent");

    const gate = yield* Schema.decodeUnknownEffect(HubGraphNode)({
      id: "release",
      kind: "human",
      operation: "gate",
      title: "Approve release",
      decisions: ["approve", "return", "reject"],
    });
    assert.strictEqual(gate.kind, "human");
  }),
);

it.effect("requires a versioned protocol identifier and bounded round count", () =>
  Effect.gen(function* () {
    const valid = yield* Schema.decodeUnknownEffect(HubGraphInteractionBlock)({
      id: "review",
      protocol: "review.v1",
      initiatorNodeId: "author",
      responderNodeId: "reviewer",
      trigger: "initiator_request",
      maxRounds: 3,
    });
    assert.strictEqual(valid.maxRounds, 3);

    assert.throws(() =>
      Schema.decodeUnknownSync(HubGraphInteractionBlock)({
        id: "review",
        protocol: "review.latest",
        initiatorNodeId: "author",
        responderNodeId: "reviewer",
        trigger: "initiator_request",
        maxRounds: 3,
      }),
    );
  }),
);

it.effect("rejects unknown definition fields and unsupported schema versions", () =>
  Effect.gen(function* () {
    const definition = {
      schemaVersion: 1,
      objective: "Research",
      sourceMessageIds: ["message-1"],
      nodes: [
        {
          id: "research",
          kind: "agent",
          expertId: "research_expert",
          operation: "task",
          prompt: { objective: "Research" },
          inputs: [{ kind: "user_request" }],
          output: { kind: "artifact", required: true },
        },
      ],
      interactionBlocks: [],
      edges: [],
    };
    const decoded = yield* Schema.decodeUnknownEffect(HubGraphDefinition)(definition);
    assert.strictEqual(decoded.schemaVersion, 1);
    assert.throws(() =>
      Schema.decodeUnknownSync(HubGraphDefinition)({ ...definition, schemaVersion: 2 }),
    );
    assert.throws(() =>
      Schema.decodeUnknownSync(HubGraphDefinition)({ ...definition, unexpected: true }),
    );
  }),
);

it.effect("keeps returned gates distinct from approved gates", () =>
  Effect.gen(function* () {
    const returned = yield* Schema.decodeUnknownEffect(HubGraphGateStatus)("returned");
    const approved = yield* Schema.decodeUnknownEffect(HubGraphGateStatus)("approved");
    assert.notStrictEqual(returned, approved);
  }),
);
