import {
  HubPlanSubmitCandidateCommandSchema,
  HubPlanSubmitReviewCommandSchema,
  HubPlanRequestInputCommandSchema,
  HubPlanProposeInputSchema,
  HubPlanListInputSchema,
  ThreadId,
} from "@synara/contracts";
import { Effect, Schema } from "effect";
import type { makeHubPlanService } from "../hubCollaboration/HubPlanService.ts";
import type { ProjectAgentServiceShape } from "../projectAgent/Services/ProjectAgentService.ts";
import { mcpToolResultError, mcpToolResultJson } from "./protocol.ts";
import { errorText } from "./toolInput.ts";
import {
  READ_ONLY_TOOL_ANNOTATIONS,
  WRITE_TOOL_ANNOTATIONS,
  type ToolEntry,
} from "./toolRuntime.ts";

const deliverableReferenceInputSchema = {
  type: "object",
  description:
    "Fixed HubDeliverableReferenceMetadata returned by synara_hub_read_deliverable. Use workerThreadId from that result; ownerThreadId is only a list/read selector and is not a publication metadata field.",
  properties: {
    hubId: { type: "string", minLength: 1 },
    workerThreadId: { type: "string", minLength: 1 },
    revision: { type: "integer", minimum: 1 },
    commitSha: { type: "string", pattern: "^[0-9a-f]{40}$" },
    provenance: {
      type: "object",
      properties: {
        hubId: { type: "string", minLength: 1 },
        workerThreadId: { type: "string", minLength: 1 },
        expertBindingSnapshotId: { type: "string", minLength: 1, maxLength: 256 },
        publishedAt: { type: "string" },
      },
      required: ["hubId", "workerThreadId", "expertBindingSnapshotId", "publishedAt"],
      additionalProperties: false,
    },
    file: {
      type: "object",
      properties: {
        path: { type: "string", minLength: 1, maxLength: 2_048 },
        libraryPath: { type: "string", minLength: 1, maxLength: 2_048 },
        currentLibraryPath: { type: "string", minLength: 1, maxLength: 2_048 },
        libraryState: { type: "string", enum: ["available", "missing"] },
        name: { type: "string", minLength: 1, maxLength: 240 },
        description: { type: ["string", "null"], maxLength: 4_000 },
        mediaType: {
          type: "string",
          enum: [
            "text/markdown",
            "text/plain",
            "text/html",
            "application/json",
            "application/pdf",
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          ],
        },
        sizeBytes: { type: "integer", minimum: 0 },
        sha256: { type: "string", pattern: "^[0-9a-f]{64}$" },
      },
      required: ["path", "libraryPath", "name", "description", "mediaType", "sizeBytes", "sha256"],
      additionalProperties: false,
    },
    expertBinding: {
      type: "object",
      properties: {
        expertId: { type: "string", minLength: 1, maxLength: 128 },
        displayName: { type: "string", minLength: 1 },
        revision: { type: "integer", minimum: 1 },
      },
      required: ["expertId", "displayName", "revision"],
      additionalProperties: false,
    },
    sourceWorkTitle: { type: "string", minLength: 1, maxLength: 240 },
  },
  required: ["hubId", "workerThreadId", "revision", "commitSha", "provenance", "file"],
  additionalProperties: false,
} as const;

const submitPlanResultProperties = {
  hubId: { type: "string", minLength: 1 },
  planId: { type: "string", minLength: 1, maxLength: 128 },
  requestId: { type: "string", minLength: 1, maxLength: 256 },
  expectedStateVersion: { type: "integer", minimum: 1 },
  expectedRevision: { type: "integer", minimum: 1 },
  stageKey: { type: "string", minLength: 1, maxLength: 128 },
  generation: { type: "integer", minimum: 1 },
  nodeKey: { type: "string", minLength: 1, maxLength: 128 },
  attemptId: {
    type: "string",
    minLength: 1,
    description:
      "Required for both actions; use the current node attemptId returned by list_plans.",
  },
  deliverableRefs: {
    type: "array",
    items: deliverableReferenceInputSchema,
    minItems: 1,
    maxItems: 3,
  },
  candidateId: { type: "string", minLength: 1, maxLength: 256 },
  outputDigest: { type: "string", minLength: 1, maxLength: 256 },
  outcome: { type: "string", enum: ["pass", "changes_requested", "blocked"] },
  summary: { type: "string", maxLength: 16_000 },
};

const submitPlanResultInputSchema = {
  type: "object",
  properties: {
    ...submitPlanResultProperties,
    action: { type: "string", enum: ["submitCandidate", "submitReview"] },
  },
  required: [
    "action",
    "hubId",
    "planId",
    "requestId",
    "expectedStateVersion",
    "expectedRevision",
    "stageKey",
    "generation",
    "nodeKey",
    "attemptId",
    "summary",
  ],
  oneOf: [
    {
      properties: { action: { const: "submitCandidate" } },
      required: ["deliverableRefs"],
    },
    {
      properties: { action: { const: "submitReview" } },
      required: ["candidateId", "outputDigest", "outcome"],
    },
  ],
  additionalProperties: false,
} as const;

/** Agent tools can propose work and report evidence. Only the owner RPC can authorize it. */
export function makeHubPlanTools(input: {
  readonly plans: ReturnType<typeof makeHubPlanService>;
  readonly projectAgent: Pick<ProjectAgentServiceShape, "resolvePrincipalForThread">;
}): readonly ToolEntry[] {
  const principalFor = (threadId: string) =>
    input.projectAgent.resolvePrincipalForThread(ThreadId.makeUnsafe(threadId)).pipe(
      Effect.flatMap((principal) =>
        principal.kind === "coordinator" || principal.kind === "worker"
          ? Effect.succeed({
              kind: principal.kind,
              hubId: principal.projectId,
              threadId: principal.threadId,
            })
          : Effect.fail(
              new Error(
                "Only this Hub's coordinator or assigned worker may use collaboration plans.",
              ),
            ),
      ),
    );
  const definitionSchema = {
    type: "object",
    additionalProperties: false,
    properties: {
      objective: { type: "string" },
      scope: { type: "string" },
      maxRepairRounds: { type: "integer", minimum: 0, maximum: 20 },
      stages: {
        type: "array",
        minItems: 1,
        maxItems: 12,
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            key: { type: "string" },
            title: { type: "string" },
            releasePolicy: { type: "string", enum: ["auto", "user"] },
          },
          required: ["key", "title", "releasePolicy"],
        },
      },
      nodes: {
        type: "array",
        minItems: 1,
        maxItems: 64,
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            key: { type: "string" },
            stageKey: { type: "string" },
            title: { type: "string" },
            brief: { type: "string" },
            role: { type: "string", enum: ["author", "reviewer", "worker"] },
            expertId: { type: "string" },
            target: {
              type: "object",
              description:
                "Required explicit ModelSelection for every node, including Experts. Resolve the configured defaults to an available provider, instance and model before proposing.",
            },
            dependsOnNodeKeys: { type: "array", items: { type: "string" } },
            workMode: { type: "string", enum: ["agent", "co_create"] },
            acceptanceCriteria: { type: "string" },
          },
          required: [
            "key",
            "stageKey",
            "title",
            "brief",
            "role",
            "dependsOnNodeKeys",
            "workMode",
            "acceptanceCriteria",
          ],
        },
      },
    },
    required: ["objective", "scope", "stages", "nodes", "maxRepairRounds"],
  };
  return [
    {
      requiredCapability: "thread:read",
      definition: {
        name: "synara_hub_list_plans",
        description:
          "Read current Hub collaboration plans, graph state and task/attempt bindings. This does not authorize execution.",
        inputSchema: {
          type: "object",
          properties: { hubId: { type: "string" } },
          required: ["hubId"],
          additionalProperties: false,
        },
        annotations: { title: "Read Hub plans", ...READ_ONLY_TOOL_ANNOTATIONS },
      },
      handler: (args, context) =>
        Effect.gen(function* () {
          const principal = yield* principalFor(context.callerThreadId);
          const request = yield* Schema.decodeUnknownEffect(HubPlanListInputSchema)(args);
          return mcpToolResultJson(yield* input.plans.list(request, principal));
        }).pipe(Effect.catch((error) => Effect.succeed(mcpToolResultError(errorText(error))))),
    },
    {
      requiredCapability: "thread:write",
      requiresActiveTurn: true,
      definition: {
        name: "synara_hub_propose_plan",
        description:
          "Propose or revise a draft collaboration plan in the Hub conversation. The user confirms the immutable scope in a card before any work starts. Use one author per stage and same-stage reviewer dependencies; a final user release for subjective acceptance. Every node must include an explicit target (provider, instanceId, model); Expert defaults must be resolved before proposal so confirmation pins the model. Proposal is not permission. sourceMessageIds must be original human messages from this coordinator conversation. Existing active plans cannot be silently changed.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            hubId: { type: "string" },
            planId: { type: "string" },
            requestId: { type: "string" },
            expectedStateVersion: { type: ["integer", "null"] },
            sourceMessageIds: {
              type: "array",
              minItems: 1,
              maxItems: 16,
              items: { type: "string" },
            },
            definition: definitionSchema,
          },
          required: [
            "hubId",
            "planId",
            "requestId",
            "expectedStateVersion",
            "definition",
            "sourceMessageIds",
          ],
        },
        annotations: { title: "Propose a Hub plan", ...WRITE_TOOL_ANNOTATIONS },
      },
      handler: (args, context) =>
        Effect.gen(function* () {
          yield* context.assertCallerTurnActive();
          const principal = yield* principalFor(context.callerThreadId);
          const request = yield* Schema.decodeUnknownEffect(HubPlanProposeInputSchema)(args);
          return mcpToolResultJson(yield* input.plans.propose(request, principal));
        }).pipe(Effect.catch((error) => Effect.succeed(mcpToolResultError(errorText(error))))),
    },
    {
      requiredCapability: "thread:write",
      requiresActiveTurn: true,
      definition: {
        name: "synara_hub_request_input",
        description:
          "Ask the Hub owner a durable directed question when a missing decision blocks this exact plan attempt. This returns immediately and does not pause a native provider request, grant permissions, approve work, or change the plan scope. Stop the current turn after this call and wait for the owner answer to arrive through the same bound attempt.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            action: { const: "requestInput" },
            hubId: { type: "string" },
            planId: { type: "string" },
            requestId: { type: "string", minLength: 1, maxLength: 256 },
            expectedStateVersion: { type: "integer", minimum: 1 },
            expectedRevision: { type: "integer", minimum: 1 },
            inputRequestId: { type: "string", minLength: 1, maxLength: 128 },
            stageKey: { type: "string", minLength: 1, maxLength: 128 },
            generation: { type: "integer", minimum: 1 },
            nodeKey: { type: "string", minLength: 1, maxLength: 128 },
            attemptId: { type: "string", minLength: 1, maxLength: 128 },
            questions: {
              type: "array",
              minItems: 1,
              maxItems: 3,
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  title: { type: "string", minLength: 1, maxLength: 4_000 },
                  options: {
                    type: "array",
                    minItems: 1,
                    maxItems: 8,
                    items: { type: "string", minLength: 1, maxLength: 240 },
                  },
                },
                required: ["title"],
              },
            },
          },
          required: [
            "action",
            "hubId",
            "planId",
            "requestId",
            "expectedStateVersion",
            "expectedRevision",
            "inputRequestId",
            "stageKey",
            "generation",
            "nodeKey",
            "attemptId",
            "questions",
          ],
        },
        annotations: { title: "Ask the Hub owner", ...WRITE_TOOL_ANNOTATIONS },
      },
      handler: (args, context) =>
        Effect.gen(function* () {
          yield* context.assertCallerTurnActive();
          const principal = yield* principalFor(context.callerThreadId);
          if (principal.kind !== "worker") {
            return yield* Effect.fail(new Error("Only an assigned plan Worker may request input."));
          }
          const request = yield* Schema.decodeUnknownEffect(HubPlanRequestInputCommandSchema)(args);
          const snapshot = yield* input.plans.command(request, principal);
          return mcpToolResultJson({
            status: "waiting_for_owner_input",
            inputRequestId: request.inputRequestId,
            instruction:
              "Stop this turn and wait for the answer to arrive on this same Worker attempt.",
            snapshot,
          });
        }).pipe(Effect.catch((error) => Effect.succeed(mcpToolResultError(errorText(error))))),
    },
    {
      requiredCapability: "thread:write",
      requiresActiveTurn: true,
      definition: {
        name: "synara_hub_submit_plan_result",
        description:
          "Submit a fixed publication candidate or structured professional review for your current assigned plan attempt. Obtain plan revision/stateVersion and node/attempt IDs with list_plans. For a candidate, pass 1–3 fixed references from read_deliverable using its workerThreadId field; ownerThreadId is only the selector used to read a worker's publication. Reviews bind candidateId/outputDigest/generation. This tool cannot confirm, release, pause, resume, cancel, or authorize work.",
        inputSchema: submitPlanResultInputSchema,
        annotations: { title: "Submit a plan result", ...WRITE_TOOL_ANNOTATIONS },
      },
      handler: (args, context) =>
        Effect.gen(function* () {
          yield* context.assertCallerTurnActive();
          if (args.action !== "submitCandidate" && args.action !== "submitReview")
            return yield* Effect.fail(
              new Error("Plan approval requires an explicit owner action in the conversation."),
            );
          const principal = yield* principalFor(context.callerThreadId);
          const commandSchema =
            args.action === "submitCandidate"
              ? HubPlanSubmitCandidateCommandSchema
              : HubPlanSubmitReviewCommandSchema;
          const request = yield* Schema.decodeUnknownEffect(commandSchema)(args);
          return mcpToolResultJson(yield* input.plans.command(request, principal));
        }).pipe(Effect.catch((error) => Effect.succeed(mcpToolResultError(errorText(error))))),
    },
  ];
}
