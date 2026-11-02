// Purpose: Keep native runtime and persistence dependencies behind Workbench host seams.

import fs from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");
const automaticFeatureRoots = [
  "apps/server/src/workbench/features",
  "apps/web/src/workbench/features",
  "apps/server/src/experts",
] as const;
const extensions = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs"]);
const restrictedRoots = [
  ["apps/server/src/persistence", "native persistence"],
  ["apps/server/src/provider", "Provider runtime control"],
  ["apps/server/src/orchestration", "task internals"],
  ["apps/server/src/agentGateway", "Agent Gateway runtime control"],
  ["apps/server/src/auth", "native credentials and authorization"],
  ["apps/server/src/providerUsage", "native provider usage storage"],
  ["apps/web/src/nativeApi", "full native client"],
  ["apps/web/src/wsNativeApi", "native transport"],
  ["apps/web/src/store", "native task store"],
  ["apps/web/src/routes", "native routes"],
  ["apps/web/src/projectInstructionsStore", "legacy project context cache"],
  ["apps/server/src/context", "native persistence"],
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

// Exact retained seams: do not exempt an entire legacy directory. Their owners and
// regression paths are recorded in workbench/integration-points.json.
export const WORKBENCH_RETAINED_IMPORTS = [
  {
    file: "apps/server/src/agentGateway/hubExpertDispatch.ts",
    specifier: "../provider/Services/ProviderDiscoveryService.ts",
  },
  {
    file: "apps/server/src/agentGateway/hubExpertDispatch.ts",
    specifier: "./targetResolver.ts",
  },
  {
    file: "apps/server/src/agentGateway/hubExpertDispatch.ts",
    specifier: "./toolInput.ts",
  },
  {
    file: "apps/server/src/projectAgent/hubDeliverables.ts",
    specifier: "effect/unstable/sql/SqlClient",
  },
  {
    file: "apps/server/src/experts/ExpertGatewayTools.ts",
    specifier: "../agentGateway/protocol.ts",
  },
  {
    file: "apps/server/src/experts/ExpertGatewayTools.ts",
    specifier: "../agentGateway/toolRuntime.ts",
  },
  {
    file: "apps/server/src/experts/ExpertMcpCredentials.ts",
    specifier: "../auth/Layers/ServerSecretStore.ts",
  },
  {
    file: "apps/server/src/experts/ExpertMcpCredentials.ts",
    specifier: "../auth/Services/ServerSecretStore.ts",
  },
  { file: "apps/server/src/experts/McpConfigSource.ts", specifier: "../providerUsage/sqlite.ts" },
  {
    file: "apps/server/src/experts/SkillPackageStore.ts",
    specifier: "../provider/skillsCatalog.ts",
  },
  {
    file: "apps/web/src/components/settings/useExpertDraftGuard.tsx",
    specifier: "@tanstack/react-router",
  },
] as const;

const isExpertSurface = (file: string) =>
  /^apps\/web\/src\/components\/settings\/(?:Expert|expert|GlobalMcp|globalMcp|LocalMcp|useExpertDraftGuard|SkillPicker)[^/]*\.[jt]sx?$/.test(
    file,
  ) || /^apps\/web\/src\/components\/chat\/Expert[^/]*\.[jt]sx?$/.test(file);

const isSpaceSurface = (file: string) =>
  /^apps\/web\/src\/components\/(?:Space[^/]*|chat\/ContextDetailsDialog)\.[jt]sx?$/.test(file);

const isProjectContextSurface = (file: string) =>
  /^apps\/web\/src\/components\/chat\/environment\/(?:projectContextAutosave|projectContextNavigationGuard|useProjectContextAutosave|useProjectContextMigration)\.[jt]sx?$/.test(
    file,
  );

export interface WorkbenchFeatureSource {
  readonly path: string;
  readonly source: string;
}

export interface WorkbenchBoundaryViolation {
  readonly file: string;
  readonly specifier: string;
  readonly boundary: string;
}

export interface WorkbenchBoundaryManifest {
  readonly integrationPoints: ReadonlyArray<{
    readonly id: string;
    readonly entryFiles?: ReadonlyArray<string>;
    readonly tests?: ReadonlyArray<string>;
    readonly featureFiles?: ReadonlyArray<string>;
    readonly featureRoots?: ReadonlyArray<string>;
    readonly retainedImports?: ReadonlyArray<{
      readonly file: string;
      readonly specifiers: ReadonlyArray<string>;
      readonly owner: string;
      readonly reason: string;
      readonly tests: ReadonlyArray<string>;
    }>;
  }>;
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
      /\.(?:test|spec|browser)\.[cm]?[jt]sx?$/.test(file)
    ) {
      return [];
    }
    return [file];
  });
}

function assertRepoRelativePath(value: string, description: string): string {
  if (
    value.length === 0 ||
    value.includes("\\") ||
    path.posix.isAbsolute(value) ||
    path.posix.normalize(value) !== value ||
    value === "." ||
    value.startsWith("../")
  ) {
    throw new Error(`${description} must be a normalized repository-relative path: ${value}`);
  }
  return value;
}

function readBoundaryManifest(
  root: string,
  requireManifest: boolean,
): WorkbenchBoundaryManifest | undefined {
  const manifestPath = path.join(root, "workbench/integration-points.json");
  if (!fs.existsSync(manifestPath)) {
    if (requireManifest) {
      throw new Error("Required Workbench manifest is missing: workbench/integration-points.json");
    }
    return undefined;
  }

  let manifest: WorkbenchBoundaryManifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as WorkbenchBoundaryManifest;
  } catch (cause) {
    throw new Error("Could not parse workbench/integration-points.json", { cause });
  }
  if (!Array.isArray(manifest.integrationPoints)) {
    throw new Error("workbench/integration-points.json must declare integrationPoints");
  }

  const requireFile = (file: string, description: string) => {
    const safePath = assertRepoRelativePath(file, description);
    if (
      !fs.existsSync(path.join(root, safePath)) ||
      !fs.statSync(path.join(root, safePath)).isFile()
    ) {
      throw new Error(`${description} does not exist: ${safePath}`);
    }
  };
  const requireDirectory = (directory: string, description: string) => {
    const safePath = assertRepoRelativePath(directory, description);
    if (
      !fs.existsSync(path.join(root, safePath)) ||
      !fs.statSync(path.join(root, safePath)).isDirectory()
    ) {
      throw new Error(`${description} does not exist: ${safePath}`);
    }
  };

  for (const point of manifest.integrationPoints) {
    for (const file of [...(point.entryFiles ?? []), ...(point.tests ?? [])]) {
      requireFile(file, `${point.id} integration reference`);
    }
    for (const file of point.featureFiles ?? []) {
      requireFile(file, `${point.id} feature file`);
      if (
        !extensions.has(path.posix.extname(file)) ||
        /\.(?:test|spec|browser)\.[cm]?[jt]sx?$/.test(file)
      ) {
        throw new Error(`${point.id} feature file is not a scanned implementation source: ${file}`);
      }
    }
    for (const directory of point.featureRoots ?? []) {
      requireDirectory(directory, `${point.id} feature root`);
    }
    for (const seam of point.retainedImports ?? []) {
      requireFile(seam.file, `${point.id} retained import`);
      if (
        seam.specifiers.length === 0 ||
        seam.owner.trim().length === 0 ||
        seam.reason.trim().length === 0 ||
        seam.tests.length === 0
      ) {
        throw new Error(
          `${point.id} retained import requires specifiers, owner, reason and tests: ${seam.file}`,
        );
      }
      for (const file of seam.tests) requireFile(file, `${point.id} retained import test`);
    }
  }
  return manifest;
}

function manifestFeatureCoverage(manifest: WorkbenchBoundaryManifest | undefined) {
  return {
    files: manifest?.integrationPoints.flatMap((point) => point.featureFiles ?? []) ?? [],
    roots: manifest?.integrationPoints.flatMap((point) => point.featureRoots ?? []) ?? [],
  };
}

/** Missing default feature roots remain valid; a real CLI run requires and validates the manifest. */
export function collectWorkbenchFeatureSources(
  root: string,
  options: { readonly requireManifest?: boolean } = {},
): WorkbenchFeatureSource[] {
  const manifest = readBoundaryManifest(root, options.requireManifest ?? false);
  const { files, roots } = manifestFeatureCoverage(manifest);
  const featureFiles = files.map((file) => assertRepoRelativePath(file, "feature file"));
  const featureRoots = roots.map((directory) => assertRepoRelativePath(directory, "feature root"));
  const legacyWebSources = walk(root, "apps/web/src/components").filter(
    (file) => isExpertSurface(file) || isSpaceSurface(file) || isProjectContextSurface(file),
  );
  const scannedFiles = new Set([
    ...automaticFeatureRoots.flatMap((directory) => walk(root, directory)),
    ...featureRoots.flatMap((directory) => walk(root, directory)),
    ...legacyWebSources,
    ...featureFiles,
  ]);
  const sources = [...scannedFiles]
    .toSorted()
    .map((file) => ({ path: file, source: fs.readFileSync(path.join(root, file), "utf8") }));

  const boundaryPoint = manifest?.integrationPoints.find(
    (point) => point.id === "workbench.feature-import-boundary",
  );
  if (manifest !== undefined && boundaryPoint === undefined) {
    throw new Error("Workbench manifest is missing workbench.feature-import-boundary");
  }
  if (boundaryPoint !== undefined) {
    const declaredSeams = (boundaryPoint.retainedImports ?? []).flatMap((seam) =>
      seam.specifiers.map((specifier) => `${seam.file}:${specifier}`),
    );
    const implementedSeams = WORKBENCH_RETAINED_IMPORTS.map(
      (seam) => `${seam.file}:${seam.specifier}`,
    );
    if (declaredSeams.toSorted().join("\n") !== implementedSeams.toSorted().join("\n")) {
      throw new Error(
        "Workbench retained imports in the manifest do not match the guard allowlist",
      );
    }
    const sourceFiles = new Set(sources.map(({ path: file }) => file));
    for (const seam of WORKBENCH_RETAINED_IMPORTS) {
      if (!sourceFiles.has(seam.file)) {
        throw new Error(`Retained import owner is outside scanner coverage: ${seam.file}`);
      }
    }
  }
  return sources;
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
  if (
    WORKBENCH_RETAINED_IMPORTS.some((seam) => seam.file === file && seam.specifier === specifier)
  ) {
    return undefined;
  }
  if (specifier === "@tanstack/react-router" || specifier.startsWith("@tanstack/react-router/")) {
    return "native router";
  }
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
    : restrictedRoots.find(
        ([root]) => isWithin(target, root) || target.replace(/\.[cm]?[jt]sx?$/, "") === root,
      )?.[1];
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
  let sources: WorkbenchFeatureSource[];
  try {
    sources = collectWorkbenchFeatureSources(repoRoot, { requireManifest: true });
  } catch (cause) {
    console.error(`Workbench feature boundary configuration error: ${String(cause)}`);
    process.exitCode = 1;
    return;
  }
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
