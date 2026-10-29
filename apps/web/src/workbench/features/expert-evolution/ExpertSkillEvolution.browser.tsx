import "../../../index.css";

import type {
  ExpertDefinition,
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
  runs: [] as SkillEvolutionRun[],
  startStatus: "no_change" as SkillEvolutionRun["status"],
  applyConflict: false,
  applySavedUnboundOnce: false,
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

import { ExpertSkillEvolution } from "./ExpertSkillEvolution";
import { ExpertEditor, type ExpertEditorTab } from "~/components/settings/ExpertEditor";
import { skillEvolutionQueryKey } from "./model";

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
  skillBindings: [{ skillId, enabled: true, activation: "on-demand" }],
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
  evolutionPolicy: "protected",
  scope: { kind: "shared" },
};
const graph: SkillEvolutionGraph = {
  nodes: [
    {
      skillId,
      name: skill.name,
      revision: 2,
      packageId,
      policy: "protected",
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
  evolutionPolicy: "independent",
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
  policy: "independent",
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
      policy: "independent",
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
    { skillId: derivedSkillId, enabled: true, activation: "startup" },
    { skillId: otherSkillId, enabled: false, activation: "on-demand" },
  ],
  after: [
    { skillId, enabled: true, activation: "startup" },
    { skillId: otherSkillId, enabled: false, activation: "on-demand" },
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
  policy: skill.evolutionPolicy,
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

function proposal(
  input: Partial<SkillEvolutionProposal> & { policy: SkillEvolutionProposal["policy"] },
): SkillEvolutionProposal {
  const { policy, ...overrides } = input;
  return {
    proposalId: `proposal-${policy}`,
    requestId: `request-${policy}`,
    expertId: expert.id,
    action: policy === "independent" ? "derive" : "update",
    name: `${policy} review method`,
    summary: "Add a reusable verification step.",
    evidence: [
      { threadId: "thread-alpha", messageId: "message-1", quote: "验证修复后再复核。" },
    ] as unknown as SkillEvolutionProposal["evidence"],
    baseSkillId: skillId,
    baseRevision: 2,
    basePackageId: packageId,
    policy,
    ...(policy === "shared" && !Object.hasOwn(input, "affectedExpertIds")
      ? { affectedExpertIds: [expert.id] }
      : {}),
    changes: [
      { path: "SKILL.md", content: btoa("---\nname: Review findings\n---\nCheck the outcome.\n") },
    ],
    digest: "f".repeat(64),
    status: "proposed",
    ...overrides,
  };
}

function run(input: Partial<SkillEvolutionRun> = {}): SkillEvolutionRun {
  const policy = input.proposals?.[0]?.policy ?? "protected";
  return {
    requestId: `request-${policy}`,
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
    proposals: [proposal({ policy })],
    ...input,
  };
}

let dispose: (() => Promise<void>) | undefined;

function EvolutionEditorFixture() {
  const [tab, setTab] = useState<ExpertEditorTab>("evolution");
  return (
    <ExpertEditor
      header={<h1>{expert.name}</h1>}
      history={<p>专家任务历史</p>}
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
      catalog={[]}
      catalogLoading={false}
      catalogError={null}
      onTabChange={setTab}
      onChange={() => {}}
      onOpenConnections={() => {}}
    />
  );
}

async function mount(initialThreadId: string | null = null, editor = false) {
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
              ) : (
                <ExpertSkillEvolution
                  expertId={expert.id}
                  expertName={expert.name}
                  active
                  initialThreadId={initialThreadId}
                  initialThreadRequestKey={initialThreadId ? 1 : 0}
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
  dispose = async () => {
    await view.unmount();
    client.clear();
  };
  return client;
}

beforeEach(() => {
  harness.calls = [];
  harness.runs = [];
  graphForTest = graph;
  harness.startStatus = "no_change";
  harness.applyConflict = false;
  harness.applySavedUnboundOnce = false;
  harness.server.skillEvolution.mockReset().mockImplementation(async (request) => {
    harness.calls.push(request);
    switch (request.action) {
      case "sources":
        return { sources };
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
        const next = run({
          requestId: request.requestId,
          sourceCount: request.sources.length,
          status: harness.startStatus,
          summary:
            harness.startStatus === "no_change"
              ? "没有新增的可复用方法。"
              : "所选来源无法支持结论。",
          ...(harness.startStatus === "failed" ? { error: "原生提炼任务执行失败。" } : {}),
          proposals: [],
        });
        harness.runs = [next, ...harness.runs];
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
  it("preselects one completed turn from history and starts only with the selected user model", async () => {
    await page.viewport(390, 900);
    await mount("thread-alpha");
    const firstTurn = page.getByRole("checkbox", { name: "选择来源：完成的复核任务" }).nth(0);
    const latestTurn = page.getByRole("checkbox", { name: "选择来源：完成的复核任务" }).nth(1);
    await expect.element(firstTurn).not.toBeChecked();
    await expect.element(latestTurn).toBeChecked();
    await expect
      .element(page.getByRole("combobox", { name: "目标 Skill" }))
      .toHaveTextContent("新建当前专家专用 Skill");
    await page.getByRole("button", { name: "开始提炼" }).click();
    await expect.poll(() => harness.calls.some((request) => request.action === "start")).toBe(true);
    const request = harness.calls.find((item) => item.action === "start");
    expect(request).toMatchObject({
      action: "start",
      expertId: expert.id,
      sources: [{ threadId: "thread-alpha", turnId: "turn-alpha-2" }],
      modelSelection: { provider: "pi", model: "user-selected-pi-model" },
    });
    await expect
      .element(
        page.getByText("无需提炼：没有发现值得写入的可复用方法。正式 Skill、修订和绑定不变。"),
      )
      .toBeVisible();
  });

  it("distinguishes insufficient evidence and failed runs", async () => {
    harness.startStatus = "insufficient_evidence";
    await page.viewport(390, 900);
    await mount();
    await page.getByRole("checkbox", { name: "选择来源：完成的复核任务" }).first().click();
    await page.getByRole("button", { name: "开始提炼" }).click();
    await expect
      .element(
        page.getByText("证据不足：当前来源无法支撑可复用结论。你可以补充来源后再次主动提炼。"),
      )
      .toBeVisible();
    harness.startStatus = "failed";
    await page.getByRole("checkbox", { name: "选择来源：完成的复核任务" }).nth(1).click();
    await page.getByRole("button", { name: "开始提炼" }).click();
    await expect.element(page.getByText("分析失败。原生提炼任务执行失败。")).toBeVisible();
  });

  it("lets the user choose protected update or expert-only derivation before starting", async () => {
    await page.viewport(390, 900);
    await mount();
    await page.getByRole("checkbox", { name: "选择来源：完成的复核任务" }).first().click();
    const targetSkillPicker = page.getByRole("combobox", { name: "目标 Skill" });
    await expect.element(targetSkillPicker).toHaveTextContent("Review findings");
    await expect.element(targetSkillPicker).not.toHaveTextContent("Expert-only review copy");
    await targetSkillPicker.selectOptions(skillId);
    const update = page.getByRole("radio", { name: /修改原版/ });
    const derive = page.getByRole("radio", { name: /创建本专家专用副本/ });
    await expect.element(update).toBeChecked();
    await derive.click();
    await expect.element(derive).toBeChecked();
    await page.getByRole("button", { name: "开始提炼" }).click();
    await expect.poll(() => harness.calls.some((request) => request.action === "start")).toBe(true);
    expect(harness.calls.find((request) => request.action === "start")).toMatchObject({
      action: "start",
      targetSkillId: skillId,
      protectedAction: "derive",
    });
  });

  it.each([
    ["protected", "认可并采用本次改动", true],
    ["shared", "采用到共享版本", false],
    ["independent", "创建专用副本并采用", false],
  ] as const)(
    "applies a %s proposal with digest-bound authorization",
    async (policy, label, protectedApproval) => {
      harness.runs = [run({ requestId: `request-${policy}`, proposals: [proposal({ policy })] })];
      await page.viewport(390, 900);
      await mount();
      await page.getByRole("button", { name: `request-${policy}` }).click();
      await expect
        .element(page.getByRole("article", { name: `Skill 候选：${policy} review method` }))
        .toBeVisible();
      if (policy === "shared")
        await expect.element(page.getByText("共享更新会影响：Review Expert")).toBeVisible();
      await page.getByRole("button", { name: label }).click();
      await expect
        .poll(() => harness.calls.some((request) => request.action === "apply"))
        .toBe(true);
      const apply = harness.calls.find((request) => request.action === "apply");
      expect(apply).toMatchObject({
        action: "apply",
        requestId: `request-${policy}`,
        proposalId: `proposal-${policy}`,
        expectedDigest: "f".repeat(64),
        ...(protectedApproval ? { approveProtected: true } : {}),
      });
      expect(apply && apply.action === "apply" ? apply.operationId : "").toBeTruthy();
      await expect.element(page.getByRole("heading", { name: "已采用" })).toBeVisible();
    },
  );

  it("blocks legacy shared-update candidates without a frozen affected-expert snapshot", async () => {
    const legacySharedProposal = proposal({ policy: "shared" });
    Reflect.deleteProperty(legacySharedProposal, "affectedExpertIds");
    harness.runs = [
      run({
        requestId: legacySharedProposal.requestId,
        proposals: [legacySharedProposal],
      }),
    ];
    await page.viewport(390, 900);
    await mount();
    await page.getByRole("button", { name: legacySharedProposal.requestId }).click();
    await expect
      .element(page.getByRole("alert"))
      .toHaveTextContent("此共享更新候选缺少冻结的影响专家名单，不能采用；请重新提炼。");
    await expect.element(page.getByRole("button", { name: "采用到共享版本" })).toBeDisabled();
    await expect
      .element(
        page.getByText(
          "共享更新会影响：此旧候选没有冻结影响名单，当前范围未知；请重新提炼后再采用。",
        ),
      )
      .toBeVisible();
    expect(harness.calls.some((request) => request.action === "apply")).toBe(false);
  });

  it("shows partial proposal outcomes and counts instead of the unchanged proposal_ready status", async () => {
    const appliedCandidate = proposal({ policy: "protected" });
    const pendingCandidate = proposal({
      policy: "protected",
      proposalId: "proposal-protected-pending",
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
    await page.getByRole("button", { name: appliedCandidate.requestId }).click();
    await page.getByRole("button", { name: "认可并采用本次改动" }).first().click();
    await expect.element(page.getByRole("heading", { name: "部分处理" })).toBeVisible();
    await expect
      .element(page.getByText("已采用 1 · 已拒绝 0 · 冲突 0 · 失败 0 · 待处理 1"))
      .toBeVisible();
    await expect
      .element(page.getByText("This model summary is not the terminal outcome."))
      .not.toBeInTheDocument();
  });

  it("rejects a candidate and preserves a server conflict without reporting it as applied", async () => {
    const protectedProposal = proposal({ policy: "protected" });
    harness.runs = [
      run({ requestId: protectedProposal.requestId, proposals: [protectedProposal] }),
    ];
    await page.viewport(390, 900);
    await mount();
    await page.getByRole("button", { name: protectedProposal.requestId }).click();
    await page.getByRole("button", { name: "拒绝" }).click();
    await expect
      .poll(() => harness.calls.some((request) => request.action === "reject"))
      .toBe(true);
    expect(harness.calls.find((request) => request.action === "reject")).toMatchObject({
      action: "reject",
      expectedDigest: protectedProposal.digest,
    });
    await expect.element(page.getByText("已拒绝，此候选不会写入正式 Skill。")).toBeVisible();

    harness.runs = [
      run({ requestId: "request-shared", proposals: [proposal({ policy: "shared" })] }),
    ];
    harness.applyConflict = true;
    await dispose?.();
    dispose = undefined;
    await mount();
    await page.getByRole("button", { name: "request-shared" }).click();
    await page.getByRole("button", { name: "采用到共享版本" }).click();
    await expect
      .element(page.getByText("目标版本或绑定已变化；候选已保留，请基于最新配置重新提炼。"))
      .toBeVisible();
    expect(page.getByRole("heading", { name: "已采用" })).not.toBeInTheDocument();
  });

  it("reuses the same operation ID when continuing a saved but unbound derivation", async () => {
    const independentProposal = proposal({ policy: "independent" });
    harness.runs = [
      run({ requestId: independentProposal.requestId, proposals: [independentProposal] }),
    ];
    harness.applySavedUnboundOnce = true;
    await page.viewport(390, 900);
    await mount();
    await page.getByRole("button", { name: independentProposal.requestId }).click();
    await page.getByRole("button", { name: "创建专用副本并采用" }).click();
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
    const protectedProposal = proposal({ policy: "protected" });
    harness.runs = [
      run({ requestId: protectedProposal.requestId, proposals: [protectedProposal] }),
    ];
    await page.viewport(390, 900);
    await mount();
    await page.getByRole("button", { name: protectedProposal.requestId }).click();
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
      await page.viewport(width, 900);
      await mount();
      const parent = page.getByTestId("_chat-flex-parent");
      await expect
        .poll(() => {
          const element = parent.element();
          return element.scrollWidth <= element.clientWidth + 1;
        })
        .toBe(true);
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
      .toHaveTextContent("Expert-only review copy · 已启用 · 启动时激活");
    await expect
      .element(page.getByTestId(`恢复后绑定:${skillId}`))
      .toHaveTextContent("Review findings · 已启用 · 启动时激活");
    await expect
      .element(page.getByTestId(`恢复后绑定:${otherSkillId}`))
      .toHaveTextContent("skl_dddddddddddddddddddddddddddddddd · 已停用 · 按需激活");

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
      expectedAffectedExpertIds: [expert.id, "other-expert"],
    });
  });

  it("keeps the preview version and policy when the current graph refreshes before restoring", async () => {
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
    await page.getByRole("button", { name: /Expert-only review copy，版本 1/ }).click();
    await page.getByRole("button", { name: "预览内容恢复" }).click();
    await expect.element(page.getByRole("region", { name: "恢复预览" })).toBeVisible();

    graphForTest = {
      ...graphWithDerived,
      nodes: graphWithDerived.nodes.map((node) =>
        node.skillId === derivedSkillId
          ? Object.assign({}, node, { revision: 2, policy: "protected" as const })
          : node,
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
      expectedAffectedExpertIds: restorePreview.affectedExpertIds,
    });
    expect(request).not.toHaveProperty("approveProtected");
  });

  it("keeps extraction and candidate drafts while switching Expert tabs", async () => {
    harness.runs = [run()];
    await mount(null, true);
    await page.getByRole("checkbox", { name: "选择来源：完成的复核任务" }).first().click();
    await page
      .getByRole("textbox", { name: "提炼重点", exact: true })
      .fill("Keep the validation steps.");
    await page.getByRole("button", { name: "request-protected" }).click();
    await page.getByRole("button", { name: "编辑候选" }).click();
    await page.getByRole("textbox", { name: "候选 Skill 名称" }).fill("Unsaved review method");

    for (const name of ["能力", "设置", "任务历史"]) {
      await page.getByRole("tab", { name, exact: true }).click();
      await expect
        .element(page.getByRole("tab", { name, exact: true }))
        .toHaveAttribute("aria-selected", "true");
      await page.getByRole("tab", { name: "进化", exact: true }).click();
      await expect
        .element(page.getByRole("checkbox", { name: "选择来源：完成的复核任务" }).first())
        .toBeChecked();
      await expect
        .element(page.getByRole("textbox", { name: "提炼重点", exact: true }))
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
    await page.getByRole("checkbox", { name: "选择来源：完成的复核任务" }).first().click();
    await page.getByRole("link", { name: "离开进化页" }).click();
    await expect.element(page.getByRole("heading", { name: "未保存的更改" })).toBeVisible();
    await expect.element(page.getByText(/来源选择和提炼重点不会自动提交/)).toBeVisible();
    await page.getByRole("button", { name: "放弃更改" }).click();
    await expect.element(page.getByText("离开后的页面")).toBeVisible();
  });
});
