import { Schema } from "effect";

import {
  HubGraphDefinition,
  type HubGraphAgentNode,
  type HubGraphDefinition as HubGraphDefinitionType,
  type HubGraphEdge,
  type HubGraphInteractionBlock,
  type HubGraphNode,
} from "@synara/contracts";

export type HubGraphCompileIssueCode =
  | "invalid_definition"
  | "duplicate_id"
  | "missing_reference"
  | "invalid_role"
  | "invalid_input"
  | "invalid_edge"
  | "invalid_interaction"
  | "invalid_output"
  | "unreachable_node"
  | "cycle_detected";

export interface HubGraphCompileIssue {
  readonly code: HubGraphCompileIssueCode;
  readonly path: string;
  readonly message: string;
}

export interface CompiledHubGraph {
  readonly definition: HubGraphDefinitionType;
  /** Stable topological order across Agent Nodes, Human Nodes and Interaction Blocks. */
  readonly executionOrder: readonly string[];
  readonly incoming: Readonly<Record<string, readonly string[]>>;
  readonly outgoing: Readonly<Record<string, readonly string[]>>;
  readonly nodeById: Readonly<Record<string, HubGraphNode>>;
  readonly interactionById: Readonly<Record<string, HubGraphInteractionBlock>>;
  /** Nodes which are responders are activated only by their owning Interaction Block. */
  readonly interactionOwnedNodeIds: readonly string[];
}

export type HubGraphCompileResult =
  | { readonly ok: true; readonly graph: CompiledHubGraph }
  | { readonly ok: false; readonly issues: readonly HubGraphCompileIssue[] };

const issue = (
  code: HubGraphCompileIssueCode,
  path: string,
  message: string,
): HubGraphCompileIssue => ({ code, path, message });

const unique = (values: readonly string[]) => new Set(values).size === values.length;

const isAgentNode = (node: HubGraphNode): node is HubGraphAgentNode => node.kind === "agent";

function stableTopologicalSort(
  vertices: readonly string[],
  outgoing: ReadonlyMap<string, ReadonlySet<string>>,
  incoming: ReadonlyMap<string, ReadonlySet<string>>,
): { readonly order: readonly string[]; readonly cyclic: readonly string[] } {
  const rank = new Map(vertices.map((id, index) => [id, index]));
  const indegree = new Map(vertices.map((id) => [id, incoming.get(id)?.size ?? 0]));
  const ready = vertices.filter((id) => indegree.get(id) === 0);
  const order: string[] = [];

  while (ready.length > 0) {
    ready.sort((a, b) => rank.get(a)! - rank.get(b)!);
    const current = ready.shift()!;
    order.push(current);
    for (const next of outgoing.get(current) ?? []) {
      const remaining = indegree.get(next)! - 1;
      indegree.set(next, remaining);
      if (remaining === 0) ready.push(next);
    }
  }

  return {
    order,
    cyclic: vertices.filter((id) => !order.includes(id)),
  };
}

/**
 * Compile and validate a declarative Hub Graph without performing I/O.
 * Interaction Blocks are virtual vertices in the outer DAG; their responder
 * nodes are owned by the block and are not independently scheduled.
 */
export function compileHubGraphDefinition(input: unknown): HubGraphCompileResult {
  let definition: HubGraphDefinitionType;
  try {
    definition = Schema.decodeUnknownSync(HubGraphDefinition)(input);
  } catch (error) {
    return {
      ok: false,
      issues: [
        issue(
          "invalid_definition",
          "$",
          error instanceof Error ? error.message : "Graph definition is invalid.",
        ),
      ],
    };
  }

  const issues: HubGraphCompileIssue[] = [];
  const nodeIds = definition.nodes.map((node) => node.id);
  const blockIds = definition.interactionBlocks.map((block) => block.id);
  const edgeIds = definition.edges.map((edge) => edge.id);
  const allIds = [...nodeIds, ...blockIds];

  if (!unique(nodeIds)) issues.push(issue("duplicate_id", "nodes", "Node IDs must be unique."));
  if (!unique(blockIds)) {
    issues.push(issue("duplicate_id", "interactionBlocks", "Interaction Block IDs must be unique."));
  }
  if (!unique(edgeIds)) issues.push(issue("duplicate_id", "edges", "Edge IDs must be unique."));
  for (const id of blockIds) {
    if (nodeIds.includes(id)) {
      issues.push(issue("duplicate_id", "interactionBlocks", \`ID "\${id}" is already used by a node.\`));
    }
  }

  const nodeById = Object.fromEntries(definition.nodes.map((node) => [node.id, node]));
  const interactionById = Object.fromEntries(
    definition.interactionBlocks.map((block) => [block.id, block]),
  );
  const vertices = [...new Set(allIds)];
  const outgoing = new Map(vertices.map((id) => [id, new Set<string>()]));
  const incoming = new Map(vertices.map((id) => [id, new Set<string>()]));

  const addDependency = (from: string, to: string, path: string) => {
    if (!outgoing.has(from) || !incoming.has(to)) {
      issues.push(
        issue("missing_reference", path, \`Dependency "\${from}" → "\${to}" references an unknown vertex.\`),
      );
      return;
    }
    outgoing.get(from)!.add(to);
    incoming.get(to)!.add(from);
  };

  const responderOwners = new Map<string, string>();
  const participantOwners = new Map<string, string>();

  definition.interactionBlocks.forEach((block, index) => {
    const path = \`interactionBlocks[\${index}]\`;
    const initiator = nodeById[block.initiatorNodeId];
    const responder = nodeById[block.responderNodeId];

    if (!initiator || !responder) {
      issues.push(issue("missing_reference", path, "Interaction participants must reference existing nodes."));
      return;
    }
    if (initiator.kind !== "agent" || responder.kind !== "agent") {
      issues.push(issue("invalid_role", path, "Interaction initiator and responder must both be Agent Nodes."));
      return;
    }
    if (initiator.id === responder.id) {
      issues.push(issue("invalid_interaction", path, "An Interaction Block requires two distinct Agent Nodes."));
    }
    if (responder.operation !== "respond") {
      issues.push(issue("invalid_role", path, "The responder must use the respond operation."));
    }
    if (initiator.operation === "respond") {
      issues.push(issue("invalid_role", path, "A responder operation cannot initiate an Interaction Block."));
    }
    if (block.maxRounds > 10) {
      issues.push(issue("invalid_interaction", \`\${path}.maxRounds\`, "Interaction rounds cannot exceed the hard limit of 10."));
    }

    for (const participantId of [initiator.id, responder.id]) {
      const owner = participantOwners.get(participantId);
      if (owner && owner !== block.id) {
        issues.push(
          issue("invalid_interaction", path, \`Node "\${participantId}" already participates in Interaction Block "\${owner}".\`),
        );
      } else {
        participantOwners.set(participantId, block.id);
      }
    }
    responderOwners.set(responder.id, block.id);

    // The initiator must complete before the protocol can start. The responder
    // is activated by the block itself, not by an independent outer-DAG edge.
    addDependency(initiator.id, block.id, path);
  });

  definition.nodes.forEach((node, index) => {
    if (node.kind !== "agent") return;
    const path = \`nodes[\${index}]\`;
    if (node.operation !== "respond" && !node.output) {
      issues.push(issue("invalid_output", \`\${path}.output\`, "Task, merge and decision nodes require an output contract.") as HubGraphCompileIssue);
    }
    if (node.operation === "respond" && !node.output) {
      issues.push(issue("invalid_output", \`\${path}.output\`, "Respond nodes require a structured output contract.") as HubGraphCompileIssue);
    }
    const seenInputs = new Set<string>();
    node.inputs.forEach((input, inputIndex) => {
      const key =
        input.kind === "node_output"
          ? \`node:\${input.nodeId}\`
          : input.kind === "interaction_response"
            ? \`interaction:\${input.blockId}\`
            : "user_request";
      if (seenInputs.has(key)) {
        issues.push(issue("invalid_input", \`\${path}.inputs[\${inputIndex}]\`, "Input references must be unique."));
      }
      seenInputs.add(key);

      if (input.kind === "node_output") {
        const source = nodeById[input.nodeId];
        if (!source) {
          issues.push(issue("missing_reference", \`\${path}.inputs[\${inputIndex}]\`, \`Node "\${input.nodeId}" does not exist.\`));
        } else if (source.id === node.id) {
          issues.push(issue("invalid_input", \`\${path}.inputs[\${inputIndex}]\`, "A node cannot consume its own output."));
        } else {
          addDependency(source.id, node.id, \`\${path}.inputs[\${inputIndex}]\`);
        }
      } else if (input.kind === "interaction_response") {
        const block = interactionById[input.blockId];
        if (!block) {
          issues.push(issue("missing_reference", \`\${path}.inputs[\${inputIndex}]\`, \`Interaction Block "\${input.blockId}" does not exist.\`));
        } else if (block.responderNodeId !== node.id && block.initiatorNodeId !== node.id) {
          issues.push(issue("invalid_input", \`\${path}.inputs[\${inputIndex}]\`, "Only a participant can consume this Interaction Block response."));
        } else {
          addDependency(block.id, node.id, \`\${path}.inputs[\${inputIndex}]\`);
        }
      }
    });

    if (node.operation === "merge" && node.inputs.filter((input) => input.kind === "node_output").length < 2) {
      issues.push(issue("invalid_input", \`\${path}.inputs\`, "Merge nodes require at least two node outputs."));
    }
    if (node.operation === "respond" && !responderOwners.has(node.id)) {
      issues.push(issue("invalid_role", path, "Respond nodes must be owned by an Interaction Block."));
    }
  });

  definition.edges.forEach((edge, index) => {
    const path = \`edges[\${index}]\`;
    if (!vertices.includes(edge.from) || !vertices.includes(edge.to)) {
      issues.push(issue("missing_reference", path, "Edge endpoints must reference an existing node or Interaction Block."));
      return;
    }
    if (edge.from === edge.to) {
      issues.push(issue("invalid_edge", path, "Self edges are not allowed."));
      return;
    }
    const fromBlock = interactionById[edge.from];
    const toBlock = interactionById[edge.to];
    if (fromBlock && toBlock) {
      issues.push(issue("invalid_edge", path, "Direct Interaction Block to Interaction Block edges are not supported."));
      return;
    }
    if (fromBlock && nodeById[edge.to]?.id === fromBlock.responderNodeId) {
      issues.push(issue("invalid_edge", path, "Interaction responders are activated by their block, not by an external edge."));
      return;
    }
    if (toBlock && edge.from !== toBlock.initiatorNodeId) {
      issues.push(issue("invalid_edge", path, "An Interaction Block can only be entered from its initiator."));
      return;
    }
    if (edge.when && (!nodeById[edge.from] || !isAgentNode(nodeById[edge.from]!))) {
      issues.push(issue("invalid_edge", path, "Conditional edges must originate from an Agent Node."));
      return;
    }
    addDependency(edge.from, edge.to, path);
  });

  if (issues.length > 0) return { ok: false, issues };

  // Nodes with explicit incoming dependencies must be reachable from a user
  // request source, either directly or through another dependency.
  const roots = definition.nodes
    .filter((node) => node.kind === "agent" && node.inputs.some((input) => input.kind === "user_request"))
    .map((node) => node.id);
  const reachable = new Set<string>(roots);
  const queue = [...roots];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const next of outgoing.get(current) ?? []) {
      if (!reachable.has(next)) {
        reachable.add(next);
        queue.push(next);
      }
    }
  }
  const unreachable = definition.nodes.filter(
    (node) => node.kind === "agent" && !reachable.has(node.id) && !responderOwners.has(node.id),
  );
  for (const node of unreachable) {
    issues.push(issue("unreachable_node", \`nodes.\${node.id}\`, \`Node "\${node.id}" is not reachable from a user request.\`));
  }

  const sorted = stableTopologicalSort(vertices, outgoing, incoming);
  if (sorted.cyclic.length > 0) {
    issues.push(
      issue("cycle_detected", "$.edges", \`Outer Graph contains a cycle involving: \${sorted.cyclic.join(", ")}.\`),
    );
  }
  if (issues.length > 0) return { ok: false, issues };

  const asRecord = (map: ReadonlyMap<string, ReadonlySet<string>>) =>
    Object.fromEntries([...map].map(([id, values]) => [id, [...values].sort()]));

  return {
    ok: true,
    graph: {
      definition,
      executionOrder: sorted.order.filter((id) => !responderOwners.has(id)),
      incoming: asRecord(incoming),
      outgoing: asRecord(outgoing),
      nodeById,
      interactionById,
      interactionOwnedNodeIds: [...responderOwners.keys()].sort(),
    },
  };
}
