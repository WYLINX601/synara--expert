import "../../../index.css";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { HubDeliverableCollection, LibraryEntry } from "@synara/contracts";
import { ProjectId } from "@synara/contracts";
import { page } from "vitest/browser";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import type { LibraryKeyDeliverable } from "./libraryPanel.logic";

const harness = vi.hoisted(() => ({
  rootEntries: [] as LibraryEntry[],
  dirEntries: {} as Record<string, LibraryEntry[]>,
  listCalls: [] as Array<string | undefined>,
  uploaded: [] as string[],
  fetchImpl: undefined as
    | ((input: RequestInfo | URL, init?: RequestInit) => Promise<Response>)
    | undefined,
  api: {
    projectAgent: {
      getOverview: vi.fn(
        async (): Promise<{ hubWorkItems: readonly unknown[] }> => ({
          hubWorkItems: [],
        }),
      ),
      library: {
        list: vi.fn(),
        mkdir: vi.fn(),
        rename: vi.fn(),
        delete: vi.fn(),
        history: vi.fn(
          async (): Promise<{
            root: string;
            commits: readonly { sha: string; message: string; at: string }[];
          }> => ({ root: "/library", commits: [] }),
        ),
        restore: vi.fn(),
        status: vi.fn(async () => ({
          root: "/library",
          remoteConfigured: false,
          lastPushAt: null,
          lastPushError: null,
        })),
      },
      deliverables: {
        list: vi.fn(async () => [] as readonly HubDeliverableCollection[]),
        read: vi.fn(),
      },
    },
    contextMenu: {
      show: vi.fn(
        async (..._args: unknown[]): Promise<"rename" | "delete" | "history" | null> => null,
      ),
    },
    projects: {
      readFile: vi.fn(async () => ({
        relativePath: "note.md",
        contents: "# note\n",
        truncated: false,
        version: null,
        encoding: "utf8",
        lineEnding: "lf",
      })),
      onFileChange: vi.fn(() => () => undefined),
    },
    git: {
      readWorkingTreeDiff: vi.fn(async () => ({ patch: "", truncated: false })),
    },
    server: {
      getConfig: vi.fn(async () => ({ availableEditors: ["vscode"], keybindings: [] })),
    },
    shell: {
      openInEditor: vi.fn(async () => undefined),
    },
  },
}));

vi.mock("~/nativeApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/nativeApi")>()),
  readNativeApi: () => harness.api,
  ensureNativeApi: () => harness.api,
}));

import { LibraryPanel } from "./LibraryPanel";

const projectId = ProjectId.makeUnsafe("group-1");

const fileEntry = (name: string, relativePath = name): LibraryEntry => ({
  name,
  relativePath,
  kind: "file",
  sizeBytes: 10,
  modifiedAt: "2026-01-01T00:00:00Z",
});

const dirEntry = (name: string): LibraryEntry => ({
  name,
  relativePath: name,
  kind: "directory",
  sizeBytes: 0,
  modifiedAt: "2026-01-01T00:00:00Z",
});

beforeEach(() => {
  harness.rootEntries = [];
  harness.dirEntries = {};
  harness.listCalls = [];
  harness.uploaded = [];
  harness.api.projectAgent.library.list.mockImplementation(
    async (input: { relativePath?: string }) => {
      harness.listCalls.push(input.relativePath);
      return {
        root: "/library",
        entries: input.relativePath
          ? (harness.dirEntries[input.relativePath] ?? [])
          : harness.rootEntries,
      };
    },
  );
  harness.api.projectAgent.library.mkdir.mockResolvedValue({ commitSha: "a" });
  harness.api.projectAgent.library.rename.mockResolvedValue({ commitSha: "b" });
  harness.api.projectAgent.library.delete.mockResolvedValue({ commitSha: "c" });
  harness.api.projectAgent.library.restore.mockResolvedValue({ commitSha: "d" });
  harness.api.projects.readFile.mockClear();
  harness.api.shell.openInEditor.mockClear();
  harness.api.projectAgent.deliverables.list.mockResolvedValue([]);
  harness.api.projectAgent.getOverview.mockResolvedValue({ hubWorkItems: [] });
  harness.api.projectAgent.deliverables.read.mockResolvedValue({
    hubId: projectId,
    workerThreadId: "expert-thread-1",
    revision: 3,
    commitSha: "a".repeat(40),
    provenance: {
      hubId: projectId,
      workerThreadId: "expert-thread-1",
      expertBindingSnapshotId: "snapshot-1",
      publishedAt: "2026-10-18T12:00:00Z",
    },
    file: {
      path: "out/final-report.md",
      libraryPath: "Artifacts/published-report.md",
      name: "published-report.md",
      description: null,
      mediaType: "text/markdown",
      sizeBytes: 24,
      sha256: "b".repeat(64),
    },
    content: { encoding: "utf-8", text: "# Published report\n\nPinned body." },
  });
  harness.api.contextMenu.show.mockResolvedValue(null);
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
    if (harness.fetchImpl) return harness.fetchImpl(input, init);
    return Promise.reject(new Error("unexpected fetch"));
  });
});

async function renderPanel(
  tab: "key" | "all" = "key",
  props: { onReferenceDeliverable?: (selection: LibraryKeyDeliverable) => void } = {},
) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const rendered = await render(
    <QueryClientProvider client={queryClient}>
      <div style={{ position: "relative", width: 480, height: 640 }}>
        <LibraryPanel
          open
          variant="docked"
          projectId={projectId}
          onClose={() => {}}
          {...(props.onReferenceDeliverable
            ? { onReferenceDeliverable: props.onReferenceDeliverable }
            : {})}
        />
      </div>
    </QueryClientProvider>,
  );
  if (tab === "all") await page.getByRole("radio", { name: "All files" }).click();
  return rendered;
}

describe("LibraryPanel", () => {
  it("defaults to the key deliverables view", async () => {
    const { container } = await renderPanel();
    await expect
      .element(page.getByText("No key deliverables are available in this library."))
      .toBeVisible();
    expect(container.querySelector('[data-library-view="key"]')).not.toBeNull();
  });

  it("marks missing key files and excludes withdrawn collections", async () => {
    const makeCollection = (
      workerThreadId: string,
      state: "active" | "withdrawn",
      name: string,
      libraryState: "available" | "missing",
    ) =>
      ({
        hubId: projectId,
        workerThreadId,
        revision: 1,
        state,
        commitSha: "a".repeat(40),
        provenance: {
          hubId: projectId,
          workerThreadId,
          expertBindingSnapshotId: "snapshot-1",
          publishedAt: "2026-10-18T12:00:00Z",
        },
        expertBinding: { expertId: "expert-1", displayName: "Research Expert", revision: 1 },
        sourceWorkTitle: "Research notes",
        files: [
          {
            path: `out/${name}`,
            libraryPath: `Artifacts/${name}`,
            currentLibraryPath: `Artifacts/${name}`,
            libraryState,
            name,
            description: null,
            mediaType: "text/markdown",
            sizeBytes: 1,
            sha256: "b".repeat(64),
          },
        ],
        updatedAt: "2026-10-18T12:00:00Z",
      }) as unknown as HubDeliverableCollection;
    harness.api.projectAgent.deliverables.list.mockResolvedValue([
      makeCollection("worker-missing", "active", "missing.md", "missing"),
      makeCollection("worker-withdrawn", "withdrawn", "withdrawn.md", "available"),
    ]);

    await renderPanel();
    await expect
      .element(page.getByRole("button", { name: "missing.md, missing from Library" }))
      .toBeVisible();
    await expect.element(page.getByText("Missing from Library", { exact: true })).toBeVisible();
    expect(page.getByRole("button", { name: "withdrawn.md" }).length).toBe(0);
  });

  it("shows the empty state when All files has no files", async () => {
    await renderPanel("all");
    await expect
      .element(page.getByText("No files yet. Add documents or artifacts for this hub."))
      .toBeVisible();
  });

  it("lists entries and toggles between list and grid views", async () => {
    harness.rootEntries = [dirEntry("Artifacts"), fileEntry("note.md")];
    const { container } = await renderPanel("all");

    await expect.element(page.getByText("Artifacts", { exact: true })).toBeVisible();
    await expect.element(page.getByText("note.md", { exact: true })).toBeVisible();
    expect(container.querySelector('[data-library-view="list"]')).not.toBeNull();

    await page.getByRole("radio", { name: "Grid" }).click();
    expect(container.querySelector('[data-library-view="grid"]')).not.toBeNull();

    await page.getByRole("radio", { name: "List" }).click();
    expect(container.querySelector('[data-library-view="list"]')).not.toBeNull();
  });

  it("refreshes in place on focus without wiping expanded subfolders", async () => {
    harness.rootEntries = [dirEntry("Artifacts")];
    harness.dirEntries = {
      Artifacts: [
        {
          name: "deep",
          relativePath: "Artifacts/deep",
          kind: "directory",
          sizeBytes: 0,
          modifiedAt: "2026-01-01T00:00:00Z",
        },
      ],
      "Artifacts/deep": [fileEntry("inner.md", "Artifacts/deep/inner.md")],
    };
    await renderPanel("all");

    // Artifacts is seeded expanded; deepen the tree once its children render.
    await expect.element(page.getByRole("button", { name: "deep" })).toBeVisible();
    await page.getByRole("button", { name: "deep" }).click();
    await expect.element(page.getByText("inner.md", { exact: true })).toBeVisible();

    const callsBeforeFocus = harness.listCalls.length;
    window.dispatchEvent(new Event("focus"));
    await vi.waitFor(() =>
      expect(harness.listCalls.length).toBeGreaterThanOrEqual(callsBeforeFocus + 3),
    );

    // The root plus every already-loaded directory is re-listed — the deep
    // listing is replaced in place, never cleared first.
    const refreshCalls = harness.listCalls.slice(callsBeforeFocus);
    expect(refreshCalls).toContain(undefined);
    expect(refreshCalls).toContain("Artifacts");
    expect(refreshCalls).toContain("Artifacts/deep");
    await expect.element(page.getByText("inner.md", { exact: true })).toBeVisible();
  });

  it("coalesces a focus burst into at most one follow-up refresh", async () => {
    harness.rootEntries = [dirEntry("Artifacts")];
    harness.dirEntries = { Artifacts: [] };
    await renderPanel("all");
    await expect.element(page.getByText("Artifacts", { exact: true })).toBeVisible();

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const immediateList = harness.api.projectAgent.library.list.getMockImplementation()!;
    harness.api.projectAgent.library.list.mockImplementation(
      async (input: { relativePath?: string }) => {
        await gate;
        return immediateList(input);
      },
    );

    const callsBeforeFocus = harness.listCalls.length;
    window.dispatchEvent(new Event("focus"));
    window.dispatchEvent(new Event("focus"));
    window.dispatchEvent(new Event("focus"));
    release();

    await vi.waitFor(() => expect(harness.listCalls.length).toBe(callsBeforeFocus + 4));
  });

  it("goes back to the file list through the preview breadcrumb button", async () => {
    harness.rootEntries = [fileEntry("note.md")];
    const { container } = await renderPanel("all");

    await page.getByRole("button", { name: "note.md" }).click();
    await vi.waitFor(() => expect(harness.api.projects.readFile).toHaveBeenCalled());
    const openInEditor = page.getByRole("button", { name: "Open", exact: true });
    await expect.element(openInEditor).toBeVisible();
    await openInEditor.click();
    await vi.waitFor(() =>
      expect(harness.api.shell.openInEditor).toHaveBeenCalledWith("/library/note.md", "vscode"),
    );
    const back = page.getByRole("button", { name: "Back to library from note.md" });
    await expect.element(back).toBeVisible();
    // The file name itself is part of the single back button.
    await expect.element(back).toHaveTextContent("note.md");

    await back.click();
    await expect.element(page.getByRole("button", { name: "note.md" })).toBeVisible();
    expect(container.querySelector('[aria-label^="Back to library"]')).toBeNull();
  });

  it("groups by the accepted Expert snapshot and reads the exact pinned publication revision", async () => {
    harness.rootEntries = [dirEntry("Artifacts"), fileEntry("ordinary.md")];
    harness.dirEntries.Artifacts = [
      {
        name: "Reports",
        relativePath: "Artifacts/Reports",
        kind: "directory",
        sizeBytes: 0,
        modifiedAt: "2026-01-01T00:00:00Z",
      },
    ];
    harness.dirEntries["Artifacts/Reports"] = [
      fileEntry("current-report.md", "Artifacts/Reports/current-report.md"),
    ];
    harness.api.projectAgent.deliverables.list.mockResolvedValue([
      {
        hubId: projectId,
        workerThreadId: "expert-thread-1",
        revision: 3,
        state: "active",
        commitSha: "a".repeat(40),
        provenance: {
          hubId: projectId,
          workerThreadId: "expert-thread-1",
          expertBindingSnapshotId: "snapshot-1",
          publishedAt: "2026-10-18T12:00:00Z",
        },
        expertBinding: { expertId: "expert-1", displayName: "Research Expert", revision: 2 },
        sourceWorkTitle: "Case synthesis",
        files: [
          {
            path: "out/final-report.md",
            libraryPath: "Artifacts/Reports/published-report.md",
            currentLibraryPath: "Artifacts/Reports/current-report.md",
            libraryState: "available",
            name: "published-report.md",
            description: null,
            mediaType: "text/markdown",
            sizeBytes: 24,
            sha256: "b".repeat(64),
          },
        ],
        updatedAt: "2026-10-18T12:00:00Z",
      } as unknown as HubDeliverableCollection,
    ]);
    const reference = vi.fn<(selection: LibraryKeyDeliverable) => void>();
    const { container } = await renderPanel("key", { onReferenceDeliverable: reference });

    await expect.element(page.getByRole("heading", { name: "Research Expert" })).toBeVisible();
    await expect.element(page.getByText("Case synthesis", { exact: true })).toBeVisible();
    await expect.element(page.getByRole("button", { name: "published-report.md" })).toBeVisible();
    expect(container.querySelector('[data-library-view="key"]')?.textContent).not.toContain(
      "Artifacts/Reports",
    );
    expect(page.getByRole("button", { name: "ordinary.md" }).length).toBe(0);

    harness.api.projects.readFile.mockClear();
    await page.getByRole("button", { name: "published-report.md" }).click();
    await expect.element(page.getByText(/Research Expert · Case synthesis/)).toBeVisible();
    await expect.element(page.getByText(/revision 3/)).toBeVisible();
    await expect.element(page.getByText("Pinned body.", { exact: true })).toBeVisible();
    expect(page.getByRole("button", { name: "Open", exact: true }).length).toBe(0);
    expect(harness.api.shell.openInEditor).not.toHaveBeenCalled();
    await page.getByRole("button", { name: "Reference in chat" }).click();
    expect(reference).toHaveBeenCalledWith(
      expect.objectContaining({
        collection: expect.objectContaining({ revision: 3, workerThreadId: "expert-thread-1" }),
        file: expect.objectContaining({ name: "published-report.md" }),
      }),
    );
    expect(harness.api.projectAgent.getOverview).not.toHaveBeenCalled();
    expect(harness.api.projectAgent.deliverables.read).toHaveBeenCalledWith({
      projectId,
      ownerThreadId: "expert-thread-1",
      path: "out/final-report.md",
      revision: 3,
    });
    expect(harness.api.projects.readFile).not.toHaveBeenCalled();
    expect(container.querySelector('[aria-label^="Back to library from"]')).not.toBeNull();
  });

  it("grows taller and wider on expand and restores on collapse", async () => {
    harness.rootEntries = Array.from({ length: 40 }, (_, index) => fileEntry(`note-${index}.md`));
    const { container } = await renderPanel("all");

    const surface = () =>
      container.querySelector<HTMLElement>("[data-environment-panel-variant] > div")!;
    await expect.element(page.getByRole("button", { name: "note-0.md" })).toBeVisible();

    const collapsed = surface().getBoundingClientRect();
    await page.getByRole("button", { name: "Expand library" }).click();
    await vi.waitFor(() => {
      const rect = surface().getBoundingClientRect();
      expect(rect.height).toBeGreaterThan(collapsed.height);
      expect(rect.width).toBeGreaterThan(collapsed.width);
    });
    const expanded = surface().getBoundingClientRect();

    await page.getByRole("button", { name: "Collapse library" }).click();
    await vi.waitFor(() => {
      const rect = surface().getBoundingClientRect();
      expect(rect.height).toBeLessThan(expanded.height);
      expect(rect.width).toBeLessThan(expanded.width);
    });
  });

  it("uploads a file through the hidden input and refetches", async () => {
    harness.rootEntries = [dirEntry("Artifacts")];
    harness.fetchImpl = async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/library/upload") {
        const name = url.searchParams.get("name");
        if (name) harness.uploaded.push(name);
        harness.rootEntries = [dirEntry("Artifacts"), fileEntry("note.md")];
        return new Response(JSON.stringify(fileEntry("note.md")), {
          status: 201,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("not found", { status: 404 });
    };
    const { container } = await renderPanel("all");

    await page.getByRole("button", { name: /Add/ }).click();
    const input = container.querySelector<HTMLInputElement>('input[type="file"]');
    expect(input).not.toBeNull();
    const transfer = new DataTransfer();
    transfer.items.add(new File(["hello"], "note.md", { type: "text/markdown" }));
    input!.files = transfer.files;
    input!.dispatchEvent(new Event("change", { bubbles: true }));

    await expect.element(page.getByText("note.md", { exact: true })).toBeVisible();
    expect(harness.uploaded).toEqual(["note.md"]);
  });

  it("keeps rename, delete, history, and restore actions on the native context menu", async () => {
    harness.rootEntries = [fileEntry("note.md")];
    harness.api.projectAgent.library.history.mockResolvedValue({
      root: "/library",
      commits: [
        {
          sha: "c".repeat(40),
          message: "Upload note.md",
          at: "2026-10-18T12:00:00Z",
        },
      ],
    });
    const { container } = await renderPanel("all");
    const contextClick = async (result: "rename" | "delete" | "history") => {
      harness.api.contextMenu.show.mockResolvedValueOnce(result);
      const callsBefore = harness.api.contextMenu.show.mock.calls.length;
      const button = container.querySelector<HTMLButtonElement>('button[title="note.md"]');
      expect(button).not.toBeNull();
      button!.dispatchEvent(
        new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 2, clientY: 2 }),
      );
      await vi.waitFor(() =>
        expect(harness.api.contextMenu.show).toHaveBeenCalledTimes(callsBefore + 1),
      );
    };

    await contextClick("rename");
    const renameInput = page.getByRole("textbox", { name: "Rename note.md" });
    await renameInput.fill("renamed.md");
    container
      .querySelector<HTMLInputElement>('input[aria-label="Rename note.md"]')
      ?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await vi.waitFor(() =>
      expect(harness.api.projectAgent.library.rename).toHaveBeenCalledWith({
        projectId,
        from: "note.md",
        to: "renamed.md",
      }),
    );

    await contextClick("delete");
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    await vi.waitFor(() =>
      expect(harness.api.projectAgent.library.delete).toHaveBeenCalledWith({
        projectId,
        relativePath: "note.md",
      }),
    );

    await contextClick("history");
    await expect.element(page.getByText("Upload note.md", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Restore" }).click();
    await vi.waitFor(() =>
      expect(harness.api.projectAgent.library.restore).toHaveBeenCalledWith({
        projectId,
        relativePath: "note.md",
        sha: "c".repeat(40),
      }),
    );

    const menuItems = harness.api.contextMenu.show.mock.calls[0]?.[0] as
      | readonly { readonly id: string }[]
      | undefined;
    const menuIds = menuItems?.map((item) => item.id);
    expect(menuIds).toEqual(["rename", "delete", "history"]);
  });
});
