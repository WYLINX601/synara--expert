import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { validateLinxMachOMinimum } from "./linxUpdateHelperMachO";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});
function thin(minimum = 0x000d0000, cpu = 0x0100000c, platform = 1): Buffer {
  const bytes = Buffer.alloc(56);
  bytes.writeUInt32LE(0xfeedfacf, 0);
  bytes.writeUInt32LE(cpu, 4);
  bytes.writeUInt32LE(2, 12);
  bytes.writeUInt32LE(1, 16);
  bytes.writeUInt32LE(24, 20);
  bytes.writeUInt32LE(0x32, 32);
  bytes.writeUInt32LE(24, 36);
  bytes.writeUInt32LE(platform, 40);
  bytes.writeUInt32LE(minimum, 44);
  return bytes;
}
async function candidate(bytes: Buffer): Promise<string> {
  const root = await fs.mkdtemp(join(tmpdir(), "linx-macho-boundary-"));
  roots.push(root);
  const path = join(root, "native");
  await fs.writeFile(path, bytes);
  return path;
}
describe("bounded native arm64 and actual minimum macOS inspection", () => {
  it("accepts native macOS arm64 without executing it and ignores nonnative resources", async () => {
    await expect(
      validateLinxMachOMinimum(await candidate(thin()), "13.0", "14.4"),
    ).resolves.toBeUndefined();
    await expect(
      validateLinxMachOMinimum(await candidate(Buffer.from("resource contents")), "13.0", "14.4"),
    ).resolves.toBeUndefined();
  });
  it("refuses both understated signed requirements and a system older than actual native requirements", async () => {
    const path = await candidate(thin(0x000e0401));
    await expect(validateLinxMachOMinimum(path, "13.0", "15.0")).rejects.toThrow("signed minimum");
    await expect(validateLinxMachOMinimum(path, "14.4.1", "14.4")).rejects.toThrow("this system");
  });
  it("refuses x64-only and non-macOS arm64 binaries", async () => {
    await expect(
      validateLinxMachOMinimum(await candidate(thin(0x000d0000, 0x01000007)), "13.0", "14.4"),
    ).rejects.toThrow("arm64");
    await expect(
      validateLinxMachOMinimum(await candidate(thin(0x000d0000, 0x0100000c, 2)), "13.0", "14.4"),
    ).rejects.toThrow("macOS build");
  });
  it("selects the bounded arm64 slice from a universal application", async () => {
    const x64 = thin(0x000d0000, 0x01000007),
      arm64 = thin();
    const bytes = Buffer.alloc(48 + x64.length + arm64.length);
    bytes.writeUInt32BE(0xcafebabe, 0);
    bytes.writeUInt32BE(2, 4);
    bytes.writeUInt32BE(0x01000007, 8);
    bytes.writeUInt32BE(48, 16);
    bytes.writeUInt32BE(x64.length, 20);
    bytes.writeUInt32BE(0x0100000c, 28);
    bytes.writeUInt32BE(48 + x64.length, 36);
    bytes.writeUInt32BE(arm64.length, 40);
    x64.copy(bytes, 48);
    arm64.copy(bytes, 48 + x64.length);
    await expect(
      validateLinxMachOMinimum(await candidate(bytes), "13.0", "14.4"),
    ).resolves.toBeUndefined();
    bytes.writeUInt32BE(0xfffffff0, 36);
    await expect(validateLinxMachOMinimum(await candidate(bytes), "13.0", "14.4")).rejects.toThrow(
      "slice bounds",
    );
  });
  it("refuses hostile architecture counts, load-command allocations and missing minimum proofs", async () => {
    const fat = Buffer.alloc(8);
    fat.writeUInt32BE(0xcafebabe, 0);
    fat.writeUInt32BE(0xffffffff, 4);
    await expect(validateLinxMachOMinimum(await candidate(fat), "13.0", "14.4")).rejects.toThrow(
      "architecture count",
    );
    const huge = thin();
    huge.writeUInt32LE(0xffffffff, 20);
    await expect(validateLinxMachOMinimum(await candidate(huge), "13.0", "14.4")).rejects.toThrow(
      "load-command bounds",
    );
    const unknown = thin();
    unknown.writeUInt32LE(0x1b, 32);
    await expect(
      validateLinxMachOMinimum(await candidate(unknown), "13.0", "14.4"),
    ).rejects.toThrow("minimum-version proof");
  });
  it("does not follow a substituted native symlink", async () => {
    const target = await candidate(thin());
    const link = `${target}-link`;
    await fs.symlink(target, link);
    await expect(validateLinxMachOMinimum(link, "13.0", "14.4")).rejects.toThrow();
  });
});
