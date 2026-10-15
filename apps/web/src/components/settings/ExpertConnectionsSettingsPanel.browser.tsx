import "../../index.css";

import { page } from "vitest/browser";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

type ServerMock = ReturnType<typeof vi.fn>;
type HarnessServer = {
  listExperts: ServerMock;
  listExpertConnections: ServerMock;
  getExpertConnectionState: ServerMock;
  readExpertConnectionReferences: ServerMock;
  saveExpert: ServerMock;
  saveExpertConnection: ServerMock;
  removeExpertConnection: ServerMock;
  testExpertConnection: ServerMock;
};

const harness = vi.hoisted(() => {
  const connection = {
    id: "linear",
    name: "Linear 工作区",
    transport: {
      type: "stdio" as const,
      command: "npx",
      args: ["-y", "linear-mcp"],
      envFromHost: [{ name: "LINEAR_TOKEN", envVar: "LINEAR_TOKEN" }],
    },
    revision: 3,
    updatedAt: "2026-10-03T00:00:00.000Z",
  };
  const expert = {
    id: "planner",
    name: "规划专家",
    description: "处理规划任务",
    useCases: "",
    persona: "",
    outputRequirements: "",
    skills: [],
    references: [],
    connections: [{ id: "linear", enabled: true, required: false, tools: ["legacy_search"] }],
    preferredProvider: "codex" as const,
    revision: 7,
    archived: false,
    updatedAt: "2026-10-03T00:00:00.000Z",
  };
  const state = {
    connection,
    expert,
    setQueryData: vi.fn(),
    invalidateQueries: vi.fn(async () => {}),
    server: {} as HarnessServer,
  };
  state.server = {
    listExperts: vi.fn(async () => [state.expert]),
    listExpertConnections: vi.fn(async () => [state.connection]),
    getExpertConnectionState: vi.fn(async ({ id }: { id: string }) => ({
      id,
      status: "active",
      revision: 2,
      updatedAt: "2026-10-03T00:00:00.000Z",
    })),
    readExpertConnectionReferences: vi.fn(async () => ({
      experts: [],
      snapshots: [],
      tasks: [],
      activeSessionCount: 0,
    })),
    saveExpert: vi.fn(async (input: Record<string, unknown>) => {
      const saved = {
        ...state.expert,
        ...input,
        revision: state.expert.revision + 1,
        updatedAt: "2026-10-03T00:01:00.000Z",
      };
      state.expert = saved;
      return saved;
    }),
    saveExpertConnection: vi.fn(async (input: Record<string, unknown>) => {
      const saved = {
        ...state.connection,
        ...input,
        revision: state.connection.revision + 1,
        updatedAt: "2026-10-03T00:02:00.000Z",
      };
      state.connection = saved;
      return saved;
    }),
    removeExpertConnection: vi.fn(async () => {}),
    testExpertConnection: vi.fn(async () => ({
      revision: 3,
      tools: ["issues.search", "issues.read"],
    })),
  };
  return state;
});

vi.mock("@tanstack/react-query", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-query")>()),
  useQueryClient: () => ({
    setQueryData: harness.setQueryData,
    invalidateQueries: harness.invalidateQueries,
  }),
  useQuery: ({ queryKey }: { queryKey: ReadonlyArray<unknown> }) => ({
    data:
      queryKey[1] === "experts"
        ? [harness.expert]
        : queryKey[1] === "expertConnectionState"
          ? {
              id: queryKey[2],
              status: "active",
              revision: 2,
              updatedAt: "2026-10-03T00:00:00.000Z",
            }
          : queryKey[1] === "expertConnectionReferences"
            ? { experts: [], snapshots: [], tasks: [], activeSessionCount: 0 }
            : [harness.connection],
    isLoading: false,
    isError: false,
    error: undefined,
  }),
  useQueries: ({ queries }: { queries: ReadonlyArray<{ queryKey: ReadonlyArray<unknown> }> }) =>
    queries.map((query) => ({
      data: {
        id: query.queryKey[2],
        status: "active",
        revision: 2,
        updatedAt: "2026-10-03T00:00:00.000Z",
      },
      isError: false,
      isLoading: false,
    })),
}));
vi.mock("./useExpertDraftGuard", () => ({
  useExpertDraftGuard: () => ({ confirmLeave: vi.fn(async () => true), dialog: null }),
}));
vi.mock("~/nativeApi", () => ({ ensureNativeApi: () => ({ server: harness.server }) }));
vi.mock("~/components/ui/toast", () => ({ toastManager: { add: vi.fn() } }));
vi.mock("./ExternalMcpSettingsPanel", () => ({ ExternalMcpSettingsPanel: () => null }));

import { ExpertConnectionsSettingsPanel } from "./ExpertConnectionsSettingsPanel";

beforeEach(() => {
  harness.connection = {
    id: "linear",
    name: "Linear 工作区",
    transport: {
      type: "stdio",
      command: "npx",
      args: ["-y", "linear-mcp"],
      envFromHost: [{ name: "LINEAR_TOKEN", envVar: "LINEAR_TOKEN" }],
    },
    revision: 3,
    updatedAt: "2026-10-03T00:00:00.000Z",
  };
  harness.expert = {
    id: "planner",
    name: "规划专家",
    description: "处理规划任务",
    useCases: "",
    persona: "",
    outputRequirements: "",
    skills: [],
    references: [],
    connections: [{ id: "linear", enabled: true, required: false, tools: ["legacy_search"] }],
    preferredProvider: "codex",
    revision: 7,
    archived: false,
    updatedAt: "2026-10-03T00:00:00.000Z",
  };
  harness.setQueryData.mockClear();
  harness.invalidateQueries.mockClear();
  for (const operation of Object.values(harness.server)) operation.mockClear();
  harness.server.testExpertConnection.mockResolvedValue({
    revision: 3,
    tools: ["issues.search", "issues.read"],
  });
});

describe("ExpertConnectionsSettingsPanel", () => {
  it("returns from a filtered detail page with the search intact", async () => {
    await render(<ExpertConnectionsSettingsPanel />);
    const search = page.getByRole("textbox", { name: "搜索 MCP 连接" });
    await search.fill("Linear");
    await page.getByRole("button", { name: "Linear 工作区", exact: true }).click();
    await page.getByRole("button", { name: "← 返回连接列表", exact: true }).click();
    await expect.element(search).toHaveValue("Linear");
    expect(page.getByText("Linear 工作区", { exact: true })).toBeVisible();
  });

  it("runs checks only on explicit request and marks their returned revision stale after a config save", async () => {
    await render(<ExpertConnectionsSettingsPanel />);
    expect(harness.server.testExpertConnection).not.toHaveBeenCalled();
    await page.getByRole("button", { name: "Linear 工作区", exact: true }).click();
    await page.getByRole("button", { name: "检查连接并读取工具", exact: true }).click();
    expect(harness.server.testExpertConnection).toHaveBeenCalledWith({
      id: "linear",
      expectedRevision: 3,
    });
    await expect.element(page.getByText(/最近检查/)).toBeVisible();
    await page.getByRole("textbox", { name: "显示名称" }).fill("Linear 更新");
    await page.getByRole("button", { name: "保存连接配置", exact: true }).click();
    await expect.element(page.getByText(/已过期/)).toBeVisible();
    expect(harness.server.testExpertConnection).toHaveBeenCalledOnce();
  });

  it("saves a new connection without testing it and makes the saved ID read-only", async () => {
    await render(<ExpertConnectionsSettingsPanel />);
    await page.getByRole("button", { name: "添加连接", exact: true }).click();
    await page.getByRole("textbox", { name: "连接 ID" }).fill("linear-copy");
    await page.getByRole("textbox", { name: "显示名称" }).fill("Linear 副本");
    await page.getByRole("textbox", { name: "启动命令" }).fill("npx");
    await page.getByRole("button", { name: "保存连接配置", exact: true }).click();
    expect(harness.server.saveExpertConnection).toHaveBeenCalledOnce();
    expect(harness.server.testExpertConnection).not.toHaveBeenCalled();
    await expect
      .element(page.getByRole("textbox", { name: "连接 ID" }))
      .toHaveAttribute("readonly");
  });

  it("preserves the existing whitelist when an expert binding is disabled and enabled again", async () => {
    await render(<ExpertConnectionsSettingsPanel />);
    await page.getByRole("button", { name: "1 位专家", exact: true }).click();
    await page.getByRole("combobox", { name: "选择专家" }).selectOptions("planner");
    const allow = page.getByRole("switch", { name: "允许使用" });
    await allow.click();
    await page.getByRole("button", { name: "保存此专家授权", exact: true }).click();
    expect(harness.server.saveExpert).toHaveBeenCalledTimes(1);
    expect(harness.server.saveExpert.mock.calls[0]?.[0]).toMatchObject({
      connections: [{ id: "linear", enabled: false, tools: ["legacy_search"] }],
    });
    await page.getByRole("switch", { name: "允许使用" }).click();
    await page.getByRole("button", { name: "保存此专家授权", exact: true }).click();
    expect(harness.server.saveExpert).toHaveBeenCalledTimes(2);
    expect(harness.server.saveExpert.mock.calls[1]?.[0]).toMatchObject({
      connections: [{ id: "linear", enabled: true, tools: ["legacy_search"] }],
    });
  });

  it("can remove a saved whitelist item without checking again and blocks an empty enabled grant", async () => {
    await render(<ExpertConnectionsSettingsPanel />);
    await page.getByRole("button", { name: "1 位专家", exact: true }).click();
    await page.getByRole("combobox", { name: "选择专家" }).selectOptions("planner");
    const tool = page.getByRole("checkbox", { name: /legacy_search/u });
    await tool.click();
    await expect
      .element(page.getByText("此连接尚未授权工具。选择至少一项后才能保存。"))
      .toBeVisible();
    const save = page.getByRole("button", { name: "保存此专家授权", exact: true });
    await expect.element(save).toBeDisabled();
    expect(harness.server.testExpertConnection).not.toHaveBeenCalled();
    expect(harness.server.saveExpert).not.toHaveBeenCalled();
  });
});
