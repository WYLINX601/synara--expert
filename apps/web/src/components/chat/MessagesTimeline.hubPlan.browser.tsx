import "../../index.css";

import { MessageId, ProjectId, type HubPlanEvent, type HubPlanSnapshot } from "@synara/contracts";
import { useEffect, useRef, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

import type { deriveTimelineEntries } from "../../session-logic";
import {
  HubPlanTimelineProvider,
  useHubPlanTimeline,
  type HubPlanTimelineValue,
} from "~/features/hubCollaboration/HubPlanTimelineContext";
import { MessagesTimeline, type MessagesTimelineController } from "./MessagesTimeline";

type TimelineEntries = ReturnType<typeof deriveTimelineEntries>;

const hubId = ProjectId.makeUnsafe("hub-plan-detached-reader");

function event(createdAt = "2026-10-22T10:02:30.000Z"): HubPlanEvent {
  const snapshot = {
    id: "plan-detached",
    hubId,
    goalId: null,
    revision: 1,
    stateVersion: 1,
    controlState: "draft",
    definition: {
      objective: "Review the release plan",
      scope: "Check the defined release scope.",
      stages: [{ key: "review", title: "Review", releasePolicy: "user" }],
      nodes: [],
      maxRepairRounds: 0,
    },
    createdAt: "2026-10-22T10:00:00.000Z",
    updatedAt: "2026-10-22T10:00:00.000Z",
    graph: {
      controlState: "draft",
      stages: [
        {
          stageKey: "review",
          title: "Review",
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
    eventSequence: 1,
  } as unknown as HubPlanSnapshot;
  return {
    sequence: 1,
    planId: snapshot.id,
    hubId,
    kind: "plan.proposed",
    payload: { snapshot },
    createdAt,
  };
}

function seededEntries(count = 18): TimelineEntries {
  return Array.from({ length: count }, (_, index) => {
    const createdAt = new Date(Date.UTC(2026, 9, 22, 10, index)).toISOString();
    const id = MessageId.makeUnsafe(`detached-reader-${index}`);
    return {
      id: `entry-${id}`,
      kind: "message" as const,
      createdAt,
      message: {
        id,
        role: "user" as const,
        text: `Question ${index}. ${"Detailed notes for this detached-reader row. ".repeat(14)}`,
        createdAt,
        streaming: false,
      },
    };
  });
}

const STABLE_ENTRIES = seededEntries();
const LONG_STABLE_ENTRIES = seededEntries(120);
const STABLE_PLAN_EVENT = event("2026-10-22T11:59:30.000Z");
const STABLE_PLAN_SNAPSHOT = (STABLE_PLAN_EVENT.payload as { snapshot: HubPlanSnapshot }).snapshot;
const EMPTY_PLAN_EVENTS: ReadonlyArray<HubPlanEvent> = [];
const EMPTY_COUNT_MAP = new Map();
const noop = () => undefined;
const noopHubPlanAction: HubPlanTimelineValue["onAction"] = async () => undefined;
const noopBeginInputReply: HubPlanTimelineValue["onBeginInputReply"] = () => undefined;
const noopRespondInput: HubPlanTimelineValue["onRespondInput"] = async () => {
  throw new Error("No input response handler in this fixture.");
};
const noopOpenThread: HubPlanTimelineValue["onOpenThread"] = () => undefined;

function ContextUpdateProbe() {
  const value = useHubPlanTimeline();
  const [contextUpdates, setContextUpdates] = useState(0);
  useEffect(() => {
    setContextUpdates((count) => count + 1);
  }, [value]);
  return <output aria-label="Hub timeline context updates">{contextUpdates}</output>;
}

function StableContextRerenderHarness({ navigationTest = false }: { navigationTest?: boolean }) {
  const controllerRef = useRef<MessagesTimelineController | null>(null);
  const [parentRenders, setParentRenders] = useState(0);
  const [snapshot, setSnapshot] = useState(STABLE_PLAN_SNAPSHOT);
  const [events, setEvents] = useState<ReadonlyArray<HubPlanEvent>>(
    navigationTest ? [event()] : EMPTY_PLAN_EVENTS,
  );
  return (
    <HubPlanTimelineProvider
      value={{
        snapshot,
        events,
        connected: true,
        onAction: noopHubPlanAction,
        onBeginInputReply: noopBeginInputReply,
        onRespondInput: noopRespondInput,
        onOpenThread: noopOpenThread,
      }}
    >
      <ContextUpdateProbe />
      {navigationTest ? (
        <button
          type="button"
          onClick={() => controllerRef.current?.scrollToHubPlanEvent?.("plan-detached", 1)}
        >
          Open existing plan operation
        </button>
      ) : null}
      <button type="button" onClick={() => setParentRenders((count) => count + 1)}>
        Unrelated parent render {parentRenders}
      </button>
      <button
        type="button"
        onClick={() => {
          setSnapshot({ ...STABLE_PLAN_SNAPSHOT, stateVersion: 2 });
          setEvents([STABLE_PLAN_EVENT]);
        }}
      >
        Apply Hub plan update
      </button>
      <div style={{ height: 320 }}>
        <MessagesTimeline
          controllerRef={controllerRef}
          hasMessages
          isWorking={false}
          activeTurnInProgress={false}
          activeTurnStartedAt={null}
          followLiveOutput={false}
          timelineEntries={LONG_STABLE_ENTRIES}
          messageChangeSignal="stable-long-history"
          turnDiffSummaryByAssistantMessageId={EMPTY_COUNT_MAP}
          onOpenTurnDiff={noop}
          revertTurnCountByUserMessageId={EMPTY_COUNT_MAP}
          onRevertUserMessage={noop}
          isRevertingCheckpoint={false}
          onImageExpand={noop}
          markdownCwd={undefined}
          resolvedTheme="dark"
          timestampFormat="locale"
          workspaceRoot={undefined}
        />
      </div>
    </HubPlanTimelineProvider>
  );
}

function DetachedReaderHarness() {
  const [events, setEvents] = useState<readonly HubPlanEvent[]>([]);
  const [eventCreatedAt, setEventCreatedAt] = useState("2026-10-22T10:02:30.000Z");
  const planEvent = event(eventCreatedAt);
  const snapshot = (planEvent.payload as { snapshot: HubPlanSnapshot }).snapshot;
  return (
    <HubPlanTimelineProvider
      value={{
        snapshot,
        events,
        connected: true,
        onAction: async () => undefined,
        onBeginInputReply: noopBeginInputReply,
        onRespondInput: noopRespondInput,
        onOpenThread: noopOpenThread,
      }}
    >
      <label>
        Plan event time
        <input
          aria-label="Plan event time"
          value={eventCreatedAt}
          onChange={(change) => setEventCreatedAt(change.target.value)}
        />
      </label>
      <button onClick={() => setEvents([planEvent])}>Append plan event</button>
      <div style={{ height: 320 }}>
        <MessagesTimeline
          hasMessages
          isWorking={false}
          activeTurnInProgress={false}
          activeTurnStartedAt={null}
          followLiveOutput={false}
          timelineEntries={STABLE_ENTRIES}
          messageChangeSignal="stable-history"
          turnDiffSummaryByAssistantMessageId={new Map()}
          onOpenTurnDiff={() => {}}
          revertTurnCountByUserMessageId={new Map()}
          onRevertUserMessage={() => {}}
          isRevertingCheckpoint={false}
          onImageExpand={() => {}}
          markdownCwd={undefined}
          resolvedTheme="dark"
          timestampFormat="locale"
          workspaceRoot={undefined}
        />
      </div>
    </HubPlanTimelineProvider>
  );
}

describe("Hub plan events in a detached transcript", () => {
  it("mounts and focuses the existing operation card when navigating from distant history", async () => {
    const screen = await render(<StableContextRerenderHarness navigationTest />);
    try {
      const selector = '[data-hub-plan-id="plan-detached"][data-hub-plan-event="1"]';
      await vi.waitFor(() => {
        const container = document.querySelector<HTMLElement>(
          "[data-chat-scroll-container='true']",
        );
        expect(container).not.toBeNull();
        expect(container!.scrollTop).toBeGreaterThan(1000);
        expect(document.querySelector(selector)).toBeNull();
      });
      await page.getByRole("button", { name: "Open existing plan operation" }).click();
      await vi.waitFor(() => {
        const card = document.querySelector(selector);
        expect(card).not.toBeNull();
        expect(document.activeElement).toBe(card);
      });
    } finally {
      await screen.unmount();
    }
  });
  it("keeps coordinator timeline layout stable across plan and unrelated state updates", async () => {
    const screen = await render(<StableContextRerenderHarness />);
    try {
      await expect
        .element(page.getByRole("status", { name: "Hub timeline context updates" }))
        .toHaveTextContent("1");
      await page.getByRole("button", { name: "Apply Hub plan update" }).click();
      await expect.element(page.getByRole("article", { name: /Hub 操作卡/ })).toBeInTheDocument();
      await expect
        .element(page.getByRole("status", { name: "Hub timeline context updates" }))
        .toHaveTextContent("2");
      await page.getByRole("button", { name: /Unrelated parent render/ }).click();
      await expect
        .element(page.getByRole("status", { name: "Hub timeline context updates" }))
        .toHaveTextContent("2");
      await expect.element(page.getByText("Unrelated parent render 1")).toBeInTheDocument();
    } finally {
      await screen.unmount();
    }
  });

  it("keeps the visible message anchor when an event is inserted above the reader", async () => {
    const screen = await render(<DetachedReaderHarness />);
    try {
      const container = document.querySelector<HTMLElement>("[data-chat-scroll-container='true']");
      expect(container).not.toBeNull();
      container!.scrollTop = Math.floor(container!.scrollHeight * 0.55);
      container!.dispatchEvent(new Event("scroll", { bubbles: true }));
      let anchor: HTMLElement | null = null;
      await vi.waitFor(() => {
        const bounds = container!.getBoundingClientRect();
        anchor =
          [...container!.querySelectorAll<HTMLElement>("[data-message-id]")].find((row) => {
            const rect = row.getBoundingClientRect();
            return rect.bottom > bounds.top && rect.top < bounds.bottom;
          }) ?? null;
        expect(anchor).not.toBeNull();
      });
      const anchorMessageId = anchor!.getAttribute("data-message-id");
      const anchorTop = anchor!.getBoundingClientRect().top;
      const anchorIndex = Number(anchorMessageId?.split("-").at(-1));
      const eventMinute = Math.max(0, anchorIndex - 1);
      const eventTime = `2026-10-22T10:${String(eventMinute).padStart(2, "0")}:30.000Z`;

      await page.getByRole("textbox", { name: "Plan event time" }).fill(eventTime);
      await page.getByRole("button", { name: "Append plan event" }).click();
      await expect
        .element(page.getByRole("article", { name: /Hub 操作卡：计划提议/ }))
        .toBeInTheDocument();
      await vi.waitFor(() => {
        const stillVisible = container!.querySelector<HTMLElement>(
          `[data-message-id="${anchorMessageId}"]`,
        );
        expect(stillVisible).not.toBeNull();
        expect(Math.abs(stillVisible!.getBoundingClientRect().top - anchorTop)).toBeLessThan(8);
      });
    } finally {
      await screen.unmount();
    }
  });
});
