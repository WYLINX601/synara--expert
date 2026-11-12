import { assert, it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { QueuedTurnPromotionRepository } from "../Services/QueuedTurnPromotions.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";
import { QueuedTurnPromotionRepositoryLive } from "./QueuedTurnPromotions.ts";

const layer = it.layer(
  QueuedTurnPromotionRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

layer("QueuedTurnPromotionRepository", (it) => {
  it.effect(
    "preserves priority, reclaims foreign owners, and permits a later message generation",
    () =>
      Effect.gen(function* () {
        const repository = yield* QueuedTurnPromotionRepository;
        const sql = yield* SqlClient.SqlClient;
        const now = "2026-07-14T00:00:00.000Z";
        const insertSourceEvent = (id: number) =>
          sql<{ readonly sequence: number }>`
          INSERT INTO orchestration_events (
            event_id, aggregate_kind, stream_id, stream_version, event_type,
            occurred_at, command_id, causation_event_id, correlation_id,
            actor_kind, payload_json, metadata_json
          ) VALUES (
            ${`evt-queued-promotion-${id}`}, 'thread', 'thread-queued-promotion', ${id - 1},
            'thread.turn-queued', ${now}, ${`cmd-queued-promotion-${id}`},
            NULL, NULL, 'server', '{}', '{}'
          )
          RETURNING sequence
        `.pipe(Effect.map((rows) => rows[0]!.sequence));

        const queuedSequence = yield* insertSourceEvent(1);
        const steerSequence = yield* insertSourceEvent(2);
        yield* repository.enqueue({
          queuedEventSequence: queuedSequence,
          threadId: "thread-queued-promotion",
          messageId: "message-queue",
          dispatchMode: "queue",
          createdAt: now,
        });
        yield* repository.enqueue({
          queuedEventSequence: steerSequence,
          threadId: "thread-queued-promotion",
          messageId: "message-steer",
          dispatchMode: "steer",
          createdAt: now,
        });

        const firstClaim = yield* repository.claimNext({
          threadId: "thread-queued-promotion",
          claimOwner: "owner-before-crash",
          claimedAt: now,
          claimExpiresAt: "2099-01-01T00:00:00.000Z",
        });
        assert.strictEqual(firstClaim.pipe(Option.getOrThrow).queuedEventSequence, steerSequence);

        const reclaimed = yield* repository.claimNext({
          threadId: "thread-queued-promotion",
          claimOwner: "owner-after-restart",
          claimedAt: now,
          claimExpiresAt: "2099-01-01T00:00:00.000Z",
        });
        assert.deepInclude(reclaimed.pipe(Option.getOrThrow), {
          queuedEventSequence: steerSequence,
          attemptCount: 2,
        });
        assert.isTrue(
          yield* repository.markPromoted({
            queuedEventSequence: steerSequence,
            claimOwner: "owner-after-restart",
            promotedAt: now,
          }),
        );

        const nextClaim = yield* repository.claimNext({
          threadId: "thread-queued-promotion",
          claimOwner: "owner-after-restart",
          claimedAt: now,
          claimExpiresAt: "2099-01-01T00:00:00.000Z",
        });
        assert.strictEqual(nextClaim.pipe(Option.getOrThrow).queuedEventSequence, queuedSequence);
        yield* repository.releaseClaim({
          queuedEventSequence: queuedSequence,
          claimOwner: "owner-after-restart",
          updatedAt: now,
        });

        const laterSteerSequence = yield* insertSourceEvent(3);
        yield* repository.enqueue({
          queuedEventSequence: laterSteerSequence,
          threadId: "thread-queued-promotion",
          messageId: "message-steer",
          dispatchMode: "steer",
          createdAt: now,
        });
        const laterGeneration = yield* repository.claimNext({
          threadId: "thread-queued-promotion",
          claimOwner: "owner-later-generation",
          claimedAt: now,
          claimExpiresAt: "2099-01-01T00:00:00.000Z",
        });
        assert.strictEqual(
          laterGeneration.pipe(Option.getOrThrow).queuedEventSequence,
          laterSteerSequence,
        );

        // `laterSteerSequence` is currently claimed ('promoting'). cancelThread now
        // widens to cancel BOTH 'queued' and 'promoting' rows, so the in-flight
        // claim is cancelled immediately -> nothing pending.
        yield* repository.cancelThread({
          threadId: "thread-queued-promotion",
          updatedAt: now,
        });
        assert.isFalse(
          yield* repository.hasPendingMessage({
            threadId: "thread-queued-promotion",
            messageId: "message-steer",
          }),
        );

        // The drain's error path releasing the (now cancelled) claim must NOT
        // resurrect it: releaseClaim only matches state='promoting', which the
        // cancelled row no longer is, so it reports no-op and the row stays dead.
        const released = yield* repository.releaseClaim({
          queuedEventSequence: laterSteerSequence,
          claimOwner: "owner-later-generation",
          updatedAt: now,
        });
        assert.isFalse(released);
        assert.isFalse(
          yield* repository.hasPendingMessage({
            threadId: "thread-queued-promotion",
            messageId: "message-steer",
          }),
        );
      }),
  );

  it.effect("retires only the claimed stale context and preserves the next user message", () =>
    Effect.gen(function* () {
      const repository = yield* QueuedTurnPromotionRepository;
      const sql = yield* SqlClient.SqlClient;
      const threadId = "thread-stale-native-context";
      const now = "2026-11-11T10:00:00.000Z";
      for (const [index, messageId] of ["stale-result", "next-user-request"].entries()) {
        const [event] = yield* sql<{ readonly sequence: number }>`
          INSERT INTO orchestration_events (
            event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
            command_id, causation_event_id, correlation_id, actor_kind, payload_json, metadata_json
          ) VALUES (
            ${`evt-stale-context-${index}`}, 'thread', ${threadId}, ${index}, 'thread.turn-queued', ${now},
            ${`cmd-stale-context-${index}`}, NULL, NULL, 'server', '{}', '{}'
          ) RETURNING sequence`;
        yield* repository.enqueue({
          queuedEventSequence: event!.sequence,
          threadId,
          messageId,
          dispatchMode: "queue",
          createdAt: now,
        });
      }
      const claim = yield* repository.claimNext({
        threadId,
        claimOwner: "current-owner",
        claimedAt: now,
        claimExpiresAt: "2099-01-01T00:00:00.000Z",
      });
      const sequence = Option.getOrThrow(claim).queuedEventSequence;
      assert.isFalse(
        yield* repository.cancelMessage({ threadId, messageId: "stale-result", updatedAt: now }),
      );
      assert.isFalse(
        yield* repository.cancelMessage({
          threadId,
          messageId: "stale-result",
          claimOwner: "foreign-owner",
          updatedAt: now,
        }),
      );
      assert.isTrue(
        yield* repository.cancelMessage({
          threadId,
          messageId: "stale-result",
          claimOwner: "current-owner",
          updatedAt: now,
        }),
      );
      assert.isFalse(
        yield* repository.releaseClaim({
          queuedEventSequence: sequence,
          claimOwner: "current-owner",
          updatedAt: now,
        }),
      );
      const next = yield* repository.claimNext({
        threadId,
        claimOwner: "current-owner",
        claimedAt: now,
        claimExpiresAt: "2099-01-01T00:00:00.000Z",
      });
      assert.strictEqual(Option.getOrThrow(next).messageId, "next-user-request");
      assert.isFalse(yield* repository.hasPendingMessage({ threadId, messageId: "stale-result" }));
    }),
  );
});
