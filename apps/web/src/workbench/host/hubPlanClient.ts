import type {
  HubDeliverableReadResult,
  HubDeliverableReferenceMetadata,
  ProjectId,
  ProjectAgentStreamEvent,
} from "@synara/contracts";

import { readNativeApi } from "~/nativeApi";

import { ensureHubPlansClient } from "./hubCollaborationClient";

/** Narrow feature capability for Hub plan commands and queries. */
export function getHubPlansClient() {
  return ensureHubPlansClient();
}

/** Read the exact immutable publication attached to a plan candidate. */
export async function readHubPlanDeliverable(
  reference: HubDeliverableReferenceMetadata,
): Promise<HubDeliverableReadResult> {
  // Ensure optional plan support was negotiated before using any related host
  // capability, so an older WS host never receives an unknown RPC.
  ensureHubPlansClient();
  const read = readNativeApi()?.projectAgent?.deliverables?.read;
  if (!read) throw new Error("当前服务端尚不支持固定版本成果查看，请更新服务端后重试。");
  const result = await read({
    projectId: reference.hubId,
    ownerThreadId: reference.workerThreadId,
    path: reference.file.path,
    revision: reference.revision,
  });
  if (
    result.hubId !== reference.hubId ||
    result.workerThreadId !== reference.workerThreadId ||
    result.revision !== reference.revision ||
    result.commitSha !== reference.commitSha ||
    result.file.path !== reference.file.path ||
    result.file.sha256 !== reference.file.sha256 ||
    result.file.mediaType !== reference.file.mediaType
  ) {
    throw new Error("服务返回的成果版本与计划记录不一致，已停止展示。");
  }
  return result;
}

/**
 * Observe the ProjectAgent snapshot already flowing through the current Hub
 * subscription. This does not acquire or release a transport subscription.
 */
export function observeHubProjectAgentSnapshots(
  projectId: ProjectId,
  listener: () => void,
): () => void {
  const api = readNativeApi()?.projectAgent;
  if (!api?.onEvent) return () => {};
  return api.onEvent((event: ProjectAgentStreamEvent) => {
    if (event.type === "snapshot" && event.overview.projectId === projectId) listener();
  });
}
