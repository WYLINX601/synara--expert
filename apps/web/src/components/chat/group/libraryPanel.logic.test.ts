import type { HubDeliverableCollection, LibraryEntry } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import {
  DEFAULT_LIBRARY_SORT,
  DEFAULT_EXPANDED_DIRECTORIES,
  compareLibraryEntries,
  entryMatchesLibraryFilters,
  flattenLibraryRows,
  indexLibraryKeyDeliverables,
  libraryKeyDeliverableDirectoryPaths,
  libraryEntryTypeBucket,
  nextLibrarySort,
  sortLibraryEntries,
  toggleLibraryDirectory,
} from "./libraryPanel.logic";

const entry = (
  name: string,
  relativePath: string,
  kind: LibraryEntry["kind"],
  modifiedAt: string,
): LibraryEntry => ({ name, relativePath, kind, sizeBytes: 1, modifiedAt });

const deliverableCollection = (
  files: readonly Record<string, unknown>[],
  options: { state?: "active" | "withdrawn"; workerThreadId?: string; revision?: number } = {},
) =>
  ({
    hubId: "hub-1",
    workerThreadId: options.workerThreadId ?? "worker-1",
    revision: options.revision ?? 2,
    state: options.state ?? "active",
    commitSha: "a".repeat(40),
    provenance: {
      hubId: "hub-1",
      workerThreadId: options.workerThreadId ?? "worker-1",
      expertBindingSnapshotId: "snapshot-1",
      publishedAt: "2026-10-18T12:00:00Z",
    },
    files,
    updatedAt: "2026-10-18T12:00:00Z",
  }) as unknown as HubDeliverableCollection;

const publishedFile = (libraryPath: string, extra: Record<string, unknown> = {}) => ({
  path: "out/report.md",
  libraryPath,
  name: "report.md",
  description: null,
  mediaType: "text/markdown",
  sizeBytes: 20,
  sha256: "b".repeat(64),
  ...extra,
});

describe("libraryEntryTypeBucket", () => {
  it("buckets by file-icon name", () => {
    expect(
      libraryEntryTypeBucket(entry("spec.md", "spec.md", "file", "2026-01-01T00:00:00Z")),
    ).toBe("documents");
    expect(
      libraryEntryTypeBucket(entry("doc.pdf", "doc.pdf", "file", "2026-01-01T00:00:00Z")),
    ).toBe("documents");
    expect(
      libraryEntryTypeBucket(entry("shot.png", "shot.png", "file", "2026-01-01T00:00:00Z")),
    ).toBe("images");
    expect(
      libraryEntryTypeBucket(entry("tool.ts", "tool.ts", "file", "2026-01-01T00:00:00Z")),
    ).toBe("code");
    expect(
      libraryEntryTypeBucket(entry("blob.bin", "blob.bin", "file", "2026-01-01T00:00:00Z")),
    ).toBe("other");
  });
});

describe("sortLibraryEntries", () => {
  const entries = [
    entry("zeta.md", "zeta.md", "file", "2026-01-03T00:00:00Z"),
    entry("Beta", "Beta", "directory", "2026-01-01T00:00:00Z"),
    entry("alpha.md", "alpha.md", "file", "2026-01-02T00:00:00Z"),
    entry("Alpha", "Alpha", "directory", "2026-01-04T00:00:00Z"),
  ];

  it("keeps directories first and sorts by name ascending", () => {
    expect(
      sortLibraryEntries(entries, { key: "name", direction: "asc" }).map((e) => e.name),
    ).toEqual(["Alpha", "Beta", "alpha.md", "zeta.md"]);
  });

  it("sorts by date descending while keeping directories first", () => {
    expect(
      sortLibraryEntries(entries, { key: "modifiedAt", direction: "desc" }).map((e) => e.name),
    ).toEqual(["Alpha", "Beta", "zeta.md", "alpha.md"]);
  });

  it("flips direction on repeat key and resets ascending on a new key", () => {
    const asc = { key: "name", direction: "asc" } as const;
    expect(nextLibrarySort(asc, "name")).toEqual({ key: "name", direction: "desc" });
    expect(nextLibrarySort(asc, "modifiedAt")).toEqual({
      key: "modifiedAt",
      direction: "asc",
    });
    expect(nextLibrarySort({ key: "name", direction: "desc" }, "name")).toEqual({
      key: "name",
      direction: "asc",
    });
  });

  it("falls back to name order on equal dates", () => {
    const tied = [
      entry("b.txt", "b.txt", "file", "2026-01-01T00:00:00Z"),
      entry("a.txt", "a.txt", "file", "2026-01-01T00:00:00Z"),
    ];
    expect(
      compareLibraryEntries(tied[0]!, tied[1]!, { key: "modifiedAt", direction: "asc" }),
    ).toBeGreaterThan(0);
  });
});

describe("entryMatchesLibraryFilters", () => {
  const note = entry("note.md", "docs/note.md", "file", "2026-01-01T00:00:00Z");

  it("matches the relative path case-insensitively", () => {
    expect(entryMatchesLibraryFilters(note, { typeFilter: "all", query: "DOCS/NO" })).toBe(true);
    expect(entryMatchesLibraryFilters(note, { typeFilter: "all", query: "missing" })).toBe(false);
  });

  it("applies the type filter to files but keeps directories", () => {
    const dir = entry("docs", "docs", "directory", "2026-01-01T00:00:00Z");
    expect(entryMatchesLibraryFilters(note, { typeFilter: "images", query: "" })).toBe(false);
    expect(entryMatchesLibraryFilters(note, { typeFilter: "documents", query: "" })).toBe(true);
    expect(entryMatchesLibraryFilters(dir, { typeFilter: "images", query: "" })).toBe(true);
  });

  it("matches only published key file paths when the key filter is enabled", () => {
    const key = entry("note.md", "docs/note.md", "file", "2026-01-01T00:00:00Z");
    expect(
      entryMatchesLibraryFilters(key, {
        typeFilter: "all",
        query: "",
        onlyKeyDeliverables: true,
        keyDeliverablePaths: new Set(["docs/note.md"]),
      }),
    ).toBe(true);
    expect(
      entryMatchesLibraryFilters(entry("other.md", "other.md", "file", ""), {
        typeFilter: "all",
        query: "",
        onlyKeyDeliverables: true,
        keyDeliverablePaths: new Set(["docs/note.md"]),
      }),
    ).toBe(false);
  });
});

describe("flattenLibraryRows", () => {
  const entriesByDir = new Map<string, readonly LibraryEntry[]>([
    [
      "",
      [
        entry("Artifacts", "Artifacts", "directory", "2026-01-01T00:00:00Z"),
        entry("readme.md", "readme.md", "file", "2026-01-02T00:00:00Z"),
      ],
    ],
    ["Artifacts", [entry("plan.pdf", "Artifacts/plan.pdf", "file", "2026-01-03T00:00:00Z")]],
  ]);
  const base = {
    entriesByDir,
    sort: { key: "name", direction: "asc" } as const,
    typeFilter: "all" as const,
    query: "",
  };

  it("expands directories on the expanded set only", () => {
    const collapsed = flattenLibraryRows({ ...base, expandedDirectories: new Set<string>() });
    expect(collapsed.map((row) => row.entry.relativePath)).toEqual(["Artifacts", "readme.md"]);

    const expanded = flattenLibraryRows({
      ...base,
      expandedDirectories: DEFAULT_EXPANDED_DIRECTORIES,
    });
    expect(expanded.map((row) => row.entry.relativePath)).toEqual([
      "Artifacts",
      "Artifacts/plan.pdf",
      "readme.md",
    ]);
    expect(expanded[1]?.depth).toBe(1);
  });

  it("searches every loaded directory even when collapsed", () => {
    const found = flattenLibraryRows({
      ...base,
      expandedDirectories: new Set<string>(),
      query: "plan",
    });
    // The matching child surfaces with its parent directory for context.
    expect(found.map((row) => row.entry.relativePath)).toEqual(["Artifacts", "Artifacts/plan.pdf"]);
  });

  it("hides directories with no loaded matches when a type filter is active", () => {
    const filtered = flattenLibraryRows({
      ...base,
      expandedDirectories: new Set<string>(),
      typeFilter: "images",
    });
    // Artifacts only holds a .pdf (documents), so the folder drops too.
    expect(filtered.map((row) => row.entry.relativePath)).toEqual([]);

    const withImage = new Map<string, readonly LibraryEntry[]>(entriesByDir);
    withImage.set("Images", [entry("shot.png", "Images/shot.png", "file", "2026-01-04T00:00:00Z")]);
    withImage.set("", [
      entry("Artifacts", "Artifacts", "directory", "2026-01-01T00:00:00Z"),
      entry("Images", "Images", "directory", "2026-01-01T00:00:00Z"),
      entry("readme.md", "readme.md", "file", "2026-01-02T00:00:00Z"),
    ]);
    const rows = flattenLibraryRows({
      ...base,
      entriesByDir: withImage,
      expandedDirectories: new Set<string>(),
      typeFilter: "images",
    });
    expect(rows.map((row) => row.entry.relativePath)).toEqual(["Images", "Images/shot.png"]);
  });

  it("keeps ancestor directories for matching key deliverables", () => {
    const nested = new Map<string, readonly LibraryEntry[]>([
      ["", [entry("Artifacts", "Artifacts", "directory", "")]],
      ["Artifacts", [entry("Reports", "Artifacts/Reports", "directory", "")]],
      [
        "Artifacts/Reports",
        [
          entry("final.md", "Artifacts/Reports/final.md", "file", ""),
          entry("draft.md", "Artifacts/Reports/draft.md", "file", ""),
        ],
      ],
    ]);
    const rows = flattenLibraryRows({
      entriesByDir: nested,
      expandedDirectories: new Set<string>(),
      sort: DEFAULT_LIBRARY_SORT,
      typeFilter: "all",
      query: "",
      onlyKeyDeliverables: true,
      keyDeliverablePaths: new Set(["Artifacts/Reports/final.md"]),
    });
    expect(rows.map((row) => row.entry.relativePath)).toEqual([
      "Artifacts",
      "Artifacts/Reports",
      "Artifacts/Reports/final.md",
    ]);
  });
});

describe("indexLibraryKeyDeliverables", () => {
  it("matches the mutable server Library path, retains missing files, and omits withdrawn publications", () => {
    const active = deliverableCollection([
      publishedFile("Artifacts/original.md", {
        currentLibraryPath: "Artifacts/renamed.md",
        libraryState: "available",
      }),
      publishedFile("Artifacts/deleted.md", { libraryState: "missing" }),
    ]);
    const withdrawn = deliverableCollection([publishedFile("Artifacts/withdrawn.md")], {
      state: "withdrawn",
      workerThreadId: "worker-2",
    });
    const indexed = indexLibraryKeyDeliverables([active, withdrawn]);

    expect(Array.from(indexed.keys())).toEqual(["Artifacts/renamed.md", "Artifacts/deleted.md"]);
    expect(indexed.get("Artifacts/renamed.md")?.file.libraryPath).toBe("Artifacts/original.md");
    expect(indexed.get("Artifacts/renamed.md")?.collection.revision).toBe(2);
    expect(indexed.get("Artifacts/deleted.md")?.file.libraryState).toBe("missing");
    expect(libraryKeyDeliverableDirectoryPaths(indexed)).toEqual(["Artifacts"]);
  });

  it("loads each ancestor directory once in parent-first order", () => {
    const indexed = indexLibraryKeyDeliverables([
      deliverableCollection([
        publishedFile("Artifacts/Reports/final.md"),
        publishedFile("Artifacts/Reports/summary.md"),
        publishedFile("Research/Notes/result.md"),
      ]),
    ]);
    expect(libraryKeyDeliverableDirectoryPaths(indexed)).toEqual([
      "Artifacts",
      "Research",
      "Artifacts/Reports",
      "Research/Notes",
    ]);
  });
});

describe("toggleLibraryDirectory", () => {
  it("adds and removes paths without mutating the input", () => {
    const initial = new Set(["Artifacts"]);
    const collapsed = toggleLibraryDirectory(initial, "Artifacts");
    expect(collapsed.has("Artifacts")).toBe(false);
    expect(initial.has("Artifacts")).toBe(true);
    expect(toggleLibraryDirectory(collapsed, "Artifacts").has("Artifacts")).toBe(true);
  });
});
