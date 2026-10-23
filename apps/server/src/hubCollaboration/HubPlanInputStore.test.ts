import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ProjectTaskAttemptId, ThreadId } from "@synara/contracts";
import { createHash } from "node:crypto";

import { runMigrations } from "../persistence/Migrations.ts";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";
import {
  runWorkbenchMigrations,
  workbenchMigrationEntries,
} from "../workbench/persistence/WorkbenchMigrations.ts";
import { HUB_PLAN_SQL } from "../workbench/persistence/HubPlanMigration.ts";
import {
  makeHubPlanStore,
  HubPlanStoreIdempotencyError,
  HubPlanStoreInvariantError,
  type HubPlanInputRequestRecord,
  type PlanRecord,
} from "./HubPlanStore.ts";
import { hubPlanInputResponseDigest, hubPlanInputResponseIdentity } from "./hubPlanInput.ts";

const tests = it.layer(NodeSqliteClient.layerMemory());
const time = "2026-10-23T06:00:00.000Z";
const responseTime = "2026-10-23T06:01:00.000Z";
let fixtureId = 0;
const fixture = () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations();
    yield* runWorkbenchMigrations();
    const suffix = ++fixtureId;
    const plan: PlanRecord = {
      id: `input-plan-${suffix}`,
      hubId: `input-hub-${suffix}`,
      goalId: null,
      revision: 1,
      stateVersion: 1,
      controlState: "draft",
      definition: {
        objective: "Local test document",
        scope: "No external actions",
        maxRepairRounds: 1,
        stages: [{ key: "draft", title: "Draft", releasePolicy: "user" }],
        nodes: [
          {
            key: "author",
            stageKey: "draft",
            title: "Author",
            role: "author",
            brief: "Write document",
            workMode: "co_create",
            dependsOnNodeKeys: [],
            acceptanceCriteria: "Reviewed document",
          },
        ],
      },
      configSnapshot: { configRevision: 1, expertIds: [] },
      stageGenerations: { draft: 0 },
      createdAt: time,
      updatedAt: time,
    };
    yield* sql`INSERT INTO projection_projects (project_id,title,workspace_root,scripts_json,created_at,updated_at)
    VALUES (${plan.hubId},'Input test','/tmp/input-test','[]',${time},${time})`;
    const store = makeHubPlanStore(sql);
    yield* store.savePlan(plan, null);
    const request: HubPlanInputRequestRecord = {
      id: "question-1",
      planId: plan.id,
      revision: 1,
      nodeKey: "author",
      stageKey: "draft",
      generation: 1,
      attemptId: ProjectTaskAttemptId.makeUnsafe("attempt-1"),
      workerThreadId: ThreadId.makeUnsafe("worker-1"),
      questions: [{ title: "Which local format?", options: ["Markdown", "Plain text"] }],
      status: "pending",
      createdAt: time,
      updatedAt: time,
    };
    return { sql, store, plan, request };
  });

const answerRequest = (
  request: HubPlanInputRequestRecord,
  answers: readonly string[] = ["Markdown"],
): HubPlanInputRequestRecord => {
  const withIdentity = {
    ...request,
    status: "answered" as const,
    answers,
    responseCreatedAt: responseTime,
    ...hubPlanInputResponseIdentity({ planId: request.planId, requestId: request.id }),
  };
  return {
    ...withIdentity,
    responseMessageDigest: hubPlanInputResponseDigest(withIdentity),
  };
};

tests("Hub directed-input durable store", (test) => {
  test.effect(
    "adds input persistence without changing the applied plan migration and survives migration replay",
    () =>
      Effect.gen(function* () {
        const h = yield* fixture();
        const migration8 = workbenchMigrationEntries.find(
          (entry) => entry.moduleId === "expert" && entry.migrationId === 8,
        )!;
        assert.equal(
          migration8.checksum,
          `sha256:${createHash("sha256").update(HUB_PLAN_SQL).digest("hex")}`,
        );
        assert.equal(
          migration8.checksum,
          "sha256:f0cb93776624de7874786a05d93c254baaacc55ae700b8a34ccf4758e3fef0d9",
        );
        yield* h.store.saveInputRequest(h.request);
        yield* runWorkbenchMigrations();
        const reloaded = yield* makeHubPlanStore(h.sql).readInputRequest({
          planId: h.plan.id,
          requestId: h.request.id,
        });
        assert.deepEqual(reloaded, h.request);
      }),
  );

  test.effect("scopes identical question identifiers to their own plan", () =>
    Effect.gen(function* () {
      const a = yield* fixture();
      const b = yield* fixture();
      yield* a.store.saveInputRequest(a.request);
      yield* b.store.saveInputRequest({
        ...b.request,
        questions: [{ title: "A different plan question" }],
      });
      assert.deepEqual(
        (yield* a.store.listInputRequests({ planId: a.plan.id })).map((item) => item.questions),
        [a.request.questions],
      );
      assert.equal(
        (yield* b.store.listInputRequests({ planId: b.plan.id }))[0]?.questions[0]?.title,
        "A different plan question",
      );
    }),
  );

  test.effect("rejects rewriting question text, author, revision or attempt identity", () =>
    Effect.gen(function* () {
      const h = yield* fixture();
      yield* h.store.saveInputRequest(h.request);
      for (const change of [
        { questions: [{ title: "Changed question" }] },
        { workerThreadId: ThreadId.makeUnsafe("other-worker") },
        { attemptId: ProjectTaskAttemptId.makeUnsafe("other-attempt") },
        { revision: 2 },
        { generation: 2 },
        { nodeKey: "other-node" },
      ]) {
        const failure = yield* Effect.flip(h.store.saveInputRequest({ ...h.request, ...change }));
        assert.instanceOf(failure, HubPlanStoreIdempotencyError);
      }
      assert.deepEqual(
        yield* h.store.readInputRequest({ planId: h.plan.id, requestId: h.request.id }),
        h.request,
      );
    }),
  );

  test.effect("retains one immutable answer through accepted and delivered states", () =>
    Effect.gen(function* () {
      const h = yield* fixture();
      yield* h.store.saveInputRequest(h.request);
      const answered = answerRequest(h.request);
      yield* h.store.saveInputRequest(answered);
      assert.deepEqual(yield* h.store.saveInputRequest(answered), answered);
      const delivered: HubPlanInputRequestRecord = { ...answered, status: "delivered" };
      yield* h.store.saveInputRequest(delivered);
      assert.instanceOf(
        yield* Effect.flip(
          h.store.saveInputRequest({ ...delivered, responseCreatedAt: "2026-10-23T06:02:00.000Z" }),
        ),
        HubPlanStoreIdempotencyError,
      );
      const failure = yield* Effect.flip(
        h.store.saveInputRequest({ ...delivered, answers: ["Plain text"] }),
      );
      assert.instanceOf(failure, HubPlanStoreIdempotencyError);
      assert.deepEqual(
        yield* h.store.readInputRequest({ planId: h.plan.id, requestId: h.request.id }),
        delivered,
      );
    }),
  );

  test.effect("does not reopen delivered or superseded questions", () =>
    Effect.gen(function* () {
      const h = yield* fixture();
      yield* h.store.saveInputRequest(h.request);
      const stale: HubPlanInputRequestRecord = { ...h.request, status: "stale" };
      yield* h.store.saveInputRequest(stale);
      for (const reopened of [
        h.request,
        { ...h.request, status: "answered" as const, answers: ["Markdown"] },
      ]) {
        assert.instanceOf(
          yield* Effect.flip(h.store.saveInputRequest(reopened)),
          HubPlanStoreIdempotencyError,
        );
      }
      const other = { ...h.request, id: "question-2" };
      yield* h.store.saveInputRequest(other);
      const answered = answerRequest(other);
      yield* h.store.saveInputRequest(answered);
      const delivered = { ...answered, status: "delivered" as const };
      yield* h.store.saveInputRequest(delivered);
      assert.instanceOf(
        yield* Effect.flip(h.store.saveInputRequest(answered)),
        HubPlanStoreIdempotencyError,
      );
    }),
  );

  test.effect(
    "rejects incomplete authorization and later changes to pinned dispatch settings",
    () =>
      Effect.gen(function* () {
        const h = yield* fixture();
        yield* h.store.saveInputRequest(h.request);
        const answer = {
          ...h.request,
          status: "answered" as const,
          answers: ["Markdown"],
          responseCreatedAt: responseTime,
        };
        assert.instanceOf(
          yield* Effect.flip(
            h.store.saveInputRequest({ ...answer, responseCommandId: "only-one-id" }),
          ),
          HubPlanStoreIdempotencyError,
        );
        const pinned: HubPlanInputRequestRecord = {
          ...answer,
          ...hubPlanInputResponseIdentity({ planId: h.plan.id, requestId: h.request.id }),
          responseMessageDigest: hubPlanInputResponseDigest(answer),
          responseRuntimeMode: "approval-required",
          responseInteractionMode: "default",
          responseModelSelection: { provider: "codex", instanceId: "codex", model: "test-model" },
        };
        yield* h.store.saveInputRequest(pinned);
        assert.instanceOf(
          yield* Effect.flip(
            h.store.saveInputRequest({ ...pinned, responseRuntimeMode: "full-access" }),
          ),
          HubPlanStoreIdempotencyError,
        );
        assert.instanceOf(
          yield* Effect.flip(
            h.store.saveInputRequest({ ...pinned, responseMessageDigest: "b".repeat(64) }),
          ),
          HubPlanStoreIdempotencyError,
        );
      }),
  );

  test.effect("requires new questions to start pending and answers to have content", () =>
    Effect.gen(function* () {
      const h = yield* fixture();
      assert.instanceOf(
        yield* Effect.flip(
          h.store.saveInputRequest({
            ...h.request,
            status: "answered",
            responseCreatedAt: responseTime,
            ...hubPlanInputResponseIdentity({ planId: h.plan.id, requestId: h.request.id }),
            responseMessageDigest: "a".repeat(64),
          }),
        ),
        HubPlanStoreInvariantError,
      );
      yield* h.store.saveInputRequest(h.request);
      assert.instanceOf(
        yield* Effect.flip(h.store.saveInputRequest({ ...h.request, status: "answered" })),
        HubPlanStoreInvariantError,
      );
      const blank = yield* Effect.exit(h.store.saveInputRequest(answerRequest(h.request, [" "])));
      assert.equal(blank._tag, "Failure");
    }),
  );

  test.effect("rolls back an answer together with its domain transaction", () =>
    Effect.gen(function* () {
      const h = yield* fixture();
      yield* h.store.saveInputRequest(h.request);
      let answerWasWritten = false;
      yield* Effect.exit(
        h.store.transaction(
          Effect.gen(function* () {
            yield* h.store.saveInputRequest({
              ...answerRequest(h.request),
            });
            answerWasWritten = true;
            return yield* Effect.fail(new Error("Rollback after answer, before outbox"));
          }),
        ),
      );
      assert.isTrue(answerWasWritten);
      assert.deepEqual(
        yield* h.store.readInputRequest({ planId: h.plan.id, requestId: h.request.id }),
        h.request,
      );
    }),
  );
});
