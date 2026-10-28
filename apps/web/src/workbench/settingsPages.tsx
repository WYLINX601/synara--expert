// FILE: settingsPages.tsx
// Purpose: Lazily connect registered Workbench settings pages to their feature components.
// Layer: Web Workbench host integration

import { Component, lazy, Suspense, useMemo, useState } from "react";
import type { ComponentProps, ComponentType, ReactNode } from "react";

import { Button } from "../components/ui/button";
import { SettingsEmptyState } from "../components/settings/SettingsPanelPrimitives";
import type { ExpertTeamsSettingsPanel } from "../components/settings/ExpertTeamsSettingsPanel";
import type { GlobalMcpSettingsPanel } from "../components/settings/GlobalMcpSettingsPanel";
import { WORKBENCH_MODULES, type WorkbenchSettingsPageId } from "./registry";

type ExpertsSettingsPageProps = Omit<ComponentProps<typeof ExpertTeamsSettingsPanel>, "active">;
type McpSettingsPageProps = ComponentProps<typeof GlobalMcpSettingsPanel>;

type SettingsPagePropsById = {
  "experts-settings": ExpertsSettingsPageProps;
  "mcp-settings": McpSettingsPageProps;
};

type SettingsPageLoader<Props> = () => Promise<{ default: ComponentType<Props> }>;

const WORKBENCH_SETTINGS_PAGE_LOADERS = {
  "experts-settings": async () => {
    const module = await import("../components/settings/ExpertTeamsSettingsPanel");
    return { default: module.ExpertTeamsSettingsPanel };
  },
  "mcp-settings": async () => {
    const module = await import("../components/settings/GlobalMcpSettingsPanel");
    return { default: module.GlobalMcpSettingsPanel };
  },
} satisfies {
  [PageId in WorkbenchSettingsPageId]: SettingsPageLoader<SettingsPagePropsById[PageId]>;
};

type WorkbenchSettingsPageBase = {
  readonly onReturnToSettings: () => void;
};

export type WorkbenchSettingsPageProps =
  | (WorkbenchSettingsPageBase & {
      readonly pageId: "experts-settings";
      readonly onOpenExperts: () => void;
    } & ExpertsSettingsPageProps)
  | (WorkbenchSettingsPageBase & {
      readonly pageId: "mcp-settings";
    } & McpSettingsPageProps);

class SettingsPageErrorBoundary extends Component<
  { readonly children: ReactNode; readonly fallback: ReactNode },
  { readonly hasError: boolean }
> {
  override state = { hasError: false };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  override render() {
    return this.state.hasError ? this.props.fallback : this.props.children;
  }
}

function settingsPageLabel(pageId: WorkbenchSettingsPageId): string {
  return (
    WORKBENCH_MODULES.find((module) => module.settings.pageId === pageId)?.settings.navigation
      .label ?? "Settings"
  );
}

export function WorkbenchSettingsPage(props: WorkbenchSettingsPageProps) {
  const [retryKey, setRetryKey] = useState(0);
  // Keep lazy identities above the Suspense boundary: initial suspension can
  // discard memo caches in the suspending subtree and restart its imports.
  const { ExpertsPage, McpPage } = useMemo(
    () => ({
      ExpertsPage: lazy(WORKBENCH_SETTINGS_PAGE_LOADERS["experts-settings"]),
      McpPage: lazy(WORKBENCH_SETTINGS_PAGE_LOADERS["mcp-settings"]),
    }),
    [retryKey],
  );
  const label = settingsPageLabel(props.pageId);
  const retry = () => setRetryKey((current) => current + 1);
  const fallback = (
    <SettingsEmptyState layout="status" tone="destructive">
      <div className="flex flex-col items-center gap-3">
        <p role="alert">Could not load {label} settings.</p>
        <div className="flex flex-wrap justify-center gap-2">
          <Button size="sm" variant="outline" onClick={props.onReturnToSettings}>
            Back to settings
          </Button>
          <Button size="sm" onClick={retry}>
            Retry
          </Button>
        </div>
      </div>
    </SettingsEmptyState>
  );
  const page =
    props.pageId === "experts-settings" ? (
      <ExpertsPage onOpenExperts={props.onOpenExperts} />
    ) : (
      <McpPage
        {...(props.initialTab === undefined ? {} : { initialTab: props.initialTab })}
        {...(props.initialConnectionId === undefined
          ? {}
          : { initialConnectionId: props.initialConnectionId })}
        {...(props.initialExpertId === undefined ? {} : { initialExpertId: props.initialExpertId })}
        {...(props.initialSearch === undefined ? {} : { initialSearch: props.initialSearch })}
        {...(props.returnExpertId === undefined ? {} : { returnExpertId: props.returnExpertId })}
        {...(props.onTabChange === undefined ? {} : { onTabChange: props.onTabChange })}
        {...(props.onReturnToExpert === undefined
          ? {}
          : { onReturnToExpert: props.onReturnToExpert })}
      />
    );

  // The boundary remount key changes only with the selected page or an explicit retry.
  // Route query updates such as expertId, connectionId, or tab changes keep page-owned drafts alive.
  return (
    <SettingsPageErrorBoundary key={`${props.pageId}:${retryKey}`} fallback={fallback}>
      <Suspense
        fallback={
          <SettingsEmptyState layout="status">
            <span role="status" aria-live="polite">
              Loading {label} settings…
            </span>
          </SettingsEmptyState>
        }
      >
        {page}
      </Suspense>
    </SettingsPageErrorBoundary>
  );
}
