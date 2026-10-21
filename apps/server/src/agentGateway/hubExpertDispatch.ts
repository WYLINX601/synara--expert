import {
  type ModelSelection,
  type HubExpertSummary,
  type ProjectId,
  type ProviderKind,
  type SynaraCreateThreadSpec,
  type SynaraResolvedCreateThreadSpec,
} from "@synara/contracts";
import { EXPERT_PROVIDER_KINDS } from "@synara/contracts";
import { isExpertProvider } from "@synara/shared/expertProviders";
import { Effect } from "effect";

import type { ExpertStore } from "../experts/ExpertStore.ts";
import type { ProviderDiscoveryServiceShape } from "../provider/Services/ProviderDiscoveryService.ts";
import {
  AgentGatewayTargetError,
  loadAgentGatewayProviderCatalog,
  resolveAgentGatewayTarget,
  type AgentGatewayProviderAvailability,
} from "./targetResolver.ts";
import { ToolInputError, errorText } from "./toolInput.ts";

export type HubExpertStore = Pick<
  ExpertStore,
  "list" | "read" | "preview" | "prepareSnapshot" | "readSnapshot"
>;

export interface HubExpertDispatchDependencies {
  readonly expertStore: HubExpertStore;
  readonly providerDiscovery: ProviderDiscoveryServiceShape;
  readonly loadProviderAvailabilities: Effect.Effect<
    ReadonlyMap<ProviderKind, AgentGatewayProviderAvailability>,
    unknown
  >;
  readonly getProjectWorkspaceRoot: (projectId: ProjectId) => Effect.Effect<string, unknown>;
}

function preferredTarget(input: {
  readonly provider: ProviderKind;
  readonly discovery: ProviderDiscoveryServiceShape;
  readonly availability?: AgentGatewayProviderAvailability;
  readonly cwd: string;
}): Effect.Effect<ModelSelection, ToolInputError> {
  return loadAgentGatewayProviderCatalog({
    provider: input.provider,
    discovery: input.discovery,
    ...(input.availability !== undefined ? { availability: input.availability } : {}),
    cwd: input.cwd,
  }).pipe(
    Effect.flatMap((catalog) => {
      if (!catalog.available) {
        return Effect.fail(
          new ToolInputError(
            catalog.error ?? `Preferred Expert provider "${input.provider}" is unavailable.`,
          ),
        );
      }
      // A provider without a configured default must ask the coordinator to
      // choose an explicit target; discovery ordering is not a preference.
      const model = catalog.defaultModel;
      if (!model) {
        return Effect.fail(
          new ToolInputError(
            `Preferred Expert provider "${input.provider}" has no configured default model; provide an explicit target.`,
          ),
        );
      }
      if (!catalog.models.some((entry) => entry.slug === model)) {
        return Effect.fail(
          new ToolInputError(
            `Configured default model "${model}" is not available for Expert provider "${input.provider}".`,
          ),
        );
      }
      return Effect.succeed({
        provider: input.provider,
        model,
      } as ModelSelection);
    }),
    Effect.mapError((error) =>
      error instanceof ToolInputError ? error : new ToolInputError(errorText(error)),
    ),
  );
}

function validateExpertPreview(
  expertStore: HubExpertStore,
  expertId: string,
  target: ModelSelection,
  cwd: string,
): Effect.Effect<void, ToolInputError> {
  if (!isExpertProvider(target.provider)) {
    return Effect.fail(new ToolInputError(`Experts do not support provider "${target.provider}".`));
  }
  const provider = target.provider;
  return Effect.tryPromise({
    try: () => expertStore.preview({ expertId, provider, cwd }),
    catch: (error) => new ToolInputError(errorText(error)),
  }).pipe(
    Effect.flatMap((preview) =>
      preview.status === "blocked" || preview.status === "incompatible"
        ? Effect.fail(
            new ToolInputError(preview.issues.join("; ") || `Expert "${expertId}" is unavailable.`),
          )
        : Effect.void,
    ),
  );
}

export function resolveHubCreationSpec(input: {
  readonly dependencies: HubExpertDispatchDependencies;
  readonly targetProjectId: ProjectId;
  readonly callerTarget: ModelSelection;
  readonly spec: SynaraCreateThreadSpec;
}): Effect.Effect<SynaraResolvedCreateThreadSpec, ToolInputError> {
  const { dependencies } = input;
  return Effect.gen(function* () {
    const cwd = yield* dependencies
      .getProjectWorkspaceRoot(input.targetProjectId)
      .pipe(Effect.mapError((error) => new ToolInputError(errorText(error))));
    const availabilities = yield* dependencies.loadProviderAvailabilities.pipe(
      Effect.mapError((error) => new ToolInputError(errorText(error))),
    );

    if (input.spec.expertId === undefined) {
      if (input.spec.target === undefined) {
        return yield* Effect.fail(new ToolInputError("A target is required for a plain worker."));
      }
      const availability = availabilities.get(input.spec.target.provider);
      const target = yield* resolveAgentGatewayTarget({
        target: input.spec.target,
        discovery: dependencies.providerDiscovery,
        ...(availability !== undefined ? { availability } : {}),
        cwd,
      }).pipe(
        Effect.mapError((error: AgentGatewayTargetError) => new ToolInputError(error.message)),
      );
      return { ...input.spec, target };
    }

    const definition = yield* Effect.tryPromise({
      try: () => dependencies.expertStore.read(input.spec.expertId!),
      catch: (error) => new ToolInputError(errorText(error)),
    });
    if (!definition) return yield* Effect.fail(new ToolInputError("Expert was not found."));
    if (definition.archived) {
      return yield* Effect.fail(new ToolInputError("Archived Experts cannot start new Hub work."));
    }

    const requestedTarget =
      input.spec.target ??
      (definition.preferredProvider
        ? yield* preferredTarget({
            provider: definition.preferredProvider,
            discovery: dependencies.providerDiscovery,
            ...(availabilities.get(definition.preferredProvider) !== undefined
              ? {
                  availability: availabilities.get(definition.preferredProvider)!,
                }
              : {}),
            cwd,
          })
        : input.callerTarget);
    const availability = availabilities.get(requestedTarget.provider);
    const target = yield* resolveAgentGatewayTarget({
      target: requestedTarget,
      discovery: dependencies.providerDiscovery,
      ...(availability !== undefined ? { availability } : {}),
      cwd,
    }).pipe(Effect.mapError((error: AgentGatewayTargetError) => new ToolInputError(error.message)));
    yield* validateExpertPreview(dependencies.expertStore, definition.id, target, cwd);

    const binding = yield* Effect.tryPromise({
      try: () => dependencies.expertStore.prepareSnapshot(definition.id),
      catch: (error) => new ToolInputError(errorText(error)),
    });
    const snapshot = yield* Effect.tryPromise({
      try: () => dependencies.expertStore.readSnapshot(binding.snapshotId),
      catch: (error) => new ToolInputError(errorText(error)),
    });
    const latest = yield* Effect.tryPromise({
      try: () => dependencies.expertStore.read(definition.id),
      catch: (error) => new ToolInputError(errorText(error)),
    });
    if (
      !latest ||
      latest.archived ||
      binding.revision !== definition.revision ||
      latest.revision !== binding.revision ||
      snapshot.expertId !== binding.expertId ||
      snapshot.displayName !== binding.displayName ||
      snapshot.revision !== binding.revision
    ) {
      return yield* Effect.fail(
        new ToolInputError("Expert changed during Hub dispatch preflight; retry the request."),
      );
    }
    yield* validateExpertPreview(dependencies.expertStore, definition.id, target, cwd);
    return { ...input.spec, target, expertBinding: binding };
  });
}

export type { HubExpertSummary } from "@synara/contracts";

export function listHubExpertSummaries(input: {
  readonly dependencies: HubExpertDispatchDependencies;
  readonly callerTarget: ModelSelection;
  readonly projectId: ProjectId;
  /** Trusted roster loaded from the Hub configuration, never tool input. */
  readonly expertIds: readonly string[];
}): Effect.Effect<ReadonlyArray<HubExpertSummary>, ToolInputError> {
  const { dependencies } = input;
  return Effect.gen(function* () {
    const expertIds = [...new Set(input.expertIds)].sort();
    // Empty and legacy Hubs do not discover the global catalogue or providers.
    if (expertIds.length === 0) return [];
    const definitions = yield* Effect.forEach(expertIds, (expertId) =>
      Effect.tryPromise({
        try: () => dependencies.expertStore.read(expertId),
        catch: (error) => new ToolInputError(errorText(error)),
      }),
    );
    const workspaceRoot = yield* dependencies
      .getProjectWorkspaceRoot(input.projectId)
      .pipe(Effect.mapError((error) => new ToolInputError(errorText(error))));
    const availabilities = yield* dependencies.loadProviderAvailabilities.pipe(
      Effect.mapError((error) => new ToolInputError(errorText(error))),
    );
    return yield* Effect.forEach(definitions, (definition, index) =>
      Effect.gen(function* () {
        if (!definition)
          return {
            targetProjectId: input.projectId,
            expertId: expertIds[index]!,
            displayName: "Unavailable Expert",
            description: "",
            useCases: "",
            preferredProvider: null,
            available: false,
          } satisfies HubExpertSummary;
        const provider = definition.preferredProvider ?? input.callerTarget.provider;
        const providerAvailability = availabilities.get(provider);
        let available = !definition.archived && isExpertProvider(provider);
        if (available) {
          const target =
            definition.preferredProvider === undefined
              ? input.callerTarget
              : yield* preferredTarget({
                  provider,
                  discovery: dependencies.providerDiscovery,
                  ...(providerAvailability !== undefined
                    ? { availability: providerAvailability }
                    : {}),
                  cwd: workspaceRoot,
                }).pipe(Effect.catch(() => Effect.succeed(null)));
          if (target === null) {
            available = false;
          } else {
            const resolved = yield* resolveAgentGatewayTarget({
              target,
              discovery: dependencies.providerDiscovery,
              ...(providerAvailability !== undefined ? { availability: providerAvailability } : {}),
              cwd: workspaceRoot,
            }).pipe(Effect.catch(() => Effect.succeed(null)));
            if (
              resolved === null ||
              (yield* validateExpertPreview(
                dependencies.expertStore,
                definition.id,
                resolved,
                workspaceRoot,
              ).pipe(
                Effect.as(true),
                Effect.catch(() => Effect.succeed(false)),
              )) === false
            ) {
              available = false;
            }
          }
        }
        return {
          targetProjectId: input.projectId,
          expertId: definition.id,
          displayName: definition.name,
          description: definition.description.slice(0, 800),
          useCases: definition.useCases.slice(0, 1600),
          preferredProvider: definition.preferredProvider ?? null,
          available,
        } satisfies HubExpertSummary;
      }),
    );
  });
}
