import { assert, it } from "@effect/vitest";
import {
  MessageId,
  ProjectId,
  ThreadId,
  type HubWorkRecord,
  type OrchestrationThreadShell,
} from "@synara/contracts";

import { makeAgentCreationIds, stableGatewayDigest } from "../../agentGateway/creationUtils.ts";
import { delegatedAttachmentId } from "../../agentGateway/delegatedAttachments.ts";
import { renderHubWorkPrompt } from "../../agentGateway/hubWorkSource.ts";
import { matchesHubPlanInitialStart } from "./hubPlanInitialStart.ts";

const sourceThreadId = ThreadId.makeUnsafe("hub-coordinator");
const sourceMessageId = MessageId.makeUnsafe("human-source-message");
const workItemId = "hub-work:plan-attempt-1";
const operationId = `gateway:create:${stableGatewayDigest({
  principalKind: "hub-work",
  principalId: sourceThreadId,
  callerTurnId: `hub-work:${workItemId}`,
  requestId: workItemId,
})}`;
const ids = makeAgentCreationIds(operationId, 0);
const targetThreadId = ids.threadId;
const target = {
  provider: "codex",
  instanceId: "codex",
  model: "gpt-6.1-sol",
  options: { reasoningEffort: "low" },
} as const;
const sourceMessages: HubWorkRecord["sourceMessages"] = [
  {
    threadId: sourceThreadId,
    messageId: sourceMessageId,
    turnId: null,
    text: "Create a bounded report.",
    attachments: [
      {
        type: "file",
        id: "source-file-1",
        name: "notes.md",
        mimeType: "text/markdown",
        sizeBytes: 32,
      },
    ],
    createdAt: "2026-10-23T10:00:00.000Z",
    updatedAt: "2026-10-23T10:00:00.000Z",
  },
];
const work: HubWorkRecord = {
  id: workItemId,
  projectId: ProjectId.makeUnsafe("hub-plan-initial"),
  sourceThreadId,
  sourceMessageId,
  title: "Author",
  targetProjectId: ProjectId.makeUnsafe("hub-plan-initial"),
  requestId: workItemId,
  scopeKey: "plan-scope",
  fingerprint: "sha256:fingerprint",
  taskIndex: 0,
  creationSpec: {
    title: "Author",
    prompt: "Create a bounded report.",
    target,
    projectId: ProjectId.makeUnsafe("hub-plan-initial"),
    environment: "local",
    inheritedRuntimeMode: "approval-required",
  },
  sourceMessages,
  workerThreadId: targetThreadId,
  state: "working",
  queueReason: null,
  resultSummary: null,
  progress: null,
  slotHeld: true,
  admittedAt: "2026-10-23T10:01:00.000Z",
  admissionCommandId: null,
  admissionMessageId: null,
  admissionPreviousState: null,
  admissionPreviousSlotHeld: false,
  revision: 1,
  createdAt: "2026-10-23T10:00:00.000Z",
  updatedAt: "2026-10-23T10:01:00.000Z",
};
const shell: OrchestrationThreadShell = {
  id: targetThreadId,
  projectId: ProjectId.makeUnsafe("hub-plan-initial"),
  title: "Author",
  modelSelection: target,
  runtimeMode: "approval-required",
  interactionMode: "default",
  envMode: "local",
  branch: null,
  worktreePath: null,
  workingDirectory: null,
  associatedWorktreePath: null,
  associatedWorktreeBranch: null,
  associatedWorktreeRef: null,
  createBranchFlowCompleted: false,
  isPinned: false,
  parentThreadId: null,
  creationSource: "synara_mcp",
  sourceThreadId,
  sourceTurnId: null,
  gatewayOperationId: operationId,
  gatewayOperationIndex: 0,
  sidechatSourceThreadId: null,
  sidechatContext: null,
  sidechatLastActivityAt: null,
  sidechatExpiredAt: null,
  lastKnownPr: null,
  latestTurn: null,
  latestUserMessageAt: null,
  latestHumanMessageAt: null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  hasActionableProposedPlan: false,
  createdAt: "2026-10-23T10:00:00.000Z",
  updatedAt: "2026-10-23T10:00:00.000Z",
  settledAt: null,
  session: null,
  handoff: null,
};
const clonedAttachmentId = delegatedAttachmentId({
  dispatchKey: workItemId,
  targetThreadId,
  targetMessageId: ids.messageId,
  sourceThreadId,
  sourceMessageId,
  sourceAttachmentId: "source-file-1",
});
const initialTurn = {
  commandId: ids.turnStartCommandId,
  messageId: ids.messageId,
  messageText: renderHubWorkPrompt({
    workItemId,
    brief: work.creationSpec.prompt,
    sourceMessages,
  }),
  attachments: [
    {
      ...sourceMessages[0]!.attachments[0]!,
      id: clonedAttachmentId,
    },
  ],
  runtimeMode: "approval-required" as const,
  interactionMode: "default" as const,
  modelSelection: target,
  enableComputerControl: false,
  computerControlMode: "off",
  computerControlGeneration: 0,
  assistantDeliveryMode: "streaming",
  dispatchMode: "queue" as const,
  dispatchOrigin: "agent" as const,
};

it("admits only the exact server-created first turn for the current HubWork attempt", () => {
  const input = {
    threadId: targetThreadId,
    shell,
    coordinatorRuntimeMode: "approval-required" as const,
    work,
    turnStart: initialTurn,
  };
  assert.isTrue(matchesHubPlanInitialStart(input));

  assert.isFalse(
    matchesHubPlanInitialStart({
      ...input,
      shell: {
        ...shell,
        modelSelection: { provider: "codex", instanceId: "codex", model: "gpt-6.1-sol" },
      },
    }),
  );

  assert.isFalse(
    matchesHubPlanInitialStart({
      ...input,
      turnStart: { ...initialTurn, messageText: `${initialTurn.messageText}\nforged` },
    }),
  );
  assert.isFalse(
    matchesHubPlanInitialStart({
      ...input,
      turnStart: {
        ...initialTurn,
        modelSelection: { ...target, options: { reasoningEffort: "high" } },
      },
    }),
  );
  assert.isFalse(
    matchesHubPlanInitialStart({
      ...input,
      turnStart: {
        ...initialTurn,
        commandId: "hub-plan-input:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:command",
      },
    }),
  );
  assert.isFalse(
    matchesHubPlanInitialStart({
      ...input,
      turnStart: { ...initialTurn, runtimeMode: "full-access" },
    }),
  );
  assert.isFalse(
    matchesHubPlanInitialStart({
      ...input,
      turnStart: {
        ...initialTurn,
        enableComputerControl: true,
        computerControlMode: "request",
      },
    }),
  );
  assert.isFalse(
    matchesHubPlanInitialStart({
      ...input,
      turnStart: { ...initialTurn, providerOptions: { approvalPolicy: "always" } },
    }),
  );
  assert.isFalse(
    matchesHubPlanInitialStart({
      ...input,
      turnStart: { ...initialTurn, assistantDeliveryMode: "buffered" },
    }),
  );
  assert.isFalse(
    matchesHubPlanInitialStart({
      ...input,
      work: { ...work, state: "cancelled", slotHeld: false },
    }),
  );
});
