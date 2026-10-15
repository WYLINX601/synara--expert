import * as fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import * as path from "node:path";

import { Effect } from "effect";

import { writeFileStringAtomically } from "../atomicWrite";
import { ensurePrivateDirectorySync } from "../privatePathPermissions";

export class ExpertMcpStorageError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ExpertMcpStorageError";
  }
}

export async function assertPrivateDirectory(
  directory: string,
  message: string,
  missingOk: boolean,
): Promise<boolean> {
  let stat: Awaited<ReturnType<typeof fs.lstat>>;
  try {
    stat = await fs.lstat(directory);
  } catch (cause) {
    if (missingOk && (cause as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw new ExpertMcpStorageError(message, { cause });
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new ExpertMcpStorageError(message);
  }
  return true;
}

export async function readPrivateJsonFile(
  target: string,
  maxBytes: number,
  message: string,
  missingOk: boolean,
): Promise<unknown | undefined> {
  let before: Awaited<ReturnType<typeof fs.lstat>>;
  try {
    before = await fs.lstat(target);
  } catch (cause) {
    if (missingOk && (cause as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new ExpertMcpStorageError(message, { cause });
  }
  if (!before.isFile() || before.isSymbolicLink() || before.size > maxBytes) {
    throw new ExpertMcpStorageError(message);
  }

  let handle: fs.FileHandle;
  try {
    handle = await fs.open(
      target,
      fsConstants.O_RDONLY | (process.platform === "win32" ? 0 : fsConstants.O_NOFOLLOW),
    );
  } catch (cause) {
    throw new ExpertMcpStorageError(message, { cause });
  }
  try {
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.size > maxBytes
    ) {
      throw new ExpertMcpStorageError(message);
    }
    const bytes = await handle.readFile();
    if (bytes.byteLength > maxBytes) throw new ExpertMcpStorageError(message);
    try {
      return JSON.parse(bytes.toString("utf8")) as unknown;
    } catch (cause) {
      throw new ExpertMcpStorageError(message, { cause });
    }
  } finally {
    await handle.close();
  }
}

export async function writePrivateFileAtomically(target: string, contents: string): Promise<void> {
  ensurePrivateDirectorySync(path.dirname(target));
  await Effect.runPromise(writeFileStringAtomically({ filePath: target, contents }));
}
