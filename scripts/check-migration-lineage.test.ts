import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  FROZEN_NATIVE_COMPATIBILITY_MIGRATION,
  findMigrationOwnershipViolations,
  findContextLedgerOwnershipViolations,
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

  it("checks only release tags that are ancestors of HEAD and preserves version ordering", () => {
    const root = mkdtempSync(join(tmpdir(), "synara-migration-lineage-git-"));
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", root, ...args], { encoding: "utf8" });
    try {
      git("init", "--quiet", "--initial-branch=main");
      git("config", "user.name", "Migration Lineage Test");
      git("config", "user.email", "migration-lineage@example.invalid");
      writeFileSync(join(root, "main.txt"), "main history\n", "utf8");
      git("add", "main.txt");
      git("commit", "--quiet", "-m", "main history");
      git("tag", "v0.6.0");

      git("switch", "--quiet", "--orphan", "unrelated-release");
      git("rm", "--quiet", "--force", "--ignore-unmatch", "-r", ".");
      writeFileSync(join(root, "other.txt"), "unrelated history\n", "utf8");
      git("add", "other.txt");
      git("commit", "--quiet", "-m", "unrelated history");
      git("tag", "v9.0.0");
      git("switch", "--quiet", "main");

      const releaseTags = resolveReleaseTags(
        (pattern) =>
          git("tag", "--merged", "HEAD", "--list", pattern, "--sort=-v:refname")
            .trim()
            .split("\n")
            .filter(Boolean),
        () => false,
      );

      expect(releaseTags).toEqual(["v0.6.0"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails closed when release tags or complete history are unavailable", () => {
    // Users skip versions: a database is wedged by the release it was created
    // under, not by the newest one.
    expect(
      resolveReleaseTags(
        () => ["v0.6.0", "v0.5.5", "v0.5.4"],
        () => false,
      ),
    ).toEqual(["v0.6.0", "v0.5.5", "v0.5.4"]);
    expect(() =>
      resolveReleaseTags(
        () => [],
        () => false,
      ),
    ).toThrow(/No release tag is reachable/u);
    expect(() =>
      resolveReleaseTags(
        () => ["v0.6.0"],
        () => true,
      ),
    ).toThrow(/shallow Git checkout/u);
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

  it("accepts the complete pinned upstream catalog and checks every script byte", () => {
    const integrated = [catalogEntry(1, "OrchestrationEvents", "a".repeat(64))];
    const candidate = [
      ...integrated,
      catalogEntry(2, "OrchestrationCommandReceipts", "b".repeat(64)),
    ];
    expect(
      findMigrationOwnershipViolations(
        candidate,
        integrated,
        candidate,
        FROZEN_NATIVE_COMPATIBILITY_MIGRATION.sha256,
      ),
    ).toEqual([]);
    expect(
      findMigrationOwnershipViolations(
        [integrated[0]!, catalogEntry(2, "OrchestrationCommandReceipts", "c".repeat(64))],
        integrated,
        candidate,
        FROZEN_NATIVE_COMPATIBILITY_MIGRATION.sha256,
      ),
    ).toContain(
      'Official migration 2 ("OrchestrationCommandReceipts") does not match its pinned upstream script bytes.',
    );
  });

  it("keeps frozen legacy 111 outside the active catalog while checking its exact bytes", () => {
    const changed = findMigrationOwnershipViolations([], [], [], "c".repeat(64));
    expect(changed).toContain(
      "Frozen compatibility script apps/server/src/persistence/Migrations/111_ContextV1.ts bytes changed.",
    );

    expect(findMigrationOwnershipViolations([], [], [])).toContain(
      "Cannot verify frozen compatibility script bytes at apps/server/src/persistence/Migrations/111_ContextV1.ts.",
    );
    expect(
      findMigrationOwnershipViolations(
        [catalogEntry(111, "RenamedContextV1", FROZEN_NATIVE_COMPATIBILITY_MIGRATION.sha256)],
        [],
        [],
        FROZEN_NATIVE_COMPATIBILITY_MIGRATION.sha256,
      ),
    ).toContain(
      'Native migration 111 ("RenamedContextV1") is not owned by the pinned upstream catalog. ' +
        "Linx extensions belong in the independent workbench_sql_migrations ledger.",
    );
  });

  it("proves Context ledger ownership from executable static declarations", () => {
    const source = readFileSync(
      new URL("../apps/server/src/workbench/persistence/WorkbenchMigrations.ts", import.meta.url),
      "utf8",
    );
    expect(findContextLedgerOwnershipViolations(source)).toEqual([]);
    for (const altered of [
      source.replace("effect: ContextV1Migration", "effect: UnknownMigration"),
      source.replace("111_ContextV1.ts", "111_Replacement.ts"),
      source.replace('moduleId: "context"', 'moduleId: "other"'),
      source.replace("b7dbd849", "00000000"),
      source.replace("...contextWorkbenchMigrationEntries", "...loadMigrations()"),
      source.replace("...contextWorkbenchMigrationEntries", "...workbenchMigrationEntries"),
      source.replace(
        "export const contextWorkbenchMigrationEntries",
        "const contextWorkbenchMigrationEntries",
      ),
    ]) {
      expect(findContextLedgerOwnershipViolations(altered)).not.toEqual([]);
    }
  });

  it("rejects an unknown local migration in the native catalog", () => {
    const problems = findMigrationOwnershipViolations(
      [catalogEntry(112, "LinxNativeExtension", "d".repeat(64))],
      [],
      [],
      FROZEN_NATIVE_COMPATIBILITY_MIGRATION.sha256,
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
