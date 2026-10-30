// FILE: registry.ts
// Purpose: Statically register existing Workbench settings and page entry points.
// Layer: Web Workbench integration boundary

type WorkbenchSettingsNavigation = {
  readonly group: "coding" | "integrations";
  readonly label: string;
  readonly description: string;
  readonly icon: string;
  readonly eyebrow: string;
  readonly badge?: string;
};

type WorkbenchSettingsSearchEntry = {
  readonly id: string;
  readonly title: string;
  readonly keywords: string;
  readonly target?: null;
  readonly query?: Readonly<Record<string, string>>;
};

export type WorkbenchSettingsSearchRoute = "/experts";

type WorkbenchSettingsSearch = {
  readonly keywords: string;
  readonly route?: WorkbenchSettingsSearchRoute;
  readonly entries?: readonly WorkbenchSettingsSearchEntry[];
};

const EXPERTS_MODULE_ID = "experts" as const;

const expertsModule = {
  id: EXPERTS_MODULE_ID,
  settings: {
    pageId: "experts-settings",
    navigation: {
      group: "coding",
      label: "Experts",
      description: "Manage the role, skills, references, and runtime preference for new tasks.",
      icon: "brain",
      eyebrow: "Task specialists",
    } satisfies WorkbenchSettingsNavigation,
    search: {
      keywords:
        "expert specialist reusable role persona skills references provider model new task agent configuration",
      route: "/experts",
      entries: [] as readonly WorkbenchSettingsSearchEntry[],
    } satisfies WorkbenchSettingsSearch,
  },
} as const;

const mcpSettingsModule = {
  id: "mcp",
  settings: {
    pageId: "mcp-settings",
    navigation: {
      group: "integrations",
      label: "MCP",
      description: "配置专家可调用的外部工具，并管理应用接入 Synara。",
      icon: "plugin-1",
      eyebrow: "MCP integrations",
    } satisfies WorkbenchSettingsNavigation,
    search: {
      keywords:
        "MCP model context protocol connections connectors external tools discovery import authorization credentials experts",
      entries: [
        {
          id: "mcp:apps",
          title: "External MCP integrations",
          keywords:
            "Pair Codex Claude and other local MCP clients with scoped project access. revoke credential task create wait read worktree approval",
          target: null,
          query: { tab: "apps" },
        },
      ],
    } satisfies WorkbenchSettingsSearch,
  },
} as const;

/**
 * Workbench settings pages are registered here as static sections and route-owned pages.
 * This is a compile-time map, not a runtime plugin loader.
 */
export const WORKBENCH_MODULES = [expertsModule, mcpSettingsModule] as const;

export const WORKBENCH_SETTINGS_SECTION_IDS = WORKBENCH_MODULES.map((module) => module.id);

export type WorkbenchSettingsPageId = (typeof WORKBENCH_MODULES)[number]["settings"]["pageId"];

export function workbenchSettingsPageForSection(
  sectionId: string,
): WorkbenchSettingsPageId | undefined {
  return WORKBENCH_MODULES.find((module) => module.id === sectionId)?.settings.pageId;
}
