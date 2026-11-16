import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign } from "node:crypto";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  LinxUpdateInstallRequest,
  LinxUpdateManifest,
  LinxUpdateReleaseReceipt,
} from "@synara/contracts";
import type * as LinxArchive from "@synara/shared/linxUpdateArchive";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  return { ...actual, statfs: vi.fn(actual.statfs) };
});
const seams = vi.hoisted(() => ({
  extract: vi.fn(),
  inspect: vi.fn(),
  adopt: vi.fn(),
  acquireHome: vi.fn(),
  transfer: vi.fn(),
  releaseHome: vi.fn(),
  acquireDB: vi.fn(),
  releaseDB: vi.fn(),
  createRecovery: vi.fn(),
  verifyRecovery: vi.fn(),
}));
vi.mock("@synara/shared/linxUpdateArchive", async (importOriginal) => ({
  ...(await importOriginal<typeof LinxArchive>()),
  extractLinxUpdateArchive: seams.extract,
  inspectLinxUpdateArchive: seams.inspect,
}));
vi.mock("@synara/shared/linxUpdateHomeOwnership", () => ({
  adoptLinxHomeOwnership: seams.adopt,
  acquireLinxHomeOwnership: seams.acquireHome,
}));
vi.mock("@synara/shared/databaseLifecycleLock", () => ({
  acquireDatabaseLifecycleLock: seams.acquireDB,
  releaseDatabaseLifecycleLock: seams.releaseDB,
}));
vi.mock("@synara/shared/linxUpdateRecovery", () => ({
  createLinxUpdateRecoverySet: seams.createRecovery,
  verifyLinxUpdateRecoverySet: seams.verifyRecovery,
}));
import {
  LinxUpdateHelperCore,
  readLinxHelperAttempt,
  requireLinxReceipt,
  validateLinxUpdateHelperStartup,
} from "./linxUpdateHelperCore";
import { recoverLinxUpdateHelperAttempt } from "./linxUpdateHelperRecovery";
import {
  LINX_HELPER_FILES as F,
  sha256,
  readPrivateJson,
  writePrivateJson,
  linxOSAtLeast,
  hashLinxHelperBundle,
} from "./linxUpdateHelperFiles";
import type { LinxHelperPlatform } from "./linxUpdateHelperPlatform";

const roots: string[] = [];
const parentPid = 987_651;
const newPid = 987_652;
let parentAlive = true;
beforeEach(() => {
  vi.clearAllMocks();
  parentAlive = true;
  vi.spyOn(process, "kill").mockImplementation(((pid: number) => {
    if (pid === parentPid && !parentAlive)
      throw Object.assign(new Error("dead"), { code: "ESRCH" });
    return true;
  }) as typeof process.kill);
  seams.inspect.mockResolvedValue({ applicationName: "Linx.app", expandedBytes: 64, entries: [] });
  seams.extract.mockImplementation(async (_source: string, destination: string) => {
    const applicationPath = join(destination, "Linx.app");
    await fs.mkdir(applicationPath, { recursive: true, mode: 0o700 });
    await fs.writeFile(join(applicationPath, "version"), "new");
    return {
      applicationName: "Linx.app",
      applicationPath,
      expandedBytes: 64,
      entries: [],
      resourceMetadata: [],
      contentDigest: await hashLinxHelperBundle(applicationPath),
    };
  });
  seams.adopt.mockResolvedValue({
    nonce: "",
    transfer: seams.transfer,
    release: seams.releaseHome,
  });
  seams.acquireHome.mockResolvedValue({
    nonce: "",
    transfer: seams.transfer,
    release: seams.releaseHome,
  });
  seams.acquireDB.mockReturnValue(Effect.succeed({ lockPath: "fixture" }));
  seams.releaseDB.mockReturnValue(Effect.void);
  seams.createRecovery.mockResolvedValue({});
  seams.verifyRecovery.mockResolvedValue({});
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.mocked(fs.statfs).mockReset();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "linx-helper-behavior-")));
  roots.push(root);
  await fs.chmod(root, 0o700);
  const attemptId = randomUUID();
  const attemptPath = join(root, attemptId);
  await fs.mkdir(attemptPath, { mode: 0o700 });
  const applicationPath = join(root, "Linx.app"),
    homePath = join(root, "home"),
    userDataPath = join(root, "profile");
  for (const path of [applicationPath, homePath, userDataPath, join(attemptPath, "snapshot")])
    await fs.mkdir(path, { mode: 0o700 });
  await fs.writeFile(join(applicationPath, "version"), "old");
  const keys = generateKeyPairSync("ed25519");
  const der = keys.publicKey.export({ format: "der", type: "spki" });
  const keyId = createHash("sha256").update(der).digest("hex").slice(0, 16);
  const sourceJson = JSON.stringify({
    repository: "WYLINX601/synara--expert",
    keyRing: { [keyId]: der.toString("base64") },
  });
  const packageBytes = Buffer.from("bounded signed package fixture");
  const manifest: LinxUpdateManifest = {
    schemaVersion: 1,
    productId: "linx",
    installIdentity: "com.wylinx.linx",
    channel: "stable",
    platform: "darwin",
    arch: "arm64",
    version: "0.1.16",
    sourceCommit: "a".repeat(40),
    minOSVersion: "13.0",
    assetName: "Linx-0.1.16-arm64.zip",
    assetUrl:
      "https://github.com/WYLINX601/synara--expert/releases/download/v0.1.16/Linx-0.1.16-arm64.zip",
    size: packageBytes.length,
    sha256: sha256(packageBytes),
    keyId,
  };
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  const nonce = randomBytes(32).toString("hex");
  const request: LinxUpdateInstallRequest = {
    schemaVersion: 1,
    attemptId,
    requestedAt: new Date().toISOString(),
    fromVersion: "0.1.15",
    toVersion: manifest.version,
    manifestDigest: sha256(manifestBytes),
    manifestPath: join(attemptPath, F.manifest),
    signaturePath: join(attemptPath, F.signature),
    packagePath: join(attemptPath, F.package),
    applicationPath,
    homePath,
    userDataPath,
    parentPid,
    authorizationDigest: sha256(nonce),
  };
  const release: LinxUpdateReleaseReceipt = {
    schemaVersion: 1,
    repository: "WYLINX601/synara--expert",
    tagName: "v0.1.16",
    releaseId: 1,
    tagObjectSha: manifest.sourceCommit,
    sourceCommit: manifest.sourceCommit,
    packageAssetId: 2,
    manifestAssetId: 3,
    signatureAssetId: 4,
    manifestDigest: request.manifestDigest,
    packageSha256: manifest.sha256,
    verifiedAt: new Date().toISOString(),
  };
  await writePrivateJson(join(attemptPath, F.request), request);
  await writePrivateJson(join(attemptPath, F.release), release);
  for (const [file, bytes] of [
    [F.nonce, nonce],
    [F.manifest, manifestBytes],
    [F.signature, sign(null, manifestBytes, keys.privateKey).toString("base64")],
    [F.package, packageBytes],
  ] as const)
    await fs.writeFile(join(attemptPath, file), bytes, { mode: 0o600 });
  const platform: LinxHelperPlatform = {
    acquireTargetLock: vi.fn(async () => ({
      assertHeld: vi.fn(async () => {}),
      release: vi.fn(async (_completed: boolean) => {}),
    })),
    validateStandaloneHelper: vi.fn(async () => {}),
    pidPath: vi.fn(async () => join(applicationPath, "Contents/MacOS/Linx")),
    validateBundle: vi.fn(async (path) => join(path, "Contents/MacOS/Linx")),
    osVersion: () => "14.4",
    prepareMetadata: vi.fn(async () => {}),
    launch: vi.fn(async () => {}),
  };
  const core = new LinxUpdateHelperCore({
    attemptPath,
    sourceJson,
    platform,
    parentPid,
    parentExitTimeoutMs: 0,
    healthTimeoutMs: 0,
  });
  const command = (
    action: "prepare" | "create-recovery" | "commit" | "cancel",
    changes: Record<string, unknown> = {},
  ) => ({
    schemaVersion: 1,
    attemptId,
    manifestDigest: request.manifestDigest,
    nonce,
    action,
    release: action === "commit" ? release : null,
    userDataSnapshotPath: action === "create-recovery" ? join(attemptPath, "snapshot") : null,
    ...changes,
  });
  return { root, attemptPath, request, release, manifest, sourceJson, platform, core, command };
}
async function prepared() {
  const f = await fixture();
  await f.core.initialize();
  await f.core.command(f.command("prepare"));
  return f;
}
async function committed() {
  const f = await prepared();
  await f.core.command(f.command("create-recovery"));
  await f.core.command(f.command("commit"));
  return f;
}

describe("helper independent authority and gates", () => {
  it("rejects spoofed kernel parent before extraction or ownership", async () => {
    const f = await fixture();
    vi.mocked(f.platform.pidPath).mockResolvedValue("/usr/bin/other");
    await expect(f.core.initialize()).rejects.toThrow("Kernel parent");
    expect(seams.extract).not.toHaveBeenCalled();
    expect(seams.adopt).not.toHaveBeenCalled();
  });
  it("rejects a supplied trust ring instead of accepting a second authority", async () => {
    const f = await fixture();
    await writePrivateJson(join(f.attemptPath, F.request), { ...f.request, keyRing: {} });
    await expect(f.core.initialize()).rejects.toThrow();
  });
  it("rejects foreign nonce and same-target digest substitution", async () => {
    const f = await fixture();
    await f.core.initialize();
    await expect(f.core.command(f.command("prepare", { nonce: "b".repeat(64) }))).rejects.toThrow(
      "IPC authorization",
    );
    await expect(
      f.core.command(f.command("prepare", { manifestDigest: "b".repeat(64) })),
    ).rejects.toThrow("IPC authorization");
    expect(seams.extract).not.toHaveBeenCalled();
  });
  it("rejects symlinked inputs and relaxed private permissions", async () => {
    const f = await fixture();
    await fs.chmod(join(f.attemptPath, F.manifest), 0o644);
    await expect(readLinxHelperAttempt(f.attemptPath, f.sourceJson)).rejects.toThrow("private");
    await fs.chmod(join(f.attemptPath, F.manifest), 0o600);
    await fs.rename(join(f.attemptPath, F.manifest), join(f.attemptPath, "elsewhere"));
    await fs.symlink("elsewhere", join(f.attemptPath, F.manifest));
    await expect(readLinxHelperAttempt(f.attemptPath, f.sourceJson)).rejects.toThrow();
  });
  it("rejects archive tampering before bounded extraction", async () => {
    const f = await fixture();
    await f.core.initialize();
    await fs.writeFile(f.request.packagePath, Buffer.alloc(f.manifest.size));
    await expect(f.core.command(f.command("prepare"))).rejects.toThrow("digest");
    expect(seams.extract).not.toHaveBeenCalled();
  });
  it.each(["macos", "space"] as const)(
    "acknowledges cancellation after a %s refusal",
    async (reason) => {
      const f = await fixture();
      if (reason === "macos") f.platform.osVersion = () => "12.7";
      else {
        const space = await fs.statfs(f.root);
        vi.mocked(fs.statfs).mockResolvedValue({ ...space, bavail: 1, bsize: 1 });
      }
      await f.core.initialize();
      await expect(f.core.command(f.command("prepare"))).rejects.toMatchObject({ reason });
      expect(seams.extract).not.toHaveBeenCalled();
      await expect(f.core.command(f.command("cancel"))).resolves.toMatchObject({
        status: "cancelled",
      });
      expect(f.core.isTerminal()).toBe(true);
      expect(await fs.readFile(join(f.request.applicationPath, "version"), "utf8")).toBe("old");
    },
  );
  it("requires a fresh exact release observation, not latest or matching version alone", async () => {
    const f = await fixture();
    for (const receipt of [
      { ...f.release, releaseId: 99 },
      { ...f.release, verifiedAt: new Date(Date.now() - 31_000).toISOString() },
      { ...f.release, sourceCommit: "b".repeat(40) },
    ])
      expect(() =>
        requireLinxReceipt(
          receipt,
          f.release,
          f.manifest,
          f.request.manifestDigest,
          f.release.repository,
        ),
      ).toThrow();
    expect(linxOSAtLeast("14", "13.4.1")).toBe(true);
    expect(linxOSAtLeast("13.4", "13.4.1")).toBe(false);
  });
});
it("reserves space for independent signed-package startup inventory before extraction", async () => {
  const f = await fixture();
  seams.inspect.mockResolvedValue({
    applicationName: "Linx.app",
    expandedBytes: 1024 ** 3,
    entries: [],
  });
  const space = await fs.statfs(f.root);
  vi.mocked(fs.statfs).mockResolvedValue({ ...space, bavail: 1536 * 1024 ** 2, bsize: 1 });
  await f.core.initialize();
  await expect(f.core.command(f.command("prepare"))).rejects.toThrow();
  expect(seams.extract).not.toHaveBeenCalled();
});
describe("explicit commit, transfer and interruption boundaries", () => {
  it("excludes a second home targeting the same app until cancellation releases the target", async () => {
    const first = await fixture();
    const second = await fixture();
    const held = new Set<string>();
    const acquire: LinxHelperPlatform["acquireTargetLock"] = async (path) => {
      if (held.has(path)) throw new Error("Installation target busy");
      held.add(path);
      return {
        assertHeld: async () => {
          if (!held.has(path)) throw new Error("Target lost");
        },
        release: async () => {
          held.delete(path);
        },
      };
    };
    vi.mocked(first.platform.acquireTargetLock).mockImplementation(acquire);
    vi.mocked(second.platform.acquireTargetLock).mockImplementation(acquire);
    await writePrivateJson(join(second.attemptPath, F.request), {
      ...second.request,
      applicationPath: first.request.applicationPath,
    });
    vi.mocked(second.platform.pidPath).mockResolvedValue(
      join(first.request.applicationPath, "Contents/MacOS/Linx"),
    );
    await first.core.initialize();
    await second.core.initialize();
    await first.core.command(first.command("prepare"));
    await expect(second.core.command(second.command("prepare"))).rejects.toThrow("target busy");
    await first.core.command(first.command("cancel"));
    await expect(second.core.command(second.command("prepare"))).resolves.toMatchObject({
      status: "prepared",
    });
    await second.core.command(second.command("cancel"));
    expect(held.size).toBe(0);
  });
  it("releases target exclusion and removes its candidate on preparation error", async () => {
    const f = await fixture();
    vi.mocked(f.platform.prepareMetadata).mockRejectedValueOnce(new Error("metadata refused"));
    await f.core.initialize();
    await expect(f.core.command(f.command("prepare"))).rejects.toThrow("metadata refused");
    await expect(f.core.command(f.command("cancel"))).resolves.toMatchObject({
      status: "cancelled",
    });
    const target = await vi.mocked(f.platform.acquireTargetLock).mock.results[0]!.value;
    expect(target.release).toHaveBeenCalledWith(true);
    await expect(
      fs.lstat(join(f.root, `.linx-candidate-${f.request.attemptId}`)),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("rejects candidate substitution before the first on-disk inventory", async () => {
    const f = await fixture();
    const extract = seams.extract.getMockImplementation()!;
    seams.extract.mockImplementation(async (...args) => {
      const result = await extract(...args);
      await fs.writeFile(join(result.applicationPath, "untrusted-code"), "replacement payload");
      return result;
    });
    await f.core.initialize();
    await expect(f.core.command(f.command("prepare"))).rejects.toThrow("authenticated");
    expect(await fs.readFile(join(f.request.applicationPath, "version"), "utf8")).toBe("old");
    expect(f.platform.launch).not.toHaveBeenCalled();
  });
  it.each(["commit", "replace", "launch"] as const)(
    "rejects a self-consistently re-sealed same-metadata candidate at %s",
    async (boundary) => {
      const f = await prepared();
      await f.core.command(f.command("create-recovery"));
      const candidate = join(f.root, `.linx-candidate-${f.request.attemptId}`, "Linx.app");
      const substitute = async (path: string) => {
        // The platform accepts the independent ad-hoc seal and unchanged metadata.
        // Neither the authenticated package nor its manifest has been modified.
        await fs.writeFile(join(path, "untrusted-code"), "independently re-signed payload");
      };
      if (boundary === "commit") {
        await substitute(candidate);
        await expect(f.core.command(f.command("commit"))).rejects.toThrow("authenticated");
        await f.core.command(f.command("cancel"));
      } else {
        await f.core.command(f.command("commit"));
        parentAlive = false;
        if (boundary === "replace") await substitute(candidate);
        else {
          vi.mocked(f.platform.validateBundle).mockImplementation(async (path, version) => {
            if (path === f.request.applicationPath && version === f.request.toVersion)
              await substitute(path);
            return join(path, "Contents/MacOS/Linx");
          });
        }
        await expect(f.core.installAfterParentExit()).rejects.toThrow("authenticated");
      }
      expect(await fs.readFile(join(f.request.applicationPath, "version"), "utf8")).toBe("old");
      expect(sha256(await fs.readFile(f.request.packagePath))).toBe(f.manifest.sha256);
      expect(f.platform.launch).not.toHaveBeenCalledWith(f.request.applicationPath, f.attemptPath);
    },
  );
  it("pins legal framework links without following or rejecting them", async () => {
    const f = await fixture();
    const extract = seams.extract.getMockImplementation()!;
    seams.extract.mockImplementation(async (...args) => {
      const result = await extract(...args);
      const framework = join(result.applicationPath, "Contents/Frameworks/Fixture.framework");
      await fs.mkdir(join(framework, "Versions/A"), { recursive: true });
      await fs.writeFile(join(framework, "Versions/A/Fixture"), "framework code");
      await fs.symlink("A", join(framework, "Versions/Current"));
      await fs.symlink("Versions/Current/Fixture", join(framework, "Fixture"));
      result.contentDigest = await hashLinxHelperBundle(result.applicationPath);
      return result;
    });
    await f.core.initialize();
    await f.core.command(f.command("prepare"));
    await f.core.command(f.command("create-recovery"));
    await expect(f.core.command(f.command("commit"))).resolves.toMatchObject({
      status: "committed",
    });
    await f.core.command(f.command("cancel"));
  });
  it("disconnect without commit cancels without installing", async () => {
    const f = await prepared();
    await f.core.disconnected();
    const target = await vi.mocked(f.platform.acquireTargetLock).mock.results[0]!.value;
    expect(target.release).toHaveBeenCalledWith(true);
    expect(
      ((await readPrivateJson(join(f.attemptPath, F.journal))) as { phase: string }).phase,
    ).toBe("cancelled");
    expect(f.platform.launch).not.toHaveBeenCalled();
    expect(await fs.readFile(join(f.request.applicationPath, "version"), "utf8")).toBe("old");
  });
  it("creates and verifies recovery under adopted home and DB ownership, then returns ownership on cancel", async () => {
    const f = await prepared();
    await f.core.command(f.command("create-recovery"));
    expect(seams.adopt).toHaveBeenCalledWith(
      expect.objectContaining({ nonce: f.command("cancel").nonce, version: "0.1.15" }),
    );
    expect(seams.createRecovery).toHaveBeenCalledWith(
      expect.objectContaining({ userDataSnapshotFormat: "portable-app-storage" }),
    );
    expect(seams.verifyRecovery).toHaveBeenCalled();
    await f.core.command(f.command("cancel"));
    expect(seams.transfer).toHaveBeenCalledWith({
      pid: parentPid,
      nonce: f.command("cancel").nonce,
      version: "0.1.15",
    });
    expect(seams.releaseDB).toHaveBeenCalled();
    expect(seams.releaseHome).not.toHaveBeenCalled();
  });
  it("refuses commit before verified recovery and fresh revalidation", async () => {
    const f = await prepared();
    await expect(f.core.command(f.command("commit"))).rejects.toThrow("recovery");
    await f.core.command(f.command("create-recovery"));
    await expect(
      f.core.command(f.command("commit", { release: { ...f.release, packageAssetId: 100 } })),
    ).rejects.toThrow("pinned target");
    expect(f.core.isCommitted()).toBe(false);
  });
  it("durably acknowledges commit but refuses renames while parent remains alive", async () => {
    const f = await committed();
    expect(
      ((await readPrivateJson(join(f.attemptPath, F.journal))) as { phase: string }).phase,
    ).toBe("waiting-for-exit");
    await expect(f.core.installAfterParentExit()).rejects.toThrow("did not exit");
    expect(f.platform.launch).not.toHaveBeenCalled();
    expect(await fs.readFile(join(f.request.applicationPath, "version"), "utf8")).toBe("old");
  });
  it("restores old app on prelaunch verification failure and retains recovery", async () => {
    const f = await committed();
    parentAlive = false;
    vi.mocked(f.platform.validateBundle).mockImplementation(async (path, version) => {
      if (path === f.request.applicationPath && version === f.request.toVersion)
        throw new Error("installed integrity failure");
      return join(path, "Contents/MacOS/Linx");
    });
    await expect(f.core.installAfterParentExit()).rejects.toThrow("integrity");
    const journal = (await readPrivateJson(join(f.attemptPath, F.journal))) as {
      phase: string;
      mayHaveWrittenData: boolean;
    };
    expect(journal).toMatchObject({ phase: "rolled-back", mayHaveWrittenData: false });
    expect(await fs.readFile(join(f.request.applicationPath, "version"), "utf8")).toBe("old");
    expect(f.platform.launch).toHaveBeenCalledWith(f.request.applicationPath);
  });
  it("writes sticky risk before OS launch and never opens old code on Gatekeeper refusal", async () => {
    const f = await committed();
    parentAlive = false;
    vi.mocked(f.platform.launch).mockImplementation(async () => {
      expect(await readPrivateJson(join(f.attemptPath, F.journal))).toMatchObject({
        phase: "launching",
        mayHaveWrittenData: true,
      });
      throw new Error("OS refused launch");
    });
    await expect(f.core.installAfterParentExit()).rejects.toThrow("OS refused");
    expect(await readPrivateJson(join(f.attemptPath, F.journal))).toMatchObject({
      phase: "recovery-required",
      mayHaveWrittenData: true,
    });
    expect(f.platform.launch).toHaveBeenCalledTimes(1);
    expect(
      await fs.readFile(join(f.root, `.linx-retained-${f.request.attemptId}.app/version`), "utf8"),
    ).toBe("old");
  });
  it("does not declare success from successful open without a real health claim", async () => {
    const f = await committed();
    parentAlive = false;
    await expect(f.core.installAfterParentExit()).rejects.toThrow("health");
    const target = await vi.mocked(f.platform.acquireTargetLock).mock.results[0]!.value;
    expect(target.release).toHaveBeenCalledWith(false);
    expect(await readPrivateJson(join(f.attemptPath, F.journal))).toMatchObject({
      phase: "recovery-required",
      mayHaveWrittenData: true,
    });
    expect(seams.transfer).not.toHaveBeenCalled();
  });
});
it("recovers a crash before the prepared journal without removing the old bundle", async () => {
  const f = await fixture();
  parentAlive = false;
  const recovered = await recoverLinxUpdateHelperAttempt({
    attemptPath: f.attemptPath,
    sourceJson: f.sourceJson,
    platform: f.platform,
  });
  expect(recovered.phase).toBe("rolled-back");
  expect(await fs.readFile(join(f.request.applicationPath, "version"), "utf8")).toBe("old");
  const target = await vi.mocked(f.platform.acquireTargetLock).mock.results[0]!.value;
  expect(target.release).toHaveBeenCalledWith(true);
});
describe("journal gap recovery", () => {
  it("restores a first-rename gap only before possible new writes", async () => {
    const f = await committed();
    parentAlive = false;
    const journal = (await readPrivateJson(join(f.attemptPath, F.journal))) as {
      retainedApplicationPath: string;
    };
    await fs.rename(f.request.applicationPath, journal.retainedApplicationPath);
    const recovered = await recoverLinxUpdateHelperAttempt({
      attemptPath: f.attemptPath,
      sourceJson: f.sourceJson,
      platform: f.platform,
    });
    expect(recovered.phase).toBe("rolled-back");
    expect(await fs.readFile(join(f.request.applicationPath, "version"), "utf8")).toBe("old");
    expect(f.platform.launch).not.toHaveBeenCalled();
  });
  it("restores a second-rename gap using path evidence even before journal phase catches up", async () => {
    const f = await committed();
    parentAlive = false;
    const journal = (await readPrivateJson(join(f.attemptPath, F.journal))) as {
      retainedApplicationPath: string;
    };
    await fs.rename(f.request.applicationPath, journal.retainedApplicationPath);
    await fs.rename(
      join(f.root, `.linx-candidate-${f.request.attemptId}`, "Linx.app"),
      f.request.applicationPath,
    );
    expect(
      (
        await recoverLinxUpdateHelperAttempt({
          attemptPath: f.attemptPath,
          sourceJson: f.sourceJson,
          platform: f.platform,
        })
      ).phase,
    ).toBe("rolled-back");
    expect(await fs.readFile(join(f.request.applicationPath, "version"), "utf8")).toBe("old");
  });
  it("never restores old app from a sticky-risk journal", async () => {
    const f = await committed();
    parentAlive = false;
    await expect(f.core.installAfterParentExit()).rejects.toThrow();
    seams.acquireHome.mockClear();
    const recovered = await recoverLinxUpdateHelperAttempt({
      attemptPath: f.attemptPath,
      sourceJson: f.sourceJson,
      platform: f.platform,
    });
    expect(recovered.phase).toBe("recovery-required");
    expect(seams.acquireHome).not.toHaveBeenCalled();
    expect(await fs.readFile(join(f.request.applicationPath, "version"), "utf8")).toBe("new");
  });
});

describe("process-bound health ownership handoff", () => {
  it("rejects a health claim with a foreign nonce without granting home access", async () => {
    const f = await fixture();
    const core = new LinxUpdateHelperCore({
      attemptPath: f.attemptPath,
      sourceJson: f.sourceJson,
      platform: f.platform,
      parentPid,
      healthTimeoutMs: 1_000,
    });
    await core.initialize();
    await core.command(f.command("prepare"));
    await core.command(f.command("create-recovery"));
    await core.command(f.command("commit"));
    parentAlive = false;
    vi.mocked(f.platform.launch).mockImplementation(async () => {
      const health = (await readPrivateJson(join(f.attemptPath, F.healthRequest))) as Record<
        string,
        unknown
      >;
      await writePrivateJson(join(f.attemptPath, F.healthClaim), {
        ...health,
        nonce: "f".repeat(64),
        pid: newPid,
        phase: "claim",
        backendReady: false,
        clientConnected: false,
      });
    });
    await expect(core.installAfterParentExit()).rejects.toThrow("binding");
    expect(seams.transfer).not.toHaveBeenCalled();
    expect(await readPrivateJson(join(f.attemptPath, F.journal))).toMatchObject({
      phase: "recovery-required",
    });
  });
  it("rejects a process outside the installed executable even with a correct nonce", async () => {
    const f = await fixture();
    const core = new LinxUpdateHelperCore({
      attemptPath: f.attemptPath,
      sourceJson: f.sourceJson,
      platform: f.platform,
      parentPid,
      healthTimeoutMs: 1_000,
    });
    await core.initialize();
    await core.command(f.command("prepare"));
    await core.command(f.command("create-recovery"));
    await core.command(f.command("commit"));
    parentAlive = false;
    vi.mocked(f.platform.pidPath).mockResolvedValue("/usr/bin/unrelated");
    vi.mocked(f.platform.launch).mockImplementation(async () => {
      const health = (await readPrivateJson(join(f.attemptPath, F.healthRequest))) as Record<
        string,
        unknown
      >;
      await writePrivateJson(join(f.attemptPath, F.healthClaim), {
        ...health,
        pid: newPid,
        phase: "claim",
        backendReady: false,
        clientConnected: false,
      });
    });
    await expect(core.installAfterParentExit()).rejects.toThrow("installed application process");
    expect(seams.transfer).not.toHaveBeenCalled();
  });
  it("grants the verified new process before acknowledging real backend/client health and retains old app", async () => {
    const f = await fixture();
    const core = new LinxUpdateHelperCore({
      attemptPath: f.attemptPath,
      sourceJson: f.sourceJson,
      platform: f.platform,
      parentPid,
      healthTimeoutMs: 1_000,
    });
    await core.initialize();
    await core.command(f.command("prepare"));
    await core.command(f.command("create-recovery"));
    await core.command(f.command("commit"));
    parentAlive = false;
    vi.mocked(f.platform.launch).mockImplementation(async () => {
      const health = (await readPrivateJson(join(f.attemptPath, F.healthRequest))) as Record<
        string,
        unknown
      >;
      await writePrivateJson(join(f.attemptPath, F.healthClaim), {
        ...health,
        pid: newPid,
        phase: "claim",
        backendReady: false,
        clientConnected: false,
      });
      // Fixture simulates only the trusted app's already-exercised backend/client observation.
      await writePrivateJson(join(f.attemptPath, F.healthProof), {
        ...health,
        pid: newPid,
        phase: "healthy",
        backendReady: true,
        clientConnected: true,
      });
    });
    await core.installAfterParentExit();
    const health = (await readPrivateJson(join(f.attemptPath, F.healthRequest))) as {
      nonce: string;
    };
    expect(seams.transfer).toHaveBeenCalledWith({
      pid: newPid,
      nonce: health.nonce,
      version: f.manifest.version,
    });
    expect(seams.releaseDB).toHaveBeenCalled();
    const target = await vi.mocked(f.platform.acquireTargetLock).mock.results[0]!.value;
    expect(target.release).toHaveBeenCalledWith(true);
    expect(await readPrivateJson(join(f.attemptPath, F.healthOwnership))).toMatchObject({
      nonce: health.nonce,
    });
    expect(await readPrivateJson(join(f.attemptPath, F.journal))).toMatchObject({
      phase: "healthy",
      mayHaveWrittenData: true,
    });
    expect(
      await fs.readFile(join(f.root, `.linx-retained-${f.request.attemptId}.app/version`), "utf8"),
    ).toBe("old");
    await expect(
      validateLinxUpdateHelperStartup({
        attemptPath: f.attemptPath,
        sourceJson: f.sourceJson,
        applicationPath: f.request.applicationPath,
        homePath: f.request.homePath,
        userDataPath: f.request.userDataPath,
        version: f.manifest.version,
        sourceCommit: f.manifest.sourceCommit,
        platform: f.platform,
        pid: newPid,
      }),
    ).resolves.toMatchObject({ journal: { phase: "healthy" } });
  });
});

describe("independent helper-death startup recovery", () => {
  const deadHelperPid = 987_653;
  async function interrupted() {
    const f = await committed();
    parentAlive = false;
    await expect(f.core.installAfterParentExit()).rejects.toThrow("health");
    const health = (await readPrivateJson(join(f.attemptPath, F.healthRequest))) as Record<
      string,
      unknown
    >;
    await writePrivateJson(join(f.attemptPath, F.healthRequest), {
      ...health,
      helperPid: deadHelperPid,
    });
    vi.mocked(process.kill).mockImplementation(((pid: number) => {
      if (pid === parentPid || pid === deadHelperPid)
        throw Object.assign(new Error("dead"), { code: "ESRCH" });
      return true;
    }) as typeof process.kill);
    const resumed = new LinxUpdateHelperCore({
      attemptPath: f.attemptPath,
      sourceJson: f.sourceJson,
      platform: f.platform,
      parentPid: newPid,
      healthTimeoutMs: 1_000,
    });
    return { ...f, resumed, previous: health };
  }
  it("requires the actual new-process parent and refuses a live previous helper", async () => {
    const f = await interrupted();
    seams.acquireHome.mockClear();
    await expect(f.resumed.resumeStartup(parentPid)).rejects.toThrow("actual live");
    vi.mocked(process.kill).mockImplementation(() => true);
    await expect(f.resumed.resumeStartup(newPid)).rejects.toThrow("live or unknown");
    expect(seams.acquireHome).not.toHaveBeenCalled();
  });
  it("reconstructs authenticated bundle content after helper death instead of trusting a new seal", async () => {
    const f = await interrupted();
    seams.acquireHome.mockClear();
    await fs.writeFile(
      join(f.request.applicationPath, "newly-resigned-code"),
      "foreign executable",
    );
    await expect(f.resumed.resumeStartup(newPid)).rejects.toThrow("authenticated");
    expect(seams.acquireHome).not.toHaveBeenCalled();
    expect(sha256(await fs.readFile(f.request.packagePath))).toBe(f.manifest.sha256);
  });
  it("refuses a changed signed package before acquiring data ownership", async () => {
    const f = await interrupted();
    seams.acquireHome.mockClear();
    await fs.writeFile(f.request.packagePath, Buffer.alloc(f.manifest.size));
    await expect(f.resumed.resumeStartup(newPid)).rejects.toThrow("package hash");
    expect(seams.acquireHome).not.toHaveBeenCalled();
  });
  it("preserves a target-version ownership floor and refuses a live data owner", async () => {
    const f = await interrupted();
    seams.acquireHome.mockRejectedValueOnce(new Error("Whole-home owner is live"));
    await expect(f.resumed.resumeStartup(newPid)).rejects.toThrow("owner is live");
    expect(seams.acquireHome).toHaveBeenCalledWith(
      expect.objectContaining({ version: f.manifest.version }),
    );
    expect(f.platform.launch).toHaveBeenCalledTimes(1);
  });
  it("uses fresh nonce and real process-bound health, never stale claims from the dead helper", async () => {
    const f = await interrupted();
    for (const file of [F.healthClaim, F.healthOwnership, F.healthProof])
      await writePrivateJson(join(f.attemptPath, file), f.previous);
    const validated = await f.resumed.resumeStartup(newPid);
    expect(validated.request.nonce).not.toBe(f.previous.nonce);
    expect(validated.request.helperPid).toBe(process.pid);
    for (const file of [F.healthClaim, F.healthOwnership, F.healthProof])
      await expect(fs.lstat(join(f.attemptPath, file))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readPrivateJson(join(f.attemptPath, F.journal))).toMatchObject({
      phase: "awaiting-health",
      mayHaveWrittenData: true,
    });
    await writePrivateJson(join(f.attemptPath, F.healthClaim), {
      ...validated.request,
      pid: newPid,
      phase: "claim",
      backendReady: false,
      clientConnected: false,
    });
    await writePrivateJson(join(f.attemptPath, F.healthProof), {
      ...validated.request,
      pid: newPid,
      phase: "healthy",
      backendReady: true,
      clientConnected: true,
    });
    await f.resumed.finishResumedStartup(validated.request);
    expect(seams.transfer).toHaveBeenCalledWith({
      pid: newPid,
      nonce: validated.request.nonce,
      version: f.manifest.version,
    });
    expect(await readPrivateJson(join(f.attemptPath, F.journal))).toMatchObject({
      phase: "healthy",
      mayHaveWrittenData: true,
    });
    expect(f.platform.launch).toHaveBeenCalledTimes(1);
  });
  it("releases both locks if resumed DB acquisition fails without downgrading or launching", async () => {
    const f = await interrupted();
    seams.releaseHome.mockClear();
    seams.acquireDB.mockReturnValueOnce(Effect.fail(new Error("DB lock busy")));
    await expect(f.resumed.resumeStartup(newPid)).rejects.toThrow("DB lock busy");
    expect(seams.releaseHome).toHaveBeenCalledTimes(1);
    expect(f.platform.launch).toHaveBeenCalledTimes(1);
    expect(await readPrivateJson(join(f.attemptPath, F.journal))).toMatchObject({
      mayHaveWrittenData: true,
    });
  });
});

it("removes only a cancelled attempt's private candidate while retaining the pinned package", async () => {
  const f = await prepared();
  await f.core.command(f.command("cancel"));
  await expect(
    fs.lstat(join(f.root, `.linx-candidate-${f.request.attemptId}`)),
  ).rejects.toMatchObject({ code: "ENOENT" });
  expect(await fs.readFile(join(f.request.applicationPath, "version"), "utf8")).toBe("old");
  expect((await fs.stat(f.request.packagePath)).size).toBe(f.manifest.size);
});
