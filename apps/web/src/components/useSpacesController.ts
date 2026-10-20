// FILE: useSpacesController.ts
// Purpose: All Space selection, editing, deletion, and assignment behavior behind the sidebar.
// Layer: Sidebar controller hook
// Why: Sidebar.tsx is the largest component in the app; the Spaces feature is a
//      self-contained unit of handlers, dialog state, and sync effects. One seam here
//      (inputs in, handlers out) keeps it reviewable instead of interleaved through an
//      8k-line component.

import {
  type ContextApi,
  type ContextCommandResult,
  type ProjectAgentSummary,
  type ProjectId,
  type SpaceContextSaveInput,
  type SpaceContextSettings,
  type SpaceId,
  type ThreadId,
} from "@synara/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { startTransition, useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { SidebarThreadSortOrder } from "../appSettings";
import {
  DEFAULT_SPACE_ICON,
  isVoidSpaceIconName,
  spaceKey,
  toSpaceIconName,
} from "../lib/spaceGrouping";
import { resolveSpaceSelectionTarget } from "../lib/spaceNavigation";
import {
  createSpace,
  deleteSpace,
  isOrdinarySpaceProject,
  moveProjectToSpace,
  moveProjectsToSpace,
  reorderSpaces,
  updateSpace,
} from "../lib/spaces";
import { readNativeApi } from "../nativeApi";
import {
  contextApiQueryIdentity,
  readContextClient,
  useContextClient,
} from "../workbench/host/contextClient";
import { useSpacesUiStore } from "../spacesUiStore";
import { useStore } from "../store";
import type { Project, SidebarThreadSummary, Space } from "../types";
import { newCommandId } from "../lib/utils";
import { useVoidSpaceStore } from "../voidSpaceStore";
import { useWorkspacePathsStore } from "../workspacePathsStore";
import { sortThreadsForSidebar } from "./Sidebar.logic";
import type { SpaceEditorMode, SpaceEditorValue } from "./SpaceEditorDialog";
import type { SpaceContextFieldsDraft } from "./SpaceContextFieldsEditor";
import { useExpertDraftGuard } from "./settings/useExpertDraftGuard";
import { useRouteSpaceSync } from "./useRouteSpaceSync";
import { toastManager } from "./ui/toast";

type SpaceEditorState =
  | { mode: "create"; projectIdAfterCreate: ProjectId | null }
  | { mode: "edit"; spaceId: SpaceId }
  // Void has no row to update, so its edit ends in a local preference rather than a command.
  | { mode: "void" };

/**
 * Whether the server's space order already equals the one we applied optimistically.
 *
 * Module scope because the caller checks this inside a `try`, and React Compiler cannot lower a
 * logical expression there — inlining it costs the whole controller its memoization.
 */
function spaceOrderMatches(
  confirmed: ReadonlyArray<SpaceId>,
  expected: ReadonlyArray<SpaceId>,
): boolean {
  return (
    confirmed.length === expected.length && confirmed.every((id, index) => id === expected[index])
  );
}

export function useSpacesController(input: {
  /** Ordinary (space-assignable) projects; computed by Sidebar because its own memos need it too. */
  ordinarySpaceProjects: readonly Project[];
  /** Hub containers are independently filed in Spaces, while their workers run in Projects. */
  hubProjects: readonly Project[];
  summariesByProjectId: ReadonlyMap<
    ProjectId,
    Pick<ProjectAgentSummary, "coordinatorThreadId" | "memberThreadIds">
  >;
  /** The collaboration owner for the routed thread, which can differ from its execution Project. */
  routeSpaceProject: Project | null;
  projectById: ReadonlyMap<ProjectId, Project>;
  sidebarThreads: readonly SidebarThreadSummary[];
  sidebarThreadSortOrder: SidebarThreadSortOrder;
  sidebarThreadAttentionFirst: boolean;
  routeThreadId: ThreadId | null;
  routeProjectId: ProjectId | null;
  isOnKanban: boolean;
  activeRouteProject: Project | null;
  activeRouteProjectId: ProjectId | null;
  activateThreadFromSidebarIntent: (threadId: ThreadId) => void;
  /** Space moves are offered from the project context menu; the menu closes on action. */
  onCloseProjectContextMenu: () => void;
}) {
  const {
    activateThreadFromSidebarIntent,
    activeRouteProject,
    activeRouteProjectId,
    isOnKanban,
    onCloseProjectContextMenu,
    ordinarySpaceProjects,
    projectById,
    routeProjectId,
    routeThreadId,
    sidebarThreadAttentionFirst,
    sidebarThreadSortOrder,
    sidebarThreads,
    hubProjects,
    summariesByProjectId,
    routeSpaceProject: activeRouteSpaceProject,
  } = input;

  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const contextClient = useContextClient();
  const spaces = useStore((store) => store.spaces);
  const requestedEditorSpaceId = useSpacesUiStore((store) => store.requestedEditorSpaceId);
  useEffect(() => {
    if (requestedEditorSpaceId === null) return;
    if (spaces.some((space) => space.id === requestedEditorSpaceId)) {
      setSpaceEditorState({ mode: "edit", spaceId: requestedEditorSpaceId });
    }
    useSpacesUiStore.getState().requestSpaceEditor(null);
  }, [requestedEditorSpaceId, spaces]);
  const reorderSpacesLocally = useStore((store) => store.reorderSpacesLocally);
  const threadsHydrated = useStore((store) => store.threadsHydrated);
  const shellSnapshotSequence = useStore((store) => store.shellSnapshotSequence ?? 0);
  const activeSpaceId = useSpacesUiStore((store) => store.activeSpaceId);
  const setActiveSpaceId = useSpacesUiStore((store) => store.setActiveSpaceId);
  const setOptimisticActiveSpaceId = useSpacesUiStore((store) => store.setOptimisticActiveSpaceId);
  const rememberSpaceThread = useSpacesUiStore((store) => store.rememberThread);
  const rememberSpaceProject = useSpacesUiStore((store) => store.rememberProject);
  const getLastSpaceThreadId = useSpacesUiStore((store) => store.getLastThreadId);
  const getLastSpaceProjectId = useSpacesUiStore((store) => store.getLastProjectId);
  const reconcileSpacesUi = useSpacesUiStore((store) => store.reconcile);
  const voidSpace = useVoidSpaceStore((store) => store.voidSpace);
  const setVoidSpace = useVoidSpaceStore((store) => store.setVoidSpace);
  const resetVoidSpace = useVoidSpaceStore((store) => store.resetVoidSpace);
  const homeDir = useWorkspacePathsStore((store) => store.homeDir);
  const chatWorkspaceRoot = useWorkspacePathsStore((store) => store.chatWorkspaceRoot);
  const studioWorkspaceRoot = useWorkspacePathsStore((store) => store.studioWorkspaceRoot);
  const groupsWorkspaceRoot = useWorkspacePathsStore((store) => store.groupsWorkspaceRoot);
  const workspacePaths = useMemo(
    () => ({ homeDir, chatWorkspaceRoot, studioWorkspaceRoot, groupsWorkspaceRoot }),
    [chatWorkspaceRoot, groupsWorkspaceRoot, homeDir, studioWorkspaceRoot],
  );

  const routeSpaceProject =
    isOnKanban && routeProjectId
      ? (projectById.get(routeProjectId) ?? null)
      : activeRouteSpaceProject;
  const routeSpaceProjectIdCandidate = routeSpaceProject?.id ?? null;
  const routeSpaceProjectBelongsToSpace =
    routeSpaceProjectIdCandidate !== null &&
    (ordinarySpaceProjects.some((project) => project.id === routeSpaceProjectIdCandidate) ||
      hubProjects.some((project) => project.id === routeSpaceProjectIdCandidate));
  const routeSpaceContext =
    routeSpaceProject && routeSpaceProjectBelongsToSpace
      ? { projectId: routeSpaceProject.id, spaceId: routeSpaceProject.spaceId ?? null }
      : null;
  const routeSpaceProjectId = routeSpaceContext?.projectId ?? null;
  const routeSpaceId = routeSpaceContext ? routeSpaceContext.spaceId : undefined;

  const [spaceEditorState, setSpaceEditorState] = useState<SpaceEditorState | null>(null);
  const editingSpaceId = spaceEditorState?.mode === "edit" ? spaceEditorState.spaceId : null;
  const contextApi = contextClient.api;
  const contextIdentity = contextApiQueryIdentity(contextApi);
  const spaceContextQuery = useQuery({
    queryKey: ["context", "space", contextIdentity, contextClient.generation, editingSpaceId],
    enabled: Boolean(editingSpaceId && contextApi && contextClient.available),
    queryFn: async () => {
      if (!editingSpaceId || !contextApi) throw new Error("Space context is unavailable.");
      const generation = contextClient.generation;
      const saved = await contextApi.getSpace({ spaceId: editingSpaceId });
      const current = readContextClient();
      if (!current.available || current.api !== contextApi || current.generation !== generation)
        throw new Error("The Context connection changed before confirmation.");
      return saved;
    },
    staleTime: 0,
  });
  const [spaceContextBase, setSpaceContextBase] = useState<SpaceContextSettings | null>(null);
  const [spaceContextDraft, setSpaceContextDraft] = useState<SpaceContextFieldsDraft>({
    directionGoal: "",
    sharedInstructions: "",
  });
  const [spaceContextConflict, setSpaceContextConflict] = useState<SpaceContextSettings | null>(
    null,
  );
  const [spaceContextError, setSpaceContextError] = useState<string | null>(null);
  const [spaceContextSaving, setSpaceContextSaving] = useState(false);
  const [spaceContextUncertain, setSpaceContextUncertain] = useState(false);
  const [spaceEditorValueDraft, setSpaceEditorValueDraft] = useState<SpaceEditorValue | null>(null);
  const [spaceEditorResetValue, setSpaceEditorResetValue] = useState<
    SpaceEditorValue | undefined
  >();
  const [spaceEditorResetVersion, setSpaceEditorResetVersion] = useState(0);
  const initializedSpaceContextIdRef = useRef<SpaceId | null>(null);
  const spaceSaveAttemptRef = useRef<SpaceContextSaveInput | null>(null);

  const [spaceContextOwner, setSpaceContextOwner] = useState<ContextApi | null>(null);
  const savedCloseRef = useRef(false);
  const spaceContextPending = Boolean(
    spaceContextBase &&
    (spaceContextSaving ||
      spaceContextUncertain ||
      spaceContextDraft.directionGoal !== spaceContextBase.directionGoal ||
      spaceContextDraft.sharedInstructions !== spaceContextBase.sharedInstructions ||
      (spaceEditorValueDraft &&
        (spaceEditorValueDraft.name !== spaceContextBase.name ||
          spaceEditorValueDraft.icon !== spaceContextBase.icon))),
  );
  const spaceContextDetached = Boolean(
    spaceContextBase &&
    (spaceContextOwner !== contextApi ||
      (spaceContextQuery.data &&
        spaceContextQuery.data.dataInstanceId !== spaceContextBase.dataInstanceId)),
  );
  const spaceContextAvailable =
    contextClient.available &&
    spaceContextQuery.isSuccess &&
    !spaceContextDetached &&
    spaceContextOwner === contextApi;

  useEffect(() => {
    if (!editingSpaceId) {
      initializedSpaceContextIdRef.current = null;
      spaceSaveAttemptRef.current = null;
      setSpaceContextBase(null);
      setSpaceContextOwner(null);
      setSpaceContextSaving(false);
      setSpaceContextConflict(null);
      setSpaceContextError(null);
      setSpaceContextUncertain(false);
      setSpaceEditorResetValue(undefined);
      setSpaceEditorValueDraft(null);
      return;
    }
    const confirmed = spaceContextQuery.data;
    if (!confirmed || confirmed.spaceId !== editingSpaceId) return;
    if (
      initializedSpaceContextIdRef.current !== editingSpaceId ||
      spaceContextBase?.dataInstanceId !== confirmed.dataInstanceId ||
      spaceContextOwner !== contextApi
    ) {
      if (initializedSpaceContextIdRef.current === editingSpaceId && spaceContextPending) {
        setSpaceContextConflict(confirmed);
        setSpaceContextError(
          "The Context owner changed. Use saved values to discard the preserved draft.",
        );
        return;
      }
      initializedSpaceContextIdRef.current = editingSpaceId;
      setSpaceContextOwner(contextApi);
      const icon = isVoidSpaceIconName(confirmed.icon) ? confirmed.icon : DEFAULT_SPACE_ICON;
      setSpaceEditorResetValue({ name: confirmed.name, icon });
      setSpaceEditorValueDraft({ name: confirmed.name, icon });
      setSpaceEditorResetVersion((value) => value + 1);
      setSpaceContextBase(confirmed);
      setSpaceContextDraft({
        directionGoal: confirmed.directionGoal,
        sharedInstructions: confirmed.sharedInstructions,
      });
      setSpaceContextConflict(null);
      setSpaceContextError(null);
      setSpaceContextUncertain(false);
      spaceSaveAttemptRef.current = null;
      return;
    }
    if (
      spaceContextBase?.spaceId === editingSpaceId &&
      confirmed.revision > spaceContextBase.revision &&
      spaceContextConflict?.revision !== confirmed.revision
    ) {
      setSpaceContextConflict(confirmed);
      setSpaceContextError(
        "Space context changed elsewhere. Compare the saved values before saving.",
      );
    }
  }, [
    editingSpaceId,
    spaceContextBase,
    spaceContextConflict,
    spaceContextQuery.data,
    spaceContextPending,
    spaceContextOwner,
    contextApi,
  ]);
  const ownsSpaceContext = contextClient.capability !== "unsupported" || spaceContextPending;
  const [spaceProjectPickerTargetId, setSpaceProjectPickerTargetId] = useState<SpaceId | null>(
    null,
  );

  useEffect(() => {
    if (!threadsHydrated) return;
    reconcileSpacesUi({
      activeSpaceIds: new Set(spaces.map((space) => space.id)),
      snapshotSequence: shellSnapshotSequence,
      projectSpaceById: new Map(
        ordinarySpaceProjects.map((project) => [project.id, project.spaceId ?? null] as const),
      ),
      threadProjectById: new Map(
        sidebarThreads
          .filter((thread) => thread.archivedAt == null)
          .map((thread) => [thread.id, thread.projectId] as const),
      ),
    });
  }, [
    ordinarySpaceProjects,
    reconcileSpacesUi,
    shellSnapshotSequence,
    sidebarThreads,
    spaces,
    threadsHydrated,
  ]);

  useRouteSpaceSync({
    isOnKanban,
    routeProjectId: routeSpaceProjectId,
    routeSpaceId,
    routeThreadId,
  });

  const selectSpaceForNavigation = useCallback(
    (spaceId: SpaceId | null) => {
      setActiveSpaceId(spaceId);
    },
    [setActiveSpaceId],
  );

  // Bookmark the context being left so returning to that space restores it.
  const rememberDepartingSpaceContext = useCallback(() => {
    const currentRouteSpaceProject =
      isOnKanban && routeProjectId
        ? (projectById.get(routeProjectId) ?? null)
        : activeRouteSpaceProject;
    const currentRouteSpaceProjectId = currentRouteSpaceProject?.id ?? null;
    const currentRouteProjectBelongsToSpace =
      currentRouteSpaceProjectId !== null &&
      (ordinarySpaceProjects.some((project) => project.id === currentRouteSpaceProjectId) ||
        hubProjects.some((project) => project.id === currentRouteSpaceProjectId));
    if (routeThreadId && currentRouteSpaceProject && currentRouteProjectBelongsToSpace) {
      rememberSpaceThread(currentRouteSpaceProject.spaceId ?? null, routeThreadId);
    } else if (
      isOnKanban &&
      currentRouteSpaceProject &&
      ordinarySpaceProjects.some((project) => project.id === currentRouteSpaceProject.id)
    ) {
      rememberSpaceProject(currentRouteSpaceProject.spaceId ?? null, currentRouteSpaceProject.id);
    }
  }, [
    activeRouteProject,
    activeRouteSpaceProject,
    hubProjects,
    isOnKanban,
    ordinarySpaceProjects,
    projectById,
    rememberSpaceProject,
    rememberSpaceThread,
    routeProjectId,
    routeThreadId,
    workspacePaths,
  ]);

  /**
   * Switch spaces without restoring the target space's last context. Used when the
   * caller is about to navigate itself (creating a project files it into the target
   * space and then opens its first thread) — the restore navigation would race it.
   */
  const handleSelectSpaceForIncomingProject = useCallback(
    (spaceId: SpaceId | null) => {
      // Read the live value so an async create flow can roll back a provisional
      // selection with the same callback instance it used to select it.
      if (spaceId === useSpacesUiStore.getState().activeSpaceId) return;
      rememberDepartingSpaceContext();
      selectSpaceForNavigation(spaceId);
    },
    [rememberDepartingSpaceContext, selectSpaceForNavigation],
  );

  const handleSelectSpace = useCallback(
    (spaceId: SpaceId | null) => {
      if (spaceId === activeSpaceId) return;

      rememberDepartingSpaceContext();

      selectSpaceForNavigation(spaceId);

      const target = resolveSpaceSelectionTarget({
        spaceId,
        projects: ordinarySpaceProjects,
        hubProjects,
        summariesByProjectId,
        projectById,
        threads: sidebarThreads,
        rememberedThreadId: getLastSpaceThreadId(spaceId),
        rememberedProjectId: getLastSpaceProjectId(spaceId),
        paths: workspacePaths,
        sortThreads: (threads) =>
          sortThreadsForSidebar(threads, sidebarThreadSortOrder, {
            attentionFirst: sidebarThreadAttentionFirst,
          }),
      });

      if (target.kind === "thread") {
        activateThreadFromSidebarIntent(target.threadId);
        return;
      }

      if (target.kind === "project") {
        startTransition(() => {
          void navigate({
            to: "/kanban/$projectId",
            params: { projectId: target.projectId },
          });
        });
        return;
      }

      // An empty Space still has to be entered. The landing has to say *which* Space it is
      // entering: a bare "/" restores the last remembered thread route, which belongs to the
      // Space being left, and useRouteSpaceSync would then adopt that thread's Space and undo
      // the click. On an upgraded install every project keeps `spaceId = null`, so every
      // user-created Space is empty and this is the only path a Space switch can take.
      startTransition(() => {
        void navigate({ to: "/", search: { space: spaceKey(target.spaceId) } });
      });
    },
    [
      activateThreadFromSidebarIntent,
      activeSpaceId,
      getLastSpaceProjectId,
      getLastSpaceThreadId,
      navigate,
      ordinarySpaceProjects,
      projectById,
      rememberDepartingSpaceContext,
      selectSpaceForNavigation,
      sidebarThreadAttentionFirst,
      sidebarThreadSortOrder,
      sidebarThreads,
      workspacePaths,
    ],
  );

  const handleSpaceEditorSubmit = useCallback(
    async (value: SpaceEditorValue) => {
      if (spaceEditorState?.mode === "void") {
        // Presentation only: no command, no server round trip, nothing to fail.
        setVoidSpace(value);
        return;
      }

      const api = readNativeApi();
      if (!api || !spaceEditorState) {
        throw new Error("The app server is unavailable.");
      }
      const icon = toSpaceIconName(value.icon);

      if (spaceEditorState.mode === "edit") {
        if (ownsSpaceContext) {
          if (!spaceContextAvailable || !contextApi)
            throw new Error("Context is disconnected. Reconnect before saving.");
          const currentSpaceContext = spaceContextBase;
          if (!currentSpaceContext || currentSpaceContext.spaceId !== spaceEditorState.spaceId) {
            throw new Error("Space context is still loading. Retry in a moment.");
          }
          if (spaceContextConflict) {
            throw new Error("Compare the saved context and choose which values to keep first.");
          }
          if (
            spaceContextDraft.directionGoal.length > 4_096 ||
            spaceContextDraft.sharedInstructions.length > 16_384
          ) {
            throw new Error("Space context exceeds a character limit.");
          }
          const metadataChanged =
            currentSpaceContext.name !== value.name || currentSpaceContext.icon !== icon;
          const contextChanged =
            currentSpaceContext.directionGoal !== spaceContextDraft.directionGoal ||
            currentSpaceContext.sharedInstructions !== spaceContextDraft.sharedInstructions;
          if (!metadataChanged && !contextChanged) return;

          const previousAttempt = spaceSaveAttemptRef.current;
          const attemptMatchesDraft =
            previousAttempt !== null &&
            previousAttempt.spaceId === spaceEditorState.spaceId &&
            previousAttempt.name === value.name &&
            previousAttempt.icon === icon &&
            previousAttempt.directionGoal === spaceContextDraft.directionGoal &&
            previousAttempt.sharedInstructions === spaceContextDraft.sharedInstructions;
          if (spaceContextUncertain && !attemptMatchesDraft) {
            throw new Error("Confirm the previous save before changing its fields.");
          }
          let attempt: SpaceContextSaveInput;
          if (!attemptMatchesDraft) {
            attempt = {
              commandId: newCommandId(),
              dataInstanceId: currentSpaceContext.dataInstanceId,
              spaceId: currentSpaceContext.spaceId,
              expectedRevision: currentSpaceContext.revision,
              expectedName: currentSpaceContext.name,
              expectedIcon: currentSpaceContext.icon,
              name: value.name,
              icon,
              directionGoal: spaceContextDraft.directionGoal,
              sharedInstructions: spaceContextDraft.sharedInstructions,
            };
            spaceSaveAttemptRef.current = attempt;
          } else {
            attempt = previousAttempt!;
          }

          const hostGeneration = contextClient.generation;
          const currentAttempt = () => {
            const current = readContextClient();
            return (
              spaceSaveAttemptRef.current === attempt &&
              current.api === contextApi &&
              current.generation === hostGeneration &&
              current.available
            );
          };
          const saveContextSpace = () => {
            if (!currentAttempt())
              throw new Error("Context is disconnected. Reconnect before saving.");
            return contextApi.saveSpace(attempt);
          };
          setSpaceContextSaving(true);
          setSpaceContextError(null);
          try {
            let result: ContextCommandResult;
            if (spaceContextUncertain) {
              if (!currentAttempt())
                throw new Error("The Context connection changed before confirmation.");
              result = await contextApi.getCommandResult({ commandId: attempt.commandId });
            } else {
              result = await saveContextSpace();
            }
            if (result.status === "unknown" || result.status === "pending") {
              if (!currentAttempt())
                throw new Error("The Context connection changed before confirmation.");
              result = await contextApi.getCommandResult({ commandId: attempt.commandId });
            }
            if (result.status === "unknown") {
              result = await saveContextSpace();
              if (result.status === "unknown" || result.status === "pending") {
                if (!currentAttempt())
                  throw new Error("The Context connection changed before confirmation.");
                result = await contextApi.getCommandResult({ commandId: attempt.commandId });
              }
            }
            if (!currentAttempt())
              throw new Error(
                "The Context connection or editor changed before this save completed.",
              );
            if (result.status === "saved") {
              const saved =
                result.space?.spaceId === currentSpaceContext.spaceId
                  ? result.space
                  : await contextApi.getSpace({ spaceId: currentSpaceContext.spaceId });
              if (
                saved.dataInstanceId !== currentSpaceContext.dataInstanceId ||
                saved.revision < currentSpaceContext.revision ||
                saved.name !== attempt.name ||
                saved.icon !== attempt.icon ||
                saved.directionGoal !== attempt.directionGoal ||
                saved.sharedInstructions !== attempt.sharedInstructions
              ) {
                throw new Error(
                  "The save completed but could not be confirmed with matching values.",
                );
              }
              if (!currentAttempt())
                throw new Error("The Context connection or editor changed before confirmation.");
              savedCloseRef.current = true;
              setSpaceContextBase(saved);
              setSpaceContextDraft({
                directionGoal: saved.directionGoal,
                sharedInstructions: saved.sharedInstructions,
              });
              setSpaceContextConflict(null);
              setSpaceContextError(null);
              setSpaceContextUncertain(false);
              spaceSaveAttemptRef.current = null;
              queryClient.setQueryData(
                ["context", "space", contextIdentity, contextClient.generation, saved.spaceId],
                saved,
              );
              void queryClient.invalidateQueries({ queryKey: ["context", "project"] });
              return;
            }
            if (result.status === "conflict") {
              const latest =
                result.space?.spaceId === currentSpaceContext.spaceId
                  ? result.space
                  : await contextApi.getSpace({ spaceId: currentSpaceContext.spaceId });
              if (!currentAttempt() || latest.dataInstanceId !== currentSpaceContext.dataInstanceId)
                throw new Error("The Context data instance or editor changed before confirmation.");
              setSpaceContextConflict(latest);
              setSpaceContextError(
                result.message ?? "Space context changed elsewhere. Compare the saved values.",
              );
              setSpaceContextUncertain(false);
              spaceSaveAttemptRef.current = null;
              queryClient.setQueryData(
                ["context", "space", contextIdentity, contextClient.generation, latest.spaceId],
                latest,
              );
              throw new Error("Space context changed elsewhere. Compare the saved values.");
            }
            if (result.status === "rejected") {
              spaceSaveAttemptRef.current = null;
              setSpaceContextUncertain(false);
              throw new Error(result.message ?? "The server rejected this Space context save.");
            }
            setSpaceContextUncertain(true);
            throw new Error(
              result.message ?? "The save is still being processed. Retry to confirm this command.",
            );
          } catch (error) {
            if (!currentAttempt()) {
              if (spaceSaveAttemptRef.current === attempt) setSpaceContextUncertain(true);
              throw error;
            }
            const message =
              error instanceof Error ? error.message : "Unable to save Space context.";
            setSpaceContextError(message);
            if (spaceSaveAttemptRef.current) setSpaceContextUncertain(true);
            throw error instanceof Error ? error : new Error(message);
          } finally {
            if (spaceSaveAttemptRef.current === attempt || spaceSaveAttemptRef.current === null)
              setSpaceContextSaving(false);
          }
        }
        // Only actual changes are sent, so an icon-only edit cannot collide with a
        // concurrent rename; saving with nothing changed is a plain close, not a
        // command — the server rejects no-op metadata updates.
        const currentSpace = spaces.find((space) => space.id === spaceEditorState.spaceId);
        const nextName = currentSpace?.name === value.name ? undefined : value.name;
        const nextIcon = currentSpace?.icon === icon ? undefined : icon;
        if (nextName === undefined && nextIcon === undefined) {
          return;
        }
        await updateSpace({
          api: api.orchestration,
          spaceId: spaceEditorState.spaceId,
          name: nextName,
          icon: nextIcon,
        });
        return;
      }

      const { spaceId, sequence } = await createSpace({
        api: api.orchestration,
        name: value.name,
        icon,
      });
      const projectId = spaceEditorState.projectIdAfterCreate;
      if (projectId) {
        try {
          await moveProjectToSpace({ api: api.orchestration, projectId, spaceId });
        } catch (error) {
          toastManager.add({
            type: "error",
            title: `${value.name} was created, but the project was not moved`,
            description: error instanceof Error ? error.message : "Try moving the project again.",
          });
          return;
        }

        if (
          activeRouteProjectId === projectId ||
          activeRouteSpaceProject?.id === projectId ||
          (isOnKanban && routeProjectId === projectId)
        ) {
          selectSpaceForNavigation(spaceId);
          setOptimisticActiveSpaceId(spaceId, sequence);
        }
        return;
      }

      handleSelectSpace(spaceId);
      setOptimisticActiveSpaceId(spaceId, sequence);
      setSpaceProjectPickerTargetId(spaceId);
    },
    [
      activeRouteProjectId,
      activeRouteSpaceProject,
      hubProjects,
      handleSelectSpace,
      isOnKanban,
      routeProjectId,
      selectSpaceForNavigation,
      setOptimisticActiveSpaceId,
      setVoidSpace,
      spaceEditorState,
      spaces,
      contextApi,
      contextIdentity,
      ownsSpaceContext,
      contextClient.generation,
      spaceContextAvailable,
      queryClient,
      spaceContextBase,
      spaceContextConflict,
      spaceContextDraft,
      spaceContextUncertain,
    ],
  );

  const handleDeleteSpace = useCallback(
    async (spaceId: SpaceId) => {
      const api = readNativeApi();
      const space = spaces.find((candidate) => candidate.id === spaceId);
      if (!api || !space) return;
      const projectCount = ordinarySpaceProjects.filter(
        (project) => (project.spaceId ?? null) === spaceId,
      ).length;
      const confirmed = await api.dialogs.confirm(
        projectCount > 0
          ? `Delete “${space.name}”?\n\n${projectCount} project${projectCount === 1 ? "" : "s"} will move to Void.`
          : `Delete “${space.name}”?`,
      );
      if (!confirmed) return;

      // Resolved before the `try`: React Compiler cannot lower a `??` chain inside a try block.
      const activeContextProject =
        activeRouteProject ??
        (isOnKanban && routeProjectId ? (projectById.get(routeProjectId) ?? null) : null);

      try {
        await deleteSpace({ api: api.orchestration, spaceId });
        if (activeSpaceId === spaceId) {
          selectSpaceForNavigation(null);
          if (!isOrdinarySpaceProject(activeContextProject, workspacePaths)) {
            // Same explicit landing as an empty-Space switch: we just selected Void, so the
            // restore must not reopen a thread that files into some other Space.
            void navigate({ to: "/", search: { space: spaceKey(null) } });
          }
        }
      } catch (error) {
        toastManager.add({
          type: "error",
          title: "Unable to delete space",
          description: error instanceof Error ? error.message : "Try again.",
        });
      }
    },
    [
      activeRouteProject,
      activeSpaceId,
      isOnKanban,
      navigate,
      ordinarySpaceProjects,
      projectById,
      routeProjectId,
      selectSpaceForNavigation,
      spaces,
      workspacePaths,
    ],
  );

  const handleRenameSpace = useCallback(async (space: Space, name: string) => {
    const api = readNativeApi();
    if (!api || space.name === name) return;
    try {
      await updateSpace({ api: api.orchestration, spaceId: space.id, name });
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Unable to rename space",
        description: error instanceof Error ? error.message : "Try again.",
      });
    }
  }, []);

  const handleRenameVoid = useCallback(
    (name: string) => {
      setVoidSpace({ name });
    },
    [setVoidSpace],
  );

  const handleReorderSpaces = useCallback(
    (orderedSpaceIds: ReadonlyArray<SpaceId>, movedSpaceId: SpaceId) => {
      const api = readNativeApi();
      if (!api) return;
      reorderSpacesLocally(orderedSpaceIds);
      void reorderSpaces({
        api: api.orchestration,
        movedSpaceId,
        orderedSpaceIds,
      }).catch(async (error) => {
        try {
          // A transport error can arrive after the command committed. Re-read the authoritative
          // shell instead of blindly rolling back a reorder the server may already have stored.
          const snapshot = await api.orchestration.getShellSnapshot();
          useStore.getState().syncServerShellSnapshot(snapshot);
          const confirmedSpaceIds = snapshot.spaces.map((space) => space.id);
          if (spaceOrderMatches(confirmedSpaceIds, orderedSpaceIds)) {
            return;
          }
        } catch {
          // Keep the optimistic order when authority cannot be reached; the next shell snapshot
          // will reconcile it without risking a false rollback after a successful commit.
        }
        toastManager.add({
          type: "error",
          title: "Unable to confirm space order",
          description: error instanceof Error ? error.message : "Try again.",
        });
      });
    },
    [reorderSpacesLocally],
  );

  const handleBulkMoveProjects = useCallback(
    async (projectIds: ReadonlyArray<ProjectId>, spaceId: SpaceId) => {
      const api = readNativeApi();
      if (!api) throw new Error("The app server is unavailable.");
      const result = await moveProjectsToSpace({
        api: api.orchestration,
        projectIds,
        spaceId,
      });
      return result.failedProjectIds;
    },
    [],
  );

  const handleMoveProjectToSpace = useCallback(
    async (projectId: ProjectId, spaceId: SpaceId | null) => {
      const api = readNativeApi();
      const project = projectById.get(projectId);
      if (!api || !project || (project.spaceId ?? null) === spaceId) return;
      onCloseProjectContextMenu();
      // Evaluated before the `try` (see `spaceOrderMatches`); none of these inputs can change
      // across the await anyway.
      const movesTheRoutedProject =
        activeRouteProjectId === projectId ||
        activeRouteSpaceProject?.id === projectId ||
        (isOnKanban && routeProjectId === projectId);
      try {
        await moveProjectToSpace({ api: api.orchestration, projectId, spaceId });
        if (movesTheRoutedProject) {
          selectSpaceForNavigation(spaceId);
        }
      } catch (error) {
        toastManager.add({
          type: "error",
          title: "Unable to move project",
          description: error instanceof Error ? error.message : "Try again.",
        });
      }
    },
    [
      activeRouteProjectId,
      activeRouteSpaceProject,
      isOnKanban,
      onCloseProjectContextMenu,
      projectById,
      routeProjectId,
      selectSpaceForNavigation,
    ],
  );

  const openSpaceCreator = useCallback((projectIdAfterCreate: ProjectId | null = null) => {
    savedCloseRef.current = false;
    setSpaceEditorState({ mode: "create", projectIdAfterCreate });
  }, []);
  const openSpaceEditor = useCallback((spaceId: SpaceId) => {
    savedCloseRef.current = false;
    setSpaceEditorState({ mode: "edit", spaceId });
  }, []);
  const openVoidEditor = useCallback(() => setSpaceEditorState({ mode: "void" }), []);

  const openSpaceProjectPicker = useCallback(
    (spaceId: SpaceId) => setSpaceProjectPickerTargetId(spaceId),
    [],
  );
  const closeSpaceProjectPicker = useCallback(() => setSpaceProjectPickerTargetId(null), []);

  const activeSpace: Space | null = activeSpaceId
    ? (spaces.find((space) => space.id === activeSpaceId) ?? null)
    : null;
  const editedSpace: Space | null =
    spaceEditorState?.mode === "edit"
      ? (spaces.find((space) => space.id === spaceEditorState.spaceId) ?? null)
      : null;
  const spaceProjectPickerTarget: Space | null = spaceProjectPickerTargetId
    ? (spaces.find((space) => space.id === spaceProjectPickerTargetId) ?? null)
    : null;
  const editingVoid = spaceEditorState?.mode === "void";
  /**
   * Void shares one namespace with the stored spaces: two identically named groups in the
   * same strip are indistinguishable, so whichever one is not being edited is off limits.
   */
  const spaceEditorExistingNames = [
    ...spaces.filter((space) => space.id !== editedSpace?.id).map((space) => space.name),
    ...(editingVoid ? [] : [voidSpace.name]),
  ];
  const spaceEditorInitialValue: SpaceEditorValue | null = editingVoid
    ? voidSpace
    : editedSpace
      ? { name: editedSpace.name, icon: editedSpace.icon }
      : null;

  const handleUseSavedSpaceContext = useCallback(() => {
    if (!spaceContextConflict) return;
    if (!contextClient.available || !spaceContextQuery.isSuccess) return;
    const saved = spaceContextDetached ? spaceContextQuery.data : spaceContextConflict;
    setSpaceContextOwner(contextApi);
    setSpaceContextSaving(false);
    setSpaceContextBase(saved);
    setSpaceContextDraft({
      directionGoal: saved.directionGoal,
      sharedInstructions: saved.sharedInstructions,
    });
    setSpaceContextConflict(null);
    setSpaceContextError(null);
    setSpaceContextUncertain(false);
    spaceSaveAttemptRef.current = null;
    queryClient.setQueryData(
      ["context", "space", contextIdentity, contextClient.generation, saved.spaceId],
      saved,
    );
    const icon = isVoidSpaceIconName(saved.icon) ? saved.icon : DEFAULT_SPACE_ICON;
    setSpaceEditorResetValue({ name: saved.name, icon });
    setSpaceEditorValueDraft({ name: saved.name, icon });
    setSpaceEditorResetVersion((value) => value + 1);
  }, [
    queryClient,
    contextIdentity,
    contextClient.available,
    contextClient.generation,
    contextApi,
    spaceContextConflict,
    spaceContextDetached,
    spaceContextQuery.data,
    spaceContextQuery.isSuccess,
  ]);

  const handleSpaceEditorValueChange = useCallback((value: SpaceEditorValue) => {
    setSpaceEditorValueDraft(value);
  }, []);

  const handleKeepSpaceContextDraft = useCallback(() => {
    if (!spaceContextConflict || spaceContextDetached || !spaceContextAvailable) return;
    const latest = spaceContextConflict;
    setSpaceContextBase(latest);
    setSpaceContextConflict(null);
    setSpaceContextError(null);
    setSpaceContextUncertain(false);
    spaceSaveAttemptRef.current = null;
    queryClient.setQueryData(
      ["context", "space", contextIdentity, contextClient.generation, latest.spaceId],
      latest,
    );
  }, [
    queryClient,
    contextIdentity,
    contextClient.generation,
    spaceContextConflict,
    spaceContextDetached,
    spaceContextAvailable,
  ]);

  const spaceDraftGuard = useExpertDraftGuard({
    isDirty: Boolean(editingSpaceId && spaceContextPending),
    canSave:
      spaceContextAvailable &&
      !spaceContextSaving &&
      !spaceContextUncertain &&
      !spaceContextConflict,
    saveDisabledReason: "Reconnect and resolve the Context owner before saving.",
    onSave: async () => {
      const value = spaceEditorValueDraft ?? spaceEditorInitialValue;
      if (!value) return false;
      await handleSpaceEditorSubmit(value);
      savedCloseRef.current = false;
      setSpaceEditorState(null);
      return true;
    },
    onDiscard: () => {
      savedCloseRef.current = false;
      setSpaceEditorState(null);
      spaceSaveAttemptRef.current = null;
      setSpaceContextSaving(false);
      setSpaceContextUncertain(false);
      return true;
    },
  });
  const closeSpaceEditor = useCallback(async () => {
    if (savedCloseRef.current) {
      savedCloseRef.current = false;
      setSpaceEditorState(null);
      return;
    }
    if (await spaceDraftGuard.confirmLeave()) {
      savedCloseRef.current = false;
      setSpaceEditorState(null);
    }
  }, [spaceDraftGuard.confirmLeave]);

  const spaceContextEditor =
    editingSpaceId && ownsSpaceContext
      ? {
          enabled: true,
          draft: spaceContextDraft,
          metadataDraft: spaceEditorValueDraft ?? spaceEditorResetValue ?? spaceEditorInitialValue,
          loading: spaceContextQuery.isPending && spaceContextBase === null,
          ready: spaceContextBase !== null,
          saving: spaceContextSaving,
          disabled:
            !spaceContextAvailable || !contextApi || spaceContextSaving || spaceContextUncertain,
          closeDisabled: false,
          keepDraftDisabled: !spaceContextAvailable || spaceContextDetached,
          submitDisabled:
            !spaceContextAvailable ||
            !contextApi ||
            spaceContextSaving ||
            spaceContextQuery.isPending ||
            spaceContextBase === null ||
            spaceContextConflict !== null ||
            spaceContextDraft.directionGoal.length > 4_096 ||
            spaceContextDraft.sharedInstructions.length > 16_384,
          error:
            (!contextClient.available
              ? "Context is disconnected. Reconnect before saving."
              : null) ??
            spaceContextError ??
            (spaceContextQuery.error instanceof Error
              ? spaceContextQuery.error.message
              : spaceContextQuery.error
                ? "Unable to load Space context."
                : null),
          conflict: spaceContextConflict,
          resetValue: spaceEditorResetValue,
          resetVersion: spaceEditorResetVersion,
          onChange: setSpaceContextDraft,
          onValueChange: handleSpaceEditorValueChange,
          onUseSaved: handleUseSavedSpaceContext,
          onKeepDraft: handleKeepSpaceContextDraft,
          onRetry: () => void spaceContextQuery.refetch(),
        }
      : null;

  return {
    activeSpace,
    spaceDraftGuardDialog: spaceDraftGuard.dialog,
    voidSpace,
    editedSpace,
    spaceEditorOpen:
      spaceEditorState?.mode === "create" ||
      editingVoid ||
      (spaceEditorState?.mode === "edit" && editedSpace !== null),
    spaceEditorMode: (spaceEditorState?.mode ?? "create") as SpaceEditorMode,
    spaceEditorInitialValue,
    spaceContextEditor,
    spaceEditorExistingNames,
    spaceProjectPickerTarget,
    openSpaceCreator,
    openSpaceEditor,
    openVoidEditor,
    closeSpaceEditor,
    openSpaceProjectPicker,
    closeSpaceProjectPicker,
    handleSelectSpace,
    handleSelectSpaceForIncomingProject,
    handleReorderSpaces,
    handleRenameSpace,
    handleRenameVoid,
    resetVoidSpace,
    handleDeleteSpace,
    handleMoveProjectToSpace,
    handleSpaceEditorSubmit,
    handleBulkMoveProjects,
  };
}
