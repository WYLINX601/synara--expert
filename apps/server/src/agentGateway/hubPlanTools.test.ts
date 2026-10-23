import { describe, expect, it, vi } from "vitest";
import { Effect } from "effect";
import { ProjectId, ThreadId } from "@synara/contracts";
import { makeHubPlanTools } from "./hubPlanTools.ts";
import type { ToolContext } from "./toolRuntime.ts";
import type { HubPlanService } from "../hubCollaboration/HubPlanService.ts";
import type { ProjectAgentServiceShape } from "../projectAgent/Services/ProjectAgentService.ts";

describe("Hub plan agent authorization", () => {
  it("never turns an agent result call into user approval", async () => {
    const command = vi.fn();
    const resolvePrincipalForThread = vi.fn();
    const tools = makeHubPlanTools({
      plans: { command } as unknown as HubPlanService,
      projectAgent: { resolvePrincipalForThread } as Pick<
        ProjectAgentServiceShape,
        "resolvePrincipalForThread"
      >,
    });
    const submit = tools.find((tool) => tool.definition.name === "synara_hub_submit_plan_result")!;
    const result = await Effect.runPromise(
      submit.handler({ action: "release", actor: "user" }, {
        callerThreadId: "worker",
        assertCallerTurnActive: () => Effect.void,
      } as unknown as ToolContext),
    );
    expect(result.isError).toBe(true);
    expect(command).not.toHaveBeenCalled();
    expect(resolvePrincipalForThread).not.toHaveBeenCalled();
  });

  it("advertises and decodes fixed candidate metadata after JSON serialization", async () => {
    const command = vi.fn(() => Effect.succeed({ accepted: true }));
    const resolvePrincipalForThread = vi.fn(() =>
      Effect.succeed({
        kind: "worker" as const,
        projectId: ProjectId.makeUnsafe("hub-1"),
        threadId: ThreadId.makeUnsafe("worker-1"),
        taskId: null,
      }),
    );
    const tools = makeHubPlanTools({
      plans: { command } as unknown as HubPlanService,
      projectAgent: { resolvePrincipalForThread } as Pick<
        ProjectAgentServiceShape,
        "resolvePrincipalForThread"
      >,
    });
    const submit = tools.find((tool) => tool.definition.name === "synara_hub_submit_plan_result")!;
    const schema = submit.definition.inputSchema as {
      readonly properties: {
        readonly attemptId: unknown;
        readonly deliverableRefs: {
          readonly items: {
            readonly properties: Record<string, unknown>;
            readonly description: string;
          };
        };
      };
      readonly required: readonly string[];
    };
    expect(schema.required).toContain("attemptId");
    expect(schema.properties.attemptId).toBeDefined();
    expect(schema.properties.deliverableRefs.items.properties.workerThreadId).toBeDefined();
    expect(schema.properties.deliverableRefs.items.properties.ownerThreadId).toBeUndefined();
    expect(schema.properties.deliverableRefs.items.description).toContain("ownerThreadId");

    const args = {
      action: "submitCandidate",
      hubId: "hub-1",
      planId: "local-note-search-acceptance",
      requestId: "candidate-submit-1",
      expectedStateVersion: 3,
      expectedRevision: 2,
      stageKey: "stage-1",
      generation: 1,
      nodeKey: "author",
      attemptId: "attempt-1",
      deliverableRefs: [
        {
          hubId: "hub-1",
          workerThreadId: "worker-1",
          revision: 1,
          commitSha: "a".repeat(40),
          provenance: {
            hubId: "hub-1",
            workerThreadId: "worker-1",
            expertBindingSnapshotId: "binding-1",
            publishedAt: "2026-10-23T00:00:00.000Z",
          },
          file: {
            path: "result.md",
            libraryPath: "worker-1/1/result.md",
            name: "Result",
            description: null,
            mediaType: "text/markdown",
            sizeBytes: 10,
            sha256: "b".repeat(64),
          },
        },
      ],
      summary: "Candidate summary",
    };
    const serializedArgs = JSON.parse(JSON.stringify(args)) as Record<string, unknown>;
    const result = await Effect.runPromise(
      submit.handler(serializedArgs, {
        callerThreadId: "worker-1",
        assertCallerTurnActive: () => Effect.void,
      } as unknown as ToolContext),
    );

    expect(result.isError).not.toBe(true);
    expect(command).toHaveBeenCalledWith(args, {
      kind: "worker",
      hubId: "hub-1",
      threadId: "worker-1",
    });
  });

  it("reports candidate field mismatches without review-union errors", async () => {
    const resolvePrincipalForThread = vi.fn(() =>
      Effect.succeed({
        kind: "worker" as const,
        projectId: ProjectId.makeUnsafe("hub-1"),
        threadId: ThreadId.makeUnsafe("worker-1"),
        taskId: null,
      }),
    );
    const tools = makeHubPlanTools({
      plans: { command: vi.fn() } as unknown as HubPlanService,
      projectAgent: { resolvePrincipalForThread } as Pick<
        ProjectAgentServiceShape,
        "resolvePrincipalForThread"
      >,
    });
    const submit = tools.find((tool) => tool.definition.name === "synara_hub_submit_plan_result")!;
    const badRef = {
      hubId: "hub-1",
      ownerThreadId: "worker-1",
      revision: 1,
      commitSha: "a".repeat(40),
      provenance: {
        hubId: "hub-1",
        workerThreadId: "worker-1",
        expertBindingSnapshotId: "binding-1",
        publishedAt: "2026-10-23T00:00:00.000Z",
      },
      file: {
        path: "result.md",
        libraryPath: "worker-1/1/result.md",
        name: "Result",
        description: null,
        mediaType: "text/markdown",
        sizeBytes: 10,
        sha256: "b".repeat(64),
      },
    };
    const result = await Effect.runPromise(
      submit.handler(
        {
          action: "submitCandidate",
          hubId: "hub-1",
          planId: "plan-1",
          requestId: "candidate-submit-1",
          expectedStateVersion: 3,
          expectedRevision: 2,
          stageKey: "stage-1",
          generation: 1,
          nodeKey: "author",
          attemptId: "attempt-1",
          deliverableRefs: [badRef],
          summary: "Candidate summary",
        },
        {
          callerThreadId: "worker-1",
          assertCallerTurnActive: () => Effect.void,
        } as unknown as ToolContext,
      ),
    );
    const errorMessage = result.content[0]?.type === "text" ? result.content[0].text : "";
    expect(result.isError).toBe(true);
    expect(errorMessage).toContain("ownerThreadId");
    expect(errorMessage).not.toContain("attemptId");
  });
});
