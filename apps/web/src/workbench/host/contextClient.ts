// FILE: contextClient.ts
// Purpose: Expose the existing server-owned Context API and legacy migration cache to web features.
// Layer: Web Workbench host integration

import { WS_CONTEXT_V1_CAPABILITY, type ContextApi, type ProjectId } from "@synara/contracts";

import { useNativeApiServerCapabilitySnapshot } from "~/hooks/useNativeApiServerCapability";
import { useProjectInstructionsStore } from "~/projectInstructionsStore";
import {
  readNativeApi,
  readNativeApiServerCapabilityState,
  readNativeApiServerConnection,
  type NativeApiServerCapabilityState,
} from "~/nativeApi";

export interface ContextClientSnapshot {
  /** Whether the connected server advertises Context v1, independent of API connectivity. */
  readonly supported: boolean;
  readonly capability: NativeApiServerCapabilityState;
  readonly generation: string | null;
  readonly connected: boolean;
  readonly available: boolean;
  /** The native API's original Context object; it is never wrapped or copied. */
  readonly api: ContextApi | null;
}

/** Read the current capability and the original host-owned Context API synchronously. */
export function readContextClient(): ContextClientSnapshot {
  const api = readNativeApi()?.context ?? null;
  const { generation, connected } = readNativeApiServerConnection();
  const capability = connected
    ? readNativeApiServerCapabilityState(WS_CONTEXT_V1_CAPABILITY)
    : "unknown";
  return {
    capability,
    generation,
    connected,
    available: capability === "supported" && connected && api !== null,
    supported: capability === "supported",
    api,
  };
}

/** Subscribe React features to the existing server-capability lifecycle. */
export function useContextClient(): ContextClientSnapshot {
  const {
    capability: advertised,
    api,
    generation,
    connected,
  } = useNativeApiServerCapabilitySnapshot(WS_CONTEXT_V1_CAPABILITY);
  const capability = connected ? advertised : "unknown";
  return {
    capability,
    generation,
    connected,
    available: capability === "supported" && connected && Boolean(api?.context),
    supported: capability === "supported",
    api: api?.context ?? null,
  };
}

/** Read the legacy instructions cache without changing, clearing, or relocating its storage. */
export function readLegacyProjectInstructions(projectId: ProjectId): string {
  return useProjectInstructionsStore.getState().instructionsByProjectId[projectId] ?? "";
}

// Query caches must follow the original connection identity, like the autosave registry.
const apiIdentities = new WeakMap<ContextApi, number>();
let nextApiIdentity = 1;
export function contextApiQueryIdentity(api: ContextApi | null): number | null {
  if (!api) return null;
  let identity = apiIdentities.get(api);
  if (identity === undefined) {
    identity = nextApiIdentity++;
    apiIdentities.set(api, identity);
  }
  return identity;
}
