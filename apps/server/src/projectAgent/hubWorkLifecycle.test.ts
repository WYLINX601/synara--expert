import {
  MessageId,
  ProjectId,
  ThreadId,
  TurnId,
  type HubWorkRecord,
  type OrchestrationThreadShell,
  type ProjectManagedWorker,
} from "@synara/contracts";
import { describe, expect, it } from "vitest";

import type { ProjectionThreadMessage } from "../persistence/Services/ProjectionThreadMessages";
import { resolveHubWorkLifecycle } from "./hubWorkLifecycle";

const requestedAt = "2026-10-23T12:50:58.575Z";
const admittedAt = "2026-10-23T12:51:00.000Z";
const completedAt = "2026-10-23T12:52:05.000Z";
const threadId = ThreadId.makeUnsafe("thread-answer-recovery");
const turnId = TurnId.makeUnsafe("turn-answer-recovery");

const record = {
  id: "hub-work:answer-recovery",
  projectId: ProjectId.makeUnsafe("hub-answer-recovery"),
  sourceThreadId: ThreadId.makeUnsafe("thread-answer-coordinator"),
  sourceMessageId: null,
  title: "Continue draft",
  workerThreadId: threadId,
  state: "working",
  queueReason: null,
  resultSummary: null,
  progress: null,
  targetProjectId: ProjectId.makeUnsafe("project-answer-recovery"),
  requestId: "request-answer-recovery",
  scopeKey: "answer-recovery",
  fingerprint: "sha256:answer-recovery",
  taskIndex: 0,
  creationSpec: {},
  sourceMessages: [],
  slotHeld: true,
  admittedAt,
  admissionCommandId: "answer-command",
  admissionMessageId: "answer-message",
  admissionPreviousState: "waiting",
  admissionPreviousSlotHeld: false,
  revision: 2,
  createdAt: requestedAt,
  updatedAt: admittedAt,
} as unknown as HubWorkRecord;

function shell(input: {
  readonly latestTurnState?: "running" | "completed";
  readonly latestTurnId?: TurnId;
  readonly completedAt?: string | null;
}) {
  const latestTurnState = input.latestTurnState ?? "completed";
  return {
    id: threadId,
    projectId: record.targetProjectId,
    title: "Continue draft",
    modelSelection: { provider: "codex", model: "fixture" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    archivedAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    session: {
      status: latestTurnState === "running" ? "running" : "idle",
      activeTurnId: latestTurnState === "running" ? (input.latestTurnId ?? turnId) : null,
      updatedAt: input.completedAt ?? completedAt,
    },
    latestTurn: {
      turnId: input.latestTurnId ?? turnId,
      state: latestTurnState,
      requestedAt,
      startedAt: requestedAt,
      completedAt: latestTurnState === "completed" ? (input.completedAt ?? completedAt) : null,
    },
  } as unknown as OrchestrationThreadShell;
}

function inputFor(input: {
  readonly shell?: OrchestrationThreadShell;
  readonly messageTurnId?: TurnId | null;
  readonly startsNewTurn?: boolean;
  readonly worker?: ProjectManagedWorker | null;
}) {
  return {
    record,
    shell: input.shell ?? shell({}),
    worker: input.worker ?? null,
    hasPendingTurn: false,
    admissionMessage: {
      startsNewTurn: input.startsNewTurn ?? true,
      turnId: input.messageTurnId === undefined ? turnId : input.messageTurnId,
    } as Pick<ProjectionThreadMessage, "startsNewTurn" | "turnId">,
  };
}

describe("HubWork lifecycle admission settlement", () => {
  it("releases an exact completed admitted turn whose request predates the reservation", () => {
    const update = resolveHubWorkLifecycle(inputFor({ shell: shell({}) }));

    expect(update?.state).toBe("idle");
    expect(update?.slotHeld).toBe(false);
    expect(update?.admittedAt).toBeNull();
    expect(update?.admissionCommandId).toBeNull();
    expect(update?.admissionMessageId).toBeNull();
  });

  it("uses an exact native turn association to resolve a null message turn ID", () => {
    const update = resolveHubWorkLifecycle({
      ...inputFor({ shell: shell({}), messageTurnId: null }),
      resolvedAdmissionTurn: {
        threadId,
        turnId,
        pendingMessageId: record.admissionMessageId,
        state: "completed",
        completedAt,
      },
    });

    expect(update?.state).toBe("idle");
    expect(update?.slotHeld).toBe(false);
  });

  it("rejects a resolved turn association for another source message", () => {
    const update = resolveHubWorkLifecycle({
      ...inputFor({ shell: shell({}), messageTurnId: null }),
      resolvedAdmissionTurn: {
        threadId,
        turnId,
        pendingMessageId: MessageId.makeUnsafe("other-message"),
        state: "completed",
        completedAt,
      },
    });

    expect(update).toBeNull();
  });

  it.each([
    [
      "completion before the reservation",
      shell({ completedAt: "2026-10-23T12:50:59.999Z" }),
      turnId,
    ],
    ["missing turn identity", shell({}), null],
    ["different turn identity", shell({}), TurnId.makeUnsafe("turn-other")],
    ["missing admission message", shell({}), undefined],
  ] as const)("keeps the reservation for %s", (_case, latestShell, messageTurnId) => {
    const message =
      messageTurnId === undefined
        ? null
        : ({ startsNewTurn: true, turnId: messageTurnId } as Pick<
            ProjectionThreadMessage,
            "startsNewTurn" | "turnId"
          >);
    const update = resolveHubWorkLifecycle({
      ...inputFor({ shell: latestShell }),
      admissionMessage: message,
    });

    expect(update).toBeNull();
  });

  it("keeps a matching but still-running admitted turn reserved", () => {
    const update = resolveHubWorkLifecycle(
      inputFor({ shell: shell({ latestTurnState: "running" }) }),
    );

    expect(update?.state).toBe("working");
    expect(update?.slotHeld).toBe(true);
  });

  it("completes only when the matching native turn has a saved result", () => {
    const worker = {
      resultAt: "2026-10-23T12:51:30.000Z",
      resultSummary: "The draft is complete.",
      needsYou: false,
    } as unknown as ProjectManagedWorker;
    const update = resolveHubWorkLifecycle(inputFor({ shell: shell({}), worker }));

    expect(update?.state).toBe("completed");
    expect(update?.slotHeld).toBe(false);
    expect(update?.resultSummary).toBe("The draft is complete.");
  });
});
