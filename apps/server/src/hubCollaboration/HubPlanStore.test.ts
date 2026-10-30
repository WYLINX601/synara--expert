import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ProjectId, ProjectTaskAttemptId, ThreadId } from "@synara/contracts";

import { runMigrations } from "../persistence/Migrations.ts";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";
import {
  runWorkbenchMigrations,
  workbenchMigrationEntries,
} from "../workbench/persistence/WorkbenchMigrations.ts";
import { hubPlanInputResponseDigest, hubPlanInputResponseIdentity } from "./hubPlanInput.ts";
import {
  HubPlanStoreConflictError,
  HubPlanStoreIdempotencyError,
  HubPlanStoreInvariantError,
  makeHubPlanStore,
  type PlanRecord,
} from "./HubPlanStore.ts";

const layer = it.layer(NodeSqliteClient.layerMemory());
const now = "2026-10-22T10:00:00.000Z";

const definition = {
  objective: "Produce a reviewed result",
  scope: "One bounded work package",
  stages: [{ key: "draft", title: "Draft", releasePolicy: "auto" }],
  nodes: [
    {
      key: "author",
      stageKey: "draft",
      title: "Author",
      brief: "Prepare the candidate",
      role: "author",
      dependsOnNodeKeys: [],
      workMode: "agent",
      acceptanceCriteria: "The result is complete",
    },
    {
      key: "reviewer",
      stageKey: "draft",
      title: "Reviewer",
      brief: "Review the candidate",
      role: "reviewer",
      dependsOnNodeKeys: ["author"],
      workMode: "agent",
      acceptanceCriteria: "The result meets the criteria",
    },
  ],
  maxRepairRounds: 2,
} as const;

const basePlan: PlanRecord = {
  id: "plan-store-test",
  hubId: "hub-plan-store-test",
  goalId: null,
  revision: 1,
  stateVersion: 0,
  controlState: "draft",
  definition,
  configSnapshot: {
    configRevision: 3,
    settings: { schemaVersion: 1, mode: "expert-team" },
    expertIds: ["architect", "reviewer"],
  },
  stageGenerations: { draft: 0 },
  sourceMessageIds: ["human-message-1"],
  createdAt: now,
  updatedAt: now,
};

const seedNativeTasks = (
  sql: SqlClient.SqlClient,
  options: { readonly hubId?: string; readonly fixtureKey?: string } = {},
) =>
  Effect.gen(function* () {
    const hubId = options.hubId ?? basePlan.hubId;
    const fixtureKey = options.fixtureKey ?? "plan-store";
    const goalId = `${fixtureKey}-goal`;
    const taskAuthorId = fixtureKey === "plan-store" ? "task-author" : `${fixtureKey}-task-author`;
    const taskReviewerId =
      fixtureKey === "plan-store" ? "task-reviewer" : `${fixtureKey}-task-reviewer`;
    const attemptId = `${fixtureKey}-attempt-author-1`;
    const workItemId = `${fixtureKey}-work-author-1`;
    yield* sql`
      INSERT INTO projection_projects (
        project_id, title, workspace_root, scripts_json, created_at, updated_at
      ) VALUES (${hubId}, 'Plan Hub', '/tmp/plan-hub', '[]', ${now}, ${now})
    `;
    yield* sql`
      INSERT INTO project_agent_configs (
        project_id, coordinator_thread_id, coordinator_name,
        coordinator_model_selection_json, limits_json, capture_enabled,
        enabled, revision, created_at, updated_at, disabled_at
      ) VALUES (
        ${hubId}, ${`${fixtureKey}-coordinator`}, 'Coordinator', '{}', '{}',
        1, 1, 1, ${now}, ${now}, NULL
      )
    `;
    yield* sql`
      INSERT INTO project_agent_goals (
        goal_id, project_id, objective, authorization_source, scope_version,
        acceptance_criteria, limits_json, status, continuation_count,
        worker_creation_count, authorized_at, revision, created_at, updated_at
      ) VALUES (
        ${goalId}, ${hubId}, 'Plan goal', 'human', 1,
        'Complete plan work', '{}', 'active', 0, 0, ${now}, 1, ${now}, ${now}
      )
    `;
    for (const taskId of [taskAuthorId, taskReviewerId]) {
      yield* sql`
        INSERT INTO project_agent_tasks (
          task_id, project_id, goal_id, title, description, acceptance_criteria,
          status, assigned_thread_id, repair_count, archived_at, revision,
          created_at, updated_at
        ) VALUES (
          ${taskId}, ${hubId}, ${goalId}, ${taskId}, NULL,
          'Complete task', 'planned', NULL, 0, NULL, 1, ${now}, ${now}
        )
      `;
    }
    yield* sql`
      INSERT INTO project_agent_task_attempts (
        attempt_id, project_id, task_id, worker_thread_id, gateway_operation_id,
        request_id, attempt_number, outcome, error, created_at, finished_at
      ) VALUES (
        ${attemptId}, ${hubId}, ${taskAuthorId}, ${`${fixtureKey}-thread-author`},
        NULL, ${`${fixtureKey}-request-author-1`}, 1, 'started', NULL, ${now}, NULL
      )
    `;
    yield* sql`
      INSERT INTO project_agent_work_items (
        work_item_id, project_id, scope_key, task_index, state, worker_thread_id,
        slot_held, revision, record_json
      ) VALUES (
        ${workItemId}, ${hubId}, ${fixtureKey}, 1, 'running',
        ${`${fixtureKey}-thread-author`}, 1, 1, '{}'
      )
    `;
  });

layer("Hub plan store", (test) => {
  test.effect(
    "persists CAS plans, immutable revisions, bindings, facts and active-plan uniqueness",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations();
        yield* runWorkbenchMigrations();
        yield* seedNativeTasks(sql);
        const store = makeHubPlanStore(sql);

        const migrationRows = yield* sql<{
          readonly migrationId: number;
          readonly name: string;
        }>`
        SELECT migration_id AS "migrationId", name
        FROM workbench_sql_migrations
        WHERE module_id = 'expert'
        ORDER BY migration_id
      `;
        assert.strictEqual(migrationRows.length, workbenchMigrationEntries.length);
        assert.deepStrictEqual(migrationRows.at(-1), {
          migrationId: 11,
          name: "ExpertAutomaticLearning",
        });

        const created = yield* store.savePlan(basePlan, null);
        assert.deepStrictEqual(created, basePlan);
        const replay = yield* store.savePlan(basePlan, null);
        assert.deepStrictEqual(replay, basePlan);

        const active = {
          ...basePlan,
          goalId: "plan-store-goal",
          stateVersion: 1,
          controlState: "active" as const,
          configSnapshot: {
            ...basePlan.configSnapshot,
            expertSnapshots: [
              { expertId: "architect", snapshotId: "snapshot-architect", revision: 2 },
              { expertId: "reviewer", snapshotId: "snapshot-reviewer", revision: 5 },
            ],
          },
          updatedAt: "2026-10-22T10:01:00.000Z",
        };
        yield* store.savePlan(active, 0);
        assert.deepStrictEqual(yield* store.read({ planId: basePlan.id }), active);
        assert.deepStrictEqual(yield* store.read({ planId: basePlan.id, revision: 1 }), active);

        const inputRequest = {
          id: "input-request-1",
          planId: basePlan.id,
          revision: 1,
          nodeKey: "author",
          stageKey: "draft",
          generation: 1,
          attemptId: ProjectTaskAttemptId.makeUnsafe("plan-store-attempt-author-1"),
          workerThreadId: ThreadId.makeUnsafe("plan-store-thread-author"),
          questions: [{ title: "Which format?", options: ["Markdown", "PDF"] }],
          status: "pending" as const,
          createdAt: now,
          updatedAt: now,
        };
        assert.deepStrictEqual(yield* store.saveInputRequest(inputRequest), inputRequest);
        const answerBase = {
          ...inputRequest,
          status: "answered" as const,
          answers: ["Markdown"],
          updatedAt: "2026-10-22T10:02:00.000Z",
          responseCreatedAt: "2026-10-22T10:02:00.000Z",
          ...hubPlanInputResponseIdentity({ planId: basePlan.id, requestId: inputRequest.id }),
        };
        const answerRecord = {
          ...answerBase,
          responseMessageDigest: hubPlanInputResponseDigest(answerBase),
        };
        assert.deepStrictEqual(yield* store.saveInputRequest(answerRecord), answerRecord);
        assert.deepStrictEqual(
          yield* store.readInputRequest({ planId: basePlan.id, requestId: inputRequest.id }),
          answerRecord,
        );
        assert.deepStrictEqual(
          yield* store.listInputRequests({ planId: basePlan.id, revision: 1 }),
          [answerRecord],
        );

        const repeatedFreeze = yield* Effect.flip(
          store.savePlan(
            {
              ...active,
              stateVersion: 2,
              configSnapshot: {
                ...active.configSnapshot,
                expertSnapshots: [
                  { expertId: "architect", snapshotId: "changed-snapshot", revision: 3 },
                  { expertId: "reviewer", snapshotId: "snapshot-reviewer", revision: 5 },
                ],
              },
              updatedAt: "2026-10-22T10:01:30.000Z",
            },
            1,
          ),
        );
        assert.isTrue(repeatedFreeze instanceof HubPlanStoreInvariantError);

        const staleWrite = yield* Effect.flip(
          store.savePlan(
            {
              ...active,
              stateVersion: 2,
              controlState: "paused",
              updatedAt: "2026-10-22T10:02:00.000Z",
            },
            0,
          ),
        );
        assert.isTrue(staleWrite instanceof HubPlanStoreConflictError);
        assert.strictEqual((yield* store.read({ planId: basePlan.id }))?.stateVersion, 1);

        const activeConflict = yield* Effect.exit(
          store.savePlan(
            { ...basePlan, id: "second-active-plan", stateVersion: 0, controlState: "active" },
            null,
          ),
        );
        assert.isTrue(Exit.isFailure(activeConflict));

        const revised = {
          ...active,
          revision: 2,
          stateVersion: 2,
          definition: { ...definition, objective: "Produce a reviewed and released result" },
          updatedAt: "2026-10-22T10:03:00.000Z",
        };
        yield* store.savePlan(revised, 1);
        assert.deepStrictEqual(yield* store.read({ planId: basePlan.id, revision: 2 }), revised);
        assert.deepStrictEqual(
          (yield* store.list({ hubId: basePlan.hubId })).map(({ revision, stateVersion }) => [
            revision,
            stateVersion,
          ]),
          [[2, 2]],
        );

        const bindings = [
          {
            planId: basePlan.id,
            revision: 1,
            nodeKey: "author",
            taskId: "task-author",
            stageKey: "draft",
            role: "author" as const,
          },
          {
            planId: basePlan.id,
            revision: 1,
            nodeKey: "reviewer",
            taskId: "task-reviewer",
            stageKey: "draft",
            role: "reviewer" as const,
          },
        ];
        assert.deepStrictEqual(yield* store.saveBindings(bindings), bindings);
        assert.deepStrictEqual(yield* store.saveBindings(bindings), bindings);
        assert.deepStrictEqual(
          yield* store.listBindings({ planId: basePlan.id, revision: 1 }),
          bindings,
        );
        const attemptBinding = {
          id: "attempt-binding-1",
          planId: basePlan.id,
          revision: 1,
          nodeKey: "author",
          taskId: "task-author",
          attemptId: "plan-store-attempt-author-1",
          workItemId: "plan-store-work-author-1",
          stageGeneration: 0,
          createdAt: now,
        };
        assert.deepStrictEqual(yield* store.appendAttemptBinding(attemptBinding), attemptBinding);
        assert.deepStrictEqual(yield* store.listAttemptBindings({ planId: basePlan.id }), [
          attemptBinding,
        ]);
        assert.deepStrictEqual(
          yield* store.findAttemptBindingByWork({ workItemId: attemptBinding.workItemId }),
          attemptBinding,
        );
        assert.deepStrictEqual(
          yield* store.findAttemptBindingByThread({ threadId: "plan-store-thread-author" }),
          attemptBinding,
        );
        assert.strictEqual(
          yield* store.findAttemptBindingByWork({ workItemId: "unknown-work-item" }),
          null,
        );
        yield* sql`
          INSERT INTO project_agent_work_items (
            work_item_id, project_id, scope_key, task_index, state, worker_thread_id,
            slot_held, revision, record_json
          ) VALUES (
            'plan-store-work-reviewer-queued', ${basePlan.hubId}, 'plan-store-reviewer',
            2, 'queued', NULL, 0, 0, '{}'
          )
        `;
        const pendingAttemptBinding = {
          id: "attempt-binding-reviewer-pending",
          planId: basePlan.id,
          revision: 1,
          nodeKey: "reviewer",
          taskId: "task-reviewer",
          attemptId: "plan-store-attempt-reviewer-pending",
          workItemId: "plan-store-work-reviewer-queued",
          stageGeneration: 0,
          createdAt: now,
        };
        assert.deepStrictEqual(
          yield* store.appendAttemptBinding(pendingAttemptBinding),
          pendingAttemptBinding,
        );
        assert.deepStrictEqual(
          yield* store.findAttemptBindingByWork({
            workItemId: pendingAttemptBinding.workItemId,
          }),
          pendingAttemptBinding,
        );
        assert.strictEqual(
          yield* store.findAttemptBindingByThread({ threadId: "pending-reviewer-thread" }),
          null,
        );
        yield* sql`
          INSERT INTO project_agent_work_items (
            work_item_id, project_id, scope_key, task_index, state, worker_thread_id,
            slot_held, revision, record_json
          ) VALUES (
            'plan-store-work-author-retry', ${basePlan.hubId}, 'plan-store-author-retry',
            3, 'queued', NULL, 0, 0, '{}'
          )
        `;
        const retryAttemptBinding = {
          ...attemptBinding,
          id: "attempt-binding-author-retry",
          attemptId: "plan-store-attempt-author-retry",
          workItemId: "plan-store-work-author-retry",
          createdAt: "2026-10-22T10:01:00.000Z",
        };
        assert.deepStrictEqual(
          yield* store.appendAttemptBinding(retryAttemptBinding),
          retryAttemptBinding,
        );
        assert.deepStrictEqual(yield* store.listAttemptBindings({ planId: basePlan.id }), [
          attemptBinding,
          pendingAttemptBinding,
          retryAttemptBinding,
        ]);
        const reusedAttempt = yield* Effect.flip(
          store.appendAttemptBinding({
            ...retryAttemptBinding,
            id: "attempt-binding-author-retry-copy",
          }),
        );
        assert.isTrue(reusedAttempt instanceof HubPlanStoreIdempotencyError);

        const candidate = {
          planId: basePlan.id,
          id: "candidate-record-1",
          revision: 1,
          stageKey: "draft",
          generation: 0,
          candidateId: "candidate-1",
          outputDigest: "sha256:candidate",
          authorNodeKey: "author",
          authorAttemptId: "plan-store-attempt-author-1",
          summary: "Candidate summary",
          status: "current" as const,
          createdAt: now,
          deliverableRefs: [
            {
              hubId: ProjectId.makeUnsafe(basePlan.hubId),
              workerThreadId: ThreadId.makeUnsafe("thread-author"),
              revision: 1,
              commitSha: "a".repeat(40),
              provenance: {
                hubId: ProjectId.makeUnsafe(basePlan.hubId),
                workerThreadId: ThreadId.makeUnsafe("thread-author"),
                expertBindingSnapshotId: "snapshot-author",
                publishedAt: now,
              },
              file: {
                path: "result.md",
                libraryPath: "artifacts/result.md",
                name: "result.md",
                description: null,
                mediaType: "text/markdown" as const,
                sizeBytes: 1,
                sha256: "b".repeat(64),
              },
            },
          ],
        };
        assert.deepStrictEqual(yield* store.appendCandidate(candidate), candidate);
        assert.deepStrictEqual(yield* store.appendCandidate(candidate), candidate);
        const candidateReplay = yield* store.appendCandidate({
          ...candidate,
          id: "candidate-record-replay",
          candidateId: "candidate-replay",
          createdAt: "2026-10-22T10:01:00.000Z",
        });
        assert.deepStrictEqual(candidateReplay, candidate);
        const candidateConflict = yield* Effect.flip(
          store.appendCandidate({
            ...candidate,
            id: "candidate-record-conflict",
            candidateId: "candidate-conflict",
            summary: "Changed content",
          }),
        );
        assert.isTrue(candidateConflict instanceof HubPlanStoreIdempotencyError);
        assert.deepStrictEqual(yield* store.listCandidates({ planId: basePlan.id }), [candidate]);

        const review = {
          planId: basePlan.id,
          id: "review-record-1",
          revision: 1,
          stageKey: "draft",
          generation: 0,
          candidateId: "candidate-1",
          outputDigest: "sha256:candidate",
          reviewerNodeKey: "reviewer",
          attemptId: "attempt-review-1",
          outcome: "pass" as const,
          status: "submitted" as const,
          summary: "Review summary",
          createdAt: now,
        };
        const release = {
          planId: basePlan.id,
          id: "release-record-1",
          revision: 1,
          stageKey: "draft",
          generation: 0,
          candidateId: "candidate-1",
          outputDigest: "sha256:candidate",
          source: "auto" as const,
          effective: true,
          comment: "Release comment",
          createdAt: now,
        };
        yield* store.appendReview(review);
        yield* store.appendRelease(release);
        assert.deepStrictEqual(
          yield* store.appendReview({
            ...review,
            id: "review-record-replay",
            createdAt: "2026-10-22T10:01:00.000Z",
          }),
          review,
        );
        const reviewConflict = yield* Effect.flip(
          store.appendReview({ ...review, id: "review-record-conflict", summary: "Changed" }),
        );
        assert.isTrue(reviewConflict instanceof HubPlanStoreIdempotencyError);
        assert.deepStrictEqual(yield* store.listReviews({ planId: basePlan.id }), [review]);
        assert.deepStrictEqual(yield* store.listReleases({ planId: basePlan.id }), [release]);
      }),
  );

  test.effect("commits durable events, receipts and outbox items atomically", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      yield* runWorkbenchMigrations();
      const eventPlan = { ...basePlan, id: "plan-events-test", hubId: "hub-plan-events-test" };
      yield* seedNativeTasks(sql, { hubId: eventPlan.hubId, fixtureKey: "events" });
      const store = makeHubPlanStore(sql);
      yield* store.savePlan(eventPlan, null);
      assert.strictEqual(
        yield* store.readLatestEventSequence({ hubId: eventPlan.hubId, planId: eventPlan.id }),
        0,
      );

      const firstEvent = yield* store.appendEvent({
        planId: eventPlan.id,
        hubId: eventPlan.hubId,
        kind: "plan.created",
        payload: { revision: 1 },
        createdAt: now,
      });
      const secondEvent = yield* store.appendEvent({
        planId: eventPlan.id,
        hubId: eventPlan.hubId,
        kind: "plan.activated",
        payload: { stateVersion: 1 },
        createdAt: "2026-10-22T10:01:00.000Z",
      });
      assert.isAbove(secondEvent.sequence, firstEvent.sequence);
      assert.strictEqual(
        yield* store.readLatestEventSequence({ hubId: eventPlan.hubId, planId: eventPlan.id }),
        secondEvent.sequence,
      );
      assert.strictEqual(
        yield* store.readLatestEventSequence({ hubId: eventPlan.hubId }),
        secondEvent.sequence,
      );
      assert.deepStrictEqual(
        yield* store.readEvents({ afterSequence: firstEvent.sequence, planId: eventPlan.id }),
        [secondEvent],
      );

      const receipt = {
        hubId: eventPlan.hubId,
        requestId: "plan-command-1",
        digest: "sha256:command",
        resultJson: '{"accepted":true}',
      };
      assert.deepStrictEqual(yield* store.writeReceipt(receipt), receipt);
      assert.deepStrictEqual(yield* store.writeReceipt(receipt), receipt);
      assert.deepStrictEqual(
        yield* store.readReceipt({ hubId: receipt.hubId, requestId: receipt.requestId }),
        receipt,
      );

      const outbox = {
        id: "dispatch-envelope-1",
        planId: eventPlan.id,
        kind: "dispatch.requested",
        payload: { taskId: "task-author" },
        createdAt: now,
      };
      const queued = yield* store.enqueue(outbox);
      assert.strictEqual(queued.status, "pending");
      assert.deepStrictEqual(yield* store.readPending({ planId: eventPlan.id }), [queued]);
      assert.strictEqual((yield* store.markDelivered({ id: outbox.id }))?.status, "delivered");
      assert.deepStrictEqual(yield* store.readPending({ planId: eventPlan.id }), []);

      const rollback = yield* Effect.exit(
        store.transaction(
          Effect.gen(function* () {
            yield* store.appendEvent({
              planId: eventPlan.id,
              hubId: eventPlan.hubId,
              kind: "plan.must_rollback",
              payload: {},
              createdAt: "2026-10-22T10:02:00.000Z",
            });
            yield* store.writeReceipt({
              hubId: eventPlan.hubId,
              requestId: "plan-command-rollback",
              digest: "sha256:rollback",
              resultJson: "{}",
            });
            yield* store.enqueue({
              id: "dispatch-rollback",
              planId: eventPlan.id,
              kind: "dispatch.requested",
              payload: {},
              createdAt: "2026-10-22T10:02:00.000Z",
            });
            return yield* Effect.fail(new Error("force rollback"));
          }),
        ),
      );
      assert.isTrue(Exit.isFailure(rollback));
      assert.strictEqual(
        (yield* store.readEvents({ planId: eventPlan.id })).filter(
          ({ kind }) => kind === "plan.must_rollback",
        ).length,
        0,
      );
      assert.strictEqual(
        yield* store.readReceipt({ hubId: eventPlan.hubId, requestId: "plan-command-rollback" }),
        null,
      );
      assert.deepStrictEqual(yield* store.readPending({ planId: eventPlan.id }), []);
      const receiptConflict = yield* Effect.flip(
        store.writeReceipt({ ...receipt, digest: "sha256:different" }),
      );
      assert.isTrue(receiptConflict instanceof HubPlanStoreIdempotencyError);
    }),
  );
});
