// FILE: registry.ts
// Purpose: Statically register existing Workbench settings and page entry points.
// Layer: Web Workbench integration boundary

type WorkbenchSettingsNavigation = {
  readonly group: "coding";
  readonly label: string;
  readonly description: string;
  readonly icon: string;
  readonly eyebrow: string;
  readonly badge?: string;
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
  },
} as const;

/**
 * Existing Expert UI is registered here as a static settings section and route-owned page.
 * This is a compile-time map, not a runtime plugin loader.
 */
export const WORKBENCH_MODULES = [expertsModule] as const;

export const WORKBENCH_SETTINGS_SECTION_IDS = [expertsModule.id] as const;

export type WorkbenchSettingsPageId = (typeof WORKBENCH_MODULES)[number]["settings"]["pageId"];

export function workbenchSettingsPageForSection(
  sectionId: string,
): WorkbenchSettingsPageId | undefined {
  return WORKBENCH_MODULES.find((module) => module.id === sectionId)?.settings.pageId;
}
