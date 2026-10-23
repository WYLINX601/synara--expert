import type {
  ChatAttachment,
  HubWorkRecord,
  ModelSelection,
  OrchestrationThreadShell,
  RuntimeMode,
  ThreadId,
} from "@synara/contracts";
import {
  autoRuntimeModeSelectionIssue,
  runtimeModeEscalatesPrivilege,
} from "@synara/shared/runtimeMode";

import { makeAgentCreationIds, stableGatewayDigest } from "../../agentGateway/creationUtils.ts";
import { delegatedAttachmentId } from "../../agentGateway/delegatedAttachments.ts";
import { renderHubWorkPrompt } from "../../agentGateway/hubWorkSource.ts";
import type { ProjectAgentTurnStartAuthorization } from "../../projectAgent/Services/ProjectAgentService.ts";

const stableJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .toSorted(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
};

export const matchesHubWorkTargetSelection = (
  work: HubWorkRecord,
  selection: ModelSelection | undefined,
): boolean =>
  selection === undefined || stableJson(selection) === stableJson(work.creationSpec.target);

const expectedDelegatedAttachments = (input: {
  readonly workItemId: string;
  readonly targetThreadId: ThreadId;
  readonly targetMessageId: string;
  readonly sourceMessages: HubWorkRecord["sourceMessages"];
}): readonly ChatAttachment[] =>
  input.sourceMessages.flatMap((message) =>
    message.attachments.map((attachment) => {
      if (attachment.type === "assistant-selection") return attachment;
      return {
        ...attachment,
        id: delegatedAttachmentId({
          dispatchKey: input.workItemId,
          targetThreadId: input.targetThreadId,
          targetMessageId: input.targetMessageId,
          sourceThreadId: message.threadId,
          sourceMessageId: message.messageId,
          sourceAttachmentId: attachment.id,
        }),
      };
    }),
  );

export interface HubPlanInitialStartShell {
  readonly id: ThreadId;
  readonly projectId: string;
  readonly modelSelection: ModelSelection;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: OrchestrationThreadShell["interactionMode"];
  readonly creationSource?: OrchestrationThreadShell["creationSource"];
  readonly sourceThreadId?: OrchestrationThreadShell["sourceThreadId"];
  readonly sourceTurnId?: OrchestrationThreadShell["sourceTurnId"];
  readonly gatewayOperationId?: OrchestrationThreadShell["gatewayOperationId"];
  readonly gatewayOperationIndex?: OrchestrationThreadShell["gatewayOperationIndex"];
}

export const hubWorkTaskPrompt = (work: HubWorkRecord): string =>
  renderHubWorkPrompt({
    workItemId: work.id,
    brief: work.creationSpec.prompt,
    sourceMessages: work.sourceMessages,
  });

export const expectedHubWorkRuntimeMode = (
  work: HubWorkRecord,
  coordinatorRuntimeMode: RuntimeMode,
): RuntimeMode => {
  const inheritedRuntimeMode = work.creationSpec.inheritedRuntimeMode;
  const compatibleInheritedRuntimeMode =
    inheritedRuntimeMode !== undefined &&
    autoRuntimeModeSelectionIssue({
      runtimeMode: inheritedRuntimeMode,
      modelSelection: work.creationSpec.target,
    }) !== null
      ? "approval-required"
      : inheritedRuntimeMode;
  return (
    work.creationSpec.runtimeMode ??
    compatibleInheritedRuntimeMode ??
    (coordinatorRuntimeMode === "auto" ? "approval-required" : coordinatorRuntimeMode)
  );
};

export const expectedHubWorkInteractionMode = (
  work: HubWorkRecord,
): OrchestrationThreadShell["interactionMode"] =>
  work.creationSpec.target.provider === "opencode" &&
  work.creationSpec.target.options?.agent === "plan"
    ? "plan"
    : "default";

export const matchesHubWorkFrozenSettings = (input: {
  readonly work: HubWorkRecord;
  readonly shell: Pick<
    HubPlanInitialStartShell,
    "modelSelection" | "runtimeMode" | "interactionMode"
  >;
  readonly coordinatorRuntimeMode: RuntimeMode;
}): boolean => {
  const { work, shell, coordinatorRuntimeMode } = input;
  const expectedRuntimeMode = expectedHubWorkRuntimeMode(work, coordinatorRuntimeMode);
  return (
    !runtimeModeEscalatesPrivilege(coordinatorRuntimeMode, expectedRuntimeMode) &&
    stableJson(shell.modelSelection) === stableJson(work.creationSpec.target) &&
    shell.runtimeMode === expectedRuntimeMode &&
    shell.interactionMode === expectedHubWorkInteractionMode(work)
  );
};

export const matchesHubWorkThreadProvenance = (input: {
  readonly threadId: ThreadId;
  readonly shell: HubPlanInitialStartShell;
  readonly work: HubWorkRecord;
}): boolean => {
  const { threadId, shell, work } = input;
  if (
    work.workerThreadId !== threadId ||
    shell.id !== threadId ||
    shell.projectId !== work.targetProjectId ||
    shell.creationSource !== "synara_mcp" ||
    shell.sourceThreadId !== work.sourceThreadId ||
    shell.sourceTurnId !== (work.delegationTurnId ?? work.sourceMessages[0]?.turnId ?? null) ||
    shell.gatewayOperationIndex !== 0 ||
    shell.gatewayOperationId === null ||
    shell.gatewayOperationId === undefined
  ) {
    return false;
  }
  const operationId = `gateway:create:${stableGatewayDigest({
    principalKind: "hub-work",
    principalId: work.sourceThreadId,
    callerTurnId: `hub-work:${work.id}`,
    requestId: work.id,
  })}`;
  return (
    shell.gatewayOperationId === operationId &&
    makeAgentCreationIds(operationId, 0).threadId === threadId
  );
};

/**
 * Proves the one server-created initial HubWork turn for a plan attempt.
 * The deterministic creation identity is checked against immutable native
 * HubWork provenance and every effectful part of the dispatched turn.
 */
export const matchesHubPlanInitialStart = (input: {
  readonly threadId: ThreadId;
  readonly shell: HubPlanInitialStartShell;
  readonly coordinatorRuntimeMode: RuntimeMode;
  readonly work: HubWorkRecord | null;
  readonly turnStart: ProjectAgentTurnStartAuthorization;
}): boolean => {
  const { threadId, shell, coordinatorRuntimeMode, work, turnStart } = input;
  if (
    !work ||
    !matchesHubWorkThreadProvenance({ threadId, shell, work }) ||
    !work.slotHeld ||
    (work.state !== "starting" && work.state !== "working" && work.state !== "waiting") ||
    !matchesHubWorkFrozenSettings({ work, shell, coordinatorRuntimeMode })
  ) {
    return false;
  }

  const operationId = `gateway:create:${stableGatewayDigest({
    principalKind: "hub-work",
    principalId: work.sourceThreadId,
    callerTurnId: `hub-work:${work.id}`,
    requestId: work.id,
  })}`;
  if (shell.gatewayOperationId !== operationId) return false;
  const ids = makeAgentCreationIds(operationId, 0);
  if (ids.threadId !== threadId) return false;

  const target: ModelSelection = work.creationSpec.target;
  const expectedRuntimeMode = expectedHubWorkRuntimeMode(work, coordinatorRuntimeMode);
  if (turnStart.runtimeMode !== expectedRuntimeMode) return false;

  const expectedInteractionMode = expectedHubWorkInteractionMode(work);
  const expectedPrompt = hubWorkTaskPrompt(work);
  const attachments = expectedDelegatedAttachments({
    workItemId: work.id,
    targetThreadId: threadId,
    targetMessageId: ids.messageId,
    sourceMessages: work.sourceMessages,
  });
  const hasNoEntries = (value: readonly unknown[] | undefined) =>
    value === undefined || value.length === 0;
  return Boolean(
    turnStart.commandId === ids.turnStartCommandId &&
    turnStart.messageId === ids.messageId &&
    turnStart.messageText === expectedPrompt &&
    turnStart.dispatchOrigin === "agent" &&
    turnStart.dispatchMode === "queue" &&
    turnStart.interactionMode === expectedInteractionMode &&
    turnStart.modelSelection !== undefined &&
    stableJson(turnStart.modelSelection) === stableJson(target) &&
    turnStart.attachments !== undefined &&
    stableJson(turnStart.attachments) === stableJson(attachments) &&
    hasNoEntries(turnStart.skills) &&
    hasNoEntries(turnStart.mentions) &&
    turnStart.providerOptions === undefined &&
    turnStart.enableComputerControl === false &&
    turnStart.computerControlMode === "off" &&
    turnStart.computerControlGeneration === 0 &&
    turnStart.assistantDeliveryMode === "streaming" &&
    turnStart.reviewTarget === undefined &&
    turnStart.sourceProposedPlan === undefined &&
    turnStart.asyncUserInputResponse === undefined &&
    turnStart.resumePrecondition === undefined,
  );
};
