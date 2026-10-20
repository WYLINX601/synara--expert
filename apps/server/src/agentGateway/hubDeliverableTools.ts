import {
  HubDeliverableListInput,
  HubDeliverablePublishInput,
  HubDeliverableReadInput,
  HubDeliverableWithdrawInput,
  ThreadId,
} from "@synara/contracts";
import { Effect, Schema } from "effect";
import type { ProjectAgentServiceShape } from "../projectAgent/Services/ProjectAgentService";
import { mcpToolResultError, mcpToolResultJson } from "./protocol";
import { ToolInputError, errorText } from "./toolInput";
import { READ_ONLY_TOOL_ANNOTATIONS, WRITE_TOOL_ANNOTATIONS, type ToolEntry } from "./toolRuntime";

/** Scope is derived from the authenticated Gateway session, never tool arguments. */
export function makeHubDeliverableTools(
  projectAgent: ProjectAgentServiceShape,
): readonly ToolEntry[] {
  const api = projectAgent.deliverables;
  if (!api) return [];
  const definitions = [
    {
      name: "synara_hub_publish_deliverables",
      operation: "publish" as const,
      description:
        "Publish 1–3 documents or index files from your own Expert worker workspace. Replaces your current key collection; does not imply user approval or start other tasks. Pass expectedRevision from the list tool (0 initially); reuse requestId only for an identical retry.",
      properties: {
        requestId: { type: "string" },
        expectedRevision: { type: "integer", minimum: 0 },
        files: {
          type: "array",
          minItems: 1,
          maxItems: 3,
          items: {
            type: "object",
            properties: {
              path: { type: "string" },
              name: { type: "string" },
              description: { type: "string" },
            },
            required: ["path"],
            additionalProperties: false,
          },
        },
      },
      required: ["requestId", "expectedRevision", "files"],
    },
    {
      name: "synara_hub_list_deliverables",
      operation: "list" as const,
      description:
        "Discover current key document/index collections published by Expert workers in your Hub. Metadata only; optional ownerThreadId filters one worker. Revision 0 means the worker has not published yet. Key means recommended reading, not user acceptance.",
      properties: { ownerThreadId: { type: "string" } },
      required: [],
    },
    {
      name: "synara_hub_read_deliverable",
      operation: "read" as const,
      description:
        "Read a key document at a published version in this Hub. Use ownerThreadId, path and revision from the Hub index or list tool; omitting revision reads the current collection. An explicit revision continues to read that exact publication after republishing or withdrawal. Linked resources keep their existing permissions and are not automatically expanded.",
      properties: {
        ownerThreadId: { type: "string" },
        path: { type: "string" },
        revision: { type: "integer", minimum: 0 },
      },
      required: ["ownerThreadId", "path"],
    },
    {
      name: "synara_hub_withdraw_deliverables",
      operation: "withdraw" as const,
      description:
        "Withdraw your own Expert worker key collection without deleting its files or Git history. Cannot withdraw another worker’s collection. Pass its current revision and a unique requestId.",
      properties: {
        ownerThreadId: { type: "string" },
        requestId: { type: "string" },
        expectedRevision: { type: "integer", minimum: 0 },
      },
      required: ["ownerThreadId", "requestId", "expectedRevision"],
    },
  ];
  return definitions.map((definition): ToolEntry => {
    const writes = definition.operation === "publish" || definition.operation === "withdraw";
    return {
      requiredCapability: writes ? "thread:write" : "thread:read",
      ...(writes ? { requiresActiveTurn: true } : {}),
      definition: {
        name: definition.name,
        description: definition.description,
        inputSchema: {
          type: "object",
          properties: definition.properties,
          required: definition.required,
          additionalProperties: false,
        },
        annotations: {
          title: definition.name,
          ...(writes ? WRITE_TOOL_ANNOTATIONS : READ_ONLY_TOOL_ANNOTATIONS),
        },
      },
      handler: (args, context) =>
        Effect.gen(function* () {
          if (Object.keys(args).some((key) => !(key in definition.properties))) {
            return yield* Effect.fail(
              new ToolInputError(
                "Unsupported argument; Hub and Expert identities come from your authenticated session.",
              ),
            );
          }
          const principal = yield* projectAgent.resolvePrincipalForThread(
            ThreadId.makeUnsafe(context.callerThreadId),
          );
          if (principal.kind === "unmanaged" || principal.kind === "user") {
            return yield* Effect.fail(
              new ToolInputError("This thread does not belong to an authorized Hub."),
            );
          }
          const projectId = principal.projectId;
          switch (definition.operation) {
            case "publish": {
              const input = yield* Schema.decodeUnknownEffect(HubDeliverablePublishInput)(args);
              return mcpToolResultJson(yield* api.publish({ ...input, projectId }, principal));
            }
            case "list": {
              const input = yield* Schema.decodeUnknownEffect(HubDeliverableListInput)(args);
              return mcpToolResultJson(yield* api.list({ ...input, projectId }, principal));
            }
            case "read": {
              const input = yield* Schema.decodeUnknownEffect(HubDeliverableReadInput)(args);
              const result = yield* api.read({ ...input, projectId }, principal);
              if (result.content.encoding !== "utf-8") {
                return mcpToolResultError(
                  "This published file is binary. View its pinned version in the Hub Library; this text tool cannot read its contents.",
                );
              }
              return mcpToolResultJson(result);
            }
            case "withdraw": {
              const input = yield* Schema.decodeUnknownEffect(HubDeliverableWithdrawInput)(args);
              return mcpToolResultJson(yield* api.withdraw({ ...input, projectId }, principal));
            }
          }
        }).pipe(Effect.catch((error) => Effect.succeed(mcpToolResultError(errorText(error))))),
    };
  });
}
