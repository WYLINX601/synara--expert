import {
  EventId,
  RuntimeItemId,
  ThreadId,
  TurnId,
  type OrchestrationProjectShell,
  type OrchestrationThreadShell,
  type ProviderRuntimeEvent,
} from "@synara/contracts";
import { Effect, Layer, ManagedRuntime, Option } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { afterEach, describe, expect, it } from "vitest";
import type { ExpertLearningEvidenceCapture } from "./expertLearningEvidence.ts";
import { makeExpertLearningEvidenceDelivery } from "./expertLearningEvidenceDelivery.ts";
import {
  ProjectionSnapshotQuery,
  type ProjectionSnapshotQueryShape,
} from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";

const projectId = "delivery-project";
const expertId = "delivery-expert";
const snapshotId = "delivery-snapshot";
const lifecycleGeneration = "delivery-generation";
const oldEventTime = "2026-10-01T10:00:00.000Z";

type PendingRow = {
  readonly capture_id: string;
  readonly source_json: string;
  readonly record_json: string;
  readonly first_sequence: number;
  readonly last_sequence: number;
  readonly pending: number;
  readonly discarded: number;
  readonly updated_at: string;
};

type PreparedCapture = NonNullable<Parameters<ExpertLearningEvidenceCapture>[2]>;
type DeliveryService = Effect.Success<ReturnType<typeof makeExpertLearningEvidenceDelivery>>;
type DeliveryRuntime = ManagedRuntime.ManagedRuntime<
  SqlClient.SqlClient | ProjectionSnapshotQuery,
  unknown
>;

const runtimes: Array<{ dispose(): Promise<void> }> = [];

afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.dispose();
});

function threadId(value: string): ThreadId {
  return ThreadId.makeUnsafe(value);
}

function turnId(value: string): TurnId {
  return TurnId.makeUnsafe(value);
}

function makeHarness(capture: ExpertLearningEvidenceCapture, spaceId = "delivery-space") {
  let currentSpaceId = spaceId;
  const projection: Partial<ProjectionSnapshotQueryShape> = {
    getThreadShellById: (id) =>
      Effect.succeed(
        Option.some({
          id,
          projectId,
          modelSelection: { provider: "omp", instanceId: "omp", model: "gpt-5.4" },
          expertBinding: { expertId, snapshotId, displayName: "Delivery fixture", revision: 1 },
        } as unknown as OrchestrationThreadShell),
      ),
    getProjectShellById: () =>
      Effect.succeed(
        Option.some({
          id: projectId,
          spaceId: currentSpaceId,
        } as unknown as OrchestrationProjectShell),
      ),
  };
  const runtime = ManagedRuntime.make(
    Layer.mergeAll(
      SqlitePersistenceMemory,
      Layer.succeed(ProjectionSnapshotQuery, projection as ProjectionSnapshotQueryShape),
    ),
  );
  runtimes.push(runtime);

  return {
    runtime,
    setSpaceId: (value: string) => {
      currentSpaceId = value;
    },
    async services() {
      const sql = await runtime.runPromise(Effect.service(SqlClient.SqlClient));
      await runtime.runPromise(sql`
        INSERT INTO expert_learning_states (owner_id, expert_id, record_json, revision, updated_at)
        VALUES (
          'delivery-owner',
          ${expertId},
          ${JSON.stringify({ state: { enabled: true, harnessKind: "omp" } })},
          1,
          ${oldEventTime}
        )
      `);
      const delivery = await runtime.runPromise(makeExpertLearningEvidenceDelivery(capture));
      return { sql, delivery };
    },
  };
}

function startedEvent(
  thread: ThreadId,
  turn: TurnId,
  model = "gpt-5.5",
  effort: "medium" | "high" = "high",
): ProviderRuntimeEvent {
  return {
    type: "turn.started",
    eventId: EventId.makeUnsafe(`start-${turn}`),
    provider: "omp",
    providerInstanceId: "omp",
    lifecycleGeneration,
    threadId: thread,
    turnId: turn,
    createdAt: oldEventTime,
    payload: { model, effort },
  };
}

function reroutedEvent(thread: ThreadId, turn: TurnId): ProviderRuntimeEvent {
  return {
    type: "model.rerouted",
    eventId: EventId.makeUnsafe(`rerouted-${turn}`),
    provider: "omp",
    providerInstanceId: "omp",
    lifecycleGeneration,
    threadId: thread,
    turnId: turn,
    createdAt: "2026-10-01T10:00:01.000Z",
    payload: { fromModel: "gpt-5.4", toModel: "gpt-5.6", reason: "runtime fallback" },
  };
}

function completedEvent(thread: ThreadId, turn: TurnId): ProviderRuntimeEvent {
  return {
    type: "turn.completed",
    eventId: EventId.makeUnsafe(`complete-${turn}`),
    provider: "omp",
    providerInstanceId: "omp",
    lifecycleGeneration,
    threadId: thread,
    turnId: turn,
    createdAt: "2026-10-01T10:00:03.000Z",
    payload: { state: "completed" },
  };
}

function withRawPayload(
  event: ProviderRuntimeEvent,
  rawBody: string,
  secret: string,
): ProviderRuntimeEvent {
  return {
    ...event,
    providerRefs: {
      providerThreadId: "raw-provider-thread-marker",
      providerTurnId: "raw-provider-turn-marker",
    },
    raw: {
      source: "pi.sdk.event",
      method: "turn_event",
      messageType: event.type,
      payload: {
        output: rawBody,
        password: secret,
        rawOnlyField: "raw-only-property-marker",
      },
    },
  };
}

function toolEvent(
  thread: ThreadId,
  turn: TurnId,
  item: string,
  detail = "Tool completed.",
  data: unknown = { exitCode: 0 },
): ProviderRuntimeEvent {
  return {
    type: "item.completed",
    eventId: EventId.makeUnsafe(`tool-${item}`),
    provider: "omp",
    providerInstanceId: "omp",
    lifecycleGeneration,
    threadId: thread,
    turnId: turn,
    itemId: RuntimeItemId.makeUnsafe(item),
    createdAt: "2026-10-01T10:00:02.000Z",
    payload: {
      itemType: "command_execution",
      status: "completed",
      title: "Tool output",
      detail,
      data,
    },
  };
}

function entry(event: ProviderRuntimeEvent, sequence: number) {
  return { event, sequence };
}

async function enqueue(
  runtime: DeliveryRuntime,
  delivery: DeliveryService,
  event: ProviderRuntimeEvent,
  sequence: number,
) {
  await runtime.runPromise(delivery.enqueue(entry(event, sequence), event.turnId));
}

async function pendingRows(runtime: DeliveryRuntime, sql: SqlClient.SqlClient) {
  return runtime.runPromise(
    sql<PendingRow>`SELECT capture_id, source_json, record_json, first_sequence, last_sequence,
      pending, discarded, updated_at FROM expert_learning_pending_evidence ORDER BY first_sequence`,
  );
}

describe("Expert learning evidence delivery", () => {
  it("keeps failed captures pending, retries after rebuilding delivery, and continues other turns", async () => {
    const failedThread = threadId("delivery-failed-thread");
    const successfulThread = threadId("delivery-success-thread");
    const failedTurn = turnId("delivery-failed-turn");
    const successfulTurn = turnId("delivery-success-turn");
    let shouldFail = true;
    const attempts: Array<{ readonly thread: ThreadId; readonly prepared?: PreparedCapture }> = [];
    const capture: ExpertLearningEvidenceCapture = (persisted, _turn, prepared) =>
      Effect.gen(function* () {
        attempts.push({ thread: persisted.event.threadId, ...(prepared ? { prepared } : {}) });
        if (shouldFail && persisted.event.threadId === failedThread) {
          return yield* Effect.fail(new Error("temporary evidence write failure"));
        }
      });
    const harness = makeHarness(capture);
    const { sql, delivery } = await harness.services();

    await enqueue(harness.runtime, delivery, startedEvent(failedThread, failedTurn), 10);
    await enqueue(harness.runtime, delivery, reroutedEvent(failedThread, failedTurn), 11);
    await enqueue(harness.runtime, delivery, startedEvent(successfulThread, successfulTurn), 20);
    await harness.runtime.runPromise(delivery.drain);

    expect(attempts.map(({ thread }) => thread)).toEqual([failedThread, successfulThread]);
    let rows = await pendingRows(harness.runtime, sql);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ pending: 1, discarded: 0 });
    expect(Date.parse(rows[0]!.updated_at)).toBeGreaterThan(Date.parse("2026-10-01T10:00:01.000Z"));
    expect(rows[1]).toMatchObject({ pending: 0, discarded: 0 });
    const successfulPacket = JSON.parse(rows[1]!.record_json) as {
      readonly turnId: TurnId;
      readonly items: ReadonlyArray<unknown>;
      readonly coverage: ReadonlyArray<unknown>;
      readonly effort?: string;
    };
    expect(successfulPacket).toMatchObject({
      turnId: successfulTurn,
      items: [],
      coverage: [],
      effort: "high",
    });
    const firstPrepared = attempts[0]!.prepared!;
    expect(firstPrepared.source).toMatchObject({
      expertId,
      snapshotId,
      projectId,
      spaceId: "delivery-space",
      instanceId: "omp",
    });
    expect(firstPrepared.modelEvent).toMatchObject({
      type: "model.rerouted",
      payload: { toModel: "gpt-5.6" },
    });
    expect(firstPrepared.effort).toBe("high");

    shouldFail = false;
    const rebuilt = await harness.runtime.runPromise(makeExpertLearningEvidenceDelivery(capture));
    await harness.runtime.runPromise(rebuilt.drain);
    rows = await pendingRows(harness.runtime, sql);
    expect(rows[0]).toMatchObject({ pending: 0, discarded: 0 });
    const retriedPacket = JSON.parse(rows[0]!.record_json) as {
      readonly turnId: TurnId;
      readonly items: ReadonlyArray<unknown>;
      readonly coverage: ReadonlyArray<unknown>;
      readonly modelEvent?: ProviderRuntimeEvent;
      readonly effort?: string;
    };
    expect(retriedPacket).toMatchObject({
      turnId: failedTurn,
      items: [],
      coverage: [],
      modelEvent: { type: "model.rerouted", payload: { toModel: "gpt-5.6" } },
      effort: "high",
    });
    expect(attempts.map(({ thread }) => thread)).toEqual([
      failedThread,
      successfulThread,
      failedThread,
    ]);
    expect(attempts[2]!.prepared?.modelEvent).toMatchObject({
      type: "model.rerouted",
      payload: { toModel: "gpt-5.6" },
    });
  });

  it("reaches a good turn after more than one failed page", async () => {
    const thread = threadId("delivery-fairness-thread");
    const goodTurn = turnId("delivery-fairness-good-turn");
    const attempts: TurnId[] = [];
    const capture: ExpertLearningEvidenceCapture = (_persisted, resolvedTurnId) =>
      Effect.gen(function* () {
        if (!resolvedTurnId) return;
        attempts.push(resolvedTurnId);
        if (resolvedTurnId !== goodTurn) {
          return yield* Effect.fail(new Error("temporary evidence write failure"));
        }
      });
    const harness = makeHarness(capture);
    const { sql, delivery } = await harness.services();

    for (let index = 1; index <= 33; index += 1) {
      const turn = turnId(`delivery-fairness-failed-${index}`);
      await enqueue(harness.runtime, delivery, startedEvent(thread, turn), index);
    }
    await enqueue(harness.runtime, delivery, startedEvent(thread, goodTurn), 34);

    await harness.runtime.runPromise(delivery.drain);
    expect(attempts).toHaveLength(32);
    expect(attempts).not.toContain(goodTurn);

    await harness.runtime.runPromise(delivery.drain);
    expect(attempts).toHaveLength(34);
    expect(attempts).toContain(goodTurn);
    const rows = await pendingRows(harness.runtime, sql);
    const goodRow = rows.find((row) => row.first_sequence === 34);
    expect(goodRow).toMatchObject({ pending: 0, discarded: 0 });
    const goodPacket = JSON.parse(goodRow!.record_json) as {
      readonly turnId: TurnId;
      readonly items: ReadonlyArray<unknown>;
      readonly coverage: ReadonlyArray<unknown>;
    };
    expect(goodPacket).toMatchObject({ turnId: goodTurn, items: [], coverage: [] });
    expect(rows.find((row) => row.first_sequence === 33)).toMatchObject({ pending: 1 });
  });

  it("coalesces replayed rows and leaves a concurrent newer enqueue pending", async () => {
    const thread = threadId("delivery-cas-thread");
    const turn = turnId("delivery-cas-turn");
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let releaseCapture!: () => void;
    const release = new Promise<void>((resolve) => {
      releaseCapture = resolve;
    });
    const captures: Array<{ readonly sequence: number; readonly prepared?: PreparedCapture }> = [];
    let blockFirst = true;
    const capture: ExpertLearningEvidenceCapture = (persisted, _turn, prepared) =>
      Effect.promise(async () => {
        captures.push({ sequence: persisted.sequence, ...(prepared ? { prepared } : {}) });
        if (blockFirst) {
          blockFirst = false;
          markStarted();
          await release;
        }
      });
    const harness = makeHarness(capture);
    const { sql, delivery } = await harness.services();
    const start = startedEvent(thread, turn);
    const toolOne = toolEvent(thread, turn, "cas-tool-one");
    const toolTwo = toolEvent(thread, turn, "cas-tool-two");

    await enqueue(harness.runtime, delivery, start, 1);
    await enqueue(harness.runtime, delivery, toolOne, 2);
    await enqueue(harness.runtime, delivery, toolOne, 2);
    let rows = await pendingRows(harness.runtime, sql);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.last_sequence).toBe(2);
    const draining = harness.runtime.runPromise(delivery.drain);
    await started;
    await enqueue(harness.runtime, delivery, toolTwo, 3);
    releaseCapture();
    await draining;

    rows = await pendingRows(harness.runtime, sql);
    expect(rows[0]).toMatchObject({ pending: 1, last_sequence: 3 });
    const packetDuringRace = JSON.parse(rows[0]!.record_json) as {
      readonly items: ReadonlyArray<{ readonly id: string }>;
      readonly sequence: number;
    };
    expect(packetDuringRace.sequence).toBe(3);
    expect(packetDuringRace.items.map(({ id }) => id)).toEqual([
      "tool-result:cas-tool-one",
      "tool-result:cas-tool-two",
    ]);
    expect(captures[0]!.prepared?.modelEvent).toMatchObject({ payload: { model: "gpt-5.5" } });
    expect(captures[0]!.prepared?.effort).toBe("high");

    await harness.runtime.runPromise(delivery.drain);
    await enqueue(harness.runtime, delivery, toolTwo, 3);
    rows = await pendingRows(harness.runtime, sql);
    expect(rows[0]).toMatchObject({ pending: 0, discarded: 0 });
    const settledPacket = JSON.parse(rows[0]!.record_json) as {
      readonly turnId: TurnId;
      readonly items: ReadonlyArray<unknown>;
      readonly coverage: ReadonlyArray<unknown>;
      readonly sequence: number;
    };
    expect(settledPacket).toMatchObject({ turnId: turn, sequence: 3, items: [], coverage: [] });
    expect(JSON.stringify(settledPacket)).not.toContain("Tool completed.");
    expect(captures.map(({ sequence }) => sequence)).toEqual([2, 3]);
  });

  it("discards a turn when its fixed source space changes", async () => {
    const thread = threadId("delivery-source-thread");
    const turn = turnId("delivery-source-turn");
    const capture = () => Effect.void;
    const harness = makeHarness(capture);
    const { sql, delivery } = await harness.services();
    await enqueue(harness.runtime, delivery, startedEvent(thread, turn), 1);
    const original = (await pendingRows(harness.runtime, sql))[0]!;
    expect(JSON.parse(original.source_json)).toMatchObject({ spaceId: "delivery-space" });

    harness.setSpaceId("delivery-space-reassigned");
    await harness.runtime.runPromise(delivery.drain);
    let rows = await pendingRows(harness.runtime, sql);
    expect(rows[0]).toMatchObject({ pending: 0, discarded: 1, record_json: "{}" });
    expect(JSON.parse(rows[0]!.source_json)).toMatchObject({ spaceId: "delivery-space" });

    await enqueue(harness.runtime, delivery, reroutedEvent(thread, turn), 2);
    rows = await pendingRows(harness.runtime, sql);
    expect(rows[0]).toMatchObject({ pending: 0, discarded: 1, last_sequence: 1 });
    expect(JSON.parse(rows[0]!.source_json)).toMatchObject({ spaceId: "delivery-space" });
  });

  it("excludes raw provider payloads from pending and settled evidence packets", async () => {
    const thread = threadId("delivery-scrub-thread");
    const turn = turnId("delivery-scrub-turn");
    const capture = () => Effect.void;
    const harness = makeHarness(capture);
    const { sql, delivery } = await harness.services();
    const rawBody = `raw-only-output-${"R".repeat(100_000)}`;
    const secret = "raw-only-private-secret-value";
    const forbiddenValues = [
      rawBody,
      secret,
      "rawOnlyField",
      "raw-only-property-marker",
      "raw-provider-thread-marker",
      "raw-provider-turn-marker",
    ];
    const events = [
      withRawPayload(startedEvent(thread, turn), rawBody, secret),
      withRawPayload(
        toolEvent(thread, turn, "scrubbed-tool", "The tool returned bounded evidence.", {
          exitCode: 0,
          password: secret,
        }),
        rawBody,
        secret,
      ),
      withRawPayload(completedEvent(thread, turn), rawBody, secret),
    ] as const;

    const assertNoRawContent = (record: string) => {
      expect(record).not.toContain('"raw":');
      expect(record).not.toContain('"providerRefs":');
      for (const forbidden of forbiddenValues) expect(record).not.toContain(forbidden);
      const packet = JSON.parse(record) as {
        readonly event: ProviderRuntimeEvent;
        readonly modelEvent?: ProviderRuntimeEvent;
        readonly items: ReadonlyArray<{ readonly text: string; readonly truncated?: boolean }>;
        readonly coverage: ReadonlyArray<string>;
      };
      expect("raw" in packet.event).toBe(false);
      expect("providerRefs" in packet.event).toBe(false);
      if (packet.modelEvent) {
        expect("raw" in packet.modelEvent).toBe(false);
        expect("providerRefs" in packet.modelEvent).toBe(false);
      }
      return packet;
    };

    for (const [index, event] of events.entries()) {
      await enqueue(harness.runtime, delivery, event, index + 1);
      const row = (await pendingRows(harness.runtime, sql))[0]!;
      const packet = assertNoRawContent(row.record_json);
      expect(packet.event.type).toBe(event.type);
    }

    const pending = (await pendingRows(harness.runtime, sql))[0]!;
    const pendingPacket = assertNoRawContent(pending.record_json);
    expect(pending.pending).toBe(1);
    expect(pendingPacket.event.type).toBe("turn.completed");
    expect(pendingPacket.modelEvent).toMatchObject({
      type: "turn.started",
      payload: { model: "gpt-5.5", effort: "high" },
    });
    expect(pendingPacket.items).toHaveLength(1);
    expect(pendingPacket.items[0]!.text.length).toBeLessThanOrEqual(8_000);
    expect(pendingPacket.coverage).toContain("tool-result-credentials-redacted");
    expect(pending.record_json.length).toBeLessThan(rawBody.length);

    await harness.runtime.runPromise(delivery.drain);
    const settled = (await pendingRows(harness.runtime, sql))[0]!;
    const settledPacket = assertNoRawContent(settled.record_json);
    expect(settled.pending).toBe(0);
    expect(settledPacket).toMatchObject({
      turnId: turn,
      event: { type: "turn.completed", payload: { state: "completed" } },
      modelEvent: {
        type: "turn.started",
        payload: { model: "gpt-5.5", effort: "high" },
      },
      items: [],
      coverage: [],
    });
    expect(settled.record_json.length).toBeLessThan(rawBody.length);
  });

  it("stores bounded scrubbed tool output in the evidence delta", async () => {
    const thread = threadId("delivery-bounded-thread");
    const turn = turnId("delivery-bounded-turn");
    const capture = () => Effect.void;
    const harness = makeHarness(capture);
    const { sql, delivery } = await harness.services();
    const rawBody = "untrusted-tool-output-".repeat(1_000);
    await enqueue(harness.runtime, delivery, startedEvent(thread, turn), 1);
    await enqueue(
      harness.runtime,
      delivery,
      toolEvent(thread, turn, "bounded-tool", rawBody, {
        exitCode: 0,
        password: "private-secret-value",
      }),
      2,
    );

    const row = (await pendingRows(harness.runtime, sql))[0]!;
    const packet = JSON.parse(row.record_json) as {
      readonly items: ReadonlyArray<{ readonly text: string; readonly truncated?: boolean }>;
      readonly coverage: ReadonlyArray<string>;
      readonly event: ProviderRuntimeEvent;
    };
    expect(packet.items).toHaveLength(1);
    expect(packet.items[0]!.text.length).toBeLessThanOrEqual(8_000);
    expect(packet.items[0]!.truncated).toBe(true);
    expect(packet.coverage).toContain("tool-result-truncated");
    expect(row.record_json).not.toContain("private-secret-value");
    expect(row.record_json).not.toContain(rawBody);
    expect(packet.event).toMatchObject({ payload: { itemType: "command_execution" } });
    expect(row.record_json.length).toBeLessThan(rawBody.length);
  });
});
