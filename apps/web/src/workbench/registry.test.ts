import { describe, expect, it } from "vitest";

import { Route } from "../routes/_chat.settings";
import {
  mcpSettingsTabForRoute,
  normalizeSettingsSection,
  SETTINGS_NAV_ITEMS,
  SETTINGS_SECTION_IDS,
  validateSettingsRouteSearch,
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
    expect(WORKBENCH_SETTINGS_SECTION_IDS).toEqual(["experts", "mcp"]);
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
      "providers",
      "models",
      "skills",
      "experts",
      "mcp",
      "worktrees",
      "advanced",
      "archived",
    ]);
    expect(settingsSectionLabel(expertsModule!.id)).toBe("Experts");
    expect(workbenchSettingsPageForSection(expertsModule!.id)).toBe("experts-settings");
    expect(expertsModule!.settings.search.keywords).toContain("specialist");
  });

  it("registers one MCP settings entry and normalizes legacy section links", () => {
    const mcpModule = WORKBENCH_MODULES.find((module) => module.id === "mcp");

    expect(mcpModule).toBeDefined();
    expect(WORKBENCH_SETTINGS_SECTION_IDS).toEqual(["experts", "mcp"]);
    expect(SETTINGS_SECTION_IDS).toContain("mcp");
    expect(SETTINGS_SECTION_IDS).toContain("expert-connections");
    expect(SETTINGS_SECTION_IDS).toContain("integrations");
    expect(normalizeSettingsSection("expert-connections")).toBe("mcp");
    expect(normalizeSettingsSection("integrations")).toBe("mcp");
    expect(SETTINGS_NAV_ITEMS.find((item) => item.id === "mcp")).toEqual({
      id: "mcp",
      ...mcpModule!.settings.navigation,
    });
    expect(mcpModule!.settings.navigation.label).toBe("MCP");
    expect(mcpModule!.settings.navigation.group).toBe("integrations");
    expect(mcpModule!.settings.search.entries).toEqual([
      {
        id: "mcp:apps",
        title: "External MCP integrations",
        keywords: expect.stringContaining("scoped project access"),
        target: null,
        query: { tab: "apps" },
      },
    ]);
    expect(settingsSectionLabel("expert-connections")).toBe("MCP");
    expect(settingsSectionLabel("integrations")).toBe("MCP");
    expect(workbenchSettingsPageForSection("mcp")).toBe("mcp-settings");
    expect(mcpSettingsTabForRoute("mcp", undefined)).toBe("tools");
    expect(mcpSettingsTabForRoute("expert-connections", undefined)).toBe("tools");
    expect(mcpSettingsTabForRoute("integrations", undefined)).toBe("apps");
    expect(mcpSettingsTabForRoute("integrations", "tools")).toBe("tools");
    expect(validateSettingsRouteSearch({ section: "integrations" })).toMatchObject({
      section: "mcp",
      tab: "apps",
    });
    expect(Route.options.validateSearch).toBe(validateSettingsRouteSearch);
    expect(validateSettingsRouteSearch({ section: "integrations" })).toMatchObject({
      section: "mcp",
      tab: "apps",
    });
    expect(validateSettingsRouteSearch({ section: "expert-connections" })).toMatchObject({
      section: "mcp",
      tab: "tools",
    });
  });

  it("does not turn unrelated native settings into Workbench pages", () => {
    expect(workbenchSettingsPageForSection("general")).toBeUndefined();
    expect(workbenchSettingsPageForSection("unknown-plugin-page")).toBeUndefined();
  });
});
