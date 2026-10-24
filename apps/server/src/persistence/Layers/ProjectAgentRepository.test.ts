import {
  ProjectActivityId,
  ProjectGoalId,
  ProjectId,
  ProjectInboxEventId,
  ProjectTaskAttemptId,
  ProjectTaskId,
  ProjectDocumentRevisionId,
  ThreadId,
} from "@synara/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Exit, Layer, Option } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ProjectAgentRepository } from "../Services/ProjectAgentRepository.ts";
import { ProjectAgentRepositoryLive } from "./ProjectAgentRepository.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";

const layer = it.layer(
  ProjectAgentRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

const projectId = ProjectId.makeUnsafe("project-coord-1");
const coordinatorThreadId = ThreadId.makeUnsafe("thread-coordinator");
const now = "2026-09-15T12:00:00.000Z";
const limits = {
  maxConcurrentWorkers: 2,
  maxNewWorkersPerTurn: 4,
  maxWorkerCreationsPerGoal: 12,
  maxAutomaticContinuationsPerGoal: 20,
  maxRepairRoundsPerTask: 2,
};

layer("ProjectAgentRepository", (it) => {
  it.effect(
    "monitor settlement preserves concurrently accepted results even at the same timestamp",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const repository = yield* ProjectAgentRepository;
        const threadId = ThreadId.makeUnsafe("thread-sql-monitor-result-race");
        yield* sql`
        INSERT INTO project_agent_managed_workers
          (project_id, thread_id, batch_id, request_id, title, created_at, updated_at)
        VALUES (${projectId}, ${threadId}, 'batch-race', 'work-race', 'Monitor race', ${now}, ${now})
      `;
        const stale = Option.getOrThrow(yield* repository.findManagedWorkerByThread(threadId));
        // An accepted plan result commits after the monitor read, within the same millisecond.
        yield* sql`UPDATE project_agent_managed_workers
        SET result_summary = 'Accepted candidate', result_at = ${now}
        WHERE thread_id = ${threadId}`;
        const update = { ...stale, settledAt: now, settleOutcome: "completed" as const };
        const saved = yield* repository.saveManagedWorkerMonitor({
          worker: update,
          expectedUpdatedAt: now,
          preserveResultEvidence: true,
        });
        assert.isTrue(saved.applied);
        const accepted = Option.getOrThrow(yield* repository.findManagedWorkerByThread(threadId));
        assert.equal(accepted.resultSummary, "Accepted candidate");
        assert.equal(accepted.resultAt, now);
        assert.equal(accepted.settleOutcome, "completed");
        // Recovery callers that intentionally clear evidence retain the previous default behavior.
        yield* repository.saveManagedWorkerMonitor({ worker: update, expectedUpdatedAt: now });
        const cleared = Option.getOrThrow(yield* repository.findManagedWorkerByThread(threadId));
        assert.isNull(cleared.resultSummary);
        assert.isNull(cleared.resultAt);
      }),
  );

  it.effect("CAS config writes reject stale revisions", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectAgentRepository;
      const config = {
        projectId,
        coordinatorThreadId,
        coordinatorName: "Demo Coordinator",
        coordinatorModelSelection: { provider: "codex" as const, model: "gpt-5-codex" },
        limits,
        captureEnabled: true,
        enabled: true,
        automationId: null,
        revision: 1,
        createdAt: now,
        updatedAt: now,
        disabledAt: null,
      };
      yield* repository.saveConfig(config, null);
      const stale = yield* Effect.exit(
        repository.saveConfig(
          { ...config, revision: 2, coordinatorName: "Stale", expertIds: ["must-not-clear"] },
          0,
        ),
      );
      assert.equal(Exit.isFailure(stale), true);
      const loaded = yield* repository.getConfig(projectId);
      assert.equal(Option.isSome(loaded), true);
      if (Option.isSome(loaded)) {
        assert.equal(loaded.value.coordinatorName, "Demo Coordinator");
        assert.deepEqual(loaded.value.expertIds, []);
      }
    }),
  );

  it.effect("normalizes explicit expert rosters and preserves them when omitted", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const repository = yield* ProjectAgentRepository;
      const rosterProjectId = ProjectId.makeUnsafe("project-expert-roster");
      yield* sql`
        INSERT INTO projection_projects (
          project_id, title, workspace_root, scripts_json, created_at, updated_at
        ) VALUES (${rosterProjectId}, 'Hub', '/tmp/hub', '[]', ${now}, ${now})
      `;
      const config = {
        projectId: rosterProjectId,
        coordinatorThreadId: ThreadId.makeUnsafe("thread-expert-roster"),
        coordinatorName: "Roster Coordinator",
        coordinatorModelSelection: { provider: "codex" as const, model: "gpt-5-codex" },
        limits,
        captureEnabled: true,
        enabled: true,
        automationId: null,
        revision: 1,
        createdAt: now,
        updatedAt: now,
        disabledAt: null,
        expertIds: ["zeta", "alpha", "zeta"],
      };

      yield* repository.saveConfig(config, null);
      const created = yield* repository.getConfig(rosterProjectId);
      assert.deepStrictEqual(Option.isSome(created) ? created.value.expertIds : null, [
        "alpha",
        "zeta",
      ]);

      yield* repository.saveConfig(
        { ...config, revision: 2, coordinatorName: "Updated Coordinator", expertIds: undefined },
        1,
      );
      const preserved = yield* repository.getConfig(rosterProjectId);
      assert.deepStrictEqual(Option.isSome(preserved) ? preserved.value.expertIds : null, [
        "alpha",
        "zeta",
      ]);

      yield* repository.saveConfig({ ...config, revision: 3, expertIds: [] }, 2);
      const cleared = yield* repository.getConfig(rosterProjectId);
      assert.deepStrictEqual(Option.isSome(cleared) ? cleared.value.expertIds : null, []);
    }),
  );

  it.effect("keeps Hub collaboration history atomic with config and roster writes", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const repository = yield* ProjectAgentRepository;
      const collaborationProjectId = ProjectId.makeUnsafe("project-hub-collaboration-store");
      yield* sql`
        INSERT INTO projection_projects (
          project_id, title, workspace_root, scripts_json, created_at, updated_at
        ) VALUES (
          ${collaborationProjectId}, 'Hub', '/tmp/hub-collaboration', '[]', ${now}, ${now}
        )
      `;
      const baseConfig = {
        projectId: collaborationProjectId,
        coordinatorThreadId: ThreadId.makeUnsafe("thread-hub-collaboration-store"),
        coordinatorName: "Hub Coordinator",
        coordinatorModelSelection: { provider: "codex" as const, model: "gpt-5-codex" },
        limits,
        captureEnabled: true,
        enabled: true,
        automationId: null,
        createdAt: now,
        updatedAt: now,
        disabledAt: null,
      };
      const settings = {
        schemaVersion: 1 as const,
        mode: "expert-team" as const,
        coordinatorInstructions: "  Assign work by specialty  ",
      };
      const created = yield* repository.saveConfig(
        {
          ...baseConfig,
          revision: 1,
          expertIds: ["reviewer", "architect", "reviewer"],
          collaboration: settings,
        },
        null,
      );
      assert.deepStrictEqual(created.collaboration, {
        schemaVersion: 1,
        mode: "expert-team",
        coordinatorInstructions: "Assign work by specialty",
      });

      const firstHistory = yield* sql<{
        readonly revision: number;
        readonly settingsJson: string;
        readonly expertIdsJson: string;
      }>`
        SELECT
          revision,
          settings_json AS "settingsJson",
          expert_ids_json AS "expertIdsJson"
        FROM hub_collaboration_config_revisions
        WHERE hub_id = ${collaborationProjectId}
      `;
      assert.deepStrictEqual(
        firstHistory.map(({ revision, settingsJson, expertIdsJson }) => ({
          revision,
          settings: JSON.parse(settingsJson),
          expertIds: JSON.parse(expertIdsJson),
        })),
        [
          {
            revision: 1,
            settings: {
              schemaVersion: 1,
              mode: "expert-team",
              coordinatorInstructions: "Assign work by specialty",
            },
            expertIds: ["architect", "reviewer"],
          },
        ],
      );

      yield* sql`
        CREATE TRIGGER reject_hub_collaboration_revision
        BEFORE INSERT ON hub_collaboration_config_revisions
        WHEN NEW.revision = 2
        BEGIN SELECT RAISE(ABORT, 'rejected collaboration history'); END
      `;
      const rejectedUpdate = yield* Effect.exit(
        repository.saveConfig({ ...baseConfig, revision: 2, expertIds: ["writer"] }, 1),
      );
      assert.isTrue(Exit.isFailure(rejectedUpdate));
      const rolledBackConfig = yield* repository.getConfig(collaborationProjectId);
      assert.isTrue(Option.isSome(rolledBackConfig));
      if (Option.isSome(rolledBackConfig)) {
        assert.strictEqual(rolledBackConfig.value.revision, 1);
        assert.deepStrictEqual(rolledBackConfig.value.expertIds, ["architect", "reviewer"]);
        assert.deepStrictEqual(rolledBackConfig.value.collaboration, created.collaboration);
      }
      const rolledBackSidecar = yield* sql<{ readonly revision: number; readonly count: number }>`
        SELECT
          config.revision,
          (SELECT COUNT(*) FROM hub_collaboration_config_revisions WHERE hub_id = config.hub_id) AS count
        FROM hub_collaboration_configs AS config
        WHERE config.hub_id = ${collaborationProjectId}
      `;
      assert.deepStrictEqual(rolledBackSidecar, [{ revision: 1, count: 1 }]);
      const rolledBackRoster = yield* sql<{ readonly expertId: string }>`
        SELECT expert_id AS "expertId"
        FROM hub_expert_participants
        WHERE hub_id = ${collaborationProjectId}
        ORDER BY expert_id
      `;
      assert.deepStrictEqual(
        rolledBackRoster.map(({ expertId }) => expertId),
        ["architect", "reviewer"],
      );

      yield* sql`DROP TRIGGER reject_hub_collaboration_revision`;
      const updated = yield* repository.saveConfig(
        { ...baseConfig, revision: 2, expertIds: ["writer"] },
        1,
      );
      assert.deepStrictEqual(updated.collaboration, created.collaboration);
      const loaded = yield* repository.getConfig(collaborationProjectId);
      assert.isTrue(Option.isSome(loaded));
      if (Option.isSome(loaded)) {
        assert.strictEqual(loaded.value.revision, 2);
        assert.deepStrictEqual(loaded.value.expertIds, ["writer"]);
        assert.deepStrictEqual(loaded.value.collaboration, created.collaboration);
      }
      const history = yield* sql<{
        readonly revision: number;
        readonly expertIdsJson: string;
        readonly requestId: string;
      }>`
        SELECT
          revision,
          expert_ids_json AS "expertIdsJson",
          request_id AS "requestId"
        FROM hub_collaboration_config_revisions
        WHERE hub_id = ${collaborationProjectId}
        ORDER BY revision
      `;
      assert.deepStrictEqual(
        history.map(({ revision, expertIdsJson, requestId }) => ({
          revision,
          expertIds: JSON.parse(expertIdsJson),
          requestId,
        })),
        [
          {
            revision: 1,
            expertIds: ["architect", "reviewer"],
            requestId: `hub-settings:${collaborationProjectId}:1`,
          },
          {
            revision: 2,
            expertIds: ["writer"],
            requestId: `hub-settings:${collaborationProjectId}:2`,
          },
        ],
      );

      const staleNativeCas = yield* Effect.exit(
        repository.saveConfig(
          {
            ...baseConfig,
            revision: 3,
            expertIds: ["stale"],
            collaboration: { schemaVersion: 1, mode: "standard" },
          },
          1,
        ),
      );
      assert.isTrue(Exit.isFailure(staleNativeCas));
      const afterStaleCas = yield* repository.getConfig(collaborationProjectId);
      assert.isTrue(Option.isSome(afterStaleCas));
      if (Option.isSome(afterStaleCas)) {
        assert.strictEqual(afterStaleCas.value.revision, 2);
        assert.deepStrictEqual(afterStaleCas.value.expertIds, ["writer"]);
        assert.deepStrictEqual(afterStaleCas.value.collaboration, created.collaboration);
      }
      const afterStaleHistory = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count
        FROM hub_collaboration_config_revisions
        WHERE hub_id = ${collaborationProjectId}
      `;
      assert.strictEqual(afterStaleHistory[0]?.count, 2);
    }),
  );

  it.effect("keeps legacy configs without collaboration settings unchanged", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const repository = yield* ProjectAgentRepository;
      const legacyProjectId = ProjectId.makeUnsafe("project-hub-collaboration-legacy");
      const config = {
        projectId: legacyProjectId,
        coordinatorThreadId: ThreadId.makeUnsafe("thread-hub-collaboration-legacy"),
        coordinatorName: "Legacy Coordinator",
        coordinatorModelSelection: { provider: "codex" as const, model: "gpt-5-codex" },
        limits,
        captureEnabled: true,
        enabled: true,
        automationId: null,
        revision: 1,
        createdAt: now,
        updatedAt: now,
        disabledAt: null,
      };
      const saved = yield* repository.saveConfig(config, null);
      assert.isFalse(Object.hasOwn(saved, "collaboration"));
      const loaded = yield* repository.getConfig(legacyProjectId);
      assert.isTrue(Option.isSome(loaded));
      if (Option.isSome(loaded)) assert.isFalse(Object.hasOwn(loaded.value, "collaboration"));
      const rows = yield* sql<{ readonly configCount: number; readonly revisionCount: number }>`
        SELECT
          (SELECT COUNT(*) FROM hub_collaboration_configs WHERE hub_id = ${legacyProjectId}) AS "configCount",
          (SELECT COUNT(*) FROM hub_collaboration_config_revisions WHERE hub_id = ${legacyProjectId}) AS "revisionCount"
      `;
      assert.deepStrictEqual(rows, [{ configCount: 0, revisionCount: 0 }]);
    }),
  );

  it.effect("rolls back the config revision when an expert roster replacement fails", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const repository = yield* ProjectAgentRepository;
      const atomicProjectId = ProjectId.makeUnsafe("project-expert-roster-atomic");
      yield* sql`
        INSERT INTO projection_projects (
          project_id, title, workspace_root, scripts_json, created_at, updated_at
        ) VALUES (${atomicProjectId}, 'Hub', '/tmp/hub', '[]', ${now}, ${now})
      `;
      const config = {
        projectId: atomicProjectId,
        coordinatorThreadId: ThreadId.makeUnsafe("thread-expert-roster-atomic"),
        coordinatorName: "Atomic Coordinator",
        coordinatorModelSelection: { provider: "codex" as const, model: "gpt-5-codex" },
        limits,
        captureEnabled: true,
        enabled: true,
        automationId: null,
        revision: 1,
        createdAt: now,
        updatedAt: now,
        disabledAt: null,
        expertIds: ["kept"],
      };
      yield* repository.saveConfig(config, null);
      yield* sql`
        CREATE TRIGGER reject_hub_expert_participant
        BEFORE INSERT ON hub_expert_participants
        WHEN NEW.expert_id = 'reject'
        BEGIN SELECT RAISE(ABORT, 'rejected participant'); END
      `;

      const failed = yield* Effect.exit(
        repository.saveConfig({ ...config, revision: 2, expertIds: ["reject"] }, 1),
      );
      assert.isTrue(Exit.isFailure(failed));
      const loaded = yield* repository.getConfig(atomicProjectId);
      assert.isTrue(Option.isSome(loaded));
      if (Option.isSome(loaded)) {
        assert.strictEqual(loaded.value.revision, 1);
        assert.deepStrictEqual(loaded.value.expertIds, ["kept"]);
      }
    }),
  );

  it.effect("clears the stored roster when project-agent data is deleted", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const repository = yield* ProjectAgentRepository;
      const cleanupProjectId = ProjectId.makeUnsafe("project-expert-roster-cleanup");
      yield* sql`
        INSERT INTO projection_projects (
          project_id, title, workspace_root, scripts_json, created_at, updated_at
        ) VALUES (${cleanupProjectId}, 'Hub', '/tmp/hub', '[]', ${now}, ${now})
      `;
      yield* repository.saveConfig(
        {
          projectId: cleanupProjectId,
          coordinatorThreadId: ThreadId.makeUnsafe("thread-expert-roster-cleanup"),
          coordinatorName: "Cleanup Coordinator",
          coordinatorModelSelection: { provider: "codex", model: "gpt-5-codex" },
          limits,
          captureEnabled: true,
          enabled: true,
          automationId: null,
          revision: 1,
          createdAt: now,
          updatedAt: now,
          disabledAt: null,
          expertIds: ["reviewer"],
        },
        null,
      );

      yield* repository.deleteProjectData(cleanupProjectId);
      const rows = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM hub_expert_participants
        WHERE hub_id = ${cleanupProjectId}
      `;
      assert.strictEqual(rows[0]?.count, 0);
    }),
  );

  it.effect("round-trips group goal, icon, and auto memory", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectAgentRepository;
      const config = {
        projectId,
        coordinatorThreadId,
        coordinatorName: "Demo Coordinator",
        coordinatorModelSelection: { provider: "codex" as const, model: "gpt-5-codex" },
        limits,
        captureEnabled: true,
        enabled: true,
        automationId: null,
        revision: 1,
        createdAt: now,
        updatedAt: now,
        disabledAt: null,
        goal: "Ship groups",
        icon: "folder",
        autoMemoryEnabled: true,
        linkedProjectIds: [],
        libraryPath: "/tmp/library",
        libraryRemoteUrl: "https://example.com/library.git",
        libraryPushOnChange: true,
      };
      yield* repository.saveConfig(
        {
          ...config,
          projectId: ProjectId.makeUnsafe("project-coord-fields"),
          coordinatorThreadId: ThreadId.makeUnsafe("thread-coordinator-fields"),
        },
        null,
      );
      const loaded = yield* repository.getConfig(ProjectId.makeUnsafe("project-coord-fields"));
      assert.equal(Option.isSome(loaded), true);
      if (Option.isSome(loaded)) {
        assert.equal(loaded.value.goal, "Ship groups");
        assert.equal(loaded.value.icon, "folder");
        assert.equal(loaded.value.autoMemoryEnabled, true);
        assert.deepEqual(loaded.value.linkedProjectIds, []);
        assert.equal(loaded.value.libraryPath, "/tmp/library");
        assert.equal(loaded.value.libraryRemoteUrl, "https://example.com/library.git");
        assert.equal(loaded.value.libraryPushOnChange, true);
      }
    }),
  );

  it.effect("document writes require the expected revision", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectAgentRepository;
      const first = yield* repository.writeDocument({
        expectedRevision: null,
        revision: {
          id: ProjectDocumentRevisionId.makeUnsafe("rev-1"),
          projectId,
          logicalPath: "notes.md",
          revision: 1,
          content: "one",
          contentHash: "h1",
          authorKind: "user",
          authorThreadId: null,
          sources: [],
          createdAt: now,
        },
      });
      assert.equal(first.revision, 1);
      const conflict = yield* Effect.exit(
        repository.writeDocument({
          expectedRevision: 0,
          revision: {
            id: ProjectDocumentRevisionId.makeUnsafe("rev-2"),
            projectId,
            logicalPath: "notes.md",
            revision: 2,
            content: "two",
            contentHash: "h2",
            authorKind: "user",
            authorThreadId: null,
            sources: [],
            createdAt: now,
          },
        }),
      );
      assert.equal(Exit.isFailure(conflict), true);
    }),
  );

  it.effect("does not replay a receipt from another project", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectAgentRepository;
      yield* repository.saveReceipt({
        requestId: "req-shared",
        projectId,
        operation: "configure",
        resultJson: JSON.stringify({ project: "coord-1" }),
        createdAt: now,
      });
      const own = yield* repository.getReceipt({ requestId: "req-shared", projectId });
      assert.equal(Option.isSome(own), true);
      const other = yield* repository.getReceipt({
        requestId: "req-shared",
        projectId: ProjectId.makeUnsafe("project-other"),
      });
      assert.equal(Option.isNone(other), true);
    }),
  );

  it.effect("pauses and resumes a goal after a zero-row write without weakening revision CAS", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const repository = yield* ProjectAgentRepository;
      const goalProjectId = ProjectId.makeUnsafe("project-goal-zero-row-pause");
      yield* repository.saveConfig(
        {
          projectId: goalProjectId,
          coordinatorThreadId: ThreadId.makeUnsafe("thread-goal-zero-row-pause"),
          coordinatorName: "Goal control test",
          coordinatorModelSelection: { provider: "codex", model: "test-model" },
          limits,
          captureEnabled: true,
          enabled: true,
          automationId: null,
          revision: 1,
          createdAt: now,
          updatedAt: now,
          disabledAt: null,
        },
        null,
      );
      const goal = {
        id: ProjectGoalId.makeUnsafe("goal-zero-row-pause"),
        projectId: goalProjectId,
        objective: "Keep native plan controls atomic",
        authorizationSource: "user" as const,
        scopeVersion: 1,
        acceptanceCriteria: null,
        limits,
        status: "active" as const,
        continuationCount: 0,
        workerCreationCount: 0,
        authorizedAt: now,
        revision: 1,
        createdAt: now,
        updatedAt: now,
      };
      yield* repository.saveGoal(goal, null);
      yield* sql.withTransaction(
        Effect.gen(function* () {
          // Plan commands may perform a legitimate zero-row cleanup first.
          yield* sql`UPDATE project_agent_goals SET status = 'active' WHERE goal_id = 'missing'`;
          yield* repository.saveGoal({ ...goal, status: "paused", revision: 2 }, 1);
        }),
      );
      const paused = Option.getOrThrow(yield* repository.getGoal(goal.id));
      assert.equal(paused.status, "paused");
      assert.equal(paused.revision, 2);
      yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`UPDATE project_agent_goals SET status = 'active' WHERE goal_id = 'missing'`;
          yield* repository.saveGoal({ ...paused, status: "active", revision: 3 }, 2);
        }),
      );
      const stale = yield* Effect.exit(
        sql.withTransaction(repository.saveGoal({ ...goal, status: "paused", revision: 4 }, 1)),
      );
      assert.isTrue(Exit.isFailure(stale));
      const resumed = Option.getOrThrow(yield* repository.getGoal(goal.id));
      assert.equal(resumed.status, "active");
      assert.equal(resumed.revision, 3);
    }),
  );

  it.effect("stores attempts without implying task completion", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectAgentRepository;
      const goalId = ProjectGoalId.makeUnsafe("goal-1");
      const taskId = ProjectTaskId.makeUnsafe("task-1");
      yield* repository.saveGoal(
        {
          id: goalId,
          projectId,
          objective: "Ship coordinator",
          authorizationSource: "user",
          scopeVersion: 1,
          acceptanceCriteria: null,
          limits,
          status: "active",
          continuationCount: 0,
          workerCreationCount: 0,
          authorizedAt: now,
          revision: 1,
          createdAt: now,
          updatedAt: now,
        },
        null,
      );
      yield* repository.saveTask(
        {
          id: taskId,
          projectId,
          goalId,
          title: "Implement persistence",
          description: null,
          acceptanceCriteria: "Tables exist",
          status: "running",
          dependsOnTaskIds: [],
          assignedThreadId: ThreadId.makeUnsafe("thread-worker"),
          repairCount: 0,
          archivedAt: null,
          revision: 1,
          createdAt: now,
          updatedAt: now,
        },
        null,
      );
      yield* repository.saveAttempt({
        id: ProjectTaskAttemptId.makeUnsafe("attempt-1"),
        projectId,
        taskId,
        workerThreadId: ThreadId.makeUnsafe("thread-worker"),
        gatewayOperationId: null,
        requestId: "op-1",
        attemptNumber: 1,
        outcome: "succeeded",
        error: null,
        createdAt: now,
        finishedAt: now,
      });
      const task = yield* repository.getTask(taskId);
      assert.equal(Option.isSome(task), true);
      if (Option.isSome(task)) {
        assert.equal(task.value.status, "running");
      }
    }),
  );

  it.effect("lists lightweight summaries with the active goal status", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectAgentRepository;
      const firstProjectId = ProjectId.makeUnsafe("project-summary-1");
      const secondProjectId = ProjectId.makeUnsafe("project-summary-2");
      const firstThreadId = ThreadId.makeUnsafe("thread-summary-1");
      const secondThreadId = ThreadId.makeUnsafe("thread-summary-2");
      const config = {
        projectId: firstProjectId,
        coordinatorThreadId: firstThreadId,
        coordinatorName: "Demo Coordinator",
        coordinatorModelSelection: { provider: "codex" as const, model: "gpt-5-codex" },
        limits,
        captureEnabled: true,
        enabled: true,
        automationId: null,
        revision: 1,
        createdAt: now,
        updatedAt: now,
        disabledAt: null,
      };
      yield* repository.saveConfig(config, null);
      yield* repository.saveConfig(
        {
          ...config,
          projectId: secondProjectId,
          coordinatorThreadId: secondThreadId,
          coordinatorName: "Other Coordinator",
        },
        null,
      );
      yield* repository.saveGoal(
        {
          id: ProjectGoalId.makeUnsafe("goal-summary"),
          projectId: firstProjectId,
          objective: "Keep summaries fresh",
          authorizationSource: "user",
          scopeVersion: 1,
          acceptanceCriteria: null,
          limits,
          status: "active",
          continuationCount: 0,
          workerCreationCount: 0,
          authorizedAt: now,
          revision: 1,
          createdAt: now,
          updatedAt: now,
        },
        null,
      );
      const summaries = yield* repository.listSummaries();
      const byProject = new Map(summaries.map((row) => [row.projectId, row]));
      assert.equal(byProject.get(firstProjectId)?.coordinatorName, "Demo Coordinator");
      assert.equal(byProject.get(firstProjectId)?.goalStatus, "active");
      assert.equal(byProject.get(secondProjectId)?.coordinatorName, "Other Coordinator");
      assert.equal(byProject.get(secondProjectId)?.goalStatus, null);
    }),
  );

  it.effect("delivers every out-of-order inbox event exactly once across pages", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectAgentRepository;
      const inboxProjectId = ProjectId.makeUnsafe("project-inbox-order");
      const sourceThreadId = ThreadId.makeUnsafe("thread-inbox-source");
      // Random UUIDs deliberately out of order relative to created_at: a cursor
      // that keyed on inbox_id alone would skip or redeliver these rows.
      const rows = [
        { id: "zzzz-0000-0000-0000-000000000001", createdAt: "2026-09-15T12:00:00.000Z" },
        { id: "0000-0000-0000-0000-0000000000aa", createdAt: "2026-09-15T12:00:00.000Z" },
        { id: "ffff-0000-0000-0000-000000000002", createdAt: "2026-09-15T12:00:01.000Z" },
        { id: "1111-0000-0000-0000-0000000000bb", createdAt: "2026-09-15T12:00:01.000Z" },
        { id: "aaaa-0000-0000-0000-000000000003", createdAt: "2026-09-15T12:00:02.000Z" },
      ];
      for (const [index, row] of rows.entries()) {
        const { inserted } = yield* repository.insertInboxEvent({
          id: ProjectInboxEventId.makeUnsafe(row.id),
          projectId: inboxProjectId,
          sourceThreadId,
          sourceEventId: `source-${index}`,
          eventType: "thread.turn-diff-completed",
          taskId: null,
          eligibleWake: true,
          createdAt: row.createdAt,
        });
        assert.equal(inserted, true);
      }
      const delivered: string[] = [];
      let cursor: { createdAt: string | null; id: string | null } = {
        createdAt: null,
        id: null,
      };
      for (let page = 0; page < 10; page += 1) {
        const batch = yield* repository.listInboxAfter({
          projectId: inboxProjectId,
          afterCreatedAt: cursor.createdAt,
          afterId: cursor.id,
          limit: 2,
        });
        if (batch.length === 0) break;
        delivered.push(...batch.map((event) => event.id));
        const last = batch[batch.length - 1]!;
        cursor = { createdAt: last.createdAt, id: last.id };
      }
      assert.deepEqual(delivered.sort(), rows.map((row) => row.id).sort());
      // Re-inserting the same source_event_id dedupes to the stored row.
      const { inserted: deduped, event: dedupedEvent } = yield* repository.insertInboxEvent({
        id: ProjectInboxEventId.makeUnsafe("bbbb-0000-0000-0000-0000000000dd"),
        projectId: inboxProjectId,
        sourceThreadId,
        sourceEventId: "source-0",
        eventType: "thread.turn-diff-completed",
        taskId: null,
        eligibleWake: true,
        createdAt: "2026-09-15T12:00:03.000Z",
      });
      assert.equal(deduped, false);
      assert.equal(dedupedEvent.id, "bbbb-0000-0000-0000-0000000000dd");
    }),
  );

  it.effect("allocates activity sequences atomically across concurrent appends", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectAgentRepository;
      const activityProjectId = ProjectId.makeUnsafe("project-activity-seq");
      const activities = yield* Effect.forEach(
        Array.from({ length: 8 }, (_, index) => index),
        (index) =>
          repository.appendActivity({
            id: ProjectActivityId.makeUnsafe(`activity-${index}`),
            projectId: activityProjectId,
            kind: "task-updated",
            actorKind: "coordinator",
            actorThreadId: null,
            goalId: null,
            taskId: null,
            source: null,
            summary: `activity ${index}`,
            createdAt: `2026-09-15T12:00:${String(index).padStart(2, "0")}.000Z`,
          }),
        { concurrency: "unbounded" },
      );
      const sequences = activities.map((activity) => activity.sequence).sort((a, b) => a - b);
      assert.deepEqual(
        sequences,
        Array.from({ length: 8 }, (_, index) => index + 1),
      );
    }),
  );

  it.effect("pages activity strictly by sequence", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectAgentRepository;
      const activityProjectId = ProjectId.makeUnsafe("project-activity-page");
      for (const index of [0, 1, 2, 3, 4]) {
        yield* repository.appendActivity({
          id: ProjectActivityId.makeUnsafe(`activity-page-${index}`),
          projectId: activityProjectId,
          kind: "task-updated",
          actorKind: "coordinator",
          actorThreadId: null,
          goalId: null,
          taskId: null,
          source: null,
          summary: `page ${index}`,
          // Same created_at for every row: a (created_at, activity_id) cursor
          // on random UUIDs could skip rows; the sequence cursor cannot.
          createdAt: "2026-09-15T12:00:00.000Z",
        });
      }
      const first = yield* repository.listActivity({ projectId: activityProjectId, limit: 2 });
      assert.deepEqual(
        first.map((row) => row.sequence),
        [5, 4],
      );
      const second = yield* repository.listActivity({
        projectId: activityProjectId,
        limit: 2,
        cursor: { sequence: first[first.length - 1]!.sequence },
      });
      assert.deepEqual(
        second.map((row) => row.sequence),
        [3, 2],
      );
      const third = yield* repository.listActivity({
        projectId: activityProjectId,
        limit: 2,
        cursor: { sequence: second[second.length - 1]!.sequence },
      });
      assert.deepEqual(
        third.map((row) => row.sequence),
        [1],
      );
    }),
  );

  it.effect("round-trips wake cursors with the createdAt keyset and busy marker", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectAgentRepository;
      const cursorProjectId = ProjectId.makeUnsafe("project-cursor");
      const initial = yield* repository.getCursor(cursorProjectId);
      assert.equal(initial.processedThroughInboxId, null);
      assert.equal(initial.coordinatorBusy, false);
      yield* repository.saveCursor({
        projectId: cursorProjectId,
        processedThroughInboxId: "inbox-9",
        processedThroughCreatedAt: "2026-09-15T12:05:00.000Z",
        frozenFromInboxId: "inbox-9",
        frozenToInboxId: "inbox-12",
        coordinatorBusy: true,
        coordinatorBusySince: "2026-09-15T12:05:01.000Z",
        updatedAt: "2026-09-15T12:05:02.000Z",
      });
      const busy = yield* repository.getCursor(cursorProjectId);
      assert.equal(busy.processedThroughInboxId, "inbox-9");
      assert.equal(busy.processedThroughCreatedAt, "2026-09-15T12:05:00.000Z");
      assert.equal(busy.coordinatorBusy, true);
      assert.equal(busy.coordinatorBusySince, "2026-09-15T12:05:01.000Z");
      yield* repository.saveCursor({
        projectId: cursorProjectId,
        processedThroughInboxId: "inbox-12",
        processedThroughCreatedAt: "2026-09-15T12:06:00.000Z",
        frozenFromInboxId: null,
        frozenToInboxId: null,
        coordinatorBusy: false,
        coordinatorBusySince: null,
        updatedAt: "2026-09-15T12:06:01.000Z",
      });
      const cleared = yield* repository.getCursor(cursorProjectId);
      assert.equal(cleared.coordinatorBusy, false);
      assert.equal(cleared.coordinatorBusySince, null);
      assert.equal(cleared.frozenFromInboxId, null);
    }),
  );

  it.effect("marks interrupted digests failed on startup reset", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectAgentRepository;
      const digestProjectId = ProjectId.makeUnsafe("project-digest-reset");
      yield* repository.saveDigest({
        projectId: digestProjectId,
        summary: "old",
        focusItems: [],
        coverageFromSequence: 0,
        coverageToSequence: 3,
        historicalCoverage: "none",
        summarizedThreadCount: 0,
        pendingThreadCount: 2,
        generationState: "running",
        generatedAt: null,
        lastGoodAt: null,
        lastError: null,
      });
      const reset = yield* repository.resetInterruptedDigests();
      assert.equal(reset >= 1, true);
      const digest = yield* repository.getDigest(digestProjectId);
      assert.equal(Option.isSome(digest) && digest.value.generationState === "failed", true);
      // A second reset leaves the failed digest untouched.
      const again = yield* repository.resetInterruptedDigests();
      const digestAfter = yield* repository.getDigest(digestProjectId);
      assert.equal(
        Option.isSome(digestAfter) && digestAfter.value.generationState === "failed",
        true,
      );
      assert.equal(again >= 0, true);
    }),
  );

  it.effect("still loads a digest whose stored error is oversize raw CLI output", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectAgentRepository;
      const sql = yield* SqlClient.SqlClient;
      const digestProjectId = ProjectId.makeUnsafe("project-digest-oversize-error");
      yield* repository.saveDigest({
        projectId: digestProjectId,
        summary: "",
        focusItems: [],
        coverageFromSequence: 0,
        coverageToSequence: 0,
        historicalCoverage: "complete",
        summarizedThreadCount: 0,
        pendingThreadCount: 0,
        generationState: "failed",
        generatedAt: null,
        lastGoodAt: null,
        lastError: null,
      });
      // Rows written before the save-side cap existed can hold >2,000 chars
      // with ANSI escapes; loading them must not fail the whole overview.
      const raw = `Codex CLI command failed: \u001b[1mworkdir:\u001b[0m ${"x".repeat(2_500)}`;
      yield* sql`UPDATE project_agent_digests SET last_error = ${raw} WHERE project_id = ${digestProjectId}`;
      const digest = yield* repository.getDigest(digestProjectId);
      assert.equal(Option.isSome(digest), true);
      if (Option.isSome(digest)) {
        const lastError = digest.value.lastError ?? "";
        assert.equal(lastError.length <= 2_000, true);
        assert.equal(lastError.includes("\u001b"), false);
        assert.equal(lastError.startsWith("Codex CLI command failed: workdir:"), true);
      }
    }),
  );

  it.effect("tracks the disk-sync marker so external edits conflict once", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectAgentRepository;
      const docProjectId = ProjectId.makeUnsafe("project-doc-diskhash");
      const write = (diskHash: string | null, expectedRevision: number | null, n: number) =>
        repository.writeDocument({
          expectedRevision,
          diskHash,
          revision: {
            id: ProjectDocumentRevisionId.makeUnsafe(`rev-diskhash-${n}`),
            projectId: docProjectId,
            logicalPath: "notes.md",
            revision: n,
            content: `v${n}`,
            contentHash: `content-h${n}`,
            authorKind: "user",
            authorThreadId: null,
            sources: [],
            createdAt: now,
          },
        });
      yield* write("disk-1", null, 1);
      const head = yield* repository.getDocumentHead(docProjectId, "notes.md");
      assert.equal(Option.isSome(head) && head.value.diskHash === "disk-1", true);
      // The mirror write bumps the marker without inserting a revision.
      yield* repository.markDocumentDiskSynced({
        projectId: docProjectId,
        logicalPath: "notes.md",
        diskHash: "disk-1-mirrored",
      });
      const synced = yield* repository.getDocumentHead(docProjectId, "notes.md");
      assert.equal(Option.isSome(synced) && synced.value.diskHash === "disk-1-mirrored", true);
      // Stale expectedRevision still maps to a revision-mismatch failure.
      const conflict = yield* Effect.exit(write("disk-2", 0, 2));
      assert.equal(Exit.isFailure(conflict), true);
      if (Exit.isFailure(conflict)) {
        assert.equal(String(conflict.cause).includes("revision mismatch"), true);
      }
    }),
  );

  it.effect("finds the owning task for an assigned worker thread", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectAgentRepository;
      const ownerProjectId = ProjectId.makeUnsafe("project-assigned-owner");
      const goalId = ProjectGoalId.makeUnsafe("goal-assigned");
      const workerThreadId = ThreadId.makeUnsafe("thread-assigned-worker");
      yield* repository.saveConfig(
        {
          projectId: ownerProjectId,
          coordinatorThreadId: ThreadId.makeUnsafe("thread-assigned-coordinator"),
          coordinatorName: "Owner Coordinator",
          coordinatorModelSelection: { provider: "codex" as const, model: "gpt-5-codex" },
          limits,
          captureEnabled: true,
          enabled: true,
          automationId: null,
          revision: 1,
          createdAt: now,
          updatedAt: now,
          disabledAt: null,
        },
        null,
      );
      yield* repository.saveGoal(
        {
          id: goalId,
          projectId: ownerProjectId,
          objective: "Track workers",
          authorizationSource: "user",
          scopeVersion: 1,
          acceptanceCriteria: null,
          limits,
          status: "active",
          continuationCount: 0,
          workerCreationCount: 0,
          authorizedAt: now,
          revision: 1,
          createdAt: now,
          updatedAt: now,
        },
        null,
      );
      const taskId = ProjectTaskId.makeUnsafe("task-assigned");
      yield* repository.saveTask(
        {
          id: taskId,
          projectId: ownerProjectId,
          goalId,
          title: "Assigned work",
          description: null,
          acceptanceCriteria: null,
          status: "running",
          dependsOnTaskIds: [],
          assignedThreadId: workerThreadId,
          repairCount: 0,
          archivedAt: null,
          revision: 1,
          createdAt: now,
          updatedAt: now,
        },
        null,
      );
      const found = yield* repository.findTaskByAssignedThread(workerThreadId);
      assert.equal(Option.isSome(found) && found.value.id === taskId, true);
      const missing = yield* repository.findTaskByAssignedThread(
        ThreadId.makeUnsafe("thread-unassigned"),
      );
      assert.equal(Option.isNone(missing), true);
    }),
  );

  it.effect("rolls back Task rows and dependencies when dependency replacement fails", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectAgentRepository;
      const fixtureProjectId = ProjectId.makeUnsafe("project-task-atomic-save");
      const goalId = ProjectGoalId.makeUnsafe("goal-task-atomic-save");
      yield* repository.saveConfig(
        {
          projectId: fixtureProjectId,
          coordinatorThreadId: ThreadId.makeUnsafe("thread-task-atomic-save"),
          coordinatorName: "Atomic save test",
          coordinatorModelSelection: { provider: "codex", model: "test-model" },
          limits,
          captureEnabled: true,
          enabled: true,
          automationId: null,
          revision: 1,
          createdAt: now,
          updatedAt: now,
          disabledAt: null,
        },
        null,
      );
      yield* repository.saveGoal(
        {
          id: goalId,
          projectId: fixtureProjectId,
          objective: "Task save transaction",
          authorizationSource: "user",
          scopeVersion: 1,
          acceptanceCriteria: null,
          limits,
          status: "active",
          continuationCount: 0,
          workerCreationCount: 0,
          authorizedAt: now,
          revision: 1,
          createdAt: now,
          updatedAt: now,
        },
        null,
      );
      const task = (id: string, dependsOnTaskIds: ProjectTaskId[] = []) => ({
        id: ProjectTaskId.makeUnsafe(id),
        projectId: fixtureProjectId,
        goalId,
        title: "Original task",
        description: null,
        acceptanceCriteria: null,
        status: "planned" as const,
        dependsOnTaskIds,
        assignedThreadId: null,
        repairCount: 0,
        archivedAt: null,
        revision: 1,
        createdAt: now,
        updatedAt: now,
      });
      const originalPrerequisite = task("task-atomic-original-prerequisite");
      const replacementPrerequisite = task("task-atomic-replacement-prerequisite");
      yield* repository.saveTask(originalPrerequisite, null);
      yield* repository.saveTask(replacementPrerequisite, null);
      const original = task("task-atomic-target", [originalPrerequisite.id]);
      yield* repository.saveTask(original, null);

      const failedUpdate = yield* Effect.exit(
        repository.saveTask(
          {
            ...original,
            title: "Must roll back",
            revision: 2,
            dependsOnTaskIds: [replacementPrerequisite.id, replacementPrerequisite.id],
          },
          1,
        ),
      );
      assert.isTrue(Exit.isFailure(failedUpdate));
      const persisted = Option.getOrThrow(yield* repository.getTask(original.id));
      assert.strictEqual(persisted.revision, 1);
      assert.strictEqual(persisted.title, "Original task");
      assert.deepStrictEqual(persisted.dependsOnTaskIds, [originalPrerequisite.id]);

      const insertId = ProjectTaskId.makeUnsafe("task-atomic-insert");
      const failedInsert = yield* Effect.exit(
        repository.saveTask(
          {
            ...task(insertId),
            id: insertId,
            dependsOnTaskIds: [replacementPrerequisite.id, replacementPrerequisite.id],
          },
          null,
        ),
      );
      assert.isTrue(Exit.isFailure(failedInsert));
      assert.isTrue(Option.isNone(yield* repository.getTask(insertId)));
      const edges = yield* repository.listTaskEdges(fixtureProjectId);
      assert.isFalse(edges.has(insertId));
    }),
  );
});
