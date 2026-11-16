import { once } from "node:events";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import { createRequire } from "node:module";
import * as path from "node:path";
import { pipeline } from "node:stream/promises";
import type { LinxManagedRepositoryRecovery } from "@synara/contracts";
import { syncDirectoryEntry } from "./filesystemPlatform";
import { execProcessFile, spawnProcess } from "./processRuntime";

const OID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const REF =
  /^refs\/([A-Za-z0-9._-]+)\/checkpoints\/([A-Za-z0-9_-]+)\/(turn|message-start|turn-start|turn-live|revert-rescue)\/([A-Za-z0-9_-]+)$/u;
const MAX_PACK_BYTES = 4 * 1024 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const gitEnvironment = () => ({
  PATH: process.env.PATH || "/usr/bin:/bin",
  LC_ALL: "C",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
  GIT_NO_LAZY_FETCH: "1",
  GIT_ALLOW_PROTOCOL: "",
  GIT_NO_REPLACE_OBJECTS: "1",
});
const gitArgs = (common: string, args: readonly string[]) => [
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.fsmonitor=false",
  "--git-dir",
  common,
  ...args,
];

function git(common: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execProcessFile(
      "git",
      gitArgs(common, args),
      { encoding: "utf8", env: gitEnvironment(), timeout: 120_000, maxBuffer: MAX_OUTPUT_BYTES },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    );
  });
}

async function requireRetainedHistory(common: string, heads: readonly string[]): Promise<void> {
  if (!heads.length) return;
  const child = spawnProcess(
    "git",
    gitArgs(common, ["rev-list", "--objects", "--quiet", "--stdin"]),
    {
      env: gitEnvironment(),
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 120_000,
    },
  );
  child.stdout.resume();
  child.stderr.resume();
  const exit = once(child, "close");
  child.stdin.on("error", () => undefined);
  child.stdin.end(`${heads.join("\n")}\n`);
  const [code] = await exit;
  if (code !== 0)
    throw new Error(
      "External retained Git history is incomplete; restore that repository before Linx recovery",
    );
}

async function readDirectRef(common: string, name: string): Promise<string | null> {
  const lines = (
    await git(common, ["for-each-ref", "--format=%(refname) %(objectname) %(symref)", name])
  ).split("\n");
  const exact = lines.map((line) => line.trim().split(/\s+/u)).filter((parts) => parts[0] === name);
  if (!exact.length) return null;
  if (exact.length !== 1 || exact[0]!.length !== 2 || !OID.test(exact[0]![1]!))
    throw new Error("Managed checkpoint ref is symbolic or has conflicting ownership");
  return exact[0]![1]!;
}

async function canonicalMissing(target: string): Promise<string> {
  let current = path.resolve(target);
  const missing: string[] = [];
  for (;;) {
    try {
      return path.join(await fs.realpath(current), ...missing.reverse());
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT" || current === path.dirname(current))
        throw cause;
      missing.push(path.basename(current));
      current = path.dirname(current);
    }
  }
}

async function headReference(
  registration: string,
  common: string,
  expectedHead: string,
): Promise<string | null> {
  const text = (await readMetadata(path.join(registration, "HEAD"), 4_096)).toString("utf8").trim();
  if (!text.startsWith("ref: ")) {
    if (text !== expectedHead) throw new Error("Managed recovery HEAD binding is corrupt");
    return null;
  }
  const reference = text.slice(5);
  if (!reference.startsWith("refs/heads/"))
    throw new Error("Managed recovery HEAD is not a branch or detached object");
  await git(common, ["check-ref-format", reference]);
  return reference;
}

export async function verifyLinxManagedReferenceCapsuleBindings(
  capsule: string,
  repositories: readonly LinxManagedRepositoryRecovery[],
  context: { sourceHomePath: string; snapshotHomePath: string },
): Promise<void> {
  const families = repositories.length
    ? await checkpointFamilies(context.snapshotHomePath)
    : new Map<string, Set<string>>();
  for (const repository of repositories) {
    if (
      repository.id !== createHash("sha256").update(repository.commonPath).digest("hex") ||
      inside(context.sourceHomePath, repository.commonPath)
    )
      throw new Error("Managed capsule external-root binding is invalid");
    for (const worktree of repository.worktrees) {
      const originalCheckout = path.join(context.sourceHomePath, worktree.path);
      const ownedFamilies = [...(families.get(await canonicalMissing(originalCheckout)) ?? [])];
      if (
        worktree.refs.some(
          (reference) => !ownedFamilies.some((family) => reference.name.startsWith(`${family}/`)),
        )
      ) {
        throw new Error("Managed capsule checkpoint is not owned by a durable native thread");
      }
      const pointer = (
        await readMetadata(path.join(context.snapshotHomePath, worktree.path, ".git"), 4_096)
      ).toString("utf8");
      const match = /^gitdir: ([^\r\n]+)\r?\n?$/u.exec(pointer);
      const expected = path.join(repository.commonPath, "worktrees", worktree.registrationName);
      if (
        !match ||
        (await canonicalMissing(path.resolve(originalCheckout, match[1]!))) !== expected
      )
        throw new Error("Managed capsule does not belong to its copied checkout");
      const registration = path.join(
        capsule,
        repository.id,
        "registrations",
        worktree.registrationName,
      );
      const backlink = (await readMetadata(path.join(registration, "gitdir"), 4_096))
        .toString("utf8")
        .trim();
      const common = (await readMetadata(path.join(registration, "commondir"), 4_096))
        .toString("utf8")
        .trim();
      if (
        (await canonicalMissing(backlink)) !== path.join(originalCheckout, ".git") ||
        (await canonicalMissing(path.resolve(expected, common))) !== repository.commonPath
      )
        throw new Error("Managed capsule backlink/common-root ownership is invalid");
    }
  }
}

function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
  );
}

async function readMetadata(filePath: string, maximum = MAX_OUTPUT_BYTES): Promise<Buffer> {
  const before = await fs.lstat(filePath);
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.size > maximum ||
    before.uid !== process.getuid?.()
  )
    throw new Error(`Unsafe app-owned Git metadata: ${filePath}`);
  const handle = await fs.open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    if (opened.dev !== before.dev || opened.ino !== before.ino)
      throw new Error("Git metadata identity changed");
    const buffer = Buffer.alloc(before.size + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const after = await handle.stat();
    if (
      bytesRead !== before.size ||
      bytesRead > maximum ||
      after.ctimeMs !== before.ctimeMs ||
      after.mtimeMs !== before.mtimeMs
    )
      throw new Error("Git metadata changed during recovery");
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

async function hashFile(filePath: string): Promise<string> {
  const handle = await fs.open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new Error("Git recovery object is not a file");
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(Math.min(1024 * 1024, Math.max(1, before.size)));
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
    const after = await handle.stat();
    if (
      before.size !== after.size ||
      before.ctimeMs !== after.ctimeMs ||
      before.mtimeMs !== after.mtimeMs
    )
      throw new Error("Git recovery object changed while hashing");
    return hash.digest("hex");
  } finally {
    await handle.close();
  }
}

interface ReadonlyRecoveryDatabase {
  prepare(sql: string): { all(): unknown[] };
  close(): void;
}
function readonlyDatabase(filePath: string): ReadonlyRecoveryDatabase {
  // These native modules do not exist on the other runtime. Selection is runtime-specific,
  // not a fallback database engine and never loads server internals into the helper.
  const moduleName = process.versions.bun ? "bun:sqlite" : "node:sqlite";
  const loaded = createRequire(import.meta.url)(moduleName) as {
    Database?: new (
      filePath: string,
      options: { readonly: boolean; create: boolean },
    ) => ReadonlyRecoveryDatabase;
    DatabaseSync?: new (
      filePath: string,
      options: { readOnly: boolean },
    ) => ReadonlyRecoveryDatabase;
  };
  if (process.versions.bun) {
    if (!loaded.Database)
      throw new Error("Bun native readonly SQLite is unavailable for managed-reference recovery");
    return new loaded.Database(filePath, { readonly: true, create: false });
  }
  if (!loaded.DatabaseSync)
    throw new Error("Node native readonly SQLite is unavailable for managed-reference recovery");
  return new loaded.DatabaseSync(filePath, { readOnly: true });
}

async function checkpointFamilies(home: string): Promise<Map<string, Set<string>>> {
  const database = readonlyDatabase(path.join(home, "userdata", "state.sqlite"));
  try {
    const columns = database.prepare("PRAGMA table_info(projection_threads)").all() as {
      name: string;
    }[];
    if (
      !columns.some((entry) => entry.name === "thread_id") ||
      !columns.some((entry) => entry.name === "worktree_path")
    )
      throw new Error("Managed reference recovery requires native thread path projections");
    const associated = columns.some((entry) => entry.name === "associated_worktree_path")
      ? "associated_worktree_path"
      : "NULL AS associated_worktree_path";
    const threads = database
      .prepare(
        `SELECT thread_id, worktree_path, ${associated} FROM projection_threads LIMIT 200001`,
      )
      .all() as {
      thread_id: string;
      worktree_path: string | null;
      associated_worktree_path: string | null;
    }[];
    if (threads.length > 200_000)
      throw new Error("Managed reference thread inventory exceeds bounds");
    const checkpoints = database
      .prepare("SELECT thread_id, checkpoint_ref FROM projection_checkpoints LIMIT 200001")
      .all() as { thread_id: string; checkpoint_ref: string }[];
    if (checkpoints.length > 200_000)
      throw new Error("Managed checkpoint inventory exceeds bounds");
    const familiesByThread = new Map<string, Set<string>>();
    for (const thread of threads) {
      if (typeof thread.thread_id !== "string") throw new Error("Invalid durable thread identity");
      const token = Buffer.from(thread.thread_id).toString("base64url");
      familiesByThread.set(thread.thread_id, new Set([`refs/synara/checkpoints/${token}`]));
    }
    for (const checkpoint of checkpoints) {
      const match =
        typeof checkpoint.checkpoint_ref === "string" ? REF.exec(checkpoint.checkpoint_ref) : null;
      if (match && match[2] === Buffer.from(checkpoint.thread_id).toString("base64url")) {
        familiesByThread.get(checkpoint.thread_id)?.add(`refs/${match[1]}/checkpoints/${match[2]}`);
      }
    }
    const byWorktree = new Map<string, Set<string>>();
    for (const thread of threads) {
      for (const recorded of [thread.worktree_path, thread.associated_worktree_path]) {
        if (recorded === null) continue;
        if (typeof recorded !== "string" || !path.isAbsolute(recorded))
          throw new Error("Invalid durable managed worktree path");
        const normalized = await fs.realpath(recorded).catch((cause: NodeJS.ErrnoException) => {
          if (cause.code === "ENOENT") return path.resolve(recorded);
          throw cause;
        });
        const families = byWorktree.get(normalized) ?? new Set<string>();
        for (const family of familiesByThread.get(thread.thread_id)!) families.add(family);
        byWorktree.set(normalized, families);
      }
    }
    return byWorktree;
  } finally {
    database.close();
  }
}

async function findManagedWorktrees(home: string): Promise<string[]> {
  const root = path.join(home, "worktrees");
  const found: string[] = [];
  let count = 0;
  async function visit(current: string): Promise<void> {
    if (++count > 200_000) throw new Error("Managed worktree scan exceeds bounds");
    const entries = await fs.readdir(current, { withFileTypes: true });
    if (entries.some((entry) => entry.name === ".git" && entry.isFile())) {
      found.push(current);
      return;
    }
    for (const entry of entries)
      if (entry.name !== ".git" && entry.isDirectory() && !entry.isSymbolicLink())
        await visit(path.join(current, entry.name));
  }
  const stat = await fs.lstat(root).catch((cause: NodeJS.ErrnoException) => {
    if (cause.code === "ENOENT") return null;
    throw cause;
  });
  if (stat === null) return found;
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Unsafe managed worktree root");
  await visit(root);
  return found;
}

async function repositoryIdentity(common: string): Promise<{
  device: string;
  inode: string;
  configSha256: string;
  objectFormat: "sha1" | "sha256";
}> {
  const stat = await fs.lstat(common);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o022) !== 0 ||
    (await fs.realpath(common)) !== common
  )
    throw new Error("External common Git dependency has unsafe ownership or aliases");
  const configSha256 = createHash("sha256")
    .update(await readMetadata(path.join(common, "config")))
    .digest("hex");
  const objectFormat = (await git(common, ["rev-parse", "--show-object-format"])).trim();
  if (objectFormat !== "sha1" && objectFormat !== "sha256")
    throw new Error("Unknown managed Git object format");
  return { device: String(stat.dev), inode: String(stat.ino), configSha256, objectFormat };
}

async function writeUniqueObjectPack(
  common: string,
  positive: readonly string[],
  negative: readonly string[],
  outputPath: string,
): Promise<void> {
  const output = await fs.open(outputPath, "wx", 0o600);
  const child = spawnProcess(
    "git",
    gitArgs(common, ["pack-objects", "--stdout", "--revs", "--delta-base-offset"]),
    { env: gitEnvironment(), stdio: ["pipe", "pipe", "pipe"], timeout: 120_000 },
  );
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    if (stderr.length < 64 * 1024) stderr += chunk.toString("utf8");
  });
  const exit = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`Managed object pack failed: ${stderr.slice(0, 2_048)}`)),
    );
  });
  // Attach before streaming so an early child rejection cannot become unhandled.
  void exit.catch(() => undefined);
  child.stdin.on("error", () => undefined);
  child.stdin.end(`${positive.join("\n")}\n${negative.map((oid) => `^${oid}`).join("\n")}\n`);
  let size = 0;
  try {
    for await (const chunk of child.stdout) {
      const bytes = chunk as Buffer;
      size += bytes.length;
      if (size > MAX_PACK_BYTES) throw new Error("Managed unique-object capsule exceeds 4 GiB");
      const capacity = await fs.statfs(path.dirname(outputPath), { bigint: true });
      if (capacity.bavail * capacity.bsize < BigInt(bytes.length + 64 * 1024 * 1024))
        throw new Error("Insufficient space for managed-reference capsule");
      await output.writeFile(bytes);
    }
    await exit;
    await output.sync();
  } catch (cause) {
    child.kill();
    await exit.catch(() => undefined);
    throw cause;
  } finally {
    await output.close();
  }
}

async function checkpointReferences(
  common: string,
  families: ReadonlySet<string>,
): Promise<{ name: string; oid: string }[]> {
  const refs: { name: string; oid: string }[] = [];
  for (const family of [...families].sort()) {
    const lines = (
      await git(common, [
        "for-each-ref",
        "--format=%(refname) %(objectname) %(symref)",
        `${family}/`,
      ])
    )
      .trim()
      .split("\n")
      .filter(Boolean);
    for (const line of lines) {
      const parts = line.trim().split(/\s+/u);
      if (
        parts.length !== 2 ||
        !REF.test(parts[0]!) ||
        !parts[0]!.startsWith(`${family}/`) ||
        !OID.test(parts[1]!)
      )
        throw new Error("Unowned or symbolic managed checkpoint reference");
      refs.push({ name: parts[0]!, oid: parts[1]! });
    }
  }
  if (refs.length > 16_384) throw new Error("Managed checkpoint family exceeds bounds");
  return refs;
}

/** Captures only exact registrations and durable thread-bound checkpoint families. */
export async function captureLinxManagedReferences(input: {
  homePath: string;
  capsuleDirectoryPath: string;
  copyDirectory: (source: string, destination: string) => Promise<void>;
  copyFile: (source: string, destination: string) => Promise<void>;
}): Promise<LinxManagedRepositoryRecovery[]> {
  const checkouts = await findManagedWorktrees(input.homePath);
  if (!checkouts.length) return [];
  const families = await checkpointFamilies(input.homePath);
  const repositories = new Map<
    string,
    {
      metadata: LinxManagedRepositoryRecovery;
      positive: Set<string>;
      worktrees: Array<LinxManagedRepositoryRecovery["worktrees"][number]>;
      sharedIndexes: string[];
    }
  >();
  for (const checkout of checkouts) {
    const pointer = (await readMetadata(path.join(checkout, ".git"), 4_096)).toString("utf8");
    const match = /^gitdir: ([^\r\n]+)\r?\n?$/u.exec(pointer);
    if (!match) throw new Error("Invalid copied managed checkout pointer");
    const registration = await fs.realpath(path.resolve(checkout, match[1]!));
    const common = await fs.realpath(
      path.resolve(
        registration,
        (await readMetadata(path.join(registration, "commondir"), 4_096)).toString("utf8").trim(),
      ),
    );
    if (
      path.dirname(registration) !== path.join(common, "worktrees") ||
      (await fs.realpath(
        (await readMetadata(path.join(registration, "gitdir"), 4_096)).toString("utf8").trim(),
      )) !== (await fs.realpath(path.join(checkout, ".git")))
    ) {
      throw new Error("Managed checkout registration/backlink ownership mismatch");
    }
    if (inside(input.homePath, common)) continue; // Fully preserved by the home inventory itself.
    const identity = await repositoryIdentity(common);
    let entry = repositories.get(common);
    if (!entry) {
      if (!repositories.size) await fs.mkdir(input.capsuleDirectoryPath, { mode: 0o700 });
      const id = createHash("sha256").update(common).digest("hex");
      const retainedHeads = [
        ...new Set(
          (
            await git(common, [
              "for-each-ref",
              "--format=%(objectname)",
              "refs/heads",
              "refs/tags",
              "refs/remotes",
            ])
          )
            .trim()
            .split(/\s+/u)
            .filter(Boolean),
        ),
      ];
      if (retainedHeads.length > 65_536 || retainedHeads.some((oid) => !OID.test(oid)))
        throw new Error("External retained-history dependency exceeds bounds");
      const worktrees: Array<LinxManagedRepositoryRecovery["worktrees"][number]> = [];
      const sharedIndexes: string[] = [];
      const metadata: LinxManagedRepositoryRecovery = {
        id,
        commonPath: common,
        ...identity,
        retainedHeads,
        worktrees,
        sharedIndexes,
      };
      entry = { metadata, positive: new Set(), worktrees, sharedIndexes };
      repositories.set(common, entry);
      await fs.mkdir(path.join(input.capsuleDirectoryPath, id), { mode: 0o700 });
      await fs.mkdir(path.join(input.capsuleDirectoryPath, id, "registrations"), { mode: 0o700 });
      await fs.mkdir(path.join(input.capsuleDirectoryPath, id, "shared-indexes"), { mode: 0o700 });
    }
    const name = path.basename(registration);
    const registrationStat = await fs.lstat(registration);
    if (
      !registrationStat.isDirectory() ||
      registrationStat.isSymbolicLink() ||
      registrationStat.uid !== process.getuid?.()
    )
      throw new Error("Unsafe managed Git registration");
    const locked = (await fs.readdir(registration)).some((name) => name.endsWith(".lock"));
    if (locked)
      throw new Error("Managed Git registration is being written; recovery requires it idle");
    const indexPath = path.join(registration, "index");
    const indexDigest = await hashFile(indexPath);
    const sharedIndex = (
      await git(registration, ["rev-parse", "--path-format=absolute", "--shared-index-path"])
    ).trim();
    if (sharedIndex) {
      const sharedPath = await fs.realpath(sharedIndex);
      if (!inside(registration, sharedPath)) {
        const name = path.basename(sharedPath);
        if (
          path.dirname(sharedPath) !== common ||
          !/^sharedindex\.(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(name)
        )
          throw new Error("Split index has an unowned external metadata dependency");
        if (!entry.sharedIndexes.includes(name)) {
          await input.copyFile(
            sharedPath,
            path.join(input.capsuleDirectoryPath, entry.metadata.id, "shared-indexes", name),
          );
          entry.sharedIndexes.push(name);
        }
      }
    }
    const head = (await git(registration, ["rev-parse", "--verify", "HEAD"])).trim();
    if (!OID.test(head)) throw new Error("Managed checkout HEAD is invalid");
    entry.positive.add(head);
    const refs = await checkpointReferences(common, families.get(checkout) ?? new Set<string>());
    for (const reference of refs) entry.positive.add(reference.oid);
    const staged = await git(registration, ["ls-files", "--stage", "--sparse", "-z"]);
    for (const record of staged.split("\0")) {
      if (!record) continue;
      const stage = /^([0-7]{6}) ([a-f0-9]{40}|[a-f0-9]{64}) [0-3]\t/u.exec(record);
      if (!stage) throw new Error("Invalid managed Git index record");
      if (stage[1] !== "160000" && !/^0+$/u.test(stage[2]!)) entry.positive.add(stage[2]!);
    }
    await input.copyDirectory(
      registration,
      path.join(input.capsuleDirectoryPath, entry.metadata.id, "registrations", name),
    );
    if (
      (await hashFile(indexPath)) !== indexDigest ||
      (await git(registration, ["rev-parse", "--verify", "HEAD"])).trim() !== head
    ) {
      throw new Error("Managed HEAD or staged index changed during recovery");
    }
    entry.worktrees.push({
      path: path.relative(input.homePath, checkout).split(path.sep).join("/"),
      registrationName: name,
      head,
      refs,
    });
  }
  for (const entry of repositories.values()) {
    await writeUniqueObjectPack(
      entry.metadata.commonPath,
      [...entry.positive],
      entry.metadata.retainedHeads,
      path.join(input.capsuleDirectoryPath, entry.metadata.id, "objects.pack"),
    );
    const identity = await repositoryIdentity(entry.metadata.commonPath);
    if (
      identity.device !== entry.metadata.device ||
      identity.inode !== entry.metadata.inode ||
      identity.configSha256 !== entry.metadata.configSha256
    )
      throw new Error("External repository identity changed during recovery");
    for (const worktree of entry.metadata.worktrees) {
      if (
        !(await sameDirectory(
          path.join(
            input.capsuleDirectoryPath,
            entry.metadata.id,
            "registrations",
            worktree.registrationName,
          ),
          path.join(entry.metadata.commonPath, "worktrees", worktree.registrationName),
        ))
      )
        throw new Error("Managed registration changed during capsule capture");
      const currentRefs = await checkpointReferences(
        entry.metadata.commonPath,
        families.get(path.join(input.homePath, worktree.path)) ?? new Set<string>(),
      );
      if (JSON.stringify(currentRefs) !== JSON.stringify(worktree.refs))
        throw new Error("Managed checkpoint family changed during recovery");
    }
  }
  return [...repositories.values()].map((entry) => entry.metadata);
}

async function sameDirectory(expected: string, actual: string): Promise<boolean> {
  const a = (await fs.readdir(expected)).sort();
  const b = (await fs.readdir(actual)).sort();
  if (JSON.stringify(a) !== JSON.stringify(b)) return false;
  for (const name of a) {
    const source = path.join(expected, name),
      target = path.join(actual, name);
    const left = await fs.lstat(source),
      right = await fs.lstat(target);
    if (
      left.isSymbolicLink() ||
      right.isSymbolicLink() ||
      left.isDirectory() !== right.isDirectory() ||
      left.isFile() !== right.isFile() ||
      (left.mode & 0o777) !== (right.mode & 0o777)
    )
      return false;
    if (left.isDirectory()) {
      if (!(await sameDirectory(source, target))) return false;
    } else if (
      !left.isFile() ||
      left.size !== right.size ||
      (await hashFile(source)) !== (await hashFile(target))
    )
      return false;
  }
  return true;
}

/** Checks every external destination before any restore writes. Existing differing state is never rolled back. */
export async function preflightLinxManagedReferenceRestore(
  capsuleDirectoryPath: string,
  repositories: readonly LinxManagedRepositoryRecovery[],
  context: { sourceHomePath: string; snapshotHomePath: string },
): Promise<void> {
  await verifyLinxManagedReferenceCapsuleBindings(capsuleDirectoryPath, repositories, context);
  for (const repository of repositories) {
    const identity = await repositoryIdentity(repository.commonPath);
    if (
      identity.device !== repository.device ||
      identity.inode !== repository.inode ||
      identity.configSha256 !== repository.configSha256 ||
      identity.objectFormat !== repository.objectFormat
    )
      throw new Error(
        "External common repository dependency changed; recover its original identity manually before restoring Linx references",
      );
    const pack = await fs.lstat(path.join(capsuleDirectoryPath, repository.id, "objects.pack"));
    if (!pack.isFile() || pack.isSymbolicLink() || pack.size > MAX_PACK_BYTES)
      throw new Error("Invalid managed-reference object pack");
    const space = await fs.statfs(repository.commonPath, { bigint: true });
    if (space.bavail * space.bsize < BigInt(pack.size) * 2n + 64n * 1024n * 1024n)
      throw new Error(
        "Insufficient external repository space for safe managed-reference restoration",
      );
    await requireRetainedHistory(repository.commonPath, repository.retainedHeads);
    for (const name of repository.sharedIndexes) {
      const target = path.join(repository.commonPath, name);
      const stat = await fs.lstat(target).catch((cause: NodeJS.ErrnoException) => {
        if (cause.code === "ENOENT") return null;
        throw cause;
      });
      if (
        stat &&
        (!stat.isFile() ||
          stat.isSymbolicLink() ||
          (await hashFile(target)) !==
            (await hashFile(
              path.join(capsuleDirectoryPath, repository.id, "shared-indexes", name),
            )))
      ) {
        throw new Error(
          "External shared index has conflicting data; recovery will not overwrite it",
        );
      }
    }
    const worktreesRoot = path.join(repository.commonPath, "worktrees");
    const registrations = await fs.lstat(worktreesRoot).catch((cause: NodeJS.ErrnoException) => {
      if (cause.code === "ENOENT") return null;
      throw cause;
    });
    if (
      registrations &&
      (!registrations.isDirectory() ||
        registrations.isSymbolicLink() ||
        registrations.uid !== process.getuid?.())
    )
      throw new Error("Unsafe external worktree-registration root");
    for (const worktree of repository.worktrees) {
      const symbolicHead = await headReference(
        path.join(capsuleDirectoryPath, repository.id, "registrations", worktree.registrationName),
        repository.commonPath,
        worktree.head,
      );
      if (symbolicHead !== null) {
        const currentHead = await readDirectRef(repository.commonPath, symbolicHead);
        if (currentHead !== null && currentHead !== worktree.head)
          throw new Error(
            "Managed checkout branch HEAD has newer data; recovery will not overwrite it",
          );
      }
      const actual = path.join(repository.commonPath, "worktrees", worktree.registrationName);
      const stat = await fs.lstat(actual).catch((cause: NodeJS.ErrnoException) => {
        if (cause.code === "ENOENT") return null;
        throw cause;
      });
      if (
        stat !== null &&
        (!stat.isDirectory() ||
          stat.isSymbolicLink() ||
          ((await fs.readdir(actual)).length &&
            !(await sameDirectory(
              path.join(
                capsuleDirectoryPath,
                repository.id,
                "registrations",
                worktree.registrationName,
              ),
              actual,
            ))))
      ) {
        throw new Error(
          "Managed Git registration has newer/conflicting data; preserve it and resolve recovery manually",
        );
      }
      for (const reference of worktree.refs) {
        const existing = await readDirectRef(repository.commonPath, reference.name);
        if (existing !== null && existing !== reference.oid)
          throw new Error("Managed checkpoint ref has newer data; recovery will not overwrite it");
      }
    }
  }
}

async function restoreObjectPack(
  capsule: string,
  repository: LinxManagedRepositoryRecovery,
): Promise<void> {
  const objects = path.join(repository.commonPath, "objects");
  const objectsStat = await fs.lstat(objects);
  if (!objectsStat.isDirectory() || objectsStat.isSymbolicLink())
    throw new Error("Unsafe external object destination");
  const temporary = await fs.mkdtemp(path.join(objects, ".linx-recovery-"));
  try {
    await fs.mkdir(path.join(temporary, "pack"), { mode: 0o700 });
    // Git validates the pack into an isolated object directory. Publication uses
    // exclusive hard links, never overwriting existing content-addressed files.
    const child = spawnProcess(
      "git",
      gitArgs(repository.commonPath, ["index-pack", "--stdin", "--strict"]),
      {
        env: {
          ...gitEnvironment(),
          GIT_OBJECT_DIRECTORY: temporary,
          GIT_ALTERNATE_OBJECT_DIRECTORIES: objects,
        },
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 120_000,
      },
    );
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < 64 * 1024) stderr += chunk.toString();
    });
    child.stdout.resume();
    const exit = new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) =>
        code === 0
          ? resolve()
          : reject(new Error(`Managed recovery pack validation failed: ${stderr.slice(0, 2_048)}`)),
      );
    });
    void exit.catch(() => undefined);
    child.stdin.on("error", () => undefined);
    const handle = await fs.open(
      path.join(capsule, repository.id, "objects.pack"),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      await pipeline(handle.createReadStream({ autoClose: false }), child.stdin);
      await exit;
    } catch (cause) {
      child.kill();
      await exit.catch(() => undefined);
      throw cause;
    } finally {
      await handle.close();
    }
    const packDirectory = path.join(objects, "pack");
    await fs.mkdir(packDirectory, { mode: 0o755 }).catch((cause: NodeJS.ErrnoException) => {
      if (cause.code !== "EEXIST") throw cause;
    });
    const packStat = await fs.lstat(packDirectory);
    if (!packStat.isDirectory() || packStat.isSymbolicLink())
      throw new Error("Unsafe external pack directory");
    for (const name of await fs.readdir(path.join(temporary, "pack"))) {
      if (!/^pack-[a-f0-9]{40,64}\.(?:pack|idx|rev)$/u.test(name))
        throw new Error("Unexpected indexed recovery pack file");
      const source = path.join(temporary, "pack", name),
        target = path.join(packDirectory, name);
      await fs.link(source, target).catch(async (cause: NodeJS.ErrnoException) => {
        if (cause.code !== "EEXIST" || (await hashFile(source)) !== (await hashFile(target)))
          throw new Error("Conflicting external object pack; no data was overwritten");
      });
      const durable = await fs.open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        await durable.sync();
      } finally {
        await durable.close();
      }
    }
    await syncDirectoryEntry(packDirectory);
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
}

export async function restoreLinxManagedReferences(input: {
  capsuleDirectoryPath: string;
  repositories: readonly LinxManagedRepositoryRecovery[];
  copyDirectory: (source: string, destination: string) => Promise<void>;
  copyFile: (source: string, destination: string) => Promise<void>;
  sourceHomePath: string;
  snapshotHomePath: string;
}): Promise<void> {
  await preflightLinxManagedReferenceRestore(input.capsuleDirectoryPath, input.repositories, input);
  for (const repository of input.repositories) {
    const worktreesRoot = path.join(repository.commonPath, "worktrees");
    await fs.mkdir(worktreesRoot, { mode: 0o755 }).catch((cause: NodeJS.ErrnoException) => {
      if (cause.code !== "EEXIST") throw cause;
    });
    const registrations = await fs.lstat(worktreesRoot);
    if (
      !registrations.isDirectory() ||
      registrations.isSymbolicLink() ||
      registrations.uid !== process.getuid?.()
    )
      throw new Error("Unsafe external worktree-registration root");
    await restoreObjectPack(input.capsuleDirectoryPath, repository);
    for (const name of repository.sharedIndexes) {
      const target = path.join(repository.commonPath, name);
      const stat = await fs.lstat(target).catch((cause: NodeJS.ErrnoException) => {
        if (cause.code === "ENOENT") return null;
        throw cause;
      });
      if (stat === null)
        await input.copyFile(
          path.join(input.capsuleDirectoryPath, repository.id, "shared-indexes", name),
          target,
        );
      else if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        (await hashFile(target)) !==
          (await hashFile(
            path.join(input.capsuleDirectoryPath, repository.id, "shared-indexes", name),
          ))
      ) {
        throw new Error("External shared index raced recovery; no newer data was overwritten");
      }
    }
    for (const worktree of repository.worktrees) {
      const destination = path.join(repository.commonPath, "worktrees", worktree.registrationName);
      const stat = await fs.lstat(destination).catch((cause: NodeJS.ErrnoException) => {
        if (cause.code === "ENOENT") return null;
        throw cause;
      });
      if (stat === null || (await fs.readdir(destination)).length === 0) {
        if (stat !== null) await fs.rmdir(destination);
        await input.copyDirectory(
          path.join(
            input.capsuleDirectoryPath,
            repository.id,
            "registrations",
            worktree.registrationName,
          ),
          destination,
        );
      } else if (
        !stat.isDirectory() ||
        stat.isSymbolicLink() ||
        !(await sameDirectory(
          path.join(
            input.capsuleDirectoryPath,
            repository.id,
            "registrations",
            worktree.registrationName,
          ),
          destination,
        ))
      ) {
        throw new Error(
          "Managed Git registration raced recovery; no newer metadata was overwritten",
        );
      }
      const symbolicHead = await headReference(
        path.join(
          input.capsuleDirectoryPath,
          repository.id,
          "registrations",
          worktree.registrationName,
        ),
        repository.commonPath,
        worktree.head,
      );
      if (symbolicHead !== null) {
        const currentHead = await readDirectRef(repository.commonPath, symbolicHead);
        if (currentHead === null)
          await git(repository.commonPath, [
            "update-ref",
            symbolicHead,
            worktree.head,
            "0".repeat(repository.objectFormat === "sha1" ? 40 : 64),
          ]);
        else if (currentHead !== worktree.head)
          throw new Error("Managed branch HEAD raced recovery; no newer data was overwritten");
      }
      for (const reference of worktree.refs) {
        const current = await readDirectRef(repository.commonPath, reference.name);
        if (current === reference.oid) continue;
        if (current)
          throw new Error("Managed checkpoint ref raced recovery; no newer ref was overwritten");
        await git(repository.commonPath, [
          "update-ref",
          reference.name,
          reference.oid,
          "0".repeat(repository.objectFormat === "sha1" ? 40 : 64),
        ]);
      }
    }
  }
}
