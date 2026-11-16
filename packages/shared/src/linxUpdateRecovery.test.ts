import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LINX_UPDATE_RECOVERY_MANIFEST_FILE_NAME } from "@synara/contracts";
import {
  createLinxUpdateRecoverySet,
  restoreLinxUpdateRecoverySetToEmptyTargets,
  verifyLinxUpdateRecoverySet,
} from "./linxUpdateRecovery";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  return { ...actual, open: vi.fn(actual.open), statfs: vi.fn(actual.statfs) };
});
const actualFs = await vi.importActual<typeof fs>("node:fs/promises");

const temporary: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.mocked(fs.open).mockReset();
  vi.mocked(fs.statfs).mockReset();
  await Promise.all(
    temporary.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "linx-recovery-test-"));
  temporary.push(root);
  const homePath = path.join(root, "home");
  const userDataPath = path.join(root, "profile");
  await fs.mkdir(path.join(homePath, "userdata", "secrets"), { recursive: true, mode: 0o700 });
  await fs.mkdir(userDataPath, { mode: 0o700 });
  await fs.writeFile(path.join(homePath, "userdata", "state.sqlite"), "database-and-ledger");
  await fs.writeFile(path.join(homePath, "userdata", "state.sqlite-wal"), "unique-wal");
  await fs.writeFile(path.join(homePath, "userdata", "secrets", "app.bin"), "private", {
    mode: 0o600,
  });
  await fs.mkdir(path.join(homePath, "worktrees", "draft"), { recursive: true });
  await fs.writeFile(
    path.join(homePath, "worktrees", "draft", "ignored.env"),
    "unique ignored worktree data",
  );
  await fs.mkdir(path.join(userDataPath, "IndexedDB"));
  await fs.writeFile(
    path.join(userDataPath, "IndexedDB", "draft-blob"),
    Buffer.from([0, 1, 255, 19]),
  );
  const recoveryDirectoryPath = path.join(root, "recovery");
  return {
    root,
    homePath,
    userDataPath,
    recoveryDirectoryPath,
    attemptId: randomUUID(),
    sourceVersion: "0.1.15",
  };
}

describe("verified Linx recovery sets", () => {
  it.each([
    { sensitive: false, account: false },
    { sensitive: true, account: false },
    { sensitive: false, account: true },
    { sensitive: true, account: true },
  ])(
    "matches only the hydrated external Codex home ($sensitive, $account)",
    async ({ sensitive, account }) => {
      const input = await fixture();
      const external = path.join(input.root, "selected-codex");
      await fs.mkdir(external);
      await fs.writeFile(path.join(external, "auth.json"), "external-auth", { mode: 0o600 });
      const instanceId = account ? "work" : "codex";
      const segment = `work-${createHash("sha256").update("work\0").update(external).update("\0").digest("hex").slice(0, 12)}`;
      const relativeOverlay = account
        ? `codex-home-overlay/accounts/${segment}`
        : "codex-home-overlay";
      const overlay = path.join(input.homePath, relativeOverlay);
      await fs.mkdir(overlay, { recursive: true });
      const alias = account ? "history.jsonl" : "auth.json";
      if (account) await fs.writeFile(path.join(external, alias), "shared-history");
      await fs.symlink(path.join(external, alias), path.join(overlay, alias));
      await fs.writeFile(path.join(overlay, "config.toml"), "unique-generated-config");
      const settings = JSON.stringify({
        revision: 23,
        migrationVersion: 3,
        settings: {
          providerInstances: {
            [instanceId]: {
              driver: "codex",
              environment: [
                {
                  name: "CODEX_HOME",
                  value: sensitive ? "" : external,
                  sensitive,
                  ...(sensitive ? { valueRedacted: true } : {}),
                },
              ],
            },
          },
        },
      });
      const settingsPath = path.join(input.homePath, "userdata", "settings.json");
      await fs.writeFile(settingsPath, settings, { mode: 0o600 });
      const secretPath = path.join(
        input.homePath,
        "userdata",
        "secrets",
        account
          ? "provider-env-d29yaw-Q09ERVhfSE9NRQ.bin"
          : "provider-env-Y29kZXg-Q09ERVhfSE9NRQ.bin",
      );
      if (sensitive) await fs.writeFile(secretPath, external, { mode: 0o600 });
      const settingsBefore = await fs.stat(settingsPath);
      const secretBefore = sensitive ? await fs.stat(secretPath) : undefined;
      const manifest = await createLinxUpdateRecoverySet(input);
      expect(manifest.entries.some((entry) => entry.path === `${relativeOverlay}/${alias}`)).toBe(
        false,
      );
      expect(JSON.stringify(manifest)).not.toContain(external);
      await restoreLinxUpdateRecoverySetToEmptyTargets({
        ...input,
        homePath: path.join(input.root, "restored-home"),
        userDataPath: path.join(input.root, "restored-profile"),
      });
      expect(
        await fs.readFile(
          path.join(input.root, "restored-home", relativeOverlay, "config.toml"),
          "utf8",
        ),
      ).toBe("unique-generated-config");
      expect(await fs.readFile(settingsPath, "utf8")).toBe(settings);
      expect((await fs.stat(settingsPath)).mtimeMs).toBe(settingsBefore.mtimeMs);
      if (sensitive) {
        expect(await fs.readFile(secretPath, "utf8")).toBe(external);
        expect(await fs.stat(secretPath)).toMatchObject({
          mode: secretBefore!.mode,
          mtimeMs: secretBefore!.mtimeMs,
          ctimeMs: secretBefore!.ctimeMs,
        });
        expect(
          await fs.readFile(
            path.join(
              input.root,
              "restored-home",
              "userdata",
              "secrets",
              path.basename(secretPath),
            ),
            "utf8",
          ),
        ).toBe(external);
      }
      expect(await fs.readFile(path.join(external, "auth.json"), "utf8")).toBe("external-auth");
      await fs.unlink(path.join(overlay, alias));
      const unrelated = path.join(input.root, "unrelated-auth");
      await fs.writeFile(unrelated, "never read");
      await fs.symlink(unrelated, path.join(overlay, alias));
      await expect(
        createLinxUpdateRecoverySet({
          ...input,
          recoveryDirectoryPath: path.join(input.root, "invalid-recovery"),
        }),
      ).rejects.toThrow("Escaping recovery link");
    },
  );
  it.each(["link", "directory-link", "oversize"])(
    "does not follow unsafe secret storage while resolving aliases (%s)",
    async (kind) => {
      const input = await fixture();
      const external = path.join(input.root, "external");
      await fs.mkdir(external);
      await fs.writeFile(path.join(external, "auth.json"), "external-auth");
      const overlay = path.join(input.homePath, "codex-home-overlay");
      await fs.mkdir(overlay);
      await fs.symlink(path.join(external, "auth.json"), path.join(overlay, "auth.json"));
      await fs.writeFile(
        path.join(input.homePath, "userdata", "settings.json"),
        JSON.stringify({
          providerInstances: {
            codex: {
              driver: "codex",
              environment: [
                { name: "CODEX_HOME", value: "", sensitive: true, valueRedacted: true },
              ],
            },
          },
        }),
      );
      const secrets = path.join(input.homePath, "userdata", "secrets");
      const name = "provider-env-Y29kZXg-Q09ERVhfSE9NRQ.bin";
      if (kind === "directory-link") {
        await fs.rm(secrets, { recursive: true });
        await fs.writeFile(path.join(external, name), external, { mode: 0o600 });
        await fs.symlink(external, secrets);
      } else if (kind === "link") {
        const target = path.join(input.root, "secret-target");
        await fs.writeFile(target, external, { mode: 0o600 });
        await fs.symlink(target, path.join(secrets, name));
      } else {
        const file = await fs.open(path.join(secrets, name), "wx", 0o600);
        await file.truncate(16 * 1024 * 1024 + 1);
        await file.close();
      }
      await expect(createLinxUpdateRecoverySet(input)).rejects.toThrow(/Secret|secret/u);
      expect(await fs.readFile(path.join(external, "auth.json"), "utf8")).toBe("external-auth");
    },
  );
  it.each(["", "fixed-expert-native", "account", "account-fixed"])(
    "omits regenerable external Codex aliases but retains unique overlay files (%s)",
    async (suffix) => {
      const input = await fixture();
      const external = path.join(input.root, "codex");
      const segment = `work-${createHash("sha256").update("work\0").update(external).update("\0").digest("hex").slice(0, 12)}`;
      const overlaySuffix = suffix.startsWith("account")
        ? `accounts/${segment}${suffix === "account-fixed" ? "/fixed-expert-native" : ""}`
        : suffix;
      const overlay = path.join(input.homePath, "codex-home-overlay", overlaySuffix);
      await fs.mkdir(external);
      await fs.mkdir(overlay, { recursive: true });
      await fs.writeFile(path.join(external, "auth.json"), "external-secret-never-copy");
      await fs.writeFile(path.join(external, "history.jsonl"), "external-history");
      await fs.writeFile(
        path.join(input.homePath, "userdata", "settings.json"),
        JSON.stringify({
          providers: {
            codex: { homePath: external, accounts: [{ id: "work", homePath: external }] },
          },
        }),
      );
      for (const name of ["auth.json", "history.jsonl"]) {
        await fs.symlink(path.join(external, name), path.join(overlay, name));
      }
      await fs.writeFile(path.join(overlay, "config.toml"), "model = 'keep-model'");
      await fs.writeFile(path.join(overlay, "unique.txt"), "unique overlay bytes");
      const manifest = await createLinxUpdateRecoverySet(input);
      expect(manifest.entries.some((entry) => entry.kind === "symlink")).toBe(false);
      await verifyLinxUpdateRecoverySet(input.recoveryDirectoryPath);
      const homePath = path.join(input.root, "restored-home");
      await restoreLinxUpdateRecoverySetToEmptyTargets({
        ...input,
        homePath,
        userDataPath: path.join(input.root, "restored-profile"),
      });
      const restored = path.join(homePath, "codex-home-overlay", overlaySuffix);
      expect(await fs.readFile(path.join(restored, "unique.txt"), "utf8")).toBe(
        "unique overlay bytes",
      );
      expect(await fs.readFile(path.join(restored, "config.toml"), "utf8")).toBe(
        "model = 'keep-model'",
      );
      await expect(fs.lstat(path.join(restored, "auth.json"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(await fs.readFile(path.join(external, "auth.json"), "utf8")).toBe(
        "external-secret-never-copy",
      );
    },
  );
  it("retains real private overlay files and does not decode unrelated settings during recovery", async () => {
    const input = await fixture();
    const overlay = path.join(input.homePath, "codex-home-overlay");
    await fs.mkdir(overlay);
    await fs.writeFile(path.join(overlay, "auth.json"), "unique private auth", { mode: 0o600 });
    await fs.writeFile(path.join(input.homePath, "userdata", "settings.json"), "{damaged settings");
    await createLinxUpdateRecoverySet(input);
    expect(
      await fs.readFile(
        path.join(input.recoveryDirectoryPath, "home", "codex-home-overlay", "auth.json"),
        "utf8",
      ),
    ).toBe("unique private auth");
    expect(
      await fs.readFile(
        path.join(input.recoveryDirectoryPath, "home", "userdata", "settings.json"),
        "utf8",
      ),
    ).toBe("{damaged settings");
  });
  it.each(["config.toml", "state.sqlite", "nested/auth.json"])(
    "does not exempt a non-generated alias even with a configured source (%s)",
    async (name) => {
      const input = await fixture();
      const source = path.join(input.root, "codex");
      await fs.mkdir(source);
      const link = path.join(input.homePath, "codex-home-overlay", name);
      await fs.mkdir(path.dirname(link), { recursive: true });
      await fs.writeFile(path.join(source, path.basename(name)), "external");
      await fs.writeFile(
        path.join(input.homePath, "userdata", "settings.json"),
        JSON.stringify({ providers: { codex: { homePath: source } } }),
      );
      await fs.symlink(path.join(source, path.basename(name)), link);
      await expect(createLinxUpdateRecoverySet(input)).rejects.toThrow("Escaping recovery link");
    },
  );
  it.each(["auth.json", "config.toml", "nested/auth.json"])(
    "rejects an unrecognized external overlay alias at %s",
    async (name) => {
      const input = await fixture();
      const link = path.join(input.homePath, "codex-home-overlay", name);
      await fs.mkdir(path.dirname(link), { recursive: true });
      const external = path.join(input.root, path.basename(name));
      await fs.writeFile(external, "unrelated external data");
      await fs.symlink(external, link);
      await expect(createLinxUpdateRecoverySet(input)).rejects.toThrow("Escaping recovery link");
    },
  );
  it("preserves secrets, WAL, IndexedDB and ignored worktree data with modes and contained links", async () => {
    const input = await fixture();
    await fs.symlink("state.sqlite", path.join(input.homePath, "userdata", "database-link"));
    await fs.mkdir(path.join(input.userDataPath, "Cache"));
    await fs.writeFile(path.join(input.userDataPath, "Cache", "reconstructable"), "cache");
    await fs.mkdir(path.join(input.homePath, "userdata", "state.sqlite.lifecycle-lock"));
    await fs.writeFile(
      path.join(input.homePath, "userdata", "state.sqlite.lifecycle-lock", "owner.json"),
      "runtime lock",
    );
    const manifest = await createLinxUpdateRecoverySet(input);
    expect(
      manifest.entries.some(
        (entry) => entry.path.includes("Cache") || entry.path.includes("lifecycle-lock"),
      ),
    ).toBe(false);
    expect(await verifyLinxUpdateRecoverySet(input.recoveryDirectoryPath)).toEqual(manifest);
    const homePath = path.join(input.root, "restored-home");
    const userDataPath = path.join(input.root, "restored-profile");
    await restoreLinxUpdateRecoverySetToEmptyTargets({ ...input, homePath, userDataPath });
    expect(await fs.readFile(path.join(homePath, "userdata", "state.sqlite-wal"), "utf8")).toBe(
      "unique-wal",
    );
    expect(await fs.readFile(path.join(homePath, "userdata", "database-link"), "utf8")).toBe(
      "database-and-ledger",
    );
    expect(await fs.readlink(path.join(homePath, "userdata", "database-link"))).toBe(
      "state.sqlite",
    );
    expect(
      (await fs.stat(path.join(homePath, "userdata", "secrets", "app.bin"))).mode & 0o777,
    ).toBe(0o600);
    expect(
      await fs.readFile(path.join(homePath, "worktrees", "draft", "ignored.env"), "utf8"),
    ).toBe("unique ignored worktree data");
    expect(await fs.readFile(path.join(userDataPath, "IndexedDB", "draft-blob"))).toEqual(
      Buffer.from([0, 1, 255, 19]),
    );
  });
  it.each(["home", "profile"])(
    "refuses a nonempty %s before modifying either target",
    async (target) => {
      const input = await fixture();
      await createLinxUpdateRecoverySet(input);
      const homePath = path.join(input.root, "new-home");
      const userDataPath = path.join(input.root, "new-profile");
      const populated = target === "home" ? homePath : userDataPath;
      await fs.mkdir(populated);
      await fs.writeFile(path.join(populated, "newer-data"), "never overwrite");
      await expect(
        restoreLinxUpdateRecoverySetToEmptyTargets({ ...input, homePath, userDataPath }),
      ).rejects.toThrow("not empty");
      expect(await fs.readFile(path.join(populated, "newer-data"), "utf8")).toBe("never overwrite");
      await expect(fs.stat(target === "home" ? userDataPath : homePath)).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
  );
  it("rejects replaying recovery creation and restoration into an already restored target", async () => {
    const input = await fixture();
    await createLinxUpdateRecoverySet(input);
    await expect(createLinxUpdateRecoverySet(input)).rejects.toThrow();
    const target = {
      ...input,
      homePath: path.join(input.root, "new-home"),
      userDataPath: path.join(input.root, "new-profile"),
    };
    await restoreLinxUpdateRecoverySetToEmptyTargets(target);
    await expect(restoreLinxUpdateRecoverySetToEmptyTargets(target)).rejects.toThrow("not empty");
  });
  it.each(["hash", "mode", "extra", "missing", "manifest"])(
    "rejects %s corruption before restoration",
    async (corruption) => {
      const input = await fixture();
      await createLinxUpdateRecoverySet(input);
      const file = path.join(input.recoveryDirectoryPath, "home", "userdata", "state.sqlite");
      if (corruption === "hash") await fs.writeFile(file, "corrupt");
      if (corruption === "mode") await fs.chmod(file, 0o700);
      if (corruption === "extra")
        await fs.writeFile(path.join(input.recoveryDirectoryPath, "home", "unexpected"), "extra");
      if (corruption === "missing") await fs.unlink(file);
      if (corruption === "manifest")
        await fs.writeFile(
          path.join(input.recoveryDirectoryPath, LINX_UPDATE_RECOVERY_MANIFEST_FILE_NAME),
          "{}",
        );
      const homePath = path.join(input.root, "new-home");
      await expect(
        restoreLinxUpdateRecoverySetToEmptyTargets({
          ...input,
          homePath,
          userDataPath: path.join(input.root, "new-profile"),
        }),
      ).rejects.toThrow();
      await expect(fs.stat(homePath)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );
  it.each(["../outside", "/etc/passwd"])(
    "rejects escaping link %s without following it",
    async (link) => {
      const input = await fixture();
      await fs.writeFile(path.join(input.root, "outside"), "not app data");
      await fs.symlink(link, path.join(input.homePath, "escape"));
      await expect(createLinxUpdateRecoverySet(input)).rejects.toThrow("Escaping recovery link");
    },
  );
  it("rejects symlink roots and nested recovery roots", async () => {
    const input = await fixture();
    const alias = path.join(input.root, "alias");
    await fs.symlink(input.homePath, alias);
    await expect(createLinxUpdateRecoverySet({ ...input, homePath: alias })).rejects.toThrow(
      "real data directory",
    );
    await expect(
      createLinxUpdateRecoverySet({
        ...input,
        recoveryDirectoryPath: path.join(input.homePath, "backup"),
      }),
    ).rejects.toThrow("disjoint");
  });
  it("rejects manifest traversal and duplicate entries rather than trusting its paths", async () => {
    const input = await fixture();
    const manifest = await createLinxUpdateRecoverySet(input);
    const file = path.join(input.recoveryDirectoryPath, LINX_UPDATE_RECOVERY_MANIFEST_FILE_NAME);
    await fs.writeFile(
      file,
      JSON.stringify({
        ...manifest,
        entries: [...manifest.entries, { ...manifest.entries[0], path: "../../escape" }],
      }),
    );
    await expect(verifyLinxUpdateRecoverySet(input.recoveryDirectoryPath)).rejects.toThrow();
    await fs.writeFile(
      file,
      JSON.stringify({ ...manifest, entries: [...manifest.entries, manifest.entries[0]] }),
    );
    await expect(verifyLinxUpdateRecoverySet(input.recoveryDirectoryPath)).rejects.toThrow();
  });
  it("fails closed on insufficient space without publishing a recovery set", async () => {
    const input = await fixture();
    const space = await actualFs.statfs(input.root, { bigint: true });
    vi.mocked(fs.statfs).mockResolvedValue({ ...space, bavail: 0n });
    await expect(createLinxUpdateRecoverySet(input)).rejects.toThrow();
    await expect(fs.stat(input.recoveryDirectoryPath)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("refuses changed input rather than accepting a mixed snapshot", async () => {
    const input = await fixture();
    const target = await actualFs.realpath(path.join(input.homePath, "userdata", "state.sqlite"));
    let changed = false;
    vi.mocked(fs.open).mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await actualFs.open(...args);
      if (!changed && args[0] === target) {
        changed = true;
        await fs.writeFile(args[0], "changed while opening");
      }
      return handle;
    });
    await expect(createLinxUpdateRecoverySet(input)).rejects.toThrow();
    await expect(
      fs.stat(path.join(input.recoveryDirectoryPath, LINX_UPDATE_RECOVERY_MANIFEST_FILE_NAME)),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("accepts an immutable portable export instead of copying a live profile", async () => {
    const input = await fixture();
    await fs.symlink(`fixture-${process.pid}`, path.join(input.userDataPath, "SingletonLock"));
    await expect(createLinxUpdateRecoverySet(input)).rejects.toThrow("offline");
    const prepared = path.join(input.root, "prepared-profile");
    await fs.mkdir(prepared, { mode: 0o700 });
    await fs.writeFile(
      path.join(prepared, "linx-portable-profile.json"),
      JSON.stringify({
        schemaVersion: 1,
        origin: "linx://app",
        snapshot: { version: 1, exportedAt: "2026-11-13T00:00:00.000Z", entries: {} },
        records: [],
      }),
    );
    const manifest = await createLinxUpdateRecoverySet({
      ...input,
      userDataSnapshotPath: prepared,
    });
    expect(manifest.userDataPath).toBe(await fs.realpath(input.userDataPath));
    expect(manifest.userDataFormat).toBe("portable-app-storage");
    expect(
      manifest.entries.some(
        (entry) => entry.root === "userData" && entry.path === "linx-portable-profile.json",
      ),
    ).toBe(true);
    expect(manifest.entries.some((entry) => entry.path.includes("IndexedDB"))).toBe(false);
  });
  it("supports genuinely empty absent roots without creating source data", async () => {
    const input = await fixture();
    await fs.rm(input.homePath, { recursive: true });
    await fs.rm(input.userDataPath, { recursive: true });
    const manifest = await createLinxUpdateRecoverySet(input);
    expect(manifest.entries.map((entry) => entry.path)).toEqual(["", ""]);
    await expect(fs.stat(input.homePath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(input.userDataPath)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("relocates absolute contained links without retaining an old-home alias", async () => {
    const input = await fixture();
    await fs.symlink(
      path.join(input.homePath, "userdata", "state.sqlite"),
      path.join(input.homePath, "database"),
    );
    await createLinxUpdateRecoverySet(input);
    expect(await fs.readlink(path.join(input.recoveryDirectoryPath, "home", "database"))).toBe(
      "userdata/state.sqlite",
    );
  });
  it("does not recursively include previous recovery sets", async () => {
    const input = await fixture();
    await createLinxUpdateRecoverySet(input);
    await fs.cp(input.recoveryDirectoryPath, path.join(input.homePath, "previous-recovery"), {
      recursive: true,
    });
    const next = await createLinxUpdateRecoverySet({
      ...input,
      recoveryDirectoryPath: path.join(input.root, "next-recovery"),
      attemptId: randomUUID(),
    });
    expect(next.entries.some((entry) => entry.path.startsWith("previous-recovery"))).toBe(false);
  });
});
