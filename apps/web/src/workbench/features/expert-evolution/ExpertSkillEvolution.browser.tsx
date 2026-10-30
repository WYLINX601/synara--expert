import "../../../index.css";

import type {
  ExpertDefinition,
  ExpertLearningState,
  ProviderKind,
  ThreadId,
  ModelSelection,
  SkillDefinition,
  SkillEvolutionGraph,
  SkillEvolutionProposal,
  SkillEvolutionRequest,
  SkillEvolutionResponse,
  SkillEvolutionRun,
  SkillEvolutionSource,
  SkillLibraryRequest,
  SkillLibraryResponse,
  SkillPackage,
} from "@synara/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Link,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { useState } from "react";

const harness = vi.hoisted(() => ({
  calls: [] as SkillEvolutionRequest[],
  learningState: undefined as ExpertLearningState | undefined,
  learningSetGate: null as Promise<void> | null,
  learningSetFailure: false,
  learningReadFailure: false,
  configuredProvider: "pi" as ProviderKind,
  runs: [] as SkillEvolutionRun[],
  startStatus: "no_change" as SkillEvolutionRun["status"],
  startUnknownOutcomeOnce: "none" as "none" | "before-persist" | "after-persist",
  startGate: null as Promise<void> | null,
  applyConflict: false,
  applySavedUnboundOnce: false,
  generateUnknownOutcomeOnce: false,
  generateBeforePersistFailure: false,
  openedTasks: [] as string[],
  openedAbilities: 0,
  server: {
    skillEvolution: vi.fn<(request: SkillEvolutionRequest) => Promise<SkillEvolutionResponse>>(),
    skillLibrary: vi.fn<(request: SkillLibraryRequest) => Promise<SkillLibraryResponse>>(),
    readSkillPackage:
      vi.fn<(input: { packageId: SkillPackage["packageId"] }) => Promise<SkillPackage>>(),
    listExperts: vi.fn<() => Promise<ExpertDefinition[]>>(),
    getConfig: vi.fn<() => Promise<{ cwd: null }>>(),
  },
  draft: {
    selectedProvider: "pi" as const,
    selectedModel: "user-selected-pi-model",
    selectedProviderInstanceId: "pi",
    selectedProviderModelOptions: undefined,
    selectedModelSupportsAutoMode: undefined,
    handleProviderModelChange: vi.fn(),
  },
}));

vi.mock("~/nativeApi", () => ({ ensureNativeApi: () => ({ server: harness.server }) }));
vi.mock("~/appSettings", () => ({
  useAppSettings: () => ({ settings: { defaultProvider: "pi" } }),
}));
vi.mock("~/hooks/useProviderStatusesForLocalConfig", () => ({
  useProviderStatusesForLocalConfig: () => [],
}));
vi.mock("~/hooks/useNativeApiServerCapability", () => ({
  useNativeApiServerCapabilitySnapshot: () => ({ connected: true, generation: "evolution-test" }),
}));
vi.mock("~/hooks/useScratchComposerDraft", () => ({
  useScratchComposerDraft: () => harness.draft,
}));
vi.mock("~/hooks/useScratchModelCatalog", () => ({ useScratchModelCatalog: () => ({}) }));
vi.mock("~/components/chat/ScratchAgentControls", () => ({ ScratchModelPickers: () => null }));
vi.mock("~/components/settings/SkillLibraryDetail", () => ({ SkillLibraryDetail: () => null }));
vi.mock("~/lib/serverReactQuery", () => ({
  serverConfigQueryOptions: () => ({
    queryKey: ["test", "config"],
    queryFn: harness.server.getConfig,
  }),
}));
vi.mock("~/lib/providerDiscovery", () => ({ resolveProviderDiscoveryCwd: () => null }));

import { ExpertLearningControl, expertLearningQueryKey } from "./ExpertLearningControl";
import { ExpertSkillEvolution } from "./ExpertSkillEvolution";
import { ExpertEditor, type ExpertEditorTab } from "~/components/settings/ExpertEditor";
import { evolutionTimelineEntries, skillEvolutionQueryKey } from "./model";

const skillId = `skl_${"a".repeat(32)}` as SkillDefinition["skillId"];
const packageId = `pkg_${"a".repeat(64)}` as SkillDefinition["packageId"];
const expert: ExpertDefinition = {
  id: "review-expert",
  name: "Review Expert",
  description: "",
  useCases: "",
  persona: "Review plans and outcomes.",
  outputRequirements: "",
  skills: [],
  skillBindings: [{ skillId, enabled: true }],
  references: [],
  connections: [],
  revision: 3,
  archived: false,
  updatedAt: "2026-10-27T00:00:00.000Z",
};
const skill: SkillDefinition = {
  skillId,
  name: "Review findings",
  description: "Reusable review method",
  tags: ["review"],
  packageId,
  entryPath: "SKILL.md",
  source: { kind: "manual", location: "", entryPath: "SKILL.md", packageId },
  locallyModified: false,
  revision: 2,
  deleted: false,
  updatedAt: "2026-10-27T00:00:00.000Z",
  scope: { kind: "shared" },
};
const graph: SkillEvolutionGraph = {
  nodes: [
    {
      skillId,
      name: skill.name,
      revision: 2,
      packageId,
      timestamp: null,
      baseline: true,
    },
  ],
  events: [],
};
const derivedSkillId = `skl_${"c".repeat(32)}` as SkillDefinition["skillId"];
const derivedPackageId = `pkg_${"c".repeat(64)}` as SkillDefinition["packageId"];
const otherSkillId = `skl_${"d".repeat(32)}` as SkillDefinition["skillId"];
const derivedSkill: SkillDefinition = {
  ...skill,
  skillId: derivedSkillId,
  name: "Expert-only review copy",
  packageId: derivedPackageId,
  source: { ...skill.source, packageId: derivedPackageId },
  revision: 1,
  scope: { kind: "expert", expertId: expert.id },
  derivedFrom: { skillId, revision: 2, packageId },
};
const derivedEvent: SkillEvolutionGraph["events"][number] = {
  eventId: "derived-event-1",
  operationId: "derived-operation-1",
  requestId: "derived-request-1",
  expertId: expert.id,
  skillId: derivedSkillId,
  name: derivedSkill.name,
  kind: "derived",
  createdAt: "2026-10-28T00:00:00.000Z",
  revision: 1,
  packageId: derivedPackageId,
  previousRevision: 2,
  previousPackageId: packageId,
  derivedFromSkillId: skillId,
  scope: { kind: "expert", expertId: expert.id },
  affectedExpertIds: [expert.id],
};
const graphWithDerived: SkillEvolutionGraph = {
  nodes: [
    ...graph.nodes,
    {
      skillId: derivedSkillId,
      name: derivedSkill.name,
      revision: 1,
      packageId: derivedPackageId,
      ownerExpertId: expert.id,
      timestamp: derivedEvent.createdAt,
      baseline: false,
      derivedFromSkillId: skillId,
    },
  ],
  events: [derivedEvent],
};
const bindingRestorePreview: NonNullable<SkillEvolutionResponse["bindingRestorePreview"]> = {
  eventId: derivedEvent.eventId,
  expertId: expert.id,
  expertRevision: 4,
  fromSkill: derivedSkill,
  toSkill: skill,
  before: [
    { skillId: derivedSkillId, enabled: true, allowEvolution: true },
    { skillId: otherSkillId, enabled: false, allowEvolution: false },
  ],
  after: [
    { skillId, enabled: true, allowEvolution: true },
    { skillId: otherSkillId, enabled: false, allowEvolution: false },
  ],
  digest: "a".repeat(64),
};
const bindingRestoredEvent: SkillEvolutionGraph["events"][number] = {
  ...derivedEvent,
  eventId: "binding-restored-event-1",
  operationId: "binding-restore-operation-1",
  skillId,
  name: skill.name,
  kind: "binding_restored",
  revision: skill.revision,
  packageId: skill.packageId,
  previousSkillId: derivedSkillId,
  derivedFromSkillId: undefined,
  scope: skill.scope,
};
const graphAfterBindingRestore: SkillEvolutionGraph = {
  ...graphWithDerived,
  events: [derivedEvent, bindingRestoredEvent],
};
const restorePreview: NonNullable<SkillEvolutionResponse["restorePreview"]> = {
  eventId: derivedEvent.eventId,
  skill: derivedSkill,
  changes: [
    { path: "SKILL.md", content: btoa("Restored target body.\n") },
    { path: "remove.md" },
    { path: "image.bin", content: "/w==" },
  ],
  affectedExpertIds: [expert.id, "other-expert"],
};
const restoreBasePackage: SkillPackage = {
  schemaVersion: 1,
  packageId: derivedPackageId,
  rootName: "expert-review-copy",
  resources: ["SKILL.md", "remove.md", "image.bin"].map((path) => ({
    path: `content/${path}`,
    kind: "file" as const,
    size: 1,
    sha256: "b".repeat(64),
  })),
  entries: [],
  fileCount: 3,
  totalBytes: 3,
};
let graphForTest = graph;
const sources: SkillEvolutionSource[] = [
  {
    threadId: "thread-alpha",
    turnId: "turn-alpha-1",
    projectId: "project-1",
    title: "完成的复核任务",
    expertId: expert.id,
    expertRevision: 3,
    snapshotId: "snapshot-alpha-1",
    completedAt: "2026-10-25T00:00:00.000Z",
    messageCount: 12,
  },
  {
    threadId: "thread-alpha",
    turnId: "turn-alpha-2",
    projectId: "project-1",
    title: "完成的复核任务",
    expertId: expert.id,
    expertRevision: 3,
    snapshotId: "snapshot-alpha-2",
    completedAt: "2026-10-26T00:00:00.000Z",
    messageCount: 8,
  },
] as unknown as SkillEvolutionSource[];
const historySources = [
  ...sources,
  {
    threadId: "thread-beta",
    turnId: "turn-beta-1",
    projectId: "project-1",
    title: "Beta 工作片段",
    expertId: expert.id,
    expertRevision: 3,
    snapshotId: "snapshot-beta-1",
    completedAt: "2026-10-27T00:00:00.000Z",
    messageCount: 6,
  },
  {
    threadId: "thread-gamma",
    turnId: "turn-gamma-1",
    projectId: "project-1",
    title: "Gamma 工作片段",
    expertId: expert.id,
    expertRevision: 3,
    snapshotId: "snapshot-gamma-1",
    completedAt: "2026-10-28T00:00:00.000Z",
    messageCount: 7,
  },
  {
    threadId: "thread-gamma",
    turnId: "turn-gamma-2",
    projectId: "project-1",
    title: "Gamma 工作片段",
    expertId: expert.id,
    expertRevision: 3,
    snapshotId: "snapshot-gamma-2",
    completedAt: "2026-10-29T00:00:00.000Z",
    messageCount: 9,
  },
] as unknown as SkillEvolutionSource[];
let sourceRows = sources;

function proposal(input: Partial<SkillEvolutionProposal> = {}): SkillEvolutionProposal {
  const action = input.action ?? "update";
  return {
    proposalId: `proposal-${action}`,
    requestId: `request-${action}`,
    expertId: expert.id,
    action,
    name: `${action} review method`,
    summary: "Add a reusable verification step.",
    evidence: [
      { threadId: "thread-alpha", messageId: "message-1", quote: "验证修复后再复核。" },
    ] as unknown as SkillEvolutionProposal["evidence"],
    baseSkillId: skillId,
    baseRevision: 2,
    basePackageId: packageId,
    changes: [
      { path: "SKILL.md", content: btoa("---\nname: Review findings\n---\nCheck the outcome.\n") },
    ],
    digest: "f".repeat(64),
    status: "proposed",
    ...input,
  };
}

function run(input: Partial<SkillEvolutionRun> = {}): SkillEvolutionRun {
  const proposals = input.proposals ?? [proposal()];
  return {
    requestId: input.requestId ?? proposals[0]?.requestId ?? "request-update",
    expertId: expert.id,
    createdAt: "2026-10-27T00:00:00.000Z",
    updatedAt: "2026-10-27T00:00:00.000Z",
    modelSelection: {
      provider: "pi",
      model: "user-selected-pi-model",
      instanceId: "pi",
    } as ModelSelection,
    sourceCount: 1,
    status: "proposal_ready",
    proposals,
    ...input,
  };
}

function opportunity(
  input: Partial<NonNullable<SkillEvolutionRun["opportunities"]>[number]> = {},
): NonNullable<SkillEvolutionRun["opportunities"]>[number] {
  return {
    opportunityId: "opportunity-1",
    requestId: "request-discovery",
    expertId: expert.id,
    name: "修复后复核",
    reason: "多次任务都先定位原因，再重跑检查并核对实际输出。",
    outcomes: ["记录复现步骤", "修复后重跑", "复核真实结果"],
    evidence: [
      { threadId: "thread-alpha", messageId: "message-1", quote: "修复后再跑一次并看实际输出。" },
    ] as unknown as NonNullable<SkillEvolutionRun["opportunities"]>[number]["evidence"],
    digest: "d".repeat(64),
    status: "suggested",
    ...input,
  };
}

function discoveryRun(
  opportunities: SkillEvolutionRun["opportunities"] = [opportunity()],
  requestId = "request-discovery",
): SkillEvolutionRun {
  return run({
    requestId,
    stage: "discovery",
    status: "opportunity_ready",
    sourceSelections: [
      { threadId: "thread-alpha", turnId: "turn-alpha-2" },
    ] as unknown as SkillEvolutionRun["sourceSelections"],
    proposals: [],
    opportunities,
  });
}

function timelineRow(requestId: string) {
  const child = harness.runs.find((run) => run.requestId === requestId);
  const entry = evolutionTimelineEntries(harness.runs).find(
    (entry) =>
      entry.run.requestId === requestId ||
      (entry.run.requestId === child?.discoveryRequestId &&
        entry.opportunity?.opportunityId === child?.opportunityId),
  );
  if (!entry) throw new Error(`Missing timeline entry for ${requestId}`);
  return page.getByTestId(`experience-node:${entry.id}`);
}

async function openRun(requestId: string) {
  const row = timelineRow(requestId);
  if (row.element().hasAttribute("hidden"))
    await page.getByRole("button", { name: /查看全部提炼记录/ }).click();
  if (
    evolutionTimelineEntries(harness.runs).some(
      (entry) =>
        entry.failed &&
        (entry.run.requestId === requestId ||
          entry.run.requestId ===
            harness.runs.find((run) => run.requestId === requestId)?.discoveryRequestId),
    )
  )
    return;
  const toggle = row.getByRole("button").first();
  if (toggle.element().getAttribute("aria-expanded") !== "true") await toggle.click();
  const child = harness.runs.find((run) => run.requestId === requestId);
  if (
    child?.stage === "generation" &&
    harness.runs.filter(
      (run) =>
        run.discoveryRequestId === child.discoveryRequestId &&
        run.opportunityId === child.opportunityId,
    ).length > 1
  ) {
    const history = row.getByRole("button", { name: /^历史预览/ });
    if (history.element().getAttribute("aria-expanded") !== "true") await history.click();
    await row
      .getByRole("button", { name: new RegExp(`第 ${child.generationIndex} 次预览`) })
      .click();
  }
}

let dispose: (() => Promise<void>) | undefined;

function EvolutionEditorFixture() {
  const [tab, setTab] = useState<ExpertEditorTab>("evolution");
  return (
    <ExpertEditor
      header={<h1>{expert.name}</h1>}
      history={<p>专家任务历史</p>}
      learning={
        <ExpertLearningControl
          expertId={expert.id}
          provider={harness.configuredProvider}
          active={tab === "settings"}
        />
      }
      evolution={
        <ExpertSkillEvolution
          expertId={expert.id}
          expertName={expert.name}
          active={tab === "evolution"}
        />
      }
      draft={expert}
      issues={[]}
      tab={tab}
      readonly={false}
      connections={[]}
      connectionsLoading={false}
      connectionsError={null}
      onTabChange={setTab}
      onChange={() => {}}
      onOpenConnections={() => {}}
    />
  );
}

function HistorySelectionFixture() {
  const [threadId, setThreadId] = useState("thread-alpha");
  const [requestKey, setRequestKey] = useState(1);
  const selectGamma = () => {
    setThreadId("thread-gamma");
    setRequestKey((current) => current + 1);
  };
  return (
    <>
      <div className="flex gap-2">
        <button type="button" onClick={selectGamma}>
          选择历史任务 C
        </button>
        <button type="button" onClick={selectGamma}>
          重新选择历史任务 C
        </button>
      </div>
      <ExpertSkillEvolution
        expertId={expert.id}
        expertName={expert.name}
        active
        initialThreadId={threadId}
        initialThreadRequestKey={requestKey}
      />
    </>
  );
}

async function mount(
  initialThreadId: string | null = null,
  editor = false,
  historySelector = false,
  openManual = true,
) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const root = createRootRoute({
    component: () => (
      <QueryClientProvider client={client}>
        <Outlet />
      </QueryClientProvider>
    ),
  });
  const evolutionRoute = createRoute({
    getParentRoute: () => root,
    path: "/evolution",
    component: () => (
      <>
        <Link to={"/away" as never}>离开进化页</Link>
        <div
          className="relative flex h-[40rem] min-h-0 min-w-0 flex-1 overflow-hidden"
          data-testid="_chat-flex-parent"
        >
          <main className="h-full min-h-0 min-w-0 flex-1 overflow-y-auto p-4">
            <div className="mx-auto max-w-5xl min-w-0">
              {editor ? (
                <EvolutionEditorFixture />
              ) : historySelector ? (
                <HistorySelectionFixture />
              ) : (
                <ExpertSkillEvolution
                  expertId={expert.id}
                  expertName={expert.name}
                  preferredProvider={harness.configuredProvider}
                  active
                  initialThreadId={initialThreadId}
                  initialThreadRequestKey={initialThreadId ? 1 : 0}
                  onOpenTask={(threadId) => harness.openedTasks.push(threadId)}
                  onOpenAbilities={() => {
                    harness.openedAbilities += 1;
                  }}
                />
              )}
            </div>
          </main>
        </div>
      </>
    ),
  });
  const awayRoute = createRoute({
    getParentRoute: () => root,
    path: "/away",
    component: () => <p>离开后的页面</p>,
  });
  const router = createRouter({
    routeTree: root.addChildren([evolutionRoute, awayRoute]),
    history: createMemoryHistory({ initialEntries: ["/evolution"] }),
  });
  const view = await render(<RouterProvider router={router} />);
  if (openManual) {
    const toggle = page.getByRole("button", { name: "手动提炼经验", exact: true });
    if (toggle.element().getAttribute("aria-expanded") !== "true") await toggle.click();
  }
  dispose = async () => {
    await view.unmount();
    client.clear();
  };
  return client;
}

beforeEach(() => {
  harness.calls = [];
  harness.learningState = undefined;
  harness.learningSetGate = null;
  harness.learningSetFailure = false;
  harness.learningReadFailure = false;
  harness.configuredProvider = "pi";
  harness.runs = [];
  graphForTest = graph;
  harness.startStatus = "no_change";
  harness.startUnknownOutcomeOnce = "none";
  harness.startGate = null;
  harness.applyConflict = false;
  harness.applySavedUnboundOnce = false;
  harness.generateUnknownOutcomeOnce = false;
  harness.generateBeforePersistFailure = false;
  harness.openedTasks = [];
  harness.openedAbilities = 0;
  sourceRows = sources;
  harness.server.skillEvolution.mockReset().mockImplementation(async (request) => {
    harness.calls.push(request);
    switch (request.action) {
      case "learningRead":
        if (harness.learningReadFailure) throw new Error("offline");
        return harness.learningState ? { learningState: harness.learningState } : {};
      case "learningSet":
        if (harness.learningSetGate) await harness.learningSetGate;
        if (harness.learningSetFailure) throw new Error("receipt unavailable");
        harness.learningState = {
          expertId: request.expertId,
          enabled: request.enabled,
          revision: request.expectedRevision + 1,
          epoch: (harness.learningState?.epoch ?? 0) + 1,
          harnessKind: request.harnessKind ?? harness.learningState?.harnessKind ?? "pi",
          updatedAt: new Date().toISOString(),
          status: request.enabled ? "idle" : "disabled",
        };
        return { learningState: harness.learningState };
      case "sources":
        return { sources: sourceRows };
      case "capabilities":
        return {
          capabilities: [{ provider: "pi", supported: true, reason: "Pi 当前满足只读提炼约束。" }],
        };
      case "list":
        return { runs: harness.runs };
      case "graph":
        return { graph: graphForTest };
      case "previewBindingRestore":
        return { bindingRestorePreview };
      case "previewRestore":
        return { restorePreview };
      case "restoreBinding":
        graphForTest = graphAfterBindingRestore;
        return { run: run({ requestId: derivedEvent.requestId, proposals: [] }), skill };
      case "start": {
        if (harness.startUnknownOutcomeOnce === "before-persist") {
          harness.startUnknownOutcomeOnce = "none";
          throw new Error("连接中断，结果未知。");
        }
        const existing = harness.runs.find((item) => item.requestId === request.requestId);
        if (existing) return { run: existing };
        if (harness.startGate) {
          await harness.startGate;
          harness.startGate = null;
        }
        const next = run({
          requestId: request.requestId,
          stage: "discovery",
          sourceCount: request.sources.length,
          sourceSelections: request.sources,
          status: harness.startStatus,
          summary:
            harness.startStatus === "no_change"
              ? "没有新增的可复用方法。"
              : "所选来源无法支持结论。",
          ...(harness.startStatus === "failed" ? { error: "原生提炼任务执行失败。" } : {}),
          proposals: [],
        });
        harness.runs = [next, ...harness.runs];
        if (harness.startUnknownOutcomeOnce === "after-persist") {
          harness.startUnknownOutcomeOnce = "none";
          throw new Error("连接中断，结果未知。");
        }
        return { run: next };
      }
      case "generate": {
        if (harness.generateBeforePersistFailure) throw new Error("模型服务连接失败。");
        let child = harness.runs.find((item) => item.requestId === request.requestId);
        if (!child) {
          const generationIndex =
            Math.max(
              0,
              ...harness.runs
                .filter(
                  (item) =>
                    item.discoveryRequestId === request.discoveryRequestId &&
                    item.opportunityId === request.opportunityId,
                )
                .map((item) => item.generationIndex ?? 0),
            ) + 1;
          const nextProposal = proposal({
            requestId: request.requestId,
            proposalId: `proposal-generation-${generationIndex}`,
          });
          child = run({
            requestId: request.requestId,
            stage: "generation",
            discoveryRequestId: request.discoveryRequestId,
            opportunityId: request.opportunityId,
            generationIndex,
            ...(request.feedback ? { feedback: request.feedback } : {}),
            status: "proposal_ready",
            proposals: [nextProposal],
          });
          harness.runs = [child, ...harness.runs];
        }
        if (harness.generateUnknownOutcomeOnce) {
          harness.generateUnknownOutcomeOnce = false;
          throw new Error("连接中断，结果未知。");
        }
        return { run: child };
      }
      case "dismissOpportunity": {
        const parent = harness.runs.find((item) => item.requestId === request.requestId)!;
        const next = {
          ...parent,
          opportunities: parent.opportunities?.map((item) =>
            item.opportunityId === request.opportunityId
              ? { ...item, status: "dismissed" as const }
              : item,
          ),
        };
        harness.runs = harness.runs.map((item) =>
          item.requestId === parent.requestId ? next : item,
        );
        return { run: next };
      }
      case "read":
        return {
          run:
            harness.runs.find((item) => item.requestId === request.requestId) ??
            run({ requestId: request.requestId }),
        };
      case "cancel": {
        const next = {
          ...harness.runs.find((item) => item.requestId === request.requestId)!,
          status: "cancel_requested" as const,
        };
        harness.runs = harness.runs.map((item) =>
          item.requestId === request.requestId ? next : item,
        );
        return { run: next };
      }
      case "reject":
      case "edit":
      case "apply": {
        const current = harness.runs.find((item) => item.requestId === request.requestId)!;
        const nextProposals = current.proposals.map((item) => {
          if (item.proposalId !== request.proposalId) return item;
          if (request.action === "edit")
            return {
              ...item,
              name: request.name,
              changes: request.changes,
              digest: "e".repeat(64),
            };
          if (request.action === "reject") return { ...item, status: "rejected" as const };
          return harness.applyConflict
            ? { ...item, status: "conflict" as const, error: "目标版本已变化。" }
            : { ...item, status: "applied" as const, resultSkillId: skillId, resultRevision: 3 };
        });
        const savedUnbound = request.action === "apply" && harness.applySavedUnboundOnce;
        if (savedUnbound) harness.applySavedUnboundOnce = false;
        const next = {
          ...current,
          proposals: savedUnbound
            ? nextProposals.map((item) =>
                item.proposalId === request.proposalId
                  ? {
                      ...item,
                      status: "saved_unbound" as const,
                      resultSkillId: skillId,
                      resultRevision: 3,
                    }
                  : item,
              )
            : nextProposals,
        };
        harness.runs = harness.runs.map((item) =>
          item.requestId === current.requestId ? next : item,
        );
        if (request.action === "apply" && !harness.applyConflict && !savedUnbound) {
          const adopted = current.proposals.find((item) => item.proposalId === request.proposalId);
          const node = {
            skillId,
            name: adopted?.name ?? skill.name,
            revision: 3,
            packageId,
            ownerExpertId: expert.id,
            timestamp: "2026-10-30T00:00:00.000Z",
            baseline: false,
          };
          graphForTest = {
            nodes: graphForTest.nodes.some((item) => item.skillId === skillId)
              ? graphForTest.nodes.map((item) => (item.skillId === skillId ? node : item))
              : [...graphForTest.nodes, node],
            events: [
              ...graphForTest.events,
              {
                ...derivedEvent,
                eventId: `adopted-${request.requestId}`,
                operationId: request.operationId,
                requestId: request.requestId,
                skillId,
                name: adopted?.name ?? skill.name,
                kind:
                  adopted?.action === "create"
                    ? "created"
                    : adopted?.action === "update"
                      ? "updated"
                      : "derived",
                createdAt: "2026-10-30T00:00:00.000Z",
                revision: 3,
                packageId,
                scope: { kind: "expert", expertId: expert.id },
              },
            ],
          };
        }
        return { run: next };
      }
      default:
        return {};
    }
  });
  harness.server.skillLibrary.mockReset().mockImplementation(async (request) => {
    if (request.action === "list") {
      return {
        skills: [skill, derivedSkill],
        items: [
          {
            skillId,
            usage: {
              expertIds: [expert.id, "other-expert"],
              enabledExpertIds: [expert.id, "other-expert"],
            },
          },
        ],
      };
    }
    if (request.action === "readFile") {
      if (request.path === "image.bin") throw new Error("当前版本文件读取失败");
      const text =
        request.path === "SKILL.md" ? "Current version body.\n" : "Current file before deletion.\n";
      return { file: { path: request.path, content: btoa(text), text } };
    }
    if (request.action === "read")
      return { skill: request.skillId === derivedSkillId ? derivedSkill : skill };
    return {};
  });
  harness.server.readSkillPackage.mockReset().mockResolvedValue(restoreBasePackage);
  harness.server.listExperts
    .mockReset()
    .mockResolvedValue([expert, { ...expert, id: "other-expert", name: "Other Expert" }]);
  harness.server.getConfig.mockReset().mockResolvedValue({ cwd: null });
});

afterEach(async () => {
  await dispose?.();
  dispose = undefined;
});

describe("Expert Skill evolution browser flow", () => {
  it("defaults learning off and manual extraction collapsed, then shares confirmed settings across tabs", async () => {
    await mount(null, true, false, false);
    const manual = page.getByRole("button", { name: "手动提炼经验", exact: true });
    await expect.element(manual).toHaveAttribute("aria-expanded", "false");
    await expect.element(page.getByRole("switch", { name: "自学习" })).not.toBeChecked();
    await page.getByRole("tab", { name: "设置", exact: true }).click();
    const toggle = page.getByRole("switch", { name: "自学习" });
    await expect.element(toggle).toBeEnabled();
    await toggle.click();
    await expect.element(toggle).toBeChecked();
    expect(harness.calls.find((request) => request.action === "learningSet")).toMatchObject({
      expertId: expert.id,
      expectedRevision: 0,
      enabled: true,
      harnessKind: "pi",
    });
    await page.getByRole("tab", { name: "进化", exact: true }).click();
    await expect.element(toggle).toBeChecked();
    await toggle.click();
    await expect.element(toggle).not.toBeChecked();
    await expect.element(page.getByText("已关闭 · 当前技能版本已固定")).toBeVisible();
    await expect.element(toggle).toBeEnabled();
    await toggle.click();
    await expect.element(toggle).toBeChecked();
    expect(
      harness.calls
        .filter((request) => request.action === "learningSet")
        .map((request) =>
          request.action === "learningSet" ? [request.enabled, request.expectedRevision] : [],
        ),
    ).toEqual([
      [true, 0],
      [false, 1],
      [true, 2],
    ]);
    expect(harness.draft.handleProviderModelChange).not.toHaveBeenCalled();
  });

  it("keeps the confirmed enabled state until a disable receipt arrives", async () => {
    harness.learningState = {
      expertId: expert.id,
      enabled: true,
      revision: 4,
      epoch: 2,
      harnessKind: "pi",
      updatedAt: "2026-10-31T00:00:00.000Z",
      status: "idle",
    };
    let release!: () => void;
    harness.learningSetGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await mount(null, false, false, false);
    const toggle = page.getByRole("switch", { name: "自学习" });
    await expect.element(toggle).toBeChecked();
    await toggle.click();
    await expect.element(toggle).toBeDisabled();
    await expect.element(toggle).toBeChecked();
    await expect.element(page.getByText("正在保存自学习设置…")).toBeVisible();
    release();
    await expect.element(toggle).not.toBeChecked();
  });

  it("does not claim disable completion after an unknown receipt and failed reread", async () => {
    harness.learningState = {
      expertId: expert.id,
      enabled: true,
      revision: 4,
      epoch: 2,
      harnessKind: "pi",
      updatedAt: "2026-10-31T00:00:00.000Z",
      status: "idle",
    };
    await mount(null, false, false, false);
    const toggle = page.getByRole("switch", { name: "自学习" });
    await expect.element(toggle).toBeChecked();
    harness.learningSetFailure = true;
    harness.learningReadFailure = true;
    await toggle.click();
    await expect.element(page.getByText("暂时无法确认自学习状态，请稍后重试。")).toBeVisible();
    await expect.element(toggle).toBeChecked();
    await expect.element(toggle).toBeDisabled();
    await expect.element(page.getByText("已关闭 · 当前技能版本已固定")).not.toBeInTheDocument();
  });

  it("keeps unsupported learning isolated from manual extraction and never switches providers", async () => {
    harness.configuredProvider = "codex";
    await mount(null, false, false, false);
    await expect.element(page.getByRole("switch", { name: "自学习" })).toBeDisabled();
    await expect.element(page.getByText(/当前 Provider 暂不支持自学习/)).toBeVisible();
    await page.getByRole("button", { name: "手动提炼经验", exact: true }).click();
    await expect.element(page.getByRole("button", { name: "提炼经验", exact: true })).toBeEnabled();
    expect(harness.calls.some((request) => request.action === "learningSet")).toBe(false);
    expect(harness.draft.handleProviderModelChange).not.toHaveBeenCalled();
  });

  it("shows background failure calmly and reveals technical detail only on demand", async () => {
    harness.learningState = {
      expertId: expert.id,
      enabled: true,
      revision: 4,
      epoch: 2,
      harnessKind: "pi",
      updatedAt: "2026-10-31T00:00:00.000Z",
      status: "failed",
      summary: "Synthetic provider failure at /isolated/test",
    };
    harness.runs = [run({ origin: "automatic", status: "failed", proposals: [] })];
    await mount(null, false, false, false);
    await expect.element(page.getByText("本轮暂未完成，后续任务不受影响。")).toBeVisible();
    expect(
      page
        .getByText(harness.learningState.summary!)
        .element()
        .closest('[aria-hidden="true"][inert]'),
    ).not.toBeNull();
    await expect
      .element(page.getByTestId("experience-node:request-update"))
      .not.toBeInTheDocument();
    await page.getByRole("button", { name: "查看学习详情" }).click();
    await expect.element(page.getByText(harness.learningState.summary!)).toBeVisible();
  });

  it("shows confirmed automatic growth with runtime evidence and existing diff details", async () => {
    const applied = proposal({
      status: "applied",
      resultSkillId: skillId,
      resultRevision: 3,
      evidence: [
        {
          kind: "runtime",
          threadId: "thread-alpha" as ThreadId,
          eventId: "tool-result-1",
          quote: "Verified the actual output.",
        },
      ],
    });
    const parent = { ...discoveryRun(), origin: "automatic" as const };
    harness.runs = [
      parent,
      run({
        origin: "automatic",
        proposals: [applied],
        stage: "generation",
        discoveryRequestId: parent.requestId,
        opportunityId: "opportunity-1",
        generationIndex: 1,
      }),
    ];
    harness.learningState = {
      expertId: expert.id,
      enabled: true,
      revision: 3,
      epoch: 1,
      harnessKind: "pi",
      updatedAt: "2026-10-31T00:00:00.000Z",
      status: "idle",
    };
    await page.viewport(1000, 900);
    await mount(null, true, false, false);
    await expect.element(page.getByText("自动学习", { exact: true })).toBeVisible();
    await expect.element(page.getByText(/条待处理/)).not.toBeInTheDocument();
    await openRun(parent.requestId);
    await page.getByRole("tab", { name: "依据 1", exact: true }).click();
    await expect.element(page.getByText("Verified the actual output.")).toBeVisible();
    await page.getByRole("tab", { name: "本次改动", exact: true }).click();
    await expect.element(page.getByRole("button", { name: "编辑候选" })).not.toBeInTheDocument();
    await page.getByRole("button", { name: /查看完整差异/ }).click();
    await expect.element(page.getByRole("dialog", { name: /完整差异/ })).toBeVisible();
    await page.getByRole("button", { name: "关闭完整差异" }).click();
    await page.getByRole("tab", { name: "设置", exact: true }).click();
    await expect.element(page.getByRole("switch", { name: "自学习" })).toBeChecked();
  });

  it("refreshes automatic state without losing feedback or announcing no-change growth", async () => {
    harness.runs = [
      discoveryRun(),
      run({
        requestId: "automatic-no-change",
        origin: "automatic",
        status: "no_change",
        proposals: [],
      }),
    ];
    const client = await mount();
    await openRun("request-discovery");
    const feedback = page.getByRole("textbox", { name: "生成反馈：修复后复核" });
    await feedback.fill("保留自动刷新期间的反馈");
    harness.learningState = {
      expertId: expert.id,
      enabled: true,
      revision: 3,
      epoch: 1,
      harnessKind: "pi",
      updatedAt: "2026-10-31T00:00:00.000Z",
      status: "idle",
    };
    await client.invalidateQueries({ queryKey: expertLearningQueryKey(expert.id) });
    await expect.element(feedback).toHaveValue("保留自动刷新期间的反馈");
    await expect
      .element(page.getByTestId("experience-node:automatic-no-change"))
      .not.toBeInTheDocument();
    expect(harness.calls.filter((request) => request.action === "list").length).toBeGreaterThan(1);
  });

  it("opens one timeline node at a time, preserves draft edits and collapses secondary controls", async () => {
    harness.runs = [run(), discoveryRun()];
    await mount();
    const candidate = timelineRow("request-update").getByRole("button").first();
    const experience = timelineRow("request-discovery").getByRole("button").first();
    await expect.element(candidate).toHaveAttribute("aria-expanded", "false");
    await expect.element(experience).toHaveAttribute("aria-expanded", "false");
    await expect
      .element(page.getByRole("button", { name: "进化星图", exact: true }))
      .toHaveAttribute("aria-expanded", "false");
    await openRun("request-update");
    await page.getByRole("button", { name: "编辑候选" }).click();
    await page.getByRole("textbox", { name: "候选 Skill 名称" }).fill("保留的候选草稿");
    await openRun("request-discovery");
    await expect.element(candidate).toHaveAttribute("aria-expanded", "false");
    await page.getByRole("textbox", { name: "生成反馈：修复后复核" }).fill("保留反馈");
    await openRun("request-update");
    await expect
      .element(page.getByRole("textbox", { name: "候选 Skill 名称" }))
      .toHaveValue("保留的候选草稿");
    await openRun("request-discovery");
    await expect
      .element(page.getByRole("textbox", { name: "生成反馈：修复后复核" }))
      .toHaveValue("保留反馈");
    await experience.click();
    await expect.element(experience).toHaveAttribute("aria-expanded", "false");
    expect(
      harness.calls.some((request) =>
        ["start", "generate", "apply", "edit"].includes(request.action),
      ),
    ).toBe(false);
  });

  it("keeps generated draft edits through detail tabs and closing the file panel", async () => {
    const parent = discoveryRun();
    const child = run({
      requestId: "generation-tabs",
      stage: "generation",
      discoveryRequestId: parent.requestId,
      opportunityId: "opportunity-1",
      generationIndex: 1,
      proposals: [proposal({ requestId: "generation-tabs" })],
    });
    harness.runs = [parent, child];
    await page.viewport(390, 844);
    await mount();
    await openRun(parent.requestId);
    const changes = page.getByRole("tab", { name: "本次改动" });
    await expect.element(changes).toHaveAttribute("aria-selected", "true");
    await expect
      .element(page.getByRole("region", { name: "候选文件差异" }))
      .not.toBeInTheDocument();
    await page.getByRole("button", { name: "编辑候选" }).click();
    await page.getByRole("textbox", { name: "候选 Skill 名称" }).fill("跨标签保留的名称");
    await page.getByRole("textbox", { name: "候选文件 SKILL.md" }).fill("Unsaved complete file.");
    await page.getByRole("button", { name: "关闭完整差异" }).click();
    await page.getByRole("tab", { name: /^依据 / }).click();
    await expect.element(page.getByRole("tabpanel", { name: /^依据 / })).toBeVisible();
    await expect
      .element(page.getByRole("button", { name: "保存候选编辑" }))
      .not.toBeInTheDocument();
    await expect.element(page.getByRole("tab", { name: "运行记录" })).not.toBeInTheDocument();
    await changes.click();
    await page.getByRole("button", { name: /继续编辑草稿/ }).click();
    await expect
      .element(page.getByRole("textbox", { name: "候选 Skill 名称" }))
      .toHaveValue("跨标签保留的名称");
    await expect
      .element(page.getByRole("textbox", { name: "候选文件 SKILL.md" }))
      .toHaveValue("Unsaved complete file.");
    expect(harness.calls.some((request) => ["edit", "apply"].includes(request.action))).toBe(false);
    await page.getByRole("button", { name: "保存候选编辑" }).click();
    await expect
      .poll(() => harness.calls.find((request) => request.action === "edit"))
      .toMatchObject({
        name: "跨标签保留的名称",
        changes: [{ path: "SKILL.md", content: btoa("Unsaved complete file.") }],
      });
  });

  it("shows applied results without nested cards and opens full content on demand", async () => {
    const parent = discoveryRun();
    const applied = proposal({
      requestId: "generation-applied",
      name: "回归复核方法：区分检查通过与目标达成",
      status: "applied",
      resultSkillId: skillId,
      resultRevision: 2,
    });
    harness.runs = [
      parent,
      run({
        requestId: applied.requestId,
        stage: "generation",
        discoveryRequestId: parent.requestId,
        opportunityId: "opportunity-1",
        generationIndex: 1,
        proposals: [applied],
      }),
    ];
    await page.viewport(390, 844);
    await mount();
    await openRun(parent.requestId);
    const title = page
      .getByRole("heading", { name: applied.name })
      .element()
      .getBoundingClientRect();
    expect(title.width).toBeGreaterThan(180);
    const node = timelineRow(parent.requestId).element();
    expect(node.scrollWidth).toBeLessThanOrEqual(node.clientWidth + 1);
    await expect.element(page.getByText(/下次独立运行生效/)).toBeVisible();
    await expect
      .element(page.getByText(/应用完成不代表已通过独立运行验证/))
      .not.toBeInTheDocument();
    await expect.element(page.getByText("暂无待处理", { exact: true })).not.toBeInTheDocument();
    await expect.element(page.getByRole("button", { name: "编辑候选" })).not.toBeInTheDocument();
    await expect
      .element(page.getByRole("button", { name: /查看生成任务/ }))
      .not.toBeInTheDocument();
    await page.getByRole("button", { name: /查看完整差异/ }).click();
    await expect.element(page.getByRole("dialog", { name: /完整差异/ })).toBeVisible();
    await expect.element(page.getByRole("region", { name: "候选文件差异" })).toBeVisible();
    await page.getByRole("button", { name: "关闭完整差异" }).click();
    await expect
      .element(page.getByRole("tab", { name: "本次改动" }))
      .toHaveAttribute("aria-selected", "true");
    expect(
      harness.calls.some((request) => ["generate", "apply", "edit"].includes(request.action)),
    ).toBe(false);
  });

  it("switches one configuration area at a time and preserves source, focus and model choices", async () => {
    await mount();
    const sources = page.getByRole("button", { name: /已选 .* 段工作记录/ });
    const focus = page.getByRole("button", { name: "补充提炼重点" });
    const model = page.getByRole("button", { name: "调整提炼模型" });
    await sources.click();
    const selection = page.getByRole("checkbox", { name: "选择来源：完成的复核任务" }).first();
    await expect.element(selection).toBeVisible();
    const selectedBefore = selection.element().getAttribute("aria-checked");
    await focus.click();
    await expect.element(sources).toHaveAttribute("aria-expanded", "false");
    await expect.element(selection).not.toBeInTheDocument();
    await page.getByRole("textbox", { name: "发现重点", exact: true }).fill("只提炼通用方法");
    await model.click();
    await expect
      .element(page.getByRole("button", { name: "编辑提炼重点" }))
      .toHaveAttribute("aria-expanded", "false");
    await expect
      .element(page.getByRole("textbox", { name: "发现重点", exact: true }))
      .not.toBeInTheDocument();
    await sources.click();
    await expect.element(model).toHaveAttribute("aria-expanded", "false");
    await expect.element(selection).toHaveAttribute("aria-checked", selectedBefore ?? "false");
    await page.getByRole("button", { name: "编辑提炼重点" }).click();
    await expect
      .element(page.getByRole("textbox", { name: "发现重点", exact: true }))
      .toHaveValue("只提炼通用方法");
    await page.getByRole("button", { name: "编辑提炼重点" }).click();
    await expect
      .element(page.getByRole("textbox", { name: "发现重点", exact: true }))
      .not.toBeInTheDocument();
    expect(harness.draft.handleProviderModelChange).not.toHaveBeenCalled();
  });

  it("lays out source and evidence actions to the right of their content", async () => {
    harness.runs = [discoveryRun()];
    await page.viewport(1176, 823);
    await mount();
    await page.getByRole("button", { name: /已选 .* 段工作记录/ }).click();
    const source = page
      .getByRole("checkbox", { name: "选择来源：完成的复核任务" })
      .first()
      .element()
      .closest("li")!;
    const sourceBounds = source.getBoundingClientRect();
    const sourceAction = [...source.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("打开任务"),
    )!;
    expect(sourceBounds.height).toBeLessThan(100);
    expect(sourceAction.getBoundingClientRect().left).toBeGreaterThan(
      sourceBounds.left + sourceBounds.width / 2,
    );
    await openRun("request-discovery");
    await page.getByRole("tab", { name: /^依据 / }).click();
    const quote = page.getByRole("blockquote").element();
    const evidenceAction = page.getByRole("button", { name: "打开来源任务" }).element();
    expect(evidenceAction.getBoundingClientRect().left).toBeGreaterThanOrEqual(
      quote.getBoundingClientRect().right,
    );
    expect(harness.openedTasks).toEqual([]);
  });

  it("uses an explicit completed history source and starts experience discovery with the selected model", async () => {
    harness.runs = [discoveryRun([], "previous-discovery")];
    await page.viewport(390, 900);
    await mount("thread-alpha");
    await page.getByRole("button", { name: /已选 .* 段工作记录/ }).click();
    const latestTurn = page.getByRole("checkbox", { name: "选择来源：完成的复核任务" }).nth(0);
    const olderTurn = page.getByRole("checkbox", { name: "选择来源：完成的复核任务" }).nth(1);
    await expect.element(latestTurn).toBeChecked();
    await expect.element(olderTurn).not.toBeChecked();
    await expect
      .element(page.getByRole("combobox", { name: "目标 Skill" }))
      .not.toBeInTheDocument();
    await expect
      .element(page.getByRole("region", { name: "候选文件差异" }))
      .not.toBeInTheDocument();
    await page.getByRole("button", { name: "提炼经验", exact: true }).click();
    await expect.poll(() => harness.calls.some((request) => request.action === "start")).toBe(true);
    const request = harness.calls.find((item) => item.action === "start");
    expect(request).toMatchObject({
      action: "start",
      expertId: expert.id,
      sources: [{ threadId: "thread-alpha", turnId: "turn-alpha-2" }],
      modelSelection: { provider: "pi", model: "user-selected-pi-model" },
    });
    expect(request).not.toHaveProperty("targetSkillId");
    expect(harness.draft.handleProviderModelChange).not.toHaveBeenCalled();
    await expect
      .element(page.getByText("没有发现值得提炼的可复用经验。正式 Skill、修订和绑定不变。"))
      .toBeVisible();
  });

  it("defaults away from discovered sources while leaving those sources manually selectable", async () => {
    harness.runs = [discoveryRun([], "covered-discovery")];
    await mount();
    await expect.element(page.getByText("已选 1 段工作记录")).toBeVisible();
    await page.getByRole("button", { name: /已选 .* 段工作记录/ }).click();
    const latest = page.getByRole("checkbox", { name: "选择来源：完成的复核任务" }).first();
    const older = page.getByRole("checkbox", { name: "选择来源：完成的复核任务" }).nth(1);
    await expect.element(latest).not.toBeChecked();
    await expect.element(older).toBeChecked();
    await latest.click();
    await page.getByRole("button", { name: "提炼经验", exact: true }).click();
    await expect.poll(() => harness.calls.some((request) => request.action === "start")).toBe(true);
    expect(harness.calls.find((request) => request.action === "start")).toMatchObject({
      sources: [
        { threadId: "thread-alpha", turnId: "turn-alpha-1" },
        { threadId: "thread-alpha", turnId: "turn-alpha-2" },
      ],
    });
  });

  it("reselects a history task after a manual range change, including the same task again", async () => {
    sourceRows = historySources;
    await mount(null, false, true);
    await page.getByRole("button", { name: /已选 .* 段工作记录/ }).click();
    const alphaLatest = page.getByRole("checkbox", { name: "选择来源：完成的复核任务" }).first();
    const beta = page.getByRole("checkbox", { name: "选择来源：Beta 工作片段" });
    const gammaLatest = page.getByRole("checkbox", { name: "选择来源：Gamma 工作片段" }).first();
    const gammaOlder = page.getByRole("checkbox", { name: "选择来源：Gamma 工作片段" }).nth(1);
    await expect.element(alphaLatest).toBeChecked();
    await alphaLatest.click();
    await beta.click();
    await expect.element(beta).toBeChecked();

    await page.getByRole("button", { name: "选择历史任务 C", exact: true }).click();
    await expect.element(gammaLatest).toBeChecked();
    await expect.element(gammaOlder).not.toBeChecked();
    await expect.element(beta).not.toBeChecked();
    await beta.click();
    await expect.element(beta).toBeChecked();

    await page.getByRole("button", { name: "重新选择历史任务 C" }).click();
    await expect.element(gammaLatest).toBeChecked();
    await expect.element(gammaOlder).not.toBeChecked();
    await expect.element(beta).not.toBeChecked();
    await page.getByRole("button", { name: "提炼经验", exact: true }).click();
    await expect.poll(() => harness.calls.some((request) => request.action === "start")).toBe(true);
    expect(harness.calls.find((request) => request.action === "start")).toMatchObject({
      sources: [{ threadId: "thread-gamma", turnId: "turn-gamma-2" }],
    });
  });

  it("reuses an unknown discovery request ID and payload on a deliberate retry", async () => {
    harness.startUnknownOutcomeOnce = "before-persist";
    await mount();
    await page.getByRole("button", { name: "提炼经验", exact: true }).click();
    await expect.element(page.getByText("连接中断，结果未知。")).toBeVisible();
    await expect
      .poll(() => harness.calls.filter((request) => request.action === "start").length)
      .toBe(1);
    const firstRequest = harness.calls.find((request) => request.action === "start");
    await page.getByRole("button", { name: "提炼经验", exact: true }).click();
    await expect
      .element(page.getByText("已开始查找可复用经验。此阶段不会写入正式 Skill。"))
      .toBeVisible();
    const startRequests = harness.calls.filter((request) => request.action === "start");
    expect(startRequests).toHaveLength(2);
    expect(startRequests[1]).toEqual(firstRequest);
  });

  it("uses a fresh discovery request ID after the user changes the pending payload", async () => {
    harness.startUnknownOutcomeOnce = "before-persist";
    await mount();
    await page.getByRole("button", { name: "提炼经验", exact: true }).click();
    await expect.element(page.getByText("连接中断，结果未知。")).toBeVisible();
    const firstRequest = harness.calls.find(
      (request): request is Extract<SkillEvolutionRequest, { action: "start" }> =>
        request.action === "start",
    );
    await page.getByRole("button", { name: /已选 .* 段工作记录/ }).click();
    await page.getByRole("button", { name: "补充提炼重点" }).click();
    await page.getByRole("textbox", { name: "发现重点" }).fill("改为关注恢复流程");
    await page.getByRole("button", { name: "提炼经验", exact: true }).click();
    await expect
      .element(page.getByText("已开始查找可复用经验。此阶段不会写入正式 Skill。"))
      .toBeVisible();
    const requests = harness.calls.filter(
      (request): request is Extract<SkillEvolutionRequest, { action: "start" }> =>
        request.action === "start",
    );
    expect(requests).toHaveLength(2);
    expect(requests[1]?.requestId).not.toBe(firstRequest?.requestId);
    expect(requests[1]).toMatchObject({ focus: "改为关注恢复流程" });
  });

  it("recovers a discovery run persisted before an unknown network outcome without resubmitting", async () => {
    harness.startUnknownOutcomeOnce = "after-persist";
    await mount();
    await page.getByRole("button", { name: "提炼经验", exact: true }).click();
    await expect
      .element(page.getByText("已恢复此次提炼请求。此阶段不会写入正式 Skill。"))
      .toBeVisible();
    await expect.element(page.getByText("提取失败", { exact: true })).not.toBeInTheDocument();
    expect(harness.calls.filter((request) => request.action === "start")).toHaveLength(1);
    const started = harness.calls.find(
      (request): request is Extract<SkillEvolutionRequest, { action: "start" }> =>
        request.action === "start",
    );
    if (!started) throw new Error("The discovery request was not recorded.");
    await expect
      .element(timelineRow(started.requestId).getByRole("button").first())
      .toHaveAttribute("aria-expanded", "true");
  });

  it("keeps opportunity feedback through discovery and protects edits made while the request is pending", async () => {
    harness.runs = [discoveryRun()];
    let releaseStart!: () => void;
    harness.startGate = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    await mount();
    await openRun("request-discovery");
    const feedback = page.getByRole("textbox", { name: "生成反馈：修复后复核" });
    await feedback.fill("先保存的机会反馈。");
    await page.getByRole("button", { name: "提炼经验", exact: true }).click();
    await expect.poll(() => harness.calls.some((request) => request.action === "start")).toBe(true);
    await feedback.fill("请求提交期间补充的反馈。");
    releaseStart();
    await expect
      .element(page.getByText("已开始查找可复用经验。此阶段不会写入正式 Skill。"))
      .toBeVisible();
    await openRun("request-discovery");
    await expect.element(feedback).toHaveValue("请求提交期间补充的反馈。");
    await page.getByRole("link", { name: "离开进化页" }).click();
    await expect.element(page.getByRole("heading", { name: "未保存的更改" })).toBeVisible();
  });

  it("prefills recent sources without making the page dirty and keeps the range editable", async () => {
    await mount();
    await expect.element(page.getByText("已选 2 段工作记录")).toBeVisible();
    await page.getByRole("button", { name: /已选 .* 段工作记录/ }).click();
    await expect
      .element(page.getByRole("checkbox", { name: "选择来源：完成的复核任务" }).first())
      .toBeChecked();
    await expect
      .element(page.getByRole("checkbox", { name: "选择来源：完成的复核任务" }).nth(1))
      .toBeChecked();
    await page.getByRole("link", { name: "离开进化页" }).click();
    await expect.element(page.getByText("离开后的页面")).toBeVisible();
    await expect
      .element(page.getByRole("heading", { name: "未保存的更改" }))
      .not.toBeInTheDocument();
  });

  it("keeps the no-source state concise and hides the source/model form", async () => {
    sourceRows = [];
    await mount();
    await expect.element(page.getByText("暂无可提炼的工作经验")).toBeVisible();
    await expect
      .element(page.getByRole("button", { name: "提炼经验", exact: true }))
      .not.toBeInTheDocument();
    await expect
      .element(page.getByRole("button", { name: /已选 .* 段工作记录/ }))
      .not.toBeInTheDocument();
    await expect.element(page.getByRole("textbox", { name: "发现重点" })).not.toBeInTheDocument();
  });

  it("distinguishes insufficient evidence and failed runs", async () => {
    harness.startStatus = "insufficient_evidence";
    await page.viewport(390, 900);
    await mount();
    await page.getByRole("button", { name: /已选 .* 段工作记录/ }).click();
    await page.getByRole("checkbox", { name: "选择来源：完成的复核任务" }).first().click();
    await page.getByRole("button", { name: "提炼经验", exact: true }).click();
    await expect
      .element(
        page.getByText("证据不足：当前来源无法支撑可复用结论。你可以补充来源后再次主动提炼。"),
      )
      .toBeVisible();
    harness.startStatus = "failed";
    await page.getByRole("checkbox", { name: "选择来源：完成的复核任务" }).nth(1).click();
    await page.getByRole("button", { name: "提炼经验", exact: true }).click();
    await expect.element(page.getByText("原生提炼任务执行失败。")).toBeVisible();
  });

  it("does not show file diffs before an experience opportunity is generated", async () => {
    const repeatedMessage = opportunity();
    harness.runs = [
      discoveryRun([
        {
          ...repeatedMessage,
          evidence: [
            ...repeatedMessage.evidence,
            { ...repeatedMessage.evidence[0]!, quote: "同一消息中的第二段独立依据。" },
          ],
        },
      ]),
    ];
    const consoleError = vi.spyOn(console, "error");
    await mount();
    await openRun("request-discovery");
    const card = page.getByRole("article", { name: "经验机会：修复后复核" });
    await expect.element(card).toBeVisible();
    await expect
      .element(
        page
          .getByRole("tabpanel", { name: "本次改动" })
          .getByText("多次任务都先定位原因，再重跑检查并核对实际输出。"),
      )
      .toBeVisible();
    await expect.element(page.getByText("记录复现步骤")).toBeVisible();
    await expect.element(page.getByText("复核真实结果")).toBeVisible();
    await page.getByRole("tab", { name: /^依据 / }).click();
    await expect.element(page.getByText("修复后再跑一次并看实际输出。")).toBeVisible();
    await expect
      .element(page.getByRole("region", { name: "候选文件差异" }))
      .not.toBeInTheDocument();
    await expect.element(page.getByText("同一消息中的第二段独立依据。")).toBeVisible();
    expect(consoleError.mock.calls.some((args) => String(args[0]).includes("same key"))).toBe(
      false,
    );
    consoleError.mockRestore();
    expect(graphForTest.events).toEqual([]);
    expect(harness.calls.some((request) => request.action === "apply")).toBe(false);
  });

  it("generates and regenerates an experience preview before explicit application", async () => {
    harness.runs = [discoveryRun()];
    await mount();
    await openRun("request-discovery");
    await page
      .getByRole("textbox", { name: "生成反馈：修复后复核" })
      .fill("保留通用复核步骤，去掉项目专有信息。");
    await page.getByRole("tab", { name: /^依据 / }).click();
    await page.getByRole("button", { name: "打开来源任务" }).click();
    expect(harness.openedTasks).toEqual(["thread-alpha"]);
    await page.getByRole("tab", { name: "本次改动" }).click();
    await page.getByRole("button", { name: /^(生成修改|重新生成)预览$/ }).click();
    await expect.element(page.getByRole("button", { name: /查看完整差异/ })).toBeVisible();
    await expect
      .element(page.getByRole("region", { name: "候选文件差异" }))
      .not.toBeInTheDocument();

    const generateRequests = harness.calls.filter(
      (request): request is Extract<SkillEvolutionRequest, { action: "generate" }> =>
        request.action === "generate",
    );
    expect(generateRequests).toHaveLength(1);
    expect(generateRequests[0]).toMatchObject({
      discoveryRequestId: "request-discovery",
      opportunityId: "opportunity-1",
      expectedDigest: "d".repeat(64),
      feedback: "保留通用复核步骤，去掉项目专有信息。",
    });
    expect(generateRequests[0]).not.toHaveProperty("modelSelection");
    expect(harness.draft.handleProviderModelChange).not.toHaveBeenCalled();
    expect(graphForTest.events).toEqual([]);

    await page.getByRole("button", { name: /^(生成修改|重新生成)预览$/ }).click();
    await expect
      .poll(() => harness.calls.filter((request) => request.action === "generate").length)
      .toBe(2);
    const allGenerateRequests = harness.calls.filter(
      (request): request is Extract<SkillEvolutionRequest, { action: "generate" }> =>
        request.action === "generate",
    );
    expect(allGenerateRequests[1]?.requestId).not.toBe(allGenerateRequests[0]?.requestId);
    await expect
      .element(timelineRow("request-discovery").getByRole("button").first())
      .toHaveAttribute("aria-expanded", "true");
    expect(harness.calls.some((request) => request.action === "apply")).toBe(false);
    expect(graphForTest.events).toEqual([]);

    await page.getByRole("button", { name: "审阅并应用" }).click();
    expect(harness.calls.some((request) => request.action === "apply")).toBe(false);
    await expect.element(page.getByRole("region", { name: "候选文件差异" })).toBeVisible();
    await page.getByRole("button", { name: "应用到「update review method」" }).click();
    await page.getByRole("button", { name: "关闭完整差异" }).click();
    await expect.poll(() => harness.calls.some((request) => request.action === "apply")).toBe(true);
    await expect.poll(() => graphForTest.events.length).toBe(1);
    await expect
      .element(page.getByRole("button", { name: /^(生成修改|重新生成)预览$/ }))
      .not.toBeInTheDocument();
    await expect.element(page.getByRole("button", { name: "忽略" })).not.toBeInTheDocument();
    await expect
      .element(timelineRow("request-discovery").getByRole("button").first())
      .toHaveAttribute("aria-expanded", "true");
    await expect
      .element(timelineRow("request-discovery").getByText("已应用", { exact: true }))
      .toBeVisible();
  });

  it("shows a generation transport error without retry or diagnostic controls", async () => {
    harness.runs = [discoveryRun()];
    harness.generateBeforePersistFailure = true;
    await mount();
    await openRun("request-discovery");
    await page.getByRole("button", { name: "生成修改预览", exact: true }).click();
    const card = page.getByRole("article", { name: "经验机会：修复后复核" });
    await expect.element(card.getByRole("alert")).toHaveTextContent("提取失败");
    await expect.element(card.getByRole("alert")).toHaveTextContent("模型服务连接失败。");
    await expect.element(card.getByRole("button")).not.toBeInTheDocument();
    await expect.element(card.getByRole("textbox")).not.toBeInTheDocument();
    expect(harness.calls.filter((request) => request.action === "generate")).toHaveLength(1);
    expect(harness.calls.some((request) => ["apply", "cancel"].includes(request.action))).toBe(
      false,
    );
  });

  it("recovers a generation result lost in transport by reading it without another dispatch", async () => {
    harness.runs = [discoveryRun()];
    harness.generateUnknownOutcomeOnce = true;
    await mount();
    await openRun("request-discovery");
    await page.getByRole("button", { name: "生成修改预览", exact: true }).click();
    await expect.element(page.getByRole("button", { name: /查看完整差异/ })).toBeVisible();
    const card = page.getByRole("article", { name: "经验机会：修复后复核" });
    await expect.element(card.getByRole("alert")).not.toBeInTheDocument();
    expect(harness.calls.filter((request) => request.action === "generate")).toHaveLength(1);
    expect(harness.openedTasks).toEqual([]);
  });

  it("shows progress without exposing native task management", async () => {
    const parent = discoveryRun();
    harness.runs = [
      parent,
      run({
        requestId: "generation-active",
        stage: "generation",
        discoveryRequestId: parent.requestId,
        opportunityId: "opportunity-1",
        generationIndex: 1,
        status: "running",
        proposals: [],
      }),
    ];
    await mount();
    await openRun(parent.requestId);
    await expect.element(page.getByText("正在提取…", { exact: true })).toBeVisible();
    const card = page.getByRole("article", { name: "经验机会：修复后复核" });
    await expect
      .element(card.getByRole("button", { name: /取消|查看.*任务/ }))
      .not.toBeInTheDocument();
    await expect
      .element(card.getByRole("button", { name: /^(生成修改|重新生成)预览$/ }))
      .not.toBeInTheDocument();
    expect(harness.calls.some((request) => request.action === "cancel")).toBe(false);
  });

  it("blocks generation for a target without Expert copy-and-improve permission and routes to abilities", async () => {
    harness.runs = [discoveryRun([opportunity({ targetSkillId: skillId })])];
    await mount();
    await openRun("request-discovery");
    await expect
      .element(
        page.getByText(/目标 Skill「Review findings」尚未在此 Expert 绑定中开启“允许复制并改进”/),
      )
      .toBeVisible();
    await expect
      .element(page.getByRole("button", { name: /^(生成修改|重新生成)预览$/ }))
      .toBeDisabled();
    await page.getByRole("button", { name: "前往 Expert 能力配置" }).click();
    expect(harness.openedAbilities).toBe(1);
    expect(harness.calls.some((request) => request.action === "generate")).toBe(false);
  });

  it("ignores an opportunity using the parent request and its digest", async () => {
    harness.runs = [discoveryRun()];
    await mount();
    await openRun("request-discovery");
    await page.getByRole("button", { name: "忽略" }).click();
    await expect
      .poll(() => harness.calls.some((request) => request.action === "dismissOpportunity"))
      .toBe(true);
    expect(harness.calls.find((request) => request.action === "dismissOpportunity")).toEqual({
      action: "dismissOpportunity",
      requestId: "request-discovery",
      opportunityId: "opportunity-1",
      expectedDigest: "d".repeat(64),
    });
  });

  it("makes older child drafts read-only after a newer generation exists", async () => {
    const parent = discoveryRun();
    const older = run({
      requestId: "generation-old",
      stage: "generation",
      discoveryRequestId: parent.requestId,
      opportunityId: "opportunity-1",
      generationIndex: 1,
      proposals: [proposal({ requestId: "generation-old", proposalId: "proposal-old" })],
    });
    const latest = run({
      requestId: "generation-latest",
      stage: "generation",
      discoveryRequestId: parent.requestId,
      opportunityId: "opportunity-1",
      generationIndex: 2,
      proposals: [proposal({ requestId: "generation-latest", proposalId: "proposal-latest" })],
    });
    harness.runs = [parent, older, latest];
    await mount();
    await openRun("generation-old");
    await expect
      .element(page.getByText("此候选已被更新的生成结果替代，不能继续编辑或采用。"))
      .toBeVisible();
    await expect.element(page.getByRole("button", { name: "编辑候选" })).not.toBeInTheDocument();
    await expect.element(page.getByRole("button", { name: "审阅并应用" })).not.toBeInTheDocument();

    await openRun("generation-latest");
    await expect.element(page.getByRole("button", { name: "编辑候选" })).toBeVisible();
    await expect.element(page.getByRole("button", { name: "审阅并应用" })).toBeVisible();
  });

  it("blocks dismissed opportunities and their existing child proposals", async () => {
    const parent = discoveryRun([opportunity({ status: "dismissed" })]);
    const child = run({
      requestId: "generation-dismissed",
      stage: "generation",
      discoveryRequestId: parent.requestId,
      opportunityId: "opportunity-1",
      generationIndex: 1,
      proposals: [
        proposal({ requestId: "generation-dismissed", proposalId: "proposal-dismissed" }),
      ],
    });
    harness.runs = [parent, child];
    await mount();
    await openRun("request-discovery");
    await expect.element(page.getByText("已忽略此经验机会；相关生成结果不能采用。")).toBeVisible();
    await expect
      .element(page.getByRole("button", { name: /^(生成修改|重新生成)预览$/ }))
      .not.toBeInTheDocument();
    await expect.element(page.getByRole("button", { name: "审阅并应用" })).not.toBeInTheDocument();

    await openRun("generation-dismissed");
    await expect.element(page.getByText("此经验已忽略，不能继续编辑或采用。")).toBeVisible();
    expect(harness.calls.some((request) => request.action === "apply")).toBe(false);
  });

  it("shows a failed child as a reason-only outcome without user work", async () => {
    const parent = discoveryRun();
    harness.runs = [
      parent,
      run({
        requestId: "generation-failed",
        stage: "generation",
        discoveryRequestId: parent.requestId,
        opportunityId: "opportunity-1",
        generationIndex: 1,
        status: "failed",
        error: "模型响应超时。",
        proposals: [],
      }),
    ];
    await mount();
    const card = page.getByRole("article", { name: "经验机会：修复后复核" });
    await expect.element(card.getByRole("alert")).toHaveTextContent("提取失败");
    await expect.element(timelineRow(parent.requestId).getByRole("button")).not.toBeInTheDocument();
    await expect.element(card.getByRole("alert")).toHaveTextContent("模型响应超时。");
    await expect.element(card.getByRole("button")).not.toBeInTheDocument();
    await expect.element(card.getByRole("tab")).not.toBeInTheDocument();
    await expect.element(page.getByText(/条待处理/)).not.toBeInTheDocument();
    expect(
      harness.calls.some((request) => ["generate", "apply", "cancel"].includes(request.action)),
    ).toBe(false);
  });

  it.each([
    ["create", "应用到「create review method」", "将创建归属于 Review Expert 的专用 Skill。"],
    [
      "derive",
      "应用到「derive review method」",
      "将基于来源 Skill 为 Review Expert 创建专用副本；共享来源保持原样。",
    ],
    ["update", "应用到「update review method」", "将更新 Review Expert 的专用 Skill。"],
  ] as const)(
    "applies the %s proposal action with concise owner-aware labels",
    async (action, label, ownerDescription) => {
      const candidate = proposal({ action });
      harness.runs = [run({ requestId: candidate.requestId, proposals: [candidate] })];
      await page.viewport(390, 900);
      await mount();
      await openRun(candidate.requestId);
      await expect
        .element(page.getByRole("article", { name: `Skill 候选：${action} review method` }))
        .toBeVisible();
      await expect.element(page.getByText(ownerDescription, { exact: true })).toBeVisible();
      await page.getByRole("button", { name: label }).click();
      await expect
        .poll(() => harness.calls.some((request) => request.action === "apply"))
        .toBe(true);
      const apply = harness.calls.find((request) => request.action === "apply");
      expect(apply).toMatchObject({
        action: "apply",
        requestId: candidate.requestId,
        proposalId: candidate.proposalId,
        expectedDigest: "f".repeat(64),
      });
      expect(apply).not.toHaveProperty("approveProtected");
      expect(apply && apply.action === "apply" ? apply.operationId : "").toBeTruthy();
      await expect.element(page.getByRole("heading", { name: "已采用" })).toBeVisible();
    },
  );

  it("shows partial proposal outcomes and counts instead of the unchanged proposal_ready status", async () => {
    const appliedCandidate = proposal({ action: "update" });
    const pendingCandidate = proposal({
      action: "update",
      proposalId: "proposal-update-pending",
      name: "Pending review method",
    });
    harness.runs = [
      run({
        requestId: appliedCandidate.requestId,
        proposals: [appliedCandidate, pendingCandidate],
        summary: "This model summary is not the terminal outcome.",
      }),
    ];
    await page.viewport(390, 900);
    await mount();
    await openRun(appliedCandidate.requestId);
    await page.getByRole("button", { name: "应用到「update review method」" }).first().click();
    await expect.element(page.getByRole("heading", { name: "部分处理" })).toBeVisible();
    await expect
      .element(page.getByText("已采用 1 · 已拒绝 0 · 冲突 0 · 失败 0 · 待处理 1"))
      .toBeVisible();
    await expect
      .element(page.getByText("This model summary is not the terminal outcome."))
      .not.toBeInTheDocument();
  });

  it("rejects a candidate and preserves a server conflict without reporting it as applied", async () => {
    const updateProposal = proposal({ action: "update" });
    harness.runs = [run({ requestId: updateProposal.requestId, proposals: [updateProposal] })];
    await page.viewport(390, 900);
    await mount();
    await openRun(updateProposal.requestId);
    await page.getByRole("button", { name: "拒绝" }).click();
    await expect
      .poll(() => harness.calls.some((request) => request.action === "reject"))
      .toBe(true);
    expect(harness.calls.find((request) => request.action === "reject")).toMatchObject({
      action: "reject",
      expectedDigest: updateProposal.digest,
    });
    await expect.element(page.getByText("已拒绝，此候选不会写入正式 Skill。")).toBeVisible();

    harness.runs = [
      run({
        requestId: "request-update-conflict",
        proposals: [proposal({ action: "update", requestId: "request-update-conflict" })],
      }),
    ];
    harness.applyConflict = true;
    await dispose?.();
    dispose = undefined;
    await mount();
    await openRun("request-update-conflict");
    await page.getByRole("button", { name: "应用到「update review method」" }).click();
    await expect
      .element(page.getByText("目标版本或绑定已变化；候选已保留，请基于最新配置重新提炼。"))
      .toBeVisible();
    expect(page.getByRole("heading", { name: "已采用" })).not.toBeInTheDocument();
  });

  it("reuses the same operation ID when continuing a saved but unbound derivation", async () => {
    const derivedProposal = proposal({ action: "derive" });
    harness.runs = [run({ requestId: derivedProposal.requestId, proposals: [derivedProposal] })];
    harness.applySavedUnboundOnce = true;
    await page.viewport(390, 900);
    await mount();
    await openRun(derivedProposal.requestId);
    await page.getByRole("button", { name: "应用到「derive review method」" }).click();
    await expect.element(page.getByRole("button", { name: "继续完成绑定" })).toBeVisible();
    await page.getByRole("button", { name: "继续完成绑定" }).click();
    await expect
      .poll(() => harness.calls.filter((request) => request.action === "apply").length)
      .toBe(2);
    const applyRequests = harness.calls.filter(
      (request): request is Extract<SkillEvolutionRequest, { action: "apply" }> =>
        request.action === "apply",
    );
    expect(applyRequests[1]?.operationId).toBe(applyRequests[0]?.operationId);
    await expect.element(page.getByRole("heading", { name: "已采用" })).toBeVisible();
  });

  it("edits complete candidate files and can add an executable resource", async () => {
    const updateProposal = proposal({ action: "update" });
    harness.runs = [run({ requestId: updateProposal.requestId, proposals: [updateProposal] })];
    await page.viewport(390, 900);
    await mount();
    await openRun(updateProposal.requestId);
    await page.getByRole("button", { name: "编辑候选" }).click();
    await page.getByRole("textbox", { name: "新候选文件路径" }).fill("docs/checklist.md");
    await page.getByRole("button", { name: "添加文件" }).click();
    await page
      .getByRole("textbox", { name: "候选文件 docs/checklist.md" })
      .fill("Review checklist.");
    await page.getByRole("checkbox", { name: "设置可执行权限：docs/checklist.md" }).click();
    await page.getByRole("button", { name: "保存候选编辑" }).click();
    await expect
      .poll(() => harness.calls.find((request) => request.action === "edit"))
      .toBeTruthy();
    const editRequest = harness.calls.find(
      (request): request is Extract<SkillEvolutionRequest, { action: "edit" }> =>
        request.action === "edit",
    );
    expect(editRequest?.changes).toContainEqual({
      path: "docs/checklist.md",
      content: btoa("Review checklist."),
      executable: true,
    });
  });

  it("shows the _chat flex parent without horizontal overflow at narrow and wide widths", async () => {
    for (const width of [320, 390, 1280]) {
      harness.runs = [run(), discoveryRun()];
      await page.viewport(width, 900);
      await mount();
      const parent = page.getByTestId("_chat-flex-parent");
      await expect
        .poll(() => {
          const element = parent.element();
          return element.scrollWidth <= element.clientWidth + 1;
        })
        .toBe(true);
      await page.getByRole("button", { name: "进化星图", exact: true }).click();
      const chart = page.getByRole("group", { name: "Expert Skill 时间环星图" });
      await expect.element(chart).toBeVisible();
      await dispose?.();
      dispose = undefined;
    }
  });

  it("previews and restores only the first derived binding, keeping a stable digest-bound operation", async () => {
    graphForTest = graphWithDerived;
    await page.viewport(390, 900);
    await mount();
    await page.getByRole("button", { name: "进化星图", exact: true }).click();
    await page.getByRole("button", { name: /Expert-only review copy，版本 1/ }).click();
    await expect.element(page.getByRole("button", { name: "预览内容恢复" })).toBeVisible();
    await page.getByRole("button", { name: "预览恢复原绑定" }).click();
    await expect
      .poll(() => harness.calls.some((request) => request.action === "previewBindingRestore"))
      .toBe(true);
    expect(harness.calls.find((request) => request.action === "previewBindingRestore")).toEqual({
      action: "previewBindingRestore",
      eventId: derivedEvent.eventId,
      expertId: expert.id,
    });
    await expect.element(page.getByRole("region", { name: "恢复原绑定预览" })).toBeVisible();
    await expect
      .element(page.getByTestId(`恢复前绑定:${derivedSkillId}`))
      .toHaveTextContent("Expert-only review copy · 已启用 · 允许复制并改进");
    await expect
      .element(page.getByTestId(`恢复后绑定:${skillId}`))
      .toHaveTextContent("Review findings · 已启用 · 允许复制并改进");
    await expect
      .element(page.getByTestId(`恢复后绑定:${otherSkillId}`))
      .toHaveTextContent("skl_dddddddddddddddddddddddddddddddd · 已停用 · 仅使用");

    await page.getByRole("button", { name: "确认恢复原绑定" }).click();
    await expect
      .poll(() => harness.calls.some((request) => request.action === "restoreBinding"))
      .toBe(true);
    const restoreRequest = harness.calls.find(
      (request): request is Extract<SkillEvolutionRequest, { action: "restoreBinding" }> =>
        request.action === "restoreBinding",
    );
    expect(restoreRequest).toMatchObject({
      action: "restoreBinding",
      eventId: derivedEvent.eventId,
      expertId: expert.id,
      expectedDigest: bindingRestorePreview.digest,
    });
    const operationHash = new Uint8Array(
      await globalThis.crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(
          [expert.id, derivedEvent.eventId, bindingRestorePreview.digest].join("\u0000"),
        ),
      ),
    );
    const expectedOperationId = `skill-evolution-bind-restore-${[...operationHash]
      .map((value) => value.toString(16).padStart(2, "0"))
      .join("")}`;
    expect(restoreRequest?.operationId).toBe(expectedOperationId);
    await expect
      .element(page.getByText("已恢复本专家到来源 Skill 的原绑定；专用副本保留，内容未恢复。"))
      .toBeVisible();

    await expect.poll(() => graphForTest.events.length).toBe(2);
    await page.getByRole("button", { name: /Review findings，版本 2/ }).click();
    const eventRow = page.getByRole("listitem").filter({ hasText: "恢复原绑定" });
    await expect.element(eventRow).toBeVisible();
    await expect.element(eventRow).not.toHaveTextContent(/· v\d+ ·/);
    await expect
      .element(page.getByRole("button", { name: "预览内容恢复" }))
      .not.toBeInTheDocument();
  });

  it("keeps deleted graph history selectable without opening the current Skill editor", async () => {
    graphForTest = {
      ...graphWithDerived,
      nodes: graphWithDerived.nodes.map((node) =>
        node.skillId === derivedSkillId ? { ...node, deleted: true } : node,
      ),
    };
    await page.viewport(390, 900);
    await mount();
    await page.getByRole("button", { name: "进化星图", exact: true }).click();
    await page.getByRole("button", { name: /Expert-only review copy，版本 1.*已删除/ }).click();
    await expect
      .element(page.getByText("已删除 · 历史事件仍可查看，当前 Skill 详情不可用。"))
      .toBeVisible();
    await expect
      .element(page.getByRole("button", { name: "打开当前 Skill 详情" }))
      .not.toBeInTheDocument();
    await expect.element(page.getByText(/派生专用副本 · v1/)).toBeVisible();
    await expect.element(page.getByRole("button", { name: "查看来源" })).toBeVisible();
    expect(
      harness.server.skillLibrary.mock.calls.some(([request]) => request.action === "read"),
    ).toBe(false);
  });

  it("compares restoration targets against the current Skill revision, including delete, binary, and read errors", async () => {
    graphForTest = graphWithDerived;
    await page.viewport(390, 900);
    await mount();
    await page.getByRole("button", { name: "进化星图", exact: true }).click();
    await page.getByRole("button", { name: /Expert-only review copy，版本 1/ }).click();
    await page.getByRole("button", { name: "预览内容恢复" }).click();
    await expect.element(page.getByRole("region", { name: "恢复预览" })).toBeVisible();
    const compareButtons = page.getByRole("button", {
      name: "查看当前版本 vs 恢复目标完整对照",
    });
    await compareButtons.nth(0).click();
    await expect.element(page.getByRole("heading", { name: "当前版本 v1" })).toBeVisible();
    await expect.element(page.getByRole("heading", { name: "恢复目标" })).toBeVisible();
    await expect.element(page.getByText("Current version body.")).toBeVisible();
    await expect.element(page.getByText("Restored target body.").last()).toBeVisible();
    await expect
      .poll(
        () =>
          harness.server.skillLibrary.mock.calls.filter(
            ([request]) => request.action === "readFile",
          ).length,
      )
      .toBe(1);
    const currentRead = harness.server.skillLibrary.mock.calls.find(
      ([request]) => request.action === "readFile" && request.path === "SKILL.md",
    )?.[0];
    expect(currentRead).toMatchObject({
      action: "readFile",
      skillId: derivedSkillId,
      path: "SKILL.md",
      expectedRevision: derivedSkill.revision,
    });

    await compareButtons.nth(0).click();
    await expect.element(page.getByText("Current file before deletion.")).toBeVisible();
    await expect.element(page.getByText("该路径将在目标版本中删除。")).toBeVisible();
    await compareButtons.nth(0).click();
    await expect.element(page.getByText("基础版本不可读：当前版本文件读取失败")).toBeVisible();
    await expect
      .element(page.getByText("目标版本是二进制文件，完整字节会随更改保存。"))
      .toBeVisible();
    await page.getByRole("button", { name: "恢复为新修订" }).click();
    await expect
      .poll(() => harness.calls.some((request) => request.action === "restore"))
      .toBe(true);
    const restoreRequest = harness.calls.find(
      (request): request is Extract<SkillEvolutionRequest, { action: "restore" }> =>
        request.action === "restore",
    );
    expect(restoreRequest).toMatchObject({
      action: "restore",
      eventId: derivedEvent.eventId,
      expertId: expert.id,
      expectedRevision: derivedSkill.revision,
    });
  });

  it("keeps the preview version and owner when the current graph refreshes before restoring", async () => {
    graphForTest = graphWithDerived;
    const execute = harness.server.skillEvolution.getMockImplementation()!;
    harness.server.skillEvolution.mockImplementation(async (request) => {
      if (request.action === "restore") {
        harness.calls.push(request);
        throw new Error("Skill 已改变，请重新预览恢复差异。");
      }
      return execute(request);
    });
    const client = await mount();
    await page.getByRole("button", { name: "进化星图", exact: true }).click();
    await page.getByRole("button", { name: /Expert-only review copy，版本 1/ }).click();
    await page.getByRole("button", { name: "预览内容恢复" }).click();
    await expect.element(page.getByRole("region", { name: "恢复预览" })).toBeVisible();

    graphForTest = {
      ...graphWithDerived,
      nodes: graphWithDerived.nodes.map((node) =>
        node.skillId === derivedSkillId ? Object.assign({}, node, { revision: 2 }) : node,
      ),
    };
    await client.invalidateQueries({ queryKey: [...skillEvolutionQueryKey(expert.id), "graph"] });
    await expect
      .element(page.getByRole("button", { name: /Expert-only review copy，版本 2/ }))
      .toBeVisible();
    await page.getByRole("button", { name: /恢复为新修订/ }).click();
    await expect.element(page.getByText("Skill 已改变，请重新预览恢复差异。")).toBeVisible();
    const request = harness.calls.find((item) => item.action === "restore");
    expect(request).toMatchObject({
      eventId: restorePreview.eventId,
      expectedRevision: restorePreview.skill.revision,
    });
    expect(request).not.toHaveProperty("approveProtected");
  });

  it("keeps extraction and candidate drafts while switching Expert tabs", async () => {
    harness.runs = [run()];
    await mount(null, true);
    await page.getByRole("button", { name: /已选 .* 段工作记录/ }).click();
    await page.getByRole("checkbox", { name: "选择来源：完成的复核任务" }).first().click();
    await page.getByRole("button", { name: "补充提炼重点" }).click();
    await page
      .getByRole("textbox", { name: "发现重点", exact: true })
      .fill("Keep the validation steps.");
    await openRun("request-update");
    await page.getByRole("button", { name: "编辑候选" }).click();
    await page.getByRole("textbox", { name: "候选 Skill 名称" }).fill("Unsaved review method");

    for (const name of ["能力", "设置", "任务历史"]) {
      await page.getByRole("tab", { name, exact: true }).click();
      await expect
        .element(page.getByRole("tab", { name, exact: true }))
        .toHaveAttribute("aria-selected", "true");
      await page.getByRole("tab", { name: "进化", exact: true }).click();
      await page.getByRole("button", { name: /已选 .* 段工作记录/ }).click();
      await expect
        .element(page.getByRole("checkbox", { name: "选择来源：完成的复核任务" }).first())
        .not.toBeChecked();
      await expect
        .element(page.getByRole("checkbox", { name: "选择来源：完成的复核任务" }).nth(1))
        .toBeChecked();
      await page.getByRole("button", { name: "编辑提炼重点" }).click();
      await expect
        .element(page.getByRole("textbox", { name: "发现重点", exact: true }))
        .toHaveValue("Keep the validation steps.");
      await expect
        .element(page.getByRole("textbox", { name: "候选 Skill 名称" }))
        .toHaveValue("Unsaved review method");
    }
    expect(
      harness.calls.some((request) => request.action === "start" || request.action === "edit"),
    ).toBe(false);
  });

  it("protects selected source drafts when leaving and requires an explicit discard", async () => {
    await page.viewport(390, 900);
    await mount();
    await page.getByRole("button", { name: /已选 .* 段工作记录/ }).click();
    await page.getByRole("checkbox", { name: "选择来源：完成的复核任务" }).first().click();
    await page.getByRole("link", { name: "离开进化页" }).click();
    await expect.element(page.getByRole("heading", { name: "未保存的更改" })).toBeVisible();
    await expect.element(page.getByText(/来源、重点和反馈不会自动提交/)).toBeVisible();
    await page.getByRole("button", { name: "放弃更改" }).click();
    await expect.element(page.getByText("离开后的页面")).toBeVisible();
  });

  it("protects an edited opportunity feedback draft when leaving", async () => {
    harness.runs = [discoveryRun()];
    await mount();
    await openRun("request-discovery");
    await page
      .getByRole("textbox", { name: "生成反馈：修复后复核" })
      .fill("保留证据链接和复核动作。");
    await page.getByRole("link", { name: "离开进化页" }).click();
    await expect.element(page.getByRole("heading", { name: "未保存的更改" })).toBeVisible();
    await expect.element(page.getByText(/来源、重点和反馈不会自动提交/)).toBeVisible();
    await page.getByRole("button", { name: "放弃更改" }).click();
    await expect.element(page.getByText("离开后的页面")).toBeVisible();
  });
});
