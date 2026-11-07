import "../../index.css";
import { ThreadFindBar } from "./ThreadFindBar";
import { CommandDialog, CommandDialogPopup } from "../ui/command";
import { page } from "vitest/browser";
import { Menu, MenuItem, MenuPopupBase, MenuSub, MenuSubPopup, MenuSubTrigger } from "../ui/menu";
import type { DesktopBridge } from "@synara/contracts";
import { createPortal } from "react-dom";
import { render } from "vitest-browser-react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { notifyNativeSurfaceOcclusionChange } from "~/lib/nativeSurfaceOcclusion";
import { useZenPointerPassthrough } from "./useZenPointerPassthrough";

function Harness({ active = true, popup = false }: { active?: boolean; popup?: boolean }) {
  useZenPointerPassthrough(active);
  return (
    <>
      <form style={{ position: "fixed", left: 10, top: 100, width: 300, height: 100 }}>
        <div
          data-zen-hit-surface=""
          style={{
            position: "absolute",
            left: 40,
            top: 20,
            width: 200,
            height: 40,
            background: "white",
          }}
        >
          Composer
        </div>
      </form>
      {popup
        ? createPortal(
            <div data-slot="dialog-viewport" style={{ position: "fixed", inset: 0 }}>
              <div
                data-slot="dialog-popup"
                style={{
                  position: "absolute",
                  top: 10,
                  left: 100,
                  width: 200,
                  height: 60,
                  background: "white",
                }}
              >
                Dialog
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}

const previousBridge = window.desktopBridge;
afterEach(() => {
  delete document.documentElement.dataset.zenSurface;
  if (previousBridge) window.desktopBridge = previousBridge;
  else delete window.desktopBridge;
});
const move = (x: number, y: number) =>
  window.dispatchEvent(new MouseEvent("mousemove", { clientX: x, clientY: y }));

function installBridge() {
  const setPointerPassthrough = vi.fn(async (_ignore: boolean) => {});
  window.desktopBridge = {
    ...previousBridge,
    zenMode: { setPointerPassthrough },
  } as unknown as DesktopBridge;
  return setPointerPassthrough;
}

describe("Zen native pointer hit regions", () => {
  it("resets stale expanded coordinates on native height shrink until a fresh pointer move", async () => {
    const previousViewport = { width: window.innerWidth, height: window.innerHeight };
    await page.viewport(720, 560);
    const set = installBridge();
    const screen = await render(
      <>
        <Harness />
        <div
          data-zen-hit-surface=""
          style={{ position: "fixed", left: 50, bottom: 20, width: 200, height: 40 }}
        >
          Bottom composer
        </div>
      </>,
    );
    try {
      move(100, 520);
      await vi.waitFor(() => expect(set).toHaveBeenLastCalledWith(false));
      await page.viewport(720, 96);
      notifyNativeSurfaceOcclusionChange();
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
      expect(set).toHaveBeenLastCalledWith(false);
      // New native client coordinates recover normal hit testing after resizing.
      move(100, 60);
      await vi.waitFor(() => expect(set).toHaveBeenLastCalledWith(false));
      move(2, 2);
      await vi.waitFor(() => expect(set).toHaveBeenLastCalledWith(true));
      window.dispatchEvent(new Event("resize"));
      await vi.waitFor(() => expect(set).toHaveBeenLastCalledWith(false));
      notifyNativeSurfaceOcclusionChange();
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
      expect(set).toHaveBeenLastCalledWith(false);
      move(2, 2);
      await vi.waitFor(() => expect(set).toHaveBeenLastCalledWith(true));
    } finally {
      await screen.unmount();
      await page.viewport(previousViewport.width, previousViewport.height);
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
    }
  });

  it("passes blank form padding and portal viewports through, but keeps actual surfaces interactive", async () => {
    const set = installBridge();
    const screen = await render(<Harness />);
    move(20, 110);
    await vi.waitFor(() => expect(set).toHaveBeenLastCalledWith(true));
    move(100, 140);
    await vi.waitFor(() => expect(set).toHaveBeenLastCalledWith(false));
    await screen.rerender(<Harness popup />);
    move(20, 20);
    await vi.waitFor(() => expect(set).toHaveBeenLastCalledWith(true));
    move(150, 30);
    await vi.waitFor(() => expect(set).toHaveBeenLastCalledWith(false));
    await screen.rerender(<Harness />);
    notifyNativeSurfaceOcclusionChange();
    await vi.waitFor(() => expect(set).toHaveBeenLastCalledWith(true));
    await screen.rerender(<Harness active={false} />);
    await vi.waitFor(() => expect(set).toHaveBeenLastCalledWith(false));
  });

  it("keeps a real portaled submenu interactive while its parent stays open", async () => {
    const set = installBridge();
    const screen = await render(
      <>
        <Harness />
        <Menu open keepOpenOnSubmenuInteraction>
          <MenuPopupBase
            anchor={{ getBoundingClientRect: () => new DOMRect(24, 24, 0, 0) }}
            side="bottom"
          >
            <MenuSub keepOpenOnFocusOut>
              <MenuSubTrigger>Targets</MenuSubTrigger>
              <MenuSubPopup>
                <MenuItem>Target project</MenuItem>
              </MenuSubPopup>
            </MenuSub>
          </MenuPopupBase>
        </Menu>
      </>,
    );
    await page.getByText("Targets", { exact: true }).hover();
    await expect.element(page.getByText("Target project", { exact: true })).toBeVisible();
    const popup = document.querySelector<HTMLElement>("[data-slot='menu-sub-content']")!;
    expect(popup.closest("[data-slot='menu-popup']")).toBeNull();
    await page.getByText("Target project", { exact: true }).hover();
    await vi.waitFor(() => expect(set).toHaveBeenLastCalledWith(false));
    const box = popup.getBoundingClientRect();
    move(box.left + 10, box.top + 10);
    await vi.waitFor(() => expect(set).toHaveBeenLastCalledWith(false));
    await screen.unmount();
  });

  it("keeps the real command palette backdrop transparent and its popup interactive", async () => {
    const set = installBridge();
    document.documentElement.dataset.zenSurface = "true";
    const screen = await render(
      <>
        <Harness />
        <CommandDialog open>
          <CommandDialogPopup aria-label="Commands">
            <button type="button">Command action</button>
          </CommandDialogPopup>
        </CommandDialog>
      </>,
    );
    await expect.element(page.getByRole("button", { name: "Command action" })).toBeVisible();
    const backdrop = document.querySelector('[data-slot="command-dialog-backdrop"]')!;
    expect(getComputedStyle(backdrop).backgroundColor).toBe("rgba(0, 0, 0, 0)");
    move(2, 2);
    await vi.waitFor(() => expect(set).toHaveBeenLastCalledWith(true));
    await page.getByRole("button", { name: "Command action" }).hover();
    await vi.waitFor(() => expect(set).toHaveBeenLastCalledWith(false));
    await screen.unmount();
  });

  it("keeps the actual find card interactive without capturing its surrounding host", async () => {
    const set = installBridge();
    const close = vi.fn();
    const screen = await render(
      <>
        <Harness />
        <div style={{ position: "fixed", left: 30, top: 10, padding: 16 }}>
          <ThreadFindBar
            open
            focusNonce={1}
            timelineEntries={[]}
            onClose={close}
            onJump={() => {}}
            onHighlightChange={() => {}}
            onActiveMatchChange={() => {}}
          />
        </div>
      </>,
    );
    move(31, 11);
    await vi.waitFor(() => expect(set).toHaveBeenLastCalledWith(true));
    await page.getByRole("textbox", { name: "Find in thread" }).hover();
    await vi.waitFor(() => expect(set).toHaveBeenLastCalledWith(false));
    await page.getByRole("textbox", { name: "Find in thread" }).fill("draft");
    await page.getByRole("button", { name: "Close find (Esc)" }).click();
    expect(close).toHaveBeenCalledOnce();
    await screen.unmount();
  });

  it("fails interactive and retries on the next pointer move without a rejection loop", async () => {
    const set = installBridge();
    await render(<Harness />);
    await vi.waitFor(() => expect(set).toHaveBeenLastCalledWith(false));
    set.mockRejectedValueOnce(new Error("Native request failed"));
    move(20, 20);
    await vi.waitFor(() =>
      expect(set.mock.calls.map(([value]) => value)).toEqual([false, true, false]),
    );
    move(21, 20);
    await vi.waitFor(() => expect(set).toHaveBeenLastCalledWith(true));
  });
});
