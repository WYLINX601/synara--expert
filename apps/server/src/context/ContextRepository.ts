import { createHash } from "node:crypto";

import {
  ContextAppliedRuntimeRecord,
  ContextCommandResult,
  ContextMigrationRecord,
  ContextMode,
  ContextPreview,
  ContextNonePreviewV2,
  ContextSession,
  ContextSnapshot,
  ContextSpacePreviewV2,
  CommandId,
  ProjectContextSettings,
  SpaceIconName,
  SpaceName,
  SpaceContextSettings,
  ThreadContextDetails,
  type OrchestrationEvent,
  ProjectId,
  SpaceId,
  type ThreadId,
} from "@synara/contracts";
import { Effect, Layer, Schema, ServiceMap } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  PersistenceDecodeError,
  PersistenceSqlError,
  toPersistenceSqlError,
} from "../persistence/Errors.ts";

export class ContextSourceUnavailableError extends Schema.TaggedErrorClass<ContextSourceUnavailableError>()(
  "ContextSourceUnavailableError",
  {
    source: Schema.Literals(["hub-source-project", "hub-space", "project-workspace"]),
  },
) {
  override get message(): string {
    switch (this.source) {
      case "hub-source-project":
        return "This Hub's source Project is unavailable.";
      case "hub-space":
        return "This Hub's assigned Space is unavailable.";
      case "project-workspace":
        return "This thread's Project workspace is unavailable.";
    }
  }
}

export type ContextRepositoryError = PersistenceSqlError | PersistenceDecodeError;
export type ContextResolutionError = ContextRepositoryError | ContextSourceUnavailableError;

export interface ThreadContextBinding {
  readonly mode: ContextMode;
  readonly snapshot?: ContextSnapshot;
}

type SpaceSaveEvent = Omit<
  Extract<OrchestrationEvent, { type: "context.space.save-requested" }>,
  "sequence"
>;
type ProjectSaveEvent = Omit<
  Extract<OrchestrationEvent, { type: "context.project.save-requested" }>,
  "sequence"
>;
type MigrationClaimEvent = Omit<
  Extract<OrchestrationEvent, { type: "context.migration.claim-requested" }>,
  "sequence"
>;
type MigrationResolveEvent = Omit<
  Extract<OrchestrationEvent, { type: "context.migration.resolve-requested" }>,
  "sequence"
>;
type BindRequestedEvent = Omit<
  Extract<OrchestrationEvent, { type: "context.thread.bind-requested" }>,
  "sequence"
>;

export interface ContextRepositoryShape {
  readonly getThreadContext?: (
    threadId: ThreadId,
  ) => Effect.Effect<
    { readonly project: ProjectContextSettings | null; readonly preview: ContextPreview },
    ContextResolutionError
  >;
  readonly resolveContextProjectId?: (
    threadId: ThreadId,
  ) => Effect.Effect<ProjectId, ContextResolutionError>;
  readonly getSpace: (
    spaceId: SpaceId,
  ) => Effect.Effect<SpaceContextSettings, ContextRepositoryError>;
  readonly getProject: (
    projectId: ProjectId,
  ) => Effect.Effect<ProjectContextSettings, ContextRepositoryError>;
  readonly getThreadBinding: (
    threadId: ThreadId,
  ) => Effect.Effect<ThreadContextBinding | undefined, ContextRepositoryError>;
  readonly getContextSession: (
    threadId: ThreadId,
  ) => Effect.Effect<ContextSession | undefined, ContextRepositoryError>;
  readonly getApplied: (
    threadId: ThreadId,
  ) => Effect.Effect<ContextAppliedRuntimeRecord | undefined, ContextRepositoryError>;
  readonly upsertApplied: (
    record: ContextAppliedRuntimeRecord,
  ) => Effect.Effect<void, ContextRepositoryError>;
  readonly getThreadDetails: (
    threadId: ThreadId,
  ) => Effect.Effect<ThreadContextDetails, ContextRepositoryError>;
  readonly getCommandResult: (
    commandId: CommandId,
  ) => Effect.Effect<ContextCommandResult, ContextRepositoryError>;
  readonly getPreview: (
    projectId: ProjectId,
  ) => Effect.Effect<ContextPreview, ContextRepositoryError>;
  readonly buildBindingSnapshot: (
    threadId: ThreadId,
    snapshotId: string,
    createdAt: string,
  ) => Effect.Effect<ContextSnapshot, ContextResolutionError>;
  /** Resolve the original CAS once and embed its exact receipt in the journal event. */
  readonly prepareSpaceSave: (
    event: SpaceSaveEvent,
  ) => Effect.Effect<SpaceSaveEvent, ContextRepositoryError>;
  readonly prepareProjectSave: (
    event: ProjectSaveEvent,
  ) => Effect.Effect<ProjectSaveEvent, ContextRepositoryError>;
  /** Resolve migration admission once and freeze its receipt and resulting values. */
  readonly prepareMigrationClaim: (
    event: MigrationClaimEvent,
  ) => Effect.Effect<MigrationClaimEvent, ContextRepositoryError>;
  readonly prepareMigrationResolve: (
    event: MigrationResolveEvent,
  ) => Effect.Effect<MigrationResolveEvent, ContextRepositoryError>;
  /** Freeze the admitted context in the bind event; replay consumes only these bytes. */
  readonly prepareBinding: (
    event: BindRequestedEvent,
  ) => Effect.Effect<BindRequestedEvent, ContextResolutionError>;
  /** Apply a replayable context event while the orchestration transaction is open. */
  readonly applyEvent: (event: OrchestrationEvent) => Effect.Effect<void, ContextRepositoryError>;
}

export class ContextRepository extends ServiceMap.Service<
  ContextRepository,
  ContextRepositoryShape
>()("synara/server/context/ContextRepository") {}

interface ContextSpaceRow {
  readonly dataInstanceId: string;
  readonly spaceId: string;
  readonly name: string;
  readonly icon: string;
  readonly directionGoal: string;
  readonly sharedInstructions: string;
  readonly revision: number;
}

interface ContextProjectRow {
  readonly dataInstanceId: string;
  readonly projectId: string;
  readonly title: string;
  readonly workspaceRoot: string;
  readonly spaceId: string | null;
  readonly projectGoal: string;
  readonly projectInstructions: string;
  readonly revision: number;
}

const decodeValue = <A>(
  schema: Schema.Top,
  value: unknown,
  operation: string,
): Effect.Effect<A, PersistenceDecodeError> =>
  Effect.try({
    try: () => Schema.decodeUnknownSync(schema as Schema.Decoder<A>)(value) as A,
    catch: (cause) =>
      new PersistenceDecodeError({
        operation,
        issue: cause instanceof Error ? cause.message : String(cause),
        cause,
      }),
  });

const decodeJson = <A>(
  schema: Schema.Top,
  json: string,
  operation: string,
): Effect.Effect<A, PersistenceDecodeError> =>
  Effect.try({
    try: () => Schema.decodeUnknownSync(schema as Schema.Decoder<A>)(JSON.parse(json)) as A,
    catch: (cause) =>
      new PersistenceDecodeError({
        operation,
        issue: cause instanceof Error ? cause.message : String(cause),
        cause,
      }),
  });

const makeContextText = (input: {
  readonly directionGoal: string;
  readonly sharedInstructions: string;
  readonly projectGoal: string;
  readonly projectInstructions: string;
}): string => {
  const sections = [
    ["方向目标", input.directionGoal],
    ["共享指令", input.sharedInstructions],
    ["项目目标", input.projectGoal],
    ["项目指令", input.projectInstructions],
  ] as const;
  return sections
    .filter(([, text]) => text.trim().length > 0)
    .map(([title, text]) => `## ${title}\n${text}`)
    .join("\n\n");
};

const snapshotHash = (preview: object): string =>
  createHash("sha256").update(JSON.stringify(preview), "utf8").digest("hex");

const hasNewContextVersion = (snapshot: ContextSnapshot, preview: ContextPreview): boolean => {
  if (snapshot.schemaVersion !== preview.schemaVersion) return true;
  if (snapshot.schemaVersion === 1 && preview.schemaVersion === 1) {
    if (
      snapshot.project.projectId !== preview.project.projectId ||
      snapshot.project.revision !== preview.project.revision ||
      snapshot.project.projectGoal !== preview.project.projectGoal ||
      snapshot.project.projectInstructions !== preview.project.projectInstructions
    ) {
      return true;
    }
  } else if (snapshot.schemaVersion === 2 && preview.schemaVersion === 2) {
    if (snapshot.source !== preview.source) return true;
    if (snapshot.source === "none" || preview.source === "none") return false;
  } else {
    return true;
  }
  if ((snapshot.space?.spaceId ?? null) !== (preview.space?.spaceId ?? null)) return true;
  if (snapshot.space === null || preview.space === null) return false;
  return (
    snapshot.space.revision !== preview.space.revision ||
    snapshot.space.directionGoal !== preview.space.directionGoal ||
    snapshot.space.sharedInstructions !== preview.space.sharedInstructions
  );
};

const makeContextRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const getDataInstanceId = Effect.gen(function* () {
    const rows = yield* sql<{ readonly dataInstanceId: string }>`
      SELECT data_instance_id AS "dataInstanceId"
      FROM context_meta WHERE singleton = 1
    `.pipe(Effect.mapError(toPersistenceSqlError("ContextRepository.getDataInstanceId")));
    const row = rows[0];
    if (!row) {
      return yield* new PersistenceDecodeError({
        operation: "ContextRepository.getDataInstanceId",
        issue: "The Context data-instance identity row is missing.",
      });
    }
    return row.dataInstanceId;
  });

  const getMigrationRecord = (
    projectId: ProjectId,
  ): Effect.Effect<ContextMigrationRecord | null, ContextRepositoryError> =>
    Effect.gen(function* () {
      const rows = yield* sql<{
        readonly projectId: string;
        readonly sourceDigest: string;
        readonly legacyInstructions: string;
        readonly status: string;
        readonly choice: string | null;
        readonly updatedAt: string;
      }>`
        SELECT project_id AS "projectId", source_digest AS "sourceDigest",
          legacy_instructions AS "legacyInstructions", status, choice,
          updated_at AS "updatedAt"
        FROM context_migrations WHERE project_id = ${projectId}
      `.pipe(Effect.mapError(toPersistenceSqlError("ContextRepository.getMigration")));
      const row = rows[0];
      if (!row) return null;
      return yield* decodeValue<ContextMigrationRecord>(
        ContextMigrationRecord,
        row,
        "ContextRepository.getMigration:decode",
      );
    });

  const getSpace = (
    spaceId: SpaceId,
  ): Effect.Effect<SpaceContextSettings, ContextRepositoryError> =>
    Effect.gen(function* () {
      const rows = yield* sql<ContextSpaceRow>`
        SELECT m.data_instance_id AS "dataInstanceId", s.space_id AS "spaceId",
          s.name, s.icon, COALESCE(c.direction_goal, '') AS "directionGoal",
          COALESCE(c.shared_instructions, '') AS "sharedInstructions",
          COALESCE(c.revision, 0) AS revision
        FROM projection_spaces s
        CROSS JOIN context_meta m
        LEFT JOIN context_spaces c ON c.space_id = s.space_id
        WHERE m.singleton = 1 AND s.space_id = ${spaceId} AND s.deleted_at IS NULL
      `.pipe(Effect.mapError(toPersistenceSqlError("ContextRepository.getSpace")));
      const row = rows[0];
      if (!row) {
        return yield* new PersistenceDecodeError({
          operation: "ContextRepository.getSpace",
          issue: `Space '${spaceId}' does not exist or is deleted.`,
        });
      }
      return yield* decodeValue<SpaceContextSettings>(
        SpaceContextSettings,
        row,
        "ContextRepository.getSpace:decode",
      );
    });

  const getSpaceForContextSource = (spaceId: SpaceId) =>
    Effect.gen(function* () {
      const rows = yield* sql<ContextSpaceRow>`
        SELECT m.data_instance_id AS "dataInstanceId", s.space_id AS "spaceId",
          s.name, s.icon, COALESCE(c.direction_goal, '') AS "directionGoal",
          COALESCE(c.shared_instructions, '') AS "sharedInstructions",
          COALESCE(c.revision, 0) AS revision
        FROM projection_spaces s
        CROSS JOIN context_meta m
        LEFT JOIN context_spaces c ON c.space_id = s.space_id
        WHERE m.singleton = 1 AND s.space_id = ${spaceId} AND s.deleted_at IS NULL
      `.pipe(Effect.mapError(toPersistenceSqlError("ContextRepository.getSpaceForContextSource")));
      const row = rows[0];
      if (!row) {
        return yield* new ContextSourceUnavailableError({ source: "hub-space" });
      }
      return yield* decodeValue<SpaceContextSettings>(
        SpaceContextSettings,
        row,
        "ContextRepository.getSpaceForContextSource:decode",
      );
    });

  const getProject = (
    projectId: ProjectId,
  ): Effect.Effect<ProjectContextSettings, ContextRepositoryError> =>
    Effect.gen(function* () {
      const rows = yield* sql<ContextProjectRow>`
        SELECT m.data_instance_id AS "dataInstanceId", p.project_id AS "projectId",
          p.title, p.workspace_root AS "workspaceRoot", p.space_id AS "spaceId",
          COALESCE(c.project_goal, '') AS "projectGoal",
          COALESCE(c.project_instructions, '') AS "projectInstructions",
          COALESCE(c.revision, 0) AS revision
        FROM projection_projects p
        CROSS JOIN context_meta m
        LEFT JOIN context_projects c ON c.project_id = p.project_id
        WHERE m.singleton = 1 AND p.project_id = ${projectId}
      `.pipe(Effect.mapError(toPersistenceSqlError("ContextRepository.getProject")));
      const row = rows[0];
      if (!row) {
        return yield* new PersistenceDecodeError({
          operation: "ContextRepository.getProject",
          issue: `Project '${projectId}' does not exist.`,
        });
      }
      const inherited =
        row.spaceId === null
          ? null
          : yield* getSpace(row.spaceId as SpaceId).pipe(
              Effect.catchTag("PersistenceDecodeError", () => Effect.succeed(null)),
            );
      const migration = yield* getMigrationRecord(projectId);
      return yield* decodeValue<ProjectContextSettings>(
        ProjectContextSettings,
        { ...row, inherited, migration },
        "ContextRepository.getProject:decode",
      );
    });

  const getThreadBinding = (
    threadId: ThreadId,
  ): Effect.Effect<ThreadContextBinding | undefined, ContextRepositoryError> =>
    Effect.gen(function* () {
      const threads = yield* sql<{ readonly threadId: string }>`
        SELECT thread_id AS "threadId" FROM projection_threads WHERE thread_id = ${threadId}
      `.pipe(Effect.mapError(toPersistenceSqlError("ContextRepository.getThreadBinding:thread")));
      if (threads.length === 0) return undefined;
      const rows = yield* sql<{ readonly mode: string; readonly snapshotJson: string | null }>`
        SELECT mode, snapshot_json AS "snapshotJson"
        FROM context_thread_bindings WHERE thread_id = ${threadId}
      `.pipe(Effect.mapError(toPersistenceSqlError("ContextRepository.getThreadBinding")));
      const row = rows[0];
      // A missing binding row means the thread predates the explicit Context origin event.
      if (!row) return { mode: "legacy" as const };
      const mode = yield* decodeValue<ContextMode>(
        ContextMode,
        row.mode,
        "ContextRepository.getThreadBinding:mode",
      );
      if (row.snapshotJson === null) return { mode };
      const snapshot = yield* decodeJson<ContextSnapshot>(
        ContextSnapshot,
        row.snapshotJson,
        "ContextRepository.getThreadBinding:snapshot",
      );
      return { mode, snapshot };
    });

  const getContextSession = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const binding = yield* getThreadBinding(threadId);
      if (binding?.mode !== "bound" || binding.snapshot === undefined) return undefined;
      return yield* decodeValue<ContextSession>(
        ContextSession,
        {
          snapshotId: binding.snapshot.snapshotId,
          snapshotHash: binding.snapshot.snapshotHash,
          text: binding.snapshot.text,
          hasContent: binding.snapshot.hasContent,
        },
        "ContextRepository.getContextSession:decode",
      );
    });

  const getApplied = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const rows = yield* sql<{ readonly recordJson: string }>`
        SELECT record_json AS "recordJson"
        FROM context_applied_runtime_records WHERE thread_id = ${threadId}
      `.pipe(Effect.mapError(toPersistenceSqlError("ContextRepository.getApplied")));
      const row = rows[0];
      if (!row) return undefined;
      return yield* decodeJson<ContextAppliedRuntimeRecord>(
        ContextAppliedRuntimeRecord,
        row.recordJson,
        "ContextRepository.getApplied:decode",
      );
    });

  const upsertApplied = (record: ContextAppliedRuntimeRecord) =>
    Effect.gen(function* () {
      const binding = yield* getThreadBinding(record.threadId);
      if (
        binding?.mode !== "bound" ||
        binding.snapshot?.snapshotId !== record.snapshotId ||
        binding.snapshot.snapshotHash !== record.snapshotHash
      ) {
        return yield* new PersistenceDecodeError({
          operation: "ContextRepository.upsertApplied",
          issue:
            "The applied runtime record does not match this thread's immutable Context snapshot.",
        });
      }
      yield* sql`
        INSERT INTO context_applied_runtime_records (thread_id, record_json)
        VALUES (${record.threadId}, ${JSON.stringify(record)})
        ON CONFLICT (thread_id) DO UPDATE SET record_json = excluded.record_json
      `.pipe(Effect.mapError(toPersistenceSqlError("ContextRepository.upsertApplied")));
    });

  const getPreview = (projectId: ProjectId) =>
    Effect.gen(function* () {
      const project = yield* getProject(projectId);
      const space = project.inherited;
      const text = makeContextText({
        directionGoal: space?.directionGoal ?? "",
        sharedInstructions: space?.sharedInstructions ?? "",
        projectGoal: project.projectGoal,
        projectInstructions: project.projectInstructions,
      });
      const withoutHash = {
        schemaVersion: 1 as const,
        rendererVersion: 1 as const,
        space:
          space === null
            ? null
            : {
                spaceId: space.spaceId,
                name: space.name,
                revision: space.revision,
                directionGoal: space.directionGoal,
                sharedInstructions: space.sharedInstructions,
              },
        project: {
          projectId: project.projectId,
          title: project.title,
          workspaceRoot: project.workspaceRoot,
          revision: project.revision,
          projectGoal: project.projectGoal,
          projectInstructions: project.projectInstructions,
        },
        text,
        hasContent: text.length > 0,
      };
      return yield* decodeValue<ContextPreview>(
        ContextPreview,
        { ...withoutHash, snapshotHash: snapshotHash(withoutHash) },
        "ContextRepository.getPreview:decode",
      );
    });

  const getSpaceOnlyPreview = (spaceId: SpaceId) =>
    Effect.gen(function* () {
      const space = yield* getSpaceForContextSource(spaceId);
      const text = makeContextText({
        directionGoal: space.directionGoal,
        sharedInstructions: space.sharedInstructions,
        projectGoal: "",
        projectInstructions: "",
      });
      const withoutHash = {
        schemaVersion: 2 as const,
        rendererVersion: 1 as const,
        source: "space" as const,
        space: {
          spaceId: space.spaceId,
          name: space.name,
          revision: space.revision,
          directionGoal: space.directionGoal,
          sharedInstructions: space.sharedInstructions,
        },
        text,
        hasContent: text.length > 0,
      };
      return yield* decodeValue<ContextPreview>(
        ContextSpacePreviewV2,
        { ...withoutHash, snapshotHash: snapshotHash(withoutHash) },
        "ContextRepository.getSpaceOnlyPreview:decode",
      );
    });

  const getNoContextPreview = () => {
    const withoutHash = {
      schemaVersion: 2 as const,
      rendererVersion: 1 as const,
      source: "none" as const,
      space: null,
      text: "",
      hasContent: false,
    };
    return decodeValue<ContextPreview>(
      ContextNonePreviewV2,
      { ...withoutHash, snapshotHash: snapshotHash(withoutHash) },
      "ContextRepository.getNoContextPreview:decode",
    );
  };

  const resolveThreadContext = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const rows = yield* sql<{
        readonly projectId: string;
        readonly projectKind: string | null;
        readonly spaceId: string | null;
        readonly sourceProjectId: string | null;
        readonly liveSourceProjectId: string | null;
        readonly liveProjectId: string | null;
      }>`
        SELECT t.project_id AS "projectId", p.kind AS "projectKind", p.space_id AS "spaceId",
          o.source_project_id AS "sourceProjectId",
          CASE WHEN source.deleted_at IS NULL THEN source.project_id ELSE NULL END AS "liveSourceProjectId",
          CASE WHEN p.deleted_at IS NULL THEN p.project_id ELSE NULL END AS "liveProjectId"
        FROM projection_threads t
        LEFT JOIN projection_projects p ON p.project_id = t.project_id
        LEFT JOIN project_agent_configs c
          ON c.coordinator_thread_id = t.thread_id AND c.project_id = t.project_id
        LEFT JOIN hub_project_origins o ON o.hub_id = c.project_id
        LEFT JOIN projection_projects source ON source.project_id = o.source_project_id
        WHERE t.thread_id = ${threadId}
      `.pipe(Effect.mapError(toPersistenceSqlError("ContextRepository.resolveThreadContext")));
      const row = rows[0];
      if (!row || !row.projectId) {
        return yield* new PersistenceDecodeError({
          operation: "ContextRepository.resolveThreadContext",
          issue: `Thread '${threadId}' does not exist or has no Project workspace.`,
        });
      }

      if (row.sourceProjectId !== null) {
        if (row.liveSourceProjectId === null) {
          return yield* new ContextSourceUnavailableError({ source: "hub-source-project" });
        }
        const project = yield* getProject(ProjectId.makeUnsafe(row.sourceProjectId));
        return { project, preview: yield* getPreview(project.projectId) };
      }

      if (row.liveProjectId === null) {
        return yield* new ContextSourceUnavailableError({ source: "project-workspace" });
      }

      if (row.projectKind === "group" || row.projectKind === "studio") {
        if (row.spaceId === null) {
          return { project: null, preview: yield* getNoContextPreview() };
        }
        return {
          project: null,
          preview: yield* getSpaceOnlyPreview(SpaceId.makeUnsafe(row.spaceId)),
        };
      }

      const project = yield* getProject(ProjectId.makeUnsafe(row.projectId));
      return { project, preview: yield* getPreview(project.projectId) };
    });

  const getThreadContext = (threadId: ThreadId) => resolveThreadContext(threadId);

  const resolveContextProjectId = (threadId: ThreadId) =>
    Effect.flatMap(resolveThreadContext(threadId), (context) =>
      context.project !== null
        ? Effect.succeed(context.project.projectId)
        : Effect.fail(
            new PersistenceDecodeError({
              operation: "ContextRepository.resolveContextProjectId",
              issue: "This Hub has no Project Context source; its Context is Space-only or empty.",
            }),
          ),
    );

  const buildBindingSnapshot = (threadId: ThreadId, snapshotId: string, createdAt: string) =>
    Effect.gen(function* () {
      const { preview } = yield* resolveThreadContext(threadId);
      return yield* decodeValue<ContextSnapshot>(
        ContextSnapshot,
        { ...preview, snapshotId, createdAt },
        "ContextRepository.buildBindingSnapshot:decode",
      );
    });

  const getThreadDetails = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const threads = yield* sql<{ readonly projectId: string }>`
        SELECT project_id AS "projectId" FROM projection_threads WHERE thread_id = ${threadId}
      `.pipe(Effect.mapError(toPersistenceSqlError("ContextRepository.getThreadDetails:thread")));
      const projectId = threads[0]?.projectId;
      if (!projectId) {
        return yield* new PersistenceDecodeError({
          operation: "ContextRepository.getThreadDetails",
          issue: `Thread '${threadId}' does not exist.`,
        });
      }
      const dataInstanceId = yield* getDataInstanceId;
      const binding = yield* getThreadBinding(threadId);
      const latestPreviewResult = yield* Effect.result(
        getThreadContext(threadId).pipe(Effect.map((context) => context.preview)),
      );
      const preview = latestPreviewResult._tag === "Success" ? latestPreviewResult.success : null;
      const applied = yield* getApplied(threadId);
      const runtimeRows = yield* sql<{
        readonly status: string;
        readonly lifecycleGeneration: string | null;
      }>`
        SELECT status, lifecycle_generation AS "lifecycleGeneration"
        FROM provider_session_runtime WHERE thread_id = ${threadId}
      `.pipe(Effect.mapError(toPersistenceSqlError("ContextRepository.getThreadDetails:runtime")));
      const runtime = runtimeRows[0];
      const isBound = binding?.mode === "bound" && binding.snapshot !== undefined;
      const boundSnapshot = binding?.mode === "bound" ? binding.snapshot : undefined;
      const sameAppliedSnapshot =
        boundSnapshot !== undefined &&
        applied !== undefined &&
        applied.snapshotId === boundSnapshot.snapshotId &&
        applied.snapshotHash === boundSnapshot.snapshotHash;
      let loadStatus: ThreadContextDetails["loadStatus"] = "absent";
      if (isBound) {
        if (runtime?.status === "error") loadStatus = "failed";
        else if (runtime?.status === "stopped") loadStatus = "stopped";
        else if (
          runtime?.status === "running" &&
          sameAppliedSnapshot &&
          applied !== undefined &&
          runtime.lifecycleGeneration === applied.lifecycleGeneration
        ) {
          loadStatus = "loaded";
        } else {
          loadStatus = "pending";
        }
      }
      return yield* decodeValue<ThreadContextDetails>(
        ThreadContextDetails,
        {
          dataInstanceId,
          threadId,
          mode: binding?.mode ?? "legacy",
          snapshot: binding?.snapshot ?? null,
          preview: binding?.mode === "unbound" ? preview : null,
          applied: applied ?? null,
          loadStatus,
          hasNewVersion:
            boundSnapshot !== undefined &&
            preview !== null &&
            hasNewContextVersion(boundSnapshot, preview),
          retry: null,
          error:
            runtime?.status === "error"
              ? "Context failed to load for this runtime."
              : preview === null && isBound
                ? "The immutable Context snapshot is preserved, but the current source could not be compared."
                : preview === null && binding?.mode === "unbound"
                  ? "The current Context source could not be loaded."
                  : null,
        },
        "ContextRepository.getThreadDetails:decode",
      );
    });

  const getCommandResult = (commandId: CommandId) =>
    Effect.gen(function* () {
      const rows = yield* sql<{ readonly resultJson: string }>`
        SELECT result_json AS "resultJson" FROM context_command_results
        WHERE command_id = ${commandId}
      `.pipe(Effect.mapError(toPersistenceSqlError("ContextRepository.getCommandResult")));
      const row = rows[0];
      if (!row) {
        const reconciliations = yield* sql<{ readonly outcome: string }>`
          SELECT outcome FROM provider_delivery_reconciliations
          WHERE reconciliation_id = ${`context-retry:${commandId}`}
          LIMIT 1
        `.pipe(
          Effect.mapError(
            toPersistenceSqlError("ContextRepository.getCommandResult:retry-reconciliation"),
          ),
        );
        return reconciliations[0]?.outcome === "safe_retry"
          ? { commandId, status: "saved" as const }
          : { commandId, status: "unknown" as const };
      }
      return yield* decodeJson<ContextCommandResult>(
        ContextCommandResult,
        row.resultJson,
        "ContextRepository.getCommandResult:decode",
      );
    });

  const recordCommandResult = (result: ContextCommandResult) =>
    sql`
      INSERT INTO context_command_results (command_id, result_json)
      VALUES (${result.commandId}, ${JSON.stringify(result)})
      ON CONFLICT (command_id) DO NOTHING
    `.pipe(Effect.mapError(toPersistenceSqlError("ContextRepository.recordCommandResult")));

  const currentProject = (projectId: ProjectId) => getProject(projectId);

  const resolveSpaceSave = (event: SpaceSaveEvent) =>
    Effect.gen(function* () {
      const input = event.payload;
      const current = yield* getSpace(input.spaceId);
      const dataInstanceId = yield* getDataInstanceId;
      if (input.dataInstanceId !== dataInstanceId) {
        return {
          commandId: input.commandId,
          status: "rejected" as const,
          space: current,
          message: "This Space belongs to a different data instance.",
        };
      }
      if (
        current.revision !== input.expectedRevision ||
        current.name !== input.expectedName ||
        current.icon !== input.expectedIcon
      ) {
        return {
          commandId: input.commandId,
          status: "conflict" as const,
          space: current,
          message: "The Space changed after this edit was opened.",
        };
      }
      const validatedName = yield* decodeValue<typeof SpaceName.Type>(
        SpaceName,
        input.name,
        "ContextRepository.saveSpace:name",
      ).pipe(Effect.catch(() => Effect.succeed(null)));
      const validatedIcon = yield* decodeValue<typeof SpaceIconName.Type>(
        SpaceIconName,
        input.icon,
        "ContextRepository.saveSpace:icon",
      ).pipe(Effect.catch(() => Effect.succeed(null)));
      if (validatedName === null || validatedIcon === null) {
        return {
          commandId: input.commandId,
          status: "rejected" as const,
          space: current,
          message: "The Space name or icon is invalid.",
        };
      }
      const duplicate = yield* sql<{ readonly spaceId: string }>`
        SELECT space_id AS "spaceId" FROM projection_spaces
        WHERE name = ${validatedName} AND deleted_at IS NULL AND space_id <> ${input.spaceId}
        LIMIT 1
      `.pipe(Effect.mapError(toPersistenceSqlError("ContextRepository.checkSpaceName")));
      if (duplicate.length > 0) {
        return {
          commandId: input.commandId,
          status: "conflict" as const,
          space: current,
          message: "A Space with this name already exists.",
        };
      }
      const changedText =
        current.directionGoal !== input.directionGoal ||
        current.sharedInstructions !== input.sharedInstructions;
      return {
        commandId: input.commandId,
        status: "saved" as const,
        space: {
          ...current,
          name: validatedName,
          icon: validatedIcon,
          directionGoal: input.directionGoal,
          sharedInstructions: input.sharedInstructions,
          revision: current.revision + (changedText ? 1 : 0),
        },
      };
    });

  const resolveProjectSave = (event: ProjectSaveEvent) =>
    Effect.gen(function* () {
      const input = event.payload;
      const current = yield* getProject(input.projectId);
      const dataInstanceId = yield* getDataInstanceId;
      if (input.dataInstanceId !== dataInstanceId) {
        return {
          commandId: input.commandId,
          status: "rejected" as const,
          project: current,
          message: "This Project belongs to a different data instance.",
        };
      }
      if (current.revision !== input.expectedRevision) {
        return {
          commandId: input.commandId,
          status: "conflict" as const,
          project: current,
          message: "The Project context changed after this edit was opened.",
        };
      }
      const changedText =
        current.projectGoal !== input.projectGoal ||
        current.projectInstructions !== input.projectInstructions;
      return {
        commandId: input.commandId,
        status: "saved" as const,
        project: {
          ...current,
          projectGoal: input.projectGoal,
          projectInstructions: input.projectInstructions,
          revision: current.revision + (changedText ? 1 : 0),
        },
      };
    });

  const prepareSpaceSave = (event: SpaceSaveEvent) =>
    event.payload.result !== undefined
      ? Effect.succeed(event)
      : Effect.map(resolveSpaceSave(event), (result) => ({
          ...event,
          payload: { ...event.payload, result },
        }));

  const prepareProjectSave = (event: ProjectSaveEvent) =>
    event.payload.result !== undefined
      ? Effect.succeed(event)
      : Effect.map(resolveProjectSave(event), (result) => ({
          ...event,
          payload: { ...event.payload, result },
        }));

  const applySpaceSave = (
    event: Extract<OrchestrationEvent, { type: "context.space.save-requested" }>,
  ) =>
    Effect.gen(function* () {
      const input = event.payload;
      const result = input.result;
      if (result === undefined || result.commandId !== input.commandId) {
        return yield* new PersistenceDecodeError({
          operation: "ContextRepository.applySpaceSave",
          issue: "A replayable Space save event must carry its matching frozen command result.",
        });
      }
      if (result.status === "saved") {
        if (result.space === undefined || result.space.spaceId !== input.spaceId) {
          return yield* new PersistenceDecodeError({
            operation: "ContextRepository.applySpaceSave",
            issue: "A saved Space event must carry its committed Space settings.",
          });
        }
        const saved = result.space;
        yield* sql`
          INSERT INTO context_spaces (
            space_id, direction_goal, shared_instructions, revision, updated_at
          ) VALUES (
            ${input.spaceId}, ${saved.directionGoal}, ${saved.sharedInstructions}, ${saved.revision}, ${event.occurredAt}
          )
          ON CONFLICT (space_id) DO UPDATE SET
            direction_goal = excluded.direction_goal,
            shared_instructions = excluded.shared_instructions,
            revision = excluded.revision,
            updated_at = excluded.updated_at
        `.pipe(Effect.mapError(toPersistenceSqlError("ContextRepository.applySpaceSave")));
      }
      yield* recordCommandResult(result);
    });

  const applyProjectSave = (
    event: Extract<OrchestrationEvent, { type: "context.project.save-requested" }>,
  ) =>
    Effect.gen(function* () {
      const input = event.payload;
      const result = input.result;
      if (result === undefined || result.commandId !== input.commandId) {
        return yield* new PersistenceDecodeError({
          operation: "ContextRepository.applyProjectSave",
          issue: "A replayable Project save event must carry its matching frozen command result.",
        });
      }
      if (result.status === "saved") {
        if (result.project === undefined || result.project.projectId !== input.projectId) {
          return yield* new PersistenceDecodeError({
            operation: "ContextRepository.applyProjectSave",
            issue: "A saved Project event must carry its committed Project settings.",
          });
        }
        const saved = result.project;
        yield* sql`
          INSERT INTO context_projects (
            project_id, project_goal, project_instructions, revision, updated_at
          ) VALUES (
            ${input.projectId}, ${saved.projectGoal}, ${saved.projectInstructions}, ${saved.revision}, ${event.occurredAt}
          )
          ON CONFLICT (project_id) DO UPDATE SET
            project_goal = excluded.project_goal,
            project_instructions = excluded.project_instructions,
            revision = excluded.revision,
            updated_at = excluded.updated_at
        `.pipe(Effect.mapError(toPersistenceSqlError("ContextRepository.applyProjectSave")));
      }
      yield* recordCommandResult(result);
    });

  const prepareBinding = (event: BindRequestedEvent) =>
    event.payload.snapshot !== undefined
      ? Effect.succeed(event)
      : Effect.map(
          buildBindingSnapshot(event.payload.threadId, event.eventId, event.payload.createdAt),
          (snapshot) => ({ ...event, payload: { ...event.payload, snapshot } }),
        );

  const resolveMigrationClaim = (event: MigrationClaimEvent) =>
    Effect.gen(function* () {
      const input = event.payload;
      const project = yield* currentProject(input.projectId);
      const dataInstanceId = yield* getDataInstanceId;
      const digest = createHash("sha256").update(input.legacyInstructions, "utf8").digest("hex");
      if (input.dataInstanceId !== dataInstanceId) {
        return {
          commandId: input.commandId,
          status: "rejected" as const,
          project,
          message: "This Project belongs to a different data instance.",
        };
      }
      if (input.expectedWorkspaceRoot !== project.workspaceRoot) {
        return {
          commandId: input.commandId,
          status: "rejected" as const,
          project,
          message: "The Project workspace changed before the legacy context was claimed.",
        };
      }
      if (digest !== input.sourceDigest) {
        return {
          commandId: input.commandId,
          status: "rejected" as const,
          project,
          message: "The legacy source digest does not match the supplied UTF-8 content.",
        };
      }
      if (project.migration !== null) {
        const sameSource = project.migration.sourceDigest === input.sourceDigest;
        return {
          commandId: input.commandId,
          status: sameSource ? ("saved" as const) : ("conflict" as const),
          project,
          ...(sameSource ? { migration: project.migration } : {}),
          ...(sameSource
            ? {}
            : { message: "A different legacy source is already claimed for this Project." }),
        };
      }
      const migration = yield* decodeValue<ContextMigrationRecord>(
        ContextMigrationRecord,
        {
          projectId: input.projectId,
          sourceDigest: input.sourceDigest,
          legacyInstructions: input.legacyInstructions,
          status:
            project.projectInstructions.length > 0 &&
            project.projectInstructions !== input.legacyInstructions
              ? "conflict"
              : "pending",
          choice: null,
          updatedAt: event.occurredAt,
        },
        "ContextRepository.prepareMigrationClaim:migration",
      );
      return {
        commandId: input.commandId,
        status: "saved" as const,
        project: { ...project, migration },
        migration,
      };
    });

  const prepareMigrationClaim = (event: MigrationClaimEvent) =>
    event.payload.result !== undefined
      ? Effect.succeed(event)
      : Effect.map(resolveMigrationClaim(event), (result) => ({
          ...event,
          payload: { ...event.payload, result },
        }));

  const resolveMigrationResolution = (event: MigrationResolveEvent) =>
    Effect.gen(function* () {
      const input = event.payload;
      const project = yield* currentProject(input.projectId);
      const dataInstanceId = yield* getDataInstanceId;
      const migration = project.migration;
      if (input.dataInstanceId !== dataInstanceId) {
        return {
          commandId: input.commandId,
          status: "rejected" as const,
          project,
          message: "This Project belongs to a different data instance.",
        };
      }
      if (!migration || migration.sourceDigest !== input.sourceDigest) {
        return {
          commandId: input.commandId,
          status: "conflict" as const,
          project,
          message: "The claimed legacy source changed before resolution.",
        };
      }
      if (project.revision !== input.expectedRevision) {
        return {
          commandId: input.commandId,
          status: "conflict" as const,
          project,
          migration,
          message: "The Project context changed before migration resolution.",
        };
      }
      if (input.instructions !== undefined && input.instructions !== migration.legacyInstructions) {
        return {
          commandId: input.commandId,
          status: "rejected" as const,
          project,
          migration,
          message: "The resolution text must match the claimed legacy source exactly.",
        };
      }
      const useLegacy = input.choice === "use_legacy";
      const changedText = useLegacy && project.projectInstructions !== migration.legacyInstructions;
      const committedProject = {
        ...project,
        projectInstructions: changedText
          ? migration.legacyInstructions
          : project.projectInstructions,
        revision: project.revision + (changedText ? 1 : 0),
      };
      const completedMigration = yield* decodeValue<ContextMigrationRecord>(
        ContextMigrationRecord,
        { ...migration, status: "completed", choice: input.choice, updatedAt: event.occurredAt },
        "ContextRepository.prepareMigrationResolve:migration",
      );
      return {
        commandId: input.commandId,
        status: "saved" as const,
        project: { ...committedProject, migration: completedMigration },
        migration: completedMigration,
      };
    });

  const prepareMigrationResolve = (event: MigrationResolveEvent) =>
    event.payload.result !== undefined
      ? Effect.succeed(event)
      : Effect.map(resolveMigrationResolution(event), (result) => ({
          ...event,
          payload: { ...event.payload, result },
        }));

  const applyMigrationClaim = (
    event: Extract<OrchestrationEvent, { type: "context.migration.claim-requested" }>,
  ) =>
    Effect.gen(function* () {
      const input = event.payload;
      const result = input.result;
      if (result === undefined || result.commandId !== input.commandId) {
        return yield* new PersistenceDecodeError({
          operation: "ContextRepository.applyMigrationClaim",
          issue: "A replayable migration claim must carry its matching frozen command result.",
        });
      }
      if (result.status === "saved") {
        const project = result.project;
        const migration = result.migration;
        if (
          project === undefined ||
          project.projectId !== input.projectId ||
          migration === undefined ||
          migration.projectId !== input.projectId ||
          migration.sourceDigest !== input.sourceDigest ||
          migration.legacyInstructions !== input.legacyInstructions ||
          project.migration?.sourceDigest !== migration.sourceDigest
        ) {
          return yield* new PersistenceDecodeError({
            operation: "ContextRepository.applyMigrationClaim",
            issue: "A saved migration claim must carry its exact committed migration record.",
          });
        }
        yield* sql`
          INSERT INTO context_migrations (
            project_id, source_digest, legacy_instructions, status, choice, updated_at
          ) VALUES (
            ${input.projectId}, ${migration.sourceDigest}, ${migration.legacyInstructions},
            ${migration.status}, ${migration.choice}, ${migration.updatedAt}
          )
          ON CONFLICT (project_id) DO UPDATE SET
            source_digest = excluded.source_digest,
            legacy_instructions = excluded.legacy_instructions,
            status = excluded.status,
            choice = excluded.choice,
            updated_at = excluded.updated_at
        `.pipe(Effect.mapError(toPersistenceSqlError("ContextRepository.applyMigrationClaim")));
      }
      yield* recordCommandResult(result);
    });

  const applyMigrationResolve = (
    event: Extract<OrchestrationEvent, { type: "context.migration.resolve-requested" }>,
  ) =>
    Effect.gen(function* () {
      const input = event.payload;
      const result = input.result;
      if (result === undefined || result.commandId !== input.commandId) {
        return yield* new PersistenceDecodeError({
          operation: "ContextRepository.applyMigrationResolve",
          issue: "A replayable migration resolution must carry its matching frozen command result.",
        });
      }
      if (result.status === "saved") {
        const project = result.project;
        const migration = result.migration;
        if (
          project === undefined ||
          project.projectId !== input.projectId ||
          migration === undefined ||
          migration.projectId !== input.projectId ||
          migration.sourceDigest !== input.sourceDigest ||
          migration.status !== "completed" ||
          migration.choice !== input.choice ||
          project.migration?.sourceDigest !== migration.sourceDigest
        ) {
          return yield* new PersistenceDecodeError({
            operation: "ContextRepository.applyMigrationResolve",
            issue:
              "A saved migration resolution must carry its exact committed Project and migration values.",
          });
        }
        yield* sql`
          INSERT INTO context_projects (
            project_id, project_goal, project_instructions, revision, updated_at
          ) VALUES (
            ${input.projectId}, ${project.projectGoal}, ${project.projectInstructions}, ${project.revision}, ${event.occurredAt}
          )
          ON CONFLICT (project_id) DO UPDATE SET
            project_goal = excluded.project_goal,
            project_instructions = excluded.project_instructions,
            revision = excluded.revision,
            updated_at = excluded.updated_at
        `.pipe(
          Effect.mapError(toPersistenceSqlError("ContextRepository.applyMigrationResolve:project")),
        );
        yield* sql`
          INSERT INTO context_migrations (
            project_id, source_digest, legacy_instructions, status, choice, updated_at
          ) VALUES (
            ${input.projectId}, ${migration.sourceDigest}, ${migration.legacyInstructions},
            ${migration.status}, ${migration.choice}, ${migration.updatedAt}
          )
          ON CONFLICT (project_id) DO UPDATE SET
            source_digest = excluded.source_digest,
            legacy_instructions = excluded.legacy_instructions,
            status = excluded.status,
            choice = excluded.choice,
            updated_at = excluded.updated_at
        `.pipe(
          Effect.mapError(
            toPersistenceSqlError("ContextRepository.applyMigrationResolve:migration"),
          ),
        );
      }
      yield* recordCommandResult(result);
    });

  const setBinding = (event: Extract<OrchestrationEvent, { type: "context.thread.binding-set" }>) =>
    Effect.gen(function* () {
      const { threadId, mode, snapshot } = event.payload;
      if (mode === "bound" && snapshot === undefined) {
        return yield* new PersistenceDecodeError({
          operation: "ContextRepository.setBinding",
          issue: "A bound Context event must contain its immutable snapshot.",
        });
      }
      yield* sql`
        INSERT INTO context_thread_bindings (thread_id, mode, snapshot_json)
        VALUES (${threadId}, ${mode}, ${snapshot === undefined ? null : JSON.stringify(snapshot)})
        ON CONFLICT (thread_id) DO NOTHING
      `.pipe(Effect.mapError(toPersistenceSqlError("ContextRepository.setBinding")));
    });

  const bindThread = (
    event: Extract<OrchestrationEvent, { type: "context.thread.bind-requested" }>,
  ) =>
    Effect.gen(function* () {
      const frozenSnapshot = event.payload.snapshot;
      if (frozenSnapshot === undefined) {
        return yield* new PersistenceDecodeError({
          operation: "ContextRepository.bindThread",
          issue: "A first-bind event must carry its frozen Context snapshot.",
        });
      }
      const snapshot = yield* decodeValue<ContextSnapshot>(
        ContextSnapshot,
        frozenSnapshot,
        "ContextRepository.bindThread:snapshot",
      );
      const expectedHash =
        snapshot.schemaVersion === 1
          ? snapshotHash({
              schemaVersion: snapshot.schemaVersion,
              rendererVersion: snapshot.rendererVersion,
              space: snapshot.space,
              project: snapshot.project,
              text: snapshot.text,
              hasContent: snapshot.hasContent,
            })
          : snapshotHash({
              schemaVersion: snapshot.schemaVersion,
              rendererVersion: snapshot.rendererVersion,
              source: snapshot.source,
              space: snapshot.space,
              text: snapshot.text,
              hasContent: snapshot.hasContent,
            });
      if (
        snapshot.snapshotId !== event.eventId ||
        snapshot.createdAt !== event.payload.createdAt ||
        snapshot.snapshotHash !== expectedHash
      ) {
        return yield* new PersistenceDecodeError({
          operation: "ContextRepository.bindThread",
          issue: "A first-bind event must carry its matching immutable Context snapshot.",
        });
      }
      const bindings = yield* sql<{ readonly mode: string }>`
        SELECT mode FROM context_thread_bindings WHERE thread_id = ${event.payload.threadId}
      `.pipe(Effect.mapError(toPersistenceSqlError("ContextRepository.bindThread:binding")));
      const existing = bindings[0];
      if (!existing) return;
      const mode = yield* decodeValue<ContextMode>(
        ContextMode,
        existing.mode,
        "ContextRepository.bindThread:mode",
      );
      if (mode !== "unbound") return;
      yield* sql`
        UPDATE context_thread_bindings SET mode = 'bound', snapshot_json = ${JSON.stringify(snapshot)}
        WHERE thread_id = ${event.payload.threadId} AND mode = 'unbound'
      `.pipe(Effect.mapError(toPersistenceSqlError("ContextRepository.bindThread")));
    });

  const applyEvent = (event: OrchestrationEvent) => {
    switch (event.type) {
      case "context.space.save-requested":
        return applySpaceSave(event);
      case "context.project.save-requested":
        return applyProjectSave(event);
      case "context.migration.claim-requested":
        return applyMigrationClaim(event);
      case "context.migration.resolve-requested":
        return applyMigrationResolve(event);
      case "context.thread.binding-set":
        return setBinding(event);
      case "context.thread.bind-requested":
        return bindThread(event);
      default:
        return Effect.void;
    }
  };

  const getThreadDetailsService = (threadId: ThreadId) => getThreadDetails(threadId);

  return {
    getThreadContext,
    getSpace,
    getProject,
    getThreadBinding,
    getContextSession,
    getApplied,
    upsertApplied,
    getThreadDetails: getThreadDetailsService,
    getCommandResult,
    getPreview,
    resolveContextProjectId,
    buildBindingSnapshot,
    prepareSpaceSave,
    prepareProjectSave,
    prepareMigrationClaim,
    prepareMigrationResolve,
    prepareBinding,
    applyEvent,
  } satisfies ContextRepositoryShape;
});

export const ContextRepositoryLive = Layer.effect(ContextRepository, makeContextRepository);
