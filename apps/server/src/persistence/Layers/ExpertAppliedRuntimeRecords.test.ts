import { assert, it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";

import { ThreadId } from "@synara/contracts";
import { ExpertAppliedRuntimeRepository } from "../Services/ExpertAppliedRuntimeRecords.ts";
import { ExpertAppliedRuntimeRepositoryLive } from "./ExpertAppliedRuntimeRecords.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";

const layer = it.layer(
  ExpertAppliedRuntimeRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

const record = (input: {
  readonly snapshotId: string;
  readonly lifecycleGeneration: string;
  readonly appliedAt: string;
}) => ({
  threadId: ThreadId.makeUnsafe("thread-applied-runtime"),
  snapshotId: input.snapshotId,
  provider: "codex" as const,
  model: "gpt-5-codex",
  runtimeComponent: "codex-cli",
  runtimeVersion: "1.2.3",
  lifecycleGeneration: input.lifecycleGeneration,
  appliedAt: input.appliedAt,
});

layer("ExpertAppliedRuntimeRepository", (it) => {
  it.effect("persists catalog submission evidence bound to its runtime generation", () =>
    Effect.gen(function* () {
      const repository = yield* ExpertAppliedRuntimeRepository;
      const value = {
        ...record({
          snapshotId: "fixed",
          lifecycleGeneration: "generation",
          appliedAt: "2026-10-20T00:00:00.000Z",
        }),
        skillApplication: {
          mode: "catalog" as const,
          snapshotId: "fixed",
          packageIds: [`pkg_${"a".repeat(64)}`],
          catalogHash: "b".repeat(64),
          instructionsHash: "c".repeat(64),
          startupEntryIds: [`pkg_${"a".repeat(64)}#role/SKILL.md`],
          lifecycleGeneration: "generation",
        },
      };
      yield* repository.upsert(value);
      assert.deepStrictEqual(
        Option.getOrUndefined(yield* repository.getByThreadId({ threadId: value.threadId })),
        value,
      );
      yield* repository.deleteByThreadId({ threadId: value.threadId });
    }),
  );
  it.effect("upserts one latest row per thread and supports read/delete", () =>
    Effect.gen(function* () {
      const repository = yield* ExpertAppliedRuntimeRepository;
      const first = record({
        snapshotId: "snapshot-first",
        lifecycleGeneration: "generation-first",
        appliedAt: "2026-09-28T00:00:00.000Z",
      });
      const latest = record({
        snapshotId: "snapshot-latest",
        lifecycleGeneration: "generation-latest",
        appliedAt: "2026-09-28T00:01:00.000Z",
      });

      yield* repository.upsert(first);
      yield* repository.upsert(latest);

      const stored = yield* repository.getByThreadId({ threadId: latest.threadId });
      assert.deepStrictEqual(Option.getOrUndefined(stored), latest);

      yield* repository.deleteByThreadId({ threadId: latest.threadId });
      assert.isTrue(Option.isNone(yield* repository.getByThreadId({ threadId: latest.threadId })));
    }),
  );

  it.effect("round-trips absent runtime details without storing nulls in the contract", () =>
    Effect.gen(function* () {
      const repository = yield* ExpertAppliedRuntimeRepository;
      const minimal = {
        threadId: ThreadId.makeUnsafe("thread-applied-runtime-minimal"),
        snapshotId: "snapshot-minimal",
        provider: "pi" as const,
        lifecycleGeneration: "generation-minimal",
        appliedAt: "2026-09-28T00:02:00.000Z",
      };

      yield* repository.upsert(minimal);
      const stored = yield* repository.getByThreadId({ threadId: minimal.threadId });
      assert.deepStrictEqual(Option.getOrUndefined(stored), minimal);
      yield* repository.deleteByThreadId({ threadId: minimal.threadId });
    }),
  );

  it.effect("lists every applied snapshot reference for owner migration inventory", () =>
    Effect.gen(function* () {
      const repository = yield* ExpertAppliedRuntimeRepository;
      const first = {
        ...record({
          snapshotId: "snapshot-inventory-first",
          lifecycleGeneration: "generation-inventory-first",
          appliedAt: "2026-09-28T00:03:00.000Z",
        }),
        threadId: ThreadId.makeUnsafe("thread-inventory-first"),
      };
      const second = {
        ...record({
          snapshotId: "snapshot-inventory-second",
          lifecycleGeneration: "generation-inventory-second",
          appliedAt: "2026-09-28T00:04:00.000Z",
        }),
        threadId: ThreadId.makeUnsafe("thread-inventory-second"),
      };
      yield* repository.upsert(first);
      yield* repository.upsert(second);

      assert.deepStrictEqual(yield* repository.listAll(), [first, second]);
      yield* repository.deleteByThreadId({ threadId: first.threadId });
      yield* repository.deleteByThreadId({ threadId: second.threadId });
    }),
  );
});
