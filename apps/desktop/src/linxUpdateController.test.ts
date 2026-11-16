import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import * as fs from "node:fs/promises";
import { copyFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { build } from "tsdown";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LinxUpdateHelperCommand, LinxUpdateManifest } from "@synara/contracts";
import { createLinxInstallerHelper } from "./linxUpdateController";

const seams = vi.hoisted(() => ({ spawn: vi.fn(), sync: vi.fn() }));
vi.mock("@synara/shared/processRuntime", () => ({
  spawnProcess: seams.spawn,
  spawnProcessSync: seams.sync,
}));
const roots: string[] = [];
beforeEach(() => {
  vi.clearAllMocks();
  seams.sync.mockImplementation((command: string, args: string[]) => {
    if (command === "/usr/bin/ditto") copyFileSync(args[2]!, args[3]!);
    return { status: 0, error: undefined };
  });
});
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "linx-controller-")));
  roots.push(root);
  await fs.chmod(root, 0o700);
  const bytes = Buffer.from("signed package fixture");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const manifest: LinxUpdateManifest = {
    schemaVersion: 1,
    productId: "linx",
    installIdentity: "com.wylinx.linx",
    channel: "stable",
    platform: "darwin",
    arch: "arm64",
    version: "0.1.16",
    sourceCommit: "a".repeat(40),
    minOSVersion: "13.0",
    assetName: "Linx-0.1.16-arm64.zip",
    assetUrl: "https://github.com/owner/repo/releases/download/v0.1.16/Linx-0.1.16-arm64.zip",
    size: bytes.length,
    sha256,
    keyId: "b".repeat(16),
  };
  const packagePath = join(root, "download.zip");
  await fs.writeFile(packagePath, bytes, { mode: 0o600 });
  const helperPath = join(root, "bundled-helper");
  await fs.writeFile(helperPath, "private helper fixture", { mode: 0o700 });
  vi.stubGlobal(
    "__LINX_UPDATE_HELPER_SHA256__",
    createHash("sha256").update("private helper fixture").digest("hex"),
  );
  const applicationPath = join(root, "Linx.app");
  await fs.mkdir(applicationPath, { mode: 0o700 });
  const input: Parameters<typeof createLinxInstallerHelper>[0] = {
    attemptId: randomUUID(),
    attemptsPath: join(root, "attempts"),
    helperPath,
    applicationPath,
    homePath: join(root, "home"),
    userDataPath: join(root, "profile"),
    currentVersion: "0.1.15",
    signal: new AbortController().signal,
    installation: {
      target: {
        ...manifest,
        manifest,
        manifestBytes: Buffer.from("signed manifest fixture"),
        signatureBytes: Buffer.from("signature fixture"),
        manifestDigest: "c".repeat(64),
      },
      download: { filePath: packagePath, size: bytes.length, sha256 },
      release: {
        schemaVersion: 1,
        repository: "owner/repo",
        tagName: "v0.1.16",
        releaseId: 1,
        tagObjectSha: manifest.sourceCommit,
        sourceCommit: manifest.sourceCommit,
        packageAssetId: 2,
        manifestAssetId: 3,
        signatureAssetId: 4,
        manifestDigest: "c".repeat(64),
        packageSha256: sha256,
        verifiedAt: new Date().toISOString(),
      },
    },
  };
  const child = Object.assign(new EventEmitter(), {
    pid: 838383,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    unref: vi.fn(),
  });
  const commands: LinxUpdateHelperCommand[] = [];
  child.stdin.on("data", (chunk: Buffer) => commands.push(JSON.parse(chunk.toString("utf8"))));
  seams.spawn.mockReturnValue(child);
  const reply = (status: string, changes: Record<string, unknown> = {}) =>
    child.stdout.write(
      `${JSON.stringify({ schemaVersion: 1, attemptId: input.attemptId, manifestDigest: input.installation.target.manifestDigest, helperPid: child.pid, status, failure: status === "failed" ? "failed" : null, ...changes })}\n`,
    );
  return { root, input, packagePath, child, commands, reply };
}

// The production controller intentionally refuses every other platform. These
// isolated fixture tests never execute a native binary, launch an app or use user data.
const macArm64 = process.platform === "darwin" && process.arch === "arm64";
describe("private standalone helper controller", () => {
  it.runIf(macArm64)(
    "authenticates the enclosing bundle seal and copies independent helper/package before spawn",
    async () => {
      const f = await fixture();
      const helper = await createLinxInstallerHelper(f.input);
      expect(seams.sync).toHaveBeenCalledWith(
        "/usr/bin/codesign",
        ["--verify", "--deep", "--strict", f.input.applicationPath],
        expect.anything(),
      );
      expect(seams.spawn).toHaveBeenCalledWith(
        join(helper.attemptPath, "linx-update-helper"),
        ["--attempt", helper.attemptPath],
        { stdio: "pipe", detached: true },
      );
      expect(await fs.readFile(join(helper.attemptPath, "package.zip"), "utf8")).toBe(
        "signed package fixture",
      );
      expect((await fs.stat(join(helper.attemptPath, "authorization.nonce"))).mode & 0o777).toBe(
        0o600,
      );
      const request: unknown = JSON.parse(
        await fs.readFile(join(helper.attemptPath, "request.json"), "utf8"),
      );
      expect(request).toMatchObject({
        authorizationDigest: createHash("sha256").update(helper.nonce).digest("hex"),
      });
      const preparing = helper.prepare(new AbortController().signal);
      f.reply("prepared");
      await preparing;
      expect(f.commands[0]).toMatchObject({
        action: "prepare",
        nonce: helper.nonce,
        manifestDigest: f.input.installation.target.manifestDigest,
      });
      const cancelling = helper.cancel();
      f.reply("cancelled");
      await cancelling;
    },
  );

  it.runIf(macArm64)(
    "pins build-defined helper bytes despite later disk, environment and global substitution",
    async () => {
      const f = await fixture();
      vi.stubEnv(
        "LINX_UPDATE_HELPER_SHA256",
        createHash("sha256")
          .update(await fs.readFile(f.input.helperPath))
          .digest("hex"),
      );
      vi.resetModules();
      // Reload after setting the build environment; a static import would capture it too early.
      const { default: configurations } = await import("../tsdown.config.mjs");
      if (!Array.isArray(configurations)) throw new Error("Expected desktop build configurations");
      const runtimeShim = join(f.root, "process-runtime.mjs");
      await fs.writeFile(
        runtimeShim,
        `export const spawnProcess = (...args) => globalThis.__linxControllerBuildSeams.spawn(...args);
export const spawnProcessSync = (...args) => globalThis.__linxControllerBuildSeams.sync(...args);
`,
      );
      vi.stubGlobal("__linxControllerBuildSeams", seams);
      const output = join(f.root, "compiled");
      await build({
        ...configurations[0],
        config: false,
        cwd: fileURLToPath(new URL("..", import.meta.url)),
        entry: [fileURLToPath(new URL("./linxUpdateController.ts", import.meta.url))],
        outDir: output,
        noExternal: () => true,
        alias: { "@synara/shared/processRuntime": runtimeShim },
        dts: false,
        sourcemap: false,
        logLevel: "silent",
      });
      const compiled = createRequire(import.meta.url)(join(output, "linxUpdateController.js")) as {
        createLinxInstallerHelper: typeof createLinxInstallerHelper;
      };
      const helper = await compiled.createLinxInstallerHelper(f.input);
      const preparing = helper.prepare(new AbortController().signal);
      f.reply("prepared");
      await preparing;
      const cancelling = helper.cancel();
      f.reply("cancelled");
      await cancelling;

      const substituted = await fixture();
      const replacement = "self-consistent replacement build";
      const replacementDigest = createHash("sha256").update(replacement).digest("hex");
      await fs.writeFile(substituted.input.helperPath, replacement);
      vi.stubEnv("LINX_UPDATE_HELPER_SHA256", replacementDigest);
      vi.stubGlobal("__LINX_UPDATE_HELPER_SHA256__", replacementDigest);
      seams.spawn.mockClear();
      await expect(compiled.createLinxInstallerHelper(substituted.input)).rejects.toThrow(
        "Bundled helper does not match this desktop build",
      );
      expect(seams.spawn).not.toHaveBeenCalled();
    },
    60_000,
  );

  it.runIf(macArm64)(
    "rejects a substituted helper even when all native signature and enclosing seal checks accept",
    async () => {
      const f = await fixture();
      await fs.writeFile(f.input.helperPath, "independently ad-hoc-signed malicious helper");
      await expect(createLinxInstallerHelper(f.input)).rejects.toThrow(
        "Bundled helper does not match this desktop build",
      );
      expect(seams.spawn).not.toHaveBeenCalled();
      await expect(
        fs.stat(join(f.input.attemptsPath, f.input.attemptId, "linx-update-helper")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it.runIf(macArm64).each([undefined, "", "not-a-sha256"])(
    "refuses installation without a valid embedded build identity (%s)",
    async (identity) => {
      const f = await fixture();
      vi.stubGlobal("__LINX_UPDATE_HELPER_SHA256__", identity);
      await expect(createLinxInstallerHelper(f.input)).rejects.toThrow(
        "Desktop build has no authenticated update helper",
      );
      expect(seams.sync).not.toHaveBeenCalled();
      expect(seams.spawn).not.toHaveBeenCalled();
    },
  );

  it.runIf(macArm64)("rejects source substitution between authentication and copying", async () => {
    const f = await fixture();
    seams.sync.mockImplementation((command: string, args: string[]) => {
      if (command === "/usr/bin/codesign" && args.at(-1) === f.input.applicationPath)
        writeFileSync(f.input.helperPath, "substituted during copy");
      return { status: 0, error: undefined };
    });
    await expect(createLinxInstallerHelper(f.input)).rejects.toThrow(
      "Standalone helper does not match this desktop build",
    );
    expect(seams.spawn).not.toHaveBeenCalled();
  });

  it.runIf(macArm64)(
    "rechecks the copied helper immediately before launch after package preparation",
    async () => {
      const f = await fixture();
      seams.sync.mockImplementation((command: string, args: string[]) => {
        if (command === "/usr/bin/ditto") {
          copyFileSync(args[2]!, args[3]!);
          writeFileSync(
            join(f.input.attemptsPath, f.input.attemptId, "linx-update-helper"),
            "substituted before spawn",
          );
        }
        return { status: 0, error: undefined };
      });
      await expect(createLinxInstallerHelper(f.input)).rejects.toThrow(
        "Standalone helper does not match this desktop build",
      );
      expect(seams.spawn).not.toHaveBeenCalled();
    },
  );

  it.runIf(macArm64)(
    "refuses a changed package identity or failed enclosing resource seal before spawning",
    async () => {
      const f = await fixture();
      await fs.truncate(f.packagePath, 1);
      await expect(createLinxInstallerHelper(f.input)).rejects.toThrow("file identity changed");
      expect(seams.spawn).not.toHaveBeenCalled();
      const other = await fixture();
      seams.sync.mockImplementation((command: string, args: string[]) => ({
        status:
          command === "/usr/bin/codesign" && args.at(-1) === other.input.applicationPath ? 1 : 0,
      }));
      await expect(createLinxInstallerHelper(other.input)).rejects.toThrow(
        "Native update preparation failed",
      );
      expect(seams.spawn).not.toHaveBeenCalled();
    },
  );

  it.runIf(macArm64)(
    "retains aborted protocol waiters so late prepare cannot masquerade as cancel acknowledgment",
    async () => {
      const f = await fixture();
      const helper = await createLinxInstallerHelper(f.input);
      const signal = new AbortController();
      const preparing = helper.prepare(signal.signal);
      const refused = expect(preparing).rejects.toThrow("cancelled");
      signal.abort(new Error("cancelled"));
      await refused;
      const cancelling = helper.cancel();
      f.reply("prepared");
      f.reply("cancelled");
      await expect(cancelling).resolves.toBeUndefined();
      expect(f.commands.map((command) => command.action)).toEqual(["prepare", "cancel"]);
    },
  );

  it.runIf(macArm64)(
    "rejects oversized unterminated output and mismatched child/target responses",
    async () => {
      const f = await fixture();
      const helper = await createLinxInstallerHelper(f.input);
      const preparing = helper.prepare(new AbortController().signal);
      f.child.stdout.write(Buffer.alloc(64 * 1024 + 1, 0x78));
      await expect(preparing).rejects.toThrow("Oversized helper response");
      const other = await fixture();
      const second = await createLinxInstallerHelper(other.input);
      const pending = second.prepare(new AbortController().signal);
      other.reply("prepared", { helperPid: 999 });
      await expect(pending).rejects.toThrow("binding changed");
    },
  );
});
