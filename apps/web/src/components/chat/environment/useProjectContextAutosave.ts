import type { ContextApi, ProjectId, ProjectContextSettings } from "@synara/contracts";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useSyncExternalStore } from "react";

import { WS_CONTEXT_V1_CAPABILITY } from "@synara/contracts";
import { readNativeApi } from "~/nativeApi";
import { useNativeApiServerCapability } from "~/hooks/useNativeApiServerCapability";

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
  const capabilityAvailable = useNativeApiServerCapability(WS_CONTEXT_V1_CAPABILITY);
  const nativeApi = readNativeApi();
  const contextApi = capabilityAvailable ? (nativeApi?.context ?? null) : null;
  const query = useQuery({
    queryKey: ["context", "project", projectId],
    enabled: Boolean(enabled && projectId && contextApi),
    queryFn: () => {
      if (!projectId || !contextApi) throw new Error("Project Context is unavailable.");
      return contextApi.getProject({ projectId });
    },
    staleTime: 0,
    // Config events are outside the transcript subscription. Refresh committed
    // sources while this surface is active; the controller protects local drafts.
    refetchInterval: enabled && contextApi ? 5_000 : false,
    refetchIntervalInBackground: false,
  });

  const controller = useMemo(
    () =>
      projectId && contextApi && query.data
        ? getProjectContextAutosave(contextApi, query.data)
        : null,
    [contextApi, projectId, query.data],
  );

  useEffect(() => {
    if (controller && query.data) controller.receiveConfirmed(query.data);
  }, [controller, query.data]);

  const state = useSyncExternalStore(
    controller?.subscribe ?? subscribeNothing,
    controller?.getState ?? emptySnapshot,
    emptySnapshot,
  );

  return {
    api: contextApi,
    controller,
    state,
    settings: query.data,
    available: Boolean(capabilityAvailable && contextApi),
    loading: Boolean(enabled && projectId && contextApi && query.isPending),
    error: query.error,
    reload: async () => {
      await query.refetch();
    },
  };
}
