import { describe, expect, it } from "vitest";

import {
  resolveSynaraDesktopRuntimeFlavor,
  synaraDesktopIdentity,
} from "@synara/shared/desktopIdentity";
import {
  createDesktopArtifactIdentity,
  resolveDesktopArtifactPublishConfig,
} from "./lib/desktop-artifact-identity.ts";

describe("desktop artifact identity", () => {
  it.each(["mac", "win"] as const)(
    "preserves the production %s package and artifact names",
    (platform) => {
      const result = createDesktopArtifactIdentity({ platform, flavor: "production" });
      expect(result.packageMetadata).toEqual({
        name: "synara-desktop",
        productName: "Synara",
        synaraDesktopFlavor: "production",
      });
      expect(result.buildConfig).toEqual({
        appId: "com.emanueledipietro.synara",
        productName: "Synara",
        artifactName: "Synara-${version}-${arch}.${ext}",
      });
      expect(result.releaseDirectoryName).toBe("release");
      expect(result.identity.usesScriptedUpdates).toBe(false);
    },
  );

  it.each([
    ["canary", "Synara Canary", "synara-canary", "synara-canary", ".synara-canary"],
    ["cua", "Synara Cua", "synara-cua", "synara-cua", ".synara-cua"],
    ["workbench", "Personal Workbench", "workbench", "workbench", ".synara-workbench"],
    [
      "workbench-preview",
      "Personal Workbench Preview",
      "workbench-preview",
      "workbench-preview",
      ".synara-workbench-preview",
    ],
  ] as const)(
    "keeps packaged %s metadata, native identity, origin, storage and updater policy aligned",
    (flavor, displayName, profileName, scheme, homeName) => {
      const result = createDesktopArtifactIdentity({ platform: "mac", flavor });
      const packagedJson = JSON.parse(JSON.stringify(result.packageMetadata));
      const runtimeFlavor = resolveSynaraDesktopRuntimeFlavor({
        isPackaged: true,
        isDevelopment: false,
        packagedFlavor: packagedJson.synaraDesktopFlavor,
        requestedFlavor: "production",
      });
      const runtimeIdentity = synaraDesktopIdentity(runtimeFlavor);
      expect(runtimeIdentity).toEqual(result.identity);
      expect(result.buildConfig.appId).toBe(runtimeIdentity.bundleId);
      expect(result.packageMetadata.productName).toBe(result.buildConfig.productName);
      expect(result.packageMetadata.productName).toBe(displayName);
      expect(result.packageMetadata.name).toBe(`synara-desktop-${flavor}`);
      expect(result.buildConfig.protocols).toEqual([
        { name: runtimeIdentity.displayName, schemes: [runtimeIdentity.scheme] },
      ]);
      expect(runtimeIdentity.scheme).toBe(scheme);
      expect(runtimeIdentity.userDataDirectoryName).toBe(profileName);
      expect(runtimeIdentity.defaultHomeDirectoryName).toBe(homeName);
      expect(runtimeIdentity.usesScriptedUpdates).toBe(true);
      expect(result.releaseDirectoryName).toBe(`release-${flavor}`);
      expect(result.buildConfig.artifactName).not.toBe("Synara-${version}-${arch}.${ext}");
    },
  );

  it.each(["canary", "cua", "workbench", "workbench-preview"] as const)(
    "refuses %s on Windows until it has an isolated installer registration",
    (flavor) => {
      expect(() => createDesktopArtifactIdentity({ platform: "win", flavor })).toThrow(
        "macOS and Linux only",
      );
    },
  );

  it("keeps official and mock update metadata out of script-updated artifacts", () => {
    const githubPublishConfig = {
      provider: "github" as const,
      owner: "synara-org",
      repo: "official-feed",
      releaseType: "release" as const,
    };
    for (const flavor of ["workbench", "workbench-preview"] as const) {
      const identity = createDesktopArtifactIdentity({ platform: "mac", flavor }).identity;
      expect(
        resolveDesktopArtifactPublishConfig({
          usesScriptedUpdates: identity.usesScriptedUpdates,
          githubPublishConfig,
          mockUpdates: true,
          mockUpdateServerPort: "4170",
        }),
      ).toBeNull();
    }
  });

  it("preserves the Stable publisher and explicit mock feed behavior", () => {
    const githubPublishConfig = {
      provider: "github" as const,
      owner: "synara-org",
      repo: "stable-feed",
      releaseType: "release" as const,
    };
    expect(
      resolveDesktopArtifactPublishConfig({
        usesScriptedUpdates: false,
        githubPublishConfig,
        mockUpdates: true,
        mockUpdateServerPort: "4170",
      }),
    ).toEqual([githubPublishConfig]);
    expect(
      resolveDesktopArtifactPublishConfig({
        usesScriptedUpdates: false,
        githubPublishConfig: undefined,
        mockUpdates: true,
        mockUpdateServerPort: "4170",
      }),
    ).toEqual([{ provider: "generic", url: "http://localhost:4170" }]);
    expect(
      resolveDesktopArtifactPublishConfig({
        usesScriptedUpdates: false,
        githubPublishConfig: undefined,
        mockUpdates: false,
        mockUpdateServerPort: undefined,
      }),
    ).toBeUndefined();
  });
});
