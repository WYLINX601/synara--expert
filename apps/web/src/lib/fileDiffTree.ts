// FILE: fileDiffTree.ts
// Purpose: Build a nested, path-compressed folder/file tree from a flat list of
//          parsed file diffs so review surfaces can render a compact explorer
//          without each one re-implementing flat-to-tree conversion. The editor
//          explorer lazy-fetches one directory level at a time from the backend,
//          so it never needed this; in-memory diff lists do.
// Layer: Web diff utilities
// Depends on: diffRendering path helpers.

import type { FileDiffMetadata } from "@pierre/diffs/react";

import { compareDiffPaths, resolveFileDiffPath } from "./diffRendering";
import { buildPathTree } from "./pathTree";

export interface FileDiffTreeFileNode {
  kind: "file";
  /** Leaf name (the final path segment). */
  name: string;
  /** Full repo-relative path, used as the selection id and React key. */
  path: string;
  fileDiff: FileDiffMetadata;
}

export interface FileDiffTreeDirectoryNode {
  kind: "directory";
  /** Display name; compressed chains render as `parent/child`. */
  name: string;
  /** Full repo-relative directory path (no trailing slash), used as the key. */
  path: string;
  children: FileDiffTreeNode[];
}

export type FileDiffTreeNode = FileDiffTreeDirectoryNode | FileDiffTreeFileNode;

/** Shared path-tree builder preserves review ordering and original metadata. */
export function buildFileDiffTree(files: ReadonlyArray<FileDiffMetadata>): FileDiffTreeNode[] {
  return buildPathTree(
    files.flatMap((fileDiff) => {
      const path = resolveFileDiffPath(fileDiff);
      const segments = path.split("/").filter(Boolean);
      const name = segments.at(-1);
      return name ? [{ kind: "file" as const, name, path, fileDiff }] : [];
    }),
    compareDiffPaths,
  );
}
