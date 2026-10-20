import "../../index.css";

import { StrictMode, useState } from "react";
import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { ComposerCommandMenu, type ComposerCommandItem } from "./ComposerCommandMenu";

async function mountMenu(input: {
  isLoading: boolean;
  triggerKind: "mention" | "skill" | "slash-command" | null;
  emptyStateText?: string;
  statusText?: string | null;
  items?: ComposerCommandItem[];
}) {
  const host = document.createElement("div");
  document.body.append(host);
  const screen = await render(
    <ComposerCommandMenu
      items={input.items ?? []}
      resolvedTheme="dark"
      isLoading={input.isLoading}
      triggerKind={input.triggerKind}
      {...(input.emptyStateText === undefined ? {} : { emptyStateText: input.emptyStateText })}
      {...(input.statusText === undefined ? {} : { statusText: input.statusText })}
      activeItemId={null}
      onHighlightedItemChange={vi.fn()}
      onSelect={vi.fn()}
    />,
    { container: host },
  );

  return {
    cleanup: async () => {
      await screen.unmount();
      host.remove();
    },
  };
}

describe("ComposerCommandMenu empty states", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("renders key deliverables under one heading with the accepted Expert identity at the right", async () => {
    const onSelect = vi.fn();
    const item: ComposerCommandItem = {
      id: "artifact",
      type: "hub-deliverable",
      label: "brief.md",
      mention: { name: "brief.md", path: "synara://hub/a/deliverables/b/brief.md?revision=3" },
      expertDisplayName: "Research at acceptance",
      description: "",
      disabled: false,
    };
    const expertItem: ComposerCommandItem = {
      id: "expert",
      type: "hub-expert",
      mention: { name: "Research", path: "synara://expert/expert-a" },
      label: "Research",
      description: "Research specialist",
      disabled: false,
    };
    const unavailableItem: ComposerCommandItem = {
      ...item,
      id: "artifact:missing",
      label: "missing.md",
      mention: {
        name: "missing.md",
        path: "synara://hub/a/deliverables/b/missing.md?revision=4",
      },
      disabled: true,
    };
    const screen = await render(
      <ComposerCommandMenu
        items={[expertItem, item, unavailableItem]}
        resolvedTheme="dark"
        isLoading={false}
        triggerKind="mention"
        activeItemId="artifact"
        onHighlightedItemChange={vi.fn()}
        onSelect={onSelect}
      />,
    );
    try {
      await expect.element(page.getByText("Experts", { exact: true })).toBeVisible();
      await expect.element(page.getByText("关键产物", { exact: true })).toBeVisible();
      expect(document.body.textContent).not.toContain("关键产物 ·");
      const row = page.getByRole("option", { name: /brief\.md/ });
      await expect.element(row).toBeVisible();
      await expect.element(row.getByText("Research at acceptance", { exact: true })).toBeVisible();
      await row.click();
      expect(onSelect).toHaveBeenCalledWith(item);
      const unavailableRow = page.getByRole("option", { name: /missing\.md/ });
      await expect.element(unavailableRow).toHaveAttribute("aria-disabled", "true");
      await expect.element(page.getByText("Unavailable", { exact: true })).toBeVisible();
      expect(document.body.textContent).not.toContain("revision");
      await expect
        .element(page.getByText("Type to search for files", { exact: true }))
        .toBeVisible();
    } finally {
      await screen.unmount();
    }
  });

  it("places the thread Project or Hub label in the truncated right metadata slot", async () => {
    const projectName = "A Project or Hub name that is intentionally much longer than the row";
    const threadItem: ComposerCommandItem = {
      id: "thread:thread-a",
      type: "thread",
      threadId: "thread-a",
      provider: "codex",
      mention: { name: "Research notes", path: "thread://thread-a" },
      label: "Research notes",
      description: projectName,
    };
    const screen = await render(
      <ComposerCommandMenu
        items={[threadItem]}
        resolvedTheme="dark"
        isLoading={false}
        triggerKind="mention"
        activeItemId={null}
        onHighlightedItemChange={vi.fn()}
        onSelect={vi.fn()}
      />,
    );

    try {
      const metadata = document.querySelector<HTMLElement>(`[title="${projectName}"]`);
      expect(metadata).not.toBeNull();
      expect(metadata?.className).toContain("truncate");
      expect(metadata?.parentElement?.className).toContain("text-right");
      await expect.element(page.getByRole("option", { name: /Research notes/ })).toBeVisible();
    } finally {
      await screen.unmount();
    }
  });

  it.each([
    ["mention", "mention", "Searching mentions..."],
    ["slash command", "slash-command", "Loading commands..."],
  ] as const)(
    "shows the %s loading label before results are available",
    async (_label, triggerKind, text) => {
      const menu = await mountMenu({ isLoading: true, triggerKind });

      try {
        await expect.element(page.getByText(text, { exact: true })).toBeVisible();
        if (triggerKind === "mention") {
          await expect.element(page.getByText("Files", { exact: true })).toBeVisible();
        } else {
          expect(document.querySelector('[data-slot="command-list"]')).toBeNull();
        }
      } finally {
        await menu.cleanup();
      }
    },
  );

  it("uses the supplied empty copy after loading completes", async () => {
    const menu = await mountMenu({
      isLoading: false,
      triggerKind: "slash-command",
      emptyStateText: "No commands are available for this provider.",
    });

    try {
      await expect
        .element(page.getByText("No commands are available for this provider.", { exact: true }))
        .toBeVisible();
      expect(document.body.textContent).not.toContain("Loading commands...");
    } finally {
      await menu.cleanup();
    }
  });

  it("keeps discovery errors visible alongside Hub and native results", async () => {
    const hubItem: ComposerCommandItem = {
      id: "artifact:brief",
      type: "hub-deliverable",
      label: "brief.md",
      mention: { name: "brief.md", path: "synara://hub/a/deliverables/b/brief.md?revision=3" },
      expertDisplayName: "Research at acceptance",
      description: "",
      disabled: false,
    };
    const nativeItem: ComposerCommandItem = {
      id: "path:readme",
      type: "path",
      path: "README.md",
      pathKind: "file",
      label: "README.md",
      description: "",
    };
    const errorText = "Hub references could not refresh. Reconnect and try again.";
    const onSelect = vi.fn();
    const screen = await render(
      <ComposerCommandMenu
        items={[hubItem, nativeItem]}
        resolvedTheme="dark"
        isLoading={false}
        triggerKind="mention"
        statusText={errorText}
        activeItemId={null}
        onHighlightedItemChange={vi.fn()}
        onSelect={onSelect}
      />,
    );

    try {
      await expect.element(page.getByRole("status")).toBeVisible();
      await expect.element(page.getByText(errorText, { exact: true })).toBeVisible();
      const hubOption = page.getByRole("option", { name: /brief\.md/ });
      const nativeOption = page.getByRole("option", { name: "README.md", exact: true });
      await expect.element(hubOption).toBeVisible();
      await expect.element(nativeOption).toBeVisible();

      await hubOption.click();
      await nativeOption.click();
      expect(onSelect).toHaveBeenNthCalledWith(1, hubItem);
      expect(onSelect).toHaveBeenNthCalledWith(2, nativeItem);
    } finally {
      await screen.unmount();
    }
  });
});

describe("ComposerCommandMenu dynamic results", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("keeps Base UI list registration stable while results and active row change", async () => {
    const firstItem: ComposerCommandItem = {
      id: "artifact:brief",
      type: "hub-deliverable",
      label: "brief.md",
      mention: { name: "brief.md", path: "synara://hub/a/deliverables/b/brief.md?revision=3" },
      expertDisplayName: "Research at acceptance",
      description: "",
      disabled: false,
    };
    const secondItem: ComposerCommandItem = {
      ...firstItem,
      id: "artifact:notes",
      label: "notes.md",
      mention: { name: "notes.md", path: "synara://hub/a/deliverables/b/notes.md?revision=4" },
    };
    const replacementItem: ComposerCommandItem = {
      ...firstItem,
      id: "artifact:summary",
      label: "summary.md",
      mention: {
        name: "summary.md",
        path: "synara://hub/a/deliverables/b/summary.md?revision=5",
      },
    };
    const expertItem: ComposerCommandItem = {
      id: "expert:research",
      type: "hub-expert",
      mention: { name: "Research", path: "synara://expert/expert-a" },
      label: "Research",
      description: "Research specialist",
      disabled: false,
    };

    function StatefulMenu() {
      const [query, setQuery] = useState("");
      const [rebuild, setRebuild] = useState(false);
      const [activeItemId, setActiveItemId] = useState<string | null>(firstItem.id);
      const [, setHighlightEventCount] = useState(0);
      const matching = query
        ? [replacementItem]
        : rebuild
          ? [expertItem, secondItem, firstItem]
          : [expertItem, firstItem, secondItem];
      // Rebuild item/group objects on each parent render just as composer search results do.
      const items = matching.map((item) => ({ ...item, description: query }));

      return (
        <>
          <input
            aria-label="Search references"
            value={query}
            onChange={(event) => {
              const nextQuery = event.currentTarget.value;
              setQuery(nextQuery);
              setActiveItemId(nextQuery ? replacementItem.id : firstItem.id);
            }}
          />
          <button
            type="button"
            onClick={() => {
              setRebuild((value) => !value);
              setActiveItemId(rebuild ? firstItem.id : secondItem.id);
            }}
          >
            Rebuild results
          </button>
          <ComposerCommandMenu
            items={items}
            resolvedTheme="dark"
            isLoading={false}
            triggerKind="mention"
            activeItemId={activeItemId}
            onHighlightedItemChange={(itemId) => {
              setActiveItemId(itemId);
              setHighlightEventCount((count) => count + 1);
            }}
            onSelect={vi.fn()}
          />
        </>
      );
    }

    const screen = await render(
      <StrictMode>
        <StatefulMenu />
      </StrictMode>,
    );
    try {
      const briefRow = page.getByRole("option", { name: /brief\.md/ });
      await expect.element(briefRow).toBeVisible();
      await briefRow.hover();
      await page.getByRole("button", { name: "Rebuild results", exact: true }).click();
      const notesRow = page.getByRole("option", { name: /notes\.md/ });
      await expect.element(notesRow).toBeVisible();
      await page.getByRole("textbox", { name: "Search references" }).fill("summary");
      const summaryRow = page.getByRole("option", { name: /summary\.md/ });
      await expect.element(summaryRow).toBeVisible();
      await page.getByRole("textbox", { name: "Search references" }).fill("");
      await expect.element(briefRow).toBeVisible();
    } finally {
      await screen.unmount();
    }
  });
});

describe("ComposerCommandMenu provider command notices", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("explains an unavailable provider command from a warning tooltip", async () => {
    const notice = "/design needs Claude Artifacts, which are off in Synara sessions by default.";
    const summary = "Artifacts are off. Turn them on in Settings.";
    const menu = await mountMenu({
      isLoading: false,
      triggerKind: "slash-command",
      items: [
        {
          id: "provider-command:claudeAgent:design",
          type: "provider-native-command",
          provider: "claudeAgent",
          command: "design",
          label: "/design",
          description: "Make a new Design artifact from a brief",
          notice: { summary, detail: notice },
        },
        {
          id: "provider-command:claudeAgent:compact",
          type: "provider-native-command",
          provider: "claudeAgent",
          command: "compact",
          label: "/compact",
          description: "Compact context",
        },
      ],
    });

    try {
      // Readable from the row alone, since keyboard use never focuses the icon.
      await expect.element(page.getByText(summary, { exact: true })).toBeVisible();
      const badge = page.getByRole("img", { name: notice });
      await expect.element(badge).toBeVisible();
      expect(document.querySelectorAll('[role="img"][aria-label]').length).toBe(1);
      await badge.hover();
      await expect.element(page.getByText(notice, { exact: true })).toBeVisible();
    } finally {
      await menu.cleanup();
    }
  });
});
