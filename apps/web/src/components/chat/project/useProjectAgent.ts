import {
  type HubWorkItem,
  type ModelSelection,
  type ProjectActivity,
  type ProjectAgentDeleteGroupResult,
  type ProjectAgentOverview,
  type ProjectAgentStreamEvent,
  type ProjectAgentWorkerRouting,
  type ProjectDocumentHead,
  type ProjectDocumentRevision,
  type ProjectEvidence,
  type ProjectId,
  type ProjectTask,
  type ProjectThreadIndexEntry,
  type ThreadId,
} from "@synara/contracts";
import { useCallback, useEffect, useRef, useState } from "react";

import { mergeHubWorkItems } from "./hubWorkItems";
import { readNativeApi } from "~/nativeApi";
import {
  projectAgentOverviewWithConfig,
  projectAgentOverviewConfigured,
} from "./projectAgentOverview.logic";
import { useProjectAgentSummariesStore } from "./useProjectAgentSummaries";

type RequestScope = {
  readonly projectId: ProjectId | null;
  readonly enabled: boolean;
  active: boolean;
};

export function useProjectAgent(input: {
  readonly projectId: ProjectId | null;
  readonly enabled: boolean;
}) {
  const [overview, setOverview] = useState<ProjectAgentOverview | null>(null);
  const workItemsRef = useRef<{ projectId: ProjectId | null; items: readonly HubWorkItem[] }>({
    projectId: null,
    items: [],
  });
  const mergeWorkItems = useCallback((projectId: ProjectId, items: readonly HubWorkItem[]) => {
    const previous = workItemsRef.current;
    const merged = mergeHubWorkItems(previous.projectId === projectId ? previous.items : [], items);
    workItemsRef.current = { projectId, items: merged };
    return merged;
  }, []);
  const applyOverview = useCallback(
    (next: ProjectAgentOverview) => {
      setOverview({
        ...next,
        hubWorkItems: mergeWorkItems(next.projectId, next.hubWorkItems ?? []),
      });
    },
    [mergeWorkItems],
  );
  const [tasks, setTasks] = useState<ReadonlyArray<ProjectTask>>([]);
  const [activity, setActivity] = useState<ReadonlyArray<ProjectActivity>>([]);
  const [activityCursor, setActivityCursor] = useState<string | null>(null);
  const [documents, setDocuments] = useState<ReadonlyArray<ProjectDocumentHead>>([]);
  const [threads, setThreads] = useState<ReadonlyArray<ProjectThreadIndexEntry>>([]);
  const [error, setError] = useState<string | null>(null);
  // Mutations fail through `setError`, but the state value only lands on the next
  // render — callers that need the message synchronously (toasts) read the ref.
  const errorRef = useRef<string | null>(null);
  const reportError = useCallback((message: string | null) => {
    errorRef.current = message;
    setError(message);
  }, []);
  const readError = useCallback(() => errorRef.current, []);
  const [busy, setBusy] = useState(false);
  const projectIdRef = useRef(input.projectId);
  const loadGeneration = useRef(0);
  const scopeRef = useRef<RequestScope>({ ...input, active: true });
  if (
    scopeRef.current.projectId !== input.projectId ||
    scopeRef.current.enabled !== input.enabled
  ) {
    scopeRef.current = { ...input, active: true };
  }
  const isCurrentScope = useCallback(
    (scope: RequestScope) => scopeRef.current === scope && scope.active,
    [],
  );
  const loadEventsRef = useRef<ProjectAgentStreamEvent[] | null>(null);
  const threadIndexEventVersion = useRef(0);
  const mutationsRef = useRef<{ scope: RequestScope | null; count: number }>({
    scope: null,
    count: 0,
  });
  const beginMutation = useCallback(() => {
    const scope = scopeRef.current;
    if (mutationsRef.current.scope !== scope) mutationsRef.current = { scope, count: 0 };
    const pending = mutationsRef.current;
    pending.count += 1;
    setBusy(true);
    return () => {
      pending.count -= 1;
      if (isCurrentScope(scope)) setBusy(pending.count > 0);
    };
  }, [isCurrentScope]);
  // Mirrors the rendered overview's configured flag so stream events can tell a
  // first-configure transition (load the lists) from a relink (index refresh only).
  const overviewConfiguredRef = useRef(false);
  projectIdRef.current = input.projectId;
  overviewConfiguredRef.current = projectAgentOverviewConfigured(overview);

  const applyStreamEvent = useCallback(
    (event: ProjectAgentStreamEvent) => {
      const current = projectIdRef.current;
      if (!current) return;
      // Events stream for every subscribed project on the client — apply only this
      // project's events and only the slice each event actually changed.
      if (event.type === "snapshot") {
        if (event.overview.projectId === current) applyOverview(event.overview);
        return;
      }
      if (event.type === "work-item-upserted") {
        if (event.projectId === current) {
          const items = mergeWorkItems(current, [event.workItem]);
          setOverview((overview) =>
            overview?.projectId === current
              ? {
                  ...overview,
                  hubWorkItems: items,
                }
              : overview,
          );
        }
        return;
      }
      if (event.type === "config-upserted") {
        if (event.config.projectId === current) {
          setOverview((overview) =>
            overview &&
            overview.projectId === current &&
            (overview.config?.revision ?? -1) <= event.config.revision
              ? projectAgentOverviewWithConfig(overview, event.config)
              : overview,
          );
        }
        return;
      }
      if (event.type === "goal-upserted") {
        if (event.goal.projectId === current) {
          setOverview((overview) =>
            overview &&
            overview.projectId === current &&
            !(overview.goal?.id === event.goal.id && overview.goal.revision > event.goal.revision)
              ? { ...overview, goal: event.goal }
              : overview,
          );
        }
        return;
      }
      if (event.type === "digest-upserted") {
        if (event.digest.projectId === current) {
          setOverview((overview) =>
            overview && overview.projectId === current
              ? { ...overview, digest: event.digest }
              : overview,
          );
        }
        return;
      }
      if (event.type === "task-upserted") {
        if (event.task.projectId === current) {
          setTasks((tasks) => {
            const index = tasks.findIndex((task) => task.id === event.task.id);
            if (index === -1) return [...tasks, event.task];
            if (event.task.revision < tasks[index]!.revision) return tasks;
            const next = [...tasks];
            next[index] = event.task;
            return next;
          });
        }
        return;
      }
      if (event.type === "thread-index-upserted") {
        if (event.projectId === current) {
          // The coordinator's own thread creations (e.g. a worker in a linked
          // repo) land here — merge rows so the Threads tab shows them without
          // waiting for the next full index listing.
          setThreads((threads) => {
            const next = [...threads];
            for (const entry of event.threads) {
              const index = next.findIndex((row) => row.threadId === entry.threadId);
              if (index === -1) {
                next.push(entry);
              } else {
                next[index] = entry;
              }
            }
            return next;
          });
        }
        return;
      }
      if (event.type === "activity-appended") {
        if (event.activity.projectId === current) {
          setActivity((activity) =>
            activity.some((entry) => entry.id === event.activity.id)
              ? activity
              : [event.activity, ...activity].toSorted(
                  (left, right) => right.sequence - left.sequence,
                ),
          );
        }
        return;
      }
      if (event.type === "document-head-updated") {
        if (event.head.projectId === current) {
          setDocuments((documents) => {
            const index = documents.findIndex(
              (document) => document.logicalPath === event.head.logicalPath,
            );
            if (index === -1) return [...documents, event.head];
            if (event.head.revision < documents[index]!.revision) return documents;
            const next = [...documents];
            next[index] = event.head;
            return next;
          });
        }
        return;
      }
    },
    [applyOverview, mergeWorkItems],
  );

  const stillCurrent = useCallback(
    (projectId: ProjectId, generation: number, scope: RequestScope) =>
      isCurrentScope(scope) &&
      projectIdRef.current === projectId &&
      loadGeneration.current === generation,
    [isCurrentScope],
  );

  const load = useCallback(async () => {
    const api = readNativeApi();
    const projectId = projectIdRef.current;
    const scope = scopeRef.current;
    if (!isCurrentScope(scope) || !scope.enabled) return;
    const generation = ++loadGeneration.current;
    // Replay only stream updates observed during this read, so a delayed list
    // cannot overwrite newer task revisions or drop a newly created row.
    const events = [...(loadEventsRef.current ?? [])];
    loadEventsRef.current = events;
    const threadEventVersion = threadIndexEventVersion.current;
    if (!api?.projectAgent || !projectId) {
      loadEventsRef.current = null;
      setOverview(null);
      setTasks([]);
      setActivity([]);
      setDocuments([]);
      setThreads([]);
      return;
    }
    try {
      const next = await api.projectAgent.getOverview({ projectId });
      if (!stillCurrent(projectId, generation, scope)) return;
      applyOverview(next);
      for (const event of events) applyStreamEvent(event);
      if (next.configured) {
        const readTasks = async () => {
          const tasks: ProjectTask[] = [];
          const cursors = new Set<string>();
          let cursor: string | null = null;
          do {
            const page = await api.projectAgent.listTasks({
              projectId,
              includeArchived: true,
              ...(cursor ? { cursor } : {}),
            });
            if (!stillCurrent(projectId, generation, scope)) return tasks;
            tasks.push(...page.tasks);
            cursor = page.nextCursor;
            if (cursor && cursors.has(cursor)) throw new Error("Task pagination did not advance.");
            if (cursor) cursors.add(cursor);
          } while (cursor);
          return tasks;
        };
        const [listed, activityPage, docs, index] = await Promise.all([
          readTasks(),
          api.projectAgent.listActivity({ projectId }),
          api.projectAgent.listDocuments({ projectId }),
          api.projectAgent.listThreadIndex({ projectId }),
        ]);
        if (!stillCurrent(projectId, generation, scope)) return;
        setTasks(listed);
        setActivity(activityPage.activity);
        setActivityCursor(activityPage.nextCursor);
        setDocuments(docs.documents);
        if (threadIndexEventVersion.current === threadEventVersion) setThreads(index.threads);
      } else {
        setTasks([]);
        setActivity([]);
        setDocuments([]);
        setThreads([]);
        setActivityCursor(null);
      }
      for (const event of events) applyStreamEvent(event);
      reportError(null);
    } catch (cause) {
      if (!stillCurrent(projectId, generation, scope)) return;
      reportError(cause instanceof Error ? cause.message : "Failed to load project coordinator.");
    } finally {
      if (loadEventsRef.current === events) loadEventsRef.current = null;
    }
  }, [reportError, applyOverview, applyStreamEvent, isCurrentScope, stillCurrent]);

  // `thread-index-upserted` events patch membership directly; a full re-list
  // still runs when config links/unlinks or task upserts could change it.
  // One refresh in flight at a time; a burst coalesces into a single
  // follow-up listing.
  const threadIndexRefreshRef = useRef({ inFlight: false, queued: false });
  const refreshThreadIndex = useCallback(() => {
    const api = readNativeApi();
    const projectId = projectIdRef.current;
    if (!api?.projectAgent || !projectId) return;
    const pending = threadIndexRefreshRef.current;
    if (pending.inFlight) {
      pending.queued = true;
      return;
    }
    pending.inFlight = true;
    const generation = loadGeneration.current;
    const scope = scopeRef.current;
    const eventVersion = threadIndexEventVersion.current;
    void (async () => {
      try {
        const index = await api.projectAgent.listThreadIndex({ projectId });
        if (
          stillCurrent(projectId, generation, scope) &&
          threadIndexEventVersion.current === eventVersion
        ) {
          setThreads(index.threads);
        }
      } catch {
        // A dropped refresh keeps the last index — the next event retries it.
      }
      pending.inFlight = false;
      if (pending.queued && isCurrentScope(scope)) {
        pending.queued = false;
        refreshThreadIndex();
      }
    })();
  }, [isCurrentScope, stillCurrent]);

  useEffect(() => {
    const scope = scopeRef.current;
    scope.active = true;
    loadGeneration.current += 1;
    loadEventsRef.current = null;
    workItemsRef.current = { projectId: input.projectId, items: [] };
    threadIndexRefreshRef.current = { inFlight: false, queued: false };
    overviewConfiguredRef.current = false;
    setBusy(false);
    setOverview(null);
    setTasks([]);
    setActivity([]);
    setActivityCursor(null);
    setDocuments([]);
    setThreads([]);
    reportError(null);
    if (!input.enabled || !input.projectId) return;
    void load();
    const api = readNativeApi();
    const subscribedProjectId = input.projectId;
    if (!api?.projectAgent || !subscribedProjectId) return;
    void api.projectAgent.subscribe({ projectId: subscribedProjectId }).catch(() => undefined);
    const unsubscribeEvents = api.projectAgent.onEvent((event: ProjectAgentStreamEvent) => {
      if (!isCurrentScope(scope)) return;
      // A snapshot is a refresh signal, not a delta. It is applied immediately
      // and followed by a fresh overview read; replaying it after that read can
      // replace newer API state with the older snapshot that triggered it.
      if (event.type !== "snapshot") loadEventsRef.current?.push(event);
      const wasConfigured = overviewConfiguredRef.current;
      applyStreamEvent(event);
      if (event.type === "snapshot" && event.overview.projectId === subscribedProjectId) {
        // A reconnect snapshot contains only the overview, not the task,
        // document, activity or membership lists missed while disconnected.
        void load();
      } else if (
        event.type === "config-upserted" &&
        event.config.projectId === subscribedProjectId
      ) {
        threadIndexEventVersion.current += 1;
        if (wasConfigured) refreshThreadIndex();
        else void load();
      } else if (event.type === "task-upserted" && event.task.projectId === subscribedProjectId) {
        threadIndexEventVersion.current += 1;
        refreshThreadIndex();
      } else if (
        event.type === "thread-index-upserted" &&
        event.projectId === subscribedProjectId
      ) {
        threadIndexEventVersion.current += 1;
        if (threadIndexRefreshRef.current.inFlight) threadIndexRefreshRef.current.queued = true;
      }
    });
    return () => {
      scope.active = false;
      loadGeneration.current += 1;
      unsubscribeEvents();
      void api.projectAgent.unsubscribe({ projectId: subscribedProjectId }).catch(() => undefined);
    };
  }, [
    input.enabled,
    input.projectId,
    load,
    refreshThreadIndex,
    applyStreamEvent,
    isCurrentScope,
    reportError,
  ]);

  const runMutation = useCallback(
    async (
      work: (
        api: NonNullable<ReturnType<typeof readNativeApi>>["projectAgent"],
        projectId: ProjectId,
      ) => Promise<void>,
    ) => {
      const api = readNativeApi();
      const projectId = projectIdRef.current;
      if (!api?.projectAgent || !projectId) return false;
      const scope = scopeRef.current;
      const finish = beginMutation();
      try {
        await work(api.projectAgent, projectId);
        if (isCurrentScope(scope)) await load();
        return true;
      } catch (cause) {
        if (isCurrentScope(scope)) {
          reportError(cause instanceof Error ? cause.message : "Project action failed.");
        }
        return false;
      } finally {
        finish();
      }
    },
    [load, reportError, beginMutation, isCurrentScope],
  );

  const configure = useCallback(
    async (input: {
      modelSelection: ModelSelection;
      coordinatorName?: string | undefined;
      workerRouting?: ProjectAgentWorkerRouting | undefined;
      limits?:
        | (ProjectAgentOverview["config"] extends infer C
            ? C extends { limits: infer L }
              ? L
              : never
            : never)
        | undefined;
      importedInstructions?: string | undefined;
      expectedRevision?: number | undefined;
      goal?: string | undefined;
      icon?: string | undefined;
      autoMemoryEnabled?: boolean | undefined;
      userDisplayName?: string | undefined;
      requestId?: string | undefined;
      libraryPath?: string | undefined;
      libraryRemoteUrl?: string | undefined;
      libraryPushOnChange?: boolean | undefined;
    }) =>
      runMutation(async (projectAgent, projectId) => {
        const overview = await projectAgent.configure({
          requestId: input.requestId ?? crypto.randomUUID(),
          projectId,
          coordinatorModelSelection: input.modelSelection,
          ...(input.coordinatorName ? { coordinatorName: input.coordinatorName } : {}),
          ...(input.workerRouting ? { workerRouting: input.workerRouting } : {}),
          ...(input.limits ? { limits: input.limits } : {}),
          ...(input.importedInstructions?.trim()
            ? { importedInstructions: input.importedInstructions }
            : {}),
          ...(input.expectedRevision !== undefined
            ? { expectedRevision: input.expectedRevision }
            : {}),
          ...(input.goal !== undefined ? { goal: input.goal } : {}),
          ...(input.icon !== undefined ? { icon: input.icon } : {}),
          ...(input.autoMemoryEnabled !== undefined
            ? { autoMemoryEnabled: input.autoMemoryEnabled }
            : {}),
          ...(input.userDisplayName?.trim()
            ? { userDisplayName: input.userDisplayName.trim() }
            : {}),
          ...(input.libraryPath !== undefined ? { libraryPath: input.libraryPath } : {}),
          ...(input.libraryRemoteUrl !== undefined
            ? { libraryRemoteUrl: input.libraryRemoteUrl }
            : {}),
          ...(input.libraryPushOnChange !== undefined
            ? { libraryPushOnChange: input.libraryPushOnChange }
            : {}),
        });
        useProjectAgentSummariesStore.getState().applyOverview(overview);
      }),
    [runMutation],
  );

  const linkProject = useCallback(
    async (linkedProjectId: ProjectId) =>
      runMutation(async (projectAgent, projectId) => {
        const overview = await projectAgent.linkProject({
          requestId: crypto.randomUUID(),
          projectId,
          linkedProjectId,
        });
        useProjectAgentSummariesStore.getState().applyOverview(overview);
      }),
    [runMutation],
  );

  const unlinkProject = useCallback(
    async (linkedProjectId: ProjectId) =>
      runMutation(async (projectAgent, projectId) => {
        const overview = await projectAgent.unlinkProject({
          requestId: crypto.randomUUID(),
          projectId,
          linkedProjectId,
        });
        useProjectAgentSummariesStore.getState().applyOverview(overview);
      }),
    [runMutation],
  );

  // Lifecycle ops share the same runMutation wrapper but take the input's
  // projectId so a settings dialog can act on any group, not just the one
  // currently bound to this hook.
  const groupControl = useCallback(
    async (
      projectId: ProjectId,
      call: (
        projectAgent: NonNullable<ReturnType<typeof readNativeApi>>["projectAgent"],
      ) => Promise<ProjectAgentOverview>,
    ) => {
      const api = readNativeApi();
      if (!api?.projectAgent) return null;
      const scope = scopeRef.current;
      const finish = beginMutation();
      try {
        const overview = await call(api.projectAgent);
        useProjectAgentSummariesStore.getState().applyOverview(overview);
        if (isCurrentScope(scope) && projectIdRef.current === projectId) await load();
        return overview;
      } catch (cause) {
        if (isCurrentScope(scope) && projectIdRef.current === projectId) {
          reportError(cause instanceof Error ? cause.message : "Hub action failed.");
        }
        return null;
      } finally {
        finish();
      }
    },
    [load, reportError, beginMutation, isCurrentScope],
  );

  const pauseGroup = useCallback(
    async (projectId: ProjectId) =>
      groupControl(projectId, (projectAgent) =>
        projectAgent.pauseGroup({ requestId: crypto.randomUUID(), projectId }),
      ),
    [groupControl],
  );

  const resumeGroup = useCallback(
    async (projectId: ProjectId) =>
      groupControl(projectId, (projectAgent) =>
        projectAgent.resumeGroup({ requestId: crypto.randomUUID(), projectId }),
      ),
    [groupControl],
  );

  const archiveGroup = useCallback(
    async (projectId: ProjectId) =>
      groupControl(projectId, (projectAgent) =>
        projectAgent.archiveGroup({ requestId: crypto.randomUUID(), projectId }),
      ),
    [groupControl],
  );

  const unarchiveGroup = useCallback(
    async (projectId: ProjectId) =>
      groupControl(projectId, (projectAgent) =>
        projectAgent.unarchiveGroup({ requestId: crypto.randomUUID(), projectId }),
      ),
    [groupControl],
  );

  const restartCoordinator = useCallback(
    async (projectId: ProjectId) =>
      groupControl(projectId, (projectAgent) =>
        projectAgent.restartCoordinator({ requestId: crypto.randomUUID(), projectId }),
      ),
    [groupControl],
  );

  const deleteGroup = useCallback(
    async (projectId: ProjectId, confirmName: string, options?: { requireEmpty?: boolean }) => {
      const api = readNativeApi();
      if (!api?.projectAgent) return null;
      const scope = scopeRef.current;
      const finish = beginMutation();
      try {
        const result: ProjectAgentDeleteGroupResult = await api.projectAgent.deleteGroup({
          requestId: crypto.randomUUID(),
          projectId,
          confirmName,
          ...(options?.requireEmpty === true ? { requireEmpty: true } : {}),
        });
        return result;
      } catch (cause) {
        if (isCurrentScope(scope) && projectIdRef.current === projectId) {
          reportError(cause instanceof Error ? cause.message : "Hub action failed.");
        }
        return null;
      } finally {
        finish();
      }
    },
    [reportError, beginMutation, isCurrentScope],
  );

  const startGoal = useCallback(
    async (objective: string) =>
      runMutation(async (projectAgent, projectId) => {
        await projectAgent.startGoal({
          requestId: crypto.randomUUID(),
          projectId,
          objective,
        });
      }),
    [runMutation],
  );

  const pauseGoal = useCallback(async () => {
    const goal = overview?.goal;
    if (!goal) return;
    await runMutation(async (projectAgent, projectId) => {
      await projectAgent.pauseGoal({
        requestId: crypto.randomUUID(),
        projectId,
        goalId: goal.id,
        expectedRevision: goal.revision,
      });
    });
  }, [overview?.goal, runMutation]);

  const resumeGoal = useCallback(async () => {
    const goal = overview?.goal;
    if (!goal) return;
    await runMutation(async (projectAgent, projectId) => {
      await projectAgent.resumeGoal({
        requestId: crypto.randomUUID(),
        projectId,
        goalId: goal.id,
        expectedRevision: goal.revision,
      });
    });
  }, [overview?.goal, runMutation]);

  const stopGoal = useCallback(async () => {
    const goal = overview?.goal;
    if (!goal) return;
    await runMutation(async (projectAgent, projectId) => {
      await projectAgent.stopGoal({
        requestId: crypto.randomUUID(),
        projectId,
        goalId: goal.id,
        expectedRevision: goal.revision,
      });
    });
  }, [overview?.goal, runMutation]);

  const createTask = useCallback(
    async (title: string) => {
      const goal = overview?.goal;
      if (!goal) return;
      await runMutation(async (projectAgent, projectId) => {
        await projectAgent.createTask({
          requestId: crypto.randomUUID(),
          projectId,
          goalId: goal.id,
          title,
        });
      });
    },
    [overview?.goal, runMutation],
  );

  const acceptTask = useCallback(
    async (task: ProjectTask) =>
      runMutation(async (projectAgent, projectId) => {
        await projectAgent.updateTask({
          requestId: crypto.randomUUID(),
          projectId,
          taskId: task.id,
          expectedRevision: task.revision,
          accept: true,
        });
      }),
    [runMutation],
  );

  const archiveTask = useCallback(
    async (task: ProjectTask) =>
      runMutation(async (projectAgent, projectId) => {
        await projectAgent.updateTask({
          requestId: crypto.randomUUID(),
          projectId,
          taskId: task.id,
          expectedRevision: task.revision,
          archived: true,
        });
      }),
    [runMutation],
  );

  const updateTaskStatus = useCallback(
    async (task: ProjectTask, input: { status?: ProjectTask["status"]; archived?: boolean }) =>
      runMutation(async (projectAgent, projectId) => {
        await projectAgent.updateTask({
          requestId: crypto.randomUUID(),
          projectId,
          taskId: task.id,
          expectedRevision: task.revision,
          ...(input.status !== undefined ? { status: input.status } : {}),
          ...(input.archived !== undefined ? { archived: input.archived } : {}),
        });
      }),
    [runMutation],
  );

  const loadEvidence = useCallback(async (taskId: ProjectTask["id"]) => {
    const api = readNativeApi();
    const projectId = projectIdRef.current;
    if (!api?.projectAgent || !projectId) return [] as ReadonlyArray<ProjectEvidence>;
    const listed = await api.projectAgent.listEvidence({ projectId, taskId });
    return listed.evidence;
  }, []);

  const loadMoreActivity = useCallback(async () => {
    const api = readNativeApi();
    const projectId = projectIdRef.current;
    if (!api?.projectAgent || !projectId || !activityCursor) return;
    const scope = scopeRef.current;
    const generation = loadGeneration.current;
    const page = await api.projectAgent.listActivity({ projectId, cursor: activityCursor });
    if (!stillCurrent(projectId, generation, scope)) return;
    setActivity((current) => [
      ...new Map([...current, ...page.activity].map((entry) => [entry.id, entry])).values(),
    ]);
    setActivityCursor(page.nextCursor);
  }, [activityCursor, stillCurrent]);

  const excludeThread = useCallback(
    async (threadId: ThreadId, excluded: boolean) =>
      runMutation(async (projectAgent, projectId) => {
        await projectAgent.excludeThread({
          requestId: crypto.randomUUID(),
          projectId,
          threadId,
          excluded,
        });
      }),
    [runMutation],
  );

  const backfillSummaries = useCallback(
    async () =>
      runMutation(async (projectAgent, projectId) => {
        await projectAgent.backfillSummaries({
          requestId: crypto.randomUUID(),
          projectId,
        });
      }),
    [runMutation],
  );

  const refreshDigest = useCallback(
    async () =>
      runMutation(async (projectAgent, projectId) => {
        await projectAgent.refreshDigest({
          requestId: crypto.randomUUID(),
          projectId,
        });
      }),
    [runMutation],
  );

  const readDocument = useCallback(async (logicalPath: string, revision?: number) => {
    const api = readNativeApi();
    const projectId = projectIdRef.current;
    if (!api?.projectAgent || !projectId) return null;
    return api.projectAgent.readDocument({
      projectId,
      logicalPath,
      ...(revision ? { revision } : {}),
    });
  }, []);

  const writeDocument = useCallback(
    async (input: {
      logicalPath: string;
      content: string;
      expectedRevision?: number;
      importExternal?: boolean;
    }) => {
      const api = readNativeApi();
      const projectId = projectIdRef.current;
      if (!api?.projectAgent || !projectId) {
        throw new Error("Project coordinator is unavailable.");
      }
      return api.projectAgent.writeDocument({
        requestId: crypto.randomUUID(),
        projectId,
        logicalPath: input.logicalPath,
        content: input.content,
        ...(input.expectedRevision !== undefined
          ? { expectedRevision: input.expectedRevision }
          : {}),
        ...(input.importExternal ? { importExternal: true } : {}),
      });
    },
    [],
  );

  const exportDocuments = useCallback(
    async (logicalPaths: ReadonlyArray<string>, destinationDirectory: string) => {
      const api = readNativeApi();
      const projectId = projectIdRef.current;
      if (!api?.projectAgent || !projectId) return;
      await api.projectAgent.exportDocuments({
        requestId: crypto.randomUUID(),
        projectId,
        logicalPaths: [...logicalPaths],
        destinationDirectory,
      });
    },
    [],
  );

  return {
    overview,
    tasks,
    activity,
    activityCursor,
    documents,
    threads,
    error,
    busy,
    load,
    readError,
    configure,
    linkProject,
    unlinkProject,
    pauseGroup,
    resumeGroup,
    archiveGroup,
    unarchiveGroup,
    restartCoordinator,
    deleteGroup,
    startGoal,
    pauseGoal,
    resumeGoal,
    stopGoal,
    createTask,
    acceptTask,
    archiveTask,
    updateTaskStatus,
    loadEvidence,
    loadMoreActivity,
    excludeThread,
    backfillSummaries,
    refreshDigest,
    readDocument,
    writeDocument,
    exportDocuments,
    setError: reportError,
  };
}

export type LoadedDocument = Awaited<
  ReturnType<ReturnType<typeof useProjectAgent>["readDocument"]>
>;
export type SavedDocument = ProjectDocumentRevision;
