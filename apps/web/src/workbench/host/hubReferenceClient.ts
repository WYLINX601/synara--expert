import type { NativeApi, ProjectId } from "@synara/contracts";
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

/** Existing stream snapshots also refresh after reconnection / a missed notification. */
export function subscribeToHubDeliverableChanges(
  projectId: ProjectId,
  listener: () => void,
): () => void {
  const api = readNativeApi()?.projectAgent;
  if (!api) return () => {};
  const release =
    api.onEvent?.((event) => {
      if (
        (event.type === "deliverables-changed" && event.projectId === projectId) ||
        (event.type === "snapshot" && event.overview.projectId === projectId)
      )
        listener();
    }) ?? (() => {});
  // The Library may be open while the Hub panel is closed. Own a reference to
  // the native subscription instead of relying on another panel to keep it live.
  void api.subscribe?.({ projectId }).catch(() => undefined);
  return () => {
    release();
    void api.unsubscribe?.({ projectId }).catch(() => undefined);
  };
}
