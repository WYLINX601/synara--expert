import type { NativeApi } from "@synara/contracts";
import {
  onNativeApiServerCapabilitiesChange,
  readNativeApi,
  readNativeApiServerConnection,
} from "~/nativeApi";

/** Read-only host capabilities for Hub composer discovery. Identity remains server-owned. */
export type HubReferenceClient = {
  listExperts: NonNullable<NativeApi["projectAgent"]["listExperts"]>;
  listDeliverables: NonNullable<NativeApi["projectAgent"]["deliverables"]>["list"];
};

export function readHubReferenceClient(): HubReferenceClient | null {
  const api = readNativeApi()?.projectAgent;
  if (!api?.listExperts || !api.deliverables?.list) return null;
  return { listExperts: api.listExperts, listDeliverables: api.deliverables.list };
}

export function hubReferenceConnectionGeneration(): string | null {
  const connection = readNativeApiServerConnection();
  return connection.connected ? connection.generation : null;
}

export function subscribeToHubReferenceConnection(listener: () => void): () => void {
  return onNativeApiServerCapabilitiesChange(listener);
}
