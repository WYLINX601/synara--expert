import { createFileRoute, lazyRouteComponent } from "@tanstack/react-router";
import type { ExpertEditorTab } from "~/components/settings/ExpertEditor";

export const Route = createFileRoute("/_chat/experts")({
  validateSearch: (
    search: Record<string, unknown>,
  ): {
    tab: ExpertEditorTab;
    kind?: "teams" | "skills";
    connectionId?: string;
    projectId?: string;
    search?: string;
    target?: string;
    sourceThreadId?: string;
  } => ({
    ...(search.kind === "teams" || search.kind === "skills" ? { kind: search.kind } : {}),
    tab:
      search.tab === "settings" || search.tab === "history" || search.tab === "evolution"
        ? search.tab
        : "capabilities",
    ...(typeof search.connectionId === "string" ? { connectionId: search.connectionId } : {}),
    ...(typeof search.search === "string" ? { search: search.search } : {}),
    ...(typeof search.sourceThreadId === "string" ? { sourceThreadId: search.sourceThreadId } : {}),
    ...(typeof search.target === "string" ? { target: search.target } : {}),
    ...(typeof search.projectId === "string" ? { projectId: search.projectId } : {}),
  }),
  component: lazyRouteComponent(() => import("~/workbench/ExpertCenterPage")),
});
