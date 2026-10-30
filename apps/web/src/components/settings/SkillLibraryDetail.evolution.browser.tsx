import "../../index.css";

import type {
  ExpertDefinition,
  SkillDefinition,
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
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

const harness = vi.hoisted(() => ({
  skill: undefined as SkillDefinition | undefined,
  server: {
    skillLibrary: vi.fn<(request: SkillLibraryRequest) => Promise<SkillLibraryResponse>>(),
    listExperts: vi.fn<() => Promise<ExpertDefinition[]>>(),
    readSkillPackage: vi.fn<() => Promise<SkillPackage>>(),
  },
}));

vi.mock("~/nativeApi", () => ({ ensureNativeApi: () => ({ server: harness.server }) }));
vi.mock("./skillPackageSettingsQueries", () => ({
  useSkillPackageConnection: () => ({ generation: "evolution-browser", connected: true }),
}));
vi.mock("~/hooks/useTheme", () => ({ useTheme: () => ({ resolvedTheme: "light" }) }));

import { SkillLibraryDetail } from "./SkillLibraryDetail";

const packageId = `pkg_${"c".repeat(64)}` as SkillDefinition["packageId"];
const baseSkill: SkillDefinition = {
  skillId: `skl_${"c".repeat(32)}` as SkillDefinition["skillId"],
  name: "Review method",
  description: "Reusable review steps.",
  tags: ["review"],
  packageId,
  entryPath: "SKILL.md",
  source: { kind: "manual", location: "", entryPath: "SKILL.md", packageId },
  locallyModified: false,
  revision: 4,
  deleted: false,
  updatedAt: "2026-10-27T00:00:00.000Z",
};
const expert: ExpertDefinition = {
  id: "review-expert",
  name: "Review Expert",
  description: "",
  useCases: "",
  persona: "Review work.",
  outputRequirements: "",
  skills: [],
  skillBindings: [{ skillId: baseSkill.skillId, enabled: true }],
  references: [],
  connections: [],
  revision: 2,
  archived: false,
  updatedAt: "2026-10-27T00:00:00.000Z",
};
const pkg: SkillPackage = {
  schemaVersion: 1,
  packageId,
  rootName: "review-method",
  resources: [{ path: "content/SKILL.md", kind: "file", size: 30, sha256: "a".repeat(64) }],
  entries: [{ entryPath: "SKILL.md", name: "Review method", description: "Review", issues: [] }],
  fileCount: 1,
  totalBytes: 30,
};
let dispose: (() => Promise<void>) | undefined;

async function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const root = createRootRoute({
    component: () => (
      <QueryClientProvider client={client}>
        <Outlet />
      </QueryClientProvider>
    ),
  });
  const detailRoute = createRoute({
    getParentRoute: () => root,
    path: "/detail",
    component: () => (
      <SkillLibraryDetail
        initial={harness.skill!}
        onClose={vi.fn()}
        onChanged={async () => {}}
        onDelete={vi.fn()}
      />
    ),
  });
  const router = createRouter({
    routeTree: root.addChildren([detailRoute]),
    history: createMemoryHistory({ initialEntries: ["/detail"] }),
  });
  const view = await render(<RouterProvider router={router} />);
  dispose = async () => {
    await view.unmount();
    client.clear();
  };
}

beforeEach(() => {
  harness.skill = { ...baseSkill };
  harness.server.skillLibrary.mockReset().mockImplementation(async (request) => {
    if (request.action === "read") return { skill: harness.skill };
    return {};
  });
  harness.server.listExperts.mockReset().mockResolvedValue([expert]);
  harness.server.readSkillPackage.mockReset().mockResolvedValue(pkg);
});

afterEach(async () => {
  await dispose?.();
  dispose = undefined;
});

describe("SkillLibraryDetail evolution settings", () => {
  it("shows shared scope as read-only information and removes policy controls", async () => {
    await mount();
    await expect.element(page.getByText("共享技能", { exact: true })).toBeVisible();
    await expect.element(page.getByRole("tab", { name: "进化策略" })).not.toBeInTheDocument();
    await expect
      .element(page.getByRole("combobox", { name: "Skill 进化策略" }))
      .not.toBeInTheDocument();
    await expect
      .element(page.getByRole("combobox", { name: "Skill 可用范围" }))
      .not.toBeInTheDocument();
  });

  it("shows an entry diagnostic in the existing source details without treating it as package corruption", async () => {
    harness.server.readSkillPackage.mockResolvedValue({
      ...pkg,
      entries: [
        {
          ...pkg.entries[0]!,
          diagnostics: [
            {
              code: "unknown_frontmatter_field",
              severity: "warning",
              message: "存在未识别的 frontmatter 字段。",
              entryPath: "SKILL.md",
              provider: "codex",
            },
          ],
        },
      ],
    });
    await mount();
    await expect
      .element(page.getByRole("status", { name: "入口配置提醒" }))
      .toHaveTextContent(/当前入口 SKILL\.md 有 1 条配置提醒/u);
    await expect.element(page.getByRole("tab", { name: "文件" })).toBeEnabled();
    await expect.element(page.getByRole("alert")).not.toBeInTheDocument();
    await page.getByRole("button", { name: "来源与版本" }).click();
    await expect
      .element(page.getByText("警告 · 存在未识别的 frontmatter 字段。", { exact: true }))
      .toBeVisible();
  });

  it("shows Expert ownership and derivation provenance as read-only facts", async () => {
    const sourceSkillId = `skl_${"b".repeat(32)}` as SkillDefinition["skillId"];
    const sourcePackageId = `pkg_${"b".repeat(64)}` as SkillDefinition["packageId"];
    harness.skill = {
      ...baseSkill,
      scope: { kind: "expert", expertId: expert.id },
      derivedFrom: {
        skillId: sourceSkillId,
        revision: 3,
        packageId: sourcePackageId,
      },
    };
    await mount();
    await expect.element(page.getByText("专家专用 · Review Expert", { exact: true })).toBeVisible();
    await expect
      .element(page.getByText(`${sourceSkillId} · v3 · ${sourcePackageId}`, { exact: true }))
      .toBeVisible();
    await expect.element(page.getByRole("tab", { name: "进化策略" })).not.toBeInTheDocument();
    await expect
      .element(page.getByRole("combobox", { name: "Skill 可用范围" }))
      .not.toBeInTheDocument();
  });
});
