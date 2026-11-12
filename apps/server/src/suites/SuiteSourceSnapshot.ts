import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { SuiteIssue, SuitePreviewInput, SuiteSource } from "@synara/contracts";

import {
  createFileResourceStore,
  compareResourcePaths,
  validateFileResourceManifest,
  type FileResourceEntry,
  type SealedFileResources,
} from "../experts/FileResourceStore";
import { expertResourceFiles } from "../experts/ExpertStore";
import {
  assertSkillResourcePath,
  readSkillArchive,
  fetchSkillSource,
  normalizeSkillSourceUrl,
  SKILL_PACKAGE_LIMIT,
} from "../experts/skillLibraryArchive";
import type { GitHubRepositorySnapshot } from "../git/Services/GitHubCli";
import { ensurePrivateDirectorySync, syncDirectoryEntry } from "../privatePathPermissions";
import { canonicalSuiteJson, suiteContentDigest } from "./suiteIdentity";

/** An action-scoped diagnostic, also used by import to preserve source failures. */
export class SuiteSourceError extends Error {
  constructor(
    readonly issue: SuiteIssue,
    options?: ErrorOptions,
  ) {
    super(issue.message, options);
  }
}
export function sourceIssue(
  code: SuiteIssue["code"],
  message: string,
  subject: SuiteIssue["subject"],
  effect: SuiteIssue["effect"] = "deny-action",
): SuiteIssue {
  if (message.length > 2000)
    throw new Error("Suite source diagnostic exceeds the 2,000-character budget.");
  return {
    code,
    category:
      code === "unsafe_path" || code === "permission_denied"
        ? "security"
        : code === "probe_error" || code === "probe_timeout"
          ? "unknown"
          : code === "resource_missing" || code === "resource_corrupt"
            ? "dependency"
            : "source",
    subject,
    action: "preview",
    effect,
    message,
    evidenceRef: null,
    checkedAt: new Date().toISOString(),
    recovery:
      code === "source_auth_required"
        ? "authorize"
        : code === "probe_error" || code === "probe_timeout" || code === "source_unreadable"
          ? "retry"
          : "repair-source",
  };
}
export interface SuiteSourceSnapshotOptions {
  readonly readGitHubSnapshot?: (input: {
    repository: string;
    requestedRef: string;
    subdirectory: string;
  }) => Promise<GitHubRepositorySnapshot>;
}
export interface CapturedSuiteSource {
  readonly rootPath: string;
  readonly source: SuiteSource;
  readonly contentHash: string;
}

export function createSuiteSourceSnapshot(
  stateDir: string,
  options: SuiteSourceSnapshotOptions = {},
) {
  if (!path.isAbsolute(stateDir) || stateDir.includes("\0"))
    throw new Error("State directory must be absolute.");
  const store = createFileResourceStore(stateDir);
  const staging = path.join(stateDir, "suites", "source-staging");
  const provenance = path.join(stateDir, "suites", "source-provenance");
  return {
    async capture(input: SuitePreviewInput["source"]): Promise<CapturedSuiteSource> {
      let stage: string | undefined;
      let localRealpath: string | undefined;
      try {
        if (input.kind === "local-folder") {
          if (!path.isAbsolute(input.path) || input.path.includes("\0"))
            throw new Error("Unsafe local Suite root: expected an absolute directory.");
          const stat = await fs.lstat(input.path);
          if (!stat.isDirectory() || stat.isSymbolicLink())
            throw new Error(
              "Unsafe local Suite root: expected a real directory, not a symlink or special file.",
            );
          const realpath = await fs.realpath(input.path);
          localRealpath = realpath;
          const sealed = await store.seal(realpath);
          const contentHash = sealed.packageId.slice(4);
          const sourceId = `source_${suiteContentDigest({ kind: "local-folder", realpath })}`;
          // Canonical local paths are server-only provenance, never SuiteSource/model fields.
          ensurePrivateDirectorySync(provenance);
          const provenanceStat = await fs.lstat(provenance);
          if (!provenanceStat.isDirectory() || provenanceStat.isSymbolicLink())
            throw new Error("Unsafe local source provenance directory.");
          // Ancestor aliases such as /tmp must not look like an escape on reread.
          const provenanceRoot = await fs.realpath(provenance);
          try {
            const handle = await fs.open(
              path.join(provenanceRoot, `${sourceId}.json`),
              "wx",
              0o600,
            );
            try {
              await handle.writeFile(canonicalSuiteJson({ kind: "local-folder", realpath }));
              await handle.sync();
            } finally {
              await handle.close();
            }
          } catch (cause) {
            if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
            const existing = await expertResourceFiles.read(
              path.join(provenanceRoot, `${sourceId}.json`),
              provenanceRoot,
            );
            if (
              existing.toString("utf8") !== canonicalSuiteJson({ kind: "local-folder", realpath })
            )
              throw new Error("Local source provenance is incomplete or corrupt.");
          }
          await syncDirectoryEntry(provenanceRoot);
          return {
            rootPath: sealed.rootPath,
            source: { kind: "local-folder", sourceId, contentHash },
            contentHash,
          };
        }
        const url = new URL(normalizeSkillSourceUrl(input.url));
        if (url.hostname !== "github.com" || url.hash || input.url.includes("#"))
          throw new Error("Suite GitHub source requires a repository or tree HTTPS URL.");
        const parts = url.pathname.slice(1).split("/").map(decodeURIComponent);
        if (
          parts.length < 2 ||
          !parts.slice(0, 2).every((part) => /^[\w.-]+$/u.test(part)) ||
          parts.some((part, index) => index !== 3 && part.includes("/"))
        )
          throw new Error("Invalid GitHub repository URL.");
        if (parts.length > 2 && (parts[2] !== "tree" || !parts[3]))
          throw new Error("Select a GitHub repository or tree URL.");
        const repository = `${parts[0]}/${parts[1]!.replace(/\.git$/u, "")}`.toLowerCase();
        const requestedRef = parts[3] ?? "HEAD";
        if (/[\p{Cc}]/u.test(requestedRef)) throw new Error("Unsafe GitHub ref.");
        const subdirectory = parts.slice(4).join("/");
        if (subdirectory) assertSkillResourcePath(subdirectory);
        if (subdirectory !== subdirectory.normalize("NFC"))
          throw new Error("GitHub subdirectory must be NFC.");
        ensurePrivateDirectorySync(staging);
        stage = path.join(staging, randomUUID());
        await fs.mkdir(stage, { mode: 0o700 });
        let resolvedCommit: string;
        let sourceEntries: GitHubRepositorySnapshot["entries"];
        // Only an unauthenticated commit lookup may fall back to the existing gh login.
        // A 404 is ambiguous (missing OR inaccessible), never evidence of public/deleted state.
        let commitBytes: Buffer | undefined;
        try {
          commitBytes = await fetchSkillSource(
            `https://api.github.com/repos/${repository}/commits/${encodeURIComponent(requestedRef)}`,
            1024 * 1024,
          );
        } catch (cause) {
          if (!options.readGitHubSnapshot) throw cause;
          const snapshot = await options.readGitHubSnapshot({
            repository,
            requestedRef,
            subdirectory,
          });
          resolvedCommit = snapshot.resolvedCommit;
          sourceEntries = snapshot.entries;
        }
        if (commitBytes) {
          const commit: unknown = JSON.parse(commitBytes.toString("utf8"));
          if (
            !commit ||
            typeof commit !== "object" ||
            !("sha" in commit) ||
            typeof commit.sha !== "string" ||
            !/^[a-f0-9]{40}$/u.test(commit.sha)
          )
            throw new Error("GitHub did not return a fixed source commit.");
          resolvedCommit = commit.sha;
          let archiveRoot: string | undefined;
          const archive = await fetchSkillSource(
            `https://codeload.github.com/${repository}/zip/${resolvedCommit}`,
            SKILL_PACKAGE_LIMIT,
          );
          const files = readSkillArchive(archive, (name, mode, directory) => {
            const root = name.split("/")[0]!;
            const expectedRoot = `${repository.split("/")[1]}-${resolvedCommit}`;
            if (
              root.toLowerCase() !== expectedRoot.toLowerCase() ||
              (archiveRoot !== undefined && root !== archiveRoot)
            )
              throw new Error("GitHub archive has an unexpected or colliding root.");
            archiveRoot = root;
            const selectedPrefix = `${root}/${subdirectory ? `${subdirectory}/` : ""}`;
            if (name === selectedPrefix.slice(0, -1)) {
              const type = mode & 0xf000;
              if (!directory || (type !== 0 && type !== 0x4000))
                throw new Error("Unsafe GitHub selected root type.");
              return false; // The selected root is not part of F-4's 5,000-entry budget.
            }
            return name.startsWith(selectedPrefix);
          });
          if (!files.length) throw new Error("Selected GitHub source directory was not found.");
          const prefix = `${archiveRoot}/${subdirectory ? `${subdirectory}/` : ""}`;
          sourceEntries = files
            .filter((file) => file.name.startsWith(prefix) && file.name.length > prefix.length)
            .map((file) => ({
              path: file.name.slice(prefix.length),
              kind: file.directory ? ("directory" as const) : ("file" as const),
              bytes: file.data,
              executable: !file.directory && file.executable,
            }));
        }
        if (!/^[a-f0-9]{40}$/u.test(resolvedCommit!))
          throw new Error("Invalid fixed GitHub commit.");
        const entries = sourceEntries!;
        const byPath = new Map<string, FileResourceEntry>();
        for (const entry of entries) {
          if (byPath.has(entry.path)) throw new Error("Colliding GitHub snapshot paths.");
          byPath.set(entry.path, {
            path: entry.path,
            kind: entry.kind,
            size: entry.bytes.length,
            sha256: createHash("sha256").update(entry.bytes).digest("hex"),
            executable: entry.executable,
          });
        }
        for (const entry of entries) {
          for (
            let parent = path.posix.dirname(entry.path);
            parent !== ".";
            parent = path.posix.dirname(parent)
          ) {
            if (!byPath.has(parent))
              byPath.set(parent, {
                path: parent,
                kind: "directory",
                size: 0,
                sha256: createHash("sha256").digest("hex"),
                executable: false,
              });
          }
        }
        const resources = [...byPath.values()].sort((a, b) => compareResourcePaths(a.path, b.path));
        validateFileResourceManifest(resources);
        for (const entry of entries) {
          const target = path.join(stage, ...entry.path.split("/"));
          await fs.mkdir(entry.kind === "directory" ? target : path.dirname(target), {
            recursive: true,
            mode: 0o700,
          });
          if (entry.kind === "file")
            await fs.writeFile(target, entry.bytes, {
              flag: "wx",
              mode: entry.executable ? 0o700 : 0o600,
            });
        }
        const sealed = await store.seal(stage, resources);
        const contentHash = sealed.packageId.slice(4);
        const sourceId = `source_${suiteContentDigest({ kind: "github", repository, subdirectory })}`;
        return {
          rootPath: sealed.rootPath,
          source: {
            kind: "github",
            sourceId,
            repository,
            subdirectory,
            requestedRef,
            resolvedCommit: resolvedCommit!,
            contentHash,
          },
          contentHash,
        };
      } catch (cause) {
        if (cause instanceof SuiteSourceError) throw cause;
        const rawMessage = cause instanceof Error ? cause.message : String(cause);
        const message = rawMessage
          .replaceAll(stateDir, "<server-state>")
          .replaceAll(
            localRealpath ?? (input.kind === "local-folder" ? input.path : input.url),
            "<selected-source>",
          )
          .replaceAll(input.kind === "local-folder" ? input.path : input.url, "<selected-source>");
        const reason =
          cause && typeof cause === "object" && "reason" in cause ? cause.reason : undefined;
        const code =
          reason === "not-authenticated" ||
          /HTTP (401|403|404)|not authenticated|not logged in/iu.test(message)
            ? "source_auth_required"
            : /unsafe|symlink|symbolic|linked|special|NFC|collid|escap|credentials|query parameters/iu.test(
                  message,
                )
              ? "unsafe_path"
              : /timeout|timed out/iu.test(message)
                ? "probe_timeout"
                : reason === "rate-limited" ||
                    /fetch failed|network|ENOTFOUND|ECONN|offline/iu.test(message)
                  ? "probe_error"
                  : "source_unreadable";
        const publicMessage =
          code === "source_auth_required"
            ? "GitHub source is inaccessible to the current login or could not be found. Check repository/ref and authorize the existing GitHub CLI login."
            : code === "unsafe_path"
              ? "Selected source contains unsafe, linked, special, colliding or non-NFC paths."
              : code === "probe_timeout" || code === "probe_error"
                ? "Source availability could not be checked and remains unknown. Retry the same source."
                : input.kind === "github"
                  ? "GitHub snapshot could not be read within the supported limits. Check the repository, fixed ref and selected subdirectory."
                  : message;
        throw new SuiteSourceError(
          sourceIssue(code, publicMessage, { kind: "suite", id: "source", path: null }),
          { cause },
        );
      } finally {
        if (stage) await expertResourceFiles.removeStaging(stage);
      }
    },
    /** Caller holds the package lifecycle lock and has checked durable references. */
    async release(contentHash: string, rootPath: string): Promise<void> {
      let sealed: SealedFileResources;
      try {
        sealed = await store.read(`res_${contentHash}`);
      } catch (cause) {
        const error = cause as NodeJS.ErrnoException;
        if (
          error.code === "ENOENT" &&
          error.path === path.join(stateDir, "experts", "file-resources", `res_${contentHash}`)
        )
          return;
        throw cause;
      }
      if (sealed.rootPath !== rootPath)
        throw new SuiteSourceError(
          sourceIssue("resource_corrupt", "Suite source root is corrupt.", {
            kind: "suite",
            id: "source",
            path: null,
          }),
        );
      // Only the verified owner package is removable, never the mutable origin.
      const packageRoot = path.dirname(sealed.rootPath);
      await expertResourceFiles.removeStaging(packageRoot);
      await syncDirectoryEntry(path.dirname(packageRoot));
    },
  };
}
