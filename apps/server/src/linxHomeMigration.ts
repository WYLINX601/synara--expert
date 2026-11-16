import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { CommandId } from "@synara/contracts";
import type { OrchestrationCommand } from "@synara/contracts";
import { Effect } from "effect";
import type { OrchestrationEngineShape } from "./orchestration/Services/OrchestrationEngine";
import {
  acquireDatabaseLifecycleLock,
  releaseDatabaseLifecycleLock,
} from "@synara/shared/databaseLifecycleLock";
import { syncDirectoryEntry } from "@synara/shared/filesystemPlatform";
import { execProcessFile } from "@synara/shared/processRuntime";
import { codexSourceIdentitySteps } from "@synara/shared/codexSourceIdentity";

export const LINX_HOME_MIGRATION_RECEIPT = "linx-home-migration.json";

/** Lexical mapping for copied metadata/options; this does not prove native ownership. */
export function relocateLinxOwnedPath(
  value: string,
  sourceHomePath: string,
  homePath: string,
): string {
  const relative = path.relative(sourceHomePath, value);
  return relative === ""
    ? homePath
    : !path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`)
      ? path.join(homePath, relative)
      : value;
}

async function resolveLivePathIdentity(value: string): Promise<string | undefined> {
  const steps = codexSourceIdentitySteps(value);
  let step = steps.next();
  while (!step.done) {
    try {
      step = steps.next(await fs.realpath(step.value));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      // Only an absent component may be appended to a canonical ancestor.
      // A dangling symlink is existing evidence, not an owned missing directory.
      const entry = await fs.lstat(step.value).catch((cause: NodeJS.ErrnoException) => {
        if (cause.code === "ENOENT") return undefined;
        throw cause;
      });
      if (entry) return undefined;
      step = steps.throw(error);
    }
  }
  return step.value;
}

/** Resolve live references natively, once per migration root, without changing historical spellings. */
export async function createLinxLivePathRelocator(sourceHomePath: string, homePath: string) {
  const roots = await Promise.all([fs.realpath(sourceHomePath), fs.realpath(homePath)]);
  const [source, destination] = roots.map((root) =>
    process.platform === "win32" ? root.toLowerCase() : root,
  ) as [string, string];
  return async (value: string): Promise<string> => {
    if (!path.isAbsolute(value)) return value;
    const canonical = await resolveLivePathIdentity(value);
    if (canonical === undefined) return value;
    const relocated = relocateLinxOwnedPath(canonical, source, homePath);
    if (relocated === canonical) return value;
    const copied = await resolveLivePathIdentity(relocated);
    if (copied === undefined || relocateLinxOwnedPath(copied, destination, source) === copied) {
      throw new Error(`Live path escapes the copied Linx home: ${relocated}`);
    }
    return relocated;
  };
}

async function realFile(filePath: string): Promise<string> {
  const stat = await fs.lstat(filePath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024)
    throw new Error(`Unsafe managed reference: ${filePath}`);
  return fs.readFile(filePath, "utf8");
}

/** Call before opening SQLite so an interrupted filesystem import cannot be upgraded or served. */
export async function assertLinxHomeMigrationReadyForDatabase(homePath: string): Promise<void> {
  const text = await realFile(`${homePath}.linx-migration.json`).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    },
  );
  if (text === null) return;
  const journal = JSON.parse(text) as Record<string, unknown>;
  if (
    journal.schemaVersion !== 1 ||
    journal.homePath !== (await fs.realpath(homePath)) ||
    (journal.status !== "paths-pending" && journal.status !== "complete")
  ) {
    throw new Error(
      "Linx home import is incomplete; preserve both sources and use the verified recovery set before starting",
    );
  }
  const receiptText = await realFile(path.join(homePath, LINX_HOME_MIGRATION_RECEIPT));
  const receipt = JSON.parse(receiptText) as Record<string, unknown>;
  if (
    receipt.schemaVersion !== 1 ||
    receipt.homePath !== journal.homePath ||
    (receipt.status !== "paths-pending" && receipt.status !== "complete")
  ) {
    throw new Error("Linx home import journal has no matching durable receipt");
  }
}

/** Repairs only linked worktrees beneath the app-owned worktrees root, never copies an external repository. */
export async function repairLinxManagedWorktrees(input: {
  sourceHomePath: string;
  homePath: string;
}): Promise<void> {
  const homePath = await fs.realpath(input.homePath);
  const sourceHomePath = await fs.realpath(input.sourceHomePath);
  const root = path.join(homePath, "worktrees");
  async function visit(current: string): Promise<void> {
    const entries = await fs.readdir(current, { withFileTypes: true });
    const pointer = entries.find((entry) => entry.name === ".git");
    if (pointer?.isFile()) {
      const oldWorktree = relocateLinxOwnedPath(current, homePath, sourceHomePath);
      const text = await realFile(path.join(current, ".git"));
      const match = /^gitdir: ([^\r\n]+)\r?\n?$/u.exec(text);
      if (!match) throw new Error(`Invalid managed worktree pointer: ${current}`);
      const oldGitDir = path.resolve(oldWorktree, match[1]!);
      const newGitDir = relocateLinxOwnedPath(oldGitDir, sourceHomePath, homePath);
      const canonicalGitDir = await fs.realpath(newGitDir);
      const commonText = await realFile(path.join(canonicalGitDir, "commondir"));
      const common = await fs.realpath(path.resolve(canonicalGitDir, commonText.trim()));
      // Bind the metadata directory to this repository's worktree registration.
      if (path.dirname(canonicalGitDir) !== path.join(common, "worktrees"))
        throw new Error("Unowned git worktree registration");
      const backlink = (await realFile(path.join(canonicalGitDir, "gitdir"))).trim();
      if (
        path.resolve(backlink) !== path.join(oldWorktree, ".git") &&
        path.resolve(backlink) !== path.join(current, ".git")
      ) {
        throw new Error("Git worktree backlink does not belong to the migrated checkout");
      }
      // Normalize only the copied pointer; Git's native repair owns the reverse link.
      await fs.writeFile(path.join(current, ".git"), `gitdir: ${canonicalGitDir}\n`, {
        flush: true,
      });
      await new Promise<void>((resolve, reject) => {
        execProcessFile(
          "git",
          [
            "-c",
            "core.hooksPath=/dev/null",
            "-c",
            "core.fsmonitor=false",
            "--git-dir",
            common,
            "worktree",
            "repair",
            current,
          ],
          {
            encoding: "utf8",
            timeout: 30_000,
            maxBuffer: 1024 * 1024,
            env: {
              PATH: process.env.PATH || "/usr/bin:/bin",
              LC_ALL: "C",
              GIT_CONFIG_NOSYSTEM: "1",
              GIT_CONFIG_GLOBAL: "/dev/null",
            },
          },
          (error) => (error ? reject(error) : resolve()),
        );
      });
      if (
        (await realFile(path.join(canonicalGitDir, "gitdir"))).trim() !== path.join(current, ".git")
      ) {
        throw new Error("Git worktree repair did not bind the new checkout");
      }
      return;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) await visit(path.join(current, entry.name));
    }
  }
  const rootStat = await fs.lstat(root).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (rootStat === null) return;
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink())
    throw new Error("Managed worktree root is not a real directory");
  await visit(root);
  // Recovery snapshot names are content-addressed historical evidence. Keep their
  // names and bytes: sourceWorktree is historical metadata, not a live path alias.
}

/** Run after the native engine/projections are ready but BEFORE any transport or task producer starts. */
export function completeLinxHomeMigration(input: {
  homePath: string;
  engine: OrchestrationEngineShape;
  migrateProviderBindings: (paths: {
    sourceHomePath: string;
    homePath: string;
  }) => Effect.Effect<void, unknown>;
  settleOrphanedActivity: (paths: {
    sourceHomePath: string;
    homePath: string;
  }) => Effect.Effect<void, Error>;
}) {
  return Effect.tryPromise({
    try: async () => {
      await assertLinxHomeMigrationReadyForDatabase(input.homePath);
      const receiptPath = path.join(input.homePath, LINX_HOME_MIGRATION_RECEIPT);
      const text = await realFile(receiptPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      if (text === null) return;
      const receipt = JSON.parse(text) as Record<string, unknown>;
      if (
        receipt.schemaVersion !== 1 ||
        typeof receipt.sourceHomePath !== "string" ||
        receipt.homePath !== (await fs.realpath(input.homePath)) ||
        (receipt.status !== "paths-pending" && receipt.status !== "complete")
      )
        throw new Error("Invalid Linx migration receipt");
      if (receipt.status === "complete") return;
      const sourceHomePath = receipt.sourceHomePath;
      const sourceLock = await Effect.runPromise(
        acquireDatabaseLifecycleLock(path.join(sourceHomePath, "userdata", "state.sqlite")),
      );
      try {
        await repairLinxManagedWorktrees({ sourceHomePath, homePath: input.homePath });
        const health = await Effect.runPromise(input.engine.getProjectionCatchUpStatus);
        if (health.state !== "healthy" || health.inFlight)
          throw new Error("Path migration requires healthy caught-up projections");
        // Native continuation admission must be repaired before exposing the engine
        // or completing the receipt; repository failures leave a retryable import.
        await Effect.runPromise(
          input.migrateProviderBindings({ sourceHomePath, homePath: input.homePath }),
        );
        await Effect.runPromise(
          input.settleOrphanedActivity({ sourceHomePath, homePath: input.homePath }),
        );
        await Effect.runPromise(input.engine.drain);
        const settledHealth = await Effect.runPromise(input.engine.getProjectionCatchUpStatus);
        if (settledHealth.state !== "healthy" || settledHealth.inFlight)
          throw new Error("Path migration requires healthy caught-up projections after restart");
        const model = await Effect.runPromise(input.engine.getReadModel());
        const relocateLivePath = await createLinxLivePathRelocator(sourceHomePath, input.homePath);
        const commands: OrchestrationCommand[] = [];
        const commandId = (kind: string, id: string) =>
          CommandId.makeUnsafe(
            `linx-home-${createHash("sha256")
              .update(`${sourceHomePath}\0${input.homePath}\0${kind}\0${id}`)
              .digest("hex")}`,
          );
        for (const project of model.projects) {
          const workspaceRoot = await relocateLivePath(project.workspaceRoot);
          const additionalFolders = await Promise.all(
            (project.additionalFolders ?? []).map(relocateLivePath),
          );
          const foldersChanged = additionalFolders.some(
            (folder, index) => folder !== project.additionalFolders?.[index],
          );
          if (workspaceRoot !== project.workspaceRoot || foldersChanged)
            commands.push({
              type: "project.meta.update",
              commandId: commandId("project", project.id),
              projectId: project.id,
              ...(workspaceRoot !== project.workspaceRoot
                ? { workspaceRoot, createWorkspaceRootIfMissing: false }
                : {}),
              ...(foldersChanged ? { additionalFolders } : {}),
            });
        }
        for (const thread of model.threads) {
          const changes: {
            worktreePath?: string;
            workingDirectory?: string;
            associatedWorktreePath?: string;
          } = {};
          for (const field of [
            "worktreePath",
            "workingDirectory",
            "associatedWorktreePath",
          ] as const) {
            const old = thread[field];
            if (old) {
              const relocated = await relocateLivePath(old);
              if (relocated !== old) changes[field] = relocated;
            }
          }
          if (Object.keys(changes).length)
            commands.push({
              type: "thread.meta.update",
              commandId: commandId("thread", thread.id),
              threadId: thread.id,
              ...changes,
            });
        }
        for (const command of commands) await Effect.runPromise(input.engine.dispatch(command));
        await Effect.runPromise(input.engine.drain);
        const finalHealth = await Effect.runPromise(input.engine.getProjectionCatchUpStatus);
        if (finalHealth.state !== "healthy" || finalHealth.inFlight)
          throw new Error("Path migration projection health is not proven");
        const updated = { ...receipt, status: "complete", completedAt: new Date().toISOString() };
        const temporaryPath = `${receiptPath}.completing-${randomUUID()}`;
        const handle = await fs.open(temporaryPath, "wx", 0o600);
        try {
          await handle.writeFile(`${JSON.stringify(updated)}\n`);
          await handle.sync();
        } finally {
          await handle.close();
        }
        await fs.rename(temporaryPath, receiptPath);
        await syncDirectoryEntry(input.homePath);
      } finally {
        await Effect.runPromise(releaseDatabaseLifecycleLock(sourceLock));
      }
    },
    catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
  });
}
