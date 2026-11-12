import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  ProjectId,
  ThreadId,
  type ExpertBinding,
} from "@synara/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const at = "2026-09-25T00:00:00.000Z";
const projectId = ProjectId.makeUnsafe("expert-project");
const sourceId = ThreadId.makeUnsafe("expert-source");
const continuationId = ThreadId.makeUnsafe("expert-continuation");
const first: ExpertBinding = {
  expertId: "reviewer",
  snapshotId: "exp_first",
  displayName: "Reviewer",
  revision: 1,
};
const updated: ExpertBinding = { ...first, snapshotId: "exp_second", revision: 2 };

async function readModel() {
  const project = await Effect.runPromise(
    projectEvent(createEmptyReadModel(at), {
      sequence: 1,
      eventId: EventId.makeUnsafe("expert-project-created"),
      aggregateKind: "project",
      aggregateId: projectId,
      type: "project.created",
      occurredAt: at,
      commandId: CommandId.makeUnsafe("expert-project-command"),
      causationEventId: null,
      correlationId: CommandId.makeUnsafe("expert-project-command"),
      metadata: {},
      payload: {
        projectId,
        kind: "project",
        title: "Experts",
        workspaceRoot: "/tmp/expert-project",
        defaultModelSelection: null,
        scripts: [],
        createdAt: at,
        updatedAt: at,
      },
    }),
  );
  return Effect.runPromise(
    projectEvent(project, {
      sequence: 2,
      eventId: EventId.makeUnsafe("expert-source-created"),
      aggregateKind: "thread",
      aggregateId: sourceId,
      type: "thread.created",
      occurredAt: at,
      commandId: CommandId.makeUnsafe("expert-source-command"),
      causationEventId: null,
      correlationId: CommandId.makeUnsafe("expert-source-command"),
      metadata: {},
      payload: {
        threadId: sourceId,
        projectId,
        title: "Review",
        modelSelection: { provider: "codex", model: "gpt-5-codex" },
        runtimeMode: "full-access",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        envMode: "local",
        branch: null,
        worktreePath: null,
        expertBinding: first,
        parentThreadId: null,
        subagentAgentId: null,
        subagentNickname: null,
        subagentRole: null,
        forkSourceThreadId: null,
        sidechatSourceThreadId: null,
        handoff: null,
        createdAt: at,
        updatedAt: at,
      },
    }),
  );
}

describe("expert thread binding", () => {
  it("saves an Expert draft without freezing its snapshot before first send", async () => {
    const model = await readModel();
    const command = {
      type: "thread.create" as const,
      commandId: CommandId.makeUnsafe("expert-create-command"),
      threadId: continuationId,
      projectId,
      expertId: "reviewer",
      title: "Next review",
      modelSelection: { provider: "codex" as const, model: "gpt-5-codex" },
      runtimeMode: "full-access" as const,
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      envMode: "local" as const,
      branch: null,
      worktreePath: null,
      createdAt: at,
    };
    const created = await Effect.runPromise(
      decideOrchestrationCommand({ command, readModel: model }),
    );
    expect(Array.isArray(created) ? created[0] : created).toMatchObject({
      type: "thread.created",
      payload: { expertBinding: null, expertDraftSelection: { expertId: "reviewer", suite: null } },
    });
  });

  it.each(["pi", "claudeAgent", "omp"] as const)(
    "inherits a fixed snapshot or uses a newly prepared snapshot on %s continuation",
    async (provider) => {
      const model = await readModel();
      const command = {
        type: "thread.handoff.create" as const,
        commandId: CommandId.makeUnsafe("expert-handoff-command"),
        threadId: continuationId,
        sourceThreadId: sourceId,
        projectId,
        title: "Continue review",
        modelSelection: { provider, model: "selected-test-model" },
        runtimeMode: "full-access" as const,
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        envMode: "local" as const,
        branch: null,
        worktreePath: null,
        importedMessages: [],
        createdAt: at,
      };
      const inherited = await Effect.runPromise(
        decideOrchestrationCommand({ command, readModel: model }),
      );
      expect(Array.isArray(inherited) ? inherited[0] : inherited).toMatchObject({
        payload: { expertBinding: first },
      });
      const refreshed = await Effect.runPromise(
        decideOrchestrationCommand({
          command: { ...command, expertId: "reviewer" },
          readModel: model,
          expertBinding: updated,
        }),
      );
      expect(Array.isArray(refreshed) ? refreshed[0] : refreshed).toMatchObject({
        payload: { expertBinding: updated },
      });
    },
  );

  it("does not authorize an untrusted draft by its chosen parent thread", async () => {
    const model = await readModel();
    const command = {
      type: "thread.create" as const,
      commandId: CommandId.makeUnsafe("untrusted-child"),
      threadId: continuationId,
      projectId,
      parentThreadId: sourceId,
      title: "Child draft",
      modelSelection: { provider: "omp" as const, model: "fixture" },
      runtimeMode: "approval-required" as const,
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      branch: null,
      worktreePath: null,
      createdAt: at,
    };
    const created = await Effect.runPromise(
      decideOrchestrationCommand({ command, readModel: model }),
    );
    expect(Array.isArray(created) ? created[0] : created).toMatchObject({
      payload: { expertBinding: null },
    });
  });

  it("preserves an unknown observation without applying it to the parent", async () => {
    const model = await readModel();
    const result = await Effect.runPromise(
      decideOrchestrationCommand({
        readModel: model,
        trustedExpertDelegationResult: true,
        command: {
          type: "thread.expert-delegation.result",
          commandId: CommandId.makeUnsafe("unknown-result"),
          threadId: sourceId,
          parentRootRunId: "original-root",
          delegationId: "delegation",
          attemptId: "attempt",
          targetExpertId: "actual-author",
          outcome: "failed",
          resultRef: "actual-result",
          resultHash: "a".repeat(64),
          result: null,
          applyToParent: true,
          createdAt: at,
          issue: {
            code: "execution_unknown",
            category: "unknown",
            subject: { kind: "execution", id: "attempt", path: null },
            action: "run",
            effect: "observe",
            message: "Execution could not be reconciled.",
            evidenceRef: null,
            checkedAt: at,
            recovery: "reconcile",
          },
        },
      }),
    );
    expect(Array.isArray(result) ? result[0] : result).toMatchObject({
      type: "thread.expert-delegation-result",
      payload: {
        targetExpertId: "actual-author",
        resultRef: "actual-result",
        applyToParent: false,
      },
    });
  });
});
