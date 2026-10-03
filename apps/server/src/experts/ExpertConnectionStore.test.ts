import { chmod, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import type { ExpertConnectionSaveInput } from "@synara/contracts";
import { afterEach, describe, expect, it } from "vitest";

import { createExpertConnectionStore } from "./ExpertConnectionStore.ts";

const temporaryRoots: string[] = [];

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "synara-expert-connection-"));
  temporaryRoots.push(root);
  return root;
}

afterEach(async () => {
  for (const root of temporaryRoots.splice(0)) {
    await chmod(root, 0o700).catch(() => undefined);
    for (const directory of await readdir(root).catch(() => [])) {
      const target = path.join(root, directory);
      await chmod(target, 0o700).catch(() => undefined);
      for (const file of await readdir(target).catch(() => [])) {
        await chmod(path.join(target, file), 0o600).catch(() => undefined);
      }
    }
    await rm(root, { recursive: true, force: true });
  }
});

function stdioInput(
  id: string,
  extra: Partial<ExpertConnectionSaveInput> = {},
): ExpertConnectionSaveInput {
  return {
    id,
    name: "Local tools",
    transport: { type: "stdio", command: "node", args: [], envFromHost: [] },
    ...extra,
  };
}

describe("ExpertConnectionStore", () => {
  it("saves and reads configs with revision checks", async () => {
    const store = createExpertConnectionStore(path.join(await makeTempRoot(), "state"));
    const created = await store.save(stdioInput("local-tools"));
    expect(created).toMatchObject({ id: "local-tools", revision: 1 });
    expect((await store.read(created.id))?.transport).toEqual({
      type: "stdio",
      command: "node",
      args: [],
      envFromHost: [],
    });
    expect((await store.list()).map(({ id }) => id)).toEqual(["local-tools"]);

    const updates = await Promise.allSettled([
      store.save(stdioInput("local-tools", { name: "First", expectedRevision: 1 })),
      store.save(stdioInput("local-tools", { name: "Second", expectedRevision: 1 })),
    ]);
    expect(updates.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(updates.filter(({ status }) => status === "rejected")).toHaveLength(1);
    expect(updates.find(({ status }) => status === "rejected")).toMatchObject({
      reason: { code: "revision_conflict" },
    });
    expect((await store.read(created.id))?.revision).toBe(2);
    await store.remove(created.id, 2);
    expect(await store.read(created.id)).toBeNull();
  });

  it("rejects plaintext credentials and unexpected secret fields", async () => {
    const store = createExpertConnectionStore(path.join(await makeTempRoot(), "state"));
    await expect(
      store.save(
        stdioInput("plain-arg", {
          transport: {
            type: "stdio",
            command: "node",
            args: ["--token", "plain-secret"],
            envFromHost: [],
          },
        }),
      ),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      store.save({
        ...stdioInput("plain-header"),
        transport: {
          type: "http",
          url: "https://tools.example/mcp",
          headersFromHost: [],
          headers: { Authorization: "Bearer plain-secret" },
        },
      } as never),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      store.save({
        id: "plain-url",
        name: "Plain URL",
        transport: {
          type: "http",
          url: "https://tools.example/mcp?access_token=plain-secret",
          headersFromHost: [],
        },
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      store.save({
        id: "query-url",
        name: "Query URL",
        transport: {
          type: "http",
          url: "https://tools.example/mcp?region=local",
          headersFromHost: [],
        },
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(await store.list()).toEqual([]);
  });

  it("rejects unsafe IDs and oversized inputs", async () => {
    const store = createExpertConnectionStore(path.join(await makeTempRoot(), "state"));
    await expect(store.read("../outside")).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      store.save(
        stdioInput("too-large", {
          transport: {
            type: "stdio",
            command: "node",
            args: Array.from({ length: 10 }, () => "x".repeat(8_000)),
            envFromHost: [],
          },
        }),
      ),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });
});
