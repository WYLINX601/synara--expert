import "../../index.css";
import type {
  ExpertDefinition,
  NativeApi,
  SuiteComposition,
  SuiteImportReceipt,
  SuitePreview,
} from "@synara/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { page } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { SuiteCatalog } from "./SuiteCatalog";
import { clearSuiteImportJournal, readSuiteImportJournal } from "./suiteImportJournal";

const server = vi.hoisted(() => ({
  listSuites: vi.fn<NativeApi["server"]["listSuites"]>(),
  readSuite: vi.fn<NativeApi["server"]["readSuite"]>(),
  previewSuite: vi.fn<NativeApi["server"]["previewSuite"]>(),
  cancelSuitePreview: vi.fn<NativeApi["server"]["cancelSuitePreview"]>(),
  commitSuiteImport: vi.fn<NativeApi["server"]["commitSuiteImport"]>(),
  getSuiteImportReceipt: vi.fn<NativeApi["server"]["getSuiteImportReceipt"]>(),
  listExperts: vi.fn<NativeApi["server"]["listExperts"]>(),
}));
vi.mock("~/workbench/host/expertClient", () => ({ ensureExpertClient: () => server }));
vi.mock("~/nativeApi", () => ({
  ensureNativeApi: () => ({ server, dialogs: { pickFolder: async () => null } }),
}));
const ref = { suiteId: "suite_10000000-0000-4000-8000-000000000001", revision: 3 };
const expert: ExpertDefinition = {
  id: "member-1",
  name: "规范作者",
  description: "形成文档",
  useCases: "编写规范",
  persona: "作者",
  outputRequirements: "可交接",
  skills: [],
  references: [],
  connections: [],
  preferredProvider: "omp",
  revision: 1,
  archived: false,
  updatedAt: "2026-11-11T00:00:00.000Z",
};
const source = {
  kind: "local-folder" as const,
  sourceId: "local-source",
  contentHash: "a".repeat(64),
};
const composition: SuiteComposition = {
  schemaVersion: 1,
  ref,
  name: "规范套件",
  description: "共享规范",
  source,
  adapterId: "synara-suite-v1",
  adapterVersion: 1,
  members: [{ key: "author", expertId: expert.id, roleSourcePath: "roles/author.md" }],
  resources: [],
  defaults: {},
  compositionHash: "b".repeat(64),
  createdAt: "2026-11-11T00:00:00.000Z",
};
function preview(requestId: string, overrides: Partial<SuitePreview> = {}): SuitePreview {
  return {
    requestId,
    previewId: `preview-${requestId}`,
    expiresAt: "2026-11-12T00:00:00.000Z",
    source,
    contentHash: source.contentHash,
    adapterId: "synara-suite-v1",
    adapterVersion: 1,
    name: "规范套件",
    description: "共享规范",
    members: [{ key: "author", name: expert.name, description: expert.description }],
    resourceKeys: ["rules"],
    issues: [],
    ...overrides,
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}
let unmount: (() => Promise<void>) | undefined;
let client: QueryClient | undefined;
beforeEach(() => {
  vi.resetAllMocks();
  clearSuiteImportJournal();
  server.listSuites.mockResolvedValue([]);
  server.listExperts.mockResolvedValue([expert]);
  server.readSuite.mockResolvedValue(composition);
  server.cancelSuitePreview.mockResolvedValue({ cancelled: true });
  server.previewSuite.mockImplementation(async (request) => preview(request.requestId));
});
afterEach(async () => {
  await unmount?.();
  unmount = undefined;
  client?.clear();
  clearSuiteImportJournal();
});
async function mount(onUseExpert = vi.fn(async () => {})) {
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const view = await render(
    <QueryClientProvider client={client}>
      <SuiteCatalog onUseExpert={onUseExpert} />
    </QueryClientProvider>,
  );
  unmount = () => view.unmount();
  return onUseExpert;
}
async function readLocal() {
  await page.getByRole("button", { name: "导入 Suite", exact: true }).click();
  await page.getByRole("radio", { name: "本地文件夹", exact: true }).click();
  await page.getByLabelText("服务端可访问的套件文件夹").fill("/fixtures/suite");
  await page.getByRole("button", { name: "读取来源", exact: true }).click();
  await expect.poll(() => server.previewSuite.mock.calls.length).toBe(1);
}

describe("Suite import and direct use", () => {
  it("does not allow ordinary close or a second submission while the original commit is in flight", async () => {
    const { promise, resolve } = deferred<SuiteImportReceipt>();
    server.commitSuiteImport.mockReturnValueOnce(promise);
    await mount();
    await readLocal();
    await page.getByRole("button", { name: "导入", exact: true }).click();
    await expect.poll(() => server.commitSuiteImport.mock.calls.length).toBe(1);
    await expect
      .element(page.getByRole("button", { name: "返回目录", exact: true }))
      .toBeDisabled();
    expect(page.getByRole("radio", { name: "GitHub", exact: true }).elements()).toHaveLength(0);
    const request = server.commitSuiteImport.mock.calls[0]![0];
    resolve({ operationId: request.operationId, requestHash: "d".repeat(64), state: "pending" });
    await expect.element(page.getByRole("button", { name: "返回目录", exact: true })).toBeEnabled();
    expect(server.commitSuiteImport).toHaveBeenCalledTimes(1);
    expect(readSuiteImportJournal()?.request).toEqual(request);
  });
  it("allows commit after acknowledging a local dependency issue without pretending it was repaired", async () => {
    server.previewSuite.mockImplementation(async (request) =>
      preview(request.requestId, {
        issues: [
          {
            code: "resource_missing",
            category: "dependency",
            subject: { kind: "resource", id: "reference", path: "reference/missing.md" },
            action: "run",
            effect: "limit-capability",
            message: "参考资料缺失",
            evidenceRef: null,
            checkedAt: "2026-11-11T00:00:00.000Z",
            recovery: "repair-source",
          },
        ],
      }),
    );
    server.commitSuiteImport.mockImplementation(async (request) => ({
      operationId: request.operationId,
      requestHash: "d".repeat(64),
      state: "pending",
    }));
    await mount();
    await readLocal();
    await expect
      .element(page.getByRole("heading", { name: "识别问题", exact: true }))
      .toBeVisible();
    await page.getByRole("button", { name: "返回预览", exact: true }).click();
    expect(server.commitSuiteImport).not.toHaveBeenCalled();
    await page.getByRole("button", { name: "导入", exact: true }).click();
    await expect.poll(() => server.commitSuiteImport.mock.calls.length).toBe(1);
  });
  it("keeps each source input and discards a late preview after switching channels", async () => {
    const { promise, resolve } = deferred<SuitePreview>();
    server.previewSuite.mockReturnValueOnce(promise);
    await mount();
    await page.getByRole("button", { name: "导入 Suite", exact: true }).click();
    await page.getByLabelText("仓库或目录链接").fill("https://github.com/org/suite");
    await page.getByRole("button", { name: "读取来源", exact: true }).click();
    await expect.poll(() => server.previewSuite.mock.calls.length).toBe(1);
    const requestId = server.previewSuite.mock.calls[0]![0].requestId;
    await page.getByRole("radio", { name: "本地文件夹", exact: true }).click();
    await page.getByLabelText("服务端可访问的套件文件夹").fill("/local/retained");
    resolve(preview(requestId));
    await expect.poll(() => server.cancelSuitePreview.mock.calls.length).toBe(1);
    await expect
      .element(page.getByRole("button", { name: "导入", exact: true }))
      .not.toBeInTheDocument();
    await page.getByRole("radio", { name: "GitHub", exact: true }).click();
    await expect
      .element(page.getByLabelText("仓库或目录链接"))
      .toHaveValue("https://github.com/org/suite");
    await page.getByRole("radio", { name: "本地文件夹", exact: true }).click();
    await expect
      .element(page.getByLabelText("服务端可访问的套件文件夹"))
      .toHaveValue("/local/retained");
    expect(server.commitSuiteImport).not.toHaveBeenCalled();
  });
  it("opens an existing identity and uses the exact Suite revision without a new import", async () => {
    server.listSuites.mockResolvedValue([
      { ref, name: composition.name, description: composition.description },
    ]);
    const onUse = await mount();
    await readLocal();
    await page.getByRole("button", { name: "打开已有套件", exact: true }).click();
    await page.getByRole("button", { name: expert.name, exact: true }).click();
    await page.getByRole("button", { name: "使用此 Expert", exact: true }).click();
    expect(onUse).toHaveBeenCalledWith({ expertId: expert.id, suite: ref });
    expect(server.commitSuiteImport).not.toHaveBeenCalled();
  });
  it("requires explicit independent import when the same source has different content", async () => {
    server.listSuites.mockResolvedValue([
      { ref, name: composition.name, description: composition.description },
    ]);
    server.readSuite.mockResolvedValue({
      ...composition,
      source: { ...source, contentHash: "c".repeat(64) },
    });
    server.commitSuiteImport.mockImplementation(async (request) => ({
      operationId: request.operationId,
      requestHash: "d".repeat(64),
      state: "pending",
    }));
    await mount();
    await readLocal();
    await page.getByRole("button", { name: "作为新套件导入", exact: true }).click();
    await expect.poll(() => server.commitSuiteImport.mock.calls.length).toBe(1);
    expect(server.commitSuiteImport.mock.calls[0]![0].mode).toBe("independent-new-content");
    expect(readSuiteImportJournal()?.request).toEqual(server.commitSuiteImport.mock.calls[0]![0]);
    expect(page.getByText("Suite 已导入。", { exact: true }).elements()).toHaveLength(0);
  });
  it("retains an unknown request and reconciles its receipt after remount without resubmitting", async () => {
    server.commitSuiteImport.mockRejectedValue(new Error("connection lost"));
    server.getSuiteImportReceipt.mockRejectedValue(new Error("offline"));
    await mount();
    await readLocal();
    await page.getByRole("button", { name: "导入", exact: true }).click();
    await expect.element(page.getByRole("button", { name: "返回目录", exact: true })).toBeEnabled();
    const accepted = readSuiteImportJournal()!.request;
    await page.getByRole("button", { name: "返回目录", exact: true }).click();
    await unmount!();
    client?.clear();
    unmount = undefined;
    server.getSuiteImportReceipt.mockResolvedValue({
      operationId: accepted.operationId,
      requestHash: "d".repeat(64),
      state: "committed",
      suite: ref,
      reused: false,
    });
    await mount();
    await expect.element(page.getByText("Suite 已导入。", { exact: true })).toBeVisible();
    expect(server.commitSuiteImport).toHaveBeenCalledTimes(1);
    expect(server.getSuiteImportReceipt).toHaveBeenLastCalledWith({
      operationId: accepted.operationId,
    });
    expect(readSuiteImportJournal()).toBeNull();
  });
});
