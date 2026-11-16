import { Effect, Layer } from "effect";

import { ContextRepository, ContextRepositoryLive } from "../context/ContextRepository";
import { OrchestrationCommandReceiptRepositoryLive } from "../persistence/Layers/OrchestrationCommandReceipts";
import { OrchestrationEventStoreLive } from "../persistence/Layers/OrchestrationEventStore";
import { ManagedAttachmentRepositoryLive } from "../persistence/Layers/ManagedAttachments";
import { OrchestrationEngineLive } from "./Layers/OrchestrationEngine";
import { OrchestrationProjectionPipelineLive } from "./Layers/ProjectionPipeline";
import { OrchestrationProjectionSnapshotQueryLive } from "./Layers/ProjectionSnapshotQuery";
import { OrchestrationEngineService } from "./Services/OrchestrationEngine";
import { OrchestrationCommandAdmissionError } from "./Errors";
import { serverMaintenanceAdmission } from "../serverMaintenance";
import { ServerConfig } from "../config";
import { completeLinxHomeMigration } from "../linxHomeMigration";
import { migrateLinxProviderBindings } from "../linxProviderBindingMigration";
import { ProviderSessionDirectory } from "../provider/Services/ProviderSessionDirectory";
import { ProviderSessionDirectoryLive } from "../provider/Layers/ProviderSessionDirectory";
import { ProviderSessionRuntimeRepositoryLive } from "../persistence/Layers/ProviderSessionRuntime";
import { ServerSettingsService } from "../serverSettings";
import { ServerSecretStore } from "../auth/Services/ServerSecretStore";
import { ServerSecretStoreLive } from "../auth/Layers/ServerSecretStore";
import { PROVIDER_OPTIONS_FINGERPRINT_HMAC_SECRET } from "../provider/continuationCompatibility";
import {
  settleLinxMigrationOrphanedActivity,
  type LinxMigrationSettlementServices,
} from "./linxMigrationStartup";

export const OrchestrationEventInfrastructureLayerLive = Layer.mergeAll(
  OrchestrationEventStoreLive,
  OrchestrationCommandReceiptRepositoryLive,
  ManagedAttachmentRepositoryLive,
);

export const OrchestrationProjectionPipelineLayerLive = OrchestrationProjectionPipelineLive.pipe(
  Layer.provide(OrchestrationEventStoreLive),
  Layer.provide(ManagedAttachmentRepositoryLive),
);

export const OrchestrationInfrastructureLayerLive = Layer.mergeAll(
  OrchestrationProjectionSnapshotQueryLive,
  OrchestrationEventInfrastructureLayerLive,
  OrchestrationProjectionPipelineLayerLive,
);

export const OrchestrationLayerLive = Layer.mergeAll(
  OrchestrationInfrastructureLayerLive,
  Layer.effect(
    OrchestrationEngineService,
    Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      // This layer is a dependency of every producer. Relocate native paths before
      // publishing the engine, not after makeServerProgram has built all reactors.
      const config = yield* ServerConfig;
      const directory = yield* ProviderSessionDirectory;
      const settingsService = yield* ServerSettingsService;
      const secrets = yield* ServerSecretStore;
      const settlementServices = yield* Effect.services<LinxMigrationSettlementServices>();
      yield* completeLinxHomeMigration({
        homePath: config.baseDir,
        engine,
        settleOrphanedActivity: (paths) =>
          settleLinxMigrationOrphanedActivity(paths).pipe(
            Effect.provideServices(settlementServices),
          ),
        migrateProviderBindings: (paths) =>
          Effect.gen(function* () {
            yield* settingsService.start;
            const settings = yield* settingsService.getSettings;
            const credentialsFingerprintKey = yield* secrets.getOrCreateRandom(
              PROVIDER_OPTIONS_FINGERPRINT_HMAC_SECRET,
              32,
            );
            yield* migrateLinxProviderBindings({
              ...paths,
              settings,
              directory,
              credentialsFingerprintKey,
            });
          }),
      });
      return {
        ...engine,
        dispatch: (command, context) =>
          serverMaintenanceAdmission.guard(
            engine.dispatch(command, context),
            () =>
              new OrchestrationCommandAdmissionError({
                commandId: command.commandId,
                commandType: command.type,
                capacity: 0,
                reservedCapacity: 0,
                reason: "stopped",
              }),
            // Only existing-run settlement. In particular, queued dispatch and
            // approval responses can start work and are NOT maintenance controls.
            command.type === "thread.activity.append" ||
              command.type === "thread.session.set" ||
              command.type === "thread.message.assistant.complete" ||
              command.type === "thread.turn.diff.complete",
          ),
      } satisfies typeof engine;
    }),
  ).pipe(
    Layer.provide(OrchestrationInfrastructureLayerLive),
    Layer.provide(
      OrchestrationEngineLive.pipe(Layer.provide(OrchestrationInfrastructureLayerLive)),
    ),
    Layer.provide(
      ProviderSessionDirectoryLive.pipe(Layer.provide(ProviderSessionRuntimeRepositoryLive)),
    ),
    Layer.provide(ServerSecretStoreLive),
  ),
);

// Context configuration is part of the server's durable orchestration runtime,
// so callers that build runtime services can depend on the same public service.
export { ContextRepository, ContextRepositoryLive };
