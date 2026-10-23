import "~/index.css";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ProjectId, SpaceId, ThreadId } from "@synara/contracts";
import type { ExpertDefinition, HubTeamPreset, ProjectAgentOverview } from "@synara/contracts";
import { page } from "vitest/browser";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

const PROJECT_ID = ProjectId.makeUnsafe("project-group-1");
const LINKED_ID = ProjectId.makeUnsafe("project-linked");
const CANDIDATE_ID = ProjectId.makeUnsafe("project-candidate");
const SOURCE_ID = ProjectId.makeUnsafe("project-source");

function expert(input: { id: string; name: string; archived?: boolean }): ExpertDefinition {
  return {
    id: input.id,
    name: input.name,
    description: `${input.name} description`,
    useCases: "Research and writing",
    persona: "Helpful expert",
    outputRequirements: "Clear result",
    skills: [],
    references: [],
    connections: [],
    revision: 1,
    archived: input.archived ?? false,
    updatedAt: "2026-10-19T00:00:00.000Z",
  };
}

function preset(overrides: Partial<HubTeamPreset> = {}): HubTeamPreset {
  return {
    id: "preset-product",
    name: "产品协作团",
    purpose: "完善产品方案",
    expertIds: ["writer"],
    coordinatorInstructions: "先澄清，再组织评审",
    collaborationPreferences: "并行收集意见",
    revision: 3,
    createdAt: "2026-10-20T00:00:00.000Z",
    updatedAt: "2026-10-21T00:00:00.000Z",
    archivedAt: null,
    ...overrides,
  };
}

const api = vi.hoisted(() => {
  const teams: Array<Record<string, unknown>> = [];
  const readDocumentResult = {
    head: {
      projectId: "project-group-1",
      logicalPath: "instructions.md",
      revision: 1,
      contentHash: "h",
      diskHash: "h",
      conflictPending: false,
      updatedAt: "2026-09-01T00:00:00.000Z",
    },
    document: {
      logicalPath: "instructions.md",
      content: "Be nice.",
      revision: 1,
    },
    history: [],
  };
  return {
    projectAgent: {
      getOverview: vi.fn(),
      listTasks: vi.fn(async () => ({ tasks: [] })),
      listActivity: vi.fn(async () => ({ activity: [], nextCursor: null })),
      listDocuments: vi.fn(async () => ({ documents: [] })),
      listThreadIndex: vi.fn(async () => ({
        threads: [] as Array<{ threadId: string }>,
      })),
      subscribe: vi.fn(async () => undefined),
      unsubscribe: vi.fn(async () => undefined),
      onEvent: vi.fn(() => () => undefined),
      configure: vi.fn(),
      readDocument: vi.fn(async () => readDocumentResult),
      writeDocument: vi.fn(async (input: { logicalPath: string; content: string }) => ({
        logicalPath: input.logicalPath,
        content: input.content,
        revision: 2,
      })),
      linkProject: vi.fn(),
      unlinkProject: vi.fn(),
      deleteGroup: vi.fn(async () => ({
        deletedProjectId: "project-group-1",
        libraryLeftOnDiskPath: null,
        workspaceLeftOnDiskPath: null,
      })),
    },
    orchestration: { dispatchCommand: vi.fn(async () => ({ sequence: 1 })) },
    server: {
      getConfig: vi.fn(async () => ({ cwd: "/srv" })),
      listExperts: vi.fn(async () => [] as ReadonlyArray<ExpertDefinition>),
    },
    provider: {
      listModels: vi.fn(async () => ({ models: [], source: "disabled" })),
    },
    hubTeamsData: teams,
    hubTeams: {
      list: vi.fn(async () => teams),
      read: vi.fn(async () => null),
      save: vi.fn(async (input: Record<string, unknown>) => {
        const existing = teams.find((team) => team.id === input.id);
        const saved = {
          ...input,
          revision: (typeof existing?.revision === "number" ? existing.revision : 0) + 1,
          createdAt:
            typeof existing?.createdAt === "string"
              ? existing.createdAt
              : "2026-10-22T00:00:00.000Z",
          updatedAt: "2026-10-22T00:01:00.000Z",
          archivedAt: null,
        };
        teams.splice(0, teams.length, saved, ...teams.filter((team) => team.id !== input.id));
        return saved;
      }),
      setArchived: vi.fn(async (input: { id: string; archived: boolean }) => {
        const existing = teams.find((team) => team.id === input.id) ?? {};
        const saved = {
          ...existing,
          revision: (typeof existing.revision === "number" ? existing.revision : 0) + 1,
          updatedAt: "2026-10-22T00:01:00.000Z",
          archivedAt: input.archived ? "2026-10-22T00:01:00.000Z" : null,
        };
        teams.splice(
          0,
          teams.length,
          ...teams.map((team) => (team.id === input.id ? saved : team)),
        );
        return saved;
      }),
    },
  };
});

vi.mock("~/nativeApi", () => ({
  readNativeApi: () => api,
  ensureNativeApi: () => api,
  readNativeApiServerCapabilityState: () => "supported",
  readNativeApiServerConnection: () => ({
    generation: "group-settings-browser",
    connected: true,
  }),
  onNativeApiServerCapabilitiesChange: () => () => undefined,
}));

vi.mock("~/hooks/useNativeApiServerCapability", () => ({
  useNativeApiServerCapabilitySnapshot: () => ({
    generation: "group-settings-browser",
    capability: "supported",
    connected: true,
    api,
  }),
}));

vi.mock("~/components/PluginLibrary", () => ({
  PluginLibrary: () => <div data-testid="plugin-library-stub">PluginLibrary stub</div>,
}));

import { makeProject } from "~/storeTestFixtures";
import { useStore } from "~/store";

import { GroupSettingsDialog } from "./GroupSettingsDialog";

function overview(overrides: Partial<ProjectAgentOverview> = {}): ProjectAgentOverview {
  return {
    projectId: PROJECT_ID,
    configured: true,
    config: {
      projectId: PROJECT_ID,
      coordinatorThreadId: ThreadId.makeUnsafe("thread-1"),
      coordinatorName: "alpha Coordinator",
      coordinatorModelSelection: { provider: "codex", model: "gpt-5-codex" },
      limits: {
        maxConcurrentWorkers: 4,
        maxNewWorkersPerTurn: 2,
        maxWorkerCreationsPerGoal: 16,
        maxAutomaticContinuationsPerGoal: 8,
        maxRepairRoundsPerTask: 2,
      },
      captureEnabled: true,
      enabled: true,
      automationId: null,
      revision: 4,
      createdAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-01T00:00:00.000Z",
      disabledAt: null,
      goal: "ship it",
      icon: "🐝",
      autoMemoryEnabled: true,
    },
    goal: null,
    digest: null,
    linkedProjectIds: [],
    blockers: [],
    recentOutcomes: [],
    coordinatorStatus: "idle",
    ...overrides,
  } as ProjectAgentOverview;
}

function renderDialog(props: Partial<Parameters<typeof GroupSettingsDialog>[0]> = {}) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <GroupSettingsDialog
        open
        mode="edit"
        projectId={PROJECT_ID}
        projectName="alpha"
        workspacePath="/tmp/group"
        defaultModelSelection={{ provider: "codex", model: "gpt-5-codex" }}
        onOpenChange={vi.fn()}
        {...props}
      />
    </QueryClientProvider>,
  );
}

describe("GroupSettingsDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.hubTeamsData.length = 0;
    api.hubTeams.list.mockImplementation(async () => api.hubTeamsData);
    api.hubTeams.save.mockImplementation(async (input: Record<string, unknown>) => {
      const existing = api.hubTeamsData.find((team) => team.id === input.id);
      const saved = {
        ...input,
        revision: (typeof existing?.revision === "number" ? existing.revision : 0) + 1,
        createdAt:
          typeof existing?.createdAt === "string" ? existing.createdAt : "2026-10-22T00:00:00.000Z",
        updatedAt: "2026-10-22T00:01:00.000Z",
        archivedAt: null,
      };
      api.hubTeamsData.splice(
        0,
        api.hubTeamsData.length,
        saved,
        ...api.hubTeamsData.filter((team) => team.id !== input.id),
      );
      return saved;
    });
    api.server.listExperts.mockResolvedValue([]);
    api.projectAgent.getOverview.mockResolvedValue(overview());
    api.projectAgent.configure.mockResolvedValue(overview());
    useStore.setState({ projects: [], sidebarThreadSummaryById: {} });
  });

  it("switches between nav sections", async () => {
    await renderDialog();

    await expect.element(page.getByLabelText("Hub name")).toBeInTheDocument();

    await page.getByRole("button", { name: "Memory" }).click();
    await expect.element(page.getByLabelText("Hub instructions")).toBeInTheDocument();

    await page.getByRole("button", { name: "Environment" }).click();
    expect(document.body.textContent).toContain("Linked repositories");

    await page.getByRole("button", { name: "Plugins" }).click();
    await expect.element(page.getByTestId("plugin-library-stub")).toBeInTheDocument();
  });

  it("opens at initialSection when provided", async () => {
    await renderDialog({ initialSection: "memory" });
    await expect.element(page.getByLabelText("Hub instructions")).toBeInTheDocument();
  });

  it("moves a Hub to the selected Space independently of its linked Projects", async () => {
    const targetSpaceId = SpaceId.makeUnsafe("space-research");
    useStore.setState({
      projects: [makeProject({ id: PROJECT_ID, kind: "group", spaceId: null })],
      spaces: [
        {
          id: targetSpaceId,
          name: "Research",
          icon: "bag",
          sortOrder: 0,
          createdAt: "2026-10-19T00:00:00.000Z",
          updatedAt: "2026-10-19T00:00:00.000Z",
        },
      ],
      sidebarThreadSummaryById: {},
    });
    await renderDialog();

    await page.getByRole("combobox", { name: "Hub Space" }).click();
    await page.getByRole("option", { name: "Research", exact: true }).click();

    await vi.waitFor(() =>
      expect(api.orchestration.dispatchCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "project.meta.update",
          projectId: PROJECT_ID,
          spaceId: targetSpaceId,
        }),
      ),
    );
  });

  it("saves General edits through projectAgent.configure", async () => {
    await renderDialog();

    await page.getByLabelText("Hub goal").fill("grow the library");
    await page.getByRole("combobox", { name: "Parallel threads" }).click();
    await page.getByRole("option", { name: "3", exact: true }).click();
    await page.getByRole("button", { name: "Save", exact: true }).click();

    await vi.waitFor(() => expect(api.projectAgent.configure).toHaveBeenCalledOnce());
    const payload = api.projectAgent.configure.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(payload.projectId).toBe(PROJECT_ID);
    expect(payload.goal).toBe("grow the library");
    expect(payload.expectedRevision).toBe(4);
    expect(payload).not.toHaveProperty("collaboration");
    expect(payload.captureEnabled).toBe(true);
    expect(payload.autoMemoryEnabled).toBe(true);
    expect(payload.limits).toMatchObject({ maxConcurrentWorkers: 3 });
    expect(payload.coordinatorModelSelection).toEqual({
      provider: "codex",
      model: "gpt-5-codex",
    });
    expect(payload.workerRouting).toMatchObject({
      modelSelection: { provider: "codex", model: "gpt-5-codex" },
      environment: "local",
    });
    expect(typeof payload.requestId).toBe("string");
    // Name unchanged: no rename command dispatched.
    expect(api.orchestration.dispatchCommand).not.toHaveBeenCalled();
  });

  it("loads human experts, filters the multiselect, and saves the selected IDs", async () => {
    api.server.listExperts.mockResolvedValue([
      expert({ id: "research", name: "Research" }),
      expert({ id: "writer", name: "Writer" }),
      expert({ id: "archived", name: "Archived", archived: true }),
    ]);
    const existing = overview();
    api.projectAgent.getOverview.mockResolvedValue(
      overview({ config: { ...existing.config!, expertIds: ["research"] } }),
    );
    await renderDialog();

    await page.getByRole("button", { name: "Experts" }).click();
    await expect.element(page.getByText("已选择 1 位专家")).toBeInTheDocument();
    await expect.element(page.getByRole("checkbox", { name: "Research" })).toBeChecked();
    await page.getByLabelText("搜索专家").fill("writer");
    await expect.element(page.getByRole("checkbox", { name: "Writer" })).toBeInTheDocument();
    await expect.element(page.getByText("Research description")).not.toBeInTheDocument();
    await page.getByRole("checkbox", { name: "Writer" }).click();
    await expect.element(page.getByText("已选择 2 位专家")).toBeInTheDocument();
    await page.getByRole("button", { name: "Save", exact: true }).click();

    await vi.waitFor(() => expect(api.projectAgent.configure).toHaveBeenCalledOnce());
    const payload = api.projectAgent.configure.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(payload.expertIds).toEqual(["research", "writer"]);
    expect(api.server.listExperts).toHaveBeenCalledOnce();
  });

  it("copies a selected team preset into the Hub draft and preserves unavailable member IDs", async () => {
    api.hubTeamsData.push(preset({ expertIds: ["writer", "missing-expert"] }));
    api.server.listExperts.mockResolvedValue([expert({ id: "writer", name: "Writer" })]);
    const existing = overview();
    api.projectAgent.getOverview.mockResolvedValue(
      overview({ config: { ...existing.config!, goal: "old goal", expertIds: [] } }),
    );
    await renderDialog();

    await page.getByRole("button", { name: "Experts" }).click();
    await page.getByRole("radio", { name: "专家团模式" }).click();
    const presetSelect = page.getByRole("combobox", { name: "从专家团预设采用副本" });
    await presetSelect.click();
    await page.getByRole("option", { name: "产品协作团 · v3" }).click();

    await expect.element(page.getByText("missing-expert · 不可用")).toBeInTheDocument();
    await expect
      .element(page.getByText("未选择或没有匹配专家时，可使用普通线程"))
      .not.toBeInTheDocument();
    await page.getByRole("button", { name: /角色与协调方式/ }).click();
    await page.getByLabelText("协调者角色与协调方式").fill("Hub 本地副本里的新协调方式");
    await page.getByRole("button", { name: "Save", exact: true }).click();

    await vi.waitFor(() => expect(api.projectAgent.configure).toHaveBeenCalledOnce());
    const payload = api.projectAgent.configure.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(payload.goal).toBe("完善产品方案");
    expect(payload.expertIds).toEqual(["writer", "missing-expert"]);
    expect(payload.collaboration).toMatchObject({
      schemaVersion: 1,
      mode: "expert-team",
      coordinatorInstructions: "Hub 本地副本里的新协调方式",
      collaborationPreferences: "并行收集意见",
      presetSource: { id: "preset-product", revision: 3 },
    });
    expect(api.hubTeams.save).not.toHaveBeenCalled();
    expect(api.hubTeamsData[0]?.coordinatorInstructions).toBe("先澄清，再组织评审");
  });

  it("restores coordinator defaults in the draft and applies them only on Save", async () => {
    const existing = overview();
    api.projectAgent.getOverview.mockResolvedValue(
      overview({
        config: {
          ...existing.config!,
          expertIds: ["writer"],
          collaboration: {
            schemaVersion: 1,
            mode: "expert-team",
            coordinatorInstructions: "saved custom role",
            collaborationPreferences: "review in parallel",
            presetSource: { id: "preset-product", revision: 2 },
          },
        },
      }),
    );
    await renderDialog();

    await page.getByRole("button", { name: "Experts" }).click();
    await page.getByRole("button", { name: /角色与协调方式/ }).click();
    const coordinator = page.getByLabelText("协调者角色与协调方式");
    await expect.element(coordinator).toHaveValue("saved custom role");
    await page.getByRole("button", { name: "恢复默认" }).click();
    await expect.element(coordinator).toHaveValue("");
    expect(api.projectAgent.configure).not.toHaveBeenCalled();

    await page.getByRole("button", { name: "Save", exact: true }).click();
    await vi.waitFor(() => expect(api.projectAgent.configure).toHaveBeenCalledOnce());
    const payload = api.projectAgent.configure.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(payload.collaboration).toEqual({
      schemaVersion: 1,
      mode: "expert-team",
      collaborationPreferences: "review in parallel",
      presetSource: { id: "preset-product", revision: 2 },
    });
  });

  it("saves a Hub copy as a team preset without configuring the Hub", async () => {
    const existing = overview();
    api.server.listExperts.mockResolvedValue([expert({ id: "writer", name: "Writer" })]);
    api.projectAgent.getOverview.mockResolvedValue(
      overview({
        config: {
          ...existing.config!,
          goal: "current team purpose",
          expertIds: ["writer"],
          collaboration: {
            schemaVersion: 1,
            mode: "expert-team",
            coordinatorInstructions: "local coordinator role",
            collaborationPreferences: "parallel review",
          },
        },
      }),
    );
    await renderDialog();

    await page.getByRole("button", { name: "Experts" }).click();
    await page.getByRole("button", { name: "另存为专家团" }).click();
    await page.getByLabelText("另存专家团名称").fill("当前 Hub 副本");
    await page.getByRole("button", { name: "保存专家团" }).click();

    await vi.waitFor(() => expect(api.hubTeams.save).toHaveBeenCalledOnce());
    expect(api.hubTeams.save).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "当前 Hub 副本",
        purpose: "current team purpose",
        expertIds: ["writer"],
        coordinatorInstructions: "local coordinator role",
        collaborationPreferences: "parallel review",
        expectedRevision: null,
      }),
    );
    expect(api.projectAgent.configure).not.toHaveBeenCalled();
    await expect.element(page.getByRole("status")).toHaveTextContent("已另存为专家团");
  });

  it("shows archived and missing selections as removable and allows other edits to save", async () => {
    api.server.listExperts.mockResolvedValue([
      expert({ id: "archived", name: "Archived", archived: true }),
    ]);
    const existing = overview();
    api.projectAgent.getOverview.mockResolvedValue(
      overview({ config: { ...existing.config!, expertIds: ["archived", "deleted"] } }),
    );
    await renderDialog();

    await page.getByRole("button", { name: "Experts" }).click();
    await expect.element(page.getByText("Archived · 已归档，不可用于新线程")).toBeInTheDocument();
    await expect.element(page.getByText("deleted · 不可用")).toBeInTheDocument();
    await page.getByRole("button", { name: "移除专家 Archived" }).click();
    await page.getByRole("button", { name: "移除专家 deleted" }).click();
    await page.getByRole("button", { name: "General" }).click();
    await page.getByLabelText("Hub goal").fill("updated without unavailable experts");
    await page.getByRole("button", { name: "Save", exact: true }).click();

    await vi.waitFor(() => expect(api.projectAgent.configure).toHaveBeenCalledOnce());
    const payload = api.projectAgent.configure.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(payload.expertIds).toEqual([]);
    expect(payload.goal).toBe("updated without unavailable experts");
  });

  it("shows a human roster error while preserving existing selections for unrelated saves", async () => {
    api.server.listExperts.mockRejectedValue(new Error("roster offline"));
    const existing = overview();
    api.projectAgent.getOverview.mockResolvedValue(
      overview({ config: { ...existing.config!, expertIds: ["persisted"] } }),
    );
    await renderDialog();

    await page.getByRole("button", { name: "Experts" }).click();
    await expect.element(page.getByRole("alert")).toHaveTextContent("无法读取专家：roster offline");
    await page.getByRole("button", { name: "General" }).click();
    await page.getByLabelText("Hub goal").fill("save despite roster outage");
    await page.getByRole("button", { name: "Save", exact: true }).click();

    await vi.waitFor(() => expect(api.projectAgent.configure).toHaveBeenCalledOnce());
    const payload = api.projectAgent.configure.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(payload.expertIds).toEqual(["persisted"]);
    expect(payload.goal).toBe("save despite roster outage");
  });

  it("allows zero-expert onboarding after a visible roster failure", async () => {
    api.server.listExperts.mockRejectedValue(new Error("roster offline"));
    api.projectAgent.getOverview.mockResolvedValue(
      overview({ configured: false, config: null, coordinatorStatus: "unconfigured" }),
    );
    await renderDialog({ mode: "onboarding" });

    await page.getByRole("button", { name: "Experts" }).click();
    await expect.element(page.getByRole("alert")).toHaveTextContent("roster offline");
    await page.getByRole("button", { name: "Create hub" }).click();

    await vi.waitFor(() => expect(api.projectAgent.configure).toHaveBeenCalledOnce());
    const payload = api.projectAgent.configure.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(payload.expertIds).toEqual([]);
  });

  it("shows the effective ceiling for a legacy limit while preserving the saved value until explicitly changed", async () => {
    const existing = overview();
    const legacy = overview({
      config: {
        ...existing.config!,
        limits: { ...existing.config!.limits, maxConcurrentWorkers: 16 },
      },
    });
    api.projectAgent.getOverview.mockResolvedValue(legacy);
    api.projectAgent.configure.mockResolvedValue(legacy);
    const screen = await renderDialog();
    try {
      await vi.waitFor(
        () =>
          expect(
            document.querySelector('[role="combobox"][aria-label="Parallel threads"]')?.textContent,
          ).toBe("8"),
        { timeout: 1_000 },
      );
      await page.getByLabelText("Hub goal").fill("keep existing limits");
      await page.getByRole("button", { name: "Save", exact: true }).click();
      await vi.waitFor(() => expect(api.projectAgent.configure).toHaveBeenCalledOnce());
      const unchanged = api.projectAgent.configure.mock.calls[0]?.[0] as {
        limits: { maxConcurrentWorkers: number };
      };
      expect(unchanged.limits.maxConcurrentWorkers).toBe(16);

      await page.getByRole("combobox", { name: "Parallel threads" }).click();
      await page.getByRole("option", { name: "8", exact: true }).click();
      await page.getByRole("button", { name: "Save", exact: true }).click();
      await vi.waitFor(() => expect(api.projectAgent.configure).toHaveBeenCalledTimes(2));
      const explicitlyChanged = api.projectAgent.configure.mock.calls[1]?.[0] as {
        limits: { maxConcurrentWorkers: number };
      };
      expect(explicitlyChanged.limits.maxConcurrentWorkers).toBe(8);
    } finally {
      await screen.unmount();
    }
  });

  it("clears the footer save error when the draft changes", async () => {
    api.projectAgent.configure.mockRejectedValue(new Error("invalid remote URL"));
    await renderDialog();

    await page.getByLabelText("Hub goal").fill("first attempt");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await vi.waitFor(() => {
      expect(document.body.textContent).toContain("invalid remote URL");
    });

    await page.getByLabelText("Hub goal").fill("corrected value");
    await vi.waitFor(() => {
      expect(document.body.textContent).not.toContain("invalid remote URL");
    });
  });

  it("saves coordinator icon and color through configure", async () => {
    await renderDialog();

    const brainButton = page.getByRole("button", { name: "Hub icon Brain" });
    await brainButton.click();
    await expect.element(brainButton).toHaveAttribute("aria-pressed", "true");

    const violetSwatch = page.getByRole("button", {
      name: "Hub icon color Violet",
    });
    await violetSwatch.click();
    await expect.element(violetSwatch).toHaveAttribute("aria-pressed", "true");

    await page.getByRole("button", { name: "Save", exact: true }).click();
    await vi.waitFor(() => expect(api.projectAgent.configure).toHaveBeenCalledOnce());
    const payload = api.projectAgent.configure.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(payload.coordinatorIcon).toBe("brain");
    expect(payload.coordinatorColor).toBe("violet");
  });

  it("clears stored appearance with Use default", async () => {
    api.projectAgent.getOverview.mockResolvedValue(
      overview({
        config: {
          ...(overview().config as object),
          coordinatorIcon: "brain",
          coordinatorColor: "violet",
        } as never,
      }),
    );
    await renderDialog();

    await expect
      .element(page.getByRole("button", { name: "Hub icon Brain" }))
      .toHaveAttribute("aria-pressed", "true");

    await page.getByRole("button", { name: "Use the default hub icon" }).click();
    await expect
      .element(page.getByRole("button", { name: "Hub icon Brain" }))
      .toHaveAttribute("aria-pressed", "false");

    await page.getByRole("button", { name: "Save", exact: true }).click();
    await vi.waitFor(() => expect(api.projectAgent.configure).toHaveBeenCalledOnce());
    const payload = api.projectAgent.configure.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(payload.coordinatorIcon).toBeNull();
    expect(payload.coordinatorColor).toBeNull();
  });

  it("dispatches project.meta.update when the hub is renamed", async () => {
    await renderDialog();

    await page.getByLabelText("Hub name").fill("beta");
    await page.getByRole("button", { name: "Save", exact: true }).click();

    await vi.waitFor(() => expect(api.projectAgent.configure).toHaveBeenCalledOnce());
    expect(api.orchestration.dispatchCommand).toHaveBeenCalledWith(
      expect.objectContaining({ type: "project.meta.update", title: "beta" }),
    );
    const payload = api.projectAgent.configure.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(payload.coordinatorName).toBe("beta");
  });

  it("autosaves Memory instructions to instructions.md", async () => {
    await renderDialog();

    await page.getByRole("button", { name: "Memory" }).click();
    const textarea = page.getByLabelText("Hub instructions");
    await textarea.fill("Always write tests first.");
    // Flush the debounced autosave by blurring.
    await page.getByRole("button", { name: "General" }).click();

    await vi.waitFor(() => expect(api.projectAgent.writeDocument).toHaveBeenCalled());
    const write = api.projectAgent.writeDocument.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(write.logicalPath).toBe("instructions.md");
    expect(write.content).toBe("Always write tests first.");
  });

  it("links and unlinks repositories from Environment", async () => {
    useStore.setState({
      projects: [
        makeProject({
          id: PROJECT_ID,
          kind: "group",
          name: "alpha",
          cwd: "/tmp/group",
        }),
        makeProject({ id: LINKED_ID, name: "linked-repo", cwd: "/tmp/linked" }),
        makeProject({
          id: CANDIDATE_ID,
          name: "candidate-repo",
          cwd: "/tmp/candidate",
        }),
      ],
    });
    api.projectAgent.getOverview.mockResolvedValue(overview({ linkedProjectIds: [LINKED_ID] }));
    api.projectAgent.linkProject.mockResolvedValue(overview());
    api.projectAgent.unlinkProject.mockResolvedValue(overview());

    await renderDialog();
    await page.getByRole("button", { name: "Environment" }).click();
    expect(document.body.textContent).toContain("linked-repo");

    await page.getByRole("button", { name: "Remove" }).click();
    await vi.waitFor(() =>
      expect(api.projectAgent.unlinkProject).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: PROJECT_ID,
          linkedProjectId: LINKED_ID,
        }),
      ),
    );

    await page.getByRole("button", { name: "Add repository" }).click();
    await page.getByRole("button", { name: /candidate-repo/ }).click();
    await vi.waitFor(() =>
      expect(api.projectAgent.linkProject).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: PROJECT_ID,
          linkedProjectId: CANDIDATE_ID,
        }),
      ),
    );
  });

  it("shows the onboarding copy and Create hub button", async () => {
    api.projectAgent.getOverview.mockResolvedValue(
      overview({
        configured: false,
        config: null,
        coordinatorStatus: "unconfigured",
      }),
    );
    await renderDialog({ mode: "onboarding" });
    expect(document.body.textContent).toContain("Set up your hub");
    await expect.element(page.getByRole("button", { name: "Create hub" })).toBeInTheDocument();
  });

  it("links a source Project before configuring and retries the same Hub after a link failure", async () => {
    api.projectAgent.getOverview.mockResolvedValue(
      overview({
        configured: false,
        config: null,
        coordinatorStatus: "unconfigured",
      }),
    );
    api.projectAgent.linkProject
      .mockRejectedValueOnce(new Error("temporary link failure"))
      .mockResolvedValueOnce(
        overview({
          configured: false,
          config: null,
          linkedProjectIds: [SOURCE_ID],
        }),
      );
    const onSourceProjectLinked = vi.fn();
    await renderDialog({
      mode: "onboarding",
      sourceProjectId: SOURCE_ID,
      sourceLinkRequestId: "source-link-request-1",
      onSourceProjectLinked,
    });

    await page.getByRole("button", { name: "Create hub" }).click();
    await vi.waitFor(() => {
      expect(document.body.textContent).toContain("temporary link failure");
    });
    expect(api.projectAgent.configure).not.toHaveBeenCalled();

    await page.getByRole("button", { name: "Create hub" }).click();
    await vi.waitFor(() => expect(api.projectAgent.configure).toHaveBeenCalledOnce());

    expect(api.projectAgent.linkProject).toHaveBeenCalledTimes(2);
    expect(api.projectAgent.linkProject.mock.calls[0]?.[0]).toEqual({
      requestId: "source-link-request-1",
      projectId: PROJECT_ID,
      linkedProjectId: SOURCE_ID,
      contextSource: true,
    });
    expect(api.projectAgent.linkProject.mock.calls[1]?.[0]).toEqual(
      api.projectAgent.linkProject.mock.calls[0]?.[0],
    );
    const configurePayload = api.projectAgent.configure.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(configurePayload.sourceProjectId).toBe(SOURCE_ID);
    expect(api.projectAgent.linkProject.mock.invocationCallOrder[1]).toBeLessThan(
      api.projectAgent.configure.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(onSourceProjectLinked).toHaveBeenCalledOnce();
    expect(onSourceProjectLinked).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      sourceProjectId: SOURCE_ID,
      sourceLinkRequestId: "source-link-request-1",
    });
  });

  it("does not repeat an already successful source link when configuring", async () => {
    api.projectAgent.getOverview.mockResolvedValue(
      overview({
        configured: false,
        config: null,
        linkedProjectIds: [SOURCE_ID],
        coordinatorStatus: "unconfigured",
      }),
    );
    await renderDialog({ mode: "onboarding", sourceProjectId: SOURCE_ID });

    await page.getByRole("button", { name: "Create hub" }).click();
    await vi.waitFor(() => expect(api.projectAgent.configure).toHaveBeenCalledOnce());

    expect(api.projectAgent.linkProject).not.toHaveBeenCalled();
    expect(api.projectAgent.configure.mock.calls[0]?.[0]).toMatchObject({
      projectId: PROJECT_ID,
      sourceProjectId: SOURCE_ID,
    });
  });

  it("restores the explicit source from an unconfigured Hub overview after reopening", async () => {
    api.projectAgent.getOverview.mockResolvedValue(
      overview({
        configured: false,
        config: null,
        sourceProjectId: SOURCE_ID,
        linkedProjectIds: [SOURCE_ID],
        coordinatorStatus: "unconfigured",
      }),
    );
    await renderDialog({ mode: "onboarding" });

    await page.getByRole("button", { name: "Create hub" }).click();
    await vi.waitFor(() => expect(api.projectAgent.configure).toHaveBeenCalledOnce());

    expect(api.projectAgent.linkProject).not.toHaveBeenCalled();
    expect(api.projectAgent.configure.mock.calls[0]?.[0]).toMatchObject({
      projectId: PROJECT_ID,
      sourceProjectId: SOURCE_ID,
    });
  });

  it("does not infer origin from ordinary linked projects", async () => {
    api.projectAgent.getOverview.mockResolvedValue(
      overview({
        configured: false,
        config: null,
        linkedProjectIds: [LINKED_ID],
        coordinatorStatus: "unconfigured",
      }),
    );
    await renderDialog({ mode: "onboarding" });

    await page.getByRole("button", { name: "Create hub" }).click();
    await vi.waitFor(() => expect(api.projectAgent.configure).toHaveBeenCalledOnce());

    expect(api.projectAgent.configure.mock.calls[0]?.[0]).not.toHaveProperty("sourceProjectId");
  });

  it("keeps the hub and closes onboarding when discard is declined", async () => {
    api.projectAgent.getOverview.mockResolvedValue(
      overview({
        configured: false,
        config: null,
        coordinatorStatus: "unconfigured",
      }),
    );
    const onOpenChange = vi.fn();
    await renderDialog({
      mode: "onboarding",
      allowDiscard: true,
      onOpenChange,
    });

    await page.getByRole("button", { name: "Cancel" }).click();
    await expect.element(page.getByRole("button", { name: "Keep hub" })).toBeInTheDocument();

    await page.getByRole("button", { name: "Keep hub" }).click();
    await vi.waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    // The setup dialog itself must close too — a re-open would re-prompt.
    await vi.waitFor(() => expect(document.body.textContent).not.toContain("Discard this hub?"));
    expect(api.projectAgent.deleteGroup).not.toHaveBeenCalled();
  });

  it("discards a still-empty onboarding hub with requireEmpty", async () => {
    api.projectAgent.getOverview.mockResolvedValue(
      overview({
        configured: false,
        config: null,
        coordinatorStatus: "unconfigured",
      }),
    );
    const onOpenChange = vi.fn();
    await renderDialog({
      mode: "onboarding",
      allowDiscard: true,
      onOpenChange,
    });

    await page.getByRole("button", { name: "Cancel" }).click();
    await page.getByRole("button", { name: "Discard hub" }).click();

    await vi.waitFor(() =>
      expect(api.projectAgent.deleteGroup).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: PROJECT_ID,
          confirmName: "alpha",
          requireEmpty: true,
        }),
      ),
    );
    await vi.waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it("notifies the caller after a source-linked onboarding hub is discarded", async () => {
    api.projectAgent.getOverview.mockResolvedValue(
      overview({
        configured: false,
        config: null,
        coordinatorStatus: "unconfigured",
      }),
    );
    const onDiscarded = vi.fn();
    await renderDialog({
      mode: "onboarding",
      allowDiscard: true,
      sourceProjectId: SOURCE_ID,
      sourceLinkRequestId: "source-link-request",
      onDiscarded,
    });

    await page.getByRole("button", { name: "Cancel" }).click();
    await page.getByRole("button", { name: "Discard hub" }).click();

    await vi.waitFor(() =>
      expect(onDiscarded).toHaveBeenCalledWith({
        projectId: PROJECT_ID,
        sourceProjectId: SOURCE_ID,
        sourceLinkRequestId: "source-link-request",
      }),
    );
  });

  it("retains the pending caller identity when hub deletion fails", async () => {
    api.projectAgent.deleteGroup.mockResolvedValueOnce(null as never);
    const onDiscarded = vi.fn();
    await renderDialog({
      mode: "onboarding",
      allowDiscard: true,
      sourceProjectId: SOURCE_ID,
      sourceLinkRequestId: "source-link-request",
      onDiscarded,
    });

    await page.getByRole("button", { name: "Cancel" }).click();
    await page.getByRole("button", { name: "Discard hub" }).click();

    await vi.waitFor(() =>
      expect(document.body.textContent).toContain("Could not delete this hub."),
    );
    expect(onDiscarded).not.toHaveBeenCalled();
  });

  it("never offers discard for a hub that already has threads", async () => {
    api.projectAgent.getOverview.mockResolvedValue(
      overview({
        configured: false,
        config: null,
        coordinatorStatus: "unconfigured",
      }),
    );
    api.projectAgent.listThreadIndex.mockResolvedValue({
      threads: [{ threadId: "worker-1" }],
    });
    const onOpenChange = vi.fn();
    await renderDialog({
      mode: "onboarding",
      allowDiscard: true,
      onOpenChange,
    });

    await page.getByRole("button", { name: "Cancel" }).click();

    await vi.waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(document.body.textContent).not.toContain("Discard this hub?");
    expect(api.projectAgent.deleteGroup).not.toHaveBeenCalled();
  });
});
