// Purpose: Keep native runtime and persistence dependencies behind Workbench host seams.

import fs from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");
const featureRoots = [
  "apps/server/src/workbench/features",
  "apps/web/src/workbench/features",
] as const;
const extensions = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs"]);
const restrictedRoots = [
  ["apps/server/src/persistence", "native persistence"],
  ["apps/server/src/provider", "Provider runtime control"],
  ["apps/server/src/orchestration", "task internals"],
  ["apps/server/src/agentGateway", "Agent Gateway runtime control"],
] as const;
const databasePackages = [
  "@effect/sql",
  "@effect/sql-sqlite-bun",
  "better-sqlite3",
  "bun:sqlite",
  "effect/unstable/sql",
  "node:sqlite",
  "sqlite3",
] as const;

export interface WorkbenchFeatureSource {
  readonly path: string;
  readonly source: string;
}

export interface WorkbenchBoundaryViolation {
  readonly file: string;
  readonly specifier: string;
  readonly boundary: string;
}

const isWithin = (candidate: string, root: string) =>
  candidate === root || candidate.startsWith(`${root}/`);

function walk(root: string, directory: string): string[] {
  const absoluteDirectory = path.join(root, directory);
  if (!fs.existsSync(absoluteDirectory)) return [];
  return fs.readdirSync(absoluteDirectory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.posix.join(directory, entry.name);
    if (entry.isDirectory()) return walk(root, file);
    if (!entry.isFile() || !extensions.has(path.posix.extname(file))) return [];
    if (
      /(?:^|\/)(?:__tests__|fixtures|testing)(?:\/|$)/.test(file) ||
      /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file)
    ) {
      return [];
    }
    return [file];
  });
}

/** Missing roots are valid until a feature is added; later files are scanned automatically. */
export function collectWorkbenchFeatureSources(root: string): WorkbenchFeatureSource[] {
  return featureRoots
    .flatMap((directory) => walk(root, directory))
    .toSorted()
    .map((file) => ({ path: file, source: fs.readFileSync(path.join(root, file), "utf8") }));
}

function specifiers(source: string): string[] {
  const code = source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/gu, "");
  const patterns = [
    /\b(?:from|import)\s*["']([^"']+)["']/gu,
    /\bimport\s*\(\s*["']([^"']+)["']/gu,
    /\brequire\s*\(\s*["']([^"']+)["']/gu,
  ];
  return [...new Set(patterns.flatMap((pattern) => [...code.matchAll(pattern)].map((m) => m[1]!)))];
}

function localTarget(file: string, specifier: string): string | undefined {
  if (specifier.startsWith("~/")) {
    return path.posix.normalize(path.posix.join("apps/web/src", specifier.slice(2)));
  }
  if (/^apps\/(?:server|web)\/src\//u.test(specifier)) return path.posix.normalize(specifier);
  if (specifier.startsWith("./") || specifier.startsWith("../")) {
    return path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier));
  }
  return undefined;
}

function boundaryFor(file: string, specifier: string): string | undefined {
  if (databasePackages.some((name) => specifier === name || specifier.startsWith(`${name}/`))) {
    return "native database access";
  }
  const target = localTarget(file, specifier);
  if (
    target !== undefined &&
    (isWithin(target, "apps/server/src/workbench/host") ||
      isWithin(target, "apps/web/src/workbench/host"))
  ) {
    return undefined;
  }
  return target === undefined
    ? undefined
    : restrictedRoots.find(([root]) => isWithin(target, root))?.[1];
}

export function findWorkbenchFeatureBoundaryViolations(
  file: string,
  source: string,
): WorkbenchBoundaryViolation[] {
  return specifiers(source).flatMap((specifier) => {
    const boundary = boundaryFor(file, specifier);
    return boundary === undefined ? [] : [{ file, specifier, boundary }];
  });
}

function main(): void {
  const sources = collectWorkbenchFeatureSources(repoRoot);
  const violations = sources.flatMap(({ path: file, source }) =>
    findWorkbenchFeatureBoundaryViolations(file, source),
  );
  if (violations.length > 0) {
    console.error("Workbench feature import boundary violations:");
    for (const { file, specifier, boundary } of violations) {
      console.error(
        `- ${file} imports ${specifier} (${boundary}); access it through an explicit workbench/host integration.`,
      );
    }
    process.exitCode = 1;
    return;
  }
  console.log(`Workbench feature boundaries verified across ${sources.length} source files.`);
}

if (import.meta.main) main();
