// FILE: linx-update-manifest.ts
// Purpose: Publisher CLI for the LU-00 Linx update manifest (generate-key, sign, verify).
// Layer: Release/publishing tool; never bundled into the desktop app.
//
// Exit codes: 0 success; 1 manifest rejected; 2 usage or configuration error.
// Private key material is never printed.

import { spawnSync } from "node:child_process";
import { Buffer } from "node:buffer";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

import {
  LINX_UPDATE_KEY_RING_MAX_BYTES,
  LINX_UPDATE_MANIFEST_MAX_BYTES,
  LINX_UPDATE_SIGNATURE_MAX_BYTES,
} from "@synara/contracts";
import {
  loadLinxUpdateKeyRing,
  LinxUpdateConfigurationError,
  verifyLinxUpdateManifest,
} from "@synara/shared/linxUpdateManifestVerification";

import {
  generateLinxUpdateSigningKeyPair,
  LINX_UPDATE_KEY_RING_FILE_NAME,
  LINX_UPDATE_PRIVATE_KEY_FILE_NAME,
  linxUpdateKeyIdForPrivateKey,
  signLinxUpdateManifestBytes,
  writeLinxUpdateKeyRing,
  writeLinxUpdatePrivateKey,
} from "./lib/linx-update-manifest-signing.ts";

const USAGE = `Usage:
  linx-update-manifest generate-key --out <dir>
  linx-update-manifest sign --manifest <path> --key <private-key.pem> [--out <signature.sig>]
  linx-update-manifest verify --manifest <path> --signature <path> --key-ring <path> \\
      --current-version <x.y.z> --asset-hosts <host[,host...]>
`;

const SUBCOMMAND_FLAGS = {
  "generate-key": ["out"],
  sign: ["manifest", "key", "out"],
  verify: ["manifest", "signature", "key-ring", "current-version", "asset-hosts"],
} as const;

type Subcommand = keyof typeof SUBCOMMAND_FLAGS;

class LinxUpdateUsageError extends Error {
  override readonly name = "LinxUpdateUsageError";
}

export interface LinxUpdateManifestCliDependencies {
  readonly cwd?: string;
  readonly stdout?: (line: string) => void;
  readonly stderr?: (line: string) => void;
  /** Injectable so tests can describe "inside a Git work tree" without a repo. */
  readonly gitWorkTreeRoot?: (dir: string) => string | null;
}

function parseFlags(
  args: ReadonlyArray<string>,
  allowed: ReadonlyArray<string>,
): ReadonlyMap<string, string> {
  const flags = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const rawFlag = args[index];
    const value = args[index + 1];
    if (rawFlag === undefined) break;
    if (!rawFlag.startsWith("--")) {
      throw new LinxUpdateUsageError(`Unexpected argument "${rawFlag}".`);
    }
    const name = rawFlag.slice(2);
    if (!allowed.includes(name)) {
      throw new LinxUpdateUsageError(`Unknown option "${rawFlag}".`);
    }
    if (value === undefined || value.length === 0 || value.startsWith("--")) {
      throw new LinxUpdateUsageError(`Option "${rawFlag}" requires a non-empty value.`);
    }
    if (flags.has(name)) {
      throw new LinxUpdateUsageError(`Option "${rawFlag}" was provided more than once.`);
    }
    flags.set(name, value);
  }
  return flags;
}

function requiredFlag(flags: ReadonlyMap<string, string>, name: string): string {
  const value = flags.get(name);
  if (value === undefined) throw new LinxUpdateUsageError(`Missing required option "--${name}".`);
  return value;
}

function readBoundedFile(
  filePath: string,
  limit: number,
): { readonly bytes: Buffer; readonly truncated: boolean } {
  let descriptor: number;
  try {
    descriptor = openSync(filePath, "r");
  } catch (error) {
    throw new LinxUpdateConfigurationError(
      `Cannot read "${filePath}": ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  try {
    const buffer = Buffer.alloc(limit + 1);
    let total = 0;
    try {
      while (total < buffer.length) {
        const read = readSync(descriptor, buffer, total, buffer.length - total, null);
        if (read === 0) break;
        total += read;
      }
    } catch (error) {
      throw new LinxUpdateConfigurationError(
        `Cannot read "${filePath}": ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return { bytes: buffer.subarray(0, total), truncated: total > limit };
  } finally {
    closeSync(descriptor);
  }
}

function readWholeFile(filePath: string): Buffer {
  try {
    return readFileSync(filePath);
  } catch (error) {
    throw new LinxUpdateConfigurationError(
      `Cannot read "${filePath}": ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Refuses when git cannot answer. A probe that fails for an unknown reason must
 * not be treated as "outside the repository": that is where keys leak.
 */
export function resolveGitWorkTreeRoot(dir: string): string | null {
  const result = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    cwd: dir,
    encoding: "utf8",
  });
  if (result.error !== undefined) {
    throw new LinxUpdateConfigurationError(
      "Cannot determine whether --out is inside a Git work tree: git is unavailable.",
    );
  }
  if (result.status === 0) {
    const root = result.stdout.trim();
    if (root.length === 0) {
      throw new LinxUpdateConfigurationError("Cannot determine the Git work tree root.");
    }
    return realpathSync(root);
  }
  if (/not a git repository/i.test(result.stderr)) return null;
  const detail = result.stderr.trim() || `git exited with status ${String(result.status)}`;
  throw new LinxUpdateConfigurationError(
    `Cannot determine whether --out is inside a Git work tree: ${detail}`,
  );
}

export function isPathInside(root: string, target: string): boolean {
  const path = relative(root, target);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

// Bare host names only: `URL.host` drops the default port for https, so a
// documented `host:port` entry could never match a real manifest URL.
const ASSET_HOST_PATTERN = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/u;

export function parseLinxUpdateAssetHosts(value: string): ReadonlyArray<string> {
  const hosts = value
    .split(",")
    .map((host) => host.trim().toLowerCase())
    .filter((host) => host.length > 0);
  if (hosts.length === 0) {
    throw new LinxUpdateConfigurationError("--asset-hosts requires at least one host.");
  }
  for (const host of hosts) {
    if (!ASSET_HOST_PATTERN.test(host)) {
      throw new LinxUpdateConfigurationError(`Invalid asset host "${host}".`);
    }
  }
  return hosts;
}

function nearestExistingAncestor(target: string): string {
  let current = target;
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) return current;
    current = parent;
  }
  return current;
}

/** Resolves symlinks for the nearest existing ancestor, then re-appends the missing tail. */
function resolveThroughExistingAncestor(target: string): string {
  const ancestor = nearestExistingAncestor(target);
  let resolvedAncestor: string;
  try {
    if (!statSync(ancestor).isDirectory()) {
      throw new LinxUpdateConfigurationError(`"--out" path "${target}" is not a directory.`);
    }
    resolvedAncestor = realpathSync(ancestor);
  } catch (error) {
    if (error instanceof LinxUpdateConfigurationError) throw error;
    throw new LinxUpdateConfigurationError(
      `Cannot inspect "${target}": ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const tail = relative(ancestor, target);
  return tail.length === 0 ? resolvedAncestor : join(resolvedAncestor, tail);
}

function assertOutsideGitWorkTree(
  dir: string,
  gitWorkTreeRoot: (dir: string) => string | null,
): void {
  const target = resolveThroughExistingAncestor(dir);
  // Git cannot be spawned from a directory that does not exist yet, so probe
  // from the nearest real ancestor and compare the resolved target.
  const ancestor = resolveThroughExistingAncestor(nearestExistingAncestor(dir));
  let root: string | null;
  try {
    root = gitWorkTreeRoot(ancestor);
  } catch (error) {
    if (error instanceof LinxUpdateConfigurationError) throw error;
    throw new LinxUpdateConfigurationError(
      `Cannot determine whether --out is inside a Git work tree: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (root !== null) {
    let resolvedRoot: string;
    try {
      resolvedRoot = realpathSync(root);
    } catch (error) {
      throw new LinxUpdateConfigurationError(
        `Cannot determine the Git work tree root: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    if (isPathInside(resolvedRoot, target)) {
      throw new LinxUpdateConfigurationError(
        `Refusing to write publisher keys inside the Git work tree at "${resolvedRoot}". Choose a directory outside the repository.`,
      );
    }
  }
}

function refuseExisting(path: string): void {
  if (existsSync(path)) {
    throw new LinxUpdateConfigurationError(
      `Refusing to replace existing "${path}". Move it aside first (key rotation is a deliberate, reviewed act).`,
    );
  }
}

function runGenerateKey(
  flags: ReadonlyMap<string, string>,
  dependencies: Required<LinxUpdateManifestCliDependencies>,
): number {
  const outDir = resolve(dependencies.cwd, requiredFlag(flags, "out"));
  assertOutsideGitWorkTree(outDir, dependencies.gitWorkTreeRoot);
  try {
    mkdirSync(outDir, { recursive: true });
  } catch (error) {
    throw new LinxUpdateConfigurationError(
      `Cannot create "${outDir}": ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const privateKeyPath = join(outDir, LINX_UPDATE_PRIVATE_KEY_FILE_NAME);
  const keyRingPath = join(outDir, LINX_UPDATE_KEY_RING_FILE_NAME);
  refuseExisting(privateKeyPath);
  refuseExisting(keyRingPath);

  const pair = generateLinxUpdateSigningKeyPair();
  writeLinxUpdatePrivateKey(privateKeyPath, pair.privateKeyPem);
  writeLinxUpdateKeyRing(keyRingPath, pair.keyRingJson);

  dependencies.stdout(`keyId: ${pair.keyId}`);
  dependencies.stdout(`publicKey: ${pair.publicKeyBase64}`);
  return 0;
}

function runSign(
  flags: ReadonlyMap<string, string>,
  dependencies: Required<LinxUpdateManifestCliDependencies>,
): number {
  const manifestPath = resolve(dependencies.cwd, requiredFlag(flags, "manifest"));
  const keyPath = resolve(dependencies.cwd, requiredFlag(flags, "key"));
  const outFlag = flags.get("out");
  const outPath =
    outFlag === undefined ? `${manifestPath}.sig` : resolve(dependencies.cwd, outFlag);

  if (outPath === manifestPath) {
    throw new LinxUpdateConfigurationError("--out must not overwrite the manifest.");
  }
  if (outPath === keyPath) {
    throw new LinxUpdateConfigurationError("--out must not overwrite the signing key.");
  }

  // The manifest is signed exactly as written. Schema admission belongs to
  // `verify`; a publisher who signs garbage produces a manifest clients reject.
  const bytes = readWholeFile(manifestPath);
  const privateKeyPem = readWholeFile(keyPath).toString("utf8");
  const keyId = linxUpdateKeyIdForPrivateKey(privateKeyPem);
  const signature = signLinxUpdateManifestBytes(bytes, privateKeyPem);
  try {
    writeFileSync(outPath, `${signature}\n`, "utf8");
  } catch (error) {
    throw new LinxUpdateConfigurationError(
      `Cannot write "${outPath}": ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  dependencies.stdout(`keyId: ${keyId}`);
  dependencies.stdout(`signature: ${outPath}`);
  return 0;
}

function runVerify(
  flags: ReadonlyMap<string, string>,
  dependencies: Required<LinxUpdateManifestCliDependencies>,
): number {
  const manifestPath = resolve(dependencies.cwd, requiredFlag(flags, "manifest"));
  const signaturePath = resolve(dependencies.cwd, requiredFlag(flags, "signature"));
  const keyRingPath = resolve(dependencies.cwd, requiredFlag(flags, "key-ring"));
  const currentVersion = requiredFlag(flags, "current-version");
  const assetHosts = parseLinxUpdateAssetHosts(requiredFlag(flags, "asset-hosts"));

  const manifestRead = readBoundedFile(manifestPath, LINX_UPDATE_MANIFEST_MAX_BYTES);
  const signatureRead = readBoundedFile(signaturePath, LINX_UPDATE_SIGNATURE_MAX_BYTES);
  const keyRingRead = readBoundedFile(keyRingPath, LINX_UPDATE_KEY_RING_MAX_BYTES);
  if (keyRingRead.truncated) {
    throw new LinxUpdateConfigurationError(
      `Trusted key ring exceeds ${LINX_UPDATE_KEY_RING_MAX_BYTES} bytes.`,
    );
  }
  const keyRing = loadLinxUpdateKeyRing(keyRingRead.bytes.toString("utf8"));

  const result = verifyLinxUpdateManifest({
    manifestBytes: manifestRead.bytes,
    signatureBytes: signatureRead.bytes,
    keyRing,
    currentVersion,
    allowedAssetHosts: assetHosts,
  });

  if (!result.ok) {
    dependencies.stderr(`reason: ${result.reason}`);
    dependencies.stderr(`field: ${result.field ?? "-"}`);
    dependencies.stderr(`message: ${result.message}`);
    return 1;
  }

  dependencies.stdout(`version: ${result.manifest.version}`);
  dependencies.stdout(`keyId: ${result.keyId}`);
  return 0;
}

export function runLinxUpdateManifestCli(
  argv: ReadonlyArray<string>,
  options: LinxUpdateManifestCliDependencies = {},
): number {
  const dependencies: Required<LinxUpdateManifestCliDependencies> = {
    cwd: options.cwd ?? process.cwd(),
    stdout: options.stdout ?? ((line) => console.log(line)),
    stderr: options.stderr ?? ((line) => console.error(line)),
    gitWorkTreeRoot: options.gitWorkTreeRoot ?? resolveGitWorkTreeRoot,
  };
  const [subcommand, ...rest] = argv;

  try {
    if (subcommand === undefined) throw new LinxUpdateUsageError("Missing subcommand.");
    if (!Object.hasOwn(SUBCOMMAND_FLAGS, subcommand)) {
      throw new LinxUpdateUsageError(`Unknown subcommand "${subcommand}".`);
    }
    const flags = parseFlags(rest, SUBCOMMAND_FLAGS[subcommand as Subcommand]);
    switch (subcommand as Subcommand) {
      case "generate-key":
        return runGenerateKey(flags, dependencies);
      case "sign":
        return runSign(flags, dependencies);
      case "verify":
        return runVerify(flags, dependencies);
    }
  } catch (error) {
    if (error instanceof LinxUpdateUsageError) {
      dependencies.stderr(`error: ${error.message}`);
      dependencies.stderr(USAGE.trimEnd());
      return 2;
    }
    if (error instanceof LinxUpdateConfigurationError) {
      dependencies.stderr(`error: ${error.message}`);
      return 2;
    }
    throw error;
  }
}

if (import.meta.main) {
  process.exitCode = runLinxUpdateManifestCli(process.argv.slice(2));
}
