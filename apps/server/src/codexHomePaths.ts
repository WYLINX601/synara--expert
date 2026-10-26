// FILE: codexHomePaths.ts
// Purpose: Pure helpers that mirror how codexAppServerManager.ts decides which
//          CODEX_HOME directory the codex app-server child process runs against.
//          Centralizing this lets consumers outside the manager (the local image
//          allowlist, image-path predictions, etc.) stay in sync with the actual
//          runtime so they don't 404 paths Codex legitimately wrote.
// Layer: Server utility (no IO; safe to import from anywhere)
// Exports: overlay constants, base/overlay home resolvers, write-home + allowlist helpers.

import { createHash } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";

import { expandProviderAccountHomePath } from "./providerAccountHomePath.ts";

export const SYNARA_CODEX_HOME_OVERLAY_DIR = "codex-home-overlay";
export const SYNARA_CODEX_HOME_ACCOUNT_OVERLAYS_DIR = "accounts";
export const SYNARA_CODEX_HOME_FIXED_EXPERT_DIR = "fixed-expert-native";

export interface CodexHomePathsInput {
  readonly env?: NodeJS.ProcessEnv;
  readonly homePath?: string;
  readonly shadowHomePath?: string;
  readonly accountId?: string;
  readonly fixedExpertNativeDiscovery?: boolean;
}

export function resolveBaseCodexHomePath(
  env: NodeJS.ProcessEnv,
  explicitHomePath?: string,
): string {
  return expandProviderAccountHomePath(
    explicitHomePath?.trim() || env.CODEX_HOME?.trim() || path.join(homedir(), ".codex"),
  );
}

export function resolveSynaraCodexHomeOverlayPath(
  env: NodeJS.ProcessEnv,
  sourceHomePath: string,
  accountSegment?: string,
  fixedExpertNativeDiscovery = false,
): string {
  const runtimeHome = env.SYNARA_HOME?.trim();
  const overlayRoot = runtimeHome || path.join(path.dirname(sourceHomePath), ".synara", "runtime");
  const overlayHome = path.join(overlayRoot, SYNARA_CODEX_HOME_OVERLAY_DIR);
  const accountOverlay = accountSegment
    ? path.join(overlayHome, SYNARA_CODEX_HOME_ACCOUNT_OVERLAYS_DIR, accountSegment)
    : overlayHome;
  return fixedExpertNativeDiscovery
    ? path.join(accountOverlay, SYNARA_CODEX_HOME_FIXED_EXPERT_DIR)
    : accountOverlay;
}

/** Recognizes Synara overlay path shapes; callers must validate ownership markers and links. */
export function isSynaraCodexHomeOverlayPath(
  env: NodeJS.ProcessEnv,
  sourceHomePath: string,
  candidateHomePath: string,
): boolean {
  const candidate = path.resolve(candidateHomePath);
  // A nested Synara instance can inherit its parent's overlay while using a
  // different runtime home. Recognize the stable overlay root shape here;
  // callers prove that it belongs to the claimed source before adopting it.
  if (path.basename(candidate) === SYNARA_CODEX_HOME_OVERLAY_DIR) return true;
  if (
    path.basename(candidate) === SYNARA_CODEX_HOME_FIXED_EXPERT_DIR &&
    (path.basename(path.dirname(candidate)) === SYNARA_CODEX_HOME_OVERLAY_DIR ||
      (path.basename(path.dirname(path.dirname(candidate))) ===
        SYNARA_CODEX_HOME_ACCOUNT_OVERLAYS_DIR &&
        path.basename(path.dirname(path.dirname(path.dirname(candidate)))) ===
          SYNARA_CODEX_HOME_OVERLAY_DIR))
  ) {
    return true;
  }
  const overlayRoot = resolveSynaraCodexHomeOverlayPath(env, sourceHomePath);
  const relative = path.relative(overlayRoot, candidate);
  if (!relative) return true;
  if (path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`))
    return false;
  const parts = relative.split(path.sep);
  if (parts.length === 1) return parts[0] === SYNARA_CODEX_HOME_FIXED_EXPERT_DIR;
  if (parts[0] !== SYNARA_CODEX_HOME_ACCOUNT_OVERLAYS_DIR || !parts[1]) return false;
  return (
    parts.length === 2 || (parts.length === 3 && parts[2] === SYNARA_CODEX_HOME_FIXED_EXPERT_DIR)
  );
}

export function resolveCodexHomeOverlayAccountSegment(
  input: Pick<CodexHomePathsInput, "accountId" | "homePath" | "shadowHomePath">,
): string | undefined {
  const accountId = input.accountId?.trim();
  const shadowHomePath = input.shadowHomePath?.trim();
  if ((!accountId || accountId === "default") && !shadowHomePath) {
    return undefined;
  }

  const label = (accountId || "shadow").replace(/[^A-Za-z0-9_-]+/g, "-").slice(0, 32) || "codex";
  const digest = createHash("sha256")
    .update(accountId ?? "")
    .update("\0")
    .update(input.homePath ?? "")
    .update("\0")
    .update(shadowHomePath ?? "")
    .digest("hex")
    .slice(0, 12);
  return `${label}-${digest}`;
}

/**
 * Returns the home directory that the codex app-server child process actually
 * writes under. Synara keeps its generated config isolated from the user's
 * source Codex home while linking shared state such as authentication.
 */
export function resolveActiveCodexHomeWritePath(input: CodexHomePathsInput = {}): string {
  const env = input.env ?? process.env;
  const configuredHome = resolveBaseCodexHomePath(env, input.homePath);
  const sqliteHome = env.CODEX_SQLITE_HOME?.trim();
  const source =
    !input.homePath?.trim() &&
    sqliteHome &&
    isSynaraCodexHomeOverlayPath(env, sqliteHome, configuredHome)
      ? resolveBaseCodexHomePath(env, sqliteHome)
      : configuredHome;
  const accountSegment = resolveCodexHomeOverlayAccountSegment({
    homePath: source,
    ...(input.accountId ? { accountId: input.accountId } : {}),
    ...(input.shadowHomePath
      ? { shadowHomePath: resolveBaseCodexHomePath(env, input.shadowHomePath) }
      : {}),
  });
  if (!input.homePath?.trim() && isSynaraCodexHomeOverlayPath(env, source, configuredHome)) {
    return configuredHome;
  }
  const overlay = resolveSynaraCodexHomeOverlayPath(
    env,
    source,
    accountSegment,
    input.fixedExpertNativeDiscovery,
  );
  return path.resolve(source) === path.resolve(overlay) ? source : overlay;
}

/**
 * Returns every Codex home directory we should treat as legitimate when
 * allowlisting locally-generated image files: the source home and the overlay
 * home if they are distinct. Callers pre-`realpath`-resolve these as needed.
 *
 * The overlay candidate remains included so generated images from earlier
 * sessions stay serveable until they are removed.
 */
export function resolveCodexHomeAllowlistCandidates(
  input: CodexHomePathsInput = {},
): readonly string[] {
  const env = input.env ?? process.env;
  const configuredHome = resolveBaseCodexHomePath(env, input.homePath);
  const sqliteHome = env.CODEX_SQLITE_HOME?.trim();
  const source =
    !input.homePath?.trim() &&
    sqliteHome &&
    isSynaraCodexHomeOverlayPath(env, sqliteHome, configuredHome)
      ? resolveBaseCodexHomePath(env, sqliteHome)
      : configuredHome;
  const shadow = input.shadowHomePath
    ? resolveBaseCodexHomePath(env, input.shadowHomePath)
    : undefined;
  const accountSegment = resolveCodexHomeOverlayAccountSegment({
    homePath: source,
    ...(input.accountId ? { accountId: input.accountId } : {}),
    ...(shadow ? { shadowHomePath: shadow } : {}),
  });
  const overlay = resolveSynaraCodexHomeOverlayPath(env, source, accountSegment);
  const fixedOverlay = resolveSynaraCodexHomeOverlayPath(env, source, accountSegment, true);
  const legacyOverlay = resolveSynaraCodexHomeOverlayPath(env, source);
  const sourceResolved = path.resolve(source);
  const overlayResolved = path.resolve(overlay);
  const candidates = sourceResolved === overlayResolved ? [source] : [source, overlay];
  if (
    path.resolve(fixedOverlay) !== overlayResolved &&
    !candidates.some((candidate) => path.resolve(candidate) === path.resolve(fixedOverlay))
  ) {
    candidates.push(fixedOverlay);
  }
  if (
    !input.homePath?.trim() &&
    isSynaraCodexHomeOverlayPath(env, source, configuredHome) &&
    !candidates.some((candidate) => path.resolve(candidate) === path.resolve(configuredHome))
  ) {
    candidates.push(configuredHome);
  }
  if (
    path.resolve(legacyOverlay) !== overlayResolved &&
    !candidates.some((candidate) => path.resolve(candidate) === path.resolve(legacyOverlay))
  ) {
    candidates.push(legacyOverlay);
  }
  if (shadow && !candidates.some((candidate) => path.resolve(candidate) === path.resolve(shadow))) {
    candidates.push(shadow);
  }
  return candidates;
}
