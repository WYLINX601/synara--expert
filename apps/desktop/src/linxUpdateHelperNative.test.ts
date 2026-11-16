import type { ChildProcessWithoutNullStreams } from "node:child_process";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { extractLinxUpdateArchive } from "@synara/shared/linxUpdateArchive";
import { runLinxPlatformCommand } from "./linxUpdateHelperPlatform";
import { spawnProcess } from "@synara/shared/processRuntime";

interface HeldTargetLock {
  child: ChildProcessWithoutNullStreams;
  closed: Promise<number | null>;
}

// Explicit isolated qualification only. Never opens an app or touches a real home.
const enabled =
  process.platform === "darwin" &&
  process.arch === "arm64" &&
  process.env.LINX_UPDATE_NATIVE_QUALIFICATION === "1";
describe.skipIf(!enabled)("isolated production Darwin bridge qualification", () => {
  let root: string, bridge: string;
  const children = new Map<ChildProcessWithoutNullStreams, Promise<number | null>>();
  const hold = async (lock: string, attempt: string) => {
    const child = spawnProcess(bridge, ["target-lock", lock, attempt], { stdio: "pipe" });
    const closed = Promise.withResolvers<number | null>();
    const ready = Promise.withResolvers<void>();
    children.set(child, closed.promise);
    child.once("error", closed.reject);
    child.once("close", closed.resolve);
    child.stderr.resume();
    child.stdout.once("data", (bytes) =>
      bytes.toString() === "locked\n"
        ? ready.resolve()
        : ready.reject(new Error("Invalid lock reply")),
    );
    child.once("error", ready.reject);
    child.once("exit", () => ready.reject(new Error("Target lock refused")));
    await ready.promise;
    return { child, closed: closed.promise };
  };
  const release = async (held: HeldTargetLock) => {
    held.child.stdin.end("release\n");
    expect(await held.closed).toBe(0);
  };
  afterEach(async () => {
    for (const child of children.keys()) child.kill("SIGKILL");
    await Promise.allSettled(children.values());
    children.clear();
  });
  beforeAll(async () => {
    root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "linx-native-provenance-")));
    bridge = join(root, "bridge");
    runLinxPlatformCommand("/usr/bin/xcrun", [
      "--sdk",
      "macosx",
      "clang",
      "-arch",
      "arm64",
      "-mmacosx-version-min=13.0",
      "-O2",
      "-Wall",
      "-Wextra",
      "-Werror",
      "-framework",
      "Foundation",
      "-framework",
      "CoreServices",
      fileURLToPath(new URL("./linxUpdateDarwinBridge.m", import.meta.url)),
      "-o",
      bridge,
    ]);
    runLinxPlatformCommand("/usr/bin/codesign", [
      "--force",
      "--sign",
      "-",
      "--timestamp=none",
      bridge,
    ]);
  });
  afterAll(async () => {
    if (root) await fs.rm(root, { recursive: true, force: true });
  });
  it("excludes different homes and live attempts, then readopts only the killed committed attempt", async () => {
    const lock = join(root, ".linx-install-fixture.lock");
    const owner = join(root, "home-one/attempt");
    const other = join(root, "home-two/attempt");
    const first = await hold(lock, owner);
    const guard = await fs.lstat(join(lock, "guard"));
    expect(await fs.readFile(join(lock, "owner"), "utf8")).toBe(owner);
    expect(() => runLinxPlatformCommand(bridge, ["target-lock", lock, other])).toThrow();
    expect(() => runLinxPlatformCommand(bridge, ["target-lock", lock, owner])).toThrow();
    first.child.kill("SIGKILL");
    expect(await first.closed).toBeNull();
    expect(() => runLinxPlatformCommand(bridge, ["target-lock", lock, other])).toThrow();
    await release(await hold(lock, owner));
    expect(await fs.readdir(lock)).toEqual(["guard"]);
    await release(await hold(lock, other));
    expect(await fs.readdir(lock)).toEqual(["guard"]);
    expect(await fs.lstat(join(lock, "guard"))).toMatchObject({
      dev: guard.dev,
      ino: guard.ino,
      nlink: 1,
      size: 0,
    });
  });
  it.each(["empty", "guard", "partial-owner", "complete-owner"])(
    "recovers the uncommitted %s crash state with the real native lease",
    async (state) => {
      const lock = join(root, `.interrupted-${state}.lock`);
      await fs.mkdir(lock, { mode: 0o700 });
      if (state !== "empty") await fs.writeFile(join(lock, "guard"), "", { mode: 0o600 });
      if (state.endsWith("-owner"))
        await fs.writeFile(
          join(lock, "owner.pending"),
          state === "partial-owner" ? "" : "uncommitted-other-attempt",
          { mode: 0o600 },
        );
      const held = await hold(lock, "new-attempt");
      expect(await fs.readFile(join(lock, "owner"), "utf8")).toBe("new-attempt");
      expect((await fs.readdir(lock)).sort()).toEqual(["guard", "owner"]);
      expect(() => runLinxPlatformCommand(bridge, ["target-lock", lock, "new-attempt"])).toThrow();
      await release(held);
      expect(await fs.readdir(lock)).toEqual(["guard"]);
    },
  );
  it.each(["empty", "guard"])(
    "allows exactly one native process to acquire a contested %s directory",
    async (state) => {
      const lock = join(root, `.contested-${state}.lock`);
      await fs.mkdir(lock, { mode: 0o700 });
      if (state === "guard") await fs.writeFile(join(lock, "guard"), "", { mode: 0o600 });
      const attempts = ["home-one/attempt", "home-two/attempt"];
      const results = await Promise.allSettled(attempts.map((attempt) => hold(lock, attempt)));
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
      const guard = await fs.lstat(join(lock, "guard"));
      for (const [index, result] of results.entries()) {
        if (result.status !== "fulfilled") continue;
        expect(await fs.readFile(join(lock, "owner"), "utf8")).toBe(attempts[index]);
        await release(result.value);
      }
      await release(await hold(lock, "subsequent-attempt"));
      expect(await fs.lstat(join(lock, "guard"))).toMatchObject({
        dev: guard.dev,
        ino: guard.ino,
      });
    },
  );
  it("does not mistake a missing owner for an unowned target while the kernel lease is live", async () => {
    const lock = join(root, ".retiring-owner.lock");
    const first = await hold(lock, "first");
    const guard = await fs.lstat(join(lock, "guard"));
    await fs.unlink(join(lock, "owner"));
    expect(() => runLinxPlatformCommand(bridge, ["target-lock", lock, "second"])).toThrow();
    first.child.kill("SIGKILL");
    expect(await first.closed).toBeNull();
    await release(await hold(lock, "second"));
    expect(await fs.lstat(join(lock, "guard"))).toMatchObject({
      dev: guard.dev,
      ino: guard.ino,
    });
  });
  it("retains a committed owner on EOF and refuses unknown committed contents or entries", async () => {
    const lock = join(root, ".eof-owner.lock");
    const first = await hold(lock, "first");
    first.child.stdin.end();
    expect(await first.closed).toBe(0);
    await fs.writeFile(join(lock, "owner.pending"), "partial", { mode: 0o600 });
    expect(() => runLinxPlatformCommand(bridge, ["target-lock", lock, "second"])).toThrow();
    expect(await fs.readFile(join(lock, "owner"), "utf8")).toBe("first");
    await release(await hold(lock, "first"));
    await fs.writeFile(join(lock, "owner"), "", { mode: 0o600 });
    expect(() => runLinxPlatformCommand(bridge, ["target-lock", lock, "first"])).toThrow();
    await fs.unlink(join(lock, "owner"));
    await fs.writeFile(join(lock, "unknown"), "", { mode: 0o600 });
    expect(() => runLinxPlatformCommand(bridge, ["target-lock", lock, "first"])).toThrow();
    expect(await fs.readFile(join(lock, "unknown"), "utf8")).toBe("");
  });
  it("refuses owner-only records without adopting an unpublished lock format", async () => {
    const lock = join(root, ".owner-only.lock");
    await fs.mkdir(lock, { mode: 0o700 });
    await fs.writeFile(join(lock, "owner"), "attempt", { mode: 0o600 });
    expect(() => runLinxPlatformCommand(bridge, ["target-lock", lock, "attempt"])).toThrow();
    expect(await fs.readFile(join(lock, "owner"), "utf8")).toBe("attempt");
    expect(await fs.readdir(lock)).toEqual(["owner"]);
  });
  it.each(["guard", "owner", "owner.pending"])(
    "refuses unsafe %s inodes without changing their contents",
    async (name) => {
      for (const kind of ["symlink", "hardlink", "mode", "directory"]) {
        const lock = join(root, `.unsafe-${name}-${kind}.lock`);
        const outside = join(root, `outside-${name}-${kind}`);
        await fs.mkdir(lock, { mode: 0o700 });
        if (name !== "guard") await fs.writeFile(join(lock, "guard"), "", { mode: 0o600 });
        await fs.writeFile(outside, "attempt", { mode: 0o600 });
        const record = join(lock, name);
        if (kind === "symlink") await fs.symlink(outside, record);
        if (kind === "hardlink") await fs.link(outside, record);
        if (kind === "mode") {
          await fs.writeFile(record, name === "guard" ? "" : "attempt", { mode: 0o600 });
          await fs.chmod(record, 0o644);
        }
        if (kind === "directory") await fs.mkdir(record, { mode: 0o700 });
        expect(() => runLinxPlatformCommand(bridge, ["target-lock", lock, "attempt"])).toThrow();
        expect(await fs.readFile(outside, "utf8")).toBe("attempt");
      }
    },
  );
  it("refuses linked and noncanonical directories and foreign permissions", async () => {
    const lock = join(root, ".directory-authority.lock");
    await fs.mkdir(lock, { mode: 0o700 });
    const linked = join(root, ".linked.lock");
    await fs.symlink(lock, linked);
    expect(() => runLinxPlatformCommand(bridge, ["target-lock", linked, "attempt"])).toThrow();
    const alias = join(root, "parent-alias");
    await fs.symlink(root, alias);
    expect(() =>
      runLinxPlatformCommand(bridge, [
        "target-lock",
        join(alias, ".directory-authority.lock"),
        "attempt",
      ]),
    ).toThrow();
    await fs.chmod(lock, 0o777);
    expect(() => runLinxPlatformCommand(bridge, ["target-lock", lock, "attempt"])).toThrow();
  });
  it("rejects guard identity changes before a live lease can report held or clear its owner", async () => {
    const lock = join(root, ".guard-identity.lock");
    const held = await hold(lock, "attempt");
    await fs.rename(join(lock, "guard"), join(lock, "displaced-guard"));
    await fs.writeFile(join(lock, "guard"), "", { mode: 0o600 });
    held.child.stdin.end("release\n");
    expect(await held.closed).toBe(1);
    expect(await fs.readFile(join(lock, "owner"), "utf8")).toBe("attempt");
    expect(() => runLinxPlatformCommand(bridge, ["target-lock", lock, "attempt"])).toThrow();
  });
  it("binds a live PID to the kernel executable rather than textual process arguments", async () => {
    const actual = runLinxPlatformCommand(bridge, ["pidpath", String(process.pid)]);
    expect(actual).toBe(await fs.realpath(process.execPath));
    expect(() => runLinxPlatformCommand(bridge, ["pidpath", "0"])).toThrow();
  });
  it("marks a raw-net package once and copies original raw quarantine/WhereFrom without approval flags", async () => {
    const archive = join(root, "download.zip"),
      app = join(root, "provenance.app");
    await fs.writeFile(archive, "isolated raw-network fixture", { mode: 0o600 });
    await fs.mkdir(app);
    const url =
      "https://github.com/WYLINX601/synara--expert/releases/download/v0.1.16/Linx-0.1.16-arm64.zip";
    runLinxPlatformCommand(bridge, ["mark-download", archive, url]);
    const quarantine = runLinxPlatformCommand("/usr/bin/xattr", [
      "-px",
      "com.apple.quarantine",
      archive,
    ]);
    const whereFrom = runLinxPlatformCommand("/usr/bin/xattr", [
      "-px",
      "com.apple.metadata:kMDItemWhereFroms",
      archive,
    ]);
    runLinxPlatformCommand(bridge, ["mark-download", archive, url]);
    expect(runLinxPlatformCommand("/usr/bin/xattr", ["-px", "com.apple.quarantine", archive])).toBe(
      quarantine,
    );
    runLinxPlatformCommand(bridge, ["provenance", archive, app]);
    expect(runLinxPlatformCommand("/usr/bin/xattr", ["-px", "com.apple.quarantine", app])).toBe(
      quarantine,
    );
    expect(
      runLinxPlatformCommand("/usr/bin/xattr", [
        "-px",
        "com.apple.metadata:kMDItemWhereFroms",
        app,
      ]),
    ).toBe(whereFrom);
  });
  it("preserves actual AppleDouble resource forks through bounded extraction and native unpack", async () => {
    const source = join(root, "Linx.app");
    await fs.mkdir(join(source, "Contents/Resources"), { recursive: true });
    const file = join(source, "Contents/Resources/fixture");
    await fs.writeFile(file, "data fork");
    const fork = Buffer.from("isolated resource-fork evidence");
    await fs.writeFile(`${file}/..namedfork/rsrc`, fork);
    const archive = join(root, "resource.zip");
    runLinxPlatformCommand("/usr/bin/ditto", [
      "-c",
      "-k",
      "--sequesterRsrc",
      "--keepParent",
      source,
      archive,
    ]);
    const extracted = await extractLinxUpdateArchive(archive, join(root, "extracted"));
    for (const metadata of extracted.resourceMetadata)
      runLinxPlatformCommand(bridge, ["unpack", metadata.filePath, metadata.targetPath]);
    expect(
      await fs.readFile(
        join(extracted.applicationPath, "Contents/Resources/fixture/..namedfork/rsrc"),
      ),
    ).toEqual(fork);
    expect(
      await fs.readFile(join(extracted.applicationPath, "Contents/Resources/fixture"), "utf8"),
    ).toBe("data fork");
  });
  it("refuses linked and cross-authority provenance targets", async () => {
    const outside = join(root, "outside");
    await fs.mkdir(outside);
    const linked = join(root, "linked.app");
    await fs.symlink(outside, linked);
    const packagePath = join(root, "unmarked.zip");
    await fs.writeFile(packagePath, "fixture");
    expect(() => runLinxPlatformCommand(bridge, ["provenance", packagePath, linked])).toThrow();
    expect(() =>
      runLinxPlatformCommand(bridge, [
        "mark-download",
        packagePath,
        "https://example.com/package.zip",
      ]),
    ).toThrow();
    await expect(fs.readdir(outside)).resolves.toEqual([]);
  });
  it("preflights application-parent authority without moving the installed fixture", async () => {
    const parent = join(root, "installation-parent"),
      app = join(parent, "Linx.app");
    await fs.mkdir(parent);
    await fs.mkdir(app);
    await fs.writeFile(join(app, "unchanged"), "old bundle");
    runLinxPlatformCommand(bridge, ["preflight", app, parent]);
    await fs.chmod(parent, 0o777);
    try {
      expect(() => runLinxPlatformCommand(bridge, ["preflight", app, parent])).toThrow();
    } finally {
      await fs.chmod(parent, 0o700);
    }
    expect(await fs.readFile(join(app, "unchanged"), "utf8")).toBe("old bundle");
  });
});
