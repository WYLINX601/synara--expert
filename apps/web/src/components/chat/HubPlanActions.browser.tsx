import "../../index.css";

import {
  ProjectId,
  ProjectTaskAttemptId,
  ProjectTaskId,
  ThreadId,
  HubPlanEventSchema,
  type HubDeliverableReferenceMetadata,
  type HubPlanEvent,
  type HubPlanInputRequest,
  type HubPlanSnapshot,
} from "@synara/contracts";
import { Schema } from "effect";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

const harness = vi.hoisted(() => ({
  api: {
    list: vi.fn(),
    read: vi.fn(),
    events: vi.fn(),
    propose: vi.fn(),
    command: vi.fn(),
    readDeliverable: vi.fn(),
  },
  plan: null as HubPlanSnapshot | null,
  plans: null as HubPlanSnapshot[] | null,
  events: [] as HubPlanEvent[],
  capability: {
    capability: "supported" as const,
    generation: "connection-a" as string | null,
    connected: true,
  },
  snapshotListeners: new Set<() => void>(),
}));

vi.mock("~/hooks/useNativeApiServerCapability", () => ({
  useNativeApiServerCapabilitySnapshot: () => harness.capability,
}));
vi.mock("~/workbench/host/hubPlanClient", () => ({
  getHubPlansClient: () => harness.api,
  readHubPlanDeliverable: (reference: HubDeliverableReferenceMetadata) =>
    harness.api.readDeliverable(reference),
  observeHubProjectAgentSnapshots: (_projectId: ProjectId, listener: () => void) => {
    harness.snapshotListeners.add(listener);
    return () => harness.snapshotListeners.delete(listener);
  },
}));
vi.mock("~/components/WorkspaceFilePreview", () => ({
  WorkspaceFilePreview: (props: {
    readonly pinnedContent: { readonly encoding: string; readonly text?: string };
  }) => (
    <div data-testid="pinned-hub-plan-preview">
      {props.pinnedContent.encoding === "utf-8" ? props.pinnedContent.text : "Binary file"}
    </div>
  ),
}));
vi.mock("~/lib/visibleInterval", () => ({ startVisibleInterval: () => () => {} }));

import { GraphBoard } from "~/features/hubCollaboration/GraphBoard";
import { HubInputRequestReplyComposer } from "~/features/hubCollaboration/HubInputRequestReplyComposer";
import { HubPlanTimelineProvider } from "~/features/hubCollaboration/HubPlanTimelineContext";
import {
  hubInputRequestDraftKey,
  type HubInputRequestReplyTarget,
} from "~/features/hubCollaboration/hubInputRequest.logic";
import {
  isHubPlanControlEvent,
  isHubPlanTimelineEvent,
} from "~/features/hubCollaboration/hubPlan.logic";
import { PlanActionCard } from "~/features/hubCollaboration/PlanActionCard";
import { useHubPlans } from "~/features/hubCollaboration/useHubPlans";
import realV2ProposedEvent from "~/features/hubCollaboration/fixtures/local-note-search-acceptance-v2.event.json";
import { snapshotFromHubPlanEvent } from "~/features/hubCollaboration/hubPlan.logic";
import {
  readHubInputRequestReplyDraft,
  setHubInputRequestReplyDraft,
} from "~/workbench/host/hubInputRequestDraftClient";

const hubId = ProjectId.makeUnsafe("hub-plan-test");
const workerThreadId = ThreadId.makeUnsafe("worker-design");

function snapshot(input: {
  readonly id?: string;
  readonly controlState: HubPlanSnapshot["controlState"];
  readonly stateVersion?: number;
  readonly eventSequence?: number;
  readonly candidateId?: string | null;
  readonly generation?: number;
  readonly status?: HubPlanSnapshot["graph"]["stages"][number]["status"];
  readonly deliverableRefs?: HubPlanSnapshot["graph"]["stages"][number]["deliverableRefs"];
  readonly retryableNode?: boolean;
  readonly attemptId?: string;
  readonly inputRequests?: ReadonlyArray<HubPlanInputRequest>;
}): HubPlanSnapshot {
  const stageStatus = input.status ?? (input.candidateId ? "waiting_user" : "running");
  return {
    id: input.id ?? "plan-current",
    hubId,
    goalId: null,
    revision: 1,
    stateVersion: input.stateVersion ?? 1,
    controlState: input.controlState,
    definition: {
      objective: "Prepare the account recovery flow",
      scope: "Design and verify the account recovery change.",
      stages: [{ key: "design", title: "Design and verify", releasePolicy: "user" }],
      nodes: [
        {
          key: "author",
          stageKey: "design",
          title: "Prepare the recovery proposal",
          brief: "Prepare a user-facing recovery proposal.",
          role: "author",
          dependsOnNodeKeys: [],
          workMode: "agent",
          acceptanceCriteria: "The proposal covers recovery and verification.",
        },
      ],
      maxRepairRounds: 2,
    },
    createdAt: "2026-10-22T10:00:00.000Z",
    updatedAt: "2026-10-22T10:01:00.000Z",
    graph: {
      controlState: input.controlState,
      stages: [
        {
          stageKey: "design",
          title: "Design and verify",
          releasePolicy: "user",
          generation:
            input.generation ??
            input.inputRequests?.[0]?.generation ??
            (input.candidateId ? 1 : null),
          status: stageStatus,
          underlyingStatus: stageStatus,
          isReleased: false,
          candidateId: input.candidateId ?? null,
          outputDigest: input.candidateId ? `digest-${input.candidateId}` : null,
          outputSummary: input.candidateId ? `Candidate summary for ${input.candidateId}` : null,
          ...(input.deliverableRefs ? { deliverableRefs: input.deliverableRefs } : {}),
          blockingReasons: [],
        },
      ],
      releasedCount: 0,
      stageCount: 1,
    },
    eventSequence: input.eventSequence ?? 1,
    nodeStates: [
      {
        nodeKey: "author",
        taskId: ProjectTaskId.makeUnsafe("task-author"),
        workerThreadId,
        attemptId: input.retryableNode
          ? ProjectTaskAttemptId.makeUnsafe(
              input.attemptId ?? input.inputRequests?.[0]?.attemptId ?? "attempt-author-1",
            )
          : (input.inputRequests?.find((request) => request.nodeKey === "author")?.attemptId ??
            null),
        ...(input.retryableNode ? { retryable: true } : {}),
      },
    ],
    ...(input.inputRequests ? { inputRequests: [...input.inputRequests] } : {}),
  } as unknown as HubPlanSnapshot;
}

function inputRequest(
  id = "input-request-author",
  questions: HubPlanInputRequest["questions"] = [
    { title: "Which recovery path?", options: ["Email", "Passkey"] },
    { title: "Why is this path preferred?" },
  ],
): HubPlanInputRequest {
  return {
    id,
    nodeKey: "author",
    stageKey: "design",
    generation: 2,
    attemptId: ProjectTaskAttemptId.makeUnsafe("attempt-author-2"),
    workerThreadId,
    questions,
    status: "pending",
  };
}

function inputReplyTarget(
  planSnapshot: HubPlanSnapshot,
  event: HubPlanEvent,
  request: HubPlanInputRequest,
): HubInputRequestReplyTarget {
  return {
    hubId: planSnapshot.hubId,
    planId: planSnapshot.id,
    revision: planSnapshot.revision,
    request,
    event,
  };
}

function LateResponseHookSurface(props: {
  readonly planA: HubPlanSnapshot;
  readonly planB: HubPlanSnapshot;
  readonly requestA: HubPlanInputRequest;
  readonly requestB: HubPlanInputRequest;
  readonly eventA: HubPlanEvent;
  readonly eventB: HubPlanEvent;
}) {
  const plans = useHubPlans({ hubId, enabled: true });
  const [target, setTarget] = useState<HubInputRequestReplyTarget | null>(() =>
    inputReplyTarget(props.planA, props.eventA, props.requestA),
  );
  const cancelTarget = (cancelledTarget: HubInputRequestReplyTarget) =>
    setTarget((current) =>
      current && hubInputRequestDraftKey(current) === hubInputRequestDraftKey(cancelledTarget)
        ? null
        : current,
    );

  return (
    <div className="space-y-3 p-4">
      <output aria-label="Race hook current plan">{plans.plan?.id ?? "loading"}</output>
      <output aria-label="Race hook selected request">{target?.request.id ?? "none"}</output>
      <button
        type="button"
        onClick={() => {
          harness.plans = [props.planB];
          harness.plan = props.planB;
          harness.events = [props.eventA, props.eventB];
          for (const listener of harness.snapshotListeners) listener();
          setTarget(inputReplyTarget(props.planB, props.eventB, props.requestB));
        }}
      >
        Select request B
      </button>
      {plans.plan && target ? (
        <HubInputRequestReplyComposer
          key={hubInputRequestDraftKey(target)}
          target={target}
          plan={plans.plan}
          connected={plans.connected}
          onSubmit={(request, answers) => plans.respondInputRequest(target.event, request, answers)}
          onCancel={() => cancelTarget(target)}
        />
      ) : null}
    </div>
  );
}

function planEvent(
  kind: string,
  sequence: number,
  planSnapshot: HubPlanSnapshot,
  payload: Record<string, unknown> = {},
): HubPlanEvent {
  return {
    sequence,
    planId: planSnapshot.id,
    hubId,
    kind,
    payload: { snapshot: planSnapshot, ...payload },
    createdAt: `2026-10-22T10:0${sequence}:00.000Z`,
  };
}

function deliverableReference(): HubDeliverableReferenceMetadata {
  return {
    hubId,
    workerThreadId,
    revision: 3,
    commitSha: "a".repeat(40),
    provenance: {
      hubId,
      workerThreadId,
      expertBindingSnapshotId: "binding-snapshot-1",
      publishedAt: "2026-10-22T10:00:00.000Z",
    },
    file: {
      path: "reports/recovery.md",
      libraryPath: "Artifacts/recovery.md",
      currentLibraryPath: "Artifacts/recovery.md",
      libraryState: "available",
      name: "recovery.md",
      description: "Recovery proposal",
      mediaType: "text/markdown",
      sizeBytes: 20,
      sha256: "b".repeat(64),
    },
  };
}

function TestSurface(props: { readonly activeHubId?: ProjectId } = {}) {
  const [draft, setDraft] = useState("Composer draft that should survive refreshes");
  const [replyTargetId, setReplyTargetId] = useState("");
  const [openedWorkerThreadId, setOpenedWorkerThreadId] = useState("");
  const [replyResult, setReplyResult] = useState("");
  const [, setConnectionRefresh] = useState(0);
  const plans = useHubPlans({ hubId: props.activeHubId ?? hubId, enabled: true });
  const latest = plans.plan;
  const inputEvent = plans.events.find((event) => event.kind === "plan.input-requested");
  const inputRequest = inputEvent?.payload.inputRequest;
  const beginInputReply = (target: { readonly request: HubPlanInputRequest }) =>
    setReplyTargetId(target.request.id);
  const openWorkerThread = (
    threadId: ThreadId,
    target?: { readonly request: HubPlanInputRequest },
  ) => {
    setOpenedWorkerThreadId(threadId);
    if (target) setReplyTargetId(target.request.id);
  };
  return (
    <HubPlanTimelineProvider
      value={{
        snapshot: latest,
        events: plans.events,
        connected: plans.connected,
        onAction: plans.performAction,
        onBeginInputReply: beginInputReply,
        onRespondInput: plans.respondInputRequest,
        onOpenThread: openWorkerThread,
      }}
    >
      <div className="space-y-3 p-4">
        <label className="flex flex-col gap-1 text-ui-sm">
          Composer draft
          <textarea
            aria-label="Composer draft"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
          />
        </label>
        <button
          type="button"
          onClick={() => {
            harness.capability = {
              ...harness.capability,
              generation: "connection-b",
            };
            setConnectionRefresh((value) => value + 1);
          }}
        >
          Change connection generation
        </button>
        <output>{plans.error ?? (plans.loading ? "Loading plans" : "Plan state loaded")}</output>
        <output aria-label="Selected reply request">{replyTargetId}</output>
        <output aria-label="Opened Worker thread">{openedWorkerThreadId}</output>
        <output aria-label="Input response result">{replyResult}</output>
        {inputEvent && inputRequest ? (
          <button
            type="button"
            onClick={() =>
              void plans
                .respondInputRequest(inputEvent, inputRequest, [
                  "Passkey",
                  "Use the stronger path.",
                ])
                .then(() => setReplyResult("accepted"))
                .catch((cause: unknown) =>
                  setReplyResult(cause instanceof Error ? cause.message : "failed"),
                )
            }
          >
            Respond input request
          </button>
        ) : null}
        {latest ? (
          <GraphBoard snapshot={latest} connected={plans.connected} onRefresh={plans.refresh} />
        ) : null}
        {plans.events.filter(isHubPlanTimelineEvent).map((event) => (
          <PlanActionCard
            key={`${event.planId}:${event.sequence}`}
            event={event}
            currentPlan={latest}
            latestTimelineEventSequence={plans.events
              .filter(
                (candidate) => candidate.planId === latest?.id && isHubPlanControlEvent(candidate),
              )
              .reduce((sequence, candidate) => Math.max(sequence, candidate.sequence), 0)}
            connected={plans.connected}
            onAction={plans.performAction}
            onBeginInputReply={beginInputReply}
            onOpenThread={openWorkerThread}
          />
        ))}
      </div>
    </HubPlanTimelineProvider>
  );
}

describe("Hub plan action surfaces", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    harness.snapshotListeners.clear();
    harness.plans = null;
    harness.capability = {
      capability: "supported",
      generation: "connection-a",
      connected: true,
    };
    harness.plan = snapshot({ controlState: "draft", status: "draft" });
    harness.events = [planEvent("plan.proposed", 1, harness.plan)];
    harness.api.list.mockImplementation(
      async () => harness.plans ?? (harness.plan ? [harness.plan] : []),
    );
    harness.api.read.mockImplementation(async () => harness.plan);
    harness.api.events.mockImplementation(async ({ afterSequence }: { afterSequence: number }) =>
      harness.events.filter((event) => event.sequence > afterSequence),
    );
    harness.api.command.mockImplementation(async () => harness.plan);
    harness.api.readDeliverable.mockImplementation(
      async (reference: HubDeliverableReferenceMetadata) => ({
        hubId: reference.hubId,
        workerThreadId: reference.workerThreadId,
        revision: reference.revision,
        commitSha: reference.commitSha,
        provenance: reference.provenance,
        file: reference.file,
        content: { encoding: "utf-8", text: "Pinned candidate body" },
      }),
    );
  });

  it("sends draft confirmation once while the first request is pending", async () => {
    let resolveCommand!: (value: HubPlanSnapshot) => void;
    const active = snapshot({ controlState: "active", stateVersion: 2, eventSequence: 2 });
    harness.api.command.mockImplementation(
      () =>
        new Promise<HubPlanSnapshot>((resolve) => {
          resolveCommand = resolve;
        }),
    );
    const screen = await render(<TestSurface />);
    try {
      const confirm = page.getByRole("button", { name: "确认计划", exact: true });
      await confirm.click();
      await vi.waitFor(() => expect(harness.api.command).toHaveBeenCalledTimes(1));
      await expect
        .element(page.getByRole("button", { name: /^(确认计划|确认中…)$/ }))
        .toBeDisabled();
      expect(harness.api.command.mock.calls[0]?.[0]).toMatchObject({
        action: "confirm",
        hubId,
        planId: "plan-current",
        expectedStateVersion: 1,
        expectedRevision: 1,
      });
      harness.plan = active;
      harness.events = [...harness.events, planEvent("plan.confirmed", 2, active)];
      resolveCommand(active);
      await expect.element(page.getByText("当前状态：协作进行中")).toBeInTheDocument();
      expect(harness.api.command).toHaveBeenCalledTimes(1);
    } finally {
      await screen.unmount();
    }
  });

  it("renders and confirms the real v2 proposed event snapshot from the Hub fixture", async () => {
    const actualEvent = Schema.decodeUnknownSync(HubPlanEventSchema)(realV2ProposedEvent);
    const actualPlan = snapshotFromHubPlanEvent(actualEvent);
    expect(actualPlan).not.toBeNull();
    harness.plan = actualPlan;
    harness.plans = actualPlan ? [actualPlan] : [];
    harness.events = [actualEvent];

    const screen = await render(<TestSurface activeHubId={actualEvent.hubId} />);
    try {
      await expect.element(page.getByText("计划 v2")).toBeInTheDocument();
      await expect
        .element(page.getByRole("button", { name: "确认计划", exact: true }))
        .toBeInTheDocument();
      await page.getByRole("button", { name: "确认计划", exact: true }).click();
      await vi.waitFor(() => expect(harness.api.command).toHaveBeenCalledTimes(1));
      expect(harness.api.command.mock.calls[0]?.[0]).toMatchObject({
        action: "confirm",
        hubId: actualEvent.hubId,
        planId: actualEvent.planId,
        expectedStateVersion: 2,
        expectedRevision: 2,
      });
    } finally {
      await screen.unmount();
    }
  });

  it("keeps an original input question actionable beside a newer unrelated event", async () => {
    const request = inputRequest();
    const parallelRequest = inputRequest("input-request-parallel", [
      { title: "Which identity check should run?", options: ["Email", "Device"] },
      { title: "Why is that check appropriate?" },
    ]);
    const current = snapshot({
      controlState: "active",
      stateVersion: 3,
      eventSequence: 5,
      inputRequests: [request, parallelRequest],
    });
    harness.plan = current;
    harness.events = [
      planEvent("plan.input-requested", 3, current, { inputRequest: request }),
      planEvent("plan.input-requested", 4, current, { inputRequest: parallelRequest }),
      planEvent("plan.resumed", 5, current),
    ];
    const screen = await render(<TestSurface />);
    try {
      await expect
        .element(page.getByText("Which recovery path?", { exact: true }))
        .toBeInTheDocument();
      await expect
        .element(
          page
            .getByLabelText("Hub 操作卡：恢复回执")
            .getByText("Which recovery path?", { exact: true }),
        )
        .not.toBeInTheDocument();
      await expect
        .element(
          page
            .getByLabelText("Hub 操作卡：Worker 请求补充信息")
            .nth(0)
            .getByText("Design and verify the account recovery change.", { exact: true }),
        )
        .not.toBeInTheDocument();
      await expect
        .element(
          page
            .getByLabelText("Hub 操作卡：Worker 请求补充信息")
            .nth(1)
            .getByText("Design and verify the account recovery change.", { exact: true }),
        )
        .not.toBeInTheDocument();
      await expect
        .element(
          page
            .getByLabelText("Hub 操作卡：恢复回执")
            .getByText("Design and verify the account recovery change.", { exact: true }),
        )
        .toBeInTheDocument();
      await expect
        .element(page.getByRole("button", { name: "在此回复" }).nth(1))
        .toBeInTheDocument();
      await expect.element(page.getByRole("button", { name: "暂停" })).toBeInTheDocument();
      await expect.element(page.getByRole("button", { name: "取消计划" })).toBeInTheDocument();
      await page.getByRole("button", { name: "在此回复" }).first().click();
      await expect.element(page.getByText(request.id)).toBeInTheDocument();
      await page.getByRole("button", { name: "去回答" }).first().click();
      await expect.element(page.getByText(workerThreadId)).toBeInTheDocument();
      await expect.element(page.getByText(request.id)).toBeInTheDocument();
    } finally {
      await screen.unmount();
    }
  });

  it.each([
    ["answered", "plan.input-responded", "已提交回复，等待送达 Worker"],
    ["delivered", "plan.input-delivered", "回复已送达 Worker"],
  ] as const)(
    "keeps an old same-id question separate from the %s receipt for a newer attempt",
    async (status, eventKind, receipt) => {
      const originalRequest = inputRequest();
      const originalPlan = snapshot({
        controlState: "active",
        stateVersion: 2,
        eventSequence: 2,
        inputRequests: [originalRequest],
      });
      const laterAttempt: HubPlanInputRequest = {
        ...inputRequest(originalRequest.id, [
          { title: "Which recovery path should the newer attempt use?", options: ["Email"] },
          { title: "Why does the newer attempt choose it?" },
        ]),
        generation: 3,
        attemptId: ProjectTaskAttemptId.makeUnsafe("attempt-author-3"),
        status,
        answers: ["Email", "Answer from the newer attempt."],
      };
      const currentPlan = snapshot({
        controlState: "active",
        stateVersion: 4,
        eventSequence: 4,
        generation: 3,
        inputRequests: [laterAttempt],
      });
      const originalEvent = planEvent("plan.input-requested", 2, originalPlan, {
        inputRequest: originalRequest,
      });
      const receiptEvent = planEvent(eventKind, 4, currentPlan, {
        inputRequestId: laterAttempt.id,
        answers: laterAttempt.answers,
        inputRequest: laterAttempt,
      });
      harness.plan = currentPlan;
      harness.plans = [currentPlan];
      harness.events = [originalEvent, receiptEvent];

      const screen = await render(<TestSurface />);
      try {
        const historicalCard = page.getByRole("article", {
          name: "Hub 操作卡：Worker 请求补充信息",
        });
        const currentCard = page.getByRole("article", {
          name:
            eventKind === "plan.input-responded"
              ? "Hub 操作卡：已提交 Worker 回复"
              : "Hub 操作卡：Worker 回复已送达",
        });

        await expect
          .element(historicalCard.getByText("等待回复", { exact: true }))
          .toBeInTheDocument();
        await expect
          .element(
            historicalCard.getByText("回复：Answer from the newer attempt.", { exact: true }),
          )
          .not.toBeInTheDocument();
        await expect
          .element(historicalCard.getByRole("button", { name: "在此回复" }))
          .not.toBeInTheDocument();
        await expect.element(currentCard.getByText(receipt, { exact: true })).toBeInTheDocument();
        await expect
          .element(currentCard.getByText("回复：Answer from the newer attempt.", { exact: true }))
          .toBeInTheDocument();
        await expect
          .element(currentCard.getByRole("button", { name: "在此回复" }))
          .not.toBeInTheDocument();
      } finally {
        await screen.unmount();
      }
    },
  );

  it("routes a contextual reply through the plan command with its request id and answers", async () => {
    const request = inputRequest();
    const current = snapshot({
      controlState: "active",
      stateVersion: 3,
      eventSequence: 3,
      inputRequests: [request],
    });
    harness.plan = current;
    harness.events = [planEvent("plan.input-requested", 3, current, { inputRequest: request })];
    const screen = await render(<TestSurface />);
    try {
      await page.getByRole("button", { name: "Respond input request" }).click();
      await expect
        .element(page.getByLabelText("Input response result"))
        .toHaveTextContent("accepted");
      expect(harness.api.command).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          action: "respondInput",
          hubId,
          planId: current.id,
          expectedStateVersion: current.stateVersion,
          expectedRevision: current.revision,
          inputRequestId: request.id,
          answers: ["Passkey", "Use the stronger path."],
        }),
      );
    } finally {
      await screen.unmount();
    }
  });

  it("rejects a duplicate contextual response while the request is being revalidated", async () => {
    const request = inputRequest();
    const current = snapshot({
      controlState: "active",
      stateVersion: 3,
      eventSequence: 3,
      inputRequests: [request],
    });
    harness.plan = current;
    harness.events = [planEvent("plan.input-requested", 3, current, { inputRequest: request })];
    const screen = await render(<TestSurface />);
    try {
      const read = harness.api.read;
      read.mockClear();
      let resolveRead!: (value: HubPlanSnapshot) => void;
      read.mockImplementation(
        () => new Promise<HubPlanSnapshot>((resolve) => (resolveRead = resolve)),
      );

      const response = page.getByRole("button", { name: "Respond input request" });
      await response.click();
      await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());
      await response.click();
      await expect
        .element(page.getByLabelText("Input response result"))
        .toHaveTextContent("正在提交");
      expect(read).toHaveBeenCalledOnce();

      resolveRead(current);
      await vi.waitFor(() => expect(harness.api.command).toHaveBeenCalledOnce());
      expect(harness.api.command.mock.calls[0]?.[0]).toMatchObject({
        action: "respondInput",
        inputRequestId: request.id,
      });
    } finally {
      await screen.unmount();
    }
  });

  it("does not submit a contextual reply after the connection generation changes", async () => {
    const request = inputRequest();
    const current = snapshot({
      controlState: "active",
      stateVersion: 3,
      eventSequence: 3,
      inputRequests: [request],
    });
    harness.plan = current;
    harness.events = [planEvent("plan.input-requested", 3, current, { inputRequest: request })];
    const screen = await render(<TestSurface />);
    try {
      await expect
        .element(page.getByRole("button", { name: "Respond input request" }))
        .toBeInTheDocument();
      harness.api.read.mockClear();
      let resolveRead!: (value: HubPlanSnapshot) => void;
      harness.api.read.mockImplementationOnce(
        () => new Promise<HubPlanSnapshot>((resolve) => (resolveRead = resolve)),
      );
      await page.getByRole("button", { name: "Respond input request" }).click();
      await vi.waitFor(() => expect(resolveRead).toBeTypeOf("function"));
      await page.getByRole("button", { name: "Change connection generation" }).click();
      resolveRead(current);
      await expect
        .element(page.getByLabelText("Input response result"))
        .toHaveTextContent("连接已变化");
      expect(harness.api.command).not.toHaveBeenCalled();
    } finally {
      await screen.unmount();
    }
  });

  it("keeps plan B and its reply draft when a delayed plan A response arrives", async () => {
    const requestA = inputRequest("input-request-plan-a");
    const requestB = inputRequest("input-request-plan-b", [
      { title: "Which B recovery path?", options: ["Email", "Passkey"] },
      { title: "Why does B choose this path?" },
    ]);
    const planA = snapshot({
      id: "plan-a",
      controlState: "active",
      stateVersion: 3,
      eventSequence: 3,
      inputRequests: [requestA],
    });
    const planB = snapshot({
      id: "plan-b",
      controlState: "active",
      stateVersion: 40,
      eventSequence: 4,
      inputRequests: [requestB],
    });
    const eventA = planEvent("plan.input-requested", 3, planA, { inputRequest: requestA });
    const eventB = planEvent("plan.input-requested", 4, planB, { inputRequest: requestB });
    const targetA = inputReplyTarget(planA, eventA, requestA);
    const targetB = inputReplyTarget(planB, eventB, requestB);
    const draftKeyA = hubInputRequestDraftKey(targetA);
    const draftKeyB = hubInputRequestDraftKey(targetB);
    const draftA = JSON.stringify({
      answers: ["Passkey", "Preferred for phishing resistance."],
      questionIndex: 1,
    });
    const draftB = JSON.stringify({
      answers: ["Email", "Existing B rationale."],
      questionIndex: 0,
    });
    const draftBAfterNavigation = JSON.stringify({
      answers: ["Email", "Existing B rationale."],
      questionIndex: 1,
    });
    setHubInputRequestReplyDraft(draftKeyA, draftA);
    setHubInputRequestReplyDraft(draftKeyB, draftB);
    harness.plan = planA;
    harness.plans = [planA];
    harness.events = [eventA];
    let resolveCommand!: (value: HubPlanSnapshot) => void;
    harness.api.command.mockImplementation(
      () =>
        new Promise<HubPlanSnapshot>((resolve) => {
          resolveCommand = resolve;
        }),
    );
    const answeredA: HubPlanSnapshot = {
      ...planA,
      stateVersion: 101,
      eventSequence: 101,
      inputRequests: [
        {
          ...requestA,
          status: "answered",
          answers: ["Passkey", "Preferred for phishing resistance."],
        },
      ],
    };

    const screen = await render(
      <LateResponseHookSurface
        planA={planA}
        planB={planB}
        requestA={requestA}
        requestB={requestB}
        eventA={eventA}
        eventB={eventB}
      />,
    );
    try {
      await expect
        .element(page.getByLabelText("Race hook current plan"))
        .toHaveTextContent(planA.id);
      await expect
        .element(page.getByRole("textbox", { name: "自定义回复：Why is this path preferred?" }))
        .toHaveValue("Preferred for phishing resistance.");

      await page.getByRole("button", { name: "提交回复" }).click();
      await vi.waitFor(() => expect(harness.api.command).toHaveBeenCalledOnce());

      await page.getByRole("button", { name: "Select request B" }).click();
      await expect
        .element(page.getByLabelText("Race hook current plan"))
        .toHaveTextContent(planB.id);
      await expect
        .element(page.getByLabelText("Race hook selected request"))
        .toHaveTextContent(requestB.id);
      await expect
        .element(page.getByRole("button", { name: "Email" }))
        .toHaveAttribute("aria-pressed", "true");
      await page.getByRole("button", { name: "Next question" }).click();
      await expect
        .element(page.getByRole("textbox", { name: "自定义回复：Why does B choose this path?" }))
        .toHaveValue("Existing B rationale.");

      resolveCommand(answeredA);
      await expect
        .element(page.getByLabelText("Race hook current plan"))
        .toHaveTextContent(planB.id);
      await expect
        .element(page.getByLabelText("Race hook selected request"))
        .toHaveTextContent(requestB.id);
      await expect
        .element(page.getByRole("textbox", { name: "自定义回复：Why does B choose this path?" }))
        .toHaveValue("Existing B rationale.");
      expect(readHubInputRequestReplyDraft(draftKeyA)).toBe("");
      expect(readHubInputRequestReplyDraft(draftKeyB)).toBe(draftBAfterNavigation);
    } finally {
      await screen.unmount();
      setHubInputRequestReplyDraft(draftKeyA, "");
      setHubInputRequestReplyDraft(draftKeyB, "");
    }
  });

  it("keeps a historical candidate read-only after a newer candidate replaces it", async () => {
    const oldCandidate = snapshot({
      controlState: "active",
      stateVersion: 2,
      eventSequence: 1,
      candidateId: "candidate-old",
    });
    const current = snapshot({
      controlState: "active",
      stateVersion: 3,
      eventSequence: 1,
      candidateId: "candidate-new",
    });
    harness.plan = current;
    harness.events = [planEvent("plan.candidate-submitted", 1, oldCandidate)];
    const screen = await render(<TestSurface />);
    try {
      await expect
        .element(page.getByText("Candidate summary for candidate-old"))
        .toBeInTheDocument();
      await expect
        .element(page.getByText("此候选已过期，当前计划中的候选版本已变化。"))
        .toBeInTheDocument();
      await expect
        .element(page.getByRole("button", { name: /确认并放行/ }))
        .not.toBeInTheDocument();
      expect(harness.api.command).not.toHaveBeenCalled();
    } finally {
      await screen.unmount();
    }
  });

  it("does not approve a candidate when its generation changes", async () => {
    const submitted = snapshot({
      controlState: "active",
      eventSequence: 1,
      candidateId: "candidate-same-id",
      generation: 1,
    });
    harness.plan = snapshot({
      controlState: "active",
      stateVersion: 2,
      eventSequence: 1,
      candidateId: "candidate-same-id",
      generation: 2,
    });
    harness.events = [planEvent("plan.candidate-submitted", 1, submitted)];
    const screen = await render(<TestSurface />);
    try {
      await expect
        .element(page.getByText("此候选已过期，当前计划中的候选版本已变化。"))
        .toBeInTheDocument();
      await expect
        .element(page.getByRole("button", { name: /确认并放行/ }))
        .not.toBeInTheDocument();
      expect(harness.api.command).not.toHaveBeenCalled();
    } finally {
      await screen.unmount();
    }
  });

  it("approves only the candidate identity recorded in the latest event", async () => {
    harness.plan = snapshot({
      controlState: "active",
      stateVersion: 2,
      eventSequence: 1,
      candidateId: "candidate-current",
      generation: 3,
    });
    harness.events = [planEvent("plan.candidate-submitted", 1, harness.plan)];
    const screen = await render(<TestSurface />);
    try {
      await page.getByRole("button", { name: /确认并放行/ }).click();
      await vi.waitFor(() => expect(harness.api.command).toHaveBeenCalledTimes(1));
      expect(harness.api.command.mock.calls[0]?.[0]).toMatchObject({
        action: "release",
        stageKey: "design",
        generation: 3,
        candidateId: "candidate-current",
        outputDigest: "digest-candidate-current",
      });
    } finally {
      await screen.unmount();
    }
  });

  it("keeps fresh list facts when an equal-version historical review event arrives", async () => {
    const reviewing = snapshot({
      controlState: "active",
      stateVersion: 4,
      eventSequence: 4,
      candidateId: "candidate-current",
      status: "reviewing",
    });
    const waiting = snapshot({
      controlState: "active",
      stateVersion: 4,
      eventSequence: 5,
      candidateId: "candidate-current",
      status: "waiting_user",
    });
    harness.plan = waiting;
    harness.events = [
      planEvent("plan.review-submitted", 4, reviewing),
      planEvent("plan.awaiting-release", 5, waiting),
    ];
    const screen = await render(<TestSurface />);
    try {
      await expect.element(page.getByRole("button", { name: /确认并放行/ })).toBeInTheDocument();
      await page.getByRole("button", { name: /确认并放行/ }).click();
      await vi.waitFor(() => expect(harness.api.command).toHaveBeenCalledTimes(1));
      expect(harness.api.command.mock.calls[0]?.[0]).toMatchObject({
        action: "release",
        candidateId: "candidate-current",
        generation: 1,
      });
    } finally {
      await screen.unmount();
    }
  });

  it("offers return for changes requested candidates and keeps pause available", async () => {
    harness.plan = snapshot({
      controlState: "active",
      stateVersion: 2,
      eventSequence: 2,
      candidateId: "candidate-needs-changes",
      status: "changes_requested",
    });
    harness.events = [planEvent("plan.review-submitted", 2, harness.plan)];
    const screen = await render(<TestSurface />);
    try {
      await expect.element(page.getByText("候选成果")).toBeInTheDocument();
      await expect.element(page.getByRole("button", { name: "退回修改" })).toBeInTheDocument();
      await expect.element(page.getByRole("button", { name: "暂停" })).toBeInTheDocument();
      await page.getByRole("textbox", { name: "退回修改意见" }).fill("请补齐验证步骤");
      await page.getByRole("button", { name: "退回修改" }).click();
      await vi.waitFor(() => expect(harness.api.command).toHaveBeenCalledTimes(1));
      expect(harness.api.command.mock.calls[0]?.[0]).toMatchObject({
        action: "return",
        candidateId: "candidate-needs-changes",
        comment: "请补齐验证步骤",
      });
    } finally {
      await screen.unmount();
    }
  });

  it("reads and previews the exact candidate publication revision", async () => {
    const reference = deliverableReference();
    harness.plan = snapshot({
      controlState: "active",
      stateVersion: 2,
      eventSequence: 2,
      candidateId: "candidate-with-file",
      deliverableRefs: [reference],
    });
    harness.events = [planEvent("plan.candidate-submitted", 2, harness.plan)];
    const screen = await render(<TestSurface />);
    try {
      await expect.element(page.getByText("reports/recovery.md")).toBeInTheDocument();
      await expect.element(page.getByText("v3")).toBeInTheDocument();
      await page.getByRole("button", { name: "查看固定版本" }).click();
      await expect
        .element(page.getByTestId("pinned-hub-plan-preview"))
        .toHaveTextContent("Pinned candidate body");
      expect(harness.api.readDeliverable).toHaveBeenCalledExactlyOnceWith(reference);
    } finally {
      await screen.unmount();
    }
  });

  it("shows persisted reviewer summaries and return comments on their event cards", async () => {
    harness.plan = snapshot({
      controlState: "active",
      stateVersion: 3,
      eventSequence: 2,
      candidateId: "candidate-reviewed",
      status: "changes_requested",
    });
    harness.events = [
      planEvent("plan.review-submitted", 1, harness.plan, {
        summary: "审核指出缺少恢复失败后的验证步骤。",
      }),
      planEvent("plan.returned", 2, harness.plan, {
        comment: "请补充失败恢复路径的测试与预期结果。",
      }),
    ];
    const screen = await render(<TestSurface />);
    try {
      await expect.element(page.getByText("审核意见").first()).toBeInTheDocument();
      await expect
        .element(page.getByText("审核指出缺少恢复失败后的验证步骤。"))
        .toBeInTheDocument();
      await expect.element(page.getByText("退回修改意见")).toBeInTheDocument();
      await expect
        .element(page.getByText("请补充失败恢复路径的测试与预期结果。"))
        .toBeInTheDocument();
    } finally {
      await screen.unmount();
    }
  });

  it("disables retry actions from the previous connection generation until a full snapshot loads", async () => {
    harness.plan = snapshot({
      controlState: "active",
      stateVersion: 2,
      eventSequence: 2,
      status: "blocked",
      generation: 1,
      retryableNode: true,
    });
    harness.events = [planEvent("plan.retried", 2, harness.plan)];
    let resolveRefresh!: (value: HubPlanSnapshot[]) => void;
    harness.api.list
      .mockImplementationOnce(async () => [harness.plan!])
      .mockImplementationOnce(
        () =>
          new Promise<HubPlanSnapshot[]>((resolve) => {
            resolveRefresh = resolve;
          }),
      );
    const screen = await render(<TestSurface />);
    try {
      await expect
        .element(page.getByRole("button", { name: "重试：Prepare the recovery proposal" }))
        .toBeInTheDocument();
      await page.getByRole("button", { name: "Change connection generation" }).click();
      await vi.waitFor(() => expect(harness.api.list).toHaveBeenCalledTimes(2));
      await expect
        .element(page.getByRole("button", { name: "重试：Prepare the recovery proposal" }))
        .not.toBeInTheDocument();
      resolveRefresh([harness.plan!]);
      await expect
        .element(page.getByRole("button", { name: "重试：Prepare the recovery proposal" }))
        .toBeInTheDocument();
    } finally {
      await screen.unmount();
    }
  });

  it("offers retry on the latest business card even when its snapshot predates the attempt", async () => {
    harness.plan = snapshot({
      controlState: "active",
      stateVersion: 4,
      eventSequence: 2,
      status: "blocked",
      generation: 3,
      retryableNode: true,
    });
    const confirmedSnapshot = snapshot({
      controlState: "active",
      stateVersion: 1,
      eventSequence: 1,
      status: "running",
      generation: 3,
    });
    harness.events = [
      planEvent("plan.proposed", 1, confirmedSnapshot),
      planEvent("plan.confirmed", 2, confirmedSnapshot),
      planEvent("worker_finished", 3, harness.plan),
    ];
    const screen = await render(<TestSurface />);
    try {
      const retryButtons = page.getByRole("button", {
        name: "重试：Prepare the recovery proposal",
      });
      await expect.element(retryButtons.first()).toBeInTheDocument();
      expect(
        [...document.querySelectorAll("button")].filter(
          (button) => button.textContent?.trim() === "重试：Prepare the recovery proposal",
        ),
      ).toHaveLength(1);
      await retryButtons.first().click();
      await vi.waitFor(() => expect(harness.api.command).toHaveBeenCalledTimes(1));
      expect(harness.api.command.mock.calls[0]?.[0]).toMatchObject({
        action: "retry",
        nodeKey: "author",
        attemptId: "attempt-author-1",
        stageKey: "design",
        generation: 3,
        expectedStateVersion: 4,
        expectedRevision: 1,
      });
    } finally {
      await screen.unmount();
    }
  });

  it("rejects a retry if the live read now points at another attempt", async () => {
    harness.plan = snapshot({
      controlState: "active",
      stateVersion: 4,
      eventSequence: 2,
      status: "blocked",
      generation: 3,
      retryableNode: true,
    });
    const confirmedSnapshot = snapshot({
      controlState: "active",
      stateVersion: 1,
      eventSequence: 1,
      status: "running",
      generation: 3,
    });
    harness.events = [
      planEvent("plan.confirmed", 2, confirmedSnapshot),
      planEvent("worker_finished", 3, harness.plan),
    ];
    harness.api.read.mockResolvedValueOnce(
      snapshot({
        controlState: "active",
        stateVersion: 5,
        eventSequence: 2,
        status: "blocked",
        generation: 3,
        retryableNode: true,
        attemptId: "attempt-author-2",
      }),
    );
    const screen = await render(<TestSurface />);
    try {
      await page.getByRole("button", { name: "重试：Prepare the recovery proposal" }).click();
      await expect.element(page.getByRole("alert")).toHaveTextContent("无法重试");
      expect(harness.api.command).not.toHaveBeenCalled();
    } finally {
      await screen.unmount();
    }
  });

  it("preserves previous-plan history and keeps a new draft behind the active plan", async () => {
    const completed = snapshot({
      id: "plan-completed",
      controlState: "completed",
      stateVersion: 6,
      eventSequence: 1,
    });
    const active = snapshot({ id: "plan-active", controlState: "active", eventSequence: 2 });
    const draft = snapshot({
      id: "plan-new-draft",
      controlState: "draft",
      status: "draft",
      eventSequence: 3,
    });
    harness.plan = active;
    harness.plans = [draft, active];
    harness.events = [
      planEvent("plan.completed", 1, completed),
      planEvent("plan.confirmed", 2, active),
      planEvent("plan.proposed", 3, draft),
    ];
    const screen = await render(<TestSurface />);
    try {
      await expect.element(page.getByRole("button", { name: "暂停" })).toBeInTheDocument();
      await expect
        .element(page.getByRole("button", { name: "确认计划", exact: true }))
        .not.toBeInTheDocument();
      await expect
        .element(page.getByRole("article", { name: /Hub 操作卡：计划完成/ }))
        .toBeInTheDocument();
      await expect
        .element(page.getByRole("article", { name: /Hub 操作卡：计划提议/ }))
        .toBeInTheDocument();
    } finally {
      await screen.unmount();
    }
  });

  it("keeps actions on the latest business card when state-only events advance the snapshot", async () => {
    harness.plan = snapshot({ controlState: "draft", status: "draft", eventSequence: 4 });
    const proposed = planEvent(
      "plan.proposed",
      1,
      snapshot({ controlState: "draft", status: "draft" }),
    );
    const stateOnly = planEvent("worker_started", 4, harness.plan);
    harness.events = [proposed, stateOnly];
    const screen = await render(<TestSurface />);
    try {
      await expect
        .element(page.getByRole("button", { name: "确认计划", exact: true }))
        .toBeInTheDocument();
      expect(document.querySelectorAll("[data-hub-plan-event]")).toHaveLength(1);
    } finally {
      await screen.unmount();
    }
  });

  it("keeps the composer draft after a command network failure and refresh error", async () => {
    harness.api.command.mockRejectedValue(new Error("Network request failed"));
    harness.api.list
      .mockResolvedValueOnce([harness.plan!])
      .mockRejectedValueOnce(new Error("Network request failed"));
    const screen = await render(<TestSurface />);
    try {
      const draft = page.getByRole("textbox", { name: "Composer draft" });
      await draft.fill("Unsent question, keep exactly");
      await page.getByRole("button", { name: "确认计划", exact: true }).click();
      await expect.element(page.getByRole("alert")).toHaveTextContent("Network request failed");
      await expect.element(draft).toHaveValue("Unsent question, keep exactly");
      expect(harness.api.command).toHaveBeenCalledTimes(1);
    } finally {
      await screen.unmount();
    }
  });

  it("reuses the same request id when retrying an unconfirmed command", async () => {
    harness.api.command
      .mockRejectedValueOnce(new Error("Network request failed"))
      .mockResolvedValueOnce(harness.plan!);
    const screen = await render(<TestSurface />);
    try {
      await page.getByRole("button", { name: "确认计划", exact: true }).click();
      await expect.element(page.getByRole("alert")).toHaveTextContent("Network request failed");
      const firstRequestId = harness.api.command.mock.calls[0]?.[0].requestId;
      await page.getByRole("button", { name: "确认计划", exact: true }).click();
      await vi.waitFor(() => expect(harness.api.command).toHaveBeenCalledTimes(2));
      expect(harness.api.command.mock.calls[1]?.[0].requestId).toBe(firstRequestId);
    } finally {
      await screen.unmount();
    }
  });

  it("keeps Graph navigation read-only and opens only the mapped worker thread", async () => {
    const active = snapshot({ controlState: "active", eventSequence: 0 });
    const onOpenThread = vi.fn();
    const screen = await render(
      <GraphBoard snapshot={active} connected onOpenThread={onOpenThread} />,
    );
    try {
      await page.getByTestId("hub-graph-capsule").click();
      const graph = document.querySelector<HTMLElement>("[data-hub-pipeline-strip]")!;
      const buttons = [...graph.querySelectorAll("button")].map(
        (button) => button.textContent ?? "",
      );
      expect(buttons.some((label) => /暂停|恢复|取消|重试/.test(label))).toBe(false);
      await expect
        .element(page.getByRole("button", { name: "查看线程", exact: true }))
        .toBeVisible();
      await page.getByRole("button", { name: /已派发/ }).click();
      await page.getByRole("button", { name: "查看线程", exact: true }).click();
      expect(onOpenThread).toHaveBeenCalledWith(workerThreadId);
      expect(harness.api.command).not.toHaveBeenCalled();
    } finally {
      await screen.unmount();
    }
  });
});
