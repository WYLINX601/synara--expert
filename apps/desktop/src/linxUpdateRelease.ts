import { createHash } from "node:crypto";
import { Schema } from "effect";

import {
  LINX_UPDATE_MANIFEST_MAX_BYTES,
  LINX_UPDATE_SIGNATURE_MAX_BYTES,
  LinxUpdateReleaseReceipt,
  LinxUpdateRepository,
  LinxUpdateSourceCommit,
  PositiveInt,
  type LinxUpdateManifest,
} from "@synara/contracts";
import { verifyLinxUpdateManifest } from "@synara/shared/linxUpdateManifestVerification";

import { fetchLinxUpdateBytes } from "./linxUpdateFeed";
import {
  LINX_UPDATE_MANIFEST_FILE_NAME,
  LINX_UPDATE_SIGNATURE_FILE_NAME,
  type LinxUpdateSource,
} from "./linxUpdateSource";

const METADATA_MAX_BYTES = 256 * 1024;
const GitHubId = PositiveInt.check(Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER));
const Asset = Schema.Struct({
  id: GitHubId,
  name: Schema.String,
  size: PositiveInt,
  state: Schema.String,
  browser_download_url: Schema.String,
});
const Release = Schema.Struct({
  id: GitHubId,
  tag_name: Schema.String,
  draft: Schema.Boolean,
  prerelease: Schema.Boolean,
  published_at: Schema.String,
  html_url: Schema.String,
  assets: Schema.Array(Asset).check(Schema.isMaxLength(64)),
});
const GitObject = Schema.Struct({
  type: Schema.Literals(["commit", "tag"]),
  sha: LinxUpdateSourceCommit,
});
const Reference = Schema.Struct({ ref: Schema.String, object: GitObject });
const Tag = Schema.Struct({ sha: LinxUpdateSourceCommit, object: GitObject });
const utf8 = new TextDecoder("utf-8", { fatal: true });
const BINDINGS = [
  "repository",
  "tagName",
  "releaseId",
  "tagObjectSha",
  "sourceCommit",
  "packageAssetId",
  "manifestAssetId",
  "signatureAssetId",
  "manifestDigest",
  "packageSha256",
] as const;

export interface LinxUpdateSignedTarget {
  readonly manifest: LinxUpdateManifest;
  readonly manifestBytes: Uint8Array;
  readonly signatureBytes: Uint8Array;
  readonly manifestDigest: string;
}

interface ReleaseInput extends LinxUpdateSignedTarget {
  readonly source: LinxUpdateSource;
  readonly fetchBytes?: (url: string, maxBytes: number) => Promise<Uint8Array>;
  readonly now?: () => Date;
}

function fetchBytes(input: ReleaseInput, url: string, maxBytes: number): Promise<Uint8Array> {
  return input.fetchBytes !== undefined
    ? input.fetchBytes(url, maxBytes)
    : fetchLinxUpdateBytes({ url, maxBytes, allowedHosts: input.source.allowedAssetHosts });
}

/** Fixed tag URLs cannot silently switch an already approved target to `latest`. */
export function linxUpdateTagAssetUrl(repository: string, version: string, name: string): string {
  return `https://github.com/${repository}/releases/download/v${version}/${encodeURIComponent(name)}`;
}

export async function resolveLinxUpdateReleaseReceipt(
  input: ReleaseInput,
): Promise<LinxUpdateReleaseReceipt> {
  const repository = Schema.decodeUnknownSync(LinxUpdateRepository)(input.source.repository);
  const tagName = `v${input.manifest.version}`;
  const api = `https://api.github.com/repos/${repository}`;
  const release = Schema.decodeUnknownSync(Release)(
    JSON.parse(
      utf8.decode(
        await fetchBytes(
          input,
          `${api}/releases/tags/${encodeURIComponent(tagName)}`,
          METADATA_MAX_BYTES,
        ),
      ),
    ),
  );
  if (
    release.draft ||
    release.prerelease ||
    release.tag_name !== tagName ||
    !Number.isFinite(Date.parse(release.published_at)) ||
    release.html_url !== `https://github.com/${repository}/releases/tag/${tagName}`
  ) {
    throw new Error("The selected Linx release is not the same public stable release.");
  }
  const reference = Schema.decodeUnknownSync(Reference)(
    JSON.parse(
      utf8.decode(
        await fetchBytes(
          input,
          `${api}/git/ref/tags/${encodeURIComponent(tagName)}`,
          METADATA_MAX_BYTES,
        ),
      ),
    ),
  );
  if (reference.ref !== `refs/tags/${tagName}`) throw new Error("The Linx tag reference changed.");
  const tagObjectSha = reference.object.sha;
  let object = reference.object;
  for (let depth = 0; object.type === "tag"; depth += 1) {
    if (depth >= 5) throw new Error("The Linx annotated tag chain exceeds the allowed depth.");
    const tag = Schema.decodeUnknownSync(Tag)(
      JSON.parse(
        utf8.decode(await fetchBytes(input, `${api}/git/tags/${object.sha}`, METADATA_MAX_BYTES)),
      ),
    );
    if (tag.sha !== object.sha)
      throw new Error("The Linx annotated tag response changed identity.");
    object = tag.object;
  }
  if (object.sha !== input.manifest.sourceCommit)
    throw new Error("The Linx tag does not name the signed source commit.");

  const expected = [
    { name: input.manifest.assetName, size: input.manifest.size },
    { name: LINX_UPDATE_MANIFEST_FILE_NAME, size: input.manifestBytes.byteLength },
    { name: LINX_UPDATE_SIGNATURE_FILE_NAME, size: input.signatureBytes.byteLength },
  ];
  const ids: number[] = [];
  for (const item of expected) {
    const matches = release.assets.filter((asset) => asset.name === item.name);
    const asset = matches[0];
    if (
      matches.length !== 1 ||
      asset === undefined ||
      asset.state !== "uploaded" ||
      asset.size !== item.size ||
      asset.browser_download_url !==
        linxUpdateTagAssetUrl(repository, input.manifest.version, item.name)
    ) {
      throw new Error("A selected Linx release asset was withdrawn or changed.");
    }
    ids.push(asset.id);
  }
  if (
    new Set(ids).size !== 3 ||
    input.manifest.assetUrl !==
      linxUpdateTagAssetUrl(repository, input.manifest.version, input.manifest.assetName)
  ) {
    throw new Error("The Linx package is not bound to the selected repository and release.");
  }
  if (createHash("sha256").update(input.manifestBytes).digest("hex") !== input.manifestDigest) {
    throw new Error("The pinned Linx manifest bytes changed.");
  }
  return Schema.decodeUnknownSync(LinxUpdateReleaseReceipt)({
    schemaVersion: 1,
    repository,
    tagName,
    releaseId: release.id,
    tagObjectSha,
    sourceCommit: object.sha,
    packageAssetId: ids[0],
    manifestAssetId: ids[1],
    signatureAssetId: ids[2],
    manifestDigest: input.manifestDigest,
    packageSha256: input.manifest.sha256,
    verifiedAt: (input.now?.() ?? new Date()).toISOString(),
  });
}

export async function revalidateLinxUpdateRelease(
  input: ReleaseInput & {
    readonly receipt: LinxUpdateReleaseReceipt;
    readonly currentVersion: string;
  },
): Promise<LinxUpdateReleaseReceipt> {
  const before = await resolveLinxUpdateReleaseReceipt(input);
  if (!BINDINGS.every((key) => before[key] === input.receipt[key])) {
    throw new Error("The selected Linx release or one of its immutable assets changed.");
  }
  const [manifestBytes, signatureBytes] = await Promise.all([
    fetchBytes(
      input,
      linxUpdateTagAssetUrl(
        input.source.repository,
        input.manifest.version,
        LINX_UPDATE_MANIFEST_FILE_NAME,
      ),
      LINX_UPDATE_MANIFEST_MAX_BYTES,
    ),
    fetchBytes(
      input,
      linxUpdateTagAssetUrl(
        input.source.repository,
        input.manifest.version,
        LINX_UPDATE_SIGNATURE_FILE_NAME,
      ),
      LINX_UPDATE_SIGNATURE_MAX_BYTES,
    ),
  ]);
  const result = verifyLinxUpdateManifest({
    manifestBytes,
    signatureBytes,
    keyRing: input.source.keyRing,
    currentVersion: input.currentVersion,
    allowedAssetHosts: input.source.allowedAssetHosts,
  });
  if (
    !result.ok ||
    createHash("sha256").update(manifestBytes).digest("hex") !== input.manifestDigest
  ) {
    throw new Error(
      "The selected Linx signed manifest was withdrawn, changed, or is no longer valid.",
    );
  }
  const after = await resolveLinxUpdateReleaseReceipt(input);
  if (!BINDINGS.every((key) => after[key] === input.receipt[key])) {
    throw new Error("The Linx release changed during online revalidation.");
  }
  return after;
}
