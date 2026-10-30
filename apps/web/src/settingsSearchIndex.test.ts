import { describe, expect, it } from "vitest";

import { SETTINGS_SEARCH_ENTRIES, rankSettingsSearchEntries } from "./settingsSearchIndex";
import { WORKBENCH_MODULES } from "./workbench/registry";

describe("Workbench settings search metadata", () => {
  it("derives one panel-level search entry per registered Workbench page", () => {
    const pageEntries = WORKBENCH_MODULES.map((module) =>
      SETTINGS_SEARCH_ENTRIES.find((entry) => entry.id === `${module.id}:page`),
    );

    expect(pageEntries).toHaveLength(WORKBENCH_MODULES.length);
    for (const [index, module] of WORKBENCH_MODULES.entries()) {
      expect(pageEntries[index]).toMatchObject({
        id: `${module.id}:page`,
        section: module.id,
        title: module.settings.navigation.label,
        target: null,
        ...("route" in module.settings.search ? { route: module.settings.search.route } : {}),
      });
      expect(pageEntries[index]?.keywords).toContain(module.settings.search.keywords);
    }
  });

  it("keeps the MCP applications deep link beside its registry-owned search metadata", () => {
    const mcp = WORKBENCH_MODULES.find((module) => module.id === "mcp");
    const entry = SETTINGS_SEARCH_ENTRIES.find((candidate) => candidate.id === "mcp:apps");

    expect(mcp?.settings.search.entries?.[0]).toMatchObject({
      id: "mcp:apps",
      title: "External MCP integrations",
      target: null,
      query: { tab: "apps" },
    });
    expect(entry).toMatchObject({
      section: "mcp",
      title: "External MCP integrations",
      target: null,
      query: { tab: "apps" },
    });
    expect(rankSettingsSearchEntries("External MCP integrations", 12)).toContainEqual(entry);
  });

  it("keeps every settings search target identifier unique", () => {
    const ids = SETTINGS_SEARCH_ENTRIES.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
