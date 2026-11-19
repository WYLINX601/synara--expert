import { createHash } from "node:crypto";
import { spawnProcessSync } from "@synara/shared/processRuntime";
import {
  createReadStream,
  createWriteStream,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { Readable } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { pipeline } from "node:stream/promises";
import { Schema } from "effect";
import { LinxUpdateManifest, compareLinxUpdateVersions } from "@synara/contracts";
import {
  loadLinxUpdateKeyRing,
  verifyLinxUpdateManifest,
} from "@synara/shared/linxUpdateManifestVerification";
import { hashFile } from "./lib/file-digest.ts";
import {
  linxUpdateKeyIdForPrivateKey,
  signLinxUpdateManifestBytes,
} from "./lib/linx-update-manifest-signing.ts";
import {
  assertLinxSigningKeyLineage,
  LINX_RELEASE_REPOSITORY,
  LINX_UPDATE_SOURCE_PATH,
  readLinxProductVersion,
  readLinxReleaseSource,
  validateLinxReleaseSource,
  type LinxReleaseSource,
} from "./lib/linx-release-source.ts";
import {
  assertImmutableCandidate,
  assertReviewerProtection,
  candidateBytes,
  candidateDigest,
  parseCandidate,
  type LinxReleaseCandidate,
} from "./lib/linx-release-candidate.ts";
import { verifyReleaseArtifactCheckpoint } from "./lib/release-artifact-checkpoint.ts";
import { selectLinxRelease, verifyLinxReleaseOperation } from "./lib/linx-release-remote.ts";
const Asset = Schema.Struct({
  id: Schema.Number,
  name: Schema.String,
  size: Schema.Number,
  url: Schema.String,
  browser_download_url: Schema.String,
});
type GitHubAsset = typeof Asset.Type;
const Release = Schema.Struct({
  id: Schema.Number,
  tag_name: Schema.String,
  target_commitish: Schema.String,
  draft: Schema.Boolean,
  prerelease: Schema.Boolean,
  html_url: Schema.String,
  upload_url: Schema.String,
  assets: Schema.Array(Asset),
});
type GitHubRelease = typeof Release.Type;
const decodeRelease = Schema.decodeUnknownSync(Release);
const decodeAssets = Schema.decodeUnknownSync(Schema.Array(Asset));
const decodeReleases = Schema.decodeUnknownSync(Schema.Array(Release));
// Node and fetch expose equivalent Web Stream interfaces from different libraries.
const nodeBody = (body: ReadableStream<Uint8Array>) =>
  Readable.fromWeb(body as unknown as NodeReadableStream<Uint8Array>);

const root = resolve(import.meta.dirname, "..");
const repository = LINX_RELEASE_REPOSITORY;
const apiRoot = `https://api.github.com/repos/${repository}`;
const [command, directoryArg, digestArg] = process.argv.slice(2);
const directory = resolve(directoryArg || "release-publish");
const token = process.env.GH_TOKEN;
const headers = (anonymous = false): Record<string, string> => ({
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
  ...(!anonymous && token ? { Authorization: `Bearer ${token}` } : {}),
});
async function api(
  path: string,
  options: { method?: string; body?: unknown; anonymous?: boolean } = {},
): Promise<unknown> {
  const response = await fetch(path ? `${apiRoot}/${path}` : apiRoot, {
    method: options.method || "GET",
    headers: {
      ...headers(options.anonymous),
      ...(options.body ? { "Content-Type": "application/json" } : {}),
    },
    ...(options.body ? { body: JSON.stringify(options.body) } : {}),
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok)
    throw new Error(`GitHub ${options.method || "GET"} ${path}: ${response.status}`);
  return response.status === 204 ? null : response.json();
}
async function assetBytes(asset: GitHubAsset | undefined, anonymous = false): Promise<Uint8Array> {
  if (!asset) throw new Error("Required release asset is missing.");
  const response = await fetch(anonymous ? asset.browser_download_url : asset.url, {
    headers: anonymous ? {} : { ...headers(), Accept: "application/octet-stream" },
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) throw new Error(`Cannot fetch ${asset.name}: ${response.status}`);
  if (asset.size > 1024 * 1024) throw new Error("Metadata exceeds bound.");
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length !== asset.size) throw new Error("Metadata size changed.");
  return bytes;
}
async function allReleases(anonymous = false): Promise<GitHubRelease[]> {
  const releases: GitHubRelease[] = [];
  for (let page = 1; ; page++) {
    const batch = decodeReleases(await api(`releases?per_page=100&page=${page}`, { anonymous }));
    releases.push(...batch);
    if (batch.length < 100) return releases;
  }
}
async function findReleaseByTag(tag: string, anonymous = false): Promise<GitHubRelease | null> {
  return selectLinxRelease(await allReleases(anonymous), tag, !anonymous);
}
async function inventory(release: GitHubRelease): Promise<GitHubAsset[]> {
  const assets: GitHubAsset[] = [];
  for (let page = 1; ; page++) {
    const batch = decodeAssets(
      await api(`releases/${release.id}/assets?per_page=100&page=${page}`),
    );
    assets.push(...batch);
    if (batch.length < 100) return assets;
  }
}
async function verifyRemoteAssets(
  release: GitHubRelease,
  candidate: LinxReleaseCandidate,
  anonymous = false,
): Promise<void> {
  const assets = anonymous ? release.assets : await inventory(release);
  const expectedNames = [...candidate.assets.map((asset) => asset.fileName), "linx-candidate.json"];
  if (
    assets.length !== expectedNames.length ||
    new Set(assets.map((asset) => asset.name)).size !== assets.length ||
    assets.some((asset) => !expectedNames.includes(asset.name))
  )
    throw new Error("Remote candidate asset inventory changed or incomplete.");
  const descriptor = assets.find((asset) => asset.name === "linx-candidate.json");
  const remoteCandidate = parseCandidate(
    JSON.parse(Buffer.from(await assetBytes(descriptor, anonymous)).toString("utf8")),
  );
  assertImmutableCandidate(candidate, remoteCandidate);
  for (const asset of candidate.assets) {
    const remote = assets.find((entry) => entry.name === asset.fileName);
    if (!remote || remote.size !== asset.size)
      throw new Error(`Remote size changed: ${asset.fileName}`);
    const response = await fetch(anonymous ? remote.browser_download_url : remote.url, {
      headers: anonymous ? {} : { ...headers(), Accept: "application/octet-stream" },
      signal: AbortSignal.timeout(30 * 60_000),
    });
    if (!response.ok || !response.body)
      throw new Error(`Remote asset unavailable: ${asset.fileName}`);
    let size = 0;
    const hash = createHash("sha256");
    for await (const chunk of nodeBody(response.body)) {
      size += chunk.length;
      if (size > asset.size) throw new Error("Remote asset exceeds signed size.");
      hash.update(chunk);
    }
    if (size !== asset.size || hash.digest("hex") !== asset.sha256)
      throw new Error(`Remote digest changed: ${asset.fileName}`);
  }
}
async function verifyRemote(
  release: GitHubRelease,
  candidate: LinxReleaseCandidate,
  anonymous = false,
  publish?: () => Promise<void>,
): Promise<void> {
  await verifyLinxReleaseOperation({
    release,
    candidate,
    api,
    anonymous,
    verify: () => verifyRemoteAssets(release, candidate, anonymous),
    ...(publish ? { publish } : {}),
  });
}
/**
 * Post-publication proof does not need the REST API: resolve the immutable tag
 * with git, then stream every public asset by its fixed release URL. This keeps
 * validation working when GitHub rate-limits anonymous API callers.
 */
async function verifyPublicCandidate(candidate: LinxReleaseCandidate): Promise<void> {
  const tags = spawnProcessSync(
    "git",
    [
      "-c",
      "credential.helper=",
      "ls-remote",
      "--tags",
      `https://github.com/${repository}.git`,
      `refs/tags/${candidate.tag}`,
      `refs/tags/${candidate.tag}^{}`,
    ],
    {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 1024 * 1024,
      timeout: 60_000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    },
  );
  if (tags.error || tags.status !== 0)
    throw new Error(`Unable to resolve the public ${candidate.tag} tag.`);
  const rows = tags.stdout
    .trim()
    .split("\n")
    .map((line) => line.split("\t"))
    .filter((row) => row.length === 2 && row[1]!.startsWith("refs/tags/"));
  const direct = rows.find(([, ref]) => ref === `refs/tags/${candidate.tag}`)?.[0];
  const peeled = rows.find(([, ref]) => ref === `refs/tags/${candidate.tag}^{}`)?.[0];
  if ((peeled ?? direct) !== candidate.sourceCommit)
    throw new Error("The public tag does not name the candidate source commit.");

  const manifest = Schema.decodeUnknownSync(LinxUpdateManifest)(
    JSON.parse(readFileSync(join(directory, "linx-update.json"), "utf8")),
  );
  if (
    manifest.channel !== "stable" ||
    manifest.version !== candidate.version ||
    manifest.sourceCommit !== candidate.sourceCommit ||
    manifest.assetName !== `Linx-${candidate.version}-arm64.zip`
  )
    throw new Error("The public manifest is not the stable candidate.");

  const allowedHosts = new Set([
    "github.com",
    "release-assets.githubusercontent.com",
    "objects.githubusercontent.com",
  ]);
  const expectedNames = [...candidate.assets.map((asset) => asset.fileName), "linx-candidate.json"];
  for (const name of expectedNames) {
    const response = await fetch(
      `https://github.com/${repository}/releases/download/${candidate.tag}/${encodeURIComponent(name)}`,
      {
        headers: { "user-agent": "linx-release-validator", Accept: "application/octet-stream" },
        signal: AbortSignal.timeout(30 * 60_000),
      },
    );
    if (!response.ok || !response.body)
      throw new Error(`Public asset unavailable: ${name} (${response.status})`);
    const finalHost = new URL(response.url).hostname;
    if (!allowedHosts.has(finalHost)) throw new Error(`Unexpected public asset host: ${finalHost}`);
    let size = 0;
    const hash = createHash("sha256");
    for await (const chunk of nodeBody(response.body)) {
      size += chunk.length;
      hash.update(chunk);
    }
    const expected = name === "linx-candidate.json" ? Buffer.from(candidateBytes(candidate)) : null;
    const asset = candidate.assets.find((entry) => entry.fileName === name);
    if (expected) {
      if (
        size !== expected.byteLength ||
        hash.digest("hex") !== createHash("sha256").update(expected).digest("hex")
      )
        throw new Error(`Public candidate descriptor changed: ${name}`);
    } else if (!asset || size !== asset.size || hash.digest("hex") !== asset.sha256) {
      throw new Error(`Public candidate asset changed: ${name}`);
    }
  }
}
function git(...args: string[]): string {
  const result = spawnProcessSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`Git ${args[0]} failed (${result.signal ?? result.status}).`);
  return result.stdout.trim();
}
async function priorSource(source: LinxReleaseSource, version: string) {
  let previous: GitHubRelease | null = null;
  for (const release of await allReleases()) {
    if (
      release.draft ||
      release.prerelease ||
      !release.assets.some((asset) => asset.name === "linx-update.json")
    )
      continue;
    if (!/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(release.tag_name))
      throw new Error("Invalid prior Linx release tag.");
    const order =
      previous === null
        ? 1
        : compareLinxUpdateVersions(release.tag_name.slice(1), previous.tag_name.slice(1));
    if (order === null) throw new Error("Invalid prior Linx release version.");
    if (order > 0) previous = release;
  }
  if (!previous) {
    if (process.env.LINX_BOOTSTRAP_SOURCE_COMMIT !== git("rev-parse", "HEAD"))
      throw new Error(
        "First release requires independently approved LINX_BOOTSTRAP_SOURCE_COMMIT and public trust root.",
      );
    return source;
  }
  const find = (name: string) => {
    const assets = previous!.assets.filter((asset) => asset.name === name);
    if (assets.length !== 1) throw new Error(`Prior release requires exactly one ${name}.`);
    return assets[0];
  };
  const manifestBytes = await assetBytes(find("linx-update.json"));
  const signatureBytes = await assetBytes(find("linx-update.json.sig"));
  if (!/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(previous.tag_name))
    throw new Error("Invalid prior Linx release tag.");
  const priorCommit = git("rev-parse", `${previous.tag_name}^{commit}`);
  git("merge-base", "--is-ancestor", priorCommit, "HEAD");
  const trusted = validateLinxReleaseSource(
    JSON.parse(git("show", `${priorCommit}:${LINX_UPDATE_SOURCE_PATH}`)),
  );
  const verified = verifyLinxUpdateManifest({
    manifestBytes,
    signatureBytes,
    keyRing: loadLinxUpdateKeyRing(JSON.stringify(trusted.keyRing)),
    currentVersion: "0.0.0",
    allowedAssetHosts: ["github.com"],
  });
  if (!verified.ok) throw new Error(`Prior release signature rejected: ${verified.reason}`);
  const parsed = verified.manifest;
  const priorConfig = Schema.decodeUnknownSync(
    Schema.Struct({ versions: Schema.Struct({ workbench: Schema.String }) }),
  )(JSON.parse(git("show", `${priorCommit}:workbench/build-config.json`)));
  if (priorConfig.versions.workbench !== parsed.version)
    throw new Error("Authenticated prior product config/version mismatch.");
  const order = compareLinxUpdateVersions(version, parsed.version);
  if (
    previous.tag_name !== `v${parsed.version}` ||
    order === null ||
    order <= 0 ||
    priorCommit !== parsed.sourceCommit
  )
    throw new Error("Prior release source/tag/version mismatch or release is not increasing.");
  return trusted;
}
async function readCandidate(): Promise<LinxReleaseCandidate> {
  const candidate = parseCandidate(
    JSON.parse(readFileSync(join(directory, "linx-candidate.json"), "utf8")),
  );
  candidateBytes(candidate);
  if (
    candidate.version !== readLinxProductVersion(root) ||
    candidate.sourceCommit !== git("rev-parse", "HEAD") ||
    candidate.lockfileSha256 !== (await hashFile(join(root, "bun.lock"))) ||
    candidate.runId !== process.env.GITHUB_RUN_ID
  )
    throw new Error("Candidate belongs to different source/lock/run.");
  for (const asset of candidate.assets)
    if (
      statSync(join(directory, asset.fileName)).size !== asset.size ||
      (await hashFile(join(directory, asset.fileName))) !== asset.sha256
    )
      throw new Error("Local candidate bytes changed.");
  return candidate;
}
async function upload(release: GitHubRelease, name: string) {
  const path = join(directory, name);
  // fetch accepts a Web Stream body with half-duplex in both Node and Bun.
  const body = Readable.toWeb(createReadStream(path)) as unknown as RequestInit["body"];
  const response = await fetch(
    `${release.upload_url.split("{")[0]}?name=${encodeURIComponent(name)}`,
    {
      method: "POST",
      headers: {
        ...headers(),
        "Content-Type": "application/octet-stream",
        "Content-Length": String(statSync(path).size),
      },
      body,
      duplex: "half",
      signal: AbortSignal.timeout(30 * 60_000),
    },
  );
  if (!response.ok) throw new Error(`Upload ${name} failed: ${response.status}`);
}
async function stage() {
  const version = readLinxProductVersion(root);
  const source = readLinxReleaseSource(root);
  const tag = `v${version}`;
  const found = await findReleaseByTag(tag);
  if (found) {
    const existing = found;
    // Never rebuild, resign, or overwrite an existing candidate. Restore exact bytes.
    const assets = await inventory(existing);
    const descriptor = assets.find((asset) => asset.name === "linx-candidate.json");
    if (!descriptor)
      throw new Error(
        "Incomplete draft has no immutable candidate; inspect and retire it manually.",
      );
    const candidate = parseCandidate(
      JSON.parse(Buffer.from(await assetBytes(descriptor)).toString("utf8")),
    );
    candidateBytes(candidate);
    if (
      candidate.sourceCommit !== git("rev-parse", "HEAD") ||
      candidate.runId !== process.env.GITHUB_RUN_ID ||
      candidate.lockfileSha256 !== (await hashFile(join(root, "bun.lock"))) ||
      candidate.version !== version
    )
      throw new Error("Existing candidate has different source/run binding.");
    await verifyRemote(existing, candidate);
    output(candidate, existing);
    return;
  }
  const sourceCommit = git("rev-parse", "HEAD");
  if (git("rev-parse", `${tag}^{commit}`) !== sourceCommit)
    throw new Error("Exact release tag required.");
  const lockfileSha256 = await hashFile(join(root, "bun.lock"));
  await verifyReleaseArtifactCheckpoint({
    assetsDirectory: directory,
    platform: "mac",
    arch: "arm64",
    target: "dmg",
    flavor: "workbench",
    version,
    sourceCommit,
    sourceTag: tag,
    lockfileSha256,
    publication: true,
  });
  const privateKey = process.env.LINX_UPDATE_PRIVATE_KEY;
  if (!privateKey) throw new Error("Protected signing key is unavailable.");
  const keyId = linxUpdateKeyIdForPrivateKey(privateKey);
  assertLinxSigningKeyLineage(source, keyId, await priorSource(source, version));
  const assetName = `Linx-${version}-arm64.zip`;
  const manifest = Schema.decodeUnknownSync(LinxUpdateManifest)({
    schemaVersion: 1,
    productId: "linx",
    installIdentity: "com.wylinx.linx",
    channel: "stable",
    version,
    sourceCommit,
    platform: "darwin",
    arch: "arm64",
    minOSVersion: "13.0",
    assetName,
    assetUrl: `https://github.com/${repository}/releases/download/${tag}/${assetName}`,
    size: statSync(join(directory, assetName)).size,
    sha256: await hashFile(join(directory, assetName)),
    keyId,
  });
  const bytes = `${JSON.stringify(manifest, null, 2)}\n`;
  writeFileSync(join(directory, "linx-update.json"), bytes, { flag: "wx" });
  writeFileSync(
    join(directory, "linx-update.json.sig"),
    `${signLinxUpdateManifestBytes(Buffer.from(bytes), privateKey)}\n`,
    { flag: "wx" },
  );
  writeFileSync(
    join(directory, "linx-update-source.json"),
    `${JSON.stringify(source, null, 2)}\n`,
    { flag: "wx" },
  );
  const candidate: LinxReleaseCandidate = {
    schemaVersion: 1,
    repository,
    version,
    tag,
    sourceCommit,
    lockfileSha256,
    runId: process.env.GITHUB_RUN_ID || "",
    assets: await Promise.all(
      readdirSync(directory).map(async (fileName) => ({
        fileName,
        size: statSync(join(directory, fileName)).size,
        sha256: await hashFile(join(directory, fileName)),
      })),
    ),
  };
  writeFileSync(join(directory, "linx-candidate.json"), candidateBytes(candidate), { flag: "wx" });
  const release = decodeRelease(
    await api("releases", {
      method: "POST",
      body: {
        tag_name: tag,
        target_commitish: sourceCommit,
        name: `Linx ${tag}`,
        draft: true,
        prerelease: false,
        body: `Candidate SHA-256: ${candidateDigest(candidate)}\nSource: ${sourceCommit}\nRun: ${candidate.runId}\n\nAd-hoc structural signature only; not Apple notarized. Preserve system protections. See docs/release.md for recovery.`,
      },
    }),
  );
  // Descriptor is uploaded last: partial drafts cannot masquerade as complete candidates.
  for (const asset of candidate.assets) await upload(release, asset.fileName);
  await upload(release, "linx-candidate.json");
  await verifyRemote(release, candidate);
  output(candidate, release);
}
function output(candidate: LinxReleaseCandidate, release: GitHubRelease) {
  const digest = candidateDigest(candidate);
  console.log(`Candidate ${candidate.tag}: ${digest}\n${release.html_url}`);
  if (process.env.GITHUB_OUTPUT)
    writeFileSync(process.env.GITHUB_OUTPUT, `digest=${digest}\nurl=${release.html_url}\n`, {
      flag: "a",
    });
  if (process.env.GITHUB_STEP_SUMMARY)
    writeFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `## Linx candidate ${candidate.tag}\n\nSHA-256: \`${digest}\`\n\nSource: \`${candidate.sourceCommit}\`\n\n[Review draft](${release.html_url})\n`,
      { flag: "a" },
    );
}
if (command === "protection") {
  if (!token) throw new Error("Authenticated environment inspection token required.");
  const repo = Schema.decodeUnknownSync(Schema.Struct({ visibility: Schema.String }))(
    await api(""),
  );
  if (repo.visibility !== "public" || process.env.GITHUB_REPOSITORY !== repository)
    throw new Error("Approved public repository required.");
  for (const name of ["linx-signing", "linx-publish"])
    assertReviewerProtection(await api(`environments/${name}`));
} else if (command === "stage") {
  await stage();
} else if (command === "promote" || command === "validate") {
  const candidate = await readCandidate();
  if (candidateDigest(candidate) !== digestArg)
    throw new Error("Approved candidate digest mismatch.");
  if (command === "validate") {
    await verifyPublicCandidate(candidate);
  } else {
    const release = await findReleaseByTag(candidate.tag);
    if (!release) throw new Error(`Release ${candidate.tag} is unavailable.`);
    await verifyRemote(
      release,
      candidate,
      false,
      release.draft
        ? async () => {
            await api(`releases/${release.id}`, {
              method: "PATCH",
              body: { draft: false, make_latest: "true" },
            });
          }
        : undefined,
    );
  }
} else if (command === "restore") {
  const tag = `v${readLinxProductVersion(root)}`;
  const release = await findReleaseByTag(tag);
  if (!release) throw new Error(`Release ${tag} is unavailable.`);
  const assets = await inventory(release);
  const descriptor = assets.find((asset) => asset.name === "linx-candidate.json");
  const descriptorBytes = await assetBytes(descriptor);
  const approved = parseCandidate(JSON.parse(Buffer.from(descriptorBytes).toString("utf8")));
  if (
    candidateDigest(approved) !== digestArg ||
    approved.sourceCommit !== git("rev-parse", "HEAD") ||
    approved.runId !== process.env.GITHUB_RUN_ID ||
    approved.lockfileSha256 !== (await hashFile(join(root, "bun.lock")))
  )
    throw new Error("Restore is not the approved source/run/digest.");
  await verifyLinxReleaseOperation({
    release,
    candidate: approved,
    api,
    verify: async () => {
      if (
        assets.length !== approved.assets.length + 1 ||
        new Set(assets.map((asset) => asset.name)).size !== assets.length
      )
        throw new Error("Restore inventory changed.");
      for (const asset of assets) {
        if (asset.name === "linx-candidate.json") {
          writeFileSync(join(directory, asset.name), descriptorBytes, { flag: "wx" });
          continue;
        }
        const expected = approved.assets.find((entry) => entry.fileName === asset.name);
        if (!expected || expected.size !== asset.size) throw new Error("Unexpected restore asset.");
        const response = await fetch(asset.url, {
          headers: { ...headers(), Accept: "application/octet-stream" },
          signal: AbortSignal.timeout(30 * 60_000),
        });
        if (!response.ok || !response.body) throw new Error("Candidate restore failed.");
        await pipeline(
          nodeBody(response.body),
          createWriteStream(join(directory, asset.name), { flags: "wx" }),
        );
      }
      await readCandidate();
    },
  });
} else
  throw new Error(
    "Usage: bun scripts/linx-release.ts protection|stage|restore|promote|validate [assets-directory] [approved-digest]",
  );
