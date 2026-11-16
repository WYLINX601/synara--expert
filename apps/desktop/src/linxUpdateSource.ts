// FILE: linxUpdateSource.ts
// Purpose: The single configuration entry for the Linx (workbench) update source.
// Layer: Desktop updater configuration
// Depends on: node:fs and the shared LU-00 key ring loader.

import FS from "node:fs";

import type { SynaraDesktopFlavor } from "@synara/shared/desktopIdentity";

import {
  loadLinxUpdateKeyRing,
  type LinxUpdateTrustedKeys,
} from "@synara/shared/linxUpdateManifestVerification";

export const LINX_UPDATE_SOURCE_FILE_NAME = "linx-update-source.json";
export const LINX_UPDATE_MANIFEST_FILE_NAME = "linx-update.json";
export const LINX_UPDATE_SIGNATURE_FILE_NAME = `${LINX_UPDATE_MANIFEST_FILE_NAME}.sig`;

/**
 * Manifest and signature live on the fixed "latest release" path; asset URLs
 * inside a verified manifest may point at the release download page, which
 * redirects to the GitHub CDN. Nothing else is reachable.
 */
export const LINX_UPDATE_RELEASE_BASE_URL = "https://github.com";
export const LINX_UPDATE_ALLOWED_HOSTS: readonly string[] = [
  "github.com",
  "api.github.com",
  "release-assets.githubusercontent.com",
  "objects.githubusercontent.com",
];

const SOURCE_FIELDS: Readonly<Record<string, true>> = { repository: true, keyRing: true };
// `owner/repo` with no scheme, path suffix, whitespace, or empty segment.
// Without the `m` flag, `$` is end-of-input only, so a trailing line terminator
// cannot slip through.
const REPOSITORY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/u;
const SOURCE_MAX_BYTES = 64 * 1024;

export interface LinxUpdateSource {
  /** Fixed `owner/repo` release repository; never inferred. */
  readonly repository: string;
  /** Trusted Ed25519 public keys, loaded and self-checked by `keyId`. */
  readonly keyRing: LinxUpdateTrustedKeys;
  readonly manifestUrl: string;
  readonly signatureUrl: string;
  /** Human-facing releases page, used only for a manual download fallback. */
  readonly releaseUrl: string;
  /** Hosts a manifest `assetUrl` may use. */
  readonly allowedAssetHosts: readonly string[];
}

export function buildLinxUpdateManifestUrl(repository: string): string {
  return `${LINX_UPDATE_RELEASE_BASE_URL}/${repository}/releases/latest/download/${LINX_UPDATE_MANIFEST_FILE_NAME}`;
}

export function buildLinxUpdateSignatureUrl(repository: string): string {
  return `${LINX_UPDATE_RELEASE_BASE_URL}/${repository}/releases/latest/download/${LINX_UPDATE_SIGNATURE_FILE_NAME}`;
}

export function buildLinxUpdateReleaseUrl(repository: string): string {
  return `${LINX_UPDATE_RELEASE_BASE_URL}/${repository}/releases/latest`;
}

/**
 * Parses `linx-update-source.json`:
 * `{ "repository": "owner/repo", "keyRing": { "<keyId>": "<base64 SPKI>" } }`.
 *
 * Returns `null` for anything missing or invalid — an unconfigured or broken
 * file must never be repaired by guessing a repository or embedding a key.
 */
export function parseLinxUpdateSource(raw: string): LinxUpdateSource | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }

  const entries = parsed as Record<string, unknown>;
  for (const key of Object.keys(entries)) {
    if (SOURCE_FIELDS[key] !== true) return null;
  }

  const repository = entries.repository;
  if (typeof repository !== "string" || !REPOSITORY_PATTERN.test(repository)) {
    return null;
  }

  const rawKeyRing = entries.keyRing;
  if (typeof rawKeyRing !== "object" || rawKeyRing === null || Array.isArray(rawKeyRing)) {
    return null;
  }

  let keyRing: LinxUpdateTrustedKeys;
  try {
    keyRing = loadLinxUpdateKeyRing(JSON.stringify(rawKeyRing));
  } catch {
    return null;
  }
  if (keyRing.size === 0) {
    return null;
  }

  return {
    repository,
    keyRing,
    manifestUrl: buildLinxUpdateManifestUrl(repository),
    signatureUrl: buildLinxUpdateSignatureUrl(repository),
    releaseUrl: buildLinxUpdateReleaseUrl(repository),
    allowedAssetHosts: [...LINX_UPDATE_ALLOWED_HOSTS],
  };
}

/** Reads the packaged source file; a missing, oversized, or invalid file is unconfigured. */
export function loadLinxUpdateSource(filePath: string): LinxUpdateSource | null {
  let raw: string;
  try {
    raw = FS.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
  if (raw.length > SOURCE_MAX_BYTES) {
    return null;
  }
  return parseLinxUpdateSource(raw);
}

/**
 * The only flavor allowed to run the Linx client, and only with a packaged
 * source file. Every other flavor keeps its existing updater, and a missing or
 * invalid file leaves the client inert instead of guessing a repository.
 */
export function resolveLinxUpdateSourceForFlavor(input: {
  readonly flavor: SynaraDesktopFlavor;
  readonly sourcePath: string | null;
  readonly load?: (path: string) => LinxUpdateSource | null;
}): LinxUpdateSource | null {
  if (input.flavor !== "workbench") return null;
  if (input.sourcePath === null) return null;
  return (input.load ?? loadLinxUpdateSource)(input.sourcePath);
}
