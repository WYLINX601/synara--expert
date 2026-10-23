import "../../index.css";

import {
  ProjectId,
  ProjectTaskAttemptId,
  ProjectTaskId,
  ThreadId,
  type HubPlanInputRequest,
  type HubPlanSnapshot,
} from "@synara/contracts";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

import { Button } from "~/components/ui/button";
import {
  readHubInputRequestReplyDraft,
  setHubInputRequestReplyDraft,
  useHubInputRequestReplyDraft,
} from "~/workbench/host/hubInputRequestDraftClient";

import { HubInputRequestReplyComposer } from "./HubInputRequestReplyComposer";
import {
  hubInputRequestDraftKey,
  parseHubInputRequestDraft,
  type HubInputRequestReplyTarget,
} from "./hubInputRequest.logic";

const hubId = ProjectId.makeUnsafe("hub-input-reply-browser-test");
const workerThreadId = ThreadId.makeUnsafe("worker-input-reply-test");
const ordinaryThreadId = ThreadId.makeUnsafe("ordinary-hub-thread");

function request(id: string): HubPlanInputRequest {
  return {
    id,
    nodeKey: "worker-node",
    stageKey: "design-stage",
    generation: 3,
    attemptId: ProjectTaskAttemptId.makeUnsafe("worker-attempt-3"),
    workerThreadId,
    questions: [{ title: "Which release?", options: ["Stable", "Canary"] }, { title: "Why?" }],
    status: "pending",
  };
}

const requestA = request("input-request-a");
const requestB = request("input-request-b");

const plan: HubPlanSnapshot = {
  id: "plan-input-reply",
  hubId,
  goalId: null,
  revision: 5,
  stateVersion: 8,
  controlState: "active",
  definition: {
    objective: "Prepare the release plan",
    scope: "Answer the author's open questions.",
    stages: [{ key: "design-stage", title: "Design", releasePolicy: "user" }],
    nodes: [
      {
        key: "worker-node",
        stageKey: "design-stage",
        title: "Prepare the proposal",
        brief: "Draft the rollout and verification details.",
        role: "author",
        expertId: "product-owner",
        dependsOnNodeKeys: [],
        workMode: "agent",
        acceptanceCriteria: "Cover release and verification.",
      },
    ],
    maxRepairRounds: 0,
  },
  createdAt: "2026-10-23T00:00:00.000Z",
  updatedAt: "2026-10-23T00:00:00.000Z",
  graph: {
    controlState: "active",
    stages: [
      {
        stageKey: "design-stage",
        title: "Design",
        releasePolicy: "user",
        generation: 3,
        status: "running",
        underlyingStatus: "running",
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
  nodeStates: [
    {
      nodeKey: "worker-node",
      taskId: ProjectTaskId.makeUnsafe("worker-task"),
      workerThreadId,
      attemptId: ProjectTaskAttemptId.makeUnsafe("worker-attempt-3"),
    },
  ],
  inputRequests: [requestA, requestB],
  eventSequence: 8,
};

function target(inputRequest: HubPlanInputRequest): HubInputRequestReplyTarget {
  return {
    hubId,
    planId: plan.id,
    revision: plan.revision,
    request: inputRequest,
    event: {
      sequence: inputRequest.id === requestA.id ? 7 : 8,
      planId: plan.id,
      hubId,
      kind: "plan.input-requested",
      payload: { snapshot: plan, inputRequest },
      createdAt: "2026-10-23T00:00:00.000Z",
    },
  };
}

function DraftHarness(props: {
  readonly planSnapshot?: HubPlanSnapshot | null;
  readonly connected?: boolean;
  readonly onSubmit?: (
    inputRequest: HubPlanInputRequest,
    answers: ReadonlyArray<string>,
  ) => Promise<HubPlanSnapshot>;
}) {
  const [openRequestId, setOpenRequestId] = useState<string | null>(requestA.id);
  const ordinaryDraft = useHubInputRequestReplyDraft(ordinaryThreadId);
  const activeTarget = openRequestId === requestA.id ? target(requestA) : target(requestB);
  const currentPlan = props.planSnapshot === undefined ? plan : props.planSnapshot;
  return (
    <div className="space-y-3 p-4">
      <output aria-label="Ordinary Hub draft">{ordinaryDraft}</output>
      <Button type="button" onClick={() => setOpenRequestId(requestA.id)}>
        Open request A
      </Button>
      <Button type="button" onClick={() => setOpenRequestId(requestB.id)}>
        Open request B
      </Button>
      {openRequestId ? (
        <HubInputRequestReplyComposer
          key={hubInputRequestDraftKey(activeTarget)}
          target={activeTarget}
          plan={currentPlan}
          connected={props.connected ?? true}
          onSubmit={props.onSubmit ?? (async () => plan)}
          onCancel={() =>
            setOpenRequestId((current) => (current === openRequestId ? null : current))
          }
        />
      ) : null}
    </div>
  );
}

function WorkerHandoffHarness(props: {
  readonly onSubmit: (
    inputRequest: HubPlanInputRequest,
    answers: ReadonlyArray<string>,
  ) => Promise<HubPlanSnapshot>;
}) {
  const [activeThreadId, setActiveThreadId] = useState<ThreadId | null>(null);
  const [replyTarget, setReplyTarget] = useState<HubInputRequestReplyTarget | null>(null);
  return (
    <div className="space-y-3 p-4">
      <output aria-label="Active thread">{activeThreadId ?? "Hub coordinator"}</output>
      <Button
        type="button"
        onClick={() => {
          setReplyTarget(target(requestA));
          setActiveThreadId(workerThreadId);
        }}
      >
        去回答
      </Button>
      {replyTarget && replyTarget.request.workerThreadId === activeThreadId ? (
        <HubInputRequestReplyComposer
          key={hubInputRequestDraftKey(replyTarget)}
          target={replyTarget}
          plan={plan}
          connected
          onSubmit={props.onSubmit}
          onCancel={() =>
            setReplyTarget((current) =>
              current && hubInputRequestDraftKey(current) === hubInputRequestDraftKey(replyTarget)
                ? null
                : current,
            )
          }
        />
      ) : null}
    </div>
  );
}

function seedDrafts() {
  const keyA = hubInputRequestDraftKey(target(requestA));
  const keyB = hubInputRequestDraftKey(target(requestB));
  setHubInputRequestReplyDraft(ordinaryThreadId, "Normal Hub message draft");
  setHubInputRequestReplyDraft(
    keyA,
    JSON.stringify({ answers: ["Stable", "Answer for A"], questionIndex: 0 }),
  );
  setHubInputRequestReplyDraft(
    keyB,
    JSON.stringify({ answers: ["Canary", "Answer for B"], questionIndex: 0 }),
  );
  return { keyA, keyB };
}

function clearDrafts(keys: { readonly keyA: ThreadId; readonly keyB: ThreadId }) {
  setHubInputRequestReplyDraft(ordinaryThreadId, "");
  setHubInputRequestReplyDraft(keys.keyA, "");
  setHubInputRequestReplyDraft(keys.keyB, "");
}

describe("Hub Worker contextual reply drafts", () => {
  it("restores isolated answers after cancel without changing the ordinary Hub draft", async () => {
    const keys = seedDrafts();
    const screen = await render(<DraftHarness />);
    try {
      await expect
        .element(page.getByRole("button", { name: "Stable" }))
        .toHaveAttribute("aria-pressed", "true");
      await page.getByRole("button", { name: "Next question" }).click();
      await expect
        .element(page.getByRole("textbox", { name: "自定义回复：Why?" }))
        .toHaveValue("Answer for A");
      await expect.element(page.getByText("Normal Hub message draft")).toBeInTheDocument();

      await page.getByRole("button", { name: "取消定向" }).click();
      await page.getByRole("button", { name: "Open request B" }).click();
      await expect
        .element(page.getByRole("button", { name: "Canary" }))
        .toHaveAttribute("aria-pressed", "true");
      await page.getByRole("button", { name: "Next question" }).click();
      await expect
        .element(page.getByRole("textbox", { name: "自定义回复：Why?" }))
        .toHaveValue("Answer for B");

      await page.getByRole("button", { name: "取消定向" }).click();
      await page.getByRole("button", { name: "Open request A" }).click();
      await expect
        .element(page.getByRole("textbox", { name: "自定义回复：Why?" }))
        .toHaveValue("Answer for A");
      expect(readHubInputRequestReplyDraft(ordinaryThreadId)).toBe("Normal Hub message draft");
    } finally {
      await screen.unmount();
      clearDrafts(keys);
    }
  });

  it("keeps a draft editable when its request becomes stale and disables submission", async () => {
    const keys = seedDrafts();
    const stalePlan: HubPlanSnapshot = {
      ...plan,
      inputRequests: plan.inputRequests?.map((inputRequest) =>
        inputRequest.id === requestA.id
          ? { ...inputRequest, status: "stale" as const }
          : inputRequest,
      ),
    };
    const screen = await render(<DraftHarness planSnapshot={stalePlan} />);
    try {
      const firstAnswer = page.getByRole("textbox", { name: "自定义回复：Which release?" });
      await firstAnswer.fill("A custom reply while stale");
      await page.getByRole("button", { name: "Next question" }).click();
      const secondAnswer = page.getByRole("textbox", { name: "自定义回复：Why?" });
      await secondAnswer.fill("Draft preserved while stale");
      await expect.element(page.getByRole("button", { name: "提交回复" })).toBeDisabled();
      expect(parseHubInputRequestDraft(readHubInputRequestReplyDraft(keys.keyA), 2)).toEqual({
        answers: ["A custom reply while stale", "Draft preserved while stale"],
        questionIndex: 1,
      });
    } finally {
      await screen.unmount();
      clearDrafts(keys);
    }
  });

  it.each([
    ["answered", "已提交回复，等待送达 Worker"],
    ["delivered", "回复已送达 Worker"],
  ] as const)(
    "shows the persisted %s receipt without losing its draft",
    async (status, receipt) => {
      const keys = seedDrafts();
      const receiptRequest: HubPlanInputRequest = {
        ...requestA,
        status,
        answers: ["Stable", "The saved Worker reply."],
      };
      const receiptPlan: HubPlanSnapshot = {
        ...plan,
        inputRequests: (plan.inputRequests ?? []).map((inputRequest) =>
          inputRequest.id === requestA.id ? receiptRequest : inputRequest,
        ),
      };
      const screen = await render(<DraftHarness planSnapshot={receiptPlan} />);
      try {
        await expect
          .element(page.getByText(`${receipt}。草稿已保留；当前不能提交。`, { exact: true }))
          .toBeInTheDocument();
        await expect.element(page.getByRole("button", { name: "提交回复" })).toBeDisabled();
        expect(readHubInputRequestReplyDraft(keys.keyA)).toBe(
          JSON.stringify({ answers: ["Stable", "Answer for A"], questionIndex: 0 }),
        );

        await page.getByRole("button", { name: "取消定向" }).click();
        await expect.element(page.getByText("Normal Hub message draft")).toBeInTheDocument();
      } finally {
        await screen.unmount();
        clearDrafts(keys);
      }
    },
  );

  it("does not let an old completion close a newly selected request or clear its draft", async () => {
    const keys = seedDrafts();
    let releaseReply!: (snapshot: HubPlanSnapshot) => void;
    const onSubmit = vi.fn(
      (inputRequest: HubPlanInputRequest, answers: ReadonlyArray<string>) =>
        new Promise<HubPlanSnapshot>((resolve) => {
          expect(inputRequest.id).toBe(requestA.id);
          expect(answers).toEqual(["Stable", "Answer for A"]);
          releaseReply = resolve;
        }),
    );
    const screen = await render(<DraftHarness onSubmit={onSubmit} />);
    try {
      await page.getByRole("button", { name: "提交回复" }).click();
      await vi.waitFor(() => expect(releaseReply).toBeTypeOf("function"));
      await page.getByRole("button", { name: "Open request B" }).click();
      await expect
        .element(page.getByRole("region", { name: "回复 Hub Worker 的问题" }))
        .toBeInTheDocument();

      releaseReply(plan);
      await vi.waitFor(() => expect(onSubmit).toHaveBeenCalledOnce());
      await page.getByRole("button", { name: "Next question" }).click();
      await expect
        .element(page.getByRole("textbox", { name: "自定义回复：Why?" }))
        .toHaveValue("Answer for B");
      expect(readHubInputRequestReplyDraft(keys.keyA)).toBe("");
      expect(
        parseHubInputRequestDraft(readHubInputRequestReplyDraft(keys.keyB), 2).answers,
      ).toEqual(["Canary", "Answer for B"]);
    } finally {
      await screen.unmount();
      clearDrafts(keys);
    }
  });

  it("opens the same request in its original Worker thread and submits that request directly", async () => {
    const keys = seedDrafts();
    const onSubmit = vi.fn(async () => plan);
    const screen = await render(<WorkerHandoffHarness onSubmit={onSubmit} />);
    try {
      await page.getByRole("button", { name: "去回答" }).click();
      await expect.element(page.getByLabelText("Active thread")).toHaveTextContent(workerThreadId);
      await expect.element(page.getByRole("button", { name: "提交回复" })).toBeInTheDocument();
      await expect.element(page.getByText("提交不会放行计划。")).toBeInTheDocument();
      await page.getByRole("button", { name: "提交回复" }).click();
      await vi.waitFor(() => expect(onSubmit).toHaveBeenCalledOnce());
      expect(onSubmit).toHaveBeenCalledExactlyOnceWith(requestA, ["Stable", "Answer for A"]);
    } finally {
      await screen.unmount();
      clearDrafts(keys);
    }
  });
});
