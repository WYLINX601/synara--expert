import { describe, expect, it } from "vitest";
import { join } from "node:path";

import {
  desktopUpdateChannel,
  resolveSynaraDesktopHomeDir,
  resolveSynaraDesktopFlavor,
  resolveSynaraDesktopRuntimeFlavor,
  canOverrideDesktopSmokeUserData,
  SYNARA_SOURCE_DESKTOP_BUILD_MARKER,
  SYNARA_BETA_BUNDLE_ID,
  SYNARA_BETA_DESKTOP_ENTRY_URL,
  SYNARA_BETA_DESKTOP_ORIGIN,
  SYNARA_CANARY_BUNDLE_ID,
  SYNARA_CANARY_DESKTOP_ENTRY_URL,
  SYNARA_CANARY_DESKTOP_ORIGIN,
  SYNARA_CUA_BUNDLE_ID,
  SYNARA_CUA_DESKTOP_ENTRY_URL,
  SYNARA_CUA_DESKTOP_ORIGIN,
  SYNARA_DESKTOP_ENTRY_URL,
  SYNARA_DESKTOP_ORIGIN,
  SYNARA_DESKTOP_UPDATE_CHANNEL,
  SYNARA_HOME_ENV,
  SYNARA_BETA_HOME_ENV,
  SYNARA_DEVELOPMENT_BUNDLE_ID,
  SYNARA_PRODUCTION_BUNDLE_ID,
  SYNARA_WORKBENCH_BUNDLE_ID,
  SYNARA_WORKBENCH_HOME_ENV,
  SYNARA_WORKBENCH_DESKTOP_ENTRY_URL,
  SYNARA_WORKBENCH_DESKTOP_ORIGIN,
  SYNARA_WORKBENCH_PREVIEW_BUNDLE_ID,
  SYNARA_WORKBENCH_PREVIEW_HOME_ENV,
  SYNARA_WORKBENCH_PREVIEW_DESKTOP_ENTRY_URL,
  SYNARA_WORKBENCH_PREVIEW_DESKTOP_ORIGIN,
  synaraDesktopIdentity,
} from "./desktopIdentity";

describe("desktopIdentity", () => {
  it("uses the exact canonical production and development bundle IDs", () => {
    expect(SYNARA_PRODUCTION_BUNDLE_ID).toBe("com.emanueledipietro.synara");
    expect(SYNARA_DEVELOPMENT_BUNDLE_ID).toBe("com.emanueledipietro.synara.dev");
    expect(synaraDesktopIdentity("production").bundleId).toBe(SYNARA_PRODUCTION_BUNDLE_ID);
    expect(synaraDesktopIdentity("development").bundleId).toBe(SYNARA_DEVELOPMENT_BUNDLE_ID);
  });

  it("uses the exact packaged renderer origin and entry URL", () => {
    expect(SYNARA_DESKTOP_ORIGIN).toBe("synara://app");
    expect(SYNARA_DESKTOP_ENTRY_URL).toBe("synara://app/index.html");
  });

  it("uses the isolated Synara desktop update channel", () => {
    expect(SYNARA_DESKTOP_UPDATE_CHANNEL).toBe("synara");
  });

  it("matches the beta update channel to prerelease tags and keeps synara otherwise", () => {
    expect(desktopUpdateChannel("beta")).toBe("beta");
    expect(desktopUpdateChannel("production")).toBe(SYNARA_DESKTOP_UPDATE_CHANNEL);
    expect(desktopUpdateChannel("canary")).toBe(SYNARA_DESKTOP_UPDATE_CHANNEL);
    expect(desktopUpdateChannel("development")).toBe(SYNARA_DESKTOP_UPDATE_CHANNEL);
  });

  it("gives Canary a fully separate desktop identity and storage profile", () => {
    expect(SYNARA_CANARY_BUNDLE_ID).toBe("com.emanueledipietro.synara.canary");
    expect(SYNARA_CANARY_DESKTOP_ORIGIN).toBe("synara-canary://app");
    expect(SYNARA_CANARY_DESKTOP_ENTRY_URL).toBe("synara-canary://app/index.html");
    expect(synaraDesktopIdentity("canary")).toEqual({
      flavor: "canary",
      displayName: "Synara Canary",
      bundleId: SYNARA_CANARY_BUNDLE_ID,
      scheme: "synara-canary",
      origin: SYNARA_CANARY_DESKTOP_ORIGIN,
      entryUrl: SYNARA_CANARY_DESKTOP_ENTRY_URL,
      userDataDirectoryName: "synara-canary",
      defaultHomeDirectoryName: ".synara-canary",
      usesScriptedUpdates: true,
    });
  });

  it("gives Cua a fully separate desktop identity and storage profile", () => {
    expect(SYNARA_CUA_BUNDLE_ID).toBe("com.emanueledipietro.synara.cua");
    expect(SYNARA_CUA_DESKTOP_ORIGIN).toBe("synara-cua://app");
    expect(SYNARA_CUA_DESKTOP_ENTRY_URL).toBe("synara-cua://app/index.html");
    expect(synaraDesktopIdentity("cua")).toEqual({
      flavor: "cua",
      displayName: "Synara Cua",
      bundleId: SYNARA_CUA_BUNDLE_ID,
      scheme: "synara-cua",
      origin: SYNARA_CUA_DESKTOP_ORIGIN,
      entryUrl: SYNARA_CUA_DESKTOP_ENTRY_URL,
      userDataDirectoryName: "synara-cua",
      defaultHomeDirectoryName: ".synara-cua",
      usesScriptedUpdates: true,
    });
  });

  it("gives Workbench and Preview separate identities, profiles, homes, and scripted updates", () => {
    expect(SYNARA_WORKBENCH_BUNDLE_ID).toBe("com.wylinx.workbench");
    expect(SYNARA_WORKBENCH_DESKTOP_ORIGIN).toBe("workbench://app");
    expect(SYNARA_WORKBENCH_DESKTOP_ENTRY_URL).toBe("workbench://app/index.html");
    expect(SYNARA_WORKBENCH_PREVIEW_BUNDLE_ID).toBe("com.wylinx.workbench.preview");
    expect(SYNARA_WORKBENCH_PREVIEW_DESKTOP_ORIGIN).toBe("workbench-preview://app");
    expect(SYNARA_WORKBENCH_PREVIEW_DESKTOP_ENTRY_URL).toBe("workbench-preview://app/index.html");
    expect(synaraDesktopIdentity("workbench")).toEqual({
      flavor: "workbench",
      displayName: "Personal Workbench",
      bundleId: SYNARA_WORKBENCH_BUNDLE_ID,
      scheme: "workbench",
      origin: SYNARA_WORKBENCH_DESKTOP_ORIGIN,
      entryUrl: SYNARA_WORKBENCH_DESKTOP_ENTRY_URL,
      userDataDirectoryName: "workbench",
      defaultHomeDirectoryName: ".synara-workbench",
      usesScriptedUpdates: true,
    });
    expect(synaraDesktopIdentity("workbench-preview")).toEqual({
      flavor: "workbench-preview",
      displayName: "Personal Workbench Preview",
      bundleId: SYNARA_WORKBENCH_PREVIEW_BUNDLE_ID,
      scheme: "workbench-preview",
      origin: SYNARA_WORKBENCH_PREVIEW_DESKTOP_ORIGIN,
      entryUrl: SYNARA_WORKBENCH_PREVIEW_DESKTOP_ENTRY_URL,
      userDataDirectoryName: "workbench-preview",
      defaultHomeDirectoryName: ".synara-workbench-preview",
      usesScriptedUpdates: true,
    });
  });

  it("gives Beta a fully separate desktop identity and storage profile", () => {
    expect(SYNARA_BETA_BUNDLE_ID).toBe("com.emanueledipietro.synara.beta");
    expect(SYNARA_BETA_DESKTOP_ORIGIN).toBe("synara-beta://app");
    expect(SYNARA_BETA_DESKTOP_ENTRY_URL).toBe("synara-beta://app/index.html");
    expect(synaraDesktopIdentity("beta")).toEqual({
      flavor: "beta",
      displayName: "Synara Beta",
      bundleId: SYNARA_BETA_BUNDLE_ID,
      scheme: "synara-beta",
      origin: SYNARA_BETA_DESKTOP_ORIGIN,
      entryUrl: SYNARA_BETA_DESKTOP_ENTRY_URL,
      userDataDirectoryName: "synara-beta",
      defaultHomeDirectoryName: ".synara-beta",
      usesScriptedUpdates: false,
    });
  });

  it("selects explicit source flavors without changing packaged Stable", () => {
    expect(resolveSynaraDesktopFlavor({ isDevelopment: false })).toBe("production");
    expect(resolveSynaraDesktopFlavor({ isDevelopment: true })).toBe("development");
    expect(
      resolveSynaraDesktopFlavor({ isDevelopment: false, requestedFlavor: "development" }),
    ).toBe("production");
    expect(
      resolveSynaraDesktopFlavor({
        isDevelopment: false,
        requestedFlavor: "development",
        allowDevelopmentOverride: true,
      }),
    ).toBe("development");
    expect(resolveSynaraDesktopFlavor({ isDevelopment: false, requestedFlavor: " canary " })).toBe(
      "canary",
    );
    expect(resolveSynaraDesktopFlavor({ isDevelopment: true, requestedFlavor: "canary" })).toBe(
      "canary",
    );
    expect(resolveSynaraDesktopFlavor({ isDevelopment: false, requestedFlavor: "workbench" })).toBe(
      "workbench",
    );
    expect(
      resolveSynaraDesktopFlavor({ isDevelopment: false, requestedFlavor: "workbench-preview" }),
    ).toBe("workbench-preview");
    expect(resolveSynaraDesktopFlavor({ isDevelopment: false, requestedFlavor: "cua" })).toBe(
      "cua",
    );
    expect(resolveSynaraDesktopFlavor({ isDevelopment: true, requestedFlavor: "CUA" })).toBe("cua");
    expect(resolveSynaraDesktopFlavor({ isDevelopment: false, requestedFlavor: "beta" })).toBe(
      "beta",
    );
    expect(resolveSynaraDesktopFlavor({ isDevelopment: false, requestedFlavor: " beta " })).toBe(
      "beta",
    );
    expect(resolveSynaraDesktopFlavor({ isDevelopment: true, requestedFlavor: "beta" })).toBe(
      "beta",
    );
  });

  it("isolates development and Canary homes from packaged Stable", () => {
    expect(synaraDesktopIdentity("development").defaultHomeDirectoryName).toBe(".synara-dev");
    expect(synaraDesktopIdentity("canary").defaultHomeDirectoryName).toBe(".synara-canary");
    expect(synaraDesktopIdentity("cua").defaultHomeDirectoryName).toBe(".synara-cua");
    expect(synaraDesktopIdentity("workbench").defaultHomeDirectoryName).toBe(".synara-workbench");
    expect(synaraDesktopIdentity("workbench-preview").defaultHomeDirectoryName).toBe(
      ".synara-workbench-preview",
    );
    expect(synaraDesktopIdentity("beta").defaultHomeDirectoryName).toBe(".synara-beta");
    expect(synaraDesktopIdentity("production").defaultHomeDirectoryName).toBe(".synara");
  });

  it.each(["production", "canary", "cua", "beta", "workbench", "workbench-preview"] as const)(
    "uses the immutable %s package flavor despite inherited source settings",
    (packagedFlavor) => {
      expect(
        resolveSynaraDesktopRuntimeFlavor({
          isPackaged: true,
          isDevelopment: true,
          packagedFlavor,
          requestedFlavor: "development",
          allowDevelopmentOverride: true,
        }),
      ).toBe(packagedFlavor);
    },
  );

  it("keeps legacy packaged Stable independent from a source shell's flavor", () => {
    expect(
      resolveSynaraDesktopRuntimeFlavor({
        isPackaged: true,
        isDevelopment: false,
        requestedFlavor: "cua",
      }),
    ).toBe("production");
  });

  it("preserves source launcher routing, including its bundled macOS bootstrap", () => {
    expect(
      resolveSynaraDesktopRuntimeFlavor({
        isPackaged: true,
        isDevelopment: false,
        requestedFlavor: "development",
        allowDevelopmentOverride: true,
      }),
    ).toBe("development");
    expect(
      resolveSynaraDesktopRuntimeFlavor({
        isPackaged: false,
        isDevelopment: true,
        requestedFlavor: "canary",
      }),
    ).toBe("canary");
  });

  it.each(["development", "CUA", null])(
    "rejects malformed packaged identity %j before opening any profile",
    (packagedFlavor) => {
      expect(() =>
        resolveSynaraDesktopRuntimeFlavor({
          isPackaged: true,
          isDevelopment: false,
          packagedFlavor,
        }),
      ).toThrow("packaged Synara desktop flavor is invalid");
    },
  );

  it("isolates smoke profiles only for source launches or isolated packages", () => {
    expect(canOverrideDesktopSmokeUserData({ packagedFlavor: "cua" })).toBe(true);
    expect(canOverrideDesktopSmokeUserData({ packagedFlavor: "beta" })).toBe(true);
    expect(
      canOverrideDesktopSmokeUserData({
        sourceBuildMarker: SYNARA_SOURCE_DESKTOP_BUILD_MARKER,
      }),
    ).toBe(true);
    for (const packagedFlavor of [
      "production",
      "canary",
      "workbench",
      "workbench-preview",
      "development",
      null,
    ]) {
      expect(
        canOverrideDesktopSmokeUserData({
          packagedFlavor,
          sourceBuildMarker: SYNARA_SOURCE_DESKTOP_BUILD_MARKER,
        }),
      ).toBe(false);
    }
    expect(canOverrideDesktopSmokeUserData({})).toBe(false);
  });
});

describe("resolveSynaraDesktopHomeDir", () => {
  it.each(["workbench", "workbench-preview"] as const)(
    "%s ignores inherited SYNARA_HOME and uses its isolated default",
    (flavor) => {
      const identity = synaraDesktopIdentity(flavor);
      expect(
        resolveSynaraDesktopHomeDir({
          flavor,
          homeDir: "/home/test",
          env: { [SYNARA_HOME_ENV]: "/stable-home" },
          joinPath: join,
        }),
      ).toBe(join("/home/test", identity.defaultHomeDirectoryName));
    },
  );

  it.each([
    ["workbench", SYNARA_WORKBENCH_HOME_ENV, "/tmp/custom-workbench"] as const,
    ["workbench-preview", SYNARA_WORKBENCH_PREVIEW_HOME_ENV, "/tmp/custom-preview"] as const,
  ])("honors the dedicated %s home override", (flavor, envName, customHome) => {
    expect(
      resolveSynaraDesktopHomeDir({
        flavor,
        homeDir: "/home/test",
        env: { [SYNARA_HOME_ENV]: "/stable-home", [envName]: customHome },
        joinPath: join,
      }),
    ).toBe(customHome);
  });

  it("preserves Stable and Beta home overrides", () => {
    expect(
      resolveSynaraDesktopHomeDir({
        flavor: "production",
        homeDir: "/home/test",
        env: { [SYNARA_HOME_ENV]: "/stable-home" },
        joinPath: join,
      }),
    ).toBe("/stable-home");
    expect(
      resolveSynaraDesktopHomeDir({
        flavor: "beta",
        homeDir: "/home/test",
        env: { [SYNARA_HOME_ENV]: "/stable-home", [SYNARA_BETA_HOME_ENV]: "/beta-home" },
        joinPath: join,
      }),
    ).toBe("/beta-home");
  });
});
