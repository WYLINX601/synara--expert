import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  createLinxUpdateRecoverySet,
  restoreLinxUpdateRecoverySetToEmptyTargets,
  verifyLinxUpdateRecoverySet,
} from "./linxUpdateRecovery";

const exec = promisify(execFile);
const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporary.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});
async function fixture(splitIndex = false) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "linx-managed-capsule-"));
  temporary.push(directory);
  const root = await fs.realpath(directory);
  const repository = path.join(root, "external-project");
  const homePath = path.join(root, ".linx");
  const userDataPath = path.join(root, "profile");
  await fs.mkdir(repository);
  await fs.mkdir(path.join(homePath, "userdata"), { recursive: true, mode: 0o700 });
  await fs.mkdir(userDataPath, { mode: 0o700 });
  const git = async (cwd: string, args: string[]) =>
    (
      await exec("git", ["-C", cwd, ...args], { timeout: 30_000, maxBuffer: 16 * 1024 * 1024 })
    ).stdout.trim();
  await git(repository, ["init", "-b", "main"]);
  await git(repository, ["config", "user.name", "Fixture"]);
  await git(repository, ["config", "user.email", "fixture@example.invalid"]);
  await fs.writeFile(path.join(repository, "tracked"), "external project baseline");
  await git(repository, ["add", "tracked"]);
  await git(repository, ["commit", "-m", "external baseline not backed up"]);
  const baseHead = await git(repository, ["rev-parse", "HEAD"]);
  const checkout = path.join(homePath, "worktrees", "thread");
  await git(repository, ["worktree", "add", "-b", "managed-thread", checkout]);
  const threadId = "owned-thread";
  const checkpointRef = `refs/synara/checkpoints/${Buffer.from(threadId).toString("base64url")}/turn/1`;
  await fs.writeFile(path.join(checkout, "tracked"), "unique checkpoint bytes");
  await git(checkout, ["add", "tracked"]);
  const tree = await git(checkout, ["write-tree"]);
  const checkpointOid = await git(checkout, [
    "commit-tree",
    tree,
    "-p",
    baseHead,
    "-m",
    `Synara checkpoint ref=${checkpointRef}`,
  ]);
  await git(checkout, ["update-ref", checkpointRef, checkpointOid]);
  const unrelatedRef = `refs/another-app/checkpoints/${Buffer.from(threadId).toString("base64url")}/turn/1`;
  const unrelatedOid = await git(repository, [
    "commit-tree",
    `${baseHead}^{tree}`,
    "-p",
    baseHead,
    "-m",
    "unrelated application checkpoint",
  ]);
  await git(repository, ["update-ref", unrelatedRef, unrelatedOid]);
  await fs.writeFile(path.join(checkout, "tracked"), "unique staged bytes after checkpoint");
  await git(checkout, ["add", "tracked"]);
  if (splitIndex) await git(checkout, ["update-index", "--split-index"]);
  const stagedOid = await git(checkout, ["rev-parse", ":tracked"]);
  await fs.writeFile(path.join(checkout, "ignored.unique"), "ignored app-owned worktree data");
  const registration = (await fs.readFile(path.join(checkout, ".git"), "utf8"))
    .trim()
    .slice("gitdir: ".length);
  const common = path.join(repository, ".git");
  const db = new DatabaseSync(path.join(homePath, "userdata", "state.sqlite"));
  db.exec(
    "CREATE TABLE projection_threads (thread_id TEXT, worktree_path TEXT, associated_worktree_path TEXT); CREATE TABLE projection_checkpoints (thread_id TEXT, checkpoint_ref TEXT)",
  );
  db.prepare("INSERT INTO projection_threads VALUES (?, ?, ?)").run(threadId, checkout, checkout);
  db.prepare("INSERT INTO projection_checkpoints VALUES (?, ?)").run(threadId, checkpointRef);
  db.close();
  return {
    root,
    repository,
    homePath,
    userDataPath,
    checkout,
    registration,
    common,
    baseHead,
    checkpointRef,
    checkpointOid,
    unrelatedRef,
    unrelatedOid,
    stagedOid,
    git,
    recoveryDirectoryPath: path.join(root, "recovery"),
    attemptId: randomUUID(),
    sourceVersion: "0.1.15",
  };
}

describe("exact native managed-reference recovery capsules", { timeout: 30_000 }, () => {
  it.each([false, true])(
    "preserves exact registration and unique staged/checkpoint objects without unrelated history (split index %s)",
    async (splitIndex) => {
      const input = await fixture(splitIndex);
      const manifest = await createLinxUpdateRecoverySet(input);
      expect(manifest.managedRepositories).toHaveLength(1);
      const capsule = manifest.managedRepositories[0]!;
      expect(capsule.commonPath).toBe(input.common);
      expect(capsule.worktrees[0]!.refs).toEqual([
        { name: input.checkpointRef, oid: input.checkpointOid },
      ]);
      expect(
        manifest.entries.some(
          (entry) => entry.root === "managedReferences" && entry.path.endsWith("/index"),
        ),
      ).toBe(true);
      const pack = path.join(
        input.recoveryDirectoryPath,
        "managedReferences",
        capsule.id,
        "objects.pack",
      );
      const proofPack = path.join(input.root, "proof.pack");
      await fs.copyFile(pack, proofPack);
      await input.git(input.repository, ["index-pack", proofPack]);
      const objects = await input.git(input.repository, [
        "verify-pack",
        "-v",
        path.join(input.root, "proof.idx"),
      ]);
      expect(objects).toContain(input.stagedOid);
      expect(objects).toContain(input.checkpointOid);
      expect(objects).not.toContain(input.unrelatedOid);
      expect(objects).not.toContain(input.baseHead);
      expect(await verifyLinxUpdateRecoverySet(input.recoveryDirectoryPath)).toEqual(manifest);
    },
  );
  it("restores only missing exact external metadata, refs and unique objects into the same retained repository", async () => {
    const input = await fixture();
    const manifest = await createLinxUpdateRecoverySet(input);
    const unique = (
      await input.git(input.repository, [
        "rev-list",
        "--objects",
        "--no-object-names",
        input.checkpointOid,
        `^${input.baseHead}`,
      ])
    ).split("\n");
    unique.push(input.stagedOid);
    await input.git(input.repository, ["update-ref", "-d", input.checkpointRef]);
    await fs.rm(input.registration, { recursive: true });
    for (const oid of new Set(unique))
      await fs.rm(path.join(input.common, "objects", oid.slice(0, 2), oid.slice(2)), {
        force: true,
      });
    const homePath = path.join(input.root, "restored-home"),
      userDataPath = path.join(input.root, "restored-profile");
    await restoreLinxUpdateRecoverySetToEmptyTargets({ ...input, homePath, userDataPath });
    expect(await input.git(input.repository, ["rev-parse", input.checkpointRef])).toBe(
      input.checkpointOid,
    );
    expect(await input.git(input.checkout, ["show", ":tracked"])).toBe(
      "unique staged bytes after checkpoint",
    );
    expect(await input.git(input.repository, ["rev-parse", input.unrelatedRef])).toBe(
      input.unrelatedOid,
    );
    expect(
      await fs.readFile(path.join(homePath, "worktrees", "thread", "ignored.unique"), "utf8"),
    ).toBe("ignored app-owned worktree data");
    const copiedIndex = path.join(
      input.recoveryDirectoryPath,
      "managedReferences",
      manifest.managedRepositories[0]!.id,
      "registrations",
      path.basename(input.registration),
      "index",
    );
    expect(await fs.readFile(path.join(input.registration, "index"))).toEqual(
      await fs.readFile(copiedIndex),
    );
  });
  it.each(["index", "ref", "head", "identity"])(
    "refuses newer/conflicting external %s before touching empty targets",
    async (conflict) => {
      const input = await fixture();
      await createLinxUpdateRecoverySet(input);
      if (conflict === "index") {
        await fs.writeFile(path.join(input.checkout, "tracked"), "newer staged data");
        await input.git(input.checkout, ["add", "tracked"]);
      }
      if (conflict === "ref")
        await input.git(input.repository, ["update-ref", input.checkpointRef, input.unrelatedOid]);
      if (conflict === "head")
        await input.git(input.repository, [
          "update-ref",
          "refs/heads/managed-thread",
          input.unrelatedOid,
        ]);
      if (conflict === "identity")
        await fs.appendFile(path.join(input.common, "config"), "\n# changed repository identity\n");
      const homePath = path.join(input.root, "new-home");
      await expect(
        restoreLinxUpdateRecoverySetToEmptyTargets({
          ...input,
          homePath,
          userDataPath: path.join(input.root, "new-profile"),
        }),
      ).rejects.toThrow();
      await expect(fs.stat(homePath)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );
  it("refuses forged backlinks and never sweeps another app's similarly named checkpoint refs", async () => {
    const input = await fixture();
    await fs.writeFile(
      path.join(input.registration, "gitdir"),
      path.join(input.repository, "unrelated", ".git"),
    );
    await expect(createLinxUpdateRecoverySet(input)).rejects.toThrow();
    expect(await input.git(input.repository, ["rev-parse", input.unrelatedRef])).toBe(
      input.unrelatedOid,
    );
  });
  it("binds capsule checkpoint names to durable thread families instead of trusting manifest ref claims", async () => {
    const input = await fixture();
    const manifest = await createLinxUpdateRecoverySet(input);
    const repository = manifest.managedRepositories[0]!;
    const forged = {
      ...manifest,
      managedRepositories: [
        {
          ...repository,
          worktrees: repository.worktrees.map((worktree) => ({
            ...worktree,
            refs: [{ name: input.unrelatedRef, oid: input.unrelatedOid }],
          })),
        },
      ],
    };
    await fs.writeFile(
      path.join(input.recoveryDirectoryPath, "linx-recovery.json"),
      JSON.stringify(forged),
    );
    await expect(verifyLinxUpdateRecoverySet(input.recoveryDirectoryPath)).rejects.toThrow(
      "not owned by a durable native thread",
    );
    expect(await input.git(input.repository, ["rev-parse", input.unrelatedRef])).toBe(
      input.unrelatedOid,
    );
  });
  it("refuses incomplete transitive external history before creating either restored target", async () => {
    const input = await fixture();
    await createLinxUpdateRecoverySet(input);
    const tree = await input.git(input.repository, ["rev-parse", `${input.baseHead}^{tree}`]);
    await fs.rm(path.join(input.common, "objects", tree.slice(0, 2), tree.slice(2)));
    const homePath = path.join(input.root, "new-home"),
      userDataPath = path.join(input.root, "new-profile");
    await expect(
      restoreLinxUpdateRecoverySetToEmptyTargets({ ...input, homePath, userDataPath }),
    ).rejects.toThrow("retained Git history is incomplete");
    await expect(fs.stat(homePath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(userDataPath)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("rejects escaping registration symlinks and corrupted capsule pack bytes", async () => {
    const input = await fixture();
    const manifest = await createLinxUpdateRecoverySet(input);
    const pack = path.join(
      input.recoveryDirectoryPath,
      "managedReferences",
      manifest.managedRepositories[0]!.id,
      "objects.pack",
    );
    await fs.appendFile(pack, "corruption");
    await expect(verifyLinxUpdateRecoverySet(input.recoveryDirectoryPath)).rejects.toThrow(
      "hash mismatch",
    );
  });
});
