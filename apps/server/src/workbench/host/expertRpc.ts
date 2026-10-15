import {
  WS_METHODS,
  WsRpcError,
  type ExpertAppliedRuntimeReadInput,
  type ExpertArchiveInput,
  type ExpertDeleteInput,
  type ExpertConnectionReferencesInput,
  type ExpertConnectionRemoveInput,
  type ExpertConnectionSaveInput,
  type ExpertConnectionTestInput,
  type ExpertPreviewInput,
  type ExpertReadInput,
  type ExpertRestoreInput,
  type ExpertSaveInput,
  type ExpertSnapshotReadInput,
  type McpConnectionSetStateInput,
  type McpDiscoveryRequest,
  type McpImportRequest,
  type OrchestrationThread,
} from "@synara/contracts";
import { Effect, Option } from "effect";

import type { createWorkbenchExpertRuntime } from "../runtimeLayer.ts";

type WorkbenchExpertRuntime = ReturnType<typeof createWorkbenchExpertRuntime>;
type RpcEffect = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  fallbackMessage: string,
) => Effect.Effect<A, WsRpcError, R>;
type ExpertRpcEffect = <A, E, R>(
  authorization: Effect.Effect<void, E, R>,
  operation: () => Promise<A>,
  fallbackMessage: string,
) => Effect.Effect<A, WsRpcError, R>;
type ExpertReferenceThread = Pick<OrchestrationThread, "id" | "title" | "expertBinding">;

/**
 * Assemble the static Expert/MCP method handlers consumed by the WebSocket RPC map.
 * Authorization and error boundaries are supplied by wsRpc so their ownership and
 * behavior remain at the native RPC entry point.
 */
export function makeWorkbenchExpertRpcHandlers<R>(input: {
  readonly runtime: WorkbenchExpertRuntime;
  readonly requireOwner: Effect.Effect<void, WsRpcError, R>;
  readonly rpcEffect: RpcEffect;
  readonly expertRpcEffect: ExpertRpcEffect;
  readonly loadProjectionThreads: () => Effect.Effect<
    ReadonlyArray<ExpertReferenceThread>,
    unknown
  >;
}) {
  const { runtime, requireOwner, rpcEffect, expertRpcEffect, loadProjectionThreads } = input;

  return {
    [WS_METHODS.serverListExperts]: () =>
      expertRpcEffect(requireOwner, () => runtime.experts.list(), "Failed to list experts"),
    [WS_METHODS.serverReadExpert]: (input: ExpertReadInput) =>
      expertRpcEffect(requireOwner, () => runtime.experts.read(input.id), "Failed to read expert"),
    [WS_METHODS.serverSaveExpert]: (input: ExpertSaveInput) =>
      expertRpcEffect(requireOwner, () => runtime.experts.save(input), "Failed to save expert"),
    [WS_METHODS.serverArchiveExpert]: (input: ExpertArchiveInput) =>
      expertRpcEffect(
        requireOwner,
        () => runtime.experts.archive(input.id, input.expectedRevision),
        "Failed to archive expert",
      ),
    [WS_METHODS.serverRestoreExpert]: (input: ExpertRestoreInput) =>
      expertRpcEffect(
        requireOwner,
        () => runtime.experts.restore(input.id, input.expectedRevision),
        "Failed to restore expert",
      ),
    [WS_METHODS.serverDeleteExpert]: (input: ExpertDeleteInput) =>
      expertRpcEffect(
        requireOwner,
        () => runtime.experts.remove(input.id, input.expectedRevision),
        "Failed to delete expert",
      ),
    [WS_METHODS.serverPreviewExpert]: (input: ExpertPreviewInput) =>
      expertRpcEffect(
        requireOwner,
        () => runtime.experts.preview(input),
        "Failed to preview expert",
      ),
    [WS_METHODS.serverReadExpertSnapshot]: (input: ExpertSnapshotReadInput) =>
      expertRpcEffect(
        requireOwner,
        () => runtime.experts.readSnapshot(input.snapshotId),
        "Failed to read expert snapshot",
      ),
    [WS_METHODS.serverReadExpertAppliedRuntime]: (input: ExpertAppliedRuntimeReadInput) =>
      rpcEffect(
        requireOwner.pipe(
          Effect.andThen(runtime.readAppliedRuntime(input)),
          Effect.map(Option.getOrNull),
        ),
        "Failed to read Expert applied runtime",
      ),
    [WS_METHODS.serverListExpertConnections]: () =>
      expertRpcEffect(
        requireOwner,
        () => runtime.connections.list(),
        "Failed to list expert connections",
      ),
    [WS_METHODS.serverSaveExpertConnection]: (input: ExpertConnectionSaveInput) =>
      expertRpcEffect(
        requireOwner,
        () => runtime.connections.save(input),
        "Failed to save expert connection",
      ),
    [WS_METHODS.serverRemoveExpertConnection]: (input: ExpertConnectionRemoveInput) =>
      expertRpcEffect(
        requireOwner,
        () => runtime.connections.remove(input.id, input.expectedRevision),
        "Failed to remove expert connection",
      ),
    [WS_METHODS.serverTestExpertConnection]: (input: ExpertConnectionTestInput) =>
      expertRpcEffect(
        requireOwner,
        () => runtime.testConnection(input),
        "Failed to test expert connection",
      ),
    [WS_METHODS.serverGetExpertConnectionState]: (input: ExpertConnectionReferencesInput) =>
      expertRpcEffect(
        requireOwner,
        () => runtime.getExpertConnectionState(input.id),
        "Failed to read expert connection state",
      ),
    [WS_METHODS.serverSetExpertConnectionState]: (input: McpConnectionSetStateInput) =>
      expertRpcEffect(
        requireOwner,
        () => runtime.setExpertConnectionState(input),
        "Failed to update expert connection state",
      ),
    [WS_METHODS.serverReadExpertConnectionReferences]: (input: ExpertConnectionReferencesInput) =>
      rpcEffect(
        requireOwner.pipe(
          Effect.andThen(
            Effect.tryPromise({
              try: () => runtime.readExpertConnectionReferences(input.id),
              catch: (cause) => cause,
            }),
          ),
          Effect.flatMap((references) =>
            loadProjectionThreads().pipe(
              Effect.map((threads) => {
                const snapshotReferences = new Map(
                  references.snapshots.map((reference) => [reference.snapshotId, reference]),
                );
                const tasks = threads.flatMap((thread) => {
                  const snapshotId = thread.expertBinding?.snapshotId;
                  if (!snapshotId) return [];
                  const reference = snapshotReferences.get(snapshotId);
                  if (!reference) return [];
                  return [
                    {
                      threadId: thread.id,
                      title: thread.title,
                      snapshotId,
                      ...(reference.configRevision === undefined
                        ? {}
                        : { configRevision: reference.configRevision }),
                      required: reference.required,
                    },
                  ];
                });
                return {
                  experts: references.experts,
                  snapshots: references.snapshots,
                  tasks,
                  activeSessionCount: references.activeSessionCount,
                };
              }),
            ),
          ),
        ),
        "Failed to read expert connection references",
      ),
    [WS_METHODS.serverDiscoverMcpConnections]: (input: McpDiscoveryRequest) =>
      expertRpcEffect(
        requireOwner,
        () => runtime.discoverMcpConnections(input),
        "Failed to discover MCP connections",
      ),
    [WS_METHODS.serverImportMcpConnections]: (input: McpImportRequest) =>
      expertRpcEffect(
        requireOwner,
        () => runtime.importMcpConnections(input),
        "Failed to import MCP connections",
      ),
  };
}
