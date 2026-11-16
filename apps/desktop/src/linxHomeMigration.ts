import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import { homedir, hostname } from "node:os";
import * as path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { parse as parseToml } from "smol-toml";
import { Effect, Schema } from "effect";
import {
  acquireDatabaseLifecycleLock,
  releaseDatabaseLifecycleLock,
} from "@synara/shared/databaseLifecycleLock";
import type { DatabaseLifecycleLock } from "@synara/shared/databaseLifecycleLock";
import {
  canonicalLinxDataPath,
  createLinxUpdateRecoverySet,
  restoreLinxUpdateRecoverySetToEmptyTargets,
  snapshotLinxOfflineUserData,
} from "@synara/shared/linxUpdateRecovery";
import { ServerSettings, type SynaraStorageSnapshot } from "@synara/contracts";
import {
  resolveSynaraStorageSnapshotPath,
  validateSynaraStorageSnapshot,
  relocateSynaraStorageSnapshotPaths,
} from "./desktopStorageMigration";
import { copyLinxLegacyProfileForExtraction, transferLinxLegacyStorage } from "./linxLegacyStorage";
import { syncDirectoryEntry } from "@synara/shared/filesystemPlatform";
import {
  BUILT_IN_PROVIDER_KINDS,
  deriveProviderInstances,
  providerStartOptionsFromInstance,
} from "@synara/shared/providerInstances";
import {
  resolveBaseCodexHomePath,
  resolveCodexHomeOverlayAccountSegment,
  resolveSynaraCodexHomeOverlayPath,
} from "@synara/shared/codexHomeOverlayPaths";
import {
  LEGACY_SYNARA_SHARED_CONTINUATION_MARKER_FILE,
  SYNARA_SHARED_CONTINUATION_MARKER_FILE,
  parseCodexSharedContinuationMarker,
} from "@synara/shared/codexContinuationMarker";
import { resolveCodexSourceHomeIdentity } from "@synara/shared/codexSourceIdentity";
import { isProviderDirectoryEnvironmentVariable } from "@synara/shared/providerDirectoryPaths";
import {
  providerEnvironmentSecretName,
  readServerSecretFile,
  resolveServerSecretPath,
} from "@synara/shared/serverSecretFiles";

const RECEIPT = "linx-home-migration.json";
export const LINX_MIGRATION_REAUTHENTICATION_NOTICE =
  "Application-owned credentials in userdata/secrets are preserved. Third-party Keychain items are not copied or renamed; provider CLIs, browser sessions and macOS permissions may require authentication or approval again. The old application must remain closed; its data is a recovery source, not a second active home.";

export function linxLegacyMigrationPaths(input: {
  homeDirectory: string;
  appDataPath: string;
  preview: boolean;
}): { sourceHomePath: string; sourceUserDataPath: string } {
  return {
    sourceHomePath: path.join(
      input.homeDirectory,
      input.preview ? ".synara-workbench-preview" : ".synara-workbench",
    ),
    sourceUserDataPath: path.join(
      input.appDataPath,
      input.preview ? "workbench-preview" : "workbench",
    ),
  };
}

async function requireOfflineProfile(profile: string): Promise<void> {
  const lockPath = path.join(profile, "SingletonLock");
  const stat = await fs.lstat(lockPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!stat) return;
  if (!stat.isSymbolicLink())
    throw new Error("Legacy profile owner is unknown; close the old application before importing");
  const owner = await fs.readlink(lockPath);
  const separator = owner.lastIndexOf("-");
  const pid = Number(owner.slice(separator + 1));
  if (
    separator < 0 ||
    owner.slice(0, separator) !== hostname() ||
    !Number.isSafeInteger(pid) ||
    pid <= 0
  ) {
    throw new Error("Legacy profile owner is unknown; refusing offline import");
  }
  try {
    process.kill(pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
    throw new Error("Legacy profile process state is unknown");
  }
  throw new Error("Legacy application is still running; close it before importing");
}

async function acquireOfflineProfile(profile: string): Promise<() => Promise<void>> {
  await requireOfflineProfile(profile);
  const lockPath = path.join(profile, "SingletonLock");
  const oldOwner = await fs.readlink(lockPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (oldOwner !== null) {
    await requireOfflineProfile(profile);
    if ((await fs.readlink(lockPath)) !== oldOwner)
      throw new Error("Legacy profile ownership changed");
    await fs.unlink(lockPath);
  }
  const owner = `${hostname()}-${process.pid}`;
  await fs.symlink(owner, lockPath);
  return async () => {
    if ((await fs.readlink(lockPath)) !== owner)
      throw new Error("Legacy profile lock ownership changed");
    await fs.unlink(lockPath);
  };
}

async function requirePortableBrowserVault(sourceHomePath: string): Promise<void> {
  for (const relative of ["browser-vault/vault", "browser-session-restore"]) {
    const envelopePath = path.join(sourceHomePath, relative, "key-protection.json");
    const handle = await fs
      .open(envelopePath, constants.O_RDONLY | constants.O_NOFOLLOW)
      .catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
    if (handle === null) {
      const legacyKey = await fs
        .lstat(path.join(sourceHomePath, relative, "vault.key"))
        .catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return null;
          throw error;
        });
      if (legacyKey && (!legacyKey.isFile() || legacyKey.isSymbolicLink() || legacyKey.size !== 32))
        throw new Error("Legacy browser vault key is corrupt");
      const encrypted = await fs
        .lstat(
          path.join(
            sourceHomePath,
            relative,
            relative === "browser-session-restore" ? "sessions.enc" : "vault.enc",
          ),
        )
        .catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return null;
          throw error;
        });
      if (encrypted && !legacyKey)
        throw new Error(
          "Browser vault/session recovery key is missing; recover the source before importing instead of creating a replacement key",
        );
      continue;
    }
    let envelope: Record<string, unknown>;
    try {
      const stat = await handle.stat();
      const named = await fs.lstat(envelopePath);
      if (
        !stat.isFile() ||
        named.isSymbolicLink() ||
        stat.ino !== named.ino ||
        stat.dev !== named.dev ||
        stat.size > 16_384
      )
        throw new Error("Browser vault key envelope is corrupt");
      const bytes = Buffer.alloc(16_385);
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
      const after = await handle.stat();
      if (
        bytesRead !== stat.size ||
        bytesRead > 16_384 ||
        after.size !== stat.size ||
        after.mtimeMs !== stat.mtimeMs ||
        after.ctimeMs !== stat.ctimeMs
      )
        throw new Error("Browser vault key envelope changed");
      envelope = JSON.parse(bytes.subarray(0, bytesRead).toString("utf8")) as Record<
        string,
        unknown
      >;
    } finally {
      await handle.close();
    }
    if (envelope === null || typeof envelope !== "object" || envelope.version !== 1)
      throw new Error("Unknown browser vault key envelope");
    if (envelope.os != null && envelope.master == null) {
      if (relative === "browser-session-restore") {
        throw new Error(
          "Remembered browser sessions have only an old-identity OS key and cannot be imported offline. Preserve the old home; explicitly recover or remove this session-recovery data before retrying, then authenticate browser sessions again. Linx will not copy Keychain items or silently discard remembered sessions.",
        );
      }
      throw new Error(
        "The browser vault has only an old-identity OS key. In the old application, configure its existing master-password protection before closing it and importing. Linx will not copy Keychain items or discard the vault.",
      );
    }
    const master = envelope.master;
    if (master === null || typeof master !== "object" || Array.isArray(master))
      throw new Error("Browser vault has no portable master-password protection");
    for (const [field, size] of [
      ["salt", 16],
      ["iv", 12],
      ["tag", 16],
      ["data", 32],
    ] as const) {
      const value = (master as Record<string, unknown>)[field];
      if (
        typeof value !== "string" ||
        Buffer.from(value, "base64").length !== size ||
        Buffer.from(value, "base64").toString("base64") !== value
      ) {
        throw new Error("Browser vault master-password envelope is corrupt");
      }
    }
  }
}
/** Edit only schema-owned provider directory slots, preserving the persisted
 * envelope, credential references, unknown settings and model selections.
 */
async function relocateCopiedProviderSettings(
  homePath: string,
  sourceHomePaths: readonly string[],
): Promise<void> {
  const settingsPath = path.join(homePath, "userdata", "settings.json");
  const handle = await fs
    .open(settingsPath, constants.O_RDONLY | constants.O_NOFOLLOW)
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
  if (handle === null) return;
  let document: unknown;
  let mode: number;
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error("Copied provider settings are not a regular file");
    mode = stat.mode & 0o777;
    document = JSON.parse(await handle.readFile("utf8"));
  } finally {
    await handle.close();
  }
  const record = (value: unknown): Record<string, unknown> | undefined =>
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  const outer = record(document);
  const settings = outer && "settings" in outer ? record(outer.settings) : outer;
  if (!settings) throw new Error("Copied provider settings are not an object");
  let changed = false;
  const relocate = (original: unknown): unknown => {
    if (typeof original !== "string" || !original.trim()) return original;
    const trimmed = original.trim();
    const absolute =
      trimmed === "~"
        ? homedir()
        : /^~[\\/]/u.test(trimmed)
          ? path.join(homedir(), ...trimmed.slice(2).split(/[\\/]+/u))
          : trimmed;
    if (!path.isAbsolute(absolute)) return original;
    for (const source of sourceHomePaths) {
      const relative = path.relative(source, absolute);
      if (path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`))
        continue;
      return path.join(homePath, relative);
    }
    return original;
  };
  const relocateFields = (value: unknown, fields: readonly string[]) => {
    const config = record(value);
    if (!config) return;
    for (const field of fields) {
      const moved = relocate(config[field]);
      if (moved === config[field]) continue;
      config[field] = moved;
      changed = true;
    }
  };
  const replaceCopiedFile = async (filePath: string, contents: string, fileMode: number) => {
    const temporaryPath = `${filePath}.relocating-${randomUUID()}`;
    const output = await fs.open(temporaryPath, "wx", fileMode);
    try {
      await output.writeFile(contents);
      await output.chmod(fileMode);
      await output.sync();
    } finally {
      await output.close();
    }
    await fs.rename(temporaryPath, filePath);
    await syncDirectoryEntry(path.dirname(filePath));
  };
  // Derive the very same account identity as launch, including redacted directory
  // variables. Hydrate a clone: secret references and unknown settings stay intact.
  const codexHomes = async () => {
    const hydrated = structuredClone(settings);
    for (const [instanceId, value] of Object.entries(record(hydrated.providerInstances) ?? {})) {
      const instance = record(value);
      if (instance?.driver !== "codex" || !Array.isArray(instance.environment)) continue;
      for (const entry of instance.environment) {
        const variable = record(entry);
        if (
          variable?.valueRedacted !== true ||
          variable.sensitive !== true ||
          typeof variable.name !== "string"
        )
          continue;
        const bytes = await readServerSecretFile(
          resolveServerSecretPath(
            path.join(homePath, "userdata", "secrets"),
            providerEnvironmentSecretName({ instanceId, name: variable.name.trim() }),
          ),
        );
        if (bytes === null) continue;
        variable.value = new TextDecoder().decode(bytes);
        delete variable.valueRedacted;
      }
    }
    const result = new Map<string, { source: string; overlay: string }>();
    for (const instance of deriveProviderInstances(
      Schema.decodeUnknownSync(ServerSettings)(hydrated),
    )) {
      if (instance.driver !== "codex") continue;
      const options = providerStartOptionsFromInstance(instance)?.codex;
      const env = { ...process.env, ...options?.environment, SYNARA_HOME: homePath };
      const source = resolveBaseCodexHomePath(env, options?.homePath);
      const shadow = options?.shadowHomePath
        ? resolveBaseCodexHomePath(env, options.shadowHomePath)
        : undefined;
      const segment = resolveCodexHomeOverlayAccountSegment({
        homePath: source,
        ...(options?.accountId ? { accountId: options.accountId } : {}),
        ...(shadow ? { shadowHomePath: shadow } : {}),
      });
      result.set(String(instance.instanceId), {
        source,
        overlay: resolveSynaraCodexHomeOverlayPath(env, source, segment),
      });
    }
    return result;
  };
  const originalCodexHomes = await codexHomes();
  const providers = record(settings.providers);
  relocateFields(providers?.codex, ["homePath"]);
  const accounts = record(providers?.codex)?.accounts;
  if (Array.isArray(accounts)) {
    for (const account of accounts) relocateFields(account, ["homePath", "shadowHomePath"]);
  }
  relocateFields(providers?.claudeAgent, ["homePath"]);
  for (const driver of ["pi", "omp"]) relocateFields(providers?.[driver], ["agentDir"]);
  for (const [instanceId, value] of Object.entries(record(settings.providerInstances) ?? {})) {
    const instance = record(value);
    if (!instance || !BUILT_IN_PROVIDER_KINDS.some((driver) => driver === instance.driver))
      continue;
    const fields = ["profileDir"];
    if (instance.driver === "codex") fields.push("homePath", "shadowHomePath");
    if (instance.driver === "claudeAgent") fields.push("homePath", "configDir", "secureStorageDir");
    if (instance.driver === "pi" || instance.driver === "omp") fields.push("agentDir");
    relocateFields(instance.config, fields);
    const driver = String(instance.driver);
    if (!Array.isArray(instance.environment)) continue;
    for (const entry of instance.environment) {
      const variable = record(entry);
      if (
        typeof variable?.name !== "string" ||
        !isProviderDirectoryEnvironmentVariable(driver, variable.name.trim())
      )
        continue;
      if (variable.valueRedacted === true) {
        if (variable.sensitive !== true) continue;
        const secretPath = resolveServerSecretPath(
          path.join(homePath, "userdata", "secrets"),
          providerEnvironmentSecretName({ instanceId, name: variable.name.trim() }),
        );
        const bytes = await readServerSecretFile(secretPath);
        if (bytes === null) continue;
        const original = new TextDecoder().decode(bytes);
        const moved = relocate(original);
        if (typeof moved !== "string" || moved === original) continue;
        const stat = await fs.lstat(secretPath);
        if (!stat.isFile() || stat.isSymbolicLink())
          throw new Error("Copied provider secret is not a regular file");
        await replaceCopiedFile(secretPath, moved, stat.mode & 0o777);
      } else {
        relocateFields(variable, ["value"]);
      }
    }
  }
  const relocatedCodexHomes = await codexHomes();
  const sourceMoves = new Map<string, string>();
  const overlayMoves = new Map<string, string>();
  for (const [instanceId, before] of originalCodexHomes) {
    const after = relocatedCodexHomes.get(instanceId);
    if (!after) throw new Error("Codex provider identity disappeared during migration");
    if (before.source !== after.source && relocate(before.source) === after.source) {
      sourceMoves.set(before.source, after.source);
    }
    if (before.overlay !== after.overlay) {
      const previous = overlayMoves.get(before.overlay);
      if (previous && previous !== after.overlay)
        throw new Error("Codex account overlay migration collision");
      overlayMoves.set(before.overlay, after.overlay);
    }
  }
  const movedOverlayEntry = (candidate: string): string => {
    for (const [from, to] of overlayMoves) {
      const relative = path.relative(from, candidate);
      if (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
        return path.join(to, relative);
    }
    return candidate;
  };
  const copiedAliasPlans = new Map<
    string,
    {
      originalLink: string;
      linkTarget: string;
      type: "dir" | "file";
      device: number;
      inode: number;
    }
  >();
  const prepareCopiedAlias = async (from: string, to: string) => {
    const originalLink = await fs.readlink(from);
    const original = await fs.lstat(from);
    const canonicalTarget = await fs.realpath(from);
    const relative = path.relative(homePath, canonicalTarget);
    if (path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`))
      throw new Error("Codex account overlay migration encountered an escaping alias");
    const finalTarget = movedOverlayEntry(canonicalTarget);
    const plan = {
      originalLink,
      linkTarget: path.relative(path.dirname(to), finalTarget) || ".",
      type: (await fs.stat(canonicalTarget)).isDirectory() ? ("dir" as const) : ("file" as const),
      device: original.dev,
      inode: original.ino,
    };
    copiedAliasPlans.set(from, plan);
    return plan;
  };
  // Recovery has already validated contained aliases. Bind their referents before
  // moving any file, since a later sibling/fixed-expert alias can temporarily
  // dangle while its target is being transferred to the new account identity.
  // Preflight all account directories before moving any private file. Missing
  // destinations are exclusively created; existing files are never overwritten.
  const mergeOverlay = async (from: string, to: string, publish: boolean): Promise<void> => {
    const source = await fs.lstat(from).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (!source) return;
    const target = await fs.lstat(to).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (source.isSymbolicLink()) {
      const plan = publish ? copiedAliasPlans.get(from) : await prepareCopiedAlias(from, to);
      if (
        !plan ||
        source.dev !== plan.device ||
        source.ino !== plan.inode ||
        (await fs.readlink(from)) !== plan.originalLink
      )
        throw new Error("Copied Codex account alias changed during migration");
      if (target && (!target.isSymbolicLink() || (await fs.readlink(to)) !== plan.linkTarget))
        throw new Error("Codex account overlay migration collision");
      if (!publish) return;
      if (!target) await fs.symlink(plan.linkTarget, to, plan.type);
      await syncDirectoryEntry(path.dirname(to));
      await fs.unlink(from);
      await syncDirectoryEntry(path.dirname(from));
      return;
    }
    if (target?.isSymbolicLink()) throw new Error("Codex account overlay migration collision");
    if (source.isDirectory()) {
      if (target && !target.isDirectory())
        throw new Error("Codex account overlay migration collision");
      if (publish && !target) await fs.mkdir(to, { mode: source.mode & 0o777 });
      for (const name of await fs.readdir(from)) {
        await mergeOverlay(path.join(from, name), path.join(to, name), publish);
      }
      if (publish) {
        await syncDirectoryEntry(to);
        await fs.rmdir(from);
        await syncDirectoryEntry(path.dirname(from));
      }
      return;
    }
    if (!source.isFile() || (target && !target.isFile()))
      throw new Error("Codex account overlay migration collision");
    // The only admissible duplicate is our own interrupted hard-link publish.
    // Equal bytes in unrelated files do not establish account ownership.
    if (target && (source.dev !== target.dev || source.ino !== target.ino))
      throw new Error("Codex account overlay migration collision");
    if (!publish) return;
    if (!target) await fs.link(from, to);
    await syncDirectoryEntry(path.dirname(to));
    await fs.unlink(from);
    await syncDirectoryEntry(path.dirname(from));
  };
  for (const [from, to] of overlayMoves) await mergeOverlay(from, to, false);
  // Also preserve contained references *into* a renamed account directory from
  // elsewhere in the copied home; they must not become dangling historical paths.
  const incomingAliases: string[] = [];
  const prepareIncomingAliases = async (directory: string): Promise<void> => {
    if (overlayMoves.has(directory)) return;
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const candidate = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        const target = await fs.realpath(candidate);
        if (movedOverlayEntry(target) !== target) {
          await prepareCopiedAlias(candidate, candidate);
          incomingAliases.push(candidate);
        }
      } else if (entry.isDirectory()) {
        await prepareIncomingAliases(candidate);
      }
    }
  };
  if (overlayMoves.size) await prepareIncomingAliases(homePath);
  // Validate the original source binding, not merely the copied marker's shape.
  // Never upgrade v1 here: runtime owns that transition and its state checks.
  const sourceFileWrites: { filePath: string; content: string; mode: number }[] = [];
  for (const [source, destination] of sourceMoves) {
    const sourceIdentity = await resolveCodexSourceHomeIdentity(source);
    const destinationIdentity = await resolveCodexSourceHomeIdentity(destination);
    const ownedDestination = relocate(sourceIdentity);
    if (
      typeof ownedDestination !== "string" ||
      (await resolveCodexSourceHomeIdentity(ownedDestination)) !== destinationIdentity
    )
      throw new Error("Codex source marker migration crosses an external home boundary");
    const configPath = path.join(destination, "config.toml");
    const configEntry = await fs.lstat(configPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (configEntry) {
      // A contained config alias stays an alias; publish to its copied referent,
      // never through a path that could write into the original/external home.
      const copiedConfigPath = await fs.realpath(configPath);
      const configRelative = path.relative(homePath, copiedConfigPath);
      if (
        path.isAbsolute(configRelative) ||
        configRelative === ".." ||
        configRelative.startsWith(`..${path.sep}`)
      )
        throw new Error("Copied Codex config escapes the destination home");
      const configHandle = await fs.open(
        copiedConfigPath,
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      let originalConfig: string;
      let configMode: number;
      try {
        const stat = await configHandle.stat();
        if (!stat.isFile()) throw new Error("Copied Codex config is not a regular file");
        configMode = stat.mode & 0o777;
        originalConfig = await configHandle.readFile("utf8");
      } finally {
        await configHandle.close();
      }
      const expectedConfig = parseToml(originalConfig);
      const configured = expectedConfig.sqlite_home;
      const configuredIdentity =
        typeof configured === "string" && path.isAbsolute(configured)
          ? await resolveCodexSourceHomeIdentity(configured)
          : undefined;
      const relocatedSqliteHome =
        configuredIdentity === sourceIdentity
          ? ownedDestination
          : typeof configured === "string" && path.isAbsolute(configured)
            ? relocate(configured)
            : configured;
      if (
        typeof configured === "string" &&
        typeof relocatedSqliteHome === "string" &&
        relocatedSqliteHome !== configured
      ) {
        if (
          configuredIdentity !== sourceIdentity ||
          (await resolveCodexSourceHomeIdentity(relocatedSqliteHome)) !== destinationIdentity
        )
          throw new Error("Codex config sqlite_home does not belong to the migrating source");
        expectedConfig.sqlite_home = relocatedSqliteHome;
        // Keep the existing quoted-assignment editing convention, but let the
        // runtime's TOML parser prove scope. A candidate inside instructions or
        // a profile cannot match the full document with only the root changed.
        // Quoted/escaped keys and basic/literal/multiline strings are all valid.
        // Overlap candidates so a quoted example cannot consume a later real key.
        const assignments =
          /^(?=([ \t]*(?:sqlite_home|"(?:\\[^\r\n]|[^"\\\r\n])*"|'[^'\r\n]*')[ \t]*=[ \t]*)("""(?:\\[\s\S]|(?!""")[^\\])*"{3,5}|'''(?:(?!''')[\s\S])*'{3,5}|"(?:\\[^\r\n]|[^"\\\r\n])*"|'[^'\r\n]*'))/gmu;
        let relocatedConfig: string | undefined;
        for (const match of originalConfig.matchAll(assignments)) {
          const valueStart = match.index + match[1]!.length;
          const candidate =
            originalConfig.slice(0, valueStart) +
            JSON.stringify(relocatedSqliteHome) +
            originalConfig.slice(valueStart + match[2]!.length);
          try {
            if (isDeepStrictEqual(parseToml(candidate), expectedConfig)) {
              relocatedConfig = candidate;
              break;
            }
          } catch {
            // A textual candidate is not authoritative without TOML equivalence.
          }
        }
        if (relocatedConfig === undefined)
          throw new Error("Cannot safely relocate the native Codex sqlite_home assignment");
        sourceFileWrites.push({
          filePath: copiedConfigPath,
          content: relocatedConfig,
          mode: configMode,
        });
      }
    }
    const names = await fs.readdir(destination).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    for (const name of names) {
      if (!/^synara-shared-continuation-v.*\.json$/u.test(name)) continue;
      const version =
        name === SYNARA_SHARED_CONTINUATION_MARKER_FILE
          ? 2
          : name === LEGACY_SYNARA_SHARED_CONTINUATION_MARKER_FILE
            ? 1
            : undefined;
      if (!version) throw new Error("Unknown Codex shared continuation marker");
      const filePath = path.join(destination, name);
      const originalPath = path.join(source, name);
      const originalStat = await fs.lstat(originalPath);
      const copiedStat = await fs.lstat(filePath);
      if (
        !originalStat.isFile() ||
        originalStat.isSymbolicLink() ||
        !copiedStat.isFile() ||
        copiedStat.isSymbolicLink()
      )
        throw new Error("Codex source marker is not a regular file");
      const original = await fs.readFile(originalPath, "utf8");
      parseCodexSharedContinuationMarker(original, sourceIdentity, version);
      const copied = await fs.readFile(filePath, "utf8");
      // Retain optional/unknown metadata and the exact generation spelling.
      const rebound = `${JSON.stringify({ ...JSON.parse(original), sourceHomeIdentity: destinationIdentity })}\n`;
      if (copied !== original && copied !== rebound)
        throw new Error("Copied Codex source marker differs from its recovery source");
      if (copied !== rebound)
        sourceFileWrites.push({ filePath, content: rebound, mode: copiedStat.mode & 0o777 });
    }
  }
  for (const { filePath, content, mode: fileMode } of sourceFileWrites)
    await replaceCopiedFile(filePath, content, fileMode);
  for (const [from, to] of overlayMoves) await mergeOverlay(from, to, true);
  for (const filePath of incomingAliases) {
    const plan = copiedAliasPlans.get(filePath)!;
    const current = await fs.lstat(filePath);
    if (
      !current.isSymbolicLink() ||
      current.dev !== plan.device ||
      current.ino !== plan.inode ||
      (await fs.readlink(filePath)) !== plan.originalLink
    )
      throw new Error("Copied Codex incoming alias changed during migration");
    const temporaryPath = `${filePath}.relocating-${randomUUID()}`;
    await fs.symlink(plan.linkTarget, temporaryPath, plan.type);
    try {
      await fs.rename(temporaryPath, filePath);
      await syncDirectoryEntry(path.dirname(filePath));
    } finally {
      await fs.rm(temporaryPath, { force: true });
    }
  }
  if (!changed) return;
  await replaceCopiedFile(settingsPath, `${JSON.stringify(document)}\n`, mode);
}

export async function migrateLegacyLinxHome(input: {
  consent: boolean;
  sourceHomePath: string;
  sourceUserDataPath: string;
  homePath: string;
  userDataPath: string;
  recoveryDirectoryPath: string;
  sourceVersion: string;
  preview: boolean;
  /** Real Electron extraction by default; injectable only for isolated filesystem tests. */
  transferStorage?: (input: {
    isolatedSourceProfilePath: string;
    userDataPath: string;
    preview: boolean;
  }) => Promise<SynaraStorageSnapshot>;
}): Promise<{ recoveryDirectoryPath: string; reauthenticationNotice: string }> {
  if (input.consent !== true) throw new Error("Legacy import requires explicit consent");
  const sourceHomePath = await canonicalLinxDataPath(input.sourceHomePath);
  const sourceUserDataPath = await canonicalLinxDataPath(input.sourceUserDataPath);
  const homePath = await canonicalLinxDataPath(input.homePath);
  const userDataPath = await canonicalLinxDataPath(input.userDataPath);
  // Pin exactly the legacy/new product lanes, not an arbitrary workspace import.
  if (
    path.basename(sourceHomePath) !==
      (input.preview ? ".synara-workbench-preview" : ".synara-workbench") ||
    path.basename(sourceUserDataPath) !== (input.preview ? "workbench-preview" : "workbench")
  ) {
    throw new Error("Legacy import source is not the approved Workbench identity");
  }
  for (const target of [homePath, userDataPath]) {
    const entries = await fs.readdir(target).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    if (entries.length) throw new Error(`Linx import target is not empty: ${target}`);
  }
  await requireOfflineProfile(sourceUserDataPath);
  // The old server owns this SAME lock for its whole lifetime. Acquiring it is
  // the offline proof, not two idle samples or an untrusted caller assertion.
  const sourceDatabasePath = path.join(sourceHomePath, "userdata", "state.sqlite");
  const sourceDatabase = await fs.lstat(sourceDatabasePath);
  if (!sourceDatabase.isFile() || sourceDatabase.isSymbolicLink())
    throw new Error("Legacy database is not a real file");
  const destinationGuard = await Effect.runPromise(
    acquireDatabaseLifecycleLock(`${homePath}.linx-import`),
  );
  let sourceLock: DatabaseLifecycleLock | undefined;
  let releaseProfile: (() => Promise<void>) | undefined;
  let scratch: string | undefined;
  try {
    sourceLock = await Effect.runPromise(acquireDatabaseLifecycleLock(sourceDatabasePath));
    releaseProfile = await acquireOfflineProfile(sourceUserDataPath);
    await requirePortableBrowserVault(sourceHomePath);
    const attemptId = randomUUID();
    scratch = await fs.mkdtemp(
      path.join(path.dirname(input.recoveryDirectoryPath), ".linx-origin-extract-"),
    );
    const offlineProfilePath = path.join(scratch, "offline-profile");
    await snapshotLinxOfflineUserData({
      userDataPath: sourceUserDataPath,
      snapshotDirectoryPath: offlineProfilePath,
    });
    const recovery = await createLinxUpdateRecoverySet({
      recoveryDirectoryPath: input.recoveryDirectoryPath,
      homePath: sourceHomePath,
      userDataPath: sourceUserDataPath,
      userDataSnapshotPath: offlineProfilePath,
      userDataSnapshotFormat: "offline-profile",
      sourceVersion: input.sourceVersion,
      attemptId,
    });
    // Sibling journal survives even a partial home restore; bootstrap fails closed.
    const journalPath = `${homePath}.linx-migration.json`;
    const journal = { schemaVersion: 1, status: "importing", attemptId, sourceHomePath, homePath };
    const journalHandle = await fs.open(journalPath, "wx", 0o600);
    try {
      await journalHandle.writeFile(`${JSON.stringify(journal)}\n`);
      await journalHandle.sync();
    } finally {
      await journalHandle.close();
    }
    await syncDirectoryEntry(path.dirname(homePath));
    await restoreLinxUpdateRecoverySetToEmptyTargets({
      recoveryDirectoryPath: input.recoveryDirectoryPath,
      homePath,
      userDataPath,
    });
    await relocateCopiedProviderSettings(homePath, [sourceHomePath, input.sourceHomePath]);
    // Import into new-origin IndexedDB without ever opening or mutating the old profile.
    const isolatedSourceProfilePath = path.join(scratch, "profile");
    await copyLinxLegacyProfileForExtraction(
      input.recoveryDirectoryPath,
      isolatedSourceProfilePath,
    );
    const snapshot = validateSynaraStorageSnapshot(
      await (input.transferStorage ?? transferLinxLegacyStorage)({
        isolatedSourceProfilePath,
        userDataPath,
        preview: input.preview,
      }),
    );
    if (!snapshot)
      throw new Error("Legacy storage transfer did not produce a valid bounded snapshot");
    // The copied old-origin handoff, if any, is itself recoverable evidence; do not overwrite it.
    const snapshotPath = resolveSynaraStorageSnapshotPath(userDataPath);
    const previous = await fs
      .readFile(snapshotPath, "utf8")
      .catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
    const entries: Record<string, string> = { ...snapshot.entries };
    if (previous !== null) {
      const previousSnapshot = validateSynaraStorageSnapshot(JSON.parse(previous));
      if (!previousSnapshot) throw new Error("Previous legacy storage handoff is corrupt");
      for (const [key, value] of Object.entries(previousSnapshot.entries)) {
        if (entries[key] !== undefined && entries[key] !== value)
          throw new Error(
            "Conflicting legacy browser handoff requires recovery, not a silent merge",
          );
        entries[key] = value;
      }
    }
    const bounded = validateSynaraStorageSnapshot({ ...snapshot, entries });
    if (!bounded) throw new Error("Combined legacy handoff exceeds storage bounds");
    const relocated = relocateSynaraStorageSnapshotPaths(bounded, {
      sourceHomePath,
      homePath,
      sourceAliases: [input.sourceHomePath],
    });
    await fs.writeFile(snapshotPath, `${JSON.stringify(relocated)}\n`, {
      mode: 0o600,
      flush: true,
    });
    // Startup consumes this through native metadata commands; no event or applied
    // migration SQL is rewritten. Until complete, bootstrap must block all producers.
    await fs.writeFile(
      path.join(homePath, RECEIPT),
      `${JSON.stringify({
        schemaVersion: 1,
        status: "paths-pending",
        attemptId: recovery.attemptId,
        sourceHomePath,
        homePath,
        sourceUserDataPath,
        userDataPath,
        recoveryDirectoryPath: path.resolve(input.recoveryDirectoryPath),
        importedAt: new Date().toISOString(),
        reauthenticationNotice: LINX_MIGRATION_REAUTHENTICATION_NOTICE,
      })}\n`,
      { flag: "wx", mode: 0o600, flush: true },
    );
    await fs.writeFile(
      journalPath,
      `${JSON.stringify({ ...journal, status: "paths-pending" })}\n`,
      { mode: 0o600, flush: true },
    );
    return {
      recoveryDirectoryPath: input.recoveryDirectoryPath,
      reauthenticationNotice: LINX_MIGRATION_REAUTHENTICATION_NOTICE,
    };
  } finally {
    try {
      if (scratch) await fs.rm(scratch, { recursive: true, force: true });
    } finally {
      try {
        if (releaseProfile) await releaseProfile();
      } finally {
        try {
          if (sourceLock) await Effect.runPromise(releaseDatabaseLifecycleLock(sourceLock));
        } finally {
          await Effect.runPromise(releaseDatabaseLifecycleLock(destinationGuard));
        }
      }
    }
  }
}
