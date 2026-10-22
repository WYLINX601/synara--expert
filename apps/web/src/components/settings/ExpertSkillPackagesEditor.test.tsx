import type { ExpertSaveInput, SkillPackage } from "@synara/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ExpertEditor } from "./ExpertEditor";
import { skillPackagesQueryKey } from "./skillPackageSettingsQueries";

vi.mock("./skillPackageSettingsQueries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./skillPackageSettingsQueries")>()),
  useSkillPackageConnection: () => ({ generation: null, connected: true }),
}));

const skillPackage: SkillPackage = {
  schemaVersion: 1,
  packageId: `pkg_${"a".repeat(64)}`,
  rootName: "planner-skills",
  resources: [],
  entries: [
    {
      entryPath: "planner/SKILL.md",
      name: "Planner",
      description: "Plan work in small steps.",
      issues: [],
    },
  ],
  fileCount: 0,
  totalBytes: 0,
};

function renderEditor(draft: ExpertSaveInput) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData(skillPackagesQueryKey(null), [skillPackage]);
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <ExpertEditor
        header={<div />}
        draft={draft}
        issues={[]}
        tab="capabilities"
        readonly={false}
        connections={[]}
        connectionsLoading={false}
        connectionsError={null}
        catalog={[]}
        catalogLoading={false}
        catalogError={null}
        onTabChange={() => undefined}
        onChange={() => undefined}
        onOpenConnections={() => undefined}
      />
    </QueryClientProvider>,
  );
}

const commonDraft = {
  name: "Planner expert",
  description: "",
  useCases: "",
  persona: "",
  outputRequirements: "",
  references: [],
  connections: [],
};

describe("ExpertSkillPackagesEditor integration", () => {
  it("keeps legacy path skills visible and exposes the unified picker", () => {
    const markup = renderEditor({
      ...commonDraft,
      skills: [{ name: "Legacy planner", path: "/old/skills/planner/SKILL.md" }],
    });

    expect(markup).toContain("Legacy planner");
    expect(markup).toContain('aria-label="添加技能"');
    expect(markup).not.toContain("改用版本包");
    expect(markup).not.toContain('aria-label="选择技能 Planner"');
  });

  it("keeps an empty package draft collapsed until the picker opens", () => {
    const markup = renderEditor({ ...commonDraft, skills: [], skillSelections: [] });

    expect(markup).toContain('aria-label="添加技能"');
    expect(markup).not.toContain("Planner");
    expect(markup).not.toContain('aria-label="选择技能 Planner"');
  });
});
