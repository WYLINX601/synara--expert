import * as fs from "node:fs/promises";
import * as path from "node:path";
import { crc32, inflateRawSync } from "node:zlib";
import YAML from "yaml";

export const SKILL_FILE_LIMIT = 16 * 1024 * 1024;
export const SKILL_PACKAGE_LIMIT = 100 * 1024 * 1024;
export function assertSkillResourcePath(value: string): void {
  if (
    !value ||
    value.length > 4096 ||
    value
      .split("/")
      .some(
        (part) =>
          !part ||
          part === "." ||
          part === ".." ||
          /[\\\p{Cc}:<>"|?*]/u.test(part) ||
          /[. ]$/u.test(part) ||
          /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part),
      )
  ) {
    throw new Error(`Unsafe Skill resource path: ${value}`);
  }
}

type SkillArchiveFile = { name: string; data: Buffer; executable: boolean; directory: boolean };
/** Read only explicitly selected entries, validating their bytes before any write. */
function readSkillArchive(
  bytes: Buffer,
  include?: (name: string, mode: number) => boolean,
): SkillArchiveFile[] {
  if (bytes.length > SKILL_PACKAGE_LIMIT || bytes.length < 22)
    throw new Error("Invalid or oversized Skill archive.");
  let end = bytes.length - 22;
  while (end >= Math.max(0, bytes.length - 65557) && bytes.readUInt32LE(end) !== 0x06054b50) end--;
  if (end < Math.max(0, bytes.length - 65557)) throw new Error("ZIP directory is missing.");
  if (
    bytes.readUInt16LE(end + 4) ||
    bytes.readUInt16LE(end + 6) ||
    bytes.readUInt16LE(end + 8) !== bytes.readUInt16LE(end + 10)
  )
    throw new Error("Multi-volume ZIP is unsupported.");
  const count = bytes.readUInt16LE(end + 10),
    offset = bytes.readUInt32LE(end + 16),
    size = bytes.readUInt32LE(end + 12);
  if (
    (!include && count > 5000) ||
    offset + size !== end ||
    end + 22 + bytes.readUInt16LE(end + 20) !== bytes.length
  )
    throw new Error("Invalid ZIP directory or entry limit exceeded.");
  const files: SkillArchiveFile[] = [];
  const seen = new Set<string>();
  let cursor = offset,
    total = 0;
  for (let index = 0; index < count; index++) {
    if (cursor + 46 > end || bytes.readUInt32LE(cursor) !== 0x02014b50)
      throw new Error("Invalid ZIP entry.");
    const flags = bytes.readUInt16LE(cursor + 8),
      method = bytes.readUInt16LE(cursor + 10),
      compressed = bytes.readUInt32LE(cursor + 20),
      expanded = bytes.readUInt32LE(cursor + 24),
      nameLength = bytes.readUInt16LE(cursor + 28),
      extraLength = bytes.readUInt16LE(cursor + 30),
      commentLength = bytes.readUInt16LE(cursor + 32),
      mode = bytes.readUInt32LE(cursor + 38) >>> 16,
      local = bytes.readUInt32LE(cursor + 42);
    const next = cursor + 46 + nameLength + extraLength + commentLength;
    if (next > end) throw new Error("Invalid ZIP entry bounds.");
    const rawName = bytes.subarray(cursor + 46, cursor + 46 + nameLength),
      decoded = rawName.toString("utf8"),
      directory = decoded.endsWith("/"),
      name = directory ? decoded.slice(0, -1) : decoded;
    if (!Buffer.from(decoded).equals(rawName)) throw new Error("ZIP names must be UTF-8.");
    assertSkillResourcePath(name);
    if (include && !include(name, mode)) {
      cursor = next;
      continue;
    }
    if (
      files.length >= 5000 ||
      flags & 1 ||
      ![0, 8].includes(method) ||
      expanded > SKILL_FILE_LIMIT ||
      (mode & 0xf000) === 0xa000 ||
      ((mode & 0xf000) !== 0 && ![0x4000, 0x8000].includes(mode & 0xf000))
    )
      throw new Error("Encrypted, linked, special, oversized or unsupported ZIP entry.");
    const folded = name.normalize("NFC").toLowerCase();
    if (seen.has(folded)) throw new Error("ZIP contains duplicate or colliding paths.");
    seen.add(folded);
    total += expanded;
    if (total > SKILL_PACKAGE_LIMIT) throw new Error("ZIP expansion exceeds 100 MiB.");
    if (local + 30 > offset || bytes.readUInt32LE(local) !== 0x04034b50)
      throw new Error("Invalid ZIP local entry.");
    const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
    if (
      start + compressed > offset ||
      !bytes.subarray(local + 30, local + 30 + bytes.readUInt16LE(local + 26)).equals(rawName)
    )
      throw new Error("ZIP local and directory identities differ.");
    const data =
      method === 0
        ? bytes.subarray(start, start + compressed)
        : inflateRawSync(bytes.subarray(start, start + compressed), {
            maxOutputLength: Math.max(1, expanded),
          });
    if (
      data.length !== expanded ||
      crc32(data) !== bytes.readUInt32LE(cursor + 16) ||
      (directory && expanded !== 0)
    )
      throw new Error("ZIP entry size mismatch.");
    files.push({ name, data, executable: (mode & 0o111) !== 0, directory });
    cursor = next;
  }
  if (cursor !== end) throw new Error("Invalid ZIP directory size.");
  for (const file of files)
    for (
      let parent = path.posix.dirname(file.name);
      parent !== ".";
      parent = path.posix.dirname(parent)
    ) {
      if (files.some((candidate) => candidate.name === parent && !candidate.directory))
        throw new Error("ZIP file/directory collision.");
    }
  return files;
}

/** Validate the selected directory before writing. Never execute package content. */
export async function extractSkillArchive(
  bytes: Buffer,
  destination: string,
  selectedPrefix?: string,
): Promise<void> {
  const files = readSkillArchive(
    bytes,
    selectedPrefix
      ? (name) => name === selectedPrefix.replace(/\/$/u, "") || name.startsWith(selectedPrefix)
      : undefined,
  );
  for (const file of files) {
    const target = path.join(destination, ...file.name.split("/"));
    await fs.mkdir(file.directory ? target : path.dirname(target), {
      recursive: true,
      mode: 0o700,
    });
    if (!file.directory)
      await fs.writeFile(target, file.data, { flag: "wx", mode: file.executable ? 0o700 : 0o600 });
  }
}

const SOURCE_HOSTS = new Set([
  "github.com",
  "api.github.com",
  "codeload.github.com",
  "raw.githubusercontent.com",
  "skills.sh",
  "clawhub.ai",
  "clawhub.com",
  "www.clawhub.ai",
  "www.clawhub.com",
]);
export async function fetchSkillSource(
  url: string,
  maxBytes = SKILL_PACKAGE_LIMIT,
  signal?: AbortSignal,
): Promise<Buffer> {
  for (let redirects = 0; redirects < 6; redirects++) {
    const target = new URL(url);
    if (
      target.protocol !== "https:" ||
      target.username ||
      target.password ||
      target.port ||
      !SOURCE_HOSTS.has(target.hostname)
    )
      throw new Error("Unsupported Skill source or unsafe download target.");
    const response = await fetch(target, {
      redirect: "manual",
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(30_000)])
        : AbortSignal.timeout(30_000),
      headers: {
        "User-Agent": "Synara-Skill-Import",
        Accept: "application/json, application/zip;q=0.9, */*;q=0.1",
      },
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      const location = response.headers.get("location");
      if (!location) throw new Error("Source redirect has no location.");
      url = new URL(location, target).href;
      continue;
    }
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw new Error(`Skill source returned HTTP ${response.status}.`);
    }
    if (Number(response.headers.get("content-length") ?? 0) > maxBytes) {
      await response.body.cancel();
      throw new Error("Skill source is too large.");
    }
    const reader = response.body.getReader(),
      chunks: Uint8Array[] = [];
    let length = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        length += chunk.value.length;
        if (length > maxBytes) throw new Error("Skill download exceeds its size limit.");
        chunks.push(chunk.value);
      }
    } finally {
      await reader.cancel();
    }
    return Buffer.concat(chunks);
  }
  throw new Error("Too many Skill source redirects.");
}

export interface DownloadedSkillSource {
  readonly root: string;
  readonly canonicalLocation: string;
  readonly resolvedRevision: string;
  readonly skillName?: string;
}
export function normalizeSkillSourceUrl(location: string): string {
  let url: URL;
  try {
    url = new URL(location);
  } catch {
    throw new Error("Invalid Skill source URL.");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    ![
      "github.com",
      "skills.sh",
      "www.skills.sh",
      "clawhub.ai",
      "clawhub.com",
      "www.clawhub.ai",
      "www.clawhub.com",
    ].includes(url.hostname) ||
    url.search
  )
    throw new Error(
      "Skill sources require a public HTTPS URL without credentials or query parameters.",
    );
  url.hash = "";
  url.hostname = url.hostname.replace(/^www\./u, "");
  url.pathname = url.pathname.replace(/\/+$/u, "");
  return url.href;
}
async function githubSource(
  url: URL,
  destination: string,
  signal?: AbortSignal,
  skillName?: string,
): Promise<DownloadedSkillSource> {
  const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if (parts.length < 2 || !parts.slice(0, 2).every((part) => /^[\w.-]+$/u.test(part)))
    throw new Error("Invalid GitHub Skill URL.");
  if (parts.some((part) => part.includes("/")))
    throw new Error(
      "GitHub URL contains an encoded path separator; use a normal tree path or a full commit SHA.",
    );
  const repo = `${parts[0]}/${parts[1]!.replace(/\.git$/u, "")}`;
  let ref = "HEAD",
    remaining: string[] = [];
  if (parts.length > 2) {
    if (!["tree", "blob"].includes(parts[2]!) || !parts[3])
      throw new Error("Select a GitHub repository, tree or SKILL.md blob URL.");
    const tail = parts.slice(3);
    ref = tail[0]!;
    let refSegments = 1;
    if (!/^[a-f0-9]{40}$/u.test(ref)) {
      const candidates: string[] = [];
      for (const kind of ["heads", "tags"]) {
        const data: unknown = JSON.parse(
          (
            await fetchSkillSource(
              `https://api.github.com/repos/${repo}/git/matching-refs/${kind}/${encodeURIComponent(ref)}`,
              1024 * 1024,
              signal,
            )
          ).toString("utf8"),
        );
        if (!Array.isArray(data))
          throw new Error(
            "GitHub ref lookup was unrecognized; use a URL pinned to a full commit SHA.",
          );
        for (const value of data)
          if (value && typeof value === "object" && typeof value.ref === "string") {
            const candidate = value.ref.replace(new RegExp(`^refs/${kind}/`), "");
            if (tail.join("/") === candidate || tail.join("/").startsWith(`${candidate}/`))
              candidates.push(candidate);
          }
      }
      const distinct = [...new Set(candidates)];
      if (distinct.length !== 1)
        throw new Error(
          "GitHub branch or tag is missing or ambiguous; use a URL pinned to a full commit SHA.",
        );
      ref = distinct[0]!;
      refSegments = ref.split("/").length;
    }
    remaining = tail.slice(refSegments);
    if (parts[2] === "blob" && remaining.at(-1) !== "SKILL.md")
      throw new Error("GitHub blob imports require SKILL.md.");
    if (remaining.at(-1) === "SKILL.md") remaining = remaining.slice(0, -1);
  }
  const commit = JSON.parse(
    (
      await fetchSkillSource(
        `https://api.github.com/repos/${repo}/commits/${encodeURIComponent(ref)}`,
        1024 * 1024,
        signal,
      )
    ).toString("utf8"),
  ) as { sha?: string };
  if (!commit.sha || !/^[a-f0-9]{40}$/u.test(commit.sha))
    throw new Error("GitHub did not return a fixed source revision.");
  if (remaining.length) assertSkillResourcePath(remaining.join("/"));
  const archiveRoot = `${parts[1]!.replace(/\.git$/u, "")}-${commit.sha}`;
  const archive = await fetchSkillSource(
    `https://codeload.github.com/${repo}/zip/${commit.sha}`,
    SKILL_PACKAGE_LIMIT,
    signal,
  );
  if (skillName) {
    const candidates = readSkillArchive(
      archive,
      (name, mode) => path.posix.basename(name) === "SKILL.md" && (mode & 0xf000) !== 0xa000,
    );
    const matches = candidates.filter((file) => {
      const metadata = /^---\s*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(
        file.data.toString("utf8"),
      );
      let name: unknown;
      try {
        const parsed: unknown = metadata
          ? YAML.parse(metadata[1]!, { logLevel: "error" })
          : undefined;
        name =
          parsed && typeof parsed === "object" && !Array.isArray(parsed)
            ? (parsed as { name?: unknown }).name
            : undefined;
      } catch {
        /* Invalid metadata cannot identify a selected source. */
      }
      return name === skillName || path.posix.basename(path.posix.dirname(file.name)) === skillName;
    });
    if (matches.length !== 1)
      throw new Error(
        "Skills.sh source entry disappeared or is ambiguous; use an exact GitHub Skill directory URL.",
      );
    const directory = path.posix.dirname(matches[0]!.name);
    if (directory !== archiveRoot && !directory.startsWith(`${archiveRoot}/`))
      throw new Error("GitHub returned an unexpected archive root.");
    remaining = directory === archiveRoot ? [] : directory.slice(archiveRoot.length + 1).split("/");
  }
  const prefix = remaining.length ? `${archiveRoot}/${remaining.join("/")}/` : undefined;
  await extractSkillArchive(archive, destination, prefix);
  const root = path.join(destination, archiveRoot, ...remaining);
  const stat = await fs.lstat(root);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new Error("GitHub Skill directory is missing or unsafe.");
  return { root, canonicalLocation: url.href, resolvedRevision: commit.sha };
}
export async function downloadSkillSource(
  location: string,
  destination: string,
  signal?: AbortSignal,
): Promise<DownloadedSkillSource> {
  const canonicalLocation = normalizeSkillSourceUrl(location),
    url = new URL(canonicalLocation),
    parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if (url.hostname === "skills.sh") {
    if (parts.length !== 3 || !parts.every((part) => /^[\w.-]+$/u.test(part)))
      throw new Error("Select a Skills.sh owner/repository/skill URL.");
    const source = await githubSource(
      new URL(`https://github.com/${parts[0]}/${parts[1]}`),
      destination,
      signal,
      parts[2]!,
    );
    return { ...source, canonicalLocation, skillName: parts[2]! };
  }
  if (url.hostname === "github.com") return githubSource(url, destination, signal);
  if (["clawhub.ai", "clawhub.com"].includes(url.hostname)) {
    const slug = parts.at(-1);
    if (!slug || !/^[\w-]+$/u.test(slug)) throw new Error("Invalid ClawHub Skill URL.");
    if (
      !(parts.length === 1 || parts.length === 2 || (parts.length === 3 && parts[1] === "skills"))
    )
      throw new Error("Select a ClawHub publisher/skills/slug URL.");
    const owner = parts.length > 1 ? parts[0] : undefined;
    if (owner && !/^[\w.-]+$/u.test(owner)) throw new Error("Invalid ClawHub publisher identity.");
    const ownerQuery = owner ? `?ownerHandle=${encodeURIComponent(owner)}` : "";
    const metadata = JSON.parse(
      (
        await fetchSkillSource(
          `https://${url.hostname}/api/v1/skills/${encodeURIComponent(slug)}${ownerQuery}`,
          1024 * 1024,
          signal,
        )
      ).toString("utf8"),
    ) as { latestVersion?: { version?: unknown }; owner?: { handle?: unknown } };
    if (owner && metadata.owner?.handle !== owner)
      throw new Error("ClawHub returned a different or ambiguous publisher identity.");
    if (typeof metadata.owner?.handle !== "string" || !/^[\w.-]+$/u.test(metadata.owner.handle))
      throw new Error("ClawHub returned no verifiable publisher identity.");
    const resolvedOwner = metadata.owner.handle,
      resolvedLocation = `https://${url.hostname}/${resolvedOwner}/skills/${slug}`;
    const version = metadata.latestVersion?.version;
    if (
      version !== undefined &&
      (typeof version !== "string" || !/^[0-9A-Za-z.+-]{1,200}$/u.test(version))
    )
      throw new Error("ClawHub did not return a supported source version.");
    const bytes = await fetchSkillSource(
      `https://${url.hostname}/api/v1/download?slug=${encodeURIComponent(slug)}&ownerHandle=${encodeURIComponent(resolvedOwner)}${typeof version === "string" ? `&version=${encodeURIComponent(version)}` : ""}`,
      SKILL_PACKAGE_LIMIT,
      signal,
    );
    if (bytes[0] === 0x7b) {
      const handoff = JSON.parse(bytes.toString("utf8")) as {
        sourceRef?: string;
        repo?: unknown;
        commit?: unknown;
        path?: unknown;
      };
      if (
        handoff.sourceRef !== "public-github" ||
        typeof handoff.repo !== "string" ||
        !/^[\w.-]+\/[\w.-]+$/u.test(handoff.repo) ||
        typeof handoff.commit !== "string" ||
        !/^[a-f0-9]{40}$/u.test(handoff.commit) ||
        typeof handoff.path !== "string"
      )
        throw new Error("Unsupported ClawHub source handoff.");
      if (handoff.path) assertSkillResourcePath(handoff.path);
      const result = await githubSource(
        new URL(`https://github.com/${handoff.repo}/tree/${handoff.commit}/${handoff.path}`),
        destination,
        signal,
      );
      return { ...result, canonicalLocation: resolvedLocation };
    }
    if (typeof version !== "string")
      throw new Error("ClawHub hosted archive has no verifiable version.");
    const root = path.join(destination, "package");
    await fs.mkdir(root, { mode: 0o700 });
    await extractSkillArchive(bytes, root);
    return { root, canonicalLocation: resolvedLocation, resolvedRevision: version };
  }
  throw new Error("Supported remote sources are GitHub, Skills.sh and ClawHub.");
}
