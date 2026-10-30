import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { supportsPosixPermissions } from "@synara/shared/filesystemPlatform";

import type { AgentDefinition } from "@anthropic-ai/claude-agent-sdk";
import type { ProviderExpertSession, ResolvedExpertSkillEntry } from "@synara/contracts";
import { parse as parseYaml } from "yaml";

import { expertResourceFiles } from "../experts/ExpertStore";
import { ensurePrivateDirectorySync, syncDirectoryEntry } from "../privatePathPermissions";
import {
  createFixedSkillProjection,
  type FixedSkillProjection,
  type FixedSkillProjectionEntry,
  type FixedSkillProjectionPackage,
} from "./fixedSkillProjection";

const PROJECTION_VERSION = "claude-fixed-skill-view-v5";
const BUILTIN_CLAUDE_AGENT_TYPES = new Set(["Explore", "Plan", "general-purpose"]);

export type FixedNativeAgentDefinition = Pick<
  AgentDefinition,
  | "description"
  | "prompt"
  | "model"
  | "maxTurns"
  | "autoCompactWindow"
  | "criticalSystemReminder_EXPERIMENTAL"
  | "initialPrompt"
  | "background"
  | "omitClaudeMd"
  | "effort"
> & {
  readonly model: string;
  readonly skills: string[];
  readonly tools?: string[];
  readonly disallowedTools?: string[];
};

export interface ClaudeFixedSkillProjection extends FixedSkillProjection {
  readonly pluginName: string;
  readonly plugins: ReadonlyArray<{ readonly name: string; readonly path: string }>;
  readonly agents: Readonly<Record<string, FixedNativeAgentDefinition>>;
  readonly allowedSubagentTypes: ReadonlyArray<string>;
  readonly entries: ReadonlyArray<
    FixedSkillProjectionEntry & {
      readonly pluginName: string;
      readonly nativeName: string;
    }
  >;
}

export class UnsupportedClaudeEntryScopeError extends Error {
  readonly code = "unsupported_entry_scope";

  constructor(message: string) {
    super(`unsupported_entry_scope: ${message}`);
    this.name = "UnsupportedClaudeEntryScopeError";
  }
}

interface ProjectionFile {
  readonly sha256: string;
  readonly size: number;
  readonly sourcePath?: string;
  readonly content?: string;
}

type ClaudePackage = FixedSkillProjectionPackage & {
  readonly pluginName: string;
  readonly generatedManifest?: string;
};

const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

function safeNativeDirectoryName(entry: ResolvedExpertSkillEntry): string {
  return `entry-${sha(`${entry.packageId}#${entry.entryPath}`).slice(0, 20)}`;
}

async function hashFile(filePath: string): Promise<string> {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) digest.update(chunk as Buffer);
  return digest.digest("hex");
}

function parseNativeMarkdown(text: string): {
  readonly metadata: Record<string, unknown>;
  readonly body: string;
} {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(text);
  if (!match) return { metadata: {}, body: text };
  const parsed: unknown = parseYaml(match[1] ?? "");
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("Native Skill or agent frontmatter must be a mapping.");
  return { metadata: parsed as Record<string, unknown>, body: text.slice(match[0].length) };
}

function nativeStringList(value: unknown, field: string, agentName: string): ReadonlyArray<string> {
  const raw =
    typeof value === "string"
      ? value.split(",")
      : Array.isArray(value) && value.every((item) => typeof item === "string")
        ? value
        : undefined;
  if (!raw) throw new Error(`Selected Expert Agent "${agentName}" has invalid ${field} metadata.`);
  return [...new Set(raw.map((item) => item.trim()).filter(Boolean))];
}

function nativePositiveInteger(
  metadata: Record<string, unknown>,
  field: "maxTurns" | "autoCompactWindow",
  agentName: string,
): number | undefined {
  if (!Object.hasOwn(metadata, field)) return undefined;
  const value = metadata[field];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1)
    throw new Error(`Selected Expert Agent "${agentName}" has invalid ${field} metadata.`);
  return value;
}

function nativeBoolean(
  metadata: Record<string, unknown>,
  field: "background" | "omitClaudeMd",
  agentName: string,
) {
  if (!Object.hasOwn(metadata, field)) return undefined;
  const value = metadata[field];
  if (typeof value !== "boolean")
    throw new Error(`Selected Expert Agent "${agentName}" has invalid ${field} metadata.`);
  return value;
}

function isNativeAgentEffort(value: unknown): value is NonNullable<AgentDefinition["effort"]> {
  return (
    (typeof value === "number" && Number.isFinite(value)) ||
    (typeof value === "string" && ["low", "medium", "high", "xhigh", "max"].includes(value))
  );
}

function mapManagedAgentSkills(
  value: unknown,
  projectedEntries: ReadonlyArray<ClaudeFixedSkillProjection["entries"][number]>,
  agentName: string,
): ReadonlyArray<string> {
  // An omitted declaration inherits the fixed parent set. An explicit empty or
  // partial list is a deliberate restriction and must remain so.
  if (value === undefined) return projectedEntries.map((entry) => entry.nativeName);
  return nativeStringList(value, "skills", agentName).map((requestedName) => {
    const matches = projectedEntries.filter((entry) =>
      [entry.nativeName, entry.name, entry.originalName].includes(requestedName),
    );
    const nativeNames = [...new Set(matches.map((entry) => entry.nativeName))];
    if (nativeNames.length !== 1)
      throw new Error(
        `Selected Expert Agent "${agentName}" references Skill "${requestedName}" outside or ambiguously within the fixed assembly.`,
      );
    return nativeNames[0]!;
  });
}

async function loadManagedSubagents(
  session: ProviderExpertSession,
  packages: ReadonlyArray<ClaudePackage>,
  projectedEntries: ReadonlyArray<ClaudeFixedSkillProjection["entries"][number]>,
): Promise<{
  readonly agents: Record<string, FixedNativeAgentDefinition>;
  readonly allowedSubagentTypes: ReadonlyArray<string>;
}> {
  const agents: Record<string, FixedNativeAgentDefinition> = {};
  const allowed = new Set<string>(BUILTIN_CLAUDE_AGENT_TYPES);
  for (const pkg of packages) {
    const entries = projectedEntries.filter((entry) => entry.packageId === pkg.packageId);
    for (const entry of entries) {
      const selected = parseNativeMarkdown(
        await fs.readFile(path.join(pkg.sourceRoot, ...entry.entryPath.split("/")), "utf8"),
      );
      const agentValue = selected.metadata.agent;
      const hasAgent = Object.hasOwn(selected.metadata, "agent");
      if (!hasAgent) {
        if (selected.metadata.context === "fork") allowed.add("general-purpose");
        continue;
      }
      if (typeof agentValue !== "string" || !agentValue.trim())
        throw new Error(`Selected Expert Skill "${entry.name}" has invalid native Agent metadata.`);
      const agentName = agentValue.trim();
      if (BUILTIN_CLAUDE_AGENT_TYPES.has(agentName)) {
        allowed.add(agentName);
        continue;
      }
      if (!/^[a-z0-9][a-z0-9_-]{0,63}$/iu.test(agentName))
        throw new Error(`Selected Expert Skill "${entry.name}" names an invalid native Agent.`);
      const candidates = [`agents/${agentName}.md`, `.claude/agents/${agentName}.md`];
      const resourcePath = candidates.find((candidate) =>
        pkg.resources.some(
          (resource) => resource.path === `content/${candidate}` && resource.kind === "file",
        ),
      );
      if (!resourcePath)
        throw new Error(
          `Selected Expert Skill "${entry.name}" requires native Agent "${agentName}", but its immutable package does not contain that definition.`,
        );
      const raw = await fs.readFile(path.join(pkg.sourceRoot, ...resourcePath.split("/")), "utf8");
      const native = parseNativeMarkdown(raw);
      const description =
        typeof native.metadata.description === "string" && native.metadata.description.trim()
          ? native.metadata.description
          : "Selected Expert agent.";
      const model = native.metadata.model === undefined ? "inherit" : native.metadata.model;
      if (typeof model !== "string" || !model.trim())
        throw new Error(`Selected Expert Agent "${agentName}" has invalid model metadata.`);
      const skills = mapManagedAgentSkills(native.metadata.skills, projectedEntries, agentName);
      const tools = Object.hasOwn(native.metadata, "tools")
        ? nativeStringList(native.metadata.tools, "tools", agentName)
        : undefined;
      const disallowedTools = Object.hasOwn(native.metadata, "disallowedTools")
        ? nativeStringList(native.metadata.disallowedTools, "disallowedTools", agentName)
        : undefined;
      const maxTurns = nativePositiveInteger(native.metadata, "maxTurns", agentName);
      const autoCompactWindow = nativePositiveInteger(
        native.metadata,
        "autoCompactWindow",
        agentName,
      );
      const background = nativeBoolean(native.metadata, "background", agentName);
      const omitClaudeMd = nativeBoolean(native.metadata, "omitClaudeMd", agentName);
      const criticalReminder = native.metadata.criticalSystemReminder_EXPERIMENTAL;
      if (criticalReminder !== undefined && typeof criticalReminder !== "string")
        throw new Error(
          `Selected Expert Agent "${agentName}" has invalid criticalSystemReminder_EXPERIMENTAL metadata.`,
        );
      const initialPrompt = native.metadata.initialPrompt;
      if (initialPrompt !== undefined && typeof initialPrompt !== "string")
        throw new Error(`Selected Expert Agent "${agentName}" has invalid initialPrompt metadata.`);
      const effort = native.metadata.effort;
      if (effort !== undefined && !isNativeAgentEffort(effort))
        throw new Error(`Selected Expert Agent "${agentName}" has invalid effort metadata.`);
      // Host permission modes, hooks, MCP servers, memory, and observer fields
      // never flow from package metadata into the Claude child agent.
      const definition: FixedNativeAgentDefinition = {
        description,
        prompt: native.body,
        model: model.trim(),
        skills: [...skills],
        ...(tools ? { tools: [...tools] } : {}),
        ...(disallowedTools ? { disallowedTools: [...disallowedTools] } : {}),
        ...(maxTurns !== undefined ? { maxTurns } : {}),
        ...(autoCompactWindow !== undefined ? { autoCompactWindow } : {}),
        ...(criticalReminder !== undefined
          ? { criticalSystemReminder_EXPERIMENTAL: criticalReminder }
          : {}),
        ...(initialPrompt !== undefined ? { initialPrompt } : {}),
        ...(background !== undefined ? { background } : {}),
        ...(omitClaudeMd !== undefined ? { omitClaudeMd } : {}),
        ...(effort !== undefined ? { effort } : {}),
      };
      const existing = agents[agentName];
      if (existing && JSON.stringify(existing) !== JSON.stringify(definition))
        throw new Error("Selected Skill packages contain conflicting native Agent definitions.");
      agents[agentName] = definition;
      allowed.add(agentName);
    }
  }
  return { agents, allowedSubagentTypes: [...allowed].toSorted() };
}

function nativeManifestResource(pkg: FixedSkillProjectionPackage) {
  const found = pkg.resources.find(
    (resource) => resource.path === "content/.claude-plugin/plugin.json",
  );
  if (found && found.kind !== "file")
    throw new Error("Claude plugin manifest path is occupied by a non-file package resource.");
  if (
    !found &&
    pkg.resources.some(
      (resource) => resource.path === "content/.claude-plugin" && resource.kind === "file",
    )
  )
    throw new Error("Claude plugin manifest directory path is occupied by a package file.");
  return found;
}

async function readNativeManifest(pkg: FixedSkillProjectionPackage): Promise<{
  readonly pluginName: string;
  readonly exists: boolean;
}> {
  const resource = nativeManifestResource(pkg);
  if (!resource) return { pluginName: `synara-fixed-${pkg.packageId.slice(4, 16)}`, exists: false };
  const realContentRoot = await fs.realpath(pkg.contentRoot);
  const manifestPath = path.join(realContentRoot, ".claude-plugin", "plugin.json");
  const bytes = await expertResourceFiles.read(manifestPath, realContentRoot);
  if (sha(bytes) !== resource.sha256)
    throw new Error("Immutable Claude plugin manifest changed before projection.");
  const parsed: unknown = JSON.parse(bytes.toString("utf8"));
  const name =
    parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>).name
      : undefined;
  if (typeof name !== "string" || !name.trim() || name !== name.trim())
    throw new Error("Immutable Claude plugin manifest must have a non-empty, trimmed name.");
  return { pluginName: name, exists: true };
}

function skillDirectory(entryPath: string): string {
  const directory = path.posix.dirname(entryPath);
  return directory === "." ? "./" : `./${directory}`;
}

function isWithinSkillDirectory(entryPath: string, directory: string): boolean {
  const parent = path.posix.dirname(entryPath);
  const root = directory === "./" ? "" : directory.slice(2);
  return root === "" || parent === root || parent.startsWith(`${root}/`);
}

function generatedManifest(
  pkg: FixedSkillProjectionPackage,
  pluginName: string,
  entries: ReadonlyArray<Pick<FixedSkillProjectionEntry, "entryPath">>,
): string {
  const selected = new Set(entries.map((entry) => entry.entryPath));
  const scopes = [...new Set(entries.map((entry) => skillDirectory(entry.entryPath)))].toSorted();
  const unselectedSkills = pkg.resources
    .filter(
      (resource) =>
        resource.kind === "file" &&
        resource.path.startsWith("content/") &&
        path.posix.basename(resource.path) === "SKILL.md",
    )
    .map((resource) => resource.path.slice("content/".length))
    .filter((entryPath) => !selected.has(entryPath));
  if (
    unselectedSkills.some((entryPath) =>
      scopes.some((scope) => isWithinSkillDirectory(entryPath, scope)),
    )
  )
    throw new UnsupportedClaudeEntryScopeError(
      "Claude plugin directory scopes would expose unselected entries; select the complete package.",
    );
  return `${JSON.stringify(
    {
      name: pluginName,
      version: "1.0.0",
      description: "Fixed Expert Skill assembly",
      skills: scopes,
    },
    null,
    2,
  )}\n`;
}

function addExpectedDirectory(expected: Map<string, ProjectionFile>, relative: string): void {
  if (!relative || relative === ".") return;
  expected.set(`${relative}/`, { sha256: "", size: 0 });
  let parent = path.posix.dirname(relative);
  while (parent !== ".") {
    expected.set(`${parent}/`, { sha256: "", size: 0 });
    parent = path.posix.dirname(parent);
  }
}

function addExpectedFile(
  expected: Map<string, ProjectionFile>,
  relative: string,
  sourcePath: string,
  resource: { readonly sha256: string; readonly size: number },
): void {
  expected.set(relative, { sha256: resource.sha256, size: resource.size, sourcePath });
  addExpectedDirectory(expected, path.posix.dirname(relative));
}

async function buildSharedPackageMirror(
  stage: string,
  pluginRelative: string,
  pkg: ClaudePackage,
): Promise<Map<string, ProjectionFile>> {
  const pluginRoot = path.join(stage, ...pluginRelative.split("/"));
  await fs.mkdir(pluginRoot, { recursive: true, mode: 0o700 });
  const expected = new Map<string, ProjectionFile>();
  for (const resource of pkg.resources) {
    if (resource.path === "content") continue;
    if (!resource.path.startsWith("content/"))
      throw new Error("Verified Skill package contains an invalid resource root.");
    const relative = resource.path.slice("content/".length);
    const target = path.join(pluginRoot, ...relative.split("/"));
    if (resource.kind === "directory") {
      await fs.mkdir(target, { recursive: true, mode: 0o700 });
      addExpectedDirectory(expected, relative);
    } else {
      const sourcePath = path.join(pkg.contentRoot, ...relative.split("/"));
      await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      await fs.link(sourcePath, target);
      addExpectedFile(expected, relative, sourcePath, resource);
    }
  }
  if (pkg.generatedManifest !== undefined) {
    const relative = ".claude-plugin/plugin.json";
    const target = path.join(pluginRoot, ...relative.split("/"));
    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await fs.writeFile(target, pkg.generatedManifest, { mode: 0o400, flag: "wx" });
    expected.set(relative, {
      sha256: sha(pkg.generatedManifest),
      size: Buffer.byteLength(pkg.generatedManifest),
      content: pkg.generatedManifest,
    });
    addExpectedDirectory(expected, ".claude-plugin");
  }
  return expected;
}

async function verifyPluginTree(
  root: string,
  expected: ReadonlyMap<string, ProjectionFile>,
): Promise<void> {
  const actual = new Map<
    string,
    { readonly kind: "directory" | "file"; readonly sha256?: string }
  >();
  const walk = async (directory: string, relative = ""): Promise<void> => {
    for (const item of await fs.readdir(directory, { withFileTypes: true })) {
      const child = path.join(directory, item.name);
      const childRelative = relative ? `${relative}/${item.name}` : item.name;
      const stat = await fs.lstat(child);
      if (stat.isSymbolicLink()) throw new Error("Claude Skill mirror contains a symbolic link.");
      if (stat.isDirectory()) {
        actual.set(`${childRelative}/`, { kind: "directory" });
        await walk(child, childRelative);
      } else if (stat.isFile()) {
        if (supportsPosixPermissions() && (stat.mode & 0o222) !== 0)
          throw new Error("Claude shared Skill mirror is writable.");
        actual.set(childRelative, { kind: "file", sha256: await hashFile(child) });
      } else {
        throw new Error("Claude Skill mirror contains an unsupported file type.");
      }
    }
  };
  await walk(root);
  if (actual.size !== expected.size)
    throw new Error("Claude Skill mirror has unexpected resources.");
  for (const [relative, record] of expected) {
    const found = actual.get(relative);
    if (record.sha256 === "") {
      if (found?.kind !== "directory") throw new Error("Claude Skill mirror directory is missing.");
      continue;
    }
    if (found?.kind !== "file" || found.sha256 !== record.sha256)
      throw new Error("Claude Skill mirror content differs from the immutable package.");
    const target = path.join(root, ...relative.split("/"));
    const stat = await fs.lstat(target);
    if (stat.size !== record.size) throw new Error("Claude Skill mirror file size changed.");
    if (record.sourcePath) {
      const source = await fs.lstat(record.sourcePath);
      if (
        source.isSymbolicLink() ||
        stat.isSymbolicLink() ||
        source.dev !== stat.dev ||
        source.ino !== stat.ino
      )
        throw new Error("Claude shared Skill resources must remain hard-linked to package bytes.");
    }
    if (record.content !== undefined && (await fs.readFile(target, "utf8")) !== record.content)
      throw new Error("Claude generated plugin manifest changed.");
  }
}

async function makeDirectoriesReadOnly(directory: string): Promise<void> {
  for (const item of await fs.readdir(directory, { withFileTypes: true })) {
    if (!item.isDirectory()) continue;
    const child = path.join(directory, item.name);
    await makeDirectoriesReadOnly(child);
    await fs.chmod(child, 0o500);
  }
}

async function makeDirectoriesWritable(directory: string): Promise<void> {
  await fs.chmod(directory, 0o700).catch(() => undefined);
  for (const item of await fs.readdir(directory, { withFileTypes: true }).catch(() => [])) {
    if (item.isDirectory()) await makeDirectoriesWritable(path.join(directory, item.name));
  }
}

async function verifyPrivateManifestTarget(pkg: ClaudePackage): Promise<void> {
  if (pkg.generatedManifest === undefined) return;
  const directory = path.join(pkg.sourceRoot, ".claude-plugin");
  const directoryStat = await fs.lstat(directory).catch((cause: unknown) => {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw cause;
  });
  if (directoryStat && (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()))
    throw new Error("Claude host manifest directory conflicts with existing Run-private content.");
  if (directoryStat) {
    const names = await fs.readdir(directory);
    if (names.some((name) => name !== "plugin.json"))
      throw new Error(
        "Claude host manifest directory conflicts with existing Run-private content.",
      );
  }
  const manifestPath = path.join(directory, "plugin.json");
  const stat = await fs.lstat(manifestPath).catch((cause: unknown) => {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw cause;
  });
  if (!stat) return;
  if (!stat.isFile() || stat.isSymbolicLink())
    throw new Error("Claude host manifest path conflicts with existing Run-private content.");
  const realSourceRoot = await fs.realpath(pkg.sourceRoot);
  const bytes = await expertResourceFiles.read(
    path.join(realSourceRoot, ".claude-plugin", "plugin.json"),
    realSourceRoot,
  );
  if (bytes.toString("utf8") !== pkg.generatedManifest)
    throw new Error("Claude host manifest conflicts with existing Run-private content.");
}

async function writePrivateManifest(pkg: ClaudePackage): Promise<void> {
  if (pkg.generatedManifest === undefined) return;
  await verifyPrivateManifestTarget(pkg);
  const directory = path.join(pkg.sourceRoot, ".claude-plugin");
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const manifestPath = path.join(directory, "plugin.json");
  try {
    await fs.writeFile(manifestPath, pkg.generatedManifest, { mode: 0o400, flag: "wx" });
    await syncDirectoryEntry(directory);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
    await verifyPrivateManifestTarget(pkg);
  }
}

export async function createClaudeFixedSkillProjection(
  base: string,
  session: ProviderExpertSession,
): Promise<ClaudeFixedSkillProjection> {
  const fixed = await createFixedSkillProjection(base, session);
  const selectedByPackage = new Map<string, FixedSkillProjectionEntry[]>();
  for (const entry of fixed.entries) {
    const group = selectedByPackage.get(entry.packageId) ?? [];
    group.push(entry);
    selectedByPackage.set(entry.packageId, group);
  }

  const names = new Map<string, string>();
  const claudePackages: ClaudePackage[] = [];
  const pluginPaths = new Map<string, string>();
  const entries: ClaudeFixedSkillProjection["entries"][number][] = [];
  for (const pkg of fixed.packages) {
    const selected = selectedByPackage.get(pkg.packageId) ?? [];
    const native = await readNativeManifest(pkg);
    const pluginName = native.pluginName;
    const priorPackage = names.get(pluginName);
    if (priorPackage && priorPackage !== pkg.packageId)
      throw new Error(`Claude plugin namespace collision for name ${pluginName}.`);
    names.set(pluginName, pkg.packageId);
    const generated = native.exists ? undefined : generatedManifest(pkg, pluginName, selected);
    const claudePackage: ClaudePackage = {
      ...pkg,
      pluginName,
      ...(generated !== undefined ? { generatedManifest: generated } : {}),
    };
    if (pkg.isPrivate) await verifyPrivateManifestTarget(claudePackage);
    claudePackages.push(claudePackage);

    const pluginPath = pkg.isPrivate
      ? pkg.sourceRoot
      : path.join(fixed.root, "plugins", pkg.packageId);
    pluginPaths.set(pkg.packageId, pluginPath);
    for (const entry of selected) {
      entries.push({
        ...entry,
        nativeName: `${pluginName}:${entry.name}`,
        pluginName,
        path: path.join(pluginPath, ...entry.entryPath.split("/")),
      });
    }
  }

  const managedSubagents =
    session.skillPolicy?.nativeSubagents === "inherit"
      ? await loadManagedSubagents(session, claudePackages, entries)
      : { agents: {}, allowedSubagentTypes: [] };

  const shared = claudePackages.filter((pkg) => !pkg.isPrivate);
  if (shared.length > 0) {
    const baseDir = path.dirname(fixed.root);
    ensurePrivateDirectorySync(baseDir);
    const current = await fs.lstat(fixed.root).catch((cause: unknown) => {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw cause;
    });
    if (!current) {
      const stage = path.join(baseDir, `.staging-${randomUUID()}`);
      await fs.mkdir(stage, { mode: 0o700 });
      try {
        for (const pkg of shared) {
          const expected = await buildSharedPackageMirror(stage, `plugins/${pkg.packageId}`, pkg);
          await verifyPluginTree(path.join(stage, "plugins", pkg.packageId), expected);
        }
        // Publish only after the tree is complete. Rename needs a writable
        // source directory on some filesystems, so seal the published root.
        let published = true;
        try {
          await fs.rename(stage, fixed.root);
        } catch (cause) {
          if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
          await fs.rm(stage, { recursive: true, force: true });
          published = false;
        }
        if (published) {
          await makeDirectoriesReadOnly(fixed.root);
          await fs.chmod(fixed.root, 0o500);
          await syncDirectoryEntry(baseDir);
        }
      } catch (cause) {
        await makeDirectoriesWritable(stage).catch(() => undefined);
        await fs.rm(stage, { recursive: true, force: true }).catch(() => undefined);
        throw cause;
      }
    } else if (!current.isDirectory() || current.isSymbolicLink()) {
      throw new Error("Unsafe Claude Skill projection root.");
    }
    for (const pkg of shared) {
      const expected = new Map<string, ProjectionFile>();
      for (const resource of pkg.resources) {
        if (resource.path === "content") continue;
        const relative = resource.path.slice("content/".length);
        if (resource.kind === "directory") addExpectedDirectory(expected, relative);
        else
          addExpectedFile(
            expected,
            relative,
            path.join(pkg.contentRoot, ...relative.split("/")),
            resource,
          );
      }
      if (pkg.generatedManifest !== undefined) {
        expected.set(".claude-plugin/plugin.json", {
          sha256: sha(pkg.generatedManifest),
          size: Buffer.byteLength(pkg.generatedManifest),
          content: pkg.generatedManifest,
        });
        addExpectedDirectory(expected, ".claude-plugin");
      }
      await verifyPluginTree(path.join(fixed.root, "plugins", pkg.packageId), expected);
    }
  }

  for (const pkg of claudePackages) if (pkg.isPrivate) await writePrivateManifest(pkg);

  const plugins = claudePackages.map((pkg) => ({
    name: pkg.pluginName,
    path: pluginPaths.get(pkg.packageId)!,
  }));
  const pluginName = plugins[0]?.name ?? `synara-fixed-empty-${sha(fixed.root).slice(0, 12)}`;
  return {
    ...fixed,
    root: fixed.root,
    skillRoots: plugins.map((plugin) => plugin.path),
    pluginName,
    plugins,
    agents: managedSubagents.agents,
    allowedSubagentTypes: managedSubagents.allowedSubagentTypes,
    entries,
  };
}
