import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
  useRouterState,
} from "@tanstack/react-router";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

const harness = vi.hoisted(() => ({
  expertsMounts: 0,
  mcpMounts: 0,
  failNextExpertRender: false,
}));

vi.mock("./ExpertTeamsSettingsPanel", async () => {
  const React = await import("react");
  return {
    ExpertTeamsSettingsPanel: (props: { onOpenExperts: () => void }) => {
      const [instance] = React.useState(() => ++harness.expertsMounts);
      if (harness.failNextExpertRender) {
        throw new Error("Test page render failure");
      }
      return (
        <div>
          <p data-testid="experts-page">Expert teams instance {instance}</p>
          <button type="button" onClick={props.onOpenExperts}>
            Open Experts
          </button>
        </div>
      );
    },
  };
});

vi.mock("./GlobalMcpSettingsPanel", async () => {
  const React = await import("react");
  return {
    GlobalMcpSettingsPanel: (props: {
      initialTab?: "tools" | "apps";
      initialExpertId?: string;
      initialConnectionId?: string;
      onTabChange?: (tab: "tools" | "apps") => void;
      onReturnToExpert?: (target: { expertId: string; connectionId?: string }) => void;
    }) => {
      const [instance] = React.useState(() => ++harness.mcpMounts);
      return (
        <div>
          <p data-testid="mcp-page">
            MCP {props.initialTab ?? "tools"} {props.initialExpertId ?? "none"}{" "}
            {props.initialConnectionId ?? "none"} instance {instance}
          </p>
          <button type="button" onClick={() => props.onTabChange?.("apps")}>
            Switch to apps
          </button>
          <button
            type="button"
            onClick={() =>
              props.onReturnToExpert?.({
                expertId: props.initialExpertId ?? "planner",
                ...(props.initialConnectionId ? { connectionId: props.initialConnectionId } : {}),
              })
            }
          >
            Return to expert
          </button>
        </div>
      );
    },
  };
});

import { validateSettingsRouteSearch } from "../../settingsNavigation";
import {
  expertCenterRouteTarget,
  resolveSettingsHostRoute,
  settingsSearchForMcpTab,
} from "../../workbench/host/settings";
import { WorkbenchSettingsPage } from "../../workbench/settingsPages";

let cleanup: (() => Promise<void>) | null = null;

async function mountSettings(initialEntry: string) {
  let router: ReturnType<typeof createRouter>;
  const root = createRootRoute({ component: () => <Outlet /> });
  const settings = createRoute({
    getParentRoute: () => root,
    path: "/settings",
    validateSearch: validateSettingsRouteSearch,
    component: () => {
      const routeSearch = settings.useSearch() as Record<string, unknown>;
      const rawSearch = useRouterState({
        select: (state) => state.location.search as Record<string, unknown>,
      });
      const resolved = resolveSettingsHostRoute(routeSearch, rawSearch);
      return (
        <div>
          <p data-testid="route-state">
            {resolved.activeSection} {resolved.mcpTab} {String(resolved.originalSection)}
          </p>
          <output data-testid="route-search">{JSON.stringify(rawSearch)}</output>
          {resolved.pageId === "experts-settings" ? (
            <WorkbenchSettingsPage
              pageId="experts-settings"
              onReturnToSettings={() =>
                void router.navigate({
                  to: "/settings",
                  search: { section: "general" } as never,
                })
              }
              onOpenExperts={() => void router.navigate({ to: "/experts" } as never)}
            />
          ) : resolved.pageId === "mcp-settings" ? (
            <WorkbenchSettingsPage
              pageId="mcp-settings"
              onReturnToSettings={() =>
                void router.navigate({
                  to: "/settings",
                  search: { section: "general" } as never,
                })
              }
              initialTab={resolved.mcpTab}
              {...(resolved.expertId === undefined ? {} : { initialExpertId: resolved.expertId })}
              {...(resolved.connectionId === undefined
                ? {}
                : { initialConnectionId: resolved.connectionId })}
              onTabChange={(tab) =>
                void router.navigate({
                  to: "/settings",
                  replace: true,
                  search: (previous) => settingsSearchForMcpTab(previous, tab),
                })
              }
              onReturnToExpert={(target) =>
                void router.navigate({
                  ...expertCenterRouteTarget({ ...target, search: rawSearch }),
                } as never)
              }
            />
          ) : null}
        </div>
      );
    },
  });
  const experts = createRoute({
    getParentRoute: () => root,
    path: "/experts/$expertId",
    component: () => {
      const location = useRouterState({
        select: (state) => ({ pathname: state.location.pathname, search: state.location.search }),
      });
      const expertId = location.pathname.split("/").at(-1);
      return (
        <p data-testid="expert-center-route">
          {expertId} {String(location.search.tab ?? "")}{" "}
          {String(location.search.connectionId ?? "")} {String(location.search.search ?? "")}
        </p>
      );
    },
  });
  router = createRouter({
    routeTree: root.addChildren([settings, experts]),
    history: createMemoryHistory({ initialEntries: [initialEntry] }),
  });
  const view = await render(<RouterProvider router={router} />);
  cleanup = async () => view.unmount();
  return router;
}

beforeEach(() => {
  harness.expertsMounts = 0;
  harness.mcpMounts = 0;
  harness.failNextExpertRender = false;
});

afterEach(async () => {
  await cleanup?.();
  cleanup = null;
});

describe("Workbench settings page host", () => {
  it("finishes first lazy loading under a normal concurrent root", async () => {
    // The application mounts without render()'s act flush. Keep this path to
    // catch suspended lazy wrappers that continually restart before mounting.
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    try {
      root.render(
        <WorkbenchSettingsPage
          pageId="experts-settings"
          onReturnToSettings={() => {}}
          onOpenExperts={() => {}}
        />,
      );
      await expect.element(page.getByTestId("experts-page")).toHaveTextContent("Expert teams");
      root.render(
        <WorkbenchSettingsPage
          pageId="mcp-settings"
          initialTab="apps"
          onReturnToSettings={() => {}}
        />,
      );
      await expect.element(page.getByTestId("mcp-page")).toHaveTextContent("MCP apps");
    } finally {
      root.unmount();
      container.remove();
    }
  });

  it("loads a page lazily and keeps MCP route props live without remounting on tab changes", async () => {
    const router = await mountSettings(
      "/settings?section=mcp&tab=tools&expertId=planner&returnExpertId=planner&connectionId=linear&search=Linear",
    );
    await expect
      .element(page.getByTestId("mcp-page"))
      .toHaveTextContent("MCP tools planner linear");

    expect(harness.mcpMounts).toBe(1);
    await page.getByRole("button", { name: "Switch to apps" }).click();
    await expect.element(page.getByTestId("mcp-page")).toHaveTextContent("MCP apps planner linear");
    expect(harness.mcpMounts).toBe(1);

    await page.getByRole("button", { name: "Return to expert" }).click();
    await expect
      .element(page.getByTestId("expert-center-route"))
      .toHaveTextContent("planner capabilities linear Linear");

    router.history.back();
    await expect.element(page.getByTestId("mcp-page")).toHaveTextContent("MCP apps planner linear");
    router.history.forward();
    await expect
      .element(page.getByTestId("expert-center-route"))
      .toHaveTextContent("planner capabilities linear Linear");
  });

  it("shows retry and return actions when a Workbench page render fails", async () => {
    harness.failNextExpertRender = true;
    const returned = vi.fn();
    const view = await render(
      <WorkbenchSettingsPage
        pageId="experts-settings"
        onReturnToSettings={returned}
        onOpenExperts={() => {}}
      />,
    );

    await expect
      .element(page.getByRole("alert"))
      .toHaveTextContent("Could not load Experts settings.");
    harness.failNextExpertRender = false;
    await page.getByRole("button", { name: "Retry" }).click();
    await expect.element(page.getByTestId("experts-page")).toHaveTextContent("Expert teams");
    await view.unmount();

    harness.failNextExpertRender = true;
    const secondView = await render(
      <WorkbenchSettingsPage
        pageId="experts-settings"
        onReturnToSettings={returned}
        onOpenExperts={() => {}}
      />,
    );
    await expect
      .element(page.getByRole("alert"))
      .toHaveTextContent("Could not load Experts settings.");
    await page.getByRole("button", { name: "Back to settings" }).click();
    expect(returned).toHaveBeenCalledOnce();
    await secondView.unmount();
  });
});
