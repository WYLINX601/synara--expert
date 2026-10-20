import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import type {
  ExpertSkillSelection,
  ResolvedExpertSkillEntry,
  SkillPackage,
} from "@synara/contracts";
import { resolveExecutable } from "@synara/shared/executable";

export const BMAD_PRESET_COMMIT = "61e01f82644c4bb533750cfa0d6d61ab61d2cc9b";

/** Reviewed menus/recommendations from the pinned upstream version. Role
 * recommendations are deliberately excluded; no recursive dependency install.
 */
export const BMAD_ROLE_PRESETS = [
  {
    id: "bmad-analyst",
    name: "Mary",
    role: "bmad-agent-analyst",
    workflows: [
      "bmad-brainstorming",
      "bmad-deep-recon",
      "bmad-prfaq",
      "bmad-product-brief",
      "bmad-project-context",
    ],
  },
  { id: "bmad-pm", name: "John", role: "bmad-agent-pm", workflows: ["bmad-prd"] },
  { id: "bmad-po", name: "Sofia", role: "bmad-agent-po", workflows: [] },
  {
    id: "bmad-architect",
    name: "Winston",
    role: "bmad-agent-architect",
    workflows: ["bmad-architecture"],
  },
  {
    id: "bmad-dev",
    name: "Amelia",
    role: "bmad-agent-dev",
    workflows: [
      "bmad-build",
      "bmad-code-review",
      "bmad-qa-generate-e2e-tests",
      "bmad-retrospective",
    ],
  },
  { id: "bmad-ux", name: "Sally", role: "bmad-agent-ux-designer", workflows: ["bmad-ux"] },
] as const;

export function bmadPresetSelections(
  manifest: SkillPackage,
  expertId: string,
): ExpertSkillSelection[] {
  const preset = BMAD_ROLE_PRESETS.find((role) => role.id === expertId);
  if (!preset) throw new Error(`Unknown BMad role: ${expertId}`);
  return [preset.role, "bmad", ...preset.workflows].map((name, index) => {
    const candidates = manifest.entries.filter((entry) => entry.name === name);
    if (candidates.length !== 1 || candidates[0]!.entryPath !== `${name}/SKILL.md`)
      throw new Error(`BMad preset requires one original entry: ${name}/SKILL.md`);
    return {
      packageId: manifest.packageId,
      entryPath: candidates[0]!.entryPath,
      activation: index === 0 ? "startup" : "on-demand",
    };
  });
}

export type BmadWorkspacePreflight = {
  projectRoot: string | null;
  configurationHash: string | null;
  issues: string[];
};

/** BMad-specific project requirements belong to its preset, not the generic
 * package store. Inspection never installs tools, executes scripts or writes.
 */
export async function inspectBmadWorkspace(
  entries: ReadonlyArray<Pick<ResolvedExpertSkillEntry, "name" | "activation">>,
  cwd: string | undefined,
  executableLookup: typeof resolveExecutable = resolveExecutable,
): Promise<BmadWorkspacePreflight | null> {
  if (
    !entries.some(
      (entry) =>
        entry.activation === "startup" &&
        BMAD_ROLE_PRESETS.some((preset) => preset.role === entry.name),
    )
  )
    return null;
  const issues: string[] = [];
  if (!cwd || !path.isAbsolute(cwd))
    return {
      projectRoot: null,
      configurationHash: null,
      issues: ["BMad requires a project working directory containing _bmad/."],
    };
  let projectRoot = path.resolve(cwd);
  while (true) {
    const candidate = path.join(projectRoot, "_bmad");
    const stat = await fs.stat(candidate).catch((cause: unknown) => {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw cause;
    });
    if (stat?.isDirectory()) break;
    const parent = path.dirname(projectRoot);
    if (parent === projectRoot)
      return {
        projectRoot: null,
        configurationHash: null,
        issues: [`BMad is not configured above ${cwd}: missing _bmad/.`],
      };
    projectRoot = parent;
  }
  if (!executableLookup("uv", { cwd }))
    issues.push("BMad requires uv on the current host PATH; install/configure it before starting.");
  const digest = createHash("sha256");
  const files = [
    "config.toml",
    "scripts/resolve_customization.py",
    "scripts/resolve_config.py",
    ...(entries.some((entry) => entry.name === "bmad-agent-po") ? ["scripts/render_skill.py"] : []),
  ];
  for (const relative of files) {
    const file = path.join(projectRoot, "_bmad", relative);
    try {
      const bytes = await fs.readFile(file);
      digest.update(relative).update("\0").update(bytes).update("\0");
    } catch (cause) {
      issues.push(
        `BMad required project file is unreadable: ${file} (${(cause as NodeJS.ErrnoException).code ?? "read failed"}).`,
      );
    }
  }
  for (const entry of entries) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/u.test(entry.name)) {
      issues.push("BMad customization requires a simple skill name.");
      continue;
    }
    for (const suffix of [".toml", ".user.toml"]) {
      const relative = `custom/${entry.name}${suffix}`;
      try {
        digest
          .update(relative)
          .update("\0")
          .update(await fs.readFile(path.join(projectRoot, "_bmad", relative)))
          .update("\0");
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== "ENOENT")
          issues.push(`BMad customization is unreadable: ${relative}.`);
      }
    }
  }
  return { projectRoot, configurationHash: issues.length ? null : digest.digest("hex"), issues };
}
