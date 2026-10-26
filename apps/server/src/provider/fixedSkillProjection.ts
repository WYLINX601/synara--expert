import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AgentDefinition } from "@anthropic-ai/claude-agent-sdk";
import type { ProviderExpertSession, ResolvedExpertSkillEntry } from "@synara/contracts";
import { Schema } from "effect";
import { SkillPackage as SkillPackageSchema } from "@synara/contracts";
import { parse as parseYaml } from "yaml";
import { ensurePrivateDirectorySync, syncDirectoryEntry } from "../privatePathPermissions";
import { expertResourceFiles } from "../experts/ExpertStore";
import {
  verifyFixedExpertAssembly,
  recordVerifiedNativeSkillAssembly,
  invalidateNativeSkillAssemblyVerification,
} from "./expertSkillCatalog";

const PROJECTION_VERSION = "native-skill-view-v3";

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

export interface FixedSkillProjection {
  readonly root: string;
  /** Kept for provider APIs which accept one root. */
  readonly pluginName: string;
  readonly plugins: ReadonlyArray<{ readonly name: string; readonly path: string }>;
  readonly skillRoots: ReadonlyArray<string>;
  readonly agents: Readonly<Record<string, FixedNativeAgentDefinition>>;
  readonly allowedSubagentTypes: ReadonlyArray<string>;
  readonly entries: ReadonlyArray<{
    /** Original Skill name, as accepted by non-namespaced native APIs. */
    readonly name: string;
    /** Exact CLI identity, including plugin namespace where required. */
    readonly nativeName: string;
    readonly pluginName: string;
    readonly path: string;
    readonly originalName: string;
    readonly originalPath: string;
    readonly sha256: string;
    readonly userInvocable?: boolean;
  }>;
}

interface ExpectedFile {
  readonly sha256: string;
  readonly sourcePath?: string;
  readonly content?: string;
}

const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

function safeNativeDirectoryName(entry: ResolvedExpertSkillEntry): string {
  return `entry-${sha(`${entry.packageId}#${entry.entryPath}`).slice(0, 20)}`;
}

async function hashFile(filePath: string): Promise<string> {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) digest.update(chunk as Buffer);
  return digest.digest("hex");
}

async function assertReadOnlyRegularFile(
  filePath: string,
  expected: { size: number; sha256: string },
) {
  const stat = await fs.lstat(filePath);
  if (
    stat.isSymbolicLink() ||
    !stat.isFile() ||
    stat.size !== expected.size ||
    (stat.mode & 0o222) !== 0 ||
    (await hashFile(filePath)) !== expected.sha256
  ) {
    throw new Error("Immutable Skill package resource changed or is unsafe.");
  }
}

async function packageView(entries: ReadonlyArray<ResolvedExpertSkillEntry>): Promise<{
  readonly contentRoot: string;
  readonly resources: ReadonlyArray<{
    readonly path: string;
    readonly kind: "file" | "directory";
    readonly size: number;
    readonly sha256: string;
  }>;
}> {
  const first = entries[0];
  if (!first) throw new Error("Fixed Skill package has no selected entry.");
  const packageId = first.packageId;
  const parts = first.entryPath.split("/");
  const contentRoot = path.resolve(first.path, ...parts.map(() => ".."));
  const packageRoot = path.dirname(contentRoot);
  if (
    path.basename(packageRoot) !== packageId ||
    path.basename(contentRoot) !== "content" ||
    entries.some((entry) => {
      const expected = path.resolve(contentRoot, ...entry.entryPath.split("/"));
      return entry.packageId !== packageId || path.resolve(entry.path) !== expected;
    })
  ) {
    throw new Error("Fixed Skill source does not match its immutable package identity.");
  }
  const packageStat = await fs.lstat(packageRoot);
  const contentStat = await fs.lstat(contentRoot);
  if (
    packageStat.isSymbolicLink() ||
    !packageStat.isDirectory() ||
    contentStat.isSymbolicLink() ||
    !contentStat.isDirectory()
  ) {
    throw new Error("Immutable Skill package path is unavailable or unsafe.");
  }
  const packageJsonPath = path.join(packageRoot, "package.json");
  const packageJsonStat = await fs.lstat(packageJsonPath);
  if (
    packageJsonStat.isSymbolicLink() ||
    !packageJsonStat.isFile() ||
    (packageJsonStat.mode & 0o222) !== 0
  ) {
    throw new Error("Immutable Skill package manifest is unavailable or unsafe.");
  }
  const manifest = Schema.decodeUnknownSync(SkillPackageSchema)(
    JSON.parse((await fs.readFile(packageJsonPath, "utf8")) as string) as unknown,
  );
  if (
    manifest.packageId !== packageId ||
    `pkg_${expertResourceFiles.hashJson({
      schemaVersion: manifest.schemaVersion,
      rootName: manifest.rootName,
      resources: manifest.resources,
    })}` !== packageId
  ) {
    throw new Error("Immutable Skill package manifest does not match its content identity.");
  }
  const selected = new Set(entries.map((entry) => entry.entryPath));
  for (const entry of entries) {
    const manifestEntry = manifest.entries.find(
      (candidate) => candidate.entryPath === entry.entryPath,
    );
    const resource = manifest.resources.find(
      (candidate) => candidate.path === `content/${entry.entryPath}`,
    );
    if (
      !manifestEntry ||
      !resource ||
      resource.kind !== "file" ||
      !entry.sha256 ||
      resource.sha256 !== entry.sha256 ||
      manifestEntry.name !== entry.name
    ) {
      throw new Error("Selected Skill identity differs from its immutable package manifest.");
    }
  }
  const resources = manifest.resources
    .filter((resource) => resource.path !== "content")
    .filter((resource) => resource.path.startsWith("content/"))
    .map((resource) => ({
      path: resource.path.slice("content/".length),
      kind: resource.kind,
      size: resource.size,
      sha256: resource.sha256,
    }));
  for (const resource of manifest.resources) {
    if (resource.path === "content" || resource.kind !== "file") continue;
    if (resource.path !== `content/${resource.path.slice("content/".length)}`)
      throw new Error("Immutable Skill package has an invalid resource path.");
    const entryPath = resource.path.slice("content/".length);
    await assertReadOnlyRegularFile(path.join(packageRoot, ...resource.path.split("/")), resource);
    if (path.posix.basename(entryPath) === "SKILL.md" && !selected.has(entryPath)) continue;
  }
  return { contentRoot, resources };
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

const BUILTIN_CLAUDE_AGENT_TYPES = new Set(["Explore", "Plan", "general-purpose"]);

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
  projectedEntries: ReadonlyArray<FixedSkillProjection["entries"][number]>,
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
  grouped: ReadonlyMap<string, ReadonlyArray<ResolvedExpertSkillEntry>>,
  packageRoots: ReadonlyMap<string, string>,
  packageResources: ReadonlyMap<
    string,
    ReadonlyArray<{
      readonly path: string;
      readonly kind: "file" | "directory";
      readonly sha256: string;
      readonly size: number;
    }>
  >,
  projectedEntries: ReadonlyArray<FixedSkillProjection["entries"][number]>,
): Promise<{
  agents: FixedSkillProjection["agents"];
  allowedSubagentTypes: ReadonlyArray<string>;
}> {
  const agents: Record<string, FixedSkillProjection["agents"][string]> = {};
  const allowed = new Set<string>(BUILTIN_CLAUDE_AGENT_TYPES);
  for (const [packageId, entries] of grouped) {
    const contentRoot = packageRoots.get(packageId)!;
    const resources = packageResources.get(packageId)!;
    for (const entry of entries) {
      const selected = parseNativeMarkdown(await fs.readFile(entry.path, "utf8"));
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
        resources.some((resource) => resource.path === candidate && resource.kind === "file"),
      );
      if (!resourcePath)
        throw new Error(
          `Selected Expert Skill "${entry.name}" requires native Agent "${agentName}", but its immutable package does not contain that definition.`,
        );
      const raw = await fs.readFile(path.join(contentRoot, ...resourcePath.split("/")), "utf8");
      const native = parseNativeMarkdown(raw);
      const definitionName = agentName;
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
      // permissionMode, hooks, mcpServers, memory, and observer fields are
      // deliberately excluded: package metadata cannot widen host approval or
      // add ambient integrations to a managed child process.
      const definition: FixedSkillProjection["agents"][string] = {
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
      const existing = agents[definitionName];
      if (existing && JSON.stringify(existing) !== JSON.stringify(definition))
        throw new Error("Selected Skill packages contain conflicting native Agent definitions.");
      agents[definitionName] = definition;
      allowed.add(definitionName);
    }
  }
  return { agents, allowedSubagentTypes: [...allowed].toSorted() };
}

function pluginMetadata(name: string): string {
  return `${JSON.stringify({ name, version: "1.0.0", description: "Fixed Expert Skill assembly" })}\n`;
}

function addDirectory(expected: Map<string, ExpectedFile>, relative: string): void {
  if (!relative) return;
  const normalized = relative.split(path.sep).join("/");
  expected.set(normalized, { sha256: "" });
  let parent = path.posix.dirname(normalized);
  while (parent !== ".") {
    expected.set(parent, { sha256: "" });
    parent = path.posix.dirname(parent);
  }
}

function addFile(
  expected: Map<string, ExpectedFile>,
  relative: string,
  sourcePath: string,
  resource: { readonly sha256: string },
): void {
  const normalized = relative.split(path.sep).join("/");
  expected.set(normalized, { sha256: resource.sha256, sourcePath });
  let parent = path.posix.dirname(normalized);
  while (parent !== ".") {
    addDirectory(expected, parent);
    parent = path.posix.dirname(parent);
  }
}

async function mirrorPackage(
  input: {
    readonly contentRoot: string;
    readonly pluginRootRelative: string;
    readonly resources: ReadonlyArray<{
      readonly path: string;
      readonly kind: "file" | "directory";
      readonly size: number;
      readonly sha256: string;
    }>;
    readonly entries: ReadonlyArray<ResolvedExpertSkillEntry>;
  },
  expected: Map<string, ExpectedFile>,
): Promise<void> {
  const selected = new Set(input.entries.map((entry) => entry.entryPath));
  const secondary = input.entries.filter((entry) => !entry.entryPath.startsWith("skills/"));
  const rootSkill = input.entries.find((entry) => entry.entryPath === "SKILL.md");
  for (const resource of input.resources) {
    if (resource.kind !== "file") continue;
    const isSkillEntry = path.posix.basename(resource.path) === "SKILL.md";
    const keepAtPluginRoot =
      !isSkillEntry || (selected.has(resource.path) && resource.path.startsWith("skills/"));
    const sourcePath = path.join(input.contentRoot, ...resource.path.split("/"));
    if (keepAtPluginRoot)
      addFile(expected, path.join(input.pluginRootRelative, resource.path), sourcePath, resource);
    if (rootSkill && !isSkillEntry)
      addFile(
        expected,
        path.join(
          input.pluginRootRelative,
          "skills",
          safeNativeDirectoryName(rootSkill),
          resource.path,
        ),
        sourcePath,
        resource,
      );
    if (isSkillEntry && !selected.has(resource.path)) continue;
    if (resource.path.startsWith("skills/")) continue;
    const rootEntry = resource.path === "SKILL.md";
    if (rootEntry && !secondary.some((entry) => entry.entryPath === resource.path)) continue;
    const selectedNonSkillsEntry =
      selected.has(resource.path) && secondary.some((entry) => entry.entryPath === resource.path);
    if (isSkillEntry && !selectedNonSkillsEntry) continue;
    if (rootEntry) {
      const entry = input.entries.find((candidate) => candidate.entryPath === resource.path)!;
      const base = path.join(input.pluginRootRelative, "skills", safeNativeDirectoryName(entry));
      addFile(expected, path.join(base, resource.path), sourcePath, resource);
    } else if (secondary.length > 0) {
      const base = path.join(input.pluginRootRelative, "skills", "__package_resources__");
      // The package-relative tree under this directory lets native Skills resolve
      // references outside their own entry directory without rewriting the source.
      addFile(expected, path.join(base, resource.path), sourcePath, resource);
    }
  }
  // A non-root Skill needs to sit under the native `skills/` directory. Mirror
  // the package tree beneath one private resource root so `../` references keep
  // their package-relative meaning. Only selected SKILL.md files are included.
  const packageRoot = path.join(input.pluginRootRelative, "skills", "__package_resources__");
  if (secondary.some((entry) => entry.entryPath !== "SKILL.md")) {
    for (const entry of secondary) {
      if (entry.entryPath === "SKILL.md") continue;
      const dest = path.join(packageRoot, entry.entryPath);
      const resource = input.resources.find((candidate) => candidate.path === entry.entryPath);
      if (!resource || resource.kind !== "file")
        throw new Error("Selected Skill entry is absent from its package resources.");
      addFile(
        expected,
        dest,
        path.join(input.contentRoot, ...entry.entryPath.split("/")),
        resource,
      );
    }
  }
}

async function verifyProjectionTree(
  root: string,
  expected: ReadonlyMap<string, ExpectedFile>,
): Promise<void> {
  const actual = new Map<string, string>();
  const walk = async (directory: string, relative = ""): Promise<void> => {
    for (const item of await fs.readdir(directory, { withFileTypes: true })) {
      const child = path.join(directory, item.name);
      const childRelative = relative ? `${relative}/${item.name}` : item.name;
      const stat = await fs.lstat(child);
      if (stat.isSymbolicLink())
        throw new Error("Fixed Skill projection contains a symbolic link.");
      if (stat.isDirectory()) {
        actual.set(`${childRelative}/`, "directory");
        await walk(child, childRelative);
      } else if (stat.isFile()) {
        if ((stat.mode & 0o222) !== 0) throw new Error("Fixed Skill projection is writable.");
        actual.set(childRelative, await hashFile(child));
      } else {
        throw new Error("Fixed Skill projection contains an unsupported file type.");
      }
    }
  };
  await walk(root);
  for (const [relative, record] of expected) {
    const target = path.join(root, ...relative.split("/"));
    if (record.sha256 === "") {
      if (actual.get(`${relative}/`) !== "directory")
        throw new Error("Fixed Skill projection directory is missing.");
      continue;
    }
    if (actual.get(relative) !== record.sha256)
      throw new Error("Fixed Skill projection changed or contains an unselected Skill.");
    if (record.sourcePath) {
      const [source, projected] = await Promise.all([
        fs.lstat(record.sourcePath),
        fs.lstat(target),
      ]);
      if (
        source.isSymbolicLink() ||
        projected.isSymbolicLink() ||
        source.dev !== projected.dev ||
        source.ino !== projected.ino
      ) {
        throw new Error("Fixed Skill projection must link immutable package resources directly.");
      }
    }
  }
  if (actual.size !== expected.size)
    throw new Error("Fixed Skill projection has unexpected resources.");
}

async function createProjectionTree(
  stage: string,
  expected: ReadonlyMap<string, ExpectedFile>,
): Promise<void> {
  for (const [relative, record] of expected) {
    const target = path.join(stage, ...relative.split("/"));
    if (record.sha256 === "") {
      await fs.mkdir(target, { recursive: true, mode: 0o700 });
    } else if (record.content !== undefined) {
      await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      await fs.writeFile(target, record.content, { mode: 0o400, flag: "wx" });
    } else if (record.sourcePath) {
      await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      await fs.link(record.sourcePath, target);
    }
  }
  const chmodDirectories = async (directory: string): Promise<void> => {
    for (const item of await fs.readdir(directory, { withFileTypes: true })) {
      const child = path.join(directory, item.name);
      if (item.isDirectory()) {
        await chmodDirectories(child);
        await fs.chmod(child, 0o500);
      }
    }
  };
  await chmodDirectories(stage);
}

/** Native views hard-link immutable package files; raw SKILL.md metadata/body and
 * package-relative resources remain unchanged and no package bytes are copied.
 */
export async function createFixedSkillProjection(
  base: string,
  session: ProviderExpertSession,
): Promise<FixedSkillProjection> {
  await verifyFixedExpertAssembly(session, session.skills);
  if (!/^exp_[a-f0-9]{64}$/u.test(session.snapshotId))
    throw new Error("Invalid fixed Skill snapshot identity.");
  ensurePrivateDirectorySync(base);
  const assemblyKey = session.skillAssemblyId?.trim() || session.snapshotId;
  const assemblyHash = sha(assemblyKey);
  const root = path.join(base, `${PROJECTION_VERSION}-${assemblyHash}`);
  const pluginName = `synara-fixed-${assemblyHash.slice(0, 20)}`;
  const selectedEntries = session.skillEntries ?? [];
  const grouped = new Map<string, ResolvedExpertSkillEntry[]>();
  for (const entry of selectedEntries)
    grouped.set(entry.packageId, [...(grouped.get(entry.packageId) ?? []), entry]);
  const plugins: { name: string; path: string }[] = [];
  const entries: FixedSkillProjection["entries"][number][] = [];
  const skillRoots: string[] = [];
  const packageRoots = new Map<string, string>();
  const packageResources = new Map<string, Awaited<ReturnType<typeof packageView>>["resources"]>();
  const expected = new Map<string, ExpectedFile>();
  for (const [packageId, packageEntries] of [...grouped].toSorted(([left], [right]) =>
    left.localeCompare(right),
  )) {
    const view = await packageView(packageEntries);
    packageRoots.set(packageId, view.contentRoot);
    packageResources.set(packageId, view.resources);
    const perPackagePlugin = `${pluginName}-${packageId.slice(4, 12)}`;
    const pluginRelative = `plugins/${perPackagePlugin}`;
    const pluginPath = path.join(root, pluginRelative);
    const manifestRelative = `${pluginRelative}/.claude-plugin/plugin.json`;
    const metadata = pluginMetadata(perPackagePlugin);
    expected.set(manifestRelative, { sha256: sha(metadata), content: metadata });
    addDirectory(expected, `${pluginRelative}/.claude-plugin`);
    addDirectory(expected, pluginRelative);
    const pluginExpected = new Map<string, ExpectedFile>();
    await mirrorPackage(
      {
        contentRoot: view.contentRoot,
        pluginRootRelative: pluginRelative,
        resources: view.resources,
        entries: packageEntries,
      },
      pluginExpected,
    );
    for (const [relative, record] of pluginExpected) expected.set(relative, record);
    for (const selected of packageEntries) {
      const safeDirectory = safeNativeDirectoryName(selected);
      const relativePath = selected.entryPath.startsWith("skills/")
        ? path.join(pluginRelative, selected.entryPath)
        : selected.entryPath === "SKILL.md"
          ? path.join(pluginRelative, "skills", safeDirectory, "SKILL.md")
          : path.join(pluginRelative, "skills", "__package_resources__", selected.entryPath);
      const nativePath = path.join(root, relativePath);
      entries.push({
        name: selected.name,
        nativeName: `${perPackagePlugin}:${selected.name}`,
        pluginName: perPackagePlugin,
        path: nativePath,
        originalName: selected.name,
        originalPath: selected.path,
        sha256: selected.sha256!,
        ...(selected.userInvocable !== undefined ? { userInvocable: selected.userInvocable } : {}),
      });
    }
    plugins.push({ name: perPackagePlugin, path: pluginPath });
    skillRoots.push(path.join(pluginPath, "skills"));
  }
  const managedSubagents =
    session.skillPolicy?.nativeSubagents === "inherit"
      ? await loadManagedSubagents(session, grouped, packageRoots, packageResources, entries)
      : { agents: {}, allowedSubagentTypes: [] };
  const existing = await fs.lstat(root).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  });
  if (existing && (!existing.isDirectory() || existing.isSymbolicLink()))
    throw new Error("Unsafe fixed Skill projection.");
  if (!existing) {
    const stage = path.join(base, `.staging-${randomUUID()}`);
    await fs.mkdir(stage, { mode: 0o700 });
    try {
      await createProjectionTree(stage, expected);
      await verifyProjectionTree(stage, expected);
      try {
        await fs.rename(stage, root);
      } catch (error) {
        if (!(await fs.lstat(root).catch(() => null))?.isDirectory()) throw error;
        await fs.rm(stage, { recursive: true, force: true });
      }
      await syncDirectoryEntry(base);
    } catch (error) {
      await fs.rm(stage, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }
  await verifyProjectionTree(root, expected);
  await fs.chmod(root, 0o500);
  return {
    root,
    pluginName,
    plugins,
    skillRoots,
    agents: managedSubagents.agents,
    allowedSubagentTypes: managedSubagents.allowedSubagentTypes,
    entries,
  };
}

export async function verifyProjectedSkillAssembly(
  session: ProviderExpertSession,
  projection: FixedSkillProjection,
  active: ReadonlyArray<{ readonly name: string; readonly path: string }>,
  lifecycleGeneration: string,
): Promise<void> {
  invalidateNativeSkillAssemblyVerification(session);
  const mapped = active.map((item) => {
    const entry = projection.entries.find(
      (candidate) =>
        (item.name === candidate.name || item.name === candidate.nativeName) &&
        path.resolve(item.path) === path.resolve(candidate.path),
    );
    if (!entry) throw new Error(`Native catalog contains an unselected Skill: ${item.name}`);
    return { name: entry.originalName, path: entry.originalPath };
  });
  if (active.length !== projection.entries.length)
    throw new Error("Native catalog omitted a selected fixed Expert Skill.");
  for (const entry of projection.entries)
    if (sha(await fs.readFile(entry.path)) !== entry.sha256)
      throw new Error("Fixed Skill projection content changed.");
  await recordVerifiedNativeSkillAssembly(session, mapped, lifecycleGeneration);
}
