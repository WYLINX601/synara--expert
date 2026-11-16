import { createHash, type Hash } from "node:crypto";
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { dirname, join, posix } from "node:path";
import { Readable } from "node:stream";
import { crc32 } from "node:zlib";
import {
  RandomAccessReader,
  fromRandomAccessReaderPromise,
  getFileNameLowLevel,
  parseExtraFields,
  type Entry,
  type ExtraField,
  type ZipFile,
} from "yauzl";

const MAX_ENTRIES = 100_000;
const MAX_EXPANDED_BYTES = 16 * 1024 ** 3;
const MAX_LINK_BYTES = 4_096;
const EXTRA_FIELDS = new Map([
  [0x0001, 1],
  [0x000a, 2],
  [0x334d, 4],
  [0x5455, 8],
  [0x5855, 16],
  [0x7855, 32],
  [0x7875, 64],
  [0x7075, 128],
  [0x6375, 256],
]);
const utf8 = new TextDecoder("utf-8", { fatal: true });

function assertExtraFields(fields: readonly ExtraField[]): void {
  let seen = 0;
  for (const field of fields) {
    const bit = EXTRA_FIELDS.get(field.id);
    if (bit === undefined || (seen & bit) !== 0)
      throw new Error("The update ZIP has unsupported or repeated metadata.");
    seen |= bit;
  }
}

export interface LinxUpdateArchiveEntry {
  readonly path: string;
  readonly kind: "file" | "directory" | "symlink";
  readonly mode: number;
  readonly size: number;
  readonly linkTarget: string | null;
}

export interface LinxUpdateArchive {
  readonly applicationName: string;
  readonly expandedBytes: number;
  readonly entries: readonly LinxUpdateArchiveEntry[];
}

export type LinxUpdateBundleRecord =
  | readonly ["directory", string, number]
  | readonly ["link", string, number, string]
  | readonly ["file", string, number, number, string];

/** Consumes the inventory in canonical relative-path order. */
export function hashLinxUpdateBundleInventory(records: LinxUpdateBundleRecord[]): string {
  records.sort((a, b) => (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  const hash = createHash("sha256");
  for (const record of records) hash.update(JSON.stringify(record));
  return hash.digest("hex");
}

interface ArchiveAuthentication {
  readonly size: number;
  readonly sha256: string;
}

export interface LinxUpdateExtractedArchive extends LinxUpdateArchive {
  readonly applicationPath: string;
  readonly contentDigest: string;
  readonly resourceMetadata: readonly { filePath: string; targetPath: string }[];
}

async function readArchiveEntry(
  zip: ZipFile,
  entry: Entry,
  filePath: string,
  mode: number,
  contentHash?: Hash,
): Promise<void> {
  const output = await fs.open(
    filePath,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  let stream: Readable | undefined;
  let size = 0;
  let crc = 0;
  try {
    stream = await zip.openReadStreamPromise(entry);
    for await (const chunk of stream) {
      const bytes = chunk as Uint8Array;
      size += bytes.byteLength;
      if (size > entry.uncompressedSize)
        throw new Error("The update ZIP expanded beyond its declared size.");
      crc = crc32(bytes, crc);
      contentHash?.update(bytes);
      let offset = 0;
      while (offset < bytes.byteLength) {
        const { bytesWritten } = await output.write(bytes, offset, bytes.byteLength - offset);
        if (bytesWritten === 0) throw new Error("The update ZIP extraction made no progress.");
        offset += bytesWritten;
      }
    }
    if (size !== entry.uncompressedSize || crc !== entry.crc32)
      throw new Error("The update ZIP entry failed size or CRC verification.");
    await output.chmod(mode);
    await output.sync();
  } finally {
    stream?.destroy();
    await output.close();
  }
}

class PinnedReader extends RandomAccessReader {
  private readonly handle: FileHandle;
  constructor(handle: FileHandle) {
    super();
    this.handle = handle;
  }
  override _readStreamForRange(start: number, end: number): Readable {
    let position = start;
    const handle = this.handle;
    // yauzl destroys cancelled ranges; range streams must never own the pinned descriptor.
    return new Readable({
      read(size) {
        if (position === end) {
          this.push(null);
          return;
        }
        const bytes = Buffer.allocUnsafe(Math.min(size, end - position, 64 * 1024));
        void handle.read(bytes, 0, bytes.length, position).then(
          ({ bytesRead }) => {
            if (this.destroyed) return;
            if (bytesRead === 0) {
              this.destroy(new Error("The update ZIP ended inside a range."));
              return;
            }
            position += bytesRead;
            this.push(bytes.subarray(0, bytesRead));
          },
          (error: Error) => this.destroy(error),
        );
      },
    });
  }

  override read(
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
    callback: (error: Error | null) => void,
  ): void {
    const read = async (): Promise<void> => {
      let total = 0;
      while (total < length) {
        const { bytesRead } = await this.handle.read(
          buffer,
          offset + total,
          length - total,
          position + total,
        );
        if (bytesRead === 0) throw new Error("The update ZIP ended inside its metadata.");
        total += bytesRead;
      }
    };
    void read().then(
      () => callback(null),
      (error: Error) => callback(error),
    );
  }
  override close(callback: (error: Error | null) => void): void {
    // The outer FileHandle owns the descriptor; yauzl must not close it a second time.
    callback(null);
  }
}

function archivePath(name: string): string {
  const path = name.endsWith("/") ? name.slice(0, -1) : name;
  if (
    path.length === 0 ||
    path.length > 4_096 ||
    path.startsWith("/") ||
    /[\\:\x00-\x1f\x7f]/u.test(path) ||
    path
      .split("/")
      .some(
        (segment) =>
          segment === "" || segment === "." || segment === ".." || segment === "..namedfork",
      )
  ) {
    throw new Error("The update ZIP contains a non-canonical path.");
  }
  return path;
}

function resolveLink(
  entry: LinxUpdateArchiveEntry,
  entries: ReadonlyMap<string, LinxUpdateArchiveEntry>,
  present: ReadonlySet<string>,
  root: string,
): void {
  const pending = [
    ...posix.dirname(entry.path).split("/").slice(1),
    ...entry.linkTarget!.split("/"),
  ];
  const resolved: string[] = [];
  let links = 0;
  for (let index = 0; index < pending.length; index += 1) {
    const segment = pending[index]!;
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (resolved.length === 0)
        throw new Error("The update ZIP contains a link outside its application.");
      resolved.pop();
      continue;
    }
    const path = `${resolved.at(-1) ?? root}/${segment}`;
    const target = entries.get(path);
    if (target?.kind === "symlink") {
      if (++links > 40 || pending.length > 16_384)
        throw new Error("The update ZIP contains cyclic links.");
      pending.splice(index, 1, ...target.linkTarget!.split("/"));
      index -= 1;
    } else resolved.push(path);
  }
  if (!present.has(resolved.at(-1) ?? root))
    throw new Error("The update ZIP contains a broken framework link.");
}

function readArchive(filePath: string): Promise<LinxUpdateArchive>;
function readArchive(
  filePath: string,
  destinationPath: string,
  authentication?: ArchiveAuthentication,
): Promise<LinxUpdateExtractedArchive>;
async function readArchive(
  filePath: string,
  destinationPath?: string,
  authentication?: ArchiveAuthentication,
): Promise<LinxUpdateArchive | LinxUpdateExtractedArchive> {
  const before = await fs.lstat(filePath);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1)
    throw new Error("The update ZIP is not a private regular file.");
  const handle = await fs.open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  const opened = await handle.stat();
  if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) {
    await handle.close();
    throw new Error("The update ZIP changed before inspection.");
  }
  if (authentication !== undefined) {
    try {
      if (opened.size !== authentication.size)
        throw new Error("The authenticated update ZIP size changed.");
      const hash = createHash("sha256");
      let size = 0;
      for await (const chunk of handle.createReadStream({ start: 0, autoClose: false })) {
        size += chunk.length;
        if (size > authentication.size)
          throw new Error("The authenticated update ZIP grew while hashing.");
        hash.update(chunk);
      }
      if (size !== authentication.size || hash.digest("hex") !== authentication.sha256)
        throw new Error("The authenticated update ZIP digest differs.");
    } catch (error) {
      await handle.close();
      throw error;
    }
  }
  const zip = await fromRandomAccessReaderPromise(new PinnedReader(handle), opened.size, {
    autoClose: false,
    lazyEntries: true,
    strictFileNames: true,
    validateEntrySizes: true,
  }).catch(async (error: unknown) => {
    await handle.close();
    throw error;
  });
  const entries = new Map<string, LinxUpdateArchiveEntry>();
  const metadata: string[] = [];
  const names = new Set<string>();
  const sourceEntries = new Map<string, Entry>();
  let createdDestination = false;
  let expandedBytes = 0;
  let metadataBytes = 0;
  let applicationName: string | null = null;
  try {
    if (zip.entryCount < 1 || zip.entryCount > MAX_ENTRIES)
      throw new Error("The update ZIP entry count exceeds its limit.");
    for await (const entry of zip.eachEntry()) {
      metadataBytes +=
        entry.fileNameLength + entry.extraFieldLength + entry.fileCommentLength + 512;
      if (metadataBytes > 32 * 1024 ** 2)
        throw new Error("The update ZIP metadata exceeds its memory limit.");
      // Native ditto emits UTF-8 names without always setting ZIP's language bit.
      // Linx packages require UTF-8; reject contradictory Unicode-path metadata.
      const fileName = utf8.decode(entry.fileNameRaw);
      const path = archivePath(fileName);
      sourceEntries.set(path, entry);
      const folded = path.normalize("NFD").toLowerCase();
      if (names.has(folded))
        throw new Error("The update ZIP contains duplicate or case-colliding paths.");
      names.add(folded);
      if (
        entry.isEncrypted() ||
        (entry.generalPurposeBitFlag & ~0x080e) !== 0 ||
        ![0, 8].includes(entry.compressionMethod) ||
        !Number.isSafeInteger(entry.uncompressedSize) ||
        entry.uncompressedSize < 0
      ) {
        throw new Error("The update ZIP uses unsupported encryption, compression or metadata.");
      }
      assertExtraFields(entry.extraFields);
      expandedBytes += entry.uncompressedSize;
      if (expandedBytes > MAX_EXPANDED_BYTES)
        throw new Error("The update ZIP exceeds its expanded byte limit.");
      const local = await zip.readLocalFileHeaderPromise(entry);
      const localExtras = parseExtraFields(local.extraField);
      assertExtraFields(localExtras);
      if (
        !local.fileName.equals(entry.fileNameRaw) ||
        local.generalPurposeBitFlag !== entry.generalPurposeBitFlag ||
        local.compressionMethod !== entry.compressionMethod ||
        getFileNameLowLevel(
          entry.generalPurposeBitFlag | 0x800,
          entry.fileNameRaw,
          entry.extraFields,
          true,
        ) !== fileName ||
        getFileNameLowLevel(
          local.generalPurposeBitFlag | 0x800,
          local.fileName,
          localExtras,
          true,
        ) !== fileName
      ) {
        throw new Error("The update ZIP central and local entry headers disagree.");
      }
      const zip64 = localExtras.find((field) => field.id === 0x0001)?.data;
      let zip64Offset = 0;
      const localSize = (value: number): number => {
        if (value !== 0xffffffff) return value;
        if (zip64 === undefined || zip64Offset + 8 > zip64.length)
          throw new Error("Missing ZIP64 local size.");
        const size = zip64.readBigUInt64LE(zip64Offset);
        zip64Offset += 8;
        if (size > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Unsafe ZIP64 local size.");
        return Number(size);
      };
      const localUncompressed = localSize(local.uncompressedSize);
      const localCompressed = localSize(local.compressedSize);
      const descriptor = (entry.generalPurposeBitFlag & 8) !== 0;
      if (
        (!descriptor &&
          (local.crc32 !== entry.crc32 ||
            localCompressed !== entry.compressedSize ||
            localUncompressed !== entry.uncompressedSize)) ||
        (descriptor &&
          ((local.crc32 !== 0 && local.crc32 !== entry.crc32) ||
            (localCompressed !== 0 && localCompressed !== entry.compressedSize) ||
            (localUncompressed !== 0 && localUncompressed !== entry.uncompressedSize))) ||
        local.fileDataStart + entry.compressedSize > opened.size
      ) {
        throw new Error("The update ZIP central and local sizes disagree.");
      }
      const mode = entry.externalFileAttributes >>> 16;
      const fileType = mode & 0xf000;
      const kind =
        fileType === 0xa000
          ? "symlink"
          : fileType === 0x4000 || entry.fileName.endsWith("/")
            ? "directory"
            : "file";
      if (
        (mode & 0o7000) !== 0 ||
        ![0, 0x8000, 0x4000, 0xa000].includes(fileType) ||
        (kind === "directory" &&
          (entry.uncompressedSize !== 0 || (mode !== 0 && (mode & 0o500) !== 0o500)))
      ) {
        throw new Error("The update ZIP contains a special or unreadable directory.");
      }
      if (path === "__MACOSX" || path.startsWith("__MACOSX/")) {
        if (kind === "symlink" || entry.uncompressedSize > 16 * 1024 ** 2)
          throw new Error("Unsafe ZIP resource metadata.");
        if (kind !== "directory") metadata.push(path);
        continue;
      }
      const root = path.split("/")[0]!;
      if (!root.endsWith(".app") || (applicationName !== null && applicationName !== root))
        throw new Error("The update ZIP must contain exactly one application.");
      applicationName = root;
      if (posix.basename(path).startsWith("._"))
        throw new Error("AppleDouble payloads must use the bounded metadata namespace.");
      let linkTarget: string | null = null;
      if (kind === "symlink") {
        if (entry.uncompressedSize < 1 || entry.uncompressedSize > MAX_LINK_BYTES)
          throw new Error("The update ZIP link exceeds its limit.");
        const stream = await zip.openReadStreamPromise(entry);
        const chunks: Buffer[] = [];
        let size = 0;
        let crc = 0;
        try {
          for await (const chunk of stream) {
            const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
            size += bytes.length;
            if (size > MAX_LINK_BYTES) throw new Error("The update ZIP link exceeds its limit.");
            crc = crc32(bytes, crc);
            chunks.push(bytes);
          }
        } finally {
          stream.destroy();
        }
        if (size !== entry.uncompressedSize || crc !== entry.crc32)
          throw new Error("The update ZIP link failed CRC verification.");
        linkTarget = utf8.decode(Buffer.concat(chunks, size));
        if (posix.isAbsolute(linkTarget) || /[\\:\x00-\x1f\x7f]/u.test(linkTarget))
          throw new Error("Unsafe ZIP link target.");
      }
      const permissions = mode === 0 ? (kind === "directory" ? 0o755 : 0o644) : mode & 0o777;
      entries.set(path, {
        path,
        kind,
        mode: permissions,
        size: entry.uncompressedSize,
        linkTarget,
      });
    }
    if (applicationName === null) throw new Error("The update ZIP contains no application.");
    if (entries.has(applicationName) && entries.get(applicationName)?.kind !== "directory") {
      throw new Error("The update application root must be a directory.");
    }
    const present = new Set(entries.keys());
    const directories = new Set<string>();
    for (const entry of entries.values()) {
      if (entry.kind === "directory") directories.add(entry.path);
      let parent = posix.dirname(entry.path);
      while (parent !== ".") {
        const owner = entries.get(parent);
        if (owner !== undefined && owner.kind !== "directory")
          throw new Error("The update ZIP writes through a non-directory.");
        directories.add(parent);
        present.add(parent);
        parent = posix.dirname(parent);
      }
    }
    for (const entry of entries.values()) {
      if (entry.kind === "symlink") resolveLink(entry, entries, present, applicationName);
    }
    for (const name of metadata) {
      const relative = name.slice("__MACOSX/".length);
      const base = posix.basename(relative);
      const target = posix.join(posix.dirname(relative), base.slice(2));
      if (
        !base.startsWith("._") ||
        (target !== applicationName && !target.startsWith(`${applicationName}/`)) ||
        !present.has(target)
      ) {
        throw new Error("The update ZIP contains resource metadata outside its application.");
      }
    }
    let extracted: LinxUpdateExtractedArchive | undefined;
    if (destinationPath !== undefined) {
      const destination = join(
        await fs.realpath(dirname(destinationPath)),
        posix.basename(destinationPath),
      );
      if (destination !== destinationPath)
        throw new Error("The extraction directory must be canonical.");
      await fs.mkdir(destination, { mode: 0o700 });
      createdDestination = true;
      const records: LinxUpdateBundleRecord[] = [];
      const relativeName = (name: string) => name.slice(applicationName!.length + 1);
      const orderedDirectories = [...directories].sort((a, b) => a.length - b.length);
      for (const directory of orderedDirectories) {
        await fs.mkdir(join(destination, directory), { mode: 0o700 });
        records.push(["directory", relativeName(directory), entries.get(directory)?.mode ?? 0o755]);
      }
      for (const entry of entries.values()) {
        if (entry.kind === "file") {
          const hash = createHash("sha256");
          await readArchiveEntry(
            zip,
            sourceEntries.get(entry.path)!,
            join(destination, entry.path),
            entry.mode,
            hash,
          );
          records.push([
            "file",
            relativeName(entry.path),
            entry.mode,
            entry.size,
            hash.digest("hex"),
          ]);
        }
      }
      const resourceMetadata: { filePath: string; targetPath: string }[] = [];
      if (metadata.length > 0)
        await fs.mkdir(join(destination, ".resource-metadata"), { mode: 0o700 });
      for (const [index, name] of metadata.entries()) {
        const relative = name.slice("__MACOSX/".length);
        const target = posix.join(posix.dirname(relative), posix.basename(relative).slice(2));
        const filePath = join(destination, ".resource-metadata", `${index}.appledouble`);
        await readArchiveEntry(zip, sourceEntries.get(name)!, filePath, 0o600);
        resourceMetadata.push({ filePath, targetPath: join(destination, target) });
      }
      for (const entry of entries.values()) {
        if (entry.kind === "symlink") {
          const linkPath = join(destination, entry.path);
          await fs.symlink(entry.linkTarget!, linkPath);
          if (process.platform === "darwin") await fs.lchmod(linkPath, entry.mode);
          records.push([
            "link",
            relativeName(entry.path),
            process.platform === "darwin" ? entry.mode : 0o777,
            entry.linkTarget!,
          ]);
        }
      }
      for (const directory of orderedDirectories.reverse()) {
        await fs.chmod(join(destination, directory), entries.get(directory)?.mode ?? 0o755);
      }
      extracted = {
        applicationName,
        expandedBytes,
        entries: [...entries.values()],
        applicationPath: join(destination, applicationName),
        contentDigest: hashLinxUpdateBundleInventory(records),
        resourceMetadata,
      };
    }
    const after = await handle.stat();
    const current = await fs.lstat(filePath);
    if (
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs ||
      current.ino !== before.ino ||
      current.dev !== before.dev
    ) {
      throw new Error("The update ZIP changed during inspection.");
    }
    return extracted ?? { applicationName, expandedBytes, entries: [...entries.values()] };
  } catch (error) {
    if (createdDestination && destinationPath !== undefined)
      await fs.rm(destinationPath, { recursive: true, force: true });
    throw error;
  } finally {
    zip.close();
    await handle.close();
  }
}

/** Read-only policy inspection; extraction also verifies streamed content lengths and CRC. */
export function inspectLinxUpdateArchive(filePath: string): Promise<LinxUpdateArchive> {
  return readArchive(filePath);
}

/** Writes only a new private directory; framework links appear after every bounded file write. */
export function extractLinxUpdateArchive(
  filePath: string,
  destinationPath: string,
  authentication?: ArchiveAuthentication,
): Promise<LinxUpdateExtractedArchive> {
  return readArchive(filePath, destinationPath, authentication);
}
