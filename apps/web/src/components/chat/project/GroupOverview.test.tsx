// FILE: GroupOverview.test.tsx
// Purpose: Static-markup coverage for the Group panel's Threads section — row
//          titles must size off the same `text-ui` token sidebar thread rows
//          use, not the panel's ambient font size.
// Layer: Chat UI component test
// Depends on: GroupThreadsSection with a stubbed project agent.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type HubWorkItem, ProjectId, ThreadId } from "@synara/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { SidebarThreadSummary } from "../../../types";
import { HubWorkItemCard } from "../group/HubWorkItemCard";

import { GroupThreadsSection } from "./GroupOverview";
import { buildGroupThreadRows, partitionGroupThreadRows } from "./groupOverview.logic";
import type { useProjectAgent } from "./useProjectAgent";

type ProjectAgent = ReturnType<typeof useProjectAgent>;

const GROUP_ID = ProjectId.makeUnsafe("group-1");

function makeThread(overrides: Partial<SidebarThreadSummary> = {}): SidebarThreadSummary {
  return {
    id: ThreadId.makeUnsafe("thread-1"),
    projectId: GROUP_ID,
    title: "Mars recruitment web",
    modelSelection: { provider: "codex", model: "gpt-5.4" },
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    session: null,
    createdAt: "2026-03-09T10:00:00.000Z",
    updatedAt: "2026-03-09T10:00:00.000Z",
    latestTurn: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    hasLiveTailWork: false,
    pendingBackgroundWorkCount: 0,
    ...overrides,
  };
}

const agent = { tasks: [], threads: [] } as unknown as ProjectAgent;

function renderThreadsSection(
  threads: readonly SidebarThreadSummary[],
  workItems: readonly HubWorkItem[] = [],
): string {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const rows = buildGroupThreadRows({
    threads,
    workItems,
    taskByThreadId: new Map(),
    indexArchivedThreadIds: new Set(),
    pullRequests: new Map(),
    projectNameById: new Map(),
    groupProjectId: GROUP_ID,
    groupProjectName: "Hub",
  });
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <GroupThreadsSection
        sections={partitionGroupThreadRows(rows)}
        agent={agent}
        onOpenThread={() => undefined}
        onOpenThreadSplit={() => undefined}
      />
    </QueryClientProvider>,
  );
}

describe("GroupThreadsSection", () => {
  it("sizes thread row titles with the same text-ui token sidebar rows use", () => {
    const markup = renderThreadsSection([makeThread()]);

    // SidebarThreadRowContent titles carry `text-ui`; panel rows must match so
    // titles track the Settings font size instead of the ambient default.
    expect(markup).toContain('class="min-w-0 truncate text-ui font-normal text-foreground"');
    expect(markup).toContain("Mars recruitment web");
  });

  it("shows the accepted Expert identity before and after the worker thread exists", () => {
    const binding = {
      expertId: "expert-original",
      snapshotId: "snapshot-original",
      displayName: "Original product expert",
      revision: 2,
    };
    const item: HubWorkItem = {
      id: "work-1",
      sourceThreadId: ThreadId.makeUnsafe("coordinator"),
      sourceMessageId: null,
      title: "Review requirements",
      workerThreadId: null,
      state: "queued",
      queueReason: "Worker limit reached",
      resultSummary: null,
      progress: null,
      expertBinding: binding,
      revision: 0,
      createdAt: "2026-10-19T08:00:00.000Z",
      updatedAt: "2026-10-19T08:00:00.000Z",
    };
    const queued = renderToStaticMarkup(<HubWorkItemCard item={item} />);
    const worker = renderThreadsSection(
      [makeThread()],
      [{ ...item, workerThreadId: ThreadId.makeUnsafe("thread-1"), state: "working" }],
    );
    expect(queued).toContain("Original product expert");
    expect(queued).toContain("Worker limit reached");
    expect(queued).toContain("v2");
    expect(worker).toContain("Original product expert");
    expect(worker).toContain("Mars recruitment web");
    expect(renderThreadsSection([makeThread()])).not.toContain("Original product expert");
  });
});
