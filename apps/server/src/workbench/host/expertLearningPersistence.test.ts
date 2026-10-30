import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite";
import { ExpertLearningRepository } from "../../experts/evolution/ExpertLearningRepository";
import { ExpertLearningRepositoryLive } from "./expertLearningPersistence";

const layer = it.layer(
  ExpertLearningRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

const evidenceRecord = (patch: Record<string, unknown> = {}) => ({
  evidenceId: "evidence-a",
  ownerId: "owner-a",
  expertId: "expert-a",
  threadId: "thread-a",
  turnId: "turn-a",
  rootRunId: "root-run-a",
  snapshotId: "snapshot-a",
  projectId: "project-a",
  modelSelection: { provider: "pi", instanceId: "pi-local", model: "configured-model" },
  items: [{ id: "message-a", kind: "message", text: "Use direct evidence.", role: "user" }],
  coverage: ["user_feedback"],
  completedAt: "2026-10-31T00:00:00.000Z",
  updatedAt: "2026-10-31T00:01:00.000Z",
  ...patch,
});

layer("Expert learning persistence", (test) => {
  test.effect("isolates learning state by owner and atomically compares revisions", () =>
    Effect.gen(function* () {
      const repository = yield* ExpertLearningRepository;
      const first = {
        ownerId: "owner-a",
        expertId: "expert-a",
        record: JSON.stringify({ state: { expertId: "expert-a", enabled: true } }),
        revision: 1,
        updatedAt: "2026-10-31T00:00:00.000Z",
      };
      yield* repository.writeState(first, 0);
      assert.deepStrictEqual(yield* repository.readState("owner-a", "expert-a"), first);
      assert.strictEqual(yield* repository.readState("owner-b", "expert-a"), undefined);

      const second = {
        ...first,
        record: "second",
        revision: 2,
        updatedAt: "2026-10-31T00:01:00.000Z",
      };
      yield* repository.writeState(second, 1);
      const stale = yield* Effect.flip(
        repository.writeState(
          { ...second, record: "stale", revision: 2, updatedAt: "2026-10-31T00:02:00.000Z" },
          1,
        ),
      );
      assert.match(String(stale), /修订冲突/u);
      assert.strictEqual((yield* repository.readState("owner-a", "expert-a"))?.record, "second");

      const malformedRevision = yield* Effect.flip(
        repository.writeState({ ...second, revision: 4 }, 2),
      );
      assert.match(String(malformedRevision), /下一版/u);
      const isolatedOwner = { ...first, ownerId: "owner-b", record: "owner-b" };
      yield* repository.writeState(isolatedOwner, 0);
      assert.strictEqual((yield* repository.listStates()).length, 2);
    }),
  );

  test.effect("bounds evidence and fixes evidence identity to its owner and task", () =>
    Effect.gen(function* () {
      const repository = yield* ExpertLearningRepository;
      const data = evidenceRecord();
      const first = {
        evidenceId: "evidence-a",
        ownerId: "owner-a",
        expertId: "expert-a",
        threadId: "thread-a",
        turnId: "turn-a",
        record: JSON.stringify(data),
        updatedAt: data.updatedAt,
      };
      yield* repository.writeEvidence(first);
      assert.deepStrictEqual(yield* repository.readEvidence(first.evidenceId), first);
      assert.deepStrictEqual(yield* repository.listEvidence("owner-a", "expert-a"), [first]);
      assert.deepStrictEqual(yield* repository.listEvidence("owner-b", "expert-a"), []);

      const updatedData = evidenceRecord({ updatedAt: "2026-10-31T00:02:00.000Z" });
      const updated = {
        ...first,
        record: JSON.stringify(updatedData),
        updatedAt: updatedData.updatedAt,
      };
      yield* repository.writeEvidence(updated);
      assert.strictEqual(
        (yield* repository.readEvidence(first.evidenceId))?.updatedAt,
        updated.updatedAt,
      );

      const mismatch = yield* Effect.flip(
        repository.writeEvidence({
          ...updated,
          ownerId: "owner-b",
          record: JSON.stringify(
            evidenceRecord({ ownerId: "owner-b", updatedAt: updated.updatedAt }),
          ),
        }),
      );
      assert.match(String(mismatch), /身份已经固定/u);

      const oversized = evidenceRecord({
        items: [{ id: "message-a", kind: "message", text: "x".repeat(16_001) }],
      });
      const bounded = yield* Effect.flip(
        repository.writeEvidence({ ...first, record: JSON.stringify(oversized) }),
      );
      assert.isNotNull(bounded);
      assert.strictEqual(
        (yield* repository.readEvidence(first.evidenceId))?.updatedAt,
        updated.updatedAt,
      );
    }),
  );

  test.effect("keeps cycle ownership fixed while allowing server record updates", () =>
    Effect.gen(function* () {
      const repository = yield* ExpertLearningRepository;
      const first = {
        cycleId: "cycle-a",
        ownerId: "owner-a",
        expertId: "expert-a",
        record: "queued",
        updatedAt: "2026-10-31T00:00:00.000Z",
      };
      yield* repository.writeCycle(first);
      const second = { ...first, record: "completed", updatedAt: "2026-10-31T00:01:00.000Z" };
      yield* repository.writeCycle(second);
      assert.deepStrictEqual(yield* repository.readCycle(first.cycleId), second);
      assert.deepStrictEqual(yield* repository.listCycles("owner-a", "expert-a"), [second]);
      assert.deepStrictEqual(yield* repository.listCycles("owner-b", "expert-a"), []);

      const conflict = yield* Effect.flip(repository.writeCycle({ ...second, ownerId: "owner-b" }));
      assert.match(String(conflict), /身份已经固定/u);
      assert.deepStrictEqual(yield* repository.readCycle(first.cycleId), second);
    }),
  );
});
