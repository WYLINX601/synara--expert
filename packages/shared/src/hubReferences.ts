import type { ProviderMentionReference } from "@synara/contracts";

export const HUB_REFERENCE_SCHEME = "synara://";
export const HUB_EXPERT_REFERENCE_PREFIX = "synara://expert/";
export const HUB_DELIVERABLE_REFERENCE_PREFIX = "synara://hub/";

export interface HubExpertReference {
  readonly kind: "expert";
  readonly expertId: string;
}

export interface HubDeliverableReference {
  readonly kind: "deliverable";
  readonly hubId: string;
  readonly workerThreadId: string;
  readonly path: string;
  readonly revision: number;
}

export type HubReference = HubExpertReference | HubDeliverableReference;

export interface SplitHubReferenceMentions {
  readonly references: readonly {
    readonly mention: ProviderMentionReference;
    readonly reference: HubReference;
  }[];
  readonly providerMentions: readonly ProviderMentionReference[];
  /** Values in the reserved URI namespace that fail strict canonical parsing. */
  readonly invalidMentions: readonly ProviderMentionReference[];
}

function validIdentifier(value: string): boolean {
  return (
    value.length > 0 && value.length <= 512 && value === value.trim() && !/[\p{Cc}/\\]/u.test(value)
  );
}

function encodeSegment(value: string): string {
  if (!validIdentifier(value)) throw new TypeError("Hub reference identifier is invalid.");
  return encodeURIComponent(value);
}

function decodeCanonicalSegment(value: string): string | null {
  try {
    const decoded = decodeURIComponent(value);
    if (!validIdentifier(decoded) || encodeURIComponent(decoded) !== value) return null;
    return decoded;
  } catch {
    return null;
  }
}

function normalizeSourcePath(value: string): string | null {
  if (
    value.length === 0 ||
    value.length > 2_048 ||
    value !== value.trim() ||
    value.startsWith("/") ||
    value.includes("\\") ||
    /[\p{Cc}]/u.test(value)
  ) {
    return null;
  }
  const segments = value.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    return null;
  }
  return value;
}

function encodePath(value: string): string {
  const normalized = normalizeSourcePath(value);
  if (normalized === null) throw new TypeError("Hub deliverable source path is invalid.");
  return normalized.split("/").map(encodeURIComponent).join("/");
}

function decodeCanonicalPath(value: string): string | null {
  const encodedSegments = value.split("/");
  if (encodedSegments.some((segment) => segment.length === 0)) return null;
  try {
    const decoded = encodedSegments.map(decodeURIComponent).join("/");
    if (normalizeSourcePath(decoded) !== decoded || encodePath(decoded) !== value) return null;
    return decoded;
  } catch {
    return null;
  }
}

export function buildHubExpertReferenceUri(expertId: string): string {
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/u.test(expertId)) {
    throw new TypeError("Expert reference id is invalid.");
  }
  return `${HUB_EXPERT_REFERENCE_PREFIX}${encodeSegment(expertId)}`;
}

export function buildHubDeliverableReferenceUri(input: {
  readonly hubId: string;
  readonly workerThreadId: string;
  readonly path: string;
  readonly revision: number;
}): string {
  if (!Number.isSafeInteger(input.revision) || input.revision <= 0) {
    throw new TypeError("Hub deliverable reference revision must be a positive integer.");
  }
  return `${HUB_DELIVERABLE_REFERENCE_PREFIX}${encodeSegment(input.hubId)}/deliverables/${encodeSegment(input.workerThreadId)}/${encodePath(input.path)}?revision=${input.revision}`;
}

/** True for the reserved app-reference namespace, including malformed and unsupported forms. */
export function isHubReferenceUri(value: string): boolean {
  return /^synara:/iu.test(value);
}

/** Parses only canonical, fully specified app references. Non-app paths return null. */
export function parseHubReferenceUri(value: string): HubReference | null {
  if (!isHubReferenceUri(value)) return null;

  if (value.startsWith(HUB_EXPERT_REFERENCE_PREFIX)) {
    const expertId = decodeCanonicalSegment(value.slice(HUB_EXPERT_REFERENCE_PREFIX.length));
    if (expertId === null || !/^[a-z0-9][a-z0-9_-]{0,63}$/u.test(expertId)) return null;
    return { kind: "expert", expertId };
  }

  const match =
    /^synara:\/\/hub\/([^/?#]+)\/deliverables\/([^/?#]+)\/(.+)\?revision=([1-9][0-9]*)$/u.exec(
      value,
    );
  if (!match) return null;
  const hubId = decodeCanonicalSegment(match[1]!);
  const workerThreadId = decodeCanonicalSegment(match[2]!);
  const path = decodeCanonicalPath(match[3]!);
  const revision = Number(match[4]);
  if (
    hubId === null ||
    workerThreadId === null ||
    path === null ||
    !Number.isSafeInteger(revision) ||
    revision <= 0
  ) {
    return null;
  }
  return { kind: "deliverable", hubId, workerThreadId, path, revision };
}

export function splitHubReferenceMentions(
  mentions: readonly ProviderMentionReference[] | undefined,
): SplitHubReferenceMentions {
  const references: Array<{ mention: ProviderMentionReference; reference: HubReference }> = [];
  const providerMentions: ProviderMentionReference[] = [];
  const invalidMentions: ProviderMentionReference[] = [];
  for (const mention of mentions ?? []) {
    if (!isHubReferenceUri(mention.path)) {
      providerMentions.push(mention);
      continue;
    }
    const reference = parseHubReferenceUri(mention.path);
    if (reference === null) invalidMentions.push(mention);
    else references.push({ mention, reference });
  }
  return { references, providerMentions, invalidMentions };
}
