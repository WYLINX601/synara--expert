// FILE: runtimeLayer.ts
// Purpose: Assemble the existing Expert stores and runtime access used by Workbench RPCs.
// Layer: Server Workbench integration boundary

import type {
  ExpertAppliedRuntimeReadInput,
  ExpertConnectionTestInput,
  McpDiscoveryRequest,
  McpImportRequest,
} from "@synara/contracts";
import { Effect } from "effect";

import { connectExpertMcp } from "../experts/ExpertMcpClient.ts";
import { createExpertMcpCredentialStore } from "../experts/ExpertMcpCredentials.ts";
import { createLocalMcpDiscovery } from "../experts/LocalMcpDiscovery.ts";
import {
  createExpertConnectionStore,
  ExpertConnectionStoreError,
  scanExpertConnectionReferences,
} from "../experts/ExpertConnectionStore.ts";
import { readExpertMcpActiveSessionCount } from "../experts/ExpertGatewayTools.ts";
import { createExpertStore } from "../experts/ExpertStore.ts";
import { createSkillPackageStore } from "../experts/SkillPackageStore.ts";
import {
  createSkillPackageSwitchService,
  type SkillPackageSwitchHost,
} from "../experts/SkillPackageSwitch.ts";
import type { ExpertAppliedRuntimeRepositoryShape } from "../persistence/Services/ExpertAppliedRuntimeRecords.ts";

export function createWorkbenchExpertRuntime(input: {
  readonly stateDir: string;
  readonly expertAppliedRuntimeRepository: Pick<
    ExpertAppliedRuntimeRepositoryShape,
    "getByThreadId"
  > &
    Partial<Pick<ExpertAppliedRuntimeRepositoryShape, "listAll">>;
  readonly connect?: typeof connectExpertMcp;
}) {
  const experts = createExpertStore(input.stateDir);
  const skillPackages = createSkillPackageStore(input.stateDir);
  const connections = createExpertConnectionStore(input.stateDir);
  const credentials = createExpertMcpCredentialStore(input.stateDir);
  const mcpDiscovery = createLocalMcpDiscovery({ connections, credentials });
  const connect = input.connect ?? ((config) => connectExpertMcp(config, { credentials }));

  return {
    experts,
    skillPackages,
    createSkillPackageSwitchService: (host: SkillPackageSwitchHost) =>
      createSkillPackageSwitchService({
        stateDir: input.stateDir,
        experts,
        packages: skillPackages,
        host,
      }),
    removeSkillPackage: (packageId: string) => skillPackages.remove(packageId),
    connections,
    discoverMcpConnections: (request: McpDiscoveryRequest) => mcpDiscovery.discover(request),
    importMcpConnections: (request: McpImportRequest) => mcpDiscovery.importSelected(request),
    readAppliedRuntime: (request: ExpertAppliedRuntimeReadInput) =>
      input.expertAppliedRuntimeRepository.getByThreadId(request),
    readAppliedRuntimeRecords: () =>
      input.expertAppliedRuntimeRepository.listAll?.() ??
      Effect.fail(new Error("Expert applied runtime inventory is unavailable.")),
    getExpertConnectionState: (id: string) => connections.readState(id),
    setExpertConnectionState: (request: Parameters<typeof connections.setState>[0]) =>
      connections.setState(request),
    readExpertConnectionReferences: async (id: string) => {
      const references = await scanExpertConnectionReferences(input.stateDir, id);
      return {
        ...references,
        tasks: [],
        activeSessionCount: readExpertMcpActiveSessionCount(input.stateDir, id),
      };
    },
    testConnection: async (request: ExpertConnectionTestInput) => {
      const initialState = await connections.readState(request.id);
      if (initialState.status !== "active") {
        throw new Error(`Expert connection is ${initialState.status}: ${request.id}`);
      }
      const config = await connections.read(request.id);
      if (!config) throw new Error(`Expert connection not found: ${request.id}`);
      if (request.expectedRevision !== undefined && request.expectedRevision !== config.revision) {
        throw new ExpertConnectionStoreError(
          "Expert connection changed; reload before testing.",
          "revision_conflict",
        );
      }
      const currentState = await connections.readState(request.id);
      if (currentState.status !== "active") {
        throw new Error(`Expert connection is ${currentState.status}: ${request.id}`);
      }
      const client = await connect(config);
      try {
        const finalState = await connections.readState(request.id);
        if (finalState.status !== "active") {
          throw new Error(`Expert connection is ${finalState.status}: ${request.id}`);
        }
        return { tools: client.tools.map((tool) => tool.name), revision: config.revision };
      } finally {
        await client.close();
      }
    },
  };
}
