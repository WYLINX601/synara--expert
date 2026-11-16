import type { LinxUpdateBusyState } from "@synara/contracts";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { OrchestrationEngineShape } from "./orchestration/Services/OrchestrationEngine";
import type { ProviderServiceShape } from "./provider/Services/ProviderService";
import type { ProjectionPendingInteractionRepositoryShape } from "./persistence/Services/ProjectionPendingInteractions";
import type { ServerMaintenanceAdmission } from "./serverMaintenance";
import type { TerminalManagerShape } from "./terminal/Services/Manager";
import type { ProjectAgentServiceShape } from "./projectAgent/Services/ProjectAgentService";

/** Probes live native ownership and durable work, not just a renderer snapshot. */
export function makeServerMaintenanceInspection(input: {
  readonly engine: Pick<OrchestrationEngineShape, "getProjectionCatchUpStatus">;
  readonly provider: Pick<
    ProviderServiceShape,
    "listSessions" | "listRetainedSessions" | "getMaintenanceActivity" | "getRuntimeEventPumpHealth"
  >;
  readonly pendingInteractions: Pick<ProjectionPendingInteractionRepositoryShape, "listUnsettled">;
  readonly sql: SqlClient.SqlClient;
  readonly admission: ServerMaintenanceAdmission;
  readonly terminal: Pick<TerminalManagerShape, "getMaintenanceActivity">;
  readonly projectAgent: Pick<ProjectAgentServiceShape, "getMaintenanceActivity">;
}): Effect.Effect<LinxUpdateBusyState | null> {
  return Effect.gen(function* () {
    const health = yield* input.engine.getProjectionCatchUpStatus;
    if (
      health.state !== "healthy" ||
      health.inFlight ||
      health.missingProjectors.length !== 0 ||
      Object.values(health.lagByProjector).some((lag) => lag !== 0)
    )
      return null;
    if (!input.provider.listRetainedSessions || !input.provider.getRuntimeEventPumpHealth)
      return null;
    const native = yield* input.provider.getMaintenanceActivity;
    if (Object.values(native).some((count) => !Number.isSafeInteger(count) || count < 0))
      return null;
    if (!input.terminal.getMaintenanceActivity) return null;
    const terminalActivity = yield* input.terminal.getMaintenanceActivity;
    if (!Number.isSafeInteger(terminalActivity) || terminalActivity < 0) return null;
    const projectAgentActivity = yield* input.projectAgent.getMaintenanceActivity;
    const pumps = yield* input.provider.getRuntimeEventPumpHealth();
    if (pumps.some((pump) => pump.status !== "healthy" || (pump.quarantinedEvents ?? 0) !== 0))
      return null;
    const sessions = yield* input.provider.listSessions();
    const retained = yield* input.provider.listRetainedSessions();
    if (retained.length !== 0) return null;
    let activeTurns = 0;
    for (const session of sessions) {
      if (session.status === "error") return null;
      if (session.activeTurnId || session.status === "running" || session.status === "connecting")
        activeTurns += 1;
    }
    const unsettled = yield* input.pendingInteractions.listUnsettled({});
    const rows = yield* input.sql<{
      readonly turns: number;
      readonly queued: number;
      readonly automation: number;
      readonly deliveries: number;
      readonly delegations: number;
      readonly hubWork: number;
      readonly runtimeEvents: number;
      readonly runtimeSessions: number;
      readonly uploads: number;
      readonly autoFix: number;
    }>`SELECT
      (SELECT count(*) FROM projection_turns WHERE state NOT IN ('completed', 'interrupted', 'error')) +
      (SELECT count(*) FROM projection_thread_sessions WHERE active_turn_id IS NOT NULL OR status NOT IN ('idle', 'ready', 'interrupted', 'stopped')) AS turns,
      (SELECT count(*) FROM queued_turn_promotions WHERE state NOT IN ('promoted', 'cancelled')) AS queued,
      (SELECT count(*) FROM automation_runs WHERE status NOT IN ('succeeded', 'failed', 'cancelled', 'interrupted', 'skipped')) AS automation,
      (SELECT count(*) FROM orchestration_event_deliveries WHERE state <> 'succeeded') AS deliveries,
      (SELECT count(*) FROM expert_delegation_attempts WHERE state NOT IN ('completed', 'failed', 'stopped')) AS delegations,
      (SELECT count(*) FROM project_agent_work_items WHERE state NOT IN ('completed', 'failed', 'cancelled')) AS hubWork,
      (SELECT count(*) FROM provider_runtime_open_turns) +
      (SELECT count(*) FROM provider_runtime_events WHERE sequence > COALESCE((SELECT min(last_acked_sequence) FROM provider_runtime_event_consumers), 0)) AS runtimeEvents,
      (SELECT count(*) FROM provider_session_runtime WHERE status NOT IN ('ready', 'idle', 'stopped', 'closed')) AS runtimeSessions,
      (SELECT count(*) FROM managed_attachment_blobs WHERE state IN ('uploading', 'deleting')) AS uploads,
      (SELECT count(*) FROM pull_request_auto_fix WHERE status NOT IN ('watching', 'paused')) AS autoFix`;
    const row = rows[0];
    if (!row || Object.values(row).some((count) => !Number.isSafeInteger(count) || count < 0))
      return null;
    if (
      !Number.isSafeInteger(projectAgentActivity.digestGenerations) ||
      projectAgentActivity.digestGenerations < 0
    )
      return null;
    return {
      activeTurns: activeTurns + native.dispatches + row.turns + row.runtimeSessions,
      pendingApprovals: unsettled.filter((item) => item.interactionKind === "approval").length,
      pendingUserInputs: unsettled.filter((item) => item.interactionKind === "userInput").length,
      backgroundTasks:
        native.nativeTasks +
        native.runtimeCleanups +
        native.pendingRuntimeEvents +
        input.admission.backgroundActive +
        terminalActivity +
        projectAgentActivity.digestGenerations +
        row.queued +
        row.automation +
        row.deliveries +
        row.delegations +
        row.hubWork +
        row.runtimeEvents +
        row.uploads +
        row.autoFix,
      acceptedWrites: input.admission.active,
    };
  }).pipe(Effect.catchCause(() => Effect.succeed(null)));
}
