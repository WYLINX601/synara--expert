import { Effect, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ThreadId, type ProviderSession } from "@synara/contracts";
import { describe, expect, it } from "vitest";
import { layerMemory } from "./persistence/NodeSqliteClient";
import type { OrchestrationProjectionCatchUpStatus } from "./orchestration/Services/OrchestrationEngine";
import { makeServerMaintenanceAdmission } from "./serverMaintenance";
import { makeServerMaintenanceInspection } from "./serverMaintenanceState";
import { ProjectionPendingInteraction } from "./persistence/Services/ProjectionPendingInteractions";

const healthy: OrchestrationProjectionCatchUpStatus = {
  state: "healthy",
  inFlight: false,
  retryAttempts: 0,
  lastFailure: null,
  highWaterSequence: 0,
  lagByProjector: {},
  missingProjectors: [],
};
const tableDefinitions = [
  "CREATE TABLE projection_turns (state TEXT)",
  "CREATE TABLE projection_thread_sessions (active_turn_id TEXT, status TEXT)",
  "CREATE TABLE queued_turn_promotions (state TEXT)",
  "CREATE TABLE automation_runs (status TEXT)",
  "CREATE TABLE orchestration_event_deliveries (state TEXT)",
  "CREATE TABLE expert_delegation_attempts (state TEXT)",
  "CREATE TABLE project_agent_work_items (state TEXT)",
  "CREATE TABLE provider_runtime_open_turns (turn_id TEXT)",
  "CREATE TABLE provider_runtime_events (sequence INTEGER)",
  "CREATE TABLE provider_runtime_event_consumers (last_acked_sequence INTEGER)",
  "CREATE TABLE provider_session_runtime (status TEXT)",
  "CREATE TABLE managed_attachment_blobs (state TEXT)",
  "CREATE TABLE pull_request_auto_fix (status TEXT)",
];
async function inspect(
  options: {
    readonly seed?: string;
    readonly health?: OrchestrationProjectionCatchUpStatus;
    readonly sessions?: readonly ProviderSession[];
    readonly nativeTasks?: boolean;
    readonly digestGenerations?: number;
    readonly terminalActivity?: number;
    readonly failedNativeProbe?: boolean;
    readonly failedProjectAgentProbe?: boolean;
    readonly nativeDispatches?: number;
    readonly runtimeCleanups?: number;
    readonly interactions?: readonly ProjectionPendingInteraction[];
  } = {},
) {
  return Effect.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      for (const statement of tableDefinitions) yield* sql.unsafe(statement);
      if (options.seed) yield* sql.unsafe(options.seed);
      return yield* makeServerMaintenanceInspection({
        sql,
        admission: makeServerMaintenanceAdmission(),
        engine: { getProjectionCatchUpStatus: Effect.succeed(options.health ?? healthy) },
        provider: {
          listSessions: () => Effect.succeed(options.sessions ?? []),
          listRetainedSessions: () => Effect.succeed([]),
          getRuntimeEventPumpHealth: () => Effect.succeed([]),
          getMaintenanceActivity: options.failedNativeProbe
            ? Effect.die("Native ownership probe failed")
            : Effect.succeed({
                dispatches: options.nativeDispatches ?? 0,
                nativeTasks: options.nativeTasks ? 1 : 0,
                runtimeCleanups: options.runtimeCleanups ?? 0,
                pendingRuntimeEvents: 0,
              }),
        },
        pendingInteractions: { listUnsettled: () => Effect.succeed(options.interactions ?? []) },
        terminal: { getMaintenanceActivity: Effect.succeed(options.terminalActivity ?? 0) },
        projectAgent: {
          getMaintenanceActivity: options.failedProjectAgentProbe
            ? Effect.die(new Error("Digest ownership probe failed"))
            : Effect.succeed({ digestGenerations: options.digestGenerations ?? 0 }),
        },
      });
    }).pipe(Effect.provide(layerMemory())),
  );
}

describe("authoritative backend maintenance inspection", () => {
  it("proves clean durable queues plus actual live-runtime activity", async () => {
    expect(await inspect()).toEqual({
      activeTurns: 0,
      pendingApprovals: 0,
      pendingUserInputs: 0,
      backgroundTasks: 0,
      acceptedWrites: 0,
    });
  });

  it.each(["unknown", "degraded"] as const)(
    "refuses %s projection health rather than treating it as idle",
    async (state) => {
      expect(await inspect({ health: { ...healthy, state } })).toBeNull();
    },
  );

  it("refuses a failed canonical native activity probe", async () => {
    expect(await inspect({ failedNativeProbe: true })).toBeNull();
  });

  it("refuses a defective required project-agent activity observer", async () => {
    expect(await inspect({ failedProjectAgentProbe: true })).toBeNull();
  });

  it.each([Number.NaN, -1, 0.5])(
    "refuses unknown project-agent activity %s",
    async (digestGenerations) => {
      expect(await inspect({ digestGenerations })).toBeNull();
    },
  );

  it.each([
    "INSERT INTO automation_runs VALUES ('running')",
    "INSERT INTO queued_turn_promotions VALUES ('queued')",
    "INSERT INTO orchestration_event_deliveries VALUES ('uncertain')",
    "INSERT INTO expert_delegation_attempts VALUES ('unknown')",
    "INSERT INTO project_agent_work_items VALUES ('waiting')",
    "INSERT INTO provider_runtime_events VALUES (1)",
    "INSERT INTO managed_attachment_blobs VALUES ('uploading')",
    "INSERT INTO pull_request_auto_fix VALUES ('fixing')",
  ])("blocks real durable background work: %s", async (seed) => {
    expect((await inspect({ seed }))?.backgroundTasks).toBeGreaterThan(0);
  });

  it.each([
    "INSERT INTO projection_turns VALUES ('running')",
    "INSERT INTO projection_thread_sessions VALUES (NULL, 'starting')",
    "INSERT INTO provider_session_runtime VALUES ('running')",
  ])("blocks durable in-flight turns even without a renderer session: %s", async (seed) => {
    expect((await inspect({ seed }))?.activeTurns).toBeGreaterThan(0);
  });

  it("counts background native tasks on an otherwise ready session", async () => {
    expect(
      (
        await inspect({
          nativeTasks: true,
          sessions: [
            {
              threadId: ThreadId.makeUnsafe("maintenance-native-thread"),
              provider: "omp",
              status: "ready",
              runtimeMode: "full-access",
              createdAt: "2026-11-13T00:00:00Z",
              updatedAt: "2026-11-13T00:00:00Z",
            },
          ],
        })
      )?.backgroundTasks,
    ).toBeGreaterThan(0);
  });

  it("counts unsettled approvals and user input even when no turn is running", async () => {
    const interactions = ["approval", "userInput"].map((interactionKind) =>
      Schema.decodeUnknownSync(ProjectionPendingInteraction)({
        interactionKind,
        requestId: `maintenance-${interactionKind}`,
        threadId: "maintenance-thread",
        turnId: null,
        lifecycleGeneration: null,
        status: "pending",
        decision: null,
        responseCommandId: null,
        responseRequestedAt: null,
        createdAt: "2026-11-13T00:00:00Z",
        resolvedAt: null,
      }),
    );
    expect(await inspect({ interactions })).toMatchObject({
      activeTurns: 0,
      pendingApprovals: 1,
      pendingUserInputs: 1,
    });
  });

  it("does not mistake a future auto-fix watch for an accepted running task", async () => {
    expect(
      (await inspect({ seed: "INSERT INTO pull_request_auto_fix VALUES ('watching')" }))
        ?.backgroundTasks,
    ).toBe(0);
  });

  it("counts actual digest and terminal process ownership, not future schedules", async () => {
    expect((await inspect({ digestGenerations: 1, terminalActivity: 1 }))?.backgroundTasks).toBe(2);
  });
  it("counts canonical native work even when adapter session listings are empty", async () => {
    expect((await inspect({ nativeTasks: true }))?.backgroundTasks).toBe(1);
    expect((await inspect({ nativeDispatches: 1 }))?.activeTurns).toBe(1);
    expect((await inspect({ runtimeCleanups: 1 }))?.backgroundTasks).toBe(1);
  });

  it("blocks unknown terminal process ownership", async () => {
    expect(await inspect({ terminalActivity: Number.NaN })).toBeNull();
  });
});
