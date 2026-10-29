import { ThreadId, type SkillEvolutionEvent } from "@synara/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite";
import { SkillEvolutionRepository } from "../../experts/evolution/SkillEvolutionRepository";
import { SkillEvolutionRepositoryLive } from "./skillEvolutionPersistence";

const layer = it.layer(
  SkillEvolutionRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);
layer("Skill evolution persistence", (it) => {
  it.effect("persists a request identity and resolves only its registered native task", () =>
    Effect.gen(function* () {
      const repository = yield* SkillEvolutionRepository;
      const row = {
        requestId: "repository-request",
        expertId: "expert-a",
        taskThreadId: "analysis-thread",
        record: JSON.stringify({
          requestId: "repository-request",
          ownerId: "owner-a",
          run: { modelSelection: { provider: "pi", model: "user-configured-model" } },
        }),
        updatedAt: "2026-10-29T00:00:00Z",
      };
      yield* repository.write(row);
      yield* repository.write({ ...row, updatedAt: "2026-10-29T00:01:00Z" });
      const execution = yield* repository.execution(ThreadId.makeUnsafe("analysis-thread"));
      assert.deepStrictEqual(execution, {
        requestId: "repository-request",
        ownerId: "owner-a",
        modelSelection: { provider: "pi", instanceId: "pi", model: "user-configured-model" },
      });
      assert.strictEqual(
        yield* repository.execution(ThreadId.makeUnsafe("ordinary-thread")),
        undefined,
      );
      assert.strictEqual(
        (yield* repository.read(row.requestId))?.updatedAt,
        "2026-10-29T00:01:00Z",
      );
      const conflict = yield* repository
        .write({ ...row, taskThreadId: "different-thread" })
        .pipe(Effect.flip);
      assert.match(String(conflict), /身份已经固定/u);
      assert.strictEqual((yield* repository.read(row.requestId))?.taskThreadId, "analysis-thread");
    }),
  );
  it.effect("records one event per operation and retains the original recorded time", () =>
    Effect.gen(function* () {
      const repository = yield* SkillEvolutionRepository;
      const event: SkillEvolutionEvent = {
        eventId: "event-a",
        operationId: "operation-a",
        requestId: "repository-request",
        expertId: "expert-a",
        skillId: "skl_" + "a".repeat(32),
        name: "A",
        kind: "updated",
        createdAt: "2026-10-29T00:00:00Z",
        revision: 2,
        packageId: "pkg_" + "a".repeat(64),
        affectedExpertIds: ["expert-a", "expert-b"],
      };
      yield* repository.appendEvent(event);
      yield* repository.appendEvent({ ...event, createdAt: "2026-10-29T00:02:00Z" });
      const events = (yield* repository.events()).filter(
        (value) => value.eventId === event.eventId,
      );
      assert.strictEqual(events.length, 1);
      assert.strictEqual(events[0]?.createdAt, event.createdAt);
    }),
  );
});
