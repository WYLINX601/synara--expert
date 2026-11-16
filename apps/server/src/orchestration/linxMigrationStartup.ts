import { Cause, Effect, FileSystem, Layer, Path } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ChildProcessSpawner } from "effect/unstable/process";

import { ServerConfig } from "../config";
import { GitCoreLive } from "../git/Layers/GitCore";
import { createLinxLivePathRelocator } from "../linxHomeMigration";
import { ProjectionPendingInteractionRepositoryLive } from "../persistence/Layers/ProjectionPendingInteractions";
import { ProviderSessionRuntimeRepositoryLive } from "../persistence/Layers/ProviderSessionRuntime";
import { ProviderRuntimeEventRepositoryLive } from "../persistence/Layers/ProviderRuntimeEvents";
import { ProviderRuntimeEventRepository } from "../persistence/Services/ProviderRuntimeEvents";
import { makeProviderRuntimeMigrationReplay } from "./Layers/ProviderRuntimeIngestion";
import { OrchestrationEngineService } from "./Services/OrchestrationEngine";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery";
import {
  captureCrashResumeRecordStrict,
  persistQuitResumeRecord,
  readQuitResumeRecord,
} from "./quitResume";
import { reconcileRestartStuckTurnsStrict } from "./startupTurnReconciliation";

export type LinxMigrationSettlementServices =
  | OrchestrationEngineService
  | ProjectionSnapshotQuery
  | ServerConfig
  | SqlClient.SqlClient
  | FileSystem.FileSystem
  | Path.Path
  | ChildProcessSpawner.ChildProcessSpawner;

/** Runs only under the pending import's source lock, before publishing the engine. */
export const settleLinxMigrationOrphanedActivity = (paths: {
  readonly sourceHomePath: string;
  readonly homePath: string;
}): Effect.Effect<void, Error, LinxMigrationSettlementServices> =>
  Effect.scoped(
    Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      const config = yield* ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const journal = yield* ProviderRuntimeEventRepository;
      const relocate = yield* Effect.tryPromise(() =>
        createLinxLivePathRelocator(paths.sourceHomePath, paths.homePath),
      );
      // The raw engine has no producer reactors. Drain accepted commands before
      // replaying provider output; neither phase may start a new provider/task.
      yield* engine.drain;
      const replay = yield* makeProviderRuntimeMigrationReplay((value) =>
        Effect.tryPromise({
          try: () => relocate(value),
          catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
        }),
      );
      yield* replay.replayBeforeMigration;
      yield* engine.drain;

      // Preserve explicit quit intent (including invalid records) without claiming
      // it. Normal startup consumes it only after paths are durable and producers
      // may run. Unlike best-effort boot, failed capture/write must abort migration.
      yield* fs.exists(config.quitResumeStatePath);
      const previous = yield* readQuitResumeRecord(config.quitResumeStatePath);
      if (previous.kind === "absent") {
        const crash = yield* captureCrashResumeRecordStrict;
        if (crash.kind === "record") {
          yield* persistQuitResumeRecord({
            path: config.quitResumeStatePath,
            record: crash.record,
          });
        }
      }
      yield* replay.finalizeOrphanedOutput;
      yield* reconcileRestartStuckTurnsStrict;
      yield* engine.drain;
      const health = yield* engine.getProjectionCatchUpStatus;
      if (health.state !== "healthy" || health.inFlight) {
        return yield* Effect.fail(
          new Error("Migration restart settlement did not reach healthy projections"),
        );
      }
      // Keep native replay-ledger ownership: only terminal projected turns are
      // removed, after every output/interaction/checkpoint settlement has committed.
      yield* journal.pruneSettledOpenTurns;
    }),
  ).pipe(
    Effect.provide(
      Layer.mergeAll(
        GitCoreLive,
        ProjectionPendingInteractionRepositoryLive,
        ProviderSessionRuntimeRepositoryLive,
        ProviderRuntimeEventRepositoryLive,
      ),
    ),
    Effect.catchCause((cause) => Effect.fail(new Error(Cause.pretty(cause)))),
  );
