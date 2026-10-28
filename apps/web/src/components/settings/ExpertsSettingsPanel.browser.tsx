import "../../index.css";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
  useParams,
} from "@tanstack/react-router";
import { page } from "vitest/browser";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import type {
  HubTeamPreset,
  SkillDefinition,
  SkillPackage,
  SkillPackagePreview,
} from "@synara/contracts";

const harness = vi.hoisted(() => {
  const makeExpert = (overrides: Record<string, unknown> = {}) => ({
    id: "planner",
    name: "规划专家",
    description: "帮助规划任务",
    useCases: "方案梳理",
    persona: "先澄清目标",
    outputRequirements: "给出步骤和依据",
    skills: [],
    references: [],
    connections: [],
    preferredProvider: "codex",
    revision: 7,
    archived: false,
    updatedAt: "2026-10-03T00:00:00.000Z",
    ...overrides,
  });
  const makeSkillPackage = (
    version: string,
    entryPath: string,
    userInvocable?: boolean,
  ): SkillPackage => ({
    schemaVersion: 1 as const,
    packageId: `pkg_${version.repeat(64)}`,
    rootName: "planner-skills",
    resources: [],
    entries: [
      {
        entryPath,
        name: "Planner",
        description: "Plan work in small steps.",
        issues: [],
        ...(userInvocable === undefined ? {} : { userInvocable }),
      },
    ],
    fileCount: 1,
    totalBytes: 100,
  });
  const importedSkillPackage = makeSkillPackage("c", "SKILL.md");
  const data = {
    experts: [makeExpert()],
    teams: [] as Array<Record<string, unknown>>,
    skillPackages: [
      makeSkillPackage("a", "planner/SKILL.md"),
      makeSkillPackage("b", "planner/v2/SKILL.md", false),
    ],
    connections: [
      {
        id: "linear",
        name: "Linear 工作区",
        transport: {
          type: "stdio" as const,
          command: "npx",
          args: ["-y", "linear-mcp"],
          envFromHost: [],
        },
        revision: 3,
        updatedAt: "2026-10-03T00:00:00.000Z",
      },
    ],
    connectionState: "active" as "active" | "disabled" | "retired",
    skills: [
      {
        name: "synara:planning",
        description: "规划与拆解任务",
        path: "/skills/planning/SKILL.md",
        enabled: true,
        scope: "synara",
        interface: { displayName: "Planning framework" },
      },
      {
        name: "codex:review",
        description: "Review changes",
        path: "/skills/review/SKILL.md",
        enabled: true,
        scope: "codex",
      },
    ],
  };
  const server = {
    skillLibrary: vi.fn(async (): Promise<{ skills: SkillDefinition[] }> => ({ skills: [] })),
    listExperts: vi.fn(async () => data.experts),
    listSkillPackages: vi.fn(async () => data.skillPackages),
    listExpertConnections: vi.fn(async () => data.connections),
    getExpertConnectionState: vi.fn(async ({ id }: { id: string }) => ({
      id,
      status: data.connectionState,
      revision: 2,
      updatedAt: "2026-10-03T00:00:00.000Z",
    })),
    saveExpert: vi.fn(async (input: Record<string, unknown>) => {
      const id = typeof input.id === "string" ? input.id : "created-expert";
      const previous = data.experts.find((expert) => expert.id === id);
      const { expectedRevision: _expectedRevision, ...fields } = input;
      const saved = {
        ...(previous ?? makeExpert({ id, name: "" })),
        ...fields,
        id,
        revision: (previous?.revision ?? 0) + 1,
        archived: false,
        updatedAt: "2026-10-03T00:01:00.000Z",
      };
      data.experts = [saved, ...data.experts.filter((expert) => expert.id !== id)];
      return saved;
    }),
    archiveExpert: vi.fn(async ({ id }: { id: string }) => {
      const previous = data.experts.find((expert) => expert.id === id) ?? makeExpert({ id });
      const saved = { ...previous, archived: true, revision: previous.revision + 1 };
      data.experts = data.experts.map((expert) => (expert.id === id ? saved : expert));
      return saved;
    }),
    restoreExpert: vi.fn(async ({ id }: { id: string }) => {
      const previous = data.experts.find((expert) => expert.id === id) ?? makeExpert({ id });
      const saved = { ...previous, archived: false, revision: previous.revision + 1 };
      data.experts = data.experts.map((expert) => (expert.id === id ? saved : expert));
      return saved;
    }),
    deleteExpert: vi.fn(async ({ id }: { id: string }) => {
      data.experts = data.experts.filter((expert) => expert.id !== id);
    }),
    previewExpert: vi.fn(async ({ expertId }: { expertId: string }) => {
      const definition = data.experts.find((expert) => expert.id === expertId) ?? makeExpert();
      return { definition, status: "available" as const, issues: [] };
    }),
    readSkillPackage: vi.fn(async ({ packageId }: { packageId: string }) => {
      const pkg = data.skillPackages.find((item) => item.packageId === packageId);
      if (!pkg) throw new Error(`Unknown skill package: ${packageId}`);
      return pkg;
    }),
    previewSkillPackage: vi.fn(
      async ({ path }: { path: string }): Promise<SkillPackagePreview> => ({
        previewId: `preview-${path}`,
        sourcePath: path,
        realRoot: path,
        expiresAt: "2026-10-22T00:00:00.000Z",
        package: importedSkillPackage,
        issues: [],
      }),
    ),
    importSkillPackage: vi.fn(async ({ previewId: _previewId }: { previewId: string }) => {
      if (!data.skillPackages.some((item) => item.packageId === importedSkillPackage.packageId))
        data.skillPackages = [...data.skillPackages, importedSkillPackage];
      return {
        package: importedSkillPackage,
        source: {
          sourceId: `src_${"c".repeat(64)}`,
          sourcePath: "/manual/planning",
          realRoot: "/manual/planning",
          packageId: importedSkillPackage.packageId,
          revision: 1,
          importedAt: "2026-10-22T00:00:00.000Z",
        },
        reused: false,
      };
    }),
    readExpertSnapshot: vi.fn(async () => null),
    readExpertAppliedRuntime: vi.fn(async () => null),
    testExpertConnection: vi.fn(async () => ({ tools: [] as string[] })),
  };
  const hubTeams = {
    list: vi.fn(async () => data.teams),
    read: vi.fn(async () => null),
    save: vi.fn(async (input: Record<string, unknown>) => {
      const existing = data.teams.find((team) => team.id === input.id);
      const saved = {
        ...input,
        revision: (typeof existing?.revision === "number" ? existing.revision : 0) + 1,
        createdAt:
          typeof existing?.createdAt === "string" ? existing.createdAt : "2026-10-22T00:00:00.000Z",
        updatedAt: "2026-10-22T00:01:00.000Z",
        archivedAt: null as string | null,
      };
      data.teams = [saved, ...data.teams.filter((team) => team.id !== input.id)];
      return saved;
    }),
    setArchived: vi.fn(async (input: { id: string; archived: boolean }) => {
      const existing = data.teams.find((team) => team.id === input.id) ?? {};
      const saved = {
        ...existing,
        revision: (typeof existing.revision === "number" ? existing.revision : 0) + 1,
        updatedAt: "2026-10-22T00:01:00.000Z",
        archivedAt: input.archived ? "2026-10-22T00:01:00.000Z" : null,
      };
      data.teams = data.teams.map((team) => (team.id === input.id ? saved : team));
      return saved;
    }),
  };
  return { data, makeExpert, makeSkillPackage, server, hubTeams };
});

vi.mock("~/nativeApi", () => ({
  ensureNativeApi: () => ({ server: harness.server, hubTeams: harness.hubTeams }),
  readNativeApiServerCapabilityState: () => "supported",
}));
vi.mock("~/hooks/useNativeApiServerCapability", () => ({
  useNativeApiServerCapabilitySnapshot: () => ({
    generation: "experts-settings-browser",
    connected: true,
    capability: "supported",
    api: undefined,
  }),
}));
vi.mock("~/lib/providerDiscoveryReactQuery", () => ({
  skillsCatalogQueryOptions: ({ enabled }: { enabled: boolean }) => ({
    queryKey: ["test", "skillsCatalog"],
    queryFn: async () => ({ skills: harness.data.skills }),
    enabled,
  }),
}));

import { ExpertsSettingsPanel } from "./ExpertsSettingsPanel";
import { ExpertTaskControl } from "../chat/ExpertTaskControl";
import { EXPERTS_QUERY_KEY } from "./expertSettingsQueries";

async function mountPanel(initialEntry = "/settings") {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  let router: ReturnType<typeof createRouter>;
  const root = createRootRoute({
    component: () => (
      <QueryClientProvider client={queryClient}>
        <Outlet />
      </QueryClientProvider>
    ),
  });
  const settings = createRoute({
    getParentRoute: () => root,
    path: "/settings",
    component: () => {
      const search = settings.useSearch() as Record<string, unknown>;
      return (
        <ExpertsSettingsPanel
          {...(typeof search.expertId === "string" ? { initialExpertId: search.expertId } : {})}
          onOpenConnections={(expertId, connectionId) => {
            void router.navigate({
              to: "/connections" as never,
              search: { expertId, ...(connectionId ? { connectionId } : {}) } as never,
            } as never);
          }}
        />
      );
    },
  });
  const connections = createRoute({
    getParentRoute: () => root,
    path: "/connections",
    component: () => <p>连接设置页面</p>,
  });
  router = createRouter({
    routeTree: root.addChildren([settings, connections]),
    history: createMemoryHistory({ initialEntries: [initialEntry] }),
  });
  const view = await render(<RouterProvider router={router} />);
  return {
    queryClient,
    router,
    close: async () => {
      await view.unmount();
      queryClient.clear();
    },
  };
}

async function mountCenter(initialEntry = "/experts/planner?tab=capabilities") {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const onUseExpert = vi.fn(async (_expertId: string) => {});
  const root = createRootRoute({
    component: () => (
      <QueryClientProvider client={queryClient}>
        <Outlet />
      </QueryClientProvider>
    ),
  });
  let router: ReturnType<typeof createRouter>;
  const center = createRoute({
    getParentRoute: () => root,
    path: "/experts",
    component: () => {
      const params = useParams({ strict: false });
      const search = center.useSearch() as { tab?: "capabilities" | "settings" | "history" };
      return (
        <ExpertsSettingsPanel
          centerRoute={{
            expertId: params.expertId ?? null,
            tab: search.tab ?? "capabilities",
            navigate: async (expertId, tab, replace) => {
              await router.navigate({
                to: (expertId ? "/experts/$expertId" : "/experts") as never,
                params: { expertId } as never,
                search: { tab } as never,
                ...(replace === undefined ? {} : { replace }),
              });
            },
          }}
          renderHistory={(expertId) => <p>任务历史 {expertId}</p>}
          onUseExpert={onUseExpert}
        />
      );
    },
  });
  const list = createRoute({ getParentRoute: () => center, path: "/" });
  const detail = createRoute({ getParentRoute: () => center, path: "$expertId" });
  const outside = createRoute({
    getParentRoute: () => root,
    path: "/outside",
    component: () => <p>其他页面</p>,
  });
  router = createRouter({
    routeTree: root.addChildren([center.addChildren([list, detail]), outside]),
    history: createMemoryHistory({ initialEntries: [initialEntry] }),
  });
  const view = await render(<RouterProvider router={router} />);
  return {
    router,
    queryClient,
    onUseExpert,
    close: async () => {
      await view.unmount();
      queryClient.clear();
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

async function selectRoutedExpert(router: ReturnType<typeof createRouter>, expertId: string) {
  await router.navigate({
    to: "/settings" as never,
    search: { expertId } as never,
  } as never);
}

function makeHubTeam(overrides: Partial<HubTeamPreset> = {}): HubTeamPreset {
  return {
    id: "team-research",
    name: "研究协作团",
    purpose: "研究与写作",
    expertIds: ["planner"],
    coordinatorInstructions: "先澄清问题",
    collaborationPreferences: "需要时交叉评审",
    revision: 4,
    createdAt: "2026-10-20T00:00:00.000Z",
    updatedAt: "2026-10-21T00:00:00.000Z",
    archivedAt: null,
    ...overrides,
  };
}

function resetHubTeamsHarness() {
  harness.data.teams = [];
  for (const operation of Object.values(harness.hubTeams)) operation.mockReset();
  harness.hubTeams.list.mockImplementation(async () => harness.data.teams);
  harness.hubTeams.save.mockImplementation(async (input: Record<string, unknown>) => {
    const existing = harness.data.teams.find((team) => team.id === input.id);
    const saved = {
      ...input,
      revision: (typeof existing?.revision === "number" ? existing.revision : 0) + 1,
      createdAt:
        typeof existing?.createdAt === "string" ? existing.createdAt : "2026-10-22T00:00:00.000Z",
      updatedAt: "2026-10-22T00:01:00.000Z",
      archivedAt: null as string | null,
    };
    harness.data.teams = [saved, ...harness.data.teams.filter((team) => team.id !== input.id)];
    return saved;
  });
  harness.hubTeams.setArchived.mockImplementation(
    async (input: { id: string; archived: boolean }) => {
      const existing = harness.data.teams.find((team) => team.id === input.id) ?? {};
      const saved = {
        ...existing,
        revision: (typeof existing.revision === "number" ? existing.revision : 0) + 1,
        updatedAt: "2026-10-22T00:01:00.000Z",
        archivedAt: input.archived ? "2026-10-22T00:01:00.000Z" : null,
      };
      harness.data.teams = harness.data.teams.map((team) => (team.id === input.id ? saved : team));
      return saved;
    },
  );
}

beforeEach(() => {
  harness.data.experts = [harness.makeExpert()];
  harness.data.skillPackages = [
    harness.makeSkillPackage("a", "planner/SKILL.md"),
    harness.makeSkillPackage("b", "planner/v2/SKILL.md", false),
  ];
  for (const operation of Object.values(harness.server)) operation.mockReset();
  resetHubTeamsHarness();
  harness.server.skillLibrary.mockResolvedValue({ skills: [] });
  harness.server.listExperts.mockImplementation(async () => harness.data.experts);
  harness.server.listSkillPackages.mockImplementation(async () => harness.data.skillPackages);
  harness.server.readSkillPackage.mockImplementation(
    async ({ packageId }: { packageId: string }) => {
      const pkg = harness.data.skillPackages.find((item) => item.packageId === packageId);
      if (!pkg) throw new Error(`Unknown skill package: ${packageId}`);
      return pkg;
    },
  );
  harness.server.previewSkillPackage.mockImplementation(
    async ({ path }: { path: string }): Promise<SkillPackagePreview> => ({
      previewId: `preview-${path}`,
      sourcePath: path,
      realRoot: path,
      expiresAt: "2026-10-22T00:00:00.000Z",
      package: {
        schemaVersion: 1,
        packageId: `pkg_${"c".repeat(64)}`,
        rootName: "imported-skills",
        resources: [],
        entries: [
          {
            entryPath: "SKILL.md",
            name: "Imported skill",
            description: "Imported for the Expert draft.",
            issues: [],
          },
        ],
        fileCount: 1,
        totalBytes: 10,
      },
      issues: [],
    }),
  );
  harness.server.importSkillPackage.mockImplementation(async () => {
    const imported: SkillPackage = {
      schemaVersion: 1,
      packageId: `pkg_${"c".repeat(64)}`,
      rootName: "imported-skills",
      resources: [],
      entries: [
        {
          entryPath: "SKILL.md",
          name: "Imported skill",
          description: "Imported for the Expert draft.",
          issues: [],
        },
      ],
      fileCount: 1,
      totalBytes: 10,
    };
    if (!harness.data.skillPackages.some((item) => item.packageId === imported.packageId))
      harness.data.skillPackages = [...harness.data.skillPackages, imported];
    return {
      package: imported,
      source: {
        sourceId: `src_${"c".repeat(64)}`,
        sourcePath: "/manual/planning",
        realRoot: "/manual/planning",
        packageId: imported.packageId,
        revision: 1,
        importedAt: "2026-10-22T00:00:00.000Z",
      },
      reused: false,
    };
  });
  harness.server.listExpertConnections.mockImplementation(async () => harness.data.connections);
  harness.data.connectionState = "active";
  harness.server.getExpertConnectionState.mockImplementation(async ({ id }: { id: string }) => ({
    id,
    status: harness.data.connectionState,
    revision: 2,
    updatedAt: "2026-10-03T00:00:00.000Z",
  }));
  harness.server.saveExpert.mockImplementation(async (input: Record<string, unknown>) => {
    const id = typeof input.id === "string" ? input.id : "created-expert";
    const previous = harness.data.experts.find((expert) => expert.id === id);
    const { expectedRevision: _expectedRevision, ...fields } = input;
    const saved = {
      ...(previous ?? harness.makeExpert({ id, name: "" })),
      ...fields,
      id,
      revision: (previous?.revision ?? 0) + 1,
      archived: false,
      updatedAt: "2026-10-03T00:01:00.000Z",
    };
    harness.data.experts = [saved, ...harness.data.experts.filter((expert) => expert.id !== id)];
    return saved;
  });
  harness.server.archiveExpert.mockImplementation(async ({ id }: { id: string }) => {
    const previous =
      harness.data.experts.find((expert) => expert.id === id) ?? harness.makeExpert({ id });
    const saved = { ...previous, archived: true, revision: previous.revision + 1 };
    harness.data.experts = harness.data.experts.map((expert) =>
      expert.id === id ? saved : expert,
    );
    return saved;
  });
  harness.server.restoreExpert.mockImplementation(async ({ id }: { id: string }) => {
    const previous =
      harness.data.experts.find((expert) => expert.id === id) ?? harness.makeExpert({ id });
    const saved = { ...previous, archived: false, revision: previous.revision + 1 };
    harness.data.experts = harness.data.experts.map((expert) =>
      expert.id === id ? saved : expert,
    );
    return saved;
  });
  harness.server.deleteExpert.mockImplementation(async ({ id }: { id: string }) => {
    harness.data.experts = harness.data.experts.filter((expert) => expert.id !== id);
  });
  harness.server.previewExpert.mockImplementation(async ({ expertId }: { expertId: string }) => ({
    definition:
      harness.data.experts.find((expert) => expert.id === expertId) ?? harness.makeExpert(),
    status: "available" as const,
    issues: [],
  }));
});

describe("ExpertsSettingsPanel browser interactions", () => {
  it("retains a team draft after a CAS save error and retries with its baseline revision", async () => {
    harness.data.teams = [makeHubTeam()];
    const { close } = await mountPanel("/settings");
    try {
      await page.getByRole("radio", { name: "专家团" }).click();
      await page.getByRole("button", { name: "编辑" }).click();
      const purpose = page.getByLabelText("专家团用途");
      await purpose.fill("updated purpose");
      harness.hubTeams.save.mockRejectedValueOnce(new Error("revision conflict"));

      await page.getByRole("button", { name: "保存专家团" }).click();
      await expect.element(page.getByRole("alert")).toHaveTextContent("revision conflict");
      await expect.element(purpose).toHaveValue("updated purpose");
      expect(harness.hubTeams.save.mock.calls[0]?.[0]).toMatchObject({
        id: "team-research",
        expectedRevision: 4,
      });

      await page.getByRole("button", { name: "保存专家团" }).click();
      await expect.poll(() => harness.hubTeams.save.mock.calls.length).toBe(2);
      expect(harness.hubTeams.save.mock.calls[1]?.[0]).toMatchObject({
        id: "team-research",
        expectedRevision: 4,
        purpose: "updated purpose",
      });
    } finally {
      await close();
    }
  });

  it("guards route departure while a team save is pending", async () => {
    const { close, router } = await mountPanel("/settings");
    try {
      await page.getByRole("radio", { name: "专家团" }).click();
      await page.getByRole("button", { name: "新建专家团" }).click();
      await page.getByLabelText("专家团名称").fill("新团队");
      await page.getByRole("checkbox", { name: "规划专家" }).click();

      const pending = deferred<HubTeamPreset>();
      harness.hubTeams.save.mockImplementationOnce(() => pending.promise);
      const navigation = router.navigate({ to: "/connections" as never } as never);
      await expect.element(page.getByRole("heading", { name: "未保存的更改" })).toBeVisible();
      await page.getByRole("button", { name: "保存并继续" }).click();
      await expect.poll(() => harness.hubTeams.save.mock.calls.length).toBe(1);
      expect(router.state.location.pathname).toBe("/settings");

      const input = harness.hubTeams.save.mock.calls[0]?.[0] as Record<string, unknown>;
      pending.resolve(
        makeHubTeam({
          id: input.id as string,
          name: input.name as string,
          purpose: input.purpose as string,
          expertIds: input.expertIds as string[],
          revision: 1,
        }),
      );
      await navigation;
      expect(router.state.location.pathname).toBe("/connections");
    } finally {
      await close();
    }
  });

  it("archives and restores team presets with revisioned actions", async () => {
    harness.data.teams = [makeHubTeam()];
    const { close } = await mountPanel("/settings");
    try {
      await page.getByRole("radio", { name: "专家团" }).click();
      await page.getByRole("button", { name: "归档", exact: true }).click();
      await page.getByRole("button", { name: "确认归档" }).click();
      await expect.poll(() => harness.hubTeams.setArchived.mock.calls.length).toBe(1);
      expect(harness.hubTeams.setArchived.mock.calls[0]?.[0]).toMatchObject({
        id: "team-research",
        expectedRevision: 4,
        archived: true,
      });

      await page.getByRole("button", { name: "查看已归档" }).click();
      await page.getByRole("button", { name: "恢复" }).click();
      await page.getByRole("button", { name: "确认恢复" }).click();
      await expect.poll(() => harness.hubTeams.setArchived.mock.calls.length).toBe(2);
      expect(harness.hubTeams.setArchived.mock.calls[1]?.[0]).toMatchObject({
        id: "team-research",
        expectedRevision: 5,
        archived: false,
      });
      await page.getByRole("button", { name: "返回专家团" }).click();
      await expect.element(page.getByText("研究协作团")).toBeInTheDocument();
    } finally {
      await close();
    }
  });

  it("offers Claude and Oh My Pi as expert preferred providers", async () => {
    const { close } = await mountPanel("/settings?expertId=planner");
    await page.getByRole("tab", { name: "设置", exact: true }).click();
    const provider = page.getByRole("combobox", { name: "专家首选 Provider", exact: true });

    for (const [providerId, displayName] of [
      ["claudeAgent", "Claude"],
      ["omp", "Oh My Pi"],
    ] as const) {
      await provider.click();
      await page.getByRole("option", { name: displayName, exact: true }).click();
      await expect.element(provider).toHaveTextContent(displayName);
      await page.getByRole("button", { name: "保存更改", exact: true }).click();
      await expect
        .poll(() => harness.server.saveExpert.mock.calls.length)
        .toBe(providerId === "claudeAgent" ? 1 : 2);
      expect(harness.server.saveExpert.mock.calls.at(-1)?.[0]).toMatchObject({
        preferredProvider: providerId,
      });
    }

    await close();
  });

  it("grows compact instructions with content and preserves independent fields across tabs and save", async () => {
    const { close } = await mountPanel("/settings?expertId=planner");
    const persona = page.getByRole("textbox", { name: "专家角色与工作方式" });
    await expect.element(persona).toHaveValue("先澄清目标");
    const textarea = document.querySelector<HTMLTextAreaElement>(
      '[aria-label="专家角色与工作方式"]',
    )!;
    const shortHeight = textarea.getBoundingClientRect().height;
    const instructions = Array.from(
      { length: 12 },
      (_, index) => `第 ${index + 1} 步：确认依据`,
    ).join("\n");
    await persona.fill(instructions);
    await expect.poll(() => textarea.getBoundingClientRect().height).toBeGreaterThan(shortHeight);
    await expect
      .element(page.getByRole("textbox", { name: "专家输出要求" }))
      .toHaveValue("给出步骤和依据");
    await persona.fill("先澄清目标，再判断依据");
    await expect.poll(() => textarea.getBoundingClientRect().height).toBe(shortHeight);
    await page.getByRole("tab", { name: "设置", exact: true }).click();
    await expect.element(page.getByRole("region", { name: "基本信息", exact: true })).toBeVisible();
    await expect
      .element(
        page
          .getByRole("region", { name: "运行配置", exact: true })
          .getByRole("combobox", { name: "专家首选 Provider" }),
      )
      .toHaveTextContent("Codex");
    await page.getByRole("textbox", { name: "专家描述" }).fill("帮助团队形成决策");
    await page.getByRole("textbox", { name: "专家使用场景" }).fill("方案比较、需求分析");
    expect(harness.server.saveExpert).not.toHaveBeenCalled();
    await page.getByRole("button", { name: "保存更改", exact: true }).click();
    await expect.poll(() => harness.server.saveExpert.mock.calls.length).toBe(1);
    expect(harness.server.saveExpert).toHaveBeenCalledWith(
      expect.objectContaining({
        description: "帮助团队形成决策",
        useCases: "方案比较、需求分析",
        persona: "先澄清目标，再判断依据",
        outputRequirements: "给出步骤和依据",
        preferredProvider: "codex",
      }),
    );
    await page.getByRole("tab", { name: "能力", exact: true }).click();
    await expect.element(persona).toHaveValue("先澄清目标，再判断依据");
    await close();
  });

  it("keeps a long summary on one line with its full text available on hover", async () => {
    const description = "完整的专家摘要".repeat(60);
    harness.data.experts = [harness.makeExpert({ description })];
    const { close } = await mountPanel();
    await expect
      .element(page.getByRole("button", { name: "编辑专家 规划专家", exact: true }))
      .toBeVisible();
    const summary = document.querySelector<HTMLElement>("span[title]");
    expect(summary?.title).toBe(description);
    expect(summary!.scrollWidth).toBeGreaterThan(summary!.clientWidth);
    const range = document.createRange();
    range.selectNodeContents(summary!);
    expect(new Set(Array.from(range.getClientRects(), (rect) => Math.round(rect.top))).size).toBe(
      1,
    );
    await close();
  });

  it("converts a legacy path into a package selection only after Apply", async () => {
    harness.data.experts = [
      harness.makeExpert({
        skills: [{ name: "synara:planning", path: "/skills/planning/SKILL.md" }],
      }),
    ];
    const { close } = await mountPanel("/settings?expertId=planner");
    await expect
      .element(page.getByRole("button", { name: "查看技能 synara:planning", exact: true }))
      .toBeVisible();
    await page.getByRole("button", { name: "添加技能", exact: true }).click();
    const catalogSkill = page.getByRole("checkbox", {
      name: "Planning framework",
      exact: true,
    });
    await expect.element(catalogSkill).toBeChecked();
    await page.getByRole("button", { name: "取消", exact: true }).click();
    expect(harness.server.importSkillPackage).not.toHaveBeenCalled();
    expect(harness.server.saveExpert).not.toHaveBeenCalled();
    await expect
      .element(page.getByRole("button", { name: "查看技能 synara:planning", exact: true }))
      .toBeVisible();

    await page.getByRole("button", { name: "添加技能", exact: true }).click();
    await expect
      .element(page.getByRole("checkbox", { name: "Planning framework", exact: true }))
      .toBeChecked();
    await page.getByRole("button", { name: "应用选择（1）", exact: true }).click();
    await expect
      .element(page.getByRole("button", { name: "查看技能 Imported skill", exact: true }))
      .toBeVisible();
    expect(harness.server.previewSkillPackage).toHaveBeenCalledWith({
      path: "/skills/planning/SKILL.md",
    });
    expect(harness.server.importSkillPackage).toHaveBeenCalledTimes(1);
    expect(harness.server.saveExpert).not.toHaveBeenCalled();
    await close();
  });

  it("drops a pending path preview when the route switches to another Expert", async () => {
    const reviewer = harness.makeExpert({ id: "reviewer", name: "评审专家" });
    harness.data.experts = [harness.makeExpert(), reviewer];
    const latePreview = deferred<SkillPackagePreview>();
    harness.server.previewSkillPackage.mockReturnValueOnce(latePreview.promise);
    const { close, router } = await mountPanel("/settings?expertId=planner");
    await page.getByRole("button", { name: "添加技能", exact: true }).click();
    await page.getByRole("radio", { name: "按路径", exact: true }).click();
    await page
      .getByRole("textbox", { name: "新技能路径", exact: true })
      .fill("/late/planner/SKILL.md");
    await page.getByRole("button", { name: "读取技能", exact: true }).click();
    await expect.poll(() => harness.server.previewSkillPackage.mock.calls.length).toBe(1);

    await selectRoutedExpert(router, "reviewer");
    await expect
      .element(page.getByRole("heading", { name: "评审专家", exact: true }))
      .toBeVisible();
    latePreview.resolve({
      previewId: "late-preview",
      sourcePath: "/late/planner/SKILL.md",
      realRoot: "/late/planner",
      expiresAt: "2026-10-22T00:00:00.000Z",
      package: harness.makeSkillPackage("c", "SKILL.md"),
      issues: [],
    });
    await latePreview.promise;

    await expect.element(page.getByRole("heading", { name: "技能 0", exact: true })).toBeVisible();
    expect(harness.server.importSkillPackage).not.toHaveBeenCalled();
    expect(harness.server.saveExpert).not.toHaveBeenCalled();
    await close();
  });

  it("does not apply an import response to a different Expert selected while Apply is pending", async () => {
    const reviewer = harness.makeExpert({ id: "reviewer", name: "评审专家" });
    harness.data.experts = [harness.makeExpert(), reviewer];
    const pendingImport = deferred<Awaited<ReturnType<typeof harness.server.importSkillPackage>>>();
    harness.server.importSkillPackage.mockReturnValueOnce(pendingImport.promise);
    const { close, router } = await mountPanel("/settings?expertId=planner");
    await page.getByRole("button", { name: "添加技能", exact: true }).click();
    await page.getByRole("radio", { name: "按路径", exact: true }).click();
    await page
      .getByRole("textbox", { name: "新技能路径", exact: true })
      .fill("/late/planner/SKILL.md");
    await page.getByRole("button", { name: "读取技能", exact: true }).click();
    await expect
      .element(page.getByRole("checkbox", { name: "Imported skill", exact: true }))
      .toBeChecked();
    await page.getByRole("button", { name: "应用选择（1）", exact: true }).click();
    await expect.poll(() => harness.server.importSkillPackage.mock.calls.length).toBe(1);

    await selectRoutedExpert(router, "reviewer");
    await expect
      .element(page.getByRole("heading", { name: "评审专家", exact: true }))
      .toBeVisible();
    const imported = harness.makeSkillPackage("c", "SKILL.md");
    harness.data.skillPackages = [...harness.data.skillPackages, imported];
    pendingImport.resolve({
      package: imported,
      source: {
        sourceId: `src_${"c".repeat(64)}`,
        sourcePath: "/late/planner",
        realRoot: "/late/planner",
        packageId: imported.packageId,
        revision: 1,
        importedAt: "2026-10-22T00:00:00.000Z",
      },
      reused: false,
    });
    await pendingImport.promise;

    await expect.element(page.getByRole("heading", { name: "技能 0", exact: true })).toBeVisible();
    expect(harness.server.saveExpert).not.toHaveBeenCalled();
    await close();
  });

  it("invalidates a pending skill Apply when the selected Expert receives a newer revision", async () => {
    const pendingImport = deferred<Awaited<ReturnType<typeof harness.server.importSkillPackage>>>();
    harness.server.importSkillPackage.mockReturnValueOnce(pendingImport.promise);
    const { close, queryClient } = await mountPanel("/settings?expertId=planner");
    await page.getByRole("button", { name: "添加技能", exact: true }).click();
    await page.getByRole("radio", { name: "按路径", exact: true }).click();
    await page
      .getByRole("textbox", { name: "新技能路径", exact: true })
      .fill("/late/planner/SKILL.md");
    await page.getByRole("button", { name: "读取技能", exact: true }).click();
    await expect
      .element(page.getByRole("checkbox", { name: "Imported skill", exact: true }))
      .toBeChecked();
    await page.getByRole("button", { name: "应用选择（1）", exact: true }).click();
    await expect.poll(() => harness.server.importSkillPackage.mock.calls.length).toBe(1);

    const latest = harness.makeExpert({ revision: 8, description: "来自服务端的新版本" });
    harness.data.experts = [latest];
    queryClient.setQueryData(EXPERTS_QUERY_KEY, [latest]);
    await expect.element(page.getByText("v8", { exact: true })).toBeVisible();
    await expect.element(page.getByRole("dialog", { name: /添加技能至/u })).not.toBeInTheDocument();

    const imported: SkillPackage = {
      schemaVersion: 1,
      packageId: `pkg_${"c".repeat(64)}`,
      rootName: "imported-skills",
      resources: [],
      entries: [
        {
          entryPath: "SKILL.md",
          name: "Imported skill",
          description: "Imported for the Expert draft.",
          issues: [],
        },
      ],
      fileCount: 1,
      totalBytes: 10,
    };
    harness.data.skillPackages = [...harness.data.skillPackages, imported];
    pendingImport.resolve({
      package: imported,
      source: {
        sourceId: `src_${"c".repeat(64)}`,
        sourcePath: "/late/planner",
        realRoot: "/late/planner",
        packageId: imported.packageId,
        revision: 1,
        importedAt: "2026-10-22T00:00:00.000Z",
      },
      reused: false,
    });
    await pendingImport.promise;

    await page.getByRole("button", { name: "添加技能", exact: true }).click();
    await expect.element(page.getByText("已选 0 项", { exact: true })).toBeVisible();
    await expect
      .element(page.getByRole("checkbox", { name: "Imported skill", exact: true }))
      .toBeVisible();
    await expect
      .element(page.getByRole("checkbox", { name: "Imported skill", exact: true }))
      .not.toBeChecked();
    expect(harness.server.saveExpert).not.toHaveBeenCalled();
    await page.getByRole("button", { name: "取消", exact: true }).click();
    await close();
  });

  it("offers independent card actions, hides versions, and opens an unsaved copy", async () => {
    const { close } = await mountPanel();
    await page.getByRole("button", { name: "管理专家 规划专家", exact: true }).click();
    await expect.element(page.getByRole("heading", { name: "专家", exact: true })).toBeVisible();
    await expect.element(page.getByText("v7", { exact: true })).not.toBeInTheDocument();
    await page.getByRole("menuitem", { name: "复制专家", exact: true }).click();
    await expect
      .element(page.getByRole("textbox", { name: "专家名称" }))
      .toHaveValue("规划专家 副本");
    await expect
      .element(page.getByRole("tab", { name: "设置" }))
      .toHaveAttribute("aria-selected", "true");
    expect(harness.server.saveExpert).not.toHaveBeenCalled();
    await page.getByRole("button", { name: "保存更改", exact: true }).click();
    await expect.poll(() => harness.server.saveExpert.mock.calls.length).toBe(1);
    expect(harness.server.saveExpert.mock.calls[0]?.[0]).not.toHaveProperty("id");
    expect(harness.server.saveExpert.mock.calls[0]?.[0]).not.toHaveProperty("expectedRevision");
    expect(harness.data.experts).toHaveLength(2);
    await close();
  });

  it("archives and restores from cards using the current revision without entering the editor", async () => {
    const { close } = await mountPanel();
    await page.getByRole("button", { name: "管理专家 规划专家", exact: true }).click();
    await page.getByRole("menuitem", { name: "归档专家", exact: true }).click();
    await page.getByRole("button", { name: "确认归档", exact: true }).click();
    await expect
      .element(page.getByRole("button", { name: "编辑专家 规划专家", exact: true }))
      .not.toBeInTheDocument();
    expect(harness.server.archiveExpert).toHaveBeenCalledWith({
      id: "planner",
      expectedRevision: 7,
    });
    await page.getByRole("button", { name: "已归档", exact: true }).click();
    await page.getByRole("button", { name: "管理专家 规划专家", exact: true }).click();
    await page.getByRole("menuitem", { name: "恢复专家", exact: true }).click();
    await page.getByRole("button", { name: "确认恢复", exact: true }).click();
    await expect
      .element(page.getByRole("button", { name: "编辑专家 规划专家", exact: true }))
      .not.toBeInTheDocument();
    expect(harness.server.restoreExpert).toHaveBeenCalledWith({
      id: "planner",
      expectedRevision: 8,
    });
    await page.getByRole("button", { name: "使用中", exact: true }).click();
    await expect
      .element(page.getByRole("button", { name: "编辑专家 规划专家", exact: true }))
      .toBeVisible();
    await close();
  });

  it("cancels deletion, retains cards after a conflict, and removes them only after success", async () => {
    const { close, queryClient } = await mountPanel();
    const requestDelete = async () => {
      await page.getByRole("button", { name: "管理专家 规划专家", exact: true }).click();
      await page.getByRole("menuitem", { name: "删除专家", exact: true }).click();
    };
    await requestDelete();
    await page.getByRole("button", { name: "取消", exact: true }).click();
    expect(harness.server.deleteExpert).not.toHaveBeenCalled();
    harness.server.deleteExpert.mockRejectedValueOnce(new Error("专家已更新，请刷新后重试。"));
    harness.server.listExperts.mockRejectedValueOnce(new Error("暂时无法刷新列表"));
    await requestDelete();
    await page.getByRole("button", { name: "确认删除", exact: true }).click();
    await expect.poll(() => queryClient.getQueryState(EXPERTS_QUERY_KEY)?.status).toBe("error");
    await expect.element(page.getByRole("alert")).toHaveTextContent("专家已更新，请刷新后重试。");
    await expect
      .element(page.getByRole("button", { name: "编辑专家 规划专家", exact: true }))
      .toBeVisible();
    await requestDelete();
    await page.getByRole("button", { name: "确认删除", exact: true }).click();
    await expect
      .element(page.getByRole("button", { name: "编辑专家 规划专家", exact: true }))
      .not.toBeInTheDocument();
    expect(document.querySelector('[aria-label="专家总数"]')?.textContent).toBe("0");
    expect(harness.server.deleteExpert).toHaveBeenLastCalledWith({
      id: "planner",
      expectedRevision: 7,
    });
    await close();
  });

  it("returns through the compact header without losing a cancelled dirty draft", async () => {
    const { close } = await mountPanel();
    await expect
      .element(page.getByRole("heading", { name: "专家", level: 1, exact: true }))
      .toBeVisible();
    expect(document.querySelector('[aria-label="专家总数"]')?.textContent).toBe("1");
    await page.getByRole("button", { name: "编辑专家 规划专家", exact: true }).click();
    await expect
      .element(page.getByRole("heading", { name: "规划专家", level: 1, exact: true }))
      .toBeVisible();
    expect(document.querySelectorAll("h1")).toHaveLength(1);
    await expect.element(page.getByRole("button", { name: "检查配置", exact: true })).toBeVisible();
    expect(harness.server.previewExpert).not.toHaveBeenCalled();

    const persona = page.getByRole("textbox", { name: "专家角色与工作方式" });
    await persona.fill("暂存的职责");
    await page.getByRole("button", { name: "返回专家列表", exact: true }).click();
    await page.getByRole("button", { name: "取消", exact: true }).click();
    await expect.element(persona).toHaveValue("暂存的职责");
    await page.getByRole("button", { name: "返回专家列表", exact: true }).click();
    await page.getByRole("button", { name: "放弃更改", exact: true }).click();
    await expect
      .element(page.getByRole("heading", { name: "专家", level: 1, exact: true }))
      .toBeVisible();
    expect(harness.server.saveExpert).not.toHaveBeenCalled();
    await close();
  });

  it("starts new experts in Settings, locates name errors, and binds managed Skill identities", async () => {
    const managed: SkillDefinition = {
      skillId: `skl_${"d".repeat(32)}`,
      name: "Planning framework",
      description: "Plan work",
      tags: [],
      packageId: `pkg_${"a".repeat(64)}`,
      entryPath: "planner/SKILL.md",
      source: {
        kind: "manual",
        location: "",
        packageId: `pkg_${"a".repeat(64)}`,
        entryPath: "planner/SKILL.md",
      },
      locallyModified: false,
      revision: 1,
      deleted: false,
      updatedAt: "2026-10-25T00:00:00.000Z",
    };
    harness.server.skillLibrary.mockResolvedValue({ skills: [managed] });
    const { close } = await mountPanel();
    await page.getByRole("button", { name: "新建专家" }).click();

    const name = page.getByRole("textbox", { name: "专家名称" });
    await expect
      .element(page.getByRole("tab", { name: "设置" }))
      .toHaveAttribute("aria-selected", "true");
    await expect.element(page.getByText("请填写专家名称。", { exact: true })).toBeVisible();
    await expect
      .element(page.getByRole("combobox", { name: "专家首选 Provider" }))
      .toHaveTextContent("不指定");
    await name.click();
    document.activeElement?.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "s",
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(harness.server.saveExpert).not.toHaveBeenCalled();

    document
      .querySelector<HTMLElement>('[role="tablist"][aria-label="专家配置页签"]')
      ?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }),
      );
    await expect
      .element(page.getByRole("tab", { name: "能力" }))
      .toHaveAttribute("aria-selected", "true");
    await expect.element(page.getByText("Planning framework", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "绑定", exact: true }).click();
    await expect.element(page.getByRole("switch", { name: "启用绑定技能" })).toBeChecked();
    await expect
      .element(page.getByRole("combobox", { name: "技能加载时机" }))
      .toHaveTextContent("按需");
    expect(harness.server.previewSkillPackage).not.toHaveBeenCalled();
    expect(harness.server.importSkillPackage).not.toHaveBeenCalled();
    expect(harness.server.saveExpert).not.toHaveBeenCalled();

    await page.getByRole("button", { name: /请填写专家名称.*定位问题/ }).click();
    await expect.element(name).toHaveFocus();
    await name.fill("规划专家副本");
    expect(harness.server.previewExpert).not.toHaveBeenCalled();
    await close();
  });

  it("keeps a cancelled preview out of the draft and saves an imported path as a package selection", async () => {
    const { close } = await mountPanel("/settings?expertId=planner");
    await expect.element(page.getByRole("heading", { name: "技能 0", exact: true })).toBeVisible();
    await expect
      .element(page.getByRole("heading", { name: "参考资料 0", exact: true }))
      .toBeVisible();
    await expect.element(page.getByRole("textbox", { name: "新技能名称" })).not.toBeInTheDocument();
    await expect.element(page.getByText("尚未配置技能。", { exact: true })).not.toBeInTheDocument();

    await page.getByRole("button", { name: "添加技能", exact: true }).click();
    await page.getByRole("radio", { name: "按路径", exact: true }).click();
    await page.getByRole("textbox", { name: "新技能路径" }).fill("/manual/planning/SKILL.md");
    await page.getByRole("button", { name: "读取技能", exact: true }).click();
    await expect
      .element(page.getByRole("checkbox", { name: "Imported skill", exact: true }))
      .toBeChecked();
    await page.getByRole("button", { name: "取消", exact: true }).click();
    await expect.element(page.getByRole("button", { name: "保存更改" })).not.toBeInTheDocument();
    expect(harness.server.importSkillPackage).not.toHaveBeenCalled();
    expect(harness.server.saveExpert).not.toHaveBeenCalled();

    await page.getByRole("button", { name: "添加参考资料", exact: true }).click();
    await page.getByRole("textbox", { name: "参考资料路径", exact: true }).fill("/docs/cancel.md");
    await page.getByRole("button", { name: "取消", exact: true }).click();
    await expect.element(page.getByRole("button", { name: "保存更改" })).not.toBeInTheDocument();

    await page.getByRole("button", { name: "添加技能", exact: true }).click();
    await page.getByRole("radio", { name: "按路径", exact: true }).click();
    await page.getByRole("textbox", { name: "新技能路径" }).fill("/manual/planning/SKILL.md");
    await page.getByRole("button", { name: "读取技能", exact: true }).click();
    await expect.poll(() => harness.server.importSkillPackage.mock.calls.length).toBe(0);
    await page.getByRole("button", { name: "应用选择（1）", exact: true }).click();
    await expect.element(page.getByRole("heading", { name: "技能 1", exact: true })).toBeVisible();
    expect(harness.server.importSkillPackage).toHaveBeenCalledTimes(1);
    expect(harness.server.importSkillPackage).toHaveBeenCalledWith({
      previewId: "preview-/manual/planning/SKILL.md",
      idempotencyKey: "preview-/manual/planning/SKILL.md",
    });

    await page.getByRole("button", { name: "添加参考资料", exact: true }).click();
    await page.getByRole("radio", { name: "批量粘贴", exact: true }).click();
    await page
      .getByRole("textbox", { name: "批量粘贴参考资料路径" })
      .fill("/docs/brief.md\n/docs/spec.md\n/docs/brief.md");
    await expect.element(page.getByText("新增 2", { exact: true })).toBeVisible();
    await expect.element(page.getByText("重复 1", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "添加 2 条", exact: true }).click();

    await page.getByRole("button", { name: "添加参考资料", exact: true }).click();
    await page.getByRole("textbox", { name: "参考资料路径", exact: true }).fill("/docs/brief.md");
    await expect.element(page.getByText("新增 0", { exact: true })).toBeVisible();
    await expect.element(page.getByText("重复 1", { exact: true })).toBeVisible();
    await expect
      .element(page.getByRole("button", { name: "添加 0 条", exact: true }))
      .toBeDisabled();
    await page.getByRole("button", { name: "取消", exact: true }).click();

    await page.getByRole("button", { name: "保存更改", exact: true }).click();
    await expect.poll(() => harness.server.saveExpert.mock.calls.length).toBe(1);
    expect(harness.server.saveExpert.mock.calls[0]?.[0]).toMatchObject({
      id: "planner",
      expectedRevision: 7,
      skills: [],
      skillSelections: [
        {
          packageId: `pkg_${"c".repeat(64)}`,
          entryPath: "SKILL.md",
          activation: "on-demand",
        },
      ],
      references: ["/docs/brief.md", "/docs/spec.md"],
    });
    await expect.element(page.getByRole("button", { name: "保存更改" })).not.toBeInTheDocument();
    await close();
  });

  it("requires a reviewed draft action before replacing an existing Expert assembly", async () => {
    const oldSkills = [{ name: "Existing role", path: "/old/role/SKILL.md" }];
    harness.data.experts = [
      harness.makeExpert({
        skills: oldSkills,
        skillSelections: [
          {
            packageId: `pkg_${"a".repeat(64)}`,
            entryPath: "planner/SKILL.md",
            activation: "startup",
          },
        ],
      }),
    ];
    const { close } = await mountPanel("/settings?expertId=planner");
    await page.getByRole("button", { name: "改用技能库装配", exact: true }).click();
    await expect
      .element(page.getByText("Existing role · /old/role/SKILL.md", { exact: true }))
      .toBeVisible();
    await expect.element(page.getByText(/planner\/SKILL.md · 启动时/u)).toBeVisible();
    await page.getByRole("button", { name: "保留原装配", exact: true }).click();
    expect(harness.server.saveExpert).not.toHaveBeenCalled();
    expect(harness.data.experts[0]?.skills).toEqual(oldSkills);
    await page.getByRole("button", { name: "改用技能库装配", exact: true }).click();
    await page.getByRole("button", { name: "确认更改草稿", exact: true }).click();
    expect(harness.server.saveExpert).not.toHaveBeenCalled();
    expect(harness.data.experts[0]?.skills).toEqual(oldSkills);
    await expect.element(page.getByText(/在设置 → 技能中新建或导入技能/u)).toBeVisible();
    await page.getByRole("button", { name: "保存更改", exact: true }).click();
    await expect.poll(() => harness.server.saveExpert.mock.calls.length).toBe(1);
    expect(harness.server.saveExpert).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "planner",
        expectedRevision: 7,
        skillBindings: [],
        skills: [],
        skillSelections: [],
      }),
    );
    await close();
  });
  it("keeps other legacy paths when removing a catalog choice, then converts the remaining path", async () => {
    harness.data.experts = [
      harness.makeExpert({
        skills: [
          { name: "synara:planning", path: "/skills/planning/SKILL.md" },
          { name: "手动技能", path: "/manual/SKILL.md" },
        ],
        references: ["/docs/brief.md"],
      }),
    ];
    const { close } = await mountPanel("/settings?expertId=planner");
    await page.getByRole("button", { name: "添加技能", exact: true }).click();
    await expect
      .element(page.getByRole("checkbox", { name: "Planning framework", exact: true }))
      .toBeChecked();
    await expect
      .element(page.getByRole("checkbox", { name: "手动技能", exact: true }))
      .toBeChecked();
    await page.getByRole("checkbox", { name: "Planning framework", exact: true }).click();
    await expect
      .element(page.getByRole("button", { name: "应用选择（1）", exact: true }))
      .toBeEnabled();
    await page.getByRole("button", { name: "应用选择（1）", exact: true }).click();
    await expect
      .element(page.getByRole("button", { name: "查看技能 Imported skill", exact: true }))
      .toBeVisible();
    await expect
      .element(page.getByRole("button", { name: "查看技能 synara:planning", exact: true }))
      .not.toBeInTheDocument();
    expect(harness.server.previewSkillPackage).toHaveBeenCalledWith({ path: "/manual/SKILL.md" });
    expect(harness.server.importSkillPackage).toHaveBeenCalledTimes(1);
    expect(harness.server.saveExpert).not.toHaveBeenCalled();
    await close();
  });

  it("keeps a conflicting dirty draft, shows the newer revision, and discards into the latest definition", async () => {
    const { close, queryClient } = await mountPanel("/settings?expertId=planner");
    const persona = page.getByRole("textbox", { name: "专家角色与工作方式" });
    await expect.element(persona).toHaveValue("先澄清目标");
    await persona.fill("本地未保存的职责");

    const latest = harness.makeExpert({ revision: 8, description: "来自服务器的最新版" });
    harness.data.experts = [latest];
    queryClient.setQueryData(EXPERTS_QUERY_KEY, [latest]);
    harness.server.saveExpert.mockRejectedValueOnce(new Error("revision conflict"));

    await page.getByRole("button", { name: "添加专家 MCP 连接" }).click();
    await page.getByRole("textbox", { name: "搜索 MCP 连接", exact: true }).fill("no match");
    await page.getByRole("button", { name: "管理 MCP 连接", exact: true }).click();
    await expect.element(page.getByText("离开前要保存还是放弃这些更改？")).toBeVisible();
    await page.getByRole("button", { name: "保存并继续" }).click();
    await expect
      .element(page.getByText("保存没有完成，当前更改仍保留。修复错误后重试，或选择放弃更改。"))
      .toBeVisible();

    await page.getByRole("button", { name: "取消" }).click();
    await expect.element(persona).toHaveValue("本地未保存的职责");
    await expect.element(page.getByText(/服务端已有 v8/)).toBeVisible();
    await page.getByRole("button", { name: "放弃", exact: true }).click();
    await page.getByRole("tab", { name: "设置" }).click();
    await expect
      .element(page.getByRole("textbox", { name: "专家描述" }))
      .toHaveValue("来自服务器的最新版");
    await page.getByRole("tab", { name: "能力" }).click();
    const refreshedPersona = page.getByRole("textbox", { name: "专家角色与工作方式" });
    await expect.element(refreshedPersona).toHaveValue("先澄清目标");

    await refreshedPersona.fill("最新版保存后的角色");
    await page.getByRole("button", { name: "管理专家 规划专家" }).click();
    await page.getByRole("menuitem", { name: "复制专家" }).click();
    await page.getByRole("button", { name: "保存并继续" }).click();
    await expect
      .element(page.getByRole("textbox", { name: "专家名称" }))
      .toHaveValue("规划专家 副本");
    await expect
      .element(page.getByRole("textbox", { name: "专家描述" }))
      .toHaveValue("来自服务器的最新版");
    await page.getByRole("tab", { name: "能力" }).click();
    await expect
      .element(page.getByRole("textbox", { name: "专家角色与工作方式" }))
      .toHaveValue("最新版保存后的角色");
    await close();
  });

  it("waits for a pending save before opening MCP settings without prompting twice", async () => {
    const { close, router } = await mountPanel("/settings?expertId=planner");
    const persona = page.getByRole("textbox", { name: "专家角色与工作方式" });
    await expect.element(persona).toHaveValue("先澄清目标");
    await persona.fill("保存后使用的职责");

    type SavedExpert = Awaited<ReturnType<typeof harness.server.saveExpert>>;
    let resolveSave!: (value: SavedExpert) => void;
    harness.server.saveExpert.mockImplementationOnce(
      () =>
        new Promise<SavedExpert>((resolve) => {
          resolveSave = resolve;
        }),
    );
    await page.getByRole("button", { name: "添加专家 MCP 连接" }).click();
    await page.getByRole("textbox", { name: "搜索 MCP 连接", exact: true }).fill("no match");
    await page.getByRole("button", { name: "管理 MCP 连接", exact: true }).click();
    await page.getByRole("button", { name: "保存并继续" }).click();
    await expect.poll(() => harness.server.saveExpert.mock.calls.length).toBe(1);
    expect(
      document.querySelector<HTMLTextAreaElement>('[aria-label="专家角色与工作方式"]')?.disabled,
    ).toBe(true);
    await expect.element(page.getByRole("button", { name: "取消" })).toBeDisabled();

    const saved = harness.makeExpert({ persona: "保存后使用的职责", revision: 8 });
    harness.data.experts = [saved];
    resolveSave(saved);
    await expect.poll(() => router.state.location.pathname).toBe("/connections");
    await expect.element(page.getByText("连接设置页面")).toBeVisible();
    await close();
  });

  it("does not run preview automatically or report an older server revision as ready", async () => {
    const { close } = await mountPanel("/settings?expertId=planner");
    expect(harness.server.previewExpert).not.toHaveBeenCalled();
    await page.getByRole("button", { name: "检查配置", exact: true }).click();
    await expect.poll(() => harness.server.previewExpert.mock.calls.length).toBe(1);

    harness.server.previewExpert.mockResolvedValueOnce({
      definition: harness.makeExpert({ revision: 6 }),
      status: "available",
      issues: [],
    });
    await page.getByRole("button", { name: "重新检查" }).click();
    await expect.element(page.getByText(/与请求的 v7 不一致/)).toBeVisible();
    await expect
      .element(page.getByRole("button", { name: "检查配置：版本不一致", exact: true }))
      .toBeVisible();
    await expect.element(page.getByText("配置预检通过", { exact: true })).not.toBeInTheDocument();
    await close();
  });

  it("shows a compact connection row for an existing disabled legacy grant", async () => {
    harness.data.experts = [
      harness.makeExpert({
        connections: [{ id: "linear", enabled: true, required: false, tools: ["legacy_search"] }],
      }),
    ];
    harness.data.connectionState = "disabled";
    const { close } = await mountPanel("/settings?expertId=planner");
    await page.getByRole("tab", { name: "能力" }).click();

    await expect.element(page.getByText("全局停用", { exact: true })).toBeVisible();
    await expect
      .element(page.getByRole("region", { name: "MCP 工具", exact: true }))
      .toHaveTextContent("旧版权限");
    await expect
      .element(page.getByRole("button", { name: "移除专家 MCP 连接 Linear 工作区", exact: true }))
      .toBeVisible();
    expect(page.getByRole("button", { name: "管理工具", exact: true }).length).toBe(0);
    expect(page.getByText("1 项工具", { exact: true }).length).toBe(0);
    expect(harness.server.getExpertConnectionState).toHaveBeenCalledWith({ id: "linear" });
    expect(harness.server.saveExpert).not.toHaveBeenCalled();
    expect(harness.data.experts[0]?.connections).toEqual([
      { id: "linear", enabled: true, required: false, tools: ["legacy_search"] },
    ]);
    await close();
  });

  it("searches and applies MCP connections without reading tools, upgrading selected bindings explicitly", async () => {
    harness.data.connections = [
      ...harness.data.connections,
      {
        id: "github",
        name: "GitHub 工作区",
        transport: {
          type: "stdio" as const,
          command: "npx",
          args: ["-y", "github-mcp"],
          envFromHost: [],
        },
        revision: 1,
        updatedAt: "2026-10-03T00:00:00.000Z",
      },
    ];
    harness.data.experts = [
      harness.makeExpert({
        connections: [
          {
            id: "linear",
            enabled: false,
            required: true,
            tools: ["issues.search"],
          },
        ],
      }),
    ];
    const { close } = await mountPanel("/settings?expertId=planner");
    await page.getByRole("tab", { name: "能力" }).click();

    const mcpSection = page.getByRole("region", { name: "MCP 工具", exact: true });
    await expect.element(mcpSection).toHaveTextContent("1");
    await expect.element(mcpSection).toHaveTextContent("Linear 工作区");
    await expect.element(mcpSection).toHaveTextContent("已关闭");
    expect(mcpSection.getByRole("button", { name: "选择工具", exact: true }).length).toBe(0);
    expect(mcpSection.getByText(/\d+ 项工具/u).length).toBe(0);

    await page.getByRole("button", { name: "添加专家 MCP 连接" }).click();
    const search = page.getByRole("textbox", { name: "搜索 MCP 连接", exact: true });
    await expect
      .element(page.getByText("所选 MCP 将提供全部工具。", { exact: false }))
      .toBeVisible();
    await expect
      .element(page.getByRole("checkbox", { name: "Linear 工作区", exact: true }))
      .toBeChecked();
    await search.fill("GitHub");
    const github = page.getByRole("checkbox", { name: "GitHub 工作区", exact: true });
    await expect.element(github).toBeVisible();
    await github.click();
    await page.getByRole("button", { name: "取消", exact: true }).click();
    expect(harness.server.saveExpert).not.toHaveBeenCalled();
    expect(harness.server.testExpertConnection).not.toHaveBeenCalled();

    await page.getByRole("button", { name: "添加专家 MCP 连接" }).click();
    await page.getByRole("textbox", { name: "搜索 MCP 连接", exact: true }).fill("GitHub");
    await page.getByRole("checkbox", { name: "GitHub 工作区", exact: true }).click();
    await page.getByRole("button", { name: "应用选择", exact: true }).click();
    expect(mcpSection.getByText("旧版权限", { exact: true }).length).toBe(0);
    await expect.element(page.getByRole("button", { name: "保存更改", exact: true })).toBeEnabled();
    await page.getByRole("button", { name: "保存更改", exact: true }).click();
    await expect.poll(() => harness.server.saveExpert.mock.calls.length).toBe(1);
    expect(harness.server.saveExpert.mock.calls[0]?.[0]).toMatchObject({
      connections: [
        {
          id: "linear",
          enabled: false,
          required: true,
          toolMode: "all",
          tools: [],
        },
        {
          id: "github",
          enabled: true,
          required: false,
          toolMode: "all",
          tools: [],
        },
      ],
    });
    expect(harness.server.testExpertConnection).not.toHaveBeenCalled();
    await close();
  });

  it("keeps missing MCP bindings visible and lets the expert draft remove them", async () => {
    harness.data.experts = [
      harness.makeExpert({
        connections: [
          { id: "missing-mcp", enabled: true, required: true, tools: ["legacy.search"] },
        ],
      }),
    ];
    const { close } = await mountPanel("/settings?expertId=planner");
    await page.getByRole("tab", { name: "能力" }).click();

    const missing = page.getByRole("region", { name: "MCP 工具", exact: true });
    await expect.element(missing).toHaveTextContent("missing-mcp");
    await expect.element(missing).toHaveTextContent("连接缺失");
    await page.getByRole("button", { name: "移除专家 MCP 连接 missing-mcp", exact: true }).click();
    await expect.element(missing).not.toHaveTextContent("missing-mcp");
    await page.getByRole("button", { name: "保存更改", exact: true }).click();
    await expect.poll(() => harness.server.saveExpert.mock.calls.length).toBe(1);
    expect(harness.server.saveExpert.mock.calls[0]?.[0]).toMatchObject({ connections: [] });
    await close();
  });

  it("labels a disabled snapshot connection as disabled instead of missing configuration", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    harness.server.readExpertSnapshot.mockResolvedValue({
      snapshotId: "snapshot-planner-v7",
      expertId: "planner",
      revision: 7,
      name: "规划专家",
      description: "帮助规划任务",
      useCases: "",
      persona: "先澄清目标",
      outputRequirements: "",
      skills: [],
      references: [],
      connections: [{ id: "linear", enabled: false, required: true, tools: ["issues.search"] }],
      skillsRoot: "/skills",
    } as never);
    harness.server.readExpertAppliedRuntime.mockResolvedValue(null);
    const view = await render(
      <QueryClientProvider client={queryClient}>
        <ExpertTaskControl
          threadId={"thread-1" as never}
          binding={
            {
              snapshotId: "snapshot-planner-v7",
              expertId: "planner",
              revision: 7,
              displayName: "规划专家",
            } as never
          }
          provider={"codex" as never}
          model="test-model"
          canContinue={false}
          onContinue={async () => {}}
        />
      </QueryClientProvider>,
    );
    await page.getByRole("button", { name: "规划专家", exact: true }).click();
    await expect.element(page.getByText("已停用", { exact: true })).toBeVisible();
    await expect.element(page.getByText("未配置", { exact: true })).not.toBeInTheDocument();
    expect(harness.server.testExpertConnection).not.toHaveBeenCalled();
    await view.unmount();
    queryClient.clear();
  });

  it("previews Claude and Oh My Pi using the active provider instance and cwd", async () => {
    for (const [provider, providerInstanceId] of [
      ["claudeAgent", "claude-work"],
      ["omp", "omp-work"],
    ] as const) {
      harness.server.previewExpert.mockClear();
      const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false, gcTime: 0 } },
      });
      harness.server.readExpertSnapshot.mockResolvedValue({
        snapshotId: "snapshot-planner-v7",
        expertId: "planner",
        revision: 7,
        displayName: "规划专家",
        description: "帮助规划任务",
        useCases: "",
        persona: "先澄清目标",
        outputRequirements: "",
        skills: [],
        references: [],
        connections: [],
        skillsRoot: "/skills",
        createdAt: "2026-10-03T00:00:00.000Z",
      } as never);
      const onContinue = vi.fn(async () => {});
      const view = await render(
        <QueryClientProvider client={queryClient}>
          <ExpertTaskControl
            threadId={"thread-1" as never}
            binding={
              {
                snapshotId: "snapshot-planner-v7",
                expertId: "planner",
                revision: 7,
                displayName: "规划专家",
              } as never
            }
            provider={provider as never}
            providerInstanceId={providerInstanceId as never}
            cwd="/workspace/project"
            model="test-model"
            canContinue
            onContinue={onContinue}
          />
        </QueryClientProvider>,
      );

      await page.getByRole("button", { name: "规划专家", exact: true }).click();
      await page.getByRole("button", { name: "规划专家 · v7", exact: true }).click();
      await expect.poll(() => harness.server.previewExpert.mock.calls.length).toBe(1);
      expect(harness.server.previewExpert).toHaveBeenLastCalledWith({
        expertId: "planner",
        provider,
        providerInstanceId,
        cwd: "/workspace/project",
      });
      await expect.element(page.getByRole("button", { name: "创建接续任务" })).toBeEnabled();
      await expect
        .element(page.getByText("当前 Provider 暂不支持专家。", { exact: true }))
        .not.toBeInTheDocument();
      await page.getByRole("button", { name: "创建接续任务" }).click();
      await expect.poll(() => onContinue.mock.calls.length).toBe(1);

      await view.unmount();
      queryClient.clear();
    }
  });
  it("distinguishes the pinned MCP revision from an explicit current-configuration check", async () => {
    harness.server.testExpertConnection.mockResolvedValue({ tools: ["issues.search"] });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    harness.server.readExpertSnapshot.mockResolvedValue({
      snapshotId: "snapshot-planner-v7",
      expertId: "planner",
      revision: 7,
      name: "规划专家",
      description: "帮助规划任务",
      useCases: "",
      persona: "先澄清目标",
      outputRequirements: "",
      skills: [],
      references: [],
      connections: [{ id: "linear", enabled: true, required: true, tools: ["issues.search"] }],
      mcpBinding: {
        schemaVersion: 1,
        source: "snapshot",
        createdAt: "2026-10-03T00:00:00.000Z",
        servers: [{ id: "linear", configRevision: 1, required: true, tools: ["issues.search"] }],
      },
      skillsRoot: "/skills",
    } as never);
    harness.server.readExpertAppliedRuntime.mockResolvedValue(null);
    const view = await render(
      <QueryClientProvider client={queryClient}>
        <ExpertTaskControl
          threadId={"thread-1" as never}
          binding={
            {
              snapshotId: "snapshot-planner-v7",
              expertId: "planner",
              revision: 7,
              displayName: "规划专家",
            } as never
          }
          provider={"codex" as never}
          model="test-model"
          canContinue={false}
          onContinue={async () => {}}
        />
      </QueryClientProvider>,
    );
    await page.getByRole("button", { name: "规划专家", exact: true }).click();
    await expect.element(page.getByText("固定配置 · v1", { exact: true })).toBeVisible();
    expect(harness.server.testExpertConnection).not.toHaveBeenCalled();
    await page.getByRole("button", { name: "检测当前配置 Linear 工作区", exact: true }).click();
    await expect.poll(() => harness.server.testExpertConnection.mock.calls.length).toBe(1);
    expect(harness.server.testExpertConnection).toHaveBeenCalledWith({ id: "linear" });
    await expect.element(page.getByText(/当前配置检测完成/)).toBeVisible();
    await expect.element(page.getByText("固定配置 · v1", { exact: true })).toBeVisible();
    await view.unmount();
    queryClient.clear();
  });

  it("shows an all-tools task authorization as automatically captured and fixed", async () => {
    harness.server.testExpertConnection.mockResolvedValueOnce({
      tools: ["issues.search", "issues.read"],
    });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    harness.server.readExpertSnapshot.mockResolvedValue({
      snapshotId: "snapshot-planner-v7",
      expertId: "planner",
      revision: 7,
      name: "规划专家",
      description: "帮助规划任务",
      useCases: "",
      persona: "先澄清目标",
      outputRequirements: "",
      skills: [],
      references: [],
      connections: [{ id: "linear", enabled: true, required: true, toolMode: "all", tools: [] }],
      mcpBinding: {
        schemaVersion: 1,
        source: "snapshot",
        createdAt: "2026-10-03T00:00:00.000Z",
        servers: [{ id: "linear", configRevision: 3, required: true, tools: [] }],
      },
      skillsRoot: "/skills",
    } as never);
    harness.server.readExpertAppliedRuntime.mockResolvedValue(null);
    const view = await render(
      <QueryClientProvider client={queryClient}>
        <ExpertTaskControl
          threadId={"thread-1" as never}
          binding={
            {
              snapshotId: "snapshot-planner-v7",
              expertId: "planner",
              revision: 7,
              displayName: "规划专家",
            } as never
          }
          provider={"codex" as never}
          model="test-model"
          canContinue={false}
          onContinue={async () => {}}
        />
      </QueryClientProvider>,
    );

    await page.getByRole("button", { name: "规划专家", exact: true }).click();
    await expect
      .element(page.getByText(/全部工具（本任务首次启动时自动读取并固定）/u))
      .toBeVisible();
    expect(page.getByText("允许的工具：无", { exact: true }).length).toBe(0);
    expect(harness.server.testExpertConnection).not.toHaveBeenCalled();

    await page.getByRole("button", { name: "检测当前配置 Linear 工作区", exact: true }).click();
    await expect
      .element(page.getByText(/当前配置检测完成 · 当前提供：issues.search、issues.read/u))
      .toBeVisible();
    expect(page.getByText(/允许但未发现/u).length).toBe(0);
    await view.unmount();
    queryClient.clear();
  });
});

describe("Expert center routes", () => {
  it("locates a newly saved expert without a second leave confirmation", async () => {
    const { router, close } = await mountCenter("/experts?tab=capabilities");
    try {
      await page.getByRole("button", { name: "新建专家", exact: true }).click();
      await page.getByLabelText("专家名称").fill("新专家路由测试");
      await page.getByRole("button", { name: "保存更改", exact: true }).click();
      await expect.poll(() => router.state.location.pathname).toBe("/experts/created-expert");
      await expect
        .element(page.getByRole("heading", { name: "未保存的更改" }))
        .not.toBeInTheDocument();
      await expect
        .element(page.getByRole("heading", { name: "新专家路由测试", exact: true }))
        .toBeVisible();
    } finally {
      await close();
    }
  });

  it("keeps the same draft through history/settings and guards leaving the expert", async () => {
    const { router, close } = await mountCenter();
    try {
      const persona = page.getByLabelText("专家角色与工作方式");
      await persona.fill("保留我的未保存角色");
      await page.getByRole("tab", { name: "任务历史", exact: true }).click();
      await expect.element(page.getByText("任务历史 planner", { exact: true })).toBeVisible();
      expect(router.state.location.searchStr).toContain("history");
      await page.getByRole("tab", { name: "能力", exact: true }).click();
      await expect.element(persona).toHaveValue("保留我的未保存角色");
      void router.navigate({ to: "/outside" as never });
      await expect.element(page.getByRole("heading", { name: "未保存的更改" })).toBeVisible();
      await page.getByRole("button", { name: "取消", exact: true }).click();
      expect(router.state.location.pathname).toBe("/experts/planner");
      await expect.element(persona).toHaveValue("保留我的未保存角色");
    } finally {
      await close();
    }
  });

  it("does not display the previous expert for an unknown detail ID", async () => {
    const { router, close } = await mountCenter();
    try {
      await expect
        .element(page.getByRole("heading", { name: "规划专家", exact: true }))
        .toBeVisible();
      await router.navigate({
        to: "/experts/$expertId",
        params: { expertId: "missing" },
        search: { tab: "capabilities" },
      });
      await expect.element(page.getByText("该专家不存在或已删除。")).toBeVisible();
      await expect
        .element(page.getByRole("button", { name: "使用此专家", exact: true }))
        .not.toBeInTheDocument();
    } finally {
      await close();
    }
  });

  it("starts with the saved expert after resolving dirty edits once", async () => {
    const { close, onUseExpert } = await mountCenter();
    try {
      await page.getByLabelText("专家角色与工作方式").fill("新的角色");
      await page.getByRole("button", { name: "使用此专家", exact: true }).click();
      await page.getByRole("button", { name: "保存并继续", exact: true }).click();
      await expect.poll(() => onUseExpert.mock.calls.length).toBe(1);
      expect(onUseExpert).toHaveBeenCalledWith("planner");
      expect(harness.server.saveExpert).toHaveBeenCalledTimes(1);
    } finally {
      await close();
    }
  });
});
