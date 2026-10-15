import { createHash } from "node:crypto";

import type { OrchestrationEvent, OrchestrationThread } from "@synara/contracts";

export type ContextExecutionEvent = Extract<
  OrchestrationEvent,
  {
    type: "thread.turn-start-requested" | "thread.goal-continuation-requested";
  }
>;

export interface ContextExecutionWorkspace {
  readonly projectWorkspaceRoot: string;
  readonly effectiveCwd: string | null;
}

/** Hash only execution inputs, excluding mutable session/turn status and current config. */
export function contextExecutionInputDigest(
  event: ContextExecutionEvent,
  thread: OrchestrationThread,
  workspace: ContextExecutionWorkspace,
): string {
  const messageId = event.type === "thread.turn-start-requested" ? event.payload.messageId : null;
  const message =
    messageId === null ? null : thread.messages.find((entry) => entry.id === messageId);
  return createHash("sha256")
    .update(
      JSON.stringify({
        payload: event.payload,
        message: message
          ? {
              id: message.id,
              text: message.text,
              attachments: message.attachments ?? [],
              skills: message.skills ?? [],
              mentions: message.mentions ?? [],
            }
          : null,
        notes: thread.notes,
        modelSelection: thread.modelSelection,
        runtimeMode: thread.runtimeMode,
        interactionMode: thread.interactionMode,
        goal: thread.goal,
        workspace: {
          ...workspace,
          projectId: thread.projectId,
          envMode: thread.envMode,
          worktreePath: thread.worktreePath,
          workingDirectory: thread.workingDirectory,
          branch: thread.branch,
        },
      }),
    )
    .digest("hex");
}
