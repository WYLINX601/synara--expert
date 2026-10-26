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
  type ProviderSkillReference,
  type ProviderExpertSession,
  type ProviderListCommandsInput,
  type ProviderListCommandsResult,
  type ProviderListSkillsInput,
  type ProviderListSkillsResult,
  type ExpertSnapshot,
  type ExpertReadInput,
  type ExpertRestoreInput,
  type ExpertSaveInput,
  type ExpertSnapshotReadInput,
  type SkillLibraryRequest,
  type SkillPackageImportInput,
  type SkillPackagePreviewInput,
  type SkillPackageReadInput,
  type SkillPackageRemoveInput,
  type SkillPackageUpdatePreviewInput,
  type SkillPackageSwitchApplyInput,
  type SkillPackageSwitchInput,
  type SkillPackageSwitchProgressReadInput,
  type McpConnectionSetStateInput,
  type McpDiscoveryRequest,
  type McpImportRequest,
  type OrchestrationThread,
} from "@synara/contracts";
import { Effect, Option } from "effect";
import {
  CurrentManagedAttachmentPrincipal,
  type ManagedAttachmentPrincipal,
} from "../../managedAttachmentPrincipal.ts";

import type { createWorkbenchExpertRuntime } from "../runtimeLayer.ts";
import type { SkillPackageSwitchHost } from "../../experts/SkillPackageSwitch.ts";

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
  readonly previewProvider?: (
    request: ExpertPreviewInput,
    skills: ReadonlyArray<ProviderSkillReference>,
  ) => Effect.Effect<ReadonlyArray<string>, unknown>;

  readonly requireOwner: Effect.Effect<void, WsRpcError, R>;
  readonly requireSkillOwner?: Effect.Effect<void, WsRpcError, R>;
  readonly rpcEffect: RpcEffect;
  readonly expertRpcEffect: ExpertRpcEffect;
  readonly loadProjectionThreads: () => Effect.Effect<
    ReadonlyArray<ExpertReferenceThread>,
    unknown
  >;
  readonly createSkillPackageSwitchHost?: (
    principal: ManagedAttachmentPrincipal,
  ) => SkillPackageSwitchHost;
}) {
  const { runtime, requireOwner, rpcEffect, expertRpcEffect, loadProjectionThreads } = input;
  const withSkillPackageSwitch = <A>(
    operation: (service: ReturnType<typeof runtime.createSkillPackageSwitchService>) => Promise<A>,
    fallbackMessage: string,
  ) =>
    rpcEffect(
      Effect.gen(function* () {
        yield* requireOwner;
        const principal = yield* CurrentManagedAttachmentPrincipal;
        if (!input.createSkillPackageSwitchHost) {
          return yield* Effect.fail(new Error("Skill package switch host is unavailable."));
        }
        const service = runtime.createSkillPackageSwitchService(
          input.createSkillPackageSwitchHost(principal),
        );
        return yield* Effect.tryPromise({ try: () => operation(service), catch: (cause) => cause });
      }),
      fallbackMessage,
    );

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
    [WS_METHODS.serverPreviewExpert]: (request: ExpertPreviewInput) =>
      expertRpcEffect(
        requireOwner,
        () => runtime.experts.preview(request),
        "Failed to preview expert",
      ).pipe(
        Effect.flatMap((preview) => {
          if (!input.previewProvider || preview.status === "incompatible")
            return Effect.succeed(preview);
          return rpcEffect(
            input.previewProvider(request, preview.definition.skills),
            "Failed to check Expert provider compatibility",
          ).pipe(
            Effect.map((issues) =>
              issues.length === 0
                ? preview
                : {
                    ...preview,
                    status: "incompatible" as const,
                    issues: [...preview.issues, ...issues],
                  },
            ),
          );
        }),
      ),
    [WS_METHODS.serverSkillLibrary]: ({ request }: { request: SkillLibraryRequest }) =>
      rpcEffect(
        Effect.gen(function* () {
          yield* input.requireSkillOwner ?? requireOwner;
          const principal = yield* CurrentManagedAttachmentPrincipal;
          return yield* Effect.tryPromise({
            try: async () => {
              if (
                (request.action === "save" &&
                  request.changes.some((change) => (change.content?.length ?? 0) > 1_398_104)) ||
                (request.action === "create" && Buffer.byteLength(request.body) > 1024 * 1024)
              )
                throw new Error(
                  "Large Skill files must use the authenticated HTTP upload endpoint.",
                );
              const result = await runtime.skillLibrary.execute(request, {
                actor: principal.ownerId,
              });
              if ((result.file?.content.length ?? 0) > 1_398_104)
                throw new Error(
                  "Large Skill files must use the authenticated HTTP download endpoint.",
                );
              return result;
            },
            catch: (cause) => cause,
          });
        }),
        "Skill library operation failed",
      ),
    [WS_METHODS.serverListSkillPackages]: () =>
      expertRpcEffect(
        requireOwner,
        () => runtime.skillPackages.list(),
        "Failed to list skill packages",
      ),
    [WS_METHODS.serverListSkillPackageSources]: () =>
      expertRpcEffect(
        requireOwner,
        () => runtime.skillPackages.listSources(),
        "Failed to list skill package sources",
      ),
    [WS_METHODS.serverReadSkillPackage]: (request: SkillPackageReadInput) =>
      expertRpcEffect(
        requireOwner,
        () => runtime.skillPackages.read(request.packageId),
        "Failed to read skill package",
      ),
    [WS_METHODS.serverPreviewSkillPackage]: (request: SkillPackagePreviewInput) =>
      expertRpcEffect(
        requireOwner,
        () => runtime.skillPackages.preview(request),
        "Failed to preview skill package",
      ),
    [WS_METHODS.serverPreviewSkillPackageUpdate]: (request: SkillPackageUpdatePreviewInput) =>
      expertRpcEffect(
        requireOwner,
        () => runtime.skillPackages.previewUpdate(request),
        "Failed to preview skill package update",
      ),
    [WS_METHODS.serverPreviewSkillPackageRemoval]: (request: SkillPackageReadInput) =>
      expertRpcEffect(
        requireOwner,
        () => runtime.skillPackages.previewRemoval(request.packageId),
        "Failed to preview skill package removal",
      ),
    [WS_METHODS.serverImportSkillPackage]: (request: SkillPackageImportInput) =>
      expertRpcEffect(
        requireOwner,
        () => runtime.skillPackages.import(request),
        "Failed to import skill package",
      ),
    [WS_METHODS.serverRemoveSkillPackage]: (request: SkillPackageRemoveInput) =>
      expertRpcEffect(
        requireOwner,
        () => runtime.removeSkillPackage(request.packageId),
        "Failed to remove skill package",
      ),
    [WS_METHODS.serverPreviewSkillPackageSwitch]: (request: SkillPackageSwitchInput) =>
      withSkillPackageSwitch(
        (service) => service.preview(request),
        "Failed to preview the Expert skill package switch",
      ),
    [WS_METHODS.serverApplySkillPackageSwitch]: (request: SkillPackageSwitchApplyInput) =>
      withSkillPackageSwitch(async (service) => {
        await service.apply(request);
        return { completed: true as const };
      }, "Failed to apply the Expert skill package switch"),
    [WS_METHODS.serverReadSkillPackageSwitchProgress]: (
      request: SkillPackageSwitchProgressReadInput,
    ) =>
      withSkillPackageSwitch(
        async (service) => ({ progress: await service.readProgress(request.switchId) }),
        "Failed to read the Expert skill package switch progress",
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

/** Thread-specific discovery uses the authoritative accepted snapshot. It must
 * not open a second provider process with ambient discovery settings. */
export function makeWorkbenchExpertDiscoveryHandlers<R>(input: {
  readonly requireOwner: Effect.Effect<void, WsRpcError, R>;
  readonly loadThreadBinding: (
    threadId: string,
  ) => Effect.Effect<{ readonly snapshotId: string } | null, unknown, R>;
  readonly readSnapshot: (snapshotId: string) => Promise<ExpertSnapshot>;
  readonly readSkillSession?: (
    threadId: string,
    snapshot: ExpertSnapshot,
  ) => Effect.Effect<ProviderExpertSession, unknown, R>;
  readonly listCommands: (
    request: ProviderListCommandsInput,
  ) => Effect.Effect<ProviderListCommandsResult, unknown, R>;
  readonly listSkills: (
    request: ProviderListSkillsInput,
  ) => Effect.Effect<ProviderListSkillsResult, unknown, R>;
}) {
  const fixedSnapshot = (threadId: string | undefined) =>
    Effect.gen(function* () {
      if (!threadId) return null;
      const binding = yield* input.loadThreadBinding(threadId);
      if (!binding) return null;
      yield* input.requireOwner;
      const snapshot = yield* Effect.tryPromise(() => input.readSnapshot(binding.snapshotId));
      if (snapshot.schemaVersion !== 3 || snapshot.skillPolicy?.discovery !== "fixed")
        return yield* Effect.fail(
          new Error("This historical Expert task has no supported fixed Skill policy."),
        );
      return snapshot;
    });
  return {
    listCommands: (request: ProviderListCommandsInput) =>
      Effect.gen(function* () {
        if (yield* fixedSnapshot(request.threadId))
          return { commands: [], source: "expert.fixed-snapshot", cached: false };
        return yield* input.listCommands(request);
      }),
    listSkills: (request: ProviderListSkillsInput) =>
      Effect.gen(function* () {
        const snapshot = yield* fixedSnapshot(request.threadId);
        if (!snapshot) return yield* input.listSkills(request);
        const session =
          input.readSkillSession && request.threadId
            ? yield* input.readSkillSession(request.threadId, snapshot)
            : snapshot;
        return {
          skills: (session.skillEntries ?? [])
            .filter((entry) => entry.userInvocable !== false)
            .map((entry) => ({
              name: entry.name,
              description: entry.description,
              path: entry.path,
              enabled: true,
              expert: {
                snapshotId: snapshot.snapshotId,
                packageId: entry.packageId,
                entryPath: entry.entryPath,
                ...(entry.managedSkillId ? { skillId: entry.managedSkillId } : {}),
              },
            })),
          source: "expert.fixed-snapshot",
          cached: false,
        };
      }),
  };
}
