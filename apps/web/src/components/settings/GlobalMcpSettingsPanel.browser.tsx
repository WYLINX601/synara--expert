import "../../index.css";

import type { McpImportResult } from "@synara/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { page } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  setExpertConnectionState: ServerMock;
  discoverMcpConnections: ServerMock;
  importMcpConnections: ServerMock;
};

const harness = vi.hoisted(() => {
  const makeConnection = () => ({
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
  });
  const makeExpert = (
    connections: Array<{
      id: string;
      enabled?: boolean;
      required: boolean;
      toolMode?: "all" | "selected";
      tools: string[];
    }> = [],
  ) => ({
    id: "planner",
    name: "规划专家",
    description: "处理规划任务",
    useCases: "",
    persona: "",
    outputRequirements: "",
    skills: [],
    references: [],
    connections,
    preferredProvider: "codex" as const,
    revision: 7,
    archived: false,
    updatedAt: "2026-10-03T00:00:00.000Z",
  });
  const state = {
    connection: makeConnection(),
    extraConnections: [] as ReturnType<typeof makeConnection>[],
    expert: makeExpert(),
    extraExperts: [] as ReturnType<typeof makeExpert>[],
    connectionStateFailure: false,
    referencesFailure: false,
    references: {
      experts: [] as Array<Record<string, unknown>>,
      snapshots: [] as Array<Record<string, unknown>>,
      tasks: [] as Array<Record<string, unknown>>,
      activeSessionCount: 0,
    },
    setQueryData: vi.fn(),
    invalidateQueries: vi.fn(async () => {}),
    stateResult(id: string) {
      return state.connectionStateFailure
        ? {
            data: undefined,
            isError: true,
            isLoading: false,
            error: new Error("状态读取失败"),
          }
        : {
            data: {
              id,
              status: "active",
              revision: 2,
              updatedAt: "2026-10-03T00:00:00.000Z",
            },
            isError: false,
            isLoading: false,
            error: undefined,
          };
    },
    referencesResult() {
      return state.referencesFailure
        ? {
            data: undefined,
            isError: true,
            isLoading: false,
            error: new Error("引用读取失败测试"),
          }
        : {
            data: state.references,
            isError: false,
            isLoading: false,
            error: undefined,
          };
    },
    server: {} as HarnessServer,
  };
  state.server = {
    listExperts: vi.fn(async () => [state.expert]),
    listExpertConnections: vi.fn(async () => [state.connection]),
    getExpertConnectionState: vi.fn(async ({ id }: { id: string }) => {
      if (state.connectionStateFailure) throw new Error("状态读取失败");
      return {
        id,
        status: "active",
        revision: 2,
        updatedAt: "2026-10-03T00:00:00.000Z",
      };
    }),
    readExpertConnectionReferences: vi.fn(async () => {
      if (state.referencesFailure) throw new Error("引用读取失败测试");
      return state.references;
    }),
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
    saveExpertConnection: vi.fn(async (input: Record<string, unknown>) => ({
      ...state.connection,
      ...input,
      revision: state.connection.revision + 1,
      updatedAt: "2026-10-03T00:02:00.000Z",
    })),
    removeExpertConnection: vi.fn(async () => {}),
    testExpertConnection: vi.fn(async () => ({
      revision: 3,
      tools: ["issues.search", "issues.read"],
    })),
    setExpertConnectionState: vi.fn(async () => ({
      id: "linear",
      status: "disabled",
      revision: 3,
      updatedAt: "2026-10-03T00:03:00.000Z",
    })),
    discoverMcpConnections: vi.fn(async () => ({
      scanId: "scan-local",
      sources: [],
      candidates: [],
    })),
    importMcpConnections: vi.fn(async () => ({ scanId: "scan-local", items: [] })),
  };
  return state;
});

vi.mock("@tanstack/react-query", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-query")>()),
  useQueryClient: () => ({
    setQueryData: harness.setQueryData,
    invalidateQueries: harness.invalidateQueries,
  }),
  useQuery: ({ queryKey }: { queryKey: ReadonlyArray<unknown> }) => {
    if (queryKey[1] === "experts")
      return {
        data: [harness.expert, ...harness.extraExperts],
        isLoading: false,
        isError: false,
        error: undefined,
      };
    if (queryKey[1] === "expertConnectionState")
      return harness.stateResult(String(queryKey[2] ?? ""));
    if (queryKey[1] === "expertConnectionReferences") return harness.referencesResult();
    return {
      data: [harness.connection, ...harness.extraConnections],
      isLoading: false,
      isError: false,
      error: undefined,
    };
  },
  useQueries: ({ queries }: { queries: ReadonlyArray<{ queryKey: ReadonlyArray<unknown> }> }) =>
    queries.map((query) => harness.stateResult(String(query.queryKey[2] ?? ""))),
}));
vi.mock("~/nativeApi", () => ({ ensureNativeApi: () => ({ server: harness.server }) }));
vi.mock("~/components/ui/toast", () => ({ toastManager: { add: vi.fn() } }));
vi.mock("./ExternalMcpSettingsPanel", () => ({ ExternalMcpSettingsPanel: () => null }));

import { GlobalMcpSettingsPanel } from "./GlobalMcpSettingsPanel";
import { toastManager } from "~/components/ui/toast";

let cleanupMountedPanel: (() => Promise<void>) | null = null;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function addSecondConnection() {
  harness.extraConnections = [{ ...harness.connection, id: "second", name: "Second MCP" }];
}

async function leaveDraft() {
  await page.getByRole("button", { name: "← 返回连接列表", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "放弃更改", exact: true }).click();
}

async function renderPanel(props: Parameters<typeof GlobalMcpSettingsPanel>[0] = {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
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
    component: () => <GlobalMcpSettingsPanel {...props} />,
  });
  const router = createRouter({
    routeTree: root.addChildren([settings]),
    history: createMemoryHistory({ initialEntries: ["/settings"] }),
  });
  const view = await render(<RouterProvider router={router} />);
  cleanupMountedPanel = async () => {
    await view.unmount();
    queryClient.clear();
  };
}

afterEach(async () => {
  await cleanupMountedPanel?.();
  cleanupMountedPanel = null;
});

beforeEach(() => {
  harness.extraConnections = [];
  harness.extraExperts = [];
  vi.mocked(toastManager.add).mockClear();
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
    connections: [],
    preferredProvider: "codex",
    revision: 7,
    archived: false,
    updatedAt: "2026-10-03T00:00:00.000Z",
  };
  harness.connectionStateFailure = false;
  harness.referencesFailure = false;
  harness.references = { experts: [], snapshots: [], tasks: [], activeSessionCount: 0 };
  harness.setQueryData.mockClear();
  harness.invalidateQueries.mockClear();
  for (const operation of Object.values(harness.server)) operation.mockClear();
  harness.server.testExpertConnection.mockResolvedValue({
    revision: 3,
    tools: ["issues.search", "issues.read"],
  });
  harness.server.discoverMcpConnections.mockResolvedValue({
    scanId: "scan-local",
    sources: [
      {
        kind: "codex",
        path: "/tmp/synara-browser-test/.codex/config.toml",
        status: "ready",
      },
    ],
    candidates: [
      {
        candidateId: "candidate-new",
        sourceKind: "codex",
        sourcePath: "/tmp/synara-browser-test/.codex/config.toml",
        sourceEntryId: "acme-issues",
        sources: [
          {
            kind: "codex",
            path: "/tmp/synara-browser-test/.codex/config.toml",
            entryId: "acme-issues",
          },
          {
            kind: "cc-switch",
            path: "/tmp/synara-browser-test/cc-switch.db",
            entryId: "mcpServers.acme-issues",
          },
        ],
        suggestedId: "acme-issues",
        name: "Acme Issues",
        protocol: "stdio",
        summary: "npx -y acme-issues-mcp",
        status: "ready",
        issues: [],
      },
      {
        candidateId: "candidate-conflict",
        sourceKind: "codex",
        sourcePath: "/tmp/synara-browser-test/.codex/config.toml",
        sourceEntryId: "linear-import",
        suggestedId: "linear-import",
        name: "Linear 工作区",
        protocol: "stdio",
        summary: "npx -y linear-mcp",
        status: "conflict",
        issues: [],
        existingId: "linear",
        existingRevision: 3,
      },
    ],
  });
  harness.server.importMcpConnections.mockResolvedValue({
    scanId: "scan-local",
    items: [
      {
        candidateId: "candidate-new",
        targetId: "acme-issues",
        status: "imported",
        revision: 1,
      },
      {
        candidateId: "candidate-conflict",
        targetId: "linear",
        status: "failed",
        message: "Connection changed after discovery.",
      },
    ],
  });
});

describe("GlobalMcpSettingsPanel wrapper", () => {
  it.each([false, true])(
    "ignores a late retirement check after navigation (reopen A: %s)",
    async (reopen) => {
      addSecondConnection();
      const oldState = deferred<NonNullable<ReturnType<typeof harness.stateResult>["data"]>>();
      harness.server.getExpertConnectionState.mockImplementationOnce(() => oldState.promise);
      await renderPanel({ initialConnectionId: "linear" });
      await page.getByRole("button", { name: "退役", exact: true }).click();
      await expect.poll(() => harness.server.getExpertConnectionState.mock.calls.length).toBe(1);
      await page.getByRole("button", { name: "← 返回连接列表", exact: true }).click();
      await page.getByRole("button", { name: "Second MCP", exact: true }).click();
      if (reopen) {
        await page.getByRole("button", { name: "← 返回连接列表", exact: true }).click();
        await page.getByRole("button", { name: "Linear 工作区", exact: true }).click();
      }
      oldState.resolve(harness.stateResult("linear").data!);
      await expect.poll(() => page.getByRole("alertdialog").length).toBe(0);
      expect(harness.server.setExpertConnectionState).not.toHaveBeenCalled();

      await page.getByRole("button", { name: "退役", exact: true }).click();
      await expect.element(page.getByRole("alertdialog")).toBeVisible();
      await page.getByRole("button", { name: "确认退役", exact: true }).click();
      await expect.poll(() => harness.server.setExpertConnectionState.mock.calls.length).toBe(1);
      expect(harness.server.setExpertConnectionState).toHaveBeenCalledWith({
        id: reopen ? "linear" : "second",
        status: "retired",
        expectedRevision: 2,
      });
    },
  );

  it("keeps a newer connection check pending when an older request fails", async () => {
    addSecondConnection();
    const oldCheck = deferred<{ revision: number; tools: string[] }>();
    const newCheck = deferred<{ revision: number; tools: string[] }>();
    harness.server.testExpertConnection
      .mockImplementationOnce(() => oldCheck.promise)
      .mockImplementationOnce(() => newCheck.promise);
    await renderPanel({ initialConnectionId: "linear" });
    await page.getByRole("button", { name: "检查连接并读取工具", exact: true }).click();
    await page.getByRole("button", { name: "← 返回连接列表", exact: true }).click();
    await page.getByRole("button", { name: "Second MCP", exact: true }).click();
    await page.getByRole("button", { name: "检查连接并读取工具", exact: true }).click();
    oldCheck.reject(new Error("old connection failure"));
    await expect.element(page.getByRole("button", { name: "检查中…", exact: true })).toBeDisabled();
    expect(page.getByText("old connection failure").length).toBe(0);
    newCheck.resolve({ revision: 3, tools: ["second.tool"] });
    await expect
      .element(page.getByRole("button", { name: "检查连接并读取工具", exact: true }))
      .toBeEnabled();
  });

  it.each(["success", "failure"] as const)(
    "does not replace B's draft after A's late save %s",
    async (outcome) => {
      addSecondConnection();
      const saved = deferred<typeof harness.connection>();
      harness.server.saveExpertConnection.mockImplementationOnce(() => saved.promise);
      await renderPanel({ initialConnectionId: "linear" });
      await page.getByRole("textbox", { name: "显示名称", exact: true }).fill("A edited");
      await page.getByRole("button", { name: "保存连接配置", exact: true }).click();
      await leaveDraft();
      await page.getByRole("button", { name: "Second MCP", exact: true }).click();
      const name = page.getByRole("textbox", { name: "显示名称", exact: true });
      await name.fill("B unsaved");
      if (outcome === "success")
        saved.resolve({ ...harness.connection, name: "A saved", revision: 4 });
      else saved.reject(new Error("A save failed"));
      await expect.element(name).toHaveValue("B unsaved");
      await expect
        .element(page.getByRole("button", { name: "保存连接配置", exact: true }))
        .toBeEnabled();
      expect(page.getByText("A save failed").length).toBe(0);
      expect(toastManager.add).not.toHaveBeenCalled();
      if (outcome === "success")
        await expect.poll(() => harness.setQueryData.mock.calls.length).toBe(1);
      else await expect.poll(() => harness.invalidateQueries.mock.calls.length).toBe(1);
    },
  );

  it.each(["success", "failure"] as const)(
    "does not replace a newly selected expert after a late authorization save %s",
    async (outcome) => {
      const grant = {
        id: "linear",
        enabled: true,
        required: false,
        toolMode: "all" as const,
        tools: [],
      };
      harness.expert.connections = [grant];
      harness.extraExperts = [{ ...harness.expert, id: "reviewer", name: "审查专家" }];
      const saved = deferred<typeof harness.expert>();
      harness.server.saveExpert.mockImplementationOnce(() => saved.promise);
      const onReturnToExpert = vi.fn();
      await renderPanel({
        initialConnectionId: "linear",
        initialExpertId: "planner",
        returnExpertId: "planner",
        onReturnToExpert,
      });
      await page.getByRole("radio", { name: "阻止启动", exact: true }).click();
      await page.getByRole("button", { name: "保存此专家授权", exact: true }).click();
      await page.getByRole("combobox", { name: "选择专家", exact: true }).selectOptions("reviewer");
      await page.getByRole("dialog").getByRole("button", { name: "放弃更改", exact: true }).click();
      await expect
        .element(page.getByRole("combobox", { name: "选择专家", exact: true }))
        .toHaveValue("reviewer");
      if (outcome === "success") {
        saved.resolve({
          ...harness.expert,
          revision: 8,
          connections: [{ ...grant, required: true }],
        });
        await expect.poll(() => harness.setQueryData.mock.calls.length).toBe(1);
      } else {
        saved.reject(new Error("Old authorization failed"));
        await expect.poll(() => harness.invalidateQueries.mock.calls.length).toBe(1);
      }
      await expect
        .element(page.getByRole("combobox", { name: "选择专家", exact: true }))
        .toHaveValue("reviewer");
      await expect
        .element(page.getByRole("radio", { name: "阻止启动", exact: true }))
        .not.toBeChecked();
      expect(onReturnToExpert).not.toHaveBeenCalled();
      expect(toastManager.add).not.toHaveBeenCalled();
      expect(page.getByText("Old authorization failed").length).toBe(0);
    },
  );

  it("only updates the original cache when a save settles after unmount", async () => {
    const saved = deferred<typeof harness.connection>();
    harness.server.saveExpertConnection.mockImplementationOnce(() => saved.promise);
    await renderPanel({ initialConnectionId: "linear" });
    await page.getByRole("textbox", { name: "显示名称", exact: true }).fill("A edited");
    await page.getByRole("button", { name: "保存连接配置", exact: true }).click();
    await cleanupMountedPanel?.();
    cleanupMountedPanel = null;
    saved.resolve({ ...harness.connection, name: "A saved", revision: 4 });
    await expect.poll(() => harness.setQueryData.mock.calls.length).toBe(1);
    expect(toastManager.add).not.toHaveBeenCalled();
  });

  it("does not roll back newer state after an older A confirmation settles on a reopened A", async () => {
    addSecondConnection();
    let cached = harness.stateResult("linear").data!;
    const readState = vi.spyOn(harness, "stateResult").mockImplementation((id) => ({
      data: { ...cached, id },
      isError: false,
      isLoading: false,
      error: undefined,
    }));
    harness.setQueryData.mockImplementation((key, update) => {
      if (key[1] === "expertConnectionState" && key[2] === "linear") {
        cached = typeof update === "function" ? update(cached) : update;
      }
    });
    const oldUpdate = deferred<typeof cached>();
    harness.server.setExpertConnectionState.mockImplementationOnce(() => oldUpdate.promise);
    try {
      await renderPanel({ initialConnectionId: "linear" });
      await page.getByRole("button", { name: "停用连接", exact: true }).click();
      await page.getByRole("button", { name: "确认停用", exact: true }).click();
      await expect.poll(() => harness.server.setExpertConnectionState.mock.calls.length).toBe(1);
      // The server committed disable, but its response is still in flight. A new view reads it.
      cached = { ...cached, status: "disabled", revision: 3 };
      const oldResponse = cached;
      await cleanupMountedPanel?.();
      cleanupMountedPanel = null;
      await renderPanel({ initialConnectionId: "second" });
      await page.getByRole("button", { name: "← 返回连接列表", exact: true }).click();
      await page.getByRole("button", { name: "Linear 工作区", exact: true }).click();
      harness.server.getExpertConnectionState.mockImplementationOnce(async () => cached);
      harness.server.setExpertConnectionState.mockResolvedValueOnce({
        ...cached,
        status: "active",
        revision: 4,
      });
      await page.getByRole("button", { name: "启用连接", exact: true }).click();
      await page.getByRole("button", { name: "确认启用", exact: true }).click();
      await expect.poll(() => cached.revision).toBe(4);
      oldUpdate.resolve(oldResponse);
      await expect.poll(() => harness.setQueryData.mock.calls.length).toBe(2);
      expect(cached).toMatchObject({ status: "active", revision: 4 });
      await expect
        .element(page.getByRole("button", { name: "停用连接", exact: true }))
        .toBeVisible();
      expect(toastManager.add).toHaveBeenCalledTimes(1);
    } finally {
      readState.mockRestore();
      harness.setQueryData.mockReset();
    }
  });

  it("uses the checked state version and blocks duplicate confirmation synchronously", async () => {
    harness.server.getExpertConnectionState.mockResolvedValueOnce({
      ...harness.stateResult("linear").data,
      revision: 8,
    });
    const update = deferred<{ id: string; status: string; revision: number; updatedAt: string }>();
    harness.server.setExpertConnectionState.mockImplementationOnce(() => update.promise);
    await renderPanel({ initialConnectionId: "linear" });
    await page.getByRole("button", { name: "退役", exact: true }).click();
    const button = page.getByRole("button", { name: "确认退役", exact: true });
    await expect.element(button).toBeVisible();
    (button.element() as HTMLButtonElement).click();
    (button.element() as HTMLButtonElement).click();
    await expect.poll(() => harness.server.setExpertConnectionState.mock.calls.length).toBe(1);
    expect(harness.server.setExpertConnectionState).toHaveBeenCalledWith({
      id: "linear",
      status: "retired",
      expectedRevision: 8,
    });
    update.reject(new Error("Connection state changed; reload before updating."));
    await expect
      .element(
        page
          .getByRole("alertdialog")
          .getByText("Connection state changed; reload before updating."),
      )
      .toBeVisible();
    expect(toastManager.add).not.toHaveBeenCalled();
  });

  it("uses the fixed config version for deletion", async () => {
    await renderPanel({ initialConnectionId: "linear" });
    await page.getByRole("button", { name: "删除", exact: true }).click();
    await page.getByRole("button", { name: "删除配置", exact: true }).click();
    await expect.poll(() => harness.server.removeExpertConnection.mock.calls.length).toBe(1);
    expect(harness.server.removeExpertConnection).toHaveBeenCalledWith({
      id: "linear",
      expectedRevision: 3,
    });
    await expect
      .element(page.getByRole("button", { name: "Linear 工作区", exact: true }))
      .toBeVisible();
  });

  it("keeps an invalid first grant behind the dirty-tab guard with discard still available", async () => {
    await renderPanel({ initialConnectionId: "linear", initialExpertId: "planner" });
    const pageSave = page.getByRole("button", { name: "保存此专家授权", exact: true });
    await expect.element(page.getByText(/至少需要选择一个工具/)).toBeVisible();
    await expect.element(pageSave).toBeDisabled();

    await page.getByRole("tab", { name: "应用接入", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await expect.element(dialog).toBeVisible();
    await expect.element(dialog.getByText(/至少需要选择一个工具/)).toBeVisible();
    await expect.element(dialog.getByRole("button", { name: "保存并继续" })).toBeDisabled();
    await expect.element(dialog.getByRole("button", { name: "放弃更改" })).toBeEnabled();
    await expect.element(dialog.getByRole("button", { name: "取消" })).toBeEnabled();

    await dialog.getByRole("button", { name: "取消", exact: true }).click();
    await expect.poll(() => dialog.length).toBe(0);
    await expect.element(pageSave).toBeDisabled();
    await expect
      .element(page.getByRole("tab", { name: "应用接入", exact: true }))
      .toHaveAttribute("aria-selected", "false");
    expect(harness.server.saveExpert).not.toHaveBeenCalled();

    await page.getByRole("tab", { name: "应用接入", exact: true }).click();
    await expect.element(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "放弃更改", exact: true }).click();
    await expect.poll(() => dialog.length).toBe(0);
    await expect
      .element(page.getByRole("tab", { name: "应用接入", exact: true }))
      .toHaveAttribute("aria-selected", "true");
    expect(harness.server.saveExpert).not.toHaveBeenCalled();
  });

  it("saves the selected first-grant tool and returns to the originating expert", async () => {
    const onReturnToExpert = vi.fn();
    await renderPanel({
      initialConnectionId: "linear",
      initialExpertId: "planner",
      returnExpertId: "planner",
      onReturnToExpert,
    });
    await page.getByRole("button", { name: "检查连接并读取工具", exact: true }).click();
    expect(harness.server.testExpertConnection).toHaveBeenCalledWith({
      id: "linear",
      expectedRevision: 3,
    });
    const tool = page.getByRole("checkbox", { name: "issues.search", exact: true });
    await expect.element(page.getByText("issues.search", { exact: true })).toBeVisible();
    await expect.element(tool).toBeVisible();
    await tool.click();
    await expect.element(tool).toBeChecked();
    const save = page.getByRole("button", { name: "保存此专家授权", exact: true });
    await expect.element(save).toBeEnabled();
    await save.click();

    await expect.poll(() => harness.server.saveExpert.mock.calls.length).toBe(1);
    expect(harness.server.saveExpert.mock.calls[0]?.[0]).toMatchObject({
      id: "planner",
      connections: [{ id: "linear", enabled: true, required: false, tools: ["issues.search"] }],
    });
    await expect.poll(() => onReturnToExpert.mock.calls.length).toBe(1);
    expect(onReturnToExpert).toHaveBeenCalledWith({
      expertId: "planner",
      connectionId: "linear",
    });
  });

  it("fails closed on reference-read failure and keeps deletion disabled", async () => {
    harness.referencesFailure = true;
    await renderPanel({ initialConnectionId: "linear" });

    const deleteButton = page.getByRole("button", { name: "删除", exact: true });
    await expect.element(deleteButton).toBeDisabled();
    await page.getByRole("tab", { name: "使用情况", exact: true }).click();
    await expect.element(page.getByText(/引用读取失败；无法确认影响，删除已禁用/)).toBeVisible();
    await expect.element(deleteButton).toBeDisabled();
    expect(harness.server.removeExpertConnection).not.toHaveBeenCalled();
  });

  it("shows unknown state and disables state actions when the state read fails", async () => {
    harness.connectionStateFailure = true;
    await renderPanel();

    await expect.element(page.getByText("未知", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Linear 工作区", exact: true }).click();
    await expect.element(page.getByText(/无法读取连接全局状态；全局状态操作已禁用/)).toBeVisible();
    await expect
      .poll(() => page.getByRole("button", { name: "启用连接", exact: true }).length)
      .toBe(0);
    await expect.element(page.getByRole("button", { name: "退役", exact: true })).toBeDisabled();
    expect(harness.server.setExpertConnectionState).not.toHaveBeenCalled();
  });

  it("retains a disabled binding's tools while preventing deletion", async () => {
    harness.expert = {
      ...harness.expert,
      connections: [{ id: "linear", enabled: false, required: false, tools: ["issues.search"] }],
    };
    harness.references = {
      experts: [
        {
          id: "planner",
          name: "规划专家",
          revision: 7,
          enabled: false,
          required: false,
          tools: ["issues.search"],
        },
      ],
      snapshots: [],
      tasks: [],
      activeSessionCount: 0,
    };
    await renderPanel({ initialConnectionId: "linear", initialExpertId: "planner" });

    const tool = page.getByRole("checkbox", { name: "issues.search", exact: true });
    await expect.element(page.getByText("issues.search", { exact: true })).toBeVisible();
    await expect.element(tool).toBeChecked();
    await expect.element(tool).toBeDisabled();
    await expect.element(page.getByRole("switch", { name: "允许使用" })).not.toBeChecked();
    await expect.element(page.getByRole("button", { name: "删除", exact: true })).toBeDisabled();
    expect(harness.server.removeExpertConnection).not.toHaveBeenCalled();
  });

  it("describes an all-tools expert reference without reporting an empty tool list", async () => {
    harness.references = {
      experts: [
        {
          id: "planner",
          name: "规划专家",
          revision: 7,
          enabled: true,
          required: false,
          toolMode: "all",
          tools: [],
        },
      ],
      snapshots: [],
      tasks: [],
      activeSessionCount: 0,
    };
    await renderPanel({ initialConnectionId: "linear" });

    await page.getByRole("tab", { name: "使用情况", exact: true }).click();
    await expect
      .element(page.getByText("规划专家 · v7 · 已启用 · 全部工具", { exact: true }))
      .toBeVisible();
  });

  it("imports one merged local MCP candidate directly and locks the selection while importing", async () => {
    let resolveImport!: (result: McpImportResult) => void;
    harness.server.importMcpConnections.mockImplementation(
      () =>
        new Promise<McpImportResult>((resolve) => {
          resolveImport = resolve;
        }),
    );
    await renderPanel();

    await page.getByRole("button", { name: "从本机发现", exact: true }).click();
    await expect.poll(() => harness.server.discoverMcpConnections.mock.calls.length).toBe(1);
    expect(harness.server.discoverMcpConnections).toHaveBeenCalledWith({});
    await expect.element(page.getByText("Acme Issues", { exact: true })).toBeVisible();
    await expect
      .element(page.getByRole("textbox", { name: "搜索发现结果", exact: true }))
      .toBeVisible();
    await expect
      .element(page.getByText("Codex · CC Switch · npx -y acme-issues-mcp", { exact: true }))
      .toBeVisible();
    await page.getByRole("textbox", { name: "搜索发现结果", exact: true }).fill("CC Switch");
    await expect.element(page.getByRole("checkbox", { name: "选择 Acme Issues" })).toBeVisible();
    expect(page.getByRole("checkbox", { name: "选择 Linear 工作区" }).length).toBe(0);
    await page.getByRole("textbox", { name: "搜索发现结果", exact: true }).fill("");
    for (const source of ["全部来源", "Codex", "CC Switch", "JSON"]) {
      expect(page.getByRole("button", { name: source, exact: true }).length).toBe(0);
    }
    expect(page.getByText(/只读扫描 Synara 服务所在电脑上的 Codex/).length).toBe(0);

    const emptyImport = page.getByRole("button", { name: "导入所选（0）", exact: true });
    await expect.element(emptyImport).toBeDisabled();
    await page.getByRole("checkbox", { name: "选择 Acme Issues", exact: true }).click();

    const importSelected = page.getByRole("button", { name: "导入所选（1）", exact: true });
    await expect.element(importSelected).toBeEnabled();
    await importSelected.click();

    const importing = page.getByRole("button", { name: "导入中…", exact: true });
    await expect.element(importing).toBeDisabled();
    await expect
      .element(page.getByRole("button", { name: "← 返回连接列表", exact: true }))
      .toBeDisabled();
    expect(harness.server.importMcpConnections).toHaveBeenCalledWith({
      scanId: "scan-local",
      items: [{ candidateId: "candidate-new", mode: "create", targetId: "acme-issues" }],
    });

    resolveImport({
      scanId: "scan-local",
      items: [
        {
          candidateId: "candidate-new",
          targetId: "acme-issues",
          status: "imported",
          revision: 1,
        },
      ],
    });
    await expect
      .element(page.getByRole("textbox", { name: "搜索 MCP 连接", exact: true }))
      .toBeVisible();
    expect(page.getByText("导入结果", { exact: true }).length).toBe(0);
    expect(toastManager.add).toHaveBeenCalledWith({
      type: "success",
      title: "已导入 1 个 MCP 连接",
    });
  });

  it("keeps the selected conflict policy and expected revision in a direct import", async () => {
    let resolveImport!: (result: McpImportResult) => void;
    harness.server.importMcpConnections.mockImplementation(
      () =>
        new Promise<McpImportResult>((resolve) => {
          resolveImport = resolve;
        }),
    );
    await renderPanel();
    await page.getByRole("button", { name: "从本机发现", exact: true }).click();
    await expect.poll(() => harness.server.discoverMcpConnections.mock.calls.length).toBe(1);

    const conflictMode = page.getByRole("combobox", {
      name: "处理 Linear 工作区 冲突",
      exact: true,
    });
    await conflictMode.selectOptions("update");
    await page.getByRole("button", { name: "导入所选（1）", exact: true }).click();
    await expect.element(page.getByRole("button", { name: "导入中…", exact: true })).toBeDisabled();
    await expect.element(conflictMode).toBeDisabled();
    await expect.poll(() => harness.server.importMcpConnections.mock.calls.length).toBe(1);
    expect(harness.server.importMcpConnections).toHaveBeenCalledWith({
      scanId: "scan-local",
      items: [
        {
          candidateId: "candidate-conflict",
          mode: "update",
          targetId: "linear",
          expectedRevision: 3,
        },
      ],
    });
    resolveImport({
      scanId: "scan-local",
      items: [
        {
          candidateId: "candidate-conflict",
          targetId: "linear",
          status: "failed",
          message: "Connection changed after discovery.",
        },
      ],
    });
    await expect
      .poll(() =>
        vi
          .mocked(toastManager.add)
          .mock.calls.some(
            ([toast]) =>
              toast.type === "error" &&
              String(toast.description).includes("Connection changed after discovery."),
          ),
      )
      .toBe(true);
    await expect
      .element(page.getByRole("textbox", { name: "搜索发现结果", exact: true }))
      .toBeVisible();
  });

  it("keeps private stdio credentials through edits and hides their IDs in the preview", async () => {
    const credentialId = "123e4567-e89b-42d3-a456-426614174010";
    const importedFrom = [
      { kind: "codex", path: "/tmp/codex/config.toml", entryId: "linear" },
      { kind: "cc-switch", path: "/tmp/cc-switch.db", entryId: "linear" },
    ];
    Object.assign(harness.connection.transport, {
      envFromHost: [],
      envFromSecret: { credentialId, names: ["LINEAR_TOKEN"] },
    });
    Object.assign(harness.connection, { importedFrom });
    await renderPanel({ initialConnectionId: "linear" });

    await page.getByText("查看脱敏配置预览", { exact: true }).click();
    await expect.element(page.getByText(/\[Synara 凭证\]/)).toBeVisible();
    await expect.element(page.getByText("已保存变量：LINEAR_TOKEN", { exact: true })).toBeVisible();
    expect(page.getByText(credentialId, { exact: true }).length).toBe(0);

    const hostMappings = page.getByPlaceholder("TOKEN=HOST_TOKEN", { exact: true });
    await hostMappings.fill("LINEAR_TOKEN=HOST_TOKEN");
    const save = page.getByRole("button", { name: "保存连接配置", exact: true });
    await expect
      .element(page.getByText("主机映射与已保存变量名称重复。", { exact: true }))
      .toBeVisible();
    await expect.element(save).toBeDisabled();
    await hostMappings.fill("");

    const name = page.getByRole("textbox", { name: "显示名称", exact: true });
    await name.fill("Linear 私有连接");
    await expect.element(save).toBeEnabled();
    await save.click();
    await expect.poll(() => harness.server.saveExpertConnection.mock.calls.length).toBe(1);
    expect(harness.server.saveExpertConnection.mock.calls[0]?.[0]).toMatchObject({
      id: "linear",
      name: "Linear 私有连接",
      importedFrom,
      transport: { type: "stdio", envFromSecret: { credentialId, names: ["LINEAR_TOKEN"] } },
    });
  });

  it("shows private HTTP header names in the preview without exposing credential IDs", async () => {
    const credentialId = "123e4567-e89b-42d3-a456-426614174011";
    Object.assign(harness.connection, {
      transport: {
        type: "http",
        url: "https://mcp.example.test/mcp",
        headersFromHost: [],
        headersFromSecret: { credentialId, names: ["Authorization", "X-Workspace"] },
      },
      importedFrom: [{ kind: "json", path: "/tmp/mcp.json", entryId: "servers:linear" }],
    });
    await renderPanel({ initialConnectionId: "linear" });

    await page.getByText("查看脱敏配置预览", { exact: true }).click();
    await expect.element(page.getByText(/\[Synara 凭证\]/)).toBeVisible();
    await expect
      .element(page.getByText("已保存请求头：Authorization、X-Workspace", { exact: true }))
      .toBeVisible();
    expect(page.getByText(credentialId, { exact: true }).length).toBe(0);
  });

  it("manages an all-tools grant without a tool check and preserves its mode", async () => {
    harness.expert = {
      ...harness.expert,
      connections: [{ id: "linear", enabled: true, required: false, toolMode: "all", tools: [] }],
    };
    const onReturnToExpert = vi.fn();
    await renderPanel({
      initialConnectionId: "linear",
      initialExpertId: "planner",
      returnExpertId: "planner",
      onReturnToExpert,
    });

    await expect.element(page.getByText("允许使用此连接的全部工具", { exact: true })).toBeVisible();
    await expect
      .element(page.getByText(/新任务首次启动时会自动读取此 MCP 提供的工具/u))
      .toBeVisible();
    expect(page.getByRole("checkbox").length).toBe(0);
    expect(page.getByText(/已选 0 \/ 0/u).length).toBe(0);

    await page.getByRole("radio", { name: "阻止启动", exact: true }).click();
    const save = page.getByRole("button", { name: "保存此专家授权", exact: true });
    await expect.element(save).toBeEnabled();
    await save.click();
    await expect.poll(() => harness.server.saveExpert.mock.calls.length).toBe(1);
    expect(harness.server.saveExpert.mock.calls[0]?.[0]).toMatchObject({
      connections: [{ id: "linear", enabled: true, required: true, toolMode: "all", tools: [] }],
    });
    expect(harness.server.testExpertConnection).not.toHaveBeenCalled();
    expect(onReturnToExpert).not.toHaveBeenCalled();
  });
});
