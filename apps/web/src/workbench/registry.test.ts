import { describe, expect, it } from "vitest";

import {
  normalizeSettingsSection,
  SETTINGS_NAV_ITEMS,
  SETTINGS_SECTION_IDS,
} from "../settingsNavigation";
import { settingsSectionLabel } from "../settingsSearchIndex";
import {
  WORKBENCH_MODULES,
  WORKBENCH_SETTINGS_SECTION_IDS,
  workbenchSettingsPageForSection,
} from "./registry";

describe("Workbench web registry", () => {
  it("registers the existing Experts setting and route-owned page from one static entry", () => {
    const expertsModule = WORKBENCH_MODULES.find((module) => module.id === "experts");

    expect(expertsModule).toBeDefined();
    expect(WORKBENCH_SETTINGS_SECTION_IDS).toEqual(["experts"]);
    expect(SETTINGS_SECTION_IDS).toContain(expertsModule!.id);
    expect(normalizeSettingsSection(expertsModule!.id)).toBe(expertsModule!.id);
    expect(SETTINGS_NAV_ITEMS.find((item) => item.id === expertsModule!.id)).toEqual({
      id: expertsModule!.id,
      ...expertsModule!.settings.navigation,
    });
    expect(SETTINGS_NAV_ITEMS.map((item) => item.id)).toEqual([
      "general",
      "profile",
      "appearance",
      "notifications",
      "behavior",
      "shortcuts",
      "usage",
      "appsnap",
      "computer",
      "integrations",
      "providers",
      "models",
      "skills",
      "experts",
      "worktrees",
      "advanced",
      "archived",
    ]);
    expect(settingsSectionLabel(expertsModule!.id)).toBe("Experts");
    expect(workbenchSettingsPageForSection(expertsModule!.id)).toBe("experts-settings");
  });

  it("does not turn unrelated native settings into Workbench pages", () => {
    expect(workbenchSettingsPageForSection("general")).toBeUndefined();
    expect(workbenchSettingsPageForSection("unknown-plugin-page")).toBeUndefined();
  });
});
