import { chmod, lstat, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createExpertMcpBindingStore } from "./ExpertMcpBindingStore.ts";

const temporaryRoots: string[] = [];

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "synara-expert-mcp-binding-"));
  temporaryRoots.push(root);
  return root;
}

async function makeWritableTree(target: string): Promise<void> {
  const stat = await lstat(target).catch(() => null);
  if (!stat || stat.isSymbolicLink()) return;
  await chmod(target, stat.isDirectory() ? 0o700 : 0o600).catch(() => undefined);
  if (!stat.isDirectory()) return;
  for (const entry of await readdir(target)) {
    await makeWritableTree(path.join(target, entry));
  }
}

afterEach(async () => {
  for (const root of temporaryRoots.splice(0)) {
    await makeWritableTree(root);
    await rm(root, { recursive: true, force: true });
  }
});

const snapshotId = "exp_" + "b".repeat(64);
const binding = {
  schemaVersion: 1 as const,
  source: "legacy-current" as const,
  createdAt: "2026-10-04T00:00:00.000Z",
  servers: [
    {
      id: "mcp-one",
      configRevision: 3,
      required: true,
      tools: ["read"],
    },
  ],
};

describe("ExpertMcpBindingStore", () => {
  it("captures legacy bindings once across store instances and keeps them immutable", async () => {
    const stateDir = path.join(await makeTempRoot(), "state");
    const firstStore = createExpertMcpBindingStore(stateDir);
    const secondStore = createExpertMcpBindingStore(stateDir);
    const capture = vi.fn(async () => binding);

    const [first, second] = await Promise.all([
      firstStore.get(snapshotId, capture),
      secondStore.get(snapshotId, capture),
    ]);
    expect(first).toEqual(binding);
    expect(second).toEqual(binding);
    expect(capture).toHaveBeenCalledTimes(1);
    expect(await firstStore.read(snapshotId)).toEqual(binding);
    expect(await secondStore.createOnce(snapshotId, binding)).toEqual(binding);
    await expect(
      secondStore.createOnce(snapshotId, {
        ...binding,
        servers: [{ ...binding.servers[0]!, configRevision: 4 }],
      }),
    ).rejects.toMatchObject({ code: "revision_conflict" });
  });

  it("rejects symlinked sidecar directories and files", async () => {
    const root = await makeTempRoot();
    const directoryState = path.join(root, "directory-state");
    const directoryStore = createExpertMcpBindingStore(directoryState);
    const bindingsDir = path.join(directoryState, "expert-mcp-bindings");
    const outsideDir = path.join(root, "outside-bindings");
    await rm(bindingsDir, { recursive: true, force: true });
    await import("node:fs/promises").then(({ mkdir }) => mkdir(outsideDir));
    await symlink(outsideDir, bindingsDir);
    await expect(directoryStore.read(snapshotId)).rejects.toMatchObject({ code: "corrupt" });

    const fileState = path.join(root, "file-state");
    const fileStore = createExpertMcpBindingStore(fileState);
    await fileStore.createOnce(snapshotId, binding);
    const filePath = path.join(fileState, "expert-mcp-bindings", snapshotId + ".json");
    const externalFile = path.join(root, "external-binding.json");
    await writeFile(externalFile, JSON.stringify(binding));
    await rm(filePath);
    await symlink(externalFile, filePath);
    await expect(fileStore.read(snapshotId)).rejects.toMatchObject({ code: "corrupt" });
  });
});
