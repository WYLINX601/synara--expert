import { mkdtempSync, chmodSync, mkdirSync, statSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { spawnProcessSync } from "@synara/shared/processRuntime";
import { hashFile } from "./lib/file-digest.ts";
import { validateLinxReleaseSource, type LinxReleaseSource } from "./lib/linx-release-source.ts";

export async function buildLinxUpdateHelper(input: {
  readonly repositoryRoot: string;
  readonly outputPath: string;
  readonly source: LinxReleaseSource;
}): Promise<{ filePath: string; size: number; sha256: string }> {
  const source = validateLinxReleaseSource(input.source);
  if (process.platform !== "darwin" || process.arch !== "arm64")
    throw new Error("Linx helper must be built and structurally verified on macOS arm64.");
  mkdirSync(dirname(input.outputPath), { recursive: true });
  const run = (command: string, args: string[]) => {
    const result = spawnProcessSync(command, args, {
      cwd: input.repositoryRoot,
      encoding: "utf8",
      timeout: 300_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    if (result.error || result.status !== 0)
      throw new Error(
        `${command} failed: ${result.stderr || result.error?.message || "unknown error"}`,
      );
  };
  // The bridge is independently signed before embedding; no runtime compiler or
  // resource inside the moving old application is needed after handoff.
  const temporary = mkdtempSync(join(tmpdir(), "linx-update-bridge-"));
  try {
    const bridge = join(temporary, "linx-update-darwin-bridge");
    run("/usr/bin/xcrun", [
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
      join(input.repositoryRoot, "apps/desktop/src/linxUpdateDarwinBridge.m"),
      "-o",
      bridge,
    ]);
    chmodSync(bridge, 0o700);
    run("/usr/bin/codesign", ["--force", "--sign", "-", "--timestamp=none", bridge]);
    run("/usr/bin/codesign", ["--verify", "--strict", "--verbose=4", bridge]);
    run("/usr/bin/lipo", ["-verify_arch", "arm64", bridge]);
    const bridgeBytes = readFileSync(bridge);
    const bridgeDigest = createHash("sha256").update(bridgeBytes).digest("hex");
    // Bun's define is a JavaScript expression; all three embedded inputs are strings.
    run("bun", [
      "build",
      join(input.repositoryRoot, "apps/desktop/src/linxUpdateHelper.ts"),
      "--compile",
      "--target=bun-darwin-arm64",
      "--define",
      `__LINX_UPDATE_SOURCE_JSON__=${JSON.stringify(JSON.stringify(source))}`,
      "--define",
      `__LINX_UPDATE_DARWIN_BRIDGE_BASE64__=${JSON.stringify(bridgeBytes.toString("base64"))}`,
      "--define",
      `__LINX_UPDATE_DARWIN_BRIDGE_SHA256__=${JSON.stringify(bridgeDigest)}`,
      "--outfile",
      input.outputPath,
    ]);
    chmodSync(input.outputPath, 0o755);
    run("/usr/bin/codesign", ["--force", "--sign", "-", "--timestamp=none", input.outputPath]);
    run("/usr/bin/codesign", ["--verify", "--strict", "--verbose=4", input.outputPath]);
    run("/usr/bin/lipo", ["-verify_arch", "arm64", input.outputPath]);
    return {
      filePath: input.outputPath,
      size: statSync(input.outputPath).size,
      sha256: await hashFile(input.outputPath),
    };
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}
