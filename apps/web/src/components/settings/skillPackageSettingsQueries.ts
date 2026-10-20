import { WS_CONTEXT_V1_CAPABILITY } from "@synara/contracts";
import { useNativeApiServerCapabilitySnapshot } from "~/hooks/useNativeApiServerCapability";

export const SKILL_PACKAGES_QUERY_KEY = ["server", "skillPackages"] as const;
export const SKILL_PACKAGE_SOURCES_QUERY_KEY = ["server", "skillPackageSources"] as const;

export function skillPackagesQueryKey(connectionGeneration: string | null) {
  return [...SKILL_PACKAGES_QUERY_KEY, connectionGeneration] as const;
}

export function skillPackageSourcesQueryKey(connectionGeneration: string | null) {
  return [...SKILL_PACKAGE_SOURCES_QUERY_KEY, connectionGeneration] as const;
}

export function skillPackageDetailQueryKey(
  packageId: string | null,
  connectionGeneration: string | null,
) {
  return [...SKILL_PACKAGES_QUERY_KEY, connectionGeneration, "detail", packageId] as const;
}

/** Track the active host generation so late responses remain isolated to their original cache. */
export function useSkillPackageConnection() {
  const { connected, generation } = useNativeApiServerCapabilitySnapshot(WS_CONTEXT_V1_CAPABILITY);
  return { connected, generation };
}
