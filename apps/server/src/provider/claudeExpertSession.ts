import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";

import type { ProviderSkillReference } from "@synara/contracts";

export const CLAUDE_EXPERT_PROJECTION_VERSION = "claude-skills-v1";
export const CLAUDE_EXPERT_PLUGIN_NAME = "synara-expert";

const MAX_SKILL_FILES = 4096;
const MAX_SKILL_BYTES = 50 * 1024 * 1024;

interface ProjectedFile {
  readonly relativePath: string;
  readonly content: Buffer;
  readonly mode: number;
}

interface InspectedSkill {
  readonly reference: ProviderSkillReference;
  readonly alias: string;
  readonly files: ReadonlyArray<ProjectedFile>;
}

export interface ClaudeExpertSkillInspection {
  readonly skills: ReadonlyArray<InspectedSkill>;
  readonly issues: ReadonlyArray<string>;
}

export interface ClaudeExpertProjection {
  readonly pluginName: typeof CLAUDE_EXPERT_PLUGIN_NAME;
  readonly pluginPath: string;
  readonly projectionVersion: typeof CLAUDE_EXPERT_PROJECTION_VERSION;
  readonly skills: ReadonlyArray<ProviderSkillReference>;
  readonly nativeSkillNames: ReadonlyArray<string>;
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
  );
}

function validSkillName(name: string): boolean {
  return /^[a-z0-9][a-z0-9_-]{0,63}$/iu.test(name);
}

async function readSkillTree(directory: string): Promise<ReadonlyArray<ProjectedFile>> {
  const files: ProjectedFile[] = [];
  let totalBytes = 0;

  const visit = async (current: string, relativeDirectory: string): Promise<void> => {
    const entries = await readdir(current, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const source = path.join(current, entry.name);
      const relativePath = relativeDirectory
        ? path.join(relativeDirectory, entry.name)
        : entry.name;
      const stat = await lstat(source);
      if (stat.isSymbolicLink()) {
        throw new Error("Expert skill snapshots cannot contain symbolic links.");
      }
      if (stat.isDirectory()) {
        await visit(source, relativePath);
        continue;
      }
      if (!stat.isFile()) {
        throw new Error("Expert skill snapshots can contain only regular files and directories.");
      }
      if (files.length >= MAX_SKILL_FILES) {
        throw new Error("Expert skill snapshot contains too many files.");
      }
      const content = await readFile(source);
      totalBytes += content.byteLength;
      if (totalBytes > MAX_SKILL_BYTES) {
        throw new Error("Expert skill snapshot exceeds the projection size limit.");
      }
      files.push({ relativePath, content, mode: stat.mode & 0o777 });
    }
  };

  await visit(directory, "");
  if (!files.some((file) => file.relativePath === "SKILL.md")) {
    throw new Error("Expert skill snapshot is missing its SKILL.md file.");
  }
  return files;
}

function validateSkillInitVisibility(skillName: string, content: Buffer): string | undefined {
  const text = content.toString("utf8");
  const frontmatter = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u);
  if (!frontmatter) {
    return `Claude Code cannot verify skill "${skillName}" without YAML frontmatter and a description.`;
  }
  let metadata: unknown;
  try {
    metadata = parseYaml(frontmatter[1] ?? "");
  } catch {
    return `Claude Code cannot verify skill "${skillName}" because its YAML frontmatter is invalid.`;
  }
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return `Claude Code cannot verify skill "${skillName}" because its YAML frontmatter is not a mapping.`;
  }
  const record = metadata as Record<string, unknown>;
  if (typeof record.description !== "string" || record.description.trim().length === 0) {
    return `Claude Code cannot verify skill "${skillName}" because its frontmatter has no non-empty description.`;
  }
  if (record["user-invocable"] === false) {
    return `Claude Code cannot verify skill "${skillName}" because user-invocable: false hides it from native init lists.`;
  }
  if (record["user-invocable"] !== undefined && typeof record["user-invocable"] !== "boolean") {
    return `Claude Code cannot verify skill "${skillName}" because user-invocable must be a YAML boolean.`;
  }
  return undefined;
}

export async function inspectClaudeExpertSkills(input: {
  readonly skills: ReadonlyArray<ProviderSkillReference>;
  readonly skillsRoot?: string;
}): Promise<ClaudeExpertSkillInspection> {
  const issues: string[] = [];
  const inspected: InspectedSkill[] = [];
  const seenNames = new Set<string>();
  let root: string | undefined;

  if (input.skillsRoot !== undefined) {
    root = path.resolve(input.skillsRoot);
    try {
      const rootStat = await lstat(root);
      if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
        issues.push("The Expert snapshot skills root is unavailable or unsafe.");
        root = undefined;
      }
    } catch {
      issues.push("The Expert snapshot skills root is unavailable or unsafe.");
      root = undefined;
    }
  }

  for (const reference of input.skills) {
    if (!validSkillName(reference.name)) {
      issues.push("An Expert skill has a name Claude Code cannot safely expose.");
      continue;
    }
    const foldedName = reference.name.toLowerCase();
    if (seenNames.has(foldedName)) {
      issues.push("Expert skills contain duplicate names that would collide in Claude Code.");
      continue;
    }
    seenNames.add(foldedName);

    const referencedPath = path.resolve(reference.path);
    if (root !== undefined && !isWithin(root, referencedPath)) {
      issues.push("An Expert skill is outside its immutable snapshot skills root.");
      continue;
    }

    try {
      const referenceStat = await lstat(referencedPath);
      if (referenceStat.isSymbolicLink()) {
        issues.push("Expert skill snapshots cannot contain symbolic links.");
        continue;
      }
      const skillDirectory = referenceStat.isDirectory()
        ? referencedPath
        : path.dirname(referencedPath);
      const skillFile = referenceStat.isDirectory()
        ? path.join(referencedPath, "SKILL.md")
        : referencedPath;
      if (path.basename(skillFile) !== "SKILL.md") {
        issues.push("Each Expert skill must resolve to a SKILL.md file.");
        continue;
      }
      if (root !== undefined && !isWithin(root, skillDirectory)) {
        issues.push("An Expert skill is outside its immutable snapshot skills root.");
        continue;
      }
      const skillFileStat = await lstat(skillFile);
      if (!skillFileStat.isFile() || skillFileStat.isSymbolicLink()) {
        issues.push("An Expert skill is missing a regular SKILL.md file.");
        continue;
      }
      const files = await readSkillTree(skillDirectory);
      const visibilityIssue = validateSkillInitVisibility(
        reference.name,
        files.find((file) => file.relativePath === "SKILL.md")!.content,
      );
      if (visibilityIssue) {
        issues.push(visibilityIssue);
        continue;
      }
      inspected.push({ reference: { ...reference }, alias: reference.name, files });
    } catch {
      issues.push("An Expert skill source is missing, unreadable, or unsafe to project.");
    }
  }

  return { skills: inspected, issues };
}

function projectionContentHash(input: {
  readonly snapshotId: string;
  readonly skills: ReadonlyArray<InspectedSkill>;
}): string {
  const hash = createHash("sha256");
  hash.update(CLAUDE_EXPERT_PROJECTION_VERSION, "utf8");
  hash.update("\0", "utf8");
  hash.update(input.snapshotId, "utf8");
  for (const skill of input.skills) {
    hash.update("\0skill\0", "utf8");
    hash.update(skill.reference.name, "utf8");
    for (const file of skill.files) {
      hash.update("\0file\0", "utf8");
      hash.update(file.relativePath, "utf8");
      hash.update(`\0${file.mode.toString(8)}\0`, "utf8");
      hash.update(file.content);
    }
  }
  return hash.digest("hex");
}

async function verifyExistingProjection(input: {
  readonly projectionDirectory: string;
  readonly metadata: string;
  readonly pluginPath: string;
  readonly contentHash: string;
  readonly snapshotId: string;
  readonly skills: ReadonlyArray<InspectedSkill>;
}): Promise<boolean> {
  try {
    const metadata = JSON.parse(await readFile(input.metadata, "utf8")) as {
      projectionVersion?: unknown;
      snapshotId?: unknown;
      contentHash?: unknown;
    };
    if (
      metadata.projectionVersion !== CLAUDE_EXPERT_PROJECTION_VERSION ||
      metadata.snapshotId !== input.snapshotId ||
      metadata.contentHash !== input.contentHash
    ) {
      return false;
    }
    const manifest = JSON.parse(
      await readFile(path.join(input.pluginPath, ".claude-plugin", "plugin.json"), "utf8"),
    ) as { name?: unknown };
    if (manifest.name !== CLAUDE_EXPERT_PLUGIN_NAME) return false;
    const expectedFiles = new Set<string>([
      ".claude-plugin/plugin.json",
      ...input.skills.flatMap((skill) =>
        skill.files.map((file) => path.join("skills", skill.alias, file.relativePath)),
      ),
    ]);
    const actualFiles = new Set<string>();
    const visit = async (directory: string, relativeDirectory: string): Promise<boolean> => {
      const entries = await readdir(directory, { withFileTypes: true });
      for (const entry of entries) {
        const target = path.join(directory, entry.name);
        const relativePath = relativeDirectory
          ? path.join(relativeDirectory, entry.name)
          : entry.name;
        const targetStat = await lstat(target);
        if (targetStat.isSymbolicLink()) return false;
        if (targetStat.isDirectory()) {
          if (!(await visit(target, relativePath))) return false;
        } else if (targetStat.isFile()) {
          actualFiles.add(relativePath);
        } else {
          return false;
        }
      }
      return true;
    };
    if (!(await visit(input.pluginPath, ""))) return false;
    if (
      actualFiles.size !== expectedFiles.size ||
      [...expectedFiles].some((file) => !actualFiles.has(file))
    ) {
      return false;
    }
    for (const skill of input.skills) {
      for (const file of skill.files) {
        const target = path.join(input.pluginPath, "skills", skill.alias, file.relativePath);
        const targetStat = await lstat(target);
        if (!targetStat.isFile() || targetStat.isSymbolicLink()) return false;
        if ((targetStat.mode & 0o777) !== file.mode) return false;
        if (!(await readFile(target)).equals(file.content)) return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

export async function createClaudeExpertProjection(input: {
  readonly outputRoot: string;
  readonly snapshotId: string;
  readonly skillsRoot?: string;
  readonly skills: ReadonlyArray<ProviderSkillReference>;
}): Promise<ClaudeExpertProjection> {
  const inspection = await inspectClaudeExpertSkills(input);
  if (inspection.issues.length > 0) {
    throw new Error(inspection.issues.join(" "));
  }
  const contentHash = projectionContentHash({
    snapshotId: input.snapshotId,
    skills: inspection.skills,
  });
  const snapshotKey = sha256(input.snapshotId).slice(0, 24);
  const projectionDirectory = path.join(
    path.resolve(input.outputRoot),
    CLAUDE_EXPERT_PROJECTION_VERSION,
    `${snapshotKey}-${contentHash.slice(0, 32)}`,
  );
  const pluginPath = path.join(projectionDirectory, "plugin");
  const metadataPath = path.join(projectionDirectory, "projection.json");

  await mkdir(path.dirname(projectionDirectory), { recursive: true, mode: 0o700 });
  const receiptSkills = inspection.skills.map((skill) => ({
    name: skill.reference.name,
    path: path.join(pluginPath, "skills", skill.alias, "SKILL.md"),
  }));
  if (
    await verifyExistingProjection({
      projectionDirectory,
      metadata: metadataPath,
      pluginPath,
      contentHash,
      snapshotId: input.snapshotId,
      skills: inspection.skills,
    })
  ) {
    return {
      pluginName: CLAUDE_EXPERT_PLUGIN_NAME,
      pluginPath,
      projectionVersion: CLAUDE_EXPERT_PROJECTION_VERSION,
      skills: receiptSkills,
      nativeSkillNames: inspection.skills.map(
        (skill) => `${CLAUDE_EXPERT_PLUGIN_NAME}:${skill.alias}`,
      ),
    };
  }

  try {
    await lstat(projectionDirectory);
    throw new Error("An existing Claude Expert projection does not match its immutable source.");
  } catch (cause) {
    if (!(cause instanceof Error && "code" in cause && cause.code === "ENOENT")) throw cause;
  }

  const stagingDirectory = `${projectionDirectory}.tmp-${randomUUID()}`;
  const stagingPluginPath = path.join(stagingDirectory, "plugin");
  try {
    await mkdir(path.join(stagingPluginPath, ".claude-plugin"), { recursive: true, mode: 0o700 });
    await mkdir(path.join(stagingPluginPath, "skills"), { recursive: true, mode: 0o700 });
    const manifest = {
      name: CLAUDE_EXPERT_PLUGIN_NAME,
      version: "1.0.0",
      description: "Expert skills projected for this Synara session.",
    };
    const manifestPath = path.join(stagingPluginPath, ".claude-plugin", "plugin.json");
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o400 });
    await chmod(manifestPath, 0o400);

    for (const skill of inspection.skills) {
      const targetSkillDirectory = path.join(stagingPluginPath, "skills", skill.alias);
      await mkdir(targetSkillDirectory, { recursive: true, mode: 0o700 });
      for (const file of skill.files) {
        const target = path.join(targetSkillDirectory, file.relativePath);
        await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
        await writeFile(target, file.content, { mode: file.mode });
        await chmod(target, file.mode);
      }
    }

    await writeFile(
      path.join(stagingDirectory, "projection.json"),
      `${JSON.stringify({
        projectionVersion: CLAUDE_EXPERT_PROJECTION_VERSION,
        snapshotId: input.snapshotId,
        contentHash,
      })}\n`,
      { mode: 0o600 },
    );
    await rename(stagingDirectory, projectionDirectory);
  } catch (cause) {
    await rm(stagingDirectory, { recursive: true, force: true }).catch(() => undefined);
    if (
      await verifyExistingProjection({
        projectionDirectory,
        metadata: metadataPath,
        pluginPath,
        contentHash,
        snapshotId: input.snapshotId,
        skills: inspection.skills,
      })
    ) {
      return {
        pluginName: CLAUDE_EXPERT_PLUGIN_NAME,
        pluginPath,
        projectionVersion: CLAUDE_EXPERT_PROJECTION_VERSION,
        skills: receiptSkills,
        nativeSkillNames: inspection.skills.map(
          (skill) => `${CLAUDE_EXPERT_PLUGIN_NAME}:${skill.alias}`,
        ),
      };
    }
    throw cause;
  }

  return {
    pluginName: CLAUDE_EXPERT_PLUGIN_NAME,
    pluginPath,
    projectionVersion: CLAUDE_EXPERT_PROJECTION_VERSION,
    skills: receiptSkills,
    nativeSkillNames: inspection.skills.map(
      (skill) => `${CLAUDE_EXPERT_PLUGIN_NAME}:${skill.alias}`,
    ),
  };
}

export function claudeNativeSkillCommandName(name: string): string {
  return `${CLAUDE_EXPERT_PLUGIN_NAME}:${name}`;
}
