import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  FROZEN_NATIVE_COMPATIBILITY_MIGRATION,
  findMigrationOwnershipViolations,
  findLineageStructureViolations,
  findReleasedLineageViolations,
  groupViolationsByPair,
  parseMigrationCatalog,
  parseMigrationLineage,
  parseMigrationLineageAllowances,
  resolveReleaseTags,
  validatePinnedUpstreamProvenance,
  type MigrationCatalogEntry,
} from "./check-migration-lineage";

const migrationsSource = () =>
  readFileSync(
    fileURLToPath(new URL("../apps/server/src/persistence/Migrations.ts", import.meta.url)),
    "utf8",
  );

const sourceFor = (entries: readonly (readonly [number, string])[]) =>
  `export const migrationEntries = [\n${entries
    .map(([id, name]) => `  [${id}, "${name}", Migration],`)
    .join("\n")}\n] as const;\n`;

const catalogEntry = (
  id: number,
  name: string,
  sha256: string,
  migrationFile = `apps/server/src/persistence/Migrations/${String(id).padStart(3, "0")}_${name}.ts`,
): MigrationCatalogEntry => ({ id, name, migrationFile, sha256 });

const frozenCatalogEntry = (sha256: string = FROZEN_NATIVE_COMPATIBILITY_MIGRATION.sha256) =>
  catalogEntry(
    FROZEN_NATIVE_COMPATIBILITY_MIGRATION.id,
    FROZEN_NATIVE_COMPATIBILITY_MIGRATION.name,
    sha256,
    FROZEN_NATIVE_COMPATIBILITY_MIGRATION.migrationFile,
  );

const released = [
  [1, "OrchestrationEvents"],
  [53, "BackfillThreadActivitySequence"],
  [54, "ProjectPullRequestPins"],
] as const;

describe("migration lineage guard", () => {
  it("parses native catalog entries with their imported migration file", () => {
    expect(
      parseMigrationCatalog(`
        import CommandDelivery from "./Migrations/054_ReservedDurableProviderCommandDelivery.ts";
        export const migrationEntries = [
          /* [112, "CommentOnlyMigration", NotAnImport] is documentation. */
          [54, "DurableProviderCommandDelivery", CommandDelivery],
          // A second tuple-shaped comment must not become a catalog entry:
          // [113, "AlsoCommentOnly", NotAnImport],
        ] as const;
      `),
    ).toEqual([
      {
        id: 54,
        name: "DurableProviderCommandDelivery",
        migrationFile:
          "apps/server/src/persistence/Migrations/054_ReservedDurableProviderCommandDelivery.ts",
      },
    ]);
  });

  it("fails closed instead of omitting an unsupported native catalog entry", () => {
    const source = `
      import Migration0001 from "./Migrations/001_OrchestrationEvents.ts";
      export const migrationEntries = [
        [1, "OrchestrationEvents", Migration0001],
        [112, "LinxNativeExtension", makeMigration()],
      ] as const;
    `;
    expect(() => parseMigrationCatalog(source)).toThrow(
      /Unsupported or dynamic migrationEntries syntax/u,
    );
  });

  it("rejects spread and single-quoted catalog syntax instead of ignoring it", () => {
    const prefix = `
      import Migration0001 from "./Migrations/001_OrchestrationEvents.ts";
      export const migrationEntries = [
        [1, "OrchestrationEvents", Migration0001],
    `;
    expect(() => parseMigrationCatalog(`${prefix}...localEntries\n] as const;`)).toThrow(
      /Unsupported or dynamic migrationEntries syntax/u,
    );
    expect(() =>
      parseMigrationCatalog(`${prefix}[112, 'LinxNativeExtension', Migration0112],\n] as const;`),
    ).toThrow(/Unsupported or dynamic migrationEntries syntax/u);
  });

  it("parses ids and names, ignoring comments around the entries", () => {
    const source = `
      // [99, "NotAnEntry"] in a comment above the array
      export const migrationEntries = [
        [1, "OrchestrationEvents", Migration0001],
        // A note about the next slot.
        [2, "OrchestrationCommandReceipts", Migration0002],
      ] as const;
    `;
    expect(parseMigrationLineage(source)).toEqual([
      { id: 1, name: "OrchestrationEvents" },
      { id: 2, name: "OrchestrationCommandReceipts" },
    ]);
  });

  it("throws when the entries array is missing or empty", () => {
    expect(() => parseMigrationLineage("export const other = [];")).toThrow(/migrationEntries/u);
    expect(() => parseMigrationLineage("export const migrationEntries = [] as const;")).toThrow(
      /zero migrations/u,
    );
  });

  it("passes when new migrations are appended", () => {
    const current = parseMigrationLineage(
      sourceFor([...released, [55, "ManagedAttachments"], [56, "CommandReceiptFingerprints"]]),
    );
    expect(
      findReleasedLineageViolations(parseMigrationLineage(sourceFor(released)), current),
    ).toEqual([]);
  });

  it("fails and names the pair when a shipped migration is renumbered", () => {
    // The v0.6.0 regression: 54 became a different migration and the pins
    // migration moved to 69.
    const current = parseMigrationLineage(
      sourceFor([
        [1, "OrchestrationEvents"],
        [53, "BackfillThreadActivitySequence"],
        [54, "DurableProviderCommandDelivery"],
        [69, "ProjectPullRequestPins"],
      ]),
    );
    expect(
      findReleasedLineageViolations(parseMigrationLineage(sourceFor(released)), current),
    ).toEqual([
      {
        id: 54,
        releasedName: "ProjectPullRequestPins",
        currentName: "DurableProviderCommandDelivery",
      },
    ]);
  });

  it("fails when a shipped migration is renamed in place or dropped", () => {
    const renamed = parseMigrationLineage(
      sourceFor([
        [1, "OrchestrationEvents"],
        [53, "BackfillThreadActivitySequence"],
        [54, "ProjectPullRequestPinsV2"],
      ]),
    );
    expect(
      findReleasedLineageViolations(parseMigrationLineage(sourceFor(released)), renamed),
    ).toEqual([
      { id: 54, releasedName: "ProjectPullRequestPins", currentName: "ProjectPullRequestPinsV2" },
    ]);

    const dropped = parseMigrationLineage(
      sourceFor([
        [1, "OrchestrationEvents"],
        [53, "BackfillThreadActivitySequence"],
      ]),
    );
    expect(
      findReleasedLineageViolations(parseMigrationLineage(sourceFor(released)), dropped),
    ).toEqual([{ id: 54, releasedName: "ProjectPullRequestPins", currentName: null }]);
  });

  it("rejects duplicate and out-of-order ids", () => {
    expect(
      findLineageStructureViolations(
        parseMigrationLineage(
          sourceFor([
            [1, "A"],
            [2, "B"],
          ]),
        ),
      ),
    ).toEqual([]);
    expect(
      findLineageStructureViolations(
        parseMigrationLineage(
          sourceFor([
            [1, "A"],
            [1, "B"],
          ]),
        ),
      ),
    ).toHaveLength(2);
    expect(
      findLineageStructureViolations(
        parseMigrationLineage(
          sourceFor([
            [2, "A"],
            [1, "B"],
          ]),
        ),
      ),
    ).toHaveLength(1);
  });

  it("checks every release tag, newest first, and degrades to an empty list", () => {
    // Users skip versions: a database is wedged by the release it was created
    // under, not by the newest one.
    expect(resolveReleaseTags(() => ["v0.6.0", "v0.5.5", "v0.5.4"])).toEqual([
      "v0.6.0",
      "v0.5.5",
      "v0.5.4",
    ]);
    expect(resolveReleaseTags(() => [])).toEqual([]);
  });

  it("exempts a divergence the runtime declares it can repair", () => {
    const current = parseMigrationLineage(
      sourceFor([
        [1, "OrchestrationEvents"],
        [54, "DurableProviderCommandDelivery"],
        [69, "ProjectPullRequestPins"],
      ]),
    );
    const shipped = parseMigrationLineage(sourceFor(released));

    expect(findReleasedLineageViolations(shipped, current)).toHaveLength(2);
    expect(
      findReleasedLineageViolations(shipped, current, [
        { id: 53, name: "BackfillThreadActivitySequence" },
        { id: 54, name: "ProjectPullRequestPins" },
      ]),
    ).toEqual([]);
  });

  it("reads the alias allowances this repository actually declares", () => {
    // The v0.6.0 renumber is repaired at runtime, so the guard must not keep
    // failing on it forever.
    expect(parseMigrationLineageAllowances(migrationsSource())).toContainEqual({
      id: 54,
      name: "ProjectPullRequestPins",
    });
    expect(parseMigrationLineageAllowances("export const other = [];")).toEqual([]);
  });

  it("reports one line per broken pair, listing every tag that shipped it", () => {
    const violation = { id: 54, releasedName: "ProjectPullRequestPins", currentName: null };
    expect(
      groupViolationsByPair([
        { tag: "v0.5.5", violations: [violation] },
        { tag: "v0.5.4", violations: [violation] },
      ]),
    ).toEqual([{ violation, tags: ["v0.5.5", "v0.5.4"] }]);
  });

  it("holds for this repository's own lineage", () => {
    const entries = parseMigrationLineage(migrationsSource());
    expect(findLineageStructureViolations(entries)).toEqual([]);
    expect(entries.length).toBeGreaterThan(50);
  });

  it("accepts pinned upstream migrations and verifies bytes for entries added by the candidate", () => {
    const integrated = [catalogEntry(1, "OrchestrationEvents", "a".repeat(64))];
    const candidate = [
      ...integrated,
      catalogEntry(2, "OrchestrationCommandReceipts", "b".repeat(64)),
    ];
    const current = [...candidate, frozenCatalogEntry()];
    expect(findMigrationOwnershipViolations(current, integrated, candidate)).toEqual([]);
    expect(
      findMigrationOwnershipViolations(
        [
          integrated[0]!,
          catalogEntry(2, "OrchestrationCommandReceipts", "c".repeat(64)),
          frozenCatalogEntry(),
        ],
        integrated,
        candidate,
      ),
    ).toContain(
      'Newly approved upstream migration 2 ("OrchestrationCommandReceipts") does not match its pinned upstream script bytes.',
    );
  });

  it("rejects a changed frozen 111 script and a removed or renamed frozen identity", () => {
    const changed = findMigrationOwnershipViolations([frozenCatalogEntry("c".repeat(64))], [], []);
    expect(changed).toContain("Frozen native migration 111_ContextV1 script bytes changed.");

    expect(findMigrationOwnershipViolations([], [], [])).toContain(
      "Frozen native migration 111_ContextV1 was removed, renamed, or moved to another ID.",
    );
    expect(
      findMigrationOwnershipViolations(
        [catalogEntry(111, "RenamedContextV1", FROZEN_NATIVE_COMPATIBILITY_MIGRATION.sha256)],
        [],
        [],
      ),
    ).toContain(
      "Frozen native migration 111_ContextV1 was removed, renamed, or moved to another ID.",
    );
  });

  it("rejects an unknown local migration in the native catalog", () => {
    const problems = findMigrationOwnershipViolations(
      [frozenCatalogEntry(), catalogEntry(112, "LinxNativeExtension", "d".repeat(64))],
      [],
      [],
    );
    expect(problems).toContain(
      'Native migration 112 ("LinxNativeExtension") is not owned by the pinned upstream catalog. ' +
        "Linx extensions belong in the independent workbench_sql_migrations ledger.",
    );
  });

  it("fails closed when pinned upstream provenance is missing or disagrees with local Git", () => {
    const missing = validatePinnedUpstreamProvenance(
      JSON.stringify({
        formatVersion: 1,
        integratedBase: { tag: "v1.0.0", commit: "a".repeat(40) },
      }),
      () => "a".repeat(40),
    );
    expect(missing.provenance).toBeNull();
    expect(missing.problems).toContain(
      "workbench/upstream.lock.json is missing candidate provenance.",
    );

    const mismatch = validatePinnedUpstreamProvenance(
      JSON.stringify({
        formatVersion: 1,
        integratedBase: { tag: "v1.0.0", commit: "a".repeat(40) },
        candidate: { tag: "v1.1.0", commit: "b".repeat(40) },
      }),
      (tag) => (tag === "v1.0.0" ? "a".repeat(40) : "c".repeat(40)),
    );
    expect(mismatch.provenance).toBeNull();
    expect(mismatch.problems).toContain(
      `Pinned upstream tag v1.1.0 resolves to ${"c".repeat(40)}, not ${"b".repeat(40)}.`,
    );
  });
});
