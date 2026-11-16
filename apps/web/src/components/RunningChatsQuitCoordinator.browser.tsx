import "../index.css";

import {
  ThreadId,
  type DesktopBridge,
  type DesktopQuitConfirmationRequest,
  type LinxUpdateWindowMaintenanceRequest,
  type NativeApi,
} from "@synara/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { page, userEvent } from "vitest/browser";
import { afterEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { useStore, persistAppStateNow } from "~/store";
import { useComposerDraftStore } from "~/composerDraftStore";
import { getWorkspaceEditorSession } from "~/lib/workspaceEditorSession";
import { composerPersistenceOperationCount } from "~/lib/composerPersistenceActivity";
import type { DeferredPersistStorage } from "~/lib/storage";
import type { PersistedComposerDraftStoreState } from "~/composerDraftPersistence";
import { APP_DISPLAY_NAME } from "~/branding";
import { setLanguagePreference } from "~/i18n";

import { RunningChatsQuitCoordinator } from "./RunningChatsQuitCoordinator";

// Only native I/O is replaced; the coordinator, draft persistence and editor session stay real.
const { nativeIo } = vi.hoisted(() => ({
  nativeIo: {
    projects: {
      writeFile: vi.fn<NativeApi["projects"]["writeFile"]>(),
    } satisfies Pick<NativeApi["projects"], "writeFile">,
    orchestration: {
      dispatchCommand: vi.fn<NativeApi["orchestration"]["dispatchCommand"]>(),
    } satisfies Pick<NativeApi["orchestration"], "dispatchCommand">,
  },
}));
vi.mock("~/nativeApi", () => ({
  ensureNativeApi: () => nativeIo,
  readNativeApi: () => nativeIo,
  readNativeApiServerConnection: () => ({ generation: "isolated-native-fixture", connected: true }),
}));

vi.mock("~/lib/wsHttpUrl", async (original) => ({
  ...(await original<typeof import("../lib/wsHttpUrl")>()),
  resolveWsHttpUrl: () => "",
}));

type QuitBridge = Pick<
  DesktopBridge,
  "onQuitConfirmationRequest" | "replyQuitConfirmation" | "updateWindowMaintenance"
>;
const originalState = useStore.getState();
const originalComposerState = useComposerDraftStore.getState();

afterEach(() => {
  setLanguagePreference("en");
  vi.unstubAllGlobals();
  useStore.setState(originalState, true);
  useComposerDraftStore.setState(originalComposerState, true);
  (
    useComposerDraftStore.persist.getOptions()
      .storage as DeferredPersistStorage<PersistedComposerDraftStoreState>
  ).flush();
  vi.clearAllMocks();
});

it.each([
  { locale: "en" as const, title: `Quit ${APP_DISPLAY_NAME}?`, quit: "Quit" },
  { locale: "zh-CN" as const, title: `退出 ${APP_DISPLAY_NAME}？`, quit: "退出" },
])(
  "requires localized confirmation for an idle quit ($locale), supports Escape, and asks again after cancel",
  async ({ locale, title, quit }) => {
    setLanguagePreference(locale);
    let request: ((payload: DesktopQuitConfirmationRequest) => void) | undefined;
    const reply = vi.fn();
    vi.stubGlobal("desktopBridge", {
      onQuitConfirmationRequest: (listener) => {
        request = listener;
        return () => {
          request = undefined;
        };
      },
      replyQuitConfirmation: reply,
    } satisfies QuitBridge);
    useStore.setState({ sidebarThreadSummaryById: {}, threadSessionById: {}, threadShellById: {} });

    const queryClient = new QueryClient({
      defaultOptions: { queries: { enabled: false, retry: false } },
    });
    const screen = await render(
      <QueryClientProvider client={queryClient}>
        <RunningChatsQuitCoordinator />
      </QueryClientProvider>,
    );
    try {
      await expect.element(page.getByRole("alertdialog")).not.toBeInTheDocument();
      request?.({ requestId: "q1", presentation: "in-app" });
      await expect
        .element(page.getByRole("alertdialog", { name: title }), { timeout: 5000 })
        .toBeVisible();
      expect(reply).toHaveBeenCalledWith({
        requestId: "q1",
        phase: "ready",
        runningCount: 0,
        chats: [],
      });
      expect(reply).not.toHaveBeenCalledWith(
        expect.objectContaining({ phase: "decision", allow: true }),
      );
      await expect.element(page.getByRole("checkbox")).not.toBeInTheDocument();
      await userEvent.keyboard("{Escape}");
      expect(reply).toHaveBeenCalledWith({ requestId: "q1", phase: "decision", allow: false });

      request?.({ requestId: "q2", presentation: "in-app" });
      await expect
        .element(page.getByRole("alertdialog", { name: title }), { timeout: 5000 })
        .toBeVisible();
      await page.getByRole("button", { name: quit, exact: true }).click();
      expect(reply).toHaveBeenCalledWith({ requestId: "q2", phase: "decision", allow: true });
    } finally {
      await screen.unmount();
    }
  },
);

it("routes update refusal through actual dirty editor state without invoking ordinary quit or saving a buffer", async () => {
  let updateRequest!: (request: LinxUpdateWindowMaintenanceRequest) => void;
  let quitRequest!: (request: DesktopQuitConfirmationRequest) => void;
  const updateReply = vi.fn();
  const quitReply = vi.fn();
  const { writeFile } = nativeIo.projects;
  const interrupt = nativeIo.orchestration.dispatchCommand;
  vi.stubGlobal("desktopBridge", {
    updateWindowMaintenance: {
      onRequest: (listener) => {
        updateRequest = listener;
        return () => {};
      },
      reply: updateReply,
    },
    onQuitConfirmationRequest: (listener) => {
      quitRequest = listener;
      return () => {};
    },
    replyQuitConfirmation: quitReply,
  } satisfies QuitBridge);
  useStore.setState({
    threadsHydrated: true,
    sidebarThreadSummaryById: {},
    threadSessionById: {},
    threadShellById: {},
  });
  useComposerDraftStore
    .getState()
    .setPrompt(ThreadId.makeUnsafe("quit-update-coordination"), "durable unsent prompt");
  persistAppStateNow();
  (
    useComposerDraftStore.persist.getOptions()
      .storage as DeferredPersistStorage<PersistedComposerDraftStoreState>
  ).flush();
  await vi.waitFor(() => expect(composerPersistenceOperationCount()).toBe(0));
  const client = new QueryClient();
  const session = getWorkspaceEditorSession(client, "/update-fixture", "draft.ts");
  const unsubscribe = session.subscribe(() => {});
  session.load({
    relativePath: "draft.ts",
    contents: "original",
    version: "sha256:original",
    encoding: "utf8",
    lineEnding: "lf",
    truncated: false,
  });
  session.pause();
  session.change("unsaved edit");
  const screen = await render(
    <QueryClientProvider client={client}>
      <RunningChatsQuitCoordinator />
    </QueryClientProvider>,
  );
  try {
    updateRequest({
      schemaVersion: 1,
      action: "prepare",
      attemptId: "12345678-1234-4234-8234-123456789012",
      probeId: "22345678-1234-4234-8234-123456789012",
      backendStopped: false,
      manifestDigest: "a".repeat(64),
    });
    expect(updateReply).toHaveBeenLastCalledWith(
      expect.objectContaining({ ready: false, unsavedEditors: expect.any(Number) }),
    );
    expect(updateReply.mock.lastCall?.[0].unsavedEditors).toBeGreaterThan(0);
    await expect.element(page.getByRole("alertdialog")).not.toBeInTheDocument();
    expect(writeFile).not.toHaveBeenCalled();
    expect(interrupt).not.toHaveBeenCalled();
    expect(quitReply).not.toHaveBeenCalled();
    expect(document.body.inert).toBe(false);
    quitRequest({ requestId: "ordinary-after-update", presentation: "in-app" });
    await expect.element(page.getByRole("alertdialog")).toBeVisible();
    await userEvent.keyboard("{Escape}");
    expect(quitReply).toHaveBeenCalledWith({
      requestId: "ordinary-after-update",
      phase: "decision",
      allow: false,
    });
  } finally {
    await screen.unmount();
    session.change("original");
    unsubscribe();
    client.clear();
  }
});
