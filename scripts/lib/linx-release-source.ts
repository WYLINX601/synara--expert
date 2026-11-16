import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadLinxUpdateKeyRing } from "@synara/shared/linxUpdateManifestVerification";

export const LINX_RELEASE_REPOSITORY = "WYLINX601/synara--expert";
export const LINX_UPDATE_SOURCE_PATH = "workbench/linx-update-source.json";
export interface LinxReleaseSource {
  readonly repository: string;
  readonly keyRing: Readonly<Record<string, string>>;
}

export function validateLinxReleaseSource(value: unknown): LinxReleaseSource {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Missing trusted Linx public source.");
  const source = value as Record<string, unknown>;
  if (
    Object.keys(source).sort().join(",") !== "keyRing,repository" ||
    source.repository !== LINX_RELEASE_REPOSITORY
  )
    throw new Error(
      "Linx release source must name the approved repository and public key ring only.",
    );
  const keys = loadLinxUpdateKeyRing(JSON.stringify(source.keyRing));
  if (keys.size === 0) throw new Error("Linx release source requires real authorized public keys.");
  return source as unknown as LinxReleaseSource;
}

export function readLinxReleaseSource(repositoryRoot: string): LinxReleaseSource {
  return validateLinxReleaseSource(
    JSON.parse(readFileSync(join(repositoryRoot, LINX_UPDATE_SOURCE_PATH), "utf8")),
  );
}

/** priorSource must come from a verified previous manifest's sourceCommit, never a network key list. */
export function assertLinxSigningKeyLineage(
  current: LinxReleaseSource,
  signingKeyId: string,
  priorSource: LinxReleaseSource,
): void {
  validateLinxReleaseSource(current);
  validateLinxReleaseSource(priorSource);
  if (
    !current.keyRing[signingKeyId] ||
    current.keyRing[signingKeyId] !== priorSource.keyRing[signingKeyId]
  )
    throw new Error(
      "Signing key was not shipped in the authenticated prior release. Ship its public key with an old trusted key before activation.",
    );
}

export function readLinxProductVersion(repositoryRoot: string): string {
  const config = JSON.parse(
    readFileSync(join(repositoryRoot, "workbench/build-config.json"), "utf8"),
  );
  const version: unknown = config?.versions?.workbench;
  if (typeof version !== "string" || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version))
    throw new Error("Invalid Linx product version in workbench/build-config.json.");
  return version;
}
