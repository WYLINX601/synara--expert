import { describe, expect, it } from "vitest";

import {
  canonicalizeSettingsMcpSearch,
  expertCenterRouteTarget,
  resolveSettingsHostRoute,
  settingsSearchForExpertFromMcp,
  settingsSearchForMcpFromExpert,
  settingsSearchForMcpTab,
} from "./settings";

describe("settings host route adaptation", () => {
  it("keeps native integrations separate from the Linx MCP route", () => {
    const rawSearch = {
      section: "integrations",
      expertId: "planner",
      connectionId: "linear",
      returnExpertId: "planner",
      search: "authorization",
    };
    const route = resolveSettingsHostRoute(rawSearch);

    expect(route).toMatchObject({
      activeSection: "integrations",
      pageId: undefined,
      mcpTab: "tools",
      originalSection: "integrations",
      shouldCanonicalizeMcpRoute: false,
      shouldRedirectExpertToCenter: false,
      expertId: "planner",
      connectionId: "linear",
      returnExpertId: "planner",
      initialSearch: "authorization",
    });
    expect(canonicalizeSettingsMcpSearch(rawSearch)).toEqual(rawSearch);
  });

  it("canonicalizes only Linx MCP and its legacy expert-connections alias", () => {
    const alias = resolveSettingsHostRoute(
      { section: "mcp", tab: "tools" },
      { section: "expert-connections" },
    );
    expect(alias).toMatchObject({
      activeSection: "mcp",
      pageId: "mcp-settings",
      mcpTab: "tools",
      originalSection: "expert-connections",
      shouldCanonicalizeMcpRoute: true,
      shouldRedirectExpertToCenter: false,
    });
    expect(
      canonicalizeSettingsMcpSearch({ section: "expert-connections", expertId: "planner" }),
    ).toEqual({
      section: "mcp",
      expertId: "planner",
      tab: "tools",
    });
    expect(
      resolveSettingsHostRoute({ section: "mcp", tab: "apps" }).shouldCanonicalizeMcpRoute,
    ).toBe(false);
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
      shouldRedirectExpertToCenter: false,
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

  it("preserves MCP entry targets and returns to the Expert center with its connection target", () => {
    expect(
      settingsSearchForMcpFromExpert({
        expertId: "planner",
        connectionId: "linear",
        projectId: "project-1",
        sourceThreadId: "thread-1",
        search: "Linear",
        target: "mcp-apps",
      }),
    ).toEqual({
      section: "mcp",
      tab: "tools",
      expertId: "planner",
      returnExpertId: "planner",
      connectionId: "linear",
      projectId: "project-1",
      sourceThreadId: "thread-1",
      search: "Linear",
      target: "mcp-apps",
    });
    expect(
      settingsSearchForExpertFromMcp(
        { expertId: "planner", connectionId: "linear" },
        {
          section: "mcp",
          tab: "apps",
          expertId: "planner",
          returnExpertId: "planner",
          search: "Linear",
          target: "mcp-apps",
          projectId: "project-1",
          sourceThreadId: "thread-1",
          unrelated: "drop",
        },
      ),
    ).toEqual({
      tab: "capabilities",
      search: "Linear",
      target: "mcp-apps",
      projectId: "project-1",
      sourceThreadId: "thread-1",
      connectionId: "linear",
    });
    expect(
      expertCenterRouteTarget({
        expertId: "planner",
        connectionId: "linear",
        search: {
          section: "mcp",
          tab: "apps",
          search: "Linear",
          target: "mcp-apps",
          projectId: "project-1",
          sourceThreadId: "thread-1",
        },
      }),
    ).toEqual({
      to: "/experts/$expertId",
      params: { expertId: "planner" },
      search: {
        search: "Linear",
        target: "mcp-apps",
        tab: "capabilities",
        connectionId: "linear",
        projectId: "project-1",
        sourceThreadId: "thread-1",
      },
    });
  });

  it("redirects only old personal Expert settings deep links to the Expert center", () => {
    expect(
      resolveSettingsHostRoute({
        section: "experts",
        expertId: "planner",
        connectionId: "linear",
      }),
    ).toMatchObject({
      activeSection: "experts",
      pageId: "experts-settings",
      shouldRedirectExpertToCenter: true,
    });
    expect(resolveSettingsHostRoute({ section: "experts" }).shouldRedirectExpertToCenter).toBe(
      false,
    );
    expect(
      resolveSettingsHostRoute({ section: "expert-connections", expertId: "planner" })
        .shouldRedirectExpertToCenter,
    ).toBe(false);
  });

  it("keeps ordinary settings outside the Workbench page map", () => {
    expect(resolveSettingsHostRoute({ section: "general" })).toMatchObject({
      activeSection: "general",
      pageId: undefined,
      shouldCanonicalizeMcpRoute: false,
      shouldRedirectExpertToCenter: false,
    });
  });
});
