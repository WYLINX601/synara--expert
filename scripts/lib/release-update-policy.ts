import { readLinxProductVersion } from "./linx-release-source.ts";

export function resolveReleaseUpdatePolicy(rawVersion: string, productVersion: string) {
  const version = rawVersion.startsWith("v") ? rawVersion.slice(1) : rawVersion;
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version) || version !== productVersion)
    throw new Error(
      "Release tag must match the Linx product version in workbench/build-config.json.",
    );
  return {
    version,
    tag: `v${version}`,
    desktopFlavor: "workbench" as const,
    isPrerelease: false,
    makeLatest: true,
  };
}
export function readReleaseUpdatePolicyConfig(rootDirectory: string): string {
  return readLinxProductVersion(rootDirectory);
}
