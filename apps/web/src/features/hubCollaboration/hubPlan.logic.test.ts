import {
  HubPlanEventSchema,
  ProjectId,
  type HubPlanEvent,
  type HubPlanSnapshot,
} from "@synara/contracts";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import type { MessagesTimelineRow } from "~/components/chat/MessagesTimeline.logic";

import realV2ProposedEvent from "./fixtures/local-note-search-acceptance-v2.event.json";
import {
  isHubPlanControlEvent,
  isHubPlanTimelineEvent,
  mergeHubPlanEventRows,
  mergeHubPlanEvents,
  latestSnapshotFromHubPlanEvents,
  selectCurrentHubPlan,
  snapshotFromHubPlanEvent,
} from "./hubPlan.logic";

function plan(input: {
  id: string;
  controlState: HubPlanSnapshot["controlState"];
}): HubPlanSnapshot {
  return {
    id: input.id,
    hubId: ProjectId.makeUnsafe("hub-a"),
    goalId: null,
    revision: 1,
    stateVersion: 1,
    controlState: input.controlState,
    definition: {
      objective: "Plan objective",
      scope: "Plan scope",
      stages: [{ key: "stage-a", title: "Stage A", releasePolicy: "user" }],
      nodes: [
        {
          key: "node-a",
          stageKey: "stage-a",
          title: "Node A",
          brief: "Node brief",
          role: "author",
          dependsOnNodeKeys: [],
          workMode: "agent",
          acceptanceCriteria: "Acceptance criteria",
        },
      ],
      maxRepairRounds: 0,
    },
    createdAt: "2026-10-22T10:00:00.000Z",
    updatedAt: "2026-10-22T10:00:00.000Z",
    graph: {
      controlState: input.controlState,
      stages: [
        {
          stageKey: "stage-a",
          title: "Stage A",
          releasePolicy: "user",
          generation: null,
          status: "draft",
          underlyingStatus: "draft",
          isReleased: false,
          candidateId: null,
          outputDigest: null,
          outputSummary: null,
          blockingReasons: [],
        },
      ],
      releasedCount: 0,
      stageCount: 1,
    },
    nodeStates: [],
    eventSequence: 1,
  };
}

function event(sequence: number, snapshot: HubPlanSnapshot): HubPlanEvent {
  return {
    sequence,
    planId: snapshot.id,
    hubId: snapshot.hubId,
    kind: "plan.proposed",
    payload: { snapshot },
    createdAt: "2026-10-22T10:00:00.000Z",
  };
}

describe("Hub plan timeline projection", () => {
  it("parses the real v2 proposed event payload captured from the isolated Hub", () => {
    const actualEvent = Schema.decodeUnknownSync(HubPlanEventSchema)(realV2ProposedEvent);
    const historicalSnapshot = snapshotFromHubPlanEvent(actualEvent);

    expect(historicalSnapshot).toMatchObject({
      id: "local-note-search-acceptance",
      hubId: "b0995f07-76f9-4696-8587-0e131060f263",
      controlState: "draft",
      revision: 2,
      stateVersion: 2,
      definition: {
        objective:
          "隔离实例协作验收：产品经理编写不超过五条的本地笔记搜索需求，代码审查员审核范围，最终由用户人工放行。",
      },
    });

    expect(Schema.is(HubPlanEventSchema)({ ...actualEvent, payload: null })).toBe(false);
  });

  it("keeps the newest unfinished plan ahead of terminal history", () => {
    const completed = plan({ id: "completed", controlState: "completed" });
    const draft = plan({ id: "draft", controlState: "draft" });
    expect(selectCurrentHubPlan([completed, draft])).toBe(draft);
  });

  it("continues an active plan before a newer draft is considered", () => {
    const active = plan({ id: "active", controlState: "active" });
    const draft = plan({ id: "draft", controlState: "draft" });
    expect(selectCurrentHubPlan([draft, active])).toBe(active);
  });

  it("deduplicates immutable events by sequence and reads the event's own snapshot", () => {
    const historical = event(3, plan({ id: "plan-a", controlState: "draft" }));
    const duplicate = { ...historical, kind: "plan.confirmed" };
    const merged = mergeHubPlanEvents([historical], [duplicate]);
    expect(merged).toEqual([historical]);
    expect(snapshotFromHubPlanEvent(historical)?.controlState).toBe("draft");
  });

  it("retains business history across plan changes and deduplicates each Hub event", () => {
    const previousPlanEvent = event(1, plan({ id: "previous-plan", controlState: "completed" }));
    const currentPlanEvent = event(2, plan({ id: "current-plan", controlState: "draft" }));
    expect(mergeHubPlanEvents([previousPlanEvent], [currentPlanEvent])).toEqual([
      previousPlanEvent,
      currentPlanEvent,
    ]);
  });

  it("does not let an equal-version historical event replace fresh native facts", () => {
    const oldBase = plan({ id: "plan-a", controlState: "active" });
    const oldSnapshot = {
      ...oldBase,
      definition: { ...oldBase.definition, objective: "Historical objective" },
    };
    const nativeBase = plan({ id: "plan-a", controlState: "active" });
    const nativeSnapshot = {
      ...nativeBase,
      definition: { ...nativeBase.definition, objective: "Fresh native objective" },
    };
    expect(latestSnapshotFromHubPlanEvents([event(4, oldSnapshot)], nativeSnapshot)).toBe(
      nativeSnapshot,
    );
  });

  it("ignores malformed historical snapshots instead of treating them as current plan data", () => {
    const malformed = {
      ...event(1, plan({ id: "plan-a", controlState: "draft" })),
      payload: { snapshot: { id: "plan-a", graph: { stages: [{}] } } },
    };
    expect(snapshotFromHubPlanEvent(malformed)).toBeNull();
  });

  it("merges plan rows by createdAt then sequence, preserving ordinary row order on ties", () => {
    const ordinaryRows = [
      { kind: "working", id: "before", createdAt: "2026-10-22T10:00:00.000Z" },
      { kind: "working", id: "after", createdAt: "2026-10-22T10:01:00.000Z" },
    ] as unknown as MessagesTimelineRow[];
    const timelineEvents = [
      event(2, plan({ id: "plan-a", controlState: "active" })),
      {
        ...event(1, plan({ id: "plan-a", controlState: "draft" })),
        createdAt: "2026-10-22T10:00:00.000Z",
      },
    ];
    const rows = mergeHubPlanEventRows(ordinaryRows, timelineEvents);
    expect(rows.map((row) => row.id)).toEqual([
      "before",
      "hub-plan:plan-a:1",
      "hub-plan:plan-a:2",
      "after",
    ]);
  });

  it("keeps state-only plan events out of the transcript while preserving business events", () => {
    const ordinaryRows = [] as MessagesTimelineRow[];
    const business = event(1, plan({ id: "plan-a", controlState: "draft" }));
    const stateOnly = { ...business, sequence: 2, kind: "worker_started" };
    const retried = { ...business, sequence: 3, kind: "plan.retried" };
    const rows = mergeHubPlanEventRows(ordinaryRows, [business, stateOnly, retried]);
    expect(rows.map((row) => row.id)).toEqual(["hub-plan:plan-a:1", "hub-plan:plan-a:3"]);
  });

  it.each(["plan.input-requested", "plan.input-responded", "plan.input-delivered"])(
    "keeps %s in the Hub timeline receipt history",
    (kind) => {
      const inputEvent = { ...event(4, plan({ id: "plan-a", controlState: "active" })), kind };
      expect(isHubPlanTimelineEvent(inputEvent)).toBe(true);
      expect(isHubPlanControlEvent(inputEvent)).toBe(false);
      expect(mergeHubPlanEventRows([], [inputEvent]).map((row) => row.id)).toEqual([
        "hub-plan:plan-a:4",
      ]);
    },
  );
});
