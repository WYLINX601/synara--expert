import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Schema } from "effect";
import {
  LinxUpdateInstallJournal,
  LinxUpdateHealthRequest,
  compareLinxInstalledAppVersions,
  type LinxUpdateHealthProof,
} from "@synara/contracts";
import {
  adoptLinxHomeOwnership,
  type LinxHomeOwnershipInput,
  type LinxHomeOwnership,
} from "@synara/shared/linxUpdateHomeOwnership";
import { writeLinxPrivateJson } from "./linxUpdateController";
import { spawnProcess, spawnProcessSync } from "@synara/shared/processRuntime";
import { setTimeout as delay } from "node:timers/promises";

const StartupValidation = Schema.Struct({
  request: LinxUpdateHealthRequest,
  journal: LinxUpdateInstallJournal,
});

/** ESRCH alone proves death; permission errors and PID reuse never authorize theft. */
function helperIsDead(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return true;
    throw new Error("Update helper liveness is unknown; preserve the recovery set");
  }
}

async function resumeLinxStartupHelper(helperPath: string, attemptPath: string, timeoutMs: number) {
  const child = spawnProcess(helperPath, ["--resume-startup", attemptPath, String(process.pid)], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (!child.stdout || !child.stderr || !child.pid)
    throw new Error("Startup recovery helper did not start with private pipes");
  child.stderr.resume();
  const ready = Promise.withResolvers<typeof StartupValidation.Type>();
  let settled = false;
  let size = 0;
  let pending = "";
  const fail = () => {
    settled = true;
    ready.reject(new Error("Verified startup recovery helper did not grant a fresh handoff"));
  };
  const timer = setTimeout(fail, timeoutMs);
  child.once("error", fail);
  child.once("exit", () => {
    if (!settled) fail();
  });
  child.stdout.on("data", (chunk: Buffer) => {
    if (settled) return;
    size += chunk.length;
    if (size > 128 * 1024) {
      fail();
      return;
    }
    pending += chunk.toString("utf8");
    const newline = pending.indexOf("\n");
    if (newline < 0) return;
    try {
      if (pending.slice(newline + 1).trim()) throw new Error("Unexpected recovery helper output");
      const value = Schema.decodeUnknownSync(StartupValidation)(
        JSON.parse(pending.slice(0, newline)),
      );
      if (value.request.helperPid !== child.pid)
        throw new Error("Recovery helper PID binding changed");
      settled = true;
      ready.resolve(value);
    } catch {
      fail();
    }
  });
  try {
    return await ready.promise;
  } finally {
    clearTimeout(timer);
  }
}

export interface LinxUpdateStartupHealth {
  ownership: LinxHomeOwnership;
  complete(input: {
    backendReady: boolean;
    clientConnected: boolean;
    homePath: string;
    sourceCommit: string;
  }): Promise<void>;
}
export async function readLinxPrivateJson(filePath: string): Promise<unknown> {
  const stat = await fs.lstat(filePath);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o077) !== 0 ||
    stat.size > 64 * 1024
  )
    throw new Error("Unsafe private update record");
  const handle = await fs.open(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const actual = await handle.stat();
    if (actual.ino !== stat.ino || actual.dev !== stat.dev || actual.size !== stat.size)
      throw new Error("Private update record changed");
    const bytes = Buffer.alloc(64 * 1024 + 1);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    const after = await handle.stat();
    if (
      bytesRead !== actual.size ||
      bytesRead > 64 * 1024 ||
      after.size !== actual.size ||
      after.mtimeMs !== actual.mtimeMs ||
      after.ctimeMs !== actual.ctimeMs
    )
      throw new Error("Private update record changed while reading");
    return JSON.parse(bytes.subarray(0, bytesRead).toString("utf8"));
  } finally {
    await handle.close();
  }
}

/** Journal discovery precedes any home/profile access. Uncertainty never authorizes old startup. */
export async function findLinxUpdateStartupAttempt(
  input: LinxHomeOwnershipInput & { attemptsPath: string; arguments: readonly string[] },
): Promise<string | null> {
  const index = input.arguments.indexOf("--linx-update-attempt");
  const explicit = index < 0 ? null : input.arguments[index + 1];
  if (
    explicit === undefined ||
    (index >= 0 && (!explicit || input.arguments.indexOf("--linx-update-attempt", index + 1) >= 0))
  )
    throw new Error("Invalid update startup claim");
  const root = await fs.lstat(input.attemptsPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT" && explicit === null) return null;
    throw error;
  });
  if (root === null) return null;
  if (
    !root.isDirectory() ||
    root.isSymbolicLink() ||
    root.uid !== process.getuid?.() ||
    (root.mode & 0o077) !== 0 ||
    (await fs.realpath(input.attemptsPath)) !== input.attemptsPath
  ) {
    throw new Error("Unsafe update attempt root; preserve recovery evidence");
  }
  const entries = await fs
    .readdir(input.attemptsPath, { withFileTypes: true })
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT" && explicit === null) return [];
      throw error;
    });
  if (entries.length > 256)
    throw new Error("Too many update attempts; inspect retained recovery records");
  let selected: string | null = null;
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink())
      throw new Error("Unsafe update attempt entry");
    const attemptPath = path.join(input.attemptsPath, entry.name);
    const journal = await readLinxPrivateJson(path.join(attemptPath, "linx-update-install.json"))
      .then(Schema.decodeUnknownSync(LinxUpdateInstallJournal))
      .catch((error: NodeJS.ErrnoException) => {
        // An interrupted preflight without a journal has never changed applications
        // or received ownership. It cannot authorize a startup claim.
        if (error.code === "ENOENT" && explicit !== attemptPath) return null;
        throw error;
      });
    if (journal === null) continue;
    if (
      journal.homePath !== input.homePath ||
      journal.userDataPath !== input.userDataPath ||
      journal.applicationPath !== input.applicationPath ||
      journal.attemptId !== entry.name
    )
      throw new Error("Update journal belongs to different application/data roots");
    const order = compareLinxInstalledAppVersions(input.version, journal.toVersion);
    if (journal.mayHaveWrittenData && (order === null || order < 0))
      throw new Error(
        "A newer application may have written this home; do not start old code or overwrite recovery data",
      );
    if (["healthy", "cancelled", "rolled-back"].includes(journal.phase)) continue;
    if (
      !journal.mayHaveWrittenData &&
      ["prepared", "waiting-for-exit"].includes(journal.phase) &&
      explicit === null
    ) {
      // Whole-home acquisition independently proves the helper/cohort is dead.
      continue;
    }
    if (
      journal.toVersion !== input.version ||
      !["launching", "awaiting-health", "recovery-required"].includes(journal.phase)
    )
      throw new Error(
        "Interrupted installation requires recovery; keep retained application and verified recovery set",
      );
    if (selected !== null)
      throw new Error("Multiple unfinished installations require recovery inspection");
    selected = attemptPath;
  }
  if (explicit !== null && (path.resolve(explicit) !== explicit || selected !== explicit))
    throw new Error("Startup attempt is not the durable pending update");
  return selected;
}

export async function claimLinxUpdateStartup(
  input: LinxHomeOwnershipInput & {
    attemptPath: string;
    sourceCommit: string;
    helperPath: string;
    timeoutMs?: number;
  },
): Promise<LinxUpdateStartupHealth> {
  const bundle = spawnProcessSync(
    "/usr/bin/codesign",
    ["--verify", "--deep", "--strict", input.applicationPath],
    { encoding: "utf8", timeout: 60_000 },
  );
  if (bundle.error || bundle.status !== 0)
    throw new Error("Installed update resource seal authentication failed");
  const signature = spawnProcessSync(
    "/usr/bin/codesign",
    ["--verify", "--strict", input.helperPath],
    { encoding: "utf8", timeout: 30_000 },
  );
  if (signature.error || signature.status !== 0)
    throw new Error("Startup helper authentication failed");
  const validation = spawnProcessSync(
    input.helperPath,
    ["--validate-startup", input.attemptPath, String(process.pid)],
    { encoding: "utf8", timeout: 60_000, maxBuffer: 128 * 1024 },
  );
  if (validation.error || validation.status !== 0)
    throw new Error("Durable update startup validation failed; preserve the verified recovery set");
  let validated = Schema.decodeUnknownSync(StartupValidation)(JSON.parse(validation.stdout));
  if (helperIsDead(validated.request.helperPid)) {
    validated = await resumeLinxStartupHelper(
      input.helperPath,
      input.attemptPath,
      input.timeoutMs ?? 60_000,
    );
  }
  const { request } = validated;
  if (
    request.applicationPath !== input.applicationPath ||
    request.homePath !== input.homePath ||
    request.userDataPath !== input.userDataPath ||
    request.version !== input.version ||
    request.sourceCommit !== input.sourceCommit
  )
    throw new Error("Startup source or data roots do not match the verified update");
  const proof: LinxUpdateHealthProof = {
    ...request,
    pid: process.pid,
    phase: "claim",
    backendReady: false,
    clientConnected: false,
  };
  await writeLinxPrivateJson(path.join(input.attemptPath, "health-claim.json"), proof);
  const deadline = Date.now() + (input.timeoutMs ?? 30_000);
  for (;;) {
    const grant = await readLinxPrivateJson(
      path.join(input.attemptPath, "health-ownership.json"),
    ).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (grant !== null) {
      const accepted = Schema.decodeUnknownSync(LinxUpdateHealthRequest)(grant);
      if (JSON.stringify(accepted) !== JSON.stringify(request))
        throw new Error("Health ownership grant does not match this startup");
      break;
    }
    if (helperIsDead(request.helperPid))
      throw new Error(
        "Update helper died before ownership grant; preserve the recovery set and reopen this same new version",
      );
    if (Date.now() >= deadline)
      throw new Error("Helper did not grant home ownership; recovery is required");
    await delay(100);
  }
  const ownership = await adoptLinxHomeOwnership({
    homePath: input.homePath,
    userDataPath: input.userDataPath,
    applicationPath: input.applicationPath,
    version: input.version,
    nonce: request.nonce,
  });
  let completed = false;
  return {
    ownership,
    complete: async (health) => {
      if (completed) return;
      if (
        !health.backendReady ||
        !health.clientConnected ||
        health.homePath !== request.homePath ||
        health.sourceCommit !== request.sourceCommit
      )
        throw new Error("New backend, managed client and source/home health are not proven");
      await writeLinxPrivateJson(path.join(input.attemptPath, "health-proof.json"), {
        ...proof,
        phase: "healthy",
        backendReady: true,
        clientConnected: true,
      } satisfies LinxUpdateHealthProof);
      const healthDeadline = Date.now() + (input.timeoutMs ?? 60_000);
      for (;;) {
        const journal = Schema.decodeUnknownSync(LinxUpdateInstallJournal)(
          await readLinxPrivateJson(path.join(input.attemptPath, "linx-update-install.json")),
        );
        if (
          journal.attemptId !== request.attemptId ||
          journal.manifestDigest !== request.manifestDigest ||
          journal.toVersion !== request.version ||
          !journal.mayHaveWrittenData
        )
          throw new Error("Update health journal binding changed");
        if (journal.phase === "healthy") break;
        if (
          journal.phase === "recovery-required" ||
          helperIsDead(request.helperPid) ||
          Date.now() >= healthDeadline
        ) {
          throw new Error(
            "Update helper did not durably acknowledge health; preserve current data and verified recovery",
          );
        }
        await delay(100);
      }
      completed = true;
    },
  };
}
