import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Schema } from "effect";
import { SuiteManifestV1, type SuiteIssue, type SuiteSource } from "@synara/contracts";
import { parse as parseToml } from "smol-toml";
import YAML from "yaml";

import {
  BMAD_PRESET_COMMIT,
  BMAD_ROLE_PRESETS,
  BMAD_SHARED_METHODS,
} from "../experts/bmadSkillPreset";
import { expertResourceFiles } from "../experts/ExpertStore";
import { compareResourcePaths } from "../experts/FileResourceStore";
import { assertSkillResourcePath, SKILL_PACKAGE_LIMIT } from "../experts/skillLibraryArchive";
import { BMAD_PINNED_FILES } from "./bmadPinnedFiles";
import { sourceIssue, SuiteSourceError } from "./SuiteSourceSnapshot";

export interface CompiledSuiteRole {
  readonly name: string;
  readonly description: string;
  readonly persona: string;
  readonly useCases: string;
  readonly outputRequirements: string;
  readonly bmadRole?: string;
}
export interface AnalyzedSuiteSource {
  readonly adapterId: string;
  readonly adapterVersion: number;
  readonly manifest: SuiteManifestV1;
  readonly roles: Readonly<Record<string, CompiledSuiteRole>>;
  readonly issues: ReadonlyArray<SuiteIssue>;
}
function table(value: unknown): value is Record<string, unknown> {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) !== Date.prototype
  );
}

/** Root-bound file access rejects links in every component, including internal links. */
export async function readSuiteSourceFile(root: string, relative: string): Promise<Buffer> {
  assertSkillResourcePath(relative);
  if (relative !== relative.normalize("NFC")) throw new Error("Suite paths must be NFC.");
  const rootStat = await fs.lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("Unsafe Suite root.");
  for (let current = path.dirname(relative); current !== "."; current = path.dirname(current)) {
    const stat = await fs.lstat(path.join(root, current));
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error("Unsafe Suite path component.");
  }
  return expertResourceFiles.read(path.join(root, relative), await fs.realpath(root));
}
function utf8(bytes: Buffer): string {
  const text = bytes.toString("utf8");
  if (!Buffer.from(text).equals(bytes)) throw new Error("Role and manifest text must be UTF-8.");
  return text;
}

/** The pinned Python resolver's structural merge, without executing imported code. */
export function mergeBmadCustomization(base: unknown, override: unknown): unknown {
  if (table(base) && table(override)) {
    const merged: Record<string, unknown> = Object.assign(Object.create(null), base);
    for (const [key, value] of Object.entries(override))
      merged[key] = Object.hasOwn(base, key) ? mergeBmadCustomization(base[key], value) : value;
    return merged;
  }
  if (Array.isArray(base) && Array.isArray(override)) {
    const all: unknown[] = [...base, ...override];
    const field =
      all.length && all.every(table)
        ? ["code", "id"].find((key) => all.every((item) => table(item) && Object.hasOwn(item, key)))
        : undefined;
    if (!field) return all;
    for (const item of all)
      if (!table(item) || typeof item[field] !== "string" || !item[field])
        throw new Error(`Invalid keyed customization array: ${field}.`);
    const result: unknown[] = [...base];
    const positions = new Map(
      base.map((item, index) => [(item as Record<string, unknown>)[field], index]),
    );
    for (const item of override) {
      const key = (item as Record<string, unknown>)[field];
      const position = positions.get(key);
      if (position === undefined) {
        positions.set(key, result.length);
        result.push(item);
      } else result[position] = item;
    }
    return result;
  }
  return override;
}

export async function compileBmadRole(input: {
  sourceRoot: string;
  roleKey: string;
  projectRoot?: string;
  expertIds?: Readonly<Record<string, string>>;
}): Promise<CompiledSuiteRole> {
  const preset = BMAD_ROLE_PRESETS.find((role) => role.id === input.roleKey);
  if (!preset)
    throw new SuiteSourceError({
      ...sourceIssue(
        "identity_unavailable",
        "Role key is not in the fixed BMAD adapter registry.",
        { kind: "expert", id: input.roleKey, path: null },
      ),
      category: "execution",
      action: "run",
    });
  try {
    const sourcePath = `${preset.role}/SKILL.md`;
    const markdownBytes = await readSuiteSourceFile(input.sourceRoot, sourcePath);
    const customizationBytes = await readSuiteSourceFile(
      input.sourceRoot,
      `${preset.role}/customize.toml`,
    );
    for (const [relative, bytes] of [
      [sourcePath, markdownBytes],
      [`${preset.role}/customize.toml`, customizationBytes],
    ] as const)
      if (createHash("sha256").update(bytes).digest("hex") !== BMAD_PINNED_FILES[relative])
        throw new Error("BMAD role bytes do not match the fixed adapter version.");
    const markdown = utf8(markdownBytes);
    const front = /^---\s*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(markdown);
    const metadata: unknown = front ? YAML.parse(front[1]!) : null;
    if (
      !table(metadata) ||
      metadata.name !== preset.role ||
      typeof metadata.description !== "string"
    )
      throw new Error("Invalid pinned role Markdown metadata.");
    let customization: unknown = parseToml(utf8(customizationBytes));
    if (input.projectRoot) {
      for (const suffix of [".toml", ".user.toml"]) {
        try {
          customization = mergeBmadCustomization(
            customization,
            parseToml(
              utf8(
                await readSuiteSourceFile(
                  input.projectRoot,
                  `_bmad/custom/${preset.role}${suffix}`,
                ),
              ),
            ),
          );
        } catch (cause) {
          if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
        }
      }
    }
    if (!table(customization) || !table(customization.agent))
      throw new Error("BMAD customization has no agent table.");
    const agent = customization.agent;
    const text = (key: string): string => {
      if (typeof agent[key] !== "string") throw new Error(`Invalid agent.${key}.`);
      return agent[key];
    };
    const strings = (key: string): string[] => {
      if (
        !Array.isArray(agent[key]) ||
        !(agent[key] as unknown[]).every((value) => typeof value === "string")
      )
        throw new Error(`Invalid agent.${key}.`);
      return agent[key] as string[];
    };
    const displayName = text("name");
    const title = text("title");
    const sourceReferenceRoot = `file resource bmad-source-dependencies/${preset.role}`;
    if (!displayName.trim()) throw new Error("Invalid customized role name.");
    for (const instruction of [
      ...strings("activation_steps_prepend"),
      ...strings("activation_steps_append"),
    ]) {
      if (/bmad-agent-|resolve_customization\.py|render_skill\.py/u.test(instruction))
        throw new Error("Unsupported role reactivation in customized activation steps.");
    }
    const facts: string[] = [];
    let factBytes = 0;
    let factCount = 0;
    for (const fact of strings("persistent_facts")) {
      if (!fact.startsWith("file:")) {
        facts.push(fact);
        continue;
      }
      if (!input.projectRoot)
        throw new Error("Project-bound persistent facts require an authorized project root.");
      const pattern = fact.slice(5).replace(/^\{project-root\}\//u, "");
      if (
        !pattern ||
        path.isAbsolute(pattern) ||
        pattern.includes("\\") ||
        pattern.split("/").some((part) => part === ".." || part === ".") ||
        /[\p{Cc}]/u.test(pattern)
      )
        throw new Error("Unsafe persistent fact path.");
      const matches: string[] = [];
      for await (const relative of fs.glob(pattern, { cwd: input.projectRoot })) {
        matches.push(relative.split(path.sep).join("/"));
        if (matches.length + factCount > 5000)
          throw new Error("Persistent fact entry budget exceeded.");
      }
      let filesLoaded = 0;
      for (const relative of matches.sort(compareResourcePaths)) {
        if (++factCount > 5000) throw new Error("Persistent fact entry budget exceeded.");
        const stat = await fs.lstat(path.join(input.projectRoot, relative));
        if (stat.isDirectory() && !stat.isSymbolicLink()) continue;
        const bytes = await readSuiteSourceFile(
          input.projectRoot,
          relative.split(path.sep).join("/"),
        );
        factBytes += bytes.length;
        if (factBytes > SKILL_PACKAGE_LIMIT) throw new Error("Persistent facts exceed 100 MiB.");
        facts.push(`Source: project/${relative}\n${utf8(bytes)}`);
        filesLoaded++;
      }
      if (!filesLoaded) throw new Error(`Persistent fact dependency is missing: ${pattern}`);
    }
    if (!Array.isArray(agent.menu)) throw new Error("Invalid agent.menu.");
    const menu: string[] = [];
    for (const item of agent.menu) {
      if (
        !table(item) ||
        typeof item.code !== "string" ||
        typeof item.description !== "string" ||
        (typeof item.skill === "string") === (typeof item.prompt === "string")
      )
        throw new Error("Unsupported BMAD menu expression.");
      if (typeof item.prompt === "string") {
        const prompt = item.prompt.replaceAll("{skill-root}", sourceReferenceRoot);
        menu.push(`${item.code}: ${item.description}\nInstruction: ${prompt}`);
        continue;
      }
      const skill = item.skill as string;
      const owner = BMAD_ROLE_PRESETS.find(
        (role) => role.role === skill || (role.workflows as readonly string[]).includes(skill),
      );
      if (
        (BMAD_SHARED_METHODS as readonly string[]).includes(skill) ||
        (preset.workflows as readonly string[]).includes(skill)
      )
        menu.push(
          `${item.code}: ${item.description}\nInvoke method ${skill} with the current Expert identity.`,
        );
      else if (owner) {
        const target = input.expertIds?.[owner.id];
        menu.push(
          `${item.code}: ${item.description}\nRequest a real Expert delegation to ${target ? `expertId=${JSON.stringify(target)}` : `Suite member key=${JSON.stringify(owner.id)}`} for ${skill}; resolve the trusted target before dispatch. Never activate its role Skill or simulate its identity.`,
        );
      } else throw new Error(`Unsupported menu capability: ${skill}`);
    }
    let poWorkflow = "";
    if (preset.id === "bmad-po") {
      if (
        !table(customization.workflow) ||
        !["at_inception", "on_start"].includes(String(customization.workflow.publication))
      )
        throw new Error("Unsupported PO workflow.publication.");
      const workflowBytes = await readSuiteSourceFile(
        input.sourceRoot,
        `${preset.role}/workflow.md`,
      );
      if (
        createHash("sha256").update(workflowBytes).digest("hex") !==
        BMAD_PINNED_FILES[`${preset.role}/workflow.md`]
      )
        throw new Error("PO workflow differs from the pinned version.");
      poWorkflow = utf8(workflowBytes)
        .replace(/^\{% if workflow\.publication[\s\S]*?\{% endif %\}\r?\n/u, "")
        .replace(
          "{% if initiative_folder == config.core.output_folder %}",
          "If the authorized project has no active initiative:",
        )
        .replace("{% else %}", "Otherwise:")
        .replace("{% endif %}", "")
        .replace(
          /\{\{\s*rendered\("([^"]+)"\)\s*\}\}/gu,
          (_match, relative: string) => `${sourceReferenceRoot}/${relative}`,
        )
        .replace(/\{\{\s*agent\.menu\s*\}\}/gu, menu.join("\n\n"))
        .replace(/\{\{\s*agent\.persistent_facts\s*\}\}/gu, facts.join("\n\n"))
        .replace(/\{\{\s*agent\.([a-z_]+)\s*\}\}/gu, (_match, key: string) =>
          Array.isArray(agent[key]) ? (agent[key] as unknown[]).join("\n") : text(key),
        )
        .replace(
          /\{\{\s*config\.core\.output_folder\s*\}\}/gu,
          "the authorized project's configured output folder",
        )
        .replace(
          /\{\{\s*initiative_folder\s*\}\}/gu,
          "the authorized project's active initiative folder",
        )
        .replaceAll("{skill-root}", sourceReferenceRoot);
      if (/\{%|\{\{/u.test(poWorkflow)) throw new Error("Unsupported static PO role expression.");
      poWorkflow += `\n\nFrozen project method customization (use these values when reading PO reference templates; no role renderer/activation):\n${JSON.stringify(customization.workflow).replaceAll("{skill-root}", sourceReferenceRoot)}`;
    }
    const persona = [
      `# ${displayName} — ${title}`,
      `Role: ${text("role")}\nIdentity: ${text("identity")}\nCommunication style: ${text("communication_style")}`,
      `Principles:\n${strings("principles")
        .map((value) => `- ${value}`)
        .join("\n")}`,
      `Fixed activation prepend instructions (in order, subject to normal approvals):\n${strings("activation_steps_prepend").join("\n")}`,
      `Persistent facts fixed at binding:\n${facts.join("\n\n")}`,
      `Activation: retain this Expert identity across methods. Read the authorized project's _bmad/config.toml and custom/config.toml then custom/config.user.toml for output_folder and active_initiative using structural merge; do not run role activation or resolve_customization.py. Read an existing initiative ticket first and respect settled requirements. Greet as ${displayName}, prefix messages with ${text("icon")}, and mention bmad navigation.`,
      `Fixed activation append instructions (in order, subject to normal approvals):\n${strings("activation_steps_append").join("\n")}`,
      preset.id === "bmad-po"
        ? "Dispatch follows the fixed PO workflow below: no unsolicited menu, greet briefly and wait when no request; mention party-mode and advanced elicitation on the first non-headless turn."
        : `Dispatch: if the user's initial intent clearly maps to a menu item, dispatch after greeting without another confirmation. Otherwise show a numbered Code / Description / Action menu and wait. Accept number, code, or fuzzy match; clarify only genuine ambiguity. Chat and bmad help remain available. Never execute import/setup scripts as an import side effect.`,
      `Menu:\n${menu.join("\n\n")}`,
      poWorkflow,
      `Trusted Suite delegation targets: ${BMAD_ROLE_PRESETS.map((role) => `${role.id} -> ${input.expertIds?.[role.id] ? `expertId=${JSON.stringify(input.expertIds[role.id])}` : "resolve this Suite member through the host before dispatch"}`).join("; ")}.`,
      `All cross-role work, including party-mode participants, requires real target Expert delegation through the host's trusted delegation tool. Resolve member references to actual Expert IDs; never fabricate execution, activate bmad-agent-* as methods, or switch personas in this session. If a target is unavailable, report that specific capability limitation. Method availability never grants tools, shell access, or project permissions.`,
    ].join("\n\n");
    if (
      persona.length > 32000 ||
      metadata.description.length > 16000 ||
      displayName.length > 200 ||
      menu.join("\n").length > 32000
    )
      throw new Error("Compiled role exceeds Expert field budgets.");
    return {
      name: displayName,
      description: metadata.description,
      persona,
      useCases: menu.join("\n\n"),
      outputRequirements:
        "Preserve source provenance and provide concrete outcomes. Cross-role results must come from real delegated Experts, not role simulation.",
      bmadRole: preset.role,
    };
  } catch (cause) {
    if (cause instanceof SuiteSourceError) throw cause;
    const message = (cause instanceof Error ? cause.message : String(cause))
      .replaceAll(input.sourceRoot, "<suite-source>")
      .replaceAll(input.projectRoot ?? input.sourceRoot, "<project>");
    const unsafe = /unsafe|symlink|symbolic|escap/iu.test(message);
    throw new SuiteSourceError(
      {
        ...sourceIssue(unsafe ? "unsafe_path" : "identity_unavailable", message, {
          kind: "expert",
          id: preset.id,
          path: `${preset.role}/SKILL.md`,
        }),
        category: unsafe ? "security" : "execution",
        action: "run",
      },
      { cause },
    );
  }
}

export async function analyzeSuiteSource(
  rootPath: string,
  source: SuiteSource,
): Promise<AnalyzedSuiteSource> {
  const issues: SuiteIssue[] = [];
  const roles: Record<string, CompiledSuiteRole> = Object.create(null);
  const addIssue = (issue: SuiteIssue) => {
    if (issues.length >= 200)
      throw new SuiteSourceError(
        sourceIssue("invalid_manifest", "Source diagnostics exceed 200 entries.", {
          kind: "suite",
          id: source.sourceId,
          path: null,
        }),
      );
    issues.push(issue);
  };
  let manifestBytes: Buffer | undefined;
  try {
    manifestBytes = await readSuiteSourceFile(rootPath, "synara-suite.json");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "ENOENT")
      throw new SuiteSourceError(
        sourceIssue("unsafe_path", "Cannot safely read root manifest.", {
          kind: "suite",
          id: source.sourceId,
          path: "synara-suite.json",
        }),
        { cause },
      );
  }
  if (manifestBytes) {
    try {
      const raw: unknown = JSON.parse(utf8(manifestBytes));
      // Unknown fields remain in the immutable original, but never enter runtime configuration.
      const supported = (
        value: unknown,
        allowed: readonly string[],
        at: string,
      ): Record<string, unknown> => {
        if (!table(value)) throw new Error(`Expected object at ${at}.`);
        const result: Record<string, unknown> = Object.create(null);
        for (const [key, item] of Object.entries(value)) {
          if (allowed.includes(key)) result[key] = item;
          else
            addIssue(
              sourceIssue(
                "unsupported_capability",
                `Unsupported manifest field ${at}.${key}; preserved in source only.`,
                { kind: "suite", id: source.sourceId, path: "synara-suite.json" },
                "observe",
              ),
            );
        }
        return result;
      };
      const projected = supported(
        raw,
        [
          "schemaVersion",
          "name",
          "description",
          "experts",
          "resources",
          "sharedResourceKeys",
          "coordinatorResourceKeys",
          "defaults",
        ],
        "manifest",
      );
      if (Array.isArray(projected.experts))
        projected.experts = projected.experts.map((item) =>
          supported(
            item,
            table(item) && item.kind === "reference"
              ? ["key", "kind", "expertId"]
              : ["key", "kind", "name", "personaPath", "description", "resourceKeys"],
            "experts",
          ),
        );
      if (Array.isArray(projected.resources))
        projected.resources = projected.resources.map((item) => {
          const fields: Record<string, string[]> = {
            skill: ["key", "kind", "packageRoot", "entryPath"],
            files: ["key", "kind", "root", "purpose"],
            connection: ["key", "kind", "connectionId", "tools"],
            "resource-reference": ["key", "kind", "resourceRef"],
          };
          const resource = supported(
            item,
            table(item) && typeof item.kind === "string"
              ? (fields[item.kind] ?? ["key", "kind"])
              : ["key", "kind"],
            "resources",
          );
          if (table(resource.tools))
            resource.tools = supported(
              resource.tools,
              resource.tools.mode === "all" ? ["mode"] : ["mode", "names"],
              "tools",
            );
          if (table(resource.resourceRef)) {
            const ref = resource.resourceRef;
            const fieldsByKind: Record<string, readonly string[]> = {
              skill: ["kind", "sourceId", "selection"],
              "managed-skill": ["kind", "sourceId", "managedSkillId"],
              files: ["kind", "sourceId", "resourceId", "purpose"],
              connection: ["kind", "sourceId", "connection"],
            };
            const projectedRef = supported(
              ref,
              typeof ref.kind === "string" ? (fieldsByKind[ref.kind] ?? ["kind"]) : ["kind"],
              "resourceRef",
            );
            if (table(projectedRef.selection))
              projectedRef.selection = supported(
                projectedRef.selection,
                ["packageId", "entryPath", "resourceMode"],
                "resourceRef.selection",
              );
            if (table(projectedRef.connection))
              projectedRef.connection = supported(
                projectedRef.connection,
                ["id", "required", "tools", "toolMode", "enabled"],
                "resourceRef.connection",
              );
            resource.resourceRef = projectedRef;
          }
          return resource;
        });
      if (projected.defaults !== undefined)
        projected.defaults = supported(
          projected.defaults,
          ["language", "outputDirectory"],
          "defaults",
        );
      const manifest = Schema.decodeUnknownSync(SuiteManifestV1)(projected);
      const expertKeys = new Set<string>();
      const resourceKeys = new Set<string>();
      for (const resource of manifest.resources ?? []) {
        if (resourceKeys.has(resource.key))
          throw new Error(`Duplicate resource key: ${resource.key}`);
        resourceKeys.add(resource.key);
      }
      for (const expert of manifest.experts) {
        if (expertKeys.has(expert.key) || resourceKeys.has(expert.key))
          throw new Error(`Duplicate package local key: ${expert.key}`);
        expertKeys.add(expert.key);
      }
      for (const key of [
        ...(manifest.sharedResourceKeys ?? []),
        ...(manifest.coordinatorResourceKeys ?? []),
        ...manifest.experts.flatMap((expert) =>
          expert.kind === "definition" ? (expert.resourceKeys ?? []) : [],
        ),
      ])
        if (!resourceKeys.has(key)) throw new Error(`Undeclared resource key: ${key}`);
      for (const expert of manifest.experts) {
        if (expert.kind !== "definition") continue;
        try {
          const persona = utf8(await readSuiteSourceFile(rootPath, expert.personaPath));
          if (!persona.trim() || persona.length > 32000 || expert.description.length > 16000)
            throw new Error("Role persona/description is empty or exceeds Expert field budgets.");
          roles[expert.key] = {
            name: expert.name,
            description: expert.description,
            persona,
            useCases: "",
            outputRequirements: "",
          };
        } catch (cause) {
          const message = (cause instanceof Error ? cause.message : String(cause)).replaceAll(
            rootPath,
            "<suite-source>",
          );
          const unsafe = /unsafe|symlink|symbolic|escap/iu.test(message);
          addIssue({
            ...sourceIssue(unsafe ? "unsafe_path" : "identity_unavailable", message, {
              kind: "expert",
              id: expert.key,
              path: expert.personaPath,
            }),
            category: unsafe ? "security" : "execution",
            action: "run",
          });
        }
      }
      if (
        Object.keys(roles).length === 0 &&
        !manifest.experts.some((expert) => expert.kind === "reference")
      )
        throw new Error("No legal member identity could be read from this manifest.");
      for (const resource of manifest.resources ?? []) {
        if (resource.kind !== "files" && resource.kind !== "skill") continue;
        const relative = resource.kind === "files" ? resource.root : resource.packageRoot;
        try {
          if (relative !== ".") {
            assertSkillResourcePath(relative);
            if (relative !== relative.normalize("NFC"))
              throw new Error("Unsafe non-NFC resource root.");
            let directory = rootPath;
            for (const segment of relative.split("/")) {
              directory = path.join(directory, segment);
              const stat = await fs.lstat(directory);
              if (!stat.isDirectory() || stat.isSymbolicLink())
                throw new Error("Unsafe resource directory component.");
            }
          }
          if (resource.kind === "skill") {
            if (path.posix.basename(resource.entryPath) !== "SKILL.md")
              throw new Error("Declared Skill entry is not an original SKILL.md entry.");
            await readSuiteSourceFile(
              rootPath,
              `${relative === "." ? "" : `${relative}/`}${resource.entryPath}`,
            );
          }
        } catch (cause) {
          const message = (cause instanceof Error ? cause.message : String(cause)).replaceAll(
            rootPath,
            "<suite-source>",
          );
          const unsafe = /unsafe|symlink|symbolic|escap/iu.test(message);
          addIssue({
            ...sourceIssue(
              unsafe
                ? "unsafe_path"
                : (cause as NodeJS.ErrnoException).code === "ENOENT"
                  ? "resource_missing"
                  : "resource_corrupt",
              message,
              { kind: "resource", id: resource.key, path: relative },
              unsafe ? "deny-action" : "limit-capability",
            ),
            action: "run",
          });
        }
      }
      return { adapterId: "synara-suite-v1", adapterVersion: 1, manifest, roles, issues };
    } catch (cause) {
      if (cause instanceof SuiteSourceError) throw cause;
      throw new SuiteSourceError(
        sourceIssue("invalid_manifest", cause instanceof Error ? cause.message : String(cause), {
          kind: "suite",
          id: source.sourceId,
          path: "synara-suite.json",
        }),
        { cause },
      );
    }
  }
  // Accept only a direct skills root or the one registered repository/package root. No recursive guessing.
  let skillsPrefix = "";
  let hasRole = false;
  for (const prefix of ["", "skills/", "upstream/skills/"]) {
    for (const role of BMAD_ROLE_PRESETS) {
      try {
        await readSuiteSourceFile(rootPath, `${prefix}${role.role}/customize.toml`);
        if (hasRole)
          throw new SuiteSourceError(
            sourceIssue("unsupported_format", "Ambiguous registered BMAD skills roots.", {
              kind: "suite",
              id: source.sourceId,
              path: null,
            }),
          );
        hasRole = true;
        skillsPrefix = prefix;
        break;
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
      }
    }
  }
  if (!hasRole)
    throw new SuiteSourceError(
      sourceIssue(
        "unsupported_format",
        "No root synara-suite.json or registered fixed BMAD skills root was recognized.",
        { kind: "suite", id: source.sourceId, path: null },
      ),
    );
  const skillsRoot = path.join(rootPath, skillsPrefix);
  const verifiedFiles = new Set<string>();
  const unavailable = new Set<string>();
  for (const [relative, expectedHash] of Object.entries(BMAD_PINNED_FILES)) {
    try {
      const bytes = await readSuiteSourceFile(skillsRoot, relative);
      if (createHash("sha256").update(bytes).digest("hex") !== expectedHash)
        throw new Error("Bytes differ from the fixed BMAD version.");
      verifiedFiles.add(relative);
    } catch (cause) {
      unavailable.add(relative.split("/")[0]!);
      const message = (cause instanceof Error ? cause.message : String(cause)).replaceAll(
        skillsRoot,
        "<suite-source>",
      );
      addIssue({
        ...sourceIssue(
          "resource_corrupt",
          `Pinned BMAD dependency ${relative}: ${message}`,
          { kind: "resource", id: relative.split("/")[0]!, path: `${skillsPrefix}${relative}` },
          "limit-capability",
        ),
        action: "run",
      });
    }
  }
  // A byte-verified common implementation plus a byte-verified role establish identity.
  if (
    !verifiedFiles.has("bmad/scripts/render_skill.py") ||
    BMAD_ROLE_PRESETS.every(
      (role) =>
        !verifiedFiles.has(`${role.role}/SKILL.md`) ||
        !verifiedFiles.has(`${role.role}/customize.toml`),
    ) ||
    (source.kind === "github" && source.resolvedCommit !== BMAD_PRESET_COMMIT)
  )
    throw new SuiteSourceError(
      sourceIssue(
        "unsupported_format",
        "Source does not match the registered BMAD 61e01f8 implementation and role identities.",
        { kind: "suite", id: source.sourceId, path: null },
      ),
    );
  const methods = [
    ...BMAD_SHARED_METHODS,
    ...BMAD_ROLE_PRESETS.flatMap((role) => [...role.workflows]),
  ];
  const resources: NonNullable<SuiteManifestV1["resources"]>[number][] = methods.map((method) => ({
    key: method,
    kind: "skill",
    packageRoot: skillsPrefix ? skillsPrefix.slice(0, -1) : ".",
    entryPath: `${method}/SKILL.md`,
  }));
  resources.push({
    key: "bmad-source-dependencies",
    kind: "files",
    root: skillsPrefix ? skillsPrefix.slice(0, -1) : ".",
    purpose: "reference",
  });
  for (const preset of BMAD_ROLE_PRESETS) {
    if (
      !verifiedFiles.has(`${preset.role}/SKILL.md`) ||
      !verifiedFiles.has(`${preset.role}/customize.toml`)
    ) {
      addIssue({
        ...sourceIssue(
          "identity_unavailable",
          "Pinned role identity is missing or differs from the supported version.",
          { kind: "expert", id: preset.id, path: `${skillsPrefix}${preset.role}/SKILL.md` },
        ),
        category: "execution",
        action: "run",
      });
      continue;
    }
    try {
      roles[preset.id] = await compileBmadRole({ sourceRoot: skillsRoot, roleKey: preset.id });
    } catch (cause) {
      if (cause instanceof SuiteSourceError) addIssue(cause.issue);
      else throw cause;
    }
  }
  if (Object.keys(roles).length === 0)
    throw new SuiteSourceError(
      sourceIssue("unsupported_format", "No legal BMAD member identity could be compiled.", {
        kind: "suite",
        id: source.sourceId,
        path: null,
      }),
    );
  for (const method of methods)
    if (unavailable.has(method))
      addIssue({
        ...sourceIssue(
          "resource_missing",
          `Pinned method ${method} has missing or mismatched dependencies; only this method is limited.`,
          { kind: "resource", id: method, path: `${skillsPrefix}${method}/SKILL.md` },
          "limit-capability",
        ),
        action: "run",
      });
  const knownEntries = new Set<string>([
    ...methods,
    ...BMAD_ROLE_PRESETS.map((role) => role.role),
    "bmod-core-tools",
    "bmod-method",
  ]);
  for (const entry of await fs.readdir(skillsRoot, { withFileTypes: true }))
    if (!knownEntries.has(entry.name))
      addIssue(
        sourceIssue(
          "unsupported_capability",
          `Unmapped BMAD material ${entry.name} is retained as source but not executable discovery.`,
          { kind: "resource", id: entry.name, path: `${skillsPrefix}${entry.name}` },
          "observe",
        ),
      );
  const manifest: SuiteManifestV1 = {
    schemaVersion: 1,
    name: "BMAD",
    description: `Fixed BMAD ${BMAD_PRESET_COMMIT} six-role Suite`,
    experts: BMAD_ROLE_PRESETS.map((preset) => ({
      key: preset.id,
      kind: "definition",
      name: roles[preset.id]?.name ?? preset.name,
      description: roles[preset.id]?.description ?? "Source role identity unavailable",
      personaPath: `${skillsPrefix}${preset.role}/SKILL.md`,
      resourceKeys: [...preset.workflows],
    })),
    resources,
    sharedResourceKeys: [...BMAD_SHARED_METHODS, "bmad-source-dependencies"],
    coordinatorResourceKeys: [],
  };
  return { adapterId: "bmad-61e01f8-v1", adapterVersion: 1, manifest, roles, issues };
}
