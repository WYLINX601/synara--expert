import "../../index.css";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

import { ComposerCommandMenu } from "./ComposerCommandMenu";
import { ComposerColumnFrame } from "./ComposerColumnFrame";
import { ComposerStackedPanel } from "./ComposerStackedPanel";
import {
  COMPOSER_COMMAND_MENU_FLOATING_WRAPPER_CLASS_NAME,
  COMPOSER_INPUT_SURFACE_CLASS_NAME,
} from "./composerPickerStyles";

const root = document.documentElement;
let previousAttributes: Record<string, string | null>;
let appRoot: HTMLDivElement;

beforeEach(() => {
  previousAttributes = Object.fromEntries(
    [
      "class",
      "style",
      "data-window-transparent",
      "data-window-material",
      "data-window-translucency",
    ].map((name) => [name, root.getAttribute(name)]),
  );
  root.style.setProperty("--popover", "rgb(40, 50, 60)");
  root.style.setProperty("--app-glass-raised-surface", "rgb(40 50 60 / 0.4)");
  // The chat composer belongs to the app root; composers portaled beside it have
  // a separate glass material and cutout rule.
  appRoot = document.createElement("div");
  appRoot.id = "root";
  document.body.append(appRoot);
});

afterEach(() => {
  appRoot.remove();
  for (const [name, value] of Object.entries(previousAttributes)) {
    if (value === null) root.removeAttribute(name);
    else root.setAttribute(name, value);
  }
});

function ComposerFixture() {
  return (
    <div data-chat-composer-slot>
      <ComposerColumnFrame>
        <ComposerStackedPanel data-testid="stacked">Queued follow-up</ComposerStackedPanel>
        <div className={COMPOSER_INPUT_SURFACE_CLASS_NAME} data-testid="composer">
          Draft input
        </div>
      </ComposerColumnFrame>
    </div>
  );
}

function surface(name: "composer" | "stacked"): HTMLElement {
  const found = appRoot.querySelector<HTMLElement>(`[data-testid="${name}"]`);
  if (!found) throw new Error(`Missing composer surface: ${name}`);
  return found;
}

// Measure the fill independently of the browser's CSS color serialization.
function fillAlpha(element: HTMLElement): number {
  const context = document.createElement("canvas").getContext("2d");
  if (!context) throw new Error("Missing canvas context");
  context.fillStyle = getComputedStyle(element).backgroundColor;
  context.fillRect(0, 0, 1, 1);
  return context.getImageData(0, 0, 1, 1).data[3]! / 255;
}

function sidebarGlass() {
  root.dataset.windowTransparent = "true";
  root.dataset.windowMaterial = "translucent";
  root.dataset.windowTranslucency = "sidebar";
}

describe("chat composer on sidebar-only macOS glass", () => {
  it.each(["light", "dark"])(
    "avoids a second backdrop layer and keeps dense fills in %s mode",
    async (theme) => {
      root.classList.toggle("dark", theme === "dark");
      sidebarGlass();
      await render(<ComposerFixture />, { container: appRoot });

      for (const name of ["composer", "stacked"] as const) {
        expect(getComputedStyle(surface(name), "::before").backdropFilter).toBe("none");
        expect(fillAlpha(surface(name))).toBeGreaterThanOrEqual(name === "composer" ? 0.9 : 0.75);
      }
    },
  );

  it.each([
    { name: "browser", transparent: false, material: "opaque", scope: "none" },
    { name: "Solid macOS", transparent: true, material: "opaque", scope: "none" },
    { name: "nontransparent host", transparent: false, material: "translucent", scope: "sidebar" },
  ])("preserves page frosting on a $name surface", async ({ transparent, material, scope }) => {
    if (transparent) root.dataset.windowTransparent = "true";
    else delete root.dataset.windowTransparent;
    root.dataset.windowMaterial = material;
    root.dataset.windowTranslucency = scope;
    await render(<ComposerFixture />, { container: appRoot });

    for (const name of ["composer", "stacked"] as const) {
      expect(getComputedStyle(surface(name), "::before").backdropFilter).not.toBe("none");
      expect(fillAlpha(surface(name))).toBeLessThan(0.75);
    }
  });

  it("preserves the shared raised tint on whole-window glass", async () => {
    sidebarGlass();
    root.dataset.windowTranslucency = "window";
    await render(<ComposerFixture />, { container: appRoot });

    for (const name of ["composer", "stacked"] as const) {
      expect(getComputedStyle(surface(name), "::before").backdropFilter).toBe("none");
      expect(fillAlpha(surface(name))).toBeCloseTo(name === "composer" ? 0.4 : 0.2, 2);
    }
  });

  it("restores page frosting when switching the mounted composer to Solid", async () => {
    sidebarGlass();
    await render(<ComposerFixture />, { container: appRoot });
    expect(getComputedStyle(surface("composer"), "::before").backdropFilter).toBe("none");

    root.dataset.windowMaterial = "opaque";
    root.dataset.windowTranslucency = "none";
    for (const name of ["composer", "stacked"] as const) {
      expect(getComputedStyle(surface(name), "::before").backdropFilter).not.toBe("none");
      await expect.poll(() => fillAlpha(surface(name))).toBeLessThan(0.75);
    }
  });

  it("uses the whole-window tint when changing scope without remounting the composer", async () => {
    sidebarGlass();
    await render(<ComposerFixture />, { container: appRoot });
    expect(fillAlpha(surface("composer"))).toBeGreaterThanOrEqual(0.9);

    root.dataset.windowTranslucency = "window";
    for (const name of ["composer", "stacked"] as const) {
      expect(getComputedStyle(surface(name), "::before").backdropFilter).toBe("none");
      await expect
        .poll(() => fillAlpha(surface(name)))
        .toBeCloseTo(name === "composer" ? 0.4 : 0.2, 2);
    }
  });
});

describe("composer menus over the transcript", () => {
  it.each(
    ["light", "dark"].flatMap((theme) =>
      ["none", "sidebar", "window"].map((scope) => ({ theme, scope })),
    ),
  )("covers transcript text in $theme / $scope mode", async ({ theme, scope }) => {
    await page.viewport(900, 650);
    root.classList.toggle("dark", theme === "dark");
    root.style.setProperty(
      "--popover",
      theme === "dark" ? "rgb(40, 50, 60)" : "rgb(255, 255, 255)",
    );
    root.dataset.windowTransparent = scope === "none" ? "false" : "true";
    root.dataset.windowMaterial = scope === "none" ? "opaque" : "translucent";
    root.dataset.windowTranslucency = scope;
    await render(
      <div style={{ position: "relative", paddingTop: 340, width: 600 }}>
        <p style={{ position: "absolute", inset: 0, fontSize: 24 }}>
          Transcript text behind the menu must stay hidden. This is a long assistant response.
        </p>
        <div data-chat-composer-slot>
          <ComposerColumnFrame>
            <div className={COMPOSER_INPUT_SURFACE_CLASS_NAME}>
              <div className={COMPOSER_COMMAND_MENU_FLOATING_WRAPPER_CLASS_NAME}>
                <ComposerCommandMenu
                  items={Array.from({ length: 24 }, (_, index) => ({
                    id: `command-${index}`,
                    type: "provider-native-command",
                    provider: "omp",
                    command: `command-${index}`,
                    label: `Command ${index}`,
                    description: "A provider command",
                  }))}
                  resolvedTheme={theme === "dark" ? "dark" : "light"}
                  isLoading={false}
                  triggerKind="slash-command"
                  activeItemId="command-0"
                  onHighlightedItemChange={() => {}}
                  onSelect={() => {}}
                />
              </div>
              Draft input
            </div>
          </ComposerColumnFrame>
        </div>
      </div>,
      { container: appRoot },
    );

    const menu = appRoot.querySelector<HTMLElement>(".chat-composer-menu-surface")!;
    if (theme === "light" && scope === "window") {
      await page.screenshot({ path: "../../../../../output/playwright/composer-menu-opaque.png" });
    }
    expect(fillAlpha(menu)).toBe(1);
    expect(getComputedStyle(menu).opacity).toBe("1");
    const list = menu.querySelector<HTMLElement>('[data-slot="scroll-area-viewport"]')!;
    expect(list.scrollHeight).toBeGreaterThan(list.clientHeight);
    list.scrollTop = list.scrollHeight;
    expect(list.scrollTop).toBeGreaterThan(0);

    // Changing the window material while a menu is open must not restore a thin fill.
    root.dataset.windowTranslucency = scope === "window" ? "sidebar" : "window";
    expect(fillAlpha(menu)).toBe(1);
  });
});
