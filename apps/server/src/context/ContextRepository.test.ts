import {
  CommandId,
  EventId,
  ProjectId,
  SpaceId,
  ThreadId,
  type OrchestrationEvent,
} from "@synara/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { createHash } from "node:crypto";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import {
  ContextRepository,
  ContextRepositoryLive,
  type ContextRepositoryShape,
} from "./ContextRepository.ts";

type ContextEvent = Extract<
  OrchestrationEvent,
  {
    type:
      | "context.space.save-requested"
      | "context.project.save-requested"
      | "context.migration.claim-requested"
      | "context.migration.resolve-requested"
      | "context.thread.binding-set"
      | "context.thread.bind-requested";
  }
>;

const repoLayer = it.layer(ContextRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)));
const now = "2026-10-14T10:00:00.000Z";
const spaceId = SpaceId.makeUnsafe("ctx-space");
const projectId = ProjectId.makeUnsafe("ctx-project");
const threadId = ThreadId.makeUnsafe("ctx-thread");
const emptyProjectId = ProjectId.makeUnsafe("ctx-empty-project");
const emptyThreadId = ThreadId.makeUnsafe("ctx-empty-thread");
let nextEventId = 0;

const event = (type: ContextEvent["type"], payload: ContextEvent["payload"]): ContextEvent =>
  ({
    sequence: ++nextEventId,
    eventId: EventId.makeUnsafe(`ctx-event-${nextEventId}`),
    type,
    aggregateKind: type.startsWith("context.thread.")
      ? "thread"
      : type.startsWith("context.space.")
        ? "space"
        : "project",
    aggregateId:
      "threadId" in payload
        ? payload.threadId
        : "spaceId" in payload
          ? payload.spaceId
          : payload.projectId,
    occurredAt: now,
    commandId:
      "commandId" in payload ? payload.commandId : CommandId.makeUnsafe(`ctx-bind-${nextEventId}`),
    causationEventId: null,
    correlationId: null,
    actorKind: "system",
    metadata: {},
    payload,
  }) as ContextEvent;

const prepareAndApply = (repository: ContextRepositoryShape, input: ContextEvent) =>
  Effect.gen(function* () {
    switch (input.type) {
      case "context.space.save-requested": {
        const prepared = yield* repository.prepareSpaceSave(input);
        const committed = { ...prepared, sequence: input.sequence } as ContextEvent;
        yield* repository.applyEvent(committed);
        return committed;
      }
      case "context.project.save-requested": {
        const prepared = yield* repository.prepareProjectSave(input);
        const committed = { ...prepared, sequence: input.sequence } as ContextEvent;
        yield* repository.applyEvent(committed);
        return committed;
      }
      case "context.migration.claim-requested": {
        const prepared = yield* repository.prepareMigrationClaim(input);
        const committed = { ...prepared, sequence: input.sequence } as ContextEvent;
        yield* repository.applyEvent(committed);
        return committed;
      }
      case "context.migration.resolve-requested": {
        const prepared = yield* repository.prepareMigrationResolve(input);
        const committed = { ...prepared, sequence: input.sequence } as ContextEvent;
        yield* repository.applyEvent(committed);
        return committed;
      }
      case "context.thread.bind-requested": {
        const prepared = yield* repository.prepareBinding(input);
        const committed = { ...prepared, sequence: input.sequence } as ContextEvent;
        yield* repository.applyEvent(committed);
        return committed;
      }
      default:
        yield* repository.applyEvent(input);
        return input;
    }
  });

const seedRows = (sql: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    yield* sql`DELETE FROM context_thread_bindings WHERE thread_id IN (${threadId}, ${emptyThreadId})`;
    yield* sql`DELETE FROM context_applied_runtime_records WHERE thread_id IN (${threadId}, ${emptyThreadId})`;
    yield* sql`DELETE FROM context_projects WHERE project_id IN (${projectId}, ${emptyProjectId})`;
    yield* sql`DELETE FROM context_spaces WHERE space_id = ${spaceId}`;
    yield* sql`DELETE FROM context_migrations WHERE project_id IN (${projectId}, ${emptyProjectId})`;
    yield* sql`DELETE FROM context_command_results`;
    yield* sql`DELETE FROM projection_threads WHERE thread_id IN (${threadId}, ${emptyThreadId})`;
    yield* sql`DELETE FROM projection_projects WHERE project_id IN (${projectId}, ${emptyProjectId})`;
    yield* sql`DELETE FROM projection_spaces WHERE space_id = ${spaceId}`;
    yield* sql`
      INSERT INTO projection_spaces (
        space_id, name, icon, sort_order, created_at, updated_at, deleted_at
      ) VALUES (${spaceId}, 'Research', 'book', 0, ${now}, ${now}, NULL)
    `;
    yield* sql`
      INSERT INTO projection_projects (
        project_id, kind, title, workspace_root, default_model_selection_json,
        scripts_json, created_at, updated_at, deleted_at, space_id
      ) VALUES (
        ${projectId}, 'project', 'Kernel test', '/tmp/ctx-kernel', NULL,
        '[]', ${now}, ${now}, NULL, ${spaceId}
      )
    `;
    yield* sql`
      INSERT INTO projection_projects (
        project_id, kind, title, workspace_root, default_model_selection_json,
        scripts_json, created_at, updated_at, deleted_at, space_id
      ) VALUES (
        ${emptyProjectId}, 'project', 'Empty test', '/tmp/ctx-empty', NULL,
        '[]', ${now}, ${now}, NULL, NULL
      )
    `;
    yield* sql`
      INSERT INTO projection_threads (
        thread_id, project_id, title, model_selection_json, branch, worktree_path,
        latest_turn_id, created_at, updated_at, deleted_at
      ) VALUES (
        ${threadId}, ${projectId}, 'Kernel thread', '{"provider":"codex","model":"gpt-5.5"}',
        NULL, NULL, NULL, ${now}, ${now}, NULL
      )
    `;
    yield* sql`
      INSERT INTO projection_threads (
        thread_id, project_id, title, model_selection_json, branch, worktree_path,
        latest_turn_id, created_at, updated_at, deleted_at
      ) VALUES (
        ${emptyThreadId}, ${emptyProjectId}, 'Empty thread', '{"provider":"codex","model":"gpt-5.5"}',
        NULL, NULL, NULL, ${now}, ${now}, NULL
      )
    `;
  });

repoLayer("ContextRepository", (it) => {
  it.effect("persists atomic CAS saves, exact command results, and replay-safe revisions", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const repository = yield* ContextRepository;
      yield* seedRows(sql);

      const space = yield* repository.getSpace(spaceId);
      const firstDataInstanceId = space.dataInstanceId;
      assert.match(
        firstDataInstanceId,
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/u,
      );
      assert.strictEqual(
        (yield* repository.getProject(projectId)).dataInstanceId,
        firstDataInstanceId,
      );
      assert.deepStrictEqual(yield* repository.getThreadBinding(threadId), { mode: "legacy" });

      const saveId = CommandId.makeUnsafe("ctx-save-space-1");
      const save = event("context.space.save-requested", {
        commandId: saveId,
        dataInstanceId: firstDataInstanceId,
        spaceId,
        expectedRevision: 0,
        expectedName: "Research",
        expectedIcon: "book",
        name: "Research team",
        icon: "lab",
        directionGoal: "Build a reliable research tool.",
        sharedInstructions: "Keep raw source text intact.",
      });
      const committedSave = yield* prepareAndApply(repository, save);
      const saved = yield* repository.getCommandResult(saveId);
      assert.strictEqual(committedSave.type, "context.space.save-requested");
      if (committedSave.type === "context.space.save-requested") {
        assert.deepStrictEqual(committedSave.payload.result, saved);
      }
      assert.strictEqual(saved.status, "saved");
      assert.strictEqual(saved.space?.revision, 1);
      assert.strictEqual(saved.space?.name, "Research team");

      // Replaying the same event cannot replace its recorded success with a CAS conflict.
      yield* prepareAndApply(repository, committedSave);
      assert.deepStrictEqual(yield* repository.getCommandResult(saveId), saved);
      assert.strictEqual((yield* repository.getSpace(spaceId)).revision, 1);

      yield* sql`UPDATE projection_spaces SET name = 'Research team', icon = 'lab' WHERE space_id = ${spaceId}`;
      const metadataOnlyId = CommandId.makeUnsafe("ctx-save-space-metadata");
      yield* prepareAndApply(
        repository,
        event("context.space.save-requested", {
          commandId: metadataOnlyId,
          dataInstanceId: firstDataInstanceId,
          spaceId,
          expectedRevision: 1,
          expectedName: "Research team",
          expectedIcon: "lab",
          name: "Research group",
          icon: "book",
          directionGoal: "Build a reliable research tool.",
          sharedInstructions: "Keep raw source text intact.",
        }),
      );
      assert.strictEqual((yield* repository.getCommandResult(metadataOnlyId)).status, "saved");
      assert.strictEqual((yield* repository.getSpace(spaceId)).revision, 1);

      yield* sql`DELETE FROM context_command_results WHERE command_id = ${saveId}`;
      yield* sql`DELETE FROM context_spaces WHERE space_id = ${spaceId}`;
      yield* repository.applyEvent(committedSave);
      assert.deepStrictEqual(yield* repository.getCommandResult(saveId), saved);
      const replayedSpaceRow = yield* sql<{
        readonly directionGoal: string;
        readonly sharedInstructions: string;
        readonly revision: number;
      }>`
        SELECT direction_goal AS "directionGoal", shared_instructions AS "sharedInstructions", revision
        FROM context_spaces WHERE space_id = ${spaceId}
      `;
      assert.deepStrictEqual(replayedSpaceRow[0], {
        directionGoal: "Build a reliable research tool.",
        sharedInstructions: "Keep raw source text intact.",
        revision: 1,
      });

      const conflictId = CommandId.makeUnsafe("ctx-save-project-conflict");
      yield* prepareAndApply(
        repository,
        event("context.project.save-requested", {
          commandId: conflictId,
          dataInstanceId: firstDataInstanceId,
          projectId,
          expectedRevision: 9,
          projectGoal: "Should not commit",
          projectInstructions: "Should not commit",
        }),
      );
      assert.strictEqual((yield* repository.getCommandResult(conflictId)).status, "conflict");

      const foreignId = CommandId.makeUnsafe("ctx-save-foreign-instance");
      yield* prepareAndApply(
        repository,
        event("context.project.save-requested", {
          commandId: foreignId,
          dataInstanceId: "00000000-0000-4000-a000-000000000000",
          projectId,
          expectedRevision: 0,
          projectGoal: "Rejected",
          projectInstructions: "Rejected",
        }),
      );
      assert.strictEqual((yield* repository.getCommandResult(foreignId)).status, "rejected");

      const rollbackId = CommandId.makeUnsafe("ctx-save-rollback");
      const rollbackEvent = event("context.project.save-requested", {
        commandId: rollbackId,
        dataInstanceId: firstDataInstanceId,
        projectId,
        expectedRevision: 0,
        projectGoal: "Must roll back.",
        projectInstructions: "Must roll back.",
      });
      yield* sql
        .withTransaction(
          Effect.gen(function* () {
            yield* prepareAndApply(repository, rollbackEvent);
            return yield* Effect.fail(new Error("rollback transaction"));
          }),
        )
        .pipe(Effect.catch(() => Effect.void));
      assert.strictEqual((yield* repository.getCommandResult(rollbackId)).status, "unknown");
      assert.strictEqual((yield* repository.getProject(projectId)).revision, 0);

      const retryCommandId = CommandId.makeUnsafe("ctx-retry-ack-lost");
      yield* sql`
        INSERT INTO orchestration_consumer_state (
          consumer_name, last_acked_sequence, created_at, updated_at
        ) VALUES ('provider-command-reactor.v1', 0, ${now}, ${now})
        ON CONFLICT (consumer_name) DO NOTHING
      `;
      yield* sql`
        INSERT INTO orchestration_event_deliveries (
          consumer_name, event_sequence, thread_id, state, attempt_count, updated_at
        ) VALUES ('provider-command-reactor.v1', 999, ${threadId}, 'retry', 1, ${now})
      `;
      yield* sql`
        INSERT INTO provider_delivery_reconciliations (
          reconciliation_id, consumer_name, event_sequence, thread_id,
          previous_state, outcome, reconciled_by, note, reconciled_at
        ) VALUES (
          ${`context-retry:${retryCommandId}`}, 'provider-command-reactor.v1', 999,
          ${threadId}, 'uncertain', 'safe_retry', 'operator', NULL, ${now}
        )
      `;
      assert.deepStrictEqual(yield* repository.getCommandResult(retryCommandId), {
        commandId: retryCommandId,
        status: "saved",
      });
    }),
  );

  it.effect("claims exact legacy source bytes and resolves without losing project goal", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const repository = yield* ContextRepository;
      yield* seedRows(sql);
      const initial = yield* repository.getProject(projectId);
      const dataInstanceId = initial.dataInstanceId;
      yield* prepareAndApply(
        repository,
        event("context.project.save-requested", {
          commandId: CommandId.makeUnsafe("ctx-save-goal-first"),
          dataInstanceId,
          projectId,
          expectedRevision: 0,
          projectGoal: "Preserve this goal.",
          projectInstructions: "Existing edited instructions.",
        }),
      );

      const legacyInstructions = "legacy bytes\nwith trailing whitespace \n";
      const sourceDigest = createHash("sha256").update(legacyInstructions, "utf8").digest("hex");
      const claimId = CommandId.makeUnsafe("ctx-claim-legacy");
      yield* prepareAndApply(
        repository,
        event("context.migration.claim-requested", {
          commandId: claimId,
          dataInstanceId,
          projectId,
          expectedWorkspaceRoot: "/tmp/ctx-kernel",
          sourceDigest,
          legacyInstructions,
        }),
      );
      const claim = yield* repository.getCommandResult(claimId);
      assert.strictEqual(claim.status, "saved");
      assert.strictEqual(claim.migration?.status, "conflict");
      assert.strictEqual(claim.migration?.sourceDigest, sourceDigest);

      const repeatedClaimId = CommandId.makeUnsafe("ctx-claim-legacy-repeat");
      yield* prepareAndApply(
        repository,
        event("context.migration.claim-requested", {
          commandId: repeatedClaimId,
          dataInstanceId,
          projectId,
          expectedWorkspaceRoot: "/tmp/ctx-kernel",
          sourceDigest,
          legacyInstructions,
        }),
      );
      const repeatedClaim = yield* repository.getCommandResult(repeatedClaimId);
      assert.strictEqual(repeatedClaim.status, "saved");
      assert.deepStrictEqual(repeatedClaim.migration, claim.migration);
      assert.strictEqual(repeatedClaim.project?.revision, 1);

      const foreignInstanceClaimId = CommandId.makeUnsafe("ctx-claim-foreign-instance");
      yield* prepareAndApply(
        repository,
        event("context.migration.claim-requested", {
          commandId: foreignInstanceClaimId,
          dataInstanceId: "00000000-0000-4000-a000-000000000000",
          projectId,
          expectedWorkspaceRoot: "/tmp/ctx-kernel",
          sourceDigest,
          legacyInstructions,
        }),
      );
      assert.strictEqual(
        (yield* repository.getCommandResult(foreignInstanceClaimId)).status,
        "rejected",
      );

      const wrongRootId = CommandId.makeUnsafe("ctx-claim-wrong-root");
      yield* prepareAndApply(
        repository,
        event("context.migration.claim-requested", {
          commandId: wrongRootId,
          dataInstanceId,
          projectId: ProjectId.makeUnsafe("ctx-empty-project"),
          expectedWorkspaceRoot: "/tmp/not-the-project",
          sourceDigest,
          legacyInstructions,
        }),
      );
      assert.strictEqual((yield* repository.getCommandResult(wrongRootId)).status, "rejected");

      const staleResolveId = CommandId.makeUnsafe("ctx-resolve-stale-revision");
      yield* prepareAndApply(
        repository,
        event("context.migration.resolve-requested", {
          commandId: staleResolveId,
          dataInstanceId,
          projectId,
          sourceDigest,
          expectedRevision: 0,
          choice: "use_legacy",
        }),
      );
      assert.strictEqual((yield* repository.getCommandResult(staleResolveId)).status, "conflict");

      const changedTextResolveId = CommandId.makeUnsafe("ctx-resolve-untrusted-text");
      yield* prepareAndApply(
        repository,
        event("context.migration.resolve-requested", {
          commandId: changedTextResolveId,
          dataInstanceId,
          projectId,
          sourceDigest,
          expectedRevision: 1,
          choice: "use_legacy",
          instructions: "different raw text",
        }),
      );
      assert.strictEqual(
        (yield* repository.getCommandResult(changedTextResolveId)).status,
        "rejected",
      );

      const resolveId = CommandId.makeUnsafe("ctx-resolve-legacy");
      yield* prepareAndApply(
        repository,
        event("context.migration.resolve-requested", {
          commandId: resolveId,
          dataInstanceId,
          projectId,
          sourceDigest,
          expectedRevision: 1,
          choice: "use_legacy",
          instructions: legacyInstructions,
        }),
      );
      const resolved = yield* repository.getCommandResult(resolveId);
      assert.strictEqual(resolved.status, "saved");
      assert.strictEqual(resolved.project?.projectGoal, "Preserve this goal.");
      assert.strictEqual(resolved.project?.projectInstructions, legacyInstructions);
      assert.strictEqual(resolved.project?.revision, 2);
      assert.strictEqual(resolved.migration?.status, "completed");
      assert.strictEqual(resolved.migration?.choice, "use_legacy");
    }),
  );

  it.effect("replays frozen migration receipts after relocation and later Project edits", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const repository = yield* ContextRepository;
      yield* seedRows(sql);
      const initialProject = yield* repository.getProject(projectId);
      const dataInstanceId = initialProject.dataInstanceId;

      yield* prepareAndApply(
        repository,
        event("context.project.save-requested", {
          commandId: CommandId.makeUnsafe("ctx-migration-replay-initial-save"),
          dataInstanceId,
          projectId,
          expectedRevision: 0,
          projectGoal: "Goal at migration time.",
          projectInstructions: "Saved instructions before migration.",
        }),
      );

      const legacyInstructions = "legacy bytes\nwith trailing space \n";
      const sourceDigest = createHash("sha256").update(legacyInstructions, "utf8").digest("hex");
      const claimEvent = yield* prepareAndApply(
        repository,
        event("context.migration.claim-requested", {
          commandId: CommandId.makeUnsafe("ctx-migration-replay-claim"),
          dataInstanceId,
          projectId,
          expectedWorkspaceRoot: "/tmp/ctx-kernel",
          sourceDigest,
          legacyInstructions,
        }),
      );
      const claimReceipt = yield* repository.getCommandResult(
        CommandId.makeUnsafe("ctx-migration-replay-claim"),
      );
      assert.strictEqual(claimReceipt.status, "saved");
      assert.strictEqual(claimReceipt.migration?.status, "conflict");

      const resolveEvent = yield* prepareAndApply(
        repository,
        event("context.migration.resolve-requested", {
          commandId: CommandId.makeUnsafe("ctx-migration-replay-resolve"),
          dataInstanceId,
          projectId,
          sourceDigest,
          expectedRevision: 1,
          choice: "use_legacy",
          instructions: legacyInstructions,
        }),
      );
      const resolveReceipt = yield* repository.getCommandResult(
        CommandId.makeUnsafe("ctx-migration-replay-resolve"),
      );
      assert.strictEqual(resolveReceipt.status, "saved");
      assert.strictEqual(resolveReceipt.project?.projectGoal, "Goal at migration time.");
      assert.strictEqual(resolveReceipt.project?.projectInstructions, legacyInstructions);
      assert.strictEqual(resolveReceipt.project?.revision, 2);
      assert.strictEqual(resolveReceipt.migration?.status, "completed");

      const laterSaveEvent = yield* prepareAndApply(
        repository,
        event("context.project.save-requested", {
          commandId: CommandId.makeUnsafe("ctx-migration-replay-later-save"),
          dataInstanceId,
          projectId,
          expectedRevision: 2,
          projectGoal: "Goal from the later edit.",
          projectInstructions: "Instructions from the later edit.",
        }),
      );
      const laterSaveReceipt = yield* repository.getCommandResult(
        CommandId.makeUnsafe("ctx-migration-replay-later-save"),
      );

      // Rebuild the Context projection after the owning workspace has moved. The journal results
      // must restore the original migration decision, followed by the later committed edit.
      yield* sql`DELETE FROM context_projects WHERE project_id = ${projectId}`;
      yield* sql`DELETE FROM context_migrations WHERE project_id = ${projectId}`;
      yield* sql`DELETE FROM context_command_results`;
      yield* sql`UPDATE projection_projects SET workspace_root = '/tmp/ctx-moved' WHERE project_id = ${projectId}`;

      yield* repository.applyEvent(claimEvent);
      yield* repository.applyEvent(resolveEvent);
      yield* repository.applyEvent(laterSaveEvent);

      assert.deepStrictEqual(
        yield* repository.getCommandResult(CommandId.makeUnsafe("ctx-migration-replay-claim")),
        claimReceipt,
      );
      assert.deepStrictEqual(
        yield* repository.getCommandResult(CommandId.makeUnsafe("ctx-migration-replay-resolve")),
        resolveReceipt,
      );
      assert.deepStrictEqual(
        yield* repository.getCommandResult(CommandId.makeUnsafe("ctx-migration-replay-later-save")),
        laterSaveReceipt,
      );
      assert.deepStrictEqual(yield* repository.getProject(projectId), {
        ...laterSaveReceipt.project,
        workspaceRoot: "/tmp/ctx-moved",
      });
      assert.strictEqual(
        (yield* repository.getProject(projectId)).projectGoal,
        "Goal from the later edit.",
      );
      assert.strictEqual(
        (yield* repository.getProject(projectId)).projectInstructions,
        "Instructions from the later edit.",
      );
      assert.strictEqual((yield* repository.getProject(projectId)).revision, 3);
      assert.strictEqual((yield* repository.getProject(projectId)).migration?.status, "completed");
      assert.strictEqual((yield* repository.getProject(projectId)).migration?.choice, "use_legacy");
    }),
  );

  it.effect("rejects migration replay events without a frozen result", () =>
    Effect.gen(function* () {
      const repository = yield* ContextRepository;
      yield* seedRows(yield* SqlClient.SqlClient);
      const unpreparedClaim = event("context.migration.claim-requested", {
        commandId: CommandId.makeUnsafe("ctx-migration-missing-result"),
        dataInstanceId: (yield* repository.getProject(projectId)).dataInstanceId,
        projectId,
        expectedWorkspaceRoot: "/tmp/ctx-kernel",
        sourceDigest: "0".repeat(64),
        legacyInstructions: "legacy",
      });
      const missingResult = yield* Effect.result(repository.applyEvent(unpreparedClaim));
      assert.strictEqual(missingResult._tag, "Failure");
      if (missingResult._tag === "Failure") {
        assert.match(missingResult.failure.message, /frozen command result/u);
      }
    }),
  );

  it.effect("replays first-bind snapshots without depending on projection_threads", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const repository = yield* ContextRepository;
      yield* seedRows(sql);
      yield* repository.applyEvent(
        event("context.thread.binding-set", { threadId, mode: "unbound" }),
      );
      const unpreparedBindEvent = event("context.thread.bind-requested", {
        threadId,
        createdAt: now,
      }) as Extract<ContextEvent, { type: "context.thread.bind-requested" }>;
      const preparedBindEvent = yield* repository.prepareBinding(unpreparedBindEvent);
      const bindEvent = {
        ...preparedBindEvent,
        sequence: unpreparedBindEvent.sequence,
      } as Extract<ContextEvent, { type: "context.thread.bind-requested" }>;
      yield* sql`DELETE FROM projection_threads WHERE thread_id = ${threadId}`;

      yield* repository.applyEvent(bindEvent);
      const bindings = yield* sql<{ readonly mode: string; readonly snapshotJson: string | null }>`
        SELECT mode, snapshot_json AS "snapshotJson"
        FROM context_thread_bindings WHERE thread_id = ${threadId}
      `;
      assert.strictEqual(bindings[0]?.mode, "bound");
      assert.deepStrictEqual(
        JSON.parse(bindings[0]?.snapshotJson ?? "null"),
        bindEvent.payload.snapshot,
      );

      const corruptedBindEvent = {
        ...bindEvent,
        payload: {
          ...bindEvent.payload,
          snapshot: { ...bindEvent.payload.snapshot!, snapshotHash: "0".repeat(64) },
        },
      } as Extract<ContextEvent, { type: "context.thread.bind-requested" }>;
      const invalidSnapshot = yield* Effect.result(repository.applyEvent(corruptedBindEvent));
      assert.strictEqual(invalidSnapshot._tag, "Failure");
    }),
  );

  it.effect("binds an immutable snapshot on first admission, including an empty snapshot", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const repository = yield* ContextRepository;
      yield* seedRows(sql);
      const dataInstanceId = (yield* repository.getProject(projectId)).dataInstanceId;
      yield* prepareAndApply(
        repository,
        event("context.space.save-requested", {
          commandId: CommandId.makeUnsafe("ctx-space-for-bind"),
          dataInstanceId,
          spaceId,
          expectedRevision: 0,
          expectedName: "Research",
          expectedIcon: "book",
          name: "Research",
          icon: "book",
          directionGoal: "First project direction.",
          sharedInstructions: "First shared instructions.",
        }),
      );
      yield* prepareAndApply(
        repository,
        event("context.project.save-requested", {
          commandId: CommandId.makeUnsafe("ctx-project-for-bind"),
          dataInstanceId,
          projectId,
          expectedRevision: 0,
          projectGoal: "First project goal.",
          projectInstructions: "First project instructions.",
        }),
      );
      yield* repository.applyEvent(
        event("context.thread.binding-set", {
          threadId,
          mode: "unbound",
        }),
      );
      const unpreparedBindEvent = event("context.thread.bind-requested", {
        threadId,
        createdAt: now,
      });
      const committedBindEvent = yield* prepareAndApply(repository, unpreparedBindEvent);
      const binding = yield* repository.getThreadBinding(threadId);
      assert.strictEqual(binding?.mode, "bound");
      assert.strictEqual(binding?.snapshot?.project.projectGoal, "First project goal.");
      const session = yield* repository.getContextSession(threadId);
      assert.strictEqual(session?.hasContent, true);
      assert.include(session?.text ?? "", "First shared instructions.");

      yield* sql`UPDATE projection_spaces SET name = 'Renamed only', icon = 'home' WHERE space_id = ${spaceId}`;
      yield* sql`UPDATE projection_projects SET title = 'Retitled only', workspace_root = '/tmp/renamed-only' WHERE project_id = ${projectId}`;
      assert.notStrictEqual(
        (yield* repository.getPreview(projectId)).snapshotHash,
        binding?.snapshot?.snapshotHash,
      );
      assert.strictEqual((yield* repository.getThreadDetails(threadId)).hasNewVersion, false);

      const projectAfterBindCommandId = CommandId.makeUnsafe("ctx-project-after-bind-replay");
      const projectAfterBindEvent = event("context.project.save-requested", {
        commandId: projectAfterBindCommandId,
        dataInstanceId,
        projectId,
        expectedRevision: 1,
        projectGoal: "Changed after binding.",
        projectInstructions: "Changed instructions.",
      });
      const committedProjectAfterBind = yield* prepareAndApply(repository, projectAfterBindEvent);
      assert.strictEqual(
        (yield* repository.getCommandResult(projectAfterBindCommandId)).status,
        "saved",
      );
      const afterEdit = yield* repository.getThreadBinding(threadId);
      assert.deepStrictEqual(afterEdit, binding);
      assert.notStrictEqual(
        (yield* repository.getPreview(projectId)).snapshotHash,
        binding?.snapshot?.snapshotHash,
      );

      yield* sql`
        UPDATE projection_spaces
        SET name = 'Renamed source', icon = 'home', deleted_at = NULL
        WHERE space_id = ${spaceId}
      `;
      yield* sql`
        UPDATE projection_projects
        SET title = 'Moved source', workspace_root = '/tmp/moved-source', space_id = NULL
        WHERE project_id = ${projectId}
      `;
      yield* sql`UPDATE context_spaces SET direction_goal = 'Changed source text.' WHERE space_id = ${spaceId}`;
      yield* sql`UPDATE context_projects SET project_goal = 'Changed source goal.' WHERE project_id = ${projectId}`;
      const changedPreview = yield* repository.getPreview(projectId);
      assert.notStrictEqual(changedPreview.snapshotHash, binding?.snapshot?.snapshotHash);

      // Rebuild just the context projection from journal events after source metadata and text changed.
      yield* sql`DELETE FROM context_thread_bindings WHERE thread_id = ${threadId}`;
      yield* repository.applyEvent(
        event("context.thread.binding-set", { threadId, mode: "unbound" }),
      );
      yield* repository.applyEvent(committedBindEvent);
      assert.deepStrictEqual(yield* repository.getThreadBinding(threadId), binding);
      assert.strictEqual(
        (yield* repository.getContextSession(threadId))?.snapshotHash,
        binding?.snapshot?.snapshotHash,
      );

      yield* sql`UPDATE projection_spaces SET deleted_at = ${now} WHERE space_id = ${spaceId}`;
      const afterSpaceDelete = yield* repository.getThreadDetails(threadId);
      assert.strictEqual(afterSpaceDelete.snapshot?.snapshotId, binding?.snapshot?.snapshotId);
      assert.strictEqual(afterSpaceDelete.hasNewVersion, true);
      yield* sql`DELETE FROM projection_projects WHERE project_id = ${projectId}`;
      const afterProjectDelete = yield* repository.getThreadDetails(threadId);
      assert.strictEqual(afterProjectDelete.snapshot?.snapshotId, binding?.snapshot?.snapshotId);
      assert.strictEqual(afterProjectDelete.preview, null);
      assert.match(afterProjectDelete.error ?? "", /could not be compared/u);

      yield* sql`DELETE FROM context_thread_bindings WHERE thread_id = ${threadId}`;
      yield* repository.applyEvent(
        event("context.thread.binding-set", { threadId, mode: "unbound" }),
      );
      yield* repository.applyEvent(committedBindEvent);
      assert.deepStrictEqual(yield* repository.getThreadBinding(threadId), binding);

      // The event journal alone can restore both the committed result and its text/revision.
      yield* sql`DELETE FROM context_command_results WHERE command_id = ${projectAfterBindCommandId}`;
      yield* repository.applyEvent(committedProjectAfterBind);
      const replayedSaveResult = yield* repository.getCommandResult(projectAfterBindCommandId);
      assert.strictEqual(replayedSaveResult.status, "saved");
      assert.strictEqual(replayedSaveResult.project?.projectGoal, "Changed after binding.");
      assert.strictEqual(replayedSaveResult.project?.revision, 2);
      const replayedProjectRow = yield* sql<{
        readonly projectGoal: string;
        readonly projectInstructions: string;
        readonly revision: number;
      }>`
        SELECT project_goal AS "projectGoal", project_instructions AS "projectInstructions", revision
        FROM context_projects WHERE project_id = ${projectId}
      `;
      assert.deepStrictEqual(replayedProjectRow[0], {
        projectGoal: "Changed after binding.",
        projectInstructions: "Changed instructions.",
        revision: 2,
      });

      yield* repository.applyEvent(
        event("context.thread.binding-set", {
          threadId: emptyThreadId,
          mode: "unbound",
        }),
      );
      yield* prepareAndApply(
        repository,
        event("context.thread.bind-requested", {
          threadId: emptyThreadId,
          createdAt: now,
        }),
      );
      const emptySession = yield* repository.getContextSession(emptyThreadId);
      assert.deepStrictEqual(emptySession, {
        snapshotId: (yield* repository.getThreadBinding(emptyThreadId))?.snapshot?.snapshotId,
        snapshotHash: (yield* repository.getThreadBinding(emptyThreadId))?.snapshot?.snapshotHash,
        text: "",
        hasContent: false,
      });
    }),
  );
});
