import { EXPERT_PROVIDER_KINDS, type ExpertProviderKind } from "@synara/contracts";

/** Providers with an implemented immutable Expert and Context projection. */
export function isExpertProvider(provider: unknown): provider is ExpertProviderKind {
  return EXPERT_PROVIDER_KINDS.some((candidate) => candidate === provider);
}
