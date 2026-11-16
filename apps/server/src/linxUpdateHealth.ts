import * as fs from "node:fs/promises";
import { constants } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

/** Read the metadata beside the actual executing server, never a supplied env SHA. */
export async function readLinxServerSourceCommit(
  entryPath = fileURLToPath(import.meta.url),
): Promise<string | null> {
  if (!entryPath.endsWith(`${path.sep}apps${path.sep}server${path.sep}dist${path.sep}index.mjs`))
    return null;
  const metadata = path.resolve(path.dirname(entryPath), "../../..", "package.json");
  try {
    const handle = await fs.open(metadata, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const before = await handle.stat();
      if (!before.isFile() || before.size > 1024 * 1024) return null;
      const bytes = Buffer.alloc(before.size + 1);
      let size = 0;
      while (size < bytes.length) {
        const read = await handle.read(bytes, size, bytes.length - size, size);
        if (read.bytesRead === 0) break;
        size += read.bytesRead;
      }
      const after = await handle.stat();
      if (
        size !== before.size ||
        after.size !== before.size ||
        after.mtimeMs !== before.mtimeMs ||
        after.ctimeMs !== before.ctimeMs
      )
        return null;
      const metadataValue: unknown = JSON.parse(bytes.toString("utf8", 0, size));
      if (
        typeof metadataValue !== "object" ||
        metadataValue === null ||
        !("synaraCommitHash" in metadataValue)
      )
        return null;
      const value = metadataValue.synaraCommitHash;
      return typeof value === "string" && /^[a-f0-9]{40}$/.test(value) ? value : null;
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
}

// Only authenticated feature sockets admitted by the trusted app-origin route enter this ledger.
// Connection scope finalizers remove them; an HTTP readiness sample alone is not client health.
const clients = new Set<string>();
export function registerLinxUpdateClient(
  key: string,
  origin: string | undefined,
  nativeAuthenticated: boolean,
): () => void {
  if (!nativeAuthenticated || (origin !== "linx://app" && origin !== "linx-preview://app"))
    return () => undefined;
  clients.add(key);
  return () => clients.delete(key);
}
export function hasLinxUpdateClient(): boolean {
  return clients.size > 0;
}
