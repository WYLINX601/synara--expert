import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import * as ts from "typescript";
import { spawnProcessSync } from "@synara/shared/processRuntime";
import {
  writeReleaseArtifactProvenance,
  type ReleaseArtifactPlatform,
  type ReleaseArtifactProvenanceManifest,
} from "./release-artifact-provenance.ts";
import {
  findLineageStructureViolations,
  parseMigrationLineage,
} from "../check-migration-lineage.ts";
import { runGit } from "./workbench-sync/git.ts";
import {
  expectedCandidateBranch,
  readSyncLock,
  validateFixedOfficialTag,
  type WorkbenchSyncLock,
} from "./workbench-sync/sync.ts";

const SHA_PATTERN = /^[0-9a-f]{40}$/i;
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const MAX_PROBE_MS = 10_000;
const MAX_BUILD_MS = 60 * 60 * 1000;

export type WorkbenchBuildFlavor = "workbench" | "workbench-preview";
export type WorkbenchBuildPlatform = ReleaseArtifactPlatform;
export type WorkbenchBuildArch = "arm64" | "x64" | "universal";

export type WorkbenchBuildRequest = {
  readonly repoRoot: string;
  readonly flavor: WorkbenchBuildFlavor;
  readonly sourceSha: string;
  readonly platform: WorkbenchBuildPlatform;
  readonly arch: WorkbenchBuildArch;
  readonly outputDir: string;
  readonly upstreamTag?: string;
  readonly upstreamSha?: string;
};

export type WorkbenchBuildToolchain = { readonly node: string; readonly bun: string };

export type WorkbenchBuildManifest = {
  readonly formatVersion: 1;
  readonly status: "diagnostic-build-only";
  readonly readiness: {
    readonly automaticChecks: "not-run";
    readonly runtimeEvidence: "not-run";
    readonly publication: "not-performed";
  };
  readonly source: {
    readonly commit: string;
    readonly flavor: WorkbenchBuildFlavor;
    readonly version: string;
  };
  readonly upstream: {
    readonly repository: string;
    readonly tag: string;
    readonly commit: string;
    readonly selection: "candidate-metadata" | "explicit-lock-match";
  };
  readonly build: {
    readonly platform: WorkbenchBuildPlatform;
    readonly arch: WorkbenchBuildArch;
    readonly target: string;
    readonly node: string;
    readonly bun: string;
  };
  readonly lockfileHashes: {
    readonly bunLock: string;
    readonly upstreamLock: string;
    readonly miseToml: string;
    readonly buildConfig: string;
  };
  readonly schemas: {
    readonly officialMigrationHighWater: number;
    readonly workbenchMigrationHighWaterByModule: Readonly<Record<string, number>>;
    readonly workbenchSchemaFormatVersion: number;
  };
  readonly externalNonSourceInputs: readonly {
    readonly name: string;
    readonly fileName: string;
    readonly sha256: string;
  }[];
  readonly artifactProvenance: {
    readonly fileName: string;
    readonly signing: ReleaseArtifactProvenanceManifest["signing"];
    readonly artifacts: readonly {
      readonly fileName: string;
      readonly size: number;
      readonly sha256: string;
    }[];
  };
};

type BuildConfig = {
  readonly formatVersion: 1;
  readonly versions: Record<WorkbenchBuildFlavor, string>;
};

export type WorkbenchBuildDependencies = {
  readonly repository?: string;
  readonly readToolchain?: (repoRoot: string) => WorkbenchBuildToolchain | null;
  readonly runBuilder?: (
    repoRoot: string,
    args: readonly string[],
    env: NodeJS.ProcessEnv,
  ) => {
    readonly status: number | null;
    readonly error?: Error;
    readonly stdout?: string;
    readonly stderr?: string;
  };
};

export type WorkbenchBuildResult = {
  readonly manifest: WorkbenchBuildManifest;
  readonly manifestPath: string;
  readonly provenancePath: string;
};

function sha256(bytes: string | Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function requireSha(value: string, label: string): string {
  if (!SHA_PATTERN.test(value)) throw new Error(`${label}-must-be-a-full-40-character-sha`);
  return value.toLowerCase();
}

function gitOutput(repoRoot: string, args: readonly string[]): string | null {
  const result = runGit(repoRoot, args);
  return result.ok ? result.stdout.trim() : null;
}

function readTrackedSourceFile(repoRoot: string, path: string): Buffer {
  const absolutePath = resolve(repoRoot, path);
  const stat = lstatSync(absolutePath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`source-input-must-be-a-regular-file:${path}`);
  }
  const tracked = runGit(repoRoot, ["ls-files", "--error-unmatch", "--", path]);
  if (!tracked.ok) throw new Error(`source-input-is-not-committed:${path}`);
  return readFileSync(absolutePath);
}

function isAncestor(repoRoot: string, ancestor: string, descendant: string): boolean | null {
  const result = runGit(repoRoot, ["merge-base", "--is-ancestor", ancestor, descendant]);
  if (result.ok) return true;
  return result.exitCode === 1 ? false : null;
}

function parseBuildConfig(value: unknown): BuildConfig {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("workbench-build-config-invalid");
  }
  const record = value as Record<string, unknown>;
  const versions = record.versions;
  if (
    record.formatVersion !== 1 ||
    typeof versions !== "object" ||
    versions === null ||
    Array.isArray(versions) ||
    typeof (versions as Record<string, unknown>).workbench !== "string" ||
    typeof (versions as Record<string, unknown>)["workbench-preview"] !== "string" ||
    !VERSION_PATTERN.test((versions as Record<string, string>).workbench!) ||
    !VERSION_PATTERN.test((versions as Record<string, string>)["workbench-preview"]!) ||
    Object.keys(record).toSorted().join(",") !== "formatVersion,versions"
  ) {
    throw new Error("workbench-build-config-invalid");
  }
  const versionKeys = Object.keys(versions).toSorted().join(",");
  if (versionKeys !== "workbench,workbench-preview") {
    throw new Error("workbench-build-config-has-unknown-flavors");
  }
  return record as BuildConfig;
}

function parseTypeScriptCatalog(source: string, fileName: string): ts.SourceFile {
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const parseDiagnostics = (
    sourceFile as ts.SourceFile & { readonly parseDiagnostics: ReadonlyArray<ts.Diagnostic> }
  ).parseDiagnostics;
  if (parseDiagnostics.length > 0) {
    throw new Error("workbench-schema-catalog-source-is-invalid");
  }
  return sourceFile;
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return (
    ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((item) => item.kind === kind)
  );
}

function exportedConstDeclarations(sourceFile: ts.SourceFile): Map<string, ts.VariableDeclaration> {
  const declarations = new Map<string, ts.VariableDeclaration>();
  for (const statement of sourceFile.statements) {
    if (
      !ts.isVariableStatement(statement) ||
      !hasModifier(statement, ts.SyntaxKind.ExportKeyword) ||
      (statement.declarationList.flags & ts.NodeFlags.Const) === 0
    ) {
      continue;
    }
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name)) continue;
      if (declarations.has(declaration.name.text))
        throw new Error("workbench-schema-catalog-is-invalid");
      declarations.set(declaration.name.text, declaration);
    }
  }
  return declarations;
}

function unwrapStaticAssertion(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function exportedObjectArray(
  declarations: ReadonlyMap<string, ts.VariableDeclaration>,
  name: string,
): Array<ReadonlyMap<string, ts.Expression>> {
  const initializer = declarations.get(name)?.initializer;
  if (!initializer) throw new Error("workbench-schema-catalog-could-not-be-read");
  const value = unwrapStaticAssertion(initializer);
  if (!ts.isArrayLiteralExpression(value))
    throw new Error("workbench-schema-catalog-could-not-be-read");

  return value.elements.map((element) => {
    if (!ts.isObjectLiteralExpression(element))
      throw new Error("workbench-schema-catalog-is-invalid");
    const fields = new Map<string, ts.Expression>();
    for (const property of element.properties) {
      if (!ts.isPropertyAssignment(property))
        throw new Error("workbench-schema-catalog-is-invalid");
      const propertyName =
        ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)
          ? property.name.text
          : undefined;
      if (!propertyName || fields.has(propertyName))
        throw new Error("workbench-schema-catalog-is-invalid");
      fields.set(propertyName, property.initializer);
    }
    return fields;
  });
}

function requireFields(
  fields: ReadonlyMap<string, ts.Expression>,
  expected: ReadonlyArray<string>,
): void {
  if (fields.size !== expected.length || expected.some((name) => !fields.has(name))) {
    throw new Error("workbench-schema-catalog-is-invalid");
  }
}

function stringLiteral(expression: ts.Expression | undefined): string | undefined {
  if (!expression) return undefined;
  const value = unwrapStaticAssertion(expression);
  return ts.isStringLiteral(value) ? value.text : undefined;
}

function numberLiteral(expression: ts.Expression | undefined): number | undefined {
  if (!expression) return undefined;
  const literal = unwrapStaticAssertion(expression);
  if (!ts.isNumericLiteral(literal)) return undefined;
  const value = Number(literal.text);
  return Number.isSafeInteger(value) ? value : undefined;
}

export function parseSchemaVersions(
  officialMigrationSource: string,
  workbenchMigrationSource: string,
): WorkbenchBuildManifest["schemas"] {
  // Parse the runtime catalogs instead of importing the server module into this
  // scripts composite project. The server module imports the full migration
  // graph, which is intentionally owned by the server TypeScript project.
  const officialEntries = parseMigrationLineage(officialMigrationSource);
  if (findLineageStructureViolations(officialEntries).length > 0) {
    throw new Error("official-migration-catalog-is-not-ordered-and-unique");
  }
  const workbenchSource = parseTypeScriptCatalog(
    workbenchMigrationSource,
    "WorkbenchMigrations.ts",
  );
  const declarations = exportedConstDeclarations(workbenchSource);
  const stringConstants = new Map<string, string>();
  for (const [name, declaration] of declarations) {
    const initializer = declaration.initializer;
    if (initializer) {
      const value = stringLiteral(unwrapStaticAssertion(initializer));
      if (value !== undefined) stringConstants.set(name, value);
    }
  }
  const legacyFields = exportedObjectArray(declarations, "LEGACY_EXPERT_OFFICIAL_MIGRATIONS");
  const workbenchFields = exportedObjectArray(declarations, "workbenchMigrationEntries");
  const formatVersionInitializer = declarations.get("WORKBENCH_SCHEMA_FORMAT_VERSION")?.initializer;
  const formatVersion = numberLiteral(formatVersionInitializer);
  if (formatVersion === undefined) throw new Error("workbench-schema-catalog-could-not-be-read");

  const legacyIdentities = legacyFields.map((fields) => {
    requireFields(fields, ["officialId", "officialName", "workbenchId"]);
    const id = numberLiteral(fields.get("officialId"));
    const name = stringLiteral(fields.get("officialName"));
    const workbenchId = numberLiteral(fields.get("workbenchId"));
    if (id === undefined || name === undefined || workbenchId === undefined)
      throw new Error("workbench-schema-catalog-is-invalid");
    return { id, name };
  });
  const workbenchEntries = workbenchFields.map((fields) => {
    requireFields(fields, ["moduleId", "migrationId", "name", "checksum", "statement"]);
    const moduleExpression = fields.get("moduleId");
    const moduleId =
      stringLiteral(moduleExpression) ??
      (moduleExpression && ts.isIdentifier(moduleExpression)
        ? stringConstants.get(moduleExpression.text)
        : undefined);
    const id = numberLiteral(fields.get("migrationId"));
    const name = stringLiteral(fields.get("name"));
    const checksum = stringLiteral(fields.get("checksum"));
    if (
      moduleId === undefined ||
      id === undefined ||
      name === undefined ||
      checksum === undefined ||
      !/^sha256:[0-9a-f]{64}$/u.test(checksum)
    ) {
      throw new Error("workbench-schema-catalog-is-invalid");
    }
    return { moduleId, id };
  });
  if (legacyIdentities.length === 0 || workbenchEntries.length === 0) {
    throw new Error("workbench-schema-catalog-is-empty");
  }
  if (
    formatVersion < 1 ||
    legacyIdentities.some(
      ({ id, name }, index) =>
        !Number.isSafeInteger(id) ||
        id <= 0 ||
        legacyIdentities.findIndex((entry) => entry.id === id && entry.name === name) !== index,
    ) ||
    workbenchEntries.some(
      ({ moduleId, id }, index) =>
        !moduleId ||
        !Number.isSafeInteger(id) ||
        id <= 0 ||
        workbenchEntries.findIndex((entry) => entry.moduleId === moduleId && entry.id === id) !==
          index,
    )
  ) {
    throw new Error("workbench-schema-catalog-is-invalid");
  }
  const legacyKeys = new Set(legacyIdentities.map(({ id, name }) => `${id}\0${name}`));
  const workbenchIdsByModule = new Map<string, number[]>();
  for (const { moduleId, id } of workbenchEntries) {
    const ids = workbenchIdsByModule.get(moduleId) ?? [];
    ids.push(id);
    workbenchIdsByModule.set(moduleId, ids);
  }
  const workbenchMigrationHighWaterByModule: Record<string, number> = {};
  for (const [moduleId, ids] of workbenchIdsByModule) {
    const ordered = [...ids].toSorted((left, right) => left - right);
    if (ordered.some((id, index) => id !== index + 1)) {
      throw new Error(`workbench-migration-ids-are-not-a-contiguous-prefix:${moduleId}`);
    }
    workbenchMigrationHighWaterByModule[moduleId] = Math.max(...ordered);
  }
  const officialCurrent = officialEntries.filter(
    ({ id, name }) => !legacyKeys.has(`${id}\0${name}`),
  );
  const officialMigrationHighWater = Math.max(...officialCurrent.map(({ id }) => id), 0);
  if (officialMigrationHighWater === 0) throw new Error("official-migration-catalog-is-empty");
  return {
    officialMigrationHighWater,
    workbenchMigrationHighWaterByModule: Object.fromEntries(
      Object.entries(workbenchMigrationHighWaterByModule).toSorted(([left], [right]) =>
        left.localeCompare(right),
      ),
    ),
    workbenchSchemaFormatVersion: formatVersion,
  };
}

function readPinnedToolchain(repoRoot: string): WorkbenchBuildToolchain {
  const miseToml = readTrackedSourceFile(repoRoot, ".mise.toml").toString("utf8");
  const node = /^\s*node\s*=\s*["']([^"']+)["']\s*$/m.exec(miseToml)?.[1];
  const bun = /^\s*bun\s*=\s*["']([^"']+)["']\s*$/m.exec(miseToml)?.[1];
  if (!node || !bun) throw new Error("mise-toolchain-pin-missing-node-or-bun");
  return { node, bun };
}

function defaultReadToolchain(repoRoot: string): WorkbenchBuildToolchain | null {
  const readVersion = (command: string): string | null => {
    const result = spawnProcessSync(command, ["--version"], {
      cwd: repoRoot,
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      timeout: MAX_PROBE_MS,
    });
    if (result.status !== 0 || result.error !== undefined || typeof result.stdout !== "string") {
      return null;
    }
    return result.stdout.trim().replace(/^v/u, "");
  };
  const node = readVersion("node");
  const bun = readVersion("bun");
  return node && bun ? { node, bun } : null;
}

function readLock(repoRoot: string): WorkbenchSyncLock {
  readTrackedSourceFile(repoRoot, "workbench/upstream.lock.json");
  return readSyncLock(resolve(repoRoot, "workbench/upstream.lock.json"));
}

function hasOriginalTargetMerge(repoRoot: string, baseSha: string, targetSha: string): boolean {
  const log = runGit(repoRoot, ["log", "--merges", "--format=%H%x00%P", "HEAD"]);
  if (!log.ok) return false;
  for (const line of log.stdout.split("\n")) {
    const [mergeSha, parents] = line.split("\0");
    const [firstParent, secondParent] = parents?.trim().split(/\s+/) ?? [];
    if (!mergeSha || !firstParent || secondParent?.toLowerCase() !== targetSha) continue;
    if (isAncestor(repoRoot, firstParent.toLowerCase(), baseSha) === true) return true;
  }
  return false;
}

type UpstreamTarget = {
  readonly tag: string;
  readonly commit: string;
  readonly selection: WorkbenchBuildManifest["upstream"]["selection"];
};

function readCandidateMetadata(repoRoot: string): unknown | null {
  const path = resolve(repoRoot, "workbench/sync-candidate.json");
  const tracked = runGit(repoRoot, [
    "ls-files",
    "--error-unmatch",
    "--",
    "workbench/sync-candidate.json",
  ]);
  if (!tracked.ok) {
    if (gitOutput(repoRoot, ["cat-file", "-e", "HEAD:workbench/sync-candidate.json"]) === null) {
      return null;
    }
    throw new Error("workbench-sync-candidate-metadata-not-committed");
  }
  try {
    readTrackedSourceFile(repoRoot, "workbench/sync-candidate.json");
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw new Error("workbench-sync-candidate-metadata-unreadable", { cause: error });
  }
}

function resolveUpstreamTarget(
  repoRoot: string,
  lock: WorkbenchSyncLock,
  request: WorkbenchBuildRequest,
  dependencies: WorkbenchBuildDependencies,
): UpstreamTarget {
  const hasExplicitTag = request.upstreamTag !== undefined;
  const hasExplicitSha = request.upstreamSha !== undefined;
  if (hasExplicitTag !== hasExplicitSha) {
    throw new Error("upstream-tag-and-sha-must-be-provided-together");
  }
  const metadata = readCandidateMetadata(repoRoot);
  let target: UpstreamTarget;
  if (metadata !== null) {
    if (
      typeof metadata !== "object" ||
      metadata === null ||
      Array.isArray(metadata) ||
      Object.keys(metadata).toSorted().join(",") !== "baseSha,branch,formatVersion,target"
    ) {
      throw new Error("workbench-sync-candidate-metadata-invalid");
    }
    const record = metadata as Record<string, unknown>;
    const metadataTarget = record.target;
    if (
      record.formatVersion !== 1 ||
      typeof record.baseSha !== "string" ||
      !SHA_PATTERN.test(record.baseSha) ||
      typeof record.branch !== "string" ||
      typeof metadataTarget !== "object" ||
      metadataTarget === null ||
      Array.isArray(metadataTarget) ||
      Object.keys(metadataTarget).toSorted().join(",") !== "commit,tag"
    ) {
      throw new Error("workbench-sync-candidate-metadata-invalid");
    }
    const details = metadataTarget as Record<string, unknown>;
    if (typeof details.tag !== "string" || typeof details.commit !== "string") {
      throw new Error("workbench-sync-candidate-metadata-invalid");
    }
    const targetSha = requireSha(details.commit, "upstream-sha");
    const metadataBase = record.baseSha.toLowerCase();
    const expectedBranch = expectedCandidateBranch(details.tag, targetSha);
    if (record.branch !== expectedBranch) {
      throw new Error("workbench-sync-candidate-branch-mismatch");
    }
    const officialTag = validateFixedOfficialTag(
      repoRoot,
      dependencies.repository ?? lock.repository,
      details.tag,
      targetSha,
    );
    if (!officialTag.ok) {
      throw new Error(`candidate-metadata-official-tag-${officialTag.reason}`);
    }
    if (
      hasExplicitTag &&
      (request.upstreamTag !== details.tag || request.upstreamSha!.toLowerCase() !== targetSha)
    ) {
      throw new Error("explicit-upstream-target-does-not-match-candidate-metadata");
    }
    if (isAncestor(repoRoot, metadataBase, request.sourceSha.toLowerCase()) !== true) {
      throw new Error("candidate-base-is-not-an-ancestor-of-source");
    }
    target = { tag: details.tag, commit: targetSha, selection: "candidate-metadata" };
    if (!hasOriginalTargetMerge(repoRoot, metadataBase, targetSha)) {
      throw new Error("candidate-metadata-lacks-fixed-target-merge-history");
    }
  } else {
    if (!hasExplicitTag || !hasExplicitSha) {
      throw new Error("provide-explicit-upstream-tag-and-sha-or-committed-candidate-metadata");
    }
    const tag = request.upstreamTag!;
    const commit = requireSha(request.upstreamSha!, "upstream-sha");
    const matchesIntegrated =
      tag === lock.integratedBase.tag && commit === lock.integratedBase.commit.toLowerCase();
    const matchesCandidate =
      tag === lock.candidate.tag && commit === lock.candidate.commit.toLowerCase();
    if (!matchesIntegrated && !matchesCandidate) {
      throw new Error("explicit-upstream-target-does-not-match-versioned-lock");
    }
    target = { tag, commit, selection: "explicit-lock-match" };
  }

  const integratedBase = lock.integratedBase.commit.toLowerCase();
  const targetIncludesIntegratedBase = isAncestor(repoRoot, integratedBase, target.commit);
  if (targetIncludesIntegratedBase === false) {
    throw new Error("upstream-target-is-older-or-diverges-from-integrated-base");
  }
  if (targetIncludesIntegratedBase === null) {
    throw new Error("upstream-target-lineage-could-not-be-proven");
  }
  const targetIsInSource = isAncestor(repoRoot, target.commit, request.sourceSha.toLowerCase());
  if (targetIsInSource === false) throw new Error("upstream-target-is-not-an-ancestor-of-source");
  if (targetIsInSource === null) throw new Error("source-upstream-ancestry-could-not-be-proven");
  return target;
}

function targetForPlatform(platform: WorkbenchBuildPlatform): string {
  return platform === "mac" ? "dmg" : platform === "linux" ? "AppImage" : "nsis";
}

function assertPlatformArch(platform: WorkbenchBuildPlatform, arch: WorkbenchBuildArch): void {
  const supported: Record<WorkbenchBuildPlatform, readonly WorkbenchBuildArch[]> = {
    mac: ["arm64", "x64", "universal"],
    linux: ["x64", "arm64"],
    win: ["x64", "arm64"],
  };
  if (!supported[platform].includes(arch))
    throw new Error("unsupported-platform-architecture-pair");
}

function isWithin(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

function defaultRunBuilder(repoRoot: string, args: readonly string[], env: NodeJS.ProcessEnv) {
  return spawnProcessSync("node", args, {
    cwd: repoRoot,
    encoding: "utf8",
    env,
    maxBuffer: 16 * 1024 * 1024,
    timeout: MAX_BUILD_MS,
  });
}

function optionalExternalIconCatalog(): WorkbenchBuildManifest["externalNonSourceInputs"] {
  const path = process.env.SYNARA_MAC_ICON_CATALOG?.trim();
  if (!path) return [];
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error("external-mac-icon-catalog-must-be-a-regular-file");
  }
  return [
    {
      name: "SYNARA_MAC_ICON_CATALOG",
      fileName: basename(path),
      sha256: sha256(readFileSync(path)),
    },
  ];
}

export async function buildWorkbenchArtifact(
  request: WorkbenchBuildRequest,
  dependencies: WorkbenchBuildDependencies = {},
): Promise<WorkbenchBuildResult> {
  const repoRoot = realpathSync(request.repoRoot);
  const sourceSha = requireSha(request.sourceSha, "source-sha");
  const requestedOutput = isAbsolute(request.outputDir)
    ? resolve(request.outputDir)
    : resolve(repoRoot, request.outputDir);
  let outputParent: string;
  try {
    outputParent = realpathSync(dirname(requestedOutput));
  } catch {
    throw new Error("output-directory-parent-must-exist");
  }
  const outputDir = resolve(outputParent, basename(requestedOutput));
  if (isWithin(repoRoot, outputDir))
    throw new Error("output-directory-must-be-outside-source-tree");
  if (existsSync(outputDir)) throw new Error("output-directory-already-exists");
  if (request.upstreamSha !== undefined) requireSha(request.upstreamSha, "upstream-sha");
  assertPlatformArch(request.platform, request.arch);

  const head = gitOutput(repoRoot, ["rev-parse", "--verify", "HEAD"])?.toLowerCase();
  if (head !== sourceSha) throw new Error("source-sha-does-not-match-current-head");
  const dirty = gitOutput(repoRoot, ["status", "--porcelain=v1", "--untracked-files=all"]);
  if (dirty === null) throw new Error("source-worktree-status-could-not-be-read");
  if (dirty !== "") throw new Error("source-worktree-is-not-clean");

  const configBytes = readTrackedSourceFile(repoRoot, "workbench/build-config.json");
  const config = parseBuildConfig(JSON.parse(configBytes.toString("utf8")) as unknown);
  const upstreamLockBytes = readTrackedSourceFile(repoRoot, "workbench/upstream.lock.json");
  const lock = readLock(repoRoot);
  const miseBytes = readTrackedSourceFile(repoRoot, ".mise.toml");
  const bunLockBytes = readTrackedSourceFile(repoRoot, "bun.lock");
  const hashes = {
    bunLock: sha256(bunLockBytes),
    upstreamLock: sha256(upstreamLockBytes),
    miseToml: sha256(miseBytes),
    buildConfig: sha256(configBytes),
  };
  const pinned = readPinnedToolchain(repoRoot);
  const toolchain = (dependencies.readToolchain ?? defaultReadToolchain)(repoRoot);
  if (!toolchain) throw new Error("actual-node-and-bun-versions-could-not-be-read");
  if (toolchain.node !== pinned.node || toolchain.bun !== pinned.bun) {
    throw new Error("actual-toolchain-does-not-match-mise-pins");
  }

  const upstream = resolveUpstreamTarget(repoRoot, lock, request, dependencies);
  const externalNonSourceInputs = optionalExternalIconCatalog();
  const version = config.versions[request.flavor];
  const platformTarget = targetForPlatform(request.platform);
  const migrationSource = readTrackedSourceFile(
    repoRoot,
    "apps/server/src/persistence/Migrations.ts",
  ).toString("utf8");
  const schemaVersions = parseSchemaVersions(
    migrationSource,
    readTrackedSourceFile(
      repoRoot,
      "apps/server/src/workbench/persistence/WorkbenchMigrations.ts",
    ).toString("utf8"),
  );
  const builderArgs = [
    resolve(repoRoot, "scripts/build-desktop-artifact.ts"),
    "--flavor",
    request.flavor,
    "--platform",
    request.platform,
    "--target",
    platformTarget,
    "--arch",
    request.arch,
    "--build-version",
    version,
    "--source-commit",
    sourceSha,
    "--lockfile-sha256",
    hashes.bunLock,
    "--output-dir",
    outputDir,
  ];
  mkdirSync(outputDir);
  const result = (dependencies.runBuilder ?? defaultRunBuilder)(repoRoot, builderArgs, {
    ...process.env,
    SYNARA_DESKTOP_SIGNED: "false",
    SYNARA_DESKTOP_SKIP_BUILD: "false",
  });
  if (result.error || result.status !== 0) {
    throw new Error(
      `desktop-builder-failed:${result.error?.message ?? result.stderr?.trim() ?? result.status ?? "unknown"}`,
    );
  }

  const currentHead = gitOutput(repoRoot, ["rev-parse", "--verify", "HEAD"])?.toLowerCase();
  const currentStatus = gitOutput(repoRoot, ["status", "--porcelain=v1", "--untracked-files=all"]);
  const currentHashes = {
    bunLock: sha256(readTrackedSourceFile(repoRoot, "bun.lock")),
    upstreamLock: sha256(readTrackedSourceFile(repoRoot, "workbench/upstream.lock.json")),
    miseToml: sha256(readTrackedSourceFile(repoRoot, ".mise.toml")),
    buildConfig: sha256(readTrackedSourceFile(repoRoot, "workbench/build-config.json")),
  };
  const currentToolchain = (dependencies.readToolchain ?? defaultReadToolchain)(repoRoot);
  if (
    currentHead !== sourceSha ||
    currentStatus !== "" ||
    JSON.stringify(currentHashes) !== JSON.stringify(hashes) ||
    currentToolchain?.node !== pinned.node ||
    currentToolchain?.bun !== pinned.bun
  ) {
    throw new Error("source-inputs-or-toolchain-changed-during-build");
  }
  if (JSON.stringify(optionalExternalIconCatalog()) !== JSON.stringify(externalNonSourceInputs)) {
    throw new Error("external-icon-input-changed-during-build");
  }

  const provenance = await writeReleaseArtifactProvenance({
    assetsDirectory: outputDir,
    platform: request.platform,
    arch: request.arch,
    target: platformTarget,
    version,
    sourceCommit: sourceSha,
    sourceTag: null,
    lockfileSha256: hashes.bunLock,
    publication: false,
    signed: false,
  });
  const manifest: WorkbenchBuildManifest = {
    formatVersion: 1,
    status: "diagnostic-build-only",
    readiness: {
      automaticChecks: "not-run",
      runtimeEvidence: "not-run",
      publication: "not-performed",
    },
    source: { commit: sourceSha, flavor: request.flavor, version },
    upstream: {
      repository: lock.repository,
      tag: upstream.tag,
      commit: upstream.commit,
      selection: upstream.selection,
    },
    build: {
      platform: request.platform,
      arch: request.arch,
      target: platformTarget,
      node: toolchain.node,
      bun: toolchain.bun,
    },
    lockfileHashes: hashes,
    schemas: schemaVersions,
    externalNonSourceInputs,
    artifactProvenance: {
      fileName: basename(provenance.path),
      signing: provenance.manifest.signing,
      artifacts: provenance.manifest.artifacts,
    },
  };
  const manifestPath = resolve(outputDir, "workbench-build-manifest.json");
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
  return { manifest, manifestPath, provenancePath: provenance.path };
}

export function parseWorkbenchBuildArgs(args: readonly string[]): WorkbenchBuildRequest | null {
  const allowed = new Set([
    "--flavor",
    "--source-sha",
    "--platform",
    "--arch",
    "--output-dir",
    "--upstream-tag",
    "--upstream-sha",
  ]);
  if (args.length % 2 !== 0) return null;
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!key || !allowed.has(key) || !value || value.startsWith("--") || values.has(key))
      return null;
    values.set(key, value);
  }
  const flavor = values.get("--flavor");
  const sourceSha = values.get("--source-sha");
  const platform = values.get("--platform");
  const arch = values.get("--arch");
  const outputDir = values.get("--output-dir");
  const upstreamTag = values.get("--upstream-tag");
  const upstreamSha = values.get("--upstream-sha");
  if (
    !flavor ||
    !["workbench", "workbench-preview"].includes(flavor) ||
    !sourceSha ||
    !platform ||
    !["mac", "linux", "win"].includes(platform) ||
    !arch ||
    !["arm64", "x64", "universal"].includes(arch) ||
    !outputDir ||
    (upstreamTag === undefined) !== (upstreamSha === undefined)
  ) {
    return null;
  }
  return {
    repoRoot: resolve(dirname(fileURLToPath(import.meta.url)), "../.."),
    flavor: flavor as WorkbenchBuildFlavor,
    sourceSha,
    platform: platform as WorkbenchBuildPlatform,
    arch: arch as WorkbenchBuildArch,
    outputDir,
    ...(upstreamTag !== undefined ? { upstreamTag } : {}),
    ...(upstreamSha !== undefined ? { upstreamSha } : {}),
  };
}
