import "../../index.css";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { page } from "vitest/browser";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import type {
  SkillPackage,
  SkillPackagePreview,
  SkillPackageRemovalPreview,
  SkillPackageSource,
  SkillPackageUpdatePreview,
} from "@synara/contracts";

const harness = vi.hoisted(() => ({
  connectionGeneration: "connection-a",
  connected: true,
  server: {
    listSkillPackages: vi.fn(async (): Promise<SkillPackage[]> => []),
    listSkillPackageSources: vi.fn(async (): Promise<SkillPackageSource[]> => []),
    readSkillPackage: vi.fn(async () => packageContent),
    previewSkillPackage: vi.fn(async () => importPreview),
    previewSkillPackageUpdate: vi.fn(async () => updatePreview),
    previewSkillPackageRemoval: vi.fn(
      async (): Promise<SkillPackageRemovalPreview> => ({ packageId, references: [] }),
    ),
    importSkillPackage: vi.fn(async () => importResult),
    removeSkillPackage: vi.fn(async () => undefined),
  },
}));

const packageId = `pkg_${"a".repeat(64)}`;
const packageContent: SkillPackage = {
  schemaVersion: 1,
  packageId,
  rootName: "planner-bundle",
  resources: [
    {
      path: "planner/SKILL.md",
      kind: "file",
      size: 240,
      sha256: "a".repeat(64),
    },
    { path: "planner", kind: "directory", size: 0, sha256: "b".repeat(64) },
    {
      path: "planner/scripts/check.py",
      kind: "file",
      size: 96,
      sha256: "c".repeat(64),
      executable: true,
    },
  ],
  entries: [
    {
      entryPath: "planner/SKILL.md",
      name: "Planner",
      description: "Plan work in small steps.",
      issues: [],
    },
  ],
  fileCount: 2,
  totalBytes: 336,
};
const importPreview: SkillPackagePreview = {
  previewId: "preview-import-1",
  sourcePath: "/source/planner",
  realRoot: "/source/planner",
  expiresAt: "2026-10-20T12:00:00.000Z",
  package: packageContent,
  issues: [],
};
const source: SkillPackageSource = {
  sourceId: `src_${"b".repeat(64)}`,
  sourcePath: "/source/planner",
  realRoot: "/source/planner",
  packageId,
  revision: 1,
  importedAt: "2026-10-20T12:00:00.000Z",
};
const updatePreview: SkillPackageUpdatePreview = {
  ...importPreview,
  previewId: "preview-update-1",
  sourceId: source.sourceId,
  sourceRevision: 2,
  previousPackageId: packageId,
  addedEntries: ["planner/review/SKILL.md"],
  changedEntries: ["planner/SKILL.md"],
  removedEntries: ["planner/old/SKILL.md"],
  resourceChanges: [{ path: "planner/scripts/check.py", change: "changed" }],
};
const importResult = {
  package: packageContent,
  source: { ...source, revision: 2 },
  reused: false,
};

vi.mock("~/nativeApi", () => ({ ensureNativeApi: () => ({ server: harness.server }) }));
vi.mock("~/hooks/useNativeApiServerCapability", () => ({
  useNativeApiServerCapabilitySnapshot: () => ({
    generation: harness.connectionGeneration,
    connected: harness.connected,
    capability: "supported",
    api: undefined,
  }),
}));

import { SkillPackagesSettingsPanel } from "./SkillPackagesSettingsPanel";
import { skillPackageSourcesQueryKey, skillPackagesQueryKey } from "./skillPackageSettingsQueries";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((complete, fail) => {
    resolve = complete;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function panel(client: QueryClient) {
  return (
    <QueryClientProvider client={client}>
      <SkillPackagesSettingsPanel />
    </QueryClientProvider>
  );
}

async function mountPanel() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  const view = await render(panel(queryClient));
  return {
    queryClient,
    view,
    close: async () => {
      await view.unmount();
      queryClient.clear();
    },
  };
}

beforeEach(() => {
  harness.connectionGeneration = "connection-a";
  harness.connected = true;
  for (const operation of Object.values(harness.server)) operation.mockReset();
  harness.server.listSkillPackages.mockResolvedValue([]);
  harness.server.listSkillPackageSources.mockResolvedValue([source]);
  harness.server.readSkillPackage.mockResolvedValue(packageContent);
  harness.server.previewSkillPackage.mockResolvedValue(importPreview);
  harness.server.previewSkillPackageUpdate.mockResolvedValue(updatePreview);
  harness.server.previewSkillPackageRemoval.mockResolvedValue({ packageId, references: [] });
  harness.server.importSkillPackage.mockResolvedValue(importResult);
  harness.server.removeSkillPackage.mockResolvedValue(undefined);
});

describe("SkillPackagesSettingsPanel browser flows", () => {
  it("previews the complete package, keeps resources collapsed, and imports idempotently", async () => {
    const mounted = await mountPanel();
    await page.getByRole("button", { name: "导入技能包", exact: true }).click();
    await page.getByRole("textbox", { name: "技能文件或目录路径" }).fill("/source/planner");
    await page.getByRole("button", { name: "预览", exact: true }).click();
    await expect.element(page.getByText("Planner", { exact: true })).toBeVisible();
    await expect.element(page.getByText(/planner\/scripts\/check\.py/u)).not.toBeInTheDocument();
    await page.getByRole("button", { name: /包内资源/ }).click();
    await expect.element(page.getByText(/planner\/scripts\/check\.py/u)).toBeVisible();
    await page.getByRole("button", { name: "确认导入", exact: true }).click();
    await expect.element(page.getByRole("status")).toHaveTextContent("已导入 planner-bundle");
    expect(harness.server.importSkillPackage).toHaveBeenCalledWith({
      previewId: importPreview.previewId,
      idempotencyKey: importPreview.previewId,
    });
    expect(mounted.queryClient.getQueryData(skillPackagesQueryKey("connection-a"))).toEqual([]);
    expect(mounted.queryClient.getQueryData(skillPackageSourcesQueryKey("connection-a"))).toEqual([
      source,
    ]);
    await mounted.close();
  });

  it("shows exact update entry paths and refuses removal while references remain", async () => {
    harness.server.listSkillPackages.mockResolvedValue([packageContent]);
    const mounted = await mountPanel();
    await page.getByRole("button", { name: /检查来源更新/ }).click();
    await expect.element(page.getByText(/planner\/review\/SKILL\.md/u)).toBeVisible();
    await expect.element(page.getByText(/planner\/old\/SKILL\.md/u)).toBeVisible();
    await page.getByRole("button", { name: "确认导入新版本", exact: true }).click();
    expect(harness.server.importSkillPackage).toHaveBeenCalledWith({
      previewId: updatePreview.previewId,
      idempotencyKey: updatePreview.previewId,
    });
    expect(page.getByText(/不会更改专家当前选择/).length).toBeGreaterThan(0);

    harness.server.previewSkillPackageRemoval.mockResolvedValueOnce({
      packageId,
      references: ["Expert 规划专家 revision 4"],
    });
    await page.getByRole("button", { name: "删除", exact: true }).click();
    await expect
      .element(page.getByText("Expert 规划专家 revision 4", { exact: true }))
      .toBeVisible();
    await expect
      .element(page.getByRole("button", { name: "确认删除", exact: true }))
      .toBeDisabled();
    await page.getByRole("button", { name: "取消", exact: true }).click();

    await page.getByRole("button", { name: "删除", exact: true }).click();
    await page.getByRole("button", { name: "确认删除", exact: true }).click();
    await expect.poll(() => harness.server.removeSkillPackage.mock.calls.length).toBe(1);
    expect(harness.server.removeSkillPackage).toHaveBeenCalledWith({ packageId });
    await mounted.close();
  });

  it("ignores preview completion after unmount", async () => {
    const pendingPreview = deferred<SkillPackagePreview>();
    harness.server.previewSkillPackage.mockReturnValueOnce(pendingPreview.promise);
    const mounted = await mountPanel();
    await page.getByRole("button", { name: "导入技能包", exact: true }).click();
    await page.getByRole("textbox", { name: "技能文件或目录路径" }).fill("/source/planner");
    await page.getByRole("button", { name: "预览", exact: true }).click();
    await expect.poll(() => harness.server.previewSkillPackage.mock.calls.length).toBe(1);
    await mounted.close();
    pendingPreview.resolve(importPreview);
    await pendingPreview.promise;
    expect(harness.server.importSkillPackage).not.toHaveBeenCalled();
  });

  it("drops a preview response from the previous server connection generation", async () => {
    const pendingPreview = deferred<SkillPackagePreview>();
    harness.server.previewSkillPackage.mockReturnValueOnce(pendingPreview.promise);
    const mounted = await mountPanel();
    await page.getByRole("button", { name: "导入技能包", exact: true }).click();
    await page.getByRole("textbox", { name: "技能文件或目录路径" }).fill("/source/planner");
    await page.getByRole("button", { name: "预览", exact: true }).click();
    await expect.poll(() => harness.server.previewSkillPackage.mock.calls.length).toBe(1);

    harness.connectionGeneration = "connection-b";
    await mounted.view.rerender(panel(mounted.queryClient));
    await expect
      .element(page.getByRole("alert"))
      .toHaveTextContent("服务器连接已更改，请重新预览此操作。");
    pendingPreview.resolve(importPreview);
    await pendingPreview.promise;
    await expect.element(page.getByText("Planner", { exact: true })).not.toBeInTheDocument();
    expect(harness.server.importSkillPackage).not.toHaveBeenCalled();
    await mounted.close();
  });
});
