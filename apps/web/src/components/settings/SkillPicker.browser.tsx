import "../../index.css";

import type {
  ExpertDefinition,
  ExpertSkillSelection,
  ProviderSkillDescriptor,
  SkillPackage,
  SkillPackagePreview,
} from "@synara/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { page } from "vitest/browser";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

const harness = vi.hoisted(() => ({
  generation: "picker-connection-a",
  connected: true,
  server: {
    readSkillPackage: vi.fn(),
    previewSkillPackage: vi.fn(),
    importSkillPackage: vi.fn(),
  },
}));

vi.mock("~/nativeApi", () => ({ ensureNativeApi: () => ({ server: harness.server }) }));
vi.mock("./skillPackageSettingsQueries", () => ({
  SKILL_PACKAGES_QUERY_KEY: ["server", "skillPackages"],
  SKILL_PACKAGE_SOURCES_QUERY_KEY: ["server", "skillPackageSources"],
  useSkillPackageConnection: () => ({
    generation: harness.generation,
    connected: harness.connected,
  }),
}));

import { SkillPicker } from "./SkillPicker";

const entry = (name: string, entryPath: string) => ({
  entryPath,
  name,
  description: `${name} description`,
  issues: [],
});

function makePackage(
  version: string,
  rootName: string,
  entries: ReturnType<typeof entry>[],
): SkillPackage {
  return {
    schemaVersion: 1,
    packageId: `pkg_${version.repeat(64)}`,
    rootName,
    resources: [],
    entries,
    fileCount: entries.length,
    totalBytes: 0,
  };
}

const currentPackage = makePackage("a", "current", [entry("Current skill", "current/SKILL.md")]);
const reusedPackage = makePackage("b", "reused", [entry("Reused skill", "reused/SKILL.md")]);
const unselectedPackage = makePackage("c", "unselected", [
  entry("Unselected skill", "unselected/SKILL.md"),
]);
const directoryPackage = makePackage("d", "directory", [
  entry("Directory planner", "planner/SKILL.md"),
  entry("Directory reviewer", "reviewer/SKILL.md"),
]);
const filePackage = makePackage("e", "single-file", [
  entry("Single file skill", "SKILL.md"),
  entry("Nested sibling skill", "nested/SKILL.md"),
]);

function previewFor(pkg: SkillPackage, previewId: string, sourcePath: string): SkillPackagePreview {
  return {
    previewId,
    sourcePath,
    realRoot: sourcePath,
    expiresAt: "2026-10-22T00:00:00.000Z",
    package: pkg,
    issues: [],
  };
}

const directoryPreview = previewFor(directoryPackage, "preview-directory", "/skills/team");
const filePreview = previewFor(filePackage, "preview-file", "/skills/single/SKILL.md");
const packageById = new Map(
  [currentPackage, reusedPackage, unselectedPackage, directoryPackage, filePackage].map((pkg) => [
    pkg.packageId,
    pkg,
  ]),
);
const skillCheckbox = (name: string) => page.getByRole("checkbox", { name, exact: true });

function expert(
  id: string,
  name: string,
  skillSelections: ExpertSkillSelection[],
): ExpertDefinition {
  return {
    id,
    name,
    description: "",
    useCases: "",
    persona: "",
    outputRequirements: "",
    skills: [],
    skillSelections,
    references: [],
    connections: [],
    revision: 1,
    archived: false,
    updatedAt: "2026-10-22T00:00:00.000Z",
  } as ExpertDefinition;
}

function selection(pkg: SkillPackage, activation: "startup" | "on-demand" = "on-demand") {
  return {
    packageId: pkg.packageId,
    entryPath: pkg.entries[0]!.entryPath,
    activation,
  } satisfies ExpertSkillSelection;
}

const emptyCatalog: ProviderSkillDescriptor[] = [];

async function mountPicker({
  skills = [],
  selections = [],
  experts = [],
  packages = [],
  catalog = emptyCatalog,
}: {
  skills?: ExpertDefinition["skills"];
  selections?: ExpertSkillSelection[];
  experts?: ExpertDefinition[];
  packages?: SkillPackage[];
  catalog?: ProviderSkillDescriptor[];
} = {}) {
  const onApply = vi.fn((_next: ExpertSkillSelection[]) => undefined);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  const picker = () => (
    <QueryClientProvider client={queryClient}>
      <SkillPicker
        skills={skills}
        selections={selections}
        expertName="规划专家"
        experts={experts}
        packages={packages}
        catalog={catalog}
        catalogError={null}
        catalogLoading={false}
        disabled={false}
        onApply={onApply}
      />
    </QueryClientProvider>
  );
  const view = await render(picker());
  return {
    onApply,
    view,
    rerender: async () => view.rerender(picker()),
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

beforeEach(() => {
  harness.generation = "picker-connection-a";
  harness.connected = true;
  harness.server.readSkillPackage.mockReset();
  harness.server.previewSkillPackage.mockReset();
  harness.server.importSkillPackage.mockReset();
  harness.server.readSkillPackage.mockImplementation(
    async ({ packageId }: { packageId: string }) => {
      const pkg = packageById.get(packageId);
      if (!pkg) throw new Error(`Unknown package ${packageId}`);
      return pkg;
    },
  );
  harness.server.previewSkillPackage.mockImplementation(async ({ path }: { path: string }) =>
    path.endsWith("SKILL.md") ? filePreview : directoryPreview,
  );
  harness.server.importSkillPackage.mockImplementation(
    async ({ previewId }: { previewId: string }) => {
      const preview = [directoryPreview, filePreview].find((item) => item.previewId === previewId);
      if (!preview) throw new Error(`Unknown preview ${previewId}`);
      return {
        package: preview.package,
        source: {
          sourceId: `src_${"f".repeat(64)}`,
          sourcePath: preview.sourcePath,
          realRoot: preview.realRoot,
          packageId: preview.package.packageId,
          revision: 1,
          importedAt: "2026-10-22T00:00:00.000Z",
        },
        reused: false,
      };
    },
  );
});

describe("SkillPicker browser flows", () => {
  it("replaces all pending choices with a searched expert, preserves activation, and can undo", async () => {
    const experts = Array.from({ length: 8 }, (_, index) =>
      expert(`empty-${index}`, `空专家 ${index + 1}`, []),
    );
    experts.push(expert("reuse-target", "目标复用专家", [selection(reusedPackage, "startup")]));
    const mounted = await mountPicker({
      selections: [selection(currentPackage, "on-demand")],
      experts,
      packages: [unselectedPackage, reusedPackage, currentPackage],
    });

    await page.getByRole("button", { name: "添加技能", exact: true }).click();
    await expect
      .element(page.getByRole("heading", { name: "添加技能至 · 规划专家" }))
      .toBeVisible();
    await expect.element(skillCheckbox("Current skill")).toBeChecked();
    await expect
      .element(page.getByRole("checkbox").nth(0))
      .toHaveAttribute("aria-label", "选择技能 Current skill");
    await skillCheckbox("Unselected skill").click();
    await expect
      .element(page.getByRole("checkbox").nth(0))
      .toHaveAttribute("aria-label", "选择技能 Current skill");
    await expect.element(skillCheckbox("Unselected skill")).toBeChecked();
    await page.getByRole("button", { name: "从专家复用技能", exact: true }).click();
    const search = page.getByRole("textbox", { name: "搜索专家名称", exact: true });
    await expect.element(search).toBeVisible();
    await search.fill("目标复用");
    await page.getByRole("button", { name: /目标复用专家/u }).click();

    await expect
      .element(page.getByRole("status"))
      .toHaveTextContent("已选择「目标复用专家」的1项技能");
    await expect.element(page.getByText(/已复用|已修改/u)).not.toBeInTheDocument();
    await expect.element(skillCheckbox("Reused skill")).toBeChecked();
    await page.getByRole("button", { name: "撤销此次覆盖", exact: true }).click();
    await expect.element(skillCheckbox("Current skill")).toBeChecked();
    await expect.element(skillCheckbox("Unselected skill")).toBeChecked();
    await expect.element(skillCheckbox("Reused skill")).not.toBeChecked();

    await page.getByRole("button", { name: "从专家复用技能", exact: true }).click();
    await page.getByRole("textbox", { name: "搜索专家名称", exact: true }).fill("目标复用");
    await page.getByRole("button", { name: /目标复用专家/u }).click();
    await page.getByRole("button", { name: "仅看已选", exact: true }).click();
    await expect.element(skillCheckbox("Current skill")).not.toBeInTheDocument();
    await expect.element(skillCheckbox("Reused skill")).toBeChecked();
    await expect
      .element(page.getByRole("checkbox").nth(0))
      .toHaveAttribute("aria-label", "选择技能 Reused skill");
    await page.getByRole("button", { name: "应用选择（1）", exact: true }).click();
    await expect.poll(() => mounted.onApply.mock.calls.length).toBe(1);
    expect(mounted.onApply).toHaveBeenCalledWith([selection(reusedPackage, "startup")]);
    expect(harness.server.readSkillPackage).toHaveBeenCalledWith({
      packageId: reusedPackage.packageId,
    });
    expect(harness.server.importSkillPackage).not.toHaveBeenCalled();
    await mounted.close();
  });

  it("filters to selected choices, clears them, reports zero, and applies an empty selection", async () => {
    const mounted = await mountPicker({
      selections: [selection(currentPackage)],
      packages: [currentPackage, unselectedPackage],
    });
    await page.getByRole("button", { name: "添加技能", exact: true }).click();
    await page.getByRole("button", { name: "仅看已选", exact: true }).click();
    await expect.element(skillCheckbox("Unselected skill")).not.toBeInTheDocument();
    await expect.element(page.getByText("已选 1 项", { exact: true })).toBeVisible();

    await page.getByRole("button", { name: "清空已选", exact: true }).click();
    await expect.element(page.getByText("已选 0 项", { exact: true })).toBeVisible();
    await expect.element(page.getByText("当前筛选下没有已选技能", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "应用选择（0）", exact: true }).click();
    await expect.poll(() => mounted.onApply.mock.calls.length).toBe(1);
    expect(mounted.onApply).toHaveBeenCalledWith([]);
    await mounted.close();
  });

  it("searches the short and full catalog descriptions and shows the full text in the tooltip", async () => {
    const catalogSkill: ProviderSkillDescriptor = {
      name: "synara:research",
      description: "Full details include the unique phrase evidence ledger.",
      path: "/skills/research/SKILL.md",
      enabled: true,
      scope: "synara",
      interface: {
        displayName: "Research assistant",
        shortDescription: "Build a research outline.",
      },
    };
    const mounted = await mountPicker({ catalog: [catalogSkill] });
    await page.getByRole("button", { name: "添加技能", exact: true }).click();
    const search = page.getByRole("textbox", { name: "搜索技能", exact: true });
    const skill = skillCheckbox("Research assistant");

    await search.fill("evidence ledger");
    await expect.element(skill).toBeVisible();
    await search.fill("research outline");
    await expect.element(skill).toBeVisible();
    await search.fill("");
    await expect
      .element(page.getByText("Build a research outline.", { exact: true }))
      .toBeVisible();
    await page
      .getByRole("button", { name: "查看技能路径 Research assistant", exact: true })
      .hover();
    await expect
      .element(
        page.getByText(/Full details include the unique phrase evidence ledger\.[\s\S]*ID：/u),
      )
      .toHaveTextContent("Full details include the unique phrase evidence ledger.");
    await expect
      .element(
        page.getByText(/Full details include the unique phrase evidence ledger\.[\s\S]*ID：/u),
      )
      .toHaveTextContent("synara:research");
    await mounted.close();
  });

  it("previews a directory into package choices and imports only when Apply is pressed", async () => {
    const mounted = await mountPicker();
    await page.getByRole("button", { name: "添加技能", exact: true }).click();
    await page.getByRole("radio", { name: "按路径", exact: true }).click();
    await page.getByRole("textbox", { name: "新技能路径", exact: true }).fill("/skills/team");
    await page.getByRole("button", { name: "读取技能", exact: true }).click();
    await expect.element(skillCheckbox("Directory planner")).toBeChecked();
    await expect.element(skillCheckbox("Directory reviewer")).toBeChecked();
    expect(harness.server.previewSkillPackage).toHaveBeenCalledWith({ path: "/skills/team" });
    expect(harness.server.importSkillPackage).not.toHaveBeenCalled();
    await page.getByRole("button", { name: "应用选择（2）", exact: true }).click();
    await expect.poll(() => mounted.onApply.mock.calls.length).toBe(1);
    expect(harness.server.importSkillPackage).toHaveBeenCalledWith({
      previewId: directoryPreview.previewId,
      idempotencyKey: directoryPreview.previewId,
    });
    expect(mounted.onApply).toHaveBeenCalledWith([
      {
        packageId: directoryPackage.packageId,
        entryPath: "planner/SKILL.md",
        activation: "on-demand",
      },
      {
        packageId: directoryPackage.packageId,
        entryPath: "reviewer/SKILL.md",
        activation: "on-demand",
      },
    ]);
    await mounted.close();
  });

  it("previews a regular SKILL.md path as one package choice and imports on Apply", async () => {
    const mounted = await mountPicker();
    await page.getByRole("button", { name: "添加技能", exact: true }).click();
    await page.getByRole("radio", { name: "按路径", exact: true }).click();
    await page
      .getByRole("textbox", { name: "新技能路径", exact: true })
      .fill("/skills/single/SKILL.md");
    await page.getByRole("button", { name: "读取技能", exact: true }).click();
    await expect.element(skillCheckbox("Single file skill")).toBeChecked();
    await page.getByRole("button", { name: "仅看已选", exact: true }).click();
    await expect.element(skillCheckbox("Nested sibling skill")).not.toBeChecked();
    expect(harness.server.importSkillPackage).not.toHaveBeenCalled();
    await page.getByRole("button", { name: "应用选择（1）", exact: true }).click();
    await expect.poll(() => mounted.onApply.mock.calls.length).toBe(1);
    expect(harness.server.importSkillPackage).toHaveBeenCalledWith({
      previewId: filePreview.previewId,
      idempotencyKey: filePreview.previewId,
    });
    expect(mounted.onApply).toHaveBeenCalledWith([
      {
        packageId: filePackage.packageId,
        entryPath: "SKILL.md",
        activation: "on-demand",
      },
    ]);
    await mounted.close();
  });

  it("shows preview failures and ignores a preview that completes after Cancel", async () => {
    const mounted = await mountPicker();
    harness.server.previewSkillPackage.mockRejectedValueOnce(new Error("路径不存在。"));
    await page.getByRole("button", { name: "添加技能", exact: true }).click();
    await page.getByRole("radio", { name: "按路径", exact: true }).click();
    await page.getByRole("textbox", { name: "新技能路径", exact: true }).fill("/missing/SKILL.md");
    await page.getByRole("button", { name: "读取技能", exact: true }).click();
    await expect.element(page.getByRole("alert")).toHaveTextContent("路径不存在。");

    const pending = deferred<SkillPackagePreview>();
    harness.server.previewSkillPackage.mockReturnValueOnce(pending.promise);
    await page.getByRole("textbox", { name: "新技能路径", exact: true }).fill("/skills/team");
    await page.getByRole("button", { name: "读取技能", exact: true }).click();
    await expect.poll(() => harness.server.previewSkillPackage.mock.calls.length).toBe(2);
    await page.getByRole("button", { name: "取消", exact: true }).click();
    await page.getByRole("button", { name: "添加技能", exact: true }).click();
    await expect.element(page.getByText("已选 0 项", { exact: true })).toBeVisible();
    pending.resolve(directoryPreview);
    await pending.promise;
    await expect.element(page.getByText("已选 0 项", { exact: true })).toBeVisible();
    await expect.element(skillCheckbox("Directory planner")).not.toBeInTheDocument();
    expect(mounted.onApply).not.toHaveBeenCalled();
    expect(harness.server.importSkillPackage).not.toHaveBeenCalled();
    await mounted.close();
  });

  it("closes and invalidates an in-flight preview when the server disconnects", async () => {
    const pending = deferred<SkillPackagePreview>();
    harness.server.previewSkillPackage.mockReturnValueOnce(pending.promise);
    const mounted = await mountPicker();
    await page.getByRole("button", { name: "添加技能", exact: true }).click();
    await page.getByRole("radio", { name: "按路径", exact: true }).click();
    await page.getByRole("textbox", { name: "新技能路径", exact: true }).fill("/skills/team");
    await page.getByRole("button", { name: "读取技能", exact: true }).click();
    await expect.poll(() => harness.server.previewSkillPackage.mock.calls.length).toBe(1);

    harness.connected = false;
    await mounted.rerender();
    await expect.element(page.getByRole("dialog", { name: /添加技能至/u })).not.toBeInTheDocument();
    pending.resolve(directoryPreview);
    await pending.promise;

    harness.connected = true;
    await mounted.rerender();
    await page.getByRole("button", { name: "添加技能", exact: true }).click();
    await expect.element(page.getByText("已选 0 项", { exact: true })).toBeVisible();
    await expect.element(skillCheckbox("Directory planner")).not.toBeInTheDocument();
    expect(mounted.onApply).not.toHaveBeenCalled();
    expect(harness.server.importSkillPackage).not.toHaveBeenCalled();
    await mounted.close();
  });
});
