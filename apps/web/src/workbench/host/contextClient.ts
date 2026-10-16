// FILE: contextClient.ts
// Purpose: Expose the existing server-owned Context API and legacy migration cache to web features.
// Layer: Web Workbench host integration

import { WS_CONTEXT_V1_CAPABILITY, type ContextApi, type ProjectId } from "@synara/contracts";

import { useNativeApiServerCapability } from "~/hooks/useNativeApiServerCapability";
import { useProjectInstructionsStore } from "~/projectInstructionsStore";
import { readNativeApi, readNativeApiServerCapability } from "~/nativeApi";

export interface ContextClientSnapshot {
  /** Whether the connected server advertises Context v1, independent of API connectivity. */
  readonly supported: boolean;
  /** The native API's original Context object; it is never wrapped or copied. */
  readonly api: ContextApi | null;
}

/** Read the current capability and the original host-owned Context API synchronously. */
export function readContextClient(): ContextClientSnapshot {
  return {
    supported: readNativeApiServerCapability(WS_CONTEXT_V1_CAPABILITY),
    api: readNativeApi()?.context ?? null,
  };
}

/** Subscribe React features to the existing server-capability lifecycle. */
export function useContextClient(): ContextClientSnapshot {
  const supported = useNativeApiServerCapability(WS_CONTEXT_V1_CAPABILITY);
  return { supported, api: readNativeApi()?.context ?? null };
}

/** Read the legacy instructions cache without changing, clearing, or relocating its storage. */
export function readLegacyProjectInstructions(projectId: ProjectId): string {
  return useProjectInstructionsStore.getState().instructionsByProjectId[projectId] ?? "";
}
