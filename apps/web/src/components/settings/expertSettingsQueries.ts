import type { ProviderInstanceId, ProviderKind } from "@synara/contracts";

export const EXPERTS_QUERY_KEY = ["server", "experts"] as const;
export const EXPERT_CONNECTIONS_QUERY_KEY = ["server", "expertConnections"] as const;

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
