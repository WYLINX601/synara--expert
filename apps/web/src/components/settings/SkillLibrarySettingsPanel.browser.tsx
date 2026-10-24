import "../../index.css";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import type {
  ExpertDefinition,
  SkillDefinition,
  SkillLibraryPreview,
  SkillLibraryRequest,
  SkillLibraryResponse,
  SkillPackage,
} from "@synara/contracts";
import { page, userEvent } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

const harness = vi.hoisted(() => ({
  generation: "library-browser-a",
  connected: true,
  skills: [] as SkillDefinition[],
  experts: [] as ExpertDefinition[],
  server: {
    skillLibrary: vi.fn<(request: SkillLibraryRequest) => Promise<SkillLibraryResponse>>(),
    listExperts: vi.fn<() => Promise<ExpertDefinition[]>>(),
    saveExpert: vi.fn(),
    readSkillPackage: vi.fn(),
    getConfig: vi.fn(async () => ({ keybindings: [] })),
  },
}));
vi.mock("~/nativeApi", () => ({ ensureNativeApi: () => ({ server: harness.server }) }));
vi.mock("~/hooks/useNativeApiServerCapability", () => ({
  useNativeApiServerCapabilitySnapshot: () => ({
    generation: harness.generation,
    connected: harness.connected,
    capability: "supported",
    api: undefined,
  }),
}));
vi.mock("~/lib/providerDiscoveryReactQuery", () => ({
  skillsCatalogQueryOptions: ({ enabled }: { enabled: boolean }) => ({
    queryKey: ["test", "library-inventory"],
    enabled,
    queryFn: async () => ({
      skills: [
        {
          name: "Native C",
          path: "/project/.agents/skills/c/SKILL.md",
          scope: "project",
          enabled: true,
        },
      ],
    }),
  }),
}));

import { SkillLibrarySettingsPanel } from "./SkillLibrarySettingsPanel";

const packageId = `pkg_${"a".repeat(64)}`;
const pkg: SkillPackage = {
  schemaVersion: 1,
  packageId,
  rootName: "library",
  entries: [
    { entryPath: "alpha/SKILL.md", name: "Alpha", description: "Review Alpha", issues: [] },
    {
      entryPath: "sibling/SKILL.md",
      name: "Sibling",
      description: "Unselected sibling",
      issues: [],
    },
  ],
  resources: [
    { path: "content/alpha/SKILL.md", kind: "file", size: 72, sha256: "a".repeat(64) },
    { path: "content/assets/data.bin", kind: "file", size: 4, sha256: "b".repeat(64) },
  ],
  fileCount: 2,
  totalBytes: 76,
};
const alpha: SkillDefinition = {
  skillId: `skl_${"a".repeat(32)}`,
  name: "Alpha",
  description: "Review Alpha",
  tags: ["review"],
  packageId,
  entryPath: "alpha/SKILL.md",
  source: { kind: "local", location: "/source/alpha", entryPath: "alpha/SKILL.md", packageId },
  locallyModified: true,
  revision: 2,
  deleted: false,
  updatedAt: "2026-10-25T00:00:00.000Z",
};
const beta: SkillDefinition = {
  ...alpha,
  skillId: `skl_${"b".repeat(32)}`,
  name: "Beta",
  description: "Design Beta",
  tags: ["design"],
  source: { ...alpha.source, kind: "manual", location: "" },
  locallyModified: false,
};
const preview: SkillLibraryPreview = {
  previewId: "preview-library-1",
  package: pkg,
  source: alpha.source,
  expiresAt: "2099-01-01T00:00:00.000Z",
  overwritesLocalEdits: true,
  resourceChanges: ["content/alpha/SKILL.md"],
};
const expert: ExpertDefinition = {
  id: "review-expert",
  name: "Review Expert",
  description: "",
  useCases: "",
  persona: "Review",
  outputRequirements: "",
  skills: [],
  skillBindings: [],
  references: [],
  connections: [],
  revision: 1,
  archived: false,
  updatedAt: "2026-10-25T00:00:00.000Z",
};
let dispose: (() => Promise<void>) | undefined;

async function mountPanel() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const root = createRootRoute({
    component: () => (
      <QueryClientProvider client={client}>
        <Outlet />
      </QueryClientProvider>
    ),
  });
  const settings = createRoute({
    getParentRoute: () => root,
    path: "/settings",
    component: SkillLibrarySettingsPanel,
  });
  const router = createRouter({
    routeTree: root.addChildren([settings]),
    history: createMemoryHistory({ initialEntries: ["/settings"] }),
  });
  const view = await render(<RouterProvider router={router} />);
  dispose = async () => {
    await view.unmount();
    client.clear();
  };
  return view;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function managedFiles() {
  let current = { ...alpha };
  const files = new Map([
    ["alpha/SKILL.md", "---\nname: Alpha\ndescription: Review Alpha\n---\nOriginal body.\n"],
    ["notes.txt", "Accepted notes.\n"],
  ]);
  harness.server.readSkillPackage.mockResolvedValue({
    ...pkg,
    resources: [
      ...pkg.resources,
      { path: "content/notes.txt", kind: "file", size: 16, sha256: "c".repeat(64) },
    ],
  });
  const original = harness.server.skillLibrary.getMockImplementation()!;
  const commit = (name: string, tags: readonly string[]) => {
    current = { ...current, name, tags: [...tags], revision: current.revision + 1 };
    files.set(
      "alpha/SKILL.md",
      files.get("alpha/SKILL.md")!.replace(/^name: .*$/mu, `name: ${name}`),
    );
    harness.skills = [current, beta];
    return { skill: current };
  };
  harness.server.skillLibrary.mockImplementation(async (request) => {
    if (request.action !== "save") return original(request);
    if (request.expectedRevision !== current.revision) throw new Error("Stale save revision");
    return commit(request.name, request.tags);
  });
  const nativeFetch = globalThis.fetch;
  const fetch = vi.fn(async (input: RequestInfo | URL, options?: RequestInit) => {
    const url = new URL(String(input), window.location.href);
    if (url.pathname !== "/api/skills/upload" && url.pathname !== "/api/skills/download")
      return nativeFetch(input, options);
    const file = url.searchParams.get("path")!;
    if (Number(url.searchParams.get("expectedRevision")) !== current.revision)
      return Response.json({ error: "Stale resource revision" }, { status: 409 });
    if (options?.method === "POST") {
      files.set(file, await (options.body as Blob).text());
      return Response.json(
        commit(
          url.searchParams.get("skillName") ?? current.name,
          JSON.parse(url.searchParams.get("tags") ?? "[]") as string[],
        ),
      );
    }
    return new Response(files.get(file), { status: files.has(file) ? 200 : 404 });
  });
  vi.stubGlobal("fetch", fetch);
  return { files, fetch, current: () => current };
}
async function replaceEditor(text: string) {
  await page
    .getByRole("textbox", { name: "alpha/SKILL.md", exact: true })
    .click({ position: { x: 15, y: 5 } });
  const modifier = /Mac/.test(navigator.platform) ? "Meta" : "Control";
  await userEvent.keyboard(`{${modifier}>}a{/${modifier}}`);
  await userEvent.keyboard(text);
}
beforeEach(async () => {
  await page.viewport(1280, 1000);
  harness.generation = "library-browser-a";
  harness.connected = true;
  harness.skills = [alpha, beta];
  harness.experts = [expert];
  for (const operation of Object.values(harness.server)) operation.mockClear();
  harness.server.skillLibrary.mockImplementation(async (request) => {
    if (request.action === "list") return { skills: harness.skills };
    if (request.action === "previewImport" || request.action === "previewRefresh")
      return { preview };
    if (request.action === "import") return { skills: [alpha] };
    if (request.action === "previewDelete") return { expertIds: [expert.id] };
    if (request.action === "save") {
      const skill = { ...alpha, name: request.name, tags: request.tags, revision: 3 };
      harness.skills = [skill, beta];
      return { skill };
    }
    if (request.action === "batch")
      return {
        results: request.items.map((item, index) => ({
          skillId: item.skillId,
          success: index === 0,
          message: index === 0 ? "Completed" : "Revision conflict",
          ...(item.operation === "previewRefresh" && index === 0 ? { preview } : {}),
        })),
      };
    return {};
  });
  harness.server.readSkillPackage.mockResolvedValue(pkg);
  harness.server.listExperts.mockImplementation(async () => harness.experts);
  harness.server.saveExpert.mockImplementation(async (input) => {
    const saved = { ...expert, ...input, revision: expert.revision + 1 };
    harness.experts = [saved];
    return saved;
  });
});
afterEach(async () => {
  await dispose?.();
  dispose = undefined;
  vi.unstubAllGlobals();
});

describe("Skill library management browser flows", () => {
  it("adopts canonical SKILL.md after rename before a later body edit", async () => {
    const resources = managedFiles();
    await mountPanel();
    await page.getByText("Alpha", { exact: true }).click();
    await page.getByRole("button", { name: /alpha\/SKILL.md/u }).click();
    await expect
      .element(page.getByRole("textbox", { name: "alpha/SKILL.md", exact: true }))
      .toHaveTextContent("name: Alpha");
    await page.getByRole("textbox", { name: "技能名称" }).fill("Renamed Alpha");
    await page.getByRole("button", { name: "保存新版本", exact: true }).click();
    await expect
      .element(page.getByRole("textbox", { name: "alpha/SKILL.md", exact: true }))
      .toHaveTextContent("name: Renamed Alpha");
    await replaceEditor(
      "---{Enter}name: Renamed Alpha{Enter}description: Review Alpha{Enter}---{Enter}Edited body.",
    );
    await page.getByRole("button", { name: "保存新版本", exact: true }).click();
    await expect.poll(() => resources.current().revision).toBe(4);
    expect(resources.files.get("alpha/SKILL.md")).toContain("name: Renamed Alpha");
    expect(resources.files.get("alpha/SKILL.md")).toContain("Edited body.");
    await expect
      .element(page.getByRole("textbox", { name: "技能名称" }))
      .toHaveValue("Renamed Alpha");
    await expect.element(page.getByRole("alert")).not.toBeInTheDocument();
  });
  it("uses the accepted revision after the real save-and-switch draft guard", async () => {
    const resources = managedFiles();
    await mountPanel();
    await page.getByText("Alpha", { exact: true }).click();
    await page.getByRole("button", { name: /alpha\/SKILL.md/u }).click();
    await expect
      .element(page.getByRole("textbox", { name: "alpha/SKILL.md", exact: true }))
      .toHaveTextContent("Original body.");
    await replaceEditor(
      "---{Enter}name: Alpha{Enter}description: Review Alpha{Enter}---{Enter}Saved before switching.",
    );
    await page.getByRole("button", { name: /notes.txt/u }).click();
    await expect.element(page.getByText("未保存的更改", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "保存并继续", exact: true }).click();
    await expect
      .element(page.getByRole("textbox", { name: "notes.txt", exact: true }))
      .toHaveTextContent("Accepted notes.");
    expect(resources.files.get("alpha/SKILL.md")).toContain("Saved before switching.");
    const lastRead = resources.fetch.mock.calls
      .filter(
        ([input]) =>
          new URL(String(input), window.location.href).pathname === "/api/skills/download",
      )
      .at(-1)![0];
    expect(new URL(String(lastRead)).searchParams.get("expectedRevision")).toBe("3");
    await expect.element(page.getByRole("alert")).not.toBeInTheDocument();
  });
  it("clears completed import ownership and cancels the current refresh preview", async () => {
    const original = harness.server.skillLibrary.getMockImplementation()!;
    harness.server.skillLibrary.mockImplementation(async (request) =>
      request.action === "previewRefresh"
        ? { preview: { ...preview, previewId: "current-refresh" } }
        : original(request),
    );
    await mountPanel();
    await page.getByRole("button", { name: "导入技能", exact: true }).click();
    await page.getByRole("textbox", { name: "技能导入来源" }).fill("/source/library");
    await page.getByRole("button", { name: "预览", exact: true }).click();
    await page.getByRole("checkbox", { name: "导入 alpha/SKILL.md" }).click();
    await page.getByRole("button", { name: "导入选中入口", exact: true }).click();
    await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
    await page.getByRole("button", { name: "预览来源更新", exact: true }).first().click();
    await expect.element(page.getByText(/来源更新会覆盖本地编辑/u)).toBeVisible();
    await page.getByRole("button", { name: "取消", exact: true }).click();
    expect(
      harness.server.skillLibrary.mock.calls
        .filter(([request]) => request.action === "cancel")
        .map(([request]) => (request.action === "cancel" ? request.previewId : "")),
    ).toEqual(["current-refresh"]);
  });
  it("cancels a refresh cancelled before its late completion and releases superseded previews", async () => {
    const late = deferred<SkillLibraryResponse>(),
      original = harness.server.skillLibrary.getMockImplementation()!;
    harness.server.skillLibrary.mockImplementation(async (request) =>
      request.action === "previewRefresh" ? late.promise : original(request),
    );
    await mountPanel();
    await page.getByRole("button", { name: "导入技能", exact: true }).click();
    await page.getByRole("textbox", { name: "技能导入来源" }).fill("/source/first");
    await page.getByRole("button", { name: "预览", exact: true }).click();
    await expect.element(page.getByRole("checkbox", { name: "导入 alpha/SKILL.md" })).toBeVisible();
    await page.getByRole("button", { name: "预览", exact: true }).click();
    await expect
      .poll(
        () =>
          harness.server.skillLibrary.mock.calls.filter(
            ([request]) => request.action === "cancel" && request.previewId === preview.previewId,
          ).length,
      )
      .toBe(1);
    await page.getByRole("button", { name: "取消", exact: true }).click();
    await page.getByRole("button", { name: "预览来源更新", exact: true }).first().click();
    await page.getByRole("button", { name: "取消", exact: true }).click();
    late.resolve({ preview: { ...preview, previewId: "late-refresh" } });
    await expect
      .poll(() =>
        harness.server.skillLibrary.mock.calls.some(
          ([request]) => request.action === "cancel" && request.previewId === "late-refresh",
        ),
      )
      .toBe(true);
    await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
    expect(
      harness.server.skillLibrary.mock.calls.some(([request]) => request.action === "refresh"),
    ).toBe(false);
  });
  it("filters and imports only explicitly checked entries with reviewed duplicate handling", async () => {
    await mountPanel();
    await expect.element(page.getByText("Alpha", { exact: true })).toBeVisible();
    await page.getByRole("textbox", { name: "搜索技能" }).fill("Beta");
    await expect.element(page.getByText("Alpha", { exact: true })).not.toBeInTheDocument();
    await page.getByRole("textbox", { name: "搜索技能" }).fill("");
    await page.getByRole("textbox", { name: "按标签过滤" }).fill("review");
    await expect.element(page.getByText("Beta", { exact: true })).not.toBeInTheDocument();
    await page.getByRole("textbox", { name: "按标签过滤" }).fill("");
    await page.getByRole("button", { name: "导入技能", exact: true }).click();
    await page.getByRole("textbox", { name: "技能导入来源" }).fill("/source/library");
    await page.getByRole("button", { name: "预览", exact: true }).click();
    await expect
      .element(page.getByRole("checkbox", { name: "导入 alpha/SKILL.md" }))
      .not.toBeChecked();
    await page.getByRole("checkbox", { name: "导入 alpha/SKILL.md" }).click();
    await page.getByRole("combobox", { name: "重复处理 alpha/SKILL.md" }).click();
    await page.getByRole("option", { name: "重命名", exact: true }).click();
    await page.getByRole("textbox", { name: "重命名 alpha/SKILL.md" }).fill("Alpha Copy");
    await page.getByRole("button", { name: "导入选中入口", exact: true }).click();
    await expect
      .poll(() =>
        harness.server.skillLibrary.mock.calls.some(
          ([request]) =>
            request.action === "import" &&
            JSON.stringify(request.choices) ===
              JSON.stringify([
                { entryPath: "alpha/SKILL.md", duplicate: "rename", name: "Alpha Copy" },
              ]),
        ),
      )
      .toBe(true);
    await expect.element(page.getByRole("status")).toHaveTextContent("已导入 1 个选中入口。");
  });

  it("reviews source overwrites, per-item batch failures and exact affected Expert deletion", async () => {
    await mountPanel();
    await page.getByRole("button", { name: "预览来源更新", exact: true }).first().click();
    await expect.element(page.getByText(/来源更新会覆盖本地编辑/u)).toBeVisible();
    await expect.element(page.getByText("content/alpha/SKILL.md", { exact: true })).toBeVisible();
    expect(
      harness.server.skillLibrary.mock.calls.some(([request]) => request.action === "refresh"),
    ).toBe(false);
    await page.getByRole("button", { name: "取消", exact: true }).click();
    await page.getByRole("checkbox", { name: "选择 Alpha" }).click();
    await page.getByRole("checkbox", { name: "选择 Beta" }).click();
    await page.getByRole("button", { name: "批量预览更新", exact: true }).click();
    await expect.element(page.getByText(/Beta · 失败 · Revision conflict/u)).toBeVisible();
    await page.getByRole("button", { name: "确认上述来源替换", exact: true }).click();
    await expect
      .poll(() =>
        harness.server.skillLibrary.mock.calls.some(
          ([request]) =>
            request.action === "batch" &&
            request.items.length === 1 &&
            request.items[0]?.operation === "refresh" &&
            request.items[0]?.previewId === preview.previewId,
        ),
      )
      .toBe(true);
    await page.getByRole("button", { name: "删除", exact: true }).first().click();
    await expect.element(page.getByText(/影响 1 个专家：review-expert/u)).toBeVisible();
    await page.getByRole("button", { name: "确认解绑并删除", exact: true }).click();
    await expect
      .poll(() =>
        harness.server.skillLibrary.mock.calls.some(
          ([request]) =>
            request.action === "batch" &&
            request.items[0]?.operation === "delete" &&
            request.items[0]?.confirmExpertIds?.[0] === expert.id,
        ),
      )
      .toBe(true);
  });

  it("preserves a dirty detail draft, binds from the Skill side and folds the wide editor on narrow screens", async () => {
    await mountPanel();
    await page.getByText("Alpha", { exact: true }).click();
    await expect.element(page.getByRole("dialog")).toBeVisible();
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(dialog.getBoundingClientRect().width).toBeGreaterThan(900);
    await page.getByRole("textbox", { name: "技能标签" }).fill("review, checked");
    await page.getByRole("button", { name: "关闭", exact: true }).click();
    await expect.element(page.getByText("未保存的更改", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "取消", exact: true }).click();
    await page.getByRole("button", { name: "保存新版本", exact: true }).click();
    await expect
      .poll(() =>
        harness.server.skillLibrary.mock.calls.some(
          ([request]) => request.action === "save" && request.tags.includes("checked"),
        ),
      )
      .toBe(true);
    await page.getByRole("button", { name: "绑定", exact: true }).click();
    await expect.element(page.getByRole("switch", { name: "启用绑定技能" })).toBeChecked();
    expect(harness.server.saveExpert).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedRevision: 1,
        skillBindings: [{ skillId: alpha.skillId, enabled: true, activation: "on-demand" }],
      }),
    );
    await page.screenshot({ path: "../../../../../_bmad-output/skill-library-wide.png" });
    await page.viewport(390, 844);
    await expect.poll(() => dialog.getBoundingClientRect().width).toBeLessThan(390);
    const resources = document.querySelector<HTMLElement>('[aria-label="技能资源"]')!;
    const editor = resources.nextElementSibling as HTMLElement;
    expect(editor.getBoundingClientRect().top).toBeGreaterThanOrEqual(
      resources.getBoundingClientRect().bottom,
    );
    await page.screenshot({ path: "../../../../../_bmad-output/skill-library-narrow.png" });
  });

  it("preserves old Expert selections and requires reviewed reassembly before binding from the Skill side", async () => {
    const old = {
      ...expert,
      skillBindings: undefined,
      skills: [{ name: "Existing role", path: "/old/role/SKILL.md" }],
      skillSelections: undefined,
    };
    harness.experts = [old];
    await mountPanel();
    await page.getByText("Alpha", { exact: true }).click();
    await expect.element(page.getByText(/请先在专家页“改用技能库装配”/u)).toBeVisible();
    await expect
      .element(page.getByRole("button", { name: "绑定", exact: true }))
      .not.toBeInTheDocument();
    expect(harness.server.saveExpert).not.toHaveBeenCalled();
    expect(harness.experts[0]?.skills).toEqual(old.skills);
    expect(harness.experts[0]?.skillBindings).toBeUndefined();
  });
  it("cancels a pending import without allowing a late preview to re-open it", async () => {
    const response = deferred<SkillLibraryResponse>();
    const original = harness.server.skillLibrary.getMockImplementation()!;
    harness.server.skillLibrary.mockImplementation((request) =>
      request.action === "previewImport" ? response.promise : original(request),
    );
    await mountPanel();
    await page.getByRole("button", { name: "导入技能", exact: true }).click();
    await page.getByRole("textbox", { name: "技能导入来源" }).fill("https://github.com/owner/repo");
    await page.getByRole("button", { name: "预览", exact: true }).click();
    await page.getByRole("button", { name: "取消", exact: true }).click();
    const request = harness.server.skillLibrary.mock.calls
      .map(([request]) => request)
      .find((request) => request.action === "previewImport")!;
    expect(harness.server.skillLibrary).toHaveBeenCalledWith({
      action: "cancel",
      previewId: request.action === "previewImport" ? request.requestId : "",
    });
    response.resolve({ preview });
    await expect
      .poll(() =>
        harness.server.skillLibrary.mock.calls.some(
          ([request]) => request.action === "cancel" && request.previewId === preview.previewId,
        ),
      )
      .toBe(true);
    await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
    expect(
      harness.server.skillLibrary.mock.calls.some(([request]) => request.action === "import"),
    ).toBe(false);
  });
});
