import "../../index.css";
import { ProjectTaskId, ThreadId, type HubPlanSnapshot } from "@synara/contracts";
import { describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import fixture from "~/features/hubCollaboration/fixtures/local-note-search-acceptance-v2.event.json";
import { GraphBoard } from "~/features/hubCollaboration/GraphBoard";
import { HubPipelineStrip } from "~/features/hubCollaboration/HubPipelineStrip";

function snapshot(mode: "blocked" | "running" | "release" | "completed"): HubPlanSnapshot {
  const base = fixture.payload.snapshot as unknown as HubPlanSnapshot;
  return {
    ...base,
    controlState: mode === "completed" ? "completed" : "active",
    nodeStates: base.definition.nodes.map((node, index) => ({
      nodeKey: node.key,
      taskId: ProjectTaskId.makeUnsafe(`task-${node.key}`),
      attemptId: null,
      workerThreadId: index === 0 ? ThreadId.makeUnsafe("graph-worker") : null,
      taskStatus:
        mode === "completed" || mode === "release" ? "done" : index === 0 ? "running" : "planned",
      ...(index === 0
        ? {
            workState:
              mode === "blocked"
                ? ("idle" as const)
                : mode === "running"
                  ? ("working" as const)
                  : ("completed" as const),
          }
        : {}),
      retryable: mode === "blocked" && index === 0,
      ...(mode === "blocked" && index === 0
        ? { progressSummary: "工作区只读，无法登记成果。" }
        : {}),
    })),
    graph: {
      ...base.graph,
      controlState: mode === "completed" ? "completed" : "active",
      stages: base.graph.stages.map((stage) =>
        Object.assign({}, stage, {
          status:
            mode === "release"
              ? "waiting_user"
              : mode === "completed"
                ? "released"
                : mode === "blocked"
                  ? "blocked"
                  : "running",
          isReleased: mode === "completed",
        }),
      ),
    },
  };
}

describe("Hub Graph navigation", () => {
  it("keeps parallel nodes distinct without overlap in a narrow track", async () => {
    const base = snapshot("running");
    const reviewer = base.definition.nodes.find((node) => node.role === "reviewer")!;
    const parallel = {
      ...base,
      definition: {
        ...base.definition,
        nodes: [...base.definition.nodes, Object.assign({}, reviewer, { key: "parallel-review" })],
      },
    };
    const screen = await render(
      <div style={{ width: 600 }}>
        <HubPipelineStrip snapshot={parallel} connected />
      </div>,
    );
    try {
      await vi.waitFor(() => {
        const track = document.querySelector<HTMLElement>("[data-hub-graph-track]")!;
        const buttons = [...track.querySelectorAll<HTMLButtonElement>("button")];
        expect(buttons).toHaveLength(4);
        for (let i = 1; i < buttons.length; i++)
          expect(buttons[i]!.getBoundingClientRect().left).toBeGreaterThanOrEqual(
            buttons[i - 1]!.getBoundingClientRect().right,
          );
        expect(track.scrollWidth).toBeGreaterThan(track.clientWidth);
      });
      await expect
        .element(page.getByRole("button", { name: "查看详情", exact: true }))
        .toBeVisible();
      await expect
        .element(page.getByLabelText("节点详情", { exact: true }))
        .not.toBeInTheDocument();
    } finally {
      await screen.unmount();
    }
  });
  it("keeps the popup and its collision box aligned to a narrow composer column", async () => {
    const screen = await render(
      <div style={{ width: 320 }}>
        <GraphBoard snapshot={snapshot("blocked")} connected />
      </div>,
    );
    try {
      await page.getByTestId("hub-graph-capsule").click();
      await vi.waitFor(() => {
        const popup = document.querySelector<HTMLElement>('[data-testid="hub-graph-panel"]');
        expect(popup).not.toBeNull();
        const popupBounds = popup!.getBoundingClientRect();
        const positionerBounds = popup!.parentElement!.getBoundingClientRect();
        expect(popupBounds.width).toBeCloseTo(320, 0);
        expect(positionerBounds.width).toBeCloseTo(popupBounds.width, 0);
        const track = popup!.querySelector<HTMLElement>('[aria-label$="协作进度链"]')!;
        expect(track.scrollWidth).toBeGreaterThan(track.clientWidth);
        expect(getComputedStyle(track).overflowX).toBe("auto");
      });
    } finally {
      await screen.unmount();
    }
  });
  it("keeps a stage-level blocker discoverable without inventing a failed node", async () => {
    const base = snapshot("blocked");
    const blockedStage: HubPlanSnapshot = {
      ...base,
      nodeStates: [],
      graph: {
        ...base.graph,
        stages: base.graph.stages.map((stage) =>
          Object.assign({}, stage, {
            blockingReasons: ["The current stage generation is unavailable or invalid."],
          }),
        ),
      },
    };
    const screen = await render(<HubPipelineStrip snapshot={blockedStage} connected />);
    try {
      await expect
        .element(page.getByText("当前阶段尚无有效执行轮次。", { exact: true }))
        .not.toBeInTheDocument();
      await page.getByRole("button", { name: "查看详情", exact: true }).click();
      await expect.element(page.getByRole("heading", { name: "执行轮次不可用" })).toBeVisible();
      await expect.element(page.getByLabelText("原始技术信息")).not.toBeInTheDocument();
      await page.getByRole("button", { name: "技术详情", exact: true }).click();
      await expect
        .element(
          page.getByText("The current stage generation is unavailable or invalid.", {
            exact: true,
          }),
        )
        .toBeVisible();
      await expect.element(page.getByRole("button", { name: /重试/ })).not.toBeInTheDocument();
      await userEvent.keyboard("{Escape}");
      await expect
        .element(page.getByLabelText("节点详情", { exact: true }))
        .not.toBeInTheDocument();
    } finally {
      await screen.unmount();
    }
  });
  it("starts with only an entry and global state, opens and closes with Escape", async () => {
    const screen = await render(<GraphBoard snapshot={snapshot("blocked")} connected />);
    try {
      await expect.element(page.getByTestId("hub-graph-panel")).not.toBeInTheDocument();
      await expect.element(page.getByTestId("hub-graph-capsule")).toHaveTextContent("协作流程");
      await expect.element(page.getByTestId("hub-graph-capsule")).not.toHaveTextContent("已放行");
      await page.getByTestId("hub-graph-capsule").click();
      await expect.element(page.getByTestId("hub-graph-panel")).toBeVisible();
      await expect.element(page.getByTestId("hub-graph-capsule")).not.toHaveTextContent("受阻");
      await expect
        .element(page.getByLabelText("节点详情", { exact: true }))
        .not.toBeInTheDocument();
      await expect
        .element(page.getByRole("button", { name: /产品经理.*未提交成果/ }))
        .toBeVisible();
      await userEvent.keyboard("{Escape}");
      await expect.element(page.getByTestId("hub-graph-panel")).not.toBeInTheDocument();
    } finally {
      await screen.unmount();
    }
  });

  it("shows only the selected node's real report on demand, with no direct retry", async () => {
    const screen = await render(<HubPipelineStrip snapshot={snapshot("blocked")} connected />);
    try {
      await expect
        .element(page.getByText("工作区只读，无法登记成果。", { exact: true }))
        .not.toBeInTheDocument();
      await page.getByRole("button", { name: /产品经理.*未提交成果/ }).click();
      await expect
        .element(page.getByLabelText("节点详情", { exact: true }))
        .not.toBeInTheDocument();
      await expect.element(page.getByText("回合结束，未提交成果", { exact: true })).toBeVisible();
      await page.getByRole("button", { name: "查看详情", exact: true }).click();
      await expect.element(page.getByRole("heading", { name: "成果登记受阻" })).toBeVisible();
      await expect
        .element(page.getByText("系统尚未确认阻塞是否解除。", { exact: true }))
        .toBeVisible();
      await expect
        .element(page.getByText("工作区只读，无法登记成果。", { exact: true }))
        .not.toBeInTheDocument();
      await page.getByRole("button", { name: "技术详情", exact: true }).click();
      await expect
        .element(page.getByText("工作区只读，无法登记成果。", { exact: true }))
        .toBeVisible();
      await expect.element(page.getByText("graph-worker", { exact: true })).toBeVisible();
      await expect.element(page.getByRole("button", { name: /重试/ })).not.toBeInTheDocument();
      await page.getByRole("button", { name: /代码审查员.*未开始/ }).click();
      await expect.element(page.getByText("尚无执行结果", { exact: true })).toBeVisible();
      await expect
        .element(page.getByRole("button", { name: /代码审查员.*未开始/ }))
        .toHaveAttribute("aria-pressed", "true");
      await expect.element(page.getByLabelText("原始技术信息")).not.toBeInTheDocument();
      await expect
        .element(page.getByText("工作区只读，无法登记成果。", { exact: true }))
        .not.toBeInTheDocument();
    } finally {
      await screen.unmount();
    }
  });

  it("keeps plan actions in the existing menu without issuing an execution command", async () => {
    const openActions = vi.fn();
    const navigate = vi.fn();
    const screen = await render(
      <HubPipelineStrip
        snapshot={snapshot("blocked")}
        connected
        onOpenThread={navigate}
        onOpenPlanActions={openActions}
      />,
    );
    try {
      await page.getByRole("button", { name: /产品经理.*未提交成果/ }).click();
      await expect
        .element(page.getByRole("button", { name: "查看线程", exact: true }))
        .toBeVisible();
      await expect
        .element(page.getByRole("menuitem", { name: "计划操作", exact: true }))
        .not.toBeInTheDocument();
      await page.getByRole("button", { name: "更多操作", exact: true }).click();
      await page.getByRole("menuitem", { name: "计划操作", exact: true }).click();
      expect(openActions).toHaveBeenCalledTimes(1);
      expect(navigate).not.toHaveBeenCalled();
      await expect.element(page.getByRole("button", { name: /重试/ })).not.toBeInTheDocument();
    } finally {
      await screen.unmount();
    }
  });

  it("navigates through the existing thread callback and dismisses the popup", async () => {
    const navigate = vi.fn();
    const screen = await render(
      <GraphBoard snapshot={snapshot("running")} connected onOpenThread={navigate} />,
    );
    try {
      await page.getByTestId("hub-graph-capsule").click();
      await page.getByRole("button", { name: /产品经理.*运行中/ }).click();
      await page.getByRole("button", { name: "查看线程", exact: true }).click();
      expect(navigate).toHaveBeenCalledWith("graph-worker");
      await expect.element(page.getByTestId("hub-graph-panel")).not.toBeInTheDocument();
    } finally {
      await screen.unmount();
    }
  });

  it("takes a confirmation gate to existing plan operations instead of executing a new command", async () => {
    const openActions = vi.fn();
    const screen = await render(
      <HubPipelineStrip snapshot={snapshot("release")} connected onOpenPlanActions={openActions} />,
    );
    try {
      await page.getByRole("button", { name: /用户.*待人工确认/ }).click();
      await page.getByRole("button", { name: "更多操作", exact: true }).click();
      await page.getByRole("menuitem", { name: "前往确认", exact: true }).click();
      expect(openActions).toHaveBeenCalledTimes(1);
      await expect.element(page.getByRole("button", { name: /重试/ })).not.toBeInTheDocument();
    } finally {
      await screen.unmount();
    }
  });

  it("does not offer retry for completed nodes and retains connection safeguards", async () => {
    const screen = await render(
      <HubPipelineStrip snapshot={snapshot("completed")} connected={false} />,
    );
    try {
      await expect.element(page.getByRole("status")).toHaveTextContent("连接已断开");
      await page.getByRole("button", { name: /产品经理.*已完成/ }).click();
      await expect.element(page.getByRole("button", { name: /重试/ })).not.toBeInTheDocument();
      await expect
        .element(page.getByRole("button", { name: "前往确认", exact: true }))
        .not.toBeInTheDocument();
    } finally {
      await screen.unmount();
    }
  });
});
