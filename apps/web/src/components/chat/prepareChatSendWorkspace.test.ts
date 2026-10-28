import { ProjectId, ThreadId } from "@synara/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useComposerDraftStore } from "../../composerDraftStore";
import { resetComposerDraftStore } from "../../composerDraftStoreTestFixtures";
import { useStore } from "../../store";
import type { Project, Thread } from "../../types";
import { prepareChatSendWorkspace } from "./prepareChatSendWorkspace";

describe("prepareChatSendWorkspace standalone draft recovery", () => {
  beforeEach(() => {
    resetComposerDraftStore();
    useStore.setState({ projects: [] });
  });

  it("preserves the recovered project's primary draft for an unmapped source draft", async () => {
    const homeProjectId = ProjectId.makeUnsafe("project-home-container");
    const recoveredProjectId = ProjectId.makeUnsafe("project-recovered");
    const sourceThreadId = ThreadId.makeUnsafe("thread-expert-standalone");
    const existingThreadId = ThreadId.makeUnsafe("thread-project-primary");
    const store = useComposerDraftStore.getState();
    store.registerDraftThread(sourceThreadId, { projectId: homeProjectId });
    store.setProjectDraftThreadId(recoveredProjectId, existingThreadId);
    store.setPrompt(existingThreadId, "keep the recovered project's draft");

    const clearProjectDraftThreadId = vi.fn(store.clearProjectDraftThreadId);
    const setDraftThreadContext = store.setDraftThreadContext;
    const syncServerShellSnapshot = vi.fn();
    const recoveredProject = {
      id: recoveredProjectId,
      kind: "project",
      workspaceRoot: "/workspace/recovered",
      scripts: [],
      defaultModelSelection: null,
    };
    const api = {
      orchestration: {
        dispatchCommand: vi.fn(async () => {
          throw new Error(
            "Orchestration command invariant failed (project.create): Project 'project-recovered' already uses workspace root '/workspace/recovered'",
          );
        }),
        getShellSnapshot: vi.fn(async () => ({ projects: [recoveredProject] })),
      },
    };

    const workspace = await prepareChatSendWorkspace({
      activeThread: {
        id: sourceThreadId,
        branch: null,
        worktreePath: null,
        workingDirectory: null,
        associatedWorktreePath: null,
        associatedWorktreeBranch: null,
        associatedWorktreeRef: null,
      } as unknown as Thread,
      isServerThread: false,
      hasNativeUserMessages: false,
      composerImagesForSend: [],
      trimmedPromptForSend: "start the expert task",
      composerFilesForSend: [],
      composerAssistantSelectionsForSend: [],
      composerBrowserAnnotationsForSend: [],
      sendableComposerTerminalContexts: [],
      composerFileCommentsForSend: [],
      sendableComposerPastedTexts: [],
      selectedModelSelectionForSend: { provider: "codex", model: "gpt-5.4" },
      selectedModelForSend: "gpt-5.4",
      activeProject: {
        id: homeProjectId,
        kind: "chat",
        name: "Home chat",
        remoteName: "Home chat",
        folderName: "Home chat",
        localName: null,
        cwd: "/home/chat",
        defaultModelSelection: null,
        expanded: true,
        scripts: [],
      } satisfies Project,
      chatWorkspaceRoot: null,
      isHomeChatContainer: true,
      isGroupContainer: false,
      resolvedThreadWorktreePath: "/workspace/recovered",
      isContainerLandingProject: true,
      runtimeModeForSend: "approval-required",
      envModeForSend: "local",
      resolvedThreadWorkingDirectory: null,
      currentActiveGitBranch: null,
      api: api as never,
      syncServerShellSnapshot,
      clearProjectDraftThreadId,
      setDraftThreadContext,
      activeRootBranch: null,
      gitBranchSourceCwd: null,
      setStoreThreadError: vi.fn(),
      queryClient: { fetchQuery: vi.fn() } as never,
    });

    expect(workspace).toMatchObject({ targetProjectIdForSend: recoveredProjectId });
    expect(clearProjectDraftThreadId).not.toHaveBeenCalled();
    const updated = useComposerDraftStore.getState();
    expect(updated.getDraftThread(sourceThreadId)?.projectId).toBe(recoveredProjectId);
    expect(updated.getDraftThreadByProjectId(recoveredProjectId)?.threadId).toBe(existingThreadId);
    expect(updated.draftsByThreadId[existingThreadId]?.prompt).toBe(
      "keep the recovered project's draft",
    );
    expect(Object.values(updated.projectDraftThreadIdByProjectId).includes(sourceThreadId)).toBe(
      false,
    );
  });
});
