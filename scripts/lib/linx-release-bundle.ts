import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findMacBundleArchitectureMismatches } from "./mac-bundle-architecture.ts";
import { readLinxReleaseSource } from "./linx-release-source.ts";

/** Structural integrity only: deliberately does not assert Gatekeeper or notarization acceptance. */
export function verifyLinxReleaseBundles(assetsDirectory: string, version: string): void {
  if (process.platform !== "darwin" || process.arch !== "arm64")
    throw new Error("Linx qualification requires macOS arm64.");
  const run = (command: string, args: string[]) =>
    execFileSync(command, args, {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  const verifyApp = (app: string) => {
    const plist = join(app, "Contents/Info.plist");
    const read = (key: string) => run("/usr/libexec/PlistBuddy", ["-c", `Print :${key}`, plist]);
    if (
      read("CFBundleIdentifier") !== "com.wylinx.linx" ||
      read("CFBundleShortVersionString") !== version ||
      read("CFBundleVersion") !== version
    )
      throw new Error("Linx bundle identity/version mismatch.");
    run("codesign", ["--verify", "--deep", "--strict", "--verbose=4", app]);
    run("lipo", ["-verify_arch", "arm64", join(app, "Contents/MacOS", read("CFBundleExecutable"))]);
    run("codesign", ["--verify", "--strict", join(app, "Contents/Resources/linx-update-helper")]);
    const mismatches = findMacBundleArchitectureMismatches(app, "arm64");
    if (mismatches.length)
      throw new Error(`Linx native architecture mismatch: ${mismatches.join(", ")}`);
    const source = readLinxReleaseSource(new URL("../..", import.meta.url).pathname);
    const bundledSource = JSON.parse(
      readFileSync(join(app, "Contents/Resources/linx-update-source.json"), "utf8"),
    );
    if (JSON.stringify(bundledSource) !== JSON.stringify(source))
      throw new Error("Bundle trusted source differs from fixed source config.");
    run("lipo", ["-verify_arch", "arm64", join(app, "Contents/Resources/linx-update-helper")]);
  };
  const stem = `Linx-${version}-arm64`;
  const root = mkdtempSync(join(tmpdir(), "linx-qualification-"));
  const mount = join(root, "mount");
  let attached = false;
  try {
    const zipRoot = join(root, "zip");
    run("ditto", ["-x", "-k", join(assetsDirectory, `${stem}.zip`), zipRoot]);
    const apps = readdirSync(zipRoot).filter(
      (name) => name.endsWith(".app") && statSync(join(zipRoot, name)).isDirectory(),
    );
    if (apps.length !== 1 || apps[0] !== "Linx.app")
      throw new Error("ZIP must contain exactly Linx.app.");
    verifyApp(join(zipRoot, "Linx.app"));
    run("hdiutil", ["verify", join(assetsDirectory, `${stem}.dmg`)]);
    run("hdiutil", [
      "attach",
      "-readonly",
      "-nobrowse",
      "-mountpoint",
      mount,
      join(assetsDirectory, `${stem}.dmg`),
    ]);
    attached = true;
    verifyApp(join(mount, "Linx.app"));
  } finally {
    if (attached) run("hdiutil", ["detach", mount]);
    rmSync(root, { recursive: true, force: true });
  }
}
