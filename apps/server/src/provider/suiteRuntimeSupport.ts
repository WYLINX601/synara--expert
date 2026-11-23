import type { ProviderSuiteExecution } from "@synara/contracts";

const supportedProviders: Record<ProviderSuiteExecution["kind"], Readonly<Record<string, true>>> = {
  "hub-coordinator": { omp: true, pi: true },
  expert: { omp: true, pi: true },
};

/** Admission only; the active adapter must still attest the fixed Run. */
export function supportsSuiteRuntime(
  provider: string,
  role: ProviderSuiteExecution["kind"],
): boolean {
  return Object.hasOwn(supportedProviders[role], provider);
}
