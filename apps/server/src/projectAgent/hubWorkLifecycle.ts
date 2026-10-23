import type {
  HubWorkRecord,
  OrchestrationThreadShell,
  ProjectManagedWorker,
} from "@synara/contracts";
import {
  canSessionAnswerPendingRequests,
  isThreadActivelyWorking,
} from "@synara/shared/groupThreadState";
import type { ProjectionThreadMessage } from "../persistence/Services/ProjectionThreadMessages";
import type { ProjectionTurnById } from "../persistence/Services/ProjectionTurns";

export interface HubWorkLifecycleInput {
  readonly record: HubWorkRecord;
  readonly shell: OrchestrationThreadShell | null;
  readonly worker: ProjectManagedWorker | null;
  readonly hasPendingTurn: boolean;
  readonly admissionMessage: Pick<ProjectionThreadMessage, "startsNewTurn" | "turnId"> | null;
  readonly resolvedAdmissionTurn?: Pick<
    ProjectionTurnById,
    "threadId" | "turnId" | "pendingMessageId" | "state" | "completedAt"
  > | null;
}

function hasLiveWork(shell: OrchestrationThreadShell): boolean {
  return (
    isThreadActivelyWorking(shell) ||
    shell.session?.status === "starting" ||
    (shell.latestTurn?.state === "running" &&
      !["stopped", "error", "interrupted"].includes(shell.session?.status ?? "idle"))
  );
}

function admissionHasSettled(input: HubWorkLifecycleInput): boolean {
  const { record, shell, admissionMessage } = input;
  if (!record.admittedAt || !shell) return false;
  const terminalSession =
    shell.session &&
    ["error", "stopped", "interrupted"].includes(shell.session.status) &&
    shell.session.updatedAt >= record.admittedAt;
  const steeredTurn =
    admissionMessage?.startsNewTurn === false &&
    shell.latestTurn?.completedAt &&
    shell.latestTurn.completedAt >= record.admittedAt &&
    (admissionMessage.turnId === null || admissionMessage.turnId === shell.latestTurn.turnId);
  const resolvedNewTurn =
    admissionMessage?.startsNewTurn === true &&
    admissionMessage.turnId === null &&
    record.workerThreadId !== null &&
    record.admissionMessageId !== null &&
    input.resolvedAdmissionTurn?.threadId === record.workerThreadId &&
    input.resolvedAdmissionTurn.turnId === shell.latestTurn?.turnId &&
    input.resolvedAdmissionTurn.pendingMessageId === record.admissionMessageId &&
    input.resolvedAdmissionTurn.state === "completed" &&
    input.resolvedAdmissionTurn.completedAt !== null &&
    input.resolvedAdmissionTurn.completedAt >= record.admittedAt;
  const completedAdmittedTurn =
    admissionMessage?.startsNewTurn === true &&
    shell.latestTurn?.state === "completed" &&
    shell.latestTurn.turnId ===
      (admissionMessage.turnId ?? (resolvedNewTurn ? input.resolvedAdmissionTurn?.turnId : null)) &&
    shell.latestTurn.completedAt !== null &&
    shell.latestTurn.completedAt >= record.admittedAt;
  return Boolean(terminalSession || steeredTurn || completedAdmittedTurn);
}

export function resolveHubWorkLifecycle(
  input: HubWorkLifecycleInput,
): Partial<HubWorkRecord> | null {
  const { record, shell, worker, hasPendingTurn } = input;
  const waiting =
    shell &&
    (shell.hasPendingApprovals || shell.hasPendingUserInput) &&
    canSessionAnswerPendingRequests(shell.session);
  const busy =
    shell && shell.archivedAt === null && (hasPendingTurn || waiting || hasLiveWork(shell));
  // Cancelling the delegated task does not prevent a person from reopening its thread.
  if (record.state === "cancelled") return { state: "cancelled", slotHeld: Boolean(busy) };
  if (!shell) return { state: "failed", slotHeld: false };
  if (shell.archivedAt !== null) return { state: "cancelled", slotHeld: false };
  if (hasPendingTurn) return { state: "working", slotHeld: true };
  if (waiting) return { state: "waiting", slotHeld: true };
  if (hasLiveWork(shell))
    return { state: worker?.needsYou ? "waiting" : "working", slotHeld: true };
  if (
    record.slotHeld &&
    record.admittedAt &&
    (!shell.latestTurn || shell.latestTurn.requestedAt < record.admittedAt) &&
    !admissionHasSettled(input)
  )
    return null;
  const update: Partial<HubWorkRecord> = {
    slotHeld: false,
    admittedAt: null,
    admissionCommandId: null,
    admissionMessageId: null,
    admissionPreviousState: null,
    admissionPreviousSlotHeld: false,
  };
  if (worker?.needsYou) return { ...update, state: "waiting" };
  if (shell.session?.status === "error" || shell.latestTurn?.state === "error")
    return { ...update, state: "failed" };
  if (
    shell.latestTurn?.state === "completed" &&
    worker?.resultAt &&
    worker.resultAt >= shell.latestTurn.requestedAt
  )
    return {
      ...update,
      state: "completed",
      resultSummary: worker.resultSummary?.slice(0, 4_000) ?? null,
    };
  return { ...update, state: "idle" };
}
