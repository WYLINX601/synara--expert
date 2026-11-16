import { generateKeyPairSync, createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({
  output: vi.fn<(command: string, args: readonly string[]) => string>(),
}));
vi.mock("@synara/shared/processRuntime", () => ({
  spawnProcessSync: vi.fn((command: string, args: readonly string[]) => ({
    status: 0,
    stdout: native.output(command, args) ?? "",
    stderr: "",
  })),
}));
import { spawnProcessSync } from "@synara/shared/processRuntime";
import { createLinxDarwinHelperPlatform } from "./linxUpdateHelperPlatform";

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  native.output.mockReset();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "linx-platform-authority-")));
  roots.push(root);
  const attempt = join(root, randomUUID());
  await fs.mkdir(attempt, { mode: 0o700 });
  const app = join(root, "Linx.app"),
    resources = join(app, "Contents/Resources");
  await fs.mkdir(join(resources, "app"), { recursive: true });
  await fs.mkdir(join(app, "Contents/MacOS"));
  await fs.writeFile(join(app, "Contents/MacOS/Linx"), "signed executable fixture");
  const keys = generateKeyPairSync("ed25519"),
    der = keys.publicKey.export({ type: "spki", format: "der" });
  const id = createHash("sha256").update(der).digest("hex").slice(0, 16);
  const source = JSON.stringify({
    repository: "WYLINX601/synara--expert",
    keyRing: { [id]: der.toString("base64") },
  });
  await fs.writeFile(join(resources, "linx-update-source.json"), source);
  await fs.writeFile(
    join(resources, "app/package.json"),
    JSON.stringify({ version: "0.1.16", buildVersion: "0.1.16", synaraCommitHash: "a".repeat(40) }),
  );
  await fs.writeFile(join(resources, "linx-update-helper"), "authenticated copied helper");
  await fs.writeFile(join(attempt, "linx-update-helper"), "authenticated copied helper", {
    mode: 0o700,
  });
  const bridgeBytes = Buffer.from("embedded bridge fixture"),
    bridgeDigest = createHash("sha256").update(bridgeBytes).digest("hex");
  vi.stubGlobal("process", { ...process, platform: "darwin", arch: "arm64" });
  vi.stubGlobal("__LINX_UPDATE_DARWIN_BRIDGE_BASE64__", bridgeBytes.toString("base64"));
  vi.stubGlobal("__LINX_UPDATE_DARWIN_BRIDGE_SHA256__", bridgeDigest);
  const plist = {
    CFBundleExecutable: "Linx",
    CFBundleIdentifier: "com.wylinx.linx",
    CFBundleShortVersionString: "0.1.16",
    CFBundleVersion: "0.1.16",
    LSMinimumSystemVersion: "13.0",
  };
  native.output.mockImplementation((command, args) => {
    if (command === "/usr/bin/plutil") return JSON.stringify(plist);
    if (command === "/usr/bin/sw_vers") return "14.4";
    if (args[0] === "pidpath") return join(attempt, "linx-update-helper");
    return "";
  });
  return {
    root,
    attempt,
    app,
    resources,
    plist,
    bridge: join(attempt, `linx-update-darwin-bridge-${bridgeDigest}`),
    source,
    platform: await createLinxDarwinHelperPlatform(attempt, source),
  };
}
describe("production native helper platform boundary", () => {
  it("authenticates the independent helper against its old signed resource and uses kernel PID paths", async () => {
    const f = await fixture();
    await f.platform.validateStandaloneHelper(f.app, f.attempt);
    expect(spawnProcessSync).toHaveBeenCalledWith(
      f.bridge,
      ["pidpath", String(process.pid)],
      expect.anything(),
    );
    expect(spawnProcessSync).toHaveBeenCalledWith(
      f.bridge,
      ["preflight", f.app, f.root],
      expect.anything(),
    );
    await fs.writeFile(join(f.attempt, "linx-update-helper"), "substituted executable");
    await expect(f.platform.validateStandaloneHelper(f.app, f.attempt)).rejects.toThrow("differs");
  });
  it("preserves archive provenance and AppleDouble through the native bridge without stripping quarantine", async () => {
    const f = await fixture(),
      packagePath = join(f.attempt, "package.zip");
    const metadata = [
      { filePath: join(f.attempt, "resource"), targetPath: join(f.app, "Contents/Info.plist") },
    ];
    const url =
      "https://github.com/WYLINX601/synara--expert/releases/download/v0.1.16/Linx-0.1.16-arm64.zip";
    await f.platform.prepareMetadata(packagePath, f.app, metadata, url);
    expect(
      vi
        .mocked(spawnProcessSync)
        .mock.calls.filter((call) => call[0] === f.bridge)
        .map((call) => call[1]),
    ).toEqual([
      ["mark-download", packagePath, url],
      ["unpack", metadata[0]!.filePath, metadata[0]!.targetPath],
      ["provenance", packagePath, f.app],
    ]);
    expect(JSON.stringify(vi.mocked(spawnProcessSync).mock.calls)).not.toContain("xattr -d");
  });
  it("launches only through LaunchServices, keeping OS approval in the path", async () => {
    const f = await fixture();
    await f.platform.launch(f.app, f.attempt);
    expect(spawnProcessSync).toHaveBeenLastCalledWith(
      "/usr/bin/open",
      ["-n", f.app, "--args", "--linx-update-attempt", f.attempt],
      expect.anything(),
    );
  });
  it("checks real Info.plist minimum OS rather than trusting a signed manifest assertion alone", async () => {
    const f = await fixture();
    f.plist.LSMinimumSystemVersion = "15.0";
    await expect(f.platform.validateBundle(f.app, "0.1.16", false)).rejects.toThrow(
      "requires macOS",
    );
    expect(
      vi
        .mocked(spawnProcessSync)
        .mock.calls.some((call) => call[0] === "/usr/bin/codesign" && call[1]?.includes(f.app)),
    ).toBe(false);
  });
  it("refuses an attacker-created or linked native bridge before executing it", async () => {
    const f = await fixture();
    await fs.chmod(f.bridge, 0o755);
    vi.mocked(spawnProcessSync).mockClear();
    await expect(createLinxDarwinHelperPlatform(f.attempt, f.source)).rejects.toThrow(
      "authenticated bridge",
    );
    expect(spawnProcessSync).not.toHaveBeenCalled();
  });
});
