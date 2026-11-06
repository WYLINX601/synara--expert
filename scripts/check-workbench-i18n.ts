import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { auditLocalization, type LocalizationDiagnostic } from "./i18n";

type LegacyLiteral = Pick<LocalizationDiagnostic, "file" | "code" | "message"> & {
  count: number;
};

function key(entry: Pick<LocalizationDiagnostic, "file" | "code" | "message">): string {
  return JSON.stringify([entry.file, entry.code, entry.message]);
}

/** Exact file, diagnostic and occurrence budgets; no directory or substring exemptions. */
export function checkLegacyLiterals(
  literals: readonly LocalizationDiagnostic[],
  baseline: unknown,
): { errors: string[]; inherited: number } {
  if (!baseline || typeof baseline !== "object")
    return { errors: ["Invalid legacy literal baseline."], inherited: 0 };
  const data = baseline as Record<string, unknown>;
  if (
    data.formatVersion !== 1 ||
    typeof data.sourceSha !== "string" ||
    !/^[a-f0-9]{40}$/.test(data.sourceSha) ||
    !Array.isArray(data.entries)
  )
    return { errors: ["Invalid legacy literal baseline."], inherited: 0 };
  const budgets = new Map<string, number>();
  for (const value of data.entries) {
    if (!value || typeof value !== "object")
      return { errors: ["Invalid legacy literal entry."], inherited: 0 };
    const entry = value as LegacyLiteral;
    if (
      typeof entry.file !== "string" ||
      typeof entry.code !== "string" ||
      typeof entry.message !== "string" ||
      !Number.isSafeInteger(entry.count) ||
      entry.count <= 0 ||
      budgets.has(key(entry))
    )
      return { errors: ["Invalid or duplicate legacy literal entry."], inherited: 0 };
    budgets.set(key(entry), entry.count);
  }
  const errors: string[] = [];
  let inherited = 0;
  for (const literal of literals) {
    const identity = key(literal);
    const remaining = budgets.get(identity) ?? 0;
    if (remaining > 0) {
      inherited++;
      budgets.set(identity, remaining - 1);
    } else {
      errors.push(`${literal.file}:${literal.line ?? 0}: ${literal.message}`);
    }
  }
  // Removing/translating old copy must shrink the baseline, never leave spare allowances.
  for (const [identity, remaining] of budgets) {
    if (remaining > 0) errors.push(`Remove ${remaining} stale legacy allowance(s): ${identity}`);
  }
  return { errors, inherited };
}

if (import.meta.main) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const report = auditLocalization(root);
  const baseline: unknown = JSON.parse(
    readFileSync(path.join(root, "workbench/i18n-legacy-literals.json"), "utf8"),
  );
  const result = checkLegacyLiterals(report.literals, baseline);
  for (const error of report.errors)
    process.stderr.write(`${error.file}:${error.line ?? 0}: ${error.message}\n`);
  for (const error of result.errors) process.stderr.write(`${error}\n`);
  process.stdout.write(
    `${report.errors.length} catalog errors; ${result.errors.length} coverage regressions; ${result.inherited} inherited untranslated occurrences.\n`,
  );
  process.exitCode = report.errors.length || result.errors.length ? 1 : 0;
}
