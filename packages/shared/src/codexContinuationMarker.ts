export const LEGACY_SYNARA_SHARED_CONTINUATION_MARKER_FILE = "synara-shared-continuation-v1.json";
export const SYNARA_SHARED_CONTINUATION_MARKER_FILE = "synara-shared-continuation-v2.json";
export const SYNARA_SHARED_CONTINUATION_MARKER_VERSION = 2;
export const SYNARA_SHARED_CONTINUATION_GENERATION_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Parse exactly the source binding accepted by Codex continuation preparation.
 * V1 has no generation; only the runtime may upgrade it after validating state.
 */
export function parseCodexSharedContinuationMarker(
  content: string,
  sourceHomeIdentity: string,
  version: 1 | 2,
):
  | { version: 1; sourceHomeIdentity: string }
  | {
      version: 2;
      sourceHomeIdentity: string;
      generation: string;
      migratedFromVersion?: 1;
    } {
  let marker: unknown;
  try {
    marker = JSON.parse(content);
  } catch {
    throw new Error("Codex shared continuation marker is malformed.");
  }
  if (
    marker === null ||
    typeof marker !== "object" ||
    Array.isArray(marker) ||
    !("version" in marker) ||
    marker.version !== version ||
    !("sourceHomeIdentity" in marker) ||
    marker.sourceHomeIdentity !== sourceHomeIdentity
  ) {
    throw new Error(
      "Codex shared continuation marker is malformed or belongs to another source home.",
    );
  }
  if (version === 1) return { version: 1, sourceHomeIdentity };
  if (
    !("generation" in marker) ||
    typeof marker.generation !== "string" ||
    !SYNARA_SHARED_CONTINUATION_GENERATION_PATTERN.test(marker.generation) ||
    ("migratedFromVersion" in marker &&
      marker.migratedFromVersion !== undefined &&
      marker.migratedFromVersion !== 1)
  ) {
    throw new Error("Codex shared continuation marker generation is malformed.");
  }
  return {
    version: 2,
    sourceHomeIdentity,
    generation: marker.generation.toLowerCase(),
    ...("migratedFromVersion" in marker && marker.migratedFromVersion === 1
      ? { migratedFromVersion: 1 as const }
      : {}),
  };
}
