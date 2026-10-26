import { crc32, deflateRawSync } from "node:zlib";

/** Small standards-based ZIP fixture; attacker cases alter metadata independently. */
export function skillZip(
  files: ReadonlyArray<{ name: string; content: Buffer | string; mode?: number }>,
): Buffer {
  const local: Buffer[] = [],
    central: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name),
      bytes = Buffer.isBuffer(file.content) ? file.content : Buffer.from(file.content),
      compressed = deflateRawSync(bytes),
      crc = crc32(bytes);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x800, 6);
    header.writeUInt16LE(8, 8);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(compressed.length, 18);
    header.writeUInt32LE(bytes.length, 22);
    header.writeUInt16LE(name.length, 26);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50);
    directory.writeUInt16LE(0x0314, 4);
    directory.writeUInt16LE(20, 6);
    directory.writeUInt16LE(0x800, 8);
    directory.writeUInt16LE(8, 10);
    directory.writeUInt32LE(crc, 16);
    directory.writeUInt32LE(compressed.length, 20);
    directory.writeUInt32LE(bytes.length, 24);
    directory.writeUInt16LE(name.length, 28);
    directory.writeUInt32LE(((file.mode ?? 0o100644) << 16) >>> 0, 38);
    directory.writeUInt32LE(offset, 42);
    local.push(header, name, compressed);
    central.push(directory, name);
    offset += header.length + name.length + compressed.length;
  }
  const end = Buffer.alloc(22),
    directories = Buffer.concat(central);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directories.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directories, end]);
}
