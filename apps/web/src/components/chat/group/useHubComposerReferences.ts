import type { ProjectId } from "@synara/contracts";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useSyncExternalStore } from "react";
import {
  readHubReferenceClient,
  hubReferenceConnectionGeneration as readConnection,
  subscribeToHubReferenceConnection as subscribe,
} from "~/workbench/host/hubReferenceClient";
import type { ComposerCommandItem } from "../ComposerCommandMenu";
import { buildHubReferenceMenuItems } from "./hubComposerReferences.logic";

export function useHubComposerReferences(input: {
  hubId: ProjectId | null;
  isCoordinator: boolean;
  enabled: boolean;
  query: string;
  nativeItems: ComposerCommandItem[];
}) {
  const connection = useSyncExternalStore(subscribe, readConnection, () => null);
  const enabled = input.enabled && input.hubId !== null && connection !== null;
  const experts = useQuery({
    queryKey: ["hub-references", connection, input.hubId, "experts"],
    enabled: enabled && input.isCoordinator,
    staleTime: 0,
    refetchOnMount: "always",
    refetchInterval: enabled && input.isCoordinator ? 5_000 : false,
    queryFn: async () => {
      const api = readHubReferenceClient();
      if (!input.hubId || !api) throw new Error("Expert discovery is unavailable.");
      const result = await api.listExperts({ projectId: input.hubId });
      if (readConnection() !== connection)
        throw new Error("The Hub connection changed. Try again.");
      return result;
    },
  });
  const deliverables = useQuery({
    queryKey: ["hub-references", connection, input.hubId, "deliverables"],
    enabled,
    staleTime: 0,
    refetchOnMount: "always",
    refetchInterval: enabled ? 5_000 : false,
    queryFn: async () => {
      const api = readHubReferenceClient();
      if (!input.hubId || !api) throw new Error("Key deliverables are unavailable.");
      const result = await api.listDeliverables({ projectId: input.hubId });
      if (readConnection() !== connection)
        throw new Error("The Hub connection changed. Try again.");
      return result;
    },
  });
  const workbenchItems = useMemo(
    () =>
      input.hubId
        ? buildHubReferenceMenuItems({
            hubId: input.hubId,
            isCoordinator: input.isCoordinator,
            query: input.query,
            experts: experts.error ? [] : (experts.data ?? []),
            deliverables: deliverables.error ? [] : (deliverables.data ?? []),
          })
        : [],
    [
      input.hubId,
      input.isCoordinator,
      input.query,
      experts.error,
      experts.data,
      deliverables.error,
      deliverables.data,
    ],
  );
  const items = useMemo(
    () => [...workbenchItems, ...input.nativeItems],
    [workbenchItems, input.nativeItems],
  );
  return {
    items,
    loading: deliverables.isFetching || (input.isCoordinator && experts.isFetching),
    error:
      input.enabled && connection === null
        ? "The Hub connection is unavailable. Reconnect and try again."
        : (deliverables.error?.message ??
          (input.isCoordinator ? experts.error?.message : null) ??
          null),
  };
}
