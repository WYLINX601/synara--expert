/**
 * OMP's native, per-session projection for immutable Expert and Context inputs.
 *
 * @module OmpExpertSession
 */
import { createHash } from "node:crypto";
import {
  access,
  chmod,
  lstat,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rmdir,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import * as nodeOs from "node:os";
import * as nodePath from "node:path";

import type { ContextSession } from "@synara/contracts";
import type { ProviderExpertSession, ProviderSkillReference } from "@synara/contracts";
import { composeProviderBaseInstructions } from "@synara/shared/contextInstructions";
import { Effect, Result } from "effect";
import { stringify as stringifyYaml } from "yaml";
import {
  createFixedSkillProjection,
  verifyProjectedSkillAssembly,
  type FixedSkillProjection,
} from "../fixedSkillProjection";
import { invalidateNativeSkillAssemblyVerification } from "../expertSkillCatalog";

export const OMP_EXPERT_PROJECTION_VERSION = "omp-acp-native-v1" as const;
export const OMP_EXPERT_SUPPORTED_CLI_VERSION = "18.12.1" as const;
const OMP_EXPERT_TEMP_PREFIX = "synara-omp-expert-";

interface FixedProjectionCleanupFileSystem {
  readonly lstat: typeof lstat;
  readonly readdir: typeof readdir;
  readonly chmod: typeof chmod;
  readonly unlink: typeof unlink;
  readonly rmdir: typeof rmdir;
}

const fixedProjectionCleanupFileSystem: FixedProjectionCleanupFileSystem = {
  lstat,
  readdir,
  chmod,
  unlink,
  rmdir,
};

/** Internal cleanup seam; it is not re-exported from the server package. */
export async function removeFixedProjectionStaging(
  directory: string,
  fileSystem: FixedProjectionCleanupFileSystem = fixedProjectionCleanupFileSystem,
): Promise<void> {
  const remove = async (target: string): Promise<void> => {
    let info: Awaited<ReturnType<typeof lstat>>;
    try {
      info = await fileSystem.lstat(target);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return;
      throw cause;
    }
    if (!info.isDirectory() || info.isSymbolicLink()) {
      try {
        await fileSystem.unlink(target);
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
      }
      return;
    }

    await fileSystem.chmod(target, 0o700);
    for (const name of await fileSystem.readdir(target)) await remove(nodePath.join(target, name));
    try {
      await fileSystem.rmdir(target);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
    }
  };
  await remove(directory);
}

export interface OmpExpertCliResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

export type OmpExpertCliRunner = (
  args: ReadonlyArray<string>,
  cwd: string,
  env: NodeJS.ProcessEnv,
) => Effect.Effect<OmpExpertCliResult, unknown>;

export interface OmpExpertSessionPreparationInput {
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly runCli: OmpExpertCliRunner;
  readonly expertSession?: ProviderExpertSession;
  readonly lifecycleGeneration?: string;
  readonly contextSession?: ContextSession;
  /** Used by preview, which receives skill references without the full snapshot. */
  readonly skills?: ReadonlyArray<ProviderSkillReference>;
  /** Used by preview when a caller can supply the snapshot root directly. */
  readonly skillsRoot?: string;
  /** Test seam for keeping all temporary files under a disposable directory. */
  readonly tempDirectory?: string;
}

export interface OmpExpertSessionPreparation {
  readonly issues: ReadonlyArray<string>;
  readonly cliVersion?: string;
  readonly instructionsHash: string;
  readonly loadedSkills: ReadonlyArray<ProviderSkillReference>;
  readonly configOverlayPath?: string;
  readonly appendSystemPromptPath?: string;
  /** Private owned directory for narrowly scoped native launch helpers. */
  readonly ownedTempDirectory?: string;
  readonly cleanup: () => Effect.Effect<void>;
  readonly verify?: () => Effect.Effect<void, unknown>;
  readonly allowedSkillCommands?: ReadonlyArray<string>;
}

interface EffectiveOmpConfig {
  readonly skillsEnabled: boolean;
  readonly customDirectories: ReadonlyArray<string>;
  readonly ignoredSkills: ReadonlyArray<string>;
  readonly includeSkills: ReadonlyArray<string>;
  readonly disabledExtensions: ReadonlyArray<string>;
  readonly enabledProviders: ReadonlyArray<string>;
  readonly disabledProviders: ReadonlyArray<string>;
}

interface NativeSkill {
  readonly name: string;
  readonly description: string;
  readonly filePath: string;
  readonly hide?: boolean;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

const ordinal = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);

function asStringArray(value: unknown): ReadonlyArray<string> | undefined {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
    return undefined;
  }
  return value;
}

function parseConfigList(stdout: string): EffectiveOmpConfig | undefined {
  try {
    const parsed: unknown = JSON.parse(stdout);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
    const values = parsed as Record<string, { readonly value?: unknown }>;
    const skillsEnabled = values["skills.enabled"]?.value;
    const customDirectories = asStringArray(values["skills.customDirectories"]?.value);
    const ignoredSkills = asStringArray(values["skills.ignoredSkills"]?.value);
    const includeSkills = asStringArray(values["skills.includeSkills"]?.value);
    const disabledExtensions = asStringArray(values.disabledExtensions?.value);
    const enabledProviders = asStringArray(values.enabledProviders?.value);
    const disabledProviders = asStringArray(values.disabledProviders?.value);
    if (
      typeof skillsEnabled !== "boolean" ||
      customDirectories === undefined ||
      ignoredSkills === undefined ||
      includeSkills === undefined ||
      disabledExtensions === undefined ||
      enabledProviders === undefined ||
      disabledProviders === undefined
    ) {
      return undefined;
    }
    return {
      skillsEnabled,
      customDirectories,
      ignoredSkills,
      includeSkills,
      disabledExtensions,
      enabledProviders,
      disabledProviders,
    };
  } catch {
    return undefined;
  }
}

function parseConfigGet(stdout: string): ReadonlyArray<string> | undefined {
  try {
    const parsed: unknown = JSON.parse(stdout);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
    return asStringArray((parsed as { readonly value?: unknown }).value);
  } catch {
    return undefined;
  }
}

function parseNativeSkillList(
  stdout: string,
):
  | { readonly skills: ReadonlyArray<NativeSkill>; readonly warnings: ReadonlyArray<unknown> }
  | undefined {
  try {
    const parsed: unknown = JSON.parse(stdout);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
    const record = parsed as { readonly skills?: unknown; readonly warnings?: unknown };
    if (!Array.isArray(record.skills) || !Array.isArray(record.warnings ?? [])) return undefined;
    if (!record.skills.every(isNativeSkillRecord)) return undefined;
    const skills = record.skills.map((value) => {
      const skill = value as Record<string, unknown>;
      return {
        name: skill.name as string,
        description: (skill.description as string | undefined) ?? "",
        filePath: skill.filePath as string,
        ...(skill.hide !== undefined ? { hide: skill.hide as boolean } : {}),
      };
    });
    return { skills, warnings: (record.warnings ?? []) as ReadonlyArray<unknown> };
  } catch {
    return undefined;
  }
}

function isNativeSkillRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const skill = value as Record<string, unknown>;
  return (
    typeof skill.name === "string" &&
    (skill.description === undefined || typeof skill.description === "string") &&
    typeof skill.filePath === "string" &&
    (skill.hide === undefined || typeof skill.hide === "boolean")
  );
}

function parseCliVersion(stdout: string): string | undefined {
  return stdout.trim().match(/^omp\/(\d+\.\d+\.\d+)$/)?.[1];
}

function requireExitZero(result: OmpExpertCliResult, command: string): string | undefined {
  return result.exitCode === 0
    ? undefined
    : `OMP could not verify ${command} (exit ${result.exitCode}).`;
}

function resolveHome(env: NodeJS.ProcessEnv): string {
  return env.HOME?.trim() || env.USERPROFILE?.trim() || nodeOs.homedir();
}

function isUserSourceEnabled(
  source: string,
  config: EffectiveOmpConfig,
  env: NodeJS.ProcessEnv,
): boolean {
  // OMP 18.12.1's getConfigDirs always includes CONFIG_DIR_NAME (.omp); its
  // disabled-provider gate applies only to foreign user config roots.
  if (source === "omp") return true;
  if (config.disabledProviders.includes(source)) return false;
  const foreignSources = new Set(["claude", "codex", "gemini"]);
  if (!foreignSources.has(source)) return true;
  if (
    config.enabledProviders.includes(source) ||
    config.enabledProviders.includes("*") ||
    config.enabledProviders.includes("all")
  ) {
    return true;
  }
  return source === "claude" && Boolean(env.CLAUDE_CONFIG_DIR?.trim());
}

function resolveNativeAppendDirectories(
  cwd: string,
  env: NodeJS.ProcessEnv,
  config: EffectiveOmpConfig,
): ReadonlyArray<string> {
  const projectRoots = [".omp", ".claude", ".codex", ".gemini"].map((directory) =>
    nodePath.resolve(cwd, directory),
  );
  const home = resolveHome(env);
  const configDirName = env.PI_CONFIG_DIR?.trim() || ".omp";
  const rawProfile = env.OMP_PROFILE !== undefined ? env.OMP_PROFILE : env.PI_PROFILE;
  const normalizedProfile = rawProfile?.trim();
  const profile =
    normalizedProfile && normalizedProfile !== "default" ? normalizedProfile : undefined;
  const ompUserRoot =
    profile && profile !== "default"
      ? nodePath.join(home, configDirName, "profiles", profile, "agent")
      : nodePath.join(home, configDirName, "agent");
  const claudeUserRoot = env.CLAUDE_CONFIG_DIR?.trim()
    ? nodePath.resolve(cwd, env.CLAUDE_CONFIG_DIR.trim())
    : nodePath.join(home, ".claude");
  const userRoots = [
    { source: "omp", root: ompUserRoot },
    { source: "claude", root: claudeUserRoot },
    { source: "codex", root: nodePath.join(home, ".codex") },
    { source: "gemini", root: nodePath.join(home, ".gemini") },
  ]
    .filter(({ source }) => isUserSourceEnabled(source, config, env))
    .map(({ root }) => root);
  // OMP 18.12.1 explicitly checks project files before user-level files.
  return [...projectRoots, ...userRoots];
}

async function readNativeAppendSystemPrompt(
  cwd: string,
  env: NodeJS.ProcessEnv,
  config: EffectiveOmpConfig,
): Promise<{ readonly path: string; readonly text: string } | undefined> {
  for (const directory of resolveNativeAppendDirectories(cwd, env, config)) {
    const candidate = nodePath.join(directory, "APPEND_SYSTEM.md");
    try {
      await access(candidate, fsConstants.F_OK);
    } catch {
      continue;
    }
    const info = await realpath(candidate);
    const text = await readFile(info, "utf8");
    return { path: info, text };
  }
  return undefined;
}

async function verifyReadOnlyTempFile(filePath: string, expectedContent: string): Promise<string> {
  const info = await lstat(filePath);
  if (info.isSymbolicLink() || !info.isFile() || (info.mode & 0o222) !== 0) {
    throw new Error("Temporary OMP projection file is not a read-only regular file.");
  }
  const content = await readFile(filePath, "utf8");
  if (content !== expectedContent)
    throw new Error("Temporary OMP projection file content changed.");
  return filePath;
}

function pathIsInside(root: string, candidate: string): boolean {
  const relative = nodePath.relative(root, candidate);
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${nodePath.sep}`) &&
    !nodePath.isAbsolute(relative)
  );
}

interface ResolvedExpertSkills {
  readonly skills: ReadonlyArray<ProviderSkillReference>;
  readonly paths: ReadonlyMap<ProviderSkillReference, string>;
  readonly customDirectories: ReadonlyArray<string>;
  readonly issue?: string;
}

async function resolveExpertSkills(
  skills: ReadonlyArray<ProviderSkillReference>,
  configuredRoot: string | undefined,
  strictSnapshotRoot: boolean,
): Promise<ResolvedExpertSkills> {
  if (skills.length === 0) return { skills: [], paths: new Map(), customDirectories: [] };
  const foldedNames = new Set<string>();
  const normalizedSkills: ProviderSkillReference[] = [];
  const paths = new Map<ProviderSkillReference, string>();
  const customDirectories: string[] = [];

  let rootRealPath: string | undefined;
  if (configuredRoot !== undefined) {
    const rootInfo = await lstat(configuredRoot);
    if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) {
      return {
        skills: [],
        paths: new Map(),
        customDirectories: [],
        issue: "The Expert snapshot skills root is unavailable or unsafe.",
      };
    }
    rootRealPath = await realpath(configuredRoot);
  } else if (strictSnapshotRoot) {
    return {
      skills: [],
      paths: new Map(),
      customDirectories: [],
      issue: "A fixed Expert snapshot skills root is required for provider startup.",
    };
  }

  for (const reference of skills) {
    const foldedName = reference.name.toLocaleLowerCase("en-US");
    if (foldedNames.has(foldedName)) {
      return {
        skills: [],
        paths: new Map(),
        customDirectories: [],
        issue: `Expert skills contain a same-name conflict for '${reference.name}'.`,
      };
    }
    foldedNames.add(foldedName);

    const referencedPath = nodePath.resolve(reference.path);
    const referenceInfo = await lstat(referencedPath);
    if (referenceInfo.isSymbolicLink()) {
      return {
        skills: [],
        paths: new Map(),
        customDirectories: [],
        issue: `Expert skill '${reference.name}' cannot be a symbolic link.`,
      };
    }
    const skillPath = referenceInfo.isDirectory()
      ? nodePath.join(referencedPath, "SKILL.md")
      : referencedPath;
    const skillInfo = await lstat(skillPath);
    if (skillInfo.isSymbolicLink() || !skillInfo.isFile()) {
      return {
        skills: [],
        paths: new Map(),
        customDirectories: [],
        issue: `Expert skill '${reference.name}' must resolve to a regular SKILL.md file.`,
      };
    }
    if (nodePath.basename(skillPath).toLowerCase() !== "skill.md") {
      return {
        skills: [],
        paths: new Map(),
        customDirectories: [],
        issue: `Expert skill '${reference.name}' must use the native SKILL.md filename.`,
      };
    }

    const skillRealPath = await realpath(skillPath);
    if (rootRealPath !== undefined && !pathIsInside(rootRealPath, skillRealPath)) {
      return {
        skills: [],
        paths: new Map(),
        customDirectories: [],
        issue: `Required Expert skill '${reference.name}' is outside its snapshot skills root.`,
      };
    }
    const normalizedReference = { ...reference, path: skillRealPath };
    normalizedSkills.push(normalizedReference);
    paths.set(normalizedReference, skillRealPath);

    const skillDirectory = nodePath.dirname(skillRealPath);
    const customDirectory = rootRealPath ?? nodePath.dirname(skillDirectory);
    if (!customDirectories.includes(customDirectory)) customDirectories.push(customDirectory);
  }

  return { skills: normalizedSkills, paths, customDirectories };
}

function matchingFilterNames(skillName: string, config: EffectiveOmpConfig): ReadonlyArray<string> {
  const filters: string[] = [];
  if (config.ignoredSkills.length > 0) filters.push("skills.ignoredSkills");
  if (config.includeSkills.length > 0) filters.push("skills.includeSkills");
  if (config.disabledExtensions.some((entry) => entry === `skill:${skillName}`)) {
    filters.push("disabledExtensions");
  }
  return filters;
}

function hasSkillWarningForPath(warnings: ReadonlyArray<unknown>, skillPath: string): boolean {
  for (const warning of warnings) {
    if (typeof warning !== "object" || warning === null || Array.isArray(warning)) continue;
    const record = warning as Record<string, unknown>;
    if (
      typeof record.skillPath === "string" &&
      nodePath.resolve(record.skillPath) === nodePath.resolve(skillPath) &&
      typeof record.message === "string"
    ) {
      return true;
    }
  }
  return false;
}

function assertUniqueOmpSkillNames(projection: FixedSkillProjection): void {
  const counts = new Map<string, number>();
  for (const entry of projection.entries) counts.set(entry.name, (counts.get(entry.name) ?? 0) + 1);
  const duplicates = [...counts]
    .filter(([, count]) => count > 1)
    .map(([name]) => name)
    .toSorted();
  if (duplicates.length > 0)
    throw new Error(
      `OMP skills.includeSkills cannot disambiguate selected fixed Skills with duplicate names: ${duplicates.join(", ")}. Choose unique Skill names.`,
    );
}

function ompNativeSkillContainerRoots(projection: FixedSkillProjection): string[] {
  const packages = new Map(projection.packages.map((pkg) => [pkg.packageId, pkg]));
  const roots = new Set<string>();
  for (const entry of projection.entries) {
    const pkg = packages.get(entry.packageId);
    if (!pkg) throw new Error(`OMP fixed Skill package ${entry.packageId} is missing.`);
    const parts = entry.entryPath.split("/");
    if (parts.at(-1) !== "SKILL.md")
      throw new Error(
        `unsupported_entry_scope: OMP requires a package-relative SKILL.md entry, got "${entry.entryPath}".`,
      );
    const root = nodePath.resolve(pkg.sourceRoot);
    const packageRoot = nodePath.dirname(root);
    // OMP scans Skill directories one level below each custom directory. A
    // root-level SKILL.md is the package content directory itself, so its
    // parent package directory is the exact native container.
    const container =
      parts.length === 1 ? packageRoot : nodePath.resolve(root, ...parts.slice(0, -2));
    const relative = nodePath.relative(packageRoot, container);
    if (
      relative === ".." ||
      relative.startsWith(`..${nodePath.sep}`) ||
      nodePath.isAbsolute(relative)
    )
      throw new Error(
        `unsupported_entry_scope: OMP Skill entry "${entry.entryPath}" has no safe native container.`,
      );
    roots.add(container);
  }
  return [...roots].toSorted(ordinal);
}

async function rejectOmpNameCollisions(
  projection: FixedSkillProjection,
  skills: ReadonlyArray<NativeSkill>,
): Promise<void> {
  const selectedByName = new Map<string, ReadonlyArray<string>>();
  for (const entry of projection.entries) {
    const paths = selectedByName.get(entry.name) ?? [];
    selectedByName.set(entry.name, [...paths, await realpath(entry.path)]);
  }
  for (const skill of skills) {
    const selectedPaths = selectedByName.get(skill.name);
    if (!selectedPaths) continue;
    const actualPath = await realpath(skill.filePath).catch(() => undefined);
    if (actualPath !== undefined && selectedPaths.includes(actualPath)) continue;
    throw new Error(
      `OMP cannot disambiguate the native Skill name "${skill.name}" because a different entry with that name is active. Choose a unique Skill name or adjust skills.includeSkills.`,
    );
  }
}

export function prepareOmpExpertSession(
  input: OmpExpertSessionPreparationInput,
): Effect.Effect<OmpExpertSessionPreparation> {
  if (input.expertSession?.skillPolicy) return prepareFixedOmpExpertSession(input);
  let tempPath: string | undefined;
  let preserveTempPath = false;
  let verifiedCliVersion: string | undefined;
  const cleanup = () =>
    tempPath
      ? Effect.tryPromise({
          try: () => rm(tempPath!, { recursive: true, force: true }),
          catch: () => undefined,
        }).pipe(Effect.ignore)
      : Effect.void;

  const noResources = (issues: ReadonlyArray<string>, instructionsHash: string) => ({
    issues,
    ...(verifiedCliVersion ? { cliVersion: verifiedCliVersion } : {}),
    instructionsHash,
    loadedSkills: [] as ReadonlyArray<ProviderSkillReference>,
    cleanup,
  });

  const isIndexedExpert = input.expertSession?.skillLoading === "index";
  const requestedSkills = isIndexedExpert
    ? []
    : (input.expertSession?.skills ?? input.skills ?? []);
  const configuredSkillsRoot = isIndexedExpert
    ? undefined
    : (input.expertSession?.skillsRoot ?? input.skillsRoot);
  const baseInstructions =
    composeProviderBaseInstructions({
      expertPersona: input.expertSession?.persona,
      contextInstructions:
        input.contextSession?.hasContent === true ? input.contextSession.text : undefined,
    }) ?? "";
  const instructionsHash = sha256(baseInstructions);

  const operation = Effect.gen(function* () {
    const versionResult = yield* input
      .runCli(["--version"], input.cwd, input.env)
      .pipe(Effect.result);
    if (Result.isFailure(versionResult)) {
      return noResources(
        ["OMP version could not be verified; Expert projection is disabled."],
        instructionsHash,
      );
    }
    const versionFailure = requireExitZero(versionResult.success, "the CLI version");
    const detectedVersion = versionFailure
      ? undefined
      : parseCliVersion(versionResult.success.stdout);
    if (!detectedVersion) {
      return noResources(
        ["OMP returned an unrecognized CLI version; Expert projection is disabled."],
        instructionsHash,
      );
    }
    if (detectedVersion !== OMP_EXPERT_SUPPORTED_CLI_VERSION) {
      return noResources(
        [
          `OMP ${detectedVersion} has no verified Expert projection contract; verified version is ${OMP_EXPERT_SUPPORTED_CLI_VERSION}.`,
        ],
        instructionsHash,
      );
    }
    verifiedCliVersion = detectedVersion;

    const configResult = yield* input
      .runCli(["config", "list", "--json"], input.cwd, input.env)
      .pipe(Effect.result);
    if (Result.isFailure(configResult)) {
      return noResources(
        ["OMP effective skill settings could not be read; Expert projection is disabled."],
        instructionsHash,
      );
    }
    const configFailure = requireExitZero(configResult.success, "effective settings");
    const config = configFailure ? undefined : parseConfigList(configResult.success.stdout);
    if (!config) {
      return noResources(
        [
          "OMP effective skill settings were incomplete or unrecognized; Expert projection is disabled.",
        ],
        instructionsHash,
      );
    }
    if (requestedSkills.length > 0 && !config.skillsEnabled) {
      return noResources(
        [
          "OMP skills.enabled=false prevents required Expert skills from loading; Synara will not enable it.",
        ],
        instructionsHash,
      );
    }

    const resolvedSkillsResult = yield* Effect.tryPromise({
      try: () =>
        resolveExpertSkills(
          requestedSkills,
          configuredSkillsRoot,
          input.expertSession !== undefined && !isIndexedExpert,
        ),
      catch: () => new Error("One or more required Expert skill files cannot be read safely."),
    }).pipe(Effect.result);
    if (Result.isFailure(resolvedSkillsResult)) {
      return noResources(
        ["One or more required Expert skill files cannot be read safely."],
        instructionsHash,
      );
    }
    const resolvedSkills = resolvedSkillsResult.success;
    if (resolvedSkills.issue) return noResources([resolvedSkills.issue], instructionsHash);
    const expectedSkills = resolvedSkills.skills;
    const skillRealPaths = resolvedSkills.paths;
    const skillCustomDirectories = resolvedSkills.customDirectories;

    let nativeAppend: { readonly path: string; readonly text: string } | undefined;
    if (baseInstructions.length > 0) {
      const nativeAppendEither = yield* Effect.tryPromise({
        try: () => readNativeAppendSystemPrompt(input.cwd, input.env, config),
        catch: () =>
          new Error(
            "OMP's effective APPEND_SYSTEM.md exists but its content could not be validated.",
          ),
      }).pipe(Effect.result);
      if (Result.isFailure(nativeAppendEither)) {
        return noResources(
          ["OMP's effective APPEND_SYSTEM.md exists but its content could not be validated."],
          instructionsHash,
        );
      }
      nativeAppend = nativeAppendEither.success;
    }

    const needsTempDirectory = expectedSkills.length > 0 || baseInstructions.length > 0;
    if (!needsTempDirectory) {
      return noResources([], instructionsHash);
    }

    const prepareFiles = yield* Effect.tryPromise({
      try: async () => {
        tempPath = await mkdtemp(
          nodePath.join(input.tempDirectory ?? nodeOs.tmpdir(), OMP_EXPERT_TEMP_PREFIX),
        );
        const configOverlayPath =
          expectedSkills.length > 0 ? nodePath.join(tempPath, "config.yml") : undefined;
        const appendSystemPromptPath =
          baseInstructions.length > 0 ? nodePath.join(tempPath, "APPEND_SYSTEM.md") : undefined;

        if (configOverlayPath) {
          const customDirectories = [...skillCustomDirectories, ...config.customDirectories];
          const overlay = stringifyYaml({ skills: { customDirectories } }, { lineWidth: 0 });
          await writeFile(configOverlayPath, overlay, { encoding: "utf8", mode: 0o400 });
          await chmod(configOverlayPath, 0o400);
          await verifyReadOnlyTempFile(configOverlayPath, overlay);
        }

        if (appendSystemPromptPath) {
          const prompt = [nativeAppend?.text, baseInstructions].filter(Boolean).join("\n\n");
          await writeFile(appendSystemPromptPath, prompt, { encoding: "utf8", mode: 0o400 });
          await chmod(appendSystemPromptPath, 0o400);
          await verifyReadOnlyTempFile(appendSystemPromptPath, prompt);
        }
        return { configOverlayPath, appendSystemPromptPath };
      },
      catch: () => new Error("OMP Expert session resources could not be prepared safely."),
    }).pipe(Effect.result);
    if (Result.isFailure(prepareFiles)) {
      return noResources(
        ["OMP Expert session resources could not be prepared safely."],
        instructionsHash,
      );
    }
    const { configOverlayPath, appendSystemPromptPath } = prepareFiles.success;

    const loadedSkills: ProviderSkillReference[] = [];
    if (configOverlayPath) {
      const overlayEnv: NodeJS.ProcessEnv = { ...input.env };
      const inheritedConfigFiles = overlayEnv.PI_CONFIG_FILES?.trim();
      overlayEnv.PI_CONFIG_FILES = [inheritedConfigFiles, configOverlayPath]
        .filter((entry): entry is string => Boolean(entry))
        .join(nodePath.delimiter);

      const effectiveDirectoriesEither = yield* input
        .runCli(["config", "get", "skills.customDirectories", "--json"], input.cwd, overlayEnv)
        .pipe(Effect.result);
      const effectiveDirectories = Result.isSuccess(effectiveDirectoriesEither)
        ? requireExitZero(effectiveDirectoriesEither.success, "the Expert skills overlay")
          ? undefined
          : parseConfigGet(effectiveDirectoriesEither.success.stdout)
        : undefined;
      const expectedDirectories = [...skillCustomDirectories, ...config.customDirectories];
      if (
        !effectiveDirectories ||
        JSON.stringify(effectiveDirectories) !== JSON.stringify(expectedDirectories)
      ) {
        return noResources(
          ["OMP did not confirm the Expert skills overlay as its effective customDirectories."],
          instructionsHash,
        );
      }

      const skillListEither = yield* input
        .runCli(["skill", "list", input.cwd, "--json"], input.cwd, overlayEnv)
        .pipe(Effect.result);
      const skillListFailure = Result.isSuccess(skillListEither)
        ? requireExitZero(skillListEither.success, "native Expert skill loading")
        : "OMP's native skill loader could not be run.";
      const skillList =
        !skillListFailure && Result.isSuccess(skillListEither)
          ? parseNativeSkillList(skillListEither.success.stdout)
          : undefined;
      if (!skillList) {
        return noResources(
          [skillListFailure ?? "OMP native skill loading returned an unrecognized result."],
          instructionsHash,
        );
      }

      const nativeSkillPaths = yield* Effect.tryPromise({
        try: () =>
          Promise.all(
            skillList.skills.map(async (skill) => realpath(skill.filePath).catch(() => undefined)),
          ),
        catch: () => new Error("OMP native skill paths could not be verified."),
      }).pipe(Effect.result);
      if (Result.isFailure(nativeSkillPaths)) {
        return noResources(["OMP native skill paths could not be verified."], instructionsHash);
      }

      const issues: string[] = [];
      const usedSkills = new Set<number>();
      for (const expected of expectedSkills) {
        const loadedIndex = skillList.skills.findIndex((skill, index) => {
          if (usedSkills.has(index) || skill.name !== expected.name) return false;
          const expectedPath = skillRealPaths.get(expected);
          return expectedPath !== undefined && nativeSkillPaths.success[index] === expectedPath;
        });
        if (loadedIndex < 0) {
          const activeFilters = matchingFilterNames(expected.name, config);
          const hasWarning = hasSkillWarningForPath(skillList.warnings, expected.path);
          const filterReason =
            activeFilters.length > 0
              ? ` Effective OMP filters are present: ${activeFilters.join(", ")}.`
              : " OMP did not expose this skill through its native loader; its description/format or source configuration may be incompatible.";
          const warningReason = hasWarning
            ? " OMP native loader reported a warning for the snapshot file."
            : "";
          issues.push(
            `Required Expert skill '${expected.name}' was not loaded from its snapshot path.${filterReason}${warningReason}`,
          );
          continue;
        }
        usedSkills.add(loadedIndex);
        const actual = skillList.skills[loadedIndex]!;
        if (!actual.description.trim()) {
          issues.push(`Required Expert skill '${expected.name}' has no native description.`);
        }
        if (actual.hide === true) {
          issues.push(
            `Required Expert skill '${expected.name}' is hidden from native model invocation.`,
          );
        }
        loadedSkills.push({ name: actual.name, path: actual.filePath });
      }
      if (issues.length > 0) return noResources(issues, instructionsHash);
    }

    const result: OmpExpertSessionPreparation = {
      issues: [],
      ...(verifiedCliVersion ? { cliVersion: verifiedCliVersion } : {}),
      instructionsHash,
      loadedSkills,
      ...(configOverlayPath ? { configOverlayPath } : {}),
      ...(appendSystemPromptPath ? { appendSystemPromptPath } : {}),
      cleanup,
    };
    preserveTempPath = true;
    return result;
  });

  return operation.pipe(Effect.onExit(() => (preserveTempPath ? Effect.void : cleanup())));
}

function prepareFixedOmpExpertSession(
  input: OmpExpertSessionPreparationInput,
): Effect.Effect<OmpExpertSessionPreparation> {
  const session = input.expertSession!;
  const baseInstructions =
    composeProviderBaseInstructions({
      expertPersona: session.persona,
      contextInstructions: input.contextSession?.hasContent ? input.contextSession.text : undefined,
    }) ?? "";
  let temp: string | undefined;
  const cleanup = () =>
    Effect.promise(async () => {
      if (temp) await removeFixedProjectionStaging(temp);
      temp = undefined;
    });
  const failure = (message: string): OmpExpertSessionPreparation => ({
    issues: [message],
    instructionsHash: sha256(baseInstructions),
    loadedSkills: [],
    cleanup,
  });
  return Effect.gen(function* () {
    const lifecycleGeneration = input.lifecycleGeneration;
    if (!lifecycleGeneration)
      throw new Error("Fixed native verification requires a lifecycle generation.");
    const version = yield* input.runCli(["--version"], input.cwd, input.env);
    const cliVersion = parseCliVersion(version.stdout);
    if (version.exitCode !== 0 || cliVersion !== OMP_EXPERT_SUPPORTED_CLI_VERSION)
      throw new Error("OMP has no verified fixed Skill assembly contract for this CLI version.");
    const originalConfigResult = yield* input.runCli(
      ["config", "list", "--json"],
      input.cwd,
      input.env,
    );
    const originalConfig =
      originalConfigResult.exitCode === 0
        ? parseConfigList(originalConfigResult.stdout)
        : undefined;
    if (!originalConfig) throw new Error("OMP could not resolve its native instruction sources.");
    const nativeAppend = yield* Effect.promise(() =>
      readNativeAppendSystemPrompt(input.cwd, input.env, originalConfig),
    );
    const projectedInstructions = [nativeAppend?.text, baseInstructions]
      .filter(Boolean)
      .join("\n\n");
    temp = yield* Effect.promise(() =>
      mkdtemp(nodePath.join(input.tempDirectory ?? nodeOs.tmpdir(), OMP_EXPERT_TEMP_PREFIX)),
    );
    const projection = yield* Effect.promise(() => createFixedSkillProjection(temp!, session));
    assertUniqueOmpSkillNames(projection);
    const configOverlayPath = nodePath.join(temp, "config.yml"),
      appendSystemPromptPath = nodePath.join(temp, "APPEND_SYSTEM.md");
    const skills = {
      enabled: true,
      enableCodexUser: false,
      enableClaudeUser: false,
      enableClaudeProject: false,
      enablePiUser: false,
      enablePiProject: false,
      enableAgentsUser: false,
      enableAgentsProject: false,
      customDirectories: ompNativeSkillContainerRoots(projection),
      includeSkills: projection.entries.length
        ? projection.entries.map((entry) => entry.name)
        : ["__synara_empty_fixed_assembly__"],
      ignoredSkills: [],
    };
    const maxRecursionDepth = session.skillPolicy?.nativeSubagents === "inherit" ? 1 : 0;
    const overlay = stringifyYaml(
      { skills, task: { maxRecursionDepth }, advisor: { enabled: false } },
      { lineWidth: 0 },
    );
    yield* Effect.promise(async () => {
      await writeFile(configOverlayPath, overlay, { mode: 0o400 });
      await writeFile(appendSystemPromptPath, projectedInstructions, { mode: 0o400 });
    });
    const env = {
      ...input.env,
      PI_CONFIG_FILES: [input.env.PI_CONFIG_FILES, configOverlayPath]
        .filter(Boolean)
        .join(nodePath.delimiter),
    };
    const verify = () =>
      Effect.gen(function* () {
        invalidateNativeSkillAssemblyVerification(session);
        const configResult = yield* input.runCli(["config", "list", "--json"], input.cwd, env);
        if (configResult.exitCode !== 0)
          throw new Error("OMP could not verify the fixed Skill configuration.");
        const config = JSON.parse(configResult.stdout) as Record<string, { value?: unknown }>;
        for (const key of [
          "enableCodexUser",
          "enableClaudeUser",
          "enableClaudeProject",
          "enablePiUser",
          "enablePiProject",
          "enableAgentsUser",
          "enableAgentsProject",
        ])
          if (config[`skills.${key}`]?.value !== false)
            throw new Error(`OMP did not disable ambient Skill source ${key}.`);
        if (
          config["task.maxRecursionDepth"]?.value !== maxRecursionDepth ||
          config["advisor.enabled"]?.value !== false ||
          config["skills.enabled"]?.value !== true ||
          JSON.stringify(config["skills.customDirectories"]?.value) !==
            JSON.stringify(skills.customDirectories) ||
          JSON.stringify(config["skills.includeSkills"]?.value) !==
            JSON.stringify(skills.includeSkills)
        )
          throw new Error("OMP did not attest the fixed assembly and native task depth.");
        const result = yield* input.runCli(["skill", "list", input.cwd, "--json"], input.cwd, env),
          parsed = result.exitCode === 0 ? parseNativeSkillList(result.stdout) : undefined;
        if (!parsed) throw new Error("OMP could not resolve the exact fixed Skill assembly.");
        yield* Effect.promise(() => rejectOmpNameCollisions(projection, parsed.skills));
        yield* Effect.promise(async () => {
          await verifyReadOnlyTempFile(configOverlayPath, overlay);
          await verifyReadOnlyTempFile(appendSystemPromptPath, projectedInstructions);
        });
        yield* Effect.promise(() =>
          verifyProjectedSkillAssembly(
            session,
            projection,
            parsed.skills.map((skill) => ({ name: skill.name, path: skill.filePath })),
            lifecycleGeneration,
          ),
        );
      });
    yield* verify();
    return {
      issues: [],
      cliVersion,
      instructionsHash: sha256(baseInstructions),
      loadedSkills: session.skills,
      configOverlayPath,
      appendSystemPromptPath,
      ownedTempDirectory: temp,
      cleanup,
      verify,
      allowedSkillCommands: projection.entries.map((entry) => entry.name),
    };
  }).pipe(Effect.catchCause((cause) => cleanup().pipe(Effect.as(failure(String(cause))))));
}
