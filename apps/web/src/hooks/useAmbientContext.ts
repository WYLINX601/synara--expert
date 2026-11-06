import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";

export const AMBIENT_CONTEXT_QUERY_KEY = ["desktop", "ambient-context"] as const;

/** Desktop owns collection/policy; React only observes the registered capability. */
export function useAmbientContext(active = true) {
  const bridge = typeof window === "undefined" ? undefined : window.desktopBridge?.ambientContext;
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: AMBIENT_CONTEXT_QUERY_KEY,
    queryFn: () => bridge!.getState(),
    enabled: Boolean(bridge) && active,
    staleTime: 0,
    // Expiry can happen without another publication from an idle app.
    refetchInterval: active && bridge ? 5_000 : false,
  });
  useEffect(() => {
    if (!active || !bridge) return;
    return bridge.onChanged(() => {
      void queryClient.invalidateQueries({ queryKey: AMBIENT_CONTEXT_QUERY_KEY });
      void queryClient.invalidateQueries({ queryKey: ["desktop", "ambient-resources"] });
    });
  }, [active, bridge, queryClient]);
  return { bridge, ...query };
}

export function useAmbientResources(query: string, active: boolean) {
  const state = useAmbientContext(active);
  const queryClient = useQueryClient();
  const allowedFamilies =
    !state.bridge || state.isError
      ? []
      : (state.data?.sources ?? [])
          .filter(
            (source) =>
              source.policy.enabled &&
              source.connected &&
              !source.error &&
              source.policy.allowedTypes.includes("resource.identity"),
          )
          .map((source) => source.manifest.id);
  const allowedSourceIds = (
    state.data?.connections
      ? state.data.connections
          .filter(
            (connection) =>
              allowedFamilies.includes("obsidian") && connection.connected && !connection.error,
          )
          .map((connection) => connection.sourceId)
      : allowedFamilies
  ).toSorted();
  const scope = JSON.stringify(allowedSourceIds);
  const enabled = active && allowedSourceIds.length > 0;
  useEffect(() => {
    // A revoked source must not refill an old cache when its in-flight search returns.
    // Scope changes also prevent a disabled source's cached results appearing on re-enable.
    const previousScopes = {
      queryKey: ["desktop", "ambient-resources"],
      predicate: (entry: { queryKey: readonly unknown[] }) => entry.queryKey[3] !== scope,
    };
    void queryClient.cancelQueries(previousScopes);
    queryClient.removeQueries(previousScopes);
  }, [queryClient, scope]);
  return useQuery({
    queryKey: ["desktop", "ambient-resources", query, scope],
    queryFn: async ({ signal }) => {
      const resources = await state.bridge!.searchResources(query);
      return signal.aborted ? [] : resources;
    },
    enabled,
    // Filter each source independently; another enabled source cannot keep a revoked
    // source visible. This also gates results that settle after the control is disabled.
    select: (resources) =>
      enabled ? resources.filter((resource) => allowedSourceIds.includes(resource.sourceId)) : [],
  });
}
