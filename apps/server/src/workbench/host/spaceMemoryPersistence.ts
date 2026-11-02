import {
  LearningChangeSet,
  RunKnowledgeManifest,
  SpaceMemoryEntry,
  SpaceMemoryReadReceipt,
  type LearningSourceReference,
  type MemoryScope,
} from "@synara/contracts";
import { Effect, Layer, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import {
  SpaceMemoryRepository,
  type SpaceMemoryRepositoryShape,
} from "../../spaceMemory/SpaceMemoryRepository.ts";
import { SpaceMemoryServiceLive } from "../../spaceMemory/SpaceMemoryService.ts";

const decode = <A>(schema: Schema.Codec<A>, record: string): A =>
  Schema.decodeUnknownSync(schema)(JSON.parse(record));

export const makeSpaceMemoryRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  type JsonRow = { readonly record_json: string };
  type SequenceRow = { readonly sequence: number };
  type IdRow = { readonly id: string };
  type MemoryIdRow = { readonly memory_id: string };
  type ChangeIdRow = { readonly change_id: string };

  const readChangeBy = (column: "request_id" | "change_id", values: readonly string[]) =>
    sql
      .unsafe<JsonRow>(
        `SELECT record_json FROM learning_change_sets WHERE ${column === "request_id" ? "owner_id = ? AND expert_id = ? AND request_id = ?" : "owner_id = ? AND change_id = ?"}`,
        values,
      )
      .pipe(
        Effect.flatMap((rows) =>
          rows[0] === undefined
            ? Effect.succeed(undefined)
            : Effect.try({
                try: () => decode(LearningChangeSet, rows[0]!.record_json),
                catch: (cause) => cause,
              }),
        ),
      );

  const findSourceChanges = (
    ownerId: string,
    expertId: string,
    sources: readonly LearningSourceReference[],
  ) => {
    if (sources.length === 0) return Effect.succeed([] as readonly LearningChangeSet[]);
    if (sources.length > 128) {
      return Effect.fail(new Error("Source change lookup accepts at most 128 source identities."));
    }

    const identities = sources.map((source) => {
      switch (source.kind) {
        case "owner":
          return { kind: source.kind, requestId: source.requestId };
        case "message":
          return { kind: source.kind, threadId: source.threadId, messageId: source.messageId };
        case "runtime":
          return { kind: source.kind, runId: source.runId, eventId: source.eventId };
        case "document":
          return {
            kind: source.kind,
            documentId: source.documentId,
            contentHash: source.contentHash,
          };
        case "attachment":
          return {
            kind: source.kind,
            attachmentId: source.attachmentId,
            contentHash: source.contentHash,
          };
      }
    });
    const requestedSources = JSON.stringify(identities);
    return sql
      .unsafe<JsonRow>(
        `SELECT json_object(
          'changeId', json_extract(lcs.record_json, '$.changeId'),
          'requestId', json_extract(lcs.record_json, '$.requestId'),
          'requestFingerprint', json_extract(lcs.record_json, '$.requestFingerprint'),
          'ownerId', json_extract(lcs.record_json, '$.ownerId'),
          'expertId', json_extract(lcs.record_json, '$.expertId'),
          'sourceScope', json(json_extract(lcs.record_json, '$.sourceScope')),
          'assetKind', json_extract(lcs.record_json, '$.assetKind'),
          'before', json(json_extract(lcs.record_json, '$.before')),
          'after', json(json_extract(lcs.record_json, '$.after')),
          'sourceRefs', json(coalesce((
            SELECT json_group_array(json(json_remove(source_ref.value, '$.quote')))
            FROM json_each(lcs.record_json, '$.sourceRefs') AS source_ref
          ), '[]')),
          'status', json_extract(lcs.record_json, '$.status'),
          'summary', json_extract(lcs.record_json, '$.summary'),
          'data', json(CASE
            WHEN json_type(lcs.record_json, '$.data.kind') = 'text'
              AND json_type(lcs.record_json, '$.data.key') = 'text'
              THEN json_object(
                'kind', json_extract(lcs.record_json, '$.data.kind'),
                'key', json_extract(lcs.record_json, '$.data.key')
              )
            WHEN json_type(lcs.record_json, '$.data.kind') = 'text'
              THEN json_object('kind', json_extract(lcs.record_json, '$.data.kind'))
            WHEN json_type(lcs.record_json, '$.data.key') = 'text'
              THEN json_object('key', json_extract(lcs.record_json, '$.data.key'))
            ELSE '{}'
          END),
          'createdAt', json_extract(lcs.record_json, '$.createdAt'),
          'updatedAt', json_extract(lcs.record_json, '$.updatedAt')
        ) AS record_json
        FROM learning_change_sets AS lcs
        WHERE lcs.owner_id = ? AND lcs.expert_id = ?
          AND json_extract(lcs.record_json, '$.ownerId') = ?
          AND json_extract(lcs.record_json, '$.expertId') = ?
          AND EXISTS (
            SELECT 1
            FROM json_each(lcs.record_json, '$.sourceRefs') AS stored_source
            JOIN json_each(?) AS requested_source
            WHERE (
              json_extract(stored_source.value, '$.kind') = 'owner'
              AND json_extract(requested_source.value, '$.kind') = 'owner'
              AND json_extract(stored_source.value, '$.requestId') = json_extract(requested_source.value, '$.requestId')
            ) OR (
              json_extract(stored_source.value, '$.kind') = 'message'
              AND json_extract(requested_source.value, '$.kind') = 'message'
              AND json_extract(stored_source.value, '$.threadId') = json_extract(requested_source.value, '$.threadId')
              AND json_extract(stored_source.value, '$.messageId') = json_extract(requested_source.value, '$.messageId')
            ) OR (
              json_extract(stored_source.value, '$.kind') = 'runtime'
              AND json_extract(requested_source.value, '$.kind') = 'runtime'
              AND json_extract(stored_source.value, '$.runId') = json_extract(requested_source.value, '$.runId')
              AND json_extract(stored_source.value, '$.eventId') = json_extract(requested_source.value, '$.eventId')
            ) OR (
              json_extract(stored_source.value, '$.kind') = 'document'
              AND json_extract(requested_source.value, '$.kind') = 'document'
              AND json_extract(stored_source.value, '$.documentId') = json_extract(requested_source.value, '$.documentId')
              AND json_extract(stored_source.value, '$.contentHash') = json_extract(requested_source.value, '$.contentHash')
            ) OR (
              json_extract(stored_source.value, '$.kind') = 'attachment'
              AND json_extract(requested_source.value, '$.kind') = 'attachment'
              AND json_extract(stored_source.value, '$.attachmentId') = json_extract(requested_source.value, '$.attachmentId')
              AND json_extract(stored_source.value, '$.contentHash') = json_extract(requested_source.value, '$.contentHash')
            )
          )
        ORDER BY lcs.created_at, lcs.change_id
        LIMIT 257`,
        [ownerId, expertId, ownerId, expertId, requestedSources],
      )
      .pipe(
        Effect.flatMap((rows) =>
          rows.length > 256
            ? Effect.fail(
                new Error(
                  "Source change lookup exceeded the 256-change limit; narrow the source identities.",
                ),
              )
            : Effect.try({
                try: () => rows.map((row) => decode(LearningChangeSet, row.record_json)),
                catch: (cause) => cause,
              }),
        ),
      );
  };

  return {
    withTransaction: <A, E, R>(effect: Effect.Effect<A, E, R>) => sql.withTransaction(effect),
    sequence: (ownerId: string) =>
      sql
        .unsafe<SequenceRow>("SELECT sequence FROM space_memory_sequences WHERE owner_id = ?", [
          ownerId,
        ])
        .pipe(Effect.map((rows) => rows[0]?.sequence ?? 0)),
    nextSequence: (ownerId: string) =>
      sql
        .unsafe<SequenceRow>(
          "INSERT INTO space_memory_sequences (owner_id, sequence) VALUES (?, 1) ON CONFLICT(owner_id) DO UPDATE SET sequence = space_memory_sequences.sequence + 1 RETURNING sequence",
          [ownerId],
        )
        .pipe(
          Effect.flatMap((rows) =>
            rows[0] === undefined
              ? Effect.fail(new Error("Could not advance the Space Memory commit sequence."))
              : Effect.succeed(rows[0].sequence),
          ),
        ),
    readHead: (ownerId: string, memoryId: string) =>
      sql
        .unsafe<JsonRow>(
          "SELECT record_json FROM space_memory_heads WHERE owner_id = ? AND memory_id = ?",
          [ownerId, memoryId],
        )
        .pipe(
          Effect.flatMap((rows) =>
            rows[0] === undefined
              ? Effect.succeed(undefined)
              : Effect.try({
                  try: () => decode(SpaceMemoryEntry, rows[0]!.record_json),
                  catch: (cause) => cause,
                }),
          ),
        ),
    readRevision: (ownerId: string, memoryId: string, revision: number) =>
      sql
        .unsafe<JsonRow>(
          "SELECT record_json FROM space_memory_revisions WHERE owner_id = ? AND memory_id = ? AND revision = ?",
          [ownerId, memoryId, revision],
        )
        .pipe(
          Effect.flatMap((rows) =>
            rows[0] === undefined
              ? Effect.succeed(undefined)
              : Effect.try({
                  try: () => decode(SpaceMemoryEntry, rows[0]!.record_json),
                  catch: (cause) => cause,
                }),
          ),
        ),
    listAtSequence: (scope: MemoryScope, sequence: number, kinds: readonly string[]) => {
      if (kinds.length === 0) return Effect.succeed([] as readonly SpaceMemoryEntry[]);
      const placeholders = kinds.map(() => "?").join(", ");
      const parameters: Array<string | number> = [
        scope.ownerId,
        scope.spaceId ?? "",
        scope.expertId,
        sequence,
        scope.spaceId ?? "",
        scope.projectId,
        ...kinds,
      ];
      return sql
        .unsafe<JsonRow>(
          `WITH ranked AS (
            SELECT record_json,
              ROW_NUMBER() OVER (PARTITION BY memory_id ORDER BY commit_sequence DESC, revision DESC) AS revision_rank
            FROM space_memory_revisions
            WHERE owner_id = ? AND space_key = ? AND expert_id = ? AND commit_sequence <= ?
              AND ((kind = 'rule' AND ? <> '') OR project_id = ?)
              AND kind IN (${placeholders})
          )
          SELECT record_json FROM ranked WHERE revision_rank = 1 ORDER BY record_json`,
          parameters,
        )
        .pipe(
          Effect.flatMap((rows) =>
            Effect.try({
              try: () => rows.map((row) => decode(SpaceMemoryEntry, row.record_json)),
              catch: (cause) => cause,
            }),
          ),
        );
    },
    writeRevision: (entry: SpaceMemoryEntry, expectedRevision: number) => {
      const spaceKey = entry.scope.spaceId ?? "";
      const record = JSON.stringify(entry);
      return sql
        .unsafe<IdRow>(
          "INSERT INTO space_memory_revisions (owner_id, memory_id, revision, space_key, expert_id, project_id, kind, commit_sequence, record_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(owner_id, memory_id, revision) DO NOTHING RETURNING memory_id",
          [
            entry.scope.ownerId,
            entry.memoryId,
            entry.revision,
            spaceKey,
            entry.scope.expertId,
            entry.scope.projectId,
            entry.kind,
            entry.commitSequence,
            record,
          ],
        )
        .pipe(
          Effect.flatMap((inserted) =>
            inserted.length !== 1
              ? Effect.fail(new Error("Space Memory revision is immutable and already exists."))
              : sql
                  .unsafe<MemoryIdRow>(
                    "INSERT INTO space_memory_heads (owner_id, memory_id, space_key, expert_id, project_id, revision, record_json) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(owner_id, memory_id) DO UPDATE SET revision = excluded.revision, record_json = excluded.record_json WHERE space_memory_heads.revision = ? AND space_memory_heads.space_key = excluded.space_key AND space_memory_heads.expert_id = excluded.expert_id AND space_memory_heads.project_id = excluded.project_id RETURNING memory_id",
                    [
                      entry.scope.ownerId,
                      entry.memoryId,
                      spaceKey,
                      entry.scope.expertId,
                      entry.scope.projectId,
                      entry.revision,
                      record,
                      expectedRevision,
                    ],
                  )
                  .pipe(
                    Effect.flatMap((updated) =>
                      updated.length === 1
                        ? Effect.void
                        : Effect.fail(
                            new Error("Space Memory revision conflict; the current head changed."),
                          ),
                    ),
                  ),
          ),
        );
    },
    findChangeByRequest: (ownerId: string, expertId: string, requestId: string) =>
      readChangeBy("request_id", [ownerId, expertId, requestId]),
    getChange: (ownerId: string, changeId: string) =>
      readChangeBy("change_id", [ownerId, changeId]),
    createChange: (change: LearningChangeSet) =>
      sql
        .unsafe<ChangeIdRow>(
          "INSERT INTO learning_change_sets (change_id, owner_id, expert_id, request_id, request_fingerprint, status, record_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING RETURNING change_id",
          [
            change.changeId,
            change.ownerId,
            change.expertId,
            change.requestId,
            change.requestFingerprint,
            change.status,
            JSON.stringify(change),
            change.createdAt,
            change.updatedAt,
          ],
        )
        .pipe(
          Effect.flatMap((rows) =>
            rows.length === 1
              ? Effect.void
              : Effect.fail(
                  new Error("A learning change already exists for this request identity."),
                ),
          ),
        ),
    updateChange: (change: LearningChangeSet) =>
      sql
        .unsafe<ChangeIdRow>(
          "UPDATE learning_change_sets SET status = ?, record_json = ?, updated_at = ? WHERE owner_id = ? AND expert_id = ? AND change_id = ? AND request_id = ? RETURNING change_id",
          [
            change.status,
            JSON.stringify(change),
            change.updatedAt,
            change.ownerId,
            change.expertId,
            change.changeId,
            change.requestId,
          ],
        )
        .pipe(
          Effect.flatMap((rows) =>
            rows.length === 1
              ? Effect.void
              : Effect.fail(new Error("The learning change identity is missing or has changed.")),
          ),
        ),
    listChanges: (ownerId: string, expertId: string, limit: number) =>
      sql
        .unsafe<JsonRow>(
          "SELECT record_json FROM learning_change_sets WHERE owner_id = ? AND expert_id = ? ORDER BY created_at DESC, change_id DESC LIMIT ?",
          [ownerId, expertId, limit],
        )
        .pipe(
          Effect.flatMap((rows) =>
            Effect.try({
              try: () => rows.map((row) => decode(LearningChangeSet, row.record_json)),
              catch: (cause) => cause,
            }),
          ),
        ),
    findSourceChanges,
    readManifest: (manifestId: string) =>
      sql
        .unsafe<JsonRow>("SELECT record_json FROM run_knowledge_manifests WHERE manifest_id = ?", [
          manifestId,
        ])
        .pipe(
          Effect.flatMap((rows) =>
            rows[0] === undefined
              ? Effect.succeed(undefined)
              : Effect.try({
                  try: () => decode(RunKnowledgeManifest, rows[0]!.record_json),
                  catch: (cause) => cause,
                }),
          ),
        ),
    findManifestByRoot: (scope: MemoryScope, rootRunId: string) =>
      sql
        .unsafe<JsonRow>(
          "SELECT record_json FROM run_knowledge_manifests WHERE owner_id = ? AND space_key = ? AND expert_id = ? AND project_id = ? AND root_run_id = ?",
          [scope.ownerId, scope.spaceId ?? "", scope.expertId, scope.projectId, rootRunId],
        )
        .pipe(
          Effect.flatMap((rows) =>
            rows[0] === undefined
              ? Effect.succeed(undefined)
              : Effect.try({
                  try: () => decode(RunKnowledgeManifest, rows[0]!.record_json),
                  catch: (cause) => cause,
                }),
          ),
        ),
    createManifest: (manifest: RunKnowledgeManifest) =>
      sql
        .unsafe<{ readonly manifest_id: string }>(
          "INSERT INTO run_knowledge_manifests (manifest_id, owner_id, space_key, expert_id, project_id, root_run_id, record_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(manifest_id) DO NOTHING RETURNING manifest_id",
          [
            manifest.id,
            manifest.scope.ownerId,
            manifest.scope.spaceId ?? "",
            manifest.scope.expertId,
            manifest.scope.projectId,
            manifest.rootRunId,
            JSON.stringify(manifest),
            manifest.createdAt,
          ],
        )
        .pipe(
          Effect.flatMap((rows) =>
            rows.length === 1
              ? Effect.void
              : Effect.fail(new Error("The Run knowledge manifest ID already exists.")),
          ),
        ),
    createReadReceipt: (receipt: SpaceMemoryReadReceipt) =>
      sql
        .unsafe<{ readonly manifest_id: string }>(
          "INSERT INTO space_memory_reads (manifest_id, memory_id, revision, content_hash, tool_call_id, read_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(manifest_id, memory_id, revision, tool_call_id) DO UPDATE SET content_hash = excluded.content_hash WHERE space_memory_reads.content_hash = excluded.content_hash RETURNING manifest_id",
          [
            receipt.manifestId,
            receipt.memoryId,
            receipt.revision,
            receipt.contentHash,
            receipt.toolCallId,
            receipt.readAt,
          ],
        )
        .pipe(
          Effect.flatMap((rows) =>
            rows.length === 1
              ? Effect.void
              : Effect.fail(
                  new Error("The Space Memory read receipt conflicts with an earlier read."),
                ),
          ),
        ),
  } satisfies SpaceMemoryRepositoryShape;
});

export const SpaceMemoryRepositoryLive = Layer.effect(
  SpaceMemoryRepository,
  makeSpaceMemoryRepository,
);

export const SpaceMemoryLive = SpaceMemoryServiceLive.pipe(
  Layer.provideMerge(SpaceMemoryRepositoryLive),
);
