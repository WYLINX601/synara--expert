import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  isPathInside,
  parseLinxUpdateAssetHosts,
  resolveGitWorkTreeRoot,
  runLinxUpdateManifestCli,
} from "./linx-update-manifest.ts";

const temporaryDirectories: string[] = [];

function makeTemporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "linx-cli-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

interface CliRun {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

function run(
  argv: ReadonlyArray<string>,
  overrides: { readonly gitWorkTreeRoot?: (dir: string) => string | null } = {},
): CliRun {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const status = runLinxUpdateManifestCli(argv, {
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line),
    gitWorkTreeRoot: overrides.gitWorkTreeRoot ?? (() => null),
  });
  return { status, stdout: stdout.join("\n"), stderr: stderr.join("\n") };
}

function readableManifest(keyId: string, patch: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schemaVersion: 1,
    productId: "linx",
    installIdentity: "com.wylinx.linx",
    channel: "stable",
    platform: "darwin",
    arch: "arm64",
    version: "1.2.3",
    sourceCommit: "a".repeat(40),
    minOSVersion: "13.0",
    assetName: "Linx-1.2.3-arm64.zip",
    assetUrl: "https://example.com/Linx-1.2.3-arm64.zip",
    size: 1_024,
    sha256: "b".repeat(64),
    keyId,
    ...patch,
  });
}

function generateKeys(directory: string): {
  keyId: string;
  privateKeyPath: string;
  keyRingPath: string;
} {
  const result = run(["generate-key", "--out", directory]);
  expect(result.status).toBe(0);
  const keyId = result.stdout.match(/^keyId: (.+)$/mu)?.[1];
  if (keyId === undefined) throw new Error(`missing keyId in: ${result.stdout}`);
  return {
    keyId,
    privateKeyPath: join(directory, "linx-update-private.pem"),
    keyRingPath: join(directory, "linx-update-keys.json"),
  };
}

describe("linx-update-manifest CLI: generate-key", () => {
  it("writes a 0600 private key outside a Git work tree and prints no key material", () => {
    const directory = makeTemporaryDirectory();
    const result = run(["generate-key", "--out", directory]);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");

    const privateKeyPath = join(directory, "linx-update-private.pem");
    const keyRingPath = join(directory, "linx-update-keys.json");
    expect(existsSync(privateKeyPath)).toBe(true);
    expect(existsSync(keyRingPath)).toBe(true);
    expect(statSync(privateKeyPath).mode & 0o777).toBe(0o600);

    const privateKey = readFileSync(privateKeyPath, "utf8");
    const keyRing = JSON.parse(readFileSync(keyRingPath, "utf8")) as Record<string, string>;
    const [keyId, publicKey] = Object.entries(keyRing)[0] ?? [];

    expect(keyId).toBeDefined();
    expect(result.stdout).toContain(`keyId: ${String(keyId)}`);
    expect(result.stdout).toContain(`publicKey: ${String(publicKey)}`);
    expect(privateKey).toContain("BEGIN PRIVATE KEY");
    expect(result.stdout).not.toContain("PRIVATE KEY");
    expect(result.stdout).not.toContain(privateKey.trim());
    expect(result.stderr).not.toContain(privateKey.trim());
  });

  it("refuses to overwrite an existing key pair (rotation is deliberate)", () => {
    const directory = makeTemporaryDirectory();
    generateKeys(directory);

    const second = run(["generate-key", "--out", directory]);

    expect(second.status).toBe(2);
    expect(second.stderr).toContain("Refusing to replace");
  });

  it("refuses an output directory inside a Git work tree", () => {
    const directory = makeTemporaryDirectory();
    const keysDirectory = join(directory, "keys");

    const result = run(["generate-key", "--out", keysDirectory], {
      gitWorkTreeRoot: () => directory,
    });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("inside the Git work tree");
    expect(existsSync(keysDirectory)).toBe(false);
  });

  it("rejects empty and unknown options as usage errors", () => {
    expect(run(["generate-key", "--out", ""]).status).toBe(2);
    expect(run(["generate-key", "--destination", "/tmp/x"]).status).toBe(2);
    expect(run(["generate-key"]).status).toBe(2);
    expect(run([]).status).toBe(2);
    expect(run(["publish"]).status).toBe(2);
    expect(run(["toString"]).status).toBe(2);
    expect(run(["constructor"]).status).toBe(2);
    expect(run(["hasOwnProperty"]).status).toBe(2);
  });

  it("reports an --out path that is a regular file as a configuration error", () => {
    const directory = makeTemporaryDirectory();
    const filePath = join(directory, "not-a-directory");
    writeFileSync(filePath, "x", "utf8");

    const result = run(["generate-key", "--out", filePath]);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("is not a directory");
    expect(result.stderr).not.toContain("git is unavailable");
  });
});

describe("linx-update-manifest CLI: sign and verify", () => {
  it("signs a manifest and verifies it end to end", () => {
    const directory = makeTemporaryDirectory();
    const keys = generateKeys(join(directory, "keys"));
    const manifestPath = join(directory, "manifest.json");
    writeFileSync(manifestPath, readableManifest(keys.keyId), "utf8");

    const signed = run(["sign", "--manifest", manifestPath, "--key", keys.privateKeyPath]);

    expect(signed.status).toBe(0);
    expect(signed.stdout).toContain(`keyId: ${keys.keyId}`);
    expect(signed.stdout).toContain("signature:");
    expect(existsSync(`${manifestPath}.sig`)).toBe(true);

    const verified = run([
      "verify",
      "--manifest",
      manifestPath,
      "--signature",
      `${manifestPath}.sig`,
      "--key-ring",
      keys.keyRingPath,
      "--current-version",
      "0.1.0",
      "--asset-hosts",
      "example.com",
    ]);

    expect(verified).toMatchObject({ status: 0, stderr: "" });
    expect(verified.stdout).toContain("version: 1.2.3");
    expect(verified.stdout).toContain(`keyId: ${keys.keyId}`);
  });

  it("rejects a tampered manifest with exit code 1 and reason=signature", () => {
    const directory = makeTemporaryDirectory();
    const keys = generateKeys(join(directory, "keys"));
    const manifestPath = join(directory, "manifest.json");
    writeFileSync(manifestPath, readableManifest(keys.keyId), "utf8");
    run(["sign", "--manifest", manifestPath, "--key", keys.privateKeyPath]);
    writeFileSync(manifestPath, `${readableManifest(keys.keyId)} `, "utf8");

    const verified = run([
      "verify",
      "--manifest",
      manifestPath,
      "--signature",
      `${manifestPath}.sig`,
      "--key-ring",
      keys.keyRingPath,
      "--current-version",
      "0.1.0",
      "--asset-hosts",
      "example.com",
    ]);

    expect(verified.status).toBe(1);
    expect(verified.stderr).toContain("reason: signature");
    expect(verified.stdout).toBe("");
  });

  it("rejects an asset host outside the allow list with reason=url", () => {
    const directory = makeTemporaryDirectory();
    const keys = generateKeys(join(directory, "keys"));
    const manifestPath = join(directory, "manifest.json");
    writeFileSync(manifestPath, readableManifest(keys.keyId), "utf8");
    run(["sign", "--manifest", manifestPath, "--key", keys.privateKeyPath]);

    const verified = run([
      "verify",
      "--manifest",
      manifestPath,
      "--signature",
      `${manifestPath}.sig`,
      "--key-ring",
      keys.keyRingPath,
      "--current-version",
      "0.1.0",
      "--asset-hosts",
      "github.com",
    ]);

    expect(verified.status).toBe(1);
    expect(verified.stderr).toContain("reason: url");
  });

  it("refuses to write a signature over its own inputs", () => {
    const directory = makeTemporaryDirectory();
    const keys = generateKeys(join(directory, "keys"));
    const manifestPath = join(directory, "manifest.json");
    writeFileSync(manifestPath, readableManifest(keys.keyId), "utf8");

    const overKey = run([
      "sign",
      "--manifest",
      manifestPath,
      "--key",
      keys.privateKeyPath,
      "--out",
      keys.privateKeyPath,
    ]);
    const overManifest = run([
      "sign",
      "--manifest",
      manifestPath,
      "--key",
      keys.privateKeyPath,
      "--out",
      manifestPath,
    ]);

    expect(overKey.status).toBe(2);
    expect(overKey.stderr).toContain("must not overwrite the signing key");
    expect(overManifest.status).toBe(2);
    expect(overManifest.stderr).toContain("must not overwrite the manifest");
    expect(readFileSync(keys.privateKeyPath, "utf8")).toContain("BEGIN PRIVATE KEY");
  });

  it("reports a missing required option as a usage error", () => {
    const result = run(["verify", "--manifest", "m.json"]);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('Missing required option "--signature"');
    expect(result.stderr).toContain("Usage:");
  });
});

describe("linx-update-manifest CLI helpers", () => {
  it("detects paths inside a directory without treating siblings as nested", () => {
    expect(isPathInside("/repo", "/repo")).toBe(true);
    expect(isPathInside("/repo", "/repo/keys")).toBe(true);
    expect(isPathInside("/repo", "/repository/keys")).toBe(false);
    expect(isPathInside("/repo", "/other")).toBe(false);
  });

  it("parses and validates the asset host allow list", () => {
    expect(parseLinxUpdateAssetHosts("Example.com, github.com")).toEqual([
      "example.com",
      "github.com",
    ]);
    expect(() => parseLinxUpdateAssetHosts("")).toThrow();
    expect(() => parseLinxUpdateAssetHosts("https://example.com")).toThrow();
    expect(() => parseLinxUpdateAssetHosts("example.com/path")).toThrow();
    expect(() => parseLinxUpdateAssetHosts("example.com:443")).toThrow();
  });

  it("probes the real Git work tree without guessing", () => {
    const repositoryRoot = resolveGitWorkTreeRoot(import.meta.dirname);

    expect(repositoryRoot).not.toBeNull();
    expect(isPathInside(repositoryRoot ?? "", resolve(import.meta.dirname))).toBe(true);
    expect(resolveGitWorkTreeRoot(tmpdir())).toBeNull();
  });
});
