import "../../index.css";

import { ProjectId, ThreadId } from "@synara/contracts";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { ExpertTaskHistory } from "./ExpertTaskHistory";
import { initialState } from "~/storeState";
import { makeProject, makeState, makeThread } from "~/storeTestFixtures";
import { useStore } from "~/store";
import { emitWsTransportState } from "~/wsTransportEvents";

const expertId = "history-expert";

function seedHistoryState(count: number): ThreadId[] {
  const projectId = ProjectId.makeUnsafe("history-project");
  const threads = Array.from({ length: count }, (_, index) =>
    makeThread({
      id: ThreadId.makeUnsafe(`history-${index}`),
      projectId,
      title: `Task ${index}`,
      expertBinding: {
        expertId,
        displayName: "Historical Expert",
        revision: 2,
        snapshotId: "snapshot-history",
      },
      updatedAt: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
    }),
  );
  const threadIds = threads.map((thread) => thread.id);
  const threadShellById = Object.fromEntries(
    threads.map((thread) => {
      const state = makeState(thread);
      const shell = state.threadShellById?.[thread.id];
      if (!shell) throw new Error(`missing shell for ${thread.id}`);
      return [thread.id, shell];
    }),
  );

  useStore.setState({
    ...initialState,
    projects: [makeProject({ id: projectId, name: "History Project" })],
    threadsHydrated: true,
    threadIds,
    threadShellById,
    shellSubscriptionGeneration: 1,
    shellSnapshotReceivedGeneration: 1,
  });
  emitWsTransportState("open");
  return threadIds;
}

beforeEach(() => {
  useStore.setState({ ...initialState });
});

afterEach(() => {
  useStore.setState({ ...initialState });
  emitWsTransportState("closed");
});

it("shows 50 rows first, then loads more and opens the original task", async () => {
  const threadIds = seedHistoryState(51);
  const onOpenThread = vi.fn();
  const screen = await render(
    <ExpertTaskHistory expertId={expertId} onOpenThread={onOpenThread} />,
  );

  await expect.element(screen.getByRole("button", { name: "打开任务：Task 50" })).toBeVisible();
  await expect
    .element(screen.getByRole("button", { name: "打开任务：Task 0" }))
    .not.toBeInTheDocument();
  await screen.getByRole("button", { name: "加载更多任务" }).click();
  await expect.element(screen.getByRole("button", { name: "打开任务：Task 0" })).toBeVisible();
  await screen.getByRole("button", { name: "打开任务：Task 50" }).click();
  expect(onOpenThread).toHaveBeenCalledWith(threadIds[50]);
  await screen.unmount();
});
