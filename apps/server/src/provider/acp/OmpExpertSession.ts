/**
 * OMP's native, per-session projection for immutable Expert and Context inputs.
 *
 * @module OmpExpertSession
 */
import { createHash } from "node:crypto";
import { access, chmod, lstat, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import * as nodeOs from "node:os";
import * as nodePath from "node:path";

import type { ContextSession } from "@synara/contracts";
import type { ProviderExpertSession, ProviderSkillReference } from "@synara/contracts";
import { composeProviderBaseInstructions } from "@synara/shared/contextInstructions";
import { Effect, Result } from "effect";
import { stringify as stringifyYaml } from "yaml";

export const OMP_EXPERT_PROJECTION_VERSION = "omp-acp-native-v1" as const;
export const OMP_EXPERT_SUPPORTED_CLI_VERSION = "18.12.1" as const;
const OMP_EXPERT_TEMP_PREFIX = "synara-omp-expert-";

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
  readonly cleanup: () => Effect.Effect<void>;
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

export function prepareOmpExpertSession(
  input: OmpExpertSessionPreparationInput,
): Effect.Effect<OmpExpertSessionPreparation> {
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
