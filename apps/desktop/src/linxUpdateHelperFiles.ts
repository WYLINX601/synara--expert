import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { syncDirectoryEntry } from "@synara/shared/filesystemPlatform";
import {
  extractLinxUpdateArchive,
  hashLinxUpdateBundleInventory,
  type LinxUpdateBundleRecord,
} from "@synara/shared/linxUpdateArchive";

export const LINX_HELPER_FILES = {
  request: "request.json",
  nonce: "authorization.nonce",
  release: "release.json",
  manifest: "manifest.json",
  signature: "manifest.sig",
  package: "package.zip",
  journal: "linx-update-install.json",
  healthRequest: "health-request.json",
  healthClaim: "health-claim.json",
  healthOwnership: "health-ownership.json",
  healthProof: "health-proof.json",
} as const;
export function linxOSAtLeast(actual: string, minimum: string): boolean {
  if (!/^\d+(?:\.\d+){0,2}$/u.test(actual) || !/^\d+(?:\.\d+){0,2}$/u.test(minimum)) return false;
  const a = actual.split(".").map(Number),
    b = minimum.split(".").map(Number);
  for (let index = 0; index < 3; index++) {
    if ((a[index] ?? 0) !== (b[index] ?? 0)) return (a[index] ?? 0) > (b[index] ?? 0);
  }
  return true;
}
export const sha256 = (bytes: Uint8Array | string): string =>
  createHash("sha256").update(bytes).digest("hex");
export async function requireCanonicalPath(path: string): Promise<void> {
  if (resolve(path) !== path || (await fs.realpath(path)) !== path)
    throw new Error("Linked or noncanonical installation path");
  let cursor = path;
  while (cursor !== dirname(cursor)) {
    if ((await fs.lstat(cursor)).isSymbolicLink()) throw new Error("Linked installation ancestor");
    cursor = dirname(cursor);
  }
}
export async function requirePrivateDirectory(path: string): Promise<void> {
  await requireCanonicalPath(path);
  const stat = await fs.lstat(path);
  if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o700)
    throw new Error("Attempt directory is not private and owned");
}
export async function readPrivateFile(path: string, maximum = 64 * 1024): Promise<Buffer> {
  const handle = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.uid !== process.getuid?.() ||
      (stat.mode & 0o777) !== 0o600 ||
      stat.size > maximum
    )
      throw new Error("Invalid private attempt file");
    const bytes = Buffer.alloc(stat.size + 1);
    let size = 0;
    while (size < bytes.length) {
      const read = await handle.read(bytes, size, bytes.length - size, size);
      if (read.bytesRead === 0) break;
      size += read.bytesRead;
    }
    const after = await handle.stat();
    if (
      size !== stat.size ||
      after.size !== stat.size ||
      after.mtimeMs !== stat.mtimeMs ||
      after.ctimeMs !== stat.ctimeMs
    )
      throw new Error("Private attempt file changed while reading");
    return bytes.subarray(0, size);
  } finally {
    await handle.close();
  }
}
export async function readPrivateJson(path: string): Promise<unknown> {
  return JSON.parse((await readPrivateFile(path)).toString("utf8"));
}
export async function writePrivateJson(path: string, value: unknown): Promise<void> {
  const temporary = join(dirname(path), `.write-${randomUUID()}`);
  const handle = await fs.open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await fs.rename(temporary, path);
    await syncDirectoryEntry(dirname(path));
  } catch (error) {
    await fs.rm(temporary, { force: true });
    throw error;
  }
}
/** Flush copied executables/packages and all extracted directory entries before handoff. */
export async function syncLinxHelperTree(path: string): Promise<void> {
  const stat = await fs.lstat(path);
  if (stat.isSymbolicLink()) return;
  if (stat.isDirectory()) {
    for (const entry of await fs.readdir(path)) await syncLinxHelperTree(join(path, entry));
    await syncDirectoryEntry(path);
    return;
  }
  if (!stat.isFile()) throw new Error("Special file in durable installation tree");
  const handle = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
export async function hashPrivatePackage(path: string, size: number): Promise<string> {
  const handle = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (
      !before.isFile() ||
      before.nlink !== 1 ||
      before.uid !== process.getuid?.() ||
      (before.mode & 0o777) !== 0o600 ||
      before.size !== size
    )
      throw new Error("Package ownership/size mismatch");
    const hash = createHash("sha256");
    let count = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      count += chunk.length;
      if (count > size) throw new Error("Package grew beyond its signed bound");
      hash.update(chunk);
    }
    const after = await handle.stat();
    if (
      count !== size ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    )
      throw new Error("Package changed while hashing");
    return hash.digest("hex");
  } finally {
    await handle.close();
  }
}
/** Pins data and seal bytes, entry types, modes and link text, not ad-hoc signer labels. */
export async function hashLinxHelperBundle(root: string): Promise<string> {
  await requireCanonicalPath(root);
  const records: LinxUpdateBundleRecord[] = [];
  let entries = 1;
  let total = 0;
  const walk = async (path: string, depth: number): Promise<void> => {
    if (depth > 128) throw new Error("Bundle inventory exceeds authenticated archive bounds");
    const before = await fs.lstat(path);
    const name = relative(root, path);
    const mode = before.mode & 0o777;
    if (before.isSymbolicLink()) {
      const target = await fs.readlink(path);
      const resolved = relative(root, await fs.realpath(path));
      if (Buffer.byteLength(target) > 4_096 || resolved === ".." || resolved.startsWith("../"))
        throw new Error("Bundle link escapes authenticated application");
      records.push(["link", name, mode, target]);
    } else if (before.isDirectory()) {
      await requireCanonicalPath(path);
      records.push(["directory", name, mode]);
      const directory = await fs.opendir(path);
      for await (const entry of directory) {
        if (++entries > 100_000)
          throw new Error("Bundle inventory exceeds authenticated archive bounds");
        await walk(join(path, entry.name), depth + 1);
      }
    } else if (before.isFile() && before.nlink === 1) {
      total += before.size;
      if (total > 16 * 1024 ** 3)
        throw new Error("Bundle content exceeds authenticated archive bounds");
      const handle = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const opened = await handle.stat();
        if (opened.dev !== before.dev || opened.ino !== before.ino)
          throw new Error("Bundle changed during authenticated inventory");
        const content = createHash("sha256");
        let size = 0;
        for await (const chunk of handle.createReadStream({ autoClose: false })) {
          size += chunk.length;
          if (size > before.size) throw new Error("Bundle grew during authenticated inventory");
          content.update(chunk);
        }
        const after = await handle.stat();
        if (
          size !== before.size ||
          before.mtimeMs !== after.mtimeMs ||
          before.ctimeMs !== after.ctimeMs
        )
          throw new Error("Bundle changed during authenticated inventory");
        records.push(["file", name, mode, size, content.digest("hex")]);
      } finally {
        await handle.close();
      }
    } else throw new Error("Special or hard-linked entry in authenticated bundle");
    const after = await fs.lstat(path);
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    )
      throw new Error("Bundle changed during authenticated inventory");
  };
  await walk(root, 0);
  return hashLinxUpdateBundleInventory(records);
}
/** Startup never trusts a writable saved digest: reconstruct from signed package bytes. */
export async function verifyLinxHelperBundleFromPackage(input: {
  packagePath: string;
  size: number;
  sha256: string;
  attemptPath: string;
  applicationPath: string;
}): Promise<string> {
  if ((await hashPrivatePackage(input.packagePath, input.size)) !== input.sha256)
    throw new Error("Authenticated package hash mismatch");
  const scratch = await fs.mkdtemp(join(input.attemptPath, ".bundle-integrity-"));
  try {
    const extracted = await extractLinxUpdateArchive(input.packagePath, join(scratch, "payload"), {
      size: input.size,
      sha256: input.sha256,
    });
    const expected = extracted.contentDigest;
    if (
      (await hashPrivatePackage(input.packagePath, input.size)) !== input.sha256 ||
      (await hashLinxHelperBundle(input.applicationPath)) !== expected
    )
      throw new Error("Bundle differs from authenticated package content");
    return expected;
  } finally {
    await fs.rm(scratch, { recursive: true, force: true });
  }
}
export async function exists(path: string): Promise<boolean> {
  try {
    await fs.lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
