// FILE: useExpertDraftGuard.browser.tsx
// Purpose: Regress async discard confirmation before a guarded route can leave.
// Layer: Browser UI test

import "../../index.css";

import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { page } from "vitest/browser";
import { afterEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { useExpertDraftGuard, type UseExpertDraftGuardOptions } from "./useExpertDraftGuard";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((complete, fail) => {
    resolve = complete;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function GuardLayout({
  onDiscard,
  shouldGuardNavigation,
}: {
  onDiscard: UseExpertDraftGuardOptions["onDiscard"];
  shouldGuardNavigation?: UseExpertDraftGuardOptions["shouldGuardNavigation"];
}) {
  const { dialog } = useExpertDraftGuard({
    isDirty: true,
    onSave: async () => true,
    onDiscard,
    ...(shouldGuardNavigation ? { shouldGuardNavigation } : {}),
  });
  return (
    <>
      {dialog}
      <Outlet />
    </>
  );
}

async function mount(
  onDiscard: UseExpertDraftGuardOptions["onDiscard"],
  shouldGuardNavigation?: UseExpertDraftGuardOptions["shouldGuardNavigation"],
) {
  const root = createRootRoute({
    component: () => (
      <GuardLayout
        onDiscard={onDiscard}
        {...(shouldGuardNavigation ? { shouldGuardNavigation } : {})}
      />
    ),
  });
  const edit = createRoute({
    getParentRoute: () => root,
    path: "/edit",
    component: () => {
      return (
        <button onClick={() => void router.navigate({ to: "/settings" })}>Attempt leave</button>
      );
    },
  });
  const next = createRoute({
    getParentRoute: () => root,
    path: "/settings",
    component: () => <p>Next page content</p>,
  });
  const router = createRouter({
    routeTree: root.addChildren([edit, next]),
    history: createMemoryHistory({ initialEntries: ["/edit"] }),
  });
  const view = await render(<RouterProvider router={router} />);

  return {
    router,
    close: async () => {
      await view.unmount();
    },
  };
}

afterEach(() => {
  document.body.innerHTML = "";
});

it("keeps navigation pending and disables repeated discard while async discard is unresolved", async () => {
  const pending = deferred<boolean | void>();
  const onDiscard = vi.fn(() => pending.promise);
  const mounted = await mount(onDiscard);

  await page.getByRole("button", { name: "Attempt leave" }).click();
  await page.getByRole("button", { name: "放弃更改" }).click();

  const discardButton = page.getByRole("button", { name: "放弃更改" });
  await expect.element(discardButton).toBeDisabled();
  expect(onDiscard).toHaveBeenCalledTimes(1);
  expect(mounted.router.state.location.pathname).toBe("/edit");

  pending.resolve(true);
  await expect.poll(() => mounted.router.state.location.pathname).toBe("/settings");
  await mounted.close();
});

it("allows navigation when async discard resolves true", async () => {
  const pending = deferred<boolean | void>();
  const mounted = await mount(() => pending.promise);

  await page.getByRole("button", { name: "Attempt leave" }).click();
  await page.getByRole("button", { name: "放弃更改" }).click();
  pending.resolve(true);

  await expect.poll(() => mounted.router.state.location.pathname).toBe("/settings");
  await mounted.close();
});

it("allows navigation when async discard resolves void", async () => {
  const pending = deferred<void>();
  const mounted = await mount(() => pending.promise);

  await page.getByRole("button", { name: "Attempt leave" }).click();
  await page.getByRole("button", { name: "放弃更改" }).click();
  pending.resolve(undefined);

  await expect.poll(() => mounted.router.state.location.pathname).toBe("/settings");
  await mounted.close();
});

it("skips the dirty guard for route changes accepted by an optional scope predicate", async () => {
  const shouldGuardNavigation = vi.fn(() => false);
  const mounted = await mount(() => undefined, shouldGuardNavigation);

  await page.getByRole("button", { name: "Attempt leave" }).click();

  await expect.poll(() => mounted.router.state.location.pathname).toBe("/settings");
  expect(shouldGuardNavigation).toHaveBeenCalledWith({
    currentPathname: "/edit",
    nextPathname: "/settings",
    currentSearch: {},
    nextSearch: {},
  });
  expect(document.body.textContent).not.toContain("未保存的更改");
  await mounted.close();
});

it("keeps navigation blocked when async discard resolves false", async () => {
  const pending = deferred<boolean | void>();
  const mounted = await mount(() => pending.promise);

  await page.getByRole("button", { name: "Attempt leave" }).click();
  await page.getByRole("button", { name: "放弃更改" }).click();
  pending.resolve(false);

  await expect.element(page.getByRole("alert")).toBeVisible();
  expect(mounted.router.state.location.pathname).toBe("/edit");
  await page.getByRole("button", { name: "取消" }).click();
  await mounted.close();
});

it("keeps navigation blocked when async discard rejects", async () => {
  const pending = deferred<boolean | void>();
  const mounted = await mount(() => pending.promise);

  await page.getByRole("button", { name: "Attempt leave" }).click();
  await page.getByRole("button", { name: "放弃更改" }).click();
  pending.reject(new Error("Discard was not confirmed"));

  await expect.element(page.getByRole("alert")).toBeVisible();
  expect(mounted.router.state.location.pathname).toBe("/edit");
  await page.getByRole("button", { name: "取消" }).click();
  await mounted.close();
});

it("keeps synchronous void discard callers compatible", async () => {
  const onDiscard = vi.fn(() => undefined);
  const mounted = await mount(onDiscard);

  await page.getByRole("button", { name: "Attempt leave" }).click();
  await page.getByRole("button", { name: "放弃更改" }).click();

  await expect.poll(() => mounted.router.state.location.pathname).toBe("/settings");
  expect(onDiscard).toHaveBeenCalledTimes(1);
  await mounted.close();
});
