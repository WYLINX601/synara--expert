export const OFFICIAL_REPOSITORY = "https://github.com/Emanuele-web04/synara.git";
const API_ROOT = "https://api.github.com/repos/Emanuele-web04/synara/releases";
const PAGE_SIZE = 100;
const MAX_PAGES = 20;

export type StableRelease = {
  readonly tag: string;
  readonly publishedAt: string;
};

export type ReleaseFetcher = (input: string, init?: RequestInit) => Promise<Response>;

export class ReleaseMetadataError extends Error {
  constructor(
    readonly failure: "http" | "network" | "invalid-response" | "pagination-limit",
    readonly httpStatus?: number,
  ) {
    super(`Release metadata request failed: ${failure}`);
    this.name = "ReleaseMetadataError";
  }
}

type ReleaseRecord = {
  readonly draft?: unknown;
  readonly prerelease?: unknown;
  readonly tag_name?: unknown;
  readonly published_at?: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parsePublishedTime(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function parseRelease(value: unknown): StableRelease | null {
  if (!isRecord(value)) return null;
  const release = value as ReleaseRecord;
  if (release.draft !== false || release.prerelease !== false) return null;
  if (typeof release.tag_name !== "string" || release.tag_name.length === 0) return null;

  const publishedAt = parsePublishedTime(release.published_at);
  return publishedAt === null ? null : { tag: release.tag_name, publishedAt };
}

/** Selects the newest published stable release from GitHub's paginated release list. */
export async function fetchLatestStableRelease(
  fetcher: ReleaseFetcher = fetch,
): Promise<StableRelease> {
  const releases: StableRelease[] = [];

  for (let page = 1; page <= MAX_PAGES; page += 1) {
    let response: Response;
    try {
      response = await fetcher(`${API_ROOT}?per_page=${PAGE_SIZE}&page=${page}`, {
        headers: {
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "synara-workbench-sync",
        },
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      throw new ReleaseMetadataError("network");
    }

    if (!response.ok) throw new ReleaseMetadataError("http", response.status);

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new ReleaseMetadataError("invalid-response");
    }
    if (!Array.isArray(body)) throw new ReleaseMetadataError("invalid-response");

    for (const entry of body) {
      const release = parseRelease(entry);
      if (release !== null) releases.push(release);
    }

    if (body.length < PAGE_SIZE) break;
    if (page === MAX_PAGES) throw new ReleaseMetadataError("pagination-limit");
  }

  releases.sort((left, right) => right.publishedAt.localeCompare(left.publishedAt));
  const latest = releases[0];
  if (!latest) throw new ReleaseMetadataError("invalid-response");
  return latest;
}
