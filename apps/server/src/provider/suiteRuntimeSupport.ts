/** Suite Run materialization requires the Provider-owned OMP execution path. */
export function supportsSuiteRuntime(provider: string): boolean {
  return provider === "omp";
}
