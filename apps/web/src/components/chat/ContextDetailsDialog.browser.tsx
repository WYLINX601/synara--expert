import "../../index.css";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ProjectId, ThreadId, type ContextApi, type ThreadContextDetails } from "@synara/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

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
});
