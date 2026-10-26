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
  SkillLibraryQuery,
  SkillPackage,
  ProviderKind,
  ProviderSkillsCatalogResult,
} from "@synara/contracts";
import { page, userEvent } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

const harness = vi.hoisted(() => ({
  generation: "library-browser-a",
  connected: true,
  skills: [] as SkillDefinition[],
  experts: [] as ExpertDefinition[],
  discoverSkills: vi.fn<(provider: ProviderKind | null) => Promise<ProviderSkillsCatalogResult>>(),
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
  skillsCatalogQueryOptions: ({
    enabled,
    provider,
  }: {
    enabled: boolean;
    provider: ProviderKind | null;
  }) => ({
    queryKey: ["test", "library-inventory", provider],
    enabled,
    queryFn: () => harness.discoverSkills(provider),
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
  source: {
    kind: "url",
    location: "https://github.com/acme/skills/tree/main/alpha",
    entryPath: "alpha/SKILL.md",
    packageId,
  },
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
  source: {
    ...alpha.source,
    kind: "url",
    location: "https://github.com/acme/skills/tree/main/beta",
  },
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

function listResponse(query?: SkillLibraryQuery): SkillLibraryResponse {
  const skills = harness.skills.filter((skill) => {
    const search = query?.search?.toLocaleLowerCase();
    if (
      search &&
      !`${skill.name} ${skill.description} ${skill.tags.join(" ")}`
        .toLocaleLowerCase()
        .includes(search)
    )
      return false;
    if (query?.sources?.length && !query.sources.includes("github")) return false;
    if (query?.createdBy?.length && !query.createdBy.includes(skill.createdBy ?? "unknown"))
      return false;
    if (query?.tags?.length && !skill.tags.some((tag) => query.tags?.includes(tag))) return false;
    if (
      query?.expertIds?.length &&
      !harness.experts.some((item) => query.expertIds?.includes(item.id))
    )
      return false;
    const used = harness.experts.some((item) =>
      item.skillBindings?.some((binding) => binding.skillId === skill.skillId),
    );
    if (query?.usage === "used" && !used) return false;
    if (query?.usage === "unused" && used) return false;
    return true;
  });
  const sorted = [...skills];
  if (query?.sort?.field === "name")
    sorted.sort(
      (left, right) =>
        left.name.localeCompare(right.name) * (query.sort?.direction === "desc" ? -1 : 1),
    );
  return {
    skills: sorted,
    items: sorted.map((skill) => ({
      skillId: skill.skillId,
      ...(skill.createdAt ? { createdAt: skill.createdAt } : {}),
      ...(skill.createdBy ? { createdBy: skill.createdBy } : {}),
      usage: {
        expertIds: harness.experts
          .filter((item) =>
            item.skillBindings?.some((binding) => binding.skillId === skill.skillId),
          )
          .map((item) => item.id),
        enabledExpertIds: harness.experts
          .filter((item) =>
            item.skillBindings?.some(
              (binding) => binding.skillId === skill.skillId && binding.enabled,
            ),
          )
          .map((item) => item.id),
      },
    })),
  };
}

async function mountPanel(width?: number) {
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
    component: () => (
      <div style={{ width, maxWidth: "100%" }}>
        <SkillLibrarySettingsPanel />
      </div>
    ),
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
  harness.server.readSkillPackage.mockImplementation(async () => ({
    ...pkg,
    resources: [
      ...pkg.resources.filter((resource) => !files.has(resource.path.slice("content/".length))),
      ...[...files].map(([path, content]) => ({
        path: `content/${path}`,
        kind: "file" as const,
        size: new TextEncoder().encode(content).length,
        sha256: "c".repeat(64),
      })),
    ],
  }));
  const original = harness.server.skillLibrary.getMockImplementation()!;
  const commit = (name: string, tags: readonly string[], description = current.description) => {
    current = { ...current, name, description, tags: [...tags], revision: current.revision + 1 };
    files.set(
      "alpha/SKILL.md",
      files
        .get("alpha/SKILL.md")!
        .replace(/^name: .*$/mu, `name: ${name}`)
        .replace(/^description: .*$/mu, `description: ${JSON.stringify(description)}`),
    );
    harness.skills = [current, beta];
    return { skill: current };
  };
  harness.server.skillLibrary.mockImplementation(async (request) => {
    if (request.action !== "save") return original(request);
    if (request.expectedRevision !== current.revision) throw new Error("Stale save revision");
    for (const change of request.changes) {
      if (change.content === undefined) files.delete(change.path);
      else
        files.set(
          change.path,
          new TextDecoder().decode(
            Uint8Array.from(atob(change.content), (value) => value.charCodeAt(0)),
          ),
        );
    }
    return commit(request.name, request.tags, request.description);
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
          url.searchParams.get("description") ?? undefined,
        ),
      );
    }
    return new Response(files.get(file), { status: files.has(file) ? 200 : 404 });
  });
  vi.stubGlobal("fetch", fetch);
  return { files, fetch, current: () => current };
}
async function replaceEditor(text: string, fileName = "alpha/SKILL.md") {
  await page
    .getByRole("textbox", { name: fileName, exact: true })
    .click({ position: { x: 15, y: 5 } });
  const modifier = /Mac/.test(navigator.platform) ? "Meta" : "Control";
  await userEvent.keyboard(`{${modifier}>}a{/${modifier}}`);
  await userEvent.keyboard(text);
}
beforeEach(async () => {
  harness.discoverSkills.mockReset();
  harness.discoverSkills.mockImplementation(async (provider) => ({
    skills: [
      {
        name: `${provider} review`,
        description: "Review code",
        path: `/home/.${provider}/skills/review/SKILL.md`,
        enabled: true,
        scope: provider ?? "unknown",
      },
      {
        name: `${provider} draft`,
        description: "Draft a plan",
        path: `/home/.${provider}/skills/draft/SKILL.md`,
        enabled: true,
        scope: provider ?? "unknown",
      },
    ],
  }));
  await page.viewport(1280, 1000);
  harness.generation = "library-browser-a";
  harness.connected = true;
  harness.skills = [alpha, beta];
  harness.experts = [expert];
  for (const operation of Object.values(harness.server)) operation.mockClear();
  harness.server.skillLibrary.mockImplementation(async (request) => {
    if (request.action === "list") return listResponse(request.query);
    if (request.action === "previewImport") return { preview };
    if (request.action === "updateFromSource")
      return {
        updateResult: {
          skillId: request.skillId,
          status: "updated",
          revision: request.expectedRevision + (request.dryRun ? 0 : 1),
          ...(request.dryRun ? { preview } : {}),
        },
        ...(request.dryRun ? { dryRun: true } : {}),
      };
    if (request.action === "bindExperts")
      return {
        bindingResults: request.targets.map((target) => ({
          expertId: target.expertId,
          status: "applied" as const,
          oldRevision: target.expectedRevision,
          newRevision: target.expectedRevision + (request.dryRun ? 1 : 1),
          addedSkillIds: request.skillIds,
          skippedSkillIds: [],
        })),
        ...(request.dryRun ? { dryRun: true } : {}),
      };
    if (request.action === "bindings" && request.operation === "list")
      return {
        bindingResult: {
          expertId: request.expertId,
          revision: 1,
          bindings: expert.skillBindings ?? [],
        },
      };
    if (request.action === "bindings") {
      const current = harness.experts.find((item) => item.id === request.expertId) ?? expert;
      if (request.operation === "set" || request.operation === "add") {
        const saved = {
          ...current,
          skillBindings: request.bindings,
          revision: current.revision + 1,
        };
        harness.experts = harness.experts.map((item) => (item.id === saved.id ? saved : item));
      }
      return {
        bindingResult: {
          expertId: request.expertId,
          revision: request.expectedRevision,
          bindings:
            request.operation === "set" || request.operation === "add" ? request.bindings : [],
          status: "applied",
        },
      };
    }
    if (request.action === "import") return { skills: [alpha] };
    if (request.action === "previewDelete") return { expertIds: [expert.id] };
    if (request.action === "save") {
      const skill = { ...alpha, name: request.name, tags: request.tags, revision: 3 };
      harness.skills = [skill, beta];
      return { skill };
    }
    if (request.action === "batch")
      return {
        results: request.items.map((item, index) =>
          item.operation === "updateFromSource"
            ? request.dryRun && index === 0
              ? {
                  skillId: item.skillId,
                  success: true,
                  status: "would_change" as const,
                  message: "updated",
                  updateResult: { skillId: item.skillId, status: "updated" as const, preview },
                }
              : request.dryRun
                ? {
                    skillId: item.skillId,
                    success: false,
                    status: "conflict" as const,
                    message: "Revision conflict",
                    updateResult: {
                      skillId: item.skillId,
                      status: "conflict" as const,
                      error: "Revision conflict",
                    },
                  }
                : {
                    skillId: item.skillId,
                    success: true,
                    status: "would_change" as const,
                    message: "updated",
                    updateResult: { skillId: item.skillId, status: "updated" as const },
                  }
            : {
                skillId: item.skillId,
                success: index === 0,
                message: index === 0 ? "Completed" : "Revision conflict",
              },
        ),
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
  vi.stubGlobal(
    "confirm",
    vi.fn(() => true),
  );
});
afterEach(async () => {
  await dispose?.();
  dispose = undefined;
  vi.unstubAllGlobals();
});

function setTestUiFontSize(fontSize: number) {
  const rootStyle = document.documentElement.style;
  const names = [
    "--app-font-size-base",
    "--app-font-size-ui",
    "--app-font-size-ui-lg",
    "--app-font-size-ui-sm",
    "--app-font-size-ui-xs",
  ];
  const previous = names.map((name) => [name, rootStyle.getPropertyValue(name)] as const);
  for (const name of names) rootStyle.setProperty(name, `${fontSize}px`);
  return () => {
    for (const [name, value] of previous) {
      if (value) rootStyle.setProperty(name, value);
      else rootStyle.removeProperty(name);
    }
  };
}

describe("Skill library management browser flows", () => {
  const showFiles = async (edit = false) => {
    await page.getByRole("tab", { name: /^文件/u }).click();
    if (edit) await page.getByRole("button", { name: "编辑", exact: true }).click();
  };
  it.each([1280, 390])(
    "keeps overview and file panes within the viewport at %i px and enlarged text",
    async (width) => {
      managedFiles();
      await page.viewport(width, 844);
      const restoreFont = setTestUiFontSize(20);
      try {
        await mountPanel();
        await page.getByText("Alpha", { exact: true }).click();
        const dialog = page.getByRole("dialog", { name: "Alpha", exact: true }).element();
        expect(dialog.scrollWidth).toBeLessThanOrEqual(dialog.clientWidth + 1);
        await showFiles();
        await expect.element(page.getByRole("article", { name: "Markdown 预览" })).toBeVisible();
        expect(dialog.scrollWidth).toBeLessThanOrEqual(dialog.clientWidth + 1);
        const row = page.getByRole("button", { name: "alpha/SKILL.md", exact: true }).element();
        const title = row.lastElementChild!.getBoundingClientRect();
        expect(title.top).toBeGreaterThanOrEqual(row.getBoundingClientRect().top + 3);
        expect(title.bottom).toBeLessThanOrEqual(row.getBoundingClientRect().bottom - 3);
        expect(
          page.getByRole("button", { name: "关闭", exact: true }).element().getBoundingClientRect()
            .bottom,
        ).toBeLessThanOrEqual(dialog.getBoundingClientRect().bottom);
      } finally {
        restoreFont();
      }
    },
  );
  it("keeps the overview focused on editable properties and bound Experts and persists a description", async () => {
    const resources = managedFiles();
    await mountPanel();
    await page.getByText("Alpha", { exact: true }).click();
    await expect
      .element(page.getByRole("tab", { name: "概览", exact: true }))
      .toHaveAttribute("aria-selected", "true");
    await expect.element(page.getByText("尚未绑定专家。", { exact: true })).toBeVisible();
    await expect.element(page.getByText(expert.name, { exact: true })).not.toBeInTheDocument();
    await expect
      .element(page.getByRole("navigation", { name: "技能资源" }))
      .not.toBeInTheDocument();
    await page
      .getByRole("textbox", { name: "技能描述", exact: true })
      .fill("Use this Skill to review source material.");
    await page.getByRole("button", { name: "保存新版本", exact: true }).click();
    await expect
      .poll(() => resources.current().description)
      .toBe("Use this Skill to review source material.");
    expect(harness.server.skillLibrary).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "save",
        expectedRevision: 2,
        description: "Use this Skill to review source material.",
      }),
    );
    expect(resources.files.get("alpha/SKILL.md")).toContain(
      "Use this Skill to review source material.",
    );
    await expect
      .element(page.getByRole("button", { name: "保存新版本", exact: true }))
      .toBeDisabled();
  });

  it("edits tag chips without duplicates and preserves pending input when removing a chip", async () => {
    managedFiles();
    await mountPanel();
    await page.getByText("Alpha", { exact: true }).click();
    const input = page.getByRole("combobox", { name: "技能标签", exact: true });
    const save = page.getByRole("button", { name: "保存新版本", exact: true });
    await expect.element(save).toBeDisabled();
    await input.fill("design");
    await userEvent.keyboard("{Enter}");
    await expect
      .element(page.getByRole("button", { name: "移除标签 design", exact: true }))
      .toBeVisible();
    await input.fill("design");
    await userEvent.keyboard("{Enter}");
    expect(
      page.getByRole("button", { name: "移除标签 design", exact: true }).elements(),
    ).toHaveLength(1);
    await input.fill("queued");
    await page.getByRole("button", { name: "移除标签 design", exact: true }).click();
    await save.click();
    await expect
      .poll(() =>
        harness.server.skillLibrary.mock.calls.some(
          ([request]) =>
            request.action === "save" &&
            JSON.stringify(request.tags) === JSON.stringify(["review", "queued"]),
        ),
      )
      .toBe(true);
    await expect
      .element(page.getByRole("button", { name: "移除标签 queued", exact: true }))
      .toBeVisible();
    await expect
      .element(page.getByRole("button", { name: "移除标签 design", exact: true }))
      .not.toBeInTheDocument();
    await expect.element(save).toBeDisabled();
  });

  it("starts keyboard navigation at a generous close target and closes a clean overview with Escape", async () => {
    await mountPanel();
    await page.getByText("Alpha", { exact: true }).click();
    const close = page.getByRole("button", { name: "关闭技能详情", exact: true });
    await expect.element(close).toHaveFocus();
    const target = close.element().getBoundingClientRect();
    expect(target.width).toBeGreaterThanOrEqual(36);
    expect(target.height).toBeGreaterThanOrEqual(36);
    await userEvent.keyboard("{Tab}");
    await expect.element(page.getByRole("tab", { name: "概览", exact: true })).toHaveFocus();
    await userEvent.keyboard("{Tab}");
    await expect
      .element(page.getByRole("textbox", { name: "技能名称", exact: true }))
      .toHaveFocus();
    await userEvent.keyboard("{Tab}");
    await expect
      .element(page.getByRole("textbox", { name: "技能描述", exact: true }))
      .toHaveFocus();
    await userEvent.keyboard("{Escape}");
    await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
  });

  it("opens Markdown in preview, follows only package resource links and preserves the edit draft across modes", async () => {
    const resources = managedFiles();
    resources.files.set(
      "alpha/SKILL.md",
      "---\nname: Alpha\ndescription: Review Alpha\n---\n# Reading guide\n\n[Notes](../notes.txt)\n\n![External](https://example.invalid/image.png)\n",
    );
    await mountPanel();
    await page.getByText("Alpha", { exact: true }).click();
    await showFiles();
    await expect
      .element(page.getByRole("heading", { name: "Reading guide", exact: true }))
      .toBeVisible();
    expect(document.querySelector('[aria-label="Markdown 预览"] img')).toBeNull();
    await page.getByRole("button", { name: "编辑", exact: true }).click();
    await replaceEditor("# Draft reading guide");
    await page.getByRole("button", { name: "预览", exact: true }).click();
    await expect
      .element(page.getByRole("heading", { name: "Draft reading guide", exact: true }))
      .toBeVisible();
    await page.getByRole("button", { name: "编辑", exact: true }).click();
    await expect
      .element(page.getByRole("textbox", { name: "alpha/SKILL.md", exact: true }))
      .toHaveTextContent("Draft reading guide");
    await replaceEditor("# Reopened draft");
    await page.getByRole("button", { name: "预览", exact: true }).click();
    await expect
      .element(page.getByRole("heading", { name: "Reopened draft", exact: true }))
      .toBeVisible();
    await page.getByRole("button", { name: /notes.txt/u }).click();
    await expect.element(page.getByText("未保存的更改", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "取消", exact: true }).click();
    await expect
      .element(page.getByRole("heading", { name: "Reopened draft", exact: true }))
      .toBeVisible();
  });
  it("creates and removes a support file through the file tree while protecting the main entry", async () => {
    const resources = managedFiles();
    await mountPanel();
    await page.getByText("Alpha", { exact: true }).click();
    await showFiles();
    await expect
      .element(page.getByRole("button", { name: "删除资源", exact: true }))
      .toBeDisabled();
    await page.getByRole("button", { name: /新建文件/u }).click();
    await page
      .getByRole("textbox", { name: "资源相对路径", exact: true })
      .fill("references/new.md");
    await page.getByRole("button", { name: "新建文本", exact: true }).click();
    await expect
      .element(page.getByRole("textbox", { name: "references/new.md", exact: true }))
      .toBeVisible();
    await replaceEditor("# New support file{Enter}{Enter}Support body.", "references/new.md");
    await page.getByRole("button", { name: "保存新版本", exact: true }).click();
    await expect
      .poll(() => resources.files.get("references/new.md"))
      .toBe("# New support file\n\nSupport body.");
    await expect
      .element(page.getByRole("button", { name: "references/new.md", exact: true }))
      .toBeVisible();
    await page.getByRole("button", { name: "删除资源", exact: true }).click();
    await expect.poll(() => resources.files.has("references/new.md")).toBe(false);
    await expect
      .element(page.getByRole("button", { name: "references/new.md", exact: true }))
      .not.toBeInTheDocument();
  });
  it("routes detail deletion through the existing impact confirmation", async () => {
    await mountPanel();
    await page.getByText("Alpha", { exact: true }).click();
    await page.getByRole("button", { name: "删除技能", exact: true }).click();
    await expect
      .element(page.getByRole("button", { name: "确认解绑并删除", exact: true }))
      .toBeVisible();
    expect(harness.server.skillLibrary).toHaveBeenCalledWith({
      action: "previewDelete",
      skillId: alpha.skillId,
    });
    expect(
      harness.server.skillLibrary.mock.calls.some(
        ([request]) => request.action === "delete" || request.action === "batch",
      ),
    ).toBe(false);
  });
  it.each([
    { width: 1280, height: 1000, fontSize: 13 },
    { width: 768, height: 900, fontSize: 20 },
    { width: 390, height: 844, fontSize: 20 },
  ])(
    "contains import option text inside each card at $width px with $fontSize px text",
    async ({ width, height, fontSize }) => {
      await page.viewport(width, height);
      const restoreFont = setTestUiFontSize(fontSize);
      try {
        await mountPanel();
        await page.getByRole("button", { name: "导入技能", exact: true }).click();
        const dialog = page.getByRole("dialog", { name: "导入技能", exact: true }).element();
        expect(dialog.scrollWidth).toBeLessThanOrEqual(dialog.clientWidth + 1);
        let previousBottom = 0;
        for (const title of ["从本地导入", "从 URL 导入", "从运行时复制"]) {
          const button = page.getByRole("button", { name: new RegExp(`^${title}`, "u") }).element();
          const rect = button.getBoundingClientRect();
          const content = page
            .getByText(title, { exact: true })
            .element()
            .parentElement!.getBoundingClientRect();
          const style = getComputedStyle(button);
          expect(content.top).toBeGreaterThanOrEqual(rect.top + parseFloat(style.paddingTop) - 1);
          expect(content.bottom).toBeLessThanOrEqual(
            rect.bottom - parseFloat(style.paddingBottom) + 1,
          );
          expect(button.scrollWidth).toBeLessThanOrEqual(button.clientWidth + 1);
          expect(rect.top).toBeGreaterThanOrEqual(previousBottom + 6);
          previousBottom = rect.bottom;
        }
        const cancel = page
          .getByRole("button", { name: "取消", exact: true })
          .element()
          .getBoundingClientRect();
        expect(cancel.top).toBeGreaterThanOrEqual(previousBottom + 8);
      } finally {
        restoreFont();
      }
    },
  );

  const chooseRuntime = async (name = "Pi") => {
    await page.getByRole("combobox", { name: "选择运行时", exact: true }).click();
    await page.getByRole("option", { name, exact: true }).click();
  };
  const openRuntimeImport = async () => {
    await page.getByRole("button", { name: "导入技能", exact: true }).click();
    await page.getByRole("button", { name: /^从运行时复制/u }).click();
  };
  const nativePreview = (location: string): SkillLibraryPreview => ({
    ...preview,
    previewId: `native-${location.includes("draft") ? "draft" : "review"}`,
    source: { ...alpha.source, kind: "runtime", location, entryPath: "SKILL.md" },
    package: {
      ...pkg,
      entries: [
        { entryPath: "SKILL.md", name: "Selected native", description: "", issues: [] },
        {
          entryPath: "nested/SKILL.md",
          name: "Do not register this sibling",
          description: "",
          issues: [],
        },
      ],
    },
  });

  it("discovers no runtime until the import method and a runtime are explicitly selected", async () => {
    await mountPanel();
    expect(harness.discoverSkills).not.toHaveBeenCalled();
    await expect
      .element(page.getByRole("textbox", { name: "扫描项目目录" }))
      .not.toBeInTheDocument();
    await page.getByRole("button", { name: "导入技能", exact: true }).click();
    await expect.element(page.getByRole("button", { name: /^从运行时复制/u })).toBeVisible();
    expect(harness.discoverSkills).not.toHaveBeenCalled();
    await page.getByRole("button", { name: /^从 URL 导入/u }).click();
    await expect.element(page.getByRole("textbox", { name: "技能导入来源" })).toBeVisible();
    expect(harness.discoverSkills).not.toHaveBeenCalled();
    await page.getByRole("button", { name: "返回导入方式", exact: true }).click();
    await page.getByRole("button", { name: /^从运行时复制/u }).click();
    expect(harness.discoverSkills).not.toHaveBeenCalled();
    await expect
      .element(page.getByRole("textbox", { name: "技能导入来源" }))
      .not.toBeInTheDocument();
    await chooseRuntime();
    await expect.element(page.getByText("pi review", { exact: true })).toBeVisible();
    expect(harness.discoverSkills.mock.calls).toEqual([["pi"]]);
    await page.getByRole("button", { name: "取消", exact: true }).click();
    await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
  });

  it("does not expose late results or selected skills from another runtime", async () => {
    const late = deferred<ProviderSkillsCatalogResult>();
    const original = harness.discoverSkills.getMockImplementation()!;
    harness.discoverSkills.mockImplementation((provider) =>
      provider === "pi" ? late.promise : original(provider),
    );
    await mountPanel();
    await openRuntimeImport();
    await chooseRuntime();
    await chooseRuntime("Oh My Pi");
    await expect.element(page.getByText("omp review", { exact: true })).toBeVisible();
    await page.getByRole("checkbox", { name: "复制 omp review", exact: true }).click();
    late.resolve(await original("pi"));
    await expect.element(page.getByText("pi review", { exact: true })).not.toBeInTheDocument();
    await chooseRuntime("Codex");
    await expect.element(page.getByText("codex review", { exact: true })).toBeVisible();
    await expect
      .element(page.getByRole("button", { name: "导入选中技能", exact: true }))
      .toBeDisabled();
    expect(
      harness.server.skillLibrary.mock.calls.some(
        ([request]) => request.action === "previewImport",
      ),
    ).toBe(false);
  });

  it("searches and bulk copies only checked native entrypoints with non-destructive duplicate handling", async () => {
    const original = harness.server.skillLibrary.getMockImplementation()!;
    harness.server.skillLibrary.mockImplementation(async (request) => {
      if (request.action === "previewImport" && request.kind === "runtime")
        return { preview: nativePreview(request.location) };
      if (request.action === "import")
        return { skills: request.previewId.includes("draft") ? [] : [alpha] };
      return original(request);
    });
    await mountPanel();
    await openRuntimeImport();
    await chooseRuntime();
    await expect.element(page.getByText("pi review", { exact: true })).toBeVisible();
    await page.getByRole("textbox", { name: "搜索运行时技能" }).fill("review");
    await page.getByRole("checkbox", { name: "全选当前运行时技能" }).click();
    await page.getByRole("textbox", { name: "搜索运行时技能" }).fill("draft");
    await expect
      .element(page.getByText("已选择 1 个（1 个不在当前搜索中）", { exact: true }))
      .toBeVisible();
    await page.getByRole("checkbox", { name: "全选当前运行时技能" }).click();
    await page.getByRole("button", { name: "导入选中技能", exact: true }).click();
    await expect
      .element(page.getByText("已导入 1 个，已跳过 1 个。", { exact: true }))
      .toBeVisible();
    const imports = harness.server.skillLibrary.mock.calls
      .map(([request]) => request)
      .filter((request) => request.action === "import");
    expect(imports).toHaveLength(2);
    for (const request of imports)
      expect(request.choices).toEqual([{ entryPath: "SKILL.md", duplicate: "skip" }]);
    await expect
      .element(page.getByRole("button", { name: "导入选中技能", exact: true }))
      .toBeDisabled();
    await page.getByRole("button", { name: "完成", exact: true }).click();
    await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
  });

  it("reports partial failures and retries only failed native skills while releasing their previews", async () => {
    let failDraft = true;
    const original = harness.server.skillLibrary.getMockImplementation()!;
    harness.server.skillLibrary.mockImplementation(async (request) => {
      if (request.action === "previewImport" && request.kind === "runtime") {
        if (request.location.includes("draft") && failDraft) throw new Error("源文件暂时无法读取");
        return { preview: nativePreview(request.location) };
      }
      return original(request);
    });
    await mountPanel();
    await openRuntimeImport();
    await chooseRuntime();
    await expect.element(page.getByText("pi review", { exact: true })).toBeVisible();
    await page.getByRole("checkbox", { name: "全选当前运行时技能" }).click();
    await page.getByRole("button", { name: "导入选中技能", exact: true }).click();
    await expect
      .element(page.getByText("已导入 1 个，已跳过 0 个，1 个失败。", { exact: true }))
      .toBeVisible();
    expect(
      harness.server.skillLibrary.mock.calls.some(([request]) => request.action === "cancel"),
    ).toBe(true);
    failDraft = false;
    await page.getByRole("button", { name: "导入选中技能", exact: true }).click();
    await expect
      .element(page.getByText("已导入 1 个，已跳过 0 个。", { exact: true }))
      .toBeVisible();
    const previews = harness.server.skillLibrary.mock.calls
      .map(([request]) => request)
      .filter((request) => request.action === "previewImport");
    expect(previews.map((request) => request.location)).toEqual([
      "/home/.pi/skills/review/SKILL.md",
      "/home/.pi/skills/draft/SKILL.md",
      "/home/.pi/skills/draft/SKILL.md",
    ]);
  });

  it("keeps an active native copy visible and fits its picker inside a narrow viewport", async () => {
    const longDescription =
      "A long Skill description that must remain compact in the import picker. ".repeat(15).trim();
    const discover = harness.discoverSkills.getMockImplementation()!;
    harness.discoverSkills.mockImplementation(async (provider) => {
      const result = await discover(provider);
      return {
        skills: result.skills.map((skill, index) =>
          index === 0 ? { ...skill, description: longDescription } : skill,
        ),
      };
    });
    const late = deferred<SkillLibraryResponse>();
    const original = harness.server.skillLibrary.getMockImplementation()!;
    harness.server.skillLibrary.mockImplementation((request) =>
      request.action === "previewImport" ? late.promise : original(request),
    );
    await page.viewport(390, 844);
    await mountPanel(360);
    await openRuntimeImport();
    await chooseRuntime();
    await expect.element(page.getByText("pi review", { exact: true })).toBeVisible();
    const dialog = page.getByRole("dialog").element();
    expect(dialog.scrollWidth).toBeLessThanOrEqual(dialog.clientWidth + 1);
    const description = page.getByText(longDescription, { exact: true }).element();
    expect(description.getBoundingClientRect().height).toBeLessThanOrEqual(
      parseFloat(getComputedStyle(description).lineHeight) * 2 + 1,
    );
    await page.getByRole("checkbox", { name: "复制 pi review", exact: true }).click();
    await page.getByRole("button", { name: "导入选中技能", exact: true }).click();
    await userEvent.keyboard("{Escape}");
    await expect.element(page.getByRole("dialog")).toBeVisible();
    await expect.element(page.getByRole("button", { name: "取消", exact: true })).toBeDisabled();
    late.resolve({ preview: nativePreview("/home/.pi/skills/review/SKILL.md") });
    await expect
      .element(page.getByText("已导入 1 个，已跳过 0 个。", { exact: true }))
      .toBeVisible();
    const summary = page.getByText("已导入 1 个，已跳过 0 个。", { exact: true }).element();
    expect(summary.getBoundingClientRect().bottom).toBeLessThanOrEqual(
      dialog.getBoundingClientRect().bottom,
    );
  });

  it("removes disappeared selections after rediscovery and reports unsupported or empty runtimes", async () => {
    const discover = harness.discoverSkills.getMockImplementation()!;
    harness.discoverSkills.mockImplementation(async (provider) => {
      const result = await discover(provider);
      return {
        skills: [
          ...result.skills,
          { name: "Plain Markdown", path: "/home/.pi/skills/plain.md", scope: "pi", enabled: true },
        ],
      };
    });
    await mountPanel();
    await openRuntimeImport();
    await chooseRuntime();
    await expect
      .element(page.getByRole("checkbox", { name: "复制 Plain Markdown", exact: true }))
      .toBeDisabled();
    await page.getByRole("checkbox", { name: "复制 pi review", exact: true }).click();
    harness.discoverSkills.mockResolvedValue({ skills: [] });
    await page.getByRole("button", { name: "重新发现", exact: true }).click();
    await expect.element(page.getByText("未发现 Pi 的本机技能。", { exact: true })).toBeVisible();
    await expect.element(page.getByText("已选择 0 个", { exact: true })).toBeVisible();
    await expect
      .element(page.getByRole("button", { name: "导入选中技能", exact: true }))
      .toBeDisabled();
  });

  it("keeps disconnected and loading states distinct from an empty library", async () => {
    harness.connected = false;
    await mountPanel();
    await expect.element(page.getByText("服务器未连接，管理操作已暂停。")).toBeVisible();
    await expect
      .element(page.getByRole("button", { name: "刷新列表", exact: true }))
      .toBeDisabled();
    await expect.element(page.getByText("没有匹配的托管技能。")).not.toBeInTheDocument();
    await expect.element(page.getByText("尚未创建或导入技能。")).not.toBeInTheDocument();
    await expect.element(page.getByRole("group", { name: "批量操作" })).not.toBeInTheDocument();
    expect(harness.server.skillLibrary).not.toHaveBeenCalled();
  });

  it("shows loading before a successful empty response and distinguishes a filtered result", async () => {
    harness.skills = [];
    const pending = deferred<SkillLibraryResponse>();
    const original = harness.server.skillLibrary.getMockImplementation()!;
    harness.server.skillLibrary.mockImplementation((request) =>
      request.action === "list" && request.query ? pending.promise : original(request),
    );
    await mountPanel();
    await expect.element(page.getByText("正在读取技能库…")).toBeVisible();
    await expect.element(page.getByText("没有匹配的托管技能。")).not.toBeInTheDocument();
    pending.resolve({ skills: [], items: [] });
    await expect.element(page.getByText("尚未创建或导入技能。")).toBeVisible();
    await page.getByRole("textbox", { name: "搜索技能" }).fill("missing");
    await expect.element(page.getByText("没有匹配的托管技能。")).toBeVisible();
    await expect
      .element(page.getByText("运行时与项目技能", { exact: true }))
      .not.toBeInTheDocument();
    expect(harness.discoverSkills).not.toHaveBeenCalled();
  });

  it("fits a narrow settings column and keeps selected actions above long Skill rows", async () => {
    const longName = "Skill".repeat(35);
    harness.skills = [
      { ...alpha, name: longName, description: "Description".repeat(40), tags: ["tag".repeat(35)] },
    ];
    await mountPanel(360);
    const search = page.getByRole("textbox", { name: "搜索技能" }).element();
    const section = search.closest("section")!;
    const control = search.closest('[data-slot="input-control"]')!;
    expect(
      control.getBoundingClientRect().left - section.getBoundingClientRect().left,
    ).toBeGreaterThanOrEqual(12);
    expect(control.getBoundingClientRect().width).toBeGreaterThan(250);
    await expect.element(page.getByRole("group", { name: "批量操作" })).not.toBeInTheDocument();
    await page.getByRole("checkbox", { name: `选择 ${longName}` }).click();
    const actions = page.getByRole("group", { name: "批量操作" }).element();
    const list = page.getByRole("list", { name: "托管技能" }).element();
    expect(actions.getBoundingClientRect().bottom).toBeLessThanOrEqual(
      list.getBoundingClientRect().top,
    );
    expect(section.scrollWidth).toBeLessThanOrEqual(section.clientWidth + 1);
    await page.getByRole("button", { name: "取消选择", exact: true }).click();
    await expect.element(page.getByRole("group", { name: "批量操作" })).not.toBeInTheDocument();
  });

  it("refreshes the library and filter options together", async () => {
    await mountPanel();
    await expect.element(page.getByRole("checkbox", { name: "选择 Alpha" })).toBeVisible();
    const facetReads = () =>
      harness.server.skillLibrary.mock.calls.filter(
        ([request]) => request.action === "list" && !request.query,
      ).length;
    const before = facetReads();
    await page.getByRole("button", { name: "刷新列表", exact: true }).click();
    await expect.poll(facetReads).toBeGreaterThan(before);
  });

  it("combines all filter dimensions in one menu and clears conditions without clearing search", async () => {
    await mountPanel();
    await expect.element(page.getByRole("button", { name: "筛选条件", exact: true })).toBeVisible();
    await expect.element(page.getByText("来源筛选")).not.toBeInTheDocument();
    await page.getByRole("textbox", { name: "搜索技能" }).fill("Alpha");
    const choose = async (
      group: string,
      option: string,
      role: "menuitemcheckbox" | "menuitemradio" = "menuitemcheckbox",
    ) => {
      await page.getByRole("button", { name: "筛选条件", exact: true }).click();
      await page.getByRole("menuitem", { name: new RegExp(`^${group}`) }).click();
      await page.getByRole(role, { name: option, exact: true }).click();
      await userEvent.keyboard("{Escape}{Escape}");
    };
    await choose("使用状态", "未绑定", "menuitemradio");
    await choose("来源", "GitHub");
    await choose("来源", "手动创建");
    await choose("专家", "Review Expert");
    await choose("添加者", "未知");
    await choose("标签", "review");
    await expect
      .poll(() =>
        harness.server.skillLibrary.mock.calls.some(
          ([request]) =>
            request.action === "list" &&
            request.query?.search === "Alpha" &&
            request.query.usage === "unused" &&
            request.query.sources?.includes("github") &&
            request.query.sources.includes("manual") &&
            request.query.expertIds?.includes(expert.id) &&
            request.query.createdBy?.includes("unknown") &&
            request.query.tags?.includes("review"),
        ),
      )
      .toBe(true);
    await expect
      .element(page.getByRole("button", { name: "筛选条件", exact: true }))
      .toHaveTextContent("6");
    await page.getByRole("button", { name: "筛选条件", exact: true }).click();
    await page.getByRole("menuitem", { name: "清除筛选", exact: true }).click();
    await expect.element(page.getByRole("textbox", { name: "搜索技能" })).toHaveValue("Alpha");
    await expect
      .poll(() => harness.server.skillLibrary.mock.calls.at(-1)?.[0])
      .toMatchObject({
        action: "list",
        query: { search: "Alpha", sort: { field: "updated", direction: "desc" } },
      });
    await expect
      .element(page.getByRole("button", { name: "筛选条件", exact: true }))
      .not.toHaveTextContent("6");
  });

  it("controls sorting and displayed metadata in the compact sort panel", async () => {
    await mountPanel();
    const list = page.getByRole("list", { name: "托管技能" });
    await expect.element(list).toHaveTextContent("更新时间：");
    await expect.element(list).not.toHaveTextContent("来源：");
    await expect.element(list).not.toHaveTextContent("创建时间：");
    await page.getByRole("button", { name: "排序与显示", exact: true }).click();
    await page.getByRole("switch", { name: "来源", exact: true }).click();
    await page.getByRole("switch", { name: "创建时间", exact: true }).click();
    await page.getByRole("switch", { name: "添加者", exact: true }).click();
    await expect.element(list).toHaveTextContent("来源：url");
    await expect.element(list).toHaveTextContent("创建时间：未知");
    await expect.element(list).not.toHaveTextContent("添加者：");
    await page.getByRole("combobox", { name: "排序字段" }).click();
    await page.getByRole("option", { name: "绑定专家数", exact: true }).click();
    await page.getByRole("button", { name: "降序，切换为升序", exact: true }).click();
    await expect
      .poll(() =>
        harness.server.skillLibrary.mock.calls.some(
          ([request]) =>
            request.action === "list" &&
            request.query?.sort?.field === "usedBy" &&
            request.query.sort.direction === "asc",
        ),
      )
      .toBe(true);
    await userEvent.keyboard("{Escape}");
    await expect
      .element(page.getByRole("button", { name: "排序与显示", exact: true }))
      .toHaveTextContent("绑定专家数");
    expect(
      harness.server.skillLibrary.mock.calls.every(([request]) => request.action === "list"),
    ).toBe(true);
  });

  it("keeps compact filter and sort popups inside a narrow viewport", async () => {
    await page.viewport(390, 844);
    await mountPanel(360);
    await page.getByRole("button", { name: "筛选条件", exact: true }).click();
    await page.getByRole("menuitem", { name: /^来源/u }).click();
    await expect
      .element(page.getByRole("menuitemcheckbox", { name: "GitHub", exact: true }))
      .toBeVisible();
    for (const menu of document.querySelectorAll('[role="menu"]')) {
      const rect = menu.getBoundingClientRect();
      if (!rect.width) continue;
      expect(rect.left).toBeGreaterThanOrEqual(-1);
      expect(rect.right).toBeLessThanOrEqual(window.innerWidth + 1);
    }
    await userEvent.keyboard("{Escape}{Escape}");
    await page.getByRole("button", { name: "排序与显示", exact: true }).click();
    await expect.element(page.getByRole("switch", { name: "来源", exact: true })).toBeVisible();
    const popup = page
      .getByRole("switch", { name: "来源", exact: true })
      .element()
      .closest('[data-slot="popover-popup"]')!;
    expect(popup.getBoundingClientRect().left).toBeGreaterThanOrEqual(-1);
    expect(popup.getBoundingClientRect().right).toBeLessThanOrEqual(window.innerWidth + 1);
    await userEvent.keyboard("{Escape}");
  });

  it("adopts canonical SKILL.md after rename before a later body edit", async () => {
    const resources = managedFiles();
    await mountPanel();
    await page.getByText("Alpha", { exact: true }).click();
    await showFiles(true);
    await page.getByRole("button", { name: /alpha\/SKILL.md/u }).click();
    await expect
      .element(page.getByRole("textbox", { name: "alpha/SKILL.md", exact: true }))
      .toHaveTextContent("name: Alpha");
    await page.getByRole("tab", { name: "概览", exact: true }).click();
    await page.getByRole("textbox", { name: "技能名称" }).fill("Renamed Alpha");
    await page.getByRole("button", { name: "保存新版本", exact: true }).click();
    await showFiles(true);
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
    await page.getByRole("tab", { name: "概览", exact: true }).click();
    await expect
      .element(page.getByRole("textbox", { name: "技能名称" }))
      .toHaveValue("Renamed Alpha");
    await expect.element(page.getByRole("alert")).not.toBeInTheDocument();
  });
  it("uses the accepted revision after the real save-and-switch draft guard", async () => {
    const resources = managedFiles();
    await mountPanel();
    await page.getByText("Alpha", { exact: true }).click();
    await showFiles(true);
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
      request.action === "updateFromSource" && request.dryRun
        ? {
            updateResult: {
              skillId: request.skillId,
              status: "updated",
              preview: { ...preview, previewId: "current-refresh" },
            },
          }
        : original(request),
    );
    await mountPanel();
    await page.getByRole("button", { name: "导入技能", exact: true }).click();
    await page.getByRole("button", { name: /^从本地导入/u }).click();
    await page.getByRole("textbox", { name: "技能导入来源" }).fill("/source/library");
    await page.getByRole("button", { name: "预览", exact: true }).click();
    await page.getByRole("checkbox", { name: "导入 alpha/SKILL.md" }).click();
    await page.getByRole("button", { name: "导入选中入口", exact: true }).click();
    await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
    await page.getByRole("button", { name: "预览并确认覆盖", exact: true }).first().click();
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
      request.action === "updateFromSource" && request.dryRun ? late.promise : original(request),
    );
    await mountPanel();
    await page.getByRole("button", { name: "导入技能", exact: true }).click();
    await page.getByRole("button", { name: /^从本地导入/u }).click();
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
    await page.getByRole("button", { name: "预览并确认覆盖", exact: true }).first().click();
    await page.getByRole("button", { name: "取消", exact: true }).click();
    late.resolve({
      updateResult: {
        skillId: alpha.skillId,
        status: "updated",
        preview: { ...preview, previewId: "late-refresh" },
      },
    });
    await expect
      .poll(() =>
        harness.server.skillLibrary.mock.calls.some(
          ([request]) => request.action === "cancel" && request.previewId === "late-refresh",
        ),
      )
      .toBe(true);
    await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
    expect(
      harness.server.skillLibrary.mock.calls.some(
        ([request]) => request.action === "updateFromSource" && !request.dryRun,
      ),
    ).toBe(false);
  });
  it("filters and imports only explicitly checked entries with reviewed duplicate handling", async () => {
    await mountPanel();
    await expect.element(page.getByText("Alpha", { exact: true })).toBeVisible();
    await page.getByRole("textbox", { name: "搜索技能" }).fill("Beta");
    await expect.element(page.getByText("Alpha", { exact: true })).not.toBeInTheDocument();
    await page.getByRole("textbox", { name: "搜索技能" }).fill("");
    await page.getByRole("button", { name: "排序与显示", exact: true }).click();
    await page.getByRole("combobox", { name: "排序字段" }).click();
    await page.getByRole("option", { name: "名称", exact: true }).click();
    await page.getByRole("button", { name: "降序，切换为升序", exact: true }).click();
    await userEvent.keyboard("{Escape}");
    expect(
      harness.server.skillLibrary.mock.calls.some(
        ([request]) =>
          request.action === "list" &&
          request.query?.sort?.field === "name" &&
          request.query.sort.direction === "asc",
      ),
    ).toBe(true);
    await page.getByRole("button", { name: "筛选条件", exact: true }).click();
    await page.getByRole("menuitem", { name: /^标签/u }).click();
    await page.getByRole("menuitemcheckbox", { name: "review", exact: true }).click();
    await expect.element(page.getByText("Beta", { exact: true })).not.toBeInTheDocument();
    await page.getByRole("menuitemcheckbox", { name: "review", exact: true }).click();
    await userEvent.keyboard("{Escape}{Escape}");
    expect(
      harness.server.skillLibrary.mock.calls.some(
        ([request]) => request.action === "list" && request.query?.tags?.includes("review"),
      ),
    ).toBe(true);
    await page.getByRole("button", { name: "导入技能", exact: true }).click();
    await page.getByRole("button", { name: /^从本地导入/u }).click();
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

  it("plans N×M add-only binding on the server and applies with the same requestId", async () => {
    await mountPanel();
    await page.getByRole("checkbox", { name: "选择 Alpha" }).click();
    await page.getByRole("checkbox", { name: "选择 Beta" }).click();
    await page.getByRole("button", { name: "添加到专家", exact: true }).click();
    await page.getByRole("checkbox", { name: "选择专家 Review Expert" }).click();
    await page.getByRole("button", { name: "预演绑定", exact: true }).click();
    await expect.element(page.getByRole("list", { name: "绑定计划结果" })).toBeVisible();
    const plan = harness.server.skillLibrary.mock.calls
      .map(([request]) => request)
      .find((request) => request.action === "bindExperts" && request.dryRun === true);
    expect(plan?.action).toBe("bindExperts");
    if (!plan || plan.action !== "bindExperts") throw new Error("Missing server binding plan");
    await page.getByRole("button", { name: "应用计划／重试失败项", exact: true }).click();
    await expect
      .element(page.getByRole("list", { name: "绑定计划结果" }))
      .toHaveTextContent("已添加");
    await expect
      .element(page.getByRole("button", { name: "应用计划／重试失败项", exact: true }))
      .toBeDisabled();
    await page.getByRole("button", { name: "关闭", exact: true }).click();
    await expect.element(page.getByRole("status")).toHaveTextContent("批量绑定完成");
    const apply = harness.server.skillLibrary.mock.calls
      .map(([request]) => request)
      .find((request) => request.action === "bindExperts" && !request.dryRun);
    expect(apply).toMatchObject({
      requestId: plan.requestId,
      skillIds: plan.skillIds,
      targets: plan.targets,
    });
  });

  it("requires a fresh server preview and requestId after an Expert revision conflict", async () => {
    const original = harness.server.skillLibrary.getMockImplementation()!;
    let plans = 0;
    harness.server.skillLibrary.mockImplementation(async (request) => {
      if (request.action !== "bindExperts") return original(request);
      if (request.dryRun && plans++ === 0) {
        harness.experts = [{ ...expert, revision: 2 }];
        return {
          bindingResults: request.targets.map((target) => ({
            expertId: target.expertId,
            status: "conflict" as const,
            oldRevision: target.expectedRevision,
            newRevision: 2,
            addedSkillIds: [],
            skippedSkillIds: request.skillIds,
            error: "Expert revision changed",
          })),
          dryRun: true,
        };
      }
      return {
        bindingResults: request.targets.map((target) => ({
          expertId: target.expertId,
          status: "applied" as const,
          oldRevision: target.expectedRevision,
          newRevision: target.expectedRevision + 1,
          addedSkillIds: request.skillIds,
          skippedSkillIds: [],
        })),
        ...(request.dryRun ? { dryRun: true } : {}),
      };
    });
    await mountPanel();
    await page.getByRole("checkbox", { name: "选择 Alpha" }).click();
    await page.getByRole("button", { name: "添加到专家", exact: true }).click();
    await page.getByRole("checkbox", { name: "选择专家 Review Expert" }).click();
    await page.getByRole("button", { name: "预演绑定", exact: true }).click();
    await expect.element(page.getByRole("alert")).toHaveTextContent(/重新预演/u);
    const firstPlan = harness.server.skillLibrary.mock.calls
      .map(([request]) => request)
      .find((request) => request.action === "bindExperts" && request.dryRun);
    if (!firstPlan || firstPlan.action !== "bindExperts")
      throw new Error("Missing first binding plan");
    expect(firstPlan.targets[0]?.expectedRevision).toBe(1);
    await page.getByRole("button", { name: "读取最新版本并重新预演", exact: true }).click();
    const plansAfterReplan = harness.server.skillLibrary.mock.calls
      .map(([request]) => request)
      .filter((request) => request.action === "bindExperts" && request.dryRun);
    const replanned = plansAfterReplan.at(-1);
    if (!replanned || replanned.action !== "bindExperts")
      throw new Error("Missing revised binding plan");
    expect(replanned.requestId).not.toBe(firstPlan.requestId);
    expect(replanned.targets[0]?.expectedRevision).toBe(2);
    await page.getByRole("button", { name: "应用计划／重试失败项", exact: true }).click();
    const apply = harness.server.skillLibrary.mock.calls
      .map(([request]) => request)
      .find((request) => request.action === "bindExperts" && !request.dryRun);
    expect(apply).toMatchObject({ requestId: replanned.requestId, targets: replanned.targets });
  });

  it("updates a clean hosted Skill in one server call and requires overwrite confirmation for local edits", async () => {
    await mountPanel();
    await page.getByRole("button", { name: "更新来源", exact: true }).click();
    await expect
      .poll(() =>
        harness.server.skillLibrary.mock.calls.some(
          ([request]) => request.action === "updateFromSource" && !request.dryRun,
        ),
      )
      .toBe(true);
    expect(globalThis.confirm).not.toHaveBeenCalled();

    await page.getByRole("button", { name: "预览并确认覆盖", exact: true }).click();
    await expect.element(page.getByText(/来源更新会覆盖本地编辑/u)).toBeVisible();
    const previewCall = harness.server.skillLibrary.mock.calls
      .map(([request]) => request)
      .find((request) => request.action === "updateFromSource" && request.dryRun);
    expect(previewCall).toMatchObject({ overwriteLocalEdits: true });
    expect(
      harness.server.skillLibrary.mock.calls.some(
        ([request]) =>
          request.action === "updateFromSource" &&
          !request.dryRun &&
          request.skillId === alpha.skillId,
      ),
    ).toBe(false);
    await page.getByRole("button", { name: "确认覆盖并更新来源", exact: true }).click();
    const applied = harness.server.skillLibrary.mock.calls
      .map(([request]) => request)
      .find(
        (request) =>
          request.action === "updateFromSource" &&
          !request.dryRun &&
          request.skillId === alpha.skillId,
      );
    expect(applied).toMatchObject({
      requestId: previewCall?.action === "updateFromSource" ? previewCall.requestId : undefined,
      overwriteLocalEdits: true,
    });
  });

  it("reviews source overwrites, per-item batch failures and exact affected Expert deletion", async () => {
    await mountPanel();
    await page.getByRole("button", { name: "预览并确认覆盖", exact: true }).first().click();
    await expect.element(page.getByText(/来源更新会覆盖本地编辑/u)).toBeVisible();
    await expect.element(page.getByText("content/alpha/SKILL.md", { exact: true })).toBeVisible();
    expect(
      harness.server.skillLibrary.mock.calls.some(
        ([request]) => request.action === "updateFromSource" && request.dryRun,
      ),
    ).toBe(true);
    await page.getByRole("button", { name: "取消", exact: true }).click();
    await page.getByRole("checkbox", { name: "选择 Alpha" }).click();
    await page.getByRole("checkbox", { name: "选择 Beta" }).click();
    await page.getByRole("button", { name: "批量更新来源", exact: true }).click();
    await expect.element(page.getByText(/Beta · 失败 · Revision conflict/u)).toBeVisible();
    await page.getByRole("button", { name: "确认上述来源更新", exact: true }).click();
    await expect
      .poll(() =>
        harness.server.skillLibrary.mock.calls.some(
          ([request]) =>
            request.action === "batch" &&
            request.items.length === 1 &&
            request.items[0]?.operation === "updateFromSource" &&
            !!request.items[0]?.requestId &&
            request.dryRun !== true,
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
    managedFiles();
    await mountPanel();
    await page.getByText("Alpha", { exact: true }).click();
    await expect.element(page.getByRole("dialog")).toBeVisible();
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    const overviewWidth = dialog.getBoundingClientRect().width;
    const overviewTabsTop = page
      .getByRole("tablist", { name: "技能详情页签" })
      .element()
      .getBoundingClientRect().top;
    expect(overviewWidth).toBeLessThanOrEqual(920);
    await page.getByRole("combobox", { name: "技能标签" }).fill("checked");
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
    await page.getByRole("button", { name: "添加到专家", exact: true }).click();
    await page.getByRole("button", { name: "绑定", exact: true }).click();
    await expect.element(page.getByRole("switch", { name: "启用绑定技能" })).toBeChecked();
    expect(harness.server.skillLibrary).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "bindings",
        operation: "set",
        expectedRevision: 1,
        bindings: [{ skillId: alpha.skillId, enabled: true, activation: "on-demand" }],
      }),
    );
    await showFiles();
    expect(dialog.getBoundingClientRect().width).toBe(overviewWidth);
    expect(
      page.getByRole("tablist", { name: "技能详情页签" }).element().getBoundingClientRect().top,
    ).toBe(overviewTabsTop);
    await page.screenshot({ path: "../../../../../_bmad-output/skill-library-wide.png" });
    await page.viewport(390, 844);
    await expect.poll(() => dialog.getBoundingClientRect().width).toBeLessThanOrEqual(390);
    expect(dialog.scrollWidth).toBeLessThanOrEqual(dialog.clientWidth + 1);
    const filesPanel = page.getByRole("tabpanel", { name: /^文件/u }).element();
    const resources = filesPanel.children[0] as HTMLElement;
    const editor = filesPanel.children[1] as HTMLElement;
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
    await page.getByRole("button", { name: "添加到专家", exact: true }).click();
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
    await page.getByRole("button", { name: /^从URL导入|^从 URL 导入/u }).click();
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
