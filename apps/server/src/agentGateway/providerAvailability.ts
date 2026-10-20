/** Shared read-only availability projection for agent tools and the Hub composer. */
import type { ProviderKind, ServerProviderStatus, ServerSettings } from "@synara/contracts";
import { deriveProviderInstances, isProviderKind } from "@synara/shared/providerInstances";

import type {
  AgentGatewayProviderAvailability,
  AgentGatewayProviderInstanceAvailability,
} from "./targetResolver";
import { PROVIDER_KINDS } from "./toolInput";

const providerInstanceAvailability = (
  instance: ReturnType<typeof deriveProviderInstances>[number],
  status: ServerProviderStatus | undefined,
): AgentGatewayProviderInstanceAvailability => {
  const result = {
    instanceId: instance.instanceId,
    displayName: instance.displayName,
    isDefault: instance.isDefault,
    enabled: instance.enabled,
  };
  return status === undefined
    ? result
    : { ...result, available: status.available, authStatus: status.authStatus };
};

export function buildAgentGatewayProviderAvailabilities(
  settings: ServerSettings,
  statuses: ReadonlyArray<ServerProviderStatus>,
): ReadonlyMap<ProviderKind, AgentGatewayProviderAvailability> {
  const statusByInstance = new Map<string, ServerProviderStatus>();
  for (const status of statuses) {
    if (isProviderKind(status.driver)) {
      const instanceId = status.instanceId ?? status.provider;
      statusByInstance.set(`${status.driver}\u0000${instanceId}`, status);
    }
  }
  const instancesByProvider = new Map<ProviderKind, ReturnType<typeof deriveProviderInstances>>();
  for (const instance of deriveProviderInstances(settings)) {
    const instances = instancesByProvider.get(instance.driver) ?? [];
    instancesByProvider.set(instance.driver, [...instances, instance]);
  }
  return new Map(
    PROVIDER_KINDS.map((provider) => {
      const status = statusByInstance.get(`${provider}\u0000${provider}`);
      return [
        provider,
        {
          enabled: settings.providers[provider].enabled,
          instances: (instancesByProvider.get(provider) ?? []).map((instance) =>
            providerInstanceAvailability(
              instance,
              statusByInstance.get(`${instance.driver}\u0000${instance.instanceId}`),
            ),
          ),
          ...(status
            ? {
                available: status.available,
                authStatus: status.authStatus,
                ...(status.message ? { message: status.message } : {}),
              }
            : {}),
        },
      ];
    }),
  );
}
