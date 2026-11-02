import { LearningCommitInput, LearningReadInput, LearningRevertInput } from "@synara/contracts";
import { Effect, Schema } from "effect";

import type {
  ExpertLearningActionsShape,
  LearningActionContext,
} from "../experts/evolution/ExpertLearningActions.ts";
import { mcpToolResultError, mcpToolResultJson, type McpToolDefinition } from "./protocol.ts";
import { errorText, ToolInputError } from "./toolInput.ts";
import {
  READ_ONLY_TOOL_ANNOTATIONS,
  type ToolContext,
  type ToolEntry,
  WRITE_TOOL_ANNOTATIONS,
} from "./toolRuntime.ts";

function inputSchema(schema: Schema.Top): Record<string, unknown> {
  const document = Schema.toJsonSchemaDocument(schema);
  return {
    ...document.schema,
    ...(Object.keys(document.definitions).length > 0 ? { $defs: document.definitions } : {}),
  };
}

function actionContext(context: ToolContext): LearningActionContext {
  const session = context.learningSession;
  if (!session)
    throw new ToolInputError("This provider session has no host-issued learning context.");
  if (context.callerProvider !== "omp" && context.callerProvider !== "pi")
    throw new ToolInputError("Learning tools are available only to supported OMP and Pi sessions.");
  if (context.callerTurnId === null)
    throw new ToolInputError("Learning tools require the active provider turn.");
  return {
    session,
    threadId: context.callerThreadId,
    turnId: context.callerTurnId,
    provider: context.callerProvider,
    sessionKey: context.callerSessionKey,
    requestId: `${typeof context.jsonRpcRequestId}:${String(context.jsonRpcRequestId)}`,
    assertActive: context.assertCallerTurnActive,
  };
}

function decodeInput<A>(decode: (args: unknown) => A, args: Record<string, unknown>): A {
  try {
    return decode(args);
  } catch (error) {
    throw new ToolInputError(errorText(error));
  }
}

function definition(
  name: string,
  title: string,
  description: string,
  schema: Record<string, unknown>,
): McpToolDefinition {
  return {
    name,
    description,
    inputSchema: schema,
    annotations: {
      title,
      ...(name === "synara_learning_read" ? READ_ONLY_TOOL_ANNOTATIONS : WRITE_TOOL_ANNOTATIONS),
    },
  };
}

function handler(
  action: (
    actions: ExpertLearningActionsShape,
    context: LearningActionContext,
    args: Record<string, unknown>,
  ) => Effect.Effect<unknown, unknown>,
  actions: ExpertLearningActionsShape,
) {
  return (args: Record<string, unknown>, context: ToolContext) =>
    Effect.gen(function* () {
      const trusted = actionContext(context);
      return mcpToolResultJson(yield* Effect.suspend(() => action(actions, trusted, args)));
    }).pipe(
      Effect.catch((error) => Effect.succeed(mcpToolResultError(errorText(error)))),
      Effect.catchDefect((defect) => Effect.succeed(mcpToolResultError(errorText(defect)))),
    );
}

const learningReadSchema = inputSchema(LearningReadInput);
const learningCommitSchema = inputSchema(LearningCommitInput);
const learningRevertSchema = inputSchema(LearningRevertInput);
const decodeReadInput = Schema.decodeUnknownSync(LearningReadInput);
const decodeCommitInput = Schema.decodeUnknownSync(LearningCommitInput);
const decodeRevertInput = Schema.decodeUnknownSync(LearningRevertInput);

/** Register the three host-backed learning tools for one verified session capability set. */
export function makeLearningTools(actions: ExpertLearningActionsShape): ReadonlyArray<ToolEntry> {
  return [
    {
      requiredCapability: "learning:read",
      requiresActiveTurn: true,
      definition: definition(
        "synara_learning_read",
        "Read applicable learning",
        "Read this Expert session's pinned rules, current facts, canonical accepted source IDs and exact authorized edit baselines. Skill IDs require mode=edit and return the current bounded entry file plus Expert/Skill revisions for editing only; runtime Skills are read on demand from this Run's native fixed catalog. Read before committing; use returned source IDs rather than inventing message IDs.",
        learningReadSchema,
      ),
      handler: handler(
        (service, context, args) => service.read(context, decodeInput(decodeReadInput, args)),
        actions,
      ),
    },
    {
      requiredCapability: "learning:write",
      requiresActiveTurn: true,
      definition: definition(
        "synara_learning_commit",
        "Commit one learning change",
        "Save one clear durable correction using verified current sources. Preferences are Memory rules; supported facts/environment are task data; procedures belong to an authorized Skill. Rules default to the current Expert and Space; projectOnly:true narrows a new rule to this Project, and existing boundaries cannot change. Facts/environment are always Project-local. One-off requests, task state and credentials are not long-term learning. Never bypass a read-only target. Read exact baselines first. For every commit, select the exact quote or range supporting this single correction, so unrelated corrections in the same message remain learnable; if deferred for a missing fragment, retry with that precise selection. Skill changes[].content is base64, omitted content deletes a file. No second model or user approval is required for this bounded save. Report deferred/saved_unbound honestly and continue the business task.",
        learningCommitSchema,
      ),
      handler: handler((service, context, args) => {
        if (context.session.learningEpoch === undefined)
          throw new ToolInputError("This learning session is read-only.");
        return service.commit(context, decodeInput(decodeCommitInput, args));
      }, actions),
    },
    {
      requiredCapability: "learning:write",
      requiresActiveTurn: true,
      definition: definition(
        "synara_learning_revert",
        "Revert a learning change",
        "Revert one exact committed learning change by changeId and report any conflict without overwriting later work.",
        learningRevertSchema,
      ),
      handler: handler((service, context, args) => {
        if (context.session.learningEpoch === undefined)
          throw new ToolInputError("This learning session is read-only.");
        return service.revert(context, decodeInput(decodeRevertInput, args));
      }, actions),
    },
  ];
}
