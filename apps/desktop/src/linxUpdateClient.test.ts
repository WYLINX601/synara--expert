import { createHash, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DesktopUpdateState } from "@synara/contracts";

import {
  EMPTY_LINX_UPDATE_CHECK_RECORD,
  LinxUpdateClient,
  parseLinxUpdateCheckRecord,
  type LinxUpdateCheckRecord,
  type LinxUpdateClientOptions,
} from "./linxUpdateClient";
import {
  LinxUpdateDownloadError,
  type LinxUpdateDownloadOptions,
  type LinxUpdateDownloadResult,
} from "./linxUpdateDownload";
import { LinxUpdateFeedError } from "./linxUpdateFeed";
import type { LinxUpdateSource } from "./linxUpdateSource";
import { createInitialDesktopUpdateState } from "./updateMachine";

interface Signer {
  readonly keyId: string;
  readonly key: KeyObject;
  readonly signManifest: (bytes: Buffer) => Buffer;
}

function createSigner(): Signer {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const der = publicKey.export({ format: "der", type: "spki" });
  const keyId = createHash("sha256").update(der).digest("hex").slice(0, 16);
  return {
    keyId,
    key: publicKey,
    signManifest: (bytes) => sign(null, bytes, privateKey),
  };
}

function manifestFor(signer: Signer, overrides: Partial<Record<string, unknown>> = {}): Buffer {
  return Buffer.from(
    JSON.stringify({
      schemaVersion: 1,
      productId: "linx",
      installIdentity: "com.wylinx.linx",
      channel: "stable",
      platform: "darwin",
      arch: "arm64",
      version: "0.2.0",
      sourceCommit: "a".repeat(40),
      minOSVersion: "13.0",
      assetName: "linx-0.2.0.zip",
      assetUrl: "https://github.com/owner/repo/releases/download/v0.2.0/linx-0.2.0.zip",
      size: 1234,
      sha256: "b".repeat(64),
      keyId: signer.keyId,
      ...overrides,
    }),
  );
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

interface HarnessOptions {
  readonly manifest?: (signer: Signer) => Buffer;
  readonly signature?: (signer: Signer, manifest: Buffer) => Buffer;
  /** Successive signature bodies; the last one repeats for further fetches. */
  readonly signatureSequence?: (signer: Signer, manifest: Buffer) => readonly Buffer[];
  readonly fetchError?: unknown;
  readonly download?: (input: LinxUpdateDownloadOptions) => Promise<LinxUpdateDownloadResult>;
  readonly install?: LinxUpdateClientOptions["install"];
  readonly stagingDir?: string;
  readonly pollIntervalMs?: number;
}

interface Harness {
  readonly client: LinxUpdateClient;
  state(): DesktopUpdateState;
  patchState(patch: Partial<DesktopUpdateState>): void;
  record(): LinxUpdateCheckRecord;
  bumps(): number;
  fetchCalls(): string[];
  downloadCalls(): number;
  advanceClock(ms: number): void;
}

function createHarness(options: HarnessOptions = {}): Harness {
  const signer = createSigner();
  const source: LinxUpdateSource = {
    repository: "owner/repo",
    keyRing: new Map([[signer.keyId, signer.key]]),
    manifestUrl: "https://github.com/owner/repo/releases/latest/download/linx-update.json",
    signatureUrl: "https://github.com/owner/repo/releases/latest/download/linx-update.json.sig",
    releaseUrl: "https://github.com/owner/repo/releases/latest",
    allowedAssetHosts: ["github.com", "objects.githubusercontent.com"],
  };

  let state: DesktopUpdateState = {
    ...createInitialDesktopUpdateState(
      "0.1.0",
      { hostArch: "arm64", appArch: "arm64", runningUnderArm64Translation: false },
      "workbench",
    ),
    enabled: true,
    status: "idle",
  };
  let stored: LinxUpdateCheckRecord = EMPTY_LINX_UPDATE_CHECK_RECORD;
  const manifest = options.manifest?.(signer) ?? manifestFor(signer);
  const signature =
    options.signature?.(signer, manifest) ??
    Buffer.from(signer.signManifest(manifest).toString("base64"));
  const signatures = [...(options.signatureSequence?.(signer, manifest) ?? [signature])];
  let clock = new Date("2026-11-13T00:00:00.000Z");
  const calls: string[] = [];
  let downloads = 0;
  let patches = 0;

  const client = new LinxUpdateClient({
    source,
    currentVersion: "0.1.0",
    stagingDir: options.stagingDir ?? join(tmpdir(), "linx-client-unused"),
    getUpdateState: () => state,
    setUpdateState: (patch) => {
      patches += 1;
      state = { ...state, ...patch };
    },
    readCheckRecord: () => stored,
    writeCheckRecord: (record) => {
      stored = record;
    },
    install:
      options.install ??
      (async () => ({ accepted: false, completed: false, message: "Fixture busy work" })),
    installFailureMessage: "Fixture installation failure",
    now: () => new Date(clock.getTime()),
    fetchBytes: async (url) => {
      calls.push(url);
      if (options.fetchError !== undefined) throw options.fetchError;
      const entry = JSON.parse(manifest.toString("utf8")) as {
        version: string;
        sourceCommit: string;
        assetName: string;
        assetUrl: string;
        size: number;
      };
      if (url.includes("/git/ref/tags/")) {
        return Buffer.from(
          JSON.stringify({
            ref: `refs/tags/v${entry.version}`,
            object: { type: "commit", sha: entry.sourceCommit },
          }),
        );
      }
      if (url.includes("/releases/tags/")) {
        const base = `https://github.com/owner/repo/releases/download/v${entry.version}/`;
        return Buffer.from(
          JSON.stringify({
            id: 100,
            tag_name: `v${entry.version}`,
            draft: false,
            prerelease: false,
            published_at: "2026-11-13T00:00:00Z",
            html_url: `https://github.com/owner/repo/releases/tag/v${entry.version}`,
            assets: [
              {
                id: 101,
                name: entry.assetName,
                size: entry.size,
                state: "uploaded",
                browser_download_url: entry.assetUrl,
              },
              {
                id: 102,
                name: "linx-update.json",
                size: manifest.length,
                state: "uploaded",
                browser_download_url: `${base}linx-update.json`,
              },
              {
                id: 103,
                name: "linx-update.json.sig",
                size: signature.length,
                state: "uploaded",
                browser_download_url: `${base}linx-update.json.sig`,
              },
            ],
          }),
        );
      }
      if (!url.endsWith(".sig")) return manifest;
      return signatures.length > 1 ? (signatures.shift() as Buffer) : (signatures[0] as Buffer);
    },
    downloadAsset: async (input) => {
      downloads += 1;
      if (options.download !== undefined) return options.download(input);
      return {
        filePath: join(input.stagingDir, input.target.assetName),
        size: 1234,
        sha256: "b".repeat(64),
      };
    },
    log: () => {},
    ...(options.pollIntervalMs === undefined ? {} : { pollIntervalMs: options.pollIntervalMs }),
  });

  return {
    client,
    state: () => state,
    patchState: (patch) => {
      state = { ...state, ...patch };
    },
    record: () => stored,
    bumps: () => patches,
    fetchCalls: () => calls,
    downloadCalls: () => downloads,
    advanceClock: (ms) => {
      clock = new Date(clock.getTime() + ms);
    },
  };
}

let stagingDir: string;

beforeEach(async () => {
  stagingDir = await mkdtemp(join(tmpdir(), "linx-client-"));
});

afterEach(async () => {
  vi.useRealTimers();
  await rm(stagingDir, { force: true, recursive: true });
});

describe("LinxUpdateClient checks", () => {
  it("publishes an available version from a verified manifest without downloading", async () => {
    const harness = createHarness();

    await harness.client.checkManually();

    const state = harness.state();
    expect(state.status).toBe("available");
    expect(state.availableVersion).toBe("0.2.0");
    expect(state.checkedAt).toBe("2026-11-13T00:00:00.000Z");
    expect(state.errorContext).toBeNull();
    expect(harness.fetchCalls()).toHaveLength(2);
    expect(harness.downloadCalls()).toBe(0);
  });

  it("reports up-to-date when the manifest is not newer", async () => {
    const harness = createHarness({
      manifest: (signer) => manifestFor(signer, { version: "0.1.0" }),
    });

    await harness.client.checkManually();

    expect(harness.state().status).toBe("up-to-date");
    expect(harness.state().availableVersion).toBeNull();
  });

  it("refetches the manifest/signature pair once when a publish races the check", async () => {
    const harness = createHarness({
      // First response is a signature over different bytes (a mid-publish pair),
      // the refetch returns the matching signature.
      signatureSequence: (signer, manifestBytes) => [
        Buffer.from(Buffer.alloc(64).toString("base64")),
        Buffer.from(signer.signManifest(manifestBytes).toString("base64")),
      ],
    });

    await harness.client.checkManually();

    expect(harness.fetchCalls()).toHaveLength(4);
    expect(harness.state().status).toBe("available");
    expect(harness.state().availableVersion).toBe("0.2.0");
  });

  it("reports a persistent signature rejection only after one refetch", async () => {
    const harness = createHarness({
      signature: () => Buffer.from(Buffer.alloc(64).toString("base64")),
    });

    await harness.client.checkManually();

    expect(harness.fetchCalls()).toHaveLength(4);
    expect(harness.state().status).toBe("error");
    expect(harness.state().message).toContain("signature");
  });

  it("refetches once and still reports a key mismatch", async () => {
    const harness = createHarness({
      manifest: (signer) => manifestFor(signer, { keyId: "0".repeat(16) }),
    });

    await harness.client.checkManually();

    expect(harness.fetchCalls()).toHaveLength(4);
    expect(harness.state().status).toBe("error");
    expect(harness.state().message).toContain("key");
  });

  it("keeps the last successful result when verification fails", async () => {
    const harness = createHarness({
      signature: () => Buffer.from(Buffer.alloc(64).toString("base64")),
    });
    harness.patchState({
      status: "available",
      availableVersion: "0.2.0",
      checkedAt: "2026-11-01T00:00:00.000Z",
    });

    await harness.client.checkManually();

    const state = harness.state();
    expect(state.status).toBe("error");
    expect(state.errorContext).toBe("check");
    expect(state.availableVersion).toBe("0.2.0");
    expect(state.checkedAt).toBe("2026-11-01T00:00:00.000Z");
    expect(state.message).toContain("signature");
  });

  it("records state only for an automatic failure and honours Retry-After", async () => {
    const harness = createHarness({
      fetchError: new LinxUpdateFeedError("status", "Update request failed with HTTP 429.", {
        statusCode: 429,
        retryAfterMs: 60_000,
      }),
    });

    await harness.client.checkAutomatically("poll");

    const state = harness.state();
    expect(state.status).toBe("error");
    expect(state.errorContext).toBe("check");
    expect(state.message).toBeNull();
    expect(harness.record().retryAfterUntil).toBe("2026-11-13T00:01:00.000Z");
  });

  it("gates every automatic reason on a persisted rate limit", async () => {
    const limited = createHarness({
      fetchError: new LinxUpdateFeedError("status", "HTTP 429", {
        statusCode: 429,
        retryAfterMs: 60_000,
      }),
    });
    await limited.client.checkAutomatically("poll");
    expect(limited.record().retryAfterUntil).toBe("2026-11-13T00:01:00.000Z");

    // Inside the retry window no automatic trigger reaches the network.
    await limited.client.checkAutomatically("startup");
    await limited.client.checkAutomatically("foreground");
    expect(limited.fetchCalls()).toHaveLength(2);

    // Once the window passes, automatic checks resume.
    limited.advanceClock(60_000);
    await limited.client.checkAutomatically("startup");
    expect(limited.fetchCalls()).toHaveLength(4);

    // A manual check is never gated.
    await limited.client.checkManually();
    expect(limited.fetchCalls()).toHaveLength(6);
  });

  it("keeps a five-minute floor on foreground checks from the persisted attempt", async () => {
    const harness = createHarness();
    await harness.client.checkManually();
    expect(harness.fetchCalls()).toHaveLength(2);

    harness.advanceClock(60 * 1000);
    await harness.client.checkAutomatically("foreground");
    expect(harness.fetchCalls()).toHaveLength(2);

    harness.advanceClock(5 * 60 * 1000);
    await harness.client.checkAutomatically("foreground");
    expect(harness.fetchCalls()).toHaveLength(4);
  });

  it("arms the next poll when a trigger joins an in-flight check", async () => {
    vi.useFakeTimers();
    const harness = createHarness();

    const manual = harness.client.checkManually();
    const joined = harness.client.checkAutomatically("startup");

    expect(joined).toBe(manual);
    await joined;
    expect(harness.fetchCalls()).toHaveLength(2);

    // The joined trigger owns no run of its own, so only its completion can arm
    // the next poll; without that the cadence would vanish for the session.
    harness.advanceClock(6 * 60 * 60 * 1000 + 1_000);
    await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000);
    expect(harness.fetchCalls()).toHaveLength(4);
  });

  it("shares one in-flight request between manual and automatic triggers", async () => {
    const harness = createHarness();

    const manual = harness.client.checkManually();
    const polling = harness.client.checkAutomatically("poll");

    expect(polling).toBe(manual);
    await manual;
    expect(harness.fetchCalls()).toHaveLength(2);
    expect(harness.bumps()).toBe(2);
  });

  it("does not let a recorded attempt suppress the startup check", async () => {
    const harness = createHarness({ pollIntervalMs: 6 * 60 * 60 * 1000 });
    await harness.client.checkManually();
    expect(harness.fetchCalls()).toHaveLength(2);

    // A relaunch minutes later still checks: only `retryAfterUntil` gates startup.
    harness.advanceClock(60 * 1000);
    await harness.client.checkAutomatically("startup");
    expect(harness.fetchCalls()).toHaveLength(4);
  });

  it("arms a delayed startup check and the recurring interval", async () => {
    vi.useFakeTimers();
    const harness = createHarness();

    harness.client.start();
    await vi.advanceTimersByTimeAsync(59_000);
    expect(harness.fetchCalls()).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(harness.fetchCalls()).toHaveLength(2);

    // The next run is scheduled from the completed check, so each 6 h tick counts.
    harness.advanceClock(6 * 60 * 60 * 1000 + 1_000);
    await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000);
    expect(harness.fetchCalls()).toHaveLength(4);

    harness.advanceClock(6 * 60 * 60 * 1000);
    await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000);
    expect(harness.fetchCalls()).toHaveLength(6);
  });
});

describe("LinxUpdateClient downloads", () => {
  it("pins the target and completes only after the downloader verifies it", async () => {
    const harness = createHarness({
      download: async (input) => {
        input.onProgress?.(42);
        return {
          filePath: join(input.stagingDir, input.target.assetName),
          size: 1234,
          sha256: "b".repeat(64),
        };
      },
    });
    await harness.client.checkManually();

    const result = await harness.client.download();

    expect(result).toEqual({ accepted: true, completed: true });
    expect(harness.state().status).toBe("downloaded");
    expect(harness.state().downloadedVersion).toBe("0.2.0");
    expect(harness.state().downloadPercent).toBe(100);
    expect(harness.downloadCalls()).toBe(1);
  });

  it("returns to available with a download error when verification fails", async () => {
    const harness = createHarness({
      download: async () => {
        throw new LinxUpdateDownloadError("sha256", "Downloaded package digest does not match.");
      },
    });
    await harness.client.checkManually();

    const result = await harness.client.download();

    expect(result).toEqual({ accepted: true, completed: false });
    const state = harness.state();
    expect(state.status).toBe("error");
    expect(state.errorContext).toBe("download");
    expect(state.availableVersion).toBe("0.2.0");
    expect(state.downloadedVersion).toBeNull();
    expect(state.canRetry).toBe(true);
    expect(state.message).toContain("digest");
  });

  it("retries the same pinned target after a failed download", async () => {
    let attempts = 0;
    const harness = createHarness({
      download: async (input) => {
        attempts += 1;
        if (attempts === 1) {
          throw new LinxUpdateDownloadError("network", "socket hang up");
        }
        return {
          filePath: join(input.stagingDir, input.target.assetName),
          size: 1234,
          sha256: "b".repeat(64),
        };
      },
    });
    await harness.client.checkManually();

    expect(await harness.client.download()).toEqual({ accepted: true, completed: false });
    expect(harness.state().status).toBe("error");

    expect(await harness.client.download()).toEqual({ accepted: true, completed: true });
    expect(harness.state().status).toBe("downloaded");
    expect(harness.downloadCalls()).toBe(2);
  });

  it("ignores a second click while a download is running", async () => {
    const downloaded = deferred<LinxUpdateDownloadResult>();
    const started = deferred<void>();
    const harness = createHarness({
      download: () => {
        started.resolve();
        return downloaded.promise;
      },
    });
    await harness.client.checkManually();

    const first = harness.client.download();
    await started.promise;
    const second = await harness.client.download();

    expect(second).toEqual({ accepted: false, completed: false });
    expect(harness.downloadCalls()).toBe(1);

    downloaded.resolve({
      filePath: join(stagingDir, "linx-0.2.0.zip"),
      size: 1234,
      sha256: "b".repeat(64),
    });
    await expect(first).resolves.toEqual({ accepted: true, completed: true });
  });

  it("reports an already downloaded artifact without downloading again", async () => {
    const harness = createHarness();
    await harness.client.checkManually();
    await harness.client.download();

    const again = await harness.client.download();

    expect(again).toEqual({ accepted: false, completed: true });
    expect(harness.downloadCalls()).toBe(1);
  });

  it("does not re-check while a verified package is waiting", async () => {
    const harness = createHarness();
    await harness.client.checkManually();
    await harness.client.download();
    expect(harness.state().status).toBe("downloaded");
    const callsBefore = harness.fetchCalls().length;

    await harness.client.checkManually();
    await harness.client.checkAutomatically("poll");

    expect(harness.state().status).toBe("downloaded");
    expect(harness.fetchCalls().length).toBe(callsBefore);
  });

  it("refuses a download with no pinned target", async () => {
    const harness = createHarness();
    harness.patchState({ status: "available", availableVersion: "0.2.0" });

    const result = await harness.client.download();

    expect(result).toEqual({ accepted: false, completed: false });
    expect(harness.downloadCalls()).toBe(0);
  });

  it("aborts the transfer and clears staging on dispose", async () => {
    const downloaded = deferred<LinxUpdateDownloadResult>();
    const started = deferred<void>();
    let signal: AbortSignal | undefined;
    const harness = createHarness({
      stagingDir,
      download: (input) => {
        signal = input.signal;
        started.resolve();
        return downloaded.promise;
      },
    });
    await harness.client.checkManually();
    await writeFile(join(stagingDir, "linx-0.2.0.zip.partial"), "partial", "utf8");

    const inFlight = harness.client.download();
    await started.promise;
    await harness.client.dispose();

    expect(signal?.aborted).toBe(true);
    downloaded.reject(new LinxUpdateDownloadError("aborted", "cancelled"));
    await expect(inFlight).resolves.toEqual({ accepted: true, completed: false });
    await expect(stat(stagingDir)).rejects.toThrow();
    expect(harness.state().status).not.toBe("downloaded");
  });

  it("keeps a busy package for a fresh explicit install click without another download", async () => {
    let attempts = 0;
    const harness = createHarness({
      install: async () => {
        attempts += 1;
        return { accepted: false, completed: false, message: "Busy work" };
      },
    });
    await harness.client.checkManually();
    await harness.client.download();
    expect(harness.state()).toMatchObject({
      status: "downloaded",
      downloadedVersion: "0.2.0",
      errorContext: "install",
      canRetry: true,
    });
    expect(attempts).toBe(1);
    await harness.client.checkAutomatically("foreground");
    expect(attempts).toBe(1);
    await harness.client.install();
    expect(attempts).toBe(2);
    expect(harness.downloadCalls()).toBe(1);
  });

  it("does not install a version asserted only by UI state", async () => {
    let attempts = 0;
    const harness = createHarness({
      install: async () => {
        attempts += 1;
        return { accepted: false, completed: false, message: null };
      },
    });
    harness.patchState({ status: "downloaded", downloadedVersion: "0.2.0" });
    expect(await harness.client.install()).toEqual({ accepted: false, completed: false });
    expect(attempts).toBe(0);
  });

  it("retains staged bytes only after a matching active handoff", async () => {
    let harness: Harness;
    harness = createHarness({
      stagingDir,
      install: async ({ target }) => {
        expect(() => harness.client.claimInstallHandoff("0".repeat(64))).toThrow();
        harness.client.claimInstallHandoff(target.manifestDigest);
        return { accepted: true, completed: false, message: null };
      },
    });
    await writeFile(join(stagingDir, "linx-0.2.0.zip"), "preserved");
    await harness.client.checkManually();
    await harness.client.download();
    await harness.client.dispose();
    expect((await stat(join(stagingDir, "linx-0.2.0.zip"))).size).toBe(9);
  });
});

describe("parseLinxUpdateCheckRecord", () => {
  it("reads a persisted record", () => {
    expect(
      parseLinxUpdateCheckRecord(
        JSON.stringify({
          lastAttemptAt: "2026-11-13T00:00:00.000Z",
          retryAfterUntil: null,
        }),
      ),
    ).toEqual({ lastAttemptAt: "2026-11-13T00:00:00.000Z", retryAfterUntil: null });
  });

  it("degrades corrupt records to empty", () => {
    expect(parseLinxUpdateCheckRecord("{")).toEqual(EMPTY_LINX_UPDATE_CHECK_RECORD);
    expect(parseLinxUpdateCheckRecord("[]")).toEqual(EMPTY_LINX_UPDATE_CHECK_RECORD);
    expect(parseLinxUpdateCheckRecord(JSON.stringify({ lastAttemptAt: "soon" }))).toEqual(
      EMPTY_LINX_UPDATE_CHECK_RECORD,
    );
  });
});
