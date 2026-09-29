// FILE: runtimeLayer.ts
// Purpose: Assemble the existing Expert stores and runtime access used by Workbench RPCs.
// Layer: Server Workbench integration boundary

import type { ExpertAppliedRuntimeReadInput } from "@synara/contracts";

import { connectExpertMcp } from "../experts/ExpertMcpClient.ts";
import { createExpertConnectionStore } from "../experts/ExpertConnectionStore.ts";
import { createExpertStore } from "../experts/ExpertStore.ts";
import type { ExpertAppliedRuntimeRepositoryShape } from "../persistence/Services/ExpertAppliedRuntimeRecords.ts";

export function createWorkbenchExpertRuntime(input: {
  readonly stateDir: string;
  readonly expertAppliedRuntimeRepository: Pick<
    ExpertAppliedRuntimeRepositoryShape,
    "getByThreadId"
  >;
  readonly connect?: typeof connectExpertMcp;
}) {
  const experts = createExpertStore(input.stateDir);
  const connections = createExpertConnectionStore(input.stateDir);
  const connect = input.connect ?? connectExpertMcp;

  return {
    experts,
    connections,
    readAppliedRuntime: (request: ExpertAppliedRuntimeReadInput) =>
      input.expertAppliedRuntimeRepository.getByThreadId(request),
    testConnection: async (connectionId: string) => {
      const config = await connections.read(connectionId);
      if (!config) throw new Error(`Expert connection not found: ${connectionId}`);
      const client = await connect(config);
      try {
        return { tools: client.tools.map((tool) => tool.name) };
      } finally {
        await client.close();
      }
    },
  };
}
