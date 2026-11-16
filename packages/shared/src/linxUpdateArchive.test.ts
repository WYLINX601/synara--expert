import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32, deflateRawSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { extractLinxUpdateArchive, inspectLinxUpdateArchive } from "./linxUpdateArchive";

vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof fs>()),
}));

interface ZipEntry {
  path: string;
  data?: string;
  mode?: number;
  localPath?: string;
  declaredSize?: number;
  crc?: number;
  utf8Flag?: boolean;
}

function zip(entries: readonly ZipEntry[]): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.path);
    const localName = Buffer.from(entry.localPath ?? entry.path);
    const data = Buffer.from(entry.data ?? "");
    const compressed = deflateRawSync(data);
    const checksum = entry.crc ?? crc32(data);
    const size = entry.declaredSize ?? data.length;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(entry.utf8Flag === false ? 0 : 0x800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(localName.length, 26);
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(0x314, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(entry.utf8Flag === false ? 0 : 0x800, 8);
    header.writeUInt16LE(8, 10);
    header.writeUInt32LE(checksum, 16);
    header.writeUInt32LE(compressed.length, 20);
    header.writeUInt32LE(size, 24);
    header.writeUInt16LE(name.length, 28);
    header.writeUInt32LE(
      ((entry.mode ?? (entry.path.endsWith("/") ? 0o40755 : 0o100644)) << 16) >>> 0,
      38,
    );
    header.writeUInt32LE(offset, 42);
    locals.push(local, localName, compressed);
    central.push(header, name);
    offset += local.length + localName.length + compressed.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

let root: string;
let archive: string;
let destination: string;
beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "linx-archive-")));
  archive = join(root, "update.zip");
  destination = join(root, "candidate");
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("bounded Linx archive extraction", () => {
  it("preserves UTF-8 names from native ditto ZIPs without a language flag", async () => {
    await fs.writeFile(
      archive,
      zip([{ path: "Linx.app/café.txt", data: "native bytes", utf8Flag: false }]),
    );
    const result = await extractLinxUpdateArchive(archive, destination);
    expect(await fs.readFile(join(result.applicationPath, "café.txt"), "utf8")).toBe(
      "native bytes",
    );
  });
  it("rejects different authenticated ZIP bytes before creating any output", async () => {
    const original = zip([{ path: "Linx.app/payload", data: "A" }]);
    const replacement = zip([{ path: "Linx.app/payload", data: "B" }]);
    expect(replacement.length).toBe(original.length);
    await fs.writeFile(archive, replacement);
    await expect(
      extractLinxUpdateArchive(archive, destination, {
        size: original.length,
        sha256: createHash("sha256").update(original).digest("hex"),
      }),
    ).rejects.toThrow("digest differs");
    await expect(fs.lstat(destination)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("derives expected content from archive streams rather than writable output", async () => {
    const original = zip([{ path: "Linx.app/payload", data: "trusted" }]);
    await fs.writeFile(archive, original);
    const authentication = {
      size: original.length,
      sha256: createHash("sha256").update(original).digest("hex"),
    };
    const baseline = await extractLinxUpdateArchive(archive, destination, authentication);
    const attacked = join(root, "attacked");
    const chmod = fs.chmod;
    const spy = vi.spyOn(fs, "chmod").mockImplementation(async (path, mode) => {
      if (path === join(attacked, "Linx.app"))
        await fs.writeFile(join(path, "payload"), "replacement");
      await chmod(path, mode);
    });
    try {
      const result = await extractLinxUpdateArchive(archive, attacked, authentication);
      expect(await fs.readFile(join(result.applicationPath, "payload"), "utf8")).toBe(
        "replacement",
      );
      expect(result.contentDigest).toBe(baseline.contentDigest);
    } finally {
      spy.mockRestore();
    }
    const replacement = zip([{ path: "Linx.app/payload", data: "replacement" }]);
    await fs.writeFile(archive, replacement);
    const changed = await extractLinxUpdateArchive(archive, join(root, "changed"), {
      size: replacement.length,
      sha256: createHash("sha256").update(replacement).digest("hex"),
    });
    expect(changed.contentDigest).not.toBe(baseline.contentDigest);
  });

  it("preserves actual framework link graph and executable contents", async () => {
    await fs.writeFile(
      archive,
      zip([
        {
          path: "Linx.app/Contents/Frameworks/Test.framework/Versions/A/Test",
          data: "signed native bytes",
          mode: 0o100755,
        },
        {
          path: "Linx.app/Contents/Frameworks/Test.framework/Versions/Current",
          data: "A",
          mode: 0o120777,
        },
        {
          path: "Linx.app/Contents/Frameworks/Test.framework/Test",
          data: "Versions/Current/Test",
          mode: 0o120777,
        },
      ]),
    );
    const result = await extractLinxUpdateArchive(archive, destination);
    const executable = join(result.applicationPath, "Contents/Frameworks/Test.framework/Test");
    expect(await fs.readFile(executable, "utf8")).toBe("signed native bytes");
    expect(await fs.readlink(executable)).toBe("Versions/Current/Test");
    expect((await fs.stat(executable)).mode & 0o777).toBe(0o755);
  });

  it.each([
    "../escape",
    "/absolute",
    "Linx.app/../escape",
    "Linx.app/./file",
    "Linx.app/a\\file",
    "Linx.app/a:file",
    "Linx.app//file",
    "Linx.app/..namedfork/rsrc",
  ])("rejects unsafe path %s before creating output", async (path) => {
    await fs.writeFile(archive, zip([{ path, data: "unsafe" }]));
    await expect(extractLinxUpdateArchive(archive, destination)).rejects.toThrow();
    await expect(fs.stat(destination)).rejects.toThrow();
    await expect(fs.stat(join(root, "escape"))).rejects.toThrow();
  });

  it.each([
    [{ path: "Linx.app/file" }, { path: "Linx.app/FILE" }],
    [{ path: "Linx.app/link", data: "/outside", mode: 0o120777 }],
    [{ path: "Linx.app/link", data: "../../outside", mode: 0o120777 }],
    [
      { path: "Linx.app/a", data: "b", mode: 0o120777 },
      { path: "Linx.app/b", data: "a", mode: 0o120777 },
    ],
    [{ path: "Linx.app/pipe", mode: 0o10644 }],
    [{ path: "Linx.app/setuid", data: "binary", mode: 0o104755 }],
    [{ path: "Linx.app/file" }, { path: "Other.app/file" }],
  ])("refuses ambiguous, cyclic, special or multi-app payload %#", async (...entries) => {
    await fs.writeFile(archive, zip(entries as ZipEntry[]));
    await expect(inspectLinxUpdateArchive(archive)).rejects.toThrow();
  });

  it("rejects lexical-inside links that escape after resolving another link", async () => {
    await fs.writeFile(
      archive,
      zip([
        { path: "Linx.app/root", data: ".", mode: 0o120777 },
        { path: "Linx.app/deep/trick", data: "../root/../outside", mode: 0o120777 },
        { path: "Linx.app/outside", data: "inside" },
      ]),
    );
    await expect(extractLinxUpdateArchive(archive, destination)).rejects.toThrow();
    await expect(fs.stat(destination)).rejects.toThrow();
  });

  it("rejects central/local name disagreement before extraction", async () => {
    await fs.writeFile(
      archive,
      zip([{ path: "Linx.app/safe", localPath: "../outside", data: "payload" }]),
    );
    await expect(extractLinxUpdateArchive(archive, destination)).rejects.toThrow();
    await expect(fs.stat(destination)).rejects.toThrow();
  });

  it.each([{ declaredSize: 1 }, { crc: 1 }])(
    "discards partial output for invalid actual bytes %#",
    async (override) => {
      await fs.writeFile(
        archive,
        zip([{ path: "Linx.app/payload", data: "long real payload", ...override }]),
      );
      await expect(extractLinxUpdateArchive(archive, destination)).rejects.toThrow();
      await expect(fs.stat(destination)).rejects.toThrow();
    },
  );

  it("never replaces an existing extraction destination", async () => {
    await fs.writeFile(archive, zip([{ path: "Linx.app/payload", data: "new" }]));
    await fs.mkdir(destination);
    await fs.writeFile(join(destination, "unique"), "keep");
    await expect(extractLinxUpdateArchive(archive, destination)).rejects.toThrow();
    expect(await fs.readFile(join(destination, "unique"), "utf8")).toBe("keep");
  });

  it("keeps AppleDouble private and binds its target to actual payload", async () => {
    await fs.writeFile(
      archive,
      zip([
        { path: "Linx.app/Contents/data", data: "data" },
        { path: "__MACOSX/Linx.app/Contents/._data", data: "opaque AppleDouble bytes" },
      ]),
    );
    const result = await extractLinxUpdateArchive(archive, destination);
    expect(result.resourceMetadata[0]?.targetPath).toBe(
      join(result.applicationPath, "Contents/data"),
    );
    expect(await fs.readFile(result.resourceMetadata[0]!.filePath, "utf8")).toBe(
      "opaque AppleDouble bytes",
    );
    await expect(fs.stat(join(destination, "__MACOSX"))).rejects.toThrow();
  });
});
