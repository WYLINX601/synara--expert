import "../../index.css";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { describe, expect, it } from "vitest";
import { buildThemeCssVariables, DEFAULT_THEME_STATE, resolveThemePack } from "~/theme/theme.logic";
import { Menu, MenuItem, MenuPopupBase } from "../ui/menu";
import {
  COMPOSER_INPUT_SHELL_CLASS_NAME,
  COMPOSER_INPUT_SURFACE_CLASS_NAME,
} from "./composerPickerStyles";

const frames = async () => {
  await new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  );
};

// Canvas resolves modern color()/color-mix() serialization and exposes actual alpha.
function alpha(color: string) {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1;
  const context = canvas.getContext("2d")!;
  context.fillStyle = color;
  context.fillRect(0, 0, 1, 1);
  return context.getImageData(0, 0, 1, 1).data[3];
}

function Surfaces() {
  return (
    <>
      <div
        data-testid="busy-desktop"
        style={{
          position: "fixed",
          inset: 0,
          padding: 16,
          background:
            "repeating-linear-gradient(135deg, #f9d6d6 0px, #f9d6d6 32px, #c5e6f6 32px, #c5e6f6 64px)",
          color: "#132435",
          fontSize: 18,
          lineHeight: 1.9,
        }}
      >
        {Array.from({ length: 18 }, (_, index) => (
          <p key={index}>Underlying desktop text · notes, documents and messages · 0123456789</p>
        ))}
      </div>
      <div
        id="root"
        data-sidebar-layout="rail"
        data-zen-mode="true"
        style={{ position: "fixed", inset: 0 }}
      >
        <div className="chat-content-card" style={{ height: "100%" }}>
          <div
            data-zen-chat="true"
            style={{ height: "100%", display: "flex", flexDirection: "column", paddingInline: 24 }}
          >
            <div
              data-testid="chat-transcript-drawer"
              style={{ padding: 20, minHeight: 150, flex: "none" }}
            >
              <p>Readable conversation</p>
              <p>The desktop stays visible only outside this drawer.</p>
            </div>
            <div data-zen-details="true" style={{ padding: 12 }}>
              Choose the next action in this drawer.
            </div>
            <button
              data-testid="zen-status-strip"
              className="mx-auto mb-1 rounded-full px-3 py-1 text-ui-xs"
            >
              Reading files · Running
            </button>
            <div data-chat-composer-slot="">
              <div className={COMPOSER_INPUT_SHELL_CLASS_NAME}>
                <div
                  data-chat-composer-surface=""
                  className={COMPOSER_INPUT_SURFACE_CLASS_NAME}
                  style={{ padding: 20 }}
                >
                  Continue the conversation…
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
      <Menu open>
        <MenuPopupBase
          anchor={{ getBoundingClientRect: () => new DOMRect(500, 24, 0, 0) }}
          side="bottom"
          align="end"
        >
          <MenuItem>Readable model menu</MenuItem>
          <MenuItem>Keep existing permissions</MenuItem>
        </MenuPopupBase>
      </Menu>
    </>
  );
}

describe("Zen opaque painted surfaces", () => {
  it.each([
    ["light", "none"],
    ["dark", "none"],
    ["light", "sidebar"],
    ["dark", "sidebar"],
    ["light", "window"],
    ["dark", "window"],
  ] as const)(
    "keeps %s surfaces opaque with %s material and restores normal glass on exit",
    async (variant, scope) => {
      const root = document.documentElement;
      const attributes = Array.from(root.attributes, ({ name, value }) => [name, value] as const);
      const viewport = { width: window.innerWidth, height: window.innerHeight };
      await page.viewport(720, 560);
      const pack = resolveThemePack(DEFAULT_THEME_STATE, variant);
      const theme = buildThemeCssVariables(
        { ...pack, theme: { ...pack.theme, opaqueWindows: scope === "none" } },
        variant,
        {
          windowTranslucency: "native",
          // Low opacity exercises the installed failure instead of relying on a white page.
          translucency: { opacity: 10, blur: null, sidebarOnly: scope === "sidebar" },
        },
      );
      root.classList.toggle("dark", variant === "dark");
      root.dataset.windowTransparent = "true";
      root.dataset.windowMaterial = theme.material;
      root.dataset.windowTranslucency = theme.translucencyScope;
      root.dataset.zenSurface = "true";
      for (const [name, value] of Object.entries(theme.variables)) {
        if (value) root.style.setProperty(name, value);
        else root.style.removeProperty(name);
      }
      const screen = await render(<Surfaces />);
      try {
        await frames();
        await expect.element(page.getByText("Readable model menu")).toBeVisible();
        const composer = document.querySelector<HTMLElement>("[data-chat-composer-surface]")!;
        const menu = document.querySelector<HTMLElement>('[data-slot="menu-popup"]')!;
        for (const surface of [
          composer,
          menu,
          document.querySelector('[data-testid="chat-transcript-drawer"]')!,
          document.querySelector("[data-zen-details]")!,
          document.querySelector('[data-testid="zen-status-strip"]')!,
        ]) {
          expect(alpha(getComputedStyle(surface).backgroundColor)).toBe(255);
          expect(getComputedStyle(surface).backgroundImage).toBe("none");
        }
        for (const surface of [composer, menu]) {
          expect(alpha(getComputedStyle(surface, "::before").backgroundColor)).toBe(255);
          expect(getComputedStyle(surface, "::before").backdropFilter).toBe("none");
        }
        for (const surface of [
          root,
          document.body,
          document.querySelector("#root")!,
          document.querySelector("[data-zen-chat]")!,
        ])
          expect(alpha(getComputedStyle(surface).backgroundColor)).toBe(0);
        expect(
          getComputedStyle(document.querySelector(".chat-content-card")!, "::before").display,
        ).toBe("none");
        if (scope === "window")
          await page.screenshot({
            path: `../../../../../.github/pr-evidence/zen-mode/opaque-${variant}-busy.png`,
          });
        delete root.dataset.zenSurface;
        await frames();
        // Normal workspace material remains unchanged when Zen exits.
        expect(alpha(getComputedStyle(composer).backgroundColor)).toBeLessThan(255);
        expect(getComputedStyle(composer).backgroundColor).not.toBe(
          getComputedStyle(document.querySelector("[data-zen-details]")!).backgroundColor,
        );
      } finally {
        await screen.unmount();
        for (const attribute of Array.from(root.attributes)) root.removeAttribute(attribute.name);
        for (const [name, value] of attributes) root.setAttribute(name, value);
        await page.viewport(viewport.width, viewport.height);
        await frames();
      }
    },
  );
});
