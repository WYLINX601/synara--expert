import {
  type ModelSelection,
  type HubExpertSummary,
  type ProjectId,
  type ProviderKind,
  type SynaraCreateThreadSpec,
  type SynaraResolvedCreateThreadSpec,
  type ProjectAgentConfig,
  type SuiteIssue,
  type SuiteRef,
  type CapabilityBinding,
  type ExecutionPurpose,
} from "@synara/contracts";
import type { ExpertDefinition } from "@synara/contracts";
import { isExpertProvider } from "@synara/shared/expertProviders";
import { Effect } from "effect";

import type { ExpertStore } from "../experts/ExpertStore.ts";
import type { ProviderDiscoveryServiceShape } from "../provider/Services/ProviderDiscoveryService.ts";
import { supportsSuiteRuntime } from "../workbench/host/providerCapabilities";
import {
  AgentGatewayTargetError,
  loadAgentGatewayProviderCatalog,
  resolveAgentGatewayTarget,
  type AgentGatewayProviderAvailability,
} from "./targetResolver.ts";
import { ToolInputError, errorText } from "./toolInput.ts";
import type { SuiteCompositionStoreShape } from "../suites/SuiteCompositionStore";

export type HubCandidateConfig = Pick<ProjectAgentConfig, "expertIds"> &
  Partial<Pick<ProjectAgentConfig, "suite" | "revision">>;

function candidateIssue(expertId: string, code: SuiteIssue["code"], message: string): SuiteIssue {
  return {
    code,
    category: code === "identity_unavailable" ? "execution" : "dependency",
    subject: { kind: "expert", id: expertId, path: null },
    action: "dispatch",
    effect: "deny-action",
    message: message.slice(0, 2_000),
    evidenceRef: null,
    checkedAt: new Date().toISOString(),
    recovery: "choose-alternative",
  };
}

/** The only membership resolver. Availability is diagnostic, never a Hub-wide gate. */
export function resolveHubExpertCandidates(input: {
  readonly config: HubCandidateConfig;
  readonly expertStore: Pick<HubExpertStore, "read">;
  readonly suiteStore?: Pick<SuiteCompositionStoreShape, "read">;
  readonly projectId?: ProjectId;
}): Effect.Effect<
  {
    readonly configRevision: number;
    readonly suite: SuiteRef | null;
    readonly candidates: readonly HubExpertSummary[];
  },
  ToolInputError
> {
  return Effect.gen(function* () {
    const suite = input.config.suite ?? null;
    let expertIds = input.config.expertIds ?? [];
    if (suite !== null) {
      if (!input.suiteStore)
        return yield* Effect.fail(
          new ToolInputError("Suite membership resolution is unavailable."),
        );
      const composition = yield* input.suiteStore
        .read(suite)
        .pipe(Effect.mapError((error) => new ToolInputError(errorText(error))));
      if (!composition)
        return yield* Effect.fail(new ToolInputError("Selected Suite revision does not exist."));
      expertIds = composition.members.map((member) => member.expertId);
    }
    const origin = suite === null ? ("roster" as const) : ("suite" as const);
    const candidates = yield* Effect.forEach([...new Set(expertIds)].sort(), (expertId) =>
      Effect.gen(function* () {
        const inspected = yield* Effect.tryPromise({
          try: () => input.expertStore.read(expertId),
          catch: (error) => new ToolInputError(errorText(error)),
        }).pipe(
          Effect.map((definition) => ({ definition, issue: null as SuiteIssue | null })),
          Effect.catch((error) =>
            Effect.succeed({
              definition: null,
              issue: candidateIssue(expertId, "resource_corrupt", error.message),
            }),
          ),
        );
        const definition = inspected.definition;
        const issues: SuiteIssue[] = inspected.issue
          ? [inspected.issue]
          : !definition || definition.archived
            ? [
                candidateIssue(
                  expertId,
                  "identity_unavailable",
                  definition
                    ? "Archived Experts cannot start new Hub work."
                    : "Expert identity is unavailable.",
                ),
              ]
            : [];
        return {
          ...(input.projectId === undefined ? {} : { targetProjectId: input.projectId }),
          expertId,
          displayName: definition?.name ?? "Unavailable Expert",
          description: definition?.description.slice(0, 800) ?? "",
          useCases: definition?.useCases.slice(0, 1_600) ?? "",
          preferredProvider: definition?.preferredProvider ?? null,
          origin,
          issues,
          available: issues.length === 0,
        } satisfies HubExpertSummary;
      }),
    );
    return { configRevision: input.config.revision ?? 0, suite, candidates };
  });
}

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
  readonly suiteStore?: Pick<SuiteCompositionStoreShape, "read">;
  readonly prepareSuiteBinding?: (input: {
    readonly suite: SuiteRef;
    readonly purpose: ExecutionPurpose;
    readonly projectId: ProjectId;
    readonly projectRoot?: string;
  }) => Effect.Effect<CapabilityBinding, unknown>;
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
  readonly hub?: {
    readonly projectId: ProjectId;
    readonly workId: string;
    readonly config: ProjectAgentConfig;
  };
}): Effect.Effect<SynaraResolvedCreateThreadSpec, ToolInputError> {
  const { dependencies } = input;
  return Effect.gen(function* () {
    if (input.hub && input.spec.expertId !== undefined) {
      const resolved = yield* resolveHubExpertCandidates({
        config: input.hub.config,
        expertStore: dependencies.expertStore,
        ...(dependencies.suiteStore ? { suiteStore: dependencies.suiteStore } : {}),
      });
      if (!resolved.candidates.some((candidate) => candidate.expertId === input.spec.expertId))
        return yield* Effect.fail(
          new ToolInputError("This Expert does not participate in the current Hub."),
        );
    }
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
      definition.defaultModelSelection ??
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
    if (!input.hub?.config.suite)
      yield* validateExpertPreview(dependencies.expertStore, definition.id, target, cwd);
    else if (!supportsSuiteRuntime(target.provider))
      return yield* Effect.fail(
        new ToolInputError(`Suite execution does not support provider "${target.provider}".`),
      );

    const binding = yield* Effect.tryPromise({
      try: () =>
        input.hub?.config.suite
          ? dependencies.expertStore.prepareSnapshot(definition.id, {
              projectRoot: cwd,
              allowMissingConnections: true,
            })
          : dependencies.expertStore.prepareSnapshot(definition.id),
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
    if (!input.hub?.config.suite)
      yield* validateExpertPreview(dependencies.expertStore, definition.id, target, cwd);
    let capability: CapabilityBinding | undefined;
    if (input.hub?.config.suite) {
      if (!dependencies.prepareSuiteBinding)
        return yield* Effect.fail(
          new ToolInputError("Suite worker binding preparation is unavailable."),
        );
      capability = yield* dependencies
        .prepareSuiteBinding({
          suite: input.hub.config.suite,
          purpose: {
            kind: "hub-worker",
            hubId: input.hub.projectId,
            workId: input.hub.workId,
            hubConfigRevision: input.hub.config.revision,
            expertSnapshotId: binding.snapshotId,
          },
          projectId: input.targetProjectId,
          projectRoot: cwd,
        })
        .pipe(Effect.mapError((error) => new ToolInputError(errorText(error))));
    }
    return {
      ...input.spec,
      target,
      expertBinding: binding,
      ...(capability === undefined
        ? {}
        : {
            capabilityBindingId: capability.bindingId,
            suite: capability.suite,
          }),
    };
  });
}

export type { HubExpertSummary } from "@synara/contracts";

export function listHubExpertSummaries(input: {
  readonly dependencies: HubExpertDispatchDependencies;
  readonly callerTarget: ModelSelection;
  readonly projectId: ProjectId;
  /** Trusted roster loaded from the Hub configuration, never tool input. */
  readonly expertIds: readonly string[];
  readonly config?: HubCandidateConfig;
}): Effect.Effect<ReadonlyArray<HubExpertSummary>, ToolInputError> {
  const { dependencies } = input;
  return Effect.gen(function* () {
    const definitions = new Map<string, ExpertDefinition | null>();
    const resolved = yield* resolveHubExpertCandidates({
      config: input.config ?? { expertIds: input.expertIds },
      expertStore: {
        read: async (expertId) => {
          const definition = await dependencies.expertStore.read(expertId);
          definitions.set(expertId, definition);
          return definition;
        },
      },
      projectId: input.projectId,
      ...(dependencies.suiteStore ? { suiteStore: dependencies.suiteStore } : {}),
    });
    if (resolved.candidates.every((candidate) => !candidate.available)) return resolved.candidates;
    const workspaceRoot = yield* dependencies
      .getProjectWorkspaceRoot(input.projectId)
      .pipe(Effect.mapError((error) => new ToolInputError(errorText(error))));
    const availabilities = yield* dependencies.loadProviderAvailabilities.pipe(
      Effect.mapError((error) => new ToolInputError(errorText(error))),
    );
    return yield* Effect.forEach(resolved.candidates, (candidate) =>
      Effect.gen(function* () {
        if (!candidate.available) return candidate;
        const definition = definitions.get(candidate.expertId);
        if (!definition || definition.archived)
          return {
            ...candidate,
            available: false,
            issues: [
              candidateIssue(
                candidate.expertId,
                "identity_unavailable",
                "Expert identity is unavailable.",
              ),
            ],
          };
        const provider =
          definition.defaultModelSelection?.provider ??
          definition.preferredProvider ??
          input.callerTarget.provider;
        const providerAvailability = availabilities.get(provider);
        const issue = yield* Effect.gen(function* () {
          if (!isExpertProvider(provider))
            return candidateIssue(
              definition.id,
              "unsupported_capability",
              `Experts do not support provider "${provider}".`,
            );
          const target =
            definition.defaultModelSelection ??
            (definition.preferredProvider === undefined
              ? input.callerTarget
              : yield* preferredTarget({
                  provider,
                  discovery: dependencies.providerDiscovery,
                  ...(providerAvailability !== undefined
                    ? { availability: providerAvailability }
                    : {}),
                  cwd: workspaceRoot,
                }));
          const targetSelection = yield* resolveAgentGatewayTarget({
            target,
            discovery: dependencies.providerDiscovery,
            ...(providerAvailability !== undefined ? { availability: providerAvailability } : {}),
            cwd: workspaceRoot,
          });
          if (resolved.suite !== null && !supportsSuiteRuntime(targetSelection.provider))
            return candidateIssue(
              definition.id,
              "unsupported_capability",
              `Suite execution does not support provider "${targetSelection.provider}".`,
            );
          if (resolved.suite === null)
            yield* validateExpertPreview(
              dependencies.expertStore,
              definition.id,
              targetSelection,
              workspaceRoot,
            );
          return null;
        }).pipe(
          Effect.catch((error) =>
            Effect.succeed(candidateIssue(definition.id, "provider_unavailable", errorText(error))),
          ),
        );
        return {
          ...candidate,
          available: issue === null,
          issues: issue === null ? candidate.issues : [...(candidate.issues ?? []), issue],
        } satisfies HubExpertSummary;
      }),
    );
  });
}
