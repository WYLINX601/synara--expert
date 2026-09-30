import {
  synaraDesktopIdentity,
  type SynaraPackagedDesktopFlavor,
} from "@synara/shared/desktopIdentity";

export interface DesktopGitHubPublishConfig {
  readonly provider: "github";
  readonly owner: string;
  readonly repo: string;
  readonly releaseType: "release";
}

export function resolveDesktopArtifactPublishConfig(input: {
  readonly usesScriptedUpdates: boolean;
  readonly githubPublishConfig: DesktopGitHubPublishConfig | undefined;
  readonly mockUpdates: boolean;
  readonly mockUpdateServerPort: string | undefined;
}):
  | ReadonlyArray<DesktopGitHubPublishConfig | { provider: "generic"; url: string }>
  | null
  | undefined {
  if (input.usesScriptedUpdates) {
    return null;
  }
  if (input.githubPublishConfig) {
    return [input.githubPublishConfig];
  }
  if (input.mockUpdates) {
    return [
      {
        provider: "generic",
        url: `http://localhost:${input.mockUpdateServerPort ?? 3000}`,
      },
    ];
  }
  return undefined;
}

export function createDesktopArtifactIdentity(input: {
  readonly platform: "mac" | "linux" | "win";
  readonly flavor: SynaraPackagedDesktopFlavor;
}) {
  // Stable's NSIS GUID deliberately survives public bundle ID changes. An
  // experimental installer must not register itself as that same product; beta
  // ships its own WINDOWS_BETA_INSTALLER_GUID, so it is exempt.
  if (input.platform === "win" && input.flavor !== "production" && input.flavor !== "beta") {
    throw new Error("Isolated desktop flavors are currently supported on macOS and Linux only.");
  }
  const identity = synaraDesktopIdentity(input.flavor);
  const suffix = input.flavor === "production" ? "" : `-${input.flavor}`;
  return {
    identity,
    packageMetadata: {
      name: `synara-desktop${suffix}`,
      productName: identity.displayName,
      synaraDesktopFlavor: input.flavor,
    },
    buildConfig: {
      appId: identity.bundleId,
      productName: identity.displayName,
      artifactName: `${identity.displayName.replaceAll(" ", "-")}-\${version}-\${arch}.\${ext}`,
      ...(input.flavor !== "production"
        ? { protocols: [{ name: identity.displayName, schemes: [identity.scheme] }] }
        : {}),
    },
    releaseDirectoryName: `release${suffix}`,
  };
}
