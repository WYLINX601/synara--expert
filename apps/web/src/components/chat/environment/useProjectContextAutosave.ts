import type { ContextApi, ProjectId, ProjectContextSettings } from "@synara/contracts";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import {
  contextApiQueryIdentity,
  readContextClient,
  useContextClient,
} from "~/workbench/host/contextClient";

import {
  getProjectContextAutosave,
  type ProjectContextAutosave,
  type ProjectContextAutosaveState,
} from "./projectContextAutosave";

const subscribeNothing = () => () => undefined;
const emptySnapshot = (): ProjectContextAutosaveState | null => null;

export interface ProjectContextController {
  readonly api: ContextApi | null;
  readonly controller: ProjectContextAutosave | null;
  readonly state: ProjectContextAutosaveState | null;
  readonly settings: ProjectContextSettings | undefined;
  readonly available: boolean;
  readonly supported: boolean;
  readonly ownsContext: boolean;
  readonly detached: boolean;
  readonly requiresDiscard: boolean;
  readonly discard: () => Promise<boolean>;
  readonly loading: boolean;
  readonly error: unknown;
  readonly reload: () => Promise<void>;
}

/**
 * Reads the server-owned project context and attaches its long-lived autosave queue.
 * The queue registry is keyed by API connection, data instance and project, so hiding
 * the Environment pane or switching threads within a project does not abandon a write.
 */
export function useProjectContextAutosave(
  projectId: ProjectId | null,
  enabled: boolean,
): ProjectContextController {
  const contextClient = useContextClient();
  const availabilityOwner = useRef({}).current;
  const contextApi = contextClient.api;
  const query = useQuery({
    queryKey: [
      "context",
      "project",
      contextApiQueryIdentity(contextApi),
      contextClient.generation,
      projectId,
    ],
    enabled: Boolean(enabled && projectId && contextApi && contextClient.available),
    queryFn: async () => {
      if (!projectId || !contextApi) throw new Error("Project Context is unavailable.");
      const generation = contextClient.generation;
      const settings = await contextApi.getProject({ projectId });
      const current = readContextClient();
      if (generation !== current.generation || current.api !== contextApi || !current.available) {
        throw new Error("Context connection changed while loading. Reconnect and retry.");
      }
      return settings;
    },
    staleTime: 0,
    // Config events are outside the transcript subscription. Refresh committed
    // sources while this surface is active; the controller protects local drafts.
    refetchInterval: enabled && contextApi && contextClient.available ? 5_000 : false,
    refetchIntervalInBackground: false,
  });

  const candidate = useMemo(
    () =>
      projectId && contextApi && query.data
        ? getProjectContextAutosave(contextApi, query.data)
        : null,
    [contextApi, projectId, query.data],
  );

  const [retained, setRetained] = useState<{
    readonly projectId: ProjectId;
    readonly api: ContextApi;
    readonly controller: ProjectContextAutosave;
  } | null>(null);
  // A changed connection/instance may offer a new queue, but it does not dismiss an
  // unsaved draft belonging to the previous owner of this same project.
  const previous = retained?.projectId === projectId ? retained : null;
  const controller = previous?.controller ?? candidate;
  const state = useSyncExternalStore(
    controller?.subscribe ?? subscribeNothing,
    controller?.getState ?? emptySnapshot,
    emptySnapshot,
  );
  const detached = Boolean(
    previous &&
    controller &&
    ((candidate !== null && controller !== candidate) || previous.api !== contextApi),
  );
  useLayoutEffect(() => {
    if (previous && previous.controller !== candidate && state?.pending) return;
    if (candidate && contextApi && projectId) {
      if (
        retained?.controller !== candidate ||
        retained.api !== contextApi ||
        retained.projectId !== projectId
      ) {
        setRetained({ controller: candidate, api: contextApi, projectId });
      }
    } else if (retained && (!previous || !state?.pending)) setRetained(null);
  }, [candidate, contextApi, projectId, previous, retained, state?.pending]);

  // Confirm the data instance again before resuming a queue after reconnect. An old
  // cached read cannot authorize a write while the current connection is refreshing it.
  const available = Boolean(
    !detached &&
    contextClient.available &&
    contextApi &&
    query.isSuccess &&
    controller === candidate,
  );
  useLayoutEffect(() => {
    controller?.setOwnerAvailable(availabilityOwner, available);
    return () => controller?.setOwnerAvailable(availabilityOwner, null);
  }, [controller, available, availabilityOwner]);

  useEffect(() => {
    if (controller === candidate && controller && query.data)
      controller.receiveConfirmed(query.data);
  }, [controller, candidate, query.data]);

  return {
    api: contextApi,
    controller,
    state,
    settings: detached ? state?.base : query.data,
    available,
    supported: contextClient.supported,
    ownsContext: contextClient.capability !== "unsupported" || Boolean(state?.pending),
    detached,
    requiresDiscard:
      detached || (contextClient.capability === "unsupported" && Boolean(state?.pending)),
    discard: async () =>
      controller
        ? detached || contextClient.capability === "unsupported"
          ? controller.discardDetachedDraft()
          : controller.discard()
        : true,
    loading: Boolean(
      enabled && projectId && contextApi && contextClient.supported && query.isPending,
    ),
    error: query.error,
    reload: async () => {
      await query.refetch();
    },
  };
}
