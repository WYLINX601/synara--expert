import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import { linxOSAtLeast } from "./linxUpdateHelperFiles";

const ARM64 = 0x0100000c;
const MAX_LOAD_COMMAND_BYTES = 16 * 1024 * 1024;
const MAGICS: Readonly<Record<string, true>> = {
  feedface: true,
  feedfacf: true,
  cefaedfe: true,
  cffaedfe: true,
  cafebabe: true,
  bebafeca: true,
  cafebabf: true,
  bfbafeca: true,
};
const versionString = (packed: number) =>
  `${packed >>> 16}.${(packed >>> 8) & 255}.${packed & 255}`;

/** Inspect only bounded headers; never execute candidate code to discover its requirements. */
export async function validateLinxMachOMinimum(
  path: string,
  signedMinimum: string,
  actualVersion: string,
): Promise<void> {
  const handle = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error("Native candidate is not a regular file");
    const read = async (offset: number, length: number): Promise<Buffer> => {
      if (!Number.isSafeInteger(offset) || offset < 0 || length < 0 || offset + length > stat.size)
        throw new Error("Truncated Mach-O header");
      const bytes = Buffer.alloc(length);
      if ((await handle.read(bytes, 0, length, offset)).bytesRead !== length)
        throw new Error("Truncated Mach-O header");
      return bytes;
    };
    if (stat.size < 4) return;
    const magic = (await read(0, 4)).toString("hex");
    if (!MAGICS[magic]) return;
    let offset = 0,
      sliceSize = stat.size;
    if (["cafebabe", "bebafeca", "cafebabf", "bfbafeca"].includes(magic)) {
      const little = magic === "bebafeca" || magic === "bfbafeca";
      const fat64 = magic === "cafebabf" || magic === "bfbafeca";
      const word = (bytes: Buffer, index: number) =>
        little ? bytes.readUInt32LE(index) : bytes.readUInt32BE(index);
      const count = word(await read(0, 8), 4);
      if (count < 1 || count > 32) throw new Error("Invalid universal Mach-O architecture count");
      const stride = fat64 ? 32 : 20;
      const table = await read(8, count * stride);
      let found = false;
      for (let index = 0; index < count; index++) {
        const base = index * stride;
        if (word(table, base) !== ARM64 || (word(table, base + 4) & 0x00ffffff) !== 0) continue;
        if (found) throw new Error("Duplicate arm64 Mach-O slice");
        found = true;
        offset = fat64
          ? Number(little ? table.readBigUInt64LE(base + 8) : table.readBigUInt64BE(base + 8))
          : word(table, base + 8);
        sliceSize = fat64
          ? Number(little ? table.readBigUInt64LE(base + 16) : table.readBigUInt64BE(base + 16))
          : word(table, base + 12);
        if (
          !Number.isSafeInteger(offset) ||
          !Number.isSafeInteger(sliceSize) ||
          offset < 8 + table.length ||
          sliceSize < 32 ||
          offset + sliceSize > stat.size
        )
          throw new Error("Invalid arm64 Mach-O slice bounds");
      }
      if (!found) throw new Error("Native candidate has no arm64 architecture");
    }
    const header = await read(offset, 32);
    if (
      header.toString("hex", 0, 4) !== "cffaedfe" ||
      header.readUInt32LE(4) !== ARM64 ||
      (header.readUInt32LE(8) & 0x00ffffff) !== 0
    )
      throw new Error("Native candidate has no supported arm64 Mach-O header");
    const count = header.readUInt32LE(16),
      size = header.readUInt32LE(20);
    if (size > MAX_LOAD_COMMAND_BYTES || size > sliceSize - 32 || count < 1 || count > size / 8)
      throw new Error("Invalid Mach-O load-command bounds");
    const commands = await read(offset + 32, size);
    let cursor = 0,
      minimum: number | null = null;
    for (let index = 0; index < count; index++) {
      if (cursor + 8 > commands.length) throw new Error("Truncated Mach-O load command");
      const command = commands.readUInt32LE(cursor),
        length = commands.readUInt32LE(cursor + 4);
      if (length < 8 || length % 8 !== 0 || cursor + length > commands.length)
        throw new Error("Invalid Mach-O load command");
      if (command === 0x32) {
        if (
          length < 24 ||
          commands.readUInt32LE(cursor + 8) !== 1 ||
          commands.readUInt32LE(cursor + 20) > (length - 24) / 8
        )
          throw new Error("Native candidate is not a valid macOS build");
        minimum = Math.max(minimum ?? 0, commands.readUInt32LE(cursor + 12));
      } else if (command === 0x24) {
        if (length !== 16) throw new Error("Invalid Mach-O minimum macOS command");
        minimum = Math.max(minimum ?? 0, commands.readUInt32LE(cursor + 8));
      }
      cursor += length;
    }
    if (cursor !== commands.length || minimum === null || minimum === 0)
      throw new Error("Native candidate has no bounded macOS minimum-version proof");
    const required = versionString(minimum);
    if (!linxOSAtLeast(signedMinimum, required) || !linxOSAtLeast(actualVersion, required))
      throw new Error(
        "Native candidate requires macOS newer than its signed minimum or this system",
      );
  } finally {
    await handle.close();
  }
}
