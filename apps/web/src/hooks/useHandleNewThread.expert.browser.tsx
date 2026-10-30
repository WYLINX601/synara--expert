import { ProjectId, ThreadId } from "@synara/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "vitest-browser-react";

import { useComposerDraftStore } from "../composerDraftStore";
import { resetComposerDraftStore } from "../composerDraftStoreTestFixtures";
import { useStore } from "../store";
import type { Project } from "../types";
import { useHandleNewThread } from "./useHandleNewThread";

const hookMocks = vi.hoisted(() => {
  const router = { state: { location: { pathname: "/home" } } };
  const navigate = vi.fn(async (input: { params: { threadId: string } }) => {
    router.state.location.pathname = `/${input.params.threadId}`;
  });
  return {
    applyGroupWorkerRoutingDefaults: vi.fn(),
    dispatchCommand: vi.fn(),
    getProviderInstanceOptions: vi.fn(() => []),
    hasReconciledServerProviderStatuses: vi.fn(() => false),
    navigate,
    openChatThreadPage: vi.fn(),
    openTerminalThreadPage: vi.fn(),
    clearTerminalState: vi.fn(),
    prefetchModelsForNewThread: vi.fn(),
    providerStatuses: [] as unknown[],
    resolveGroupContainerThreadDefaults: vi.fn<() => Promise<null | { modelSelection: unknown }>>(
      async () => null,
    ),
    router,
    clearTemporaryThread: vi.fn(),
    markTemporaryThread: vi.fn(),
    useProjectEnvironmentStore: {
      getState: () => ({ envModeByProjectId: {} }),
    },
    queryClient: {},
  };
});

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useNavigate: () => hookMocks.navigate,
  useRouter: () => hookMocks.router,
}));

vi.mock("@tanstack/react-query", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-query")>()),
  useQuery: () => ({ data: null }),
  useQueryClient: () => hookMocks.queryClient,
}));

vi.mock("../appSettings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../appSettings")>();
  return {
    ...actual,
    getProviderInstanceOptions: hookMocks.getProviderInstanceOptions,
    resolveSelectableProviderInstanceId: (provider: string) => provider,
    useAppSettings: () => ({
      settings: {
        defaultThreadEnvMode: "local",
        defaultProvider: "codex",
        hiddenProviders: [],
        providerOrder: ["codex"],
      },
      serverSettings: null,
    }),
  };
});

vi.mock("../lib/providerModelPrefetch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/providerModelPrefetch")>()),
  prefetchModelsForNewThread: hookMocks.prefetchModelsForNewThread,
}));

vi.mock("../lib/composerSendOwnership", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/composerSendOwnership")>()),
  hasActiveComposerSend: () => false,
}));

vi.mock("./useProviderStatusesForLocalConfig", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./useProviderStatusesForLocalConfig")>()),
  useProviderStatusesForLocalConfig: () => hookMocks.providerStatuses,
}));

vi.mock("../lib/serverReactQuery", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/serverReactQuery")>()),
  hasReconciledServerProviderStatuses: hookMocks.hasReconciledServerProviderStatuses,
  serverConfigQueryOptions: () => ({ queryKey: ["server-config"] }),
}));

vi.mock("../lib/groupWorkerRouting", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/groupWorkerRouting")>()),
  applyGroupWorkerRoutingDefaults: hookMocks.applyGroupWorkerRoutingDefaults,
  resolveGroupContainerThreadDefaults: hookMocks.resolveGroupContainerThreadDefaults,
}));

vi.mock("../lib/providerAvailability", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/providerAvailability")>()),
  findProviderStatus: vi.fn(),
  isProviderUsable: vi.fn(() => true),
  resolveAvailableProviderPreference: vi.fn(() => "codex"),
}));

vi.mock("../nativeApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../nativeApi")>()),
  readNativeApi: () => ({ orchestration: { dispatchCommand: hookMocks.dispatchCommand } }),
}));

vi.mock("../focusedChatContext", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../focusedChatContext")>()),
  useFocusedChatContext: () => ({
    activeDraftThread: null,
    activeProjectId: null,
    activeThread: null,
    focusedThreadId: null,
    routeThreadId: null,
  }),
}));

vi.mock("../projectEnvironmentStore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../projectEnvironmentStore")>()),
  useProjectEnvironmentStore: hookMocks.useProjectEnvironmentStore,
}));

vi.mock("../temporaryThreadStore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../temporaryThreadStore")>()),
  useTemporaryThreadStore: (selector: (state: unknown) => unknown) =>
    selector({
      markTemporaryThread: hookMocks.markTemporaryThread,
      clearTemporaryThread: hookMocks.clearTemporaryThread,
    }),
}));

vi.mock("../terminalStateStore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../terminalStateStore")>()),
  useTerminalStateStore: (selector: (state: unknown) => unknown) =>
    selector({
      openChatThreadPage: hookMocks.openChatThreadPage,
      openTerminalThreadPage: hookMocks.openTerminalThreadPage,
      clearTerminalState: hookMocks.clearTerminalState,
    }),
}));

function makeProject(id: ProjectId, kind: Project["kind"] = "project"): Project {
  return {
    id,
    kind,
    name: `Project ${id}`,
    remoteName: `Project ${id}`,
    folderName: `Project ${id}`,
    localName: null,
    cwd: `/workspace/${id}`,
    defaultModelSelection: null,
    expanded: true,
    scripts: [],
  };
}

function resetHookHarness(project: Project): void {
  resetComposerDraftStore();
  useStore.setState({ projects: [project], threadsHydrated: true });
  hookMocks.router.state.location.pathname = "/home";
  hookMocks.navigate.mockClear();
  hookMocks.dispatchCommand.mockClear();
  hookMocks.openChatThreadPage.mockClear();
  hookMocks.openTerminalThreadPage.mockClear();
  hookMocks.clearTerminalState.mockClear();
  hookMocks.applyGroupWorkerRoutingDefaults.mockClear();
  hookMocks.prefetchModelsForNewThread.mockClear();
  hookMocks.markTemporaryThread.mockClear();
  hookMocks.clearTemporaryThread.mockClear();
  hookMocks.resolveGroupContainerThreadDefaults.mockReset().mockResolvedValue(null);
}

describe("useHandleNewThread Expert standalone bootstrap", () => {
  beforeEach(() => {
    hookMocks.providerStatuses = [];
  });

  it("leaves the primary draft text, Expert and model intact while creating an unclaimed Expert draft", async () => {
    const projectId = ProjectId.makeUnsafe("expert-standalone-project");
    const project = makeProject(projectId);
    resetHookHarness(project);

    const primaryThreadId = ThreadId.makeUnsafe("expert-primary-draft");
    const composerStore = useComposerDraftStore.getState();
    composerStore.setProjectDraftThreadId(projectId, primaryThreadId, {
      expertId: "expert-existing",
    });
    composerStore.setPrompt(primaryThreadId, "keep my existing unsent message");
    composerStore.setModelSelectionAndSticky(primaryThreadId, {
      provider: "codex",
      model: "gpt-5.4",
      options: { reasoningEffort: "high" },
    });
    const beforeComposer = useComposerDraftStore.getState().draftsByThreadId[primaryThreadId]!;

    const hook = await renderHook(() => useHandleNewThread());
    try {
      const createdThreadId = await hook.result.current.handleNewThread(projectId, {
        standalone: true,
        expertId: "expert-new",
      });

      expect(createdThreadId).toBeTruthy();
      expect(createdThreadId).not.toBe(primaryThreadId);
      const after = useComposerDraftStore.getState();
      expect(after.getDraftThreadByProjectId(projectId)?.threadId).toBe(primaryThreadId);
      expect(after.getDraftThread(primaryThreadId)?.expertId).toBe("expert-existing");
      expect(after.draftsByThreadId[primaryThreadId]?.prompt).toBe(
        "keep my existing unsent message",
      );
      expect(after.draftsByThreadId[primaryThreadId]?.activeProvider).toBe(
        beforeComposer.activeProvider,
      );
      expect(after.draftsByThreadId[primaryThreadId]?.modelSelectionByProvider).toEqual(
        beforeComposer.modelSelectionByProvider,
      );
      expect(after.getDraftThread(createdThreadId!)?.expertId).toBe("expert-new");
      expect(after.draftsByThreadId[createdThreadId!]?.prompt ?? "").toBe("");
      expect(hookMocks.navigate).toHaveBeenCalledOnce();
      expect(hookMocks.dispatchCommand).not.toHaveBeenCalled();
    } finally {
      await hook.unmount();
    }
  });

  it("keeps a standalone draft when only its Expert metadata changes before navigation is superseded", async () => {
    const projectId = ProjectId.makeUnsafe("expert-edited-draft-project");
    resetHookHarness(makeProject(projectId));

    let resolveNavigation!: () => void;
    hookMocks.navigate.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveNavigation = () => resolve();
        }),
    );

    const hook = await renderHook(() => useHandleNewThread());
    try {
      const pendingCreation = hook.result.current.handleNewThread(projectId, {
        standalone: true,
        expertId: "expert-at-stage",
      });
      await expect.poll(() => hookMocks.navigate.mock.calls.length).toBe(1);

      const threadId = ThreadId.makeUnsafe(hookMocks.navigate.mock.calls[0]![0].params.threadId);
      const store = useComposerDraftStore.getState();
      const stagedComposer = store.draftsByThreadId[threadId];
      expect(store.getDraftThread(threadId)?.expertId).toBe("expert-at-stage");

      store.setDraftThreadContext(threadId, { expertId: "expert-edited-after-stage" });
      expect(useComposerDraftStore.getState().draftsByThreadId[threadId]).toBe(stagedComposer);

      hookMocks.router.state.location.pathname = "/superseding-route";
      resolveNavigation();
      await expect(pendingCreation).resolves.toBeNull();

      const after = useComposerDraftStore.getState();
      expect(after.getDraftThread(threadId)?.expertId).toBe("expert-edited-after-stage");
      expect(after.draftsByThreadId[threadId]).toBe(stagedComposer);
    } finally {
      await hook.unmount();
    }
  });

  it("cleans up an untouched empty standalone draft when navigation is superseded", async () => {
    const projectId = ProjectId.makeUnsafe("expert-untouched-draft-project");
    resetHookHarness(makeProject(projectId));

    let resolveNavigation!: () => void;
    hookMocks.navigate.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveNavigation = () => resolve();
        }),
    );

    const hook = await renderHook(() => useHandleNewThread());
    try {
      const pendingCreation = hook.result.current.handleNewThread(projectId, {
        standalone: true,
        expertId: "expert-untouched",
      });
      await expect.poll(() => hookMocks.navigate.mock.calls.length).toBe(1);

      const threadId = ThreadId.makeUnsafe(hookMocks.navigate.mock.calls[0]![0].params.threadId);
      expect(useComposerDraftStore.getState().getDraftThread(threadId)).not.toBeNull();
      expect(useComposerDraftStore.getState().draftsByThreadId[threadId]?.prompt ?? "").toBe("");

      hookMocks.router.state.location.pathname = "/superseding-route";
      resolveNavigation();
      await expect(pendingCreation).resolves.toBeNull();

      const after = useComposerDraftStore.getState();
      expect(after.getDraftThread(threadId)).toBeNull();
      expect(after.draftsByThreadId[threadId]).toBeUndefined();
    } finally {
      await hook.unmount();
    }
  });

  it("does not register or navigate when the caller becomes stale during group-default preparation", async () => {
    const projectId = ProjectId.makeUnsafe("expert-stale-group-project");
    const project = makeProject(projectId, "group");
    resetHookHarness(project);

    const primaryThreadId = ThreadId.makeUnsafe("expert-stale-primary");
    const store = useComposerDraftStore.getState();
    store.setProjectDraftThreadId(projectId, primaryThreadId, { expertId: "expert-existing" });
    store.setPrompt(primaryThreadId, "preserve this group draft");

    let resolveGroupDefaults!: (value: null) => void;
    const pendingDefaults = new Promise<null>((resolve) => {
      resolveGroupDefaults = resolve;
    });
    hookMocks.resolveGroupContainerThreadDefaults.mockReturnValueOnce(pendingDefaults);

    let isCurrent = true;
    const hook = await renderHook(() => useHandleNewThread());
    try {
      const pendingCreation = hook.result.current.handleNewThread(
        projectId,
        { standalone: true, expertId: "expert-stale" },
        { isCurrent: () => isCurrent },
      );
      await expect.poll(() => hookMocks.resolveGroupContainerThreadDefaults).toHaveBeenCalledOnce();

      isCurrent = false;
      resolveGroupDefaults(null);
      await expect(pendingCreation).resolves.toBeNull();

      const after = useComposerDraftStore.getState();
      expect(Object.keys(after.draftThreadsByThreadId)).toEqual([primaryThreadId]);
      expect(after.getDraftThreadByProjectId(projectId)?.threadId).toBe(primaryThreadId);
      expect(after.draftsByThreadId[primaryThreadId]?.prompt).toBe("preserve this group draft");
      expect(hookMocks.navigate).not.toHaveBeenCalled();
      expect(hookMocks.openChatThreadPage).not.toHaveBeenCalled();
      expect(hookMocks.dispatchCommand).not.toHaveBeenCalled();
    } finally {
      await hook.unmount();
    }
  });
});
