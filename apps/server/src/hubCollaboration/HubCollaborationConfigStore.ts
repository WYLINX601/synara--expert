import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { createHash } from "node:crypto";

import {
  HubCollaborationSettings as HubCollaborationSettingsSchema,
  HubTeamArchiveInput as HubTeamArchiveInputSchema,
  HubTeamPreset as HubTeamPresetSchema,
  HubTeamReadInput as HubTeamReadInputSchema,
  HubTeamSaveInput as HubTeamSaveInputSchema,
  type HubCollaborationSettings,
  type HubTeamArchiveInput,
  type HubTeamPreset,
  type HubTeamReadInput,
  type HubTeamSaveInput,
} from "@synara/contracts";

export class HubCollaborationStoreValidationError extends Schema.TaggedErrorClass<HubCollaborationStoreValidationError>()(
  "HubCollaborationStoreValidationError",
  { operation: Schema.String, detail: Schema.String },
) {
  override get message(): string {
    return `Invalid Hub collaboration ${this.operation} input: ${this.detail}`;
  }
}

export class HubCollaborationStoreConflictError extends Schema.TaggedErrorClass<HubCollaborationStoreConflictError>()(
  "HubCollaborationStoreConflictError",
  {
    resourceId: Schema.String,
    expectedRevision: Schema.NullOr(Schema.Number),
    actualRevision: Schema.NullOr(Schema.Number),
  },
) {
  override get message(): string {
    return `Hub collaboration resource ${this.resourceId} changed (expected revision ${this.expectedRevision ?? "none"}, current revision ${this.actualRevision ?? "none"}).`;
  }
}

export class HubCollaborationStoreNotFoundError extends Schema.TaggedErrorClass<HubCollaborationStoreNotFoundError>()(
  "HubCollaborationStoreNotFoundError",
  { resourceId: Schema.String },
) {
  override get message(): string {
    return `Hub team preset ${this.resourceId} was not found.`;
  }
}

export class HubCollaborationStoreIdempotencyError extends Schema.TaggedErrorClass<HubCollaborationStoreIdempotencyError>()(
  "HubCollaborationStoreIdempotencyError",
  { resourceId: Schema.String, requestId: Schema.String },
) {
  override get message(): string {
    return `Hub collaboration request ${this.requestId} was already used with a different payload for ${this.resourceId}.`;
  }
}

export class HubCollaborationStoreDecodeError extends Schema.TaggedErrorClass<HubCollaborationStoreDecodeError>()(
  "HubCollaborationStoreDecodeError",
  { operation: Schema.String, detail: Schema.String },
) {
  override get message(): string {
    return `Could not read Hub collaboration data during ${this.operation}: ${this.detail}`;
  }
}

export class HubCollaborationStoreSqlError extends Schema.TaggedErrorClass<HubCollaborationStoreSqlError>()(
  "HubCollaborationStoreSqlError",
  { operation: Schema.String, detail: Schema.String },
) {
  override get message(): string {
    return `Hub collaboration storage failed during ${this.operation}: ${this.detail}`;
  }
}

export type HubCollaborationStoreError =
  | HubCollaborationStoreValidationError
  | HubCollaborationStoreConflictError
  | HubCollaborationStoreNotFoundError
  | HubCollaborationStoreIdempotencyError
  | HubCollaborationStoreDecodeError
  | HubCollaborationStoreSqlError;

export interface HubCollaborationConfigSaveInput {
  readonly hubId: string;
  readonly expectedRevision: number | null;
  readonly requestId: string;
  readonly settings: HubCollaborationSettings;
}

export interface HubCollaborationConfigSnapshot {
  readonly hubId: string;
  readonly revision: number;
  readonly settings: HubCollaborationSettings;
  /** Current roster for readHubSettings; saved roster for a write/replay result. */
  readonly expertIds: readonly string[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface HubCollaborationConfigRevision {
  readonly hubId: string;
  readonly revision: number;
  readonly settings: HubCollaborationSettings;
  readonly expertIds: readonly string[];
  readonly requestId: string;
  readonly createdAt: string;
}

export interface HubCollaborationConfigStore {
  /** Includes archived presets unless explicitly filtered out. */
  readonly listTeams: (input?: {
    readonly includeArchived?: boolean;
  }) => Effect.Effect<readonly HubTeamPreset[], HubCollaborationStoreError>;
  readonly readTeam: (
    input: HubTeamReadInput,
  ) => Effect.Effect<HubTeamPreset | null, HubCollaborationStoreError>;
  readonly saveTeam: (
    input: HubTeamSaveInput,
  ) => Effect.Effect<HubTeamPreset, HubCollaborationStoreError>;
  readonly setTeamArchived: (
    input: HubTeamArchiveInput,
  ) => Effect.Effect<HubTeamPreset, HubCollaborationStoreError>;
  readonly readHubSettings: (input: {
    readonly hubId: string;
  }) => Effect.Effect<HubCollaborationConfigSnapshot | null, HubCollaborationStoreError>;
  readonly readHubSettingsHistory: (input: {
    readonly hubId: string;
  }) => Effect.Effect<readonly HubCollaborationConfigRevision[], HubCollaborationStoreError>;
  readonly saveHubSettings: (
    input: HubCollaborationConfigSaveInput,
  ) => Effect.Effect<HubCollaborationConfigSnapshot, HubCollaborationStoreError>;
  /** Uses the same ambient SqlClient transaction as the calling repository. */
  readonly saveHubSettingsInTransaction: (
    input: HubCollaborationConfigSaveInput,
  ) => Effect.Effect<HubCollaborationConfigSnapshot, HubCollaborationStoreError>;
}

interface TeamRow {
  readonly id: string;
  readonly name: string;
  readonly purpose: string;
  readonly expertIdsJson: string;
  readonly coordinatorInstructions: string | null;
  readonly collaborationPreferences: string | null;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly archivedAt: string | null;
}

interface TeamRevisionRow extends TeamRow {
  readonly requestId: string;
  readonly payloadDigest: string;
  readonly operation: "save" | "archive" | "restore";
}

interface ConfigRow {
  readonly hubId: string;
  readonly revision: number;
  readonly settingsJson: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly expertIdsJson: string;
}

interface ConfigRevisionRow {
  readonly hubId: string;
  readonly revision: number;
  readonly settingsJson: string;
  readonly expertIdsJson: string;
  readonly requestId: string;
  readonly payloadDigest: string;
  readonly createdAt: string;
}

interface ReceiptRow {
  readonly payloadDigest: string;
  readonly resultJson: string;
}

const CONFIG_SNAPSHOT_SCHEMA = Schema.Struct({
  hubId: Schema.String,
  revision: Schema.Number,
  settings: HubCollaborationSettingsSchema,
  expertIds: Schema.Array(Schema.String),
  createdAt: Schema.String,
  updatedAt: Schema.String,
});

const CONFIG_REVISION_SCHEMA = Schema.Struct({
  hubId: Schema.String,
  revision: Schema.Number,
  settings: HubCollaborationSettingsSchema,
  expertIds: Schema.Array(Schema.String),
  requestId: Schema.String,
  createdAt: Schema.String,
});

const decodeFailure = (operation: string, cause: unknown) =>
  new HubCollaborationStoreDecodeError({
    operation,
    detail: cause instanceof Error ? cause.message : String(cause),
  });

const validationFailure = (operation: string, cause: unknown) =>
  new HubCollaborationStoreValidationError({
    operation,
    detail: cause instanceof Error ? cause.message : String(cause),
  });

const decodeUnknown = <A>(schema: Schema.Decoder<A>, value: unknown, operation: string) =>
  Effect.try({
    try: () => Schema.decodeUnknownSync(schema)(value),
    catch: (cause) => validationFailure(operation, cause),
  });

const decodeStored = <A>(schema: Schema.Decoder<A>, value: unknown, operation: string) =>
  Effect.try({
    try: () => Schema.decodeUnknownSync(schema)(value),
    catch: (cause) => decodeFailure(operation, cause),
  });

const parseJson = (
  value: string,
  operation: string,
): Effect.Effect<unknown, HubCollaborationStoreDecodeError> =>
  Effect.try({
    try: () => JSON.parse(value) as unknown,
    catch: (cause) => decodeFailure(operation, cause),
  });

const normalizeOptionalText = (value: string | undefined): string | undefined => {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
};

const normalizeExpertIds = (expertIds: readonly string[]): string[] => {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const raw of expertIds) {
    const expertId = raw.trim();
    if (expertId.length === 0 || seen.has(expertId)) continue;
    seen.add(expertId);
    normalized.push(expertId);
  }
  return normalized;
};

const normalizeTeamSave = (input: HubTeamSaveInput) =>
  decodeUnknown(
    HubTeamSaveInputSchema,
    {
      ...input,
      id: input.id.trim(),
      name: input.name.trim(),
      purpose: input.purpose.trim(),
      expertIds: normalizeExpertIds(input.expertIds),
      requestId: input.requestId.trim(),
      ...(normalizeOptionalText(input.coordinatorInstructions) === undefined
        ? { coordinatorInstructions: undefined }
        : { coordinatorInstructions: normalizeOptionalText(input.coordinatorInstructions) }),
      ...(normalizeOptionalText(input.collaborationPreferences) === undefined
        ? { collaborationPreferences: undefined }
        : { collaborationPreferences: normalizeOptionalText(input.collaborationPreferences) }),
    },
    "team preset save",
  );

const normalizeTeamArchive = (input: HubTeamArchiveInput) =>
  decodeUnknown(
    HubTeamArchiveInputSchema,
    { ...input, id: input.id.trim(), requestId: input.requestId.trim() },
    "team preset archive",
  );

const normalizeTeamRead = (input: HubTeamReadInput) =>
  decodeUnknown(HubTeamReadInputSchema, { ...input, id: input.id.trim() }, "team preset read");

export const normalizeHubCollaborationSettings = (
  settings: HubCollaborationSettings,
): Effect.Effect<HubCollaborationSettings, HubCollaborationStoreValidationError> => {
  const presetSource = settings.presetSource;
  return decodeUnknown(
    HubCollaborationSettingsSchema,
    {
      schemaVersion: settings.schemaVersion,
      mode: settings.mode,
      ...(normalizeOptionalText(settings.coordinatorInstructions) === undefined
        ? {}
        : { coordinatorInstructions: normalizeOptionalText(settings.coordinatorInstructions) }),
      ...(normalizeOptionalText(settings.collaborationPreferences) === undefined
        ? {}
        : { collaborationPreferences: normalizeOptionalText(settings.collaborationPreferences) }),
      ...(presetSource === undefined
        ? {}
        : { presetSource: { id: presetSource.id.trim(), revision: presetSource.revision } }),
    },
    "Hub settings save",
  );
};

const normalizeHubSave = (input: HubCollaborationConfigSaveInput) =>
  Effect.gen(function* () {
    const settings = yield* normalizeHubCollaborationSettings(input.settings);
    const hubId = input.hubId.trim();
    const requestId = input.requestId.trim();
    if (hubId.length === 0 || requestId.length === 0) {
      return yield* Effect.fail(
        validationFailure("Hub settings save", new Error("hubId and requestId must be non-empty.")),
      );
    }
    return { ...input, hubId, requestId, settings };
  });

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

const isStoreError = (cause: unknown): cause is HubCollaborationStoreError =>
  cause instanceof HubCollaborationStoreValidationError ||
  cause instanceof HubCollaborationStoreConflictError ||
  cause instanceof HubCollaborationStoreNotFoundError ||
  cause instanceof HubCollaborationStoreIdempotencyError ||
  cause instanceof HubCollaborationStoreDecodeError ||
  cause instanceof HubCollaborationStoreSqlError;

const mapFailure = (operation: string) =>
  Effect.mapError(
    (cause: unknown): HubCollaborationStoreError =>
      isStoreError(cause)
        ? cause
        : new HubCollaborationStoreSqlError({
            operation,
            detail: cause instanceof Error ? cause.message : String(cause),
          }),
  );

const rowToTeam = (row: TeamRow, operation: string) =>
  Effect.gen(function* () {
    const expertIdsRaw = yield* parseJson(row.expertIdsJson, operation);
    return yield* decodeStored(
      HubTeamPresetSchema,
      {
        id: row.id,
        name: row.name,
        purpose: row.purpose,
        expertIds: expertIdsRaw,
        ...(row.coordinatorInstructions === null
          ? {}
          : { coordinatorInstructions: row.coordinatorInstructions }),
        ...(row.collaborationPreferences === null
          ? {}
          : { collaborationPreferences: row.collaborationPreferences }),
        revision: row.revision,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        archivedAt: row.archivedAt,
      },
      operation,
    );
  });

const rowToConfig = (row: ConfigRow, operation: string) =>
  Effect.gen(function* () {
    const settingsRaw = yield* parseJson(row.settingsJson, operation);
    const expertIdsRaw = yield* parseJson(row.expertIdsJson, operation);
    const settings = yield* decodeStored(HubCollaborationSettingsSchema, settingsRaw, operation);
    const expertIds = yield* decodeStored(Schema.Array(Schema.String), expertIdsRaw, operation);
    return yield* decodeStored(
      CONFIG_SNAPSHOT_SCHEMA,
      {
        hubId: row.hubId,
        revision: row.revision,
        settings,
        expertIds,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      },
      operation,
    );
  });

const jsonValue = (value: unknown) => JSON.stringify(value);

const currentTeamSql = (sql: SqlClient.SqlClient, id: string) =>
  sql<TeamRow>`
    SELECT
      id,
      name,
      purpose,
      expert_ids_json AS "expertIdsJson",
      coordinator_instructions AS "coordinatorInstructions",
      collaboration_preferences AS "collaborationPreferences",
      revision,
      created_at AS "createdAt",
      updated_at AS "updatedAt",
      archived_at AS "archivedAt"
    FROM hub_team_presets
    WHERE id = ${id}
  `;

const insertReceipt = (
  sql: SqlClient.SqlClient,
  input: {
    readonly operationScope: "team-save" | "team-archive" | "hub-settings-save";
    readonly aggregateId: string;
    readonly requestId: string;
    readonly payloadDigest: string;
    readonly result: unknown;
    readonly createdAt: string;
  },
) =>
  sql`
    INSERT INTO hub_collaboration_operation_receipts (
      operation_scope, aggregate_id, request_id, payload_digest, result_json, created_at
    ) VALUES (
      ${input.operationScope}, ${input.aggregateId}, ${input.requestId},
      ${input.payloadDigest}, ${jsonValue(input.result)}, ${input.createdAt}
    )
  `;

const readReceipt = (
  sql: SqlClient.SqlClient,
  operationScope: "team-save" | "team-archive" | "hub-settings-save",
  aggregateId: string,
  requestId: string,
) =>
  sql<ReceiptRow>`
    SELECT payload_digest AS "payloadDigest", result_json AS "resultJson"
    FROM hub_collaboration_operation_receipts
    WHERE operation_scope = ${operationScope}
      AND aggregate_id = ${aggregateId}
      AND request_id = ${requestId}
    LIMIT 1
  `;

const replayReceipt = <A>(input: {
  readonly sql: SqlClient.SqlClient;
  readonly operationScope: "team-save" | "team-archive" | "hub-settings-save";
  readonly aggregateId: string;
  readonly requestId: string;
  readonly payloadDigest: string;
  readonly schema: Schema.Decoder<A>;
  readonly operation: string;
}): Effect.Effect<A | null, HubCollaborationStoreError> =>
  Effect.gen(function* () {
    const rows = yield* readReceipt(
      input.sql,
      input.operationScope,
      input.aggregateId,
      input.requestId,
    );
    const receipt = rows[0];
    if (!receipt) return null;
    if (receipt.payloadDigest !== input.payloadDigest) {
      return yield* Effect.fail(
        new HubCollaborationStoreIdempotencyError({
          resourceId: input.aggregateId,
          requestId: input.requestId,
        }),
      );
    }
    const raw = yield* parseJson(receipt.resultJson, input.operation);
    return yield* decodeStored(input.schema, raw, input.operation);
  }).pipe(mapFailure(input.operation));

const readConfigSql = (sql: SqlClient.SqlClient, hubId: string) =>
  sql<ConfigRow>`
    SELECT
      config.hub_id AS "hubId",
      config.revision,
      config.settings_json AS "settingsJson",
      (
        SELECT revision.created_at
        FROM hub_collaboration_config_revisions AS revision
        WHERE revision.hub_id = config.hub_id
        ORDER BY revision.revision ASC
        LIMIT 1
      ) AS "createdAt",
      config.updated_at AS "updatedAt",
      COALESCE(
        (
          SELECT json_group_array(participant.expert_id)
          FROM (
            SELECT expert_id
            FROM hub_expert_participants
            WHERE hub_id = config.hub_id
            ORDER BY expert_id
          ) AS participant
        ),
        '[]'
      ) AS "expertIdsJson"
    FROM hub_collaboration_configs AS config
    WHERE config.hub_id = ${hubId}
  `;

const readConfigHistoryRows = (sql: SqlClient.SqlClient, hubId: string) =>
  sql<ConfigRevisionRow>`
    SELECT
      hub_id AS "hubId",
      revision,
      settings_json AS "settingsJson",
      expert_ids_json AS "expertIdsJson",
      request_id AS "requestId",
      payload_digest AS "payloadDigest",
      created_at AS "createdAt"
    FROM hub_collaboration_config_revisions
    WHERE hub_id = ${hubId}
    ORDER BY revision ASC
  `;

const readParticipantIds = (sql: SqlClient.SqlClient, hubId: string) =>
  sql<{ readonly expertId: string }>`
    SELECT expert_id AS "expertId"
    FROM hub_expert_participants
    WHERE hub_id = ${hubId}
    ORDER BY expert_id
  `;

const rowToConfigRevision = (row: ConfigRevisionRow) =>
  Effect.gen(function* () {
    const settingsRaw = yield* parseJson(row.settingsJson, "Hub settings history");
    const expertIdsRaw = yield* parseJson(row.expertIdsJson, "Hub settings history");
    const settings = yield* decodeStored(
      HubCollaborationSettingsSchema,
      settingsRaw,
      "Hub settings history",
    );
    const expertIds = yield* decodeStored(
      Schema.Array(Schema.String),
      expertIdsRaw,
      "Hub settings history",
    );
    return yield* decodeStored(
      CONFIG_REVISION_SCHEMA,
      {
        hubId: row.hubId,
        revision: row.revision,
        settings,
        expertIds,
        requestId: row.requestId,
        createdAt: row.createdAt,
      },
      "Hub settings history",
    );
  });

const normalizeReadHubId = (raw: string, operation: string) => {
  const hubId = raw.trim();
  return hubId.length > 0
    ? Effect.succeed(hubId)
    : Effect.fail(validationFailure(operation, new Error("hubId must be non-empty.")));
};

const saveTeamTransaction = (sql: SqlClient.SqlClient, input: HubTeamSaveInput) =>
  Effect.gen(function* () {
    const payloadDigest = digest({
      id: input.id,
      expectedRevision: input.expectedRevision,
      name: input.name,
      purpose: input.purpose,
      expertIds: input.expertIds,
      coordinatorInstructions: input.coordinatorInstructions ?? null,
      collaborationPreferences: input.collaborationPreferences ?? null,
    });
    const replay = yield* replayReceipt({
      sql,
      operationScope: "team-save",
      aggregateId: input.id,
      requestId: input.requestId,
      payloadDigest,
      schema: HubTeamPresetSchema,
      operation: "team preset save receipt",
    });
    if (replay) return replay;

    const existingRows = yield* currentTeamSql(sql, input.id);
    const existing = existingRows[0];
    const actualRevision = existing?.revision ?? null;
    if (actualRevision !== input.expectedRevision) {
      return yield* Effect.fail(
        new HubCollaborationStoreConflictError({
          resourceId: input.id,
          expectedRevision: input.expectedRevision,
          actualRevision,
        }),
      );
    }

    const now = new Date().toISOString();
    const revision = (existing?.revision ?? 0) + 1;
    const createdAt = existing?.createdAt ?? now;
    const archivedAt = existing?.archivedAt ?? null;
    const result = {
      id: input.id,
      name: input.name,
      purpose: input.purpose,
      expertIds: input.expertIds,
      ...(input.coordinatorInstructions === undefined
        ? {}
        : { coordinatorInstructions: input.coordinatorInstructions }),
      ...(input.collaborationPreferences === undefined
        ? {}
        : { collaborationPreferences: input.collaborationPreferences }),
      revision,
      createdAt,
      updatedAt: now,
      archivedAt,
    } satisfies HubTeamPreset;

    if (existing) {
      const updated = yield* sql<{ readonly id: string }>`
        UPDATE hub_team_presets
        SET
          name = ${input.name},
          purpose = ${input.purpose},
          expert_ids_json = ${jsonValue(input.expertIds)},
          coordinator_instructions = ${input.coordinatorInstructions ?? null},
          collaboration_preferences = ${input.collaborationPreferences ?? null},
          revision = ${revision},
          updated_at = ${now}
        WHERE id = ${input.id} AND revision = ${existing.revision}
        RETURNING id
      `;
      if (updated.length === 0) {
        return yield* Effect.fail(
          new HubCollaborationStoreConflictError({
            resourceId: input.id,
            expectedRevision: input.expectedRevision,
            actualRevision: existing.revision,
          }),
        );
      }
    } else {
      yield* sql`
        INSERT INTO hub_team_presets (
          id, name, purpose, expert_ids_json, coordinator_instructions,
          collaboration_preferences, revision, created_at, updated_at, archived_at
        ) VALUES (
          ${input.id}, ${input.name}, ${input.purpose}, ${jsonValue(input.expertIds)},
          ${input.coordinatorInstructions ?? null}, ${input.collaborationPreferences ?? null},
          ${revision}, ${createdAt}, ${now}, NULL
        )
      `;
    }

    yield* sql`
      INSERT INTO hub_team_preset_revisions (
        preset_id, revision, request_id, payload_digest, operation, name, purpose,
        expert_ids_json, coordinator_instructions, collaboration_preferences,
        archived_at, created_at, updated_at
      ) VALUES (
        ${input.id}, ${revision}, ${input.requestId}, ${payloadDigest}, 'save',
        ${input.name}, ${input.purpose}, ${jsonValue(input.expertIds)},
        ${input.coordinatorInstructions ?? null}, ${input.collaborationPreferences ?? null},
        ${archivedAt}, ${createdAt}, ${now}
      )
    `;
    yield* insertReceipt(sql, {
      operationScope: "team-save",
      aggregateId: input.id,
      requestId: input.requestId,
      payloadDigest,
      result,
      createdAt: now,
    });
    return result;
  });

const setTeamArchivedTransaction = (sql: SqlClient.SqlClient, input: HubTeamArchiveInput) =>
  Effect.gen(function* () {
    const payloadDigest = digest({
      id: input.id,
      expectedRevision: input.expectedRevision,
      archived: input.archived,
    });
    const replay = yield* replayReceipt({
      sql,
      operationScope: "team-archive",
      aggregateId: input.id,
      requestId: input.requestId,
      payloadDigest,
      schema: HubTeamPresetSchema,
      operation: "team preset archive receipt",
    });
    if (replay) return replay;

    const rows = yield* currentTeamSql(sql, input.id);
    const existing = rows[0];
    if (!existing)
      return yield* Effect.fail(new HubCollaborationStoreNotFoundError({ resourceId: input.id }));
    if (existing.revision !== input.expectedRevision) {
      return yield* Effect.fail(
        new HubCollaborationStoreConflictError({
          resourceId: input.id,
          expectedRevision: input.expectedRevision,
          actualRevision: existing.revision,
        }),
      );
    }

    const now = new Date().toISOString();
    const archivedAt = input.archived ? (existing.archivedAt ?? now) : null;
    const changed = archivedAt !== existing.archivedAt;
    const revision = changed ? existing.revision + 1 : existing.revision;
    const updatedAt = changed ? now : existing.updatedAt;
    if (changed) {
      const updated = yield* sql<{ readonly id: string }>`
        UPDATE hub_team_presets
        SET revision = ${revision}, archived_at = ${archivedAt}, updated_at = ${updatedAt}
        WHERE id = ${input.id} AND revision = ${existing.revision}
        RETURNING id
      `;
      if (updated.length === 0) {
        return yield* Effect.fail(
          new HubCollaborationStoreConflictError({
            resourceId: input.id,
            expectedRevision: input.expectedRevision,
            actualRevision: existing.revision,
          }),
        );
      }
      yield* sql`
        INSERT INTO hub_team_preset_revisions (
          preset_id, revision, request_id, payload_digest, operation, name, purpose,
          expert_ids_json, coordinator_instructions, collaboration_preferences,
          archived_at, created_at, updated_at
        ) VALUES (
          ${input.id}, ${revision}, ${input.requestId}, ${payloadDigest},
          ${input.archived ? "archive" : "restore"}, ${existing.name}, ${existing.purpose},
          ${existing.expertIdsJson}, ${existing.coordinatorInstructions},
          ${existing.collaborationPreferences}, ${archivedAt}, ${existing.createdAt}, ${updatedAt}
        )
      `;
    }
    const result = yield* rowToTeam(
      {
        ...existing,
        revision,
        updatedAt,
        archivedAt,
      },
      "team preset archive result",
    );
    yield* insertReceipt(sql, {
      operationScope: "team-archive",
      aggregateId: input.id,
      requestId: input.requestId,
      payloadDigest,
      result,
      createdAt: now,
    });
    return result;
  });

const saveHubSettingsTransaction = (
  sql: SqlClient.SqlClient,
  input: HubCollaborationConfigSaveInput,
) =>
  Effect.gen(function* () {
    const normalized = yield* normalizeHubSave(input);
    const payloadDigest = digest({
      hubId: normalized.hubId,
      expectedRevision: normalized.expectedRevision,
      settings: normalized.settings,
    });
    const replay = yield* replayReceipt({
      sql,
      operationScope: "hub-settings-save",
      aggregateId: normalized.hubId,
      requestId: normalized.requestId,
      payloadDigest,
      schema: CONFIG_SNAPSHOT_SCHEMA,
      operation: "Hub settings save receipt",
    });
    if (replay) return replay;

    const rows = yield* sql<{
      readonly revision: number;
      readonly createdAt: string;
    }>`
      SELECT
        config.revision,
        (
          SELECT revision.created_at
          FROM hub_collaboration_config_revisions AS revision
          WHERE revision.hub_id = config.hub_id
          ORDER BY revision.revision ASC
          LIMIT 1
        ) AS "createdAt"
      FROM hub_collaboration_configs AS config
      WHERE config.hub_id = ${normalized.hubId}
    `;
    const existing = rows[0];
    const actualRevision = existing?.revision ?? null;
    if (actualRevision !== normalized.expectedRevision) {
      return yield* Effect.fail(
        new HubCollaborationStoreConflictError({
          resourceId: normalized.hubId,
          expectedRevision: normalized.expectedRevision,
          actualRevision,
        }),
      );
    }

    // Read from the authoritative current roster inside this ambient transaction.
    const expertIds = (yield* readParticipantIds(sql, normalized.hubId)).map(
      ({ expertId }) => expertId,
    );
    const now = new Date().toISOString();
    const revision = (actualRevision ?? 0) + 1;
    const settingsJson = jsonValue(normalized.settings);
    const expertIdsJson = jsonValue(expertIds);
    if (existing) {
      const updated = yield* sql<{ readonly hubId: string }>`
        UPDATE hub_collaboration_configs
        SET revision = ${revision}, settings_json = ${settingsJson}, updated_at = ${now}
        WHERE hub_id = ${normalized.hubId} AND revision = ${existing.revision}
        RETURNING hub_id AS "hubId"
      `;
      if (updated.length === 0) {
        return yield* Effect.fail(
          new HubCollaborationStoreConflictError({
            resourceId: normalized.hubId,
            expectedRevision: normalized.expectedRevision,
            actualRevision: existing.revision,
          }),
        );
      }
    } else {
      const inserted = yield* sql<{ readonly hubId: string }>`
        INSERT INTO hub_collaboration_configs (hub_id, revision, settings_json, updated_at)
        VALUES (${normalized.hubId}, ${revision}, ${settingsJson}, ${now})
        ON CONFLICT (hub_id) DO NOTHING
        RETURNING hub_id AS "hubId"
      `;
      if (inserted.length === 0) {
        return yield* Effect.fail(
          new HubCollaborationStoreConflictError({
            resourceId: normalized.hubId,
            expectedRevision: normalized.expectedRevision,
            actualRevision: 1,
          }),
        );
      }
    }

    const createdAt = existing?.createdAt ?? now;
    yield* sql`
      INSERT INTO hub_collaboration_config_revisions (
        hub_id, revision, settings_json, expert_ids_json,
        request_id, payload_digest, created_at
      ) VALUES (
        ${normalized.hubId}, ${revision}, ${settingsJson}, ${expertIdsJson},
        ${normalized.requestId}, ${payloadDigest}, ${now}
      )
    `;
    const result = {
      hubId: normalized.hubId,
      revision,
      settings: normalized.settings,
      expertIds,
      createdAt,
      updatedAt: now,
    } satisfies HubCollaborationConfigSnapshot;
    yield* insertReceipt(sql, {
      operationScope: "hub-settings-save",
      aggregateId: normalized.hubId,
      requestId: normalized.requestId,
      payloadDigest,
      result,
      createdAt: now,
    });
    return result;
  });

export const makeHubCollaborationConfigStore = (
  sql: SqlClient.SqlClient,
): HubCollaborationConfigStore => {
  const listTeams: HubCollaborationConfigStore["listTeams"] = (input) =>
    Effect.gen(function* () {
      const includeArchived = input?.includeArchived ?? true;
      const rows = includeArchived
        ? yield* sql<TeamRow>`
            SELECT
              id,
              name,
              purpose,
              expert_ids_json AS "expertIdsJson",
              coordinator_instructions AS "coordinatorInstructions",
              collaboration_preferences AS "collaborationPreferences",
              revision,
              created_at AS "createdAt",
              updated_at AS "updatedAt",
              archived_at AS "archivedAt"
            FROM hub_team_presets
            ORDER BY name COLLATE NOCASE, id
          `
        : yield* sql<TeamRow>`
            SELECT
              id,
              name,
              purpose,
              expert_ids_json AS "expertIdsJson",
              coordinator_instructions AS "coordinatorInstructions",
              collaboration_preferences AS "collaborationPreferences",
              revision,
              created_at AS "createdAt",
              updated_at AS "updatedAt",
              archived_at AS "archivedAt"
            FROM hub_team_presets
            WHERE archived_at IS NULL
            ORDER BY name COLLATE NOCASE, id
          `;
      const teams: HubTeamPreset[] = [];
      for (const row of rows) teams.push(yield* rowToTeam(row, "team preset list"));
      return teams;
    }).pipe(mapFailure("list team presets"));

  const readTeam: HubCollaborationConfigStore["readTeam"] = (rawInput) =>
    Effect.gen(function* () {
      const input = yield* normalizeTeamRead(rawInput);
      if (input.revision !== undefined) {
        const rows = yield* sql<TeamRevisionRow>`
          SELECT
            preset_id AS id,
            revision,
            request_id AS "requestId",
            payload_digest AS "payloadDigest",
            operation,
            name,
            purpose,
            expert_ids_json AS "expertIdsJson",
            coordinator_instructions AS "coordinatorInstructions",
            collaboration_preferences AS "collaborationPreferences",
            archived_at AS "archivedAt",
            created_at AS "createdAt",
            updated_at AS "updatedAt"
          FROM hub_team_preset_revisions
          WHERE preset_id = ${input.id} AND revision = ${input.revision}
        `;
        const row = rows[0];
        return row ? yield* rowToTeam(row, "team preset revision read") : null;
      }
      const rows = yield* currentTeamSql(sql, input.id);
      return rows[0] ? yield* rowToTeam(rows[0], "team preset read") : null;
    }).pipe(mapFailure("read team preset"));

  const saveTeam: HubCollaborationConfigStore["saveTeam"] = (rawInput) =>
    Effect.gen(function* () {
      const input = yield* normalizeTeamSave(rawInput);
      return yield* sql.withTransaction(saveTeamTransaction(sql, input));
    }).pipe(mapFailure("save team preset"));

  const setTeamArchived: HubCollaborationConfigStore["setTeamArchived"] = (rawInput) =>
    Effect.gen(function* () {
      const input = yield* normalizeTeamArchive(rawInput);
      return yield* sql.withTransaction(setTeamArchivedTransaction(sql, input));
    }).pipe(mapFailure("archive team preset"));

  const readHubSettings: HubCollaborationConfigStore["readHubSettings"] = (input) =>
    Effect.gen(function* () {
      const hubId = yield* normalizeReadHubId(input.hubId, "Hub settings read");
      const rows = yield* readConfigSql(sql, hubId);
      const row = rows[0];
      return row ? yield* rowToConfig(row, "Hub settings read") : null;
    }).pipe(mapFailure("read Hub settings"));

  const readHubSettingsHistory: HubCollaborationConfigStore["readHubSettingsHistory"] = (input) =>
    Effect.gen(function* () {
      const hubId = yield* normalizeReadHubId(input.hubId, "Hub settings history");
      const rows = yield* readConfigHistoryRows(sql, hubId);
      const revisions: HubCollaborationConfigRevision[] = [];
      for (const row of rows) revisions.push(yield* rowToConfigRevision(row));
      return revisions;
    }).pipe(mapFailure("read Hub settings history"));

  const saveHubSettingsInTransaction: HubCollaborationConfigStore["saveHubSettingsInTransaction"] =
    (input) =>
      saveHubSettingsTransaction(sql, input).pipe(mapFailure("save Hub settings in transaction"));

  const saveHubSettings: HubCollaborationConfigStore["saveHubSettings"] = (input) =>
    sql.withTransaction(saveHubSettingsInTransaction(input)).pipe(mapFailure("save Hub settings"));

  return {
    listTeams,
    readTeam,
    saveTeam,
    setTeamArchived,
    readHubSettings,
    readHubSettingsHistory,
    saveHubSettings,
    saveHubSettingsInTransaction,
  };
};
