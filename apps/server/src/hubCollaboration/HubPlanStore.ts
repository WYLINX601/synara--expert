import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlError from "effect/unstable/sql/SqlError";

import {
  HubDeliverableReferenceMetadata as HubDeliverableReferenceMetadataSchema,
  HubCollaborationSettings as HubCollaborationSettingsSchema,
  HubPlanDefinitionSchema,
  HubPlanInputRequestSchema,
  ModelSelection,
  ProviderInteractionMode,
  RuntimeMode,
  type HubCollaborationSettings,
  type HubDeliverableReferenceMetadata,
  type HubPlanDefinition,
  type HubPlanInputRequest,
} from "@synara/contracts";

import type {
  HubPlanCandidateFact,
  HubPlanControlState,
  HubPlanReleaseFact,
  HubPlanReviewFact,
} from "./planGraph.ts";

const nonEmptyText = Schema.String.check(Schema.makeFilter((value) => value.trim().length > 0));
const nonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const positiveInt = Schema.Int.check(Schema.isGreaterThan(0));
const controlStateSchema = Schema.Literals([
  "draft",
  "active",
  "pausing",
  "paused",
  "cancelling",
  "cancelled",
  "completed",
]);
const nodeRoleSchema = Schema.Literals(["author", "reviewer", "worker"]);

export interface HubPlanExpertSnapshot {
  readonly expertId: string;
  readonly snapshotId: string;
  readonly revision: number;
}

export interface HubPlanConfigSnapshot {
  readonly configRevision: number;
  readonly settings?: HubCollaborationSettings | undefined;
  readonly expertIds: readonly string[];
  readonly expertSnapshots?: readonly HubPlanExpertSnapshot[] | undefined;
}

/** The durable Hub plan state. The task graph itself remains in native task tables. */
export interface PlanRecord {
  readonly id: string;
  readonly hubId: string;
  readonly goalId: string | null;
  readonly revision: number;
  readonly stateVersion: number;
  readonly controlState: HubPlanControlState;
  readonly definition: HubPlanDefinition;
  readonly configSnapshot: HubPlanConfigSnapshot;
  readonly stageGenerations: Readonly<Record<string, number>>;
  readonly sourceMessageIds?: readonly string[] | undefined;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface HubPlanNodeBinding {
  readonly planId: string;
  readonly revision: number;
  readonly nodeKey: string;
  readonly taskId: string;
  readonly stageKey: string;
  readonly role: "author" | "reviewer" | "worker";
}

export type HubPlanCandidateRecord = HubPlanCandidateFact & {
  readonly planId: string;
  readonly id: string;
  readonly revision: number;
  readonly createdAt: string;
  readonly deliverableRefs: readonly HubDeliverableReferenceMetadata[];
};

export type HubPlanReviewRecord = HubPlanReviewFact & {
  readonly planId: string;
  readonly id: string;
  readonly revision: number;
  readonly summary: string;
  readonly createdAt: string;
};

export type HubPlanReleaseRecord = HubPlanReleaseFact & {
  readonly planId: string;
  readonly id: string;
  readonly revision: number;
  readonly comment?: string | undefined;
  readonly createdAt: string;
};

export interface HubPlanAttemptBinding {
  readonly id: string;
  readonly planId: string;
  readonly revision: number;
  readonly nodeKey: string;
  readonly taskId: string;
  readonly attemptId: string;
  readonly workItemId: string;
  readonly stageGeneration: number;
  readonly createdAt: string;
}

export type HubPlanInputRequestRecord = HubPlanInputRequest & {
  readonly planId: string;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** Server-derived replay identity for the answer continuation. */
  readonly responseCreatedAt?: string | undefined;
  readonly responseCommandId?: string | undefined;
  readonly responseMessageId?: string | undefined;
  readonly responseMessageDigest?: string | undefined;
  /** Exact thread settings bound before the first dispatch attempt. */
  readonly responseRuntimeMode?: typeof RuntimeMode.Type | undefined;
  readonly responseInteractionMode?: typeof ProviderInteractionMode.Type | undefined;
  readonly responseModelSelection?: typeof ModelSelection.Type | undefined;
};

export interface HubPlanEvent {
  readonly sequence: number;
  readonly planId: string;
  readonly hubId: string;
  readonly kind: string;
  readonly payload: unknown;
  readonly createdAt: string;
}

export interface HubPlanReceipt {
  readonly hubId: string;
  readonly requestId: string;
  readonly digest: string;
  readonly resultJson: string;
}

export interface HubPlanOutboxItem {
  readonly id: string;
  readonly planId: string;
  readonly kind: string;
  readonly payload: unknown;
  readonly status: "pending" | "delivered";
  readonly createdAt: string;
}

export class HubPlanStoreValidationError extends Schema.TaggedErrorClass<HubPlanStoreValidationError>()(
  "HubPlanStoreValidationError",
  { operation: Schema.String, detail: Schema.String },
) {
  override get message(): string {
    return `Invalid Hub plan ${this.operation} input: ${this.detail}`;
  }
}

export class HubPlanStoreConflictError extends Schema.TaggedErrorClass<HubPlanStoreConflictError>()(
  "HubPlanStoreConflictError",
  {
    resourceId: Schema.String,
    expectedStateVersion: Schema.NullOr(Schema.Number),
    actualStateVersion: Schema.NullOr(Schema.Number),
  },
) {
  override get message(): string {
    return `Hub plan ${this.resourceId} changed (expected state version ${this.expectedStateVersion ?? "none"}, current state version ${this.actualStateVersion ?? "none"}).`;
  }
}

export class HubPlanStoreIdempotencyError extends Schema.TaggedErrorClass<HubPlanStoreIdempotencyError>()(
  "HubPlanStoreIdempotencyError",
  { resourceId: Schema.String },
) {
  override get message(): string {
    return `Hub plan resource ${this.resourceId} was already stored with different content.`;
  }
}

export class HubPlanStoreInvariantError extends Schema.TaggedErrorClass<HubPlanStoreInvariantError>()(
  "HubPlanStoreInvariantError",
  { resourceId: Schema.String, detail: Schema.String },
) {
  override get message(): string {
    return `Hub plan invariant failed for ${this.resourceId}: ${this.detail}`;
  }
}

export class HubPlanStoreDecodeError extends Schema.TaggedErrorClass<HubPlanStoreDecodeError>()(
  "HubPlanStoreDecodeError",
  { operation: Schema.String, detail: Schema.String },
) {
  override get message(): string {
    return `Could not read Hub plan data during ${this.operation}: ${this.detail}`;
  }
}

export class HubPlanStoreSqlError extends Schema.TaggedErrorClass<HubPlanStoreSqlError>()(
  "HubPlanStoreSqlError",
  { operation: Schema.String, detail: Schema.String },
) {
  override get message(): string {
    return `Hub plan storage failed during ${this.operation}: ${this.detail}`;
  }
}

export type HubPlanStoreError =
  | HubPlanStoreValidationError
  | HubPlanStoreConflictError
  | HubPlanStoreIdempotencyError
  | HubPlanStoreInvariantError
  | HubPlanStoreDecodeError
  | HubPlanStoreSqlError;

const PlanConfigSnapshotSchema = Schema.Struct({
  configRevision: nonNegativeInt,
  settings: Schema.optional(HubCollaborationSettingsSchema),
  expertIds: Schema.Array(nonEmptyText),
  expertSnapshots: Schema.optional(
    Schema.Array(
      Schema.Struct({
        expertId: nonEmptyText,
        snapshotId: nonEmptyText,
        revision: positiveInt,
      }),
    ),
  ),
}).annotate({ parseOptions: { onExcessProperty: "error" } });

const PlanRecordSchema = Schema.Struct({
  id: nonEmptyText,
  hubId: nonEmptyText,
  goalId: Schema.NullOr(nonEmptyText),
  revision: positiveInt,
  stateVersion: nonNegativeInt,
  controlState: controlStateSchema,
  definition: HubPlanDefinitionSchema,
  configSnapshot: PlanConfigSnapshotSchema,
  stageGenerations: Schema.Record(Schema.String, nonNegativeInt),
  sourceMessageIds: Schema.optional(Schema.Array(nonEmptyText)),
  createdAt: nonEmptyText,
  updatedAt: nonEmptyText,
}).annotate({ parseOptions: { onExcessProperty: "error" } });

const NodeBindingSchema = Schema.Struct({
  planId: nonEmptyText,
  revision: positiveInt,
  nodeKey: nonEmptyText,
  taskId: nonEmptyText,
  stageKey: nonEmptyText,
  role: nodeRoleSchema,
}).annotate({ parseOptions: { onExcessProperty: "error" } });

const AttemptBindingSchema = Schema.Struct({
  id: nonEmptyText,
  planId: nonEmptyText,
  revision: positiveInt,
  nodeKey: nonEmptyText,
  taskId: nonEmptyText,
  attemptId: nonEmptyText,
  workItemId: nonEmptyText,
  stageGeneration: nonNegativeInt,
  createdAt: nonEmptyText,
}).annotate({ parseOptions: { onExcessProperty: "error" } });

const InputRequestRecordSchema = Schema.Struct({
  ...HubPlanInputRequestSchema.fields,
  planId: nonEmptyText,
  revision: positiveInt,
  createdAt: nonEmptyText,
  updatedAt: nonEmptyText,
  responseCreatedAt: Schema.optional(nonEmptyText),
  responseCommandId: Schema.optional(nonEmptyText),
  responseMessageId: Schema.optional(nonEmptyText),
  responseMessageDigest: Schema.optional(Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))),
  responseRuntimeMode: Schema.optional(RuntimeMode),
  responseInteractionMode: Schema.optional(ProviderInteractionMode),
  responseModelSelection: Schema.optional(ModelSelection),
}).annotate({ parseOptions: { onExcessProperty: "error" } });

const CandidateSchema = Schema.Struct({
  planId: nonEmptyText,
  id: nonEmptyText,
  revision: positiveInt,
  stageKey: nonEmptyText,
  generation: nonNegativeInt,
  candidateId: nonEmptyText,
  outputDigest: nonEmptyText,
  authorNodeKey: nonEmptyText,
  authorAttemptId: nonEmptyText,
  summary: Schema.NullOr(Schema.String),
  status: Schema.Literals(["draft", "current", "superseded"]),
  createdAt: nonEmptyText,
  deliverableRefs: Schema.Array(HubDeliverableReferenceMetadataSchema).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(3),
  ),
}).annotate({ parseOptions: { onExcessProperty: "error" } });

const ReviewSchema = Schema.Struct({
  planId: nonEmptyText,
  id: nonEmptyText,
  revision: positiveInt,
  stageKey: nonEmptyText,
  generation: nonNegativeInt,
  candidateId: nonEmptyText,
  outputDigest: nonEmptyText,
  reviewerNodeKey: nonEmptyText,
  attemptId: nonEmptyText,
  outcome: Schema.Literals(["pass", "changes_requested", "blocked"]),
  status: Schema.Literals(["draft", "submitted"]),
  summary: Schema.String,
  createdAt: nonEmptyText,
}).annotate({ parseOptions: { onExcessProperty: "error" } });

const ReleaseSchema = Schema.Struct({
  planId: nonEmptyText,
  id: nonEmptyText,
  revision: positiveInt,
  stageKey: nonEmptyText,
  generation: nonNegativeInt,
  candidateId: nonEmptyText,
  outputDigest: nonEmptyText,
  source: Schema.Literals(["auto", "user"]),
  effective: Schema.Boolean,
  comment: Schema.optional(Schema.String),
  createdAt: nonEmptyText,
}).annotate({ parseOptions: { onExcessProperty: "error" } });

const ReceiptSchema = Schema.Struct({
  hubId: nonEmptyText,
  requestId: nonEmptyText,
  digest: nonEmptyText,
  resultJson: Schema.String,
}).annotate({ parseOptions: { onExcessProperty: "error" } });

const OutboxSchema = Schema.Struct({
  id: nonEmptyText,
  planId: nonEmptyText,
  kind: nonEmptyText,
  payload: Schema.Unknown,
  status: Schema.Literals(["pending", "delivered"]),
  createdAt: nonEmptyText,
}).annotate({ parseOptions: { onExcessProperty: "error" } });

const errorDetail = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

const validationError = (operation: string, cause: unknown) =>
  new HubPlanStoreValidationError({ operation, detail: errorDetail(cause) });

const decodeInput = <A>(schema: Schema.Decoder<A>, value: unknown, operation: string) =>
  Effect.try({
    try: () => Schema.decodeUnknownSync(schema)(value),
    catch: (cause) => validationError(operation, cause),
  });

const decodeStored = <A>(schema: Schema.Decoder<A>, value: unknown, operation: string) =>
  Effect.try({
    try: () => Schema.decodeUnknownSync(schema)(value),
    catch: (cause) => new HubPlanStoreDecodeError({ operation, detail: errorDetail(cause) }),
  });

const decodeJson = (value: string, operation: string) =>
  Effect.try({
    try: () => JSON.parse(value) as unknown,
    catch: (cause) => new HubPlanStoreDecodeError({ operation, detail: errorDetail(cause) }),
  });

const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, child]) => child !== undefined)
        .toSorted(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalize(child)]),
    );
  }
  return value;
};

const canonicalJson = (value: unknown): string => {
  const json = JSON.stringify(canonicalize(value));
  if (json === undefined) throw new Error("value is not JSON serializable");
  return json;
};

const encodeJson = (value: unknown, operation: string) =>
  Effect.try({
    try: () => canonicalJson(value),
    catch: (cause) => validationError(operation, cause),
  });

const sameJson = (left: unknown, right: unknown): boolean =>
  canonicalJson(left) === canonicalJson(right);

const decodeRecordJson = <A>(schema: Schema.Decoder<A>, value: string, operation: string) =>
  Effect.gen(function* () {
    const json = yield* decodeJson(value, operation);
    return yield* decodeStored(schema, json, operation);
  });

const mapSqlError = (operation: string) => (cause: unknown) =>
  new HubPlanStoreSqlError({ operation, detail: errorDetail(cause) });

const isStoreError = (cause: unknown): cause is HubPlanStoreError =>
  cause instanceof HubPlanStoreValidationError ||
  cause instanceof HubPlanStoreConflictError ||
  cause instanceof HubPlanStoreIdempotencyError ||
  cause instanceof HubPlanStoreInvariantError ||
  cause instanceof HubPlanStoreDecodeError ||
  cause instanceof HubPlanStoreSqlError;

const mapTransactionError = (operation: string, cause: unknown): HubPlanStoreError | unknown => {
  if (isStoreError(cause)) return cause;
  if (cause instanceof SqlError.SqlError) return mapSqlError(operation)(cause);
  return cause;
};

const planSnapshot = (record: PlanRecord) => ({
  definition: record.definition,
  configSnapshot: record.configSnapshot,
  ...(record.sourceMessageIds === undefined ? {} : { sourceMessageIds: record.sourceMessageIds }),
});

const planSnapshotWithoutExpertSnapshots = (record: PlanRecord) => {
  const { expertSnapshots: _expertSnapshots, ...configSnapshot } = record.configSnapshot;
  return {
    definition: record.definition,
    configSnapshot,
    ...(record.sourceMessageIds === undefined ? {} : { sourceMessageIds: record.sourceMessageIds }),
  };
};

const isExpertSnapshotFreeze = (current: PlanRecord, next: PlanRecord): boolean =>
  current.controlState === "draft" &&
  next.controlState === "active" &&
  current.goalId === null &&
  next.goalId !== null &&
  current.revision === next.revision &&
  current.configSnapshot.expertSnapshots === undefined &&
  next.configSnapshot.expertSnapshots !== undefined &&
  sameJson(planSnapshotWithoutExpertSnapshots(current), planSnapshotWithoutExpertSnapshots(next)) &&
  sameJson(
    [...current.configSnapshot.expertIds].toSorted(),
    next.configSnapshot.expertSnapshots.map(({ expertId }) => expertId).toSorted(),
  );

const sameCandidateSubmission = (
  left: HubPlanCandidateRecord,
  right: HubPlanCandidateRecord,
): boolean =>
  left.revision === right.revision &&
  left.stageKey === right.stageKey &&
  left.generation === right.generation &&
  left.authorNodeKey === right.authorNodeKey &&
  left.authorAttemptId === right.authorAttemptId &&
  left.outputDigest === right.outputDigest &&
  left.summary === right.summary;

const sameReviewSubmission = (left: HubPlanReviewRecord, right: HubPlanReviewRecord): boolean =>
  left.revision === right.revision &&
  left.candidateId === right.candidateId &&
  left.reviewerNodeKey === right.reviewerNodeKey &&
  left.attemptId === right.attemptId &&
  left.generation === right.generation &&
  left.outputDigest === right.outputDigest &&
  left.outcome === right.outcome &&
  left.summary === right.summary;

interface PlanRow {
  readonly planId: string;
  readonly hubId: string;
  readonly goalId: string | null;
  readonly revision: number;
  readonly stateVersion: number;
  readonly controlState: string;
  readonly definitionJson: string;
  readonly configSnapshotJson: string;
  readonly stageGenerationsJson: string;
  readonly sourceMessageIdsJson: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

const planFromRow = (row: PlanRow) =>
  Effect.gen(function* () {
    const definitionJson = yield* decodeJson(row.definitionJson, "readPlan.definition");
    const definition = yield* decodeStored(
      HubPlanDefinitionSchema,
      definitionJson,
      "readPlan.definition",
    );
    const configJson = yield* decodeJson(row.configSnapshotJson, "readPlan.configSnapshot");
    const configSnapshot = yield* decodeStored(
      PlanConfigSnapshotSchema,
      configJson,
      "readPlan.configSnapshot",
    );
    const stageGenerationsJson = yield* decodeJson(
      row.stageGenerationsJson,
      "readPlan.stageGenerations",
    );
    const stageGenerations = yield* decodeStored(
      Schema.Record(Schema.String, nonNegativeInt),
      stageGenerationsJson,
      "readPlan.stageGenerations",
    );
    const sourceMessageIdsJson = yield* decodeJson(
      row.sourceMessageIdsJson,
      "readPlan.sourceMessageIds",
    );
    const sourceMessageIds = yield* decodeStored(
      Schema.NullOr(Schema.Array(nonEmptyText)),
      sourceMessageIdsJson,
      "readPlan.sourceMessageIds",
    );
    return yield* decodeStored(
      PlanRecordSchema,
      {
        id: row.planId,
        hubId: row.hubId,
        goalId: row.goalId,
        revision: row.revision,
        stateVersion: row.stateVersion,
        controlState: row.controlState,
        definition,
        configSnapshot,
        stageGenerations,
        ...(sourceMessageIds === null ? {} : { sourceMessageIds }),
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      },
      "readPlan",
    );
  });

const eventFromRow = (row: {
  readonly sequence: number;
  readonly planId: string;
  readonly hubId: string;
  readonly kind: string;
  readonly payloadJson: string;
  readonly createdAt: string;
}) =>
  Effect.gen(function* () {
    const payload = yield* decodeJson(row.payloadJson, "readEvents.payload");
    return {
      sequence: row.sequence,
      planId: row.planId,
      hubId: row.hubId,
      kind: row.kind,
      payload,
      createdAt: row.createdAt,
    } satisfies HubPlanEvent;
  });

const outboxFromRow = (row: {
  readonly id: string;
  readonly planId: string;
  readonly kind: string;
  readonly payloadJson: string;
  readonly status: string;
  readonly createdAt: string;
}) =>
  Effect.gen(function* () {
    const payload = yield* decodeJson(row.payloadJson, "readOutbox.payload");
    return yield* decodeStored(
      OutboxSchema,
      {
        id: row.id,
        planId: row.planId,
        kind: row.kind,
        payload,
        status: row.status,
        createdAt: row.createdAt,
      },
      "readOutbox",
    );
  });

export interface HubPlanStore {
  readonly transaction: <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | HubPlanStoreError, R>;
  readonly read: (input: {
    readonly planId: string;
    readonly revision?: number;
  }) => Effect.Effect<PlanRecord | null, HubPlanStoreError>;
  readonly list: (input: {
    readonly hubId: string;
  }) => Effect.Effect<readonly PlanRecord[], HubPlanStoreError>;
  readonly savePlan: (
    record: PlanRecord,
    expectedStateVersion: number | null,
  ) => Effect.Effect<PlanRecord, HubPlanStoreError>;
  readonly saveBindings: (
    bindings: readonly HubPlanNodeBinding[],
  ) => Effect.Effect<readonly HubPlanNodeBinding[], HubPlanStoreError>;
  readonly listBindings: (input: {
    readonly planId: string;
    readonly revision?: number;
  }) => Effect.Effect<readonly HubPlanNodeBinding[], HubPlanStoreError>;
  readonly appendAttemptBinding: (
    binding: HubPlanAttemptBinding,
  ) => Effect.Effect<HubPlanAttemptBinding, HubPlanStoreError>;
  readonly listAttemptBindings: (input: {
    readonly planId: string;
  }) => Effect.Effect<readonly HubPlanAttemptBinding[], HubPlanStoreError>;
  readonly findAttemptBindingByWork: (input: {
    readonly workItemId: string;
  }) => Effect.Effect<HubPlanAttemptBinding | null, HubPlanStoreError>;
  readonly findAttemptBindingByThread: (input: {
    readonly threadId: string;
  }) => Effect.Effect<HubPlanAttemptBinding | null, HubPlanStoreError>;
  readonly saveInputRequest: (
    request: HubPlanInputRequestRecord,
  ) => Effect.Effect<HubPlanInputRequestRecord, HubPlanStoreError>;
  readonly readInputRequest: (input: {
    readonly planId: string;
    readonly requestId: string;
  }) => Effect.Effect<HubPlanInputRequestRecord | null, HubPlanStoreError>;
  readonly listInputRequests: (input: {
    readonly planId: string;
    readonly revision?: number;
  }) => Effect.Effect<readonly HubPlanInputRequestRecord[], HubPlanStoreError>;
  readonly appendCandidate: (
    record: HubPlanCandidateRecord,
  ) => Effect.Effect<HubPlanCandidateRecord, HubPlanStoreError>;
  readonly listCandidates: (input: {
    readonly planId: string;
  }) => Effect.Effect<readonly HubPlanCandidateRecord[], HubPlanStoreError>;
  readonly appendReview: (
    record: HubPlanReviewRecord,
  ) => Effect.Effect<HubPlanReviewRecord, HubPlanStoreError>;
  readonly listReviews: (input: {
    readonly planId: string;
  }) => Effect.Effect<readonly HubPlanReviewRecord[], HubPlanStoreError>;
  readonly appendRelease: (
    record: HubPlanReleaseRecord,
  ) => Effect.Effect<HubPlanReleaseRecord, HubPlanStoreError>;
  readonly listReleases: (input: {
    readonly planId: string;
  }) => Effect.Effect<readonly HubPlanReleaseRecord[], HubPlanStoreError>;
  readonly appendEvent: (
    event: Omit<HubPlanEvent, "sequence">,
  ) => Effect.Effect<HubPlanEvent, HubPlanStoreError>;
  readonly readEvents: (input?: {
    readonly afterSequence?: number;
    readonly planId?: string;
    readonly hubId?: string;
    readonly limit?: number;
  }) => Effect.Effect<readonly HubPlanEvent[], HubPlanStoreError>;
  readonly readLatestEventSequence: (input: {
    readonly hubId: string;
    readonly planId?: string;
  }) => Effect.Effect<number, HubPlanStoreError>;
  readonly readReceipt: (input: {
    readonly hubId: string;
    readonly requestId: string;
  }) => Effect.Effect<HubPlanReceipt | null, HubPlanStoreError>;
  readonly writeReceipt: (
    receipt: HubPlanReceipt,
  ) => Effect.Effect<HubPlanReceipt, HubPlanStoreError>;
  readonly enqueue: (
    item: Omit<HubPlanOutboxItem, "status">,
  ) => Effect.Effect<HubPlanOutboxItem, HubPlanStoreError>;
  readonly readPending: (input?: {
    readonly planId?: string;
    readonly limit?: number;
  }) => Effect.Effect<readonly HubPlanOutboxItem[], HubPlanStoreError>;
  readonly markDelivered: (input: {
    readonly id: string;
  }) => Effect.Effect<HubPlanOutboxItem | null, HubPlanStoreError>;
}

export const makeHubPlanStore = (sql: SqlClient.SqlClient): HubPlanStore => {
  const transaction = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    sql
      .withTransaction(effect)
      .pipe(
        Effect.mapError(
          (cause) => mapTransactionError("transaction", cause) as E | HubPlanStoreError,
        ),
      );

  const readCurrentRow = (planId: string) =>
    sql<PlanRow>`
      SELECT
        plan_id AS "planId",
        hub_id AS "hubId",
        goal_id AS "goalId",
        revision,
        state_version AS "stateVersion",
        control_state AS "controlState",
        definition_json AS "definitionJson",
        config_snapshot_json AS "configSnapshotJson",
        stage_generations_json AS "stageGenerationsJson",
        source_message_ids_json AS "sourceMessageIdsJson",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM hub_plans
      WHERE plan_id = ${planId}
    `.pipe(Effect.mapError(mapSqlError("readPlan")));

  const read = (input: { readonly planId: string; readonly revision?: number }) =>
    Effect.gen(function* () {
      const request = yield* decodeInput(
        Schema.Struct({ planId: nonEmptyText, revision: Schema.optional(positiveInt) }),
        input,
        "readPlan",
      );
      if (request.revision !== undefined) {
        const rows = yield* sql<{ readonly recordJson: string }>`
          SELECT record_json AS "recordJson"
          FROM hub_plan_revisions
          WHERE plan_id = ${request.planId} AND revision = ${request.revision}
        `.pipe(Effect.mapError(mapSqlError("readPlan.revision")));
        const row = rows[0];
        if (row === undefined) return null;
        return yield* decodeRecordJson(PlanRecordSchema, row.recordJson, "readPlan.revision");
      }
      const rows = yield* readCurrentRow(request.planId);
      const row = rows[0];
      return row === undefined ? null : yield* planFromRow(row);
    });

  const list = (input: { readonly hubId: string }) =>
    Effect.gen(function* () {
      const request = yield* decodeInput(
        Schema.Struct({ hubId: nonEmptyText }),
        input,
        "listPlans",
      );
      const rows = yield* sql<PlanRow>`
        SELECT
          plan_id AS "planId",
          hub_id AS "hubId",
          goal_id AS "goalId",
          revision,
          state_version AS "stateVersion",
          control_state AS "controlState",
          definition_json AS "definitionJson",
          config_snapshot_json AS "configSnapshotJson",
          stage_generations_json AS "stageGenerationsJson",
          source_message_ids_json AS "sourceMessageIdsJson",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM hub_plans
        WHERE hub_id = ${request.hubId}
        ORDER BY updated_at DESC, plan_id
      `.pipe(Effect.mapError(mapSqlError("listPlans")));
      return yield* Effect.forEach(rows, planFromRow, { concurrency: 1 });
    });

  const savePlan = (inputRecord: PlanRecord, expectedStateVersion: number | null) =>
    transaction(
      Effect.gen(function* () {
        const record = yield* decodeInput(PlanRecordSchema, inputRecord, "savePlan");
        const expected = yield* decodeInput(
          Schema.NullOr(nonNegativeInt),
          expectedStateVersion,
          "savePlan.expectedStateVersion",
        );
        const definitionJson = yield* encodeJson(record.definition, "savePlan.definition");
        const configSnapshotJson = yield* encodeJson(
          record.configSnapshot,
          "savePlan.configSnapshot",
        );
        const stageGenerationsJson = yield* encodeJson(
          record.stageGenerations,
          "savePlan.stageGenerations",
        );
        const sourceMessageIdsJson = yield* encodeJson(
          record.sourceMessageIds ?? null,
          "savePlan.sourceMessageIds",
        );
        const currentRows = yield* readCurrentRow(record.id);
        const currentRow = currentRows[0];
        if (currentRow === undefined) {
          if (expected !== null) {
            return yield* Effect.fail(
              new HubPlanStoreConflictError({
                resourceId: record.id,
                expectedStateVersion: expected,
                actualStateVersion: null,
              }),
            );
          }
          if (record.revision !== 1) {
            return yield* Effect.fail(
              new HubPlanStoreInvariantError({
                resourceId: record.id,
                detail: "a new plan must start at revision 1",
              }),
            );
          }
          yield* sql`
            INSERT INTO hub_plans (
              plan_id, hub_id, goal_id, revision, state_version, control_state,
              definition_json, config_snapshot_json, stage_generations_json,
              source_message_ids_json, created_at, updated_at
            ) VALUES (
              ${record.id}, ${record.hubId}, ${record.goalId}, ${record.revision},
              ${record.stateVersion}, ${record.controlState}, ${definitionJson},
              ${configSnapshotJson}, ${stageGenerationsJson}, ${sourceMessageIdsJson},
              ${record.createdAt}, ${record.updatedAt}
            )
          `.pipe(Effect.mapError(mapSqlError("savePlan.insert")));
          yield* sql`
            INSERT INTO hub_plan_revisions (plan_id, revision, record_json, created_at)
            VALUES (${record.id}, ${record.revision}, ${yield* encodeJson(record, "savePlan.record")}, ${record.createdAt})
          `.pipe(Effect.mapError(mapSqlError("savePlan.revision")));
          return record;
        }

        const current = yield* planFromRow(currentRow);
        if (sameJson(current, record)) return current;
        if (expected !== current.stateVersion) {
          return yield* Effect.fail(
            new HubPlanStoreConflictError({
              resourceId: record.id,
              expectedStateVersion: expected,
              actualStateVersion: current.stateVersion,
            }),
          );
        }
        if (record.hubId !== current.hubId || record.createdAt !== current.createdAt) {
          return yield* Effect.fail(
            new HubPlanStoreInvariantError({
              resourceId: record.id,
              detail: "hubId and createdAt are immutable",
            }),
          );
        }
        if (record.stateVersion !== current.stateVersion + 1) {
          return yield* Effect.fail(
            new HubPlanStoreInvariantError({
              resourceId: record.id,
              detail: "stateVersion must increase by exactly one",
            }),
          );
        }
        const snapshotChanged = !sameJson(planSnapshot(current), planSnapshot(record));
        const expertSnapshotFreeze = snapshotChanged && isExpertSnapshotFreeze(current, record);
        if (record.revision === current.revision && snapshotChanged && !expertSnapshotFreeze) {
          return yield* Effect.fail(
            new HubPlanStoreInvariantError({
              resourceId: record.id,
              detail:
                "definition, config, and source messages require a new immutable revision; only draft activation may freeze Expert snapshots",
            }),
          );
        }
        if (record.revision === current.revision + 1 && !snapshotChanged) {
          return yield* Effect.fail(
            new HubPlanStoreInvariantError({
              resourceId: record.id,
              detail: "a new revision must change definition, config, or source messages",
            }),
          );
        }
        if (record.revision !== current.revision && record.revision !== current.revision + 1) {
          return yield* Effect.fail(
            new HubPlanStoreInvariantError({
              resourceId: record.id,
              detail: "revision must remain unchanged or increase by exactly one",
            }),
          );
        }
        const rowsChanged = yield* sql<{ readonly stateVersion: number }>`
          UPDATE hub_plans SET
            goal_id = ${record.goalId},
            revision = ${record.revision},
            state_version = ${record.stateVersion},
            control_state = ${record.controlState},
            definition_json = ${definitionJson},
            config_snapshot_json = ${configSnapshotJson},
            stage_generations_json = ${stageGenerationsJson},
            source_message_ids_json = ${sourceMessageIdsJson},
            updated_at = ${record.updatedAt}
          WHERE plan_id = ${record.id} AND state_version = ${current.stateVersion}
          RETURNING state_version AS "stateVersion"
        `.pipe(Effect.mapError(mapSqlError("savePlan.update")));
        if (rowsChanged.length === 0) {
          const latestRows = yield* readCurrentRow(record.id);
          const latest = latestRows[0] === undefined ? null : yield* planFromRow(latestRows[0]);
          return yield* Effect.fail(
            new HubPlanStoreConflictError({
              resourceId: record.id,
              expectedStateVersion: expected,
              actualStateVersion: latest?.stateVersion ?? null,
            }),
          );
        }
        if (record.revision !== current.revision) {
          const recordJson = yield* encodeJson(record, "savePlan.record");
          yield* sql`
            INSERT INTO hub_plan_revisions (plan_id, revision, record_json, created_at)
            VALUES (${record.id}, ${record.revision}, ${recordJson}, ${record.updatedAt})
          `.pipe(Effect.mapError(mapSqlError("savePlan.revision")));
        } else if (expertSnapshotFreeze) {
          const recordJson = yield* encodeJson(record, "savePlan.freezeExpertSnapshots");
          const rowsUpdated = yield* sql<{ readonly revision: number }>`
            UPDATE hub_plan_revisions
            SET record_json = ${recordJson}, created_at = ${record.updatedAt}
            WHERE plan_id = ${record.id} AND revision = ${record.revision}
            RETURNING revision
          `.pipe(Effect.mapError(mapSqlError("savePlan.freezeExpertSnapshots")));
          if (rowsUpdated.length === 0) {
            return yield* Effect.fail(
              new HubPlanStoreInvariantError({
                resourceId: record.id,
                detail: "the draft revision snapshot is missing during Expert freeze",
              }),
            );
          }
        }
        return record;
      }),
    );

  const saveBindings = (inputBindings: readonly HubPlanNodeBinding[]) =>
    transaction(
      Effect.gen(function* () {
        const bindings = yield* decodeInput(
          Schema.Array(NodeBindingSchema),
          inputBindings,
          "saveBindings",
        );
        const uniqueNodes = new Set<string>();
        const uniqueTasks = new Set<string>();
        for (const binding of bindings) {
          const nodeKey = `${binding.planId}\u0000${binding.revision}\u0000${binding.nodeKey}`;
          const taskKey = `${binding.planId}\u0000${binding.revision}\u0000${binding.taskId}`;
          if (uniqueNodes.has(nodeKey) || uniqueTasks.has(taskKey)) {
            return yield* Effect.fail(
              new HubPlanStoreInvariantError({
                resourceId: binding.planId,
                detail: "binding batch contains a duplicate node or task",
              }),
            );
          }
          uniqueNodes.add(nodeKey);
          uniqueTasks.add(taskKey);
          const existingRows = yield* sql<HubPlanNodeBinding>`
            SELECT
              plan_id AS "planId",
              revision,
              node_key AS "nodeKey",
              task_id AS "taskId",
              stage_key AS "stageKey",
              role
            FROM hub_plan_node_bindings
            WHERE plan_id = ${binding.planId}
              AND revision = ${binding.revision}
              AND node_key = ${binding.nodeKey}
          `.pipe(Effect.mapError(mapSqlError("saveBindings.read")));
          const existing = existingRows[0];
          if (existing !== undefined) {
            if (!sameJson(existing, binding)) {
              return yield* Effect.fail(
                new HubPlanStoreIdempotencyError({
                  resourceId: `${binding.planId}:${binding.revision}:${binding.nodeKey}`,
                }),
              );
            }
            continue;
          }
          yield* sql`
            INSERT INTO hub_plan_node_bindings (
              plan_id, revision, node_key, task_id, stage_key, role
            ) VALUES (
              ${binding.planId}, ${binding.revision}, ${binding.nodeKey},
              ${binding.taskId}, ${binding.stageKey}, ${binding.role}
            )
          `.pipe(Effect.mapError(mapSqlError("saveBindings.insert")));
        }
        return bindings;
      }),
    );

  const listBindings = (input: { readonly planId: string; readonly revision?: number }) =>
    Effect.gen(function* () {
      const request = yield* decodeInput(
        Schema.Struct({ planId: nonEmptyText, revision: Schema.optional(positiveInt) }),
        input,
        "listBindings",
      );
      const rows =
        request.revision === undefined
          ? yield* sql<HubPlanNodeBinding>`
              SELECT
                plan_id AS "planId",
                revision,
                node_key AS "nodeKey",
                task_id AS "taskId",
                stage_key AS "stageKey",
                role
              FROM hub_plan_node_bindings
              WHERE plan_id = ${request.planId}
              ORDER BY revision, node_key
            `.pipe(Effect.mapError(mapSqlError("listBindings")))
          : yield* sql<HubPlanNodeBinding>`
              SELECT
                plan_id AS "planId",
                revision,
                node_key AS "nodeKey",
                task_id AS "taskId",
                stage_key AS "stageKey",
                role
              FROM hub_plan_node_bindings
              WHERE plan_id = ${request.planId} AND revision = ${request.revision}
              ORDER BY node_key
            `.pipe(Effect.mapError(mapSqlError("listBindings")));
      return yield* decodeStored(Schema.Array(NodeBindingSchema), rows, "listBindings");
    });

  const appendAttemptBinding = (inputBinding: HubPlanAttemptBinding) =>
    transaction(
      Effect.gen(function* () {
        const binding = yield* decodeInput(
          AttemptBindingSchema,
          inputBinding,
          "appendAttemptBinding",
        );
        const rows = yield* sql<HubPlanAttemptBinding>`
          SELECT
            id,
            plan_id AS "planId",
            revision,
            node_key AS "nodeKey",
            task_id AS "taskId",
            attempt_id AS "attemptId",
            work_item_id AS "workItemId",
            stage_generation AS "stageGeneration",
            created_at AS "createdAt"
          FROM hub_plan_attempt_bindings
          WHERE id = ${binding.id}
        `.pipe(Effect.mapError(mapSqlError("appendAttemptBinding.read")));
        const existing = rows[0];
        if (existing !== undefined) {
          if (!sameJson(existing, binding)) {
            return yield* Effect.fail(new HubPlanStoreIdempotencyError({ resourceId: binding.id }));
          }
          return existing;
        }
        const identityRows = yield* sql<{ readonly id: string }>`
          SELECT id
          FROM hub_plan_attempt_bindings
          WHERE attempt_id = ${binding.attemptId} OR work_item_id = ${binding.workItemId}
          LIMIT 1
        `.pipe(Effect.mapError(mapSqlError("appendAttemptBinding.identity")));
        if (identityRows.length > 0) {
          return yield* Effect.fail(
            new HubPlanStoreIdempotencyError({
              resourceId: `attempt:${binding.attemptId}:work:${binding.workItemId}`,
            }),
          );
        }
        yield* sql`
          INSERT INTO hub_plan_attempt_bindings (
            id, plan_id, revision, node_key, task_id, attempt_id,
            work_item_id, stage_generation, created_at
          ) VALUES (
            ${binding.id}, ${binding.planId}, ${binding.revision}, ${binding.nodeKey},
            ${binding.taskId}, ${binding.attemptId}, ${binding.workItemId},
            ${binding.stageGeneration}, ${binding.createdAt}
          )
        `.pipe(Effect.mapError(mapSqlError("appendAttemptBinding.insert")));
        return binding;
      }),
    );

  const listAttemptBindings = (input: { readonly planId: string }) =>
    Effect.gen(function* () {
      const request = yield* decodeInput(
        Schema.Struct({ planId: nonEmptyText }),
        input,
        "listAttemptBindings",
      );
      const rows = yield* sql<HubPlanAttemptBinding>`
        SELECT
          id,
          plan_id AS "planId",
          revision,
          node_key AS "nodeKey",
          task_id AS "taskId",
          attempt_id AS "attemptId",
          work_item_id AS "workItemId",
          stage_generation AS "stageGeneration",
          created_at AS "createdAt"
        FROM hub_plan_attempt_bindings
        WHERE plan_id = ${request.planId}
        ORDER BY created_at, id
      `.pipe(Effect.mapError(mapSqlError("listAttemptBindings")));
      return yield* decodeStored(Schema.Array(AttemptBindingSchema), rows, "listAttemptBindings");
    });

  const findAttemptBindingByWork = (input: { readonly workItemId: string }) =>
    Effect.gen(function* () {
      const request = yield* decodeInput(
        Schema.Struct({ workItemId: nonEmptyText }),
        input,
        "findAttemptBindingByWork",
      );
      const rows = yield* sql<HubPlanAttemptBinding>`
        SELECT
          id,
          plan_id AS "planId",
          revision,
          node_key AS "nodeKey",
          task_id AS "taskId",
          attempt_id AS "attemptId",
          work_item_id AS "workItemId",
          stage_generation AS "stageGeneration",
          created_at AS "createdAt"
        FROM hub_plan_attempt_bindings
        WHERE work_item_id = ${request.workItemId}
        ORDER BY created_at DESC, id DESC
        LIMIT 1
      `.pipe(Effect.mapError(mapSqlError("findAttemptBindingByWork")));
      const row = rows[0];
      return row === undefined
        ? null
        : yield* decodeStored(AttemptBindingSchema, row, "findAttemptBindingByWork");
    });

  const findAttemptBindingByThread = (input: { readonly threadId: string }) =>
    Effect.gen(function* () {
      const request = yield* decodeInput(
        Schema.Struct({ threadId: nonEmptyText }),
        input,
        "findAttemptBindingByThread",
      );
      const rows = yield* sql<HubPlanAttemptBinding>`
        SELECT
          binding.id,
          binding.plan_id AS "planId",
          binding.revision,
          binding.node_key AS "nodeKey",
          binding.task_id AS "taskId",
          binding.attempt_id AS "attemptId",
          binding.work_item_id AS "workItemId",
          binding.stage_generation AS "stageGeneration",
          binding.created_at AS "createdAt"
        FROM hub_plan_attempt_bindings binding
        JOIN project_agent_task_attempts attempt ON attempt.attempt_id = binding.attempt_id
        WHERE attempt.worker_thread_id = ${request.threadId}
        ORDER BY binding.created_at DESC, binding.id DESC
        LIMIT 1
      `.pipe(Effect.mapError(mapSqlError("findAttemptBindingByThread")));
      const row = rows[0];
      return row === undefined
        ? null
        : yield* decodeStored(AttemptBindingSchema, row, "findAttemptBindingByThread");
    });

  const saveInputRequest = (inputRecord: HubPlanInputRequestRecord) =>
    transaction(
      Effect.gen(function* () {
        const request = yield* decodeInput(
          InputRequestRecordSchema,
          inputRecord,
          "saveInputRequest",
        );
        const encoded = yield* encodeJson(request, "saveInputRequest");
        const rows = yield* sql<{ readonly recordJson: string }>`
          SELECT record_json AS "recordJson"
          FROM hub_plan_input_requests
          WHERE plan_id = ${request.planId} AND request_id = ${request.id}
        `.pipe(Effect.mapError(mapSqlError("saveInputRequest.read")));
        const existingRow = rows[0];
        if (existingRow === undefined) {
          if (request.status !== "pending" || request.answers !== undefined) {
            return yield* Effect.fail(
              new HubPlanStoreInvariantError({
                resourceId: request.id,
                detail: "a Hub input request must be created in pending status",
              }),
            );
          }
          yield* sql`
            INSERT INTO hub_plan_input_requests (
              plan_id, revision, request_id, record_json, created_at, updated_at
            ) VALUES (
              ${request.planId}, ${request.revision}, ${request.id}, ${encoded},
              ${request.createdAt}, ${request.updatedAt}
            )
          `.pipe(Effect.mapError(mapSqlError("saveInputRequest.insert")));
          return request;
        }

        const existing = yield* decodeRecordJson(
          InputRequestRecordSchema,
          existingRow.recordJson,
          "saveInputRequest.existing",
        );
        const identity = (record: HubPlanInputRequestRecord) => ({
          planId: record.planId,
          revision: record.revision,
          id: record.id,
          nodeKey: record.nodeKey,
          stageKey: record.stageKey,
          generation: record.generation,
          attemptId: record.attemptId,
          workerThreadId: record.workerThreadId,
          questions: record.questions,
          createdAt: record.createdAt,
        });
        if (!sameJson(identity(existing), identity(request))) {
          return yield* Effect.fail(new HubPlanStoreIdempotencyError({ resourceId: request.id }));
        }
        const sameOptionalJson = (left: unknown, right: unknown) =>
          left === undefined || right === undefined ? left === right : sameJson(left, right);
        const answersMatch = sameOptionalJson(existing.answers, request.answers);
        const authorizationFields = [
          "responseCreatedAt",
          "responseCommandId",
          "responseMessageId",
          "responseMessageDigest",
          "responseRuntimeMode",
          "responseInteractionMode",
          "responseModelSelection",
        ] as const;
        const authorizationStable = authorizationFields.every(
          (field) =>
            existing[field] === undefined || sameOptionalJson(existing[field], request[field]),
        );
        const hasResponseIdentity =
          request.responseCreatedAt !== undefined ||
          request.responseCommandId !== undefined ||
          request.responseMessageId !== undefined ||
          request.responseMessageDigest !== undefined;
        const hasCompleteResponseIdentity =
          request.responseCreatedAt !== undefined &&
          request.responseCommandId !== undefined &&
          request.responseMessageId !== undefined &&
          request.responseMessageDigest !== undefined;
        const hasAnyPinnedSettings =
          request.responseRuntimeMode !== undefined ||
          request.responseInteractionMode !== undefined ||
          request.responseModelSelection !== undefined;
        const hasCompletePinnedSettings =
          request.responseRuntimeMode !== undefined &&
          request.responseInteractionMode !== undefined &&
          request.responseModelSelection !== undefined;
        const allowedTransition =
          existing.status === request.status ||
          (existing.status === "pending" &&
            (request.status === "answered" || request.status === "stale")) ||
          (existing.status === "answered" &&
            (request.status === "delivered" || request.status === "stale"));
        if (
          !allowedTransition ||
          (existing.answers !== undefined && !answersMatch) ||
          !authorizationStable ||
          (hasResponseIdentity && !hasCompleteResponseIdentity) ||
          (hasAnyPinnedSettings && !hasCompletePinnedSettings) ||
          ((hasResponseIdentity || hasAnyPinnedSettings) && request.status === "pending")
        ) {
          return yield* Effect.fail(new HubPlanStoreIdempotencyError({ resourceId: request.id }));
        }
        if (
          (request.status === "answered" || request.status === "delivered") &&
          request.responseCreatedAt === undefined
        ) {
          return yield* Effect.fail(
            new HubPlanStoreInvariantError({
              resourceId: request.id,
              detail: "an answered Hub input request requires its immutable response timestamp",
            }),
          );
        }
        if (existing.status === request.status && answersMatch && sameJson(existing, request))
          return existing;
        if (request.status === "answered" && request.answers === undefined) {
          return yield* Effect.fail(
            new HubPlanStoreInvariantError({
              resourceId: request.id,
              detail: "an answered Hub input request requires answers",
            }),
          );
        }
        const updatedRows = yield* sql<{ readonly recordJson: string }>`
          UPDATE hub_plan_input_requests
          SET record_json = ${encoded}, updated_at = ${request.updatedAt}
          WHERE plan_id = ${request.planId} AND request_id = ${request.id}
            AND record_json = ${existingRow.recordJson}
          RETURNING record_json AS "recordJson"
        `.pipe(Effect.mapError(mapSqlError("saveInputRequest.update")));
        if (updatedRows.length === 0) {
          return yield* Effect.fail(
            new HubPlanStoreConflictError({
              resourceId: request.id,
              expectedStateVersion: null,
              actualStateVersion: null,
            }),
          );
        }
        return request;
      }),
    );

  const readInputRequest = (input: { readonly planId: string; readonly requestId: string }) =>
    Effect.gen(function* () {
      const request = yield* decodeInput(
        Schema.Struct({ planId: nonEmptyText, requestId: nonEmptyText }),
        input,
        "readInputRequest",
      );
      const rows = yield* sql<{ readonly recordJson: string }>`
        SELECT record_json AS "recordJson"
        FROM hub_plan_input_requests
        WHERE plan_id = ${request.planId} AND request_id = ${request.requestId}
      `.pipe(Effect.mapError(mapSqlError("readInputRequest")));
      const row = rows[0];
      return row === undefined
        ? null
        : yield* decodeRecordJson(InputRequestRecordSchema, row.recordJson, "readInputRequest");
    });

  const listInputRequests = (input: { readonly planId: string; readonly revision?: number }) =>
    Effect.gen(function* () {
      const query = yield* decodeInput(
        Schema.Struct({ planId: nonEmptyText, revision: Schema.optional(positiveInt) }),
        input,
        "listInputRequests",
      );
      const rows =
        query.revision === undefined
          ? yield* sql<{ readonly recordJson: string }>`
              SELECT record_json AS "recordJson"
              FROM hub_plan_input_requests
              WHERE plan_id = ${query.planId}
              ORDER BY created_at, request_id
            `.pipe(Effect.mapError(mapSqlError("listInputRequests")))
          : yield* sql<{ readonly recordJson: string }>`
              SELECT record_json AS "recordJson"
              FROM hub_plan_input_requests
              WHERE plan_id = ${query.planId} AND revision = ${query.revision}
              ORDER BY created_at, request_id
            `.pipe(Effect.mapError(mapSqlError("listInputRequests")));
      return yield* Effect.forEach(rows, (row) =>
        decodeRecordJson(InputRequestRecordSchema, row.recordJson, "listInputRequests"),
      );
    });

  const appendImmutableRecord = <
    A extends { readonly planId: string; readonly id: string; readonly createdAt: string },
  >(
    table: "candidate" | "review" | "release",
    inputRecord: A,
    schema: Schema.Decoder<A>,
  ) =>
    transaction(
      Effect.gen(function* () {
        const record = yield* decodeInput(schema, inputRecord, `append${table}`);
        const recordJson = yield* encodeJson(record, `append${table}`);
        const rows =
          table === "candidate"
            ? yield* sql<{ readonly recordJson: string }>`
                SELECT record_json AS "recordJson" FROM hub_plan_candidates
                WHERE plan_id = ${record.planId} AND id = ${record.id}
              `.pipe(Effect.mapError(mapSqlError("appendCandidate.read")))
            : table === "review"
              ? yield* sql<{ readonly recordJson: string }>`
                  SELECT record_json AS "recordJson" FROM hub_plan_reviews
                  WHERE plan_id = ${record.planId} AND id = ${record.id}
                `.pipe(Effect.mapError(mapSqlError("appendReview.read")))
              : yield* sql<{ readonly recordJson: string }>`
                  SELECT record_json AS "recordJson" FROM hub_plan_releases
                  WHERE plan_id = ${record.planId} AND id = ${record.id}
                `.pipe(Effect.mapError(mapSqlError("appendRelease.read")));
        const existing = rows[0];
        if (existing !== undefined) {
          const stored = yield* decodeRecordJson(
            schema,
            existing.recordJson,
            `append${table}.read`,
          );
          if (!sameJson(stored, record)) {
            return yield* Effect.fail(
              new HubPlanStoreIdempotencyError({ resourceId: `${record.planId}:${record.id}` }),
            );
          }
          return stored;
        }
        if (table === "candidate") {
          const candidate = record as unknown as HubPlanCandidateRecord;
          const generationRows = yield* sql<{ readonly recordJson: string }>`
            SELECT record_json AS "recordJson" FROM hub_plan_candidates
            WHERE plan_id = ${candidate.planId}
          `.pipe(Effect.mapError(mapSqlError("appendCandidate.findGeneration")));
          for (const row of generationRows) {
            const stored = yield* decodeRecordJson(
              CandidateSchema,
              row.recordJson,
              "appendCandidate.findGeneration",
            );
            if (
              stored.revision !== candidate.revision ||
              stored.stageKey !== candidate.stageKey ||
              stored.generation !== candidate.generation
            ) {
              continue;
            }
            if (!sameCandidateSubmission(stored, candidate)) {
              return yield* Effect.fail(
                new HubPlanStoreIdempotencyError({
                  resourceId: `${candidate.planId}:candidate:${candidate.revision}:${candidate.stageKey}:${candidate.generation}`,
                }),
              );
            }
            return stored as unknown as A;
          }
        } else if (table === "review") {
          const review = record as unknown as HubPlanReviewRecord;
          const candidateRows = yield* sql<{ readonly recordJson: string }>`
            SELECT record_json AS "recordJson" FROM hub_plan_reviews
            WHERE plan_id = ${review.planId}
          `.pipe(Effect.mapError(mapSqlError("appendReview.findAttempt")));
          for (const row of candidateRows) {
            const stored = yield* decodeRecordJson(
              ReviewSchema,
              row.recordJson,
              "appendReview.findAttempt",
            );
            if (
              stored.candidateId !== review.candidateId ||
              stored.reviewerNodeKey !== review.reviewerNodeKey ||
              stored.attemptId !== review.attemptId ||
              stored.generation !== review.generation
            ) {
              continue;
            }
            if (!sameReviewSubmission(stored, review)) {
              return yield* Effect.fail(
                new HubPlanStoreIdempotencyError({
                  resourceId: `${review.planId}:review:${review.candidateId}:${review.reviewerNodeKey}:${review.attemptId}:${review.generation}`,
                }),
              );
            }
            return stored as unknown as A;
          }
        }
        if (table === "candidate") {
          yield* sql`
            INSERT INTO hub_plan_candidates (plan_id, id, record_json, created_at)
            VALUES (${record.planId}, ${record.id}, ${recordJson}, ${record.createdAt})
          `.pipe(Effect.mapError(mapSqlError("appendCandidate.insert")));
        } else if (table === "review") {
          yield* sql`
            INSERT INTO hub_plan_reviews (plan_id, id, record_json, created_at)
            VALUES (${record.planId}, ${record.id}, ${recordJson}, ${record.createdAt})
          `.pipe(Effect.mapError(mapSqlError("appendReview.insert")));
        } else {
          yield* sql`
            INSERT INTO hub_plan_releases (plan_id, id, record_json, created_at)
            VALUES (${record.planId}, ${record.id}, ${recordJson}, ${record.createdAt})
          `.pipe(Effect.mapError(mapSqlError("appendRelease.insert")));
        }
        return record;
      }),
    );

  const listImmutableRecords = <A>(
    table: "candidate" | "review" | "release",
    input: { readonly planId: string },
    schema: Schema.Decoder<A>,
  ) =>
    Effect.gen(function* () {
      const request = yield* decodeInput(
        Schema.Struct({ planId: nonEmptyText }),
        input,
        `list${table}`,
      );
      const rows =
        table === "candidate"
          ? yield* sql<{ readonly recordJson: string }>`
              SELECT record_json AS "recordJson" FROM hub_plan_candidates
              WHERE plan_id = ${request.planId} ORDER BY created_at, id
            `.pipe(Effect.mapError(mapSqlError("listCandidates")))
          : table === "review"
            ? yield* sql<{ readonly recordJson: string }>`
                SELECT record_json AS "recordJson" FROM hub_plan_reviews
                WHERE plan_id = ${request.planId} ORDER BY created_at, id
              `.pipe(Effect.mapError(mapSqlError("listReviews")))
            : yield* sql<{ readonly recordJson: string }>`
                SELECT record_json AS "recordJson" FROM hub_plan_releases
                WHERE plan_id = ${request.planId} ORDER BY created_at, id
              `.pipe(Effect.mapError(mapSqlError("listReleases")));
      return yield* Effect.forEach(
        rows,
        ({ recordJson }) => decodeRecordJson(schema, recordJson, `list${table}`),
        { concurrency: 1 },
      );
    });

  const appendEvent = (inputEvent: Omit<HubPlanEvent, "sequence">) =>
    Effect.gen(function* () {
      const event = yield* decodeInput(
        Schema.Struct({
          planId: nonEmptyText,
          hubId: nonEmptyText,
          kind: nonEmptyText,
          payload: Schema.Unknown,
          createdAt: nonEmptyText,
        }),
        inputEvent,
        "appendEvent",
      );
      const payloadJson = yield* encodeJson(event.payload, "appendEvent.payload");
      const rows = yield* sql<{ readonly sequence: number }>`
        INSERT INTO hub_plan_events (plan_id, hub_id, kind, payload_json, created_at)
        VALUES (${event.planId}, ${event.hubId}, ${event.kind}, ${payloadJson}, ${event.createdAt})
        RETURNING sequence
      `.pipe(Effect.mapError(mapSqlError("appendEvent")));
      const sequence = rows[0]?.sequence;
      if (sequence === undefined) {
        return yield* Effect.fail(
          new HubPlanStoreInvariantError({
            resourceId: event.planId,
            detail: "SQLite did not return the allocated event sequence",
          }),
        );
      }
      return { ...event, sequence };
    });

  const readEvents = (
    input: {
      readonly afterSequence?: number;
      readonly planId?: string;
      readonly hubId?: string;
      readonly limit?: number;
    } = {},
  ) =>
    Effect.gen(function* () {
      const request = yield* decodeInput(
        Schema.Struct({
          afterSequence: Schema.optional(nonNegativeInt),
          planId: Schema.optional(nonEmptyText),
          hubId: Schema.optional(nonEmptyText),
          limit: Schema.optional(positiveInt),
        }),
        input,
        "readEvents",
      );
      const afterSequence = request.afterSequence ?? 0;
      const limit = Math.min(request.limit ?? 500, 5_000);
      const planId = request.planId ?? null;
      const hubId = request.hubId ?? null;
      const rows = yield* sql<{
        readonly sequence: number;
        readonly planId: string;
        readonly hubId: string;
        readonly kind: string;
        readonly payloadJson: string;
        readonly createdAt: string;
      }>`
        SELECT
          sequence,
          plan_id AS "planId",
          hub_id AS "hubId",
          kind,
          payload_json AS "payloadJson",
          created_at AS "createdAt"
        FROM hub_plan_events
        WHERE sequence > ${afterSequence}
          AND (${planId} IS NULL OR plan_id = ${planId})
          AND (${hubId} IS NULL OR hub_id = ${hubId})
        ORDER BY sequence
        LIMIT ${limit}
      `.pipe(Effect.mapError(mapSqlError("readEvents")));
      return yield* Effect.forEach(rows, eventFromRow, { concurrency: 1 });
    });

  const readLatestEventSequence = (input: { readonly hubId: string; readonly planId?: string }) =>
    Effect.gen(function* () {
      const request = yield* decodeInput(
        Schema.Struct({ hubId: nonEmptyText, planId: Schema.optional(nonEmptyText) }),
        input,
        "readLatestEventSequence",
      );
      const planId = request.planId ?? null;
      const rows = yield* sql<{ readonly sequence: number | null }>`
        SELECT MAX(sequence) AS sequence
        FROM hub_plan_events
        WHERE hub_id = ${request.hubId}
          AND (${planId} IS NULL OR plan_id = ${planId})
      `.pipe(Effect.mapError(mapSqlError("readLatestEventSequence")));
      return rows[0]?.sequence ?? 0;
    });

  const readReceipt = (input: { readonly hubId: string; readonly requestId: string }) =>
    Effect.gen(function* () {
      const request = yield* decodeInput(
        Schema.Struct({ hubId: nonEmptyText, requestId: nonEmptyText }),
        input,
        "readReceipt",
      );
      const rows = yield* sql<HubPlanReceipt>`
        SELECT hub_id AS "hubId", request_id AS "requestId", digest, result_json AS "resultJson"
        FROM hub_plan_operation_receipts
        WHERE hub_id = ${request.hubId} AND request_id = ${request.requestId}
      `.pipe(Effect.mapError(mapSqlError("readReceipt")));
      const row = rows[0];
      return row === undefined ? null : yield* decodeStored(ReceiptSchema, row, "readReceipt");
    });

  const writeReceipt = (inputReceipt: HubPlanReceipt) =>
    transaction(
      Effect.gen(function* () {
        const receipt = yield* decodeInput(ReceiptSchema, inputReceipt, "writeReceipt");
        const existingRows = yield* sql<HubPlanReceipt>`
          SELECT hub_id AS "hubId", request_id AS "requestId", digest, result_json AS "resultJson"
          FROM hub_plan_operation_receipts
          WHERE hub_id = ${receipt.hubId} AND request_id = ${receipt.requestId}
        `.pipe(Effect.mapError(mapSqlError("writeReceipt.read")));
        const existing = existingRows[0];
        if (existing !== undefined) {
          if (!sameJson(existing, receipt)) {
            return yield* Effect.fail(
              new HubPlanStoreIdempotencyError({
                resourceId: `${receipt.hubId}:${receipt.requestId}`,
              }),
            );
          }
          return existing;
        }
        yield* sql`
          INSERT INTO hub_plan_operation_receipts (
            hub_id, request_id, digest, result_json, created_at
          ) VALUES (
            ${receipt.hubId}, ${receipt.requestId}, ${receipt.digest}, ${receipt.resultJson},
            ${new Date().toISOString()}
          )
        `.pipe(Effect.mapError(mapSqlError("writeReceipt.insert")));
        return receipt;
      }),
    );

  const enqueue = (inputItem: Omit<HubPlanOutboxItem, "status">) =>
    transaction(
      Effect.gen(function* () {
        const item = yield* decodeInput(
          Schema.Struct({
            id: nonEmptyText,
            planId: nonEmptyText,
            kind: nonEmptyText,
            payload: Schema.Unknown,
            createdAt: nonEmptyText,
          }),
          inputItem,
          "enqueue",
        );
        const itemJson = yield* encodeJson(item.payload, "enqueue.payload");
        const existingRows = yield* sql<{
          readonly id: string;
          readonly planId: string;
          readonly kind: string;
          readonly payloadJson: string;
          readonly status: string;
          readonly createdAt: string;
        }>`
          SELECT
            id,
            plan_id AS "planId",
            kind,
            payload_json AS "payloadJson",
            status,
            created_at AS "createdAt"
          FROM hub_plan_outbox
          WHERE id = ${item.id}
        `.pipe(Effect.mapError(mapSqlError("enqueue.read")));
        const existingRow = existingRows[0];
        if (existingRow !== undefined) {
          const existing = yield* outboxFromRow(existingRow);
          if (
            existing.planId !== item.planId ||
            existing.kind !== item.kind ||
            !sameJson(existing.payload, item.payload) ||
            existing.createdAt !== item.createdAt
          ) {
            return yield* Effect.fail(new HubPlanStoreIdempotencyError({ resourceId: item.id }));
          }
          return existing;
        }
        yield* sql`
          INSERT INTO hub_plan_outbox (id, plan_id, kind, payload_json, status, created_at)
          VALUES (${item.id}, ${item.planId}, ${item.kind}, ${itemJson}, 'pending', ${item.createdAt})
        `.pipe(Effect.mapError(mapSqlError("enqueue.insert")));
        return { ...item, status: "pending" as const };
      }),
    );

  const readPending = (input: { readonly planId?: string; readonly limit?: number } = {}) =>
    Effect.gen(function* () {
      const request = yield* decodeInput(
        Schema.Struct({
          planId: Schema.optional(nonEmptyText),
          limit: Schema.optional(positiveInt),
        }),
        input,
        "readPending",
      );
      const planId = request.planId ?? null;
      const limit = Math.min(request.limit ?? 500, 5_000);
      const rows = yield* sql<{
        readonly id: string;
        readonly planId: string;
        readonly kind: string;
        readonly payloadJson: string;
        readonly status: string;
        readonly createdAt: string;
      }>`
        SELECT
          id,
          plan_id AS "planId",
          kind,
          payload_json AS "payloadJson",
          status,
          created_at AS "createdAt"
        FROM hub_plan_outbox
        WHERE status = 'pending' AND (${planId} IS NULL OR plan_id = ${planId})
        ORDER BY created_at, id
        LIMIT ${limit}
      `.pipe(Effect.mapError(mapSqlError("readPending")));
      return yield* Effect.forEach(rows, outboxFromRow, { concurrency: 1 });
    });

  const markDelivered = (input: { readonly id: string }) =>
    Effect.gen(function* () {
      const request = yield* decodeInput(
        Schema.Struct({ id: nonEmptyText }),
        input,
        "markDelivered",
      );
      const updated = yield* sql<{
        readonly id: string;
        readonly planId: string;
        readonly kind: string;
        readonly payloadJson: string;
        readonly status: string;
        readonly createdAt: string;
      }>`
        UPDATE hub_plan_outbox
        SET status = 'delivered'
        WHERE id = ${request.id}
        RETURNING
          id,
          plan_id AS "planId",
          kind,
          payload_json AS "payloadJson",
          status,
          created_at AS "createdAt"
      `.pipe(Effect.mapError(mapSqlError("markDelivered")));
      const row = updated[0];
      if (row !== undefined) return yield* outboxFromRow(row);
      const rows = yield* sql<{
        readonly id: string;
        readonly planId: string;
        readonly kind: string;
        readonly payloadJson: string;
        readonly status: string;
        readonly createdAt: string;
      }>`
        SELECT
          id,
          plan_id AS "planId",
          kind,
          payload_json AS "payloadJson",
          status,
          created_at AS "createdAt"
        FROM hub_plan_outbox
        WHERE id = ${request.id}
      `.pipe(Effect.mapError(mapSqlError("markDelivered.read")));
      const existing = rows[0];
      return existing === undefined ? null : yield* outboxFromRow(existing);
    });

  const appendCandidate = (record: HubPlanCandidateRecord) =>
    appendImmutableRecord("candidate", record, CandidateSchema);
  const appendReview = (record: HubPlanReviewRecord) =>
    appendImmutableRecord("review", record, ReviewSchema);
  const appendRelease = (record: HubPlanReleaseRecord) =>
    appendImmutableRecord("release", record, ReleaseSchema);

  return {
    transaction,
    read,
    list,
    savePlan,
    saveBindings,
    listBindings,
    appendAttemptBinding,
    listAttemptBindings,
    findAttemptBindingByWork,
    findAttemptBindingByThread,
    saveInputRequest,
    readInputRequest,
    listInputRequests,
    appendCandidate,
    listCandidates: (input) => listImmutableRecords("candidate", input, CandidateSchema),
    appendReview,
    listReviews: (input) => listImmutableRecords("review", input, ReviewSchema),
    appendRelease,
    listReleases: (input) => listImmutableRecords("release", input, ReleaseSchema),
    appendEvent,
    readEvents,
    readLatestEventSequence,
    readReceipt,
    writeReceipt,
    enqueue,
    readPending,
    markDelivered,
  };
};
