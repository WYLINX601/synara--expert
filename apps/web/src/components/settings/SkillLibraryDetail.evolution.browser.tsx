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
  configureCalls: [] as SkillLibraryRequest[],
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
  skillBindings: [{ skillId: baseSkill.skillId, enabled: true, activation: "on-demand" }],
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
  harness.configureCalls = [];
  harness.server.skillLibrary.mockReset().mockImplementation(async (request) => {
    if (request.action === "read") return { skill: harness.skill };
    if (request.action === "configureEvolution") {
      harness.configureCalls.push(request);
      harness.skill = {
        ...harness.skill!,
        revision: harness.skill!.revision + 1,
        evolutionPolicy: request.evolutionPolicy,
        scope: request.scope,
      };
      return { skill: harness.skill };
    }
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
  it("saves policy through configureEvolution with the expected revision", async () => {
    await mount();
    await page.getByRole("tab", { name: "进化策略" }).click();
    await page.getByRole("combobox", { name: "Skill 进化策略" }).click();
    await page.getByRole("option", { name: "共享进化" }).click();
    await page.getByRole("button", { name: "保存进化策略" }).click();
    await expect.poll(() => harness.configureCalls.length).toBe(1);
    expect(harness.configureCalls[0]).toMatchObject({
      action: "configureEvolution",
      skillId: baseSkill.skillId,
      expectedRevision: 4,
      evolutionPolicy: "shared",
      scope: { kind: "shared" },
    });
  });

  it("keeps shared scope when a shared source is configured for independent evolution", async () => {
    await mount();
    await page.getByRole("tab", { name: "进化策略" }).click();
    await page.getByRole("combobox", { name: "Skill 进化策略" }).click();
    await page.getByRole("option", { name: "独立进化" }).click();
    await page.getByRole("button", { name: "保存进化策略" }).click();
    await expect.poll(() => harness.configureCalls.length).toBe(1);
    expect(harness.configureCalls[0]).toMatchObject({
      action: "configureEvolution",
      evolutionPolicy: "independent",
      scope: { kind: "shared" },
    });
  });

  it("requires explicit confirmation before changing an expert-only scope", async () => {
    await mount();
    await page.getByRole("tab", { name: "进化策略" }).click();
    await page.getByRole("combobox", { name: "Skill 可用范围" }).click();
    await page.getByRole("option", { name: "Review Expert" }).click();
    await page.getByRole("button", { name: "保存进化策略" }).click();
    await expect
      .element(page.getByRole("heading", { name: "确认更改 Skill 可用范围" }))
      .toBeVisible();
    await expect.element(page.getByText(/当前有 1 个专家引用此 Skill/)).toBeVisible();
    await page.getByRole("button", { name: "取消" }).click();
    await expect.poll(() => harness.configureCalls.length).toBe(0);

    await page.getByRole("button", { name: "保存进化策略" }).click();
    await page.getByRole("button", { name: "确认并保存范围" }).click();
    await expect.poll(() => harness.configureCalls.length).toBe(1);
    expect(harness.configureCalls[0]).toMatchObject({
      action: "configureEvolution",
      expectedRevision: 4,
      scope: { kind: "expert", expertId: expert.id },
    });
  });
});
