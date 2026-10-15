import { describe, expect, it } from "vitest";

import {
  canonicalizeSettingsMcpSearch,
  resolveSettingsHostRoute,
  settingsSearchForExpertFromMcp,
  settingsSearchForMcpFromExpert,
  settingsSearchForMcpTab,
} from "./settings";

describe("settings host route adaptation", () => {
  it("resolves old MCP section aliases while retaining the raw alias and deep-link values", () => {
    const rawSearch = {
      section: "integrations",
      expertId: "planner",
      connectionId: "linear",
      returnExpertId: "planner",
      search: "authorization",
    };
    const route = resolveSettingsHostRoute(
      { ...rawSearch, section: "mcp", tab: "apps" },
      rawSearch,
    );

    expect(route).toMatchObject({
      activeSection: "mcp",
      pageId: "mcp-settings",
      mcpTab: "apps",
      originalSection: "integrations",
      shouldCanonicalizeMcpRoute: true,
      expertId: "planner",
      connectionId: "linear",
      returnExpertId: "planner",
      initialSearch: "authorization",
    });
    expect(
      canonicalizeSettingsMcpSearch({
        ...rawSearch,
        tab: "apps",
      }),
    ).toEqual({
      ...rawSearch,
      section: "mcp",
      tab: "apps",
    });
  });

  it("uses the legacy connections default and avoids rewriting a canonical route", () => {
    const route = resolveSettingsHostRoute(
      { section: "mcp", tab: "tools" },
      { section: "expert-connections" },
    );
    expect(route).toMatchObject({
      activeSection: "mcp",
      pageId: "mcp-settings",
      mcpTab: "tools",
      originalSection: "expert-connections",
      shouldCanonicalizeMcpRoute: true,
    });
    expect(
      resolveSettingsHostRoute({ section: "mcp", tab: "apps" }).shouldCanonicalizeMcpRoute,
    ).toBe(false);
  });

  it("keeps tab changes in the current history entry with all deep-link fields", () => {
    const current = {
      section: "mcp",
      tab: "tools",
      expertId: "planner",
      connectionId: "linear",
      returnExpertId: "planner",
      search: "remote tools",
    };
    expect(settingsSearchForMcpTab(current, "apps")).toEqual({
      ...current,
      section: "mcp",
      tab: "apps",
    });
  });

  it("preserves expert and connection targets in both directions", () => {
    expect(settingsSearchForMcpFromExpert({ expertId: "planner", connectionId: "linear" })).toEqual(
      {
        section: "mcp",
        tab: "tools",
        expertId: "planner",
        returnExpertId: "planner",
        connectionId: "linear",
      },
    );
    expect(settingsSearchForExpertFromMcp({ expertId: "planner", connectionId: "linear" })).toEqual(
      {
        section: "experts",
        expertId: "planner",
        connectionId: "linear",
      },
    );
  });

  it("keeps ordinary settings outside the Workbench page map", () => {
    expect(resolveSettingsHostRoute({ section: "general" })).toMatchObject({
      activeSection: "general",
      pageId: undefined,
      shouldCanonicalizeMcpRoute: false,
    });
  });
});
