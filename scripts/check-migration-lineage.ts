// FILE: check-migration-lineage.ts
// Purpose: Fail closed when a released migration's (id, name) tracker identity changes.
// Layer: CI preflight

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as ts from "typescript";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const migrationsFile = "apps/server/src/persistence/Migrations.ts";
const upstreamLockFile = "workbench/upstream.lock.json";

/**
 * Migration 111 was added to the official tracker during the fork's history.
 * Its SQL and tracker identity are now a frozen compatibility exception: old
 * databases may already have applied it, so neither its bytes nor its name
 * can be changed. The active implementation now lives in the Context ledger;
 * only the exact historical identity/schema may be adopted after backup.
 */
export const FROZEN_NATIVE_COMPATIBILITY_MIGRATION = {
  id: 111,
  name: "ContextV1",
  migrationFile: "apps/server/src/persistence/Migrations/111_ContextV1.ts",
  sha256: "b7dbd84911484156f3f38093973338ca005dce9e8ba4b38b8972d9dfe79a4911",
} as const;

/**
 * Every shipped Synara database records its applied migrations as (id, name)
 * rows in `effect_sql_migrations`, and the runtime reconciler in
 * `Migrations.ts` treats a name that does not match the ID as a foreign
 * lineage: it truncates the tracker and replays the schema. Renumbering or
 * renaming a migration that a release already wrote therefore corrupts every
 * database from that release. v0.6.0 moved `ProjectPullRequestPins` from 54 to
 * 69 and did exactly that.
 *
 * Appending new migrations is always safe. This guard rejects changes to pairs
 * any reachable release tag already shipped — not just the newest one, because
 * a database is wedged by the release *it* was created under, and users skip
 * versions. A pair that today's `MIGRATION_LINEAGE_ALIASES` knows how to repair
 * is exempt: that divergence is handled rather than merely present.
 */

export interface MigrationLineageEntry {
  readonly id: number;
  readonly name: string;
}

export interface MigrationCatalogEntry extends MigrationLineageEntry {
  readonly migrationFile: string;
  readonly sha256?: string | undefined;
}

export interface PinnedUpstreamRevision {
  readonly tag: string;
  readonly commit: string;
}

export interface PinnedUpstreamProvenance {
  readonly integratedBase: PinnedUpstreamRevision;
  readonly candidate: PinnedUpstreamRevision;
}

const migrationImportsPattern =
  /^\s*import\s+([\w$]+)\s+from\s+["']\.\/Migrations\/([^"']+\.ts)["'];?\s*$/gmu;
const staticCatalogEntryPattern = /\[\s*(\d+)\s*,\s*"([^"]+)"\s*,\s*([\w$]+)\s*\]/uy;

function stripCatalogComments(source: string): string {
  let output = "";
  let quote: '"' | "'" | null = null;
  let escaped = false;
  for (let index = 0; index < source.length; ) {
    const current = source[index]!;
    const next = source[index + 1];
    if (quote !== null) {
      output += current;
      if (escaped) escaped = false;
      else if (current === "\\") escaped = true;
      else if (current === quote) quote = null;
      index += 1;
      continue;
    }
    if (current === '"' || current === "'") {
      quote = current;
      output += current;
      index += 1;
      continue;
    }
    if (current === "/" && next === "/") {
      while (index < source.length && source[index] !== "\n" && source[index] !== "\r") {
        output += " ";
        index += 1;
      }
      continue;
    }
    if (current === "/" && next === "*") {
      output += "  ";
      index += 2;
      let closed = false;
      while (index < source.length) {
        if (source[index] === "*" && source[index + 1] === "/") {
          output += "  ";
          index += 2;
          closed = true;
          break;
        }
        const commentCharacter = source[index]!;
        output += commentCharacter === "\n" || commentCharacter === "\r" ? commentCharacter : " ";
        index += 1;
      }
      if (!closed) throw new Error("Unterminated comment in migrationEntries array.");
      continue;
    }
    output += current;
    index += 1;
  }
  return output;
}

function parseStaticCatalogEntries(block: string): Array<{
  readonly id: number;
  readonly name: string;
  readonly migrationImport: string;
}> {
  const entries: Array<{ id: number; name: string; migrationImport: string }> = [];
  let cursor = 0;
  while (cursor < block.length) {
    while (/\s/u.test(block[cursor] ?? "")) cursor += 1;
    if (cursor >= block.length) break;

    staticCatalogEntryPattern.lastIndex = cursor;
    const match = staticCatalogEntryPattern.exec(block);
    if (match === null) {
      const excerpt = block
        .slice(cursor, cursor + 40)
        .trim()
        .replace(/\s+/gu, " ");
      throw new Error(
        `Unsupported or dynamic migrationEntries syntax near "${excerpt}"; every entry must be a static imported migration tuple.`,
      );
    }

    const id = match[1];
    const name = match[2];
    const migrationImport = match[3];
    if (id === undefined || name === undefined || migrationImport === undefined) {
      throw new Error("A migrationEntries tuple is incomplete.");
    }
    entries.push({ id: Number(id), name, migrationImport });
    cursor = staticCatalogEntryPattern.lastIndex;
    while (/\s/u.test(block[cursor] ?? "")) cursor += 1;
    if (cursor < block.length) {
      if (block[cursor] !== ",") {
        const excerpt = block
          .slice(cursor, cursor + 40)
          .trim()
          .replace(/\s+/gu, " ");
        throw new Error(`Expected a comma between migrationEntries tuples near "${excerpt}".`);
      }
      cursor += 1;
    }
  }
  return entries;
}

/**
 * Parse the native catalog together with the source file each entry executes.
 * Reading imports from the official source handles historical filename/name
 * differences such as migration 54 without guessing a path from its label.
 */
export function parseMigrationCatalog(source: string): MigrationCatalogEntry[] {
  const block = entriesBlockPattern.exec(source);
  if (block === null || block[1] === undefined) {
    throw new Error(`Could not locate the migrationEntries array in ${migrationsFile}.`);
  }

  const imports = new Map<string, string[]>();
  for (const match of source.matchAll(migrationImportsPattern)) {
    const alias = match[1];
    const importedFile = match[2];
    if (alias === undefined || importedFile === undefined || importedFile.includes("..")) {
      throw new Error(`Could not safely resolve a migration import in ${migrationsFile}.`);
    }
    const files = imports.get(alias) ?? [];
    files.push(importedFile);
    imports.set(alias, files);
  }

  const uncommentedBody = stripCatalogComments(block[1]);
  const entries: MigrationCatalogEntry[] = [];
  for (const parsed of parseStaticCatalogEntries(uncommentedBody)) {
    const importedFiles = imports.get(parsed.migrationImport) ?? [];
    if (importedFiles.length !== 1) {
      throw new Error(
        `Migration ${parsed.id} ("${parsed.name}") must resolve exactly once to an imported SQL script.`,
      );
    }
    entries.push({
      id: parsed.id,
      name: parsed.name,
      migrationFile: `apps/server/src/persistence/Migrations/${importedFiles[0]!}`,
    });
  }
  if (entries.length === 0) {
    throw new Error(`Parsed zero migrations from ${migrationsFile}; the guard cannot verify it.`);
  }

  const uncommentedBlock = block[0].replace(block[1], uncommentedBody);
  const uncommentedSource =
    source.slice(0, block.index) + uncommentedBlock + source.slice(block.index + block[0].length);
  const lineageEntries = parseMigrationLineage(uncommentedSource);
  for (let index = 0; index < lineageEntries.length; index += 1) {
    const expected = lineageEntries[index]!;
    const entry = entries[index];
    if (entry === undefined || entry.id !== expected.id || entry.name !== expected.name) {
      throw new Error(
        `Migration ${expected.id} ("${expected.name}") does not resolve exactly once to a supported imported SQL script.`,
      );
    }
  }
  if (entries.length !== lineageEntries.length) {
    throw new Error(
      `Migration catalog resolved ${entries.length} of ${lineageEntries.length} lineage entries from ${migrationsFile}.`,
    );
  }
  return entries;
}

const validCommit = (value: unknown): value is string =>
  typeof value === "string" && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/iu.test(value);
const validTag = (value: unknown): value is string =>
  typeof value === "string" && /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(value);

/**
 * Validate that the lock names two full, locally available official tag
 * commits. An ownership audit must fail closed when this evidence is absent.
 */
export function validatePinnedUpstreamProvenance(
  source: string,
  resolveTagCommit: (tag: string) => string | null,
): { readonly provenance: PinnedUpstreamProvenance | null; readonly problems: string[] } {
  let decoded: unknown;
  try {
    decoded = JSON.parse(source);
  } catch {
    return { provenance: null, problems: [`${upstreamLockFile} is not valid JSON.`] };
  }
  if (typeof decoded !== "object" || decoded === null) {
    return { provenance: null, problems: [`${upstreamLockFile} must contain an object.`] };
  }

  const lock = decoded as {
    readonly formatVersion?: unknown;
    readonly integratedBase?: { readonly tag?: unknown; readonly commit?: unknown };
    readonly candidate?: { readonly tag?: unknown; readonly commit?: unknown };
  };
  const problems: string[] = [];
  if (lock.formatVersion !== 1) {
    problems.push(`${upstreamLockFile} has an unsupported formatVersion.`);
  }

  const revisions: Array<{ name: "integratedBase" | "candidate"; value: unknown }> = [
    { name: "integratedBase", value: lock.integratedBase },
    { name: "candidate", value: lock.candidate },
  ];
  const validRevisions = new Map<string, PinnedUpstreamRevision>();
  for (const { name, value } of revisions) {
    if (typeof value !== "object" || value === null) {
      problems.push(`${upstreamLockFile} is missing ${name} provenance.`);
      continue;
    }
    const revision = value as { readonly tag?: unknown; readonly commit?: unknown };
    if (!validTag(revision.tag) || !validCommit(revision.commit)) {
      problems.push(`${upstreamLockFile} ${name} must name a release tag and full commit SHA.`);
      continue;
    }
    const resolvedCommit = resolveTagCommit(revision.tag);
    if (resolvedCommit === null) {
      problems.push(`Pinned upstream tag ${revision.tag} cannot be resolved from local Git.`);
      continue;
    }
    if (resolvedCommit.toLowerCase() !== revision.commit.toLowerCase()) {
      problems.push(
        `Pinned upstream tag ${revision.tag} resolves to ${resolvedCommit}, not ${revision.commit}.`,
      );
      continue;
    }
    validRevisions.set(name, { tag: revision.tag, commit: revision.commit.toLowerCase() });
  }

  const integratedBase = validRevisions.get("integratedBase");
  const candidate = validRevisions.get("candidate");
  if (problems.length > 0 || integratedBase === undefined || candidate === undefined) {
    return { provenance: null, problems };
  }
  return { provenance: { integratedBase, candidate }, problems };
}

const migrationIdentity = ({ id, name }: MigrationLineageEntry) => `${id}:${name}`;

/**
 * Enforce byte-for-byte ownership of the complete active catalog against the
 * pinned upstream candidate. The former native Context script is checked
 * separately because it remains on disk for legacy adoption but is no longer
 * an active native migration.
 */
export function findMigrationOwnershipViolations(
  current: readonly MigrationCatalogEntry[],
  integratedBase: readonly MigrationCatalogEntry[],
  candidate: readonly MigrationCatalogEntry[],
  frozenCompatibilitySha256?: string | undefined,
): string[] {
  const problems: string[] = [];
  const currentById = new Map(current.map((entry) => [entry.id, entry]));
  const currentIdentities = new Set(current.map(migrationIdentity));
  const candidateById = new Map(candidate.map((entry) => [entry.id, entry]));
  const candidateIdentities = new Set(candidate.map(migrationIdentity));

  for (const entry of integratedBase) {
    const next = candidateById.get(entry.id);
    if (next === undefined || next.name !== entry.name) {
      problems.push(
        `Pinned upstream candidate changes integrated migration ${entry.id} ("${entry.name}").`,
      );
      continue;
    }
    if (entry.sha256 === undefined || next.sha256 === undefined) {
      problems.push(`Cannot verify pinned upstream script bytes for migration ${entry.id}.`);
    } else if (entry.sha256 !== next.sha256) {
      problems.push(
        `Pinned upstream candidate changes the script bytes for existing migration ${entry.id} ("${entry.name}").`,
      );
    }
  }

  for (const entry of candidate) {
    if (!currentIdentities.has(migrationIdentity(entry))) {
      const localAtId = currentById.get(entry.id);
      problems.push(
        localAtId === undefined
          ? `Current native catalog is missing pinned upstream migration ${entry.id} ("${entry.name}").`
          : `Current native migration ${entry.id} is "${localAtId.name}"; pinned upstream owns "${entry.name}".`,
      );
      continue;
    }

    const local = currentById.get(entry.id);
    if (local?.sha256 === undefined || entry.sha256 === undefined) {
      problems.push(
        `Cannot verify local script bytes for official migration ${entry.id} ("${entry.name}").`,
      );
    } else if (local.sha256 !== entry.sha256) {
      problems.push(
        `Official migration ${entry.id} ("${entry.name}") does not match its pinned upstream script bytes.`,
      );
    }
  }

  const frozen = FROZEN_NATIVE_COMPATIBILITY_MIGRATION;
  if (frozenCompatibilitySha256 === undefined) {
    problems.push(`Cannot verify frozen compatibility script bytes at ${frozen.migrationFile}.`);
  } else if (frozenCompatibilitySha256 !== frozen.sha256) {
    problems.push(`Frozen compatibility script ${frozen.migrationFile} bytes changed.`);
  }

  for (const entry of current) {
    if (candidateIdentities.has(migrationIdentity(entry))) continue;
    problems.push(
      `Native migration ${entry.id} ("${entry.name}") is not owned by the pinned upstream catalog. ` +
        "Linx extensions belong in the independent workbench_sql_migrations ledger.",
    );
  }
  return problems;
}

/** Statically prove that the frozen script is still the active context1 implementation. */
export function findContextLedgerOwnershipViolations(source: string): string[] {
  const error = [
    "Context ledger must register the frozen ContextV1 effect as (context, 1), and include it exactly once in the active workbench catalog.",
  ];
  const file = ts.createSourceFile("WorkbenchMigrations.ts", source, ts.ScriptTarget.Latest, true);
  const declarations = new Map<string, ts.Expression>();
  let frozenImport: string | undefined;
  for (const statement of file.statements) {
    if (
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      statement.moduleSpecifier.text === "../../persistence/Migrations/111_ContextV1.ts"
    ) {
      if (frozenImport !== undefined || statement.importClause?.isTypeOnly) return error;
      frozenImport = statement.importClause?.name?.text;
    }
    if (
      !ts.isVariableStatement(statement) ||
      !statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ||
      (statement.declarationList.flags & ts.NodeFlags.Const) === 0
    )
      continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue;
      if (declarations.has(declaration.name.text)) return error;
      declarations.set(declaration.name.text, declaration.initializer);
    }
  }
  const unwrap = (expression: ts.Expression | undefined): ts.Expression | undefined => {
    while (
      expression &&
      (ts.isAsExpression(expression) ||
        ts.isParenthesizedExpression(expression) ||
        ts.isSatisfiesExpression(expression))
    )
      expression = expression.expression;
    return expression;
  };
  const context = unwrap(declarations.get("contextWorkbenchMigrationEntries"));
  if (
    !frozenImport ||
    !context ||
    !ts.isArrayLiteralExpression(context) ||
    context.elements.length !== 1
  )
    return error;
  const entry = context.elements[0];
  if (!entry || !ts.isObjectLiteralExpression(entry)) return error;
  const fields = new Map<string, ts.Expression>();
  for (const property of entry.properties) {
    if (
      !ts.isPropertyAssignment(property) ||
      !(ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) ||
      fields.has(property.name.text)
    )
      return error;
    fields.set(property.name.text, property.initializer);
  }
  const literal = (name: string) => {
    const value = unwrap(fields.get(name));
    return value && (ts.isStringLiteral(value) || ts.isNumericLiteral(value))
      ? value.text
      : undefined;
  };
  const effect = unwrap(fields.get("effect"));
  if (
    fields.size !== 5 ||
    literal("moduleId") !== "context" ||
    literal("migrationId") !== "1" ||
    literal("name") !== FROZEN_NATIVE_COMPATIBILITY_MIGRATION.name ||
    literal("checksum") !== `sha256:${FROZEN_NATIVE_COMPATIBILITY_MIGRATION.sha256}` ||
    !effect ||
    !ts.isIdentifier(effect) ||
    effect.text !== frozenImport
  )
    return error;
  const all = unwrap(declarations.get("allWorkbenchMigrationEntries"));
  const names = ["workbenchMigrationEntries", "contextWorkbenchMigrationEntries"];
  if (
    !all ||
    !ts.isArrayLiteralExpression(all) ||
    all.elements.length !== names.length ||
    all.elements.some(
      (element, index) =>
        !ts.isSpreadElement(element) ||
        !ts.isIdentifier(element.expression) ||
        element.expression.text !== names[index],
    )
  )
    return error;
  return [];
}

export interface MigrationLineageViolation {
  readonly id: number;
  readonly releasedName: string;
  readonly currentName: string | null;
}

/** A released (id, name) pair whose divergence from today's lineage is handled. */
export interface MigrationLineageAllowance {
  readonly id: number;
  readonly name: string;
}

/**
 * Divergences that already shipped and that the runtime handles by a mechanism
 * other than `MIGRATION_LINEAGE_ALIASES`. Each entry is a reviewed claim that
 * upgrading such a database is safe today; nothing may be added here without
 * naming the mechanism that makes it so.
 *
 * These exist because the guard was written after the fact. New divergences are
 * not supposed to reach this list — append a migration instead.
 */
const HANDLED_RELEASED_DIVERGENCES: readonly MigrationLineageAllowance[] = [
  // v0.0.15 and older recorded these two at 17/18 before the slots were reused.
  // `LAST_SHARED_LINEAGE_MIGRATION_ID` sits at 16 precisely because of them: a
  // divergence above that boundary takes the replay path, and every migration
  // past 16 is idempotent, so replaying 17.. over such a database is safe.
  { id: 17, name: "ProjectionThreadsArchivedAt" },
  { id: 18, name: "ProjectionThreadsArchivedAtIndex" },
  // Renamed in place (not renumbered) during the Synara identity cutover, so
  // migration 32 is the same migration under a new name. `reconcileMigrationLineage`
  // renames the tracker row back to the canonical name whenever the rows below
  // it are canonical, which is the only way this pair can occur.
  { id: 32, name: "ReconcileLegacyT3SchemaImport" },
  // These were shipped as official IDs before WB-02 moved the exact histories
  // into the expert-owned workbench ledger. Startup recognizes their frozen
  // names/schema, snapshots the original database, then adopts them before the
  // official migrator runs. Their IDs are no longer in today's official list.
  { id: 109, name: "ProjectionThreadsExpertBinding" },
  { id: 110, name: "ExpertAppliedRuntimeRecords" },
  // Exact legacy Context history is adopted into context1 after the same backup/transaction gate.
  { id: 111, name: "ContextV1" },
];

const entriesBlockPattern = /export const migrationEntries\s*=\s*\[([\s\S]*?)\]\s*as const;/u;
const entryPattern = /\[\s*(\d+)\s*,\s*"([^"]+)"/gu;
const aliasesBlockPattern = /export const MIGRATION_LINEAGE_ALIASES[^=]*=\s*\[([\s\S]*?)\n\];/u;
const aliasPattern = /historicalId:\s*(\d+),\s*(?:\/\/[^\n]*\n\s*)*historicalName:\s*"([^"]+)"/gu;

export function parseMigrationLineage(source: string): MigrationLineageEntry[] {
  const block = entriesBlockPattern.exec(source);
  if (block === null || block[1] === undefined) {
    throw new Error(`Could not locate the migrationEntries array in ${migrationsFile}.`);
  }
  const entries: MigrationLineageEntry[] = [];
  for (const match of block[1].matchAll(entryPattern)) {
    entries.push({ id: Number(match[1]), name: match[2]! });
  }
  if (entries.length === 0) {
    throw new Error(`Parsed zero migrations from ${migrationsFile}; the guard cannot verify it.`);
  }
  return entries;
}

/**
 * The (id, name) pairs the runtime reconciler can repair without replaying a
 * schema. Absent block means no aliases are declared, which is the normal state
 * — only a parsed-but-empty block would be suspicious, and that reads the same.
 */
export function parseMigrationLineageAllowances(source: string): MigrationLineageAllowance[] {
  const block = aliasesBlockPattern.exec(source);
  if (block === null || block[1] === undefined) {
    return [];
  }
  return [...block[1].matchAll(aliasPattern)].map((match) => ({
    id: Number(match[1]),
    name: match[2]!,
  }));
}

/**
 * Structural problems that make the lineage unusable regardless of history:
 * the Effect migrator rejects duplicate IDs outright, and out-of-order entries
 * mean the file no longer reads as an append-only log.
 */
export function findLineageStructureViolations(
  entries: readonly MigrationLineageEntry[],
): string[] {
  const problems: string[] = [];
  const seen = new Map<number, string>();
  let previousId = 0;
  for (const entry of entries) {
    const duplicate = seen.get(entry.id);
    if (duplicate !== undefined) {
      problems.push(
        `Migration ${entry.id} is declared twice ("${duplicate}" and "${entry.name}").`,
      );
    }
    seen.set(entry.id, entry.name);
    if (entry.id <= previousId) {
      problems.push(`Migration ${entry.id} ("${entry.name}") is out of ascending order.`);
    }
    previousId = entry.id;
  }
  return problems;
}

export function findReleasedLineageViolations(
  released: readonly MigrationLineageEntry[],
  current: readonly MigrationLineageEntry[],
  allowances: readonly MigrationLineageAllowance[] = [],
): MigrationLineageViolation[] {
  const currentNamesById = new Map(current.map((entry) => [entry.id, entry.name]));
  const allowed = new Set(allowances.map((allowance) => `${allowance.id}:${allowance.name}`));
  const violations: MigrationLineageViolation[] = [];
  for (const entry of released) {
    const currentName = currentNamesById.get(entry.id);
    if (currentName === entry.name) continue;
    if (allowed.has(`${entry.id}:${entry.name}`)) continue;
    violations.push({
      id: entry.id,
      releasedName: entry.name,
      currentName: currentName ?? null,
    });
  }
  return violations;
}

function git(args: readonly string[]): { readonly status: number; readonly stdout: string } {
  const result = spawnSync("git", [...args], { cwd: repoRoot, encoding: "utf8" });
  return { status: result.status ?? 1, stdout: result.stdout ?? "" };
}

function gitFile(commit: string, path: string): Buffer | null {
  const result = spawnSync("git", ["show", `${commit}:${path}`], {
    cwd: repoRoot,
    encoding: null,
  });
  return result.status === 0 && Buffer.isBuffer(result.stdout) ? result.stdout : null;
}

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

function hashCurrentCatalog(entries: readonly MigrationCatalogEntry[]): {
  readonly entries: MigrationCatalogEntry[];
  readonly problems: string[];
} {
  const problems: string[] = [];
  const hashed: MigrationCatalogEntry[] = [];
  for (const entry of entries) {
    try {
      hashed.push({
        ...entry,
        sha256: sha256(readFileSync(resolve(repoRoot, entry.migrationFile))),
      });
    } catch {
      problems.push(`Current migration script is unreadable: ${entry.migrationFile}.`);
    }
  }
  return { entries: hashed, problems };
}

function readPinnedCatalog(
  commit: string,
  label: string,
): {
  readonly entries: MigrationCatalogEntry[] | null;
  readonly problems: string[];
} {
  const sourceBytes = gitFile(commit, migrationsFile);
  if (sourceBytes === null) {
    return {
      entries: null,
      problems: [`Pinned upstream ${label} source ${commit}:${migrationsFile} is unreadable.`],
    };
  }

  let parsed: MigrationCatalogEntry[];
  try {
    parsed = parseMigrationCatalog(sourceBytes.toString("utf8"));
  } catch (error) {
    return {
      entries: null,
      problems: [
        `Pinned upstream ${label} migration catalog is unreadable: ${error instanceof Error ? error.message : String(error)}`,
      ],
    };
  }

  const entries: MigrationCatalogEntry[] = [];
  const problems: string[] = [];
  for (const entry of parsed) {
    const scriptBytes = gitFile(commit, entry.migrationFile);
    if (scriptBytes === null) {
      problems.push(
        `Pinned upstream ${label} migration ${entry.id} ("${entry.name}") script is unreadable at ${entry.migrationFile}.`,
      );
      continue;
    }
    entries.push({ ...entry, sha256: sha256(scriptBytes) });
  }
  return { entries: problems.length === 0 ? entries : null, problems };
}

function auditCurrentMigrationOwnership(currentSource: string): string[] {
  let lockSource: string;
  try {
    lockSource = readFileSync(resolve(repoRoot, upstreamLockFile), "utf8");
  } catch {
    return [`Pinned upstream provenance is missing: ${upstreamLockFile} is unreadable.`];
  }

  const provenance = validatePinnedUpstreamProvenance(lockSource, (tag) => {
    const resolved = git(["rev-parse", "--verify", `refs/tags/${tag}^{commit}`]);
    return resolved.status === 0 ? resolved.stdout.trim() : null;
  });
  if (provenance.problems.length > 0 || provenance.provenance === null) {
    return [
      "Migration ownership audit cannot verify its pinned upstream source:",
      ...provenance.problems,
    ];
  }

  const { integratedBase, candidate } = provenance.provenance;
  const ancestry = git(["merge-base", "--is-ancestor", integratedBase.commit, candidate.commit]);
  if (ancestry.status !== 0) {
    return [
      `Pinned upstream candidate ${candidate.tag} is not a verified descendant of integrated base ${integratedBase.tag}.`,
    ];
  }

  let currentParsed: MigrationCatalogEntry[];
  try {
    currentParsed = parseMigrationCatalog(currentSource);
  } catch (error) {
    return [
      `Current native migration catalog cannot be audited: ${error instanceof Error ? error.message : String(error)}`,
    ];
  }
  const currentHashed = hashCurrentCatalog(currentParsed);
  const base = readPinnedCatalog(integratedBase.commit, `integrated base ${integratedBase.tag}`);
  const next = readPinnedCatalog(candidate.commit, `candidate ${candidate.tag}`);
  const problems = [...currentHashed.problems, ...base.problems, ...next.problems];
  if (problems.length > 0 || base.entries === null || next.entries === null) {
    return ["Migration ownership audit cannot verify pinned migration source files:", ...problems];
  }

  let frozenCompatibilitySha256: string;
  try {
    frozenCompatibilitySha256 = sha256(
      readFileSync(resolve(repoRoot, FROZEN_NATIVE_COMPATIBILITY_MIGRATION.migrationFile)),
    );
  } catch {
    return [
      `Frozen compatibility migration is unreadable: ${FROZEN_NATIVE_COMPATIBILITY_MIGRATION.migrationFile}.`,
    ];
  }

  let contextLedgerProblems: string[];
  try {
    contextLedgerProblems = findContextLedgerOwnershipViolations(
      readFileSync(
        resolve(repoRoot, "apps/server/src/workbench/persistence/WorkbenchMigrations.ts"),
        "utf8",
      ),
    );
  } catch {
    contextLedgerProblems = ["Cannot verify the Context workbench ledger source."];
  }
  return [
    ...findMigrationOwnershipViolations(
      currentHashed.entries,
      base.entries,
      next.entries,
      frozenCompatibilitySha256,
    ),
    ...contextLedgerProblems,
  ];
}

const defaultListTags = (pattern: string): readonly string[] => {
  const result = git(["tag", "--merged", "HEAD", "--list", pattern, "--sort=-v:refname"]);
  return result.status === 0
    ? result.stdout
        .split("\n")
        .map((tag) => tag.trim())
        .filter(Boolean)
    : [];
};

const defaultIsShallowRepository = (): boolean => {
  const result = git(["rev-parse", "--is-shallow-repository"]);
  if (
    result.status !== 0 ||
    (result.stdout.trim() !== "true" && result.stdout.trim() !== "false")
  ) {
    throw new Error("Cannot determine whether this checkout has complete Git history.");
  }
  return result.stdout.trim() === "true";
};

/**
 * Every release tag whose commit is an ancestor of HEAD, newest first. Tags on
 * unrelated remote branches are excluded. Missing or shallow history is a
 * hard failure because the guard cannot prove which migrations have shipped.
 */
export function resolveReleaseTags(
  listTags: (pattern: string) => readonly string[] = defaultListTags,
  isShallowRepository: () => boolean = defaultIsShallowRepository,
): string[] {
  if (isShallowRepository()) {
    throw new Error("Migration lineage cannot be verified from a shallow Git checkout.");
  }
  const tags = [...listTags("v[0-9]*")];
  if (tags.length === 0) {
    throw new Error(
      "No release tag is reachable from this checkout; migration lineage cannot be verified.",
    );
  }
  return tags;
}

interface TaggedViolation {
  readonly violation: MigrationLineageViolation;
  readonly tags: string[];
}

/**
 * Collapses per-tag violations to one line per broken pair. Every v0.5.x tag
 * shipping the same migration 54 is one mistake, not five.
 */
export function groupViolationsByPair(
  perTag: ReadonlyArray<{
    readonly tag: string;
    readonly violations: readonly MigrationLineageViolation[];
  }>,
): TaggedViolation[] {
  const grouped = new Map<string, TaggedViolation>();
  for (const { tag, violations } of perTag) {
    for (const violation of violations) {
      const key = `${violation.id}:${violation.releasedName}`;
      const existing = grouped.get(key);
      if (existing) {
        existing.tags.push(tag);
        continue;
      }
      grouped.set(key, { violation, tags: [tag] });
    }
  }
  return [...grouped.values()].toSorted((left, right) => left.violation.id - right.violation.id);
}

function main(): void {
  const currentSource = readFileSync(resolve(repoRoot, migrationsFile), "utf8");
  const currentEntries = parseMigrationLineage(currentSource);
  const allowances = [
    ...parseMigrationLineageAllowances(currentSource),
    ...HANDLED_RELEASED_DIVERGENCES,
  ];

  const structureProblems = findLineageStructureViolations(currentEntries);
  if (structureProblems.length > 0) {
    console.error("Migration lineage is malformed:");
    for (const problem of structureProblems) console.error(`- ${problem}`);
    process.exitCode = 1;
    return;
  }

  const ownershipProblems = auditCurrentMigrationOwnership(currentSource);
  if (ownershipProblems.length > 0) {
    console.error("Migration ownership audit failed:");
    for (const problem of ownershipProblems) console.error(`- ${problem}`);
    process.exitCode = 1;
  } else {
    console.log(
      "Migration ownership audit passed: pinned upstream catalog and frozen migration 111 are valid.",
    );
  }

  let tags: string[];
  try {
    tags = resolveReleaseTags();
  } catch (error) {
    console.error(
      `Migration lineage history check failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
    return;
  }

  const checked: string[] = [];
  const perTag: Array<{ tag: string; violations: readonly MigrationLineageViolation[] }> = [];
  for (const tag of tags) {
    const released = git(["show", `${tag}:${migrationsFile}`]);
    if (released.status !== 0) {
      console.error(`Cannot read ${migrationsFile} from release tag ${tag}.`);
      process.exitCode = 1;
      return;
    }
    let releasedEntries: MigrationLineageEntry[];
    try {
      releasedEntries = parseMigrationLineage(released.stdout);
    } catch (error) {
      console.error(
        `Cannot verify migration lineage at release tag ${tag}: ${error instanceof Error ? error.message : String(error)}`,
      );
      process.exitCode = 1;
      return;
    }
    checked.push(tag);
    const violations = findReleasedLineageViolations(releasedEntries, currentEntries, allowances);
    if (violations.length > 0) perTag.push({ tag, violations });
  }

  if (perTag.length === 0) {
    console.log(
      `Migration lineage check passed: all migrations shipped across ${checked.length} release ` +
        `tags (${checked[checked.length - 1]}..${checked[0]}) keep their released (id, name)` +
        ".",
    );
    return;
  }

  console.error(
    "Migration lineage changed for migrations that were already shipped. " +
      "Released (id, name) pairs are recorded in every user's effect_sql_migrations table; " +
      "changing one makes the reconciler treat those databases as a foreign lineage and replay " +
      "their schema. Append a new migration instead of renumbering or renaming a shipped one, " +
      "or declare a reviewed MIGRATION_LINEAGE_ALIASES entry if the change already shipped.",
  );
  for (const { violation, tags: shippedIn } of groupViolationsByPair(perTag)) {
    console.error(
      `- migration ${violation.id}: ${shippedIn.join(", ")} shipped ` +
        `"${violation.releasedName}", ${migrationsFile} now has ${
          violation.currentName === null ? "no entry" : `"${violation.currentName}"`
        }.`,
    );
  }
  process.exitCode = 1;
}

if (import.meta.main) main();
