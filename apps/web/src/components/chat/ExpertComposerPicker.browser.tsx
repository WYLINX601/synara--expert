import "../../index.css";

import type { ExpertDefinition, ExpertPreview } from "@synara/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ComponentProps } from "react";
import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { ExpertComposerPicker } from "./ExpertComposerPicker";
import { t } from "~/i18n";

const expertsQueryKey = ["server", "experts"] as const;
const expert: ExpertDefinition = {
  id: "planner",
  name: "规划专家",
  description: "帮助规划任务",
  useCases: "方案梳理",
  persona: "先澄清目标",
  outputRequirements: "给出步骤和依据",
  skills: [],
  references: [],
  connections: [],
  preferredProvider: "codex",
  revision: 1,
  archived: false,
  updatedAt: "2026-10-19T00:00:00.000Z",
};

let unmount: (() => Promise<void>) | undefined;
let queryClient: QueryClient | undefined;

afterEach(async () => {
  await unmount?.();
  unmount = undefined;
  queryClient?.clear();
  queryClient = undefined;
});

async function renderPicker(props: Partial<ComponentProps<typeof ExpertComposerPicker>> = {}) {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  queryClient.setQueryData(expertsQueryKey, [expert]);
  const view = await render(
    <QueryClientProvider client={queryClient}>
      <ExpertComposerPicker
        expertId="planner"
        provider="codex"
        preview={undefined}
        previewFetching={false}
        previewError={false}
        unsupportedProvider={false}
        onSelect={() => {}}
        {...props}
      />
    </QueryClientProvider>,
  );
  unmount = () => view.unmount();
  return view;
}

function preview(status: ExpertPreview["status"], issues: string[] = []): ExpertPreview {
  return { definition: expert, status, issues };
}

describe("expert composer picker status feedback", () => {
  it("keeps healthy status out of the trigger and omits the empty footer", async () => {
    await renderPicker({ preview: preview("available") });
    const trigger = page.getByRole("button", {
      name: t("chat:expertPickerAriaSelected", { name: "规划专家" }),
      exact: true,
    });

    await expect
      .element(trigger)
      .toHaveAttribute("title", t("chat:expertPickerTitleSelect", { label: "规划专家" }));
    await expect.element(trigger).not.toHaveTextContent(t("chat:expertPreviewPartial"));
    await trigger.click();

    expect(page.getByText(t("chat:expertPreviewPartial"), { exact: true }).elements()).toHaveLength(
      0,
    );
    expect(document.querySelector('[data-slot="menu-popup"] .border-t')).toBeNull();
  });

  it("shows healthy preview issues without restoring the available label", async () => {
    await renderPicker({ preview: preview("available", ["预览警告：未找到可选技能"]) });
    const trigger = page.getByRole("button", {
      name: t("chat:expertPickerAriaSelected", { name: "规划专家" }),
      exact: true,
    });

    await expect.element(trigger).not.toHaveTextContent(t("chat:expertPreviewPartial"));
    await expect
      .element(trigger)
      .toHaveAttribute("title", t("chat:expertPickerTitleSelect", { label: "规划专家" }));
    await trigger.click();

    await expect.element(page.getByText("预览警告：未找到可选技能", { exact: true })).toBeVisible();
    expect(document.querySelector('[data-slot="menu-popup"] .border-t')).not.toBeNull();
    expect(page.getByText(t("chat:expertPreviewPartial"), { exact: true }).elements()).toHaveLength(
      0,
    );
  });

  it.each([
    {
      feedback: t("chat:expertPickerChecking"),
      previewFetching: true,
      previewError: false,
      detail: undefined,
    },
    {
      feedback: t("chat:expertPickerCheckFailed"),
      previewFetching: false,
      previewError: true,
      detail: t("chat:expertPickerPreviewFailed"),
    },
  ])(
    "preserves $feedback feedback for a cached available preview",
    async ({ feedback, previewFetching, previewError, detail }) => {
      await renderPicker({
        preview: preview("available"),
        previewFetching,
        previewError,
      });
      const trigger = page.getByRole("button", {
        name: t("chat:expertPickerAriaSelected", { name: "规划专家" }),
        exact: true,
      });

      await expect.element(trigger).toHaveTextContent(feedback);
      await expect.element(trigger).toHaveAttribute("title", `规划专家 · ${feedback}`);
      await expect.element(trigger).not.toHaveTextContent(t("chat:expertPreviewPartial"));
      await trigger.click();

      const menu = page.getByRole("menu");
      await expect.element(menu.getByText(feedback, { exact: true })).toBeVisible();
      if (detail) await expect.element(menu.getByText(detail, { exact: true })).toBeVisible();
      expect(document.querySelector('[data-slot="menu-popup"] .border-t')).not.toBeNull();
    },
  );

  it.each([
    ["partial", t("chat:expertPreviewPartial")],
    ["blocked", t("chat:expertPreviewNeedsConnection")],
    ["incompatible", t("chat:expertPreviewIncompatible")],
  ] as const)("shows %s status and its preview issues", async (status, label) => {
    await renderPicker({ preview: preview(status, ["需要连接 Linear"]) });
    const trigger = page.getByRole("button", {
      name: t("chat:expertPickerAriaSelected", { name: "规划专家" }),
      exact: true,
    });

    await expect.element(trigger).toHaveTextContent(label);
    await expect.element(trigger).toHaveAttribute("title", `规划专家 · ${label}`);
    await trigger.click();

    await expect.element(page.getByRole("menu").getByText(label, { exact: true })).toBeVisible();
    await expect.element(page.getByText("需要连接 Linear", { exact: true })).toBeVisible();
  });

  it("keeps loading and preview errors visible in the trigger and menu", async () => {
    await renderPicker({ previewFetching: true });
    const trigger = page.getByRole("button", {
      name: t("chat:expertPickerAriaSelected", { name: "规划专家" }),
      exact: true,
    });

    await expect.element(trigger).toHaveTextContent(t("chat:expertPickerChecking"));
    await trigger.click();
    await expect
      .element(page.getByRole("menu").getByText(t("chat:expertPickerChecking"), { exact: true }))
      .toBeVisible();
    await unmount?.();
    unmount = undefined;
    queryClient?.clear();
    queryClient = undefined;

    await renderPicker({ previewError: true });
    const errorTrigger = page.getByRole("button", {
      name: t("chat:expertPickerAriaSelected", { name: "规划专家" }),
      exact: true,
    });
    await expect.element(errorTrigger).toHaveTextContent(t("chat:expertPickerCheckFailed"));
    await errorTrigger.click();
    await expect
      .element(page.getByRole("menu").getByText(t("chat:expertPickerCheckFailed"), { exact: true }))
      .toBeVisible();
  });

  it("retains the selected checkmark and commits an expert selection", async () => {
    const onSelect = vi.fn();
    const onSelectionCommitted = vi.fn();
    await renderPicker({ onSelect, onSelectionCommitted });
    await page
      .getByRole("button", {
        name: t("chat:expertPickerAriaSelected", { name: "规划专家" }),
        exact: true,
      })
      .click();

    const selectedItem = page.getByRole("menuitem", { name: "规划专家", exact: true });
    const selectedRow = Array.from(
      document.querySelectorAll<HTMLElement>('[role="menuitem"]'),
    ).find((item) => item.textContent?.trim() === "规划专家");
    expect(selectedRow?.querySelector("svg")).not.toBeNull();
    await selectedItem.click();

    expect(onSelect).toHaveBeenCalledOnce();
    expect(onSelect).toHaveBeenLastCalledWith("planner");
    expect(onSelectionCommitted).toHaveBeenCalledOnce();
  });
});
