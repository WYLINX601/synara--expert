import { describe, expect, it } from "vitest";
import { ThreadId, type HubWorkItem } from "@synara/contracts";
import { mergePinnedFocusItems } from "./digest";
import { buildRuntimeDigest } from "./digestRuntimeState";

const worker = {
  threadId: ThreadId.makeUnsafe("pm-worker"),
  title: "Product discussion",
  needsYou: false,
  settleOutcome: "completed" as const,
  resultAt: null,
  resultSummary: null,
  updatedAt: "2026-10-21T06:18:00.000Z",
};
const work: HubWorkItem = {
  id: "work-1",
  sourceThreadId: ThreadId.makeUnsafe("hub"),
  sourceMessageId: null,
  title: "Product discussion",
  workerThreadId: worker.threadId,
  state: "idle",
  queueReason: null,
  resultSummary: null,
  progress: {
    revision: 1,
    summary: "Required skill is missing",
    steps: [{ id: "workflow", text: "Load role workflow", status: "pending" }],
  },
  revision: 1,
  createdAt: worker.updatedAt,
  updatedAt: worker.updatedAt,
};
describe("current Hub digest", () => {
  it("reports missing result separately from a completed runtime turn", () => {
    const digest = buildRuntimeDigest({ workItems: [], workers: [worker], pendingWakeCount: 0 });
    expect(digest?.summary).toContain("turn completed; no result registered");
    expect(digest?.summary).toContain("0 pending event(s)");
    expect(digest?.focusItems[0]?.sourceThreadId).toBe(worker.threadId);
  });
  it("uses current work progress and emits one row per worker", () => {
    const digest = buildRuntimeDigest({
      workItems: [work],
      workers: [worker],
      pendingWakeCount: 2,
    });
    expect(digest?.summary).toContain(
      "idle; turn completed; no result registered. Required skill is missing",
    );
    expect(digest?.summary).toContain("2 pending event(s)");
    expect(digest?.summary).not.toContain("result reported");
    expect(digest?.focusItems).toHaveLength(1);
  });
  it("does not apply an old runtime completion to a working or reported work item", () => {
    for (const state of ["working", "completed"] as const) {
      const digest = buildRuntimeDigest({
        workItems: [{ ...work, state, resultSummary: state === "completed" ? "Done" : null }],
        workers: [worker],
        pendingWakeCount: 0,
      });
      expect(digest?.summary).not.toContain("no result registered");
      expect(digest?.summary).toContain(
        state === "completed" ? "result reported. Done" : "working.",
      );
    }
  });
  it("preserves stopped and failed outcomes without declaring task completion", () => {
    for (const settleOutcome of ["stopped", "failed", "interrupted"] as const) {
      const digest = buildRuntimeDigest({
        workItems: [],
        workers: [{ ...worker, settleOutcome }],
        pendingWakeCount: 0,
      });
      expect(digest?.summary).toContain(settleOutcome);
      expect(digest?.summary).not.toContain("completed");
    }
  });
  it("shows current progress rather than a previous result on a follow-up", () => {
    const digest = buildRuntimeDigest({
      workItems: [{ ...work, state: "working", resultSummary: "Old result" }],
      workers: [worker],
      pendingWakeCount: 0,
    });
    expect(digest?.summary).toContain("Required skill is missing");
    expect(digest?.summary).not.toContain("Old result");
  });
  it("keeps focus identity stable when other work changes the sort order", () => {
    const first = buildRuntimeDigest({ workItems: [work], workers: [], pendingWakeCount: 0 })!;
    const next = buildRuntimeDigest({
      workItems: [work, { ...work, id: "newer", updatedAt: "2026-10-22T00:00:00.000Z" }],
      workers: [],
      pendingWakeCount: 0,
    })!;
    expect(
      mergePinnedFocusItems(next.focusItems, [{ ...first.focusItems[0]!, pinned: true }]),
    ).toHaveLength(2);
  });
  it("leaves narrative-only projects on the existing digest path", () => {
    expect(buildRuntimeDigest({ workItems: [], workers: [], pendingWakeCount: 0 })).toBeNull();
  });
});
