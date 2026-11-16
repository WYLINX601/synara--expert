import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  hasLinxUpdateClient,
  readLinxServerSourceCommit,
  registerLinxUpdateClient,
} from "./linxUpdateHealth";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("trusted native feature-socket health ledger", () => {
  it("requires the existing native authentication and exact Linx origin, and removes disconnected clients", () => {
    expect(hasLinxUpdateClient()).toBe(false);
    const excluded = [
      registerLinxUpdateClient("unauthed", "linx://app", false),
      registerLinxUpdateClient("web", "http://127.0.0.1:3773", true),
      registerLinxUpdateClient("legacy", "synara://app", true),
      registerLinxUpdateClient("spoofed", "linx://app.evil", true),
      registerLinxUpdateClient("missing", undefined, true),
    ];
    expect(hasLinxUpdateClient()).toBe(false);
    const release = registerLinxUpdateClient("stable", "linx://app", true);
    const releasePreview = registerLinxUpdateClient("preview", "linx-preview://app", true);
    expect(hasLinxUpdateClient()).toBe(true);
    release();
    expect(hasLinxUpdateClient()).toBe(true);
    releasePreview();
    expect(hasLinxUpdateClient()).toBe(false);
    excluded.forEach((remove) => remove());
  });

  it("binds source SHA to the actual executing packaged-server metadata, not an env claim", async () => {
    const root = await fs.mkdtemp(join(tmpdir(), "linx-server-source-"));
    roots.push(root);
    const entry = join(root, "apps/server/dist/index.mjs");
    await fs.mkdir(join(root, "apps/server/dist"), { recursive: true });
    const metadata = join(root, "package.json");
    await fs.writeFile(metadata, JSON.stringify({ synaraCommitHash: "a".repeat(40) }));
    expect(await readLinxServerSourceCommit(entry)).toBe("a".repeat(40));
    expect(await readLinxServerSourceCommit(join(root, "other.mjs"))).toBeNull();
    await fs.writeFile(metadata, JSON.stringify({ synaraCommitHash: "a".repeat(12) }));
    expect(await readLinxServerSourceCommit(entry)).toBeNull();
    await fs.writeFile(metadata, "null");
    expect(await readLinxServerSourceCommit(entry)).toBeNull();
    await fs.writeFile(metadata, "invalid");
    expect(await readLinxServerSourceCommit(entry)).toBeNull();
    await fs.writeFile(metadata, Buffer.alloc(1024 * 1024 + 1));
    expect(await readLinxServerSourceCommit(entry)).toBeNull();
    await fs.rm(metadata);
    expect(await readLinxServerSourceCommit(entry)).toBeNull();
    const external = join(root, "external.json");
    await fs.writeFile(external, JSON.stringify({ synaraCommitHash: "a".repeat(40) }));
    await fs.symlink(external, metadata);
    expect(await readLinxServerSourceCommit(entry)).toBeNull();
  });
});
