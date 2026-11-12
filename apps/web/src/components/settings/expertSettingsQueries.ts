import type { ProviderInstanceId, ProviderKind, SuiteRef } from "@synara/contracts";

export const EXPERTS_QUERY_KEY = ["server", "experts"] as const;
export const EXPERT_CONNECTIONS_QUERY_KEY = ["server", "expertConnections"] as const;
export const SUITES_QUERY_KEY = ["server", "suites"] as const;
export const suiteQueryKey = (ref: SuiteRef | null) =>
  [...SUITES_QUERY_KEY, ref?.suiteId ?? null, ref?.revision ?? null] as const;

export function expertPreviewQueryKey(
  expertId: string,
  revision: number,
  provider: ProviderKind,
  providerInstanceId?: ProviderInstanceId | null,
  cwd?: string | null,
) {
  return [
    ...EXPERTS_QUERY_KEY,
    "preview",
    expertId,
    revision,
    provider,
    providerInstanceId ?? null,
    cwd ?? null,
  ] as const;
}
