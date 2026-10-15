import type { OrchestrationThread } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import {
  contextExecutionInputDigest,
  type ContextExecutionEvent,
} from "./contextDispatchEvidence.ts";

const event = {
  type: "thread.turn-start-requested",
  payload: { threadId: "thread", messageId: "message" },
} as ContextExecutionEvent;
const thread = {
  projectId: "project",
  envMode: "local",
  worktreePath: null,
  workingDirectory: null,
  branch: "main",
  messages: [
    { id: "message", text: "Original user input", attachments: [], skills: [], mentions: [] },
  ],
  notes: "Notes",
  modelSelection: { provider: "codex", model: "model" },
  runtimeMode: "approval-required",
  interactionMode: "default",
  goal: null,
} as unknown as OrchestrationThread;
const workspace = { projectWorkspaceRoot: "/tmp/original", effectiveCwd: "/tmp/original" };
const hash = (value = thread, location = workspace) =>
  contextExecutionInputDigest(event, value, location);

describe("Context original-input witness", () => {
  it("ignores execution status, but rejects changed inputs or workspace ownership", () => {
    const original = hash();
    expect(
      hash({
        ...thread,
        status: "working",
        session: { status: "closed" },
      } as unknown as OrchestrationThread),
    ).toBe(original);
    for (const change of [
      { projectId: "other" },
      { envMode: "worktree" },
      { worktreePath: "/tmp/other" },
      { workingDirectory: "subdirectory" },
      { branch: "other" },
      { notes: "Changed notes" },
      { messages: [{ ...thread.messages[0], text: "Changed input" }] },
    ])
      expect(hash({ ...thread, ...change } as OrchestrationThread)).not.toBe(original);
    expect(hash(thread, { ...workspace, projectWorkspaceRoot: "/tmp/reassigned" })).not.toBe(
      original,
    );
    expect(hash(thread, { ...workspace, effectiveCwd: "/tmp/other-cwd" })).not.toBe(original);
  });
});
