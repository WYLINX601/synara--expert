import { assert } from "@effect/vitest";
import { ProjectTaskAttemptId, ThreadId } from "@synara/contracts";
import { it } from "vitest";

import {
  hubPlanInputResponseDigest,
  matchesHubPlanInputResponseStart,
  renderHubPlanInputResponse,
  type HubPlanInputResponseAuthorization,
  type HubPlanInputResponseTurnStart,
} from "./hubPlanInput.ts";

const request = {
  id: "request-1",
  nodeKey: "author",
  stageKey: "draft",
  generation: 1,
  attemptId: ProjectTaskAttemptId.makeUnsafe("attempt-1"),
  workerThreadId: ThreadId.makeUnsafe("worker-1"),
  questions: [{ title: "Which format?", options: ["Markdown", "PDF"] }],
  status: "answered",
  answers: ["Markdown"],
  responseCommandId: "hub-plan-input:command-1",
  responseMessageId: "hub-plan-input:message-1",
  responseRuntimeMode: "approval-required",
  responseInteractionMode: "default",
  responseModelSelection: {
    provider: "codex",
    instanceId: "codex",
    model: "gpt-6.1-sol",
  },
  responseCreatedAt: "2026-10-23T10:00:00.000Z",
  updatedAt: "2026-10-23T10:00:00.000Z",
} as const;

const authorizedRequest: HubPlanInputResponseAuthorization = {
  ...request,
  responseMessageDigest: hubPlanInputResponseDigest(request),
};

const turnStart: HubPlanInputResponseTurnStart = {
  commandId: request.responseCommandId,
  messageId: request.responseMessageId,
  messageText: renderHubPlanInputResponse(request),
  attachments: [],
  runtimeMode: request.responseRuntimeMode,
  interactionMode: request.responseInteractionMode,
  modelSelection: request.responseModelSelection,
  enableComputerControl: false,
  computerControlMode: "off",
  computerControlGeneration: 0,
  assistantDeliveryMode: "streaming",
  dispatchMode: "queue",
  dispatchOrigin: "user",
  createdAt: request.responseCreatedAt,
};

const work = {
  slotHeld: true,
  admissionCommandId: request.responseCommandId,
  admissionMessageId: request.responseMessageId,
};

it("requires the exact persisted Hub answer and its reserved native admission", () => {
  assert.isTrue(matchesHubPlanInputResponseStart({ request: authorizedRequest, turnStart, work }));
  const deliveredRequest = {
    ...authorizedRequest,
    status: "delivered" as const,
    updatedAt: "2026-10-23T10:10:00.000Z",
  };
  assert.isTrue(
    matchesHubPlanInputResponseStart({ request: deliveredRequest, turnStart, work }),
    "delivering an accepted response may advance mutable updatedAt without changing its authorization time",
  );
  assert.isFalse(
    matchesHubPlanInputResponseStart({
      request: deliveredRequest,
      turnStart: { ...turnStart, createdAt: deliveredRequest.updatedAt },
      work,
    }),
    "the delivered timestamp must not be usable as a different native message timestamp",
  );
  assert.isFalse(
    matchesHubPlanInputResponseStart({
      request: authorizedRequest,
      turnStart: { ...turnStart, messageText: `${turnStart.messageText}\nextra instruction` },
      work,
    }),
  );
  assert.isFalse(
    matchesHubPlanInputResponseStart({
      request: authorizedRequest,
      turnStart: { ...turnStart, runtimeMode: "full-access" },
      work,
    }),
  );
  assert.isFalse(
    matchesHubPlanInputResponseStart({
      request: authorizedRequest,
      turnStart: {
        ...turnStart,
        modelSelection: { ...turnStart.modelSelection!, model: "different-model" },
      },
      work,
    }),
  );
  assert.isFalse(
    matchesHubPlanInputResponseStart({
      request: authorizedRequest,
      turnStart: { ...turnStart, attachments: [{ id: "unapproved-attachment" }] },
      work,
    }),
  );
  assert.isFalse(
    matchesHubPlanInputResponseStart({
      request: authorizedRequest,
      turnStart: { ...turnStart, providerOptions: { approvalPolicy: "never" } },
      work,
    }),
  );
  assert.isFalse(
    matchesHubPlanInputResponseStart({
      request: authorizedRequest,
      turnStart: {
        ...turnStart,
        enableComputerControl: true,
        computerControlMode: "request",
      },
      work,
    }),
  );
  assert.isFalse(
    matchesHubPlanInputResponseStart({
      request: authorizedRequest,
      turnStart: { ...turnStart, computerControlGeneration: 1 },
      work,
    }),
  );
  assert.isFalse(
    matchesHubPlanInputResponseStart({
      request: authorizedRequest,
      turnStart: { ...turnStart, assistantDeliveryMode: "buffered" },
      work,
    }),
  );
  assert.isFalse(
    matchesHubPlanInputResponseStart({
      request: authorizedRequest,
      turnStart: { ...turnStart, createdAt: "2026-10-23T10:00:01.000Z" },
      work,
    }),
  );
  assert.isFalse(
    matchesHubPlanInputResponseStart({
      request: authorizedRequest,
      turnStart,
      work: { ...work, admissionCommandId: "other-command" },
    }),
  );
  assert.isFalse(
    matchesHubPlanInputResponseStart({
      request: authorizedRequest,
      turnStart,
      work: { ...work, slotHeld: false },
    }),
  );
});
