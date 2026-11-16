import { LinxUpdateOperationError } from "./linxUpdateFailure";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import { Effect, Schema } from "effect";
import {
  LinxUpdateInstallRequest,
  LinxUpdateInstallJournal,
  LinxUpdateHelperCommand,
  LinxUpdateReleaseReceipt,
  LinxUpdateHealthRequest,
  LinxUpdateHealthProof,
  type LinxUpdateHelperResponse,
  type LinxUpdateManifest,
} from "@synara/contracts";
import {
  extractLinxUpdateArchive,
  inspectLinxUpdateArchive,
} from "@synara/shared/linxUpdateArchive";
import {
  acquireDatabaseLifecycleLock,
  releaseDatabaseLifecycleLock,
  type DatabaseLifecycleLock,
} from "@synara/shared/databaseLifecycleLock";
import {
  adoptLinxHomeOwnership,
  acquireLinxHomeOwnership,
  type LinxHomeOwnership,
} from "@synara/shared/linxUpdateHomeOwnership";
import {
  createLinxUpdateRecoverySet,
  verifyLinxUpdateRecoverySet,
} from "@synara/shared/linxUpdateRecovery";
import { verifyLinxUpdateManifest } from "@synara/shared/linxUpdateManifestVerification";
import { syncDirectoryEntry } from "@synara/shared/filesystemPlatform";
import { parseLinxUpdateSource } from "./linxUpdateSource";
import {
  LINX_HELPER_FILES as F,
  sha256,
  readPrivateFile,
  readPrivateJson,
  writePrivateJson,
  requirePrivateDirectory,
  requireCanonicalPath,
  hashPrivatePackage,
  exists,
  linxOSAtLeast,
  syncLinxHelperTree,
  hashLinxHelperBundle,
  verifyLinxHelperBundleFromPackage,
} from "./linxUpdateHelperFiles";
import type { LinxHelperPlatform, LinxInstallationTargetLock } from "./linxUpdateHelperPlatform";

const delay = (ms: number): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
};
const inside = (root: string, path: string) =>
  path === root || (!relative(root, path).startsWith("../") && relative(root, path) !== "..");
export const linxHelperParentState = (pid: number): "live" | "dead" | "unknown" => {
  try {
    process.kill(pid, 0);
    return "live";
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH" ? "dead" : "unknown";
  }
};
export function requireLinxReceipt(
  receipt: LinxUpdateReleaseReceipt,
  initial: LinxUpdateReleaseReceipt,
  manifest: LinxUpdateManifest,
  digest: string,
  repository: string,
  now = Date.now(),
): void {
  const fields = [
    "repository",
    "tagName",
    "releaseId",
    "tagObjectSha",
    "sourceCommit",
    "packageAssetId",
    "manifestAssetId",
    "signatureAssetId",
    "manifestDigest",
    "packageSha256",
  ] as const;
  if (
    fields.some((key) => receipt[key] !== initial[key]) ||
    receipt.repository !== repository ||
    receipt.manifestDigest !== digest ||
    receipt.packageSha256 !== manifest.sha256 ||
    receipt.sourceCommit !== manifest.sourceCommit ||
    receipt.tagName !== `v${manifest.version}` ||
    now - Date.parse(receipt.verifiedAt) > 30_000 ||
    Date.parse(receipt.verifiedAt) > now + 1_000
  )
    throw new Error("Release receipt is stale or not the exact pinned target");
}
export interface LinxHelperAttempt {
  request: LinxUpdateInstallRequest;
  manifest: LinxUpdateManifest;
  nonce: string;
  release: LinxUpdateReleaseReceipt;
}
export async function readLinxHelperAttempt(
  attemptPath: string,
  sourceJson: string,
): Promise<LinxHelperAttempt> {
  await requirePrivateDirectory(attemptPath);
  const request = Schema.decodeUnknownSync(LinxUpdateInstallRequest)(
    await readPrivateJson(join(attemptPath, F.request)),
  );
  if (basename(attemptPath) !== request.attemptId)
    throw new Error("Attempt directory identity mismatch");
  for (const [field, file] of [
    ["manifestPath", F.manifest],
    ["signaturePath", F.signature],
    ["packagePath", F.package],
  ] as const)
    if (request[field] !== join(attemptPath, file)) throw new Error("Attempt input path mismatch");
  for (const path of [request.applicationPath, request.homePath, request.userDataPath]) {
    if (path === request.applicationPath && !(await exists(path)))
      await requireCanonicalPath(dirname(path));
    else await requireCanonicalPath(path);
    if (inside(path, attemptPath) || inside(attemptPath, path))
      throw new Error("Attempt must remain outside app/data roots");
  }
  if (
    !request.applicationPath.endsWith(".app") ||
    inside(request.homePath, request.userDataPath) ||
    inside(request.userDataPath, request.homePath)
  )
    throw new Error("Invalid app/data root separation");
  for (const root of [request.homePath, request.userDataPath])
    if (inside(root, request.applicationPath) || inside(request.applicationPath, root))
      throw new Error("Application and data roots must remain separate");
  const nonce = (await readPrivateFile(join(attemptPath, F.nonce), 64)).toString("utf8");
  if (!/^[a-f0-9]{64}$/u.test(nonce) || sha256(nonce) !== request.authorizationDigest)
    throw new Error("Private authorization binding mismatch");
  const source = parseLinxUpdateSource(sourceJson);
  if (!source) throw new Error("Missing embedded trust root");
  const manifestBytes = await readPrivateFile(request.manifestPath, 16 * 1024);
  if (sha256(manifestBytes) !== request.manifestDigest) throw new Error("Manifest digest mismatch");
  const verified = verifyLinxUpdateManifest({
    manifestBytes,
    signatureBytes: await readPrivateFile(request.signaturePath, 256),
    keyRing: source.keyRing,
    currentVersion: request.fromVersion,
    allowedAssetHosts: source.allowedAssetHosts,
  });
  if (!verified.ok) throw new Error(`Signed manifest rejected: ${verified.reason}`);
  const manifest = verified.manifest;
  if (
    manifest.version !== request.toVersion ||
    manifest.assetUrl !==
      `https://github.com/${source.repository}/releases/download/v${manifest.version}/${manifest.assetName}`
  )
    throw new Error("Signed target differs from install request/repository");
  const release = Schema.decodeUnknownSync(LinxUpdateReleaseReceipt)(
    await readPrivateJson(join(attemptPath, F.release)),
  );
  return { request, manifest, nonce, release };
}
export interface LinxHelperCoreOptions {
  attemptPath: string;
  sourceJson: string;
  platform: LinxHelperPlatform;
  parentPid?: number;
  healthTimeoutMs?: number;
  parentExitTimeoutMs?: number;
}
export class LinxUpdateHelperCore {
  private attempt!: LinxHelperAttempt;
  private journal: LinxUpdateInstallJournal | null = null;
  private ownership: LinxHomeOwnership | null = null;
  private database: DatabaseLifecycleLock | null = null;
  private target: LinxInstallationTargetLock | null = null;
  private candidateDigest = "";
  private candidateOwned = false;
  private committed = false;
  private commitExpiresAt = 0;
  private recoveryReady = false;
  private parentExecutable = "";
  private executable = "";
  private terminal = false;
  constructor(private readonly options: LinxHelperCoreOptions) {}
  private file(name: string): string {
    return join(this.options.attemptPath, name);
  }
  private candidateRoot(): string {
    return join(
      dirname(this.attempt.request.applicationPath),
      `.linx-candidate-${this.attempt.request.attemptId}`,
    );
  }
  private candidate(): string {
    return join(this.candidateRoot(), "Linx.app");
  }
  private async assertCandidate(path = this.candidate()): Promise<void> {
    if (!this.target) throw new Error("No installation target ownership");
    await this.target.assertHeld();
    if (!this.candidateDigest || (await hashLinxHelperBundle(path)) !== this.candidateDigest)
      throw new Error("Bundle differs from authenticated package content");
    await this.target.assertHeld();
  }
  private async releaseTarget(completed: boolean): Promise<void> {
    const target = this.target;
    this.target = null;
    if (target) await target.release(completed);
  }
  private async phase(
    phase: LinxUpdateInstallJournal["phase"],
    message: string | null = null,
    risk = false,
  ): Promise<void> {
    if (!this.journal) throw new Error("No prepared journal");
    this.journal = {
      ...this.journal,
      phase,
      message,
      mayHaveWrittenData: this.journal.mayHaveWrittenData || risk,
      updatedAt: new Date().toISOString(),
    };
    await writePrivateJson(
      this.file(F.journal),
      Schema.decodeUnknownSync(LinxUpdateInstallJournal)(this.journal),
    );
  }
  async initialize(): Promise<void> {
    this.attempt = await readLinxHelperAttempt(this.options.attemptPath, this.options.sourceJson);
    const { request, manifest, release } = this.attempt;
    if (
      request.parentPid !== (this.options.parentPid ?? process.ppid) ||
      linxHelperParentState(request.parentPid) !== "live"
    )
      throw new Error("Helper was not launched by the claimed live parent");
    if (
      Date.now() - Date.parse(request.requestedAt) > 5 * 60_000 ||
      Date.parse(request.requestedAt) > Date.now() + 1_000
    )
      throw new Error("Stale installation authorization");
    const source = parseLinxUpdateSource(this.options.sourceJson)!;
    requireLinxReceipt(release, release, manifest, request.manifestDigest, source.repository);
    this.parentExecutable = await this.options.platform.validateBundle(
      request.applicationPath,
      request.fromVersion,
      false,
    );
    if ((await this.options.platform.pidPath(request.parentPid)) !== this.parentExecutable)
      throw new Error("Kernel parent executable is not the current application");
    await this.options.platform.validateStandaloneHelper(
      request.applicationPath,
      this.options.attemptPath,
    );
    if (await exists(this.file(F.journal)))
      throw new Error(
        "Attempt already has an installation journal; recover it instead of replaying commands",
      );
  }
  private async assertParent(): Promise<void> {
    if (
      linxHelperParentState(this.attempt.request.parentPid) !== "live" ||
      (await this.options.platform.pidPath(this.attempt.request.parentPid)) !==
        this.parentExecutable
    )
      throw new Error("Authorized parent is no longer running");
  }
  private response(status: LinxUpdateHelperResponse["status"]): LinxUpdateHelperResponse {
    return {
      schemaVersion: 1,
      attemptId: this.attempt.request.attemptId,
      manifestDigest: this.attempt.request.manifestDigest,
      helperPid: process.pid,
      status,
      failure: null,
    };
  }
  async command(input: unknown): Promise<LinxUpdateHelperResponse> {
    const command = Schema.decodeUnknownSync(LinxUpdateHelperCommand)(input);
    const { request, nonce, manifest, release } = this.attempt;
    if (
      command.attemptId !== request.attemptId ||
      command.manifestDigest !== request.manifestDigest ||
      !timingSafeEqual(Buffer.from(command.nonce), Buffer.from(nonce))
    )
      throw new Error("IPC authorization mismatch");
    if (this.terminal || (this.committed && command.action !== "cancel"))
      throw new Error("Attempt no longer accepts commands");
    await this.assertParent();
    switch (command.action) {
      case "prepare": {
        if (this.journal) throw new Error("Attempt already prepared");
        this.target = await this.options.platform.acquireTargetLock(
          request.applicationPath,
          this.options.attemptPath,
        );
        if (!linxOSAtLeast(this.options.platform.osVersion(), manifest.minOSVersion))
          throw new LinxUpdateOperationError("macos");
        if ((await hashPrivatePackage(request.packagePath, manifest.size)) !== manifest.sha256)
          throw new Error("Package digest mismatch");
        const parent = dirname(request.applicationPath);
        await requireCanonicalPath(parent);
        await fs.access(parent, constants.W_OK | constants.X_OK);
        const parentStat = await fs.stat(parent);
        if (
          (parentStat.mode & 0o002) !== 0 ||
          (parentStat.uid !== 0 && parentStat.uid !== process.getuid?.())
        )
          throw new LinxUpdateOperationError("permissions");
        // Prove create/rename rights on this filesystem before the old app exits.
        const probe = await fs.mkdtemp(join(parent, ".linx-permission-"));
        const movedProbe = `${probe}-renamed`;
        try {
          await fs.rename(probe, movedProbe);
        } finally {
          await fs.rm(probe, { recursive: true, force: true });
          await fs.rm(movedProbe, { recursive: true, force: true });
        }
        const inventory = await inspectLinxUpdateArchive(request.packagePath);
        if (inventory.applicationName !== "Linx.app")
          throw new Error("Archive must contain exactly Linx.app");
        const space = await fs.statfs(parent);
        // Startup independently reconstructs the signed inventory in private scratch.
        if (space.bavail * space.bsize < 2 * inventory.expandedBytes + 256 * 1024 * 1024)
          throw new LinxUpdateOperationError("space");
        const retained = join(parent, `.linx-retained-${request.attemptId}.app`);
        if ((await exists(retained)) || (await exists(this.candidateRoot())))
          throw new Error("Candidate/retained destination already exists");
        const extracted = await extractLinxUpdateArchive(
          request.packagePath,
          this.candidateRoot(),
          { size: manifest.size, sha256: manifest.sha256 },
        );
        this.candidateOwned = true;
        this.candidateDigest = extracted.contentDigest;
        if (extracted.applicationPath !== this.candidate())
          throw new Error("Unexpected candidate application path");
        await fs.chmod(this.candidateRoot(), 0o700);
        if ((await fs.stat(this.candidate())).dev !== (await fs.stat(parent)).dev)
          throw new Error("Candidate is on another filesystem");
        await this.options.platform.prepareMetadata(
          request.packagePath,
          this.candidate(),
          extracted.resourceMetadata,
          manifest.assetUrl,
        );
        this.executable = await this.options.platform.validateBundle(
          this.candidate(),
          request.toVersion,
          true,
          manifest,
        );
        if ((await hashPrivatePackage(request.packagePath, manifest.size)) !== manifest.sha256)
          throw new Error("Authenticated package changed during extraction");
        await this.assertCandidate();
        await syncLinxHelperTree(this.candidateRoot());
        await syncLinxHelperTree(request.packagePath);
        await syncDirectoryEntry(parent);
        this.journal = {
          schemaVersion: 1,
          attemptId: request.attemptId,
          fromVersion: request.fromVersion,
          toVersion: request.toVersion,
          manifestDigest: request.manifestDigest,
          packageSha256: manifest.sha256,
          applicationPath: request.applicationPath,
          homePath: request.homePath,
          userDataPath: request.userDataPath,
          retainedApplicationPath: retained,
          recoveryDirectoryPath: this.file("recovery"),
          phase: "prepared",
          requestedAt: request.requestedAt,
          updatedAt: new Date().toISOString(),
          mayHaveWrittenData: false,
          message: null,
        };
        await this.phase("prepared");
        return this.response("prepared");
      }
      case "create-recovery": {
        if (!this.journal || this.recoveryReady)
          throw new Error("Recovery request is out of order");
        if (
          !command.userDataSnapshotPath ||
          !inside(this.options.attemptPath, command.userDataSnapshotPath) ||
          command.userDataSnapshotPath === this.options.attemptPath
        )
          throw new Error("Profile snapshot must be inside private attempt");
        await requireCanonicalPath(command.userDataSnapshotPath);
        this.ownership = await adoptLinxHomeOwnership({
          homePath: request.homePath,
          userDataPath: request.userDataPath,
          applicationPath: request.applicationPath,
          version: request.fromVersion,
          nonce,
        });
        this.database = await Effect.runPromise(
          acquireDatabaseLifecycleLock(join(request.homePath, "userdata/state.sqlite")),
        );
        await createLinxUpdateRecoverySet({
          recoveryDirectoryPath: this.journal.recoveryDirectoryPath,
          homePath: request.homePath,
          userDataPath: request.userDataPath,
          userDataSnapshotPath: command.userDataSnapshotPath,
          userDataSnapshotFormat: "portable-app-storage",
          attemptId: request.attemptId,
          sourceVersion: request.fromVersion,
        });
        await verifyLinxUpdateRecoverySet(this.journal.recoveryDirectoryPath);
        this.recoveryReady = true;
        return this.response("recovery-ready");
      }
      case "commit": {
        if (!this.recoveryReady || !command.release)
          throw new Error("Cannot commit without verified pre-exit recovery");
        requireLinxReceipt(
          command.release,
          release,
          manifest,
          request.manifestDigest,
          parseLinxUpdateSource(this.options.sourceJson)!.repository,
        );
        await this.options.platform.validateBundle(
          request.applicationPath,
          request.fromVersion,
          false,
        );
        await this.options.platform.validateBundle(
          this.candidate(),
          request.toVersion,
          true,
          manifest,
        );
        await this.assertCandidate();
        await verifyLinxUpdateRecoverySet(this.journal!.recoveryDirectoryPath);
        await this.assertParent();
        requireLinxReceipt(
          command.release,
          release,
          manifest,
          request.manifestDigest,
          parseLinxUpdateSource(this.options.sourceJson)!.repository,
        );
        await this.phase("waiting-for-exit");
        this.commitExpiresAt = Date.parse(command.release.verifiedAt) + 30_000;
        this.committed = true;
        return this.response("committed");
      }
      case "cancel":
        await this.cancel();
        return this.response("cancelled");
    }
  }
  private async releaseDatabase(): Promise<void> {
    if (this.database) {
      await Effect.runPromise(releaseDatabaseLifecycleLock(this.database));
      this.database = null;
    }
  }
  async cancel(): Promise<void> {
    if (this.committed) {
      await this.assertParent();
      this.committed = false;
    }
    let completed = false;
    try {
      await this.releaseDatabase();
      if (this.ownership) {
        if (linxHelperParentState(this.attempt.request.parentPid) === "live")
          await this.ownership.transfer({
            pid: this.attempt.request.parentPid,
            nonce: this.attempt.nonce,
            version: this.attempt.request.fromVersion,
          });
        else await this.ownership.release();
        this.ownership = null;
      }
      if (this.target && this.candidateOwned && (await exists(this.candidateRoot()))) {
        await this.target.assertHeld();
        await requirePrivateDirectory(this.candidateRoot());
        await fs.rm(this.candidateRoot(), { recursive: true });
        await syncDirectoryEntry(dirname(this.attempt.request.applicationPath));
      }
      if (this.journal) await this.phase("cancelled");
      this.terminal = true;
      completed = true;
    } finally {
      await this.releaseTarget(completed);
    }
  }
  isCommitted(): boolean {
    return this.committed;
  }
  isTerminal(): boolean {
    return this.terminal;
  }
  async disconnected(): Promise<void> {
    if (!this.committed && !this.terminal) await this.cancel();
  }
  /** Reestablish a dead helper's new-version handoff without ever restoring old code. */
  async resumeStartup(
    pid: number,
  ): Promise<{ request: LinxUpdateHealthRequest; journal: LinxUpdateInstallJournal }> {
    if (pid !== (this.options.parentPid ?? process.ppid) || linxHelperParentState(pid) !== "live")
      throw new Error(
        "Resumed startup must be requested by the actual live new-application parent",
      );
    this.attempt = await readLinxHelperAttempt(this.options.attemptPath, this.options.sourceJson);
    const { request, manifest } = this.attempt;
    const validated = await validateLinxUpdateHelperStartup({
      attemptPath: this.options.attemptPath,
      sourceJson: this.options.sourceJson,
      platform: this.options.platform,
      applicationPath: request.applicationPath,
      homePath: request.homePath,
      userDataPath: request.userDataPath,
      version: manifest.version,
      sourceCommit: manifest.sourceCommit,
      pid,
    });
    if (linxHelperParentState(validated.request.helperPid) !== "dead")
      throw new Error("Previous health helper is live or unknown");
    if (!["launching", "awaiting-health", "recovery-required"].includes(validated.journal.phase))
      throw new Error("Only interrupted new-version startup can resume");
    this.journal = validated.journal;
    this.target = await this.options.platform.acquireTargetLock(
      request.applicationPath,
      this.options.attemptPath,
    );
    try {
      this.executable = await this.options.platform.validateBundle(
        request.applicationPath,
        request.toVersion,
        true,
        manifest,
      );
      this.candidateDigest = await verifyLinxHelperBundleFromPackage({
        packagePath: request.packagePath,
        size: manifest.size,
        sha256: manifest.sha256,
        attemptPath: this.options.attemptPath,
        applicationPath: request.applicationPath,
      });
      this.ownership = await acquireLinxHomeOwnership({
        homePath: request.homePath,
        userDataPath: request.userDataPath,
        applicationPath: request.applicationPath,
        version: request.toVersion,
      });
      await this.target.assertHeld();
      this.database = await Effect.runPromise(
        acquireDatabaseLifecycleLock(join(request.homePath, "userdata/state.sqlite")),
      );
      for (const file of [F.healthClaim, F.healthOwnership, F.healthProof])
        await fs.rm(this.file(file), { force: true });
      const health = Schema.decodeUnknownSync(LinxUpdateHealthRequest)({
        ...validated.request,
        helperPid: process.pid,
        nonce: randomBytes(32).toString("hex"),
        createdAt: new Date().toISOString(),
      });
      await writePrivateJson(this.file(F.healthRequest), health);
      await this.phase(
        "awaiting-health",
        "Resuming independently verified new-version startup after helper interruption.",
        true,
      );
      return { request: health, journal: this.journal };
    } catch (error) {
      try {
        await this.releaseDatabase();
        if (this.ownership) await this.ownership.release();
        this.ownership = null;
      } finally {
        await this.releaseTarget(false);
      }
      throw error;
    }
  }
  async finishResumedStartup(health: LinxUpdateHealthRequest): Promise<void> {
    try {
      await this.awaitHealth(health);
    } catch (error) {
      await this.phase(
        "recovery-required",
        "Resumed new-version health was not proven. Preserve current data and the verified recovery set.",
        true,
      );
      throw error;
    } finally {
      try {
        await this.releaseDatabase();
        if (this.ownership) {
          await this.ownership.release();
          this.ownership = null;
        }
      } finally {
        await this.releaseTarget(this.journal?.phase === "healthy");
        this.terminal = true;
      }
    }
  }
  async installAfterParentExit(): Promise<void> {
    if (!this.committed || !this.journal || !this.ownership)
      throw new Error("No explicit committed handoff");
    const { request, manifest } = this.attempt;
    const deadline = Math.min(
      this.commitExpiresAt,
      Date.now() + (this.options.parentExitTimeoutMs ?? 60_000),
    );
    while (linxHelperParentState(request.parentPid) !== "dead") {
      if (!this.committed) return;
      if (Date.now() >= deadline) {
        this.committed = false;
        await this.cancel();
        throw new Error("Parent did not exit; installation cancelled");
      }
      await delay(100);
    }
    if (!this.committed) return;
    if (Date.now() > this.commitExpiresAt) {
      this.committed = false;
      await this.cancel();
      throw new Error("Final release observation expired before parent exit");
    }
    try {
      await this.options.platform.validateBundle(
        request.applicationPath,
        request.fromVersion,
        false,
      );
      await this.options.platform.validateBundle(
        this.candidate(),
        request.toVersion,
        true,
        manifest,
      );
      await this.assertCandidate();
      await fs.rename(request.applicationPath, this.journal.retainedApplicationPath);
      await syncDirectoryEntry(dirname(request.applicationPath));
      await this.phase("old-retained");
      await this.target!.assertHeld();
      await fs.rename(this.candidate(), request.applicationPath);
      await syncDirectoryEntry(this.candidateRoot());
      await syncDirectoryEntry(dirname(request.applicationPath));
      await this.phase("new-installed");
      this.executable = await this.options.platform.validateBundle(
        request.applicationPath,
        request.toVersion,
        true,
        manifest,
      );
      const health = Schema.decodeUnknownSync(LinxUpdateHealthRequest)({
        schemaVersion: 1,
        attemptId: request.attemptId,
        manifestDigest: request.manifestDigest,
        nonce: randomBytes(32).toString("hex"),
        helperPid: process.pid,
        applicationPath: request.applicationPath,
        homePath: request.homePath,
        userDataPath: request.userDataPath,
        version: request.toVersion,
        sourceCommit: manifest.sourceCommit,
        createdAt: new Date().toISOString(),
      });
      await writePrivateJson(this.file(F.healthRequest), health);
      // Sticky and durable BEFORE LaunchServices may start any new-version code.
      await this.assertCandidate(request.applicationPath);
      await this.phase("launching", null, true);
      await this.options.platform.launch(request.applicationPath, this.options.attemptPath);
      await this.phase("awaiting-health");
      await this.awaitHealth(health);
      this.terminal = true;
    } catch (error) {
      if (this.journal.mayHaveWrittenData) {
        try {
          await this.phase(
            "recovery-required",
            "New application may have written data. Keep the retained application and verified recovery set; do not reopen old code against current data.",
          );
        } finally {
          // Do not kill an active new app or reclaim its transferred home lease.
          await this.releaseDatabase();
          if (this.ownership) {
            await this.ownership.release();
            this.ownership = null;
          }
        }
      } else {
        try {
          if (!this.target) throw new Error("No installation target ownership for rollback");
          await this.target.assertHeld();
          if (await exists(this.journal.retainedApplicationPath)) {
            await this.options.platform.validateBundle(
              this.journal.retainedApplicationPath,
              request.fromVersion,
              false,
            );
            if (await exists(request.applicationPath)) {
              await requireCanonicalPath(request.applicationPath);
              if (await exists(this.candidate()))
                throw new Error(
                  "Both installed and staged candidates exist; preserve the interrupted attempt",
                );
              await this.target.assertHeld();
              await fs.rename(request.applicationPath, this.candidate());
              await syncDirectoryEntry(dirname(request.applicationPath));
              await syncDirectoryEntry(this.candidateRoot());
            }
            await this.target.assertHeld();
            await fs.rename(this.journal.retainedApplicationPath, request.applicationPath);
            await syncDirectoryEntry(dirname(request.applicationPath));
          }
          await this.options.platform.validateBundle(
            request.applicationPath,
            request.fromVersion,
            false,
          );
          await this.phase(
            "rolled-back",
            "Installation failed before any new-version launch; previous application restored.",
          );
        } finally {
          await this.releaseDatabase();
          if (this.ownership) {
            await this.ownership.release();
            this.ownership = null;
          }
        }
        await this.target!.assertHeld();
        await this.options.platform.launch(request.applicationPath);
      }
      this.terminal = true;
      throw error;
    } finally {
      await this.releaseTarget(
        this.journal.phase === "healthy" || this.journal.phase === "rolled-back",
      );
    }
  }
  private async awaitHealth(health: LinxUpdateHealthRequest): Promise<void> {
    const deadline = Date.now() + (this.options.healthTimeoutMs ?? 120_000);
    let claimedPid: number | null = null;
    while (Date.now() < deadline) {
      if (claimedPid === null && (await exists(this.file(F.healthClaim)))) {
        const claim = Schema.decodeUnknownSync(LinxUpdateHealthProof)(
          await readPrivateJson(this.file(F.healthClaim)),
        );
        await this.validateProof(claim, health, "claim");
        claimedPid = claim.pid;
        await this.ownership!.transfer({
          pid: claim.pid,
          nonce: health.nonce,
          version: health.version,
        });
        this.ownership = null;
        await this.releaseDatabase();
        await writePrivateJson(this.file(F.healthOwnership), health);
      }
      if (claimedPid !== null && (await exists(this.file(F.healthProof)))) {
        const proof = Schema.decodeUnknownSync(LinxUpdateHealthProof)(
          await readPrivateJson(this.file(F.healthProof)),
        );
        await this.validateProof(proof, health, "healthy");
        if (proof.pid !== claimedPid)
          throw new Error("Health PID changed after ownership transfer");
        await this.phase("healthy");
        return;
      }
      await delay(100);
    }
    throw new Error(
      "New application did not provide process-bound backend/client health before the deadline",
    );
  }
  private async validateProof(
    proof: LinxUpdateHealthProof,
    health: LinxUpdateHealthRequest,
    phase: "claim" | "healthy",
  ): Promise<void> {
    for (const key of Object.keys(health) as (keyof LinxUpdateHealthRequest)[])
      if (proof[key] !== health[key]) throw new Error("Health attempt binding mismatch");
    if (
      proof.phase !== phase ||
      proof.pid === this.attempt.request.parentPid ||
      proof.pid === process.pid ||
      linxHelperParentState(proof.pid) !== "live" ||
      (await this.options.platform.pidPath(proof.pid)) !== this.executable
    )
      throw new Error("Health proof is not from the installed application process");
    await this.options.platform.validateBundle(
      health.applicationPath,
      health.version,
      true,
      this.attempt.manifest,
    );
    await this.assertCandidate(health.applicationPath);
  }
}

export async function validateLinxUpdateHelperStartup(input: {
  attemptPath: string;
  applicationPath: string;
  homePath: string;
  userDataPath: string;
  version: string;
  sourceCommit: string;
  sourceJson: string;
  platform: LinxHelperPlatform;
  pid?: number;
}): Promise<{ request: LinxUpdateHealthRequest; journal: LinxUpdateInstallJournal }> {
  const attempt = await readLinxHelperAttempt(input.attemptPath, input.sourceJson);
  const journal = Schema.decodeUnknownSync(LinxUpdateInstallJournal)(
    await readPrivateJson(join(input.attemptPath, F.journal)),
  );
  const request = Schema.decodeUnknownSync(LinxUpdateHealthRequest)(
    await readPrivateJson(join(input.attemptPath, F.healthRequest)),
  );
  if (
    journal.attemptId !== attempt.request.attemptId ||
    journal.manifestDigest !== attempt.request.manifestDigest ||
    journal.packageSha256 !== attempt.manifest.sha256 ||
    journal.fromVersion !== attempt.request.fromVersion ||
    journal.toVersion !== attempt.manifest.version ||
    !journal.mayHaveWrittenData ||
    !["launching", "awaiting-health", "healthy", "recovery-required"].includes(journal.phase)
  )
    throw new Error("Startup journal does not authorize new-version data access");
  for (const key of ["applicationPath", "homePath", "userDataPath"] as const)
    if (
      request[key] !== input[key] ||
      journal[key] !== input[key] ||
      attempt.request[key] !== input[key]
    )
      throw new Error("Startup roots differ from signed attempt");
  for (const key of ["requestedAt"] as const)
    if (journal[key] !== attempt.request[key])
      throw new Error("Startup journal timing differs from attempt");
  if (
    (await hashPrivatePackage(attempt.request.packagePath, attempt.manifest.size)) !==
    attempt.manifest.sha256
  )
    throw new Error("Startup signed package hash mismatch");
  if (
    request.attemptId !== journal.attemptId ||
    request.manifestDigest !== journal.manifestDigest ||
    request.version !== input.version ||
    request.version !== attempt.manifest.version ||
    request.sourceCommit !== input.sourceCommit ||
    request.sourceCommit !== attempt.manifest.sourceCommit
  )
    throw new Error("Startup version/source binding mismatch");
  if (
    journal.retainedApplicationPath !==
      join(dirname(input.applicationPath), `.linx-retained-${journal.attemptId}.app`) ||
    journal.recoveryDirectoryPath !== join(input.attemptPath, "recovery")
  )
    throw new Error("Startup recovery paths differ from fixed attempt layout");
  await verifyLinxUpdateRecoverySet(journal.recoveryDirectoryPath);
  const executable = await input.platform.validateBundle(
    input.applicationPath,
    input.version,
    true,
    attempt.manifest,
  );
  await verifyLinxHelperBundleFromPackage({
    packagePath: attempt.request.packagePath,
    size: attempt.manifest.size,
    sha256: attempt.manifest.sha256,
    attemptPath: input.attemptPath,
    applicationPath: input.applicationPath,
  });
  if ((await input.platform.pidPath(input.pid ?? process.pid)) !== executable)
    throw new Error("Startup kernel process does not match installed bundle");
  return { request, journal };
}
