import { describe, expect, it } from "vitest";

import {
  WsBootstrapRpcGroup,
  WsFeatureRpcGroup,
  WsComputerRpcGroup,
  WsProjectAgentRpcGroup,
} from "./rpc";
import { COMPUTER_WS_METHODS } from "./computer";
import { ORCHESTRATION_WS_METHODS } from "./orchestration";
import { WS_METHODS } from "./ws";

describe("WS RPC contracts", () => {
  it("keeps bootstrap and feature RPCs in separate groups", () => {
    expect(WsBootstrapRpcGroup.requests.has("bootstrap.negotiate")).toBe(true);
    expect(WsFeatureRpcGroup.requests.has("bootstrap.negotiate")).toBe(false);
    expect(
      WsFeatureRpcGroup.requests.has(ORCHESTRATION_WS_METHODS.listProviderDeliveryBlockers),
    ).toBe(true);
    expect(WsFeatureRpcGroup.requests.has(ORCHESTRATION_WS_METHODS.reconcileProviderDelivery)).toBe(
      true,
    );
  });

  it("registers every computer method, including setup", () => {
    for (const method of Object.values(COMPUTER_WS_METHODS)) {
      expect(WsComputerRpcGroup.requests.has(method)).toBe(true);
    }
  });

  it("registers revision-guarded expert restore in the feature RPC group", () => {
    expect(WsFeatureRpcGroup.requests.has(WS_METHODS.serverRestoreExpert)).toBe(true);
  });

  it("registers revision-guarded expert delete in the feature RPC group", () => {
    expect(WsFeatureRpcGroup.requests.has(WS_METHODS.serverDeleteExpert)).toBe(true);
  });

  it("registers the fixed expert connection state and references RPCs", () => {
    expect(WsFeatureRpcGroup.requests.has("server.getExpertConnectionState")).toBe(true);
    expect(WsFeatureRpcGroup.requests.has("server.setExpertConnectionState")).toBe(true);
    expect(WsFeatureRpcGroup.requests.has("server.readExpertConnectionReferences")).toBe(true);
  });

  it("registers owner MCP discovery and import RPCs", () => {
    expect(WsFeatureRpcGroup.requests.has(WS_METHODS.serverDiscoverMcpConnections)).toBe(true);
    expect(WsFeatureRpcGroup.requests.has(WS_METHODS.serverImportMcpConnections)).toBe(true);
  });

  it("registers owner skill package lifecycle RPCs", () => {
    for (const method of [
      WS_METHODS.serverListSkillPackages,
      WS_METHODS.serverListSkillPackageSources,
      WS_METHODS.serverReadSkillPackage,
      WS_METHODS.serverPreviewSkillPackage,
      WS_METHODS.serverPreviewSkillPackageUpdate,
      WS_METHODS.serverPreviewSkillPackageRemoval,
      WS_METHODS.serverImportSkillPackage,
      WS_METHODS.serverRemoveSkillPackage,
    ]) {
      expect(WsFeatureRpcGroup.requests.has(method)).toBe(true);
    }
  });

  it("exports project-agent RPCs in a satellite group", () => {
    expect(WsProjectAgentRpcGroup.requests.has("projectAgent.linkProject")).toBe(true);
    expect(WsProjectAgentRpcGroup.requests.has("projectAgent.unlinkProject")).toBe(true);
    expect(WsProjectAgentRpcGroup.requests.has("projectAgent.getOverview")).toBe(true);
    expect(WsFeatureRpcGroup.requests.has("projectAgent.linkProject")).toBe(false);
    expect(WsFeatureRpcGroup.requests.has("projectAgent.getOverview")).toBe(false);
  });
});
