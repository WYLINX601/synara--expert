import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, rm, stat } from "node:fs/promises";
import { relative, sep, join } from "node:path";
import type { RepositoryStatePaths, VerificationCheck, VerificationCheckLogs } from "./state.ts";

export type VerificationLogIndex = {
  readonly formatVersion: 1;
  readonly runId: string;
  readonly candidateSha: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly checks: readonly Pick<
    VerificationCheck,
    "id" | "status" | "exitCode" | "durationMs" | "reason" | "logs"
  >[];
};

export type VerificationLogRun = {
  readonly runId: string;
  writeCheck(
    id: string,
    output: { readonly stdout: string; readonly stderr: string; readonly runnerError?: string },
  ): Promise<VerificationCheckLogs>;
  writeIndex(index: VerificationLogIndex): Promise<{
    readonly path: string;
    readonly sha256: string;
    readonly sizeBytes: number;
  }>;
};

function sha256(contents: Buffer): string {
  return createHash("sha256").update(contents).digest("hex");
}

function commonRelativePath(commonDirectory: string, absolutePath: string): string {
  return relative(commonDirectory, absolutePath).split(sep).join("/");
}

async function ensurePrivateDirectory(path: string, create: boolean): Promise<void> {
  if (create) {
    try {
      await mkdir(path, { mode: 0o700 });
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
    }
  }
  const pathStats = await lstat(path);
  if (!pathStats.isDirectory() || pathStats.isSymbolicLink()) {
    throw new Error("verification-log-directory-invalid");
  }
  if (process.platform !== "win32") {
    await chmod(path, 0o700);
    const privateStats = await stat(path);
    if ((privateStats.mode & 0o777) !== 0o700) {
      throw new Error("verification-log-directory-not-private");
    }
  }
}

async function writePrivateFile(path: string, content: string): Promise<Buffer> {
  const contents = Buffer.from(content, "utf8");
  const handle = await open(path, "wx", 0o600);
  try {
    if (process.platform !== "win32") await handle.chmod(0o600);
    await handle.writeFile(contents);
    await handle.sync();
  } catch (error) {
    await handle.close();
    await rm(path, { force: true });
    throw error;
  }
  await handle.close();
  if (process.platform !== "win32") {
    const fileStats = await stat(path);
    if (!fileStats.isFile() || (fileStats.mode & 0o777) !== 0o600) {
      await rm(path, { force: true });
      throw new Error("verification-log-file-not-private");
    }
  }
  return contents;
}

function logFileReference(commonDirectory: string, path: string, contents: Buffer) {
  return {
    path: commonRelativePath(commonDirectory, path),
    sha256: sha256(contents),
    sizeBytes: contents.byteLength,
  };
}

export async function createVerificationLogRun(
  paths: RepositoryStatePaths,
  candidateSha: string,
  runId = randomUUID(),
): Promise<VerificationLogRun> {
  const root = join(paths.stateDirectory, "verification-logs");
  const candidateDirectory = join(root, candidateSha);
  const runDirectory = join(candidateDirectory, runId);
  await ensurePrivateDirectory(paths.stateDirectory, false);
  await ensurePrivateDirectory(root, true);
  await ensurePrivateDirectory(candidateDirectory, true);
  await ensurePrivateDirectory(runDirectory, true);

  const indexPath = join(runDirectory, "index.json");
  return {
    runId,
    async writeCheck(id, output) {
      if (!/^[a-z0-9-]+$/.test(id)) throw new Error("verification-log-check-id-invalid");
      const stdoutPath = join(runDirectory, `${id}.stdout.log`);
      const stderrPath = join(runDirectory, `${id}.stderr.log`);
      const stdout = await writePrivateFile(stdoutPath, output.stdout);
      const stderr = await writePrivateFile(stderrPath, output.stderr);
      const runnerError = output.runnerError
        ? await writePrivateFile(join(runDirectory, `${id}.runner-error.log`), output.runnerError)
        : undefined;
      return {
        stdout: logFileReference(paths.commonDirectory, stdoutPath, stdout),
        stderr: logFileReference(paths.commonDirectory, stderrPath, stderr),
        ...(runnerError
          ? {
              runnerError: logFileReference(
                paths.commonDirectory,
                join(runDirectory, `${id}.runner-error.log`),
                runnerError,
              ),
            }
          : {}),
      };
    },
    async writeIndex(index) {
      const contents = await writePrivateFile(indexPath, `${JSON.stringify(index, null, 2)}\n`);
      try {
        const directory = await open(runDirectory, "r");
        try {
          await directory.sync();
        } finally {
          await directory.close();
        }
      } catch {
        // Some supported filesystems do not permit syncing directory handles.
      }
      return logFileReference(paths.commonDirectory, indexPath, contents);
    },
  };
}
