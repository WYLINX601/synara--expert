import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import type { Stats } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Effect, Schema } from "effect";
import {
  LINX_HOME_OWNERSHIP_MAX_BYTES,
  LinxHomeOwnershipRecord,
  LinxInstalledAppVersion,
  compareLinxInstalledAppVersions,
} from "@synara/contracts";
import type { LinxHomeOwnershipMember, LinxHomeOwnershipProcess } from "@synara/contracts";
import {
  acquireDatabaseLifecycleLock,
  releaseDatabaseLifecycleLock,
} from "./databaseLifecycleLock";
import { canonicalLinxDataPath } from "./linxUpdateRecovery";
import { syncDirectoryEntry } from "./filesystemPlatform";
import { execProcessFile } from "./processRuntime";

const decodeRecord = Schema.decodeUnknownSync(LinxHomeOwnershipRecord);
const NONCE = /^[a-f0-9]{64}$/u;
const RECORD_FILE = "owner.json";
export interface LinxHomeOwnershipInput {
  homePath: string;
  userDataPath: string;
  applicationPath: string;
  version: string;
}
export interface LinxHomeOwnership {
  readonly nonce: string;
  transfer(input: { pid: number; nonce: string; version: string }): Promise<void>;
  release(): Promise<void>;
}

function processState(pid: number): "live" | "dead" | "unknown" {
  try {
    process.kill(pid, 0);
    return "live";
  } catch (cause) {
    return (cause as NodeJS.ErrnoException).code === "ESRCH" ? "dead" : "unknown";
  }
}

async function processIdentity(pid: number): Promise<LinxHomeOwnershipProcess> {
  if (!Number.isSafeInteger(pid) || pid <= 0 || processState(pid) !== "live")
    throw new Error("Ownership target process is not provably live");
  const startedAt = await new Promise<string>((resolve, reject) => {
    execProcessFile(
      "/bin/ps",
      ["-p", String(pid), "-o", "lstart="],
      { encoding: "utf8", timeout: 5_000, maxBuffer: 4_096, env: { LC_ALL: "C" } },
      (error, stdout) => (error ? reject(error) : resolve(stdout.trim())),
    );
  });
  if (!startedAt || startedAt.includes("\n") || processState(pid) !== "live")
    throw new Error("Ownership process start identity is unknown");
  return { pid, startedAt };
}

function sameProcess(a: LinxHomeOwnershipProcess, b: LinxHomeOwnershipProcess): boolean {
  return a.pid === b.pid && a.startedAt === b.startedAt;
}

function privateOwned(stat: Stats, label: string, directory: boolean): void {
  if (
    (directory ? !stat.isDirectory() : !stat.isFile()) ||
    stat.isSymbolicLink() ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o022) !== 0
  )
    throw new Error(
      `Unsafe ownership ${label}: real, current-UID, non-writable-by-others path required`,
    );
}

async function canonicalBindings(input: LinxHomeOwnershipInput): Promise<LinxHomeOwnershipInput> {
  Schema.decodeUnknownSync(LinxInstalledAppVersion)(input.version);
  const homePath = await canonicalLinxDataPath(input.homePath);
  const userDataPath = await canonicalLinxDataPath(input.userDataPath);
  for (const root of [homePath, userDataPath]) {
    privateOwned(await fs.lstat(path.dirname(root)), "data parent", true);
    const stat = await fs.lstat(root).catch((cause: NodeJS.ErrnoException) => {
      if (cause.code === "ENOENT") return null;
      throw cause;
    });
    if (stat) privateOwned(stat, "data root", true);
  }
  const relative = path.relative(homePath, userDataPath);
  const reverse = path.relative(userDataPath, homePath);
  if (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative)) ||
    (!reverse.startsWith(`..${path.sep}`) && reverse !== ".." && !path.isAbsolute(reverse))
  )
    throw new Error("Home and Chromium profile must be disjoint");
  const suppliedApplication = await fs
    .lstat(input.applicationPath)
    .catch((cause: NodeJS.ErrnoException) => {
      if (cause.code === "ENOENT") return null;
      throw cause;
    });
  let applicationPath: string;
  if (suppliedApplication === null) {
    // The fixed app path may be absent after old-retained but before new-installed.
    // Only an already published exact root binding can authorize this claim.
    const parent = await fs.realpath(path.dirname(input.applicationPath));
    const parentStat = await fs.lstat(parent);
    if (
      !parentStat.isDirectory() ||
      parentStat.isSymbolicLink() ||
      (parentStat.mode & 0o002) !== 0 ||
      (parentStat.uid !== process.getuid?.() && parentStat.uid !== 0)
    )
      throw new Error("Missing application has an unsafe parent");
    applicationPath = path.join(parent, path.basename(input.applicationPath));
    const existing = await readRecord(`${homePath}.linx-owner`);
    if (
      existing.homePath !== homePath ||
      existing.userDataPath !== userDataPath ||
      existing.applicationPath !== applicationPath
    ) {
      throw new Error("Missing application requires its exact persisted ownership binding");
    }
  } else {
    if (suppliedApplication.isSymbolicLink())
      throw new Error("Ownership application path cannot be a symlink");
    applicationPath = await fs.realpath(input.applicationPath);
    const application = await fs.lstat(applicationPath);
    if (
      !application.isDirectory() ||
      application.isSymbolicLink() ||
      (application.mode & 0o002) !== 0 ||
      (application.uid !== process.getuid?.() && application.uid !== 0)
    )
      throw new Error("Ownership application path is unsafe");
  }
  return { homePath, userDataPath, applicationPath, version: input.version };
}

function assertBindings(record: LinxHomeOwnershipRecord, input: LinxHomeOwnershipInput): void {
  if (
    record.uid !== process.getuid?.() ||
    record.homePath !== input.homePath ||
    record.userDataPath !== input.userDataPath ||
    record.applicationPath !== input.applicationPath ||
    record.version !== input.version
  )
    throw new Error("Whole-home ownership root/profile/application/version binding mismatch");
}

async function readRecord(directory: string): Promise<LinxHomeOwnershipRecord> {
  const directoryStat = await fs.lstat(directory);
  privateOwned(directoryStat, "directory", true);
  if ((directoryStat.mode & 0o077) !== 0) throw new Error("Ownership directory must be private");
  const filePath = path.join(directory, RECORD_FILE);
  const before = await fs.lstat(filePath);
  privateOwned(before, "record", false);
  if ((before.mode & 0o077) !== 0) throw new Error("Ownership record must be private");
  const handle = await fs.open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    privateOwned(opened, "opened record", false);
    if (
      opened.ino !== before.ino ||
      opened.dev !== before.dev ||
      opened.size > LINX_HOME_OWNERSHIP_MAX_BYTES
    )
      throw new Error("Ownership record changed or exceeds bounds");
    const bytes = Buffer.alloc(LINX_HOME_OWNERSHIP_MAX_BYTES + 1);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead > LINX_HOME_OWNERSHIP_MAX_BYTES || bytesRead !== opened.size)
      throw new Error("Ownership record is truncated or changed");
    const after = await handle.stat();
    if (
      after.size !== opened.size ||
      after.mtimeMs !== opened.mtimeMs ||
      after.ctimeMs !== opened.ctimeMs
    )
      throw new Error("Ownership record changed while reading");
    const record = decodeRecord(JSON.parse(bytes.subarray(0, bytesRead).toString("utf8")));
    if (record.uid !== process.getuid?.()) throw new Error("Ownership record UID mismatch");
    return record;
  } finally {
    await handle.close();
  }
}

async function writeRecord(directory: string, record: LinxHomeOwnershipRecord): Promise<void> {
  const text = `${JSON.stringify(decodeRecord(record))}\n`;
  if (Buffer.byteLength(text) > LINX_HOME_OWNERSHIP_MAX_BYTES)
    throw new Error("Ownership cohort exceeds record bounds");
  const temporary = path.join(directory, `.owner-${randomUUID()}.json`);
  const handle = await fs.open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(text);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(temporary, path.join(directory, RECORD_FILE));
  await syncDirectoryEntry(directory);
}

async function mutate<A>(directory: string, use: () => Promise<A>): Promise<A> {
  privateOwned(await fs.lstat(directory), "directory", true);
  const lock = await Effect.runPromise(
    acquireDatabaseLifecycleLock(path.join(directory, "mutation")),
  );
  try {
    return await use();
  } finally {
    await Effect.runPromise(releaseDatabaseLifecycleLock(lock));
  }
}

function requireNonce(nonce: string): string {
  if (!NONCE.test(nonce))
    throw new Error(
      "Whole-home ownership nonce must contain 32 random bytes encoded as lowercase hex",
    );
  return createHash("sha256").update(nonce).digest("hex");
}

function matchesNonce(record: LinxHomeOwnershipRecord, nonce: string): boolean {
  const digest = requireNonce(nonce);
  return (
    record.nonceDigest !== null &&
    timingSafeEqual(Buffer.from(record.nonceDigest, "hex"), Buffer.from(digest, "hex"))
  );
}

function deadMembersOnly(members: readonly LinxHomeOwnershipMember[]): void {
  // Even a different start identity is NOT permission to reap a reused live PID.
  if (members.some((member) => processState(member.process.pid) !== "dead"))
    throw new Error("Ownership has a live, reused-PID or unknown cohort member");
}

function lease(
  directory: string,
  bindings: LinxHomeOwnershipInput,
  nonce: string,
  owner: LinxHomeOwnershipProcess,
  generation: number,
): LinxHomeOwnership {
  let released = false;
  async function current(): Promise<LinxHomeOwnershipRecord> {
    if (released) throw new Error("Whole-home ownership handle was released or transferred");
    const record = await readRecord(directory);
    assertBindings(record, bindings);
    if (
      record.generation !== generation ||
      !record.adopted ||
      record.owner === null ||
      !sameProcess(record.owner, owner) ||
      !matchesNonce(record, nonce) ||
      !sameProcess(await processIdentity(process.pid), owner)
    ) {
      throw new Error("Stale whole-home ownership handle cannot alter the current lease");
    }
    return record;
  }
  return {
    nonce,
    transfer: async (target) =>
      mutate(directory, async () => {
        const record = await current();
        const comparison = compareLinxInstalledAppVersions(target.version, record.version);
        if (comparison === null || comparison < 0)
          throw new Error(
            `Whole-home ownership version floor ${record.version} refuses a downgrade to ${target.version}`,
          );
        const nonceDigest = requireNonce(target.nonce);
        const nextOwner = await processIdentity(target.pid);
        deadMembersOnly(record.members.filter((member) => member.role === "server"));
        const members = record.members.filter(
          (member) =>
            member.role === "cohort" &&
            processState(member.process.pid) !== "dead" &&
            !sameProcess(member.process, nextOwner),
        );
        if (
          !sameProcess(owner, nextOwner) &&
          !members.some((member) => sameProcess(member.process, owner))
        ) {
          members.push({
            id: randomUUID(),
            role: "cohort",
            process: owner,
            joinedGeneration: record.generation,
          });
        }
        await writeRecord(directory, {
          ...record,
          owner: nextOwner,
          version: target.version,
          nonceDigest,
          adopted: false,
          generation: record.generation + 1,
          updatedAt: new Date().toISOString(),
          members,
        });
        released = true;
      }),
    release: async () => {
      if (released)
        throw new Error("Stale whole-home ownership handle cannot release a transferred lease");
      await mutate(directory, async () => {
        const record = await current();
        deadMembersOnly(record.members.filter((member) => member.role === "server"));
        await writeRecord(directory, {
          ...record,
          owner: null,
          nonceDigest: null,
          adopted: false,
          generation: record.generation + 1,
          updatedAt: new Date().toISOString(),
          members: record.members.filter((member) => processState(member.process.pid) !== "dead"),
        });
        released = true;
      });
    },
  };
}

export async function acquireLinxHomeOwnership(
  input: LinxHomeOwnershipInput,
): Promise<LinxHomeOwnership> {
  const bindings = await canonicalBindings(input);
  const directory = `${bindings.homePath}.linx-owner`;
  let created = false;
  try {
    await fs.mkdir(directory, { mode: 0o700 });
    created = true;
    await syncDirectoryEntry(path.dirname(directory));
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
  }
  return mutate(directory, async () => {
    let previous: LinxHomeOwnershipRecord | null = null;
    try {
      previous = await readRecord(directory);
    } catch (cause) {
      if (!created || (cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
    }
    if (previous !== null) {
      if (
        previous.homePath !== bindings.homePath ||
        previous.userDataPath !== bindings.userDataPath ||
        previous.applicationPath !== bindings.applicationPath
      )
        throw new Error("Ownership guard belongs to different roots or application");
      if (previous.owner !== null && processState(previous.owner.pid) !== "dead")
        throw new Error("Whole-home owner is live, reused-PID or unknown");
      deadMembersOnly(previous.members);
      const comparison = compareLinxInstalledAppVersions(bindings.version, previous.version);
      if (comparison === null || comparison < 0)
        throw new Error(
          `Whole-home ownership version floor ${previous.version} refuses a downgrade to ${bindings.version}`,
        );
    }
    // Existing standalone backends predate this guard. Publish only while their
    // native DB lock is free, then future server startups must join the grant.
    const dbPath = path.join(bindings.homePath, "userdata", "state.sqlite");
    const database = await fs.lstat(dbPath).catch((cause: NodeJS.ErrnoException) => {
      if (cause.code === "ENOENT") return null;
      throw cause;
    });
    const databaseLock =
      database === null ? null : await Effect.runPromise(acquireDatabaseLifecycleLock(dbPath));
    try {
      const nonce = randomBytes(32).toString("hex");
      const owner = await processIdentity(process.pid);
      const generation = (previous?.generation ?? 0) + 1;
      const record = decodeRecord({
        schemaVersion: 1,
        guardId: previous?.guardId ?? randomUUID(),
        uid: process.getuid?.(),
        ...bindings,
        owner,
        generation,
        nonceDigest: requireNonce(nonce),
        adopted: true,
        members: [],
        updatedAt: new Date().toISOString(),
      });
      await writeRecord(directory, record);
      return lease(directory, bindings, nonce, owner, generation);
    } finally {
      if (databaseLock) await Effect.runPromise(releaseDatabaseLifecycleLock(databaseLock));
    }
  });
}

export async function adoptLinxHomeOwnership(
  input: LinxHomeOwnershipInput & { nonce: string },
): Promise<LinxHomeOwnership> {
  const bindings = await canonicalBindings(input);
  const directory = `${bindings.homePath}.linx-owner`;
  return mutate(directory, async () => {
    const record = await readRecord(directory);
    assertBindings(record, bindings);
    const owner = await processIdentity(process.pid);
    if (
      record.owner === null ||
      !sameProcess(record.owner, owner) ||
      !matchesNonce(record, input.nonce) ||
      record.adopted
    )
      throw new Error("Whole-home transfer grant is invalid, stale or already adopted");
    const generation = record.generation + 1;
    await writeRecord(directory, {
      ...record,
      adopted: true,
      generation,
      updatedAt: new Date().toISOString(),
    });
    return lease(directory, bindings, input.nonce, owner, generation);
  });
}

export async function joinLinxHomeOwnershipForServer(input: {
  homePath: string;
  nonce?: string;
  parentPid: number;
}): Promise<(() => Promise<void>) | null> {
  const home = await canonicalLinxDataPath(input.homePath);
  const directory = `${home}.linx-owner`;
  const stat = await fs.lstat(directory).catch((cause: NodeJS.ErrnoException) => {
    if (cause.code === "ENOENT") return null;
    throw cause;
  });
  if (stat === null) {
    if (input.nonce !== undefined) throw new Error("A server ownership grant has no guard record");
    if ([".linx", ".linx-preview"].includes(path.basename(home)))
      throw new Error("Linx server requires desktop home ownership before first use");
    return null;
  }
  if (input.nonce === undefined || input.parentPid !== process.ppid)
    throw new Error("Guarded Linx home requires its current parent's ephemeral ownership grant");
  const nonce = input.nonce;
  const member = await mutate(directory, async () => {
    const record = await readRecord(directory);
    if (
      record.homePath !== home ||
      !record.adopted ||
      record.owner === null ||
      record.owner.pid !== input.parentPid ||
      !sameProcess(record.owner, await processIdentity(input.parentPid)) ||
      !matchesNonce(record, nonce)
    )
      throw new Error("Server parent ownership grant is stale or mismatched");
    const member: LinxHomeOwnershipMember = {
      id: randomUUID(),
      role: "server",
      process: await processIdentity(process.pid),
      joinedGeneration: record.generation,
    };
    const members = record.members.filter((entry) => processState(entry.process.pid) !== "dead");
    if (
      members.some((entry) => entry.role === "server" && sameProcess(entry.process, member.process))
    )
      throw new Error("Server already joined this home ownership generation");
    await writeRecord(directory, {
      ...record,
      members: [...members, member],
      updatedAt: new Date().toISOString(),
    });
    return { member, guardId: record.guardId };
  });
  let released = false;
  return async () => {
    if (released) return;
    await mutate(directory, async () => {
      const record = await readRecord(directory);
      if (record.guardId !== member.guardId || record.homePath !== home)
        throw new Error("Server ownership guard changed");
      const entry = record.members.find((entry) => entry.id === member.member.id);
      if (!entry || !sameProcess(entry.process, await processIdentity(process.pid)))
        throw new Error("Server ownership membership changed");
      await writeRecord(directory, {
        ...record,
        members: record.members.filter((entry) => entry.id !== member.member.id),
        updatedAt: new Date().toISOString(),
      });
      released = true;
    });
  };
}
