// FILE: settings.ts
// Purpose: Adapt settings route search values and expert/MCP navigation to Workbench pages.
// Layer: Web Workbench host integration

import {
  mcpSettingsTabForRoute,
  normalizeSettingsSection,
  type McpSettingsTab,
  type SettingsSectionId,
} from "../../settingsNavigation";
import { workbenchSettingsPageForSection, type WorkbenchSettingsPageId } from "../registry";

type Search = Readonly<Record<string, unknown>>;

export interface SettingsHostRoute {
  readonly activeSection: SettingsSectionId;
  readonly pageId: WorkbenchSettingsPageId | undefined;
  readonly mcpTab: McpSettingsTab;
  /** The pre-normalized section, retained to distinguish old links from canonical routes. */
  readonly originalSection: unknown;
  readonly shouldCanonicalizeMcpRoute: boolean;
  readonly expertId?: string;
  readonly connectionId?: string;
  readonly initialSearch?: string;
  readonly returnExpertId?: string;
}

function isMcpSection(section: unknown): boolean {
  return section === "mcp" || section === "expert-connections";
}

function searchString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** Resolve normalized settings selection while retaining the raw alias used by the URL. */
export function resolveSettingsHostRoute(routeSearch: Search, rawSearch: Search = routeSearch) {
  const activeSection = normalizeSettingsSection(routeSearch.section);
  const mcpTab = mcpSettingsTabForRoute(rawSearch.section, rawSearch.tab);
  const originalSection = rawSearch.section;
  const shouldCanonicalizeMcpRoute =
    isMcpSection(originalSection) && !(originalSection === "mcp" && rawSearch.tab === mcpTab);

  const expertId = searchString(routeSearch.expertId);
  const connectionId = searchString(routeSearch.connectionId);
  const initialSearch = searchString(routeSearch.search);
  const returnExpertId = searchString(routeSearch.returnExpertId);

  return {
    activeSection,
    pageId: workbenchSettingsPageForSection(activeSection),
    mcpTab,
    originalSection,
    shouldCanonicalizeMcpRoute,
    ...(expertId === undefined ? {} : { expertId }),
    ...(connectionId === undefined ? {} : { connectionId }),
    ...(initialSearch === undefined ? {} : { initialSearch }),
    ...(returnExpertId === undefined ? {} : { returnExpertId }),
  } satisfies SettingsHostRoute;
}

/** Normalize legacy MCP section names without discarding deep-link identifiers or other search. */
export function canonicalizeSettingsMcpSearch(search: Search): Record<string, unknown> {
  if (!isMcpSection(search.section)) return { ...search };
  return {
    ...search,
    section: "mcp",
    tab: mcpSettingsTabForRoute(search.section, search.tab),
  };
}

/** Keep route state in sync with the MCP tab while preserving the current deep link. */
export function settingsSearchForMcpTab(search: Search, tab: McpSettingsTab) {
  return { ...search, section: "mcp", tab };
}

/** Move from an expert editor to the matching MCP authorization/connection view. */
export function settingsSearchForMcpFromExpert(input: {
  readonly expertId: string;
  readonly connectionId?: string;
}) {
  return {
    section: "mcp",
    tab: "tools" as const,
    expertId: input.expertId,
    returnExpertId: input.expertId,
    ...(input.connectionId ? { connectionId: input.connectionId } : {}),
  };
}

/** Return from MCP management to the requested expert while retaining its connection target. */
export function settingsSearchForExpertFromMcp(target: {
  readonly expertId: string;
  readonly connectionId?: string;
}) {
  return {
    section: "experts" as const,
    expertId: target.expertId,
    ...(target.connectionId ? { connectionId: target.connectionId } : {}),
  };
}
