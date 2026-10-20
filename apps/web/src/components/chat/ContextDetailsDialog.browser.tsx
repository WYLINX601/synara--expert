import "../../index.css";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  ProjectId,
  SpaceId,
  ThreadId,
  type ContextApi,
  type ContextSnapshot,
  type ThreadContextDetails,
} from "@synara/contracts";
import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

const contextClientHarness = vi.hoisted(() => ({
  value: null as null | {
    capability: "supported" | "unsupported" | "unknown";
    supported: boolean;
    generation: string | null;
    connected: boolean;
    available: boolean;
    api: null;
  },
}));
vi.mock("~/workbench/host/contextClient", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/workbench/host/contextClient")>();
  return {
    ...actual,
    useContextClient: () => contextClientHarness.value ?? actual.useContextClient(),
  };
});

import { ContextDetailsDialog } from "./ContextDetailsDialog";

const threadId = ThreadId.makeUnsafe("context-details-thread");
const projectId = ProjectId.makeUnsafe("context-details-project");

function details(overrides: Partial<ThreadContextDetails> = {}): ThreadContextDetails {
  return {
    dataInstanceId: "data-instance-details",
    threadId,
    mode: "bound",
    snapshot: null,
    preview: null,
    applied: null,
    loadStatus: "pending",
    hasNewVersion: false,
    retry: null,
    error: null,
    ...overrides,
  };
}

function boundSnapshot(source: "space" | "none"): ContextSnapshot {
  const common = {
    rendererVersion: 1 as const,
    text: source === "space" ? "Frozen standalone Space instructions" : "Frozen Hub background",
    snapshotHash: "snapshot-hash",
    hasContent: true,
    snapshotId: `snapshot-${source}`,
    createdAt: "2026-10-19T00:00:00.000Z",
  };
  if (source === "space") {
    return {
      ...common,
      schemaVersion: 2,
      source,
      space: {
        spaceId: SpaceId.makeUnsafe("context-details-space"),
        name: "Example Space",
        revision: 3,
        directionGoal: "Space goal",
        sharedInstructions: "Space instructions",
      },
    };
  }
  return { ...common, schemaVersion: 2, source, space: null };
}

function legacyBoundSnapshot(): ContextSnapshot {
  return {
    schemaVersion: 1,
    rendererVersion: 1,
    space: {
      spaceId: SpaceId.makeUnsafe("context-details-space"),
      name: "Legacy Space",
      revision: 2,
      directionGoal: "Legacy Space goal",
      sharedInstructions: "Legacy Space instructions",
    },
    project: {
      projectId,
      title: "Existing Project",
      workspaceRoot: "/workspace/project",
      revision: 4,
      projectGoal: "Project goal",
      projectInstructions: "Project instructions",
    },
    text: "Frozen v1 Project instructions",
    snapshotHash: "legacy-snapshot-hash",
    hasContent: true,
    snapshotId: "legacy-snapshot",
    createdAt: "2026-10-18T00:00:00.000Z",
  };
}

function setNativeApi(context: ContextApi): () => void {
  const previous = Object.getOwnPropertyDescriptor(window, "nativeApi");
  Object.defineProperty(window, "nativeApi", {
    configurable: true,
    value: { context },
  });
  return () => {
    if (previous) Object.defineProperty(window, "nativeApi", previous);
    else Reflect.deleteProperty(window, "nativeApi");
  };
}

describe("ContextDetailsDialog", () => {
  let restoreNativeApi: (() => void) | null = null;

  afterEach(() => {
    restoreNativeApi?.();
    restoreNativeApi = null;
    contextClientHarness.value = null;
    document.body.innerHTML = "";
  });

  it("refreshes the current thread load state while the details dialog stays open", async () => {
    let latest = details();
    const getThread = vi.fn(async () => latest);
    const context = {
      getSpace: vi.fn(),
      getProject: vi.fn(),
      getThread,
      saveSpace: vi.fn(),
      saveProject: vi.fn(),
      getCommandResult: vi.fn(),
      claimMigration: vi.fn(),
      resolveMigration: vi.fn(),
      retryLoad: vi.fn(),
    } satisfies ContextApi;
    restoreNativeApi = setNativeApi(context);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const host = document.createElement("div");
    document.body.append(host);
    const screen = await render(
      <QueryClientProvider client={queryClient}>
        <ContextDetailsDialog
          open
          onOpenChange={() => undefined}
          threadId={threadId}
          projectId={projectId}
          isLocalDraft={false}
          onNewThread={() => undefined}
        />
      </QueryClientProvider>,
      { container: host },
    );

    try {
      await expect.poll(() => document.body.textContent).toContain("Waiting to load");
      latest = details({ loadStatus: "stopped" });
      await expect.poll(() => document.body.textContent, { timeout: 5_000 }).toContain("stopped");
      expect(getThread.mock.calls.length).toBeGreaterThanOrEqual(2);
    } finally {
      await screen.unmount();
      queryClient.clear();
      host.remove();
    }
  });

  it("shows a reconnect message and disables new chat when the supported API is unavailable", async () => {
    contextClientHarness.value = {
      capability: "supported",
      generation: "test:1",
      connected: true,
      available: false,
      supported: true,
      api: null,
    };
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const host = document.createElement("div");
    document.body.append(host);
    const screen = await render(
      <QueryClientProvider client={queryClient}>
        <ContextDetailsDialog
          open
          onOpenChange={() => undefined}
          threadId={threadId}
          projectId={projectId}
          isLocalDraft={false}
          onNewThread={() => undefined}
        />
      </QueryClientProvider>,
      { container: host },
    );

    try {
      await expect
        .element(page.getByText("Context is temporarily unavailable. Reconnect and try again."))
        .toBeVisible();
      await expect
        .element(page.getByRole("button", { name: "Start a new chat with current Context" }))
        .toBeDisabled();
    } finally {
      await screen.unmount();
      queryClient.clear();
      host.remove();
    }
  });

  it.each([
    {
      label: "Space-only v2 snapshots",
      snapshot: boundSnapshot("space"),
      sourceLabel: "Example Space",
      frozenText: "Frozen standalone Space instructions",
    },
    {
      label: "Hub-background-only v2 snapshots",
      snapshot: boundSnapshot("none"),
      sourceLabel: "Hub background only",
      frozenText: "Frozen Hub background",
    },
  ])(
    "renders $label without changing the frozen snapshot",
    async ({ snapshot, sourceLabel, frozenText }) => {
      const context = {
        getSpace: vi.fn(),
        getProject: vi.fn(),
        getThread: vi.fn(async () => details({ loadStatus: "loaded", snapshot })),
        saveSpace: vi.fn(),
        saveProject: vi.fn(),
        getCommandResult: vi.fn(),
        claimMigration: vi.fn(),
        resolveMigration: vi.fn(),
        retryLoad: vi.fn(),
      } satisfies ContextApi;
      restoreNativeApi = setNativeApi(context);
      const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      const host = document.createElement("div");
      document.body.append(host);
      const screen = await render(
        <QueryClientProvider client={queryClient}>
          <ContextDetailsDialog
            open
            onOpenChange={() => undefined}
            threadId={threadId}
            projectId={null}
            isLocalDraft={false}
            onNewThread={() => undefined}
          />
        </QueryClientProvider>,
        { container: host },
      );

      try {
        await expect.element(page.getByText(sourceLabel, { exact: true })).toBeVisible();
        await expect.element(page.getByText(frozenText, { exact: true })).toBeVisible();
        expect(context.getThread).toHaveBeenCalledWith({ threadId });
      } finally {
        await screen.unmount();
        queryClient.clear();
        host.remove();
      }
    },
  );

  it("continues to render the legacy v1 Space-to-Project snapshot", async () => {
    const snapshot = legacyBoundSnapshot();
    const context = {
      getSpace: vi.fn(),
      getProject: vi.fn(),
      getThread: vi.fn(async () => details({ loadStatus: "loaded", snapshot })),
      saveSpace: vi.fn(),
      saveProject: vi.fn(),
      getCommandResult: vi.fn(),
      claimMigration: vi.fn(),
      resolveMigration: vi.fn(),
      retryLoad: vi.fn(),
    } satisfies ContextApi;
    restoreNativeApi = setNativeApi(context);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const host = document.createElement("div");
    document.body.append(host);
    const screen = await render(
      <QueryClientProvider client={queryClient}>
        <ContextDetailsDialog
          open
          onOpenChange={() => undefined}
          threadId={threadId}
          projectId={projectId}
          isLocalDraft={false}
          onNewThread={() => undefined}
        />
      </QueryClientProvider>,
      { container: host },
    );

    try {
      await expect
        .element(page.getByText("Legacy Space → Existing Project", { exact: true }))
        .toBeVisible();
      await expect
        .element(page.getByText("Frozen v1 Project instructions", { exact: true }))
        .toBeVisible();
    } finally {
      await screen.unmount();
      queryClient.clear();
      host.remove();
    }
  });
});
