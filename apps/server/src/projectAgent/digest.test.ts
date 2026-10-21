import { ProjectActivityId, ThreadId } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import {
  allowedDigestSources,
  mergePinnedFocusItems,
  sanitizeDigestFocusItems,
  validateDigestFocusItems,
  wakeReceiptRequestId,
} from "./digest";

describe("project digest helpers", () => {
  it("drops focus items without a known source", () => {
    const allowed = allowedDigestSources({
      activities: [],
      taskIds: ["task-1"],
      threadIds: ["thread-1"],
      documentPaths: ["decisions.md"],
    });
    const items = validateDigestFocusItems(
      [
        { title: "Known task", kind: "task", source: "task-1" },
        { title: "Invented", kind: "blocker", source: "missing" },
      ],
      allowed,
    );
    expect(items.map((item) => item.title)).toEqual(["Known task"]);
  });

  it("resolves activity references to their real thread instead of casting the activity id", () => {
    const threadId = ThreadId.makeUnsafe("worker");
    const sources = allowedDigestSources({
      activities: [
        {
          id: ProjectActivityId.makeUnsafe("activity"),
          source: { threadId },
          actorThreadId: null,
          taskId: null,
        },
      ],
      threadIds: [threadId],
      taskIds: [],
      documentPaths: ["decisions.md"],
    });
    const result = validateDigestFocusItems(
      [
        { title: "Worker result", kind: "message", source: "activity" },
        { title: "Wrong source kind", kind: "message", source: "decisions.md" },
      ],
      sources,
    );
    expect(result[0]?.sourceThreadId).toBe(threadId);
    expect(result[1]?.sourceThreadId).toBeUndefined();
    expect(
      sanitizeDigestFocusItems(
        [
          {
            id: "old",
            title: "Old pinned item",
            kind: "message",
            pinned: true,
            sourceThreadId: ThreadId.makeUnsafe("activity"),
          },
        ],
        sources,
      )[0],
    ).not.toHaveProperty("sourceThreadId");
  });

  it("keeps pinned items ahead of generated ones", () => {
    const pinned = [
      {
        id: "pin-1",
        title: "Pinned",
        kind: "task" as const,
        pinned: true,
      },
    ];
    const generated = [
      { id: "pin-1", title: "Duplicate", kind: "task" as const, pinned: false },
      { id: "gen-2", title: "New", kind: "blocker" as const, pinned: false },
    ];
    expect(mergePinnedFocusItems(generated, pinned).map((item) => item.id)).toEqual([
      "pin-1",
      "gen-2",
    ]);
  });

  it("uses a stable wake receipt id for an event range", () => {
    expect(
      wakeReceiptRequestId({
        projectId: "project-1",
        fromInboxId: "a",
        toInboxId: "b",
      }),
    ).toBe("wake:project-1:a:b");
  });
});
