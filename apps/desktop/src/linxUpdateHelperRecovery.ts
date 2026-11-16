import * as fs from "node:fs/promises";
import { dirname, join } from "node:path";
import { Effect, Schema } from "effect";
import { LinxUpdateInstallJournal } from "@synara/contracts";
import { acquireLinxHomeOwnership } from "@synara/shared/linxUpdateHomeOwnership";
import {
  acquireDatabaseLifecycleLock,
  releaseDatabaseLifecycleLock,
} from "@synara/shared/databaseLifecycleLock";
import { verifyLinxUpdateRecoverySet } from "@synara/shared/linxUpdateRecovery";
import { syncDirectoryEntry } from "@synara/shared/filesystemPlatform";
import {
  LINX_HELPER_FILES as F,
  readPrivateJson,
  writePrivateJson,
  exists,
  hashPrivatePackage,
  verifyLinxHelperBundleFromPackage,
} from "./linxUpdateHelperFiles";
import { readLinxHelperAttempt, linxHelperParentState } from "./linxUpdateHelperCore";
import type { LinxHelperPlatform } from "./linxUpdateHelperPlatform";

/** Offline interruption recovery. It never starts old code once new code could have run. */
export async function recoverLinxUpdateHelperAttempt(input: {
  attemptPath: string;
  sourceJson: string;
  platform: LinxHelperPlatform;
}): Promise<LinxUpdateInstallJournal> {
  const { request, manifest } = await readLinxHelperAttempt(input.attemptPath, input.sourceJson);
  const path = join(input.attemptPath, F.journal);
  const retained = join(
    dirname(request.applicationPath),
    `.linx-retained-${request.attemptId}.app`,
  );
  const candidateRoot = join(
    dirname(request.applicationPath),
    `.linx-candidate-${request.attemptId}`,
  );
  const recovery = join(input.attemptPath, "recovery");
  const recorded = await exists(path);
  // A crash can precede the first prepared journal. Only the untouched old app
  // and absence of any replacement/launch evidence permit completing that lease.
  const journal = Schema.decodeUnknownSync(LinxUpdateInstallJournal)(
    recorded
      ? await readPrivateJson(path)
      : {
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
          recoveryDirectoryPath: recovery,
          phase: "prepared",
          requestedAt: request.requestedAt,
          updatedAt: new Date().toISOString(),
          mayHaveWrittenData: false,
          message: null,
        },
  );
  for (const key of [
    "attemptId",
    "fromVersion",
    "toVersion",
    "manifestDigest",
    "applicationPath",
    "homePath",
    "userDataPath",
    "requestedAt",
  ] as const)
    if (journal[key] !== request[key])
      throw new Error("Recovery journal bindings differ from signed attempt");
  if (
    journal.packageSha256 !== manifest.sha256 ||
    journal.retainedApplicationPath !== retained ||
    journal.recoveryDirectoryPath !== recovery
  )
    throw new Error("Recovery paths/package differ from fixed attempt");
  if ((await hashPrivatePackage(request.packagePath, manifest.size)) !== manifest.sha256)
    throw new Error("Recovery package hash mismatch");
  const target = await input.platform.acquireTargetLock(request.applicationPath, input.attemptPath);
  let completed = false;
  try {
    if (
      !recorded &&
      ((await exists(retained)) || (await exists(join(input.attemptPath, F.healthRequest))))
    )
      throw new Error("Missing journal with replacement evidence; preserve the interrupted target");
    const risk =
      journal.mayHaveWrittenData ||
      ["launching", "awaiting-health", "healthy", "recovery-required"].includes(journal.phase);
    if (risk) {
      await input.platform.validateBundle(
        request.applicationPath,
        request.toVersion,
        true,
        manifest,
      );
      await verifyLinxHelperBundleFromPackage({
        packagePath: request.packagePath,
        size: manifest.size,
        sha256: manifest.sha256,
        attemptPath: input.attemptPath,
        applicationPath: request.applicationPath,
      });
      await verifyLinxUpdateRecoverySet(recovery);
      if (journal.phase === "healthy") {
        completed = true;
        return journal;
      }
      const blocked = {
        ...journal,
        phase: "recovery-required" as const,
        mayHaveWrittenData: true,
        updatedAt: new Date().toISOString(),
        message:
          "New-version writes cannot be excluded. Keep current data and the verified recovery set. Never automatically reopen the retained old application.",
      };
      await writePrivateJson(path, blocked);
      return blocked;
    }
    if (linxHelperParentState(request.parentPid) !== "dead")
      throw new Error("Cannot recover while the original parent is live or unknown");
    // Whole-home stale-owner/cohort/version-floor checks are independently enforced here.
    const ownership = await acquireLinxHomeOwnership({
      homePath: request.homePath,
      userDataPath: request.userDataPath,
      applicationPath: request.applicationPath,
      version: request.fromVersion,
    });
    let database;
    try {
      database = await Effect.runPromise(
        acquireDatabaseLifecycleLock(join(request.homePath, "userdata/state.sqlite")),
      );
      await target.assertHeld();
      if (await exists(retained)) {
        await input.platform.validateBundle(retained, request.fromVersion, false);
        await verifyLinxUpdateRecoverySet(recovery);
        if (await exists(request.applicationPath)) {
          await input.platform.validateBundle(
            request.applicationPath,
            request.toVersion,
            true,
            manifest,
          );
          const candidate = join(candidateRoot, "Linx.app");
          if (await exists(candidate))
            throw new Error(
              "Both installed and staged candidate exist; retain all evidence for manual recovery",
            );
          await target.assertHeld();
          await fs.rename(request.applicationPath, candidate);
          await syncDirectoryEntry(candidateRoot);
          await syncDirectoryEntry(dirname(request.applicationPath));
        }
        await target.assertHeld();
        await fs.rename(retained, request.applicationPath);
        await syncDirectoryEntry(dirname(request.applicationPath));
      } else {
        if (["old-retained", "new-installed"].includes(journal.phase))
          throw new Error("Retained application missing during rename-gap recovery");
        await input.platform.validateBundle(request.applicationPath, request.fromVersion, false);
      }
      const restored = {
        ...journal,
        phase: "rolled-back" as const,
        updatedAt: new Date().toISOString(),
        message:
          "Interrupted installation restored before any possible new-version launch. Recovery set and package retained.",
      };
      await writePrivateJson(path, restored);
      completed = true;
      return restored;
    } finally {
      if (database) await Effect.runPromise(releaseDatabaseLifecycleLock(database));
      await ownership.release();
    }
  } finally {
    await target.release(completed);
  }
}
