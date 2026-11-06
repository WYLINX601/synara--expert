import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import type { AmbientResourceReference } from "@synara/contracts";
import { DesktopAmbientContext } from "./DesktopAmbientContext";

it("persists only policy, rotates session pairing and refuses changes after shutdown", async () => {
  const directory = await mkdtemp(join(tmpdir(), "synara-ambient-test-"));
  const path = join(directory, "settings.json");
  const first = new DesktopAmbientContext(path, () => {});
  let second: DesktopAmbientContext | undefined;
  try {
    expect((await first.getState()).sources[0]?.policy.enabled).toBe(false);
    const policy = { enabled: true, allowedTypes: ["selection.text"] as const };
    await first.configure("obsidian", policy);
    const initial = await first.pairing("obsidian");
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(policy);
    expect((await first.getState()).sources[0]?.connected).toBe(false);
    await first.stop();
    await expect(first.configure("obsidian", policy)).rejects.toThrow("stopped");
    second = new DesktopAmbientContext(path, () => {});
    expect((await second.getState()).sources[0]?.policy).toEqual(policy);
    expect((await second.pairing("obsidian")).token).not.toBe(initial.token);
    expect((await second.capture()).items).toEqual([]);
  } finally {
    await first.stop();
    await second?.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

it("discards a resource search whose policy was revoked before it completed", async () => {
  const directory = await mkdtemp(join(tmpdir(), "synara-ambient-search-test-"));
  const context = new DesktopAmbientContext(join(directory, "settings.json"), () => {});
  try {
    await context.configure("obsidian", { enabled: true, allowedTypes: ["resource.identity"] });
    let finish!: (resources: readonly AmbientResourceReference[]) => void;
    const search = vi.spyOn(context.obsidian, "searchResources").mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const pending = context.searchResources("note");
    await expect.poll(() => search.mock.calls.length).toBe(1);
    const revoke = context.configure("obsidian", { enabled: false, allowedTypes: [] });
    finish([{ sourceId: "obsidian", targetKey: "note", uri: "file:///note.md", title: "note" }]);
    expect(await pending).toEqual([]);
    await revoke;
    expect(await context.searchResources("note")).toEqual([]);
    expect(search).toHaveBeenCalledTimes(1);
  } finally {
    await context.stop();
    await rm(directory, { recursive: true, force: true });
  }
});
