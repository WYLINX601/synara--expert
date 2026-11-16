import { constants } from "node:fs";
import type { Stats } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";

const MAX_SECRET_FILE_BYTES = 16 * 1024 * 1024;

export function providerEnvironmentSecretName(input: {
  readonly instanceId: string;
  readonly name: string;
}): string {
  return `provider-env-${Buffer.from(input.instanceId, "utf8").toString("base64url")}-${Buffer.from(input.name, "utf8").toString("base64url")}`;
}

export function resolveServerSecretPath(secretsDir: string, name: string): string {
  return path.join(secretsDir, `${name.replace(/[^a-zA-Z0-9_.-]/g, "_")}.bin`);
}

export async function readServerSecretFile(secretPath: string): Promise<Uint8Array | null> {
  const directory = await fs
    .lstat(path.dirname(secretPath))
    .catch((cause: NodeJS.ErrnoException) => {
      if (cause.code === "ENOENT") return null;
      throw cause;
    });
  if (directory === null) return null;
  if (!directory.isDirectory() || directory.isSymbolicLink()) {
    throw new Error("Secret directory is invalid.");
  }
  let before: Stats;
  try {
    before = await fs.lstat(secretPath);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw cause;
  }
  if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_SECRET_FILE_BYTES) {
    throw new Error("Secret file is invalid.");
  }
  const flags = constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW);
  const handle = await fs.open(secretPath, flags);
  try {
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.size > MAX_SECRET_FILE_BYTES
    ) {
      throw new Error("Secret file is invalid.");
    }
    const chunks: Buffer[] = [];
    let total = 0;
    while (true) {
      const remaining = MAX_SECRET_FILE_BYTES + 1 - total;
      if (remaining <= 0) throw new Error("Secret file is invalid.");
      const chunk = Buffer.alloc(Math.min(64 * 1024, remaining));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > MAX_SECRET_FILE_BYTES) throw new Error("Secret file is invalid.");
      chunks.push(chunk.subarray(0, bytesRead));
    }
    const after = await handle.stat();
    const named = await fs.lstat(secretPath);
    const parent = await fs.lstat(path.dirname(secretPath));
    if (
      total !== before.size ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs ||
      after.mode !== before.mode ||
      named.isSymbolicLink() ||
      named.dev !== before.dev ||
      named.ino !== before.ino ||
      parent.isSymbolicLink() ||
      parent.dev !== directory.dev ||
      parent.ino !== directory.ino
    ) {
      throw new Error("Secret file changed while reading.");
    }
    return Buffer.concat(chunks, total);
  } finally {
    await handle.close();
  }
}
