import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import {
  createRootRoute,
  createRoute,
  createRouter,
  createMemoryHistory,
  RouterProvider,
  Outlet,
} from "@tanstack/react-router";
import { TooltipProvider } from "synara-ui/components/ui/tooltip";
import { installNetworkBoundary } from "./networkBoundary";
import { installStorageBoundary } from "./storageBoundary";
import "@fontsource-variable/jetbrains-mono";
import "./synara.generated.css";
import "./prototype.css";

installNetworkBoundary();
installStorageBoundary();
const { App } = await import("./App");
const { ComponentReference } = await import("./ComponentReference");
const rootRoute = createRootRoute({
  component: () => (
    <TooltipProvider delay={250}>
      <Outlet />
    </TooltipProvider>
  ),
});
const route = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: new URLSearchParams(window.location.search).has("ui-reference")
    ? ComponentReference
    : App,
});
const router = createRouter({
  routeTree: rootRoute.addChildren([route]),
  history: createMemoryHistory({ initialEntries: ["/"] }),
});
const root = document.getElementById("root");
if (!root) throw new Error("Prototype root missing");
createRoot(root).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
