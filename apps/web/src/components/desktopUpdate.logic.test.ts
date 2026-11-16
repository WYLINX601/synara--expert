import { describe, expect, it } from "vitest";
import type { DesktopUpdateActionResult, DesktopUpdateState } from "@synara/contracts";

import {
  getDesktopUpdateActionError,
  getDesktopUpdateAlreadyCurrentNotice,
  getDesktopUpdateDownloadPercent,
  getDesktopUpdateErrorSignature,
  getDesktopUpdateRefusalNotice,
  isDesktopUpdateButtonDisabled,
  isDesktopUpdateDownloadOnClick,
  isDesktopUpdateInstallInFlight,
  resolveDesktopUpdateButtonAction,
  shouldRecommendManualDesktopDownload,
  shouldShowArm64IntelBuildWarning,
  shouldShowDesktopUpdateButton,
  shouldToastDesktopUpdateActionResult,
} from "./desktopUpdate.logic";

const baseState: DesktopUpdateState = {
  enabled: true,
  status: "idle",
  currentVersion: "1.0.0",
  hostArch: "x64",
  appArch: "x64",
  runningUnderArm64Translation: false,
  availableVersion: null,
  downloadedVersion: null,
  downloadPercent: null,
  checkedAt: null,
  message: null,
  errorContext: null,
  canRetry: false,
  installFailureCount: 0,
  flavor: "production",
  releaseUrl: null,
};

describe("desktop update button state", () => {
  it("hides the button when idle (no update available)", () => {
    expect(shouldShowDesktopUpdateButton(baseState)).toBe(false);
    expect(resolveDesktopUpdateButtonAction(baseState)).toBe("check");
  });

  it("shows a download action when an update is available", () => {
    const state: DesktopUpdateState = {
      ...baseState,
      status: "available",
      availableVersion: "1.1.0",
    };
    expect(shouldShowDesktopUpdateButton(state)).toBe(true);
    expect(resolveDesktopUpdateButtonAction(state)).toBe("download");
    expect(isDesktopUpdateButtonDisabled(state)).toBe(true);
  });

  it("keeps retry action available after a download error", () => {
    const state: DesktopUpdateState = {
      ...baseState,
      status: "error",
      availableVersion: "1.1.0",
      message: "network timeout",
      errorContext: "download",
      canRetry: true,
    };
    expect(shouldShowDesktopUpdateButton(state)).toBe(true);
    expect(resolveDesktopUpdateButtonAction(state)).toBe("download");
    expect(isDesktopUpdateButtonDisabled(state)).toBe(false);
  });

  it("keeps install action available after an install error", () => {
    const state: DesktopUpdateState = {
      ...baseState,
      status: "error",
      downloadedVersion: "1.1.0",
      availableVersion: "1.1.0",
      message: "shutdown timeout",
      errorContext: "install",
      canRetry: true,
    };
    expect(shouldShowDesktopUpdateButton(state)).toBe(true);
    expect(resolveDesktopUpdateButtonAction(state)).toBe("install");
  });

  it("rebuilds updater state after a failed install restart", () => {
    const state: DesktopUpdateState = {
      ...baseState,
      status: "error",
      availableVersion: "1.1.0",
      downloadedVersion: null,
      message: "Synara restarted before the update was installed.",
      errorContext: "install",
      canRetry: true,
      installFailureCount: 1,
    };

    expect(resolveDesktopUpdateButtonAction(state)).toBe("download");
    expect(isDesktopUpdateButtonDisabled(state)).toBe(false);
  });

  it("keeps update errors with known versions actionable even when context is missing", () => {
    expect(
      resolveDesktopUpdateButtonAction({
        ...baseState,
        status: "error",
        availableVersion: "1.1.0",
        downloadedVersion: "1.1.0",
        message: "native updater failed",
        errorContext: null,
        canRetry: true,
      }),
    ).toBe("install");

    expect(
      resolveDesktopUpdateButtonAction({
        ...baseState,
        status: "error",
        availableVersion: "1.1.0",
        message: "native updater failed",
        errorContext: null,
        canRetry: true,
      }),
    ).toBe("download");
  });

  it("hides the button for non-actionable check errors", () => {
    const state: DesktopUpdateState = {
      ...baseState,
      status: "error",
      message: "network unavailable",
      errorContext: "check",
      canRetry: true,
    };
    expect(shouldShowDesktopUpdateButton(state)).toBe(false);
    expect(resolveDesktopUpdateButtonAction(state)).toBe("check");
  });

  it("hides non-actionable update errors without a known version", () => {
    const state: DesktopUpdateState = {
      ...baseState,
      status: "error",
      message: "native updater failed",
      errorContext: "install",
      canRetry: false,
    };

    expect(resolveDesktopUpdateButtonAction(state)).toBe("none");
    expect(shouldShowDesktopUpdateButton(state)).toBe(false);
  });

  it("disables the button while downloading", () => {
    const state: DesktopUpdateState = {
      ...baseState,
      status: "downloading",
      availableVersion: "1.1.0",
      downloadPercent: 42.5,
    };
    expect(shouldShowDesktopUpdateButton(state)).toBe(true);
    expect(isDesktopUpdateButtonDisabled(state)).toBe(true);
    expect(getDesktopUpdateDownloadPercent(state)).toBe(42);
  });

  it("keeps an installation visible but disables another action", () => {
    const state: DesktopUpdateState = {
      ...baseState,
      flavor: "workbench",
      status: "installing",
      downloadedVersion: "1.1.0",
      availableVersion: "1.1.0",
    };
    expect(shouldShowDesktopUpdateButton(state)).toBe(true);
    expect(isDesktopUpdateButtonDisabled(state)).toBe(true);
    expect(resolveDesktopUpdateButtonAction(state)).toBe("none");
    expect(getDesktopUpdateDownloadPercent(state)).toBeNull();
  });

  it("surfaces a clamped integer download percentage only while downloading", () => {
    expect(getDesktopUpdateDownloadPercent(null)).toBeNull();
    expect(
      getDesktopUpdateDownloadPercent({
        ...baseState,
        status: "downloading",
        downloadPercent: null,
      }),
    ).toBeNull();
    expect(
      getDesktopUpdateDownloadPercent({
        ...baseState,
        status: "downloading",
        downloadPercent: 37.9,
      }),
    ).toBe(37);
    expect(
      getDesktopUpdateDownloadPercent({
        ...baseState,
        status: "downloading",
        downloadPercent: 126.9,
      }),
    ).toBe(100);
    expect(
      getDesktopUpdateDownloadPercent({ ...baseState, status: "downloading", downloadPercent: -8 }),
    ).toBe(0);
    // Percentage stays hidden outside the active download (e.g. ready to install).
    expect(
      getDesktopUpdateDownloadPercent({ ...baseState, status: "downloaded", downloadPercent: 100 }),
    ).toBeNull();
  });

  it("keeps update checks hidden while a check is in flight", () => {
    const state: DesktopUpdateState = {
      ...baseState,
      status: "checking",
    };

    expect(shouldShowDesktopUpdateButton(state)).toBe(false);
    expect(resolveDesktopUpdateButtonAction(state)).toBe("check");
    expect(isDesktopUpdateButtonDisabled(state)).toBe(true);
  });

  it("keeps available/downloaded failure retries actionable", () => {
    const downloadFailure: DesktopUpdateState = {
      ...baseState,
      status: "available",
      availableVersion: "1.1.0",
      message: "checksum mismatch",
      errorContext: "download",
      canRetry: true,
    };
    expect(resolveDesktopUpdateButtonAction(downloadFailure)).toBe("download");
    expect(isDesktopUpdateButtonDisabled(downloadFailure)).toBe(false);

    const installFailure: DesktopUpdateState = {
      ...baseState,
      status: "downloaded",
      downloadedVersion: "1.1.0",
      availableVersion: "1.1.0",
      message: "shutdown timeout",
      errorContext: "install",
      canRetry: true,
    };
    expect(resolveDesktopUpdateButtonAction(installFailure)).toBe("install");
    expect(isDesktopUpdateButtonDisabled(installFailure)).toBe(false);
  });
});

describe("getDesktopUpdateActionError", () => {
  it("returns user-visible message for accepted failed attempts", () => {
    const result: DesktopUpdateActionResult = {
      accepted: true,
      completed: false,
      state: {
        ...baseState,
        status: "available",
        availableVersion: "1.1.0",
        message: "checksum mismatch",
        errorContext: "download",
        canRetry: true,
      },
    };
    expect(getDesktopUpdateActionError(result)).toBe("checksum mismatch");
  });

  it("ignores messages for non-accepted attempts", () => {
    const result: DesktopUpdateActionResult = {
      accepted: false,
      completed: false,
      state: {
        ...baseState,
        status: "error",
        message: "background failure",
        errorContext: "check",
        canRetry: false,
      },
    };
    expect(getDesktopUpdateActionError(result)).toBeNull();
  });
});

describe("getDesktopUpdateAlreadyCurrentNotice", () => {
  it("returns null when the version was genuinely actionable", () => {
    const result: DesktopUpdateActionResult = {
      accepted: true,
      completed: false,
      state: {
        ...baseState,
        status: "available",
        availableVersion: "1.1.0",
        message: "checksum mismatch",
        errorContext: "download",
      },
    };
    expect(getDesktopUpdateAlreadyCurrentNotice(result)).toBeNull();
  });
});

describe("isDesktopUpdateInstallInFlight", () => {
  it("keeps an accepted install latched while the updater still reports downloaded", () => {
    const result: DesktopUpdateActionResult = {
      accepted: true,
      completed: false,
      state: {
        ...baseState,
        status: "downloaded",
        downloadedVersion: "1.1.0",
        availableVersion: "1.1.0",
      },
    };
    expect(isDesktopUpdateInstallInFlight(result)).toBe(true);
  });

  it("keeps an actual installation latched after the download action completes", () => {
    expect(
      isDesktopUpdateInstallInFlight({
        accepted: true,
        completed: true,
        state: {
          ...baseState,
          flavor: "workbench",
          status: "installing",
          downloadedVersion: "1.1.0",
        },
      }),
    ).toBe(true);
  });

  it("clears for rejected, completed, or already-failed installs", () => {
    expect(
      isDesktopUpdateInstallInFlight({
        accepted: false,
        completed: false,
        state: {
          ...baseState,
          status: "downloaded",
          downloadedVersion: "1.1.0",
        },
      }),
    ).toBe(false);
    expect(
      isDesktopUpdateInstallInFlight({
        accepted: true,
        completed: true,
        state: {
          ...baseState,
          status: "downloaded",
          downloadedVersion: "1.1.0",
        },
      }),
    ).toBe(false);
    // Both an immediate handoff failure and the watchdog preserve the artifact
    // as downloaded so Retry can install it without downloading again.
    const failedState: DesktopUpdateState = {
      ...baseState,
      status: "downloaded",
      downloadedVersion: "1.1.0",
      errorContext: "install",
      message: "Backend did not stop in time",
      canRetry: true,
    };
    expect(
      isDesktopUpdateInstallInFlight({
        accepted: true,
        completed: false,
        state: failedState,
      }),
    ).toBe(false);
  });
});

describe("desktop update UI helpers", () => {
  it("toasts only for accepted incomplete actions", () => {
    expect(
      shouldToastDesktopUpdateActionResult({
        accepted: true,
        completed: false,
        state: baseState,
      }),
    ).toBe(true);
    expect(
      shouldToastDesktopUpdateActionResult({
        accepted: true,
        completed: true,
        state: baseState,
      }),
    ).toBe(false);
  });

  it("recommends a manual download after repeated install failures", () => {
    expect(
      shouldRecommendManualDesktopDownload({
        ...baseState,
        installFailureCount: 2,
        releaseUrl: "https://example.com/releases",
      }),
    ).toBe(true);
    expect(
      shouldRecommendManualDesktopDownload({
        ...baseState,
        installFailureCount: 1,
        releaseUrl: "https://example.com/releases",
      }),
    ).toBe(false);
    expect(
      shouldRecommendManualDesktopDownload({
        ...baseState,
        installFailureCount: 3,
        releaseUrl: null,
      }),
    ).toBe(false);
  });

  it("includes the install failure count in error signatures", () => {
    const failedState = {
      ...baseState,
      status: "error" as const,
      availableVersion: "1.1.0",
      errorContext: "install" as const,
      message: "Install failed",
    };

    expect(getDesktopUpdateErrorSignature({ ...failedState, installFailureCount: 1 })).not.toBe(
      getDesktopUpdateErrorSignature({ ...failedState, installFailureCount: 2 }),
    );
  });

  it("shows an Apple Silicon warning for Intel builds under Rosetta", () => {
    const state: DesktopUpdateState = {
      ...baseState,
      hostArch: "arm64",
      appArch: "x64",
      runningUnderArm64Translation: true,
    };

    expect(shouldShowArm64IntelBuildWarning(state)).toBe(true);
  });
});

// The workbench (Linx) flavor never downloads in the background: its `available`
// state is a click-to-download action and its copy must not claim preparation.
describe("workbench click-to-download updates", () => {
  const workbenchAvailable: DesktopUpdateState = {
    ...baseState,
    flavor: "workbench",
    status: "available",
    availableVersion: "1.1.0",
  };

  it("keeps the available state clickable", () => {
    expect(isDesktopUpdateDownloadOnClick(workbenchAvailable)).toBe(true);
    expect(isDesktopUpdateDownloadOnClick({ ...baseState, flavor: "production" })).toBe(false);
    expect(shouldShowDesktopUpdateButton(workbenchAvailable)).toBe(true);
    expect(resolveDesktopUpdateButtonAction(workbenchAvailable)).toBe("download");
    expect(isDesktopUpdateButtonDisabled(workbenchAvailable)).toBe(false);
    expect(isDesktopUpdateButtonDisabled({ ...baseState, status: "available" })).toBe(true);
  });

  it("describes a failed download as a download failure", () => {
    const failed: DesktopUpdateState = {
      ...workbenchAvailable,
      status: "error",
      errorContext: "download",
      message: "socket hang up",
      canRetry: true,
    };

    expect(isDesktopUpdateButtonDisabled(failed)).toBe(false);
    expect(resolveDesktopUpdateButtonAction(failed)).toBe("download");
  });

  it("surfaces the explanatory message of a refused install", () => {
    const refused: DesktopUpdateActionResult = {
      accepted: false,
      completed: false,
      state: {
        ...workbenchAvailable,
        status: "downloaded",
        downloadedVersion: "1.1.0",
        message: "Installing arrives later.",
      },
    };

    expect(getDesktopUpdateRefusalNotice(refused)).toBe("Installing arrives later.");
    expect(getDesktopUpdateRefusalNotice({ ...refused, accepted: true })).toBeNull();
    expect(
      getDesktopUpdateRefusalNotice({ ...refused, state: { ...refused.state, message: "  " } }),
    ).toBeNull();
  });

  it("surfaces install refusal instead of download success after one click", () => {
    const result: DesktopUpdateActionResult = {
      accepted: true,
      completed: true,
      state: {
        ...workbenchAvailable,
        status: "downloaded",
        downloadedVersion: "1.1.0",
        errorContext: "install",
        message: "Finish the current task before installing.",
      },
    };
    expect(getDesktopUpdateRefusalNotice(result)).toBe(result.state.message);
    expect(isDesktopUpdateInstallInFlight(result)).toBe(false);
  });

  it("still accepts a retry click after a failed download", () => {
    const failed: DesktopUpdateState = {
      ...workbenchAvailable,
      status: "error",
      errorContext: "download",
      canRetry: true,
    };

    expect(shouldShowDesktopUpdateButton(failed)).toBe(true);
    expect(getDesktopUpdateErrorSignature(failed)).not.toBeNull();
  });
});
